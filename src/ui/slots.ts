/**
 * 槽位注册表：界面上每一块「谁在什么位置放什么东西」由插件自己登记。
 *
 * 为什么要这一层（与 core/surface-registry.ts 同一套思路，但对象是**组件**不是数据）：
 * 原来界面是写死的——想加一个状态栏徽标就得改 App.tsx。有了注册表之后，
 * 界面壳只负责声明「我有这几个位置」，谁往里放、放什么由功能点自己决定；
 * 界面壳不认识任何具体功能。
 *
 * 刻意不依赖 React：同一份注册表要被两种壳复用（浏览器壳用 React 组件、
 * TUI 壳用 ink 组件），所以这里对「组件」只当作一个泛型 C，不 import 任何框架。
 *
 * 四条规则（前三条对齐 dsh 的 ui-slots 语义）：
 *   - **格子与遮蔽**：一种形态决定「什么算一个格子」——single 整个槽一个格子、
 *     list 每个 id 一个格子、keyed 每个 key 一个格子。同一个格子里可以合法地放多份，
 *     按 `priority` 小者胜（这叫遮蔽）；同格子同 priority 是装配错误，当场报错——
 *     两个插件抢同一个位置必须让作者自己说清谁赢，不能靠加载顺序偷偷决定。
 *   - **崩溃退位**：一个条目在渲染期抛异常，注册表把它标成坏的并从格子里剔掉，
 *     格子里的下一名顶上；坏掉的条目不会自己复活（要复活就重新注册）。
 *   - **往未声明的槽注册当场报错**，但可以用 `injectSlot` 说「等这个槽出现我再贡献」，
 *     于是插件之间不再需要靠加载顺序排依赖。
 *   - **chain：条目自己选举**。每条登记带一个 `select(owner)` 选择器，渲染时按
 *     priority 升序依次问（小者先试，同值按注册序），第一个**不返回 null** 的当选；
 *     全都弃权就落给渲染方的兜底。「谁负责展示这个工具调用」这类分派不再写死 if——
 *     内置渲染器与第三方渲染器在**同一条链**里按优先级竞争。chain 没有格子的概念，
 *     同 priority 允许多条并存（按注册序排队），register 也不做占用冲突检查。
 *
 * @module dsc/ui/slots
 */

/** 槽的四种形态：single/list/keyed 各管「几个格子」，chain 管「谁来渲染这一份」。 */
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'

/** 一条登记：某插件往某槽放了一个组件。 */
export interface SlotEntry<C> {
  /** 槽名（父级声明的那个 id）。 */
  slot: string
  /** 这条登记的稳定 id。 */
  id: string
  /** 排序权重，小的在前；相同则按注册先后。 */
  order: number
  /** 遮蔽权重，小的胜；同一个格子里 priority 相同就是冲突。 */
  priority: number
  /** keyed 槽的分格键；其它槽为 null。 */
  key: string | null
  /** 这条登记占的格子（single 恒为 ''，list 是 id，keyed 是 key）。 */
  cell: string
  /** 这条登记声明出来的子槽名（`renderSlot` 只认这几个名字）。 */
  children: readonly string[]
  /** chain 槽的选举选择器；其它形态为 null。 */
  select: ((owner: unknown) => unknown) | null
  /** 组件本身（浏览器壳里是 React 组件，TUI 壳里是 ink 组件）。 */
  component: C
  /** 注册序号：order 与 priority 都持平时的稳定次序。 */
  seq: number
}

/** 注册一条登记时要给的字段（component 单独传）。 */
export interface SlotRegisterOptions {
  id: string
  /** 缺省 0；list 槽里决定横向次序。 */
  order?: number
  /** 缺省 0；同一个格子里小者胜（遮蔽）。chain 槽里小者**先被问**（先试先当选）。 */
  priority?: number
  /** keyed 槽必填：这条登记负责哪个 key。 */
  key?: string
  /**
   * chain 槽必填：这条登记的选举选择器。渲染时拿到渲染方给的 owner 值，
   * 返回非 null 就当选（返回值原样交给组件的 `matched` prop），返回 null 表示
   * 「这单我不接，问下一位」。必须写成纯函数——只读 owner，不碰外部可变状态。
   */
  select?: (owner: unknown) => unknown
  /**
   * 这条登记自己开出来的子槽（槽名 → 形态）。
   *
   * 子槽是**全局名字**、按引用计数共享：一个 list 槽里的多条登记可以声明同名子槽，
   * 那个名字就成了「所有实例共用、每个实例各渲染一遍」的扩展点
   * （典型例子：`chat.message.footer` 由每条消息的渲染者声明，插件往里放一个按钮，
   * 于是每条消息都长出一个按钮）。同名不同形态照样报错。
   */
  children?: Readonly<Record<string, SlotKind>>
}

