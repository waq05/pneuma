/**
 * superagent 领域核心的补盲：`core/tickets.ts`、`core/evals.ts`、`core/model.ts`。
 *
 * 这一份专挑现有用例没走到的**分支**：坏输入、缺省值、降级与「什么也不做」的守卫。
 * 全部用 `MemoryRepositories` + 假执行器 / 假出站队列，不碰磁盘、不碰模型。
 *
 * 断言的是模块真实行为：工单集合怎么变、disposition 怎么落、引擎回调被叫了几次，
 * 而不是另造一份判据。
 *
 * @module dsc/packages/superagent/tests/tickets-extra
 */
import { describe, expect, test } from 'vitest'
import { Evals } from '../core/evals.js'
import { UserError } from '../core/errors.js'
import { key } from '../core/ids.js'
import { MemoryRepositories } from '../core/memory.js'
import {
  followupOwners,
  isoTime,
  latestAssignment,
  latestReport,
  liveTicket,
  reached,
  readUntil,
  settled,
  ticketOutcome,
  waitsForPerson,
  type Assignment,
  type ChannelRef,
  type Decision,
  type Evaluation,
  type Mandate,
  type PolicyEffect,
  type Thread,
  type ThreadRef,
  type Ticket,
  type TicketInput,
  type Trigger,
} from '../core/model.js'
import type { EngineOptions } from '../core/part.js'
import type { Candidate, DomainEvent, GateResult, OutboundMessage, Outbox, Policy, ReplyStatus } from '../core/ports.js'
import { Replies } from '../core/replies.js'
import { Tickets } from '../core/tickets.js'

const NOW = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-01T00:01:00.000Z'
const EARLIER = '2025-12-31T23:59:00.000Z'
const CHANNEL: ChannelRef = { source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1' } }

function mandateOf(overrides: Partial<Mandate> = {}): Mandate {
  return {
    strength: 'explicit',
    policyVersion: 'v1',
    basis: { via: 'addressed', addressed: 'mention' },
    actor: { source: 'feishu', id: 'ou_1' },
    scope: 'chat',
    ...overrides,
  }
}

function threadRef(id = 'x'): ThreadRef {
  return { source: 'feishu', id }
}

const threadKeyOf = (ref: ThreadRef): string => `${ref.source}:${ref.id}`

function threadOf(ref: ThreadRef, overrides: Partial<Thread> = {}): Thread {
  return {
    key: threadKeyOf(ref),
    ref,
    createdAt: NOW,
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: {},
    ...overrides,
  }
}

function triggerOf(id: string, overrides: Partial<Trigger> = {}): Trigger {
  const thread = overrides.threads?.[0] ?? threadRef()
  return {
    id,
    source: 'feishu',
    threads: [thread],
    actor: { source: 'feishu', id: 'ou_1' },
    human: true,
    at: NOW,
    text: '改一下登录页',
    channel: CHANNEL,
    meta: {},
    ...overrides,
  }
}

function ticketOf(overrides: Partial<Ticket> = {}): Ticket {
  const assignment: Assignment = { id: 'a0', state: 'pending', createdAt: NOW }
  return {
    id: 'tk1',
    title: '改登录页',
    decisionId: 'dec1',
    mandate: mandateOf(),
    channels: [],
    assignments: [assignment],
    inputs: [],
    undelivered: [],
    createdAt: NOW,
    updatedAt: NOW,
    origin: { triggerId: 'trig1', triggerIds: ['trig1'] },
    ...overrides,
  }
}

type TriggerInput = Extract<TicketInput, { kind: 'trigger' }>

function inputOf(ticketId: string, triggerId: string, overrides: Partial<TriggerInput> = {}): TriggerInput {
  return {
    id: key('input', ticketId, 'trigger', triggerId),
    kind: 'trigger',
    triggerId,
    at: NOW,
    ...overrides,
  }
}

function evaluatingOf(overrides: Partial<Evaluation> = {}): Evaluation {
  return {
    id: 'eval-1',
    threadKey: 'feishu:x',
    triggerIds: ['trig1'],
    primary: 'trig1',
    strength: 'explicit',
    actor: { source: 'feishu', id: 'ou_1' },
    basis: { via: 'followup' },
    policyVersion: 'v1',
    startedAt: NOW,
    deadline: NOW,
    ...overrides,
  }
}

/** 假出站队列：与真实实现一样按 id 幂等。 */
function fakeOutbox(): { outbox: Outbox; sent: OutboundMessage[]; statuses: Map<string, ReplyStatus>; withdrawn: string[] } {
  const sent: OutboundMessage[] = []
  const statuses = new Map<string, ReplyStatus>()
  const withdrawn: string[] = []
  const outbox: Outbox = {
    send(message) {
      if (statuses.has(message.id)) return
      sent.push(message)
      statuses.set(message.id, 'pending')
    },
    status(id) {
      return statuses.get(id)
    },
    withdraw(id) {
      withdrawn.push(id)
      if (statuses.get(id) === 'pending') statuses.set(id, 'dropped')
    },
  }
  return { outbox, sent, statuses, withdrawn }
}

interface ExecutorCalls {
  start: Array<{ ticketId: string; assignmentId: string }>
  deliver: Array<{ ticketId: string; assignmentId: string }>
  stop: Array<{ ticketId: string; assignmentId: string; reason: string }>
}

interface Harness {
  repo: MemoryRepositories
  box: ReturnType<typeof fakeOutbox>
  calls: ExecutorCalls
  events: DomainEvent[]
  requests: Candidate[]
  tickets: Tickets
  evals: Evals
  policy: () => Policy
  state: {
    now: string
    paused: boolean
    revalidate: boolean
    version: string
    gateResult: GateResult
    gateFor?: (trigger: Trigger) => GateResult
    admits: boolean
    timeoutMs: number
  }
}

/**
 * 一套夹具：真仓库 + 真 Replies / Tickets / Evals，执行器、判定器与出站队列是假的。
 *
 * `state` 可改：时钟、暂停、revalidate、policy 版本、gate 结论都靠它切分支。
 */
function harness(options: {
  prepareTicket?: (ticket: Ticket) => Ticket
} = {}): Harness {
  const repo = new MemoryRepositories()
  const box = fakeOutbox()
  const calls: ExecutorCalls = { start: [], deliver: [], stop: [] }
  const events: DomainEvent[] = []
  const requests: Candidate[] = []
  const state: Harness['state'] = {
    now: NOW,
    paused: false,
    revalidate: true,
    version: 'v1',
    gateResult: { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } },
    admits: true,
    timeoutMs: 1_000,
  }
  const policy = (): Policy => ({
    version: state.version,
    paused: state.paused,
    gate: (trigger) => state.gateFor?.(trigger) ?? state.gateResult,
    revalidate: () => state.revalidate,
    admitsInferred: () => state.admits,
    evalTimeoutMs: state.timeoutMs,
  })
  const engineOptions: EngineOptions = {
    repo,
    policy,
    scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: {
      request(candidate) {
        requests.push(candidate)
      },
      release() {},
    },
    executor: {
      start(ticket, assignment) {
        calls.start.push({ ticketId: ticket.id, assignmentId: assignment.id })
      },
      deliver(ticket, assignment) {
        calls.deliver.push({ ticketId: ticket.id, assignmentId: assignment.id })
      },
      stop(ticket, assignment, reason) {
        calls.stop.push({ ticketId: ticket.id, assignmentId: assignment.id, reason })
      },
    },
    outbox: box.outbox,
    now: () => state.now,
    emit(event) {
      events.push(event)
    },
    ...(options.prepareTicket === undefined ? {} : { prepareTicket: options.prepareTicket }),
  }
  const replies = new Replies(engineOptions)
  const tickets = new Tickets(engineOptions, replies)
  const evals = new Evals(engineOptions, tickets)
  return { repo, box, calls, events, requests, tickets, evals, policy, state }
}

/** 断言抛出的是指定 code 的 UserError；不是就原样抛出来，别把失败吞成「没抛」。 */
function codeOf(work: () => unknown): string {
  try {
    work()
  } catch (error) {
    if (error instanceof UserError) return error.code
    throw error
  }
  throw new Error('期望抛出 UserError，实际没有抛')
}

// ── Tickets.create ──────────────────────────────────────────────────────────

