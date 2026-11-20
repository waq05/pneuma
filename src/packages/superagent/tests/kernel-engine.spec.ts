/**
 * 编排内核（`core/engine.ts` + 它的四个 part）的包级补盲。
 *
 * 为什么单独一份：`core/engine.ts` 是领域层的唯一事务入口，里面每个方法都只是「开事务 → 交给
 * part」，本身没有分支——它 0% 覆盖意味着**没有任何测试从入口走进去**，part 之间的接线
 * （`withdraw` → `attach` → `routed`、`report` → `end`、`interrupted` → `restart`）一条都没被
 * 串起来过。这里用真 `Engine` + `MemoryRepositories` + 假执行器 / 假出站队列，逐条走入口。
 *
 * 断言的是领域真行为（工单集合、分配状态、出站队列里有没有那条消息、回调被叫没叫），
 * 不是另造一份判据。
 *
 * @module dsc/packages/superagent/tests/kernel-engine
 */
import { describe, expect, test } from 'vitest'
import { Engine } from '../core/engine.js'
import { UserError } from '../core/errors.js'
import { key } from '../core/ids.js'
import { MemoryRepositories } from '../core/memory.js'
import {
  threadKey,
  type Assignment,
  type ChannelRef,
  type Decision,
  type Evaluation,
  type Mandate,
  type Thread,
  type ThreadRef,
  type Ticket,
  type TicketInput,
  type Trigger,
} from '../core/model.js'
import type { EngineOptions } from '../core/part.js'
import type { Candidate, DomainEvent, GateResult, OutboundMessage, Outbox, Policy, ReplyStatus } from '../core/ports.js'

const NOW = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-01T00:01:00.000Z'
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

const threadRef = (id = 'x'): ThreadRef => ({ source: 'feishu', id })

function threadOf(ref: ThreadRef, overrides: Partial<Thread> = {}): Thread {
  return { key: threadKey(ref), ref, createdAt: NOW, subscriptions: [], correlated: [], pending: [], meta: {}, ...overrides }
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
  return { id: key('input', ticketId, 'trigger', triggerId), kind: 'trigger', triggerId, at: NOW, ...overrides }
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

/** 假出站队列：与真实现一样按 id 幂等，并记下撤销。 */
function fakeOutbox() {
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

function harness() {
  const repo = new MemoryRepositories()
  const box = fakeOutbox()
  const calls = { start: [] as Ticket[], deliver: [] as Ticket[], stop: [] as { id: string; reason: string }[] }
  const events: DomainEvent[] = []
  const requests: Candidate[] = []
  const released: string[] = []
  const state = {
    now: NOW,
    paused: false,
    revalidate: true,
    version: 'v1',
    gateResult: { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } } as GateResult,
    admits: true,
    timeoutMs: 1_000,
  }
  const policy = (): Policy => ({
    version: state.version,
    paused: state.paused,
    gate: () => state.gateResult,
    revalidate: () => state.revalidate,
    admitsInferred: () => state.admits,
    evalTimeoutMs: state.timeoutMs,
  })
  const options: EngineOptions = {
    repo,
    policy,
    scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: (candidate) => { requests.push(candidate) }, release: (id) => { released.push(id) } },
    executor: {
      start: (ticket) => { calls.start.push(ticket) },
      deliver: (ticket) => { calls.deliver.push(ticket) },
      stop: (ticket, _assignment, reason) => { calls.stop.push({ id: ticket.id, reason }) },
    },
    outbox: box.outbox,
    now: () => state.now,
    emit: (event) => { events.push(event) },
  }
  return { repo, box, calls, events, requests, released, state, engine: new Engine(options) }
}

/** 断言抛出的是指定 code 的 UserError；不是就原样抛出，别把失败吞成「没抛」。 */
function codeOf(work: () => unknown): string {
  try {
    work()
  } catch (error) {
    if (error instanceof UserError) return error.code
    throw error
  }
  throw new Error('期望抛出 UserError，实际没有抛')
}

