/**
 * 移植自 dsh-superagent/src/app/delivery.ts（86 行，原生重写）。
 *
 * 上游职责不变：按 request id 幂等地把一条消息投给一个会话，跨会话重启不重复投；
 * 投递前调 `authorize`、投出去后调 `accepted`；消息带自己的来源，不会被人打的字认领。
 *
 * 与上游的差异（逐条，都是 DSH 能力换成本仓原生能力）：
 * 1. **幂等账**：上游靠 DSH 消息 id（`dsh-superagent:<requestId>`）+ session-persistence 回放。
 *    本仓消息没有 id 字段，改为「投递成功时往会话日志写一条 note，id = `dsh-superagent:<requestId>`」；
 *    重启后 `Session.load` 重放 note 记录，`session.notes()` 仍读得到——等价于「跨重启不重复投」。
 * 2. **排队账**：还没出账的那一条另记在 `Store` 的 KV 里（`superagent-delivery-pending:` 键族，
 *    session + request → 正文）。为什么不能只放内存：上游 `inbox.remove` 撤的是**持久收件箱**里的
 *    消息，重启后执行器要能按 requestId 把它撤掉（`executor/dsh.ts` 的 launch 那一步），内存账
 *    重启就没了。键族用 `kv.ts` 导出的 `family()` 定义（外部插件自建键的官方口子）。
 * 3. **已投集合的来源**：上游订阅 `session/event` 增量；本仓从 `session.notes()` 建一次缓存，
 *    之后由本模块自己追加（只有本模块写这个前缀的 note），不再订阅事件。
 * 4. **flush**：本仓 `appendUser` / `appendNote` 同步落盘（`core/session.ts` 的 write），
 *    没有待刷缓冲，因此没有上游最后那句 `sessionPersistence.flush()`。
 * 5. **消息来源**：上游用 MessageSourceMap 的 `dsh-superagent` source；本仓用
 *    `Session.appendUser` 的 `origin`——机器投递一律 `'notice'`，界面据此画内部触发行，
 *    重放走同一个字段（`core/session.ts` 的 InboxOrigin）。
 * 6. **三种模式的落点**（对照 `session-core/loop.ts` 的收件箱语义）：
 *    - `queue`：下一轮才出账 → 跑动中 `session.enqueueAsync(..., 'user')`，闲置时 `agent.followup`；
 *    - `steer`：步骤边界并进本轮 → 跑动中 `session.enqueueAsync(..., 'notice')`
 *      （loop 的 `drainInbox(true)` 只取 notice 来源，正好是「下一步先看它」），闲置时
 *      `agent.followup(..., 'notice')`；
 *    - `{ inject }`：直接写历史、不唤醒 → `session.appendUser(..., 'notice')`。
 * 7. **投递目标**：唤醒/排队要用 MiniAgent，所以目标从 dsh `Agent` 换成本仓最小结构
 *    `DeliveryTarget`（`session` + `agent`），由 `app/sessions.ts` 的 `SessionHandle` 结构满足。
 * 8. 取消上游的 `deliveryId()`：它认老插件消息来源，本仓没有那套消息来源表。
 * 9. 排队消息出账时按**正文**认回 requestId（上游按消息 id）；本仓收件箱条目没有 id
 *    （`core/session.ts:172` 的 `AsyncInboxItem` 只有正文 / 图 / 文件 / 来源）。同一条投递的
 *    「还在不在收件箱里」因此不能只按正文认：用户用 `editAsync`（`core/session.ts:1154`）把排队
 *    正文改掉之后，正文对不上，重投就会被当成新的一条再入箱一次（已实测复现），`forget` 也撤不掉。
 *    所以入箱时把那条条目对象和它的下标一起记进内存账（{@link Slot}），查询顺序是
 *    「对象还在收件箱里 → 正文精确匹配 → 原地换出来的新对象（用户改了正文）」。
 *    跨重启后内存账没了，只剩正文匹配（KV 里记的是正文，见第 2 条）：重启前改了正文、重启后
 *    再重投，仍会认不出。要根治得给收件箱条目加 id（`src/core/**` 不在本轮可写范围）。
 *    还有一条从正文推断出来的边界：这一条当时是**队尾**，用户先把它撤掉、紧接着又排进一条新的
 *    （新消息追加到队尾，正好落在原下标），而新条目还没被本模块观察到——两条账都分不出来，
 *    会把新条目当成它的编辑。这个窗口只有「同一次投递模块调用之前连续两个界面动作」那么宽；
 *    要根治同样得靠条目 id。
 *
 * 另有一条已知边界，改不动、只记下来：正文被改过、且改过的那条**已经出账**之后才重投时，
 * `claim` 仍是按正文认（`app/sessions.ts:532` 只传正文），认不回来 → 永久账漏记，重投会再入箱一次。
 * 补它要让 `superagent/inbox-claimed` 带上认回的 requestId（`app/sessions.ts` 不在本轮可写范围）。
 *
 * @module dsc/packages/superagent/app/delivery
 */