describe('Tickets.create：origin、通道去重与首批订阅', () => {
  test('primary 缺失时用最后一个 trigger；重复通道只留一个；prepareTicket 能改写标题', () => {
    const h = harness({ prepareTicket: (ticket) => ({ ...ticket, title: '被预处理过的标题' }) })
    h.repo.triggers.save(triggerOf('trig1', { channel: CHANNEL, threads: [threadRef('x'), threadRef('y')] }))
    h.repo.triggers.save(triggerOf('trig2', { channel: CHANNEL, threads: [threadRef('x'), threadRef('z')] }))
    h.repo.threads.save(threadOf(threadRef('x')))
    h.repo.threads.save(threadOf(threadRef('y')))
    h.repo.threads.save(threadOf(threadRef('z')))

    h.tickets.create('tk1', 'dec1', mandateOf(), { triggerIds: ['trig1', 'trig2'] }, {
      kind: 'accept', title: '原标题', scope: 'chat', reason: 'ok', acknowledgement: '收到',
    }, NOW)

    const ticket = h.repo.tickets.get('tk1')!
    expect(ticket.origin, '没有 primary 时回落到最后一个 trigger').toEqual({ triggerId: 'trig2', triggerIds: ['trig1', 'trig2'] })
    expect(ticket.channels, '两个 trigger 的同一个通道只留一个').toEqual([CHANNEL])
    expect(ticket.title, 'prepareTicket 的结果要落库').toBe('被预处理过的标题')
    expect(ticket.assignments).toHaveLength(1)
    expect(ticket.assignments[0]!.state).toBe('pending')
    expect(h.calls.start, '建单后立刻排队派工').toEqual([{ ticketId: 'tk1', assignmentId: ticket.assignments[0]!.id }])
    expect(h.repo.threads.get('feishu:x')!.subscriptions).toEqual(['tk1'])
    expect(h.repo.threads.get('feishu:y')!.subscriptions).toEqual(['tk1'])
    expect(h.repo.threads.get('feishu:z')!.subscriptions).toEqual(['tk1'])
    expect(h.box.sent, '有通道的人消息才带确认').toEqual([
      { id: key('ack', 'trig2'), channel: CHANNEL, text: '收到', kind: 'acknowledgement', ticketId: 'tk1' },
    ])
    expect(h.events.at(-1)).toMatchObject({ type: 'ticket.created' })
    expect(h.events.filter((event) => event.type === 'thread.subscribed')).toHaveLength(3)
  })

  test('primary 指向不存在的 trigger 时 origin 用第一个；缺 trigger 的 thread 不订阅、不确认', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig2', { channel: undefined, threads: [threadRef('x')] }))
    h.repo.threads.save(threadOf(threadRef('x')))

    h.tickets.create('tk2', 'dec2', mandateOf(), { triggerIds: ['ghost', 'trig2'], primary: 'ghost' }, {
      kind: 'accept', title: '标题', scope: 'chat', reason: 'ok', acknowledgement: '收到',
    }, NOW)

    const ticket = h.repo.tickets.get('tk2')!
    expect(ticket.origin.triggerId).toBe('ghost')
    expect(ticket.channels, '没有通道的 trigger 不贡献通道').toEqual([])
    expect(h.box.sent, '没有 primary trigger 就没有确认').toEqual([])
    expect(h.repo.threads.get('feishu:x')!.subscriptions).toEqual(['tk2'])
  })
})

// ── Tickets.bind / threadClosed / followsDone ───────────────────────────────

describe('Tickets.bind：重绑会重开、own 一旦为真不再变回', () => {
  test('未知 / 已结束的工单都拒绝', () => {
    const h = harness()
    expect(codeOf(() => h.tickets.bind('ghost', threadRef(), true))).toBe('unknownTicket')
    h.repo.tickets.save(ticketOf({ ended: { at: NOW, by: 'human', outcome: 'stopped' } }))
    expect(codeOf(() => h.tickets.bind('tk1', threadRef(), true))).toBe('ticketEnded')
  })

  test('已有的 follow 重开并保留 own；新 follow 追加；updatedAt 前进', () => {
    const h = harness()
    const first = threadRef('a')
    h.repo.tickets.save(ticketOf({ follows: [{ thread: threadKeyOf(first), own: false, closed: { at: EARLIER, outcome: 'closed' } }] }))
    h.state.now = LATER

    const ticket = h.tickets.bind('tk1', first, true)
    expect(ticket.follows).toEqual([{ thread: threadKeyOf(first), own: true }])
    expect(ticket.updatedAt).toBe(LATER)
    expect(h.repo.threads.get(threadKeyOf(first))!.subscriptions).toEqual(['tk1'])

    const second = threadRef('b')
    const both = h.tickets.bind('tk1', second, false)
    expect(both.follows).toEqual([
      { thread: threadKeyOf(first), own: true },
      { thread: threadKeyOf(second), own: false },
    ])
    expect(h.tickets.bind('tk1', first, false).follows![0]!.own, 'own 不退回 false').toBe(true)
  })
})

describe('Tickets.threadClosed / followsDone', () => {
  test('没 follow 的话题直接跳过；自己的 PR 已关就结束，不看其它 follow', () => {
    const h = harness()
    const own = threadRef('pr')
    const other = threadRef('issue')
    h.repo.tickets.save(ticketOf({
      follows: [
        { thread: threadKeyOf(own), own: true },
        { thread: threadKeyOf(other), own: false },
      ],
    }))
    h.repo.tickets.save(ticketOf({ id: 'tk-other', follows: [{ thread: threadKeyOf(other), own: true }] }))

    h.tickets.threadClosed(threadRef('unfollowed'), 'merged', NOW)
    expect(h.repo.tickets.get('tk1')!.ended, '没人 follow 的话题不结束任何工单').toBeUndefined()

    h.tickets.threadClosed(own, 'merged', NOW)
    expect(h.repo.tickets.get('tk1')!.ended).toEqual({ at: NOW, by: 'executor', outcome: 'merged' })
    expect(h.repo.tickets.get('tk-other')!.ended, '别的工单只 follow 它自己的').toBeUndefined()
  })

  test('没有 own 时要等所有 follow 都关；结束时间取最晚的那次关闭', () => {
    const h = harness()
    const a = threadRef('a')
    const b = threadRef('b')
    h.repo.tickets.save(ticketOf({
      follows: [{ thread: threadKeyOf(a), own: false }, { thread: threadKeyOf(b), own: false }],
    }))
    h.tickets.threadClosed(a, 'closed', EARLIER)
    expect(h.repo.tickets.get('tk1')!.ended).toBeUndefined()

    h.state.now = '2026-01-02T00:00:00.000Z'
    h.tickets.threadClosed(b, 'closed', LATER)
    expect(h.repo.tickets.get('tk1')!.ended).toEqual({ at: LATER, by: 'executor', outcome: 'closed' })
  })

  test('关闭后工作已恢复并 ready：结束时刻用 now，而不是 PR 的关闭时刻', () => {
    const h = harness()
    const pr = threadRef('pr')
    h.repo.tickets.save(ticketOf({
      follows: [{ thread: threadKeyOf(pr), own: true }],
      assignments: [{ id: 'a1', state: 'running', createdAt: LATER, report: { state: 'ready', summary: '做完了', at: LATER } }],
    }))
    h.state.now = '2026-01-02T00:00:00.000Z'
    h.tickets.threadClosed(pr, 'merged', EARLIER)
    expect(h.repo.tickets.get('tk1')!.ended!.at).toBe('2026-01-02T00:00:00.000Z')
  })

  test('关闭后工单还欠着人消息的工作时先不结束，等 ready 报告', () => {
    const h = harness()
    const pr = threadRef('pr')
    const input = inputOf('tk1', 'trig-human')
    h.repo.triggers.save(triggerOf('trig-human'))
    h.repo.triggers.saveDisposition('trig-human', { fanout: ['tk1'], acked: ['tk1'], at: NOW })
    h.repo.tickets.save(ticketOf({
      follows: [{ thread: threadKeyOf(pr), own: false }],
      inputs: [input],
      undelivered: [input.id],
      assignments: [{ id: 'a1', state: 'running', createdAt: NOW, report: { state: 'progress', summary: '在做', at: NOW } }],
    }))
    h.tickets.threadClosed(pr, 'closed', LATER)
    expect(h.repo.tickets.get('tk1')!.ended, '未完成的工作让工单继续').toBeUndefined()
  })
})

