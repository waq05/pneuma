/**
 * @pneuma/subagent 的包级测试：钉 12 条不变量。
 * 为什么只钉这些：入口只有插件对象，派活要会话与模型；能便宜钉住的是装配面、包形态、入口、
 * 文档、agent-roles 里那张不落盘的出厂角色表，以及 2026-11-06 并入的共享任务板
 * （team_task 工具、板子提示段、设置分区里的 board 子开关）装配面。
 *
 * 迁移说明：装配行改成 `YAML.parse` 后断言结构；入口直接 import 源码；
 * 假 ctx 只实现 apply 用到的几个面，传给强类型入口时用 `as unknown as Context`。
 * @module @pneuma/subagent/tests
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { afterAll, expect, test } from 'vitest'
import { builtinRole, builtinRoleNames } from '../agent-roles.js'
import { COLLAB_TOOL_NAMES, DEFAULT_ROLE_TURNS, subagentPlugin } from '../index.js'
import { boardCreate, boardUpdate, resetBoard } from '@pneuma/runtime/core/team-board.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  type?: string
  exports?: Record<string, { default?: string } | string>
  pneuma?: { library?: boolean; bundle?: { patch?: string } }
}

/** 装配文件里的一行。 */
interface PatchRow {
  id?: string
  name?: string
}

/** 工具调用上下文里测试用得到的部分（真类型见 `core/tools.ts` 的 `ToolContext`）。 */
interface CapturedRunContext {
  cwd: string
  sessionId: string
  sessionPath: string
  signal: AbortSignal
}

/** 工具声明里测试用得到的部分。 */
interface CapturedTool {
  name: string
  description: string
  risk: string
  parameters: {
    properties: Record<string, { type?: string; enum?: string[]; description?: string }>
    required?: string[]
  }
  run: (args: Record<string, unknown>, runCtx: CapturedRunContext) => unknown
}

/** 提示段注册项。 */
interface CapturedPrompt {
  id: string
  render: () => string
}

/** 设置分区里测试用得到的部分。 */
interface CapturedSection {
  id: string
  groups?: Array<{ id: string; title?: string }>
  fields: () => Array<{ key: string; type?: string; group?: string; action?: string; label?: string }>
  values: () => Record<string, unknown>
  action?: unknown
}

// 临时 HOME + DSC_HOME：apply 会铺出厂角色、读插件配置，真实 ~/.dsc 一个字节都不许动。
// 必须在 import 源码之前设好——DSC_HOME 与 homedir() 都在模块加载时取一次。
const home = mkdtempSync(join(tmpdir(), 'numa-subagent-test-'))
const savedEnv = {
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
  DSC_HOME: process.env['DSC_HOME'],
}
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })

const pkg = JSON.parse(read('../package.json')) as PackageJson

/** 还原环境变量：有原值就写回，原本没有就删掉。 */
function restoreEnv(name: 'HOME' | 'USERPROFILE' | 'DSC_HOME'): void {
  const before = savedEnv[name]
  if (before === undefined) delete process.env[name]
  else process.env[name] = before
}

afterAll(() => {
  restoreEnv('HOME')
  restoreEnv('USERPROFILE')
  restoreEnv('DSC_HOME')
})

/**
 * 假 ctx：apply 只用这几个面；effect 真跑回调、把返回的 disposer 收下，
 * 否则 syncTools 里的注册根本不会发生，断言无从谈起。
 */
