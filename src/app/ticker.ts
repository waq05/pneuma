/**
 * 共享节拍器：同一个周期的所有订阅者共用一个 `setInterval`。
 *
 * 为什么需要：ink 的每一帧提交（commit）都要跑一次整棵树的 yoga 布局 + 输出 diff，
 * 所以「有几个动画就有几个定时器」是纯粹的浪费——3 个跑动中的队友各自挂一个 120ms
 * 的 spinner 计时器，就是 25 次/秒的全树提交，而本该只有一个 8.3 次/秒的节拍。
 *
 * 用法：`const frame = useTick(120)` —— 只有订阅这个周期的组件重渲染，且**同周期只
 * 有一个计时器**。计时器在最后一个订阅者走掉时清掉（不占着进程）。
 *
 * @module dsc-tui/app/ticker
 */
import { useCallback, useSyncExternalStore } from 'react'

interface Clock {
  timer: ReturnType<typeof setInterval>
  listeners: Set<() => void>
  count: number
}

/** 周期 → 时钟（模块级：同一个周期全局一份）。 */
const clocks = new Map<number, Clock>()

const subscribeTick = (ms: number, listener: () => void): (() => void) => {
  let clock = clocks.get(ms)
  if (clock === undefined) {
    const created: Clock = { timer: undefined as unknown as ReturnType<typeof setInterval>, listeners: new Set(), count: 0 }
    created.timer = setInterval(() => {
      created.count += 1
      for (const entry of [...created.listeners]) entry()
    }, ms)
    // 攒着的节拍不许把进程吊住（TUI 退出路径要能立刻走）
    ;(created.timer as { unref?: () => void }).unref?.()
    clock = created
    clocks.set(ms, clock)
  }
  clock.listeners.add(listener)
  return () => {
    const current = clocks.get(ms)
    if (current === undefined) return
    current.listeners.delete(listener)
    if (current.listeners.size === 0) {
      clearInterval(current.timer)
      clocks.delete(ms)
    }
  }
}

/** 读节拍计数（时钟还没建起来时读作 0——不在这里创建时钟，渲染必须无副作用）。 */
const readTick = (ms: number): number => clocks.get(ms)?.count ?? 0

/**
 * 按周期取一个自增计数：值变了就说明该重渲染了。
 *
 * @param ms - 周期毫秒。
 * @param enabled - false 时不订阅（收工的卡停表，静默时一个计时器都不留）。
 */
export function useTick(ms: number, enabled = true): number {
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? subscribeTick(ms, listener) : () => {}),
    [ms, enabled],
  )
  const getSnapshot = useCallback(() => (enabled ? readTick(ms) : 0), [ms, enabled])
  return useSyncExternalStore(subscribe, getSnapshot)
}
