/**
 * dsh 服务桥（第一版，**只读**）：把 Pneuma 的会话历史与用量日志，按 dsh 的
 * `sessions` / `sessionPersistence` 的形状露给外部插件。
 *
 * 为什么要有它：`dsh-cost-meter` 这类插件在运行时 `ctx.get('sessionPersistence')` 现取，
 * 取到 `undefined` 就静默少一段功能——「装得上」与「用得了」是两件事。判定表
 * （`service-map.ts`）早就把这两个名字标成 `adapted`：有对应物、形状不同、必须写适配器。
 *
 * ## 边界（重要）
 *
 * 只实现**读**。dsh 的 `create` / `append` 要求「写所有权」与 seq 单调，而 Pneuma 的会话
 * 由内核的回合循环独占写入；给插件开写口等于两套写者改同一份会话记录，坏的是用户的历史。
 * 所以写方法一律抛一条中文错误，**不做静默 no-op**——静默会让插件以为写成功了。
 *
 * ## 字段口径
 *
 * 形状照 dsh 的声明抄（`SessionPersistenceSnapshot` / `SessionPersistenceListOptions` /
 * `SessionPageRequest`，以及内部调用点上出现的 `create` / `open` / `stat` / `list`）。
 * **没有逐字段核对过 dsh 的运行时**，所以刻意只给最小面：多给一个字段就多一个猜错的机会。
 * 真包验收（见 docs/dsh-service-bridge-plan.md 第三步）之后再来收紧。
 *
 * 事件流怎么来：
 *   - 会话 jsonl 的一行 = 一个事件，行号（1 起）当 `seq`；
 *   - 每次模型调用的 token 用量在 `~/.dsc/usage/usage.jsonl`（不在会话日志里），
 *     按 `sid` 归到会话上，类型标成 `llm/usage`——算账要的就是这一种事件。
 *
 * @module dsc/core/dsh-compat/session-bridge
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { listSessions } from '../session.js'
import type { UsageRecord } from '../usage-log.js'
import { usageLogFile } from '../usage-log.js'

/** dsh 的事件最简形：类型 + seq + 载荷。字段少了有插件读不到，多了我们也猜不准。 */
export interface BridgeEvent {
  readonly seq: number
  readonly type: string
  /** 原始行（会话 jsonl 的那一条，或合成的用量记录）。 */
  readonly data: Record<string, unknown>
}

/** `stat()` 的返回（照 dsh 的 `SessionPersistenceSnapshot` 取最小集）。 */
export interface BridgeSnapshot {
  readonly header: { readonly sessionId: string; readonly cwd?: string; readonly createdAt?: number }
  readonly formatStatus: 'current'
  readonly revision: string
  readonly eventCount: number
  readonly sizeBytes: number
}

/** 一页事件（照 `SessionPageRequest` 的两个游标取最小集）。 */
export interface BridgePage {
  readonly events: readonly BridgeEvent[]
  /** 这一页之后还有没有更多事件。 */
  readonly hasMore: boolean
}

/** 只读句柄：dsh 的 `open(id, 'read')` 拿到的那个东西。 */
export interface BridgeHandle {
  readonly sessionId: string
  read(range?: { readonly throughSeq?: number; readonly beforeSeq?: number; readonly maxMessages?: number }): BridgePage
  close(): void
}

/** `sessionPersistence` 的只读面。 */
export interface SessionPersistenceBridge {
  list(options?: { readonly signal?: AbortSignal }): readonly BridgeSnapshot[]
  stat(sessionId: string, options?: { readonly signal?: AbortSignal }): BridgeSnapshot | undefined
  open(sessionId: string, mode?: 'read' | 'write', options?: { readonly signal?: AbortSignal }): BridgeHandle
  create(): never
  append(): never
}

/** `sessions` 的只读面（dsh 的多会话注册表，Pneuma 只有当前工作区这一份）。 */
export interface SessionsBridge {
  list(): readonly { sessionId: string; cwd?: string; createdAt?: number; title?: string; live: boolean; persisted: boolean }[]
  get(sessionId: string): { sessionId: string; cwd?: string; createdAt?: number; title?: string; live: boolean; persisted: boolean } | undefined
  has(sessionId: string): boolean
}

