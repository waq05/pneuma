/**
 * 主区整页的状态（壳的页面真源）：`null` = 对话页；非空 = 某个插件的整页在顶上。
 *
 * 为什么要有这一层：旧界面的主区不止一个页面——「对话」之外还有插件中心、技能这些
 * **整页**（顶栏与正文都换成页自己的，见 desktop 渲染层 `view: 'chat'|'plugins'|'skills'`）。
 * 壳里把这些页做成 plugin 注册的 `shell.page` 槽条目：谁报名谁在，页与页之间由
 * 这里的一个 id 切换（侧栏入口写它、页自己读它决定画不画）。
 *
 * 与 dock-state 同一个模式（模块级订阅状态）：渲染树的两端（侧栏入口、页本体）
 * 不在同一条 props 链上，状态与渲染树无关。
 *
 * @module dsc-ui-shell/page-state
 */

let page: string | null = null
const listeners = new Set<() => void>()

/** 现在顶在主区的是哪一页（`null` = 对话页）。 */
export function shellPage(): string | null {
  return page
}

/** 切页（`null` = 回对话页）。切到同一页不重复通知。 */
export function setShellPage(next: string | null): void {
  if (next === page) return
  page = next
  for (const listener of listeners) listener()
}

/** 订阅切页（`useSyncExternalStore` 的订阅函数）。 */
export function subscribePage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
