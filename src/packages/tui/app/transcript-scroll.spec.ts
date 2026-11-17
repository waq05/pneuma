/**
 * 转录浮层的行滚动 / 刻度栏 / 子代理跟活测试（真 App + 假 runtime；迁自
 * `scripts/tui-transcript-scroll-test.mjs`）。
 *
 * 钉住的病根与行为：
 *   [1] 浮层打开时贴住最新，刻度栏（2 列）在场；
 *   [2] 滚轮一格 = 正好 3 行（按行滚动，不是按条）；
 *   [3] 一条比一屏还高的条目也能逐行读完——用户报的「点进子代看不到工作过程」；
 *   [4] 刻度栏：点子某一轮 → 那一轮的题面落到视口顶；[ / ] 跳上/下一轮；
 *   [5] PgUp/PgDn 翻一屏；滚到顶夹住、滚到底回跟尾；
 *   [6] 子代理转录「跟活」：打开期间反复 peek（节流 ≥400ms），Esc 关掉就停；
 *       peek 里 Ctrl+O 也能关（旧版提示这么写、代码没实现）；
 *   [7] 窄屏（<60 列）不画刻度栏，但照样能逐行滚；
 *   [8] 一轮的会话：右侧整列不画（比例滚动条已按用户要求去掉）；
 *   [9] 刻度栏那两列逐行画了什么（组件级渲染）；
 *   [10] 聊天视图连滚 8 上 8 下，刻度栏与输入框的行号一动不动（胶囊不占布局）；
 *   [11] 连滚洪峰：一包 5 格 = 15 行、全程不回跳。
 *
 * ## 探针侧的两个坑（都踩过，读帧必须沿用）
 *
 * `frame()` 读的是「最近一次写出的帧」，没有新帧时读到的是旧帧——那不是空屏，是屏幕没变；
 * `bodyRows()[0]` 是标题行，正文从 `[1]` 起。判「某一格落在第几行」用 `screen()`
 * （非 TTY 时 ink 逐帧整块追加，最后 `rows − 1` 行就是最后一帧），`frame()` 只判「在不在」。
 *
 * ## 时序
 *
 * 探针每个键固定 sleep；这里换成 composer.spec 同款「最少 150ms 且输出连续几拍不变」。
 * [6] 的跟活推快照循环、[11] 的快速连滚节奏是**驱动输入**（模拟真实终端的事件流），
 * 保留固定间隔——那是被测行为的一部分，不是等待。
 *
 * ## 隔离
 *
 * `tempHome()` + `DSC_HOME` 在 App 被加载之前换好（Composer 经 history-store 读
 * `~/.dsc/.tui-history`），App 动态 import。真实 `~/.dsc` 一个字节都不动。
 *
 * 归 `tui` project（`src/packages/tui/**` + node + 假 stdin/stdout，直读 src，不走 lib）。
 *
 * @module dsc/packages/tui/app/transcript-scroll.spec
 */
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { createElement } from 'react'
import { render } from 'ink'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { DscRuntime, RuntimeSnapshot, TranscriptEntry } from '@pneuma/runtime/contract.js'
import { tempHome } from '../../../../tests/harness.js'
import { commandsPlugin, runCommand } from '../../commands/index.js'
import { railGeometry } from './scroll-model.js'
import { displayWidth } from './display-width.js'

/** 临时主目录：`.tui-history` 落在它下面（真实 `~/.dsc` 不动）。 */
const home = tempHome('dsc-transcript-scroll-')
const originalDscHome = process.env.DSC_HOME
process.env.DSC_HOME = join(home.home, '.dsc')

/**
 * 与 `scripts/_tui-commands.mjs` 同款的最小假 ctx：把真的 commands 插件挂上去
 * （/agents 是命令，App 不直接 import 命令实现，派发口由宿主注入）。
 */
const commandCtx = {
  provide() {},
  get() {
    return undefined
  },
  effect(fn: () => void) {
    if (typeof fn === 'function') fn()
  },
  on() {
    return () => {}
  },
  emit() {},
  session: { current: () => ({ meta: { cwd: '/w', id: 'test' }, filePath: '/w/test.jsonl' }) },
  llm: {},
}
// cordis 的 apply 类型是 apply(ctx, config) 两参（config 由插件自己消费，commands 的
// 实现不读它）；单参调用是探针的既有形态，收窄成单参函数类型再调。
;(commandsPlugin.apply as (ctx: unknown) => void)(commandCtx)
const dispatchCommand = (input: string, runtime: DscRuntime, ui: unknown): boolean =>
  runCommand(input, runtime as DscRuntime, ui as Parameters<typeof runCommand>[2])

/** 帧里某个字形所在的终端列号（1 基）：CJK 占两列，必须按显示宽度从行首累加。 */
const colOf = (line: string, glyph: string) => displayWidth(line.slice(0, line.indexOf(glyph))) + 1

