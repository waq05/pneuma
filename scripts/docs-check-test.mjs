/**
 * `scripts/docs-check.mjs` 的自测。
 *
 * 为什么必须有：报警器自己不验，「它报了红」和「它压根没扫」在终端上长得一样。
 * 本测试在临时目录里造仓库根（配 `--root`），不碰真仓库，也不依赖本机路径。
 *
 * 断言：
 *   1. 反引号里写一个不存在的路径 → 退出 1、恰好 1 条违规、文件与行号精确（存在的路径不报）；
 *   2. 相对链接写断 → 退出 1；带 title 的链接按 path 解析（存在的不报、缺的报）；
 *   3. `<!-- docs-check:ignore: 理由 -->` 生效 → 退出 0、0 条违规；
 *   4. 围栏代码块里的路径不报 → 退出 0；
 *   5. 基线只许缩减：`entries.length > maxEntries` → 退出 1（同一条目数把上限调回 2 → 退 0）；
 *   6. 参数错误（不认识规则名 / `--root` 不是目录）→ 退出 2；
 *   7. 行内代码里写的豁免注释只是示例，不豁免下一行 → 退出 1；
 *   8. `NUMA_GATE_DISABLE=docs-check` 时整条跳过 → 退出 0、stdout/stderr 有跳过行，
 *      `--json` 跳过态可解析且带 `skipped`；不相关门禁名不跳过（本来红还是红）。
 *
 * 运行：node scripts/docs-check-test.mjs
 *
 * @module dsc/scripts/docs-check-test
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), 'docs-check.mjs')
const roots = []
let passed = 0
let failed = 0

/** 造一个临时仓库根：`docs/<name>.md` + `src/core/real.ts`（给「存在」作对照）。 */
function fixture(name, markdown) {
  const root = mkdtempSync(join(tmpdir(), 'docs-check-test-'))
  roots.push(root)
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'src', 'core'), { recursive: true })
  writeFileSync(join(root, 'src', 'core', 'real.ts'), '// 存在的文件\n', 'utf8')
  writeFileSync(join(root, 'docs', name), markdown, 'utf8')
  return root
}

/** 给 fixture 根写一份基线文件。 */
function writeBaseline(root, baseline) {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'docs-check-baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
}

