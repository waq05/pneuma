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
import { Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  DiffRows,
  FileIcon,
  IconBranch,
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconEdit,
  IconSpark,
  MarkdownView,
  defineUiPlugin,
  estimateTextTokens,
  getHostNative,
  openTrace,
  setDockPreview,
  setDockReview,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
  type ChangedFileView,
  type HostSnapshot,
  type SlotComponentProps,
  type SlotMatchedOf,
  type SlotOwnerOf,
  type TranscriptEntry,
} from '@dsc/ui'
import { buildRoundFolds, processFoldPolicy, TurnFoldRow, useFoldMemory, type ProcessFold } from './round-fold'
import { formatClock, formatDuration, liveActivity, roundDuration, roundInfos, turnStartedAt, type RoundInfo } from './timing'
import { useIntendedDiff } from './intended-diff'
import { readFold, writeFold, stepGroupFoldKey, turnFoldKey } from './fold-state'
import { groupSteps, type StepGroup, type StepGrouping } from './process-groups'
import { RowSeat, StepGroupSeat } from './fold-seats'
import { JumpRail, previewText } from './jump-rail'
// 路径/悬停/完成音/工具摘要口径从平台种子（`@dsc/ui-primitives`）取：与壳内部同一份实现，
// 不再内联（E6）——completion-sound 带模块级 AudioContext 单例，重复一份会造出两个。
import { TOOL_STATUS_TEXT, baseNameOf, displayPathOf, formatTokens, matchTool, oneLine, playCompletionSound, prettyJson, toolSummary, toolVerb, useHoverDelay, type ToolMatch } from '@dsc/ui-primitives'
import {
  ChatStatus,
  IntendedBody,
  IntendedPreview,
  TOOLCARD_FACTORY,
  TraceJumpButton,
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
const NO_ENTRIES: readonly TranscriptEntry[] = Object.freeze([])

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

/**
 * 跟着底部的自动滚动（对齐桌面端 use-chat-viewport 的核心行为）：
 * 用户停在底部时新条目进来就跟着走，自己往上翻过就暂停跟随——暂停时界面上
 * 出现「回到底部」按钮，点它恢复跟随。阈值 160px 是旧界面的口径。
 * 为什么要传 `dep`：条目数组每帧都是新的，拿引用当依赖会让每次快照都强制滚一次。
 */
function useFollowBottom(dep: number): { setEnd: (node: HTMLDivElement | null) => void; paused: boolean; resume: () => void } {
  const [end, setEnd] = useState<HTMLDivElement | null>(null)
  const pinned = useRef(true)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    const scroller = end?.closest('.chat')
    if (!(scroller instanceof HTMLElement)) return undefined
    const onScroll = (): void => {
      const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160
      pinned.current = atBottom
      setPaused(!atBottom)
    }
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [end])

  useEffect(() => {
    if (!pinned.current) return
    const scroller = end?.closest('.chat')
    if (scroller instanceof HTMLElement) scroller.scrollTop = scroller.scrollHeight
  }, [end, dep])

  const resume = (): void => {
    pinned.current = true
    setPaused(false)
    const scroller = end?.closest('.chat')
    if (scroller instanceof HTMLElement) scroller.scrollTop = scroller.scrollHeight
  }
  return { setEnd, paused, resume }
}

/** 一页装几轮（桌面端 PAGE_ROUNDS 同款）：分的是渲染量，不是数据量。 */
const PAGE_ROUNDS = 8

