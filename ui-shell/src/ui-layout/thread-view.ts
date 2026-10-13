/**
 * 正文区的两张脸：`chat`（对话消息流）/ `trace`（执行轨迹页）——壳的视图真源。
 *
 * 为什么要有这一层：轨迹页与对话页**共用同一块正文位**（`.thread-zone > .thread-main`，
 * 输入区与状态栏两张脸都在），谁顶在上面不能由任一个插件自己说了算——顶栏页签（壳画）、
 * 会话右键菜单（sessions 插件）、工具行的「在轨迹中查看」药丸（transcript 插件）
 * 三个入口都要切它，轨迹插件自己则要读它决定画不画。与 page-state 同一个模式
 * （模块级订阅状态）：这几端不在同一条 props 链上。
 *
 * 「聚焦某一步」也住这里（`openTrace(stepId)`）：药丸点了要的不是一句「切到轨迹」，
 * 而是「切过去并滚到那条调用」。跨插件传这个意图没有别的地方可放——transcript 拿不到
 * trace 的组件引用，trace 也拦不住 transcript 的点击，中间只隔着这一份状态。
 * 取用的协议：trace 插件读到 focus 后**滚过去并清掉**（见 `clearTraceFocus`），
 * 这一笔是「一次性指令」而不是「常驻状态」。
 *
 * @module dsc-ui-shell/thread-view
 */
import { useSyncExternalStore } from 'react'

/** 正文区正在显示哪一张脸。 */
export type ThreadView = 'chat' | 'trace'

let view: ThreadView = 'chat'
let focusStep: number | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** 现在正文区显示的是哪一张脸。 */
export function shellThreadView(): ThreadView {
  return view
}

/** 切正文区的脸（切到同一张不重复通知）。 */
export function setThreadView(next: ThreadView): void {
  if (next === view) return
  view = next
  emit()
}

/**
 * 切到轨迹页，并（可选）把某一条步骤定为聚焦目标。
 *
 * 传了 `stepId` 就连 focus 一起写：两个字段一次通知发出去——分两次写会让 trace
 * 先按「没聚焦」渲染一帧再重排，滚动位置会闪一下。
 */
export function openTrace(stepId?: number): void {
  const nextFocus = stepId ?? null
  if (view === 'trace' && focusStep === nextFocus) return
  view = 'trace'
  focusStep = nextFocus
  emit()
}

/** 当前待处理的聚焦目标（没设过是 null）。 */
export function traceFocusStep(): number | null {
  return focusStep
}

/** 消费掉聚焦目标（trace 插件滚到位之后调用；指令只生效一次）。 */
export function clearTraceFocus(): void {
  if (focusStep === null) return
  focusStep = null
  emit()
}

/** 订阅切换（`useSyncExternalStore` 的订阅函数）。 */
export function subscribeThreadView(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 读正文区当前的脸并跟着变（hook 形态）。
 *
 * 与 `page-state.ts` 的 `useShellPage` 同一条理由住这里：壳自己（`app.tsx`）也要用，
 * 放插件面就得让 `ui-layout` 反过来引 `@dsc/ui`。`@dsc/ui` 只把它转出给插件。
 */
export function useThreadView(): ThreadView {
  return useSyncExternalStore(subscribeThreadView, shellThreadView, () => 'chat')
}

/** 读「待处理的聚焦步骤」（hook 形态；消费方滚到位后调 `clearTraceFocus`）。 */
export function useTraceFocus(): number | null {
  return useSyncExternalStore(subscribeThreadView, traceFocusStep, () => null)
}
