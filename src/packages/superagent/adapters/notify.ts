/**
 * 结果通知：工单结束时往 `outbox` 里放一句人能直接读的话，并把待发的取成「最近动态」。
 *
 * 设计文档第 12 节「第 6 步」把这件事和三条命令放在一起，但这里**不碰网络**：
 * 入队只写一行 `outbox`（`kind: 'notice'`，`message.ticketId` 指回工单），真正把它发到聊天
 * 里是通道的事（P1），这里连 fetch 都没有。也**不写 transcript**：这笔账在 `event` 表里
 * （`runtime.record` 逐条落库），通知只是给人看的那一句。
 *
 * 为什么复用 `outbox` 而不是另开一张表：P0 的 `outbox` 本来就是「待执行的副作用，发完即删」
 * （`adapters/store.ts:75`），通知正是这个语义；另开一张表要迁移、要清理，收益为零。
 *
 * `drain()` 取走即删（`DscStore.drainOutbox`），拿到的东西存进内存窗口 `recent()`，
 * 给第 7 步的快照面用。窗口上限 20 条：这是「动态」，不是审计，多了没人看。
 *
 * @module dsc/packages/superagent/adapters/notify
 */
import { latestAssignment, latestReport, type ChannelRef, type OutboundMessage, type Ticket } from '../core/index.js'
import { StoreOutbox } from './outbox.js'
import type { DscStore, OutboxItem } from './store.js'

/** 「最近动态」的一条：`at` 是入队时刻，`text` 就是那句话本身。 */
export interface RecentNotice {
  at: string
  text: string
}

/** 内存窗口的容量：超出就丢最旧的。 */
export const RECENT_CAP = 20

/**
 * 一次从库里取多少行。
 *
 * 取走即删、没有游标，所以 `drain()` 会按这个批量反复取直到空；给 50 是「一张工单狂刷也
 * 不至于一次只有 20 条」，同时不让单条 SQL 的参数表膨胀。
 */
const DRAIN_BATCH = 50

/**
 * 通知消息的通道占位。
 *
 * `OutboundMessage.channel` 是必填的 `ChannelRef`（`core/ports.ts:72`），但 P0 没有真的发送方，
 * 也没有「通知发到哪个会话」这个设置。这里给一个自解释的常量：以后接通道时按 `source` 分流，
 * 不会把它错投到某个真实会话里。
 */
const NOTICE_CHANNEL: ChannelRef = { source: 'manual', thread: 'manual:notice', address: {} }

/** 交付摘要可能很长（worker 会列出每个改动文件）；通知只要一句，截到这里。 */
const SUMMARY_MAX = 200

