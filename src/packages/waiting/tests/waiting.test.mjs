/** waiting 包级测试：any() 的语义——有没有哪张卡片正挂着等用户。读 lib/ 产物，先 pnpm run build。
 * 单独跑：node src/packages/waiting/tests/waiting.test.mjs
 */
import assert from 'node:assert/strict'

const { waitingPlugin } = await import(new URL('../../../../lib/packages/waiting/index.js', import.meta.url).href)

let service
waitingPlugin.apply({ provide(id, value) { assert.equal(id, 'waiting'); service = value } })

let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}

check('没人登记时 any() 为假；登记一张挂起的卡片后为真，ids 列出它', () => {
  assert.equal(service.any, false)
  const off = service.register('approval', () => true)
  assert.equal(service.any, true)
  assert.deepEqual(service.ids, ['approval'])
  off()
  assert.equal(service.any, false)
})
check('卡片自己算崩了、或者已经答完（false），都不算有人在等', () => {
  const boom = service.register('question', () => { throw new Error('boom') })
  const done = service.register('plan', () => false)
  assert.equal(service.any, false)
  boom()
  done()
})
check('退订只撤自己那一份', () => {
  const off = service.register('approval', () => true)
  service.register('question', () => true)
  off()
  assert.deepEqual(service.ids, ['question'])
  assert.equal(service.any, true)
})

console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
