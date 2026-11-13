/**
 * 出站发送：把 `outbox` 里的消息真正送到对面（飞书回一条、GitHub 回一条评论）。
 *
 * **之前缺的正是这一半**：`StoreNotifier` 只把行取出来放进「最近动态」那个内存窗口，
 * 界面看得见、对面收不到——飞书群里 @ 一次，机器人从此不说话。这个文件补上发送。
 *
 * 三条规则，每条都对应一种「不做就会出错」的情况：
 *
 * 1. **认领之后必须收尾**。`claimOutbox` 把行标成 `sending` 交出来，行还在库里；
 *    发成功要 `finishOutbox` 删掉，这一拍没发出去要 `requeueOutbox` 退回 `pending`。
 *    少做后半截，那条消息就永远停在 `sending`，除了重启没人再取它。
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

/** 一拍最多取多少行。50 与 `claimOutbox` 的默认批量一致；取不完的下一拍继续。 */
const BATCH = 50

/**
 * 同一条消息最多试几次（含第一次）。
 *
 * 八次配下面那条退避算下来是「5 + 10 + 20 + 40 + 80 + 160 + 300 ≈ 10 分钟」：GitHub 或飞书
 * 抖几分钟能自己好，抖一小时的（令牌过期、应用被停用）靠重试也救不回来，丢了并记日志更诚实。
 */
export const MAX_ATTEMPTS = 8

/** 第一次失败的退避间隔；之后每次翻倍。 */
export const BASE_DELAY_MS = 5000

/** 退避上限；两次五分钟之后还不行，就是「不是抖一下」的问题了。 */
export const MAX_DELAY_MS = 300_000

/** 放回队列失败时最多留多少条在内存里等下一拍再试：一批 50 条，留 500 够十批。 */
const KEPT_CAP = 500

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
 * 一行的 `value` 能不能被 `store.ts` 的 `decodeOutboxItem` 读成一条。
 *
 * 四道判据与那边逐条对齐（`store.ts:248-263`）：是字符串、是 JSON、是对象、`id` 与 `kind`
 * 都是非空字符串。少判最后一道就会漏掉「能解析但缺 id/kind」的行——那种行让 `claimOutbox`
 * 每次都抛，自救却认为它没问题，于是整批出站消息永久发不出去。
 */
