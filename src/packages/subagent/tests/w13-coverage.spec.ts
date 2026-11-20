/**
 * W13 覆盖率补齐（subagent 侧）：把 `index.ts` 里「只有真跑才走得到」的边角补上。
 *
 * 覆盖目标（按 `coverage/packages/subagent/index.ts.html` 的未覆盖行）：
 *   - `resolveSpawnOverrides` 的模型 / 思考强度校验分支；
 *   - 提示段里的模型授权说明（开关打开 + 清单空 / 非空两种）；
 *   - 任务板的 create claim_now / get 带进展 / block 的额外行；
 *   - 看板快照的「活动丢光 → 任务丢光 → 硬截断」三段降级；
 *   - `team_message` 的 inbox / 配额 / 广播 / 点名 / 投给 Lead 两条路；
 *   - `TeamService.open` 的现役 / 名册缺失 / 非队友文件 / 一次性 / 复活（含老名册兜底）；
 *   - `TeamService.stopBySession`；
 *   - `context: 'fork'` 的父会话切点（`forkSeedLines`）；
 *   - `team_task` 的绑定失败三分支（不存在 / 已被认领 / 依赖没完成）；
 *   - 队友工具调用经过 `teammateGuardChain`（共享守卫链的改写与标记）；
 *   - 嵌套派活（队友再派队友）与归属会话上溯；
 *   - `agent-roles.ts` 的坏文件 / 迁移 / 非法值分支。
 *
 * 这里跑真 `apply`、真会话文件、真 MiniAgent，只替换模型端点与宿主表面（同
 * `wiring.spec.ts` 的夹具口径）。`DSC_HOME` 在 import 被测模块之前指向临时目录。
 *
 * @module dsc/packages/subagent/tests/w13-coverage.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-subagent-w13-'))
process.env['DSC_HOME'] = HOME

/** 临时工作区：队友按父会话的 cwd 干活，这里只需要不是一个 git 仓库。 */
const WORKSPACE = mkdtempSync(join(tmpdir(), 'dsc-subagent-w13-cwd-'))

type Plugin = typeof import('../index.js')['subagentPlugin']
type SessionT = import('../../../core/session.js').Session
type SessionModule = typeof import('../../../core/session.js')
type IndexModule = typeof import('../index.js')
type RolesModule = typeof import('../agent-roles.js')
type BoardModule = typeof import('../board-snapshot.js')
type TeamBoardT = import('@pneuma/runtime/core/team-board.js').TeamBoard

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

interface CapturedProjection {
  id: string
  apply: (messages: ChatMessageLike[], session?: unknown, report?: (view: Record<string, unknown>) => void) => ChatMessageLike[]
  options?: { order?: number }
}

