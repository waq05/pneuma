/**
 * 内置插件：对话消息流（对照旧桌面界面 `ChatView.tsx` 的座位与逐行渲染）。
 *
 * 三条与旧界面一致的结构约定，改的时候别破坏：
 *
 *   1. **一轮一个 `.turn-seat`**：旧界面把「用户消息 → 过程 → 最终回答 → 改动卡 → 轮尾」
 *      装进一个座位，行距靠 `.turn-seat` 的 `gap` 加几条 `:has()` 补差
 *      （views.css:8466-8485）。我们同样按「遇到 user 条目就开新座位」切分，于是那些
 *      行距规则原样生效。还没进任何一轮的条目挂在 `.chat-inner` 下，与旧界面一致。
 *   2. **一行一个 `.entry-row`**：`data-round` 是本轮序号（0 基）。
 *   3. **整轮折叠与阶段组都已搬**（round-fold.ts / process-groups.ts / fold-seats.tsx，
 *      与旧桌面渲染层同构）：定稿轮的过程收成一行「用时 X」；轮内再切一层阶段组——
 *      组头是类别聚合（「已读取文件，执行了命令」），组体是那一段的过程条目，默认收起、
 *      有自己的限高滚动与方向渐隐。四档能力表跟着 `processFold` 偏好走（stepGrouping /
 *      liveDetail / reasoningPreview 逐格生效）。
 *
 * 与旧界面已知的差异（都是「功能还没有」而不是「样式对不上」）：
 *   - 吸附快捷栏未搬（工具卡的 tc-bar 吸附已单独实现，长会话的跨轮跳转由右侧
 *     刻度条 JumpRail 负责，见 jump-rail.tsx）；
 *   - 分页与它的滚动保持比旧壳细一档：口径跟 dsh 对齐成条目数（≥50 条且 ≥2 轮地板、
 *     ≤500 条封顶，边界仍对齐轮起点，见 paging.ts）；「加载更早」放页时照 dsh 的
 *     preserve 口径把锚点拉回原视口位置（旧壳按轮分页、没有补偿，点一下会跳）；
 *   - 队友卡旧消息流里没有对应物，这一块是壳自己补的（`.shell-subagent`）。
 *
 * 样式与 class 名照抄旧版（`ui-shell/src/legacy/views.css`，行号同旧 `styles.css`）：
 * `.chat-inner` 1297、`.turn-seat` 8466、`.entry-row` 6852、`.entry-user` 1307、
 * `.entry-text` 1319、`.think-block` 7208、`.entry.tool-card` 1832、`.entry-system` 1442、
 * `.plan-card` 6632、`.changes-card` 9469、`.round-foot` 7001、`.diff-*` 9762 起、
 * `.turn-fold` / `.turn-status` / `.chat-to-bottom` / `.load-earlier` 同在 legacy 里。
 *
 * @module dsc-ui-shell/plugins/transcript
 */
import { Component, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  DiffRows,
  FileIcon,
  IconBranch,
  IconChevronDown,
  IconClock,
  IconChevronUp,
  IconCode,
  IconCopy,
  IconDiff,
  IconEdit,
  IconSpark,
  IconTarget,
  MarkdownView,
  defineUiPlugin,
  estimateTextTokens,
  getHostNative,
  openTrace,
  setDockPreview,
  setDockReview,
  toastErr,
  toastOk,
  useActions,
  useHostChannel,
  useHostSelector,
  useService,
  ACTIONS_SERVICE,
  type ActionsHandle,
  type ChangedFileView,
  type HostSnapshot,
  type SlotComponentProps,
  type SlotMatchedOf,
  type SlotOwnerOf,
  type TranscriptEntry,
  type UserFileAttachment,
} from '@dsc/ui'
import { buildRoundFolds, processFoldPolicy, TurnFoldRow, useFoldMemory, type ProcessFold } from './round-fold'
import { formatClock, formatDuration, liveActivity, roundDuration, turnStartedAt, type RoundInfo } from './timing'
// 分轮口径的唯一真值：座位切分与轮元信息从同一次 splitRounds 出来，下标恒一致（见 rounds.ts）。
import { splitRounds, teammateReportLabel } from './rounds'
import { useIntendedDiff } from './intended-diff'
import { readFold, writeFold, stepGroupFoldKey, turnFoldKey } from './fold-state'
import { groupSteps, seatPlan, type StepGroup, type StepGrouping } from './process-groups'
import { RowSeat, StepGroupSeat } from './fold-seats'
import { JumpRail, previewText } from './jump-rail'
// 写前预览通知（宿主 file-review 插件发的那段多行 diff 文本）：按正文形状认出来，
// 画成左对齐的卡片，而不是让它走 `.entry-system` 的居中一行（几十行 diff 居中成一坨）。
import { parseReviewNotice } from './review-notice'
import { ReviewNoticeCard } from './review-notice-card'
import { pageStartRound } from './paging'
// 三级嵌套滚动的接力（工具详情 → 阶段组体 → 会话流），见模块头。
// 路径/悬停/完成音/工具摘要口径从平台种子（`@dsc/ui-primitives`）取：与壳内部同一份实现，
// 不再内联（E6）——completion-sound 带模块级 AudioContext 单例，重复一份会造出两个。
import { NO_ENTRIES, TOOL_STATUS_TEXT, baseNameOf, displayPathOf, findLast, formatTokens, matchTool, oneLine, playCompletionSound, prettyJson, readCwd, readEntries, readLive, readSessions, readSessionPath, readTurnState, toolSummary, toolVerb, useHoverDelay, type ToolMatch } from '@dsc/ui-primitives'
import {
  ChatStatus,
  IntendedBody,
  IntendedPreview,
  OpenPathButton,
  TOOLCARD_FACTORY,
  TraceJumpButton,
  fileTargetOf,
  registerToolCard,
} from './tool-card/factory'

/** 折叠偏好经 context 穿进深处的 ThinkRow / ToolRow / 座位（插件树就在壳的树里，可用）。 */
export interface FoldPrefs {
  policy: ReturnType<typeof processFoldPolicy>
  /** 定稿的思考行默认展开吗（uiPrefs.reasoningDefaultOpen）。 */
  reasoningOpen: boolean
  /** 工具卡默认展开吗（uiPrefs.toolDefaultOpen）。 */
  toolOpen: boolean
}
const FOLD_PREFS: FoldPrefs = { policy: processFoldPolicy('standard'), reasoningOpen: false, toolOpen: false }
const FoldPrefsContext = createContext<FoldPrefs>(FOLD_PREFS)

/** 流内动作（TranscriptFlow 提供，深处的行消费）：编辑重发。 */
interface FlowActions {
  /** 编辑一条用户消息并重发：分叉新会话（第 1 条前无内容则开全新会话），原会话保留。 */
  editRefork(entry: Extract<TranscriptEntry, { kind: 'user' }>, text: string): void
  /** 回合跑动中置灰编辑（旧界面同款：跑动中不让编辑）。 */
  busy: boolean
}
const NO_ACTIONS: FlowActions = { editRefork: () => undefined, busy: false }
const FlowActionsContext = createContext<FlowActions>(NO_ACTIONS)

/**
 * 会话工作目录（相对路径展示与「将做的改动」推演的基准）。
 *
 * 为什么要 context 而不是 props：工具行可能经 toolview 链交给别的插件渲染，
 * 槽渲染不穿 props 链，但仍在同一棵 React 树里——context 是那条「不打扰插件
 * 作者、又能让深处的行拿到壳数据」的路。
 */
const ShellCwdContext = createContext('')

/** 当前会话 uuid 的传递面（工具卡的展开态存档键、评价键都用它做前缀）。 */
const ShellSessionContext = createContext<string | null>(null)

/** 空的条目表：没拿到快照时共用一份，省得每帧新建数组。 */
/** 工具条目（ToolRow 与 toolview 选举的 owner 形状；工具卡的 Factory 输入也用它）。 */
export type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>

/** 工具调用视图的 chain 槽：每一条工具调用由选举出的渲染者负责（见下）。 */
export const TOOLVIEW_SLOT = 'transcript.toolview'

/**
 * 内部几层之间传的 renderSlot 形状（= toolview 槽的 owner 份额）。
 * 公开契约在 {@link SlotMap} 的声明里，这里只是把它拧成一个具名函数类型，免得每层重抄。
 */
type ToolViewRender = (name: typeof TOOLVIEW_SLOT, props: { entry: ToolEntry; storeKey?: string }) => ReactNode

/**
 * 把本插件开出来的子槽并进 `@dsc/ui` 的槽位契约表（D1）——插件就近声明自己认识的位置。
 *
 * owner 的形状就是渲染方（RowBody）在 `renderSlot` 调用点真正传的东西：`{ entry, storeKey }`；
 * matched 是内置选择器的返回值（`matchTool` 的命中结果）。表一旦钉住，`select` 的参数、
 * 当选组件的 props、他人 `renderSlot` 的实参在编译期互相校验。
 */
declare module '@dsc/ui' {
  interface SlotMap {
    [TOOLVIEW_SLOT]: {
      kind: 'chain'
      owner: { entry: ToolEntry; storeKey?: string }
      matched: ToolMatch
    }
    // 只读「子智能体条目流」的落点：团队插件把队友会话条目交给它渲染（与主会话同一套行）。
    // 组件经 `ui.provide('transcriptFlow', …)` 交出去，团队页签直接渲染它；这一条声明是为了
    // 让那条条目具备 toolview 选举链（工具卡不只是内置兜底）。
    'shell.subagent.flow': { kind: 'list' }
  }
}

/**
 * 内置渲染器在链里的位置：priority 大（后问）——任何想接管某种工具的插件注册一个
 * 更小的 priority、选择器认领自己的工具就赢；内置选择器全认领（catch-all），
 * 所以链空着的时候工具卡照常画，链上有人接就归别人。
 */
const BUILTIN_TOOLVIEW_PRIORITY = 100

export default defineUiPlugin({
  name: '消息流',
  apply(ui) {
    // 工具卡的装配定义（D2）：定义在这里注册，对话页与轨迹页各自渲染——两个父位置
    // 选不同的局部组件（对话页选 intended 预览等四件；轨迹页只选轨迹口径的耗时）。
    registerToolCard(ui)
    // toolview 是本条目声明出来的 chain 子槽：「谁渲染这条工具调用」由选举决定，
    // 不在渲染体里写死 if——内置渲染器也只是链上的一条（见下一条注册）。
    ui.slots.register(
      'shell.main',
      { id: 'transcript.flow', order: 1, children: { [TOOLVIEW_SLOT]: 'chain' } },
      TranscriptFlow,
    )
    ui.slots.register(
      TOOLVIEW_SLOT,
      {
        id: 'transcript.toolview.builtin',
        priority: BUILTIN_TOOLVIEW_PRIORITY,
        // owner 的类型来自 SlotMap 的声明（D1）：entry 就是渲染方传的那条工具调用，
        // 不需要再对 unknown 做断言。
        select: (owner) => matchTool(owner.entry.call.name),
      },
      BuiltinToolView,
    )
    // 只读「子智能体条目流」：与主会话同一套行渲染（RowBody：markdown / 思考 / 工具卡 /
    // 子代理卡 / 计划卡 / system 行），只读——编辑重发不给。声明成一条独立槽位（带 toolview
    // 选举链），组件本身经 `transcriptFlow` 服务交出去：团队右栏页签直接渲染它；服务缺席时
    // 团队那边退回简版 PeekView（兜底仍留着，见 team/ui.tsx）。
    ui.slots.declare(SUBAGENT_FLOW_SLOT, 'list')
    ui.slots.register(
      SUBAGENT_FLOW_SLOT,
      { id: 'transcript.subagent.flow', order: 1, children: { [TOOLVIEW_SLOT]: 'chain' } },
      SubagentFlow,
    )
    ui.provide<TranscriptFlowService>('transcriptFlow', { Component: SubagentFlow, slot: SUBAGENT_FLOW_SLOT })
  },
})

/** 座位里的一行：条目 + 它是不是「正在直播的那一条」（直播行多一个光标与展开态）+ 全量下标（折叠区间判据）。 */
interface Row {
  entry: TranscriptEntry
  live: boolean
  /** 这一条在全量条目序列里的下标（定稿在前、直播尾按序接在后面）；buildSeats 填。 */
  at: number
}

/** 一轮的座位。`round` 是序号（0 基），写进 `.entry-row` 的 `data-round`。 */
interface Seat {
  round: number
  rows: Row[]
}

/** 独立条目（不进过程区）：收起整轮不能把「等你点批准」「结束标记」也一起藏掉。 */
const TURN_INDEPENDENT: ReadonlySet<string> = new Set(['user', 'plan', 'system', 'turn-end', 'turn-max-tokens'])

/** 空的分组结果（verbose 档共用一份，引用稳定，不给每帧新建空 Map）。 */
const EMPTY_STEP_GROUPING: StepGrouping = { groups: [], headAt: new Map(), at: new Map() }

/** 贴底判定（px）：与 dsh 的 `use-scroll-follow` 同一档（25px），差别只在取整。 */
const FOLLOW_BOTTOM_PX = 24

/** 位置落定的等待（ms）：dsh 是 500ms；壳里的手势距离都短，等太久反而像卡住。 */
const FOLLOW_SETTLE_MS = 180

/** 往上翻的键：只有「想回头读」才需要抢在内容增长前松手（往下滚到底不需要）。 */
const UP_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'PageUp', 'Home'])

