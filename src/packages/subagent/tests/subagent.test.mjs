/**
 * @pneuma/subagent 的包级测试：钉住这个包自己的不变量。
 * 为什么只钉这些：入口只有插件对象，派活要会话与模型；能便宜钉住的是装配面、包形态、入口、
 * 文档、agent-roles 里那张不落盘的出厂角色表、2026-11 起的轮次预算（角色文件 > 设置页按
 * 角色 > 全局上限，以及旧安装的角色文件迁移）、模型授权（开关 + 授权清单 + spawn 的
 * model/effort 校验与优先级）、T3 团队协作（任务板进展/活动/绑定、队友互发消息、
 * 提示词摘要、角色扩充、团队模式），以及 2026-11-06 并入的共享任务板工具装配面。
 * @module @pneuma/subagent/tests
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
// 任务板 v2（进展/活动/绑定）是内核模块，包测试直接钉它的数据面（T3a）
const boardMod = await import('../../../../lib/core/team-board.js')

// 假 ctx：apply 只用这几个面；effect 真跑回调、把返回的 disposer 收下，
// 否则 syncTools 里的注册根本不会发生，断言无从谈起。
function fakeContext() {
  const captured = { tools: [], sections: undefined, prompts: [], projections: [], provided: {} }
  const ctx = {
    session: { current: () => ({ meta: { id: 'package-test' } }) },
    // 宿主事件口：写名册/任务板会推 dsc/changed，本文件不钉推送次数，给空实现占位。
    emit: () => undefined,
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
      // 看板快照这类易变段走投影：注册项收下来，用例直接调它钉注入行为
      registerProjection: (id, apply, options) => {
        captured.projections.push({ id, apply, options })
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
    // 模型面：设置分区的授权清单读 listModels()，spawn 校验读 parseModelRef()。
    // 路由用不到（本文件不真派活），给空实现占位。
    llm: {
      model: 'current-model',
      listModels: () => [
        {
          value: 'alpha/m1',
          provider: 'alpha',
          providerDisplayName: 'Alpha',
          model: 'm1',
          description: 'Alpha · 32k 上下文',
          contextWindow: 32000,
          thinkingLevels: [],
          modalities: ['text'],
        },
        {
          value: 'alpha/m2',
          provider: 'alpha',
          providerDisplayName: 'Alpha',
          model: 'm2',
          description: 'Alpha · 64k 上下文',
          contextWindow: 64000,
          thinkingLevels: [],
          modalities: ['text'],
        },
        {
          value: 'beta/m3',
          provider: 'beta',
          providerDisplayName: 'Beta',
          model: 'm3',
          description: 'Beta · 128k 上下文',
          contextWindow: 128000,
          thinkingLevels: [],
          modalities: ['text'],
        },
      ],
      // 与真实现同口径的简化版：带已知端点前缀就切，否则整串当当前端点的模型名
      parseModelRef: (ref) => {
        for (const provider of ['alpha', 'beta']) {
          if (ref.startsWith(`${provider}/`)) return { provider, model: ref.slice(provider.length + 1) }
        }
        return { provider: 'current', model: ref }
      },
      providerOf: () => 'current',
      modelOf: () => 'current-model',
      routeTo: () => ({}),
      routeForSession: () => ({}),
    },
    approval: {},
    // 队友的会话归属解析登记在 `guards` 上（P0-8 收口）：假 ctx 也要给这两个口，
    // 否则 apply 里 `ctx.guards.registerSessionResolver` 直接抛，整条装配测不起来。
    guards: {
      register: () => () => {},
      registerSessionResolver: () => () => {},
      gate: () => ({ action: 'defer' }),
      observe: () => {},
    },
    // 内核会话表：默认查不到任何会话（`subagent` 工具查不到父会话就报错，见 G6 那条用例）。
    agent: { sessionById: () => undefined },
    get: () => undefined,
  }
  return { ctx, captured }
}

/** 直接把配置写进临时 DSC_HOME 的 plugins.json（模拟「重启后读盘」与设定初始开关）。 */
function writeSubagentConfig(config) {
  const file = join(process.env.DSC_HOME, 'plugins.json')
  let doc = { version: 1, entries: [] }
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // 还没有这份文件：从空条目树开始
  }
  if (!Array.isArray(doc.entries)) doc.entries = []
  const entry = doc.entries.find((item) => item.file === 'subagent')
  if (entry === undefined) doc.entries.push({ file: 'subagent', disabled: false, config: { ...config } })
  else entry.config = { ...(entry.config ?? {}), ...config }
  writeFileSync(file, JSON.stringify(doc), 'utf8')
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
  assert.deepEqual(roles.builtinRoleNames(), [
    'architect',
    'critic',
    'developer',
    'explorer',
    'ops',
    'pm',
    'reviewer',
    'tester',
    'writer',
  ])
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
  assert.deepEqual((section.groups ?? []).map((group) => group.id), ['turns', 'models', 'board'])
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

// 协作工具豁免：只读角色（explorer 的工牌只有 read/glob/grep）也要能认领任务，
// 所以 team_task 必须走这份豁免表，而不是挤进每个角色的 tools 白名单。
test('协作工具豁免表包含 team_task，且不夹带文件类工具', () => {
  assert.ok(mod.COLLAB_TOOL_NAMES.includes('team_task'), 'team_task 必须在协作工具豁免表里')
  assert.ok(mod.COLLAB_TOOL_NAMES.includes('team_message'), 'team_message 必须在协作工具豁免表里')
  for (const name of ['read', 'write', 'edit', 'bash', 'glob', 'grep']) {
    assert.equal(mod.COLLAB_TOOL_NAMES.includes(name), false, `${name} 不该进协作工具豁免表`)
  }
  passed += 1
})

// 一次性小工（对照 dsh 的 one-shot）：spawn 要有一个开关，模型才选得出来。
// keep 缺省 = 留用（寻常队友），所以它不能进 required，否则每次派活都得表态。
test('subagent 工具有 keep 开关，缺省留用，描述里讲清一次性是什么', () => {
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const tool = captured.tools.find((entry) => entry.name === 'subagent')
  assert.notEqual(tool, undefined, '派活工具默认开')
  const keep = tool.parameters.properties.keep
  assert.notEqual(keep, undefined, 'spawn 要能选一次性（keep 参数）')
  assert.equal(keep.type, 'boolean')
  assert.ok(keep.description.includes('一次性'), 'keep 的描述要说出「一次性」三个字')
  assert.equal((tool.parameters.required ?? []).includes('keep'), false, 'keep 不填默认留用，不能必填')
  assert.ok(tool.description.includes('一次性'), '工具描述要讲清 keep=false 的后果')
  passed += 1
})

