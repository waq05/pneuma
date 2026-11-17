/**
 * sandbox 插件装配面补测（`src/packages/sandbox/index.ts`）与账本/DPAPI 边界。
 *
 * 与 `wiring-extra.spec.ts` 不重复：那边钉装配清单、设置分区主路径、后端降级与守卫主判定；
 * 这里只补它没走到的分支：
 *   - 守卫拿不到归属会话（P0-8 的 fail-closed 那条）；
 *   - 半截升权请求（`malformed`）；
 *   - read-only 档的空可写根与「可问一次」两态；
 *   - 全局强制执行 none 与某会话 workspace-write 交叉时的 effectiveEnforcement；
 *   - `/sandbox` 的空拒绝列表；
 *   - 坏账本不让卸载按钮冒出来；
 *   - setup / uninstall 的失败文案；
 *   - `account.ts` 的 BOM、EISDIR、逐字段校验；
 *   - 用假 FFI 覆盖 `protectSecret` / `unprotectSecret` 的成功、失败与空 blob。
 *
 * 会起进程/改系统的东西（受限令牌、doctor、sweep、提权 setup）整包换成假实现；
 * DSC_HOME 在动态 import 之前指进临时目录。
 *
 * @module dsc/packages/sandbox/tests/wiring-more.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-sandbox-wiring-more-'))
process.env['DSC_HOME'] = HOME

const mockState = vi.hoisted(() => ({
  setupResult: { ok: true, detail: '账号已启用' } as { ok: boolean; detail: string },
  uninstallResult: { ok: true, detail: '已清掉' } as { ok: boolean; detail: string },
  setupCalls: [] as string[],
  uninstallCalls: [] as string[],
}))

/* 受限令牌：默认不可用（apply 只会在 win32 默认档自动探测一次）。 */
vi.mock('../win/backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../win/backend.js')>()
  return {
    ...actual,
    probeWindowsToken: () => ({ available: false, detail: '测试关闭受限令牌' }),
  }
})

/* 体检：不 spawn powershell。 */
vi.mock('../win/doctor.js', () => ({
  doctorWindowsNetwork: async () => ({ tier: 'full' as const, details: ['√ 测试体检'] }),
}))

/* 清扫：不碰真实临时目录。 */
vi.mock('../win/sweep.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../win/sweep.js')>()
  return { ...actual, sweepSandboxTemps: () => ({ swept: [], kept: [], failed: [] }) }
})

/* 提权 setup：不弹 UAC；结论按用例给。 */
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
type AccountModule = typeof import('../win/account.js')

let sandboxPlugin: SandboxIndex['sandboxPlugin']
let pluginRegistry: typeof import('@pneuma/runtime/core/plugin-registry.js')
let account: AccountModule

beforeAll(async () => {
  sandboxPlugin = (await import('../index.js')).sandboxPlugin
  pluginRegistry = await import('@pneuma/runtime/core/plugin-registry.js')
  account = await import('../win/account.js')
}, 20_000)

function resetPluginsFile(): void {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(join(HOME, 'plugins.json'), `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`, 'utf8')
  rmSync(join(HOME, 'sandbox', 'setup-state.json'), { force: true })
}

beforeEach(() => {
  resetPluginsFile()
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
    // Windows 上偶尔被子进程占着：临时目录留给系统清。
  }
})

/** 等异步探测落地。 */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

/** 一个够用的假会话。 */
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
  guards: Array<{ id: string; order: number; decide: (input: Record<string, unknown>) => unknown }>
  commands: Array<{ name: string; run: (args: { ui: { notice: (text: string) => void } }) => void }>
  facts: Array<{ id: string; fn: (session?: unknown) => string }>
  notices: string[]
  events: string[]
  provided: Record<string, unknown>
  sectionOf: () => Record<string, unknown> | null
}

