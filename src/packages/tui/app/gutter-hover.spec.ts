/**
 * 刻度列 / 比例滚动条的**悬停读数与拖动 scrub**（整条迁自 `scripts/tui-gutter-hover-test.mjs`）。
 *
 * ## 来源与分层
 *
 * 原探针钉四件事，全部落在 tui 层（node + 假终端，直读 src）：
 *
 *   [1] `parseMouse`：一包多条要全取出来，而「纯鼠标包」之外的东西一律不认；
 *   [2] `pointer` 小 store：列判定（刻度列在页边距之内）+「值没变不通知」；
 *   [3] 悬停读数条：停住 250ms 才弹、弹出来就跟着行走、离开刻度列就消失；
 *   [4] 拖动 = 按住左键划过刻度列（scrub），且只对认拖动的区生效；
 *   [5] 正文里左键点 / 拖不再被当成点滚动条（用户报障回归），刻度列自己的点击仍能跳。
 *
 * 鼠标事件一律走真实 SGR 序列（`\x1b[<b;x;yM`）：验的是整条链路（App 解析 → 命中区判定
 * → 读数条/跳转），不是某个纯函数。四段都在这一层有接缝，所以整条迁过来、探针可整删。
 *
 * ## 时序（与探针同款，不能换 settle）
 *
 * [3] 的「刚停上去还在 dwell 里」必须在进列后 **<250ms** 读帧——用「等输出稳定」的
 * settle 会把 dwell 等过去，断言就变成假绿。所以这里保留探针的固定 sleep 节奏：
 * `press(keys, ms)` 写键后等 ms 毫秒再读屏。
 *
 * @module dsc/packages/tui/app/gutter-hover.spec
 */
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { afterEach, describe, expect, test } from 'vitest'
import type { DscRuntime, RuntimeSnapshot, TranscriptEntry } from '@pneuma/runtime/contract.js'
import { displayWidth } from './display-width.js'
import { parseMouse } from './mouse.js'
import { clearPointer, onGutter, publishPointer, readPointer } from './pointer.js'
import { RAIL_WIDTH } from './scroll-model.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 帧里某个字形所在的**终端列号**（1 基）。
 *
 * 不能直接用 `indexOf`：帧是剥了 ANSI 的**字符串**，CJK 宽字符占两列，字符串下标会把
 * 后面的列号整体算小。按显示宽度从行首累加才是列。
 */
const colOf = (line: string, glyph: string): number => displayWidth(line.slice(0, line.indexOf(glyph))) + 1

describe('① parseMouse：一包多条与「纯鼠标包」判定', () => {
  test('单条滚轮：1 条事件、button 64、press', () => {
    const one = parseMouse('[<64;10;5M')
    expect(one).toHaveLength(1)
    expect(one?.[0]).toMatchObject({ button: 64, col: 10, row: 5, press: true })
  })

  test('松开（小写 m）读作 press=false', () => {
    expect(parseMouse('[<0;3;4m')?.[0].press).toBe(false)
  })

  test('一包三条全部取出（含中间残留的 ESC）', () => {
    const burst = parseMouse('[<64;10;5M\x1b[<64;10;6M\x1b[<35;98;9M')
    expect(burst).toHaveLength(3)
    expect(burst?.[1]?.button).toBe(64)
    expect(burst?.[2]?.button).toBe(35)
    expect(burst?.[2]?.col).toBe(98)
  })

  test('拖动 = button 32（低两位仍是左键、32 位是移动）', () => {
    const bits = parseMouse('[<32;98;18M')?.[0]
    expect((bits?.button ?? 0) & 3).toBe(0)
    expect((bits?.button ?? 0) & 32).not.toBe(0)
  })

  test('纯移动 = button 35（低两位 3 = 没有按键）', () => {
    const motion = parseMouse('[<35;98;18M')?.[0]
    expect((motion?.button ?? 0) & 3).toBe(3)
    expect((motion?.button ?? 0) & 32).not.toBe(0)
  })

  test('不是鼠标包（普通按键 / 空串）返回 null', () => {
    expect(parseMouse('a')).toBeNull()
    expect(parseMouse('')).toBeNull()
  })

  test('混了别的字符就不认（粘贴文本里的 `[<1;2;3M` 不会被吞）', () => {
    expect(parseMouse('看看这个 [<0;1;2M 哈哈哈哈')).toBeNull()
  })
})