// G6：superagent 的 worker 会话是执行器自己造的，不经常驻 agent 名册。它调这个工具时
// 父会话必须查得到（内核 `ctx.agent.attach` 登记过）；查不到要报错，**不能**回落
// `ctx.session.current()`——那会把队友派到用户正看着的会话名下，名册、额度、任务板
// 全落到错的那条会话上。
test('subagent 工具：父会话查不到就报错，查得到就按那条会话干活', async () => {
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const tool = captured.tools.find((entry) => entry.name === 'subagent')
  const runCtx = {
    cwd: process.cwd(),
    sessionId: 'worker-t1',
    sessionPath: join(home, 'nowhere.jsonl'),
    signal: new AbortController().signal,
  }
  // 查不到：同步报错（不是 rejected promise），错误里点明「不在内核的会话表里」与怎么补。
  assert.throws(() => tool.run({ action: 'list' }, runCtx), /不在内核的会话表里/)
  // 查得到：按那条会话报名单（假会话没有队友，所以是空名单 + 角色表）。
  ctx.agent.sessionById = (sessionId) => (sessionId === 'worker-t1' ? { meta: { id: 'worker-t1' } } : undefined)
  const listed = await tool.run({ action: 'list' }, runCtx)
  assert.match(listed, /本会话没有在队或收工的队友/, '查得到就按那条会话报名单')
  passed += 1
})

// 出厂角色模板不再钉死轮次：默认值放设置页的 roleTurns，否则文件里的显式值会永远压过
// 设置页——那样「默认最大轮次」这一项对内置角色就是个摆设。
test('出厂角色模板不写 max-turns，默认轮次交给设置页的 roleTurns', () => {
  for (const name of ['critic', 'reviewer', 'writer', 'explorer']) {
    const role = roles.builtinRole(name)
    assert.notEqual(role, null, `内置角色 ${name} 缺失`)
    assert.equal(role.maxTurnsDeclared, false, `${name} 的出厂模板不该再钉 max-turns`)
    assert.equal(role.maxTurns, 0, `${name} 未声明时解析结果应为 0（不设限）`)
  }
  passed += 1
})

// 三档优先级：角色文件显式 max-turns > 设置页按角色 roleTurns > 全局上限。
// 显式写 0 也算显式（= 不限），要压过设置页；但全局设了上限仍取更严。
test('轮次预算三档优先级：角色文件 > 设置页按角色 > 全局上限', () => {
  const defaults = { critic: 16, reviewer: 64, writer: 128, explorer: 0 }
  const declared = { name: 'critic', maxTurns: 9, maxTurnsDeclared: true }
  assert.equal(mod.resolveMaxTurns(declared, defaults, 0), 9, '角色文件显式值优先')
  assert.equal(mod.resolveMaxTurns(declared, defaults, 5), 5, '全局上限更小时取全局')
  assert.equal(mod.resolveMaxTurns(declared, defaults, 50), 9, '全局上限更大时仍用角色值')

  const inherited = { name: 'writer', maxTurns: 0, maxTurnsDeclared: false }
  assert.equal(mod.resolveMaxTurns(inherited, defaults, 0), 128, '没写就用设置页该角色的值')
  assert.equal(mod.resolveMaxTurns({ ...inherited, name: 'explorer' }, defaults, 0), 0, 'explorer 默认不限')
  assert.equal(mod.resolveMaxTurns({ ...inherited, name: 'custom-role' }, defaults, 0), 0, '没配过的角色按不限')

  const explicitZero = { name: 'critic', maxTurns: 0, maxTurnsDeclared: true }
  assert.equal(mod.resolveMaxTurns(explicitZero, defaults, 0), 0, '显式写 0 = 不限，压过设置页')
  assert.equal(mod.resolveMaxTurns(explicitZero, defaults, 30), 30, '但全局上限照旧取更严')
  passed += 1
})

// 设置页：一个「默认最大轮次」分组，四个内置角色各一个 0..200 的数字项，
// 默认值 critic 16 / reviewer 64 / writer 128 / explorer 0（不限）。
test('设置分区有「默认最大轮次」分组，按角色给 0..200 的数字项与出厂默认值', () => {
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const section = captured.sections
  const zh = JSON.parse(read('../locale/ui.zh.json'))
  assert.deepEqual((section.groups ?? []).map((group) => group.id), ['turns', 'models', 'board'])
  const turnsGroup = section.groups[0]
  assert.equal(turnsGroup.title, zh['group.turns.title'], '分组标题走字典，中文原文是「默认最大轮次」')
  assert.equal(turnsGroup.description, zh['group.turns.description'])

  const fields = section.fields()
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const values = section.values()
  for (const [role, turns] of [['critic', 16], ['reviewer', 64], ['writer', 128], ['explorer', 0]]) {
    const field = byKey.get(`roleTurns.${role}`)
    assert.notEqual(field, undefined, `缺 roleTurns.${role} 数字项`)
    assert.equal(field.type, 'number')
    assert.equal(field.min, 0)
    assert.equal(field.max, 200)
    assert.equal(field.step, 1)
    assert.equal(field.group, 'turns')
    assert.ok(field.label.includes(role), `label 要点名角色：${field.label}`)
    assert.equal(values[`roleTurns.${role}`], turns, `${role} 的出厂默认值`)
  }
  passed += 1
})

// 保存链路：点号键 roleTurns.<角色> 整块写进 plugins.json 的 subagent.config.roleTurns，
// 改一个角色不动别的；越界或未知角色当场拒。
test('保存 roleTurns.<角色> 落到 plugins.json，改一个不动其他', () => {
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const section = captured.sections
  assert.equal(section.save('roleTurns.writer', 200), undefined, '保存成功应返回 void')
  const file = join(process.env.DSC_HOME, 'plugins.json')
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const entry = doc.entries.find((item) => item.file === 'subagent')
  assert.notEqual(entry, undefined, 'plugins.json 里应有 subagent 条目')
  assert.equal(entry.config.roleTurns.writer, 200)
  assert.equal(entry.config.roleTurns.critic, 16, 'roleTurns 整块写入时其余角色保留默认值')
  assert.equal(section.values()['roleTurns.writer'], 200, '保存后分区值立刻反映新值')
  assert.equal(section.values()['roleTurns.critic'], 16, '改一个角色不该动其他角色')

  const bad = section.save('roleTurns.critic', 999)
  assert.equal(typeof bad, 'string', '越界值要返回失败原因')
  assert.equal(section.values()['roleTurns.critic'], 16, '保存失败不改值')
  assert.equal(typeof section.save('roleTurns.nobody', 5), 'string', '未知角色要拒绝')
  passed += 1
})

