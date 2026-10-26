/**
 * 行滚动模型（`src/app/scroll-model.ts`）的纯函数测试。
 *
 * 钉住的四件事：
 *   [1] 估算：没量过的条目按显示宽度数折行（CJK 记 2 列），不认识的字面量不炸；
 *   [2] 布局：跟尾时窗口贴住尾部、spacer 三段高度相加恒等于总行数、窗口**有界**
 *       （192 条里只装视口附近那些，不是全篇）、行高表宽度变了就作废；
 *   [3] 滚动量：`shift` = 从尾部往上退的行数（0 = 跟尾，夹在 [0, total-viewport]）；
 *   [4] 刻度栏（照 dsh-TUI）：一轮一格、▲ + 刻度 + ▼ 这一块纵向居中、两头箭头**永远
 *       画**（没有目标只是暗色 / 不可跳）、格子不够就滑窗口且当前轮始终在窗口里、
 *       命中判定空行返回 null；字形也在这一节。
 *   [5] 箭头目标（`turnJumpTarget`）：读到本轮中段时 ▲ 先对齐本轮题面；够不着视口顶的
 *       下一轮不名（否则点了没反应、箭头却亮着）。
 *
 * 用法：pnpm build && node scripts/tui-scroll-model-test.mjs
 *
 * @module dsc/scripts/tui-scroll-model-test
 */
const {
  HeightCache,
  estimateLines,
  layoutViewport,
  anchorAtRow,
  rowOfAnchor,
  shiftForTurn,
  activeTurnIndex,
  railEligible,
  railGeometry,
  railHitRow,
  turnJumpTarget,
  RAIL_GLYPH,
  OVERSCAN_LINES,
  RAIL_MIN_COLUMNS,
} = await import('../lib/app/scroll-model.js')

/** 跟尾（没有锚点）的布局：探针里绝大多数用例都是这个形状。 */
const TAIL = null
/** 钉在「第 index 条的第 offset 行」。 */
const at = (index, offset = 0) => ({ id: index + 1, index, offset })

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log('行滚动模型测试')

