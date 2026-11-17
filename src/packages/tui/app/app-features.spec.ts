/**
 * 0.6.57 特性电池（迁自 `scripts/tui-features-test.mjs`）：欢迎页 / 思考分行 / 状态栏一行
 * / IME 光标停靠 / 双击 Esc 撤回上一轮 / 附件芯片（Ctrl+V 贴图、点击预览、✕ 摘下、提交
 * 合流）/ 会话内图片行点击预览 / 子代理浮层（/agents → 转录）。
 *
 * 剪贴板与图片渲染都走 App 的注入口（clipboardReader / imageRenderer），不真调
 * PowerShell；附件用的图片是真实写的 1×1 PNG（submit 断言要读成 data URL）。
 *
 * ## 结构
 *
 * 探针是**一个 App 实例顺序驱动**的长序列：后面每组特性依赖前面按键留下的状态（第二轮
 * 芯片编号接在第一轮后面、撤回预填的原话要先 Ctrl+U 清掉才能敲 /agents）。所以这里不按
 * 特性拆文件——拆了就得在每份里重放前置按键，状态机走两遍容易分叉——而是在一个文件里
 * 按特性分组 describe，组间按探针原序排列（vitest 同文件默认串行，顺序就是执行顺序）。
 *
 * ## 帧的读法
 *
 * 探针每个键固定 sleep 160ms、`lastFrame()` 从「本次按键后新写的内容」取尾巴。这里换成
 * scroll 探针同款的两条规矩：`press()` 等帧稳定（最少 150ms 且输出连续几拍不变）；
 * `frame()` 读「最近一次写出的帧」，**没有新帧 = 屏幕没变 = 沿用上一帧**，不是空屏。
 * 原始累计输出（`raw`）留给两处必须读 SGR/光标序列的断言。
 *
 * ## 隔离
 *
 * `tempHome()` + `DSC_HOME` 必须在 App 被加载之前换好（Composer 经 history-store 读
 * `~/.dsc/.tui-history`），App 一律动态 import。真实 `~/.dsc` 一个字节都不动。
 *
 * 「标签斜体、正文不斜体」的强断言在 `chat-style.spec.ts`（要 FORCE_COLOR=3 才能看到
 * SGR）；本文件里那条斜体断言在无色进程里只是弱判据，保留是为了钉「正文行上不出现
 * 斜体开关」这一半。
 *
 * 归 `tui` project（`src/packages/tui/**` + node + 假 stdin/stdout，直读 src，不走 lib）。
 *
 * @module dsc/packages/tui/app/app-features.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { DscRuntime, RuntimeSnapshot } from '@pneuma/runtime/contract.js'
import type { CommandContext } from '@pneuma/runtime/services/types.js'
import { tempHome } from '../../../../tests/harness.js'
import { commandsPlugin, runCommand } from '../../commands/index.js'

/** 临时主目录：`.tui-history` 与附件 PNG 都落在它下面（真实 `~/.dsc` 不动）。 */
const home = tempHome('dsc-app-features-')
const originalDscHome = process.env.DSC_HOME
process.env.DSC_HOME = join(home.home, '.dsc')

/**
 * 与 `scripts/_tui-commands.mjs` 同款的最小假 ctx：把**真的** commands 插件挂上去，
 * 拿到与宿主半同一条派发路径。缺哪个 apply 当场抛，别猜。
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
/** 派发一条输入（与宿主半同一条路径）。 */
const dispatchCommand = (input: string, runtime: DscRuntime, ui: CommandContext): boolean =>
  runCommand(input, runtime, ui)

/** 真实可解码的 1×1 PNG（附件提交要真读文件）。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const dscDir = join(home.home, '.dsc')
mkdirSync(dscDir, { recursive: true })
const pngPath = join(dscDir, 'pic.png')
writeFileSync(pngPath, PNG_1PX)

/** 会话条目底座：用户消息（带图）+ 思考 + 正文。 */
const ENTRIES = [
  { id: 1, kind: 'user', text: '你好', images: ['data:image/png;base64,AAAA'] },
  { id: 2, kind: 'thinking', text: '用户问「你好」。这是纯问答，直接回答即可，不用工具。' },
  { id: 3, kind: 'text', text: '兄弟你好' },
]

