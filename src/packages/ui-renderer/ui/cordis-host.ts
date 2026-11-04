/**
 * 浏览器壳的 cordis 宿主：把「装一条界面插件」这件事交给与宿主内核同一套的框架。
 *
 * 为什么要这一层：宿主（`src/host/kernel.ts`）早就用 cordis 装插件——`apply(ctx)`、
 * `inject` 声明依赖、`ctx.effect()` 自动回收、fiber 状态可读。界面壳此前自己写了一份
 * 小一号的装载器（`boot.ts` 的账本 + 失败重试），两边的生命周期语义各说各话：宿主插件
 * 卸载由 cordis 保证顺序，界面插件卸载靠手工账本倒序调用。
 *
 * 这一层不改插件写法。插件仍然 `export default defineUiPlugin({ apply(ui) })`，拿到的
 * `ui` 仍是那六项（id / slots / host / runtime / provide / consume）——壳把 cordis 的
 * `ctx` 包装成 `ui` 交过去。于是 19 个内置插件一行都不用改，第三方插件也不必重写，
 * 而装配、等待、回收全部走 cordis：
 *
 * | 旧账本 | cordis |
 * | --- | --- |
 * | `ledgerOfPlugin` 手工倒序调用 | `ctx.effect()` / fiber 自动回收（依赖顺序由框架保证） |
 * | `unmetInjections` 装前检查 + 重试一轮 | `inject` 声明，缺服务时 fiber 停在「待装」 |
 * | `disposers` 表 + `uninstall` | `fiber.dispose()` |
 * | 状态靠 `UiBootPluginState.state` 自己维护 | `fiber.state`（0 待装 / 1 装载中 / 2 生效 / 3 失败 / 4 已卸） |
 *
 * 服务只垫三个：`slots` / `host` / `runtime`（壳自己提供，fiber 持有）。插件
 * `ui.provide()` 出来的服务同时写进界面侧的服务表（`useService` 读它，保持既有行为）
 * 与 cordis（将来的插件 `inject` 得到）——两边都是同一个值、同一次释放。
 *
 * @module dsc-ui-shell/ui-renderer/cordis-host
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { createScopedSlotApi, type ServiceRegistry } from '@dsc/ui-core'
import type { UiHostInfo, UiPluginApi, UiRuntimeApi, UiSlots } from '@dsc/ui'

/**
 * 壳提供的那三个服务声明进方 context 的接口。
 *
 * `declare module` 的合并只认词法相邻的声明，所以声明落在这个文件（`new Context()`
 * 与它的全部读点都在这）。宿主侧的 `src/services/types.ts` 声明的是另一批服务名
 * （llm / session / tools …），两边的 tsconfig 各自 include，不冲突。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 槽位注册表：插件往已声明的槽里登记组件。 */
    slots: UiSlots
    /** 宿主身份（名字与版本）。 */
    host: UiHostInfo
    /**
     * 宿主数据通道（快照订阅 + 方法调用）。
     *
     * 为什么叫 uiRuntime 而不是 runtime：cordis 的 Context 自带一个 runtime 访问器
     * （fiber 的插件运行时），重名会在第一次 provide 时抛
     * 「property "runtime" is already declared as accessor」——真机走查踩过。
     */
    uiRuntime: UiRuntimeApi
  }
}

/** 插件 `apply` 的形状（与 `UiPluginModule.apply` 一致，这里不引整包）。 */
export type UiApply = (ui: UiPluginApi) => void | (() => void)

/** 装一条时的可选项。 */
export interface UiMountHooks {
  /** 每成功 provide 一个服务调一次（报告要用）。 */
  onProvide?: (name: string) => void
  /**
   * 这条插件依赖的**服务名**（不是插件 id）。
   *
   * 声明进来之后 cordis 会等它们就绪再跑 `apply`，服务后补上来（别的插件在更晚的批里
   * 装上、或 HMR 时装上）也会自动启动——这是 dsh 侧 `inject` 的语义。
   *
   * 为什么由调用方筛：界面清单里的 `inject` 是**双关**（既可能是另一个插件的 id，
   * 也可能是服务名，见 `core/manifest.ts`）。把插件 id 当服务名交给 cordis，那条纤维
   * 会永远等不到东西。
   */
  inject?: readonly string[]
  /** 纤维状态变化（0 待装 / 1 装载中 / 2 生效 / 3 失败 / 4 已卸），带上还缺哪些服务。 */
  onState?: (state: number, missing: readonly string[]) => void
}