/** 假 ctx：只实现 apply 用到的面。 */
function fakeCtx(session: ReturnType<typeof fakeSession>, options: { approval?: boolean } = {}): Harness {
  const guards: Harness['guards'] = []
  const commands: Harness['commands'] = []
  const facts: Harness['facts'] = []
  const notices: string[] = []
  const events: string[] = []
  let section: Record<string, unknown> | null = null
  const provided: Record<string, unknown> = {}
  const noop = (): void => {}

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
        return noop
      },
    },
    effect(fn: () => unknown) {
      const off = fn()
      return typeof off === 'function' ? off : noop
    },
    prompt: {
      registerEnvFacts(id: string, fn: (value?: unknown) => string) {
        facts.push({ id, fn })
        return noop
      },
    },
    settings: {
      registerSection(value: Record<string, unknown>) {
        section = value
        return noop
      },
    },
    commands: {
      register(spec: { name: string }, run: Harness['commands'][number]['run']) {
        commands.push({ name: spec.name, run })
        return noop
      },
    },
    provide(name: string, value: unknown) {
      provided[name] = value
      return noop
    },
    on() {
      return noop
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

interface SectionLike {
  id: string
  order: number
  fields: () => Array<Record<string, unknown>>
  action: (name: string) => Promise<string | void>
  save: (key: string, value: unknown) => Promise<string | void>
}

interface Booted extends Harness {
  cwd: string
  session: ReturnType<typeof fakeSession>
  service: {
    mode: string
    enforcement: string
    describe(): string
    setMode(next: string): void
  }
  guard: Harness['guards'][number]
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

/** 真 apply，config 走 `passed`。 */
function boot(options: { config?: Record<string, unknown>; approval?: boolean } = {}): Booted {
  const cwd = mkdtempSync(join(HOME, 'work-'))
  const session = fakeSession(cwd)
  const fake = fakeCtx(session, options)
  const dispose = (sandboxPlugin.apply as unknown as (ctx: unknown, passed: unknown) => () => void)(
    fake.ctx,
    options.config ?? {},
  )
  cleanups.push(dispose)
  const service = fake.provided['sandbox'] as Booted['service']
  const guard = fake.guards.find((item) => item.id === 'sandbox')!
  const section = fake.sectionOf() as unknown as SectionLike
  return { ...fake, cwd, session, service, guard, section, dispose }
}

/** 设置分区里某个 info 字段的文本。 */
function fieldText(booted: Booted, label: string): string {
  const field = booted.section.fields().find((item) => item.label === label)
  return String(field?.text ?? '')
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

/** 写一份合法账本。 */
function writeSetupState(text: string): void {
  mkdirSync(join(HOME, 'sandbox'), { recursive: true })
  writeFileSync(join(HOME, 'sandbox', 'setup-state.json'), text, 'utf8')
}

// ── 守卫剩余分支 ─────────────────────────────────────────────────────────────

describe('守卫：归属会话与半截升权', () => {
  test('归属会话解析不到（名册没有、日志也读不回来）→ deny，不回落当前会话', async () => {
    const booted = boot()
    const verdict = booted.guard.decide(
      guardInput(booted, {
        sessionId: 'already-gone',
        sessionPath: join(HOME, 'gone', 's.jsonl'),
        target: join(HOME, 'outside', 'x.txt'),
      }),
    ) as { action: string; reason: string }

    expect(verdict.action).toBe('deny')
    expect(verdict.reason).toContain('归属的会话已经结束')
    expect(verdict.reason).toContain('判不出该按哪一档沙箱执行')
  })

  test('只给 justification 不给 sandbox_permissions：按 malformed 拒，并给出成对写法', async () => {
    const booted = boot()
    const target = join(HOME, 'outside', 'x.txt')
    const verdict = booted.guard.decide(
      guardInput(booted, {
        target,
        args: { path: target, content: 'x', justification: '这次必须写出去' },
      }),
    ) as { action: string; reason: string }

    expect(verdict.action).toBe('deny')
    expect(verdict.reason).toContain('升权参数不完整')
    expect(verdict.reason).toContain('只给了 justification 没给 sandbox_permissions')
    expect(verdict.reason).toContain('命中规则「malformed-request」')
    expect(verdict.reason).toContain('两个升权参数要么都给')
  })
})

describe('read-only 档：空可写根与可问一次', () => {
  test('没有审批插件时写盘直接 deny，理由里的可写根是「（无）」', async () => {
    const booted = boot({ config: { mode: 'read-only' } })
    expect(booted.service.mode).toBe('read-only')

    const verdict = booted.guard.decide(guardInput(booted)) as { action: string; reason: string }
    expect(verdict.action).toBe('deny')
    expect(verdict.reason).toContain('mode-read-only')
    expect(verdict.reason).toContain('可写根：（无）')

    const prompt = booted.facts.find((item) => item.id === 'sandbox')!.fn(booted.session)
    expect(prompt).toContain('可写根：（无，只读档不许写盘）')
  })

  test('审批在场时同一笔写只 defer 一次（沙箱不替审批做决定）', async () => {
    const booted = boot({ config: { mode: 'read-only' }, approval: true })
    expect(booted.guard.decide(guardInput(booted))).toEqual({ action: 'defer' })
  })
})

describe('强制执行等级的交叉口径', () => {
  test('全局 enforcement=none 但会话切回 workspace-write：实际等级报 partial', async () => {
    const booted = boot({ config: { mode: 'danger-full-access' } })
    expect(booted.service.enforcement).toBe('none')
    expect(fieldText(booted, '当前会话强制执行等级')).toBe('none —— 当前档位不设围栏')

    await booted.section.save('mode', 'workspace-write')

    expect(booted.service.mode).toBe('workspace-write')
    // 进程级后端仍停在 none（配置还是 danger），但这个会话实际有围栏。
    expect(booted.service.enforcement).toBe('partial')
    expect(fieldText(booted, '当前会话强制执行等级')).toContain('partial —— 进程内策略围栏')
  })
})

// ── 报告与设置分区补遗 ───────────────────────────────────────────────────────

describe('报告与设置分区补遗', () => {
  test('/sandbox：没有拒绝记录时写「（还没有）」；没有本会话放宽时不列该段', () => {
    const booted = boot()
    const notices: string[] = []
    booted.commands.find((item) => item.name === 'sandbox')!.run({ ui: { notice: (text) => notices.push(text) } })
    const text = notices[0]!

    expect(text).toContain('最近 3 次拒绝：')
    expect(text).toContain('（还没有）')
    expect(text).toContain('只读子路径（0）：无')
    expect(text).not.toContain('本会话放宽出来的可写根')
  })

  test('坏账本（坏 JSON）不冒卸载按钮；setup / doctor 仍在', () => {
    writeSetupState('{bad')
    const booted = boot()
    const actions = booted.section.fields().filter((item) => item.type === 'button').map((item) => item.action)

    if (process.platform === 'win32') {
      expect(actions).toContain('setup')
      expect(actions).toContain('doctor')
      expect(actions).not.toContain('uninstall')
    } else {
      expect(actions).toContain('probe')
    }
  })

  test('setup / uninstall 的失败结论来自提权结果，并带上体检结论', async () => {
    const booted = boot()
    if (process.platform !== 'win32') {
      expect(await booted.section.action('setup')).toBe('网络第二级只适用于 Windows')
      expect(await booted.section.action('uninstall')).toBe('网络第二级只适用于 Windows')
      return
    }

    mockState.setupResult = { ok: false, detail: '账号没建起来' }
    const setup = String(await booted.section.action('setup'))
    expect(setup).toContain('提权 setup 未完成')
    expect(setup).toContain('账号没建起来')
    expect(setup).toContain('体检：full —— √ 测试体检')
    expect(mockState.setupCalls).toContain(HOME)

    mockState.uninstallResult = { ok: true, detail: '已清掉账号与规则' }
    const uninstall = String(await booted.section.action('uninstall'))
    expect(uninstall).toContain('提权卸载完成')
    expect(uninstall).toContain('已清掉账号与规则')
    expect(mockState.uninstallCalls).toContain(HOME)
  })
})

// ── account.ts 账本边界 ──────────────────────────────────────────────────────

describe('readSetupState：BOM / 读失败 / 逐字段校验', () => {
  /** 一份形状合法的账本。 */
  const valid = {
    version: 1,
    account: 'dsc-sandbox-offline',
    sid: 'S-1-5-21-1',
    proxyPort: 3128,
    firewallRules: ['dsc-rule-a'],
    wfpProviderGuid: '11111111-1111-1111-1111-111111111111',
    wfpSublayerGuid: '22222222-2222-2222-2222-222222222222',
    at: '2026-11-16T00:00:00.000Z',
  }

  test('PowerShell 5.1 写出的 BOM 会被剥掉；路径是目录时给「读失败」而不是崩溃', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsc-account-bom-'))
    try {
      mkdirSync(account.sandboxDir(home), { recursive: true })
      writeFileSync(account.setupStatePath(home), `\uFEFF${JSON.stringify(valid)}`, 'utf8')
      expect(account.readSetupState(home)).toEqual({ ok: true, state: valid })

      // 把 setup-state.json 做成目录：readFileSync 抛 EISDIR（不是 ENOENT）。
      const dirHome = mkdtempSync(join(tmpdir(), 'dsc-account-dir-'))
      try {
        mkdirSync(join(account.setupStatePath(dirHome)), { recursive: true })
        const broken = account.readSetupState(dirHome)
        expect(broken).toMatchObject({ ok: false })
        if (broken !== null && !broken.ok) expect(broken.error).toContain('读 setup 状态文件失败')
      } finally {
        rmSync(dirHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test('逐字段坏值：每个都返回 ok:false 并点名是哪一栏', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsc-account-shape-'))
    try {
      mkdirSync(account.sandboxDir(home), { recursive: true })
      const cases: Array<{ name: string; value: unknown; expect: string }> = [
        { name: '顶层不是对象', value: null, expect: '顶层不是对象' },
        { name: 'version 不是整数', value: { ...valid, version: '1' }, expect: 'version 不是整数' },
        { name: 'account 不是非空字符串', value: { ...valid, account: '' }, expect: 'account 不是非空字符串' },
        { name: 'sid 不是非空字符串', value: { ...valid, sid: '' }, expect: 'sid 不是非空字符串' },
        { name: 'proxyPort 不是 0-65535 的整数', value: { ...valid, proxyPort: 70_000 }, expect: 'proxyPort 不是 0-65535 的整数' },
        { name: 'firewallRules 不是字符串数组', value: { ...valid, firewallRules: ['ok', 2] }, expect: 'firewallRules 不是字符串数组' },
        { name: 'wfpProviderGuid 不是非空字符串', value: { ...valid, wfpProviderGuid: '' }, expect: 'wfpProviderGuid 不是非空字符串' },
        { name: 'wfpSublayerGuid 不是非空字符串', value: { ...valid, wfpSublayerGuid: '' }, expect: 'wfpSublayerGuid 不是非空字符串' },
        { name: 'at 不是非空字符串', value: { ...valid, at: '' }, expect: 'at 不是非空字符串' },
        { name: 'wfpFilterCount 不是数字', value: { ...valid, wfpFilterCount: 'x' }, expect: 'wfpFilterCount 不是数字' },
      ]

      for (const one of cases) {
        writeFileSync(account.setupStatePath(home), JSON.stringify(one.value), 'utf8')
        const read = account.readSetupState(home)
        expect(read, one.name).toMatchObject({ ok: false })
        if (read !== null && !read.ok) expect(read.error, one.name).toContain(one.expect)
      }
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

// ── DPAPI：假 FFI ────────────────────────────────────────────────────────────

describe('protectSecret / unprotectSecret：假 FFI', () => {
  type BoundWin32 = Parameters<AccountModule['protectSecret']>[0]

  const crypt = {
    protectMode: 'ok' as 'ok' | 'fail' | 'empty',
    unprotectMode: 'ok' as 'ok' | 'fail',
    nextPayload: Buffer.from('secret'),
    freed: [] as number[],
    lastError: 5,
  }

  /** 假 crypt32：protect/unprotect 都是可编排的普通函数。 */
  function fakeBound(): BoundWin32 {
    const library = {
      func: (_convention: string, name: string) => {
        if (name === 'CryptProtectData') {
          return (...args: unknown[]) => {
            if (crypt.protectMode === 'fail') return 0
            const out = args[args.length - 1] as Buffer
            if (crypt.protectMode === 'empty') {
              out.writeUInt32LE(0, 0)
              out.writeBigUInt64LE(0n, 8)
              return 1
            }
            out.writeUInt32LE(crypt.nextPayload.length, 0)
            out.writeBigUInt64LE(0x2000n, 8)
            return 1
          }
        }
        return (...args: unknown[]) => {
          if (crypt.unprotectMode === 'fail') return 0
          const out = args[args.length - 1] as Buffer
          out.writeUInt32LE(crypt.nextPayload.length, 0)
          out.writeBigUInt64LE(0x3000n, 8)
          return 1
        }
      },
    }
    const koffi = {
      load: () => library,
      alloc: () => new Uint16Array(1),
      decode: () => new Uint8Array(crypt.nextPayload),
      address: () => 0x1000n,
      errno: () => 0,
    }
    return {
      koffi,
      localFree: (pointer: number) => {
        crypt.freed.push(Number(pointer))
        return 0
      },
      getLastLastError: () => crypt.lastError,
      formatMessageW: () => 0,
    } as unknown as BoundWin32
  }

  beforeEach(() => {
    crypt.protectMode = 'ok'
    crypt.unprotectMode = 'ok'
    crypt.nextPayload = Buffer.from('secret')
    crypt.freed.length = 0
    crypt.lastError = 5
  })

  test('protect 成功：16 字节 DATA_BLOB 入参（cbData + 指针），出参读完 LocalFree', () => {
    const result = account.protectSecret(fakeBound(), 'pw')
    expect(result.toString('utf8')).toBe('secret')
    expect(crypt.freed).toEqual([0x2000])
  })

  test('protect 返回 0 / 报成功但空 blob：分别抛系统错误与「空 blob」', () => {
    crypt.protectMode = 'fail'
    expect(() => account.protectSecret(fakeBound(), 'pw')).toThrow(/CryptProtectData 失败（Win32 错误码 5）/)

    crypt.protectMode = 'empty'
    expect(() => account.protectSecret(fakeBound(), 'pw')).toThrow(/报成功但给出空 blob/)
  })

  test('unprotect 成功回 utf8；空密文在碰 FFI 之前就被拒', () => {
    crypt.nextPayload = Buffer.from('hunter2')
    expect(account.unprotectSecret(fakeBound(), Buffer.from([1, 2, 3]))).toBe('hunter2')
    expect(crypt.freed).toEqual([0x3000])

    expect(() => account.unprotectSecret(fakeBound(), Buffer.alloc(0))).toThrow(/拒绝空密文/)
  })
})
