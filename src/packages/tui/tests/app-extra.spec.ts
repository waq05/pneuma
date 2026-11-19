/**
 * `App.tsx` 交互分支补测（tui project，node + 假终端）。
 *
 * 已有覆盖的分工：`app/` 下的 spec 分别钉住渲染形态、滚动模型、选择器/设置页组件；
 * 本文件只补 **App 的键盘/鼠标路由分支**——审批四档、提问单选·多选·自由文本·跳过、
 * 计划批准/拒绝/反馈、Ctrl+C 双击退出与打断、Ctrl+T/Ctrl+O、Ctrl+V 三种剪贴板结果、
 * 提交时的图片合流、模型/模式/技能浮层、会话选择器的 Ctrl 动作组、回底胶囊与 BEL。
 *
 * ## 夹具
 *
 * 每个用例独立挂载一只 App（`mount()`），`afterEach` 统一 unmount + 关 stdin——这些
 * 分支改的是 App 内部状态，串在同一只实例上会互相污染（改名态、armed、modal 都会
 * 把后面的键吞掉）。假 runtime 记录每次调用；需要的返回值按用例覆盖。
 *
 * ## 读帧
 *
 * 与 `app-features.spec.ts` 同款：`press()` 等帧稳定（最少 150ms 且输出连续几拍不变）；
 * `frame()` 读最近一次写出的帧，没有新帧 = 屏幕没变 = 沿用上一帧。真实的 `~/.dsc`
 * 一个字节都不动（`tempHome` + `DSC_HOME` 在 App 动态 import 之前换好）。
 *
 * @module dsc/packages/tui/tests/app-extra.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import type { DscRuntime, RuntimeSnapshot } from '@pneuma/runtime/contract.js'
import type { CommandContext } from '@pneuma/runtime/services/types.js'
import { tempHome } from '../../../../tests/harness.js'
import { SKIPPED_ANSWER } from '../app/AskCard.js'

// ── 隔离与夹具文件 ────────────────────────────────────────────────────────────

const home = tempHome('dsc-app-extra-')
const originalDscHome = process.env.DSC_HOME
process.env.DSC_HOME = join(home.home, '.dsc')

/** 1×1 PNG：正文里的图片路径要走真实的 `extractImages`（读盘成 data URL）。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const dscDir = join(home.home, '.dsc')
mkdirSync(dscDir, { recursive: true })
const pngPath = join(dscDir, 'pic.png')
writeFileSync(pngPath, PNG_1PX)
/** 扩展名不是图片：附件芯片提交时必须走「读取失败」分支。 */
const badImagePath = join(dscDir, 'bad.txt')
writeFileSync(badImagePath, 'not an image')

// ── 快照 ──────────────────────────────────────────────────────────────────────

const BASE_STATUS: Record<string, unknown> = {
  turnState: 'idle',
  model: 'test-model',
  effort: 'medium',
  usage: null,
  contextWindow: 1_000_000,
  sessionId: '/w/s.jsonl',
  cwd: '/w',
}

/** 最小快照；`entries`/`sessions`/`surfaces`/`status` 支持整字段覆盖。 */
function makeSnapshot(overrides: Record<string, unknown> = {}): RuntimeSnapshot {
  const base: Record<string, unknown> = {
    entries: [
      { id: 1, kind: 'user', text: '你好' },
      { id: 2, kind: 'text', text: '世界' },
    ],
    sessions: [],
    sessionsLoading: false,
    sessionStates: {},
    status: BASE_STATUS,
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
    status: { ...(base.status as object), ...((overrides.status as object) ?? {}) },
    surfaces: { ...(base.surfaces as object), ...((overrides.surfaces as object) ?? {}) },
  } as unknown as RuntimeSnapshot
}

// ── 卡片夹具 ──────────────────────────────────────────────────────────────────

/** 20 行差异：折叠上限 14，折叠时露出「还有 6 行」。 */
const DIFF_LINES = Array.from({ length: 20 }, (_, i) => ({
  kind: 'add' as const,
  text: `新增行-${i + 1}`,
  oldLine: null,
  newLine: i + 1,
}))

const DIFF = {
  path: '/w/x.ts',
  added: 20,
  removed: 0,
  hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 20, lines: DIFF_LINES }],
  status: 'modified' as const,
}

