/**
 * @pneuma/team 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：看板读写要 ~/.dsc 与会话 id，留在集成探针里；能便宜钉住的是装配面、包形态、
 * 入口、文档，以及 apply 注册的 team_task 工具 schema 与设置分区。
 * @module @pneuma/team/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
let passed = 0

const pkg = JSON.parse(read('../package.json'))
const mod = await import('../../../../lib/packages/team/index.js')

// 假 ctx：apply 只碰这四个面；effect 不执行回调，才能留住注册结果供断言。
function fakeContext() {
  const captured = { tool: undefined, section: undefined, prompts: [] }
  const ctx = {
    session: { current: () => ({ meta: { id: 'package-test' } }) },
    tools: {
      register: (entry) => {
        captured.tool = entry
        return () => {}
      },
    },
    prompt: {
      register: (id) => {
        captured.prompts.push(id)
        return () => {}
      },
    },
    settings: {
      registerSection: (spec) => {
        captured.section = spec
        return () => {}
      },
    },
    effect: () => {},
  }
  return { ctx, captured }
}

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/team', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /^\s*-\s*id: team\s*$/m, '装配行的 id 必须正好是 team')
  assert.ok(patch.includes("name: '@pneuma/team'"), "装配行的 name 必须是 '@pneuma/team'")
  passed += 1
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml（库包则相反）。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.exports['.'], 'exports 必须有 "."')
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
  assert.equal(typeof mod.teamPlugin, 'object')
  assert.equal(typeof mod.teamPlugin.name, 'string')
  assert.equal(mod.teamPlugin.name, pkg.name.split('/').pop())
  assert.equal(mod.teamPlugin.name, 'team')
  assert.equal(typeof mod.teamPlugin.apply, 'function')
  passed += 1
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), '缺 ## Model Experience')
  assert.ok(readme.includes('## Known Limitations'), '缺 ## Known Limitations')
  passed += 1
})

// 工具 schema：看板是只读风险的工具，认领/结项/删除这些动作必须在枚举里，否则模型调不动。
test('apply 注册的 team_task 是只读风险，action 枚举覆盖认领与结项', () => {
  const { ctx, captured } = fakeContext()
  mod.teamPlugin.apply(ctx)
  const tool = captured.tool
  assert.equal(tool.name, 'team_task')
  assert.equal(tool.risk, 'read')
  assert.deepEqual(tool.parameters.required, ['action'])
  const actions = tool.parameters.properties.action.enum
  for (const action of ['create', 'list', 'claim', 'complete', 'delete', 'set_dependencies']) {
    assert.ok(actions.includes(action), 'action 枚举缺 ' + action)
  }
  assert.equal(typeof tool.run, 'function')
  passed += 1
})

// 提示与设置：看板摘要挂在 prompt 的 team 段上，设置分区 id 也必须是 team。
test('prompt 段与设置分区都叫 team', () => {
  const { ctx, captured } = fakeContext()
  mod.teamPlugin.apply(ctx)
  assert.deepEqual(captured.prompts, ['team'])
  assert.equal(captured.section.id, 'team')
  assert.equal(typeof captured.section.action, 'function')
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
