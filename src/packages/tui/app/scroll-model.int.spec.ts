/**
 * 行滚动模型（`./scroll-model.ts`）的纯函数用例（迁自 `scripts/tui-scroll-model-test.mjs`）。
 *
 * 这一层钉的是**几何**，不是画面：`estimateLines` 数一行有多高、`layoutViewport` 算窗口
 * 切在哪、`railGeometry` 算刻度栏每一行画什么。它们都是纯函数，喂数出数，不碰 React、
 * 不碰 ink、也不碰内核——所以能一条行为一条断言地钉死。
 *
 * ## 为什么这些数值得单独一张网
 *
 * 用户报的「连滚不动 + 再滚一下突然弹回底部」「点进子代理看不到工作过程」都出在这里：
 * 行高估算与真实渲染差十几行，跳过的内容段高度就整个错位，视口顶落到别的内容上。
 * `tui-transcript-style-test.mjs` 那边用真渲染把「估算 == 真实」钉住；这边钉的是估算
 * 与布局**自己那套算术**：跟尾贴底、spacer 三段加起来必须等于总行数、锚点 ⇄ 行号往返、
 * 刻度栏块永远整块留在列里。
 *
 * ## 为什么放在 integration 而不是 unit
 *
 * 本文件主体是纯数据（几何结果），按本批的落位规则归「模块同目录」；层名按批次统一用
 * `.int.spec.ts`。它不产内核、不联网、不渲染，unit 层同样跑得动——真要更贴切可以去掉
 * `.int` 移进 unit，这里不擅自改批次约定。
 *
 * ## 迁移时砍掉的东西
 *
 * 没有。原探针 82 条断言全是纯函数读数，逐条搬成 82 个用例；`console.log('ok')` 全部
 * 换成 `expect`，`check()` 的手写技术全部去掉。
 *
 * @module dsc/packages/tui/app/scroll-model.int.spec
 */
import { describe, expect, test } from 'vitest'
import type { TranscriptEntry } from '../../../contract.js'
import {
  HeightCache,
  OVERSCAN_LINES,
  RAIL_GLYPH,
  RAIL_MIN_COLUMNS,
  activeTurnIndex,
  anchorAtRow,
  estimateLines,
  layoutViewport,
  railEligible,
  railGeometry,
  railHitRow,
  rowOfAnchor,
  shiftForTurn,
  turnJumpTarget,
  type ScrollAnchor,
} from './scroll-model.js'

/** 跟尾（没有锚点）的布局：绝大多数用例都是这个形状。 */
const TAIL = null
/** 钉在「第 index 条的第 offset 行」。 */
const at = (index: number, offset = 0): ScrollAnchor => ({ id: index + 1, index, offset })

/** 一条纯文本条目；`makeEntries` 与个别用例共用。 */
function textEntry(id: number, text: string): Extract<TranscriptEntry, { kind: 'text' }> {
  return { kind: 'text', id, text }
}

/** n 条文本条目（每条一行）。 */
function makeEntries(count: number): TranscriptEntry[] {
  return Array.from({ length: count }, (_, index) => textEntry(index + 1, `条目-${index + 1}`))
}

/** 结果原文有 14 行的工具卡：折叠态实际只画一行。 */
const TOOL_LONG: Extract<TranscriptEntry, { kind: 'tool' }> = {
  kind: 'tool',
  id: 2,
  call: {
    callId: 'c',
    name: 'browser_look',
    argsText: '{"action":"snapshot"}',
    resultText: Array.from({ length: 14 }, (_, index) => `结果第 ${index} 行`).join('\n'),
    status: 'done',
  },
}

/** 收工的子代理卡（瀑布不再画）。 */
const SUB_IDLE: Extract<TranscriptEntry, { kind: 'subagent' }> = {
  kind: 'subagent',
  id: 3,
  sub: { name: 'a', role: 'r', task: 't', state: 'idle', rounds: 1, toolCalls: 2, outputLines: ['一', '二', '三'] },
}

/** 跑动中、还没有当前工具的子代理卡 = 标题 + 3 行瀑布。 */
const SUB_WORKING: Extract<TranscriptEntry, { kind: 'subagent' }> = {
  kind: 'subagent',
  id: 3,
  sub: { name: 'a', role: 'r', task: 't', state: 'working', rounds: 1, toolCalls: 2, outputLines: ['一'] },
}

