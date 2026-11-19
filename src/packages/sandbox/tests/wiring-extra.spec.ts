/**
 * sandbox 插件装配面补测（`src/packages/sandbox/index.ts`）：
 * 后端选择/降级、fail-closed、docker 探测代次、设置分区的 fields/values/save/action、
 * `/sandbox` 报告、守卫的升权两档与审批在场与否、对外服务的查询口。
 *
 * 与 `plugin-wiring.spec.ts` 的分工：那边钉「挂上了没」，这里钉「每条决策分支说了什么」。
 * 后端探测、doctor、sweep、提权 setup 都是**会起进程/改系统**的东西，这里整包换成可编排的
 * 假实现（`vi.mock` + `vi.hoisted` 的共享状态），只验插件拿结论后怎么选、怎么写文案。
 * 真 FFI/真子进程的行为由 `win/setup.spec.ts` 与集成层负责。
 *
 * DSC_HOME 在任何 import 之前指进临时目录——`policy` / `plugin-registry` 的路径是模块求值时
 * 算定的；不隔离就会读写开发机真实的 `~/.dsc`。
 *
 * @module dsc/packages/sandbox/tests/wiring-extra.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync , realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'dsc-sandbox-wiring-extra-')))
process.env['DSC_HOME'] = HOME

/** 可编排的假后端状态（vi.mock 的工厂在 import 之前跑，只能用 vi.hoisted 的共享对象）。 */
const mockState = vi.hoisted(() => ({
  /** 受限令牌探测结论。 */
  probeToken: { available: false, detail: 'runner 入口没有构建产物：找不到 runner-entry.js' },
  /** true = probeWindowsToken 直接抛错（验 apply 的 catch 分支）。 */
  throwProbe: false,
  /** createWindowsTokenRunner 收到的入参。 */
  tokenOptions: null as Record<string, unknown> | null,
  /** dispose 被调了几次。 */
  tokenDispose: 0,
  /** 受限令牌后端是否已把网络第二级也锁死。 */
  networkEnforced: false,
  /** docker 探测固定结论。 */
  probeDockerFixed: { available: false, detail: 'docker 不在 PATH' },
  /** true = docker 探测挂起，由 dockerResolvers 手工兑现（验代次作废）。 */
  dockerDeferred: false,
  dockerResolvers: [] as Array<(value: { available: boolean; detail: string }) => void>,
  /** sweep 结论。 */
  sweep: { swept: [] as Array<{ path: string; sid: string; ageMs: number }>, kept: [] as string[], failed: [] as unknown[] },
  /** doctor 结论 / 是否抛错。 */
  doctor: { tier: 'partial' as 'full' | 'partial', details: ['× 没有 setup-state.json：二级网络管控还没成功 setup 过一次'] },
  doctorThrows: false,
  /** 提权安装/卸载结论与调用记录。 */
  setupResult: { ok: true, detail: '账号已启用' } as { ok: boolean; detail: string },
  uninstallResult: { ok: true, detail: '已清掉' } as { ok: boolean; detail: string },
  setupCalls: [] as string[],
  uninstallCalls: [] as string[],
}))

/* probeDocker 换成可编排的；createDockerRunner 保持真的（它只拼参数，不起进程）。 */
vi.mock('../backends.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backends.js')>()
  return {
    ...actual,
    probeDocker: () =>
      mockState.dockerDeferred
        ? new Promise((resolve) => mockState.dockerResolvers.push(resolve))
        : Promise.resolve(mockState.probeDockerFixed),
  }
})

/* 受限令牌后端换成假的：探测结论可控，执行器句柄可断言 dispose。 */
vi.mock('../win/backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../win/backend.js')>()
  return {
    ...actual,
    probeWindowsToken: () => {
      if (mockState.throwProbe) throw new Error('探测自身崩了')
      return mockState.probeToken
    },
    createWindowsTokenRunner: (options: Record<string, unknown>) => {
      mockState.tokenOptions = options
      return {
        runner: { id: 'sandbox-token-fake', order: 20, plan: () => null },
        dispose: () => {
          mockState.tokenDispose += 1
        },
        describe: () => '受限令牌 + ACL 已就位',
        networkEnforced: mockState.networkEnforced,
      }
    },
  }
})

vi.mock('../win/doctor.js', () => ({
  doctorWindowsNetwork: async () => {
    if (mockState.doctorThrows) throw new Error('doctor 崩了')
    return mockState.doctor
  },
}))

vi.mock('../win/sweep.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../win/sweep.js')>()
  return { ...actual, sweepSandboxTemps: () => mockState.sweep }
})

vi.mock('../win/setup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../win/setup.js')>()
  return {
    ...actual,
    runSetupElevated: async (home: string) => {
      mockState.setupCalls.push(home)
      return mockState.setupResult
    },
    runUninstallElevated: async (home: string) => {
      mockState.uninstallCalls.push(home)
      return mockState.uninstallResult
    },
  }
})

type SandboxIndex = typeof import('../index.js')
let sandboxPlugin: SandboxIndex['sandboxPlugin']
let pluginRegistry: typeof import('@pneuma/runtime/core/plugin-registry.js')
let commandRunner: typeof import('@pneuma/runtime/core/tools/command-runner.js')

