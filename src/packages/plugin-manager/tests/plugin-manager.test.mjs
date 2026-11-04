/**
 * @pneuma/plugin-manager 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：它只有一颗 plugin_manager 工具、没有可导出的纯函数，能便宜测的是清单、包形态、入口对象与装配声明的两个依赖。
 * @module @pneuma/plugin-manager/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
let passed = 0

const { pluginManagerPlugin } = await import(new URL('../../../../lib/packages/plugin-manager/index.js', import.meta.url).href)

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  assert.ok(patch.includes('id: plugin-manager'))
  assert.ok(patch.includes("name: '@pneuma/plugin-manager'"))
  passed += 1
})

test('包形态：ESM、两个导出子路径、patch 声明自洽', () => {
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.exports['.'])
  assert.ok(pkg.exports['./package.json'])
  if (pkg.pneuma?.library === true) {
    assert.equal(pkg.pneuma?.bundle, undefined)
  } else {
    assert.equal(pkg.pneuma?.bundle?.patch, './cordis.patch.yml')
  }
  passed += 1
})

test('入口：lib 产物里的插件对象有名字与 apply', () => {
  assert.equal(typeof pluginManagerPlugin.name, 'string')
  assert.ok([pkg.name.split('/').at(-1), 'plugin-manager'].includes(pluginManagerPlugin.name))
  assert.equal(typeof pluginManagerPlugin.apply, 'function')
  passed += 1
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'))
  assert.ok(readme.includes('## Known Limitations'))
  passed += 1
})

test('装配面：只依赖 tools 与 commands，自己不 provide', () => {
  assert.deepEqual([...pluginManagerPlugin.inject], ['tools', 'commands'])
  assert.equal(pluginManagerPlugin.provide, undefined)
  passed += 1
})

after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
