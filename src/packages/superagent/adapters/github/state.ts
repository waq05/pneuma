/**
 * 游标与 ETag 的落盘：直接读写 `kv` 表（DDL 见 `adapters/store.ts:46`）。
 *
 * 为什么不经过 `DscStore`：它没给 kv 的读写方法，而这一层要的是「键值 + 一次事务」。
 * 表名与列名照抄，键名照上游 `kv.ts:46-50` 的形状——键名是**跨版本契约**：改了它，
 * 升级后旧游标读不到，症状是「第一次轮询把 14 天的历史又读一遍」，不会报错。
 *
 * 为什么值一律走 JSON：`kv.value` 是 `TEXT NOT NULL`，而游标、重试表、CI 指纹都是结构体。
 * 读不出来（手改过库、旧版本写坏）时返回 `undefined` 而不是抛错：一条坏游标不该让整个
 * 来源停摆，退回「从这一拍开始」比崩溃好。
 *
 * @module dsc/packages/superagent/adapters/github/state
 */

/** `node:sqlite` 的语句对象在本层用到的那两个方法；只声明用得到的，别把整个 DatabaseSync 递进来。 */
export interface GithubKvStatement {
  get(...args: unknown[]): unknown
  run(...args: unknown[]): unknown
  all(...args: unknown[]): unknown[]
}

/** `DscStore.handle` 的结构类型（`adapters/store.ts:360`），只取 `prepare`。 */
export interface GithubKvHandle {
  prepare(sql: string): GithubKvStatement
}

/**
 * 键名，照 `kv.ts:46-50` 的 `KV.github` 一族写。
 *
 * `cursor` / `stream` / `ci` 的冒号后缀不要改成别的分隔符：上游按 `prefix + name.join(':')`
 * 生成（`kv.ts:17`），运维查库、迁移脚本都按这个形状找。
 */
export const GITHUB_KEYS = {
  /** 通知的读取游标（一个仓库一份）。 */
  since: 'github-since',
  /** 读失败、还没到 24 小时放弃线的通知，按编号记在这里。 */
  retries: 'github-retry',
  /** 某个 Issue / PR 的读取游标，通知读取与订阅轮询共用。 */
  cursor: (number: number): string => `github-cursor:${String(number)}`,
  /** 某个全仓库事件流的游标、各类型的起始时间与 ETag。 */
  stream: (id: string): string => `github-stream:${id}`,
  /** 默认分支 CI 的基线（上一次的失败集合）与上报计数。 */
  branchCi: 'github-branch-ci',
  /** 某个 PR 的 CI 指纹与上报计数。 */
  ci: (number: number): string => `github-ci:${String(number)}`,
} as const

/** 一条待重试的通知（上游 `sources/github.ts:155`）。 */
export interface GithubRetry {
  since: string
  pr: boolean
  failedAt?: string
  attempts?: number
}

/** 一条事件流的落盘状态（`kv.ts:48`）。 */
export interface GithubStreamState {
  since: string
  /** 各类型（issues / pulls / comments）从什么时候开始收，用于丢掉「开关打开之前」的旧条目。 */
  started: Record<string, string>
  etag?: string
}

/** 默认分支 CI 的状态（`kv.ts:49`）。 */
export interface GithubBranchCiState {
  branch?: string
  failures?: string[]
  revision: number
}

/** 某个 PR 的 CI 状态（`kv.ts:50`）。 */
export interface GithubCiState {
  fingerprint: string
  revision: number
}

/** 一行的 `value` 列；不是字符串就当没读到。 */
function column(row: unknown): string | undefined {
  if (row === null || typeof row !== 'object') return undefined
  const value = (row as { value?: unknown }).value
  return typeof value === 'string' ? value : undefined
}

/**
 * kv 上的读写与事务。
 *
 * `set(key, undefined)` 表示删除：上游 `ctx.state.set(key, undefined)` 就是这个语义
 * （`sources/github.ts:184/191`），开关关掉时靠它把流游标清空，将来重新打开才会从
 * 打开的那一刻算起，而不是把关闭期间的旧条目追回来。
 */
export class GithubState {
  private readonly handle: GithubKvHandle
  private depth = 0

  constructor(handle: GithubKvHandle) {
    this.handle = handle
  }

  get<T>(key: string): T | undefined {
    const raw = column(this.handle.prepare('SELECT value FROM kv WHERE key = ?').get(key))
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }

  set<T>(key: string, value: T | undefined): void {
    if (value === undefined) {
      this.handle.prepare('DELETE FROM kv WHERE key = ?').run(key)
      return
    }
    this.handle.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, JSON.stringify(value))
  }

  /**
   * 一次事务。
   *
   * 嵌套调用并入外层（同 `DscStore.atomic`，`adapters/store.ts:366-368`）：通知游标必须和
   * 重试表一起落盘（`sources/github.ts:341`），要么都前进、要么都别动——只前进游标而没记下
   * 重试，那几条读失败的通知就永久消失了。
   */
  atomic<T>(work: () => T): T {
    if (this.depth > 0) return work()
    this.handle.prepare('BEGIN IMMEDIATE').run()
    this.depth += 1
    try {
      const value = work()
      this.handle.prepare('COMMIT').run()
      return value
    } catch (error) {
      try {
        this.handle.prepare('ROLLBACK').run()
      } catch {
        // SQLite 可能已经自己回滚（比如 COMMIT 本身失败），再 ROLLBACK 会报「无事务」
      }
      throw error
    } finally {
      this.depth -= 1
    }
  }
}
