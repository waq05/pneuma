/**
 * 这一条条目会不会真的画出东西。
 *
 * 为什么要有这一问：宿主把一些条目记进会话流，但界面**故意不画**它们——
 * 改动明细（`changes` / `turnDiff`）统一由轮尾那张「已编辑 N 个文件」卡汇总，
 * 正常收尾的 `turn-end` 也不单独说话（结束状态写在整轮开关那一行）。
 * 座位（`RowSeat`）以前照样给它们建一个空盒子，而过程区是 `gap: 3px` 的 flex 列，
 * 空盒子**同样吃一个缝**：一轮改五个文件就在组头与下一行之间叠出 27px 的空白
 * （2026-11-08 用户报障：组头下面一大片白，才轮到「后台作业 job-1 完成了」）。
 *
 * 所以判据放在渲染前，而不是靠 CSS 去`display:none`——后者不产生盒子，
 * 但 React 里仍是一次挂载与一次布局计算，且`hidden`那套「Ctrl+F 能命中」的
 * 语义在这里没有意义（这些条目本来就没有可读正文）。
 *
 * 口径：
 * - `changes` / `turnDiff`：永不上屏（汇总卡读的是 `seat.rows`，与画不画这一行无关）；
 * - `turn-end`：正常结束（`completed`）安静，中断 / 跑挂才出那一句；
 * - `text`：正文是空白（全是空格换行）的不占位——流式开始时那一帧正是这样；
 * - 其余照旧。
 *
 * @module dsc-ui-shell/plugins/transcript/row-shows
 */
import type { TranscriptEntry } from '@dsc/ui'

/** 这一条会不会画出可见内容（false = 别给它建座位）。 */
export function rowShows(entry: TranscriptEntry): boolean {
  switch (entry.kind) {
    case 'changes':
    case 'turnDiff':
      return false
    case 'turn-end':
      return entry.reason !== 'completed'
    case 'text':
      return entry.text.trim() !== ''
    default:
      return true
  }
}
