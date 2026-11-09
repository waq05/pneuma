/**
 * markdown 视图：react-markdown（会话流同款）+ remark-gfm + 代码块走 shiki
 * + 相对路径图片经宿主 fs-read 转 base64。
 *
 * 从旧渲染层 file-preview.tsx 的 MarkdownView / MdImage / CodeBlock 移植。
 * 与旧版的一点差异：fs-read 的通道不归平台层管——调用方传 fsRead(file) 取回包
 * （预览插件传 dock 通道那份），不传时相对路径图片一律显示占位。
 *
 * 两条硬约束（2026-10-28 修流式抽搐时立的）：
 *
 *   1. components 必须是**模块级常量**。react-markdown 把这张表原样交给
 *      hast-util-to-jsx-runtime，后者直接拿 components[tag] 的函数当元素类型
 *      （该包 lib/index.js 的 createElement：state.components[name]）。写在渲染函数
 *      里的内联箭头函数每帧都是新引用，React 把它们当成新组件类型，于是**每来一个
 *      流式字，全篇的代码块、图片、pre 都卸载重挂一次**：代码块里「已高亮的那份结果」
 *      跟着归零，先退回纯文本、再换成高亮，字号与行号各换一遍——对话顶部已经输出
 *      完的代码块一抽一抽地闪，就是这么来的。表提到模块级后实例跨帧复用，变的只有
 *      正文文本。
 *
 *   2. 代码块的纯文本态与高亮态必须是**同一个 DOM 骨架**（pre.shiki > code >
 *      span.line）。旧实现两态分别是 pre.file-code-plain 与 shiki 的 HTML 字符串，
 *      字号（caption ↔ tool）、行号（无 ↔ 有）、左内距（12px ↔ 0）三项都不一样，
 *      切换一次高度就跳一次。现在两态都由 React 按行渲染，高亮结果来自
 *      highlightToLines（结构化 token，不是 HTML 字符串），切换时行容器原地复用，
 *      只换行内的 span 与颜色。
 *
 * 正文要用的 base / fsRead / streaming 走 context 传：不能塞进 components（那会让
 * 表退回每帧新建），又不能丢（相对路径图片要靠它解析）。
 *
 * @module dsc-ui-shell/platform/markdown
 */
