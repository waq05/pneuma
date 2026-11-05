/**
 * `@pneuma/cli` 的包级测试：钉入口表、产物与版本豁免三个子命令。
 *
 * 为什么子命令要真 spawn：这层逻辑住在「内核起来之前」的脚本里（顶层读 argv、process.exit），
 * 当函数 import 根本跑不起来；而版本豁免的要点恰恰是**退出码与写盘副作用**（不给
 * --accept-risk 就不许写盘），只能对着子进程验。HOME 用临时目录，不碰真实 ~/.dsc。
 * @module @pneuma/cli/tests
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
let passed = 0

test('库包身份：private + pneuma.library，且没有装配行', () => {
  assert.equal(pkg.private, true)
  assert.equal(pkg.pneuma.library, true)
  assert.equal(pkg.pneuma.bundle, undefined)
  assert.ok(!existsSync(new URL('../cordis.patch.yml', import.meta.url)))
  passed += 1
})

test('入口表里的每个文件都在源码里', () => {
  const entry = read('../index.ts')
  for (const file of ['config-cli.ts', 'plugin-cli.ts']) {
    // 表里写的是产物名（.js），源码是 .ts：比的是同一个 basename。
    assert.ok(entry.includes(file.replace(/\.ts$/, '.js')), `index.ts 的入口表没写 ${file}`)
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} 不在包里`)
  }
  passed += 1
})

test('入口表导出的是产物文件名（.js 而不是 .ts）', async () => {
  const mod = await import('../../../../lib/packages/cli/index.js')
  assert.deepEqual(mod.CLI_ENTRIES, { config: 'config-cli.js', plugin: 'plugin-cli.js' })
  passed += 1
})

test('两个脚本都在顶层收尾（process.exit），不会被当库 import', () => {
  for (const file of ['config-cli.ts', 'plugin-cli.ts']) {
    assert.match(read(`../${file}`), /process\.exit\(/, `${file} 没有 process.exit：它还是库的形状`)
  }
  passed += 1
})

test('README 两段都在', () => {
  const text = read('../README.md')
  assert.match(text, /^## Model Experience/m)
  assert.match(text, /^## Known Limitations/m)
  passed += 1
})

// ── 版本豁免三个子命令：真 spawn 一次编译产物 ────────────────────────────────────
//
// 用临时 DSC_HOME + 临时 profile：断言的是「退出码 + 写盘形状」，不碰用户真实的 ~/.dsc。
const CLI_FILE = fileURLToPath(new URL('../../../../lib/packages/cli/plugin-cli.js', import.meta.url))
const cliHome = mkdtempSync(join(tmpdir(), 'numa-cli-test-'))
const profileDir = join(cliHome, 'profiles', 'probe')
const compatibilityFile = join(profileDir, 'compatibility.json')
const runtimeVersion = (await import('../../../../lib/core/plugin-bundle.js')).DSH_CONTRACT_VERSION

/** 跑一次编译后的 `numa plugin`；stdout/stderr 一起回来看。 */
const runCli = (args) => {
  const result = spawnSync(process.execPath, [CLI_FILE, ...args], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    encoding: 'utf8',
    env: { ...process.env, DSC_HOME: cliHome, DSC_UI_SERVER: '0', DSC_PROFILE: '' },
  })
  return { code: result.status, out: result.stdout + result.stderr }
}

/** 读 profile 的 compatibility.json（还没写过给 null）。 */
const readCompatibility = () => (existsSync(compatibilityFile) ? JSON.parse(readFileSync(compatibilityFile, 'utf8')) : null)

test('version-exemptions：没有登记时明说没有豁免', () => {
  const result = runCli(['version-exemptions', '--profile', 'probe'])
  assert.equal(result.code, 0, result.out)
  assert.match(result.out, /没有登记豁免/)
  passed += 1
})

test('allow-version：不给 --accept-risk 就拒绝写盘，并打印风险原文', () => {
  const result = runCli(['allow-version', '@acme/plug-a@1.2.3', '--dsh-version', runtimeVersion, '--profile', 'probe'])
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, /不兼容插件可能崩溃或丢数据/)
  assert.match(result.out, /只对这一个版本组合有效/)
  assert.equal(existsSync(compatibilityFile), false, '没授权也写了盘')
  passed += 1
})

test('allow-version：运行时版本对不上时拒绝', () => {
  const result = runCli(['allow-version', '@acme/plug-a@1.2.3', '--dsh-version', '9.9.9', '--accept-risk', '--profile', 'probe'])
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, /运行时对不上/)
  assert.equal(existsSync(compatibilityFile), false)
  passed += 1
})

test('allow-version：区间版本不收（豁免只对确定的版本有意义）', () => {
  const result = runCli(['allow-version', '@acme/plug-a@^1.2.0', '--dsh-version', runtimeVersion, '--accept-risk', '--profile', 'probe'])
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, /精确版本/)
  passed += 1
})