/** 写侧的唯一一句话：为什么不行、怎么办。 */
const WRITE_REFUSAL =
  'dsh 的会话写句柄在 Pneuma 里不可用：会话由内核的回合循环独占写入，第二套写者会改坏用户的会话记录。' +
  '只读接口（list / stat / open(…, "read")）可以照常用。'

/** 读一份文件的全部行；坏行跳过（与宿主读会话的口径一致）。 */
function linesOf(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/)
  } catch {
    return []
  }
}

/**
 * 用量日志按会话归档（只读请求行；工具行没有 token，算账用不上）。
 *
 * 结果按文件的 mtime+size 缓存：一份用了几周的 usage.jsonl 能有几万行，而插件会按秒
 * 轮询 `stat()`——每次都整文件重解析是白烧 CPU。追加一行就会改 mtime，所以缓存不会旧。
 */
let usageCache: { stamp: string; rows: Map<string, UsageRecord[]> } | null = null

function usageBySession(): Map<string, UsageRecord[]> {
  const file = usageLogFile()
  const stamp = (() => {
    try {
      const info = statSync(file)
      return `${String(info.mtimeMs)}:${String(info.size)}`
    } catch {
      return ''
    }
  })()
  if (stamp !== '' && usageCache !== null && usageCache.stamp === stamp) return usageCache.rows
  const out = new Map<string, UsageRecord[]>()
  if (!existsSync(file)) {
    usageCache = { stamp: '', rows: out }
    return out
  }
  for (const line of linesOf(file)) {
    if (line.trim() === '') continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row === null || typeof row !== 'object') continue
    const record = row as Partial<UsageRecord> & { k?: unknown }
    if (record.k !== undefined) continue // 工具行
    if (typeof record.sid !== 'string' || typeof record.i !== 'number' || typeof record.o !== 'number') continue
    if (typeof record.t !== 'number') continue
    const list = out.get(record.sid) ?? []
    list.push(record as UsageRecord)
    out.set(record.sid, list)
  }
  usageCache = { stamp, rows: out }
  return out
}

/**
 * 一个会话的全部事件：先 jsonl 的逐行事件，再按时间把用量事件并进去。
 *
 * 合并方式：两边都按时间戳排序后归并（会话行用 `ts`，缺 `ts` 的老行排在最前）。
 * seq 是事件在**这个视图里**的位置（1 起），不是文件行号——因为并进来之后行号会错位，
 * 而 dsh 的游标语义是「事件序号」，不是「文件行」。
 */
function eventsOf(path: string, usage: readonly UsageRecord[]): BridgeEvent[] {
  const rows: { at: number; type: string; data: Record<string, unknown> }[] = []
  let fallbackAt = 0
  for (const line of linesOf(path)) {
    if (line.trim() === '') continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const at = typeof row['ts'] === 'number' ? row['ts'] : fallbackAt
    fallbackAt += 1
    rows.push({ at, type: typeof row['type'] === 'string' ? row['type'] : 'unknown', data: row })
  }
  for (const record of usage) {
    rows.push({
      at: record.t,
      type: 'llm/usage',
      data: {
        provider: record.provider,
        model: record.model,
        inputTokens: record.i,
        outputTokens: record.o,
        cacheReadTokens: record.ch ?? 0,
        cacheWriteTokens: record.cm ?? 0,
        at: record.t,
      },
    })
  }
  return rows
    .sort((a, b) => a.at - b.at)
    .map((row, index) => ({ seq: index + 1, type: row.type, data: row.data }))
}

/** 一个会话文件的快照（stat 与句柄共用，免得两处口径不一）。 */
function snapshotOf(item: ReturnType<typeof listSessions>[number], eventCount: number, sizeBytes: number): BridgeSnapshot {
  return {
    header: { sessionId: item.id, cwd: item.cwd, createdAt: item.createdAt },
    formatStatus: 'current',
    // revision 用「事件数 + 字节数」：够插件判断「读到的这一份有没有变」，不假装是内容哈希。
    revision: `${String(eventCount)}:${String(sizeBytes)}`,
    eventCount,
    sizeBytes,
  }
}