// ── Tickets.attachable / attach ─────────────────────────────────────────────

describe('Tickets.attachable：四种拒绝都带专用 code', () => {
  test('未知 trigger、worker 仍决定、被人停、授权失效', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf())
    expect(codeOf(() => h.tickets.attachable('tk1', 'ghost'))).toBe('unknownTrigger')

    h.repo.triggers.save(triggerOf('trig-human'))
    h.repo.triggers.saveDisposition('trig-human', { fanout: ['tk1'], at: NOW })
    expect(codeOf(() => h.tickets.attachable('tk1', 'trig-human'))).toBe('workerDecides')

    const stopped = ticketOf({ id: 'stopped', ended: { at: NOW, by: 'human', outcome: 'stopped' } })
    h.repo.tickets.save(stopped)
    h.repo.triggers.save(triggerOf('trig-bot', { human: false }))
    expect(codeOf(() => h.tickets.attachable('stopped', 'trig-bot'))).toBe('ticketStopped')

    const ended = ticketOf({ id: 'ended', ended: { at: NOW, by: 'executor', outcome: 'completed' } })
    h.repo.tickets.save(ended)
    h.state.revalidate = false
    expect(codeOf(() => h.tickets.attachable('ended', 'trig-bot'))).toBe('mandateRevoked')

    h.state.revalidate = true
    expect(h.tickets.attachable('ended', 'trig-bot').id).toBe('trig-bot')
  })
})

describe('Tickets.attach：同一条消息的四种落法', () => {
  test('worker 已有且仍未送达：只补 note；已送达则再发一条 note Input', () => {
    const h = harness()
    const trigger = triggerOf('trig1')
    h.repo.triggers.save(trigger)
    const input = inputOf('tk1', 'trig1')
    h.repo.tickets.save(ticketOf({ inputs: [input], undelivered: [input.id] }))

    h.tickets.attach('tk1', trigger, '这是一条备注')
    expect(h.repo.tickets.get('tk1')!.inputs.find((item) => item.id === input.id)).toMatchObject({ note: '这是一条备注' })

    h.repo.tickets.save(ticketOf({ id: 'tk2', inputs: [inputOf('tk2', 'trig1')] }))
    h.repo.triggers.saveDisposition('trig1', { fanout: ['tk1', 'tk2'], at: NOW })
    h.tickets.attach('tk2', trigger, '再来一条')
    const noteId = key('input', 'tk2', 'trigger', 'trig1', 'note', '再来一条')
    expect(h.repo.tickets.get('tk2')!.inputs.map((item) => item.id)).toContain(noteId)
  })

  test('requeued / 从 context 转来 / 工单已结束：都重新作为 attached Input 投递', () => {
    for (const variant of ['requeued', 'context', 'ended'] as const) {
      const h = harness()
      const trigger = triggerOf('trig1')
      h.repo.triggers.save(trigger)
      h.repo.triggers.saveDisposition('trig1', {
        fanout: ['tk1'],
        at: NOW,
        ...(variant === 'requeued' ? { requeued: true as const } : {}),
        ...(variant === 'context' ? { context: ['tk1'] } : {}),
      })
      h.repo.tickets.save(ticketOf({
        inputs: [inputOf('tk1', 'trig1')],
        ...(variant === 'ended' ? { ended: { at: NOW, by: 'executor' as const, outcome: 'completed' as const } } : {}),
      }))

      h.tickets.attach('tk1', trigger)
      const ids = h.repo.tickets.get('tk1')!.inputs.map((item) => item.id)
      const attached = key('input', 'tk1', 'trigger', 'trig1', 'attached', NOW)
      expect(ids, `${variant} 应当追加 attached Input`).toContain(attached)
      expect(h.repo.triggers.disposition('trig1')!.fanout).toEqual(['tk1'])
      if (variant === 'context') expect(h.repo.triggers.disposition('trig1')!.context).toBeUndefined()
    }
  })

  test('已在 worker 手里且不需要重发：attach 不新增 Input', () => {
    const h = harness()
    const trigger = triggerOf('trig1')
    h.repo.triggers.save(trigger)
    h.repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW })
    h.repo.tickets.save(ticketOf({ inputs: [inputOf('tk1', 'trig1')] }))

    h.tickets.attach('tk1', trigger)
    expect(h.repo.tickets.get('tk1')!.inputs).toHaveLength(1)
  })
})

// ── requestStatus / retry ───────────────────────────────────────────────────

describe('Tickets.requestStatus', () => {
  test('只问 waiting 的 running worker；其它一律 false，未知工单抛错', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({
      assignments: [{ id: 'a1', state: 'running', createdAt: NOW, report: { state: 'waiting', summary: '等人', at: NOW } }],
    }))
    expect(h.tickets.requestStatus('tk1')).toBe(true)
    const ticket = h.repo.tickets.get('tk1')!
    expect(ticket.inputs).toHaveLength(1)
    expect(ticket.inputs[0]).toMatchObject({ kind: 'text' })
    expect((ticket.inputs[0] as Extract<TicketInput, { kind: 'text' }>).text).toContain('status-only request')

    h.tickets.requestStatus('tk1')
    expect(h.repo.tickets.get('tk1')!.inputs, '同一时刻重复请求幂等').toHaveLength(1)

    h.repo.tickets.save(ticketOf({
      id: 'progress',
      assignments: [{ id: 'a1', state: 'running', createdAt: NOW, report: { state: 'progress', summary: '在做', at: NOW } }],
    }))
    expect(h.tickets.requestStatus('progress')).toBe(false)

    h.repo.tickets.save(ticketOf({ id: 'ended', ended: { at: NOW, by: 'human', outcome: 'stopped' } }))
    expect(h.tickets.requestStatus('ended')).toBe(false)

    expect(codeOf(() => h.tickets.requestStatus('ghost'))).toBe('unknownTicket')
  })
})

describe('Tickets.retry', () => {
  test('失败工单：结束旧分配、把未读 trigger 放回队首、起新分配', () => {
    const h = harness()
    const input = inputOf('tk1', 'trig1', { readAt: null, deliveredTo: 'a1' })
    h.repo.tickets.save(ticketOf({
      assignments: [{ id: 'a1', state: 'running', createdAt: NOW, report: { state: 'failed', summary: '挂了', at: NOW } }],
      inputs: [input],
    }))
    h.state.now = LATER

    const ticket = h.tickets.retry('tk1')
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.assignments[0]).toMatchObject({ state: 'ended', endedReason: 'retried', endedAt: LATER })
    expect(ticket.assignments[1]).toMatchObject({ state: 'pending', createdAt: LATER })
    expect(ticket.undelivered, '未读 trigger 重新排队').toEqual([input.id])
    expect(ticket.updatedAt).toBe(LATER)
    expect(h.calls.stop.map((call) => call.reason)).toEqual(['retried'])
    expect(h.calls.start).toHaveLength(1)
  })

  test('不可重试与未知工单各自报错', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf())
    expect(codeOf(() => h.tickets.retry('tk1'))).toBe('notRetryable')
    expect(codeOf(() => h.tickets.retry('ghost'))).toBe('unknownTicket')

    h.repo.tickets.save(ticketOf({
      id: 'ended',
      ended: { at: NOW, by: 'executor', outcome: 'completed' },
      assignments: [{ id: 'a1', state: 'ended', createdAt: NOW, report: { state: 'failed', summary: '挂了', at: NOW } }],
    }))
    expect(codeOf(() => h.tickets.retry('ended'))).toBe('notRetryable')
  })
})

// ── markUnrelated / dropSubscriptions / policyChanged ───────────────────────