// ── [1] 估算 ────────────────────────────────────────────────────────────────
console.log('\n[1] estimateLines')
// 空正文必须是 0 行：`MarkdownView` 对空串不产出任何行（「直播尾还没吐字」的那一帧）
check('空文本按 0 行（markdown 空块表不占行）', estimateLines({ kind: 'text', id: 1, text: '' }, 40) === 0, JSON.stringify(estimateLines({ kind: 'text', id: 1, text: '' }, 40)))
check(
  'CJK 按 2 列折算：20 个汉字（40 列）正好 1 行',
  estimateLines({ kind: 'text', id: 1, text: '汉字'.repeat(10) }, 40) === 1,
  String(estimateLines({ kind: 'text', id: 1, text: '汉字'.repeat(10) }, 40)),
)
check(
  '超宽就折行：40 个汉字（80 列）在 40 列里占 2 行',
  estimateLines({ kind: 'text', id: 1, text: '汉字'.repeat(20) }, 40) === 2,
  String(estimateLines({ kind: 'text', id: 1, text: '汉字'.repeat(20) }, 40)),
)
check(
  '换行符各自计数',
  estimateLines({ kind: 'text', id: 1, text: '一行\n二行\n三行' }, 40) === 3,
  String(estimateLines({ kind: 'text', id: 1, text: '一行\n二行\n三行' }, 40)),
)
// 卡片类按**折叠态实际画几行**估：曾经按最长字段数折行，工具卡一张就虚高十几行，
// 滚到那段时坐标整体缩水 —— 用户报的「连滚不动 + 突然弹回底部」。
const TOOL_LONG = {
  kind: 'tool',
  id: 2,
  call: {
    callId: 'c',
    name: 'browser_look',
    argsText: '{"action":"snapshot"}',
    resultText: Array.from({ length: 14 }, (_, i) => `结果第 ${i} 行`).join('\n'),
    status: 'done',
  },
}
// 工具行现在**默认折叠成一行**（「⚙ 调用 xx 工具 · 状态」），参数与结果点开才给——
// 展开是手动触发的少数情形，估算按折叠态；旧口径（1 + 200 字摘要折行 = 4 行、更早按
// 结果原文数 16 行）都随渲染形态退役。
check('工具卡恒按折叠态估 1 行（旧口径 4 行 / 更早 16 行）', estimateLines(TOOL_LONG, 80) === 1, String(estimateLines(TOOL_LONG, 80)))
check(
  '工具卡没有结果时同样 1 行',
  estimateLines({ ...TOOL_LONG, call: { ...TOOL_LONG.call, resultText: '' } }, 80) === 1,
  String(estimateLines({ ...TOOL_LONG, call: { ...TOOL_LONG.call, resultText: '' } }, 80)),
)
check(
  '子代理卡收工后只有标题 1 行（瀑布不再画）',
  estimateLines({ kind: 'subagent', id: 3, sub: { name: 'a', role: 'r', task: 't', state: 'idle', rounds: 1, toolCalls: 2, outputLines: ['一', '二', '三'] } }, 80) === 1,
  String(estimateLines({ kind: 'subagent', id: 3, sub: { name: 'a', role: 'r', task: 't', state: 'idle', rounds: 1, toolCalls: 2, outputLines: ['一', '二', '三'] } }, 80)),
)
// 跑动中 = 标题 + 3 行瀑布；**当前工具行只在真有工具在跑时才画**（渲染器是
// `sub.lastTool !== undefined` 才挂那一行）——估算必须跟着这个条件走，否则又差一行
const WORKING_SUB = { kind: 'subagent', id: 3, sub: { name: 'a', role: 'r', task: 't', state: 'working', rounds: 1, toolCalls: 2, outputLines: ['一'] } }
check('子代理卡跑动中（还没工具）= 标题 + 3 行瀑布（= 4）', estimateLines(WORKING_SUB, 80) === 4, String(estimateLines(WORKING_SUB, 80)))
check(
  '子代理卡跑动中（有工具）= 再多一行当前工具（= 5）',
  estimateLines({ ...WORKING_SUB, sub: { ...WORKING_SUB.sub, lastTool: { name: 'read', args: 'a.ts', status: 'running' } } }, 80) === 5,
  String(estimateLines({ ...WORKING_SUB, sub: { ...WORKING_SUB.sub, lastTool: { name: 'read', args: 'a.ts', status: 'running' } } }, 80)),
)
const THINK_LONG = { kind: 'thinking', id: 4, text: Array.from({ length: 9 }, (_, i) => `第 ${i} 段推理`).join('\n') }
// 折叠态 = 标签 1 行 + **恒定 3 行瀑布**（照 dsh 的 preview ticker：每行硬截、不折行）——
// 行数与正文长短、框宽都无关（此前是「压成一行预览再折行」，框一变宽行数就变，正是
// 「跳过段估算忽高忽低」的来源之一）。
check('思考块折叠 = 标签 1 行 + 恒定 3 行瀑布', estimateLines(THINK_LONG, 80) === 4, String(estimateLines(THINK_LONG, 80)))
check('思考块折叠：极窄的框也是 4 行（硬截不折行）', estimateLines(THINK_LONG, 12) === 4, String(estimateLines(THINK_LONG, 12)))
check('思考块折叠：空正文只有标签一行', estimateLines({ kind: 'thinking', id: 5, text: '' }, 80) === 1, String(estimateLines({ kind: 'thinking', id: 5, text: '' }, 80)))
check(
  '思考块展开 = 标签 1 行 + 全文 9 行（估算跟着渲染口径走）',
  estimateLines(THINK_LONG, 80, { expandThinking: true }) === 10,
  String(estimateLines(THINK_LONG, 80, { expandThinking: true })),
)
check('题面含前面那行空（与 ChatView 的 USER_TOP_GAP 同口径）', estimateLines({ kind: 'user', id: 5, text: '问题' }, 80) === 2, String(estimateLines({ kind: 'user', id: 5, text: '问题' }, 80)))
check('队友汇报那条不占额外的空行', estimateLines({ kind: 'user', id: 6, text: '汇报', internal: true }, 80) === 1, String(estimateLines({ kind: 'user', id: 6, text: '汇报', internal: true }, 80)))
check('计划卡 = 标题 1 行 + 文件 1 行（不是「正文 + 2 行边框」）', estimateLines({ kind: 'plan', id: 7, plan: {} }, 40) === 2, String(estimateLines({ kind: 'plan', id: 7, plan: {} }, 40)))