/** 审批卡：scopes 决定哪些档位在卡上/键盘上有效。 */
function makeApproval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ap-1',
    toolName: 'write',
    argsSummary: 'write /w/x.ts',
    meaning: '写 /w/x.ts',
    reason: '工作区内的改动需要确认',
    risk: 'medium',
    suggestedRule: null,
    hardline: false,
    scopes: ['once', 'session'],
    policy: 'auto-edit',
    reviewer: 'user',
    mode: 'default',
    ...overrides,
  }
}

/** 单选提问。 */
const ASK_SINGLE = {
  id: 'ask-1',
  question: '选哪个方案？',
  options: [{ label: '方案甲' }, { label: '方案乙' }],
  multiSelect: false,
  allowFreeText: true,
}

/** 多选提问。 */
const ASK_MULTI = {
  id: 'ask-2',
  question: '要哪些能力？',
  options: [{ label: '甲能力' }, { label: '乙能力' }, { label: '丙能力' }],
  multiSelect: true,
  allowFreeText: false,
}

/** 两道题：跳过一题后应推进到下一题。 */
const ASK_TWO = {
  id: 'ask-3',
  question: '第一题',
  options: [{ label: 'A' }],
  multiSelect: false,
  allowFreeText: false,
  questions: [
    { question: '第一题', options: [{ label: 'A' }], multiSelect: false, allowFreeText: false },
    { question: '第二题', options: [{ label: 'B' }], multiSelect: false, allowFreeText: false },
  ],
}

/** 20 行计划：折叠时出现「… 共 20 行」。 */
const PLAN = {
  file: '.dsc/plans/p.md',
  title: '重构计划',
  text: Array.from({ length: 20 }, (_, i) => `计划行-${i + 1}`).join('\n'),
  decision: 'pending',
}

const SESSIONS = [
  { id: '/w/s0.jsonl', cwd: '/w', createdAt: 3, updatedAt: 300, title: '标题0' },
  { id: '/w/s1.jsonl', cwd: '/w', createdAt: 2, updatedAt: 200, title: '标题1' },
  { id: '/w/s2.jsonl', cwd: '/w', createdAt: 1, updatedAt: 100, title: '标题2' },
]

// ── 假 runtime ────────────────────────────────────────────────────────────────

interface MountOptions {
  snapshot?: RuntimeSnapshot
  models?: Array<Record<string, unknown>>
  presets?: Record<string, unknown> | null
  skills?: Array<Record<string, unknown>>
  archived?: Array<Record<string, unknown>>
  userMessages?: string[]
  fork?: { ok: true; path: string } | { ok: false; error: string }
  usePresetResult?: Record<string, unknown>
  clipboardReader?: () => Promise<{ kind: 'image'; path: string } | { kind: 'text'; text: string }>
  imageRenderer?: () => Promise<string>
  dispatch?: (input: string, runtime: DscRuntime, ui: CommandContext) => boolean
}

interface Calls {
  approval: string[]
  question: string[]
  plan: Array<{ decision: string; feedback?: string }>
  submit: Array<{ text: string; images?: unknown }>
  setModel: string[]
  usePreset: string[]
  pin: Array<[string, boolean]>
  archive: string[]
  restore: string[]
  purge: string[]
  rename: Array<[string, string]>
  fork: Array<[string, number]>
  open: string[]
  refresh: number
  interrupt: number
  exit: number
}

/** 命令派发口：把 App 的命令面回调直接映射出来（命令模块本身另有单测）。 */
const defaultDispatch = (input: string, _runtime: DscRuntime, ui: CommandContext): boolean => {
  if (input === '/resume') {
    ui.openPicker()
    return true
  }
  if (input === '/model') {
    ui.openModels()
    return true
  }
  if (input === '/preset') {
    ui.openPresets?.()
    return true
  }
  if (input === '/skills') {
    ui.openSkills?.()
    return true
  }
  return false
}

