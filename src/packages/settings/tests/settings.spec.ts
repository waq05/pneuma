/** settings 包级测试：插件对象 + 八个内置分区的 id/order/字段（分区在 apply 里注册，按源码断言）。
 * 读 lib/ 产物，先 pnpm run build。单独跑：node src/packages/settings/tests/settings.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { settingsPlugin } = await import(new URL('../../../../lib/packages/settings/index.js', import.meta.url).href)
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}
check('插件对象：名字、提供服务、三个注入', () => {
  assert.equal(settingsPlugin.name, 'settings')
  assert.equal(settingsPlugin.provide, 'settings')
  assert.deepEqual([...settingsPlugin.inject], ['llm', 'approval', 'transcript'])
  assert.equal(typeof settingsPlugin.apply, 'function')
})
check('八个内置分区按固定顺序注册', () => {
  assert.match(source, /for \(const section of \[general, models, presetsSection, skillsSection, archiveSection, usageSection, tuiSection, about\]\)/)
})
check('分区 id 与 order 对得上（通用 0 到关于 900）', () => {
  const orderOf = (id) => {
    const hit = /order: (\d+)/.exec(source.slice(source.indexOf("id: '" + id + "'"), source.indexOf("id: '" + id + "'") + 300))
    return hit === null ? null : Number(hit[1])
  }
  assert.deepEqual(['general', 'models', 'presets', 'skills', 'usage', 'archive', 'tui', 'about'].map(orderOf), [0, 10, 15, 20, 25, 30, 35, 900])
})
check('通用分区的四个字段按顺序：预设、思考、温度、托盘', () => {
  const block = source.slice(source.indexOf("id: 'general'"), source.indexOf("id: 'models'"))
  assert.deepEqual([...block.matchAll(/key: '(\w+)'/g)].map((match) => match[1]), ['permissionPreset', 'effort', 'temperature', 'closeToTray'])
})
check('五个分区由桌面端自画（custom），关于分区有检查更新', () => {
  assert.equal((source.match(/custom: true/g) ?? []).length, 5)
  assert.match(source, /key: 'updateCheck'/)
  assert.match(source, /action: 'check-update'/)
})
console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
