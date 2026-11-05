/**
 * @pneuma/runtime-adapter 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：适配器要织进整套服务才能跑，这里钉清单、包形态、入口对象（名字沿用内核契约 ui-runtime）与它声明要拿的那些服务面。
 * @module @pneuma/runtime-adapter/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
let passed = 0

const { runtimePlugin } = await import(new URL('../../../../lib/packages/runtime/index.js', import.meta.url).href)

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  assert.ok(patch.includes('id: runtime'))
  assert.ok(patch.includes("name: '@pneuma/runtime-adapter'"))
  passed += 1
})

test('包形态：ESM、两个导出子路径、patch 声明自洽', () => {
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.exports['.'].default)
  assert.ok(pkg.exports['./package.json'])
  if (pkg.pneuma?.library === true) {
    assert.equal(pkg.pneuma?.bundle, undefined)
  } else {
    assert.equal(pkg.pneuma?.bundle?.patch, './cordis.patch.yml')
  }
  passed += 1
})

test('入口：插件对象有名字与 apply', () => {
  // 目录 id 是 runtime、包名末段是 runtime-adapter，但插件对象名沿用内核里既有的契约名
  // 'ui-runtime'（src/packages/runtime/index.ts:29），这里钉的是那个契约名。
  assert.equal(runtimePlugin.name, 'ui-runtime')
  assert.equal(typeof runtimePlugin.apply, 'function')
  passed += 1
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'))
  assert.ok(readme.includes('## Known Limitations'))
  passed += 1
})

test('适配器契约：provide 是 ui，注入面含 tools/mode/presets/permissionPresets', () => {
  assert.equal(runtimePlugin.provide, 'ui')
  for (const dep of ['tools', 'mode', 'presets', 'permissionPresets', 'goal', 'ask', 'plan', 'todo']) {
    assert.ok(runtimePlugin.inject.includes(dep))
  }
  passed += 1
})

after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