describe('Tickets.markUnrelated', () => {
  test('源话题、自己 follow 的话题、没订阅的话题各自拒绝', () => {
    const h = harness()
    const source = threadRef('x')
    const followed = threadRef('pr')
    h.repo.tickets.save(ticketOf({ follows: [{ thread: threadKeyOf(followed), own: true }] }))
    h.repo.triggers.save(triggerOf('trig1', { threads: [source] }))
    h.repo.threads.save(threadOf(followed, { subscriptions: ['tk1'] }))

    expect(codeOf(() => h.tickets.markUnrelated('tk1', threadKeyOf(source), 'x'))).toBe('sourceThread')
    expect(codeOf(() => h.tickets.markUnrelated('tk1', threadKeyOf(followed), 'x'))).toBe('followedThread')
    expect(codeOf(() => h.tickets.markUnrelated('tk1', 'feishu:unknown', 'x'))).toBe('notFollowing')
  })

  test('成功时只退掉这张工单的订阅，并把它决定过的人消息交回 Eval', () => {
    const h = harness()
    const related = threadRef('z')
    h.repo.threads.save(threadOf(related, { subscriptions: ['tk1', 'tk2'] }))
    // 起始 trigger 在别的话题上：`related` 只是它后来订阅并决定的一条消息所在的话题。
    h.repo.triggers.save(triggerOf('origin-trig', { threads: [threadRef('origin')] }))
    h.repo.tickets.save(ticketOf({
      origin: { triggerId: 'origin-trig', triggerIds: ['origin-trig'] },
      inputs: [inputOf('tk1', 'trig1')],
    }))
    h.repo.triggers.save(triggerOf('trig1', { threads: [related] }))
    h.repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW })
    h.repo.tickets.save(ticketOf({ id: 'tk2' }))

    h.tickets.markUnrelated('tk1', threadKeyOf(related), '这个话题不相关')
    expect(h.repo.threads.get(threadKeyOf(related))!.subscriptions).toEqual(['tk2'])
    expect(h.repo.triggers.disposition('trig1')!.handbacks).toEqual([
      { ticketId: 'tk1', reason: '这个话题不相关', at: NOW },
    ])
    expect(h.events.map((event) => event.type)).toContain('thread.unsubscribed')
  })
})

describe('Tickets.dropSubscriptions', () => {
  test('未知话题 / 没有匹配订阅都不动；按工单过滤只掉那一张', () => {
    const h = harness()
    expect(h.tickets.dropSubscriptions('feishu:none', 'person')).toBe(false)

    const ref = threadRef('x')
    h.repo.threads.save(threadOf(ref, { subscriptions: ['tk1', 'tk2'] }))
    expect(h.tickets.dropSubscriptions(threadKeyOf(ref), 'person', 'tk3')).toBe(false)
    expect(h.repo.threads.get(threadKeyOf(ref))!.subscriptions).toEqual(['tk1', 'tk2'])

    expect(h.tickets.dropSubscriptions(threadKeyOf(ref), 'person', 'tk1')).toBe(true)
    expect(h.repo.threads.get(threadKeyOf(ref))!.subscriptions).toEqual(['tk2'])
  })

  test('订阅掉光后 follow 也删；follow 为空时连字段一起删', () => {
    const h = harness()
    const ref = threadRef('x')
    h.repo.threads.save(threadOf(ref, { subscriptions: ['tk1', 'tk2'] }))
    h.repo.tickets.save(ticketOf({ follows: [{ thread: threadKeyOf(ref), own: true }] }))
    h.repo.tickets.save(ticketOf({ id: 'tk2', follows: [{ thread: threadKeyOf(ref), own: false }] }))

    expect(h.tickets.dropSubscriptions(threadKeyOf(ref), 'executor', undefined, '清理')).toBe(true)
    expect(h.repo.tickets.get('tk1')!.follows).toBeUndefined()
    expect(h.repo.tickets.get('tk2')!.follows).toBeUndefined()
    expect(h.events.at(-1)).toMatchObject({ type: 'thread.unsubscribed', data: { reason: '清理', by: 'executor' } })
  })
})

describe('Tickets.policyChanged', () => {
  test('只通知受影响的开放工单，按接受时间从旧到新；同一时刻的重复不重复入队', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({ id: 'new', createdAt: LATER, updatedAt: LATER }))
    h.repo.tickets.save(ticketOf({ id: 'old', createdAt: EARLIER, updatedAt: EARLIER }))
    h.repo.tickets.save(ticketOf({ id: 'ended', createdAt: EARLIER, ended: { at: NOW, by: 'human', outcome: 'stopped' } }))
    const effect: PolicyEffect = { proactive: false }
    const effects = new Map<string, PolicyEffect>([['old', effect], ['new', effect], ['ended', effect]])

    h.tickets.policyChanged('v1', 'v2', effects)
    const oldInputs = h.repo.tickets.get('old')!.inputs
    expect(oldInputs).toHaveLength(1)
    expect(oldInputs[0]).toMatchObject({ kind: 'policy-changed', from: 'v1', to: 'v2', effect })
    expect(h.repo.tickets.get('new')!.inputs).toHaveLength(1)
    expect(h.repo.tickets.get('ended')!.inputs, '结束的工单不通知').toEqual([])

    h.tickets.policyChanged('v1', 'v2', effects)
    expect(h.repo.tickets.get('old')!.inputs).toHaveLength(1)
    h.state.now = LATER
    h.tickets.policyChanged('v1', 'v2', effects)
    expect(h.repo.tickets.get('old')!.inputs, '换时刻的同一对版本变更要记新 Input').toHaveLength(2)
  })
})

// ── addInput / wake ─────────────────────────────────────────────────────────

describe('Tickets.addInput', () => {
  test('重复 id 直接返回；自动消息在等人时先扣住；人写的 trigger 不扣', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({
      assignments: [{ id: 'a1', state: 'running', createdAt: NOW, report: { state: 'blocked', summary: '等人', at: NOW } }],
    }))
    const note: TicketInput = { id: 'note-1', kind: 'note', text: '自动事实', at: NOW }
    h.tickets.addInput(h.repo.tickets.get('tk1')!, note)
    let saved = h.repo.tickets.get('tk1')!
    expect(saved.inputs.map((item) => item.id)).toEqual(['note-1'])
    expect(saved.undelivered, '等人时自动 note 不投递').toEqual([])
    expect(h.calls.deliver).toEqual([])

    h.tickets.addInput(h.repo.tickets.get('tk1')!, note)
    expect(h.repo.tickets.get('tk1')!.inputs).toHaveLength(1)

    h.tickets.addInput(h.repo.tickets.get('tk1')!, { id: 'human-1', kind: 'trigger', triggerId: 'trig1', at: NOW, human: true })
    saved = h.repo.tickets.get('tk1')!
    expect(saved.undelivered).toEqual(['human-1'])
    expect(h.calls.deliver).toEqual([{ ticketId: 'tk1', assignmentId: 'a1' }])
  })

  test('没有运行中的分配但最新分配 pending：不等人时重新派工', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf())
    h.tickets.addInput(h.repo.tickets.get('tk1')!, { id: 'n1', kind: 'note', text: '事实', at: NOW })
    expect(h.calls.start).toEqual([{ ticketId: 'tk1', assignmentId: 'a0' }])
  })
})

