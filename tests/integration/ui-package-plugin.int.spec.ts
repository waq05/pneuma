/**
 * 组合包的界面半边：发现、门禁、启动图、信任卡、启停（迁自
 * `scripts/ui-package-plugin-test.mjs` 全部段落）。
 *
 * 一个包声明 `pneuma.client.platform = 'pneuma'`（外加 api 区间与 `exports["./client"]`），
 * 宿主把它收进启动图。这条链的判定口全在 `core/` 的纯函数 + 文件系统上：
 *   ① 发现与门禁：platform 收编 / api 区间 / 缺入口 / 坏载体整条拒；
 *   ② 取字节与组图：内容寻址 rev、按 exports 读字节、进启动图；
 *   ③ 远程壳（手机）与桌面壳共用 createUiBootSource——同一张图；
 *   ④ 插件中心的卡与启停：key / origin / version / profile / problemKind，第三方组同形；
 *   ⑤ 停用走 plugins.json 的条目树：产物表消失、卡片还在（enabled=false）、再开回来。
 *
 * 为什么是 integration：全链在真实文件系统上跑（profile / third-party / plugins.json），
 * `writePluginEnabled` 的落盘位置由 `DSC_HOME`（HOME 派生）在模块加载时算定，
 * `tests/setup/temp-home.ts` 提供的隔离与其它集成用例同一口径。不起内核，无需先 build。
 *
 * 夹具声明的兼容区间跟壳版本走：版本号每次发版都动，钉死字面量会让夹具每逢发版红一次。
 *
 * @module dsc/tests/integration/ui-package-plugin
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  collectUiArtifactsForPlatform,
  isPackageUiEntry,
  isThirdPartyUiEntry,
  lookupPackageUiBundle,
  readUiArtifactBytes,
  scanPackageUiTrusts,
  scanThirdPartyUiTrusts,
  toUiPluginRows,
} from '@pneuma/runtime/core/ui-bundles.js'
import { writePluginEnabled } from '@pneuma/runtime/core/plugin-registry.js'
import { composeUiBootGraph } from '@pneuma/runtime/core/ui-manifest.js'
import { createUiBootSource } from '@pneuma/runtime/core/ui-boot-source.js'

/** 夹具声明的 api 区间跟壳版本走（`^<壳版本>`）。 */
const shellPackageJson = JSON.parse(
  readFileSync(new URL('../../ui-shell/package.json', import.meta.url), 'utf8'),
) as { version: string }
const SHELL_VERSION = shellPackageJson.version
const SHELL_API = `^${SHELL_VERSION}`

const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
const profile = join(home, 'profile')
const third = join(home, 'third-party')
mkdirSync(third, { recursive: true })

/**
 * 内置产物清单的替身：`uiPluginsDir()` 基于模块自身位置解析（lib 下跑 → `lib/ui/plugins`
 * 的真清单；vitest 从 src 装载 → `src/ui/plugins` 不存在 → apiVersion 缺失 → 门禁按
 * 「不知道对着哪个壳写的」失败关闭）。组合包的判定只用 apiVersion 与 takenIds 基线，
 * 这里给一份带壳版本、零内置行的清单，与探针跑 lib 时读到的语义一致，也让 spec 不依赖
 * `lib/` 产物的新鲜度。
 */
const builtinDir = join(home, 'builtin')
mkdirSync(builtinDir, { recursive: true })
writeFileSync(
  join(builtinDir, 'manifest.json'),
  JSON.stringify({ version: 1, apiVersion: SHELL_VERSION, plugins: [] }),
  'utf8',
)

/** 一段最小的界面半 bundle（组合包与第三方夹具共用）。 */
const bundle = "module.exports = { name: '成本条', apply(ui) { ui.slots.register('composer.footer', { id: 'cost' }, () => null) } }\n"

