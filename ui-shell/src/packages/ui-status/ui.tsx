/**
 * 内置插件：状态面板（对照 ZCode 的「会话状态面板」：一个可收成胶囊的多分区总览浮层）。
 *
 * ## 为什么要有它
 *
 * 长会话里「现在到底有几件事在跑」原本散在多处：输入框上方的任务条（`plugins/tasks`）、
 * 标题旁的「N 个子智能体」下拉（`plugins/team`）、状态栏的读数，各答一半——任务条不报队友，
 * 队友下拉不报任务进度。这个面板把这几条**合成一块浮层，默认落在顶栏页签行右端**
 * （收起态的胶囊可以按住拖动，位置记在本机，见 {@link POS_KEY}）。
 * （第一版之后任务条与「智能体团队」钮已从壳里撤掉：它们报的东西这里都有，留着是两份。）
 *
 * ## 形状（照 ZCode 的状态面板）
 *
 * - **同一壳收展（morph）**：收起态是胶囊（一颗药丸，只报优先级最高的那一条摘要），
 *   展开态是一块 320px 浮层。两态是**同一棵 DOM**（`[data-expanded]` 切换），收起/展开
 *   过渡最大高度、圆角、背景与阴影。ZCode 的 shell 也是这么做的。
 * - **自动档按正文区宽度裁决**：量的是正文区（`.thread-main` 上的 `data-thread-area`）
 *   的宽度（ResizeObserver），
 *   不读 `window.innerWidth`——右侧 dock 开合会改正文区宽度但不改窗口宽度。
 *   注意**宽度的裁决口径与落点分开**：胶囊默认画在顶栏页签行，但 1280px 这条线量的仍是正文区，
 *   否则把胶囊挪个位置就把自动档的行为一起改了。
 * - **分区七个**（顺序照 ZCode 的 Git 工具 / 目标 / 计划 / 进程 / 终端 / 工作流 / 智能体），
 *   各自可折叠、各自限高滚动；进程区超过 6 条启用聚焦窗口（当前项 ±1 连续 3 条，
 *   前后折成折叠桶，hover 出预览卡）。
 * - **智能体区只列在跑的**；收工的折成一条「已结束 · N ›」目录行，经 team 插件的
 *   `teamPanel` 服务打开团队面板（缺这个服务时整行不渲染——点了没反应的入口比没有更糟）。
 *
 * ## 为什么挂在 `shell.main` 槽里却画到顶栏页签行
 *
 * `shell.main` 的条目渲染在滚动容器里（`.chat-inner`），静态排布会随正文滚走。所以这里
 * 用的是右缘刻度条（`plugins/transcript/jump-rail.tsx`）那一套：**一个 hidden 哨兵**在文档流里
 * 占位，组件把浮层 portal 出去。portal 宿主优先取顶栏页签行（`.topbar .tabs`）：
 * 那一行的右侧本来就是空的，胶囊摆那儿不压正文第一行。手机档（<860px）没有这一行，
 * 回落到正文区右上角（从哨兵往上找 `[data-thread-area]`，见 {@link THREAD_AREA_SELECTOR}）。
 * 收起态的胶囊可以按住拖动，位置存在本机（{@link POS_KEY}），拖不出可见范围。
 *
 * ## 数据（逐区）
 *
 * - **Git 工具**：本地轮询 `dock git-status`（读类 op 直接放行；`stats:true` 多要每文件
 *   增删行数——tracked 走 numstat、未跟踪按内容数换行符，都计进这一对 +N/−N）。
 *   不是仓库、或干净到没有一行改动时整区不画（ZCode 同款：干净仓库不摆状态卡）。
 *   点「更改」行开右侧栏的 Git 页签（暂存 / 提交 / 历史 / diff 都在那里）。
 * - **目标 / 进程**：快照的 `surfaces.goal` / `surfaces.todos`（与目标条同源，逐帧推）。
 * - **计划**：快照的 `surfaces.planDirectory`（宿主扫工作区 `.dsc/plans/`，最新在前；
 *   正在等批的那一份不进目录——它在输入框上方的评审卡里）。点一行在右侧栏打开它。
 * - **终端**：快照的 `surfaces.backgroundWorks`（正在跑的后台作业 / 持久终端会话）；
 *   停止走 `stopBackground`（等价 job_kill / terminal close 的簿记，放行面上）。
 * - **工作流**：快照的 `surfaces.scheduled`。dsc 没有工作流引擎，这一区绑的是最接近的
 *   「按规则自动跑一轮」——定点任务；schedule 插件默认关着，关着时整区不渲染。
 * - **智能体**：`listTeammates`（team 插件开着时经共享席位读，缺席才回落到 5 秒轮询）。
 *
 * 纯派生规则（聚焦窗口 / 折叠桶 / 胶囊优先级链 / 时长与倒计时）在 `./status-model.ts`，
 * 由 `scripts/ui-status-panel-test.mjs` 逐条钉住。
 *
 * @module dsc-ui-shell/plugins/status
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconActivity,
  IconArrowRight,
  IconBranch,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircle,
  IconClose,
  IconDiff,
  IconExpand,
  IconFlatList,
  IconMore,
  IconStop,
  IconTarget,
  IconTerminal,
  IconTree,
  SLOT,
  defineUiPlugin,
  openDockTab,
  registerDockTab,
  setDockPreview,
  setDockSubagent,
  setDockWorkOutput,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
  useSeat,
  useService,
  useThreadView,
  type ActionsDecl,
  type BackgroundOutputView,
  type BackgroundWorkView,
  type DockTabBodyProps,
  type GoalView,
  type HostSnapshot,
  type PlanEntryView,
  type ScheduledTaskView,
  type StoreHandle,
  type TeammateView,
  type TodoItemView,
  type TodoView,
  type UiPluginApi,
} from '@dsc/ui'
import { readSessionId } from '@dsc/ui-primitives'
import {
  capsuleSummary,
  foldBucketKind,
  formatAgo,
  formatCountdown,
  formatDuration,
  longestElapsedMs,
  longestWorkElapsedMs,
  mateElapsedMs,
  todoFocusWindow,
  type CapsuleSummary,
  type FoldBucketKind,
} from './status-model'

/** 轮询间隔（毫秒）：队友名册在快照里没有，只能问通道。 */
const POLL_MS = 5000
/**
 * 后台活输出面的轮询间隔（毫秒）：只读输出面按秒拉一次快照（对照参考实现的 1s 轮询）。
 * 只在页签可见、且后台活还在运行时续拉（跑完的活不再变，停手）。
 */
const WORK_POLL_MS = 1000
/** 「跟到底」判定阈值（px）：距底部这个范围内算还在底部（照参考实现的 8px）。 */
const FOLLOW_BOTTOM_PX = 8
/**
 * Git 读数的轮询节奏（毫秒）：有改动最勤，干净仓库与「不是仓库」两档放松。
 * 没走快照面是因为宿主的 Git 读数是现算的（`git status` + `diff --numstat`），
 * 自己控制节奏比让宿主替所有会话定时算更省。
 */
/** 催拍的间隔下限（毫秒）：一拍刚跑过就别立刻再拍一次（换会话那一拍常与挂载那一拍重叠）。 */
const GIT_NUDGE_FLOOR_MS = 800

const GIT_POLL_DIRTY_MS = 12_000
const GIT_POLL_CLEAN_MS = 30_000
const GIT_POLL_IDLE_MS = 60_000
/** 单次读超过这个毫秒数就当仓库很大：下一拍按 3 倍退让（别在大仓上空转）。 */
const GIT_SLOW_MS = 2500
/** 时间读数的两档刷新：在跑的后台活要秒级；只有「多久前 / 还有多久」的读数秒级没用。 */
const CLOCK_FAST_MS = 1000
const CLOCK_SLOW_MS = 10_000
/** 自动档展开面板的最小宿主宽度（照 ZCode：1280px 以下收成胶囊）。 */
const AUTO_PANEL_MIN_WIDTH = 1280
/**
 * 定位锚选择器：正文区（壳打在 `.thread-main` / `.thread-main-empty` 上的 `data-thread-area`）。
 * 它是**宽度裁决**的锚（{@link AUTO_PANEL_MIN_WIDTH}）；portal 宿主取不到页签行时也回落用它。
 * **不认 `.chat-wrap`**（那个在空会话态只有内容高，认它这面板会锚到版心；
 * 见壳 `styles.css` 的 `[data-thread-area]` 规则）。
 */
const THREAD_AREA_SELECTOR = '[data-thread-area]'
/**
 * 默认落点：顶栏页签行（`.topbar .tabs`）的右端。那一行的右侧本来就是空的，胶囊摆那儿
 * 不压正文第一行（2026-11-02 用户截图：胶囊正好盖在消息流第一行的「思考 · 进行中」上）。
 * 手机档（<860px）没有这一行，回落正文区右上角。
 */
const TOPBAR_TABS_SELECTOR = '.topbar .tabs'
/** 展示档位的存档键（本机，跟人走而不跟会话走）。 */
const MODE_KEY = 'dsc.statusPanel.mode'
/** 胶囊位置的存档键（本机存档，与 {@link MODE_KEY} 同一套规矩；不跟会话走）。 */
const POS_KEY = 'dsc.statusPanel.pos'
/** 拖动判定阈值（px）：按下后位移没超过这个数就当点击，不当拖动。 */
const DRAG_SLOP = 4
/** 松手时离默认落点小于这个距离（px）就吸附回默认，并清掉存档。 */
const SNAP_BACK_PX = 24
/** 拖动范围离容器边缘的最小留白（px）：胶囊不顶在边上。 */
const DRAG_MARGIN = 8
/** 折叠桶预览卡的开 / 关延迟（ZCode 的 120ms / 80ms）：滑过不停留不弹卡。 */
const PREVIEW_OPEN_MS = 120
const PREVIEW_CLOSE_MS = 80

/** 三种展示档（与 ZCode 的 displayModeAuto / Expanded / Collapsed 同义）。 */
type DisplayMode = 'auto' | 'panel' | 'mini'