describe('Tickets.wake：结束的工单被人的消息唤醒', () => {
  test('暂停时不醒；没有未送达、不是被人停的、未知工单都不动', () => {
    const h = harness()
    const input = inputOf('tk1', 'trig1', { human: true })
    h.repo.tickets.save(ticketOf({ inputs: [input], undelivered: [input.id], ended: { at: EARLIER, by: 'executor', outcome: 'completed' } }))
    h.state.paused = true
    h.tickets.wake('tk1')
    expect(h.repo.tickets.get('tk1')!.ended).toBeTruthy()

    h.state.paused = false
    h.repo.tickets.save(ticketOf({ id: 'open' }))
    h.tickets.wake('open')
    expect(h.repo.tickets.get('open')!.assignments, '开放工单不新建分配').toHaveLength(1)

    h.repo.tickets.save(ticketOf({
      id: 'stopped',
      ended: { at: NOW, by: 'human', outcome: 'stopped' },
      inputs: [inputOf('stopped', 'trig1', { human: true })],
      undelivered: [inputOf('stopped', 'trig1').id],
    }))
    h.tickets.wake('stopped')
    expect(h.repo.tickets.get('stopped')!.ended!.by).toBe('human')

    expect(() => h.tickets.wake('ghost')).not.toThrow()
  })

  test('只有自动消息等待时不醒', () => {
    const h = harness()
    const bot = inputOf('tk1', 'trig-bot')
    h.repo.tickets.save(ticketOf({ inputs: [bot], undelivered: [bot.id], ended: { at: EARLIER, by: 'executor', outcome: 'completed' } }))
    h.tickets.wake('tk1')
    expect(h.repo.tickets.get('tk1')!.ended).toBeTruthy()
  })

  test('授权失效：不再醒来，清空未送达并把消息交回 Eval', () => {
    const h = harness()
    const input = inputOf('tk1', 'trig1', { human: true })
    h.repo.tickets.save(ticketOf({ inputs: [input], undelivered: [input.id], ended: { at: EARLIER, by: 'executor', outcome: 'completed' } }))
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW })
    h.repo.threads.save(threadOf(threadRef(), { subscriptions: ['tk1'] }))
    h.state.revalidate = false

    h.tickets.wake('tk1')
    const ticket = h.repo.tickets.get('tk1')!
    expect(ticket.ended, '授权没了就保持结束').toBeTruthy()
    expect(ticket.undelivered).toEqual([])
    expect(h.repo.triggers.disposition('trig1')!.fanout).toEqual([])
    expect(h.repo.threads.get('feishu:x')!.pending, '没人决定的 trigger 回到 Eval 队列').toEqual(['trig1'])
  })

  test('正常唤醒：清掉 ended、新分配、resumed 标记排在队首', () => {
    const h = harness()
    const input = inputOf('tk1', 'trig1', { human: true, at: EARLIER })
    h.repo.tickets.save(ticketOf({ inputs: [input], undelivered: [input.id], ended: { at: NOW, by: 'executor', outcome: 'completed' } }))
    h.repo.triggers.save(triggerOf('trig1'))
    h.state.now = LATER

    h.tickets.wake('tk1')
    const ticket = h.repo.tickets.get('tk1')!
    expect(ticket.ended).toBeUndefined()
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.assignments[1]).toMatchObject({ state: 'pending', createdAt: LATER })
    const resumedId = key('input', 'tk1', 'resumed', 'trig1')
    expect(ticket.undelivered).toEqual([resumedId, input.id])
    expect(ticket.inputs.at(-1)).toMatchObject({ id: resumedId, kind: 'resumed', triggerId: 'trig1' })
    expect(h.calls.start).toEqual([{ ticketId: 'tk1', assignmentId: ticket.assignments[1]!.id }])
    expect(h.events.at(-1)).toMatchObject({ type: 'ticket.resumed', data: { ticketId: 'tk1', triggerId: 'trig1' } })
  })
})

// ── end / note / followForContext ───────────────────────────────────────────

describe('Tickets.end', () => {
  test('结束运行中的分配、清 attention 与 delivery、带自定义理由', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({
      assignments: [
        { id: 'a1', state: 'running', createdAt: NOW },
        { id: 'a0', state: 'ended', createdAt: EARLIER, endedAt: EARLIER },
      ],
      attention: { id: 'att1', question: '要吗？' },
      delivery: { error: '投递失败', at: NOW },
    }))
    h.state.now = LATER

    h.tickets.end('tk1', 'executor', 'completed', NOW, '人要求收工')
    const ticket = h.repo.tickets.get('tk1')!
    expect(ticket.ended).toEqual({ at: NOW, by: 'executor', outcome: 'completed', reason: '人要求收工' })
    expect(ticket.assignments[0]).toMatchObject({ state: 'ended', endedAt: NOW })
    expect(ticket.attention).toBeUndefined()
    expect(ticket.delivery).toBeUndefined()
    expect(ticket.undelivered).toEqual([])
    expect(ticket.updatedAt).toBe(LATER)
    expect(h.calls.stop).toEqual([{ ticketId: 'tk1', assignmentId: 'a1', reason: '人要求收工' }])
    expect(h.events.at(-1)).toMatchObject({ type: 'ticket.ended', data: { outcome: 'completed', reason: '人要求收工' } })
  })

  test('已结束再调用是空操作；reason 与 outcome 相同则不记 reason', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({ ended: { at: EARLIER, by: 'human', outcome: 'stopped' } }))
    h.tickets.end('tk1', 'executor', 'completed')
    expect(h.repo.tickets.get('tk1')!.ended).toEqual({ at: EARLIER, by: 'human', outcome: 'stopped' })

    h.repo.tickets.save(ticketOf({ id: 'tk2' }))
    h.tickets.end('tk2', 'executor', 'completed', NOW, 'completed')
    expect(h.repo.tickets.get('tk2')!.ended).toEqual({ at: NOW, by: 'executor', outcome: 'completed' })

    expect(codeOf(() => h.tickets.end('ghost', 'executor', 'completed'))).toBe('unknownTicket')
  })

  test('结束时把 worker 没收到的消息交回、并把没送达的 fanout 撤掉', () => {
    const h = harness()
    const input = inputOf('tk1', 'trig1', { at: EARLIER })
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW })
    h.repo.threads.save(threadOf(threadRef(), { subscriptions: ['tk1'] }))
    h.repo.tickets.save(ticketOf({ inputs: [input], undelivered: [input.id] }))

    h.tickets.end('tk1', 'executor', 'completed', NOW)
    expect(h.repo.triggers.disposition('trig1')!.fanout).toEqual([])
    expect(h.repo.threads.get('feishu:x')!.pending).toEqual(['trig1'])
  })
})

describe('Tickets.note / followForContext', () => {
  test('note：未知与结束的工单拒绝，开放工单追加并投递', () => {
    const h = harness()
    expect(codeOf(() => h.tickets.note('ghost', 'x'))).toBe('unknownTicket')
    h.repo.tickets.save(ticketOf({ id: 'ended', ended: { at: NOW, by: 'human', outcome: 'stopped' } }))
    expect(codeOf(() => h.tickets.note('ended', 'x'))).toBe('ticketEnded')

    h.repo.tickets.save(ticketOf({ assignments: [{ id: 'a1', state: 'running', createdAt: NOW }] }))
    const ticket = h.tickets.note('tk1', '一个事实')
    expect(ticket.inputs.at(-1)).toMatchObject({ kind: 'note', text: '一个事实' })
    expect(ticket.undelivered).toHaveLength(1)
    expect(h.calls.deliver).toEqual([{ ticketId: 'tk1', assignmentId: 'a1' }])
  })

  test('followForContext：未知 / 结束拒绝，已订阅返回 false，新订阅记 context', () => {
    const h = harness()
    const ref = threadRef('issue')
    expect(codeOf(() => h.tickets.followForContext('ghost', ref))).toBe('unknownTicket')
    h.repo.tickets.save(ticketOf({ id: 'ended', ended: { at: NOW, by: 'human', outcome: 'stopped' } }))
    expect(codeOf(() => h.tickets.followForContext('ended', ref))).toBe('ticketEnded')

    h.repo.tickets.save(ticketOf())
    expect(h.tickets.followForContext('tk1', ref)).toBe(true)
    expect(h.repo.threads.get(threadKeyOf(ref))).toMatchObject({ subscriptions: ['tk1'], context: ['tk1'] })
    expect(h.tickets.followForContext('tk1', ref), '已经 follow 过').toBe(false)
  })
})

// ── Evals：due / delivered ─────────────────────────────────────────────────