/** fiber 状态码 → 人话（诊断区与日志用）。 */
export const FIBER_STATE_TEXT: Readonly<Record<number, string>> = {
  0: '待装（还差依赖）',
  1: '装载中',
  2: '已生效',
  3: '装载失败',
  4: '已卸载',
  5: '已卸载',
}

/** 一份 fiber 状态的人话；读不到给 undefined。 */
export function fiberStateText(state: number | undefined): string | undefined {
  return state === undefined ? undefined : (FIBER_STATE_TEXT[state] ?? `状态 ${String(state)}`)
}

/** 壳里的 cordis 根：装、卸、查状态。 */
export interface UiCordisRoot {
  /** 根 context（诊断与将来「插件里 `ctx.plugin` 挂子插件」的入口）。 */
  readonly ctx: Context
  /**
   * 装一条插件。
   * @param id - 插件 id（纤维名、服务提供者的记录名）
   * @param apply - 插件导出的 `apply`
   * @param hooks - 可选钩子
   * @returns 装好后（fiber 已生效）的那个 fiber
   * @throws 插件 `apply` 抛错时原样抛出（调用方记报告，别静默）
   */
  mount(id: string, apply: UiApply, hooks?: UiMountHooks): Promise<Fiber>
  /** 卸一条（没装过或已卸是空操作；卸载中的重复调用返回同一次卸载）。 */
  unmount(id: string): Promise<void>
  /** 这个插件现在的 fiber 状态码（没装过给 undefined）。 */
  stateOf(id: string): number | undefined
  /** 这条纤维还在等哪些服务（不在等待就给空数组）。 */
  missingOf(id: string): readonly string[]
  /** 卸掉全部。 */
  disposeAll(): Promise<void>
}

export interface UiCordisRootOptions {
  slots: UiSlots
  host: UiHostInfo
  runtime: UiRuntimeApi
  /** 界面侧服务表（provide/consume 的既有读面，插件与 `useService` 都读它）。 */
  services: ServiceRegistry
}

/**
 * 建一个 cordis 根，把壳自己的三个服务提供出去。
 *
 * 服务由 root fiber 持有：卸载插件只撤它自己 provide 的那些，壳的三个一直在。
 * @param options - 槽位注册表、宿主身份、运行时通道、界面侧服务表
 * @returns 可装可卸的根
 */
