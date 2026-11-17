/**
 * 二级网络管控体检（`src/packages/sandbox/win/doctor.ts`）：六项逐条查的分支与容错。
 *
 * 这里**不碰真 FFI、不起真 PowerShell、不改系统**：
 *   - `./ffi.js` 换成可编排的假底座（`tryLoadFfi` / `bindAll`）；
 *   - `./account.js` 只换 `readSetupState` 与 `unprotectSecret`，路径口径仍用真的；
 *   - `./wfp.js` 的探测结论可控；
 *   - `node:child_process` 的 `spawn` 换成按顺序兑现的假子进程（Get-LocalUser / Get-NetFirewallRule）。
 *
 * 每条用例自己决定 ③ 账号探测与 ⑤ 防火墙探测返回什么；断言只看医生给出的
 * `tier` 与中文明细（那才是用户看到的东西）。
 *
 * @module dsc/packages/sandbox/win/doctor.spec
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'

/** 假子进程的行为脚本：close = 正常/带退出码结束，error = spawn 本身失败。 */
interface SpawnBehavior {
  kind: 'close' | 'error'
  code?: number
  stdout?: string
  stderr?: string
  message?: string
}

/** `vi.mock` 工厂在 import 之前跑，只能用 `vi.hoisted` 的共享状态。 */
const m = vi.hoisted(() => ({
  ffiOk: true,
  ffiWhy: 'koffi 缺失',
  state: null as unknown,
  unprotectResult: 'secret',
  unprotectError: null as string | null,
  rules: ['dsc-rule-a', 'dsc-rule-b', 'dsc-rule-c', 'dsc-rule-d', 'dsc-rule-e'],
  wfp: { present: true, detail: '查到持久子层' },
  wfpError: null as string | null,
  behaviors: [] as SpawnBehavior[],
  calls: [] as Array<{ file: string; args: string[] }>,
}))

/* PowerShell 换成假子进程：按用例排好的顺序兑现，不真跑 cmdlet。 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (file: string, args: string[]) => {
      const behavior = m.behaviors.shift() ?? { kind: 'close', code: 0, stdout: '' }
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill: () => boolean
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => true
      m.calls.push({ file, args })
      if (behavior.kind === 'close') {
        setTimeout(() => {
          if (behavior.stdout !== undefined) child.stdout.write(behavior.stdout)
          if (behavior.stderr !== undefined) child.stderr.write(behavior.stderr)
          setTimeout(() => {
            child.stdout.end()
            child.stderr.end()
            child.emit('close', behavior.code ?? 0)
          }, 2)
        }, 1)
      } else {
        setTimeout(() => child.emit('error', new Error(behavior.message ?? 'spawn 失败')), 1)
      }
      return child as unknown as import('node:child_process').ChildProcess
    },
  }
})

/* FFI 底座：只保留 doctor 用到的两个入口（tryLoadFfi / bindAll）。 */
vi.mock('./ffi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ffi.js')>()
  const fakeKoffi = {
    load: () => ({ func: () => () => 0 }),
    alloc: () => new Uint16Array(1),
    decode: () => new Uint8Array(0),
    address: () => 0n,
    errno: () => 0,
  }
  const bound = {
    koffi: fakeKoffi,
    localFree: () => 0,
    getLastLastError: () => 0,
    formatMessageW: () => 0,
  }
  return {
    ...actual,
    tryLoadFfi: () =>
      (m.ffiOk
        ? { ok: true, ffi: { koffi: fakeKoffi, k32: {}, adv: {} } }
        : { ok: false, why: m.ffiWhy }) as unknown as ReturnType<typeof actual.tryLoadFfi>,
    bindAll: () => bound as unknown as ReturnType<typeof actual.bindAll>,
  }
})

/* 账本与 DPAPI：结论可控；`accountBlobPath` 等路径函数保持真的。 */
vi.mock('./account.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./account.js')>()
  return {
    ...actual,
    readSetupState: () => m.state as ReturnType<typeof actual.readSetupState>,
    unprotectSecret: () => {
      if (m.unprotectError !== null) throw new Error(m.unprotectError)
      return m.unprotectResult
    },
  }
})

/* 防火墙规则名固定成 5 条，方便按条断言「缺几条 / 作用域对不对」。 */
vi.mock('./net-abi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./net-abi.js')>()
  return { ...actual, firewallRuleNames: () => m.rules }
})

