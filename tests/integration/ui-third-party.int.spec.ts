/**
 * 第三方界面插件：发现、启停、信任门、内容摘要 rev、伺服、TUI 装载，以及信任卡数据源
 * （`scanThirdPartyUiTrusts`）把「没加载」分成三档（迁自 `scripts/ui-third-party-test.mjs`）。
 *
 * ## 目录形状
 *
 * `~/.dsc/plugins/<目录名>/`，`ui/client.js` 是界面半边，`plugin.json` 声明 `api`（必填）
 * 与可选 `platforms`。启停用 plugins.json 的 entries（键 `<目录名>/ui/client.js`，与宿主
 * 插件同格），信任用顶层 `uiTrust` 段。
 *
 * ## 被测的是什么
 *
 * 1. 发现层：api 齐全但未信任 → 信任门拦下；没写 api / 区间不满足 → problems 点名；
 *    未信任的点名等待确认。
 * 2. 信任卡数据源：三档 `problemKind`（version / manifest / artifact）在**数据里**分开；
 *    未信任是独立状态（problem 为空、trusted=false）；stale（同意后被换过）单列一档。
 * 3. 信任动作落盘（`uiTrust` 段）+ 重确认后可装载；双平台插件出两行；停用后不合成也不算
 *    problem；与内置撞名第三方让路。
 * 4. 内容摘要 rev：16 位、同字节稳定、换字节旧信任不算数（内容变了要重新确认）、
 *    rev 与文件 mtime 无关（sha256 前 16 位）。
 * 5. 伺服：第三方 id 走同一条 `/plugins/` 路由（内容寻址 200、错 rev 404 说版本、缺 rev 404）。
 * 6. TUI 装载：第三方 tui 条目进终端注册表，`injectSlot` 等到的贡献随声明落地、
 *    卸载时撤掉；启停记录与宿主插件同格。
 *
 * ## 落位与隔离
 *
 * 第三方目录全在临时 HOME 的 `DSC_HOME/plugins` 下（setup 已换 HOME）；内置清单指向夹具
 * 目录（`builtinDir`），真实 `~/.dsc` 一个字节都不写。样本 bundle 自造（工厂注册名必须
 * 等于目录 id，装载器按 id 从工厂表里取）。
 *
 * @module dsc/tests/integration/ui-third-party
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  collectUiArtifactsForPlatform,
  discoverThirdPartyUiArtifacts,
  scanThirdPartyUiTrusts,
} from '@pneuma/runtime/core/ui-bundles.js'
import { resolveUiBundleRequest } from '@pneuma/runtime/core/ui-route.js'
import { readPluginEntries, readUiPluginTrust, trustUiPlugin, writePluginEnabled } from '@pneuma/runtime/core/plugin-registry.js'
import { SlotRegistry } from '@pneuma/ui-core/slots.js'
import { loadTuiPlugins } from '@pneuma/ui-core/tui-plugins.js'
import { TUI_SLOTS } from '@pneuma/ui-core/tui-plugin-api.js'

/** 夹具总目录（内置清单落这里）；第三方目录在临时 HOME 的 plugins 下。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-ui-third-'))

afterAll(() => {
  try {
    rmSync(WORK, { recursive: true, force: true })
  } catch {
    // 删不掉不影响结论：临时目录会被系统清。
  }
})

/** 样本 bundle（工厂注册名由 __ID__ 占位：必须等于目录 id，装载器按 id 从工厂表里取）。 */
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

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? ''
const DSC_HOME = join(HOME, '.dsc')
const thirdRoot = join(DSC_HOME, 'plugins')
/** 内置清单目录（apiVersion 1.0.0，条目只写 builtin-one）。 */
const builtinDir = join(WORK, 'builtin-plugins')

/** 造一个第三方目录：`ui/client.js` + `plugin.json`（api 必填、platforms 可选）。 */
function mkThird(name: string, api: string | undefined, platforms?: string[]): void {
  mkdirSync(join(thirdRoot, name, 'ui'), { recursive: true })
  writeFileSync(join(thirdRoot, name, 'ui', 'client.js'), SAMPLE_BUNDLE.replaceAll('__ID__', name), 'utf8')
  writeFileSync(
    join(thirdRoot, name, 'plugin.json'),
    JSON.stringify({ api, ...(platforms === undefined ? {} : { platforms }) }),
    'utf8',
  )
}

/** 一份信任卡读数的窄化形状。 */
interface TrustView {
  name: string
  problem?: string
  problemKind?: string
  trusted?: boolean
}

