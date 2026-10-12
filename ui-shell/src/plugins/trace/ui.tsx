/**
 * 内置插件：执行轨迹页（对照旧桌面渲染层 `TraceView.tsx`，补上几处壳的增量）。
 *
 * 结构：
 * 1. 上方一条**时间概览条**（TraceTimeline）：整轮会话按真实时间投影成横向时间轴，
 *    拖选区间可聚焦下方记录，滚轮缩放 / 右键拖动平移（旧版留的「这一轮不做」已补）；
 * 2. **工具栏行**（sticky）：轮数 / 工具调用数 / 用量 / 区间命中计数 + 全部展开折叠
 *    + **搜索**（新，对照 dsh 的搜索框：命中步骤高亮、未命中的轮收起来）；
 * 3. **轮次记录表**：按用户消息分轮，轮头一行可折叠；带 `compaction` 字段的条目
 *    渲染成轮与轮之间的独立区段行「已压缩历史 · 第 N 次」；正文 text 不进轨迹；
 * 4. 每条步骤右侧一列**行内元信息**：时刻（HH:mm）· 工具耗时 · 用量；
 * 5. 点行打开右侧**检查器**（TraceInspector）：输入 / 输出 / 思考全文 / 计时 / 用量 / 附件；
 * 6. 尾部跟随：默认贴底，用户上滚暂停，滚回底部附近自动恢复。
 *
 * 壳的增量（旧版没有的）：搜索、时间轴缩放平移、子代理/轮结束/长度上限/模型重试
 * 四类步骤的行渲染（旧版这四类会画成空行）、工具行「在轨迹中查看」带来的**聚焦闪烁**。
 *
 * 诚实口径：条目 `ts` 是「最后写入时刻」，工具的发起时刻只认 `call.startedAt`，耗时只认
 * `call.durationMs`——缺哪个就写「未记录」，不拿 `ts` 冒充、不编 0 秒、不虚构宽度。
 *
 * @module dsc-ui-shell/plugins/trace
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCoins,
  IconSearch,
  SLOT,
  clearTraceFocus,
  defineUiPlugin,
  useHostSelector,
  useTraceFocus,
  type HostSnapshot,
  type TranscriptEntry,
} from '@dsc/ui'
import { formatClock } from '../../platform/time'
import { formatTokens } from '../../platform/tokens'
import { matchTool, prettyJson, TOOL_STATUS_TEXT, toolSummary, toolVerb, type ToolMatch } from '../../platform/tool-summary'
import { buildTraceModel, entryUsage, formatTraceDuration, rangeHits, stepMatches, type TraceRange, type TraceRound, type TraceStepEntry } from './trace-format'
import { TraceTimeline } from './timeline'
import { TraceInspector } from './inspector'

/** 折叠态里的思考摘要长度：一行放不下就省略号，展开才看全文。 */
const THINK_PREVIEW_LIMIT = 90

/**
 * 「用户真的滚离底部了」的门槛（px）：比贴底判定 AT_BOTTOM_EPS（32px）宽一档，
 * 两档之间是滞回区间——停在这一带两边都不动，跟随态不会随着手抖反复翻。
 * 与消息流的自动跟随是同一把尺子（那边叫 PAUSE_EPS），刻意取值一致。
 */
const TRACE_PAUSE_EPS = 120
/** 贴底判定（与右缘刻度条、消息流共用同一档）。 */
const AT_BOTTOM_EPS = 32
/** 从轨迹页跳过来的高亮闪烁持续多久（ms）——足够眼睛找到位置，不用手动清。 */
const FLASH_MS = 1600

/** 把多行文本压成一行摘要（折叠态显示用）。 */
function summarize(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > THINK_PREVIEW_LIMIT ? `${flat.slice(0, THINK_PREVIEW_LIMIT)}…` : flat
}

export default defineUiPlugin({
  name: '执行轨迹',
  apply(ui) {
    // 轨迹页住在正文区的「另一张脸」槽里（`thread-view` 切到 trace 时壳才渲染它）。
    ui.slots.register(SLOT.thread, { id: 'trace.view', order: 1 }, TraceView)
  },
})

