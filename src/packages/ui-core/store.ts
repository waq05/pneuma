/**
 * 席位（store seat）的契约与引擎：插件登记时声明一份**共享状态**，组件用 selector hook 读、
 * 用 actions 写；两个登记给了同一个 handle 才共享同一个实例（身份就是 handle 对象本身）。
 *
 * 与参考实现（dsh 的 `client-store`）的取舍，写在明处：
 *   - 不引 zustand/immer：dsc 只需要「订阅 + 烘焙 actions」这点能力，引两个依赖不划算。
 *     action 里的 draft 是**浅拷贝的普通对象**（不是 immer proxy）——action 作者约定
 *     「嵌套对象要么整体替换、要么展开新建」，第一版不做深层追踪（typecheck 示例里钉住）。
 *   - 没有 persist：dsc 第一版没有「席位跨会话持久化」的真实需求，等有需求再加。
 *   - instance 的生命周期归注册表管（同一 handle 的登记共享一个实例，最后一个持有者卸载时
 *     实例消失）；这个文件只提供 create()，不知道谁在持有。
 *
 * 不依赖 React：`useStore` 只是一段「可调用类型」，React 绑定在 `slots-react.ts`。
 *
 * @module dsc/ui/store
 */

/**
 * action 表：state 的**全部写路径**（审计面——组件只能经它写）。
 *
 * 参数写成 `any[]` 是刻意的（与 dsh 同款）：每个 action 自带参数表，`unknown[]` 会在
 * 严格逆变下拒掉所有具体签名；真正的参数由 {@link BakedActions} 逐个 action 再推断出来。
 */
export type ActionsDecl<T> = Record<string, (state: T, ...params: any[]) => void>

/**
 * 剥掉 draft 之后的 action 表：组件与 inject 面拿到的形态——框架把 state 参数烘进闭包，
 * 调用方只给业务实参，看不到 draft、也没有 set/update。
 */
export type BakedActions<T, A extends ActionsDecl<T>> = {
  [K in keyof A]: A[K] extends (state: T, ...params: infer P) => void ? (...params: P) => void : never
}

/** 席位的声明：初值工厂（每实例一份新 state）+ 写集。 */
export interface StoreSpec<T extends object, A extends ActionsDecl<T>> {
  /**
   * 初值工厂。写成 lambda 而不是对象字面量：每个实例各拿一份新 state，
   * 共享一个字面量会让两个实例写到同一份对象上。
   */
  init: () => T
  /** action 表 = 这份状态的全部写路径。 */
  actions: A
}

/** 快照源：读当前值 + 订阅变化（React 绑定与诊断都靠这两下）。 */
export interface SeatSnapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 席位实例：快照源 + 烘焙过的 actions。 */
export interface SeatInstance<T extends object, A extends ActionsDecl<T>> extends SeatSnapshot<T> {
  /** 组件写状态的唯一路径（draft 已剥掉）。 */
  readonly actions: BakedActions<T, A>
  /** 整值替换（引擎与测试用；组件只该用 actions，别拿它当后门）。 */
  readonly set: (next: T) => void
}

/**
 * 席位句柄：声明 + 实例工厂 + **共享身份**。
 *
 * 注意：handle 必须在 `apply(ui)` 里现建，**不许模块级导出**——模块缓存会让它在插件热重载
 * 之间变成一份伪装的单例，两次加载共享同一份状态（dsh 的同款警告）。
 */
export interface StoreHandle<T extends object, A extends ActionsDecl<T>> {
  readonly spec: StoreSpec<T, A>
  /** 建一个实例（注册表与测试用；组件与插件作者不直接调）。 */
  create(): SeatInstance<T, A>
}

/** 组件侧的 selector hook（注册表注入的 `useStore` 就是它）。 */
export type SnapshotSelectorHook<T> = <S>(
  selector: (state: T) => S,
  isEqual?: (a: S, b: S) => boolean,
) => S

/**
 * 登记里声明席位后，组件 props 多出来的那一份：读用 `useStore`，写用 `actions`。
 * 没声明席位（H = undefined）时是空份额。
 */
export type PropsStoreOf<H> = H extends StoreHandle<infer T, infer A>
  ? { useStore: SnapshotSelectorHook<T>; actions: BakedActions<T, A> }
  : object

/** 从 handle 推出实例类型（注册表的 `seat()` 用）。 */
export type SeatInstanceOf<H> = H extends StoreHandle<infer T, infer A> ? SeatInstance<T, A> : never

/**
 * 声明一份共享状态。返回的 handle 是席位的**身份**：同一个 handle 被几处登记共用，
 * 就共享同一个实例；跨插件共享走 `ui.provide` / `ui.consume` 把 handle 传出去。
 *
 * `A & ActionsDecl<T>` 这个交叉位置是**承重的**（与参考实现的同一手法）：T 先从 `init`
 * 推出来，交叉再给 actions 的 draft 参数提供上下文类型；action 的业务实参请显式标注
 * （`setList(draft, list: readonly X[])`），它们会被 {@link BakedActions} 逐个再推给组件。
 *
 * 引擎口径（第一版，见文件头）：action 收到的是顶层浅拷贝，写嵌套字段要整体替换
 * （`draft.list = [...draft.list, item]`），不要原地改嵌套对象。
 */
export function defineStore<T extends object, A extends ActionsDecl<T>>(
  spec: StoreSpec<T, A> & { actions: A & ActionsDecl<T> },
): StoreHandle<T, A> {
  return {
    spec,
    create(): SeatInstance<T, A> {
      let state = spec.init()
      const listeners = new Set<() => void>()
      const set = (next: T): void => {
        state = next
        for (const listener of [...listeners]) listener()
      }
      const actions = {} as Record<string, (...params: unknown[]) => void>
      for (const key of Object.keys(spec.actions)) {
        const mutate = spec.actions[key]
        actions[key] = (...params: unknown[]) => {
          // 浅拷贝顶层：mutate 改顶层字段（或整体替换某个嵌套值），发布新引用。
          const draft = { ...state } as T
          mutate(draft, ...params)
          set(draft)
        }
      }
      return {
        getSnapshot: () => state,
        subscribe: (listener): (() => void) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        actions: actions as BakedActions<T, A>,
        set,
      }
    },
  }
}
