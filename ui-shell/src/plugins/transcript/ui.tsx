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
 *   3. **整轮折叠已搬**（round-fold.ts，四档能力表跟着 `processFold` 偏好走）：
 *      定稿轮的过程收成一行「用时 X」，跑动中/插话/中断/失败的轮强制展开。
 *      **阶段组、右缘刻度条、吸附快捷栏还没搬**（见文件尾的诚实边界）。
 *
 * 与旧界面已知的差异（都是「功能还没有」而不是「样式对不上」）：
 *   - 阶段组（14 类过程聚合）与右缘刻度条未搬，长会话折叠后过程按条直排；
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
import { Component, createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  DiffRows,
  FileIcon,
  IconBranch,
  IconChevronDown,
  IconChevronUp,
  IconCode,
  IconCopy,
  IconEdit,
  IconFolder,
  IconSearch,
  IconSpark,
  IconTerminal,
  IconThumbDown,
  IconThumbUp,
  MarkdownView,
  defineUiPlugin,
  estimateTextTokens,
  getHostNative,
  setDockPanel,
  setDockPreview,
  setDockReview,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
  type ChangedFileView,
  type HostSnapshot,
  type ToolCallView,
  type TranscriptEntry,
} from '@dsc/ui'
import { buildRoundFolds, processFoldPolicy, TurnFoldRow, useTurnFoldMemory, type ProcessFold } from './round-fold'
import { formatClock, formatDuration, liveActivity, roundDuration, roundInfos, turnStartedAt, type RoundInfo } from './timing'
import { useIntendedDiff } from './intended-diff'
import { readFold, writeFold } from './fold-state'
import { baseNameOf, displayPathOf } from '../../platform/paths'
import { useHoverDelay } from '../../platform/hover-delay'
import { playCompletionSound } from '../../platform/completion-sound'

/** 折叠偏好经 context 穿进深处的 ThinkRow / ToolRow / 座位（插件树就在壳的树里，可用）。 */
interface FoldPrefs {
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

/** 工具条目（ToolRow 与 toolview 选举的 owner 形状）。 */
type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>

/** 工具调用视图的 chain 槽：每一条工具调用由选举出的渲染者负责（见下）。 */
export const TOOLVIEW_SLOT = 'transcript.toolview'

/**
 * 内置渲染器在链里的位置：priority 大（后问）——任何想接管某种工具的插件注册一个
 * 更小的 priority、选择器认领自己的工具就赢；内置选择器全认领（catch-all），
 * 所以链空着的时候工具卡照常画，链上有人接就归别人。
 */
const BUILTIN_TOOLVIEW_PRIORITY = 100

export default defineUiPlugin({
  name: '消息流',
  apply(ui) {
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
        select: (owner) => matchTool(toolOwnerCall(owner).name),
      },
      BuiltinToolView,
    )
  },
})

