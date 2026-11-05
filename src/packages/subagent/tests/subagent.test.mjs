/**
 * @pneuma/subagent 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：入口只有插件对象，派活要会话与模型；能便宜钉住的是装配面、包形态、入口、
 * 文档，以及 agent-roles 里那张不落盘的出厂角色表。
 * @module @pneuma/subagent/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
let passed = 0

const pkg = JSON.parse(read('../package.json'))
const mod = await import('../../../../lib/packages/subagent/index.js')
const roles = await import('../../../../lib/packages/subagent/agent-roles.js')

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/subagent', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /^\s*-\s*id: subagent\s*$/m, '装配行的 id 必须正好是 subagent')
  assert.ok(patch.includes("name: '@pneuma/subagent'"), "装配行的 name 必须是 '@pneuma/subagent'")
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
test('lib 入口能加载，插件名与 apply 对得上', () => {
  assert.equal(typeof mod.subagentPlugin, 'object')
  assert.equal(typeof mod.subagentPlugin.name, 'string')
  assert.equal(mod.subagentPlugin.name, pkg.name.split('/').pop())
  assert.equal(mod.subagentPlugin.name, 'subagent')
  assert.equal(typeof mod.subagentPlugin.apply, 'function')
  passed += 1
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), '缺 ## Model Experience')
  assert.ok(readme.includes('## Known Limitations'), '缺 ## Known Limitations')
  passed += 1
})

// 出厂角色表：四个名字是写死的，explorer 的工牌只能是读类工具、且不许要授权。
test('出厂角色：四个内置角色，explorer 只有读工具且不许要授权', () => {
  assert.deepEqual(roles.builtinRoleNames(), ['critic', 'explorer', 'reviewer', 'writer'])
  const explorer = roles.builtinRole('explorer')
  assert.notEqual(explorer, null)
  assert.equal(explorer.builtin, true)
  assert.deepEqual(explorer.tools, ['read', 'glob', 'grep'])
  assert.equal(explorer.approval, 'forbid')
  assert.equal(roles.builtinRole('no-such-role'), null)
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
