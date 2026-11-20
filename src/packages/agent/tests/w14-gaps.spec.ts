/**
 * agent 插件长尾补盲（w14）：`deps.notice` 接成 `dsc/notice` 时带会话归属、
 * 爆窗重试挂 `onContextOverflow`、`stop()` 等「还在忙的 agent」收摊，
 * 以及 cache-probe 的同名工具排序稳定返回 0。
 *
 * 复用 `wiring.spec.ts` 的假 ctx 形状：会话是真的（临时 `DSC_HOME` + 临时工作区），
 * MiniAgent 也是真的，只有模型流与宿主表面是假的。`DSC_HOME` 在任何产品 import 之前
 * 指进临时目录。
 *
 * @module dsc/packages/agent/tests/w14-gaps.spec
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type { ChatMessage, StreamHandlers, StreamRequest, StreamResult } from '@pneuma/runtime/core/llm.js'
import { sortToolSchemas } from '../cache-probe.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-agent-w14-'))
process.env['DSC_HOME'] = HOME
const WORKSPACE = mkdtempSync(join(tmpdir(), 'dsc-agent-w14-cwd-'))

type SessionT = import('../../../core/session.js').Session
let agentPlugin: (typeof import('../index.js'))['agentPlugin']
let SessionClass: (typeof import('../../../core/session.js'))['Session']
let LlmErrorClass: (typeof import('../../../core/llm.js'))['LlmError']

const ROUTE = { api: 'fake', baseUrl: 'http://fake', apiKey: 'k', model: 'fake/model', maxTokens: 16 }

const okStream = (text: string): StreamResult => ({
  text,
  reasoning: '',
  toolCalls: [],
  usage: null,
  finishReason: 'stop',
})

beforeAll(async () => {
  SessionClass = (await import('../../../core/session.js')).Session
  LlmErrorClass = (await import('../../../core/llm.js')).LlmError
  agentPlugin = (await import('../index.js')).agentPlugin
})

const openSessions: SessionT[] = []

beforeEach(() => {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
})

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
  hasAgent(sessionId: string): boolean
  isRunning(filePath: string): boolean
  stop(filePath: string): Promise<void>
}

interface Harness {
  services: Map<string, unknown>
  events: Array<{ name: string; args: unknown[] }>
  notices: Array<{ text: string; sessionPath?: string }>
  handlers: Map<string, Array<(...args: never[]) => void>>
  session: SessionT
  stream: (api: string, request: StreamRequest, handlers: StreamHandlers) => Promise<StreamResult>
  forceCompact: (signal: AbortSignal) => Promise<boolean>
  projections: Array<(messages: ChatMessage[]) => ChatMessage[]>
  extraProjection: ((messages: ChatMessage[]) => ChatMessage[]) | undefined
}

function newSession(id: string): SessionT {
  const session = SessionClass.create(WORKSPACE, join(HOME, 'sessions', `${id}.jsonl`))
  openSessions.push(session)
  return session
}

/** 等一个条件成立（回合与落盘都是异步的）。 */
async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
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
  const notices: Harness['notices'] = []
  const handlers = new Map<string, Array<(...args: never[]) => void>>()
  const projections: Harness['projections'] = []
  const session = newSession('sess-w14')
  session.appendUser('种子')

  const rewrite = (messages: ChatMessage[]): ChatMessage[] => {
    let out = messages
    for (const projection of projections) out = projection(out)
    return out
  }

  const harness: Harness = {
    services,
    events,
    notices,
    handlers,
    session,
    stream: async () => okStream('好的'),
    forceCompact: async () => false,
    projections,
    extraProjection: undefined,
  }
  harness.projections.push((messages) => (harness.extraProjection === undefined ? messages : harness.extraProjection(messages)))

  const ctx = {
    session: { current: () => harness.session },
    llm: {
      routeForSession: () => ROUTE,
      providerOf: () => 'fake',
      modelOf: () => ROUTE.model,
      stream: (api: string, request: StreamRequest, streamHandlers: StreamHandlers) =>
        harness.stream(api, request, streamHandlers),
    },
    compact: {
      check: async () => undefined,
      forceCompact: (signal: AbortSignal) => harness.forceCompact(signal),
    },
    prompt: {
      systemPromptParts: () => ({ text: '系统提示', sections: [] }),
      rewrite,
      registerProjection(_id: string, fn: (messages: ChatMessage[]) => ChatMessage[]) {
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
      emit: () => undefined,
      system: () => undefined,
    },
    emit(name: string, ...args: unknown[]) {
      events.push({ name, args })
      if (name === 'dsc/notice' && typeof args[0] === 'string') {
        // 归属参数在中间（`dsc/notice` 的第二个槽是 undefined 或类别），取最后一个字符串参数。
        const sessionPath = args.filter((arg): arg is string => typeof arg === 'string').at(-1)
        notices.push({ text: args[0], ...(sessionPath === undefined ? {} : { sessionPath }) })
      }
    },
    get() {
      return undefined
    },
    on(event: string, handler: (...args: never[]) => void) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => undefined
    },
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
  }
  agentPlugin.apply?.(ctx as never, undefined)
  return harness
}

