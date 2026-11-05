/**
 * P2「加载器对齐」自检：行目标解析（含 exports 子路径）/ 身份 = 行 id / 安装锚点与
 * pinned-overridable / 默认关的行进目录 / 行级 inject / 设置分区元数据 /
 * 行级版本闸（engines.pneuma）/ plugins.json 迁移与坏文件拒写 / 行 id 重复即失败。
 *
 * 全部夹具造在临时目录里（HOME 与 DSC_HOME 都指过去），不碰真实的 ~/.dsc。
 * 运行：pnpm build && node scripts/plugin-model-test.mjs
 * 想拿别的构建产物跑（例如临时 tsc 输出目录）：
 *   PNEUMA_TEST_LIB=.p2build node scripts/plugin-model-test.mjs
 *
 * @module dsc/scripts/plugin-model-test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const libDir =
  process.env.PNEUMA_TEST_LIB === undefined
    ? join(repoRoot, 'lib')
    : resolve(repoRoot, process.env.PNEUMA_TEST_LIB)

const home = mkdtempSync(join(tmpdir(), 'dsc-plugin-model-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
// 这条自检自己指定 profile 目录，不让 config.yaml 里的 profile 混进来
delete process.env.DSC_PROFILE
mkdirSync(process.env.DSC_HOME, { recursive: true })

const pluginsJson = join(process.env.DSC_HOME, 'plugins.json')

let pass = 0
let fail = 0
/** 一条断言：通过打印 PASS，失败打印 FAIL 并带现场。 */
function check(label, ok, extra) {
  if (ok) {
    pass += 1
    console.log('PASS  ' + label)
    return
  }
  fail += 1
  console.log('FAIL  ' + label + (extra === undefined || extra === '' ? '' : ' \u2192 ' + String(extra)))
}

const writeText = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}
const writeJson = (file, value) => writeText(file, JSON.stringify(value, null, 2) + '\n')
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const libUrl = (relative) => pathToFileURL(join(libDir, relative)).href

// ── 夹具：插件模块与包 ────────────────────────────────────────────────────────
// 模块里不 import 任何东西：本自检要盯的是「加载器把谁挂上了」，不是插件能做什么。

globalThis.__P2 = { imported: [], mounted: [], disposed: [], loaded: {}, configs: {} }

/** 一个最小 cordis object plugin 的源码（tag 用来认它是哪一份）。 */
function moduleSource(tag, extraLines) {
  const lines = [
    "globalThis.__P2.imported.push('" + tag + "')",
    ...(extraLines === undefined ? [] : extraLines),
    "export const name = '" + tag + "'",
    'export const inject = []',
    'export function apply() {',
    "  globalThis.__P2.mounted.push('" + tag + "')",
    '  return () => {',
    "    globalThis.__P2.disposed.push('" + tag + "')",
    '  }',
    '}',
    '',
  ]
  return lines.join('\n')
}

/** 同上，但把 apply 收到的 config 记下来（验 hostConfig 用）。 */
function moduleSourceWithConfig(tag) {
  return [
    "globalThis.__P2.imported.push('" + tag + "')",
    "export const name = '" + tag + "'",
    'export const inject = []',
    'export function apply(ctx, config) {',
    "  globalThis.__P2.mounted.push('" + tag + "')",
    "  globalThis.__P2.configs['" + tag + "'] = config",
    '  return () => {',
    "    globalThis.__P2.disposed.push('" + tag + "')",
    '  }',
    '}',
    '',
  ].join('\n')
}

/** 写一个装在 <root>/node_modules 下的包。 */
function makePackage(root, name, options) {
  const dir = join(root, 'node_modules', ...name.split('/'))
  const manifest = {
    name,
    version: options.version === undefined ? '1.0.0' : options.version,
    type: 'module',
    exports: options.exports === undefined ? { '.': './index.js', './package.json': './package.json' } : options.exports,
  }
  if (options.pneuma !== undefined) manifest.pneuma = options.pneuma
  if (options.extra !== undefined) Object.assign(manifest, options.extra)
  writeJson(join(dir, 'package.json'), manifest)
  for (const [file, tag] of Object.entries(options.entries)) {
    writeText(join(dir, file), options.recordConfig === true ? moduleSourceWithConfig(tag) : moduleSource(tag))
  }
  return dir
}

/** 写一个 profile 目录：bundles 是包名列表，patch 是这一层自己的 cordis.patch.yml。 */
function makeProfile(name, options = {}) {
  const dir = join(home, 'profiles', name)
  writeJson(join(dir, 'package.json'), {
    name: 'profile-' + name,
    dsh: { profile: { bundles: options.bundles === undefined ? [] : options.bundles } },
  })
  if (options.patch !== undefined) writeText(join(dir, 'cordis.patch.yml'), options.patch)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  return dir
}

