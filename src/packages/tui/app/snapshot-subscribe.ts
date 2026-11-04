/**
 * TUI 快照存储：把「上游每个 delta 一次」的通知折成「一个窗口一次」的**取值**。
 *
 * 为什么需要（两笔账）：
 * 1. `transcript.invalidate()`（src/plugins/transcript.ts:54）是同步通知，TUI 又直接
 *    `useSyncExternalStore(runtime.subscribe, ...)` —— 队友流式跑起来时每个 text/
 *    reasoning delta 都要走一次 `forwardSubagent → transcript.emit → invalidate`
 *    （src/plugins/subagent.ts:459），也就是**一次全树 React reconcile**。三个队友叠
 *    起来就是几十次/秒（ink 只把终端写入限在 30fps，CPU 是花在 React 上的，所以照样卡）。
 *    桌面/远程早就有这道闸（host-stdio / remote 的 80ms 合并），TUI 是唯一没有的消费者。
 * 2. 光节流通知还不够：上游每次 invalidate 都会把快照缓存清掉，`getSnapshot()` 于是
 *    每次读都返回**新对象**；React 会在提交后的被动效果里复读一次做「快照有没有变」的
 *    一致性检查，读到新对象就再提交一帧。实测 60 次变更里通知只落了 3 次，提交却有 10 次。
 *    所以这个存储要在窗口内**冻结取值**：窗口里 React 读几次都拿到同一个引用。
 *
 * 语义（三条都不能丢）：
 * - **leading**：静默期后的第一个变更立刻取一次值——点一下、敲一句的响应不能等窗口；
 * - **trailing**：窗口内的后续变更攒到窗口末尾一次性取值——稳态提交次数 ≈ 1000/ms；
 * - **冻结**：两次取值之间 `getSnapshot()` 返回同一个引用，React 不会因为复读而重复提交。
 *
 * @module dsc-tui/app/snapshot-subscribe
 */
import { useMemo } from 'react'

/** 默认合并窗口：与桌面/远程同值（80ms ≈ 12.5 次/秒上限，肉眼仍连续）。 */
export const TUI_SNAPSHOT_MS = 80

export interface CoalesceOptions {
  /** 合并窗口毫秒；≤0 = 不合并（测试与排障用）。 */
  ms: number
  /** 时间源（测试注入假时钟）。 */
  now?: () => number
}

export interface CoalescedStore<T> {
  /** 交给 `useSyncExternalStore` 的 subscribe（多监听者共用一个窗口与一个定时器）。 */
  subscribe: (onStoreChange: () => void) => () => void
  /** 交给 `useSyncExternalStore` 的 getSnapshot（窗口内引用冻结）。 */
  getSnapshot: () => T
  /** 还有没有攒着没放出去的变更（探针用）。 */
  pending: () => boolean
}

/**
 * 把「上游的同步通知 + 每次都变的上游取值」折成「窗口一次的稳定取值」。
 *
 * @param readUpstream - 上游取值（如 `runtime.getSnapshot`）。
 * @param upstream - 上游 subscribe，返回退订函数。
 * @param options - 合并窗口与时间源。
 */
export function createCoalescedStore<T>(
  readUpstream: () => T,
  upstream: (listener: () => void) => () => void,
  options: CoalesceOptions,
): CoalescedStore<T> {
  const { ms } = options
  const now = options.now ?? Date.now
  const listeners = new Set<() => void>()
  let off: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 窗口内还有没放出去过的变更。 */
  let pending = false
  /** 上次放值的时刻（-Infinity = 从没放过，第一个变更走 leading）。 */
  let lastFlush = Number.NEGATIVE_INFINITY
  /** 冻结的取值：只有放值那一刻才换引用。 */
  let value: { current: T } | null = null

  /** 取一次上游值并换掉引用，然后通知下游。 */
  const publish = (): void => {
    value = { current: readUpstream() }
    lastFlush = now()
    pending = false
    for (const listener of [...listeners]) listener()
  }

  const flush = (): void => {
    timer = null
    if (!pending) return
    publish()
  }

  const cancelTimer = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  const onUpstreamChange = (): void => {
    const at = now()
    if (ms <= 0 || at - lastFlush >= ms) {
      // 静默期已过（或压根不合并）：立刻放值，窗口内的后续变更排到窗口末尾
      cancelTimer()
      publish()
      return
    }
    pending = true
    if (timer !== null) return
    timer = setTimeout(flush, Math.max(1, ms - (at - lastFlush)))
    // 攒着的窗口不许把进程吊住（TUI 退出路径要能立刻走）
    ;(timer as { unref?: () => void }).unref?.()
  }

  return {
    pending: () => pending,
    getSnapshot() {
      value ??= { current: readUpstream() }
      return value.current
    },
    subscribe(onStoreChange) {
      listeners.add(onStoreChange)
      if (off === null) off = upstream(onUpstreamChange)
      return () => {
        listeners.delete(onStoreChange)
        if (listeners.size > 0) return
        cancelTimer()
        pending = false
        const stop = off
        off = null
        stop?.()
      }
    },
  }
}

/**
 * 给 App 用的快捷封装：按 runtime 缓存的合并存储。
 *
 * @param runtime - 提供 `subscribe` / `getSnapshot` 的运行时（TUI 里就是 runtime 服务）。
 * @param ms - 合并窗口（测试注入 0 可以要一条直通路径做对照）。
 */
export function useCoalescedSnapshot<T>(
  runtime: { subscribe: (listener: () => void) => () => void; getSnapshot: () => T },
  ms = TUI_SNAPSHOT_MS,
): CoalescedStore<T> {
  return useMemo(
    () => createCoalescedStore(() => runtime.getSnapshot(), (l) => runtime.subscribe(l), { ms }),
    [runtime, ms],
  )
}
