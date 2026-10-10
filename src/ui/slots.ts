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
 * 与 dsh 的 ui-slots 对齐的三条：
 *   - 槽分四种：single（一个占据者）/ list（有序多份）/ keyed（按 key 分发）；
 *     第四种 chain（条目自己选举）暂不需要，用到再加；
 *   - 注册返回退订函数，插件卸载后下一帧就没了（可回滚，cordis 的效果语义）；
 *   - 往未声明的槽注册**当场报错**：拼错槽名是老半天查不出来的那种 bug。
 *
 * @module dsc/ui/slots
 */

/** 槽的四种形态里目前实现的三种。 */
export type SlotKind = 'single' | 'list' | 'keyed'

/** 一条登记：某插件往某槽放了一个组件。 */
export interface SlotEntry<C> {
  /** 槽名（父级声明的那个 id）。 */
  slot: string
  /** 这条登记的稳定 id（同一个槽里同名 = 后注册者顶掉先注册者）。 */
  id: string
  /** 排序权重，小的在前；相同则按注册先后。 */
  order: number
  /** keyed 槽的分格键；其它槽为 null。 */
  key: string | null
  /** 组件本身（浏览器壳里是 React 组件，TUI 壳里是 ink 组件）。 */
  component: C
  /** 注册序号：order 持平时的稳定次序，界面不会莫名重排。 */
  seq: number
}

/** 注册一条登记时要给的字段（component 单独传）。 */
export interface SlotRegisterOptions {
  id: string
  /** 缺省 0。 */
  order?: number
  /** 只有 keyed 槽需要。 */
  key?: string
}

/** 往未声明的槽注册时抛这个：消息里带上已知槽名，省得去翻代码。 */
export class UndeclaredSlotError extends Error {
  constructor(slot: string, known: readonly string[]) {
    super(`槽位 ${slot} 没有被声明（已声明：${known.length === 0 ? '无' : known.join('、')}）`)
  }
}

/** 同一个槽里重复的 id 抛这个（两条登记抢同一个位置，是装配错误不是运行时状况）。 */
export class DuplicateSlotIdError extends Error {
  constructor(slot: string, id: string) {
    super(`槽位 ${slot} 里的 id ${id} 已经被占用`)
  }
}

/**
 * 槽位注册表本体。
 *
 * @typeParam C - 组件类型。浏览器壳传 React 组件类型，TUI 壳传 ink 组件类型。
 */
export class SlotRegistry<C = unknown> {
  private readonly kinds = new Map<string, SlotKind>()
  private readonly entries = new Map<string, SlotEntry<C>[]>()
  private readonly listeners = new Set<() => void>()
  /**
   * `winners()` 的结果缓存。
   *
   * React 的 useSyncExternalStore 要求「没变就返回同一个引用」，而 winners 对
   * single/keyed 两种槽每次都要**建新数组**（切掉多余的条目）。不缓存的话每次
   * 取快照都是新引用，界面会掉进无限重渲染。任何登记变化时整表清掉即可：
   * 这个缓存只服务「一拍之内重复取」这一种情况。
   */
  private readonly winnersCache = new Map<string, readonly SlotEntry<C>[]>()
  private version = 0
  private seq = 0

  /**
   * 声明一个槽（界面壳在加载任何插件之前声明自己有哪些位置）。
   * @param slot - 槽名，约定用「区域.位置」形状，例如 `shell.main`、`statusbar.right`
   * @param kind - 这个位置能容纳几份
   * @returns 撤回声明的函数（连带清掉这个槽里的登记）
   */
  declare(slot: string, kind: SlotKind): () => void {
    if (this.kinds.has(slot)) throw new Error(`槽位 ${slot} 被声明了两次`)
    this.kinds.set(slot, kind)
    this.version += 1
    this.winnersCache.clear()
    this.notify()
    return () => {
      if (!this.kinds.delete(slot)) return
      this.entries.delete(slot)
      this.version += 1
      this.winnersCache.clear()
      this.notify()
    }
  }

