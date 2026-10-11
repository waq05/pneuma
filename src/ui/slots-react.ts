/**
 * 槽位注册表的 React 订阅面（两种壳共用：浏览器壳的 DOM 组件与终端壳的 ink 组件
 * 都是 React 组件，订阅逻辑只有一份）。
 *
 * 要点（与 ui-shell 的旧版一致，下沉到共享层是因为 TUI 壳要用同一份语义）：
 *
 *   1. `useSyncExternalStore` 的快照必须**引用稳定**，否则每次渲染都被判成「变了」，
 *      界面掉进无限重渲染。稳定性由注册表按槽保证（同一个槽版本没变就返回同一个数组），
 *      而订阅也是**按槽**的——别的槽登记新东西不该把这一块也叫醒。
 *
 * 渲染出口（SlotOutlet）不在这一份里：条目外层的包装是载体自己的事
 * （浏览器壳套 `<div class="slot-entry">` 供自检认块，终端壳套 ink 的 Box）。
 *
 * @module dsc/ui/slots-react
 */
import { useCallback, useSyncExternalStore } from 'react'
import type { SlotEntry, SlotFault } from './slots.js'
import type { SlotRegistry } from './slots.js'

/** 订阅一个槽里的登记（快照的引用稳定由注册表按槽版本保证）。 */
export function useSlot<C>(slots: SlotRegistry<C>, slot: string): readonly SlotEntry<C>[] {
  const subscribe = useCallback((onChange: () => void) => slots.subscribe(onChange, slot), [slots, slot])
  const snapshot = useCallback(() => slots.winners(slot), [slots, slot])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** 订阅壳记下的故障（诊断区用：哪个插件的哪一块崩了、崩在哪一步）。 */
export function useSlotFaults<C>(slots: SlotRegistry<C>): readonly SlotFault[] {
  const subscribe = useCallback((onChange: () => void) => slots.subscribe(onChange), [slots])
  const snapshot = useCallback(() => slots.faults, [slots])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
