/**
 * 插件加载器「行」模型的内核集成用例（迁自 `scripts/plugin-model-test.mjs`）。
 *
 * 钉的是 P2「加载器对齐」那一条线：行目标解析（含 `exports` 子路径）、身份 = 行 id、
 * 安装锚点与 pinned/overridable、默认关的行进目录但不加载、行级 `inject`、
 * 设置分区元数据、行级版本闸（`engines.pneuma`）、`plugins.json` 迁移与坏文件拒写、
 * 行 id 重复即启动失败。
 *
 * ## 为什么夹具包都造在临时目录、而不是用真包
 *
 * 这里要验的是**加载器怎么读清单、怎么解析、怎么判身份**，不是某个包能做什么。
 * 夹具包的模块体里不 import 任何东西，只往 `globalThis.__MODEL__` 里记一笔，于是
 * 「谁被 import、谁被 apply、谁被 dispose」在测试里是直读的。真包会把这些信号淹掉。
 *
 * ## 为什么每个用例的包名都不一样
 *
 * `plugin-loader.ts:1866` 的解析表是**进程级**的：同一个包名在这次启动里解析出两个
 * 物理目录会直接抛错——那是生产语义（否则会挂出两份服务实例）。integration 层的
 * `retry: 1` 会让失败用例再跑一遍，若两次用同一批包名，第二次会先在「两个目录」上炸，
 * 把真正的失败原因盖掉。所以包名统一走 {@link unique}，每次取号。
 *
 * ## 与 `bootKernel` 的关系
 *
 * 这一批不起内核：加载器的行为只需要一个裸 cordis `Context`，起内核会把 mock 时代的
 * 假模型、会话落盘、插件热更轮询全拖进来，而它们都不是本文件要钉的东西。
 * `DSC_HOT=0` 关掉 `mountApplicationRows` 自动拉起的轮询，免得后台定时器在用例之间漂。
 *
 * @module dsc/core/plugin-loader.int.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as bundleApi from '@pneuma/runtime/core/plugin-bundle.js'
import * as loader from '@pneuma/runtime/core/plugin-loader.js'
import { DSC_HOME } from '@pneuma/runtime/core/path-policy.js'
import * as registry from '@pneuma/runtime/core/plugin-registry.js'

/** 这一批夹具的总目录。integration 的临时 HOME 在 setup 里铺好，这里只造夹具。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-plugin-model-'))

// 本文件自己指定 appDir 与 profile，不让 config.yaml 里的 profile 混进来；
// 手动挂载而不是验轮询，所以关掉自动拉起的后台热更（`plugin-loader.ts:1480`）。
delete process.env['DSC_PROFILE']
process.env['DSC_HOT'] = '0'

/** `plugins.json` 的位置：注册表以它为准（DSC_HOME 由 integration setup 的临时 HOME 决定）。 */
const PLUGINS_JSON = join(DSC_HOME, 'plugins.json')

/** 夹具模块往这里记信号：import / apply / dispose 各一条，配置另存。 */
interface ModelRecord {
  imported: string[]
  mounted: string[]
  disposed: string[]
  configs: Record<string, unknown>
}

const RECORD: ModelRecord = { imported: [], mounted: [], disposed: [], configs: {} }
;(globalThis as unknown as { __MODEL__?: ModelRecord }).__MODEL__ = RECORD

/** 包名/行 id 的唯一后缀：解析表是进程级的，重试时不能再撞同一个包名。 */
let serial = 0
/**
 * 取一个本次运行里没用过的名字。
 * @param base - 语义前缀（读报错时还要认得出来）
 * @returns `<base>-<序号>`
 */
function unique(base: string): string {
  serial += 1
  return `${base}-${String(serial)}`
}

/** 写文件，顺带把父目录建好（夹具全是一次性目录，不值得每次 mkdir）。 */
function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