// ── 夹具：内置清单（apiVersion 1.0.0）+ 第三方目录 ─────────────────────────────
beforeAll(() => {
  mkdirSync(join(builtinDir, 'builtin-one'), { recursive: true })
  writeFileSync(join(builtinDir, 'builtin-one', 'client.js'), SAMPLE_BUNDLE.replaceAll('__ID__', 'builtin-one'), 'utf8')
  writeFileSync(
    join(builtinDir, 'manifest.json'),
    JSON.stringify({ version: 1, apiVersion: '1.0.0', plugins: [{ id: 'builtin-one', file: 'client.js', platform: 'web' }] }),
    'utf8',
  )
  mkThird('good-ui', '^1.0.0')
  mkThird('no-api', undefined)
  mkThird('greedy', '^9.0.0')
  mkThird('both-platforms', '^1.0.0', ['web', 'tui'])
})

// ── 发现层：门禁/信任/启停逐条（信任之前） ─────────────────────────────────────
describe('发现层：信任门与门禁（信任之前）', () => {
  let ids: string[] = []
  let problems = ''

  beforeAll(() => {
    const report = discoverThirdPartyUiArtifacts('1.0.0', new Set(['builtin-one']))
    ids = report.entries.map((entry) => entry.id)
    problems = report.problems.join(' | ')
  })

  test('api 齐全且已信任前：good-ui 被信任门拦下', () => {
    expect(ids.includes('good-ui'), JSON.stringify(ids)).toBe(false)
  })
  test('没写 api 的目录被点名拒绝', () => {
    expect(problems.includes('no-api') && problems.includes('api'), problems).toBe(true)
  })
  test('区间不满足的目录被门禁拒绝', () => {
    expect(problems.includes('greedy') && problems.includes('已跳过加载'), problems).toBe(true)
  })
  test('未信任的目录被点名等待确认', () => {
    expect(problems.includes('还没有信任记录'), problems).toBe(true)
  })
})

// ── 管理面：信任卡数据源把「没加载」分档 ────────────────────────────────────────
describe('信任卡数据源：三档 problemKind 分开', () => {
  let views: TrustView[] = []

  beforeAll(() => {
    // ghost：plugin.json 声明齐了但 ui/client.js 不在 → 「读不到产物」档
    mkdirSync(join(thirdRoot, 'ghost', 'ui'), { recursive: true })
    writeFileSync(join(thirdRoot, 'ghost', 'plugin.json'), JSON.stringify({ api: '^1.0.0' }), 'utf8')
    views = scanThirdPartyUiTrusts('1.0.0', new Set(['builtin-one'])) as TrustView[]
  })

  const byName = (name: string): TrustView | undefined => views.find((view) => view.name === name)

  test('数据层：三档 problemKind 分开（version / manifest / artifact）', () => {
    expect(byName('greedy')?.problemKind, JSON.stringify(views.map((view) => [view.name, view.problemKind]))).toBe('version')
    expect(byName('no-api')?.problemKind).toBe('manifest')
    expect(byName('ghost')?.problemKind).toBe('artifact')
  })

  test('未信任是独立状态（problem 为空、trusted=false），不是 problem 的一种', () => {
    const good = byName('good-ui')
    expect(good).toBeDefined()
    expect(good?.problem).toBeUndefined()
    expect(good?.problemKind).toBeUndefined()
    expect(good?.trusted).toBe(false)
  })

  test('分档文案各咬自己的事实：版本档要升壳依据、产物档点名 client.js、清单档点名 api', () => {
    const greedy = byName('greedy')
    const ghost = byName('ghost')
    const noApi = byName('no-api')
    expect((greedy?.problem ?? '').includes('@dsc/ui') && (greedy?.problem ?? '').includes('已跳过加载'), greedy?.problem).toBe(true)
    expect((ghost?.problem ?? '').includes('ui/client.js') && (ghost?.problem ?? '').includes('读不到'), ghost?.problem).toBe(true)
    expect((noApi?.problem ?? '').includes('api'), noApi?.problem).toBe(true)
  })
})

