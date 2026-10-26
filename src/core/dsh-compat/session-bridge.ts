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
 *   - 会话 jsonl 的一行 = 一个事件，**翻译成 dsh 的事件类型**（`user/message` /
 *     `assistant/message` / `tool/result`），并把正文包成 dsh 的消息形状
 *     （`{ id, role, content: 内容块[], source }`）。为什么不原样丢行：插件是按
 *     dsh 的类型认的——`dsh-cost-meter` 的 backfill / context-costs / trajectory
 *     只认 `assistant/message`，拿 `assistant` 行去喂它等于没喂。
 *   - 每次模型调用的 token 用量在 `~/.dsc/usage/usage.jsonl`（不在会话日志里），
 *     按 `sid` 归到会话上：**并进它前面最近的那条 assistant/message**（dsh 的用量就
 *     挂在助手消息上，不单独成事件）。前面没有助手消息可挂时，才落一条
 *     `llm/usage` 扩展事件（带 `ignorable`，不认识的插件可以跳过）。
 *   - `seq` 是事件在这个视图里的位置（1 起）；`time` 是行上的 `ts`（毫秒）。
 *
 * @module dsc/core/dsh-compat/session-bridge
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { listSessions } from '../session.js'
import type { UsageRecord } from '../usage-log.js'
import { usageLogFile } from '../usage-log.js'
import { toDshUsage } from './llm-usage-event.js'

/** dsh 的事件最简形：类型 + seq + 时间 + 载荷。字段少了有插件读不到，多了我们也猜不准。 */
export interface BridgeEvent {
  readonly seq: number
  readonly type: string
  /** Unix 毫秒。dsh 的每条事件都带，按时间排序/算耗时的插件要用。 */
  readonly time: number
  /** dsh 形状的载荷（消息类事件包着 `{ id, role, content, source }`）。 */
  readonly data: Record<string, unknown>
  /**
   * `true` = 不认识的读者可以安全跳过。dsh 用这个标记「纯信息性记录」，
   * 我们只给两种自造事件打：`state`（Pneuma 的会话状态行）与 `llm/usage`（没处挂的用量）。
   */
  readonly ignorable?: true
}

/**
 * `stat()` 的返回（照 dsh 的 `SessionPersistenceSnapshot` 取最小集）。
 *
 * `header.id` 这个字段名是**照着真实消费方核过的**：`dsh-cost-meter` 的
 * `sessionRowOf()` 只认 `header.id`，写 `sessionId` 会被当成「没有这个会话」直接跳过。
 */