describe('Evals.due：暂停顺延、超期重排、连续超期记 unavailable', () => {
  test('没有 evaluating 或候选还没投递时一律不动', () => {
    const h = harness()
    const ref = threadRef()
    const plain = threadOf(ref)
    h.evals.due(plain, h.policy())
    expect(plain.evaluating).toBeUndefined()

    const notDelivered = threadOf(ref, { evaluating: evaluatingOf({ deadline: EARLIER }) })
    h.repo.threads.save(notDelivered)
    h.evals.due(h.repo.threads.get(threadKeyOf(ref))!, h.policy())
    expect(h.repo.threads.get(threadKeyOf(ref))!.evaluating!.deadline).toBe(EARLIER)
  })

  test('暂停时记 pausedAt；恢复时把 deadline 顺延一段；重复暂停不动', () => {
    const h = harness()
    const ref = threadRef()
    h.repo.threads.save(threadOf(ref, { evaluating: evaluatingOf({ delivered: NOW, deadline: LATER }) }))
    h.state.paused = true

    h.evals.due(h.repo.threads.get(threadKeyOf(ref))!, h.policy())
    expect(h.repo.threads.get(threadKeyOf(ref))!.evaluating!.pausedAt).toBe(NOW)
    h.state.now = '2026-01-01T00:00:30.000Z'
    h.evals.due(h.repo.threads.get(threadKeyOf(ref))!, h.policy())
    expect(h.repo.threads.get(threadKeyOf(ref))!.evaluating!.pausedAt, '已经记过就不动').toBe(NOW)

    h.state.paused = false
    h.state.now = LATER
    h.evals.due(h.repo.threads.get(threadKeyOf(ref))!, h.policy())
    const evaluating = h.repo.threads.get(threadKeyOf(ref))!.evaluating!
    expect(evaluating.pausedAt).toBeUndefined()
    expect(evaluating.deadline).toBe('2026-01-01T00:02:00.000Z')
  })

  test('投递后超期：重排一次；连续超到第 3 次记 unavailable', () => {
    const h = harness()
    const ref = threadRef()
    h.repo.threads.save(threadOf(ref, {
      evaluating: evaluatingOf({ delivered: EARLIER, deadline: EARLIER }),
      pending: ['trig0'],
    }))
    h.evals.due(h.repo.threads.get(threadKeyOf(ref))!, h.policy())
    let thread = h.repo.threads.get(threadKeyOf(ref))!
    expect(thread.evaluating, '第一次超期先重排').toBeUndefined()
    expect(thread.expired).toBe(1)
    expect(thread.pending).toEqual(['trig1', 'trig0'])

    h.repo.threads.save(threadOf(ref, {
      evaluating: evaluatingOf({ delivered: EARLIER, deadline: EARLIER, id: 'eval-2' }),
      expired: 2,
    }))
    h.evals.due(h.repo.threads.get(threadKeyOf(ref))!, h.policy())
    thread = h.repo.threads.get(threadKeyOf(ref))!
    expect(thread.evaluating).toBeUndefined()
    const decision = h.repo.decisions.byThread(threadKeyOf(ref)).at(-1)!
    expect(decision).toMatchObject({ kind: 'unavailable', reason: [{ code: 'timeout' }], evalId: 'eval-2' })
  })
})

describe('Evals.delivered', () => {
  test('找不到、已投递都不动；首次投递把 deadline 从现在起算', () => {
    const h = harness()
    h.evals.delivered('ghost', h.policy())
    const ref = threadRef()
    h.repo.threads.save(threadOf(ref, { evaluating: evaluatingOf({ delivered: EARLIER }) }))
    h.evals.delivered('eval-1', h.policy())
    expect(h.repo.threads.get(threadKeyOf(ref))!.evaluating!.delivered).toBe(EARLIER)

    h.repo.threads.save(threadOf(ref, { evaluating: evaluatingOf() }))
    h.state.now = LATER
    h.evals.delivered('eval-1', h.policy())
    expect(h.repo.threads.get(threadKeyOf(ref))!.evaluating).toMatchObject({
      delivered: LATER,
      deadline: '2026-01-01T00:01:01.000Z',
    })
  })
})

// ── Evals.start ────────────────────────────────────────────────────────────

describe('Evals.start：先摘掉已归属工单的消息，再判一批', () => {
  test('worker 仍决定的人消息从队列里摘掉并广播；摘完为空就不起 Eval', () => {
    const h = harness()
    const ref = threadRef()
    h.repo.threads.save(threadOf(ref, { pending: ['trig1'] }))
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW })
    h.repo.tickets.save(ticketOf())

    h.evals.start(threadKeyOf(ref), h.policy())
    const thread = h.repo.threads.get(threadKeyOf(ref))!
    expect(thread.pending).toEqual([])
    expect(thread.evaluating).toBeUndefined()
    expect(h.requests).toEqual([])
    expect(h.events.at(-1)).toMatchObject({ type: 'trigger.followup', data: { triggerId: 'trig1' } })
  })

  test('已开过工单的 trigger 只记 ignore，同批其余 trigger 单独起 Eval', () => {
    const h = harness()
    const ref = threadRef()
    h.repo.threads.save(threadOf(ref, { pending: ['trig1', 'trig2'] }))
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.triggers.save(triggerOf('trig2'))
    h.repo.decisions.save({
      id: 'dec-old', evalId: 'eval-old', threadKey: threadKeyOf(ref), triggerIds: ['trig1'], policyVersion: 'v1',
      at: NOW, kind: 'accept', reason: [], strength: 'explicit', ticketId: 'tk-old',
    })

    h.evals.start(threadKeyOf(ref), h.policy())
    const decisions = h.repo.decisions.byThread(threadKeyOf(ref))
    expect(decisions.some((item) => item.kind === 'ignore'
      && item.reason.some((reason) => reason.code === 'startedTicket'))).toBe(true)
    const thread = h.repo.threads.get(threadKeyOf(ref))!
    expect(thread.pending).toEqual([])
    expect(thread.evaluating!.triggerIds).toEqual(['trig2'])
    expect(h.requests).toHaveLength(1)
  })

  test('整批不可准入：记一条 ignore，队列清空，不起 Eval', () => {
    const h = harness()
    const ref = threadRef()
    h.repo.threads.save(threadOf(ref, { pending: ['trig1', 'trig2'] }))
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.triggers.save(triggerOf('trig2'))
    h.state.gateResult = { admissible: false, reason: 'not_listened' }

    h.evals.start(threadKeyOf(ref), h.policy())
    const thread = h.repo.threads.get(threadKeyOf(ref))!
    expect(thread.pending).toEqual([])
    expect(thread.evaluating).toBeUndefined()
    const decision = h.repo.decisions.byThread(threadKeyOf(ref)).at(-1)!
    expect(decision.kind).toBe('ignore')
    expect(decision.reason.map((reason) => reason.code)).toEqual(['not_listened', 'not_listened'])
  })

  test('强者的选择：更强优先，同强度更晚优先；结果写进 Eval 与 disposition', () => {
    const h = harness()
    const ref = threadRef()
    h.repo.threads.save(threadOf(ref, { pending: ['trig1', 'trig2', 'trig3'] }))
    h.repo.triggers.save(triggerOf('trig1', { at: EARLIER }))
    h.repo.triggers.save(triggerOf('trig2', { at: NOW }))
    h.repo.triggers.save(triggerOf('trig3', { at: LATER }))
    h.state.gateFor = (trigger) => trigger.id === 'trig1'
      ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } }
      : { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } }

    h.evals.start(threadKeyOf(ref), h.policy())
    const thread = h.repo.threads.get(threadKeyOf(ref))!
    expect(thread.evaluating).toMatchObject({ primary: 'trig3', strength: 'explicit', triggerIds: ['trig1', 'trig2', 'trig3'] })
    expect(thread.pending).toEqual([])
    expect(h.repo.triggers.disposition('trig1')!.evalId).toBe(thread.evaluating!.id)
    expect(h.repo.triggers.disposition('trig3')!.evalId).toBe(thread.evaluating!.id)
    expect(h.requests[0]!.triggers.map((trigger) => trigger.id)).toEqual(['trig1', 'trig2', 'trig3'])
    expect(h.events.at(-1)).toMatchObject({ type: 'eval.started' })
  })
})

// ── Evals.decide ───────────────────────────────────────────────────────────