/* WFP 探测结论可控（要不要抛也由用例决定）。 */
vi.mock('./wfp.js', () => ({
  probeWfpSublayer: () => {
    if (m.wfpError !== null) throw new Error(m.wfpError)
    return m.wfp
  },
}))

import { doctorWindowsNetwork } from './doctor.js'
import { accountBlobPath } from './account.js'

const dirs: string[] = []

beforeEach(() => {
  m.ffiOk = true
  m.ffiWhy = 'koffi 缺失'
  m.unprotectResult = 'secret'
  m.unprotectError = null
  m.wfp = { present: true, detail: '查到持久子层' }
  m.wfpError = null
  m.behaviors.length = 0
  m.calls.length = 0
  m.state = {
    ok: true,
    state: {
      version: 1,
      account: 'dsc-sandbox-offline',
      sid: 'S-1-5-21-100-200-300-400',
      proxyPort: 3128,
      firewallRules: ['dsc-rule-a'],
      wfpProviderGuid: '11111111-2222-3333-4444-555555555555',
      wfpSublayerGuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      at: '2026-11-16T00:00:00.000Z',
    },
  }
})

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } catch {
      // Windows 上偶尔被扫描进程占着：临时目录留给系统清。
    }
  }
})

/** 一个干净的 dscHome。 */
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-doctor-spec-'))
  dirs.push(dir)
  return dir
}

/** 写一份能让 ④ 通过的 account.bin（内容无所谓，unprotectSecret 已被替换）。 */
function writeBlob(home: string): void {
  mkdirSync(join(home, 'sandbox'), { recursive: true })
  writeFileSync(accountBlobPath(home), Buffer.from([1, 2, 3, 4]))
}

/** 排一个正常退出的假 PowerShell。 */
function close(stdout = '', code = 0, stderr = ''): void {
  m.behaviors.push({ kind: 'close', code, stdout, stderr })
}

/** 排一个 spawn 失败的假 PowerShell。 */
function spawnError(message: string): void {
  m.behaviors.push({ kind: 'error', message })
}

/** 排「账号探测」的返回。 */
function queueAccount(payload: Record<string, unknown>): void {
  close(JSON.stringify(payload))
}

/** 排「防火墙探测」的返回：每个规则名一行 `名字||作用域`。 */
function queueFirewall(lines: readonly string[]): void {
  close(lines.join('\n'))
}

/** 一条与账本 SID 对上的防火墙输出。 */
function greenFirewall(): string[] {
  return m.rules.map((name) => `${name}||S-1-5-21-100-200-300-400`)
}

describe('doctorWindowsNetwork：六项全绿', () => {
  test('FFI、账本、账号、DPAPI、5 条防火墙、WFP 都通过 → full，明细逐项打 √', async () => {
    const home = tempHome()
    writeBlob(home)
    queueAccount({ exists: true, enabled: true, sid: 'S-1-5-21-100-200-300-400' })
    queueFirewall(greenFirewall())

    const result = await doctorWindowsNetwork(home)
    const text = result.details.join('\n')

    expect(result.tier).toBe('full')
    expect(text).toContain('√ koffi/Win32 FFI 底座可用')
    expect(text).toContain('√ setup-state.json 在：账号 dsc-sandbox-offline（S-1-5-21-100-200-300-400），代理端口 3128')
    expect(text).toContain('√ 本地账号 dsc-sandbox-offline 存在且已启用（SID S-1-5-21-100-200-300-400）')
    expect(text).toContain('√ account.bin 可用 DPAPI 解开（明文 6 个字符')
    expect(text).toContain('√ 5 条防火墙规则都在，且作用域都限定在账号 dsc-sandbox-offline')
    expect(text).toContain('√ WFP 子层探测：查到持久子层')

    // 两条 cmdlet 各起了一次 powershell，且命令文本对得上。
    expect(m.calls).toHaveLength(2)
    expect(m.calls[0]!.file).toContain('powershell.exe')
    expect(m.calls[0]!.args.join(' ')).toContain('Get-LocalUser')
    expect(m.calls[1]!.args.join(' ')).toContain('Get-NetFirewallRule')
  })
})

