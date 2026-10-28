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
import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconSpark, defineUiPlugin, getHostNative, toastErr, toastOk, useActions, useHostChannel, useHostSelector, useService, ACTIONS_SERVICE, type ActionsHandle, type HostSnapshot, type SlotComponentProps, type TranscriptEntry } from '@dsc/ui'
import { buildRoundFolds, processFoldPolicy, useFoldMemory, type ProcessFold } from './round-fold'
import { liveActivity, turnStartedAt } from './timing'
import { splitRounds, teammateReportLabel } from './rounds'
import { stepGroupFoldKey, turnFoldKey } from './fold-state'
import { groupSteps, type StepGrouping } from './process-groups'
import { JumpRail, previewText } from './jump-rail'
import { pageStartRound } from './paging'
import { matchTool, playCompletionSound, readCwd, readEntries, readLive, readSessions, readSessionPath, readTurnState } from '@dsc/ui-primitives'
import { registerToolCard } from './tool-card/factory'
import { EMPTY_STEP_GROUPING, FOLD_PREFS, FlowActionsContext, FoldPrefsContext, ShellCwdContext, ShellSessionContext, TOOLVIEW_SLOT, buildSeats, keyOf, type FoldPrefs, type FlowActions, type Row, type Seat, type ToolViewRender } from './shared'
import { useFollowBottom } from './follow'
import { RowBody, RowBoundary, SeatBody } from './render'
import { TurnStatusLine } from './rows/foot'
import { BuiltinToolView } from './rows/tool-row'
import { WELCOME_CARDS, WELCOME_ICON_BY_ID, WelcomeState } from './welcome'
import { SUBAGENT_FLOW_SLOT, SubagentFlow, type TranscriptFlowService } from './subagent-flow'

// 本插件对外交出去的那几样仍从 `ui.tsx` 出（槽名、服务形状、行/渲染形状）：
// 拆分只改文件位置，不动对外面。
export type { FoldPrefs, ToolEntry } from './shared'
export { TOOLVIEW_SLOT } from './shared'
export { SUBAGENT_FLOW_SLOT, type TranscriptFlowProps, type TranscriptFlowService } from './subagent-flow'
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

/** 往输入框写字的服务（composer 插件提供；缺席时首屏卡片置灰）。 */
interface ComposerDraftService {
  insert(text: string): void
}


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
  // 空会话欢迎态（与旧桌面界面同一份文案）：整块在 welcome.tsx，这里只递数据。
  if (seats.rounds.length === 0 && seats.leading.every((row) => row.entry.kind === 'system')) {
    return (
      <WelcomeState
        cards={welcomeCards}
        resume={resume}
        leading={seats.leading}
        sessionKey={sessionKey}
        cwd={cwd}
        composerReady={composerDraft !== undefined}
        onResume={(id) => {
          void (async () => {
            await channel.invoke('openSession', [id])
            await channel.invoke('refreshSessions', [])
          })()
        }}
      />
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
