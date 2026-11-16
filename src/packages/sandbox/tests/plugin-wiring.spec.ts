/**
 * sandbox 插件装配面（`src/packages/sandbox/index.ts`）：守卫、设置分区、命令、对外服务。
 *
 * 用假 ctx（只实现插件真用到的那几项）跑一次 `apply`，再逐项调用服务与守卫。
 * 归 unit 而不是 integration：不起内核、不装配插件，只验「这个插件把自己的面挂对了没」。
 *
 * DSC_HOME 在任何 import 之前指进临时目录——`policy` / `plugin-registry` 的路径是模块求值时
 * 算定的；不隔离就会读写开发机真实的 `~/.dsc`。
 *
 * @module dsc/packages/sandbox/tests/plugin-wiring.spec
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-sandbox-wiring-'))
process.env['DSC_HOME'] = HOME

/** 动态 import 的插件与类型（beforeAll 里装载）。 */
let sandboxPlugin: typeof import('../index.js').sandboxPlugin
let policyModule: typeof import('../policy.js')

afterAll(() => {
  delete process.env['DSC_HOME']
})

/** 一个够用的假会话：权限状态可读可写，meta 带 cwd/id。 */
function fakeSession(cwd: string) {
  const state: Record<string, unknown> = {}
  return {
    meta: { cwd, id: 's1' },
    filePath: join(HOME, 'sessions', 's1.jsonl'),
    state(id: string) {
      return state[id] as never
    },
    appendState(id: string, payload: unknown) {
      state[id] = payload
    },
    setState(id: string, payload: unknown) {
      state[id] = payload
    },
  }
}

/** 假 ctx：记录插件挂了什么，按需返回 disposer。 */
function fakeCtx(session: ReturnType<typeof fakeSession>) {
  const guards: Array<{ id: string; order: number; decide: (input: unknown) => unknown }> = []
  const commands: Array<{ name: string; run: (args: unknown) => unknown }> = []
  const facts: Array<{ id: string; fn: (s: unknown) => string }> = []
  const notices: string[] = []
  const events: string[] = []
  let section: Record<string, unknown> | null = null
  const provided: Record<string, unknown> = {}
  const ctx = {
    session: { current: () => session },
    get(name: string) {
      if (name === 'agent') {
        return {
          sessionById: (id: string) => (id === 's1' ? session : undefined),
          sessionFor: () => undefined,
        }
      }
      return undefined
    },
    guards: {
      register(guard: { id: string; order: number; decide: (input: unknown) => unknown }) {
        guards.push(guard)
        return () => undefined
      },
    },
    effect(fn: () => unknown) {
      return fn()
    },
    prompt: {
      registerEnvFacts(id: string, fn: (s: unknown) => string) {
        facts.push({ id, fn })
        return () => undefined
      },
    },
    settings: {
      registerSection(value: Record<string, unknown>) {
        section = value
        return () => undefined
      },
    },
    commands: {
      register(spec: { name: string }, run: (args: unknown) => unknown) {
        commands.push({ name: spec.name, run })
        return () => undefined
      },
    },
    provide(name: string, value: unknown) {
      provided[name] = value
      return () => undefined
    },
    on(event: string) {
      events.push(event)
      return () => undefined
    },
    emit(event: string) {
      events.push(event)
    },
    transcript: {
      system(text: string) {
        notices.push(text)
      },
    },
  }
  return { ctx, guards, commands, facts, notices, events, provided, sectionOf: () => section }
}

/** 服务形状（只取测试用到的成员）。 */
interface SandboxServiceLike {
  mode: string
  enforcement: string
  writableRoots: readonly string[]
  networkAccess: boolean
  tmpDir: string
  canWrite(path: string, cwd?: string): { allowed: boolean; reason: string }
  check(target: string | undefined, command: string | undefined): { allowed: boolean; requestable: boolean; rule?: string }
  describe(): string
  grantSession(path: string, roots: readonly string[]): void
  sessionGrants(path: string): readonly string[]
  setMode(next: string): void
  setDefaultMode(next: string): void
}

beforeAll(async () => {
  sandboxPlugin = (await import('../index.js')).sandboxPlugin
  policyModule = await import('../policy.js')
})

function boot(options: { mode?: string; networkAccess?: boolean } = {}) {
  const cwd = join(HOME, 'work')
  mkdirSync(cwd, { recursive: true })
  const session = fakeSession(cwd)
  const fake = fakeCtx(session)
  ;(sandboxPlugin.apply as (ctx: unknown, passed: unknown) => void)(fake.ctx, {
    mode: options.mode ?? 'workspace-write',
    networkAccess: options.networkAccess ?? false,
  })
  const service = fake.provided['sandbox'] as SandboxServiceLike
  const sandboxGuard = fake.guards.find((guard) => guard.id === 'sandbox')!
  return { ...fake, cwd, session, service, sandboxGuard }
}

describe('装配面', () => {
  test('两个守卫、一个设置分区、两条命令、一个服务、一条 prompt 事实', () => {
    const booted = boot()
    expect(booted.guards.map((guard) => [guard.id, guard.order])).toEqual([
      ['sandbox', 8],
      ['file-review', 25],
    ])
    expect(booted.sectionOf()).toMatchObject({ id: 'sandbox' })
    expect(booted.commands.map((command) => command.name).sort()).toEqual(['file-review', 'sandbox'])
    expect(booted.service).toBeDefined()
    expect(booted.facts.map((fact) => fact.id)).toContain('sandbox')
    expect(booted.events).toContain('dsc/session-open')
  })

  test('/sandbox 与 /file-review 都把说明发给 ui.notice', () => {
    const booted = boot()
    const notices: string[] = []
    const ui = { notice: (text: string) => notices.push(text) }
    for (const command of booted.commands) command.run({ ui })
    expect(notices).toHaveLength(2)
    expect(notices.join('\n')).toContain('沙箱')
    expect(notices.join('\n')).toContain('改动前预览')
  })

  test('prompt 环境事实写清档位与强制执行等级', () => {
    const booted = boot()
    const text = booted.facts.find((fact) => fact.id === 'sandbox')!.fn(booted.session)
    expect(text).toContain('workspace-write')
  })
})

