/**
 * mode 插件的装配面测试：服务、环境快照、守卫闸门、四条切档命令与会话恢复。
 *
 * 真 `apply` + 假 ctx；会话用最小替身（模式存在 `state('mode')` 里，与真的 `Session` 同形）。
 * `DSC_HOME` 指到临时目录：切档会写审计行，不能落进真实 `~/.dsc`。
 *
 * @module @pneuma/mode/tests/wiring
 */
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

/** 最小会话替身：模式就是一条状态条目。 */
interface FakeSession {
  mode: string
  calls: Array<{ key: string; value: unknown }>
  meta: { id: string; cwd: string }
  filePath: string
  state(key: string): unknown
  appendState(key: string, value: unknown): void
}

function makeSession(id: string, mode = 'build', cwd = '/tmp/work'): FakeSession {
  const session: FakeSession = {
    mode,
    calls: [],
    meta: { id, cwd },
    filePath: `/tmp/${id}.jsonl`,
    state(key) {
      return key === 'mode' ? session.mode : undefined
    },
    appendState(key, value) {
      session.calls.push({ key, value })
      if (key === 'mode') session.mode = String(value)
    },
  }
  return session
}

/** 假 ctx：只实现 mode 插件会碰的面。 */
function fakeContext(initial: FakeSession) {
  const emitted: Array<{ event: string; args: unknown[] }> = []
  const services = new Map<string, unknown>()
  const commands: Array<{ spec: { name: string; args?: string; description?: string }; handler: (input: unknown) => void }> = []
  const guards: Array<{ id: string; order: number; decide(input: Record<string, unknown>): Promise<unknown> | unknown }> = []
  const envFacts: Array<(session?: { meta: { id: string } }) => string> = []
  const handlers = new Map<string, (...args: never[]) => void>()
  const offs: string[] = []
  let current = initial
  const roster = new Map<string, FakeSession>()
  const ctx = {
    session: {
      current: () => current,
    },
    approval: { policy: 'auto' },
    commands: {
      register: (spec: { name: string }, handler: (input: unknown) => void) => {
        commands.push({ spec, handler })
        return () => {}
      },
    },
    guards: {
      register: (guard: (typeof guards)[number]) => {
        guards.push(guard)
        return () => {}
      },
    },
    prompt: {
      registerEnvFacts: (id: string, provider: (session?: { meta: { id: string } }) => string) => {
        void id
        envFacts.push(provider)
        return () => {}
      },
    },
    surfaces: {
      register: () => () => {},
    },
    on: (event: string, handler: (...args: never[]) => void) => {
      handlers.set(event, handler)
    },
    emit: (event: string, ...args: unknown[]) => {
      emitted.push({ event, args })
    },
    effect: (execute: () => unknown, label: string) => {
      const off = execute()
      offs.push(label)
      return typeof off === 'function' ? off : () => {}
    },
    provide: (serviceName: string, service: unknown) => {
      services.set(serviceName, service)
    },
    get: (serviceName: string) =>
      serviceName === 'agent'
        ? {
            sessionById: (id: string) => roster.get(id),
            sessionFor: (path: string) => [...roster.values()].find((session) => session.filePath === path),
          }
        : undefined,
  }
  return { ctx, emitted, services, commands, guards, envFacts, handlers, offs, roster, setCurrent: (next: FakeSession) => (current = next) }
}

type Harness = ReturnType<typeof fakeContext>

let modePlugin: typeof import('../index.js')['modePlugin']
beforeAll(async () => {
  process.env['DSC_HOME'] = createTempDir('dsc-mode-spec-')
  ;({ modePlugin } = await import('../index.js'))
})

afterEach(() => {
  // 每个用例用独立的假 ctx，没有跨用例状态要清。
})

/** 装一次插件。 */
function mount(initial = makeSession('s1')): { harness: Harness; service: Record<string, unknown>; dispose: () => void } {
  const harness = fakeContext(initial)
  const dispose = modePlugin.apply(harness.ctx as unknown as Context, undefined) as unknown
  const service = harness.services.get('mode') as Record<string, unknown>
  return { harness, service, dispose: () => (typeof dispose === 'function' ? (dispose as () => void)() : undefined) }
}