function TraceView(): ReactNode {
  const entries = useHostSelector(readEntries)
  const live = useHostSelector(readLive)
  const sessionPath = useHostSelector(readSessionPath)
  const usage = useHostSelector(readUsage)
  /** 消息流与直播尾合在一份看：跑动中的工具调用正是轨迹最该显示的东西。 */
  const all = useMemo<TranscriptEntry[]>(() => [...entries, ...live], [entries, live])
  const model = useMemo(() => buildTraceModel(all), [all])
  const rounds = model.rounds
  const toolCount = all.filter((entry) => entry.kind === 'tool').length

  const scroller = useRef<HTMLDivElement | null>(null)
  /** 展开着的轮次序号；默认只放最新一轮。 */
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  /** 检查器正开着的那条记录（存 id 而不是对象：运行中的工具卡会持续更新，按 id 现取才跟得上）。 */
  const [inspectId, setInspectId] = useState<number | null>(null)
  /** 时间条上拖选出来的区间。 */
  const [selected, setSelected] = useState<TraceRange | null>(null)
  /** 搜索词（dsh 的搜索框；空串 = 不在搜索）。 */
  const [query, setQuery] = useState('')
  /** 从别处跳进来要高亮的那一条（几秒后自己灭）。 */
  const [flashId, setFlashId] = useState<number | null>(null)

  /**
   * 还在不在「跟随最新内容」。
   *
   * 为什么用 ref 不用 state：这个判断挂在滚动事件与每次渲染上，走 state 会为了一个
   * 只在切换瞬间才变的值多渲染一轮；需求也明确「不弹任何按钮」，所以它没有配套 UI。
   * 判定沿消息流的做法：离开底部 TRACE_PAUSE_EPS 就暂停，回到 AT_BOTTOM_EPS 以内恢复。
   */
  const followRef = useRef(true)
  /**
   * 我们自己钉底时落到的那个 scrollTop。
   *
   * 为什么要记这一笔：`scrollTop = scrollHeight` 是程序性滚动，但它同样会（异步）发一个
   * scroll 事件；不认这一笔的话，自动跟随会把**自己钉的那一下**判成「用户滚离」，
   * 于是新步骤一来就自己停了跟随。
   */
  const autoTopRef = useRef(-1)
  /** 已经聚焦过的那个区间（同一区间不重复滚，内容更新时不把视角反复拽走）。 */
  const appliedSelection = useRef<TraceRange | null>(null)
  /** 待聚焦的步骤 id：等它所在的那一轮渲染出来再滚（见下面的聚焦 effect）。 */
  const [focusId, setFocusId] = useState<number | null>(null)

  /** 条目 id → 轮次序号（检查器标题、命中步骤的轮次都要用）。 */
  const roundOfEntry = useMemo(() => {
    const map = new Map<number, number>()
    for (const round of rounds) {
      if (round.user !== null) map.set(round.user.id, round.index)
      for (const step of round.steps) map.set(step.id, round.index)
    }
    return map
  }, [rounds])

  /**
   * 每轮的用量真值：轮内**最后一条**带 usage 的 text / tool 条目（contract.ts 的口径）。
   * 为什么整轮键起来：同一轮里靠前的条目挂的是「到那一刻为止」的累计，逐条显示会让人
   * 把中间值读成整轮量；这里只认最后一条，其余行不显示用量。
   */
  const roundUsage = useMemo(() => {
    const map = new Map<number, { entryId: number; total: number }>()
    for (const round of rounds) {
      for (const step of round.steps) {
        const own = entryUsage(step)
        if (own !== null) map.set(round.index, { entryId: step.id, total: own.inputTokens + own.outputTokens })
      }
    }
    return map
  }, [rounds])

  /** 选中的区间命中了哪些步骤（没选就是空集，界面不画任何命中样式）。 */
  const hitIds = useMemo(() => {
    const hits = new Set<number>()
    if (selected === null) return hits
    for (const mark of model.marks) if (rangeHits(mark, selected)) hits.add(mark.id)
    return hits
  }, [model.marks, selected])

  /** 搜索：命中的步骤 id 与命中的轮次序号（没在搜就是空集，界面不画过滤）。 */
  const search = useMemo(() => {
    const needle = query.trim()
    if (needle === '') return null
    const steps = new Set<number>()
    const roundsHit = new Set<number>()
    for (const round of rounds) {
      for (const step of round.steps) {
        if (!stepMatches(step, needle)) continue
        steps.add(step.id)
        roundsHit.add(round.index)
      }
    }
    return { steps, rounds: roundsHit, count: steps.size }
  }, [query, rounds])

  /** 按 id 找条目：检查器要拿到最新的那一份（工具卡的结果是后到的）。 */
  const inspectEntry = useMemo(
    () => (inspectId === null ? null : (all.find((entry) => entry.id === inspectId) ?? null)),
    [inspectId, all],
  )

  // 最新一轮默认展开：新的一轮到来时把它打开，旧的保持用户留下的折叠状态。
  useEffect(() => {
    if (rounds.length === 0) return
    setExpanded((current) => {
      const last = rounds.length - 1
      if (current.has(last)) return current
      return new Set(current).add(last)
    })
  }, [rounds.length])

  /**
   * 尾部跟随：内容变了就把尾巴贴到底——前提是「还在跟随」。
   * 轨迹表是往下 append 行（不是像流式正文那样改已有元素的高度），所以不需要消息流
   * 那套「自己钉的那一下」之外的额外处理，这里从简。
   */
  useEffect(() => {
    const element = scroller.current
    if (element === null || !followRef.current) return
    element.scrollTop = element.scrollHeight
    autoTopRef.current = element.scrollTop
  }, [all])

  /**
   * 滚动 = 用户对视角的表态：离开底部就暂停跟随，回到贴底档（32px）以内就恢复。
   * 滚动事件可能来自「我们自己钉底那一下」，落点与 autoTopRef 重合就不算用户滚离。
   */
  useEffect(() => {
    const element = scroller.current
    if (element === null) return undefined
    const onScroll = (): void => {
      if (Math.abs(element.scrollTop - autoTopRef.current) <= 1) return
      const limit = element.scrollHeight - element.clientHeight
      // 一屏装得下：不存在「离开底部」，跟随照旧
      if (limit <= 0) {
        followRef.current = true
        return
      }
      const away = limit - element.scrollTop
      if (away <= AT_BOTTOM_EPS) followRef.current = true
      else if (away > TRACE_PAUSE_EPS) followRef.current = false
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      element.removeEventListener('scroll', onScroll)
    }
  }, [])

  /**
   * 工具行的「在轨迹中查看」跳过来时的聚焦：展开它所在的那一轮、滚过去、闪一下。
   * `focus` 是一次性指令（thread-view 的约定）：发起方写，这里读完就清——否则
   * 用户后来手动滚到别处，再回到轨迹页又会被拽回那一条。
   */
  const focus = useTraceFocus()
  useEffect(() => {
    if (focus === null) return
    const round = roundOfEntry.get(focus)
    if (round !== undefined) {
      setExpanded((current) => (current.has(round) ? current : new Set(current).add(round)))
    }
    setFocusId(focus)
    setFlashId(focus)
    clearTraceFocus()
  }, [focus, roundOfEntry])

  // 闪烁自己灭（用户看到位置就够了，不需要一条留在视线里的痕迹）。
  useEffect(() => {
    if (flashId === null) return undefined
    const timer = window.setTimeout(() => {
      setFlashId(null)
    }, FLASH_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [flashId])

  /** 点行开检查器：卡片自己的交互（折叠、参数里的按钮、划选文本）不抢过来。 */
  const openFromRow = (event: ReactMouseEvent<HTMLDivElement>, step: TraceStepEntry): void => {
    const target = event.target
    if (
      target instanceof HTMLElement &&
      target.closest('button, a, summary, .tool-head, .tool-body, [data-trace-open]') !== null
    ) {
      return
    }
    setInspectId(step.id)
  }

  const clearSelection = useCallback((): void => setSelected(null), [])
  const closeInspector = useCallback((): void => setInspectId(null), [])

  /**
   * 拖选之后聚焦：把命中所在的轮打开，并记下要滚到哪一条。
   * 同一个区间只做一次（内容再更新也不把用户正在看的视角拽走）。
   */
  useEffect(() => {
    if (selected === null) {
      appliedSelection.current = null
      return
    }
    if (appliedSelection.current === selected) return
    appliedSelection.current = selected
    const hits = model.marks.filter((mark) => rangeHits(mark, selected))
    if (hits.length === 0) return
    setExpanded((current) => {
      const next = new Set(current)
      for (const hit of hits) next.add(hit.round)
      return next
    })
    setFocusId(hits[0]?.id ?? null)
  }, [selected, model.marks])

  /** 真要滚，得等命中的那一轮已经渲染出来（折着的轮里没有那条记录）。 */
  useEffect(() => {
    if (focusId === null) return
    const element = scroller.current
    const target = element?.querySelector(`[data-trace-step="${String(focusId)}"]`)
    if (element === null || !(target instanceof HTMLElement)) return
    target.scrollIntoView({ block: 'center' })
    autoTopRef.current = element.scrollTop
    // 用户在看区间内的记录，不该被下一条新记录拽回底部：这一下之后暂停跟随，
    // 滚回底部附近（32px）会自动恢复。
    followRef.current = false
    setFocusId(null)
  }, [focusId, expanded, model.marks])

  if (model.segments.length === 0) {
    return (
      <div className="trace-page">
        <div className="chat" ref={scroller}>
          <div className="chat-inner trace">
            <div className="trace-empty">本会话还没有执行轨迹。发送消息或使用工具后，这里会显示执行过程。</div>
          </div>
        </div>
      </div>
    )
  }

  const allOpen = expanded.size >= rounds.length
  const toggleAll = (): void => {
    setExpanded(allOpen ? new Set() : new Set(rounds.map((_, index) => index)))
  }
  const toggleRound = (index: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div className="trace-page">
      <div className="chat" ref={scroller}>
        <div className="chat-inner trace">
          <TraceTimeline
            marks={model.marks}
            boundaries={model.boundaries}
            spanStart={model.spanStart}
            spanEnd={model.spanEnd}
            selected={selected}
            selectedCount={hitIds.size}
            resetKey={sessionPath ?? ''}
            onSelect={setSelected}
          />

          <div className="trace-stats" data-trace-query={search === null ? undefined : '1'}>
            <span>{rounds.length} 轮</span>
            <span>{toolCount} 次工具调用</span>
            {usage !== null && (
              <span>
                <IconCoins size={12} /> {formatTokens(usage)} tok
              </span>
            )}
            {selected !== null && (
              <span className="trace-focus-chip" data-trace-focus="1">
                已聚焦区间内 {hitIds.size} 步
              </span>
            )}
            {search !== null && (
              <span className="trace-focus-chip" data-trace-search-count="1">
                搜索命中 {search.count} 步
              </span>
            )}
            <button className="text-btn trace-toggle-all" onClick={toggleAll}>
              {allOpen ? '全部折叠' : '全部展开'}
            </button>
            {/* 搜索（对照 dsh 的工具栏搜索框）：命中步骤高亮，未命中的轮先收起来。 */}
            <span className="trace-search">
              <IconSearch size={12} />
              <input
                type="search"
                className="trace-search-input"
                data-trace-search="1"
                placeholder="搜索步骤（工具名、参数、输出…）"
                aria-label="搜索轨迹里的步骤"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return
                  event.stopPropagation()
                  setQuery('')
                }}
              />
              {query === '' ? null : (
                <button
                  type="button"
                  className="trace-search-clear"
                  data-trace-search-clear="1"
                  data-tip="清空搜索（Esc 也行）"
                  aria-label="清空搜索"
                  onClick={() => {
                    setQuery('')
                  }}
                >
                  <IconClose size={10} />
                </button>
              )}
            </span>
          </div>

          {search !== null && search.count === 0 ? (
            <div className="trace-empty" data-trace-search-empty="1">
              没有匹配「{query.trim()}」的步骤。
            </div>
          ) : null}

          {model.segments.map((segment) => {
            if (segment.type === 'compaction') {
              // 压缩落点：轮与轮之间的独立区段行（对照 dsh 的 Between turns）。
              // 渲染层只认 entry.compaction 这个字段，不做任何正文文本匹配。
              return (
                <div
                  className="trace-compact"
                  key={`compact-${String(segment.entry.id)}`}
                  data-trace-compaction={String(segment.count)}
                  data-tip="从这一刻起，模型看到的历史已经是压缩后的摘要"
                >
                  <span className="trace-compact-rule" />
                  <span className="trace-compact-tag">已压缩历史 · 第 {segment.count} 次</span>
                  <span className="trace-compact-rule" />
                </div>
              )
            }
            const round = segment.round
            // 搜索激活时：命中的轮留在表里，其余整轮不画（dsh 的过滤语义）；
            // 命中轮强制展开，免得「搜到了却在折着的轮里看不见」。
            const searching = search !== null
            const hitRound = searching && search.rounds.has(round.index)
            if (searching && !hitRound) return null
            return (
              <RoundBlock
                key={`round-${String(round.index)}`}
                round={round}
                open={expanded.has(round.index) || hitRound}
                onToggle={() => toggleRound(round.index)}
                usage={roundUsage.get(round.index) ?? null}
                hitIds={hitIds}
                searchHits={search?.steps ?? null}
                dimmed={selected !== null}
                inspectingId={inspectId}
                flashId={flashId}
                onOpenInspector={setInspectId}
                onRowClick={openFromRow}
              />
            )
          })}
        </div>
      </div>

      {inspectEntry !== null && (
        <>
          {/* 遮罩：点一下就关（需求指定的两种关闭方式之一，另一种是右上角的 ×） */}
          <div className="trace-scrim" data-trace-scrim="1" onClick={closeInspector} />
          <TraceInspector
            entry={inspectEntry}
            round={roundOfEntry.get(inspectEntry.id) ?? null}
            usageIsRoundTotal={
              inspectEntry.kind === 'text' || inspectEntry.kind === 'tool'
                ? roundUsage.get(roundOfEntry.get(inspectEntry.id) ?? -1)?.entryId === inspectEntry.id
                : false
            }
            onClose={closeInspector}
          />
        </>
      )}
    </div>
  )
}

