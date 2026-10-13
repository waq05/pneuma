/**
 * 阶段 7c 探针：第三方界面插件——发现、启停、信任门、内容摘要 rev、伺服、TUI 装载。
 *
 * 目录形状：`~/.dsc/plugins/<目录名>/`，`ui/client.js` 是界面半边，`plugin.json`
 * 声明 `api`（必填）与可选 `platforms`。启停用 plugins.json 的 entries（键
 * `<目录名>/ui/client.js`，与宿主插件同格），信任用顶层 `uiTrust` 段。
 *
 * 运行：pnpm build && node scripts/ui-third-party-test.mjs
 *
 * @module dsc/scripts/ui-third-party-test
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离必须在 import 之前：plugins.json / 插件目录的路径在模块加载时定型。
const home = mkdtempSync(join(tmpdir(), 'dsc-ui-third-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')

const { discoverThirdPartyUiArtifacts, collectUiArtifactsForPlatform } =
  await import('../lib/core/ui-bundles.js')
const { resolveUiBundleRequest } = await import('../lib/core/ui-route.js')
const { trustUiPlugin, readPluginEntries, writePluginEnabled, readUiPluginTrust } = await import(
  '../lib/core/plugin-registry.js'
)
const { SlotRegistry } = await import('../lib/ui/slots.js')
const { loadTuiPlugins } = await import('../lib/ui/tui-plugins.js')
const { TUI_SLOTS } = await import('../lib/ui/tui-plugin-api.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// ── 夹具：内置清单（apiVersion 1.0.0）+ 第三方目录 ─────────────────────────────
// 样本 bundle 自造（演示插件已按拍板移除，不再借内置产物）：工厂注册名必须等于目录 id
// （打包约定），装载器按 id 从工厂表里取——拿别人的 bundle 原样放进自己的目录，
// 装载器会报「没有注册工厂」。
const SAMPLE_BUNDLE = [
  `(globalThis.__DSC_UI_FACTORIES__ ??= {})['__ID__'] = function (require, module, exports) {`,
  `  const React = require('react');`,
  `  const { defineUiPlugin, TUI_SLOTS, Text } = require('@dsc/ui');`,
  `  module.exports = defineUiPlugin({`,
  `    name: '第三方样本',`,
  `    apply(ui) {`,
  `      // D2 扩展点：工具卡尾巴的扩展行，用 injectSlot 等 transcript 的 Factory 声明它。`,
  `      ui.slots.injectSlot('transcript.toolcard.footer', () =>`,
  `        ui.slots.register('transcript.toolcard.footer', { id: 'sample.footer', order: 1 }, function () {`,
  `          return React.createElement(Text, null, '第三方给工具卡加的一行');`,
  `        }),`,
  `      );`,
  `      if (ui.host.platform === 'tui') {`,
  `        ui.slots.injectSlot(TUI_SLOTS.noticeExtensions, () =>`,
  `          ui.slots.register(TUI_SLOTS.noticeExtensions, { id: 'sample.line', order: 1 }, function () {`,
  `            return React.createElement(Text, null, '第三方样本已接入终端壳');`,
  `          }),`,
  `        );`,
  `      }`,
  `    },`,
  `  });`,
  `};`,
  ``,
].join('\n')
const builtinDir = join(home, 'builtin-plugins')
mkdirSync(join(builtinDir, 'builtin-one'), { recursive: true })
writeFileSync(join(builtinDir, 'builtin-one', 'client.js'), SAMPLE_BUNDLE.replaceAll('__ID__', 'builtin-one'), 'utf8')
writeFileSync(
  join(builtinDir, 'manifest.json'),
  JSON.stringify({ version: 1, apiVersion: '1.0.0', plugins: [{ id: 'builtin-one', file: 'client.js', platform: 'web' }] }),
  'utf8',
)

const thirdRoot = join(process.env.DSC_HOME, 'plugins')
const mkThird = (name, api, platforms) => {
  mkdirSync(join(thirdRoot, name, 'ui'), { recursive: true })
  writeFileSync(join(thirdRoot, name, 'ui', 'client.js'), SAMPLE_BUNDLE.replaceAll('__ID__', name), 'utf8')
  writeFileSync(join(thirdRoot, name, 'plugin.json'), JSON.stringify({ api, ...(platforms === undefined ? {} : { platforms }) }), 'utf8')
}
mkThird('good-ui', '^1.0.0')
mkThird('no-api', undefined)
mkThird('greedy', '^9.0.0')
mkThird('both-platforms', '^1.0.0', ['web', 'tui'])

// ── 发现层：门禁/信任/启停逐条 ─────────────────────────────────────────────────
{
  const report = discoverThirdPartyUiArtifacts('1.0.0', new Set(['builtin-one']))
  const ids = report.entries.map((entry) => entry.id)
  check('api 齐全且已信任前：good-ui 被信任门拦下', !ids.includes('good-ui'), JSON.stringify(ids))
  check('没写 api 的目录被点名拒绝', report.problems.some((line) => line.includes('no-api') && line.includes('api')))
  check('区间不满足的目录被门禁拒绝', report.problems.some((line) => line.includes('greedy') && line.includes('已跳过加载')))
  check('未信任的目录被点名等待确认', report.problems.some((line) => line.includes('还没有信任记录')))
}

// 信任 good-ui 与 both-platforms（信任确认动作的落点）
trustUiPlugin('good-ui/ui/client.js')
trustUiPlugin('both-platforms/ui/client.js')
check('信任记录落盘 plugins.json 顶层 uiTrust', Object.keys(readUiPluginTrust()).length === 2)

{
  const report = discoverThirdPartyUiArtifacts('1.0.0', new Set(['builtin-one']))
  const ids = report.entries.map((entry) => entry.id)
  check('信任后 good-ui 合成', ids.includes('good-ui'))
  check('双平台插件出两行（web 缺省 + tui 显式）', report.entries.filter((entry) => entry.id === 'both-platforms').length === 2 &&
    report.entries.some((entry) => entry.id === 'both-platforms' && entry.platform === 'tui'))

  // 启停共用 plugins.json 的 entries：停用后不合成、也不算 problem
  writePluginEnabled('good-ui/ui/client.js', false)
  const afterDisable = discoverThirdPartyUiArtifacts('1.0.0', new Set())
  check('停用后不合成也不报问题', !afterDisable.entries.some((entry) => entry.id === 'good-ui') &&
    !afterDisable.problems.some((line) => line.includes('good-ui')))
  writePluginEnabled('good-ui/ui/client.js', true)

  // 内容摘要 rev：同一份字节跨 collect 同 rev；换字节 rev 必变
  const first = discoverThirdPartyUiArtifacts('1.0.0', new Set())
  const revA = first.entries.find((entry) => entry.id === 'both-platforms')?.rev
  check('rev 是 16 位内容摘要', typeof revA === 'string' && revA.length === 16, String(revA))
  const second = discoverThirdPartyUiArtifacts('1.0.0', new Set())
  check('同一份字节 rev 稳定', second.entries.find((entry) => entry.id === 'both-platforms')?.rev === revA)
  const bundle = join(thirdRoot, 'both-platforms', 'ui', 'client.js')
  writeFileSync(bundle, readFileSync(bundle, 'utf8') + '\n// touched\n', 'utf8')
  const third = discoverThirdPartyUiArtifacts('1.0.0', new Set())
  check('换了字节 rev 跟着变', third.entries.find((entry) => entry.id === 'both-platforms')?.rev !== revA)

  // 与内置撞名：第三方让路
  mkThird('builtin-one', '^1.0.0')
  const clash = discoverThirdPartyUiArtifacts('1.0.0', new Set(['builtin-one']))
  check('与内置 id 撞名时第三方被跳过', clash.problems.some((line) => line.includes('builtin-one') && line.includes('撞名')))

  // ── 合成：内置 + 第三方一张表 ────────────────────────────────────────────────
  const merged = collectUiArtifactsForPlatform('web', { builtinDir })
  check('合成表含内置条目', merged.entries.some((entry) => entry.id === 'builtin-one'))
  check('合成表含第三方 web 条目', merged.entries.some((entry) => entry.id === 'both-platforms' && entry.platform === undefined))
  const mergedTui = collectUiArtifactsForPlatform('tui', { builtinDir })
  check('tui 视图只含声明了 tui 的第三方', mergedTui.entries.every((entry) => entry.id === 'both-platforms'))
}

// ── 伺服：第三方 id 走同一条 /plugins/ 路由 ────────────────────────────────────
{
  const table = discoverThirdPartyUiArtifacts('1.0.0', new Set())
  const good = table.entries.find((entry) => entry.id === 'good-ui')
  if (good === undefined) {
    check('伺服用例的 good-ui 在场', false, JSON.stringify(table))
  } else {
    const hit = resolveUiBundleRequest(`/plugins/good-ui/client.js`, good.rev, builtinDir)
    check('第三方 bundle 按内容寻址 200', hit.status === 200 && (hit.body ?? Buffer.alloc(0)).length > 0)
    const stale = resolveUiBundleRequest(`/plugins/good-ui/client.js`, '0'.repeat(16), builtinDir)
    check('rev 对不上 → 404 说版本问题', stale.status === 404 && (stale.reason ?? '').includes('版本'))
    const noRev = resolveUiBundleRequest(`/plugins/good-ui/client.js`, null, builtinDir)
    check('缺 rev 一律 404（与内置同规矩）', noRev.status === 404 && (noRev.reason ?? '').includes('rev'))
    // 内容寻址的关键证据：rev 就来自字节本身（sha256 前 16 位），不来自 mtime
    const { createHash } = await import('node:crypto')
    check(
      'rev 与文件 mtime 无关（内容摘要语义）',
      good.rev === createHash('sha256').update(readFileSync(join(thirdRoot, 'good-ui', 'ui', 'client.js'))).digest('hex').slice(0, 16),
    )
  }
}

// ── TUI 装载：第三方 tui 插件进终端注册表 ──────────────────────────────────────
{
  // 内置清单指到夹具目录；第三方走 DSC_HOME 的 plugins（发现层读的就是它）。
  // 工具卡 footer 槽在这里先声明：第三方样本用 injectSlot 等它，声明一到贡献就落进注册表
  // （TUI 里没有 transcript，这是「等待声明」语义最干净的验证姿势）。
  const registry = new SlotRegistry()
  registry.declare(TUI_SLOTS.noticeExtensions, 'list')
  registry.declare('transcript.toolcard.footer', 'list')
  const reports = []
  const load = loadTuiPlugins({
    registry,
    runtime: { subscribe: () => () => {}, getSnapshot: () => null },
    host: { name: 'Muse Code', version: '0.0.0-probe', platform: 'tui' },
    pluginsDir: builtinDir,
    onReport: (report) => reports.push(report),
  })
  const both = load.reports.find((report) => report.id === 'both-platforms')
  check('TUI 装载第三方 tui 条目成功', both?.ok === true, JSON.stringify(both))
  check('注册表里真的有了它的登记', registry.winners(TUI_SLOTS.noticeExtensions).length === 1)
  check('第三方经 injectSlot 往工具卡 footer 槽的贡献落了地', registry.winners('transcript.toolcard.footer').length === 1)
  load.disposeAll()
  check('卸载后 footer 槽的贡献被撤掉', registry.entriesOf('transcript.toolcard.footer').length === 0)
}

// 收尾核对：启停记录与信任记录同住 plugins.json（不另起一套开关）
{
  const entries = readPluginEntries()
  check('启停记录与宿主插件同格（entries 数组）', Array.isArray(entries))
}

if (failures > 0) {
  console.log(`\n${String(failures)} 条断言未过`)
  process.exit(1)
}
console.log('\n全部通过')
rmSync(home, { recursive: true, force: true })