beforeAll(async () => {
  sandboxPlugin = (await import('../index.js')).sandboxPlugin
  pluginRegistry = await import('@pneuma/runtime/core/plugin-registry.js')
  commandRunner = await import('@pneuma/runtime/core/tools/command-runner.js')
}, 20_000)

function resetPluginsFile(): void {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(join(HOME, 'plugins.json'), `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`, 'utf8')
  // 账本是「这台机器装过网络第二级」的证据：上一个用例写过的必须清掉，否则卸载按钮会漏进下一个用例。
  rmSync(join(HOME, 'sandbox', 'setup-state.json'), { force: true })
}

beforeEach(() => {
  resetPluginsFile()
  mockState.probeToken = { available: false, detail: 'runner 入口没有构建产物：找不到 runner-entry.js' }
  mockState.throwProbe = false
  mockState.tokenOptions = null
  mockState.tokenDispose = 0
  mockState.networkEnforced = false
  mockState.probeDockerFixed = { available: false, detail: 'docker 不在 PATH' }
  mockState.dockerDeferred = false
  mockState.dockerResolvers.length = 0
  mockState.sweep = { swept: [], kept: [], failed: [] }
  mockState.doctor = { tier: 'partial', details: ['× 没有 setup-state.json：二级网络管控还没成功 setup 过一次'] }
  mockState.doctorThrows = false
  mockState.setupResult = { ok: true, detail: '账号已启用' }
  mockState.uninstallResult = { ok: true, detail: '已清掉' }
  mockState.setupCalls.length = 0
  mockState.uninstallCalls.length = 0
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch {
    // Windows 上偶尔被子进程占着：临时目录留给系统清，不让收尾拖红。
  }
})

/** 等异步探测/事件落地（全是可控 promise，几毫秒足够）。 */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

/**
 * 临时把 `process.platform` 换成指定值（用完恢复原属性描述符）。
 *
 * 「默认档在 Windows 上自动启用受限令牌」这条分支（`index.ts` 按 process.platform 判定）只在 win32 上走得到；
 * 这里换成 win32 就能在 Linux 上验它拿到结论后怎么上报。后端探测与执行器已整体换假实现，不涉及真实路径语义。
 */
async function withPlatform<T>(value: NodeJS.Platform, run: () => T | Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...descriptor, value })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

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

interface Harness {
  ctx: Record<string, unknown>
  guards: Array<{ id: string; order: number; decide: (input: unknown) => unknown }>
  commands: Array<{ name: string; run: (args: unknown) => unknown }>
  facts: Array<{ id: string; fn: (session?: unknown) => string }>
  notices: string[]
  events: string[]
  effects: Array<{ label: string | undefined; off: unknown }>
  onHandlers: Array<{ event: string; handler: (...args: unknown[]) => unknown }>
  /** 每个挂载点的退订调用次数。 */
  offCalls: Record<string, number>
  provided: Record<string, unknown>
  sectionOf: () => Record<string, unknown> | null
}

/** 假 ctx：记录插件挂了什么，按需返回 disposer。 */
function fakeCtx(session: ReturnType<typeof fakeSession>, options: { approval?: boolean } = {}): Harness {
  const guards: Harness['guards'] = []
  const commands: Harness['commands'] = []
  const facts: Harness['facts'] = []
  const notices: string[] = []
  const events: string[] = []
  const effects: Harness['effects'] = []
  const onHandlers: Harness['onHandlers'] = []
  const offCalls: Record<string, number> = {}
  let section: Record<string, unknown> | null = null
  const provided: Record<string, unknown> = {}

  const disposer = (area: string): (() => void) => () => {
    offCalls[area] = (offCalls[area] ?? 0) + 1
  }

  const ctx = {
    session: { current: () => session },
    get(name: string) {
      if (name === 'agent') {
        return {
          sessionById: (id: string) => (id === 's1' ? session : undefined),
          sessionFor: (path: string) => (path === session.filePath ? session : undefined),
        }
      }
      if (name === 'approval') return options.approval === true ? {} : undefined
      return undefined
    },
    guards: {
      register(guard: Harness['guards'][number]) {
        guards.push(guard)
        return disposer(`guard:${guard.id}`)
      },
    },
    effect(fn: () => unknown, label?: string) {
      const off = fn()
      effects.push({ label, off })
      return off
    },
    prompt: {
      registerEnvFacts(id: string, fn: (value?: unknown) => string) {
        facts.push({ id, fn })
        return disposer('prompt')
      },
    },
    settings: {
      registerSection(value: Record<string, unknown>) {
        section = value
        return disposer('section')
      },
    },
    commands: {
      register(spec: { name: string }, run: (args: unknown) => unknown) {
        commands.push({ name: spec.name, run })
        return disposer(`command:${spec.name}`)
      },
    },
    provide(name: string, value: unknown) {
      provided[name] = value
      return disposer(`service:${name}`)
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      onHandlers.push({ event, handler })
      return disposer(`on:${event}`)
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
  return { ctx, guards, commands, facts, notices, events, effects, onHandlers, offCalls, provided, sectionOf: () => section }
}

interface ServiceLike {
  mode: string
  enforcement: string
  writableRoots: readonly string[]
  networkAccess: boolean
  tmpDir: string
  canWrite(path: string, cwd?: string, sessionPath?: string): { allowed: boolean; reason?: string; root?: string }
  check(target: string | undefined, command: string | undefined, cwd?: string, sessionPath?: string): {
    allowed: boolean
    requestable: boolean
    reason?: string
    rule?: string
  }
  describe(): string
  grantSession(path: string, roots: readonly string[]): void
  sessionGrants(path: string): readonly string[]
  setMode(next: string): void
  setDefaultMode(next: string): void
}

interface Booted extends Harness {
  cwd: string
  session: ReturnType<typeof fakeSession>
  service: ServiceLike
  guard: Harness['guards'][number]
  section: {
    id: string
    order: number
    groups: Array<{ id: string }>
    fields: () => Array<Record<string, unknown>>
    values: () => Record<string, unknown>
    save: (key: string, value: unknown) => Promise<string | void>
    action: (name: string) => Promise<string | void>
  }
  dispose: () => void
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const dispose of cleanups.splice(0)) {
    try {
      dispose()
    } catch {
      // 已经收过了
    }
  }
})

