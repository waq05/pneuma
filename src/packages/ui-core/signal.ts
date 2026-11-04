/**
 * 模块级信号：一份共享状态 + 订阅 + 通知（全壳唯一一份写法）。
 *
 * 为什么要它：界面里有七处模块级共享状态（正文区那张脸、切页、dock 布局、旁问、文件树、
 * 团队面板、启动账本），每处都手写「`Set<() => void>` + `subscribe` + 一个 for 循环通知」。
 * 抄过去的不是那十行代码，是三条**抄漏了也不报错**的语义：
 *
 *   1. **引用稳定**：没变时 `get()` 必须返回同一个值（对象也一样）。`useSyncExternalStore`
 *      拿它判断要不要重画——克隆一次就是逐帧重画，而且是"看起来卡"而不是"看起来错"；
 *   2. **通知前复制订阅者**：回调里退订（组件卸载时就会发生）不能打断这一轮遍历，
 *      否则后面几个订阅者这一轮收不到通知，界面就停在旧值上；
 *   3. **写入判等**：值没变就不通知。几个老实现各自用 `next === value` 判，
 *      这里统一成 `Object.is`（`NaN` 算没变）。
 *
 * 与 `defineStore`（`store.ts`）的分工：
 *   - `defineStore` 是**按登记实例化**的席位——必须在 `apply(ui)` 里现建，随登记卸载消失，
 *     带 actions 表与浅拷贝 draft；
 *   - 这份是**模块级单例**——没有登记、没有生命周期，谁引都是同一份。
 *   两者要的只有「订阅 + 没变不通知」，所以不合并成一层。
 *
 * 两种用法，按「状态归不归这份信号」选：
 *   - **值归信号**（`set`）：切页、团队面板开合、dock 布局、正文区那张脸。多字段写成
 *     **一个对象**、一次 `set` 发出去；分两次写会让订阅方先渲染半套新值
 *     （`thread-view` 的「切到轨迹并聚焦某一步」踩过这个：滚动位置会闪一下）。
 *   - **值在别处**（`notify`）：状态是一张模块级 Map 或挂在 `globalThis` 上的账本
 *     （文件树、旁问、启动账本）。这类只借这份信号当**变更通道**：值怎么存照旧，
 *     写完调 `notify()` 让订阅者重读。硬要把 Map 塞进信号，每次流式增量都得整张复制一遍，
 *     换来的是零语义收益。
 *
 * @module dsc/ui/signal
 */

/** 一份模块级信号。 */
export interface Signal<T> {
  /** 读当前值（没变时返回同一个引用）。 */
  get(): T
  /** 写新值；与当前值相同（`Object.is`）就不通知。 */
  set(next: T): void
  /**
   * 通知订阅者「外部数据变了，重读一次」。
   *
   * 只在**值不归这份信号**时用（模块级 Map、`globalThis` 上的账本）；值归信号时用 `set`。
   * 它不判等——调用方说变了就是变了。
   */
  notify(): void
  /** 订阅变化（`useSyncExternalStore` 的订阅函数形状）。 */
  subscribe(listener: () => void): () => void
}

/** 造一份信号；初值就是第一份状态。 */
export function createSignal<T>(initial: T): Signal<T> {
  let value = initial
  const listeners = new Set<() => void>()
  const notify = (): void => {
    // 复制一份再遍历：回调里退订不会漏掉后面的订阅者。
    for (const listener of [...listeners]) listener()
  }
  return {
    get: () => value,
    set: (next: T) => {
      if (Object.is(next, value)) return
      value = next
      notify()
    },
    notify,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
