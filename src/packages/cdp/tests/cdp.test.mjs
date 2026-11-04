/** cdp 包级测试：RingBuffer 的纯函数 + 库包的清单形状。
 * 读 lib/ 产物（先 pnpm run build）；单独跑：node src/packages/cdp/tests/cdp.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const { RingBuffer } = await import(new URL('../../../../lib/packages/cdp/ring-buffer.js', import.meta.url).href)
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}

check('环形缓冲：满了丢最旧的，改容量只截最旧的，clear 清空，能按条件找回条目', () => {
  const buffer = new RingBuffer(2)
  for (const n of [1, 2, 3]) buffer.push({ requestId: `r${n}` })
  assert.equal(buffer.size, 2)
  assert.deepEqual(buffer.toArray(), [{ requestId: 'r2' }, { requestId: 'r3' }])
  assert.deepEqual(buffer.find((item) => item.requestId === 'r3'), { requestId: 'r3' })
  assert.equal(buffer.find((item) => item.requestId === 'r1'), undefined)
  buffer.resize(1)
  assert.deepEqual(buffer.toArray(), [{ requestId: 'r3' }])
  buffer.clear()
  assert.equal(buffer.size, 0)
})
check('库包清单：library 为真，没有 cordis.patch.yml / bundle / order', () => {
  assert.equal(manifest.pneuma.library, true)
  assert.equal(existsSync(new URL('../cordis.patch.yml', import.meta.url)), false)
  assert.equal(manifest.pneuma.bundle, undefined)
  assert.equal(manifest.pneuma.order, undefined)
})
check('模块子路径导出键与目标一字不差，且指向包内真实模块', () => {
  const modules = Object.entries(manifest.exports).filter(([key]) => key.startsWith('./') && key !== './package.json')
  assert.ok(modules.length > 0 && Object.keys(manifest.exports).includes('./ring-buffer.js'))
  for (const [key, target] of modules) assert.equal(target, key)
})
console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
