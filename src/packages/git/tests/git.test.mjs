/** git 包级测试：插件对象 + 三档轮询节奏 + 快照面接线（真跑 git 的读数留给集成探针）。
 * 读 lib/ 产物，先 pnpm run build。单独跑：node src/packages/git/tests/git.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { gitPlugin } = await import(new URL('../../../../lib/packages/git/index.js', import.meta.url).href)
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}
check('插件对象：名字、提供服务、两个注入', () => {
  assert.deepEqual([gitPlugin.name, gitPlugin.provide], ['git', 'git'])
  assert.deepEqual([...gitPlugin.inject], ['session', 'surfaces'])
  assert.equal(typeof gitPlugin.apply, 'function')
})
check('三档节奏：脏 12s、干净 30s、非仓库 60s', () => {
  for (const snippet of [/POLL_DIRTY_MS = 12_000/, /POLL_CLEAN_MS = 30_000/, /POLL_IDLE_MS = 60_000/]) assert.match(source, snippet)
})
check('空读数形状：repo=false、分支空、非 detached、0 个改动', () => {
  assert.match(source, /EMPTY_GIT: GitSurface = \{ repo: false, branch: '', detached: false, dirtyFileCount: 0 \}/)
})
check('服务只有 snapshot / refresh，并注册 git 这一片快照', () => {
  assert.match(source, /const service: GitService = \{/)
  assert.match(source, /snapshot\(\): GitSurface \{/)
  assert.match(source, /ctx\.provide\('git', service\)/)
  assert.match(source, /surfaces\.register\('git'/)
})
check('读数只数工作目录内的改动，分支有 detached 与「无提交」两种兜底', () => {
  assert.match(source, /toWorkspacePath\(entry\.file, prefix\) !== null/)
  assert.match(source, /detached = head === 'HEAD'/)
  assert.match(source, /'（无提交）'|'\(无提交\)'/)
})
check('两处催拍：回合收工与换到别的工作区', () => {
  assert.match(source, /ctx\.on\('dsc\/turn-end', refresh\)/)
  assert.match(source, /session\.meta\.cwd !== cacheCwd/)
})
console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
