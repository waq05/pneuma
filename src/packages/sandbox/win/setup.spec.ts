/**
 * Windows 沙箱提权 setup 的可执行面（`src/packages/sandbox/win/setup.ts`）：
 * 脚本生成（setup / uninstall）、并发互斥、以及 `run*Elevated` 的三路结论
 * （退出码 / 账本 / 失败原因对不上时怎么拼文案）。
 *
 * 这里**不弹 UAC、不改系统**：`node:child_process` 的 `spawn` 换成可编排的假子进程，
 * 账本与 setup-error.txt 由用例自己写；真 FFI 只在互斥体那一条用例里打开（CreateMutexW
 * 是纯进程内对象，不落盘不改 ACL）。FFI 默认关掉，互斥体走空实现，其余用例不受机器影响。
 *
 * 每条用例一个临时 dscHome，收尾容忍 Windows 的 EPERM（偶尔被扫描进程占着）。
 *
 * @module dsc/packages/sandbox/win/setup.spec
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/** 假子进程的行为脚本：close = 正常退出，error = spawn 失败，hang = 永不返回（验超时）。 */
interface SpawnBehavior {
  kind: 'close' | 'error' | 'hang'
  code?: number
  stdout?: string
  stderr?: string
  message?: string
  /** close 之前跑一下（让「提权脚本删掉账本」这类副作用发生）。 */
  beforeClose?: () => void
}

const spawnState = vi.hoisted(() => ({
  behaviors: [] as SpawnBehavior[],
  calls: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
  children: [] as Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }>,
  defaultBehavior: { kind: 'close', code: 0 } as SpawnBehavior,
}))

/* 子进程换成假的：不起 PowerShell、不弹 UAC。 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (file: string, args: string[], options: Record<string, unknown>) => {
      const behavior = spawnState.behaviors.shift() ?? spawnState.defaultBehavior
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill: ReturnType<typeof vi.fn>
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = vi.fn(() => true)
      spawnState.calls.push({ file, args, options })
      spawnState.children.push(child)

      if (behavior.kind === 'close') {
        // 先给 stdout/stderr 一拍让监听器收到数据，再发 close。
        setTimeout(() => {
          if (behavior.stdout !== undefined) child.stdout.write(behavior.stdout)
          if (behavior.stderr !== undefined) child.stderr.write(behavior.stderr)
          setTimeout(() => {
            behavior.beforeClose?.()
            child.stdout.end()
            child.stderr.end()
            child.emit('close', behavior.code ?? 0)
          }, 2)
        }, 1)
      } else if (behavior.kind === 'error') {
        setTimeout(() => child.emit('error', new Error(behavior.message ?? 'spawn 失败')), 1)
      }
      return child
    },
  }
})

/* FFI 默认关掉：互斥体返回空实现，用例不必依赖 koffi；互斥体那条自己打开。 */
const ffiState = vi.hoisted(() => ({ enabled: false }))
vi.mock('./ffi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ffi.js')>()
  return {
    ...actual,
    tryLoadFfi: () =>
      ffiState.enabled
        ? actual.tryLoadFfi()
        : ({ ok: false, why: '测试里关掉 FFI（互斥体走空实现）' } as const),
  }
})

import * as setup from './setup.js'
import { tryLoadFfi } from './ffi.js'
import { accountBlobPath, setupErrorPath, setupScriptPath } from './account.js'
import { DSC_WFP_FILTERS, firewallRuleNames } from './net-abi.js'

const dirs: string[] = []

beforeEach(() => {
  spawnState.behaviors.length = 0
  spawnState.calls.length = 0
  spawnState.children.length = 0
  spawnState.defaultBehavior = { kind: 'close', code: 0 }
  ffiState.enabled = false
})

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } catch {
      // Windows 上偶尔被占着：临时目录留给系统清。
    }
  }
})

afterAll(() => {
  // 兜底：beforeEach 之外的目录（如果有）也收掉。
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 同上 */
    }
  }
})

/** 一个干净的 dscHome。 */
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-setup-spec-'))
  dirs.push(dir)
  return dir
}

/** 排一段假子进程行为。 */
function queue(behavior: SpawnBehavior): void {
  spawnState.behaviors.push(behavior)
}

