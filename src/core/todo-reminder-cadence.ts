/**
 * todo 节流提醒的**注入节流台账**（纯逻辑，投影本体在 `packages/todo/index.ts`）。
 *
 * ## 为什么需要这一层
 *
 * `appendTodoReminder`（见 `core/todo-reminder.ts`）只回答「这条历史该不该在**这一刻**补一句」，
 * 它的幂等判据是「历史里已经有这条提醒就不补」。可是提醒是**投影注入、不落会话历史**
 * （`core/todo-reminder.ts` 的文件头写了为什么刻意不落）：历史里永远查不到它，于是
 * 「距上次写清单已经 ≥ N 轮」这个条件一旦成立，**之后每一跳的请求都满足**——从第 9 次请求
 * 起，每一跳都会再补一次同一句提醒。白烧 token 还在其次，同一句话反复出现在同一段上下文里，
 * 模型会把它当背景音，提醒本身就失效了。
 *
 * 所以投影那边要另记一笔账：**这条会话上一次真的注入提醒的那一轮**，判据是
 * 「本轮 − 上次注入的轮 ≥ everyRounds」。口径与契约（`contract/transcript.ts` 的
 * `CONTEXT_INJECTION_KINDS.todoReminder`）一致：每 N 轮一次。
 *
 * ## 三个细节
 *
 * 1. **按会话记**：常驻多 agent 下每条会话有自己的清单与轮次，A 会话刚提醒过不代表 B 会话
 *    的提醒也该省掉。写法照 `packages/prompt/index.ts` 的 `envSent`（约 :163）：`Map<会话 id, …>`、
 *    只活内存、表满（64 条）整表清掉——进程重启后一律当「首次」，宁可多发一条提醒，
 *    也不要让一条本该出现的提醒无声消失。
 * 2. **轮号 = 这条会话里已有的 assistant 消息条数**（一轮 = 一次模型请求 = 一条 assistant
 *    消息，与 `countRoundsSinceLastTodoWrite` 同一口径）。不用「距上次写清单的轮数」当轮号：
 *    那个数在每次 `todo_write` 之后清零，拿它当周期判据会让提醒越拖越稀——写一次清单，
 *    下一次提醒就要多等整整一个周期，而且每写一次都再退一步。
 * 3. **同一轮重复投影要给出同一个答案**：回合环在请求发出前会把投影链再跑一遍做
 *    「日志 + 投影链能否重建这份请求」的校验（`packages/session-core/loop.ts:611`），
 *    两次跑的是同一份输入、同一轮号。所以「本轮 == 上次注入的轮」也算**该注入**，
 *    否则第二遍会少一句，invariant 当场报「对不上」。重试同一轮（流中断后再发一次）
 *    也是这个道理：同一轮号应当拿到同一份请求。
 *
 * @module dsc/core/todo-reminder-cadence
 */
import type { ChatMessage } from './llm.js'

/**
 * 这条会话已经走到第几轮：数历史里有几条 assistant 消息（0 基）。
 *
 * 只看 assistant：user 是这一轮的开头（还没答），tool 是这一步的中间产物；都算不上一轮。
 * 环境快照那条 user 也因此在外面（它同样不是轮）。
 *
 * 压缩会改小这个数（历史被摘要替换）：{@link TodoReminderCadence.due} 把「轮号倒退」
 * 当台账失效处理，理由见那边的注释。
 *
 * @param messages 组装好要发给模型的那份消息（或会话历史，assistant 条数一样）
 * @returns 轮号（0 表示还没有一条 assistant）
 */
export function countRounds(messages: readonly ChatMessage[]): number {
  let rounds = 0
  for (const message of messages) {
    if (message.role === 'assistant') rounds += 1
  }
  return rounds
}

/**
 * 注入节流台账：按会话记住「上一次真的注入提醒的那一轮」。
 *
 * 用法固定成两步（投影里照抄这一顺序）：
 *
 * ```ts
 * if (!cadence.due(sessionId, round, everyRounds)) return messages
 * const out = appendTodoReminder(messages, options)
 * if (out !== messages) cadence.mark(sessionId, round)
 * ```
 *
 * **只有真注入了才记账**：`appendTodoReminder` 拒绝的那一跳（开关关着、清单里没有未完成项、
 * 距上次写清单还不够 N 轮）什么也没补，若也跟着记账，下一跳就会被误判成「刚提醒过」，
 * 提醒被白白推迟一整个周期。
 */
export class TodoReminderCadence {
  /** 会话 id → 上一次真的注入过提醒的轮号。 */
  private readonly lastInjected = new Map<string, number>()

  /**
   * 这一跳该不该试着注入提醒。
   *
   * @param sessionId 会话 id（`session.meta.id`）；不同会话互不影响
   * @param round 这一跳的轮号（{@link countRounds}）
   * @param everyRounds 每几轮提醒一次（夹到 ≥1，免得配成 0 变成每跳都试）
   * @returns 该试返回 true；离上次注入还差几轮返回 false
   */
  due(sessionId: string, round: number, everyRounds: number): boolean {
    const every = Math.max(1, Math.floor(everyRounds))
    const last = this.lastInjected.get(sessionId)
    // 首次（含进程刚起来、会话刚恢复）：契约要求「首次必注入」，试一次由调用方定夺。
    if (last === undefined) return true
    // 轮号倒退：历史被压缩过，之前记的轮号已经不在同一条数轴上了。当台账失效处理，
    // 否则「上次注入在 100 轮」会把之后几十轮全挡住（100−20 ≥ 8 永远不成立的反面）。
    if (round < last) return true
    // 同一轮重复投影（invariant 二次派生、流中断后的整轮重试）：必须给同一个答案。
    if (round === last) return true
    return round - last >= every
  }

  /**
   * 记下这一轮真的注入了提醒。
   *
   * 表满时整表清掉（与 `envSent` 同一条取舍）：清完所有会话都按「首次」重来一次，
   * 代价是每条会话多一条提醒，比无界长大好。
   *
   * @param sessionId 会话 id
   * @param round 这一跳的轮号
   */
  mark(sessionId: string, round: number): void {
    if (this.lastInjected.size >= 64 && !this.lastInjected.has(sessionId)) this.lastInjected.clear()
    this.lastInjected.set(sessionId, round)
  }
}
