/**
 * 转录视口：把一段条目按**行**滚动地画在定高区域里，右侧带轮数刻度栏。
 *
 * 结构（自上而下）：
 *   [上占位 spacer] + [窗口内的条目] + [下占位 spacer]
 *   整叠内容 `flexShrink={0}` + `marginBottom={-shift}`，装在定高、`overflowY="hidden"`、
 *   `justifyContent="flex-end"` 的裁剪盒里——尾锚定 + 负 margin 就是逐行滚动（ink 按行
 *   裁切越界文本，见 `render-node-to-output.js` / `output.js`），折行也跟着走，不用自己算。
 *   spacer 让内容总高恒等于估算总行数，于是「视口顶落在第几行」就是全部滚动状态。
 *
 * 滚动状态是 **视口顶的内容行号 `top`**（null = 跟尾）而不是「距尾部多少行」：队友还在
 * 往尾部写的时候，距尾部计数会被新内容推着走——你正读到的地方会被顶下去；钉住顶行号才
 * 站得住（在顶部以上的条目已定稿、不可变，所以钉住是稳的）。
 *
 * 行高表：渲染前从上一帧量到的行里取真值（`measuredHeight`），没量过的用估算
 * （`scroll-model.estimateLines`）；内容宽度一改（刻度栏出现/消失）表就整表作废。
 * settled 条目不可变，所以量到一次就永久有效；只有 live 尾每帧重测。
 *
 * 视口行数由调用方按帧几何算好传进来（浮层是「帧行数 − 状态栏 − 浮层框架」，聊天是
 * 「帧行数 − 状态栏 − 聊天框架」），不在这里量，免得首帧拿不到数。
 *
 * @module dsc-tui/app/TranscriptViewport
 */
import { Box, Text } from 'ink'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { DOMElement } from 'ink'
import type { JSX, ReactNode } from 'react'
import type { TranscriptEntry } from '../contract.js'
import { measuredHeight, type RegisterClick } from './click.js'
import {
  activeTurnIndex,
  anchorAtRow,
  estimateLines,
  HeightCache,
  layoutViewport,
  railEligible,
  railGeometry,
  RAIL_MIN_COLUMNS,
  RAIL_WIDTH,
  rowOfAnchor,
  turnJumpTarget,
  type ScrollAnchor,
  type TurnMark,
  type ViewportLayout,
} from './scroll-model.js'
import { TimelineRail } from './TimelineRail.js'
import { GAP, INDENT, TEXT } from './theme.js'

/** 流头部（聊天区的欢迎块）在行高表里的哨兵 id——它不是真条目，但占行、要参与排版。 */
const LEADING_ID = -1_000_000

/** 一次滚轮 = 几行（终端一格滚轮不分行，三行是「一格看得出动了」的最小值）。 */
export const WHEEL_LINES = 3

/** 视口对外的手柄：App 的键位与鼠标处理打这里（视口自己持有滚动状态）。 */
export interface TranscriptViewportApi {
  /** 按行滚：正数往上（看更早的）。 */
  scrollLines: (delta: number) => void
  /** 跳到上/下一轮。 */
  jumpTurn: (direction: 'up' | 'down') => void
  /** 跳到指定轮。 */
  jumpToTurn: (index: number) => void
  /** 回到底部（跟尾）。 */
  toTail: () => void
  /** 翻一页的行数（一屏减一行；视口行数自己量的，调用方不必知道）。 */
  page: () => number
  /** 是不是贴着最新。 */
  atTail: () => boolean
  /** 当前这份布局（测试与探针读）。 */
  layout: () => ViewportLayout | null
}

