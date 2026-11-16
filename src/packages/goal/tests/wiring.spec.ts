/**
 * goal 插件装配面（`packages/goal/index.ts`）：工具 / 命令 / 界面投影 / 压缩携带 /
 * 自动续跑 / 设置分区 / 按会话分表。
 *
 * 用假 ctx 跑真 `apply`：目标存储（`goal.ts`）是真的，插件配置走临时 `DSC_HOME`
 * 里真的 `plugins.json`。`DSC_HOME` 在任何 import 之前指向临时目录——路径常量在
 * 模块求值时算定。
 *
 * @module dsc/packages/goal/tests/wiring.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-goal-wiring-'))
process.env['DSC_HOME'] = HOME

type GoalIndex = typeof import('../index.js')
let goalPlugin: GoalIndex['goalPlugin']

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 上偶发 EPERM：临时目录交给系统清。
  }
})

beforeAll(async () => {
  goalPlugin = (await import('../index.js')).goalPlugin
})

beforeEach(() => {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

/** 目标插件只碰会话的 meta / state / appendState，假会话给这三样就够。 */
interface FakeSession {
  meta: { id: string; cwd: string; createdAt: number }
  filePath: string
  states: Map<string, unknown>
  appended: Array<{ id: string; payload: unknown }>
  state(id: string): unknown
  appendState(id: string, payload: unknown): void
}

function newSession(id: string): FakeSession {
  const states = new Map<string, unknown>()
  const appended: Array<{ id: string; payload: unknown }> = []
  return {
    meta: { id, cwd: 'C:/repo', createdAt: Date.now() },
    filePath: `C:/repo/.dsc/sessions/${id}.jsonl`,
    states,
    appended,
    state: (key) => states.get(key),
    appendState(key, payload) {
      states.set(key, payload)
      appended.push({ id: key, payload })
    },
  }
}

interface GoalTool {
  name: string
  risk: string
  parameters: {
    properties: Record<string, unknown>
    required?: string[]
  }
  run: (args: Record<string, unknown>, runCtx: Record<string, unknown>) => Promise<string>
}

interface GoalServiceLike {
  goalView(): Record<string, unknown> | null
  goalAction(action: string): { ok: boolean; error?: string }
  takeGoalRound(): string | null
  readonly goals: {
    create(objective: string, maxRounds?: number): { ok: boolean }
  }
}

interface Harness {
  tools: GoalTool[]
  commands: Array<{ spec: { name: string; args: string }; run: (payload: Record<string, unknown>) => void }>
  surfaces: Map<string, () => unknown>
  carries: Array<(session?: FakeSession) => string>
  sections: Array<Record<string, unknown>>
  notices: string[]
  events: Array<{ name: string; payload: unknown[] }>
  followups: Array<{ text: string; origin?: string }>
  systems: string[]
  waiting: Set<string>
  services: Map<string, unknown>
  handlers: Map<string, (...args: never[]) => void>
  agents: {
    sessionFor(filePath: string): FakeSession | undefined
    sessionById(sessionId: string): FakeSession | undefined
  }
  session: FakeSession
  setSession(session: FakeSession): void
  cleanup: () => void
}

