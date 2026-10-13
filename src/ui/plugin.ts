/**
 * 界面插件的契约：第三方与内置插件写的是同一份东西。
 *
 * 一个界面插件就是一个 JS bundle + 一次 `apply(ui)` 调用。它拿到的 `ui`
 * 上有槽位注册表（往界面上放组件）和宿主身份（要显示版本号之类的用），
 * 没有别的——网络、会话、宿主的 RPC 都**不**从这里给，那属于壳自己的事。
 *
 * 为什么不给插件任意 import 权限：界面代码跑在渲染进程里，能调宿主暴露的全部方法；
 * 所以加载器只放行白名单模块（react / react-dom / @dsc/ui），其余 require 直接抛。
 *
 * @module dsc/ui/plugin
 */
import type { HostSnapshot } from './frames.js'
import type {
  FactoryDefinitionPropsOf,
  FactoryMapLike,
  SlotChildrenOf,
  SlotComponentLike,
  SlotEntry,
  SlotFactoryRegisterOptions,
  SlotKindOf,
  SlotMapLike,
  SlotPropsOf,
  SlotRegisterOptions,
} from './slots.js'
import type { SeatInstanceOf, StoreHandle } from './store.js'
import type { ServiceRegistry } from './services.js'
import type { UiPlatform } from './manifest.js'

/** 界面要显示的宿主身份。 */
export interface UiHostInfo {
  /** 产品的显示名，例如 `Muse Code`。 */
  name: string
  /** 宿主版本，例如 `0.6.67`。 */
  version: string
  /**
   * 装载这个插件的载体（阶段 6 起）。插件按它分支注册进哪条槽——
   * 同一份 bundle 在浏览器壳与终端壳里各跑一次，靠的就是这一个字段；
   * 缺省当 `web`（清单里 platform 缺省也是这个语义）。
   */
  platform?: UiPlatform
}

/**
 * 插件看到的那一面槽位注册表。
 *
 * 为什么给接口而不是直接把注册表类交出去：插件只需要「声明槽、注册组件、等一个槽
 * 出现、查已经画了什么」，不需要知道谁崩了、怎么退位（那是壳的事）。接口窄一点，
 * 将来给壳加内部能力时不会顺手把权限也扩给插件；而且加载器可以传一个**记账外壳**
 * 进去，插件卸载或重试时按账本回滚。
 *
 * 三个类型参数与注册表同形：`M`（槽位契约表）在插件 import 的那个模块里合并，
 * 槽名/owner/children/chain matched 全从表里推；`FM` 是 Factory 契约表。
 *
 * @typeParam C - 组件类型
 * @typeParam M - 槽位契约表（未收窄时是开放的 `SlotMapLike`）
 * @typeParam FM - Factory 契约表（未收窄时是开放的 `FactoryMapLike`）
 */
export interface UiSlotApi<C = unknown, M = SlotMapLike, FM = FactoryMapLike> {
  /** 已声明的槽名（诊断与「这个槽在不在」的判断用）。 */
  readonly slots: string[]
  /** 某个槽的形态；没声明过给 undefined。 */
  spec<K extends keyof M & string>(slot: K): SlotKindOf<M, K> | undefined
  declare<K extends keyof M & string>(slot: K, kind: SlotKindOf<M, K>): () => void
  /**
   * 往一个已声明的槽里登记组件（props 约束从契约表推，写错在调用点就编不过）。
   */
  register<
    K extends keyof M & string,
    const D extends SlotChildrenOf<M> = Record<never, never>,
    H extends StoreHandle<any, any> | undefined = undefined,
  >(
    slot: K,
    options: SlotRegisterOptions<M, K, D, H>,
    component: C & SlotComponentLike<SlotPropsOf<M, K, D, H, FM>>,
  ): () => void
  /** 注册一个可复用的 Factory 定义（D2）。 */
  registerFactory<F extends keyof FM & string>(
    options: SlotFactoryRegisterOptions<M, FM, F>,
    component: C & SlotComponentLike<FactoryDefinitionPropsOf<M, FM, F>>,
  ): () => void
  /**
   * 读一个席位的共享实例（该 handle 已有登记才给实例，没有给 undefined）。
   *
   * 典型用法：插件经服务表（`useService`）拿到别的插件 provide 的 handle，
   * 再经这里读同一份共享状态——team 抽名单、status 面板读同一份就是这条路。
   */
  seat<H extends StoreHandle<any, any>>(handle: H): SeatInstanceOf<H> | undefined
  injectSlot<K extends keyof M & string>(slot: K, contribute: () => void | (() => void)): () => void
  entriesOf(slot: string): readonly SlotEntry<C>[]
  winners(slot: string): readonly SlotEntry<C>[]
}