/** 一次插件故障（渲染期异常、贡献回调抛错、卸载回调抛错）。 */
export interface SlotFault {
  slot: string
  /** 出事的登记 id；贡献回调还没形成登记时是空串。 */
  id: string
  /** 出在哪个阶段。 */
  phase: 'render' | 'contribute' | 'dispose'
  error: Error
}

/** 往未声明的槽注册时抛这个：消息里带上已知槽名，省得去翻代码。 */
export class UndeclaredSlotError extends Error {
  constructor(slot: string, known: readonly string[]) {
    super(`槽位 ${slot} 没有被声明（已声明：${known.length === 0 ? '无' : known.join('、')}）`)
  }
}

/** 同一个槽被声明成两种形态时抛这个（两个功能点对同一个位置的期望不一致）。 */
export class SlotKindConflictError extends Error {
  constructor(slot: string, declared: SlotKind, wanted: SlotKind) {
    super(`槽位 ${slot} 已经声明成 ${declared}，不能再声明成 ${wanted}`)
  }
}

/** 同一个格子、同一个 priority 有两条登记时抛这个（谁赢必须由作者自己说清）。 */
export class DuplicateSlotError extends Error {
  constructor(slot: string, cell: string, priority: number, holder: string, incoming: string) {
    const where = cell === '' ? '这个槽' : `格子 ${cell}`
    super(
      `槽位 ${slot} 的${where}里已经有 ${holder}（priority ${String(priority)}）。` +
        `想替换它就把 ${incoming} 的 priority 调小（例如 ${String(priority - 1)}），或者换个 id。`,
    )
  }
}

/** keyed 槽没给 key 时抛这个：不给 key 就等于把整槽压成一个格子，静默丢东西。 */
export class KeyedSlotKeyError extends Error {
  constructor(slot: string) {
    super(`槽位 ${slot} 是 keyed 形态，register 必须给 key（决定这条登记负责哪一格）`)
  }
}

/** chain 槽的登记没给选择器时抛这个：没有选择器的条目永远无法当选，只能是死登记。 */
export class ChainSlotSelectError extends Error {
  constructor(slot: string) {
    super(`槽位 ${slot} 是 chain 形态，register 必须给 select（这条登记靠它参与选举）`)
  }
}

/** 一次选举的结果：当选的登记 + 选择器交回来的 matched 值。 */
export interface SlotElectResult<C> {
  entry: SlotEntry<C>
  /** 选择器的返回值原样透传（渲染层把它展开成组件的 `matched` prop）。 */
  matched: unknown
}

/**
 * 壳自己装配错了（子槽没声明、出口没在壳里）时抛这个。
 *
 * 与插件组件抛异常区分开：那种是「某个插件坏了，那一块不显示就行」；
 * 这种是「壳和插件的契约没对上」，必须炸出来，不能被降级成一句界面文案。
 */
export class SlotAssemblyError extends Error {}

/** 等一个槽声明出来用的登记位。 */
interface Waiter {
  contribute: () => void | (() => void)
  /** 已经贡献过（防重复跑）。 */
  ran: boolean
  /** 贡献时拿到的退订函数。 */
  dispose: (() => void) | null
}

/** 订阅者：`slot` 为 null 表示关心所有槽的变化（诊断区用）。 */
interface Listener {
  slot: string | null
  fn: () => void
}

/**
 * 槽位注册表本体。
 *
 * @typeParam C - 组件类型。浏览器壳传 React 组件类型，TUI 壳传 ink 组件类型。
 */
