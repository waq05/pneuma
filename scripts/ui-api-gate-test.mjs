/**
 * 阶段 7a/7b 探针：`@dsc/ui` 契约版本门禁（宿主侧 semver 判定）。
 *
 * 验收口径：apiVersion 不匹配的插件**不进产物表**（自然不进启动图），problems 里
 * 有「插件要求 @dsc/ui …，当前壳 …，已跳过加载」这样的人话；内置清单（构建产物）
 * 条目与壳同源、无声明也放行；workspace:/非法区间直接拒并要求写具体区间。
 *
 * 运行：pnpm build && pnpm -C ui-shell build && node scripts/ui-api-gate-test.mjs
 *
 * @module dsc/scripts/ui-api-gate-test
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { collectUiPluginArtifacts, evaluateUiApiGate, readUiPluginManifestReport } = await import(
  '../lib/core/ui-bundles.js'
)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// ── 真内置清单：构建产物自带 apiVersion，全部插件放行 ──────────────────────────
const builtin = collectUiPluginArtifacts()
// apiVersion 与壳包版本必须一起走（build-plugins.mjs 从 ui-shell/package.json 读）：
// 钉「相等」这个不变量，而不是钉某个具体值——版本纪律是次版本随导出增量走。
const shellVersion = JSON.parse(readFileSync(new URL('../ui-shell/package.json', import.meta.url), 'utf8')).version
check('内置清单带 apiVersion 且与壳包版本一致', builtin.apiVersion === shellVersion, `${String(builtin.apiVersion)} ≠ ${shellVersion}`)
// 数量不钉死（演示插件已按拍板移除，内置清单会变）：零 problem、至少有一个即可。
check('内置清单的全部插件都进了产物表', builtin.problems.length === 0 && builtin.entries.length > 0, `entries=${String(builtin.entries.length)} problems=${JSON.stringify(builtin.problems)}`)
check('内置清单的条目不带 api 声明（与壳同源）', builtin.entries.every((entry) => entry.api === undefined))

// ── 门禁函数逐条规则 ───────────────────────────────────────────────────────────
check('区间满足 → 放行', evaluateUiApiGate('^1.0.0', '1.0.0') === null)
check('区间满足（1.x 通配）→ 放行', evaluateUiApiGate('1.x', '1.2.0') === null)
check('区间不满足（主版本高）→ 拒并说明', (() => {
  const reason = evaluateUiApiGate('^2.0.0', '1.0.0')
  return reason !== null && reason.includes('已跳过加载') && reason.includes('^2.0.0') && reason.includes('1.0.0')
})(), evaluateUiApiGate('^2.0.0', '1.0.0') ?? '')
check('区间不满足（更低下限）→ 拒', evaluateUiApiGate('^0.9.0', '1.0.0') !== null)
check('workspace: 前缀 → 拒并要求写具体区间', (() => {
  const reason = evaluateUiApiGate('workspace:^', '1.0.0')
  return reason !== null && reason.includes('具体')
})())
check('非法区间 → 拒', evaluateUiApiGate('最新版', '1.0.0') !== null)
check('内置条目无声明 + 清单带 apiVersion → 放行（与壳同源）', evaluateUiApiGate(undefined, '1.0.0') === null)
check('双方都无版本依据 → 放行（兼容旧构建产物）', evaluateUiApiGate(undefined, undefined) === null)

// ── 端到端：临时清单里混一个 api 不满足的条目，collect 时被剔除 ────────────────
const work = mkdtempSync(join(tmpdir(), 'dsc-ui-api-gate-'))
try {
  const dir = join(work, 'plugins')
  mkdirSync(join(dir, 'good'), { recursive: true })
  mkdirSync(join(dir, 'greedy'), { recursive: true })
  // bundle 随便拿个真的（门禁不看内容，只看文件在不在）
  cpSync('lib/ui/plugins/composer/client.js', join(dir, 'good', 'client.js'))
  cpSync('lib/ui/plugins/composer/client.js', join(dir, 'greedy', 'client.js'))
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
  const report = readUiPluginManifestReport(dir)
  check('清单读取层不拦（判定在门禁层）', report.entries.length === 2 && report.apiVersion === '1.0.0')
  const artifacts = collectUiPluginArtifacts(dir)
  check('满足区间的条目进了产物表', artifacts.entries.some((entry) => entry.id === 'good'))
  check('api 不满足的条目被剔除', !artifacts.entries.some((entry) => entry.id === 'greedy'))
  check('剔除的原因进了 problems 且是人话', artifacts.problems.some(
    (line) => line.includes('greedy') && line.includes('@dsc/ui') && line.includes('已跳过加载'),
  ), JSON.stringify(artifacts.problems))
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n${String(failures)} 条断言未过`)
  process.exit(1)
}
console.log('\n全部通过')