/** 一轮：轮头一行 + 展开后的步骤表。 */
function RoundBlock({
  round,
  open,
  onToggle,
  usage,
  hitIds,
  searchHits,
  dimmed,
  inspectingId,
  flashId,
  onOpenInspector,
  onRowClick,
}: {
  round: TraceRound
  open: boolean
  onToggle: () => void
  usage: { entryId: number; total: number } | null
  hitIds: Set<number>
  /** 搜索命中的步骤 id（null = 不在搜索）；命中行高亮。 */
  searchHits: ReadonlySet<number> | null
  /** 时间条上有选中区间时，未命中的步骤要压暗（聚焦效果）。 */
  dimmed: boolean
  inspectingId: number | null
  flashId: number | null
  onOpenInspector: (id: number) => void
  onRowClick: (event: ReactMouseEvent<HTMLDivElement>, step: TraceStepEntry) => void
}): ReactNode {
  const tools = round.steps.filter((step) => step.kind === 'tool').length
  const user = round.user
  const images = user?.images?.length ?? 0
  return (
    <div className={`trace-round${open ? ' open' : ''}`} data-trace-round={String(round.index)}>
      <div className="round-line">
        <button
          className="round-head"
          data-round-index={String(round.index)}
          aria-expanded={open}
          data-tip={open ? '折叠这一轮' : '展开这一轮的执行步骤'}
          onClick={onToggle}
        >
          <span className="round-caret">
            {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          </span>
          <span className="round-no">第 {round.index + 1} 轮</span>
          {user !== null && <span className="round-user">{user.text}</span>}
          {images > 0 && <span className="round-attach">{images} 张附件</span>}
          <span className="round-meta">
            {round.steps.length === 0 ? '无步骤' : `${round.steps.length} 步 · ${tools} 次工具`}
          </span>
          {usage !== null && (
            <span
              className="round-tok"
              data-tip="这一轮所有模型请求的 prompt + completion 之和（宿主上报的真值）"
            >
              {formatTokens(usage.total)} tok
            </span>
          )}
        </button>
        {user !== null && (
          <button
            type="button"
            className="round-open"
            data-trace-open={String(user.id)}
            data-tip="查看这条用户消息与附件"
            aria-label="查看这条用户消息与附件"
            onClick={() => onOpenInspector(user.id)}
          >
            <IconChevronRight size={12} />
          </button>
        )}
      </div>
      {open &&
        (round.steps.length === 0 ? (
          <div className="round-none">无工具调用与系统事件</div>
        ) : (
          <div className="round-steps">
            {round.steps.map((step) => (
              <StepRow
                key={step.id}
                step={step}
                round={round.index}
                hit={hitIds.has(step.id)}
                searchHit={searchHits === null ? false : searchHits.has(step.id)}
                dim={dimmed && !hitIds.has(step.id)}
                flash={flashId === step.id}
                inspecting={inspectingId === step.id}
                usageTotal={roundUsageOwnTotal(step, usage)}
                onOpenInspector={onOpenInspector}
                onRowClick={onRowClick}
              />
            ))}
          </div>
        ))}
    </div>
  )
}

/**
 * 这一行自己带的用量：只有它就是本轮的真值那一行才显示。
 * 中间的累计值不显示——同一轮里每条都挂着一个数，逐条画会让人以为那是每一步花的量。
 */
function roundUsageOwnTotal(
  step: TraceStepEntry,
  usage: { entryId: number; total: number } | null,
): number | null {
  if (usage === null || usage.entryId !== step.id) return null
  return usage.total
}

/** 一条步骤：内容 + 右侧行内元信息（时刻 / 耗时 / 用量 / 打开检查器）。 */
function StepRow({
  step,
  round,
  hit,
  searchHit,
  dim,
  flash,
  inspecting,
  usageTotal,
  onOpenInspector,
  onRowClick,
}: {
  step: TraceStepEntry
  round: number
  hit: boolean
  searchHit: boolean
  dim: boolean
  flash: boolean
  inspecting: boolean
  usageTotal: number | null
  onOpenInspector: (id: number) => void
  onRowClick: (event: ReactMouseEvent<HTMLDivElement>, step: TraceStepEntry) => void
}): ReactNode {
  // 行内时刻取条目 ts（HH:mm）——工具的**发起**时刻另有 startedAt，两者不是一回事。
  const clock = formatClock(step.ts ?? null)
  const duration = step.kind === 'tool' ? formatTraceDuration(step.call.durationMs ?? null) : null
  const status = step.kind === 'tool' ? step.call.status : null
  return (
    <div
      className={`step trace-step${hit ? ' is-hit' : ''}${dim ? ' is-dim' : ''}${inspecting ? ' is-inspecting' : ''}${flash ? ' is-flash' : ''}${searchHit ? ' is-search-hit' : ''}`}
      data-trace-step={String(step.id)}
      data-round={String(round)}
      data-kind={step.kind}
      data-status={status ?? undefined}
      data-hit={hit ? '1' : undefined}
      data-search-hit={searchHit ? '1' : undefined}
      onClick={(event) => onRowClick(event, step)}
    >
      <div className="trace-step-body">
        {step.kind === 'tool' && <TraceToolRow entry={step} />}
        {step.kind === 'thinking' && (
          <details className="trace-think">
            <summary data-tip="展开思考全文">
              <span className="th-label">思考</span>
              <span className="th-preview">{summarize(step.text)}</span>
              <IconChevronDown size={13} className="th-chevron" />
            </summary>
            <div className="body">{step.text}</div>
          </details>
        )}
        {step.kind === 'system' && (
          <div className="trace-sys" data-tip={step.text}>
            {step.text}
          </div>
        )}
        {step.kind === 'plan' && (
          <div className="trace-plan" data-tip={step.plan.text}>
            <span className="th-label">计划</span>
            <span className="plan-title">{step.plan.title}</span>
            <span className="plan-file">{step.plan.file}</span>
          </div>
        )}
        {/* 四类轮级/旁路事件（旧版这四类会画成空行；dsh 里各有自己的行样式）。 */}
        {step.kind === 'subagent' && (
          <div className="trace-sys trace-event" data-tip={step.sub.task}>
            <span className="th-label">子代理</span>
            <span className="event-text">{step.sub.name}</span>
            <span className="event-state">{step.sub.state}</span>
          </div>
        )}
        {step.kind === 'turn-end' && (
          <div className="trace-sys trace-event" data-tip="这一轮没有正常结束">
            <span className="th-label">{step.reason === 'aborted' ? '已停止' : '过程失败'}</span>
          </div>
        )}
        {step.kind === 'turn-max-tokens' && (
          <div className="trace-sys trace-event" data-tip="这次输出撞上了长度上限">
            <span className="th-label">达到长度上限</span>
          </div>
        )}
        {step.kind === 'model-retry' && (
          <div className="trace-sys trace-event" data-tip="同一个请求重试了">
            <span className="th-label">{`模型重试（第 ${String(step.attempt)} 次）`}</span>
          </div>
        )}
      </div>
      <div className="trace-meta">
        {clock !== null && (
          <span className="tmeta-clock" data-tip="这条记录最后写入的时刻（本机时区）">
            {clock}
          </span>
        )}
        {duration !== null && (
          <span className="tmeta-dur" data-tip="这次工具调用从发起到结果回来的耗时">
            {duration}
          </span>
        )}
        {usageTotal !== null && (
          <span className="tmeta-tok" data-tip="这一轮所有模型请求的 prompt + completion 之和">
            {formatTokens(usageTotal)} tok
          </span>
        )}
        <button
          type="button"
          className="tmeta-open"
          data-trace-open={String(step.id)}
          data-tip="打开检查器：输入、输出、思考全文、计时与用量"
          aria-label="打开检查器"
          onClick={() => onOpenInspector(step.id)}
        >
          <IconChevronRight size={12} />
        </button>
      </div>
    </div>
  )
}

/**
 * 轨迹页里的工具卡：比对话页的轻一档——没有吸附快捷栏与「将做的改动」推演
 * （轨迹页看的是「已经发生了什么」，耗时也是宿主上报的真值而不是现场计时）。
 *
 * 行结构与对话页同一套 class（`.entry.tool-card` / `.tool-head` / `.tool-body`），
 * 摘要、动词、状态词都读平台层同一份口径（`platform/tool-summary`）——两张脸对
 * 同一条调用给同一句话。
 */
function TraceToolRow({ entry }: { entry: Extract<TraceStepEntry, { kind: 'tool' }> }): ReactNode {
  const call = entry.call
  const [open, setOpen] = useState(false)
  const expandable = call.status !== 'preparing'
  const bodyOpen = open && expandable
  const match: ToolMatch = matchTool(call.name)
  const Icon = match.Icon
  const summary = toolSummary(call.name, call.argsText)
  const duration = formatTraceDuration(call.durationMs ?? null)
  const statusText = TOOL_STATUS_TEXT[call.status] ?? call.status

  return (
    <div className={`entry tool-card status-${call.status}${bodyOpen ? ' open' : ''}`}>
      <div
        className="tool-head"
        role="button"
        tabIndex={expandable ? 0 : -1}
        {...(expandable ? { 'aria-expanded': bodyOpen } : {})}
        data-tip={expandable ? (bodyOpen ? '点击收起参数与结果' : '点击展开参数与结果') : '正在准备参数'}
        onClick={() => {
          if (expandable) setOpen(!open)
        }}
        onKeyDown={(event) => {
          if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
          event.preventDefault()
          setOpen(!open)
        }}
      >
        <span className="tool-dot" aria-hidden="true" />
        <Icon size={14} className="tool-icon" />
        <span className="verb">{toolVerb(match.base, call.status)}</span>
        {/* 认不出的工具保留原名：没有它就看不出这是哪家的工具（MCP 那些名字不直观）。 */}
        {match.known ? null : <span className="name">{call.name}</span>}
        <span className="preview">{summary}</span>
        <span className="status">
          {call.status === 'running' ? <i className="tc-spin" aria-hidden="true" /> : null}
          {/* 定稿不说「完成」：状态点已经绿了，再印一遍是噪声。 */}
          {call.status === 'done' ? '' : statusText}
          {call.status === 'done' ? (duration === null ? '' : duration) : duration === null ? '' : ` · 用时 ${duration}`}
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

/** 空条目表：没拿到快照时共用一份，省得每帧新建数组。 */
const NO_ENTRIES: readonly TranscriptEntry[] = Object.freeze([])

function readEntries(snapshot: HostSnapshot | null): readonly TranscriptEntry[] {
  const value = snapshot?.entries
  return Array.isArray(value) ? (value as unknown as TranscriptEntry[]) : NO_ENTRIES
}

function readLive(snapshot: HostSnapshot | null): readonly TranscriptEntry[] {
  const value = snapshot?.liveEntries
  return Array.isArray(value) ? (value as unknown as TranscriptEntry[]) : NO_ENTRIES
}

/** 当前会话的 jsonl 路径（时间条取景窗口的重置键）。 */
function readSessionPath(snapshot: HostSnapshot | null): string | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const value = (status as Record<string, unknown>)['sessionPath']
  return typeof value === 'string' ? value : null
}

/** 快照上的整会话用量（`status.usage`，状态栏与轮尾读的同一份）；没有就是 null。 */
function readUsage(snapshot: HostSnapshot | null): number | null {
  const status = snapshot?.['status']
  if (typeof status !== 'object' || status === null) return null
  const usage = (status as Record<string, unknown>)['usage']
  if (typeof usage !== 'object' || usage === null) return null
  const input = (usage as Record<string, unknown>)['inputTokens']
  const output = (usage as Record<string, unknown>)['outputTokens']
  if (typeof input !== 'number' || typeof output !== 'number') return null
  const total = input + output
  return Number.isFinite(total) ? total : null
}
