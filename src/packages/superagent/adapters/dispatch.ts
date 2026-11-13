/**
 * 出站发送：把 `outbox` 里的消息真正送到对面（飞书回一条、GitHub 回一条评论）。
 *
 * **之前缺的正是这一半**：`StoreNotifier` 只把行取出来放进「最近动态」那个内存窗口，
 * 界面看得见、对面收不到——飞书群里 @ 一次，机器人从此不说话。这个文件补上发送。
 *
 * 三条规则，每条都对应一种「不做就会出错」的情况：
 *
 * 1. **发失败要按原 id 重新入队**。`drainOutbox` 取出即删（`store.ts:449-454` 的注释写明
 *    「发失败的消息由发送方自己重新入队」），所以每拍取出的行要么发成功、要么写回队列。
 *    id 就是幂等键（飞书的 `--idempotency-key`、GitHub 评论里的 HTML 标记都用它），
 *    因此重投不会把同一句话说两遍。
 * 2. **退避状态只在内存**。失败次数与「下次可发时刻」不落库：进程重启后所有待发消息立刻
 *    重试一次。这是至少一次投递的代价，换来的是「重启不丢消息」——反过来把「已试几次」
 *    写进库，就得为它加一张表和一次迁移，而重启时那一格的价值几乎为零。
 * 3. **`manual` 通道只进最近动态**。那是 P0 的通知占位（`notify.ts` 的 `NOTICE_CHANNEL`、
 *    `runtime.ts:90` 的 `RECOVERY_CHANNEL`），没有可以回话的会话；而来源没起来（飞书没配、
 *    GitHub 没令牌）是另一回事：那种情况按退避等，不立刻丢。
 *
 * @module dsc/packages/superagent/adapters/dispatch
 */
import type { OutboundMessage } from '../core/ports.js'
import type { RecentNotice } from './notify.js'
import { MANUAL_SOURCE } from './settings.js'
import type { DscStore, OutboxItem } from './store.js'

/** 一拍最多取多少行。50 与 `drainOutbox` 的默认批量一致；取不完的下一拍继续。 */
const BATCH = 50

/** 同一条消息最多试几次（含第一次）。到顶就丢弃并记一行：留一条永远发不出去的行没有意义。 */
export const MAX_ATTEMPTS = 5

/** 第一次失败的退避间隔；之后每次翻倍。 */
export const BASE_DELAY_MS = 5000

/** 退避上限；两分钟以上再重试，对面的问题多半不会自己好，但也不该永久放弃。 */
export const MAX_DELAY_MS = 300_000

/** 记住多少个「已经进过最近动态」的 id：只为一个目的——重投的消息不要在窗口里出现两遍。 */
const SHOWN_CAP = 500

/**
 * 一个发送方：发出去，或者告诉调用方「这个会话永远收不到了」。
 *
 * 只有两种正常结果，对应两个适配器的 `'sent' | 'gone'`：`'gone'` 是永久失败（消息被撤回、
 * 会话被删、Issue 被锁），重试一万次也一样。其余错误照抛，由这里按可重试处理。
 */
export type MessageSender = (message: OutboundMessage) => Promise<'sent' | 'gone'>

/** 把未知异常压成一行。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从一行 `outbox` 里读出消息；不是我们能发的行（没有 `payload.message`）给 `undefined`。 */
function messageOf(row: OutboxItem): OutboundMessage | undefined {
  const payload = row.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const message = (payload as Record<string, unknown>).message
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined
  const cast = message as Partial<OutboundMessage>
  if (typeof cast.id !== 'string' || cast.id === '' || typeof cast.text !== 'string') return undefined
  const channel = cast.channel
  if (channel === null || typeof channel !== 'object' || typeof channel.source !== 'string') return undefined
  return cast as OutboundMessage
}

/** 入队时刻：我们自己写的行有 `payload.at`，别家的没有，用当前时刻顶上。 */function atOf(row: OutboxItem): string | undefined {
  const payload = row.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const at = (payload as Record<string, unknown>).at
  return typeof at === 'string' && at !== '' ? at : undefined
}

