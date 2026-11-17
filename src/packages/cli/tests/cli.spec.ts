/**
 * `@pneuma/cli` 的包级测试：钉入口表、产物与版本豁免三个子命令。
 *
 * 为什么子命令要真执行：这层逻辑住在「内核起来之前」的脚本里（顶层读 argv、process.exit），
 * 当函数 import 根本跑不起来；而版本豁免的要点恰恰是**退出码与写盘副作用**（不给
 * --accept-risk 就不许写盘）。迁移后不再 spawn `lib/` 产物，改成在测试进程里
 * `vi.resetModules()` + 动态 import 源码，把 `process.exit` 拦成一个异常——测到的仍是
 * 「退出码 + 写盘形状」，同时不依赖 `pnpm build`。HOME 用临时目录，不碰真实 ~/.dsc。
 * @module @pneuma/cli/tests
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import { DSH_CONTRACT_VERSION, exemptionAllows, readProfile } from '../../../core/plugin-bundle.js'
import { CLI_ENTRIES } from '../index.js'
import { ignoredBuildsOf, installScriptsAdvice } from '../pnpm-builds.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json')) as {
  private?: boolean
  pneuma?: { library?: boolean; bundle?: unknown }
}

/** 脚本里 `process.exit` 被调用时抛出的信号：捕获它就是拿到退出码。 */
class CliExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${String(code)})`)
  }
}

/** 一次 CLI 调用的结果：退出码 + stdout/stderr 合并后的文本。 */
interface CliRun {
  code: number
  out: string
}

const cliHome = mkdtempSync(join(tmpdir(), 'numa-cli-test-'))
const profileDir = join(cliHome, 'profiles', 'probe')
const compatibilityFile = join(profileDir, 'compatibility.json')

/**
 * 在测试进程里执行一个 CLI 脚本：设 argv、拦 process.exit、收集输出。
 *
 * @param entry - `../config-cli.js` 这类源码说明符
 * @param args - 子命令之后的参数
 */
async function runCli(entry: '../config-cli.js' | '../plugin-cli.js', args: readonly string[]): Promise<CliRun> {
  const argv = process.argv
  const home = process.env['DSC_HOME']
  const profile = process.env['DSC_PROFILE']
  const uiServer = process.env['DSC_UI_SERVER']
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
  process.argv = [process.execPath, entry, ...args]
  process.env['DSC_HOME'] = cliHome
  process.env['DSC_UI_SERVER'] = '0'
  process.env['DSC_PROFILE'] = ''
  let code = 0
  try {
    vi.resetModules()
    await import(entry)
    // 走到这里说明脚本没有 process.exit：按 0 处理，让断言去暴露问题。
  } catch (thrown) {
    if (!(thrown instanceof CliExit)) throw thrown
    code = thrown.code
  } finally {
    process.argv = argv
    exit.mockRestore()
    log.mockRestore()
    error.mockRestore()
    if (home === undefined) delete process.env['DSC_HOME']
    else process.env['DSC_HOME'] = home
    if (profile === undefined) delete process.env['DSC_PROFILE']
    else process.env['DSC_PROFILE'] = profile
    if (uiServer === undefined) delete process.env['DSC_UI_SERVER']
    else process.env['DSC_UI_SERVER'] = uiServer
  }
  return { code, out: lines.join('\n') }
}

/** 跑一次 `numa plugin`。 */
async function runPlugin(args: readonly string[]): Promise<CliRun> {
  return runCli('../plugin-cli.js', args)
}

/** 读 profile 的 compatibility.json（还没写过给 null）。 */
const readCompatibility = (): { exemptions: Array<{ package: string; version: string; dshVersion?: string }> } | null =>
  existsSync(compatibilityFile)
    ? (JSON.parse(readFileSync(compatibilityFile, 'utf8')) as {
        exemptions: Array<{ package: string; version: string; dshVersion?: string }>
      })
    : null

afterAll(() => {
  vi.restoreAllMocks()
  // 临时 HOME 用完就删：里面只有这轮造出来的 profile，不留尾巴。
  rmSync(cliHome, { recursive: true, force: true })
})

test('库包身份：private + pneuma.library，且没有装配行', () => {
  expect(pkg.private).toBe(true)
  expect(pkg.pneuma?.library).toBe(true)
  expect(pkg.pneuma?.bundle).toBeUndefined()
  expect(existsSync(new URL('../cordis.patch.yml', import.meta.url))).toBe(false)
})

test('入口表里的每个文件都在源码里', () => {
  const entries = Object.values(CLI_ENTRIES)
  for (const file of ['config-cli.ts', 'plugin-cli.ts']) {
    // 表里写的是产物名（.js），源码是 .ts：比的是同一个 basename。
    expect(entries, `index.ts 的入口表没写 ${file}`).toContain(file.replace(/\.ts$/, '.js'))
    expect(existsSync(new URL(`../${file}`, import.meta.url)), `${file} 不在包里`).toBe(true)
  }
})

test('入口表导出的是产物文件名（.js 而不是 .ts）', () => {
  expect(CLI_ENTRIES).toStrictEqual({ config: 'config-cli.js', plugin: 'plugin-cli.js' })
})

test('两个脚本一 import 就收尾（顶层 process.exit），不会被当库 import', async () => {
  // 这两条同时钉「模块顶层执行」与「退出码」：能用 import 拿到返回值就说明它还是库的形状。
  const config = await runCli('../config-cli.js', [])
  expect(config.code, 'numa config 不带参数应当是用法提示 + 退出 0').toBe(0)
  expect(config.out).toMatch(/numa config migrate/)
  const plugin = await runCli('../plugin-cli.js', [])
  expect(plugin.code, 'numa plugin 不带子命令应当是用法 + 退出 1').toBe(1)
  expect(plugin.out).toMatch(/numa plugin <add\|remove\|list/)
})

test('README 两段都在', () => {
  const text = read('../README.md')
  expect(text).toMatch(/^## Model Experience/m)
  expect(text).toMatch(/^## Known Limitations/m)
})

// ── 版本豁免三个子命令：真跑一次源码 ───────────────────────────────────────────
test('version-exemptions：没有登记时明说没有豁免', async () => {
  const result = await runPlugin(['version-exemptions', '--profile', 'probe'])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toMatch(/没有登记豁免/)
})

test('allow-version：不给 --accept-risk 就拒绝写盘，并打印风险原文', async () => {
  const result = await runPlugin(['allow-version', '@acme/plug-a@1.2.3', '--dsh-version', DSH_CONTRACT_VERSION, '--profile', 'probe'])
  expect(result.code, result.out).toBe(1)
  expect(result.out).toMatch(/不兼容插件可能崩溃或丢数据/)
  expect(result.out).toMatch(/只对这一个版本组合有效/)
  expect(existsSync(compatibilityFile), '没授权也写了盘').toBe(false)
})

test('allow-version：运行时版本对不上时拒绝', async () => {
  const result = await runPlugin(['allow-version', '@acme/plug-a@1.2.3', '--dsh-version', '9.9.9', '--accept-risk', '--profile', 'probe'])
  expect(result.code, result.out).toBe(1)
  expect(result.out).toMatch(/运行时对不上/)
  expect(existsSync(compatibilityFile)).toBe(false)
})

test('allow-version：区间版本不收（豁免只对确定的版本有意义）', async () => {
  const result = await runPlugin(['allow-version', '@acme/plug-a@^1.2.0', '--dsh-version', DSH_CONTRACT_VERSION, '--accept-risk', '--profile', 'probe'])
  expect(result.code, result.out).toBe(1)
  expect(result.out).toMatch(/精确版本/)
})

test('allow-version：带 --accept-risk 才写，形状与 readProfile 的解析兼容', async () => {
  const result = await runPlugin(['allow-version', '@acme/plug-a@1.2.3', '--dsh-version', DSH_CONTRACT_VERSION, '--accept-risk', '--profile', 'probe'])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toMatch(/已登记豁免/)
  const doc = readCompatibility()
  expect(doc?.exemptions).toHaveLength(1)
  expect(doc?.exemptions[0]).toStrictEqual({ package: '@acme/plug-a', version: '1.2.3', dshVersion: DSH_CONTRACT_VERSION })
  // 版本闸读的就是 readProfile().exemptions：这条记录必须原样出现在里面，否则等于没登记。
  const exemptions = readProfile(profileDir).exemptions
  expect(exemptions).toStrictEqual([{ package: '@acme/plug-a', version: '1.2.3', dshVersion: DSH_CONTRACT_VERSION }])
  // 精确到版本：同一个包换个版本就不放行（一次点头不该永久有效）。
  expect(exemptionAllows(exemptions, '@acme/plug-a', '1.2.3')).toBe(true)
  expect(exemptionAllows(exemptions, '@acme/plug-a', '1.2.4')).toBe(false)
  expect(exemptionAllows(exemptions, '@acme/plug-b', '1.2.3')).toBe(false)
  expect(exemptionAllows(exemptions, '@acme/plug-a', undefined)).toBe(false)
})

test('version-exemptions：列出包名、版本与当前运行时', async () => {
  const result = await runPlugin(['version-exemptions', '--profile', 'probe'])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toMatch(/@acme\/plug-a@1\.2\.3/)
  expect(result.out).toContain(DSH_CONTRACT_VERSION)
  expect(result.out).toMatch(/对当前运行时有效/)
})

test('version-exemptions：按旧运行时登记的授权标「不起作用」并给出重按命令', async () => {
  // 单独一个 profile：上一个用例的账本还要留给 revoke-version。
  const staleProfile = join(cliHome, 'profiles', 'stale')
  mkdirSync(staleProfile, { recursive: true })
  writeFileSync(
    join(staleProfile, 'compatibility.json'),
    JSON.stringify({ exemptions: [{ package: '@acme/plug-b', version: '2.0.1', dshVersion: '0.2.1' }] }, null, 2) + '\n',
    'utf8',
  )
  const result = await runPlugin(['version-exemptions', '--profile', 'stale'])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toMatch(/不是当前运行时，这条授权现在不起作用/)
  // 重按命令必须能原样复制：包名@版本、当前运行时、风险确认，一样都不能少。
  expect(result.out, result.out).toContain(
    `numa plugin allow-version @acme/plug-b@2.0.1 --dsh-version ${DSH_CONTRACT_VERSION} --accept-risk`,
  )
})

test('revoke-version：删掉那一条；再撤一次只说「没有这条授权」', async () => {
  const first = await runPlugin(['revoke-version', '@acme/plug-a@1.2.3', '--dsh-version', DSH_CONTRACT_VERSION, '--profile', 'probe'])
  expect(first.code, first.out).toBe(0)
  expect(first.out).toMatch(/已撤销/)
  expect(readCompatibility()?.exemptions).toStrictEqual([])
  const second = await runPlugin(['revoke-version', '@acme/plug-a@1.2.3', '--dsh-version', DSH_CONTRACT_VERSION, '--profile', 'probe'])
  expect(second.code, second.out).toBe(0)
  expect(second.out).toMatch(/没有这条授权/)
})

// ── 安装脚本被跳过：读 pnpm 的输出，并把下一步摆到人面前 ────────────────────────
// pnpm 10 起默认不跑第三方包的安装脚本。没有这一层的话，装完只看到「装上了」，
// 依赖原生编译的插件要到用时才炸。授权本身交给 pnpm（approve-builds），这里只钉「读得准、说得清」。
test('ignoredBuildsOf：读 pnpm ignored-builds 的列表', () => {
  const text = [
    'Automatically ignored builds during installation:',
    '  esbuild@0.21.5',
    '  sharp@0.33.0',
    '',
  ].join('\n')
  expect(ignoredBuildsOf(text)).toStrictEqual(['esbuild@0.21.5', 'sharp@0.33.0'])
})

test('ignoredBuildsOf：读 pnpm add 那一行摘要，容忍句末的点', () => {
  expect(ignoredBuildsOf('Ignored build scripts: esbuild@0.21.5, sharp@0.33.0.\n')).toStrictEqual([
    'esbuild@0.21.5',
    'sharp@0.33.0',
  ])
})

test('ignoredBuildsOf：没写版本的裸包名也认（别拿 @ 或 / 当判据）', () => {
  const text = ['Automatically ignored builds during installation:', '  esbuild', '  @scope/thing@1.0.0', ''].join('\n')
  expect(ignoredBuildsOf(text)).toStrictEqual(['esbuild', '@scope/thing@1.0.0'])
})

test('ignoredBuildsOf：没有 node_modules 时不当成一堆包名', () => {
  expect(
    ignoredBuildsOf('Automatically ignored builds during installation:\n  Cannot identify as no node_modules found\n'),
  ).toStrictEqual([])
  expect(ignoredBuildsOf('')).toStrictEqual([])
})

test('installScriptsAdvice：说清跳过了谁、不影响装载、以及在哪授权', () => {
  const advice = installScriptsAdvice(['esbuild@0.21.5'], profileDir)
  expect(advice).toMatch(/esbuild@0\.21\.5/)
  expect(advice).toMatch(/照样能装载/)
  expect(advice, advice).toContain('pnpm approve-builds')
  expect(advice, advice).toContain(profileDir)
})

test('builds：列这个 profile 被跳过的脚本，并给出授权命令', async () => {
  // 先把 profile 的清单铺出来（跑过一次 add 的 profile 一定有它）；没有清单时那句
  // 「还没建这个 profile」是另一条分支，这里顺手一起钉住。
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"name":"probe","private":true}\n', 'utf8')
  const result = await runPlugin(['builds', '--profile', 'probe'])
  expect(result.code, result.out).toBe(0)
  expect(result.out).toMatch(/被跳过的安装脚本/)
  expect(result.out).toMatch(/pnpm approve-builds/)
})

test('用法里列出了 builds', async () => {
  const result = await runPlugin(['no-such-subcommand'])
  expect(result.code).toBe(1)
  expect(result.out).toMatch(/builds/)
})