/** 最小快照（RuntimeSnapshot 只列 App 要读的字段），overrides 支持整字段覆盖。 */
function makeSnapshot(overrides: Record<string, unknown> = {}): RuntimeSnapshot {
  const base: Record<string, unknown> = {
    entries: ENTRIES,
    sessions: [],
    sessionsLoading: false,
    sessionStates: {},
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
  return {
    ...base,
    ...overrides,
    surfaces: { ...(base.surfaces as object), ...((overrides.surfaces as object) ?? {}) },
  } as unknown as RuntimeSnapshot
}

// ── 假 runtime：收发记录器 ────────────────────────────────────────────────────

const listeners = new Set<() => void>()
let snapshot: RuntimeSnapshot = makeSnapshot()
/** submit 收到的（原文，图片 data URL 列表）。 */
const submits: Array<{ text: string; images?: unknown }> = []
/** fork 调用记录（撤回上一轮）。 */
const forkCalls: Array<[string, number]> = []
/** openSession 收到的路径（撤回后切分叉会话）。 */
const openedSessions: string[] = []
/** peekTranscript 收到的文件（队友转录只读回放）。 */
const peeks: string[] = []

/** 假 runtime 的完整形状（DscRuntime + 本文件驱动用的 setSnapshot）。 */
type FeatureRuntime = DscRuntime & { setSnapshot(next: RuntimeSnapshot): void }

const runtime = {
  subscribe(cb: () => void) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  getSnapshot(): RuntimeSnapshot {
    return snapshot
  },
  setSnapshot(next: RuntimeSnapshot) {
    snapshot = next
    for (const listener of [...listeners]) listener()
  },
  listModels: () => [],
  dock: () => Promise.resolve({ entries: [] }),
  submit(text: string, images?: unknown) {
    submits.push({ text, images })
  },
  openSession(path: string) {
    openedSessions.push(path)
  },
  refreshSessions: () => Promise.resolve(),
  listArchivedSessions: () => Promise.resolve({ items: [] }),
  renameSession: () => Promise.resolve({ ok: true }),
  setSessionPinned: () => Promise.resolve({ ok: true }),
  archiveSessions: () => Promise.resolve({ ok: true }),
  restoreSessions: () => Promise.resolve({ ok: true }),
  purgeSessions: () => Promise.resolve({ ok: true }),
  forkSession(path: string, index: number) {
    forkCalls.push([path, index])
    return Promise.resolve({ ok: true, path: '/w/fork.jsonl' })
  },
  listUserMessages: () => Promise.resolve(['撤回的原话']),
  listTeammates: () => [
    {
      name: 'writer-1',
      role: 'writer',
      state: 'working',
      task: '写正文',
      file: '/w/agent-writer.jsonl',
      parent: 'lead',
      depth: 1,
      rounds: 3,
      startedAt: 1,
    },
  ],
  peekTranscript(file: string) {
    peeks.push(file)
    return Promise.resolve([{ id: 1, kind: 'system', text: `代理日志：${file}` }])
  },
  setModel() {},
  interrupt() {},
  exit() {},
  answerApproval() {},
  answerQuestion() {},
  answerPlan() {},
} as unknown as FeatureRuntime

/** 注入口：剪贴板总是有图 / 渲染器回一个可断言的字符串。 */
const clipboardReader = async () => ({ kind: 'image' as const, path: pngPath })
const imageRenderer = async () => 'BLOCK-CHARS'

// ── 假终端 ────────────────────────────────────────────────────────────────────

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
stdout.columns = 110
stdout.rows = 40
stdout.isTTY = false

/** 累计原始输出（含 SGR 与光标序列）：IME 与斜体判据从这里读。 */
let raw = ''
/** 最近一帧的原始文本：从最后一个 `2K` 起；**没有 `2K` 的帧回退整段**（scroll 探针同款），
 *  且只在尾巴非空白时更新——没有新帧 = 屏幕没变 = 沿用上一帧，不是空屏。 */
let lastRaw = ''
stdout.on('data', (chunk: Buffer) => {
  raw += String(chunk)
  const at = raw.lastIndexOf('\x1b[2K')
  const tail = at >= 0 ? raw.slice(at) : raw
  if (tail.replace(/\s/g, '') !== '') lastRaw = tail
})

let instance: ReturnType<typeof render> | null = null

/** 剥掉 ANSI 与光标控制序列。 */
const clean = (text: string) => text.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
/** 最近一帧剥掉 ANSI 后的文本（没新帧 = 屏幕没变 = 沿用上一帧）。 */
const frame = () => clean(lastRaw)
/** 按行拆帧。 */
const contentLines = (text: string) => text.replace(/\n$/, '').split('\n')
/** 某段文字所在的行号（0 基）；找不到 = -1。 */
const lineOf = (text: string, needle: string) => contentLines(text).findIndex((line) => line.includes(needle))

/** 等这一帧写完：最少 150ms，且输出长度连续几拍不再变（composer.spec 同款）。 */
async function settleFrame(): Promise<void> {
  const startedAt = Date.now()
  const deadline = startedAt + 2_000
  let previous = -1
  let stable = 0
  while (Date.now() < deadline) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 25))
    if (raw.length === previous) stable += 1
    else {
      stable = 0
      previous = raw.length
    }
    if (Date.now() - startedAt >= 150 && stable >= 2) return
  }
}

