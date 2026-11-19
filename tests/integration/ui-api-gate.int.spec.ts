/**
 * `@dsc/ui` 契约版本门禁（宿主侧 semver 判定）（迁自 `scripts/ui-api-gate-test.mjs`）。
 *
 * ## 被测的是什么
 *
 * - **真内置清单**：构建产物自带 apiVersion，与壳包版本相等（钉「相等」这个不变量，
 *   不钉具体值）；全部插件放行（零 problem、至少一条）；条目逐条带 api（来自各自
 *   package.json 的 peer 区间）。壳没构建时整段 skip（探针同款）。
 * - **门禁函数逐条规则**（`evaluateUiApiGate`）：区间满足放行（含 1.x 通配）、主版本高拒
 *   且说清两版、低下限拒、`workspace:` 前缀拒并要求写具体区间、非法区间拒、内置条目无
 *   声明 + 清单带 apiVersion 放行（与壳同源）、双方都无版本依据拒（失败关闭）。
 * - **端到端**：临时清单里混一个 api 不满足的条目，collect 时被剔除、原因进 problems
 *   且是人话；清单读取层不拦（判定在门禁层）。
 *
 * ## 落位与隔离
 *
 * 门禁函数是纯函数；端到端段用临时目录，产物字节借真产物（`lib/ui/plugins/composer/
 * client.js`，门禁不看内容只看文件在不在）——壳没构建时端到端段 skip。
 *
 * @module dsc/tests/integration/ui-api-gate
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { collectUiPluginArtifacts, evaluateUiApiGate, readUiPluginManifestReport } from '@pneuma/runtime/core/ui-bundles.js'

/** 仓库根（本文件在 tests/integration/ 下）。 */
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
/**
 * 界面壳产物目录（显式拼，不用 `uiPluginsDir()` 的缺省值）：那个缺省值按模块自身位置解析，
 * spec 从 src 导入时算出的是 `src/ui/plugins`（永远没有产物）。
 */
const UI_PLUGINS = join(REPO_ROOT, 'lib', 'ui', 'plugins')
/** 界面壳有没有构建（产物段共用的门，探针同款 SKIP）。 */
const SHELL_BUILT = existsSync(join(UI_PLUGINS, 'manifest.json'))