function fakeContext(): { ctx: Context; captured: { tools: CapturedTool[]; sections?: CapturedSection; prompts: CapturedPrompt[]; provided: Record<string, unknown> } } {
  const captured: {
    tools: CapturedTool[]
    sections?: CapturedSection
    prompts: CapturedPrompt[]
    provided: Record<string, unknown>
  } = { tools: [], sections: undefined, prompts: [], provided: {} }
  const ctx = {
    session: { current: () => ({ meta: { id: 'package-test' } }) },
    tools: {
      register: (entry: CapturedTool) => {
        captured.tools.push(entry)
        return () => {}
      },
      list: () => captured.tools,
    },
    prompt: {
      register: (id: string, render: () => string) => {
        captured.prompts.push({ id, render })
        return () => {}
      },
    },
    settings: {
      about: () => ({ home: process.env.DSC_HOME }),
      registerSection: (spec: CapturedSection) => {
        captured.sections = spec
        return () => {}
      },
    },
    provide: (name: string, service: unknown) => {
      captured.provided[name] = service
    },
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
    transcript: { touch: () => {} },
    // 设置分区里的「授权模型」多选要现读模型清单（这里给空清单；本文件不钉模型列表）
    llm: { listModels: () => [] },
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
  // 假 ctx 只实现测试用到的面；真实 Context 的字段远多于它。
  return { ctx: ctx as unknown as Context, captured }
}

test('cordis.patch.yml 的装配行认的是 @pneuma/subagent', () => {
  const patch = YAML.parse(read('../cordis.patch.yml')) as Array<{ insert?: PatchRow[] }>
  const row = patch.flatMap((layer) => layer.insert ?? []).find((item) => item.id === 'subagent')
  // 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对。
  expect(row, '装配行的 id 必须正好是 subagent').toBeDefined()
  expect(row?.name, "装配行的 name 必须是 '@pneuma/subagent'").toBe('@pneuma/subagent')
})

test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports?.['.'], 'exports 必须有 "."').toBeDefined()
  expect(pkg.exports?.['./package.json'], 'exports 必须有 "./package.json"').toBeDefined()
  if (pkg.pneuma?.library === true) {
    expect(pkg.pneuma?.bundle, '库包不该有 bundle.patch').toBeUndefined()
  } else {
    expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
  }
})

test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof subagentPlugin).toBe('object')
  expect(typeof subagentPlugin.name).toBe('string')
  expect(subagentPlugin.name).toBe(pkg.name.split('/').pop())
  expect(subagentPlugin.name).toBe('subagent')
  expect(typeof subagentPlugin.apply).toBe('function')
})

test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme, '缺 ## Model Experience').toContain('## Model Experience')
  expect(readme, '缺 ## Known Limitations').toContain('## Known Limitations')
})