// ── [2] 布局 ────────────────────────────────────────────────────────────────
console.log('\n[2] layoutViewport')
const makeEntries = (count) =>
  Array.from({ length: count }, (_, i) => ({ kind: 'text', id: i + 1, text: `条目-${i + 1}` }))

{
  const entries = makeEntries(10)
  const heights = new HeightCache()
  heights.useWidth(80)
  for (const entry of entries) heights.set(entry.id, 2) // 每条实测量到 2 行
  const layout = layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: TAIL })
  check('跟尾：窗口一直装到最后一条', layout.end === 10, JSON.stringify([layout.start, layout.end]))
  check('总行数 = 真实行数之和', layout.totalLines === 20, String(layout.totalLines))
  check('spacer 三段相加恒等于总行数', layout.aboveLines + (layout.end - layout.start) * 2 + layout.belowLines === layout.totalLines, JSON.stringify([layout.aboveLines, layout.belowLines]))
  // 视口顶行 = 20 − 6 = 14，上占位（6）比它少 8 行 = overscan，窗口覆盖得住
  check('窗口覆盖视口（上占位留出 overscan）', layout.aboveLines === 6, String(layout.aboveLines))
  check('尾部布局的 shift 是 0（跟尾）', layout.shift === 0)
  check('跟尾时解析出来的 top 是 null（锚点语义：没有钉住哪一条）', layout.top === null)
  check('maxShift = 总行数 − 视口行数', layout.maxShift === 14, String(layout.maxShift))
  check('窗口下方没有内容（贴尾）', layout.belowLines === 0)
}
{
  const entries = makeEntries(192)
  const heights = new HeightCache()
  heights.useWidth(80)
  const layout = layoutViewport(entries, heights, { width: 80, viewportLines: 20, anchor: TAIL })
  const windowSize = layout.end - layout.start
  // 窗口 = 视口(20) + 上下 overscan(8×2) 行；每条至少 1 行 → 条数有上界
  check(
    `长会话的窗口有界（192 条只装 ${windowSize} 条）`,
    windowSize <= 20 + 2 * OVERSCAN_LINES,
    String(windowSize),
  )
  check(
    '上占位 + 窗口 + 下占位 = 总行数（三段拆得干净）',
    layout.aboveLines + windowSize + layout.belowLines === layout.totalLines,
    JSON.stringify([layout.aboveLines, windowSize, layout.belowLines, layout.totalLines]),
  )
}
{
  const entries = makeEntries(10)
  const heights = new HeightCache()
  heights.useWidth(80)
  for (const entry of entries) heights.set(entry.id, 2)
  const tail = layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: TAIL })
  // 第 4 条的第 1 行 = 内容第 8 行（每条 2 行）→ 视口顶 8 → 退 20 − 6 − 8 = 6 行
  const up3 = layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: at(4, 1) })
  check('钉住第 4 条第 1 行（内容第 9 行）→ shift = 14 − 9 = 5', up3.shift === 5 && tail.shift === 0, JSON.stringify([tail.shift, up3.shift]))
  check('解析出来的 top = 锚点所在的内容行号', up3.top === 9, String(up3.top))
  check(
    '钉住之后窗口仍盖住视口',
    up3.aboveLines + (up3.end - up3.start) * 2 >= up3.totalLines - 6 - 6,
    JSON.stringify([up3.aboveLines, up3.start, up3.end]),
  )
  // 锚点在最后一条的最后一行的**下一行**（= 尾部）→ 退化成跟尾；超出范围也一样
  check('锚点顶过尾部 → 就是跟尾（不是顶出一片空白）', layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: at(9, 1) }).shift === 0)
  check('锚点行号超过 maxShift 会夹回尾部（不顶出空白）', layoutViewport(entries, heights, { width: 80, viewportLines: 6, anchor: at(8, 1) }).shift === 0)
  const short = layoutViewport(makeEntries(2), new HeightCache(), { width: 80, viewportLines: 20, anchor: TAIL })
  check('一屏装得下时 maxShift = 0 且窗口是全篇', short.maxShift === 0 && short.start === 0 && short.end === 2, JSON.stringify(short))
}
// ── [2b] 锚点 ⇄ 行号的往返（0.7.x 修「连滚弹回底部」的机制） ────────────────
{
  const entries = makeEntries(10)
  const rows = entries.map(() => 2)
  check('行号 → 锚点：第 0 行落在第 0 条第 0 行', JSON.stringify(anchorAtRow(rows, entries, 0, 14)) === JSON.stringify({ id: 1, index: 0, offset: 0 }), JSON.stringify(anchorAtRow(rows, entries, 0, 14)))
  check('行号 → 锚点：第 9 行落在第 4 条第 1 行', JSON.stringify(anchorAtRow(rows, entries, 9, 14)) === JSON.stringify({ id: 5, index: 4, offset: 1 }), JSON.stringify(anchorAtRow(rows, entries, 9, 14)))
  check('行号到/过尾部 → 锚点是 null（跟尾）', anchorAtRow(rows, entries, 14, 14) === null && anchorAtRow(rows, entries, 99, 14) === null)
  check('锚点 → 行号：往返一致', rowOfAnchor(rows, entries, anchorAtRow(rows, entries, 9, 14)) === 9)
  check(
    '锚点还在，但长度变了 → 同一个锚点指的还是同一条（行号跟着变，视线不动）',
    rowOfAnchor([2, 2, 5, 2, 2, 2, 2, 2, 2, 2], entries, { id: 3, index: 2, offset: 1 }) === 5,
    String(rowOfAnchor([2, 2, 5, 2, 2, 2, 2, 2, 2, 2], entries, { id: 3, index: 2, offset: 1 })),
  )
  check('下标失效（条目顺序变了）时按 id 重新找', rowOfAnchor(rows, entries, { id: 5, index: 0, offset: 1 }) === 9, String(rowOfAnchor(rows, entries, { id: 5, index: 0, offset: 1 })))
  check('条目没了（切会话/压缩）→ 给出一个越界行号，调用方夹回尾部', rowOfAnchor(rows, entries, { id: 999, index: 0, offset: 0 }) > 1000)
}
{
  const heights = new HeightCache()
  heights.useWidth(80)
  heights.set(1, 9)
  check('行高表按 id 存真值', heights.get(1) === 9 && heights.size === 1)
  heights.useWidth(60)
  check('宽度变了行高表作废（折行重算）', heights.size === 0)
}