/** 九段推理的思考块（折叠态与正文长短无关）。 */
const THINK_LONG: Extract<TranscriptEntry, { kind: 'thinking' }> = {
  kind: 'thinking',
  id: 4,
  text: Array.from({ length: 9 }, (_, index) => `第 ${index} 段推理`).join('\n'),
}

describe('① estimateLines：没量过的条目按折叠态实际画几行', () => {
  test('空文本按 0 行（markdown 空块表不占行）', () => {
    // 「直播尾还没吐字」的那一帧就是一条空 text 条目；按 1 行估会让整叠内容比真实高一行。
    expect(estimateLines(textEntry(1, ''), 40)).toBe(0)
  })

  test('CJK 按 2 列折算：20 个汉字（40 列）正好 1 行', () => {
    expect(estimateLines(textEntry(1, '汉字'.repeat(10)), 40)).toBe(1)
  })

  test('超宽就折行：40 个汉字（80 列）在 40 列里占 2 行', () => {
    expect(estimateLines(textEntry(1, '汉字'.repeat(20)), 40)).toBe(2)
  })

  test('换行符各自计数', () => {
    expect(estimateLines(textEntry(1, '一行\n二行\n三行'), 40)).toBe(3)
  })

  test('工具卡恒按折叠态估 1 行（旧口径 4 行 / 更早 16 行）', () => {
    // 结果原文十四行，卡片折叠态只画一行；按原文数会让一屏十几张卡虚高两百行。
    expect(estimateLines(TOOL_LONG, 80)).toBe(1)
  })

  test('工具卡没有结果时同样 1 行', () => {
    expect(estimateLines({ ...TOOL_LONG, call: { ...TOOL_LONG.call, resultText: '' } }, 80)).toBe(1)
  })

  test('子代理卡收工后只有标题 1 行（瀑布不再画）', () => {
    expect(estimateLines(SUB_IDLE, 80)).toBe(1)
  })

  test('子代理卡跑动中（还没工具）= 标题 + 3 行瀑布（= 4）', () => {
    expect(estimateLines(SUB_WORKING, 80)).toBe(4)
  })

  test('子代理卡跑动中（有工具）= 再多一行当前工具（= 5）', () => {
    expect(
      estimateLines({ ...SUB_WORKING, sub: { ...SUB_WORKING.sub, lastTool: { name: 'read', args: 'a.ts', status: 'running' } } }, 80),
    ).toBe(5)
  })

  test('思考块折叠 = 标签 1 行 + 恒定 3 行瀑布', () => {
    expect(estimateLines(THINK_LONG, 80)).toBe(4)
  })

  test('思考块折叠：极窄的框也是 4 行（硬截不折行）', () => {
    // 瀑布每行硬截到框宽，所以行数与宽度无关——框一变宽行数就变，曾让估算忽高忽低。
    expect(estimateLines(THINK_LONG, 12)).toBe(4)
  })

  test('思考块折叠：空正文只有标签一行', () => {
    expect(estimateLines({ kind: 'thinking', id: 5, text: '' }, 80)).toBe(1)
  })

  test('思考块展开 = 标签 1 行 + 全文 9 行（估算跟着渲染口径走）', () => {
    expect(estimateLines(THINK_LONG, 80, { expandThinking: true })).toBe(10)
  })

  test('题面含前面那行空（与 ChatView 的 USER_TOP_GAP 同口径）', () => {
    expect(estimateLines({ kind: 'user', id: 5, text: '问题' }, 80)).toBe(2)
  })

  test('队友汇报那条不占额外的空行', () => {
    expect(estimateLines({ kind: 'user', id: 6, text: '汇报', internal: true }, 80)).toBe(1)
  })

  test('计划卡 = 标题 1 行 + 文件 1 行（不是「正文 + 2 行边框」）', () => {
    expect(estimateLines({ kind: 'plan', id: 7, plan: { file: '/w/p.md', title: '计划', text: '正文', decision: 'pending' } }, 40)).toBe(2)
  })
})