/** 在 profile 下写一个组合包夹具（package.json + 可选文件）。 */
function writePackage(name: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = join(profile, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }, null, 2), 'utf8')
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }
  return dir
}

/** 载体声明里 client 端的标准形状。 */
const clientExports = { exports: { './client': { default: './lib/client.js' } } }

writePackage('dsh-cost-meter', {
  dsh: { client: { platform: 'pneuma', api: SHELL_API, inject: [] } },
  ...clientExports,
}, { 'lib/client.js': bundle })

// dsh 自己的载体（web）：只列不加载，不进启动图
writePackage('dsh-other', { dsh: { client: { platform: 'web', api: SHELL_API } }, ...clientExports }, { 'lib/client.js': bundle })
// 缺 api
writePackage('no-api', { dsh: { client: { platform: 'pneuma' } }, ...clientExports }, { 'lib/client.js': bundle })
// api 对不上（1.x 的壳契约）
writePackage('old-api', { dsh: { client: { platform: 'pneuma', api: '^1.0.0' } }, ...clientExports }, { 'lib/client.js': bundle })
// 没有 exports["./client"]
writePackage('no-entry', { dsh: { client: { platform: 'pneuma', api: SHELL_API } } })
// 载体声明写坏（'term' 不是认得的载体）：整条拒掉，不静默按 web 处理
writePackage('bad-platforms', {
  dsh: { client: { platform: 'pneuma', api: SHELL_API, platforms: ['web', 'term'] } },
  ...clientExports,
}, { 'lib/client.js': bundle })
// 声明同时服务终端壳（platforms: [web, tui]）：一份代码出两行，两个载体各取各的
writePackage('both-shells', {
  dsh: { client: { platform: 'pneuma', api: SHELL_API, platforms: ['web', 'tui'] } },
  ...clientExports,
}, { 'lib/client.js': bundle })
// services / phase：与内置产物、第三方同一套字段（坏值要记问题，不能静默丢）
writePackage('declared-deps', {
  dsh: { client: { platform: 'pneuma', api: SHELL_API, services: ['probe.seat'], phase: 'early' } },
  ...clientExports,
}, { 'lib/client.js': bundle })
writePackage('bad-deps', {
  dsh: { client: { platform: 'pneuma', api: SHELL_API, services: 'probe.seat', phase: 'soon' } },
  ...clientExports,
}, { 'lib/client.js': bundle })

const artifacts = collectUiArtifactsForPlatform('web', { packageDir: profile, thirdPartyDir: third, builtinDir, force: true })
const entry = artifacts.entries.find((item) => item.id === 'dsh-cost-meter')
const problems = artifacts.problems.join('；')

afterAll(() => {
  // 停用实验的收尾：把夹具键还原成启用，不给同 worker 里排后面的文件留 disabled 残留。
  writePluginEnabled('dsh-cost-meter/client', true)
})

describe('发现与门禁', () => {
  test('platform = pneuma 的包被收进产物表，来源标 package，rev 是 16 位内容摘要', () => {
    expect(entry).toBeDefined()
    // origin 只在组合包与第三方的行上有（内置行的形状没有它）——按探针口径动态读。
    expect((entry as { origin?: string } | undefined)?.origin).toBe('package')
    expect(entry?.rev).toMatch(/^[0-9a-f]{16}$/)
  })

  test('platform = web 的包不进启动图（只列不加载）', () => {
    expect(artifacts.entries.some((item) => item.id === 'dsh-other')).toBe(false)
  })

  test('缺 api / api 对不上 / 没有入口 / 坏载体：整条拒并说清原因', () => {
    expect(problems).toContain('no-api')
    expect(problems).toContain('api')
    expect(problems).toContain('old-api')
    expect(problems).toContain('no-entry')
    expect(problems).toContain('bad-platforms')
    expect(problems).toContain('platforms')
  })

  test('services 与 phase 收进条目（与内置产物同一套字段）；坏值记 problems', () => {
    const depsEntry = artifacts.entries.find((item) => item.id === 'declared-deps')
    expect(depsEntry?.services?.join(',')).toBe('probe.seat')
    expect(depsEntry?.phase).toBe('early')
    expect(problems).toContain('bad-deps')
    expect(problems).toContain('pneuma.client.services')
    expect(problems).toContain('pneuma.client.phase')
  })

  test('缺省只服务 web：终端壳的产物表里没有它；声明 platforms: [web, tui] 后两个壳都收', () => {
    const tuiArtifacts = collectUiArtifactsForPlatform('tui', { packageDir: profile, thirdPartyDir: third, builtinDir, force: true })
    expect(tuiArtifacts.entries.some((item) => item.id === 'dsh-cost-meter')).toBe(false)
    expect(tuiArtifacts.entries.some((item) => item.id === 'both-shells' && item.platform === 'tui')).toBe(true)
    // web 视图里同一份包也在（platform 缺省即 web）。
    expect(artifacts.entries.some((item) => item.id === 'both-shells' && item.platform === undefined)).toBe(true)
  })
})

