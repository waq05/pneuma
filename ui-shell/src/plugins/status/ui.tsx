/**
 * 内置插件：状态面板（对照 ZCode 的「会话状态面板」：一个可收成胶囊的多分区总览浮层）。
 *
 * ## 为什么要有它
 *
 * 长会话里「现在到底有几件事在跑」原本散在多处：输入框上方的任务条（`plugins/tasks`）、
 * 标题旁的「N 个子智能体」下拉（`plugins/team`）、状态栏的读数，各答一半——任务条不报队友，
 * 队友下拉不报任务进度。这个面板把这几条**合成一块钉在正文右上角**的浮层。
 * （第一版之后任务条与「智能体团队」钮已从壳里撤掉：它们报的东西这里都有，留着是两份。）
 *
 * ## 形状（照 ZCode 的状态面板）
 *
 * - **同一壳收展（morph）**：收起态是胶囊（一颗药丸，只报优先级最高的那一条摘要），
 *   展开态是一块 320px 浮层。两态是**同一棵 DOM**（`[data-expanded]` 切换），收起/展开
 *   过渡最大高度、圆角、背景与阴影。ZCode 的 shell 也是这么做的。
 * - **自动档按宿主宽度裁决**：量的是定位父级 `.chat-wrap` 的宽度（ResizeObserver），
 *   不读 `window.innerWidth`——右侧 dock 开合会改宿主宽度但不改窗口宽度。
 * - **分区七个**（顺序照 ZCode 的 Git 工具 / 目标 / 计划 / 进程 / 终端 / 工作流 / 智能体），
 *   各自可折叠、各自限高滚动；进程区超过 6 条启用聚焦窗口（当前项 ±1 连续 3 条，
 *   前后折成折叠桶，hover 出预览卡）。
 * - **智能体区只列在跑的**；收工的折成一条「已结束 · N ›」目录行，经 team 插件的
 *   `teamPanel` 服务打开团队面板（缺这个服务时整行不渲染——点了没反应的入口比没有更糟）。
 *
 * ## 为什么挂在 `shell.main` 槽里却画在正文右上角
 *
 * `shell.main` 的条目渲染在滚动容器里（`.chat-inner`），静态排布会随正文滚走。所以这里
 * 用的是右缘刻度条（`plugins/transcript/jump-rail.tsx`）那一套：**一个 hidden 哨兵**在文档流里
 * 占位，组件从它往上找 `.chat-wrap`（`position: relative` 的定位父级），再把浮层 portal 进去。
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
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
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
  setDockPreview,
  setDockSubagent,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
  useSeat,
  useService,
  useThreadView,
  type ActionsDecl,
  type BackgroundWorkView,
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
 * Git 读数的轮询节奏（毫秒）：有改动最勤，干净仓库与「不是仓库」两档放松。
 * 没走快照面是因为宿主的 Git 读数是现算的（`git status` + `diff --numstat`），
 * 自己控制节奏比让宿主替所有会话定时算更省。
 */
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
/** 展示档位的存档键（本机，跟人走而不跟会话走）。 */
const MODE_KEY = 'dsc.statusPanel.mode'
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

/**
 * 当前会话 id——**口径必须和 `listTeammates` 一致**：队友名册里的 `sessionId` 是它的
 * 出生会话的**文件名**（去 `.jsonl`），所以这里从快照的 `status.sessionPath` 取尾段，
 * 而不是读 `status.sessionId`（那是另一个字段，和名册对不上，第一版自检里智能体节
 * 就是这么整节不出现的）。
 */
