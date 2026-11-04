/** image-diet 包级测试：设置分区的字段与默认值。
 * 读 lib/ 产物（先 pnpm run build）；单独跑：node src/packages/image-diet/tests/image-diet.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const { imageDietPlugin } = await import(new URL('../../../../lib/packages/image-diet/index.js', import.meta.url).href)
const core = await import(new URL('../../../../lib/core/image-diet.js', import.meta.url).href)
let section
imageDietPlugin.apply({ settings: { registerSection(spec) { section = spec; return () => {} } }, effect(fn) { fn() } })
const fields = section.fields()

let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}

check('分区身份：id image-diet、标题走 t(\'section.title\')、order 38', () => {
  assert.equal(section.id, 'image-diet')
  // 标题文案的原文在 locale/ui.zh.json：这里钉「用了哪个键」+「键在字典里」，
  // 不再钉某一句中文——否则一换语言这条断言就替文案做主了。
  assert.match(read('../index.ts'), /title: t\('section\.title'\)/)
  assert.ok(Object.hasOwn(JSON.parse(read('../locale/ui.zh.json')), 'section.title'))
  assert.equal(section.order, 38)
})
check('四个控件：总开关 + 三个数字预算', () => {
  assert.deepEqual(fields.map((field) => field.key), ['enabled', 'userImageBudget', 'toolImageBudget', 'keepRounds'])
  assert.deepEqual(fields.map((field) => field.type), ['switch', 'number', 'number', 'number'])
})
check('数字控件的上下界与 IMAGE_DIET_RANGES 一致', () => {
  for (const field of fields.slice(1)) {
    assert.equal(field.min, core.IMAGE_DIET_RANGES[field.key].min)
    assert.equal(field.max, core.IMAGE_DIET_RANGES[field.key].max)
  }
})
check('默认值：开着，用户图 4 张、工具图 2 张、保留 2 回合；越界值夹回区间', () => {
  assert.deepEqual(core.readImageDietConfig({}), { enabled: true, userImageBudget: 4, toolImageBudget: 2, keepRounds: 2 })
  assert.equal(core.readImageDietConfig({ keepRounds: 999 }).keepRounds, 50)
  assert.equal(core.readImageDietConfig({ userImageBudget: -3 }).userImageBudget, 0)
})
console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