describe('装配：服务、环境快照、守卫与四档清单', () => {
  test('provide mode；mode 默认 build；surface 给出四档', () => {
    const { service } = mount()
    expect(service['mode']).toBe('build')
    expect((service['surface'] as () => { current: string; options: Array<{ id: string; label: string }> })()).toMatchObject({
      current: 'build',
      options: [
        { id: 'build', label: '执行' },
        { id: 'plan', label: '计划' },
        { id: 'explore', label: '探索' },
        { id: 'quiet', label: '免打扰' },
      ],
    })
  })

  test('挂载即广播一次当前档位；环境快照按会话给模式条款', () => {
    const plan = makeSession('s-plan', 'plan')
    const { harness, service } = mount(plan)
    expect(harness.emitted.filter((event) => event.event === 'dsc/mode-changed').map((event) => event.args[0])).toStrictEqual(['plan'])
    // 环境快照：无会话时按当前会话；给了会话按那条会话的模式。
    expect(harness.envFacts[0]?.({ meta: { id: 's-plan' } })).toContain('当前模式：计划')
    expect(harness.envFacts[0]?.()).toContain('当前模式：计划')
    // 不认识的会话 id 回落当前查看的会话。
    expect((service['modeFor'] as (id?: string) => string)('unknown-id')).toBe('plan')
  })
})

describe('切档：写进会话状态并广播', () => {
  test('setMode 写状态、发 notice 与 mode-changed；同档再切也写记录但不重复报「切换」', () => {
    const session = makeSession('s1', 'build')
    const { harness, service } = mount(session)
    const setMode = service['setMode'] as (mode: string) => void

    setMode('explore')
    expect(session.mode).toBe('explore')
    expect(session.calls).toStrictEqual([{ key: 'mode', value: 'explore' }])
    const notices = harness.emitted.filter((event) => event.event === 'dsc/notice')
    expect(String(notices[0]?.args[0])).toContain('协作模式切换为「探索」')
    expect(String(notices[0]?.args[0])).toContain('只读答疑')
    expect(harness.emitted.some((event) => event.event === 'dsc/changed')).toBe(true)

    const before = harness.emitted.length
    setMode('explore')
    // 同档：仍然记一条状态（恢复历史会话时需要它存在），且不重复写审计，但通知照发。
    expect(session.calls).toHaveLength(2)
    expect(harness.emitted.length).toBeGreaterThan(before)
  })

  test('会话恢复时按该会话的模式广播一次', () => {
    const session = makeSession('s1', 'quiet')
    const { harness } = mount(session)
    harness.emitted.length = 0
    harness.handlers.get('dsc/session-open')?.({ session } as never)
    expect(harness.emitted.map((event) => event.event)).toContain('dsc/mode-changed')
    expect(harness.emitted.find((event) => event.event === 'dsc/mode-changed')?.args[0]).toBe('quiet')
  })
})

