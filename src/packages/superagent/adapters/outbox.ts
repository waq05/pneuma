/**
 * P0 的出站队列：落在存储层已有的 `outbox` 表上。
 *
 * 表结构原样是 `(id TEXT PRIMARY KEY, value TEXT NOT NULL)`（`adapters/store.ts` 的
 * `SCHEMA_STATEMENTS`）。`value` 里存 `{ id, kind, payload }`，所以这里**不改表**：
 * 状态写进 `payload.state`，`payload.message` 放原消息。这样第 6 步的发送泵
 * （`drainOutbox`）拿到的一行仍然自解释，P1 加字段也不用迁移。
 *
 * 为什么 `status` / `withdraw` 要直接读同一个连接：`DscStore` 只给了
 * `enqueueOutbox` / `drainOutbox`（取走即删），没有「查一条」「删一条」的窄 API。
 * 要做到幂等（同 id 不重复入队）与撤回（只删未发的），就必须按 id 读一次、删一次。
 * 这里不新建连接（那会冒出第二个 WAL 写者），而是复用 `DscStore.handle`；
 * 写的仍然只是 `outbox` 一行，表结构一个字节没动。
 *
 * `sent` / `dropped` 只在内存里记：`drainOutbox` 取走一行就删行，库里没有「已发」
 * 这个事实可查。P0 的 outbox 只由核心写、没有发送泵在跑（第 6 步才接），所以
 * 「重启后忘了哪些已发」目前没有后果；真接上发送泵时，已发状态应由效果表
 * （`effect`）记，不在这里补。
 *
 * @module dsc/packages/superagent/adapters/outbox
 */
import type { DatabaseSync } from 'node:sqlite'
import type { OutboundMessage, Outbox, ReplyStatus } from '../core/ports.js'
import type { DscStore } from './store.js'

/** 本类写在 `value.payload.state` 上的键。 */
const STATE_KEY = 'state'

/** 一行 `outbox` 里我们关心的部分。 */
interface StoredState { state?: ReplyStatus }

/**
 * 按 id 找一行出站消息，返回 `value` 解析后的对象；没有或坏行返回 `undefined`。
 *
 * 坏行不抛：这个类只负责队列，读不出状态就当「还没发」，让消息留在库里由发送方
 * 处理；`drainOutbox` 读它时会按 `outbox_corrupt` 报错，那里才是该吵的地方。
 */
function decodeRow(db: DatabaseSync, id: string): StoredState | undefined {
  const row = db.prepare('SELECT value FROM outbox WHERE id = ?').get(id)
  if (row === undefined || typeof row.value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(row.value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const payload = (parsed as Record<string, unknown>).payload
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return {}
    const state = (payload as Record<string, unknown>)[STATE_KEY]
    if (state === 'pending' || state === 'sent' || state === 'dropped') return { state }
    return {}
  } catch {
    return undefined
  }
}

/**
 * `Outbox` 端口的 SQLite 实现。
 *
 * `send` 幂等：同 id 的第二次调用在 `status` 里已经能看到一条记录，直接返回，
 * 不重复入队；核心自己也会用内容哈希做 id（`core/replies.ts:44`），两处一起
 * 保证「一句话只催一次」。
 */
export class StoreOutbox implements Outbox {
  private readonly store: DscStore
  private readonly db: DatabaseSync
  /** 已在内存里确认过的状态；`sent` / `dropped` 只能从这里读到（行已被删）。 */
  private readonly known = new Map<string, ReplyStatus>()

  constructor(store: DscStore, db: DatabaseSync = store.handle) {
    this.store = store
    this.db = db
  }

  send(message: OutboundMessage): void {
    // 先看已知状态：pending 不必再写一次，sent / dropped 更不能再写（撤回与幂等都要它）。
    if (this.status(message.id) !== undefined) return
    this.store.enqueueOutbox({ id: message.id, kind: message.kind, payload: { message, [STATE_KEY]: 'pending' } })
    this.known.set(message.id, 'pending')
  }

  status(id: string): ReplyStatus | undefined {
    const remembered = this.known.get(id)
    if (remembered === 'sent' || remembered === 'dropped') return remembered
    const row = decodeRow(this.db, id)
    if (row === undefined) {
      // 行不在了，但内存记着它入过队：说明发送泵已经把它取走（`drainOutbox` 取走即删）。
      if (remembered === 'pending') {
        this.known.set(id, 'sent')
        return 'sent'
      }
      return undefined
    }
    const state = row.state ?? 'pending'
    this.known.set(id, state)
    return state
  }

  withdraw(id: string): void {
    const current = this.status(id)
    // 「未发送」才撤得回来；已发、已撤回、从没入过队的都不动。
    if (current !== 'pending') return
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id)
    this.known.set(id, 'dropped')
  }
}
