/**
 * superagent 的存储适配层：建库、迁移、单实例锁，以及窄写入 API。
 *
 * 表结构照 `docs/superagent-design.md:237-258` 的上游 DDL 原样搬（9 张表 + 4 个索引）。
 * 另外补了 `meta` / `event` / `assignment` 三张：原文没有它们，而这一版的写入 API
 * （追加事件、记一次分配、放运行期元数据）需要落点。原文一张没删、一个字段没改，
 * 新增的理由逐条写在 `SCHEMA_STATEMENTS` 里。
 *
 * 业务对象一律 JSON 进 `value` 列（原文第 260 行的取舍）：表结构稳定，P1 加字段不迁移。
 *
 * 版本用 `PRAGMA user_version`，不用原文的 `kv['store.schema']`：迁移框架在「连表都可能
 * 是坏的」这一刻就得读出可信版本号，而 `kv` 表本身可能正是要修的东西。user_version 是
 * SQLite 自己的字段，读它不依赖任何表。
 *
 * @module dsc/packages/superagent/adapters/store
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tryOsLock } from '@pneuma/runtime/core/os-lock.js'
import type { EffectRow } from './effects.js'
import { orchestratorDbPath, orchestratorLockPath } from '../paths.js'

/** 当前代码认识的 schema 版本。加表 / 改列时加一，并在 `MIGRATIONS` 里补一段。 */
export const SCHEMA_VERSION = 2

/** 第一版的结构就写在 `SCHEMA_STATEMENTS` 里，不占迁移表；迁移表只放 v1 之后的增量。 */
const BASE_VERSION = 1

/**
 * 版本 → 语句数组的迁移表：v1 之后每加一版就在末尾追加一段（当前只有 v2）。
 *
 * 为什么是表不是 if 链：迁移必须按版本号严格递增执行，且将来要能一眼看出「v3 改了哪几句」。
 * if 链一长，谁都不敢删旧分支，最后没人知道某个版本到底跑过什么。
 */
const MIGRATIONS: readonly { readonly version: number; readonly statements: readonly string[] }[] = [
  /*
   * v2：给 outbox 加状态列（pending / sending），让「取出即删」变成「先认领、再收尾」。
   *
   * **为什么建表语句里不同时加这一列**：`applySchema` 对空库也会跑迁移——空库从
   * `BASE_VERSION` 起算，v2 这一段一定执行。建表时已经带上 state、这里再 ALTER 一次，
   * SQLite 会抛 `duplicate column name: state`（已实测），整个库打不开。
   * 所以列只由这条迁移加：新库「先建 v1 形状，再 ALTER」，老库「本来就是 v1 形状，ALTER」，
   * 两条路径落到同一个结构，建表语句也不用改语义。
   *
   * `DEFAULT 'pending'` 让老库里已有的行升级后立刻能被发送泵认领，不需要额外的回填语句。
   */
  { version: 2, statements: ["ALTER TABLE outbox ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'"] },
]

