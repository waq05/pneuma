/**
 * subagent 插件「队友生命周期」的补测（W14 重 harness 面）。
 *
 * 覆盖目标（对照 W14 缺口清单 `packages/subagent/index.ts`）：
 *   - `forkSeedLines` 读父会话失败（668）；
 *   - 工牌只有 effort 时的路由（1231）与 spawn 的 `parseModelRef` 回调（1968）；
 *   - 轮次预算到点掐断（1287）与最后一轮提醒（1291-1292）；
 *   - 当前会话正被查看时事件直接进转录（1334）；
 *   - `ctx.agent.attach` 交给宿主的六个回调（1347-1352）；
 *   - 无结论收摊文案的三档（1544/1546/1551）；
 *   - 嵌套派活时把汇报投进父队友的信箱（1571-1575）；
 *   - 复活失败退回只读（1700）；
 *   - 名字序号用尽的兜底（1868）；
 *   - 收工队友攒太多时的挤出（1978-1985）；
 *   - 认领失败（2022）。
 *
 * 做法：抄 `w13-coverage.spec.ts` 的整条 harness（真 `apply`、真会话文件、真 MiniAgent，
 * 只替换模型端点与宿主表面），只在副本上补两样记录：`agent.attach` 收下的会话对象
 * （用来把「当前查看的会话」换成队友会话）与 `transcript.emit` 的归属会话参数。
 * 两处只在特定条件下才生效的替身用 `vi.mock` 包一层真实模块：会话锁被占（复活失败）
 * 与板子写失败（认领失败）都靠它注入，其余调用一律透传。
 *
 * 隔离：临时 `DSC_HOME` + 临时工作区，动态 import 在设好环境之后；真实 `~/.dsc` 不碰。
 *
 * @module @pneuma/subagent/tests/w14c-lifecycle.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

/** 两个注入开关：只在标记路径 / 打开开关时才让替身抛错。 */
const ctl = vi.hoisted(() => ({ failClaim: false, throwLoad: false }))

vi.mock('@pneuma/runtime/core/session.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../core/session.js')>()
  // 构造器是私有的，不能继承：用原类当原型借一份静态面，只把 load 换成可按开关抛错的版本。
  const Wrapped = Object.create(real.Session) as typeof real.Session
  Wrapped.load = ((file: string, keepPath = false, options: { lease?: boolean } = {}) => {
    // 复活路径的写租约被别的窗口占着：只有文件名带标记时才抛，别的调用全透传。
    if (ctl.throwLoad && file.includes('revive-throw')) throw new Error('这份会话已在另一个 Pneuma 窗口打开')
    return real.Session.load(file, keepPath, options)
  }) as typeof real.Session.load
  return { ...real, Session: Wrapped }
})

vi.mock('@pneuma/runtime/core/team-board.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../core/team-board.js')>()
  return {
    ...real,
    boardUpdate: (...args: Parameters<typeof real.boardUpdate>): ReturnType<typeof real.boardUpdate> => {
      // 认领那一步写板失败（另一个窗口抢了 CAS）：开关打开才抛。
      if (ctl.failClaim) throw new Error('板子被别的窗口改过')
      return real.boardUpdate(...args)
    },
  }
})

const HOME = mkdtempSync(join(tmpdir(), 'dsc-subagent-w14c-'))
process.env['DSC_HOME'] = HOME

/** 临时工作区：队友按父会话的 cwd 干活，这里只需要不是一个 git 仓库。 */
const WORKSPACE = mkdtempSync(join(tmpdir(), 'dsc-subagent-w14c-cwd-'))

type Plugin = (typeof import('../index.js'))['subagentPlugin']
type SessionT = import('../../../core/session.js').Session
type SessionModule = typeof import('../../../core/session.js')
type IndexModule = typeof import('../index.js')
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

