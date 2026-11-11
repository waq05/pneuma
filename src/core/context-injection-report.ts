/**
 * 「这一份注入该不该再上报一张卡」的纯逻辑（投影的上报闸）。
 *
 * ## 为什么需要这道闸
 *
 * 本仓的注入是**投影注入、不落会话历史**：env-facts 每轮都往请求末尾补一份环境快照，
 * 待办提醒与重复调用提醒也在命中时补一句。跳过任何一跳，那一跳的模型就真的没有这份
 * 上下文——所以「每跳都注入」这条行为不能改成「没变就不发」。
 *
 * 但**记账**是另一件事。会话流里的注入卡回答的是「这一跳**新增**了哪些注入」：同一份
 * 环境快照在第 2..16 跳一字未变，再画一张「环境快照 875 字」的卡并不能告诉读者任何
 * 新东西，反而把「第 1 跳注入了什么」淹没在一排一模一样的卡里；而且日志里每跳记一条，
 * 重开这条会话重放出来的卡片数量就会跟实时对不上（重开的卡与实时逐字一致，才是这张卡
 * 可信的前提）。
 *
 * 判据只有一条：**这次要上报的正文与上一次上报过的完全相同 → 不上报**。首次必报；
 * 空文本没有正文可报，不上报，但会被记成「当前状态」，这样它重新出现时才算新。
 *
 * ## 为什么不能与注入闸共用一个 Map
 *
 * prompt 插件里的 `envSent` 记的是「上一份快照的文本 + 时刻」，回答的是「这一跳还要不要
 * 注入」（`envRefreshMs` 缺省 0 = 每跳都注入）；本台账记的是「上一份上报过的正文」，
 * 回答的是「这一跳还要不要长卡」。两件事的触发条件不同，共用一份表就会互相污染：
 * 注入被跳过的那一跳不该动台账；台账若跟着注入闸一起失效，下一跳就会把一份其实从没
 * 上报过的正文当成「报过了」而永远不再报。所以两边各记各的，注释也各写各的。
 *
 * 为什么按会话记：常驻多 agent 下每条会话有自己的工作目录、模式与清单，A 会话的环境
 * 没变不代表 B 会话的也没变。
 *
 * @module dsc/core/context-injection-report
 */

/**
 * 这一跳该不该上报这份注入（纯函数，不碰任何状态）。
 *
 * @param last - 这个会话、这一类注入上一次上报过的正文（`undefined` = 还没报过）
 * @param next - 这一跳要上报的正文
 * @returns 该上报返回 true；正文空白、或与上次逐字相同返回 false
 */
export function shouldReport(last: string | undefined, next: string): boolean {
  // 空正文没有可看的读数，报一条「0 字」只会是噪声；也不算「内容变了」。
  if (next.trim() === '') return false
  return last !== next
}

/**
 * 上报台账：按「会话 → 注入类别」记住上一次上报过的正文。
 *
 * 只活在内存里：进程重启后一律当「首次」，宁可让每类注入多报一条，也不要让一份
 * 其实刚变过的注入无声消失。表满时整表清掉（与 prompt 插件的 `envSent` 同一条取舍）。
 */
export class InjectionReportLedger {
  /** 会话 id → （注入类别 → 上一次上报过的正文）。 */
  private readonly sessions = new Map<string, Map<string, string>>()

  /**
   * 判一次并记账：这一跳的正文无论报不报，都记为「当前状态」。
   *
   * 空文本也记（理由见 {@link shouldReport} 的说明）：片段从「有」变「空」再变回来，
   * 是一次真实的重新出现，不能因为中间那几跳没上报就把它当成「跟上次一样」。
   *
   * @param sessionId - 会话 id（`session.meta.id`）；不同会话互不影响
   * @param kind - 注入类别（`env-facts` / `mode` / `sandbox` / `todo-reminder` …），片段各算一类
   * @param text - 这一跳要上报的正文
   * @returns 该不该上报
   */
  take(sessionId: string, kind: string, text: string): boolean {
    let kinds = this.sessions.get(sessionId)
    if (kinds === undefined) {
      if (this.sessions.size >= 64) this.sessions.clear()
      kinds = new Map()
      this.sessions.set(sessionId, kinds)
    }
    const report = shouldReport(kinds.get(kind), text)
    kinds.set(kind, text)
    return report
  }
}