/**
 * 建库语句。
 *
 * 前 9 张表与 4 个索引逐字来自 `docs/superagent-design.md:238-257`（上游 schema 11）。
 * 全部 `IF NOT EXISTS`：重复执行不报错，这是「同目录连开两次」与「表被手删后自愈」的前提。
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  // ── 上游原文，一字未改 ──────────────────────────────────────────────────
  'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);',
  // 这一句保持 v1 形状：v2 加的 `state` 列由 `MIGRATIONS` 那条 ALTER 加，
  // 否则新库会「建表已带列、再 ALTER」撞 duplicate column（理由见 MIGRATIONS）。
  'CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL);',
  `CREATE TABLE IF NOT EXISTS trigger_thread (
     thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL,
     PRIMARY KEY (thread, id));`,
  `CREATE TABLE IF NOT EXISTS effect (
     kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
     generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
     error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL, since TEXT NOT NULL,
     PRIMARY KEY (kind, key));`,
  'CREATE INDEX IF NOT EXISTS trigger_at ON trigger(at);',
  'CREATE INDEX IF NOT EXISTS trigger_thread_at ON trigger_thread(thread, at);',
  'CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);',
  'CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);',

  // ── 本适配层补的三张表：原文没有，写入 API 需要落点 ──────────────────────
  /*
   * meta：本插件自己的运行期元数据（迁移水位、上次修复时间这类）。
   * 为什么不复用 kv：kv 是上游 schema 的键空间，读写方是上游搬来的那套代码。两套语义
   * 混在一张表里，将来谁清空 kv 做一次 reset，就会顺手抹掉这里的修复记录。
   */
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  /*
   * event：工单事件流，只追加、按 seq 回放。
   * 为什么不塞 outbox：outbox 是「待执行的副作用」，发完就删；event 是账，要能一直读。
   * 合成一张表就得给「已发」加软删标记，队列越滚越慢，回放还得跳过死行。
   * 唯一索引同时干两件事：保证 (ticket, seq) 不重复，以及 listEvents 的范围扫。
   */
  `CREATE TABLE IF NOT EXISTS event (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ticket TEXT NOT NULL,
     seq INTEGER NOT NULL,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     at TEXT NOT NULL);`,
  'CREATE UNIQUE INDEX IF NOT EXISTS event_ticket_seq ON event(ticket, seq);',
  /*
   * assignment：谁在替哪张工单干活。
   * 为什么不写进 ticket.value：分配有独立生命周期（认领 / 释放 / 失败重派），而且要按
   * agent 查「手上有几张」；塞进 JSON 就只能全表扫、逐行 parse。
   */
  `CREATE TABLE IF NOT EXISTS assignment (
     id TEXT PRIMARY KEY,
     ticket TEXT NOT NULL,
     agent TEXT NOT NULL,
     state TEXT NOT NULL,
     at TEXT NOT NULL,
     value TEXT NOT NULL DEFAULT '{}');`,
  'CREATE INDEX IF NOT EXISTS assignment_ticket ON assignment(ticket);',
  'CREATE INDEX IF NOT EXISTS assignment_agent_state ON assignment(agent, state);',
]

/** 出错时带机器可判的 code：调用方要按 code 分支（版本过高 → 提示升级，锁占用 → 停在未启动）。 */
export type StoreErrorCode =
  | 'store_version_too_new'
  | 'store_missing'
  | 'instance_lock_busy'
  | 'ticket_exists'
  | 'ticket_not_found'
  | 'ticket_invalid'
  | 'event_invalid'
  | 'outbox_invalid'
  | 'outbox_corrupt'

/** 存储层的错误。`code` 是契约的一部分，别只靠 message 匹配。 */
export class StoreError extends Error {
  readonly code: StoreErrorCode

  constructor(code: StoreErrorCode, message: string) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}

/** 执行器起工作树要用的三元组（设计文档 §6.2 的 `ticket.execution.name`）。 */
export interface TicketExecution {
  /** 工作树目录名（`worktreesDir()` 下的一级子目录）。 */
  name: string
  /** 源仓库根。 */
  repo: string
  /** 这次执行用的分支。 */
  branch: string
}

/** 一张工单读出来的样子。字段都在 `ticket.value` 的 JSON 里。 */
export interface TicketRecord {
  id: string
  title: string
  task: string
  /** 状态机里的那一格；P0 默认 `queued`。 */
  state: string
  /** 来源：`manual`（手动）、以后的 `github` 等。 */
  source: string
  createdAt: string
  updatedAt: string
  /** 还没排到执行时是 null。 */
  execution: TicketExecution | null
}

/** 新建工单要给的字段：只收调用点真的有的，别把整张表结构摊给上游。 */
export interface NewTicket {
  /** 不传就生成 UUID；调用点想用自己的 id（比如从外部系统带过来）才传。 */
  id?: string
  title: string
  task: string
  state?: string
  source?: string
  execution?: TicketExecution
  /** 测试注入用；不传取当前时刻。 */
  at?: string
}

