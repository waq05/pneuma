/**
 * subagent 插件装配面（`packages/subagent/index.ts`）：工具 / 提示段 / 服务 / 设置分区 /
 * 守卫链的挂载，以及派活、后台汇报、失败、一次性回收、传话、叫停、任务板、/review 通道。
 *
 * 这里跑的是**真 `apply`**：真的写 `~/.dsc/agents`、真的建会话文件、真的跑 MiniAgent；
 * 唯一被替换的是模型端点（`ctx.llm.stream` 直接返回一段文本）与宿主表面（假 ctx）。
 * `DSC_HOME` 在任何 import 之前指向临时目录——路径常量在模块求值时算定。
 *
 * @module dsc/packages/subagent/tests/wiring.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-subagent-wiring-'))
process.env['DSC_HOME'] = HOME

/** 临时工作区：队友按父会话的 cwd 干活，这里只需要不是一个 git 仓库。 */
const WORKSPACE = mkdtempSync(join(tmpdir(), 'dsc-subagent-cwd-'))

type Plugin = typeof import('../index.js')['subagentPlugin']
type SessionT = import('../../../core/session.js').Session
type SessionModule = typeof import('../../../core/session.js')

interface CapturedTool {
  name: string
  description: string
  risk: string
  parameters: Record<string, unknown>
  run: (args: Record<string, unknown>, runCtx: Record<string, unknown>) => Promise<string> | string
}

interface CapturedPrompt {
  id: string
  render: () => string
  options?: Record<string, unknown>
}

interface CapturedSection {
  id: string
  order?: number
  groups?: Array<{ id: string }>
  fields: () => Array<{ key?: string; action?: string; group?: string }>
  values: () => Record<string, unknown>
  save: (key: string, value: unknown) => string | void
  action: (name: string) => string
}

interface ChatMessageLike {
  role: string
  content: string
}

interface FakeSession {
  meta: { id: string; cwd: string }
  filePath: string
  messages: ChatMessageLike[]
  appendUser: (text: string) => void
  state: (id: string) => unknown
  setState: (id: string, value: unknown) => void
}

interface Harness {
  ctx: Record<string, unknown>
  tools: CapturedTool[]
  prompts: CapturedPrompt[]
  sections: CapturedSection[]
  services: Map<string, unknown>
  guards: Array<{ id: string; order: number; decide: (input: Record<string, unknown>) => Promise<unknown> }>
  resolverFns: Array<(sessionId: string) => unknown>
  systems: Array<{ text: string; sessionId?: string }>
  emitted: Array<Record<string, unknown>>
  followups: Array<{ text: string; sessionId?: string; origin?: string }>
  decisions: Array<Record<string, unknown>>
  touches: number
  session: SessionT
  setSession: (session: SessionT) => void
  section: CapturedSection
  cleanup: () => void
  streamHandler: (api: string, request: StreamRequestLike, handlers: StreamHandlersLike) => Promise<StreamResultLike>
  release: () => void
}

interface StreamRequestLike {
  signal?: AbortSignal
}

interface StreamHandlersLike {
  onDelta?: (kind: 'text' | 'reasoning', text: string) => void
}

interface StreamResultLike {
  text: string
  reasoning: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  usage: { inputTokens: number; outputTokens: number } | null
  finishReason: string | null
}

const ROUTE = { api: 'fake', baseUrl: 'http://fake', apiKey: 'k', model: 'fake/model' }

const okStream = (text: string): StreamResultLike => ({
  text,
  reasoning: '',
  toolCalls: [],
  usage: { inputTokens: 3, outputTokens: 4 },
  finishReason: 'stop',
})

let plugin: Plugin
let SessionClass: SessionModule['Session']
const cleanups: Array<() => void> = []
const dirs: string[] = [HOME, WORKSPACE]

beforeAll(async () => {
  SessionClass = (await import('../../../core/session.js')).Session
  plugin = (await import('../index.js')).subagentPlugin
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup()
    } catch {
      // 已经收过了
    }
  }
})

afterAll(() => {
  delete process.env['DSC_HOME']
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 })
    } catch {
      // Windows 上文件可能还被写流占着：临时目录留给系统清。
    }
  }
})

beforeEach(() => {
  // 每条用例从一份干净配置出发：设置分区的保存会写磁盘，残留会串到下一用例。
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  writeJson(join(HOME, 'plugins.json'), { version: 1, entries: [] })
})

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readRoster(): Array<Record<string, unknown>> {
  try {
    const doc = JSON.parse(readFileSync(join(HOME, 'team', 'roster.json'), 'utf8')) as { teammates?: unknown }
    return Array.isArray(doc.teammates) ? (doc.teammates as Array<Record<string, unknown>>) : []
  } catch {
    return []
  }
}