export class SlotRegistry<C = unknown> {
  /** 已声明的槽：名字 → 形态 + 引用计数（引用计数让子槽可以被多份登记共享）。 */
  private readonly kinds = new Map<string, { kind: SlotKind; refs: number }>()
  private readonly entries = new Map<string, SlotEntry<C>[]>()
  /** 渲染期崩过、已经退位的登记（不复活，重新注册才是一次新的机会）。 */
  private readonly broken = new Set<SlotEntry<C>>()
  private readonly listeners = new Set<Listener>()
  /** 最近几十条故障（每次追加都换一个新数组，诊断区才能靠引用变化重渲染）。 */
  private faultLog: SlotFault[] = []
  private readonly faultListeners = new Set<(fault: SlotFault) => void>()
  /** 等槽声明的贡献者（槽一出现就跑，槽一消失就撤）。 */
  private readonly waiters = new Map<string, Set<Waiter>>()
  /**
   * `winners()` 的缓存，每个槽各自记下「算的时候那个槽的版本号」。
   *
   * 为什么要缓存：React 的 `useSyncExternalStore` 要求「没变就返回同一个引用」，
   * 而 winners 每次都要新建数组（遮掉被顶掉的条目）。
   * 为什么按槽记版本：一次登记只该让**那一个槽**的快照换引用。要是全局清缓存，
   * 每个出口都会被判成「变了」，一次登记就放大成整页重渲染。
   */
  private readonly winnersCache = new Map<string, { version: number; list: readonly SlotEntry<C>[] }>()
  /** 每个槽各自的单调版本号（React 那边拿它当 useSyncExternalStore 的快照）。 */
  private readonly versions = new Map<string, number>()
  private globalVersion = 0
  private seq = 0

  /**
   * 声明一个槽（界面壳在加载任何插件之前声明自己有哪些位置）。
   *
   * 同一个名字、同一种形态重复声明是合法的（引用计数 +1），
   * 这样多个条目可以把自己的子槽声明成同一个共享扩展点。
   * @param slot - 槽名，约定用「区域.位置」形状，例如 `shell.main`、`statusbar.right`
   * @param kind - 这个位置能容纳几份
   * @returns 撤回这一次声明的函数（计数归零时，连带清掉槽里的登记与等待者）
   */
  declare(slot: string, kind: SlotKind): () => void {
    const existing = this.kinds.get(slot)
    if (existing !== undefined) {
      if (existing.kind !== kind) throw new SlotKindConflictError(slot, existing.kind, kind)
      existing.refs += 1
    } else {
      this.kinds.set(slot, { kind, refs: 1 })
      this.runWaiters(slot)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.kinds.get(slot)
      if (current === undefined) return
      current.refs -= 1
      if (current.refs > 0) return
      this.kinds.delete(slot)
      this.entries.delete(slot)
      this.suspendWaiters(slot)
      this.bump(slot)
    }
  }

  /**
   * 等一个槽声明出来再贡献（插件之间不必靠加载顺序排依赖）。
   *
   * 槽每次被声明都会跑一遍 `contribute`；槽被撤回时，`contribute` 交回来的
   * 退订函数会被调用。于是「先加载的插件给后声明的槽加东西」不再失败。
   * @param slot - 要等的槽名
   * @param contribute - 槽存在时的贡献动作，可返回退订函数
   * @returns 撤回这次等待（连带撤掉已经做出的贡献）
   */
  injectSlot(slot: string, contribute: () => void | (() => void)): () => void {
    const waiter: Waiter = { contribute, ran: false, dispose: null }
    const set = this.waiters.get(slot) ?? new Set<Waiter>()
    set.add(waiter)
    this.waiters.set(slot, set)
    if (this.kinds.has(slot)) this.runWaiter(slot, waiter)
    return () => {
      set.delete(waiter)
      if (set.size === 0) this.waiters.delete(slot)
      this.suspendWaiter(slot, waiter)
    }
  }

