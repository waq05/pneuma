/**
 * 转录视口的**行滚动模型**（纯函数 + 行高表，不碰 React）。
 *
 * 为什么以「行」为单位：条数是坏的坐标——一条派活 prompt 可以比一屏还高，按条滚永远
 * 滚不进它（用户报的「点进子代理看不到工作过程」正是这个）。ink 是按行裁切越界文本的
 * （`render-node-to-output.js` 的 clip + `output.js` 的 from/to 行切），所以「尾锚定 +
 * 内容盒负 marginBottom」就等于逐行滚动，连折行都跟着走，不用自己算 CJK 折行。
 *
 * 视口 = [上占位 spacer] + [窗口内的条目] + [下占位 spacer]，内容总高恰好等于估算出的
 * 总行数；于是「从尾部往上退 N 行」这一个数字就是全部滚动状态（0 = 跟尾）。窗口只装
 * 视口附近 ± overscan 行，所以会话再长、渲染量也是有界的。
 *
 * 行高表：settled 条目不可变 → 量到的行数可以永久缓存；live 尾每帧重测。没量过的条目
 * 用估算（按显示宽度数折行），窗口滑到哪里就量到哪里，估算逐步被真值替换。
 *
 * @module dsc-tui/app/scroll-model
 */
import type { TranscriptEntry } from '../contract.js'
import { displayWidth } from './click.js'

/** 窗口上下各多渲染几行：滚动时不留白，也不至于把整篇都拉进来。 */
export const OVERSCAN_LINES = 8

/** 行高表：条目 id → 显示行数。宽度变了（刻度栏出现/消失）就整体作废。 */
export class HeightCache {
  private table = new Map<number, number>()
  private width: number | null = null

  /** 换宽度（含首次）就清表：折行变了，旧行数全是错的。 */
  useWidth(width: number): void {
    if (this.width === width) return
    this.width = width
    this.table.clear()
  }

  get(id: number): number | undefined {
    return this.table.get(id)
  }

  set(id: number, lines: number): void {
    if (lines > 0) this.table.set(id, lines)
  }

  get size(): number {
    return this.table.size
  }
}

/**
 * 没量过的条目按**折叠态实际画出来的行数**估：一件卡片的估算误差不是小数字——它直接
 * 变成「跳过的那段内容有多高」，跳过段的高度又决定视口顶落在内容坐标的哪一行。
 *
 * 曾经的口径（按最长字段数折行、卡片再补框架行）在工具卡上错得离谱：结果原文十四行，
 * 卡片折叠态其实只画**一行**（「⚙ 调用 xx 工具 · 状态」，参数与结果要点开才给）。误差
 * 14 行/张，一屏十几张就是两百行——滚轮往上滚时这些误差被真实测量逐条替换，内容坐标
 * 整个缩水，于是「前几格滚轮不动、再滚一下突然弹回底部」（用户报的连滚回跳），长会话
 * 还会因为跳过段虚高把视口顶推出正文（整片空白）。
 *
 * 所以这里逐类照着渲染器数行（只数结构行，文本按显示宽度折行），宁可与真实差一两行，
 * 也不要差十几行。`text` 仍是「按原文折行」的近似——markdown 的块间距与代码围栏行
 * 一增一减，量级上互相抵消（真值一旦被量到就永久进表，估算只管没滚到过的那段）。
 */