/**
 * 会话清单的短时缓存：
 *
 * 为什么要有：`list()` 要给每个会话读一遍 jsonl 才能数事件，几十个会话就是几十次读盘；
 * 而插件（费用条这类）会按秒轮询。2 秒的窗口够挡住「同一帧里问三遍」，又不会让新会话
 * 看不见。缓存里存的是**读盘结果**，不是授权——过期就重读。
 */
const LIST_TTL_MS = 2_000
let listCache: { at: number; rows: BridgeSnapshot[] } | null = null

/** 造一个只读的 `sessionPersistence`。 */
export function createSessionPersistenceBridge(): SessionPersistenceBridge {
  const handleOf = (sessionId: string): BridgeHandle => {
    const item = listSessions().find((candidate) => candidate.id === sessionId)
    if (item === undefined) throw new Error(`没有这个会话：${sessionId}`)
    const events = eventsOf(item.path, usageBySession().get(sessionId) ?? [])
    return {
      sessionId,
      read(range) {
        const through = range?.throughSeq
        const before = range?.beforeSeq
        const max = range?.maxMessages
        let slice = events
        if (through !== undefined) slice = slice.filter((event) => event.seq <= through)
        if (before !== undefined) slice = slice.filter((event) => event.seq < before)
        const limited = max === undefined ? slice : slice.slice(0, Math.max(0, max))
        return { events: limited, hasMore: limited.length < slice.length }
      },
      close() {
        /* 只读句柄没有要释放的东西；留着只为对上 dsh 的接口形状。 */
      },
    }
  }

  return {
    list() {
      if (listCache !== null && Date.now() - listCache.at < LIST_TTL_MS) return listCache.rows
      const usage = usageBySession()
      const rows = listSessions().map((item) => {
        const events = eventsOf(item.path, usage.get(item.id) ?? [])
        return snapshotOf(item, events.length, existsSync(item.path) ? statSync(item.path).size : 0)
      })
      listCache = { at: Date.now(), rows }
      return rows
    },
    stat(sessionId) {
      const item = listSessions().find((candidate) => candidate.id === sessionId)
      if (item === undefined) return undefined
      const events = eventsOf(item.path, usageBySession().get(sessionId) ?? [])
      return snapshotOf(item, events.length, existsSync(item.path) ? statSync(item.path).size : 0)
    },
    open(sessionId, mode = 'read') {
      if (mode !== 'read') throw new Error(WRITE_REFUSAL)
      return handleOf(sessionId)
    },
    create() {
      throw new Error(WRITE_REFUSAL)
    },
    append() {
      throw new Error(WRITE_REFUSAL)
    },
  }
}

/** 造一个只读的 `sessions`。 */
export function createSessionsBridge(): SessionsBridge {
  const rows = (): ReturnType<SessionsBridge['list']> =>
    listSessions().map((item) => ({
      sessionId: item.id,
      cwd: item.cwd,
      createdAt: item.createdAt,
      ...(item.title === undefined ? {} : { title: item.title }),
      // live：pinned 不表示活着；这里没有「正在跑」的判据，一律 false，别假装知道。
      live: false,
      persisted: true,
    }))
  return {
    list: rows,
    get(sessionId) {
      return rows().find((row) => row.sessionId === sessionId)
    },
    has(sessionId) {
      return rows().some((row) => row.sessionId === sessionId)
    },
  }
}

/**
 * 按名字取一个桥（compat 的 `ctx.get` 兜底用）。
 * @param name - 服务名
 * @returns 桥；不归这座桥管的服务给 undefined（交给上层继续判缺）
 */
export function compatServiceOf(name: string): unknown {
  if (name === 'sessionPersistence') return createSessionPersistenceBridge()
  if (name === 'sessions') return createSessionsBridge()
  return undefined
}