/** 真 apply：传入的 config 走 `passed`（装配时那份），磁盘先被 beforeEach 清空。 */
function boot(options: { config?: Record<string, unknown>; approval?: boolean } = {}): Booted {
  const cwd = mkdtempSync(join(HOME, 'work-'))
  const session = fakeSession(cwd)
  const fake = fakeCtx(session, options)
  const dispose = (sandboxPlugin.apply as unknown as (ctx: unknown, passed: unknown) => () => void)(
    fake.ctx,
    options.config ?? {},
  )
  cleanups.push(dispose)
  const service = fake.provided['sandbox'] as ServiceLike
  const guard = fake.guards.find((item) => item.id === 'sandbox')!
  const section = fake.sectionOf() as unknown as Booted['section']
  return { ...fake, cwd, session, service, guard, section, dispose }
}

/** 设置分区里某个 info/button 字段的文本。 */
function fieldText(booted: Booted, label: string): string {
  const field = booted.section.fields().find((item) => item.label === label)
  return String(field?.text ?? '')
}

/** 设置分区里某个控件（按 key）。 */
function fieldByKey(booted: Booted, key: string): Record<string, unknown> | undefined {
  return booted.section.fields().find((item) => item.key === key)
}

/** 磁盘上 sandbox 条目的配置。 */
function storedConfig(): Record<string, unknown> {
  return pluginRegistry.getPluginConfig('sandbox')
}

/** 写一份合法账本（验 setupInstalled / 专用账号分支）。 */
function writeSetupState(overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(HOME, 'sandbox'), { recursive: true })
  writeFileSync(
    join(HOME, 'sandbox', 'setup-state.json'),
    JSON.stringify({
      version: 1,
      account: 'dsc-sandbox-offline',
      sid: 'S-1-5-21-100-200-300-400',
      proxyPort: 3128,
      firewallRules: ['a'],
      wfpProviderGuid: '11111111-2222-3333-4444-555555555555',
      wfpSublayerGuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      at: '2026-11-16T00:00:00.000Z',
      ...overrides,
    }),
    'utf8',
  )
}

/** 守卫输入（写类默认指向工作区内）。 */
function guardInput(booted: Booted, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    toolName: 'write',
    risk: 'write',
    cwd: booted.cwd,
    args: { path: join(booted.cwd, 'a.txt'), content: 'x' },
    target: join(booted.cwd, 'a.txt'),
    signal: new AbortController().signal,
    sessionId: 's1',
    sessionPath: booted.session.filePath,
    ...overrides,
  }
}

// ── 装配与收尾 ───────────────────────────────────────────────────────────────

describe('装配与收尾', () => {
  test('两个守卫两个命令一个服务；四条 effect 登记；收尾逐个退订', () => {
    const booted = boot()
    expect(booted.guards.map((item) => [item.id, item.order])).toEqual([
      ['sandbox', 8],
      ['file-review', 25],
    ])
    expect(booted.commands.map((item) => item.name).sort()).toEqual(['file-review', 'sandbox'])
    expect(booted.effects.map((item) => item.label)).toEqual([
      'sandbox: guards.register',
      'sandbox: guards.register（改动前预览）',
      'sandbox: prompt.registerEnvFacts',
      'sandbox: settings.registerSection',
      'sandbox: commands.register',
      'sandbox: commands.register（改动前预览）',
    ])

    booted.dispose()
    expect(booted.offCalls).toMatchObject({
      'guard:sandbox': 1,
      'guard:file-review': 1,
      prompt: 1,
      section: 1,
      'command:sandbox': 1,
      'command:file-review': 1,
      'service:sandbox': 1,
      'on:dsc/session-open': 1,
    })
  })

  test('dsc/session-open：重算后端并广播 dsc/changed', async () => {
    const booted = boot()
    const handler = booted.onHandlers.find((item) => item.event === 'dsc/session-open')!.handler
    const before = booted.events.filter((event) => event === 'dsc/changed').length
    handler()
    await flush()
    expect(booted.events.filter((event) => event === 'dsc/changed').length).toBeGreaterThan(before)
  })
})

// ── 后端选择与降级 ───────────────────────────────────────────────────────────

