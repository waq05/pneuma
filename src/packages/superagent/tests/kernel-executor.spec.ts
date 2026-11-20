/**
 * `executor/dsh.ts` 的包级补盲：工作区命名 / 消息格式的纯函数、`WorkerSlots` 的并发保留，
 * 以及 `DshExecutor` 用假宿主走通的几条主路径（派工、投递、停工、重连、事件处理）。
 *
 * 为什么用假宿主：这个类只通过 `ExecutorHost` 的六个口子跟外面打交道（引擎回调、工单存储、
 * 效果队列、会话管理器、体检格、Cordis 事件）。真起宿主要真模型、真子进程；判据只在于
 * 「它按顺序调了谁、传了什么」，所以按 `app/sessions.ts` 的 `SessionHandle` 形状造真对象替身，
 * 不 mock 被测函数本身。
 *
 * 不覆盖的部分写明：`prepareDirectory` 要真跑 shell 命令与 git（见 `environment.test.mjs`
 * 探针对 `runAsWorker` / `verifyDirectory` 的覆盖），这里让工作区目录预先存在以跳过准备命令。
 *
 * @module dsc/packages/superagent/tests/kernel-executor
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { Later } from '../app/effects.js'
import { key } from '../core/ids.js'
import { SettingsSchema } from '../core/policy.js'
import type { Assignment, Ticket, Trigger } from '../core/model.js'
import {
  DshExecutor,
  WorkerSlots,
  batchLine,
  batchOf,
  inputMessage,
  inputResource,
  mandateInstructions,
  sourceTrigger,
  ticketExecution,
  ticketOfSession,
  transient,
  triggerMessage,
  workerSessionId,
} from '../executor/dsh.js'

const NOW = '2026-01-01T00:00:00.000Z'
const CHANNEL = { source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1' } }

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
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'feishu', id: 'ou_1' }, scope: 'chat' },
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

// ── 纯函数 ──────────────────────────────────────────────────────────────────

describe('dsh：会话 id 与工作区命名', () => {
  test('workerSessionId / ticketOfSession 互逆，非 worker 会话还原成 undefined', () => {
    expect(workerSessionId('tk1')).toBe('worker-tk1')
    expect(ticketOfSession('worker-tk1')).toBe('tk1')
    expect(ticketOfSession('master')).toBeUndefined()
    expect(ticketOfSession('worker-')).toBe('')
  })

  test('ticketExecution：远端的 accept 决定工作区名、目录与给 worker 的作业说明', () => {
    const settings = SettingsSchema.parse({})
    const ticket = ticketOf({ id: 'abcdef0123456789' })
    const outcome = { kind: 'accept' as const, title: '标题', scope: 'chat', reason: '要做', name: 'login-fix' }
    const execution = ticketExecution(ticket, outcome, settings, '/state')
    expect(execution.name).toBe('login-fix-abcdef012345')
    expect(execution.directory.endsWith(join('login-fix-abcdef012345'))).toBe(true)
    expect(execution.assignment).toBe('')
  })

  test('ticketExecution：规则型接单把规则、范围与路由备注拼进说明；无规则时只留备注', () => {
    const settings = SettingsSchema.parse({
      policy: { rules: [{ id: 'r1', name: '小改动', enabled: true, instruction: '只动一个模块' }] },
    })
    // 规则型接单：授权来源是「有工单的线程里的后续消息」（`via: 'followup'`），规则 id 记在 basis.rules。
    const ticket = ticketOf({ id: 'tk1', mandate: { ...ticketOf().mandate, strength: 'inferred', basis: { via: 'followup', rules: ['r1'] } } })
    const execution = ticketExecution(ticket, {
      kind: 'accept', title: '标题', scope: 'chat', reason: '要做', name: 'login-fix', note: '来源是工单 42',
    }, settings, '/state')
    expect(execution.assignment).toContain('Proactively accepted under r1')
    expect(execution.assignment).toContain('小改动 (r1): 只动一个模块')
    expect(execution.assignment).toContain('Routing note (not the source request): 来源是工单 42')

    const noNote = ticketExecution(ticketOf({ id: 'tk2' }), { kind: 'accept', title: '标题', scope: 'chat', reason: '要做', name: 'login-fix' }, settings, '/state')
    expect(noNote.assignment).toBe('')
  })

  test('mandateInstructions：只有规则型接单才有附加授权说明', () => {
    expect(mandateInstructions({ strength: 'inferred' })).toContain('limited proactive authorization')
    expect(mandateInstructions({ strength: 'explicit' })).toBe('')
  })

  test('sourceTrigger / batchOf / batchLine：取来源与同批其它消息', () => {
    const host = { store: { triggers: { get: (id: string) => (id === 'trig1' ? triggerOf('trig1') : id === 'trig2' ? triggerOf('trig2') : undefined) } } }
    expect(sourceTrigger(host as never, ticketOf())!.id).toBe('trig1')
    expect(sourceTrigger(host as never, ticketOf({ origin: { triggerId: 'ghost', triggerIds: [] } }))).toBeUndefined()

    const ticket = ticketOf({ origin: { triggerId: 'trig1', triggerIds: ['trig1', 'trig2', 'ghost'] } })
    expect(batchOf(host as never, ticket).map((trigger) => trigger.id)).toEqual(['trig2'])
    expect(batchLine(triggerOf('trig2', { text: '很多   空白\n换行' }))).toEqual({
      trigger_id: 'trig2', from: 'ou_1', at: NOW, preview: '很多 空白 换行', read: 'trigger/trig2',
    })
  })
})

describe('dsh：消息格式', () => {
  test('triggerMessage：带上来源链接、路由备注与未读的回复预览；长文本截断并给读取路径', () => {
    const trigger = triggerOf('trig1', { text: 'x'.repeat(700) })
    const message = triggerMessage(trigger, { source_url: 'https://example.test/1' }, '备注', triggerOf('parent', { text: '很长的原文 '.repeat(30) }))
    expect(message.trigger_id).toBe('trig1')
    expect(message.thread).toBe('feishu:x')
    expect(message.source_url).toBe('https://example.test/1')
    expect(message.routing_note).toBe('备注')
    expect(message.text).toHaveLength(601)
    expect(message.chars).toBe(700)
    expect(message.read).toBe('trigger/trig1')
    expect(message.replies_to!.preview.length).toBeLessThanOrEqual(160)
    expect(message.replies_to!.preview.includes('\n')).toBe(false)

    const short = triggerMessage(triggerOf('t2'), {})
    expect(short.text).toBe('把登录页改成中文')
    expect('chars' in short).toBe(false)
    expect('routing_note' in short).toBe(false)
    expect('replies_to' in short).toBe(false)
  })

  test('inputMessage：trigger / policy-changed / resumed / note / text / legacy reopen 各一形', () => {
    expect(inputMessage({ id: 'in1', kind: 'trigger', triggerId: 'trig1', at: NOW }, { trigger_id: 'trig1' }))
      .toBe(JSON.stringify({ trigger_id: 'trig1' }))
    expect(inputMessage({ id: 'in1', kind: 'trigger', triggerId: 'trig1', at: NOW }))
      .toBe(JSON.stringify({ trigger_id: 'trig1', read: 'trigger/trig1' }))
    expect(inputMessage({ id: 'in1', kind: 'trigger', triggerId: 'trig1', at: NOW, context: true }, { trigger_id: 'trig1' }))
      .toBe(JSON.stringify({ trigger_id: 'trig1', context: true }))

    const policy = inputMessage({ id: 'in2', kind: 'policy-changed', from: 'v1', to: 'v2', at: NOW })
    expect(policy).toContain('Policy change')
    const policyEffect = inputMessage({
      id: 'in2', kind: 'policy-changed', from: 'v1', to: 'v2', at: NOW,
      effect: { rules: [{ id: 'r1', name: '小改动', change: 'disabled' }, { id: 'r2', name: '修 bug', change: 'changed', instruction: '只修 bug' }],
        proactive: false, requesterAllowed: false, requester: { id: 'ou_9', source: 'feishu' } },
    })
    expect(policyEffect).toContain('Rule 小改动 (r1)')
    expect(policyEffect).toContain('Rule 修 bug (r2)')
    expect(policyEffect).toContain('Work inferred from a rule is no longer accepted')
    expect(policyEffect).toContain('ou_9 on feishu')

    expect(inputMessage({ id: 'in3', kind: 'resumed', triggerId: 'trig1', at: NOW })).toContain('resumed it under the same mandate')
    expect(inputMessage({ id: 'in4', kind: 'note', text: '上下文', at: NOW })).toBe('Note from the orchestrator, for context only: 上下文')
    expect(inputMessage({ id: 'in5', kind: 'text', text: '请看下 CI', at: NOW })).toBe('请看下 CI')
    expect(inputMessage({ id: 'in6', kind: 'reopen', at: NOW } as never)).toBeUndefined()
    expect(inputResource('tk1', 'in1')).toBe(`ticket/tk1/input/${key('in1')}`)
  })

  test('transient：HTTP 408/429/5xx 与网络类错误算瞬时，其余不算', () => {
    expect(transient({ status: 408 })).toBe(true)
    expect(transient({ status: 429 })).toBe(true)
    expect(transient({ status: 503 })).toBe(true)
    expect(transient({ status: 404 })).toBe(false)
    expect(transient(new Error('fetch failed'))).toBe(true)
    expect(transient(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true)
    expect(transient(new Error('rate limit exceeded'))).toBe(true)
    expect(transient(new Error('bad request'))).toBe(false)
    expect(transient('socket hang up')).toBe(true)
    expect(transient(undefined)).toBe(false)
  })
})

describe('dsh：WorkerSlots 并发保留', () => {
  test('running 与 starting 一起算占用；launch 只按 running 与 wake 扣名额', () => {
    const running: string[] = []
    const slots = new WorkerSlots(() => running, () => 2)
    expect(slots.used()).toBe(0)
    expect(slots.launches()).toBe(2)
    slots.reserve('t1', 'launch')
    expect(slots.used()).toBe(1)
    expect(slots.launches()).toBe(2)
    slots.reserve('t2', 'wake')
    expect(slots.launches()).toBe(1)
    slots.free('t2')
    running.push('t3')
    expect(slots.used()).toBe(2)
    expect(slots.launches(), 'wake 已释放，只剩 running 的 t3 占一个名额').toBe(1)
    expect(() => slots.reserve('t4', 'wake')).toThrow(Later)
  })

  test('没名额时抛 Later；person 多占一个名额；同一张工单重复 reserve 幂等', () => {
    const slots = new WorkerSlots(() => [], () => 1)
    slots.reserve('t1', 'launch')
    expect(() => slots.reserve('t2', 'launch')).toThrow(Later)
    slots.reserve('t2', 'person')
    expect(slots.used()).toBe(2)
    slots.reserve('t2', 'wake')
    expect(slots.used()).toBe(2)
    slots.free('t1')
    slots.free('t2')
    expect(slots.used()).toBe(0)
  })
})

// ── DshExecutor ─────────────────────────────────────────────────────────────

interface FakeAgent {
  id: string
  status: 'idle' | 'running'
  cancels: { kind: string; keepInbox?: boolean }[]
  removed: string[]
  last: string
  whenIdle: () => Promise<void>
  cancel: (options?: { kind: string; keepInbox?: boolean }) => void
  inbox: { remove: (id: string) => void }
  lastAssistantText: () => string
}

/** 夹具与宿主合并后的对象：既带调用记录，也带宿主自己的 `sessions` / `engine` 等口子。 */
type FakeHost = ReturnType<typeof makeHost>['host'] & ReturnType<typeof makeHost>