export function estimateLines(
  entry: TranscriptEntry,
  width: number,
  options?: { expandThinking?: boolean },
): number {
  const usable = Math.max(8, width)
  switch (entry.kind) {
    // 题面：`❯ ` 前缀占两列，前缀与正文同行；前面还留一行空（见 ChatView 的 USER_TOP_GAP）
    case 'user':
      if (entry.internal === true) return 1
      return 1 + folded(entry.text, usable, INDENT_DETAIL)
    // markdown 正文：按原文折行（见上）
    case 'text':
      return folded(entry.text, usable)
    // 思考块：折叠态 = 标签一行 + **恒定 3 行瀑布**（照 dsh 的 preview ticker：每行硬截到框宽、
    // 不折行，所以行数与宽度、与流到哪一句都无关）；展开态 = 标签一行 + 全文折行
    case 'thinking':
      if (options?.expandThinking === true) {
        return 1 + folded(entry.text, usable, INDENT_DETAIL)
      }
      return entry.text === '' ? 1 : 1 + WATERFALL_ROWS
    // 工具行：**默认折叠成一行**「⚙ 调用 xx 工具 · 状态」（点击才展开参数与结果行）。
    // 展开是用户手动触发的少数情形：估算按折叠态，展开后那一帧量到真值就顶上
    // （行高表每次渲染都重量，见 TranscriptViewport 的量测循环）。
    case 'tool':
      return 1
    // 子代理卡：标题一行；跑动中再挂一行「当前工具」（有才挂）+ 三行瀑布；失败再挂一行原因
    case 'subagent': {
      const working = entry.sub.state === 'working'
      const toolLine = working && entry.sub.lastTool !== undefined ? 1 : 0
      return (
        1 +
        toolLine +
        (working ? WATERFALL_ROWS : 0) +
        (entry.sub.state === 'failed' && entry.sub.error !== undefined ? 1 : 0)
      )
    }
    // 计划卡 / 系统说明：标题行 + 文件行；压缩通知多一行分隔线
    case 'plan':
      return 2
    case 'system':
      return (entry.compaction === undefined ? 0 : 1) + Math.max(1, folded(entry.text, usable, INDENT_DETAIL))
    // 以下都是一行平铺文字（轮尾标记、重试行、文件改动、截断提示）
    default:
      return 1
  }
}

/** 瀑布窗口的行数（子代理卡与思考块共用；与 `ChatView` 的 `WATERFALL_ROWS` 同口径）。 */
const WATERFALL_ROWS = 3
/** 缩进列数（与 theme 的 `INDENT.detail` 同口径；本模块不引 UI 层，故复写常量）。 */
const INDENT_DETAIL = 2

/** 多行文本折行总数（空行算一行，与 ink 的空行渲染一致；**空串算 0 行**）。 */
function folded(text: string, usable: number, indent = 0): number {
  // 空串必须是 0：`MarkdownView` 对空正文不产出任何行（`parseMarkdown('')` 是空块表），
  // 而「直播尾还没吐字」的那一帧正是一条空 text 条目——按 1 行估会让整叠内容比真实
  // 高一行，滚动时最后一行就少看一条（曾经在会话列表探针里抓到这个 ±1）。
  if (text === '') return 0
  let lines = 0
  for (const raw of text.split('\n')) {
    lines += Math.max(1, Math.ceil((displayWidth(raw) + indent) / usable))
  }
  return lines
}

/** 一行里的最长文本（估算用；不认识的就是空串）。 */


/** 一轮（= 一条非内部用户消息）在内容坐标里的位置。 */
export interface TurnMark {
  /** 条目 id。 */
  id: number
  /** 它在全量 transcript 里的下标（跳转时用来选窗口）。 */
  index: number
  /** 内容行坐标（这一条的第一行）。 */
  top: number
}

/** 视口布局：窗口切到哪、占位多高、滚动量多少。 */
export interface ViewportLayout {
  /** 窗口切片下标（[start, end)）。 */
  start: number
  end: number
  /** 窗口上方跳过的行数（上占位 spacer 的高度）。 */
  aboveLines: number
  /** 窗口下方跳过的行数（下占位 spacer 的高度）。 */
  belowLines: number
  /** 每一条的行数（量到真值用真值，没量过是估算）——锚点换算要用同一份。 */
  rows: number[]
  /** 内容总行数（估算/实测混合）。 */
  totalLines: number
  /** 可上退的最大行数（0 = 一屏装得下，不需要滚）。 */
  maxShift: number
  /** 夹好的滚动量：从内容尾部往上退多少行；0 = 跟尾。 */
  shift: number
  /** 解析出来的视口顶内容行号（null = 跟尾）。 */
  top: number | null
  /** 全量 transcript 里的每一轮（刻度栏与跳转用；不在窗口里的也有）。 */
  turns: TurnMark[]
}