export function createCordisRoot(options: UiCordisRootOptions): UiCordisRoot {
  const ctx = new Context()
  ctx.provide('slots', options.slots)
  ctx.provide('host', options.host)
  // 服务名要避开 cordis 自带的 Context 成员（runtime / effect / fiber 都是它的），
  // 重名会当场抛「already declared as accessor」。
  ctx.provide('uiRuntime', options.runtime)

  const fibers = new Map<string, Fiber>()
  /** 卸载进行中的承诺：cordis 的卸载是异步的，重复调用要等同一次。 */
  const unmounting = new Map<string, Promise<void>>()

  /** 一条纤维还差哪些服务（服务名来自它声明的 inject；没就绪的读不到实现）。 */
  const missingOfFiber = (fiber: Fiber): string[] =>
    Object.keys(fiber.inject ?? {}).filter((name) => fiber.store?.[name] === undefined)

  const unmountNow = (id: string): Promise<void> => {
    const running = unmounting.get(id)
    if (running !== undefined) return running
    const fiber = fibers.get(id)
    if (fiber === undefined) return Promise.resolve()
    fibers.delete(id)
    const task = fiber
      .dispose()
      .catch((error: unknown) => {
        console.warn(`[ui-shell] 插件 ${id} 卸载时出错：`, error)
      })
      .finally(() => {
        unmounting.delete(id)
      })
    unmounting.set(id, task)
    return task
  }

  /**
   * 造插件看到的那六项。
   *
   * 槽位登记与 provide 都挂 `ctx.effect()`：`apply` 抛错、卸载、重装都由 cordis
   * 按依赖顺序回收，壳不必再维护一份账本。
   */
  const apiOf = (inner: Context, id: string, hooks: UiMountHooks | undefined): UiPluginApi => ({
    id,
    slots: createScopedSlotApi(inner.slots, (release) => {
      inner.effect(() => release)
      return release
    }),
    host: inner.host,
    runtime: inner.uiRuntime,
    provide: (name, value) => {
      // 界面侧的服务表是插件真正读的那一份（useService 订阅它的出现与消失）。
      const release = options.services.provide(name, value, id)
      inner.effect(() => release)
      // 同时镜像进 cordis：将来声明 inject: ['名字'] 的插件由框架等它就绪。
      try {
        ;(inner.provide as (service: string, implemented: unknown) => void)(name, value)
      } catch (error) {
        // 与壳自己的三个服务重名，或已被别的 fiber 占住：界面侧照旧可用，不因此装不上。
        console.warn(`[ui-shell] 服务「${name}」没能在 cordis 里镜像：`, error)
      }
      hooks?.onProvide?.(name)
    },
    consume: <T>(name: string): T | undefined => {
      // 先问 cordis（镜像进去的那份），再回落到界面侧的表——两处同一个值，
      // 但镜像可能因重名而缺席（上面那个 catch），落回来才不会读到 undefined。
      const mirrored = (inner.get as (service: string) => unknown)(name)
      return (mirrored as T | undefined) ?? options.services.consume<T>(name)
    },
  })

  return {
    ctx,
    mount: async (id, apply, hooks) => {
      // 同一个 id 上不能有两条纤维：重试轮与 HMR 都会走到这里（先前那条等依赖的、
      // 或者上一次失败的）。先撤干净再挂。
      await unmountNow(id)
      // 对象形状与 dsh 的插件一致：名字给纤维用，inject 是服务名（由调用方筛过），
      // apply 收 ctx。`apply` 返回的退订函数由 cordis 直接收下（`Fiber._execute`
      // 认函数返回值），所以插件里那句 `return () => …` 不必改。
      const fiber = ctx.plugin({
        name: id,
        ...(hooks?.inject === undefined || hooks.inject.length === 0 ? {} : { inject: [...hooks.inject] }),
        apply: (inner: Context) => apply(apiOf(inner, id, hooks)),
      })
      try {
        await fiber
      } catch (error) {
        // 装失败也要撤掉这半条纤维，不留「状态 3 但还占着槽位」的残骸。
        await fiber.dispose().catch(() => undefined)
        throw error
      }
      fibers.set(id, fiber)
      // 纤维状态变化要能传回壳：依赖后补上来时它会从「待装」自己变成「生效」，
      // 账本不跟上就会一直显示旧的失败行（cordis 每次状态切换都发这条事件）。
      if (hooks?.onState !== undefined) {
        const onState = hooks.onState
        const watch = (changed: Fiber): void => {
          if (fiber.uid === null || changed.uid !== fiber.uid) return
          onState(changed.state, missingOfFiber(changed))
        }
        // cordis 的 on 返回退订函数（没有 off 这个名字），交给 effect 管：壳卸根时一起撤。
        const off = (ctx.on as unknown as (name: string, listener: (changed: Fiber) => void) => () => void)(
          'internal/status',
          watch,
        )
        ctx.effect(() => (typeof off === 'function' ? off : () => undefined))
      }
      return fiber
    },
    unmount: (id) => unmountNow(id),
    stateOf: (id) => fibers.get(id)?.state,
    missingOf: (id) => {
      const fiber = fibers.get(id)
      return fiber === undefined ? [] : missingOfFiber(fiber)
    },
    disposeAll: async () => {
      await Promise.all([...fibers.keys()].map(async (id) => {
        const fiber = fibers.get(id)
        fibers.delete(id)
        await fiber?.dispose().catch(() => undefined)
      }))
      await Promise.all([...unmounting.values()])
    },
  }
}