export interface TranscriptViewportProps {
  /** 全量条目（顺序即时间序）。 */
  entries: TranscriptEntry[]
  /** 没画刻度栏时可用的内容宽度（列）——调用方按帧几何扣掉边框与内边距。 */
  maxWidth: number
  /**
   * 视口行数。省略 = **自己量**（聊天区下面是会变高的卡片与输入区，算不出固定值）：
   * 先用一个宽松的默认值起排（尾锚定不受它影响，画面本来就是对的），量到真值后重排一次。
   */
  viewportLines?: number
  /** 终端总列数（刻度栏门槛与它自己占的列数用）。 */
  columns: number
  /**
   * 刻度栏**居中**用的高度（省略 = 视口行数）。视口行数会随页脚变（「回到底部」胶囊、
   * 草稿行数），按它居中会让整块刻度每滚一下挪一格；调用方传一个「只在终端改变尺寸时才变」
   * 的高度（聊天区是「帧高 − 状态栏」），刻度栏就静止了。
   */
  railCenterLines?: number
  /**
   * 思考块当前是不是展开的：只影响**没量到过的**条目的行数估算（一条思考块展开态十几行、
   * 折叠态只画两行）。估错了会连带「跳过段」的高度一起错，表现出来就是「滚轮前几格不动、
   * 再滚一下弹回底部」。
   */
  expandThinking?: boolean
  /** 一条条目怎么画。 */
  renderEntry: (entry: TranscriptEntry) => ReactNode
  /** 画不画右侧刻度栏（浮层画；窄屏由 `railEligible` 再判一次）。 */
  showRail?: boolean
  registerClick?: RegisterClick
  /** 「是不是贴着最新」变化时回调（聊天那颗回到底部的胶囊用）。 */
  onAtTailChange?: (atTail: boolean) => void
  /** 没有条目时的占位文案。 */
  emptyHint?: string
  /**
   * 挂在**流最顶上**的块（聊天区的启动欢迎页）：随内容一起从顶上滚走，所以它是流里的
   * 第一个「条目」（占行、参与行高表），不是固定表头。
   */
  leading?: ReactNode
  /** 视口顶部固定的内容（浮层标题行这类，不参与滚动）。 */
  header?: (layout: ViewportLayout) => ReactNode
  /**
   * **浮在视口第一行上**的钉住块（聊天的「当前轮题面」）：零高容器 + 负 `marginTop`，压在
   * 内容第一行上，而不是挤掉一行。
   *
   * 为什么不占一行（两条都是用户报过的）：占一行会改内容坐标——同样格数滚上去再滚回来就差
   * 一行到不了底；也会把右侧刻度栏整体推下去一格（「上下滑动时刻度会上下晃」）。浮上去之后
   * 视口、刻度、滚动坐标全部不动，代价是**可见内容少一行**（与 dsh 挤掉一行的观感一致）。
   *
   * 只有滚离尾部（`top !== null`）时才给「当前轮」；第三参是正文列宽（盖满第一行用）。
   */
  pinned?: (active: TurnMark, layout: ViewportLayout, width: number) => ReactNode
  /** 视口底部固定的内容（提示行、回到底部胶囊）。 */
  footer?: ReactNode
}

