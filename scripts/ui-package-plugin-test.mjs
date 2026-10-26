// 组合包的界面半边（2.0）：一个包声明 dsh.client.platform = 'pneuma'，宿主收进启动图。
// 跑法：cd D:\dsc && pnpm run build && node scripts/ui-package-plugin-test.mjs
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-ui-package-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(join(home, '.dsc'), { recursive: true })

const {
  collectUiArtifactsForPlatform,
  isPackageUiEntry,
  isThirdPartyUiEntry,
  lookupPackageUiBundle,
  readUiArtifactBytes,
  scanPackageUiTrusts,
  scanThirdPartyUiTrusts,
} = await import('../lib/core/ui-bundles.js')
const { writePluginEnabled } = await import('../lib/core/plugin-registry.js')
const { composeUiBootGraph } = await import('../lib/ui/manifest.js')
const { createUiBootSource } = await import('../lib/core/ui-boot-source.js')
const { toUiPluginRows } = await import('../lib/core/ui-bundles.js')

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (extra === '' ? '' : ' — ' + extra)) }
}

const profile = join(home, 'profile')
const third = join(home, 'third-party')
mkdirSync(third, { recursive: true })

function writePackage(name, manifest, files = {}) {
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

const bundle = "module.exports = { name: '成本条', apply(ui) { ui.slots.register('composer.footer', { id: 'cost' }, () => null) } }\n"
writePackage('dsh-cost-meter', {
  dsh: { client: { platform: 'pneuma', api: '^2.0.0', inject: [] } },
  exports: { './client': { default: './lib/client.js' } },
}, { 'lib/client.js': bundle })

// dsh 自己的载体（web）：只列不加载，不进启动图
writePackage('dsh-other', {
  dsh: { client: { platform: 'web', api: '^2.0.0' } },
  exports: { './client': { default: './lib/client.js' } },
}, { 'lib/client.js': bundle })

// 缺 api
writePackage('no-api', {
  dsh: { client: { platform: 'pneuma' } },
  exports: { './client': { default: './lib/client.js' } },
}, { 'lib/client.js': bundle })

// api 对不上（1.x 的壳契约）
writePackage('old-api', {
  dsh: { client: { platform: 'pneuma', api: '^1.0.0' } },
  exports: { './client': { default: './lib/client.js' } },
}, { 'lib/client.js': bundle })

// 没有 exports["./client"]
writePackage('no-entry', { dsh: { client: { platform: 'pneuma', api: '^2.0.0' } } })

// 载体声明写坏（'term' 不是认得的载体）：整条拒掉，不静默按 web 处理
writePackage('bad-platforms', {
  dsh: { client: { platform: 'pneuma', api: '^2.0.0', platforms: ['web', 'term'] } },
  exports: { './client': { default: './lib/client.js' } },
}, { 'lib/client.js': bundle })

// 声明同时服务终端壳（platforms: [web, tui]）：一份代码出两行，两个载体各取各的
writePackage('both-shells', {
  dsh: { client: { platform: 'pneuma', api: '^2.0.0', platforms: ['web', 'tui'] } },
  exports: { './client': { default: './lib/client.js' } },
}, { 'lib/client.js': bundle })

// services / phase：与内置产物、第三方同一套字段（坏值要记问题，不能静默丢）
writePackage('declared-deps', {
  dsh: { client: { platform: 'pneuma', api: '^2.0.0', services: ['probe.seat'], phase: 'early' } },
  exports: { './client': { default: './lib/client.js' } },
}, { 'lib/client.js': bundle })
writePackage('bad-deps', {
  dsh: { client: { platform: 'pneuma', api: '^2.0.0', services: 'probe.seat', phase: 'soon' } },
  exports: { './client': { default: './lib/client.js' } },
}, { 'lib/client.js': bundle })

const artifacts = collectUiArtifactsForPlatform('web', { packageDir: profile, thirdPartyDir: third, force: true })
const entry = artifacts.entries.find((item) => item.id === 'dsh-cost-meter')
const problems = artifacts.problems.join('；')

console.log('组合包界面半边：发现与门禁')
check('platform = pneuma 的包被收进产物表', entry !== undefined, JSON.stringify(artifacts.entries.map((e) => e.id)))
check('条的来源标成 package', (entry && entry.origin) === 'package', String(entry && entry.origin))
check('rev 是 16 位内容摘要', /^[0-9a-f]{16}$/.test(String(entry && entry.rev)), String(entry && entry.rev))
check('platform = web 的包不进启动图（只列不加载）', !artifacts.entries.some((item) => item.id === 'dsh-other'))
check('缺 api 的被拒并说清原因', problems.includes('no-api') && problems.includes('api'), problems)
check('api 对不上被门禁拒掉', problems.includes('old-api'), problems)
check('没有 exports["./client"] 的被拒并说清', problems.includes('no-entry'), problems)
check('platforms 里有不认识的值整条拒掉', problems.includes('bad-platforms') && problems.includes('platforms'), problems)
const depsEntry = artifacts.entries.find((item) => item.id === 'declared-deps')
check(
  'services 与 phase 收进条目（与内置产物同一套字段）',
  depsEntry?.services?.join(',') === 'probe.seat' && depsEntry?.phase === 'early',
  JSON.stringify({ services: depsEntry?.services, phase: depsEntry?.phase }),
)
check(
  'services / phase 坏值记 problems，不当没看见',
  problems.includes('bad-deps') && problems.includes('dsh.client.services') && problems.includes('dsh.client.phase'),
  problems,
)
const tuiArtifacts = collectUiArtifactsForPlatform('tui', { packageDir: profile, thirdPartyDir: third, force: true })
check(
  '缺省只服务 web：终端壳的产物表里没有它',
  !tuiArtifacts.entries.some((item) => item.id === 'dsh-cost-meter'),
  JSON.stringify(tuiArtifacts.entries.map((e) => e.id)),
)
check(
  '声明 platforms: [web, tui] 后终端壳也收（一份代码两行）',
  tuiArtifacts.entries.some((item) => item.id === 'both-shells' && item.platform === 'tui'),
  JSON.stringify(tuiArtifacts.entries.map((e) => e.id)),
)
check(
  'web 视图里同一份包也在（platform 缺省即 web）',
  artifacts.entries.some((item) => item.id === 'both-shells' && item.platform === undefined),
  JSON.stringify(artifacts.entries.map((e) => e.id)),
)

console.log('组合包界面半边：取字节与组图')
const bytes = entry === undefined ? null : readUiArtifactBytes(entry, { packageDir: profile })
check('按条目读出字节（入口由包的 exports 决定）', bytes !== null && bytes.toString('utf8') === bundle, String(bytes === null ? null : bytes.length))
const hit = lookupPackageUiBundle('dsh-cost-meter', 'client.js', String(entry && entry.rev), profile)
check('按 rev 查得到当前字节', hit.known && hit.current && hit.body !== null)
const graph = composeUiBootGraph({ name: 'Pneuma', version: 'test' }, toUiPluginRows(artifacts.entries))
const row = graph.entries.find((item) => item.id === 'dsh-cost-meter')
check('进得了启动图（壳按图装）', row !== undefined, JSON.stringify(graph.entries.map((e) => e.id)))
check('地址是内容寻址的 /plugins/<包名>/client.js?rev=', row !== undefined && row.url.includes('dsh-cost-meter/client.js?rev='), String(row && row.url))

console.log('组合包界面半边：远程壳（手机）那张图里也要有')
// 远程壳与本机界面服务共用 createUiBootSource，缺省按 DSC_PROFILE 解析 profile；
// 这里显式传 packageDir，钉住「手机端看的是同一张图」。
{
  const emptyBuiltin = join(home, 'empty-builtin')
  mkdirSync(emptyBuiltin, { recursive: true })
  // 空的内置目录也要带 apiVersion：门禁按它判包的 @dsc/ui 区间（没有这份清单就无从判，
  // 组合包会被当成「不知道对着哪个壳写的」拒掉——这是失败关闭，不是 bug）。
  writeFileSync(join(emptyBuiltin, 'manifest.json'), JSON.stringify({ version: 1, apiVersion: '2.0.0', plugins: [] }), 'utf8')
  const remote = createUiBootSource({
    host: { name: 'Pneuma', version: 'test' },
    builtinDir: emptyBuiltin,
    thirdPartyDir: third,
    packageDir: profile,
  })
  const remoteGraph = remote.graph()
  check(
    '远程壳的启动图里有这条包界面半',
    remoteGraph.entries.some((item) => item.id === 'dsh-cost-meter'),
    JSON.stringify(remoteGraph.entries.map((e) => e.id)),
  )
  const watched = remote.watchRows().find((item) => item.id === 'dsh-cost-meter')
  check(
    '远程壳 stat 的是包自己的入口（不是内置目录里的同名文件）',
    watched !== undefined && watched.path === join(profile, 'node_modules', 'dsh-cost-meter', 'lib', 'client.js'),
    String(watched && watched.path),
  )
  const served = lookupPackageUiBundle('dsh-cost-meter', 'client.js', String(entry && entry.rev), profile)
  check('远程壳取字节走同一条内容寻址查询', served.known && served.current && served.body !== null)
}

console.log('组合包界面半边：插件中心那张卡与启停入口')
const trusts = scanPackageUiTrusts(artifacts.apiVersion, new Set(), profile)
const costRow = trusts.find((item) => item.name === 'dsh-cost-meter')
check('卡上看得见这条包界面半', costRow !== undefined, JSON.stringify(trusts.map((item) => item.name)))
check('来源标成 package', costRow !== undefined && costRow.origin === 'package', String(costRow && costRow.origin))
check('启停键是 <包名>/client（不是第三方那种 /ui/client.js）', costRow !== undefined && costRow.key === 'dsh-cost-meter/client', String(costRow && costRow.key))
check('组合包恒为已同意（装进 profile 就是同意）', costRow !== undefined && costRow.trusted === true && costRow.trustedAt === undefined)
// 卡片上要能看出「装的是哪个版本、来自哪一层」——没有这两项时，装了多个 profile
// 或同一个包升了版，用户只能回命令行敲 numa plugin list 才知道。
check('卡上带包版本', costRow !== undefined && costRow.version === '1.0.0', String(costRow && costRow.version))
check('卡上带 profile 名（来源）', costRow !== undefined && costRow.profile === 'profile', String(costRow && costRow.profile))
check('http 取字节不受这两个字段影响', costRow !== undefined && typeof costRow.api === 'string')
check('卡上不带 dsh 自己的载体（platform = web）', !trusts.some((item) => item.name === 'dsh-other'))
check('缺声明的行带 manifest 档', trusts.find((item) => item.name === 'no-api')?.problemKind === 'manifest')
check('版本不满足的行带 version 档', trusts.find((item) => item.name === 'old-api')?.problemKind === 'version')
check('没有入口的行带 artifact 档', trusts.find((item) => item.name === 'no-entry')?.problemKind === 'artifact')
// 第三方那组（对照组）：每行也要带 key 与 origin，形状与组合包那一组一致。
mkdirSync(join(third, 'demo-third', 'ui'), { recursive: true })
writeFileSync(join(third, 'demo-third', 'plugin.json'), JSON.stringify({ api: '^2.0.0' }), 'utf8')
writeFileSync(join(third, 'demo-third', 'ui', 'client.js'), bundle, 'utf8')
const thirdRows = scanThirdPartyUiTrusts(artifacts.apiVersion, new Set(), third)
check(
  '第三方那组每行也带 key 与 origin（两处同形）',
  thirdRows.length === 1 && thirdRows[0].key === 'demo-third/ui/client.js' && thirdRows[0].origin === 'third-party',
  JSON.stringify(thirdRows),
)
check(
  '第三方行没有版本与 profile（不许冒充组合包）',
  thirdRows[0].version === undefined && thirdRows[0].profile === undefined,
  JSON.stringify({ v: thirdRows[0].version, p: thirdRows[0].profile }),
)

check('isPackageUiEntry 认 <包名>/client', isPackageUiEntry('dsh-cost-meter/client', profile) === true)
check('isPackageUiEntry 不认宿主插件名', isPackageUiEntry('goal', profile) === false)
check('isPackageUiEntry 不认 dsh 自己的载体（platform = web）', isPackageUiEntry('dsh-other/client', profile) === false)
check('isPackageUiEntry 对声明了但坏掉的包仍认（它确实是我们的界面半）', isPackageUiEntry('no-entry/client', profile) === true)
check('isThirdPartyUiEntry 不认组合包的键（两条路不混）', isThirdPartyUiEntry('dsh-cost-meter/client') === false)

// 停用走 plugins.json 的条目树：产物表里消失，卡片上还在（带 enabled=false）。
writePluginEnabled('dsh-cost-meter/client', false)
const afterOff = collectUiArtifactsForPlatform('web', { packageDir: profile, thirdPartyDir: third, force: true })
check('停用后不进启动图', !afterOff.entries.some((item) => item.id === 'dsh-cost-meter'))
check('停用的 id 单独列出来（装载器要能说「被停用了」）', afterOff.disabled.includes('dsh-cost-meter'), JSON.stringify(afterOff.disabled))
const offRow = scanPackageUiTrusts(afterOff.apiVersion, new Set(), profile).find((item) => item.name === 'dsh-cost-meter')
check('停用后卡片上还在，且 enabled=false', offRow !== undefined && offRow.enabled === false)
writePluginEnabled('dsh-cost-meter/client', true)
const afterOn = collectUiArtifactsForPlatform('web', { packageDir: profile, thirdPartyDir: third, force: true })
check('再打开又回到启动图', afterOn.entries.some((item) => item.id === 'dsh-cost-meter'))

console.log(String.fromCharCode(10) + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
