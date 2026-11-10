/**
 * 选区判定与浮钮位置（纯函数，2026-10-25）。
 *
 * 为什么单独成文件：这些判断都能用真值表跑（不碰 React、不碰 DOM），而「浮不浮按钮、
 * 浮在哪」恰恰是最容易写错、又最难在界面里复现的部分。
 *
 * 四条口径：
 *   - 太短的不算（少于 4 个字符多半是误触）；
 *   - **保留换行**、只把每行里的连续空格/制表压成一个（选中的常是代码：把换行抹平，引用就没法看了）；
 *   - 连续空行压成一个（引用里不需要三段空白）；
 *   - 超长截断（引用上限与宿主 core/side-ask.ts 的 SIDE_ASK_MAX_QUOTE 同一口径，截断比拒绝友好）。
 *
 * @module dsc-ui-shell/plugins/ask/select
 */

/** 少于这么多字符不浮按钮。 */
export const MIN_SELECTION_CHARS = 4
/** 引用上限：与宿主 core/side-ask.ts 的 SIDE_ASK_MAX_QUOTE 同一口径。 */
export const MAX_SELECTION_CHARS = 8000
/** 浮钮与选区之间的间距（px）。 */
export const ANCHOR_GAP = 8
/**
 * 浮钮的**兜底**尺寸（px）：只在浮层还没上屏、量不到真实宽度时先摆一个位置。
 *
 * 为什么不能拿它当唯一依据：`ask.selection.action` 是一条 list 槽，插件往里挂 2–3 颗动作时
 * 整排宽度由插件决定，按单颗 92px 估就会把整排推出右边界（被 `.app` 的 overflow-x: clip 裁掉）。
 * 真实宽度由浮层渲染后自己量（getBoundingClientRect），量到了就一律以实量为准。
 */
export const BUBBLE_W = 92
export const BUBBLE_H = 30

/** 首帧兜底：浮层还没上屏时用它先摆位置，量到真实尺寸后立刻替换。 */
const FALLBACK_SIZE: { width: number; height: number } = { width: BUBBLE_W, height: BUBBLE_H }

/** 视口坐标的框。 */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * 把一段选区原文整理成「可以引用」的样子。
 *
 * @returns 整理后的文本；不值得浮按钮时返回 null
 */
export function normalizeSelection(raw: string): string | null {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
  const kept: string[] = []
  for (const line of lines) {
    // 连续空行只留一个：引用块的高度是稀缺的。
    if (line === '' && kept.length > 0 && kept[kept.length - 1] === '') continue
    kept.push(line)
  }
  const text = kept.join('\n').trim()
  if (text.length < MIN_SELECTION_CHARS) return null
  if (text.length <= MAX_SELECTION_CHARS) return text
  return text.slice(0, MAX_SELECTION_CHARS) + '…'
}

/**
 * 浮钮落在哪：默认贴选区右下角，出界就往回收。
 *
 * 为什么不用「跟着光标走」：跨行选区时末尾光标常常贴着右缘、甚至滚出视口，
 * 贴右下角再夹取一遍，至少保证整颗按钮在视野里。
 *
 * 为什么宽度要传进来（而不是读常量）：这条浮层已经改成槽，动作颗数由插件决定，
 * 「一颗」和「三颗」的宽度差出两三倍。由调用方在容器上量一次 `getBoundingClientRect().width`
 * 再传进来，夹取就跟着真实宽度走——代价是多一次布局读（多一帧同步测量）。
 * 没量到（首帧 / 浮层还没上屏）时退回 FALLBACK_SIZE，与只看单颗的老行为一致。
 */
export function anchorOf(
  selection: Box,
  viewport: { width: number; height: number },
  measured: { width: number; height: number } = FALLBACK_SIZE,
): { left: number; top: number } {
  // 右缘留 ANCHOR_GAP；左边同样留 ANCHOR_GAP，不贴视口边缘。
  const maxLeft = Math.max(ANCHOR_GAP, viewport.width - measured.width - ANCHOR_GAP)
  const rightAligned = selection.right - measured.width
  const left = Math.min(Math.max(ANCHOR_GAP, rightAligned), maxLeft)
  // 下面放得下就放下面；放不下（选区贴着底边）就翻到选区上方。
  const below = selection.bottom + ANCHOR_GAP
  const top =
    below + measured.height <= viewport.height - ANCHOR_GAP
      ? below
      : Math.max(ANCHOR_GAP, selection.top - measured.height - ANCHOR_GAP)
  return { left, top }
}
