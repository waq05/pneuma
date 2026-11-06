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

/**
 * 收起态最多摊几行结果。**0 = 收起态只留头行**（2026-10-27 起）。
 *
 * 原来是 3 行（照 codex 的 DETAIL_PREVIEW_LINES）：卡收起时也能读到最后几行输出。
 * 用户报「工具调用在折叠状态时占用面积太大，只占一行就行」——三行预览让每张卡从
 * 一行变四行，一轮里十几张卡就是半屏。现在收起态只画头行（仍然带「+N 行」读数，
 * 点开才看结果），这个常量留在这里是为了那个行数计算。
 */
export const RESULT_TAIL_LINES = 0

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
  const kept = contentLines(text)
  if (kept === null) return null
  const cap = Math.max(0, limit)
  const lines = cap === 0 ? [] : kept.slice(-cap)
  return { lines, hidden: kept.length - lines.length }
}

/**
 * 展开体输出区的「首行摘要」：取第一行有内容的文字，其余行数进 hidden。
 *
 * 与 {@link resultTail} 同一套口径（同一份压平、去空行、单行截断），只是取**头**不取尾：
 * 命令输出的表头、读取结果的第一行、搜索的第一处命中都在开头；展开体的第一段回答的是
 * 「这次调用回来的是什么」，不是「最后一行说了什么」。
 *
 * @param text 工具结果原文
 * @param limit 最多摊几行（缺省 1：只露首行）
 */
export function resultHead(text: string | undefined, limit = 1): ResultTail | null {
  const kept = contentLines(text)
  if (kept === null) return null
  const cap = Math.max(0, limit)
  const lines = cap === 0 ? [] : kept.slice(0, cap)
  return { lines, hidden: kept.length - lines.length }
}

/**
 * 结果原文 → 预览行：换行归一、去空行、行尾空白剪掉、单行截断。
 *
 * 两条预览（收起态取尾巴 / 展开体取头）都从这里拿，避免两边对「什么算一行」各写一套。
 * 末尾的空行是工具输出常见的收尾（每行都以换行结束），空白行不占预览额度。
 */
function contentLines(text: string | undefined): string[] | null {
  if (text === undefined || text.trim() === '') return null
  const kept: string[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/[ \t]+$/, '')
    if (line.trim() === '') continue
    kept.push(clipLine(line))
  }
  return kept.length === 0 ? null : kept
}

/**
 * 首行之外还剩下的原文（展开体「展开更多」用）。
 *
 * 为什么单独给一份原文而不是复用 {@link resultTail}：预览要的是「压平、截断、只留几行」，
 * 展开要看的是**原样**——多行的缩进、空行都该在。所以这里只做一件事：跳过前导空行，
 * 从第一个有内容的行之后原样切出去。
 *
 * @param text 工具结果原文
 * @returns 首行之后的原文；只有一行、或没有内容时给空串
 */
export function resultRest(text: string | undefined): string {
  if (text === undefined || text.trim() === '') return ''
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let first = -1
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() !== '') {
      first = index
      break
    }
  }
  if (first < 0) return ''
  return lines.slice(first + 1).join('\n')
}

/** 单行截断：按码点切，不切出半个代理对；截断点补一个省略号。 */
function clipLine(line: string): string {
  if (line.length <= PREVIEW_LINE_MAX_CHARS) return line
  return `${Array.from(line).slice(0, PREVIEW_LINE_MAX_CHARS - 1).join('')}…`
}