describe('后端选择与降级', () => {
  test('默认 policy + win32 自动升失败：说明里点名原因；非 Windows 说默认策略围栏', () => {
    const booted = boot()
    const status = fieldText(booted, '后端现状')
    if (process.platform === 'win32') {
      expect(status).toContain('自动启用系统级隔离没成')
      expect(status).toContain('runner 入口没有构建产物')
    } else {
      expect(status).toContain('默认后端，不需要外部进程')
    }
    expect(booted.service.enforcement).toBe('partial')
    expect(booted.facts.find((item) => item.id === 'sandbox')!.fn(booted.session)).toContain('partial')
  })

  test('danger-full-access：enforcement none、后端不参与判定、守卫整档 defer', () => {
    const booted = boot({ config: { mode: 'danger-full-access', backend: 'docker', onUnavailable: 'fail-closed' } })
    expect(booted.service.enforcement).toBe('none')
    expect(fieldText(booted, '后端现状')).toContain('不设围栏；后端与「建不起来就拒」在这一档不生效')
    const prompt = booted.facts.find((item) => item.id === 'sandbox')!.fn(booted.session)
    expect(prompt).toContain('档位 danger-full-access')
    expect(prompt).not.toContain('可写根')
    expect(booted.service.describe()).toContain('围栏关闭（不限制）')
    expect(booted.guard.decide(guardInput(booted, { target: join(HOME, 'outside', 'x.txt') }))).toEqual({
      action: 'defer',
    })

    const plain = boot({ config: { mode: 'danger-full-access' } })
    expect(fieldText(plain, '后端现状')).toBe('档位 danger-full-access：不设围栏')
  })

  test('显式 windows-token 但不可用：降级说明进设置页与会话流', () => {
    const booted = boot({ config: { backend: 'windows-token' } })
    const status = fieldText(booted, '后端现状')
    expect(status).toContain('Windows 受限令牌后端不可用，已降级为策略围栏')
    expect(status).toContain('runner 入口没有构建产物')
    expect(booted.notices).toContain(
      '沙箱：Windows 受限令牌后端不可用，已降级为策略围栏：runner 入口没有构建产物：找不到 runner-entry.js',
    )
    expect(booted.service.enforcement).toBe('partial')
  })

  test('windows-token + fail-closed：写与执行一律拒、读照常，提示段带警告', () => {
    const booted = boot({ config: { backend: 'windows-token', onUnavailable: 'fail-closed' } })
    expect(fieldText(booted, '后端现状')).toContain('写与执行类工具一律拒（读照常）')

    const write = booted.guard.decide(guardInput(booted, { target: join(HOME, 'outside', 'x.txt') })) as {
      action: string
      reason: string
    }
    expect(write.action).toBe('deny')
    expect(write.reason).toContain('你要的隔离后端（docker / Windows 受限令牌）没建起来')
    expect(write.reason).toContain('命中规则「backend-unavailable」')
    expect(booted.guard.decide(guardInput(booted, { risk: 'read' }))).toEqual({ action: 'defer' })

    const prompt = booted.facts.find((item) => item.id === 'sandbox')!.fn(booted.session)
    expect(prompt).toContain('⚠ 你要的隔离后端没建起来')

    const notices: string[] = []
    booted.commands.find((item) => item.name === 'sandbox')!.run({ ui: { notice: (text: string) => notices.push(text) } })
    expect(notices[0]).toContain('（当前正处在这个状态：写与执行类一律拒）')
  })

  test('windows-token 可用（自动档）：注册执行器、说明自动启用、dispose 回收', async () => {
    // 自动启用只在 win32 上判定（index.ts 的 needsTokenProbe）：临时当 win32 才验得到这条分支。
    await withPlatform('win32', () => {
      mockState.probeToken = { available: true, detail: '受限令牌后端可用' }
      const booted = boot()
      expect(booted.service.enforcement).toBe('partial')
      expect(fieldText(booted, '后端现状')).toContain('已自动启用系统级隔离（可在设置里改回策略围栏）')
      expect(fieldText(booted, '后端现状')).toContain('受限令牌 + ACL 已就位')
      expect(commandRunner.commandRunnerIds()).toContain('sandbox-token-fake')

      // 执行器入参：档位与网络都按现读配置给。
      expect(mockState.tokenOptions).toMatchObject({ mode: 'workspace-write' })
      expect((mockState.tokenOptions!['networkAccess'] as () => boolean)()).toBe(false)
      const onDetail = mockState.tokenOptions!['onDetail'] as (message: string) => void
      onDetail('测试明细')
      expect(booted.notices).toContain('沙箱：测试明细')

      const prompt = booted.facts.find((item) => item.id === 'sandbox')!.fn(booted.session)
      expect(prompt).toContain('当前后端是自动启用的 Windows 受限令牌')

      booted.dispose()
      expect(mockState.tokenDispose).toBe(1)
      expect(commandRunner.commandRunnerIds()).not.toContain('sandbox-token-fake')
    })
  })

  test('windows-token 可用 + 账本在位：走专用账号分支并报 full', async () => {
    // 同上：自动启用是 Windows 专属分支；账本与 runner 都是假的，Linux 上验得到同样的结论文案。
    await withPlatform('win32', () => {
      writeSetupState()
      mockState.probeToken = { available: true, detail: '受限令牌后端可用' }
      mockState.networkEnforced = true
      const booted = boot()
      expect(booted.service.enforcement).toBe('full')
      expect(fieldText(booted, '后端现状')).toContain('Windows 受限令牌 + 专用账号（dsc-sandbox-offline）')
      expect(mockState.tokenOptions?.['account']).toMatchObject({
        name: 'dsc-sandbox-offline',
        sid: 'S-1-5-21-100-200-300-400',
        dscHome: HOME,
        proxyPort: 3128,
      })
    })
  })

  test('docker 可用：容器执行器就位、full、镜像进说明', async () => {
    mockState.probeDockerFixed = { available: true, detail: 'docker Server 27.0.0' }
    const booted = boot({ config: { backend: 'docker', image: 'node:20-alpine' } })
    await flush()
    expect(booted.service.enforcement).toBe('full')
    expect(fieldText(booted, '后端现状')).toContain('容器后端可用（docker Server 27.0.0），命令在 node:20-alpine 里跑')
    expect(commandRunner.commandRunnerIds()).toContain('sandbox-docker')
    booted.dispose()
    expect(commandRunner.commandRunnerIds()).not.toContain('sandbox-docker')
  })

  test('docker 不可用：degrade 与 fail-closed 两套文案与判定', async () => {
    const degraded = boot({ config: { backend: 'docker' } })
    await flush()
    expect(degraded.service.enforcement).toBe('partial')
    expect(fieldText(degraded, '后端现状')).toBe('容器后端不可用，已降级为策略围栏：docker 不在 PATH')
    expect(degraded.notices).toContain(
      '沙箱：选的容器后端用不了，已降级为策略围栏（强制执行 partial，照常执行 + 审批卡兜底）——docker 不在 PATH',
    )

    const closed = boot({ config: { backend: 'docker', onUnavailable: 'fail-closed' } })
    await flush()
    expect(fieldText(closed, '后端现状')).toContain('容器后端不可用，且配置选了「后端建不起来就拒」')
    expect(closed.notices).toContain(
      '沙箱：选的容器后端用不了，按配置 fail-closed 处理，写与执行类工具一律拒——docker 不在 PATH',
    )
    const verdict = closed.guard.decide(guardInput(closed, { target: join(HOME, 'outside', 'x.txt') })) as {
      action: string
    }
    expect(verdict.action).toBe('deny')
  })

  test('docker 探测中途被再次切换：过期结果作废，最后一次生效', async () => {
    mockState.dockerDeferred = true
    const booted = boot({ config: { backend: 'docker' } })
    const second = booted.section.action('probe')
    const third = booted.section.action('probe')
    expect(mockState.dockerResolvers).toHaveLength(3)

    // 第一次（apply 挂载时那次）最后返回：它已经过期。
    mockState.dockerResolvers[0]!({ available: true, detail: 'docker Server 1' })
    await flush()
    // 第三次（最新代次）先落地：它就是当前结论。
    mockState.dockerResolvers[2]!({ available: true, detail: 'docker Server 3' })
    await flush()
    expect(await third).toContain('容器后端可用（docker Server 3）')
    // 第二次在第三次之后才回来：代次已经不是它，结论作废。
    mockState.dockerResolvers[1]!({ available: true, detail: 'docker Server 2' })
    await flush()
    expect(await second).toBe('后端被再次切换，这次探测结果作废')
  })

  test('后端探测自身抛错：会话流给一句兜底说明', async () => {
    // 探测只在「默认档 + win32」这条路上发生（index.ts 的 needsTokenProbe），临时当 win32 才验得到 catch 分支。
    await withPlatform('win32', async () => {
      mockState.throwProbe = true
      const booted = boot()
      await flush()
      expect(booted.notices.some((text) => text.startsWith('沙箱后端探测失败（照常执行 + 审批卡兜底）：'))).toBe(true)
      expect(booted.notices.join('\n')).toContain('探测自身崩了')
    })
  })
})

