/**
 * `probe-inventory-check.mjs` 的自测：不引测试框架，只用 `node:assert`。
 *
 * 五组断言（对应 design/01-test-bench.md §3 与 05-acceptance.md:39 的 0/1/2 三档）：
 *   ① 临时根只放一条 `zz-orphan-check.mjs` → 退 1 且在输出里点名（B/D 读真仓库根，不会误退 2）；
 *   ② 把它改名成 `zz-orphan-test.mjs` → 退 0（`-test.mjs` 自动进 A 类）；
 *   ③ `--manual` 登记一个不存在的文件 → 退 1 且 `staleEntries` 非空；
 *   ④ `--json` 的 stdout 可 `JSON.parse`、六类之和 + 未归类 == total、`platforms` 三键齐；
 *   ⑤ 参数错（`--bogus`）→ 退 2 且 stderr 有提示（工具错误与断言失败必须分开）。
 *
 * 临时文件全用 `mkdtempSync(join(tmpdir(),'numa-'))` 建、`rmSync` 收；不碰 `~/.dsc`、不联网。
 * 跑法：`node scripts/probe-inventory-check-test.mjs`（`-test.mjs` 命名会让 check-core 自动收它）。
 *
 * 临时孤儿文件名一律用字符串拼接构造：本文件自己就在扫描范围里，写死 `zz-orphan-*.mjs`
 * 字面量会让别的 `.mjs` 的 E 类引用检测命中，反向验收（真 scripts/ 里放同名空文件）就永远
 * 红不起来。
 *
 * @module dsc/scripts/probe-inventory-check-test
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'probe-inventory-check.mjs')
const tempRoot = mkdtempSync(join(tmpdir(), 'numa-'))
const manualPath = join(tempRoot, 'manual.json')
const ORPHAN_CHECK = ['zz-orphan', 'check.mjs'].join('-')
const ORPHAN_TEST = ['zz-orphan', 'test.mjs'].join('-')
const GONE_ENTRY = ['zz-gone', 'check.mjs'].join('-')

/** 写一份登记表：空数组用于「没有任何人工登记」的场景。 */
function writeManual(entries) {
  writeFileSync(manualPath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8')
}

/** 跑一次检查脚本；清掉 `NUMA_GATE_DISABLE` 与 `NUMA_RUN_ID`，自测不受外部环境摆布。 */
function run(extraArgs = []) {
  const env = { ...process.env }
  delete env.NUMA_GATE_DISABLE
  delete env.NUMA_RUN_ID
  const result = spawnSync(process.execPath, [scriptPath, `--root=${tempRoot}`, `--manual=${manualPath}`, ...extraArgs], {
    encoding: 'utf8',
    env,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

let passed = 0
try {
  writeManual([])

  // ① 临时根里放一条不属于任何一类的脚本 → 退 1 并点名。
  writeFileSync(join(tempRoot, ORPHAN_CHECK), '// 反向用例：不属于任何一类\n', 'utf8')
  let result = run()
  assert.equal(result.status, 1, `① 未归类应退 1，实际 ${String(result.status)}\n${result.stderr}`)
  assert.ok(result.stdout.includes(ORPHAN_CHECK), `① 输出里应点名 ${ORPHAN_CHECK}\n${result.stdout}`)
  passed += 1

  // ② 改名成 `-test.mjs` → A 类自动发现，退 0。
  rmSync(join(tempRoot, ORPHAN_CHECK), { force: true })
  writeFileSync(join(tempRoot, ORPHAN_TEST), '// 反向用例：改名后进 A 类\n', 'utf8')
  result = run()
  assert.equal(result.status, 0, `② 改名后应退 0，实际 ${String(result.status)}\n${result.stderr}`)
  passed += 1

  // ③ 登记表里留一条文件不存在的条目 → 退 1 且 staleEntries 非空。
  writeManual([{ file: GONE_ENTRY, reason: '反向用例：登记一个不存在的文件', owner: 'test', addedAt: '2026-11-18', runBy: 'test' }])
  result = run(['--json'])
  assert.equal(result.status, 1, `③ 失效登记应退 1，实际 ${String(result.status)}\n${result.stderr}`)
  const staleReport = JSON.parse(result.stdout)
  assert.ok(staleReport.staleEntries.length > 0, '③ 失效登记应进 staleEntries')
  passed += 1

  // ④ `--json` 可解析；六类之和 + 未归类 == total；platforms 三键齐。
  writeManual([])
  const jsonResult = run(['--json'])
  assert.equal(jsonResult.status, 0, `④ 应退 0，实际 ${String(jsonResult.status)}\n${jsonResult.stderr}`)
  const report = JSON.parse(jsonResult.stdout)
  const classSum = Object.values(report.classes).reduce((sum, count) => sum + count, 0)
  assert.equal(classSum + report.unclassified.length, report.total, '④ 六类之和 + 未归类应等于 total')
  for (const key of ['win32', 'all', 'other']) {
    assert.equal(typeof report.platforms[key], 'number', `④ platforms.${key} 应是数字`)
  }
  assert.equal(typeof report.runId, 'string', '④ runId 应是字符串')
  passed += 1

  // ⑤ 参数错误 → 退 2（05-acceptance.md:39：正常 0 / 故障 1 / 工具或参数错 2）。
  result = run(['--bogus'])
  assert.equal(result.status, 2, `⑤ 未知参数应退 2，实际 ${String(result.status)}\n${result.stderr}`)
  assert.ok(result.stderr.includes('不认识的参数'), `⑤ stderr 应给出参数提示\n${result.stderr}`)
  passed += 1
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

console.log(`probe-inventory-check-test: ${String(passed)} 项通过`)