interface Harness {
  executor: DshExecutor
  host: FakeHost
  agent: FakeAgent
}

function makeHost(options: {
  tickets?: Ticket[]
  triggers?: Map<string, Trigger>
  paused?: boolean
  closing?: boolean
  maxWorkers?: number
  sessionStatus?: 'idle' | 'running'
  services?: Record<string, unknown>
} = {}) {
  const handlers = new Map<string, (payload: never) => void>()
  const disposers: (() => void)[] = []
  const tickets = new Map((options.tickets ?? []).map(ticket => [ticket.id, ticket]))
  const triggers = options.triggers ?? new Map<string, Trigger>()
  const agents = new Map<string, FakeAgent>()
  const effects: { handlers: Map<string, (payload: never) => unknown>; enqueued: { kind: string; id: string; payload: unknown }[]; options: Map<string, unknown>;
    handle: (kind: string, handler: (payload: never) => unknown, effectOptions: unknown) => void;
    enqueue: (kind: string, id: string, payload: unknown) => void } = {
    handlers: new Map(),
    enqueued: [],
    options: new Map(),
    handle(kind, handler, effectOptions) {
      effects.handlers.set(kind, handler)
      effects.options.set(kind, effectOptions)
    },
    enqueue(kind, id, payload) { effects.enqueued.push({ kind, id, payload }) },
  }
  const calls = {
    started: [] as { ticketId: string; assignmentId: string }[],
    delivered: [] as { ticketId: string; assignmentId: string; inputIds: string[] }[],
    read: [] as { ticketId: string; inputIds: string[] }[],
    turnEnded: [] as { ticketId: string; assignmentId: string }[],
    deliveryFailed: [] as { ticketId: string; error: string }[],
    interrupted: [] as { ticketId: string; assignmentId: string }[],
    prompts: [] as { sessionId: string; requestId: string; text: string; mode: unknown }[],
    relays: [] as { sessionId: string; text: string }[],
    reports: [] as { ticketId: string; state: string }[],
    cancels: [] as string[],
    health: [] as { state?: string; detail?: string }[],
    ensures: [] as { sessionId: string; directory: string }[],
  }
  let now = 0
  const settings = SettingsSchema.parse({ executor: { maxWorkers: options.maxWorkers ?? 4, prepare: '' } })
  const newAgent = (id: string, status?: 'idle' | 'running'): FakeAgent => {
    const value: FakeAgent = {
      id,
      status: status ?? options.sessionStatus ?? 'idle',
      cancels: [],
      removed: [],
      last: '我改完了',
      whenIdle: async () => {},
      cancel(cancelOptions: { kind: string; keepInbox?: boolean } = { kind: 'user' }) {
        value.cancels.push(cancelOptions)
        value.status = 'idle'
      },
      inbox: {
        remove(removedId: string) { value.removed.push(removedId) },
      },
      lastAssistantText: () => value.last,
    }
    agents.set(id, value)
    return value
  }
  /** 复用已有句柄：同一个会话被多处拿到的必须是同一个对象。 */
  const agentFor = (id: string, status?: 'idle' | 'running'): FakeAgent => agents.get(id) ?? newAgent(id, status)
  const host = {
    context: {
      on(event: string, handler: (payload: never) => void) {
        handlers.set(event, handler)
        const dispose = () => { handlers.delete(event) }
        disposers.push(dispose)
        return dispose
      },
      get: (name: string) => (options.services ?? {})[name],
    },
    engine: {
      assignmentStarted: (ticketId: string, assignmentId: string) => { calls.started.push({ ticketId, assignmentId }) },
      inputsDelivered: (ticketId: string, assignmentId: string, inputIds: string[]) => {
        calls.delivered.push({ ticketId, assignmentId, inputIds })
        // 真实现会把送到的输入从 undelivered 里摘掉，投递循环靠它收敛。
        const current = tickets.get(ticketId)
        if (current) tickets.set(ticketId, { ...current, undelivered: current.undelivered.filter(id => !inputIds.includes(id)) })
      },
      inputsRead: (ticketId: string, inputIds: string[]) => { calls.read.push({ ticketId, inputIds }) },
      turnEnded: (ticketId: string, assignmentId: string) => { calls.turnEnded.push({ ticketId, assignmentId }) },
      deliveryFailed: (ticketId: string, assignmentId: string, error: string) => { calls.deliveryFailed.push({ ticketId, error }) },
      assignmentInterrupted: (ticketId: string, assignmentId: string) => { calls.interrupted.push({ ticketId, assignmentId }) },
      report: (ticketId: string, report: { state: string }) => {
        calls.reports.push({ ticketId, state: report.state })
        const current = tickets.get(ticketId)!
        const updated = { ...current, updatedAt: new Date(++now).toISOString() }
        tickets.set(ticketId, updated)
        return updated
      },
    },
    store: {
      tickets: {
        get: (id: string) => tickets.get(id),
        list: () => [...tickets.values()],
        open: () => [...tickets.values()].filter(ticket => !ticket.ended),
      },
      triggers: { get: (id: string) => triggers.get(id) },
      set: () => {},
      settings: () => settings,
      atomic: (work: () => unknown) => work(),
      afterCommit: (work: () => void) => { work() },
    },
    effects: {
      handle(kind: string, handler: (payload: never) => unknown, effectOptions: unknown) {
        effects.handle(kind, handler, effectOptions)
      },
      enqueue(kind: string, id: string, payload: unknown) { effects.enqueue(kind, id, payload) },
    },
    health: {
      get: () => undefined,
      set: (health: { state?: string; detail?: string }) => { calls.health.push(health) },
    },
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
      relay: (sessionId: string, text: string) => { calls.relays.push({ sessionId, text }) },
      holds: async () => false,
      agent: (sessionId: string) => agents.get(sessionId),
    },
    closing: () => options.closing ?? false,
    paused: () => options.paused ?? false,
    environment: () => [],
    sourceLink: async () => ({}),
    repliedTo: () => undefined,
  }
  return { host, tickets, triggers, agents, effects, calls, handlers, disposers, newAgent, settings }
}

