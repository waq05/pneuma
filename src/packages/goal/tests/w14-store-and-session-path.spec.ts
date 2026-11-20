/**
 * goal 收尾缺口：`goal.ts` 的 86/176/196/207-208 与 `index.ts` 的 116-117/169/295-296。
 *
 * 两条腿：
 *   1. `GoalStore` 本体直测——上膛开关、跑满上限后 resume 被拒、改上限校验、
 *      「改上限改到低于已跑轮次」时自动转 blocked 并卸膛；
 *   2. 插件面真跑 `apply`——服务上的 `goals` getter、`/goal` 建目标失败时弹的 notice、
 *      以及工具按 `sessionPath` 读一份会话文件后缓存并写回（`Session.load` 用最小替身，
 *      因为真 `Session.load` 要一份完整 jsonl 与写租约，与本文件要验的缓存路径无关）。
 *
 * `DSC_HOME` 在动态 import 之前指到临时目录；假 ctx 只实现 apply 碰到的面。
 *
 * @module @pneuma/goal/tests/w14-store-and-session-path.spec
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-goal-w14-'))
const savedHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = HOME

/** `Session.load` 的最小替身：登记过的路径返回对应假会话，没登记的按文件不存在抛错。 */
const loaded = vi.hoisted(() => ({ calls: 0, byPath: new Map<string, unknown>() }))

vi.mock('@pneuma/runtime/core/session.js', () => ({
  Session: {
    load: (filePath: string): unknown => {
      loaded.calls += 1
      const session = loaded.byPath.get(filePath)
      if (session === undefined) throw new Error(`ENOENT: ${filePath}`)
      return session
    },
  },
}))

type GoalIndex = typeof import('../index.js')
type GoalModule = typeof import('../goal.js')
let goalPlugin: GoalIndex['goalPlugin']
let GoalStore: GoalModule['GoalStore']

/** 目标插件只碰会话的 meta / state / appendState，假会话给这几样就够。 */
interface FakeSession {
  meta: { id: string; cwd: string }
  filePath: string
  states: Map<string, unknown>
  appended: Array<{ id: string; payload: unknown }>
  state(id: string): unknown
  appendState(id: string, payload: unknown): void
}

function newSession(id: string): FakeSession {
  const states = new Map<string, unknown>()
  const appended: Array<{ id: string; payload: unknown }> = []
  const session: FakeSession = {
    meta: { id, cwd: 'C:/repo' },
    filePath: `C:/repo/.dsc/sessions/${id}.jsonl`,
    states,
    appended,
    state: (key) => states.get(key),
    appendState(key, payload) {
      states.set(key, payload)
      appended.push({ id: key, payload })
    },
  }
  return session
}

interface GoalTool {
  name: string
  run: (args: Record<string, unknown>, runCtx: Record<string, unknown>) => Promise<string>
}

interface GoalServiceLike {
  goalView(): Record<string, unknown> | null
  readonly goals: {
    create(objective: string, maxRounds?: number): { ok: boolean }
    snapshot: Record<string, unknown> | null
    armed: boolean
  }
}

interface Harness {
  tools: GoalTool[]
  commands: Array<{ spec: { name: string }; run: (payload: Record<string, unknown>) => void }>
  services: Map<string, unknown>
  notices: string[]
  events: string[]
  handlers: Map<string, (...args: never[]) => void>
  session: FakeSession
  agents: {
    sessionFor(filePath: string): FakeSession | undefined
    sessionById(sessionId: string): FakeSession | undefined
  }
}

/** 假 ctx：挂载点收进数组，`effect` 真跑回调，`get('agent')` 读一张可改的名册。 */
function fakeCtx(): Harness {
  const tools: GoalTool[] = []
  const commands: Harness['commands'] = []
  const services = new Map<string, unknown>()
  const notices: string[] = []
  const events: string[] = []
  const handlers = new Map<string, (...args: never[]) => void>()
  const session = newSession('sess-1')
  const agents: Harness['agents'] = { sessionFor: () => undefined, sessionById: () => undefined }

  const ctx = {
    session: { current: () => session },
    get: (name: string) => (name === 'agent' ? agents : undefined),
    waiting: { anyFor: () => false },
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => undefined
    },
    tools: {
      register(entry: GoalTool) {
        tools.push(entry)
        return () => undefined
      },
    },
    commands: {
      register(spec: Harness['commands'][number]['spec'], run: Harness['commands'][number]['run']) {
        commands.push({ spec, run })
        return () => undefined
      },
    },
    surfaces: { register: () => () => undefined },
    compact: { registerCarry: () => () => undefined },
    settings: { registerSection: () => () => undefined },
    transcript: { system: () => undefined },
    agent: { followup: () => undefined },
    provide(name: string, service: unknown) {
      services.set(name, service)
    },
    emit(name: string) {
      events.push(name)
      if (name === 'dsc/notice') notices.push('notice')
    },
    on(event: string, handler: (...args: never[]) => void) {
      handlers.set(event, handler)
      return () => undefined
    },
  }
  goalPlugin.apply(ctx as never, undefined)

  return { tools, commands, services, notices, events, handlers, session, agents }
}