describe('取字节与组图', () => {
  test('按条目读出字节（入口由包的 exports 决定），按 rev 查得到当前字节', () => {
    expect(entry).toBeDefined()
    if (entry === undefined) return
    const bytes = readUiArtifactBytes(entry, { packageDir: profile })
    expect(bytes?.toString('utf8')).toBe(bundle)
    const hit = lookupPackageUiBundle('dsh-cost-meter', 'client.js', String(entry.rev), profile)
    expect(hit.known).toBe(true)
    expect(hit.current).toBe(true)
    expect(hit.body !== null).toBe(true)
  })

  test('进得了启动图，地址是内容寻址的 /plugins/<包名>/client.js?rev=', () => {
    const graph = composeUiBootGraph({ name: 'Pneuma', version: 'test' }, toUiPluginRows(artifacts.entries))
    const row = graph.entries.find((item) => item.id === 'dsh-cost-meter')
    expect(row).toBeDefined()
    expect(row?.url.includes('dsh-cost-meter/client.js?rev=')).toBe(true)
  })
})

describe('远程壳（手机）那张图里也要有', () => {
  // 远程壳与本机界面服务共用 createUiBootSource，缺省按 DSC_PROFILE 解析 profile；
  // 这里显式传 packageDir，钉住「手机端看的是同一张图」。
  function remoteSource(): ReturnType<typeof createUiBootSource> {
    return createUiBootSource({
      host: { name: 'Pneuma', version: 'test' },
      builtinDir,
      thirdPartyDir: third,
      packageDir: profile,
    })
  }

  test('远程壳的启动图里有这条包界面半，stat 的是包自己的入口（不是内置目录里的同名文件）', () => {
    const remote = remoteSource()
    const remoteGraph = remote.graph()
    expect(remoteGraph.entries.some((item) => item.id === 'dsh-cost-meter')).toBe(true)
    const watched = remote.watchRows().find((item) => item.id === 'dsh-cost-meter')
    expect(watched?.path).toBe(join(profile, 'node_modules', 'dsh-cost-meter', 'lib', 'client.js'))
  })

  test('远程壳取字节走同一条内容寻址查询', () => {
    expect(entry).toBeDefined()
    if (entry === undefined) return
    const served = lookupPackageUiBundle('dsh-cost-meter', 'client.js', String(entry.rev), profile)
    expect(served.known).toBe(true)
    expect(served.current).toBe(true)
    expect(served.body !== null).toBe(true)
  })
})