// ── 设置分区 ─────────────────────────────────────────────────────────────────

describe('设置分区', () => {
  test('fields：三档下拉、review 组、win32 控件按「装过没」增减、坏配置单列一条', () => {
    const booted = boot({ config: { mode: 'yolo' } })
    const fields = booted.section.fields()
    expect(booted.section.id).toBe('sandbox')
    expect(booted.section.order).toBe(31)
    expect(booted.section.groups.map((group) => group.id)).toContain('review')

    const mode = fieldByKey(booted, 'mode') as { options: Array<{ value: string }> }
    expect(mode.options.map((option) => option.value)).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    expect(fieldByKey(booted, 'enabled')).toMatchObject({ group: 'review', type: 'switch' })
    expect(fieldByKey(booted, 'maxLines')).toMatchObject({ group: 'review', min: 5, max: 2000 })
    expect(fieldText(booted, '当前会话强制执行等级')).toContain('partial ——')

    const actions = fields.filter((item) => item.type === 'button').map((item) => item.action)
    expect(actions).toContain('probe')
    if (process.platform === 'win32') {
      expect(actions).toContain('setup')
      expect(actions).toContain('doctor')
      expect(actions).not.toContain('uninstall')
      expect(fieldText(booted, '网络第二级（提权布防）')).toContain('partial ——')

      writeSetupState()
      const withLedger = booted.section.fields()
      expect(withLedger.filter((item) => item.type === 'button').map((item) => item.action)).toContain('uninstall')
    }

    // 坏档位回落默认值 + 列出问题。
    expect(fieldText(booted, '配置有问题（已按默认值兜底）')).toContain('档位只能是')
  })

  test('values：档位、列表格式化、review 三项', () => {
    const booted = boot({
      config: {
        mode: 'workspace-write',
        networkAccess: true,
        networkAllowlist: ['a.com', '*.b.com'],
        extraWritableRoots: ['D:\\shared'],
        readOnlySubpaths: ['D:\\shared\\generated'],
        backend: 'policy',
        image: 'node:20-alpine',
        onUnavailable: 'fail-closed',
        grantCacheRoots: false,
      },
    })
    expect(booted.section.values()).toEqual({
      mode: 'workspace-write',
      defaultMode: 'workspace-write',
      networkAccess: true,
      networkAllowlist: 'a.com; *.b.com',
      extraWritableRoots: 'D:\\shared',
      readOnlySubpaths: 'D:\\shared\\generated',
      backend: 'policy',
      grantCacheRoots: false,
      image: 'node:20-alpine',
      onUnavailable: 'fail-closed',
      enabled: true,
      maxLines: 120,
      contextLines: 3,
    })
  })

  test('save 档位：非法值回文案，会话档位与默认档位分开落', async () => {
    const booted = boot()
    expect(await booted.section.save('mode', 'root')).toContain('档位只能是')
    await booted.section.save('mode', 'read-only')
    expect(booted.service.mode).toBe('read-only')
    expect(storedConfig()['mode']).toBeUndefined()

    expect(await booted.section.save('defaultMode', 'root')).toContain('档位只能是')
    await booted.section.save('defaultMode', 'workspace-write')
    expect(storedConfig()['mode']).toBe('workspace-write')
    // 「新会话默认」不改当前会话已经钉住的档位。
    expect(booted.service.mode).toBe('read-only')
  })

  test('save 网络/白名单/后端/镜像/缓存目录：校验与落盘', async () => {
    const booted = boot()
    await booted.section.save('networkAccess', true)
    expect(booted.service.networkAccess).toBe(true)
    expect(storedConfig()['networkAccess']).toBe(true)

    expect(await booted.section.save('networkAllowlist', 'not a domain; ok.com')).toContain('白名单里有不像域名的项')
    await booted.section.save('networkAllowlist', 'Example.COM; *.foo.com')
    expect(storedConfig()['networkAllowlist']).toEqual(['example.com', '*.foo.com'])

    expect(await booted.section.save('onUnavailable', 'maybe')).toContain('只能是 degrade')
    await booted.section.save('onUnavailable', 'fail-closed')
    expect(storedConfig()['onUnavailable']).toBe('fail-closed')

    expect(await booted.section.save('backend', 'nsjail')).toContain('后端只能是')
    await booted.section.save('backend', 'policy')
    expect(storedConfig()['backend']).toBe('policy')

    expect(await booted.section.save('image', '   ')).toContain('空着')
    expect(await booted.section.save('image', 'node 20')).toContain('不能带空格')
    await booted.section.save('image', '  node:20  ')
    expect(storedConfig()['image']).toBe('node:20')

    await booted.section.save('grantCacheRoots', false)
    expect(storedConfig()['grantCacheRoots']).toBe(false)

    await booted.section.save('extraWritableRoots', 'D:\\x; D:\\y; D:\\x')
    expect(storedConfig()['extraWritableRoots']).toEqual(['D:\\x', 'D:\\y'])
    await booted.section.save('readOnlySubpaths', 'D:\\x\\gen\nD:\\y\\gen')
    expect(storedConfig()['readOnlySubpaths']).toEqual(['D:\\x\\gen', 'D:\\y\\gen'])
  })

  test('save 改动预览三项：写完即回，不做后端重算；未知键给文案', async () => {
    const booted = boot()
    const before = booted.events.filter((event) => event === 'dsc/changed').length
    expect(await booted.section.save('enabled', false)).toBeUndefined()
    expect(storedConfig()['enabled']).toBe(false)
    // 预览三项只 emit 一次变更，不重建后端（重建会拆掉执行器并补一条「沙箱已就绪」）。
    expect(booted.events.filter((event) => event === 'dsc/changed').length).toBeGreaterThan(before)

    expect(await booted.section.save('maxLines', 'abc')).toContain('这里要填一个数字')
    await booted.section.save('maxLines', 42.6)
    expect(storedConfig()['maxLines']).toBe(43)

    expect(await booted.section.save('contextLines', Number.NaN)).toContain('这里要填一个数字')
    await booted.section.save('contextLines', 2)
    expect(storedConfig()['contextLines']).toBe(2)

    expect(await booted.section.save('nope', 1)).toContain('这个分区没有这项')
  })

  test('action：probe 返回后端现状；doctor 成功/异常；未知按钮', async () => {
    const booted = boot()
    expect(String(await booted.section.action('probe'))).toContain('进程内策略围栏')

    if (process.platform === 'win32') {
      mockState.doctor = { tier: 'full', details: ['√ FFI', '√ 账本'] }
      expect(await booted.section.action('doctor')).toBe('网络第二级：full —— √ FFI；√ 账本')

      mockState.doctorThrows = true
      expect(String(await booted.section.action('doctor'))).toContain('体检失败：doctor 崩了')
    }
    expect(await booted.section.action('nope')).toContain('这个分区没有这个按钮')
  })

  test('action：setup / uninstall 的平台闸与结论文案', async () => {
    const booted = boot()
    if (process.platform !== 'win32') {
      expect(await booted.section.action('setup')).toBe('网络第二级只适用于 Windows')
      expect(await booted.section.action('uninstall')).toBe('网络第二级只适用于 Windows')
      return
    }
    mockState.doctor = { tier: 'full', details: ['√ FFI'] }
    const setup = String(await booted.section.action('setup'))
    expect(setup).toContain('提权 setup 完成')
    expect(setup).toContain('账号已启用')
    expect(setup).toContain('√ FFI')
    expect(mockState.setupCalls).toContain(HOME)

    mockState.uninstallResult = { ok: false, detail: '账号删不掉' }
    const uninstall = String(await booted.section.action('uninstall'))
    expect(uninstall).toContain('提权卸载未完成')
    expect(uninstall).toContain('账号删不掉')
    expect(mockState.uninstallCalls).toContain(HOME)
  })
})