describe('守卫闸门：按归属会话的模式判，归属不明按最严的探索档', () => {
  test('build 档交给后面的审批（defer）；read 一律 pass；写类在 explore 档被拒', async () => {
    const session = makeSession('s1', 'build')
    const harness = mount(session).harness
    const guards = harness.guards
    // 守卫按归属会话查名册：把这条会话登记进去，才走「按会话模式判」这条路。
    harness.roster.set('s1', session)
    const guard = guards[0]!
    expect(guard.order).toBe(10)
    const base = { toolName: 'write', risk: 'write', cwd: '/tmp/work', args: {}, sessionId: 's1', sessionPath: session.filePath }

    expect(await guard.decide({ ...base, risk: 'read', toolName: 'read' })).toStrictEqual({ action: 'defer' })
    expect(await guard.decide(base)).toStrictEqual({ action: 'defer' })

    // 计划档：读放行，写计划文件放行，写工程文件拒绝。
    session.mode = 'plan'
    expect(await guard.decide({ ...base, risk: 'read', toolName: 'read' })).toStrictEqual({ action: 'pass' })
    expect(await guard.decide({ ...base, target: '/tmp/work/.dsc/plans/plan.md' })).toStrictEqual({ action: 'pass' })
    expect(await guard.decide(base)).toMatchObject({ action: 'deny' })

    // 免打扰档：工作区内写放行、工作区外写拒绝。
    session.mode = 'quiet'
    expect(await guard.decide({ ...base, target: '/tmp/work/a.txt' })).toStrictEqual({ action: 'pass' })
    expect(await guard.decide({ ...base, target: '/etc/passwd' })).toMatchObject({ action: 'deny' })

    session.mode = 'explore'
    const denied = (await guard.decide(base)) as { action: string; reason: string }
    expect(denied.action).toBe('deny')
    expect(denied.reason).toContain('这次调用被模式拦下')
    expect(denied.reason).toContain('探索模式只读不写')
  })

  test('归属会话解析不出来时按探索档判（不回落当前查看的会话）', async () => {
    const current = makeSession('s1', 'build')
    const harness = mount(current).harness
    const guards = harness.guards
    harness.roster.clear()
    // 当前会话是 build，但这次调用自称的会话不在名册里、也没有路径可查。
    expect(await guards[0]!.decide({ toolName: 'write', risk: 'write', cwd: '/tmp/work', args: {}, sessionId: 'gone' })).toMatchObject({
      action: 'deny',
    })
  })

  test('按 sessionId 找到名册里的另一条会话时，用那条的模式判', async () => {
    const current = makeSession('s1', 'build')
    const harness = mount(current).harness
    const guards = harness.guards
    const other = makeSession('s2', 'explore')
    harness.roster.set('s2', other)
    expect(
      await guards[0]!.decide({ toolName: 'write', risk: 'write', cwd: '/tmp/work', args: {}, sessionId: 's2', sessionPath: other.filePath }),
    ).toMatchObject({ action: 'deny' })
  })
})

describe('命令：/mode 与四个快捷档', () => {
  test('/mode 认中文别名；认不出来时列出可选档位', () => {
    const session = makeSession('s1', 'build')
    const harness = mount(session).harness
    const commands = harness.commands
    const modeCommand = commands.find((command) => command.spec.name === 'mode')!
    const notices: string[] = []
    const ui = { notice: (text: string) => notices.push(text) }

    modeCommand.handler({ args: ['不认识'], ui })
    expect(notices[0]).toContain('模式可选')
    expect(notices[0]).toContain('build（执行）')

    modeCommand.handler({ args: ['只读'], ui })
    expect(session.mode).toBe('explore')
    expect(notices).toHaveLength(1)
  })

  test('四个快捷命令：切档；带的话会继续发出去；不带就只切档', () => {
    const session = makeSession('s1', 'build')
    const harness = mount(session).harness
    const commands = harness.commands
    const submitted: string[] = []
    const runtime = { submit: (text: string) => submitted.push(text) }

    const plan = commands.find((command) => command.spec.name === 'plan')!
    expect(plan.spec.description).toContain('计划模式')
    plan.handler({ args: ['给', '审批层', '加四档'], ui: { notice: () => {} }, runtime })
    expect(session.mode).toBe('plan')
    expect(submitted).toStrictEqual(['给 审批层 加四档'])

    const explore = commands.find((command) => command.spec.name === 'explore')!
    expect(explore.spec.description).toContain('探索模式')
    explore.handler({ args: [], ui: { notice: () => {} }, runtime })
    expect(session.mode).toBe('explore')

    const quiet = commands.find((command) => command.spec.name === 'quiet')!
    expect(quiet.spec.description).toContain('免打扰模式')
    quiet.handler({ args: [], ui: { notice: () => {} }, runtime })
    expect(session.mode).toBe('quiet')

    const build = commands.find((command) => command.spec.name === 'build')!
    expect(build.spec.description).toContain('回到执行模式')
    build.handler({ args: [], ui: { notice: () => {} }, runtime })
    expect(session.mode).toBe('build')
    expect(submitted).toHaveLength(1)
    expect(harness.emitted.some((event) => event.event === 'dsc/mode-changed')).toBe(true)
  })
})