/** Idempotent message delivery to Session agents across Session restarts. */
import type { MiniAgent } from '@pneuma/session-core/loop.js'
import type { AsyncInboxItem, Session } from '@pneuma/runtime/core/session.js'
import { family } from '../kv.js'
import type { Store } from './store.js'

/** 幂等 note 的 id 前缀：`<前缀><requestId>` 就是这条投递的永久账。 */
export const DELIVERY_NOTE = 'dsh-superagent:'
/**
 * 排队中（还没出账）的投递：会话 id + request id → 正文。
 * 分隔符用 `|`：会话 id 是 uuid / `worker-<hex>`，request id 由本模块与执行器给，两者都不含它。
 */
const PENDING = family<string, [session: string, request: string]>('superagent-delivery-pending:', (session, request) => `${session}|${request}`)
/** 一条投递的 id，与上游 `messageId(requestId)` 逐字相同。 */
export type PromptedId = string
/** The id of the message delivered under `requestId`, the same on every retry. */
export const messageId = (requestId: string): PromptedId => `${DELIVERY_NOTE}${requestId}`
/** 从 `promptedId` 取回 requestId；不是本模块发的 id 时返回 undefined。 */
export const requestIdOf = (id: PromptedId): string | undefined => id.startsWith(DELIVERY_NOTE) ? id.slice(DELIVERY_NOTE.length) : undefined

/** 投递目标：会话本体 + 唤醒/排队要用的 agent（`SessionHandle` 结构上满足它）。 */
export interface DeliveryTarget {
  readonly session: Session
  readonly agent: MiniAgent
}
/** 投递模式，与上游同名同义。 */
export type DeliveryMode = 'queue' | 'steer' | { inject: string }
/** `send` 的结论：立即进历史 / 排进收件箱等出账 / 这个 requestId 已经投过。 */
export type DeliveryOutcome = 'landed' | 'queued' | 'duplicate'

interface Seen { ids: Set<string> }
/**
 * 一条排队投递在收件箱里的落点：入箱那一刻的条目对象 + 下标。
 *
 * 为什么记对象：`editAsync` 是**原地换掉**一个条目（`[index] = { text, ... }`），对象变了、下标不变；
 * 记着旧对象就能认出「这个位置换出来的新对象就是它」，而不用拿正文去猜。下标随收件箱的增删会漂，
 * 所以每次按对象认回来时一并刷新。
 */
interface Slot { item: AsyncInboxItem; index: number }

/**
 * Delivers messages to Session agents at most once per request ID across active and restored Sessions.
 * Tracks delivered message IDs from the durable note ledger and the pending inbox so retries from `Sessions` do not duplicate messages,
 * and marks delivered messages as machine notices (`origin: 'notice'`) rather than messages written by a person.
 */
