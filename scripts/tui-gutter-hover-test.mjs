/**
 * 刻度列 / 比例滚动条的**悬停读数与拖动 scrub**测试（真 App + 假 runtime + SGR 鼠标事件）。
 *
 * 钉住四件事：
 *   [1] `parseMouse`：一包多条（终端把连着发生的事件攒一包发，旧锚定正则整包丢）要全取出来，
 *       而「纯鼠标包」之外的东西一律不认（粘贴文本里带 `[<1;2;3M` 也不能被吞）；
 *   [2] `pointer` 那个小 store：列判定（刻度列在页边距之内）+「值没变不通知」；
 *   [3] 悬停读数条：停住 250ms 才弹、弹出来就跟着行走、离开刻度列就消失，内容是那一轮题面；
 *   [4] 拖动 = 按住左键划过刻度列（scrub），且**只对认拖动的区**生效（点胶囊能回底、拖胶囊不行）。
 *
 * 鼠标事件一律走真实 SGR 序列（`\x1b[<b;x;yM`）：验的是整条链路（App 解析 → 命中区判定 →
 * 读数条/跳转），不是某个纯函数。
 *
 * 用法：pnpm build && node scripts/tui-gutter-hover-test.mjs
 *
 * @module dsc/scripts/tui-gutter-hover-test
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'

const home = mkdtempSync(join(tmpdir(), 'dsc-hover-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')

const { App } = await import('../lib/app/App.js')
const { parseMouse } = await import('../lib/app/mouse.js')
const { clearPointer, onGutter, publishPointer, readPointer } = await import('../lib/app/pointer.js')
const { RAIL_WIDTH } = await import('../lib/app/scroll-model.js')
const { displayWidth } = await import('../lib/app/display-width.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 帧里某个字形所在的**终端列号**（1 基）。
 *
 * 不能直接用 `indexOf`：帧是剥了 ANSI 的**字符串**，CJK 宽字符占两列，字符串下标会把
 * 后面的列号整体算小（本仓的 fixture 全是中文，实测偏十列）。按显示宽度从行首累加才是列。
 */
const colOf = (line, glyph) => displayWidth(line.slice(0, line.indexOf(glyph))) + 1

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log('刻度列悬停 / 拖动测试')

// ── [1] parseMouse：一包多条与「纯鼠标包」判定 ────────────────────────────────
{
  const one = parseMouse('[<64;10;5M')
  check('单条滚轮：1 条事件、button 64、press', one !== null && one.length === 1 && one[0].button === 64 && one[0].col === 10 && one[0].row === 5 && one[0].press === true, JSON.stringify(one))
  check('松开（小写 m）读作 press=false', parseMouse('[<0;3;4m')?.[0].press === false)
  const burst = parseMouse('[<64;10;5M\x1b[<64;10;6M\x1b[<35;98;9M')
  check(
    `一包三条全部取出（含中间残留的 ESC）`,
    burst !== null && burst.length === 3 && burst[1].button === 64 && burst[2].button === 35 && burst[2].col === 98,
    JSON.stringify(burst),
  )
  const bits = parseMouse('[<32;98;18M')?.[0]
  check('拖动 = button 32（低两位仍是左键、32 位是移动）', bits !== undefined && (bits.button & 3) === 0 && (bits.button & 32) !== 0)
  const motion = parseMouse('[<35;98;18M')?.[0]
  check('纯移动 = button 35（低两位 3 = 没有按键）', motion !== undefined && (motion.button & 3) === 3 && (motion.button & 32) !== 0)
  check('不是鼠标包（普通按键）返回 null', parseMouse('a') === null && parseMouse('') === null)
  check(
    '混了别的字符就不认（粘贴文本里的 `[<1;2;3M` 不会被吞）',
    parseMouse('看看这个 [<0;1;2M 哈哈哈哈') === null,
    JSON.stringify(parseMouse('看看这个 [<0;1;2M 哈哈哈哈')),
  )
}