  /**
   * 往一个已声明的槽里登记组件。
   * @param slot - 槽名
   * @param options - 登记 id 与排序
   * @param component - 组件
   * @returns 退订函数；插件卸载时调用，界面下一帧就没有它了
   */
  register(slot: string, options: SlotRegisterOptions, component: C): () => void {
    if (!this.kinds.has(slot)) throw new UndeclaredSlotError(slot, this.slots)
    const kind = this.kinds.get(slot) as SlotKind
    const list = this.entries.get(slot) ?? []
    if (list.some((entry) => entry.id === options.id)) throw new DuplicateSlotIdError(slot, options.id)
    const entry: SlotEntry<C> = {
      slot,
      id: options.id,
      order: options.order ?? 0,
      key: kind === 'keyed' ? options.key ?? '' : null,
      component,
      seq: this.seq,
    }
    this.seq += 1
    const next = [...list, entry].sort(compareEntries)
    this.entries.set(slot, next)
    this.version += 1
    this.winnersCache.clear()
    this.notify()
    return () => {
      const current = this.entries.get(slot)
      if (current === undefined) return
      const filtered = current.filter((candidate) => candidate !== entry)
      if (filtered.length === current.length) return
      this.entries.set(slot, filtered)
      this.version += 1
      this.winnersCache.clear()
      this.notify()
    }
  }

  /** 已声明的槽名（按声明顺序，诊断与报错消息用）。 */
  get slots(): string[] {
    return [...this.kinds.keys()]
  }

  /** 某个槽的形态；没声明过给 undefined。 */
  spec(slot: string): SlotKind | undefined {
    return this.kinds.get(slot)
  }

  /** 某个槽里的全部登记（已按 order + 注册序排好）。 */
  entriesOf(slot: string): readonly SlotEntry<C>[] {
    return this.entries.get(slot) ?? EMPTY
  }

  /**
   * 渲染一个槽时该画哪几条。
   *
   * single 只取第一条、keyed 每格取第一条（同格的后来者压不过先来的：先注册的是
   * 更具体的实现，与 dsh 的 shadowing 同一套语义）；list 全要。
   * @param slot - 槽名
   * @returns 该画的登记（list 传引用，可直接喂给 useSyncExternalStore）
   */
  winners(slot: string): readonly SlotEntry<C>[] {
    const cached = this.winnersCache.get(slot)
    if (cached !== undefined) return cached
    const list = this.entriesOf(slot)
    const kind = this.kinds.get(slot)
    const result = deriveWinners(list, kind)
    this.winnersCache.set(slot, result)
    return result
  }

  /** 单调版本号：React 那边用它做 useSyncExternalStore 的快照。 */
  getVersion(): number {
    return this.version
  }

  /** 订阅登记变化；返回退订函数。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 注册总数（诊断面板用）。 */
  get size(): number {
    let total = 0
    for (const list of this.entries.values()) total += list.length
    return total
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // 一个订阅者炸了不该拖垮其它订阅者（回调里通常就是 setState）
      }
    }
  }
}

/** 空列表常量：没登记的槽共享同一个引用，省得 React 每次看到新数组。 */
const EMPTY: readonly never[] = Object.freeze([])

/** order 小的在前；持平时按注册序号。 */
function compareEntries<C>(a: SlotEntry<C>, b: SlotEntry<C>): number {
  return a.order === b.order ? a.seq - b.seq : a.order - b.order
}

/**
 * 由登记表算出「这个槽该画哪几条」。
 *
 * list 原样返回（引用稳定，可以直接当 useSyncExternalStore 的快照）；
 * single 只留第一条；keyed 每格留第一条——同格的后来者压不过先来的，
 * 与 dsh 的 shadowing 同一套语义（先注册的是更具体的实现）。
 */
function deriveWinners<C>(list: readonly SlotEntry<C>[], kind: SlotKind | undefined): readonly SlotEntry<C>[] {
  if (kind === 'list' || kind === undefined) return list
  if (kind === 'single') return list.length === 0 ? EMPTY : [list[0] as SlotEntry<C>]
  const seen = new Set<string>()
  const out: SlotEntry<C>[] = []
  for (const entry of list) {
    const key = entry.key ?? ''
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}
