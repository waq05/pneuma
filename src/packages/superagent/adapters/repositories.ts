/**
 * superagent 的仓储适配：把领域端口 `Repositories` 落在 SQLite 上。
 *
 * 表名与列照上游 `src/app/store.ts`（schema 11）：`trigger` / `disposition` / `thread` / `ticket` /
 * `decision` 都是「主键 + `value` 一列 JSON」，所以这里不做字段映射、不建 ORM 模型——领域对象
 * 原样序列化，P1 往模型里加字段不用改这里，也不用迁移（同 `adapters/store.ts:9` 的取舍）。
 *
 * 所有方法同步：端口注释（`core/ports.ts:105`）写明「synchronous so `atomic` can wrap」。
 * 一旦有 async，一次工作单元就被拆成多个 microtask，别的写者能插进中间，事务边界名存实亡。
 *
 * @module dsc/packages/superagent/adapters/repositories
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  latestAssignment,
  threadKey,
  type Decision,
  type Repositories,
  type Thread,
  type Ticket,
  type Trigger,
  type TriggerDisposition,
} from '../core/index.js'

/**
 * `value` 列读不成 JSON 对象时抛的错。
 *
 * 形状跟着 `StoreError` 走（`name` + 机器可判的 `code`），但单开一个类：`StoreError` 的 code
 * 描述的是「库」的状态（版本、锁、缺库），这里描述的是「某一行坏了」。混进同一个联合类型，
 * 调用方就得在版本判断里多排除一个跟它无关的成员。
 */
export class StoreRowError extends Error {
  readonly code = 'store_row_corrupt'