/**
 * 跟着底部的自动滚动（对齐 dsh 的 `use-scroll-follow.ts` 与 `use-chat-reading.ts`）。
 *
 * 三条规矩，缺一条就会「粘滞」——明明往上滚了一段，下一口流式内容一到又被拽回底部：
 *
 * 1. **读者往回读就先松手**：往上滚的滚轮、`↑` / `PgUp` / `Home` 一到，跟随当场取消，
 *    不等滚动位置越过哪条线；等位置落定（`scrollend`，或 180ms 内没有新滚动）再按距离重判。
 *    只认「往上」：在底部往下滚时浏览器什么也不做，这时松手只会让下一口内容没人追。
 * 2. **只认自己的写**：钉底要写 `scrollTop`，它引发的 scroll 事件不能当成「读者动了」。
 *    记下每次写到哪儿，差在 1px 以内就当自己滚的（dsh 的 `movedByReader` 同一口径）。
 * 3. **贴底的门槛要近**：dsh 用 25px；壳原来写 160px，往上滚一小段仍算「在底部」，
 *    于是内容一长就把人拽回去，手感就是粘。
 *
 * 内容变长（新条目、流式正文、虚拟列表补挂）交给 `ResizeObserver`：只有跟随开着才钉底，
 * 读者在读的时候一个字都不动（dsh 的 `onResize` 也是这条）。
 *
 * @param dep 条目数：条目变了要重钉一次（ResizeObserver 之外的第二道保险）
 * @param sessionKey 换会话时重新起算（打开会话即锚在末尾）
 */
function useFollowBottom(
  dep: number,
  sessionKey: string,
): {
  setEnd: (node: HTMLDivElement | null) => void
  /** 末尾那个锚点（滚轮接力的钩子从它找 .chat；调用点不必再拿一次 DOM）。 */
  end: HTMLDivElement | null
  paused: boolean
  resume: () => void
  pause: () => void
} {
  const [end, setEnd] = useState<HTMLDivElement | null>(null)
  /** 跟随的意图。与「此刻离底多远」分开：距离只在落定时量一次。 */
  const following = useRef(true)
  /** 上一次由我们自己写到的位置（用来认出「这条 scroll 是我们自己引起的」）。 */
  const written = useRef(0)
  const settleTimer = useRef<number | null>(null)
  /** 滚动容器的两个动作：钉到底、立刻停跟随（给 `pause` 用）。 */
  const control = useRef<{ pin: () => void; stop: () => void } | null>(null)
  const [paused, setPaused] = useState(false)
  /** 上一次钉底是按哪条会话起的算；初值给一个空串哨兵，于是首屏也算「换了一条」。 */
  const pinnedFor = useRef('')

  useEffect(() => {
    const scroller = end?.closest('.chat')
    if (!(scroller instanceof HTMLElement)) return undefined
    const floor = (): number => Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const pin = (): void => {
      scroller.scrollTop = scroller.scrollHeight
      written.current = scroller.scrollTop
    }
    const clearSettle = (): void => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current)
      settleTimer.current = null
    }
    /** 位置落定：这一刻的远近才算数。够近就恢复跟随并补齐最后几像素。 */
    const settle = (): void => {
      clearSettle()
      const near = floor() - scroller.scrollTop <= FOLLOW_BOTTOM_PX
      following.current = near
      setPaused(!near)
      if (near) pin()
    }
    const schedule = (): void => {
      clearSettle()
      settleTimer.current = window.setTimeout(settle, FOLLOW_SETTLE_MS)
    }
    const onScroll = (): void => {
      const top = scroller.scrollTop
      if (Math.abs(top - written.current) <= 1) {
        written.current = top
        return
      }
      if (following.current) {
        following.current = false
        setPaused(true)
      }
      schedule()
    }
    /** 读者动手：先松手，不等这一下手势滚出多远。 */
    const onGesture = (): void => {
      following.current = false
      schedule()
    }
    const onWheel = (event: WheelEvent): void => {
      // 只认「往上滚」：在底部往下滚时浏览器什么也不做，这时若把跟随松掉，
      // 下一口流式内容就没人追了（点开工具卡、往下翻也一样，不该断跟随）。
      if (event.ctrlKey || event.deltaY >= 0) return
      onGesture()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (UP_KEYS.has(event.key)) onGesture()
    }
    /** 内容变长：跟随开着才追，读者在读就一动不动。 */
    const onResize = (): void => {
      if (!following.current) return
      if (floor() - scroller.scrollTop > 4) pin()
    }
    control.current = {
      pin,
      stop: () => {
        clearSettle()
        following.current = false
        setPaused(true)
      },
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('scrollend', settle)
    scroller.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('keydown', onKey)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : undefined
    observer?.observe(scroller)
    const content = scroller.firstElementChild
    if (content !== null) observer?.observe(content)
    return () => {
      clearSettle()
      control.current = null
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('scrollend', settle)
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('keydown', onKey)
      observer?.disconnect()
    }
  }, [end])

  // 换会话（含首屏）那一拍先重新钉住底部，再照常跟：这一条声明在上面那个滚动监听
  // 效果**之后**，顺序有讲究——监听效果刚按当前位置（打开会话时是 scrollTop=0）
  // 判过「暂停」，这条要盖住它。
  useEffect(() => {
    if (pinnedFor.current !== sessionKey) {
      pinnedFor.current = sessionKey
      following.current = true
      setPaused(false)
    }
    if (!following.current) return
    control.current?.pin()
  }, [sessionKey, end, dep])

  const resume = (): void => {
    following.current = true
    setPaused(false)
    control.current?.pin()
  }

  /**
   * 暂停跟随（「加载更早」在放页时调）。
   *
   * 只等滚动事件判有一个缝：放页后的那一下补偿是程序性滚动，它引发的 scroll 事件
   * 下一帧才到，而流式内容可能先到一步把这口 delta 接上——跟随要是还开着，视角就被
   * 拽回底部，刚补好的阅读位置全毁。这里直接表态「不跟了」，缝就没了。
   */
  const pause = (): void => {
    control.current?.stop()
  }

  return { setEnd, end, paused, resume, pause }
}


/**
 * 首屏四张能力卡（对照 Codex UI 的 home cards）：点一下把提示词写进输入框，不直接发送——
 * 提示词里带冒号的留了下一句的位置，用户可以接着补。
 *
 * 图标只用壳里已有的（IconCode / IconSpark / IconDiff / IconTarget），不新画一套。
 */
interface ComposerDraftService {
  insert(text: string): void
}

const WELCOME_CARDS: ReadonlyArray<{
  id: string
  Icon: (props: { size?: number }) => ReactNode
  title: string
  hint: string
  prompt: string
}> = [
  { id: 'read', Icon: IconCode, title: '看懂代码', hint: '解释一处实现的来龙去脉', prompt: '帮我讲清楚这段代码在做什么：\n' },
  { id: 'build', Icon: IconSpark, title: '做点东西', hint: '从需求一路写到能跑', prompt: '帮我实现：' },
  {
    id: 'review',
    Icon: IconDiff,
    title: '审查改动',
    hint: '看未提交的改动有没有坑',
    prompt: '审查当前未提交的改动，指出风险、遗漏和可以简化的地方。',
  },
  { id: 'fix', Icon: IconTarget, title: '排查问题', hint: '从一个报错查到根因', prompt: '帮我排查一下这个问题：\n' },
]

/** 动作 id → 图标：动作表里只存文案与动作，图标是转录插件自己的资产（见下面的登记）。 */
const WELCOME_ICON_BY_ID: ReadonlyMap<string, (props: { size?: number }) => ReactNode> = new Map(
  WELCOME_CARDS.map((card) => [`welcome.${card.id}`, card.Icon] as const),
)