function readable(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const value = parsed as Record<string, unknown>
  return typeof value.id === 'string' && value.id !== '' && typeof value.kind === 'string' && value.kind !== ''
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
 * 一拍做一件事：认领一批 → 逐条发 → 发完删行、没发的放回队列。没有定时器，由
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
  /** 放回队列失败、库里停在 `sending` 的行；下一拍最前面先处理它们。 */
  private readonly kept: OutboxItem[] = []

  constructor(options: DispatchOptions) {
    this.options = options
  }

  /**
   * 发一轮。
   *
   * 只取一轮、不循环：放回队列的失败行如果在这一拍里又被取出来，会撞上退避未到点，
   * 于是「取出 → 放回」空转不停。留给下一拍处理，代价是最多晚 2 秒。
   *
   * 不抛：取队列本身失败（比如某行 JSON 坏了，`store.ts` 的 `decodeOutboxItem` 会抛）
   * 只记一行，下一拍照旧跑。
   */
  async flush(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.round()
    } catch (error) {
      // 走到这里的只有没被单独兜住的那几步（放回队列、记窗口；库被关掉是最常见的一种）。
      // 一条消息出事不该让下一拍不跑，所以这里必须吞掉——「不抛」是 `flush` 的契约，
      // 调用方（`runtime.flushOutbox`）那一层 catch 只是兜底，不该是常态。
      this.options.log?.(`出站发送这一拍失败：${errorText(error)}`)
    } finally {
      this.busy = false
    }
  }

  private async round(): Promise<void> {
    // 上一拍放回队列失败的那几条排在最前面：它们在库里还停在 sending（下一次开库才会被放回），
    // 「放回队列」这一步没成功之前，同一进程里只有内存这一份能继续试。
    const rows = [...this.kept.splice(0), ...this.take()]
    if (rows.length === 0) return
    const fresh: RecentNotice[] = []
    const again: OutboxItem[] = []
    for (const row of rows) {
      const message = messageOf(row)
      // 不是我们写的行（别家往同一张表里放的）：读不出消息就只删，不猜。
      if (message === undefined) {
        this.finish(row.id)
        continue
      }
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
        this.finish(row.id)
        continue
      }
      // 退避没到点就放回队列，不试、也不计一次失败。
      if (!this.due(message.id)) {
        again.push(row)
        continue
      }
      const sender = this.options.senders()[message.channel.source]
      if (sender === undefined) {
        // 放弃投递（试满八次）也要删行：留在库里会停在 sending，下次启动又被放回队列重发。
        if (this.defer(message.id, `来源 ${message.channel.source} 还没起来`)) again.push(row)
        else this.finish(row.id)
        continue
      }
      try {
        const outcome = await sender(message)
        this.attempts.delete(message.id)
        // 发出去与永久发不出都算有结论：删行。`sending` 只是「在手里」，不是终态。
        this.finish(row.id)
        if (outcome === 'gone') this.options.log?.(`出站消息 ${message.id} 永久发不出（会话已不可用），已丢弃`)
      } catch (error) {
        if (this.defer(message.id, `发送失败：${errorText(error)}`)) again.push(row)
        else this.finish(row.id)
      }
    }
    for (const row of again) this.requeue(row)
    if (fresh.length > 0) this.options.remember(fresh)
  }

  /**
   * 取一批。读不出来时自救一次再试：`store.ts` 的 `decodeOutboxItem` 遇到坏行会抛，而
   * `claimOutbox` 把「选中 + 改状态」放在一个事务里——一行坏数据就会让整批回滚，症状是
   * 「所有回复都发不出去，日志里每 2 秒一条取出站消息失败」。
   */
  private take(): OutboxItem[] {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return this.options.store.claimOutbox(BATCH)
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
   * 只在认领失败之后调用：`claimOutbox` 抛错时那个事务已经回滚，被它选中的行仍是 `pending`，
   * 删掉坏行之后下一次认领就能过。只删**确认解析不了**的（不是 JSON、或不是对象）：
   * 能解析的留给下一轮正常发送，不因为邻居坏就一起丢。用库自己的那条连接
   * （`store.handle`）而不是新开一条，与 `outbox.ts` 的理由相同：第二个 WAL 写者会让
   * 两条连接的事务互不可见。
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

  /** 放回队列：只把状态改回 `pending`，id / kind / payload 一个字节都没动，幂等键不变。 */
  private requeue(row: OutboxItem): void {
    try {
      this.options.store.requeueOutbox(row.id)
    } catch (error) {
      // 状态没改回去，这一行在库里会一直停在 sending（要等下次开库才被放回队列）；
      // 所以在内存里留一份，下一拍照旧能试。不这么做的话，「发失败 + 库写不进去」
      // （磁盘满、库被锁、正在停用）会静默丢消息——日志有痕迹，但没有人会去翻两秒一条的日志。
      if (this.kept.length < KEPT_CAP) this.kept.push(row)
      this.options.log?.(`出站消息 ${row.id} 放回队列失败：${errorText(error)}`)
    }
  }

  /**
   * 这一行有结论了：删掉。
   *
   * 删不掉最坏是「下次开库把它从 sending 放回 pending、再发一遍」，靠幂等键兜住，
   * 所以这里只记一行日志，不往外抛——一条消息收尾失败不该让整拍中断。
   */
  private finish(id: string): void {
    try {
      this.options.store.finishOutbox(id)
    } catch (error) {
      this.options.log?.(`出站消息 ${id} 收尾删行失败：${errorText(error)}`)
    }
  }
}
