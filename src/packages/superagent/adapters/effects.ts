/**
 * 持久化的副作用队列（`effect` 表）：派工与输入投递不再放在内存数组里，进程崩在
 * 「已入队、还没执行」那一刻也不丢活。
 *
 * ## 为什么照上游 `app/effects.ts` 搬
 *
 * 上游把「要稍后做的事」统一记在 `effect` 表里，原因写在它的类型注释里：这些动作必须在
 * **调用方的写事务里入队**（与工单状态一起提交或一起回滚），而执行它们要在事务之外（建工作树、
 * 跑命令、发消息都是慢动作）。内存队列做不到前半句：`Tickets.create` 的事务回滚了，内存里
 * 那一项还在，恢复之后会派一张根本不存在的工单；反过来进程在提交后、派工前崩掉，那一项就没了。
 * SQLite 表两者都能守住，所以这里逐项照搬，而不是另发明一套「更简单」的队列。
 *
 * 移植时逐条对齐的语义（括号里是上游行号，`src/app/effects.ts`）：
 * - `enqueue` 用 `ON CONFLICT(kind,key)` 合并同一件事，`seq` 保留队列位置、`generation` 自增
 *   （39、61-66 行）：`generation` 是「这一行被替换过」的凭据，运行中的那一次收尾时带着旧
 *   generation，就删不掉新入队的那一行；
 * - `dispatch` 里 ordered 的 kind 只取队首一行，且**未到期也挡住后面的**（108-113 行）；
 * - `attempt` 的三条收尾规则（133-144 行）：成功删行；`stopped` 时保留行等重启重试；
 *   `Later` 只推后 due、不算失败；其他错误加 attempts、截断 error、指数退避；
 * - 所有 UPDATE/DELETE 都带 `kind/key/seq/generation` 四个条件，防运行中替换的行被覆盖。
 *
 * ## 与上游的三处差异
 *
 * 1. 本插件的 kind 只有 `launch` / `delivery` 两种：上游的 `assessment`、`relay`、`notice`、
 *    `reply` 在 DSC 各自有别的驱动（判定器同步规则、通知走 outbox），现在搬过来只会是死代码。
 * 2. 上游的 `Store` 有 `afterCommit`，本插件的 `DscStore` 没有。`cancel` 之后直接刷一次健康上报：
 *    它只读 COUNT，在调用方的事务里读也没有副作用，不值得为它给存储层加一套回调。
 * 3. 健康上报做成可选：`health` 不给就整个跳过。本插件的 doctor 是拉取式（`HealthCheck.run`），
 *    与上游的 `HealthBoard.claim` 推拉方向相反，适配层该放在装配处而不是领域队列里；这里只留
 *    上游那个 `claim(kind).set(entry)` 的窄口，谁接进来谁适配。另外 `Later` 那一支会把原因写进
 *    `error` 列（上游只改 due）：这条的读者只有「attempts ≥ 3 就报 error」，attempts 没加，
 *    所以不影响判据，但排查时能看到「它在等什么」。
 *
 * @module dsc/packages/superagent/adapters/effects
 */
import type { DatabaseSync } from 'node:sqlite'

/** 这个副作用现在跑不了（暂停、没空位），过 `retry[0]` 毫秒再来；**不算失败**，不加 attempts。 */
export class Later extends Error {}

/** 连续失败到几次就把这一 kind 的健康项标成 error（与上游同一阈值，也同来源轮询的阈值）。 */
export const FAILURES_BEFORE_ERROR = 3

/**
 * 每种副作用带的载荷。
 *
 * 只放**派工真正需要**的字段：`ticketId` 用来在执行时重读工单，`assignmentId` 用来确认
 * 「这次派工还是最新那份分配」。工单正文、标题这类会变的东西不进 payload——进快照就会过期。
 */
export interface EffectPayloads {
  /** 派一份待执行的分配；key 是分配 id（同一分配重复入队只会合并成一行）。 */
  launch: { ticketId: string; assignmentId: string }
  /** 把工单里没送达的输入递给正在跑的 worker；key 是工单 id。 */
  delivery: { ticketId: string }
}