// ── [2] pointer：列判定与通知语义 ───────────────────────────────────────────
{
  const columns = 100
  const gutterCol = columns - 2 - RAIL_WIDTH + 1 // 页边距 2 列之内侧，刻度列的第一列（1 基）
  check(
    `列判定：刻度列那两列算（${gutterCol}/${gutterCol + 1}），左边一列不算`,
    onGutter(gutterCol, columns) && onGutter(gutterCol + 1, columns) && !onGutter(gutterCol - 1, columns),
    JSON.stringify([gutterCol, onGutter(gutterCol - 1, columns)]),
  )
  clearPointer()
  let notices = 0
  const stop = (() => {
    // 直接用 store 的订阅面（组件那层是同一份）：这里只数通知次数
    const before = readPointer()
    return { before }
  })()
  // 通过在刻度列上连发同一行来数通知：读值不变即为「没通知」。用两次 publish 之间的
  // 读值对比代替订阅（拉模型，够验语义）。
  publishPointer(10, 5, columns)
  const outside = readPointer()
  publishPointer(gutterCol, 5, columns)
  const first = readPointer()
  publishPointer(gutterCol + 1, 5, columns) // 同一行、同一列内 → 值不变
  const same = readPointer()
  publishPointer(gutterCol, 9, columns)
  const moved = readPointer()
  clearPointer()
  check('指针在正文列上：读作 null（订阅者一次都不会重渲染）', outside === null && stop.before === null, JSON.stringify([stop.before, outside]))
  check('指针进刻度列：读作行号', first === 5, String(first))
  check('同一行内挪一格：读值不变（store 层就没通知）', same === 5, String(same))
  check('换一行：读值跟着换', moved === 9, String(moved))
  check('清场后读作 null', readPointer() === null)
}