// 重启后从磁盘读回：配置里缺的角色补出厂默认，不是整份丢失。
test('从 plugins.json 读回各角色轮次，配置里缺的角色补出厂默认', () => {
  const file = join(process.env.DSC_HOME, 'plugins.json')
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const entry = doc.entries.find((item) => item.file === 'subagent')
  entry.config.roleTurns = { critic: 33, explorer: 5 }
  writeFileSync(file, JSON.stringify(doc), 'utf8')

  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const values = captured.sections.values()
  assert.equal(values['roleTurns.critic'], 33, '磁盘上的值要读回')
  assert.equal(values['roleTurns.explorer'], 5, '不限的角色也可以配上限')
  assert.equal(values['roleTurns.writer'], 128, '配置里缺的角色补出厂默认')
  assert.equal(values['roleTurns.reviewer'], 64, '配置里缺的角色补出厂默认')
  passed += 1
})

// 旧安装迁移：只在 max-turns 仍等于旧出厂默认（critic 4 / reviewer 16 / writer 20）时删掉
// 那一行；用户改过的值保留；只动内置角色的 .md；幂等。
test('迁移旧角色文件：等于旧出厂默认的 max-turns 删掉，改过的保留且幂等', () => {
  const dir = roles.DSC_AGENTS_DIR
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'critic.md'), '---\nname: critic\ndescription: 反驳\ntools: read\nmax-turns: 4\n---\n\n正文\n', 'utf8')
  writeFileSync(join(dir, 'reviewer.md'), '---\nname: reviewer\nmax-turns: 16\n---\n正文\n', 'utf8')
  writeFileSync(join(dir, 'writer.md'), '---\nname: writer\nmax-turns: 99\n---\n正文\n', 'utf8')
  writeFileSync(join(dir, 'my-role.md'), '---\nname: my-role\nmax-turns: 4\n---\n正文\n', 'utf8')

  assert.deepEqual(roles.migrateBuiltinRoleMaxTurns().sort(), ['critic', 'reviewer'], '只迁等于旧默认的内置角色')
  const criticText = readFileSync(join(dir, 'critic.md'), 'utf8')
  assert.equal(criticText.includes('max-turns'), false, '旧默认那一行要删掉')
  assert.equal(criticText.includes('tools: read'), true, '其他 frontmatter 原样保留')
  assert.equal(criticText.includes('正文'), true, '正文原样保留')
  assert.equal(readFileSync(join(dir, 'writer.md'), 'utf8').includes('max-turns: 99'), true, '用户改过的值保留')
  assert.equal(readFileSync(join(dir, 'my-role.md'), 'utf8').includes('max-turns: 4'), true, '非内置角色不碰')

  const critic = roles.readRole(join(dir, 'critic.md'))
  assert.equal(critic.maxTurnsDeclared, false, '迁移后不再算显式声明，回落设置页默认值')
  assert.deepEqual(critic.tools, ['read'])
  assert.equal(critic.prompt, '正文')

  assert.deepEqual(roles.migrateBuiltinRoleMaxTurns(), [], '第二次跑不该再改任何文件')
  passed += 1
})

// 迁移挂在 apply 上：插件一启动就把旧安装的出厂角色文件挪到「用设置页默认值」的状态。
test('apply 启动时自动迁移旧出厂角色文件', () => {
  writeFileSync(join(roles.DSC_AGENTS_DIR, 'critic.md'), '---\nname: critic\nmax-turns: 4\n---\n正文\n', 'utf8')
  const { ctx } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  assert.equal(readFileSync(join(roles.DSC_AGENTS_DIR, 'critic.md'), 'utf8').includes('max-turns'), false)
  passed += 1
})

// ── T2b：队友模型授权（开关 + 授权清单 + spawn 的 model/effort）────────────────

// 配置读取：allowedModels 只收非空字符串，去重、保序；坏类型整份当没配。
test('allowedModels 读取：去空、去重、非字符串丢弃', () => {
  assert.deepEqual(mod.readAllowedModels(['alpha/m1', ' alpha/m1 ', '', 3, null, 'beta/m3']), ['alpha/m1', 'beta/m3'])
  assert.deepEqual(mod.readAllowedModels('alpha/m1'), [])
  assert.deepEqual(mod.readAllowedModels(undefined), [])
  passed += 1
})

// 设置分区：旧的「队友默认模型」文本框撤掉，换成开关 + 按端点分组的授权模型多选。
test('设置分区：默认模型文本框换成开关 + 授权模型分组多选', () => {
  writeSubagentConfig({ allowModelSelection: false, allowedModels: [] })
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const section = captured.sections
  assert.deepEqual((section.groups ?? []).map((group) => group.id), ['turns', 'models', 'board'])
  const zh = JSON.parse(read('../locale/ui.zh.json'))
  assert.equal(section.groups[1].title, zh['group.models.title'], '分组标题走字典')
  assert.equal(section.groups[1].description, zh['group.models.description'])

  const fields = section.fields()
  assert.equal(fields.some((field) => field.key === 'defaultModel'), false, '旧的默认模型文本框要撤掉')
  const toggle = fields.find((field) => field.key === 'allowModelSelection')
  assert.notEqual(toggle, undefined, '缺 allowModelSelection 开关')
  assert.equal(toggle.type, 'switch')
  assert.equal(toggle.group, 'models')
  const checks = fields.find((field) => field.key === 'allowedModels')
  assert.notEqual(checks, undefined, '缺 allowedModels 多选')
  assert.equal(checks.type, 'checks')
  assert.equal(checks.group, 'models')
  assert.deepEqual(checks.groups.map((group) => group.title), ['Alpha', 'Beta'], '按端点显示名分组')
  assert.deepEqual(checks.groups[0].options.map((option) => option.value), ['alpha/m1', 'alpha/m2'])
  assert.equal(checks.groups[1].options[0].value, 'beta/m3')
  assert.equal(checks.groups[1].options[0].label, 'm3', '选项标题是模型名')
  assert.ok(checks.groups[0].options[0].detail.includes('32k'), '副说明用 listModels 的 description')
  passed += 1
})