const toolCtx = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: 'sess-1',
  sessionPath: '',
  ...overrides,
})

beforeAll(async () => {
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
  goalPlugin = (await import('../index.js')).goalPlugin
  GoalStore = (await import('../goal.js')).GoalStore
})

afterAll(() => {
  if (savedHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = savedHome
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 偶发 EPERM：临时目录留给系统清。
  }
})

test('GoalStore：setArmed 真的改上膛状态，且没目标时不该续跑', () => {
  const store = new GoalStore()
  expect(store.armed).toBe(false)
  store.setArmed(true)
  expect(store.armed).toBe(true)
  expect(store.shouldContinue).toBe(false)
  store.setArmed(false)
  expect(store.armed).toBe(false)
})

test('GoalStore：跑满上限后 resume 被拒，提示先放宽上限', () => {
  const store = new GoalStore()
  expect(store.create('一轮就满', 1).ok).toBe(true)
  expect(store.countRound()?.phase).toBe('blocked')

  const resumed = store.resumeByUser()
  expect(resumed).toMatchObject({ ok: false })
  expect(resumed.ok ? '' : resumed.error).toContain('跑满 1 轮上限')
  expect(resumed.ok ? '' : resumed.error).toContain('/goal rounds')
})

test('GoalStore：改上限的非法值被拒，降到现在轮次以下时自动转 blocked 并卸膛', () => {
  const store = new GoalStore()
  expect(store.create('两个轮次', 2).ok).toBe(true)

  const tooSmall = store.editByUser({ maxRounds: 0 })
  const tooBig = store.editByUser({ maxRounds: 257 })
  expect(tooSmall).toMatchObject({ ok: false, error: expect.stringContaining('要在 1 到 256 之间') })
  expect(tooBig).toMatchObject({ ok: false, error: expect.stringContaining('轮次上限') })
  expect(store.snapshot?.phase).toBe('active')

  expect(store.countRound()?.rounds).toBe(1)
  expect(store.armed).toBe(true)
  // 已跑 1 轮，把上限改成 1：当场转 blocked（第 207-208 行），不能等下一轮。
  const edited = store.editByUser({ maxRounds: 1 })
  expect(edited.ok).toBe(true)
  expect(store.snapshot).toMatchObject({ phase: 'blocked', blockedReason: '轮次已达上限', maxRounds: 1 })
  expect(store.armed).toBe(false)
})

test('服务上的 goals getter 返回当前会话的目标存储', () => {
  const harness = fakeCtx()
  const service = harness.services.get('goal') as GoalServiceLike
  expect(service.goals.snapshot).toBeNull()
  expect(service.goals.create('从 getter 建的目标', 6).ok).toBe(true)
  expect(service.goals.snapshot).toMatchObject({ objective: '从 getter 建的目标', maxRounds: 6 })
})

test('工具按 sessionPath 读会话并缓存：第二次走缓存不再读盘，状态写回读进来那份', async () => {
  loaded.calls = 0
  loaded.byPath.clear()
  const harness = fakeCtx()
  const teammate = newSession('sess-teammate')
  loaded.byPath.set(teammate.filePath, teammate)
  const tool = harness.tools[0]!

  const created = await tool.run({ action: 'create', objective: '队友会话的目标' }, toolCtx({ sessionPath: teammate.filePath }))
  expect(created).toContain('目标已建立')
  expect(loaded.calls).toBe(1)
  expect(teammate.appended.at(-1)).toMatchObject({ id: 'goal', payload: { objective: '队友会话的目标' } })
  expect(harness.session.appended).toHaveLength(0)

  const completed = await tool.run({ action: 'complete' }, toolCtx({ sessionPath: teammate.filePath }))
  expect(completed).toContain('已标记完成')
  // 第二次命中 loadedByPath 缓存（第 105-106 行），不再调 Session.load。
  expect(loaded.calls).toBe(1)
  expect(teammate.appended.at(-1)).toMatchObject({ id: 'goal', payload: { phase: 'complete' } })
})

test('/goal <文本>：已有未完成目标时把失败原因弹给用户，不再覆盖', () => {
  const harness = fakeCtx()
  const command = harness.commands[0]!
  const notices: string[] = []
  const ui = { notice: (text: string) => notices.push(text) }

  command.run({ args: ['第一个目标'], ui } as never)
  expect(notices.at(-1)).toContain('目标已建立')

  command.run({ args: ['第二个目标'], ui } as never)
  expect(notices.at(-1)).toContain('已经有目标在跑')
  expect(notices.at(-1)).toContain('/goal clear')
})
