/** todo 包级测试：导出的插件对象 + todo_write 的工具 schema（含四态）。读 lib/ 产物，先 pnpm run build。
 * 工具在 apply 里现造、不 export，所以 schema 那段按源码断言。单独跑：node src/packages/todo/tests/todo.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { todoPlugin } = await import(new URL('../../../../lib/packages/todo/index.js', import.meta.url).href)
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}

check('插件对象：名字、提供服务、可 apply', () => {
  assert.equal(todoPlugin.name, 'todo')
  assert.equal(todoPlugin.provide, 'todo')
  assert.equal(typeof todoPlugin.apply, 'function')
})
check('inject 声明了它真正用到的七个服务', () => {
  assert.deepEqual([...todoPlugin.inject], ['session', 'tools', 'commands', 'surfaces', 'compact', 'prompt', 'settings'])
})
check('工具叫 todo_write，风险等级是只读', () => {
  assert.match(source, /name: 'todo_write'/)
  assert.match(source, /risk: 'read'/)
})
check('schema 必填只有 todos，merge 是布尔开关', () => {
  assert.match(source, /required: \['todos'\]/)
  assert.match(source, /merge: \{ type: 'boolean'/)
})
check('状态只有 pending / in_progress / completed / cancelled 四态', () => {
  assert.match(source, /'pending \| in_progress \| completed \| cancelled'/)
})
check('子任务的父 id 是可选字段', () => {
  assert.match(source, /parent: \{ type: 'string'/)
})

console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