function TranscriptFlow({
  renderSlot,
}: SlotComponentProps<Record<never, never>, typeof TOOLVIEW_SLOT>): ReactNode {
  const entries = useHostSelector(readEntries)
  const live = useHostSelector(readLive)
  const turnState = useHostSelector(readTurnState)
  const sessionPath = useHostSelector(readSessionPath)
  const sessionId = useHostSelector(readSessionId)
  const cwd = useHostSelector(readCwd) ?? ''
  const channel = useHostChannel()
  /**
   * 行 key 的会话那一半：优先用会话文件路径，没有就用会话 uuid，都没有就空串
   * （空串只出现在「宿主还没接上」那一瞬间，此时也还没有条目）。
   */
  const sessionKey = sessionPath ?? sessionId ?? ''
  const seats = useMemo(() => buildSeats(entries, live), [entries, live])
  const follow = useFollowBottom(entries.length + live.length, sessionKey)

  // 折叠偏好：mount 时读一次 uiPrefs，设置页改档位时经自定义事件同步进来。
  // 行为偏好（完成提示音/通知）也在这份里：同会话跑动→空闲的那一下要用。
  const [prefs, setPrefs] = useState<FoldPrefs>(FOLD_PREFS)
  const [behavior, setBehavior] = useState<{ sound: boolean; variant: number; notify: boolean }>({
    sound: true,
    variant: 1,
    notify: true,
  })
  useEffect(() => {
    const read = (): void => {
      void channel
        .invoke<Record<string, unknown>>('getUiPrefs', [])
        .then((value) => {
          setPrefs({
            policy: processFoldPolicy(readFoldValue(value['processFold'])),
            reasoningOpen: value['reasoningDefaultOpen'] === true,
            toolOpen: value['toolDefaultOpen'] === true,
          })
          const variant = value['turnCompleteSoundVariant']
          setBehavior({
            sound: value['turnCompleteSound'] !== false,
            variant: typeof variant === 'number' && Number.isFinite(variant) ? variant : 1,
            notify: value['turnCompleteNotify'] !== false,
          })
        })
        .catch(() => undefined)
    }
    read()
    window.addEventListener('shell.uiprefs', read)
    return () => window.removeEventListener('shell.uiprefs', read)
  }, [channel])

  // 回合完成提醒（桌面端 App 的同款判定）：**同一会话**从跑动变空闲的那一拍，
  // 按偏好播一声完成提示音；页面不在前台时再弹一条系统通知（只有桌面原生桥有）。
  const prevState = useRef<string>(turnState)
  const behaviorRef = useRef(behavior)
  behaviorRef.current = behavior
  const sessionRef = useRef(sessionPath)
  useEffect(() => {
    const was = prevState.current
    prevState.current = turnState
    if (was === 'idle' || turnState !== 'idle') return
    // 会话换了不算完成（切走时那个会话跑完是后台事件，侧栏状态点已经说过它）。
    if (sessionRef.current !== sessionPath) return
    if (behaviorRef.current.sound) playCompletionSound(behaviorRef.current.variant)
    const background = document.hidden || !document.hasFocus()
    const native = getHostNative()
    if (background && behaviorRef.current.notify && native.available) {
      const last = [...entries].reverse().find((entry) => entry.kind === 'text')
      const body =
        last !== undefined && last.kind === 'text'
          ? last.text.replace(/\s+/g, ' ').trim().slice(0, 120)
          : '任务完成'
      void native
        .invoke('notify', [{ title: '任务完成', body }])
        .catch(() => undefined)
    }
  }, [turnState, sessionPath, entries])

  // 分页（口径见 paging.ts）：默认只画尾部一页，更早的点「加载更早」再放出来；一页按
  // 条目数算——「至少 50 条且至少 2 轮，最多 500 条封顶」，边界对齐轮起点。按轮分页
  // 挡不住「单轮极长」，而拖慢长会话的正是那一轮里压着的几十上百个条目。
  //
  // state 记的是**绝对轮号**（用户放出来的最早那一轮）而不是「放了几页」：会话还在长，
  // 按页数记会让窗口整体后移，把用户正看着的那一轮悄悄收走（桌面端 useChatViewport
  // 在同一条上栽过）；null = 还没点过，窗口跟着尾部默认页走。
  const [earliest, setEarliest] = useState<number | null>(null)
  const roundSizes = useMemo(() => seats.rounds.map((seat) => seat.rows.length), [seats.rounds])
  const tailStart = useMemo(() => pageStartRound(roundSizes, roundSizes.length), [roundSizes])
  const firstVisible = earliest === null ? tailStart : Math.min(earliest, tailStart)
  const visibleSeats = useMemo(
    () => seats.rounds.filter((seat) => seat.round >= firstVisible),
    [seats.rounds, firstVisible],
  )
  // 下一次点「加载更早」会放出来的轮数：按钮文案的读数与点击落点用同一份计算。
  const earlierRounds = useMemo(
    () => firstVisible - pageStartRound(roundSizes, firstVisible),
    [roundSizes, firstVisible],
  )
  // 换会话（或会话被清空）分页窗口回默认：「已放出到第几轮」是上一条会话的事。
  const cleared = seats.rounds.length === 0
  useEffect(() => {
    setEarliest(null)
  }, [sessionKey, cleared])

  /** 「加载更早」那颗按钮（放页的锚点在它所在的滚动容器里找）。 */
  const earlierRef = useRef<HTMLButtonElement | null>(null)
  /** 放页前的锚点：第一个画出来的座位，记它距滚动容器顶端的位置。 */
  const pageAnchor = useRef<{ node: HTMLElement; top: number; from: number } | null>(null)

  /**
   * 记锚点（放页前调）：当前画出来的**第一个座位**距滚动容器顶端的位置。
   *
   * 为什么锚座位而不是「按钮后第一个有高度的兄弟」（桌面端是后者）：新放出来的早轮
   * 整段插在第一个座位前面——被往下推的就是它。座位之前可能还挂着开场 system 行
   * （`seats.leading`），那几行本来就不动，量它们等于白量，阅读位置照跳。
   * dsh 的 `beginPaging()` 取的就是「DOM 序里第一个可用的 seat」，同一条口径。
   */
  const beginPaging = (): void => {
    const button = earlierRef.current
    if (button === null) return
    const scroller = button.closest('.chat')
    if (!(scroller instanceof HTMLElement)) return
    const seat = scroller.querySelector<HTMLElement>('[data-round-seat]')
    pageAnchor.current =
      seat === null
        ? null
        : { node: seat, top: seat.getBoundingClientRect().top - scroller.getBoundingClientRect().top, from: firstVisible }
  }

  /**
   * 放页（「加载更早」按钮与刻度条点没画出来的轮共用）：先记锚点，再把窗口往前扩。
   *
   * 跟随一并暂停：这两个入口只有用户主动往上看才会碰到，此刻要是还开着跟随，
   * 下一口流式内容就把视角拽回底部了。
   */
  const release = (startRound: number): void => {
    if (startRound >= firstVisible) return
    beginPaging()
    follow.pause()
    setEarliest(startRound)
  }

  /**
   * 放页后的补偿：把锚点拉回它原来的视口位置（距滚动容器顶端同样的距离）。
   *
   * 为什么是 useLayoutEffect：它跑在 DOM 更新之后、浏览器绘制之前——补在绘制前，
   * 用户看不到「跳一下再弹回来」。为什么量「距滚动容器顶端的位置」而不是记 scrollTop
   * 差值：插入的高度只能这么量（锚点被往下推多少 = 它上方长了多少）。
   * 只补外层 `.chat`：锚点若是新插入的早轮自己的组内滚动，与本屏阅读位置无关。
   */
  useLayoutEffect(() => {
    const anchor = pageAnchor.current
    if (anchor === null) return
    pageAnchor.current = null
    // 只有窗口真的往前扩了才补：点了已画出来的轮（值没变）、窗口跟着尾部后移都不是放页。
    // 锚点还挂在文档里同样是前提——换会话会把旧的那一整棵换掉，那一跳该由贴底逻辑接管。
    if (firstVisible >= anchor.from || !anchor.node.isConnected) return
    const scroller = anchor.node.closest('.chat')
    if (!(scroller instanceof HTMLElement)) return
    const top = anchor.node.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scroller.scrollTop += top - anchor.top
  }, [firstVisible])

  // 整轮折叠：四档能力表 + 每轮的折叠预算 + 用户手动开合（双层记忆：当场重画 + 重挂读回）。
  const foldMemory = useFoldMemory()
  // 轮元信息与座位切分是同一次 splitRounds 的两半（buildSeats 里跑的），所以座位序号
  // 与这里的下标恒一致——别再单独调一次 roundInfos，那会重新引入两处真值。
  const rounds = seats.infos
  const liveRoundIndex = rounds.length - 1
  const roundFolds = useMemo(
    () => buildRoundFolds([...entries, ...live], rounds, { foldTurns: prefs.policy.foldTurns, live: turnState !== 'idle', lastRoundIndex: liveRoundIndex }),
    [entries, live, rounds, prefs.policy.foldTurns, turnState, liveRoundIndex],
  )
  // 阶段分组（档位表能力之一）：一轮里连续的过程条目按「正文 / 计划卡 / 独立条目」封组，
  // 组头只说「这一阶段干了哪类事」。none 档给空表（引用稳定的常量），整轮折叠不依赖它。
  const stepGrouping = useMemo<StepGrouping>(
    () =>
      prefs.policy.stepGrouping === 'none'
        ? EMPTY_STEP_GROUPING
        : groupSteps(
            [...entries, ...live],
            rounds,
            // running 谓词直接复用 roundFold——口径单点，别处不再重判
            (roundIndex) => roundFolds.get(roundIndex)?.running ?? false,
            prefs.policy.stepGrouping === 'history',
          ),
    [entries, live, rounds, roundFolds, prefs.policy.stepGrouping],
  )
  // 轮收尾复位（旧桌面版语义）：一轮从跑动落到定稿的那一刻，把整轮与它下面所有阶段组的
  // 开合写回默认（收起）——用户点开过的那一组不会在下一轮里弹回去，但同一轮的残留收干净。
  const runningRounds = useMemo(() => {
    const set = new Set<number>()
    for (const fold of roundFolds.values()) if (fold.running) set.add(fold.roundIndex)
    return set
  }, [roundFolds])
  const prevRunningRounds = useRef<Set<number>>(new Set())
  useEffect(() => {
    const settled: string[] = []
    for (const roundIndex of prevRunningRounds.current) {
      if (runningRounds.has(roundIndex)) continue
      settled.push(turnFoldKey(sessionId, roundIndex))
      for (const group of stepGrouping.groups) {
        if (group.roundIndex === roundIndex) settled.push(stepGroupFoldKey(sessionId, roundIndex, group.seq))
      }
    }
    foldMemory.reset(settled)
    prevRunningRounds.current = runningRounds
    // foldMemory.reset 是稳定引用（useFoldMemory 里 useCallback 包过），不进依赖清单。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningRounds, stepGrouping, sessionId])

  // 页脚「分叉这一轮」：保留到本轮用户消息（含），从这一轮的回答重来——旧界面同一语义。
  // 第 1 轮不给分（分完还是这一轮，没有意义）。
  const forkRound = (seat: Seat): void => {
    if (sessionPath === null) return
    const roundNo = seat.round + 1
    void (async () => {
      try {
        const result = await channel.invoke<{ ok: boolean; path?: string; error?: string }>('forkSession', [sessionPath, roundNo])
        if (result.ok !== true) {
          toastErr(result.error ?? '分叉失败')
          return
        }
        await channel.invoke('openSession', result.path === undefined ? [] : [result.path])
        await channel.invoke('refreshSessions', [])
        toastOk('已从这一轮分叉出新会话')
      } catch (reason) {
        toastErr(`分叉失败：${reason instanceof Error ? reason.message : String(reason)}`)
      }
    })()
  }

  /**
   * 编辑一条用户消息并重发（旧界面同款）：提交=分叉新会话并重发改文——
   * 第 1 条消息前没有内容，分叉出来是空的，所以直接开全新会话；原会话保留不动。
   * 分叉会话本身是「复制到第 index 条用户消息之前」，所以编辑第 N 条就分叉到 N-1。
   */
  const editRefork = (entry: Extract<TranscriptEntry, { kind: 'user' }>, text: string): void => {
    // 分叉序号 = 这条消息**之前**有多少条开轮的用户消息。旧写法手数「非插话的 user」，
    // 与分轮口径是两处真值（插话 / internal 一变就错开）；现在直接数轮——每一条开轮的
    // 用户消息恰好对应一轮（rounds.ts 规则 1），所以「startIndex 落在本条目之前的轮」数量就是它。
    const all = [...entries, ...live]
    const at = all.findIndex((item) => item.id === entry.id)
    const index = rounds.filter((round) => round.startIndex < at).length
    void (async () => {
      try {
        if (sessionPath === null || index === 0) {
          await channel.invoke('openSession', [])
        } else {
          const result = await channel.invoke<{ ok: boolean; path?: string; error?: string }>('forkSession', [sessionPath, index])
          if (result.ok !== true) {
            toastErr(result.error ?? '分叉失败')
            return
          }
          await channel.invoke('openSession', result.path === undefined ? [] : [result.path])
        }
        await channel.invoke('refreshSessions', [])
        await channel.invoke('submit', [text])
      } catch (reason) {
        toastErr(`重发失败：${reason instanceof Error ? reason.message : String(reason)}`)
      }
    })()
  }
  const actions: FlowActions = { editRefork, busy: turnState !== 'idle' }

  // 进行中状态行（回合没结束才有）：阶段 + 活动名 + 用时。
  const activity = useMemo(() => liveActivity([...entries, ...live], turnState), [entries, live, turnState])
  const startedAt = useMemo(() => turnStartedAt([...entries, ...live]), [entries, live])

  // 右侧刻度条的数据：每轮的题面（用户消息）与回复摘要（该轮最后一条定稿正文）。
  // 含「还没画出来」的早轮——那正是刻度条要先把它们画出来的用途（点击 → onReveal）。
  // 放在空会话提前 return 之前：hook 数量不能因分支而变。
  const railRounds = useMemo(
    () =>
      seats.rounds.map((seat) => {
        const user = seat.rows[0]?.entry
        const answer = seat.rows
          .map((row) => row.entry)
          .filter((entry): entry is Extract<TranscriptEntry, { kind: 'text' }> => entry.kind === 'text' && entry.id >= 0)
          .at(-1)
        return {
          round: seat.round,
          // 题面预览只在来源是**人**时才填（对照 dsh 的 turnOutline：非 user 来源不留题面）。
          // internal 汇报（队友干完活）有刻度但不给原文，改给一句人话——绝不把
          // `<teammate-report …>` 当题面塞进悬停卡。
          prompt:
            user?.kind !== 'user'
              ? ''
              : user.internal === true
                ? teammateReportLabel(user.text)
                : previewText(user.text, 'prompt'),
          response: answer === undefined ? '' : previewText(answer.text, 'response'),
        }
      }),
    [seats.rounds],
  )
  /** 刻度条点了还没画出来的轮：把它放出来（走「加载更早」同一套锚点与跟随暂停）。 */
  const revealRound = (round: number): void => {
    release(round)
  }

  // 开场 system 条目不铺在首屏：启动期的沙箱档位、迁移报告、模型配置提示这些属于
  // **日志与轨迹**（会话 jsonl 里一条不少，轨迹页也照常看得到）。首屏只留一句人话。
  // 真出问题（带 level: 'error' 的条目，例如没有可用的模型端点）改成一次 Toast：
  // 弹窗负责「告诉你现在干不了活、去哪儿修」，正文里的那几行命令交给设置页。
  // 能力卡点击后往输入框写字（provider 是 composer 插件；缺席时卡片置灰，点了没反应比没有更糟）。
  const composerDraft = useService<ComposerDraftService>('composerDraft')

  // 四张卡片同时登记成动作表里的四条：命令面板搜「看懂代码」也能直接落到输入框。
  // 文案只在这一处声明（WELCOME_CARDS），卡片与面板读同一份。
  const actionsHandle = useService<ActionsHandle>(ACTIONS_SERVICE)
  useEffect(() => {
    if (actionsHandle === undefined) return undefined
    return actionsHandle.register(
      'transcript',
      WELCOME_CARDS.map((card) => ({
        id: `welcome.${card.id}`,
        label: card.title,
        hint: card.hint,
        group: '提示词',
        keywords: ['提示词', 'prompt'],
        run: () => {
          composerDraft?.insert(card.prompt)
        },
      })),
    )
  }, [actionsHandle, composerDraft])

  // 首屏的「接着上次做」：最近七天内改过、且有标题的那条会话（排除当前这条）。
  // 为什么按七天截断：再久的东西不该在空会话首屏上抢位置——侧栏里还找得到。
  const sessions = useHostSelector(readSessions)
  const resume = useMemo(() => {
    const now = Date.now()
    return (
      [...sessions]
        .filter(
          (session) =>
            session.archivedAt === undefined &&
            session.id !== sessionPath &&
            (session.title ?? '') !== '' &&
            now - session.updatedAt < 7 * 24 * 60 * 60 * 1000,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
    )
  }, [sessions, sessionPath])

  // 首屏卡片的两种来源：动作表（常驻，含命令面板里的那几条），或动作表缺席时的内置清单。
  const registeredActions = useActions()
  const promptActions = useMemo(
    () => registeredActions.filter((action) => action.group === '提示词'),
    [registeredActions],
  )
  const welcomeCards = useMemo(() => {
    if (promptActions.length > 0) {
      return promptActions.map((action) => ({
        id: action.id,
        Icon: WELCOME_ICON_BY_ID.get(action.id) ?? IconSpark,
        title: action.label,
        hint: action.hint ?? '',
        run: action.run,
      }))
    }
    return WELCOME_CARDS.map((card) => ({
      id: card.id,
      Icon: card.Icon,
      title: card.title,
      hint: card.hint,
      run: () => {
        composerDraft?.insert(card.prompt)
      },
    }))
  }, [promptActions, composerDraft])

  const bootError = useMemo(() => {
    const row = seats.leading.find((item) => item.entry.kind === 'system' && item.entry.level === 'error')
    return row !== undefined && row.entry.kind === 'system' ? row.entry : null
  }, [seats.leading])

  useEffect(() => {
    if (bootError === null) return
    // 只弹第一行：后面几行是命令示例，弹窗里放不下，也不该抢视线。
    toastErr(bootError.text.split('\n')[0] ?? '启动时有问题需要处理')
  }, [bootError?.id, sessionKey])

  // 空会话欢迎态（与旧桌面界面同一份文案）。
  if (seats.rounds.length === 0 && seats.leading.every((row) => row.entry.kind === 'system')) {
    return (
      <div className="welcome">
        {/* 首屏不放 logo（2026-10-27 用户：中间这个图标有点突兀）。
            空态的第一眼该落在「有什么可以帮忙的？」这句话上，图标在标题上方只是挡视线；
            品牌声部留给侧栏与收起的窄栏（.sidebar-header / .rail-logo 那两档）。 */}
        <h1>有什么可以帮忙的？</h1>
        <p>
          输入 <code>/</code> 查看可用指令 · 消息会携带当前工作目录上下文
        </p>
        <div className="welcome-cards">
          {welcomeCards.map((card) => (
            <button
              key={card.id}
              type="button"
              className="welcome-card"
              disabled={composerDraft === undefined}
              onClick={card.run}
            >
              <card.Icon size={16} />
              <span className="welcome-card-text">
                <span className="welcome-card-title">{card.title}</span>
                <span className="welcome-card-hint">{card.hint}</span>
              </span>
            </button>
          ))}
        </div>
        {resume === null ? null : (
          <button
            type="button"
            className="welcome-resume"
            onClick={() => {
              void (async () => {
                await channel.invoke('openSession', [resume.id])
                await channel.invoke('refreshSessions', [])
              })()
            }}
          >
            <IconClock size={13} />
            <span className="welcome-resume-title">接着上次：{resume.title}</span>
            <span className="welcome-resume-time">{elapsedLabel(resume.updatedAt)}</span>
          </button>
        )}
        {seats.leading.map((row) => {
          if (row.entry.kind !== 'system') return null
          // 命令输出（/help、/status…）是用户主动要的东西，空会话首屏也要画出来：
          // 这一支原先只画写前预览卡，于是新会话里打第一条命令什么都看不到（2026-10-27 查账）。
          if (row.entry.command === true) {
            return (
              <div key={keyOf(row, sessionKey)} className="entry-system-command">
                {row.entry.text}
              </div>
            )
          }
          // 自动跑起来的那一轮（定点任务之类）没有用户消息，它的写前预览会落在开场区；
          // 这里同样走卡片——同一条通知在哪个位置都不该变成居中的一大坨。
          const notice = parseReviewNotice(row.entry.text)
          if (notice === null) return null
          return <ReviewNoticeCard key={keyOf(row, sessionKey)} notice={notice} cwd={cwd} />
        })}
      </div>
    )
  }

  return (
    <ShellSessionContext.Provider value={sessionId}>
    <ShellCwdContext.Provider value={cwd ?? ''}>
    <FoldPrefsContext.Provider value={prefs}>
      <FlowActionsContext.Provider value={actions}>
      {/* 右侧回合刻度条（对照 dsh 的 TurnNavigator）：绝对定位到 .chat-wrap，
          不参与文档流；它自己找滚动容器做当前轮判定与跳转。 */}
      <JumpRail rounds={railRounds} renderedFrom={firstVisible} onReveal={revealRound} />
      {/* 「加载更早」：上面还有没画出来的轮才有这一行（firstVisible === 0 = 已到顶）。
          文案里的轮数是**这一页实际会放出来的轮数**（同一次纯函数算出来的，不写死常数）。 */}
      {firstVisible > 0 ? (
        <button
          type="button"
          className="chat-earlier"
          ref={earlierRef}
          data-earlier-rounds={firstVisible}
          data-tip="把更早的几轮画出来（一页至少 50 条且 2 轮），你现在看的位置不会动"
          onClick={() => {
            release(firstVisible - earlierRounds)
          }}
        >
          {`加载更早的 ${String(earlierRounds)} 轮（上面还有 ${String(firstVisible)} 轮）`}
        </button>
      ) : null}
      {seats.leading.map((row) => (
        <RowBoundary key={keyOf(row, sessionKey)} entry={row.entry}>
          <div className="entry-row">
            <RowBody row={row} renderSlot={renderSlot} />
          </div>
        </RowBoundary>
      ))}
      {visibleSeats.map((seat) => (
        <div className="turn-seat" data-round-seat={seat.round} key={seat.round}>
          <SeatBody
            seat={seat}
            round={rounds[seat.round]}
            running={turnState !== 'idle' && seat.round === rounds.length - 1}
            sessionId={sessionId}
            sessionKey={sessionKey}
            cwd={cwd}
            roundFolds={roundFolds}
            foldMemory={foldMemory}
            stepGrouping={stepGrouping}
            renderSlot={renderSlot}
            onFork={sessionPath === null || seat.round === 0 ? undefined : () => forkRound(seat)}
          />
        </div>
      ))}
      {/* 回合进行中：流末尾的状态行（阶段 + 活动名 + 实时用时 + 动画省略号） */}
      {activity !== null ? <TurnStatusLine stage={activity.stage} activity={activity.activity} startedAt={startedAt} /> : null}
      <div ref={follow.setEnd} />
      {/* 暂停跟随时的回头路：只在这一刻出现（跟随中不画），点一下恢复跟随并送回底部。 */}
      {follow.paused ? (
        <button
          type="button"
          className="chat-to-bottom"
          title="回到最新一条（自动跟随会重新打开）"
          onClick={follow.resume}
        >
          回到底部
        </button>
      ) : null}
      </FlowActionsContext.Provider>
    </FoldPrefsContext.Provider>
    </ShellCwdContext.Provider>
    </ShellSessionContext.Provider>
  )
}

/** processFold 的取值收窄（线上来的值对不上就回落 standard）。 */
function readFoldValue(value: unknown): ProcessFold {
  return value === 'compact' || value === 'detailed' || value === 'verbose' ? value : 'standard'
}

/** 会话清单（首屏「接着上次」用；快照里没有时给空表）。 */
/** 相对时间（分钟 / 小时 / 天）：首屏那一行只需要「多久以前」，精确到秒没有意义。 */
function elapsedLabel(at: number): string {
  const minutes = Math.max(Math.round((Date.now() - at) / 60_000), 0)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  return `${String(Math.round(hours / 24))} 天前`
}

/** 当前会话 uuid（评价存档键用；旧界面也是拿它拼键）。 */
function readSessionId(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const value = (status as Record<string, unknown>)['sessionId']
  return typeof value === 'string' && value !== '' ? value : null
}

/** 一个座位的全部行：整轮总开关 → 过程行（可折）→ 改动卡 + 轮尾。 */
function SeatBody({
  seat,
  round,
  running,
  sessionId,
  sessionKey,
  cwd,
  roundFolds,
  foldMemory,
  stepGrouping,
  renderSlot,
  onFork,
}: {
  seat: Seat
  /**
   * 这一轮的起止时刻（`timing.roundInfos` 算好的那份）。**别再就地重算**：
   * 轮尾与总开关上的「用时」都认它——roundInfos 会跳过 system 条目（「已恢复会话」
   * 这类通知的 ts 是恢复那一刻，算进来会得出一个天文数字，旧界面 turn-timing 的
   * 注释里写明了这条教训）。
   */
  round: RoundInfo | undefined
  /** 这一轮还在跑（只有最后一轮会跑）：轮尾的时刻与用量此时不画。 */
  running: boolean
  /** 当前会话 uuid（评价存档键的前半截，与旧界面同一口径）。 */
  sessionId: string | null
  /** 行 key 的会话那一半（见 {@link keyOf}）。 */
  sessionKey: string
  /** 会话工作目录：相对路径展示 + 「将做的改动」推演的相对路径基准。 */
  cwd: string
  roundFolds: ReadonlyMap<number, import('./round-fold').RoundFold>
  foldMemory: ReturnType<typeof useFoldMemory>
  /** 阶段分组（哪些连续条目成一组、组头挂在哪条之前，都从它来；none 档是空表）。 */
  stepGrouping: StepGrouping
  renderSlot: ToolViewRender
  /** 页脚「分叉这一轮」；undefined = 分不了（没在会话里 / 第 1 轮）。 */
  onFork?: () => void
}): ReactNode {
  const fold = roundFolds.get(seat.round)
  // 跑动中的轮连总开关都不画（永远展开）；可折的定稿轮才有开合。
  const foldRunning = fold?.running === true
  const foldable = fold !== undefined && fold.foldable && fold.hasContent && !foldRunning && !fold.blocked
  const turnKey = turnFoldKey(sessionId, seat.round)
  const turnOpen = foldMemory.open(turnKey, false)
  /** 整轮收起来没有：可折 + 有内容 + 已收尾 + 用户没收起来（默认就是收起）。 */
  const collapsed = foldable && !turnOpen
  /** 把整轮放出来（座位被 Ctrl+F 命中、或焦点落在收起的内容里时由座位自己调）。 */
  const reveal = (): void => {
    foldMemory.set(turnKey, true)
  }
  // 总开关行：可折的定稿轮才画（不可折的档位——verbose——连抬头都不画，照旧版）。
  const showFoldRow = fold !== undefined && fold.foldable && !foldRunning
  // roundInfos 与座位是同一次切分出来的，正常一对一；真缺了（宿主刚清空这类中间帧）
  // 就给一份「做不到计时」的空轮次，界面照画、只是不报时间。
  const roundInfo: RoundInfo = round ?? {
    index: seat.round,
    startIndex: seat.rows[0]?.at ?? 0,
    endIndex: seat.rows[seat.rows.length - 1]?.at ?? 0,
    startTs: null,
    endTs: null,
    answered: true,
  }
  // 这一轮的最终回答（复制与评价都按它算，旧界面 roundAnswer 同口径）：最后一条定稿正文。
  const answer = seat.rows
    .map((row) => row.entry)
    .filter((entry): entry is Extract<TranscriptEntry, { kind: 'text' }> => entry.kind === 'text' && entry.id >= 0)
    .at(-1)
  // 整轮的正文估算（页脚的「~N tok」回落）：一轮里的定稿正文加起来；直播尾不算。
  const tokens = seat.rows.reduce(
    (sum, row) => (row.entry.kind === 'text' && row.entry.id >= 0 ? sum + estimateTextTokens(row.entry.text) : sum),
    0,
  )
  const usage = findLast(
    seat.rows,
    (row): row is Row & { entry: Extract<TranscriptEntry, { kind: 'text' | 'tool' }> } =>
      (row.entry.kind === 'text' || row.entry.kind === 'tool') && row.entry.usage !== undefined,
  )?.entry.usage
  /**
   * 一行条目：真盒子（RowSeat：收起时挂 hidden="until-found" 而不是卸载——Ctrl+F 能命中，
   * 键盘焦点不会被抽走）+ 行级错误边界 + 行体。组内成员与过程行都走它。
   */
  const seatRow = (row: Row, hidden: boolean): ReactNode => (
    <RowSeat
      key={keyOf(row, sessionKey)}
      hidden={hidden}
      onReveal={reveal}
      roundIndex={seat.round}
    >
      <RowBoundary entry={row.entry}>
        <RowBody row={row} renderSlot={renderSlot} />
      </RowBoundary>
    </RowSeat>
  )
  /** 一组现在展开没有（键：会话 + 轮 + 组序号；默认一律收起——组头承载「现在在干什么」）。 */
  const groupOpen = (group: StepGroup): boolean =>
    foldMemory.open(stepGroupFoldKey(sessionId, group.roundIndex, group.seq), false)
  const toggleGroup = (group: StepGroup): void => {
    foldMemory.set(stepGroupFoldKey(sessionId, group.roundIndex, group.seq), !groupOpen(group))
  }
  const liveDetail = useContext(FoldPrefsContext).policy.liveDetail
  // 过程区分块：连续的过程条目收进阶段组（组体是「真盒子」，才有自己的限高与滚动），
  // 其余按「过程 / 之后」两档摆——独立节点（计划卡、system、轮尾标记）永远在「之后」，
  // 收起整轮不把它们一起藏掉。
  //
  // 「哪条行归哪儿」是 process-groups.ts 的**纯函数**（seatPlan）：**每条行恰好出一次**
  // ——组出一次（带着它的全部组员），不在组里的行各出一次。这条不变量曾经靠渲染体自己
  // 维护，漏掉一次就是「一条思考栏出现两次」（0.6.67 报障）；搬出去之后它由
  // `scripts/ui-transcript-render-test.mjs` 直接断言。
  const rowByAt = new Map(seat.rows.map((row) => [row.at, row]))
  const processBlocks: ReactNode[] = []
  const afterBlocks: ReactNode[] = []
  for (const item of seatPlan(seat.rows.slice(1).map((row) => row.at), stepGrouping)) {
    if (item.kind === 'group') {
      const head = item.group
      const members = item.members
        .map((at) => rowByAt.get(at))
        .filter((member): member is Row => member !== undefined)
      processBlocks.push(
        <StepGroupSeat
          key={`step-${String(head.roundIndex)}-${String(head.seq)}`}
          group={head}
          turnCollapsed={collapsed}
          open={groupOpen(head)}
          showDetail={liveDetail}
          onToggle={() => toggleGroup(head)}
          onRevealTurn={reveal}
        >
          {members.map((member) => seatRow(member, false))}
        </StepGroupSeat>,
      )
      continue
    }
    const row = rowByAt.get(item.at)
    if (row === undefined) continue
    const inProcess =
      fold !== undefined && fold.foldable && fold.hasContent
      && row.at >= fold.startIndex && row.at <= fold.endIndex
    if (inProcess && !TURN_INDEPENDENT.has(row.entry.kind)) processBlocks.push(seatRow(row, collapsed))
    else afterBlocks.push(seatRow(row, false))
  }
  return (
    <>
      {seat.rows.length === 0 ? null : seatRow(seat.rows[0]!, false)}
      {showFoldRow && fold !== undefined ? (
        <div className="entry-row" data-round={seat.round}>
          <TurnFoldRow
            open={!collapsed}
            round={roundInfo}
            // 不可折的两种情况：这一轮压根没有过程内容，或者它被中断 / 跑挂 / 轮内插过话。
            // 照旧版的做法这一行照样画出来，只是点不动——用户得看得见「这一轮收成什么样」。
            disabled={!fold.hasContent || fold.blocked}
            endReason={fold.endReason}
            onToggle={() => {
              foldMemory.set(turnKey, collapsed)
            }}
          />
        </div>
      ) : null}
      {processBlocks.length === 0 ? null : (
        // 过程区**包一层**再折：整轮收起是「这一片高度从 0 长回来 / 缩回 0」，一片一起动才行。
        // 平铺在座位上折不了——收起的行是 `hidden`（不产生盒子），夹在它们之间的 6px flex gap
        // 会留下来，几十行的轮收起来就是一片空白的间隙堆。包进一格之后，座位的 gap 只算这一格。
        // 高度动画本身在 CSS：`.turn-process` 的 grid-template-rows 0fr↔1fr（不需要 JS 量高度）。
        <div className="turn-process" data-fold={collapsed ? 'closed' : 'open'}>
          <div className="turn-process-body">{processBlocks}</div>
        </div>
      )}
      {afterBlocks}
      <ChangesCard rows={seat.rows} cwd={cwd} />
      <RoundFoot
        round={roundInfo}
        running={running}
        copyText={answer?.text}
        usage={usage ?? null}
        tokens={tokens > 0 ? tokens : null}
        onFork={onFork}
      />
    </>
  )
}

/** 一行的内容：按条目种类分派。 */
function RowBody({
  row,
  renderSlot,
}: {
  row: Row
  renderSlot: ToolViewRender
}): ReactNode {
  const sessionId = useContext(ShellSessionContext)
  const cwd = useContext(ShellCwdContext)
  const entry = row.entry
  switch (entry.kind) {
    case 'user':
      return <UserRow entry={entry} />
    case 'text':
      return (
        <div className={row.live ? 'entry-text live' : 'entry-text'}>
          {/* 正文渲染 markdown（与桌面端 MarkdownText 同一能力面：GFM 表格/任务列表等）。
              直播尾同样渲染——半截 markdown 短暂错排是流式的固有代价，桌面端也一样。 */}
          <MarkdownView text={entry.text} path="" streaming={row.live} />
        </div>
      )
    case 'thinking':
      // 展开态存档键（`会话id:think:条目id`）：条目原位更新（宿主把同一段思考合并进同一条）
      // 时 id 不变，键就稳定；用 row.at 会在前面条目入账时漂。
      return (
        <ThinkRow
          entry={entry}
          live={row.live}
          storeKey={`${sessionId ?? ''}:think:${String(entry.id)}`}
        />
      )
    case 'tool': {
      // 这条工具调用谁画由 toolview 链选举：链上有人认领就归它（matched 一并交给它），
      // 全体弃权（或链上没人）落回内置工具卡——内置渲染器自己也在链上，这只是兜底位。
      // 展开态存档键（`会话id:条目序号`）顺着 owner 传给当选者：链上有人接管时同一份
      // 展开态也活得过重挂。
      const storeKey = `${sessionId ?? ''}:${String(row.at)}`
      return renderSlot?.(TOOLVIEW_SLOT, { entry, storeKey }) ?? <ToolRow entry={entry} storeKey={storeKey} />
    }
    case 'system': {
      // 写前预览（宿主 file-review 插件）：这段正文是**多行 unified diff 纯文本**，
      // 走专用卡片（左对齐、等宽、限高滚动）；其余 system 通知（「这一轮被中断」这类
      // 一行短句）保持 `.entry-system` 的居中观感不变。
      const notice = parseReviewNotice(entry.text)
      if (notice !== null) return <ReviewNoticeCard notice={notice} cwd={cwd} />
      // 命令输出是多行清单（/help 十几行、/status 六行），居中的灰字排不下：走左对齐等宽块
      return entry.command === true ? (
        <div className="entry-system-command">{entry.text}</div>
      ) : (
        <div className="entry-system">{entry.text}</div>
      )
    }
    case 'turn-max-tokens':
      return (
        <div className="entry-system" data-turn-notice="max-tokens">
          这一轮的输出达到长度上限，已被截断
        </div>
      )
    case 'model-retry':
      return (
        <div className="entry-system" data-turn-notice="model-retry">
          模型请求失败，正在重试（第 {entry.attempt} 次）：{entry.text}
        </div>
      )
    case 'turn-end':
      // 旧界面这一条不上屏（结束状态写在整轮开关那一行）。我们还没有那一行，
      // 于是只把「没好好答完」的两种原因显出来——正常结束保持安静。
      if (entry.reason === 'completed') return null
      return <div className="entry-system">{entry.reason === 'aborted' ? '这一轮被中断' : '这一轮过程失败'}</div>
    case 'plan':
      return (
        <div className={`plan-card ${entry.plan.decision === 'pending' ? 'pending' : 'settled'}`}>
          <div className="plan-head">
            <span className="plan-title">{entry.plan.title}</span>
            <span className="plan-verdict">
              {entry.plan.decision === 'pending' ? '等你批' : entry.plan.decision === 'approved' ? '已批准' : '未批准'}
            </span>
          </div>
          <pre className="plan-body">{entry.plan.text}</pre>
          <div className="plan-foot">
            <span className="plan-file" title={entry.plan.file}>
              {entry.plan.file}
            </span>
          </div>
        </div>
      )
    case 'subagent':
      return <SubagentRow entry={entry} />
    case 'changes':
    case 'turnDiff':
      // 这两种条目本身不上屏：同一轮里的改动聚合成轮尾一张卡（见 ChangesCard）。
      return null
    default: {
      // 宿主加了新种类而壳还没跟上时，显式说一句，不要静悄悄地少一块。
      const kind = (entry as { kind?: unknown }).kind
      return <div className="entry-system">认不出的条目：{String(kind)}</div>
    }
  }
}

/**
 * 用户消息的附件条（贴图条之后、正文之前）：视频能就地播放，其余文件给一张可点开的文件卡。
 *
 * 卡片只是一层结构+类名，排版全在 `styles.css` 的 `.entry-user-files` / `.user-file-card` 里；
 * 视频没有 `url`（宿主只给了路径句柄）时降级成普通文件卡，不留一个播不了的空播放器。
 *
 * @param props - `files` 是宿主给的用户附件清单，缺省/空数组时整块不渲染。
 * @returns 附件条，或 null。
 */
function UserFileCards({ files }: { files?: readonly UserFileAttachment[] }): ReactNode {
  if (files === undefined || files.length === 0) return null
  return (
    <div className="entry-user-files">
      {files.map((file) =>
        file.kind === 'video' && file.url !== undefined && file.url !== '' ? (
          <figure key={file.sha} className="user-file-card user-video-card" data-file-kind="video">
            <video src={file.url} controls playsInline preload="metadata" aria-label={file.name} />
            <figcaption className="user-file-name" title={file.path}>
              {file.name}
            </figcaption>
            <span className="user-file-meta">{formatBytes(file.bytes)}</span>
          </figure>
        ) : (
          <FileAttachmentCard key={file.sha} file={file} />
        ),
      )}
    </div>
  )
}

/**
 * 一个非视频附件的卡片：文档图标 + 文件名 + 体积。有 `url` 时整卡是下载链接，没有就是死卡片。
 *
 * @param props - `file` 是宿主给的用户附件。
 * @returns 文件卡（`<a>` 或 `<div>`）。
 */
function FileAttachmentCard({ file }: { file: UserFileAttachment }): ReactNode {
  const body = (
    <>
      <FileIcon name={file.name} size={16} />
      <span className="user-file-name" title={file.path}>
        {file.name}
      </span>
      <span className="user-file-meta">{formatBytes(file.bytes)}</span>
    </>
  )
  if (file.url === undefined || file.url === '') {
    return (
      <div className="user-file-card" data-file-kind="file">
        {body}
      </div>
    )
  }
  return (
    <a className="user-file-card" data-file-kind="file" href={file.url} target="_blank" rel="noreferrer" title={file.path}>
      {body}
    </a>
  )
}

/** 用户消息：气泡 + 贴图条 + hover 浮出的「编辑」钮（编辑重发 = 分叉新会话重发，原会话保留）。 */
function UserRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }): ReactNode {
  const actions = useContext(FlowActionsContext)
  // 编辑中的草稿（null = 没在编辑）。Enter 提交 / Shift+Enter 换行 / Esc 取消。
  const [draft, setDraft] = useState<string | null>(null)
  // 运行时投递进来的消息（队友汇报）不拿它当人打的字渲染，也不压成居中的 system 断句：
  // 按 dsh 的 turn-trigger 画成一行「触发行」——一句话说清是谁的汇报（队友名 / 状态都从
  // body 头里解出来，见 rounds.ts 的 teammateReportLabel）。`data-internal="1"` 属性留着
  // （样式与探针认它）。完整汇报仍挂在 title 上，需要时悬停可看。
  if (entry.internal === true) {
    return (
      <div className="entry-system" data-internal="1" title={entry.text}>
        {teammateReportLabel(entry.text)}
      </div>
    )
  }
  return (
    <div className="user-turn">
      <div className={`entry-user${draft === null ? '' : ' editing'}`}>
        {entry.images === undefined || entry.images.length === 0 ? null : (
          <div className="entry-user-images">
            {entry.images.map((url, index) => (
              <a key={index} href={url} target="_blank" rel="noreferrer" data-tip="点开看原图">
                <img src={url} alt={`第 ${String(index + 1)} 张贴图`} />
              </a>
            ))}
          </div>
        )}
        <UserFileCards files={entry.files} />
        {draft === null ? (
          entry.text
        ) : (
          <div className="user-edit">
            <textarea
              className="user-edit-box"
              value={draft}
              autoFocus
              rows={Math.min(10, Math.max(2, draft.split('\n').length))}
              aria-label="编辑这条消息"
              onChange={(event) => {
                setDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setDraft(null)
                  return
                }
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                event.preventDefault()
                const text = draft.trim()
                if (text === '') return
                setDraft(null)
                actions.editRefork(entry, text)
              }}
            />
            <p className="user-edit-note">Enter 重发（分叉出新会话，原会话保留） · Shift+Enter 换行 · Esc 取消</p>
            <div className="user-edit-actions">
              <button
                type="button"
                className="dsc-btn"
                data-variant="ghost"
                data-size="xs"
                onClick={() => {
                  setDraft(null)
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="dsc-btn"
                data-variant="primary"
                data-size="xs"
                disabled={draft.trim() === ''}
                onClick={() => {
                  const text = draft.trim()
                  if (text === '') return
                  setDraft(null)
                  actions.editRefork(entry, text)
                }}
              >
                重发
              </button>
            </div>
          </div>
        )}
      </div>
      {draft === null ? (
        <div className="user-actions">
          <button
            type="button"
            className="user-act"
            title={actions.busy ? '这一轮还在跑，先等它结束或打断再编辑' : '编辑这条消息并重发（会分叉出新会话，原会话保留）'}
            aria-label="编辑并重发这条消息"
            disabled={actions.busy}
            onClick={() => {
              setDraft(entry.text)
            }}
          >
            <IconEdit size={15} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** 首行：直到第一个换行为止（旧版 ThinkingBlock.tsx:42-45）。 */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/**
 * 最新一个「已经写完的段落」的首行（旧版 `ThinkingBlock.tsx:54-70`，语义同 dsh 的
 * `latestCompletedParagraphFirstLine`）。
 *
 * 段落之间以空行（一行里只有空白）分隔。最后一个段落如果还没写到换行，说明它正在被吐字，
 * 不能拿来当摘要——所以从后往前找第一个「首行已经收尾」的段落。一段都没写完就返回空串，
 * 界面据此只画标题、不画分隔点与摘要。
 */
function latestCompletedParagraphFirstLine(text: string): string {
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  while (true) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd = nextParagraph === null ? text.length
      : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
}

/**
 * 思考块（旧桌面渲染层 `ThinkingBlock.tsx` 的同构移植）：默认折叠成一行
 * 「星标 + 标题 + 分隔点 + 摘要」，点开才是完整思考原文；展开内容超过
 * {@link BAR_MIN_CONTENT_H} 时，展开区顶部吸附一条带「收起」的快捷栏。
 *
 * 三条与旧版一致、改的时候别破坏的事（前两条正是本批的两个报障）：
 *
 *  1. **展开区是有条件渲染的**（`open && …`）。少了这个条件，收起时正文照样在 DOM 里、
 *     照样占高度——点箭头只转个方向，「思考内容关不掉」。
 *  2. **跑动中的摘要取「最新一个写完的段落的首行」**，不是首行：直播时最后一段还在往外
 *     吐字，拿它当摘要会一个字跳一次（旧版 ThinkingBlock.tsx:7-8 的注释就是这条教训）。
 *     另一半防抖在行 key 上——直播尾的 `ts` 每口 delta 都刷新，键里带上它就会逐字重挂
 *     （见 {@link keyOf}）。
 *  3. **展开态走存档**（`fold-state`）：会话切换会重放历史、条目整表重建，重挂时从存档键
 *     读回用户上次的选择；不存的话「展开两条、切走再切回」就全合上了。
 *
 * 跑动中**保留**「收起」按钮（工具卡在 running 时藏起来是因为那里收起有「任务被中断」的
 * 歧义；思考段是只读文本，收起它不会被理解成取消）。
 */
function ThinkRow({
  entry,
  live,
  storeKey,
}: {
  entry: Extract<TranscriptEntry, { kind: 'thinking' }>
  live: boolean
  /** 展开状态的存档键（`会话id:think:条目id`）；不传就不存档。 */
  storeKey?: string
}): ReactNode {
  const prefs = useContext(FoldPrefsContext)
  /**
   * 展开态：**一律从用户的默认档位起算，跑动中也不替用户展开**。
   *
   * 这里原来写的是 `readFold(storeKey, live || prefs.reasoningOpen)`（直播尾挂载即展开，
   * 当时认为它是「现在在干什么」的唯一线索）。它在**定稿那一瞬间**会制造一次很难受的
   * 抽动，也就是 0.6.67 的报障「思考完毕闪屏折叠」：直播尾是负 id 的条目，定稿后换成
   * 正 id 的新条目（`adapter/transcript.ts` 的 pushThinking），React key 跟着换 →
   * 旧实例卸载、新实例挂载 → 新实例按默认档位算出来是**收起**，于是用户眼前那段摊开的
   * 思考在定稿那一拍整体收拢（若开着动效还会从 0fr 重播一次高度过渡）。
   *
   * 参考实现从不这么做：dsh 的推理行**永远以收起态起步**，`running` 只改「折叠行右边那句
   * 预览」的取法（进行中取最新写完段落的首行，定稿后取首行，ReasoningRow.tsx:56），
   * 行的开合只由用户点击决定（use-disclosure.ts:12-13）。直播的「还活着」由扫光 + 摘要 +
   * 小圈承载（本组件三样都有），不需要把正文摊开。
   */
  const [open, setOpen] = useState(() => readFold(storeKey, prefs.reasoningOpen))
  const [barVisible, setBarVisible] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  /** 展开态一变就写回存档：组件被重挂时下一个实例才读得到。 */
  const setOpenPersisted = (next: boolean): void => {
    writeFold(storeKey, next)
    setOpen(next)
  }
  const toggle = (): void => {
    setOpenPersisted(!open)
  }

  // 摘要（折叠态那一行右边那一段）：跑动中只认写完的段落，收工后取首行；`**` 一律去掉。
  const summary = (live ? latestCompletedParagraphFirstLine(entry.text) : firstLine(entry.text)).replaceAll('**', '')
  // 这一行现在画不画摘要：空摘要不画；紧凑档的定稿条也不画（那一档的语义就是「只剩标题 + 箭头」，
  // 对照 dsh 的 settledReasoningPreview）。跑动中照画——正在写的那一句不能因为档位被藏了。
  const preview = summary !== '' && (live || prefs.policy.reasoningPreview)

  // 展开内容够长才给快捷栏；阈值判断放在布局之后量，量的是真实像素而不是估算。
  // 直播时 text 一直在变长，所以挂 ResizeObserver 跟着重量（不是只量一次）。
  useEffect(() => {
    const body = bodyRef.current
    if (body === null || !open) {
      setBarVisible(false)
      return undefined
    }
    const measure = (): void => {
      setBarVisible(expandedContentHeight(body) > BAR_MIN_CONTENT_H)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => {
      observer.disconnect()
    }
  }, [open, entry.text])

  return (
    <div
      className={`think-block${live ? ' live' : ''}${open ? ' open' : ''}`}
      // 两态走 data-state（dsh 的 ReasoningRow.tsx:80）；.live 是「直播尾」这个概念，样式里仍在用。
      data-state={live ? 'running' : 'ok'}
      // 折叠态有没有摘要可画（dsh 的 data-preview）：空摘要不占位。
      data-preview={preview ? '1' : undefined}
    >
      {/* 跑动这一态在视觉上是扫光 + 品牌色，读屏读不到「扫光」，所以补一句只给读屏的说明。 */}
      {live ? <span className="think-sr">正在思考</span> : null}
      <div
        className="think-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-tip={open ? '收起这段思考' : '展开这段思考'}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          // 空格按在 div 上默认会滚页面，先挡掉再自己处理（与工具卡紧凑行同款）。
          event.preventDefault()
          toggle()
        }}
      >
        <IconSpark size={12} className="think-star" />
        {/* 标题照 dsh 的 `message.think`（两个字「思考」）：2026-10-27 之前是「思考过程」，
            多出来的两个字在窄栏里会被浏览器按字断行（见 views.css 里标题防竖排那条），
            而且同一件事工具行说「读取」、这行说「思考过程」，字数与词性都对不齐。 */}
        <span className="think-label">思考</span>
        {/* 分隔点：只在真有摘要时画（紧凑档的定稿条不画，箭头因此紧跟在标题右边）。 */}
        {preview ? <span className="think-dot" aria-hidden="true" /> : null}
        {preview ? (
          <span className="think-summary" data-streaming={live ? '1' : undefined}>
            <span className="think-summary-text" data-shimmer={live ? summary : undefined}>
              {summary}
            </span>
          </span>
        ) : null}
        {/* 进行中的小圈：系统里说「少动」时扫光会停，这枚静态环就是那会儿唯一的活动标记。 */}
        <span className="think-status">{live ? <i className="think-spin" aria-hidden="true" /> : null}</span>
        <IconChevronDown size={11} className="think-chevron" />
      </div>
      {/* 吸附快捷栏：是 .think-block 的直接子项（不套在 .think-body 里），这样展开区可以
          放心用 overflow 裁剪做高度过渡，sticky 的参照系仍是滚动容器 .chat。 */}
      {open && barVisible ? (
        <div className="think-bar" data-think-chrome="1">
          <span className="think-bar-status">思考 · {live ? '进行中' : '已完成'}</span>
          <button
            type="button"
            className="think-collapse"
            title="收起这段思考"
            onClick={() => {
              setOpenPersisted(false)
            }}
          >
            收起
            <IconChevronUp size={11} />
          </button>
        </div>
      ) : null}
      {/* 展开区：**条件渲染**（见组件注释第 1 条）。高度过渡要裁剪，所以正文外面再包一层
          .think-body-clip；正文自己的左竖线留在 .think-text 上。 */}
      {open ? (
        <div className="think-body" ref={bodyRef}>
          <div className="think-body-clip">
            <div className="think-text">{entry.text}</div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 内置当选者：选举把 matched（图标 + 动词）算好交过来；渲染的是一个 **Factory occurrence**
 * （D2）——对话页给四个局部组件（intended 预览 / 中文耗时 / 「将做的改动」/ 「在轨迹中查看」），
 * 轨迹页渲染同一个定义、只换耗时口径。Factory 没注册时落到旧工具卡（fallback，保险丝）。
 */
function BuiltinToolView(
  props: SlotComponentProps<SlotOwnerOf<typeof TOOLVIEW_SLOT>, never, SlotMatchedOf<typeof TOOLVIEW_SLOT>>,
): ReactNode {
  // 折叠偏好与会话工作目录从 context 拿（槽渲染不穿 props 链，见 ShellCwdContext 的注释）；
  // 以输入 props 交给 Factory，定义组件本身不认识对话页的 context。
  const prefs = useContext(FoldPrefsContext)
  const cwd = useContext(ShellCwdContext)
  return props.renderFactorySlot(
    TOOLCARD_FACTORY,
    {
      entry: props.entry,
      storeKey: props.storeKey,
      persistKey: props.storeKey,
      variant: 'chat',
      match: props.matched,
      foldPrefs: prefs,
      cwd,
    },
    {
      slots: {
        preview: IntendedPreview,
        statusDetail: ChatStatus,
        bodyExtra: IntendedBody,
        trailing: TraceJumpButton,
      },
      fallback: <ToolRow entry={props.entry} matched={props.matched} storeKey={props.storeKey} />,
    },
  )
}

/** 展开内容超过这个高度才给吸附快捷栏——小卡不背这条累赘（旧界面同款阈值）。 */
const BAR_MIN_CONTENT_H = 400

/**
 * 展开区有多长：把每个子块的自然高度加起来。
 *
 * 为什么读 scrollHeight 而不是 offsetHeight：参数与结果两块各被 max-height 夹在
 * --dsc-tool-detail-max-h（约 180px）里，读 offsetHeight 会把任意长的内容都看成 180px，
 * 加总永远进不了 400px 阈值，快捷栏就再也不会出现。
 */
function expandedContentHeight(body: HTMLElement): number {
  let total = 0
  for (const child of Array.from(body.children)) {
    if (!(child instanceof HTMLElement)) continue
    // 快捷栏自己不算内容。把它算进去会自我维持：内容 390 + 栏 26 > 400 → 显示栏 →
    // 下一轮又量到 416 → 一直显示。所以量之前先把它排除。
    if (child.dataset.tcChrome !== undefined) continue
    total += Math.max(child.scrollHeight, child.offsetHeight)
  }
  return total
}

/**
 * 工具卡：一行头（状态点 + 图标 + 动词 + 摘要 + 状态）+ 展开后的「将做的改动」/参数/结果
 * （桌面端 `ToolCard.tsx` 的同构移植；行头保留壳的动词风格）。
 *
 * 三件与旧界面一致、改的时候别破坏的事：
 * 1. **展开态存档**（`fold-state`）：会话切换会把条目整表重建，重挂时从存档键读回
 *    用户上次的展开选择——否则「展开两条卡、切走再切回」就全合上了。
 * 2. **「将做的改动」只在 running 期出**（write / edit，含审批等待）：从参数 + 盘上现值
 *    推演这次调用将产生的 diff；落地后轮尾的「文件已更改」卡接手，卡上再挂一份就是重复。
 * 3. **吸附快捷栏**：展开内容够长（>400px）才出现，滚动时吸在聊天区顶部，
 *    栏上是「状态 · 用时」与「收起」。
 */
function ToolRow({ entry, matched, storeKey }: { entry: ToolEntry; matched?: ToolMatch; storeKey?: string }): ReactNode {
  const call = entry.call
  const prefs = useContext(FoldPrefsContext)
  const cwd = useContext(ShellCwdContext)
  const [open, setOpen] = useState(() => readFold(storeKey, prefs.toolOpen))
  const [barVisible, setBarVisible] = useState(false)
  // 参数还没到齐的这一次调用不可展开——展开也看不到东西，还会让「点一下」白点。
  const expandable = call.status !== 'preparing'
  const bodyOpen = open && expandable
  const running = call.status === 'running'
  const summary = toolSummary(call.name, call.argsText)
  const match = matched ?? matchTool(call.name)
  const Icon = match.Icon
  // 文件类工具这次调用指向的文件（摘要区的可点路径靠它；认不出就是 null）。
  const targetPath = fileTargetOf(call.name, call.argsText, cwd)
  // 「将做的改动」：write / edit 进行中时从参数 + 盘上现值推演（落地后自动消失）。
  const intended = useIntendedDiff(call, cwd)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)

  /** 展开态一变就写回存档：组件被重挂时下一个实例才读得到。 */
  const setOpenPersisted = (next: boolean): void => {
    writeFold(storeKey, next)
    setOpen(next)
  }
  const toggle = (): void => {
    if (expandable) setOpenPersisted(!open)
  }

  // 展开内容够长才给快捷栏；阈值判断放在布局之后量，量的是真实像素而不是估算。
  useEffect(() => {
    const body = bodyRef.current
    if (body === null || !bodyOpen) {
      setBarVisible(false)
      return undefined
    }
    const measure = (): void => {
      setBarVisible(expandedContentHeight(body) > BAR_MIN_CONTENT_H)
    }
    measure()
    // 换字号、换密度、结果后到都会改展开区高度，所以跟着重量，而不是只量一次。
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => {
      observer.disconnect()
    }
  }, [bodyOpen, call.argsText, call.resultText, call.status])

  /**
   * 吸附态要额外补一条与滚动容器顶部内距等高的底。
   *
   * 为什么：sticky 只把栏吸到滚动容器的内容盒顶端，`.chat` 顶部还有 12px 内距，
   * 那条缝里会露出半行刚滚过去的参数——看着像渲染坏了。判断「栏顶是否已经贴住滚动
   * 容器顶端」（阈值取自 .chat 真实的内距，不写死像素），贴住了才加 .stuck 补缝；
   * 没贴住就不加，否则这条底会盖在紧凑行的下半截文字上。
   */
  useEffect(() => {
    if (!bodyOpen || !barVisible) return undefined
    const bar = barRef.current
    const body = bodyRef.current
    if (bar === null || body === null) return undefined
    const chat = body.closest('.chat')
    if (!(chat instanceof HTMLElement)) return undefined
    const padTop = Number.parseFloat(getComputedStyle(chat).paddingTop)
    const threshold = (Number.isFinite(padTop) ? padTop : 12) + 1.5
    const sync = (): void => {
      const gap = bar.getBoundingClientRect().top - chat.getBoundingClientRect().top
      bar.classList.toggle('stuck', gap <= threshold)
    }
    sync()
    chat.addEventListener('scroll', sync, { passive: true })
    return () => {
      chat.removeEventListener('scroll', sync)
    }
  }, [bodyOpen, barVisible, call.argsText, call.resultText, call.status])

  // 用时口径：优先宿主上报的本次调用耗时（ToolCallView.durationMs），没有就不印。
  const duration = formatDuration(call.durationMs ?? null)
  const barStatus =
    running || duration === null ? (TOOL_STATUS_TEXT[call.status] ?? call.status) : `${TOOL_STATUS_TEXT[call.status] ?? call.status} · 用时 ${duration}`

  return (
    <div className={`entry tool-card status-${call.status}${bodyOpen ? ' open' : ''}`}>
      <div
        className="tool-head"
        role="button"
        tabIndex={expandable ? 0 : -1}
        {...(expandable ? { 'aria-expanded': bodyOpen } : {})}
        data-tip={expandable ? (bodyOpen ? '收起参数与结果' : '展开参数与结果') : '正在准备参数'}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          toggle()
        }}
      >
        {/* 行首状态点：成功绿 / 失败红 / 被拒黄 / 进行中强调色（codex 的 bullet）。 */}
        <span className="tool-dot" aria-hidden="true" />
        <Icon size={14} className="tool-icon" />
        <span className="verb">{toolVerb(match.base, call.status)}</span>
        {/* 认不出的工具保留原名：没有它就看不出这是哪家的工具（MCP 那些名字不直观）。
            分隔点照 dsh 的「工具调用 · <工具名>」。 */}
        {match.known ? null : <span className="name">{`· ${call.name}`}</span>}
        <span className="preview">
          {intended !== null ? (
            <>
              <OpenPathButton absPath={intended.absPath} cwd={cwd} patch={intended.file ?? call.change ?? null} />
              {intended.file !== null && (
                <span className="changes-counts">
                  {intended.file.status === 'added' && <span className="diff-badge">新增</span>}
                  <span className="changes-added">{`+${String(intended.file.added)}`}</span>
                  <span className="changes-removed">{`-${String(intended.file.removed)}`}</span>
                </span>
              )}
              {intended.mismatch === 'missing' && <span className="tc-warn">old 不在当前文件里</span>}
              {intended.mismatch === 'ambiguous' && <span className="tc-warn">old 匹配多处</span>}
            </>
          ) : targetPath !== null ? (
            <OpenPathButton absPath={targetPath} cwd={cwd} patch={call.change ?? null} />
          ) : (
            summary
          )}
        </span>
        <span className="status">
          {call.status === 'running' ? <i className="tc-spin" aria-hidden="true" /> : null}
          {/* 定稿不说「完成」：状态点已经绿了，再印一遍是噪声（codex 也只留圆点）。 */}
          {call.status === 'done' ? '' : (TOOL_STATUS_TEXT[call.status] ?? call.status)}
          {duration === null || call.status === 'done' ? '' : ` · 用时 ${duration}`}
        </span>
        {/* 「在轨迹中查看」（对照 dsh 工具行 hover 的药丸）：切到轨迹页并聚焦这一条。
            默认透明（不抢行内的注意力），悬停/键盘聚焦才浮出来。 */}
        <button
          type="button"
          className="tc-trace"
          data-trace-jump={String(entry.id)}
          data-tip="在轨迹页查看这条调用的时刻与耗时"
          aria-label="在轨迹中查看"
          onClick={(event) => {
            event.stopPropagation()
            openTrace(entry.id)
          }}
        >
          在轨迹中查看
        </button>
        {expandable ? <IconChevronDown size={11} className="tc-chevron" /> : null}
      </div>
      {bodyOpen ? (
        <div className="tool-body" ref={bodyRef}>
          {barVisible ? (
            <div className="tc-bar" data-tc-chrome="1" ref={barRef}>
              <span className="tc-bar-status">{barStatus}</span>
              {/* 还在跑的时候不给「收起」：这一刻收起只会让人以为任务被取消了。 */}
              {running ? null : (
                <button
                  type="button"
                  className="tc-collapse"
                  title="收起这张工具卡"
                  onClick={() => {
                    setOpenPersisted(false)
                  }}
                >
                  收起
                  <IconChevronUp size={11} />
                </button>
              )}
            </div>
          ) : null}
          {intended !== null ? (
            <div className="tc-intended">
              <div className="tc-intended-head">
                <span className="tc-intended-title">将做的改动</span>
                {intended.fellBack && <span className="tc-warn">读不到文件当前内容，以下按参数推算</span>}
                {intended.mismatch === 'missing' && <span className="tc-warn">old 在文件中不存在，执行会失败</span>}
                {intended.mismatch === 'ambiguous' && <span className="tc-warn">old 匹配多处，执行会失败</span>}
              </div>
              {intended.file === null ? (
                <p className="tc-intended-note">两段内容一致，不会有实际改动。</p>
              ) : (
                <div className="tc-intended-diff">
                  <DiffRows hunks={intended.file.hunks} path={intended.absPath} />
                </div>
              )}
            </div>
          ) : null}
          <div className="label">参数</div>
          <div className="args">{prettyJson(call.argsText)}</div>
          {call.resultText === undefined || call.resultText === '' ? null : (
            <>
              <div className="label">结果</div>
              <div className="result">{call.resultText}</div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** 队友卡的状态词。 */
const SUB_STATE_TEXT: Readonly<Record<string, string>> = {
  working: '干活中',
  idle: '已收工',
  stopped: '被打断',
  failed: '过程失败',
}

/** 队友卡：旧消息流里没有对应物，这一块是壳自己补的（属于已知的样式增量）。 */
function SubagentRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'subagent' }> }): ReactNode {
  const sub = entry.sub
  return (
    <div className="shell-subagent" data-state={sub.state}>
      <div className="shell-subagent-head">
        <span className="shell-subagent-name">{sub.name}</span>
        <span className="shell-subagent-role">{sub.role}</span>
        <span className="shell-subagent-state">{SUB_STATE_TEXT[sub.state] ?? sub.state}</span>
      </div>
      <p className="shell-subagent-task">{oneLine(sub.task, 160)}</p>
      <p className="shell-subagent-meta">
        {sub.rounds} 轮 · {sub.toolCalls} 次工具
        {sub.tokens === undefined ? '' : ` · ${formatTokens(sub.tokens)} tok`}
        {sub.lastTool === undefined ? '' : ` · 当前 ${sub.lastTool.name}`}
      </p>
      {sub.error === undefined ? null : <p className="shell-subagent-error">{sub.error}</p>}
    </div>
  )
}

/**
 * 把本轮改动合成一份清单。
 *
 * 优先级照旧界面：先看有没有 `turnDiff`（回合基线的聚合差异），有就只用它；否则把逐条
 * `changes` 按路径合并（同文件多刀把增删行数相加、差异段顺次拼起来）。
 */
function mergeChanges(rows: readonly Row[]): ChangedFileView[] {
  const turnDiff = findLast(rows, (row) => row.entry.kind === 'turnDiff')
  if (turnDiff !== undefined && turnDiff.entry.kind === 'turnDiff') return turnDiff.entry.files
  const byPath = new Map<string, ChangedFileView>()
  for (const row of rows) {
    if (row.entry.kind !== 'changes') continue
    const file = row.entry.file
    const existing = byPath.get(file.path)
    byPath.set(
      file.path,
      existing === undefined
        ? file
        : {
            ...existing,
            added: existing.added + file.added,
            removed: existing.removed + file.removed,
            hunks: [...existing.hunks, ...file.hunks],
            ...(existing.truncated === true || file.truncated === true ? { truncated: true } : {}),
          },
    )
  }
  return [...byPath.values()]
}

/** 折叠阈值之下的行数（对照旧界面 ChangedFiles 的 COLLAPSED_ROWS = 4）。 */
const COLLAPSED_ROWS = 4

/** 增删计数（绿 + / 红 -；与旧界面同款结构）。 */
function Counts({ added, removed }: { added: number; removed: number }): ReactNode {
  return (
    <span className="changes-counts">
      <span className="changes-added">{`+${String(added)}`}</span>
      <span className="changes-removed">{`-${String(removed)}`}</span>
    </span>
  )
}

/**
 * 悬停预览浮层（旧界面 `DiffHoverCard` 的同构移植）：显示**该文件的 diff**——hunks 数据
 * 就在条目上，不读盘、没有工作目录限制；宽 = 聚合卡宽 − 48，锚上方优先、放不下落下方，
 * maxHeight 420。挂在 body 下，不被聊天区的滚动/裁剪框住。
 *
 * Escape 关闭走 capture：审批卡在冒泡阶段监听 Esc=拒绝，预览开着时按 Esc 只该收预览。
 * 鼠标进卡 keep()、出卡 onLeave() 起同一条收卡倒计时——只挂 onKeep 会让卡**永远粘住**
 * （行上的 mouseleave 早在鼠标进卡那一刻就烧掉了），这是 2026-10-14 用户报的毛病之一。
 */
function DiffHoverCard({
  file,
  anchor,
  cardWidth,
  cwd,
  onKeep,
  onLeave,
  onClose,
}: {
  file: ChangedFileView
  anchor: DOMRect
  cardWidth: number
  cwd: string
  /** 鼠标移进卡里：取消「移开后收卡」的倒计时，用户能与卡内容交互。 */
  onKeep: () => void
  /** 鼠标离开卡：起收卡倒计时（与「从行上移开」同一条，1s 后收）。 */
  onLeave: () => void
  onClose: () => void
}): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const width = Math.max(320, Math.min(cardWidth - 48, window.innerWidth - 16))
  const maxHeight = Math.min(420, window.innerHeight - 24)
  // 上方放得下（按上限估）就贴行上方，否则落行下方；横向夹进视口。
  const left = Math.min(Math.max(8, anchor.left - 24), Math.max(8, window.innerWidth - width - 8))
  const style: CSSProperties =
    anchor.top - 12 >= maxHeight
      ? { left: `${String(left)}px`, bottom: `${String(window.innerHeight - anchor.top + 6)}px`, width: `${String(width)}px`, maxHeight: `${String(maxHeight)}px` }
      : { left: `${String(left)}px`, top: `${String(anchor.bottom + 6)}px`, width: `${String(width)}px`, maxHeight: `${String(maxHeight)}px` }
  return createPortal(
    <div className="hover-preview" style={style} onMouseEnter={onKeep} onMouseLeave={onLeave}>
      <div className="hover-preview-head">
        <FileIcon name={file.path} size={14} />
        <span className="hover-preview-name" title={file.path}>
          {displayPathOf(file.path, cwd)}
        </span>
        <span className="hover-preview-stat">
          {file.status === 'added' && <span className="diff-badge">新增</span>}
          <span className="changes-added">{`+${String(file.added)}`}</span>
          <span className="changes-removed">{`-${String(file.removed)}`}</span>
        </span>
      </div>
      <div className="hover-preview-diff">
        <DiffRows hunks={file.hunks} path={file.path} />
      </div>
    </div>,
    document.body,
  )
}

/**
 * 轮尾的「文件已更改」聚合卡（旧界面 `ChangedFilesCard` 的同构移植）。
 *
 * 数据是同一轮里成功落盘的文件改动（`kind: 'changes'` 逐刀条目 + `kind: 'turnDiff'`
 * 回合聚合条目）：有聚合条目就用它，没有就回退逐条合并。界面只做聚合与展示，不碰文件
 * 系统——悬停预览也只用 hunks：行上停 500ms 出该文件的 diff（不读盘、无工作目录限制）。
 *
 * 交互照旧界面：卡头点击审查、每行「审查」开审查面板并定位到该文件、「打开」进文件
 * 预览页签、超过 {@link COLLAPSED_ROWS} 行时列表折起、靠底部按钮放全。
 */
function ChangesCard({ rows, cwd }: { rows: readonly Row[]; cwd: string }): ReactNode {
  const files = useMemo(() => mergeChanges(rows), [rows])
  const [expanded, setExpanded] = useState(true)
  // 悬停预览：行上停够 500ms 才出卡（避免划过一路闪卡）；移开 1s 后收（行上移开、
  // 鼠标离开卡各自起同一条倒计时），移进卡里续命。
  const cardRef = useRef<HTMLDivElement | null>(null)
  const hoverDelay = useHoverDelay<ChangedFileView>()
  const { hover } = hoverDelay
  // 行数换了（换轮/会话重放）就按新条数重置折起态：≤4 行直接全露。
  useEffect(() => {
    setExpanded(files.length <= COLLAPSED_ROWS)
  }, [files.length])
  if (files.length === 0) return null
  const totalAdded = files.reduce((sum, file) => sum + file.added, 0)
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0)
  const single = files.length === 1 ? files[0] : undefined
  const visible = expanded ? files : files.slice(0, COLLAPSED_ROWS)
  /** 开审查栏：把这一轮的清单与下标交给它（旧界面：并排右栏定位到该文件）。 */
  const reviewAt = (index: number): void => {
    setDockReview({ files, index, cwd })
  }
  /** 进文件预览页签（看文件当前内容，审查看的是修改当时的快照）。 */
  const openAt = (path: string): void => {
    setDockPreview({ path, cwd })
  }
  const armHover = (file: ChangedFileView, anchor: DOMRect): void => {
    hoverDelay.arm(file, anchor, cardRef.current?.offsetWidth ?? 480)
  }
  return (
    // 不再包 `.entry-row`：旧版里 `.changes-card` 是 `.turn-seat` 的直接子项，间距靠
    // `.turn-seat > .changes-card` 那条规则给（多包一层会让选择器失配）。
    <div className="changes-card" ref={cardRef} data-changed-files="" {...(single === undefined ? {} : { 'data-single': '1' })}>
        <button
          type="button"
          className="changes-head"
          onClick={() => {
            reviewAt(files.indexOf(single ?? files[0]!))
          }}
        >
          <span className="changes-tile">
            {/* 卡头是文件自己的彩色图标（单文件用它，多文件用第一个）——旧界面同款。 */}
            <FileIcon name={(single ?? files[0]!).path} size={20} />
          </span>
          <span className="changes-titles">
            <span className="changes-title">{single === undefined ? `${String(files.length)} 个文件已更改` : baseNameOf(single.path)}</span>
            <span className="changes-stat">
              <Counts added={totalAdded} removed={totalRemoved} />
              <span className="changes-hint">点击审查改动</span>
            </span>
          </span>
        </button>
        {single === undefined ? (
          <ul className="changes-list">
            {visible.map((file) => (
              <li
                className="changes-row-wrap"
                key={file.path}
                onMouseEnter={(event) => armHover(file, event.currentTarget.getBoundingClientRect())}
                onMouseLeave={hoverDelay.disarm}
              >
                <button
                  type="button"
                  className="changes-row"
                  onClick={() => {
                    reviewAt(files.indexOf(file))
                  }}
                >
                  <span className="changes-path" title={file.path}>
                    {file.status === 'added' && <span className="changes-badge">新增</span>}
                    {displayPathOf(file.path, cwd)}
                  </span>
                  <Counts added={file.added} removed={file.removed} />
                </button>
                <span className="changes-act">
                  <button
                    type="button"
                    className="changes-btn"
                    onClick={() => {
                      reviewAt(files.indexOf(file))
                    }}
                  >
                    审查
                  </button>
                  <button
                    type="button"
                    className="changes-btn"
                    onClick={() => {
                      openAt(file.path)
                    }}
                  >
                    打开
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {single === undefined && files.length > COLLAPSED_ROWS ? (
          <button
            type="button"
            className="changes-toggle"
            onClick={() => {
              setExpanded((value) => !value)
            }}
          >
            {expanded ? '收起' : `展开全部 ${String(files.length)} 个文件`}
          </button>
        ) : null}
        {single !== undefined ? (
          <div className="changes-act changes-act-single">
            <button
              type="button"
              className="changes-btn"
              onClick={() => {
                reviewAt(0)
              }}
            >
              审查
            </button>
            <button
              type="button"
              className="changes-btn"
              onClick={() => {
                openAt(single.path)
              }}
            >
              打开
            </button>
          </div>
        ) : null}
        {hover !== null ? (
          <DiffHoverCard
            file={hover.item}
            anchor={hover.anchor}
            cardWidth={hover.cardWidth}
            cwd={cwd}
            onKeep={hoverDelay.keep}
            onLeave={hoverDelay.disarm}
            onClose={hoverDelay.close}
          />
        ) : null}
    </div>
  )
}

/**
 * 轮尾一行（桌面端 `TurnFooter.tsx` 的同构移植）：复制 · 分叉 · 用量 · 时刻，
 * 一条左对齐行。
 *
 * 赞 / 踩两颗钮**去掉了**（产品决定）：评价只记本机、没有上传通道，留两颗按了不出声的
 * 钮只会让人以为「反馈发出去了」；本机存档（`dsc.messageFeedback`）也一并不再读写。
 *
 * 「用时」不占行面、只挂在整行的 title 上（旧界面口径：它是这一行里分量最轻的一项，
 * 形态上也与 dsh 不同——dsh 只在整轮过程总开关的标签上报时长）。**别再把它印成可见的
 * 一行字**：早期壳版在这里印原始秒数，把「684083.4 秒」这种数字直接摊给了用户。
 *
 * 降级规则（老会话没有 ts 时是常态，不是异常）：什么都没有 → 整行不画；只拿得到开始
 * 时刻 → 只显示 HH:mm；用时算不出来（含乱序日志）→ 不往 title 里写。绝不显示 NaN。
 * 这一轮还在跑时时刻与用量都不画：那一刻流末尾的状态行正在报同一份时间，两处一起跳
 * 反而乱；用量还在长，报半截数字没有意义。分叉按钮要留在这一行上（置灰）。
 */
function RoundFoot(props: {
  /** 这一轮的起止时刻（timing.roundInfos 那份；用时 = 它俩之差）。 */
  round: RoundInfo
  /** 这一轮还在跑：时刻与用量先不画。 */
  running: boolean
  /** 这一轮最终回答的原文；没有（以工具结果收尾）就不画复制。 */
  copyText?: string
  /** 宿主上报的整轮真实用量（该轮最后一条带 usage 的条目）。 */
  usage: { inputTokens: number; outputTokens: number } | null
  /** 这一轮正文的 token 估算（没有真值时回落显示，带 ~）。 */
  tokens: number | null
  /** 「分叉这一轮」；undefined = 这个视图分不了（只读 / 第 1 轮）。 */
  onFork?: () => void
}): ReactNode {
  const clock = props.running ? null : formatClock(props.round.startTs)
  const used = props.running ? null : formatDuration(roundDuration(props.round))
  // 真值优先：0 或负数当没上报——真跑过一轮不可能一个 token 都没有。
  const measured = props.running ? null : props.usage
  const real =
    measured !== null && measured.inputTokens + measured.outputTokens > 0
      ? measured.inputTokens + measured.outputTokens
      : null
  // 回落口径：没有宿主上报的用量才用正文估算顶上（显示时带 ~）。
  const estimated = real !== null || props.running || props.tokens === null || props.tokens <= 0 ? null : props.tokens
  const copy = props.copyText !== undefined && props.copyText !== ''
  const fork = props.onFork !== undefined
  // 老会话什么时间都拿不到、又没有动作与用量要画：这一行不必占位（旧界面整行不渲染）。
  if (clock === null && !copy && !fork && real === null && estimated === null) return null
  return (
    // 与 `.changes-card` 同理：不再包 `.entry-row`，让 `.turn-seat > .round-foot` 的
    // 间距规则命中——包一层之后那条规则失配，回落到 `.round-foot` 自带的 -15px
    // 负外边距（它本来是给旧版 `.chat-inner` 的 16px 间距设计的），会把这一行顶进
    // 上面的改动卡里（截图里的「底部按钮与文件变更重叠」就是这么来的）。
    <div
      className="round-foot"
      // 「用时」不占行面，放在整行的悬停提示里（口径与旧界面一致）。
      title={
        used === null
          ? undefined
          : `用时 ${used}（从发出这条消息到这一轮最后一次写入，中间的工具调用与思考都算在内）`
      }
    >
      {copy ? (
        <button
          type="button"
          className="round-act"
          title="复制这条回复的原文"
          aria-label="复制这条回复的原文"
          onClick={() => {
            // 剪贴板被浏览器拒绝（非安全上下文）时不给假反馈，所以 .catch 里什么都不做。
            void navigator.clipboard.writeText(props.copyText ?? '').catch(() => undefined)
          }}
        >
          <IconCopy size={17} />
        </button>
      ) : null}
      {fork ? (
        <button
          type="button"
          className="user-act"
          title="以这条消息为界分叉出新会话"
          aria-label="以这条消息为界分叉出新会话"
          disabled={props.running}
          onClick={props.onFork}
        >
          {/* 图标 15px：方向性动作用小图标（与旧界面同一档），读数（用量、时刻）才用大的。 */}
          <IconBranch size={15} />
        </button>
      ) : null}
      {real !== null ? (
        <span
          className="round-tokens"
          title="这一轮所有模型请求的 prompt 与 completion 之和（宿主上报的真实用量）"
        >
          用量 {formatTokens(real)} tok
        </span>
      ) : null}
      {estimated !== null ? (
        <span
          className="round-tokens"
          title="助手正文的 token 估算值（老会话无宿主上报用量）"
        >
          ~{formatTokens(estimated)} tok
        </span>
      ) : null}
      {clock !== null && (real !== null || estimated !== null) ? (
        <span className="round-sep" aria-hidden="true">
          ·
        </span>
      ) : null}
      {clock !== null ? (
        <span className="round-clock" title="这条消息发出的时刻（本机时区）">
          {clock}
        </span>
      ) : null}
    </div>
  )
}

/**
 * 助手回合进行中的状态行（桌面端 TurnStatusLine.tsx 同构移植）：
 * 第一行：旋转圈 + 阶段说明；中间一条浅色分割线；第二行：星标 + 当前活动名 + 已用时 + 动画省略号。
 *
 * 计时口径：这一轮从用户消息发出算起（条目上的 ts）。老会话拿不到 ts 时退回
 * 「本组件第一次看到这一轮的时刻」——计时器永远有值，不精确但不会显示 NaN。
 */
function TurnStatusLine(props: { stage: string; activity: string; startedAt: number | null }): ReactNode {
  const fallbackStart = useRef(Date.now())
  const [now, setNow] = useState(() => Date.now())

  // 每秒跳一次。这个 interval 只在状态行挂着的时候存在，回合结束随组件一起卸载。
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const elapsed = formatDuration(now - (props.startedAt ?? fallbackStart.current))

  return (
    <div className="turn-status">
      <div className="turn-status-row">
        <span className="turn-status-spin" aria-hidden="true" />
        <span className="turn-status-stage" role="status">
          {props.stage}
        </span>
      </div>
      <div className="turn-status-rule" aria-hidden="true" />
      <div className="turn-status-row">
        <IconSpark size={12} className="turn-status-icon" />
        <span className="turn-status-activity">
          {props.activity}
          {elapsed === null ? null : `，用时 ${elapsed}`}
        </span>
        <span className="turn-status-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  )
}

/**
 * 一行一个错误边界。
 *
 * 为什么行级也要兜：消息流整条流是**一个**槽条目，壳的错误边界是按条目退位的——
 * 一行渲染崩了会让整条流消失。多包一层之后，坏的那一行显示原因，其余照常。
 *
 * 条目更新时清掉错误再试一次：工具卡从「跑动中」变成「完成」是同一个条目换数据，
 * 如果一次画崩就永久留住错误，那一行会一直显示错误而看不到后来的正确内容。
 */
class RowBoundary extends Component<{ entry: TranscriptEntry; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidUpdate(previous: { entry: TranscriptEntry }): void {
    if (this.state.error !== null && previous.entry !== this.props.entry) this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return <div className="entry-system">这一条没画出来：{this.state.error.message}</div>
    }
    return this.props.children
  }
}

/**
 * 一行的 React key：**会话标识 + 条目 id**。
 *
 * 为什么刻意**不含 ts**（0.6.67 的抽搐就是这么来的）：直播尾的 `ts` 会在**每一口 delta**
 * 上被刷新（`src/adapter/transcript.ts:600` 的 `last.ts = ts`），拿它拼键等于每来一个字
 * 就把这一行重挂一次。重挂的后果有两个，正好是用户报的两条：
 *   - `@starting-style` 那段高度过渡每次重挂都从 0fr 重播一遍 → 思考块一抽一抽的；
 *   - 组件的 `useState` 初值重新算（跑动中的思考行算出来是「展开」）→ 点收起立刻被打回
 *     展开态，看上去「思考内容关不掉」。
 *
 * 为什么还要带会话标识：`id` 只在**一段内容里**稳定（定稿合进同一条时 id 不变），两条会话
 * 的条目 id 都从 1 开始——只按 id 拼，切会话时 React 会把上一条会话的实例借给这一条，
 * 用户点开的折叠态就串味了。
 */
function keyOf(row: Row, sessionKey: string): string {
  return `${sessionKey}|${String(row.entry.id)}`
}

/**
 * 把条目切成座位与轮（口径见 rounds.ts 的 `splitRounds`）：直播条目按序接在定稿之后，
 * 分轮规则与轮元信息共用同一份，于是 `rounds[i].round === infos[i].index` 恒成立——
 * 座位序号与 `RoundInfo` 下标**结构上不可能错开**（旧版这里只看 `kind === 'user'`，
 * 插话（steering）会多切一个座位，把 `rounds[seat.round]` 整体顶偏，就是右侧刻度条
 * 错位、多刻度的根因）。每行记下它在**全量条目**（定稿 + 直播）里的下标（折叠区间用）。
 *
 * @returns leading 前导行；rounds 座位；infos 对应的轮元信息（TranscriptFlow 直接拿去用，
 *   不再单独调一次 `roundInfos`——那正是「两处分轮互相打架」的来源）。
 */
function buildSeats(
  entries: readonly TranscriptEntry[],
  live: readonly TranscriptEntry[],
): { leading: Row[]; rounds: Seat[]; infos: RoundInfo[] } {
  const all: readonly TranscriptEntry[] = [...entries, ...live]
  const split = splitRounds(all)
  const rowOf = (at: number): Row => ({ entry: all[at], live: at >= entries.length, at })
  return {
    leading: split.leading.map(rowOf),
    rounds: split.seats.map((seat) => ({ round: seat.round, rows: seat.indices.map(rowOf) })),
    infos: split.rounds,
  }
}

// ── 只读「子智能体条目流」（右栏页签用）────────────────────────────────────────
/**
 * 槽位名：只读条目流的落点（团队右栏页签经 `transcriptFlow` 服务拿到的组件）。
 *
 * 团队插件是把**组件当值**直接渲染的（没有槽渲染上下文），所以这条登记在运行时由壳渲染
 * 只是「将来宿主愿意的话」的出口；声明它的意义在于让那条条目具备 toolview 选举链——
 * 见 apply 里的注册与 {@link SubagentFlow} 的 `renderSlot` 说明。
 */
export const SUBAGENT_FLOW_SLOT = 'shell.subagent.flow'

/** 只读条目流的输入（团队页签把 `peekTranscript` 回的条目原样喂进来）。 */
export interface TranscriptFlowProps {
  entries: readonly TranscriptEntry[]
  /** 会话工作目录：相对路径展示与「将做的改动」推演的基准；拿不到给空串。 */
  cwd?: string
  /**
   * 折叠存档键的会话那一半（思考/工具卡的展开态）：拿不到时给队友会话文件路径，
   * 免得不同队友的条目 id（都从 1 起）撞在同一把键上。
   */
  sessionKey?: string
}

/** `transcriptFlow` 服务的形状：组件本身 + 它的槽位名（槽名给诊断与将来的宿主渲染用）。 */
export interface TranscriptFlowService {
  Component: (props: TranscriptFlowProps) => ReactNode
  slot: string
}

/**
 * 只读条目流：把一份 `TranscriptEntry[]` 用**主会话同一套行渲染**铺出来
 * （markdown 正文 / 思考折叠 / 工具卡 / 子代理卡 / 计划卡 / system 行）。
 *
 * 与主会话 {@link TranscriptFlow} 的差别只有三处，都是「只读」这件事本身要求的：
 *  - 动作 context 给 {@link NO_ACTIONS}（没有「编辑重发」这条出口）；
 *  - 用户消息走 {@link ReadonlyUserRow}（气泡照画，不画 hover 浮出的编辑钮）；
 *  - 不画轮尾 / 改动卡 / 刻度条 / 分页 / 整轮折叠——右栏是伴读面，不是操作面。
 *
 * 工具行走 `renderSlot(TOOLVIEW_SLOT, …)`：本条目在 SlotMap 里声明了这条 chain 子槽，
 * 被壳当槽条目渲染时由选举链决定谁画。团队插件是直接把组件当值渲染（没有槽渲染上下文），
 * 那时 `renderSlot` 缺席，落到内置工具卡 {@link ToolRow}——与 `RowBody` 自己的兜底
 * （`renderSlot?.(…) ?? <ToolRow …/>`）是同一条路，工具卡照常出得来。
 */
function SubagentFlow(props: {
  entries?: readonly TranscriptEntry[]
  cwd?: string
  sessionKey?: string
  /** 槽渲染上下文（壳把本条目当槽条目渲染时才有）；缺席时用内置工具卡兜底。 */
  renderSlot?: ToolViewRender
  childSlots?: readonly string[]
}): ReactNode {
  const entries = props.entries ?? NO_ENTRIES
  const cwd = props.cwd ?? ''
  const toolRender: ToolViewRender =
    props.renderSlot ?? ((_name, owner) => <ToolRow entry={owner.entry} storeKey={owner.storeKey} />)
  const rows = useMemo<Row[]>(() => entries.map((entry, at) => ({ entry, live: false, at })), [entries])
  return (
    <ShellSessionContext.Provider value={props.sessionKey ?? null}>
    <ShellCwdContext.Provider value={cwd}>
    <FoldPrefsContext.Provider value={FOLD_PREFS}>
    <FlowActionsContext.Provider value={NO_ACTIONS}>
      <div className="chat-inner subagent-flow">
        {rows.map((row) => (
          <div className="entry-row" key={`sub|${row.entry.kind}|${String(row.entry.id)}`}>
            <RowBoundary entry={row.entry}>
              {row.entry.kind === 'user' ? <ReadonlyUserRow entry={row.entry} /> : <RowBody row={row} renderSlot={toolRender} />}
            </RowBoundary>
          </div>
        ))}
      </div>
    </FlowActionsContext.Provider>
    </FoldPrefsContext.Provider>
    </ShellCwdContext.Provider>
    </ShellSessionContext.Provider>
  )
}

/** 只读用户消息：UserRow 的同款气泡，去掉 hover 浮出的「编辑并重发」。 */
function ReadonlyUserRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }): ReactNode {
  // 运行时投递进来的消息（队友汇报）整条交给 UserRow：它对这个 kind 提前 return「触发行」，
  // 本来就不带编辑钮，所以只读出口可以原样复用——文案只有一处（rounds.ts 的
  // teammateReportLabel），不会出现主会话与右栏对同一件事说两句话。
  if (entry.internal === true) return <UserRow entry={entry} />
  return (
    <div className="user-turn">
      <div className="entry-user">
        {entry.images === undefined || entry.images.length === 0 ? null : (
          <div className="entry-user-images">
            {entry.images.map((url, index) => (
              <a key={index} href={url} target="_blank" rel="noreferrer" data-tip="点开看原图">
                <img src={url} alt={`第 ${String(index + 1)} 张贴图`} />
              </a>
            ))}
          </div>
        )}
        <UserFileCards files={entry.files} />
        {entry.text}
      </div>
    </div>
  )
}

/**
 * 附件体积的人话读法（1024 进制）：不到 1KB 给整数 B，不到 1MB 给一位小数 KB，再往上一位小数 MB。
 *
 * @param bytes - 字节数。
 * @returns 形如 `512 B` / `3.4 KB` / `1.2 MB`；数字不合法时给一个破折号，不显示 NaN。
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${String(Math.round(bytes))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
