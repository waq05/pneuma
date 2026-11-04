/**
 * 界面单元的开关探针：停用一行 → 这个单元不进启动图；重新启用 → 它回来。
 *
 * 为什么要有这条：2.0 起每个界面单元都是一个包、一行（`ui-<id>`），插件中心里能单独
 * 停用。以前内置产物是「扫 lib/ui/plugins/ 目录拿到什么就装什么」，开关写了等于没写；
 * 现在 `UiArtifactCache.table()` 按 `isPluginEnabled('ui-<id>')` 过一遍。这条探针证明
 * 那一步真的接上了，而且**不用重启、不用 force**——同一个产物缓存实例，改完
 * plugins.json 再取一次表就该看到变化（闸在取表那一步，不在建表那一步）。
 *
 * 隔离：临时 HOME，不碰真实 ~/.dsc（与其它探针同一套做法）。
 *
 * 跑法：cd D:\dsc && pnpm run build && pnpm run build:ui && node scripts/ui-switch-check.mjs
 *
 * 命名故意不叫 `ui-*-test.mjs`：`check:ui` 按文件名自动发现，多一条会改变那道门禁的
 * 条数（54 → 55）。要把它并进门禁，改名成 `ui-switch-test.mjs` 即可，别的都不用动。
 *
 * @module dsc/scripts/ui-switch-check
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-ui-switch-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(join(home, '.dsc'), { recursive: true })

const pluginsJson = join(home, '.dsc', 'plugins.json')

/** 把一条开关落盘（与插件中心写的同一份文件、同一套字段）。 */
function writeSwitch(file, enabled) {
  writeFileSync(
    pluginsJson,
    JSON.stringify({ version: 1, entries: [{ file, disabled: !enabled, config: {} }] }, null, 2) + '\n',
    'utf8',
  )
}

/** 一次落多条开关（同一份文件、同一套字段，批量开合时用）。 */
function writeSwitches(files, enabled) {
  writeFileSync(
    pluginsJson,
    JSON.stringify(
      { version: 1, entries: files.map((file) => ({ file, disabled: !enabled, config: {} })) },
      null,
      2,
    ) + '\n',
    'utf8',
  )
}

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log('  PASS ' + name)
  } else {
    fail += 1
    console.log('  FAIL ' + name + (extra === '' ? '' : ' — ' + extra))
  }
}

// 动态 import：上面的 DSC_HOME 必须在宿主模块**加载时**就位（plugins.json 的路径是模块级常量）。
const { collectUiArtifactsForPlatform, toUiPluginRows } = await import('../lib/core/ui-bundles.js')
const { composeUiBootGraph } = await import('../lib/core/ui-manifest.js')

const host = { name: 'Pneuma', version: 'test' }
const inGraph = (graph, id) => graph.entries.some((entry) => entry.id === id)
const inTable = (artifacts, id) => artifacts.entries.some((entry) => entry.id === id)

console.log('这一行真的存在（基础包 + 包的产物 + 界面产物）')
{
  // 行来自 @pneuma/base 的 cordis.patch.yml（build-packages 把各包的行按 pneuma.order 合成一层），
  // 内核装的就是这一份。它缺了，后面的开关再对也无处可关。
  const YAML = (await import('yaml')).default
  const basePatch = YAML.parse(readFileSync(new URL('../lib/node_modules/@pneuma/base/cordis.patch.yml', import.meta.url), 'utf8'))
  const rows = (basePatch[0]?.insert ?? [])
  const row = rows.find((item) => item.id === 'ui-transcript')
  check('基础包里有 ui-transcript 这一行', row !== undefined, JSON.stringify(rows.slice(-3)))
  check('这一行的 name 指到 @pneuma/ui-transcript', row?.name === '@pneuma/ui-transcript', String(row?.name))
  const pkgFile = new URL('../lib/node_modules/@pneuma/ui-transcript/package.json', import.meta.url)
  const manifest = JSON.parse(readFileSync(pkgFile, 'utf8'))
  check('包的入口 exports["."] 指着 index.js', manifest.exports?.['.'] === './index.js', JSON.stringify(manifest.exports))
  check('包的 exports 里去掉了包内不存在的界面入口', manifest.exports?.['./client'] === undefined, JSON.stringify(manifest.exports))
  // 空 apply 也要能被 Loader 认成插件对象：dsh 形状（模块自身带 apply）是我们的第三种认法。
  const mod = await import(new URL('../lib/node_modules/@pneuma/ui-transcript/index.js', import.meta.url).href)
  check('模块导出 name = ui-transcript', mod.name === 'ui-transcript', String(mod.name))
  check('模块自身带 apply（dsh 形状，picked 走第三条）', typeof mod.apply === 'function')
  mod.apply()
  check('空 apply 调一下不炸', true)
  const artifactDir = new URL('../lib/ui/plugins/transcript/', import.meta.url)
  check('界面产物仍在 lib/ui/plugins/transcript/', existsSync(new URL('client.js', artifactDir)) && existsSync(new URL('bundle.json', artifactDir)))
}