describe('② layoutViewport：窗口切在哪、占位多高、从尾往上退几行', () => {
  test('跟尾：窗口一直装到最后一条', () => {
    const entries = makeEntries(10)
    const heights = new HeightCache()
    heights.useWidth(80)
    for (const entry of entries) heights.set(entry.id, 2)
    const layout = layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: TAIL })
    expect(layout.end).toBe(10)
  })

  test('总行数 = 真实行数之和', () => {
    const entries = makeEntries(10)
    const heights = new HeightCache()
    heights.useWidth(80)
    for (const entry of entries) heights.set(entry.id, 2)
    expect(layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: TAIL }).totalLines).toBe(20)
  })

  test('spacer 三段相加恒等于总行数', () => {
    // 这条不成立，屏幕就会「少一行」或多出一片空白。
    const entries = makeEntries(10)
    const heights = new HeightCache()
    heights.useWidth(80)
    for (const entry of entries) heights.set(entry.id, 2)
    const layout = layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: TAIL })
    expect(layout.aboveLines + (layout.end - layout.start) * 2 + layout.belowLines).toBe(layout.totalLines)
  })

  test('窗口覆盖视口（上占位留出 overscan）', () => {
    const entries = makeEntries(10)
    const heights = new HeightCache()
    heights.useWidth(80)
    for (const entry of entries) heights.set(entry.id, 2)
    // 视口顶行 = 20 − 6 = 14，上占位（6）比它少 8 行 = overscan
    expect(layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: TAIL }).aboveLines).toBe(6)
  })

  test('尾部布局的 shift 是 0（跟尾）', () => {
    const entries = makeEntries(10)
    const heights = new HeightCache()
    heights.useWidth(80)
    for (const entry of entries) heights.set(entry.id, 2)
    expect(layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: TAIL }).shift).toBe(0)
  })

  test('跟尾时解析出来的 top 是 null（锚点语义：没有钉住哪一条）', () => {
    const entries = makeEntries(10)
    const heights = new HeightCache()
    heights.useWidth(80)
    for (const entry of entries) heights.set(entry.id, 2)
    expect(layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: TAIL }).top).toBeNull()
  })

  test('maxShift = 总行数 − 视口行数', () => {
    const entries = makeEntries(10)
    const heights = new HeightCache()
    heights.useWidth(80)
    for (const entry of entries) heights.set(entry.id, 2)
    expect(layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: TAIL }).maxShift).toBe(14)
  })

  test('窗口下方没有内容（贴尾）', () => {
    const entries = makeEntries(10)
    const heights = new HeightCache()
    heights.useWidth(80)
    for (const entry of entries) heights.set(entry.id, 2)
    expect(layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: TAIL }).belowLines).toBe(0)
  })

  test('长会话的窗口有界（192 条只装视口附近那些）', () => {
    const entries = makeEntries(192)
    const heights = new HeightCache()
    heights.useWidth(80)
    const layout = layoutViewport(entries, heights, { width: 80, viewportLines: 20, anchor: TAIL })
    const windowSize = layout.end - layout.start
    // 窗口 = 视口(20) + 上下 overscan(8×2) 行；每条至少 1 行 → 条数有上界。
    expect(windowSize).toBeLessThanOrEqual(20 + 2 * OVERSCAN_LINES)
  })

  test('长会话：上占位 + 窗口 + 下占位 = 总行数（三段拆得干净）', () => {
    const entries = makeEntries(192)
    const heights = new HeightCache()
    heights.useWidth(80)
    const layout = layoutViewport(entries, heights, { width: 80, viewportLines: 20, anchor: TAIL })
    const windowSize = layout.end - layout.start
    expect(layout.aboveLines + windowSize + layout.belowLines).toBe(layout.totalLines)
  })

  test('钉住第 4 条第 1 行（内容第 9 行）→ shift = 14 − 9 = 5', () => {
    const entries = makeEntries(10)
    const heights = new HeightCache()
    heights.useWidth(80)
    for (const entry of entries) heights.set(entry.id, 2)
    const tail = layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: TAIL })
    const up3 = layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: at(4, 1) })
    expect(up3.shift).toBe(5)
    expect(tail.shift).toBe(0)
  })

  test('解析出来的 top = 锚点所在的内容行号', () => {
    const entries = makeEntries(10)
    const heights = new HeightCache()
    heights.useWidth(80)
    for (const entry of entries) heights.set(entry.id, 2)
    expect(layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: at(4, 1) }).top).toBe(9)
  })

  test('钉住之后窗口仍盖住视口', () => {
    const entries = makeEntries(10)
    const heights = new HeightCache()
    heights.useWidth(80)
    for (const entry of entries) heights.set(entry.id, 2)
    const up3 = layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: at(4, 1) })
    expect(up3.aboveLines + (up3.end - up3.start) * 2).toBeGreaterThanOrEqual(up3.totalLines - 6 - 6)
  })

  test('锚点顶过尾部 → 就是跟尾（不是顶出一片空白）', () => {
    const entries = makeEntries(10)
    const heights = new HeightCache()
    heights.useWidth(80)
    for (const entry of entries) heights.set(entry.id, 2)
    expect(layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: at(9, 1) }).shift).toBe(0)
  })

  test('锚点行号超过 maxShift 会夹回尾部（不顶出空白）', () => {
    const entries = makeEntries(10)
    const heights = new HeightCache()
    heights.useWidth(80)
    for (const entry of entries) heights.set(entry.id, 2)
    expect(layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: at(8, 1) }).shift).toBe(0)
  })

  test('一屏装得下时 maxShift = 0 且窗口是全篇', () => {
    const short = layoutViewport(makeEntries(2), new HeightCache(), { width: 80, viewportLines: 20, anchor: TAIL })
    expect(short.maxShift).toBe(0)
    expect(short.start).toBe(0)
    expect(short.end).toBe(2)
  })
})