export const TranscriptViewport = forwardRef<TranscriptViewportApi, TranscriptViewportProps>(
  function TranscriptViewport(
    { entries, maxWidth, viewportLines, columns, railCenterLines, expandThinking, renderEntry, showRail = false, registerClick, onAtTailChange, emptyHint, leading, header, pinned, footer },
    ref,
  ): JSX.Element {
    /** 视口顶的**内容锚点**（哪一条的第几行）；null = 跟尾（新内容长出来就一直跟着尾巴）。 */
    const [anchor, setAnchor] = useState<ScrollAnchor | null>(null)
    /** 自己量到的裁剪盒高度（`viewportLines` 省略时用；`flexGrow` 撑出来的高度量不到就先用默认）。 */
    const [selfLines, setSelfLines] = useState(0)
    const boxRef = useRef<DOMElement | null>(null)
    const lines = viewportLines ?? (selfLines > 0 ? selfLines : 30)
    /** 行高表（宽度变了自动作废）。 */
    const heights = useRef<HeightCache>(new HeightCache()).current
    const nodes = useRef(new Map<number, DOMElement | null>())
    const atTail = useRef(true)
    /** 本轮量到「与估算不符」的条数（>0 就要按真值重排一次）。 */
    const fixups = useRef(0)

    // 流头部当成一条「伪条目」参与排版：占它的行、跟着滚，但不进窗口的 renderEntry
    const layoutEntries: TranscriptEntry[] =
      leading === undefined
        ? entries
        : [{ kind: 'system', id: LEADING_ID, text: '' } as TranscriptEntry, ...entries]
    /** id → 条目（量到真值时查它的估算值）。 */
    const byId = new Map(layoutEntries.map((entry) => [entry.id, entry]))
    /** 估算口径：必须与实际渲染口径一致（思考块展开与否差十几行）。 */
    const estimate = { expandThinking: expandThinking === true }

    // 刻度栏先按列数定「要不要给它留位」；画不画再按轮数/内容高度复核（不画就把列还给正文）
    const wantRail = showRail && columns >= RAIL_MIN_COLUMNS
    const width = Math.max(20, maxWidth - (wantRail ? RAIL_WIDTH : 0))
    heights.useWidth(width)

    // 渲染前先把上一帧量到的行数收进行高表：这一帧的布局就能用上真值。
    // （读的是上一帧的 yoga 几何——`click.ts` 的命中判定也是这么「用的时候才量」。）
    // 只有「首次量到、且与估算不符」才记一笔重排请求：纯文本条目估算本来就准，不必多排，
    // 否则流式增量（每条都要新量一次）会把提交次数拖着翻倍。
    for (const [id, node] of nodes.current) {
      const measured = measuredHeight(node)
      if (measured === null) continue
      const known = heights.get(id)
      heights.set(id, measured)
      if (known !== undefined) continue
      const entry = byId.get(id)
      if (entry !== undefined && estimateLines(entry, width, estimate) !== measured) fixups.current += 1
    }

    // 布局：锚点 → 视口顶行号 → 窗口切片与滚动量。刻度栏占不占位要按「画出来没有」
    // 复核，所以可能按两个宽度各排一次（`railOn` 为假时把 2 列还给正文，下一帧就正）。
    const measuredLayout = layoutViewport(layoutEntries, heights, { width, viewportLines: lines, anchor, ...estimate })
    const railOn =
      wantRail &&
      railEligible({
        columns,
        turnCount: measuredLayout.turns.length,
        viewportLines: lines,
        contentLines: measuredLayout.totalLines,
      })
    const layout =
      railOn || !wantRail
        ? measuredLayout
        : layoutViewport(layoutEntries, heights, { width: maxWidth, viewportLines: lines, anchor, ...estimate })
    const windowEntries = layoutEntries.slice(layout.start, layout.end)
    const turns = layout.turns
    const activeIndex = activeTurnIndex(turns, layout.shift, layout, lines)
    const viewportTop = Math.max(0, layout.totalLines - lines - layout.shift)
    // 刻度栏照 dsh：块纵向居中、两头的箭头永远画（没有目标画暗色），窗口贴尾时钉在最新。
    // 居中高度用调用方给的稳定值（视口行数会随页脚变化，按它居中会「滚动时刻度上下晃」）
    const geometry = railOn
      ? railGeometry({
          turnCount: turns.length,
          activeIndex,
          rows: lines,
          centerRows: railCenterLines,
          atBottom: layout.shift === 0,
          viewportTop,
          maxTop: layout.maxShift,
          turnTops: turns.map((turn) => turn.top),
        })
      : null
    // 轮数不够（<2 轮）或画不下就整列不画——右边空着，正文也不必让位
    const contentWidth = railOn ? width : maxWidth
    // 浮在视口第一行上的钉住块（只在滚离尾部、且真有当前轮时给）：内容坐标不动，它只是压在第一行上
    const activeTurn = turns[activeIndex]
    const pinnedNode =
      pinned === undefined || layout.top === null || activeTurn === undefined
        ? null
        : pinned(activeTurn, layout, contentWidth)

    // 手柄与夹界都读「刚画出去的那一帧」：键位/鼠标发生在帧之后，读到的是最新值
    const layoutRef = useRef(layout)
    layoutRef.current = layout
    const linesRef = useRef(lines)
    linesRef.current = lines
    /** 本帧参与排版的条目（含流头部伪条目）：滚动手柄按行号换算锚点时要查它。 */
    const layoutEntriesRef = useRef(layoutEntries)
    layoutEntriesRef.current = layoutEntries

    /**
     * 往上/往下滚 delta 行（正数 = 往更早的看）。
     *
     * 两条都踩过（用户报的「连滚不动 + 突然弹回底部」）：
     * - **必须用函数式更新**：终端把连续几格滚轮合并成一包是常态，一个任务里会连着调
     *   好几次；若每次都读「上一次渲染时的位置」来算，几次都从同一个基准起算，最后只有
     *   一格生效——五格滚轮只走三行。函数式更新拿的是累积后的最新值，几格就是几格。
     * - **行号算完立刻换成锚点**：行号是估算坐标系里的坐标，跳过段一旦被量到真值就缩水，
     *   同一个行号指的内容会变；钉成「哪一条的第几行」之后，跳过段怎么变视线都不动
     *   （见 `scroll-model.ScrollAnchor`）。
     */
    const scrollLines = useCallback((delta: number) => {
      setAnchor((previous) => {
        const current = layoutRef.current
        const entries = layoutEntriesRef.current
        const from = previous === null ? current.maxShift : rowOfAnchor(current.rows, entries, previous)
        const next = Math.max(0, Math.min(current.maxShift, from - delta))
        return anchorAtRow(current.rows, entries, next, current.maxShift)
      })
    }, [])

    const jumpToTurn = useCallback((index: number) => {
      const current = layoutRef.current
      const turn = current.turns[index]
      if (turn === undefined) return
      // 锚在那一条的第 0 行：跳轮之后跳过段再怎么量，题面都待在视口顶
      const maxTop = Math.max(0, current.totalLines - linesRef.current)
      const row = Math.min(turn.top, maxTop)
      setAnchor(anchorAtRow(current.rows, layoutEntriesRef.current, row, current.maxShift))
    }, [])

    /** 刻度悬停读数条上的题面预览（轮下标 → 该轮题面首行；读的是上一帧的布局与条目表）。 */
    const turnPreview = useCallback((turn: number): string | null => {
      const mark = layoutRef.current.turns[turn]
      const entry = mark === undefined ? undefined : layoutEntriesRef.current[mark.index]
      if (entry === undefined || entry.kind !== 'user') return null
      return entry.text.replace(/\s+/g, ' ').trim()
    }, [])

    const jumpTurn = useCallback(
      (direction: 'up' | 'down') => {
        const current = layoutRef.current
        const viewport = Math.max(0, current.totalLines - lines - current.shift)
        // 箭头的目标与刻度栏用同一条纯函数（`[`/`]` 键与点击不会给出不同的落点）
        const next = turnJumpTarget({
          turnCount: current.turns.length,
          activeIndex: activeTurnIndex(current.turns, current.shift, current, lines),
          direction,
          viewportTop: viewport,
          maxTop: current.maxShift,
          turnTops: current.turns.map((turn) => turn.top),
        })
        if (next !== null) jumpToTurn(next)
      },
      [jumpToTurn, lines],
    )

    useImperativeHandle(
      ref,
      (): TranscriptViewportApi => ({
        scrollLines,
        jumpTurn,
        jumpToTurn,
        toTail: () => setAnchor(null),
        page: () => Math.max(1, linesRef.current - 1),
        atTail: () => layoutRef.current.shift === 0,
        layout: () => layoutRef.current,
      }),
      [jumpToTurn, jumpTurn, scrollLines],
    )

    const atTailNow = layout.shift === 0
    useEffect(() => {
      if (atTail.current === atTailNow) return
      atTail.current = atTailNow
      onAtTailChange?.(atTailNow)
    }, [atTailNow, onAtTailChange])

    /**
     * 量到的真值要「落地一次」：首帧的位置全是估算出来的，排完这一帧才拿到真实行高——
     * 不重排一次，首屏就可能停在错误的行上（试过：可视区里出现半屏空占位）。
     * 签名只看「条目数 + 已量条数」，所以流式增量不会反复触发（那是同一个签名），
     * 只有「新条目进来」或「又量到一批」才多排一帧，且必然收敛。
     */
    const [, setPass] = useState(0)
    useEffect(() => {
      if (viewportLines !== undefined) return
      const measured = measuredHeight(boxRef.current)
      if (measured === null || measured === selfLines) return
      setSelfLines(measured)
    })
    useEffect(() => {
      if (fixups.current === 0) return
      fixups.current = 0
      setPass((current) => current + 1)
    })

    return (
      <Box flexDirection="column" flexGrow={1} minHeight={0}>
        {header?.(layout)}
        <Box flexDirection="row" minHeight={0} flexGrow={1}>
          <Box
            ref={boxRef}
            flexDirection="column"
            width={contentWidth}
            {...(viewportLines === undefined ? { flexGrow: 1, minHeight: 0 } : { height: viewportLines, flexShrink: 0 })}
            overflowY="hidden"
            justifyContent="flex-end"
          >
            <Box flexDirection="column" flexShrink={0} gap={GAP.none} marginBottom={-layout.shift}>
              {layout.aboveLines > 0 ? <Box height={layout.aboveLines} flexShrink={0} /> : null}
              {windowEntries.map((entry) => (
                <Box
                  key={entry.id}
                  ref={(node: DOMElement | null) => {
                    if (node === null) nodes.current.delete(entry.id)
                    else nodes.current.set(entry.id, node)
                  }}
                  flexDirection="column"
                  flexShrink={0}
                  gap={GAP.none}
                >
                  {entry.id === LEADING_ID ? leading : renderEntry(entry)}
                </Box>
              ))}
              {layout.belowLines > 0 ? <Box height={layout.belowLines} flexShrink={0} /> : null}
              {layoutEntries.length === 0 ? (
                <Box marginLeft={INDENT.detail}>
                  <Text {...TEXT.secondary}>{emptyHint ?? '（这个会话还没有条目）'}</Text>
                </Box>
              ) : null}
              {/* 钉住块：零高容器里的 1 行，负 margin 把它抬到裁剪盒第一行上（`-(行数 + 滚动量)`：
                  内容列底部的行减这么多正好是第一行）。**排在最后**才画在内容之上。 */}
              {pinnedNode === null ? null : (
                <Box height={0} flexShrink={0}>
                  <Box marginTop={-(lines + layout.shift)} flexDirection="column">
                    {pinnedNode}
                  </Box>
                </Box>
              )}
            </Box>
          </Box>
          {/* 这一列在正文**右侧**（照 dsh-TUI 的位置；用户在右边找它）：≥2 轮画轮数刻度，
              一轮的会话整列不画（没有可跳的目标，画出来只是噪音） */}
          {geometry !== null ? (
            <TimelineRail
              geometry={geometry}
              registerClick={registerClick}
              onPickTurn={jumpToTurn}
              turnText={turnPreview}
            />
          ) : null}
        </Box>
        {footer}
      </Box>
    )
  },
)