/**
 * 视口顶的**内容锚点**：钉在某一条的第几行上，而不是「内容第几行」这个绝对行号。
 *
 * 为什么必须这样（用户报的「连滚不动 + 突然弹回底部」的根）：「第几行」是**估算坐标系**
 * 里的坐标——从没滚到过的那一段（跳过段）只有估算值，滚过去量到真值就会整体缩水或长高，
 * 同一个行号指向的内容就换了。表现出来就是：滚轮前几格画面不动（行号在缩水的坐标里
 * 追不上），再滚一下落到别处。钉住「哪一条的第几行」就没有这个问题：跳过段怎么变，
 * 视口顶那一条都还在原地——因为**被跳过的那一段本来就不在画面里**，量它量到多少都不该
 * 动摇视线。同一条内部的偏移是稳的（进了窗口的条目都量过真值）。
 */
export interface ScrollAnchor {
  /** 条目 id（`TranscriptEntry.id`，含流头部那条伪条目的哨兵 id）。 */
  id: number
  /** 该条在数组里的下标（命中失效时按 id 重新找）。 */
  index: number
  /** 视口顶落在这一条内部的第几行（0 基）。 */
  offset: number
}

/** 行号 → 锚点：落在那一条的第几行。到（或超过）尾部就是「跟尾」（null）。 */
export function anchorAtRow(
  rows: readonly number[],
  entries: readonly TranscriptEntry[],
  row: number,
  maxTop: number,
): ScrollAnchor | null {
  if (row >= maxTop) return null
  const target = Math.max(0, row)
  let walk = 0
  for (let index = 0; index < entries.length; index += 1) {
    const height = rows[index] ?? 0
    if (target < walk + height) {
      return { id: entries[index]!.id, index, offset: target - walk }
    }
    walk += height
  }
  // 空会话（或行号落在末尾之外）：没有可钉的条目
  return null
}

/** 锚点 → 行号（内容坐标）。`null`（跟尾）给 `totalLines`，调用方自己夹。 */
export function rowOfAnchor(
  rows: readonly number[],
  entries: readonly TranscriptEntry[],
  anchor: ScrollAnchor,
): number {
  let index = entries[anchor.index]?.id === anchor.id ? anchor.index : -1
  if (index === -1) index = entries.findIndex((entry) => entry.id === anchor.id)
  if (index === -1) return Number.MAX_SAFE_INTEGER
  let walk = 0
  for (let at = 0; at < index; at += 1) walk += rows[at] ?? 0
  return walk + Math.max(0, Math.min(anchor.offset, (rows[index] ?? 1) - 1))
}

/** 每条的显示行数：量过就用真值，没量过用估算。 */
function lineOf(
  entry: TranscriptEntry,
  heights: HeightCache,
  width: number,
  options?: EstimateOptions,
): number {
  const measured = heights.get(entry.id)
  return measured ?? estimateLines(entry, width, options)
}

/** 估算要跟着渲染口径走的那点开关（目前只有「思考块是不是展开的」）。 */
export interface EstimateOptions {
  /** 思考块当前是不是展开的（展开态比折叠态高得多，估算必须跟着变）。 */
  expandThinking?: boolean
}

/**
 * 算出视口布局。
 *
 * @param entries - 全量条目（顺序即时间序）。
 * @param heights - 行高表（含已量到的真值）。
 * @param options - 内容宽度、视口行数、视口顶锚点（null = 跟尾）。
 */
