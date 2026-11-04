/** approval 包级测试：插件对象 + 审批卡「将做的改动」的推演（纯函数，不碰内核）。
 * 读 lib/ 产物，先 pnpm run build。单独跑：node src/packages/approval/tests/approval.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { approvalPlugin, approvalDiffOf } = await import(new URL('../../../../lib/packages/approval/index.js', import.meta.url).href)
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
let pass = 0, fail = 0
const check = async (label, fn) => {
  try { await fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}
await check('插件对象：名字、提供服务、五个注入、可 apply', () => {
  assert.equal(approvalPlugin.name, 'approval')
  assert.equal(approvalPlugin.provide, 'approval')
  assert.deepEqual([...approvalPlugin.inject], ['llm', 'session', 'guards', 'surfaces', 'waiting'])
  assert.equal(typeof approvalPlugin.apply, 'function')
})
await check('只给写类工具推演差异：只读与命令工具直接不给', async () => {
  assert.equal(await approvalDiffOf({ toolName: 'read', args: {} }), null)
  assert.equal(await approvalDiffOf({ toolName: 'bash', args: { command: 'ls' } }), null)
})
await check('write 到还不存在的文件：从空串起算，added 两条、标 fellBack', async () => {
  const view = await approvalDiffOf({ toolName: 'write', args: { path: 'no-such-dir/x.txt', content: 'a\nb\n' }, cwd: process.cwd() })
  assert.equal(view.status, 'added')
  assert.equal(view.fellBack, true)
  assert.equal(view.added, 2)
})
await check('三档权限模式与两档审阅者都在源码里', () => {
  for (const id of ['readonly', 'auto-edit', 'full-access', 'user', 'auto-review']) assert.match(source, new RegExp(`id: '${id}'`))
})
await check('等卡时限默认 300 秒，夹在 10 秒到 1 小时', () => {
  assert.match(source, /DEFAULT_APPROVAL_TIMEOUT_MS = 300_000/)
  assert.match(source, /Math\.min\(Math\.max\(Math\.round\(num\), 10_000\), 3_600_000\)/)
})
console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