  /**
   * 往一个已声明的槽里登记组件。
   * @param slot - 槽名
   * @param options - 登记 id、排序与遮蔽权重
   * @param component - 组件
   * @returns 退订函数；插件卸载时调用，界面下一帧就没有它了
   * @throws {UndeclaredSlotError} 槽没声明（想等它出现就用 `injectSlot`）
   * @throws {KeyedSlotKeyError} keyed 槽没给 key
   * @throws {DuplicateSlotError} 同格子同 priority 已经被占
   */
  register(slot: string, options: SlotRegisterOptions, component: C): () => void {
    const spec = this.kinds.get(slot)
    if (spec === undefined) throw new UndeclaredSlotError(slot, this.slots)
    const key = spec.kind === 'keyed' ? options.key : null
    if (spec.kind === 'keyed' && (key === undefined || key === '')) throw new KeyedSlotKeyError(slot)
    if (spec.kind === 'chain' && options.select === undefined) throw new ChainSlotSelectError(slot)
    const priority = options.priority ?? 0
    // chain 没有格子的概念（每条登记都是独立的候选人），也不做占用冲突检查——
    // 同 priority 并存是合法的，选举时按注册序排队。
    const cell = spec.kind === 'chain' ? '' : spec.kind === 'list' ? options.id : spec.kind === 'keyed' ? (key as string) : ''
    const list = this.entries.get(slot) ?? []
    const clash = spec.kind === 'chain' ? undefined : list.find((entry) => entry.cell === cell && entry.priority === priority)
    if (clash !== undefined) throw new DuplicateSlotError(slot, cell, priority, clash.id, options.id)
    const releases = this.declareChildren(options.children)
    const entry: SlotEntry<C> = {
      slot,
      id: options.id,
      order: options.order ?? 0,
      priority,
      key: key ?? null,
      cell,
      children: Object.keys(options.children ?? {}),
      select: options.select ?? null,
      component,
      seq: this.seq,
    }
    this.seq += 1
    this.entries.set(slot, [...list, entry].sort(compareEntries))
    this.bump(slot)
    return () => {
      const current = this.entries.get(slot)
      if (current !== undefined) {
        const filtered = current.filter((candidate) => candidate !== entry)
        if (filtered.length !== current.length) {
          this.entries.set(slot, filtered)
          this.broken.delete(entry)
          this.bump(slot)
        }
      }
      for (const release of releases) release()
    }
  }

  /**
   * 让一个 chain 槽为这份 owner 值选出渲染者。
   *
   * 按 priority 升序逐个问选择器（同 priority 按注册序），第一个不返回 null 的当选；
   * 选择器抛异常视同弃权（记一条故障，链继续走——一个坏选择器不该烧掉整条链）；
   * 全部弃权（或槽里没有幸存者）返回 null，渲染方画自己的兜底。
   * @param slot - chain 形态的槽名
   * @param owner - 渲染位置的上下文（例如「这一条工具调用」），原样交给选择器
   * @throws {Error} 槽不是 chain 形态时抛装配错误（选举只对 chain 有意义）
   */
  elect(slot: string, owner: unknown): SlotElectResult<C> | null {
    if (this.kinds.get(slot)?.kind !== 'chain') {
      throw new SlotAssemblyError(`槽位 ${slot} 不是 chain 形态（elect 只对 chain 有意义）`)
    }
    const list = [...(this.entries.get(slot) ?? EMPTY)].sort(compareChain)
    for (const entry of list) {
      if (this.broken.has(entry)) continue
      try {
        const select = entry.select
        const matched = select === null ? null : select(owner)
        if (matched !== null && matched !== undefined) return { entry, matched }
      } catch (error) {
        // 选择器是登记作者写的纯函数，抛了说明它有 bug：记一条故障让它退位，
        // 然后照常问下一位——不因为一个坏选择器把整条链废掉。
        this.broken.add(entry)
        this.record({ slot, id: entry.id, phase: 'render', error: toError(error) })
        this.bump(slot)
      }
    }
    return null
  }

  /**
   * 报一个条目的渲染期故障：这个条目退位，格子里的下一名顶上。
   * @param entry - 出事的那条登记（组件拿到的就是它，所以身份是准的）
   * @param error - 异常
   */
  reportFault(entry: SlotEntry<C>, error: unknown): void {
    if (this.broken.has(entry)) return
    this.broken.add(entry)
    this.record({ slot: entry.slot, id: entry.id, phase: 'render', error: toError(error) })
    this.bump(entry.slot)
  }

