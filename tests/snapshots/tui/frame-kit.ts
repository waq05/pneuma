/**
 * TUI 帧快照的公共骨架：假终端 + 假 runtime + 整屏帧提取。
 *
 * ## 为什么单独一份，而不是每个场景各写一遍
 *
 * 「起 App、喂快照、等一帧稳定、剥 ANSI、取最后一帧」这五步在 `app-features.spec.ts`、
 * `chat-compacting.spec.ts` 里各有一次实现，细节还不同（一个从累计输出取尾巴，一个从
 * 最后一个 `\x1b[2K` 取尾巴）。快照场景要的是**逐字节可比**的整屏帧，读法必须统一：
 * 差一个行尾空格、差一次光标序列，golden 就会在无意义的地方红。所以把读法收在这里。
 *
 * ## 帧为什么从最后一个 `\x1b[2K` 取
 *
 * ink 用 log-update 重画：擦掉上一帧的每一行时先写 `\x1b[2K`，最后一个 `\x1b[2K`
 * 之后紧接着就是**新一帧的正文**（擦除块结束后才开始写内容）。取最后一个，拿到的是
 * 「这次重画后的整屏」；从累计输出开头取会把历史帧也拼进来。
 *
 * ## 确定性
 *
 * - 假终端的列数/行数显式给，不读真实终端。
 * - 时间：条目不带 `ts`；子代理卡用 `idle` + 固定起止时刻，不显示「现在 - 开始」。
 * - 路径：sessionId / cwd 固定为 `/w`，帧里不会出现临时目录。
 * - 只有盲文 spinner 与「已用 Ns」是时间函数，`normalizeFrame` 把它们折成占位符；
 *   其余文本原样进 golden，数字变化仍然会红。
 *
 * @module dsc/tests/snapshots/tui/frame-kit
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { render } from 'ink'
import type {
  AskUserView,
  DscRuntime,
  GoalView,
  PlanView,
  RuntimeSnapshot,
  StatusView,
  TodoView,
  TranscriptEntry,
} from '@pneuma/runtime/contract.js'
import type { CommandContext } from '@pneuma/runtime/services/types.js'
import { tempHome } from '../../harness.js'

/** 真实可解码的 1×1 PNG：附件芯片只读文件名，但剪贴板读取器要求真文件。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 场景统一的临时主目录：`DSC_HOME` 必须在 App 被动态 import 之前换好。 */
export const home = tempHome('dsc-tui-frames-')
const originalDscHome = process.env.DSC_HOME
process.env.DSC_HOME = join(home.home, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })
/** 附件芯片读这个文件；名字固定，帧里只出现 `pic.png`。 */
export const pngPath = join(process.env.DSC_HOME, 'pic.png')
writeFileSync(pngPath, PNG_1PX)

