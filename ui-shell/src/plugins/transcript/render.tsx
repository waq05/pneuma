/**
 * 座位的渲染骨架：一轮（SeatBody）→ 一行（RowBody）→ 行级错误边界（RowBoundary）。
 *
 * 从 `transcript/ui.tsx` 拆出来（2026-10-28，只搬不改）：模块头仍见那一份。
 *
 * @module dsc-ui-shell/plugins/transcript/render
 */
import { Component, useContext, type ReactNode } from 'react'
import { MarkdownView, estimateTextTokens, type TranscriptEntry } from '@dsc/ui'
import { ReviewNoticeCard, findLast, parseReviewNotice } from '@dsc/ui-primitives'
import { FoldPrefsContext, ShellCwdContext, ShellSessionContext, TOOLVIEW_SLOT, TURN_INDEPENDENT, keyOf, type Row, type Seat, type ToolViewRender } from './shared'
import { stepGroupFoldKey, turnFoldKey } from './fold-state'
import { useFoldMemory } from './round-fold'
import { RowSeat, StepGroupSeat } from './fold-seats'
import { TurnFoldRow } from './round-fold'
import { seatPlan, type StepGroup, type StepGrouping } from './process-groups'
import type { RoundInfo } from './timing'
import { UserRow } from './rows/user-row'
import { ThinkRow } from './rows/think-row'
import { SubagentRow, ToolRow } from './rows/tool-row'
import { ChangesCard } from './rows/changes-card'
import { RoundFoot } from './rows/foot'

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


export function RowBody({
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
      return <div className="entry-system">这一条没画出来：{this.state.error.message}</div>
    }
    return this.props.children
  }
}
