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

console.log('组合包界面半边：插件中心那张卡与启停入口')
const trusts = scanPackageUiTrusts(artifacts.apiVersion, new Set(), profile)
const costRow = trusts.find((item) => item.name === 'dsh-cost-meter')
check('卡上看得见这条包界面半', costRow !== undefined, JSON.stringify(trusts.map((item) => item.name)))
check('来源标成 package', costRow !== undefined && costRow.origin === 'package', String(costRow && costRow.origin))
check('启停键是 <包名>/client（不是第三方那种 /ui/client.js）', costRow !== undefined && costRow.key === 'dsh-cost-meter/client', String(costRow && costRow.key))
check('组合包恒为已同意（装进 profile 就是同意）', costRow !== undefined && costRow.trusted === true && costRow.trustedAt === undefined)
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

check('isPackageUiEntry 认 <包名>/client', isPackageUiEntry('dsh-cost-meter/client', profile) === true)
check('isPackageUiEntry 不认宿主插件名', isPackageUiEntry('goal', profile) === false)
check('isPackageUiEntry 不认 dsh 自己的载体（platform = web）', isPackageUiEntry('dsh-other/client', profile) === false)
check('isPackageUiEntry 对声明了但坏掉的包仍认（它确实是我们的界面半）', isPackageUiEntry('no-entry/client', profile) === true)
check('isThirdPartyUiEntry 不认组合包的键（两条路不混）', isThirdPartyUiEntry('dsh-cost-meter/client') === false)

// 停用走 plugins.json 的条目树：产物表里消失，卡片上还在（带 enabled=false）。
writePluginEnabled('dsh-cost-meter/client', false)
const afterOff = collectUiArtifactsForPlatform('web', { packageDir: profile, thirdPartyDir: third, force: true })
check('停用后不进启动图', !afterOff.entries.some((item) => item.id === 'dsh-cost-meter'))
const offRow = scanPackageUiTrusts(afterOff.apiVersion, new Set(), profile).find((item) => item.name === 'dsh-cost-meter')
check('停用后卡片上还在，且 enabled=false', offRow !== undefined && offRow.enabled === false)
writePluginEnabled('dsh-cost-meter/client', true)
const afterOn = collectUiArtifactsForPlatform('web', { packageDir: profile, thirdPartyDir: third, force: true })
check('再打开又回到启动图', afterOn.entries.some((item) => item.id === 'dsh-cost-meter'))

console.log(String.fromCharCode(10) + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