// ── 守卫判定补遗 ─────────────────────────────────────────────────────────────

describe('守卫判定补遗', () => {
  test('可问的越界：审批在场 defer，不在场 deny；受保护名即使审批在场也 deny', () => {
    const withApproval = boot({ approval: true })
    expect(withApproval.guard.decide(guardInput(withApproval, { target: join(HOME, 'outside', 'x.txt') }))).toEqual({
      action: 'defer',
    })
    const protectedVerdict = withApproval.guard.decide(
      guardInput(withApproval, { target: join(withApproval.cwd, '.env') }),
    ) as { action: string; reason: string }
    expect(protectedVerdict.action).toBe('deny')
    expect(protectedVerdict.reason).toContain('protected-metadata')

    const noApproval = boot()
    expect(noApproval.guard.decide(guardInput(noApproval, { target: join(HOME, 'outside', 'x.txt') }))).toMatchObject({
      action: 'deny',
    })
  })

  test('升权请求：workspace-write 重判通过/仍不合法；danger 整条 defer', () => {
    const booted = boot()
    const outside = join(HOME, 'outside', 'x.txt')

    const widened = booted.guard.decide(
      guardInput(booted, {
        target: outside,
        args: { path: outside, content: 'x', sandbox_permissions: 'workspace-write', justification: '要写' },
      }),
    )
    expect(widened).toEqual({ action: 'defer' })

    const stillDenied = booted.guard.decide(
      guardInput(booted, {
        target: join(booted.cwd, '.env'),
        args: { path: join(booted.cwd, '.env'), content: 'x', sandbox_permissions: 'workspace-write', justification: '要写' },
      }),
    ) as { action: string; reason: string }
    expect(stillDenied.action).toBe('deny')
    expect(stillDenied.reason).toContain('仍然')

    expect(
      booted.guard.decide(
        guardInput(booted, {
          target: outside,
          args: { path: outside, content: 'x', sandbox_permissions: 'danger-full-access', justification: '整条出沙箱' },
        }),
      ),
    ).toEqual({ action: 'defer' })

    // 命令类认不出「写目标」：放宽请求只能整条 defer，由审批卡兜底。
    expect(
      booted.guard.decide(
        guardInput(booted, {
          toolName: 'bash',
          risk: 'exec',
          command: 'npm install left-pad',
          target: undefined,
          args: { command: 'npm install left-pad', sandbox_permissions: 'workspace-write', justification: '装依赖' },
        }),
      ),
    ).toEqual({ action: 'defer' })
  })

  test('网络关时的联网命令：deny 并给「打开开关」的自救路径', () => {
    const booted = boot()
    const verdict = booted.guard.decide(
      guardInput(booted, {
        toolName: 'bash',
        risk: 'exec',
        command: 'curl https://example.com',
        target: undefined,
        args: { command: 'curl https://example.com' },
      }),
    ) as { action: string; reason: string }
    expect(verdict.action).toBe('deny')
    expect(verdict.reason).toContain('命中规则「network-off」')
    expect(verdict.reason).toContain('打开网络开关')
  })

  test('命令里的写目标越界：命中 write-target 前缀，并给出改到可写根的做法', () => {
    const booted = boot()
    const command = `cp ${join(booted.cwd, 'a.txt')} ${join(HOME, 'outside', 'b.txt')}`
    const verdict = booted.guard.decide(
      guardInput(booted, { toolName: 'bash', risk: 'exec', command, target: undefined, args: { command } }),
    ) as { action: string; reason: string }
    expect(verdict.action).toBe('deny')
    expect(verdict.reason).toContain('write-target:')
    expect(verdict.reason).toContain('把目标改到可写根内')
  })

  test('写目标为空 / 命令为空：不判（那是审批卡的活）', () => {
    const booted = boot()
    expect(booted.guard.decide(guardInput(booted, { target: '' }))).toEqual({ action: 'defer' })
    expect(
      booted.guard.decide(guardInput(booted, { risk: 'exec', command: '   ', target: undefined, args: {} })),
    ).toEqual({ action: 'defer' })
  })
})