function TranscriptFlow({
  renderSlot,
}: SlotComponentProps<Record<never, never>, typeof TOOLVIEW_SLOT>): ReactNode {
  const entries = useHostSelector(readEntries)
  const live = useHostSelector(readLive)
  const turnState = useHostSelector(readTurnState)
  const sessionPath = useHostSelector(readSessionPath)
  const sessionId = useHostSelector(readSessionId)
  const cwd = useHostSelector(readCwdValue)
  const channel = useHostChannel()
  /**
   * 行 key 的会话那一半：优先用会话文件路径，没有就用会话 uuid，都没有就空串
   * （空串只出现在「宿主还没接上」那一瞬间，此时也还没有条目）。
   */
  const sessionKey = sessionPath ?? sessionId ?? ''
  const seats = useMemo(() => buildSeats(entries, live), [entries, live])
  const follow = useFollowBottom(entries.length + live.length)

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

  // 分页：只渲染最后 PAGE_ROUNDS 轮，更早的点「加载更早」再放出来（换会话重置）。
  const [firstVisible, setFirstVisible] = useState(0)
  const visibleSeats = useMemo(
    () => seats.rounds.filter((seat) => seat.round >= firstVisible),
    [seats.rounds, firstVisible],
  )
  useEffect(() => {
    setFirstVisible(Math.max(0, seats.rounds.length - PAGE_ROUNDS))
  }, [sessionPath, seats.rounds.length])

  // 整轮折叠：四档能力表 + 每轮的折叠预算 + 用户手动开合（双层记忆：当场重画 + 重挂读回）。
  const foldMemory = useFoldMemory()
  const rounds = useMemo(
    () => roundInfos([...entries, ...live]),
    [entries, live],
  )
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
    let index = 0
    for (const item of [...entries, ...live]) {
      if (item.id === entry.id) break
      if (item.kind === 'user' && item.steering !== true) index += 1
    }
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
          prompt: user?.kind === 'user' ? previewText(user.text, 'prompt') : '',
          response: answer === undefined ? '' : previewText(answer.text, 'response'),
        }
      }),
    [seats.rounds],
  )
  const revealRound = useCallback((round: number): void => {
    setFirstVisible((current) => Math.min(current, round))
  }, [])

  // 空会话欢迎态（与旧桌面界面同一份文案）：开场 system 提示行作注脚，
  // 「会话 x · 模型 y」那条开场标不画——它在状态栏悬浮卡里，再画一遍是重复。
  if (seats.rounds.length === 0 && seats.leading.every((row) => row.entry.kind === 'system')) {
    return (
      <div className="welcome">
        <h1>有什么可以帮忙的？</h1>
        <p>
          输入 <code>/</code> 查看可用指令 · 消息会携带当前工作目录上下文
        </p>
        {seats.leading.map((row) => {
          const text = row.entry.kind === 'system' ? row.entry.text : ''
          return isSessionMarker(text) ? null : (
            <div className="welcome-note" key={keyOf(row, sessionKey)}>
              {text}
            </div>
          )
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
      {firstVisible > 0 ? (
        <button
          type="button"
          className="chat-earlier"
          data-earlier-rounds={firstVisible}
          data-tip="把更早的几轮画出来，你现在看的位置不会动"
          onClick={() => {
            setFirstVisible((current) => Math.max(0, current - PAGE_ROUNDS))
          }}
        >
          {`加载更早的 ${String(Math.min(PAGE_ROUNDS, firstVisible))} 轮（上面还有 ${String(firstVisible)} 轮）`}
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

/** 读当前会话的 jsonl 路径（换会话时分页重置用）。 */
function readSessionPath(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const value = (status as Record<string, unknown>)['sessionPath']
  return typeof value === 'string' ? value : null
}

/** 当前会话 uuid（评价存档键用；旧界面也是拿它拼键）。 */
function readSessionId(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const value = (status as Record<string, unknown>)['sessionId']
  return typeof value === 'string' && value !== '' ? value : null
}

/** 会话工作目录（相对路径展示与「将做的改动」推演的基准）。 */
function readCwdValue(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return ''
  const value = (status as Record<string, unknown>)['cwd']
  return typeof value === 'string' ? value : ''
}

function readTurnState(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return 'idle'
  const value = (status as Record<string, unknown>)['turnState']
  return typeof value === 'string' ? value : 'idle'
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
  const usage = seat.rows.findLast(
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
  const rowByAt = new Map(seat.rows.map((row) => [row.at, row]))
  const processBlocks: ReactNode[] = []
  const afterBlocks: ReactNode[] = []
  for (const row of seat.rows.slice(1)) {
    const head = stepGrouping.headAt.get(row.at)
    if (head !== undefined) {
      const members: Row[] = []
      for (let at = head.startIndex; at <= head.endIndex; at += 1) {
        const member = rowByAt.get(at)
        if (member !== undefined) members.push(member)
      }
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
      {processBlocks}
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
  const entry = row.entry
  switch (entry.kind) {
    case 'user':
      return <UserRow entry={entry} />
    case 'text':
      return (
        <div className={row.live ? 'entry-text live' : 'entry-text'}>
          {/* 正文渲染 markdown（与桌面端 MarkdownText 同一能力面：GFM 表格/任务列表等）。
              直播尾同样渲染——半截 markdown 短暂错排是流式的固有代价，桌面端也一样。 */}
          <MarkdownView text={entry.text} path="" />
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
    case 'system':
      return <div className="entry-system">{entry.text}</div>
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

/** 用户消息：气泡 + 贴图条 + hover 浮出的「编辑」钮（编辑重发 = 分叉新会话重发，原会话保留）。 */
function UserRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }): ReactNode {
  const actions = useContext(FlowActionsContext)
  // 编辑中的草稿（null = 没在编辑）。Enter 提交 / Shift+Enter 换行 / Esc 取消。
  const [draft, setDraft] = useState<string | null>(null)
  // 运行时投递进来的消息（队友汇报）不拿它当人打的字渲染，与旧界面一致地压成一行。
  if (entry.internal === true) {
    return (
      <div className="entry-system" data-internal="1" title={entry.text}>
        子任务状态更新
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
  // 直播尾挂载即展开（它是「现在在干什么」的唯一线索）；定稿条目按用户的默认态设置。
  // 有存档就认存档——重挂（换会话再切回来）时不能让用户的展开白点。
  const [open, setOpen] = useState(() => readFold(storeKey, live || prefs.reasoningOpen))
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
        data-tip={open ? '点击收起这段思考过程' : '点击展开这段思考过程'}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          // 空格按在 div 上默认会滚页面，先挡掉再自己处理（与工具卡紧凑行同款）。
          event.preventDefault()
          toggle()
        }}
      >
        <IconSpark size={12} className="think-star" />
        <span className="think-label">思考过程</span>
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
          <span className="think-bar-status">思考过程 · {live ? '进行中' : '已完成'}</span>
          <button
            type="button"
            className="think-collapse"
            title="收起这段思考过程"
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
        data-tip={expandable ? (bodyOpen ? '点击收起参数与结果' : '点击展开参数与结果') : '正在准备参数'}
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
        {/* 认不出的工具保留原名：没有它就看不出这是哪家的工具（MCP 那些名字不直观）。 */}
        {match.known ? null : <span className="name">{call.name}</span>}
        <span className="preview">
          {intended !== null ? (
            <>
              <span className="tc-path" title={intended.absPath}>
                {displayPathOf(intended.absPath, cwd)}
              </span>
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
  const turnDiff = rows.findLast((row) => row.entry.kind === 'turnDiff')
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
 */
function DiffHoverCard({
  file,
  anchor,
  cardWidth,
  cwd,
  onKeep,
  onClose,
}: {
  file: ChangedFileView
  anchor: DOMRect
  cardWidth: number
  cwd: string
  /** 鼠标移进卡里：取消「移开 100ms 后收卡」的倒计时，用户能与卡内容交互。 */
  onKeep: () => void
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
    <div className="hover-preview" style={style} onMouseEnter={onKeep}>
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
  // 悬停预览：行上停够 500ms 才出卡（避免划过一路闪卡）；移开 100ms 后收，移进卡里续命。
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
          title="这一轮助手正文的 token 估算（中文约 0.65 token/字、其余约 0.33）；老会话没有宿主上报的用量，这是估算值"
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
 * 识别宿主开场写进消息流的那条「会话 xxx · 模型 yyy」（桌面端 session-marker.ts 同款）。
 * 状态栏悬浮卡已经带着会话 id 与模型，欢迎态里再画一遍是重复。
 * 为什么按正文形状认而不是按 kind 认：system 这一个 kind 混着十几种通知，
 * 只有这一条的正文长得出来这个形状；认不出就不动它。
 */
const SESSION_MARKER = /^会话 \S+ · 模型 \S+$/

function isSessionMarker(text: string): boolean {
  return SESSION_MARKER.test(text.trim())
}

/** 把条目按「遇到 user 就开新座位」切分，直播条目挂在最后一个座位上。每行记下它在全量条目里的下标（折叠区间用）。 */
function buildSeats(
  entries: readonly TranscriptEntry[],
  live: readonly TranscriptEntry[],
): { leading: Row[]; rounds: Seat[] } {
  const leading: Row[] = []
  const rounds: Seat[] = []
  entries.forEach((entry, at) => {
    const row: Row = { entry, live: false, at }
    if (entry.kind === 'user') {
      rounds.push({ round: rounds.length, rows: [row] })
      return
    }
    const current = rounds[rounds.length - 1]
    if (current === undefined) leading.push(row)
    else current.rows.push(row)
  })
  live.forEach((entry, offset) => {
    const row: Row = { entry, live: true, at: entries.length + offset }
    const current = rounds[rounds.length - 1]
    if (current === undefined) leading.push(row)
    else current.rows.push(row)
  })
  return { leading, rounds }
}

/** 帧里的条目只保证有 `id`，视图字段的收窄在插件这一侧完成（共用核心不认识具体种类）。 */
function readEntries(snapshot: HostSnapshot | null): readonly TranscriptEntry[] {
  const value = snapshot?.entries
  return Array.isArray(value) ? (value as unknown as TranscriptEntry[]) : NO_ENTRIES
}

function readLive(snapshot: HostSnapshot | null): readonly TranscriptEntry[] {
  const value = snapshot?.liveEntries
  return Array.isArray(value) ? (value as unknown as TranscriptEntry[]) : NO_ENTRIES
}