test('allow-version：带 --accept-risk 才写，形状与 readProfile 的解析兼容', async () => {
  const result = runCli(['allow-version', '@acme/plug-a@1.2.3', '--dsh-version', runtimeVersion, '--accept-risk', '--profile', 'probe'])
  assert.equal(result.code, 0, result.out)
  assert.match(result.out, /已登记豁免/)
  const doc = readCompatibility()
  assert.equal(doc.exemptions.length, 1)
  assert.deepEqual(doc.exemptions[0], { package: '@acme/plug-a', version: '1.2.3', dshVersion: runtimeVersion })
  // 版本闸读的就是 readProfile().exemptions：这条记录必须原样出现在里面，否则等于没登记。
  const { readProfile, exemptionAllows } = await import('../../../../lib/core/plugin-bundle.js')
  const exemptions = readProfile(profileDir).exemptions
  assert.deepEqual(exemptions, [{ package: '@acme/plug-a', version: '1.2.3', dshVersion: runtimeVersion }])
  // 精确到版本：同一个包换个版本就不放行（一次点头不该永久有效）。
  assert.equal(exemptionAllows(exemptions, '@acme/plug-a', '1.2.3'), true)
  assert.equal(exemptionAllows(exemptions, '@acme/plug-a', '1.2.4'), false)
  assert.equal(exemptionAllows(exemptions, '@acme/plug-b', '1.2.3'), false)
  assert.equal(exemptionAllows(exemptions, '@acme/plug-a', undefined), false)
  passed += 1
})

test('version-exemptions：列出包名、版本与当前运行时', () => {
  const result = runCli(['version-exemptions', '--profile', 'probe'])
  assert.equal(result.code, 0, result.out)
  assert.match(result.out, /@acme\/plug-a@1\.2\.3/)
  assert.ok(result.out.includes(runtimeVersion), result.out)
  assert.match(result.out, /对当前运行时有效/)
  passed += 1
})

test('revoke-version：删掉那一条；再撤一次只说「没有这条授权」', () => {
  const first = runCli(['revoke-version', '@acme/plug-a@1.2.3', '--dsh-version', runtimeVersion, '--profile', 'probe'])
  assert.equal(first.code, 0, first.out)
  assert.match(first.out, /已撤销/)
  assert.deepEqual(readCompatibility().exemptions, [])
  const second = runCli(['revoke-version', '@acme/plug-a@1.2.3', '--dsh-version', runtimeVersion, '--profile', 'probe'])
  assert.equal(second.code, 0, second.out)
  assert.match(second.out, /没有这条授权/)
  passed += 1
})

// ── 安装脚本被跳过：读 pnpm 的输出，并把下一步摆到人面前 ────────────────────────
// pnpm 10 起默认不跑第三方包的安装脚本。没有这一层的话，装完只看到「装上了」，
// 依赖原生编译的插件要到用时才炸。授权本身交给 pnpm（approve-builds），这里只钉「读得准、说得清」。
test('ignoredBuildsOf：读 pnpm ignored-builds 的列表', async () => {
  const { ignoredBuildsOf } = await import('../../../../lib/packages/cli/pnpm-builds.js')
  const text = [
    'Automatically ignored builds during installation:',
    '  esbuild@0.21.5',
    '  sharp@0.33.0',
    '',
  ].join('\n')
  assert.deepEqual(ignoredBuildsOf(text), ['esbuild@0.21.5', 'sharp@0.33.0'])
  passed += 1
})

test('ignoredBuildsOf：读 pnpm add 那一行摘要，容忍句末的点', async () => {
  const { ignoredBuildsOf } = await import('../../../../lib/packages/cli/pnpm-builds.js')
  assert.deepEqual(ignoredBuildsOf('Ignored build scripts: esbuild@0.21.5, sharp@0.33.0.\n'), ['esbuild@0.21.5', 'sharp@0.33.0'])
  passed += 1
})

test('ignoredBuildsOf：没写版本的裸包名也认（别拿 @ 或 / 当判据）', async () => {
  const { ignoredBuildsOf } = await import('../../../../lib/packages/cli/pnpm-builds.js')
  const text = ['Automatically ignored builds during installation:', '  esbuild', '  @scope/thing@1.0.0', ''].join('\n')
  assert.deepEqual(ignoredBuildsOf(text), ['esbuild', '@scope/thing@1.0.0'])
  passed += 1
})

test('ignoredBuildsOf：没有 node_modules 时不当成一堆包名', async () => {
  const { ignoredBuildsOf } = await import('../../../../lib/packages/cli/pnpm-builds.js')
  assert.deepEqual(ignoredBuildsOf('Automatically ignored builds during installation:\n  Cannot identify as no node_modules found\n'), [])
  assert.deepEqual(ignoredBuildsOf(''), [])
  passed += 1
})

test('installScriptsAdvice：说清跳过了谁、不影响装载、以及在哪授权', async () => {
  const { installScriptsAdvice } = await import('../../../../lib/packages/cli/pnpm-builds.js')
  const advice = installScriptsAdvice(['esbuild@0.21.5'], profileDir)
  assert.match(advice, /esbuild@0\.21\.5/)
  assert.match(advice, /照样能装载/)
  assert.ok(advice.includes('pnpm approve-builds'), advice)
  assert.ok(advice.includes(profileDir), advice)
  passed += 1
})

test('builds：列这个 profile 被跳过的脚本，并给出授权命令', () => {
  // 先把 profile 的清单铺出来（跑过一次 add 的 profile 一定有它）；没有清单时那句
  // 「还没建这个 profile」是另一条分支，这里顺手一起钉住。
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"name":"probe","private":true}\n', 'utf8')
  const result = runCli(['builds', '--profile', 'probe'])
  assert.equal(result.code, 0, result.out)
  assert.match(result.out, /被跳过的安装脚本/)
  assert.match(result.out, /pnpm approve-builds/)
  passed += 1
})

test('用法里列出了 builds', () => {
  const result = runCli(['no-such-subcommand'])
  assert.equal(result.code, 1)
  assert.match(result.out, /builds/)
  passed += 1
})

after(() => {
  console.log(`通过 ${String(passed)} 项`)
  // 临时 HOME 用完就删：里面只有这轮造出来的 profile，不留尾巴。
  rmSync(cliHome, { recursive: true, force: true })
})
