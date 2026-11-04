/**
 * @pneuma/permission-presets 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：这个包的契约就是「provide 一个服务、只调审批与模式已有的 setter」，能便宜测的是清单、包形态、入口对象与它声明的依赖面。
 * @module @pneuma/permission-presets/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
let passed = 0

const { permissionPresetsPlugin } = await import(new URL('../../../../lib/packages/permission-presets/index.js', import.meta.url).href)

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  assert.ok(patch.includes('id: permission-presets'))
  assert.ok(patch.includes("name: '@pneuma/permission-presets'"))
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
  assert.equal(typeof permissionPresetsPlugin.name, 'string')
  assert.ok([pkg.name.split('/').at(-1), 'permission-presets'].includes(permissionPresetsPlugin.name))
  assert.equal(typeof permissionPresetsPlugin.apply, 'function')
  passed += 1
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'))
  assert.ok(readme.includes('## Known Limitations'))
  passed += 1
})

test('服务名：provide 是 permissionPresets，依赖审批/模式/快照那几个面', () => {
  assert.equal(permissionPresetsPlugin.provide, 'permissionPresets')
  for (const dep of ['approval', 'mode', 'surfaces', 'settings', 'session', 'transcript']) {
    assert.ok(permissionPresetsPlugin.inject.includes(dep))
  }
  passed += 1
})

after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