export function layoutViewport(
  entries: TranscriptEntry[],
  heights: HeightCache,
  options: { width: number; viewportLines: number; anchor: ScrollAnchor | null } & EstimateOptions,
): ViewportLayout {
  const { width, viewportLines } = options
  const viewport = Math.max(1, viewportLines)
  const rows = entries.map((entry) => lineOf(entry, heights, width, options))
  const totalLines = rows.reduce((sum, value) => sum + value, 0)
  const maxShift = Math.max(0, totalLines - viewport)
  const maxTop = Math.max(0, totalLines - viewport)
  // 锚点 → 行号 → 从尾部退多少行；跟尾（null）就是 0
  const wanted = options.anchor === null ? maxTop : rowOfAnchor(rows, entries, options.anchor)
  const shift = Math.max(0, Math.min(maxShift, maxShift - Math.max(0, Math.min(wanted, maxTop))))

  // 视口顶行（内容坐标）：从尾部往上退 shift 行
  const top = Math.max(0, totalLines - viewport - shift)
  const windowFrom = top - OVERSCAN_LINES
  const wantedEnd = top + viewport + OVERSCAN_LINES

  let start = 0
  let above = 0
  while (start < entries.length && above + rows[start]! <= windowFrom) {
    above += rows[start]!
    start += 1
  }
  let end = entries.length
  let cursor = above
  for (let index = start; index < entries.length; index += 1) {
    cursor += rows[index]!
    if (cursor >= wantedEnd) {
      end = index + 1
      break
    }
  }
  const windowLines = rows.slice(start, end).reduce((sum, value) => sum + value, 0)
  const below = Math.max(0, totalLines - above - windowLines)

  const turns: TurnMark[] = []
  let walk = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.kind === 'user' && entry.internal !== true) {
      turns.push({ id: entry.id, index, top: walk })
    }
    walk += rows[index]!
  }
  return { start, end, aboveLines: above, belowLines: below, rows, totalLines, maxShift, shift, top: shift === 0 ? null : top, turns }
}

/** 跳到某一轮时该用的滚动量：让这一轮的题面正好落在视口顶上。 */
export function shiftForTurn(turn: TurnMark, layout: Pick<ViewportLayout, 'totalLines' | 'maxShift'>, viewportLines: number): number {
  const viewport = Math.max(1, viewportLines)
  return Math.max(0, Math.min(layout.maxShift, layout.totalLines - viewport - turn.top))
}

/** 当前视口顶上那一轮（= 拥有视口首行的那一轮；视口在内容头部时算第 0 轮）。 */
export function activeTurnIndex(turns: TurnMark[], shift: number, layout: Pick<ViewportLayout, 'totalLines'>, viewportLines: number): number {
  if (turns.length === 0) return -1
  const top = Math.max(0, layout.totalLines - Math.max(1, viewportLines) - shift)
  let active = 0
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index]!.top <= top) active = index
    else break
  }
  return active
}

// ── 刻度栏几何 ──────────────────────────────────────────────────────────────

/** 刻度栏占的列数（dsh 同款 2 列：`━━` / ` ─` 对齐）。 */
export const RAIL_WIDTH = 2
/** 窄于此不画（再窄正文就挤没了）。 */
export const RAIL_MIN_COLUMNS = 60
/** 至少两轮才值得画。 */
export const RAIL_MIN_TURNS = 2

/**
 * 刻度栏的字形（照 dsh-TUI 的 TimelineRail 搬）：当前轮 `━━` 重线、其余 ` ─` 短线
 * （占满 2 列、右对齐，不靠测量对齐）、箭头 `▴`/`▾`。
 */
export const RAIL_GLYPH = {
  active: '━━',
  idle: ' ─',
  up: ' ▴',
  down: ' ▾',
} as const

/** 画不画右侧那一列（轮数刻度）。 */
export function gutterEligible(options: { columns: number; viewportLines: number; contentLines: number }): boolean {
  if (options.columns < RAIL_MIN_COLUMNS) return false
  // 一屏装得下、连一行都塞不进这列——画出来只是噪音
  if (options.viewportLines < 3) return false
  if (options.contentLines <= options.viewportLines) return false
  return true
}

/** 画不画**轮数刻度**（还要 ≥2 轮：一轮的刻度没有可跳的目标，整列就不画）。 */
export function railEligible(options: {
  columns: number
  turnCount: number
  viewportLines: number
  contentLines: number
}): boolean {
  if (options.turnCount < RAIL_MIN_TURNS) return false
  return gutterEligible(options)
}

