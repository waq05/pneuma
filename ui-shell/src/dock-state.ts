/**
 * 停靠面板的开合状态（壳的布局真源）。
 *
 * 为什么放在壳这一侧而不是插件自己的 state：打开面板要**改壳的布局**——
 * `.thread-zone` 从「一列」变成「正文 + 面板」两列（见 `styles.css` 的 `[data-dock]`）。
 * 插件只该说「我要一块停靠区」，怎么让位是壳的事。所以这一份是个极小的订阅式状态：
 * 插件写、壳读，双方都不必认识对方。
 *
 * 为什么不用 React context：槽条目的渲染树与壳的 App 不在同一条 props 链上
 * （插件是壳按启动图动态装上去的），而这一份状态本来就与渲染树无关。
 *
 * @module dsc-ui-shell/dock-state
 */

/**
 * 当前打开的是哪一块面板（`null` = 收起）。
 *
 * 为什么是"面板 id"而不是一个布尔：停靠区里可以有几块互斥的面板（终端 / 文件与预览），
 * 同一时刻只该显示一块，而"谁被点开了"这件事只能有一个真源。头栏那几颗开合钮
 * 各自写自己的 id，面板自己比对 id 决定画不画——两侧都不必认识对方。
 */
let panel: string | null = null
const listeners = new Set<() => void>()

/** 现在开的是哪一块面板（`useSyncExternalStore` 的取数函数；null = 收起）。 */
export function dockPanel(): string | null {
  return panel
}

/**
 * 打开某一块面板（`null` = 收起）。
 *
 * 面板的**内容**由插件自己决定渲染什么；收起时壳不渲染 `shell.dock` 这个槽，
 * 于是所有面板都被卸载——这是有意的：收起面板不该在布局里留一条看不见的占位。
 */
export function setDockPanel(next: string | null): void {
  if (next === panel) return
  panel = next
  for (const listener of listeners) listener()
}

/** 订阅开合变化（`useSyncExternalStore` 的订阅函数）。 */
export function subscribeDock(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