const serviceOf = (harness: Harness): AgentServiceLike => harness.services.get('agent') as AgentServiceLike

describe('deps 接线', () => {
  test('invariant 失配：提醒走 dsc/notice 且带会话归属（filePath）', async () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    let rewrites = 0
    harness.extraProjection = (messages) => {
      rewrites += 1
      return rewrites === 1 ? messages : [...messages, { role: 'user', content: '投影多出来的一条' }]
    }
    service.followup('你好')
    await until(() => harness.notices.length > 0)
    const notice = harness.notices.find((item) => item.text.includes('请求 invariant'))
    expect(notice?.text).toContain('请求 invariant')
    expect(notice?.sessionPath).toBe(harness.session.filePath)
  })

  test('爆窗：走 compact.forceCompact 压一次再重试，重试成功不把回合打红', async () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    let streamCalls = 0
    let forceCalls = 0
    harness.stream = async () => {
      streamCalls += 1
      if (streamCalls === 1) throw new LlmErrorClass('maximum context length exceeded', 400)
      return okStream('压完再答')
    }
    harness.forceCompact = async () => {
      forceCalls += 1
      return true
    }
    service.followup('hi')
    await until(() => harness.events.some((item) => item.name === 'dsc/turn-end'))
    expect(streamCalls).toBe(2)
    expect(forceCalls).toBe(1)
    const turnEnd = harness.events.find((item) => item.name === 'dsc/turn-end')
    expect(turnEnd?.args[0]).toBe('completed')
  })

  test('stop：agent 还在忙时进等待循环，回合收尾后收摊并移出名册', async () => {
    const harness = fakeCtx()
    const service = serviceOf(harness)
    let release: ((result: StreamResult) => void) | undefined
    harness.stream = () =>
      new Promise<StreamResult>((resolve) => {
        release = resolve
      })
    service.followup('慢慢答')
    await until(() => service.isRunning(harness.session.filePath))
    const stopping = service.stop(harness.session.filePath)
    await until(() => release !== undefined)
    release!(okStream('答完了'))
    await stopping
    expect(service.hasAgent(harness.session.meta.id)).toBe(false)
    expect(service.isRunning(harness.session.filePath)).toBe(false)
  })
})

describe('工具定义排序', () => {
  test('同名工具比较返回 0：排序不抛错、两条都在', () => {
    const tool = { name: 'same', description: 'd', parameters: {} }
    const sorted = sortToolSchemas({ baseUrl: '', apiKey: '', model: 'm', messages: [], tools: [tool, { ...tool }] })
    expect(sorted.tools?.map((item) => item.name)).toEqual(['same', 'same'])
  })
})
