/**
 * `sandbox/index.ts` 的**残部分支**补测（现有 wiring-extra / wiring-more / plugin-wiring
 * 已覆盖主干，这里只补覆盖率报告里还标红的分支），外加 `win/account.ts` 的两条 DPAPI 残部分支。
 *
 * 覆盖点（按源码行号）：
 *   - 263       拒绝文案里 `网络：开` 的那一支；
 *   - 344       risk 既不是 read/write/exec 时的 PASS 兜底；
 *   - 440/441   提示段里的只读子路径列表与网络开；
 *   - 447/552   显式选受限令牌（非自动档）时的提示与后端说明；
 *   - 457       配置有问题时提示段的 ⚠ 行；
 *   - 525/532   受限令牌 read-only 模式；grantCacheRoots=false 不并入缓存根；
 *   - 538       onDetail 在 dispose 之后被调用时静默；
 *   - 630/676   自动启用的受限令牌在「挂载行」与 `/sandbox` 报告里的说法；
 *   - 642-646   非 Windows 时网络第二级体检直接给「不适用」；
 *   - 653       体检抛的是非 Error（字符串）时 String(error) 兜底；
 *   - 680-684   只读档的空可写根、只读子路径、网络开；
 *   - 692/817   非 Windows 的报告与设置分区不出现 win32 控件；
 *   - 807       设置分区里的拒绝记录；
 *   - 937/949/952  save 收到非字符串值（String(value) 分支）；
 *   - 1009/1016 非 Windows 上 setup / uninstall 直接回「只适用于 Windows」；
 *   - 1045/1049 /file-review 的「关着」与「最近预览」；
 *   - 1206      后端探测失败时插件已经 dispose：不再往会话流写兜底说明。
 *
 * 运行期后端仍整包替换成假实现（不探测 docker、不提权、不起子进程），DSC_HOME 在
 * 任何 import 之前指进临时目录。
 *
 * @module dsc/packages/sandbox/tests/index-branches.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync , realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { Win32Error } from '../win/ffi.js'
import type { BoundWin32 } from '../win/ffi.js'
import { unprotectSecret } from '../win/account.js'

const HOME = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsc-sandbox-index-branches-')))
process.env['DSC_HOME'] = HOME

/** 可编排的假后端状态（vi.mock 工厂在 import 前跑，只能用 vi.hoisted 的共享对象）。 */
const mockState = vi.hoisted(() => ({
  probeToken: { available: false, detail: 'runner 入口没有构建产物：找不到 runner-entry.js' },
  /** null / 'error' / 'string'：探测抛什么。 */
  throwProbe: null as null | 'error' | 'string',
  tokenOptions: null as Record<string, unknown> | null,
  tokenDispose: 0,
  networkEnforced: false,
  probeDockerFixed: { available: false, detail: 'docker 不在 PATH' },
  sweep: { swept: [] as unknown[], kept: [] as string[], failed: [] as unknown[] },
  doctor: { tier: 'partial' as 'full' | 'partial', details: ['× 没有 setup-state.json'] },
  /** null / 'error' / 'string'：doctor 抛什么。 */
  doctorThrows: null as null | 'error' | 'string',
  setupResult: { ok: true, detail: '账号已启用' },
  uninstallResult: { ok: true, detail: '已清掉' },
}))

vi.mock('../backends.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backends.js')>()
  return { ...actual, probeDocker: async () => mockState.probeDockerFixed }
})

vi.mock('../win/backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../win/backend.js')>()
  return {
    ...actual,
    probeWindowsToken: () => {
      if (mockState.throwProbe === 'error') throw new Error('探测自身崩了')
      if (mockState.throwProbe === 'string') throw '探测抛了个字符串'
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
    if (mockState.doctorThrows === 'error') throw new Error('doctor 崩了')
    if (mockState.doctorThrows === 'string') throw 'doctor 抛了个字符串'
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
    runSetupElevated: async () => mockState.setupResult,
    runUninstallElevated: async () => mockState.uninstallResult,
  }
})

type SandboxIndex = typeof import('../index.js')
let sandboxPlugin: SandboxIndex['sandboxPlugin']
let pluginRegistry: typeof import('@pneuma/runtime/core/plugin-registry.js')

beforeAll(async () => {
  sandboxPlugin = (await import('../index.js')).sandboxPlugin
  pluginRegistry = await import('@pneuma/runtime/core/plugin-registry.js')
}, 20_000)