import { createContext, Fragment, memo, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createT } from '@dsc/ui-core'
import { highlightToLines, type HighlightedCodeLine } from './highlight'
import { IconCheck, IconCopy, IconWrapLines } from './icons'
import { joinPath } from './paths'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui-core` 的 `createT`）。 */
const t = createT({ zh, en })

/** 宿主 fs-read 回包里 markdown 图片消费的那几个字段（形状对就行，不引契约）。 */
interface FsReadLike {
  kind?: string
  mime?: string
  base64?: string
  tooLarge?: boolean
}

/** markdown 里相对路径图片的解析口：给一个能调 fs-read 的函数即可。 */
export type FsRead = (file: string) => Promise<unknown>

/**
 * 一帧渲染要用的环境。
 *
 * streaming 只影响代码块什么时候上色：流式期间代码每隔几十毫秒就长出新行，上一次高亮
 * 立刻作废，白烧 CPU 还让最后一块反复变色。所以流式中改成「等代码停顿 120ms 再算」——
 * 已经输出完的块不会再变，这个等待只付一次，随后就有颜色；正在增长的尾块每次增量都
 * 把定时器往后推，到落定才上色。
 */
interface MarkdownEnv {
  /** 相对路径图片的解析基准目录（当前文档所在目录）。 */
  base: string
  /** 宿主 fs-read 的入口；缺省时相对路径图片显示占位。 */
  fsRead?: FsRead | undefined
  streaming: boolean
}

const MARKDOWN_ENV = createContext<MarkdownEnv>({ base: '', streaming: false })

/** remark 插件表也提成常量：数组每帧新建会让 react-markdown 重建整条解析管线。 */
const REMARK_PLUGINS = [remarkGfm]

/**
 * 挂源行号的块级标签。只有块级挂——改动标记的精度就到块（段落 / 标题 / 列表项 /
 * 表格 / 代码块），行内元素（strong / em / 行内 code）标不出来也没有合适的视觉位置。
 */
const LINE_TAGGED_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'blockquote',
  'hr',
  'div',
  'section',
  'article',
  'details',
  'summary',
])

/** hast 节点里这个插件要读的那几项（只用到通用形状，不引 unist 类型）。 */
interface SourceLineNode {
  tagName?: string
  properties?: Record<string, unknown>
  position?: { start?: { line?: number }; end?: { line?: number } } | undefined
  children?: SourceLineNode[]
}

/**
 * rehype 插件：把块级元素的源行区间写成 `data-line-start` / `data-line-end`。
 *
 * 为什么需要：react-markdown 渲出来的 DOM 不带「我来自源文件第几行」，而「改动发生在
 * 第几行」只有 hunks 能给（`DiffLineView.newLine`）。两边要能对上，得先把源行号带进
 * 渲染结果；下一步由 `MarkdownView` 的 effect 按改动区间给命中的块挂 `.md-changed`。
 */
function rehypeSourceLines(): (tree: SourceLineNode) => void {
  const mark = (node: SourceLineNode): void => {
    for (const child of node.children ?? []) mark(child)
    const tag = node.tagName
    const start = node.position?.start?.line
    if (typeof tag !== 'string' || !LINE_TAGGED_TAGS.has(tag) || start === undefined) return
    const end = node.position?.end?.line
    node.properties = {
      ...(node.properties ?? {}),
      'data-line-start': String(start),
      ...(end === undefined ? {} : { 'data-line-end': String(end) }),
    }
  }
  return (tree): void => {
    mark(tree)
  }
}

/** rehype 插件表：与 remark 一样提成常量，避免每帧新建导致解析管线重建。 */
const REHYPE_PLUGINS = [rehypeSourceLines] as unknown as Options['rehypePlugins']

/** 没挂改动快照时的空区间表：模块级常量，免得 memo 的入参每帧新引用。 */
const NO_CHANGED_RANGES: ReadonlyArray<readonly [number, number]> = []

/**
 * 内嵌图片缓存的**字符预算**（约 24 MB 的 base64 文本，也就是 18 MB 上下的原图）。
 *
 * 为什么要有上限：这张表按绝对路径一键一值，值是一整份 base64 字符串——一张
 * 1832×1218 的截图就有 1～2 MB。用户翻一天文档、来回看几十张图，这张表只进不出，
 * 进程内存就这么一块一块涨上去（2026-11-01 查内存时发现的唯一无界表）。
 * 超预算按插入序淘汰最老的：缓存只影响「再看一次要不要重新读盘」，丢一份不坏功能。
 */
const MD_IMAGE_BUDGET_CHARS = 24 * 1024 * 1024

/** 相对路径图片的 base64 缓存（进程内一份；key = 绝对路径）。 */
const mdImageCache = new Map<string, string>()
/** 表里现在的字符总量（淘汰时按它算，不必每次遍历求和）。 */
let mdImageChars = 0

/** 塞一份图片进缓存：单张超过预算的干脆不缓存（它自己就顶破整张表）。 */
function putImage(abs: string, url: string): void {
  if (url.length > MD_IMAGE_BUDGET_CHARS) return
  const previous = mdImageCache.get(abs)
  if (previous !== undefined) mdImageChars -= previous.length
  mdImageCache.delete(abs)
  mdImageCache.set(abs, url)
  mdImageChars += url.length
  while (mdImageChars > MD_IMAGE_BUDGET_CHARS) {
    const oldest = mdImageCache.keys().next().value
    if (oldest === undefined) break
    const dropped = mdImageCache.get(oldest)
    mdImageCache.delete(oldest)
    mdImageChars -= dropped?.length ?? 0
  }
}

/** markdown 里的一张图：http(s)/data 直接给 src；相对路径经 fs-read 转 data URL。 */
function MdImage({ src, alt }: { src: string; alt: string }): JSX.Element {
  const { base, fsRead } = useContext(MARKDOWN_ENV)
  const external = /^(https?:|data:|blob:)/i.test(src)
  const abs = external ? src : joinPath(base, decodeURIComponent(src))
  const cached = external ? undefined : mdImageCache.get(abs)
  const [resolved, setResolved] = useState<string | undefined>(external ? src : cached)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (external || resolved !== undefined || fsRead === undefined) return
    let on = true
    void fsRead(abs)
      .then((data) => {
        const read = data as FsReadLike
        if (!on) return
        if (read.kind === 'image' && read.tooLarge !== true && read.base64 !== undefined) {
          const url = `data:${read.mime};base64,${read.base64}`
          putImage(abs, url)
          setResolved(url)
        } else {
          setFailed(true)
        }
      })
      .catch(() => {
        if (on) setFailed(true)
      })
    return () => {
      on = false
    }
  }, [external, abs, fsRead, resolved])
  if (failed || (!external && resolved === undefined)) {
    return <span className="file-md-img-missing">{t('primitives.markdown.imageMissingNamed', { label: alt || src })}</span>
  }
  return <img src={resolved} alt={alt} loading="lazy" />
}

/* ────────────────────────────── 代码块 ────────────────────────────── */

/**
 * 已算好的高亮行缓存上限（条）。会话里反复出现的同一段代码不必再跑一遍 shiki。
 *
 * 条数之外还要一道**字符预算**：一条缓存的份量是「源码 + 每个 token 的文本」，
 * 也就是大致两倍源码。只按 200 条封顶的话，200 段 200 KB 的大代码块就是 80 MB；
 * 按 1.5M 字符（约 3 MB 文本）封顶才真的把这张表按住。两道闸都留着：条数挡
 * 「无数小片段」，字符挡「少量巨无霸」。
 */
const LINE_CACHE_LIMIT = 200

/** 高亮行缓存的字符预算（按源码长度计，约等于实际占用的一半）。 */
const LINE_CACHE_BUDGET_CHARS = 1_500_000

/** 高亮行缓存：键＝语法 + 源码。插入序即淘汰序（够用，不做真 LRU）。 */
const LINE_CACHE = new Map<string, HighlightedCodeLine[]>()

/** 表里现行缓存的源码总长（淘汰时按它算）。 */
let lineCacheChars = 0

/** 每一份缓存占了多少字符（键 → 源码长度；与缓存同增同减，不在淘汰时反推）。 */
const lineCacheCost = new Map<string, number>()

function cacheKeyOf(code: string, lang: string): string {
  return lang + '\u0000' + code
}

/**
 * 塞一份高亮结果进缓存，两道闸都过一遍：条数与字符预算。
 *
 * 淘汰按插入序（先来先走）：高亮缓存命中的是「同一段代码重画」（切会话、展开整轮），
 * 近因顺序与命中率并不严格对应，真 LRU 的代价不值这个差额。
 */
function putLines(code: string, key: string, value: HighlightedCodeLine[]): void {
  if (LINE_CACHE.has(key)) {
    LINE_CACHE.delete(key)
    lineCacheChars -= lineCacheCost.get(key) ?? 0
    lineCacheCost.delete(key)
  }
  LINE_CACHE.set(key, value)
  lineCacheCost.set(key, code.length)
  lineCacheChars += code.length
  while (LINE_CACHE.size > LINE_CACHE_LIMIT || lineCacheChars > LINE_CACHE_BUDGET_CHARS) {
    const oldest = LINE_CACHE.keys().next().value
    if (oldest === undefined) break
    LINE_CACHE.delete(oldest)
    lineCacheChars -= lineCacheCost.get(oldest) ?? 0
    lineCacheCost.delete(oldest)
  }
}

/** 一行的外壳：第一行前不加换行符，其余每行前面补一个（与 shiki 的 HTML 同构）。 */
function SourceLine({ first, children }: { first: boolean; children: ReactNode }): JSX.Element {
  return (
    <>
      {first ? null : '\n'}
      {children}
    </>
  )
}

/** 纯文本态的行：与高亮态同构（每行一个 span.line）。 */
function plainLines(code: string): ReactNode[] {
  return code.split('\n').map((text, index) => (
    <SourceLine key={index} first={index === 0}>
      <span className="line">{text}</span>
    </SourceLine>
  ))
}

/** 流式中等代码停顿多久再上色（毫秒）。 */
const STREAM_HIGHLIGHT_IDLE_MS = 120

/**
 * 一个围栏代码块。
 *
 * 高亮是异步的（语法按需装载），所以有「纯文本先顶着」这一态；两态共用同一套元素
 * 结构，切换时只有行内的 span 与颜色变化，高度、行号、字号都不动。
 */
function CodeBlock({ code, lang, streaming }: { code: string; lang: string; streaming: boolean }): JSX.Element {
  const key = cacheKeyOf(code, lang)
  const [lines, setLines] = useState<{ key: string; value: HighlightedCodeLine[] } | null>(() => {
    const hit = LINE_CACHE.get(key)
    return hit === undefined ? null : { key, value: hit }
  })
  /** 已经交出去的那份高亮（键）。用它挡住「缓存命中也要 setState」带来的每帧空转。 */
  const applied = useRef<string | null>(null)
  useEffect(() => {
    const hit = LINE_CACHE.get(key)
    if (hit !== undefined) {
      if (applied.current !== key) {
        applied.current = key
        setLines({ key, value: hit })
      }
      return
    }
    let on = true
    const run = (): void => {
      highlightToLines(code, lang)
        .then((value) => {
          if (!on || value === null) return
          putLines(code, key, value)
          applied.current = key
          setLines({ key, value })
        })
        .catch(() => {
          // 语法装不上就留在纯文本：代码块不该因为高亮失败而空一块。
        })
    }
    // 流式中这块代码还在长：等它停顿一下再算。已输出完的块不会变，这个等待只付一次；
    // 正在增长的尾块每次 delta 都会重排定时器，于是它到落定才上色，不会每来一个字重算。
    const timer = streaming ? window.setTimeout(run, STREAM_HIGHLIGHT_IDLE_MS) : null
    if (timer === null) run()
    return () => {
      on = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [code, key, lang, streaming])
  // 只认**这一份**代码的高亮结果：换了代码就先亮纯文本，不拿上一版顶着（那会显示旧内容）。
  const highlighted = lines !== null && lines.key === key ? lines.value : null
  /** 折行开关：只作用于这一块，默认关（超长行横向滚动，跟编辑器一致）。 */
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
  }, [])
  const copy = (): void => {
    // 非安全上下文（http 打开的面板）里剪贴板会被挡：失败就当没点，别把异常抛到界面。
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true)
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
        copyTimer.current = window.setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => {})
  }
  return (
    <div className={wrap ? 'file-code-body file-code-body--wrap' : 'file-code-body'}>
      <div className="md-code-head">
        <span className="md-code-lang">{lang}</span>
        <span className="md-code-acts">
          <button
            type="button"
            className="md-code-act"
            aria-pressed={wrap}
            title={wrap ? t('primitives.code.unwrap') : t('primitives.code.wrap')}
            aria-label={wrap ? t('primitives.code.unwrap') : t('primitives.code.wrap')}
            onClick={() => setWrap((on) => !on)}
          >
            <IconWrapLines />
          </button>
          <button
            type="button"
            className="md-code-act"
            data-copied={copied ? 'true' : undefined}
            title={copied ? t('primitives.code.copied') : t('primitives.code.copy')}
            aria-label={copied ? t('primitives.code.copied') : t('primitives.code.copy')}
            onClick={copy}
          >
            {copied ? <IconCheck /> : <IconCopy />}
          </button>
        </span>
      </div>
      <pre className="shiki">
        <code>
          {highlighted === null
            ? plainLines(code)
            : highlighted.map((segments, index) => (
                <SourceLine key={index} first={index === 0}>
                  <span className="line">
                    {segments.map((segment, at) => (
                      <span key={at} style={segment.style}>
                        {segment.text}
                      </span>
                    ))}
                  </span>
                </SourceLine>
              ))}
        </code>
      </pre>
    </div>
  )
}

/** 代码块：围栏标注带语言的才走高亮（行内代码与无语言围栏维持原样）。 */
function MarkdownCode({ className, children, node }: {
  className?: string | undefined
  children?: ReactNode
  node?: { position?: { start?: { offset?: number; line?: number } } | undefined } | undefined
}): JSX.Element {
  const { streaming } = useContext(MARKDOWN_ENV)
  const match = /language-([\w-]+)/.exec(className ?? '')
  const raw = String(children ?? '').replace(/\n$/, '')
  if (match === null) return <code className={className}>{children}</code>
  // key 用这块代码在源文本里的起始偏移：流式增长时前面的块偏移不变，React 才会复用
  // 同一个 CodeBlock 实例（连同已经算好的高亮），而不是按位置重建。
  const offset = node?.position?.start?.offset
  const line = node?.position?.start?.line
  return (
    // 外层 div 只为挂源行号（「改动」快照命中时整块标色）；代码块自身的 DOM 骨架不动。
    <div className="md-code-block" data-line-start={line === undefined ? undefined : String(line)}>
      <CodeBlock
        key={offset === undefined ? undefined : 'code:' + String(offset)}
        code={raw}
        lang={match[1] as string}
        streaming={streaming}
      />
    </div>
  )
}

/* ────────────────────────────── 组件表 ────────────────────────────── */

/**
 * react-markdown 的组件表：模块级常量，一次定好，跨帧复用。
 *
 * 这里每一项都允许重渲染，但不允许「换函数」：换函数＝换元素类型＝整棵子树重挂。
 */
const MARKDOWN_COMPONENTS: Components = {
  // 链接一律新窗口（`target="_blank"`）：主窗口是单页应用，裸 `<a href>` 点一下会把整个
  // 界面导航走——加载不出来就是白屏，还没有后退路（2026-11-02 报障）。走新窗口这条，
  // 原生层按「外链交系统浏览器 / 同源附件照旧开窗」处理，见 desktop 主进程的开窗闸门。
  a: ({ href, children, title }) => (
    <a href={href} {...(title === undefined ? {} : { title })} rel="noreferrer noopener" target="_blank">
      {children}
    </a>
  ),
  img: ({ src, alt }) => {
    const source = typeof src === 'string' ? src : ''
    return source === '' ? (
      <span className="file-md-img-missing">{t('primitives.markdown.imageMissing')}</span>
    ) : (
      <MdImage src={source} alt={alt ?? ''} />
    )
  },
  code: MarkdownCode,
  pre: ({ children }) => <>{children}</>,
}

/**
 * markdown 视图：会话流同款 ReactMarkdown，代码块交给 shiki。
 *
 * streaming 由调用方给（会话流传这一行是不是直播尾）：只在流式中改变代码块上色的
 * 时机，不影响其余渲染。
 */
export const MarkdownView = memo(function MarkdownView({ text, path, fsRead, streaming = false, changedRanges }: {
  text: string
  path: string
  /** 相对路径图片的解析口；缺省时相对路径图片显示占位。 */
  fsRead?: FsRead | undefined
  /** 这段正文还在增长：代码块等它停顿一下再上色（见 CodeBlock 的说明）。 */
  streaming?: boolean
  /**
   * 改动覆盖的新文件行区间（1 基、闭区间，来自 hunks 的 `newStart..newStart+newCount-1`）：
   * 渲染后命中的块挂 `.md-changed`。缺省 / 空数组 = 不标。
   */
  changedRanges?: ReadonlyArray<readonly [number, number]> | undefined
}): JSX.Element {
  const base = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
  const env = useMemo<MarkdownEnv>(() => ({ base, fsRead, streaming }), [base, fsRead, streaming])
  const bodyRef = useRef<HTMLDivElement>(null)
  const ranges = changedRanges ?? NO_CHANGED_RANGES
  // 渲染完再把「改过」标到块上：DOM 刚生成时还没有类名，这里按 rehypeSourceLines 写下的
  // data-line-* 与改动区间求交。ranges 为空直接跳过，不白遍历一遍 DOM。
  useEffect(() => {
    const root = bodyRef.current
    if (root === null || ranges.length === 0) return
    // 已经标上的外层块：内层块命中同一个改动时不再叠一层底色（表格里的行、列表里的段落）。
    const marked: HTMLElement[] = []
    for (const node of root.querySelectorAll<HTMLElement>('[data-line-start]')) {
      const start = Number(node.dataset['lineStart'] ?? '')
      const end = Number(node.dataset['lineEnd'] ?? '')
      if (Number.isNaN(start)) continue
      const tail = Number.isNaN(end) ? start : end
      const hit = ranges.some(([from, to]) => start <= to && tail >= from)
      if (!hit) {
        node.classList.remove('md-changed')
        continue
      }
      if (marked.some((outer) => outer.contains(node))) continue
      node.classList.add('md-changed')
      marked.push(node)
    }
  }, [text, ranges])
  return (
    <MARKDOWN_ENV.Provider value={env}>
      <div className="file-md" ref={bodyRef}>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
          {text}
        </ReactMarkdown>
      </div>
    </MARKDOWN_ENV.Provider>
  )
})