describe('Evals.decide：拒绝面与 replay', () => {
  test('未知 trigger、已结束的 Eval、worker 仍决定都拒绝', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    expect(codeOf(() => h.evals.decide('ghost', { kind: 'ignore', reason: 'x' }))).toBe('unknownTrigger')
    expect(codeOf(() => h.evals.decide('trig1', { kind: 'ignore', reason: 'x', evalId: 'gone' }))).toBe('evalFinished')

    h.repo.tickets.save(ticketOf())
    h.repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW })
    expect(codeOf(() => h.evals.decide('trig1', { kind: 'accept', title: 't', scope: 'chat', reason: 'ok' })))
      .toBe('workerDecides')
  })

  test('同一条消息 replay accept：有其它 trigger 就重评，单独一条就 ignore', () => {
    const h = harness()
    const ref = threadRef()
    h.repo.threads.save(threadOf(ref, { evaluating: evaluatingOf({ triggerIds: ['trig1', 'trig2'] }) }))
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.triggers.save(triggerOf('trig2'))
    h.repo.decisions.save({
      id: 'dec-old', evalId: 'eval-old', threadKey: threadKeyOf(ref), triggerIds: ['trig1'], policyVersion: 'v1',
      at: NOW, kind: 'accept', reason: [], strength: 'explicit', ticketId: 'tk-old',
    })

    const earlier = h.evals.decide('trig1', { kind: 'accept', title: 't', scope: 'chat', reason: 'ok' })
    expect(earlier.ticketId).toBe('tk-old')
    const thread = h.repo.threads.get(threadKeyOf(ref))!
    expect(thread.evaluating).toBeUndefined()
    expect(thread.pending).toEqual(['trig2'])
    expect(h.repo.decisions.byThread(threadKeyOf(ref)).at(-1)).toMatchObject({ kind: 'unavailable' })

    h.repo.threads.save(threadOf(ref, { evaluating: evaluatingOf({ id: 'eval-solo', triggerIds: ['trig2'] }) }))
    h.repo.decisions.save({
      id: 'dec-solo', evalId: 'eval-solo', threadKey: threadKeyOf(ref), triggerIds: ['trig2'], policyVersion: 'v1',
      at: NOW, kind: 'accept', reason: [], strength: 'explicit', ticketId: 'tk-solo',
    })
    h.evals.decide('trig2', { kind: 'accept', title: 't', scope: 'chat', reason: 'ok' })
    expect(h.repo.decisions.byThread(threadKeyOf(ref)).at(-1)).toMatchObject({
      kind: 'ignore',
      reason: [{ code: 'startedTicket', triggerId: 'trig2', values: { ticket: 'tk-solo' } }],
    })
  })

  test('推断候选在规则不成立时不能 accept', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.state.gateResult = { admissible: true, strength: 'inferred', basis: { via: 'followup' } }
    h.state.admits = false
    expect(codeOf(() => h.evals.decide('trig1', { kind: 'accept', title: 't', scope: 'chat', reason: 'ok', rules: [] })))
      .toBe('notExplicit')
  })

  test('accept：建工单、Mandate 带上规则；inferred ignore 补 ignoredFromCard', () => {
    const h = harness()
    const ref = threadRef()
    h.repo.threads.save(threadOf(ref))
    h.repo.triggers.save(triggerOf('trig1'))
    h.state.gateResult = { admissible: true, strength: 'inferred', basis: { via: 'followup' } }

    const decision = h.evals.decide('trig1', {
      kind: 'accept', title: '标题', scope: 'chat', reason: '看起来要做', rules: ['rule-a'], audit: { score: 1 },
    })
    expect(decision.kind).toBe('accept')
    expect(decision.mandate).toMatchObject({ strength: 'inferred', basis: { via: 'followup', rules: ['rule-a'] }, scope: 'chat' })
    expect(decision.audit).toEqual({ score: 1 })
    expect(h.repo.tickets.get(decision.ticketId!), 'accept 要真建出工单').toBeTruthy()

    h.repo.triggers.save(triggerOf('trig2'))
    const ignored = h.evals.decide('trig2', { kind: 'ignore', reason: '不算' })
    expect(ignored.reason[0]).toMatchObject({ code: 'ignoredFromCard' })
  })

  test('stop：活工单被停；未知 / 已结束与推断候选都只记 ignore', () => {
    const h = harness()
    const ref = threadRef()
    h.repo.threads.save(threadOf(ref))
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.triggers.save(triggerOf('trig2'))
    h.repo.triggers.save(triggerOf('trig3'))
    h.repo.tickets.save(ticketOf())

    const stopped = h.evals.decide('trig1', { kind: 'stop', ticketId: 'tk1', reason: '人叫停' })
    expect(stopped).toMatchObject({ kind: 'stop', ticketId: 'tk1' })
    expect(h.repo.tickets.get('tk1')!.ended).toMatchObject({ by: 'human', outcome: 'stopped' })

    const unknown = h.evals.decide('trig2', { kind: 'stop', ticketId: 'ghost', reason: 'x' })
    expect(unknown).toMatchObject({ kind: 'ignore', reason: [{ code: 'stopUnknown' }] })

    h.state.gateFor = () => ({ admissible: true, strength: 'inferred', basis: { via: 'followup' } })
    h.repo.tickets.save(ticketOf({ id: 'tk-inferred' }))
    const weak = h.evals.decide('trig3', { kind: 'stop', ticketId: 'tk-inferred', reason: 'x' })
    expect(weak).toMatchObject({ kind: 'ignore', reason: [{ code: 'stopNotExplicit' }] })
  })

  test('判定时 policy 版本已变：重评在途 Eval，把 trigger 放回队列', () => {
    const h = harness()
    const ref = threadRef()
    h.repo.threads.save(threadOf(ref, { evaluating: evaluatingOf({ policyVersion: 'old' }) }))
    h.repo.triggers.save(triggerOf('trig1'))

    const decision = h.evals.decide('trig1', { kind: 'ignore', reason: 'x' })
    expect(decision).toMatchObject({ kind: 'unavailable', reason: [{ code: 'policyChanged' }] })
    const thread = h.repo.threads.get(threadKeyOf(ref))!
    expect(thread.evaluating).toBeUndefined()
    expect(thread.pending).toEqual(['trig1'])
  })
})

// ── Evals 的其余变更面 ────────────────────────────────────────────────────

describe('Evals.reevaluate / handback / dismiss / withdraw', () => {
  test('reevaluate：未知抛错；Eval 正持有返回 false；否则入队并标 requeued', () => {
    const h = harness()
    expect(codeOf(() => h.evals.reevaluate('ghost'))).toBe('unknownTrigger')
    const ref = threadRef()
    h.repo.threads.save(threadOf(ref, { evaluating: evaluatingOf() }))
    h.repo.triggers.save(triggerOf('trig1'))
    expect(h.evals.reevaluate('trig1')).toBe(false)

    h.repo.threads.save(threadOf(ref))
    expect(h.evals.reevaluate('trig1')).toBe(true)
    expect(h.repo.threads.get(threadKeyOf(ref))!.pending).toEqual(['trig1'])
    expect(h.repo.triggers.disposition('trig1')!.requeued).toBe(true)
    expect(h.events.at(-1)).toMatchObject({ type: 'trigger.requeued' })
  })

  test('handback：未到达 / 已 handback 拒绝；成功写 handbacks 并把消息交回 Eval', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf())
    h.repo.triggers.save(triggerOf('trig1'))
    expect(codeOf(() => h.evals.handback('tk1', 'trig1', 'x'))).toBe('notReached')

    h.repo.tickets.save(ticketOf({ inputs: [inputOf('tk1', 'trig1')] }))
    h.repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW, handbacks: [{ ticketId: 'tk1', reason: 'x', at: NOW }] })
    expect(codeOf(() => h.evals.handback('tk1', 'trig1', 'y'))).toBe('handedBack')

    h.repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW })
    expect(h.evals.handback('tk1', 'trig1', '不归我'), 'handback 后不再有工单决定它').toBe(true)
    expect(h.repo.triggers.disposition('trig1')!.handbacks).toEqual([{ ticketId: 'tk1', reason: '不归我', at: NOW }])
    expect(h.repo.threads.get('feishu:x')!.pending).toEqual(['trig1'])
  })

  test('dismiss：只接受 unavailable；withdraw 只摘排队中的 trigger', () => {
    const h = harness()
    const dec: Decision = {
      id: 'dec1', evalId: 'e1', threadKey: 'feishu:x', triggerIds: ['trig1'], policyVersion: 'v1',
      at: NOW, kind: 'unavailable', reason: [{ code: 'timeout' }], strength: 'explicit',
    }
    expect(codeOf(() => h.evals.dismiss('ghost'))).toBe('unknownProblem')
    h.repo.decisions.save({ ...dec, kind: 'ignore' })
    expect(codeOf(() => h.evals.dismiss('dec1'))).toBe('unknownProblem')

    h.repo.decisions.save(dec)
    expect(h.evals.dismiss('dec1').dismissed).toBe(true)
    expect(h.repo.decisions.get('dec1')!.dismissed).toBe(true)

    const ref = threadRef()
    h.repo.threads.save(threadOf(ref, { pending: ['trig1', 'trig2'] }))
    h.evals.withdraw(triggerOf('trig1'))
    expect(h.repo.threads.get(threadKeyOf(ref))!.pending).toEqual(['trig2'])
    h.evals.withdraw(triggerOf('ghost'))
  })
})