/** 刻度栏的一行：一轮的刻度、上/下箭头（`enabled` = 有目标可跳），或空行。 */
export type RailRow =
  | { kind: 'tick'; turn: number; active: boolean }
  | { kind: 'up'; enabled: boolean }
  | { kind: 'down'; enabled: boolean }

export interface RailGeometry {
  /** 每一行（0 基，从上到下）画什么；null = 空行。 */
  rows: Array<RailRow | null>
  /** 「上一轮」跳转目标（轮下标；null = 上面没有了）。 */
  up: number | null
  /** 「下一轮」跳转目标。 */
  down: number | null
  /** ▲ 画在第几行（块内 0 基；-1 = 这次没有刻度栏）。 */
  upRow: number
  /** ▼ 画在第几行。 */
  downRow: number
  /** 第一格刻度画在第几行。 */
  tickTop: number
  /** 窗口里的轮区间 [windowStart, windowEnd)。 */
  windowStart: number
  windowEnd: number
}

/**
 * 上/下一轮的跳转目标（刻度栏箭头与 `[`/`]` 键**共用这一条**，两边不可能对不上）。
 *
 * 两条 dsh 定的规矩：
 * - ▲ 先对齐本轮的题面：读到本轮中段（视口顶在本轮题面之下）时，▲ 指的就是**本轮**
 *   ——再按一次才退到上一轮。少了这条，读到长回答中段按 ▲ 会直接跳过本轮的题面。
 * - 名下的那一轮必须真能滚到视口顶（顶行号 ≤ 能滚到的最大顶行号）：够不着的那一轮
 *   点下去没反应，箭头却亮着，按几次都不动。够不着就不给目标（暗箭头 = 保证的空操作）。
 *
 * @param options - 轮数、当前轮、视口顶与最大顶行号（内容坐标）、每轮顶行号（可选）。
 */
export function turnJumpTarget(options: {
  turnCount: number
  activeIndex: number
  direction: 'up' | 'down'
  /** 视口当前顶行号（内容坐标）；不给就按「题面已在视口顶之上」处理。 */
  viewportTop?: number
  /** 能滚到的最大顶行号（= 内容总行数 − 视口行数）；不给就不判可达性。 */
  maxTop?: number
  /** 每轮的顶行号（内容坐标，`layoutViewport` 的 `turns[].top`）。 */
  turnTops?: number[]
}): number | null {
  const { turnCount, activeIndex, direction } = options
  if (turnCount === 0 || activeIndex < 0 || activeIndex >= turnCount) return null
  const tops = options.turnTops
  if (direction === 'up') {
    const activeTop = tops?.[activeIndex]
    const midTurn =
      activeTop !== undefined && options.viewportTop !== undefined && options.viewportTop > activeTop
    const target = midTurn ? activeIndex : activeIndex - 1
    return target >= 0 ? target : null
  }
  const next = activeIndex + 1
  if (next >= turnCount) return null
  const nextTop = tops?.[next]
  if (nextTop !== undefined && options.maxTop !== undefined && nextTop > options.maxTop) return null
  return next
}

/**
 * 刻度栏几何（照 dsh-TUI 的 `computeRailGeometry`）：一轮一格，▲ + 刻度 + ▼ 这一块在
 * 列里**纵向居中**，两头没有目标时箭头照样画（暗色）——位置固定，视线才不用每帧重新找。
 *
 * 窗口：轮数多于格子（列高 − 2）时绕当前轮滑一格；贴尾时钉住最新的那几格（活动刻度
 * 永远在窗口里，否则没有一格是高亮的）。行数不够画（列高 < 3）返回全空。
 *
 * **居中用的高度与窗口用的高度可以分开**（`centerRows` / `rows`），这不是冗余：聊天区
 * 的可用高度会随「回到底部」胶囊、草稿变高这些**页脚**变化而少一行，块若按它居中，
 * 一滚动整块就上下挪一格（用户报障「上下滑动时刻度会上下晃」）。所以调用方按**只在
 * 改变终端尺寸时才变**的高度居中，窗口仍按真实列高算；`centerRows` 比列高大时夹住
 * （块最矮也得整块留在列里，否则 ▼ 会被裁出去）。
 *
 * 每一行落什么还由 `rows` 数组直接给出（渲染与命中判定同源），`upRow`/`tickTop`/`downRow`
 * 是给探针读的同一份几何。
 *
 * @param options - 轮数、当前轮、可用行数（= 视口行数）、是否贴尾、每轮顶行号等。
 */