function readSessionId(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const path = (status as Record<string, unknown>)['sessionPath']
  if (typeof path !== 'string' || path === '') return null
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  return base.endsWith('.jsonl') ? base.slice(0, -6) : base
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
  // 可用宽度的初值也从宿主取（首帧就按宿主裁决，不闪一下）；量不到时按「宽」起步，
  // 下面的 ResizeObserver 会立刻纠正。**不读 window.innerWidth**——dock 开合改宿主宽
  // 不改窗口宽，按窗口判会在这两种情况里判错。
  const [avail, setAvail] = useState(() => {
    const wrap = typeof document === 'undefined' ? null : document.querySelector('.chat-wrap')
    return wrap instanceof HTMLElement && wrap.clientWidth > 0 ? wrap.clientWidth : AUTO_PANEL_MIN_WIDTH
  })

  // 定位父级：从哨兵往上找 `.chat-wrap`（与右缘刻度条同一套做法）。
  useEffect(() => {
    const node = sentinel.current
    const found = node?.closest('.chat-wrap')
    setHost(found instanceof HTMLElement ? found : null)
  }, [view])

  // 可用宽度：量**宿主**（.chat-wrap）而不是 window——右边 dock 开合、左栏折叠都会
  // 改宿主的宽度而窗口宽度不动；旧版读 window.innerWidth，自动档在这两种情况下判错。
  useEffect(() => {
    if (host === null) return undefined
    const element = host
    const measure = (): void => setAvail(element.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [host])

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
  }, [channel])

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
        // 面板宽度上限以宿主宽度为准（窄宿主里 320px 浮层会盖掉半篇正文）。
        style={{ '--sp-avail': `${String(avail)}px` } as CSSProperties}
      >
        <aside
          className="sp"
          data-display-mode={mode}
          data-expanded={expanded ? '1' : '0'}
          aria-label="状态"
        >
          {/* 收起态：一颗药丸。同一棵 DOM 里常驻，展开时靠 CSS 藏起来（过渡不断）。 */}
          <button
            type="button"
            className="sp-mini"
            data-sp-mini="1"
            aria-label="展开状态面板"
            aria-hidden={expanded}
            tabIndex={expanded ? -1 : 0}
            inert={expanded}
            data-tip="展开状态面板（Git、目标、计划、进程、终端、工作流与智能体）"
            onClick={() => {
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
      {/* 哨兵：只负责给出定位父级（.chat-wrap），自己永远不可见也不占位。 */}
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
    trail = (
      <span className="sp-git-delta">
        <span className="sp-add">{`+${String(summary.added)}`}</span>
        <span className="sp-del">{`−${String(summary.removed)}`}</span>
      </span>
    )
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
                data-tip={`${mate.role} · ${mate.task}\n点开在右侧栏看它的运行记录（只读）`}
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
                data-tip="停掉这个队友（尽力而为）"
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
      trail={
        <span className="sp-git-delta" data-sp-git-delta={`${String(git.added)}/${String(git.removed)}`}>
          <span className="sp-add">{`+${String(git.added)}`}</span>
          <span className="sp-del">{`−${String(git.removed)}`}</span>
        </span>
      }
    >
      <ul className="sp-list">
        <li className="sp-row">
          <button
            type="button"
            className="sp-row-open"
            data-sp-git-changes={String(git.files)}
            aria-label="打开 Git 页签"
            data-tip="在右侧栏打开 Git 页签（暂存 / 提交 / 历史 / diff）"
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
 * 折叠态读数是「最长已运行 · N 后台」（ZCode 同款）。行本身不可点：作业 / 终端的输出
 * 在 dsc 里没有可视面（job_output / terminal read 是模型那边的事），点开没去处——
 * 所以只有行尾的停止钮可交互（收自己起的后台活，与 stopTeammate 同一档，不过审批）。
 */
function WorkSection({
  works,
  now,
  open,
  separated,
  onToggle,
  onStop,
}: {
  works: readonly BackgroundWorkView[]
  now: number
  open: boolean
  separated: boolean
  onToggle(): void
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
              <span
                className="sp-row-open sp-row-static"
                data-sp-work={work.id}
                data-tip={`${work.kind === 'job' ? '后台作业' : '终端会话'} ${work.id}\n${work.title}`}
              >
                <IconTerminal size={13} className="sp-icon sp-icon-run" />
                <span className="sp-row-text" title={work.title}>
                  {work.title}
                </span>
                {elapsed === null ? null : <span className="sp-row-time">{elapsed}</span>}
              </span>
              <button
                type="button"
                className="sp-row-stop"
                aria-label={`停止 ${work.id}`}
                data-tip="收掉这个后台活（整树收尾）"
                onClick={() => {
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
