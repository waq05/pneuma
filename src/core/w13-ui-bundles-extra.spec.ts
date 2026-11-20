/**
 * `core/ui-bundles.ts` 的缺口补齐（W13）：产物自述的坏形状、第三方信任扫描的缺清单行、
 * 组合包声明里「exports 有但没给可用入口」与 node_modules 目录形状异常时的降级。
 *
 * 夹具照抄 `ui-bundles.spec.ts` 的做法：`DSC_HOME` 指到临时目录、每个用例用新子目录
 * （模块级缓存按目录分键，不会串味）。这里只补那边没造过的坏形状，正常路径不重复。
 *
 * @module dsc/core/w13-ui-bundles-extra.spec
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../tests/support/tmp-dir.js'

const HOME = createTempDir('dsc-w13-ui-bundles-')
process.env['DSC_HOME'] = HOME

let ui: typeof import('./ui-bundles.js')
let n = 0

beforeAll(async () => {
  ui = await import('./ui-bundles.js')
}, 30_000)

beforeEach(() => {
  n += 1
  // 启停 / 信任记录每次从干净的一份开始。
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

/** 一个新的插件根（根清单只写壳契约版本）。 */
function builtinRoot(apiVersion = '2.0.0'): string {
  const dir = join(HOME, `builtin-${String(n)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, ui.UI_PLUGIN_MANIFEST), JSON.stringify({ apiVersion }), 'utf8')
  return dir
}

/** 在插件根下写一份自述（内容原样）。 */
function writeBundle(root: string, id: string, bundle: unknown, client: string | null = ''): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, ui.UI_PLUGIN_BUNDLE), typeof bundle === 'string' ? bundle : JSON.stringify(bundle), 'utf8')
  if (client !== null) writeFileSync(join(dir, 'client.js'), client, 'utf8')
  return dir
}

describe('产物自述的坏形状', () => {
  test('bundle.json 顶层不是对象（数组）：点名跳过，不把它当条目', () => {
    const root = builtinRoot()
    writeBundle(root, 'arrayish', [])
    const report = ui.readUiPluginManifestReport(root)
    expect(report.entries).toEqual([])
    expect(report.problems.some((line) => line.includes('不是对象'))).toBe(true)
  })

  test('bundle.json 写着自己的 id 与目录名不一致：id 由位置决定，丢弃并说明', () => {
    const root = builtinRoot()
    writeBundle(root, 'alpha', { id: 'beta', file: 'client.js' }, 'alpha bytes')
    const report = ui.readUiPluginManifestReport(root)
    expect(report.entries).toEqual([])
    expect(report.problems.some((line) => line.includes('与目录名/位置上那个不一致'))).toBe(true)
  })
})

describe('第三方信任扫描：缺清单与「有清单没产物」两类行', () => {
  function thirdRoot(): string {
    return join(HOME, `third-${String(n)}`)
  }

  test('目录还不存在：信任卡给空表（还没装过第三方是正常态）', () => {
    expect(ui.scanThirdPartyUiTrusts('2.0.0', new Set(), join(thirdRoot(), 'missing'))).toEqual([])
  })

  test('只有 ui/client.js、没有 plugin.json：信任卡上要有一行说明缺清单', () => {
    const root = thirdRoot()
    mkdirSync(join(root, 'only-client', 'ui'), { recursive: true })
    writeFileSync(join(root, 'only-client', 'ui', 'client.js'), 'console.log(1)\n', 'utf8')
    const rows = ui.scanThirdPartyUiTrusts('2.0.0', new Set(), root)
    const row = rows.find((item) => item.name === 'only-client')
    expect(row).toBeDefined()
    expect(row?.problemKind).toBe('manifest')
    expect(row?.problem).toContain('没有 plugin.json')
  })

  test('plugin.json 的 phase 坏：记一条问题（当没声明），不影响后面判定', () => {
    const root = thirdRoot()
    mkdirSync(join(root, 'weird-phase', 'ui'), { recursive: true })
    writeFileSync(join(root, 'weird-phase', 'plugin.json'), JSON.stringify({ api: '^2.0.0', phase: 'whenever' }), 'utf8')
    writeFileSync(join(root, 'weird-phase', 'ui', 'client.js'), 'console.log(2)\n', 'utf8')
    const report = ui.discoverThirdPartyUiArtifacts('2.0.0', new Set(), root)
    expect(report.entries).toEqual([])
    expect(report.problems.some((line) => line.includes("phase 只能是 'early' / 'application'"))).toBe(true)
  })

  test('信过之后 ui/client.js 不见了：点名「plugin.json 在，但产物读不到」', () => {
    const root = thirdRoot()
    const dir = join(root, 'lost-client')
    mkdirSync(join(dir, 'ui'), { recursive: true })
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ api: '^2.0.0' }), 'utf8')
    writeFileSync(join(dir, 'ui', 'client.js'), 'console.log(3)\n', 'utf8')
    const trusted = ui.trustThirdPartyUiPlugin('lost-client', '2.0.0', new Set(), root)
    expect(trusted).toMatchObject({ ok: true })
    rmSync(join(dir, 'ui', 'client.js'))
    const report = ui.discoverThirdPartyUiArtifacts('2.0.0', new Set(), root)
    expect(report.entries).toEqual([])
    expect(report.problems.some((line) => line.includes('plugin.json 在，但 ui/client.js 读不到'))).toBe(true)
  })

  test('services 声明坏了：记一条问题、当没声明处理；声明合法时原样带进条目', () => {
    const root = thirdRoot()
    const dir = join(root, 'bad-services')
    mkdirSync(join(dir, 'ui'), { recursive: true })
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ api: '^2.0.0', services: [1, ''] }), 'utf8')
    writeFileSync(join(dir, 'ui', 'client.js'), 'console.log(4)\n', 'utf8')
    expect(ui.trustThirdPartyUiPlugin('bad-services', '2.0.0', new Set(), root)).toMatchObject({ ok: true })
    const report = ui.discoverThirdPartyUiArtifacts('2.0.0', new Set(), root)
    expect(report.entries.map((entry) => entry.id)).toContain('bad-services')
    expect(report.problems.some((line) => line.includes('services 必须是非空字符串数组'))).toBe(true)
    // 合法值这条路：services 用非空字符串数组时原样进条目（不是被上面那条坏了就整批丢）。
    const good = join(root, 'good-services')
    mkdirSync(join(good, 'ui'), { recursive: true })
    writeFileSync(join(good, 'plugin.json'), JSON.stringify({ api: '^2.0.0', services: ['terminal'] }), 'utf8')
    writeFileSync(join(good, 'ui', 'client.js'), 'console.log(6)\n', 'utf8')
    expect(ui.trustThirdPartyUiPlugin('good-services', '2.0.0', new Set(), root)).toMatchObject({ ok: true })
    const merged = ui.discoverThirdPartyUiArtifacts('2.0.0', new Set(), root)
    expect(merged.entries.find((entry) => entry.id === 'good-services')?.services).toEqual(['terminal'])
  })

  test('信任落盘时 plugins.json 坏掉：拒绝覆盖，把原因原样交回', () => {
    const root = thirdRoot()
    const dir = join(root, 'plain')
    mkdirSync(join(dir, 'ui'), { recursive: true })
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ api: '^2.0.0' }), 'utf8')
    writeFileSync(join(dir, 'ui', 'client.js'), 'console.log(5)\n', 'utf8')
    writeFileSync(join(HOME, 'plugins.json'), '{broken', 'utf8')
    const result = ui.trustThirdPartyUiPlugin('plain', '2.0.0', new Set(), root)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  })
})

describe('组合包声明与 node_modules 形状异常时的降级', () => {
  function profileRoot(): string {
    return join(HOME, `profile-${String(n)}`)
  }

  /** 写一个包目录（package.json 内容原样；`exports` 由调用方给）。 */
  function addPackage(profile: string, name: string, manifest: unknown, client = 'pkg client\n'): string {
    const dir = join(profile, 'node_modules', ...name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8')
    if (client !== '') writeFileSync(join(dir, 'client.js'), client, 'utf8')
    return dir
  }

  test('package.json 不是合法 JSON：该包当「没有声明」跳过，不抛', () => {
    const profile = profileRoot()
    addPackage(profile, 'broken-json', '{not json')
    const report = ui.discoverPackageUiArtifacts(profile, '2.0.0', new Set())
    expect(report.entries).toEqual([])
  })

  test('exports["./client"] 是条件对象但没有任何可用键：入口判为缺失', () => {
    const profile = profileRoot()
    addPackage(profile, 'bad-conditions', {
      version: '1.0.0',
      pneuma: { client: { platform: 'pneuma', api: '^2.0.0' } },
      exports: { './client': { browser: './client.js' } },
    })
    const report = ui.discoverPackageUiArtifacts(profile, '2.0.0', new Set())
    expect(report.entries).toEqual([])
    expect(report.problems.length).toBeGreaterThan(0)
  })

  test('node_modules 本身是个文件：包列表给空表，不抛', () => {
    const profile = profileRoot()
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'node_modules'), 'not a dir', 'utf8')
    const report = ui.discoverPackageUiArtifacts(profile, '2.0.0', new Set())
    expect(report.entries).toEqual([])
  })

  test('@scope 是个文件（不是目录）：跳过这一项，好包照常收', () => {
    const profile = profileRoot()
    const nodeModules = join(profile, 'node_modules')
    mkdirSync(nodeModules, { recursive: true })
    writeFileSync(join(nodeModules, '@scope'), 'oops', 'utf8')
    addPackage(profile, 'good-pkg', {
      version: '1.0.0',
      pneuma: { client: { platform: 'pneuma', api: '^2.0.0' } },
      exports: { './client': './client.js' },
    })
    const report = ui.discoverPackageUiArtifacts(profile, '2.0.0', new Set())
    expect(report.entries.map((entry) => entry.id)).toContain('good-pkg')
  })
})