describe('插件中心那张卡与启停入口', () => {
  test('卡上看得见这条包界面半：来源 package、键 <包名>/client、恒为已同意', () => {
    const trusts = scanPackageUiTrusts(artifacts.apiVersion, new Set(), profile)
    const costRow = trusts.find((item) => item.name === 'dsh-cost-meter')
    expect(costRow).toBeDefined()
    expect(costRow?.origin).toBe('package')
    expect(costRow?.key).toBe('dsh-cost-meter/client')
    expect(costRow?.trusted).toBe(true)
    expect(costRow?.trustedAt).toBeUndefined()
  })

  test('卡上带包版本与 profile 名（装了多个 profile / 升了版能看出来），http 取字节不受影响', () => {
    const trusts = scanPackageUiTrusts(artifacts.apiVersion, new Set(), profile)
    const costRow = trusts.find((item) => item.name === 'dsh-cost-meter')
    expect(costRow?.version).toBe('1.0.0')
    expect(costRow?.profile).toBe('profile')
    expect(typeof costRow?.api).toBe('string')
  })

  test('卡上不带 dsh 自己的载体（platform = web）；坏夹具行带对应的 problemKind 档', () => {
    const trusts = scanPackageUiTrusts(artifacts.apiVersion, new Set(), profile)
    expect(trusts.some((item) => item.name === 'dsh-other')).toBe(false)
    expect(trusts.find((item) => item.name === 'no-api')?.problemKind).toBe('manifest')
    expect(trusts.find((item) => item.name === 'old-api')?.problemKind).toBe('version')
    expect(trusts.find((item) => item.name === 'no-entry')?.problemKind).toBe('artifact')
  })

  test('第三方那组每行也带 key 与 origin（两处同形），但没有版本与 profile（不许冒充组合包）', () => {
    const demo = join(third, 'demo-third', 'ui')
    mkdirSync(demo, { recursive: true })
    writeFileSync(join(third, 'demo-third', 'plugin.json'), JSON.stringify({ api: SHELL_API }), 'utf8')
    writeFileSync(join(demo, 'client.js'), bundle, 'utf8')
    const thirdRows = scanThirdPartyUiTrusts(artifacts.apiVersion, new Set(), third)
    expect(thirdRows).toHaveLength(1)
    expect(thirdRows[0]?.key).toBe('demo-third/ui/client.js')
    expect(thirdRows[0]?.origin).toBe('third-party')
    expect(thirdRows[0]?.version).toBeUndefined()
    expect(thirdRows[0]?.profile).toBeUndefined()
  })

  test('isPackageUiEntry / isThirdPartyUiEntry：两条路不混', () => {
    expect(isPackageUiEntry('dsh-cost-meter/client', profile)).toBe(true)
    expect(isPackageUiEntry('goal', profile)).toBe(false)
    expect(isPackageUiEntry('dsh-other/client', profile)).toBe(false)
    // 对声明了但坏掉的包仍认（它确实是我们的界面半）。
    expect(isPackageUiEntry('no-entry/client', profile)).toBe(true)
    expect(isThirdPartyUiEntry('dsh-cost-meter/client')).toBe(false)
  })

  test('停用走 plugins.json 的条目树：产物表消失、卡片还在（enabled=false）、再开回来', () => {
    writePluginEnabled('dsh-cost-meter/client', false)
    const afterOff = collectUiArtifactsForPlatform('web', { packageDir: profile, thirdPartyDir: third, builtinDir, force: true })
    expect(afterOff.entries.some((item) => item.id === 'dsh-cost-meter')).toBe(false)
    // 停用的 id 单独列出来（装载器要能说「被停用了」）。
    expect(afterOff.disabled).toContain('dsh-cost-meter')
    const offRow = scanPackageUiTrusts(afterOff.apiVersion, new Set(), profile).find(
      (item) => item.name === 'dsh-cost-meter',
    )
    expect(offRow?.enabled).toBe(false)

    writePluginEnabled('dsh-cost-meter/client', true)
    const afterOn = collectUiArtifactsForPlatform('web', { packageDir: profile, thirdPartyDir: third, builtinDir, force: true })
    expect(afterOn.entries.some((item) => item.id === 'dsh-cost-meter')).toBe(true)
  })
})
