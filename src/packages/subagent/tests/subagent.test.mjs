/**
 * @pneuma/subagent 的包级测试：钉 9 条不变量。
 * 为什么只钉这些：入口只有插件对象，派活要会话与模型；能便宜钉住的是装配面、包形态、入口、
 * 文档、agent-roles 里那张不落盘的出厂角色表，以及 2026-11-06 并入的共享任务板
 * （team_task 工具、板子提示段、设置分区里的 board 子开关）装配面。
 * @module @pneuma/subagent/tests
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
let passed = 0

// 临时 HOME + DSC_HOME：apply 会铺出厂角色、读插件配置，真实 ~/.dsc 一个字节都不许动。
// 必须在 import lib 产物之前设好——DSC_HOME 与 homedir() 都在模块加载时取一次。
const home = mkdtempSync(join(tmpdir(), 'numa-subagent-test-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })

const pkg = JSON.parse(read('../package.json'))
const mod = await import('../../../../lib/packages/subagent/index.js')
const roles = await import('../../../../lib/packages/subagent/agent-roles.js')

// 假 ctx：apply 只用这几个面；effect 真跑回调、把返回的 disposer 收下，
// 否则 syncTools 里的注册根本不会发生，断言无从谈起。
function fakeContext() {
  const captured = { tools: [], sections: undefined, prompts: [], provided: {} }
  const ctx = {
    session: { current: () => ({ meta: { id: 'package-test' } }) },
    tools: {
      register: (entry) => {
        captured.tools.push(entry)
        return () => {}
      },
      list: () => captured.tools,
    },
    prompt: {
      register: (id, render) => {
        captured.prompts.push({ id, render })
        return () => {}
      },
    },
    settings: {
      about: () => ({ home: process.env.DSC_HOME }),
      registerSection: (spec) => {
        captured.sections = spec
        return () => {}
      },
    },
    provide: (name, service) => {
      captured.provided[name] = service
    },
    effect: (execute) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
    transcript: { touch: () => {} },
    llm: {},
    approval: {},
    agent: {},
    get: () => undefined,
  }
  return { ctx, captured }
}

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

// 任务板工具：板子是只读风险的工具，认领/结项/删除这些动作必须在枚举里，否则模型调不动。
test('apply 注册的 team_task 是只读风险，action 枚举覆盖认领与结项', () => {
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const tool = captured.tools.find((entry) => entry.name === 'team_task')
  assert.notEqual(tool, undefined, '板子默认开，必须注册 team_task')
  assert.equal(tool.risk, 'read')
  assert.deepEqual(tool.parameters.required, ['action'])
  const actions = tool.parameters.properties.action.enum
  for (const action of ['create', 'list', 'claim', 'complete', 'delete', 'set_dependencies']) {
    assert.ok(actions.includes(action), 'action 枚举缺 ' + action)
  }
  assert.equal(typeof tool.run, 'function')
  passed += 1
})

// 板子子开关：关掉只撤板子（工具 + 提示段），派活与名册照常。
test('board 关掉后没有 team_task 与板子提示段，subagent 照常', () => {
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx, { board: false })
  assert.equal(captured.tools.some((entry) => entry.name === 'team_task'), false, 'board=false 不该注册 team_task')
  assert.equal(captured.tools.some((entry) => entry.name === 'subagent'), true, 'board=false 不影响派活工具')
  assert.deepEqual(captured.prompts.map((entry) => entry.id), ['subagent'], '只该剩子智能体提示段')
  passed += 1
})

// 反方向也要成立：只要一块共享待办、不要派活时，关掉 allowDelegation 不能把板子带走。
test('allowDelegation 关掉后板子仍在（只想要共享待办的用法）', () => {
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx, { allowDelegation: false })
  assert.equal(captured.tools.some((entry) => entry.name === 'subagent'), false, '派活工具该撤下')
  assert.equal(captured.tools.some((entry) => entry.name === 'team_task'), true, '板子该留着')
  assert.deepEqual(captured.prompts.map((entry) => entry.id), ['team'])
  passed += 1
})

// 合并后的接缝：提示段必须提 team_task（分开时子智能体提示不提板子，模型就不会用），
// 设置分区仍是 subagent，板子字段收在 board 分组里，清空按钮跟着搬过来。
test('提示段提 team_task，设置分区仍是 subagent 且带任务板分组', () => {
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  assert.deepEqual(captured.prompts.map((entry) => entry.id).sort(), ['subagent', 'team'])

  const subagentPrompt = captured.prompts.find((entry) => entry.id === 'subagent').render()
  assert.ok(subagentPrompt.includes('team_task'), '子智能体提示段必须提一句 team_task')
  const boardPrompt = captured.prompts.find((entry) => entry.id === 'team').render()
  assert.ok(boardPrompt.includes('# 共享任务板'), '板子提示段缺标题')

  const section = captured.sections
  assert.equal(section.id, 'subagent')
  assert.deepEqual((section.groups ?? []).map((group) => group.id), ['board'])
  const fields = section.fields()
  const boardField = fields.find((field) => field.key === 'board')
  assert.notEqual(boardField, undefined, '缺 board 子开关')
  assert.equal(boardField.group, 'board')
  assert.equal(fields.some((field) => field.action === 'clear-board'), true, '清空任务板按钮要跟着搬过来')
  assert.equal(section.values().board, true, '板子默认开')
  assert.equal(typeof section.action, 'function')

  // 分组标题中文是「任务板」：design 里点名的那一条，直接读本包的界面字典钉住。
  const zh = JSON.parse(read('../locale/ui.zh.json'))
  assert.equal(zh['group.board.title'], '任务板')
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