describe('Evals.routed / policyChanged', () => {
  test('routed：单独一条记 routed ignore；同批多条重评剩下那些', () => {
    const h = harness()
    const ref = threadRef()
    h.repo.threads.save(threadOf(ref, { evaluating: evaluatingOf({ triggerIds: ['trig1'] }) }))
    h.repo.triggers.save(triggerOf('trig1'))
    h.evals.routed('trig1', 'tk1')
    expect(h.repo.decisions.byThread(threadKeyOf(ref)).at(-1)).toMatchObject({
      kind: 'ignore',
      reason: [{ code: 'routed', values: { ticket: 'tk1' } }],
    })

    h.repo.threads.save(threadOf(ref, { evaluating: evaluatingOf({ id: 'eval-2', triggerIds: ['trig1', 'trig2'] }) }))
    h.repo.triggers.save(triggerOf('trig2'))
    h.evals.routed('trig1', 'tk1')
    const thread = h.repo.threads.get(threadKeyOf(ref))!
    expect(thread.evaluating).toBeUndefined()
    expect(thread.pending).toEqual(['trig2'])

    expect(() => h.evals.routed('trig3', 'tk1')).not.toThrow()
  })

  test('policyChanged：在途 Eval 全部按新版本重评，并广播版本变化', () => {
    const h = harness()
    const ref = threadRef()
    h.repo.threads.save(threadOf(ref, { evaluating: evaluatingOf() }))
    h.repo.triggers.save(triggerOf('trig1'))

    h.evals.policyChanged('v1', 'v2')
    expect(h.repo.decisions.byThread(threadKeyOf(ref)).at(-1)).toMatchObject({
      kind: 'unavailable',
      reason: [{ code: 'policyChanged' }],
    })
    expect(h.repo.threads.get(threadKeyOf(ref))!.pending).toEqual(['trig1'])
    expect(h.events.at(-1)).toMatchObject({ type: 'policy.changed', data: { from: 'v1', to: 'v2' } })
  })
})

// ── core/model.ts 的纯函数 ─────────────────────────────────────────────────

describe('model 纯函数：时间、状态与「谁还在决定这条消息」', () => {
  test('isoTime 正常化可解析时间，解析不了原样返回；liveTicket / ticketOutcome', () => {
    expect(isoTime('2026-01-01')).toBe('2026-01-01T00:00:00.000Z')
    expect(isoTime('not-a-time')).toBe('not-a-time')
    expect(liveTicket(ticketOf())).toBe(true)
    expect(liveTicket(ticketOf({ ended: { at: NOW, by: 'executor', outcome: 'merged' } }))).toBe(false)
    expect(ticketOutcome(ticketOf({ ended: { at: NOW, by: 'executor', outcome: 'merged' } }))).toBe('merged')
    expect(ticketOutcome(ticketOf())).toBeUndefined()
  })

  test('reached：origin、Input、订阅都算，context-only 在 context=false 时不算', () => {
    const trigger = triggerOf('trig1', { threads: [threadRef('x'), threadRef('y')] })
    expect(reached(ticketOf({ origin: { triggerId: 'trig1', triggerIds: ['trig1'] } }), trigger, () => undefined)).toBe(true)
    expect(reached(ticketOf({ origin: { triggerId: 'other', triggerIds: ['other'] }, inputs: [inputOf('tk1', 'trig1')] }), trigger, () => undefined)).toBe(true)

    const threads = new Map([
      ['feishu:x', threadOf(threadRef('x'), { subscriptions: ['tk1'], context: ['tk1'] })],
      ['feishu:y', threadOf(threadRef('y'), { subscriptions: ['tk1'], context: ['tk1'] })],
    ])
    const outsider = ticketOf({ origin: { triggerId: 'other', triggerIds: ['other'] } })
    expect(reached(outsider, trigger, (key) => threads.get(key), false), '所有线程都只是 context').toBe(false)
    threads.get('feishu:y')!.context = []
    expect(reached(outsider, trigger, (key) => threads.get(key), false), '有一个正常订阅就算').toBe(true)
  })

  test('readUntil / waitsForPerson / latest 辅助函数的分支', () => {
    const ticket = ticketOf({
      assignments: [
        { id: 'a0', state: 'ended', createdAt: EARLIER, endedAt: EARLIER, idleAt: LATER },
        { id: 'a1', state: 'running', createdAt: NOW, report: { state: 'progress', summary: '做', at: NOW } },
      ],
      inputs: [{ id: 'human', kind: 'trigger', triggerId: 'trig1', at: LATER, human: true }],
    })
    expect(readUntil(ticket)).toBe(LATER)
    expect(readUntil(ticket, false), 'progress 报告不算读完').toBe(LATER)
    expect(latestAssignment(ticket)!.id).toBe('a1')
    expect(latestReport(ticket)).toMatchObject({ state: 'progress' })

    const blocked = ticketOf({
      assignments: [{ id: 'a1', state: 'running', createdAt: NOW, report: { state: 'blocked', summary: '等人', at: NOW } }],
    })
    expect(waitsForPerson(blocked), '没有更新的真人消息').toBe(true)
    expect(waitsForPerson(ticketOf({
      assignments: [{ id: 'a1', state: 'running', createdAt: NOW, report: { state: 'blocked', summary: '等人', at: NOW } }],
      inputs: [{ id: 'human', kind: 'trigger', triggerId: 'trig1', at: LATER, human: true }],
    })), '有更新的真人消息就不等了').toBe(false)
    expect(waitsForPerson(ticketOf())).toBe(false)
  })

  test('settled 只认真正的裁决：stop / unavailable / routed 都不算', () => {
    expect(settled({ kind: 'accept', reason: [] })).toBe(true)
    expect(settled({ kind: 'ignore', reason: [] })).toBe(true)
    expect(settled({ kind: 'stop', reason: [] })).toBe(false)
    expect(settled({ kind: 'unavailable', reason: [] })).toBe(false)
    expect(settled({ kind: 'accept', reason: [{ code: 'routed' }] })).toBe(false)
    expect(settled({ kind: 'accept', reason: [{ code: 'stopNotExplicit' }] })).toBe(false)
  })

  test('followupOwners 的每个排除条件', () => {
    const repo = new MemoryRepositories()
    const trigger = triggerOf('trig1')
    repo.triggers.save(trigger)
    repo.threads.save(threadOf(threadRef(), { subscriptions: ['tk1'] }))
    repo.tickets.save(ticketOf())

    expect(followupOwners(triggerOf('bot', { human: false }), repo), '非人所写').toEqual([])
    expect(followupOwners(trigger, repo), '没有 disposition').toEqual([])

    repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW })
    expect(followupOwners(trigger, repo), '活的工单决定它').toEqual(['tk1'])

    repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW, requeued: true })
    expect(followupOwners(trigger, repo), '人又发回 Eval').toEqual([])

    repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW, handbacks: [{ ticketId: 'tk1', reason: 'x', at: NOW }] })
    expect(followupOwners(trigger, repo), 'handback 过的不再决定').toEqual([])

    repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW, context: ['tk1'] })
    expect(followupOwners(trigger, repo), '只在 context 里到达').toEqual([])

    repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW })
    repo.tickets.save(ticketOf({ ended: { at: NOW, by: 'executor', outcome: 'completed' } }))
    expect(followupOwners(trigger, repo), '结束且没有等待中的该 trigger').toEqual([])
    const input = inputOf('tk1', 'trig1')
    repo.tickets.save(ticketOf({
      ended: { at: NOW, by: 'executor', outcome: 'completed' },
      inputs: [input],
      undelivered: [input.id],
    }))
    expect(followupOwners(trigger, repo), '结束但该消息仍在等待恢复').toEqual(['tk1'])
    repo.tickets.save(ticketOf({ ended: { at: NOW, by: 'human', outcome: 'stopped' }, inputs: [input], undelivered: [input.id] }))
    expect(followupOwners(trigger, repo), '人停的不再决定').toEqual([])

    repo.tickets.save(ticketOf())
    repo.threads.save(threadOf(threadRef(), {
      subscriptions: ['tk1'],
      evaluating: evaluatingOf(),
    }))
    expect(followupOwners(trigger, repo), 'Eval 正持有它').toEqual([])

    repo.threads.save(threadOf(threadRef(), { subscriptions: ['tk1'] }))
    repo.triggers.saveDisposition('trig1', { fanout: ['tk1', 'ghost'], at: NOW })
    expect(followupOwners(trigger, repo), 'fanout 里查不到的工单不算').toEqual(['tk1'])
  })
})