// ── Intake：从入口收一条消息 ────────────────────────────────────────────────

describe('Engine.receive：去重、过滤、扇出、入队', () => {
  test('没有话题的 trigger 直接拒绝；同一条第二次是 duplicate', () => {
    const h = harness()
    expect(() => h.engine.receive(triggerOf('trig0', { threads: [] }))).toThrow('A trigger must belong to at least one thread')
    expect(h.engine.receive(triggerOf('trig1'))).toBe('stored')
    expect(h.engine.receive(triggerOf('trig1'))).toBe('duplicate')
  })

  test('来源没监听：只落库并记 filtered disposition，不入队', () => {
    const h = harness()
    const engine = new Engine({
      ...({
        repo: h.repo,
        policy: () => ({ version: 'v1', paused: false, gate: () => h.state.gateResult, revalidate: () => true,
          admitsInferred: () => true, evalTimeoutMs: 1_000 }),
        scope: { scope: () => ({ listened: false, reason: 'source_disabled' }) },
        assessor: { request: () => {} },
        executor: { start: () => {}, deliver: () => {}, stop: () => {} },
        outbox: h.box.outbox,
        now: () => h.state.now,
      } satisfies EngineOptions),
    })
    expect(engine.receive(triggerOf('trig1'))).toBe('filtered')
    expect(h.repo.triggers.get('trig1')).toBeTruthy()
    expect(h.repo.triggers.disposition('trig1')).toMatchObject({ filtered: { code: 'source_disabled' } })
    expect(h.repo.threads.get('feishu:x')).toBeUndefined()
  })

  test('订阅了该话题的活工单收到 Input 并进 undelivered；没人决定时同时入队等评估', () => {
    const h = harness()
    h.repo.threads.save(threadOf(threadRef(), { subscriptions: ['tk1'] }))
    h.repo.tickets.save(ticketOf())
    expect(h.engine.receive(triggerOf('trig1'))).toBe('stored')
    const ticket = h.repo.tickets.get('tk1')!
    expect(ticket.inputs.map((input) => input.id)).toEqual([key('input', 'tk1', 'trigger', 'trig1')])
    expect(ticket.undelivered).toEqual([key('input', 'tk1', 'trigger', 'trig1')])
    expect(h.repo.triggers.disposition('trig1')).toMatchObject({ fanout: ['tk1'] })
    expect(h.events.map((event) => event.type)).toContain('trigger.received')
  })

  test('没订阅者时把 trigger 排进该话题的待评估队列', () => {
    const h = harness()
    h.repo.threads.save(threadOf(threadRef()))
    h.engine.receive(triggerOf('trig1'))
    expect(h.repo.threads.get('feishu:x')!.pending).toEqual(['trig1'])
  })
})

// ── 话题：绑定与关闭 ────────────────────────────────────────────────────────

describe('Engine.bindThread / threadClosed', () => {
  test('bindThread 在事务里落订阅；threadClosed 归一化时间戳后结束工单', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf())
    const bound = h.engine.bindThread('tk1', threadRef('pr'), true)
    expect(bound.follows).toEqual([{ thread: 'feishu:pr', own: true }])
    expect(h.repo.threads.get('feishu:pr')!.subscriptions).toContain('tk1')

    // GitHub 只给到整秒，入口要归一成 ISO 毫秒形式。
    h.engine.threadClosed(threadRef('pr'), 'merged', '2026-01-01T00:00:00Z')
    expect(h.repo.tickets.get('tk1')!.ended).toEqual({ at: NOW, by: 'executor', outcome: 'merged' })
  })

  test('bindThread 对未知工单抛 unknownTicket', () => {
    const h = harness()
    expect(codeOf(() => h.engine.bindThread('ghost', threadRef(), false))).toBe('unknownTicket')
  })
})

// ── 时钟：evaluateDue 三个分支 ──────────────────────────────────────────────