/** 一条出站消息：`kind` 决定发给哪个通道，`payload` 是通道自己解释的内容。 */
export interface OutboxItem {
  id: string
  kind: string
  payload: unknown
}

/** 入队时的入参：id 可以不传。 */
export interface NewOutboxItem {
  id?: string
  kind: string
  payload: unknown
}

/**
 * 把 `value` 列的 JSON 读成对象，认不出就给空对象。
 *
 * 改状态的写入也走它：就地改原对象才能保住不认识的字段，不能拿 `decodeTicketValue` 的结果
 * 写回去——那个函数只重建它认识的七个字段，P1 往 value 里加点东西，改一次状态就抹掉了。
 */
function parseTicketJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // 畸形 JSON 当成空对象：至少让这一行以 id + 默认值出现，而不是让整张列表崩掉
  }
  return {}
}

/** 把 `value` 列里的 JSON 收敛成工单。库文件用户能手改，所以这里按不可信输入处理。 */
export function decodeTicketValue(id: string, raw: unknown): TicketRecord {
  const parsed = parseTicketJson(raw)
  return {
    id,
    title: asText(parsed.title),
    task: asText(parsed.task),
    state: asText(parsed.state, 'unknown'),
    source: asText(parsed.source),
    createdAt: asText(parsed.createdAt),
    updatedAt: asText(parsed.updatedAt),
    execution: decodeExecution(parsed.execution),
  }
}

/** 只要字符串，别的类型一律回落：库里的数字/对象字段不该让读路径抛错。 */
function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * 三项缺一就当作「还没排到执行」。
 * 让执行器拿到半份配置去 `git worktree add`，报出来的会是 git 的错，比这里返回 null 难查得多。
 */
function decodeExecution(raw: unknown): TicketExecution | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const name = asText(value.name)
  const repo = asText(value.repo)
  const branch = asText(value.branch)
  if (name === '' || repo === '' || branch === '') return null
  return { name, repo, branch }
}