/** 从选举 owner 里取工具调用（选择器与当选组件共用这一个读法）。 */
function toolOwnerCall(owner: unknown): ToolCallView {
  const call = (owner as { entry?: { call?: ToolCallView } } | null)?.entry?.call
  if (call === undefined) throw new Error('toolview 的 owner 里没有工具调用（渲染方传的是 { entry }）')
  return call
}

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
}: {
  renderSlot?: (name: string, props?: Record<string, unknown>) => ReactNode
}): ReactNode {
  const entries = useHostSelector(readEntries)
  const live = useHostSelector(readLive)
  const turnState = useHostSelector(readTurnState)
  const sessionPath = useHostSelector(readSessionPath)
  const sessionId = useHostSelector(readSessionId)
  const cwd = useHostSelector(readCwdValue)
  const channel = useHostChannel()
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

  // 整轮折叠：四档能力表 + 每轮的折叠预算 + 用户手动开合（组件内记忆）。
  const foldMemory = useTurnFoldMemory()
  const rounds = useMemo(
    () => roundInfos([...entries, ...live]),
    [entries, live],
  )
  const liveRoundIndex = rounds.length - 1
  const roundFolds = useMemo(
    () => buildRoundFolds([...entries, ...live], rounds, { foldTurns: prefs.policy.foldTurns, live: turnState !== 'idle', lastRoundIndex: liveRoundIndex }),
    [entries, live, rounds, prefs.policy.foldTurns, turnState, liveRoundIndex],
  )

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
            <div className="welcome-note" key={keyOf(row)}>
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
        <RowBoundary key={keyOf(row)} entry={row.entry}>
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
            cwd={cwd}
            roundFolds={roundFolds}
            foldMemory={foldMemory}
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
  cwd,
  roundFolds,
  foldMemory,
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
  /** 会话工作目录：相对路径展示 + 「将做的改动」推演的相对路径基准。 */
  cwd: string
  roundFolds: ReadonlyMap<number, import('./round-fold').RoundFold>
  foldMemory: ReturnType<typeof useTurnFoldMemory>
  renderSlot?: (name: string, props?: Record<string, unknown>) => ReactNode
  /** 页脚「分叉这一轮」；undefined = 分不了（没在会话里 / 第 1 轮）。 */
  onFork?: () => void
}): ReactNode {
  const fold = roundFolds.get(seat.round)
  // 跑动中的轮连总开关都不画（永远展开）；可折的定稿轮才有开合。
  const foldRunning = fold?.running === true
  const foldable = fold !== undefined && fold.foldable && fold.hasContent && !foldRunning && !fold.blocked
  const processOpen = !foldable || foldMemory.isOpen(seat.round)
  // 无过程内容的定稿轮：总开关画成不可点的抬头（照 dsh 的 disabled），位置在用户消息之后。
  const showFoldRow = fold !== undefined && !foldRunning && shouldShowFoldRow(fold)
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
  return (
    <>
      {seat.rows.map((row) => (
        <span key={keyOf(row)} style={{ display: 'contents' }}>
          {showFoldRow && fold !== undefined && row.at === foldRowAt(fold, seat) ? (
            <div className="entry-row" data-round={seat.round}>
              <TurnFoldRow
                open={processOpen}
                round={roundInfo}
                disabled={!foldable}
                endReason={fold.endReason}
                onToggle={() => foldMemory.set(seat.round, !processOpen)}
              />
            </div>
          ) : null}
          <RowBoundary entry={row.entry}>
            <div
              className="entry-row"
              data-round={seat.round}
              // 过程区收起时整行挂 hidden="until-found"：不占版面，但 Ctrl+F 命中会自动展开。
              // @types/react 的 hidden 还只有 boolean，运行时 React 19 认字符串值，这里断言一次。
              {...(inFoldRange(fold, foldable, processOpen, row)
                ? { hidden: 'until-found' as unknown as boolean }
                : {})}
            >
              <RowBody row={row} renderSlot={renderSlot} />
            </div>
          </RowBoundary>
        </span>
      ))}
      <ChangesCard rows={seat.rows} cwd={cwd} />
      <RoundFoot
        round={roundInfo}
        running={running}
        sessionId={sessionId}
        copyText={answer?.text}
        copyId={answer?.id}
        usage={usage ?? null}
        tokens={tokens > 0 ? tokens : null}
        onFork={onFork}
      />
    </>
  )
}

/** 总开关行这一轮画不画：跑动中不画；其余定稿轮都画（可折或不可点的抬头）。 */
function shouldShowFoldRow(fold: { running: boolean }): boolean {
  return !fold.running
}

/** 总开关画在哪条之前：有过程内容画在过程区第一条前，没有就画在用户消息（本座位第一行）之后。 */
function foldRowAt(fold: { hasContent: boolean; startIndex: number }, seat: Seat): number {
  return fold.hasContent ? fold.startIndex : seat.rows[0]?.at ?? -1
}

/** 这一行在不在「收起的过程区」里（独立条目永不在）。 */
function inFoldRange(
  fold: { startIndex: number; endIndex: number; hasContent: boolean; foldable: boolean } | undefined,
  foldable: boolean,
  processOpen: boolean,
  row: Row,
): boolean {
  if (fold === undefined || !foldable || processOpen || !fold.hasContent) return false
  if (row.at < fold.startIndex || row.at > fold.endIndex) return false
  return !TURN_INDEPENDENT.has(row.entry.kind)
}