/** 一条 120 行的代码块：比一屏（33 行）高得多，验「一条超高条目也能逐行读」。 */
const TALL_TEXT = ['```text', ...Array.from({ length: 120 }, (_, i) => `长行${String(i).padStart(3, '0')}`), '```'].join(
  '\n',
)

/** 6 轮，每轮 1 条题面 + 19 条正文（每条 1 行）：轮与轮隔开 20 行，跳轮不会被尾部夹住。 */
function multiTurnEntries(): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let id = 1
  for (let turn = 0; turn < 6; turn += 1) {
    entries.push({ kind: 'user', id: id++, text: `第 ${turn + 1} 问` })
    for (let i = 0; i < 19; i += 1) entries.push({ kind: 'text', id: id++, text: `行${turn}-${i}` })
  }
  return entries
}

function makeSnapshot(entries: TranscriptEntry[]): RuntimeSnapshot {
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
  } as unknown as RuntimeSnapshot
}

interface MountOptions {
  entries: TranscriptEntry[]
  peek?: unknown
  columns?: number
  rows?: number
  teammates?: Array<Record<string, unknown>>
}

/** mount 出来的句柄（探针 mountApp 的返回集）。 */
interface MountedApp {
  runtime: Record<string, unknown> & { __notify?: () => void; peekCalls: string[] }
  state: { snapshot: RuntimeSnapshot }
  frame: () => string
  press: (keys: string) => Promise<string>
  bodyRows: () => string[]
  firstBody: () => string
  screen: () => string[]
  unmount: () => void
}

/** 起一个真 App + 假 runtime；等首帧稳定后返回读帧/按键的口。 */
async function mountApp({ entries, peek, columns = 100, rows = 40, teammates = [] }: MountOptions): Promise<MountedApp> {
  const { App } = await import('./App.js')
  const state = { snapshot: makeSnapshot(entries) }
  const runtime: Record<string, unknown> & { __notify?: () => void; peekCalls: string[] } = {
    peekCalls: [],
    subscribe(listener: () => void) {
      runtime.__notify = listener
      return () => {}
    },
    getSnapshot: () => state.snapshot,
    peekTranscript: (file: string) => {
      runtime.peekCalls.push(file)
      return Promise.resolve(typeof peek === 'function' ? (peek as (f: string) => unknown)(file) : (peek ?? []))
    },
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
  const instance = render(
    createElement(App as React.ComponentType<Record<string, unknown>>, { runtime, dispatchCommand }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await settleFrame(output)

  let lastFrame = ''
  /** 最近一次写出的帧；本次按键没有新帧（屏幕没变）就沿用上一帧（不是空屏）。 */
  const frame = () => {
    const idx = output.lastIndexOf('\x1b[2K')
    const tail = (idx < 0 ? output : output.slice(idx)).replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
    if (tail.replace(/\s/g, '') !== '') lastFrame = tail
    return lastFrame
  }
  /** 敲一段键序列，等帧稳定，返回最新帧。press 前清空累计输出——frame/screen 都基于本次输出。 */
  const press = async (keys: string): Promise<string> => {
    output = ''
    stdin.write(keys)
    await settleFrame(output)
    return frame()
  }
  /**
   * 浮层正文行：只去掉左右边框（刻度栏那两列留着——窄屏没有刻度栏，盲剥会吃掉正文开头）。
   * `[0]` 是标题行，正文从 `[1]` 起。题面行前面有一行空（ChatView 的 USER_TOP_GAP），
   * 所以「跳到某一轮」之后第一条非空正文行才是 `❯ …`，判据一律走 `firstBody()`。
   */
  const bodyRows = () =>
    frame()
      .replace(/\n$/, '')
      .split('\n')
      .filter((line) => line.startsWith('  │'))
      .map((line) => line.slice(3, -1))
  const firstBody = () => bodyRows().slice(1).find((row) => row.trim() !== '') ?? ''
  /**
   * 整屏行（按行号定位用）：非 TTY 时 ink 逐帧整块追加，取最后 `rows − 1` 行就是最后一帧。
   * 这一拍没有新帧（屏幕没变）就沿用上一屏——与 frame() 同一条规矩。
   */
  let lastScreen: string[] = []
  const screen = () => {
    const lines = output
      .split('\n')
      .map((line) => line.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, ''))
      .filter((line, index, all) => !(index === all.length - 1 && line === ''))
    if (lines.length > 0) lastScreen = lines.slice(-(rows - 1))
    return lastScreen
  }
  return {
    runtime,
    state,
    frame,
    press,
    bodyRows,
    firstBody,
    screen,
    unmount: () => instance.unmount(),
  }
}

/** 等这一帧写完：最少 150ms，且输出长度连续几拍不再变（composer.spec 同款）。 */
async function settleFrame(read: string, floorMs = 150, deadlineMs = 2_000): Promise<void> {
  const startedAt = Date.now()
  let previous = -1
  let stable = 0
  while (Date.now() < startedAt + deadlineMs) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 25))
    if (read.length === previous) stable += 1
    else {
      stable = 0
      previous = read.length
    }
    if (Date.now() - startedAt >= floorMs && stable >= 2) return
  }
}