interface CapturedSection {
  id: string
  order?: number
  fields: () => Array<Record<string, unknown>>
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

interface Harness {
  ctx: Record<string, unknown>
  tools: CapturedTool[]
  prompts: CapturedPrompt[]
  projections: CapturedProjection[]
  sections: CapturedSection[]
  services: Map<string, unknown>
  guards: Array<{ id: string; order: number; decide: (input: Record<string, unknown>) => Promise<unknown> }>
  resolverFns: Array<(sessionId: string) => unknown>
  systems: Array<{ text: string; sessionId?: string }>
  emitted: Array<Record<string, unknown>>
  events: Array<{ name: string; args: unknown[] }>
  followups: Array<{ text: string; sessionId?: string; origin?: string }>
  decisions: Array<Record<string, unknown>>
  routeCalls: Array<{ provider: string; model: string; effort: string }>
  /** 共享守卫链上真实收到的 gate 入参（队友改写后应带 `teammate` 标记）。 */
  gates: Array<Record<string, unknown>>
  observes: Array<{ toolName: string; text: string }>
  /** 界面 `ctx.session.open` 被打开的文件。 */
  opened: string[]
  /** `ctx.agent.attach` 记下的会话 id → 会话对象。 */
  attached: Map<string, unknown>
  /** 内核会话表里「还有 agent」的会话 id 集合（默认空 = 都已收摊）。 */
  resident: Set<string>
  touches: number
  session: SessionT
  setSession: (session: SessionT) => void
  section: CapturedSection
  cleanup: () => void
  streamHandler: (api: string, request: StreamRequestLike, handlers: StreamHandlersLike) => Promise<StreamResultLike>
  release: () => void
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
let indexModule: IndexModule
let rolesModule: RolesModule
let boardModule: BoardModule
const cleanups: Array<() => void> = []
const dirs: string[] = [HOME, WORKSPACE]

beforeAll(async () => {
  SessionClass = (await import('../../../core/session.js')).Session
  indexModule = await import('../index.js')
  rolesModule = await import('../agent-roles.js')
  boardModule = await import('../board-snapshot.js')
  plugin = indexModule.subagentPlugin
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

/** 手改名册后把 mtime 推到未来：插件按 mtime 做读缓存，同毫秒内改写会被当成「没动」。 */
let rosterMtimeBump = 0
function bumpRosterMtime(): void {
  rosterMtimeBump += 1000
  const when = new Date(Date.now() + rosterMtimeBump)
  utimesSync(join(HOME, 'team', 'roster.json'), when, when)
}

/** 往名册里追加/替换一条记录（模拟「别的进程写过名册」或老版本留下的记录）。 */
function putRosterRecord(record: Record<string, unknown>): void {
  const rest = readRoster().filter((entry) => entry['name'] !== record['name'])
  writeJson(join(HOME, 'team', 'roster.json'), { teammates: [...rest, record] })
  bumpRosterMtime()
}

/** 真 Session：父会话是队友归属、汇报落点与 fork 种子的来源。 */
function newSession(cwd = WORKSPACE): SessionT {
  const file = join(HOME, 'sessions', `parent-${String(Date.now())}-${String(Math.random()).slice(2)}.jsonl`)
  return SessionClass.create(cwd, file)
}

async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待条件超时')
}

/** 等一个会话文件的 meta 首行落盘（写流是异步的，`isTeammateSessionFile` 只读首行）。 */
async function waitMeta(file: string): Promise<void> {
  await until(() => {
    try {
      const first = JSON.parse(readFileSync(file, 'utf8').split('\n')[0] ?? '') as { type?: string; origin?: string }
      return first.type === 'meta' && first.origin === 'subagent'
    } catch {
      return false
    }
  })
}

/**
 * 假 ctx：把插件用到的挂载点全实现，`effect` 真跑回调。
 * 与 `wiring.spec.ts` 同形，多记三样 W13 要断言的东西：共享守卫链接到的入参、
 * 界面打开的会话文件、内核会话表里「常驻 / 已收摊」。
 */
function fakeCtx(options: { config?: Record<string, unknown>; decision?: 'allow-once' | 'reject' } = {}): Harness {
  const tools: CapturedTool[] = []
  const prompts: CapturedPrompt[] = []
  const projections: CapturedProjection[] = []
  const sections: CapturedSection[] = []
  const services = new Map<string, unknown>()
  const guards: Harness['guards'] = []
  const resolverFns: Harness['resolverFns'] = []
  const systems: Harness['systems'] = []
  const emitted: Harness['emitted'] = []
  const events: Harness['events'] = []
  const followups: Harness['followups'] = []
  const decisions: Harness['decisions'] = []
  const routeCalls: Harness['routeCalls'] = []
  const gates: Harness['gates'] = []
  const observes: Harness['observes'] = []
  const opened: string[] = []
  const attached = new Map<string, unknown>()
  const resident = new Set<string>()
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
    session: {
      current: () => harness.session,
      open: async (file: string) => {
        opened.push(file)
      },
    },
    emit(name: string, ...args: unknown[]) {
      events.push({ name, args })
    },
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
      registerProjection(id: string, apply: CapturedProjection['apply'], opts?: { order?: number }) {
        const item = { id, apply, ...(opts === undefined ? {} : { options: opts }) } as CapturedProjection
        projections.push(item)
        return () => {
          const index = projections.indexOf(item)
          if (index >= 0) projections.splice(index, 1)
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
      routeTo: (provider: string, model: string, effort: string) => {
        routeCalls.push({ provider, model, effort })
        return ROUTE
      },
      providerOf: () => 'fake',
      modelOf: () => 'fake/model',
      parseModelRef: (ref: string) => {
        const at = ref.indexOf('/')
        return at > 0 ? { provider: ref.slice(0, at), model: ref.slice(at + 1) } : { provider: 'fake', model: ref }
      },
      listModels: () => [
        {
          value: 'fake/model',
          provider: 'fake',
          providerDisplayName: 'Fake',
          model: 'model',
          description: 'Fake · 32k 上下文',
          contextWindow: 32000,
          thinkingLevels: [],
          modalities: ['text'],
        },
      ],
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
      gate: async (input: Record<string, unknown>) => {
        gates.push(input)
        return { action: 'defer' }
      },
      observe: (toolName: string, text: string) => {
        observes.push({ toolName, text })
      },
    },
    agent: {
      sessionById: (id: string) => (harness.session.meta.id === id ? harness.session : undefined),
      hasAgent: (id: string) => resident.has(id),
      attach: (session: { meta: { id: string } }, driver?: unknown) => {
        attached.set(session.meta.id, driver)
      },
      detach: (sessionId: string) => {
        attached.delete(sessionId)
      },
      acceptsInput: (sessionId: string) => attached.has(sessionId),
      followup: (text: string, _images?: unknown, sessionId?: string, origin?: string) => {
        followups.push({ text, ...(sessionId === undefined ? {} : { sessionId }), ...(origin === undefined ? {} : { origin }) })
      },
    },
  }

  for (const name of ['read', 'glob', 'grep']) {
    tools.push({ name, description: name, risk: 'read', parameters: {}, run: () => name })
  }

  harness.ctx = ctx
  harness.tools = tools
  harness.prompts = prompts
  harness.projections = projections
  harness.sections = sections
  harness.services = services
  harness.guards = guards
  harness.resolverFns = resolverFns
  harness.systems = systems
  harness.emitted = emitted
  harness.events = events
  harness.followups = followups
  harness.decisions = decisions
  harness.routeCalls = routeCalls
  harness.gates = gates
  harness.observes = observes
  harness.opened = opened
  harness.attached = attached
  harness.resident = resident
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

function subagentTool(harness: Harness): CapturedTool {
  const tool = harness.tools.find((entry) => entry.name === 'subagent')
  expect(tool, 'default 配置下应当注册 subagent 工具').toBeDefined()
  return tool as CapturedTool
}

function teamService(harness: Harness): Record<string, (...args: never[]) => unknown> & {
  list: () => Array<Record<string, unknown>>
  board: (sessionId: string) => TeamBoardT
  open: (name: string) => Promise<void>
  stopBySession: (sessionId: string) => Promise<string[]>
  message: (name: string, text: string) => Promise<string>
  remove: (name: string) => Promise<string>
} {
  return harness.services.get('team') as never
}

function tool(harness: Harness, name: string): CapturedTool {
  const found = harness.tools.find((entry) => entry.name === name)
  expect(found, `应当注册 ${name} 工具`).toBeDefined()
  return found as CapturedTool
}

function runTool(harness: Harness, args: Record<string, unknown>): Promise<string> | string {
  return subagentTool(harness).run(args, {
    cwd: harness.session.meta.cwd,
    signal: new AbortController().signal,
    sessionId: harness.session.meta.id,
  })
}

/** 跑任务板 / 团队消息工具：归属当前会话，署名可按用例给。 */
function runTeamTool(
  harness: Harness,
  name: 'team_task' | 'team_message',
  args: Record<string, unknown>,
  caller?: string,
): Promise<string> | string {
  return tool(harness, name).run(args, {
    sessionId: harness.session.meta.id,
    ...(caller === undefined ? {} : { caller: { name: caller, depth: 1, background: true, sessionId: harness.session.meta.id } }),
  })
}

/** 派一个后台队友并等它收工。 */
async function spawnAndSettle(
  harness: Harness,
  args: Record<string, unknown>,
): Promise<{ name: string; text: string }> {
  const text = String(await runTool(harness, { action: 'spawn', background: true, task: TASK, ...args }))
  const matched = /已派给 ([a-z0-9-]+)/.exec(text)
  const name = matched?.[1] ?? String(args['name'] ?? '')
  await until(() => {
    const view = teamService(harness).list()
    const found = view.find((item) => item['name'] === name)
    return found !== undefined && found['state'] !== 'working'
  })
  return { name, text }
}

const TASK = '请统计仓库里有多少个测试文件并给出结论，附证据位置'

// ── 1. 纯函数：spawn 的 model / effort 校验 ─────────────────────────────────
describe('resolveSpawnOverrides', () => {
  const parseModelRef = (ref: string) => {
    const at = ref.indexOf('/')
    return at > 0 ? { provider: ref.slice(0, at), model: ref.slice(at + 1) } : { provider: 'fake', model: ref }
  }
  const run = (...args: Parameters<IndexModule['resolveSpawnOverrides']>): ReturnType<IndexModule['resolveSpawnOverrides']> =>
    indexModule.resolveSpawnOverrides(...args)

  test('不带 model / effort 原样通过；非字符串一律按没填', () => {
    expect(run(undefined, undefined, { allow: false, allowed: [] }, parseModelRef)).toEqual({ ok: true, model: null, effort: null })
    expect(run(42, 7, { allow: false, allowed: [] }, parseModelRef)).toEqual({ ok: true, model: null, effort: null })
  })

  test('开关没开时带 model 直接拒绝，话说清楚去设置里打开', () => {
    const denied = run('fake/model', undefined, { allow: false, allowed: [] }, parseModelRef)
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.reason).toContain('用户还没打开')
      expect(denied.reason).toContain('不能指定模型')
    }
  })

  test('开关打开：裸模型名补端点后落进授权清单才算通过', () => {
    // parseModelRef 给裸名补当前端点（fake）→ 归一成 fake/model，正在清单里。
    expect(run('model', undefined, { allow: true, allowed: ['fake/model'] }, parseModelRef)).toEqual({
      ok: true,
      model: 'fake/model',
      effort: null,
    })
    // 端点 + 模型都给的写法同一个结果。
    expect(run('fake/model', undefined, { allow: true, allowed: ['fake/model'] }, parseModelRef)).toEqual({
      ok: true,
      model: 'fake/model',
      effort: null,
    })
  })

  test('parseModelRef 的 model 为空时用端点名当值（子代理实现不编造模型）', () => {
    expect(run('fake', undefined, { allow: true, allowed: ['fake'] }, () => ({ provider: 'fake', model: '' }))).toEqual({
      ok: true,
      model: 'fake',
      effort: null,
    })
  })

  test('清单为空 / 不在清单：两种理由分开说，给出可选的清单', () => {
    const empty = run('fake/model', undefined, { allow: true, allowed: [] }, parseModelRef)
    expect(empty.ok).toBe(false)
    if (!empty.ok) {
      expect(empty.reason).toContain('不在用户授权的清单里')
      expect(empty.reason).toContain('一个都没授权')
    }
    const notListed = run('fake/model', undefined, { allow: true, allowed: ['other/model'] }, parseModelRef)
    expect(notListed.ok).toBe(false)
    if (!notListed.ok) expect(notListed.reason).toContain('可选的：other/model')
  })

  test('effort 只认 EFFORT_LEVELS：非法值拒绝并列出可选值，合法值原样带走', () => {
    const bad = run(undefined, 'turbo', { allow: false, allowed: [] }, parseModelRef)
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.reason).toContain('不认识的 effort')
      expect(bad.reason).toContain('high')
    }
    expect(run(undefined, ' high ', { allow: false, allowed: [] }, parseModelRef)).toEqual({ ok: true, model: null, effort: 'high' })
  })
})