  constructor(readonly table: string, readonly row: string, cause: unknown) {
    super(
      `${table} 表 ${row} 行的 value 不是合法 JSON 对象：${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'StoreRowError'
  }
}

/**
 * 仓储端口的 SQLite 实现。
 *
 * 构造时只接一个连接，不自己 `new DatabaseSync`：本包已经有建库、迁移、PRAGMA 的唯一入口
 * （`openStore`），再开一条连接就会冒出两套 PRAGMA、两个 WAL 写者。连接用 `DscStore.handle` 取。
 */
export class StoreRepositories implements Repositories {
  /** 当前事务层数；> 0 时再进 `atomic` 只交出执行权，提交或回滚归开事务的那一层。 */
  private depth = 0

  constructor(private readonly db: DatabaseSync) {}

  /**
   * 一个工作单元：最外层 `BEGIN IMMEDIATE`，成功 `COMMIT`，失败 `ROLLBACK` 后把原错误原样抛回。
   *
   * 为什么是 IMMEDIATE：这些工作单元一开始就打算写，先拿写锁，能在「读到旧值再改」的竞态
   * 发生前挡住别的进程，而不是等第一条 INSERT 才失败、前面读到的值已经过期。
   *
   * 为什么嵌套要记账：SQLite 不认嵌套事务，内层自己 BEGIN 会报错；退一步用 SAVEPOINT 也不行——
   * 内层 RELEASE 后如果外层再回滚，内层的改动跟着一起没，语义上等价，但内层无法单独回滚。
   * 本包的约定是「回滚只归最外层」，所以内层直接执行，异常交给外层收。
   */
  atomic<T>(work: () => T): T {
    // 另一条重入路径：外层是 `DscStore.atomic` 开的事务（同一个连接）。这时 depth 还是 0，
    // 但 db.isTransaction 已经是 true，再 BEGIN 会被 SQLite 拒绝，所以也要并入外层。
    if (this.depth > 0 || this.db.isTransaction) {
      const outer = this.depth
      this.depth = outer + 1
      try {
        return work()
      } finally {
        this.depth = outer
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      const value = work()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // COMMIT 自身失败时 SQLite 已经回滚过，再 ROLLBACK 会报「没有活动事务」。
        // 吞掉它，唯一目的是别盖住真正要往上抛的那个错误。
      }
      throw error
    } finally {
      this.depth = 0
    }
  }

  readonly triggers = {
    get: (id: string): Trigger | undefined => this.one<Trigger>('trigger', 'id', id),
    /**
     * 写 Trigger 的同时重建 `trigger_thread` 索引：这张表把「哪条 Trigger 在什么时候到过哪个线程」
     * 单独存成列，读时间线时不必把整张 `trigger` 表 parse 一遍。上游同样在 save 里重建
     * （`src/app/store.ts:127-132`），漏掉它索引就会停在旧值上，还不报错。
     *
     * 三条语句必须同一个事务，否则中间一刻索引和 Trigger 对不上。
     */
    save: (trigger: Trigger): void => {
      this.atomic(() => {
        this.db
          .prepare(
            'INSERT INTO trigger (id, value, at) VALUES (?, ?, ?) ' +
              'ON CONFLICT(id) DO UPDATE SET value = excluded.value, at = excluded.at',
          )
          .run(trigger.id, JSON.stringify(trigger), trigger.at)
        this.db.prepare('DELETE FROM trigger_thread WHERE id = ?').run(trigger.id)
        const insert = this.db.prepare(
          'INSERT OR IGNORE INTO trigger_thread (thread, id, at, human) VALUES (?, ?, ?, ?)',
        )
        for (const ref of trigger.threads) {
          insert.run(threadKey(ref), trigger.id, trigger.at, trigger.human ? 1 : 0)
        }
      })
    },
    disposition: (id: string): TriggerDisposition | undefined =>
      this.one<TriggerDisposition>('disposition', 'id', id),
    saveDisposition: (id: string, value: TriggerDisposition): void => {
      this.db
        .prepare('INSERT INTO disposition (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value')
        .run(id, JSON.stringify(value))
    },
  }

  readonly threads = {
    get: (key: string): Thread | undefined => this.one<Thread>('thread', 'key', key),
    save: (thread: Thread): void => {
      this.db
        .prepare('INSERT INTO thread (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(thread.key, JSON.stringify(thread))
    },
    list: (): Thread[] => this.scan<Thread>('thread', 'key', 'ASC'),
    /**
     * 判据逐字照上游生成列（`src/app/store.ts:38`）：`pending` 非空，或 `evaluating` 已存在。
     *
     * 为什么不看「有没有工单」：线程上可能早就有订阅它的工单，但 Trigger 一条都没排队，
     * Eval 也从未启动——用工单近似会把这种线程算成活跃，防抖队列之外凭空多出一批要跑的东西。
     */
    active: (): Thread[] =>
      this.scan<Thread>('thread', 'key', 'ASC').filter(
        (thread) => thread.pending.length > 0 || thread.evaluating !== undefined,
      ),
  }

  readonly tickets = {
    get: (id: string): Ticket | undefined => this.one<Ticket>('ticket', 'id', id),
    save: (ticket: Ticket): void => {
      this.db
        .prepare('INSERT INTO ticket (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value')
        .run(ticket.id, JSON.stringify(ticket))
    },
    /** 新的在前：上游 `src/app/store.ts:237` 是 `ORDER BY rowid DESC`。 */
    list: (): Ticket[] => this.scan<Ticket>('ticket', 'id', 'DESC'),
    /** 未结束 = 没有 `ended`，对应上游生成列 `open`（`src/app/store.ts:32`）。 */
    open: (): Ticket[] => this.scan<Ticket>('ticket', 'id', 'DESC').filter((ticket) => !ticket.ended),
    /**
     * 判据照上游生成列（`src/app/store.ts:34-35`）：有未送达 Input，或**最新** Assignment 处于
     * pending / running。
     *
     * 「最新」不能放宽成「任意一个」：工单的 Assignment 按时间追加，历史那条停在 running
     * 是数据损坏（引擎加下一条前会关掉上一条），把损坏当成活跃会让工单永远退不出活跃集。
     * SQL 那边用 `$.assignments[#-1]` 表达，这里用 `latestAssignment`（`core/model.ts:334`），
     * 与内存实现（`core/memory.ts:43`）同一条判据。
     */
    active: (): Ticket[] =>
      this.scan<Ticket>('ticket', 'id', 'DESC').filter((ticket) => {
        if (ticket.undelivered.length > 0) return true
        const state = latestAssignment(ticket)?.state
        return state === 'pending' || state === 'running'
      }),
  }

  readonly decisions = {
    get: (id: string): Decision | undefined => this.one<Decision>('decision', 'id', id),
    /**
     * `thread` 单独一列而不是只存在 value 里：`byThread` 要按线程取整段决策历史，列上还有索引
     * `decision_thread`，这样翻历史不用先把整张表 parse 一遍。上游同（`src/app/store.ts:245`）。
     */
    save: (decision: Decision): void => {
      this.db
        .prepare(
          'INSERT INTO decision (id, thread, value) VALUES (?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET value = excluded.value, thread = excluded.thread',
        )
        .run(decision.id, decision.threadKey, JSON.stringify(decision))
    },
    /** 旧的在先：一次 Eval 的历史按发生顺序读才有意义，上游 `src/app/store.ts:246` 同样 `ORDER BY rowid`。 */
    byThread: (key: string): Decision[] => {
      const rows = this.db.prepare('SELECT id, value FROM decision WHERE thread = ? ORDER BY rowid').all(key)
      return rows.map((row) => this.parse<Decision>('decision', String(row.id), row.value))
    },
  }

  /**
   * 读一行并按 JSON 还原。
   *
   * 表名与主键列名都是本文件里的字面量（`thread` 表的主键列叫 `key`，其余叫 `id`），拼进 SQL
   * 的只有调用点常量，不含外部输入。
   */
  private one<T>(table: string, column: 'id' | 'key', value: string): T | undefined {
    const row = this.db.prepare(`SELECT value FROM ${table} WHERE ${column} = ?`).get(value)
    return row === undefined ? undefined : this.parse<T>(table, value, row.value)
  }

  /** 全表扫，顺序与上游一致：`rowid` 就是插入序，没有别的稳定排序可用。 */
  private scan<T>(table: string, column: 'id' | 'key', order: 'ASC' | 'DESC'): T[] {
    const rows = this.db.prepare(`SELECT ${column} AS rowkey, value FROM ${table} ORDER BY rowid ${order}`).all()
    return rows.map((row) => this.parse<T>(table, String(row.rowkey), row.value))
  }

  /**
   * JSON 解析失败必须往上抛，不能当成「没有这一行」。
   *
   * 仓储的 `get` 返回 undefined 只有一种含义：库里没有这条。把坏行也报成 undefined，上层会
   * 当成没收到、把同样的消息再写一遍，坏数据就一直藏在库底；抛出去至少能让编排器停下并指向
   * 具体那张表那一行。库文件用户能手改，所以这里按不可信输入处理。
   */
  private parse<T>(table: string, row: string, raw: unknown): T {
    if (typeof raw !== 'string') throw new StoreRowError(table, row, 'value 列不是文本')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new StoreRowError(table, row, error)
    }
    // JSON 里的 null / 数组也是「解析成功」，但它们不满足端口返回的对象类型；
    // 放过去会让上层拿到 null 才炸，错误点离这里更远。
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StoreRowError(table, row, `JSON 不是对象：${raw.slice(0, 80)}`)
    }
    return parsed as T
  }
}
