/**
 * 座位的渲染骨架：一轮（SeatBody）→ 一行（RowBody）→ 行级错误边界（RowBoundary）。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/render
 */
import { Component, memo, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { MarkdownView, createT, estimateTextTokens, type TranscriptEntry } from '@dsc/ui'
import { ReviewNoticeCard, findLast, parseReviewNotice } from '@dsc/ui-primitives'
import { FoldPrefsContext, ShellCwdContext, ShellSessionContext, TOOLVIEW_SLOT, TRANSCRIPT_NODE_SLOT, TRANSCRIPT_REASONING_BODY_SLOT, TURN_INDEPENDENT, keyOf, type Row, type Seat, type ToolViewRender } from './shared'
import { stepGroupFoldKey, turnFoldKey } from './fold-state'
import type { SeatStore } from './seat-store'
import { rowShows } from './row-shows'
import { turnDefaultOpen, useFoldMemory } from './round-fold'
import { RowSeat, StepGroupSeat } from './fold-seats'
import { TurnFoldRow } from './round-fold'
import { seatPlan, type StepGroup, type StepGrouping } from './process-groups'
import type { RoundInfo } from './timing'
import { UserRow } from './rows/user-row'
import { ThinkRow } from './rows/think-row'
import { ThinkText } from './rows/think-text'
import { RetryRow } from './rows/retry-row'
import { SubagentRow, ToolRow } from './rows/tool-row'
import { ChangesCard } from './rows/changes-card'
import { CompactionRow } from './rows/compaction-row'
import { ContextInjectionCard, SystemPromptCard } from './rows/prompt-card'
import { RoundFoot } from './rows/foot'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 过程区里的一段排布：`fold` 的行会被包进 `.turn-process`（收起时整段缩回 0），
 * 其余（foldedReplies=all 留在屏幕上的正文）直接排在座位上。
 */
interface MiddleBlock {
  node: ReactNode
  fold: boolean
}

export function SeatBody({
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
  store,
  onForkRound,
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
  /** 座位注册表：行体自己按身份从这里订阅（见 seat-store.ts），座位不再把 Row 递下去。 */
  store: SeatStore
  /**
   * 页脚「分叉这一轮」：吃轮号、不吃座位对象。
   *
   * 为什么参数换成轮号（2026-11-10，S2 彻底方案）：座位每帧都是新对象，吃座位的回调也只能
   * 每帧现造；换成数字之后顶层那个回调是稳定的（`ui.tsx` 的 `forkRound` 用 `useCallback`），
   * 这里再按轮号包一层 memo，轮尾那一行就不会跟着每一口 delta 重造。
   * undefined = 分不了（没在会话里）。
   */
  onForkRound?: (round: number) => void
}): ReactNode {
  const foldPrefs = useContext(FoldPrefsContext)
  const fold = roundFolds.get(seat.round)
  // 跑动中的轮连总开关都不画（永远展开）；可折的定稿轮才有开合。
  const foldRunning = fold?.running === true
  const foldable = fold !== undefined && fold.foldable && fold.hasContent && !foldRunning && !fold.blocked
  const turnKey = turnFoldKey(sessionId, seat.round)
  /**
   * 兜底默认态（collapseTiming，口径见 round-fold.tsx 的 turnDefaultOpen）：next-input
   * 下最新一轮先摊着，等下一轮进来它不再是最新，兜底当场翻成收起——不做定时器。
   * 用户手点过一下之后走存档（foldMemory），兜底不再生效。
   */
  const defaultOpen = turnDefaultOpen(foldPrefs.collapseTiming, fold?.latest === true)
  const turnOpen = foldMemory.open(turnKey, defaultOpen)
  /** 整轮收起来没有：可折 + 有内容 + 已收尾 + 没被展开（默认收起；next-input 的最新一轮默认展开）。 */
  const collapsed = foldable && !turnOpen
  /** 把整轮放出来（座位被 Ctrl+F 命中、或焦点落在收起的内容里时由座位自己调）。 */
  // 为什么要 useCallback（S2 彻底方案，2026-11-10）：这个回调被递给每一行的座位壳
  // （`SeatFrame` 的 `onReveal`）。座位壳是 memo 的，回调每帧换引用就会让整屏的壳全部重渲染，
  // 逐行订阅也就白做了。依赖只有存档对象与这一轮的键，两者都不随 delta 变。
  const reveal = useCallback((): void => {
    foldMemory.set(turnKey, true)
  }, [foldMemory, turnKey])
  /**
   * 轮尾那个「分叉」回调：按**轮号**包一层，于是它跨帧是同一个引用（第 1 轮不给分）。
   * 回调本身稳定，包出来的这一个才稳得住——见上面 `onForkRound` 的注释。
   */
  const onFork = useMemo(
    () => (onForkRound === undefined || seat.round === 0 ? undefined : () => onForkRound(seat.round)),
    [onForkRound, seat.round],
  )
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
  // 过程正文（entry.process）不算回答：它是「接下来要干什么」的前言，不是这一轮说的话。
  const answer = seat.rows
    .map((row) => row.entry)
    .filter((entry): entry is Extract<TranscriptEntry, { kind: 'text' }> =>
      entry.kind === 'text' && entry.id >= 0 && entry.process !== true)
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
   * 一行条目：座位壳（真盒子 + 收起时的 `hidden="until-found"`）+ 行体。
   *
   * 2026-11-10（S2 彻底方案）：壳与行体分开——壳只吃**稳定标量**（座位键、藏不藏、轮序号），
   * 行体自己去注册表订阅（见 {@link SeatFrame}）。所以这一行递下去的不是 `Row` 对象
   * （那个每帧都是新的），而是一个字符串身份。
   */
  const seatRow = (row: Row, hidden: boolean): ReactNode => {
    // 画不出东西的条目**不建座位**（判据见 row-shows.ts）：空盒子不占高度，但仍吃过程区
    // 那一个 3px 的 flex 缝——一轮改五个文件就在组头下面叠出 27px 的白。
    if (!rowShows(row.entry)) return null
    const key = keyOf(row, sessionKey)
    return (
      <SeatFrame
        key={key}
        seatKey={key}
        hidden={hidden}
        onReveal={reveal}
        roundIndex={seat.round}
        store={store}
        renderSlot={renderSlot}
      />
    )
  }
  /**
   * 一组现在展开没有。
   *
   * 键用**组里第一条的稳定身份**（`row.stable`，见 shared.ts 的 {@link Row.stable}），不再用
   * 「轮内第几组」的序号：跑动中尾组会不断吸收新成员，中途还会因为「一条不成组」而从界面上
   * 消失又出现（见 process-groups.ts 尾组那段），序号在前面的组消失时会整体前移，用户点开的
   * 那一组于是被下一组借走。dsh 的组身份同样由首成员派生（conversation-nodes/process-groups.ts
   * 的 `['process', first.key, first.groupPart]`），这里取同一口径。
   */
  const groupKeyOf = (group: StepGroup): string => {
    const first = seat.rows.find((row) => row.at === group.startIndex)
    return stepGroupFoldKey(sessionId, first?.stable ?? `r${String(group.roundIndex)}:${String(group.seq)}`)
  }
  const groupOpen = (group: StepGroup): boolean => foldMemory.open(groupKeyOf(group), false)
  const toggleGroup = (group: StepGroup): void => {
    foldMemory.set(groupKeyOf(group), !groupOpen(group))
  }
  const liveDetail = foldPrefs.policy.liveDetail
  // 过程区分块：连续的过程条目收进阶段组（组体是「真盒子」，才有自己的限高与滚动），
  // 其余按「过程 / 之后」两档摆——独立节点（计划卡、system、轮尾标记）永远在「之后」，
  // 收起整轮不把它们一起藏掉。
  //
  // 「哪条行归哪儿」是 process-groups.ts 的**纯函数**（seatPlan）：**每条行恰好出一次**
  // ——组出一次（带着它的全部组员），不在组里的行各出一次。这条不变量曾经靠渲染体自己
  // 维护，漏掉一次就是「一条思考栏出现两次」（0.6.67 报障）；搬出去之后它由
  // `scripts/ui-transcript-render-test.mjs` 直接断言。
  const rowByAt = new Map(seat.rows.map((row) => [row.at, row]))
  /**
   * 收起后要藏的行：判据是预算器给的**下标集合**（foldedReplies=all 时正文不在集合里）。
   * 2026-11-06 由「落在过程区区间里就藏」改成查集合：all 档要留下中间那几段话，
   * 一段连续区间表达不了「藏、留、藏」这种形状。
   */
  const inFold = (row: Row): boolean =>
    fold !== undefined && fold.foldable && fold.hidden.has(row.at) && !TURN_INDEPENDENT.has(row.entry.kind)

  /** 按「藏 / 留」两档摆一行（组员与单独行共用这一条，别在别处再写一遍）。 */
  const middle: MiddleBlock[] = []
  const pushRow = (row: Row): void => {
    // **一条行要么进「要藏的一段」，要么原地摆着，绝不能被挪到队尾**（2026-11-07 报障：
    // 「任务中的更改文件一直堆积在底部，没有保持原位」）。原来这里有个 else 分支把
    // 「不折、也不是留在屏幕上的正文」的行丢进 afterBlocks，而 afterBlocks 是整段过程区
    // **之后**才渲染的——写前预览卡（system 条目）、计划卡、轮尾标记这些独立行于是全部
    // 排到一轮的末尾。写前预览一次编辑一张，一个任务里改十几次文件就是十几张卡摞在底部。
    // 分段机制（下面那个循环）本来就能在原地夹住这些行：它们作为 fold: false 的块把
    // 过程区分成几段，收起时只有段落收起来，它们留在原地。
    if (inFold(row)) middle.push({ node: seatRow(row, collapsed), fold: true })
    else middle.push({ node: seatRow(row, false), fold: false })
  }
  for (const item of seatPlan(seat.rows.slice(1).map((row) => row.at), stepGrouping)) {
    if (item.kind === 'group') {
      const head = item.group
      const members = item.members
        .map((at) => rowByAt.get(at))
        .filter((member): member is Row => member !== undefined)
      // 组一律画组头，不按成员条数放平（2026-11-07 撤掉 10-31 的放平规则）：
      // 放平的前提是「组里只有一条工具」，而那时组头说的是和工具行同一句话。现在思考也在
      // 组里，一条思考 + 一次调用就是一个完整的阶段，放平等于把这层结构重新摊回平铺——
      // 正是用户报障时看到的画面。dsh 也不按条数放平（ChatGroupSeat 对每个组都画头）。
      middle.push({
        fold: true,
        node: (
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
          </StepGroupSeat>
        ),
      })
      continue
    }
    const row = rowByAt.get(item.at)
    if (row === undefined) continue
    // 不上屏的行连「分段」都不该参与：它会把一段过程区劈成两段，凭空多出两个段间缝。
    if (!rowShows(row.entry)) continue
    pushRow(row)
  }
  /**
   * 过程区**分段**包一层再折：连续的「要藏」行合成一段 `.turn-process`，收起时这一片
   * 高度从 0 长回来 / 缩回 0，一段一起动；留在屏幕上的正文不进任何一段，按原顺序夹在
   * 几段之间（foldedReplies=all 的「中间留几段话在外面」就是这么落地的）。
   *
   * 为什么必须包一层：平铺在座位上折不了——收起的行是 `hidden`（不产生盒子），夹在它们
   * 之间的 6px flex gap 会留下来，几十行的轮收起来就是一片空白的间隙堆。包进一格之后，
   * 座位的 gap 只算这一格。高度动画本身在 CSS：`.turn-process` 的 grid-template-rows
   * 0fr↔1fr（不需要 JS 量高度）。
   */
  const foldBlocks: ReactNode[] = []
  let segment: ReactNode[] = []
  const flushSegment = (): void => {
    if (segment.length === 0) return
    foldBlocks.push(
      <div className="turn-process" data-fold={collapsed ? 'closed' : 'open'} key={`process-${String(foldBlocks.length)}`}>
        <div className="turn-process-body">{segment}</div>
      </div>,
    )
    segment = []
  }
  for (const block of middle) {
    if (block.fold) {
      segment.push(block.node)
      continue
    }
    flushSegment()
    foldBlocks.push(block.node)
  }
  flushSegment()
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
      {foldBlocks.length === 0 ? null : <>{foldBlocks}</>}
      {/* 「已编辑 N 个文件」是**轮尾**卡：这一轮还在跑时不画。
          0.8.0 之前它一出现第一条 changes 条目就上屏，于是「正在运行命令」的转圈下面
          先挂出一份只算了一半的清单——用户看到的是「这一轮改了 5 个文件」，
          而实际上后面还有几刀没落地，点「审查」看到的是半截改动（2026-11-01 报障）。
          判据只认 running（ChatView 的 turnState + 「是不是最后一轮」）：它精确对应
          「这一轮正在执行」。不拿 roundFold 的 running——那个还含「这一轮没答完」，
          被中断的旧轮会永远成立，它的改动卡就再也画不出来了。 */}
      {running ? null : <ChangesCard rows={seat.rows} cwd={cwd} />}
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


/**
 * 内置行体：每种 kind 长什么样。
 *
 * 2026-11-10 从 RowBody 拆出来：`transcript.node` 槽的**兜底**就是这一份（链上没人认领
 * 时画的还是这些分支），拆出来之后「谁画的」与「画成什么样」分成两层，槽那边只管前者。
 * 逐分支与拆分前一致，不要在这里顺手改行为。
 */
function builtinRowBody(
  row: Row,
  sessionId: string | null,
  cwd: string,
  renderSlot: ToolViewRender | undefined,
): ReactNode {
  const entry = row.entry
  switch (entry.kind) {
    case 'user':
      return <UserRow entry={entry} />
    case 'text':
      // 过程正文：同一步里调工具之前的那句前言（adapter 在 tool/call 时标上的）。
      // 它跟思考行同处过程区，只是模型把话写在了正文通道（dsh 的模型写在 reasoning 里，
      // 屏幕上是一行「思考 · …」）。所以这里按过程行的量级画：小字、灰、不占正文的排场。
      if (entry.process === true) {
        return (
          <div className={row.live ? 'entry-note live' : 'entry-note'} data-process-note>
            <MarkdownView text={entry.text} path="" baseDir={cwd} streaming={row.live} />
          </div>
        )
      }
      return (
        <div className={row.live ? 'entry-text live' : 'entry-text'}>
          {/* 正文渲染 markdown（与桌面端 MarkdownText 同一能力面：GFM 表格/任务列表等）。
              直播尾同样渲染——半截 markdown 短暂错排是流式的固有代价，桌面端也一样。
              baseDir 递的是会话的工作目录：正文里「相对路径」的文件链接要按它拼绝对路径，
              否则点一下只会得到一个空 href（2026-11-09「点链接弹出新窗口」的成因）。 */}
          <MarkdownView text={entry.text} path="" baseDir={cwd} streaming={row.live} />
        </div>
      )
    case 'thinking': {
      // 展开态存档键：`会话id:think:<行的稳定身份>`。
      //
      // 为什么不是 `entry.id`（2026-11-10 改）：直播思考的 id 是「第几个直播段」的负数，
      // 段一增删就变；定稿那一刻又换成正数。键跟着 id 换，用户点开的那一段在「新工具进来 /
      // 这段定稿」时查不到存档、直接收起，而下一段直播思考恰好复用同一个负 id、把那份
      // 「展开」读走——报障的原话就是「收起旧的、展开新的」。稳定身份见 shared.ts 的 Row.stable。
      const storeKey = `${sessionId ?? ''}:${row.stable}`
      // 正文走 `transcript.reasoning.body` 选举：链上有人认领就换排版，全体弃权落回 ThinkText。
      // 兜底走第三个参数（不是 `??`）：renderSlot 返回的是 outlet 元素、永远不是 null。
      const fallback = <ThinkText text={entry.text} live={row.live} />
      return (
        <ThinkRow
          entry={entry}
          live={row.live}
          storeKey={storeKey}
          body={renderSlot?.(TRANSCRIPT_REASONING_BODY_SLOT, { entry, live: row.live, storeKey }, fallback) ?? fallback}
        />
      )
    }
    case 'tool': {
      // 这条工具调用谁画由 toolview 链选举：链上有人认领就归它（matched 一并交给它），
      // 全体弃权（或链上没人）落回内置工具卡——内置渲染器自己也在链上，这只是兜底位。
      // 展开态存档键顺着 owner 传给当选者：链上有人接管时同一份展开态也活得过重挂。
      //
      // 键为什么不再用 `row.at`（0.6.x，2026-11-10 改）：at 是条目在全量数组里的下标，
      // 直播段增删、历史入账都会让它漂——工具卡展开着，前一条定稿一进来它就「换了个身份」，
      // 展开态落到别的卡上。改用行的稳定身份（工具优先取 callId，见 shared.ts 的 buildSeats）。
      const storeKey = `${sessionId ?? ''}:${row.stable}`
      return renderSlot?.(TOOLVIEW_SLOT, { entry, storeKey }) ?? <ToolRow entry={entry} storeKey={storeKey} />
    }
    case 'system': {
      // 压缩落点（对照 dsh 的 CompactionItem）：这条 system 正文是「历史刚被压缩」的取证句，
      // 给轨迹页切区段用的。对话流里不铺整句，只画一行分隔 + 次数——读者要的是「这里断过」，
      // 不是再读一遍通知正文（正文里的信息量与「只保留摘要」这层含义一并压进 data-tip）。
      // **必须排在写前预览前面**：压缩通知从不是 diff 正文，先判标记再解析文本，
      // 免得以后某句压缩提示里恰好出现 diff 形状时被认成预览卡。
      if (entry.compaction !== undefined) return <CompactionRow mark={entry.compaction} />
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
    case 'system-prompt': {
      // 这一轮用的系统提示：只画读数与段清单，正文不画（正文按 hash 去重在会话 state 里，
      // 条目不携带——这是数据面的决定，界面不去补）。
      //
      // 存档键与会话 id + 行的稳定身份拼（与 think / tool 同口径）：切会话重挂时展开态
      // 能读回来；同一条提示连发几轮时 adapter 原地刷 ts，键不变，所以点开的那张不会自己收起。
      const storeKey = `${sessionId ?? ''}:${row.stable}`
      return <SystemPromptCard prompt={entry.prompt} storeKey={storeKey} />
    }
    case 'context-injection': {
      // 这一轮额外注进上下文的东西（环境快照 / 模式 / 沙箱 / 待办提醒）：同样是请求侧内容，
      // 不进对话正文，只记成一张可展开的账单卡。存档键口径同上。
      const storeKey = `${sessionId ?? ''}:${row.stable}`
      return <ContextInjectionCard parts={entry.parts} storeKey={storeKey} />
    }
    case 'turn-max-tokens':
      return (
        <div className="entry-system" data-turn-notice="max-tokens">
          {t('transcript.entry.maxTokens')}
        </div>
      )
    case 'model-retry':
      // 从一行灰字换成可展开的折叠条（2026-11-07）：收起时只说「第几次 / 还剩几次 / 等了
      // 多久」，失败原因要点开——一次限流连着重试四五次时，原文摊在会话里会糊满屏。
      return <RetryRow entry={entry} />
    case 'turn-end':
      // 旧界面这一条不上屏（结束状态写在整轮开关那一行）。我们还没有那一行，
      // 于是只把「没好好答完」的两种原因显出来——正常结束保持安静。
      if (entry.reason === 'completed') return null
      return <div className="entry-system">{entry.reason === 'aborted' ? t('transcript.entry.aborted') : t('transcript.entry.failed')}</div>
    case 'plan':
      return (
        <div className={`plan-card ${entry.plan.decision === 'pending' ? 'pending' : 'settled'}`}>
          <div className="plan-head">
            <span className="plan-title">{entry.plan.title}</span>
            <span className="plan-verdict">
              {entry.plan.decision === 'pending'
                ? t('transcript.plan.pending')
                : entry.plan.decision === 'approved'
                  ? t('transcript.plan.approved')
                  : t('transcript.plan.rejected')}
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
      return <div className="entry-system">{t('transcript.entry.unknownKind', { kind: String(kind) })}</div>
    }
  }
}

/**
 * 行体：先问节点级槽，落空画内置行体（见上面的 builtinRowBody）。
 *
 * 这一层**没有 memo**，也不需要——「没变就不重画」的保证在别处（2026-11-10，S2 彻底方案）：
 *   - 座位里的行走 {@link SeatFrame} + {@link RowSlot}：壳是 memo 的（props 全是稳定标量），
 *     行体订阅注册表（`seat-store.ts`），只有**自己那一格换了对象**才重渲染；
 *   - 前导行（开场 system 行、系统提示卡）与只读子代理流仍直接用它：那两处的条目一次给定、
 *     不是流式热路径，多包一层 `memo` 只会多一层要维护的比较器。
 *
 * 为什么不再比 `row.entry` 引用 + `row.live` + `renderSlot`（上一轮的止血比较器）：
 * 那个比较器只省掉**行体函数体**这一层，座位壳（`RowSeat` 里的两个 hook）与元素对账照旧
 * 每帧各跑一遍；而且宿主每 50 帧发一次全量锚帧（`core/remote/frames.ts` 的
 * `FULL_ANCHOR_FRAMES`），那一帧每条 `entry` 都是新对象、内容一字不差，比较器当场集体失效
 * （实测一次 115 行同时重画）。现在等价判断挪进注册表（`sameRow`：引用相同**或深度相等**
 * 都算没变），一处判断同时管住壳与行体。
 */
export function RowBody({ row, renderSlot }: { row: Row; renderSlot?: ToolViewRender }): ReactNode {
  const sessionId = useContext(ShellSessionContext)
  const cwd = useContext(ShellCwdContext)
  const builtin = builtinRowBody(row, sessionId, cwd, renderSlot)
  // 没有槽渲染上下文（团队页签直接把组件当值渲染）时直接画内置行体——**不能**用一个
  // 返回 null 的空函数顶替，否则整条子代理流会白屏（renderSlot 一旦存在就会被调用）。
  if (renderSlot === undefined) return builtin
  // 兜底走 renderSlot 的第三个参数，不要写成 `renderSlot(...) ?? builtin`：返回值是渲染出口
  // 的元素、永远不是 null，`??` 判不出「链上没人」。
  return renderSlot(TRANSCRIPT_NODE_SLOT, {
    entry: row.entry, live: row.live, stable: row.stable, sessionId,
  }, builtin)
}

/**
 * 一行的座位壳：`.entry-row` 真盒子 + 收起时的 `hidden="until-found"`。
 *
 * props 只有**稳定标量**与稳定引用（座位键、藏不藏、轮序号、放行动作、注册表、槽渲染函数），
 * 所以 `memo` 的默认浅比较就能挡住「整屏每帧重渲染」：流式期间 delta 只让注册表里的某一格
 * 换对象，壳一个都不重渲染，只有那一格的行体被通知（见 {@link RowSlot}）。
 *
 * 为什么不让壳自己去订阅：壳要画的东西（藏不藏、轮序号）是**父**算出来的，不是注册表里的
 * 数据；把这两样也塞进注册表，等于每帧都要为所有行生成一份「藏不藏」的状态，反而更贵。
 *
 * 为什么 `hidden` 走 prop 而不是 context：它只在折叠/展开那一拍变（一次点击，不是每帧），
 * 变的次数少到不值得为它单开一条订阅通道。
 */
export const SeatFrame = memo(function SeatFrame(props: {
  /** 座位键 = `会话|行稳定身份`（与 React key、注册表键是同一个字符串）。 */
  seatKey: string
  hidden: boolean
  roundIndex: number | undefined
  onReveal(): void
  store: SeatStore
  renderSlot?: ToolViewRender
}): ReactNode {
  return (
    <RowSeat hidden={props.hidden} onReveal={props.onReveal} roundIndex={props.roundIndex}>
      <RowSlot seatKey={props.seatKey} store={props.store} renderSlot={props.renderSlot} />
    </RowSeat>
  )
})

/**
 * 行体入口：自己从注册表订阅**这一行**。
 *
 * 三层各管一件事，缺一层都会退回到「整树每帧重渲染」：
 *   1. 壳（{@link SeatFrame}）与它都是 `memo` 的，props 恒为那几个稳定值 → 父组件每帧重渲染
 *      时它们直接被跳过，连函数体都不进；
 *   2. 这一层订阅注册表：`useSyncExternalStore` 的快照就是行的 `Row` 对象，注册表在
 *      `sameRow` 判等通过时复用旧对象 → 快照不变 → 不重渲染；
 *   3. 真变了（尾行每帧都在变）时，注册表 `commit()` 只通知这一格，React 只重渲染这一行。
 *
 * 快照读的是 `store.row(seatKey)`：注册表在**渲染期**就把这一帧的登记表放进 pending
 * （见 `seat-store.ts` 的 `stage`），所以新挂载的行第一帧就拿得到数据，不会先画一帧空的。
 */
const RowSlot = memo(function RowSlot(props: {
  seatKey: string
  store: SeatStore
  renderSlot?: ToolViewRender
}): ReactNode {
  const row = useSeatRow(props.store, props.seatKey)
  if (row === undefined) return null
  return (
    <RowBoundary entry={row.entry}>
      <RowBody row={row} renderSlot={props.renderSlot} />
    </RowBoundary>
  )
})

/**
 * 订阅注册表里的一格。
 *
 * `subscribe` / `getSnapshot` 都按 `seatKey` 包一层 `useCallback`：`useSyncExternalStore`
 * 会把它们放进依赖里，每帧给新函数等于每帧重订阅一次（退订 + 订阅，白干活）。
 */
function useSeatRow(store: SeatStore, seatKey: string): Row | undefined {
  const subscribe = useCallback((onChange: () => void) => store.subscribe(seatKey, onChange), [store, seatKey])
  const snapshot = useCallback(() => store.row(seatKey), [store, seatKey])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
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
export class RowBoundary extends Component<{ entry: TranscriptEntry; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidUpdate(previous: { entry: TranscriptEntry }): void {
    if (this.state.error !== null && previous.entry !== this.props.entry) this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return <div className="entry-system">{t('transcript.entry.renderFailed', { message: this.state.error.message })}</div>
    }
    return this.props.children
  }
}