// ── 2. 提示段里的模型授权说明 ───────────────────────────────────────────────
describe('提示段：模型授权说明', () => {
  test('开关打开但清单为空：明确提示先去勾选', () => {
    const harness = fakeCtx({ config: { allowModelSelection: true } })
    const prompt = harness.prompts.find((entry) => entry.id === 'subagent') as CapturedPrompt
    expect(prompt.render()).toContain('还没有授权任何模型')
  })

  test('开关打开且清单非空：把授权清单原样告诉模型', () => {
    const harness = fakeCtx({ config: { allowModelSelection: true, allowedModels: ['fake/model', 'fake/other'] } })
    const prompt = harness.prompts.find((entry) => entry.id === 'subagent') as CapturedPrompt
    const text = prompt.render()
    expect(text).toContain('fake/model、fake/other')
    expect(text).toContain('spawn 时可以用 model')
  })
})

// ── 3. 任务板：claim_now / 进展 / 阻塞的额外输出 ────────────────────────────
describe('team_task 补充分支', () => {
  test('create claim_now：建完直接进 in_progress；get 带进展；block 报告卡住原因', async () => {
    const harness = fakeCtx()
    const service = teamService(harness)
    const revision = (): number => service.board(harness.session.meta.id).revision

    const created = String(await runTeamTool(harness, 'team_task', { action: 'create', subject: '先做这个' }))
    expect(created).toContain('已建 t1')
    await runTeamTool(harness, 'team_task', { action: 'claim', id: 't1', expected_revision: revision() })
    await runTeamTool(harness, 'team_task', { action: 'note', id: 't1', expected_revision: revision(), text: '做了一半' })

    const got = String(await runTeamTool(harness, 'team_task', { action: 'get', id: 't1' }))
    expect(got).toContain('做了一半')
    expect(got).toContain('进展（1 条')

    const blocked = String(
      await runTeamTool(harness, 'team_task', { action: 'block', id: 't1', expected_revision: revision(), text: '等依赖' }),
    )
    expect(blocked).toContain('卡住原因：等依赖')

    const claimedNow = String(
      await runTeamTool(harness, 'team_task', { action: 'create', subject: '直接开工', claim_now: true }),
    )
    expect(claimedNow).toContain('状态直接进 in_progress')
    expect(claimedNow).toContain('认领人')
  })
})