describe('doctorWindowsNetwork：缺项与坏账本', () => {
  test('没账本、没账号、没 account.bin、防火墙缺 5 条 → partial，WFP 只作提示', async () => {
    const home = tempHome()
    m.state = null
    m.wfp = { present: false, detail: '未查到子层' }
    queueAccount({ exists: false })
    queueFirewall([])

    const result = await doctorWindowsNetwork(home)
    const text = result.details.join('\n')

    expect(result.tier).toBe('partial')
    expect(text).toContain('× 没有 setup-state.json：二级网络管控还没成功 setup 过一次')
    expect(text).toContain('× 本地账号 dsc-sandbox-offline 不存在')
    expect(text).toContain('× 没有 account.bin')
    expect(text).toContain('× 防火墙规则缺 5 条')
    expect(text).toContain('· WFP 子层探测（提示项，不计入结论）')
  })

  test('WFP 查不到但其余全绿 → 仍是 full（提示项不拉低 tier）', async () => {
    const home = tempHome()
    writeBlob(home)
    m.wfp = { present: false, detail: '非提权会话看不到 WFP 对象' }
    queueAccount({ exists: true, enabled: true, sid: 'S-1-5-21-100-200-300-400' })
    queueFirewall(greenFirewall())

    const result = await doctorWindowsNetwork(home)

    expect(result.tier).toBe('full')
    expect(result.details.join('\n')).toContain('· WFP 子层探测（提示项，不计入结论）：非提权会话看不到 WFP 对象')
  })

  test('账本字段不对：明细带原因；账号 SID 未知、防火墙作用域读不出 → 按没核对处理', async () => {
    const home = tempHome()
    writeBlob(home)
    m.state = { ok: false, error: 'setup 状态文件字段不对（setup-state.json）：sid 不是非空字符串' }
    queueAccount({ exists: true, enabled: true, sid: 'S-1-5-21-9' })
    // 只有规则名、没有 `||作用域` 的行：found 有、scopes 空。
    queueFirewall(m.rules)

    const result = await doctorWindowsNetwork(home)
    const text = result.details.join('\n')

    expect(result.tier).toBe('partial')
    expect(text).toContain('× setup 状态文件字段不对')
    expect(text).toContain('√ 本地账号 dsc-sandbox-offline 存在且已启用（SID S-1-5-21-9）')
    expect(text).toContain('√ 5 条防火墙规则都在（作用域没读出来，没有核对 LocalUserAuthorizedList）')
  })
})

describe('doctorWindowsNetwork：账号探测分支', () => {
  test('账号存在但禁用 → 明细点名「禁用态」', async () => {
    const home = tempHome()
    writeBlob(home)
    queueAccount({ exists: true, enabled: false, sid: 'S-1-5-21-100-200-300-400' })
    queueFirewall(greenFirewall())

    const result = await doctorWindowsNetwork(home)

    expect(result.tier).toBe('partial')
    expect(result.details.join('\n')).toContain('× 本地账号 dsc-sandbox-offline 存在但处于禁用态')
  })

  test('账号 SID 与账本不一致 → 明细说「账本是旧的，请重跑 setup」', async () => {
    const home = tempHome()
    writeBlob(home)
    m.state = {
      ok: true,
      state: {
        version: 1,
        account: 'dsc-sandbox-offline',
        sid: 'S-1-5-21-OLD',
        proxyPort: 3128,
        firewallRules: ['dsc-rule-a'],
        wfpProviderGuid: '11111111-2222-3333-4444-555555555555',
        wfpSublayerGuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        at: '2026-11-16T00:00:00.000Z',
      },
    }
    queueAccount({ exists: true, enabled: true, sid: 'S-1-5-21-NEW' })
    queueFirewall(greenFirewall())

    const result = await doctorWindowsNetwork(home)

    expect(result.tier).toBe('partial')
    expect(result.details.join('\n')).toContain('与账本里的（S-1-5-21-OLD）不一致')
    expect(result.details.join('\n')).toContain('账本是旧的，请重跑 setup')
  })

  test('powershell 非零退出 / 输出不是 JSON：两种探测失败都变成 × 明细', async () => {
    const home = tempHome()
    writeBlob(home)

    // 第一次：非零退出、stdout 为空。
    close('', 1, '拒绝访问')
    queueFirewall(greenFirewall())
    const first = await doctorWindowsNetwork(home)
    expect(first.tier).toBe('partial')
    expect(first.details.join('\n')).toContain('× 查本地账号 dsc-sandbox-offline 失败：powershell 退出码 1：拒绝访问')

    // 第二次：退出码 0 但输出无法解析。
    close('not-json')
    queueFirewall(greenFirewall())
    const second = await doctorWindowsNetwork(home)
    expect(second.tier).toBe('partial')
    expect(second.details.join('\n')).toContain('× 查本地账号 dsc-sandbox-offline 失败：解析 Get-LocalUser 输出失败')
  })

  test('spawn 自身失败（error 事件）→ 明细里带原始错误', async () => {
    const home = tempHome()
    writeBlob(home)
    spawnError('找不到 powershell.exe')
    queueFirewall(greenFirewall())

    const result = await doctorWindowsNetwork(home)

    expect(result.tier).toBe('partial')
    expect(result.details.join('\n')).toContain('× 查本地账号 dsc-sandbox-offline 失败：powershell 退出码 -1：找不到 powershell.exe')
  })
})

