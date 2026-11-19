/**
 * 界面插件产物（`core/ui-bundles.ts`）：清单解析、API 门禁、内容寻址缓存、第三方与组合包发现/信任。
 *
 * 全部在临时 DSC_HOME 下造目录：清单与 bundle.json 是手写的，client.js 是几行文本。
 * 进程内的模块级缓存按目录分键，所以每个用例用新目录就不会串味。
 *
 * @module dsc/core/ui-bundles.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-ui-bundles-'))
process.env['DSC_HOME'] = HOME

let ui: typeof import('./ui-bundles.js')
let n = 0

beforeAll(async () => {
  ui = await import('./ui-bundles.js')
})

beforeEach(() => {
  n += 1
  // 每个用例从干净的启停/信任记录开始（模块级缓存按目录分键，不会串）。
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

/** 一个新的插件根目录（root manifest 只写壳契约版本）。 */
function builtinRoot(apiVersion = '2.0.0'): string {
  const dir = mkdtempSync(join(HOME, `builtin-${String(n)}-`))
  writeFileSync(join(dir, ui.UI_PLUGIN_MANIFEST), JSON.stringify({ apiVersion }), 'utf8')
  return dir
}

/** 在插件根下写一个产物目录：bundle.json + client.js。 */
function addBundle(root: string, id: string, bundle: Record<string, unknown>, client = `console.log('${id}')\n`): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, ui.UI_PLUGIN_BUNDLE), JSON.stringify({ apiVersion: '2.0.0', ...bundle }), 'utf8')
  if (client !== '') writeFileSync(join(dir, 'client.js'), client, 'utf8')
  return dir
}

/** 写 plugins.json 的启停条目。 */
function writePluginEntries(entries: Array<{ file: string; disabled: boolean }>): void {
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries }), 'utf8')
}

/** 让文件指纹确实变一下。 */
function touch(file: string): void {
  const later = new Date(Date.now() + 5_000)
  utimesSync(file, later, later)
}

describe('evaluateUiApiGate', () => {
  test('清单没有 apiVersion：条目也没声明就拒；声明了按区间判', () => {
    expect(ui.evaluateUiApiGate(undefined, undefined)).toContain('清单没写 apiVersion')
    expect(ui.evaluateUiApiGate('^2.0.0', undefined)).toContain('清单未声明 apiVersion')
    expect(ui.evaluateUiApiGate('^3.0.0', undefined)).toContain('已跳过加载')
  })

  test('内置条目没声明 api 视为与壳同源；workspace:/坏区间/不满足都拒', () => {
    expect(ui.evaluateUiApiGate(undefined, '2.0.0')).toBeNull()
    expect(ui.evaluateUiApiGate('workspace:*', '2.0.0')).toContain('workspace:')
    expect(ui.evaluateUiApiGate('not-a-range', '2.0.0')).toContain('不是合法的 semver 区间')
    expect(ui.evaluateUiApiGate('^2.0.0', '2.0.0')).toBeNull()
  })
})