// 保存语义：开关开着却一个模型都没勾 = 不可保存（两个方向都拦），落盘是扁平值数组。
test('模型授权保存：开关开但清单为空时拒绝，落盘进 plugins.json', () => {
  writeSubagentConfig({ allowModelSelection: false, allowedModels: [] })
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const section = captured.sections
  assert.equal(section.values().allowModelSelection, false, '默认关闭')
  assert.deepEqual(section.values().allowedModels, [], '默认一个都不授权')

  assert.equal(typeof section.save('allowModelSelection', true), 'string', '没勾模型不能开启开关')
  assert.equal(section.values().allowModelSelection, false, '保存失败不落盘')

  assert.equal(section.save('allowedModels', ['alpha/m1', 'beta/m3']), undefined)
  assert.deepEqual(section.values().allowedModels, ['alpha/m1', 'beta/m3'])
  assert.equal(section.save('allowModelSelection', true), undefined)
  assert.equal(section.values().allowModelSelection, true)

  assert.equal(typeof section.save('allowedModels', []), 'string', '开关开着时不能清空清单')
  assert.deepEqual(section.values().allowedModels, ['alpha/m1', 'beta/m3'], '拒绝后原值不动')

  const doc = JSON.parse(readFileSync(join(process.env.DSC_HOME, 'plugins.json'), 'utf8'))
  const entry = doc.entries.find((item) => item.file === 'subagent')
  assert.equal(entry.config.allowModelSelection, true)
  assert.deepEqual(entry.config.allowedModels, ['alpha/m1', 'beta/m3'])
  passed += 1
})

// spawn 覆盖值校验：开关、授权清单、effort 取值，全是纯函数，好钉。
test('spawn 覆盖值校验：开关关闭/不在清单/清单为空都拒，命中则归一成 provider/model', () => {
  const parse = (ref) => {
    for (const provider of ['alpha', 'beta']) {
      if (ref.startsWith(`${provider}/`)) return { provider, model: ref.slice(provider.length + 1) }
    }
    return { provider: 'current', model: ref }
  }
  const off = mod.resolveSpawnOverrides('alpha/m1', undefined, { allow: false, allowed: ['alpha/m1'] }, parse)
  assert.equal(off.ok, false, '开关关闭时带 model 必须拒')
  assert.match(off.reason, /允许 Agent 为子队友选择模型/, '要告诉模型去设置里打开')

  const denied = mod.resolveSpawnOverrides('alpha/m2', undefined, { allow: true, allowed: ['alpha/m1'] }, parse)
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /不在用户授权的清单里/)
  assert.ok(denied.reason.includes('alpha/m1'), '拒绝时要列出可选项')

  assert.deepEqual(
    mod.resolveSpawnOverrides('alpha/m1', 'high', { allow: true, allowed: ['alpha/m1'] }, parse),
    { ok: true, model: 'alpha/m1', effort: 'high' },
    '命中清单：归一成 provider/model',
  )
  assert.deepEqual(
    mod.resolveSpawnOverrides('m1', undefined, { allow: true, allowed: ['current/m1'] }, parse),
    { ok: true, model: 'current/m1', effort: null },
    '裸模型名补当前端点前缀再比对',
  )

  const none = mod.resolveSpawnOverrides('alpha/m1', undefined, { allow: true, allowed: [] }, parse)
  assert.equal(none.ok, false)
  assert.match(none.reason, /一个都没授权/)

  const badEffort = mod.resolveSpawnOverrides(undefined, 'maxx', { allow: false, allowed: [] }, parse)
  assert.equal(badEffort.ok, false)
  assert.match(badEffort.reason, /不认识的 effort/)

  assert.deepEqual(
    mod.resolveSpawnOverrides(undefined, undefined, { allow: false, allowed: [] }, parse),
    { ok: true, model: null, effort: null },
    '不传 = 不覆盖',
  )
  passed += 1
})

// 优先级：spawn 显式 > 角色文件 > 旧配置 defaultModel > 跟随会话；effort 没有旧配置那一档。
test('模型/思考强度优先级：spawn > 角色文件 > 旧 defaultModel > 跟随会话', () => {
  const role = { model: 'alpha/role', effort: 'low' }
  assert.equal(mod.resolveTeammateModel('beta/spawn', role, 'current/old'), 'beta/spawn')
  assert.equal(mod.resolveTeammateModel(null, role, 'current/old'), 'alpha/role')
  assert.equal(mod.resolveTeammateModel(null, { model: null }, 'current/old'), 'current/old', '旧配置做兼容兜底')
  assert.equal(mod.resolveTeammateModel(null, { model: null }, ''), null, '都没有 = 跟随当前会话')
  assert.equal(mod.resolveTeammateEffort('high', role), 'high')
  assert.equal(mod.resolveTeammateEffort(null, role), 'low')
  assert.equal(mod.resolveTeammateEffort(null, { effort: null }), null)
  passed += 1
})

// 工具面：schema 上有 model/effort，开关关闭时真调 spawn 会被明确拒绝（不会真派出去）。
test('spawn 工具带 model/effort 参数，开关关闭时带 model 被拒', async () => {
  writeSubagentConfig({ allowModelSelection: false, allowedModels: [] })
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const tool = captured.tools.find((entry) => entry.name === 'subagent')
  assert.notEqual(tool, undefined)
  assert.equal(tool.parameters.properties.model.type, 'string')
  assert.deepEqual(tool.parameters.properties.effort.enum, ['default', 'off', 'low', 'high', 'max'])
  assert.ok(tool.description.includes('允许 Agent 为子队友选择模型'), '工具描述要点出这个开关')

  ctx.agent.sessionById = (sessionId) => ({ meta: { id: sessionId } })
  const runCtx = {
    cwd: process.cwd(),
    sessionId: 't2b-session',
    sessionPath: join(home, 't2b-session.jsonl'),
    signal: new AbortController().signal,
  }
  const out = await tool.run({ action: 'spawn', role: 'writer', task: '把 x 改成 y，并补一条测试', model: 'alpha/m1' }, runCtx)
  assert.match(out, /允许 Agent 为子队友选择模型/, '开关关闭时给出明确拒绝原因')
  passed += 1
})