/** 本插件用到的副作用种类。 */
export type EffectKind = keyof EffectPayloads

/** 一行待执行的副作用（`effect` 表的一行，只取队列要用的列）。 */
export interface EffectRow {
  key: string
  /** 载荷的 JSON 原文；执行时才 parse，坏 JSON 走「这次失败」那条路而不是让整个队列停摆。 */
  value: string
  /** 队列位置：只在入队时给一次，合并时不改。 */
  seq: number
  /** 载荷被替换过一次就加一；运行中的旧尝试据此放弃收尾。 */
  generation: number
  attempts: number
  /** 到期时刻（毫秒时间戳）；`dispatch` 只取 `due <= now` 的行。 */
  due: number
}

/**
 * 队列需要的存储窄口。
 *
 * 定义在这里而不是收整个 `DscStore`：队列只碰 `effect` 一张表，收窄之后包级测试可以用一个
 * 只实现这几个方法的假存储，也不必为了跑队列去开真库。真实的 `DscStore` 结构上满足它。
 *
 * 为什么还留一个裸 `handle`：上游的 `pending` / `cancel` / 「读最大 seq」是队列自己拼 SQL
 * （`effects.ts:58、76、80`），没走存储方法。这三条语句只有队列会用、也不会被别的写路径复用，
 * 原样搬过来比给存储层再开三个一次性方法更贴近上游。
 */
export interface EffectStore {
  /** `DscStore.handle`：同一个连接，队列自己的三句窄查询用它。 */
  readonly handle: DatabaseSync
  /** 入队 / 合并；必须在调用方的写事务里同步执行。 */
  enqueueEffect(kind: string, key: string, value: string, seq: number, due: number, since: string): void
  /** 非 ordered 的 kind：取 `due <= now` 的前 `limit` 行，按 seq。 */
  claimEffectRows(kind: string, now: number, limit: number): EffectRow[]
  /** ordered 的 kind：只取队首一行，**不看 due**（未到期也要挡住后面的）。 */
  claimOrderedEffectRow(kind: string): EffectRow | undefined
  /** 成功：删掉这一行（seq + generation 证明删的是自己跑的那一行）。 */
  finishEffect(kind: string, key: string, seq: number, generation: number): void
  /** 失败 / 推后：只改这一行。 */
  retryEffect(kind: string, key: string, seq: number, generation: number, attempts: number, error: string, due: number): void
  /** 健康上报用的计数；没有 health 的部署可以不给。 */
  countEffects?(kind: string): number
}

/** 健康项的一格；与上游 `HealthEntry.set` 同形（状态 + 一句话 + 时间）。 */
export interface EffectHealthEntry {
  set(entry: { state: 'ready' | 'error'; detail: string; at: string }): void
}

/**
 * 健康板子的窄口。
 *
 * 只要求 `claim(kind)`：上游的 `HealthBoard` 给每个 kind 一格，谁先登记谁拿。不要求它懂
 * EffectQueue 的任何事——这样队列本身不依赖 doctor 插件存不存在。
 */
export interface EffectHealth {
  claim(kind: string): EffectHealthEntry
}

/** `handle` 的四个选项；与上游同名同义，逐个见字段注释。 */
export interface EffectHandlerOptions {
  /** 现在最多能有几个在跑；0 = 先别跑（比如处理被暂停）。 */
  limit?: () => number
  /** 首次与最大退避毫秒数；失败后要等 `[0]`，之后翻倍到 `[1]` 为止。 */
  retry?: readonly [number, number]
  /** 一次只跑一个，按队列顺序；失败的那一个会挡住同 kind 后面的行。 */
  ordered?: boolean
  /**
   * 失败不在健康项上标 error（失败已经落到工单上时用，比如投递失败有 `ticket.delivery`）。
   *
   * 当前健康项只由 `dispatch` 自身抛错来置 error（`DscStore` 没有「最大 attempts」那条查询），
   * 所以这个开关暂时没有可观察的差别；留着是为了与上游的处理器选项逐项对齐，接上健康上报后生效。
   */
  quiet?: boolean
}