describe('②b 锚点 ⇄ 行号的往返（修「连滚弹回底部」的机制）', () => {
  test('行号 → 锚点：第 0 行落在第 0 条第 0 行', () => {
    const entries = makeEntries(10)
    const rows = entries.map(() => 2)
    expect(anchorAtRow(rows, entries, 0, 14)).toEqual({ id: 1, index: 0, offset: 0 })
  })

  test('行号 → 锚点：第 9 行落在第 4 条第 1 行', () => {
    const entries = makeEntries(10)
    const rows = entries.map(() => 2)
    expect(anchorAtRow(rows, entries, 9, 14)).toEqual({ id: 5, index: 4, offset: 1 })
  })

  test('行号到/过尾部 → 锚点是 null（跟尾）', () => {
    const entries = makeEntries(10)
    const rows = entries.map(() => 2)
    expect(anchorAtRow(rows, entries, 14, 14)).toBeNull()
    expect(anchorAtRow(rows, entries, 99, 14)).toBeNull()
  })

  test('锚点 → 行号：往返一致', () => {
    const entries = makeEntries(10)
    const rows = entries.map(() => 2)
    expect(rowOfAnchor(rows, entries, anchorAtRow(rows, entries, 9, 14)!)).toBe(9)
  })

  test('锚点还在，但长度变了 → 同一个锚点指的还是同一条（行号跟着变，视线不动）', () => {
    const entries = makeEntries(10)
    expect(rowOfAnchor([2, 2, 5, 2, 2, 2, 2, 2, 2, 2], entries, { id: 3, index: 2, offset: 1 })).toBe(5)
  })

  test('下标失效（条目顺序变了）时按 id 重新找', () => {
    const entries = makeEntries(10)
    const rows = entries.map(() => 2)
    expect(rowOfAnchor(rows, entries, { id: 5, index: 0, offset: 1 })).toBe(9)
  })

  test('条目没了（切会话/压缩）→ 给出一个越界行号，调用方夹回尾部', () => {
    const entries = makeEntries(10)
    const rows = entries.map(() => 2)
    expect(rowOfAnchor(rows, entries, { id: 999, index: 0, offset: 0 })).toBeGreaterThan(1000)
  })

  test('行高表按 id 存真值', () => {
    const heights = new HeightCache()
    heights.useWidth(80)
    heights.set(1, 9)
    expect(heights.get(1)).toBe(9)
    expect(heights.size).toBe(1)
  })

  test('宽度变了行高表作废（折行重算）', () => {
    const heights = new HeightCache()
    heights.useWidth(80)
    heights.set(1, 9)
    heights.useWidth(60)
    expect(heights.size).toBe(0)
  })
})

