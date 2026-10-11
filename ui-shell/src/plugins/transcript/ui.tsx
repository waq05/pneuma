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
import { Component, createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import {
  IconChevronDown,
  IconCode,
  IconCopy,
  IconEdit,
  IconFolder,
  IconSearch,
  IconSpark,
  IconSwap,
  IconTerminal,
  IconThumbDown,
  IconThumbUp,
} from '@dsc/ui'
import {
  defineUiPlugin,
  MarkdownView,
  toastErr,
  toastOk,
  useHostChannel,
  useHostSelector,
  type ChangedFileView,
  type DiffHunkView,
  type HostSnapshot,
  type ToolCallView,
  type TranscriptEntry,
} from '@dsc/ui'
import { buildRoundFolds, processFoldPolicy, TurnFoldRow, useTurnFoldMemory, type ProcessFold } from './round-fold'
import { formatDuration, liveActivity, roundInfos, turnStartedAt, type RoundInfo } from './timing'

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
  const channel = useHostChannel()
  const seats = useMemo(() => buildSeats(entries, live), [entries, live])
  const follow = useFollowBottom(entries.length + live.length)

  // 折叠偏好：mount 时读一次 uiPrefs，设置页改档位时经自定义事件同步进来。
  const [prefs, setPrefs] = useState<FoldPrefs>(FOLD_PREFS)
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
        })
        .catch(() => undefined)
    }
    read()
    window.addEventListener('shell.uiprefs', read)
    return () => window.removeEventListener('shell.uiprefs', read)
  }, [channel])

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

function readTurnState(snapshot: HostSnapshot | null): string {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return 'idle'
  const value = (status as Record<string, unknown>)['turnState']
  return typeof value === 'string' ? value : 'idle'
}

