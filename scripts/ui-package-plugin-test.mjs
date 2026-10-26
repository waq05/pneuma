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

const { collectUiArtifactsForPlatform, lookupPackageUiBundle, readUiArtifactBytes } = await import('../lib/core/ui-bundles.js')
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

console.log('组合包界面半边：取字节与组图')
const bytes = entry === undefined ? null : readUiArtifactBytes(entry, { packageDir: profile })
check('按条目读出字节（入口由包的 exports 决定）', bytes !== null && bytes.toString('utf8') === bundle, String(bytes === null ? null : bytes.length))
const hit = lookupPackageUiBundle('dsh-cost-meter', 'client.js', String(entry && entry.rev), profile)
check('按 rev 查得到当前字节', hit.known && hit.current && hit.body !== null)
const graph = composeUiBootGraph({ name: 'Pneuma', version: 'test' }, toUiPluginRows(artifacts.entries))
const row = graph.entries.find((item) => item.id === 'dsh-cost-meter')
check('进得了启动图（壳按图装）', row !== undefined, JSON.stringify(graph.entries.map((e) => e.id)))
check('地址是内容寻址的 /plugins/<包名>/client.js?rev=', row !== undefined && row.url.includes('dsh-cost-meter/client.js?rev='), String(row && row.url))

console.log(String.fromCharCode(10) + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