/** 正文里「长行NNN」的序号（升序出现）。 */
const tallNumbers = (rows: string[]) =>
  rows.map((row) => /长行(\d{3})/.exec(row)?.[1]).filter((value) => value !== undefined).map(Number)

const WHEEL_UP = '\x1b[<64;20;10M'
const WHEEL_DOWN = '\x1b[<65;20;10M'
const PGUP = '\x1b[5~'
const PGDN = '\x1b[6~'

/** 正文定位的公共口径：「行x-y」的 (x,y) → 全文第 x*20+y+1 行。 */
const lineIndexOf = (row: string | undefined): number | null => {
  const match = row === undefined ? undefined : /行(\d)-(\d+)/.exec(row)
  return match === null || match === undefined ? null : Number(match[1]) * 20 + Number(match[2]) + 1
}

/** 多轮会话节（[1][2][4][5]）共用的那个 App。 */
let app: MountedApp | null = null
const allApps: Array<{ unmount: () => void }> = []
async function mount(options: MountOptions): Promise<MountedApp> {
  const mounted = await mountApp(options)
  allApps.push(mounted)
  return mounted
}

beforeAll(async () => {
  app = await mount({ entries: multiTurnEntries() })
  await app.press('\x0f') // Ctrl+O 打开回看浮层
})