beforeEach(() => {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(join(HOME, 'plugins.json'), `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`, 'utf8')
  rmSync(join(HOME, 'sandbox', 'setup-state.json'), { force: true })
  mockState.probeToken = { available: false, detail: 'runner 入口没有构建产物：找不到 runner-entry.js' }
  mockState.throwProbe = null
  mockState.tokenOptions = null
  mockState.tokenDispose = 0
  mockState.networkEnforced = false
  mockState.probeDockerFixed = { available: false, detail: 'docker 不在 PATH' }
  mockState.sweep = { swept: [], kept: [], failed: [] }
  mockState.doctor = { tier: 'partial', details: ['× 没有 setup-state.json'] }
  mockState.doctorThrows = null
  mockState.setupResult = { ok: true, detail: '账号已启用' }
  mockState.uninstallResult = { ok: true, detail: '已清掉' }
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch {
    // Windows 上偶尔被占着：留给系统清
  }
})

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

/** 临时改 `process.platform`（用完恢复原属性描述符）。 */
async function withPlatform(value: string, run: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...descriptor, value })
  try {
    await run()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

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
  sectionOf: () => Record<string, unknown> | null
  provided: Record<string, unknown>
}

function fakeCtx(session: ReturnType<typeof fakeSession>, approval = false): Harness {
  const guards: Harness['guards'] = []
  const commands: Harness['commands'] = []
  const facts: Harness['facts'] = []
  const notices: string[] = []
  const events: string[] = []
  let section: Record<string, unknown> | null = null
  const provided: Record<string, unknown> = {}
  const noop = () => () => {}

  const ctx = {
    session: { current: () => session },
    get(name: string) {
      if (name === 'agent') {
        return {
          sessionById: (id: string) => (id === 's1' ? session : undefined),
          sessionFor: (path: string) => (path === session.filePath ? session : undefined),
        }
      }
      if (name === 'approval') return approval ? {} : undefined
      return undefined
    },
    guards: {
      register(guard: Harness['guards'][number]) {
        guards.push(guard)
        return noop()
      },
    },
    effect(fn: () => unknown) {
      return fn()
    },
    prompt: {
      registerEnvFacts(id: string, fn: (value?: unknown) => string) {
        facts.push({ id, fn })
        return noop()
      },
    },
    settings: {
      registerSection(value: Record<string, unknown>) {
        section = value
        return noop()
      },
    },
    commands: {
      register(spec: { name: string }, run: (args: unknown) => unknown) {
        commands.push({ name: spec.name, run })
        return noop()
      },
    },
    provide(name: string, value: unknown) {
      provided[name] = value
      return noop()
    },
    on() {
      return noop()
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
  return { ctx, guards, commands, facts, notices, events, sectionOf: () => section, provided }
}

interface SectionLike {
  fields: () => Array<Record<string, unknown>>
  values: () => Record<string, unknown>
  save: (key: string, value: unknown) => Promise<string | void>
  action: (name: string) => Promise<string | void>
}

interface Booted extends Harness {
  cwd: string
  session: ReturnType<typeof fakeSession>
  guard: { id: string; order: number; decide: (input: unknown) => unknown }
  section: SectionLike
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

function boot(options: {
  config?: Record<string, unknown> | ((cwd: string) => Record<string, unknown>)
  approval?: boolean
} = {}): Booted {
  const cwd = mkdtempSync(join(HOME, 'work-'))
  const config = typeof options.config === 'function' ? options.config(cwd) : (options.config ?? {})
  const session = fakeSession(cwd)
  const fake = fakeCtx(session, options.approval === true)
  const dispose = (sandboxPlugin.apply as unknown as (ctx: unknown, passed: unknown) => () => void)(fake.ctx, config)
  cleanups.push(dispose)
  return {
    ...fake,
    cwd,
    session,
    guard: fake.guards.find((item) => item.id === 'sandbox')!,
    section: fake.sectionOf() as unknown as SectionLike,
    dispose,
  }
}

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

/** 跑一条已注册命令，收集它发给 ui.notice 的文本。 */
function runCommand(booted: Booted, name: string): string {
  const command = booted.commands.find((item) => item.name === name)!
  const output: string[] = []
  command.run({ ui: { notice: (text: string) => output.push(text) } })
  return output.join('\n')
}

function fieldText(booted: Booted, predicate: (field: Record<string, unknown>) => boolean): string {
  const field = booted.section.fields().find((item) => predicate(item))
  return String(field?.text ?? '')
}

describe('守卫与提示段的残部分支', () => {
  test('只读档拒绝文案里的「网络：开」取自配置（不是写死的）', () => {
    const booted = boot({ config: { mode: 'read-only', networkAccess: true } })
    const decision = booted.guard.decide(guardInput(booted)) as { action: string; reason: string }

    expect(decision.action).toBe('deny')
    expect(decision.reason).toContain('网络：开')
    expect(decision.reason).toContain('命中规则「mode-read-only」')
  })

  test('risk 不在 read/write/exec 三种里：不判（PASS → defer）', () => {
    const booted = boot()
    const decision = booted.guard.decide(
      guardInput(booted, { risk: 'network' as never, args: {}, target: undefined }),
    )
    expect(decision).toEqual({ action: 'defer' })
  })

  test('提示段：只读子路径逐条列出；网络开时说「开」', () => {
    const booted = boot({
      config: (cwd) => ({
        networkAccess: true,
        readOnlySubpaths: [join(cwd, 'generated'), join(cwd, 'dist')],
      }),
    })
    const text = booted.facts[0]!.fn(booted.session)

    expect(text).toContain(join(booted.cwd, 'generated'))
    expect(text).toContain(join(booted.cwd, 'dist'))
    expect(text).toContain('网络：开')
  })

  test('提示段：配置有问题时追加 ⚠ 一行（坏档位/坏开关都进 problems）', () => {
    const booted = boot({ config: { mode: 'bogus', networkAccess: 'yes' } })
    const text = booted.facts[0]!.fn(booted.session)

    expect(text).toContain('⚠ 沙箱配置有问题（已按默认值兜底）')
    expect(text).toContain('档位只能是')
    expect(text).toContain('网络开关要 true/false')
  })

  test('显式选受限令牌（非自动档）+ read-only + 不授缓存根：入参与说明都按显式档走', () => {
    mockState.probeToken = { available: true, detail: 'runner 入口在位' }
    const booted = boot({
      config: {
        backend: 'windows-token',
        mode: 'read-only',
        grantCacheRoots: false,
        extraWritableRoots: ['C:\\extra'],
      },
    })

    // 525：受限令牌后端按配置的 read-only 构造；532：grantCacheRoots=false 不并入缓存根
    expect(mockState.tokenOptions).toMatchObject({ mode: 'read-only' })
    expect(mockState.tokenOptions!.extraRoots).toEqual(['C:\\extra'])

    // 447：显式档不写「自动启用」；552：backendDetail 用 baseDetail
    const prompt = booted.facts[0]!.fn(booted.session)
    expect(prompt).toContain('当前后端是 Windows 受限令牌：')
    expect(prompt).not.toContain('自动启用')
    const status = fieldText(booted, (field) => String(field.text ?? '').startsWith('Windows 受限令牌：'))
    expect(status).toContain('命令内部越界写被系统层拦截')
    expect(status).not.toContain('已自动启用')
  })

  test('onDetail 在 dispose 前写会话流，dispose 之后静默（538 的 else 支）', () => {
    mockState.probeToken = { available: true, detail: 'runner 入口在位' }
    const booted = boot({ config: { backend: 'windows-token' } })
    const onDetail = mockState.tokenOptions!.onDetail as (message: string) => void

    const before = booted.notices.length
    onDetail('已授权 2 个可写根')
    expect(booted.notices.length).toBe(before + 1)
    expect(booted.notices.at(-1)).toContain('已授权 2 个可写根')

    booted.dispose()
    const afterDispose = booted.notices.length
    onDetail('dispose 之后不该写')
    expect(booted.notices.length).toBe(afterDispose)
  })

  test('自动启用的受限令牌 + partial：挂载行与 /sandbox 报告都说「已自动启用」', async () => {
    // 「默认档 + win32」才会自动启用受限令牌（index.ts 的 needsTokenProbe）：临时当 win32 验上报文案。
    await withPlatform('win32', async () => {
      mockState.probeToken = { available: true, detail: 'runner 入口在位' }
      mockState.networkEnforced = false
      const booted = boot()
      await flush()

      // 630：mountLine 里 backendAuto 为 true 的那一支
      expect(booted.notices.some((line) => line.includes('已自动启用系统级隔离（可在设置里改回策略围栏），越界写被系统层拦截'))).toBe(true)

      // 676：report 把实际生效后端写在配置值前面（实际是 windows-token，配置里仍是 policy）
      const report = runCommand(booted, 'sandbox')
      expect(report).toContain(
        'windows-token（已自动启用系统级隔离，可在设置里改回策略围栏；配置里的 backend 仍是 policy）',
      )
    })
  })
})

describe('/sandbox 报告与设置分区的残部分支', () => {
  test('只读档：可写根写「（无…）」、只读子路径逐条列、网络开', () => {
    const booted = boot({
      config: { mode: 'read-only', networkAccess: true, readOnlySubpaths: ['C:\\gen'] },
    })
    const report = runCommand(booted, 'sandbox')

    expect(report).toContain('（无：只读档不许写盘）')
    expect(report).toContain('C:\\gen')
    expect(report).toContain('网络：开')
  })

  test('设置分区「最近 3 次拒绝」：被拒之后列出工具、规则与原因', () => {
    const booted = boot()
    const decision = booted.guard.decide(
      guardInput(booted, {
        target: join(tmpdir(), 'outside-sandbox', 'x.txt'),
        args: { path: join(tmpdir(), 'outside-sandbox', 'x.txt'), content: 'x' },
      }),
    ) as { action: string }
    expect(decision.action).toBe('deny')

    const text = fieldText(booted, (field) => field.label === '最近 3 次拒绝')
    expect(text).toContain('outside-writable-roots')
    expect(text).toContain('write')
  })

  test('非 Windows：不体检网络第二级、不出现 win32 控件、setup/uninstall 直接回「只适用于 Windows」', async () => {
    await withPlatform('linux', async () => {
      const booted = boot()
      await flush()

      // 642-646：直接给「不适用」，不调 doctor（假 doctor 会被记成 partial 明细）
      const tierText = fieldText(booted, (field) => field.label === '网络第二级（提权布防）')
      expect(tierText).toBe('')

      // 817：没有 setup / uninstall / doctor 三个按钮
      const actions = booted.section.fields().map((field) => field.action).filter(Boolean)
      expect(actions).not.toContain('setup')
      expect(actions).not.toContain('uninstall')
      expect(actions).not.toContain('doctor')

      // 692：报告里不出现网络第二级那一行
      expect(runCommand(booted, 'sandbox')).not.toContain('网络第二级')

      // 1009 / 1016：平台闸
      expect(await booted.section.action('setup')).toContain('只适用于 Windows')
      expect(await booted.section.action('uninstall')).toContain('只适用于 Windows')
    })
  })

  test('体检抛的是字符串（非 Error）：明细里用 String(error) 兜底', async () => {
    // 网络第二级体检只在 win32 上真的跑（index.ts 的 refreshNetworkTier 非 win32 直接给「不适用」），
    // 临时当 win32 验得到 catch 里 String(error) 那条兜底。
    await withPlatform('win32', async () => {
      mockState.doctorThrows = 'string'
      const booted = boot()
      await flush()

      const text = fieldText(booted, (field) => field.label === '网络第二级（提权布防）')
      expect(text).toContain('体检失败：doctor 抛了个字符串')
    })
  })

  test('save 收到非字符串值：String(value) 分支照样落盘', async () => {
    const booted = boot()

    await booted.section.save('networkAllowlist', 123)
    await booted.section.save('extraWritableRoots', 7)
    await booted.section.save('readOnlySubpaths', 8)

    const stored = pluginRegistry.getPluginConfig('sandbox')
    expect(stored['readOnlySubpaths']).toEqual(['8'])
    expect(stored['extraWritableRoots']).toEqual(['7'])
  })
})

describe('/file-review 与收尾时序', () => {
  test('预览关着时说「关着」；有历史预览时列出最近几条', () => {
    const disabled = boot({ config: { enabled: false } })
    expect(runCommand(disabled, 'file-review')).toContain('关着')

    const booted = boot()
    const reviewGuard = booted.guards.find((item) => item.id === 'file-review')!
    reviewGuard.decide(
      guardInput(booted, {
        toolName: 'write',
        args: { path: join(booted.cwd, 'new.txt'), content: 'a\nb\n' },
        target: join(booted.cwd, 'new.txt'),
      }),
    )
    const text = runCommand(booted, 'file-review')
    expect(text).toContain('开着')
    expect(text).toContain('最近预览：')
    expect(text).toContain('新建')
  })

  test('后端探测失败时插件已经 dispose：不再往会话流写兜底说明', async () => {
    mockState.throwProbe = 'error'
    const booted = boot()
    booted.dispose()
    await flush()

    expect(booted.notices.some((line) => line.includes('沙箱后端探测失败'))).toBe(false)
  })
})

/**
 * DPAPI 残部分支（`win/account.ts`）。
 *
 * crypt32 的绑定在模块里缓存，所以整份测试共用同一个假世界；每个用例只改 knobs。
 */
function makeCryptWorld() {
  const heap = new Map<number, Buffer>()
  const addresses = new WeakMap<object, number>()
  const freed: number[] = []
  let nextAddress = 0x20_0000
  let nextBlob = 0x55_0000

  const knobs = {
    fail: false,
    lastError: 13,
    text: 's3cret',
    /** true = decode 返回 ArrayBuffer（验 account.ts 的 `new Uint8Array(decoded)` 支）。 */
    asArrayBuffer: false,
  }

  const alloc = (type: string, count: number) =>
    type === 'uint8' ? Buffer.alloc(count) : Buffer.alloc(count * (type === 'uint16' ? 2 : 1))
  const address = (value: unknown) => {
    if (typeof value === 'number') return BigInt(value)
    const key = value as object
    let found = addresses.get(key)
    if (found === undefined) {
      found = nextAddress
      nextAddress += 0x1000
      addresses.set(key, found)
      heap.set(found, value as Buffer)
    }
    return BigInt(found)
  }
  const decode = (value: unknown, type: string, count?: number) => {
    if (type !== 'uint8') return 0
    const wanted = count ?? 0
    if (typeof value === 'number') {
      const bytes = heap.get(value) ?? Buffer.alloc(wanted)
      if (knobs.asArrayBuffer) {
        const slice = bytes.subarray(0, wanted)
        return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
      }
      return bytes.subarray(0, wanted)
    }
    return Buffer.isBuffer(value) ? value.subarray(0, wanted) : Buffer.alloc(wanted)
  }

  const unprotect = (
    _input: unknown,
    _description: unknown,
    _entropy: unknown,
    _reserved: unknown,
    _prompt: unknown,
    _flags: number,
    output: Buffer,
  ) => {
    if (knobs.fail) return 0
    const bytes = Buffer.from(knobs.text, 'utf8')
    const pointer = nextBlob
    nextBlob += 0x1000
    heap.set(pointer, bytes)
    output.writeUInt32LE(bytes.length, 0)
    output.writeBigUInt64LE(BigInt(pointer), 8)
    return 1
  }

  const crypt32 = {
    func: (_convention: string, name: string) => (name === 'CryptUnprotectData' ? unprotect : () => 1),
  }
  const koffi = {
    load: () => crypt32,
    alloc,
    decode,
    address,
    errno: () => 0,
  }
  const bound = {
    koffi,
    getLastLastError: () => knobs.lastError,
    formatMessageW: () => 0,
    localFree: (pointer: number) => {
      freed.push(pointer)
      return 0
    },
  } as unknown as BoundWin32

  return { bound, knobs, freed }
}

const crypt = makeCryptWorld()

describe('win/account.ts 的 DPAPI 残部分支', () => {
  test('crypt32.dll 绑不上：抛带「DPAPI 不可用」的明确错误（不缓存坏绑定）', () => {
    // 这个用例必须排在最前面：crypt32 的绑定在模块里缓存，先让它失败一次。
    const broken = {
      koffi: { load: () => { throw new Error('crypt32.dll 不在') } },
    } as unknown as BoundWin32

    let caught: unknown
    try {
      unprotectSecret(broken, Buffer.from('cipher'))
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).toContain('crypt32.dll 绑定失败（DPAPI 不可用）')
    expect((caught as Error).message).toContain('crypt32.dll 不在')
  })

  test('CryptUnprotectData 返回 0 → 抛 Win32Error，且不释放出参', () => {
    crypt.knobs.fail = true
    crypt.freed.length = 0

    let caught: unknown
    try {
      unprotectSecret(crypt.bound, Buffer.from('cipher'))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect(caught).toMatchObject({ api: 'CryptUnprotectData', win32Code: 13 })
    expect(crypt.freed).toEqual([])
  })

  test('decode 给的是 ArrayBuffer（不是 Uint8Array）时也按字节读出明文，并 LocalFree', () => {
    crypt.knobs.fail = false
    crypt.knobs.asArrayBuffer = true
    crypt.knobs.text = 'p@ss-中文'
    crypt.freed.length = 0

    expect(unprotectSecret(crypt.bound, Buffer.from('cipher'))).toBe('p@ss-中文')
    expect(crypt.freed).toHaveLength(1)
    expect(crypt.freed[0]).toBeGreaterThan(0)
  })
})
