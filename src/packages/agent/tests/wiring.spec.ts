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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  attach(session: SessionT, driver?: ForeignDriverLike): void
  detach(sessionId: string): void
  acceptsInput(sessionId: string): boolean
}

/** 外部循环（队友）的执行面替身。 */
interface ForeignDriverLike {
  followup(text: string, images?: string[], origin?: string, files?: unknown[]): void
  interrupt(): void
  isRunning(): boolean
  editQueued?(index: number, text: string): boolean
  removeQueued?(index: number): boolean
  steerQueued?(index?: number): boolean
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
  /** 每轮系统提示正文；缓存探针用例靠改它制造「system 变」的断点。 */
  systemText: string
  /** 假审批服务（缺省缺席）：测「挂着审批卡切走」的状态点时用。 */
  approval?: { pendingFor(filePath: string): boolean }
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
    systemText: '系统提示',
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
      systemPromptParts: () => ({ text: harness.systemText, sections: [] }),
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
      if (name === 'approval') return harness.approval
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
    // 探针默认关（`DSC_CACHE_PROBE` 没设）：断点字段一个都不写。
    expect(Object.hasOwn(JSON.parse(line), 'bp')).toBe(false)
    expect(session.messages.some((message) => message.role === 'user' && message.content === '你好')).toBe(true)
  })
})

describe('缓存归因探针', () => {
  /** usage.jsonl 里属于这条会话的请求行（工具行没有 i/o，顺手排掉）。 */
  const usageRows = (session: SessionT): Array<Record<string, unknown>> => {
    const file = join(HOME, 'usage', 'usage.jsonl')
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row['sid'] === session.meta.id && row['k'] !== 'tool')
  }

  test('开启时只给「真变了」的请求写断点：首请求与只追加都不写', async () => {
    process.env['DSC_CACHE_PROBE'] = '1'
    try {
      const harness = fakeCtx()
      const service = serviceOf(harness)
      const session = harness.session
      const followup = (text: string): void => service.followup(text, undefined, undefined, 'notice')

      followup('第一问')
      await until(() => usageRows(session).length >= 1)
      followup('第二问')
      await until(() => usageRows(session).length >= 2)
      // 换一版系统提示：下一轮的前缀断在第 0 条（system）。
      harness.systemText = '系统提示（改过）'
      followup('第三问')
      await until(() => usageRows(session).length >= 3)

      const rows = usageRows(session)
      // 会话第一次请求没有可比的上一次。
      expect(rows[0]?.['bp']).toBeUndefined()
      // 第二轮只是历史多了一条 user 消息：纯追加，不写断点。
      expect(rows[1]?.['bp']).toBeUndefined()
      // 第三轮系统提示变了：断在下标 0，来源标记 sys、角色 system。
      expect(rows[2]?.['bp']).toEqual({ at: 0, role: 'system', sys: true })
    } finally {
      delete process.env['DSC_CACHE_PROBE']
    }
  })
})

