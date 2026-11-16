/**
 * agent 插件装配面（`packages/agent/index.ts`）：按会话常驻的 agent 注册表、
 * 会话切换的收摊策略、休眠会话投递、重复调用提醒投影、一轮完整回合的事件广播与用量落账。
 *
 * 用假 ctx 跑真 `apply`，会话是**真 Session**（临时 `DSC_HOME` + 临时工作区），
 * MiniAgent 也是真的；只有模型流与宿主表面是假的。`DSC_HOME` 在任何 import 之前
 * 指向临时目录——路径常量在模块求值时算定。
 *
 * @module dsc/packages/agent/tests/wiring.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type { ChatMessage, StreamHandlers, StreamRequest, StreamResult } from '@pneuma/runtime/core/llm.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-agent-wiring-'))
process.env['DSC_HOME'] = HOME
const WORKSPACE = mkdtempSync(join(tmpdir(), 'dsc-agent-cwd-'))

type AgentIndex = typeof import('../index.js')
type SessionT = import('../../../core/session.js').Session
type SessionModule = typeof import('../../../core/session.js')
let agentPlugin: AgentIndex['agentPlugin']
let SessionClass: SessionModule['Session']

const ROUTE = { api: 'fake', baseUrl: 'http://fake', apiKey: 'k', model: 'fake/model', maxTokens: 16 }

const okStream = (text: string): StreamResult => ({
  text,
  reasoning: '',
  toolCalls: [],
  usage: { inputTokens: 3, outputTokens: 4, cacheHitTokens: 1, cacheMissTokens: 2 },
  finishReason: 'stop',
})

beforeAll(async () => {
  SessionClass = (await import('../../../core/session.js')).Session
  agentPlugin = (await import('../index.js')).agentPlugin
})

beforeEach(() => {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
})

const openSessions: SessionT[] = []

afterEach(() => {
  for (const session of openSessions.splice(0)) {
    try {
      session.close()
    } catch {
      // 已经关了
    }
  }
})

afterAll(() => {
  delete process.env['DSC_HOME']
  for (const dir of [HOME, WORKSPACE]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows 上偶发 EPERM：临时目录交给系统清。
    }
  }
})

interface AgentServiceLike {
  followup(text: string, images?: string[], sessionId?: string, origin?: string, files?: unknown[]): void
  interrupt(filePath?: string): void
  hasAgent(sessionId: string): boolean
  editQueued(index: number, text: string): boolean
  removeQueued(index: number): boolean
  steerQueued(index?: number): boolean
  sessionById(sessionId: string): SessionT | undefined
  sessionFor(filePath: string): SessionT | undefined
  isRunning(filePath: string): boolean
  stop(filePath: string): Promise<void>
}

interface Harness {
  services: Map<string, unknown>
  events: Array<{ name: string; args: unknown[] }>
  transcript: Array<{ event: Record<string, unknown>; sessionId?: string }>
  notices: string[]
  systems: string[]
  handlers: Map<string, (...args: never[]) => void>
  session: SessionT
  setSession(session: SessionT): void
  stream: (api: string, request: StreamRequest, handlers: StreamHandlers) => Promise<StreamResult>
  /** 与 `ctx.prompt.rewrite` 同一条投影链（测试里直接驱动投影）。 */
  rewrite: (messages: ChatMessage[], session?: SessionT) => ChatMessage[]
}

function newSession(id: string): SessionT {
  const session = SessionClass.create(WORKSPACE, join(HOME, 'sessions', `${id}.jsonl`))
  openSessions.push(session)
  return session
}

/** 等一个条件成立（写流与回合都是异步的）。 */
async function until(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待条件超时')
}