// 提示词：开着时名册提示写出授权清单（且只写清单内的），关着时明说不能指定。
test('提示词：授权清单只写清单内的模型，关闭时明说不能指定', () => {
  writeSubagentConfig({ allowModelSelection: true, allowedModels: ['alpha/m1'] })
  let { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  let prompt = captured.prompts.find((entry) => entry.id === 'subagent').render()
  assert.ok(prompt.includes('alpha/m1'), '授权清单要写进名册提示')
  assert.ok(prompt.includes('只影响之后新建的队友'))
  assert.equal(prompt.includes('alpha/m2'), false, '未授权的模型不该出现在提示里')
  assert.equal(prompt.includes('beta/m3'), false, '未授权的端点也不该出现')

  writeSubagentConfig({ allowModelSelection: false })
  ;({ ctx, captured } = fakeContext())
  mod.subagentPlugin.apply(ctx)
  prompt = captured.prompts.find((entry) => entry.id === 'subagent').render()
  assert.ok(prompt.includes('不能指定模型'), '关闭时要明说不能指定')
  passed += 1
})

// 队友系统提示的模型句：冻结值与「仅影响新队友」；授权清单不往队友提示里写。
test('队友系统提示的模型句：写冻结值与仅影响新队友，不列授权清单', () => {
  const text = mod.teammateModelNote('alpha/m1', 'high', true)
  assert.ok(text.includes('alpha/m1'))
  assert.ok(text.includes('high'))
  assert.ok(text.includes('只影响之后新建的队友'))
  assert.ok(text.includes('只能从用户授权的模型清单里挑'))

  const following = mod.teammateModelNote('current-model', null, false)
  assert.ok(following.includes('思考强度跟随默认'))
  assert.ok(following.includes('不能指定模型'))
  passed += 1
})

// ── T3a：任务板 v2（进展/活动/绑定）＋ 队友互通 ＋ 角色扩充 ──────────────────

// 老文件兼容：缺 notes/activity/blockedReason/assignee 的板子照常读，补默认值、不报错。
test('team-board：老文件缺新字段时补默认值（向后兼容）', () => {
  const sid = 'legacy-board-session'
  const file = boardMod.boardFile(sid)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      revision: 3,
      tasks: [{ id: 't1', subject: '旧任务', status: 'pending', owner: null, blockedBy: [], writeScopes: [] }],
    }),
    'utf8',
  )
  const board = boardMod.readBoard(sid)
  assert.equal(board.revision, 3, '老 revision 原样保留')
  assert.deepEqual(board.activity, [], '缺 activity 补空数组')
  assert.deepEqual(board.tasks[0].notes, [], '缺 notes 补空数组')
  assert.equal(board.tasks[0].blockedReason, null)
  assert.equal(board.tasks[0].assignee, null)
  passed += 1
})

// 数据面全流程：create → claim（带绑定）→ note → block → unblock → assign → complete，
// 每步都写活动、都走 CAS；最后投影出 latestNote/noteCount/活动。
test('team-board：进展/阻塞/绑定/活动全流程与 CAS', () => {
  const sid = 'board-lifecycle'
  rmSync(boardMod.boardFile(sid), { force: true })
  const created = boardMod.boardCreate(sid, { subject: '实现登录', writeScopes: ['src/auth'], actor: 'lead' })
  assert.equal(created.task.id, 't1')
  assert.equal(created.board.revision, 1)
  assert.deepEqual(created.board.activity.map((entry) => entry.kind), ['create'])

  // CAS：拿过期版本改一定被拒
  assert.throws(() => boardMod.boardUpdate(sid, 't1', 0, 'claim', { owner: 'dev-1' }), /第 0 版/)

  let result = boardMod.boardUpdate(sid, 't1', created.board.revision, 'claim', {
    owner: 'dev-1',
    assignee: 'dev-1',
    by: 'dev-1',
  })
  assert.equal(result.task.status, 'in_progress')
  assert.equal(result.task.owner, 'dev-1')
  assert.equal(result.task.assignee, 'dev-1', 'spawn 绑定与认领一次 CAS 做完')
  assert.equal(result.board.activity[0].kind, 'claim')

  result = boardMod.boardUpdate(sid, 't1', result.board.revision, 'note', { text: '读完 auth 模块，开始改 login', by: 'dev-1' })
  assert.equal(result.task.notes.length, 1)
  assert.equal(result.task.notes[0].by, 'dev-1')
  assert.equal(result.board.activity[0].kind, 'note')

  result = boardMod.boardUpdate(sid, 't1', result.board.revision, 'block', { text: '等待接口契约', by: 'dev-1' })
  assert.equal(result.task.blockedReason, '等待接口契约')
  assert.equal(result.task.notes[0].text, '[卡住] 等待接口契约', '卡住也留一条进展（历史可追溯）')

  result = boardMod.boardUpdate(sid, 't1', result.board.revision, 'unblock', { text: '契约已定', by: 'lead' })
  assert.equal(result.task.blockedReason, null)
  assert.equal(result.task.notes[0].text, '[解除] 契约已定')

  result = boardMod.boardUpdate(sid, 't1', result.board.revision, 'assign', { assignee: 'dev-2', by: 'lead' })
  assert.equal(result.task.assignee, 'dev-2')
  assert.equal(result.board.activity[0].kind, 'claim', '指派记成 claim 类活动')

  result = boardMod.boardUpdate(sid, 't1', result.board.revision, 'complete', { text: '已实现并自测通过', by: 'dev-2' })
  assert.equal(result.task.status, 'completed')
  assert.equal(result.task.notes[0].text, '已实现并自测通过', 'complete 的正文作为终稿摘要进 notes')
  assert.deepEqual(result.board.activity[0].kind, 'complete')

  const view = boardMod.boardViewOf(result.board)
  assert.equal(view.tasks[0].latestNote.text, '已实现并自测通过')
  assert.equal(view.tasks[0].noteCount, 4)
  assert.equal(view.tasks[0].assignee, 'dev-2')
  assert.equal(view.tasks[0].blockedReason, null)
  assert.equal(view.activity.length, result.board.activity.length)
  assert.equal(view.activity[0].kind, 'complete')
  passed += 1
})

