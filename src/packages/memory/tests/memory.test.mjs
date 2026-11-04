/** memory 包级测试：插件对象 + memory 工具 schema + /memory 命令 + 设置分区（按源码断言）。
 * 读 lib/ 产物，先 pnpm run build。单独跑：node src/packages/memory/tests/memory.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { memoryPlugin } = await import(new URL('../../../../lib/packages/memory/index.js', import.meta.url).href)
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}
check('插件对象：名字、提供服务、八个注入', () => {
  assert.equal(memoryPlugin.name, 'memory')
  assert.equal(memoryPlugin.provide, 'memory')
  assert.deepEqual([...memoryPlugin.inject], ['session', 'tools', 'prompt', 'approval', 'agent', 'commands', 'transcript', 'settings'])
  assert.equal(typeof memoryPlugin.apply, 'function')
})
check('工具叫 memory，风险是写，批量操作里 target/action 必填', () => {
  assert.match(source, /name: 'memory'/)
  assert.match(source, /risk: 'write'/)
  assert.match(source, /required: \['target', 'action'\]/)
})
check('三格在描述里写死：memory | user | workspace，类型三种', () => {
  assert.match(source, /memory \| user \| workspace/)
  assert.match(source, /fact \| feedback \| reference/)
})
check('/memory 命令带 show/eval/prune/clear 子命令', () => {
  assert.match(source, /name: 'memory', args: '\[show \| eval \| refresh \| prune/)
})
check('设置分区 id=memory、order=35，含总开关与三格额度', () => {
  assert.match(source, /id: 'memory'[\s\S]{0,120}order: 35/)
  for (const key of ['enabled', 'userProfile', 'workspace', 'globalLimit', 'reviewEveryTurns']) {
    assert.match(source, new RegExp(`key: '${key}'`))
  }
})
console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