describe('Engine.evaluateDue：过期、暂停顺延、开新评估', () => {
  test('已送达且过期的评估：回队（expired+1）、让判定器释放，同一轮再开新评估', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.threads.save(threadOf(threadRef(), {
      evaluating: evaluatingOf({ delivered: NOW, deadline: '2025-12-31T23:00:00.000Z' }),
    }))
    h.engine.evaluateDue()
    const thread = h.repo.threads.get('feishu:x')!
    // 回队后同一轮 evaluateDue 又把它开成新评估，所以 pending 已被新评估吃掉。
    expect(thread.expired).toBe(1)
    expect(h.released).toEqual(['eval-1'])
    expect(thread.evaluating).toBeDefined()
    expect(thread.evaluating!.id).not.toBe('eval-1')
    expect(h.requests).toHaveLength(1)
  })

  test('暂停时只记暂停起点，不顺延也不判过期', () => {
    const h = harness()
    h.state.paused = true
    h.repo.threads.save(threadOf(threadRef(), {
      evaluating: evaluatingOf({ delivered: NOW, deadline: '2025-12-31T23:00:00.000Z' }),
    }))
    h.engine.evaluateDue()
    expect(h.repo.threads.get('feishu:x')!.evaluating!.pausedAt).toBe(NOW)
  })

  test('暂停结束后按暂停时长顺延截止时刻', () => {
    const h = harness()
    h.repo.threads.save(threadOf(threadRef(), {
      evaluating: evaluatingOf({ delivered: NOW, deadline: '2026-01-01T00:00:10.000Z', pausedAt: '2025-12-31T23:59:50.000Z' }),
    }))
    h.engine.evaluateDue()
    const evaluation = h.repo.threads.get('feishu:x')!.evaluating!
    expect(evaluation.pausedAt).toBeUndefined()
    expect(evaluation.deadline).toBe('2026-01-01T00:00:20.000Z')
  })

  test('有待评估消息且没有在跑的评估：开评估并向判定器要候选', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.threads.save(threadOf(threadRef(), { pending: ['trig1'] }))
    h.engine.evaluateDue()
    expect(h.repo.threads.get('feishu:x')!.evaluating).toBeTruthy()
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]!.triggers.map((trigger) => trigger.id)).toEqual(['trig1'])
  })

  test('结束工单还欠着人的消息：处理没暂停时被唤醒（重开并派新分配）', () => {
    const h = harness()
    const input = inputOf('tk1', 'trig-human', { human: true })
    h.repo.triggers.save(triggerOf('trig-human'))
    h.repo.tickets.save(ticketOf({
      ended: { at: NOW, by: 'executor', outcome: 'completed' },
      inputs: [input],
      undelivered: [input.id],
    }))
    h.engine.evaluateDue()
    expect(h.repo.tickets.get('tk1')!.ended).toBeUndefined()
    expect(h.calls.start.map((ticket) => ticket.id)).toEqual(['tk1'])
  })
})

// ── 主会话：候选与判定 ──────────────────────────────────────────────────────

describe('Engine.candidate / decide', () => {
  test('candidate 只在评估持有该 trigger 时给出候选', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.threads.save(threadOf(threadRef(), { evaluating: evaluatingOf() }))
    expect(h.engine.candidate('trig1')!.evalId).toBe('eval-1')
    expect(h.engine.candidate('other')).toBeUndefined()
  })

  test('decide accept：直接评估建出工单并派工，事件里有 ticket.created', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.threads.save(threadOf(threadRef()))
    const decision: Decision = h.engine.decide('trig1', { kind: 'accept', title: '标题', scope: 'chat', reason: '要做' })
    expect(decision.kind).toBe('accept')
    expect(decision.ticketId).toBeTruthy()
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ title: '标题' })
    expect(h.calls.start).toHaveLength(1)
    expect(h.events.map((event) => event.type)).toContain('ticket.created')
  })

  test('decide 对未知 trigger 抛 unknownTrigger', () => {
    const h = harness()
    expect(codeOf(() => h.engine.decide('ghost', { kind: 'ignore', reason: 'x' }))).toBe('unknownTrigger')
  })
})