/** 敲一段键序列，等帧稳定；返回「本次新写出的帧」（可能为空 = 屏幕没变）。 */
async function press(keys: string): Promise<string> {
  const before = raw.length
  stdin.write(keys)
  await settleFrame()
  return raw.slice(before)
}

beforeAll(async () => {
  const { App } = await import('./App.js')
  instance = render(
    createElement(App as React.ComponentType<Record<string, unknown>>, {
      runtime,
      dispatchCommand,
      clipboardReader,
      imageRenderer,
    }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await settleFrame()
})

afterAll(() => {
  instance?.unmount()
  stdin.end()
  if (originalDscHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = originalDscHome
  home.restore()
})

// ── ① 欢迎页 ────────────────────────────────────────────────────────────────

describe('① 欢迎页（短会话挂在流顶）', () => {
  test('出现 Pneuma 与版本号（版本号别写死档位）', () => {
    const current = frame()
    expect(current.includes('Pneuma') && /v\d+\.\d+\.\d+/.test(current), JSON.stringify(contentLines(current).slice(0, 6))).toBe(true)
  })

  test('含模型与目录', () => {
    const current = frame()
    expect(current.includes('模型 test-model')).toBe(true)
    expect(current.includes('/w')).toBe(true)
  })

  test('提示双击 Esc 撤回', () => {
    expect(frame().includes('双击 Esc 撤回上一轮')).toBe(true)
  })
})

// ── ①b 大字点阵 ─────────────────────────────────────────────────────────────

describe('①b 大字点阵（110×40 够画整块，逐行钉字形）', () => {
  /** 5 行大字逐字钉住——改名后只查「含 Pneuma」看不见漏改。 */
  const ART_PNEUMA = [
    '█████ █   █ █████ █   █ █   █ █████',
    '█   █ ██  █ █     █   █ ██ ██ █   █',
    '█████ █ █ █ ████  █   █ █ █ █ █████',
    '█     █  ██ █     █   █ █   █ █   █',
    '█     █   █ █████ ▀▀▀▀▀ █   █ █   █',
  ]

  test('大字恰好 5 行（阶梯门槛内的终端才画）', () => {
    const artLines = contentLines(frame()).filter((line) => /^[█▀ ]+$/.test(line) && line.includes('█'))
    expect(artLines.length, JSON.stringify(artLines)).toBe(5)
  })

  test('大字逐行拼出 PNEUMA（流内缩进由会话流的 padding 决定）', () => {
    const artLines = contentLines(frame()).filter((line) => /^[█▀ ]+$/.test(line) && line.includes('█'))
    expect(artLines.map((line) => line.trim())).toEqual(ART_PNEUMA)
  })

  test('大字不再拼旧名（MUSE CODE 的两行首行都不在）', () => {
    const current = frame()
    expect(current.includes('█   █ █   █ ▀▀▀▀█ █████')).toBe(false)
    expect(current.includes('█████ █████ █████ █████')).toBe(false)
  })
})

// ── ② 思考分行 ──────────────────────────────────────────────────────────────

describe('② 思考分行：⚓ 标签行与内容分行（0.6.59 对齐 dsh）', () => {
  test('思考标签行存在', () => {
    expect(lineOf(frame(), '⚓ 思考')).toBeGreaterThanOrEqual(0)
  })

  test('思考标签与内容分行', () => {
    const lines = contentLines(frame())
    const thinkLine = lines.findIndex((line) => line.includes('⚓ 思考'))
    expect(thinkLine).toBeGreaterThanOrEqual(0)
    expect(lines[thinkLine]?.includes('纯问答') ?? true).toBe(false)
    expect(lines[thinkLine + 1]?.includes('纯问答')).toBe(true)
  })

  test('思考正文不斜体（那一行没有斜体开关；强断言在 chat-style.spec.ts）', () => {
    const rawThinkBody = raw
      .split('\n')
      .filter((line) => line.includes('纯问答'))
      .pop()
    expect(rawThinkBody !== undefined && !rawThinkBody.includes('\x1b[3m'), JSON.stringify(rawThinkBody?.slice(0, 120))).toBe(true)
  })
})

// ── ②c 用户消息上方留空行 ───────────────────────────────────────────────────

describe('②c 用户消息与上一轮之间留一行空（dsh 的 marginTopOnTurn 同款）', () => {
  test('用户行找到了', () => {
    expect(lineOf(frame(), '❯ 你好')).toBeGreaterThan(0)
  })

  test('用户行上面那一行是空的', () => {
    const lines = contentLines(frame())
    const userRow = lines.findIndex((line) => line.includes('❯ 你好'))
    expect(lines[userRow - 1]?.trim(), JSON.stringify(lines.slice(Math.max(0, userRow - 2), userRow + 1))).toBe('')
  })
})

// ── ③ 状态栏 ────────────────────────────────────────────────────────────────

describe('③ 状态栏：一行、左右两组字段（0.7.x 去掉横跨整幅的 context 进度条）', () => {
  test('字段行合并状态与模型（左组）', () => {
    const statusLine = contentLines(frame()).find((line) => line.includes('空闲'))
    expect(statusLine !== undefined && statusLine.includes('test-model') && statusLine.includes('标准'), JSON.stringify(statusLine)).toBe(true)
  })

  test('蓝色 context 进度条没了（整帧里没有它的读数 0/1.0M）', () => {
    expect(frame().includes('/1.0M')).toBe(false)
  })

  test('字段行就是最后一行（右组 ctx/cwd；会话段 0.6.62 出厂关）', () => {
    const lines = contentLines(frame())
    const statusLine = lines.find((line) => line.includes('空闲'))
    expect(lines[lines.length - 1]).toBe(statusLine)
    expect(statusLine?.includes('ctx')).toBe(true)
    expect(statusLine?.includes('/w')).toBe(true)
    expect(statusLine?.includes('会话')).toBe(false)
  })
})

// ── ④ 恒定帧 ────────────────────────────────────────────────────────────────

describe('④ 恒定帧仍是 39 行', () => {
  test('恒定帧仍为 39 行', () => {
    expect(contentLines(frame()).length, String(contentLines(frame()).length)).toBe(39)
  })
})

// ── ⑤ IME 光标停靠 ──────────────────────────────────────────────────────────

describe('⑤ IME 光标停靠：帧尾有「回到 caret 列 + 显示光标」序列', () => {
  test('光标停靠序列出现（cursorTo 的 G 序列 + ?25h）', () => {
    expect(raw.includes('\x1b[?25h') && /\x1b\[\d+G/.test(raw), JSON.stringify(raw.slice(-200))).toBe(true)
  })
})

// ── ⑥ 会话内图片行点击预览 ──────────────────────────────────────────────────

describe('⑥ 会话内图片行点击 → 预览浮层（渲染走注入口）', () => {
  test('图片行带点击提示', () => {
    expect(lineOf(frame(), '🖼 1 张图片 · 点击预览')).toBeGreaterThanOrEqual(0)
  })

  test('点击图片行打开预览浮层', async () => {
    const imgLine = lineOf(frame(), '🖼 1 张图片 · 点击预览')
    await press(`\x1b[<0;3;${imgLine + 1}M`)
    const current = frame()
    expect(current.includes('BLOCK-CHARS') && current.includes('图片（1 张）'), JSON.stringify(contentLines(current).slice(0, 8))).toBe(true)
  })

  test('Esc 关闭预览', async () => {
    await press('\x1b')
    expect(frame()).not.toContain('BLOCK-CHARS')
  })
})

// ── ⑦ Ctrl+V 贴图 ───────────────────────────────────────────────────────────

describe('⑦ Ctrl+V 贴图：芯片出现 → 提交合流 data URL → 芯片清空', () => {
  test('Ctrl+V 挂上附件芯片', async () => {
    await press('\x16')
    const current = frame()
    expect(current.includes('[图#1] pic.png') && current.includes('已附加图片 #1'), JSON.stringify(contentLines(current).slice(-12))).toBe(true)
  })

  test('提交把芯片读成 data URL 随消息发送', async () => {
    await press('hello')
    await press('\r')
    const last = submits.at(-1)
    expect(submits.length, JSON.stringify(submits)).toBe(1)
    expect(last?.text).toBe('hello')
    expect(Array.isArray(last?.images)).toBe(true)
    expect(String((last?.images as string[])[0]).startsWith('data:image/png;base64,')).toBe(true)
  })

  test('提交后芯片清空', () => {
    expect(frame()).not.toContain('[图#1]')
  })
})

// ── ⑧ 芯片点击预览 / ✕ 摘下 ─────────────────────────────────────────────────

describe('⑧ 芯片点击预览 / ✕ 摘下', () => {
  test('第二枚芯片出现', async () => {
    await press('\x16')
    expect(lineOf(frame(), '[图#2] pic.png')).toBeGreaterThanOrEqual(0)
  })

  test('点芯片主体打开预览', async () => {
    const chipRow = lineOf(frame(), '[图#2] pic.png')
    await press(`\x1b[<0;3;${chipRow + 1}M`)
    expect(frame()).toContain('BLOCK-CHARS')
  })

  test('Esc 收起预览（摘下之前）', async () => {
    await press('\x1b')
    expect(frame()).not.toContain('BLOCK-CHARS')
  })

  test('点 ✕（芯片主体之后两列）摘下芯片', async () => {
    const chipRow = lineOf(frame(), '[图#2] pic.png')
    // ✕ 在芯片主体之后两列（页边距 +2 后主体从 col 2 起、宽 14，✕ 区在 16-17 列）
    await press(`\x1b[<0;18;${chipRow + 1}M`)
    expect(frame(), JSON.stringify(contentLines(frame()).slice(-10))).not.toContain('[图#2]')
  })
})

// ── ⑨ 双击 Esc 撤回上一轮 ───────────────────────────────────────────────────

describe('⑨ 双击 Esc 撤回上一轮（fork + 原话回输入框）', () => {
  test('第一次 Esc 出现 prime 提示', async () => {
    await press('\x1b')
    expect(frame().includes('再按一次 Esc'), JSON.stringify(contentLines(frame()).slice(-6))).toBe(true)
  })

  test('第二次 Esc 触发 fork（最后一条用户消息之前）并切到分叉会话', async () => {
    await press('\x1b')
    expect(forkCalls.length, JSON.stringify(forkCalls)).toBe(1)
    expect(forkCalls[0]?.[0]).toBe('/w/s.jsonl')
    expect(forkCalls[0]?.[1]).toBe(0)
    expect(openedSessions.includes('/w/fork.jsonl'), JSON.stringify(openedSessions)).toBe(true)
  })

  test('原话回到输入框', () => {
    expect(frame().includes('撤回的原话'), JSON.stringify(contentLines(frame()).slice(-6))).toBe(true)
  })

  test('撤回成功提示（原会话保留）', () => {
    const current = frame()
    expect(current.includes('已撤回上一轮')).toBe(true)
    expect(current.includes('/resume')).toBe(true)
  })
})

// ── ⑩ /agents 子代理浮层 ────────────────────────────────────────────────────

describe('⑩ /agents 打开子代理浮层 → Enter 看转录', () => {
  test('子代理浮层列出队友', async () => {
    await press('\x15') // Ctrl+U 清掉撤回预填的原话
    await press('/agents')
    await press('\r')
    const current = frame()
    expect(
      current.includes('子代理与后台会话') && current.includes('writer-1') && current.includes('写正文'),
      JSON.stringify(contentLines(current).slice(0, 8)),
    ).toBe(true)
  })

  test('Enter 进入队友转录（只读 peek）', async () => {
    await press('\r')
    const current = frame()
    expect(peeks.includes('/w/agent-writer.jsonl'), JSON.stringify(peeks)).toBe(true)
    expect(current.includes('writer-1（writer）') && current.includes('代理日志'), JSON.stringify(contentLines(current).slice(0, 6))).toBe(true)
  })

  test('Esc 关闭子代理转录', async () => {
    await press('\x1b')
    expect(frame()).not.toContain('writer-1（writer）')
  })
})

// ── ⑪ 长会话不再画欢迎页 ────────────────────────────────────────────────────

describe('⑪ 长会话不再画欢迎页', () => {
  beforeAll(() => {
    runtime.setSnapshot(
      makeSnapshot({
        entries: Array.from({ length: 120 }, (_, i) => ({ id: i, kind: 'system', text: `条目-${i}` })),
      }),
    )
  })

  test('长会话不画欢迎页', async () => {
    await settleFrame()
    expect(frame()).not.toContain('Pneuma')
  })

  test('长会话最新条目仍底对齐', () => {
    expect(frame().includes('条目-119')).toBe(true)
  })
})