/**
 * 一行的 `value` 能不能解析成一个对象。
 *
 * 判据与 `store.ts` 的 `decodeOutboxItem` 一致：那边碰到同样的形状会抛 `outbox_corrupt`。
 */
function readable(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/** 第 `count` 次失败之后等多久：5 秒、10 秒、20 秒、40 秒，封顶 5 分钟。 */
export function backoffMs(count: number): number {
  const delay = BASE_DELAY_MS * 2 ** Math.max(0, count - 1)
  return Math.min(delay, MAX_DELAY_MS)
}

/** 发送泵要的四件东西。 */
export interface DispatchOptions {
  /** 编排库；出站队列在它里面 */
  store: DscStore
  /**
   * 按 `channel.source` 找发送方。
   *
   * 是 getter 而不是一张表：两个来源都在运行期之后才建好（`index.ts` 的
   * `startGithub` / `startFeishu`），构造时算死就会变成「来源起来之前排队的回复永远发不出去」。
   */
  senders: () => Partial<Record<string, MessageSender>>
  /** 进「最近动态」；接 `StoreNotifier.remember`。 */
  remember(fresh: readonly RecentNotice[]): void
  /** 时钟；退避与窗口里的时刻都用它，测试注入固定值。 */
  now: () => string
  log?(line: string): void
}

/**
 * 出站发送泵。
 *
 * 一拍做一件事：取出一批 → 逐条发 → 失败的原样写回队列。没有定时器，由
 * `runtime.pump()` 每 2 秒叫一次（与两个来源轮询同一条节奏）。
 */
export class OutboxDispatcher {
  private readonly options: DispatchOptions
  /** 「上一拍还没回来」：发送是网络活，慢了会比 2 秒的泵长，不设这道闸就会把同一行发两遍。 */
  private busy = false
  /** 失败次数与下次可发时刻，只在内存里。 */
  private readonly attempts = new Map<string, { count: number; nextAt: number }>()
  /** 已经进过最近动态的消息 id；重投的同一条不再重复显示。 */
  private readonly shown = new Set<string>()

  constructor(options: DispatchOptions) {
    this.options = options
  }

  /**
   * 发一轮。
   *
   * 只取一轮、不循环：写回队列的失败行如果在这一拍里又被取出来，会撞上退避未到点，
   * 于是「取出 → 写回」空转不停。留给下一拍处理，代价是最多晚 2 秒。
   *
   * 不抛：取队列本身失败（比如某行 JSON 坏了，`store.ts` 的 `decodeOutboxItem` 会抛）
   * 只记一行，下一拍照旧跑。
   */
  async flush(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.round()
    } finally {
      this.busy = false
    }
  }

  private async round(): Promise<void> {
    const rows = this.take()
    if (rows.length === 0) return
    const fresh: RecentNotice[] = []
    const again: OutboxItem[] = []
    for (const row of rows) {
      const message = messageOf(row)
      // 不是我们写的行（别家往同一张表里放的）：读不出消息就只删，不猜。
      if (message === undefined) continue
      if (!this.shown.has(message.id)) {
        this.shown.add(message.id)
        if (this.shown.size > SHOWN_CAP) {
          const oldest = this.shown.values().next().value
          if (oldest !== undefined) this.shown.delete(oldest)
        }
        if (message.text !== '') fresh.push({ at: atOf(row) ?? this.options.now(), text: message.text })
      }
      // `manual` 是「没有真实会话」的占位：只显示，不发送，也不留行。
      if (message.channel.source === MANUAL_SOURCE) {
        this.attempts.delete(message.id)
        continue
      }
      // 退避没到点就放回队列，不试、也不计一次失败。
      if (!this.due(message.id)) {
        again.push(row)
        continue
      }
      const sender = this.options.senders()[message.channel.source]
      if (sender === undefined) {
        if (this.defer(message.id, `来源 ${message.channel.source} 还没起来`)) again.push(row)
        continue
      }
      try {
        const outcome = await sender(message)
        this.attempts.delete(message.id)
        if (outcome === 'gone') this.options.log?.(`出站消息 ${message.id} 永久发不出（会话已不可用），已丢弃`)
      } catch (error) {
        if (this.defer(message.id, `发送失败：${errorText(error)}`)) again.push(row)
      }
    }
    for (const row of again) this.requeue(row)
    if (fresh.length > 0) this.options.remember(fresh)
  }

  /**
   * 取一批。读不出来时自救一次再试：`store.ts` 的 `decodeOutboxItem` 遇到坏行会抛，而
   * `drainOutbox` 把「取出 + 删除」放在一个事务里——一行坏数据就会让整批回滚，症状是
   * 「所有回复都发不出去，日志里每 2 秒一条取出站消息失败」。
   */
  private take(): OutboxItem[] {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return this.options.store.drainOutbox(BATCH)
      } catch (error) {
        this.options.log?.(`取出站消息失败：${errorText(error)}`)
        if (!this.salvage()) return []
      }
    }
    return []
  }

  /**
   * 把读不出来的行删掉。
   *
   * 只删**确认解析不了**的（不是 JSON、或不是对象）：能解析的留给下一轮正常发送，
   * 不因为邻居坏就一起丢。用库自己的那条连接（`store.handle`）而不是新开一条，
   * 与 `outbox.ts` 的理由相同：第二个 WAL 写者会让两条连接的事务互不可见。
   *
   * @returns 删掉过东西没有；没有说明这次失败不是坏行引起的，别重试了
   */
  private salvage(): boolean {
    const db = this.options.store.handle
    const rows = db.prepare('SELECT rowid AS row, value FROM outbox').all()
    const remove = db.prepare('DELETE FROM outbox WHERE rowid = ?')
    let dropped = 0
    for (const row of rows) {
      if (readable(row.value)) continue
      remove.run(typeof row.row === 'number' ? row.row : Number(row.row))
      dropped += 1
    }
    if (dropped === 0) return false
    this.options.log?.(`出站队列删掉 ${String(dropped)} 行读不出来的数据`)
    return true
  }

  /** 这条现在能不能发：从没失败过，或者退避到点了。 */
  private due(id: string): boolean {
    const entry = this.attempts.get(id)
    if (entry === undefined) return true
    const now = Date.parse(this.options.now())
    return !Number.isFinite(now) || now >= entry.nextAt
  }

  /**
   * 记一次失败，必要时安排退避。
   *
   * 两种失败共用这一条路：发送方存在但发送抛了、以及来源压根还没起来。区别只在日志里的
   * `why`——对调用方来说都是「这一行现在发不出去」，要的都只是一次退避重试。
   *
   * @returns 还值得再试一次吗；到 {@link MAX_ATTEMPTS} 就是 `false`，这一行丢弃
   */
  private defer(id: string, why: string): boolean {
    const count = (this.attempts.get(id)?.count ?? 0) + 1
    if (count >= MAX_ATTEMPTS) {
      this.attempts.delete(id)
      this.options.log?.(`出站消息 ${id} 放弃投递：${why}（已试 ${String(count)} 次）`)
      return false
    }
    const now = Date.parse(this.options.now())
    this.attempts.set(id, { count, nextAt: Number.isFinite(now) ? now + backoffMs(count) : 0 })
    this.options.log?.(`出站消息 ${id} 稍后重试：${why}（第 ${String(count)} 次，${String(Math.round(backoffMs(count) / 1000))} 秒后）`)
    return true
  }

  /** 写回队列：同 id、同 kind、同 payload，幂等键不变，重投不会重复。 */
  private requeue(row: OutboxItem): void {
    try {
      this.options.store.enqueueOutbox({ id: row.id, kind: row.kind, payload: row.payload })
    } catch (error) {
      this.options.log?.(`出站消息 ${row.id} 写回队列失败：${errorText(error)}`)
    }
  }
}