/** 写一个带 patch 的组合包（patch 里的行由本自检给）。 */
function makeBundle(profileDir, name, patchText) {
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

/**
 * 造一个「应用自带行」的安装目录：<appDir>/lib/node_modules/@pneuma/base 的 patch
 * + 若干功能包（都住在 <appDir>/lib/node_modules 下）。
 */
function makeApp(appName, rows) {
  const appDir = join(home, 'apps', appName)
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

/** 一个 insert 行块（YAML）。 */
function insertRows(rows) {
  // 名字一律加引号：YAML 的 plain scalar 不能以 @ 开头（@scope/name 会被解析器拒掉）
  return (
    '- insert:\n' +
    rows
      .map(
        (row) =>
          '    - id: ' + row.id + '\n      name: ' + "'" + row.name + "'" + (row.extra === undefined ? '' : '\n' + row.extra),
      )
      .join('\n') +
    '\n'
  )
}

const { Context } = await import('@deepseek-ai/cordis')
const loader = await import(libUrl('core/plugin-loader.js'))
const registry = await import(libUrl('core/plugin-registry.js'))
const bundleApi = await import(libUrl('core/plugin-bundle.js'))

/** 一个裸 cordis 根（自检不装内核，只验加载器）。 */
const newContext = () => new Context()

/** 挂一次组合包；返回 { root, result }（失败时抛）。 */
async function mountProfile(profileDir, appDir) {
  const root = newContext()
  const result = await loader.mountBundlePlugins(root, profileDir, appDir === undefined ? {} : { appDir })
  return { root, result }
}
const infos = () => registry.listPluginInfos()
const infoOf = (file) => infos().find((item) => item.file === file)

// ── 1. 子路径行 + 身份 = 行 id + 设置分区元数据 ────────────────────────────────
console.log('── 行目标解析：exports 子路径、身份、设置分区 ──')
{
  const profileDir = makeProfile('subpath')
  makePackage(profileDir, '@p2/alpha', {
    pneuma: { title: '甲包', description: '子路径与身份的自检包', settingsSection: 'alpha' },
    exports: { '.': './index.js', './panel': './panel.js', './package.json': './package.json' },
    entries: { 'index.js': 'alpha', 'panel.js': 'alpha-panel' },
  })
  writeText(
    join(profileDir, 'cordis.patch.yml'),
    insertRows([
      { id: 'alpha', name: '@p2/alpha' },
      { id: 'alpha-panel', name: '@p2/alpha/panel' },
    ]),
  )

  const { result } = await mountProfile(profileDir)
  check('两行都挂上了（exports 子路径走 Node 解析）', result.failures.length === 0, JSON.stringify(result.failures))
  check(
    '包根那一行真的执行了',
    globalThis.__P2.mounted.includes('alpha'),
    JSON.stringify(globalThis.__P2.mounted),
  )
  check(
    '子路径那一行真的执行了',
    globalThis.__P2.mounted.includes('alpha-panel'),
    JSON.stringify(globalThis.__P2.mounted),
  )
  check('meta.file 是行 id（不是文件的 basename）', registry.getPluginMeta('alpha')?.file === 'alpha')
  check('子路径行的 meta.file 也是行 id', registry.getPluginMeta('alpha-panel')?.file === 'alpha-panel')
  check('插件中心按行 id 列出来', infoOf('alpha') !== undefined && infoOf('alpha-panel') !== undefined)
  check(
    'package.json 的 pneuma.settingsSection 进了 meta',
    registry.getPluginMeta('alpha')?.settingsSection === 'alpha',
    String(registry.getPluginMeta('alpha')?.settingsSection),
  )
  check(
    'package.json 的 pneuma.title 进了插件中心',
    infoOf('alpha')?.name === '甲包',
    String(infoOf('alpha')?.name),
  )

  // 热启停按身份：子路径那一行单独停用，包根那一行不受影响
  const off = await loader.setPluginEnabledHot('alpha-panel', false)
  check('按行 id 热停用成功', off.ok === true, JSON.stringify(off))
  check('停用的是子路径那一份 fiber', globalThis.__P2.disposed.includes('alpha-panel'))
  check('包根那一行没被连带停掉', infoOf('alpha')?.enabled === true)
  check('停用写进了 plugins.json（键是行 id）', readJson(pluginsJson).entries.some((entry) => entry.file === 'alpha-panel'))

  const on = await loader.setPluginEnabledHot('alpha-panel', true)
  check('按行 id 重新挂载成功（找回原入口）', on.ok === true, JSON.stringify(on))
  check('重新挂载真的执行了模块', globalThis.__P2.mounted.filter((tag) => tag === 'alpha-panel').length === 2)
}

// ── 2. 默认关的行：进目录，但不 import、不挂载 ─────────────────────────────────
console.log('── 默认关的行：插件中心看得见，代码不加载 ──')
{
  const profileDir = makeProfile('disabled-row')
  makePackage(profileDir, '@p2/beta', {
    pneuma: { title: '乙包', description: '默认关的自检包', settingsSection: 'beta' },
    entries: { 'index.js': 'beta' },
  })
  writeText(
    join(profileDir, 'cordis.patch.yml'),
    insertRows([{ id: 'beta', name: '@p2/beta', extra: '      disabled: true' }]),
  )

  const before = globalThis.__P2.imported.length
  const { result } = await mountProfile(profileDir)
  check('默认关的行不算失败', result.failures.length === 0, JSON.stringify(result.failures))
  check('插件中心列得出这一行（不再直接 continue）', infoOf('beta') !== undefined, JSON.stringify(infos().map((i) => i.file)))
  check('显示为停用', infoOf('beta')?.enabled === false)
  check('meta 标了 defaultDisabled', registry.getPluginMeta('beta')?.defaultDisabled === true)
  check('标题与设置分区来自 package.json', infoOf('beta')?.name === '乙包' && infoOf('beta')?.settingsSection === 'beta')
  check('没有 import 它的模块', !globalThis.__P2.imported.includes('beta'), JSON.stringify(globalThis.__P2.imported.slice(before)))
  check('没有挂载（fiber 不存在）', !globalThis.__P2.mounted.includes('beta'))

  // 用户把它打开：行 id 要能找回入口
  const on = await loader.setPluginEnabledHot('beta', true)
  check('打开默认关的行会真的挂上', on.ok === true && globalThis.__P2.mounted.includes('beta'), JSON.stringify(on))
}

// ── 3. 安装锚点：pinned 用应用那份，overridable 用 profile 那份 ───────────────
console.log('── 安装锚点：pinned / overridable ──')
{
  const appDir = join(home, 'app-anchor')
  mkdirSync(join(appDir, 'lib', 'node_modules'), { recursive: true })
  const profileDir = makeProfile('anchors')

  // 两边各一份，版本与标记不同：谁被加载一目了然
  makePackage(join(appDir, 'lib'), '@p2/ovr', {
    version: '1.0.0',
    entries: { 'index.js': 'ovr-app' },
  })
  makePackage(profileDir, '@p2/ovr', {
    version: '2.0.0',
    entries: { 'index.js': 'ovr-profile' },
  })
  makePackage(join(appDir, 'lib'), '@p2/pin', {
    version: '1.0.0',
    pneuma: { resolution: 'pinned' },
    entries: { 'index.js': 'pin-app' },
  })
  makePackage(profileDir, '@p2/pin', {
    version: '2.0.0',
    pneuma: { resolution: 'pinned' },
    entries: { 'index.js': 'pin-profile' },
  })

  writeText(
    join(profileDir, 'cordis.patch.yml'),
    insertRows([
      { id: 'ovr', name: '@p2/ovr' },
      { id: 'pin', name: '@p2/pin' },
    ]),
  )

  const { result } = await mountProfile(profileDir, appDir)
  const warnings = result.warnings.join(' | ')
  check('两行都挂上了', result.failures.length === 0, JSON.stringify(result.failures))
  check('overridable 用 profile 那份', globalThis.__P2.mounted.includes('ovr-profile'), JSON.stringify(globalThis.__P2.mounted))
  check('overridable 没有误用应用那份', !globalThis.__P2.mounted.includes('ovr-app'))
  check('pinned 用应用安装目录那份', globalThis.__P2.mounted.includes('pin-app'), JSON.stringify(globalThis.__P2.mounted))
  check('pinned 没有误用 profile 那份', !globalThis.__P2.mounted.includes('pin-profile'))
  check(
    'pinned 被 profile 副本让路时给了告警',
    warnings.includes('pinned') && warnings.includes(join(profileDir, 'node_modules', '@p2', 'pin')),
    warnings,
  )
  check('overridable 不算冲突、也没有多余告警', !warnings.includes('@p2/ovr'), warnings)
}

// ── 3b. 行级版本闸：engines.pneuma 按「实际解析到的包」判 ─────────────────────
console.log('── 行级版本闸：engines.pneuma ──')
{
  const profileDir = makeProfile('engines')
  makePackage(profileDir, '@p2/gate-ok', {
    entries: { 'index.js': 'gate-ok' },
    extra: { engines: { pneuma: '>=1.0.0 <2.0.0' } },
  })
  makePackage(profileDir, '@p2/gate-bad', {
    pneuma: { title: '下一代契约的包' },
    entries: { 'index.js': 'gate-bad' },
    extra: { engines: { pneuma: '>=2.0.0' } },
  })
  writeText(
    join(profileDir, 'cordis.patch.yml'),
    insertRows([
      { id: 'gate-ok', name: '@p2/gate-ok' },
      { id: 'gate-bad', name: '@p2/gate-bad' },
    ]),
  )

  const { result } = await mountProfile(profileDir)
  const warnings = result.warnings.join(' | ')
  check('契约满足的行照常挂上', globalThis.__P2.mounted.includes('gate-ok'))
  check('要求下一代契约的行被跳过', !globalThis.__P2.mounted.includes('gate-bad'))
  check(
    '跳过的那一行进失败清单（内核会报出来）',
    result.failures.length === 1 && result.failures[0].file === 'gate-bad',
    JSON.stringify(result.failures),
  )
  check(
    '失败文案写了包要求什么、当前契约是什么',
    String(result.failures[0]?.problem).includes('>=2.0.0') && String(result.failures[0]?.problem).includes('1.0.0'),
    String(result.failures[0]?.problem),
  )
  check(
    '插件中心看得见这一行、并且带 problem',
    infoOf('gate-bad')?.problem !== undefined && String(infoOf('gate-bad')?.problem).includes('>=2.0.0'),
    JSON.stringify(infoOf('gate-bad')),
  )
  check('告警说了怎么办（compatibility.json 登记豁免）', warnings.includes('compatibility.json'), warnings)
}

{
  // 豁免：profile 的 compatibility.json 里登记过就照挂，并说明是豁免放行的
  const profileDir = makeProfile('engines-exempt')
  makePackage(profileDir, '@p2/gate-exempt', {
    entries: { 'index.js': 'gate-exempt' },
    extra: { engines: { pneuma: '>=2.0.0' } },
  })
  writeText(join(profileDir, 'compatibility.json'), JSON.stringify({ exemptions: [{ package: '@p2/gate-exempt' }] }))
  writeText(join(profileDir, 'cordis.patch.yml'), insertRows([{ id: 'gate-exempt', name: '@p2/gate-exempt' }]))

  const { result } = await mountProfile(profileDir)
  check('登记豁免后照常挂上', globalThis.__P2.mounted.includes('gate-exempt'), JSON.stringify(result.failures))
  check('豁免过的行不算失败', result.failures.length === 0, JSON.stringify(result.failures))
  check('告警说明是豁免放行的', result.warnings.join(' | ').includes('豁免'), result.warnings.join(' | '))
}

{
  // 豁免登记过、但按旧运行时记的：契约从 0.2.1 升到 0.2.2 以后这类记录会静默失效。
  // 这里盯的是「用户能不能看懂为什么会失效、下一步按哪条命令」，而不是再劝他登记一次。
  const current = bundleApi.DSH_CONTRACT_VERSION
  const profileDir = makeProfile('engines-stale')
  makePackage(profileDir, '@p2/gate-stale', {
    version: '1.2.3',
    entries: { 'index.js': 'gate-stale' },
    extra: { engines: { pneuma: '>=2.0.0' } },
  })
  writeText(
    join(profileDir, 'compatibility.json'),
    JSON.stringify({ exemptions: [{ package: '@p2/gate-stale', version: '1.2.3', dshVersion: '0.2.1' }] }),
  )
  writeText(join(profileDir, 'cordis.patch.yml'), insertRows([{ id: 'gate-stale', name: '@p2/gate-stale' }]))

  const stale = await mountProfile(profileDir)
  const text = stale.result.failures.map((item) => String(item.problem)).join(' | ')
  check('按旧运行时登记的豁免不再放行', !globalThis.__P2.mounted.includes('gate-stale'), text)
  check('失败文案点出旧记录按哪个运行时登记、当前是哪个', text.includes('0.2.1') && text.includes(current), text)
  check(
    '失败文案给出重按命令（包名@版本 × 当前运行时 × 风险确认）',
    text.includes(`numa plugin allow-version @p2/gate-stale@1.2.3 --dsh-version ${current} --accept-risk`),
    text,
  )
  check('不再让用户「去登记豁免」（他已经登记过）', !text.includes('登记豁免可以强行启用'), text)

  // 重按一次（同样的包与版本，换成当前运行时）就当场放行，不需要改包。
  writeText(
    join(profileDir, 'compatibility.json'),
    JSON.stringify({ exemptions: [{ package: '@p2/gate-stale', version: '1.2.3', dshVersion: current }] }),
  )
  const renewed = await mountProfile(profileDir)
  check('重按后照常挂上', globalThis.__P2.mounted.includes('gate-stale'), JSON.stringify(renewed.result.failures))
  check('重按后不算失败', renewed.result.failures.length === 0, JSON.stringify(renewed.result.failures))

  // 同一个包换了版本：登记的是上一版，文案要说清「登记的是 v1.2.2」，别只说对不上。
  const movedProfile = makeProfile('engines-moved')
  makePackage(movedProfile, '@p2/gate-moved', {
    version: '1.2.3',
    entries: { 'index.js': 'gate-moved' },
    extra: { engines: { pneuma: '>=2.0.0' } },
  })
  writeText(
    join(movedProfile, 'compatibility.json'),
    JSON.stringify({ exemptions: [{ package: '@p2/gate-moved', version: '1.2.2', dshVersion: current }] }),
  )
  writeText(join(movedProfile, 'cordis.patch.yml'), insertRows([{ id: 'gate-moved', name: '@p2/gate-moved' }]))
  const moved = await mountProfile(movedProfile)
  const movedText = moved.result.failures.map((item) => String(item.problem)).join(' | ')
  check('换了包版本的豁免不算数', !globalThis.__P2.mounted.includes('gate-moved'), movedText)
  check('文案说清登记的是哪一版、这一份是哪一版', movedText.includes('v1.2.2') && movedText.includes('v1.2.3'), movedText)
}

// ── 4. plugins.json 迁移：旧键双查 + 惰性写回 + 未知键保留 ─────────────────────
console.log('── plugins.json：旧键、写回、未知键 ──')
{
  // 4a：旧格式（条目键就是行 id）
  writeJson(pluginsJson, {
    version: 1,
    entries: [{ file: 'ops', disabled: true, config: { x: 1 } }],
    uiTrust: { 't/ui/client.js': { trustedAt: 123 } },
    custom: { keep: true },
  })
  const entries = registry.readPluginEntries()
  check(
    '旧格式 entries 读得到',
    entries.length === 1 && entries[0].file === 'ops' && entries[0].disabled === true && entries[0].config.x === 1,
    JSON.stringify(entries),
  )
  check('按行 id 读到旧键的配置', registry.getPluginConfig('ops').x === 1, JSON.stringify(registry.getPluginConfig('ops')))
  registry.writePluginEnabled('ops', true)
  const doc = readJson(pluginsJson)
  check(
    '写回后条目还在、开关变了',
    doc.entries.length === 1 && doc.entries[0].file === 'ops' && doc.entries[0].disabled === false,
    JSON.stringify(doc.entries),
  )
  check('未知顶层键 uiTrust 原样保留', doc.uiTrust?.['t/ui/client.js']?.trustedAt === 123, JSON.stringify(doc.uiTrust))
  check('未知顶层键 custom 原样保留', doc.custom?.keep === true, JSON.stringify(doc.custom))

  // 4b：旧键是文件名（0.8.1 的写法），行 id 是新的。
  // 入口特意不叫 index.js：那个名字被多个包共用，按文件名迁移本就分不清（见 4c）。
  const profileDir = makeProfile('migrate-alias')
  makePackage(profileDir, '@p2/legacy', {
    exports: { '.': './main.js', './package.json': './package.json' },
    entries: { 'main.js': 'legacy' },
  })
  writeText(join(profileDir, 'cordis.patch.yml'), insertRows([{ id: 'legacy', name: '@p2/legacy' }]))
  writeJson(pluginsJson, {
    version: 1,
    entries: [{ file: 'main.js', disabled: false, config: { y: 2 } }],
    uiTrust: { 't/ui/client.js': { trustedAt: 456 } },
  })

  const { result } = await mountProfile(profileDir)
  check('旧文件名键的那一行照常挂上', result.failures.length === 0, JSON.stringify(result.failures))
  check('按行 id 读到文件名旧键的配置', registry.getPluginConfig('legacy').y === 2, JSON.stringify(registry.getPluginConfig('legacy')))

  registry.writePluginEnabled('legacy', false)
  const merged = readJson(pluginsJson)
  const byFile = new Map(merged.entries.map((entry) => [entry.file, entry]))
  check('写回后新键存在', byFile.has('legacy'), JSON.stringify([...byFile.keys()]))
  check('写回后旧键也还在（回滚到旧版本读得到）', byFile.has('main.js'))
  check('新键的开关是停用', byFile.get('legacy')?.disabled === true)
  check('旧键同步成停用', byFile.get('main.js')?.disabled === true)
  check('迁移时 uiTrust 不丢', merged.uiTrust?.['t/ui/client.js']?.trustedAt === 456, JSON.stringify(merged.uiTrust))

  // 4c：两个行共用一个入口文件名时，旧键有歧义——谁都不许拿它当线索（不能读错别人的配置）
  const ambiguous = makeProfile('migrate-ambiguous')
  makePackage(ambiguous, '@p2/g1', { entries: { 'index.js': 'g1' } })
  makePackage(ambiguous, '@p2/g2', { entries: { 'index.js': 'g2' } })
  writeText(
    join(ambiguous, 'cordis.patch.yml'),
    insertRows([
      { id: 'g1', name: '@p2/g1' },
      { id: 'g2', name: '@p2/g2' },
    ]),
  )
  writeJson(pluginsJson, { version: 1, entries: [{ file: 'index.js', disabled: false, config: { z: 9 } }] })
  const ambiguousMount = await mountProfile(ambiguous)
  check('入口同名的两行照常挂上', ambiguousMount.result.failures.length === 0, JSON.stringify(ambiguousMount.result.failures))
  check(
    '旧键有歧义时不拿它当线索（g1 没读到别人的配置）',
    Object.keys(registry.getPluginConfig('g1')).length === 0,
    JSON.stringify(registry.getPluginConfig('g1')),
  )
  check(
    '旧键有歧义时不拿它当线索（g2 也没读到）',
    Object.keys(registry.getPluginConfig('g2')).length === 0,
    JSON.stringify(registry.getPluginConfig('g2')),
  )
}

// ── 5. 行 id 重复 / 同包两目录：都直接失败 ─────────────────────────────────────
console.log('── 行 id 重复与解析冲突 ──')
{
  const profileDir = makeProfile('dup-id', { bundles: ['bundle-one', 'bundle-two'] })
  makeBundle(profileDir, 'bundle-one', insertRows([{ id: 'twice', name: './plugins/one.js' }]))
  makeBundle(profileDir, 'bundle-two', insertRows([{ id: 'twice', name: './plugins/two.js' }]))
  writeText(join(profileDir, 'node_modules', 'bundle-one', 'plugins', 'one.js'), moduleSource('one'))
  writeText(join(profileDir, 'node_modules', 'bundle-two', 'plugins', 'two.js'), moduleSource('two'))

  let duplicated = null
  try {
    await mountProfile(profileDir)
  } catch (error) {
    duplicated = error
  }
  check('行 id 重复时启动失败', duplicated !== null, '没有抛错')
  const message = duplicated === null ? '' : String(duplicated.message)
  check('报错里写了重复的 id', message.includes('twice'), message)
  check('报错里写了两个来源', message.includes('bundle-one') && message.includes('bundle-two'), message)
  check('重复的那两行都没被挂上', !globalThis.__P2.mounted.includes('one') && !globalThis.__P2.mounted.includes('two'))
}

{
  const dupA = makeProfile('dup-dir-a')
  makePackage(dupA, '@p2/dup', { version: '1.0.0', entries: { 'index.js': 'dup-a' } })
  writeText(join(dupA, 'cordis.patch.yml'), insertRows([{ id: 'dup-a', name: '@p2/dup' }]))
  const dupB = makeProfile('dup-dir-b')
  makePackage(dupB, '@p2/dup', { version: '2.0.0', entries: { 'index.js': 'dup-b' } })
  writeText(join(dupB, 'cordis.patch.yml'), insertRows([{ id: 'dup-b', name: '@p2/dup' }]))

  const first = await mountProfile(dupA)
  check('第一份能解析', first.result.failures.length === 0, JSON.stringify(first.result.failures))
  let conflict = null
  try {
    await mountProfile(dupB)
  } catch (error) {
    conflict = error
  }
  check('同一包名解析出两个目录时启动失败', conflict !== null, '没有抛错')
  const conflictMessage = conflict === null ? '' : String(conflict.message)
  check(
    '冲突报错写明双方路径',
    conflictMessage.includes('dup-dir-a') && conflictMessage.includes('dup-dir-b') && conflictMessage.includes('两个不同的目录'),
    conflictMessage,
  )
}

// ── 6. 应用自带行（mountApplicationRows）──────────────────────────────────────
console.log('── 应用自带行：解析、身份、surface、幂等、hostConfig ──')
{
  const appDir = makeApp('rows-all', [
    { id: 'app-main', name: '@p3/main', tag: 'app-main', pneuma: { title: '自带主行', settingsSection: 'app-main' } },
    { id: 'host-stdio', name: '@p3/hs', tag: 'app-hs' },
    { id: 'tui', name: '@p3/tui', tag: 'app-tui' },
  ])
  const rowsContext = newContext()
  // 'tui'：tui 行挂上、host-stdio 行跳过（surface 表的口径，别的用例再逐向验）。
  const failures = await loader.mountApplicationRows(rowsContext, { appDir, surface: 'tui' })
  check('应用自带行全部挂上', failures.length === 0, JSON.stringify(failures))
  check(
    '普通行与 tui 行都真的执行了',
    ['app-main', 'app-tui'].every((tag) => globalThis.__P2.mounted.includes(tag)),
    JSON.stringify(globalThis.__P2.mounted.slice(-5)),
  )
  check(
    '身份是行 id（app-main / tui）',
    registry.getPluginMeta('app-main')?.file === 'app-main' && registry.getPluginMeta('tui')?.file === 'tui',
  )
  check('package.json 的 settingsSection 进了 meta', registry.getPluginMeta('app-main')?.settingsSection === 'app-main')
  check('package.json 的 title 进了插件中心', infoOf('app-main')?.name === '自带主行', String(infoOf('app-main')?.name))

  // 幂等：再挂一次不该新增 fiber
  const before = globalThis.__P2.mounted.filter((tag) => tag === 'app-main').length
  // 幂等是「同一个 root 上重复调用」：换 Context 就该重新挂（自检会连开两个内核，
  // 那正是 dsh-compat 探针第二次 boot 的场景）。
  const again = await loader.mountApplicationRows(rowsContext, { appDir, surface: 'tui' })
  check('重复调用不报失败', again.length === 0, JSON.stringify(again))
  check(
    '重复调用不重复挂（fiber 数没变）',
    globalThis.__P2.mounted.filter((tag) => tag === 'app-main').length === before,
    String(before) + ' -> ' + String(globalThis.__P2.mounted.filter((tag) => tag === 'app-main').length),
  )

  // 清场：后面的 surface 场景要复用 tui / host-stdio 这两个 id
  for (const id of ['app-main', 'host-stdio', 'tui']) await loader.unmountExternalPlugin(id)
}

{
  // headless：tui 行不挂，host-stdio 行照挂
  const appDir = makeApp('rows-headless', [
    { id: 'app-h', name: '@p3/h-main', tag: 'h-main' },
    { id: 'host-stdio', name: '@p3/h-hs', tag: 'h-hs' },
    { id: 'tui', name: '@p3/h-tui', tag: 'h-tui' },
  ])
  const failures = await loader.mountApplicationRows(newContext(), { appDir, surface: 'headless' })
  check('headless：不算失败', failures.length === 0, JSON.stringify(failures))
  check('headless：tui 行不挂', !globalThis.__P2.mounted.includes('h-tui'))
  check('headless：host-stdio 行照挂', globalThis.__P2.mounted.includes('h-hs'))
  check('headless：普通行照挂', globalThis.__P2.mounted.includes('h-main'))
  for (const id of ['app-h', 'host-stdio', 'tui']) await loader.unmountExternalPlugin(id)
}

{
  // tui：host-stdio 行不挂
  const appDir = makeApp('rows-tui', [
    { id: 'app-t', name: '@p3/t-main', tag: 't-main' },
    { id: 'host-stdio', name: '@p3/t-hs', tag: 't-hs' },
    { id: 'tui', name: '@p3/t-tui', tag: 't-tui' },
  ])
  const failures = await loader.mountApplicationRows(newContext(), { appDir, surface: 'tui' })
  check('tui：不算失败', failures.length === 0, JSON.stringify(failures))
  check('tui：host-stdio 行不挂', !globalThis.__P2.mounted.includes('t-hs'))
  check('tui：tui 行照挂', globalThis.__P2.mounted.includes('t-tui'))
  for (const id of ['app-t', 'host-stdio', 'tui']) await loader.unmountExternalPlugin(id)
}

{
  // 应用自带清单还没生成：返回空数组、不抛（P3 期间的正常状态）
  const appDir = join(home, 'apps', 'rows-missing')
  mkdirSync(appDir, { recursive: true })
  let threw = null
  let result = null
  try {
    result = await loader.mountApplicationRows(newContext(), { appDir })
  } catch (error) {
    threw = error
  }
  check('base 清单不存在时返回空数组且不抛', threw === null && Array.isArray(result) && result.length === 0, threw === null ? JSON.stringify(result) : String(threw))
}

{
  // 应用自带的包也过同一个闸：版本闸挂在「挂一行」这一步，不在「读组合包」那一步。
  const appDir = makeApp('rows-engines', [
    { id: 'app-gate', name: '@p3/gate', tag: 'app-gate', extra: { engines: { pneuma: '>=2.0.0' } } },
  ])
  const failures = await loader.mountApplicationRows(newContext(), { appDir, surface: 'none' })
  check(
    '应用自带行也过版本闸（不满足就跳过）',
    failures.length === 1 && failures[0].file === 'app-gate',
    JSON.stringify(failures),
  )
  check('被闸拦住的行没有挂上', !globalThis.__P2.mounted.includes('app-gate'))
  const exempt = await loader.mountApplicationRows(newContext(), { appDir, surface: 'none', exemptions: ['@p3/gate'] })
  check(
    '传了豁免名单就照挂',
    exempt.length === 0 && globalThis.__P2.mounted.includes('app-gate'),
    JSON.stringify(exempt),
  )
  await loader.unmountExternalPlugin('app-gate')
}

{
  // 应用自带行的包级覆盖：overridable 用 profile 那份，pinned 仍用应用那份。
  // 这是「官方功能包与第三方包一视同仁」的落点：用户装一份改过的 @pneuma/ops 才真的生效。
  const appDir = makeApp('rows-override', [
    { id: 'ovr-a', name: '@p3/ovr-a', tag: 'app-ovr-a', pneuma: { resolution: 'overridable' } },
    { id: 'pin-a', name: '@p3/pin-a', tag: 'app-pin-a', pneuma: { resolution: 'pinned' } },
  ])
  const profileDir = makeProfile('override')
  makePackage(profileDir, '@p3/ovr-a', { entries: { 'index.js': 'profile-ovr-a' } })
  makePackage(profileDir, '@p3/pin-a', { entries: { 'index.js': 'profile-pin-a' } })

  const failures = await loader.mountApplicationRows(newContext(), {
    appDir,
    surface: 'none',
    overrideDir: profileDir,
  })
  check('应用自带行不算失败', failures.length === 0, JSON.stringify(failures))
  check(
    'overridable 的应用行用 profile 那份',
    globalThis.__P2.mounted.includes('profile-ovr-a'),
    JSON.stringify(globalThis.__P2.mounted.slice(-4)),
  )
  check('overridable 的应用行没有误用应用那份', !globalThis.__P2.mounted.includes('app-ovr-a'))
  check(
    'pinned 的应用行仍用应用那份',
    globalThis.__P2.mounted.includes('app-pin-a') && !globalThis.__P2.mounted.includes('profile-pin-a'),
    JSON.stringify(globalThis.__P2.mounted.slice(-4)),
  )
  for (const id of ['ovr-a', 'pin-a']) await loader.unmountExternalPlugin(id)

  // 不查 profile（overrideDir: null）：另起一份安装目录，免得上一次解析进解析表。
  // （解析表是「一次启动里一个包名一个目录」，同一进程里对同名包改口径会被它拦下——那是对的。）
  const appDirNoOverride = makeApp('rows-override-null', [
    { id: 'ovr-c', name: '@p3/ovr-c', tag: 'app-ovr-c', pneuma: { resolution: 'overridable' } },
  ])
  makePackage(profileDir, '@p3/ovr-c', { entries: { 'index.js': 'profile-ovr-c' } })
  const noOverride = await loader.mountApplicationRows(newContext(), {
    appDir: appDirNoOverride,
    surface: 'none',
    overrideDir: null,
  })
  check(
    '不查 profile 时 overridable 走应用那份',
    noOverride.length === 0 && globalThis.__P2.mounted.includes('app-ovr-c'),
    JSON.stringify(noOverride),
  )
  check('不查 profile 时没有加载 profile 副本', !globalThis.__P2.mounted.includes('profile-ovr-c'))
  await loader.unmountExternalPlugin('ovr-c')
}

{
  // hostConfig：命中的行整份替代 plugins.json（不深合并），没命中的仍读磁盘
  const appDir = makeApp('rows-hostconfig', [
    { id: 'host-cfg', name: '@p3/host-cfg', tag: 'host-cfg', recordConfig: true },
    { id: 'disk-cfg', name: '@p3/disk-cfg', tag: 'disk-cfg', recordConfig: true },
  ])
  writeJson(pluginsJson, {
    version: 1,
    entries: [
      { file: 'host-cfg', disabled: false, config: { fromDisk: true, shared: 'disk' } },
      { file: 'disk-cfg', disabled: false, config: { fromDisk: true } },
    ],
  })
  const failures = await loader.mountApplicationRows(newContext(), {
    appDir,
    hostConfig: { 'host-cfg': { fromHost: true, shared: 'host' } },
  })
  check('hostConfig 行不算失败', failures.length === 0, JSON.stringify(failures))
  check(
    '命中的行拿到的是 hostConfig 那份（整份替代）',
    JSON.stringify(globalThis.__P2.configs['host-cfg']) === JSON.stringify({ fromHost: true, shared: 'host' }),
    JSON.stringify(globalThis.__P2.configs['host-cfg']),
  )
  check(
    '盘上的键没有混进来（不做深合并）',
    globalThis.__P2.configs['host-cfg']?.fromDisk === undefined,
    JSON.stringify(globalThis.__P2.configs['host-cfg']),
  )
  check(
    '没命中的行仍读 plugins.json',
    JSON.stringify(globalThis.__P2.configs['disk-cfg']) === JSON.stringify({ fromDisk: true }),
    JSON.stringify(globalThis.__P2.configs['disk-cfg']),
  )
  for (const id of ['host-cfg', 'disk-cfg']) await loader.unmountExternalPlugin(id)
}

// ── 7. 坏 plugins.json：拒绝写盘、文件不动 ────────────────────────────────────
console.log('── 坏 plugins.json ──')
{
  const broken = '{\n  "version": 1,\n  "entries": [\n'
  writeText(pluginsJson, broken)
  let thrown = null
  try {
    registry.writePluginEnabled('ops', false)
  } catch (error) {
    thrown = error
  }
  check('坏文件时写入被拒绝', thrown !== null, '写入居然成功了')
  check('报错说清是哪个文件', thrown !== null && String(thrown.message).includes('plugins.json'), thrown === null ? '' : String(thrown.message))
  check('报错说明不写盘的理由', thrown !== null && String(thrown.message).includes('覆盖'), thrown === null ? '' : String(thrown.message))
  check('文件内容一个字节没变', readFileSync(pluginsJson, 'utf8') === broken)
}

console.log('')
console.log(pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
