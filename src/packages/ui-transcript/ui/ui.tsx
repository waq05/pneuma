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
 * 样式与 class 名照抄旧版（`src/packages/ui-renderer/ui/styles/legacy/views.css`，行号同旧 `styles.css`）：
 * `.chat-inner` 1297、`.turn-seat` 8466、`.entry-row` 6852、`.entry-user` 1307、
 * `.entry-text` 1319、`.think-block` 7208、`.entry.tool-card` 1832、`.entry-system` 1442、
 * `.plan-card` 6632、`.changes-card` 9469、`.round-foot` 7001、`.diff-*` 9762 起、
 * `.turn-fold` / `.turn-status` / `.chat-to-bottom` / `.load-earlier` 同在 legacy 里。
 *
 * @module dsc-ui-shell/plugins/transcript
 */
import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconSpark, createT, defineUiPlugin, getHostNative, toastErr, toastOk, useActions, useHostChannel, useHostSelector, useService, ACTIONS_SERVICE, type ActionsHandle, type ApprovalRequestView, type AskUserView, type HostSnapshot, type PlanView, type SlotComponentProps, type TranscriptEntry } from '@dsc/ui'
import { buildRoundFolds, processFoldPolicy, turnDefaultOpen, useFoldMemory, type ProcessFold } from './round-fold'
import { liveActivity, turnStartedAt } from './timing'
import { internalLabel, splitRounds } from './rounds'
import { turnFoldKey } from './fold-state'
import { groupSteps, type StepGrouping } from './process-groups'
import { JumpRail, previewText } from './jump-rail'
import { pageStartRound } from './paging'
import { matchTool, playCompletionSound, readCompactingSince, readCwd, readEntries, readLive, readSessions, readSessionPath, readTurnState } from '@dsc/ui-primitives'
import { registerToolCard } from './tool-card/factory'
import { EMPTY_STEP_GROUPING, FOLD_PREFS, FlowActionsContext, FoldPrefsContext, ShellCwdContext, ShellSessionContext, TOOLVIEW_SLOT, TRANSCRIPT_NODE_SLOT, TRANSCRIPT_REASONING_BODY_SLOT, buildSeats, keyOf, type FoldPrefs, type FlowActions, type Row, type Seat, type ToolViewRender, type TranscriptChildSlot } from './shared'
import { turnEndNotice, waitingNotice, type WaitingCard } from './turn-notify'
import { useFollowBottom } from './follow'
import { RowBody, RowBoundary, SeatBody } from './render'
import { TurnStatusLine } from './rows/foot'
import { BuiltinToolView } from './rows/tool-row'
import { WELCOME_CARDS, WELCOME_ICON_BY_ID, WelcomeState } from './welcome'
import { greetingSlot, nextGreetingBoundaryDelayMs } from './greeting'
import { SUBAGENT_FLOW_SLOT, SubagentFlow, type TranscriptFlowService } from './subagent-flow'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
// 构建时 JSON 直接内联进 `client.js`，运行期不需要宿主下发文件。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 通知标题的译文表（文案键 → 已经翻好的标题）。
 *
 * 为什么不是直接把 `notice.titleKey` 丢给 `t`：`scripts/ui-locale-test.mjs` 只认
 * `t('字面量键')` 的调用点，动态键它看不见，六个键会被判成「没人用的键」并让闸门判红。
 * 表里漏了一个键时退回动态取词——取词器对未知键返回键名并告警一次，不会静默吞掉。
 */
const NOTICE_TITLES: Readonly<Record<string, string>> = {
  'transcript.notify.done': t('transcript.notify.done'),
  'transcript.notify.failed': t('transcript.notify.failed'),
  'transcript.notify.truncated': t('transcript.notify.truncated'),
  'transcript.notify.question': t('transcript.notify.question'),
  'transcript.notify.approval': t('transcript.notify.approval'),
  'transcript.notify.plan': t('transcript.notify.plan'),
}

// 本插件对外交出去的那几样仍从 `ui.tsx` 出（槽名、服务形状、行/渲染形状）：
// 拆分只改文件位置，不动对外面。
export type { FoldPrefs, ToolEntry } from './shared'
export { TOOLVIEW_SLOT } from './shared'
export { SUBAGENT_FLOW_SLOT, type TranscriptFlowProps, type TranscriptFlowService } from './subagent-flow'
const BUILTIN_TOOLVIEW_PRIORITY = 100

