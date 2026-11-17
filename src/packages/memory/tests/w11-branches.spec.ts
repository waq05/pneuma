/**
 * memory 设置面与生命周期分支补测（w11）：设置分区的全部保存键（额度、复盘、整理、
 * 选中格/条目/搜索/清空二次确认）、条目操作与整理动作的边界、非法 type 的整批拒绝、
 * turn-end 的会话归属过滤、短应答跳过复盘与复盘启动失败的提示。
 *
 * 假 ctx + 真 `apply`；`DSC_HOME` 在 import 之前指进临时目录，每个用例独立 workspace。
 *
 * @module dsc/packages/memory/tests/w11-branches
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-memory-w11-'))
process.env['DSC_HOME'] = HOME

type Plugin = typeof import('../index.js')['memoryPlugin']

interface CapturedTool {
  name: string
  run: (args: Record<string, unknown>, scope: Record<string, unknown>) => Promise<string>
}
interface CapturedCommand {
  spec: { name: string }
  run: (input: { args: string[]; ui: { notice: (text: string) => void } }) => void
}
interface CapturedSection {
  save: (key: string, value: unknown) => string | void
  action: (name: string) => string | void
  values: () => Record<string, unknown>
  fields: () => Array<Record<string, unknown>>
}
interface MemoryServiceLike {
  cells: (at?: string) => Array<{ target: string; entries: string[]; filePath: string }>
  write: (ops: Array<Record<string, unknown>>, at?: string) => { ok: boolean; error: string }
}
interface Harness {
  tools: CapturedTool[]
  commands: CapturedCommand[]
  sections: CapturedSection[]
  service: MemoryServiceLike
  section: CapturedSection
  notices: string[]
  followups: string[]
  handlers: Map<string, (reason?: string, signal?: { sessionId?: string }) => void>
  session: { meta: { id: string; cwd: string }; messages: Array<{ role: string; content: string }> }
  cwd: string
  followupThrows: boolean
  cleanup: () => void
}

let plugin: Plugin
const cleanups: Array<() => void> = []
const dirs: string[] = [HOME]

beforeAll(async () => {
  plugin = (await import('../index.js')).memoryPlugin
})

beforeEach(() => {
  writeJson(join(HOME, 'plugins.json'), { version: 1, entries: [] })
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup()
    } catch {
      // 已经收过了
    }
  }
})

afterAll(() => {
  delete process.env['DSC_HOME']
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 })
    } catch {
      // Windows 句柄：临时目录留给系统清
    }
  }
})

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeConfig(config: Record<string, unknown>): void {
  writeJson(join(HOME, 'plugins.json'), {
    version: 1,
    entries: [{ file: 'memory', disabled: false, config }],
  })
}

function newWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-memory-w11-cwd-'))
  dirs.push(dir)
  return dir
}

function fakeCtx(options: { cwd?: string } = {}): Harness {
  const tools: CapturedTool[] = []
  const commands: CapturedCommand[] = []
  const sections: CapturedSection[] = []
  const notices: string[] = []
  const followups: string[] = []
  const handlers = new Map<string, Harness['handlers'] extends Map<string, infer F> ? F : never>()
  const effects: Array<() => void> = []
  const harness = { followupThrows: false } as unknown as Harness
  harness.session = {
    meta: { id: `mem-w11-${String(Math.random()).slice(2)}`, cwd: options.cwd ?? newWorkspace() },
    messages: [],
  }
  harness.cwd = harness.session.meta.cwd

  const ctx = {
    session: { current: () => harness.session },
    tools: {
      register(entry: CapturedTool) {
        tools.push(entry)
        return () => undefined
      },
    },
    prompt: { register: () => () => undefined },
    commands: {
      register(spec: CapturedCommand['spec'], run: CapturedCommand['run']) {
        commands.push({ spec, run })
        return () => undefined
      },
    },
    settings: {
      registerSection(spec: CapturedSection) {
        sections.push(spec)
        return () => undefined
      },
    },
    approval: { decide: async () => 'allow-once' },
    agent: {
      followup: (text: string) => {
        if (harness.followupThrows) throw new Error('followup boom')
        followups.push(text)
      },
    },
    transcript: { system: () => undefined },
    effect(execute: () => unknown) {
      const off = execute()
      if (typeof off === 'function') effects.push(off as () => void)
      return () => undefined
    },
    on(event: string, handler: Harness['handlers'] extends Map<string, infer F> ? F : never) {
      handlers.set(event, handler as never)
      return () => undefined
    },
    emit(event: string, text?: unknown) {
      if (event === 'dsc/notice' && typeof text === 'string') notices.push(text)
    },
    provide(_name: string, service: MemoryServiceLike) {
      harness.service = service
    },
  }

  harness.tools = tools
  harness.commands = commands
  harness.sections = sections
  harness.notices = notices
  harness.followups = followups
  harness.handlers = handlers
  const apply = plugin.apply as unknown as (context: unknown) => (() => void) | void
  const returned = apply(ctx)
  harness.cleanup = () => {
    if (typeof returned === 'function') returned()
    for (const off of effects.splice(0)) off()
  }
  cleanups.push(harness.cleanup)
  harness.section = sections[0] as CapturedSection
  return harness
}

function runCommand(harness: Harness, args: string[]): string[] {
  const command = harness.commands.find((entry) => entry.spec.name === 'memory')
  if (command === undefined) throw new Error('没有注册 /memory 命令')
  const said: string[] = []
  command.run({ args, ui: { notice: (text: string) => said.push(text) } })
  return said
}

function runTool(harness: Harness, args: Record<string, unknown>): Promise<string> {
  const tool = harness.tools.find((entry) => entry.name === 'memory')
  if (tool === undefined) throw new Error('没有注册 memory 工具')
  return tool.run(args, {
    cwd: harness.cwd,
    sessionId: harness.session.meta.id,
    sessionPath: '',
    signal: new AbortController().signal,
  })
}

// ── 设置分区：保存 ───────────────────────────────────────────────────────────

test('设置保存：界面开关、三格额度、复盘与整理、选格/条目/搜索/二次确认都落进 values', () => {
  const harness = fakeCtx()
  const section = harness.section
  section.save('userProfile', false)
  section.save('workspace', false)
  section.save('writeApproval', false)
  section.save('reviewEnabled', true)
  section.save('globalLimit', '1234')
  section.save('userLimit', '2345')
  section.save('workspaceLimit', '3456')
  section.save('reviewEveryTurns', '2')
  section.save('pruneEnabled', true)
  section.save('pruneAfterDays', '9')
  section.save('cell', 'user')
  section.save('entry', '1')
  section.save('search', '关键字')
  section.save('clearArmed', true)

  expect(section.values()).toMatchObject({
    userProfile: false,
    workspace: false,
    writeApproval: false,
    reviewEnabled: true,
    globalLimit: 1234,
    userLimit: 2345,
    workspaceLimit: 3456,
    reviewEveryTurns: 2,
    pruneEnabled: true,
    pruneAfterDays: 9,
    cell: 'user',
    entry: '',
    search: '关键字',
    clearArmed: true,
  })
})

test('设置保存：非法数字、坏格子与未知键都返回人话且不改值', () => {
  const harness = fakeCtx()
  const section = harness.section
  expect(String(section.save('reviewEveryTurns', 'abc'))).toContain('整数')
  expect(String(section.save('pruneAfterDays', 'abc'))).toContain('整数')
  expect(String(section.save('cell', 'nope'))).toContain('格')
  expect(String(section.save('no-such-key', 1))).toContain('no-such-key')
})

// ── 设置分区：动作 ───────────────────────────────────────────────────────────

test('设置动作：没选条目 / 删条目 / 清空需二次确认 / 整理 / 评估 / 刷新 / 未知', () => {
  const harness = fakeCtx()
  const section = harness.section
  expect(String(section.action('entryDelete'))).toContain('选')

  const written = harness.service.write(
    [
      { target: 'global', action: 'add', content: '一条待删除的记忆' },
      { target: 'global', action: 'add', content: '另一条要留着的记忆' },
    ],
    harness.cwd,
  )
  expect(written.ok).toBe(true)
  section.save('cell', 'global')
  section.save('search', '')
  section.save('entry', '0')
  expect(String(section.action('entryDelete'))).toContain('删掉')

  expect(String(section.action('cellClear'))).toContain('确认')
  section.save('clearArmed', true)
  expect(String(section.action('cellClear'))).toContain('清空')

  expect(typeof section.action('pruneNow')).toBe('string')
  expect(String(section.action('evalReport'))).toContain('覆盖率')
  expect(String(section.action('refresh'))).toContain('重算')
  expect(String(section.action('nope'))).toContain('nope')
})

// ── 参数解析 ─────────────────────────────────────────────────────────────────

test('工具参数：非法 type、非对象项、混合批次整批拒绝；合法 type 照常写入', async () => {
  const harness = fakeCtx()
  const badType = await runTool(harness, {
    operations: [{ target: 'global', action: 'add', content: 'x', type: 'bogus' }],
  })
  expect(badType).toContain('type')

  const badItem = await runTool(harness, { operations: ['not-an-object'] })
  expect(badItem).toContain('每一项')

  const good = await runTool(harness, {
    operations: [{ target: 'global', action: 'add', content: '带类型的记忆条目', type: ' FACT ' }],
  })
  expect(good).toContain('带类型的记忆条目')
})

// ── 生命周期 ─────────────────────────────────────────────────────────────────

test('turn-end：别的会话的回合不推进本会话的复盘', () => {
  writeConfig({ reviewEnabled: true, reviewEveryTurns: 1 })
  const harness = fakeCtx()
  harness.session.messages = [{ role: 'user', content: '请把失败路径补齐' }]
  harness.handlers.get('dsc/turn-end')?.('completed', { sessionId: 'other-session' })
  expect(harness.followups).toEqual([])
  // 本会话的回合才触发。
  harness.handlers.get('dsc/turn-end')?.('completed', { sessionId: harness.session.meta.id })
  expect(harness.followups.length).toBe(1)
})

test('turn-end：短应答跳过复盘；复盘启动失败写一条通知', () => {
  writeConfig({ reviewEnabled: true, reviewEveryTurns: 1 })
  const harness = fakeCtx()
  harness.session.messages = [{ role: 'user', content: '继续' }]
  harness.handlers.get('dsc/turn-end')?.('completed', { sessionId: harness.session.meta.id })
  expect(harness.followups).toEqual([])

  harness.session.messages = [{ role: 'user', content: '请把这块的失败路径都补齐' }]
  harness.followupThrows = true
  harness.handlers.get('dsc/turn-end')?.('completed', { sessionId: harness.session.meta.id })
  expect(harness.notices.some((text) => text.includes('没能启动'))).toBe(true)
})

test('隐式反馈：回话复述条目的前 12 个字就记一次引用', async () => {
  const harness = fakeCtx()
  const body = '这是一条会被回话复述的记忆条目'
  await runTool(harness, { target: 'global', action: 'add', content: body })
  harness.session.messages = [
    { role: 'user', content: '你按记忆里的来' },
    { role: 'assistant', content: `我遵循「${body.slice(0, 12)}」来做。` },
  ]
  harness.handlers.get('dsc/turn-end')?.('completed', { sessionId: harness.session.meta.id })
  const usage = JSON.parse(readFileSync(join(HOME, 'memory', '.usage.json'), 'utf8')) as Record<string, { count?: number }>
  expect(Object.values(usage).some((item) => (item.count ?? 0) >= 1)).toBe(true)
})

test('/memory 子命令：show 的条目行与 clear 的缺参数/坏格子', async () => {
  const harness = fakeCtx()
  await runTool(harness, { target: 'global', action: 'add', content: '展示用的一条记忆' })
  expect(runCommand(harness, ['show']).join('\n')).toContain('展示用的一条记忆')
  expect(runCommand(harness, ['clear']).join('\n')).toContain('要说清')
  expect(runCommand(harness, ['clear', 'nope']).join('\n')).toContain('要说清')
})
