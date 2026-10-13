/**
 * 状态面板的纯派生逻辑：进程聚焦窗口 / 折叠桶语义 / 胶囊摘要链 / 时长口径。
 *
 * 零 React、零 DOM——组件只做渲染，规则全在这里，`scripts/ui-status-panel-test.mjs`
 * 按 Node 的类型擦除直接 import 这个 .ts 逐条钉（所以这里只许 `import type`，
 * 不许引入任何运行期依赖）。
 *
 * 规则对照 ZCode `packages/ui/src/v4/ConversationStatusPanel.tsx`（聚焦窗口
 * `getStatusPanelTodoFocusWindow`、折叠桶文案、`StatusSummaryRow` 的优先级链），
 * 按 dsc 的数据面裁掉它没有的档（工作流 / Git 变更 / 终态计划目录）。
 *
 * @module dsc-ui-shell/plugins/status/model
 */
import type { GoalView, TeammateView, TodoItemView, TodoView } from '@dsc/ui'

/** 超过这个条数才启用聚焦窗口（0-6 条按原序全显）。 */
export const TODO_COMPACT_THRESHOLD = 6
/** 聚焦窗口的条数：当前项前后合起来恒取 3 条（条目数足够时）。 */
export const TODO_FOCUS_SIZE = 3

export interface TodoFocusWindow {
  compact: boolean
  /** 窗口之前的条目（折叠桶）。 */
  preceding: readonly TodoItemView[]
  /** 窗口本体，严格保持 snapshot 原序。 */
  focus: readonly TodoItemView[]
  /** 窗口之后的条目（折叠桶）。 */
  following: readonly TodoItemView[]
}

/** 完成口径：completed 与 cancelled 都算「不再需要盯」。 */
function isSettled(status: TodoItemView['status']): boolean {
  return status === 'completed' || status === 'cancelled'
}

/**
 * 进程区的聚焦窗口（对照 ZCode `getStatusPanelTodoFocusWindow`）：
 * ≤{@link TODO_COMPACT_THRESHOLD} 条按 snapshot 原序全显；超过时聚焦连续
 * {@link TODO_FOCUS_SIZE} 条——优先进行中，其次首个待办，全办完则取末尾三条；
 * 靠近末尾向前回填，条目数足够时窗口恒为 3 条且不改变原序。
 */
export function todoFocusWindow(items: readonly TodoItemView[]): TodoFocusWindow {
  if (items.length <= TODO_COMPACT_THRESHOLD) {
    return { compact: false, preceding: [], focus: items, following: [] }
  }
  const runningIndex = items.findIndex((item) => item.status === 'in_progress')
  const pendingIndex = items.findIndex((item) => item.status === 'pending')
  const focusIndex =
    runningIndex >= 0
      ? runningIndex
      : pendingIndex >= 0
        ? pendingIndex
        : Math.max(0, items.length - TODO_FOCUS_SIZE)
  const start = Math.max(0, Math.min(focusIndex, items.length - TODO_FOCUS_SIZE))
  const end = Math.min(items.length, start + TODO_FOCUS_SIZE)
  return {
    compact: true,
    preceding: items.slice(0, start),
    focus: items.slice(start, end),
    following: items.slice(end),
  }
}

export type FoldBucketKind = 'completed' | 'waiting' | 'earlier' | 'later'

/**
 * 折叠桶的语义档：窗口前的桶全办完 → 「已完成 n 项」，窗口后的桶全待办 →
 * 「待处理 n 项」，否则退回中性位置词「前面 n 项 / 后面 n 项」。
 * 禁止用位置切片虚报状态（ZCode 同款裁定）。
 */
export function foldBucketKind(
  items: readonly TodoItemView[],
  side: 'preceding' | 'following',
): FoldBucketKind {
  if (side === 'preceding') {
    return items.every((item) => isSettled(item.status)) ? 'completed' : 'earlier'
  }
  return items.every((item) => item.status === 'pending') ? 'waiting' : 'later'
}

export type CapsuleSummary =
  | { kind: 'todo-current'; text: string }
  | { kind: 'goal'; text: string; phase: GoalView['phase'] }
  | { kind: 'todo-done'; text: string }
  | { kind: 'progress'; done: number; total: number }
  | { kind: 'mates'; count: number }

/**
 * 胶囊读数（收起态那一行）的优先级链（对照 ZCode `StatusSummaryRow` 的主状态段，
 * 裁掉 dsc 没有的工作流 / Git 变更两档）：
 *
 * 1. 当前待办（进行中，其次首个待办）——主代理此刻在做的事；
 * 2. 目标（ZCode 把「未完成相位」与「已完成」两档分列在 Git 变更两侧；dsc 没有
 *    Git 档，两档相邻，所以合成一条）；
 * 3. 最后一条办完的待办；
 * 4. 进程 done/total；
 * 5. 在跑的队友数（只在没有任何主状态时兜底）。
 *
 * 已结束的队友**不进胶囊**：终态不撑起一颗胶囊（ZCode 同款裁定——
 * 「does not keep a mini capsule alive for ended Agents alone」）。
 */
export function capsuleSummary(input: {
  todos: TodoView | null
  goal: GoalView | null
  runningMates: number
}): CapsuleSummary | null {
  const items = input.todos?.items ?? []
  const current =
    items.find((item) => item.status === 'in_progress') ??
    items.find((item) => item.status === 'pending') ??
    null
  if (current !== null) return { kind: 'todo-current', text: current.content }

  const goal = input.goal
  if (goal !== null) return { kind: 'goal', text: goal.objective, phase: goal.phase }

  const done = [...items].reverse().find((item) => item.status === 'completed')
  if (done !== undefined) return { kind: 'todo-done', text: done.content }

  if (input.todos !== null && input.todos.total > 0) {
    return { kind: 'progress', done: input.todos.done, total: input.todos.total }
  }

  if (input.runningMates > 0) return { kind: 'mates', count: input.runningMates }

  return null
}

/** 毫秒 → 「14分30秒」/「8秒」；负数 / NaN 给 null（与团队行的口径一致）。 */
export function formatDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null
  const total = Math.max(1, Math.round(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (hours > 0) return `${String(hours)}小时${pad(minutes)}分`
  if (minutes > 0) return `${String(minutes)}分${pad(seconds)}秒`
  return `${String(seconds)}秒`
}

/** 一条队友行的已运行毫秒（收工的按 finishedAt 冻结，在跑的跟 now 走）。 */
export function mateElapsedMs(
  mate: Pick<TeammateView, 'startedAt' | 'finishedAt'>,
  now: number,
): number {
  return Math.max(0, (mate.finishedAt ?? now) - mate.startedAt)
}

/** 一组在跑队友里最长的那条已运行毫秒（折叠态读数用）。 */
export function longestElapsedMs(
  mates: readonly Pick<TeammateView, 'startedAt' | 'finishedAt'>[],
  now: number,
): number {
  return mates.reduce((longest, mate) => Math.max(longest, mateElapsedMs(mate, now)), 0)
}