export class AgentDelivery {
  private readonly seen = new WeakMap<Session, Seen>()
  private readonly queued = new WeakMap<Session, Map<string, string>>()
  /** 还没出账的投递 → 它入箱时那条收件箱条目（内存账，见文件头第 9 条与 {@link Slot}）。 */
  private readonly slots = new WeakMap<Session, Map<string, Slot>>()
  /** 这个会话收件箱里见过的条目对象：用来判「这个位置上的条目是原地换出来的新对象」。 */
  private readonly observed = new WeakMap<Session, WeakSet<AsyncInboxItem>>()

  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'delete' | 'keys'>) {}

  /** 这个会话投递过的 id 集合：从会话日志的 note 记录恢复（跨重启有效），之后增量维护。 */
  private delivered(session: Session): Seen {
    let seen = this.seen.get(session)
    if (seen === undefined) {
      seen = { ids: new Set(session.notes().flatMap(note => note.id.startsWith(DELIVERY_NOTE) ? [note.id] : [])) }
      this.seen.set(session, seen)
    }
    return seen
  }
  /** 这个会话还没出账的投递：首次读时从 KV 恢复（跨重启有效），之后增量维护。 */
  private pendingOf(session: Session): Map<string, string> {
    let queued = this.queued.get(session)
    if (queued === undefined) {
      queued = new Map()
      const head = `${PENDING.prefix}${session.meta.id}|`
      for (const name of this.store.keys(PENDING.prefix)) {
        if (!name.startsWith(head)) continue
        const text = this.store.get(PENDING(session.meta.id, name.slice(head.length)))
        if (text !== undefined) queued.set(name.slice(head.length), text)
      }
      this.queued.set(session, queued)
    }
    return queued
  }
  private remember(session: Session, requestId: string, text: string, item: AsyncInboxItem | undefined): void {
    this.pendingOf(session).set(requestId, text)
    this.store.set(PENDING(session.meta.id, requestId), text)
    const slots = this.slotsOf(session)
    if (item === undefined) slots.delete(requestId)
    else slots.set(requestId, { item, index: session.asyncInbox().indexOf(item) })
  }
  private forgetPending(session: Session, requestId: string): void {
    this.pendingOf(session).delete(requestId)
    this.slotsOf(session).delete(requestId)
    this.store.delete(PENDING(session.meta.id, requestId))
  }
  private slotsOf(session: Session): Map<string, Slot> {
    let slots = this.slots.get(session)
    if (slots === undefined) { slots = new Map(); this.slots.set(session, slots) }
    return slots
  }
  private observedOf(session: Session): WeakSet<AsyncInboxItem> {
    let observed = this.observed.get(session)
    if (observed === undefined) { observed = new WeakSet(); this.observed.set(session, observed) }
    return observed
  }
  /**
   * 这条排队投递现在在收件箱里的下标；认不出（没排过 / 已出账 / 被撤掉）返回 -1。
   *
   * 三条判据按可靠性排：对象还在（正文被改、或被「插话」提过队都认得出）→ 正文精确匹配
   * （跨重启只剩这一条）→ 记的下标上是个没见过的新对象（用户原地改了正文）。
   * 最后一条是推断，见文件头第 9 条写的边界：同一下标上「撤掉旧的、又排进一条新的」分不出来。
   */
  private indexOf(session: Session, requestId: string): number {
    const text = this.pendingOf(session).get(requestId)
    if (text === undefined) return -1
    const items = session.asyncInbox()
    const slot = this.slotsOf(session).get(requestId)
    const observed = this.observedOf(session)
    const own = slot === undefined ? -1 : items.indexOf(slot.item)
    let index = own >= 0 ? own : items.findIndex(item => item.text === text)
    if (index < 0 && slot !== undefined) {
      // 原地换掉：`editAsync` 只改这一格，下标不动，换出来的是个没见过的对象。
      const replaced = items[slot.index]
      const claimed = replaced !== undefined &&
        [...this.slotsOf(session).values()].some(other => other.item === replaced)
      if (replaced !== undefined && !claimed && !observed.has(replaced)) index = slot.index
    }
    // 这一次看到的条目都记进 observed：下一次「原地换出来的新对象」才判得出来。
    for (const item of items) observed.add(item)
    if (index >= 0) this.slotsOf(session).set(requestId, { item: items[index]!, index })
    return index
  }
  /** Returns whether this Session already holds the message delivered under `requestId`, or has it waiting in its inbox. */
  async holds(target: DeliveryTarget, requestId: string): Promise<boolean> {
    if (this.delivered(target.session).ids.has(messageId(requestId))) return true
    return this.indexOf(target.session, requestId) >= 0
  }
  /**
   * 投一条消息，同一 requestId 至多一次；`authorize` 在动手前调，`accepted` 在投出去后调。
   * @returns 立即进了历史（landed）/ 排进收件箱等出账（queued）/ 这个 id 已经投过（duplicate）
   */
  async send(target: DeliveryTarget, requestId: string, text: string, mode: DeliveryMode, signal: AbortSignal,
    authorize?: () => void, accepted?: () => void): Promise<DeliveryOutcome> {
    signal.throwIfAborted()
    authorize?.()
    if (await this.holds(target, requestId)) { accepted?.(); return 'duplicate' }
    signal.throwIfAborted()
    const session = target.session
    if (typeof mode === 'object') {
      // 直接进历史、不唤醒：上游 `agent.inject(message)`。
      session.appendUser(text, undefined, undefined, 'notice')
      this.landed(session, requestId, 'inject')
      accepted?.()
      return 'landed'
    }
    if (target.agent.isRunning) {
      // 跑动中一律先入箱：queue 等回合收尾出账，steer 在步骤边界出账（见文件头的模式映射）。
      session.enqueueAsync(text, undefined, mode === 'steer' ? 'notice' : 'user')
      // `enqueueAsync` 追加在队尾（`core/session.ts:1127-1140`）：刚写进去的那条就是最后一条，
      // 把它的对象记进内存账，用户改了正文之后还能按 requestId 认回来（见文件头第 9 条）。
      this.remember(session, requestId, text, session.asyncInbox().at(-1))
      accepted?.()
      return 'queued'
    }
    target.agent.followup(text, undefined, mode === 'steer' ? 'notice' : 'user')
    this.landed(session, requestId, mode)
    accepted?.()
    return 'landed'
  }
  /** 记一条已投递：写永久账（note）、清排队账并更新缓存；`detail` 只进日志、便于事后对账。 */
  landed(session: Session, requestId: string, detail = ''): void {
    this.forgetPending(session, requestId)
    const id = messageId(requestId)
    const seen = this.delivered(session)
    if (seen.ids.has(id)) return
    session.appendNote(id, detail)
    seen.ids.add(id)
  }
  /** 一条消息真的进了会话历史时调：是排队中的投递就认回来，返回它的 requestId；不是本模块投的返回 undefined。 */
  claim(session: Session, text: string): string | undefined {
    const requestId = [...this.pendingOf(session)].find(([, queued]) => queued === text)?.[0]
    if (requestId === undefined) return undefined
    this.landed(session, requestId, 'queued')
    return requestId
  }
  /** 撤掉一条还没出账的投递；已经出账（或根本没排过）返回 false。 */
  forget(session: Session, requestId: string): boolean {
    const index = this.indexOf(session, requestId)
    if (index < 0) return false
    const removed = session.removeAsync(index)
    if (removed) this.forgetPending(session, requestId)
    return removed
  }
  /** 丢掉这个会话所有还没出账的投递登记（停会话、且不保留收件箱时用；见 `SessionHandle.cancel`）。 */
  discard(session: Session): void {
    for (const requestId of [...this.pendingOf(session).keys()]) this.forgetPending(session, requestId)
  }
}