function fakeCtx(): Harness {
  const services = new Map<string, unknown>()
  const events: Harness['events'] = []
  const transcript: Harness['transcript'] = []
  const notices: string[] = []
  const systems: string[] = []
  const handlers = new Map<string, (...args: never[]) => void>()
  const projections: Array<(messages: ChatMessage[], session?: SessionT, report?: (view: unknown) => void) => ChatMessage[]> = []
  const session = newSession('sess-0')
  session.appendUser('种子')

  const rewrite = (messages: ChatMessage[], target?: SessionT, report?: (view: unknown) => void): ChatMessage[] => {
    let out = messages
    for (const projection of projections) out = projection(out, target, report)
    return out
  }

  const harness = {
    session,
    rewrite,
    setSession(next: SessionT): void {
      harness.session = next
    },
    stream: async (_api: string, _request: StreamRequest, handlersArg: StreamHandlers): Promise<StreamResult> => {
      handlersArg.onDelta('text', '你好')
      return okStream('你好')
    },
  } as unknown as Harness

  const ctx = {
    session: { current: () => harness.session },
    llm: {
      routeForSession: () => ROUTE,
      providerOf: () => 'fake',
      modelOf: () => ROUTE.model,
      stream: (api: string, request: StreamRequest, handlersArg: StreamHandlers) => harness.stream(api, request, handlersArg),
    },
    compact: {
      check: async () => undefined,
      forceCompact: async () => false,
    },
    prompt: {
      systemPromptParts: () => ({ text: '系统提示', sections: [] }),
      rewrite,
      registerProjection(
        _id: string,
        fn: (messages: ChatMessage[], session?: SessionT, report?: (view: unknown) => void) => ChatMessage[],
        _opts?: { order?: number },
      ) {
        projections.push(fn)
        return () => undefined
      },
    },
    tools: {
      visible: () => [],
      list: () => [],
    },
    guards: {
      gate: async () => ({ action: 'defer' }),
      observe: (_name: string, text: string) => text,
    },
    transcript: {
      emit: (event: Record<string, unknown>, sessionId?: string) =>
        transcript.push({ event, ...(sessionId === undefined ? {} : { sessionId }) }),
      system: (text: string) => systems.push(text),
    },
    emit(name: string, ...args: unknown[]) {
      events.push({ name, args })
      if (name === 'dsc/notice' && typeof args[0] === 'string') notices.push(args[0])
    },
    get(name: string) {
      if (name === 'approval') return undefined
      return undefined
    },
    on(event: string, handler: (...args: never[]) => void) {
      handlers.set(event, handler)
      return () => undefined
    },
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    provide(name: string, service: unknown) {
      services.set(name, service)
    },
  }

  agentPlugin.apply?.(ctx as never, undefined)
  harness.services = services
  harness.events = events
  harness.transcript = transcript
  harness.notices = notices
  harness.systems = systems
  harness.handlers = handlers
  return harness
}

const serviceOf = (harness: Harness): AgentServiceLike => harness.services.get('agent') as AgentServiceLike

/** 模拟 session 插件打开一条会话：切当前查看 + 广播 dsc/session-open。 */
function open(harness: Harness, session: SessionT): void {
  harness.setSession(session)
  harness.handlers.get('dsc/session-open')!({ session } as never)
}

describe('注册表与服务查询', () => {
  test('服务按 id / 路径找常驻会话；排队动作与未知路径都是安全的空操作', () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    const current = harness.session

    expect(service.hasAgent(current.meta.id)).toBe(true)
    expect(service.sessionById(current.meta.id)).toBe(current)
    expect(service.sessionFor(current.filePath)).toBe(current)
    expect(service.isRunning(current.filePath)).toBe(false)

    expect(service.hasAgent('ghost')).toBe(false)
    expect(service.sessionById('ghost')).toBeUndefined()
    expect(service.sessionFor('C:/nope.jsonl')).toBeUndefined()
    expect(service.isRunning('C:/nope.jsonl')).toBe(false)

    expect(service.editQueued(0, 'x')).toBe(false)
    expect(service.removeQueued(0)).toBe(false)
    expect(service.steerQueued()).toBe(false)

    // interrupt / stop 对不在跑的会话与未知路径都是空操作。
    expect(() => service.interrupt()).not.toThrow()
    expect(() => service.interrupt('C:/nope.jsonl')).not.toThrow()
  })
})

describe('会话切换与休眠投递', () => {
  test('切走保留最近 3 个空闲 agent，超出的收摊；墓碑让 followup 能写进休眠会话', async () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    const sessions = Array.from({ length: 6 }, (_, index) => newSession(`sess-${String(index + 1)}`))
    for (const session of sessions) {
      session.appendUser(`来自 ${session.meta.id}`)
      open(harness, session)
    }
    await until(() =>
      sessions.every((session) => {
        try {
          return readFileSync(session.filePath, 'utf8').includes('来自')
        } catch {
          return false
        }
      }),
    )

    // 初始会话与最早的 sess-1 都已超出 IDLE_KEEP=3 的保留窗，被收摊。
    expect(service.hasAgent(sessions[0]!.meta.id)).toBe(false)
    expect(service.hasAgent(sessions[5]!.meta.id)).toBe(true)

    // 收摊的会话仍能按原名册投递：写进 jsonl 等用户回去看，不打断、不起回合。
    service.followup('后台作业完成', undefined, sessions[0]!.meta.id, 'notice')
    // Session.load → appendUser → close 走的是写流，落盘是异步的。
    await until(() => readFileSync(sessions[0]!.filePath, 'utf8').includes('后台作业完成'))
    const text = readFileSync(sessions[0]!.filePath, 'utf8')
    expect(text).toContain('后台作业完成')
    expect(text).toContain('"origin":"notice"')

    // 名册里完全没有的会话：只发一条通知，不写任何文件。
    service.followup('没人接', undefined, 'ghost', 'notice')
    expect(harness.notices.some((message) => message.includes('不在本窗口的名册里'))).toBe(true)

    // 再打开一条还留着的空闲会话：直接复用，不再新建。
    open(harness, sessions[5]!)
    expect(service.sessionById(sessions[5]!.meta.id)).toBe(sessions[5])
  })

  test('stop：取消并收摊指定路径的 agent，存档前清掉排队输入', async () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    const first = newSession('sess-stop')
    open(harness, first)
    const second = newSession('sess-next')
    open(harness, second)

    expect(service.hasAgent(first.meta.id)).toBe(true)
    first.enqueueAsync('排队一', undefined, 'user')
    await service.stop(first.filePath)
    expect(service.hasAgent(first.meta.id)).toBe(false)
    expect(first.state('async-inbox')).toMatchObject({ items: [] })
    // 未知路径：空操作，不抛错。
    await expect(service.stop('C:/nope.jsonl')).resolves.toBeUndefined()
  })
})