describe('③ 轮位置与跳转', () => {
  /** 两条真轮 + 一条插话（算一轮）+ 一条队友汇报（不算）+ 一条通知。 */
  const TURN_ENTRIES: TranscriptEntry[] = [
    { kind: 'user', id: 1, text: '第一问' },
    { kind: 'text', id: 2, text: '答' },
    { kind: 'user', id: 3, text: '插话', steering: true },
    { kind: 'text', id: 4, text: '答' },
    { kind: 'user', id: 5, text: '队友汇报', internal: true },
    { kind: 'system', id: 6, text: '通知' },
  ]

  /** 每条 3 行、视口 4 行的布局。 */
  function turnLayout(): ReturnType<typeof layoutViewport> {
    const heights = new HeightCache()
    heights.useWidth(80)
    for (const entry of TURN_ENTRIES) heights.set(entry.id, 3)
    return layoutViewport(TURN_ENTRIES, heights, { width: 80, viewportLines: 4, anchor: TAIL })
  }

  test('一轮 = 一条非内部用户消息（插话算、队友汇报不算）', () => {
    const turns = turnLayout().turns
    expect(turns).toHaveLength(2)
    expect(turns[0]?.id).toBe(1)
    expect(turns[1]?.id).toBe(3)
  })

  test('轮的 top 是内容行坐标（第 0 轮 = 0，第 1 轮 = 6 = 前两条各 3 行）', () => {
    const turns = turnLayout().turns
    expect(turns.map((turn) => turn.top)).toEqual([0, 6])
  })

  test('跳第一轮：shift = 总行数 − 视口行数（顶到头）', () => {
    const layout = turnLayout()
    expect(shiftForTurn(layout.turns[0]!, layout, 4)).toBe(layout.maxShift)
  })

  test('跳第二轮：那一轮正好落在视口顶上', () => {
    const layout = turnLayout()
    expect(shiftForTurn(layout.turns[1]!, layout, 4)).toBe(layout.totalLines - 4 - 6)
  })

  test('跟尾时当前轮 = 最后一轮', () => {
    const layout = turnLayout()
    expect(activeTurnIndex(layout.turns, 0, layout, 4)).toBe(1)
  })

  test('顶到头时当前轮 = 第一轮', () => {
    const layout = turnLayout()
    expect(activeTurnIndex(layout.turns, layout.maxShift, layout, 4)).toBe(0)
  })
})