// ── 路由：attach ────────────────────────────────────────────────────────────

describe('Engine.attach', () => {
  test('把消息挂到工单：补 Input、记 routed、工单重新唤醒', () => {
    const h = harness()
    const trigger = triggerOf('trig9', { threads: [threadRef('other')] })
    h.repo.triggers.save(trigger)
    h.repo.triggers.saveDisposition('trig9', { fanout: [], at: NOW, requeued: true })
    h.repo.tickets.save(ticketOf())
    const ticket = h.engine.attach('tk1', 'trig9', '这里是备注')
    expect(ticket.inputs.some((input) => input.kind === 'trigger' && input.triggerId === 'trig9')).toBe(true)
    expect(h.repo.threads.get('feishu:other')!.subscriptions).toContain('tk1')
  })

  test('worker 已经交回过的消息不能再挂给同一张工单', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig9'))
    h.repo.triggers.saveDisposition('trig9', { fanout: ['tk1'], handbacks: [{ ticketId: 'tk1', reason: 'x', at: NOW }], at: NOW })
    h.repo.tickets.save(ticketOf())
    expect(codeOf(() => h.engine.attach('tk1', 'trig9'))).toBe('handedBackHere')
  })
})

// ── 人：状态请求、回复、重评、清理问题、取消订阅、停与重试 ──────────────────

describe('Engine.requestStatus / reply', () => {
  test('requestStatus 只问 waiting 的工人，未知工单抛错', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({
      assignments: [{ id: 'a1', state: 'running', createdAt: NOW, report: { state: 'waiting', summary: '等人', at: NOW } }],
    }))
    expect(h.engine.requestStatus('tk1')).toBe(true)
    expect(codeOf(() => h.engine.requestStatus('ghost'))).toBe('unknownTicket')
  })

  test('acknowledgement：入队确认、记下已接手，同一 id 第二次 reused', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.triggers.saveDisposition('trig1', { fanout: [], at: NOW })
    h.repo.tickets.save(ticketOf())
    const first = h.engine.reply({ purpose: 'acknowledgement', ticketId: 'tk1', triggerId: 'trig1', text: '收到' })
    expect(first).toEqual({ id: key('ack', 'trig1'), status: 'pending', reused: false })
    expect(h.box.sent).toEqual([{ id: key('ack', 'trig1'), channel: CHANNEL, text: '收到', kind: 'acknowledgement', ticketId: 'tk1' }])
    expect(h.repo.triggers.disposition('trig1')!.acked).toEqual(['tk1'])
    expect(h.engine.reply({ purpose: 'acknowledgement', ticketId: 'tk1', triggerId: 'trig1', text: '再说一遍' }).reused).toBe(true)
  })

  test('result：未就绪的工单拒绝，已完成工单把结果发回起始会话', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.tickets.save(ticketOf())
    expect(codeOf(() => h.engine.reply({ purpose: 'result', ticketId: 'tk1', text: '做完了' }))).toBe('notReady')

    h.repo.tickets.save(ticketOf({ id: 'done', ended: { at: NOW, by: 'executor', outcome: 'completed' } }))
    const reply = h.engine.reply({ purpose: 'result', ticketId: 'done', text: '做完了' })
    expect(reply.status).toBe('pending')
    expect(h.box.sent.at(-1)).toMatchObject({ channel: CHANNEL, kind: 'reply', ticketId: 'done', text: '做完了' })
  })

  test('attention：问题文本对不上就拒，对上了发到问问题那条消息的会话', () => {
    const h = harness()
    const asker = triggerOf('asker', { channel: { ...CHANNEL, thread: 'feishu:oc_ask' } })
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.triggers.save(asker)
    h.repo.tickets.save(ticketOf({
      attention: { id: key('attention', 'tk1', '要哪个方案', NOW), question: '要哪个方案', triggerId: 'asker' },
    }))
    expect(codeOf(() => h.engine.reply({ purpose: 'attention', ticketId: 'tk1', question: '别的问题', text: 'x' }))).toBe('notAttention')
    const reply = h.engine.reply({ purpose: 'attention', ticketId: 'tk1', question: '要哪个方案', text: '用 A' })
    expect(h.box.sent.at(-1)).toMatchObject({ text: '用 A', channel: asker.channel })
    expect(reply.id).toBe(key('attention-reply', key('attention', 'tk1', '要哪个方案', NOW)))
  })
})

