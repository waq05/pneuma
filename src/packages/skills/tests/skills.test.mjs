/** skills 包级测试：插件对象 + skill 工具 schema + /skills 与每技能一条命令（按源码断言）。
 * 读 lib/ 产物，先 pnpm run build。单独跑：node src/packages/skills/tests/skills.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { skillsPlugin } = await import(new URL('../../../../lib/packages/skills/index.js', import.meta.url).href)
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}
check('插件对象：名字、提供服务、四个注入', () => {
  assert.equal(skillsPlugin.name, 'skills')
  assert.equal(skillsPlugin.provide, 'skills')
  assert.deepEqual([...skillsPlugin.inject], ['session', 'tools', 'commands', 'transcript'])
  assert.equal(typeof skillsPlugin.apply, 'function')
})
check('工具叫 skill，只读，只有 name 必填', () => {
  assert.match(source, /name: 'skill'/)
  assert.match(source, /required: \['name'\]/)
  assert.match(source, /risk: 'read'/)
})
check('/skills 固定命令注册在命令表里', () => {
  assert.match(source, /name: 'skills', args: '', description: '查看技能清单/)
})
check('每个可调用技能再注册一条 /技能名，参数是 [需求]', () => {
  assert.match(source, /name, args: '\[需求\]'/)
})
check('九个内置命令名不许被技能占用', () => {
  const line = source.split('\n').find((row) => row.includes('const RESERVED_COMMANDS'))
  assert.deepEqual(line.match(/'[a-z]+'/g).map((item) => item.slice(1, -1)), ['new', 'resume', 'compact', 'model', 'help', 'exit', 'effort', 'plugins', 'skills'])
})
check('目录形态是 <available_skills>，单条描述截到 500 字', () => {
  assert.match(source, /<available_skills>/)
  assert.match(source, /DESCRIPTION_LIMIT = 500/)
})
console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
