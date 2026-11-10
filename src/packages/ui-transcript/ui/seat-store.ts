/**
 * 座位注册表：按行的**稳定身份**索引，只把「内容真的变了」的那几行换掉。
 *
 * 为什么要有这一层（差距清单 S2 的彻底方案，2026-11-10）：
 * `ui.tsx` 每来一口 delta 都要重算座位（`live` 每帧是新引用），而 `buildSeats` 里的 `rowOf`
 * 返回对象字面量——**每一行都是新 `Row` 对象**。上一轮给行体包了个带比较器的 `memo` 止血，
 * 但那只省掉「行体函数体」；座位壳（`RowSeat` 里的两个 hook）与元素对账照旧每帧各跑一遍，
 * 而且全量锚帧（宿主每 50 帧发一次全量快照）会把每一行的 `entry` 引用换掉，memo 集体失效
 * 一次（实测 115 行同时重画）。
 *
 * 这一层做的事只有三条，但每条都得守住：
 *   1. **按身份索引**：键是 `keyOf(row, sessionKey)`——与 React 的 `key` 是同一个字符串
 *      （见 `shared.ts` 的 {@link keyOf}）。两处各算一份迟早就漂，所以这里直接调它。
 *   2. **内容等价就复用旧对象**：`entry` 引用相同、或**深度相等**（全量锚帧里那种「内容没变
 *      但对象重建」），且 `live` / `at` / `stable` 一致 → 这一帧继续用上一帧那个 `Row`。
 *      行体拿到的 props 因此引用不变，`memo` 与订阅两边都不会动它。
 *   3. **只通知变了的那几行**：`commit()` 里对比「这一帧的登记表」与「上一帧的登记表」，
 *      只对换过对象的键喊一声。订阅者（`useSeatRow`）因此是**逐行**重画的。
 *
 * 为什么 `stage` 在渲染里、`commit` 在 layout effect 里（两个阶段分开）：
 * - 行体必须在**自己渲染的那一刻**读到这一帧的数据（新挂载的尾行不能先画一帧空的），
 *   而它渲染在父组件之后——所以 `stage` 只把新表放进 `pending`，`getSnapshot` 优先读 pending；
 * - 已经挂载、这一帧被 `memo` 跳过的行需要一次通知；通知必须在**提交之后**发（渲染期间
 *   调 setState 会炸），所以 `commit` 摆在父组件的 `useLayoutEffect` 里。
 * - 新挂载的行在这一帧才 `subscribe`（`useSyncExternalStore` 在 passive effect 里订阅），
 *   它拿到的是 `pending` 里的新数据，因此**不会**被这次通知再打一枪——一次渲染，不多不少。
 *
 * 这个文件不 import React：注册表本体能在 Node 里直接跑（`scripts/ui-row-isolation-test.mjs`
 * 用它演算「深度相等复用 / 只通知变了的行 / 退订摘除」），订阅的胶水在 `render.tsx`。
 *
 * @module dsc-ui-shell/plugins/transcript/seat-store
 */
import type { Row } from './shared'

/** 注册表里的一格：这一行现在的数据。 */
interface SeatCell {
  row: Row
}

/**
 * 一帧要登记的行：前导段 + 各座位。
 *
 * 形状与 `shared.ts` 的 `buildSeats` 返回值对齐（只取它真正用到的两半），于是调用点不用
 * 先摊平成一个大数组再递进来——那一摊也是每帧一次分配。
 */
export interface SeatSource {
  leading: readonly Row[]
  rounds: readonly { rows: readonly Row[] }[]
}

/**
 * 一条行的键：`会话 + 行稳定身份`。
 *
 * 这个函数由调用方注入（`ui.tsx` 递的是 `shared.ts` 的 {@link keyOf}），**不在本文件里再写一份**：
 * 行的 React `key` 与注册表键必须是同一个字符串，两处各算一份迟早会漂。
 */
export type RowKeyOf = (row: Row, sessionKey: string) => string

export interface SeatStore {
  /**
   * 登记这一帧的座位（**渲染期**调，只写 pending，不通知）。
   *
   * @param sessionKey 行键的会话那一半（见 `keyOf`）
   * @param seats 当前要画的行（前导段也登记：它们同样按身份渲染，只是永远不藏）
   */
  stage(sessionKey: string, seats: SeatSource): void
  /** 提交换届并通知「行对象换了」的那几行（**layout effect** 里调）。 */
  commit(): void
  /** 一行现在该画的数据；没登记过给 undefined。 */
  row(key: string): Row | undefined
  /**
   * 订阅一行的变化。
   *
   * 退订由订阅方在卸载时执行（`useSyncExternalStore` 的 cleanup）：**摘除的是这一行的那一格
   * 订阅集合，集合空了连键一起删**，否则注册表会在一条长会话里越攒越多。
   */
  subscribe(key: string, listener: () => void): () => void
  /** 现役行数（诊断 / 探针读数）。 */
  size(): number
  /** 上一次 `commit` 通知了几行（诊断 / 探针读数）。 */
  lastChanged(): number
}

