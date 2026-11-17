/**
 * hooks 的两块分支补测（w11）：
 *
 *   1. `lifecycle-hooks.ts` 的配置文件容错（读不动、坏 JSON、非对象、未知事件、组/条目
 *      形状不对、matcher 不支持、type/async/空命令、超过 50 条截断）与 `runLifecycleCommand`
 *      的超时/取消/输出截断；
 *   2. `hooks/index.ts` 的设置保存键、关闭状态下观察者早退、未批准脚本的提醒、外部钩子
 *      关闭时的守卫早退、PreToolUse note 留言如何进下一次请求，以及 compacted/exit/turn-end
 *      的事件挂点。
 *
 * @module dsc/packages/hooks/tests/w11-branches
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import type { LifecyclePayload } from '../lifecycle-hooks.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-hooks-w11-'))
process.env['DSC_HOME'] = HOME

const HOOKS_FILE = join(HOME, 'hooks.json')
const LIFECYCLE_FILE = join(HOME, 'lifecycle-hooks.json')
const PLUGINS_FILE = join(HOME, 'plugins.json')

let hooksPlugin: typeof import('../index.js')['hooksPlugin']
let lifecycle: typeof import('../lifecycle-hooks.js')

beforeAll(async () => {
  lifecycle = await import('../lifecycle-hooks.js')
  hooksPlugin = (await import('../index.js')).hooksPlugin
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 句柄：留给系统清
  }
})

let bump = 0
function fresh(file: string, text: string): void {
  writeFileSync(file, text, 'utf8')
  bump += 1
  const stamp = new Date(Date.now() + bump * 1000)
  try {
    utimesSync(file, stamp, stamp)
  } catch {
    // 改不了时间就算了
  }
}

function writeHooks(doc: { rules?: unknown[]; scripts?: unknown[]; settings?: Record<string, unknown> }): void {
  fresh(HOOKS_FILE, JSON.stringify({ version: 1, settings: doc.settings ?? {}, rules: doc.rules ?? [], scripts: doc.scripts ?? [] }))
}

function writeLifecycle(doc: unknown): void {
  fresh(LIFECYCLE_FILE, JSON.stringify(doc))
}

function writePlugins(entries: unknown[]): void {
  fresh(PLUGINS_FILE, JSON.stringify({ version: 1, entries }))
}

beforeEach(() => {
  bump = 0
  writeHooks({})
  writeLifecycle({ hooks: {} })
  writePlugins([])
})

function script(name: string, body: string): string {
  const file = join(HOME, name)
  writeFileSync(file, body, 'utf8')
  return file
}

const payload: LifecyclePayload = {
  session_id: 'sess-w11',
  transcript_path: null,
  cwd: HOME,
  hook_event_name: 'PreToolUse',
  model: 'fake/model',
  permission_mode: 'default',
}

// ── 配置容错 ─────────────────────────────────────────────────────────────────

test('readLifecycleDoc：读不动/坏 JSON/非对象/未知事件/组与条目形状不对都进 problems', () => {
  expect(lifecycle.readLifecycleDoc(HOME).problems[0]).toContain('读不了')
  fresh(LIFECYCLE_FILE, '')
  expect(lifecycle.readLifecycleDoc(LIFECYCLE_FILE)).toEqual({ hooks: [], problems: [] })

  fresh(LIFECYCLE_FILE, '{')
  expect(lifecycle.readLifecycleDoc(LIFECYCLE_FILE).problems[0]).toContain('不是合法 JSON')

  fresh(LIFECYCLE_FILE, '[]')
  expect(lifecycle.readLifecycleDoc(LIFECYCLE_FILE).problems[0]).toContain('最外层必须是对象')

  fresh(LIFECYCLE_FILE, JSON.stringify({ Nope: [] }))
  expect(lifecycle.readLifecycleDoc(LIFECYCLE_FILE).problems.join('\n')).toContain('不认识的事件名')

  fresh(LIFECYCLE_FILE, JSON.stringify({ PreToolUse: 'x' }))
  expect(lifecycle.readLifecycleDoc(LIFECYCLE_FILE).problems.join('\n')).toContain('应该是钩子组数组')

  fresh(LIFECYCLE_FILE, JSON.stringify({ PreToolUse: [null] }))
  expect(lifecycle.readLifecycleDoc(LIFECYCLE_FILE).problems.join('\n')).toContain('不是对象')

  fresh(LIFECYCLE_FILE, JSON.stringify({ SessionStart: [{ matcher: 'startup' }] }))
  expect(lifecycle.readLifecycleDoc(LIFECYCLE_FILE).problems.join('\n')).toContain('没有 hooks 数组')

  fresh(LIFECYCLE_FILE, JSON.stringify({ PreToolUse: [{ hooks: [null] }] }))
  expect(lifecycle.readLifecycleDoc(LIFECYCLE_FILE).problems.join('\n')).toContain('不是对象')

  fresh(LIFECYCLE_FILE, JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'prompt', command: 'x' }] }] }))
  expect(lifecycle.readLifecycleDoc(LIFECYCLE_FILE).problems.join('\n')).toContain('只跑 command')

  fresh(LIFECYCLE_FILE, JSON.stringify({ PreToolUse: [{ hooks: [{ command: 'x', async: true }] }] }))
  expect(lifecycle.readLifecycleDoc(LIFECYCLE_FILE).problems.join('\n')).toContain('等不了异步')

  fresh(LIFECYCLE_FILE, JSON.stringify({ PreToolUse: [{ hooks: [{ command: '   ' }] }] }))
  expect(lifecycle.readLifecycleDoc(LIFECYCLE_FILE).problems.join('\n')).toContain('没有 command')

  // 不支持 matcher 的事件上写了 matcher：只提示忽略，钩子照样读进来。
  fresh(
    LIFECYCLE_FILE,
    JSON.stringify({ Stop: [{ matcher: 'x', hooks: [{ command: 'node a.js', timeout: 1 }] }] }),
  )
  const doc = lifecycle.readLifecycleDoc(LIFECYCLE_FILE)
  expect(doc.hooks).toHaveLength(1)
  expect(doc.problems.join('\n')).toContain('会被忽略')
})

test('readLifecycleDoc：超过上限截断并说明；直接事件表形态也认', () => {
  const groups = Array.from({ length: lifecycle.LIFECYCLE_MAX_HOOKS + 1 }, () => ({
    hooks: [{ command: 'node a.js' }],
  }))
  fresh(LIFECYCLE_FILE, JSON.stringify({ PreToolUse: groups }))
  const doc = lifecycle.readLifecycleDoc(LIFECYCLE_FILE)
  expect(doc.hooks).toHaveLength(lifecycle.LIFECYCLE_MAX_HOOKS)
  expect(doc.problems.join('\n')).toContain('超过')

  fresh(LIFECYCLE_FILE, JSON.stringify({ PostToolUse: [{ hooks: [{ command: 'node b.js' }] }] }))
  expect(lifecycle.readLifecycleDoc(LIFECYCLE_FILE).hooks[0]).toMatchObject({ event: 'PostToolUse' })
})

test('runLifecycleCommand：正常输出、超时、取消、输出截断', async () => {
  const ok = script('ok.js', 'process.stdout.write("{\\"action\\":\\"pass\\"}")')
  const ran = await lifecycle.runLifecycleCommand(`node ${ok}`, 3_000, payload, HOME, new AbortController().signal)
  expect(ran.exitCode).toBe(0)
  expect(ran.stdout).toContain('pass')

  const slow = script('slow.js', 'setTimeout(() => {}, 10000)')
  const timedOut = await lifecycle.runLifecycleCommand(`node ${slow}`, 1, payload, HOME, new AbortController().signal)
  expect(timedOut.timedOut).toBe(true)

  const controller = new AbortController()
  const pending = lifecycle.runLifecycleCommand(`node ${slow}`, 10_000, payload, HOME, controller.signal)
  controller.abort()
  expect((await pending).exitCode).toBe(-1)

  const big = script('big.js', 'process.stdout.write("x".repeat(500000))')
  const out = await lifecycle.runLifecycleCommand(`node ${big}`, 5_000, payload, HOME, new AbortController().signal)
  expect(out.truncated).toBe(true)
})

// ── 插件装配 ─────────────────────────────────────────────────────────────────

interface FakeSection {
  fields: () => Array<Record<string, unknown>>
  values: () => Record<string, unknown>
  save: (key: string, value: unknown) => string | void
  action: (name: string) => string | void
}

interface Harness {
  guards: Array<{ id: string; decide: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }>
  observers: Array<{ id: string; observe: (tool: string, text: string) => string }>
  projections: Array<(messages: unknown[]) => unknown>
  notices: string[]
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>
  section: FakeSection
  cleanup?: () => void
}

const harnesses: Harness[] = []

function fakeCtx(config: Record<string, unknown>): Harness {
  const guards: Harness['guards'] = []
  const observers: Harness['observers'] = []
  const projections: Harness['projections'] = []
  const notices: string[] = []
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const sections: FakeSection[] = []
  const session = {
    meta: { id: 'sess-w11', cwd: HOME },
    filePath: join(HOME, 'sessions', 'a.jsonl'),
    messages: [] as Array<{ role: string; content: string }>,
    appendNote: () => undefined,
  }
  const ctx = {
    effect(execute: () => unknown) {
      execute()
      return () => undefined
    },
    guards: {
      register(guard: Harness['guards'][number]) {
        guards.push(guard)
        return () => undefined
      },
      registerObserver(observer: Harness['observers'][number]) {
        observers.push(observer)
        return () => undefined
      },
    },
    approval: { policy: 'auto-edit', decide: async () => 'allow-once' },
    session: { current: () => session },
    llm: { model: 'fake/model' },
    commands: { register: () => () => undefined },
    prompt: {
      registerProjection(_id: string, fn: (messages: unknown[]) => unknown) {
        projections.push(fn)
        return () => undefined
      },
    },
    settings: {
      registerSection(section: FakeSection) {
        sections.push(section)
        return () => undefined
      },
    },
    provide: () => undefined,
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => undefined
    },
    emit(event: string, text?: string) {
      if (event === 'dsc/notice' && text !== undefined) notices.push(text)
    },
  }
  const returned = hooksPlugin.apply?.(ctx as never, {
    enabled: true,
    configPath: LIFECYCLE_FILE,
    timeoutMs: 5_000,
    failClosed: false,
    commandAllowlist: '',
    ...config,
  })
  const harness: Harness = { guards, observers, projections, notices, handlers, section: sections[0] as FakeSection }
  if (typeof returned === 'function') harness.cleanup = returned as () => void
  harnesses.push(harness)
  return harness
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    try {
      harness.cleanup?.()
    } catch {
      // 已经收过了
    }
  }
})

const input = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  toolName: 'bash',
  risk: 'exec',
  cwd: HOME,
  args: { command: 'echo hi' },
  command: 'echo hi',
  target: '',
  signal: new AbortController().signal,
  sessionId: 'sess-w11',
  sessionPath: join(HOME, 'sessions', 'a.jsonl'),
  ...patch,
})

test('设置保存：脚本/规则开关、节流与外部钩子各键都有正确回执', () => {
  writeHooks({
    rules: [{ id: 'r1', enabled: true, tool: 'bash', field: 'command', action: 'ask', pattern: 'rm', reason: '' }],
    scripts: [{ id: 's1', enabled: true, event: 'pre-tool', matcher: '*', command: 'node a.js' }],
  })
  const harness = fakeCtx({})
  const section = harness.section
  section.save('scriptFailClosed', true)
  section.save('autoAccept', true)
  expect(String(section.save('scriptTimeoutMs', 'abc'))).toContain('数字')
  section.save('scriptTimeoutMs', '1234')
  section.save('externalEnabled', true)
  section.save('externalFailClosed', true)
  expect(String(section.save('externalTimeoutMs', 'abc'))).toContain('数字')
  section.save('externalTimeoutMs', '1')
  expect(String(section.save('externalConfigPath', '   '))).toContain('不能空')
  section.save('externalConfigPath', LIFECYCLE_FILE)
  section.save('externalCommandAllowlist', 'node, git')

  section.save('ruleId', 'r1')
  section.save('ruleEnabled', false)
  section.save('scriptId', 's1')
  section.save('scriptEnabled', false)
  section.save('ruleAction', 'deny')
  section.save('scriptEvent', 'bogus')
  section.save('scriptMatcher', '*')
  section.save('scriptCommand', 'node c.js')
  expect(String(section.save('unknownKey', 1))).toContain('unknownKey')

  const values = section.values()
  expect(values).toMatchObject({ scriptFailClosed: true, autoAccept: true, externalCommandAllowlist: 'node, git' })
  expect(section.fields().length).toBeGreaterThan(10)
})

test('观察者：总开关关着时早退；未批准脚本只提醒一次', () => {
  writeHooks({ settings: { enabled: false } })
  const off = fakeCtx({})
  const quiet = off.observers.find((observer) => observer.id === 'hooks')
  expect(quiet?.observe('bash', 'out')).toBe('out')
  expect(off.notices).toEqual([])

  writeHooks({
    settings: { enabled: true },
    scripts: [{ id: 's1', enabled: true, event: 'post-tool', matcher: '*', command: 'node a.js' }],
  })
  const on = fakeCtx({})
  const observer = on.observers.find((entry) => entry.id === 'hooks')
  observer?.observe('bash', 'out')
  observer?.observe('bash', 'out')
  expect(on.notices.filter((text) => text.includes('没生效'))).toHaveLength(1)
})

test('外部钩子：关闭时守卫直接 defer；PreToolUse note 进下一次请求', async () => {
  writePlugins([{ file: 'hooks', config: { enabled: false, configPath: LIFECYCLE_FILE } }])
  const disabled = fakeCtx({ enabled: false })
  const offGuard = disabled.guards.find((guard) => guard.id === 'lifecycle-hooks')
  expect(await offGuard!.decide(input())).toEqual({ action: 'defer' })

  const note = script('note.js', 'process.stdout.write("{\\"action\\":\\"note\\",\\"message\\":\\"记得看文档\\"}")')
  writeLifecycle({
    hooks: {
      PreToolUse: [{ hooks: [{ command: `node ${note}`, timeout: 5 }] }],
    },
  })
  writePlugins([{ file: 'hooks', config: { enabled: true, configPath: LIFECYCLE_FILE, timeoutMs: 5_000 } }])
  const enabled = fakeCtx({ enabled: true })
  const guard = enabled.guards.find((entry) => entry.id === 'lifecycle-hooks')
  expect(await guard!.decide(input())).toEqual({ action: 'defer' })
  expect(enabled.notices.some((text) => text.includes('没跑好'))).toBe(false)

  const projected = enabled.projections[0]?.([
    { role: 'user', content: '继续' },
  ]) as Array<{ role: string; content: string }>
  expect(JSON.stringify(projected)).toContain('记得看文档')
})

test('事件挂点：compacted/exit 不抛；turn-end 的 completed/aborted 都走到外部事件', () => {
  writeLifecycle({ hooks: {} })
  const harness = fakeCtx({})
  for (const handler of harness.handlers.get('dsc/compacted') ?? []) handler()
  for (const handler of harness.handlers.get('dsc/exit') ?? []) handler()
  for (const handler of harness.handlers.get('dsc/turn-end') ?? []) {
    handler('completed', { sessionId: 'sess-w11' })
    handler('aborted', { sessionId: 'sess-w11' })
  }
  expect(harness.notices).toEqual([])
})