interface StreamRequestLike {
  signal?: AbortSignal
  messages?: ChatMessageLike[]
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

/** `ctx.agent.attach` 的驱动面：宿主拿它给队友会话投输入 / 打断 / 改队列。 */
interface AttachedDriver {
  followup: (text: string, images?: string[], origin?: string, files?: unknown[]) => void
  interrupt: () => void
  isRunning: () => boolean
  editQueued: (index: number, text: string) => boolean
  removeQueued: (index: number) => boolean
  steerQueued: (index: number) => boolean
}

interface Harness {
  ctx: Record<string, unknown>
  tools: CapturedTool[]
  prompts: CapturedPrompt[]
  sections: CapturedSection[]
  services: Map<string, unknown>
  systems: Array<{ text: string; sessionId?: string }>
  /** `ctx.transcript.emit` 记下的 (事件, 归属会话 id)。 */
  emitted: Array<{ event: Record<string, unknown>; sessionId?: string }>
  events: Array<{ name: string; args: unknown[] }>
  followups: Array<{ text: string; sessionId?: string; origin?: string }>
  routeCalls: Array<{ provider: string; model: string; effort: string }>
  /** 界面 `ctx.session.open` 被打开的文件。 */
  opened: string[]
  /** `ctx.agent.attach` 记下的会话 id → 驱动面。 */
  attached: Map<string, AttachedDriver>
  /** `ctx.agent.attach` 记下的会话 id → 会话对象（用来切换「当前查看的会话」）。 */
  attachedSessions: Map<string, SessionT>
  /** 内核会话表里「还有 agent」的会话 id 集合（默认空 = 都已收摊）。 */
  resident: Set<string>
  session: SessionT
  setSession: (session: SessionT) => void
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

const TASK = '请统计仓库里有多少个测试文件并给出结论，附证据位置'

let plugin: Plugin
let SessionClass: SessionModule['Session']
let indexModule: IndexModule
const cleanups: Array<() => void> = []
const dirs: string[] = [HOME, WORKSPACE]

beforeAll(async () => {
  SessionClass = (await import('../../../core/session.js')).Session
  indexModule = await import('../index.js')
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
  // 名册跨用例共用同一个 HOME：每个用例从空名册起跑，免得名字 / 名额被判成上一个用例的。
  writeJson(join(HOME, 'team', 'roster.json'), { teammates: [] })
  bumpRosterMtime()
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

/** 写一个测试角色（角色文件每次 `findRole` 现读，不用等缓存）。 */
function writeRoleFile(name: string, body: string, front: Record<string, string> = {}): void {
  const dir = join(HOME, 'agents')
  mkdirSync(dir, { recursive: true })
  const lines = [
    '---',
    `name: ${name}`,
    'description: W14c 生命周期补测用的角色',
    ...Object.entries(front).map(([key, value]) => `${key}: ${value}`),
    '---',
    body,
  ]
  writeFileSync(join(dir, `${name}.md`), lines.join('\n') + '\n', 'utf8')
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

/** 假 ctx：把插件用到的挂载点全实现，`effect` 真跑回调（同 w13 的夹具口径）。 */
function fakeCtx(options: { config?: Record<string, unknown> } = {}): Harness {
  const tools: CapturedTool[] = []
  const prompts: CapturedPrompt[] = []
  const sections: CapturedSection[] = []
  const services = new Map<string, unknown>()
  const systems: Harness['systems'] = []
  const emitted: Harness['emitted'] = []
  const events: Harness['events'] = []
  const followups: Harness['followups'] = []
  const routeCalls: Harness['routeCalls'] = []
  const opened: string[] = []
  const attached = new Map<string, AttachedDriver>()
  const attachedSessions = new Map<string, SessionT>()
  const resident = new Set<string>()
  const effects: Array<() => void> = []

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
      registerProjection() {
        return () => undefined
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
      touch: (): void => undefined,
      emit: (event: Record<string, unknown>, sessionId?: string) => {
        emitted.push({ event, ...(sessionId === undefined ? {} : { sessionId }) })
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
      decide: async () => 'allow-once',
    },
    guards: {
      register() {
        return () => undefined
      },
      registerSessionResolver(_id: string, _fn: (sessionId: string) => unknown) {
        return () => undefined
      },
      gate: async () => ({ action: 'defer' }),
      observe: (_toolName: string, text: string) => text,
    },
    agent: {
      sessionById: (id: string) => attachedSessions.get(id) ?? (harness.session.meta.id === id ? harness.session : undefined),
      hasAgent: (id: string) => resident.has(id),
      attach: (session: SessionT, driver?: AttachedDriver) => {
        attached.set(session.meta.id, driver as AttachedDriver)
        attachedSessions.set(session.meta.id, session)
      },
      detach: (sessionId: string) => {
        attached.delete(sessionId)
        attachedSessions.delete(sessionId)
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
  harness.sections = sections
  harness.services = services
  harness.systems = systems
  harness.emitted = emitted
  harness.events = events
  harness.followups = followups
  harness.routeCalls = routeCalls
  harness.opened = opened
  harness.attached = attached
  harness.attachedSessions = attachedSessions
  harness.resident = resident
  harness.session = parent
  harness.setSession = (session: SessionT) => {
    harness.session = session
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apply = plugin.apply as unknown as (context: unknown, passed?: unknown) => (() => void) | void
  const returned = apply(ctx, options.config)
  const cleanup = (): void => {
    if (typeof returned === 'function') returned()
    for (const off of effects.splice(0)) off()
  }
  harness.cleanup = cleanup
  cleanups.push(cleanup)
  return harness
}

function subagentTool(harness: Harness): CapturedTool {
  const tool = harness.tools.find((entry) => entry.name === 'subagent')
  expect(tool, 'default 配置下应当注册 subagent 工具').toBeDefined()
  return tool as CapturedTool
}

function tool(harness: Harness, name: string): CapturedTool {
  const found = harness.tools.find((entry) => entry.name === name)
  expect(found, `应当注册 ${name} 工具`).toBeDefined()
  return found as CapturedTool
}

interface TeamServiceLike {
  list: () => Array<Record<string, unknown>>
  board: (sessionId: string) => TeamBoardT
  open: (name: string) => Promise<void>
  remove: (name: string) => Promise<string>
}

function teamService(harness: Harness): TeamServiceLike {
  return harness.services.get('team') as TeamServiceLike
}

function runTool(harness: Harness, args: Record<string, unknown>): Promise<string> | string {
  return subagentTool(harness).run(args, {
    cwd: harness.session.meta.cwd,
    signal: new AbortController().signal,
    sessionId: harness.session.meta.id,
  })
}

/** 跑任务板 / 团队消息工具：归属当前会话。 */
function runTeamTool(
  harness: Harness,
  name: 'team_task' | 'team_message',
  args: Record<string, unknown>,
): Promise<string> | string {
  return tool(harness, name).run(args, { sessionId: harness.session.meta.id })
}

/** 等某个队友离开 working（收工 / 被停）。 */
async function waitSettled(harness: Harness, name: string): Promise<void> {
  await until(() => {
    const found = teamService(harness)
      .list()
      .find((item) => item['name'] === name)
    return found !== undefined && found['state'] !== 'working'
  })
}

/** 派一个后台队友并等它收工。 */
async function spawnAndSettle(harness: Harness, args: Record<string, unknown>): Promise<{ name: string; text: string }> {
  const text = String(await runTool(harness, { action: 'spawn', background: true, task: TASK, ...args }))
  const matched = /已派给 ([a-z0-9-]+)/.exec(text)
  const name = matched?.[1] ?? String(args['name'] ?? '')
  await waitSettled(harness, name)
  return { name, text }
}

// ── 1. 工牌路由：只有 effort / spawn 的模型解析回调 ─────────────────────────

describe('工牌与模型解析', () => {
  test('工牌只有 effort 时按父会话端点路由并带上思考强度（1231）', async () => {
    const harness = fakeCtx()
    const { text } = await spawnAndSettle(harness, { role: 'explorer', name: 'effort-only', background: true, effort: 'high' })
    expect(text).toContain('已派给 effort-only')
    expect(harness.routeCalls.some((call) => call.effort === 'high')).toBe(true)
  })

  test('spawn 显式带 model 时走 parseModelRef 回调归一（1968）', async () => {
    const harness = fakeCtx({ config: { allowModelSelection: true, allowedModels: ['fake/model'] } })
    const { text } = await spawnAndSettle(harness, {
      role: 'explorer',
      name: 'model-pick',
      background: true,
      model: 'fake/model',
    })
    expect(text).toContain('已派给 model-pick')
    // 显式模型同样经 routeTo 出去（工牌里 model 非空那支）。
    expect(harness.routeCalls.some((call) => call.model === 'model')).toBe(true)
  })
})

// ── 2. 轮次预算与最后一轮提醒 ───────────────────────────────────────────────

describe('轮次预算', () => {
  test('最后一轮先提醒交结论，预算到点还调工具就掐断（1287/1291-1292）', async () => {
    writeRoleFile('tight-budget', '把工具调用全部交完再收工。', { tools: 'read', 'max-turns': '3' })
    const harness = fakeCtx()
    let call = 0
    harness.streamHandler = async () => {
      call += 1
      if (call > 5) return okStream('兜底收工')
      return {
        text: '',
        reasoning: '',
        toolCalls: [{ id: `call-${String(call)}`, name: 'read', arguments: '{"path":"a.ts"}' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: 'tool_calls',
      }
    }
    const { name } = await spawnAndSettle(harness, { role: 'tight-budget', name: 'budget-one', background: true })
    const record = readRoster().find((entry) => entry['name'] === name) as Record<string, unknown>
    const raw = readFileSync(String(record['file']), 'utf8')
    expect(call, raw.slice(-1200)).toBeGreaterThanOrEqual(3)
    // 最后一轮的提醒真的进了它的对话（1292 的 followup 落成 user 记录）。
    await until(() => readFileSync(String(record['file']), 'utf8').includes('下一轮是最后一次'))
    const view = teamService(harness)
      .list()
      .find((item) => item['name'] === name)
    expect(view?.['state']).toBe('stopped')
  }, 30_000)
})

// ── 3. 无结论收摊文案的三档 ────────────────────────────────────────────────

describe('无结论收摊文案', () => {
  test('后台队友没留文字：默认档说明「没交最终结论」并给运行记录路径（1544/1546/1551）', async () => {
    const harness = fakeCtx()
    harness.streamHandler = async () => okStream('')
    const { name } = await spawnAndSettle(harness, { role: 'explorer', name: 'no-text', background: true })
    expect(name).toBe('no-text')
    await until(() => harness.followups.some((item) => item.text.includes('没交最终结论')))
    expect(harness.followups.some((item) => item.text.includes('运行记录：'))).toBe(true)
  }, 30_000)

  test('轮次预算用完那一档：文案写出预算轮数', async () => {
    writeRoleFile('tight-one', '最多一轮，直接交结论。', { tools: 'read', 'max-turns': '1' })
    const harness = fakeCtx()
    harness.streamHandler = async () => okStream('')
    await spawnAndSettle(harness, { role: 'tight-one', name: 'budget-text', background: true })
    await until(() => harness.followups.some((item) => item.text.includes('轮次预算用完（1 轮）')))
  }, 30_000)

  test('前台队友没留文字：交给模型的这句话只说原因，不再重复路径（1551 的 withPath=false）', async () => {
    writeRoleFile('tight-one', '最多一轮，直接交结论。', { tools: 'read', 'max-turns': '1' })
    const harness = fakeCtx()
    harness.streamHandler = async () => okStream('')
    const text = String(
      await runTool(harness, { action: 'spawn', role: 'tight-one', task: TASK, background: false, name: 'foreground-text' }),
    )
    expect(text).toContain('轮次预算用完（1 轮），没交最终结论')
    // 原因只有一份：拿掉路径那一句之后不带第二个「运行记录：」。
    expect(text.split('运行记录：').length).toBe(2)
  }, 30_000)
})

// ── 4. 当前会话正被查看时事件直接进转录 ─────────────────────────────────────

describe('流事件转发', () => {
  test('当前查看的就是队友会话：事件按主会话同款形状直接 emit 并带归属（1334）', async () => {
    const harness = fakeCtx()
    const gate: { open: () => void } = { open: () => undefined }
    const opened = new Promise<void>((resolve) => {
      gate.open = resolve
    })
    harness.streamHandler = async (_api, _request, handlers) => {
      await opened
      handlers.onDelta?.('text', '这是队友自己的对话\n')
      return okStream('这是队友自己的对话')
    }
    const text = String(
      await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, background: true, name: 'live-view' }),
    )
    expect(text).toContain('已派给 live-view')
    const session = [...harness.attachedSessions.entries()].at(-1)?.[1]
    expect(session, '派活时会 attach 队友会话').toBeDefined()
    harness.setSession(session as SessionT)
    gate.open()
    await waitSettled(harness, 'live-view')
    expect(harness.emitted.some((item) => item.event['type'] === 'message' && item.sessionId === session?.meta.id)).toBe(true)
    expect(harness.emitted.some((item) => item.event['type'] === 'delta' && item.sessionId === session?.meta.id)).toBe(true)
  }, 30_000)

  test('attach 交给宿主的六个回调都能用（1347-1352）', async () => {
    const harness = fakeCtx()
    const { name } = await spawnAndSettle(harness, { role: 'explorer', name: 'attached-six', background: true })
    const entry = [...harness.attached.entries()].at(-1)
    expect(entry, '队友会话应当登记进 ctx.agent').toBeDefined()
    const [sessionId, driver] = entry as [string, AttachedDriver]
    expect(sessionId).toBe(harness.attachedSessions.get(sessionId)?.meta.id)
    // 六个回调逐个走一遍：投递 / 打断 / 读运行态 / 改队列 / 撤队列 / 插话。
    driver.followup('再补一句', undefined, 'user')
    expect(driver.isRunning()).toBe(true)
    driver.editQueued(0, '改一版')
    driver.removeQueued(0)
    driver.steerQueued(0)
    driver.interrupt()
    await until(() => !driver.isRunning(), 10_000)
    expect(driver.isRunning()).toBe(false)
  }, 30_000)
})

// ── 5. 嵌套派活：汇报投进父队友信箱 ────────────────────────────────────────

describe('嵌套父队友通知', () => {
  test('子队友收工：汇报写进父队友的信箱并叫醒它（1571-1575）', async () => {
    writeRoleFile('nested-w14c', '你可以往下派活。', { tools: 'subagent, read' })
    const harness = fakeCtx({ config: { maxDepth: 2 } })
    let outerSpawned = false
    harness.streamHandler = async (_api, request) => {
      const system = String(request.messages?.[0]?.content ?? '')
      const matched = /你是队友「([^」]+)」/.exec(system)
      const name = matched?.[1] ?? ''
      if (name === 'outer-w14c') {
        if (!outerSpawned) {
          outerSpawned = true
          return {
            text: '',
            reasoning: '',
            toolCalls: [
              {
                id: 'inner-spawn',
                name: 'subagent',
                arguments: JSON.stringify({
                  action: 'spawn',
                  role: 'explorer',
                  task: '数一下测试文件数量并给结论',
                  background: true,
                  name: 'inner-w14c',
                }),
              },
            ],
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: 'tool_calls',
          }
        }
        return okStream('外层收工')
      }
      return okStream('内层结论：42 个测试文件')
    }
    const text = String(
      await runTool(harness, { action: 'spawn', role: 'nested-w14c', task: TASK, background: true, name: 'outer-w14c' }),
    )
    expect(text).toContain('已派给 outer-w14c')
    // 内层队友收工后汇报进外层队友的信箱；外层再被叫醒，报告落进外层的会话记录。
    await until(() => readRoster().some((entry) => entry['name'] === 'inner-w14c'), 10_000)
    await until(() => {
      const record = readRoster().find((entry) => entry['name'] === 'outer-w14c')
      if (record === undefined) return false
      try {
        const raw = readFileSync(String(record['file']), 'utf8')
        // 日志是 JSONL：引号在字符串里被转义，只认「报告标记 + 内层名字」两段。
        return raw.includes('teammate-report') && raw.includes('inner-w14c')
      } catch {
        return false
      }
    }, 15_000)
    const outer = readRoster().find((entry) => entry['name'] === 'outer-w14c') as Record<string, unknown>
    expect(String(outer['file'])).toContain('sessions')
    const inner = readRoster().find((entry) => entry['name'] === 'inner-w14c') as Record<string, unknown>
    expect(inner['parent']).toBe('outer-w14c')
  }, 45_000)
})

// ── 6. 复活失败退回只读 ─────────────────────────────────────────────────────

describe('复活失败', () => {
  test('写租约被别的窗口占着：emit 一条说明后按记录打开，不崩（1700）', async () => {
    const harness = fakeCtx()
    const sessionModule = await import('../../../core/session.js')
    const id = `revive-throw-${String(Math.random()).slice(2, 8)}`
    const file = join(sessionModule.sessionsRoot(), sessionModule.slugCwd(WORKSPACE), `${id}.jsonl`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'meta',
          id,
          origin: 'subagent',
          parentSession: harness.session.meta.id,
          cwd: WORKSPACE,
          createdAt: Date.now(),
        }),
        JSON.stringify({ type: 'assistant', text: '以前的结论', reasoning: '', ts: Date.now() }),
      ].join('\n') + '\n',
      'utf8',
    )
    putRosterRecord({
      name: 'throwing',
      role: 'explorer',
      state: 'idle',
      task: '老的活',
      file,
      cwd: WORKSPACE,
      parent: 'lead',
      depth: 1,
      rounds: 1,
      startedAt: Date.now(),
      mode: 'continuable',
      sessionId: harness.session.meta.id,
    })
    ctl.throwLoad = true
    try {
      await teamService(harness).open('throwing')
    } finally {
      ctl.throwLoad = false
    }
    expect(harness.events.some((event) => String(event.args[0]).includes('没把「throwing」叫回来'))).toBe(true)
    expect(harness.opened).toContain(file)
  }, 30_000)
})

// ── 7. 名字序号用尽 ────────────────────────────────────────────────────────

describe('命名兜底', () => {
  test('角色-1..99 全被名册占着：退回「角色-时间戳」（1868）', async () => {
    const records = Array.from({ length: 99 }, (_, index) => ({
      name: `explorer-${String(index + 1)}`,
      role: 'explorer',
      state: 'idle',
      task: '占位',
      file: join(WORKSPACE, `fake-${String(index + 1)}.jsonl`),
      cwd: WORKSPACE,
      parent: 'lead',
      depth: 1,
      rounds: 1,
      startedAt: Date.now(),
      mode: 'continuable',
    }))
    writeJson(join(HOME, 'team', 'roster.json'), { teammates: records })
    bumpRosterMtime()
    const harness = fakeCtx()
    harness.streamHandler = async () => okStream('占位的结论')
    const text = String(await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, background: true }))
    const matched = /已派给 (explorer-\d+)/.exec(text)
    expect(matched, `兜底名应当带上时间戳，实际：${text}`).not.toBeNull()
    const name = matched?.[1] as string
    expect(name.length).toBeGreaterThan('explorer-99'.length)
    await waitSettled(harness, name)
  }, 30_000)
})

// ── 8. 收工队友攒太多时的挤出 ──────────────────────────────────────────────

describe('finished 列表挤出', () => {
  test('收工的超过 12 个：再派一个时把最老的挤出名单并关闭会话（1978-1985）', async () => {
    const harness = fakeCtx()
    harness.streamHandler = async () => okStream('收工结论')
    const names: string[] = []
    for (let index = 1; index <= 13; index += 1) {
      const name = `fin-${String(index)}`
      const text = String(await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, background: true, name }))
      expect(text).toContain(`已派给 ${name}`)
      await waitSettled(harness, name)
      names.push(name)
    }
    const listed = String(
      await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, background: true, name: 'fin-last' }),
    )
    expect(listed).toContain('已派给 fin-last')
    await waitSettled(harness, 'fin-last')
    const list = String(await runTool(harness, { action: 'list' }))
    // 挤出的是最早收工的 fin-1：名单里不再有它，后面的还在。
    expect(list).not.toContain('- fin-1（')
    expect(list).toContain('- fin-2（')
    expect(list).toContain('- fin-last（')
    // 名册里的运行记录不清（挤出只清内存，磁盘留着供查看）。
    expect(readRoster().some((entry) => entry['name'] === 'fin-1')).toBe(true)
    for (const name of [...names, 'fin-last']) {
      try {
        await teamService(harness).remove(name)
      } catch {
        // 已经收掉的不影响后面
      }
    }
  }, 120_000)
})

