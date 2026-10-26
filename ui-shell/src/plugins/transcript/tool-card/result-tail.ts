/**
 * 收起态工具卡的「结果尾巴」：把一次调用的输出压成最后几行，给没点开的卡一句交代。
 *
 * 为什么需要它（对照 codex 的 compact 输出预览）：工具卡收起时只写着「读取 / 搜索 / 完成」，
 * 用户想知道这一条到底得到了什么，只能逐张点开——长会话里几十张卡，点开一遍就丢了上下文。
 * codex 的做法是每条活动最多摊「标题 + 3 行输出」（exec_cell/compact.rs:113-129 与
 * history_cell/activity_preview.rs:7），收起态本身就是一句结果。
 *
 * 三个口径，都是为了让预览「说的是结果」而不是又一份日志头：
 * - **取尾巴不取头**：命令的退出状态、错误的最后一行都在末尾，头几行往往只是启动横幅；
 * - **丢掉纯空白行**：预览只有 3 行，空行占掉一行等于少读一行输出；
 * - **单行截到 {@link PREVIEW_LINE_MAX_CHARS} 字**：一条压缩过的 JSON 可能有几十万字符，
 *   原样塞进 DOM 三行就是三份长字符串，滚动与重排都会跟着变慢。
 *
 * 本模块不碰 React，纯函数可以直接测（scripts/ui-transcript-render-test.mjs）。
 *
 * @module dsc-ui-shell/plugins/transcript/tool-card/result-tail
 */

/** 收起态最多摊几行结果（与 codex 的 DETAIL_PREVIEW_LINES 同值）。 */
export const RESULT_TAIL_LINES = 3

/** 预览里单行最多保留几个字（超出截断并补省略号）。 */
export const PREVIEW_LINE_MAX_CHARS = 300

/** 一次调用在收起态能摊出来的东西。 */
export interface ResultTail {
  /** 要摊的那几行（最多 {@link RESULT_TAIL_LINES} 行，顺序与输出一致）。 */
  lines: string[]
  /** 还有几行没摊出来（0 表示已经全在这里了）。 */
  hidden: number
}

/**
 * 把工具结果压成收起态的预览行。
 *
 * @param text 工具结果原文（可能很大，也可能根本没回来）
 * @param limit 最多摊几行（缺省 {@link RESULT_TAIL_LINES}）
 * @returns 预览；结果为空白时返回 null（这时候摊出来的只会是一条空行，不如不画）
 */
export function resultTail(text: string | undefined, limit = RESULT_TAIL_LINES): ResultTail | null {
  if (text === undefined || text.trim() === '') return null
  const all = text.replace(/\r\n?/g, '\n').split('\n')
  // 末尾的空行是工具输出常见的收尾（每行都以换行结束），不该占掉一行预览。
  let end = all.length
  while (end > 0 && (all[end - 1] ?? '').trim() === '') end -= 1
  const kept: string[] = []
  for (let index = 0; index < end; index += 1) {
    const line = (all[index] ?? '').replace(/[ \t]+$/, '')
    if (line.trim() === '') continue
    kept.push(clipLine(line))
  }
  if (kept.length === 0) return null
  const lines = kept.slice(-Math.max(1, limit))
  return { lines, hidden: kept.length - lines.length }
}

/** 单行截断：按码点切，不切出半个代理对；截断点补一个省略号。 */
function clipLine(line: string): string {
  if (line.length <= PREVIEW_LINE_MAX_CHARS) return line
  return `${Array.from(line).slice(0, PREVIEW_LINE_MAX_CHARS - 1).join('')}…`
}