// ── [3] 轮 ─────────────────────────────────────────────────────────────────
console.log('\n[3] 轮位置与跳转')
{
  const entries = [
    { kind: 'user', id: 1, text: '第一问' },
    { kind: 'text', id: 2, text: '答' },
    { kind: 'user', id: 3, text: '插话', steering: true },
    { kind: 'text', id: 4, text: '答' },
    { kind: 'user', id: 5, text: '队友汇报', internal: true },
    { kind: 'system', id: 6, text: '通知' },
  ]
  const heights = new HeightCache()
  heights.useWidth(80)
  for (const entry of entries) heights.set(entry.id, 3)
  const layout = layoutViewport(entries, heights, { width: 80, viewportLines: 4, anchor: TAIL })
  check('一轮 = 一条非内部用户消息（插话算、队友汇报不算）', layout.turns.length === 2 && layout.turns[0].id === 1 && layout.turns[1].id === 3, JSON.stringify(layout.turns))
  check('轮的 top 是内容行坐标（第 0 轮 = 0，第 1 轮 = 6 = 前两条各 3 行）', layout.turns[0].top === 0 && layout.turns[1].top === 6, JSON.stringify(layout.turns.map((t) => t.top)))
  check('跳第一轮：shift = 总行数 − 视口行数（顶到头）', shiftForTurn(layout.turns[0], layout, 4) === layout.maxShift, String(shiftForTurn(layout.turns[0], layout, 4)))
  check('跳第二轮：那一轮正好落在视口顶上', shiftForTurn(layout.turns[1], layout, 4) === layout.totalLines - 4 - 6, String(shiftForTurn(layout.turns[1], layout, 4)))
  check('跟尾时当前轮 = 最后一轮', activeTurnIndex(layout.turns, 0, layout, 4) === 1, String(activeTurnIndex(layout.turns, 0, layout, 4)))
  check('顶到头时当前轮 = 第一轮', activeTurnIndex(layout.turns, layout.maxShift, layout, 4) === 0, String(activeTurnIndex(layout.turns, layout.maxShift, layout, 4)))
}