function makeRuntime(initial: RuntimeSnapshot, options: MountOptions): {
  runtime: DscRuntime & { setSnapshot(next: RuntimeSnapshot): void }
  calls: Calls
} {
  const listeners = new Set<() => void>()
  let current = initial
  const calls: Calls = {
    approval: [],
    question: [],
    plan: [],
    submit: [],
    setModel: [],
    usePreset: [],
    pin: [],
    archive: [],
    restore: [],
    purge: [],
    rename: [],
    fork: [],
    open: [],
    refresh: 0,
    interrupt: 0,
    exit: 0,
  }

  const runtime = {
    subscribe(cb: () => void) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getSnapshot: () => current,
    setSnapshot(next: RuntimeSnapshot) {
      current = next
      for (const listener of [...listeners]) listener()
    },
    listModels: () => options.models ?? [],
    getUiPrefs: () => ({ statusBar: undefined }),
    dock: () => Promise.resolve({ entries: [] }),
    listPresets: () =>
      options.presets ?? {
        current: 'build',
        defaultName: 'build',
        options: [],
        droppable: [],
      },
    usePreset(name: string) {
      calls.usePreset.push(name)
      return options.usePresetResult ?? { ok: true, notice: `已切换到模式「${name}」` }
    },
    listSkills: () => options.skills ?? [],
    listArchivedSessions: () =>
      Promise.resolve({ items: options.archived ?? [], trashDir: '', trashCount: 0 }),
    refreshSessions: () => {
      calls.refresh += 1
      return Promise.resolve()
    },
    openSession: (path: string) => calls.open.push(path),
    forkSession: (path: string, index: number) => {
      calls.fork.push([path, index])
      return Promise.resolve(options.fork ?? { ok: true, path: '/w/forked.jsonl' })
    },
    listUserMessages: () => Promise.resolve(options.userMessages ?? []),
    setSessionPinned: (id: string, pinned: boolean) => {
      calls.pin.push([id, pinned])
      return Promise.resolve({ ok: true })
    },
    archiveSessions: (ids: string[]) => {
      calls.archive.push(...ids)
      return Promise.resolve({ ok: true })
    },
    restoreSessions: (ids: string[]) => {
      calls.restore.push(...ids)
      return Promise.resolve({ ok: true })
    },
    purgeSessions: (ids: string[]) => {
      calls.purge.push(...ids)
      return Promise.resolve({ ok: true })
    },
    renameSession: (id: string, title: string) => {
      calls.rename.push([id, title])
      return Promise.resolve({ ok: true })
    },
    listTeammates: () => [],
    peekTranscript: () => Promise.resolve([]),
    submit: (text: string, images?: unknown) => calls.submit.push({ text, images }),
    setModel: (value: string) => calls.setModel.push(value),
    interrupt: () => {
      calls.interrupt += 1
    },
    exit: () => {
      calls.exit += 1
    },
    answerApproval: (answer: string) => calls.approval.push(answer),
    answerQuestion: (answer: string) => calls.question.push(answer),
    answerPlan: (decision: string, feedback?: string) => calls.plan.push({ decision, feedback }),
  } as unknown as DscRuntime & { setSnapshot(next: RuntimeSnapshot): void }

  return { runtime, calls }
}

// ── 假终端与挂载 ──────────────────────────────────────────────────────────────

type FakeStdin = PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

type FakeStdout = PassThrough & { columns: number; rows: number; isTTY: boolean }

function fakeStdin(): FakeStdin {
  const stream = new PassThrough() as FakeStdin
  stream.isTTY = true
  stream.setRawMode = () => {}
  stream.ref = () => {}
  stream.unref = () => {}
  return stream
}

interface Mounted {
  calls: Calls
  press(keys: string): Promise<string>
  frame(): string
  lines(): string[]
  setSnapshot(next: RuntimeSnapshot): Promise<void>
  raw(): string
  unmount(): void
}

const openMounts: Mounted[] = []

