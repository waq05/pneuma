/**
 * superagent 的只读查询面：列表、详情、事件时间线、状态计数靠它。
 *
 * 为什么单开一个文件与一种连接：写库的只有编排器一个进程，读它的是界面、命令、体检
 * 这些会同时发起很多次的一方。只读连接（`readOnly: true`）在 WAL 下不挡写，也不会因为
 * 某次误写把编排状态改坏——「读」的边界交给 SQLite 自己守，不靠调用方自觉。
 *
 * 这个模块不建表、不迁移、不开写事务：库还没建出来就直接报 `store_missing`，
 * 让调用方去等编排器。少一条隐式建库路径，就少一次「界面先起来把库建成了半成品」。
 *
 * @module dsc/packages/superagent/adapters/store-read
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { clampInt } from '@pneuma/runtime/core/clamp.js'
import { orchestratorDbPath } from '../paths.js'
import { decodeTicketValue, StoreError, type TicketRecord } from './store.js'

/** 单次列表的条数上限：界面一屏几十行，给再多也没人看，还会把 IPC 撑大。 */
const MAX_LIST_LIMIT = 500

/** 缺省条数。 */
const DEFAULT_LIST_LIMIT = 50

/** 事件一行。`payload` 是写入方给的任意 JSON。 */
export interface EventRecord {
  /** 工单内的序号，从 1 起连续递增；`listEvents` 的 `sinceSeq` 就吃它。 */
  seq: number
  kind: string
  payload: unknown
  at: string
}

/** 工单列表的过滤条件。P0 只有状态与分页，别的条件等真有查询再长。 */
export interface TicketFilter {
  /** 只要这一种状态；不传 = 全部。 */
  state?: string
  /** 条数，默认 50，最多 500。 */
  limit?: number
  /** 跳过前 N 条，默认 0。 */
  offset?: number
}

/** 打开只读连接。库不存在报 `store_missing`，不替写方建库。 */
export function openStoreRead(path: string = orchestratorDbPath()): StoreRead {
  if (!existsSync(path)) {
    throw new StoreError('store_missing', `还没有编排库：${path}（等编排器第一次启动后再读）`)
  }
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')
    return new StoreRead(db)
  } catch (error) {
    try {
      db.close()
    } catch {
      // 关不掉不该盖住打开失败的原因
    }
    throw error
  }
}

/** 只读查询面。构造它只该走 `openStoreRead`。 */
export class StoreRead {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** 工单列表，新的在前（按插入顺序倒序：没给排序字段时这是唯一稳定的顺序）。 */
  listTickets(filter: TicketFilter = {}): TicketRecord[] {
    const limit = clampInt(filter.limit, 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT)
    const offset = clampInt(filter.offset, 0, Number.MAX_SAFE_INTEGER, 0)
    const rows =
      filter.state === undefined
        ? this.db.prepare('SELECT id, value FROM ticket ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset)
        : this.db
            .prepare(`SELECT id, value FROM ticket WHERE ${stateOf('value')} = ? ORDER BY rowid DESC LIMIT ? OFFSET ?`)
            .all(filter.state, limit, offset)
    return rows.map((row) => decodeTicketValue(String(row.id), row.value))
  }

  /** 单张工单；没有就返回 null（「查不到」是正常结果，不是错误）。 */
  getTicket(id: string): TicketRecord | null {
    const row = this.db.prepare('SELECT value FROM ticket WHERE id = ?').get(id)
    return row === undefined ? null : decodeTicketValue(id, row.value)
  }

  /** 按 seq 升序读事件；`sinceSeq` 之后（不含）的才要，默认从头读。 */
  listEvents(ticketId: string, sinceSeq = 0): EventRecord[] {
    if (!Number.isInteger(sinceSeq) || sinceSeq < 0) {
      throw new StoreError('event_invalid', `sinceSeq 必须是非负整数：${String(sinceSeq)}`)
    }
    const rows = this.db
      .prepare('SELECT seq, kind, payload, at FROM event WHERE ticket = ? AND seq > ? ORDER BY seq')
      .all(ticketId, sinceSeq)
    return rows.map((row) => ({
      seq: typeof row.seq === 'number' ? row.seq : Number(row.seq),
      kind: typeof row.kind === 'string' ? row.kind : '',
      payload: decodePayload(row.payload),
      at: typeof row.at === 'string' ? row.at : '',
    }))
  }

  /** 每个状态各几张工单。`value` 坏掉的行归到 `unknown`，不让一次手改毁掉整个面板。 */
  countByState(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT ${stateOf('value')} AS state, COUNT(*) AS n FROM ticket GROUP BY state`)
      .all()
    const out: Record<string, number> = {}
    for (const row of rows) {
      const key = typeof row.state === 'string' && row.state !== '' ? row.state : 'unknown'
      const count = typeof row.n === 'number' ? row.n : Number(row.n)
      out[key] = (out[key] ?? 0) + count
    }
    return out
  }

  /** 关连接；重复调是空操作。 */
  close(): void {
    try {
      if (this.db.isOpen) this.db.close()
    } catch {
      // 只读连接关闭失败没有后果，别让它盖住调用方的正常收尾
    }
  }
}

/**
 * 状态表达式：状态存在 `value` 的 JSON 里（原文的取舍：表结构稳定，加字段不迁移）。
 *
 * 必须套 `json_valid`：`value` 是用户能手改的一列，`json_extract` 碰到坏 JSON 会直接抛
 * `malformed JSON`，那样连「列表能打开」都保不住。坏行按空状态处理，由调用方归到 unknown。
 */
function stateOf(column: string): string {
  return `(CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.state') ELSE '' END)`
}

/**
 * 事件 payload 的解码：认得出就还原成对象，认不出就把原文交回去。
 * 这里刻意不像 outbox 那样抛错——读事件流是为了看历史，一条坏记录不该让整段历史打不开。
 */
function decodePayload(raw: unknown): unknown {
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
