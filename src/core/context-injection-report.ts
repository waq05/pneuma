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
 * ## 还有第二道闸：留底闸（{@link InjectionNoteLedger}）
 *
 * 注入方除了「要不要长卡」，还要决定「要不要往会话日志落一条 note」。规矩是
 * `session-core/loop.ts:77`：往请求里注入日志上没有的内容，注入方自己留底。可是同一份
 * 历史会被投影链跑**两遍**——一遍是真正发给模型的请求，另一遍是请求发出前的不变量校验
 * （`loop.ts:452` 的 `checkRequestInvariant`）。两遍算出来的注入一字不差，但第二遍并没有
 * 发出去，跟着落 note 就会「每注入一次、日志里多两条」。
 *
 * 判据与上报闸不同：上报闸比的是「正文有没有变」（同一句话每 N 轮重注一次，正文没变，
 * 仍不该画第二张卡）；留底闸比的是「**这一份历史**是不是已经为这句话留过底」。同一份历史
 * 重跑时最后一条消息还是同一个对象，两次真请求之间一定落过新的 assistant / tool 消息、
 * 对象引用不同。所以判据 = 会话 id + 历史最后一条消息的对象引用 + 正文。
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

/**
 * 留底台账：按会话记住「上一次为哪一份历史、哪一句正文落过 note」。
 *
 * 投影里固定这么用（先判再落，判与落必须挨在一起）：
 *
 * ```ts
 * if (out === messages) return out
 * const last = owner.messages[owner.messages.length - 1]
 * if (noted.take(owner.meta.id, last, text)) owner.appendNote(id, text)
 * return out
 * ```
 *
 * 同一份历史的二次派生（invariant 校验）拿到同一个 `last` 对象引用与同一句正文，
 * 第二次 `take` 返回 false，note 不重复落。两次真请求之间日志里一定落过新消息，
 * 引用不同，照常落。
 *
 * 只活在内存里：进程重启后一律当「首次」，宁可让某次注入多一条 note，也不要让一次
 * 真注入无声无息、事后对不出模型当时多看了什么。表满整表清（与 `envSent`、
 * {@link InjectionReportLedger} 同一条取舍）。
 */
export class InjectionNoteLedger {
  /** 会话 id → 「上次落 note 时历史的最后一条消息（按引用比）+ 正文」。 */
  private readonly noted = new Map<string, { last: object | undefined; text: string }>()

  /**
   * 判一次并记账：这一跳该不该落 note。
   *
   * @param sessionId - 会话 id（`session.meta.id`）；不同会话互不影响
   * @param last - 这一跳对应历史的最后一条消息（`session.messages` 的尾项，没有则为 `undefined`）
   * @param text - 要落的正文（注入原文）
   * @returns 该落返回 true；同一份历史、同一句正文已经落过返回 false
   */
  take(sessionId: string, last: object | undefined, text: string): boolean {
    const prev = this.noted.get(sessionId)
    if (prev !== undefined && prev.last === last && prev.text === text) return false
    // 只为新会话清表：已有会话刷新自己那条时表并不会变大，顺手清掉会误伤别人的记录。
    if (this.noted.size >= 64 && prev === undefined) this.noted.clear()
    this.noted.set(sessionId, { last, text })
    return true
  }
}
