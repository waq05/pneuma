/** surfaces 包级测试：注册 / 读取 / 退订这条服务形状。读 lib/ 产物，先 pnpm run build。
 * 单独跑：node src/packages/surfaces/tests/surfaces.test.mjs
 */
import assert from 'node:assert/strict'

const { surfacesPlugin } = await import(new URL('../../../../lib/packages/surfaces/index.js', import.meta.url).href)

let service
surfacesPlugin.apply({ provide(id, value) { assert.equal(id, 'surfaces'); service = value } })

let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}

check('注册一片投影，build 里就有它；ids 按注册顺序，退订后两处都没了', () => {
  const first = service.register('session', () => ({ id: 's1' }))
  const second = service.register('todos', () => [])
  assert.deepEqual(service.build(), { session: { id: 's1' }, todos: [] })
  assert.deepEqual(service.ids, ['session', 'todos'])
  first()
  second()
  assert.deepEqual(service.build(), {})
  assert.deepEqual(service.ids, [])
})
check('生产函数抛错时沿用上一次的值，不把整帧快照弄没', () => {
  let alive = true
  service.register('waiting', () => {
    if (!alive) throw new Error('boom')
    return 'ok'
  })
  assert.equal(service.build().waiting, 'ok')
  alive = false
  assert.equal(service.build().waiting, 'ok')
})

console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
