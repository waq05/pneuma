/**
 * 插件工厂的「到达」协议：一个 id 从「批脚本或单资源 URL」到「工厂已注册」的三态回退。
 *
 * 这份逻辑住在共享层（浏览器安全、零 node 依赖）有三个理由：
 *
 *   1. 它是**取数路径的正确性核心**——批脚本是一段 classic script、一次注册整批工厂，
 *      失败形态与单资源不同：传输失败（`error` 事件，什么都没执行）可以同 URL 重试一次；
 *      加载了却没注册这条 id（解析错、或运行期 throw 停了后面的注册）**绝不能重放**，
 *      否则会停在同一处，还可能把整批旧工厂覆盖回来（dsc 的工厂表是后写覆盖，不会像
 *      参考实现那样「二次注册即抛」，所以这条禁令更要显式写死）。
 *   2. 参考实现的 dump 里最难核对的一段就是「最多三次请求」的算术；放在这里之后，
 *      同一份实现既能被浏览器壳用，也能被 node 探针直接驱动（探针用一个假的 load 计数）。
 *   3. 换装时机与记账（在途共享、已执行集合、已失败集合）是有状态的东西，散在加载器里
 *      容易在两处各写一份而慢慢分叉。
 *
 * @module dsc/ui/arrival
 */

/** 一条待到达的图行：首选 URL +（可选）回退的单资源 URL。 */
export interface UiArrivalRow {
  /** 插件 id（工厂表里的键）。 */
  id: string
  /** 首选取数地址：批 URL，或 HMR 重取时的单资源 URL。 */
  preferred: string
  /** 首选不是单资源时给的单资源回退地址。 */
  fallback?: string
}

/** 到达协议依赖的外部面：取数（执行脚本）与「工厂注册了没有」。 */
export interface UiArrivalHost {
  /** 取一个 URL 并让它执行；拒绝 = 传输失败。同一 URL 的在途共享由账本负责。 */
  load(url: string): Promise<void>
  /** 工厂表里这个 id 的工厂在不在。 */
  has(id: string): boolean
}

/** 一行到达的结果（探针读数；失败时带完整原因链）。 */
export interface UiArrivalResult {
  /** 请求过的 URL，按发生顺序（含重试与回退）。 */
  requests: string[]
  /** 失败原因链（成功时为空）。 */
  failures: string[]
}

/**
 * 到达账本：在途共享 + 「已执行」「已失败」两张 URL 表。
 *
 * 为什么不放在 `boot.ts` 里：HMR 的换装（按新 rev 重取单资源）与首装的批取数走同一条
 * 协议，账本必须跨两次调用活着，也要能被探针单独驱动。
 */
export class UiArrivalLedger {
  /** 同一 URL 的在途取数（一个批被 N 条 entry 需要时只发一次请求）。 */
  private readonly inFlight = new Map<string, Promise<void>>()
  /** 已经执行过的 URL：绝不再取（重放会停在同一处/覆盖已注册的工厂）。 */
  private readonly executed = new Set<string>()
  /** 已经失败过的 URL：不再尝试（同一 URL 的连续失败只报一次）。 */
  private readonly failed = new Set<string>()

  /** 取一个 URL（同 URL 共享在途），成功后记进「已执行」。 */
  private loadShared(url: string, host: UiArrivalHost): Promise<void> {
    let transport = this.inFlight.get(url)
    if (transport === undefined) {
      transport = host
        .load(url)
        .then(() => {
          this.executed.add(url)
        })
        .finally(() => {
          this.inFlight.delete(url)
        })
      this.inFlight.set(url, transport)
    }
    return transport
  }

  /**
   * 让一条图行的工厂到达。
   *
   * 三态算术（与参考实现逐分支对齐；`requests` 回填给探针，请求数可逐条数死）：
   *
   *   | 情形 | 请求序列 | 次数/每条缺行 |
   *   | --- | --- | --- |
   *   | 批传输失败 | 批 → 批（重试 1 次） → 单资源 | 3 |
   *   | 批执行了但没注册这条 id | 批 → 单资源（批进「已失败」，绝不重放） | 2 |
   *   | 同批更早的行已让批执行过、这条仍缺 | 0 → 单资源 | 1 |
   *   | 批已记失败 | 0 → 单资源 | 1 |
   *   | 一切正常 | 批（同批所有行共享在途/已执行） | 整批 1 |
   *
   * @throws 失败时抛出带整条原因链的错误（调用方决定记为报告还是忽略预取失败）
   */
  async arrive(row: UiArrivalRow, host: UiArrivalHost): Promise<UiArrivalResult> {
    const result: UiArrivalResult = { requests: [], failures: [] }
    if (host.has(row.id)) return result
    const attempt = async (url: string): Promise<'registered' | 'transport-failed' | 'not-registered'> => {
      result.requests.push(url)
      try {
        await this.loadShared(url, host)
      } catch (error) {
        result.failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
        return 'transport-failed'
      }
      if (host.has(row.id)) return 'registered'
      result.failures.push(`${url}: 脚本执行了却没有注册「${row.id}」的工厂`)
      return 'not-registered'
    }

    let outcome: 'registered' | 'transport-failed' | 'not-registered' = 'transport-failed'
    if (this.failed.has(row.preferred)) {
      result.failures.push(`${row.preferred}: 这个地址上一次已经失败过，跳过`)
    } else if (row.fallback !== undefined && this.executed.has(row.preferred)) {
      // 批已经跑过（同批更早的行就是这么注册的），这条还缺：重放会停在同一处。
      result.failures.push(`${row.preferred}: 批已经执行过却没注册「${row.id}」，不再重放`)
      outcome = 'not-registered'
      this.failed.add(row.preferred)
    } else {
      outcome = await attempt(row.preferred)
      if (outcome === 'transport-failed') outcome = await attempt(row.preferred)
      // 只有批 URL 记进「已失败」：单资源没有回退，下一次导入仍可重试。
      if (outcome !== 'registered' && row.fallback !== undefined) this.failed.add(row.preferred)
    }
    if (outcome !== 'registered' && row.fallback !== undefined) outcome = await attempt(row.fallback)
    if (outcome !== 'registered') {
      throw new Error(`插件「${row.id}」取不回来：${result.failures.join('；')}`)
    }
    return result
  }
}