describe('readUiPluginManifestReport：根清单与每份自述', () => {
  test('目录不在：空清单，不报问题', () => {
    const report = ui.readUiPluginManifestReport(join(HOME, 'nowhere'))
    expect(report).toEqual({ entries: [], problems: [] })
  })

  test('2.0 产物：bundle.json 自述成条目，platforms 一条产物出两行', () => {
    const root = builtinRoot()
    addBundle(root, 'alpha', { file: 'client.js', platforms: ['web', 'tui'] })
    const report = ui.readUiPluginManifestReport(root)
    expect(report.apiVersion).toBe('2.0.0')
    expect(report.entries.map((entry) => `${entry.id}:${entry.platform ?? 'web'}`)).toEqual(['alpha:web', 'alpha:tui'])
    expect(report.problems).toEqual([])
  })

  test('坏自述与旧产物都点名报出来', () => {
    const root = builtinRoot()
    addBundle(root, 'good', { file: 'client.js' })
    const broken = join(root, 'broken')
    mkdirSync(broken)
    writeFileSync(join(broken, ui.UI_PLUGIN_BUNDLE), '{bad', 'utf8')
    const legacy = join(root, 'legacy')
    mkdirSync(legacy)
    writeFileSync(join(legacy, 'client.js'), 'x', 'utf8')
    const badPlatforms = join(root, 'badplat')
    mkdirSync(badPlatforms)
    writeFileSync(join(badPlatforms, ui.UI_PLUGIN_BUNDLE), JSON.stringify({ file: 'client.js', platforms: ['web', 'term'] }), 'utf8')

    const report = ui.readUiPluginManifestReport(root)
    expect(report.entries.map((entry) => entry.id)).toEqual(['good'])
    expect(report.problems.some((line) => line.includes('不是合法 JSON'))).toBe(true)
    expect(report.problems.some((line) => line.includes('没有 bundle.json'))).toBe(true)
    expect(report.problems.some((line) => line.includes("platforms 只能是 'web' / 'tui'"))).toBe(true)
  })

  test('自述里的 apiVersion 不一致：报问题并当没写', () => {
    // 根清单不写 apiVersion（旧构建没有它），版本只能从各份自述里取。
    const root = mkdtempSync(join(HOME, `bundles-only-${String(n)}-`))
    addBundle(root, 'a', { file: 'client.js', apiVersion: '2.0.0' })
    addBundle(root, 'b', { file: 'client.js', apiVersion: '3.0.0' })
    const report = ui.readUiPluginManifestReport(root)
    expect(report.apiVersion).toBeUndefined()
    expect(report.problems.some((line) => line.includes('apiVersion 不一致'))).toBe(true)
  })

  test('根清单坏掉：当没写并说明原因', () => {
    const dir = mkdtempSync(join(HOME, 'badroot-'))
    writeFileSync(join(dir, ui.UI_PLUGIN_MANIFEST), '{bad', 'utf8')
    expect(ui.readUiPluginManifestReport(dir).problems.some((line) => line.includes('不是合法 JSON'))).toBe(true)

    const array = mkdtempSync(join(HOME, 'arrayroot-'))
    writeFileSync(join(array, ui.UI_PLUGIN_MANIFEST), '[]', 'utf8')
    expect(ui.readUiPluginManifestReport(array).problems.some((line) => line.includes('顶层不是对象'))).toBe(true)

    const badApi = mkdtempSync(join(HOME, 'badapi-'))
    writeFileSync(join(badApi, ui.UI_PLUGIN_MANIFEST), JSON.stringify({ apiVersion: 2 }), 'utf8')
    expect(ui.readUiPluginManifestReport(badApi).problems.some((line) => line.includes('apiVersion 不是非空字符串'))).toBe(true)
  })

  test('旧构建的中央 plugins 数组只在没有自述时兜底；逐条收敛坏字段', () => {
    const dir = mkdtempSync(join(HOME, 'legacy-'))
    writeFileSync(
      join(dir, ui.UI_PLUGIN_MANIFEST),
      JSON.stringify({
        apiVersion: '2.0.0',
        plugins: [
          { id: 'ok', file: 'client.js', inject: ['a', 7], services: 'nope', api: 5, phase: 'weird', platform: 'web' },
          'not-an-object',
          { id: 'bad id', file: 'client.js' },
          { id: 'slash', file: 'a/b.js' },
          { id: 'plat', file: 'client.js', platform: 'term' },
        ],
      }),
      'utf8',
    )
    // 末尾注释：位置决定身份（目录名 / 数组那一行的 id），内容里写别的 id 只在自述里能造出来。
    const report = ui.readUiPluginManifestReport(dir)
    expect(report.entries.map((entry) => entry.id)).toEqual(['ok'])
    expect(report.entries[0]).toMatchObject({ inject: ['a'] })
    for (const needle of ['不是对象', 'id 不成形', '文件名不成形', '载体（platform）不认识', 'api 不是非空字符串', 'services 不是数组', 'phase 只能是']) {
      expect(report.problems.some((line) => line.includes(needle)), needle).toBe(true)
    }
  })
})