/** 把多行摘要压成一行，超长截断。 */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX)}…` : flat
}

/**
 * 工单结束时那句话。
 *
 * 规则只有一条：**成功说清改了什么，失败说清失败在哪一步**。
 * - 成功（`completed` / `merged`）用 worker 最后一段报告——那是它写的交付摘要（改了哪些文件）；
 * - `closed` 说清 PR 没合并；
 * - `stopped` 是「人叫停」，所以不叫失败；但若最后一份报告是 `failed`，仍要把卡住的那一步写出来。
 *
 * `startedAt` 是判断「哪一步」的唯一依据：没开始过说明倒在派工（建工作树 / 起 worker），
 * 开始过就是 worker 的回合。
 */
export function noticeText(ticket: Ticket): string {
  const head = `工单「${ticket.title}」`
  const report = latestReport(ticket)
  const summary = clip(report?.summary ?? '')
  const step = latestAssignment(ticket)?.startedAt === undefined ? '派工（建工作树、起 worker）' : 'worker 的回合'
  const changed = summary === '' ? '' : `：${summary}`
  switch (ticket.ended?.outcome) {
    case 'completed':
      return summary === '' ? `${head}已完成，但 worker 没留交付摘要。` : `${head}已完成${changed}`
    case 'merged':
      return `${head}已结束：它跟的 PR 已合并${changed}`
    case 'closed':
      return `${head}已结束：它跟的 PR 被关闭，没有合并${changed}`
    case 'dropped':
      return summary === '' ? `${head}已结束：worker 说没有剩下要做的事。` : `${head}已结束：worker 说没有剩下要做的事${changed}`
    case 'stopped':
      // 叫停不是失败；但如果它本来就卡在失败上，那句话必须把失败的那一步说出来。
      if (report?.state === 'failed') {
        return `${head}已停止。失败在${step}${summary === '' ? '（没有错误详情）' : changed}`
      }
      return `${head}已停止（你要求停止）。`
    default:
      return `${head}已结束。`
  }
}

/** 从一行 outbox 里读那句话；不是通知（没有 `payload.message.text`）就给空串。 */
function textOf(row: OutboxItem): string {
  const payload = row.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const message = (payload as Record<string, unknown>).message
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return ''
  const text = (message as Record<string, unknown>).text
  return typeof text === 'string' ? text.trim() : ''
}

/** 从一行 outbox 里读入队时刻（我们自己写的行才有）；别家写的行没有时间字段。 */
function atOf(row: OutboxItem): string | undefined {
  const payload = row.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const at = (payload as Record<string, unknown>).at
  return typeof at === 'string' && at !== '' ? at : undefined
}

/**
 * 通知的落点：一条 `outbox` 行 + 一个内存窗口。
 *
 * 不持有自己的数据库连接：`DscStore` 是唯一写入口（第二个 WAL 写者会让事务互不可见，
 * 见 `runtime.ts` 构造里的注释）。
 */
export class StoreNotifier {
  private readonly store: DscStore
  /** 只用来做 id 幂等（同一条通知不重复入队），不负责发送。 */
  private readonly queue: StoreOutbox
  private readonly clock: () => string
  /** 最近动态，最旧在前、最新在末尾。 */
  private readonly items: RecentNotice[] = []

  /**
   * @param store - 编排库；调用方负责开关
   * @param options.now - 时钟；缺省读系统时钟（只在别家写的 outbox 行缺时间时用得上）
   */
  constructor(store: DscStore, options: { now?: () => string } = {}) {
    this.store = store
    this.queue = new StoreOutbox(store)
    this.clock = options.now ?? (() => new Date().toISOString())
  }

  /**
   * 工单结束：入队一条 `notice`。
   *
   * 幂等键是「工单 id + 结束时刻」：工单被一条新消息唤醒后又结束，时刻会变，那是新的一条；
   * 同一次结束重复调用则原地不动。查重走 `StoreOutbox.status`，它读同一张表、不写。
   *
   * @param ticket - 已经结束的工单；没结束的（没有 `ended`）直接返回，不编通知
   */
  ended(ticket: Ticket): void {
    const ended = ticket.ended
    if (ended === undefined) return
    const id = `notice:${ticket.id}:${ended.at}`
    if (this.queue.status(id) !== undefined) return
    const message: OutboundMessage = {
      id,
      channel: NOTICE_CHANNEL,
      text: noticeText(ticket),
      kind: 'notice',
      ticketId: ticket.id,
    }
    // `at` 一起写进 payload：行一旦入队就与内存无关了，库里的东西要自解释（同 outbox.ts 的理由）。
    this.store.enqueueOutbox({ id, kind: 'notice', payload: { message, at: ended.at } })
  }

  /**
   * 把 `outbox` 里待发的全取出来，转成最近动态。
   *
   * 取走即删（`drainOutbox` 的语义），所以同一行不会被读第二次；别家写的消息（回执 / 回复）
   * 也在这张表里，它们同样有 `message.text`，一起进「最近动态」是合理的——人看到的本来就是
   * 一切要说的话。
   *
   * @returns 收完之后窗口里的快照（最多 {@link RECENT_CAP} 条）
   */
  drain(): RecentNotice[] {
    const fresh: RecentNotice[] = []
    for (;;) {
      const rows = this.store.drainOutbox(DRAIN_BATCH)
      if (rows.length === 0) break
      for (const row of rows) {
        const text = textOf(row)
        if (text === '') continue
        fresh.push({ at: atOf(row) ?? this.clock(), text })
      }
      if (rows.length < DRAIN_BATCH) break
    }
    this.remember(fresh)
    return this.recent()
  }

  /** 最近动态：最旧在前、最新在末尾。给副本，外面改它不影响这个窗口。 */
  recent(): RecentNotice[] {
    return [...this.items]
  }

  /** 收进窗口，超容量丢最旧的。 */
  private remember(fresh: readonly RecentNotice[]): void {
    if (fresh.length === 0) return
    this.items.push(...fresh)
    const overflow = this.items.length - RECENT_CAP
    if (overflow > 0) this.items.splice(0, overflow)
  }
}