// ── 真 App 的挂载脚手架 ────────────────────────────────────────────────────
function makeSnapshot(entries) {
  return {
    entries,
    sessions: [],
    sessionsLoading: false,
    sessionStates: {},
    subagents: [],
    queued: [],
    notices: [],
    status: { turnState: 'idle', model: 'test-model', effort: 'medium', usage: null, contextWindow: 1_000_000, sessionId: '/w/s.jsonl', cwd: '/w' },
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

async function mountApp({ entries, columns = 100, rows = 40 }) {
  const state = { snapshot: makeSnapshot(entries) }
  const runtime = {
    subscribe(listener) { runtime.__notify = listener; return () => {} },
    getSnapshot: () => state.snapshot,
    peekTranscript: () => Promise.resolve([]),
    listModels: () => [], listPresets: () => [], listSkills: () => [], listTeammates: () => [],
    getSettingsSections: () => [], getUiPrefs: () => ({ statusBar: undefined }),
    dock: () => Promise.resolve({ entries: [] }),
    submit() {}, openSession() {}, refreshSessions: () => Promise.resolve(),
    archiveSessions: () => Promise.resolve({ ok: true }), restoreSessions: () => Promise.resolve({ ok: true }),
    purgeSessions: () => Promise.resolve({ ok: true }), renameSession: () => Promise.resolve({ ok: true }),
    setSessionPinned: () => Promise.resolve({ ok: true }), forkSession: () => Promise.resolve({ ok: true }),
    usePreset: () => Promise.resolve({ ok: true }), setModel() {}, interrupt() {}, exit() {},
    answerApproval() {}, answerQuestion() {}, answerPlan() {},
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
  stdout.on('data', (chunk) => { output += String(chunk) })
  render(React.createElement(App, { runtime }), { stdin, stdout, exitOnCtrlC: false, patchConsole: false })
  await sleep(240)
  /** 最近一屏（非 TTY 时整帧追加，取尾部 rows − 1 行）。没有新帧就沿用上一屏。 */
  let lastScreen = []
  const screen = () => {
    const lines = output.split('\n').map((line) => line.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')).filter((l, i, all) => !(i === all.length - 1 && l === ''))
    if (lines.length > 0) lastScreen = lines.slice(-(rows - 1))
    return lastScreen
  }
  const press = async (keys, ms = 220) => {
    output = ''
    stdin.write(keys)
    await sleep(ms)
    return screen()
  }
  return { runtime, state, screen, press, columns }
}

/** 8 轮，每轮 1 条题面 + 12 行正文（刻度栏放得下 8 格）。 */
const turnEntries = () => {
  const entries = []
  let id = 1
  for (let turn = 0; turn < 8; turn += 1) {
    entries.push({ kind: 'user', id: id++, text: `第 ${turn + 1} 问：帮我看一下 ${turn} 号问题` })
    for (let i = 0; i < 12; i += 1) entries.push({ kind: 'text', id: id++, text: `行${turn}-${i}` })
  }
  return entries
}

// ── [3] 悬停读数条 ─────────────────────────────────────────────────────────
console.log('\n[3] 悬停刻度列：停住弹读数条、跟着行走、离开消失')
{
  const app = await mountApp({ entries: turnEntries() })
  await app.press('\x1b[<64;10;5M\x1b[<64;10;5M', 400) // 上滚 2 格：滚离尾部（钉住轮头在场）
  const lines = app.screen()
  const upRow = lines.findIndex((line) => line.includes('▴'))
  const railCol = colOf(lines[upRow] ?? '', '▴')
  check('刻度栏在场（能找到 ▲ 与它的列）', upRow > 0 && railCol > 3, JSON.stringify([upRow, railCol]))
  check(`▲ 那一列落在刻度列里（${railCol} 列，onGutter 认）`, onGutter(railCol, app.columns), JSON.stringify([railCol, app.columns]))
  const tickRow = upRow + 3
  /** 刻度行 → 轮号：▲ 自己占 upRow，第一格刻度在 upRow + 1，所以第 N 格（1 基）在 upRow + N。 */
  const turnAt = (row) => row - upRow

  await app.press(`\x1b[<35;${railCol};${tickRow + 1}M`, 120)
  check('刚停上去还在 dwell 里：不弹读数条（扫过不弹）', !app.screen().some((line) => /第 \d+ 轮 ·/.test(line)), JSON.stringify(app.screen().filter((l) => l.includes('第')).slice(0, 3)))
  await sleep(420) // dwell 250ms + 一帧渲染，留足余量（电池里机器可能正忙）
  const chip = app.screen()[tickRow] ?? ''
  check(
    `停住 250ms 后弹出读数条、浮在悬停那一行上、报的正是这一格（第 ${turnAt(tickRow)} 轮）`,
    new RegExp(`第 ${turnAt(tickRow)} 轮 · 第 ${turnAt(tickRow)} 问`).test(chip),
    JSON.stringify(chip),
  )
  check('读数条画的还是那一行的刻度（右侧刻度没被盖掉）', chip.includes('─'), JSON.stringify(chip.slice(-6)))

  const nextRow = tickRow + 2
  await app.press(`\x1b[<35;${railCol};${nextRow + 1}M`, 320)
  check(
    `换一行悬停：读数条跟着换到第 ${nextRow} 行、报第 ${turnAt(nextRow)} 轮`,
    new RegExp(`第 ${turnAt(nextRow)} 轮 ·`).test(app.screen()[nextRow] ?? ''),
    JSON.stringify(app.screen()[nextRow] ?? ''),
  )

  await app.press(`\x1b[<35;10;${nextRow + 1}M`, 320)
  check('指针离开刻度列：读数条收掉', !app.screen().some((line) => /第 \d+ 轮 ·/.test(line)))
}

// ── [4] 拖动 scrub：会话从「在刻度列上按下」开 ──────────────────────────────
console.log('\n[4] 从刻度列上按住划过 = 跳到那一行；松手即停；拖胶囊不算')
{
  const app = await mountApp({ entries: turnEntries() })
  await app.press('\x1b[<64;10;5M\x1b[<64;10;5M', 400)
  const lines = app.screen()
  const upRow = lines.findIndex((line) => line.includes('▴'))
  const railCol = colOf(lines[upRow] ?? '', '▴')
  /** 帧行 → 轮号（▲ 自己占 upRow，第一格刻度在 upRow + 1）。 */
  const turnAt = (row) => row - upRow
  const startRow = upRow + 2 // 第 2 轮那一格
  const targetRow = upRow + 5 // 第 5 轮那一格

  // 按下 = 点击语义（跳到那一格），**同时**把拖动会话开在刻度列上
  await app.press(`\x1b[<0;${railCol};${startRow + 1}M`, 350)
  check(
    `在刻度列上按下：跳到第 ${turnAt(startRow)} 轮（钉住轮头报同一轮）`,
    (app.screen()[0] ?? '').includes(`第 ${turnAt(startRow)} 问`),
    JSON.stringify(app.screen().slice(0, 2)),
  )
  // 按住划到另一格：会话里的命中按行算，视图跟着手走
  await app.press(`\x1b[<32;${railCol};${targetRow + 1}M`, 400)
  check(
    `按住划到第 ${turnAt(targetRow)} 轮那一格：视图跟到那一轮`,
    (app.screen()[0] ?? '').includes(`第 ${turnAt(targetRow)} 问`),
    JSON.stringify(app.screen().slice(0, 2)),
  )
  // 松手（0;x;ym）：会话结束——再划过刻度列也不跟了
  await app.press(`\x1b[<0;${railCol};${targetRow + 1}m`, 220)
  await app.press(`\x1b[<32;${railCol};${startRow + 1}M`, 400)
  check(
    '松手后再划过刻度列：不跟（会话只活在按下与松手之间）',
    (app.screen()[0] ?? '').includes(`第 ${turnAt(targetRow)} 问`),
    JSON.stringify(app.screen().slice(0, 2)),
  )
  // 反向：拖（按住）不算做「点击」——胶囊认点击、不认拖动
  const after = app.screen()
  await app.press('\x1b[<32;10;' + (after.findIndex((line) => line.includes('回到底部')) + 1) + 'M', 300)
  const stillAway = app.screen()
  check('按住拖过「回到底部」胶囊：不回底（胶囊不认拖动，防误触）', stillAway.some((line) => line.includes('回到底部')), JSON.stringify(stillAway.filter((l) => l.includes('回到底部'))))
  await app.press(`\x1b[<0;10;${stillAway.findIndex((line) => line.includes('回到底部')) + 1}M`, 320)
  check('同一处普通点击：回到底部（拖动与点击分流）', !app.screen().some((line) => line.includes('回到底部')))
}

// ── [5] 正文区：左键点 / 拖都不动滚动（用户报障回归） ───────────────────────
// 报障原形：「鼠标左键点击任意位置都被当做点击滑动条，会导致上下滑动」。病根是那一列的
// 命中判定**只判行**（行落在刻度块那一段就命中，列完全没看）。这一节把三条路都钉住：
// 正文列上的点击、正文里按住拖动、从正文按下再划进刻度列——画面一律不许动；而刻度列
// 自己的点击仍要能跳（列判定不能把功能修坏）。
console.log('\n[5] 正文里左键点/拖不再被当成点滚动条')
{
  const app = await mountApp({ entries: turnEntries() })
  await app.press('\x1b[<64;10;5M\x1b[<64;10;5M', 400) // 滚离尾部：钉住轮头在场，位置可观察
  const lines = app.screen()
  const upRow = lines.findIndex((line) => line.includes('▴'))
  const railCol = colOf(lines[upRow] ?? '', '▴')
  const row = upRow + 3 // 挑一行**右侧就是刻度**的正文行（旧实现只判行，点它会跳轮）
  const before = app.screen()[0] ?? ''
  check('起点：滚离尾部（钉住轮头报着当前轮）', /第 \d+ 问/.test(before), JSON.stringify(before))
  // ① 正文列上点一下（含松开）
  await app.press(`\x1b[<0;10;${row + 1}M\x1b[<0;10;${row + 1}m`, 320)
  check('正文列上点一下（同一行的右侧有刻度）：画面不动', (app.screen()[0] ?? '') === before, JSON.stringify([before, app.screen()[0]]))
  // ② 从正文按住往下划
  await app.press(`\x1b[<0;10;${row + 1}M`, 150)
  await app.press(`\x1b[<32;10;${upRow + 6}M`, 350)
  check('正文里按住拖动：画面不动', (app.screen()[0] ?? '') === before, JSON.stringify([before, app.screen()[0]]))
  // ③ 从正文按下、再划进刻度列那一列：会话没开在刻度列上，照样不动
  await app.press(`\x1b[<32;${railCol};${upRow + 2}M`, 350)
  check('从正文按下再划到刻度列：仍不动（会话只从刻度列上的按下开）', (app.screen()[0] ?? '') === before, JSON.stringify([before, app.screen()[0]]))
  // ④ 刻度列本身照样能点：跳轮功能没被列判定修坏
  await app.press(`\x1b[<0;${railCol};${upRow + 3}M`, 350)
  check('刻度列上点击：跳到第 2 轮（功能没被修坏）', /第 2 问/.test(app.screen()[0] ?? ''), JSON.stringify(app.screen().slice(0, 2)))
}

process.exit(failures === 0 ? 0 : 1)