/** 假 ctx：挂载点收进数组，`effect` 真跑，`get('agent')` 读一张可改的名册。 */
function fakeCtx(): Harness {
  const tools: GoalTool[] = []
  const commands: Harness['commands'] = []
  const surfaces = new Map<string, () => unknown>()
  const carries: Harness['carries'] = []
  const sections: Array<Record<string, unknown>> = []
  const notices: string[] = []
  const events: Harness['events'] = []
  const followups: Harness['followups'] = []
  const systems: string[] = []
  const services = new Map<string, unknown>()
  const handlers = new Map<string, (...args: never[]) => void>()
  const waiting = new Set<string>()
  const primary = newSession('sess-1')
  const agents: Harness['agents'] = {
    sessionFor: () => undefined,
    sessionById: () => undefined,
  }

  const harness = {
    session: primary,
    setSession(session: FakeSession): void {
      harness.session = session
    },
  } as unknown as Harness

  const ctx = {
    session: { current: () => harness.session },
    get(name: string) {
      return name === 'agent' ? agents : undefined
    },
    waiting: { anyFor: (id: string) => waiting.has(id) },
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    tools: {
      register(tool: GoalTool) {
        tools.push(tool)
        return () => undefined
      },
    },
    commands: {
      register(spec: Harness['commands'][number]['spec'], run: Harness['commands'][number]['run']) {
        commands.push({ spec, run })
        return () => undefined
      },
    },
    surfaces: {
      register(id: string, read: () => unknown) {
        surfaces.set(id, read)
        return () => undefined
      },
    },
    compact: {
      registerCarry(fn: (session?: FakeSession) => string) {
        carries.push(fn)
        return () => undefined
      },
    },
    settings: {
      registerSection(section: Record<string, unknown>) {
        sections.push(section)
        return () => undefined
      },
    },
    transcript: { system: (text: string) => systems.push(text) },
    agent: {
      followup: (text: string, _images?: unknown, _files?: unknown, origin?: string) =>
        followups.push({ text, ...(origin === undefined ? {} : { origin }) }),
    },
    provide(name: string, service: unknown) {
      services.set(name, service)
    },
    emit(name: string, ...payload: unknown[]) {
      events.push({ name, payload })
      const text = payload[0]
      if (name === 'dsc/notice' && typeof text === 'string') notices.push(text)
    },
    on(event: string, handler: (...args: never[]) => void) {
      handlers.set(event, handler)
      return () => undefined
    },
  }

  const cleanup = goalPlugin.apply?.(ctx as never, undefined)
  harness.tools = tools
  harness.commands = commands
  harness.surfaces = surfaces
  harness.carries = carries
  harness.sections = sections
  harness.notices = notices
  harness.events = events
  harness.followups = followups
  harness.systems = systems
  harness.waiting = waiting
  harness.services = services
  harness.handlers = handlers
  harness.agents = agents
  harness.cleanup = typeof cleanup === 'function' ? (cleanup as () => void) : () => undefined
  return harness
}

const toolCtx = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: 'sess-1',
  sessionPath: 'C:/repo/.dsc/sessions/sess-1.jsonl',
  ...overrides,
})

describe('挂载面', () => {
  test('工具、命令、投影、压缩携带、设置分区与服务都挂上了', () => {
    const harness = fakeCtx()
    expect(harness.tools[0]).toMatchObject({ name: 'goal', risk: 'read' })
    expect(harness.tools[0]!.parameters.required).toEqual(['action'])
    expect(Object.keys(harness.tools[0]!.parameters.properties).sort()).toEqual(['action', 'maxRounds', 'objective', 'reason'])
    expect(harness.commands[0]!.spec).toMatchObject({ name: 'goal' })
    expect(harness.commands[0]!.spec.args).toContain('pause')
    expect(harness.surfaces.has('goal')).toBe(true)
    expect(harness.carries).toHaveLength(1)
    expect(harness.sections[0]).toMatchObject({ id: 'goal', order: 36 })
    expect(harness.services.get('goal')).toBeDefined()
    expect(harness.handlers.has('dsc/turn-end')).toBe(true)
    expect(harness.handlers.has('dsc/session-open')).toBe(true)
  })
})

describe('工具：create / complete / blocked 与按会话归属', () => {
  test('create 建目标、空目标报错、complete 停住、blocked 空原因报错', async () => {
    const harness = fakeCtx()
    const tool = harness.tools[0]!
    const service = harness.services.get('goal') as GoalServiceLike

    await expect(tool.run({ action: 'create', objective: '  ' }, toolCtx())).rejects.toThrow('目标不能是空话')
    const created = await tool.run({ action: 'create', objective: '把测试补到 18 条', maxRounds: 3 }, toolCtx())
    expect(created).toContain('目标已建立')
    expect(created).toContain('上限 3 轮')
    expect(service.goalView()).toMatchObject({ objective: '把测试补到 18 条', phase: 'active', rounds: 0, maxRounds: 3, armed: true })

    // 同会话已有未完成目标：再建一个必须被拒。
    await expect(tool.run({ action: 'create', objective: '另一个目标' }, toolCtx())).rejects.toThrow('已经有目标在跑')

    await expect(tool.run({ action: 'blocked', reason: '   ' }, toolCtx())).rejects.toThrow('blocked 必须写清')
    const blocked = await tool.run({ action: 'blocked', reason: '缺一个 API key' }, toolCtx())
    expect(blocked).toContain('已标记阻塞')
    expect(service.goalView()).toMatchObject({ phase: 'blocked', blockedReason: '缺一个 API key', armed: false })

    const completed = await tool.run({ action: 'complete' }, toolCtx())
    expect(completed).toContain('已标记完成')
    expect(service.goalView()).toMatchObject({ phase: 'complete', armed: false })

    await expect(tool.run({ action: 'pause' }, toolCtx())).rejects.toThrow('action 只能是 create / complete / blocked')
  })

  test('工具按发起调用的会话写状态：sessionPath / sessionId 优先于当前查看的会话', async () => {
    const harness = fakeCtx()
    const tool = harness.tools[0]!
    const other = newSession('sess-2')
    harness.agents.sessionFor = (filePath) => (filePath === other.filePath ? other : undefined)
    harness.agents.sessionById = (id) => (id === 'sess-2' ? other : undefined)

    await tool.run({ action: 'create', objective: '后台会话的目标' }, toolCtx({ sessionPath: other.filePath }))
    expect(other.appended.at(-1)).toMatchObject({ id: 'goal', payload: { objective: '后台会话的目标' } })
    expect(harness.session.appended).toHaveLength(0)

    await tool.run({ action: 'complete' }, toolCtx({ sessionPath: 'C:/nope.jsonl', sessionId: 'sess-2' }))
    expect(other.appended.at(-1)).toMatchObject({ id: 'goal', payload: { phase: 'complete' } })

    // 路径与 id 都解析不到时回落当前查看的会话。
    await tool.run({ action: 'create', objective: '当前会话的目标' }, toolCtx({ sessionPath: 'C:/nope.jsonl', sessionId: 'ghost' }))
    expect(harness.session.appended.at(-1)).toMatchObject({ id: 'goal', payload: { objective: '当前会话的目标' } })
  })
})