test('出厂角色：九个内置角色，各自的工具白名单/审批/默认轮次都对得上', () => {
  // 2026-11 团队协作升级：在四个通用角色之外新增 pm/architect/developer/tester/ops。
  expect(builtinRoleNames()).toStrictEqual([
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
  const expected: Record<string, { tools: string[]; approval: string; turns: number }> = {
    explorer: { tools: ['read', 'glob', 'grep'], approval: 'forbid', turns: 0 },
    writer: { tools: ['read', 'write', 'edit', 'glob', 'grep', 'bash'], approval: 'ask', turns: 128 },
    critic: { tools: ['read', 'glob', 'grep'], approval: 'forbid', turns: 16 },
    reviewer: { tools: ['read', 'glob', 'grep'], approval: 'forbid', turns: 64 },
    pm: { tools: ['read', 'glob', 'grep', 'subagent'], approval: 'forbid', turns: 48 },
    architect: { tools: ['read', 'glob', 'grep'], approval: 'forbid', turns: 32 },
    developer: { tools: ['read', 'write', 'edit', 'glob', 'grep', 'bash'], approval: 'ask', turns: 128 },
    tester: { tools: ['read', 'glob', 'grep', 'bash', 'write'], approval: 'ask', turns: 64 },
    ops: { tools: ['read', 'bash', 'glob', 'grep'], approval: 'ask', turns: 32 },
  }
  for (const [name, spec] of Object.entries(expected)) {
    const role = builtinRole(name)
    expect(role, `内置角色 ${name} 缺失`).not.toBeNull()
    expect(role?.builtin, `${name} 要标成内置`).toBe(true)
    expect(role?.tools, `${name} 的工具白名单`).toStrictEqual(spec.tools)
    expect(role?.approval, `${name} 的审批档`).toBe(spec.approval)
    // 出厂模板不再钉 max-turns：默认轮次统一放 DEFAULT_ROLE_TURNS，设置页才能改
    expect(role?.maxTurns, `${name} 模板不该写死轮次`).toBe(0)
    expect(role?.maxTurnsDeclared, `${name} 模板不该显式声明轮次`).toBe(false)
    expect(DEFAULT_ROLE_TURNS[name], `${name} 的默认轮次`).toBe(spec.turns)
  }
  expect(builtinRole('no-such-role')).toBeNull()
})

test('apply 注册的 team_task 是只读风险，action 枚举覆盖认领与结项', () => {
  const { ctx, captured } = fakeContext()
  subagentPlugin.apply(ctx, undefined)
  const tool = captured.tools.find((entry) => entry.name === 'team_task')
  // 板子默认开，必须注册 team_task。
  expect(tool).toBeDefined()
  expect(tool?.risk).toBe('read')
  expect(tool?.parameters.required).toStrictEqual(['action'])
  const actions = tool?.parameters.properties['action']?.enum ?? []
  for (const action of ['create', 'list', 'claim', 'complete', 'delete', 'set_dependencies']) {
    expect(actions, 'action 枚举缺 ' + action).toContain(action)
  }
  expect(typeof tool?.run).toBe('function')
})

test('board 关掉后没有 team_task 与板子提示段，subagent 照常', () => {
  const { ctx, captured } = fakeContext()
  subagentPlugin.apply(ctx, { board: false })
  expect(captured.tools.some((entry) => entry.name === 'team_task'), 'board=false 不该注册 team_task').toBe(false)
  expect(captured.tools.some((entry) => entry.name === 'subagent'), 'board=false 不影响派活工具').toBe(true)
  expect(captured.prompts.map((entry) => entry.id), '只该剩子智能体提示段').toStrictEqual(['subagent'])
})

test('allowDelegation 关掉后板子仍在（只想要共享待办的用法）', () => {
  const { ctx, captured } = fakeContext()
  subagentPlugin.apply(ctx, { allowDelegation: false })
  expect(captured.tools.some((entry) => entry.name === 'subagent'), '派活工具该撤下').toBe(false)
  expect(captured.tools.some((entry) => entry.name === 'team_task'), '板子该留着').toBe(true)
  expect(captured.prompts.map((entry) => entry.id)).toStrictEqual(['team'])
})

test('提示段提 team_task，设置分区分 turns/models/board 三组且字段换成新键', () => {
  const { ctx, captured } = fakeContext()
  subagentPlugin.apply(ctx, undefined)
  expect(captured.prompts.map((entry) => entry.id).sort()).toStrictEqual(['subagent', 'team'])

  const subagentPrompt = captured.prompts.find((entry) => entry.id === 'subagent')?.render() ?? ''
  expect(subagentPrompt, '子智能体提示段必须提一句 team_task').toContain('team_task')
  expect(subagentPrompt, 'Lead 提示段要有团队分工协议').toContain('分工协议')
  const renderBoard = (): string => captured.prompts.find((entry) => entry.id === 'team')?.render() ?? ''
  const boardPrompt = renderBoard()
  expect(boardPrompt, '板子提示段缺标题').toContain('# 共享任务板')
  expect(boardPrompt, '空板要明说还没有任务').toContain('板上还没有任务')
  expect(boardPrompt, '板子提示段要提示派活用 task_id 绑定').toContain('task_id')
  // 板上真有任务时，提示段要带负责人与最新进展（空板看不到这一行，所以现造一条）
  const created = boardCreate('package-test', { subject: '示例任务' })
  try {
    boardUpdate('package-test', created.task.id, created.board.revision, 'note', {
      text: '接口层改完，跑单测中',
      by: 'dev-1',
    })
    const withTask = renderBoard()
    expect(withTask, '板子提示段要展示最新进展').toContain('最新进展')
    expect(withTask, '提示段要带上进展正文').toContain('接口层改完')
    expect(withTask, '提示段要带负责人署名').toContain('dev-1')
  } finally {
    // 提示段每轮现读磁盘：不清理会影响同一进程里后续断言空板的用例
    resetBoard('package-test')
  }

  const section = captured.sections
  expect(section).toBeDefined()
  expect(section?.id).toBe('subagent')
  expect((section?.groups ?? []).map((group) => group.id)).toStrictEqual(['turns', 'models', 'board'])

  const fields = section?.fields() ?? []
  const keys = fields.map((field) => field.key)
  // 2026-11：默认模型文本框撤掉，换成「允许 Agent 选模型」开关 + 授权模型多选
  expect(keys).not.toContain('defaultModel')
  expect(fields.find((field) => field.key === 'allowModelSelection')?.type, '缺 allowModelSelection 开关').toBe('switch')
  expect(fields.find((field) => field.key === 'allowedModels')?.type, '缺 allowedModels 多选').toBe('checks')
  expect(fields.find((field) => field.key === 'teamMode')?.type, '缺 teamMode 开关').toBe('switch')
  for (const role of builtinRoleNames()) {
    const field = fields.find((candidate) => candidate.key === `roleTurns.${role}`)
    expect(field, `缺 roleTurns.${role} 数字项`).toBeDefined()
    expect(field?.type, `${role} 的轮次项要是数字`).toBe('number')
    expect(field?.group).toBe('turns')
  }
  expect(fields.filter((field) => field.group === 'models')).toHaveLength(2)
  const boardField = fields.find((field) => field.key === 'board')
  expect(boardField, '缺 board 子开关').toBeDefined()
  expect(boardField?.group).toBe('board')
  expect(fields.some((field) => field.action === 'clear-board'), '清空任务板按钮要跟着搬过来').toBe(true)

  // 默认值：板子开、团队模式关、模型选择关、九个角色轮次各就各位
  const values = section?.values() ?? {}
  expect(values['board'], '板子默认开').toBe(true)
  expect(values['teamMode'], '团队模式默认关').toBe(false)
  expect(values['allowModelSelection'], '模型选择默认关').toBe(false)
  expect(values['allowedModels'], '授权清单默认空').toStrictEqual([])
  for (const [role, turns] of Object.entries(DEFAULT_ROLE_TURNS)) {
    expect(values[`roleTurns.${role}`], `${role} 的默认轮次`).toBe(turns)
  }
  // 旧配置键仍被兼容读取，但界面不再把它画成设置项
  expect('defaultModel' in values, 'defaultModel 不该再出现在设置值里').toBe(false)
  expect(typeof section?.action).toBe('function')

  // 分组标题直接读本包的界面字典钉住（design 里点名的三个分组）
  const zh = JSON.parse(read('../locale/ui.zh.json')) as Record<string, string>
  expect(zh['group.turns.title']).toBe('默认最大轮次')
  expect(zh['group.models.title']).toBe('队友模型')
  expect(zh['group.board.title']).toBe('任务板')
})

test('协作工具豁免表包含 team_task / team_message，且不夹带文件类工具', () => {
  expect(COLLAB_TOOL_NAMES).toContain('team_task')
  expect(COLLAB_TOOL_NAMES).toContain('team_message')
  for (const name of ['read', 'write', 'edit', 'bash', 'glob', 'grep']) {
    expect(COLLAB_TOOL_NAMES, `${name} 不该进协作工具豁免表`).not.toContain(name)
  }
})

test('subagent 工具有 keep 开关，缺省留用，描述里讲清一次性是什么', () => {
  const { ctx, captured } = fakeContext()
  subagentPlugin.apply(ctx, undefined)
  const tool = captured.tools.find((entry) => entry.name === 'subagent')
  expect(tool, '派活工具默认开').toBeDefined()
  const keep = tool?.parameters.properties['keep']
  expect(keep, 'spawn 要能选一次性（keep 参数）').toBeDefined()
  expect(keep?.type).toBe('boolean')
  expect(keep?.description, 'keep 的描述要说出「一次性」三个字').toContain('一次性')
  expect((tool?.parameters.required ?? []).includes('keep'), 'keep 不填默认留用，不能必填').toBe(false)
  expect(tool?.description, '工具描述要讲清 keep=false 的后果').toContain('一次性')
})

// G6：superagent 的 worker 会话是执行器自己造的，不经常驻 agent 名册。它调这个工具时
// 父会话必须查得到（内核 `ctx.agent.attach` 登记过）；查不到要报错，**不能**回落
// `ctx.session.current()`——那会把队友派到用户正看着的会话名下，名册、额度、任务板
// 全落到错的那条会话上。
test('subagent 工具：父会话查不到就报错，查得到就按那条会话干活', async () => {
  const { ctx, captured } = fakeContext()
  subagentPlugin.apply(ctx, undefined)
  const tool = captured.tools.find((entry) => entry.name === 'subagent')!
  const runCtx: CapturedRunContext = {
    cwd: process.cwd(),
    sessionId: 'worker-t1',
    sessionPath: join(home, 'nowhere.jsonl'),
    signal: new AbortController().signal,
  }
  // 查不到：同步报错（不是 rejected promise），错误里点明「不在内核的会话表里」。
  expect(() => tool.run({ action: 'list' }, runCtx)).toThrow(/不在内核的会话表里/)
  // 查得到：按那条会话报名单（假会话没有队友，所以是空名单 + 角色表）。
  const agent = ctx.agent as unknown as { sessionById: (sessionId: string) => unknown }
  agent.sessionById = (sessionId) => (sessionId === 'worker-t1' ? { meta: { id: 'worker-t1' } } : undefined)
  const listed = await tool.run({ action: 'list' }, runCtx)
  expect(String(listed), '查得到就按那条会话报名单').toContain('本会话没有在队或收工的队友')
})
