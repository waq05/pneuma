/**
 * llm 插件长尾补盲（w14）：无会话时的请求归因兜底、未知端点的路由报错、
 * 按「传进来的那条会话」取路由/提供方/模型/窗口。
 *
 * 复用 `wiring.spec.ts` 的假 ctx 形状：端点与模型都是配置里的假数据，会话是假的，
 * 不联网、不读盘。这里只测 `index.ts` 里 wiring 没走到的几条分支。
 *
 * @module dsc/packages/llm/tests/w14-gaps.spec
 */
import { beforeAll, describe, expect, test } from 'vitest'
import type { DscCoreConfig, ModelInfo } from '@pneuma/runtime/core/config.js'
import type { LlmRoute, LlmService } from '@pneuma/runtime/services/types.js'

let llmPlugin: (typeof import('../index.js'))['llmPlugin']

beforeAll(async () => {
  llmPlugin = (await import('../index.js')).llmPlugin
})

const model = (id: string, contextWindow: number): ModelInfo => ({
  id,
  name: id,
  contextWindow,
  maxTokens: 100,
  thinkingLevels: [],
  thinkingParam: 'none',
  effortMap: {},
  modalities: ['text'],
})

const CONFIG: DscCoreConfig = {
  defaultProvider: 'p',
  defaultModel: 'm1',
  providers: {
    p: {
      name: 'p',
      displayName: 'P',
      baseUrl: 'http://p',
      apiKey: 'key-p',
      models: [model('m1', 1_000), model('m2', 4_096)],
    },
  },
}

interface FakeSession {
  meta: { id: string; cwd: string }
  filePath: string
  states: Map<string, unknown>
  state(id: string): unknown
  appendState(id: string, payload: unknown): void
  appendNote(id: string, text: string): void
}

function newSession(id = 'sess-1'): FakeSession {
  const states = new Map<string, unknown>()
  return {
    meta: { id, cwd: 'C:/repo' },
    filePath: `C:/repo/.dsc/sessions/${id}.jsonl`,
    states,
    state: (key) => states.get(key),
    appendState(key, payload) {
      states.set(key, payload)
    },
    appendNote() {},
  }
}

interface Harness {
  session: FakeSession
  holder: { current: () => FakeSession }
  services: Map<string, unknown>
  defaultEffort: string
}

function fakeCtx(
  options: { saved?: { provider: string; model: string; effort?: string }; defaultEffort?: string } = {},
): Harness {
  const session = newSession()
  if (options.saved !== undefined) session.states.set('model', options.saved)
  const holder = { current: (): FakeSession => session }
  const services = new Map<string, unknown>()
  const harness: Harness = {
    session,
    holder,
    services,
    defaultEffort: options.defaultEffort ?? 'default',
  }
  const ctx = {
    session: holder,
    get(name: string) {
      if (name !== 'settings') return undefined
      return { prefs: () => ({ defaultEffort: harness.defaultEffort }) }
    },
    emit() {},
    logger: { debug() {} },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    on() {
      return () => undefined
    },
  }
  llmPlugin.apply?.(ctx as never, CONFIG)
  return harness
}

const serviceOf = (harness: Harness): LlmService => harness.services.get('llm') as LlmService

describe('按会话取路由', () => {
  test('routeForSession / providerOf / modelOf / contextWindowOf 看的是传进来的会话，不是当前查看的', () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    const other = newSession('sess-2')
    other.states.set('model', { provider: 'p', model: 'm2', effort: 'default' })

    expect(service.routeForSession(other as never) as LlmRoute).toMatchObject({ model: 'm2', maxTokens: 100 })
    expect(service.providerOf(other as never)).toBe('p')
    expect(service.modelOf(other as never)).toBe('m2')
    expect(service.contextWindowOf(other as never)).toBe(4_096)

    // 没记过模型的会话回落配置默认。
    const fresh = newSession('sess-3')
    expect(service.modelOf(fresh as never)).toBe('m1')
    expect(service.contextWindowOf(fresh as never)).toBe(1_000)
  })
})

describe('未知端点', () => {
  test('routeTo 里的端点不在配置里：报出端点名与去哪改', () => {
    const service = serviceOf(fakeCtx())
    expect(() => service.routeTo('ghost', 'm1', 'default')).toThrow('没有名为 ghost 的模型端点')
    expect(() => service.routeTo('ghost', 'm1', 'default')).toThrow('config.yaml')
  })
})

describe('请求归因兜底', () => {
  test('拿不到当前会话时省略归因头，请求照样派发', async () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    let seen: { sessionId?: string } | undefined
    service.registerAdapter({
      id: 'stub',
      async stream(request) {
        seen = request as unknown as { sessionId?: string }
        return { text: 'ok', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
      },
    })
    // apply 之后才把「当前会话」弄坏：apply 期读的是会话状态，那一步必须还是好的。
    harness.holder.current = () => {
      throw new Error('还没打开任何会话')
    }
    const result = await service.stream(
      'stub',
      { baseUrl: 'http://x', apiKey: 'k', model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
      { onDelta() {} },
    )
    expect(result.text).toBe('ok')
    expect(seen?.sessionId).toBeUndefined()
  })
})