/** 写一份 JSON 文件。 */
function writeJson(file: string, value: unknown): void {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** 读一份 JSON 文件。 */
function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** 一个最小 cordis object plugin 的源码（tag 用来认它是哪一份）。 */
function moduleSource(tag: string): string {
  return [
    `globalThis.__MODEL__.imported.push(${JSON.stringify(tag)})`,
    `export const name = ${JSON.stringify(tag)}`,
    'export const inject = []',
    'export function apply() {',
    `  globalThis.__MODEL__.mounted.push(${JSON.stringify(tag)})`,
    '  return () => {',
    `    globalThis.__MODEL__.disposed.push(${JSON.stringify(tag)})`,
    '  }',
    '}',
    '',
  ].join('\n')
}

/** 同上，但把 `apply` 收到的 config 记下来（验 hostConfig 用）。 */
function moduleSourceWithConfig(tag: string): string {
  return [
    `globalThis.__MODEL__.imported.push(${JSON.stringify(tag)})`,
    `export const name = ${JSON.stringify(tag)}`,
    'export const inject = []',
    'export function apply(ctx, config) {',
    `  globalThis.__MODEL__.mounted.push(${JSON.stringify(tag)})`,
    `  globalThis.__MODEL__.configs[${JSON.stringify(tag)}] = config`,
    '  return () => {',
    `    globalThis.__MODEL__.disposed.push(${JSON.stringify(tag)})`,
    '  }',
    '}',
    '',
  ].join('\n')
}

/** `makePackage` 的可选项。 */
interface PackageOptions {
  version?: string
  exports?: Record<string, string>
  pneuma?: Record<string, unknown>
  /** 落进清单的其它顶层字段（例如 `engines`）。 */
  extra?: Record<string, unknown>
  /** 入口文件名 → tag；每个文件写一份 {@link moduleSource}。 */
  entries?: Record<string, string>
  /** 入口写 {@link moduleSourceWithConfig}（记 apply 收到的 config）。 */
  recordConfig?: boolean
}

/** 写一个装在 `<root>/node_modules` 下的包，返回包目录。 */
function makePackage(root: string, name: string, options: PackageOptions = {}): string {
  const dir = join(root, 'node_modules', ...name.split('/'))
  const manifest: Record<string, unknown> = {
    name,
    version: options.version ?? '1.0.0',
    type: 'module',
    exports: options.exports ?? { '.': './index.js', './package.json': './package.json' },
    ...options.extra,
  }
  if (options.pneuma !== undefined) manifest['pneuma'] = options.pneuma
  writeJson(join(dir, 'package.json'), manifest)
  for (const [file, tag] of Object.entries(options.entries ?? { 'index.js': name })) {
    writeText(join(dir, file), options.recordConfig === true ? moduleSourceWithConfig(tag) : moduleSource(tag))
  }
  return dir
}

/** `makeProfile` 的可选项。 */
interface ProfileOptions {
  bundles?: string[]
  patch?: string
}

/** 写一个 profile 目录。 */
function makeProfile(name: string, options: ProfileOptions = {}): string {
  const dir = join(WORK, 'profiles', name)
  writeJson(join(dir, 'package.json'), {
    name: `profile-${name}`,
    dsh: { profile: { bundles: options.bundles ?? [] } },
  })
  if (options.patch !== undefined) writeText(join(dir, 'cordis.patch.yml'), options.patch)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  return dir
}

/** 写一个带 patch 的组合包（patch 里的行由用例给）。 */
function makeBundle(profileDir: string, name: string, patchText: string): string {
  const dir = join(profileDir, 'node_modules', name)
  writeJson(join(dir, 'package.json'), {
    name,
    version: '1.0.0',
    type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  writeText(join(dir, 'cordis.patch.yml'), patchText)
  return dir
}

/** 一个 insert 行块（YAML）。名字一律加引号：plain scalar 不能以 `@` 开头。 */
function insertRows(rows: Array<{ id: string; name: string; extra?: string }>): string {
  const lines = rows.map(
    (row) => `    - id: ${row.id}\n      name: '${row.name}'${row.extra === undefined ? '' : `\n${row.extra}`}`,
  )
  return `- insert:\n${lines.join('\n')}\n`
}

/** 一个「应用自带行」安装目录的一行。 */
interface AppRow {
  id: string
  name: string
  tag: string
  pneuma?: Record<string, unknown>
  extra?: Record<string, unknown>
  recordConfig?: boolean
}

/** 造一个应用安装目录：`lib/node_modules` 下放包，`@pneuma/base` 给行清单。 */
function makeApp(appName: string, rows: AppRow[]): string {
  const appDir = join(WORK, 'apps', appName)
  const lib = join(appDir, 'lib')
  for (const row of rows) {
    makePackage(lib, row.name, {
      entries: { 'index.js': row.tag },
      ...(row.pneuma === undefined ? {} : { pneuma: row.pneuma }),
      ...(row.extra === undefined ? {} : { extra: row.extra }),
      ...(row.recordConfig === true ? { recordConfig: true } : {}),
    })
  }
  writeJson(join(lib, 'node_modules', '@pneuma', 'base', 'package.json'), {
    name: '@pneuma/base',
    version: '1.0.0',
    type: 'module',
  })
  writeText(
    join(lib, 'node_modules', '@pneuma', 'base', 'cordis.patch.yml'),
    insertRows(rows.map((row) => ({ id: row.id, name: row.name }))),
  )
  return appDir
}

/** 挂一次组合包；返回失败与告警（行都挂进新 root）。 */
async function mountProfile(
  profileDir: string,
  appDir?: string,
): Promise<{ root: Context; failures: Array<{ file: string; name: string; problem: string }>; warnings: string[] }> {
  const root = new Context()
  const result = await loader.mountBundlePlugins(root, profileDir, appDir === undefined ? {} : { appDir })
  return { root, ...result }
}

/** 插件中心里的某一行。 */
function infoOf(file: string): ReturnType<typeof registry.listPluginInfos>[number] | undefined {
  return registry.listPluginInfos().find((item) => item.file === file)
}

beforeEach(() => {
  // 每条用例开始前清空信号：夹具模块是新的（包名唯一），但记录是共用的。
  RECORD.imported.length = 0
  RECORD.mounted.length = 0
  RECORD.disposed.length = 0
  RECORD.configs = {}
})

describe('① 行目标解析：exports 子路径、身份 = 行 id、设置分区元数据', () => {
  test('包根与子路径两行都挂上，meta.file 是行 id 而不是文件 basename', async () => {
    const id = unique('alpha')
    const panelId = unique('alpha-panel')
    const pkg = unique('@p2/alpha')
    const profileDir = makeProfile(unique('subpath'))
    makePackage(profileDir, pkg, {
      pneuma: { title: '甲包', description: '子路径与身份的自检包', settingsSection: 'alpha' },
      exports: { '.': './index.js', './panel': './panel.js', './package.json': './package.json' },
      entries: { 'index.js': id, 'panel.js': panelId },
    })
    writeText(
      join(profileDir, 'cordis.patch.yml'),
      insertRows([
        { id, name: pkg },
        { id: panelId, name: `${pkg}/panel` },
      ]),
    )

    const { failures } = await mountProfile(profileDir)
    expect(failures).toEqual([])
    expect(RECORD.mounted).toContain(id)
    expect(RECORD.mounted).toContain(panelId)
    expect(registry.getPluginMeta(id)?.file).toBe(id)
    expect(registry.getPluginMeta(panelId)?.file).toBe(panelId)
    expect(infoOf(id)).toBeDefined()
    expect(infoOf(panelId)).toBeDefined()
    expect(registry.getPluginMeta(id)?.settingsSection).toBe('alpha')
    expect(infoOf(id)?.name).toBe('甲包')
  })

  test('热启停按行 id：子路径那一行单独停用，包根那一行不受影响', async () => {
    const id = unique('alpha')
    const panelId = unique('alpha-panel')
    const pkg = unique('@p2/alpha')
    const profileDir = makeProfile(unique('hot-toggle'))
    makePackage(profileDir, pkg, {
      exports: { '.': './index.js', './panel': './panel.js', './package.json': './package.json' },
      entries: { 'index.js': id, 'panel.js': panelId },
    })
    writeText(
      join(profileDir, 'cordis.patch.yml'),
      insertRows([
        { id, name: pkg },
        { id: panelId, name: `${pkg}/panel` },
      ]),
    )
    await mountProfile(profileDir)

    const off = await loader.setPluginEnabledHot(panelId, false)
    expect(off).toEqual({ ok: true })
    expect(RECORD.disposed).toContain(panelId)
    expect(infoOf(id)?.enabled).toBe(true)
    expect(registry.readPluginEntries().some((entry) => entry.file === panelId)).toBe(true)

    const on = await loader.setPluginEnabledHot(panelId, true)
    expect(on.ok).toBe(true)
    // 重新挂载会再 apply 一次：两行 id 各自一条，说明挂的是子路径那一份。
    expect(RECORD.mounted.filter((tag) => tag === panelId)).toHaveLength(2)
  })
})

describe('② 默认关的行：插件中心看得见，代码不加载', () => {
  test('列得出、标停用、不 import 不挂载；用户打开后真的挂上', async () => {
    const id = unique('beta')
    const pkg = unique('@p2/beta')
    const profileDir = makeProfile(unique('disabled-row'))
    makePackage(profileDir, pkg, {
      pneuma: { title: '乙包', description: '默认关的自检包', settingsSection: 'beta' },
      entries: { 'index.js': id },
    })
    writeText(
      join(profileDir, 'cordis.patch.yml'),
      insertRows([{ id, name: pkg, extra: '      disabled: true' }]),
    )

    const { failures } = await mountProfile(profileDir)
    expect(failures).toEqual([])
    expect(infoOf(id)).toBeDefined()
    expect(infoOf(id)?.enabled).toBe(false)
    expect(registry.getPluginMeta(id)?.defaultDisabled).toBe(true)
    expect(infoOf(id)?.name).toBe('乙包')
    expect(infoOf(id)?.settingsSection).toBe('beta')
    expect(RECORD.imported).not.toContain(id)
    expect(RECORD.mounted).not.toContain(id)

    const on = await loader.setPluginEnabledHot(id, true)
    expect(on.ok).toBe(true)
    expect(RECORD.mounted).toContain(id)
  })
})

describe('③ 安装锚点：pinned 用应用那份，overridable 用 profile 那份', () => {
  test('两边各有一份时，谁被加载一目了然，pinned 的让路会写告警', async () => {
    const appDir = join(WORK, 'app-anchor')
    mkdirSync(join(appDir, 'lib', 'node_modules'), { recursive: true })
    const profileDir = makeProfile(unique('anchors'))

    const ovr = unique('@p2/ovr')
    const pin = unique('@p2/pin')
    makePackage(join(appDir, 'lib'), ovr, { entries: { 'index.js': `${ovr}-app` } })
    makePackage(profileDir, ovr, { version: '2.0.0', entries: { 'index.js': `${ovr}-profile` } })
    makePackage(join(appDir, 'lib'), pin, {
      pneuma: { resolution: 'pinned' },
      entries: { 'index.js': `${pin}-app` },
    })
    makePackage(profileDir, pin, {
      version: '2.0.0',
      pneuma: { resolution: 'pinned' },
      entries: { 'index.js': `${pin}-profile` },
    })
    writeText(
      join(profileDir, 'cordis.patch.yml'),
      insertRows([
        { id: unique('ovr'), name: ovr },
        { id: unique('pin'), name: pin },
      ]),
    )

    const { failures, warnings } = await mountProfile(profileDir, appDir)
    expect(failures).toEqual([])
    expect(RECORD.mounted).toContain(`${ovr}-profile`)
    expect(RECORD.mounted).not.toContain(`${ovr}-app`)
    expect(RECORD.mounted).toContain(`${pin}-app`)
    expect(RECORD.mounted).not.toContain(`${pin}-profile`)
    expect(warnings.join(' | ')).toContain('pinned')
    expect(warnings.join(' | ')).toContain(join(profileDir, 'node_modules', ...pin.split('/')))
    expect(warnings.join(' | ')).not.toContain(ovr)
  })
})

describe('④ 行级版本闸：engines.pneuma 按「实际解析到的包」判', () => {
  test('契约不满足的行被跳过、进失败清单、插件中心带 problem、告警指向 compatibility.json', async () => {
    const profileDir = makeProfile(unique('engines'))
    const okPkg = unique('@p2/gate-ok')
    const badPkg = unique('@p2/gate-bad')
    const okTag = unique('gate-ok')
    const badRow = unique('gate-bad')
    makePackage(profileDir, okPkg, { entries: { 'index.js': okTag }, extra: { engines: { pneuma: '>=1.0.0 <2.0.0' } } })
    makePackage(profileDir, badPkg, {
      pneuma: { title: '下一代契约的包' },
      entries: { 'index.js': unique('gate-bad') },
      extra: { engines: { pneuma: '>=2.0.0' } },
    })
    writeText(
      join(profileDir, 'cordis.patch.yml'),
      insertRows([
        { id: unique('gate-ok'), name: okPkg },
        { id: badRow, name: badPkg },
      ]),
    )

    const { failures, warnings } = await mountProfile(profileDir)
    expect(RECORD.mounted).toContain(okTag)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.file).toBe(badRow)
    expect(String(failures[0]?.problem)).toContain('>=2.0.0')
    expect(String(failures[0]?.problem)).toContain('1.0.0')
    expect(String(infoOf(badRow)?.problem)).toContain('>=2.0.0')
    expect(warnings.join(' | ')).toContain('compatibility.json')
  })

  test('compatibility.json 里登记过豁免就照挂，并说明是豁免放行的', async () => {
    const profileDir = makeProfile(unique('engines-exempt'))
    const pkg = unique('@p2/gate-exempt')
    makePackage(profileDir, pkg, { entries: { 'index.js': unique('gate-exempt') }, extra: { engines: { pneuma: '>=2.0.0' } } })
    writeJson(join(profileDir, 'compatibility.json'), { exemptions: [{ package: pkg }] })
    writeText(join(profileDir, 'cordis.patch.yml'), insertRows([{ id: unique('gate-exempt'), name: pkg }]))

    const { failures, warnings } = await mountProfile(profileDir)
    expect(failures).toEqual([])
    expect(warnings.join(' | ')).toContain('豁免')
  })

  test('按旧运行时登记的豁免不再放行，文案说清按哪个运行时登记、下一步跑什么命令', async () => {
    const current = bundleApi.DSH_CONTRACT_VERSION
    const profileDir = makeProfile(unique('engines-stale'))
    const pkg = unique('@p2/gate-stale')
    const rowId = unique('gate-stale')
    makePackage(profileDir, pkg, {
      version: '1.2.3',
      entries: { 'index.js': rowId },
      extra: { engines: { pneuma: '>=2.0.0' } },
    })
    writeJson(join(profileDir, 'compatibility.json'), {
      exemptions: [{ package: pkg, version: '1.2.3', dshVersion: '0.2.1' }],
    })
    writeText(join(profileDir, 'cordis.patch.yml'), insertRows([{ id: rowId, name: pkg }]))

    const stale = await mountProfile(profileDir)
    const text = stale.failures.map((item) => String(item.problem)).join(' | ')
    expect(RECORD.mounted).not.toContain(rowId)
    expect(text).toContain('0.2.1')
    expect(text).toContain(current)
    expect(text).toContain(`numa plugin allow-version ${pkg}@1.2.3 --dsh-version ${current} --accept-risk`)
    expect(text).not.toContain('登记豁免可以强行启用')

    // 重按一次（同样的包与版本，换成当前运行时）就当场放行，不需要改包。
    writeJson(join(profileDir, 'compatibility.json'), {
      exemptions: [{ package: pkg, version: '1.2.3', dshVersion: current }],
    })
    const renewed = await mountProfile(profileDir)
    expect(renewed.failures).toEqual([])
    expect(RECORD.mounted).toContain(rowId)
  })

  test('同一个包换了版本：文案说清登记的是哪一版、这一份是哪一版', async () => {
    const current = bundleApi.DSH_CONTRACT_VERSION
    const profileDir = makeProfile(unique('engines-moved'))
    const pkg = unique('@p2/gate-moved')
    const rowId = unique('gate-moved')
    makePackage(profileDir, pkg, {
      version: '1.2.3',
      entries: { 'index.js': rowId },
      extra: { engines: { pneuma: '>=2.0.0' } },
    })
    writeJson(join(profileDir, 'compatibility.json'), {
      exemptions: [{ package: pkg, version: '1.2.2', dshVersion: current }],
    })
    writeText(join(profileDir, 'cordis.patch.yml'), insertRows([{ id: rowId, name: pkg }]))

    const moved = await mountProfile(profileDir)
    const text = moved.failures.map((item) => String(item.problem)).join(' | ')
    expect(RECORD.mounted).not.toContain(rowId)
    expect(text).toContain('v1.2.2')
    expect(text).toContain('v1.2.3')
  })
})

describe('⑤ plugins.json：旧键双查、惰性写回、未知键保留', () => {
  test('旧格式读得到；写回只改开关，未知顶层键原样保留', () => {
    writeJson(PLUGINS_JSON, {
      version: 1,
      entries: [{ file: 'ops', disabled: true, config: { x: 1 } }],
      uiTrust: { 't/ui/client.js': { trustedAt: 123 } },
      custom: { keep: true },
    })
    const entries = registry.readPluginEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.file).toBe('ops')
    expect(entries[0]?.disabled).toBe(true)
    expect(registry.getPluginConfig('ops')['x']).toBe(1)

    registry.writePluginEnabled('ops', true)
    const doc = readJson(PLUGINS_JSON)
    const docEntries = doc['entries'] as Array<{ file: string; disabled: boolean }>
    expect(docEntries).toHaveLength(1)
    expect(docEntries[0]?.disabled).toBe(false)
    expect((doc['uiTrust'] as Record<string, { trustedAt: number }>)['t/ui/client.js']?.trustedAt).toBe(123)
    expect((doc['custom'] as { keep: boolean }).keep).toBe(true)
  })

  test('旧键是文件名时按行 id 读得到配置，写回后新旧键都在（回滚到旧版本也读得到）', async () => {
    const profileDir = makeProfile(unique('migrate-alias'))
    const pkg = unique('@p2/legacy')
    const rowId = unique('legacy')
    makePackage(profileDir, pkg, {
      exports: { '.': './main.js', './package.json': './package.json' },
      entries: { 'main.js': rowId },
    })
    writeText(join(profileDir, 'cordis.patch.yml'), insertRows([{ id: rowId, name: pkg }]))
    writeJson(PLUGINS_JSON, {
      version: 1,
      entries: [{ file: 'main.js', disabled: false, config: { y: 2 } }],
      uiTrust: { 't/ui/client.js': { trustedAt: 456 } },
    })

    const { failures } = await mountProfile(profileDir)
    expect(failures).toEqual([])
    expect(registry.getPluginConfig(rowId)['y']).toBe(2)

    registry.writePluginEnabled(rowId, false)
    const merged = readJson(PLUGINS_JSON)
    const entries = merged['entries'] as Array<{ file: string; disabled: boolean }>
    const byFile = new Map(entries.map((entry) => [entry.file, entry]))
    expect(byFile.has(rowId)).toBe(true)
    expect(byFile.has('main.js')).toBe(true)
    expect(byFile.get(rowId)?.disabled).toBe(true)
    expect(byFile.get('main.js')?.disabled).toBe(true)
    expect((merged['uiTrust'] as Record<string, { trustedAt: number }>)['t/ui/client.js']?.trustedAt).toBe(456)
  })

  test('两个行共用一个入口文件名时旧键有歧义：谁都不许拿它当线索', async () => {
    const profileDir = makeProfile(unique('migrate-ambiguous'))
    const g1 = unique('@p2/g1')
    const g2 = unique('@p2/g2')
    const row1 = unique('g1')
    const row2 = unique('g2')
    makePackage(profileDir, g1, { entries: { 'index.js': row1 } })
    makePackage(profileDir, g2, { entries: { 'index.js': row2 } })
    writeText(
      join(profileDir, 'cordis.patch.yml'),
      insertRows([
        { id: row1, name: g1 },
        { id: row2, name: g2 },
      ]),
    )
    writeJson(PLUGINS_JSON, { version: 1, entries: [{ file: 'index.js', disabled: false, config: { z: 9 } }] })

    const { failures } = await mountProfile(profileDir)
    expect(failures).toEqual([])
    expect(Object.keys(registry.getPluginConfig(row1))).toEqual([])
    expect(Object.keys(registry.getPluginConfig(row2))).toEqual([])
  })

  test('坏文件时拒绝写盘，报错说清是哪个文件、为什么，文件一个字节没变', () => {
    const broken = '{\n  "version": 1,\n  "entries": [\n'
    writeText(PLUGINS_JSON, broken)
    expect(() => {
      registry.writePluginEnabled('ops-broken', false)
    }).toThrow(/plugins\.json/)
    expect(() => {
      registry.writePluginEnabled('ops-broken', false)
    }).toThrow(/覆盖/)
    expect(readFileSync(PLUGINS_JSON, 'utf8')).toBe(broken)
  })
})

describe('⑥ 配置错误：行 id 重复、同一包名两个目录都直接失败', () => {
  test('行 id 重复时启动失败，报错写了重复的 id 与两个来源', async () => {
    const profileDir = makeProfile(unique('dup-id'), { bundles: ['bundle-one', 'bundle-two'] })
    const dupId = unique('twice')
    makeBundle(profileDir, 'bundle-one', insertRows([{ id: dupId, name: './plugins/one.js' }]))
    makeBundle(profileDir, 'bundle-two', insertRows([{ id: dupId, name: './plugins/two.js' }]))
    writeText(join(profileDir, 'node_modules', 'bundle-one', 'plugins', 'one.js'), moduleSource(unique('one')))
    writeText(join(profileDir, 'node_modules', 'bundle-two', 'plugins', 'two.js'), moduleSource(unique('two')))

    const failure = await mountProfile(profileDir).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const message = String((failure as Error).message)
    expect(message).toContain(dupId)
    expect(message).toMatch(/bundle-one[\s\S]*bundle-two|bundle-two[\s\S]*bundle-one/)
  })

  test('同一包名解析出两个目录时启动失败，报错写明双方路径', async () => {
    const pkg = unique('@p2/dup')
    const dirA = unique('dup-dir-a')
    const dirB = unique('dup-dir-b')
    const profileA = makeProfile(dirA)
    makePackage(profileA, pkg, { entries: { 'index.js': unique('dup-a') } })
    writeText(join(profileA, 'cordis.patch.yml'), insertRows([{ id: unique('dup-a'), name: pkg }]))
    const profileB = makeProfile(dirB)
    makePackage(profileB, pkg, { version: '2.0.0', entries: { 'index.js': unique('dup-b') } })
    writeText(join(profileB, 'cordis.patch.yml'), insertRows([{ id: unique('dup-b'), name: pkg }]))

    const first = await mountProfile(profileA)
    expect(first.failures).toEqual([])

    const conflict = await mountProfile(profileB).catch((error: unknown) => error)
    expect(conflict).toBeInstanceOf(Error)
    const message = String((conflict as Error).message)
    expect(message).toContain(dirA)
    expect(message).toContain(dirB)
    expect(message).toContain('两个不同的目录')
  })
})

describe('⑦ 应用自带行：解析、身份、surface、幂等、hostConfig、覆盖', () => {
  test('普通行与 tui 行都挂；身份是行 id；settingsSection / title 进插件中心', async () => {
    const mainId = unique('app-main')
    const mainTag = unique('app-main')
    const mainPkg = unique('@p3/main')
    const appDir = makeApp(unique('rows-all'), [
      { id: mainId, name: mainPkg, tag: mainTag, pneuma: { title: '自带主行', settingsSection: mainId } },
      { id: 'host-stdio', name: unique('@p3/hs'), tag: unique('app-hs') },
      { id: 'tui', name: unique('@p3/tui'), tag: 'app-tui' },
    ])
    const rowsContext = new Context()
    const failures = await loader.mountApplicationRows(rowsContext, { appDir, surface: 'tui' })
    expect(failures).toEqual([])
    expect(RECORD.mounted).toContain(mainTag)
    expect(RECORD.mounted).toContain('app-tui')
    expect(registry.getPluginMeta(mainId)?.file).toBe(mainId)
    expect(registry.getPluginMeta('tui')?.file).toBe('tui')
    expect(registry.getPluginMeta(mainId)?.settingsSection).toBe(mainId)
    expect(infoOf(mainId)?.name).toBe('自带主行')

    // 幂等：同一个 root 上重复调用不新增 fiber（换 Context 才该重新挂）。
    const before = RECORD.mounted.filter((tag) => tag === mainTag).length
    const again = await loader.mountApplicationRows(rowsContext, { appDir, surface: 'tui' })
    expect(again).toEqual([])
    expect(RECORD.mounted.filter((tag) => tag === mainTag)).toHaveLength(before)
  })

  test('surface=headless 不挂 tui 行、surface=tui 不挂 host-stdio 行，其余照挂', async () => {
    const headless = makeApp(unique('rows-headless'), [
      { id: unique('app-h'), name: unique('@p3/h-main'), tag: 'h-main' },
      { id: 'host-stdio', name: unique('@p3/h-hs'), tag: 'h-hs' },
      { id: 'tui', name: unique('@p3/h-tui'), tag: 'h-tui' },
    ])
    const headlessFailures = await loader.mountApplicationRows(new Context(), { appDir: headless, surface: 'headless' })
    expect(headlessFailures).toEqual([])
    expect(RECORD.mounted).toContain('h-main')
    expect(RECORD.mounted).not.toContain('h-tui')
    expect(RECORD.mounted).toContain('h-hs')

    const tui = makeApp(unique('rows-tui'), [
      { id: unique('app-t'), name: unique('@p3/t-main'), tag: 't-main' },
      { id: 'host-stdio', name: unique('@p3/t-hs'), tag: 't-hs' },
      { id: 'tui', name: unique('@p3/t-tui'), tag: 't-tui' },
    ])
    const tuiFailures = await loader.mountApplicationRows(new Context(), { appDir: tui, surface: 'tui' })
    expect(tuiFailures).toEqual([])
    expect(RECORD.mounted).not.toContain('t-hs')
    expect(RECORD.mounted).toContain('t-tui')
  })

  test('base 清单不存在时返回空数组且不抛（P3 期间的正常状态）', async () => {
    const appDir = join(WORK, 'apps', unique('rows-missing'))
    mkdirSync(appDir, { recursive: true })
    await expect(loader.mountApplicationRows(new Context(), { appDir })).resolves.toEqual([])
  })

  test('应用自带行也过版本闸；传了豁免名单就照挂', async () => {
    const gateId = unique('app-gate')
    const gatePkg = unique('@p3/gate')
    const gateTag = unique('app-gate')
    const appDir = makeApp(unique('rows-engines'), [
      { id: gateId, name: gatePkg, tag: gateTag, extra: { engines: { pneuma: '>=2.0.0' } } },
    ])
    const failures = await loader.mountApplicationRows(new Context(), { appDir, surface: 'none' })
    expect(failures).toHaveLength(1)
    expect(failures[0]?.file).toBe(gateId)
    expect(RECORD.mounted).not.toContain(gateTag)

    const exempt = await loader.mountApplicationRows(new Context(), {
      appDir,
      surface: 'none',
      exemptions: [gatePkg],
    })
    expect(exempt).toEqual([])
    expect(RECORD.mounted).toContain(gateTag)
  })

  test('来源与可否停用：应用自带行算内置，pneuma.toggleable 决定有没有开关', async () => {
    const plainId = unique('src-plain')
    const switchId = unique('src-switch')
    const uiId = unique('ui-demo')
    const appDir = makeApp(unique('rows-source'), [
      { id: plainId, name: unique('@p3/src-plain'), tag: unique('src-plain') },
      { id: switchId, name: unique('@p3/src-switch'), tag: unique('src-switch'), pneuma: { toggleable: true } },
      { id: uiId, name: unique('@p3/ui-demo'), tag: unique('ui-demo'), pneuma: { toggleable: true } },
    ])
    const failures = await loader.mountApplicationRows(new Context(), { appDir, surface: 'none' })
    expect(failures).toEqual([])
    expect(infoOf(plainId)?.source).toBe('builtin')
    expect(infoOf(plainId)?.toggleable).toBe(false)
    expect(infoOf(switchId)?.toggleable).toBe(true)
    expect(infoOf(switchId)?.source).toBe('builtin')
    expect(infoOf(uiId)?.toggleable).toBe(true)

    // 组合包的行是用户自装，来源不能被「内置」污染。
    const profileDir = makeProfile(unique('source-bundle'))
    const bundledPkg = unique('@p3/bundled')
    const bundledRow = unique('bundled-row')
    makePackage(profileDir, bundledPkg, { entries: { 'index.js': unique('bundled') } })
    writeText(join(profileDir, 'cordis.patch.yml'), insertRows([{ id: bundledRow, name: bundledPkg }]))
    await loader.mountBundlePlugins(new Context(), profileDir)
    expect(infoOf(bundledRow)?.source).toBe('external')
  })

  test('实验档：meta 与插件中心都透传 pneuma.experimental', async () => {
    const experimentalRow = unique('src-experimental')
    const regularRow = unique('src-regular')
    const kernelMarksId = unique('src-kernel-marks')
    const appDir = makeApp(unique('rows-experimental'), [
      {
        id: experimentalRow,
        name: unique('@p3/src-experimental'),
        tag: unique('src-experimental'),
        pneuma: { toggleable: true, experimental: true },
      },
      { id: regularRow, name: unique('@p3/src-regular'), tag: unique('src-regular'), pneuma: { toggleable: true } },
      {
        id: kernelMarksId,
        name: unique('@p3/src-kernel-marks'),
        tag: unique('src-kernel-marks'),
        pneuma: { experimental: true },
      },
    ])
    const failures = await loader.mountApplicationRows(new Context(), { appDir, surface: 'none' })
    expect(failures).toEqual([])
    expect(registry.getPluginMeta(experimentalRow)?.experimental).toBe(true)
    expect(infoOf(experimentalRow)?.experimental).toBe(true)
    expect(infoOf(regularRow)?.experimental).toBeUndefined()

    /** 插件中心的分档判据（与 `ui-plugins/ui/ui.tsx` 的过滤顺序一致：实验优先于 `ui-` 前缀）。 */
    const groupOf = (row: ReturnType<typeof infoOf>): string => {
      if (row === undefined) return 'missing'
      if (row.source === 'external') return 'custom'
      if (!row.toggleable) return 'kernel'
      if (row.experimental === true) return 'experimental'
      return row.file.startsWith('ui-') ? 'uiUnits' : 'official'
    }
    expect(groupOf(infoOf(experimentalRow))).toBe('experimental')
    expect(groupOf(infoOf(regularRow))).toBe('official')
    expect(groupOf(infoOf(kernelMarksId))).toBe('kernel')
  })

  test('三个真实包的清单确实带了 experimental 且仍可拨', () => {
    // 夹具证明「分档判据」，这三条证明「真包真的被标了」——判据对了但清单漏标，
    // 界面上那些行会落进「官方可开关」，用户就分不出实验档。
    for (const name of ['dsh-compat', 'ops', 'self-improve']) {
      const manifest = JSON.parse(
        readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8'),
      ) as { pneuma?: { experimental?: boolean; toggleable?: boolean } }
      expect(manifest.pneuma?.experimental, name).toBe(true)
      expect(manifest.pneuma?.toggleable, name).toBe(true)
    }
  })

  test('应用自带行的包级覆盖：overridable 用 profile 那份，pinned 仍用应用那份', async () => {
    const ovrId = unique('ovr-a')
    const pinId = unique('pin-a')
    const ovrPkg = unique('@p3/ovr-a')
    const pinPkg = unique('@p3/pin-a')
    const appDir = makeApp(unique('rows-override'), [
      { id: ovrId, name: ovrPkg, tag: 'app-ovr-a', pneuma: { resolution: 'overridable' } },
      { id: pinId, name: pinPkg, tag: 'app-pin-a', pneuma: { resolution: 'pinned' } },
    ])
    const profileDir = makeProfile(unique('override'))
    makePackage(profileDir, ovrPkg, { entries: { 'index.js': 'profile-ovr-a' } })
    makePackage(profileDir, pinPkg, { entries: { 'index.js': 'profile-pin-a' } })

    const failures = await loader.mountApplicationRows(new Context(), {
      appDir,
      surface: 'none',
      overrideDir: profileDir,
    })
    expect(failures).toEqual([])
    const mountedTail = RECORD.mounted.slice(-4).join(',')
    expect(mountedTail).toContain('profile-ovr-a')
    expect(mountedTail).not.toContain('app-ovr-a')
    expect(mountedTail).toContain('app-pin-a')
    expect(mountedTail).not.toContain('profile-pin-a')

    // 不查 profile（overrideDir: null）：另起一份安装目录，免得上一次解析进进程级解析表。
    const noOverridePkg = unique('@p3/ovr-c')
    const noOverrideApp = makeApp(unique('rows-override-null'), [
      { id: unique('ovr-c'), name: noOverridePkg, tag: 'app-ovr-c', pneuma: { resolution: 'overridable' } },
    ])
    makePackage(profileDir, noOverridePkg, { entries: { 'index.js': 'profile-ovr-c' } })
    const noOverride = await loader.mountApplicationRows(new Context(), {
      appDir: noOverrideApp,
      surface: 'none',
      overrideDir: null,
    })
    expect(noOverride).toEqual([])
    expect(RECORD.mounted).toContain('app-ovr-c')
    expect(RECORD.mounted).not.toContain('profile-ovr-c')
  })

  test('hostConfig：命中的行整份替代 plugins.json（不深合并），没命中的仍读磁盘', async () => {
    const hostId = unique('host-cfg')
    const diskId = unique('disk-cfg')
    const hostTag = unique('host-cfg')
    const diskTag = unique('disk-cfg')
    const appDir = makeApp(unique('rows-hostconfig'), [
      { id: hostId, name: unique('@p3/host-cfg'), tag: hostTag, recordConfig: true },
      { id: diskId, name: unique('@p3/disk-cfg'), tag: diskTag, recordConfig: true },
    ])
    writeJson(PLUGINS_JSON, {
      version: 1,
      entries: [
        { file: hostId, disabled: false, config: { fromDisk: true, shared: 'disk' } },
        { file: diskId, disabled: false, config: { fromDisk: true } },
      ],
    })
    const failures = await loader.mountApplicationRows(new Context(), {
      appDir,
      hostConfig: { [hostId]: { fromHost: true, shared: 'host' } },
    })
    expect(failures).toEqual([])
    expect(RECORD.configs[hostTag]).toEqual({ fromHost: true, shared: 'host' })
    expect((RECORD.configs[hostTag] as { fromDisk?: boolean }).fromDisk).toBeUndefined()
    expect(RECORD.configs[diskTag]).toEqual({ fromDisk: true })
  })
})