/** 场景结束时还原环境（`tempHome` 的约定：临时目录保留，环境变量还回去）。 */
export function restoreHome(): void {
  if (originalDscHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = originalDscHome
  home.restore()
}

/** 当前会话身份的固定值：帧里不许出现随机目录。 */
const SESSION_PATH = '/w/s.jsonl'
const CWD = '/w'

/** 状态栏底座：字段都显式给，避免默认值随产品改动漂。 */
export function status(overrides: Partial<StatusView> = {}): StatusView {
  return {
    sessionId: SESSION_PATH,
    model: 'test-model',
    provider: 'test-provider',
    effort: 'high',
    turnState: 'idle',
    usage: null,
    contextWindow: 1_000_000,
    contextUsed: 12_345,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    progress: { turns: 0, steps: 0 },
    cwd: CWD,
    ...overrides,
  }
}

/** 任务清单底座。 */
export function todos(overrides: Partial<TodoView> = {}): TodoView {
  return { items: [], revision: 1, done: 0, total: 0, active: null, ...overrides }
}

/** RuntimeSnapshot 底座：App 渲染时读到的字段都有确定值。 */
export function snapshot(entries: TranscriptEntry[], overrides: Record<string, unknown> = {}): RuntimeSnapshot {
  const base: Record<string, unknown> = {
    entries,
    status: status(),
    surfaces: {
      git: { repo: true, branch: 'main', detached: false, dirtyFileCount: 0 },
      pendingApproval: null,
      policy: {
        current: 'auto-edit',
        options: [{ id: 'auto-edit', label: '工作区自动', hint: '' }],
        reviewer: 'user',
        reviewerOptions: [{ id: 'user', label: '本人', hint: '' }],
      },
      permissionPresets: { current: 'custom', defaultName: 'default', options: [] },
      mode: { current: 'build', options: [{ id: 'build', label: '执行', hint: '' }] },
      preset: { current: 'default', defaultName: 'default', options: [], droppable: [] },
      todos: todos(),
      pendingPlan: null,
      goal: null,
      pendingQuestion: null,
      backgroundWorks: [],
      planDirectory: [],
      scheduled: [],
      superagent: {},
    },
    sessions: [],
    sessionsLoading: false,
    sessionStates: {},
    subagents: [],
    queued: [],
    notices: [],
  }
  return {
    ...base,
    ...overrides,
    status: { ...(base.status as object), ...((overrides.status as object) ?? {}) },
    surfaces: { ...(base.surfaces as object), ...((overrides.surfaces as object) ?? {}) },
  } as unknown as RuntimeSnapshot
}

/** 一条用户消息（不带 ts：帧里不出现时钟）。 */
export const userEntry = (id: number, text: string, extra: Partial<Extract<TranscriptEntry, { kind: 'user' }>> = {}): TranscriptEntry => ({
  id,
  kind: 'user',
  text,
  ...extra,
})
/** 一条助手正文。 */
export const textEntry = (id: number, text: string, extra: Partial<Extract<TranscriptEntry, { kind: 'text' }>> = {}): TranscriptEntry => ({
  id,
  kind: 'text',
  text,
  ...extra,
})
/** 一条思考。 */
export const thinkingEntry = (id: number, text: string, extra: Partial<Extract<TranscriptEntry, { kind: 'thinking' }>> = {}): TranscriptEntry => ({
  id,
  kind: 'thinking',
  text,
  ...extra,
})
/** 一条工具调用。 */
export const toolEntry = (
  id: number,
  overrides: Partial<Extract<TranscriptEntry, { kind: 'tool' }>['call']> = {},
): TranscriptEntry => ({
  id,
  kind: 'tool',
  call: {
    callId: `call-${String(id)}`,
    name: 'read_file',
    argsText: '{"file_path":"/w/README.md"}',
    status: 'done',
    ...overrides,
  },
})

/** 一批固定的队友（/agents 浮层与子代理卡的共同来源）。 */
export const teammates = [
  {
    name: 'writer-1',
    role: 'writer',
    state: 'working' as const,
    task: '写正文',
    file: '/w/agent-writer.jsonl',
    parent: 'lead',
    depth: 1,
    rounds: 3,
    startedAt: 1_000,
  },
  {
    name: 'reviewer-1',
    role: 'reviewer',
    state: 'idle' as const,
    task: '复核改动',
    file: '/w/agent-reviewer.jsonl',
    parent: 'lead',
    depth: 1,
    rounds: 2,
    startedAt: 2_000,
  },
]

/** 一条待批审批（纯卡片；diff 由调用方补）。 */
export function approval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'approval-1',
    toolName: 'write_file',
    argsSummary: '{"file_path":"/w/README.md"}',
    meaning: '要写入 README.md',
    reason: '写文件需要确认',
    risk: 'medium',
    suggestedRule: null,
    hardline: false,
    scopes: ['once', 'session', 'always'],
    policy: 'auto-edit',
    reviewer: 'user',
    mode: 'build',
    ...overrides,
  }
}

/** 一条提问（单题、三选项）。 */
export function question(overrides: Partial<AskUserView> = {}): AskUserView {
  return {
    id: 'ask-1',
    question: '先做哪一块？',
    header: '范围',
    options: [
      { label: '内核', description: '先动 src/core' },
      { label: '界面', description: '先动 ui-shell' },
      { label: '测试', description: '先补门禁' },
    ],
    multiSelect: false,
    allowFreeText: true,
    ...overrides,
  }
}

/** 一份待批计划。 */
export function plan(overrides: Partial<PlanView> = {}): PlanView {
  return {
    file: '/w/.dsc/plans/plan.md',
    title: '测试层收尾',
    text: ['# 测试层收尾', '', '1. 建帧快照', '2. 跑两遍', '3. 写报告'].join('\n'),
    decision: 'pending',
    ...overrides,
  }
}

/** 一个会话目标。 */
export function goal(overrides: Partial<GoalView> = {}): GoalView {
  return {
    objective: '把 TUI 帧快照层建起来',
    phase: 'active',
    rounds: 2,
    maxRounds: 8,
    armed: false,
    ...overrides,
  }
}

/** 场景可选的运行参数。 */
export interface MountOptions {
  columns?: number
  rows?: number
  /** 状态栏段显隐（`getUiPrefs().statusBar`）；缺省 = 出厂默认。 */
  statusBar?: Record<string, boolean>
  clipboardReader?: () => Promise<{ kind: 'image'; path: string }>
  imageRenderer?: () => Promise<string>
}

/** 挂载后的帧句柄。`text` 是当前最后一帧（剥过 ANSI、折过 spinner 占位）。 */
export interface MountedFrame {
  readonly text: string
  readonly raw: string
  /** 敲一段键并等帧稳定；与 app-features 的 `press` 同款。 */
  press(keys: string): Promise<void>
  unmount(): void
}

/** 等输出长度连续几拍不再变化（最少 `floorMs`）。 */
async function settle(read: () => number, floorMs = 200, deadlineMs = 3_000): Promise<void> {
  const startedAt = Date.now()
  let previous = -1
  let stable = 0
  while (Date.now() < startedAt + deadlineMs) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 25))
    const length = read()
    if (length === previous) stable += 1
    else {
      stable = 0
      previous = length
    }
    if (Date.now() - startedAt >= floorMs && stable >= 2) return
  }
}

