/** compact 包级测试：插件对象 + 九个可调值 + /compact 命令（配置与阈值按源码断言）。
 * 读 lib/ 产物，先 pnpm run build。单独跑：node src/packages/compact/tests/compact.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { compactPlugin } = await import(new URL('../../../../lib/packages/compact/index.js', import.meta.url).href)
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}
check('插件对象：名字、提供服务、六个注入', () => {
  assert.equal(compactPlugin.name, 'compact')
  assert.equal(compactPlugin.provide, 'compact')
  assert.deepEqual([...compactPlugin.inject], ['llm', 'session', 'commands', 'settings', 'prompt', 'tools'])
  assert.equal(typeof compactPlugin.apply, 'function')
})
check('九个可调值的缺省口径写死在 DEFAULTS 里，分区 order=35', () => {
  for (const snippet of [/keepRecent: DEFAULT_KEEP_RECENT/, /autoCompactPercent: 80/, /headroomTokens: 0/, /compactionRetries: 1/, /retainPercent: 16/, /order: 35/]) assert.match(source, snippet)
})
check('设置分区 id=compact，字段正好这九个', () => {
  const block = source.slice(source.indexOf('const fields: SettingsField[] = ['), source.indexOf('const section: SettingsSectionSpec'))
  assert.match(source, /id: 'compact'/)
  assert.deepEqual([...block.matchAll(/key: '(\w+)'/g)].map((match) => match[1]), ['keepRecent', 'autoCompactPercent', 'headroomTokens', 'compactionRetries', 'retainPercent', 'anchorBudgetChars', 'userQuoteBudgetChars', 'readStateFiles', 'readStateChars'])
})
check('/compact 不带参数；多打的字只回一句用法', () => {
  assert.match(source, /name: 'compact', args: '', description: '压缩上下文'/)
  assert.match(source, /用法：\/compact（不带参数）/)
})
check('触发阈值：比例线与「窗口减输出预留减余量」取小，下限 1024', () => {
  assert.match(source, /Math\.max\(1024, Math\.min\(byRatio, window - reserve - headroom\)\)/)
  assert.match(source, /Math\.min\(65_536, Math\.floor\(window \* 0\.064\)\)/)
})
console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