// ── [4] 刻度栏 ──────────────────────────────────────────────────────────────
console.log('\n[4] 刻度栏几何（照 dsh-TUI）')
check('窄于 60 列不画', railEligible({ columns: RAIL_MIN_COLUMNS - 1, turnCount: 5, viewportLines: 20, contentLines: 200 }) === false)
check('只有一轮不画', railEligible({ columns: 100, turnCount: 1, viewportLines: 20, contentLines: 200 }) === false)
check('一屏装得下不画', railEligible({ columns: 100, turnCount: 5, viewportLines: 200, contentLines: 200 }) === false)
check('够条件才画', railEligible({ columns: 100, turnCount: 5, viewportLines: 20, contentLines: 200 }) === true)
check(
  '字形照 dsh：活动重线 / 静止短线 / 箭头小三角',
  RAIL_GLYPH.active === '━━' && RAIL_GLYPH.idle === ' ─' && RAIL_GLYPH.up === ' ▴' && RAIL_GLYPH.down === ' ▾',
  JSON.stringify(RAIL_GLYPH),
)
{
  // 居中高度与列高分开（用户报障「上下滑动时刻度上下晃」）：聊天区的可用高度会随「回到底部」
  // 胶囊、草稿行数变，按它居中就每滚一下挪一格；按稳定高度居中后，列高少一行块也不动。
  const stable = railGeometry({ turnCount: 6, activeIndex: 5, rows: 33, centerRows: 39, atBottom: true })
  const shrunk = railGeometry({ turnCount: 6, activeIndex: 5, rows: 32, centerRows: 39, atBottom: true })
  check(
    '列高少一行（页脚多一行）：块的上下边界一动不动',
    stable.upRow === shrunk.upRow && stable.downRow === shrunk.downRow,
    JSON.stringify({ stable: [stable.upRow, stable.downRow], shrunk: [shrunk.upRow, shrunk.downRow] }),
  )
  check('块仍留在列里（居中高度比列高大，也要夹住）', stable.upRow >= 0 && stable.downRow < 33, JSON.stringify([stable.upRow, stable.downRow]))
  // 轮数多到块几乎填满列时：居中高度再大也只夹到 0，块顶就是列顶
  const tall = railGeometry({ turnCount: 40, activeIndex: 0, rows: 10, centerRows: 39 })
  check(
    '块比列矮不了几行时夹到 0（不溢出、▼ 不被裁）',
    tall.upRow === 0 && tall.downRow === 9 && tall.rows.filter((row) => row !== null).length === 10,
    JSON.stringify({ upRow: tall.upRow, downRow: tall.downRow }),
  )
}
{
  // dsh-TUI 对位（`src/ink/timeline-rail.ts` 的 computeRailGeometry）：这一节的数就是它的
  // 数——写探针时用 dsh 的原函数跑过一轮网格（行数 3/4/8/12/26/40 × 轮数 0/1/2/3/5/20/60
  // × 当前轮若干 × 贴尾两态 = 420 组，420/420 逐字段一致）。dsh 在「轮数 < 2 或没有格子」
  // 时返回 null，这里同义为「整列空行」。
  const g = railGeometry({ turnCount: 8, activeIndex: 3, rows: 26 })
  check(
    '26 行 8 轮：块居中（▲ 8、刻度 9..16、▼ 17）',
    g.upRow === 8 && g.tickTop === 9 && g.downRow === 17,
    JSON.stringify({ upRow: g.upRow, tickTop: g.tickTop, downRow: g.downRow }),
  )
  check('轮数 < 2 时整列空（与 dsh 的 null 同义）', railGeometry({ turnCount: 1, activeIndex: 0, rows: 26 }).rows.every((row) => row === null))
}
{
  const g = railGeometry({ turnCount: 3, activeIndex: 1, rows: 10 })
  const ticks = g.rows.filter((row) => row?.kind === 'tick')
  check(
    '3 轮 10 行：每轮一格 + ▲/▼ 各一行',
    ticks.length === 3 && g.up === 0 && g.down === 2,
    JSON.stringify({ up: g.up, down: g.down, ticks: ticks.map((row) => row.turn) }),
  )
  check(
    '▲ + 刻度 + ▼ 这一块纵向居中（上下留空相等或差一行）',
    g.upRow === 2 && g.tickTop === 3 && g.downRow === 6 && Math.abs(g.upRow - (10 - 1 - g.downRow)) <= 1,
    JSON.stringify({ upRow: g.upRow, tickTop: g.tickTop, downRow: g.downRow }),
  )
  check(
    '块以外的行是空行（首行不是箭头）',
    g.rows.slice(0, g.upRow).every((row) => row === null) && g.rows.slice(g.downRow + 1).every((row) => row === null),
    JSON.stringify(g.rows.map((row) => (row === null ? null : row.kind))),
  )
  check('当前轮在几何里标出来', g.rows.some((row) => row?.kind === 'tick' && row.active === true))
  check(
    '命中判定：▲/▼ 各给 up/down、刻度行给轮下标、空行给 null',
    railHitRow(g, 1) === null && railHitRow(g, 2) === 'up' && railHitRow(g, 3) === 0 && railHitRow(g, 5) === 2 && railHitRow(g, 6) === 'down' && railHitRow(g, 9) === null,
    JSON.stringify(g.rows.map((r) => (r === null ? null : r.kind === 'tick' ? r.turn : r.kind))),
  )
}
{
  const g = railGeometry({ turnCount: 2, activeIndex: 0, rows: 10 })
  check('第一轮：▲ 照样画，只是没有目标（enabled = false）', g.up === null && g.down === 1 && g.rows[g.upRow]?.kind === 'up' && g.rows[g.upRow]?.enabled === false, JSON.stringify({ up: g.up, down: g.down }))
  const tail = railGeometry({ turnCount: 2, activeIndex: 1, rows: 10 })
  check('最后一轮：▼ 照样画，只是没有目标', tail.down === null && tail.up === 0 && tail.rows[tail.downRow]?.kind === 'down' && tail.rows[tail.downRow]?.enabled === false, JSON.stringify({ up: tail.up, down: tail.down }))
  check('两头的箭头都画（块高 = 轮数 + 2）', tail.rows.filter((row) => row !== null).length === 4, JSON.stringify(tail.rows.map((r) => r?.kind ?? null)))
}
{
  const g = railGeometry({ turnCount: 50, activeIndex: 25, rows: 12 })
  const ticks = g.rows.filter((row) => row?.kind === 'tick').map((row) => row.turn)
  check('轮多于行：滑窗口且最多 rows − 2 格', ticks.length === 10, String(ticks.length))
  check('当前轮一定在窗口里', ticks.includes(25), JSON.stringify(ticks))
  check('窗口内的轮号是连续的', ticks.every((turn, i) => i === 0 || turn === ticks[i - 1] + 1), JSON.stringify(ticks))
  const head = railGeometry({ turnCount: 50, activeIndex: 0, rows: 12 })
  check('贴头时窗口从第 0 轮起', head.windowStart === 0 && head.rows.filter((r) => r?.kind === 'tick')[0].turn === 0)
  const foot = railGeometry({ turnCount: 50, activeIndex: 49, rows: 12, atBottom: true })
  check('贴尾时窗口钉住最新（到第 49 轮止）', foot.windowEnd === 50 && foot.rows.filter((r) => r?.kind === 'tick').at(-1).turn === 49, JSON.stringify({ start: foot.windowStart, end: foot.windowEnd }))
  check('窗口永不含错位的活动刻度（活动那格一定在窗口内）', foot.rows.some((row) => row?.kind === 'tick' && row.active === true))
}
check('列高不够（3 行以下没有格子）时整列空', railGeometry({ turnCount: 9, activeIndex: 0, rows: 2 }).rows.every((row) => row === null))
check('OVERSCAN_LINES 是正数（窗口上下各留一点）', OVERSCAN_LINES > 0)