  /** 订阅故障（壳把最近几条画在诊断区，线上排错不必靠用户截图）。 */
  onFault(handler: (fault: SlotFault) => void): () => void {
    this.faultListeners.add(handler)
    return () => {
      this.faultListeners.delete(handler)
    }
  }

  /** 目前攒下的故障（诊断区用）。 */
  get faults(): readonly SlotFault[] {
    return this.faultLog
  }

  /** 已声明的槽名（按声明顺序，诊断与报错消息用）。 */
  get slots(): string[] {
    return [...this.kinds.keys()]
  }

  /** 某个槽的形态；没声明过给 undefined。 */
  spec(slot: string): SlotKind | undefined {
    return this.kinds.get(slot)?.kind
  }

  /** 某个槽里的全部登记（含被遮蔽的与被退位的，诊断用）。 */
  entriesOf(slot: string): readonly SlotEntry<C>[] {
    return this.entries.get(slot) ?? EMPTY
  }

  /**
   * 渲染一个槽时该画哪几条：每个格子取一名幸存者，再按 order 排显示序。
   *
   * 返回值在这个槽的版本号不变时引用稳定，可以直接当 `useSyncExternalStore` 的快照。
   * @param slot - 槽名
   */
  winners(slot: string): readonly SlotEntry<C>[] {
    const version = this.versions.get(slot) ?? 0
    const cached = this.winnersCache.get(slot)
    if (cached !== undefined && cached.version === version) return cached.list
    const kind = this.kinds.get(slot)?.kind
    const list = !this.kinds.has(slot)
      ? EMPTY
      : kind === 'chain'
        ? // chain 没有「每格一名」的遮蔽语义：诊断与订阅都看**全部幸存候选人**，
          // 按（priority，注册序）排——这正是 elect 逐个问的顺序。
          [...(this.entries.get(slot) ?? EMPTY)].filter((entry) => !this.broken.has(entry)).sort(compareChain)
        : deriveWinners(this.entries.get(slot) ?? EMPTY, this.broken)
    this.winnersCache.set(slot, { version, list })
    return list
  }

  /**
   * 某个槽的单调版本号。
   *
   * 为什么不用「winners 数组」当 useSyncExternalStore 的快照：那要求注册表保证
   * 引用稳定，一次登记就得把所有槽的缓存清掉（一个槽的变化会放大成整个界面的重渲染）。
   * 版本号是标量，比较便宜，而且内容在渲染体里现读（读的时候一定是新的）。
   */
  version(slot: string): number {
    return this.versions.get(slot) ?? 0
  }

  /** 全局单调版本号（诊断区那种「关心所有槽」的订阅者用）。 */
  getVersion(): number {
    return this.globalVersion
  }

  /**
   * 订阅登记变化。
   * @param listener - 变化回调
   * @param slot - 只关心这个槽；不传表示关心所有槽
   * @returns 退订函数
   */
  subscribe(listener: () => void, slot?: string): () => void {
    const record: Listener = { slot: slot ?? null, fn: listener }
    this.listeners.add(record)
    return () => {
      this.listeners.delete(record)
    }
  }

  /** 注册总数（诊断面板用）。 */
  get size(): number {
    let total = 0
    for (const list of this.entries.values()) total += list.length
    return total
  }

  /** 这个槽里有没有已被退位的条目（诊断面板标红用）。 */
  brokenCount(slot: string): number {
    let total = 0
    for (const entry of this.entries.get(slot) ?? []) if (this.broken.has(entry)) total += 1
    return total
  }

  /** 按 children 声明表把子槽开出来，返回一批退订函数。 */
  private declareChildren(children: Readonly<Record<string, SlotKind>> | undefined): (() => void)[] {
    if (children === undefined) return []
    const releases: (() => void)[] = []
    for (const [name, kind] of Object.entries(children)) releases.push(this.declare(name, kind))
    return releases
  }

  /** 槽刚被声明：把所有等待者跑一遍。 */
  private runWaiters(slot: string): void {
    const set = this.waiters.get(slot)
    if (set === undefined) return
    for (const waiter of [...set]) this.runWaiter(slot, waiter)
  }