describe('对外服务', () => {
  test('mode / enforcement / roots / tmpDir / networkAccess', () => {
    const booted = boot({ mode: 'workspace-write', networkAccess: true })
    expect(booted.service.mode).toBe('workspace-write')
    expect(booted.service.enforcement).toBe('partial')
    expect(booted.service.networkAccess).toBe(true)
    expect(booted.service.writableRoots.some((root) => root.includes('work'))).toBe(true)
    expect(booted.service.tmpDir).toContain('sandbox')
    expect(booted.service.describe()).toContain('workspace-write')
  })

  test('canWrite：工作区内允许，区外拒绝并给理由', () => {
    const booted = boot()
    const inside = booted.service.canWrite(join(booted.cwd, 'a.txt'))
    expect(inside.allowed, inside.reason).toBe(true)
    const outside = booted.service.canWrite(join(HOME, 'elsewhere', 'b.txt'))
    expect(outside.allowed).toBe(false)
    expect(outside.reason).not.toBe('')
  })

  test('check：forbidden 命令不可请求放宽；可提问的写越界标 requestable', () => {
    const booted = boot()
    const forbidden = booted.service.check(undefined, 'schtasks /query')
    expect(forbidden.allowed).toBe(false)
    expect(forbidden.rule).toBe('schtasks')
    expect(forbidden.requestable).toBe(false)

    const writeOutside = booted.service.check(join(HOME, 'elsewhere', 'b.txt'), undefined)
    expect(writeOutside.allowed).toBe(false)
    expect(writeOutside.requestable).toBe(true)
  })

  test('grantSession 只影响该会话路径，可重复并去重', () => {
    const booted = boot()
    const granted = join(HOME, 'granted')
    booted.service.grantSession(booted.session.filePath, [granted, granted])
    expect(booted.service.sessionGrants(booted.session.filePath)).toEqual([granted])
    // 别的会话路径不受影响。
    expect(booted.service.sessionGrants('/other/session.jsonl')).toEqual([])
  })

  test('setMode 非法值当场抛错；合法值写会话状态并 emit', () => {
    const booted = boot()
    expect(() => booted.service.setMode('root')).toThrow(/只能/)
    booted.service.setMode('danger-full-access')
    expect(booted.service.mode).toBe('danger-full-access')
    expect(booted.events).toContain('dsc/changed')
    expect(() => booted.service.setDefaultMode('root')).toThrow(/只能/)
  })
})

describe('守卫判定', () => {
  function input(overrides: Record<string, unknown> = {}) {
    return {
      toolName: 'write',
      risk: 'write',
      cwd: join(HOME, 'work'),
      args: { path: join(HOME, 'work', 'a.txt'), content: 'x' },
      target: join(HOME, 'work', 'a.txt'),
      signal: new AbortController().signal,
      sessionId: 's1',
      sessionPath: join(HOME, 'sessions', 's1.jsonl'),
      ...overrides,
    }
  }

  test('读类工具与 danger-full-access 档直接 defer', () => {
    const booted = boot()
    expect(booted.sandboxGuard.decide(input({ risk: 'read' }))).toEqual({ action: 'defer' })

    const full = boot({ mode: 'danger-full-access' })
    expect(full.sandboxGuard.decide(input())).toEqual({ action: 'defer' })
  })

  test('工作区内写 defer；区外写 deny 并带档位、可写根与下一步', () => {
    const booted = boot()
    expect(booted.sandboxGuard.decide(input())).toEqual({ action: 'defer' })

    const denied = booted.sandboxGuard.decide(
      input({ args: { path: join(HOME, 'elsewhere', 'b.txt'), content: 'x' }, target: join(HOME, 'elsewhere', 'b.txt') }),
    ) as { action: string; reason: string }
    expect(denied.action).toBe('deny')
    expect(denied.reason).toContain('沙箱拒绝这次 write')
    expect(denied.reason).toContain('workspace-write')
    expect(denied.reason).toContain('命中规则')
  })

  test('forbidden 命令 deny；半截升权请求 deny', () => {
    const booted = boot()
    const command = booted.sandboxGuard.decide(
      input({ toolName: 'bash', risk: 'exec', command: 'schtasks /query', args: { command: 'schtasks /query' }, target: undefined }),
    ) as { action: string; reason: string }
    expect(command.action).toBe('deny')
    expect(command.reason).toContain('schtasks')

    const malformed = booted.sandboxGuard.decide(
      input({ args: { path: join(HOME, 'work', 'a.txt'), content: 'x', sandbox_permissions: 'workspace-write' } }),
    ) as { action: string; reason: string }
    expect(malformed.action).toBe('deny')
    expect(malformed.reason).toContain('两个升权参数')
  })

  test('归属会话解析不到：deny（回落当前会话等于按别人的档位放行）', () => {
    const booted = boot()
    const verdict = booted.sandboxGuard.decide(input({ sessionId: 'gone', sessionPath: '' })) as {
      action: string
      reason: string
    }
    expect(verdict.action).toBe('deny')
    expect(verdict.reason).toContain('会话已经结束')
  })
})

describe('policy 暴露的一致性', () => {
  test('服务用的档位与 SANDBOX_MODES 表一致', () => {
    const booted = boot()
    expect(policyModule.SANDBOX_MODES).toContain(booted.service.mode)
  })
})