// ── 4. 看板快照的三段降级 ──────────────────────────────────────────────────
describe('boardSnapshotText 截断降级', () => {
  test('活动丢光、任务丢光后仍在超限：硬截断并接上提示', () => {
    const long = '很长的一段看板内容'.repeat(30)
    const task = (id: string): Record<string, unknown> => ({
      id,
      subject: long,
      description: '',
      status: 'todo',
      owner: null,
      assignee: null,
      blockedBy: [],
      blockedReason: null,
      writeScopes: [],
      notes: [{ at: Date.now(), by: 'lead', text: long }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const board = {
      revision: 9,
      tasks: Array.from({ length: 10 }, (_, index) => task(`t${String(index + 1)}`)),
      activity: Array.from({ length: 8 }, (_, index) => ({
        at: Date.now() - index,
        kind: 'note',
        by: 'lead',
        text: long,
      })),
    } as unknown as TeamBoardT
    const text = boardModule.boardSnapshotText(board)
    expect(text).toContain('快照已截断')
    expect(text).toContain(boardModule.BOARD_SNAPSHOT_HEAD)
    // 硬截断后不会超过上限（尾部提示之外不再有正文）。
    expect(text.length).toBeLessThanOrEqual(boardModule.BOARD_SNAPSHOT_LIMITS.chars + 200)
  })
})

// ── 5. team_message ────────────────────────────────────────────────────────
describe('team_message', () => {
  test('inbox / 未知 action / 空正文 / 超长正文', async () => {
    const harness = fakeCtx()
    expect(String(await runTeamTool(harness, 'team_message', { action: 'inbox' }))).toContain('你的信箱是空的')
    expect(String(await runTeamTool(harness, 'team_message', { action: 'dance' }))).toContain('不认识的 action')
    expect(String(await runTeamTool(harness, 'team_message', { action: 'send', to: 'lead', text: '  ' }))).toContain('要带上 text')
    const long = 'x'.repeat(9000)
    expect(String(await runTeamTool(harness, 'team_message', { action: 'send', to: 'lead', text: long }))).toContain('最长 8000 字')
  })

  test('投给 Lead 两条路：有常驻 agent 进下一轮，否则写进会话', async () => {
    const harness = fakeCtx()
    // 没有常驻 agent：appendUser 写进父会话。
    const written = String(await runTeamTool(harness, 'team_message', { action: 'send', to: 'lead', text: '来自队友的话' }, 'mate-x'))
    expect(written).toContain('写入会话')
    expect(String([...harness.session.messages].reverse().find((message) => message.role === 'user')?.content)).toContain('来自队友的话')
    // 有常驻 agent：走 followup（标 notice）。
    harness.resident.add(harness.session.meta.id)
    const pushed = String(await runTeamTool(harness, 'team_message', { action: 'send', to: 'lead', text: '第二句' }, 'mate-x'))
    expect(pushed).toContain('已并入它的下一轮')
    expect(harness.followups.some((item) => item.text.includes('第二句') && item.origin === 'notice')).toBe(true)
  })

  test('广播：投给同会话在队队友并记进看板活动；点名字收不到的进 missed', async () => {
    const harness = fakeCtx()
    const { name } = await spawnAndSettle(harness, { role: 'explorer', name: 'mate-b', background: true })
    const broadcast = String(await runTeamTool(harness, 'team_message', { action: 'broadcast', text: '大家停一下' }))
    expect(broadcast).toContain('已广播给 1 个对象')
    expect(broadcast).toContain(name)
    // 看板活动里有这条消息（kind=message）。
    const activity = harness.services.get('team') as { board: (id: string) => { activity: Array<{ kind: string; text: string }> } }
    const entries = activity.board(harness.session.meta.id).activity
    expect(entries.some((entry) => entry.kind === 'message' && entry.text.includes('大家停一下'))).toBe(true)

    const missed = String(await runTeamTool(harness, 'team_message', { action: 'send', to: 'ghost-mate', text: '你在吗' }))
    expect(missed).toContain('没人会读')
    // 投给自己被拒。
    expect(String(await runTeamTool(harness, 'team_message', { action: 'send', to: 'lead', text: 'hi' }))).toContain('收件人就是你自己')
  })

  test('广播没有对象时说清楚；队友发消息有每轮额度，用完拒绝', async () => {
    const empty = fakeCtx()
    expect(String(await runTeamTool(empty, 'team_message', { action: 'broadcast', text: '有人吗' }))).toContain('没有可发的对象')

    const harness = fakeCtx()
    const { name } = await spawnAndSettle(harness, { role: 'explorer', name: 'quota-one', background: true })
    const send = async (text: string): Promise<string> =>
      String(await runTeamTool(harness, 'team_message', { action: 'send', to: 'lead', text }, name))
    expect(await send('第一条')).toContain('本轮还剩 2 条额度')
    expect(await send('第二条')).toContain('本轮还剩 1 条额度')
    expect(await send('第三条')).toContain('本轮还剩 0 条额度')
    expect(await send('第四条')).toContain('每轮上限 3 条')
  })
})

// ── 6. TeamService.open / 复活 / stopBySession ─────────────────────────────
describe('团队服务：打开与复活', () => {
  test('现役队友直接打开会话；名册里没有 / 不是队友记录时给提示', async () => {
    const harness = fakeCtx()
    const { name } = await spawnAndSettle(harness, { role: 'explorer', name: 'openable', background: true })
    await teamService(harness).open(name)
    expect(harness.opened.some((file) => file.includes('sessions'))).toBe(true)

    await teamService(harness).open('nobody')
    expect(harness.events.some((event) => String(event.args[0]).includes('名册里没有'))).toBe(true)
  })

  test('非队友路径 / 一次性 / 复活失败：都退回按记录打开', async () => {
    const harness = fakeCtx()
    const { name } = await spawnAndSettle(harness, { role: 'explorer', name: 'rec-source', background: true })
    const record = readRoster().find((entry) => entry.name === name) as Record<string, unknown>
    const realFile = String(record['file'])
    await waitMeta(realFile)

    putRosterRecord({ ...record, name: 'outsider', file: join(WORKSPACE, 'outsider.jsonl') })
    await teamService(harness).open('outsider')
    expect(harness.events.some((event) => String(event.args[0]).includes('这不是队友的运行记录'))).toBe(true)

    putRosterRecord({ ...record, name: 'oncer-rec', mode: 'one-shot', sessionId: harness.session.meta.id })
    await teamService(harness).open('oncer-rec')
    expect(harness.opened).toContain(realFile)

    // 角色不存在且老名册没有冻结工牌：复活不了，按记录打开。
    putRosterRecord({ ...record, name: 'legacy-gone', role: 'no-such-role', sessionId: harness.session.meta.id, badge: undefined, prompt: undefined })
    await teamService(harness).open('legacy-gone')
    expect(harness.opened).toContain(realFile)

    // 派出它的会话不在本窗口：提示只读打开。
    putRosterRecord({ ...record, name: 'orphan', sessionId: 'other-session-id' })
    await teamService(harness).open('orphan')
    expect(harness.events.some((event) => String(event.args[0]).includes('不在本窗口'))).toBe(true)
  })

  test('复活收工的队友：冻结工牌与说明书原样重建，老名册则按角色名现读', async () => {
    const harness = fakeCtx()
    const { name } = await spawnAndSettle(harness, { role: 'explorer', name: 'revive-src', background: true })
    const record = readRoster().find((entry) => entry.name === name) as Record<string, unknown>
    await waitMeta(String(record['file']))

    // 造一条没人占写租约的队友记录（真会话文件 + meta 标 origin=subagent）：复活会 Session.load 它。
    const sessionModule = await import('../../../core/session.js')
    const revivedId = `revived-${String(Math.random()).slice(2, 8)}`
    const revivedFile = join(sessionModule.sessionsRoot(), sessionModule.slugCwd(WORKSPACE), `${revivedId}.jsonl`)
    mkdirSync(dirname(revivedFile), { recursive: true })
    writeFileSync(
      revivedFile,
      [
        JSON.stringify({ type: 'meta', id: revivedId, origin: 'subagent', parentSession: harness.session.meta.id, cwd: WORKSPACE, createdAt: Date.now() }),
        JSON.stringify({ type: 'assistant', text: '复活前的结论', reasoning: '', ts: Date.now() }),
      ].join('\n') + '\n',
      'utf8',
    )

    // 冻结工牌 + 说明书的记录：直接按名册复活（文件换成没人占的那条）。
    putRosterRecord({ ...record, name: 'revived-frozen', file: revivedFile, sessionId: harness.session.meta.id })
    await teamService(harness).open('revived-frozen')
    const view = teamService(harness).list().find((item) => item['name'] === 'revived-frozen')
    expect(view).toMatchObject({ role: 'explorer', state: 'idle', mode: 'continuable' })
    // 复活会重新 attach（输入框能说话）：派活那位 + 复活这位。
    expect(harness.attached.size).toBeGreaterThanOrEqual(2)

    // 老名册（没有 badge/prompt）：按角色名现读一份。
    putRosterRecord({
      name: 'revived-legacy',
      role: 'explorer',
      state: 'idle',
      task: '老的活',
      file: revivedFile,
      cwd: WORKSPACE,
      parent: 'lead',
      depth: 1,
      rounds: 1,
      startedAt: Date.now(),
      mode: 'continuable',
      sessionId: harness.session.meta.id,
    })
    await teamService(harness).open('revived-legacy')
    expect(teamService(harness).list().some((item) => item['name'] === 'revived-legacy')).toBe(true)
  })

  test('stopBySession：停掉这条会话派出的队友并回名单，别的会话为空', async () => {
    const harness = fakeCtx()
    // 不等收工：正在干的也要能停。
    const text = String(await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, background: true, name: 'by-session' }))
    expect(text).toContain('已派给 by-session')
    const stopped = await teamService(harness).stopBySession(harness.session.meta.id)
    expect(stopped).toEqual(['by-session'])
    expect(await teamService(harness).stopBySession('other-session')).toEqual([])
  })
})

// ── 7. fork 的父会话切点 ───────────────────────────────────────────────────
describe('context: fork 的种子', () => {
  test('父会话有完整回合时带上前缀；队友记录里看得到父会话的结论', async () => {
    const harness = fakeCtx()
    harness.session.appendAssistant('父会话的决策结论', '', [])
    // 父会话日志是异步写盘：先等它落盘，否则 `forkSeedLines` 读到空文件会按「没有完整回合」拒绝。
    await until(() => {
      try {
        return readFileSync(harness.session.filePath, 'utf8').includes('父会话的决策结论')
      } catch {
        return false
      }
    })
    const { name, text } = await spawnAndSettle(harness, {
      role: 'explorer',
      name: 'forked',
      background: true,
      context: 'fork',
    })
    expect(text).toContain('已派给 forked')
    const record = readRoster().find((entry) => entry.name === name) as Record<string, unknown>
    const raw = readFileSync(String(record['file']), 'utf8')
    expect(raw).toContain('父会话的决策结论')
    expect(raw).toContain('"type":"meta"')
  })
})

// ── 8. spawn 绑定任务失败的三个分支 ────────────────────────────────────────
describe('spawn 绑定 task_id 的拒绝分支', () => {
  test('任务不存在 / 已被别人认领 / 依赖没完成', async () => {
    const harness = fakeCtx()
    const board = (): TeamBoardT => teamService(harness).board(harness.session.meta.id)

    expect(String(await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, task_id: 't404' }))).toContain('任务板上没有 t404')

    await runTeamTool(harness, 'team_task', { action: 'create', subject: '先认掉' })
    await runTeamTool(harness, 'team_task', { action: 'claim', id: 't1', expected_revision: board().revision, owner: 'other-guy' })
    expect(String(await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, task_id: 't1', name: 'want-t1' }))).toContain('已经被 other-guy 认领')

    await runTeamTool(harness, 'team_task', { action: 'create', subject: '前置任务' })
    await runTeamTool(harness, 'team_task', {
      action: 'create',
      subject: '依赖任务',
      blocked_by: ['t2'],
    })
    expect(String(await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, task_id: 't3', name: 'want-t3' }))).toContain('还在等依赖')
  })
})