/**
 * 建一个注册表。
 *
 * 为什么不做成模块级单例：会话区可能出现两棵树（主对话流 + 团队页签的只读条目流，
 * 见 `subagent-flow.tsx`），两棵树的行键前缀不同、生命周期也不同；共用一份注册表等于
 * 让一边的卸载把另一边的行摘掉。
 *
 * @param keyOf 行键的算法（见 {@link RowKeyOf}）
 */
export function createSeatStore(keyOf: RowKeyOf): SeatStore {
  /** 上一帧现役的行（键 → 格）。 */
  let committed = new Map<string, SeatCell>()
  /** 这一帧刚登记、还没提交的行。 */
  let pending: Map<string, SeatCell> | null = null
  /** 逐行的订阅者（键 → 回调集合）。与 `committed` 分开存：`stage` 每帧重建格子，订阅不能跟着丢。 */
  const listeners = new Map<string, Set<() => void>>()
  let changed = 0

  /**
   * 这一帧该用哪个格子：内容等价就复用上一帧那一个（引用不变 = 行体不必重画）。
   *
   * 注意只跟 `committed` 比，不跟本次 `pending` 比：同一帧里 `stage` 可能被调两次
   * （React 严格模式的双次渲染），两次都必须收敛到同一个结果。
   */
  const accept = (key: string, row: Row): SeatCell => {
    const previous = committed.get(key)
    if (previous !== undefined && sameRow(previous.row, row)) return previous
    return { row }
  }

  return {
    stage(sessionKey, seats) {
      const next = new Map<string, SeatCell>()
      /** 登记一行：键是「会话 + 行的稳定身份」，值与上一帧内容等价时直接复用上一帧那一格。 */
      const register = (row: Row): void => {
        const key = keyOf(row, sessionKey)
        next.set(key, accept(key, row))
      }
      for (const row of seats.leading) register(row)
      for (const seat of seats.rounds) {
        for (const row of seat.rows) register(row)
      }
      pending = next
    },

    commit() {
      const next = pending
      if (next === null) return
      pending = null
      const touched: string[] = []
      for (const [key, cell] of next) {
        if (committed.get(key) !== cell) touched.push(key)
      }
      // 这一帧消失的行：把它们的订阅位一并摘掉。行体卸载时自己也会退订，这里是兜底
      // （渲染崩了、或整轮被分页切走时，cleanup 未必按顺序跑到）。
      for (const key of [...listeners.keys()]) {
        if (!next.has(key)) listeners.delete(key)
      }
      committed = next
      changed = touched.length
      for (const key of touched) {
        const set = listeners.get(key)
        if (set === undefined) continue
        for (const listener of [...set]) listener()
      }
    },

    row(key) {
      return (pending ?? committed).get(key)?.row
    },

    subscribe(key, listener) {
      const set = listeners.get(key) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(key, set)
      return () => {
        // 只摘自己那一格；集合空了连键删掉——这样注册表里不会留着上一帧的空壳。
        const current = listeners.get(key)
        if (current === undefined) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(key)
      }
    },

    size() {
      return committed.size
    },

    lastChanged() {
      return changed
    },
  }
}

/**
 * 两行算不算「同一行」：身份、位置、直播标记一致，且条目的**内容**没变。
 *
 * 为什么 `entry` 引用相同还不够：宿主每 50 帧（或 30 秒）发一次全量锚帧（见
 * `core/remote/frames.ts` 的 `FULL_ANCHOR_FRAMES`），那一帧里每条条目都是新对象、内容一字不差。
 * 只比引用的话，每来一次锚帧整屏 100 多行就要重画一遍；深度比一遍就全躲过去了。
 *
 * 为什么手写递归而不 `JSON.stringify` 对比：这一条会在一帧里被问上百次，字符串化每次都
 * 产生新的中间字符串，是拿垃圾换省事；这里只需要「同不同」，早退比序列化便宜得多。
 */
export function sameRow(previous: Row, next: Row): boolean {
  if (previous === next) return true
  if (previous.stable !== next.stable) return false
  if (previous.live !== next.live) return false
  // `at` 参与比较：它变化意味着历史分页/直播定稿让这一行换了下标，`Row` 对象必须换新的
  // （否则读到的是旧下标）。它不进 DOM，变的次数也极少（翻页、定稿那一拍）。
  if (previous.at !== next.at) return false
  return previous.entry === next.entry || sameContent(previous.entry, next.entry)
}

/**
 * 两份条目数据的**内容**是否一致（`===` 认引用，其余逐字段递归）。
 *
 * 条目是纯 JSON 数据（无函数、无循环引用、键序由同一段代码产出），所以逐字段比是安全的。
 * 数组按长度 + 逐项比；对象先比键数、再逐个键比——少一个键和多一个键都算不同
 * （条目里的可选字段是用条件展开加的，缺字段与「字段为 undefined」在 JSON 里本来就不一样）。
 */
export function sameContent(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!sameContent(left[index], right[index])) return false
    }
    return true
  }
  const before = left as Record<string, unknown>
  const after = right as Record<string, unknown>
  const keys = Object.keys(before)
  if (keys.length !== Object.keys(after).length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(after, key)) return false
    if (!sameContent(before[key], after[key])) return false
  }
  return true
}