const MODE_LABEL: Readonly<Record<DisplayMode, string>> = {
  auto: '自动展开',
  panel: '始终展开',
  mini: '始终收起',
}

const MODE_ORDER: readonly DisplayMode[] = ['auto', 'panel', 'mini']

/** 读存档的展示档；认不出按自动。 */
function readMode(): DisplayMode {
  try {
    const raw = globalThis.localStorage?.getItem(MODE_KEY)
    return raw === 'panel' || raw === 'mini' || raw === 'auto' ? raw : 'auto'
  } catch {
    // 隐私模式 / 存储被禁：当自动，不影响面板本身能用。
    return 'auto'
  }
}

/** 写存档（写不进去不算失败——下次进来退回自动而已）。 */
function writeMode(mode: DisplayMode): void {
  try {
    globalThis.localStorage?.setItem(MODE_KEY, mode)
  } catch {
    // 同上：存档是锦上添花。
  }
}

/** 胶囊位置（相对默认落点的位移，px）。 */
type CapsulePos = { x: number; y: number }

/** 读存档的胶囊位置；没有、坏掉、不是有限数，一律当「没拖过」（回默认落点）。 */
function readPos(): CapsulePos | null {
  try {
    const raw = globalThis.localStorage?.getItem(POS_KEY)
    if (raw === null || raw === undefined) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const x = (parsed as { x?: unknown }).x
    const y = (parsed as { y?: unknown }).y
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x, y }
  } catch {
    // 隐私模式 / 存储被禁 / 存的是坏 JSON：都当没拖过。
    return null
  }
}

/** 写胶囊位置存档（写不进去不算失败——下次进来回到默认落点而已）。 */
function writePos(pos: CapsulePos): void {
  try {
    globalThis.localStorage?.setItem(POS_KEY, JSON.stringify(pos))
  } catch {
    // 同上：存档是锦上添花。
  }
}

/** 删掉胶囊位置存档（吸附回默认落点时用）。 */
function clearPos(): void {
  try {
    globalThis.localStorage?.removeItem(POS_KEY)
  } catch {
    // 同上。
  }
}

/** 把值夹进区间；区间反了（容器比胶囊还窄）就退化成 min，别把胶囊甩出容器。 */
function clampIn(value: number, min: number, max: number): number {
  return min > max ? min : Math.min(Math.max(value, min), max)
}

/** 位移的允许区间（相对默认落点的 px）。 */
type DragBounds = { minX: number; maxX: number; minY: number; maxY: number }

/**
 * 算位移允许区间：容器取 `.main`（取不到退正文区），内缩 {@link DRAG_MARGIN}；
 * 再结合 `.sp-host` 当前的 `getBoundingClientRect()` 倒推出它「没有位移时」在哪，
 * 于是区间就是「胶囊左缘 ≥ 容器左内缘、右缘 ≤ 容器右内缘」这两个不等式解出来的 x 范围。
 *
 * `applied` 是**此刻**已经生效的位移（不是想去的位移）：屏幕上量到的矩形含它，
 * 减掉才是基准位置。
 */
function dragBounds(hostEl: HTMLElement, applied: CapsulePos): DragBounds | null {
  const container = hostEl.closest('.main') ?? hostEl.closest(THREAD_AREA_SELECTOR)
  if (container === null) return null
  const frame = container.getBoundingClientRect()
  const rect = hostEl.getBoundingClientRect()
  const left = rect.left - applied.x
  const top = rect.top - applied.y
  return {
    minX: frame.left + DRAG_MARGIN - left,
    maxX: frame.right - DRAG_MARGIN - rect.width - left,
    minY: frame.top + DRAG_MARGIN - top,
    maxY: frame.bottom - DRAG_MARGIN - rect.height - top,
  }
}

/**
 * 七个分区各自的开合（顺序照 ZCode：Git 工具 / 目标 / 计划 / 进程 / 终端 / 工作流 / 智能体）。
 *
 * 默认：Git 工具 / 目标 / 进程展开；计划、终端、工作流、智能体收起——照 ZCode
 * 「活动列表默认收起」，回看性的目录（计划）也收起。
 */
type SectionId = 'git' | 'goal' | 'plan' | 'todo' | 'terminal' | 'workflow' | 'agent'
const DEFAULT_SECTION_OPEN: Readonly<Record<SectionId, boolean>> = {
  git: true,
  goal: true,
  plan: false,
  todo: true,
  terminal: false,
  workflow: false,
  agent: false,
}

/** 队友状态 → 数据属性（样式里靠它上色，与团队面板同一套词）。 */
const MATE_TONE: Readonly<Record<TeammateView['state'], string>> = {
  working: 'working',
  idle: 'idle',
  stopped: 'stopped',
  failed: 'failed',
}

/** 折叠桶的文案（状态语义，禁止用位置切片虚报状态）。 */
const FOLD_LABEL: Readonly<Record<FoldBucketKind, (count: number) => string>> = {
  completed: (count) => `已完成 ${String(count)} 项`,
  waiting: (count) => `待处理 ${String(count)} 项`,
  earlier: (count) => `前面 ${String(count)} 项`,
  later: (count) => `后面 ${String(count)} 项`,
}

/**
 * 名册席位的读面形状（team 插件 `ui.provide('teammates', handle)` 传出来的那份）。
 *
 * 插件之间不 import 彼此的实现（各自的 bundle 独立），只认这个形状：读 `list`，
 * 不碰写路径（停止队友等动作仍是直调界面通道的动作，不是状态）。
 */
interface MateSeatState {
  list: readonly TeammateView[]
}
type MateSeatHandle = StoreHandle<MateSeatState, ActionsDecl<MateSeatState>>

/** 服务名（provider 是 team 插件；缺席时回落到本地轮询）。 */
const TEAMMATES_SERVICE = 'teammates'
/** 「智能体目录在哪」的服务名（provider 是 team 插件：打开智能体团队面板）。 */
const TEAM_PANEL_SERVICE = 'teamPanel'

/** team 插件经服务表给出去的目录口子（已结束行点开团队面板）。 */
interface TeamPanelService {
  open(): void
}

export default defineUiPlugin({
  name: '状态面板',
  apply(ui) {
    // order 5：排在消息流（order 1）之后。它是浮层，排在哪一位都不进文档流，
    // 但排后面一点可以让它在 DOM 里晚于正文出现（自检按选择器取它更省事）。
    //
    // 组件是个 apply 期闭包：面板要在**渲染期**经 `ui.slots.seat(handle)` 读共享席位
    // （`ui` 只在 apply 里拿得到），闭包把槽位面交进去；组件身份每次装载生成一次，
    // 在插件生命周期里是稳定的。
    ui.slots.register(SLOT.main, { id: 'status.panel', order: 5 }, () => <StatusPanel slots={ui.slots} />)
    // 报名一种页签界面（kind = 'work-output'）：「终端」区点一行把那个后台活的**只读输出面**
    // 开到右侧栏（等宽 <pre> + 按秒轮询快照，不是交互式终端那条可写通道）。文本面与
    // 「用户自己开的 shell」（terminal 页签）是两套东西，别混。
    registerDockTab({
      kind: 'work-output',
      label: '输出',
      icon: <IconTerminal size={13} />,
      component: WorkOutputTab,
    })
  },
})

/** 一份任务投影（与任务条同一份读法：没有这个面或没有条目就是 null）。 */
function readTodos(snapshot: HostSnapshot | null): TodoView | null {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return null
  const todos = (surfaces as Record<string, unknown>)['todos']
  if (typeof todos !== 'object' || todos === null) return null
  const record = todos as Record<string, unknown>
  if (!Array.isArray(record['items']) || record['items'].length === 0) return null
  return todos as TodoView
}

/** 任务投影的相等判断：快照每帧换引用，不给判断会逐帧重画浮层。 */
function sameTodos(left: TodoView | null, right: TodoView | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  if (left.done !== right.done || left.total !== right.total || left.active !== right.active) return false
  if (left.items.length !== right.items.length) return false
  return left.items.every((item, index) => {
    const other = right.items[index]
    return other !== undefined && item.id === other.id && item.status === other.status && item.content === other.content
  })
}

/** 从快照里取会话目标面；没设目标（宿主给 null）或缺面时返回 null。 */
function readGoal(snapshot: HostSnapshot | null): GoalView | null {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return null
  const goal = (surfaces as Record<string, unknown>)['goal']
  return typeof goal === 'object' && goal !== null ? (goal as GoalView) : null
}

/** 目标投影的相等判断（逐帧推，不给判断会逐帧重画）。 */
function sameGoal(left: GoalView | null, right: GoalView | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  return (
    left.objective === right.objective &&
    left.phase === right.phase &&
    left.rounds === right.rounds &&
    left.maxRounds === right.maxRounds &&
    left.armed === right.armed &&
    left.blockedReason === right.blockedReason
  )
}