/** 跑一次 docs-check，返回 `{status, json}`（`--json` 输出可解析是每次都要验的）。 */
function run(root, rule) {
  const result = spawnSync(process.execPath, [script, '--root', root, '--rule', rule, '--json'], {
    cwd: dirname(script),
    encoding: 'utf8',
  })
  assert.strictEqual(result.stderr, '', result.stderr)
  return { status: result.status, json: JSON.parse(result.stdout) }
}

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n${String(error.message).split('\n').slice(0, 6).join('\n')}`)
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  }
}

console.log('[1] 不存在的仓库路径 → 1 条违规')
check('不存在的路径退 1 并点名文件与行号', () => {
  const root = fixture('a.md', '# a\n\n这里写 `src/core/foo.ts`，磁盘上没有；`src/core/real.ts` 是有的。\n')
  const { status, json } = run(root, 'code-path')
  assert.strictEqual(status, 1)
  assert.strictEqual(json.stats.checked, 2)
  assert.strictEqual(json.stats.violations, 1)
  assert.deepStrictEqual(json.violations.map(({ file, line, rule, value }) => ({ file, line, rule, value })), [
    { file: 'docs/a.md', line: 3, rule: 'code-path', value: 'src/core/foo.ts' },
  ])
  assert.strictEqual(json.stats.baselined, 0)
})

console.log('[2] 相对链接断链 → 1 条违规（带 title 的按 path 解析）')
check('断链退 1 且按文档所在目录解析', () => {
  const root = fixture('b.md', '# b\n\n[缺的文件](../nope.md)\n[有标题但存在](./ok.md "标题")\n[有标题且缺失](./gone.md "标题")\n')
  writeFileSync(join(root, 'docs', 'ok.md'), '# ok\n', 'utf8')
  const { status, json } = run(root, 'link')
  assert.strictEqual(status, 1)
  assert.strictEqual(json.stats.violations, 2)
  assert.deepStrictEqual(
    json.violations.map((violation) => [violation.file, violation.line]),
    [
      ['docs/b.md', 3],
      ['docs/b.md', 5],
    ],
  )
})

console.log('[3] docs-check:ignore 生效 → 0')
check('行级 ignore 豁免下一行', () => {
  const root = fixture('c.md', '# c\n\n<!-- docs-check:ignore: 自测豁免 -->\n`src/core/foo.ts`\n')
  const { status, json } = run(root, 'code-path')
  assert.strictEqual(status, 0)
  assert.strictEqual(json.stats.violations, 0)
})

console.log('[4] 围栏代码块整段跳过 → 0')
check('围栏里的路径不报', () => {
  const root = fixture('d.md', '# d\n\n```js\n路径 `src/core/foo.ts` 只是示例\n```\n')
  const { status, json } = run(root, 'code-path')
  assert.strictEqual(status, 0)
  assert.strictEqual(json.stats.violations, 0)
})

console.log('[5] 基线只许缩减 → 1')
check('entries 超过 maxEntries 退 1，调回上限退 0', () => {
  const root = fixture('e.md', '# e\n\n`src/core/foo.ts` 与 `src/core/bar.ts`\n')
  const entries = [
    { rule: 'code-path', file: 'docs/e.md', value: 'src/core/foo.ts', reason: '自测冻结' },
    { rule: 'code-path', file: 'docs/e.md', value: 'src/core/bar.ts', reason: '自测冻结' },
  ]
  writeBaseline(root, { version: 1, maxEntries: 2, entries })
  const ok = run(root, 'code-path')
  assert.strictEqual(ok.status, 0, '2 条命中基线应退 0')
  assert.strictEqual(ok.json.stats.baselined, 2)
  writeBaseline(root, { version: 1, maxEntries: 1, entries })
  const grown = run(root, 'code-path')
  assert.strictEqual(grown.status, 1)
  assert.strictEqual(grown.json.violations.length, 1)
  assert.strictEqual(grown.json.violations[0].rule, 'baseline')
  assert.match(grown.json.violations[0].reason, /基线只许缩减/)
})

console.log('[6] 参数错误 → 2')
check('不认识的规则名与不存在的 --root 都退 2', () => {
  const badRule = spawnSync(process.execPath, [script, '--rule', 'nope'], { cwd: dirname(script), encoding: 'utf8' })
  assert.strictEqual(badRule.status, 2)
  assert.match(badRule.stderr, /规则名不认识/)
  const missingRoot = join(tmpdir(), 'docs-check-test-missing-root')
  rmSync(missingRoot, { recursive: true, force: true })
  const badRoot = spawnSync(process.execPath, [script, '--root', missingRoot], { cwd: dirname(script), encoding: 'utf8' })
  assert.strictEqual(badRoot.status, 2)
  assert.match(badRoot.stderr, /--root 不是目录/)
})

console.log('[7] 行内代码里的豁免注释不生效 → 1')
check('反引号里的 docs-check:ignore 只是示例', () => {
  const root = fixture('f.md', '# f\n\n`<!-- docs-check:ignore: 假豁免 -->`\n`src/core/foo.ts`\n')
  const { status, json } = run(root, 'code-path')
  assert.strictEqual(status, 1)
  assert.strictEqual(json.stats.violations, 1)
  assert.strictEqual(json.violations[0].line, 4)
})

console.log('[8] NUMA_GATE_DISABLE 统一回退 → 0 且不静默')
check('命中门禁名时跳过并打提示，不相关门禁名不跳过', () => {
  const root = fixture('g.md', '# g\n\n`src/core/foo.ts`\n') // 正常情况下这是红的
  const envWith = (value) => ({ ...process.env, NUMA_GATE_DISABLE: value })
  const human = spawnSync(process.execPath, [script, '--root', root, '--rule', 'code-path'], {
    cwd: dirname(script),
    encoding: 'utf8',
    env: envWith('docs-check'),
  })
  assert.strictEqual(human.status, 0)
  assert.match(`${human.stdout}${human.stderr}`, /已按 NUMA_GATE_DISABLE 跳过 docs-check/)
  const jsonRun = spawnSync(process.execPath, [script, '--root', root, '--json'], {
    cwd: dirname(script),
    encoding: 'utf8',
    env: envWith('docs-check'),
  })
  assert.strictEqual(jsonRun.status, 0)
  assert.match(jsonRun.stderr, /已按 NUMA_GATE_DISABLE 跳过 docs-check/)
  const payload = JSON.parse(jsonRun.stdout)
  assert.strictEqual(payload.skipped, 'docs-check')
  assert.strictEqual(payload.stats.violations, 0)
  // 逗号列表里命中任意一项也跳过
  const list = spawnSync(process.execPath, [script, '--root', root, '--json'], {
    cwd: dirname(script),
    encoding: 'utf8',
    env: envWith('other-gate, docs-check'),
  })
  assert.strictEqual(list.status, 0)
  assert.strictEqual(JSON.parse(list.stdout).skipped, 'docs-check')
  // 不相关的门禁名不跳过：本该红还是红
  const other = spawnSync(process.execPath, [script, '--root', root, '--rule', 'code-path'], {
    cwd: dirname(script),
    encoding: 'utf8',
    env: envWith('other-gate'),
  })
  assert.strictEqual(other.status, 1)
})

console.log(
  failed === 0
    ? `\n8 条断言全部通过（${String(passed)}/${String(passed + failed)}）`
    : `\n${String(failed)}/${String(passed + failed)} 条断言失败`,
)
process.exit(failed === 0 ? 0 : 1)