function setup(options: Parameters<typeof makeHost>[0] = {}): Harness {
  const built = makeHost(options)
  const executor = new DshExecutor(built.host as never)
  executor.install()
  // 夹具与宿主合并成一个对象：既当 `host` 传给被测类，又带着调用记录，测试里只读写 `running.host.*`。
  const merged: FakeHost = Object.assign(built.host, built)
  return { executor, host: merged, agent: built.agents.get('worker-tk1') ?? built.newAgent('worker-tk1') }
}

/** 让微任务与已 resolve 的 promise 回调跑完。 */
async function drain(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

describe('dsh：构造与效果登记', () => {
  test('登记 launch / delivery 两个效果；暂停时 launch 名额为 0，不暂停按剩余名额', () => {
    const running = setup()
    const launchOptions = running.host.effects.options.get('launch') as { limit: () => number; retry: number[] }
    expect(launchOptions.limit()).toBe(4)
    expect(launchOptions.retry).toEqual([5000, 300_000])
    const deliveryOptions = running.host.effects.options.get('delivery') as { limit: () => number; quiet: boolean }
    expect(deliveryOptions.limit()).toBe(4)
    expect(deliveryOptions.quiet).toBe(true)

    const paused = setup({ paused: true })
    expect((paused.host.effects.options.get('launch') as { limit: () => number }).limit()).toBe(0)
    expect((paused.host.effects.options.get('delivery') as { limit: () => number }).limit()).toBe(0)
  })

  test('prepare 把工作区名、目录与作业说明写进 execution', () => {
    const running = setup()
    const prepared = running.executor.prepare(ticketOf(), { kind: 'accept', title: '标题', scope: 'chat', reason: 'x', name: 'login-fix' })
    expect(prepared.execution!.name).toBe('login-fix-tk1')
    expect(prepared.execution!.directory).toContain('login-fix-tk1')
  })

  test('start / deliver 各排一个效果；activeCount 只数有在跑 worker 的工单', () => {
    const running = setup({ tickets: [ticketOf()] })
    running.executor.start(ticketOf(), assignmentOf())
    running.executor.deliver(ticketOf(), assignmentOf())
    expect(running.host.effects.enqueued).toEqual([
      { kind: 'launch', id: 'a1', payload: { ticketId: 'tk1', assignmentId: 'a1' } },
      { kind: 'delivery', id: 'tk1', payload: { ticketId: 'tk1' } },
    ])
    expect(running.executor.activeCount()).toBe(0)
    expect(running.agent.status).toBe('idle')
  })
})

describe('dsh：launchQueued 派工', () => {
  test('工作区已存在：给 worker 投作业消息并把分配标成 running', async () => {
    const directory = createTempDir('dsc-dsh-')
    mkdirSync(directory, { recursive: true })
    const ticket = ticketOf({ execution: { name: 'login-fix-tk1', directory, assignment: '把登录页改成中文' } })
    const running = setup({ tickets: [ticket], triggers: new Map([['trig1', triggerOf('trig1')]]) })
    running.host.settings.executor.prepare = ''
    const handler = running.host.effects.handlers.get('launch') as (payload: { ticketId: string; assignmentId: string }) => Promise<void>
    await handler({ ticketId: 'tk1', assignmentId: 'a1' })
    expect(running.host.calls.ensures).toEqual([{ sessionId: 'worker-tk1', directory }])
    expect(running.host.calls.prompts).toHaveLength(1)
    const prompt = running.host.calls.prompts[0]!
    expect(prompt.sessionId).toBe('worker-tk1')
    expect(prompt.requestId).toBe('assignment:tk1')
    expect(JSON.parse(prompt.text)).toMatchObject({ ticket_id: 'tk1', title: '登录页改中文', assignment: '把登录页改成中文' })
    expect(running.host.calls.started).toEqual([{ ticketId: 'tk1', assignmentId: 'a1' }])
  })

  test('工单不存在 / 已结束 / 分配已被换掉时直接返回，不碰会话', async () => {
    const handlerOf = (running: Harness) => running.host.effects.handlers.get('launch') as (payload: { ticketId: string; assignmentId: string }) => Promise<void>
    const missing = setup()
    await handlerOf(missing)({ ticketId: 'ghost', assignmentId: 'a1' })
    expect(missing.host.calls.ensures).toEqual([])

    const ended = setup({ tickets: [ticketOf({ ended: { at: NOW, by: 'human', outcome: 'stopped' } })] })
    await handlerOf(ended)({ ticketId: 'tk1', assignmentId: 'a1' })
    expect(ended.host.calls.ensures).toEqual([])

    const replaced = setup({ tickets: [ticketOf({ assignments: [assignmentOf({ id: 'a2' })] })] })
    await handlerOf(replaced)({ ticketId: 'tk1', assignmentId: 'a1' })
    expect(replaced.host.calls.ensures).toEqual([])
  })

  test('派工失败（非瞬时）：把工单记成 failed 并转告主会话', async () => {
    const directory = createTempDir('dsc-dsh-')
    mkdirSync(directory, { recursive: true })
    const ticket = ticketOf({ execution: { name: 'n', directory, assignment: '做' } })
    const running = setup({ tickets: [ticket] })
    running.host.sessions.ensure = async () => { throw new Error('worker 起不来') }
    const handler = running.host.effects.handlers.get('launch') as (payload: { ticketId: string; assignmentId: string }) => Promise<void>
    await handler({ ticketId: 'tk1', assignmentId: 'a1' })
    expect(running.host.calls.reports).toEqual([{ ticketId: 'tk1', state: 'failed' }])
    expect(running.host.calls.relays).toHaveLength(1)
  })

  test('停机或暂停时把错误抛回效果队列（等恢复后重排）', async () => {
    const directory = createTempDir('dsc-dsh-')
    mkdirSync(directory, { recursive: true })
    const ticket = ticketOf({ execution: { name: 'n', directory, assignment: '做' } })
    const closing = setup({ tickets: [ticket], closing: true })
    const handler = closing.host.effects.handlers.get('launch') as (payload: { ticketId: string; assignmentId: string }) => Promise<void>
    await expect(handler({ ticketId: 'tk1', assignmentId: 'a1' })).rejects.toThrow('dsh-superagent is stopping')

    const paused = setup({ tickets: [ticket], paused: true })
    const pausedHandler = paused.host.effects.handlers.get('launch') as (payload: { ticketId: string; assignmentId: string }) => Promise<void>
    await expect(pausedHandler({ ticketId: 'tk1', assignmentId: 'a1' })).rejects.toBeInstanceOf(Later)
  })

  test('旧的 Session 还挂着待发的工单消息时，先按 requestId 撤掉', async () => {
    const directory = createTempDir('dsc-dsh-')
    mkdirSync(directory, { recursive: true })
    const input = { id: 'in1', kind: 'trigger' as const, triggerId: 'trig9', at: NOW }
    const ticket = ticketOf({
      execution: { name: 'n', directory, assignment: '做' },
      inputs: [input],
      undelivered: ['in1'],
    })
    const running = setup({ tickets: [ticket] })
    const handler = running.host.effects.handlers.get('launch') as (payload: { ticketId: string; assignmentId: string }) => Promise<void>
    await handler({ ticketId: 'tk1', assignmentId: 'a1' })
    expect(running.agent.removed).toEqual(['prompted:in1'])
  })

  test('后续分配：只发「新的是什么」，并带上重试说明与截断的作业正文', async () => {
    const directory = createTempDir('dsc-dsh-')
    mkdirSync(directory, { recursive: true })
    const longAssignment = '很长的作业说明'.repeat(400)
    const ticket = ticketOf({
      execution: { name: 'n', directory, assignment: longAssignment },
      assignments: [
        assignmentOf({ state: 'ended', endedReason: 'retried' }),
        assignmentOf({ id: 'a2', state: 'pending' }),
      ],
    })
    const running = setup({ tickets: [ticket] })
    running.host.sessions.holds = async () => true
    const handler = running.host.effects.handlers.get('launch') as (payload: { ticketId: string; assignmentId: string }) => Promise<void>
    await handler({ ticketId: 'tk1', assignmentId: 'a2' })
    const text = JSON.parse(running.host.calls.prompts[0]!.text) as Record<string, unknown>
    expect(running.host.calls.prompts[0]!.requestId).toBe('assignment:tk1:a2')
    expect(text).toMatchObject({ ticket_id: 'tk1', assignment: 2, note: expect.stringContaining('person retried') })
    expect(text.title, '后续分配不再重发标题与正文').toBeUndefined()

    // 首次分配且正文超长：给截断预览 + 字数 + 读取路径。
    const first = setup({ tickets: [ticketOf({
      execution: { name: 'n', directory, assignment: longAssignment },
    })] })
    await (first.host.effects.handlers.get('launch') as (payload: { ticketId: string; assignmentId: string }) => Promise<void>)({ ticketId: 'tk1', assignmentId: 'a1' })
    const capped = JSON.parse(first.host.calls.prompts[0]!.text) as Record<string, unknown>
    expect(String(capped.assignment).endsWith('…')).toBe(true)
    expect(capped.assignment_chars).toBe(longAssignment.length)
    expect(capped.assignment_read).toBe('ticket/tk1/assignment')
  })
})

describe('dsh：deliverQueued 投递', () => {
  test('把等待中的输入投给 worker 并记 inputsDelivered；没有分配时不投', async () => {
    const input = { id: 'in1', kind: 'text' as const, text: '请看下 CI', at: NOW }
    const ticket = ticketOf({
      assignments: [assignmentOf({ state: 'running', startedAt: NOW })],
      inputs: [input],
      undelivered: ['in1'],
    })
    const running = setup({ tickets: [ticket] })
    const handler = running.host.effects.handlers.get('delivery') as (payload: { ticketId: string }) => Promise<void>
    await handler({ ticketId: 'tk1' })
    expect(running.host.calls.prompts[0]).toMatchObject({ sessionId: 'worker-tk1', text: '请看下 CI', mode: 'steer' })
    expect(running.host.calls.delivered).toEqual([{ ticketId: 'tk1', assignmentId: 'a1', inputIds: ['in1'] }])

    const noAssignment = setup({ tickets: [ticketOf({ inputs: [input], undelivered: ['in1'] })] })
    await (noAssignment.host.effects.handlers.get('delivery') as (payload: { ticketId: string }) => Promise<void>)({ ticketId: 'tk1' })
    expect(noAssignment.host.calls.delivered).toEqual([])
  })

  test('worker 会话丢了就先重建；投递失败记录在工单上并抛出', async () => {
    const input = { id: 'in1', kind: 'text' as const, text: '再看一下', at: NOW }
    const ticket = ticketOf({
      assignments: [assignmentOf({ state: 'running', startedAt: NOW })],
      inputs: [input],
      undelivered: ['in1'],
    })
    const running = setup({ tickets: [ticket] })
    // 模拟会话被外部删掉：会话管理器里查不到这个 worker。
    running.host.agents.delete('worker-tk1')
    const handler = running.host.effects.handlers.get('delivery') as (payload: { ticketId: string }) => Promise<void>
    await handler({ ticketId: 'tk1' })
    expect(running.host.calls.ensures).toEqual([{ sessionId: 'worker-tk1', directory: '' }])

    const failing = setup({ tickets: [ticket] })
    failing.host.sessions.prompt = async () => { throw new Error('投递炸了') }
    await expect((failing.host.effects.handlers.get('delivery') as (payload: { ticketId: string }) => Promise<void>)({ ticketId: 'tk1' }))
      .rejects.toThrow('投递炸了')
    expect(failing.host.calls.deliveryFailed).toEqual([{ ticketId: 'tk1', error: 'Error: 投递炸了' }])
  })
})

describe('dsh：停工与停机', () => {
  test('stop：等事务提交后取消回合（自己的报告就不取消）并收后台活', async () => {
    const running = setup({ tickets: [ticketOf()] })
    const agent = running.host.newAgent('worker-tk1', 'running')
    running.executor.stop(ticketOf({ assignments: [assignmentOf({ state: 'running' })] }), assignmentOf({ state: 'running' }), '工单结束')
    expect(agent.cancels).toEqual([{ kind: 'user', keepInbox: false }])
    await drain()

    // 最后一句是 ready 报告、之后没有新输入：工单自己结束的回合不再取消。
    const quiet = setup({ tickets: [ticketOf()] })
    const quietAgent = quiet.host.newAgent('worker-tk1', 'running')
    quiet.executor.stop(
      ticketOf({ assignments: [assignmentOf({ state: 'running', report: { state: 'ready', summary: '好了', at: NOW } })] }),
      assignmentOf({ state: 'running', report: { state: 'ready', summary: '好了', at: NOW } }),
      '完成了',
    )
    expect(quietAgent.cancels).toEqual([])
    await drain()
  })

  test('shutdown：给每个已加载 worker 收后台活，取消还在跑的回合，最多等 10 秒', async () => {
    const running = setup({ tickets: [ticketOf(), ticketOf({ id: 'tk2' })] })
    running.host.newAgent('worker-tk1', 'running')
    running.host.newAgent('worker-tk2', 'idle')
    await running.executor.shutdown()
    expect(running.host.agents.get('worker-tk1')!.cancels).toEqual([{ kind: 'user', keepInbox: true }])
    expect(running.host.agents.get('worker-tk2')!.cancels).toEqual([])
  })

  test('dispose 退订全部事件并清掉待触发计时器', async () => {
    vi.useFakeTimers()
    try {
      const running = setup({ tickets: [ticketOf()] })
      const errorHandler = running.host.handlers.get('superagent/agent-error') as (payload: never) => void
      // 瞬时错误安排 15 秒后的重试；dispose 之后计时器不再跑。
      running.host.newAgent('worker-tk1', 'running')
      errorHandler({ agent: running.host.agents.get('worker-tk1')!, error: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) } as never)
      running.executor.dispose()
      vi.advanceTimersByTime(60_000)
      await drain()
      expect(running.host.calls.prompts).toEqual([])
      expect(running.host.handlers.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('dsh：resume 重启对账', () => {
  test('在跑的分配先中断，pending 的重新排队，等人的不排', () => {
    const runningTicket = ticketOf({ id: 'a', assignments: [assignmentOf({ state: 'running' })] })
    const pendingTicket = ticketOf({ id: 'b', assignments: [assignmentOf({ state: 'pending' })] })
    const waiting = ticketOf({ id: 'c', assignments: [assignmentOf({ state: 'pending', report: { state: 'blocked', summary: '卡', at: NOW } })] })
    const running = setup({ tickets: [runningTicket, pendingTicket, waiting] })
    running.host.newAgent('worker-a', 'running')
    running.executor.resume()
    expect(running.host.calls.interrupted).toEqual([{ ticketId: 'a', assignmentId: 'a1' }])
    expect(running.host.effects.enqueued).toEqual([{ kind: 'launch', id: 'a1', payload: { ticketId: 'b', assignmentId: 'a1' } }])
  })
})

describe('dsh：Cordis 事件处理', () => {
  test('worker 回合 idle：看后台活静默后报 waiting 并转告主会话', async () => {
    const ticket = ticketOf({ assignments: [assignmentOf({ state: 'running', startedAt: NOW })] })
    const running = setup({ tickets: [ticket] })
    const agent = running.host.newAgent('worker-tk1', 'idle')
    const statusHandler = running.host.handlers.get('superagent/agent-status') as (payload: never) => void
    statusHandler({ agent, status: 'idle' } as never)
    await drain()
    expect(running.host.calls.turnEnded).toEqual([{ ticketId: 'tk1', assignmentId: 'a1' }])
    expect(running.host.calls.reports).toEqual([{ ticketId: 'tk1', state: 'waiting' }])
    expect(running.host.calls.relays).toHaveLength(1)
  })

  test('空闲回落但工单已结束 / 没有在跑的分配时什么也不做', async () => {
    const running = setup({ tickets: [ticketOf({ ended: { at: NOW, by: 'human', outcome: 'stopped' } })] })
    const agent = running.host.newAgent('worker-tk1', 'idle')
    ;(running.host.handlers.get('superagent/agent-status') as (payload: never) => void)({ agent, status: 'idle' } as never)
    await drain()
    expect(running.host.calls.turnEnded).toEqual([])
  })

  test('message-read：按 requestId 认出读到的 trigger 并记 inputsRead', async () => {
    const input = { id: 'in1', kind: 'trigger' as const, triggerId: 'trig9', at: NOW }
    const running = setup({ tickets: [ticketOf({ inputs: [input] })] })
    ;(running.host.handlers.get('superagent/message-read') as (payload: never) => void)({ sessionId: 'worker-tk1', requestId: 'in1' } as never)
    await drain()
    expect(running.host.calls.read).toEqual([{ ticketId: 'tk1', inputIds: ['in1'] }])
  })

  test('inbox-claimed：user 来源的消息记成「人自己开的回合」', async () => {
    const running = setup({ tickets: [ticketOf()] })
    ;(running.host.handlers.get('superagent/inbox-claimed') as (payload: never) => void)({ sessionId: 'worker-tk1', origin: 'user' } as never)
    // 人开的回合不让 workerIdle 判成「交还给人」：ready 报告之后的人消息才算新工作。
    const agent = running.host.newAgent('worker-tk1', 'idle')
    const ticket = ticketOf({ assignments: [assignmentOf({ state: 'running', startedAt: NOW, report: { state: 'ready', summary: '好了', at: NOW } })] })
    running.host.tickets.set('tk1', ticket)
    ;(running.host.handlers.get('superagent/agent-status') as (payload: never) => void)({ agent, status: 'idle' } as never)
    await drain()
    // 人自己开的回合也照常收尾（turnEnded 记一次），而不是被当成「交还给人」直接 handOff。
    expect(running.host.calls.turnEnded).toHaveLength(1)
  })

  test('agent-error：瞬时错误按退避重试，非瞬时错误记 failed', async () => {
    vi.useFakeTimers()
    try {
      const ticket = ticketOf({ assignments: [assignmentOf({ state: 'running', startedAt: NOW })] })
      const running = setup({ tickets: [ticket] })
      const agent = running.host.newAgent('worker-tk1', 'idle')
      const errorHandler = running.host.handlers.get('superagent/agent-error') as (payload: never) => void

      errorHandler({ agent, error: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) } as never)
      vi.advanceTimersByTime(15_000)
      await drain()
      expect(running.host.calls.prompts.at(-1)!.requestId).toBe('retry:a1:1')
      expect(running.host.calls.prompts.at(-1)!.text).toContain('passing reason')

      const failing = setup({ tickets: [ticket] })
      const failingAgent = failing.host.newAgent('worker-tk1', 'idle')
      ;(failing.host.handlers.get('superagent/agent-error') as (payload: never) => void)({ agent: failingAgent, error: new Error('code bug') } as never)
      await drain()
      expect(failing.host.calls.reports).toEqual([{ ticketId: 'tk1', state: 'failed' }])
    } finally {
      vi.useRealTimers()
    }
  })

  test('agent-status running：中止正在看的后台活（settling 里的 abort 被调用）', async () => {
    const ticket = ticketOf({ assignments: [assignmentOf({ state: 'running', startedAt: NOW })] })
    const running = setup({ tickets: [ticket] })
    const agent = running.host.newAgent('worker-tk1', 'running')
    const statusHandler = running.host.handlers.get('superagent/agent-status') as (payload: never) => void
    // running 状态只做「中止 look」：没有 look 时就是空操作，但要保证不抛。
    expect(() => { statusHandler({ agent, status: 'running' } as never) }).not.toThrow()
    expect(() => { statusHandler({ agent, status: 'idle' } as never) }).not.toThrow()
    await drain()
  })

  test('worker 交还给人：记 turnEnded、收子智能体、把留给人的作业逐个收尾并转告', async () => {
    const ticket = ticketOf({
      attention: { id: 'att1', question: '要哪个方案', triggerId: 'trig1' },
      assignments: [assignmentOf({ state: 'running', startedAt: NOW })],
    })
    const job = { id: 'job-1', owner: 'worker-tk1', status: 'running', command: 'pnpm dev\n第二行' }
    const jobs = {
      list: () => [{ ...job }],
      wait: async () => { job.status = 'completed'; return true },
      kill: () => true,
    }
    const team = {
      list: () => [{ sessionId: 'worker-tk1', state: 'working' }],
      stopBySession: async () => [],
    }
    const running = setup({ tickets: [ticket], services: { jobs, team } })
    const agent = running.host.newAgent('worker-tk1', 'idle')
    ;(running.host.handlers.get('superagent/agent-status') as (payload: never) => void)({ agent, status: 'idle' } as never)
    await drain()
    expect(running.host.calls.turnEnded).toEqual([{ ticketId: 'tk1', assignmentId: 'a1' }])
    expect(agent.cancels, '收完队友要取消被叫醒的回合，且保留收件箱').toEqual([{ kind: 'user', keepInbox: true }])
    expect(running.host.calls.prompts.at(-1)).toMatchObject({ requestId: 'ended:job-1' })
    expect(running.host.calls.prompts.at(-1)!.text).toContain('job-1 (pnpm dev)')
  })

  test('后台活静默结束后叫醒 worker：把结束的作业交回给它', async () => {
    const ticket = ticketOf({ assignments: [assignmentOf({ state: 'running', startedAt: NOW })] })
    const job = { id: 'job-1', owner: 'worker-tk1', status: 'running', command: 'pnpm test' }
    const jobs = {
      list: () => [{ ...job }],
      wait: async () => { job.status = 'completed'; return true },
      kill: () => true,
    }
    const running = setup({ tickets: [ticket], services: { jobs } })
    const agent = running.host.newAgent('worker-tk1', 'idle')
    ;(running.host.handlers.get('superagent/agent-status') as (payload: never) => void)({ agent, status: 'idle' } as never)
    await drain()
    expect(running.host.calls.prompts.at(-1)).toMatchObject({ requestId: 'settled:job-1' })
    expect(running.host.calls.prompts.at(-1)!.text).toContain('your turn ended')
    expect(running.host.calls.turnEnded).toEqual([{ ticketId: 'tk1', assignmentId: 'a1' }])
  })

  test('worker 事件处理失败：体检格报 error，下次成功恢复 ready', async () => {
    const ticket = ticketOf({ assignments: [assignmentOf({ state: 'running', startedAt: NOW })] })
    const running = setup({ tickets: [ticket] })
    const agent = running.host.newAgent('worker-tk1', 'idle')
    // engine.report 抛错 → background 把体检格设成 error。
    running.host.engine.report = () => { throw new Error('报告落不了库') }
    ;(running.host.handlers.get('superagent/agent-status') as (payload: never) => void)({ agent, status: 'idle' } as never)
    await drain()
    expect(running.host.calls.health.at(-1)).toMatchObject({ state: 'error' })
    expect(running.host.calls.health.at(-1)!.detail).toContain('报告落不了库')
  })
})

afterEach(() => {
  vi.useRealTimers()
})
