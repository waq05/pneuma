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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SlotEntry, SlotFault } from './slots.js'
import type { SlotRegistry } from './slots.js'
import { SlotAssemblyError } from './slots.js'
import type { ActionsDecl, BakedActions, SeatInstance, SeatInstanceOf, SnapshotSelectorHook, StoreHandle } from './store.js'

/** 订阅一个槽里的登记（快照的引用稳定由注册表按槽版本保证）。 */
export function useSlot<C, M, FM>(slots: SlotRegistry<C, M, FM>, slot: string): readonly SlotEntry<C>[] {
  const subscribe = useCallback((onChange: () => void) => slots.subscribe(onChange, slot), [slots, slot])
  const snapshot = useCallback(() => slots.winners(slot), [slots, slot])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** 订阅壳记下的故障（诊断区用：哪个插件的哪一块崩了、崩在哪一步）。 */
export function useSlotFaults<C, M, FM>(slots: SlotRegistry<C, M, FM>): readonly SlotFault[] {
  const subscribe = useCallback((onChange: () => void) => slots.subscribe(onChange), [slots])
  const snapshot = useCallback(() => slots.faults, [slots])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/**
 * 读一个席位实例（selector + 可选相等判断，与 `useHostSelector` 同一手法）。
 *
 * 实例缺席（undefined——提供者还没装上、或已卸载）时返回 undefined，调用方据此决定
 * 要不要走本地回落（D3 的 status 面板就是这样用）。订阅随实例出现/消失切换：同一个
 * 组件在两个实例之间换源不需要重挂。
 */
export function useSeat<T extends object, A extends ActionsDecl<T>, S>(
  instance: SeatInstance<T, A> | undefined,
  selector: (state: T) => S,
  isEqual: (a: S, b: S) => boolean = Object.is,
): S | undefined {
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const equalRef = useRef(isEqual)
  equalRef.current = isEqual
  const [value, setValue] = useState<S | undefined>(() =>
    instance === undefined ? undefined : selector(instance.getSnapshot()),
  )
  const heldRef = useRef<S | undefined>(value)
  useEffect(() => {
    if (instance === undefined) {
      // 实例不在账上就把值清掉：不许静默画旧数据（与 dsh 的 StaleAuthorizationError 同一条精神）。
      if (heldRef.current !== undefined) {
        heldRef.current = undefined
        setValue(undefined)
      }
      return undefined
    }
    const read = (): void => {
      const next = selectorRef.current(instance.getSnapshot())
      if (heldRef.current !== undefined && equalRef.current(heldRef.current, next)) return
      heldRef.current = next
      setValue(next)
    }
    // 挂载时先对一次：订阅之前可能已经有写入。
    read()
    return instance.subscribe(read)
  }, [instance])
  return value
}

/**
 * 登记过席位的条目用：把实例的组件面（`useStore` + `actions`）拼好交给条目组件
 * （渲染出口在渲染时展开在 owner / 渲染能力之后）。
 *
 * 只在真有席位的条目里调用；`handle === null` 的条目拿空份额。有登记就意味着注册表
 * 持有这个席位——实例一定在账上（`seat()` 首次渲染读时懒建）。
 */
export function useSeatProps<T extends object, A extends ActionsDecl<T>>(
  slots: { seat<H extends StoreHandle<any, any>>(handle: H): SeatInstanceOf<H> | undefined },
  handle: StoreHandle<T, A> | null,
): { useStore: SnapshotSelectorHook<T>; actions: BakedActions<T, A> } | Record<string, never> {
  const instance = useMemo(
    () => (handle === null ? undefined : (slots.seat(handle) as SeatInstance<T, A> | undefined)),
    [slots, handle],
  )
  const useStore = useCallback(
    <S,>(selector: (state: T) => S, isEqual?: (a: S, b: S) => boolean): S =>
      // 内部擦除：登记过席位的条目实例一定存在（见函数文档）；返回类型由 PropsStoreOf 收窄。
      useSeat(instance, selector, isEqual) as S,
    [instance],
  )
  return useMemo(() => {
    if (handle === null) return NO_SEAT
    if (instance === undefined) {
      throw new SlotAssemblyError('席位的实例不在账上：登记的持有者还在，实例却已释放（装配错误）')
    }
    return { useStore, actions: instance.actions }
  }, [handle, instance, useStore])
}

/** 没有席位的条目共用的空份额（引用稳定，展开时不会让组件每帧换 props）。 */
const NO_SEAT: Record<string, never> = Object.freeze({})