  /** 跑一个等待者的贡献动作（已经跑过就不重复跑）。 */
  private runWaiter(slot: string, waiter: Waiter): void {
    if (waiter.ran) return
    waiter.ran = true
    try {
      const result = waiter.contribute()
      waiter.dispose = typeof result === 'function' ? result : null
    } catch (error) {
      this.record({ slot, id: '', phase: 'contribute', error: toError(error) })
    }
  }

  /** 槽被撤回：把所有等待者已经做出的贡献撤掉（等待关系留着，槽回来再贡献）。 */
  private suspendWaiters(slot: string): void {
    const set = this.waiters.get(slot)
    if (set === undefined) return
    for (const waiter of [...set]) this.suspendWaiter(slot, waiter)
  }

  /** 撤掉一个等待者的贡献。 */
  private suspendWaiter(slot: string, waiter: Waiter): void {
    if (!waiter.ran) return
    waiter.ran = false
    const dispose = waiter.dispose
    waiter.dispose = null
    if (dispose === null) return
    try {
      dispose()
    } catch (error) {
      this.record({ slot, id: '', phase: 'dispose', error: toError(error) })
    }
  }

  /** 版本号 +1，然后通知关心这个槽（以及关心所有槽）的订阅者。 */
  private bump(slot: string): void {
    this.versions.set(slot, (this.versions.get(slot) ?? 0) + 1)
    this.globalVersion += 1
    for (const listener of [...this.listeners]) {
      if (listener.slot !== null && listener.slot !== slot) continue
      try {
        listener.fn()
      } catch (error) {
        // 一个订阅者炸了不该拖垮其它订阅者，但也不能静默——多半是渲染异常，要有迹可循。
        console.error(`槽位 ${slot} 的订阅者抛异常：`, error)
      }
    }
  }

  /** 记一条故障并广播给监督者。 */
  private record(fault: SlotFault): void {
    this.faultLog = [...this.faultLog, fault].slice(-50)
    for (const handler of [...this.faultListeners]) {
      try {
        handler(fault)
      } catch (error) {
        console.error('槽位故障监听器抛异常：', error)
      }
    }
  }
}

/** 空列表常量：没登记的槽共享同一个引用。 */
const EMPTY: readonly never[] = Object.freeze([])

/**
 * 由登记表算出「这个槽该画哪几条」。
 *
 * 每个格子取一名幸存者：priority 小的胜（遮蔽），同 priority 不可能同时存在
 * （注册时就报错了）；被退位的条目直接跳过。最后按 order 排显示序。
 */
function deriveWinners<C>(
  list: readonly SlotEntry<C>[],
  broken: ReadonlySet<SlotEntry<C>>,
): readonly SlotEntry<C>[] {
  if (list.length === 0) return EMPTY
  const byCell = new Map<string, SlotEntry<C>>()
  for (const entry of list) {
    if (broken.has(entry)) continue
    const held = byCell.get(entry.cell)
    if (held === undefined || compareShadow(entry, held) < 0) byCell.set(entry.cell, entry)
  }
  if (byCell.size === 0) return EMPTY
  return [...byCell.values()].sort(compareEntries)
}

/** 显示序：order 小的在前；持平时按注册序号。 */
function compareEntries<C>(a: SlotEntry<C>, b: SlotEntry<C>): number {
  return a.order === b.order ? a.seq - b.seq : a.order - b.order
}

/** 遮蔽序：priority 小者胜；持平时 order 小的在前，再持平按注册序号。 */
function compareShadow<C>(a: SlotEntry<C>, b: SlotEntry<C>): number {
  if (a.priority !== b.priority) return a.priority - b.priority
  return compareEntries(a, b)
}

/** 选举序：priority 小者先被问；持平时注册早的先被问。 */
function compareChain<C>(a: SlotEntry<C>, b: SlotEntry<C>): number {
  return a.priority === b.priority ? a.seq - b.seq : a.priority - b.priority
}

/** 把抛出来的东西收敛成 Error（JS 里可以 throw 任何值）。 */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
