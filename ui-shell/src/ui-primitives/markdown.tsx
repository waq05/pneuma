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
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlightToLines, type HighlightedCodeLine } from './highlight'
import { joinPath } from './paths'

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

/** 相对路径图片的 base64 缓存（进程内一份；key = 绝对路径）。 */
const mdImageCache = new Map<string, string>()

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
          mdImageCache.set(abs, url)
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
    return <span className="file-md-img-missing">[图片：{alt || src}]</span>
  }
  return <img src={resolved} alt={alt} loading="lazy" />
}

/* ────────────────────────────── 代码块 ────────────────────────────── */

/** 已算好的高亮行缓存上限（条）。会话里反复出现的同一段代码不必再跑一遍 shiki。 */
const LINE_CACHE_LIMIT = 200

/** 高亮行缓存：键＝语法 + 源码。插入序即淘汰序（够用，不做真 LRU）。 */
const LINE_CACHE = new Map<string, HighlightedCodeLine[]>()

function cacheKeyOf(code: string, lang: string): string {
  return lang + '\u0000' + code
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
          if (LINE_CACHE.size >= LINE_CACHE_LIMIT) {
            const oldest = LINE_CACHE.keys().next().value
            if (oldest !== undefined) LINE_CACHE.delete(oldest)
          }
          LINE_CACHE.set(key, value)
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
  return (
    <div className="file-code-body">
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
  node?: { position?: { start?: { offset?: number } } | undefined } | undefined
}): JSX.Element {
  const { streaming } = useContext(MARKDOWN_ENV)
  const match = /language-([\w-]+)/.exec(className ?? '')
  const raw = String(children ?? '').replace(/\n$/, '')
  if (match === null) return <code className={className}>{children}</code>
  // key 用这块代码在源文本里的起始偏移：流式增长时前面的块偏移不变，React 才会复用
  // 同一个 CodeBlock 实例（连同已经算好的高亮），而不是按位置重建。
  const offset = node?.position?.start?.offset
  return (
    <CodeBlock
      key={offset === undefined ? undefined : 'code:' + String(offset)}
      code={raw}
      lang={match[1] as string}
      streaming={streaming}
    />
  )
}

/* ────────────────────────────── 组件表 ────────────────────────────── */

/**
 * react-markdown 的组件表：模块级常量，一次定好，跨帧复用。
 *
 * 这里每一项都允许重渲染，但不允许「换函数」：换函数＝换元素类型＝整棵子树重挂。
 */
const MARKDOWN_COMPONENTS: Components = {
  img: ({ src, alt }) => {
    const source = typeof src === 'string' ? src : ''
    return source === '' ? (
      <span className="file-md-img-missing">[图片]</span>
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
export const MarkdownView = memo(function MarkdownView({ text, path, fsRead, streaming = false }: {
  text: string
  path: string
  /** 相对路径图片的解析口；缺省时相对路径图片显示占位。 */
  fsRead?: FsRead | undefined
  /** 这段正文还在增长：代码块等它停顿一下再上色（见 CodeBlock 的说明）。 */
  streaming?: boolean
}): JSX.Element {
  const base = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
  const env = useMemo<MarkdownEnv>(() => ({ base, fsRead, streaming }), [base, fsRead, streaming])
  return (
    <MARKDOWN_ENV.Provider value={env}>
      <div className="file-md">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
          {text}
        </ReactMarkdown>
      </div>
    </MARKDOWN_ENV.Provider>
  )
})
