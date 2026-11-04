/** session 包级测试：插件对象与服务面（真会话要文件系统，留给 scripts/ 的集成探针）。
 * 读 lib/ 产物，先 pnpm run build。单独跑：node src/packages/session/tests/session.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { sessionPlugin } = await import(new URL('../../../../lib/packages/session/index.js', import.meta.url).href)
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}
check('插件对象：名字、提供服务、不声明 inject、apply 收两个参数', () => {
  assert.deepEqual([sessionPlugin.name, sessionPlugin.provide], ['session', 'session'])
  assert.equal(sessionPlugin.inject, undefined)
  assert.equal(typeof sessionPlugin.apply, 'function')
  assert.equal(sessionPlugin.apply.length, 2)
})
check('服务面十二个方法一个不少', () => {
  for (const signature of [
    'current() {', 'async open(', 'async refresh() {', 'async archive(paths) {', 'archived(): ArchivedPage {', 'restore(paths) {',
    'async purge(paths) {', 'rename(path, title) {', 'setPinned(path, pinned) {', 'userMessages(path) {',
    'fork(path, index): SessionForkResult {', 'rewind(path, keep, text): SettingsMutation {',
  ]) assert.ok(source.includes(signature), signature)
})
check('会话插件不自己注册工具与命令（那两件事有专门的包）', () => {
  assert.doesNotMatch(source, /ctx\.(tools|commands)\.register/)
  assert.doesNotMatch(source, /ctx\.prompt\.register/)
})
check('启动选项 cwd/resumeSessionPath，切会话发 dsc/session-open，退出关会话', () => {
  assert.match(source, /cwd\?: string/)
  assert.match(source, /resumeSessionPath\?: string \| null/)
  assert.match(source, /'auto' = last-session 指针/)
  assert.match(source, /ctx\.emit\('dsc\/session-open'/)
  assert.match(source, /ctx\.on\('dsc\/exit', \(\) => session\.close\(\)\)/)
})
console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