describe('产物表与内容寻址', () => {
  test('table：读字节算 12 位 rev，缺文件的进 problems，停用的进 disabled', () => {
    const root = builtinRoot()
    addBundle(root, 'alpha', { file: 'client.js' }, 'alpha bytes')
    addBundle(root, 'beta', { file: 'client.js' }, '')
    writePluginEntries([{ file: 'ui-alpha', disabled: true }])

    const artifacts = ui.collectUiPluginArtifacts(root, 'web')
    expect(artifacts).toEqual({
      entries: [],
      problems: expect.arrayContaining([expect.stringContaining('读不到 client.js')]),
      disabled: ['alpha'],
      apiVersion: '2.0.0',
    })
  })

  test('table 按平台切；HEAD 不读盘；上一代地址还能取到旧字节', () => {
    const root = builtinRoot()
    addBundle(root, 'alpha', { file: 'client.js', platforms: ['web', 'tui'] }, 'v1')
    const web = ui.collectUiPluginArtifacts(root, 'web')
    expect(web.entries).toHaveLength(1)
    const entry = web.entries[0]!
    expect(entry.rev).toMatch(/^[0-9a-f]{12}$/)
    expect(ui.collectUiPluginArtifacts(root, 'tui').entries).toHaveLength(1)

    expect(ui.lookupUiPluginBundle('alpha', 'client.js', entry.rev, root).body?.toString()).toBe('v1')
    expect(ui.lookupUiPluginBundle('alpha', 'client.js', entry.rev, root, false).body).toBeNull()
    expect(ui.lookupUiPluginBundle('alpha', 'client.js', entry.rev, root, false).size).toBe(2)

    const file = join(root, 'alpha', 'client.js')
    writeFileSync(file, 'v2-longer', 'utf8')
    touch(file)
    const next = ui.collectUiPluginArtifacts(root, 'web', { force: true })
    expect(next.entries[0]!.rev).not.toBe(entry.rev)
    const old = ui.lookupUiPluginBundle('alpha', 'client.js', entry.rev, root)
    expect(old).toMatchObject({ known: true, previous: true, current: false })
    expect(old.body?.toString()).toBe('v1')
    expect(ui.lookupUiPluginBundle('alpha', 'client.js', 'deadbeef', root)).toMatchObject({ known: true, current: false, previous: false })
    expect(ui.lookupUiPluginBundle('nope', 'client.js', entry.rev, root).known).toBe(false)
  })

  test('缓存计数：连取两次只建一次表，refresh 强制重建', () => {
    const root = builtinRoot()
    addBundle(root, 'alpha', { file: 'client.js' })
    ui.resetUiArtifactCacheCounters()
    ui.collectUiPluginArtifacts(root, 'web')
    ui.collectUiPluginArtifacts(root, 'web')
    expect(ui.uiArtifactCacheCounters().tableBuilds).toBe(1)
    ui.collectUiPluginArtifacts(root, 'web', { force: true })
    expect(ui.uiArtifactCacheCounters().tableBuilds).toBe(2)
  })
})