/** 出站行解析：认不出就抛 `outbox_corrupt`——宁可让泵停下报错，也别静默丢消息。 */
function decodeOutboxItem(raw: unknown): OutboxItem {
  if (typeof raw !== 'string') throw new StoreError('outbox_corrupt', 'outbox.value 不是字符串')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new StoreError('outbox_corrupt', `outbox.value 不是 JSON：${raw.slice(0, 80)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StoreError('outbox_corrupt', `outbox.value 不是对象：${raw.slice(0, 80)}`)
  }
  const value = parsed as Record<string, unknown>
  const id = asText(value.id)
  const kind = asText(value.kind)
  if (id === '' || kind === '') throw new StoreError('outbox_corrupt', `outbox 行缺 id 或 kind：${raw.slice(0, 80)}`)
  return { id, kind, payload: value.payload ?? null }
}

/** 当前时刻：统一 ISO 字符串，排序即时间序。 */
function nowIso(): string {
  return new Date().toISOString()
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get()
  const value = row?.user_version
  return typeof value === 'number' ? value : 0
}

function tooNew(path: string, version: number): StoreError {
  return new StoreError(
    'store_version_too_new',
    `数据库 schema 版本 ${String(version)} 高于本代码支持的 ${String(SCHEMA_VERSION)}（${path}）；` +
      '这是新版本 Pneuma 写的库，请升级后再打开，别用旧版本降级读它',
  )
}

/**
 * 建表 + 迁移。调用方负责开事务。
 *
 * 当前版本的建表语句每次都重跑：全是 `IF NOT EXISTS`，顺手补回被手删的表，
 * 「版本号对但表缺」的破损库就靠这一步自愈，不必单独写一套修复逻辑。
 */
function applySchema(db: DatabaseSync, fromVersion: number): void {
  for (const sql of SCHEMA_STATEMENTS) db.exec(sql)
  let version = Math.max(fromVersion, BASE_VERSION)
  for (const step of MIGRATIONS) {
    if (step.version <= version) continue
    for (const sql of step.statements) db.exec(sql)
    version = step.version
  }
  if (version !== SCHEMA_VERSION) {
    // 走到这里说明代码自己的迁移表缺了一段，不是用户能修的问题，按普通错误抛
    throw new Error(`迁移链不完整：执行到版本 ${String(version)}，代码要求 ${String(SCHEMA_VERSION)}`)
  }
  // PRAGMA 不接受绑定参数；这里拼进去的是代码常量，不来自外部输入
  db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
}

function migrate(db: DatabaseSync, path: string): void {
  const seen = readUserVersion(db)
  if (seen > SCHEMA_VERSION) throw tooNew(path, seen)
  db.exec('BEGIN IMMEDIATE')
  try {
    // 拿到写锁后重读：两个进程同时开一个空库时，先到的那个刚迁移完，
    // 这里读到的若还是迁移前的旧值，就会把整段 DDL 再跑一遍（幂等，但白等锁）。
    const version = readUserVersion(db)
    if (version > SCHEMA_VERSION) throw tooNew(path, version)
    applySchema(db, version)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 有的错误（比如 COMMIT 自身失败）已经让 SQLite 自己回滚了，再 ROLLBACK 会报「无事务」
    }
    throw error
  }
}

function closeQuietly(db: DatabaseSync): void {
  try {
    if (db.isOpen) db.close()
  } catch {
    // 关不掉也不该盖住真正的错误
  }
}

/**
 * 把上次崩在发送途中的行放回队列：`sending` → `pending`，返回改动行数。
 *
 * **为什么放在开库这一步**：一次打开库就意味着「上一段生命周期结束了」——单实例锁保证
 * 同一时刻只有一个进程握着这个库，所以此刻还停在 `sending` 的行，一定是上一个进程认领之后
 * 没来得及收尾的，没有别人还会去发它。放在 `openStore` 里，运行时、命令、体检、测试
 * 四条入口自动都覆盖，不必让每个调用方记得调一次 `runtime.recover()`。
 *
 * **为什么重发是安全的**：两个通道都按消息 id 做幂等（飞书的 `--idempotency-key`、
 * GitHub 评论里的 HTML 标记），最坏情况是对方收到两条相同的请求，而不是会话里多出一句话。
 * 两害相权取其轻：宁可按幂等键重发一次，也不丢一条已经应答过用户的回复。
 */
function recoverSendingOutbox(db: DatabaseSync): number {
  const result = db.prepare("UPDATE outbox SET state = 'pending' WHERE state = 'sending'").run()
  return Number(result.changes ?? 0)
}

/**
 * 打开编排库：建目录、设 PRAGMA、建表、迁移。
 *
 * WAL 是这里唯一要解释的取舍：编排器是单写者，但界面、命令、体检会同时读。
 * 默认的回滚日志会让读挡住写、写挡住读；WAL 下读不挡写，正好对上这个读写比例。
 */
export function openStore(path: string = orchestratorDbPath()): DscStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    migrate(db, path)
    // 上一进程崩在发送途中的行在打开时统一放回队列（理由见 recoverSendingOutbox）
    recoverSendingOutbox(db)
  } catch (error) {
    closeQuietly(db)
    throw error
  }
  try {
    // 设计文档 §5.1 要求文件 0600：库里全是用户的需求原文与代码改动记录。
    // Windows 上 chmod 只动只读位、不会真的收窄 ACL；失败也不该挡住打开。
    chmodSync(path, 0o600)
  } catch {
    // 见上：平台差异，不影响可用性
  }
  return new DscStore(db)
}

/**
 * 写入面。只做「一件事」的方法，事务边界由 `atomic` 统一管；调用方拿不到裸连接，
 * 免得有人绕过事务直接改表。
 */
export class DscStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** 同包的仓储适配层要用同一个连接：事务必须落在同一个 DatabaseSync 上。 */
  get handle(): DatabaseSync { return this.db }

  /**
   * 事务：写回执与入队副作用必须落在同一个事务里（设计文档 §6.1 第 1 条）。
   * 嵌套调用并入外层——回滚的责任只归最外层，内层自己 BEGIN 会把外层的改动提前提交。
   */
  atomic<T>(work: () => T): T {
    if (this.db.isTransaction) return work()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 同 migrate：SQLite 可能已经自己回滚
      }
      throw error
    }
  }

  /** 建一张工单，返回它的 id。 */
  createTicket(input: NewTicket): string {
    if (input.title === '' || input.task === '') {
      throw new StoreError('ticket_invalid', '工单的标题与需求都不能为空')
    }
    const id = input.id ?? randomUUID()
    const at = input.at ?? nowIso()
    const record: TicketRecord = {
      id,
      title: input.title,
      task: input.task,
      state: input.state ?? 'queued',
      source: input.source ?? 'manual',
      createdAt: at,
      updatedAt: at,
      execution: input.execution ?? null,
    }
    this.atomic(() => {
      if (this.db.prepare('SELECT 1 AS hit FROM ticket WHERE id = ?').get(id) !== undefined) {
        throw new StoreError('ticket_exists', `工单 id 已存在：${id}`)
      }
      this.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(id, JSON.stringify(record))
    })
    return id
  }

  /** 追加一条工单事件，返回它在工单内的 seq（从 1 起，紧接上一条）。 */
  appendEvent(ticketId: string, kind: string, payload: unknown): number {
    if (kind === '') throw new StoreError('event_invalid', `事件 kind 不能为空（工单 ${ticketId}）`)
    return this.atomic(() => {
      this.readTicket(ticketId)
      // BEGIN IMMEDIATE 已经独占写锁，MAX+1 不会被别的进程插进来
      const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM event WHERE ticket = ?').get(ticketId)
      const next = typeof row?.next === 'number' ? row.next : 1
      this.db
        .prepare('INSERT INTO event (ticket, seq, kind, payload, at) VALUES (?, ?, ?, ?, ?)')
        .run(ticketId, next, kind, JSON.stringify(payload ?? null), nowIso())
      return next
    })
  }

  /** 改工单状态。状态是 `value` 里的一个字段，就地改原对象，不让 P1 加的字段被顺手清掉。 */
  setTicketState(id: string, state: string): void {
    if (state === '') throw new StoreError('ticket_invalid', `工单状态不能为空（${id}）`)
    this.atomic(() => {
      const row = this.db.prepare('SELECT value FROM ticket WHERE id = ?').get(id)
      if (row === undefined) throw new StoreError('ticket_not_found', `没有这张工单：${id}`)
      const record = parseTicketJson(row.value)
      record.state = state
      record.updatedAt = nowIso()
      this.db.prepare('UPDATE ticket SET value = ? WHERE id = ?').run(JSON.stringify(record), id)
    })
  }

  /** 入队一条出站消息，返回它的 id。新行一律 `pending`，等着发送泵来认领。 */
  enqueueOutbox(item: NewOutboxItem): string {
    if (item.kind === '') throw new StoreError('outbox_invalid', '出站消息的 kind 不能为空')
    const id = item.id ?? randomUUID()
    this.atomic(() => {
      this.db
        .prepare("INSERT INTO outbox (id, value, state) VALUES (?, ?, 'pending')")
        .run(id, JSON.stringify({ id, kind: item.kind, payload: item.payload ?? null }))
    })
    return id
  }

  /**
   * 认领最多 `limit` 条待发消息：把它们从 `pending` 改成 `sending` 并返回，**行不删**。
   *
   * 为什么不再「取出即删」：v1 的 `drainOutbox` 一次取走最多 50 行，发完之前只活在内存里，
   * 进程崩在这批中间，还没发的那几条就没了。改成先标记再发，崩了下次开库还能找回来
   * （`recoverSendingOutbox` 把它们放回 `pending`）。
   *
   * 为什么认领与读取在同一个事务里：`UPDATE ... RETURNING` 一条语句完成「选中 + 改状态」，
   * 中间没有第二个读者能插进来把同一行也认领走。`ORDER BY rowid` 保住入队顺序；
   * RETURNING 本身不保证行序，所以把 rowid 一起带回来再排一次——顺序乱了不会丢消息，
   * 但「先催 A 再催 B」的先后会乱。
   */
  claimOutbox(limit = 50): OutboxItem[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new StoreError('outbox_invalid', `claimOutbox 的 limit 必须是正整数：${String(limit)}`)
    }
    return this.atomic(() => {
      const rows = this.db
        .prepare(
          `UPDATE outbox SET state = 'sending'
           WHERE id IN (SELECT id FROM outbox WHERE state = 'pending' ORDER BY rowid LIMIT ?)
           RETURNING rowid AS row, value`,
        )
        .all(limit)
      if (rows.length === 0) return []
      return [...rows]
        .sort((left, right) => Number(left.row) - Number(right.row))
        .map((row) => decodeOutboxItem(row.value))
    })
  }

  /**
   * 收尾：发完（含「永久发不出」、放弃投递）就删行。
   *
   * 只按 id 删：一行在库里的 id 就是它的幂等键，状态是 `sending` 还是被谁改回 `pending`
   * 都不影响「这条消息已经有结论了」这个事实。
   */
  finishOutbox(id: string): void {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id)
  }

  /** 这一拍没发出去（发送失败、来源没起来、退避未到点）：状态改回 `pending`，下一拍还能认领。 */
  requeueOutbox(id: string): void {
    this.db.prepare("UPDATE outbox SET state = 'pending' WHERE id = ?").run(id)
  }

  /**
   * `effect` 表的五个窄方法：前四条（入队、两种取行、收尾、重试）的语句来自上游
   * `app/effects.ts`，只做了换行排版；`countEffects` 是本插件为健康上报补的一条 COUNT
   * （上游 `report` 那条查询还带 `attempts` / `since`，这里按窄口只需要计数）。
   *
   * 为什么不在这里判重、不在这里算退避：这些语义属于队列（`adapters/effects.ts`），存储层
   * 只负责把那几句话落到 SQL 上。搬家会让「表里一行到底是什么状态」有两份解释。
   */

  /**
   * 入队或合并一行副作用。
   *
   * `ON CONFLICT` 的那一段是整张表的关键：同一 (kind,key) 再说一遍时覆盖载荷、`generation`
   * 加一（运行中的旧尝试据此放弃收尾）、清掉失败计数、due 拉回现在；`seq` 保持原值，
   * 这件事在队列里的先后位置不因为重复入队而改变。
   *
   * **同步执行**：调用方可能在 Engine 的写事务里，异步落库会漏掉「已提交、没入队」这一半。
   */
  enqueueEffect(kind: string, key: string, value: string, seq: number, due: number, since: string): void {
    this.db
      .prepare(
        `INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, key) DO UPDATE
         SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`,
      )
      .run(kind, key, value, seq, due, since)
  }

  /** 非 ordered 的 kind：取到期的前 `limit` 行，按 seq。`16 + 在跑数` 那个上限由队列算好后传进来。 */
  claimEffectRows(kind: string, now: number, limit: number): EffectRow[] {
    return this.db
      .prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? AND due <= ? ORDER BY seq LIMIT ?')
      .all(kind, now, limit) as unknown as EffectRow[]
  }

  /**
   * ordered 的 kind：只取队首一行，**不带 due 条件**。
   *
   * 队首没到期时后面的行也不许跑——顺序语义就靠这一条；队列拿到行之后自己再判 due。
   */
  claimOrderedEffectRow(kind: string): EffectRow | undefined {
    return this.db
      .prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? ORDER BY seq LIMIT 1')
      .get(kind) as unknown as EffectRow | undefined
  }

  /** 成功收尾：删掉自己跑的那一行。四个条件缺一不可（行可能已被重新入队或被撤掉）。 */
  finishEffect(kind: string, key: string, seq: number, generation: number): void {
    this.db
      .prepare('DELETE FROM effect WHERE kind = ? AND key = ? AND seq = ? AND generation = ?')
      .run(kind, key, seq, generation)
  }

  /**
   * 失败 / 推后：只改 attempts、error、due。
   *
   * attempts 由调用方算好再传（不是 SQL 里的 `attempts + 1`）：队列手里有这一行的 attempts，
   * 传绝对值比让存储层再读一次更直白；四个匹配条件照样保证不会改到别人的行。
   */
  retryEffect(kind: string, key: string, seq: number, generation: number, attempts: number, error: string, due: number): void {
    this.db
      .prepare('UPDATE effect SET attempts = ?, error = ?, due = ? WHERE kind = ? AND key = ? AND seq = ? AND generation = ?')
      .run(attempts, error, due, kind, key, seq, generation)
  }

  /** 某个 kind 还有几行在等；健康上报用（没接健康就不必调）。 */
  countEffects(kind: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS waiting FROM effect WHERE kind = ?').get(kind)
    return Number(row?.waiting ?? 0)
  }

  /** 关连接。重复调用是空操作，方便 finally 里写。 */
  close(): void {
    closeQuietly(this.db)
  }

  /** 读一张工单，不存在就抛 `ticket_not_found`。 */
  private readTicket(id: string): TicketRecord {
    const row = this.db.prepare('SELECT value FROM ticket WHERE id = ?').get(id)
    if (row === undefined) throw new StoreError('ticket_not_found', `没有这张工单：${id}`)
    return decodeTicketValue(id, row.value)
  }
}

/** 拿在手里的单实例锁。`release()` 可以重复调。 */
export interface InstanceLock {
  readonly path: string
  release(): void
}

/**
 * 拿编排库的单实例锁。拿不到立刻抛 `instance_lock_busy`，绝不死等。
 *
 * 主路径走 `src/core/os-lock.ts:265` 的 `tryOsLock`（Windows 命名互斥量 / POSIX flock）：
 * 包的依赖方向是「包 → core」，仓库里早有这样的引用（`src/packages/checkpoint/shadow.ts:54`），
 * 不违反分层；而且 OS 锁的持有者是内核对象，进程一死就自动释放，没有陈锁。
 *
 * `unsupported`（koffi 没装、平台不认识）时退回 `O_EXCL` 文件锁：宁可留一个崩溃后要手删
 * 的锁文件，也不能在「两个进程同时写同一个库」这件事上 fail-open。
 */
export function acquireInstanceLock(path: string = orchestratorLockPath()): InstanceLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const attempt = tryOsLock(path)
  if (attempt.kind === 'ok') {
    let released = false
    return {
      path,
      release: () => {
        if (released) return
        released = true
        attempt.lock.release()
      },
    }
  }
  if (attempt.kind === 'busy') {
    throw new StoreError('instance_lock_busy', `另一个 Pneuma 进程正握着编排库（${path}）；本进程停在未启动状态`)
  }
  return acquireFileLock(path, attempt.why)
}

/**
 * 兜底文件锁：`O_EXCL` 建文件，已存在就是别人拿着。
 *
 * 只写 pid 供人排查，判定只看文件在不在——读 pid 再查活着的写法在 Windows 上会被 pid
 * 复用骗（`src/core/os-lock.ts:3-8` 记过这个坑），这里不重复它。
 */
function acquireFileLock(path: string, why: string): InstanceLock {
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new StoreError(
        'instance_lock_busy',
        `另一个 Pneuma 进程正握着编排库（${path}）；本进程停在未启动状态` +
          `（OS 锁不可用，已退回文件锁：${why}。崩溃残锁请手动删掉这个文件）`,
      )
    }
    throw error
  }
  try {
    writeSync(fd, `${String(process.pid)}\n`)
  } catch {
    // pid 只是给人看的，写不进去不影响锁本身
  }
  try {
    closeSync(fd)
  } catch {
    // 同上
  }
  let released = false
  return {
    path,
    release: () => {
      if (released) return
      released = true
      try {
        unlinkSync(path)
      } catch {
        // 已经被手删了：目的已达到
      }
    },
  }
}