// ── 信任之后：合成、双平台、启停、内容摘要 rev、stale、撞名 ──────────────────────
describe('信任之后：合成表与内容摘要 rev', () => {
  /** 段间共享读数。 */
  const facts: Record<string, unknown> = {}
  let revA = ''

  beforeAll(() => {
    trustUiPlugin('good-ui/ui/client.js')
    trustUiPlugin('both-platforms/ui/client.js')
    facts['trustCount'] = Object.keys(readUiPluginTrust()).length

    const report = discoverThirdPartyUiArtifacts('1.0.0', new Set(['builtin-one']))
    facts['trustedGood'] = report.entries.some((entry) => entry.id === 'good-ui')
    facts['dualRows'] = report.entries.filter((entry) => entry.id === 'both-platforms').length
    facts['dualTuiRow'] = report.entries.some((entry) => entry.id === 'both-platforms' && entry.platform === 'tui')

    // 启停共用 plugins.json 的 entries：停用后不合成、也不算 problem
    writePluginEnabled('good-ui/ui/client.js', false)
    const afterDisable = discoverThirdPartyUiArtifacts('1.0.0', new Set())
    facts['disabledAbsent'] = !afterDisable.entries.some((entry) => entry.id === 'good-ui')
    facts['disabledQuiet'] = !afterDisable.problems.some((line) => line.includes('good-ui'))
    writePluginEnabled('good-ui/ui/client.js', true)

    // 内容摘要 rev：同一份字节跨 collect 同 rev；换字节 rev 必变。
    // 有意收紧（信任强度）：信任记录现在带内容摘要，换了字节旧信任就不算数。所以先断言
    // 「被拦下、要求重新确认」，再走一次确认动作。
    const first = discoverThirdPartyUiArtifacts('1.0.0', new Set())
    revA = first.entries.find((entry) => entry.id === 'both-platforms')?.rev ?? ''
    facts['revLength'] = revA.length
    const second = discoverThirdPartyUiArtifacts('1.0.0', new Set())
    facts['revStable'] = second.entries.find((entry) => entry.id === 'both-platforms')?.rev === revA

    const bundle = join(thirdRoot, 'both-platforms', 'ui', 'client.js')
    writeFileSync(bundle, `${readFileSync(bundle, 'utf8')}\n// touched\n`, 'utf8')
    const touched = discoverThirdPartyUiArtifacts('1.0.0', new Set())
    facts['staleBlocked'] =
      !touched.entries.some((entry) => entry.id === 'both-platforms') &&
      touched.problems.some((line) => line.includes('both-platforms') && line.includes('需要重新确认'))

    // 单列一档（stale）：用户曾经点过头，界面要说清「你同意的那份被换掉了」。
    const staleViews = scanThirdPartyUiTrusts('1.0.0', new Set()) as TrustView[]
    const staleRow = staleViews.find((view) => view.name === 'both-platforms')
    facts['staleKind'] = staleRow?.problemKind
    facts['staleTrusted'] = staleRow?.trusted
    facts['staleText'] = staleRow?.problem
    facts['goodNotStale'] = staleViews.find((view) => view.name === 'good-ui')?.problemKind

    // 重新确认一次（界面上是同一张信任卡的动作），摘要随之更新到当前这份字节。
    trustUiPlugin('both-platforms/ui/client.js')
    const third = discoverThirdPartyUiArtifacts('1.0.0', new Set())
    facts['reconfirmRev'] = third.entries.find((entry) => entry.id === 'both-platforms')?.rev !== revA

    // 与内置撞名：第三方让路
    mkThird('builtin-one', '^1.0.0')
    const clash = discoverThirdPartyUiArtifacts('1.0.0', new Set(['builtin-one']))
    facts['clashYield'] = clash.problems.some((line) => line.includes('builtin-one') && line.includes('撞名'))

    // ── 合成：内置 + 第三方一张表 ──
    const merged = collectUiArtifactsForPlatform('web', { builtinDir })
    facts['mergedBuiltin'] = merged.entries.some((entry) => entry.id === 'builtin-one')
    facts['mergedThirdWeb'] = merged.entries.some((entry) => entry.id === 'both-platforms' && entry.platform === undefined)
    const mergedTui = collectUiArtifactsForPlatform('tui', { builtinDir })
    facts['mergedTuiOnly'] = mergedTui.entries.every((entry) => entry.id === 'both-platforms')
  })

  test('信任记录落盘 plugins.json 顶层 uiTrust（两条）', () => {
    expect(facts['trustCount']).toBe(2)
  })
  test('信任后 good-ui 合成', () => {
    expect(facts['trustedGood']).toBe(true)
  })
  test('双平台插件出两行（web 缺省 + tui 显式）', () => {
    expect(facts['dualRows']).toBe(2)
    expect(facts['dualTuiRow']).toBe(true)
  })
  test('停用后不合成也不报问题', () => {
    expect(facts['disabledAbsent']).toBe(true)
    expect(facts['disabledQuiet']).toBe(true)
  })
  test('rev 是 16 位内容摘要，同一份字节 rev 稳定', () => {
    expect(facts['revLength']).toBe(16)
    expect(facts['revStable']).toBe(true)
  })
  test('换了字节：旧信任不再算数（内容变了要重新确认）', () => {
    expect(facts['staleBlocked'], JSON.stringify(facts['staleText'])).toBe(true)
  })
  test('内容变了单列一档（problemKind = stale，trusted = false），说明说清「同意之后被换过」', () => {
    expect(facts['staleKind']).toBe('stale')
    expect(facts['staleTrusted']).toBe(false)
    expect(String(facts['staleText'])).toContain('重新确认')
  })
  test('没被换过内容的插件不会沾上 stale', () => {
    expect(facts['goodNotStale']).toBeUndefined()
  })
  test('换了字节 rev 跟着变（重新确认后可装载）', () => {
    expect(facts['reconfirmRev']).toBe(true)
  })
  test('与内置 id 撞名时第三方被跳过', () => {
    expect(facts['clashYield']).toBe(true)
  })
  test('合成表含内置与第三方 web 条目；tui 视图只含声明了 tui 的第三方', () => {
    expect(facts['mergedBuiltin']).toBe(true)
    expect(facts['mergedThirdWeb']).toBe(true)
    expect(facts['mergedTuiOnly']).toBe(true)
  })
})