// ── [5] 箭头目标 ────────────────────────────────────────────────────────────
console.log('\n[5] 箭头目标（turnJumpTarget）')
{
  const tops = [0, 20, 60, 90]
  const base = { turnCount: 4, turnTops: tops, maxTop: 200 }
  check('读到本轮中段：▲ 先对齐本轮的题面', turnJumpTarget({ ...base, activeIndex: 2, viewportTop: 70, direction: 'up' }) === 2, String(turnJumpTarget({ ...base, activeIndex: 2, viewportTop: 70, direction: 'up' })))
  check('题面已在视口顶之上：▲ 退到上一轮', turnJumpTarget({ ...base, activeIndex: 2, viewportTop: 60, direction: 'up' }) === 1, String(turnJumpTarget({ ...base, activeIndex: 2, viewportTop: 60, direction: 'up' })))
  check('第一轮题面就在视口顶：▲ 没有目标', turnJumpTarget({ ...base, activeIndex: 0, viewportTop: 0, direction: 'up' }) === null)
  check('▼ 给下一轮', turnJumpTarget({ ...base, activeIndex: 1, viewportTop: 20, direction: 'down' }) === 2)
  check('最后一轮：▼ 没有目标', turnJumpTarget({ ...base, activeIndex: 3, viewportTop: 90, direction: 'down' }) === null)
  // 够不着视口顶的下一轮不名：否则跳过去会被夹在最大顶行号，再按 ▼ 原地不动
  check(
    '够不着视口顶的下一轮：▼ 没有目标（暗箭头 = 空操作）',
    turnJumpTarget({ turnCount: 2, turnTops: [0, 150], maxTop: 120, activeIndex: 0, viewportTop: 0, direction: 'down' }) === null,
  )
  check(
    '够得着就是目标（150 → 100 可达）',
    turnJumpTarget({ turnCount: 2, turnTops: [0, 150], maxTop: 160, activeIndex: 0, viewportTop: 0, direction: 'down' }) === 1,
  )
  check('没有轮时两个方向都没目标', turnJumpTarget({ turnCount: 0, activeIndex: 0, direction: 'up' }) === null && turnJumpTarget({ turnCount: 0, activeIndex: 0, direction: 'down' }) === null)
  // 不传 turnTops 的回落：当前轮 ± 1（刻度栏以外的地方也用它，缺数据时不许崩）
  check('缺每轮顶行号时退回「当前轮 ± 1」', turnJumpTarget({ turnCount: 3, activeIndex: 1, direction: 'up' }) === 0 && turnJumpTarget({ turnCount: 3, activeIndex: 1, direction: 'down' }) === 2)
}

process.exit(failures === 0 ? 0 : 1)