describe('④ 刻度栏几何（照 dsh-TUI）', () => {
  test('窄于 60 列不画', () => {
    expect(railEligible({ columns: RAIL_MIN_COLUMNS - 1, turnCount: 5, viewportLines: 20, contentLines: 200 })).toBe(false)
  })

  test('只有一轮不画', () => {
    expect(railEligible({ columns: 100, turnCount: 1, viewportLines: 20, contentLines: 200 })).toBe(false)
  })

  test('一屏装得下不画', () => {
    expect(railEligible({ columns: 100, turnCount: 5, viewportLines: 200, contentLines: 200 })).toBe(false)
  })

  test('够条件才画', () => {
    expect(railEligible({ columns: 100, turnCount: 5, viewportLines: 20, contentLines: 200 })).toBe(true)
  })

  test('字形照 dsh：活动重线 / 静止短线 / 箭头小三角', () => {
    expect(RAIL_GLYPH).toEqual({ active: '━━', idle: ' ─', up: ' ▴', down: ' ▾' })
  })

  test('列高少一行（页脚多一行）：块的上下边界一动不动', () => {
    // 居中高度与列高分开：按会变的可用高度居中的话，一滚动整块就上下挪一格。
    const stable = railGeometry({ turnCount: 6, activeIndex: 5, rows: 33, centerRows: 39, atBottom: true })
    const shrunk = railGeometry({ turnCount: 6, activeIndex: 5, rows: 32, centerRows: 39, atBottom: true })
    expect(stable.upRow).toBe(shrunk.upRow)
    expect(stable.downRow).toBe(shrunk.downRow)
  })

  test('块仍留在列里（居中高度比列高大，也要夹住）', () => {
    const stable = railGeometry({ turnCount: 6, activeIndex: 5, rows: 33, centerRows: 39, atBottom: true })
    expect(stable.upRow).toBeGreaterThanOrEqual(0)
    expect(stable.downRow).toBeLessThan(33)
  })

  test('块比列矮不了几行时夹到 0（不溢出、▼ 不被裁）', () => {
    const tall = railGeometry({ turnCount: 40, activeIndex: 0, rows: 10, centerRows: 39 })
    expect(tall.upRow).toBe(0)
    expect(tall.downRow).toBe(9)
    expect(tall.rows.filter((row) => row !== null)).toHaveLength(10)
  })

  test('26 行 8 轮：块居中（▲ 8、刻度 9..16、▼ 17）', () => {
    const geometry = railGeometry({ turnCount: 8, activeIndex: 3, rows: 26 })
    expect(geometry.upRow).toBe(8)
    expect(geometry.tickTop).toBe(9)
    expect(geometry.downRow).toBe(17)
  })

  test('轮数 < 2 时整列空（与 dsh 的 null 同义）', () => {
    expect(railGeometry({ turnCount: 1, activeIndex: 0, rows: 26 }).rows.every((row) => row === null)).toBe(true)
  })

  test('3 轮 10 行：每轮一格 + ▲/▼ 各一行', () => {
    const geometry = railGeometry({ turnCount: 3, activeIndex: 1, rows: 10 })
    const ticks = geometry.rows.filter((row) => row?.kind === 'tick')
    expect(ticks).toHaveLength(3)
    expect(geometry.up).toBe(0)
    expect(geometry.down).toBe(2)
  })

  test('▲ + 刻度 + ▼ 这一块纵向居中（上下留空相等或差一行）', () => {
    const geometry = railGeometry({ turnCount: 3, activeIndex: 1, rows: 10 })
    expect(geometry.upRow).toBe(2)
    expect(geometry.tickTop).toBe(3)
    expect(geometry.downRow).toBe(6)
    expect(Math.abs(geometry.upRow - (10 - 1 - geometry.downRow))).toBeLessThanOrEqual(1)
  })

  test('块以外的行是空行（首行不是箭头）', () => {
    const geometry = railGeometry({ turnCount: 3, activeIndex: 1, rows: 10 })
    expect(geometry.rows.slice(0, geometry.upRow).every((row) => row === null)).toBe(true)
    expect(geometry.rows.slice(geometry.downRow + 1).every((row) => row === null)).toBe(true)
  })

  test('当前轮在几何里标出来', () => {
    const geometry = railGeometry({ turnCount: 3, activeIndex: 1, rows: 10 })
    expect(geometry.rows.some((row) => row?.kind === 'tick' && row.active === true)).toBe(true)
  })

  test('命中判定：▲/▼ 各给 up/down、刻度行给轮下标、空行给 null', () => {
    const geometry = railGeometry({ turnCount: 3, activeIndex: 1, rows: 10 })
    expect(railHitRow(geometry, 1)).toBeNull()
    expect(railHitRow(geometry, 2)).toBe('up')
    expect(railHitRow(geometry, 3)).toBe(0)
    expect(railHitRow(geometry, 5)).toBe(2)
    expect(railHitRow(geometry, 6)).toBe('down')
    expect(railHitRow(geometry, 9)).toBeNull()
  })

  test('第一轮：▲ 照样画，只是没有目标（enabled = false）', () => {
    const geometry = railGeometry({ turnCount: 2, activeIndex: 0, rows: 10 })
    const arrow = geometry.rows[geometry.upRow]
    expect(geometry.up).toBeNull()
    expect(geometry.down).toBe(1)
    expect(arrow?.kind).toBe('up')
    expect(arrow?.kind === 'up' ? arrow.enabled : undefined).toBe(false)
  })

  test('最后一轮：▼ 照样画，只是没有目标', () => {
    const tail = railGeometry({ turnCount: 2, activeIndex: 1, rows: 10 })
    const arrow = tail.rows[tail.downRow]
    expect(tail.down).toBeNull()
    expect(tail.up).toBe(0)
    expect(arrow?.kind).toBe('down')
    expect(arrow?.kind === 'down' ? arrow.enabled : undefined).toBe(false)
  })

  test('两头的箭头都画（块高 = 轮数 + 2）', () => {
    const tail = railGeometry({ turnCount: 2, activeIndex: 1, rows: 10 })
    expect(tail.rows.filter((row) => row !== null)).toHaveLength(4)
  })

  test('轮多于行：滑窗口且最多 rows − 2 格', () => {
    const geometry = railGeometry({ turnCount: 50, activeIndex: 25, rows: 12 })
    const ticks = geometry.rows.filter((row) => row?.kind === 'tick')
    expect(ticks).toHaveLength(10)
  })

  test('当前轮一定在窗口里', () => {
    const geometry = railGeometry({ turnCount: 50, activeIndex: 25, rows: 12 })
    const turns = geometry.rows.filter((row) => row?.kind === 'tick').map((row) => (row?.kind === 'tick' ? row.turn : -1))
    expect(turns).toContain(25)
  })

  test('窗口内的轮号是连续的', () => {
    const geometry = railGeometry({ turnCount: 50, activeIndex: 25, rows: 12 })
    const ticks = geometry.rows.filter((row) => row?.kind === 'tick').map((row) => (row?.kind === 'tick' ? row.turn : -1))
    expect(ticks.every((turn, index) => index === 0 || turn === ticks[index - 1]! + 1)).toBe(true)
  })

  test('贴头时窗口从第 0 轮起', () => {
    const head = railGeometry({ turnCount: 50, activeIndex: 0, rows: 12 })
    const first = head.rows.find((row) => row?.kind === 'tick')
    expect(head.windowStart).toBe(0)
    expect(first?.kind === 'tick' ? first.turn : -1).toBe(0)
  })

  test('贴尾时窗口钉住最新（到第 49 轮止）', () => {
    const foot = railGeometry({ turnCount: 50, activeIndex: 49, rows: 12, atBottom: true })
    const ticks = foot.rows.filter((row) => row?.kind === 'tick')
    const last = ticks[ticks.length - 1]
    expect(foot.windowEnd).toBe(50)
    expect(last?.kind === 'tick' ? last.turn : -1).toBe(49)
  })

  test('窗口永不含错位的活动刻度（活动那格一定在窗口内）', () => {
    const foot = railGeometry({ turnCount: 50, activeIndex: 49, rows: 12, atBottom: true })
    expect(foot.rows.some((row) => row?.kind === 'tick' && row.active === true)).toBe(true)
  })

  test('列高不够（3 行以下没有格子）时整列空', () => {
    expect(railGeometry({ turnCount: 9, activeIndex: 0, rows: 2 }).rows.every((row) => row === null)).toBe(true)
  })

  test('OVERSCAN_LINES 是正数（窗口上下各留一点）', () => {
    expect(OVERSCAN_LINES).toBeGreaterThan(0)
  })
})