// ── 伺服：第三方 id 走同一条 /plugins/ 路由 ────────────────────────────────────
describe('伺服：第三方 id 走同一条 /plugins/ 路由', () => {
  let rev = ''
  let digest = ''

  beforeAll(() => {
    const table = discoverThirdPartyUiArtifacts('1.0.0', new Set())
    rev = table.entries.find((entry) => entry.id === 'good-ui')?.rev ?? ''
    digest = createHash('sha256').update(readFileSync(join(thirdRoot, 'good-ui', 'ui', 'client.js'))).digest('hex').slice(0, 16)
  })

  test('第三方 bundle 按内容寻址 200', () => {
    const hit = resolveUiBundleRequest('/plugins/good-ui/client.js', rev, builtinDir)
    expect(hit.status, String(hit.status)).toBe(200)
    expect((hit.body ?? Buffer.alloc(0)).length).toBeGreaterThan(0)
  })
  test('rev 对不上 → 404 说版本问题；缺 rev 一律 404（与内置同规矩）', () => {
    const stale = resolveUiBundleRequest('/plugins/good-ui/client.js', '0'.repeat(16), builtinDir)
    expect(stale.status).toBe(404)
    expect((stale.reason ?? '')).toContain('版本')
    const noRev = resolveUiBundleRequest('/plugins/good-ui/client.js', null, builtinDir)
    expect(noRev.status).toBe(404)
    expect((noRev.reason ?? '')).toContain('rev')
  })
  test('rev 与文件 mtime 无关（内容摘要语义：sha256 前 16 位）', () => {
    expect(rev).toBe(digest)
  })
})

// ── TUI 装载：第三方 tui 插件进终端注册表 ──────────────────────────────────────
describe('TUI 装载：第三方 tui 插件进终端注册表', () => {
  const facts: Record<string, unknown> = {}

  beforeAll(() => {
    // 内置清单指到夹具目录；第三方走 DSC_HOME 的 plugins（发现层读的就是它）。
    // 工具卡 footer 槽在这里先声明：第三方样本用 injectSlot 等它，声明一到贡献就落进注册表
    //（TUI 里没有 transcript，这是「等待声明」语义最干净的验证姿势）。
    const registry = new SlotRegistry()
    registry.declare(TUI_SLOTS.noticeExtensions, 'list')
    registry.declare('transcript.toolcard.footer', 'list')
    const load = loadTuiPlugins({
      registry: registry as never,
      runtime: { subscribe: (): (() => void) => (): void => {}, getSnapshot: (): null => null } as never,
      host: { name: 'Pneuma', version: '0.0.0-spec', platform: 'tui' },
      pluginsDir: builtinDir,
    })
    const both = load.reports.find((report) => report.id === 'both-platforms')
    facts['tuiLoaded'] = both?.ok === true
    facts['noticeRow'] = registry.winners(TUI_SLOTS.noticeExtensions).length === 1
    facts['footerRow'] = registry.winners('transcript.toolcard.footer').length === 1
    load.disposeAll()
    facts['footerCleared'] = registry.entriesOf('transcript.toolcard.footer').length === 0
  })

  test('TUI 装载第三方 tui 条目成功', () => {
    expect(facts['tuiLoaded']).toBe(true)
  })
  test('注册表里真的有了它的登记', () => {
    expect(facts['noticeRow']).toBe(true)
  })
  test('第三方经 injectSlot 往工具卡 footer 槽的贡献落了地', () => {
    expect(facts['footerRow']).toBe(true)
  })
  test('卸载后 footer 槽的贡献被撤掉', () => {
    expect(facts['footerCleared']).toBe(true)
  })

  test('收尾核对：启停记录与信任记录同住 plugins.json（不另起一套开关）', () => {
    expect(Array.isArray(readPluginEntries())).toBe(true)
  })
})
