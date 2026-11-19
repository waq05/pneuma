/**
 * `numa plugin` 子命令补测（`packages/cli/plugin-cli.ts`）。
 *
 * 同目录的 `cli.spec.ts` 已经钉住：入口表、无子命令的用法、版本豁免的空/有/旧运行时三条
 * 列表分支、`allow-version` 的拒绝路径与写盘形状、`revoke-version` 的正常撤销、`builds`
 * 在已有 profile 上的输出。这里只补剩下的工作分支：
 *
 *   - `add` / `remove`：用法、成功写清单、本地 `file:` 包认名字、tarball 认不出、
 *     pnpm 失败时退出码透传；
 *   - `list`：未建 profile、包目录缺失、已装包（patch 无）、版本闸不过、已登记豁免、
 *     patch 文件读不了、没有额外组合包、profile 自己的 patch；
 *   - `version-exemptions`：compatibility.json 坏了；
 *   - `allow-version`：缺 `--dsh-version`、重复授权、账本坏了不写盘、保留不认识的顶层键；
 *   - `revoke-version`：规格不合法、缺 `--dsh-version`、账本坏了、删老记录（无 dshVersion）；
 *   - `builds`：未建 profile；
 *   - profile 解析优先级：`--profile` > `DSC_PROFILE`。
 *
 * ## 为什么用假 pnpm
 *
 * `add` / `remove` 的 pnpm 调用是 `spawnSync('pnpm', …, { shell: true })`，真跑会碰网络、
 * 改全局 store，还会因为包名不存在而失败。这里在临时目录造一个同名 `pnpm` 入口（Windows
 * 是 `.cmd`，POSIX 是脚本），把它放到 PATH 最前面，用 `FAKE_PNPM_EXIT` 控制退出码——
 * 测到的仍是「插件 CLI 自己做了什么」，但没有任何外部依赖。
 *
 * @module @pneuma/cli/tests/plugin-cli-extra.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import { DSH_CONTRACT_VERSION } from '../../../core/plugin-bundle.js'

/** 脚本里 `process.exit` 被调用时抛出的信号：捕获它就是拿到退出码。 */
class CliExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${String(code)})`)
  }
}

interface CliRun {
  code: number
  out: string
}

const cliHome = mkdtempSync(join(tmpdir(), 'numa-plugin-cli-extra-'))
const fakeBin = join(cliHome, 'bin')

/** profile 目录。 */
const profileDir = (name: string): string => join(cliHome, 'profiles', name)

/** 一次 CLI 调用：设 argv / 临时 HOME / 拦 process.exit，收集 stdout+stderr。 */
async function runPlugin(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<CliRun> {
  const argv = process.argv
  const touched = ['DSC_HOME', 'DSC_UI_SERVER', 'DSC_PROFILE', ...Object.keys(env)]
  const before = new Map(touched.map((key) => [key, process.env[key]]))
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '))
  })
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new CliExit(typeof code === 'number' ? code : 0)
  }) as typeof process.exit)
  process.argv = [process.execPath, 'plugin-cli.js', ...args]
  process.env['DSC_HOME'] = cliHome
  process.env['DSC_UI_SERVER'] = '0'
  process.env['DSC_PROFILE'] = ''
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  let code = 0
  try {
    vi.resetModules()
    await import('../plugin-cli.js')
  } catch (thrown) {
    if (!(thrown instanceof CliExit)) throw thrown
    code = thrown.code
  } finally {
    process.argv = argv
    exit.mockRestore()
    log.mockRestore()
    error.mockRestore()
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  return { code, out: lines.join('\n') }
}

/** 把假 pnpm 放到 PATH 最前面，跑完恢复；`exitCode` 由假脚本透传。 */
async function withFakePnpm<T>(exitCode: number, body: () => Promise<T>): Promise<T> {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const previousPath = process.env[key]
  const previousExit = process.env['FAKE_PNPM_EXIT']
  process.env[key] = fakeBin + delimiter + (previousPath ?? '')
  process.env['FAKE_PNPM_EXIT'] = String(exitCode)
  try {
    return await body()
  } finally {
    if (previousPath === undefined) delete process.env[key]
    else process.env[key] = previousPath
    if (previousExit === undefined) delete process.env['FAKE_PNPM_EXIT']
    else process.env['FAKE_PNPM_EXIT'] = previousExit
  }
}

/** 造一个 profile 清单。 */
function seedProfile(name: string, manifest: Record<string, unknown>): string {
  const dir = profileDir(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return dir
}

/** 读 profile 清单。 */
function manifestOf(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(profileDir(name), 'package.json'), 'utf8')) as Record<string, unknown>
}

/** 写 compatibility.json 的原文（允许故意写坏）。 */
function writeCompatRaw(name: string, text: string): void {
  mkdirSync(profileDir(name), { recursive: true })
  writeFileSync(join(profileDir(name), 'compatibility.json'), text, 'utf8')
}

/** 读 compatibility.json。 */
function readCompat(name: string): { exemptions: Array<Record<string, unknown>> } & Record<string, unknown> {
  return JSON.parse(readFileSync(join(profileDir(name), 'compatibility.json'), 'utf8')) as {
    exemptions: Array<Record<string, unknown>>
  } & Record<string, unknown>
}

/** 造一个本地的假 pnpm：只按 FAKE_PNPM_EXIT 退出，不碰任何包。 */
mkdirSync(fakeBin, { recursive: true })
writeFileSync(join(fakeBin, 'fake-pnpm.js'), "process.exit(Number(process.env['FAKE_PNPM_EXIT'] ?? '0'))\n", 'utf8')
if (process.platform === 'win32') {
  writeFileSync(join(fakeBin, 'pnpm.cmd'), '@echo off\r\n@node "%~dp0fake-pnpm.js" %*\r\n', 'utf8')
} else {
  writeFileSync(join(fakeBin, 'pnpm'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-pnpm.js" "$@"\n', {
    encoding: 'utf8',
    mode: 0o755,
  })
}

afterAll(() => {
  vi.restoreAllMocks()
  rmSync(cliHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// ── add ────────────────────────────────────────────────────────────────────────
test('add 不带目标：用法 + 先登记豁免的出口，退出 1', async () => {
  const result = await runPlugin(['add'])
  expect(result.code, result.out).toBe(1)
  expect(result.out).toMatch(/用法：numa plugin add <包名\|tarball\|本地路径>/)
  expect(result.out, 'add 失败时要把版本豁免这条出路摆出来').toMatch(/allow-version <包名@版本> --dsh-version/)
})

test('add 成功：profile 清单收包，没有 patch 的包给说明', async () => {
  const result = await withFakePnpm(0, () => runPlugin(['add', '@acme/plug-a', '--profile', 'add-ok']))
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('profile  ' + profileDir('add-ok'))
  expect(result.out).toContain('要跑    pnpm add @acme/plug-a')
  expect(result.out).toContain('没有声明 dsh.bundle.patch')
  expect(result.out).toContain('宿主开着的话下一轮轮询就挂上')
  expect((manifestOf('add-ok')['dsh'] as { profile: { bundles: string[] } }).profile.bundles).toEqual(['@acme/plug-a'])
})

test('add file: 本地包：从被装包自己的 package.json 认名字并写进清单', async () => {
  const pkgDir = join(cliHome, 'local-bundle')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@acme/local-bundle', version: '0.3.0' }), 'utf8')
  const result = await withFakePnpm(0, () =>
    runPlugin(['add', 'file:' + pkgDir, '--profile', 'add-local']),
  )
  expect(result.code, result.out).toBe(0)
  expect((manifestOf('add-local')['dsh'] as { profile: { bundles: string[] } }).profile.bundles).toEqual([
    '@acme/local-bundle',
  ])
})

test('add tarball 认不出包名：不写清单，退出 1 并说清原因', async () => {
  const tarball = join(cliHome, 'not-a-real-bundle.tgz')
  const result = await withFakePnpm(0, () => runPlugin(['add', tarball, '--profile', 'add-tgz']))
  expect(result.code, result.out).toBe(1)
  expect(result.out).toContain('认不出这个包叫什么')
  expect((manifestOf('add-tgz')['dsh'] as { profile: { bundles: string[] } }).profile.bundles).toEqual([])
})

test('add pnpm 失败：退出码原样透传，并给人话', async () => {
  const result = await withFakePnpm(3, () => runPlugin(['add', '@acme/plug-fail', '--profile', 'add-fail']))
  expect(result.code, result.out).toBe(3)
  expect(result.out).toContain('安装失败。常见原因')
})

// ── remove ─────────────────────────────────────────────────────────────────────
test('remove 不带目标：用法 + 退出 1', async () => {
  const result = await runPlugin(['remove'])
  expect(result.code, result.out).toBe(1)
  expect(result.out).toMatch(/用法：numa plugin remove <包名>/)
})

test('remove：先摘清单与依赖行，再调 pnpm；--profile 可写在位置参数前', async () => {
  seedProfile('remove-ok', {
    name: 'probe',
    private: true,
    dsh: { profile: { bundles: ['@acme/plug-a', '@acme/other'] } },
    dependencies: { '@acme/plug-a': '1.0.0', '@acme/other': '2.0.0' },
  })
  // positionalsOf 要跳过 --profile 的值，否则会把 profile 名当成包名。
  const result = await withFakePnpm(0, () =>
    runPlugin(['remove', '--profile', 'remove-ok', '@acme/plug-a']),
  )
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('已卸载 @acme/plug-a')
  const manifest = manifestOf('remove-ok')
  expect((manifest['dsh'] as { profile: { bundles: string[] } }).profile.bundles).toEqual(['@acme/other'])
  expect(manifest['dependencies']).toEqual({ '@acme/other': '2.0.0' })
})

test('remove pnpm 失败：清单已经摘掉，退出码透传并说明', async () => {
  seedProfile('remove-fail', {
    name: 'probe',
    private: true,
    dsh: { profile: { bundles: ['@acme/plug-a'] } },
  })
  const result = await withFakePnpm(4, () => runPlugin(['remove', '@acme/plug-a', '--profile', 'remove-fail']))
  expect(result.code, result.out).toBe(4)
  expect(result.out).toContain('卸载 pnpm 包时出错（profile 清单里已经去掉了这一行）')
  expect((manifestOf('remove-fail')['dsh'] as { profile: { bundles: string[] } }).profile.bundles).toEqual([])
})

// ── list ───────────────────────────────────────────────────────────────────────
test('list 未建 profile：明说首次启动会自动铺', async () => {
  const result = await runPlugin(['list', '--profile', 'list-missing'])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('profile  ' + profileDir('list-missing'))
  expect(result.out).toContain('（还没建这个 profile；首次启动会自动铺默认 profile）')
})

test('list 包目录缺失：提示先 pnpm install；profile 自己的 patch 被列出', async () => {
  const dir = seedProfile('list-no-dir', {
    name: 'probe',
    private: true,
    dsh: { profile: { bundles: ['@acme/missing'] } },
  })
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n', 'utf8')
  const result = await runPlugin(['list', '--profile', 'list-no-dir'])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('@acme/missing  （目录不在，先 pnpm install）')
  expect(result.out).toContain('profile 自己的 patch：' + join(dir, 'cordis.patch.yml'))
})

test('list 已装包：版本、patch 条数与可用状态', async () => {
  const dir = seedProfile('list-ok', { name: 'probe', private: true, dsh: { profile: { bundles: ['@acme/plug-a'] } } })
  const bundleDir = join(dir, 'node_modules', '@acme', 'plug-a')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ name: '@acme/plug-a', version: '1.0.0' }), 'utf8')
  const result = await runPlugin(['list', '--profile', 'list-ok'])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('@acme/plug-a v1.0.0  patch 无  可用')
})

test('list 版本闸不过：标「启动时会跳过」并给出原因', async () => {
  const dir = seedProfile('list-gate', { name: 'probe', private: true, dsh: { profile: { bundles: ['@acme/plug-gate'] } } })
  const bundleDir = join(dir, 'node_modules', '@acme', 'plug-gate')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(
    join(bundleDir, 'package.json'),
    JSON.stringify({ name: '@acme/plug-gate', version: '2.0.0', engines: { dsh: '^9.0.0' } }),
    'utf8',
  )
  const result = await runPlugin(['list', '--profile', 'list-gate'])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('版本不符，启动时会跳过')
  expect(result.out).toContain('这个包要求 dsh ^9.0.0')
})

test('list 登记过豁免：显示可用，并附上被豁免的原因', async () => {
  const dir = seedProfile('list-exempt', {
    name: 'probe',
    private: true,
    dsh: { profile: { bundles: ['@acme/plug-gate'] } },
  })
  const bundleDir = join(dir, 'node_modules', '@acme', 'plug-gate')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(
    join(bundleDir, 'package.json'),
    JSON.stringify({ name: '@acme/plug-gate', version: '2.0.0', engines: { dsh: '^9.0.0' } }),
    'utf8',
  )
  writeFileSync(join(dir, 'compatibility.json'), JSON.stringify({ exemptions: [{ package: '@acme/plug-gate' }] }), 'utf8')
  const result = await runPlugin(['list', '--profile', 'list-exempt'])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('patch 无  可用')
  expect(result.out).toContain('（已登记豁免：这个包要求 dsh ^9.0.0')
})

test('list 包的 patch 文件读不了：把错误摆到这一行上，不中断整屏', async () => {
  const dir = seedProfile('list-bad-patch', {
    name: 'probe',
    private: true,
    dsh: { profile: { bundles: ['@acme/plug-bad'] } },
  })
  const bundleDir = join(dir, 'node_modules', '@acme', 'plug-bad')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(
    join(bundleDir, 'package.json'),
    JSON.stringify({ name: '@acme/plug-bad', version: '1.0.0', pneuma: { bundle: { patch: 'missing.yml' } } }),
    'utf8',
  )
  const result = await runPlugin(['list', '--profile', 'list-bad-patch'])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('（读不了：')
  expect(result.out).toContain('missing.yml')
})

test('list 没有额外组合包：明说', async () => {
  seedProfile('list-empty', { name: 'probe', private: true, dsh: { profile: { bundles: [] } } })
  const result = await runPlugin(['list', '--profile', 'list-empty'])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('（没有额外组合包）')
})

// ── version-exemptions ─────────────────────────────────────────────────────────
test('version-exemptions 账本坏了：退出 1，不猜内容', async () => {
  writeCompatRaw('vex-broken', '{ this is not json')
  const result = await runPlugin(['version-exemptions', '--profile', 'vex-broken'])
  expect(result.code, result.out).toBe(1)
  expect(result.out).toContain('compatibility.json 解析不了')
  expect(result.out).toContain('读不懂就不猜内容')
})

test('version-exemptions 老记录：标注未记录版本/运行时，并说明按包名放行', async () => {
  writeCompatRaw('vex-legacy', JSON.stringify({ exemptions: [{ package: '@acme/legacy' }] }))
  const result = await runPlugin(['version-exemptions', '--profile', 'vex-legacy'])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('@acme/legacy@(整包，未记录版本)')
  expect(result.out).toContain('dsh (未记录运行时)')
  expect(result.out).toContain('老记录：只按包名放行')
})

// ── allow-version ──────────────────────────────────────────────────────────────
test('allow-version 缺 --dsh-version：退出 1，并给出当前运行时的完整命令', async () => {
  const result = await runPlugin(['allow-version', '@acme/plug-a@1.2.3', '--profile', 'allow-no-dsh'])
  expect(result.code, result.out).toBe(1)
  expect(result.out).toContain('缺 --dsh-version')
  expect(result.out).toContain('当前运行时是 ' + DSH_CONTRACT_VERSION)
  expect(result.out).toContain('--dsh-version ' + DSH_CONTRACT_VERSION + ' --accept-risk')
  expect(existsSync(join(profileDir('allow-no-dsh'), 'compatibility.json'))).toBe(false)
})

test('allow-version 重复授权：不重复写，退出 0', async () => {
  writeCompatRaw(
    'allow-dup',
    JSON.stringify({ exemptions: [{ package: '@acme/dup', version: '1.0.0', dshVersion: DSH_CONTRACT_VERSION }] }),
  )
  const result = await runPlugin([
    'allow-version',
    '@acme/dup@1.0.0',
    '--dsh-version',
    DSH_CONTRACT_VERSION,
    '--accept-risk',
    '--profile',
    'allow-dup',
  ])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('这条授权已经在册')
  expect(readCompat('allow-dup').exemptions).toHaveLength(1)
})

test('allow-version 账本坏了：拒绝写盘，文件原样保留', async () => {
  writeCompatRaw('allow-broken', 'not json at all')
  const result = await runPlugin([
    'allow-version',
    '@acme/plug-a@1.2.3',
    '--dsh-version',
    DSH_CONTRACT_VERSION,
    '--accept-risk',
    '--profile',
    'allow-broken',
  ])
  expect(result.code, result.out).toBe(1)
  expect(result.out).toContain('这次不写盘')
  expect(readFileSync(join(profileDir('allow-broken'), 'compatibility.json'), 'utf8')).toBe('not json at all')
})

test('allow-version 写回时保留不认识的顶层键（不能整份覆盖别人的授权）', async () => {
  writeCompatRaw('allow-merge', JSON.stringify({ schema: 3, exemptions: [] }))
  const result = await runPlugin([
    'allow-version',
    '@acme/merge@1.0.0',
    '--dsh-version',
    DSH_CONTRACT_VERSION,
    '--accept-risk',
    '--profile',
    'allow-merge',
  ])
  expect(result.code, result.out).toBe(0)
  const doc = readCompat('allow-merge')
  expect(doc['schema']).toBe(3)
  expect(doc.exemptions).toStrictEqual([
    { package: '@acme/merge', version: '1.0.0', dshVersion: DSH_CONTRACT_VERSION },
  ])
})

// ── revoke-version ────────────────────────────────────────────────────────────
test('revoke-version 规格不合法 / 缺 --dsh-version：两条用法各退 1', async () => {
  const bad = await runPlugin(['revoke-version', '^1.2.0', '--dsh-version', DSH_CONTRACT_VERSION, '--profile', 'rev'])
  expect(bad.code, bad.out).toBe(1)
  expect(bad.out).toMatch(/用法：numa plugin revoke-version <包名@版本>/)
  expect(bad.out).toContain('版本写精确版本')

  const noDsh = await runPlugin(['revoke-version', '@acme/plug-a@1.0.0', '--profile', 'rev'])
  expect(noDsh.code, noDsh.out).toBe(1)
  expect(noDsh.out).toContain('缺 --dsh-version')
})

test('revoke-version 账本坏了：拒绝写盘，退出 1', async () => {
  writeCompatRaw('rev-broken', '}')
  const result = await runPlugin([
    'revoke-version',
    '@acme/plug-a@1.0.0',
    '--dsh-version',
    DSH_CONTRACT_VERSION,
    '--profile',
    'rev-broken',
  ])
  expect(result.code, result.out).toBe(1)
  expect(result.out).toContain('这次不写盘')
})

test('revoke-version 删老记录：没记运行时的授权按包名+版本一并撤掉', async () => {
  writeCompatRaw('rev-legacy', JSON.stringify({ exemptions: [{ package: '@acme/legacy', version: '1.0.0' }] }))
  const result = await runPlugin([
    'revoke-version',
    '@acme/legacy@1.0.0',
    '--dsh-version',
    DSH_CONTRACT_VERSION,
    '--profile',
    'rev-legacy',
  ])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('已撤销：@acme/legacy@1.0.0')
  expect(readCompat('rev-legacy').exemptions).toStrictEqual([])
})

// ── builds ────────────────────────────────────────────────────────────────────
test('builds 未建 profile：明说还没建，退出 0', async () => {
  const result = await runPlugin(['builds', '--profile', 'builds-missing'])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('（还没建这个 profile；首次启动会自动铺默认 profile）')
})

// ── profile 解析优先级 ─────────────────────────────────────────────────────────
test('profile 解析：--profile 参数优先于 DSC_PROFILE 环境变量', async () => {
  const result = await runPlugin(['version-exemptions', '--profile', 'from-arg'], { DSC_PROFILE: 'from-env' })
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('profile  ' + profileDir('from-arg'))
  expect(result.out).not.toContain(profileDir('from-env'))
})

test('profile 解析：没给 --profile 时 DSC_PROFILE 生效', async () => {
  const result = await runPlugin(['version-exemptions'], { DSC_PROFILE: 'from-env' })
  expect(result.code, result.out).toBe(0)
  expect(result.out).toContain('profile  ' + profileDir('from-env'))
})