describe('Engine 的人侧动作', () => {
  test('reevaluate 与 dismiss：未知的各自报错，正常的改状态', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.threads.save(threadOf(threadRef()))
    expect(h.engine.reevaluate('trig1')).toBe(true)
    expect(codeOf(() => h.engine.reevaluate('ghost'))).toBe('unknownTrigger')

    h.repo.decisions.save({
      id: 'dec-bad', evalId: 'e', threadKey: 'feishu:x', triggerIds: ['trig1'], policyVersion: 'v1',
      at: NOW, kind: 'unavailable', reason: [], strength: 'explicit',
    })
    expect(h.engine.dismiss('dec-bad').dismissed).toBe(true)
    expect(codeOf(() => h.engine.dismiss('ghost'))).toBe('unknownProblem')
  })

  test('unsubscribe 退掉话题的全部订阅；没有订阅时返回 false', () => {
    const h = harness()
    h.repo.threads.save(threadOf(threadRef(), { subscriptions: ['tk1'] }))
    h.repo.tickets.save(ticketOf())
    expect(h.engine.unsubscribe('feishu:x')).toBe(true)
    expect(h.engine.unsubscribe('feishu:x')).toBe(false)
  })

  test('stopTicket 结束工单并停止分配；retryTicket 给失败工单派新分配', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({
      assignments: [{ id: 'a1', state: 'running', createdAt: NOW, report: { state: 'failed', summary: '挂了', at: NOW } }],
    }))
    const retried = h.engine.retryTicket('tk1')
    expect(retried.assignments.map((assignment) => assignment.state)).toEqual(['ended', 'pending'])
    expect(h.calls.stop.map((call) => call.reason)).toEqual(['retried'])

    h.repo.tickets.save(ticketOf({ id: 't2' }))
    expect(h.engine.stopTicket('t2', '人叫停').ended).toMatchObject({ by: 'human', outcome: 'stopped' })
    expect(codeOf(() => h.engine.stopTicket('ghost'))).toBe('unknownTicket')
  })

  test('note / followForContext / markUnrelated 的入口各走通一次', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.tickets.save(ticketOf())
    const noted = h.engine.note('tk1', '人留了一句话')
    expect(noted.inputs.at(-1)).toMatchObject({ kind: 'note', text: '人留了一句话' })

    expect(h.engine.followForContext('tk1', threadRef('ctx'))).toBe(true)
    expect(h.engine.followForContext('tk1', threadRef('ctx'))).toBe(false)

    h.repo.threads.save(threadOf(threadRef('ctx'), { subscriptions: ['tk1'] }))
    h.repo.tickets.save(ticketOf({ inputs: [inputOf('tk1', 'trig1')] }))
    h.engine.markUnrelated('tk1', 'feishu:ctx', '不相关')
    expect(h.repo.threads.get('feishu:ctx')!.subscriptions).toEqual([])
  })
})

// ── 执行器回调：分配的生命周期与报告 ────────────────────────────────────────

