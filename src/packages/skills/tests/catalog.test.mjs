/**
 * skills 包的目录过滤测试：钉住「stale / archived 不进模型可见目录，但仍能被按名字读」。
 *
 * 为什么单独抽一条：过滤逻辑以前写在 buildCatalog 里，只能靠读源码猜它对不对。
 * 现在 `catalogEntries` 是纯函数，直接喂假定义、假停用集合、假档位就能断言四种组合。
 * 注意这条边界：**只过滤目录文本**，`skill` 工具走的是 service.read，不在过滤范围内。
 *
 * 读 lib/ 产物，先 pnpm run build。
 * 用法：node --test "src/packages/skills/tests/*.test.mjs"
 *
 * @module @pneuma/skills/tests/catalog
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const { catalogEntries } = await import(new URL('../../../../lib/packages/skills/index.js', import.meta.url).href)
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
let passed = 0

/** 假定义：只填断言用得到的字段（真实 SkillDefinition 的其余字段与过滤无关）。 */
const definition = (name, modelInvocable = true) => ({ name, description: `${name} 的说明`, modelInvocable })

// 第 1 条：stale 与 archived 不出现在目录里，active 出现，disabled 不出现。
test('catalogEntries：stale / archived 被剔除，active 与「没有档位」留下', () => {
  const definitions = [
    definition('alpha'),
    definition('beta'),
    definition('gamma'),
    definition('omega'),
    definition('silent'),
  ]
  const disabled = new Set(['omega'])
  const lifecycles = new Map([
    ['alpha', 'active'],
    ['beta', 'stale'],
    ['gamma', 'archived'],
    ['omega', 'active'],
  ])
  const names = catalogEntries(definitions, disabled, lifecycles).map((item) => item.name)
  assert.deepEqual(names, ['alpha', 'silent'], `实际 ${names.join('、')}`)
  passed += 1
})

// 第 2 条：没有档位信息（.usage.json 不存在或坏掉）时照旧全部进目录，别把技能全藏了。
test('catalogEntries：档位表为空时，可调用且启用的技能全部保留', () => {
  const definitions = [definition('alpha'), definition('beta'), definition('gamma', false)]
  const names = catalogEntries(definitions, new Set(), new Map()).map((item) => item.name)
  assert.deepEqual(names, ['alpha', 'beta'])
  passed += 1
})

// 第 3 条：只影响目录，不影响按名字读——源码里 buildCatalog 用的是过滤后的清单，
// service.read 仍走 collect()（这一条按源码钉，避免以后有人在 read 上也套一层过滤）。
test('buildCatalog 用 catalogEntries 过滤，service.read 仍走不过滤的 collect()', () => {
  assert.match(source, /catalogEntries\(definitions, disabled, readSkillLifecycles\(\)\)/)
  assert.match(source, /const definition = collect\(\)\.find\(\(item\) => item\.name === name\)/)
  passed += 1
})

// 第 4 条：目录里剩下的条目仍按老规矩渲染（描述截断 + whenToUse），并带 <available_skills> 包裹。
test('目录文本仍然带 <available_skills> 与 whenToUse', () => {
  assert.match(source, /<available_skills>/)
  assert.match(source, /item\.whenToUse === undefined/)
  passed += 1
})

after(() => {
  console.log(`通过 ${String(passed)} 项`)
})