// 截断纪律：每任务最多 20 条进展、活动时间线最多 200 条；纯活动追加不动 revision。
test('team-board：进展 20 条 / 活动 200 条上限，活动追加不动 revision', () => {
  const sid = 'board-caps'
  rmSync(boardMod.boardFile(sid), { force: true })
  let result = boardMod.boardCreate(sid, { subject: '压测截断' })
  for (let index = 0; index < 25; index += 1) {
    result = boardMod.boardUpdate(sid, 't1', result.board.revision, 'note', { text: `进展 ${index}`, by: 'dev' })
  }
  const board = boardMod.readBoard(sid)
  assert.equal(board.tasks[0].notes.length, boardMod.MAX_NOTES_PER_TASK)
  assert.equal(board.tasks[0].notes[0].text, '进展 24', '新的在前，旧的被截掉')

  for (let index = 0; index < 205; index += 1) {
    boardMod.recordBoardActivity(sid, { by: 'dev', kind: 'message', text: `消息 ${index}` })
  }
  const after = boardMod.readBoard(sid)
  assert.equal(after.activity.length, boardMod.MAX_ACTIVITY)
  assert.equal(after.activity[0].text, '消息 204')
  assert.equal(after.revision, board.revision, '纯活动追加不动 revision（不把改任务的队友 CAS 打回）')
  passed += 1
})

// 角色扩充：九内置角色 + 各自工具白名单/审批档；默认轮次进 DEFAULT_ROLE_TURNS 与设置页。
test('内置角色扩到九个，新角色有各自白名单/审批/默认轮次', () => {
  assert.deepEqual(roles.builtinRoleNames(), [
    'architect',
    'critic',
    'developer',
    'explorer',
    'ops',
    'pm',
    'reviewer',
    'tester',
    'writer',
  ])
  const expected = {
    pm: { approval: 'forbid', tools: ['read', 'glob', 'grep', 'subagent'] },
    architect: { approval: 'forbid', tools: ['read', 'glob', 'grep'] },
    developer: { approval: 'ask', tools: ['read', 'write', 'edit', 'glob', 'grep', 'bash'] },
    tester: { approval: 'ask', tools: ['read', 'glob', 'grep', 'bash', 'write'] },
    ops: { approval: 'ask', tools: ['read', 'bash', 'glob', 'grep'] },
  }
  for (const [name, spec] of Object.entries(expected)) {
    const role = roles.builtinRole(name)
    assert.notEqual(role, null, `内置角色 ${name} 缺失`)
    assert.deepEqual(role.tools, spec.tools, `${name} 的工具白名单`)
    assert.equal(role.approval, spec.approval, `${name} 的审批档`)
    assert.ok(role.prompt.length > 50, `${name} 的提示词不能是空壳`)
  }
  assert.equal(mod.DEFAULT_ROLE_TURNS.pm, 48)
  assert.equal(mod.DEFAULT_ROLE_TURNS.architect, 32)
  assert.equal(mod.DEFAULT_ROLE_TURNS.developer, 128)
  assert.equal(mod.DEFAULT_ROLE_TURNS.tester, 64)
  assert.equal(mod.DEFAULT_ROLE_TURNS.ops, 32)
  assert.equal(mod.DEFAULT_ROLE_TURNS.explorer, 0)

  writeSubagentConfig({ roleTurns: undefined })
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const values = captured.sections.values()
  for (const [name, turns] of [
    ['pm', 48],
    ['architect', 32],
    ['developer', 128],
    ['tester', 64],
    ['ops', 32],
  ]) {
    assert.equal(values[`roleTurns.${name}`], turns, `设置页要列出 ${name} 的默认轮次`)
  }
  passed += 1
})

// 团队模式：打开自动把 maxDepth 抬到 2，关闭不回退；设置项是个开关。
test('团队模式开关：打开抬到二层，关闭不回退', () => {
  writeSubagentConfig({ teamMode: false, maxDepth: 1 })
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const section = captured.sections
  assert.equal(section.values().teamMode, false)
  assert.equal(section.values().maxDepth, 1)
  assert.equal(section.fields().find((field) => field.key === 'teamMode')?.type, 'switch')

  assert.equal(section.save('teamMode', true), undefined)
  assert.equal(section.values().teamMode, true)
  assert.equal(section.values().maxDepth, 2, '团队模式 = 允许二层派活')

  assert.equal(section.save('teamMode', false), undefined)
  assert.equal(section.values().teamMode, false)
  assert.equal(section.values().maxDepth, 2, '关闭不替用户降级 maxDepth')
  passed += 1
})

// 横向通道跟着派活开关走：关掉 board 只撤 team_task，team_message 还在；
// 关掉 allowDelegation 则两个工具一起撤。
test('team_message 注册跟着 allowDelegation，不跟着 board', () => {
  writeSubagentConfig({ board: false, allowDelegation: true })
  let fake = fakeContext()
  mod.subagentPlugin.apply(fake.ctx)
  assert.equal(fake.captured.tools.some((entry) => entry.name === 'team_task'), false, 'board 关掉不该有 team_task')
  assert.equal(fake.captured.tools.some((entry) => entry.name === 'team_message'), true, 'team_message 跟派活走')

  writeSubagentConfig({ board: true, allowDelegation: false })
  fake = fakeContext()
  mod.subagentPlugin.apply(fake.ctx)
  assert.equal(fake.captured.tools.some((entry) => entry.name === 'team_message'), false, '不允许派活时没有收件人')
  assert.equal(fake.captured.tools.some((entry) => entry.name === 'team_task'), true, 'board 仍开，板子还在')
  passed += 1
})

// team_message：点对点投递到信箱 + 记板子活动；目标不在队时如实说「没人会读」。
test('team_message：send 投信箱、写活动；目标不在队如实说明', async () => {
  writeSubagentConfig({ board: true, allowDelegation: true })
  const sid = 'msg-session'
  rmSync(boardMod.boardFile(sid), { force: true })
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const tool = captured.tools.find((entry) => entry.name === 'team_message')
  assert.notEqual(tool, undefined, '缺 team_message 工具')
  assert.deepEqual(tool.parameters.properties.action.enum, ['send', 'broadcast', 'inbox'])
  const runCtx = { cwd: process.cwd(), sessionId: sid, sessionPath: join(home, 'msg.jsonl'), signal: new AbortController().signal }

  const out = await tool.run({ action: 'send', to: 'ghost-1', text: '在吗，接口契约定了吗' }, runCtx)
  assert.match(out, /不在队/, '目标不在队要如实说明')
  const inbox = boardMod.inboxRead('ghost-1')
  assert.equal(inbox.length, 1, '话要写进信箱')
  assert.ok(inbox[0].includes('接口契约'))
  assert.ok(inbox[0].includes('from="lead"'), '带 from 署名')

  const board = boardMod.readBoard(sid)
  assert.equal(board.activity[0].kind, 'message', '消息记进板子活动')
  assert.ok(board.activity[0].text.includes('ghost-1'))

  // inbox 读最近消息
  boardMod.inboxAppend('lead', '<team-message from="dev-1" to="lead"> 我这边完成了 </team-message>')
  const inboxOut = await tool.run({ action: 'inbox', limit: 5 }, runCtx)
  assert.match(inboxOut, /我这边完成了/)
  passed += 1
})

