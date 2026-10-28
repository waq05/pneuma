/**
 * 思考栏与工具卡共用的一件：展开后「内容够不够长」的量法与最小高度。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/rows/fold-body
 */
/** 展开内容超过这个高度才给吸附快捷栏——小卡不背这条累赘（旧界面同款阈值）。 */
export const BAR_MIN_CONTENT_H = 400

/**
 * 展开区有多长：把每个子块的自然高度加起来。
 *
 * 为什么读 scrollHeight 而不是 offsetHeight：参数与结果两块各被 max-height 夹在
 * --dsc-tool-detail-max-h（约 180px）里，读 offsetHeight 会把任意长的内容都看成 180px，
 * 加总永远进不了 400px 阈值，快捷栏就再也不会出现。
 */
export function expandedContentHeight(body: HTMLElement): number {
  let total = 0
  for (const child of Array.from(body.children)) {
    if (!(child instanceof HTMLElement)) continue
    // 快捷栏自己不算内容。把它算进去会自我维持：内容 390 + 栏 26 > 400 → 显示栏 →
    // 下一轮又量到 416 → 一直显示。所以量之前先把它排除。
    if (child.dataset.tcChrome !== undefined) continue
    total += Math.max(child.scrollHeight, child.offsetHeight)
  }
  return total
}
