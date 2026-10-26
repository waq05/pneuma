/**
 * 会话流的**排版契约**电池（带真彩 SGR）：思考块怎么排、用户行怎么隔、状态栏几行，
 * 以及「行数估算 == 真实渲染」这条支撑滚动稳定性的不变量。
 *
 * 为什么单独一个电池：`FORCE_COLOR` 必须在 import ink **之前**设（chalk 在模块加载时
 * 探测一次色彩能力），而其余探针都依赖「非 TTY → 纯文本帧」的读法。这里自己起一个
 * 进程，先把色彩打开，再动态 import ink 与组件。
 *
 * 为什么钉「估算 == 渲染」：行滚动靠行高表，从没渲染过的条目只能估算；估算一旦与真实
 * 差得多，滚动就会「前几格不动、再滚一下弹回底部」（用户报障）。这里对每一种条目
 * 单独渲染一次，把真实行数与 `estimateLines` 对上——它是那条病根的回归门。
 *
 * 运行：pnpm build && node scripts/tui-transcript-style-test.mjs
 *
 * @module dsc/scripts/tui-transcript-style-test
 */
process.env.FORCE_COLOR = '3'  // 真彩：金色题面才不会被降级成亮白
const { PassThrough } = await import('node:stream')
const React = (await import('react')).default
const { render, Box } = await import('ink')
const { Entry } = await import('../lib/app/ChatView.js')
const { StatusBar } = await import('../lib/app/StatusBar.js')
const { estimateLines } = await import('../lib/app/scroll-model.js')
const { absoluteTop, measuredHeight } = await import('../lib/app/click.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const WIDTH = 60
/** 终端列数：`MarkdownView` 自己按 `columns − 6` 算宽度，让盒宽与它一致（估算按盒宽算）。 */
const COLUMNS = WIDTH + 6

/** 把一件东西渲染成裸行（每行含 SGR 原文）。 */
async function renderLines(element, columns = COLUMNS, rows = 60) {
  const stdout = new PassThrough()
  stdout.columns = columns
  stdout.rows = rows
  stdout.isTTY = false
  let text = ''
  stdout.on('data', (chunk) => {
    text += String(chunk)
  })
  const instance = render(element, { stdout, exitOnCtrlC: false, patchConsole: false })
  await new Promise((resolve) => setTimeout(resolve, 120))
  instance.unmount()
  const at = text.lastIndexOf('\x1b[2K')
  return (at < 0 ? text : text.slice(at))
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => line.replace(/^\x1b\[2K/, ''))
    .filter((line, index, all) => !(index === all.length - 1 && line === ''))
}

/** 去掉 SGR：判「这一行画了什么」用（几何与文案）。 */
const plain = (line) => line.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '').replace(/\s+$/, '')

const renderEntry = (entry, expandThinking = false) =>
  renderLines(
    React.createElement(Box, { width: WIDTH }, React.createElement(Entry, { entry, streaming: false, expandThinking })),
  )

/**
 * 挂一个**常驻**的小宿主：展开集合与切换回调由一个 state 持有（与 App 同构），
 * `Entry` 登记点击区，探针直接调 `hit`（App 点击时也是这么问的：现量 top/height 再问）。
 * 帧从整段输出里取（非 TTY 下每帧整段追加，取尾部即最新帧）。
 */
