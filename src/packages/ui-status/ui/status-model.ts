/**
 * 状态面板的纯派生逻辑：进程聚焦窗口 / 折叠桶语义 / 胶囊摘要链 / 时间口径。
 *
 * 零 React、零 DOM——组件只做渲染，规则全在这里，`scripts/ui-status-panel-test.mjs`
 * 按 Node 的类型擦除直接 import 这个 .ts 逐条钉（所以这里只许 `import type`，
 * 不许引入任何运行期依赖）。
 *
 * 规则对照 ZCode `packages/ui/src/v4/ConversationStatusPanel.tsx`（聚焦窗口
 * `getStatusPanelTodoFocusWindow`、折叠桶文案、`StatusSummaryRow` 的优先级链）。
 * 数据面差一档就用 dsc 自己的东西顶上，两处绑定都在 {@link capsuleSummary} 的注释里
 * 写明了：**工作流 = 定点任务**、**计划目录 = 提交过的计划文件**；dsc 没有的东西
 * （多站并行的工作流运行、run 目录）不出档，不摆空壳。
 *
 * @module dsc-ui-shell/plugins/status/model
 */
import type {
  BackgroundWorkView,
  GoalView,
  PlanEntryView,
  TeammateView,
  TodoItemView,
  TodoView,
} from '@dsc/ui'

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
  | { kind: 'workflow'; text: string }
  | { kind: 'todo-current'; text: string }
  | { kind: 'goal'; text: string; phase: GoalView['phase'] }
  | { kind: 'git'; added: number; removed: number; files: number }
  | { kind: 'goal-done'; text: string }
  | { kind: 'todo-done'; text: string }
  | { kind: 'progress'; done: number; total: number }
  | { kind: 'plan'; text: string }
  | { kind: 'running'; mates: number; works: number }
  | { kind: 'mates-ended'; count: number }

/** {@link capsuleSummary} 的输入：各数据面现读数（没有就是 null / 空数组）。 */
export interface CapsuleInput {
  todos: TodoView | null
  goal: GoalView | null
  /** 在跑的队友数（只看当前会话的）。 */
  runningMates: number
  /** Git 变更汇总（干净仓库 / 不是仓库 / 还没读到都给 null）。 */
  git: { added: number; removed: number; files: number } | null
  /** 提交过的计划目录（最新在前）。 */
  plans: readonly PlanEntryView[]
  /** 正在跑的后台作业与终端会话。 */
  runningWorks: readonly BackgroundWorkView[]
  /** 正在跑的定点任务标题（`lastStatus === 'running'` 的第一条）；null = 没有。 */
  runningTask: string | null
  /** 本会话收工的队友数（只在没有任何主状态时兜底——见函数注释）。 */
  endedMates: number
}

/**
 * 胶囊读数（收起态那一行）的优先级链（对照 ZCode `StatusSummaryRow`）：
 *
 * 1. 在跑的定点任务（ZCode 第一档是「在跑的工作流」；dsc 没有工作流引擎，绑的是
 *    定点任务——按规则自动跑的那一轮，语义最近）；
 * 2. 当前待办（进行中，其次首个待办）——主代理此刻在做的事；
 * 3. 未完成的目标（active / paused / blocked 都算「还在办」）；
 * 4. Git 变更（有改动就报，数字用增删行数；只有 untracked 时退报文件数）；
 * 5. 已完成的目标；
 * 6. 最后一条办完的待办；
 * 7. 进程 done/total；
 * 8. 计划目录的最新一份（ZCode：有计划目录时报它的标题）；
 * 9. 在跑的后台活兜底（作业 / 终端 / 队友，混合时给总数）；
 * 10. 只有收工的队友时兜底报一条——**这是 dsc 对 ZCode 的有意偏离**：
 *     ZCode 的已结束智能体不撑胶囊（它有别的入口），而 dsc 在去掉标题栏团队钮之后，
 *     状态面板是「已结束名册」的唯一入口，全空就真进不去了，所以留这一档。
 *
 * 最后两档之前都空才轮到它们；没有任何可报的给 null（面板整块不画）。
 */
export function capsuleSummary(input: CapsuleInput): CapsuleSummary | null {
  if (input.runningTask !== null && input.runningTask !== '') {
    return { kind: 'workflow', text: input.runningTask }
  }

  const items = input.todos?.items ?? []
  const current =
    items.find((item) => item.status === 'in_progress') ??
    items.find((item) => item.status === 'pending') ??
    null
  if (current !== null) return { kind: 'todo-current', text: current.content }

  const goal = input.goal
  if (goal !== null && goal.phase !== 'complete') {
    return { kind: 'goal', text: goal.objective, phase: goal.phase }
  }

  if (input.git !== null && input.git.files > 0) {
    return { kind: 'git', added: input.git.added, removed: input.git.removed, files: input.git.files }
  }

  if (goal !== null) return { kind: 'goal-done', text: goal.objective }

  const done = [...items].reverse().find((item) => item.status === 'completed')
  if (done !== undefined) return { kind: 'todo-done', text: done.content }

  if (input.todos !== null && input.todos.total > 0) {
    return { kind: 'progress', done: input.todos.done, total: input.todos.total }
  }

  const newestPlan = input.plans[0]
  if (newestPlan !== undefined) return { kind: 'plan', text: newestPlan.title }

  if (input.runningMates > 0 || input.runningWorks.length > 0) {
    return { kind: 'running', mates: input.runningMates, works: input.runningWorks.length }
  }

  if (input.endedMates > 0) return { kind: 'mates-ended', count: input.endedMates }

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
  if (minutes > 0) return `${String(minutes)}分${String(seconds)}秒`
  return `${String(seconds)}秒`
}

/**
 * 距离一个未来时刻还有多久：`3小时42分后` / 不到一秒给 `即将`；已过点给 `已到点`。
 * nextAt 缺席（null）给 null——「没有排期」由调用方自己给文案（那是状态不是时长）。
 */
export function formatCountdown(nextAt: number | null, now: number): string | null {
  if (nextAt === null || !Number.isFinite(nextAt)) return null
  const diff = nextAt - now
  if (diff <= 0) return '已到点'
  const text = formatDuration(diff)
  return text === null || diff < 1000 ? '即将' : `${text}后`
}

/** 一个过去时刻距今多久：不到一分钟给 `刚刚`（列表按分钟级刷新，不给秒级读数）。 */
export function formatAgo(at: number, now: number): string | null {
  if (!Number.isFinite(at) || at <= 0) return null
  const diff = now - at
  if (diff < 0) return null
  if (diff < 60_000) return '刚刚'
  const text = formatDuration(diff)
  return text === null ? null : `${text}前`
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

/** 一组在跑的后台活里最长的那条已运行毫秒（「终端」区折叠态读数用）。 */
export function longestWorkElapsedMs(
  works: readonly Pick<BackgroundWorkView, 'startedAt'>[],
  now: number,
): number {
  return works.reduce((longest, work) => Math.max(longest, Math.max(0, now - work.startedAt)), 0)
}