export function railGeometry(options: {
  turnCount: number
  activeIndex: number
  rows: number
  /** 视口贴着最新（贴尾时窗口钉在最新的那几轮上）。 */
  atBottom?: boolean
  /**
   * 居中用的高度（默认 = `rows`）。传一个**不随页脚变化**的高度（聊天区传「帧高 − 状态栏」），
   * 滚动时刻度栏就不会跟着跳。
   */
  centerRows?: number
  /** 视口当前顶行号（内容坐标）。 */
  viewportTop?: number
  /** 能滚到的最大顶行号。 */
  maxTop?: number
  /** 每轮的顶行号（内容坐标）。 */
  turnTops?: number[]
}): RailGeometry {
  const rows = Math.max(1, options.rows)
  const turnCount = Math.max(0, options.turnCount)
  /** 上下各留一行给 ▲/▼（dsh 同款：箭头行永远存在，有没有目标只改颜色）。 */
  const maxTicks = rows - 2
  // 轮数不到两轮、或列高装不下「▲ + 一格 + ▼」——整列空（与 dsh 的 null 同义）
  if (turnCount < RAIL_MIN_TURNS || maxTicks < 1) {
    return {
      rows: Array.from({ length: rows }, () => null),
      up: null,
      down: null,
      upRow: -1,
      downRow: -1,
      tickTop: -1,
      windowStart: 0,
      windowEnd: 0,
    }
  }
  const activeIndex = Math.max(0, Math.min(options.activeIndex, turnCount - 1))
  const shown = Math.min(turnCount, maxTicks)
  let start = 0
  if (turnCount > maxTicks) {
    const tailStart = turnCount - maxTicks
    start =
      options.atBottom === true
        ? Math.min(activeIndex, tailStart)
        : Math.min(Math.max(0, activeIndex - Math.floor(maxTicks / 2)), tailStart)
  }

  const up = turnJumpTarget({ ...options, turnCount, activeIndex, direction: 'up' })
  const down = turnJumpTarget({ ...options, turnCount, activeIndex, direction: 'down' })

  // 纵向居中（对齐 dsh）：▲ + 刻度 + ▼ 整块居中，剩下的行上下平分。
  // 居中高度可以是「稳定高度」（见 `centerRows`），但块必须整块留在列里——夹住下界
  const blockLines = shown + 2
  const blockTop = Math.max(
    0,
    Math.min(Math.floor((Math.max(1, options.centerRows ?? rows) - blockLines) / 2), rows - blockLines),
  )
  const upRow = blockTop
  const tickTop = blockTop + 1
  const downRow = tickTop + shown
  const output: Array<RailRow | null> = Array.from({ length: rows }, () => null)
  output[upRow] = { kind: 'up', enabled: up !== null }
  for (let offset = 0; offset < shown; offset += 1) {
    const turn = start + offset
    output[tickTop + offset] = { kind: 'tick', turn, active: turn === activeIndex }
  }
  output[downRow] = { kind: 'down', enabled: down !== null }
  return {
    rows: output,
    up,
    down,
    upRow,
    downRow,
    tickTop,
    windowStart: start,
    windowEnd: start + shown,
  }
}

/** 刻度栏某一行的命中判定：点到刻度给轮下标、箭头给 'up'/'down'、空行给 null。 */
export function railHitRow(geometry: RailGeometry, row: number): number | 'up' | 'down' | null {
  const entry = geometry.rows[row]
  if (entry === undefined || entry === null) return null
  if (entry.kind === 'up') return 'up'
  if (entry.kind === 'down') return 'down'
  return entry.turn
}
