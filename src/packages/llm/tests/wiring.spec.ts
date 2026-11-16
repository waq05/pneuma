/**
 * llm 插件装配面（`packages/llm/index.ts`）：按会话取路由、档位校验与夹取、
 * 模型切换、`parseModelRef`、协议适配器注册与派发、请求清洗提醒与追踪号落日志。
 *
 * 用假 ctx 跑真 `apply`：端点是假的、会话是假的，插件里的判定与状态迁移全是真的。
 *
 * @module dsc/packages/llm/tests/wiring.spec
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { DscCoreConfig } from '@pneuma/runtime/core/config.js'
import type { StreamHandlers, StreamRequest, StreamResult } from '@pneuma/runtime/core/llm.js'

type LlmIndex = typeof import('../index.js')
let llmPlugin: LlmIndex['llmPlugin']

beforeAll(async () => {
  llmPlugin = (await import('../index.js')).llmPlugin
})

afterAll(() => {
  // 这个包不读盘：没有临时 HOME 要清。
})

const CONFIG: DscCoreConfig = {
  defaultProvider: 'p',
  defaultModel: 'm1',
  providers: {
    p: {
      name: 'p',
      displayName: '',
      baseUrl: 'http://p',
      apiKey: 'key-p',
      models: [
        {
          id: 'm1',
          name: 'M1',
          contextWindow: 1000,
          maxTokens: 100,
          thinkingLevels: ['low', 'high'],
          thinkingParam: 'reasoning-effort',
          effortMap: {},
          modalities: ['text', 'image'],
        },
        {
          id: 'm2',
          name: 'M2',
          contextWindow: 0,
          maxTokens: 50,
          thinkingLevels: [],
          thinkingParam: 'none',
          effortMap: {},
          modalities: ['text'],
        },
      ],
    },
    'command/deepseek': {
      name: 'command/deepseek',
      displayName: 'Command',
      baseUrl: 'http://c',
      apiKey: 'key-c',
      cacheControl: true,
      models: [
        {
          id: 'deepseek/deepseek-v4.1-flash',
          name: 'Flash',
          contextWindow: 64_000,
          maxTokens: 1000,
          thinkingLevels: ['low'],
          thinkingParam: 'thinking',
          effortMap: {},
          modalities: ['text'],
        },
      ],
    },
    // 前缀更短的端点：验证「长端点名优先」，不能被它抢走 command/deepseek 的引用。
    command: {
      name: 'command',
      displayName: 'Command Short',
      baseUrl: 'http://c2',
      apiKey: 'key-c2',
      models: [
        {
          id: 'deepseek/deepseek-v4.1-flash',
          name: 'Flash',
          contextWindow: 64_000,
          maxTokens: 1000,
          thinkingLevels: ['low'],
          thinkingParam: 'thinking',
          effortMap: {},
          modalities: ['text'],
        },
      ],
    },
    deepseek: {
      name: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: 'http://d',
      apiKey: 'key-d',
      models: [
        {
          id: 'deepseek-v4.1-flash',
          name: 'Flash',
          contextWindow: 64_000,
          maxTokens: 1000,
          thinkingLevels: ['low'],
          thinkingParam: 'thinking',
          effortMap: {},
          modalities: ['text'],
        },
      ],
    },
  },
}

interface FakeSession {
  meta: { id: string; cwd: string }
  filePath: string
  states: Map<string, unknown>
  notes: Array<{ id: string; text: string }>
  state(id: string): unknown
  appendState(id: string, payload: unknown): void
  appendNote(id: string, text: string): void
}

function newSession(id = 'sess-1'): FakeSession {
  const states = new Map<string, unknown>()
  const notes: Array<{ id: string; text: string }> = []
  return {
    meta: { id, cwd: 'C:/repo' },
    filePath: `C:/repo/.dsc/sessions/${id}.jsonl`,
    states,
    notes,
    state: (key) => states.get(key),
    appendState(key, payload) {
      states.set(key, payload)
    },
    appendNote(key, text) {
      notes.push({ id: key, text })
    },
  }
}

interface LlmServiceLike {
  readonly provider: string
  readonly model: string
  readonly effort: string
  readonly contextWindow: number
  readonly inputModalities: string[]
  route(): Record<string, unknown>
  routeForSession(session: unknown): Record<string, unknown>
  providerOf(session: unknown): string
  modelOf(session: unknown): string
  contextWindowOf(session: unknown): number
  routeTo(provider: string, model: string, effort: string): Record<string, unknown>
  registerAdapter(adapter: {
    id: string
    stream: (request: StreamRequest, handlers: StreamHandlers) => Promise<StreamResult>
  }): () => void
  stream(api: string, request: StreamRequest, handlers: StreamHandlers): Promise<StreamResult>
  setEffort(effort: string): void
  setModel(provider: string, model: string): void
  parseModelRef(ref: string): { provider: string; model: string }
  listModels(): Array<Record<string, unknown>>
}

interface Harness {
  services: Map<string, unknown>
  events: string[]
  notices: string[]
  debugLines: Array<{ format: string; args: unknown[] }>
  handlers: Map<string, (...args: never[]) => void>
  session: FakeSession
  setSession(session: FakeSession): void
  defaultEffort: string
}

function fakeCtx(options: { saved?: { provider: string; model: string; effort?: string }; defaultEffort?: string } = {}): Harness {
  const services = new Map<string, unknown>()
  const events: string[] = []
  const notices: string[] = []
  const debugLines: Harness['debugLines'] = []
  const handlers = new Map<string, (...args: never[]) => void>()
  const session = newSession()
  if (options.saved !== undefined) session.states.set('model', options.saved)

  const harness = {
    session,
    defaultEffort: options.defaultEffort ?? 'default',
    setSession(next: FakeSession): void {
      harness.session = next
    },
  } as unknown as Harness

  const ctx = {
    session: { current: () => harness.session },
    get(name: string) {
      if (name !== 'settings') return undefined
      return { prefs: () => ({ defaultEffort: harness.defaultEffort }) }
    },
    emit(name: string, text?: string) {
      events.push(name)
      if (name === 'dsc/notice' && typeof text === 'string') notices.push(text)
    },
    logger: {
      debug(format: string, ...args: unknown[]) {
        debugLines.push({ format, args })
      },
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    on(event: string, handler: (...args: never[]) => void) {
      handlers.set(event, handler)
      return () => undefined
    },
  }

  llmPlugin.apply?.(ctx as never, CONFIG)
  harness.services = services
  harness.events = events
  harness.notices = notices
  harness.debugLines = debugLines
  harness.handlers = handlers
  return harness
}

const serviceOf = (harness: Harness): LlmServiceLike => harness.services.get('llm') as LlmServiceLike

const request = (overrides: Partial<StreamRequest> = {}): StreamRequest => ({
  baseUrl: 'http://x',
  apiKey: 'k',
  model: 'm1',
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
})

const handlers = (): StreamHandlers => ({ onDelta: () => undefined })

describe('路由与状态', () => {
  test('当前会话的三项、上下文窗口、模态与 route 字段', () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)

    expect(service.provider).toBe('p')
    expect(service.model).toBe('m1')
    expect(service.effort).toBe('default')
    expect(service.contextWindow).toBe(1000)
    expect(service.inputModalities).toEqual(['text', 'image'])
    expect(service.route()).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'http://p',
      apiKey: 'key-p',
      model: 'm1',
      maxTokens: 100,
      thinking: undefined,
      reasoningEffort: undefined,
    })

    // 档位声明了就发线上值；没声明的档位退回「默认」（不发字段）。
    expect(service.routeTo('p', 'm1', 'high')).toMatchObject({ reasoningEffort: 'high' })
    expect(service.routeTo('p', 'm1', 'max')).toMatchObject({ reasoningEffort: undefined })
    // 端点声明了显式缓存才带 cacheControl。
    expect(service.routeTo('command/deepseek', 'deepseek/deepseek-v4.1-flash', 'low')).toMatchObject({
      cacheControl: true,
      thinking: 'enabled',
    })
    expect(service.routeTo('p', 'm1', 'low').cacheControl).toBeUndefined()
  })

  test('setEffort 校验模型声明、写会话状态并广播；setModel 校验端点与模型', () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)

    expect(() => service.setEffort('max')).toThrow('思考档位「最大」用不了')
    expect(() => service.setEffort('max')).toThrow('这个模型只支持：低、高')

    service.setEffort('high')
    expect(harness.session.state('model')).toMatchObject({ provider: 'p', model: 'm1', effort: 'high' })
    expect(harness.events).toContain('dsc/changed')
    expect(service.effort).toBe('high')

    expect(() => service.setModel('nope', 'm1')).toThrow('没有名为 nope 的端点')
    expect(() => service.setModel('p', 'nope')).toThrow('端点 p 没有模型 nope')
    service.setModel('p', 'm2')
    // 新模型没有思考档位：原档位退回 default，不能把端点不认识的字段发出去。
    expect(harness.session.state('model')).toMatchObject({ provider: 'p', model: 'm2', effort: 'default' })
    expect(service.model).toBe('m2')
    expect(service.contextWindow).toBe(0)
  })

  test('startup 从会话记录恢复模型；session-open 只给没记录的新会话补默认值', () => {
    const hit = fakeCtx({ saved: { provider: 'p', model: 'm1', effort: 'high' } })
    const restored = serviceOf(hit)
    expect(restored.model).toBe('m1')
    expect(restored.effort).toBe('high')

    const harness = fakeCtx()
    const service = serviceOf(harness)
    const open = harness.handlers.get('dsc/session-open')!

    // 新会话（没有 filePath）没记录：把上一次选的写进去。
    const fresh = newSession('sess-new')
    open({ session: fresh, filePath: undefined } as never)
    expect(fresh.state('model')).toMatchObject({ provider: 'p', model: 'm1', effort: 'default' })
    expect(harness.events).toContain('dsc/changed')

    // 恢复老会话（有 filePath）没记录：什么都不写。
    const resumed = newSession('sess-old')
    open({ session: resumed, filePath: resumed.filePath } as never)
    expect(resumed.state('model')).toBeUndefined()

    // 已有记录的会话：只广播，不覆盖。
    const saved = newSession('sess-saved')
    saved.states.set('model', { provider: 'p', model: 'm2', effort: 'default' })
    open({ session: saved, filePath: saved.filePath } as never)
    expect(saved.state('model')).toMatchObject({ model: 'm2' })
    expect(service.model).toBe('m1')
  })

  test('parseModelRef 最长端点前缀优先；listModels 给界面投影', () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)

    expect(service.parseModelRef('command/deepseek/deepseek-v4.1-flash')).toEqual({
      provider: 'command/deepseek',
      model: 'deepseek-v4.1-flash',
    })
    expect(service.parseModelRef('m2')).toEqual({ provider: 'p', model: 'm2' })

    const models = service.listModels()
    expect(models.map((item) => item.value)).toContain('p/m1')
    expect(models.find((item) => item.value === 'p/m1')).toMatchObject({
      provider: 'p',
      // displayName 为空时回落到端点名。
      providerDisplayName: 'p',
      model: 'm1',
      contextWindow: 1000,
      thinkingLevels: ['low', 'high'],
      modalities: ['text', 'image'],
    })
    expect(String(models.find((item) => item.value === 'p/m1')?.description)).toContain('1k 上下文')
    expect(String(models.find((item) => item.value === 'p/m1')?.description)).toContain('照片')
    expect(String(models.find((item) => item.value === 'p/m2')?.description)).toContain('无思考档位')
  })
})

describe('协议适配器与请求派发', () => {
  test('适配器：重名拒绝、卸载生效、未知协议报可用清单', async () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)

    expect(() =>
      service.registerAdapter({ id: 'openai-completions', stream: async () => ({}) as StreamResult }),
    ).toThrow('已经注册过')
    const off = service.registerAdapter({
      id: 'fake',
      stream: async () => ({
        text: 'ok',
        reasoning: '',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 2 },
        finishReason: 'stop',
      }),
    })
    await expect(service.stream('fake', request(), handlers())).resolves.toMatchObject({ text: 'ok' })
    off()
    // stream 在派发前同步抛错（不返回 rejected promise）：用 toThrow 而不是 rejects。
    expect(() => service.stream('fake', request(), handlers())).toThrow('已注册：openai-completions')
    expect(() => service.stream('nope', request(), handlers())).toThrow('没有对应的适配器')
  })

  test('stream：补会话归因、清洗提醒同形状只报一次、追踪号落 note 与日志', async () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    const seen: Array<{ sessionId?: string; sanitize?: unknown }> = []

    service.registerAdapter({
      id: 'fake',
      stream: async (req, h) => {
        seen.push({ sessionId: req.sessionId, sanitize: h.onSanitize })
        h.onSanitize?.({ droppedResults: 1, droppedCalls: 0, droppedMessages: 0, reordered: 0 })
        h.onSanitize?.({ droppedResults: 1, droppedCalls: 0, droppedMessages: 0, reordered: 0 })
        h.onRequestDebug?.({ requestId: 'req-7' } as never)
        return {
          text: 'ok',
          reasoning: '',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 2 },
          finishReason: 'stop',
        }
      },
    })

    await service.stream('fake', request(), handlers())
    expect(seen[0]!.sessionId).toBe('sess-1')
    // 同一个会话同一种残留形状只报一次。
    expect(harness.notices).toHaveLength(1)
    expect(harness.notices[0]).toContain('丢弃重复/孤儿的工具结果 1 条')
    expect(harness.session.notes).toEqual([{ id: 'llm/request-id', text: 'fake req-7' }])
    expect(harness.debugLines).toEqual([{ format: 'llm %s request-id %s', args: ['fake', 'req-7'] }])

    // 调用方显式给了会话归因就听它的。
    await service.stream('fake', request({ sessionId: 'explicit' }), handlers())
    expect(seen[1]!.sessionId).toBe('explicit')
  })
})