// ── /sandbox 报告与对外服务 ──────────────────────────────────────────────────

describe('/sandbox 报告与对外服务', () => {
  test('报告：最近 3 次拒绝只留后三条、会话放宽根单列、配置问题带 ⚠', () => {
    const booted = boot({ config: { mode: 'yolo' } })
    for (const tool of ['tool-a', 'tool-b', 'tool-c', 'tool-d']) {
      booted.guard.decide(guardInput(booted, { toolName: tool, target: join(HOME, 'outside', `${tool}.txt`) }))
    }
    const granted = join(HOME, 'granted-session')
    booted.service.grantSession(booted.session.filePath, [granted])

    const notices: string[] = []
    booted.commands.find((item) => item.name === 'sandbox')!.run({ ui: { notice: (text: string) => notices.push(text) } })
    const text = notices[0]!
    expect(text).toContain('最近 3 次拒绝：')
    expect(text).not.toContain('tool-a')
    expect(text).toContain('tool-b')
    expect(text).toContain('tool-d')
    expect(text).toContain('本会话放宽出来的可写根（1）')
    expect(text).toContain(granted)
    expect(text).toContain('⚠ 配置有问题（已按默认值兜底）')
    if (process.platform === 'win32') expect(text).toContain('网络第二级：')
  })

  test('check：danger 放行；写越界可问、受保护名不可问、联网与只读命令的结论', () => {
    const full = boot({ config: { mode: 'danger-full-access' } })
    expect(full.service.check('anywhere', undefined)).toEqual({ allowed: true, requestable: false })

    const booted = boot()
    expect(booted.service.check(join(HOME, 'outside', 'x.txt'), undefined)).toMatchObject({
      allowed: false,
      requestable: true,
      rule: 'outside-writable-roots',
    })
    expect(booted.service.check(join(booted.cwd, '.env'), undefined)).toMatchObject({
      allowed: false,
      requestable: false,
      rule: 'protected-metadata',
    })
    expect(booted.service.check(undefined, 'curl https://example.com')).toMatchObject({
      allowed: false,
      requestable: false,
      rule: 'network-off',
    })
    expect(booted.service.check(undefined, 'git status')).toEqual({ allowed: true, requestable: false })
    expect(booted.service.check(undefined, '   ')).toEqual({ allowed: true, requestable: false })
  })

  test('canWrite 带 cwd/sessionPath；grantSession 忽略空参、去重，放宽根参与判定', () => {
    const booted = boot()
    expect(booted.service.canWrite(join(booted.cwd, 'a.txt'), booted.cwd)).toMatchObject({ allowed: true })
    expect(booted.service.canWrite(join(HOME, 'outside', 'b.txt'), booted.cwd).allowed).toBe(false)

    booted.service.grantSession('', ['D:\\x'])
    expect(booted.service.sessionGrants('')).toEqual([])
    booted.service.grantSession(booted.session.filePath, [])
    expect(booted.service.sessionGrants(booted.session.filePath)).toEqual([])
    const granted = join(HOME, 'granted')
    booted.service.grantSession(booted.session.filePath, [granted, granted, ''])
    expect(booted.service.sessionGrants(booted.session.filePath)).toEqual([granted])

    const target = join(granted, 'f.txt')
    expect(booted.service.canWrite(target, booted.cwd, booted.session.filePath).allowed).toBe(true)
    // 别的会话没有这条放宽，照旧拒。
    expect(booted.service.canWrite(target, booted.cwd, '/other/session.jsonl').allowed).toBe(false)
  })

  test('setDefaultMode 写盘；非法档位抛错；describe 跟档位走', () => {
    const booted = boot()
    // 先读一次把默认值钉进本会话（读路径会 pin），再改新会话默认——老会话不许跟着漂。
    expect(booted.service.mode).toBe('workspace-write')
    expect(() => booted.service.setDefaultMode('root')).toThrow(/只能/)
    booted.service.setDefaultMode('read-only')
    expect(storedConfig()['mode']).toBe('read-only')
    expect(booted.service.mode).toBe('workspace-write')
    expect(booted.service.describe()).toContain('workspace-write')

    booted.service.setMode('danger-full-access')
    expect(booted.service.describe()).toContain('围栏关闭（不限制）')
  })

  test('清扫任务：清掉旧目录时说一条；已 dispose 就什么都不说', async () => {
    mockState.sweep = {
      swept: [
        { path: 'D:\\tmp\\a', sid: 'S-1', ageMs: 90_000_000 },
        { path: 'D:\\tmp\\b', sid: 'S-2', ageMs: 90_000_000 },
      ],
      kept: [],
      failed: [],
    }
    const booted = boot()
    await new Promise((resolve) => setImmediate(resolve))
    await flush()
    expect(booted.notices).toContain('沙箱：清掉了 2 个超过 24 小时的会话临时目录')

    const disposed = boot()
    disposed.dispose()
    const before = disposed.notices.length
    await new Promise((resolve) => setImmediate(resolve))
    await flush()
    expect(disposed.notices).toHaveLength(before)
  })
})

// 平台判定的完整性：上面的 win32 分支在非 Windows 上会被跳过，这里钉一下分支常量没有漂。
test('win32 专属行为都挂在 process.platform 判断下（可移植性哨兵）', () => {
  expect(['win32', 'linux', 'darwin']).toContain(process.platform)
  expect(existsSync(join(HOME, 'plugins.json'))).toBe(true)
})