// ── 9. 队友工具调用走共享守卫链 ────────────────────────────────────────────
describe('队友的守卫链', () => {
  test('队友调工具：gate 入参被改写成归属会话并带上 teammate 标记，observe 也转发', async () => {
    const harness = fakeCtx()
    let call = 0
    harness.streamHandler = async (_api, _request, handlers) => {
      call += 1
      if (call === 1) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' }],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'tool_calls',
        }
      }
      handlers.onDelta?.('text', '看完 a.ts 了\n')
      return okStream('看完 a.ts 了')
    }
    const { name } = await spawnAndSettle(harness, { role: 'explorer', name: 'guard-runner', background: true })

    expect(harness.gates.length).toBeGreaterThan(0)
    const gate = harness.gates.find((input) => input['teammate'] === 'guard-runner')
    expect(gate, '队友的工具调用要带 teammate 标记交给共享链').toBeDefined()
    expect(gate?.['sessionId'], '会话要改写成派它的那条（归属会话）').toBe(harness.session.meta.id)
    expect(String(gate?.['sessionPath'])).toContain('parent-')
    expect(harness.observes.length).toBeGreaterThan(0)

    // 队友自己的 toolCalls 计数长在面板视图里。
    const listed = String(await runTool(harness, { action: 'list' }))
    expect(listed).toContain('1 次工具调用')
    expect(name).toBe('guard-runner')
  })
})