afterAll(() => {
  for (const mounted of allApps) mounted.unmount()
  if (originalDscHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = originalDscHome
  home.restore()
})

// ── [1] 回看浮层：打开即贴尾、刻度栏在场 ──────────────────────────────────────

describe('[1] 回看浮层：打开即贴尾、刻度栏在场', () => {
  test('浮层打开（标题带条数）', () => {
    expect(app?.frame().includes('回看全文（共 120 条')).toBe(true)
  })

  test('跟上最新：可见区最后一行是最后一条', () => {
    expect(app?.bodyRows().some((row) => row.includes('行5-18'))).toBe(true)
  })

  test('刻度栏在场（上/下箭头 + 刻度线）', () => {
    const current = app?.frame() ?? ''
    expect(current.includes('▴') && current.includes('▾') && current.includes('━')).toBe(true)
  })

  test('刻度栏在正文右侧（箭头列靠右缘）', () => {
    const rows = (app?.frame() ?? '').replace(/\n$/, '').split('\n')
    const upRow = rows.findIndex((row) => row.includes('▴'))
    const railCol = colOf(rows[upRow] ?? '', '▴')
    const frameWidth = rows[2]?.length ?? 0
    expect(railCol, `col=${railCol} 宽=${frameWidth}`).toBeGreaterThan(frameWidth - 8)
  })

  test('刻度块纵向居中（▲/▼ 对视口中轴对称）', () => {
    const rows = (app?.frame() ?? '').replace(/\n$/, '').split('\n')
    const upRow = rows.findIndex((row) => row.includes('▴'))
    const downRow = rows.findIndex((row) => row.includes('▾'))
    // 视口首行 = 帧第 2 行（0 基：边框 + 标题各占一行），末行 = 倒数第三行（下面还有提示行与状态栏）
    const firstRow = 2
    const lastRow = rows.length - 5
    expect(upRow > firstRow && downRow < lastRow, `up=${upRow} down=${downRow} 总行=${rows.length}`).toBe(true)
    expect(Math.abs(upRow - firstRow - (lastRow - downRow)), `up=${upRow} down=${downRow}`).toBeLessThanOrEqual(1)
  })

  test('块高 = 轮数 + 2（6 轮 → ▲/6 格/▼）', () => {
    const rows = (app?.frame() ?? '').replace(/\n$/, '').split('\n')
    const upRow = rows.findIndex((row) => row.includes('▴'))
    const downRow = rows.findIndex((row) => row.includes('▾'))
    expect(downRow - upRow, `块高=${downRow - upRow}`).toBe(7)
  })
})

// ── [2] 滚轮一格 = 正好 3 行 ─────────────────────────────────────────────────

describe('[2] 滚轮一格 = 正好 3 行', () => {
  /** 贴尾时的顶行（上滚之前记录，两条用例共用——「回到原处」就是回到它）。 */
  let tailTop: number | null = null

  test('滚轮上 1 格后顶行正好退 3 行', async () => {
    const mounted = app!
    tailTop = lineIndexOf(mounted.bodyRows().find((row) => /行\d-\d+/.test(row)))
    await mounted.press(WHEEL_UP)
    const after = lineIndexOf(mounted.bodyRows().find((row) => /行\d-\d+/.test(row)))
    expect(after, `before=${tailTop} after=${after}`).toBe((tailTop ?? 0) - 3)
  })

  test('滚轮下 1 格回到原处', async () => {
    const mounted = app!
    await mounted.press(WHEEL_DOWN)
    expect(lineIndexOf(mounted.bodyRows().find((row) => /行\d-\d+/.test(row)))).toBe(tailTop)
  })
})

// ── [4] 刻度栏点击 / [ ] 跳轮 ────────────────────────────────────────────────

describe('[4] 刻度栏点击 / [ ] 跳轮', () => {
  /** ▲ 所在行（块顶）与活动刻度（━）所在行。 */
  const railUpRow = () => (app?.frame() ?? '').split('\n').findIndex((line) => line.includes('▴'))
  const activeRow = () => (app?.frame() ?? '').split('\n').findIndex((line) => line.includes('━'))
  /**
   * 点 ▲：照 dsh 的口径，读到本轮中段时 ▲ 先把本轮的题面顶到视口顶。
   * 列号照探针从**活动刻度行（━）**取：━━ 是双宽字形，它的左缘才是热区起点；
   * ▴ 那一格的 colOf 比它偏右一列，点过去落进边框（实测不命中）。
   */
  const clickUp = async (): Promise<string> => {
    const rows = (app?.frame() ?? '').split('\n')
    const railRow = rows.findIndex((line) => line.includes('━'))
    const railCol = railRow < 0 ? 0 : colOf(rows[railRow] ?? '', '━')
    return app!.press(`\x1b[<0;${railCol + 1};${railUpRow() + 1}M`)
  }

  test('刻度线能被找到（当前轮那条粗线）', () => {
    const rows = (app?.frame() ?? '').split('\n')
    const railRow = rows.findIndex((line) => line.includes('━'))
    const railCol = railRow < 0 ? -1 : colOf(rows[railRow] ?? '', '━')
    expect(railCol > 3 && railRow > 1, `row=${railRow} col=${railCol}`).toBe(true)
  })

  test('] 下一轮：往下跳（顶行变了）', async () => {
    const before = lineIndexOf(app!.bodyRows().find((row) => /行\d-\d+/.test(row)))
    const afterDown = await app!.press(']')
    expect(
      lineIndexOf(afterDown.split('\n').find((row) => /行\d-\d+/.test(row))) !== before ||
        afterDown.split('\n').some((row) => /第 \d 问/.test(row)),
    ).toBe(true)
  })

  test('点 ▲ → 当前轮的题面顶到视口顶（本轮中段先对齐本轮）', async () => {
    await clickUp()
    expect(app!.firstBody().includes('第 5 问'), JSON.stringify(app!.bodyRows().slice(1, 3))).toBe(true)
  })

  test('再点 ▲ → 退到上一轮（活动刻度上移一行）', async () => {
    const rowBeforeClick = activeRow()
    await clickUp()
    expect(activeRow(), `活动刻度 ${rowBeforeClick} → ${activeRow()}`).toBe(rowBeforeClick - 1)
  })

  test('[ 一直往回跳 → 第一问题面落到视口顶', async () => {
    await app!.press('\x1b') // 关掉浮层，重新用「跳到第一轮」的场景
    await app!.press('\x0f')
    for (let i = 0; i < 12; i += 1) await app!.press('[')
    expect(app!.firstBody().includes('第 1 问'), JSON.stringify(app!.bodyRows().slice(1, 3))).toBe(true)
  })

  test('第一轮时 ▲ 照样画着但点它没有任何反应（暗 = 空操作）', async () => {
    const bodyBefore = app!.bodyRows().join('|')
    const tickBefore = activeRow()
    await clickUp()
    expect(app!.bodyRows().join('|')).toBe(bodyBefore)
    expect(activeRow()).toBe(tickBefore)
  })

  test('] 下一轮 → 第二问题面落到视口顶', async () => {
    await app!.press(']')
    expect(app!.firstBody().includes('第 2 问'), JSON.stringify(app!.bodyRows().slice(1, 3))).toBe(true)
  })
})

// ── [5] PgUp/PgDn 与夹界 ────────────────────────────────────────────────────

describe('[5] PgUp/PgDn 与夹界', () => {
  test('PgDn 往下翻', async () => {
    const topBeforePage = lineIndexOf(app!.bodyRows().find((row) => /行\d-\d+/.test(row)))
    await app!.press(PGDN)
    const afterPageDown = lineIndexOf(app!.bodyRows().find((row) => /行\d-\d+/.test(row)))
    expect(afterPageDown !== null && afterPageDown > (topBeforePage ?? 0), `${topBeforePage} → ${afterPageDown}`).toBe(true)
  })

  test('PgUp 往上翻（回到或超过原处）', async () => {
    const topBeforePage = lineIndexOf(app!.bodyRows().find((row) => /行\d-\d+/.test(row)))
    await app!.press(PGUP)
    const after = lineIndexOf(app!.bodyRows().find((row) => /行\d-\d+/.test(row)))
    expect((after ?? 9999)).toBeLessThanOrEqual(topBeforePage ?? 9999)
  })

  test('滚到顶后夹住（第一问仍在顶）', async () => {
    for (let i = 0; i < 3; i += 1) await app!.press(PGUP)
    expect(app!.firstBody().includes('第 1 问'), JSON.stringify(app!.bodyRows().slice(1, 3))).toBe(true)
  })

  test('一直往下滚回到跟尾（看得见最后一条）', async () => {
    for (let i = 0; i < 5; i += 1) await app!.press(PGDN)
    expect(app!.bodyRows().some((row) => row.includes('行5-18')), JSON.stringify(app!.bodyRows().slice(-2))).toBe(true)
    await app!.press('\x1b')
  })
})

// ── [3] 一条比一屏还高的条目 ─────────────────────────────────────────────────

describe('[3] 一条超高条目也能逐行滚（用户报的病根）', () => {
  let tall: MountedApp

  beforeAll(async () => {
    tall = await mount({ entries: [{ kind: 'user', id: 1, text: TALL_TEXT }] })
    await tall.press('\x0f')
  })

  test('打开时停在尾部（看得见最后几行）', () => {
    expect(tallNumbers(tall.bodyRows()).includes(119), JSON.stringify(tallNumbers(tall.bodyRows()).slice(-3))).toBe(true)
  })

  test('滚轮一格后退 3 行', async () => {
    const tail = tallNumbers(tall.bodyRows())
    await tall.press(WHEEL_UP)
    const wheeled = tallNumbers(tall.bodyRows())
    expect(wheeled[0], `${tail[0]} → ${wheeled[0]}`).toBe((tail[0] ?? 0) - 3)
  })

  test('PgUp 再退一整屏', async () => {
    const tailFirst = tallNumbers(tall.bodyRows())[0] ?? 0
    await tall.press(PGUP)
    const paged = tallNumbers(tall.bodyRows())
    expect(tailFirst - (paged[0] ?? 0), `${tailFirst} → ${paged[0]}`).toBeGreaterThanOrEqual(20)
    await tall.press('\x1b')
  })
})

// ── [6] 子代理转录跟活 ──────────────────────────────────────────────────────

describe('[6] 子代理转录：跟活 + Ctrl+O 关闭', () => {
  let peekApp: MountedApp
  /** 队友在写：不断追加的转录条目（peek 每次回最新的）。 */
  const streamed: Array<Record<string, unknown>> = []

  beforeAll(async () => {
    peekApp = await mount({
      entries: multiTurnEntries(),
      peek: () => [...streamed],
      teammates: [
        {
          name: 'writer-1',
          role: 'writer',
          state: 'working',
          task: '写正文',
          file: '/w/agent-writer.jsonl',
          parent: 'lead',
          depth: 1,
          rounds: 2,
          startedAt: 1,
        },
      ],
    })
    await peekApp.press('/agents')
    await peekApp.press('\r') // 第一次回车 = 接受补全菜单里的 /agents
    await peekApp.press('\r') // 第二次回车 = 进选中那一行的转录
  })

  test('名单里能看到队友', () => {
    expect(peekApp.frame().includes('writer-1'), peekApp.frame().replace(/\n/g, '|').slice(0, 160)).toBe(true)
  })

  test('打开转录时先 peek 一次', () => {
    expect(peekApp.runtime.peekCalls.length).toBeGreaterThanOrEqual(1)
  })

  test('转录浮层是只读形态（提示行写了「只读」）', () => {
    expect(peekApp.frame().includes('只读'), peekApp.frame().slice(0, 60)).toBe(true)
  })

  test('跟活：打开期间反复 peek，能看到队友最新那一步', async () => {
    // 队友在写：不断推快照，转录应当跟着重放（70ms 一次是事件流的节奏，不是等待断言）
    for (let i = 0; i < 12; i += 1) {
      streamed.push({ kind: 'text', id: i + 1, text: `队友第 ${i + 1} 步` })
      peekApp.state.snapshot = makeSnapshot(multiTurnEntries())
      peekApp.runtime.__notify?.()
      await new Promise((resolveTick) => setTimeout(resolveTick, 70))
    }
    await settleFrame(peekApp.frame(), 400)
    expect(peekApp.runtime.peekCalls.length, `实测 ${peekApp.runtime.peekCalls.length} 次`).toBeGreaterThanOrEqual(3)
    expect(peekApp.frame().includes('队友第 12 步'), JSON.stringify(peekApp.bodyRows().slice(-3))).toBe(true)
  })

  test('peek 里 Ctrl+O 能关（回到主界面；旧版提示写了但没实现）', async () => {
    await peekApp.press('\x0f')
    expect(!peekApp.frame().includes('只读') && !peekApp.frame().includes('writer-1'), peekApp.frame().slice(0, 80)).toBe(true)
  })

  test('关掉之后不再 peek', async () => {
    const closedCalls = peekApp.runtime.peekCalls.length
    for (let i = 0; i < 10; i += 1) {
      peekApp.state.snapshot = makeSnapshot(multiTurnEntries())
      peekApp.runtime.__notify?.()
      await new Promise((resolveTick) => setTimeout(resolveTick, 60))
    }
    await settleFrame(peekApp.frame(), 300)
    expect(peekApp.runtime.peekCalls.length, `${closedCalls} → ${peekApp.runtime.peekCalls.length}`).toBe(closedCalls)
  })
})

// ── [7] 窄屏不画刻度栏 ──────────────────────────────────────────────────────

describe('[7] 窄屏（50 列）不画刻度栏，照样逐行滚', () => {
  let narrow: MountedApp
  let narrowBefore: number | null

  beforeAll(async () => {
    narrow = await mount({ entries: multiTurnEntries(), columns: 50 })
    await narrow.press('\x0f')
    narrowBefore = lineIndexOf(narrow.bodyRows().find((row) => /行\d-\d+/.test(row)))
  })

  test('窄屏没有箭头/刻度线', () => {
    expect(!narrow.frame().includes('▾') && !narrow.frame().includes('━'), narrow.frame().replace(/\n/g, '|').slice(0, 120)).toBe(true)
  })

  test('窄屏滚轮同样退 3 行', async () => {
    await narrow.press(WHEEL_UP)
    expect(lineIndexOf(narrow.bodyRows().find((row) => /行\d-\d+/.test(row))), `${narrowBefore} →`).toBe(
      (narrowBefore ?? 0) - 3,
    )
    await narrow.press('\x1b')
  })
})

// ── [8] 一轮的会话：右侧整列不画 ─────────────────────────────────────────────

describe('[8] 只有 1 轮的会话：右侧整列不画，滚轮照样逐行滚', () => {
  let one: MountedApp

  beforeAll(async () => {
    // 旧实现下同一份 fixture 会画比例滑块 `██`；现在这一列只在 ≥2 轮时画刻度。
    const singleTurn: TranscriptEntry[] = [{ kind: 'user', id: 1, text: '一条长任务' }]
    for (let i = 0; i < 60; i += 1) singleTurn.push({ kind: 'text', id: i + 2, text: `长行-${String(i).padStart(2, '0')}` })
    one = await mount({ entries: singleTurn })
    await one.press('\x0f')
  })

  test('内容确实超一屏（正文行出现在屏上）', () => {
    expect(one.screen().some((row) => /长行-\d\d/.test(row)), JSON.stringify(one.screen().slice(0, 3))).toBe(true)
  })

  test('滑块 ██ 已退役（比例滚动条不回来）', () => {
    expect(one.frame().includes('██'), JSON.stringify(one.screen()[2]?.slice(-6))).toBe(false)
  })

  test('刻度线 / 箭头也不画（单轮没有可跳的目标）', () => {
    expect(!one.frame().includes('━') && !one.frame().includes('▴') && !one.frame().includes('▾')).toBe(true)
  })

  test('没有那一列照样逐行滚', async () => {
    const before = one.screen().find((row) => /长行-\d\d/.test(row)) ?? ''
    await one.press(WHEEL_UP)
    const after = one.screen().find((row) => /长行-\d\d/.test(row)) ?? ''
    expect(after !== before && /长行-\d\d/.test(after), JSON.stringify([before, after])).toBe(true)
    await one.press('\x1b')
  })
})

// ── [9] 刻度栏那两列逐行画了什么（组件级渲染）─────────────────────────────────

/** 把一个小部件渲染成裸行（组件级，无 App）：返回剥了 ANSI 的行数组。 */
async function renderLines(element: React.ReactElement, columns = 6, rows = 12): Promise<string[]> {
  const rstdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
  rstdout.columns = columns
  rstdout.rows = rows
  rstdout.isTTY = false
  let text = ''
  rstdout.on('data', (chunk: Buffer) => {
    text += String(chunk)
  })
  const instance = render(element, {
    stdout: rstdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await new Promise((resolveTick) => setTimeout(resolveTick, 150))
  instance.unmount()
  const at = text.lastIndexOf('\x1b[2K')
  return (at < 0 ? text : text.slice(at))
    .replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
    .replace(/\n$/, '')
    .split('\n')
}

describe('[9] 刻度栏逐行字形（组件级渲染）', () => {
  test('8 行 4 轮：块纵向居中、两头箭头、活动刻度重线、其余短线', async () => {
    const { TimelineRail } = await import('./TimelineRail.js')
    const geometry = railGeometry({ turnCount: 4, activeIndex: 1, rows: 8 })
    const lines = await renderLines(createElement(TimelineRail, { geometry, onPickTurn: () => {} }))
    const cell = (row: number) => (lines[row] ?? '').replace(/\s+$/, '')
    expect(
      geometry.upRow === 1 && geometry.downRow === 6 && cell(0) === '' && cell(7) === '',
      `▲ 在 ${geometry.upRow}、刻度 ${geometry.tickTop}..${geometry.downRow - 1}、▼ 在 ${geometry.downRow}：${JSON.stringify(lines)}`,
    ).toBe(true)
    expect(cell(geometry.upRow).includes('▴') && cell(geometry.downRow).includes('▾'), JSON.stringify(lines)).toBe(true)
    expect(
      cell(geometry.tickTop + 1).includes('━━') && cell(geometry.tickTop).includes('─') && !cell(geometry.tickTop).includes('━'),
      JSON.stringify(lines),
    ).toBe(true)
    expect(lines.filter((line) => /[━─]/.test(line)).length, JSON.stringify(lines)).toBe(4)
  })

  test('第一轮时 ▲ 照样占着那一行（块形状不随目标变）', async () => {
    const { TimelineRail } = await import('./TimelineRail.js')
    const geometry = railGeometry({ turnCount: 2, activeIndex: 0, rows: 8 })
    const lines = await renderLines(createElement(TimelineRail, { geometry, onPickTurn: () => {} }))
    expect(
      (lines[geometry.upRow] ?? '').includes('▴') && (lines[geometry.downRow] ?? '').includes('▾'),
      JSON.stringify(lines),
    ).toBe(true)
  })
})

// ── [10] 聊天视图：滚动时布局不许随「回到底部」胶囊变 ──────────────────────────

describe('[10] 聊天视图：连滚 8 上 8 下，刻度栏与输入框的行号一动不动', () => {
  let chat: MountedApp
  /** 起始布局行号（▲/▼/输入框），漂移判据的基准。 */
  let before: { up: number; down: number; composer: number; pill: number; rail: boolean }

  /** 当前屏上各关键部件的行号。 */
  const rowsNow = () => {
    const lines = chat.screen()
    const at = (glyph: string) => lines.findIndex((line) => line.includes(glyph))
    return {
      up: at('▴'),
      down: at('▾'),
      composer: at('╭'),
      pill: at('回到底部'),
      rail: lines.some((line) => line.includes('━')),
    }
  }

  beforeAll(async () => {
    chat = await mount({ entries: multiTurnEntries() })
    before = rowsNow()
  })

  test('聊天视图里画着刻度栏（▲ 在块顶、▼ 在块底）', () => {
    expect(before.up > 0 && before.down > before.up && before.rail, JSON.stringify(before)).toBe(true)
  })

  test('一开始贴着最新（没有胶囊）', () => {
    expect(before.pill, JSON.stringify(before)).toBe(-1)
  })

  test('滚动中：胶囊浮在输入框上一行（转录区最后一行）', async () => {
    const drift: Array<{ up: number; down: number; composer: number; pill: number; rail: boolean }> = []
    for (let i = 0; i < 8; i += 1) {
      await chat.press(WHEEL_UP)
      const now = rowsNow()
      if (now.up !== before.up || now.down !== before.down || now.composer !== before.composer) drift.push(now)
    }
    const scrolled = rowsNow()
    expect(drift, `漂移 ${JSON.stringify(drift[0])}（原 ${JSON.stringify(before)}）`).toEqual([])
    expect(scrolled.pill, JSON.stringify(scrolled)).toBe(scrolled.composer - 1)
  })

  test('胶囊靠右，右缘让开右缘那两列刻度', () => {
    const line = chat.screen()[rowsNow().pill] ?? ''
    const at = line.indexOf('回到底部')
    // 「回到底部（Enter/End）」的显示宽度 21（前后都是 ASCII 空格，字符串下标 = 列号）
    const PILL = 21
    expect(at, `「回到底部」在第 ${at} 列`).toBeGreaterThan(40)
    expect(at + PILL, `右缘 ${at + PILL} 列`).toBeLessThanOrEqual(97)
  })

  test('来回一屏后 ▲/▼/输入框仍在原行；同样格数滚回来正好到底', async () => {
    for (let i = 0; i < 8; i += 1) await chat.press(WHEEL_DOWN)
    const back = rowsNow()
    expect(back.pill, JSON.stringify(back)).toBe(-1)
    expect(back.up).toBe(before.up)
    expect(back.down).toBe(before.down)
    expect(back.composer).toBe(before.composer)
  })

  test('滚离尾部：第一行浮着当前轮的题面（钉住轮头，不占布局）', async () => {
    const pinnedRow = () => chat.screen()[0] ?? ''
    // 贴尾时第一行不是钉住轮头（钉住行只在滚离尾部后出现）
    expect(!pinnedRow().startsWith('  ❯ 第'), JSON.stringify(pinnedRow().slice(0, 40))).toBe(true)
    await chat.press(WHEEL_UP)
    await chat.press(WHEEL_UP)
    const pinned = pinnedRow()
    const pinnedTurn = /❯ 第 (\d+) 问/.exec(pinned)?.[1]
    expect(pinnedTurn !== undefined, JSON.stringify(pinned.slice(0, 60))).toBe(true)
    expect(pinnedTurn, `读到第 ${String(pinnedTurn)} 问`).toBe('5')
    expect(/❯ 第 \d+ 问/.test(pinned) && !/行\d-\d/.test(pinned), JSON.stringify(pinned.slice(0, 40))).toBe(true)
  })

  test('点钉住行 → 跳到那一轮', async () => {
    await chat.press('\x1b[<0;8;1M')
    const afterPick = chat.screen()
    expect(
      /❯ 第 5 问/.test(afterPick[0] ?? '') && /行4-0\b/.test((afterPick[1] ?? '').trim()),
      JSON.stringify(afterPick.slice(0, 3).map((line) => line.trim().slice(0, 30))),
    ).toBe(true)
  })

  test('点那颗浮起来的胶囊 → 回到底部', async () => {
    await chat.press(WHEEL_DOWN.repeat(30))
    await chat.press(WHEEL_UP)
    await chat.press(WHEEL_UP)
    const popped = rowsNow()
    await chat.press(`\x1b[<0;6;${popped.pill + 1}M`)
    expect(chat.screen().findIndex((line) => line.includes('回到底部')), JSON.stringify(rowsNow())).toBe(-1)
  })
})

// ── [11] 连滚洪峰 ───────────────────────────────────────────────────────────

describe('[11] 连滚洪峰：一包 5 格 = 15 行、全程不回跳', () => {
  /** 每轮：题面 + 思考 + 2 张长结果工具卡 + 20 行编号标记正文（卡片让「估算 vs 真值」真的不一致）。 */
  function cards(): TranscriptEntry[] {
    const entries: TranscriptEntry[] = []
    let id = 1
    for (let turn = 0; turn < 5; turn += 1) {
      entries.push({ kind: 'user', id: id++, text: `第 ${turn + 1} 问` })
      entries.push({
        kind: 'thinking',
        id: id++,
        text: Array.from({ length: 9 }, (_, i) => `第 ${i} 段推理`).join('\n'),
      })
      for (let tool = 0; tool < 2; tool += 1) {
        entries.push({
          kind: 'tool',
          id: id++,
          call: {
            callId: `c-${turn}-${tool}`,
            name: 'browser_look',
            argsText: '{"action":"snapshot","full":true}',
            resultText: Array.from({ length: 14 }, (_, i) => `结果第 ${i} 行`).join('\n'),
            status: 'done' as const,
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

  let chat: MountedApp
  beforeAll(async () => {
    chat = await mount({ entries: cards() })
  })

  /** 某个标记在屏幕上的行号（找不到 = -1，说明滚出屏幕了）。 */
  const rowOfMarker = (marker: string) => chat.screen().findIndex((line) => line.includes(marker))
  /** 屏幕第 row 行（或往下第一行）那个标记的文本（窗口 24 行：中间可能隔十几行非标记内容）。 */
  const markerNear = (row: number): string | null => {
    const lines = chat.screen()
    for (let at = row; at < Math.min(lines.length, row + 24); at += 1) {
      const found = /M\d-\d\d/.exec(lines[at] ?? '')
      if (found !== null) return found[0]
    }
    return null
  }

  test('标记正文在场（能读到尺子）', () => {
    const marker = markerNear(3)
    expect(marker !== null && rowOfMarker(marker) >= 0, JSON.stringify(chat.screen().slice(0, 6))).toBe(true)
  })

  test('逐格上滚 6 次，盯住的那个标记每次都正好往下走 3 行', async () => {
    const tracked: Array<string | number> = []
    let marker = markerNear(3) ?? ''
    let row = rowOfMarker(marker)
    for (let i = 0; i < 6; i += 1) {
      const beforeRow = row
      await chat.press(WHEEL_UP)
      let now = rowOfMarker(marker)
      if (now === -1) {
        // 盯的那个滚出屏幕了：换一个（照旧从靠上的位置挑，继续量位移）
        marker = markerNear(3) ?? ''
        now = marker === '' ? -1 : rowOfMarker(marker)
        tracked.push(`换尺子→${marker}`)
      } else {
        tracked.push(now - beforeRow)
      }
      row = now
    }
    expect(
      tracked.every((step) => step === 3 || String(step).startsWith('换尺子')),
      `实测 ${JSON.stringify(tracked)}`,
    ).toBe(true)
  })

  test('一包 5 格一次走 15 行', async () => {
    const burstMarker = markerNear(3) ?? ''
    const burstRow = burstMarker === '' ? -1 : rowOfMarker(burstMarker)
    await chat.press(WHEEL_UP.repeat(5))
    const burstNow = burstMarker === '' ? -1 : rowOfMarker(burstMarker)
    expect(burstNow, `${burstMarker} 从 ${burstRow} 到 ${burstNow}`).toBe(burstRow + 15)
  })

  test('快速连滚 20 格全程没有回跳', async () => {
    await chat.press(WHEEL_DOWN.repeat(20)) // 先回底部附近
    const jumps: string[] = []
    for (let i = 0; i < 20; i += 1) {
      const watch = markerNear(3)
      const at = watch === null ? -1 : rowOfMarker(watch)
      await chat.press(WHEEL_UP)
      const after = watch === null ? -1 : rowOfMarker(watch)
      if (at >= 0 && after >= 0 && after < at) jumps.push(`${watch} ${at}→${after}`)
    }
    expect(jumps.length, jumps.slice(0, 4).join(' , ')).toBe(0)
  })
})