export interface BridgeSnapshot {
  readonly header: { readonly id: string; readonly cwd?: string; readonly createdAt?: number }
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

/**
 * 只读句柄：dsh 的 `open(id, 'read')` 拿到的那个东西。
 *
 * 三个成员都是按真实消费方（`dsh-cost-meter` 的 `recordsFromPersistence`）核出来的：
 * 它读 `handle.header` 取会话头、读 `handle.inheritedEventCount` 算继承计数、然后
 * `await handle.read(offset)`——**offset 是一个 seq 数字**，不是我们原先那种对象。
 */
export interface BridgeHandle {
  readonly sessionId: string
  readonly header: { readonly id: string; readonly cwd?: string; readonly createdAt?: number }
  readonly inheritedEventCount: number
  /**
   * 读一页事件。
   * @param range - 起点：数字 = dsh 的 seq 偏移（从这一号开始取）；对象 = 本仓库自用的游标
   */
  read(
    range?: number | { readonly throughSeq?: number; readonly beforeSeq?: number; readonly maxMessages?: number },
  ): BridgePage
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
/** 一条消息的身份：稳定、可复现（同一份日志读两次给同一个 id）。 */
function messageIdOf(sessionId: string, index: number): string {
  return `pneuma-${sessionId}-${String(index)}`
}

/** 内容块：只翻我们真的有的三种。 */
type ContentBlock = Record<string, unknown>

/** 把一行会话记录翻成 dsh 的事件（认不出的行按 `ignorable` 原样透传）。 */
function eventOfRow(row: Record<string, unknown>, sessionId: string, index: number): Omit<BridgeEvent, 'seq' | 'time'> | undefined {
  const type = typeof row['type'] === 'string' ? row['type'] : 'unknown'
  const id = messageIdOf(sessionId, index)
  if (type === 'meta') return undefined
  if (type === 'user') {
    return {
      type: 'user/message',
      data: {
        id,
        role: 'user',
        content: typeof row['text'] === 'string' ? [{ type: 'text', text: row['text'] }] : [],
        source: { kind: 'user' },
      },
    }
  }
  if (type === 'assistant') {
    const content: ContentBlock[] = []
    if (typeof row['text'] === 'string' && row['text'] !== '') content.push({ type: 'text', text: row['text'] })
    if (typeof row['reasoning'] === 'string' && row['reasoning'] !== '') content.push({ type: 'reasoning', text: row['reasoning'] })
    const calls = Array.isArray(row['toolCalls']) ? (row['toolCalls'] as Record<string, unknown>[]) : []
    for (const call of calls) {
      content.push({
        type: 'tool-call',
        id: typeof call['id'] === 'string' ? call['id'] : '',
        name: typeof call['name'] === 'string' ? call['name'] : '',
        arguments: typeof call['arguments'] === 'string' ? call['arguments'] : JSON.stringify(call['arguments'] ?? {}),
      })
    }
    return {
      type: 'assistant/message',
      data: {
        // 历史里没有 dsh 的步骤编号（我们的日志不记），给 0：插件拿它对齐时间线时
        // 得到的是「同一步」而不是一个大得离谱的数。
        turn: 0,
        step: 0,
        message: { id, role: 'assistant', content, source: { kind: 'model', provider: '', model: '' } },
        stream: [],
      },
    }
  }
  if (type === 'tool') {
    const callId = typeof row['callId'] === 'string' ? row['callId'] : ''
    return {
      type: 'tool/result',
      data: {
        turn: 0,
        step: 0,
        message: {
          id,
          role: 'tool',
          content: typeof row['text'] === 'string' ? [{ type: 'text', text: row['text'] }] : [],
          source: { kind: 'tool', callId },
          toolCallId: callId,
        },
      },
    }
  }
  // 剩下的都是 Pneuma 自己的记录（state 之类）：原样给，标 ignorable 让插件放手跳过。
  return { type, data: row, ignorable: true }
}

/**
 * 一个会话的全部事件：jsonl 逐行翻译，再把用量并进助手消息。
 *
 * 合并方式：先按时间戳排序（会话行用 `ts`，缺 `ts` 的老行排在最前），再顺序扫一遍；
 * 每条用量挂到**它前面最近的那条、还没挂过用量的** `assistant/message` 上。
 * 挂不上（前面没有助手消息）才落一条 `llm/usage` 扩展事件，不丢数。
 */
function eventsOf(path: string, usage: readonly UsageRecord[], sessionId: string): BridgeEvent[] {
  const rows: { at: number; event: Omit<BridgeEvent, 'seq' | 'time'> }[] = []
  let fallbackAt = 0
  let index = 0
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
    index += 1
    const event = eventOfRow(row, sessionId, index)
    if (event !== undefined) rows.push({ at, event })
  }
  for (const record of usage) {
    rows.push({
      at: record.t,
      event: {
        type: 'llm/usage',
        ignorable: true,
        data: {
          provider: record.provider,
          model: record.model,
          ...toDshUsage({
            inputTokens: record.i,
            outputTokens: record.o,
            ...(record.ch === undefined ? {} : { cacheHitTokens: record.ch }),
            ...(record.cm === undefined ? {} : { cacheMissTokens: record.cm }),
          }),
          at: record.t,
        },
      },
    })
  }
  const ordered = rows.sort((a, b) => a.at - b.at)
  /** 已经挂进助手消息的那些用量事件（后面从时间线里剔掉，别重复计数）。 */
  const attached = new Set<Omit<BridgeEvent, 'seq' | 'time'>>()
  /** 最近一条还没挂用量的助手消息（按时间往前找，找到就挂）。 */
  let lastAssistant: { data: Record<string, unknown>; hasUsage: boolean } | null = null
  for (const row of ordered) {
    const { event } = row
    if (event.type === 'assistant/message') {
      lastAssistant = { data: event.data, hasUsage: false }
      continue
    }
    if (event.type !== 'llm/usage' || lastAssistant === null || lastAssistant.hasUsage) continue
    // 用量并进助手消息：这就是 dsh 的读法（用量不长在单独的事件上）。
    // 整份搬过去、不再换算一次——那两个数字已经是 dsh 口径，换算两遍会把输入算成 0。
    const { provider, model, at: _at, ...usageOnly } = event.data
    lastAssistant.data['usage'] = usageOnly
    const message = lastAssistant.data['message'] as { source?: Record<string, unknown> } | undefined
    if (message?.source !== undefined) {
      message.source['provider'] = provider
      message.source['model'] = model
    }
    lastAssistant.hasUsage = true
    // 挂上了就把这条独立的用量事件从时间线里拿掉（它已经以 usage 的形式活在消息里）。
    attached.add(event)
  }
  return ordered
    .filter((row) => !attached.has(row.event))
    .map((row, position) => ({ ...row.event, seq: position + 1, time: row.at }))
}

/** 一个会话文件的快照（stat 与句柄共用，免得两处口径不一）。 */
function snapshotOf(item: ReturnType<typeof listSessions>[number], eventCount: number, sizeBytes: number): BridgeSnapshot {
  return {
    header: { id: item.id, cwd: item.cwd, createdAt: item.createdAt },
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
    const events = eventsOf(item.path, usageBySession().get(sessionId) ?? [], sessionId)
    return {
      sessionId,
      header: { id: item.id, cwd: item.cwd, createdAt: item.createdAt },
      // dsh 的「继承事件数」是 fork 时带过来的前缀条数；Pneuma 没有 fork 概念，恒 0。
      inheritedEventCount: 0,
      read(range) {
        // 两种调用形态都要吃：dsh 那条传的是**数字偏移**（从这一号 seq 开始取），
        // 本仓库的探针传对象（three cursors）。分成两条路各自都好读，不合并成一个万能参数。
        if (typeof range === 'number') {
          const start = Math.max(0, range)
          const slice = events.filter((event) => event.seq >= start)
          return { events: slice, hasMore: false }
        }
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
        const events = eventsOf(item.path, usage.get(item.id) ?? [], item.id)
        return snapshotOf(item, events.length, existsSync(item.path) ? statSync(item.path).size : 0)
      })
      listCache = { at: Date.now(), rows }
      return rows
    },
    stat(sessionId) {
      const item = listSessions().find((candidate) => candidate.id === sessionId)
      if (item === undefined) return undefined
      const events = eventsOf(item.path, usageBySession().get(sessionId) ?? [], sessionId)
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