/** 一行的内容：按条目种类分派。 */
function RowBody({
  row,
  renderSlot,
}: {
  row: Row
  renderSlot?: (name: string, props?: Record<string, unknown>) => ReactNode
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
      return <ThinkRow entry={entry} live={row.live} />
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

/** 思考块：可折的一行头 + 原文体。默认态跟着 uiPrefs.reasoningDefaultOpen 走；跑动中的那一条永远展开。 */
function ThinkRow({
  entry,
  live,
}: {
  entry: Extract<TranscriptEntry, { kind: 'thinking' }>
  live: boolean
}): ReactNode {
  const prefs = useContext(FoldPrefsContext)
  const [open, setOpen] = useState(live || prefs.reasoningOpen)
  const firstLine = entry.text.split('\n', 1)[0]?.replaceAll('**', '').trim() ?? ''
  const toggle = (): void => {
    setOpen((current) => !current)
  }
  return (
    <div className={`think-block${open ? ' open' : ''}`} data-state={live ? 'running' : 'ok'}>
      <div
        className="think-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-tip={open ? '点击收起这段思考过程' : '点击展开这段思考过程'}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          toggle()
        }}
      >
        <IconSpark size={12} className="think-star" />
        <span className="think-label">思考过程</span>
        {firstLine === '' ? null : (
          <>
            <span className="think-dot" aria-hidden="true" />
            <span className="think-summary">
              <span className="think-summary-text">{firstLine}</span>
            </span>
          </>
        )}
        <span className="think-status">{live ? <i className="think-spin" aria-hidden="true" /> : null}</span>
        <IconChevronDown size={11} className="think-chevron" />
      </div>
      <div className="think-body">
        <div className="think-body-clip">
          <div className="think-text">{entry.text}</div>
        </div>
      </div>
    </div>
  )
}

/** 各工具的摘要字段；不在表里的走 {@link DEFAULT_FIELDS}。 */
const SUMMARY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  bash: ['command', 'description'],
  shell: ['command', 'description'],
  read: ['file_path', 'path'],
  read_file: ['file_path', 'path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  glob: ['pattern', 'path'],
  grep: ['pattern', 'path'],
  webfetch: ['url'],
  fetch: ['url'],
  task: ['description', 'prompt'],
}

/** 不认识的工具：只挑最像「目标」的几个字段。 */
const DEFAULT_FIELDS: readonly string[] = [
  'file_path',
  'path',
  'command',
  'pattern',
  'query',
  'url',
  'description',
]

/** 换行压成空格，超长截断。 */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
}

