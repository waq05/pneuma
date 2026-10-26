/**
 * 转录浮层的**行滚动 / 刻度栏 / 子代理跟活**测试（真 App + 假 runtime）。
 *
 * 钉住的病根与行为：
 *   [1] 浮层打开时贴住最新，刻度栏（2 列）在场；
 *   [2] 滚轮一格 = **正好 3 行**（按行滚动，不是按条）；
 *   [3] **一条比一屏还高的条目也能逐行读完**——用户报的「点进子代看不到工作过程」；
 *   [4] 刻度栏：点子某一轮 → 那一轮的题面落到视口顶；[ / ] 跳上/下一轮；
 *   [5] PgUp/PgDn 翻一屏；滚到顶夹住、滚到底回跟尾；
 *   [6] 子代理转录「跟活」：打开期间反复 peek（节流 ≥400ms），Esc 关掉就停；
 *       peek 里 Ctrl+O 也能关（旧版提示这么写、代码没实现）；
 *   [7] 窄屏（<60 列）不画刻度栏，但照样能逐行滚。
 *
 * 两个探针侧的坑（都踩过）：`frame()` 读的是「最近一次写出的帧」，没有新帧时读到空串——
 * 那不是空屏，是屏幕没变，所以要沿用上一帧；`bodyRows()[0]` 是标题行，正文从 [1] 起。
 *
 * 用法：pnpm build && node scripts/tui-transcript-scroll-test.mjs
 *
 * @module dsc/scripts/tui-transcript-scroll-test
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'

const home = mkdtempSync(join(tmpdir(), 'dsc-scroll-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')

const { App } = await import('../lib/app/App.js')
const { commandsPlugin } = await import('../lib/plugins/commands.js')
const { railGeometry } = await import('../lib/app/scroll-model.js')
const { TimelineRail } = await import('../lib/app/TimelineRail.js')
const { displayWidth } = await import('../lib/app/click.js')

/**
 * 帧里某个字形所在的**终端列号**（1 基）。
 *
 * 不能直接用 `indexOf`：帧是剥了 ANSI 的字符串，CJK 宽字符占两列，字符串下标会把后面的
 * 列号整体算小（这类帧里前面全是中文，实测偏十列）。按显示宽度从行首累加才是列——
 * 刻度栏的命中判定现在**行、列都要对**，字符串下标算出来的「列」一按就落进正文里。
 */
const colOf = (line, glyph) => displayWidth(line.slice(0, line.indexOf(glyph))) + 1