/** 真 Session：父会话是队友归属、汇报落点与 fork 种子的来源。 */
function newSession(cwd = WORKSPACE): SessionT {
  const file = join(HOME, 'sessions', `parent-${String(Date.now())}-${String(Math.random()).slice(2)}.jsonl`)
  const session = SessionClass.create(cwd, file)
  return session
}

/** 等队友运行记录落稳：写流是异步的，收工那一刻文件可能还没刷完。 */
async function waitFile(file: string): Promise<void> {
  await until(() => {
    try {
      const raw = readFileSync(file, 'utf8')
      if (!raw.endsWith('\n')) return false
      const first = JSON.parse(raw.split('\n')[0]!) as { type?: string }
      return first.type === 'meta'
    } catch {
      return false
    }
  })
}

/** 等一个条件成立（后台队友的回合是异步跑完的）。 */
async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待条件超时')
}

/**
 * 假 ctx：把插件用到的挂载点全实现，`effect` 真跑回调。
 * 模型这一层由 `harness.streamHandler` 替换（默认回一段正文）。
 */
function fakeCtx(options: { config?: Record<string, unknown>; decision?: 'allow-once' | 'reject' } = {}): Harness {
  const tools: CapturedTool[] = []
  const prompts: CapturedPrompt[] = []
  const sections: CapturedSection[] = []
  const services = new Map<string, unknown>()
  const guards: Harness['guards'] = []
  const resolverFns: Harness['resolverFns'] = []
  const systems: Harness['systems'] = []
  const emitted: Harness['emitted'] = []
  const followups: Harness['followups'] = []
  const decisions: Harness['decisions'] = []
  const effects: Array<() => void> = []
  let touches = 0

  const parent = newSession()
  cleanups.push(() => {
    try {
      parent.close()
    } catch {
      // 已经关了
    }
  })

  const harness = {
    streamHandler: async (_api: string, _request: StreamRequestLike, handlers: StreamHandlersLike) => {
      handlers.onDelta?.('text', '队友结论第一行\n第二行\n')
      return okStream('队友结论第一行\n第二行')
    },
    release: (): void => undefined,
  } as unknown as Harness

  const ctx = {
    session: { current: () => harness.session },
    tools: {
      register(entry: CapturedTool) {
        tools.push(entry)
        return () => {
          const index = tools.indexOf(entry)
          if (index >= 0) tools.splice(index, 1)
        }
      },
      list: () => tools,
    },
    prompt: {
      register(id: string, render: () => string, opts?: Record<string, unknown>) {
        const item = { id, render, ...(opts === undefined ? {} : { options: opts }) }
        prompts.push(item)
        return () => {
          const index = prompts.indexOf(item)
          if (index >= 0) prompts.splice(index, 1)
        }
      },
    },
    settings: {
      about: () => ({ home: HOME }),
      registerSection(spec: CapturedSection) {
        sections.push(spec)
        return () => {
          const index = sections.indexOf(spec)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    provide(name: string, service: unknown) {
      services.set(name, service)
    },
    effect(execute: () => unknown) {
      const off = execute()
      if (typeof off === 'function') effects.push(off as () => void)
      return () => {
        if (typeof off === 'function') (off as () => void)()
      }
    },
    transcript: {
      touch: () => {
        touches += 1
      },
      emit: (event: Record<string, unknown>) => {
        emitted.push(event)
      },
      system: (text: string, _a?: unknown, _b?: unknown, sessionId?: string) => {
        systems.push({ text, ...(sessionId === undefined ? {} : { sessionId }) })
      },
    },
    llm: {
      model: 'fake/model',
      routeForSession: () => ROUTE,
      routeTo: () => ROUTE,
      stream: (api: string, request: StreamRequestLike, handlers: StreamHandlersLike) =>
        harness.streamHandler(api, request, handlers),
    },
    approval: {
      decide: async (request: Record<string, unknown>, _signal?: AbortSignal) => {
        decisions.push(request)
        return options.decision ?? 'allow-once'
      },
    },
    guards: {
      register(guard: Harness['guards'][number]) {
        guards.push(guard)
        return () => undefined
      },
      registerSessionResolver(_id: string, fn: (sessionId: string) => unknown) {
        resolverFns.push(fn)
        return () => undefined
      },
      gate: async () => ({ action: 'defer' }),
      observe: () => undefined,
    },
    agent: {
      sessionById: (id: string) => (harness.session.meta.id === id ? harness.session : undefined),
      hasAgent: () => false,
      followup: (text: string, _images?: unknown, sessionId?: string, origin?: string) => {
        followups.push({ text, ...(sessionId === undefined ? {} : { sessionId }), ...(origin === undefined ? {} : { origin }) })
      },
    },
  }

  // 基础工具：工牌白名单与协作工具筛选都要从这里取。
  for (const name of ['read', 'glob', 'grep']) {
    tools.push({ name, description: name, risk: 'read', parameters: {}, run: () => name })
  }

  harness.ctx = ctx
  harness.tools = tools
  harness.prompts = prompts
  harness.sections = sections
  harness.services = services
  harness.guards = guards
  harness.resolverFns = resolverFns
  harness.systems = systems
  harness.emitted = emitted
  harness.followups = followups
  harness.decisions = decisions
  harness.touches = 0
  harness.session = parent
  harness.setSession = (session: SessionT) => {
    harness.session = session
  }
  Object.defineProperty(harness, 'touches', {
    get: () => touches,
  })
  harness.section = undefined as unknown as CapturedSection
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apply = plugin.apply as unknown as (context: unknown, passed?: unknown) => (() => void) | void
  const returned = apply(ctx, options.config)
  const cleanup = (): void => {
    if (typeof returned === 'function') returned()
    for (const off of effects.splice(0)) off()
  }
  harness.cleanup = cleanup
  cleanups.push(cleanup)
  harness.section = sections[0] as CapturedSection
  return harness
}

/** 取派活工具。 */
function subagentTool(harness: Harness): CapturedTool {
  const tool = harness.tools.find((entry) => entry.name === 'subagent')
  expect(tool, 'default 配置下应当注册 subagent 工具').toBeDefined()
  return tool as CapturedTool
}

/** 调派活工具：默认归属当前会话。 */
function runTool(harness: Harness, args: Record<string, unknown>): Promise<string> | string {
  return subagentTool(harness).run(args, {
    cwd: harness.session.meta.cwd,
    signal: new AbortController().signal,
    sessionId: harness.session.meta.id,
  })
}

/** 派一个后台队友并等它收工。 */
async function spawnAndSettle(
  harness: Harness,
  args: Record<string, unknown>,
): Promise<{ name: string; text: string }> {
  const text = String(await runTool(harness, { action: 'spawn', background: true, task: TASK, ...args }))
  const matched = /已派给 ([a-z0-9-]+)/.exec(text)
  const name = matched?.[1] ?? String(args.name ?? '')
  await until(() => {
    const view = (harness.services.get('team') as { list: () => Array<{ name: string; state: string }> }).list()
    const found = view.find((item) => item.name === name)
    return found !== undefined && found.state !== 'working'
  }).catch((error: unknown) => {
    const view = (harness.services.get('team') as { list: () => Array<Record<string, unknown>> }).list()
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; spawn=${text}; events=${harness.emitted
        .map((event) => String(event['type']))
        .join(',')}; view=${JSON.stringify(view)}; roster=${JSON.stringify(readRoster())}`,
    )
  })
  return { name, text }
}

const TASK = '请统计仓库里有多少个测试文件并给出结论，附证据位置'

describe('注册面', () => {
  test('工具、提示段、服务、守卫与设置分区都挂上了', () => {
    const harness = fakeCtx()
    expect(harness.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['subagent', 'team_task']))
    expect(harness.prompts.map((prompt) => prompt.id).sort()).toEqual(['subagent', 'team'])
    expect([...harness.services.keys()].sort()).toEqual(['review', 'team'])
    expect(harness.guards.map((guard) => `${guard.id}@${String(guard.order)}`)).toEqual([
      'teammate-mode@9',
      'teammate-approval@29',
    ])
    expect(harness.resolverFns).toHaveLength(1)
    expect(harness.sections[0]).toMatchObject({ id: 'subagent', order: 40 })
    expect(harness.sections[0]?.groups?.map((group) => group.id)).toEqual(['board'])
    expect([...(plugin.inject as string[])]).toEqual([
      'session',
      'tools',
      'llm',
      'approval',
      'guards',
      'transcript',
      'prompt',
      'settings',
      'agent',
    ])
  })

  test('默认配置：派活与板子都开，并发 4、层数 1、轮次不限、审批 forbid', () => {
    const harness = fakeCtx()
    expect(harness.section.values()).toMatchObject({
      allowDelegation: true,
      maxTeammates: 4,
      maxDepth: 1,
      maxTurns: 0,
      approval: 'forbid',
      notify: 'auto',
      defaultModel: '',
      board: true,
    })
  })

  test('配置夹取：数字越界收敛、坏审批回落 forbid、字符串 false 认作关', () => {
    const harness = fakeCtx({
      config: {
        maxTeammates: 99,
        maxDepth: -5,
        maxTurns: 999,
        approval: 'bogus',
        notify: 'quiet',
        defaultModel: '  deepseek/deepseek-chat  ',
        board: 'false',
        allowDelegation: 'false',
      },
    })
    expect(harness.section.values()).toMatchObject({
      maxTeammates: 8,
      maxDepth: 0,
      maxTurns: 200,
      approval: 'forbid',
      notify: 'quiet',
      defaultModel: 'deepseek/deepseek-chat',
      board: false,
      allowDelegation: false,
    })
    expect(harness.tools.some((tool) => tool.name === 'subagent')).toBe(false)
    expect(harness.tools.some((tool) => tool.name === 'team_task')).toBe(false)
    expect(harness.prompts).toHaveLength(0)
  })

  test('allowDelegation / board 各管一半：两种单独开都成立', () => {
    const onlyBoard = fakeCtx({ config: { allowDelegation: false } })
    expect(onlyBoard.tools.some((tool) => tool.name === 'subagent')).toBe(false)
    expect(onlyBoard.tools.some((tool) => tool.name === 'team_task')).toBe(true)
    expect(onlyBoard.prompts.map((prompt) => prompt.id)).toEqual(['team'])

    const onlyDelegate = fakeCtx({ config: { board: false } })
    expect(onlyDelegate.tools.some((tool) => tool.name === 'team_task')).toBe(false)
    expect(onlyDelegate.tools.some((tool) => tool.name === 'subagent')).toBe(true)
    expect(onlyDelegate.prompts.map((prompt) => prompt.id)).toEqual(['subagent'])
  })

  test('提示段列出可用角色；板子提示段在板上没有任务时也说清规矩', () => {
    const harness = fakeCtx()
    const subagentPrompt = harness.prompts.find((prompt) => prompt.id === 'subagent')?.render() ?? ''
    expect(subagentPrompt).toContain('# 子智能体')
    expect(subagentPrompt).toContain('explorer')
    expect(subagentPrompt).toContain('team_task')
    expect(subagentPrompt).toContain('本会话同时干活上限 4 个')
    const boardPrompt = harness.prompts.find((prompt) => prompt.id === 'team')?.render() ?? ''
    expect(boardPrompt).toContain('# 共享任务板')
    expect(boardPrompt).toContain('板上还没有任务')
  })
})

describe('设置分区', () => {
  test('保存开关会立刻重挂工具与提示段', () => {
    const harness = fakeCtx()
    expect(harness.tools.some((tool) => tool.name === 'subagent')).toBe(true)

    expect(harness.section.save('allowDelegation', false)).toBeUndefined()
    expect(harness.tools.some((tool) => tool.name === 'subagent')).toBe(false)
    expect(harness.tools.some((tool) => tool.name === 'team_task')).toBe(true)
    expect(harness.prompts.map((prompt) => prompt.id)).toEqual(['team'])

    expect(harness.section.save('board', false)).toBeUndefined()
    expect(harness.tools.some((tool) => tool.name === 'team_task')).toBe(false)
    expect(harness.prompts).toHaveLength(0)

    expect(harness.section.save('allowDelegation', true)).toBeUndefined()
    expect(harness.tools.some((tool) => tool.name === 'subagent')).toBe(true)
  })

  test('保存非法值返回人话错误，且不改当前配置', () => {
    const harness = fakeCtx()
    expect(String(harness.section.save('approval', 'always'))).toContain('不认识的值')
    expect(String(harness.section.save('defaultModel', 'deepseek-chat'))).toContain('端点名/模型名')
    expect(String(harness.section.save('nope', 1))).toContain('没有这项')
    expect(harness.section.values()).toMatchObject({ approval: 'forbid', defaultModel: '' })
  })

  test('动作：新建示例角色写进角色目录；清空任务板返回条数；未知按钮抛错', async () => {
    const harness = fakeCtx()
    const said = String(harness.section.action('new-role'))
    expect(said).toContain('starter.md')
    expect(existsSync(join(HOME, 'agents', 'starter.md'))).toBe(true)

    const teamTask = harness.tools.find((tool) => tool.name === 'team_task') as CapturedTool
    await teamTask.run({ action: 'create', subject: '看一眼' }, { sessionId: harness.session.meta.id })
    expect(String(harness.section.action('clear-board'))).toContain('去掉 1 条')

    expect(() => harness.section.action('no-such-button')).toThrow(/没有这个按钮/)
  })
})

describe('subagent 工具的校验分支', () => {
  test('未知 action、未知角色、太短任务、非法名字', async () => {
    const harness = fakeCtx()
    expect(String(await runTool(harness, { action: 'dance' }))).toContain('不认识的 action')
    expect(String(await runTool(harness, { action: 'spawn', role: 'no-such-role', task: TASK }))).toContain(
      '角色 no-such-role 不可用',
    )
    expect(String(await runTool(harness, { action: 'spawn', role: 'explorer', task: '太短' }))).toContain('任务描述太短')
    expect(
      String(await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, name: 'Bad_Name' })),
    ).toContain('队友名「Bad_Name」不合法')
  })

  test('list 空名单仍给出可用角色；message 空文本与不存在队友各有一句实话', async () => {
    const harness = fakeCtx()
    const list = String(await runTool(harness, { action: 'list' }))
    expect(list).toContain('本会话没有在队或收工的队友')
    expect(list).toContain('explorer')
    expect(String(await runTool(harness, { action: 'message', name: 'x', text: '   ' }))).toContain('message 要带上 text')
    expect(String(await runTool(harness, { action: 'message', name: 'ghost', text: '喂' }))).toContain(
      '没有叫 ghost 的队友',
    )
    expect(String(await runTool(harness, { action: 'interrupt', name: 'ghost' }))).toContain('没有叫 ghost 的队友')
    expect(String(await runTool(harness, { action: 'stop', name: 'ghost' }))).toContain('没有叫 ghost 的队友')
  })

  test('层数上限与 context 取值都按设置与父会话状态拒绝', async () => {
    const noNesting = fakeCtx({ config: { maxDepth: 0 } })
    expect(String(await runTool(noNesting, { action: 'spawn', role: 'explorer', task: TASK }))).toContain(
      '设置只允许到 0 层',
    )

    const harness = fakeCtx()
    expect(
      String(await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, context: 'weird' })),
    ).toContain('不认识的 context')
    // 新会话还没落过任何一条消息：fork 带不上内容。
    expect(
      String(await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, context: 'fork' })),
    ).toContain('带不上父会话的内容')
  })
})

describe('派活、汇报与回收', () => {
  test('后台派活：工牌/提示、名册落盘、汇报接进父会话', async () => {
    const harness = fakeCtx()
    const { name, text } = await spawnAndSettle(harness, { role: 'explorer', background: true })
    expect(name).toMatch(/^explorer-\d+$/)
    expect(text).toContain('工具 read、glob、grep')
    expect(text).toContain('它在后台干')

    const record = readRoster().find((entry) => entry.name === name)
    expect(record).toMatchObject({
      role: 'explorer',
      state: 'idle',
      parent: 'lead',
      depth: 1,
      mode: 'continuable',
      sessionId: harness.session.meta.id,
    })
    expect(String(record?.file)).toContain('.teammates')

    const view = (harness.services.get('team') as { list: () => Array<Record<string, unknown>> }).list()
    expect(view.find((item) => item.name === name)).toMatchObject({ role: 'explorer', state: 'idle', rounds: 1 })

    await until(() => harness.followups.length > 0)
    expect(harness.followups[0]?.text).toContain('<teammate-report ')
    expect(harness.followups[0]?.text).toContain('state="已完成"')
    expect(harness.followups[0]?.text).toContain('队友结论第一行')
    expect(harness.followups[0]?.sessionId).toBe(harness.session.meta.id)
    expect(harness.followups[0]?.origin).toBe('notice')
    expect(harness.systems.some((item) => item.text.includes('汇报已并入下一轮'))).toBe(true)
    expect(harness.emitted.some((event) => event['type'] === 'subagent')).toBe(true)
  })

  test('notify=quiet：汇报写进派出会话，不唤醒父 agent', async () => {
    const harness = fakeCtx({ config: { notify: 'quiet' } })
    const { name } = await spawnAndSettle(harness, { role: 'explorer', background: true, name: 'quiet-one' })
    expect(name).toBe('quiet-one')
    await until(() => harness.systems.some((item) => item.text.includes('汇报已写入会话')))
    expect(harness.followups).toHaveLength(0)
    const lastUser = [...harness.session.messages].reverse().find((message) => message.role === 'user')
    expect(String(lastUser?.content)).toContain('<teammate-report ')
  })

  test('前台派活：工具这一轮等结果并原样带回结论与运行记录路径', async () => {
    const harness = fakeCtx()
    const text = String(await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, background: false }))
    expect(text).toContain('干完了')
    expect(text).toContain('第 1 轮')
    expect(text).toContain('运行记录：')
    expect(text).toContain('队友结论第一行')
    expect(harness.followups).toHaveLength(0)
  })

  test('失败分支：流报错 → 状态 failed、错误写进汇报与工具回话', async () => {
    const harness = fakeCtx()
    harness.streamHandler = async () => {
      throw new Error('端点炸了')
    }
    const text = String(
      await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, background: false, name: 'boomer' }),
    )
    expect(text).toContain('失败')
    expect(text).toContain('端点炸了')
    const view = (harness.services.get('team') as { list: () => Array<Record<string, unknown>> }).list()
    expect(view.find((item) => item.name === 'boomer')).toMatchObject({ state: 'failed' })
  })

  test('一次性小工：收工后从在队表摘掉，不接后续消息，但名册保留', async () => {
    const harness = fakeCtx()
    const { name } = await spawnAndSettle(harness, {
      role: 'explorer',
      background: true,
      keep: false,
      name: 'oncer',
    })
    const view = (harness.services.get('team') as { list: () => Array<Record<string, unknown>> }).list()
    expect(view.find((item) => item.name === name)).toMatchObject({ mode: 'one-shot', state: 'idle' })

    const message = String(await runTool(harness, { action: 'message', name, text: '还在吗' }))
    expect(message).toContain('一次性子智能体')
    const stop = String(await runTool(harness, { action: 'interrupt', name }))
    expect(stop).toContain('已经结束了')

    const removed = String(
      await (harness.services.get('team') as { remove: (name: string) => Promise<string> }).remove(name),
    )
    expect(removed).toContain('运行记录一并删除')
    expect(readRoster().some((entry) => entry.name === name)).toBe(false)
  })

  test('传话叫醒收工队友：信箱落盘，并且再干完会补一次汇报', async () => {
    const harness = fakeCtx()
    const { name } = await spawnAndSettle(harness, { role: 'explorer', background: true, name: 'messenger' })
    await until(() => harness.followups.length === 1)

    const said = String(await runTool(harness, { action: 'message', name, text: '再查一下 grep 的用法' }))
    expect(said).toContain('话已投给 messenger')
    const inbox = join(HOME, 'team', 'inbox', 'messenger.jsonl')
    expect(existsSync(inbox)).toBe(true)
    expect(readFileSync(inbox, 'utf8')).toContain('再查一下 grep 的用法')

    await until(() => harness.followups.length >= 2)
    expect(harness.followups[harness.followups.length - 1]?.text).toContain('<teammate-report ')
  })

  test('并发额度按会话算：满载直接拒绝，不排队', async () => {
    const harness = fakeCtx({ config: { maxTeammates: 1 } })
    harness.streamHandler = (_api, request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        harness.release = () => {
          _resolve(okStream('慢慢干完'))
        }
      })
    const first = String(await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, background: true, name: 'busy-one' }))
    expect(first).toContain('已派给 busy-one')
    const second = String(await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, background: true, name: 'busy-two' }))
    expect(second).toContain('已到上限 1 个')
    harness.release()
    await until(() => {
      const view = (harness.services.get('team') as { list: () => Array<{ name: string; state: string }> }).list()
      return view.find((item) => item.name === 'busy-one')?.state !== 'working'
    })
  })

  test('叫停现役队友：保留在名册里，话术与界面管理通道一致', async () => {
    const harness = fakeCtx()
    await spawnAndSettle(harness, { role: 'explorer', background: true, name: 'stoppable' })
    const stopped = String(await runTool(harness, { action: 'stop', name: 'stoppable' }))
    expect(stopped).toContain('已叫停')
    expect(stopped).toContain('保留在名册里')
    const interrupted = String(await runTool(harness, { action: 'interrupt', name: 'stoppable' }))
    expect(interrupted).toContain('这一轮被打断了')
  })
})

describe('任务板与团队服务', () => {
  test('team_task：create/list/get/claim/complete/delete 与版本号校验', async () => {
    const harness = fakeCtx()
    const tool = harness.tools.find((entry) => entry.name === 'team_task') as CapturedTool
    const run = (args: Record<string, unknown>): Promise<string> => tool.run(args, { sessionId: harness.session.meta.id }) as Promise<string>

    expect(String(await run({ action: 'list' }))).toContain('任务板是空的')
    const created = String(await run({ action: 'create', subject: '写测试', description: '覆盖装配面', write_scopes: ['src/'] }))
    expect(created).toContain('已建 t1')
    expect(String(await run({ action: 'get', id: 't9' }))).toContain('任务板上没有 t9')
    expect(String(await run({ action: 'get', id: 't1' }))).toContain('标题：写测试')

    expect(String(await run({ action: 'claim', id: 't1' }))).toContain('expected_revision')
    expect(String(await run({ action: 'claim', id: 't1', expected_revision: 1 }))).toContain('in_progress')
    expect(String(await run({ action: 'complete', id: 't1', expected_revision: 99 }))).toContain('任务板操作没做成')
    expect(String(await run({ action: 'complete', id: 't1', expected_revision: 2 }))).toContain('completed')
    expect(String(await run({ action: 'delete', id: 't1', expected_revision: 3 }))).toContain('任务板第 4 版')
    expect(String(await run({ action: 'list' }))).toContain('任务板是空的')
    expect(String(await run({ action: 'dance' }))).toContain('不认识的 action')
  })

  test('团队服务：list/board/peek 只读查看，peek 拒绝队友目录之外的文件', async () => {
    const harness = fakeCtx()
    const { name } = await spawnAndSettle(harness, { role: 'explorer', background: true, name: 'peeker' })
    const service = harness.services.get('team') as {
      list: () => Array<{ name: string; file: string; sessionId?: string }>
      board: (sessionId: string) => { revision: number; tasks: Array<{ id: string; ready: boolean }> }
      peek: (file: string) => Promise<unknown[]>
    }
    const view = service.list().find((item) => item.name === name)
    expect(view?.sessionId).toBe(harness.session.meta.id)

    const tool = harness.tools.find((entry) => entry.name === 'team_task') as CapturedTool
    await tool.run({ action: 'create', subject: '看板任务' }, { sessionId: harness.session.meta.id })
    const board = service.board(harness.session.meta.id)
    expect(board.tasks[0]).toMatchObject({ id: 't1', ready: true })

    await waitFile(String(view?.file))
    const entries = await service.peek(String(view?.file))
    expect(Array.isArray(entries)).toBe(true)
    await expect(service.peek(join(WORKSPACE, 'nope.jsonl'))).rejects.toThrow(/只能看队友的运行记录/)
  })

  test('团队服务 remove：还在干活时拒绝；收工后移除并删运行记录', async () => {
    const harness = fakeCtx()
    harness.streamHandler = (_api, request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        harness.release = () => _resolve(okStream('收工'))
      })
    await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, background: true, name: 'removable' })
    const service = harness.services.get('team') as { remove: (name: string) => Promise<string> }
    expect(String(await service.remove('removable'))).toContain('还在干活')
    harness.release()
    await until(() => {
      const view = (harness.services.get('team') as { list: () => Array<{ name: string; state: string }> }).list()
      return view.find((item) => item.name === 'removable')?.state === 'idle'
    })
    expect(String(await service.remove('removable'))).toContain('运行记录一并删除')
    expect(String(await service.remove('removable'))).toContain('名册里没有')
  })
})

describe('审查通道与守卫', () => {
  const scope = {
    target: { kind: 'worktree' as const },
    label: '未提交改动',
    diffPath: join(WORKSPACE, 'review.diff'),
    diffBytes: 12,
    stat: ' a.ts | 1 +',
    untracked: [],
  }

  test('/review 通道：派只读审查员、running→finished、findings 写回发起会话', async () => {
    const harness = fakeCtx()
    const review = harness.services.get('review') as {
      spawn: (request: unknown) => { ok: boolean; name?: string; reason?: string }
      status: () => Record<string, unknown> | null
      cancel: () => boolean
    }
    const spawned = review.spawn({ scope, focus: '看并发' })
    expect(spawned.ok).toBe(true)
    const name = String(spawned.name)
    expect(name).toMatch(/^reviewer-/)
    expect(review.status()).toMatchObject({ state: 'running', target: '未提交改动' })

    await until(() => review.status()?.state === 'finished')
    expect(review.status()).toMatchObject({ state: 'finished', findings: '队友结论第一行\n第二行' })
    const lastUser = [...harness.session.messages].reverse().find((message) => message.role === 'user')
    expect(String(lastUser?.content)).toContain('<review-findings ')
    expect(String(lastUser?.content)).toContain('state="已完成"')
    expect(harness.systems.some((item) => item.text.includes('findings 已写进会话'))).toBe(true)
  })

  test('/review 取消：叫停队友并把记录标成取消', async () => {
    const harness = fakeCtx()
    harness.streamHandler = (_api, request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const review = harness.services.get('review') as {
      spawn: (request: unknown) => { ok: boolean }
      status: () => Record<string, unknown> | null
      cancel: () => boolean
    }
    expect(review.spawn({ scope, focus: '' }).ok).toBe(true)
    expect(review.cancel()).toBe(true)
    expect(review.status()).toMatchObject({ state: 'finished', findings: '审查被取消。' })
    await until(() => {
      const lastUser = [...harness.session.messages].reverse().find((message) => message.role === 'user')
      return String(lastUser?.content).includes('<review-findings ')
    })
    const lastUser = [...harness.session.messages].reverse().find((message) => message.role === 'user')
    expect(String(lastUser?.content)).toContain('审查被取消。')
  })

  test('teammate-mode：非队友会话 defer；按父会话模式拒绝越界写', async () => {
    const harness = fakeCtx()
    await spawnAndSettle(harness, { role: 'explorer', background: true, name: 'guarded' })
    const guard = harness.guards.find((item) => item.id === 'teammate-mode') as Harness['guards'][number]
    expect(await guard.decide({ toolName: 'write', risk: 'write', cwd: WORKSPACE, sessionId: 'someone-else' })).toEqual({
      action: 'defer',
    })

    harness.session.setState('mode', 'explore')
    const denied = (await guard.decide({
      toolName: 'write',
      risk: 'write',
      cwd: WORKSPACE,
      target: join(WORKSPACE, 'a.txt'),
      sessionId: 'someone-else',
      teammate: 'guarded',
    })) as { action: string; reason: string }
    expect(denied.action).toBe('deny')
    expect(denied.reason).toContain('父会话在「探索」模式')

    const read = (await guard.decide({
      toolName: 'read',
      risk: 'read',
      cwd: WORKSPACE,
      sessionId: 'someone-else',
      teammate: 'guarded',
    })) as { action: string }
    expect(read.action).toBe('pass')
  })

  test('teammate-approval：非队友 defer；后台队友在 foreground 上限下不许问', async () => {
    const plain = fakeCtx()
    const plainGuard = plain.guards.find((item) => item.id === 'teammate-approval') as Harness['guards'][number]
    expect(await plainGuard.decide({ toolName: 'bash', risk: 'exec', cwd: WORKSPACE, sessionId: 'x', args: {} })).toEqual({
      action: 'defer',
    })

    const harness = fakeCtx({ config: { approval: 'foreground' } })
    await spawnAndSettle(harness, { role: 'writer', background: true, name: 'bg-writer' })
    const guard = harness.guards.find((item) => item.id === 'teammate-approval') as Harness['guards'][number]
    const denied = (await guard.decide({
      toolName: 'bash',
      risk: 'exec',
      cwd: WORKSPACE,
      sessionId: 'x',
      args: { command: 'pnpm test' },
      teammate: 'bg-writer',
    })) as { action: string }
    expect(denied.action).toBe('deny')
  })

  test('teammate-approval：ask 上限下弹卡，卡上写清队友名字与父会话归属', async () => {
    const harness = fakeCtx({ config: { approval: 'ask' } })
    await spawnAndSettle(harness, { role: 'writer', background: true, name: 'ask-writer' })
    const guard = harness.guards.find((item) => item.id === 'teammate-approval') as Harness['guards'][number]
    const verdict = (await guard.decide({
      toolName: 'bash',
      risk: 'exec',
      cwd: WORKSPACE,
      sessionId: 'x',
      args: { command: 'pnpm test' },
      teammate: 'ask-writer',
    })) as { action: string }
    expect(verdict.action).toBe('pass')
    expect(harness.decisions[0]).toMatchObject({ sessionId: harness.session.meta.id })
    expect(String(harness.decisions[0]?.['toolName'])).toContain('队友 ask-writer')
  })

  test('会话归属解析器：只认在队队友的运行记录，出队后失效', async () => {
    const harness = fakeCtx()
    const { name } = await spawnAndSettle(harness, { role: 'explorer', background: true, name: 'resolved' })
    const view = (harness.services.get('team') as { list: () => Array<{ name: string; file: string }> }).list()
    const file = String(view.find((item) => item.name === name)?.file)
    await waitFile(file)
    const teammateSession = SessionClass.load(file, true, { lease: false })
    try {
      const resolver = harness.resolverFns[0]!
      const fact = resolver(teammateSession.meta.id) as Record<string, unknown> | undefined
      expect(fact).toMatchObject({
        sessionId: harness.session.meta.id,
        sessionPath: harness.session.filePath,
        facts: { teammate: name, teammateSessionId: teammateSession.meta.id },
      })
      expect(resolver('not-a-teammate')).toBeUndefined()
    } finally {
      teammateSession.close()
    }
  })

  test('卸载：disposer 撤掉工具并叫停、关闭在跑的队友', async () => {
    const harness = fakeCtx()
    harness.streamHandler = (_api, request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, background: true, name: 'doomed' })
    expect(harness.tools.some((tool) => tool.name === 'subagent')).toBe(true)
    expect(() => harness.cleanup()).not.toThrow()
    expect(harness.tools.some((tool) => tool.name === 'subagent')).toBe(false)
    expect(harness.tools.some((tool) => tool.name === 'team_task')).toBe(false)
    expect(harness.prompts).toHaveLength(0)
    expect(harness.sections).toHaveLength(0)
  })
})