/** 一个座位的全部行：整轮总开关 → 过程行（可折）→ 改动卡 + 轮尾。 */
function SeatBody({
  seat,
  roundFolds,
  foldMemory,
  renderSlot,
  onFork,
}: {
  seat: Seat
  roundFolds: ReadonlyMap<number, import('./round-fold').RoundFold>
  foldMemory: ReturnType<typeof useTurnFoldMemory>
  renderSlot?: (name: string, props?: Record<string, unknown>) => ReactNode
  /** 页脚「分叉这一轮」；undefined = 分不了（没在会话里 / 第 1 轮）。 */
  onFork?: () => void
}): ReactNode {
  const fold = roundFolds.get(seat.round)
  // 跑动中的轮连总开关都不画（永远展开）；可折的定稿轮才有开合。
  const running = fold?.running === true
  const foldable = fold !== undefined && fold.foldable && fold.hasContent && !running && !fold.blocked
  const processOpen = !foldable || foldMemory.isOpen(seat.round)
  // 无过程内容的定稿轮：总开关画成不可点的抬头（照 dsh 的 disabled），位置在用户消息之后。
  const showFoldRow = fold !== undefined && !running && shouldShowFoldRow(fold)
  return (
    <>
      {seat.rows.map((row) => (
        <span key={keyOf(row)} style={{ display: 'contents' }}>
          {showFoldRow && fold !== undefined && row.at === foldRowAt(fold, seat) ? (
            <div className="entry-row" data-round={seat.round}>
              <TurnFoldRow
                open={processOpen}
                round={seatRoundInfo(seat)}
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
      <ChangesCard rows={seat.rows} />
      <RoundFoot rows={seat.rows} onFork={onFork} />
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

/** 座位的轮次信息（RoundInfo 的最小重建：TurnFoldRow 只要 index 与起止时刻）。 */
function seatRoundInfo(seat: Seat): RoundInfo {
  const rows = seat.rows
  const first = rows[0]?.entry
  const last = rows[rows.length - 1]?.entry
  const tsOf = (entry: TranscriptEntry | undefined): number | null => {
    const ts = entry?.ts
    return typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : null
  }
  const startTs = tsOf(first)
  let endTs: number | null = null
  for (const row of rows) {
    const ts = tsOf(row.entry)
    if (ts !== null) endTs = ts
  }
  if (endTs !== null && startTs !== null && endTs < startTs) endTs = null
  return {
    index: seat.round,
    startIndex: rows[0]?.at ?? 0,
    endIndex: rows[rows.length - 1]?.at ?? 0,
    startTs,
    endTs,
    answered: rows.some((row) => row.entry.kind !== 'user'),
  }
}

/** 一行的内容：按条目种类分派。 */
function RowBody({
  row,
  renderSlot,
}: {
  row: Row
  renderSlot?: (name: string, props?: Record<string, unknown>) => ReactNode
}): ReactNode {
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
    case 'tool':
      // 这条工具调用谁画由 toolview 链选举：链上有人认领就归它（matched 一并交给它），
      // 全体弃权（或链上没人）落回内置工具卡——内置渲染器自己也在链上，这只是兜底位。
      return renderSlot?.(TOOLVIEW_SLOT, { entry }) ?? <ToolRow entry={entry} />
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
function BuiltinToolView(props: { entry: { call: ToolCallView }; matched: ToolMatch }): ReactNode {
  return <ToolRow entry={props.entry as ToolEntry} matched={props.matched} />
}

/** 工具卡：一行头（状态点 + 图标 + 动词 + 摘要 + 状态）+ 展开后的参数与结果。默认态跟 uiPrefs.toolDefaultOpen。 */
function ToolRow({ entry, matched }: { entry: ToolEntry; matched?: ToolMatch }): ReactNode {
  const call = entry.call
  const prefs = useContext(FoldPrefsContext)
  const [open, setOpen] = useState(prefs.toolOpen)
  // 参数还没到齐的这一次调用不可展开——展开也看不到东西，还会让「点一下」白点。
  const expandable = call.status !== 'preparing'
  const bodyOpen = open && expandable
  const summary = toolSummary(call.name, call.argsText)
  const match = matched ?? matchTool(call.name)
  const Icon = match.Icon
  const toggle = (): void => {
    if (expandable) setOpen((current) => !current)
  }
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
        <span className="preview">{summary}</span>
        <span className="status">
          {call.status === 'running' ? <i className="tc-spin" aria-hidden="true" /> : null}
          {/* 定稿不说「完成」：状态点已经绿了，再印一遍是噪声（codex 也只留圆点）。 */}
          {call.status === 'done' ? '' : (TOOL_STATUS_TEXT[call.status] ?? call.status)}
          {call.durationMs === undefined ? '' : `${call.status === 'done' ? '' : ' · '}${(call.durationMs / 1000).toFixed(1)} 秒`}
        </span>
        {expandable ? <IconChevronDown size={11} className="tc-chevron" /> : null}
      </div>
      {bodyOpen ? (
        <div className="tool-body">
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

/** token 数缩写（旧界面的 k/M 口径）。 */
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
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

/** 差异段：一行四格（旧行号 / 新行号 / 记号 / 内容），颜色交给 `.diff-add` / `.diff-del`。 */
function DiffRows({ hunks }: { hunks: readonly DiffHunkView[] }): ReactNode {
  return (
    <div className="diff-body" data-wrap="">
      {hunks.map((hunk, hunkIndex) => (
        <div className="diff-hunk" key={hunkIndex}>
          <div className="diff-hunk-head">{`@@ -${String(hunk.oldStart)},${String(hunk.oldCount)} +${String(hunk.newStart)},${String(hunk.newCount)} @@`}</div>
          {hunk.lines.map((line, lineIndex) => (
            <div
              className={`diff-line ${line.kind === 'add' ? 'diff-add' : line.kind === 'remove' ? 'diff-del' : 'diff-ctx'}`}
              key={lineIndex}
            >
              <span className="diff-no">{line.oldLine ?? ''}</span>
              <span className="diff-no">{line.newLine ?? ''}</span>
              <span className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ''}</span>
              <span className="diff-text">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
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

function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/**
 * 轮尾的「文件已更改」卡：把本轮所有改动聚成一张。
 *
 * 旧界面的「审查 / 打开」两颗按钮要接审查面板与文件预览（壳里都还没有），所以这里
 * 换成点一行就地展开差异——同样的信息，不用再把用户带到别处。
 */
function ChangesCard({ rows }: { rows: readonly Row[] }): ReactNode {
  const [openPath, setOpenPath] = useState<string | null>(null)
  const files = useMemo(() => mergeChanges(rows), [rows])
  if (files.length === 0) return null
  const totalAdded = files.reduce((sum, file) => sum + file.added, 0)
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0)
  const single = files.length === 1 ? files[0] : undefined
  return (
    <div className="entry-row">
      <div className="changes-card" data-changed-files="" {...(single === undefined ? {} : { 'data-single': '1' })}>
        <div className="changes-head">
          <span className="changes-tile">
            <IconCode size={20} />
          </span>
          <span className="changes-titles">
            <span className="changes-title">
              {single === undefined ? `${String(files.length)} 个文件已更改` : baseName(single.path)}
            </span>
            <span className="changes-stat">
              <span className="changes-counts">
                <span className="changes-added">+{totalAdded}</span>
                <span className="changes-removed">-{totalRemoved}</span>
              </span>
              <span className="changes-hint">点一行看差异</span>
            </span>
          </span>
        </div>
        <ul className="changes-list">
          {files.map((file) => (
            <li className="changes-row-wrap" key={file.path}>
              <button
                type="button"
                className="changes-row"
                aria-expanded={openPath === file.path}
                onClick={() => {
                  setOpenPath((current) => (current === file.path ? null : file.path))
                }}
              >
                <span className="changes-path" title={file.path}>
                  {file.status === 'added' ? <span className="changes-badge">新增</span> : null}
                  {baseName(file.path)}
                </span>
                <span className="changes-counts">
                  <span className="changes-added">+{file.added}</span>
                  <span className="changes-removed">-{file.removed}</span>
                </span>
              </button>
              {openPath === file.path ? (
                <div className="shell-diff">
                  <DiffRows hunks={file.hunks} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** 带整轮用量读数的条目（口径与条目契约一致：只有 text / tool 两类会带）。 */
type UsageRow = Row & { entry: Extract<TranscriptEntry, { kind: 'text' | 'tool' }> }

/** 赞踩记录的 localStorage 键（桌面渲染层 chat/feedback.ts 同款：按条目 id 记）。 */
const FEEDBACK_KEY = 'dsc.messageFeedback'

/** 读这一轮的赞踩记录（按轮首条目的 id 键控）；键损坏当没记。 */
function readFeedback(key: number): 'up' | 'down' | null {
  try {
    const raw = JSON.parse(localStorage.getItem(FEEDBACK_KEY) ?? '{}') as unknown
    if (typeof raw !== 'object' || raw === null) return null
    const value = (raw as Record<string, unknown>)[String(key)]
    return value === 'up' || value === 'down' ? value : null
  } catch {
    return null
  }
}

/** 写这一轮的赞踩记录（再点一次取消 = 删键）。 */
function writeFeedback(key: number, value: 'up' | 'down' | null): void {
  try {
    const raw = JSON.parse(localStorage.getItem(FEEDBACK_KEY) ?? '{}') as Record<string, unknown>
    if (value === null) delete raw[String(key)]
    else raw[String(key)] = value
    localStorage.setItem(FEEDBACK_KEY, JSON.stringify(raw))
  } catch {
    // 写不进去就算了：这是纯界面记录，不影响任何功能。
  }
}

function hasUsage(row: Row): row is UsageRow {
  const entry = row.entry
  return (entry.kind === 'text' || entry.kind === 'tool') && entry.usage !== undefined
}

/**
 * 轮尾一行：复制、赞踩、分叉、用时、工具次数、用量、时刻（桌面端 TurnFooter 的同构移植）。
 * 全空就不画（旧界面同样整行不渲染）。
 *
 * 赞踩存 localStorage（`dsc.messageFeedback`，与桌面渲染层同一键）——它是纯界面记录
 * （宿主协议里没有反馈上报），换浏览器不跟人走。分叉复用侧栏那套：列用户消息选一句分叉。
 */
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

function RoundFoot({ rows, onFork }: { rows: readonly Row[]; onFork?: () => void }): ReactNode {
  const [copied, setCopied] = useState(false)
  const footKey = rows[0]?.entry.id ?? 0
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(() => readFeedback(footKey))
  useEffect(() => {
    setFeedback(readFeedback(footKey))
  }, [footKey])
  const first = rows[0]?.entry.ts
  const last = rows[rows.length - 1]?.entry.ts
  const usage = rows.findLast(hasUsage)
  const toolCount = rows.filter((row) => row.entry.kind === 'tool').length
  const text = rows
    .filter((row): row is Row & { entry: Extract<TranscriptEntry, { kind: 'text' }> } => row.entry.kind === 'text')
    .map((row) => row.entry.text)
    .join('\n\n')
  const seconds = first === undefined || last === undefined || last <= first ? undefined : (last - first) / 1000
  const tokens = usage?.entry.usage

  if (tokens === undefined && first === undefined && text === '') return null

  return (
    <div className="entry-row">
      <div className="round-foot">
        {text === '' ? null : (
          <button
            type="button"
            className="round-act"
            title="复制这条回复的原文"
            aria-label="复制这条回复的原文"
            onClick={() => {
              // 剪贴板被浏览器拒绝（非安全上下文）时不给假反馈，所以 .catch 里什么都不做。
              void navigator.clipboard
                .writeText(text)
                .then(() => {
                  setCopied(true)
                  window.setTimeout(() => {
                    setCopied(false)
                  }, 1200)
                })
                .catch(() => undefined)
            }}
          >
            <IconCopy size={17} />
          </button>
        )}
        {copied ? <span className="round-tokens">已复制</span> : null}
        {text === '' ? null : (
          <>
            <button
              type="button"
              className={`round-act${feedback === 'up' ? ' on' : ''}`}
              title={feedback === 'up' ? '已标记「有帮助」（再点一次取消）' : '这条回复有帮助'}
              aria-label="这条回复有帮助"
              onClick={() => {
                const next = feedback === 'up' ? null : 'up'
                setFeedback(next)
                writeFeedback(footKey, next)
              }}
            >
              <IconThumbUp size={16} />
            </button>
            <button
              type="button"
              className={`round-act${feedback === 'down' ? ' on' : ''}`}
              title={feedback === 'down' ? '已标记「没帮助」（再点一次取消）' : '这条回复没帮助'}
              aria-label="这条回复没帮助"
              onClick={() => {
                const next = feedback === 'down' ? null : 'down'
                setFeedback(next)
                writeFeedback(footKey, next)
              }}
            >
              <IconThumbDown size={16} />
            </button>
          </>
        )}
        {onFork === undefined || text === '' ? null : (
          <button type="button" className="round-act" title="从这一轮分叉出新会话" aria-label="分叉这一轮" onClick={onFork}>
            <IconSwap size={16} />
          </button>
        )}
        {seconds === undefined ? null : (
          <span className="round-tokens" title="这一轮从发出到最后一笔写入">
            用时 {seconds.toFixed(1)} 秒
          </span>
        )}
        {toolCount === 0 ? null : (
          <>
            <span className="round-sep" aria-hidden="true">·</span>
            <span className="round-tokens" title="这一轮调用的工具次数">{toolCount} 次工具</span>
          </>
        )}
        {tokens === undefined ? null : (
          <>
            {seconds === undefined && toolCount === 0 ? null : (
              <span className="round-sep" aria-hidden="true">·</span>
            )}
            <span className="round-tokens" title="宿主上报的真实用量">
              用量 {formatTokens(tokens.inputTokens + tokens.outputTokens)} tok
            </span>
          </>
        )}
        {first === undefined ? null : (
          <>
            <span className="round-sep" aria-hidden="true">
              ·
            </span>
            <span className="round-clock" title="这条消息发出的时刻（本机时区）">
              {new Date(first).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </>
        )}
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