describe('Engine 的执行器回调', () => {
  test('assignmentStarted / inputsDelivered / inputsRead / turnEnded / deliveryFailed 落库', () => {
    const h = harness()
    const input = inputOf('tk1', 'trig1')
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.tickets.save(ticketOf({ inputs: [input], undelivered: [input.id] }))

    h.engine.assignmentStarted('tk1', 'a0')
    expect(h.repo.tickets.get('tk1')!.assignments[0]).toMatchObject({ state: 'running', startedAt: NOW })

    h.engine.inputsDelivered('tk1', 'a0', [input.id])
    expect(h.repo.tickets.get('tk1')!.undelivered).toEqual([])

    h.engine.inputsRead('tk1', [input.id])
    expect((h.repo.tickets.get('tk1')!.inputs[0] as TriggerInput).readAt).toBe(NOW)

    h.state.now = LATER
    h.engine.turnEnded('tk1', 'a0')
    expect(h.repo.tickets.get('tk1')!.assignments[0]!.idleAt).toBe(LATER)

    h.engine.deliveryFailed('tk1', 'a0', 'x'.repeat(400))
    expect(h.repo.tickets.get('tk1')!.delivery!.error).toHaveLength(300)
  })

  test('report：ready 结束工单；blocked 留下注意力问题并撤回旧的待发回复', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.tickets.save(ticketOf({
      attention: { id: key('attention', 'tk1', '旧问题', NOW), question: '旧问题', triggerId: 'trig1' },
      assignments: [{ id: 'a1', state: 'running', createdAt: NOW }],
    }))
    // blocked 提问：新的 attention 顶掉旧的，旧回复被撤销。
    const first = h.engine.report('tk1', { state: 'blocked', summary: '卡住了', question: '要哪个方案', askedBy: 'trig1' })
    expect(first.attention!.question).toBe('要哪个方案')
    expect(h.box.withdrawn).toContain(key('attention-reply', key('attention', 'tk1', '旧问题', NOW)))

    // ready 结束工单，注意力问题清掉。
    const ready = h.engine.report('tk1', { state: 'ready', summary: '做完了' })
    expect(ready.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
    expect(ready.attention).toBeUndefined()
  })

  test('report 的拒绝面：未知工单、已结束工单、问题配结果', () => {
    const h = harness()
    expect(codeOf(() => h.engine.report('ghost', { state: 'progress', summary: 'x' }))).toBe('unknownTicket')
    h.repo.tickets.save(ticketOf({ ended: { at: NOW, by: 'human', outcome: 'stopped' } }))
    expect(codeOf(() => h.engine.report('tk1', { state: 'progress', summary: 'x' }))).toBe('ticketEnded')

    h.repo.tickets.save(ticketOf())
    expect(codeOf(() => h.engine.report('tk1', { state: 'ready', summary: 'x', question: '?' }))).toBe('questionWithResult')
  })

  test('assignmentInterrupted：还没说定就带恢复说明重启，已说定就把等着的消息投出去', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({
      assignments: [{ id: 'a1', state: 'running', createdAt: NOW, report: { state: 'progress', summary: '在做', at: NOW } }],
    }))
    h.engine.assignmentInterrupted('tk1', 'a1')
    const restarted = h.repo.tickets.get('tk1')!
    expect(restarted.assignments.map((assignment) => assignment.state)).toEqual(['ended', 'pending'])
    expect(restarted.assignments[0]!.endedReason).toBe('hostRestarted')
    expect(h.calls.start.map((ticket) => ticket.id)).toEqual(['tk1'])

    h.repo.tickets.save(ticketOf({
      id: 'settled',
      inputs: [inputOf('settled', 'trig-s')],
      undelivered: [inputOf('settled', 'trig-s').id],
      assignments: [{ id: 'b1', state: 'running', createdAt: NOW, report: { state: 'waiting', summary: '等', at: NOW } }],
    }))
    h.engine.assignmentInterrupted('settled', 'b1')
    expect(h.calls.deliver.map((ticket) => ticket.id)).toEqual(['settled'])
  })

  test('policyChanged 与 handback 从入口走通', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW })
    h.repo.tickets.save(ticketOf({ inputs: [inputOf('tk1', 'trig1')] }))
    h.engine.policyChanged('v1', 'v2')
    expect(h.events.map((event) => event.type)).toContain('policy.changed')
    expect(h.engine.handback('tk1', 'trig1', '不是这张工单的事')).toBe(true)
  })
})
