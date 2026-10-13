/**
 * 装载器的「记账外壳」：把插件在 `apply` 期间做的槽位登记全部记账，卸载或重试时按账本
 * 逆序回滚。浏览器壳（`ui-shell/src/ui-renderer/boot.ts`）与终端壳（`src/ui/tui-plugins.ts`）共用
 * 这一份——装载语义两壳一致是契约的一部分。
 *
 * 为什么单独一个文件：类型收窄（D1）后，外壳的方法必须与注册表的公开重载**逐字同形**
 * （插件作者的调用点才是类型检查发生的地方），这份镜像放一处才不会两边漂移。
 *
 * @module dsc/ui/scoped-slots
 */
import type {
  FactoryDefinitionPropsOf,
  FactoryMapLike,
  SlotChildrenOf,
  SlotComponentLike,
  SlotKindOf,
  SlotMapLike,
  SlotPropsOf,
  SlotRegisterOptions,
  SlotFactoryRegisterOptions,
} from './slots.js'
import type { SlotRegistry } from './slots.js'
import type { UiSlotApi } from './plugin.js'
import type { SeatInstanceOf, StoreHandle } from './store.js'

/**
 * 给一个插件的槽位外壳。
 * @param slots - 壳的注册表
 * @param record - 记账函数：把一个退订动作挂到该插件的账本上（原样返回它）
 * @returns 插件看到的那一面（与 {@link UiSlotApi} 同形）
 */
export function createScopedSlotApi<C, M = SlotMapLike, FM = FactoryMapLike>(
  slots: SlotRegistry<C, M, FM>,
  record: (release: () => void) => () => void,
): UiSlotApi<C, M, FM> {
  return {
    get slots(): string[] {
      return slots.slots
    },
    spec: <K extends keyof M & string>(slot: K) => slots.spec(slot),
    declare: <K extends keyof M & string>(slot: K, kind: SlotKindOf<M, K>) => record(slots.declare(slot, kind)),
    register: <
      K extends keyof M & string,
      const D extends SlotChildrenOf<M> = Record<never, never>,
      H extends StoreHandle<any, any> | undefined = undefined,
    >(
      slot: K,
      options: SlotRegisterOptions<M, K, D, H>,
      component: C & SlotComponentLike<SlotPropsOf<M, K, D, H, FM>>,
    ) => record(slots.register(slot, options, component)),
    registerFactory: <F extends keyof FM & string>(
      options: SlotFactoryRegisterOptions<M, FM, F>,
      component: C & SlotComponentLike<FactoryDefinitionPropsOf<M, FM, F>>,
    ) => record(slots.registerFactory(options, component)),
    seat: <H extends StoreHandle<any, any>>(handle: H): SeatInstanceOf<H> | undefined => slots.seat(handle),
    injectSlot: <K extends keyof M & string>(slot: K, contribute: () => void | (() => void)) =>
      record(slots.injectSlot(slot, contribute)),
    entriesOf: (slot: string) => slots.entriesOf(slot),
    winners: (slot: string) => slots.winners(slot),
  }
}