describe('服务：用户动作与自动续跑', () => {
  test('goalAction：pause / resume / clear / extend，以及没有目标时的失败原因', async () => {
    const harness = fakeCtx()
    const tool = harness.tools[0]!
    const service = harness.services.get('goal') as GoalServiceLike

    expect(service.goalAction('pause')).toEqual({ ok: false, error: '当前没有目标。' })
    expect(service.goalAction('resume')).toEqual({ ok: false, error: '当前没有目标：先用 /goal <目标> 建一个。' })

    await tool.run({ action: 'create', objective: '跑到底', maxRounds: 2 }, toolCtx())
    expect(service.goalAction('pause')).toEqual({ ok: true })
    expect(service.goalView()).toMatchObject({ phase: 'paused', armed: false })
    expect(service.goalAction('resume')).toEqual({ ok: true })
    expect(service.goalView()).toMatchObject({ phase: 'active', armed: true })
    expect(service.goalAction('extend')).toEqual({ ok: true })
    // extendRoundsBy 缺省 8：2 → 10。
    expect(service.goalView()).toMatchObject({ maxRounds: 10, phase: 'active' })
    expect(service.goalAction('clear')).toEqual({ ok: true })
    expect(service.goalView()).toBeNull()
    expect(harness.notices.some((text) => text.includes('轮次上限已放宽'))).toBe(true)
    expect(harness.events.some((event) => event.name === 'dsc/changed')).toBe(true)
  })

  test('takeGoalRound：等人时不推、跑满上限停住、正常时轮次 +1 并给续跑文案', async () => {
    const harness = fakeCtx()
    const tool = harness.tools[0]!
    const service = harness.services.get('goal') as GoalServiceLike

    expect(service.takeGoalRound()).toBeNull()

    await tool.run({ action: 'create', objective: '补覆盖率', maxRounds: 2 }, toolCtx())
    harness.waiting.add('sess-1')
    expect(service.takeGoalRound()).toBeNull()
    expect(service.goalView()).toMatchObject({ rounds: 0 })

    harness.waiting.clear()
    const first = service.takeGoalRound()
    expect(first).toContain('第 1/2 轮')
    expect(first).toContain('补覆盖率')
    expect(service.goalView()).toMatchObject({ rounds: 1, phase: 'active', armed: true })

    // 第 2 轮正好到上限：返回 null、转 blocked、卸膛。
    expect(service.takeGoalRound()).toBeNull()
    expect(service.goalView()).toMatchObject({ rounds: 2, phase: 'blocked', armed: false })
    expect(harness.notices.some((text) => text.includes('跑满 2 轮上限'))).toBe(true)
  })

  test('dsc/turn-end：只认当前会话的干净结束；session-open 恢复目标但一律卸膛', async () => {
    const harness = fakeCtx()
    const tool = harness.tools[0]!
    const service = harness.services.get('goal') as GoalServiceLike
    const turnEnd = harness.handlers.get('dsc/turn-end')!
    await tool.run({ action: 'create', objective: '自动续跑', maxRounds: 3 }, toolCtx())

    turnEnd('aborted' as never, { sessionId: 'sess-1' } as never)
    turnEnd('completed' as never, { sessionId: 'sess-2' } as never)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.followups).toHaveLength(0)

    turnEnd('completed' as never, { sessionId: 'sess-1' } as never)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(harness.followups).toHaveLength(1)
    expect(harness.followups[0]!.origin).toBe('notice')
    expect(harness.followups[0]!.text).toContain('第 1/3 轮')
    expect(harness.systems.some((text) => text.includes('目标自动续跑'))).toBe(true)

    // 恢复历史会话：目标本体回来，但绝不能自动点火。
    const restored = newSession('sess-1')
    restored.states.set('goal', { id: 'g1', revision: 2, objective: '历史目标', phase: 'active', maxRounds: 5, rounds: 1 })
    harness.setSession(restored)
    harness.handlers.get('dsc/session-open')!({ session: restored } as never)
    expect(service.goalView()).toMatchObject({ objective: '历史目标', armed: false })
    expect(service.takeGoalRound()).toBeNull()
  })
})