// ── 10. 嵌套派活：队友再派一个 + 归属会话上溯 ───────────────────────────────
describe('嵌套派活', () => {
  test('队友能往下派：子队友的 parent/depth 对得上，归属会话仍是最上层', async () => {
    const harness = fakeCtx({ config: { maxDepth: 2 } })
    // 自定义角色：允许它调 subagent（出厂角色都只有只读工具）。
    const explorer = readFileSync(join(HOME, 'agents', 'explorer.md'), 'utf8')
    writeFileSync(
      join(HOME, 'agents', 'nested.md'),
      explorer
        .replace(/^name: .*$/m, 'name: nested')
        .replace(/^tools: .*$/m, 'tools: subagent, read')
        .replace(/^description: .*$/m, 'description: 会往下派活的队友'),
      'utf8',
    )

    let call = 0
    harness.streamHandler = async (_api, _request, handlers) => {
      call += 1
      if (call === 1) {
        // 外层队友派一个前台小工。
        return {
          text: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'nested-call',
              name: 'subagent',
              arguments: JSON.stringify({ action: 'spawn', role: 'explorer', task: '数一下测试文件数量', background: false, name: 'inner-one' }),
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'tool_calls',
        }
      }
      handlers.onDelta?.('text', '嵌套的活干完了\n')
      return okStream('嵌套的活干完了')
    }

    const { text } = await spawnAndSettle(harness, { role: 'nested', name: 'outer-one', background: true })
    expect(text).toContain('已派给 outer-one')
    const roster = readRoster()
    const inner = roster.find((entry) => entry.name === 'inner-one')
    expect(inner, '内层队友要进名册').toBeDefined()
    expect(inner?.['parent']).toBe('outer-one')
    expect(inner?.['depth']).toBe(2)
    expect(inner?.['sessionId'], '内层队友的派出会话是外层队友的会话').not.toBe(harness.session.meta.id)
    // 外层收工后，名册上能找到它自己的记录。
    expect(roster.some((entry) => entry.name === 'outer-one')).toBe(true)
  })
})