async function mountToggle(entry, columns = COLUMNS) {
  const stdout = new PassThrough()
  stdout.columns = columns
  stdout.rows = 60
  stdout.isTTY = false
  let text = ''
  stdout.on('data', (chunk) => {
    text += String(chunk)
  })
  const regions = []
  const register = (region) => {
    regions.push(region)
    return () => {
      const index = regions.indexOf(region)
      if (index >= 0) regions.splice(index, 1)
    }
  }
  const { useState } = React
  function Host() {
    const [open, setOpen] = useState(false)
    return React.createElement(
      Box,
      { width: WIDTH, flexDirection: 'column' },
      React.createElement(Entry, {
        entry,
        streaming: false,
        expandThinking: false,
        expandedTools: new Set(open ? [entry.id] : []),
        onToggleTool: (id) => setOpen((current) => (id === entry.id ? !current : current)),
        registerClick: register,
      }),
    )
  }
  const instance = render(React.createElement(Host), { stdout, exitOnCtrlC: false, patchConsole: false })
  await new Promise((resolve) => setTimeout(resolve, 180))
  let mark = 0
  const since = () => plain(text.slice(mark))
  const contains = (needle) => since().includes(needle)
  const lastFrame = () =>
    (text.slice(text.lastIndexOf('\x1b[2K')).replace(/\n$/, '').split('\n')).map((line) => plain(line.replace(/^\x1b\[2K/, '')))
  const click = async (col, row) => {
    mark = text.length
    const clicked = regions.some((region) => {
      const top = absoluteTop(region.node.current)
      const height = measuredHeight(region.node.current)
      if (top === null || height === null) return false
      return region.hit(col, row, top, height)
    })
    await new Promise((resolve) => setTimeout(resolve, 180))
    return clicked
  }
  return { click, since, contains, lastFrame, regions, unmount: () => instance.unmount() }
}

const LONG_RESULT = Array.from({ length: 14 }, (_, i) => `结果第 ${i} 行`).join('\n')
const LONG_THINK = Array.from({ length: 9 }, (_, i) => `第 ${i} 段推理`).join('\n')

console.log('会话流排版契约测试')

// ── [1] 思考块 ──────────────────────────────────────────────────────────────
{
  const entry = { kind: 'thinking', id: 1, text: LONG_THINK, durationMs: 4200 }
  const folded = await renderEntry(entry)
  // 折叠态 = 标签 + **恒定 3 行瀑布**（照 dsh 的 preview ticker）：每行硬截到框宽、不折行，
  // 所以块高与「正文多长 / 框多宽」都无关——恒高是这一块的核心契约（流式加字不会让整块跳）。
  check(`折叠态 = 标签 + 恒定 3 行瀑布（实测 ${folded.length} 行）`, folded.length === 4, JSON.stringify(folded.map(plain)))
  check('标签在行首（无缩进）', plain(folded[0]).startsWith('⚓ 思考'), JSON.stringify(plain(folded[0])))
  check('标签行是斜体 + 暗淡（照 dsh：只有标签斜体）', folded[0].includes('\x1b[3m') && folded[0].includes('\x1b[2m'), JSON.stringify(folded[0]))
  check('瀑布每行缩两格 + `│ ` 引导', folded.slice(1).every((line) => plain(line).startsWith('  │ ')), JSON.stringify(folded.slice(1).map(plain)))
  check('首行前缀 `…`（上面还有内容）', plain(folded[1]).startsWith('  │ …第 6 段推理'), JSON.stringify(plain(folded[1])))
  check('末行留的是**最新**那几段（从尾部截）', plain(folded[3]).includes('第 8 段推理'), JSON.stringify(plain(folded[3])))
  check('思考正文不斜体（不再是斜体长段）', folded.slice(1).every((line) => !line.includes('\x1b[3m')), JSON.stringify(folded[1]))
  check('思考正文是暗淡色（终端没有字号，暗淡就是「小一号」）', folded[1].includes('\x1b[2m'), JSON.stringify(folded[1]))
  check(
    `折叠态行数与估算一致（${estimateLines(entry, WIDTH)}）`,
    estimateLines(entry, WIDTH) === folded.length,
    `${estimateLines(entry, WIDTH)} vs ${folded.length}`,
  )
  const expanded = await renderEntry(entry, true)
  check(
    `展开态 = 标签 1 行 + 全文 9 行，实测 ${expanded.length}`,
    expanded.length === 10 && estimateLines(entry, WIDTH, { expandThinking: true }) === expanded.length,
    JSON.stringify([expanded.length, estimateLines(entry, WIDTH, { expandThinking: true })]),
  )
  // 恒高：一句短话也是 4 行（空行画 `│ ` 而不是空串——空串的 Text 高度是 0，瀑布会缺行）
  const short = { kind: 'thinking', id: 8, text: '短一句' }
  const shortLines = await renderEntry(short)
  check(
    `短思考同样恒定 4 行（恒高与正文长短无关），估算一致（${estimateLines(short, WIDTH)}）`,
    shortLines.length === 4 && estimateLines(short, WIDTH) === 4 && plain(shortLines[2]) === '  │',
    JSON.stringify(shortLines.map(plain)),
  )
  // 恒高：一整行超长（不换行的那种）也硬截成 4 行
  const wide = { kind: 'thinking', id: 9, text: '甲'.repeat(300) }
  const wideLines = await renderEntry(wide)
  check(
    `超长单行也是恒定 4 行（硬截不折行）`,
    wideLines.length === 4 && estimateLines(wide, WIDTH) === 4,
    JSON.stringify(wideLines.map(plain)),
  )
  // 流式：spinner 走**呼吸色**（品牌蓝 ↔ 冰蓝之间；对齐 dsh 的 Kimi Code 蓝脉冲），
  // 不是固定的强调蓝——强调蓝 #7DA1DE 的蓝通道 0xDE，呼吸带的蓝通道恒 ≥ 0xFE。
  const streamed = await renderLines(
    React.createElement(Box, { width: WIDTH }, React.createElement(Entry, { entry: { kind: 'thinking', id: 10, text: '推一下' }, streaming: true, expandThinking: false })),
  )
  const rgb = /38;2;(\d+);(\d+);(\d+)/.exec(streamed[0] ?? '')
  check(
    `流式 spinner 是呼吸色（读到 ${rgb === null ? '无色' : rgb.slice(1).join(',')}）`,
    rgb !== null && Number(rgb[1]) >= 0x4d && Number(rgb[1]) <= 0x93 && Number(rgb[2]) >= 0x6b && Number(rgb[2]) <= 0xbe && Number(rgb[3]) >= 0xfe,
    JSON.stringify(streamed[0]),
  )
  check('流式标签报「思考中」', plain(streamed[0] ?? '').includes('思考中'), JSON.stringify(plain(streamed[0] ?? '')))
}

// ── [2] 用户消息 ────────────────────────────────────────────────────────────
{
  const entry = { kind: 'user', id: 2, text: '你好，这是一句题面' }
  const lines = await renderEntry(entry)
  check(`带上了前面那行空（共两行），实测 ${lines.length}`, lines.length === 2 && plain(lines[0]) === '', JSON.stringify(lines.map(plain)))
  check('题面行金色 + 粗体（dsh userPromptLabel）', plain(lines[1]).startsWith('❯ 你好') && lines[1].includes('\x1b[1m') && lines[1].includes('38;2;255;223;128'), JSON.stringify(lines[1]))
  check(
    `用户行行数与估算一致（${estimateLines(entry, WIDTH)}）`,
    estimateLines(entry, WIDTH) === lines.length,
    `${estimateLines(entry, WIDTH)} vs ${lines.length}`,
  )
  const internal = await renderEntry({ kind: 'user', id: 3, text: '汇报', internal: true })
  check('队友汇报那条不占空行、只有一行', internal.length === 1 && estimateLines({ kind: 'user', id: 3, text: '汇报', internal: true }, WIDTH) === 1, JSON.stringify(internal.map(plain)))
}

// ── [3] 工具卡：默认「调用 xx 工具」一行，点击展开参数与结果 ────────────────
{
  const entry = {
    kind: 'tool',
    id: 4,
    call: { callId: 'c1', name: 'browser_look', argsText: '{"action":"snapshot"}', resultText: LONG_RESULT, status: 'done', durationMs: 1400 },
  }
  const lines = await renderEntry(entry)
  const head = plain(lines[0])
  check(`折叠态就是一行（实测 ${lines.length} 行）`, lines.length === 1, JSON.stringify(lines.map(plain)))
  check('默认报「调用 xx 工具」+ 状态 + 耗时', head === '⚙  调用 browser_look 工具 · ✓ 完成 · 1.4s', JSON.stringify(head))
  check('图标与文字之间留两格（终端把 ⚙ 画成双宽字形时也挤不着）', head.startsWith('⚙  调用'), JSON.stringify(head.slice(0, 10)))
  check(
    '折叠态不摊参数与结果（那两样点开才给）',
    !head.includes('snapshot') && !lines.some((line) => line.includes('结果第 0 行')),
    JSON.stringify(lines.map(plain)),
  )
  check(
    `折叠态行数与估算一致（${estimateLines(entry, WIDTH)}）`,
    estimateLines(entry, WIDTH) === 1,
    String(estimateLines(entry, WIDTH)),
  )
  check(
    '没有结果时同样一行（估算与渲染都恒 1 行）',
    estimateLines({ ...entry, id: 9, call: { ...entry.call, resultText: '' } }, WIDTH) === 1,
  )

  // 点击链路：真登记点击区 → 调命中判定（App 点击时也是这么问的）→ 展开再点收回
  const card = await mountToggle(entry)
  check('卡片登记了点击区（可点）', card.regions.length === 1, String(card.regions.length))
  check('点击前列不出参数与结果', !card.contains('▸ {"action":"snapshot"}') && !card.contains('结果第 0 行'))
  const hitIn = await card.click(4, 0)
  check(
    '卡片内点一下：展开出参数行（▸）与结果行（↳）',
    hitIn && card.contains('▸ {"action":"snapshot"}') && card.contains('↳ 结果第 0 行'),
    JSON.stringify(card.since()),
  )
  check('点在卡片右侧之外（刻度栏那两列）：不命中、不展开', !(await card.click(WIDTH + 2, 0)) && !card.since().includes('↳ 结果第 0 行'))
  check('点在卡片上下之外的行：不命中', !(await card.click(4, 5)))
  const hitBack = await card.click(4, 0)
  check('再点一下收回折叠', hitBack && !card.lastFrame().some((line) => line.includes('结果第 0 行')), JSON.stringify(card.lastFrame()))
  card.unmount()
}

// ── [4] 子代理卡 ────────────────────────────────────────────────────────────
{
  const settled = {
    kind: 'subagent',
    id: 6,
    sub: { name: 'mate-1', role: 'explorer', state: 'idle', task: '查资料', rounds: 3, toolCalls: 4, model: 'm', outputLines: ['一', '二', '三'] },
  }
  const done = await renderEntry(settled)
  check(`收工后只有标题一行（实测 ${done.length}）`, done.length === 1 && estimateLines(settled, WIDTH) === 1, JSON.stringify(done.map(plain)))
  const working = { ...settled, id: 7, sub: { ...settled.sub, state: 'working' } }
  const live = await renderEntry(working)
  check(
    `跑动中（还没有工具在跑）= 标题 + 3 行瀑布（实测 ${live.length}，估算 ${estimateLines(working, WIDTH)}）`,
    live.length === 4 && estimateLines(working, WIDTH) === 4,
    JSON.stringify(live.map(plain)),
  )
  const withTool = { ...working, id: 9, sub: { ...working.sub, lastTool: { name: 'read', args: 'a.ts', status: 'running' } } }
  const live2 = await renderEntry(withTool)
  check(
    `跑动中（有工具）= 标题 + 当前工具 + 3 行瀑布（实测 ${live2.length}，估算 ${estimateLines(withTool, WIDTH)}）`,
    live2.length === 5 && estimateLines(withTool, WIDTH) === 5,
    JSON.stringify(live2.map(plain)),
  )
}

// ── [5] 状态栏：一行、没有那条蓝色进度条 ────────────────────────────────────
{
  const status = {
    turnState: 'idle',
    model: 'test-model',
    effort: 'medium',
    usage: null,
    contextWindow: 1_000_000,
    contextUsed: 0,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    sessionId: '/w/s.jsonl',
    cwd: '/w',
  }
  const surfaces = {
    pendingApproval: null,
    pendingQuestion: null,
    pendingPlan: null,
    goal: null,
    todos: { total: 0, done: 0, active: null },
    mode: { options: [{ id: 'build', label: '执行' }], current: 'build' },
    policy: { options: [{ id: 'default', label: '标准' }], current: 'default' },
  }
  const bar = await renderLines(
    React.createElement(StatusBar, {
      status,
      surfaces,
      subagents: [],
      queued: 0,
      config: { model: true, effort: false, cache: false, tokens: false, cost: false, mode: true, policy: true, ctx: true, cwd: true, session: false },
    }),
    COLUMNS,
  )
  check(`状态栏只有一行（实测 ${bar.length} 行）`, bar.length === 1, JSON.stringify(bar.map(plain)))
  check('那一行还是原来的字段行（状态 + 模型）', plain(bar[0]).includes('空闲') && plain(bar[0]).includes('test-model'), JSON.stringify(plain(bar[0])))
  check(
    'context 读数的长形式（`x/y pct`）不再出现在状态栏里',
    !bar.some((line) => /\d+\/1\.0M/.test(plain(line))),
    JSON.stringify(bar.map(plain)),
  )
  check('没有任何填充背景色块（那条进度条靠 childless Box 的 backgroundColor 画）', !bar.some((line) => /\x1b\[48[;0-9]*m/.test(line)), JSON.stringify(bar))
}

// ── [6] 呼吸色与刻度列悬停提亮 ──────────────────────────────────────────────
{
  const { mixHex, RAIL_COLOR } = await import('../lib/app/theme.js')
  const { onGutter, publishPointer, clearPointer } = await import('../lib/app/pointer.js')
  const { TimelineRail } = await import('../lib/app/TimelineRail.js')
  const { railGeometry } = await import('../lib/app/scroll-model.js')
  check('mixHex：两端原样（t=0 / t=1）', mixHex('#4D6BFE', '#93BEFF', 0).toLowerCase() === '#4d6bfe' && mixHex('#4D6BFE', '#93BEFF', 1).toLowerCase() === '#93beff', mixHex('#4D6BFE', '#93BEFF', 0))
  check('mixHex：中点取两端的平均', mixHex('#000000', '#ffffff', 0.5) === '#808080', mixHex('#000000', '#ffffff', 0.5))
  check('mixHex：t 越界夹住（正弦算出来不会越界，但别让越界值渲染出坏色）', mixHex('#000000', '#ffffff', 9) === '#ffffff' && mixHex('#000000', '#ffffff', -3) === '#000000')
  check('mixHex：非 hex（16 色名）原样返回，不出错', mixHex('cyan', '#ffffff', 0.5) === 'cyan')

  const hexToSgr = (hex) => {
    const value = Number.parseInt(hex.replace('#', ''), 16)
    return `38;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`
  }
  // 悬停：指针停在某一格刻度上 → 那一行提亮到 RAIL_COLOR.active，别行仍是 idle
  // （栏目顶行 = 帧第 0 行，所以指针的 1 基行号 = 列内行号 + 1；悬停第二格刻度，
  //  那里本来画的是 idle 的短线，提亮才看得出来）
  const geometry = railGeometry({ turnCount: 3, activeIndex: 0, rows: 8 })
  const hoverRow = geometry.tickTop + 1
  publishPointer(5, hoverRow + 1, 8) // 列 5/8 落在刻度列（页边距 2 内）
  const hovered = await renderLines(React.createElement(TimelineRail, { geometry, onPickTurn: () => {} }), 8, 10)
  clearPointer()
  const idle = await renderLines(React.createElement(TimelineRail, { geometry, onPickTurn: () => {} }), 8, 10)
  check(
    `悬停那一行提亮到 active（第 ${hoverRow} 行含 ${hexToSgr(RAIL_COLOR.active)}）`,
    hovered[hoverRow]?.includes(hexToSgr(RAIL_COLOR.active)) === true,
    JSON.stringify(hovered.map(plain)),
  )
  check(
    '没悬停时同一行是 idle 色（提亮不是恒定渲染）',
    idle[hoverRow]?.includes(hexToSgr(RAIL_COLOR.idle)) === true && !idle[hoverRow]?.includes(hexToSgr(RAIL_COLOR.active)),
    JSON.stringify(idle.map(plain)),
  )
  check(
    '悬停只影响那一行（另一格刻度还是 idle）',
    hovered[geometry.tickTop + 2]?.includes(hexToSgr(RAIL_COLOR.idle)) === true &&
      !hovered[geometry.tickTop + 2]?.includes(hexToSgr(RAIL_COLOR.active)),
    JSON.stringify([plain(hovered[geometry.tickTop + 2]), plain(hovered[hoverRow])]),
  )
  check('onGutter 与渲染用的列门槛一致（列 5/8 在下、列 4/8 在上）', onGutter(5, 8) && !onGutter(4, 8))
}

process.exit(failures === 0 ? 0 : 1)
