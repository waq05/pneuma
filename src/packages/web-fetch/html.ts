/**
 * HTML → Markdown：把抓回来的网页正文变成模型读得省的东西。
 *
 * 为什么不是「把 HTML 原样塞给模型」：一个普通文档页的 HTML 有 60%~80% 是标签、内联脚本和
 * 样式表，直接塞进去既烧上下文又读不出结构（表格塌成一串字）。转换器用的是 turndown（dsh 的
 * `packages/web/tool-web/src/fetch.ts` 同一套）+ GitHub 风格扩展（表格、删除线、任务列表）。
 *
 * 两件**安全/健壮**的事与转换质量同等重要，都在本模块里：
 *  1. 活动与隐藏内容整块丢掉（`<script>` / `<style>` / `hidden` / `display:none`）——正文里
 *     一段看不见的文字，模型却读得到，那是往上下文里塞暗桩最省事的做法；
 *  2. 转换前先量一遍嵌套深度（{@link exceedsConversionDepth}），太深的直接放弃转换。turndown
 *     的 DOM 树是递归走的，几千层嵌套会让同步循环卡到几十秒，而这期间超时定时器根本没机会
 *     跑（同一段代码 dsh 量过：512 层 0.15 秒，20000 层 5 秒）。
 *
 * @module dsc/plugins/web-fetch/html
 */
import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'

/**
 * 转换器实例：样式选项是**面向模型的展现口径**，不是可配置项。
 *
 * ATX 标题（`## 标题`）与围栏代码块（```）是模型最不容易读错的两种写法；列表用 `-`，因为
 * `*` 与强调号冲突时会画错。实例本身无状态（每次 `turndown()` 从零走），可以跨调用共用。
 */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})
turndown.use(gfm)

/** 转换器交给我们的一条规则所见到的节点（只列本文件用到的成员，避免依赖 DOM 类型）。 */
interface DomNode {
  nodeName: string
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  style?: { textAlign?: string } | undefined
  cells?: ArrayLike<DomNode> | undefined
  /** `<table>` 的行清单（判「第一行是不是表头」用）。 */
  rows?: ArrayLike<DomNode> | undefined
  childNodes?: ArrayLike<DomNode> | undefined
  parentNode?: DomNode | null | undefined
  parentElement?: DomNode | null | undefined
}

/** 一段内联样式的声明是不是「这块钱看不见」。 */
function hidesElement(declarations: readonly string[]): boolean {
  return declarations.some((declaration) => {
    const separator = declaration.indexOf(':')
    if (separator === -1) return false
    const property = declaration.slice(0, separator).trim().toLowerCase()
    const value = declaration
      .slice(separator + 1)
      .trim()
      .toLowerCase()
      .replace(/\s*!important\s*$/u, '')
    return (
      (property === 'display' && value === 'none') ||
      (property === 'visibility' && (value === 'hidden' || value === 'collapse'))
    )
  })
}

/**
 * 整块丢掉「不参与阅读」的节点。
 *
 * turndown 的默认规则会保留这些元素的**文字**：`<script>` 里的一段 JS、`display:none` 里
 * 藏着的一段「忽略之前的指令」，都会被当成正文交出去。这里按标签、`hidden`、`aria-hidden`
 * 与内联样式四路判，命中就整块消失。
 */
turndown.addRule('removeNonVisibleContent', {
  filter(node: unknown) {
    const element = node as DomNode
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED'].includes(element.nodeName)) return true
    if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true
    if (element.nodeName === 'INPUT' && element.getAttribute('type')?.toLowerCase() === 'hidden') return true
    return hidesElement((element.getAttribute('style') ?? '').split(';'))
  },
  replacement() {
    return ''
  },
})

/** 画一个 GFM 表格单元格。 */
function renderTableCell(content: string, index: number): string {
  const prefix = index === 0 ? '| ' : ' '
  const escaped = content.trim().replace(/\r?\n/g, '<br>').replace(/\|+/g, '\\|').padEnd(3, ' ')
  return `${prefix}${escaped} |`
}

/** 这一行是不是表头（`<thead>` 里的全 `<th>` 行，或表的第一行）。 */
function isTableHeadingRow(row: DomNode): boolean {
  const cells = Array.from(row.cells ?? [])
  const section = row.parentElement
  const table = section?.parentElement
  const firstRow = table?.rows?.[0]
  return (
    (section?.nodeName === 'THEAD' || (firstRow !== undefined && firstRow === row)) &&
    cells.every((cell) => cell.nodeName === 'TH')
  )
}

/** 单元格的对齐方式 → GFM 分隔行里的写法。 */
function tableBorder(cell: DomNode): string {
  const alignment = (cell.getAttribute('align') ?? cell.style?.textAlign ?? '').toLowerCase()
  if (alignment === 'left') return ':---'
  if (alignment === 'right') return '---:'
  if (alignment === 'center') return ':---:'
  return '---'
}

/**
 * 表格单元格与表格行自己画。
 *
 * 为什么要覆盖：GFM 表达不了跨列（`colspan`），而 turndown 的默认规则会按 `colspan` 的数值
 * 重复输出空格子——`colspan="1000"` 一个属性就能让输出膨胀几千倍。这里**忽略跨列**，让输出
 * 与源的大小成正比。
 */