// team_task 工具面：note / assign / get / activity 都能用，输出带最新进展与活动。
test('team_task 工具：note/assign/get/activity 覆盖新动作', async () => {
  writeSubagentConfig({ board: true, allowDelegation: true })
  const sid = 'tool-board'
  rmSync(boardMod.boardFile(sid), { force: true })
  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const tool = captured.tools.find((entry) => entry.name === 'team_task')
  const runCtx = { cwd: process.cwd(), sessionId: sid, sessionPath: join(home, 'tool-board.jsonl'), signal: new AbortController().signal }

  let out = await tool.run({ action: 'create', subject: '写协作文档', write_scopes: ['docs/'] }, runCtx)
  assert.match(out, /已建 t1/)
  out = await tool.run({ action: 'claim', id: 't1', expected_revision: 1, owner: 'lead' }, runCtx)
  assert.match(out, /in_progress/)
  out = await tool.run({ action: 'note', id: 't1', expected_revision: 2, text: '大纲写好了' }, runCtx)
  assert.match(out, /大纲写好了/, 'note 回执要带最新进展')
  out = await tool.run({ action: 'assign', id: 't1', expected_revision: 3, assignee: 'writer-1' }, runCtx)
  assert.match(out, /绑定：writer-1/)
  out = await tool.run({ action: 'get', id: 't1' }, runCtx)
  assert.match(out, /进展（1 条/)
  assert.match(out, /绑定队友：writer-1/)
  out = await tool.run({ action: 'activity', limit: 5 }, runCtx)
  assert.match(out, /最近 \d 条活动/)

  const board = boardMod.readBoard(sid)
  assert.equal(board.tasks[0].notes[0].text, '大纲写好了')
  assert.equal(board.tasks[0].assignee, 'writer-1')
  passed += 1
})

// spawn 的 task_id：不存在 / 已被别人认领 / 依赖没完成，都要给明确原因而不是硬派。
test('spawn 带 task_id：不存在/被认领/依赖未完成都明确拒绝', async () => {
  writeSubagentConfig({ board: true, allowDelegation: true })
  const sid = 'spawn-task'
  rmSync(boardMod.boardFile(sid), { force: true })
  let created = boardMod.boardCreate(sid, { subject: '实现登录接口' })
  boardMod.boardUpdate(sid, created.task.id, created.board.revision, 'claim', { owner: 'someone-else', by: 'lead' })
  created = boardMod.boardCreate(sid, { subject: '登录后的跳转', blockedBy: ['t1'] })
  assert.equal(created.task.id, 't2')

  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  ctx.agent.sessionById = (sessionId) => ({ meta: { id: sessionId } })
  const tool = captured.tools.find((entry) => entry.name === 'subagent')
  const runCtx = { cwd: process.cwd(), sessionId: sid, sessionPath: join(home, 'spawn-task.jsonl'), signal: new AbortController().signal }
  const base = { action: 'spawn', role: 'developer', task: '实现登录接口并补一条测试' }

  let out = await tool.run({ ...base, task_id: 't99' }, runCtx)
  assert.match(out, /没有 t99/)
  out = await tool.run({ ...base, task_id: 't1' }, runCtx)
  assert.match(out, /已经被 someone-else 认领/)
  out = await tool.run({ ...base, task_id: 't2' }, runCtx)
  assert.match(out, /还在等依赖完成/)

  // 板子上没有认领/绑定副作用：两条任务状态没被这次失败的 spawn 改掉
  const board = boardMod.readBoard(sid)
  assert.equal(board.tasks.find((task) => task.id === 't1')?.owner, 'someone-else')
  assert.equal(board.tasks.find((task) => task.id === 't2')?.owner, null)
  passed += 1
})

// 提示词摘要：一行任务要带负责人/绑定/卡住/最新进展；活动行带时间与动作。
test('提示词摘要行：任务带负责人/绑定/卡住/最新进展，活动带时间', () => {
  const sid = 'digest-session'
  rmSync(boardMod.boardFile(sid), { force: true })
  const created = boardMod.boardCreate(sid, { subject: '拆分验收任务' })
  let result = boardMod.boardUpdate(sid, 't1', created.board.revision, 'claim', { owner: 'dev-1', assignee: 'dev-1', by: 'dev-1' })
  result = boardMod.boardUpdate(sid, 't1', result.board.revision, 'note', { text: '已完成接口层', by: 'dev-1' })
  result = boardMod.boardUpdate(sid, 't1', result.board.revision, 'block', { text: '等测试环境', by: 'dev-1' })
  const line = mod.taskDigestLine(result.board, result.board.tasks[0])
  assert.ok(line.includes('t1'))
  assert.ok(line.includes('@dev-1'))
  assert.ok(line.includes('绑定 dev-1'))
  assert.ok(line.includes('卡住：等测试环境'))
  // notes 新的在前：最新的那条是刚才的 block 记录
  assert.ok(line.includes('最新进展（dev-1）：[卡住] 等测试环境'))
  const activity = mod.activityDigestLine(result.board.activity[0])
  assert.match(activity, /^\- \d{2}:\d{2} dev-1 note t1：/)
  passed += 1
})

