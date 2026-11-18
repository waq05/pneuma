/**
 * `scripts/version-check.mjs` 的自测：临时目录造站点 + 假包，逐条断言退出码与输出。
 * 用法：node scripts/version-check-test.mjs（退出 0 全过 / 1 有用例失败）。
 *
 * @module scripts/version-check-test
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./version-check.mjs', import.meta.url))
const tempRoots = []

/** 造一份临时仓库：三处必填清单 + 两个假包。 */
function makeRepo(version = '9.9.9') {
  const root = mkdtempSync(join(tmpdir(), 'version-check-'))
  tempRoots.push(root)
  for (const rel of ['package.json', 'desktop/package.json', 'ui-shell/package.json', 'src/packages/alpha/package.json', 'src/packages/beta/package.json']) {
    writeManifest(root, rel, version)
  }
  return root
}

/** 往临时仓库写一份最小 package.json。 */
function writeManifest(root, rel, version) {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ name: rel.replaceAll('/', '-'), version }, null, 2)}\n`, 'utf8')
}

/** 跑一次 version-check；env 用来模拟 `NUMA_GATE_DISABLE`。 */
function run(args, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

let passed = 0
try {
  // 1. 全一致 → 0
  let repo = makeRepo()
  let out = run(['--root', repo, '--tag', 'v9.9.9'])
  assert.equal(out.status, 0, out.stderr || out.stdout)
  assert.match(out.stdout, /版本一致/)
  passed += 1

  // 2. desktop 落后 → 1，且打印对照表那一行
  repo = makeRepo()
  writeManifest(repo, 'desktop/package.json', '9.9.8')
  out = run(['--root', repo, '--tag', 'v9.9.9'])
  assert.equal(out.status, 1, out.stderr || out.stdout)
  assert.ok(out.stdout.includes('desktop 9.9.8 ≠ 9.9.9'), out.stdout)
  passed += 1

  // 3. --tag 与站点版本不符 → 1
  repo = makeRepo()
  out = run(['--root', repo, '--tag', 'v0.9.0'])
  assert.equal(out.status, 1, out.stderr || out.stdout)
  assert.ok(out.stdout.includes('root 9.9.9 ≠ 0.9.0'), out.stdout)
  passed += 1

  // 4. 缺 ui-shell/package.json → 2
  repo = makeRepo()
  rmSync(join(repo, 'ui-shell'), { recursive: true })
  out = run(['--root', repo, '--tag', 'v9.9.9'])
  assert.equal(out.status, 2, out.stdout)
  assert.ok(out.stderr.includes('ui-shell'), out.stderr)
  passed += 1

  // 5. glob 展开为 0 → 2
  repo = makeRepo()
  rmSync(join(repo, 'src/packages'), { recursive: true })
  out = run(['--root', repo, '--tag', 'v9.9.9'])
  assert.equal(out.status, 2, out.stdout)
  assert.ok(out.stderr.includes('glob'), out.stderr)
  passed += 1

  // 6. 没有 --tag 且不在 git 仓库（取不到 tag）→ 2
  repo = makeRepo()
  out = run(['--root', repo])
  assert.equal(out.status, 2, out.stdout)
  assert.ok(out.stderr.includes('取不到 tag'), out.stderr)
  passed += 1

  // 7. --json 输出可解析，ok 与退出码一致
  repo = makeRepo()
  out = run(['--root', repo, '--tag', 'v9.9.9', '--json'])
  assert.equal(out.status, 0, out.stderr || out.stdout)
  assert.equal(JSON.parse(out.stdout).ok, true)
  passed += 1

  // 8. 包组里一个包落后 → 1，包组行给出不一致计数
  repo = makeRepo()
  writeManifest(repo, 'src/packages/beta/package.json', '9.9.8')
  out = run(['--root', repo, '--tag', 'v9.9.9'])
  assert.equal(out.status, 1, out.stderr || out.stdout)
  assert.ok(out.stdout.includes('packages 有 1/2 个包 ≠ 9.9.9'), out.stdout)
  passed += 1

  // 9. NUMA_GATE_DISABLE 命中：本该退 1 的不一致夹具 → 0，且打印跳过行（05-acceptance.md §6）
  repo = makeRepo()
  writeManifest(repo, 'desktop/package.json', '9.9.8')
  out = run(['--root', repo, '--tag', 'v9.9.9'], { NUMA_GATE_DISABLE: 'version-check' })
  assert.equal(out.status, 0, out.stderr || out.stdout)
  assert.ok(out.stdout.includes('已按 NUMA_GATE_DISABLE 跳过 version-check'), out.stdout)
  passed += 1

  // 10. NUMA_GATE_DISABLE + --json：stdout 仍是一份可 parse 的 JSON，跳过提示走 stderr
  repo = makeRepo()
  out = run(['--root', repo, '--tag', 'v9.9.9', '--json'], { NUMA_GATE_DISABLE: 'other-gate,version-check' })
  assert.equal(out.status, 0, out.stderr || out.stdout)
  const skipped = JSON.parse(out.stdout)
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.gate, 'version-check')
  assert.ok(out.stderr.includes('已按 NUMA_GATE_DISABLE 跳过 version-check'), out.stderr)
  passed += 1
} finally {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true })
}

console.log(`✓ version-check 自测：${String(passed)}/${String(passed)} 通过`)