describe('外部驱动（队友）与休眠投递的剩余分支', () => {
  /** 记录调用的 driver 替身。 */
  function driverOf(calls: string[]): ForeignDriverLike {
    return {
      followup: (text) => calls.push(`followup:${text}`),
      interrupt: () => calls.push('interrupt'),
      isRunning: () => true,
      editQueued: (index, text) => (calls.push(`edit:${String(index)}:${text}`), true),
      removeQueued: (index) => (calls.push(`remove:${String(index)}`), true),
      steerQueued: (index) => (calls.push(`steer:${String(index ?? 'all')}`), true),
    }
  }

  test('attach / detach：按 id 与路径查得到；有驱动才算「能接住输入」；isRunning 走驱动', () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    const foreign = newSession('sess-foreign')
    const calls: string[] = []
    const driver = driverOf(calls)

    service.attach(foreign, driver)
    expect(service.sessionById(foreign.meta.id)).toBe(foreign)
    expect(service.sessionFor(foreign.filePath)).toBe(foreign)
    expect(service.acceptsInput(foreign.meta.id)).toBe(true)
    expect(service.isRunning(foreign.filePath)).toBe(true)
    // 有驱动但不在常驻表里：hasAgent 仍是 false（不能被当成常驻 agent 去唤醒）。
    expect(service.hasAgent(foreign.meta.id)).toBe(false)

    service.detach(foreign.meta.id)
    expect(service.sessionById(foreign.meta.id)).toBeUndefined()
    expect(service.acceptsInput(foreign.meta.id)).toBe(false)
    expect(service.isRunning(foreign.filePath)).toBe(false)
    // 没登记过的 detach 是空操作。
    expect(() => service.detach('never')).not.toThrow()
  })

  test('followup 投给外部驱动；interrupt 按路径 / 按当前查看都走驱动；排队动作交给驱动', () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    const calls: string[] = []
    const driver = driverOf(calls)
    const foreign = newSession('sess-foreign')
    service.attach(foreign, driver)

    service.followup('给队友的话', undefined, foreign.meta.id)
    expect(calls).toContain('followup:给队友的话')

    // 当前查看的会话也 attach 了驱动：无路径的 interrupt 先看当前查看有没有驱动。
    service.attach(harness.session, driver)
    service.interrupt()
    expect(calls).toContain('interrupt')

    // 按路径停：常驻表里没有这条，落到 attached 的驱动上。
    service.interrupt(foreign.filePath)
    expect(calls.filter((call) => call === 'interrupt').length).toBe(2)

    // 打开外部驱动的会话：active 让出来（null），排队动作改交当前查看的驱动。
    open(harness, foreign)
    expect(service.editQueued(0, '改一句')).toBe(true)
    expect(service.removeQueued(1)).toBe(true)
    expect(service.steerQueued()).toBe(true)
    expect(calls).toContain('edit:0:改一句')
    expect(calls).toContain('remove:1')
    expect(calls).toContain('steer:all')
  })

  test('打开队友会话时把前一条在跑的会话状态点重新点亮（挂着审批卡的发 awaiting-approval）', async () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    const running = harness.session
    // 让第一轮卡在流里：回合开始后不返回，直到测试放行。
    let release: (() => void) | undefined
    ;(harness as { stream: unknown }).stream = () =>
      new Promise<StreamResult>((resolve) => {
        release = () => resolve(okStream('好'))
      })
    service.followup('卡住的一轮', undefined, undefined, 'user')
    await until(() => harness.events.some((event) => event.name === 'dsc/turn-start'))

    harness.approval = { pendingFor: (path) => path === running.filePath }
    const foreign = newSession('sess-foreign')
    const driver = driverOf([])
    service.attach(foreign, driver)
    harness.events.length = 0
    open(harness, foreign)

    const status = harness.events.find(
      (event) => event.name === 'dsc/agent-status' && (event.args[0] as { path?: string }).path === running.filePath,
    )
    expect(status).toBeDefined()
    expect((status?.args[0] as { state: string }).state).toBe('awaiting-approval')

    release?.()
    await until(() => harness.events.some((event) => event.name === 'dsc/turn-end'))
  })

  test('普通会话切换：前一条在跑就重发状态点（没有审批卡时是 working），空闲的进保留名册', async () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    const running = harness.session
    let release: (() => void) | undefined
    ;(harness as { stream: unknown }).stream = () =>
      new Promise<StreamResult>((resolve) => {
        release = () => resolve(okStream('好'))
      })
    service.followup('后台跑一轮', undefined, undefined, 'user')
    await until(() => harness.events.some((event) => event.name === 'dsc/turn-start'))

    const next = newSession('sess-next')
    harness.events.length = 0
    open(harness, next)
    const status = harness.events.find(
      (event) => event.name === 'dsc/agent-status' && (event.args[0] as { path?: string }).path === running.filePath,
    )
    expect((status?.args[0] as { state: string }).state).toBe('working')
    release?.()
    await until(() => harness.events.some((event) => event.name === 'dsc/turn-end'))

    // 再切走一条空闲会话：它按「空闲保留」处理，不重发运行中状态。
    harness.events.length = 0
    const idle = newSession('sess-idle')
    open(harness, idle)
    expect(harness.events.some((event) => event.name === 'dsc/agent-status')).toBe(false)
  })

  test('后台会话跑完自己收摊（onIdle），不用等人切回去', async () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    const background = newSession('sess-background')
    open(harness, background)
    expect(service.hasAgent(background.meta.id)).toBe(true)
    // 切到别的会话后让后台那条跑一轮：跑完 onIdle 发现它不是当前查看的就收摊。
    service.followup('跑完就走', undefined, background.meta.id, 'notice')
    const other = newSession('sess-other')
    open(harness, other)
    await until(() => !service.hasAgent(background.meta.id))
    expect(service.sessionById(background.meta.id)).toBeUndefined()
  })

  test('dsc/exit：把所有常驻 agent 收摊清表', () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    const extra = newSession('sess-extra')
    open(harness, extra)
    expect(service.hasAgent(harness.session.meta.id)).toBe(true)
    harness.handlers.get('dsc/exit')!()
    expect(service.hasAgent(harness.session.meta.id)).toBe(false)
    expect(service.hasAgent(extra.meta.id)).toBe(false)
  })

  test('收工队友的记录只读：投递被拒；墓碑指向坏文件时给一条「没能写进会话」', async () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    // 造墓碑：开一条会话再切走四条，它被挤出空闲保留窗后 disposeAgent 记下路径。
    const retired = newSession('sess-retired')
    open(harness, retired)
    const fillers = Array.from({ length: 4 }, (_, index) => newSession(`sess-fill-${String(index)}`))
    for (const filler of fillers) open(harness, filler)
    expect(service.hasAgent(retired.meta.id)).toBe(false)

    // 把它的首行改成队友记录：投递应被拒（只读史料），不写用户消息。
    writeFileSync(retired.filePath, `${JSON.stringify({ type: 'meta', ...retired.meta, origin: 'subagent' })}\n`, 'utf8')
    service.followup('叫它接着干', undefined, retired.meta.id, 'user')
    expect(harness.notices.some((message) => message.includes('这位队友已经收工'))).toBe(true)

    // 墓碑指向的文件没了：Session.load 抛错，折成一句通知而不是让调用方炸。
    rmSync(retired.filePath, { force: true })
    service.followup('再投一次', undefined, retired.meta.id, 'user')
    expect(harness.notices.some((message) => message.includes('没能写进会话'))).toBe(true)
  })

  test('当前查看的就是收工队友时，followup 明说只读，不悄悄写日志', () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    const teammate = newSession('sess-teammate')
    harness.setSession(teammate)
    // 直接改 meta 的 origin：这条会话没有经过 session-open，因此没有常驻 agent。
    ;(teammate.meta as { origin?: string }).origin = 'subagent'
    service.followup('接着干', undefined, teammate.meta.id, 'user')
    expect(harness.notices.some((message) => message.includes('这位队友已经收工'))).toBe(true)
    expect(teammate.messages).toHaveLength(0)
  })
})

describe('工具结果记账', () => {
  test('工具调用带耗时：tool/result 落一条工具行；没有耗时的合成结果不记', async () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    // 第一次回一个工具调用（工具不存在，循环仍会为它产出一条带耗时的失败结果），第二次收尾。
    let round = 0
    ;(harness as { stream: unknown }).stream = async () => {
      round += 1
      if (round === 1) {
        return {
          ...okStream(''),
          toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
          finishReason: 'tool_calls',
        }
      }
      return okStream('收工')
    }
    service.followup('用一次工具', undefined, undefined, 'user')
    const usageFile = join(HOME, 'usage', 'usage.jsonl')
    await until(() => {
      if (!existsSync(usageFile)) return false
      return readFileSync(usageFile, 'utf8').includes('"k":"tool"')
    })
    const toolRow = readFileSync(usageFile, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row['k'] === 'tool' && row['sid'] === harness.session.meta.id)
    expect(toolRow).toBeDefined()
    expect(typeof toolRow?.['ms']).toBe('number')
  })
})
