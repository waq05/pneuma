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
/** 浮钮的估算尺寸（px）：只为夹取边界用，真实尺寸由 CSS 决定。 */
export const BUBBLE_W = 92
export const BUBBLE_H = 30

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
 */
export function anchorOf(
  selection: Box,
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const maxLeft = Math.max(ANCHOR_GAP, viewport.width - BUBBLE_W - ANCHOR_GAP)
  const left = Math.min(Math.max(ANCHOR_GAP, selection.right - BUBBLE_W), maxLeft)
  // 下面放得下就放下面；放不下（选区贴着底边）就翻到选区上方。
  const below = selection.bottom + ANCHOR_GAP
  const top =
    below + BUBBLE_H <= viewport.height - ANCHOR_GAP
      ? below
      : Math.max(ANCHOR_GAP, selection.top - BUBBLE_H - ANCHOR_GAP)
  return { left, top }
}