describe('doctorWindowsNetwork：防火墙与 FFI/DPAPI 容错', () => {
  test('防火墙缺 3 条 → 点名缺哪几条', async () => {
    const home = tempHome()
    writeBlob(home)
    queueAccount({ exists: true, enabled: true, sid: 'S-1-5-21-100-200-300-400' })
    queueFirewall(greenFirewall().slice(0, 2))

    const result = await doctorWindowsNetwork(home)

    expect(result.tier).toBe('partial')
    const text = result.details.join('\n')
    expect(text).toContain('× 防火墙规则缺 3 条：dsc-rule-c、dsc-rule-d、dsc-rule-e')
  })

  test('防火墙规则在但作用域是别的账号 → 判作用域不对', async () => {
    const home = tempHome()
    writeBlob(home)
    queueAccount({ exists: true, enabled: true, sid: 'S-1-5-21-100-200-300-400' })
    queueFirewall(m.rules.map((name) => `${name}||S-1-5-21-999-999-999-999`))

    const result = await doctorWindowsNetwork(home)

    expect(result.tier).toBe('partial')
    expect(result.details.join('\n')).toContain('× 防火墙规则作用域不对')
  })

  test('防火墙探测非零退出 → × 查防火墙规则失败', async () => {
    const home = tempHome()
    writeBlob(home)
    queueAccount({ exists: true, enabled: true, sid: 'S-1-5-21-100-200-300-400' })
    close('', 1, '还需要提升权限')

    const result = await doctorWindowsNetwork(home)

    expect(result.tier).toBe('partial')
    expect(result.details.join('\n')).toContain('× 查防火墙规则失败：powershell 退出码 1：还需要提升权限')
  })

  test('FFI 不可用：④ 跳过 account.bin 检查，明细说明原因', async () => {
    const home = tempHome()
    writeBlob(home)
    m.ffiOk = false
    m.ffiWhy = 'koffi 模块加载失败'
    queueAccount({ exists: true, enabled: true, sid: 'S-1-5-21-100-200-300-400' })
    queueFirewall(greenFirewall())

    const result = await doctorWindowsNetwork(home)
    const text = result.details.join('\n')

    expect(result.tier).toBe('partial')
    expect(text).toContain('× koffi/Win32 FFI 底座不可用：koffi 模块加载失败')
    expect(text).toContain('× 跳过 account.bin 检查：FFI 底座不可用，DPAPI 解不开')
  })

  test('account.bin 解不开 / WFP 探测抛错：各自一条明细，WFP 不拉低 tier', async () => {
    const home = tempHome()
    writeBlob(home)
    m.unprotectError = 'CryptUnprotectData 拒绝空密文'
    m.wfpError = 'FwpmEngineOpen0 失败'
    queueAccount({ exists: true, enabled: true, sid: 'S-1-5-21-100-200-300-400' })
    queueFirewall(greenFirewall())

    const result = await doctorWindowsNetwork(home)
    const text = result.details.join('\n')

    expect(result.tier).toBe('partial')
    expect(text).toContain('× account.bin 检查失败：CryptUnprotectData 拒绝空密文')
    expect(text).toContain('· WFP 子层探测异常（提示项，不计入结论）：FwpmEngineOpen0 失败')
  })
})