describe('第三方界面插件', () => {
  function thirdRoot(): string {
    return mkdtempSync(join(HOME, `third-${String(n)}-`))
  }

  function addThird(root: string, name: string, manifest: unknown, client: string | null = 'third bytes\n'): void {
    const dir = join(root, name, 'ui')
    mkdirSync(dir, { recursive: true })
    if (manifest !== undefined) writeFileSync(join(root, name, 'plugin.json'), JSON.stringify(manifest), 'utf8')
    if (client !== null) writeFileSync(join(dir, 'client.js'), client, 'utf8')
  }

  test('发现：缺 plugin.json / 缺 api / platform 坏 / 撞名 / 停用各有一句话', () => {
    const root = thirdRoot()
    addThird(root, 'no-manifest', undefined)
    mkdirSync(join(root, 'host-only'), { recursive: true })
    addThird(root, 'no-api', {})
    addThird(root, 'badplat', { api: '^2.0.0', platforms: ['term'] })
    addThird(root, 'clash', { api: '^2.0.0' })
    addThird(root, 'disabled', { api: '^2.0.0' })
    writePluginEntries([{ file: 'disabled/ui/client.js', disabled: true }])

    const report = ui.discoverThirdPartyUiArtifacts('2.0.0', new Set(['clash']), root)
    expect(report.entries).toEqual([])
    expect(report.disabled).toEqual(['disabled'])
    for (const needle of ['没有 plugin.json', '没写 api', 'platforms 不认识', '与内置插件撞名']) {
      expect(report.problems.some((line) => line.includes(needle)), needle).toBe(true)
    }
  })

  test('未信任 / 信任后内容变了：都拦住并说清下一步', () => {
    const root = thirdRoot()
    addThird(root, 'plain', { api: '^2.0.0' })
    let report = ui.discoverThirdPartyUiArtifacts('2.0.0', new Set(), root)
    expect(report.problems.some((line) => line.includes('还没有信任记录'))).toBe(true)

    const trust = ui.trustThirdPartyUiPlugin('plain', '2.0.0', new Set(), root)
    expect(trust).toMatchObject({ ok: true })
    if (trust.ok) expect(trust.notice).toContain('已信任')
    report = ui.discoverThirdPartyUiArtifacts('2.0.0', new Set(), root)
    expect(report.entries).toHaveLength(1)
    const entry = report.entries[0]!
    expect(entry).toMatchObject({ id: 'plain', origin: 'third-party', file: 'client.js' })
    expect(entry.rev).toMatch(/^[0-9a-f]{16}$/)

    // 再信一次：提示「早就信任过了」。
    const again = ui.trustThirdPartyUiPlugin('plain', '2.0.0', new Set(), root)
    if (again.ok) expect(again.notice).toContain('早就信任过了')

    // 换内容：摘要对不上，必须重新确认。
    writeFileSync(join(root, 'plain', 'ui', 'client.js'), 'changed bytes\n', 'utf8')
    report = ui.discoverThirdPartyUiArtifacts('2.0.0', new Set(), root)
    expect(report.entries).toEqual([])
    expect(report.problems.some((line) => line.includes('和当初同意加载时不一样'))).toBe(true)
    const retrust = ui.trustThirdPartyUiPlugin('plain', '2.0.0', new Set(), root)
    if (retrust.ok) expect(retrust.notice).toContain('已按当前这份重新确认')
  })

  test('信任动作的拒绝面：目录名、缺清单、缺 api、撞名、门禁、缺 client', () => {
    const root = thirdRoot()
    expect(ui.trustThirdPartyUiPlugin('', '2.0.0', new Set(), root)).toMatchObject({ ok: false })
    expect(ui.trustThirdPartyUiPlugin('..', '2.0.0', new Set(), root)).toMatchObject({ ok: false })
    expect(ui.trustThirdPartyUiPlugin('a/b', '2.0.0', new Set(), root)).toMatchObject({ ok: false })

    addThird(root, 'no-manifest', undefined)
    expect(ui.trustThirdPartyUiPlugin('no-manifest', '2.0.0', new Set(), root)).toMatchObject({ ok: false, error: expect.stringContaining('读不到') })
    addThird(root, 'no-api', {})
    expect(ui.trustThirdPartyUiPlugin('no-api', '2.0.0', new Set(), root)).toMatchObject({ ok: false, error: expect.stringContaining('没写 api') })
    addThird(root, 'clash', { api: '^2.0.0' })
    expect(ui.trustThirdPartyUiPlugin('clash', '2.0.0', new Set(['clash']), root)).toMatchObject({ ok: false, error: expect.stringContaining('撞名') })
    addThird(root, 'old', { api: '^9.0.0' })
    expect(ui.trustThirdPartyUiPlugin('old', '2.0.0', new Set(), root)).toMatchObject({ ok: false, error: expect.stringContaining('已跳过加载') })
    addThird(root, 'no-client', { api: '^2.0.0' }, null)
    expect(ui.trustThirdPartyUiPlugin('no-client', '2.0.0', new Set(), root)).toMatchObject({ ok: false, error: expect.stringContaining('client.js 读不到') })
  })

  test('信任卡视图：每一条给出状态与下一步（含 stale）', () => {
    const root = thirdRoot()
    addThird(root, 'ok', { api: '^2.0.0' })
    ui.trustThirdPartyUiPlugin('ok', '2.0.0', new Set(), root)
    addThird(root, 'no-api', {})
    addThird(root, 'clash', { api: '^2.0.0' })
    addThird(root, 'stale', { api: '^2.0.0' })
    ui.trustThirdPartyUiPlugin('stale', '2.0.0', new Set(), root)
    writeFileSync(join(root, 'stale', 'ui', 'client.js'), 'new\n', 'utf8')
    mkdirSync(join(root, 'host-only'), { recursive: true })

    const rows = ui.scanThirdPartyUiTrusts('2.0.0', new Set(['clash']), root)
    const byName = new Map(rows.map((row) => [row.name, row]))
    expect(byName.has('host-only')).toBe(false)
    expect(byName.get('ok')).toMatchObject({ trusted: true, enabled: true, platforms: ['web'] })
    expect(byName.get('no-api')).toMatchObject({ problemKind: 'manifest' })
    expect(byName.get('clash')).toMatchObject({ problemKind: 'clash' })
    expect(byName.get('stale')).toMatchObject({ problemKind: 'stale', trusted: false })
  })

  test('第三方字节查询：当前 / 上一代 / HEAD / 未知；id 不成形给 unknown', () => {
    const root = thirdRoot()
    addThird(root, 'plain', { api: '^2.0.0' }, 'one\n')
    ui.trustThirdPartyUiPlugin('plain', '2.0.0', new Set(), root)
    const first = ui.discoverThirdPartyUiArtifacts('2.0.0', new Set(), root).entries[0]!
    expect(ui.lookupThirdPartyUiBundle('plain', 'client.js', first.rev, root).body?.toString()).toBe('one\n')
    expect(ui.lookupThirdPartyUiBundle('plain', 'client.js', first.rev, root, false).body).toBeNull()

    writeFileSync(join(root, 'plain', 'ui', 'client.js'), 'two longer\n', 'utf8')
    // 内容换了要重新确认（摘要跟着内容走），确认之后才是合法条目。
    ui.trustThirdPartyUiPlugin('plain', '2.0.0', new Set(), root)
    const second = ui.discoverThirdPartyUiArtifacts('2.0.0', new Set(), root).entries[0]!
    expect(second.rev).not.toBe(first.rev)
    expect(ui.lookupThirdPartyUiBundle('plain', 'client.js', first.rev, root)).toMatchObject({ previous: true })
    expect(ui.lookupThirdPartyUiBundle('plain', 'client.js', 'nope', root)).toMatchObject({ known: true, current: false, previous: false })
    expect(ui.lookupThirdPartyUiBundle('..', 'client.js', first.rev, root).known).toBe(false)
  })
})