describe('② pointer：列判定与通知语义', () => {
  const columns = 100
  const gutterCol = columns - 2 - RAIL_WIDTH + 1 // 页边距 2 列之内侧，刻度列的第一列（1 基）

  test('列判定：刻度列那两列算，左边一列不算', () => {
    expect(onGutter(gutterCol, columns)).toBe(true)
    expect(onGutter(gutterCol + 1, columns)).toBe(true)
    expect(onGutter(gutterCol - 1, columns)).toBe(false)
  })

  test('正文列读作 null；进刻度列读行号；同行挪一格值不变；换行值跟着换；清场回 null', () => {
    clearPointer()
    expect(readPointer()).toBeNull()
    publishPointer(10, 5, columns)
    expect(readPointer()).toBeNull()
    publishPointer(gutterCol, 5, columns)
    expect(readPointer()).toBe(5)
    publishPointer(gutterCol + 1, 5, columns) // 同一行、同一列内 → 值不变
    expect(readPointer()).toBe(5)
    publishPointer(gutterCol, 9, columns)
    expect(readPointer()).toBe(9)
    clearPointer()
    expect(readPointer()).toBeNull()
  })
})

/** 一条 120 行的流体：8 轮，每轮 1 条题面 + 12 行正文（刻度栏放得下 8 格）。 */
function turnEntries(): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let id = 1
  for (let turn = 0; turn < 8; turn += 1) {
    entries.push({ kind: 'user', id: id++, text: `第 ${turn + 1} 问：帮我看一下 ${turn} 号问题` })
    for (let i = 0; i < 12; i += 1) entries.push({ kind: 'text', id: id++, text: `行${turn}-${i}` })
  }
  return entries
}

/** App 读到的最小快照。 */
function makeSnapshot(entries: TranscriptEntry[]): RuntimeSnapshot {
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
  } as unknown as RuntimeSnapshot
}

/** 挂载后的读屏 / 按键句柄。 */
interface MountedApp {
  screen: () => string[]
  press: (keys: string, ms?: number) => Promise<string[]>
  columns: number
  unmount: () => void
}

/** 起一个真 App + 假 runtime；与探针同款的 fixed-sleep 读屏。 */
async function mountApp({ entries, columns = 100, rows = 40 }: { entries: TranscriptEntry[]; columns?: number; rows?: number }): Promise<MountedApp> {
  const { App } = await import('./App.js')
  const state = { snapshot: makeSnapshot(entries) }
  const runtime: Record<string, unknown> = {
    subscribe(listener: () => void) {
      runtime.__notify = listener
      return () => {}
    },
    getSnapshot: () => state.snapshot,
    peekTranscript: () => Promise.resolve([]),
    listModels: () => [],
    listPresets: () => [],
    listSkills: () => [],
    listTeammates: () => [],
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
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
  stdout.columns = columns
  stdout.rows = rows
  stdout.isTTY = false
  let output = ''
  stdout.on('data', (chunk: Buffer) => {
    output += String(chunk)
  })
  const instance = render(createElement(App as React.ComponentType<Record<string, unknown>>, { runtime, dispatchCommand: () => false }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await sleep(300)
  /** 最近一屏（非 TTY 时整帧追加，取尾部 rows − 1 行）。没有新帧就沿用上一屏。 */
  let lastScreen: string[] = []
  const screen = (): string[] => {
    const lines = output
      .split('\n')
      .map((line) => line.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, ''))
      .filter((line, index, all) => !(index === all.length - 1 && line === ''))
    if (lines.length > 0) lastScreen = lines.slice(-(rows - 1))
    return lastScreen
  }
  const press = async (keys: string, ms = 220): Promise<string[]> => {
    output = ''
    stdin.write(keys)
    await sleep(ms)
    return screen()
  }
  return { screen, press, columns, unmount: () => instance.unmount() }
}

/** 屏上「▲」所在行与它所在的终端列号；找不到行 = -1。 */
function railOf(lines: string[]): { upRow: number; railCol: number } {
  const upRow = lines.findIndex((line) => line.includes('▴'))
  return { upRow, railCol: upRow < 0 ? -1 : colOf(lines[upRow] ?? '', '▴') }
}

const mounted: MountedApp[] = []
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount()
  clearPointer()
})

async function mountWithRail(): Promise<MountedApp> {
  const app = await mountApp({ entries: turnEntries() })
  mounted.push(app)
  await app.press('\x1b[<64;10;5M\x1b[<64;10;5M', 400) // 上滚 2 格：滚离尾部
  return app
}

