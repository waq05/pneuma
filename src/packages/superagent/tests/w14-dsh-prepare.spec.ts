/**
 * `executor/dsh.ts` 的工作区准备路径（`prepareDirectory`）覆盖。
 *
 * `kernel-executor.spec.ts` 明确把这条路径留空：它的注释写着「让工作区目录预先存在以跳过
 * 准备命令」。于是 302-316 行整段（mkdir → 读设置里的 prepare 命令 → 生效时区环境 →
 * 超时信号 → 跑命令 → 失败清空目录 → 建目录 → verifyDirectory）没有任何用例走到。
 *
 * 这里复用同形的假宿主（引擎回调 / 工单表 / 效果队列 / 会话管理器都是内存替身），只把
 * 「工作区目录不存在」和「设置里有 prepare 命令」这两件事摆进去，让真 `runAsWorker` 跑
 * 一个 `node -e` 小命令。成功与失败两支都测：成功要继续派工（492-493 行的二次检查），
 * 失败要抛 `PrepareFailed` 并清掉空目录。
 *
 * @module dsc/packages/superagent/tests/w14-dsh-prepare
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { SettingsSchema } from '../core/policy.js'
import type { Assignment, Ticket, Trigger } from '../core/model.js'
import { DshExecutor } from '../executor/dsh.js'

const NOW = '2026-01-01T00:00:00.000Z'
const CHANNEL = {
  source: 'feishu',
  thread: 'feishu:oc_1',
  address: { chatId: 'oc_1' },
}

function triggerOf(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id,
    source: 'feishu',
    threads: [{ source: 'feishu', id: 'x' }],
    actor: { source: 'feishu', id: 'ou_1' },
    human: true,
    at: NOW,
    text: '把登录页改成中文',
    channel: CHANNEL,
    meta: {},
    ...overrides,
  }
}

function assignmentOf(overrides: Partial<Assignment> = {}): Assignment {
  return { id: 'a1', state: 'pending', createdAt: NOW, ...overrides }
}

function ticketOf(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'tk1',
    title: '登录页改中文',
    decisionId: 'dec1',
    mandate: {
      strength: 'explicit',
      policyVersion: 'v1',
      basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'feishu', id: 'ou_1' },
      scope: 'chat',
    },
    channels: [],
    assignments: [assignmentOf()],
    inputs: [],
    undelivered: [],
    createdAt: NOW,
    updatedAt: NOW,
    origin: { triggerId: 'trig1', triggerIds: ['trig1'] },
    ...overrides,
  }
}

// ── 假宿主：与 kernel-executor.spec.ts 同形（只保留本文件用到的口子）────────

interface FakeAgent {
  id: string
  status: 'idle' | 'running'
  last: string
  whenIdle: () => Promise<void>
  cancel: (options?: { kind: string; keepInbox?: boolean }) => void
  inbox: { remove: (id: string) => void }
  lastAssistantText: () => string
}

function makeHost(options: { tickets?: Ticket[]; triggers?: Map<string, Trigger> } = {}) {
  const handlers = new Map<string, (payload: never) => void>()
  const disposers: (() => void)[] = []
  const tickets = new Map((options.tickets ?? []).map((ticket) => [ticket.id, ticket]))
  const triggers = options.triggers ?? new Map<string, Trigger>()
  const agents = new Map<string, FakeAgent>()
  const effects: {
    handlers: Map<string, (payload: never) => unknown>
    enqueued: { kind: string; id: string; payload: unknown }[]
    options: Map<string, unknown>
    handle: (kind: string, handler: (payload: never) => unknown, effectOptions: unknown) => void
    enqueue: (kind: string, id: string, payload: unknown) => void
  } = {
    handlers: new Map(),
    enqueued: [],
    options: new Map(),
    handle(kind, handler, effectOptions) {
      effects.handlers.set(kind, handler)
      effects.options.set(kind, effectOptions)
    },
    enqueue(kind, id, payload) {
      effects.enqueued.push({ kind, id, payload })
    },
  }
  const calls = {
    started: [] as { ticketId: string; assignmentId: string }[],
    prompts: [] as {
      sessionId: string
      requestId: string
      text: string
      mode: unknown
    }[],
    ensures: [] as { sessionId: string; directory: string }[],
    reports: [] as { ticketId: string; state: string; summary?: string }[],
  }
  let now = 0
  const settings = SettingsSchema.parse({
    executor: { maxWorkers: 4, prepare: '' },
  })
  const newAgent = (id: string): FakeAgent => {
    const value: FakeAgent = {
      id,
      status: 'idle',
      last: '我改完了',
      whenIdle: async () => {},
      cancel() {
        value.status = 'idle'
      },
      inbox: { remove() {} },
      lastAssistantText: () => value.last,
    }
    agents.set(id, value)
    return value
  }
  const agentFor = (id: string): FakeAgent => agents.get(id) ?? newAgent(id)
  const host = {
    context: {
      on(event: string, handler: (payload: never) => void) {
        handlers.set(event, handler)
        const dispose = () => {
          handlers.delete(event)
        }
        disposers.push(dispose)
        return dispose
      },
      get: () => undefined,
    },
    engine: {
      assignmentStarted: (ticketId: string, assignmentId: string) => {
        calls.started.push({ ticketId, assignmentId })
      },
      inputsDelivered: () => {},
      inputsRead: () => {},
      turnEnded: () => {},
      deliveryFailed: () => {},
      assignmentInterrupted: () => {},
      report: (ticketId: string, report: { state: string; summary?: string }) => {
        calls.reports.push({ ticketId, ...report })
        const current = tickets.get(ticketId)!
        const updated = {
          ...current,
          updatedAt: new Date(++now).toISOString(),
          statusReport: report,
        }
        tickets.set(ticketId, updated)
        return updated
      },
    },
    store: {
      tickets: {
        get: (id: string) => tickets.get(id),
        list: () => [...tickets.values()],
        open: () => [...tickets.values()].filter((ticket) => !ticket.ended),
      },
      triggers: { get: (id: string) => triggers.get(id) },
      set: () => {},
      settings: () => settings,
      atomic: (work: () => unknown) => work(),
      afterCommit: (work: () => void) => {
        work()
      },
    },
    effects: {
      handle(kind: string, handler: (payload: never) => unknown, effectOptions: unknown) {
        effects.handle(kind, handler, effectOptions)
      },
      enqueue(kind: string, id: string, payload: unknown) {
        effects.enqueue(kind, id, payload)
      },
    },
    health: { get: () => undefined, set: () => {} },
    machine: { stateDir: '/state' },
    lifetime: new AbortController().signal,
    sessions: {
      ensure: async (sessionId: string, directory: string) => {
        calls.ensures.push({ sessionId, directory })
        return agentFor(sessionId)
      },
      prompt: async (sessionId: string, requestId: string, text: string, mode: unknown) => {
        calls.prompts.push({ sessionId, requestId, text, mode })
      },
      promptedId: (id: string) => `prompted:${id}`,
      relay: () => {},
      holds: async () => false,
      agent: (sessionId: string) => agents.get(sessionId),
    },
    closing: () => false,
    paused: () => false,
    environment: () => [],
    sourceLink: async () => ({}),
    repliedTo: () => undefined,
  }
  return {
    host,
    tickets,
    triggers,
    agents,
    effects,
    calls,
    handlers,
    disposers,
    newAgent,
    settings,
  }
}

function setup(options: { tickets?: Ticket[]; triggers?: Map<string, Trigger> } = {}) {
  const built = makeHost(options)
  const executor = new DshExecutor(built.host as never)
  executor.install()
  return { executor, built }
}

const launchHandlerOf = (built: ReturnType<typeof makeHost>) =>
  built.effects.handlers.get('launch') as (payload: { ticketId: string; assignmentId: string }) => Promise<void>

describe('DshExecutor.prepareDirectory：工作区不存在时真跑准备命令', () => {
  test('prepare 命令成功：建目录、跑命令、verifyDirectory 通过，然后照常派工', async () => {
    const parent = createTempDir('dsc-dsh-prepare-ok-')
    const workspace = join(parent, 'login-fix-tk1')
    const ticket = ticketOf({
      execution: {
        name: 'login-fix-tk1',
        directory: workspace,
        assignment: '把登录页改成中文',
      },
    })
    const { built } = setup({
      tickets: [ticket],
      triggers: new Map([['trig1', triggerOf('trig1')]]),
    })
    built.settings.executor.prepare = 'node -e "console.log(\'prepared\')"'

    await launchHandlerOf(built)({ ticketId: 'tk1', assignmentId: 'a1' })

    expect(existsSync(workspace)).toBe(true)
    expect(built.calls.ensures).toEqual([{ sessionId: 'worker-tk1', directory: workspace }])
    expect(built.calls.prompts).toHaveLength(1)
    expect(built.calls.started).toEqual([{ ticketId: 'tk1', assignmentId: 'a1' }])
  })

  test('prepare 命令失败：抛 PrepareFailed（带命令输出），空目录被清掉，不派工', async () => {
    const parent = createTempDir('dsc-dsh-prepare-fail-')
    const workspace = join(parent, 'login-fix-tk1')
    mkdirSync(parent, { recursive: true })
    const ticket = ticketOf({
      execution: {
        name: 'login-fix-tk1',
        directory: workspace,
        assignment: '把登录页改成中文',
      },
    })
    const { built } = setup({
      tickets: [ticket],
      triggers: new Map([['trig1', triggerOf('trig1')]]),
    })
    built.settings.executor.prepare = 'node -e "process.exit(3)"'

    // PrepareFailed 不重试：launchQueued 把它记成工单 failed，而不是继续派工。
    await launchHandlerOf(built)({ ticketId: 'tk1', assignmentId: 'a1' })
    expect(built.calls.reports).toEqual([
      {
        ticketId: 'tk1',
        state: 'failed',
        summary: expect.stringMatching(/prepare command failed/i),
      },
    ])
    // 命令没写东西：失败后把这个空目录清掉，下一次重试不会误以为已准备好。
    expect(existsSync(workspace)).toBe(false)
    expect(built.calls.ensures).toEqual([])
    expect(built.calls.prompts).toEqual([])
  })
})