async function mount(options: MountOptions = {}): Promise<Mounted> {
  const snapshot = options.snapshot ?? makeSnapshot()
  const { runtime, calls } = makeRuntime(snapshot, options)
  const stdin = fakeStdin()
  const stdout = new PassThrough() as FakeStdout
  stdout.columns = 200
  stdout.rows = 40
  stdout.isTTY = false

  let output = ''
  let lastRaw = ''
  stdout.on('data', (chunk: Buffer) => {
    output += String(chunk)
    const at = output.lastIndexOf('\x1b[2K')
    const tail = at >= 0 ? output.slice(at) : output
    // 没有新帧 = 屏幕没变 = 沿用上一帧，不是空屏。
    if (tail.replace(/\s/g, '') !== '') lastRaw = tail
  })

  /** 等这一帧写完：最少 150ms，且输出长度连续几拍不再变（app-features 同款）。 */
  async function settle(): Promise<void> {
    const startedAt = Date.now()
    const deadline = startedAt + 2_000
    let previous = -1
    let stable = 0
    while (Date.now() < deadline) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 25))
      if (output.length === previous) stable += 1
      else {
        stable = 0
        previous = output.length
      }
      if (Date.now() - startedAt >= 150 && stable >= 2) return
    }
  }

  const instance = render(
    createElement(AppComponent, {
      runtime,
      dispatchCommand: options.dispatch ?? defaultDispatch,
      ...(options.clipboardReader === undefined ? {} : { clipboardReader: options.clipboardReader }),
      ...(options.imageRenderer === undefined ? {} : { imageRenderer: options.imageRenderer }),
    }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )

  const mounted: Mounted = {
    calls,
    async press(keys: string) {
      const before = output.length
      stdin.write(keys)
      await settle()
      return output.slice(before)
    },
    frame() {
      return lastRaw.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
    },
    lines() {
      return mounted.frame().replace(/\n$/, '').split('\n')
    },
    async setSnapshot(next: RuntimeSnapshot) {
      runtime.setSnapshot(next)
      await settle()
    },
    raw() {
      return output
    },
    unmount() {
      instance.unmount()
      stdin.end()
    },
  }

  await settle()
  openMounts.push(mounted)
  return mounted
}

let AppComponent: React.ComponentType<Record<string, unknown>>

beforeAll(async () => {
  const { App } = await import('../app/App.js')
  AppComponent = App as unknown as React.ComponentType<Record<string, unknown>>
})

afterEach(() => {
  for (const mounted of openMounts.splice(0)) mounted.unmount()
})