/**
 * 首屏两个读数共用的窗口（七天）：比这更久的东西不抢首屏的位置，但值得在招呼语里
 * 说一句「有阵子没见了」。「接着上次」和「久未使用」读同一个数，改窗口时不会只改一半。
 */
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export default defineUiPlugin({
  name: t('transcript.plugin.name'),
  apply(ui) {
    // 工具卡的装配定义（D2）：定义在这里注册，对话页与轨迹页各自渲染——两个父位置
    // 选不同的局部组件（对话页选 intended 预览等四件；轨迹页只选轨迹口径的耗时）。
    registerToolCard(ui)
    // 本条目声明三个 chain 子槽，行渲染时按需问它们：
    //   - `transcript.node`（节点级）：一条条目归谁画，dsh 的 conversation.chat.node 等价物；
    //   - `transcript.toolview`：单条工具调用归谁画（内置工具卡也在链上，只是兜底位）；
    //   - `transcript.reasoning.body`：思考行的**正文区**单独开一条，因为想换的只是正文排版
    //     （纯文本 → markdown），而行头、摘要、吸附栏、折叠交互仍归内置 ThinkRow——
    //     接一条 body 槽不必把整套折叠逻辑重写一遍。
    ui.slots.register(
      'shell.main',
      {
        id: 'transcript.flow',
        order: 1,
        children: {
          [TOOLVIEW_SLOT]: 'chain',
          [TRANSCRIPT_NODE_SLOT]: 'chain',
          [TRANSCRIPT_REASONING_BODY_SLOT]: 'chain',
        },
      },
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
    // 子代理卡 / 计划卡 / system 行），只读——编辑重发不给。声明成一条独立槽位（带同一套
    // 三个 chain 子槽），组件本身经 `transcriptFlow` 服务交出去：团队右栏页签直接渲染它；
    // 服务缺席时团队那边退回简版 PeekView（兜底仍留着，见 team/ui.tsx）。
    ui.slots.declare(SUBAGENT_FLOW_SLOT, 'list')
    ui.slots.register(
      SUBAGENT_FLOW_SLOT,
      {
        id: 'transcript.subagent.flow',
        order: 1,
        children: {
          [TOOLVIEW_SLOT]: 'chain',
          [TRANSCRIPT_NODE_SLOT]: 'chain',
          [TRANSCRIPT_REASONING_BODY_SLOT]: 'chain',
        },
      },
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
}: SlotComponentProps<Record<never, never>, TranscriptChildSlot>): ReactNode {
  const entries = useHostSelector(readEntries)
  const live = useHostSelector(readLive)
  const turnState = useHostSelector(readTurnState)
  // 压缩进行中（0.7.2）：压缩不是回合，turnState 一直是 idle，得单独读一个字段。
  const compactingSince = useHostSelector(readCompactingSince)
  const sessionPath = useHostSelector(readSessionPath)
  const sessionId = useHostSelector(readSessionId)
  const cwd = useHostSelector(readCwd) ?? ''
  // 挂着的「等人的卡」（审批 → 计划 → 提问）：通知用，界面本身由 ui-prompt 画。
  const waitingCard = useHostSelector(readWaitingCard, sameWaitingCard)
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
            // 两项新偏好（契约里已冻结的取值）：认不出的值各自回落出厂口径
            // （跑完立刻收起 / 收起后正文照留）。
            collapseTiming: value['collapseTiming'] === 'next-input' ? 'next-input' : 'completion',
            foldedReplies: value['foldedReplies'] === 'final' ? 'final' : 'all',
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

  // 回合结束提醒（桌面端 App 的同款判定）：**同一会话**从跑动变空闲的那一拍，
  // 按结局挑一条文案（完成 / 失败 / 输出超长），按偏好播一声提示音；页面不在前台时
  // 再弹一条系统通知（只有桌面原生桥有）。用户主动中断（aborted）既不响也不弹——
  // `turnEndNotice` 对那一轮直接给 null，这里照 null 收手就是。
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
    // 只看刚跑完的这一轮：上一轮的轮尾标记不该替这一轮说话（同一会话里连续跑很多轮）。
    const rows = seats.rounds[seats.rounds.length - 1]?.rows ?? []
    const notice = turnEndNotice(rows)
    if (notice === null) return
    const behaviorNow = behaviorRef.current
    if (behaviorNow.sound) playCompletionSound(behaviorNow.variant)
    const background = document.hidden || !document.hasFocus()
    const native = getHostNative()
    if (background && behaviorNow.notify && native.available) {
      const title = NOTICE_TITLES[notice.titleKey] ?? t(notice.titleKey)
      void native
        .invoke('notify', [{ title, body: notice.body }])
        .catch(() => undefined)
    }
  }, [turnState, sessionPath, seats])

  // 等人的卡：审批 / 计划评审 / 模型提问挂上来的那一拍，窗口不在前台才提示。
  // 前台时这张卡本来就画在输入框上方，再响一声是重复噪音。
  //
  // 记忆按「会话 + 卡键」记：同一张卡只提示一次，切会话时先清空——否则切回上次
  // 那个还挂着审批的会话会被当成「刚冒出来」再响一遍。
  const waitingSessionRef = useRef(sessionKey)
  const waitingKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const switched = waitingSessionRef.current !== sessionKey
    if (switched) {
      waitingSessionRef.current = sessionKey
      // 从「宿主还没接上」（空串）变成真会话不算切换，照常判一次，别把首帧就挂着的卡吞掉。
      if (sessionKey !== '') {
        waitingKeyRef.current = waitingCard?.key ?? null
        return
      }
    }
    const key = waitingCard?.key ?? null
    const previous = waitingKeyRef.current
    waitingKeyRef.current = key
    // 卡撤了、或者还是同一张（内容变了也不重复喊）。
    if (key === null || key === previous) return
    // 窗口在前台：界面上本来就看得到，不响也不弹。
    if (!document.hidden && document.hasFocus()) return
    const behaviorNow = behaviorRef.current
    const native = getHostNative()
    if (!behaviorNow.notify || !native.available) return
    const notice = waitingNotice(waitingCard)
    if (notice === null) return
    if (behaviorNow.sound) playCompletionSound(behaviorNow.variant)
    const title = NOTICE_TITLES[notice.titleKey] ?? t(notice.titleKey)
    void native
      .invoke('notify', [{ title, body: notice.body }])
      .catch(() => undefined)
  }, [waitingCard, sessionKey])

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
    () => buildRoundFolds([...entries, ...live], rounds, {
      foldTurns: prefs.policy.foldTurns,
      live: turnState !== 'idle',
      lastRoundIndex: liveRoundIndex,
      foldedReplies: prefs.foldedReplies,
    }),
    [entries, live, rounds, prefs.policy.foldTurns, prefs.foldedReplies, turnState, liveRoundIndex],
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
  // 整轮收起 → 复位它内部所有行与阶段组（对齐 dsh 的 disclosureReset）。
  //
  // 2026-11-10 改（原来写的是「轮一收尾就把整轮与所有阶段组写回收起」）：那条规则会在
  // **用户正看着**的时候动手——一轮刚跑完、还没被收起，里面点开的思考/组就被写回了收起，
  // 等于替用户做了一次手动收起，而且紧接着下一轮进来又恢复不成。参考实现的时机只有一处：
  // 「这一条是过程成员、它被整轮折叠隐藏、且正处于隐藏/收起动画中」才推进复位版本
  // （`ChatNodeSeat.tsx:122-131`）。这里照同一条口径：**从展开变成收起的那一拍**清存档。
  //
  // 为什么清存档而不是写 false：清掉之后每条行回落到自己的默认档（思考/工具/组都是收起，
  // 设置里开的默认值也照常生效），写 false 会把「用户手动收起」这个判断钉死。
  const collapsedRounds = useMemo(() => {
    const set = new Set<number>()
    for (const fold of roundFolds.values()) {
      // 与 render.tsx 的 collapsed 同一口径：可折 + 有内容 + 已收尾 + 没被展开。
      if (!fold.foldable || !fold.hasContent || fold.running || fold.blocked) continue
      const defaultOpen = turnDefaultOpen(prefs.collapseTiming, fold.latest)
      if (!foldMemory.open(turnFoldKey(sessionId, fold.roundIndex), defaultOpen)) set.add(fold.roundIndex)
    }
    return set
  }, [roundFolds, prefs.collapseTiming, sessionId, foldMemory])
  const prevCollapsedRounds = useRef<Set<number>>(new Set())
  useEffect(() => {
    const entering: string[] = []
    const sid = sessionId ?? ''
    for (const roundIndex of collapsedRounds) {
      if (prevCollapsedRounds.current.has(roundIndex)) continue
      // 行的键是 `会话id:r<轮>:<类型>:<序号>`（工具可能是 `…:call:<id>`），组是
      // `会话id:step:r<轮>:…`——两条前缀把这一轮扫干净（见 fold-state.ts 的 clearFoldPrefix）。
      entering.push(`${sid}:r${String(roundIndex)}:`, `${sid}:step:r${String(roundIndex)}:`)
    }
    prevCollapsedRounds.current = collapsedRounds
    if (entering.length === 0) return
    foldMemory.clearPrefixes(entering)
    // clearPrefixes 是稳定引用（useFoldMemory 里 useCallback 包过），不进依赖清单。
  }, [collapsedRounds, sessionId, foldMemory])

  /**
   * 最新一轮的下一句输入进来时，收掉上一轮「摊着」的默认态（next-input 档的既有语义）：
   * 那一轮不再是最后一轮，兜底自己会翻成收起，这里只负责把整轮那一格的手动存档抹掉，
   * 免得它钉在展开上。
   */
  const prevTopRound = useRef<number | null>(null)
  useEffect(() => {
    const top = liveRoundIndex
    const previous = prevTopRound.current
    prevTopRound.current = top
    if (previous === null || previous === top) return
    if (prefs.collapseTiming !== 'next-input') return
    foldMemory.clear([turnFoldKey(sessionId, previous)])
  }, [liveRoundIndex, prefs.collapseTiming, sessionId, foldMemory])

  // 页脚「分叉这一轮」：保留到本轮用户消息（含），从这一轮的回答重来——旧界面同一语义。
  // 第 1 轮不给分（分完还是这一轮，没有意义）。
  const forkRound = (seat: Seat): void => {
    if (sessionPath === null) return
    const roundNo = seat.round + 1
    void (async () => {
      try {
        const result = await channel.invoke<{ ok: boolean; path?: string; error?: string }>('forkSession', [sessionPath, roundNo])
        if (result.ok !== true) {
          toastErr(result.error ?? t('transcript.fork.failed'))
          return
        }
        await channel.invoke('openSession', result.path === undefined ? [] : [result.path])
        await channel.invoke('refreshSessions', [])
        toastOk(t('transcript.fork.ok'))
      } catch (reason) {
        toastErr(t('transcript.fork.failedDetail', { message: reason instanceof Error ? reason.message : String(reason) }))
      }
    })()
  }

  /**
   * 编辑一条用户消息并重发：**在当前会话里**截断到这条之前再重发（2026-11-03 改）。
   *
   * 以前是「分叉新会话再重发」：编辑第 N 条就等于复制出 N-1 条到新会话，原会话留着。
   * 实际用起来这不是「改一下这句话」，而是「多出一条会话」——用户想改的是手头这条，
   * 结果被换到另一条新会话里，还得自己回去收拾原来那条。现在改成原地重来：
   * 宿主作废这条及其之后的回答（日志追加一条 `rewind` 记录，原文仍在磁盘上可回查），
   * 然后把改过的文字重新提交——会话还是这条，哈希、标题、工作区都不动。
   *
   * 保留几轮的口径：这条消息**之前**有多少条开轮的用户消息。每一条开轮的用户消息
   * 恰好对应一轮（rounds.ts 规则 1），所以「startIndex 落在本条目之前的轮」数量就是它。
   */
  const editAndResend = (entry: Extract<TranscriptEntry, { kind: 'user' }>, text: string): void => {
    const all = [...entries, ...live]
    const at = all.findIndex((item) => item.id === entry.id)
    if (at < 0) {
      toastErr(t('transcript.edit.gone'))
      return
    }
    // 保留几条 = 这条之前**人打的**用户消息条数：宿主 `rewindSession` 的第二个参数就是这个口径
    // （与 `src/core/session.ts` 的 isHumanUserMessage 一一对应，界面上就是 `internal !== true`：
    // 机器投递的通知、队友汇报、审查结论都带这个标记）。
    // 顺带一个用得上的等价关系：`rounds.ts` 规则 3 不让 internal 条目开新轮，所以这个计数也
    // 正好是这条消息所在轮的序号——下面清折叠存档时直接拿 `keep` 当轮号，不必再数一遍。
    const keep = all.slice(0, at).filter((item) => item.kind === 'user' && item.internal !== true).length
    if (sessionPath === null) {
      toastErr(t('transcript.edit.notSaved'))
      return
    }
    void (async () => {
      try {
        // 第三个参数是改过的正文：作废的是第一条消息时，宿主拿它当新的侧栏标题
        const result = await channel.invoke<{ ok: boolean; error?: string }>('rewindSession', [sessionPath, keep, text])
        if (result?.ok !== true) {
          toastErr(result?.error ?? t('transcript.edit.failed'))
          return
        }
        // 同一轮重答：轮序号不变（rewind 之后新回答还是第 keep 轮），折叠存档的键因此完全一样，
        // 上一次的展开选择会被新内容继承——包括这一轮里每一行、每个阶段组的键（它们也带轮号）。
        // 参考实现靠「回答代次」让旧选择自然失效；本仓没有代次，就在重答这一拍把这一轮的存档清掉。
        // 清的是 keep 这一轮：`keep` 是「这条消息之前有几条人打的用户消息」，也就是它的轮序号。
        const sid = sessionId ?? ''
        // 整轮那一格用精确键：`turn:1` 当前缀会把 `turn:10` 一起清掉。
        foldMemory.clear([turnFoldKey(sid || null, keep)])
        // 行与阶段组的键按轮内身份拼（`…:r3:…` / `…:step:r3:…`），只能按前缀扫。
        foldMemory.clearPrefixes([`${sid}:r${String(keep)}:`, `${sid}:step:r${String(keep)}:`])
        await channel.invoke('submit', [text])
        // 标题、排序都跟最后一条消息走：改完重扫一次，侧栏立刻对上（现在这一步是缓存命中）。
        await channel.invoke('refreshSessions', [])
      } catch (reason) {
        toastErr(t('transcript.edit.resendFailed', { message: reason instanceof Error ? reason.message : String(reason) }))
      }
    })()
  }
  const actions: FlowActions = { editAndResend, busy: turnState !== 'idle' }

  // 进行中直播行（回合没结束才有）：一句状态 + 用时。
  const activity = useMemo(() => liveActivity([...entries, ...live], turnState), [entries, live, turnState])
  // 这一轮从哪一刻开始：直播行上的「用时」认它（老会话没有 ts 就是 null，那就不报时间）。
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
          // internal 消息（队友汇报、后台作业通知……）根本不另起一轮（rounds.ts 规则 3）；
          // 万一它落在某轮里，也不给原文、改给一句人话——绝不把 `<teammate-report …>` 或
          // 作业通知原文当题面塞进悬停卡。
          prompt:
            user?.kind !== 'user'
              ? ''
              : user.internal === true
                ? internalLabel(user.text)
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
        group: t('transcript.action.group'),
        keywords: [t('transcript.action.group'), 'prompt'],
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
            now - session.updatedAt < RECENT_WINDOW_MS,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
    )
  }, [sessions, sessionPath])

  // 首屏那句招呼语只看现在几点（2026-11-10：不再按周末 / 久未用 / 头一回分岔）。
  // 到下一个换档整点（05/09/12/14/18/23）重绘一次：挂一晚上的窗口也会自己从「下午好」
  // 换成「晚上好」，不用等用户操作。刷新时刻单独存一份，定时器才有东西依赖。
  const [greetingAt, setGreetingAt] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setTimeout(() => setGreetingAt(new Date()), nextGreetingBoundaryDelayMs(greetingAt))
    return () => window.clearTimeout(timer)
  }, [greetingAt])
  const greeting = greetingSlot({ at: greetingAt })

  // 首屏卡片的两种来源：动作表（常驻，含命令面板里的那几条），或动作表缺席时的内置清单。
  const registeredActions = useActions()
  const promptActions = useMemo(
    () => registeredActions.filter((action) => action.group === t('transcript.action.group')),
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
    toastErr(bootError.text.split('\n')[0] ?? t('transcript.boot.failed'))
  }, [bootError?.id, sessionKey])

  // 空会话欢迎态（与旧桌面界面同一份文案）。
  // 空会话欢迎态（与旧桌面界面同一份文案）：整块在 welcome.tsx，这里只递数据。
  if (seats.rounds.length === 0 && seats.leading.every((row) => row.entry.kind === 'system')) {
    return (
      <WelcomeState
        cards={welcomeCards}
        greeting={greeting}
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
          data-tip={t('transcript.earlier.tip')}
          onClick={() => {
            release(firstVisible - earlierRounds)
          }}
        >
          {t('transcript.earlier.label', { shown: earlierRounds, total: firstVisible })}
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
      {/* 压缩进行中：与回合直播行同一个位置、同一套动画（0.7.2）。
          压完这条行消失，宿主紧接着写一条「上下文已压缩」的通知，底部的占用百分比也一起刷新。 */}
      {compactingSince !== null ? (
        <TurnStatusLine text={t('transcript.status.compacting')} startedAt={null} />
      ) : null}
      {/* 回合进行中：流末尾一条直播行（转圈 + 状态 + 用时 + 三点动画），形态对齐 dsh 的
          `RunningStatus`。三种情况不画这条：
          1. 正在压缩——压缩发生在回合起点（beforeRequest），那一刻 turnState 已经是 thinking，
             两条都画就是两个转圈，压缩优先；
          2. 回合已结束（activity 为 null）；
          3. 没有这一轮（首轮还没开跑）。
          2026-11-08 拆掉的旧禁令：以前「过程区画着未收口的组头就不画这条」，理由是组头
          已经在说「正在运行命令」。但 dsh 是**两行并存**的（组头报阶段、这行报状态与用时），
          用户要的正是截图里那种「准备运行代码 + 深度求索中，用时 X」的形状。重复问题改用
          文案解决：行面只说通用状态，具体工具名收进悬停提示（见 rows/foot.tsx 的注释）。 */}
      {activity !== null && compactingSince === null ? (
        <TurnStatusLine
          text={turnState === 'awaiting-approval' ? activity.text : t('transcript.status.working')}
          startedAt={startedAt}
          hint={activity.text}
        />
      ) : null}
      <div ref={follow.setEnd} />
      {/* 暂停跟随时的回头路：只在这一刻出现（跟随中不画），点一下恢复跟随并送回底部。 */}
      {follow.paused ? (
        <button
          type="button"
          className="chat-to-bottom"
          title={t('transcript.toBottom.tip')}
          onClick={follow.resume}
        >
          {t('transcript.toBottom.label')}
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

/** 当前会话 uuid（评价存档键用；旧界面也是拿它拼键）。 */
function readSessionId(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const value = (status as Record<string, unknown>)['sessionId']
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 快照里挂着的「等人的卡」：审批 → 计划评审 → 模型提问，与 `src/packages/remote/index.ts:692-703`
 * 的推送优先级同一个口径（同一时刻至多一张在前面挡着）。
 *
 * 为什么选择器返回一张「小卡」而不是原视图：通知只需要三样东西——卡种（挑文案）、
 * 卡键（去重）、一行标题；原视图每帧都是新对象，拖着整份 diff / 计划全文去比等，
 * 白白多算一遍。
 */
function readWaitingCard(snapshot: HostSnapshot | null): WaitingCard | null {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return null
  const table = surfaces as Record<string, unknown>
  // 快照在界面侧是 unknown 树：字段缺失（老宿主 / 半截帧）时宁可给空标题，也不要在
  // 通知的选择器里抛异常——那会打断整棵树的渲染。
  const approval = table['pendingApproval']
  if (typeof approval === 'object' && approval !== null) {
    const view = approval as Partial<ApprovalRequestView>
    const summary = typeof view.argsSummary === 'string' ? view.argsSummary.trim() : ''
    // 参数摘要为空（有些工具没有可读参数）时退回工具名，通知里总得有一行字。
    const tool = typeof view.toolName === 'string' ? view.toolName.trim() : ''
    return { kind: 'approval', key: `approval:${String(view.id ?? '')}`, headline: summary !== '' ? summary : tool }
  }
  const plan = table['pendingPlan']
  if (typeof plan === 'object' && plan !== null) {
    const view = plan as Partial<PlanView>
    return {
      kind: 'plan',
      key: `plan:${String(view.file ?? '')}`,
      headline: typeof view.title === 'string' ? view.title : '',
    }
  }
  const question = table['pendingQuestion']
  if (typeof question === 'object' && question !== null) {
    const view = question as Partial<AskUserView>
    const header = typeof view.header === 'string' && view.header.trim() !== '' ? view.header : view.question
    return {
      kind: 'question',
      key: `question:${String(view.id ?? '')}`,
      headline: typeof header === 'string' ? header : '',
    }
  }
  return null
}

/** 等待卡的逐字段比较：宿主每帧给的都是新对象，按引用比等于每帧都判定「来了一张新卡」。 */
function sameWaitingCard(previous: WaitingCard | null, next: WaitingCard | null): boolean {
  if (previous === null || next === null) return previous === next
  return previous.kind === next.kind && previous.key === next.key && previous.headline === next.headline
}

/** 一个座位的全部行：整轮总开关 → 过程行（可折）→ 改动卡 + 轮尾。 */
