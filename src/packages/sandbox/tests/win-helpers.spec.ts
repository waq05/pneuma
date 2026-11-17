/**
 * Windows 沙箱的纯/半纯工具函数：提权脚本生成、账本路径与读取、可写根、GUID 编码。
 *
 * 不调 FFI、不提权、不写真实 `~/.dsc`：需要 DSC_HOME 的那一项在 import 前隔离到临时目录。
 * 提权脚本只验生成文本的关键结构（账号先禁用、5 条防火墙、12 条 WFP、最后才 Enable）。
 *
 * @module dsc/packages/sandbox/tests/win-helpers.spec
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-win-helpers-'))
process.env['DSC_HOME'] = HOME

let setup: typeof import('../win/setup.js')
let account: typeof import('../win/account.js')
let backend: typeof import('../win/backend.js')
let wfp: typeof import('../win/wfp.js')

afterAll(() => {
  delete process.env['DSC_HOME']
})

beforeAll(async () => {
  setup = await import('../win/setup.js')
  account = await import('../win/account.js')
  backend = await import('../win/backend.js')
  wfp = await import('../win/wfp.js')
})

describe('buildSetupScript', () => {
  test('生成的脚本按纪律排布：账号先建禁用态 → 防火墙 → WFP → 账本 → 最后 Enable', () => {
    const script = setup.buildSetupScript({ dscHome: 'C:\\Users\\me\\.dsc' })
    expect(script).toContain("$DscHome = 'C:\\Users\\me\\.dsc'")
    expect(script).toContain(`$DscAccount = '${setup.DSC_SANDBOX_ACCOUNT}'`)
    expect(script).toContain(`$DscProxyPort = ${String(setup.DSC_SANDBOX_DEFAULT_PROXY_PORT)}`)
    expect(script).toContain('$DscStatePath = Join-Path $DscSandboxDir')
    expect(script).toContain('New-LocalUser')
    expect(script).toContain('-Disabled')
    // 防火墙若干条 + WFP filter 表 + 最后一步解禁。
    expect(script.match(/Remove-NetFirewallRule -Name '/g)?.length ?? 0).toBeGreaterThanOrEqual(5)
    expect(script).toContain('$DscFilters = @(')
    expect(script).toContain('Enable-LocalUser -Name $DscAccount')
    expect(script.lastIndexOf('Enable-LocalUser')).toBeGreaterThan(script.indexOf('Move-Item -Path $DscStateTmp'))
  })

  test('自定义端口与 GUID 原样进脚本', () => {
    const script = setup.buildSetupScript({
      dscHome: '/home/me/.dsc',
      proxyPort: 4000,
      guidProvider: '11111111-2222-3333-4444-555555555555',
      guidSublayer: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })
    expect(script).toContain('$DscProxyPort = 4000')
    expect(script).toContain('11111111-2222-3333-4444-555555555555')
    expect(script).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  })

  test('非法 dscHome / GUID / 端口在生成阶段就拒绝', () => {
    expect(() => setup.buildSetupScript({ dscHome: '' })).toThrow(/非空字符串/)
    expect(() => setup.buildSetupScript({ dscHome: "C:\\it's" })).toThrow(/单引号/)
    expect(() => setup.buildSetupScript({ dscHome: 'a\nb' })).toThrow(/换行/)
    expect(() => setup.buildSetupScript({ dscHome: '/x', guidProvider: 'nope' })).toThrow(/GUID/)
    expect(() => setup.buildSetupScript({ dscHome: '/x', proxyPort: 70_000 })).toThrow()
  })
})

describe('账本路径与读取', () => {
  test('路径都落在 <dscHome>/sandbox 下', () => {
    expect(account.sandboxDir('/d')).toBe(join('/d', 'sandbox'))
    expect(account.setupStatePath('/d')).toBe(join('/d', 'sandbox', 'setup-state.json'))
    expect(account.accountBlobPath('/d')).toBe(join('/d', 'sandbox', 'account.bin'))
    expect(account.setupScriptPath('/d')).toBe(join('/d', 'sandbox', 'setup.ps1'))
    expect(account.setupErrorPath('/d')).toBe(join('/d', 'sandbox', 'setup-error.txt'))
  })

  test('没文件返回 null；坏 JSON / 坏字段返回 ok:false 并说清原因', () => {
    expect(account.readSetupState(join(HOME, 'none'))).toBeNull()

    mkdirSync(account.sandboxDir(HOME), { recursive: true })
    writeFileSync(account.setupStatePath(HOME), '{bad', 'utf8')
    const broken = account.readSetupState(HOME)
    expect(broken).toMatchObject({ ok: false })
    if (broken !== null && !broken.ok) expect(broken.error).toContain('不是合法 JSON')

    writeFileSync(account.setupStatePath(HOME), JSON.stringify({ version: 1, account: 'x' }), 'utf8')
    const missing = account.readSetupState(HOME)
    expect(missing).toMatchObject({ ok: false })
    if (missing !== null && !missing.ok) expect(missing.error).toContain('sid')
  })

  test('合法账本原样读回（含可选 wfpFilterCount）', () => {
    const state = {
      version: 1,
      account: 'dsc-sandbox-offline',
      sid: 'S-1-5-21-1',
      proxyPort: 3128,
      firewallRules: ['a', 'b'],
      wfpProviderGuid: '11111111-1111-1111-1111-111111111111',
      wfpSublayerGuid: '22222222-2222-2222-2222-222222222222',
      at: '2026-03-09T00:00:00.000Z',
      wfpFilterCount: 12,
    }
    writeFileSync(account.setupStatePath(HOME), JSON.stringify(state), 'utf8')
    expect(account.readSetupState(HOME)).toEqual({ ok: true, state })
  })
})

describe('writeRootsFor', () => {
  test('工作区 root + 私有临时目录 temp；附加根去重且大小写不敏感', () => {
    // 2026-11-17 起可写根先过 canonicalWriteCwd / canonicalizePath（dev 的 BUG-0004 修复：
    // cwd 与附加根必须同一个函数、同一个 cwd 展开）。拿 `/work/repo` 这种假路径断言字面串
    // 不再成立——规范化会把盘符相对路径折成本盘的 `D:\work\repo`。改用真目录按真实拼法比，
    // 顺便把「尾巴多一个分隔符算同一个目录」也钉住。
    const work = mkdtempSync(join(tmpdir(), 'dsc-writeroot-work-'))
    const extra = mkdtempSync(join(tmpdir(), 'dsc-writeroot-extra-'))
    const roots = backend.writeRootsFor(work + sep, [work, extra + sep])
    const lower = (path: string): string => path.toLowerCase()
    const rootPaths = roots.filter((item) => item.side === 'root').map((item) => lower(item.path))
    const tempPaths = roots.filter((item) => item.side === 'temp').map((item) => item.path)
    // 工作区与附加根各一条：`work + sep` 与 `work` 规范化后是同一个目录，只留一条。
    expect(rootPaths).toEqual([lower(work), lower(extra)])
    expect(tempPaths).toHaveLength(1)
    expect(tempPaths[0]).toContain('sandbox')
    expect(new Set(roots.map((item) => lower(item.path))).size).toBe(roots.length)
  })

  test('附加根里的相对路径按 cwd 展开，不落到宿主进程的 cwd', () => {
    const work = mkdtempSync(join(tmpdir(), 'dsc-writeroot-rel-'))
    const roots = backend.writeRootsFor(work, ['sub/dir'])
    const rootPaths = roots.filter((item) => item.side === 'root').map((item) => item.path.toLowerCase())
    expect(rootPaths).toContain(join(work, 'sub', 'dir').toLowerCase())
  })

  test('空附加根被忽略；每个根都有 SID 且互不相同', () => {
    const roots = backend.writeRootsFor('/w', ['  ', ''])
    expect(roots.filter((item) => item.side === 'root')).toHaveLength(1)
    expect(new Set(roots.map((item) => item.sid)).size).toBe(roots.length)
  })
})

describe('guidStringToBuffer', () => {
  test('按 WFP 的混合字节序编码（前三个字段小端）', () => {
    expect(wfp.guidStringToBuffer('c38d57d1-05a7-4c33-904f-7fbceee60e82').toString('hex')).toBe(
      'd1578dc3a705334c904f7fbceee60e82',
    )
  })

  test('带花括号与首尾空白也认；形状不对抛错', () => {
    expect(
      wfp.guidStringToBuffer('{c38d57d1-05a7-4c33-904f-7fbceee60e82}').toString('hex'),
    ).toBe('d1578dc3a705334c904f7fbceee60e82')
    expect(() => wfp.guidStringToBuffer('not-a-guid')).toThrow(/GUID/)
  })

  test('probeWfpSublayer 对坏 GUID 返回 present:false 而不是抛', () => {
    const result = wfp.probeWfpSublayer('bad')
    expect(result.present).toBe(false)
    expect(result.detail).toContain('GUID')
  })
})
