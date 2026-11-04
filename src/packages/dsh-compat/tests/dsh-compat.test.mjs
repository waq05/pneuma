/**
 * @pneuma/dsh-compat 的包级测试：钉 4 条不变量。
 * 为什么只钉这些：这个包是给外部插件补差异的薄壳，对外只有插件对象，四条装配面不变量是它能被便宜验证的全部。
 * @module @pneuma/dsh-compat/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
let passed = 0

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/dsh-compat', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /^\s*-\s*id: dsh-compat\s*$/m, '装配行的 id 必须正好是 dsh-compat')
  assert.ok(patch.includes("name: '@pneuma/dsh-compat'"), "装配行的 name 必须是 '@pneuma/dsh-compat'")
  passed += 1
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.name, '@pneuma/dsh-compat')
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.exports['.'], 'exports 必须有 "."')
  assert.ok(pkg.exports['./package.json'], 'exports 必须有 "./package.json"')
  assert.equal(pkg.pneuma.bundle.patch, './cordis.patch.yml')
  assert.notEqual(pkg.pneuma.library, true, '功能包不该标成库包')
  passed += 1
})

// 入口真能加载：lib 产物已构建，这里直接 import 并检查插件对象的三件事。
test('lib 入口能加载，插件名与 apply 对得上', async () => {
  const pkg = JSON.parse(read('../package.json'))
  const mod = await import('../../../../lib/packages/dsh-compat/index.js')
  const keys = Object.keys(mod).filter((key) => /Plugin$/.test(key))
  assert.equal(keys.length, 1, '入口应当恰好导出一个 *Plugin 对象')
  const plugin = mod[keys[0]]
  assert.equal(typeof plugin, 'object')
  assert.equal(typeof plugin.name, 'string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  assert.equal(plugin.name, pkg.name.slice('@pneuma/'.length))
  assert.equal(plugin.name, 'dsh-compat')
  assert.equal(typeof plugin.apply, 'function')
  passed += 1
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), '缺 ## Model Experience')
  assert.ok(readme.includes('## Known Limitations'), '缺 ## Known Limitations')
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
