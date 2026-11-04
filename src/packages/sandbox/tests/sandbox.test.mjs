/** sandbox 包级测试：policy.ts 的判定（默认值、白名单、档位拒写、受保护名）。读 lib/ 产物，先 pnpm run build。
 * 单独跑：node src/packages/sandbox/tests/sandbox.test.mjs
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const policy = await import(new URL('../../../../lib/packages/sandbox/policy.js', import.meta.url).href)
const repo = fileURLToPath(new URL('../../../..', import.meta.url))
const base = { cwd: repo, tmpDir: join(repo, '.tmp'), dscHome: join(repo, '.dsc'), extraWritableRoots: [], readOnlySubpaths: [], networkAccess: false }

let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}
check('默认配置 workspace-write、网络关；坏档位回落并记一条问题', () => {
  const { config } = policy.resolveSandboxConfig(undefined)
  assert.deepEqual([config.mode, config.networkAccess], ['workspace-write', false])
  const bad = policy.resolveSandboxConfig({ mode: 'yolo' })
  assert.equal(bad.config.mode, 'workspace-write')
  assert.equal(bad.problems.length, 1)
})
check('白名单：精确域不放行子域，通配只放一层；条目归一后路径与中文域不收', () => {
  assert.equal(policy.allowlistMatches('api.example.com', ['example.com']), false)
  assert.equal(policy.allowlistMatches('api.example.com', ['*.example.com']), true)
  assert.equal(policy.allowlistMatches('a.b.example.com', ['*.example.com']), false)
  assert.deepEqual(policy.normalizeAllowlistEntry(' Example.COM. '), { ok: true, domain: 'example.com' })
  const rejects = ['https://x/y', '中文.中国'].map((raw) => policy.normalizeAllowlistEntry(raw).ok)
  assert.deepEqual(rejects, [false, false])
})
check('档位判定：只读档拒一切写，可写档放行根内、拒根外与受保护名', () => {
  const readOnly = policy.createPolicy({ ...base, mode: 'read-only' })
  assert.equal(policy.checkWrite(readOnly, join(repo, 'package.json')).rule, 'mode-read-only')
  const write = policy.createPolicy({ ...base, mode: 'workspace-write' })
  assert.equal(policy.checkWrite(write, join(repo, 'package.json')).allowed, true)
  assert.equal(policy.checkWrite(write, join(tmpdir(), 'outside.txt')).rule, 'outside-writable-roots')
  assert.equal(policy.checkWrite(write, join(repo, '.env')).rule, 'protected-metadata')
})
console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