/** 执行器只需要「入队 + 登记处理器 + 催一拍」这三样；测试的内存版照这个口实现即可。 */
export interface EffectQueuePort {
  enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void
  handle<K extends EffectKind>(
    kind: K,
    run: (payload: EffectPayloads[K], key: string) => Promise<void>,
    options?: EffectHandlerOptions,
  ): void
  /** 下一拍派一次；由 `terminate` / `closeSession` 这类「名额刚让出来」的时刻调用。 */
  kick(): void
  /** 停新活、等正在跑的收尾；行留在表里（执行器 `dispose` 调用）。 */
  drain(): Promise<void>
}

/** 已登记的一个处理器；`run` 收 unknown 载荷，由 `attempt` 负责 parse。 */
interface Handler {
  run: (payload: unknown, key: string) => Promise<void>
  limit: () => number
  retry: readonly [number, number]
  ordered: boolean
  quiet: boolean
}

/** 一次在跑的尝试；`done` 只用于 `idle` / `drain` 等待，不向外抛错。 */
interface Task {
  kind: EffectKind
  key: string
  done: Promise<void>
}

/**
 * 持久化副作用队列。
 *
 * 生命周期与上游一致：`start()` 之前的行只躺在库里（装配没完成时不该动手），`drain()` 之后
 * 不再接新活、等跑完，行留在库里等下一次启动。中间由 `kick()` 排一个 microtask 去 `dispatch()`。
 */
export class EffectQueue implements EffectQueuePort {
  private readonly handlers = new Map<EffectKind, Handler>()
  private readonly entries = new Map<EffectKind, EffectHealthEntry>()
  private readonly tasks = new Set<Task>()
  /** 上一拍派工自己抛错的 kind；下一次派工成功时刷一次健康，把 error 改回 ready。 */
  private readonly broken = new Set<EffectKind>()
  /** 入队顺序号：只在内存里递增，构造时从库里的最大值接着数，重启后新行仍排在旧行之后。 */
  private seq: number
  private scheduled = false
  /** 只有 `start()` 到 `drain()` 之间才跑：装配没完成时排队的行不该动手。 */
  private started = false
  private stopped = false

  /**
   * @param store - 只碰 `effect` 表的窄口
   * @param health - 可选的健康板子；不给就跳过上报（理由见文件头第 3 条）
   * @param now - 当前毫秒时刻；测试注入假时钟，退避才能在用例里瞬移
   */
  constructor(
    private readonly store: EffectStore,
    private readonly health?: EffectHealth,
    private readonly now: () => number = () => Date.now(),
  ) {
    // 从库里的最大值接着数（上游 `effects.ts:58`）：重启后新入队的行仍排在旧行之后，
    // 否则 ordered 的 kind 会把新活插到还没跑完的旧活前面。
    const row = store.handle.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get()
    this.seq = Number(row?.seq ?? 0)
  }

  /**
   * 入队或合并一行，**同步**执行 SQL。
   *
   * 同步是硬要求：它会被 Engine 的写事务包住（`Tickets.create` 里就调 `executor.start`），
   * 异步落库会让「工单提交了、副作用没入队」这种半截状态重新出现。
   *
   * 合并规则照上游：同一 (kind,key) 覆盖 value、generation 加一、attempts 与 error 清零、
   * due 拉回现在。为什么 `seq` 不动：这一件事在队列里的先后位置不该因为又有人说了一遍就变。
   */
  enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void {
    const at = this.now()
    this.store.enqueueEffect(kind, key, JSON.stringify(payload), ++this.seq, at, new Date(at).toISOString())
    this.kick()
  }