/** 端到端段的夹具目录。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-ui-api-gate-'))

afterAll(() => {
  try {
    rmSync(WORK, { recursive: true, force: true })
  } catch {
    // 删不掉不影响结论：临时目录会被系统清。
  }
})

// ── 真内置清单：构建产物自带 apiVersion，全部插件放行 ──────────────────────────
describe.skipIf(!SHELL_BUILT)('真内置清单（构建产物）', () => {
  const builtin = collectUiPluginArtifacts(UI_PLUGINS)
  // apiVersion 与壳包版本必须一起走（build-plugins.mjs 从 ui-shell/package.json 读）：
  // 钉「相等」这个不变量，而不是钉某个具体值——版本纪律是次版本随导出增量走。
  const shellVersion = (JSON.parse(readFileSync(join(REPO_ROOT, 'ui-shell', 'package.json'), 'utf8')) as { version: string }).version

  test('内置清单带 apiVersion 且与壳包版本一致', () => {
    expect(builtin.apiVersion === shellVersion, `${String(builtin.apiVersion)} ≠ ${shellVersion}`).toBe(true)
  })

  test('内置清单的全部插件都进了产物表（零 problem；数量不钉死）', () => {
    expect(
      builtin.problems.length === 0 && builtin.entries.length > 0,
      `entries=${String(builtin.entries.length)} problems=${JSON.stringify(builtin.problems)}`,
    ).toBe(true)
  })

  test('内置清单的条目逐条带 api（package.json 的 @dsc/ui 区间）', () => {
    const missing = builtin.entries.filter((entry) => typeof entry.api !== 'string' || entry.api === '')
    expect(missing.map((entry) => [entry.id, entry.api]), JSON.stringify(missing)).toEqual([])
  })
})

// ── 门禁函数逐条规则 ───────────────────────────────────────────────────────────
describe('门禁函数 evaluateUiApiGate 逐条规则', () => {
  test('区间满足 → 放行', () => {
    expect(evaluateUiApiGate('^1.0.0', '1.0.0')).toBeNull()
  })
  test('区间满足（1.x 通配）→ 放行', () => {
    expect(evaluateUiApiGate('1.x', '1.2.0')).toBeNull()
  })
  test('区间不满足（主版本高）→ 拒并说明两版', () => {
    const reason = evaluateUiApiGate('^2.0.0', '1.0.0')
    expect(reason !== null && reason.includes('已跳过加载') && reason.includes('^2.0.0') && reason.includes('1.0.0'), reason ?? '').toBe(true)
  })
  test('区间不满足（更低下限）→ 拒', () => {
    expect(evaluateUiApiGate('^0.9.0', '1.0.0')).not.toBeNull()
  })
  test('workspace: 前缀 → 拒并要求写具体区间', () => {
    const reason = evaluateUiApiGate('workspace:^', '1.0.0')
    expect(reason !== null && reason.includes('具体'), reason ?? '').toBe(true)
  })
  test('非法区间 → 拒', () => {
    expect(evaluateUiApiGate('最新版', '1.0.0')).not.toBeNull()
  })
  test('内置条目无声明 + 清单带 apiVersion → 放行（与壳同源）', () => {
    expect(evaluateUiApiGate(undefined, '1.0.0')).toBeNull()
  })
  test('双方都无版本依据 → 拒（失败关闭：手写清单不能绕过门禁）', () => {
    const reason = evaluateUiApiGate(undefined, undefined)
    expect(reason !== null && reason.includes('apiVersion') && reason.includes('已跳过'), reason ?? '').toBe(true)
  })
})

// ── 端到端：临时清单里混一个 api 不满足的条目，collect 时被剔除 ──────────────────
describe.skipIf(!SHELL_BUILT)('端到端：api 不满足的条目被 collect 剔除', () => {
  const dir = join(WORK, 'plugins')

  beforeAll(() => {
    mkdirSync(join(dir, 'good'), { recursive: true })
    mkdirSync(join(dir, 'greedy'), { recursive: true })
    // bundle 随便拿个真的（门禁不看内容，只看文件在不在）
    cpSync(join(UI_PLUGINS, 'composer', 'client.js'), join(dir, 'good', 'client.js'))
    cpSync(join(UI_PLUGINS, 'composer', 'client.js'), join(dir, 'greedy', 'client.js'))
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        apiVersion: '1.0.0',
        plugins: [
          { id: 'good', file: 'client.js', platform: 'web', api: '^1.0.0' },
          { id: 'greedy', file: 'client.js', platform: 'web', api: '^9.0.0' },
        ],
      }),
      'utf8',
    )
  })

  test('清单读取层不拦（判定在门禁层）', () => {
    const report = readUiPluginManifestReport(dir)
    expect(
      report.entries.length === 2 && report.apiVersion === '1.0.0',
      JSON.stringify(report.entries.map((entry) => entry.id)),
    ).toBe(true)
  })

  test('满足区间的条目进了产物表；api 不满足的被剔除且原因进 problems', () => {
    const artifacts = collectUiPluginArtifacts(dir)
    expect(artifacts.entries.some((entry) => entry.id === 'good'), JSON.stringify(artifacts.entries.map((entry) => entry.id))).toBe(true)
    expect(artifacts.entries.some((entry) => entry.id === 'greedy')).toBe(false)
    expect(
      artifacts.problems.some((line) => line.includes('greedy') && line.includes('@dsc/ui') && line.includes('已跳过加载')),
      JSON.stringify(artifacts.problems),
    ).toBe(true)
  })
})
