/** plan 包级测试：插件对象 + exit_plan_mode 的工具 schema + 三个投影的注册（按源码断言）。
 * 读 lib/ 产物，先 pnpm run build。单独跑：node src/packages/plan/tests/plan.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { planPlugin } = await import(new URL('../../../../lib/packages/plan/index.js', import.meta.url).href)
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}
check('插件对象：名字、提供服务、五个注入', () => {
  assert.equal(planPlugin.name, 'plan')
  assert.equal(planPlugin.provide, 'plan')
  assert.deepEqual([...planPlugin.inject], ['session', 'tools', 'mode', 'surfaces', 'waiting'])
  assert.equal(typeof planPlugin.apply, 'function')
})
check('工具叫 exit_plan_mode，风险只读，只有 plan 必填', () => {
  assert.match(source, /name: 'exit_plan_mode'/)
  assert.match(source, /required: \['plan'\]/)
  assert.match(source, /risk: 'read'/)
})
check('计划落盘走 planFilePath，批准后把模式切回 build', () => {
  assert.match(source, /planFilePath\(runCtx\.cwd, title\)/)
  assert.match(source, /ctx\.mode\.setMode\('build'\)/)
})
check('投影两个面 + 一个等待登记', () => {
  assert.match(source, /surfaces\.register\('pendingPlan'/)
  assert.match(source, /surfaces\.register\('planDirectory'/)
  assert.match(source, /waiting\.register\('plan'/)
})
check('面板只出最近 12 条，会话账上限 50 条', () => {
  assert.match(source, /PLAN_DIRECTORY_LIMIT = 12/)
  assert.match(source, /PLAN_HISTORY_LIMIT = 50/)
})
console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