// ── 11. agent-roles：坏文件与迁移 ──────────────────────────────────────────
describe('agent-roles 的坏文件与迁移', () => {
  test('坏 YAML / 非法角色名 / 数组工具 / 非法 effort 与 approval 都记 problem 不崩', () => {
    const dir = join(HOME, 'agents')
    mkdirSync(dir, { recursive: true })

    const badYaml = join(dir, 'bad-yaml.md')
    writeFileSync(badYaml, '---\n[not yaml\n---\n正文\n', 'utf8')
    const parsedBad = rolesModule.readRole(badYaml)
    expect(parsedBad?.problem).toContain('frontmatter 不是合法 YAML')

    const badName = join(dir, 'mixed.md')
    writeFileSync(badName, '---\nname: Bad_Name\ntools: [read, grep]\n---\n正文\n', 'utf8')
    const parsedName = rolesModule.readRole(badName)
    expect(parsedName?.problem).toContain('角色名「Bad_Name」不合法')

    const arrayTools = join(dir, 'array-tools.md')
    writeFileSync(arrayTools, '---\nname: array-tools\ntools:\n  - read\n  - grep\neffort: turbo\n---\n正文\n', 'utf8')
    const parsedTools = rolesModule.readRole(arrayTools)
    expect(parsedTools?.tools).toEqual(['read', 'grep'])
    expect(parsedTools?.problem).toContain('effort 只能是')

    // 只有 approval 非法：problem 是「第一条」，所以单开一个文件才验得到它。
    const badApproval = join(dir, 'bad-approval.md')
    writeFileSync(badApproval, '---\nname: bad-approval\napproval: maybe\n---\n正文\n', 'utf8')
    expect(rolesModule.readRole(badApproval)?.problem).toContain('approval 只能是')

    expect(() => rolesModule.writeRole('Bad_Name', { description: '', prompt: '' })).toThrow(/角色名「Bad_Name」不合法/)
  })

  test('迁移老内置角色：只删等于旧默认的 max-turns，CRLF 也认；坏文件原样留下', () => {
    const dir = join(HOME, 'agents')
    mkdirSync(dir, { recursive: true })
    // writer 的旧出厂默认是 20（见 LEGACY_BUILTIN_MAX_TURNS）：用 CRLF 写，验换行保留。
    const writer = join(dir, 'writer.md')
    writeFileSync(writer, '---\r\nname: writer\r\ndescription: 写手\r\nmax-turns: 20\r\n---\r\n正文\r\n', 'utf8')
    // reviewer 的旧默认 16，但用户改成了 9：不该动。
    const reviewer = join(dir, 'reviewer.md')
    writeFileSync(reviewer, '---\nname: reviewer\ndescription: 审查\nmax-turns: 9\n---\n正文\n', 'utf8')
    // critic 的 frontmatter 坏了：迁移吞掉异常，文件不动。
    const critic = join(dir, 'critic.md')
    writeFileSync(critic, '---\n[oops\n---\n正文\n', 'utf8')

    const migrated = rolesModule.migrateBuiltinRoleMaxTurns()
    expect(migrated).toContain('writer')
    const writerText = readFileSync(writer, 'utf8')
    expect(writerText).not.toMatch(/max-?turns/i)
    expect(writerText).toContain('\r\n')
    expect(readFileSync(reviewer, 'utf8')).toContain('max-turns: 9')
    expect(readFileSync(critic, 'utf8')).toContain('[oops')
    // 幂等：第二次没有可迁移的。
    expect(rolesModule.migrateBuiltinRoleMaxTurns()).not.toContain('writer')
  })
})