describe('重复调用提醒投影', () => {
  test('尾部第 3 次同参调用追加一条提醒并落 note；二次派生不重复落；无会话不猜', () => {
    const harness = fakeCtx()
    const session = harness.session
    const call = { id: 'c1', type: 'function' as const, function: { name: 'read', arguments: '{"path":"a.ts"}' } }
    session.messages.push(
      { role: 'user', content: '开始' },
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
    )

    // 通过同一条投影链驱动 agent 的 repeat-reminder：注入一条提醒（第 3 次，温和档）。
    const out = harness.rewrite([{ role: 'user', content: '继续' }], session)
    expect(out).toHaveLength(2)
    expect(out[1]!.content).toContain('你在用完全相同的参数重复调用同一个工具')
    expect(session.notes().map((note) => note.id)).toContain('repeat-reminder')

    // 同一份历史再算一遍（invariant 的二次派生）：不重复追加、不重复落 note。
    const again = harness.rewrite(out, session)
    expect(again).toBe(out)
    expect(session.notes().filter((note) => note.id === 'repeat-reminder')).toHaveLength(1)

    // 拿不到会话（老调用方）：原样返回，不猜次数。
    const noSession = harness.rewrite([{ role: 'user', content: '继续' }], undefined)
    expect(noSession).toHaveLength(1)
  })
})

describe('一轮完整回合', () => {
  test('turn-start / turn-end 广播、当前会话进转录、用量落 usage.jsonl', async () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    const session = harness.session

    service.followup('你好', undefined, undefined, 'notice')
    await until(() => harness.events.some((item) => item.name === 'dsc/turn-end'))

    const turnEnd = harness.events.find((item) => item.name === 'dsc/turn-end')!
    expect(turnEnd.args[0]).toBe('completed')
    expect(turnEnd.args[1]).toMatchObject({ sessionId: session.meta.id, sessionPath: session.filePath })
    expect(harness.events.some((item) => item.name === 'dsc/turn-start')).toBe(true)
    expect(
      harness.events.some(
        (item) => item.name === 'dsc/agent-status' && (item.args[0] as { state?: string }).state === 'working',
      ),
    ).toBe(true)
    expect(
      harness.events.some(
        (item) => item.name === 'dsc/agent-status' && (item.args[0] as { state?: string }).state === 'idle',
      ),
    ).toBe(true)

    // 当前查看会话的事件进转录（user / turn/start / turn/end）。
    expect(harness.transcript.some((item) => item.event.type === 'user')).toBe(true)
    expect(harness.transcript.some((item) => item.event.type === 'turn/start')).toBe(true)
    expect(harness.transcript.some((item) => item.event.type === 'turn/end')).toBe(true)
    expect(harness.transcript.every((item) => item.sessionId === session.meta.id)).toBe(true)

    // 用量按发起回合的会话落一条到 usage.jsonl（含缓存明细）。
    const usageFile = join(HOME, 'usage', 'usage.jsonl')
    await until(() => existsSync(usageFile))
    const line = readFileSync(usageFile, 'utf8').trim().split('\n').at(-1)!
    expect(JSON.parse(line)).toMatchObject({
      provider: 'fake',
      model: ROUTE.model,
      i: 3,
      o: 4,
      ch: 1,
      cm: 2,
      sid: session.meta.id,
    })
    expect(session.messages.some((message) => message.role === 'user' && message.content === '你好')).toBe(true)
  })
})
