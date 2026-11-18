/**
 * self-improve 的补盲（`packages/self-improve/index.ts`）：插件自发轮次的收尾分支、
 * 候选转技能/记忆的降级，以及会话状态写不进去时的容错。
 *
 * 真 `apply` + 假 ctx；DSC_HOME 在 import 前指到临时目录，技能与候选都落临时盘。
 *
 * @module @pneuma/self-improve/tests/w11-branches.spec
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-self-improve-w11-'))
process.env['DSC_HOME'] = HOME
const WORK = join(HOME, 'work')
mkdirSync(WORK, { recursive: true })

let plugin: typeof import('../index.js').selfImprovePlugin
let store: typeof import('../store.js')

beforeAll(async () => {
  plugin = (await import('../index.js')).selfImprovePlugin
  store = await import('../store.js')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 偶发占用
  }
})

interface Message {
  role: 'user' | 'assistant' | 'tool'
  content?: unknown
}

interface Options {
  enabled?: boolean
  messages?: Message[]
  memoryOk?: boolean
  appendStateThrows?: boolean
  throwingDisposer?: boolean
}

interface Harness {
  tool(name: string): { run: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }
  command(name: string): { run: (input: { args: string[]; ui: { notice: (text: string) => void } }) => void }
  messages: Message[]
  notices: string[]
  followups: string[]
  memoryWrites: Array<{ operations: unknown[]; cwd?: string }>
  turnEnd(reason: 'completed' | 'aborted' | 'error'): void
  disposer(): void
}

function mount(options: Options = {}): Harness {
  const messages: Message[] = options.messages ?? []
  const state = new Map<string, unknown>()
  const noticeLines: string[] = []
  const followups: string[] = []
  const memoryWrites: Harness['memoryWrites'] = []
  const handlers = new Map<string, (reason?: unknown) => void>()
  const disposers: Array<() => void> = []
  const tools = new Map<string, { run: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }>()
  const commands = new Map<string, { run: (input: { args: string[]; ui: { notice: (text: string) => void } }) => void }>()

  const session = {
    meta: { id: 's1', cwd: WORK },
    filePath: join(HOME, 'sessions', 's1.jsonl'),
    messages,
    toolErrors: new Map<string, string>(),
    state: (name: string) => state.get(name),
    appendState: (name: string, value: unknown) => {
      if (options.appendStateThrows === true) throw new Error('日志写不进去')
      state.set(name, value)
    },
  }

  const track = (off: () => void): (() => void) => {
    const wrapped = (): void => {
      if (options.throwingDisposer === true) throw new Error('卸载失败')
      off()
    }
    disposers.push(wrapped)
    return wrapped
  }

  const ctx = {
    effect(fn: () => unknown) {
      const out = fn()
      return track(typeof out === 'function' ? (out as () => void) : () => undefined)
    },
    on(event: string, handler: (reason?: unknown) => void) {
      handlers.set(event, handler)
      return () => {
        handlers.delete(event)
      }
    },
    tools: {
      register(tool: { name: string; run: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      list: () => [...tools.values()],
      visible: () => [...tools.values()],
    },
    guards: { register: () => () => undefined },
    commands: {
      register(spec: { name: string }, run: (input: { args: string[]; ui: { notice: (text: string) => void } }) => void) {
        commands.set(spec.name, { run })
        return () => commands.delete(spec.name)
      },
    },
    settings: { registerSection: () => () => undefined },
    prompt: {
      register: () => () => undefined,
      registerProjection: () => () => undefined,
    },
    session: { current: () => session },
    transcript: { system: (text: string) => noticeLines.push(text) },
    approval: { decide: async () => 'allow-once' },
    skills: { setEnabled: () => ({ ok: true }) },
    memory: {
      write(operations: unknown[], cwd?: string) {
        memoryWrites.push({ operations, cwd })
        return options.memoryOk === false ? { ok: false, error: '额度满了' } : { ok: true }
      },
    },
    agent: {
      followup(text: string) {
        followups.push(text)
      },
    },
    emit: () => undefined,
    get: () => undefined,
    logger: { debug: () => undefined },
  }

  const dispose = plugin.apply?.(ctx as never, { enabled: options.enabled ?? true }) as (() => void) | undefined
  if (typeof dispose === 'function') disposers.push(dispose)

  return {
    tool: (name) => tools.get(name)!,
    command: (name) => commands.get(name)!,
    messages,
    notices: noticeLines,
    followups,
    memoryWrites,
    turnEnd: (reason) => handlers.get('dsc/turn-end')?.(reason),
    disposer: () => {
      if (typeof dispose === 'function') dispose()
    },
  }
}

const scope = (): { cwd: string; signal: AbortSignal; sessionId: string; sessionPath: string } => ({
  cwd: WORK,
  signal: new AbortController().signal,
  sessionId: 's1',
  sessionPath: join(HOME, 'sessions', 's1.jsonl'),
})

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

test('learning 工具：总开关关着直接回一句人话', async () => {
  const h = mount({ enabled: false })
  expect(await h.tool('learning').run({ action: 'list' }, scope())).toContain('经验沉淀现在是关着的')
})

test('note 候选 promote as=skill：起一轮沉淀而不是直接落技能', async () => {
  store.recordCandidate(WORK, { kind: 'note', text: '把这条整理成技能', turnRef: 't#1' })
  const id = store.readCandidates(WORK).at(-1)!.id
  const h = mount()
  const out = await h.tool('learning').run({ action: 'promote', id, as: 'skill' }, scope())
  expect(out).toContain('已起一轮技能沉淀')
  expect(h.followups).toHaveLength(1)
  expect(store.readCandidates(WORK).find((entry) => entry.id === id)?.state).toBe('promoted')
})

test('promote as=memory：未知 target 落 workspace；memory 写失败原样回报', async () => {
  store.recordCandidate(WORK, { kind: 'note', text: '记住 A', turnRef: 't#1' })
  const first = store.readCandidates(WORK).at(-1)!.id
  const ok = mount()
  const out = await ok.tool('learning').run({ action: 'promote', id: first, as: 'memory', target: 'bogus' }, scope())
  expect(out).toContain('已把候选')
  expect(ok.memoryWrites[0]?.operations).toEqual([{ action: 'add', target: 'workspace', content: '记住 A' }])

  store.recordCandidate(WORK, { kind: 'note', text: '记住 B', turnRef: 't#1' })
  const second = store.readCandidates(WORK).at(-1)!.id
  const bad = mount({ memoryOk: false })
  expect(await bad.tool('learning').run({ action: 'promote', id: second, as: 'memory' }, scope())).toContain('写进记忆没成')
})

test('会话状态写不进去：/learn 仍能起轮，并提示重启后可能重复', () => {
  const h = mount({ appendStateThrows: true })
  h.command('learn').run({ args: [], ui: { notice: (text: string) => h.notices.push(text) } })
  expect(h.followups).toHaveLength(1)
  expect(h.notices.join('\n')).toContain('会话状态没能记下来')
})

test('沉淀轮收尾：aborted / NONE / 解析失败 / 回了 patch 各不落盘', () => {
  const aborted = mount()
  aborted.command('learn').run({ args: [], ui: { notice: () => undefined } })
  aborted.turnEnd('aborted')
  expect(aborted.notices.join('\n')).toContain('沉淀轮以 aborted 结束')

  const none = mount()
  none.command('learn').run({ args: [], ui: { notice: () => undefined } })
  none.messages.push({ role: 'assistant', content: 'NONE' })
  none.turnEnd('completed')
  expect(none.notices.join('\n')).toContain('没沉淀出技能')

  const invalid = mount()
  invalid.command('learn').run({ args: [], ui: { notice: () => undefined } })
  invalid.messages.push({ role: 'assistant', content: '{}' })
  invalid.turnEnd('completed')
  expect(invalid.notices.join('\n')).toContain('没法解析成技能草稿')

  const revision = mount()
  revision.command('learn').run({ args: [], ui: { notice: () => undefined } })
  revision.messages.push({
    role: 'assistant',
    content: JSON.stringify({ action: 'patch', name: 'x', old_string: 'a', new_string: 'b', reason: 'r' }),
  })
  revision.turnEnd('completed')
  expect(revision.notices.join('\n')).toContain('沉淀轮要的是新建草稿')
})

test('卸载时某个退订抛错：其余清理照常，apply 的 disposer 不抛', () => {
  const h = mount({ throwingDisposer: true })
  expect(() => h.disposer()).not.toThrow()
})

test('候选重复 propose 只加命中', async () => {
  const h = mount()
  const first = await h.tool('learning').run({ action: 'propose', text: '重复经验', kind: 'note' }, scope())
  expect(first).toContain('已记候选')
  const second = await h.tool('learning').run({ action: 'propose', text: '重复经验', kind: 'note' }, scope())
  expect(second).toContain('已经在了')
  await flush()
})