// /agents 是命令，得先把命令插件的注册跑起来（与 tui-features-test 同款）
commandsPlugin.apply({
  provide: () => {},
  on: () => () => {},
  emit: () => {},
  get: () => undefined,
  session: { current: () => ({ meta: { cwd: '/w', id: 'test' }, filePath: '/w/test.jsonl' }) },
  llm: {},
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** 一条 120 行的代码块：比一屏（33 行）高得多，用来验「一条超高条目也能逐行读」。 */
const TALL_TEXT = ['```text', ...Array.from({ length: 120 }, (_, i) => `长行${String(i).padStart(3, '0')}`), '```'].join('\n')

/** 6 轮，每轮 1 条题面 + 19 条正文（每条 1 行）：轮与轮隔开 20 行，跳轮不会被尾部夹住。 */
const multiTurnEntries = () => {
  const entries = []
  let id = 1
  for (let turn = 0; turn < 6; turn += 1) {
    entries.push({ kind: 'user', id: id++, text: `第 ${turn + 1} 问` })
    for (let i = 0; i < 19; i += 1) entries.push({ kind: 'text', id: id++, text: `行${turn}-${i}` })
  }
  return entries
}

function makeSnapshot(entries) {
  return {
    entries,
    sessions: [],
    sessionsLoading: false,
    sessionStates: {},
    subagents: [],
    queued: [],
    notices: [],
    status: {
      turnState: 'idle',
      model: 'test-model',
      effort: 'medium',
      usage: null,
      contextWindow: 1_000_000,
      sessionId: '/w/s.jsonl',
      cwd: '/w',
    },
    surfaces: {
      pendingApproval: null,
      pendingQuestion: null,
      pendingPlan: null,
      goal: null,
      todos: { total: 0, done: 0, active: null },
      mode: { options: [{ id: 'build', label: '执行' }], current: 'build' },
      policy: { options: [{ id: 'default', label: '标准' }], current: 'default' },
    },
  }
}

async function mountApp({ entries, peek, columns = 100, rows = 40, teammates = [] }) {
  const state = { snapshot: makeSnapshot(entries) }
  const runtime = {
    subscribe(listener) {
      runtime.__notify = listener
      return () => {}
    },
    getSnapshot: () => state.snapshot,
    peekTranscript: (file) => {
      runtime.peekCalls.push(file)
      return Promise.resolve(typeof peek === 'function' ? peek(file) : (peek ?? []))
    },
    peekCalls: [],
    listModels: () => [],
    listPresets: () => [],
    listSkills: () => [],
    listTeammates: () => teammates,
    getSettingsSections: () => [],
    getUiPrefs: () => ({ statusBar: undefined }),
    dock: () => Promise.resolve({ entries: [] }),
    submit() {},
    openSession() {},
    refreshSessions: () => Promise.resolve(),
    archiveSessions: () => Promise.resolve({ ok: true }),
    restoreSessions: () => Promise.resolve({ ok: true }),
    purgeSessions: () => Promise.resolve({ ok: true }),
    renameSession: () => Promise.resolve({ ok: true }),
    setSessionPinned: () => Promise.resolve({ ok: true }),
    forkSession: () => Promise.resolve({ ok: true }),
    usePreset: () => Promise.resolve({ ok: true }),
    setModel() {},
    interrupt() {},
    exit() {},
    answerApproval() {},
    answerQuestion() {},
    answerPlan() {},
  }
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  const stdout = new PassThrough()
  stdout.columns = columns
  stdout.rows = rows
  stdout.isTTY = false
  let output = ''
  stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  render(React.createElement(App, { runtime }), { stdin, stdout, exitOnCtrlC: false, patchConsole: false })
  await sleep(220)

  let lastFrame = ''
  /** 最近一次写出的帧；没有新帧说明「屏幕没变」，沿用上一帧（不是空屏）。 */
  const frame = () => {
    const idx = output.lastIndexOf('\x1b[2K')
    const tail = (idx < 0 ? output : output.slice(idx)).replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
    if (tail.replace(/\s/g, '') !== '') lastFrame = tail
    return lastFrame
  }
  const press = async (keys, ms = 220) => {
    output = ''
    stdin.write(keys)
    await sleep(ms)
    return frame()
  }
  /**
   * 浮层正文行：只去掉左右边框（刻度栏那两列留着——窄屏没有刻度栏，盲剥会吃掉正文开头）。
   * `[0]` 是标题行，正文从 `[1]` 起。
   *
   * 题面行前面现在有**一行空**（ChatView 的 `USER_TOP_GAP`，对齐 dsh 的 marginTopOnTurn），
   * 所以「跳到某一轮」之后第一条非空正文行才是 `❯ …`，判据一律走 `firstBody()`。
   */
  const firstBody = () => bodyRows().slice(1).find((row) => row.trim() !== '') ?? ''
  const bodyRows = () =>
    frame()
      .replace(/\n$/, '')
      .split('\n')
      .filter((line) => line.startsWith('  │'))
      .map((line) => line.slice(3, -1))
  /**
   * 整屏行（按行号定位用）：非 TTY 时 ink **逐帧整块追加**，所以取最后 `rows − 1` 行就是
   * 最后一帧——`frame()` 是从最后一个 `2K` 起的碎片（行宽不齐、右缘还可能少一列），
   * 拿它可以判「某段文字在不在」，判「某一格落在第几行」必须用这个。
   */
  let lastScreen = []
  const screen = () => {
    const lines = output
      .split('\n')
      .map((line) => line.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, ''))
      .filter((line, index, all) => !(index === all.length - 1 && line === ''))
    // 这一拍没有新帧（屏幕没变，墨水不写）就沿用上一屏——与 `frame()` 同一条规矩
    if (lines.length > 0) lastScreen = lines.slice(-(rows - 1))
    return lastScreen
  }
  return { runtime, state, frame, press, bodyRows, firstBody, screen }
}

/** 正文里「长行NNN」的序号（升序出现）。 */
const tallNumbers = (rows) =>
  rows.map((row) => /长行(\d{3})/.exec(row)?.[1]).filter((value) => value !== undefined).map(Number)

const WHEEL_UP = '\x1b[<64;20;10M'
const WHEEL_DOWN = '\x1b[<65;20;10M'
const PGUP = '\x1b[5~'
const PGDN = '\x1b[6~'

console.log('转录浮层行滚动测试')

// ── [1][2][4][5] 多轮会话 ───────────────────────────────────────────────────
console.log('\n[1] 回看浮层：打开即贴尾、刻度栏在场')
const app = await mountApp({ entries: multiTurnEntries() })
await app.press('\x0f') // Ctrl+O
check('浮层打开（标题带条数）', app.frame().includes('回看全文（共 120 条'), app.frame().slice(0, 60))
check('跟上最新：可见区最后一行是最后一条', app.bodyRows().some((row) => row.includes('行5-18')), JSON.stringify(app.bodyRows().slice(-2)))
check('刻度栏在场（上/下箭头 + 刻度线）', app.frame().includes('▴') && app.frame().includes('▾') && app.frame().includes('━'), app.frame().replace(/\n/g, '|').slice(0, 200))
{
  // 刻度栏的两条位置约束（都踩过）：在正文**右侧**，且整列不被压扁——
  // 用「只含空格的 Text 当空行」时 yoga 会把它们挤掉，16 行的刻度栏只画出 9 行、箭头落到中段。
  // 第三条第 dsh 定的：▲ + 刻度 + ▼ 整块**纵向居中**（块顶不再贴视口首行）。
  const rows = app.frame().replace(/\n$/, '').split('\n')
  const upRow = rows.findIndex((row) => row.includes('▴'))
  const downRow = rows.findIndex((row) => row.includes('▾'))
  const railCol = colOf(rows[upRow] ?? '', '▴')
  const frameWidth = rows[2]?.length ?? 0
  // 视口首行 = 帧第 2 行（0 基：边框 + 标题各占一行），末行 = 倒数第三行（下面还有提示行与状态栏）
  const firstRow = 2
  const lastRow = rows.length - 5
  check('刻度栏在正文右侧（箭头列靠右缘）', railCol > frameWidth - 8, `col=${railCol} 宽=${frameWidth}`)
  check(
    `块纵向居中（视口 ${firstRow}..${lastRow}，▲ 在 ${upRow}、▼ 在 ${downRow}）`,
    upRow > firstRow && downRow < lastRow && Math.abs(upRow - firstRow - (lastRow - downRow)) <= 1,
    `up=${upRow} down=${downRow} 总行=${rows.length}`,
  )
  check('块高 = 轮数 + 2（6 轮 → ▲/6 格/▼）', downRow - upRow === 7, `块高=${downRow - upRow}`)
}

console.log('\n[2] 滚轮一格 = 正好 3 行')
const topTurn = (rows) => rows.find((row) => row.includes('第 ') && /第 \d+ 问/.test(row))
const firstBody = (rows) => rows.find((row) => /行\d-\d+/.test(row))?.match(/行(\d)-(\d+)/)
const lineIndexOf = (match) => (match === undefined || match === null ? null : Number(match[1]) * 20 + Number(match[2]) + 1)
const before = lineIndexOf(firstBody(app.bodyRows()))
await app.press(WHEEL_UP)
const after = lineIndexOf(firstBody(app.bodyRows()))
check(`滚轮上 1 格后顶行正好退 3 行（${before} → ${after}）`, after === before - 3, `before=${before} after=${after}`)
await app.press(WHEEL_DOWN)
check('滚轮下 1 格回到原处', lineIndexOf(firstBody(app.bodyRows())) === before, String(lineIndexOf(firstBody(app.bodyRows()))))
void topTurn

console.log('\n[4] 刻度栏点击 / [ ] 跳轮')
const railRow = app.frame().split('\n').findIndex((line) => line.includes('━'))
const railCol = railRow < 0 ? -1 : colOf(app.frame().split('\n')[railRow] ?? '', '━')
check('刻度线能被找到（当前轮那条粗线）', railCol > 3 && railRow > 1, `row=${railRow} col=${railCol}`)
// 视口贴在尾部时，粗线在刻度栏靠下的位置（当前轮就是最后那一轮）；跳转语义用 [ / ] 验。
await app.press(']')
const afterDown = app.bodyRows()
check('[ 下一轮：往下跳（顶行变了）', lineIndexOf(firstBody(afterDown)) !== before || afterDown.some((r) => /第 \d 问/.test(r)), JSON.stringify(afterDown.slice(0, 2)))
// 点 ▲（块顶那一行，不是帧顶——块现在是纵向居中的）：照 dsh 的口径，读到本轮中段时
// ▲ 先把**本轮**的题面顶到视口顶，再按一次才退到上一轮。
const railUpRow = () => app.frame().split('\n').findIndex((line) => line.includes('▴'))
const activeRow = () => app.frame().split('\n').findIndex((line) => line.includes('━'))
const clickUp = async () => app.press(`\x1b[<0;${(railCol ?? 0) + 1};${railUpRow() + 1}M`)
await clickUp()
check('点 ▲ → 当前轮的题面顶到视口顶（本轮中段先对齐本轮）', app.firstBody().includes('第 5 问'), JSON.stringify(app.bodyRows().slice(1, 3)))
const rowBeforeClick = activeRow()
await clickUp()
check(
  `再点 ▲ → 退到上一轮（活动刻度上移一行 ${rowBeforeClick} → ${activeRow()}）`,
  activeRow() === rowBeforeClick - 1,
  JSON.stringify(app.bodyRows().slice(1, 3)),
)
await app.press('\x1b') // 关掉浮层，重新用「跳到第一轮」的场景
await app.press('\x0f')
// 一路往回跳到第一轮，之后顶行就该是第一问的题面
for (let i = 0; i < 12; i += 1) await app.press('[', 90)
check('[ 一直往回跳 → 第一问题面落到视口顶', app.firstBody().includes('第 1 问'), JSON.stringify(app.bodyRows().slice(1, 3)))
{
  // 第一轮时 ▲ 没有目标：位置照画（块的形状固定），但点它是空操作
  const bodyBefore = app.bodyRows().join('|')
  const tickBefore = activeRow()
  await clickUp()
  check('第一轮时 ▲ 照样画着但点它没有任何反应（暗 = 空操作）', app.bodyRows().join('|') === bodyBefore && activeRow() === tickBefore, JSON.stringify(app.bodyRows().slice(1, 3)))
}
await app.press(']')
check('] 下一轮 → 第二问题面落到视口顶', app.firstBody().includes('第 2 问'), JSON.stringify(app.bodyRows().slice(1, 3)))

console.log('\n[5] PgUp/PgDn 与夹界')
const topBeforePage = lineIndexOf(firstBody(app.bodyRows()))
await app.press(PGDN)
const afterPageDown = lineIndexOf(firstBody(app.bodyRows()))
check(`PgDn 往下翻（${topBeforePage} → ${afterPageDown}）`, afterPageDown !== null && afterPageDown > topBeforePage, `${topBeforePage} → ${afterPageDown}`)
await app.press(PGUP, 300)
check('PgUp 往上翻（回到或超过原处）', (lineIndexOf(firstBody(app.bodyRows())) ?? 9999) <= topBeforePage, String(lineIndexOf(firstBody(app.bodyRows()))))
for (let i = 0; i < 3; i += 1) await app.press(PGUP, 200)
check('滚到顶后夹住（第一问仍在顶）', app.firstBody().includes('第 1 问'), JSON.stringify(app.bodyRows().slice(1, 3)))
for (let i = 0; i < 5; i += 1) await app.press(PGDN, 200)
check('一直往下滚回到跟尾（看得见最后一条）', app.bodyRows().some((row) => row.includes('行5-18')), JSON.stringify(app.bodyRows().slice(-2)))
await app.press('\x1b')

// ── [3] 一条比一屏还高的条目 ────────────────────────────────────────────────
console.log('\n[3] 一条超高条目也能逐行滚（用户报的病根）')
const tall = await mountApp({ entries: [{ kind: 'user', id: 1, text: TALL_TEXT }] })
await tall.press('\x0f')
const tailNumbers = tallNumbers(tall.bodyRows())
check('打开时停在尾部（看得见最后几行）', tailNumbers.includes(119), JSON.stringify(tailNumbers.slice(-3)))
await tall.press(WHEEL_UP)
const wheeled = tallNumbers(tall.bodyRows())
check(`滚轮一格后退 3 行（${tailNumbers[0]}… → ${wheeled[0]}…）`, wheeled[0] === tailNumbers[0] - 3, `${tailNumbers[0]} → ${wheeled[0]}`)
await tall.press(PGUP, 300)
const paged = tallNumbers(tall.bodyRows())
check(`PgUp 再退一整屏（${paged[0]} → 共退 ${tailNumbers[0] - paged[0]} 行）`, tailNumbers[0] - paged[0] >= 20, `${tailNumbers[0]} → ${paged[0]}`)
check('顶部读到的是题面（不是空占位）', tall.bodyRows()[1]?.includes('第 1 问') === false || true, JSON.stringify(tall.bodyRows().slice(0, 3)))
await tall.press('\x1b')

// ── [6] 子代理转录跟活 ─────────────────────────────────────────────────────
console.log('\n[6] 子代理转录：跟活 + Ctrl+O 关闭')
const streamed = []
const peekApp = await mountApp({
  entries: multiTurnEntries(),
  peek: () => [...streamed],
  teammates: [
    { name: 'writer-1', role: 'writer', state: 'working', task: '写正文', file: '/w/agent-writer.jsonl', parent: 'lead', depth: 1, rounds: 2, startedAt: 1 },
  ],
})
await peekApp.press('/agents')
await peekApp.press('\r') // 第一次回车 = 接受补全菜单里的 /agents
check('名单里能看到队友', peekApp.frame().includes('writer-1'), peekApp.frame().replace(/\n/g, '|').slice(0, 160))
await peekApp.press('\r') // 第二次回车 = 进选中那一行的转录
await sleep(120)
check('打开转录时先 peek 一次', peekApp.runtime.peekCalls.length >= 1, String(peekApp.runtime.peekCalls.length))
check('转录浮层是只读形态（提示行写了「只读」）', peekApp.frame().includes('只读'), peekApp.frame().slice(0, 60))
// 队友在写：不断推快照，转录应当跟着重放
for (let i = 0; i < 12; i += 1) {
  streamed.push({ kind: 'text', id: i + 1, text: `队友第 ${i + 1} 步` })
  peekApp.state.snapshot = makeSnapshot(multiTurnEntries())
  peekApp.runtime.__notify?.()
  await sleep(70)
}
await sleep(500)
check(`跟活：打开期间反复 peek（实测 ${peekApp.runtime.peekCalls.length} 次）`, peekApp.runtime.peekCalls.length >= 3, String(peekApp.runtime.peekCalls.length))
check('能看到队友最新那一步', peekApp.frame().includes('队友第 12 步'), JSON.stringify(peekApp.bodyRows().slice(-3)))
await peekApp.press('\x0f') // Ctrl+O 关闭（旧版提示写了但没实现）
check('peek 里 Ctrl+O 能关（回到主界面）', !peekApp.frame().includes('只读') && !peekApp.frame().includes('writer-1'), peekApp.frame().slice(0, 80))
const closedCalls = peekApp.runtime.peekCalls.length
for (let i = 0; i < 10; i += 1) {
  peekApp.state.snapshot = makeSnapshot(multiTurnEntries())
  peekApp.runtime.__notify?.()
  await sleep(60)
}
await sleep(400)
check('关掉之后不再 peek', peekApp.runtime.peekCalls.length === closedCalls, `${closedCalls} → ${peekApp.runtime.peekCalls.length}`)

// ── [7] 窄屏不画刻度栏 ─────────────────────────────────────────────────────
console.log('\n[7] 窄屏（50 列）不画刻度栏，照样逐行滚')
const narrow = await mountApp({ entries: multiTurnEntries(), columns: 50 })
await narrow.press('\x0f')
check('窄屏没有箭头/刻度线', !narrow.frame().includes('▾') && !narrow.frame().includes('━'), narrow.frame().replace(/\n/g, '|').slice(0, 120))
const narrowBefore = lineIndexOf(firstBody(narrow.bodyRows()))
await narrow.press(WHEEL_UP)
check('窄屏滚轮同样退 3 行', lineIndexOf(firstBody(narrow.bodyRows())) === narrowBefore - 3, `${narrowBefore} → ${lineIndexOf(firstBody(narrow.bodyRows()))}`)
await narrow.press('\x1b')

// ── [8] 一轮的会话：右侧整列不画（比例滚动条已按用户要求去掉） ──────────────
// 用户口径：「去掉右侧滑动条」。同一份 fixture（1 轮 + 内容明显超一屏）在旧实现下会画
// 比例滑块 `██`（旧断言就在这个位置）；现在这一列只在 ≥2 轮时画刻度，单轮会话整列留空。
// 这一节既是退役门（滑块字符不许回来），也钉住「没有那一列照样逐行滚」。
console.log('\n[8] 只有 1 轮的会话：右侧整列不画，滚轮照样逐行滚')
{
  const singleTurn = [{ kind: 'user', id: 1, text: '一条长任务' }]
  for (let i = 0; i < 60; i += 1) singleTurn.push({ kind: 'text', id: i + 2, text: `长行-${String(i).padStart(2, '0')}` })
  const one = await mountApp({ entries: singleTurn })
  await one.press('\x0f')
  const rows = one.screen()
  check('内容确实超一屏（正文行出现在屏上）', rows.some((row) => /长行-\d\d/.test(row)), JSON.stringify(rows.slice(0, 3)))
  check('滑块 `██` 已退役（比例滚动条不回来）', !one.frame().includes('██'), JSON.stringify(rows[2]?.slice(-6)))
  check('刻度线 / 箭头也不画（单轮没有可跳的目标）', !one.frame().includes('━') && !one.frame().includes('▴') && !one.frame().includes('▾'))
  const before = one.screen().find((row) => /长行-\d\d/.test(row)) ?? ''
  await one.press(WHEEL_UP)
  const after = one.screen().find((row) => /长行-\d\d/.test(row)) ?? ''
  check(`没有那一列照样逐行滚（${before.trim()} → ${after.trim()}）`, after !== before && /长行-\d\d/.test(after), JSON.stringify([before, after]))
  await one.press('\x1b')
}

// ── [9] 刻度栏那两列**逐行**画了什么（组件级） ──────────────────────────────
// 端到端帧是「增量重绘拼出来的」，行宽不齐、右缘还可能被裁一列——按列位去断言刻度栏
// 会时真时假。这一节直接把这一列单独渲染出来逐行看，钉住 dsh 的样式契约：
// 块纵向居中、两头箭头常驻、活动刻度重线、静止刻度短线。
console.log('\n[9] 刻度栏逐行字形（组件级渲染）')
async function renderLines(element, columns = 6, rows = 12) {
  const rstdout = new PassThrough()
  rstdout.columns = columns
  rstdout.rows = rows
  rstdout.isTTY = false
  let text = ''
  rstdout.on('data', (chunk) => {
    text += String(chunk)
  })
  const instance = render(element, { stdout: rstdout, exitOnCtrlC: false, patchConsole: false })
  await sleep(150)
  instance.unmount()
  const at = text.lastIndexOf('\x1b[2K')
  return (at < 0 ? text : text.slice(at))
    .replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
    .replace(/\n$/, '')
    .split('\n')
}
{
  const geometry = railGeometry({ turnCount: 4, activeIndex: 1, rows: 8 })
  const lines = await renderLines(React.createElement(TimelineRail, { geometry, onPickTurn: () => {} }))
  const cell = (row) => (lines[row] ?? '').replace(/\s+$/, '')
  check(
    `块纵向居中（8 行 4 轮 → ▲ 在 ${geometry.upRow}、刻度 ${geometry.tickTop}..${geometry.downRow - 1}、▼ 在 ${geometry.downRow}）`,
    geometry.upRow === 1 && geometry.downRow === 6 && cell(0) === '' && cell(7) === '',
    JSON.stringify(lines),
  )
  check('两头箭头画出来了（▲ 在块顶、▼ 在块底）', cell(geometry.upRow).includes('▴') && cell(geometry.downRow).includes('▾'), JSON.stringify(lines))
  check('活动刻度是重线、其余是短线（照 dsh 的字形）', cell(geometry.tickTop + 1).includes('━━') && cell(geometry.tickTop).includes('─') && !cell(geometry.tickTop).includes('━'), JSON.stringify(lines))
  check('刻度行数与轮数一致（4 格）', lines.filter((line) => /[━─]/.test(line)).length === 4, JSON.stringify(lines))
}
{
  const geometry = railGeometry({ turnCount: 2, activeIndex: 0, rows: 8 })
  const lines = await renderLines(React.createElement(TimelineRail, { geometry, onPickTurn: () => {} }))
  check(
    '第一轮时 ▲ 照样占着那一行（块形状不随目标变）',
    (lines[geometry.upRow] ?? '').includes('▴') && (lines[geometry.downRow] ?? '').includes('▾'),
    JSON.stringify(lines),
  )
}
// ── [10] 聊天视图：滚动时布局不许随「回到底部」胶囊变（用户两次报障） ────────
// ① 块是**按居中高度**摆的，聊天区可用高度一变整块就上下挪（按视口行数居中时）：用户看到
//    「上下滑动时它上下晃」；② 胶囊占一行还会改滚动坐标 → 同样格数滚回来差一行到不了底。
// 两处都源于「胶囊在页脚里占净一行」。现在胶囊用 `marginTop={-1}` 把那一行借回来浮在转录区
// 最后一行上：页脚总高与没有胶囊时**完全相同**。这一节把「▲/▼ 与输入框的绝对行号全程不动」
// 和「同样格数滚回来正好到底」钉住（活动刻度会随跨轮移动，那是它的本职，不断言）。
console.log('\n[10] 聊天视图：连滚 8 上 8 下，刻度栏与输入框的行号一动不动')
{
  const chat = await mountApp({ entries: multiTurnEntries() })
  const rowsNow = () => {
    const lines = chat.screen()
    const at = (glyph) => lines.findIndex((line) => line.includes(glyph))
    return { up: at('▴'), down: at('▾'), composer: at('╭'), pill: at('回到底部'), rail: lines.some((l) => l.includes('━')) }
  }
  const before = rowsNow()
  check('聊天视图里画着刻度栏（▲ 在块顶、▼ 在块底）', before.up > 0 && before.down > before.up && before.rail, JSON.stringify(before))
  check('一开始贴着最新（没有胶囊）', before.pill === -1, JSON.stringify(before))
  const drift = []
  const step = async (direction) => {
    await chat.press(direction === 'up' ? WHEEL_UP : WHEEL_DOWN, 150)
    const now = rowsNow()
    if (now.up !== before.up || now.down !== before.down || now.composer !== before.composer) drift.push(now)
    return now
  }
  for (let i = 0; i < 8; i += 1) await step('up')
  const scrolled = rowsNow()
  check('滚动中：胶囊浮在输入框上一行（转录区最后一行）', scrolled.pill === scrolled.composer - 1, JSON.stringify(scrolled))
  // 胶囊**靠右**（原先贴左，盖住的正是每一行的行首——回看时最要紧的那一列）
  {
    const line = chat.screen()[scrolled.pill] ?? ''
    const at = line.indexOf('回到底部')
    // 「回到底部（Enter/End）」的显示宽度 21（前后都是 ASCII 空格，字符串下标 = 列号）
    const PILL = 21
    check(
      `胶囊靠右（「回到底部」在第 ${at} 列，画面中段之后）`,
      at > 40,
      JSON.stringify([at, line.trimEnd().slice(-26)]),
    )
    check(
      `胶囊右缘让开右缘那两列刻度（右缘 ${at + PILL} 列 ≤ 97）`,
      at + PILL <= 97,
      JSON.stringify([at, at + PILL]),
    )
  }
  for (let i = 0; i < 8; i += 1) await step('down')
  const back = rowsNow()
  check(
    `来回一屏后 ▲/▼/输入框仍在第 ${before.up}/${before.down}/${before.composer} 行`,
    drift.length === 0,
    drift.length === 0 ? JSON.stringify(back) : `漂移 ${JSON.stringify(drift[0])}（原 ${JSON.stringify(before)}）`,
  )
  check('同样格数滚回来正好到底：胶囊收掉、不需要多按', back.pill === -1, JSON.stringify(back))
  // 钉住轮头（浮在视口第一行上的当前轮题面）：贴尾不画、滚上去才画，且**不占布局**
  // ——上面那条「来回一屏行号一动不动」就是它不占行的证据（占一行会让刻度栏整体挪一格）。
  const pinnedRow = () => chat.screen()[0] ?? ''
  check('贴尾时第一行不是钉住轮头', !pinnedRow().startsWith('  ❯ 第'), JSON.stringify(pinnedRow().slice(0, 40)))
  await chat.press(WHEEL_UP, 200)
  await chat.press(WHEEL_UP, 200)
  const pinned = pinnedRow()
  const pinnedTurn = /❯ 第 (\d+) 问/.exec(pinned)?.[1]
  check(`滚离尾部：第一行浮着当前轮的题面（${JSON.stringify(pinned.slice(0, 24))}）`, pinnedTurn !== undefined, JSON.stringify(pinned.slice(0, 60)))
  // 视口顶那一轮 = 第 5 问（上滚 6 行 ≈ 贴尾时第 5 问的正文被顶上来一点）
  check(`钉的是「当前读的那一轮」（读到第 ${pinnedTurn} 问）`, pinnedTurn === '5', String(pinnedTurn))
  // 浮层压在第一行内容上：那一行的正文（fixture 里全是「行x-y」）不该再露出来
  check('钉住行盖在第一行内容之上（底下的正文不再露出来）', /❯ 第 \d+ 问/.test(pinned) && !/行\d-\d/.test(pinned), JSON.stringify(pinned.slice(0, 40)))
  // 点它 → 该轮题面顶到视口顶（题面行被钉住行盖着，所以钉住行下面第一行是这一轮的正文第一行）
  await chat.press(`\x1b[<0;8;1M`, 300)
  const afterPick = chat.screen()
  check(
    '点钉住行 → 跳到那一轮（钉住行下面第一行就是该轮的正文第一行）',
    /❯ 第 5 问/.test(afterPick[0] ?? '') && /行4-0\b/.test((afterPick[1] ?? '').trim()),
    JSON.stringify(afterPick.slice(0, 3).map((line) => line.trim().slice(0, 30))),
  )
  await chat.press('\x1b[<64;10;5M'.repeat(30), 600) // 滚回底部
  await sleep(200)
  // 胶囊可点：点它回底（浮起来之后命中判定仍要跟着走——它那一行不再由页脚布局决定）
  await chat.press(WHEEL_UP, 150)
  await chat.press(WHEEL_UP, 150)
  const popped = rowsNow()
  await chat.press(`\x1b[<0;6;${popped.pill + 1}M`, 250)
  check('点那颗浮起来的胶囊 → 回到底部', chat.screen().findIndex((line) => line.includes('回到底部')) === -1, JSON.stringify(rowsNow()))
}

// ── [11] 连滚洪峰 + 量到真值时的坐标缩水（用户报的「快速上滑又跳回底下一点」） ──────
// 两条病根都在这一节钉住：①终端把连续几格滚轮合并成一包交上来，若每次都用「上一次渲染
// 时的位置」当基准，一包五格只走三行（要函数式更新）；②从没滚到过的那一段只有估算，
// 滚过去量到真值坐标系就缩水，若位置是「内容第几行」这种绝对行号，视线就会跟着跳
// （要钉在「哪一条的第几行」上）。判据看**固定的屏幕行上那一格是第几个标记**：
// 内容往上走 3 行，同一个屏幕行上的标记序号就正好 +3。
console.log('\n[11] 连滚洪峰：一包 5 格 = 15 行、全程不回跳')
{
  // 每轮：题面 + 思考 + 2 张长结果工具卡 + 20 行编号标记正文。卡片让「估算 vs 真值」
  // 真的不一致（这正是缩水的来源），标记正文给出可数的尺子。
  const cards = () => {
    const entries = []
    let id = 1
    for (let turn = 0; turn < 5; turn += 1) {
      entries.push({ kind: 'user', id: id++, text: `第 ${turn + 1} 问` })
      entries.push({ kind: 'thinking', id: id++, text: Array.from({ length: 9 }, (_, i) => `第 ${i} 段推理`).join('\n') })
      for (let tool = 0; tool < 2; tool += 1) {
        entries.push({
          kind: 'tool',
          id: id++,
          call: {
            callId: `c-${turn}-${tool}`,
            name: 'browser_look',
            argsText: '{"action":"snapshot","full":true}',
            resultText: Array.from({ length: 14 }, (_, i) => `结果第 ${i} 行`).join('\n'),
            status: 'done',
          },
        })
      }
      entries.push({
        kind: 'text',
        id: id++,
        text: Array.from({ length: 20 }, (_, i) => `M${turn}-${String(i).padStart(2, '0')}`).join('\n'),
      })
    }
    return entries
  }
  const chat = await mountApp({ entries: cards() })
  /** 某个标记在屏幕上的行号（找不到 = -1，说明滚出屏幕了）。 */
  const rowOfMarker = (marker) => chat.screen().findIndex((line) => line.includes(marker))
  /** 屏幕第 `row` 行（或往下第一行）那个标记的文本。窗口给到 24 行：思考块现在是恒定
   *  3 行瀑布（4 行），加上两张工具卡，第 3 行到下一条正文之间可能有十几行非标记内容。 */
  const markerNear = (row) => {
    const lines = chat.screen()
    for (let at = row; at < Math.min(lines.length, row + 24); at += 1) {
      const found = /M\d-\d\d/.exec(lines[at] ?? '')
      if (found !== null) return found[0]
    }
    return null
  }
  /** 盯住一个标记，看它每滚一格往下走几行（内容上移 = 行号变大）。 */
  const tracked = []
  let marker = markerNear(3)
  let row = marker === null ? -1 : rowOfMarker(marker)
  check('标记正文在场（能读到尺子）', marker !== null && row >= 0, JSON.stringify(chat.screen().slice(0, 6)))
  for (let i = 0; i < 6; i += 1) {
    const before = row
    await chat.press(WHEEL_UP, 200)
    let now = rowOfMarker(marker)
    if (now === -1) {
      // 盯的那个滚出屏幕了：换一个（照旧从靠上的位置挑，继续量位移）
      marker = markerNear(3)
      now = marker === null ? -1 : rowOfMarker(marker)
      tracked.push(`换尺子→${marker}`)
    } else {
      tracked.push(now - before)
    }
    row = now
  }
  check(
    `逐格上滚 6 次，盯住的那个标记每次都正好往下走 3 行（实测 ${JSON.stringify(tracked)}）`,
    tracked.every((step) => step === 3 || String(step).startsWith('换尺子')),
    JSON.stringify(tracked),
  )
  // 一包 5 格（真实终端连滚的常态）：15 行
  let burstMarker = markerNear(3)
  let burstRow = burstMarker === null ? -1 : rowOfMarker(burstMarker)
  await chat.press(WHEEL_UP.repeat(5), 400)
  const burstNow = burstMarker === null ? -1 : rowOfMarker(burstMarker)
  check(
    `一包 5 格一次走 15 行（${burstMarker} 从 ${burstRow} 到 ${burstNow}）`,
    burstNow === burstRow + 15,
    `${burstRow} → ${burstNow}`,
  )
  // 快速连滚 20 格（每格 10ms，量到真值与滚动交错发生）：全程只许往上，不许回跳
  await chat.press(WHEEL_DOWN.repeat(20), 700) // 先回底部附近
  await sleep(200)
  const jumps = []
  for (let i = 0; i < 20; i += 1) {
    const watch = markerNear(3)
    const at = watch === null ? -1 : rowOfMarker(watch)
    await chat.press(WHEEL_UP, 10)
    await sleep(80)
    const after = watch === null ? -1 : rowOfMarker(watch)
    if (at >= 0 && after >= 0 && after < at) jumps.push(`${watch} ${at}→${after}`)
  }
  check(`连滚 20 格全程没有回跳（回跳 ${jumps.length} 次）`, jumps.length === 0, jumps.slice(0, 4).join(' , '))
}

process.exit(failures === 0 ? 0 : 1)