  /**
   * 登记一个 kind 的处理器。
   *
   * 同一个 kind 重复登记直接抛错：两份处理器会让同一行被两条路各跑一遍，而且谁先谁后
   * 取决于装配顺序——这种错误在运行期极难查，不如在装配时就炸。
   */
  handle<K extends EffectKind>(
    kind: K,
    run: (payload: EffectPayloads[K], key: string) => Promise<void>,
    options: EffectHandlerOptions = {},
  ): void {
    if (this.handlers.has(kind)) throw new Error(`${kind} 这个副作用已经有处理器了`)
    const entry = this.health?.claim(kind)
    if (entry !== undefined) this.entries.set(kind, entry)
    const limit = options.limit ?? (() => 1)
    const retry = options.retry ?? ([2000, 60_000] as const)
    const ordered = options.ordered ?? false
    // ordered 的 kind 一次只能跑一个：并发两个就会打乱「队首没跑完、后面的不许动」这条规则。
    this.handlers.set(kind, {
      run: run as unknown as Handler['run'],
      limit: ordered ? () => Math.min(1, limit()) : limit,
      retry,
      ordered,
      quiet: options.quiet ?? false,
    })
    this.report(kind)
    this.kick()
  }

  /** 有没有这个 kind（给了 key 就是这一行）还在队列里（上游 `effects.ts:75-77` 同两句）。 */
  pending(kind: EffectKind, key?: string): boolean {
    return key === undefined
      ? this.store.handle.prepare('SELECT 1 FROM effect WHERE kind = ? LIMIT 1').get(kind) !== undefined
      : this.store.handle.prepare('SELECT 1 FROM effect WHERE kind = ? AND key = ?').get(kind, key) !== undefined
  }

  /**
   * 撤掉一行；已经在跑的那一次会正常收尾（它的 DELETE 带 generation，删不到就别删）。
   *
   * 这里没有上游的 `afterCommit`：删完直接刷健康。健康上报只读 COUNT，在调用方事务里读不会
   * 留下任何写入，也不影响回滚。
   */
  cancel(kind: EffectKind, key: string): void {
    this.store.handle.prepare('DELETE FROM effect WHERE kind = ? AND key = ?').run(kind, key)
    this.report(kind)
  }

  /** 允许派工；之前排队的行从这一刻起可以被取走。 */
  start(): void {
    this.started = true
    this.kick()
  }