// Lead 系统提示：团队段是逐字常量（看板数据一律不进系统提示），看板快照走投影；
// 子智能体提示带分工协议。2026-11 缓存修复：系统提示每轮变 = 前缀缓存每轮作废。
test('Lead 提示段稳定 + 看板快照投影 + 分工协议', () => {
  writeSubagentConfig({ board: true, allowDelegation: true, teamMode: false })
  const sid = 'package-test'
  rmSync(boardMod.boardFile(sid), { force: true })
  const created = boardMod.boardCreate(sid, { subject: '给队友的任务' })
  let result = boardMod.boardUpdate(sid, 't1', created.board.revision, 'claim', { owner: 'dev-1', assignee: 'dev-1', by: 'dev-1' })
  boardMod.boardUpdate(sid, 't1', result.board.revision, 'note', { text: '第一版实现完成', by: 'dev-1' })

  let { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const renderTeam = () => captured.prompts.find((entry) => entry.id === 'team').render()
  const boardPrompt = renderTeam()
  // 稳定段：只讲规矩，不含任何看板数据（含任务、进展、活动、队友状态）
  assert.ok(boardPrompt.includes('# 共享任务板'), '缺标题')
  assert.ok(boardPrompt.includes('任务板的规矩'), '缺规矩')
  assert.ok(boardPrompt.includes('task_id'), '要提醒派活时用 task_id 绑定')
  assert.equal(boardPrompt.includes('第一版实现完成'), false, '看板正文不该进系统提示')
  assert.equal(boardPrompt.includes('最新进展'), false, '看板数据不该进系统提示')
  assert.equal(boardPrompt.includes('最近活动'), false, '活动时间线不该进系统提示')
  assert.equal(boardPrompt.includes('在队队友与绑定任务'), false, '队友状态不该进系统提示')

  // 系统提示段逐字稳定：往板子上写进展/记活动之后，同一段文本必须一个字节都不变。
  boardMod.boardUpdate(sid, 't1', boardMod.readBoard(sid).revision, 'note', { text: '第二版也完成', by: 'dev-1' })
  boardMod.recordBoardActivity(sid, { by: 'dev-1', kind: 'message', text: '再记一条活动' })
  assert.equal(renderTeam(), boardPrompt, '看板变了，系统提示团队段也必须逐字不变')

  // 易变段走投影：看板变了就注入一次快照，正文带最新进展
  const projection = captured.projections.find((entry) => entry.id === 'team-board')
  assert.notEqual(projection, undefined, '看板快照要走 team-board 投影')
  assert.equal(projection.options.order, 700)
  const owner = { meta: { id: sid }, messages: [], appendNote: () => {} }
  const base = [{ role: 'user', content: '开始' }]
  const injected = projection.apply(base, owner, () => {})
  assert.equal(injected.length, base.length + 1, '看板变了要注入一条快照')
  const snapshot = injected[injected.length - 1].content
  assert.ok(snapshot.includes('# 共享任务板快照'), '快照要有固定开头')
  assert.ok(snapshot.includes('第一版实现完成'), '快照要带最新进展')
  assert.ok(snapshot.includes('再记一条活动'), '快照要带最近活动')

  const subagentPrompt = captured.prompts.find((entry) => entry.id === 'subagent').render()
  assert.ok(subagentPrompt.includes('分工协议'), 'Lead 提示要有团队分工协议')
  assert.ok(subagentPrompt.includes('pm'), '分工协议要点名 pm')
  assert.equal(subagentPrompt.includes('团队模式已开'), false, '团队模式关着时不该出现那句提示')

  writeSubagentConfig({ teamMode: true, maxDepth: 2 })
  ;({ ctx, captured } = fakeContext())
  mod.subagentPlugin.apply(ctx)
  const modePrompt = captured.prompts.find((entry) => entry.id === 'subagent').render()
  assert.ok(modePrompt.includes('团队模式已开'))

  // 队友系统提示的「团队协作」段只放规矩：不含看板数据，逐字稳定（队友会话的缓存同理）
  const boardEnabled = mod.teammateCollabGuide(true)
  assert.ok(boardEnabled.includes('team_task list'), '队友段要教它去查最新看板')
  assert.equal(boardEnabled.includes('｜最新进展（'), false, '队友段不该塞看板行数据')
  assert.equal(mod.teammateCollabGuide(true), boardEnabled, '队友段必须是常量')
  assert.ok(mod.teammateCollabGuide(false).includes('任务板未开启'), '关掉板子时如实说')
  // 板子数据留在这块会话上会影响后面的装配用例：清干净
  boardMod.resetBoard(sid)
  passed += 1
})

// host 服务投影：team.board 走 boardViewOf（新字段全在）；team.list 带 taskId，老名册缺省 undefined。
test('team.board / team.list 投影带新字段（含老名册兼容）', () => {
  writeSubagentConfig({ board: true, allowDelegation: true })
  const boardSession = 'svc-board'
  rmSync(boardMod.boardFile(boardSession), { force: true })
  const created = boardMod.boardCreate(boardSession, { subject: '服务投影' })
  let result = boardMod.boardUpdate(boardSession, 't1', created.board.revision, 'claim', {
    owner: 'dev-x',
    assignee: 'dev-x',
    by: 'dev-x',
  })
  boardMod.boardUpdate(boardSession, 't1', result.board.revision, 'note', { text: '进展一', by: 'dev-x' })

  const rosterFile = join(process.env.DSC_HOME, 'team', 'roster.json')
  mkdirSync(dirname(rosterFile), { recursive: true })
  writeFileSync(
    rosterFile,
    JSON.stringify({
      teammates: [
        { name: 'dev-1', role: 'developer', state: 'idle', task: '做 x', file: join(home, 'dev-1.jsonl'), cwd: home, parent: 'lead', depth: 1, rounds: 3, startedAt: 1, taskId: 't7' },
        { name: 'old-1', role: 'writer', state: 'idle', task: '旧记录', file: join(home, 'old-1.jsonl'), cwd: home, parent: 'lead', depth: 1, rounds: 1, startedAt: 0 },
      ],
    }),
    'utf8',
  )

  const { ctx, captured } = fakeContext()
  mod.subagentPlugin.apply(ctx)
  const view = captured.provided.team.board(boardSession)
  assert.equal(view.tasks[0].latestNote.text, '进展一')
  assert.equal(view.tasks[0].noteCount, 1)
  assert.equal(view.tasks[0].assignee, 'dev-x')
  assert.equal(view.tasks[0].blockedReason, null)
  assert.equal(view.activity[0].kind, 'note')

  const views = captured.provided.team.list()
  assert.equal(views.find((entry) => entry.name === 'dev-1')?.taskId, 't7')
  assert.equal(views.find((entry) => entry.name === 'old-1')?.taskId, undefined, '老名册没有 taskId 时不报错')
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