console.log('出厂态（plugins.json 里没有这条开关）')
const initial = collectUiArtifactsForPlatform('web', { force: true })
const total = initial.entries.length
check('transcript 在产物表里', inTable(initial, 'transcript'))
check('没有被停用的单元', initial.disabled.length === 0, JSON.stringify(initial.disabled))
check('内置产物 21 个界面单元（19 个单元 + 布局 + 渲染器）', total === 21, String(total))
const initialGraph = composeUiBootGraph(host, toUiPluginRows(initial.entries), initial.disabled)
check('transcript 在启动图里', inGraph(initialGraph, 'transcript'))
check('启动图没有「被停用」段', initialGraph.disabled === undefined, JSON.stringify(initialGraph.disabled))

console.log('停用 ui-transcript')
writeSwitch('ui-transcript', false)
// 故意用**非 force** 的取法：证明开关不靠重建产物表才生效（缓存钥匙是 manifest.json，不是 plugins.json）。
const off = collectUiArtifactsForPlatform('web')
check('transcript 不在产物表里', !inTable(off, 'transcript'))
check('disabled 报得出「它被停用了」', off.disabled.includes('transcript'), JSON.stringify(off.disabled))
check('其余单元照旧（19 → 18）', off.entries.length === total - 1, String(off.entries.length))
const offGraph = composeUiBootGraph(host, toUiPluginRows(off.entries), off.disabled)
check('transcript 不在启动图里', !inGraph(offGraph, 'transcript'))
check('启动图把它记进 disabled', (offGraph.disabled ?? []).includes('transcript'), JSON.stringify(offGraph.disabled))
check('启动图剩 18 条', offGraph.entries.length === total - 1, String(offGraph.entries.length))
check('批里也没有它', offGraph.batches.every((batch) => !batch.entries.includes('transcript')))
check('别的单元没被牵连（composer 仍在）', inGraph(offGraph, 'composer'))

console.log('键是 ui-<id>，不是 <id>')
// 停用**宿主功能包** transcript 不该拿走界面单元：两行的身份不同，各管各的。
writeSwitch('transcript', false)
const hostOff = collectUiArtifactsForPlatform('web')
check('停用宿主行 transcript 不影响界面单元', inTable(hostOff, 'transcript') && hostOff.disabled.length === 0)

console.log('重新启用 ui-transcript')
writeSwitch('ui-transcript', true)
const on = collectUiArtifactsForPlatform('web')
check('transcript 回到产物表', inTable(on, 'transcript'))
check('disabled 又空了', on.disabled.length === 0, JSON.stringify(on.disabled))
check('单元数回来了（18 → 19）', on.entries.length === total, String(on.entries.length))
const onGraph = composeUiBootGraph(host, toUiPluginRows(on.entries), on.disabled)
check('transcript 回到启动图', inGraph(onGraph, 'transcript'))
check('整图 rev 与出厂态一致（内容没变）', onGraph.rev === initialGraph.rev, onGraph.rev + ' ≠ ' + initialGraph.rev)

console.log('21 个单元逐个停用/启用')
{
  const ids = initial.entries.map((entry) => entry.id).sort()
  check('出厂态 21 个单元（逐个开关的前提）', ids.length === 21, String(ids.length))
  const missed = []
  const collateral = []
  for (const id of ids) {
    writeSwitch('ui-' + id, false)
    const off = collectUiArtifactsForPlatform('web')
    if (inTable(off, id) || !off.disabled.includes(id)) missed.push(id)
    if (off.entries.length !== 20) collateral.push(id + ':' + String(off.entries.length))
  }
  check('每一个 ui-<id> 都能单独停掉（键写错就会漏）', missed.length === 0, missed.join(','))
  check('停一个只少一个（没有牵连别的单元）', collateral.length === 0, collateral.join(';'))
  writeSwitches(ids.map((id) => 'ui-' + id), false)
  const allOff = collectUiArtifactsForPlatform('web')
  check('21 个全停：产物表为空', allOff.entries.length === 0, String(allOff.entries.length))
  check('20 个全停：disabled 报满 20 个', allOff.disabled.length === ids.length, String(allOff.disabled.length))
  writeSwitches(ids.map((id) => 'ui-' + id), true)
  const allOn = collectUiArtifactsForPlatform('web')
  check('21 个全开：都回到产物表', allOn.entries.length === ids.length, String(allOn.entries.length))
  const allOnGraph = composeUiBootGraph(host, toUiPluginRows(allOn.entries), allOn.disabled)
  check(
    '全开后整图 rev 与出厂态一致（内容没变）',
    allOnGraph.rev === initialGraph.rev,
    allOnGraph.rev + ' ≠ ' + initialGraph.rev,
  )
}

console.log(String.fromCharCode(10) + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