/** 名册列表的相等判断：轮询每 3/5 秒换一次引用，名单没变就别重画。 */
function sameMateList(left: readonly TeammateView[], right: readonly TeammateView[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((mate, index) => {
    const other = right[index]
    return (
      other !== undefined &&
      mate.file === other.file &&
      mate.state === other.state &&
      mate.task === other.task &&
      mate.startedAt === other.startedAt &&
      mate.finishedAt === other.finishedAt
    )
  })
}

/**
 * 当前会话的 jsonl 路径（只用于判「换工作区了」）。
 *
 * 为什么认路径而不是 `status.sessionId`：同一间工作区里换会话，git 读数一模一样，
 * 不必重拍；换到别的工作区的会话才要。路径是这两件事的最小判据。
 */
function readSessionPathKey(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return ''
  const path = (status as Record<string, unknown>)['sessionPath']
  return typeof path === 'string' ? path : ''
}

/** 当前会话的工作目录（git 指针指着谁）。 */
function readCwdKey(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return ''
  const cwd = (status as Record<string, unknown>)['cwd']
  return typeof cwd === 'string' ? cwd : ''
}

/** 回合状态（`idle` / 跑动…）：`跑动 → idle` 那一拍要重拍一次 git 读数。 */
function readTurnStateKey(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return 'idle'
  const value = (status as Record<string, unknown>)['turnState']
  return typeof value === 'string' ? value : 'idle'
}

/** Git 读数（本地轮询）：分支 + 增删行数 + 脏文件数（含 untracked）。 */
interface GitSummary {
  branch: string
  added: number
  removed: number
  files: number
}
/** Git 读数的相等判断（轮询每拍换新对象，读数没变就别重画面板）。 */
function sameGit(left: GitSummary | null, right: GitSummary | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  return left.branch === right.branch && left.added === right.added && left.removed === right.removed && left.files === right.files
}

/** 空表常量：选择器要返回**稳定引用**（每帧新建数组会被判成变化，逐帧重画）。 */
const NO_WORKS: readonly BackgroundWorkView[] = []
const NO_PLANS: readonly PlanEntryView[] = []
const NO_TASKS: readonly ScheduledTaskView[] = []

/** 从快照里取后台活清单（tools-default 贡献）；缺面 / 形状不对给空表。 */
function readBackgroundWorks(snapshot: HostSnapshot | null): readonly BackgroundWorkView[] {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return NO_WORKS
  const works = (surfaces as Record<string, unknown>)['backgroundWorks']
  return Array.isArray(works) ? (works as BackgroundWorkView[]) : NO_WORKS
}

/** 后台活清单的相等判断（快照每帧换引用，不给判断会逐帧重画）。 */
function sameWorks(left: readonly BackgroundWorkView[], right: readonly BackgroundWorkView[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((work, index) => {
    const other = right[index]
    return (
      other !== undefined &&
      work.id === other.id &&
      work.kind === other.kind &&
      work.title === other.title &&
      work.startedAt === other.startedAt
    )
  })
}

/** 从快照里取计划目录（plan 贡献）；缺面给空表。 */
function readPlanDirectory(snapshot: HostSnapshot | null): readonly PlanEntryView[] {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return NO_PLANS
  const plans = (surfaces as Record<string, unknown>)['planDirectory']
  return Array.isArray(plans) ? (plans as PlanEntryView[]) : NO_PLANS
}

/** 计划目录的相等判断：目录最多十几行，逐项比也便宜。 */
function samePlans(left: readonly PlanEntryView[], right: readonly PlanEntryView[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((plan, index) => {
    const other = right[index]
    return other !== undefined && plan.file === other.file && plan.title === other.title && plan.at === other.at
  })
}

/** 从快照里取定点任务（schedule 贡献）；插件关着时这一面整个缺席，给空表。 */
function readScheduled(snapshot: HostSnapshot | null): readonly ScheduledTaskView[] {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return NO_TASKS
  const tasks = (surfaces as Record<string, unknown>)['scheduled']
  return Array.isArray(tasks) ? (tasks as ScheduledTaskView[]) : NO_TASKS
}

/** 定点任务清单的相等判断。 */
function sameTasks(left: readonly ScheduledTaskView[], right: readonly ScheduledTaskView[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((task, index) => {
    const other = right[index]
    return (
      other !== undefined &&
      task.id === other.id &&
      task.title === other.title &&
      task.enabled === other.enabled &&
      task.nextRunAt === other.nextRunAt &&
      task.lastStatus === other.lastStatus &&
      task.lastError === other.lastError
    )
  })
}

/** 有没有悬停输入（精细指针）。没有（触屏）时折叠桶的预览卡改为点按开合。 */
function hasHoverInput(): boolean {
  return typeof window.matchMedia === 'function' ? !window.matchMedia('(hover: none)').matches : true
}

function StatusPanel({ slots }: { slots: UiPluginApi['slots'] }): ReactNode {
  const channel = useHostChannel()
  const view = useThreadView()
  const todos = useHostSelector(readTodos, sameTodos)
  const goal = useHostSelector(readGoal, sameGoal)
  const sessionId = useHostSelector(readSessionId)
  // 后台活 / 计划目录 / 定点任务：三份都是快照面（逐帧推），相等判断各自一份。
  const works = useHostSelector(readBackgroundWorks, sameWorks)
  const plans = useHostSelector(readPlanDirectory, samePlans)
  const scheduled = useHostSelector(readScheduled, sameTasks)
  // Git 读数走本地轮询（见文件头「数据」那一节）：不是仓库 / 读失败给 null，干净仓库也给 null。
  const [git, setGit] = useState<GitSummary | null>(null)
  // 当前会话的路径与工作目录：只用来判「换工作区了」，所以直接取字符串（不进渲染面）。
  const sessionPathKey = useHostSelector(readSessionPathKey)
  const cwdKey = useHostSelector(readCwdKey)
  const turnState = useHostSelector(readTurnStateKey)
  /**
   * Git 轮询的「立刻重拍」计数：自增即重挂轮询效果，挂载那一下就是一次 `git status`。
   * 两次催拍之间至少隔 {@link GIT_NUDGE_FLOOR_MS}——催拍是「立刻再取一次」，不是排队取 N 次。
   */
  const [gitNudge, setGitNudge] = useState(0)
  const lastGitPollRef = useRef(0)
  const nudgeGit = useCallback((): void => {
    if (Date.now() - lastGitPollRef.current < GIT_NUDGE_FLOOR_MS) return
    setGitNudge((value) => value + 1)
  }, [])
  // 名册来源（D3）：team 插件把席位 handle 经服务表传出来。
  //   有席位 → 读同一份共享实例（team 那个 3 秒轮询是唯一的数据源，这边不再自拉）；
  //   没席位（team 没装/被停用）→ 保留本地轮询（下面那段 effect）。
  // `useService` 订阅服务表的出现/消失，所以 team 启停后自动切源，不需要刷新页面。
  const seat = useService<MateSeatHandle>(TEAMMATES_SERVICE)
  // 智能体目录（团队面板）的口子：ended 行点它；服务缺席时那一行整行不渲染。
  const teamPanel = useService<TeamPanelService>(TEAM_PANEL_SERVICE)
  const instance = useMemo(
    () => (seat === undefined ? undefined : slots.seat(seat)),
    [slots, seat],
  )
  const shared = useSeat(instance, (state) => state.list)
  const [localMates, setLocalMates] = useState<readonly TeammateView[]>([])
  const usingShared = shared !== undefined
  const [mode, setMode] = useState<DisplayMode>(readMode)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sectionOpen, setSectionOpen] = useState<Record<SectionId, boolean>>({ ...DEFAULT_SECTION_OPEN })
  const [preview, setPreview] = useState<{ group: 'preceding' | 'following'; top: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const sentinel = useRef<HTMLDivElement | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  // 正文区（量宽度用）：它和 portal 宿主是两件事——落点可以在页签行，宽度裁决仍看正文区。
  const [area, setArea] = useState<HTMLElement | null>(null)
  // 胶囊的位置（相对默认落点的位移）：先读本机存档，没有就落默认点。
  const [pos, setPos] = useState<CapsulePos>(() => readPos() ?? { x: 0, y: 0 })
  // 位置的「最新真值」：拖动时每帧直接写 DOM（不 setState），松手才回灌状态。
  const posRef = useRef<CapsulePos>(pos)
  /** 拖动过程中的临时账本；null 表示现在没在拖。 */
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    baseX: number
    baseY: number
    bounds: DragBounds
    moved: boolean
    frame: number | null
    nextX: number
    nextY: number
  } | null>(null)
  // 真拖动过之后浏览器还会补一次 click：这个标记让那一次不展开面板。
  const suppressClickRef = useRef(false)
  // 可用宽度的初值也从正文区取（首帧就按正文区裁决，不闪一下）；量不到时按「宽」起步，
  // 下面的 ResizeObserver 会立刻纠正。**不读 window.innerWidth**——dock 开合改正文区宽
  // 不改窗口宽，按窗口判会在这两种情况里判错。
  const [avail, setAvail] = useState(() => {
    const el = typeof document === 'undefined' ? null : document.querySelector(THREAD_AREA_SELECTOR)
    return el instanceof HTMLElement && el.clientWidth > 0 ? el.clientWidth : AUTO_PANEL_MIN_WIDTH
  })

  // 落点与宽度锚一次性解析出来（换会话 / 换视图时重算）：
  //   落点（portal 目标）：优先顶栏页签行 `.topbar .tabs`——那一行右侧本来就是空的；
  //   取不到（手机档没有这一行）再回落正文区右上角。
  //   宽度锚：正文区 `[data-thread-area]`，与落点无关（自动档 1280px 的口径不跟着胶囊走）。
  // **不认 `.chat-wrap`**（右缘刻度条至今认它）：空会话态里它只有内容高、还被居中边距
  // 推着走，认它会把这面板锚到版心——0.6.67 用户报的「更改面板位置不对」就是这一条。
  useEffect(() => {
    const node = sentinel.current
    const tabs = document.querySelector(TOPBAR_TABS_SELECTOR)
    const nextHost: Element | null = tabs ?? node?.closest(THREAD_AREA_SELECTOR) ?? null
    setHost(nextHost instanceof HTMLElement ? nextHost : null)
    const nextArea = node?.closest(THREAD_AREA_SELECTOR) ?? null
    setArea(nextArea instanceof HTMLElement ? nextArea : null)
  }, [view])

  // 可用宽度：量**正文区**（不是 window、也不是胶囊的落点容器）——右边 dock 开合、左栏
  // 折叠都会改正文区的宽度而窗口宽度不动；旧版读 window.innerWidth，自动档在这两种情况下判错。
  useEffect(() => {
    if (area === null) return undefined
    const element = area
    const measure = (): void => setAvail(element.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [area])

  /** 落状态 + 落盘（拖动松手、窗口缩放夹取都走这一条，保证 ref 与 state 同步）。 */
  const commitPos = useCallback((next: CapsulePos): void => {
    posRef.current = next
    setPos(next)
    if (next.x === 0 && next.y === 0) clearPos()
    else writePos(next)
  }, [])

  /** 拖动起点：记下指针、基准位置与夹取区间；按钮上攥住指针，拖出窗口外再回来还接着拖。 */
  const onMiniPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    const hostEl = box.current
    if (hostEl === null) return
    const bounds = dragBounds(hostEl, posRef.current)
    if (bounds === null) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 合成事件没有活动指针时会抛：抓不住不影响拖动本身（只是拖出窗口会断）。
    }
    hostEl.setAttribute('data-dragging', '1')
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: posRef.current.x,
      baseY: posRef.current.y,
      bounds,
      moved: false,
      frame: null,
      nextX: posRef.current.x,
      nextY: posRef.current.y,
    }
  }, [])

  /**
   * 拖动中：位移没超过 {@link DRAG_SLOP} 就什么都不做（保持「点一下展开」的语义）；
   * 超过之后按帧合并——每帧最多写一次 `host.style.transform`，不走 setState，
   * 否则一秒一拍的时钟读数会陪着整棵面板一起重渲染。
   */
  const onMiniPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (drag === null || event.pointerId !== drag.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return
    drag.moved = true
    drag.nextX = clampIn(drag.baseX + dx, drag.bounds.minX, drag.bounds.maxX)
    drag.nextY = clampIn(drag.baseY + dy, drag.bounds.minY, drag.bounds.maxY)
    if (drag.frame !== null) return
    drag.frame = window.requestAnimationFrame(() => {
      drag.frame = null
      const hostEl = box.current
      if (hostEl === null) return
      hostEl.style.transform = `translate3d(${String(drag.nextX)}px, ${String(drag.nextY)}px, 0)`
    })
  }, [])

  /** 松手（含被系统打断）：真拖动过才落状态与存档；离默认点很近就吸附复位。 */
  const onMiniPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (drag === null || event.pointerId !== drag.pointerId) return
    dragRef.current = null
    if (drag.frame !== null) {
      window.cancelAnimationFrame(drag.frame)
      drag.frame = null
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // 指针已经没了（pointercancel）：放开是幂等的，抛了就算了。
    }
    box.current?.removeAttribute('data-dragging')
    if (!drag.moved) return
    // 拖动结束后按钮还会收到一次 click：吞掉它，不然拖完就弹开面板。
    suppressClickRef.current = true
    const moved: CapsulePos = { x: drag.nextX, y: drag.nextY }
    // 离默认落点太近就吸附回去并忘掉存档，下次进来还是默认点。
    const final: CapsulePos = Math.hypot(moved.x, moved.y) < SNAP_BACK_PX ? { x: 0, y: 0 } : moved
    // 最终位移在这里手写一次：吸附回 0 时状态值与上一帧相同，React 见样式没变不会重写
    // DOM，胶囊会停在拖到的位置上（这就是那次「松手了它不回家」的来源）。
    const hostEl = box.current
    if (hostEl !== null) hostEl.style.transform = `translate3d(${String(final.x)}px, ${String(final.y)}px, 0)`
    commitPos(final)
  }, [commitPos])

  // 窗口变小 / dock 打开：把已记住的位置重新夹进可见范围（夹过就写回状态与存档）。
  useEffect(() => {
    if (host === null) return undefined
    const onResize = (): void => {
      const hostEl = box.current
      if (hostEl === null) return
      const bounds = dragBounds(hostEl, posRef.current)
      if (bounds === null) return
      const current = posRef.current
      const clamped: CapsulePos = {
        x: clampIn(current.x, bounds.minX, bounds.maxX),
        y: clampIn(current.y, bounds.minY, bounds.maxY),
      }
      if (clamped.x === current.x && clamped.y === current.y) return
      commitPos(clamped)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [host, commitPos])

  // 名册本地轮询（回落到「没有共享席位」时才跑）：页面不可见时不问（后台省心跳），
  // 切回可见立刻补一拍。共享席位出现时这条 effect 被拆掉，轮询随之停止。
  useEffect(() => {
    if (usingShared) return undefined
    let alive = true
    const poll = (): void => {
      if (document.visibilityState === 'hidden') return
      void channel
        .invoke<TeammateView[]>('listTeammates', [])
        .then((list) => {
          if (!alive) return
          const next = Array.isArray(list) ? list : []
          setLocalMates((current) => (sameMateList(current, next) ? current : next))
        })
        .catch(() => {
          // team 服务缺席（子智能体插件没开）时名册就是空的：给空态而不是报错条。
          if (alive) setLocalMates((current) => (current.length === 0 ? current : []))
        })
    }
    poll()
    const timer = window.setInterval(poll, POLL_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [channel, usingShared])

  /**
   * Git 读数：本地轮询（`dock git-status` 是读类 op，界面通道直接放行）。
   *
   * 三档节奏（有改动 12s / 干净 30s / 不是仓库 60s）＋一个慢仓库退让：单拍耗时超过
   * {@link GIT_SLOW_MS} 就按 3 倍间隔走——在大仓里每 12 秒跑一次 `git status` 是拿
   * 用户的 CPU 换一行读数，不值。页面不可见不拍，切回可见立刻补一拍。
   *
   * 光靠定时器不够（0.6.67 报障「编辑了文件后 git 胶囊没出现」）：拍与拍之间最长能隔
   * 60 秒，而**刚写完文件的那几秒正是用户盯着面板看的时候**。所以另有两处**事件催拍**
   * （见下面的 nudge 效果）：换工作区、以及回合收工。参考实现同样不只看时钟——dsh 在
   * 回合边界（`turn/start` 与 `turn/end`）拍工作树快照，ZCode 则在工作区变化与显式刷新
   * （提交/切分支）时重取；两家的定时那一档都不宽于 dsc 这三档。
   *
   * `gitNudge` 进依赖清单就是「立刻重拍一次」：自增 → 本效果重挂 → 挂载即 `tick()`。
   */
  useEffect(() => {
    let alive = true
    let timer: number | null = null
    function stopTimer(): void {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
    }
    function schedule(ms: number): void {
      if (!alive) return
      timer = window.setTimeout(tick, ms)
    }
    function settle(base: number, startedAt: number): void {
      const took = Date.now() - startedAt
      schedule(took > GIT_SLOW_MS ? base * 3 : base)
    }
    function tick(): void {
      stopTimer()
      if (document.visibilityState === 'hidden') {
        schedule(GIT_POLL_DIRTY_MS)
        return
      }
      const startedAt = Date.now()
      lastGitPollRef.current = startedAt
      void channel
        .invoke<Record<string, unknown>>('dock', ['git-status', { stats: true }])
        .then((data) => {
          if (!alive) return
          const added = typeof data?.['added'] === 'number' ? data['added'] : 0
          const removed = typeof data?.['removed'] === 'number' ? data['removed'] : 0
          const files = typeof data?.['dirtyFileCount'] === 'number' ? data['dirtyFileCount'] : 0
          const branch = typeof data?.['branch'] === 'string' ? data['branch'] : ''
          const next: GitSummary | null = files > 0 || added + removed > 0 ? { branch, added, removed, files } : null
          setGit((current) => (sameGit(current, next) ? current : next))
          settle(next === null ? GIT_POLL_CLEAN_MS : GIT_POLL_DIRTY_MS, startedAt)
        })
        .catch(() => {
          if (!alive) return
          // 不是仓库 / 读不动：整区与胶囊那一档一起消失，节奏放松到最慢一档。
          setGit((current) => (current === null ? current : null))
          settle(GIT_POLL_IDLE_MS, startedAt)
        })
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    tick()
    return () => {
      alive = false
      stopTimer()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [channel, gitNudge])

  /** 换工作区（切会话 / 换目录）：指针指着的仓库变了，读数当场重取。 */
  useEffect(() => {
    nudgeGit()
  }, [sessionPathKey, cwdKey, nudgeGit])

  /**
   * 回合收工：这一轮可能落了文件，而「刚写完」正是用户看面板的那一刻。
   * 与 dsh 的回合边界口径一致（它在 `turn/end` 拍工作树快照）。
   */
  const previousTurnState = useRef(turnState)
  useEffect(() => {
    const was = previousTurnState.current
    previousTurnState.current = turnState
    if (was !== 'idle' && turnState === 'idle') nudgeGit()
  }, [turnState, nudgeGit])

  const mates = shared ?? localMates
  const mine = useMemo(
    () => (sessionId === null ? [] : mates.filter((mate) => mate.sessionId === sessionId)),
    [mates, sessionId],
  )
  const running = useMemo(() => mine.filter((mate) => mate.state === 'working'), [mine])
  const ended = useMemo(() => mine.filter((mate) => mate.state !== 'working'), [mine])
  /** 现在展开成面板没有：显式档直接定，自动档看宿主够不够宽（见 AUTO_PANEL_MIN_WIDTH）。 */
  const expanded = mode === 'panel' || (mode === 'auto' && avail >= AUTO_PANEL_MIN_WIDTH)

  // 时间读数分两档（面板收起时两档都不跑：胶囊上没有秒级 / 分钟级读数）：
  //   快档：有在跑的后台活（队友 / 作业 / 终端）才要秒级时长；
  //   慢档：只有「多久前 / 还有多久」这类读数（计划目录的 mtime、定点任务的下次时间），
  //   10 秒一拍足够——旧版只要有面板就常驻一条 1s 定时器，这里按需起。
  const fastClock = expanded && (running.length > 0 || works.length > 0)
  const slowClock = expanded && (scheduled.length > 0 || plans.length > 0)
  useEffect(() => {
    if (!fastClock) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_FAST_MS)
    return () => window.clearInterval(timer)
  }, [fastClock])
  useEffect(() => {
    if (fastClock || !slowClock) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_SLOW_MS)
    return () => window.clearInterval(timer)
  }, [fastClock, slowClock])

  /** 在跑的定点任务（「工作流」区第一档 + 胶囊第一档；任务表里至多一条在跑）。 */
  const runningTask = useMemo(
    () => scheduled.find((task) => task.lastStatus === 'running')?.title ?? null,
    [scheduled],
  )
  const summary = useMemo(
    () =>
      capsuleSummary({
        todos,
        goal,
        runningMates: running.length,
        git,
        plans,
        runningWorks: works,
        runningTask,
        endedMates: ended.length,
      }),
    [todos, goal, running.length, git, plans, works, runningTask, ended.length],
  )
  /** 折叠桶的窗口（卡片与分区行共用同一份划分，避免两处算法漂移）。 */
  const foldWindow = useMemo(() => todoFocusWindow(todos?.items ?? []), [todos])

  // 任务快照一变，已展开的折叠桶预览关掉（窗口按新快照重算）——ZCode 同款裁定，
  // renderer 本地状态，不写 session / store。
  const todoSignature = useMemo(
    () => (todos === null ? '' : todos.items.map((item) => `${item.id}\u0000${item.content}\u0000${item.status}`).join('\u0001')),
    [todos],
  )
  useEffect(() => {
    setPreview(null)
  }, [todoSignature])

  // 预览卡：开 / 关都带延迟（滑过不停留不弹卡）；从折叠行移到卡片上算「还在里面」
  // （两边共用这一对定时器，卡片不闪）。
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const clearTimers = useCallback((): void => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current)
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    openTimer.current = null
    closeTimer.current = null
  }, [])
  const scheduleOpen = useCallback(
    (group: 'preceding' | 'following', element: HTMLElement): void => {
      clearTimers()
      const anchor = box.current
      const top = anchor === null ? 0 : element.getBoundingClientRect().top - anchor.getBoundingClientRect().top
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null
        setPreview({ group, top })
      }, PREVIEW_OPEN_MS)
    },
    [clearTimers],
  )
  const scheduleClose = useCallback((): void => {
    clearTimers()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setPreview(null)
    }, PREVIEW_CLOSE_MS)
  }, [clearTimers])
  const keepPreviewOpen = clearTimers
  /** 触屏点按：不做延迟，立刻开 / 关（没有 hover 可等）。 */
  const openPreviewNow = useCallback(
    (group: 'preceding' | 'following', element: HTMLElement): void => {
      clearTimers()
      const anchor = box.current
      const top = anchor === null ? 0 : element.getBoundingClientRect().top - anchor.getBoundingClientRect().top
      setPreview({ group, top })
    },
    [clearTimers],
  )
  useEffect(() => clearTimers, [clearTimers])
  useEffect(() => {
    if (preview === null) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  const stopMate = (mate: TeammateView): void => {
    void channel
      .invoke('stopTeammate', [mate.name])
      .then(() => toastOk(`已叫停 ${mate.name}`))
      .catch((reason: unknown) => toastErr(`叫停失败：${reason instanceof Error ? reason.message : String(reason)}`))
  }

  /** 收掉一个正在跑的后台作业 / 终端会话（「终端」区行尾的停止钮）。 */
  const stopWork = (work: BackgroundWorkView): void => {
    void channel
      .invoke<string>('stopBackground', [work.id])
      .then((text) => {
        toastOk(typeof text === 'string' && text.trim() !== '' ? text : `已收掉 ${work.id}`)
      })
      .catch((reason: unknown) => {
        toastErr(`收不掉：${reason instanceof Error ? reason.message : String(reason)}`)
      })
  }

  /** 点开一个后台活的**只读输出面**（右侧栏的 work-output 页签）。与「停止」两个动作分开。 */
  const openWork = (work: BackgroundWorkView): void => {
    setDockWorkOutput({ id: work.id, label: work.title })
  }

  /** 清空任务清单（原任务条上那颗钮——任务条撤了，动作搬进「进程」区）。 */
  const clearTodos = (): void => {
    void channel
      .invoke('clearTodos', [])
      .then(() => {
        toastOk('任务清单已清空')
      })
      .catch((reason: unknown) => {
        toastErr(`清空失败：${reason instanceof Error ? reason.message : String(reason)}`)
      })
  }

  const goalAction = (name: 'pause' | 'resume', tip: string): void => {
    void channel
      .invoke('goalAction', [name])
      .then(() => toastOk(tip))
      .catch((reason: unknown) => toastErr(`目标操作失败：${reason instanceof Error ? reason.message : String(reason)}`))
  }

  const chooseMode = (next: DisplayMode): void => {
    setMenuOpen(false)
    setMode(next)
    writeMode(next)
  }

  const toggleSection = (id: SectionId): void => {
    setSectionOpen((current) => ({ ...current, [id]: !current[id] }))
  }

  // 七处都空时整块不画：浮层不该在无事可报时占着右上角。
  // 与 ZCode 的一处**有意偏离**：已结束的队友也算「有事」——标题栏那颗「智能体团队」
  // 钮撤掉之后，本会话的队伍只剩这一区的「已结束 · N ›」目录行一个入口，全空就真进不去了
  // （胶囊链最后那一档 mates-ended 也是为它留的）。
  const hasData =
    todos !== null ||
    goal !== null ||
    mine.length > 0 ||
    git !== null ||
    plans.length > 0 ||
    works.length > 0 ||
    scheduled.length > 0
  // 分区可见性（渲染顺序照 ZCode：Git 工具 / 目标 / 计划 / 进程 / 终端 / 工作流 / 智能体）。
  const showGit = git !== null
  const showGoal = goal !== null
  const showPlan = plans.length > 0
  const showTodo = todos !== null
  const showTerminal = works.length > 0
  const showWorkflow = scheduled.length > 0
  // 分割线依据：按渲染顺序算「这个分区之上有没有可显示的分区」（纯算式，不引入状态）。
  const sepGoal = showGit
  const sepPlan = showGit || showGoal
  const sepTodo = showGit || showGoal || showPlan
  const sepTerminal = sepTodo || showTodo
  const sepWorkflow = sepTerminal || showTerminal
  const sepAgent = sepWorkflow || showWorkflow
  const panel =
    hasData && view === 'chat' ? (
      <div
        className="sp-host"
        ref={box}
        // 面板宽度上限以正文区宽度为准（窄正文里 320px 浮层会盖掉半篇正文）。
        // 位移一律照写（为 0 也写）：拖动时同一份写法则每帧直接改 DOM，两条路不给两套代码。
        style={
          {
            '--sp-avail': `${String(avail)}px`,
            transform: `translate3d(${String(pos.x)}px, ${String(pos.y)}px, 0)`,
          } as CSSProperties
        }
      >
        <aside
          className="sp"
          data-display-mode={mode}
          data-expanded={expanded ? '1' : '0'}
          aria-label="状态"
        >
          {/* 收起态：一颗药丸。同一棵 DOM 里常驻，展开时靠 CSS 藏起来（过渡不断）。
              展开态没有这颗按钮，所以「按住拖动」天然只在收起态生效。 */}
          <button
            type="button"
            className="sp-mini"
            data-sp-mini="1"
            aria-label="展开状态面板"
            aria-hidden={expanded}
            tabIndex={expanded ? -1 : 0}
            inert={expanded}
            data-tip="展开状态面板（按住可以拖动）"
            onPointerDown={onMiniPointerDown}
            onPointerMove={onMiniPointerMove}
            onPointerUp={onMiniPointerUp}
            onPointerCancel={onMiniPointerUp}
            onClick={() => {
              // 刚拖完松手时浏览器会补一次 click：这一次只清标记，不展开。
              if (suppressClickRef.current) {
                suppressClickRef.current = false
                return
              }
              chooseMode('panel')
            }}
          >
            <MiniSummary summary={summary} />
          </button>
          {/* 展开态：标题栏 + 分区列表。收起时同样靠 CSS 藏起来（位置绝对，不占尺寸）。 */}
          <div className="sp-panel" aria-hidden={!expanded} inert={!expanded}>
            <div className="sp-toolbar">
              <button
                type="button"
                className="sp-icon-btn"
                aria-label="展开策略"
                data-tip={`状态面板展开策略：${MODE_LABEL[mode]}`}
                aria-expanded={menuOpen}
                onClick={() => {
                  setMenuOpen((open) => !open)
                }}
              >
                <IconMore size={13} />
              </button>
              <button
                type="button"
                className="sp-icon-btn"
                aria-label="收起为胶囊"
                data-tip="收起为胶囊"
                onClick={() => {
                  chooseMode('mini')
                }}
              >
                <IconChevronDown size={13} />
              </button>
              {menuOpen ? (
                <>
                  <div
                    className="sp-mask"
                    onClick={() => {
                      setMenuOpen(false)
                    }}
                  />
                  <div className="sp-menu" role="menu" aria-label="展开策略">
                    {MODE_ORDER.map((item) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={item === mode}
                        key={item}
                        className={`sp-menu-item${item === mode ? ' on' : ''}`}
                        onClick={() => {
                          chooseMode(item)
                        }}
                      >
                        {MODE_LABEL[item]}
                        {item === mode ? <IconCheck size={12} /> : null}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
            <div className="sp-scroll">
              {showGit && git !== null ? (
                <GitSection
                  git={git}
                  open={sectionOpen.git}
                  separated={false}
                  onToggle={() => {
                    toggleSection('git')
                  }}
                />
              ) : null}
              {showGoal && goal !== null ? (
                <GoalSection
                  goal={goal}
                  open={sectionOpen.goal}
                  separated={sepGoal}
                  onToggle={() => {
                    toggleSection('goal')
                  }}
                  onAction={goalAction}
                />
              ) : null}
              {showPlan ? (
                <PlanSection
                  plans={plans}
                  now={now}
                  open={sectionOpen.plan}
                  separated={sepPlan}
                  onToggle={() => {
                    toggleSection('plan')
                  }}
                />
              ) : null}
              <TodoSection
                todos={todos}
                open={sectionOpen.todo}
                separated={sepTodo}
                onToggle={() => {
                  toggleSection('todo')
                }}
                onClear={clearTodos}
                previewOpen={preview === null ? null : preview.group}
                onPreviewOpen={(group, element) => {
                  scheduleOpen(group, element)
                }}
                onPreviewClose={scheduleClose}
                onPreviewTouch={openPreviewNow}
                onPreviewKeep={keepPreviewOpen}
              />
              {showTerminal ? (
                <WorkSection
                  works={works}
                  now={now}
                  open={sectionOpen.terminal}
                  separated={sepTerminal}
                  onToggle={() => {
                    toggleSection('terminal')
                  }}
                  onOpen={openWork}
                  onStop={stopWork}
                />
              ) : null}
              {showWorkflow ? (
                <WorkflowSection
                  tasks={scheduled}
                  now={now}
                  open={sectionOpen.workflow}
                  separated={sepWorkflow}
                  onToggle={() => {
                    toggleSection('workflow')
                  }}
                />
              ) : null}
              <AgentSection
                running={running}
                endedCount={ended.length}
                now={now}
                open={sectionOpen.agent}
                separated={sepAgent}
                onToggle={() => {
                  toggleSection('agent')
                }}
                onStop={stopMate}
                onOpen={(mate) => {
                  setDockSubagent({ path: mate.file, label: mate.name })
                }}
                onOpenDirectory={teamPanel === undefined ? undefined : () => {
                  teamPanel.open()
                }}
              />
            </div>
          </div>
        </aside>
        {preview !== null ? (
          <FoldPreviewCard
            group={preview.group}
            items={preview.group === 'preceding' ? foldWindow.preceding : foldWindow.following}
            top={preview.top}
            onEnter={keepPreviewOpen}
            onLeave={scheduleClose}
          />
        ) : null}
      </div>
    ) : (
      <div className="sp-host" hidden />
    )

  return (
    <>
      {/* 哨兵：只负责给出定位父级（正文区那一格），自己永远不可见也不占位。 */}
      <div ref={sentinel} hidden />
      {host === null ? null : createPortal(panel, host)}
    </>
  )
}

/** 胶囊里的那一条摘要（图标 + 文案 + 可选读数），图标在 hover / focus 时换成「展开」。 */
function MiniSummary({ summary }: { summary: CapsuleSummary | null }): ReactNode {
  if (summary === null) return null
  let icon: ReactNode
  let text: ReactNode
  let trail: ReactNode = null
  if (summary.kind === 'workflow') {
    icon = <IconCalendar size={13} className="sp-icon-run" />
    text = summary.text
  } else if (summary.kind === 'todo-current') {
    icon = <IconArrowRight size={13} />
    text = summary.text
  } else if (summary.kind === 'goal') {
    icon = <IconTarget size={13} />
    text = summary.text
  } else if (summary.kind === 'git') {
    icon = <IconDiff size={13} />
    text = '更改'
    // 胶囊不再报增删行数（2026-10-27 用户：+/- 行数只在「编辑文件」的操作上显示）。
    // 原因是这一格量的是**整个工作区**相对 HEAD 的差（含不是这次会话改的、含还没提交的），
    // 挂在常驻胶囊上就是一个一直在跳、又对不上任何一次操作的读数；真要按行数看改动，
    // 工具卡（写入 / 编辑）与轮尾「文件已更改」卡上那一份才是「这次改了什么」。
    // 文件数留着：它是「有没有东西没提交」的粗读数，不冒充某一次操作的量。
  } else if (summary.kind === 'goal-done') {
    icon = <IconTarget size={13} className="sp-icon-done" />
    text = summary.text
  } else if (summary.kind === 'todo-done') {
    icon = <IconCheck size={13} className="sp-icon-done" />
    text = summary.text
  } else if (summary.kind === 'progress') {
    icon = <IconFlatList size={13} />
    text = '进程'
    trail = `${String(summary.done)}/${String(summary.total)}`
  } else if (summary.kind === 'plan') {
    icon = <IconFlatList size={13} />
    text = summary.text
  } else if (summary.kind === 'running') {
    // 混合（队友 + 后台活）给「都算上」的总数，单一种类给各自的说法（照 ZCode 的兜底档）。
    if (summary.mates > 0 && summary.works > 0) {
      icon = <IconActivity size={13} />
      text = `${String(summary.mates + summary.works)} 项在跑`
    } else if (summary.works > 0) {
      icon = <IconTerminal size={13} />
      text = `${String(summary.works)} 个后台任务`
    } else {
      icon = <IconTree size={13} />
      text = `${String(summary.mates)} 个智能体在跑`
    }
  } else {
    icon = <IconTree size={13} />
    text = `已结束 ${String(summary.count)} 个智能体`
  }
  return (
    <>
      <span className="sp-mini-icon">
        {icon}
        <IconExpand size={13} className="sp-mini-expand" />
      </span>
      <span className="sp-mini-text" title={typeof text === 'string' ? text : undefined}>
        {text}
      </span>
      {trail === null ? null : <span className="sp-mini-trail">{trail}</span>}
    </>
  )
}

/** 分区骨架：标题行（整行可点收起 / 展开）+ 折叠体（限高滚动在体内）。 */
function StatusSectionBlock({
  id,
  title,
  trail,
  open,
  separated,
  onToggle,
  children,
}: {
  id: SectionId
  title: string
  trail: ReactNode
  open: boolean
  separated: boolean
  onToggle(): void
  children: ReactNode
}): ReactNode {
  return (
    <section
      className="sp-section"
      data-sp-section={id}
      data-sp-open={open ? '1' : '0'}
      data-separated={separated ? '1' : undefined}
    >
      <button
        type="button"
        className="sp-section-head"
        aria-expanded={open}
        data-sp-section-trigger={id}
        onClick={onToggle}
      >
        <span className="sp-section-title">{title}</span>
        {open ? (
          <IconChevronUp size={12} className="sp-section-caret" />
        ) : (
          <IconChevronDown size={12} className="sp-section-caret" />
        )}
        <span className="sp-section-trail">{trail}</span>
      </button>
      <div className="sp-section-body">
        <div className="sp-section-scroll" data-sp-section-scroll={id}>
          {children}
        </div>
      </div>
    </section>
  )
}

/** 目标节：目标正文 + 相位 / 轮次读数 + 暂停 / 继续（与目标条同一个 `goalAction`）。 */
function GoalSection({
  goal,
  open,
  separated,
  onToggle,
  onAction,
}: {
  goal: GoalView
  open: boolean
  separated: boolean
  onToggle(): void
  onAction(name: 'pause' | 'resume', tip: string): void
}): ReactNode {
  const phaseText =
    goal.phase === 'active'
      ? goal.armed
        ? '自动续跑中'
        : '已建立（未上膛）'
      : goal.phase === 'paused'
        ? '已暂停'
        : goal.phase === 'blocked'
          ? '已阻塞'
          : '已完成'
  return (
    <StatusSectionBlock
      id="goal"
      title="目标"
      open={open}
      separated={separated}
      onToggle={onToggle}
      trail={`${String(goal.rounds)}/${String(goal.maxRounds)} 轮`}
    >
      <div className="sp-goal" data-goal-phase={goal.phase}>
        <IconTarget size={14} className="sp-icon sp-icon-goal" />
        <p className="sp-goal-text" title={goal.blockedReason ?? goal.objective}>
          {goal.objective}
        </p>
        {goal.phase === 'active' ? (
          <button
            type="button"
            className="sp-goal-btn"
            data-tip="暂停自动续跑（不会打断当前这一轮）"
            onClick={() => {
              onAction('pause', '目标已暂停')
            }}
          >
            暂停
          </button>
        ) : goal.phase !== 'complete' ? (
          <button
            type="button"
            className="sp-goal-btn"
            data-tip="继续自动续跑"
            onClick={() => {
              onAction('resume', '目标已继续')
            }}
          >
            继续
          </button>
        ) : null}
      </div>
      <p className="sp-goal-state">
        {phaseText} · {String(goal.rounds)}/{String(goal.maxRounds)} 轮
      </p>
    </StatusSectionBlock>
  )
}

/** 进程行的一条（列表 / 预览卡共用）：三态图标 + 两行截断正文（全文留在 title 里）。 */
const TodoRow = memo(function TodoRow({ item }: { item: TodoItemView }): ReactNode {
  return (
    <li className="sp-row" data-status={item.status}>
      <TodoStatusIcon status={item.status} />
      <span className="sp-row-text" title={item.content}>
        {item.content}
      </span>
      {item.parent === undefined ? null : <span className="sp-row-note">子任务</span>}
    </li>
  )
})

/** 待办三态图标：进行中（箭头）/ 办完（对勾、划掉）/ 待办（空心圈）/ 取消（叉）。 */
function TodoStatusIcon({ status }: { status: TodoItemView['status'] }): ReactNode {
  if (status === 'completed') return <IconCheck size={13} className="sp-icon sp-icon-done" />
  if (status === 'cancelled') return <IconClose size={12} className="sp-icon sp-icon-cancel" />
  if (status === 'in_progress') return <IconArrowRight size={13} className="sp-icon sp-icon-run" />
  return <IconCircle size={13} className="sp-icon sp-icon-wait" />
}

/**
 * 进程节：标题行读数常显 `done/total`；列表 = 聚焦窗口（≤6 条全显；更多时窗口 3 条 +
 * 前后折叠桶，hover / focus（触屏点按）出预览卡看整桶，点卡片外或 Escape 关）。
 */
function TodoSection({
  todos,
  open,
  separated,
  onToggle,
  onClear,
  previewOpen,
  onPreviewOpen,
  onPreviewClose,
  onPreviewTouch,
  onPreviewKeep,
}: {
  todos: TodoView | null
  open: boolean
  separated: boolean
  onToggle(): void
  /** 清空清单（原任务条上那颗钮，随任务条撤掉搬进这里）。 */
  onClear(): void
  previewOpen: 'preceding' | 'following' | null
  onPreviewOpen(group: 'preceding' | 'following', element: HTMLElement): void
  onPreviewClose(): void
  onPreviewTouch(group: 'preceding' | 'following', element: HTMLElement): void
  onPreviewKeep(): void
}): ReactNode {
  if (todos === null) return null
  const window = todoFocusWindow(todos.items)
  return (
    <StatusSectionBlock
      id="todo"
      title="进程"
      open={open}
      separated={separated}
      onToggle={onToggle}
      trail={
        <span
          className="sp-section-trail"
          data-sp-progress={`${String(todos.done)}/${String(todos.total)}`}
          data-sp-complete={todos.total > 0 && todos.done >= todos.total ? '1' : '0'}
        >
          {`${String(todos.done)}/${String(todos.total)}`}
        </span>
      }
    >
      <ul className="sp-list">
        {window.compact && window.preceding.length > 0 ? (
          <li>
            <FoldRow
              group="preceding"
              items={window.preceding}
              open={previewOpen === 'preceding'}
              onPreviewOpen={onPreviewOpen}
              onPreviewClose={onPreviewClose}
              onPreviewTouch={onPreviewTouch}
            />
          </li>
        ) : null}
        {window.focus.map((item) => (
          <TodoRow key={item.id} item={item} />
        ))}
        {window.compact && window.following.length > 0 ? (
          <li>
            <FoldRow
              group="following"
              items={window.following}
              open={previewOpen === 'following'}
              onPreviewOpen={onPreviewOpen}
              onPreviewClose={onPreviewClose}
              onPreviewTouch={onPreviewTouch}
            />
          </li>
        ) : null}
      </ul>
      {todos.total > 0 ? (
        <div className="sp-row-foot">
          <button
            type="button"
            className="sp-clear"
            data-sp-clear="1"
            data-tip="清空任务清单（模型下一次更新清单会重建它）"
            onClick={onClear}
          >
            清空清单
          </button>
        </div>
      ) : null}
    </StatusSectionBlock>
  )
}

/** 折叠桶那一行：桌面 hover / focus（120ms）开预览，触屏点按立刻开合；离开（80ms）关。 */
function FoldRow({
  group,
  items,
  open,
  onPreviewOpen,
  onPreviewClose,
  onPreviewTouch,
}: {
  group: 'preceding' | 'following'
  items: readonly TodoItemView[]
  open: boolean
  onPreviewOpen(group: 'preceding' | 'following', element: HTMLElement): void
  onPreviewClose(): void
  onPreviewTouch(group: 'preceding' | 'following', element: HTMLElement): void
}): ReactNode {
  const label = FOLD_LABEL[foldBucketKind(items, group)](items.length)
  return (
    <button
      type="button"
      className="sp-fold"
      data-sp-fold={group}
      aria-expanded={open}
      title={label}
      onMouseEnter={(event) => {
        onPreviewOpen(group, event.currentTarget)
      }}
      onMouseLeave={onPreviewClose}
      onFocus={(event) => {
        onPreviewOpen(group, event.currentTarget)
      }}
      onBlur={onPreviewClose}
      onClick={(event) => {
        // 无悬停输入（触屏）才把点按当开合；桌面点击不反转 hover 已经打开的卡。
        if (hasHoverInput()) return
        if (open) onPreviewClose()
        else onPreviewTouch(group, event.currentTarget)
      }}
    >
      <IconChevronLeft size={12} />
      <span className="sp-fold-text">{label}</span>
    </button>
  )
}

/** 折叠桶的预览卡：浮在面板左侧，整桶按原序列出（只读；轮子滚卡内列表）。 */
function FoldPreviewCard({
  group,
  items,
  top,
  onEnter,
  onLeave,
}: {
  group: 'preceding' | 'following'
  items: readonly TodoItemView[]
  top: number
  onEnter(): void
  onLeave(): void
}): ReactNode {
  if (items.length === 0) return null
  const label = FOLD_LABEL[foldBucketKind(items, group)](items.length)
  return (
    <div
      className="sp-card"
      data-sp-card={group}
      role="tooltip"
      style={{ top }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <p className="sp-card-head">{label}</p>
      <ul className="sp-card-list">
        {items.map((item) => (
          <TodoRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  )
}

/**
 * 智能体节：只列**在跑的**（两行行：名字 + 已运行 + 停止；点行落右侧栏看运行记录）；
 * 收工的折成「已结束 · N ›」一条目录行——点开团队面板（team 插件的 `teamPanel` 服务），
 * 服务缺席（team 没装）时整行不渲染。折叠态读数 = 最长运行时长 · N 运行。
 */
function AgentSection({
  running,
  endedCount,
  now,
  open,
  separated,
  onToggle,
  onStop,
  onOpen,
  onOpenDirectory,
}: {
  running: readonly TeammateView[]
  endedCount: number
  now: number
  open: boolean
  separated: boolean
  onToggle(): void
  onStop(mate: TeammateView): void
  onOpen(mate: TeammateView): void
  onOpenDirectory?: () => void
}): ReactNode {
  if (running.length === 0 && endedCount === 0) return null
  const ordered = [...running].sort((left, right) => left.startedAt - right.startedAt)
  const longest = formatDuration(longestElapsedMs(running, now))
  const trail =
    running.length === 0 ? '' : open ? `${String(running.length)} 运行` : `${longest ?? ''} · ${String(running.length)} 运行`
  return (
    <StatusSectionBlock id="agent" title="智能体" open={open} separated={separated} onToggle={onToggle} trail={trail}>
      <ul className="sp-list">
        {ordered.map((mate) => {
          const elapsed = formatDuration(mateElapsedMs(mate, now))
          return (
            <li className="sp-row sp-row-agent" data-state={MATE_TONE[mate.state]} key={mate.file}>
              {/* 整行可点：落到右侧栏看它的运行记录（行内按钮各自 stopPropagation）。 */}
              <button
                type="button"
                className="sp-row-open"
                aria-label={`打开 ${mate.name} 的运行记录`}
                data-sp-agent={mate.name}
                data-tip={`${mate.role} · ${mate.task}\n点开在右侧边栏看它的运行记录（只读）`}
                onClick={() => {
                  onOpen(mate)
                }}
              >
                <IconTree size={13} className="sp-icon sp-icon-run" />
                <span className="sp-row-text" title={mate.task}>
                  {mate.name}
                </span>
                {elapsed === null ? null : <span className="sp-row-time">{elapsed}</span>}
              </button>
              <button
                type="button"
                className="sp-row-stop"
                aria-label={`停掉 ${mate.name}`}
                data-tip="停掉这个队友（尽力而为，已跑完的改不了结果）"
                onClick={(event) => {
                  event.stopPropagation()
                  onStop(mate)
                }}
              >
                <IconStop size={12} />
              </button>
            </li>
          )
        })}
      </ul>
      {endedCount > 0 && onOpenDirectory !== undefined ? (
        <button type="button" className="sp-ended" data-sp-ended={String(endedCount)} onClick={onOpenDirectory}>
          <IconCheck size={13} className="sp-icon" />
          <span>已结束</span>
          <span className="sp-ended-count">{endedCount}</span>
          <IconChevronRight size={12} className="sp-ended-go" />
        </button>
      ) : null}
    </StatusSectionBlock>
  )
}

/**
 * Git 工具区（ZCode 同名分区的瘦身版）：一行「更改」（点开右侧栏 Git 页签）+ 一行分支。
 *
 * 与 ZCode 的三行（更改 / 分支 / 提交推送）差一行：dsc 没有 git 动作工具，提交与推送
 * 都是 Git 页签里的事（那里暂存 / 提交的写类 op 照过审批），所以这一区只做读数与入口。
 * 干净仓库整区不画（ZCode 同款：干净仓库不摆状态卡）——判在 StatusPanel 那一层。
 */
function GitSection({
  git,
  open,
  separated,
  onToggle,
}: {
  git: GitSummary
  open: boolean
  separated: boolean
  onToggle(): void
}): ReactNode {
  return (
    <StatusSectionBlock
      id="git"
      title="Git 工具"
      open={open}
      separated={separated}
      onToggle={onToggle}
      // 分区头同样不报增删行数（与胶囊那条同一个理由，见 MiniSummary 的注释）。
      // 行里已经有「N 个文件」，再挂一对 ± 只是把工作区总量重复一遍。
      trail={null}
    >
      <ul className="sp-list">
        <li className="sp-row">
          <button
            type="button"
            className="sp-row-open"
            data-sp-git-changes={String(git.files)}
            aria-label="打开 Git 页签"
            data-tip="在右侧边栏打开 Git"
            onClick={() => {
              openDockTab('git')
            }}
          >
            <IconDiff size={13} className="sp-icon sp-icon-run" />
            <span className="sp-row-text">更改</span>
            <span className="sp-row-time">{`${String(git.files)} 个文件`}</span>
          </button>
        </li>
        <li className="sp-row">
          <span className="sp-row-open sp-row-static" data-sp-git-branch={git.branch} data-tip="当前分支">
            <IconBranch size={13} className="sp-icon" />
            <span className="sp-row-text" title={git.branch}>
              {git.branch}
            </span>
          </span>
        </li>
      </ul>
    </StatusSectionBlock>
  )
}

/**
 * 计划区（ZCode 的「计划」= 终态计划目录）：工作区里**提交过**的计划文件，最新在前；
 * 正在等批的那一份不在目录里（它挂在输入框上方的评审卡上）。点一行在右侧栏打开它。
 */
function PlanSection({
  plans,
  now,
  open,
  separated,
  onToggle,
}: {
  plans: readonly PlanEntryView[]
  now: number
  open: boolean
  separated: boolean
  onToggle(): void
}): ReactNode {
  return (
    <StatusSectionBlock
      id="plan"
      title="计划"
      open={open}
      separated={separated}
      onToggle={onToggle}
      trail={`${String(plans.length)} 份`}
    >
      <ul className="sp-list">
        {plans.map((plan) => {
          const ago = formatAgo(plan.at, now)
          return (
            <li className="sp-row" key={plan.file}>
              <button
                type="button"
                className="sp-row-open"
                data-sp-plan={plan.file}
                aria-label={`打开计划：${plan.title}`}
                data-tip={`${plan.title}\n${plan.file}`}
                onClick={() => {
                  setDockPreview({ path: plan.file })
                }}
              >
                <IconFlatList size={13} className="sp-icon" />
                <span className="sp-row-text" title={plan.title}>
                  {plan.title}
                </span>
                {ago === null ? null : <span className="sp-row-time">{ago}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </StatusSectionBlock>
  )
}

/**
 * 终端区（ZCode 的「终端」）：正在跑的后台作业与持久终端会话。
 *
 * 折叠态读数是「最长已运行 · N 后台」（ZCode 同款）。行**整行可点**：点开在右侧栏看那个
 * 后台活的**只读输出面**（work-output 页签，等宽 `<pre>` + 按秒轮询快照）——它与状态面板
 * 的停止钮是两个动作，行尾的停止钮 `stopPropagation` 单独走 stopBackground，不误触打开。
 * 交互式终端（用户自己开的 shell）与这条是两套：后台这条只读，不复用可写通道。
 */
function WorkSection({
  works,
  now,
  open,
  separated,
  onToggle,
  onOpen,
  onStop,
}: {
  works: readonly BackgroundWorkView[]
  now: number
  open: boolean
  separated: boolean
  onToggle(): void
  /** 点开一个后台活的只读输出面（右侧栏 work-output 页签）。 */
  onOpen(work: BackgroundWorkView): void
  onStop(work: BackgroundWorkView): void
}): ReactNode {
  const longest = formatDuration(longestWorkElapsedMs(works, now))
  const trail =
    open ? `${String(works.length)} 个后台运行` : `${longest ?? ''} · ${String(works.length)} 后台`
  return (
    <StatusSectionBlock id="terminal" title="终端" open={open} separated={separated} onToggle={onToggle} trail={trail}>
      <ul className="sp-list">
        {works.map((work) => {
          const elapsed = formatDuration(Math.max(0, now - work.startedAt))
          return (
            <li className="sp-row" key={work.id} data-work-kind={work.kind}>
              {/* 整行可点：落到右侧栏看这个后台活的只读输出；行尾停止钮各自 stopPropagation。 */}
              <button
                type="button"
                className="sp-row-open"
                aria-label={`查看 ${work.id} 的输出`}
                data-sp-work={work.id}
                data-tip={`${work.kind === 'job' ? '后台作业' : '终端会话'} ${work.id}\n${work.title}\n点开在右侧边栏看输出（只读）`}
                onClick={() => {
                  onOpen(work)
                }}
              >
                <IconTerminal size={13} className="sp-icon sp-icon-run" />
                <span className="sp-row-text" title={work.title}>
                  {work.title}
                </span>
                {elapsed === null ? null : <span className="sp-row-time">{elapsed}</span>}
              </button>
              <button
                type="button"
                className="sp-row-stop"
                aria-label={`停止 ${work.id}`}
                data-tip="停止任务"
                onClick={(event) => {
                  event.stopPropagation()
                  onStop(work)
                }}
              >
                <IconStop size={12} />
              </button>
            </li>
          )
        })}
      </ul>
    </StatusSectionBlock>
  )
}

/**
 * 右侧栏里的后台活输出页签体：头部一行（标题 + 状态）+ 只读等宽文本面。
 *
 * 形态照参考实现的后台输出侧栏：纯 `<pre>`（**不引 xterm**——后台这条只读、不接收输入），
 * 按 {@link WORK_POLL_MS} 轮询 `readBackground` 的**尾部快照**（只在页签可见、且活还在跑时
 * 续拉；跑完停手），跟随滚动——滚离底部暂停视图（冻结当前帧）、回到底部或点「回到底部」恢复。
 * 头部丢字（`droppedChars > 0`）显式报一条，对应参考实现的 truncated / gap 提示。
 */
function WorkOutputTab({ tab, active, expanded }: DockTabBodyProps): ReactNode {
  const channel = useHostChannel()
  const id = tab.path ?? ''
  const [view, setView] = useState<BackgroundOutputView | null>(null)
  const [frozen, setFrozen] = useState<BackgroundOutputView | null>(null)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const prevTop = useRef(0)
  // 换后台活（同一张页签被复用）就清掉旧读数，别闪上一份的输出。
  useEffect(() => {
    setView(null)
    setFrozen(null)
    setError('')
    prevTop.current = 0
  }, [id])
  const visible = active && expanded
  useEffect(() => {
    if (id === '' || !visible) return undefined
    let alive = true
    let timer: number | null = null
    const poll = (): void => {
      void channel
        .invoke<BackgroundOutputView>('readBackground', [id])
        .then((result) => {
          if (!alive) return
          setView(result)
          setError('')
          // 只在还在跑时续拉；跑完（completed/failed/killed/closed）这一份不再变，停手。
          if (result?.status === 'running') timer = window.setTimeout(poll, WORK_POLL_MS)
        })
        .catch((reason: unknown) => {
          if (!alive) return
          setError(reason instanceof Error ? reason.message : String(reason))
        })
    }
    poll()
    return () => {
      alive = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [channel, id, visible])

  const display = frozen ?? view
  const following = frozen === null
  // 跟随态：新快照进来就贴底。
  useEffect(() => {
    if (!visible || !following) return
    const el = scrollRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [visible, following, display?.text])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (el === null) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_BOTTOM_PX
    // 向上滚且不在底部 → 冻结；冻结态回到底部 → 恢复跟随。
    if (following && el.scrollTop < prevTop.current && !atBottom) setFrozen(view)
    else if (!following && atBottom) setFrozen(null)
    prevTop.current = el.scrollTop
  }

  return (
    <div className="work-out" data-sp-output={id} data-status={display?.status ?? 'loading'} data-following={following ? '1' : '0'}>
      <div className="work-out-head">
        <IconTerminal size={13} className="sp-icon" />
        <span className="work-out-title" title={tab.label ?? id}>
          {tab.label ?? id}
        </span>
        <span className="work-out-status" data-tone={display?.status === 'running' ? 'run' : 'plain'}>
          {outputStatusLabel(display?.status)}
        </span>
      </div>
      {error === '' ? null : <div className="work-out-note">{`读不了输出：${error}`}</div>}
      {display !== null && display.droppedChars > 0 ? (
        <div className="work-out-note" data-sp-output-dropped={String(display.droppedChars)}>
          {`头部已丢弃 ${String(display.droppedChars)} 字符（缓冲超上限，较早的输出不再保留）`}
        </div>
      ) : null}
      <div className="work-out-scroll" ref={scrollRef} onScroll={onScroll}>
        <pre className="work-out-text" data-sp-output-text>
          {display === null ? '正在读输出…' : display.text === '' ? '（还没有输出）' : display.text}
        </pre>
      </div>
      {following ? null : (
        <button
          type="button"
          className="work-out-resume"
          data-sp-output-resume="1"
          data-tip="恢复跟随（新输出自动滚到底）"
          onClick={() => {
            setFrozen(null)
          }}
        >
          <IconChevronDown size={13} />
          回到底部
        </button>
      )}
    </div>
  )
}

/** 后台活状态的显示词（作业与终端两组状态合一份）。 */
function outputStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'running':
      return '运行中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'killed':
      return '已终止'
    case 'closed':
      return '已结束'
    default:
      return '读取中'
  }
}

/** 定点任务一行右侧的读数：异常态报状态，正常报「还有多久」（照 ZCode 行二「在做什么」位）。 */
function taskState(task: ScheduledTaskView, now: number): { text: string; tone: string } {
  if (!task.enabled) return { text: task.nextRunAt === null ? '已停用' : '已暂停', tone: 'muted' }
  if (task.lastStatus === 'running') return { text: '运行中', tone: 'run' }
  if (task.lastStatus === 'failed') return { text: '上次失败', tone: 'danger' }
  if (task.lastStatus === 'blocked') return { text: '已阻塞', tone: 'danger' }
  const countdown = formatCountdown(task.nextRunAt, now)
  return countdown === null ? { text: '未排期', tone: 'muted' } : { text: countdown, tone: 'plain' }
}

/**
 * 工作流区：dsc 没有工作流引擎，这一区绑的是最接近的「按规则自动跑一轮」——**定点任务**
 * （schedule 插件，默认关；关着时这一份快照面整个缺席、整区不渲染）。行是只读的：
 * 暂停 / 恢复 / 立跑仍走 `/schedule` 与 schedule 工具那一套，界面这里不立第二个动作面。
 */
function WorkflowSection({
  tasks,
  now,
  open,
  separated,
  onToggle,
}: {
  tasks: readonly ScheduledTaskView[]
  now: number
  open: boolean
  separated: boolean
  onToggle(): void
}): ReactNode {
  const running = tasks.filter((task) => task.lastStatus === 'running').length
  const trail = running > 0 ? `${String(running)} 个运行中` : `${String(tasks.length)} 条`
  return (
    <StatusSectionBlock id="workflow" title="工作流" open={open} separated={separated} onToggle={onToggle} trail={trail}>
      <ul className="sp-list">
        {tasks.map((task) => {
          const state = taskState(task, now)
          return (
            <li
              className="sp-row"
              key={task.id}
              data-sched-state={task.lastStatus}
              data-sched-enabled={task.enabled ? '1' : '0'}
            >
              <span
                className="sp-row-open sp-row-static"
                data-sp-task={task.id}
                data-tip={task.lastError === null ? task.title : `${task.title}\n上次失败：${task.lastError}`}
              >
                <IconCalendar
                  size={13}
                  className={task.lastStatus === 'running' ? 'sp-icon sp-icon-run' : 'sp-icon'}
                />
                <span className="sp-row-text" title={task.title}>
                  {task.title}
                </span>
                <span className="sp-row-time" data-tone={state.tone}>
                  {state.text}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
    </StatusSectionBlock>
  )
}