turndown.addRule('tableCellWithoutSpanExpansion', {
  filter: ['th', 'td'],
  replacement(content: string, node: unknown) {
    const cell = node as DomNode
    // 序号按 `<td>`/`<th>` 自己在行里的位置算，不按 childNodes：后者把行内的换行文本节点
    // 也算进去，第一个单元格的序号会变成 1，整行就少掉开头那根竖线。
    const cells = cell.parentNode?.cells ?? []
    return renderTableCell(content, Array.prototype.indexOf.call(cells, cell))
  },
})

turndown.addRule('tableRowWithoutSpanExpansion', {
  filter: 'tr',
  replacement(content: string, node: unknown) {
    const row = node as DomNode
    const cells = Array.from(row.cells ?? [])
    const border = isTableHeadingRow(row) ? cells.map((cell, index) => renderTableCell(tableBorder(cell), index)).join('') : ''
    return `\n${content}${border.length > 0 ? `\n${border}` : ''}`
  },
})

/**
 * 嵌套深度上限：超过就不转换，直接把原文当纯文本交出去。
 *
 * 512 层远高于真实页面的几十层，也远低于能把主线程卡住的量级。这是健壮性红线，不是可调参数。
 */
const MAX_CONVERSION_DEPTH = 512

/** 自闭合标签：不占嵌套深度。 */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** 内容按纯文本解析到闭合标签为止的元素（里面的 `<` 不算标签）。 */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'noscript'])

/** 标签名后面还能不能跟字符（用来确认这不是 `</scriptfoo>` 这种别名）。 */
function isTagBoundary(char: string | undefined): boolean {
  return char === undefined || char === '>' || char === '/' || /\s/.test(char)
}

/** 找 `</script>` 这类闭合标签的位置，不把里面的正文当标记解析。 */
function findRawTextEnd(lowerHtml: string, name: string, from: number): number {
  const prefix = `</${name}`
  let candidate = lowerHtml.indexOf(prefix, from)
  while (candidate !== -1 && !isTagBoundary(lowerHtml[candidate + prefix.length])) {
    candidate = lowerHtml.indexOf(prefix, candidate + prefix.length)
  }
  return candidate
}

/**
 * 这段 HTML 的嵌套深度是不是越过了上限。
 *
 * 一遍扫描的保守估计：跳过注释、跳过 raw-text 元素正文、认引号里的 `>`、只接受与当前元素同名
 * 的闭合标签。写坏的 HTML 因此会**多算**嵌套而不是漏算——宁可少转一个页面，也不要卡住进程。
 *
 * @param html 待转换的 HTML 源码
 * @returns 超过 {@link MAX_CONVERSION_DEPTH} 就是 true
 */
export function exceedsConversionDepth(html: string): boolean {
  const lowerHtml = html.toLowerCase()
  const openElements: string[] = []
  let offset = 0

  while (offset < html.length) {
    const start = html.indexOf('<', offset)
    if (start === -1) break
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4)
      if (end === -1) break
      offset = end + 3
      continue
    }

    let cursor = start + 1
    const closing = html[cursor] === '/'
    if (closing) cursor += 1
    const nameStart = cursor
    while (/[a-zA-Z0-9-]/.test(html[cursor] ?? '')) cursor += 1
    if (cursor === nameStart || !/[a-zA-Z]/.test(html.charAt(nameStart))) {
      offset = start + 1
      continue
    }

    const name = lowerHtml.slice(nameStart, cursor)
    let quote: string | undefined
    while (cursor < html.length) {
      const char = html[cursor]
      cursor += 1
      if (quote !== undefined) {
        if (char === quote) quote = undefined
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        break
      }
    }
    if (html[cursor - 1] !== '>') break

    if (closing) {
      if (openElements.at(-1) === name) openElements.pop()
    } else {
      let last = cursor - 2
      while (/\s/.test(html.charAt(last))) last -= 1
      if (!VOID_ELEMENTS.has(name) && html[last] !== '/') {
        openElements.push(name)
        if (openElements.length > MAX_CONVERSION_DEPTH) return true
        if (RAW_TEXT_ELEMENTS.has(name)) {
          const end = findRawTextEnd(lowerHtml, name, cursor)
          if (end === -1) break
          offset = end
          continue
        }
      }
    }
    offset = cursor
  }
  return false
}

/** 转换一处正文的结果。 */
export interface RenderedBody {
  /** 转好的 Markdown（或一句固定的「这段没能转换」）。 */
  text: string
  /** 源是不是在转换前就被切短了（切短了正文就不完整）。 */
  sourceTruncated: boolean
}

/** 转换失败/放弃时给模型的固定说法：宁可明说没转，也不把原始活动标记递出去。 */
const OMITTED = '[这段 HTML 没能安全转换成 Markdown，已整段略去。]'

/**
 * 把一处正文转成模型能读的文本。
 *
 * @param kind 正文种类（`html` 转换，`text` 原样）
 * @param source 解码后的正文
 * @param maxChars 参与转换的源字符上限（同步转换的工作量由它兜住）
 * @returns 转换结果与「源被切过没有」
 */
export function renderBody(kind: 'html' | 'text', source: string, maxChars: number): RenderedBody {
  const content = source.slice(0, maxChars)
  const sourceTruncated = content.length !== source.length
  if (kind === 'text') return { text: content, sourceTruncated }
  if (exceedsConversionDepth(content)) return { text: OMITTED, sourceTruncated }
  try {
    return { text: turndown.turndown(content), sourceTruncated }
  } catch {
    // 写坏的标记可能让递归走爆栈（RangeError）：这种也只能明说没转。
    return { text: OMITTED, sourceTruncated }
  }
}