// ── 9. 派活认领失败 ────────────────────────────────────────────────────────

describe('派活认领失败', () => {
  test('写板 CAS 失败：把原因原样带回来，不派出去（2022）', async () => {
    const harness = fakeCtx()
    await runTeamTool(harness, 'team_task', { action: 'create', subject: '先建一条' })
    ctl.failClaim = true
    try {
      const text = String(
        await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, task_id: 't1', name: 'claim-fail' }),
      )
      expect(text).toContain('认领 t1 失败')
      expect(text).toContain('板子被别的窗口改过')
    } finally {
      ctl.failClaim = false
    }
    // 没派出去：名单里没有它。
    expect(String(await runTool(harness, { action: 'list' }))).not.toContain('claim-fail')
  })
})

// ── 10. fork 读父会话失败 ──────────────────────────────────────────────────

describe('fork 种子读不到', () => {
  test('父会话文件被删掉：说清带不上内容并给 fresh 建议（668）', async () => {
    const harness = fakeCtx()
    harness.session.appendAssistant('父会话的完整回答', '', [])
    // 等 meta 落盘（`persisted` 是「写过 meta」这个内存标记）。
    await until(() => existsSync(harness.session.filePath))
    rmSync(harness.session.filePath, { force: true })
    const text = String(
      await runTool(harness, { action: 'spawn', role: 'explorer', task: TASK, context: 'fork', name: 'fork-broken' }),
    )
    expect(text).toContain('带不上父会话的内容')
    expect(text).toContain('context="fresh"')
  }, 30_000)
})