describe('⑤ 箭头目标（turnJumpTarget）', () => {
  /** 四轮的顶行号：0 / 20 / 60 / 90；能滚到的最大顶行号 200。 */
  const BASE = { turnCount: 4, turnTops: [0, 20, 60, 90], maxTop: 200 }

  test('读到本轮中段：▲ 先对齐本轮的题面', () => {
    expect(turnJumpTarget({ ...BASE, activeIndex: 2, viewportTop: 70, direction: 'up' })).toBe(2)
  })

  test('题面已在视口顶之上：▲ 退到上一轮', () => {
    expect(turnJumpTarget({ ...BASE, activeIndex: 2, viewportTop: 60, direction: 'up' })).toBe(1)
  })

  test('第一轮题面就在视口顶：▲ 没有目标', () => {
    expect(turnJumpTarget({ ...BASE, activeIndex: 0, viewportTop: 0, direction: 'up' })).toBeNull()
  })

  test('▼ 给下一轮', () => {
    expect(turnJumpTarget({ ...BASE, activeIndex: 1, viewportTop: 20, direction: 'down' })).toBe(2)
  })

  test('最后一轮：▼ 没有目标', () => {
    expect(turnJumpTarget({ ...BASE, activeIndex: 3, viewportTop: 90, direction: 'down' })).toBeNull()
  })

  test('够不着视口顶的下一轮：▼ 没有目标（暗箭头 = 空操作）', () => {
    // 给了目标却滚不到，点下去没反应、箭头还亮着——按几次都不动，比不亮更糟。
    expect(turnJumpTarget({ turnCount: 2, turnTops: [0, 150], maxTop: 120, activeIndex: 0, viewportTop: 0, direction: 'down' })).toBeNull()
  })

  test('够得着就是目标（150 → 160 可达）', () => {
    expect(turnJumpTarget({ turnCount: 2, turnTops: [0, 150], maxTop: 160, activeIndex: 0, viewportTop: 0, direction: 'down' })).toBe(1)
  })

  test('没有轮时两个方向都没目标', () => {
    expect(turnJumpTarget({ turnCount: 0, activeIndex: 0, direction: 'up' })).toBeNull()
    expect(turnJumpTarget({ turnCount: 0, activeIndex: 0, direction: 'down' })).toBeNull()
  })

  test('缺每轮顶行号时退回「当前轮 ± 1」', () => {
    expect(turnJumpTarget({ turnCount: 3, activeIndex: 1, direction: 'up' })).toBe(0)
    expect(turnJumpTarget({ turnCount: 3, activeIndex: 1, direction: 'down' })).toBe(2)
  })
})