/** URL 只留主机名（旧界面也是这个口径：整条链接太占地方）。 */
function shortUrl(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * 工具调用的入参摘要：从 JSON 参数里挑两个关键字段拼成一行。
 *
 * 这是旧界面 `toolSummary` 的简化版：挑字段的口径照抄，但字段表只覆盖常用工具
 * （旧版按每个工具手写），认不出的工具回落到「目标」类字段。
 */
function toolSummary(name: string, argsText: string): string {
  let args: unknown
  try {
    args = JSON.parse(argsText) as unknown
  } catch {
    // 参数还没吐全（preparing）时不是合法 JSON，直接把原文当摘要（旧界面同样兜这一手）。
    return oneLine(argsText, 72)
  }
  if (typeof args !== 'object' || args === null) return ''
  const record = args as Record<string, unknown>
  const picks = SUMMARY_FIELDS[name] ?? DEFAULT_FIELDS
  const parts: string[] = []
  for (const field of picks) {
    const value = record[field]
    if (typeof value !== 'string' || value === '') continue
    parts.push(oneLine(field === 'url' ? shortUrl(value) : value, 48))
    if (parts.length === 2) break
  }
  return oneLine(parts.join(' · '), 72)
}

/** 工具状态词（旧界面同一套说法）。 */
const TOOL_STATUS_TEXT: Readonly<Record<string, string>> = {
  preparing: '准备中',
  running: '进行中',
  done: '完成',
  failed: '失败',
  rejected: '被拒',
}

/**
 * 已知工具的「动词 + 图标」。
 *
 * 照 codex 的口径（`D:\codex\codex\codex-rs\tui\src\exec_cell\render.rs` 的
 * `• Ran <command>`）：行首一枚状态点、一枚图标、一个**加粗动词**，命令行跟在后面。
 * 动词中文化（跑了 / 读了 / 搜了…），状态点与图标承担「这是什么工具」，所以知名工具
 * 不再单独印一枚等宽工具名徽标；认不出的工具（MCP 那些）保留原名，免得看不出是什么。
 */
const KNOWN_TOOLS: Readonly<
  Record<string, { verb: string; Icon: ComponentType<{ size?: number; className?: string }> }>
> = {
  bash: { verb: '跑', Icon: IconTerminal },
  shell: { verb: '跑', Icon: IconTerminal },
  read: { verb: '读', Icon: IconFolder },
  read_file: { verb: '读', Icon: IconFolder },
  write: { verb: '写', Icon: IconEdit },
  edit: { verb: '改', Icon: IconEdit },
  glob: { verb: '搜', Icon: IconSearch },
  grep: { verb: '搜', Icon: IconSearch },
  webfetch: { verb: '取', Icon: IconSearch },
  fetch: { verb: '取', Icon: IconSearch },
  task: { verb: '派', Icon: IconSpark },
}

/** 认不出的工具的图标。 */
const UNKNOWN_TOOL_ICON = IconCode

/** 一次工具匹配的结果：图标 + 基础动词 + 是不是知名工具（决定要不要印原名）。 */
interface ToolMatch {
  Icon: ComponentType<{ size?: number; className?: string }>
  known: boolean
  base: string
}

/** 按工具名配「图标 + 动词」；认不出的回落到通用图标与「调用」。 */
function matchTool(name: string): ToolMatch {
  const known = KNOWN_TOOLS[name]
  return known !== undefined
    ? { Icon: known.Icon, known: true, base: known.verb }
    : { Icon: UNKNOWN_TOOL_ICON, known: false, base: '调用' }
}

/**
 * 动词随状态变（codex 的 `Ran` / `Running` 同一套二分）。
 * 失败 / 被拒不改动词——那种情形由行尾的状态词说，不用把动词也拧一遍。
 */
function toolVerb(base: string, status: string): string {
  if (status === 'running') return `正在${base}`
  if (status === 'preparing') return `准备${base}`
  return `${base}了`
}

/** 参数原文能格式化就格式化，不能就原样——绝不因为格式坏掉而不显示参数。 */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2)
  } catch {
    return text
  }
}