describe('组合包界面半边', () => {
  function profileRoot(): string {
    return mkdtempSync(join(HOME, `profile-${String(n)}-`))
  }

  function addPackage(profile: string, name: string, manifest: unknown, client: string | null = 'package bytes\n'): string {
    const dir = join(profile, 'node_modules', ...name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
    if (client !== null) writeFileSync(join(dir, 'client.js'), client, 'utf8')
    return dir
  }

  const PNEMA = (extra: Record<string, unknown> = {}) => ({
    version: '1.2.3',
    pneuma: { client: { platform: 'pneuma', api: '^2.0.0', ...extra } },
    exports: { './client': './client.js' },
  })

  test('发现：pneuma 载体收进来，web 静默跳过，别家载体报问题', () => {
    const profile = profileRoot()
    addPackage(profile, '@scope/ok', PNEMA({ platforms: ['web', 'tui'] }))
    addPackage(profile, 'dsh-web', { pneuma: { client: { platform: 'web' } } })
    addPackage(profile, 'other', { pneuma: { client: { platform: 'term' } } })
    addPackage(profile, 'no-client-decl', { name: 'x' })

    const report = ui.discoverPackageUiArtifacts(profile, '2.0.0', new Set())
    expect(report.entries.map((entry) => `${entry.id}:${entry.platform ?? 'web'}`).sort()).toEqual([
      '@scope/ok:tui',
      '@scope/ok:web',
    ])
    expect(report.problems.some((line) => line.includes("只能是 'pneuma'"))).toBe(true)
  })

  test('判定顺序：platforms → api → 门禁 → 撞名 → 入口', () => {
    const profile = profileRoot()
    addPackage(profile, 'bad-platforms', PNEMA({ platforms: ['web', 'term'] }))
    addPackage(profile, 'no-api', { pneuma: { client: { platform: 'pneuma' } }, exports: { './client': './client.js' } })
    addPackage(profile, 'old', PNEMA({ api: '^9.0.0' }))
    addPackage(profile, 'clash', PNEMA())
    addPackage(profile, 'no-entry', { pneuma: { client: { platform: 'pneuma', api: '^2.0.0' } } })
    addPackage(profile, 'escape', { ...PNEMA(), exports: { './client': '../../outside.js' } })
    addPackage(profile, 'no-file', PNEMA(), null)

    const report = ui.discoverPackageUiArtifacts(profile, '2.0.0', new Set(['clash']))
    expect(report.entries).toEqual([])
    for (const needle of ['platforms 只能是', 'api 没写', '已跳过加载', '撞名', '没有 exports["./client"]', '指到了包外', '读不到']) {
      expect(report.problems.some((line) => line.includes(needle)), needle).toBe(true)
    }
  })

  test('字段坏值记问题、停用进 disabled；成功条目带 inject/services/phase/immediately', () => {
    const profile = profileRoot()
    addPackage(
      profile,
      'good',
      PNEMA({ inject: ['a', 7], services: ['s'], external: ['e'], phase: 'early', immediately: true }),
    )
    addPackage(profile, 'badfields', PNEMA({ services: 'nope', external: [1], phase: 'weird' }))
    addPackage(profile, 'off', PNEMA())
    writePluginEntries([{ file: 'off/client', disabled: true }])

    const report = ui.discoverPackageUiArtifacts(profile, '2.0.0', new Set())
    const entry = report.entries.find((item) => item.id === 'good')!
    expect(entry).toMatchObject({ inject: ['a'], services: ['s'], external: ['e'], phase: 'early', immediately: true })
    expect(entry.rev).toMatch(/^[0-9a-f]{16}$/)
    expect(report.disabled).toEqual(['off'])
    for (const needle of ['pneuma.client.services 不是数组', 'external 里有非字符串项', 'phase 只能是']) {
      expect(report.problems.some((line) => line.includes(needle)), needle).toBe(true)
    }
  })

  test('启停键判定与内容寻址（当前 / HEAD / 上一代 / 未知）', () => {
    const profile = profileRoot()
    addPackage(profile, '@scope/ok', PNEMA(), 'one\n')
    expect(ui.isPackageUiEntry('@scope/ok/client', profile)).toBe(true)
    expect(ui.isPackageUiEntry('@scope/ok/other', profile)).toBe(false)
    expect(ui.isPackageUiEntry('@scope/nope/client', profile)).toBe(false)

    const first = ui.discoverPackageUiArtifacts(profile, '2.0.0', new Set()).entries[0]!
    expect(ui.lookupPackageUiBundle('@scope/ok', 'client.js', first.rev, profile).body?.toString()).toBe('one\n')
    expect(ui.lookupPackageUiBundle('@scope/ok', 'client.js', first.rev, profile, false).body).toBeNull()
    expect(ui.lookupPackageUiBundle('@scope/ok', 'client.js', first.rev, null).known).toBe(false)

    writeFileSync(join(profile, 'node_modules', '@scope', 'ok', 'client.js'), 'two longer\n', 'utf8')
    touch(join(profile, 'node_modules', '@scope', 'ok', 'client.js'))
    const second = ui.discoverPackageUiArtifacts(profile, '2.0.0', new Set()).entries[0]!
    expect(ui.lookupPackageUiBundle('@scope/ok', 'client.js', first.rev, profile)).toMatchObject({ previous: true })
    expect(ui.lookupPackageUiBundle('@scope/ok', 'client.js', second.rev, profile)).toMatchObject({ current: true })
    expect(ui.lookupPackageUiBundle('@scope/ok', 'client.js', 'nope', profile)).toMatchObject({ known: true })
  })

  test('组合包信任卡：列出能装 / 装不上的理由与版本来源', () => {
    const profile = profileRoot()
    addPackage(profile, '@scope/ok', PNEMA())
    addPackage(profile, 'old', PNEMA({ api: '^9.0.0' }))
    addPackage(profile, 'dsh-web', { pneuma: { client: { platform: 'web' } } })
    addPackage(profile, 'other', { pneuma: { client: { platform: 'term' } } })

    const rows = ui.scanPackageUiTrusts('2.0.0', new Set(), profile)
    const byName = new Map(rows.map((row) => [row.name, row]))
    expect(byName.has('dsh-web')).toBe(false)
    expect(byName.get('@scope/ok')).toMatchObject({ trusted: true, platforms: ['web'], version: '1.2.3' })
    expect(byName.get('old')).toMatchObject({ problemKind: 'version' })
    expect(byName.get('other')).toMatchObject({ problemKind: 'manifest', platforms: [] })
    expect(ui.scanPackageUiTrusts('2.0.0', new Set(), null)).toEqual([])
  })
})

describe('产物路径与启动图行', () => {
  test('三类来源的路径与字节；越界与坏 id 给 null', () => {
    const builtin = builtinRoot()
    addBundle(builtin, 'alpha', { file: 'client.js' }, 'builtin')
    const third = mkdtempSync(join(HOME, 'third-path-'))
    mkdirSync(join(third, 'plain', 'ui'), { recursive: true })
    writeFileSync(join(third, 'plain', 'ui', 'client.js'), 'third', 'utf8')
    const profile = mkdtempSync(join(HOME, 'profile-path-'))
    const pkgDir = join(profile, 'node_modules', 'pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'client.js'), 'pkg', 'utf8')

    const builtinRow = ui.collectUiPluginArtifacts(builtin, 'web').entries[0]!
    expect(ui.readUiArtifactBytes(builtinRow, { builtinDir: builtin })?.toString()).toBe('builtin')
    expect(ui.uiArtifactFilePath(builtinRow, { builtinDir: builtin })).toContain('client.js')

    const thirdRow = { id: 'plain', file: 'client.js', rev: 'x', origin: 'third-party' } as never
    expect(ui.readUiArtifactBytes(thirdRow, { thirdPartyDir: third })?.toString()).toBe('third')
    expect(ui.uiArtifactFilePath({ id: '..', file: 'client.js', rev: 'x', origin: 'third-party' } as never, { thirdPartyDir: third })).toBeNull()

    const packageRow = { id: 'pkg', file: 'client.js', rev: 'x', origin: 'package', path: join(pkgDir, 'client.js') } as never
    expect(ui.readUiArtifactBytes(packageRow)?.toString()).toBe('pkg')
    expect(ui.uiArtifactFilePath({ id: 'pkg', file: 'c', rev: 'x', origin: 'package' } as never)).toBeNull()
  })

  test('toUiPluginRows：只带声明过的字段', () => {
    const rows = ui.toUiPluginRows([
      { id: 'a', file: 'client.js', rev: 'r1' },
      {
        id: 'b',
        file: 'client.js',
        rev: 'r2',
        inject: ['a'],
        services: ['s'],
        external: ['e'],
        immediately: true,
        phase: 'early',
      },
    ])
    expect(rows).toEqual([
      { id: 'a', rev: 'r1' },
      { id: 'b', rev: 'r2', inject: ['a'], services: ['s'], external: ['e'], immediately: true, phase: 'early' },
    ])
  })

  test('collectUiArtifactsForPlatform：内置 + 第三方 + 组合包合成一张表', () => {
    const builtin = builtinRoot()
    addBundle(builtin, 'alpha', { file: 'client.js' })
    const third = mkdtempSync(join(HOME, 'third-merge-'))
    mkdirSync(join(third, 'plain', 'ui'), { recursive: true })
    writeFileSync(join(third, 'plain', 'plugin.json'), JSON.stringify({ api: '^2.0.0' }), 'utf8')
    writeFileSync(join(third, 'plain', 'ui', 'client.js'), 'third', 'utf8')
    ui.trustThirdPartyUiPlugin('plain', '2.0.0', new Set(['alpha']), third)
    const profile = mkdtempSync(join(HOME, 'profile-merge-'))
    const pkg = join(profile, 'node_modules', 'pkg')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ pneuma: { client: { platform: 'pneuma', api: '^2.0.0' } }, exports: { './client': './client.js' } }), 'utf8')
    writeFileSync(join(pkg, 'client.js'), 'pkg', 'utf8')

    const merged = ui.collectUiArtifactsForPlatform('web', { builtinDir: builtin, thirdPartyDir: third, packageDir: profile })
    expect(merged.entries.map((entry) => entry.id).sort()).toEqual(['alpha', 'pkg', 'plain'])
    expect(merged.apiVersion).toBe('2.0.0')
    expect(merged.problems).toEqual([])
  })
})