afterAll(() => {
  if (originalDscHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = originalDscHome
  home.restore()
})

/** 断言辅助：失败时把当前屏幕贴出来，省得只看到 true !== false。 */
function expectFrame(app: Mounted, needle: string): void {
  expect(app.frame().includes(needle), JSON.stringify(app.lines())).toBe(true)
}

function expectNoFrame(app: Mounted, needle: string): void {
  expect(app.frame().includes(needle), JSON.stringify(app.lines())).toBe(false)
}

// ── 审批卡 ────────────────────────────────────────────────────────────────────

describe('审批卡键盘路由（scopes 决定哪些档位生效）', () => {
  test('y 允许一次、n 拒绝', async () => {
    const app = await mount({ snapshot: makeSnapshot({ surfaces: { pendingApproval: makeApproval() } }) })
    expectFrame(app, '工具授权：write')

    await app.press('y')
    expect(app.calls.approval).toEqual(['allow-once'])

    await app.press('n')
    expect(app.calls.approval).toEqual(['allow-once', 'reject'])
  })

  test('a 只在本会话档在 scopes 内时生效；缺永久档时 p 不响应', async () => {
    const app = await mount({
      snapshot: makeSnapshot({
        surfaces: { pendingApproval: makeApproval({ scopes: ['once', 'session'] }) },
      }),
    })

    await app.press('p')
    expect(app.calls.approval, 'scopes 没有 always，p 必须被忽略').toEqual([])

    await app.press('a')
    expect(app.calls.approval).toEqual(['allow-session'])
  })

  test('p 只在永久档在 scopes 内时生效；缺本会话档时 a 不响应', async () => {
    const app = await mount({
      snapshot: makeSnapshot({
        surfaces: { pendingApproval: makeApproval({ scopes: ['once', 'always'] }) },
      }),
    })

    await app.press('a')
    expect(app.calls.approval, 'scopes 没有 session，a 必须被忽略').toEqual([])

    await app.press('p')
    expect(app.calls.approval).toEqual(['allow-always'])
  })

  test('Esc 拒绝（与 n 等价）', async () => {
    const app = await mount({ snapshot: makeSnapshot({ surfaces: { pendingApproval: makeApproval() } }) })
    await app.press('\x1b')
    expect(app.calls.approval).toEqual(['reject'])
  })

  test('v 展开 20 行 diff，再按 v 收起', async () => {
    const app = await mount({
      snapshot: makeSnapshot({
        surfaces: { pendingApproval: makeApproval({ diff: DIFF, argsSummary: undefined }) },
      }),
    })
    expectFrame(app, '还有 6 行')
    expectNoFrame(app, '新增行-20')

    await app.press('v')
    expectFrame(app, '新增行-20')
    expectNoFrame(app, '还有 6 行')

    await app.press('v')
    expectFrame(app, '还有 6 行')
    expectNoFrame(app, '新增行-20')
  })

  test('hardline 卡只画拒绝档，n 走拒绝', async () => {
    const app = await mount({
      snapshot: makeSnapshot({
        surfaces: { pendingApproval: makeApproval({ hardline: true, scopes: ['once'] }) },
      }),
    })
    expectFrame(app, '拒绝（命中硬地板，不可放行）')
    expectNoFrame(app, '[y] 允许一次')

    await app.press('n')
    expect(app.calls.approval).toEqual(['reject'])
  })
})

// ── 提问卡 ────────────────────────────────────────────────────────────────────

describe('提问卡键盘路由', () => {
  test('单选：↓ 改高亮，空格作答高亮项', async () => {
    const app = await mount({ snapshot: makeSnapshot({ surfaces: { pendingQuestion: ASK_SINGLE } }) })
    expectFrame(app, '选哪个方案？')

    await app.press('\x1b[B')
    await app.press(' ')
    expect(app.calls.question).toEqual(['方案乙'])
  })

  test('多选：空格勾两项，Enter 合并提交', async () => {
    const app = await mount({ snapshot: makeSnapshot({ surfaces: { pendingQuestion: ASK_MULTI } }) })

    await app.press(' ')
    await app.press('\x1b[B')
    await app.press(' ')
    await app.press('\r')

    expect(app.calls.question).toEqual(['甲能力、乙能力'])
  })

  test('自由文本：输入后 Enter 提交原文（覆盖高亮选项）', async () => {
    const app = await mount({ snapshot: makeSnapshot({ surfaces: { pendingQuestion: ASK_SINGLE } }) })

    await app.press('hello')
    await app.press('\r')
    expect(app.calls.question).toEqual(['hello'])
  })

  test('Esc 跳过；两题各自跳过一次并按题推进', async () => {
    const app = await mount({ snapshot: makeSnapshot({ surfaces: { pendingQuestion: ASK_TWO } }) })
    expectFrame(app, '第一题')

    await app.press('\x1b')
    expectFrame(app, '第二题')

    await app.press('\x1b')
    expect(app.calls.question).toEqual([SKIPPED_ANSWER, SKIPPED_ANSWER])
  })
})

// ── 计划评审卡 ────────────────────────────────────────────────────────────────

describe('计划评审卡键盘路由', () => {
  test('y 批准、n 拒绝', async () => {
    const app = await mount({ snapshot: makeSnapshot({ surfaces: { pendingPlan: PLAN } }) })
    expectFrame(app, '计划评审：重构计划')

    await app.press('y')
    await app.press('n')
    expect(app.calls.plan).toEqual([{ decision: 'approved' }, { decision: 'rejected' }])
  })

  test('v 展开全文，再按 v 收起', async () => {
    const app = await mount({ snapshot: makeSnapshot({ surfaces: { pendingPlan: PLAN } }) })
    expectFrame(app, '… 共 20 行')
    expectNoFrame(app, '计划行-20')

    await app.press('v')
    expectFrame(app, '计划行-20')
    expectNoFrame(app, '… 共 20 行')

    await app.press('v')
    expectFrame(app, '… 共 20 行')
  })

  test('e 进入反馈态，输入后 Enter 带反馈退回', async () => {
    const app = await mount({ snapshot: makeSnapshot({ surfaces: { pendingPlan: PLAN } }) })

    await app.press('e')
    expectFrame(app, '带反馈退回：在下方输入框写反馈原话')

    await app.press('换个方案')
    await app.press('\r')
    expect(app.calls.plan).toEqual([{ decision: 'rejected', feedback: '换个方案' }])
  })

  test('e 进入反馈态后 Esc 取消（提示行消失）', async () => {
    const app = await mount({ snapshot: makeSnapshot({ surfaces: { pendingPlan: PLAN } }) })

    await app.press('e')
    expectFrame(app, '带反馈退回：在下方输入框写反馈原话')
    await app.press('\x1b')
    expectNoFrame(app, '带反馈退回：在下方输入框写反馈原话')
    expect(app.calls.plan).toEqual([])
  })
})

// ── Ctrl+C / Ctrl+T / Ctrl+O ─────────────────────────────────────────────────

describe('全局快捷键', () => {
  test('空闲时 Ctrl+C 双击退出：第一下只提示', async () => {
    const app = await mount()
    await app.press('\x03')
    expectFrame(app, '再按一次 Ctrl+C 退出')
    expect(app.calls.exit).toBe(0)

    await app.press('\x03')
    expect(app.calls.exit).toBe(1)
  })

  test('跑动中第一下 Ctrl+C 是打断，不提示退出', async () => {
    const app = await mount({ snapshot: makeSnapshot({ status: { turnState: 'running' } }) })
    await app.press('\x03')
    expect(app.calls.interrupt).toBe(1)
    expect(app.calls.exit).toBe(0)
    expectNoFrame(app, '再按一次 Ctrl+C 退出')
  })

  test('Ctrl+T 展开/折叠思考块', async () => {
    // 折叠态只画尾部 3 行瀑布；「思考行-1」只有展开全文时才看得见。
    const app = await mount({
      snapshot: makeSnapshot({
        entries: [
          { id: 1, kind: 'user', text: '你好' },
          {
            id: 2,
            kind: 'thinking',
            text: ['思考行-1', '思考行-2', '思考行-3', '思考行-4', '思考行-5', '思考行-6'].join('\n'),
          },
        ],
      }),
    })
    expectNoFrame(app, '思考行-1')

    await app.press('\x14')
    expectFrame(app, '思考行-1')

    await app.press('\x14')
    expectNoFrame(app, '思考行-1')
  })

  test('Ctrl+O 打开回看全文，q 关闭', async () => {
    const app = await mount()
    await app.press('\x0f')
    expectFrame(app, '回看全文（共 2 条')

    await app.press('q')
    expectNoFrame(app, '回看全文（共')
  })
})

// ── Ctrl+V 剪贴板 ─────────────────────────────────────────────────────────────

describe('Ctrl+V 剪贴板三种结果', () => {
  test('文本：并入当前草稿', async () => {
    const app = await mount({
      clipboardReader: () => Promise.resolve({ kind: 'text', text: '粘贴的文字' }),
    })
    await app.press('\x16')
    expectFrame(app, '粘贴的文字')
  })

  test('空文本：提示终端粘贴分工', async () => {
    const app = await mount({
      clipboardReader: () => Promise.resolve({ kind: 'text', text: '   ' }),
    })
    await app.press('\x16')
    expectFrame(app, '剪贴板里没有图片')
  })

  test('读取失败：提示失败', async () => {
    const app = await mount({
      clipboardReader: () => Promise.reject(new Error('no clipboard')),
    })
    await app.press('\x16')
    expectFrame(app, '剪贴板读取失败')
  })
})

// ── 提交时的图片处理 ──────────────────────────────────────────────────────────

describe('提交时的图片合流', () => {
  test('正文里的本地图片路径读成 data URL 随 submit 发送', async () => {
    const app = await mount()
    await app.press(`${pngPath} 看图`)
    await app.press('\r')

    const last = app.calls.submit.at(-1)
    expect(app.calls.submit.length, JSON.stringify(app.calls.submit)).toBe(1)
    expect(last?.text).toContain(pngPath)
    expect(Array.isArray(last?.images)).toBe(true)
    expect(String((last?.images as string[])[0]).startsWith('data:image/png;base64,')).toBe(true)
  })

  test('附件芯片读失败：提示失败但仍提交文字', async () => {
    const app = await mount({
      clipboardReader: () => Promise.resolve({ kind: 'image', path: badImagePath }),
    })
    await app.press('\x16')
    expectFrame(app, '[图#1] bad.txt')

    await app.press('hi')
    await app.press('\r')
    expectFrame(app, '图片读取失败（太大或 IO 错误）：bad.txt')
    expect(app.calls.submit.at(-1)?.text).toBe('hi')
    expect(app.calls.submit.at(-1)?.images).toBeUndefined()
  })
})

// ── 模型 / 模式 / 技能浮层 ────────────────────────────────────────────────────

const MODELS = [
  {
    value: 'ark/model-a',
    provider: 'ark',
    providerDisplayName: 'ARK',
    model: 'model-a',
    description: '端点 A',
    contextWindow: 1000,
    thinkingLevels: [],
  },
  {
    value: 'ark/model-b',
    provider: 'ark',
    providerDisplayName: 'ARK',
    model: 'model-b',
    description: '端点 B',
    contextWindow: 1000,
    thinkingLevels: [],
  },
]

const PRESETS = {
  current: 'build',
  defaultName: 'build',
  options: [
    { name: 'build', label: '执行', description: '默认', tools: null, drop: [], deny: [] },
    { name: 'plan', label: '计划', description: '只读', tools: [], drop: [], deny: [] },
  ],
  droppable: [],
}

const SKILLS = [
  {
    name: 'alpha',
    description: '甲技能',
    source: 'global',
    enabled: true,
    modelInvocable: true,
    userInvocable: false,
    toggleable: true,
  },
  {
    name: 'beta',
    description: '乙技能',
    source: 'global',
    enabled: true,
    modelInvocable: true,
    userInvocable: true,
    toggleable: true,
  },
]

describe('模型选择浮层', () => {
  test('/model：↓ 选中第二项 Enter 切换；重开按 Esc 不调用', async () => {
    const app = await mount({ models: MODELS })

    await app.press('/model')
    await app.press('\r')
    expectFrame(app, '模型选择（2 个）')

    await app.press('\x1b[B')
    await app.press('\r')
    expect(app.calls.setModel).toEqual(['ark/model-b'])
    expectNoFrame(app, '模型选择')

    await app.press('/model')
    await app.press('\r')
    expectFrame(app, '模型选择（2 个）')
    await app.press('\x1b')
    expectNoFrame(app, '模型选择')
    expect(app.calls.setModel).toEqual(['ark/model-b'])
  })

  test('/model：输入即筛选（只剩含 b 的候选）', async () => {
    const app = await mount({ models: MODELS })
    await app.press('/model')
    await app.press('\r')

    await app.press('b')
    expectFrame(app, 'ark/model-b')
    expectNoFrame(app, 'ark/model-a')
  })
})

describe('模式选择浮层', () => {
  test('/preset：↓ 选中第二项，Enter 调用 usePreset 并提示', async () => {
    const app = await mount({ presets: PRESETS })
    await app.press('/preset')
    await app.press('\r')
    expectFrame(app, '模式选择（2 个）')

    await app.press('\x1b[B')
    await app.press('\r')
    expect(app.calls.usePreset).toEqual(['plan'])
    expectFrame(app, '已切换到模式「plan」')
    expectNoFrame(app, '模式选择')
  })

  test('/preset：usePreset 失败时把错误放 notice', async () => {
    const app = await mount({
      presets: PRESETS,
      usePresetResult: { ok: false, error: '写盘失败' },
    })
    await app.press('/preset')
    await app.press('\r')
    await app.press('\r')

    expect(app.calls.usePreset).toEqual(['build'])
    expectFrame(app, '写盘失败')
  })
})

describe('技能选择浮层', () => {
  test('不可回填项只提示不关页；可回填项关页并回填 /名字', async () => {
    const app = await mount({ skills: SKILLS })
    await app.press('/skills')
    await app.press('\r')
    expectFrame(app, '技能（2 个）')

    // 不可回填：浮层不关（notice 被浮层盖着，Esc 回主界面后才看得见）。
    await app.press('\r')
    expectFrame(app, '技能（2 个）')
    await app.press('\x1b')
    expectFrame(app, '技能 alpha 没注册成命令')

    // 重开，↓ 到可回填项：关页并把 /beta 灌回输入行。
    await app.press('/skills')
    await app.press('\r')
    expectFrame(app, '技能（2 个）')
    await app.press('\x1b[B')
    await app.press('\r')
    expectNoFrame(app, '技能（2 个）')
    expectFrame(app, '/beta')
  })
})

// ── 会话选择器动作 ────────────────────────────────────────────────────────────

describe('会话选择器 Ctrl 动作组', () => {
  test('Ctrl+P 置顶、Ctrl+A 归档（都作用于当前选中会话）', async () => {
    const app = await mount({ snapshot: makeSnapshot({ sessions: SESSIONS }) })
    await app.press('/resume')
    await app.press('\r')
    expectFrame(app, 'Tab 切归档页')

    await app.press('\x10')
    expect(app.calls.pin).toEqual([['/w/s0.jsonl', true]])

    await app.press('\x01')
    expect(app.calls.archive).toEqual(['/w/s0.jsonl'])
  })

  test('Ctrl+X 第一次只 arm，第二次才永久删除', async () => {
    const app = await mount({ snapshot: makeSnapshot({ sessions: SESSIONS }) })
    await app.press('/resume')
    await app.press('\r')

    await app.press('\x18')
    expect(app.calls.purge, '第一次 Ctrl+X 只进入确认态').toEqual([])
    expectFrame(app, '再按一次 Ctrl+X 确认永久删除')

    await app.press('\x18')
    expect(app.calls.purge).toEqual(['/w/s0.jsonl'])
  })

  test('Ctrl+F 在最后一条用户消息之后分叉并打开新会话', async () => {
    const app = await mount({
      snapshot: makeSnapshot({ sessions: SESSIONS }),
      userMessages: ['m1', 'm2', 'm3'],
    })
    await app.press('/resume')
    await app.press('\r')

    await app.press('\x06')
    expect(app.calls.fork).toEqual([['/w/s0.jsonl', 3]])
    expect(app.calls.open).toContain('/w/forked.jsonl')
    expectNoFrame(app, 'Tab 切归档页')
  })

  test('Ctrl+R 改名：缓冲预填标题、可退格重输、Enter 保存', async () => {
    const app = await mount({ snapshot: makeSnapshot({ sessions: SESSIONS }) })
    await app.press('/resume')
    await app.press('\r')

    await app.press('\x12')
    expectFrame(app, '改名：标题0')

    await app.press('\x7f')
    await app.press('X')
    expectFrame(app, '改名：标题X')

    await app.press('\r')
    expect(app.calls.rename).toEqual([['/w/s0.jsonl', '标题X']])
    expectNoFrame(app, '改名：')
  })

  test('Tab 切归档页并列出条目，Ctrl+U 恢复，Esc 关闭', async () => {
    const app = await mount({
      snapshot: makeSnapshot({ sessions: SESSIONS }),
      archived: [
        {
          path: '/w/old.jsonl',
          cwd: '/w',
          title: '旧会话',
          createdAt: 1,
          updatedAt: 2,
          archivedAt: 3,
        },
      ],
    })
    await app.press('/resume')
    await app.press('\r')

    await app.press('\t')
    expectFrame(app, '旧会话')
    expectFrame(app, 'Tab 切活动页')

    await app.press('\x15')
    expect(app.calls.restore).toEqual(['/w/old.jsonl'])

    await app.press('\x1b')
    expectNoFrame(app, 'Tab 切活动页')
  })
})

// ── 聊天回底与提示音 ──────────────────────────────────────────────────────────

describe('聊天回底与提示音', () => {
  test('PgUp 回看出现回底胶囊，Enter 回到底部', async () => {
    const app = await mount({
      snapshot: makeSnapshot({
        entries: Array.from({ length: 120 }, (_, i) => ({ id: i, kind: 'system', text: `条目-${i}` })),
      }),
    })
    expectFrame(app, '条目-119')

    await app.press('\x1b[5~')
    expectFrame(app, '回到底部')

    await app.press('\r')
    expectNoFrame(app, '回到底部')
    expectFrame(app, '条目-119')
  })

  test('回合从跑动回空闲时写 BEL', async () => {
    const app = await mount()
    await app.setSnapshot(makeSnapshot({ status: { turnState: 'running' } }))
    await app.setSnapshot(makeSnapshot({ status: { turnState: 'idle' } }))

    expect(app.raw().includes('\x07'), JSON.stringify(app.raw().slice(-120))).toBe(true)
  })
})

// ── 图片预览翻页 ──────────────────────────────────────────────────────────────

describe('图片预览浮层', () => {
  test('会话内两张图：点击打开，←→ 切换，Esc 关闭', async () => {
    const app = await mount({
      snapshot: makeSnapshot({
        entries: [
          {
            id: 1,
            kind: 'user',
            text: '看图',
            images: ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'],
          },
        ],
      }),
      imageRenderer: () => Promise.resolve('BLOCK-CHARS'),
    })

    const row = app.lines().findIndex((line) => line.includes('🖼 2 张图片 · 点击预览'))
    expect(row, JSON.stringify(app.lines())).toBeGreaterThanOrEqual(0)
    await app.press(`\x1b[<0;3;${row + 1}M`)
    expectFrame(app, '图片（2 张）（1/2）')
    expectFrame(app, 'BLOCK-CHARS')

    await app.press('\x1b[C')
    expectFrame(app, '（2/2）')

    await app.press('\x1b[D')
    expectFrame(app, '（1/2）')

    await app.press('\x1b')
    expectNoFrame(app, 'BLOCK-CHARS')
  })
})