/** 剥掉 ANSI 的 SGR / 光标序列与 OSC。 */
function clean(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
}

/**
 * 把「与业务无关的无常项」折成固定占位符（别的原样比）。
 *
 * 三处归一，都有明确理由：
 * - 盲文 spinner 与「已用 Ns」是时间函数；
 * - 版本号（`v0.9.1`）每次发版都会变——Welcome 页出现在 29 份 golden 里，不归一
 *   就是「发一次版红一大片」。版本一致性另有闸（根 package.json 与 tag 对齐），
 *   快照层不需要重复承担这件事。
 */
export function normalizeFrame(text: string): string {
  return text
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '⠋')
    .replace(/已用 \d+m\d+s/g, '已用 <elapsed>')
    .replace(/已用 \d+s/g, '已用 <elapsed>')
    .replace(/\bv\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g, '<version>')
}

/** 取「最后一次重画」的整屏帧。 */
function extractFrame(raw: string): string {
  const at = raw.lastIndexOf('\x1b[2K')
  const tail = at >= 0 ? raw.slice(at) : raw
  return normalizeFrame(clean(tail))
}

/** App 的最小假 runtime（与 app-features 同款，只是方法齐全）。 */
function makeRuntime(initial: RuntimeSnapshot, options: MountOptions): { runtime: DscRuntime; setSnapshot(next: RuntimeSnapshot): void } {
  const listeners = new Set<() => void>()
  let current = initial
  const runtime: Record<string, unknown> = {
    subscribe(cb: () => void) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getSnapshot: () => current,
    setSnapshot(next: RuntimeSnapshot) {
      current = next
      for (const listener of [...listeners]) listener()
    },
    listModels: () => [],
    listPresets: () => [],
    listSkills: () => [],
    ...(options.statusBar === undefined
      ? {}
      : { getUiPrefs: () => ({ statusBar: options.statusBar }) }),
    dock: () => Promise.resolve({ entries: [] }),
    submit() {},
    openSession() {},
    refreshSessions: () => Promise.resolve(),
    listArchivedSessions: () => Promise.resolve({ items: [] }),
    renameSession: () => Promise.resolve({ ok: true }),
    setSessionPinned: () => Promise.resolve({ ok: true }),
    archiveSessions: () => Promise.resolve({ ok: true }),
    restoreSessions: () => Promise.resolve({ ok: true }),
    purgeSessions: () => Promise.resolve({ ok: true }),
    forkSession: () => Promise.resolve({ ok: true, path: '/w/fork.jsonl' }),
    listUserMessages: () => Promise.resolve([]),
    listTeammates: () => teammates,
    peekTranscript: () => Promise.resolve([]),
    setModel() {},
    interrupt() {},
    exit() {},
    answerApproval() {},
    answerQuestion() {},
    answerPlan() {},
  }
  return { runtime: runtime as unknown as DscRuntime, setSnapshot: runtime['setSnapshot'] as (next: RuntimeSnapshot) => void }
}

/** 假命令派发：只认 `/agents`，走 App 真实的「命令 → ui.openAgents」通道。 */
function dispatchCommand(input: string, _runtime: DscRuntime, ui: CommandContext): boolean {
  if (input === '/agents' || input.startsWith('/agents ')) {
    ui.openAgents?.()
    return true
  }
  return false
}

/**
 * 挂载 App 并返回整屏帧句柄。App 动态 import（`DSC_HOME` 已经在模块顶层换好）。
 *
 * @param app - `beforeAll` 里动态 import 的 App 组件（测试文件持有，避免每场景重载模块）。
 */
export async function mountFrame(
  app: unknown,
  initial: RuntimeSnapshot,
  options: MountOptions = {},
): Promise<MountedFrame> {
  const columns = options.columns ?? 110
  const rows = options.rows ?? 40
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
  stdout.columns = columns
  stdout.rows = rows
  stdout.isTTY = false
  let raw = ''
  stdout.on('data', (chunk: Buffer) => {
    raw += String(chunk)
  })
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

  const { runtime } = makeRuntime(initial, options)
  const instance = render(
    createElement(app as React.ComponentType<Record<string, unknown>>, {
      runtime,
      dispatchCommand,
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
  await settle(() => raw.length)
  return {
    get text() {
      return extractFrame(raw)
    },
    get raw() {
      return raw
    },
    async press(keys: string) {
      stdin.write(keys)
      await settle(() => raw.length)
    },
    unmount() {
      instance.unmount()
    },
  }
}

/** 帧里某段文字所在的行号（0 基）；找不到 = -1。 */
export function lineOf(frame: string, needle: string): number {
  return frame.replace(/\n$/, '').split('\n').findIndex((line) => line.includes(needle))
}

/** 帧的行数组。 */
export function frameLines(frame: string): string[] {
  return frame.replace(/\n$/, '').split('\n')
}