/**
 * 插件拿到的运行时通道：订阅宿主快照 + 调宿主方法。
 *
 * 这一份是界面壳对「宿主」的全部认识——插件不必知道底下是 SSE、WebSocket 还是 IPC
 * （桌面窗口走的是宿主伺服的同一份壳，浏览器里跑的是同一份代码）。
 */
export interface UiRuntimeApi {
  /** 当前快照；还没收到第一帧时 null。 */
  getSnapshot(): HostSnapshot | null
  /** 订阅变化（配合 React 的 useSyncExternalStore 用）。 */
  subscribe(listener: () => void): () => void
  /**
   * 调一个宿主方法（方法名与参数形状就是 `INVOKABLE_METHODS` 那一份白名单）。
   * @param method - 方法名
   * @param args - 实参
   * @throws {Error} 方法不在白名单里、或执行失败
   */
  invoke<T = unknown>(method: string, args?: unknown[]): Promise<T>
}

/**
 * 插件拿到的那一份 API。
 *
 * @typeParam C - 组件类型（浏览器壳是 React 组件，TUI 壳是 ink 组件）
 * @typeParam M - 槽位契约表（declare module 合并到插件 import 的那个模块）
 * @typeParam FM - Factory 契约表
 */
export interface UiPluginApi<C = unknown, M = SlotMapLike, FM = FactoryMapLike> {
  /** 这个插件的 id（清单里那一条），诊断与去重都用它。 */
  id: string
  /** 槽位注册表：声明过的槽才能注册，没声明的当场报错；想等一个槽出现用 `injectSlot`。 */
  slots: UiSlotApi<C, M, FM>
  /** 宿主身份。 */
  host: UiHostInfo
  /** 运行时通道：看状态、调方法。 */
  runtime: UiRuntimeApi
  /**
   * 提供一个服务（A1）。同一个名字第二次 provide 抛装配错误（带两个插件 id 的人话）；
   * 返回值随插件卸载释放（进装载账本）——provider 停用后 consumer 下一次读会变 undefined。
   */
  provide<T>(name: string, value: T): void
  /**
   * 读一个服务；缺席给 undefined（软依赖）。
   *
   * 想「提供者缺席就不装」用 `plugin.json` 的 `inject` 声明**硬依赖**——装载器会等它
   * 就绪、缺席时报告一行原因（见 `manifest.ts` 的 inject 双关说明）。
   */
  consume<T>(name: string): T | undefined
}

/** 插件 bundle 必须导出的形状。 */
export interface UiPluginModule<C = unknown, M = SlotMapLike, FM = FactoryMapLike> {
  /** 显示名（可缺省，缺省就用清单里的 id）。 */
  name?: string
  /**
   * 界面半边：注册自己的槽位。只能在这里登记，不要起副作用之外的定时器。
   * @param ui - 插件 API
   * @returns 可选的退订函数：壳体卸载这个插件时调用（HMR、重试都靠它）
   */
  apply(ui: UiPluginApi<C, M, FM>): void | (() => void)
}

/**
 * 标识函数：给插件作者写 `export default defineUiPlugin({ apply })` 用的，
 * 作用只是让类型检查提前发现「apply 写错了」这类笔误。
 */
export function defineUiPlugin<C, M, FM>(module: UiPluginModule<C, M, FM>): UiPluginModule<C, M, FM> {
  return module
}

/** 一个插件的加载结果（界面壳把失败的列出来，不要静默）。 */
export interface UiPluginLoadReport {
  id: string
  /** 插件自己报的显示名（没报就没有这一项）。 */
  name?: string
  ok: boolean
  /** 失败原因（加载脚本失败、没导出 apply、apply 抛错、等服务就绪都算）。 */
  error?: string
  /** 第几次尝试才装上（1 = 一次就成；依赖别的插件的会 > 1）。 */
  attempts?: number
  /** 这个插件 provide 过的服务名（装成功后填，诊断区可读）。 */
  provides?: string[]
}

/** 一次装载的总结果。 */
export interface UiPluginLoadResult {
  /** 每个插件一条，成功的也记（诊断区看得见谁装上了）。 */
  reports: UiPluginLoadReport[]
  /** 装载结束时的服务名快照（诊断区显示用）。 */
  services: readonly string[]
  /** 服务表本体：渲染侧的服务订阅（`useService`）要经 context 拿它。 */
  serviceRegistry: ServiceRegistry
  /**
   * 撤掉这一轮装上的全部插件。
   *
   * 为什么要有：`apply` 交回来的退订函数原先被直接丢掉，于是「装完就固定」——
   * 想再挂一个新插件只能整页刷新。有了它，热更新、失败重试、测试收尾都有落点。
   */
  disposeAll(): void
}