/** 内置当选者：选举把 matched（图标 + 动词）算好交过来，渲染与兜底共用 ToolRow。 */
function BuiltinToolView(props: { entry: { call: ToolCallView }; matched: ToolMatch; storeKey?: string }): ReactNode {
  return <ToolRow entry={props.entry as ToolEntry} matched={props.matched} storeKey={props.storeKey} />
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

/** 去掉小数末尾多余的 0：46.0K → 46K，1.00M → 1M（旧渲染层 token-estimate 同款）。 */
function trimZero(value: number): string {
  const text = value >= 100 ? value.toFixed(0) : value.toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/**
 * token 数缩写（旧界面的 K/M 口径，与状态栏/侧栏同一份口径）：1000 以下四舍五入成
 * 整数——估算值可以是小数（中文 0.65 token/字），直接 String() 会把 `~17.970000000000002`
 * 这种浮点尾巴摊给用户。
 */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${trimZero(value / 1_000)}K`
  return `${trimZero(value / 1_000_000)}M`
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
  /** 开审查面板：把这一轮的清单与下标交给它（旧界面：并排右栏定位到该文件）。 */
  const reviewAt = (index: number): void => {
    setDockReview({ files, index, cwd })
    setDockPanel('review')
  }
  /** 进文件预览页签（看文件当前内容，审查看的是修改当时的快照）。 */
  const openAt = (path: string): void => {
    setDockPreview({ path, cwd })
    setDockPanel('preview')
  }
  const armHover = (file: ChangedFileView, anchor: DOMRect): void => {
    hoverDelay.arm(file, anchor, cardRef.current?.offsetWidth ?? 480)
  }
  return (
    <div className="entry-row">
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
    </div>
  )
}

/** 赞踩记录的 localStorage 键（桌面渲染层 chat/feedback.ts 同款：键 = `会话:条目`）。 */
const FEEDBACK_KEY = 'dsc.messageFeedback'

/** 本机评价的说明只弹一次（第一次点的时候），免得每点一次都弹一条提示（旧界面同款）。 */
let toldFeedbackOnce = false

/** 读这一轮的赞踩记录（键 = `会话uuid:最终回答条目id`，与旧界面同一份存档）；键损坏当没记。 */
function readFeedback(key: string): 'up' | 'down' | null {
  try {
    const raw = JSON.parse(localStorage.getItem(FEEDBACK_KEY) ?? '{}') as unknown
    if (typeof raw !== 'object' || raw === null) return null
    const value = (raw as Record<string, unknown>)[key]
    return value === 'up' || value === 'down' ? value : null
  } catch {
    return null
  }
}

/** 写这一轮的赞踩记录（再点一次取消 = 删键）；第一次评价时弹一次说明。 */
function writeFeedback(key: string, value: 'up' | 'down' | null): void {
  try {
    const raw = JSON.parse(localStorage.getItem(FEEDBACK_KEY) ?? '{}') as Record<string, unknown>
    if (value === null) delete raw[key]
    else raw[key] = value
    localStorage.setItem(FEEDBACK_KEY, JSON.stringify(raw))
  } catch {
    // 写不进去就算了：这是纯界面记录，不影响任何功能。
  }
  if (!toldFeedbackOnce) {
    toldFeedbackOnce = true
    toastOk('已在本机记下你的评价（宿主还没有评价上传通道）')
  }
}

/**
 * 轮尾一行（桌面端 `TurnFooter.tsx` 的同构移植）：复制 · 赞 · 踩 · 分叉 · 用量 · 时刻，
 * 一条左对齐行。
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
  /** 当前会话 uuid（评价存档键的前半截）。 */
  sessionId: string | null
  /** 这一轮最终回答的原文；没有（以工具结果收尾）就不画复制与评价。 */
  copyText?: string
  /** 最终回答条目的 id（评价存档键的后半截；老日志重放时与旧界面同键）。 */
  copyId?: number
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
  const feedbackKey = copy && props.copyId !== undefined ? `${props.sessionId ?? ''}:${String(props.copyId)}` : undefined
  const vote = feedbackKey !== undefined
  const fork = props.onFork !== undefined
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(() => (feedbackKey === undefined ? null : readFeedback(feedbackKey)))
  useEffect(() => {
    setFeedback(feedbackKey === undefined ? null : readFeedback(feedbackKey))
  }, [feedbackKey])
  // 老会话什么时间都拿不到、又没有动作与用量要画：这一行不必占位（旧界面整行不渲染）。
  if (clock === null && !copy && !vote && !fork && real === null && estimated === null) return null
  return (
    <div className="entry-row">
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
        {vote ? (
          <>
            <button
              type="button"
              className={`round-act${feedback === 'up' ? ' on' : ''}`}
              title="这条回复不错（只记在本机）"
              aria-label="这条回复不错（只记在本机）"
              aria-pressed={feedback === 'up'}
              onClick={() => {
                const next = feedback === 'up' ? null : 'up'
                setFeedback(next)
                writeFeedback(feedbackKey, next)
              }}
            >
              <IconThumbUp size={17} />
            </button>
            <button
              type="button"
              className={`round-act${feedback === 'down' ? ' on' : ''}`}
              title="这条回复不好（只记在本机）"
              aria-label="这条回复不好（只记在本机）"
              aria-pressed={feedback === 'down'}
              onClick={() => {
                const next = feedback === 'down' ? null : 'down'
                setFeedback(next)
                writeFeedback(feedbackKey, next)
              }}
            >
              <IconThumbDown size={17} />
            </button>
          </>
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

/** 一行的 React key：条目 id 在会话内单调递增，直播条目是负 id，都不会撞。 */
function keyOf(row: Row): string {
  return `${String(row.entry.id)}|${String(row.entry.ts ?? 0)}`
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
