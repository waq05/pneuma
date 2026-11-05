/**
 * @pneuma/tools 的包级测试：钉 7 条不变量。
 * 为什么只钉这些：这是纯内存注册表，服务本身就能整套便宜地验，不需要会话、模型或磁盘。
 * @module @pneuma/tools/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
let passed = 0

const pkg = JSON.parse(read('../package.json'))
const mod = await import('../../../../lib/packages/tools/index.js')

// 假 ctx：这个插件只做一件事——provide 出 tools 服务。
function makeService() {
  let service
  mod.toolsPlugin.apply({ provide: (_name, value) => { service = value } })
  assert.equal(typeof service, 'object', 'apply 必须 provide 出 tools 服务')
  return service
}

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/tools', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /^\s*-\s*id: tools\s*$/m, '装配行的 id 必须正好是 tools')
  assert.ok(patch.includes("name: '@pneuma/tools'"), "装配行的 name 必须是 '@pneuma/tools'")
  passed += 1
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml（库包则相反）。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.exports['.'].default, 'exports 必须有 "."')
  assert.ok(pkg.exports['./package.json'], 'exports 必须有 "./package.json"')
  if (pkg.pneuma.library === true) {
    assert.equal(pkg.pneuma.bundle, undefined, '库包不该有 bundle.patch')
  } else {
    assert.equal(pkg.pneuma.bundle.patch, './cordis.patch.yml')
  }
  passed += 1
})

// 入口真能加载：lib 产物已构建，这里直接 import 并检查插件对象的三件事。
test('lib 入口能加载，插件名、provide 与 apply 对得上', () => {
  assert.equal(typeof mod.toolsPlugin, 'object')
  assert.equal(typeof mod.toolsPlugin.name, 'string')
  assert.equal(mod.toolsPlugin.name, pkg.name.split('/').pop())
  assert.equal(mod.toolsPlugin.name, 'tools')
  assert.equal(mod.toolsPlugin.provide, 'tools')
  assert.equal(typeof mod.toolsPlugin.apply, 'function')
  passed += 1
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), '缺 ## Model Experience')
  assert.ok(readme.includes('## Known Limitations'), '缺 ## Known Limitations')
  passed += 1
})

// 注册表：注册后进 list，注销只删自己那一条，别人同名的条目不该被误删。
test('tools 服务：注册进表，注销的是自己那一条', () => {
  const service = makeService()
  const first = { name: 'demo', run: () => 'first' }
  const offFirst = service.register(first)
  assert.deepEqual(service.list().map((entry) => entry.name), ['demo'])
  const second = { name: 'demo', run: () => 'second' }
  service.register(second)
  assert.deepEqual(service.list().map((entry) => entry.run()), ['second'])
  offFirst()
  assert.deepEqual(service.list().map((entry) => entry.run()), ['second'], '旧条目的注销不该删掉新条目')
  passed += 1
})

// 形状关：dsh 风格定义（有 execute 没 run）必须当场拦下并指路兼容层，不能等模型调用时才炸。
test('注册表拦下 dsh 风格定义并指点兼容层，也拦下空名与缺 run', () => {
  const service = makeService()
  assert.throws(() => service.register({ name: 'bad', execute: () => {} }), /dsh 风格/)
  assert.throws(() => service.register({ name: '', run: () => {} }), /非空的 name/)
  assert.throws(() => service.register({ name: 'noRun' }), /缺 run 函数/)
  passed += 1
})

// 目录投影：只做减法、按注册顺序叠加；一个投影崩了就跳过它，别让整轮请求失败。
test('visible 只做减法，崩掉的投影跳过而不是整轮失败', () => {
  const service = makeService()
  service.register({ name: 'a', run: () => '' })
  service.register({ name: 'b', run: () => '' })
  const off = service.project('only-a', (list) => list.filter((entry) => entry.name === 'a'))
  assert.deepEqual(service.visible().map((entry) => entry.name), ['a'])
  off()
  assert.deepEqual(service.visible().map((entry) => entry.name).sort(), ['a', 'b'])
  const offBad = service.project('boom', () => { throw new Error('boom') })
  const originalError = console.error
  console.error = () => {}
  try {
    assert.deepEqual(service.visible().map((entry) => entry.name).sort(), ['a', 'b'], '崩掉的投影应被跳过，目录保持原样')
  } finally {
    console.error = originalError
    offBad()
  }
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