describe('③ 悬停刻度列：停住弹读数条、跟着行走、离开消失', () => {
  test('停住 250ms 才弹；换行跟着换；离开刻度列收掉', async () => {
    const app = await mountWithRail()
    const lines = app.screen()
    const { upRow, railCol } = railOf(lines)
    expect(upRow).toBeGreaterThan(0)
    expect(railCol).toBeGreaterThan(3)
    expect(onGutter(railCol, app.columns)).toBe(true)
    const tickRow = upRow + 3
    /** 刻度行 → 轮号：▲ 自己占 upRow，第一格刻度在 upRow + 1。 */
    const turnAt = (row: number): number => row - upRow

    await app.press(`\x1b[<35;${railCol};${tickRow + 1}M`, 120)
    expect(app.screen().some((line) => /第 \d+ 轮 ·/.test(line))).toBe(false)
    await sleep(420) // dwell 250ms + 一帧渲染，留足余量
    const chip = app.screen()[tickRow] ?? ''
    expect(chip).toMatch(new RegExp(`第 ${turnAt(tickRow)} 轮 · 第 ${turnAt(tickRow)} 问`))
    expect(chip).toContain('─') // 读数条画的还是那一行的刻度

    const nextRow = tickRow + 2
    await app.press(`\x1b[<35;${railCol};${nextRow + 1}M`, 320)
    expect(app.screen()[nextRow] ?? '').toMatch(new RegExp(`第 ${turnAt(nextRow)} 轮 ·`))

    await app.press(`\x1b[<35;10;${nextRow + 1}M`, 320)
    expect(app.screen().some((line) => /第 \d+ 轮 ·/.test(line))).toBe(false)
  })
})

describe('④ 从刻度列上按住划过 = 跳到那一行；松手即停；拖胶囊不算', () => {
  test('按下跳轮、拖动跟手、松手断开、拖胶囊不回底、点击胶囊回底', async () => {
    const app = await mountWithRail()
    const lines = app.screen()
    const { upRow, railCol } = railOf(lines)
    const turnAt = (row: number): number => row - upRow
    const startRow = upRow + 2 // 第 2 轮那一格
    const targetRow = upRow + 5 // 第 5 轮那一格

    // 按下 = 点击语义（跳到那一格），同时把拖动会话开在刻度列上
    await app.press(`\x1b[<0;${railCol};${startRow + 1}M`, 350)
    expect(app.screen()[0] ?? '').toContain(`第 ${turnAt(startRow)} 问`)
    // 按住划到另一格：会话里的命中按行算，视图跟着手走
    await app.press(`\x1b[<32;${railCol};${targetRow + 1}M`, 400)
    expect(app.screen()[0] ?? '').toContain(`第 ${turnAt(targetRow)} 问`)
    // 松手（0;x;ym）：会话结束——再划过刻度列也不跟了
    await app.press(`\x1b[<0;${railCol};${targetRow + 1}m`, 220)
    await app.press(`\x1b[<32;${railCol};${startRow + 1}M`, 400)
    expect(app.screen()[0] ?? '').toContain(`第 ${turnAt(targetRow)} 问`)

    // 反向：拖（按住）不算点击——胶囊认点击、不认拖动
    const after = app.screen()
    await app.press(`\x1b[<32;10;${after.findIndex((line) => line.includes('回到底部')) + 1}M`, 300)
    expect(app.screen().some((line) => line.includes('回到底部'))).toBe(true)
    await app.press(`\x1b[<0;10;${app.screen().findIndex((line) => line.includes('回到底部')) + 1}M`, 320)
    expect(app.screen().some((line) => line.includes('回到底部'))).toBe(false)
  })
})

describe('⑤ 正文里左键点 / 拖不再被当成点滚动条', () => {
  test('正文点、正文拖、从正文划进刻度列都不动；刻度列自己的点击仍能跳', async () => {
    const app = await mountWithRail()
    const lines = app.screen()
    const { upRow, railCol } = railOf(lines)
    const row = upRow + 3 // 一行右侧就是刻度的正文行（旧实现只判行，点它会跳轮）
    const before = app.screen()[0] ?? ''
    expect(before).toMatch(/第 \d+ 问/)

    // ① 正文列上点一下（含松开）
    await app.press(`\x1b[<0;10;${row + 1}M\x1b[<0;10;${row + 1}m`, 320)
    expect(app.screen()[0]).toBe(before)
    // ② 从正文按住往下划
    await app.press(`\x1b[<0;10;${row + 1}M`, 150)
    await app.press(`\x1b[<32;10;${upRow + 6}M`, 350)
    expect(app.screen()[0]).toBe(before)
    // ③ 从正文按下、再划进刻度列那一列：会话没开在刻度列上，照样不动
    await app.press(`\x1b[<32;${railCol};${upRow + 2}M`, 350)
    expect(app.screen()[0]).toBe(before)
    // ④ 刻度列本身照样能点：跳轮功能没被列判定修坏
    await app.press(`\x1b[<0;${railCol};${upRow + 3}M`, 350)
    expect(app.screen()[0] ?? '').toMatch(/第 2 问/)
  })
})