  /** 排一个 microtask 派工；同一拍内多次调用只排一次（入队密集时不会反复扫表）。 */
  kick(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.dispatch()
    })
  }

  /**
   * 等到「没有这个 kind（或任何 kind）在跑，且现在没有能起来的行」。
   *
   * 循环而不是等一次：一次派工结束后可能让出名额，下一轮才有行能起来。
   */
  async idle(kind?: EffectKind): Promise<void> {
    for (;;) {
      this.dispatch()
      const running = [...this.tasks]
        .filter((task) => kind === undefined || task.kind === kind)
        .map((task) => task.done)
      if (running.length === 0) return
      await Promise.allSettled(running)
    }
  }

  /**
   * 停新活、等跑完；**行留在库里**，下一次 `start()` 接着跑。
   *
   * 这正是「宿主正常退出」与「进程崩掉」走同一条恢复路径的原因：两种情况下没跑完的行都在表里。
   */
  async drain(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.tasks].map((task) => task.done))
  }

  /**
   * 派一拍：每个 kind 各自取行、各自看名额。
   *
   * 与上游逐行一致，包括三个容易改错的细节：
   * 1. `running` 按 key 去重：同一行不会被并发跑两遍（入队合并时旧尝试还在跑）；
   * 2. ordered 的 kind 只取队首一行，而且**队首没到期也挡住后面的**——顺序语义靠这一条；
   * 3. `limit()` 只在 `ready` 非空时才问：暂停时那个回调可能同步读外部状态，空转时不必问。
   */
  dispatch(): void {
    if (!this.started || this.stopped) return
    for (const [kind, handler] of this.handlers) {
      try {
        const running = new Set(
          [...this.tasks].filter((task) => task.kind === kind).map((task) => task.key),
        )
        const rows = handler.ordered
          ? (() => {
              const row = this.store.claimOrderedEffectRow(kind)
              return row === undefined ? [] : [row]
            })()
          : this.store.claimEffectRows(kind, this.now(), 16 + running.size)
        const ready = handler.ordered && running.size > 0
          ? []
          : rows.filter((row) => row.due <= this.now() && !running.has(row.key))
        let room = ready.length > 0 ? handler.limit() - running.size : 0
        for (const row of ready) {
          if (room-- <= 0) break
          this.run(kind, handler, row)
        }
        if (this.broken.delete(kind)) this.report(kind)
      } catch (error) {
        this.failed(kind, error)
      }
    }
  }

  /** 起一次尝试；异常在这里吞掉并记进健康，绝不让一条坏行卡死整个泵。 */
  private run(kind: EffectKind, handler: Handler, row: EffectRow): void {
    const task: Task = { kind, key: row.key, done: Promise.resolve() }
    task.done = this.attempt(kind, handler, row)
      .catch((error: unknown) => {
        this.failed(kind, error)
      })
      .finally(() => {
        this.tasks.delete(task)
        this.kick()
      })
    this.tasks.add(task)
  }

  /**
   * 跑一次并收尾。
   *
   * 收尾的三条路与四个匹配条件是整个队列的安全边界，改任何一条都会出现「覆盖了别人的行」或
   * 「关掉时把没跑完的活删了」：
   * - 成功 → 删行；
   * - `stopped` → **什么都不做**：这一行还没执行完，留着让下次启动重试（关掉时删掉等于丢活）；
   * - `Later` → 只把 due 推后 `retry[0]`，不记失败（「现在没空位」不是这行的错）；
   * - 其他错误 → attempts+1、error 截 1000 字、due 推后 `min(最大退避, 首次 × 2^attempts)`。
   */
  private async attempt(kind: EffectKind, handler: Handler, row: EffectRow): Promise<void> {
    let failure: { error: unknown } | undefined
    try {
      await handler.run(JSON.parse(row.value) as never, row.key)
    } catch (error) {
      failure = { error }
    }
    // 四个条件一起匹配：运行期间这一行可能被重新入队（generation 变了）或被撤掉（行没了）。
    if (failure === undefined) {
      this.store.finishEffect(kind, row.key, row.seq, row.generation)
    } else if (this.stopped) {
      // 关停中：行原样留着，下一次 start 的第一拍会再取到它。
      return
    } else if (failure.error instanceof Later) {
      this.store.retryEffect(kind, row.key, row.seq, row.generation, row.attempts, String(failure.error).slice(0, 1000), this.now() + handler.retry[0])
    } else {
      const delay = Math.min(handler.retry[1], handler.retry[0] * 2 ** Math.min(row.attempts, 16))
      this.store.retryEffect(
        kind,
        row.key,
        row.seq,
        row.generation,
        row.attempts + 1,
        String(failure.error).slice(0, 1000),
        this.now() + delay,
      )
    }
    if (!this.stopped) this.report(kind)
  }

  /** 派工本身抛错（读表失败这类）：记进健康，下一拍再试。 */
  private failed(kind: EffectKind, error: unknown): void {
    this.broken.add(kind)
    this.entries.get(kind)?.set({
      state: 'error',
      detail: `副作用队列派工时抛错：${String(error)}`,
      at: new Date(this.now()).toISOString(),
    })
  }

  /**
   * 刷新一个 kind 的健康项：现在有几条在等。
   *
   * 上游还拿最大 attempts 判「连续失败三次就报 error」；`countEffects` 只给计数，这一条
   * 暂时不做（健康上报本身也没接进来）。接上时要把 counts 换成一条带 attempts 的查询。
   */
  private report(kind: EffectKind): void {
    const entry = this.entries.get(kind)
    if (entry === undefined) return
    const waiting = this.store.countEffects?.(kind) ?? 0
    entry.set({
      state: 'ready',
      detail: waiting > 0 ? `${String(waiting)} 条副作用在等` : '没有等待的副作用',
      at: new Date(this.now()).toISOString(),
    })
  }
}