describe('设置分区与压缩携带', () => {
  test('values 读配置、save 校验并落盘，新目标立刻用新上限', async () => {
    const harness = fakeCtx()
    const section = harness.sections[0] as unknown as {
      fields(): Array<{ key: string; min: number; max: number }>
      values(): Record<string, unknown>
      save(key: string, value: unknown): string | void
    }
    const tool = harness.tools[0]!
    const service = harness.services.get('goal') as GoalServiceLike

    expect(section.fields().map((field) => field.key)).toEqual(['defaultMaxRounds', 'extendRoundsBy'])
    expect(section.values()).toEqual({ defaultMaxRounds: 24, extendRoundsBy: 8 })

    expect(section.save('defaultMaxRounds', 'abc')).toContain('数字')
    expect(section.save('nope', 1)).toContain('nope')

    expect(section.save('defaultMaxRounds', 5)).toBeUndefined()
    expect(section.save('extendRoundsBy', 3)).toBeUndefined()
    expect(section.values()).toEqual({ defaultMaxRounds: 5, extendRoundsBy: 3 })

    const saved = JSON.parse(readFileSync(join(HOME, 'plugins.json'), 'utf8')) as {
      entries: Array<{ file: string; config: Record<string, unknown> }>
    }
    expect(saved.entries.find((entry) => entry.file === 'goal')?.config).toMatchObject({ defaultMaxRounds: 5, extendRoundsBy: 3 })

    await tool.run({ action: 'create', objective: '用新配置' }, toolCtx())
    expect(service.goalView()).toMatchObject({ maxRounds: 5 })
    expect(service.goalAction('extend')).toEqual({ ok: true })
    expect(service.goalView()).toMatchObject({ maxRounds: 8 })
  })

  test('压缩携带：有目标给一句原文，没目标给空串；按被压缩的那条会话取', async () => {
    const harness = fakeCtx()
    const tool = harness.tools[0]!
    const carry = harness.carries[0]!
    expect(carry()).toBe('')

    await tool.run({ action: 'create', objective: '压缩别把我改写了', maxRounds: 4 }, toolCtx())
    const text = carry(harness.session)
    expect(text).toContain('会话目标：压缩别把我改写了')
    expect(text).toContain('0/4')

    const other = newSession('sess-9')
    expect(carry(other)).toBe('')
  })
})

describe('命令 /goal', () => {
  test('空参数给当前目标、pause/resume/clear/rounds 走服务、未知词建目标', async () => {
    const harness = fakeCtx()
    const command = harness.commands[0]!
    const notices: string[] = []
    const ui = { notice: (text: string) => notices.push(text) }
    const run = (args: string[]): void => command.run({ args, ui } as never)

    run([])
    expect(notices.at(-1)).toContain('当前没有目标')

    run(['把覆盖率补到 18 条'])
    expect(notices.at(-1)).toContain('目标已建立')
    expect(notices.at(-1)).toContain('上限 24 轮')

    run([])
    expect(notices.at(-1)).toContain('当前目标：把覆盖率补到 18 条')

    run(['pause'])
    expect(harness.notices.some((text) => text.includes('已暂停'))).toBe(true)
    run(['rounds'])
    expect(harness.notices.some((text) => text.includes('轮次上限已放宽'))).toBe(true)
    run(['resume'])
    expect(harness.notices.some((text) => text.includes('已继续'))).toBe(true)
    run(['clear'])
    expect(harness.notices.some((text) => text.includes('已清空'))).toBe(true)
    run([])
    expect(notices.at(-1)).toContain('当前没有目标')
  })
})