/** 写一份合法账本。 */
function writeState(home: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(home, 'sandbox'), { recursive: true })
  writeFileSync(
    join(home, 'sandbox', 'setup-state.json'),
    JSON.stringify({
      version: 1,
      account: 'dsc-sandbox-offline',
      sid: 'S-1-5-21-100-200-300-400',
      proxyPort: 3128,
      firewallRules: ['dsc-sandbox-block-outbound'],
      wfpProviderGuid: '11111111-2222-3333-4444-555555555555',
      wfpSublayerGuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      at: '2026-11-16T00:00:00.000Z',
      wfpFilterCount: 12,
      ...overrides,
    }),
    'utf8',
  )
}

/** 上一次 spawn 收到的 launcher 命令行。 */
function launcherOf(index = 0): string {
  const call = spawnState.calls[index]!
  return call.args[call.args.length - 1]!
}

describe('常量与生成脚本', () => {
  test('账号/组/端口/账本版本/互斥体名字是固定口径', () => {
    expect(setup.DSC_SANDBOX_ACCOUNT).toBe('dsc-sandbox-offline')
    expect(setup.DSC_SANDBOX_GROUP).toBe('DscSandboxUsers')
    expect(setup.DSC_SANDBOX_DEFAULT_PROXY_PORT).toBe(3128)
    expect(setup.DSC_SETUP_STATE_VERSION).toBe(1)
    expect(setup.SETUP_MUTEX_NAME).toBe('Local\\dsc-sandbox-setup')
    expect(setup.SETUP_BUSY_DETAIL).toContain('另一个沙箱安装正在运行')
  })

  test('setup 脚本：5 条防火墙都先删后建、代理端口走补集、12 条 filter、Enable 最后', () => {
    const script = setup.buildSetupScript({ dscHome: 'C:\\Users\\me\\.dsc' })
    expect(script.match(/New-NetFirewallRule /g) ?? []).toHaveLength(5)
    expect(script.match(/Remove-NetFirewallRule -Name '/g) ?? []).toHaveLength(5)
    // 环回 TCP 的放行不是 allow 规则，而是 block 的端口补集。
    expect(script).toContain("-RemotePorts '1-3127,3129-65535'")
    expect(script).toContain('-LocalUser "O:LSD:(A;;CC;;;$DscSid)"')
    expect(script.match(/^  '[0-9a-f-]{36}\|dsc_wfp_/gm) ?? []).toHaveLength(12)
    for (const filter of DSC_WFP_FILTERS) expect(script).toContain(filter.key)
    expect(script).toContain('New-LocalUser -Name $DscAccount')
    expect(script).toContain('-Disabled')

    // 顺序即安全纪律：建账号（禁用态）→ 防火墙 → WFP → 写账本 → 最后解禁。
    const accountAt = script.indexOf('New-LocalUser -Name $DscAccount')
    const firewallAt = script.indexOf('New-NetFirewallRule ')
    const wfpAt = script.indexOf('[DscWfp]::Install')
    const ledgerAt = script.indexOf('Move-Item -Path $DscStateTmp -Destination $DscStatePath')
    const enableAt = script.indexOf('Enable-LocalUser -Name $DscAccount')
    expect(accountAt).toBeGreaterThan(0)
    expect(accountAt).toBeLessThan(firewallAt)
    expect(firewallAt).toBeLessThan(wfpAt)
    expect(wfpAt).toBeLessThan(ledgerAt)
    expect(ledgerAt).toBeLessThan(enableAt)
  })

  test('setup 脚本：自定义端口/GUID 原样进；端口 0 与 65535 的补集边界', () => {
    const custom = setup.buildSetupScript({
      dscHome: '/home/me/.dsc',
      proxyPort: 4000,
      guidProvider: '11111111-2222-3333-4444-555555555555',
      guidSublayer: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })
    expect(custom).toContain('$DscProxyPort = 4000')
    expect(custom).toContain("-RemotePorts '1-3999,4001-65535'")
    expect(custom).toContain('11111111-2222-3333-4444-555555555555')
    expect(custom).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')

    const zero = setup.buildSetupScript({ dscHome: '/x', proxyPort: 0 })
    expect(zero).toContain("-RemotePorts '1-65535'")
    const top = setup.buildSetupScript({ dscHome: '/x', proxyPort: 65_535 })
    expect(top).toContain("-RemotePorts '1-65534'")
  })

  test('setup 脚本：坏 dscHome / GUID / 端口在生成阶段就拒', () => {
    expect(() => setup.buildSetupScript({ dscHome: '' })).toThrow(/非空字符串/)
    expect(() => setup.buildSetupScript({ dscHome: "C:\\it's" })).toThrow(/单引号/)
    expect(() => setup.buildSetupScript({ dscHome: 'a\nb' })).toThrow(/换行/)
    expect(() => setup.buildSetupScript({ dscHome: '/x', guidProvider: 'nope' })).toThrow(/GUID/)
    expect(() => setup.buildSetupScript({ dscHome: '/x', guidSublayer: 'nope' })).toThrow(/GUID/)
    expect(() => setup.buildSetupScript({ dscHome: '/x', proxyPort: 70_000 })).toThrow(/环回 TCP 端口补集/)
  })

  test('uninstall 脚本：删账号→删规则→删 WFP→最后删账本，规则名与 filter key 同源', () => {
    const script = setup.buildUninstallScript({ dscHome: 'C:\\Users\\me\\.dsc' })
    expect(script).toContain(`$DscAccount = '${setup.DSC_SANDBOX_ACCOUNT}'`)
    for (const name of firewallRuleNames(setup.DSC_SANDBOX_DEFAULT_PROXY_PORT)) expect(script).toContain(`'${name}'`)
    for (const filter of DSC_WFP_FILTERS) expect(script).toContain(`'${filter.key}'`)
    expect(script).toContain('Remove-LocalUser -Name $DscAccount')
    expect(script).toContain('Remove-LocalGroup -Name $DscGroup')
    expect(script).toContain('已删除账号组')
    expect(script).toContain('[DscWfp]::Uninstall')
    expect(script).toContain('setup-state.json 还在，卸载没走完')

    // 账本必须在 WFP 拆完之后才删：中途失败时设置页的卸载按钮还能重试。
    const wfpAt = script.indexOf('[DscWfp]::Uninstall')
    const removeFilesAt = script.indexOf('$DscStatePath, $DscSecretPath')
    expect(removeFilesAt).toBeGreaterThan(wfpAt)
  })

  test('uninstall 脚本：账本给的账号/GUID/端口覆盖默认值', () => {
    const script = setup.buildUninstallScript({
      dscHome: 'C:\\d',
      account: 'custom-sandbox-account',
      guidProvider: '99999999-2222-3333-4444-555555555555',
      guidSublayer: '88888888-2222-3333-4444-555555555555',
      proxyPort: 4000,
    })
    expect(script).toContain("$DscAccount = 'custom-sandbox-account'")
    expect(script).toContain('99999999-2222-3333-4444-555555555555')
    expect(script).toContain('88888888-2222-3333-4444-555555555555')
  })

  test('uninstall 脚本：坏 dscHome / 账号 / GUID / 端口在生成阶段就拒', () => {
    expect(() => setup.buildUninstallScript({ dscHome: '' })).toThrow(/非空字符串/)
    expect(() => setup.buildUninstallScript({ dscHome: "C:\\it's" })).toThrow(/单引号/)
    expect(() => setup.buildUninstallScript({ dscHome: 'a\nb' })).toThrow(/换行/)
    expect(() => setup.buildUninstallScript({ dscHome: '/x', account: "it's" })).toThrow(/账号名/)
    expect(() => setup.buildUninstallScript({ dscHome: '/x', guidProvider: 'nope' })).toThrow(/GUID/)
    expect(() => setup.buildUninstallScript({ dscHome: '/x', proxyPort: 70_000 })).toThrow(/环回 TCP 端口补集/)
  })
})

describe('并发互斥', () => {
  test('同名互斥体第二次被拒（真 FFI 可用时），release 可重复调；不可用时退回空实现', () => {
    ffiState.enabled = true
    // 先看这台机器上真 FFI 能不能用：能用才验「同名被拒」，不能用就验 no-op 路径。
    const probe = tryLoadFfi()
    const name = `Local\\dsc-sandbox-setup-spec-${String(process.pid)}`
    const first = setup.acquireSetupMutex(name)
    expect(first.ok).toBe(true)
    if (probe.ok && first.ok) {
      const second = setup.acquireSetupMutex(name)
      expect(second.ok).toBe(false)
      if (!second.ok) expect(second.why).toBe(setup.SETUP_BUSY_DETAIL)
      // 重复 release 不该抛；放掉之后同名字又能拿到。
      first.mutex.release()
      first.mutex.release()
      const third = setup.acquireSetupMutex(name)
      expect(third.ok).toBe(true)
      if (third.ok) third.mutex.release()
    } else {
      // 非 Windows / koffi 缺失：no-op 互斥体，永远允许继续（安装本来也跑不了）。
      if (first.ok) first.mutex.release()
    }
  })
})

describe('runSetupElevated：三处证据', () => {
  test('成功：脚本落盘带 BOM、旧错误文件被清、结论含账号与条数', async () => {
    const home = tempHome()
    writeState(home)
    mkdirSync(join(home, 'sandbox'), { recursive: true })
    writeFileSync(setupErrorPath(home), '\uFEFF上一轮的失败记录', 'utf8')
    queue({ kind: 'close', code: 0, stdout: 'done' })

    const result = await setup.runSetupElevated(home, { timeoutMs: 5000 })
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('提权 setup 成功')
    expect(result.detail).toContain('账号 dsc-sandbox-offline')
    expect(result.detail).toContain('防火墙 1 条')
    expect(result.detail).toContain('WFP filter 12 条')

    const scriptPath = setupScriptPath(home)
    const text = readFileSync(scriptPath, 'utf8')
    expect(text.charCodeAt(0)).toBe(0xfeff) // PowerShell 5.1 只认带 BOM 的 UTF-8
    expect(text).toContain("$DscHome = '")
    expect(existsSync(setupErrorPath(home))).toBe(false)

    const call = spawnState.calls[0]!
    expect(call.file.toLowerCase()).toContain('powershell.exe')
    expect(call.args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']))
    expect(launcherOf()).toContain('-Verb RunAs')
    expect(launcherOf()).toContain('-File')
    expect(launcherOf()).toContain('setup.ps1')
    expect(call.options).toMatchObject({ windowsHide: true })
  })

  test('失败：退出码 + 脚本报错 + stderr + 没有账本，四段都写进 detail', async () => {
    const home = tempHome()
    // 真实脚本是提权进程里写 setup-error.txt 的：假子进程也要在「跑起来之后」写，
    // 因为 installElevated 会在起进程之前先清掉上一轮的旧文件。
    queue({
      kind: 'close',
      code: 1,
      stderr: 'Access is denied',
      beforeClose: () => {
        mkdirSync(join(home, 'sandbox'), { recursive: true })
        writeFileSync(setupErrorPath(home), '\uFEFFsetup 失败：建账号被拒', 'utf8')
      },
    })

    const result = await setup.runSetupElevated(home, { timeoutMs: 5000 })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('提权 setup 退出码 1')
    expect(result.detail).toContain('脚本报错：setup 失败：建账号被拒')
    expect(result.detail).toContain('stderr：Access is denied')
    expect(result.detail).toContain('没有 setup-state.json')
  })

  test('账本坏了：按「读不动」报，不把坏文件当成功', async () => {
    const home = tempHome()
    mkdirSync(join(home, 'sandbox'), { recursive: true })
    writeFileSync(join(home, 'sandbox', 'setup-state.json'), '{bad', 'utf8')
    queue({ kind: 'close', code: 1 })

    const result = await setup.runSetupElevated(home, { timeoutMs: 5000 })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('账本读不动')
  })

  test('退出码 0 但没账本 / 账本在但退出码非 0：都按失败报并说清是半成品', async () => {
    const noLedger = tempHome()
    queue({ kind: 'close', code: 0 })
    const first = await setup.runSetupElevated(noLedger, { timeoutMs: 5000 })
    expect(first.ok).toBe(false)
    expect(first.detail).toContain('提权 setup 退出码 0')
    expect(first.detail).toContain('没有 setup-state.json')

    const halfDone = tempHome()
    writeState(halfDone)
    queue({ kind: 'close', code: 2 })
    const second = await setup.runSetupElevated(halfDone, { timeoutMs: 5000 })
    expect(second.ok).toBe(false)
    expect(second.detail).toContain('属半成品，请重跑 setup')
  })

  test('超时：杀掉子进程并报「可能在等 UAC」', async () => {
    const home = tempHome()
    queue({ kind: 'hang' })
    const result = await setup.runSetupElevated(home, { timeoutMs: 20 })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('提权 setup 超时未结束')
    expect(result.detail).toContain('可能在等 UAC 授权')
    expect(spawnState.children[0]!.kill).toHaveBeenCalled()
  })

  test('spawn 自己失败（找不到解释器）：stderr 带上原因，不当成功', async () => {
    const home = tempHome()
    queue({ kind: 'error', message: 'spawn ENOENT' })
    const result = await setup.runSetupElevated(home, { timeoutMs: 5000 })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('提权 setup 退出码 -1')
    expect(result.detail).toContain('spawn ENOENT')
  })

  test('生成脚本/写脚本失败：不起子进程，直接给可定位的 detail', async () => {
    const badHome = await setup.runSetupElevated('', { timeoutMs: 100 })
    expect(badHome.ok).toBe(false)
    expect(badHome.detail).toContain('生成 setup 脚本失败')

    // dscHome 指向一个文件：sandbox/ 建不出来。
    const parent = tempHome()
    const fileHome = join(parent, 'not-a-dir')
    writeFileSync(fileHome, 'x', 'utf8')
    const unwritable = await setup.runSetupElevated(fileHome, { timeoutMs: 100 })
    expect(unwritable.ok).toBe(false)
    expect(unwritable.detail).toContain('写 setup 脚本失败')
    expect(spawnState.calls).toHaveLength(0)
  })
})

describe('runUninstallElevated：三处证据', () => {
  test('成功：脚本带账本里的账号、落盘带 BOM、账本消失才算卸干净', async () => {
    const home = tempHome()
    writeState(home, {
      account: 'custom-sandbox-account',
      wfpProviderGuid: '99999999-2222-3333-4444-555555555555',
      wfpSublayerGuid: '88888888-2222-3333-4444-555555555555',
      proxyPort: 4000,
    })
    queue({
      kind: 'close',
      code: 0,
      beforeClose: () => rmSync(join(home, 'sandbox', 'setup-state.json'), { force: true }),
    })

    const result = await setup.runUninstallElevated(home, { timeoutMs: 5000 })
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('提权卸载完成')

    const scriptPath = join(home, 'sandbox', 'uninstall.ps1')
    const text = readFileSync(scriptPath, 'utf8')
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(text).toContain("$DscAccount = 'custom-sandbox-account'")
    expect(text).toContain('99999999-2222-3333-4444-555555555555')
    expect(text).toContain('88888888-2222-3333-4444-555555555555')

    expect(launcherOf()).toContain('-Verb RunAs')
    expect(launcherOf()).toContain('uninstall.ps1')
  })

  test('失败：账本还在就说「没走完」，脚本报错与 stderr 一并带上', async () => {
    const home = tempHome()
    writeState(home)
    queue({
      kind: 'close',
      code: 1,
      stderr: 'busy',
      beforeClose: () => writeFileSync(setupErrorPath(home), '卸载失败：账号被占用', 'utf8'),
    })

    const result = await setup.runUninstallElevated(home, { timeoutMs: 5000 })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('提权卸载退出码 1')
    expect(result.detail).toContain('脚本报错：卸载失败：账号被占用')
    expect(result.detail).toContain('stderr：busy')
    expect(result.detail).toContain('setup-state.json 还在')
    expect(result.detail).toContain('卸载没走完')
  })

  test('账本坏了 / 超时：分别报「读不动」与「可能在等 UAC」', async () => {
    const corrupt = tempHome()
    mkdirSync(join(corrupt, 'sandbox'), { recursive: true })
    writeFileSync(join(corrupt, 'sandbox', 'setup-state.json'), '{bad', 'utf8')
    queue({ kind: 'close', code: 1 })
    const broken = await setup.runUninstallElevated(corrupt, { timeoutMs: 5000 })
    expect(broken.ok).toBe(false)
    expect(broken.detail).toContain('账本读不动')

    const slow = tempHome()
    queue({ kind: 'hang' })
    const timedOut = await setup.runUninstallElevated(slow, { timeoutMs: 20 })
    expect(timedOut.ok).toBe(false)
    expect(timedOut.detail).toContain('提权卸载超时未结束')
    expect(timedOut.detail).toContain('可能在等 UAC 授权')
  })

  test('生成脚本/写脚本失败：直接给可定位的 detail，不起子进程', async () => {
    const badHome = await setup.runUninstallElevated('', { timeoutMs: 100 })
    expect(badHome.ok).toBe(false)
    expect(badHome.detail).toContain('生成卸载脚本失败')

    const parent = tempHome()
    const fileHome = join(parent, 'not-a-dir-either')
    writeFileSync(fileHome, 'x', 'utf8')
    const unwritable = await setup.runUninstallElevated(fileHome, { timeoutMs: 100 })
    expect(unwritable.ok).toBe(false)
    expect(unwritable.detail).toContain('写卸载脚本失败')
    expect(unwritable.detail).toContain('uninstall.ps1')
    expect(spawnState.calls).toHaveLength(0)
  })
})

// account.bin 的路径口径与 setup 生成的 $DscSecretPath 必须一致（写错等于把密码写去别处）。
test('setup 脚本里的密码落点与 account.ts 的路径口径一致', () => {
  const home = tempHome()
  const script = setup.buildSetupScript({ dscHome: home })
  expect(script).toContain("$DscSecretPath = Join-Path $DscSandboxDir 'account.bin'")
  expect(accountBlobPath(home)).toBe(join(home, 'sandbox', 'account.bin'))
})
