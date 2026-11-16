/**
 * 第 11 轮补盲：只挑现有 23 份 spec 没走到的分支与错误路径。
 *
 * 覆盖面（按缺口排序）：
 *   - `core/assignments.ts`：started / delivered / read / turnEnded / deliveryFailed /
 *     interrupted / report 的每一条守卫、默认值与状态机边界；
 *   - `adapters/feishu/loops.ts`：坏游标、已投递名单、话题视野裁剪、长连接超时 / 崩溃 /
 *     同步抛错、补收循环的异常出口；
 *   - `core/engine.ts`、`core/intake.ts`、`core/memory.ts`、`core/reasons.ts`、
 *     `core/stage.ts`、`core/model.ts` 的残部；
 *   - `service.ts`、`adapters/assessor.ts`、`adapters/notify.ts` 的默认分支；
 *   - `commands.ts` 的解析 / 前缀匹配 / 输出渲染；
 *   - `adapters/store.ts` 与 `adapters/outbox.ts` 的坏行与幂等边界。
 *
 * 全部离线：假仓库 / 假执行器 / 假 CLI / 假 kv，不碰真实 `~/.dsc`。
 *
 * @module @pneuma/superagent/tests/w11-branches
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { Assignments } from '../core/assignments.js'
import { Engine } from '../core/engine.js'
import { UserError } from '../core/errors.js'
import { key } from '../core/ids.js'
import { Intake } from '../core/intake.js'
import { MemoryRepositories } from '../core/memory.js'
import {
  latestAssignment, latestReport, liveTicket, reached, ticketOutcome,
  type Assignment, type ChannelRef, type Decision, type Evaluation, type Mandate,
  type Thread, type Ticket, type TicketInput, type Trigger, type TriggerDisposition,
} from '../core/model.js'
import type { EngineOptions } from '../core/part.js'
import type { Candidate, DomainEvent, GateResult, Outbox, Policy, ReplyStatus } from '../core/ports.js'
import { reasonText } from '../core/reasons.js'
import { Replies } from '../core/replies.js'
import { canRetry, ticketStage } from '../core/stage.js'
import { Tickets } from '../core/tickets.js'
import { ManualAssessor } from '../adapters/assessor.js'
import { ModelAssessor } from '../adapters/assessor-model.js'
import { defaultSettings } from '../adapters/settings.js'
import { OutboxDispatcher } from '../adapters/dispatch.js'
import { createFeishuSource, cursorAt, consumerRetry, FeishuKv, FEISHU_KEYS } from '../adapters/feishu/loops.js'
import type { CliConsume, CliResult, CliRun } from '../adapters/feishu/cli.js'
import type { FeishuThread } from '../adapters/feishu/loops.js'
import { feishuTriggerId } from '../adapters/feishu/trigger.js'
import { parseSaCommand, registerCommands, resolveTicket } from '../commands.js'
import type { TicketView } from '../runtime.js'

// 必须在动态 import 任何读 DSC_HOME 的模块之前设好；静态 import 不能放在这里。
const HOME = mkdtempSync(join(tmpdir(), 'superagent-w11-'))
const PREVIOUS_HOME = process.env['DSC_HOME']
process.env['DSC_HOME'] = HOME

const { openStore, decodeTicketValue } = await import('../adapters/store.js')
const { StoreOutbox } = await import('../adapters/outbox.js')
const { SuperagentService } = await import('../service.js')
const { StoreNotifier } = await import('../adapters/notify.js')
const { SuperagentRuntime } = await import('../runtime.js')
const { StoreRepositories } = await import('../adapters/repositories.js')

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true })
  if (PREVIOUS_HOME === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = PREVIOUS_HOME
})

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

const threadRef = (id = 'x') => ({ source: 'feishu', id })

function threadOf(id = 'x', overrides: Partial<Thread> = {}): Thread {
  return {
    key: `feishu:${id}`,
    ref: threadRef(id),
    createdAt: NOW,
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: {},
    ...overrides,
  }
}

function triggerOf(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id,
    source: 'feishu',
    threads: [threadRef()],
    actor: { source: 'feishu', id: 'ou_1' },
    human: true,
    at: NOW,
    text: '改一下登录页',
    channel: CHANNEL,
    meta: {},
    ...overrides,
  }
}

function assignmentOf(id = 'a0', overrides: Partial<Assignment> = {}): Assignment {
  return { id, state: 'running', createdAt: NOW, ...overrides }
}

function ticketOf(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'tk1',
    title: '改登录页',
    decisionId: 'dec1',
    mandate: mandateOf(),
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

function triggerInput(id: string, overrides: Partial<Extract<TicketInput, { kind: 'trigger' }>> = {}): Extract<TicketInput, { kind: 'trigger' }> {
  return { id, kind: 'trigger', triggerId: 'trig1', at: NOW, ...overrides }
}

function fakeOutbox(): { outbox: Outbox; sent: unknown[]; statuses: Map<string, ReplyStatus>; withdrawn: string[] } {
  const sent: unknown[] = []
  const statuses = new Map<string, ReplyStatus>()
  const withdrawn: string[] = []
  const outbox: Outbox = {
    send(message) {
      if (statuses.has(message.id)) return
      sent.push(message)
      statuses.set(message.id, 'pending')
    },
    status(id) { return statuses.get(id) },
    withdraw(id) {
      withdrawn.push(id)
      if (statuses.get(id) === 'pending') statuses.set(id, 'dropped')
    },
  }
  return { outbox, sent, statuses, withdrawn }
}

interface Calls {
  start: Array<{ ticketId: string; assignmentId: string }>
  deliver: Array<{ ticketId: string; assignmentId: string }>
  stop: Array<{ ticketId: string; assignmentId: string; reason: string }>
}

interface Harness {
  repo: MemoryRepositories
  calls: Calls
  events: DomainEvent[]
  requests: Candidate[]
  state: { now: string; paused: boolean; revalidate: boolean; gateResult: GateResult; admits: boolean; timeoutMs: number }
  options: EngineOptions
  replies: Replies
  tickets: Tickets
  assignments: Assignments
  intake: Intake
  engine: Engine
  box: ReturnType<typeof fakeOutbox>
}

/** 真仓库 + 真 Replies/Tickets/Assignments/Intake/Engine；执行器、判定器、出站队列是假的。 */
function harness(): Harness {
  const repo = new MemoryRepositories()
  const box = fakeOutbox()
  const calls: Calls = { start: [], deliver: [], stop: [] }
  const events: DomainEvent[] = []
  const requests: Candidate[] = []
  const state: Harness['state'] = {
    now: NOW,
    paused: false,
    revalidate: true,
    gateResult: { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } },
    admits: true,
    timeoutMs: 1_000,
  }
  const policy = (): Policy => ({
    version: 'v1',
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
    assessor: {
      request(candidate) { requests.push(candidate) },
      release() {},
    },
    executor: {
      start(ticket, assignment) { calls.start.push({ ticketId: ticket.id, assignmentId: assignment.id }) },
      deliver(ticket, assignment) { calls.deliver.push({ ticketId: ticket.id, assignmentId: assignment.id }) },
      stop(ticket, assignment, reason) { calls.stop.push({ ticketId: ticket.id, assignmentId: assignment.id, reason }) },
    },
    outbox: box.outbox,
    now: () => state.now,
    emit(event) { events.push(event) },
  }
  const replies = new Replies(options)
  const tickets = new Tickets(options, replies)
  const assignments = new Assignments(options, tickets, replies)
  const intake = new Intake(options, tickets)
  const engine = new Engine(options)
  return { repo, calls, events, requests, state, options, replies, tickets, assignments, intake, engine, box }
}

/** 断言抛出的是指定 code 的 UserError。 */
function codeOf(work: () => unknown): string {
  try {
    work()
  } catch (error) {
    if (error instanceof UserError) return error.code
    throw error
  }
  throw new Error('期望抛出 UserError，实际没有抛')
}

// ── core/assignments.ts ────────────────────────────────────────────────────

describe('Assignments.started：未知分配与已结束分配不动，其余入 running 并投递', () => {
  test('未知工单 / 未知分配 / 已结束分配都保持原样', () => {
    const h = harness()
    expect(codeOf(() => h.assignments.started('nope', 'a0'))).toBe('unknownTicket')
    h.repo.tickets.save(ticketOf())
    h.assignments.started('tk1', 'missing')
    expect(h.repo.tickets.get('tk1')!.assignments[0]!.state).toBe('running')
    h.repo.tickets.save(ticketOf({ assignments: [assignmentOf('a1', { state: 'ended' })] }))
    h.assignments.started('tk1', 'a1')
    expect(h.repo.tickets.get('tk1')!.assignments[0]!.state).toBe('ended')
    expect(h.events).toStrictEqual([])
  })

  test('开着的工单有未投递输入 → 派 executor.deliver 并 emit assignment.started', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({ assignments: [assignmentOf('a0', { state: 'pending' })], undelivered: ['in1'] }))
    h.assignments.started('tk1', 'a0')
    const ticket = h.repo.tickets.get('tk1')!
    expect(ticket.assignments[0]!.state).toBe('running')
    expect(ticket.assignments[0]!.startedAt).toBe(NOW)
    expect(h.calls.deliver).toStrictEqual([{ ticketId: 'tk1', assignmentId: 'a0' }])
    expect(h.events.at(-1)).toMatchObject({ type: 'assignment.started', data: { ticketId: 'tk1', assignmentId: 'a0' } })
  })

  test('已开始过的 startedAt 不覆盖；工单已结束则不投递', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({
      ended: { at: NOW, by: 'executor', outcome: 'completed' },
      assignments: [assignmentOf('a0', { startedAt: EARLIER })],
      undelivered: ['in1'],
    }))
    h.assignments.started('tk1', 'a0')
    expect(h.repo.tickets.get('tk1')!.assignments[0]!.startedAt).toBe(EARLIER)
    expect(h.calls.deliver).toStrictEqual([])
  })
})

describe('Assignments.delivered / read / turnEnded / deliveryFailed 的守卫', () => {
  test('delivered：未知工单抛错，分配不再 running 时什么也不写', () => {
    const h = harness()
    expect(codeOf(() => h.assignments.delivered('nope', 'a0', []))).toBe('unknownTicket')
    h.repo.tickets.save(ticketOf({ assignments: [assignmentOf('a0', { state: 'pending' })] }))
    h.assignments.delivered('tk1', 'a0', ['in1'])
    expect(h.repo.tickets.get('tk1')!.undelivered).toStrictEqual([])
  })

  test('delivered：清未投递、记 deliveredAt、trigger 输入写 readAt=null 与 deliveredTo、清 delivery', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({
      assignments: [assignmentOf()],
      inputs: [triggerInput('i1'), triggerInput('i2'), { id: 'n1', kind: 'note', text: 'x', at: NOW }],
      undelivered: ['i1', 'i2', 'n1', 'i3'],
      delivery: { error: '旧的失败', at: EARLIER },
    }))
    h.assignments.delivered('tk1', 'a0', ['i1', 'i2'])
    const ticket = h.repo.tickets.get('tk1')!
    expect(ticket.undelivered).toStrictEqual(['n1', 'i3'])
    expect(ticket.assignments[0]!.deliveredAt).toBe(NOW)
    expect(ticket.inputs[0]).toMatchObject({ readAt: null, deliveredTo: 'a0' })
    expect(ticket.inputs[1]).toMatchObject({ readAt: null, deliveredTo: 'a0' })
    expect(ticket.inputs[2]).not.toHaveProperty('readAt')
    expect(ticket.delivery).toBeUndefined()
  })

  test('read：已结束工单不动；trigger 输入首次读记时刻，已读不覆盖', () => {
    const h = harness()
    expect(codeOf(() => h.assignments.read('nope', []))).toBe('unknownTicket')
    h.repo.tickets.save(ticketOf({
      ended: { at: NOW, by: 'executor', outcome: 'completed' },
      inputs: [triggerInput('i1')],
    }))
    h.assignments.read('tk1', ['i1'])
    expect(h.repo.tickets.get('tk1')!.inputs[0]).not.toHaveProperty('readAt')

    h.repo.tickets.save(ticketOf({ inputs: [triggerInput('i1'), triggerInput('i2', { readAt: EARLIER })] }))
    h.state.now = LATER
    h.assignments.read('tk1', ['i1', 'i2'])
    const ticket = h.repo.tickets.get('tk1')!
    expect(ticket.inputs[0]).toMatchObject({ readAt: LATER })
    expect(ticket.inputs[1]).toMatchObject({ readAt: EARLIER })
  })

  test('turnEnded：running 才记 idleAt；deliveryFailed：running 才记并截断 300 字', () => {
    const h = harness()
    expect(codeOf(() => h.assignments.turnEnded('nope', 'a0'))).toBe('unknownTicket')
    h.repo.tickets.save(ticketOf({ assignments: [assignmentOf('a0', { state: 'pending' })] }))
    h.assignments.turnEnded('tk1', 'a0')
    expect(h.repo.tickets.get('tk1')!.assignments[0]!.idleAt).toBeUndefined()

    h.repo.tickets.save(ticketOf({ assignments: [assignmentOf()] }))
    h.assignments.turnEnded('tk1', 'a0')
    expect(h.repo.tickets.get('tk1')!.assignments[0]!.idleAt).toBe(NOW)

    h.state.now = LATER
    h.assignments.deliveryFailed('tk1', 'a0', 'x'.repeat(500))
    expect(h.repo.tickets.get('tk1')!.delivery).toEqual({ error: 'x'.repeat(300), at: LATER })
    h.repo.tickets.save(ticketOf({ assignments: [assignmentOf('a0', { state: 'ended' })] }))
    h.assignments.deliveryFailed('tk1', 'a0', 'ignored')
    expect(h.repo.tickets.get('tk1')!.delivery).toBeUndefined()
  })
})

describe('Assignments.interrupted：按最新报告决定接续还是重启', () => {
  test('没有报告 → restart：旧分配结束、新分配 pending、恢复提示入队、executor.start', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf())
    h.assignments.interrupted('tk1', 'a0')
    const ticket = h.repo.tickets.get('tk1')!
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.assignments[0]).toMatchObject({ state: 'ended', endedReason: 'hostRestarted' })
    expect(ticket.assignments[1]!.state).toBe('pending')
    expect(ticket.inputs.at(-1)).toMatchObject({ kind: 'text' })
    expect(h.calls.start).toStrictEqual([{ ticketId: 'tk1', assignmentId: ticket.assignments[1]!.id }])
    expect(h.events.some((event) => event.type === 'assignment.ended')).toBe(true)
  })

  test('waiting 且之后没有输入 → 保分配；有未投递就 deliver', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({
      assignments: [assignmentOf('a0', { report: { state: 'waiting', summary: '等消息', at: NOW } })],
      undelivered: ['i1'],
    }))
    h.assignments.interrupted('tk1', 'a0')
    expect(h.repo.tickets.get('tk1')!.assignments).toHaveLength(1)
    expect(h.calls.deliver).toStrictEqual([{ ticketId: 'tk1', assignmentId: 'a0' }])
  })

  test('waiting 且没有未投递 → 完全不动', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({
      assignments: [assignmentOf('a0', { report: { state: 'waiting', summary: '等消息', at: NOW } })],
    }))
    h.assignments.interrupted('tk1', 'a0')
    expect(h.repo.tickets.get('tk1')!.assignments).toHaveLength(1)
    expect(h.calls.deliver).toStrictEqual([])
  })

  test('progress 报告 → restart；waiting 但报告后又投递过（busy）→ restart', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({ assignments: [assignmentOf('a0', { report: { state: 'progress', summary: '干活', at: NOW } })] }))
    h.assignments.interrupted('tk1', 'a0')
    expect(h.repo.tickets.get('tk1')!.assignments).toHaveLength(2)

    const busy = harness()
    busy.repo.tickets.save(ticketOf({
      assignments: [assignmentOf('a0', {
        deliveredAt: LATER,
        report: { state: 'waiting', summary: '等消息', at: NOW },
      })],
    }))
    busy.assignments.interrupted('tk1', 'a0')
    expect(busy.repo.tickets.get('tk1')!.assignments).toHaveLength(2)
  })

  test('ready / blocked / failed 且不 busy 都算 settled；未知工单抛错', () => {
    for (const state of ['ready', 'blocked', 'failed'] as const) {
      const h = harness()
      h.repo.tickets.save(ticketOf({ assignments: [assignmentOf('a0', { report: { state, summary: 'x', at: NOW } })] }))
      h.assignments.interrupted('tk1', 'a0')
      expect(h.repo.tickets.get('tk1')!.assignments, state).toHaveLength(1)
    }
    expect(codeOf(() => harness().assignments.interrupted('nope', 'a0'))).toBe('unknownTicket')
  })
})

describe('Assignments.report：准入守卫', () => {
  test('未知 / 已结束工单', () => {
    const h = harness()
    expect(codeOf(() => h.assignments.report('nope', { state: 'progress', summary: '' }))).toBe('unknownTicket')
    h.repo.tickets.save(ticketOf({ ended: { at: NOW, by: 'executor', outcome: 'completed' } }))
    expect(codeOf(() => h.assignments.report('tk1', { state: 'progress', summary: '' }))).toBe('ticketEnded')
  })

  test('问题不能和 ready / answers 同时出现；askedBy 必须带问题', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf())
    expect(codeOf(() => h.assignments.report('tk1', { state: 'ready', summary: '', question: 'Q' }))).toBe('questionWithResult')
    expect(codeOf(() => h.assignments.report('tk1', { state: 'progress', summary: '', question: 'Q', answers: 'trig1' }))).toBe('questionWithResult')
    expect(codeOf(() => h.assignments.report('tk1', { state: 'progress', summary: '', askedBy: 'trig1' }))).toBe('askerWithoutQuestion')
  })

  test('asker 必须是真人、有通道、且消息到过工单', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf())
    expect(codeOf(() => h.assignments.report('tk1', { state: 'progress', summary: '', question: 'Q', askedBy: 'missing' }))).toBe('notAsker')

    h.repo.triggers.save(triggerOf('bot', { human: false }))
    expect(codeOf(() => h.assignments.report('tk1', { state: 'progress', summary: '', question: 'Q', askedBy: 'bot' }))).toBe('notAsker')

    h.repo.triggers.save(triggerOf('nochan', { channel: undefined }))
    expect(codeOf(() => h.assignments.report('tk1', { state: 'progress', summary: '', question: 'Q', askedBy: 'nochan' }))).toBe('notAsker')

    h.repo.triggers.save(triggerOf('far', { threads: [threadRef('other')] }))
    expect(codeOf(() => h.assignments.report('tk1', { state: 'progress', summary: '', question: 'Q', askedBy: 'far' }))).toBe('notAsker')
  })

  test('answer 必须是真人且消息到过工单', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf())
    h.repo.triggers.save(triggerOf('bot', { human: false }))
    expect(codeOf(() => h.assignments.report('tk1', { state: 'progress', summary: '', answers: 'bot' }))).toBe('notAnswerable')
    h.repo.triggers.save(triggerOf('far', { threads: [threadRef('other')] }))
    expect(codeOf(() => h.assignments.report('tk1', { state: 'progress', summary: '', answers: 'far' }))).toBe('notAnswerable')
  })

  test('没有分配 / 最新分配已结束', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({ assignments: [] }))
    expect(codeOf(() => h.assignments.report('tk1', { state: 'progress', summary: '' }))).toBe('unknownAssignment')
    h.repo.tickets.save(ticketOf({ assignments: [assignmentOf('a0', { state: 'ended' })] }))
    expect(codeOf(() => h.assignments.report('tk1', { state: 'progress', summary: '' }))).toBe('assignmentEnded')
  })
})

describe('Assignments.report：attention、answers 与结局', () => {
  test('新问题写成 attention；同一问题复用；换问题撤回旧回复', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.tickets.save(ticketOf({ assignments: [assignmentOf('a0', { state: 'pending' })] }))
    h.state.now = NOW
    const first = h.assignments.report('tk1', { state: 'progress', summary: '问一下', question: 'Q1', askedBy: 'trig1' })
    const attention = first.attention!
    expect(attention.question).toBe('Q1')
    expect(attention.triggerId).toBe('trig1')

    h.state.now = LATER
    const same = h.assignments.report('tk1', { state: 'progress', summary: '还在问', question: 'Q1' })
    expect(same.attention!.id).toBe(attention.id)
    expect(h.box.withdrawn).toStrictEqual([])

    const replaced = h.assignments.report('tk1', { state: 'progress', summary: '换问题', question: 'Q2' })
    expect(replaced.attention!.question).toBe('Q2')
    expect(replaced.attention!.id).not.toBe(attention.id)
    expect(h.box.withdrawn).toStrictEqual([key('attention-reply', attention.id)])
  })

  test('question: null 清掉 attention 并撤回；ready 也清掉并撤回', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.tickets.save(ticketOf({ assignments: [assignmentOf('a0')] }))
    const opened = h.assignments.report('tk1', { state: 'progress', summary: '', question: 'Q', askedBy: 'trig1' })
    const id = opened.attention!.id
    const cleared = h.assignments.report('tk1', { state: 'progress', summary: '', question: null })
    expect(cleared.attention).toBeUndefined()
    expect(h.box.withdrawn).toStrictEqual([key('attention-reply', id)])

    const openedAgain = h.assignments.report('tk1', { state: 'progress', summary: '', question: 'Q2', askedBy: 'trig1' })
    const second = openedAgain.attention!.id
    const ready = h.assignments.report('tk1', { state: 'ready', summary: '好了' })
    expect(ready.ended?.outcome).toBe('completed')
    expect(ready.attention).toBeUndefined()
    expect(h.box.withdrawn).toContain(key('attention-reply', second))
  })

  test('answers 去重并 takeUp；blocked/failed 只扣下自动输入', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.triggers.saveDisposition('trig1', { fanout: ['tk1'], at: NOW })
    h.repo.tickets.save(ticketOf({
      answers: ['trig1'],
      inputs: [
        triggerInput('human', { human: true }),
        triggerInput('bot'),
        { id: 'note', kind: 'note', text: 'x', at: NOW },
      ],
      undelivered: ['human', 'bot', 'note'],
    }))
    const ticket = h.assignments.report('tk1', { state: 'blocked', summary: '卡住', answers: 'trig1' })
    expect(ticket.answers).toStrictEqual(['trig1'])
    expect(ticket.undelivered).toStrictEqual(['human'])
    expect(h.repo.triggers.disposition('trig1')!.acked).toStrictEqual(['tk1'])
  })

  test('dropped：有 followsDone 用它，否则 dropped；ready：无 follows 即 completed', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({
      follows: [{ thread: 'feishu:pr', own: true, closed: { at: NOW, outcome: 'merged' } }],
    }))
    const dropped = h.assignments.report('tk1', { state: 'dropped', summary: '没活了' })
    expect(dropped.ended).toMatchObject({ by: 'executor', outcome: 'merged' })

    const plain = harness()
    plain.repo.tickets.save(ticketOf())
    expect(plain.assignments.report('tk1', { state: 'dropped', summary: '没活了' }).ended?.outcome).toBe('dropped')

    const ready = harness()
    ready.repo.tickets.save(ticketOf())
    expect(ready.assignments.report('tk1', { state: 'ready', summary: '好了' }).ended?.outcome).toBe('completed')
  })

  test('ready 跟的 Thread 没全关 → 不结束；全关 → 用 closed 的结局', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf({
      follows: [{ thread: 'feishu:pr', own: true }],
    }))
    const open = h.assignments.report('tk1', { state: 'ready', summary: '好了' })
    expect(open.ended).toBeUndefined()

    const closed = harness()
    closed.repo.tickets.save(ticketOf({
      follows: [{ thread: 'feishu:pr', own: true, closed: { at: NOW, outcome: 'closed' } }],
    }))
    expect(closed.assignments.report('tk1', { state: 'ready', summary: '好了' }).ended?.outcome).toBe('closed')
  })

  test('progress / waiting 不结束工单；问题与答案不带 askedBy 也能记', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf())
    expect(h.assignments.report('tk1', { state: 'progress', summary: '' }).ended).toBeUndefined()
    expect(h.assignments.report('tk1', { state: 'waiting', summary: '' }).ended).toBeUndefined()
    const asked = h.assignments.report('tk1', { state: 'progress', summary: '', question: 'Q' })
    expect(asked.attention).toMatchObject({ question: 'Q' })
    expect(asked.attention!.triggerId).toBeUndefined()
  })
})

// ── core/model.ts / memory.ts / reasons.ts / stage.ts ─────────────────────

describe('model 残部：reached 的 input-only 分支', () => {
  test('只有 trigger 输入、没有订阅时，context 参数决定是否算到达', () => {
    const ticket = ticketOf({ inputs: [triggerInput('i1', { triggerId: 'other' })], origin: { triggerId: 'origin', triggerIds: ['origin'] } })
    const trigger = triggerOf('other', { threads: [threadRef('x')] })
    expect(reached(ticket, trigger, () => undefined)).toBe(true)
    expect(reached(ticket, trigger, () => threadOf('x'), false)).toBe(true)
    const contextOnly = ticketOf({
      inputs: [triggerInput('i1', { triggerId: 'other', context: true })],
      origin: { triggerId: 'origin', triggerIds: ['origin'] },
    })
    expect(reached(contextOnly, trigger, () => threadOf('x', { context: ['tk1'] }), false)).toBe(false)
  })

  test('latestReport / latestAssignment / liveTicket / ticketOutcome 的空值', () => {
    expect(latestAssignment(ticketOf({ assignments: [] }))).toBeUndefined()
    expect(latestReport(ticketOf({ assignments: [] }))).toBeUndefined()
    expect(liveTicket(ticketOf())).toBe(true)
    expect(ticketOutcome(ticketOf())).toBeUndefined()
  })
})

describe('MemoryRepositories：快照回滚与 active 过滤', () => {
  test('atomic 抛错时把五张表都恢复', () => {
    const repo = new MemoryRepositories()
    repo.triggers.save(triggerOf('old'))
    expect(() => repo.atomic(() => {
      repo.triggers.save(triggerOf('new'))
      repo.tickets.save(ticketOf())
      throw new Error('rollback')
    })).toThrow('rollback')
    expect(repo.triggers.get('new')).toBeUndefined()
    expect(repo.tickets.get('tk1')).toBeUndefined()
    expect(repo.triggers.get('old')).toBeDefined()
  })

  test('tickets.active 收未投递与 pending/running；threads.active 收 pending 或 evaluating', () => {
    const repo = new MemoryRepositories()
    repo.tickets.save(ticketOf({ id: 'u', undelivered: ['i'], assignments: [assignmentOf('a', { state: 'ended' })] }))
    repo.tickets.save(ticketOf({ id: 'p', assignments: [assignmentOf('a', { state: 'pending' })] }))
    repo.tickets.save(ticketOf({ id: 'r', assignments: [assignmentOf('a')] }))
    repo.tickets.save(ticketOf({ id: 'idle', assignments: [assignmentOf('a', { state: 'ended' })] }))
    expect(repo.tickets.active().map((ticket) => ticket.id).sort()).toStrictEqual(['p', 'r', 'u'])

    repo.threads.save(threadOf('p', { pending: ['t'] }))
    repo.threads.save(threadOf('e', { evaluating: { id: 'e', threadKey: 'feishu:e', triggerIds: [], strength: 'explicit', actor: { source: 's', id: 'i' }, basis: { via: 'followup' }, policyVersion: 'v1', startedAt: NOW, deadline: LATER } }))
    repo.threads.save(threadOf('idle'))
    expect(repo.threads.active().map((thread) => thread.key).sort()).toStrictEqual(['feishu:e', 'feishu:p'])
  })
})

describe('reasons / stage', () => {
  test('reasonText：单条、数组、未知 code、缺值、triggerId 前缀、undefined', () => {
    expect(reasonText(undefined)).toBe('')
    expect(reasonText({ code: 'timeout' })).toBe('Assessment timed out')
    expect(reasonText([{ code: 'timeout' }, { code: 'said', values: { text: '你好' }, triggerId: 't1' }]))
      .toBe('Assessment timed out; t1: 你好')
    expect(reasonText({ code: 'custom.code' })).toBe('custom.code')
    expect(reasonText({ code: 'startedTicket' })).toBe('Already started ticket {ticket}')
  })

  test('ticketStage：running 无报告 → working，ended 分配 → idle，delivery/attention 优先', () => {
    expect(ticketStage(ticketOf({ assignments: [assignmentOf()] }))).toStrictEqual({ stage: 'working' })
    expect(ticketStage(ticketOf({ assignments: [assignmentOf('a', { state: 'ended' })] }))).toStrictEqual({ stage: 'idle' })
    expect(ticketStage(ticketOf({ delivery: { error: 'x', at: NOW } }))).toStrictEqual({ stage: 'person', action: 'delivery' })
    expect(ticketStage(ticketOf({ attention: { id: 'at', question: 'Q' } }))).toStrictEqual({ stage: 'person', action: 'answer' })
    expect(canRetry(ticketOf({ delivery: { error: 'x', at: NOW } }))).toBe(true)
  })
})

// ── core/intake.ts ────────────────────────────────────────────────────────

describe('Intake：过滤、去重、订阅扇出与上下文标记', () => {
  test('空 threads 抛错；重复 trigger 返回 duplicate；未监听写 filtered disposition', () => {
    const h = harness()
    expect(() => h.intake.receive(triggerOf('t', { threads: [] }))).toThrow('at least one thread')
    h.repo.triggers.save(triggerOf('dup'))
    expect(h.intake.receive(triggerOf('dup'))).toBe('duplicate')

    h.options.scope = { scope: () => ({ listened: false, reason: 'nope' }) }
    expect(h.intake.receive(triggerOf('filtered'))).toBe('filtered')
    expect(h.repo.triggers.disposition('filtered')!.filtered).toStrictEqual({ code: 'nope' })
  })

  test('活工单收输入；人消息唤醒非人结束的工单；人停的工单不收；context 线程单独标记', () => {
    const h = harness()
    h.repo.threads.save(threadOf('x', { lastAt: LATER, subscriptions: ['live', 'ended', 'stopped', 'ctx'], context: ['ctx'] }))
    h.repo.tickets.save(ticketOf({ id: 'live', assignments: [assignmentOf()] }))
    h.repo.tickets.save(ticketOf({ id: 'ended', ended: { at: NOW, by: 'executor', outcome: 'completed' }, assignments: [assignmentOf('a', { state: 'ended' })] }))
    h.repo.tickets.save(ticketOf({ id: 'stopped', ended: { at: NOW, by: 'human', outcome: 'stopped' }, assignments: [assignmentOf('a', { state: 'ended' })] }))
    h.repo.tickets.save(ticketOf({ id: 'ctx', assignments: [assignmentOf()] }))
    expect(h.intake.receive(triggerOf('trig', { at: EARLIER, human: true }))).toBe('stored')
    const disposition = h.repo.triggers.disposition('trig')!
    expect(disposition.fanout).toStrictEqual(['live', 'ended', 'ctx'])
    expect(disposition.context).toStrictEqual(['ctx'])
    expect(h.repo.tickets.get('live')!.inputs[0]).toMatchObject({ triggerId: 'trig' })
    expect(h.repo.tickets.get('ctx')!.inputs[0]).toMatchObject({ context: true })
    expect(h.repo.tickets.get('stopped')!.inputs).toStrictEqual([])
    expect(h.repo.threads.get('feishu:x')!.lastAt, '旧时间不回写').toBe(LATER)
  })

  test('机器人消息不唤醒已结束工单', () => {
    const h = harness()
    h.repo.threads.save(threadOf('x', { subscriptions: ['ended'] }))
    h.repo.tickets.save(ticketOf({ id: 'ended', ended: { at: NOW, by: 'executor', outcome: 'completed' }, assignments: [assignmentOf('a', { state: 'ended' })] }))
    h.intake.receive(triggerOf('bot', { human: false }))
    expect(h.repo.tickets.get('ended')!.inputs).toStrictEqual([])
    expect(h.repo.triggers.disposition('bot')!.fanout).toStrictEqual([])
  })
})

// ── core/engine.ts ────────────────────────────────────────────────────────

describe('Engine：委派入口与错误路径', () => {
  test('evaluateDue 的三段：到期 Eval、暂停提前返回、待评估线程、待唤醒工单', () => {
    const h = harness()
    h.repo.threads.save(threadOf('due', {
      evaluating: { id: 'e', threadKey: 'feishu:due', triggerIds: [], strength: 'explicit', actor: { source: 's', id: 'i' }, basis: { via: 'followup' }, policyVersion: 'v1', startedAt: NOW, deadline: LATER },
    }))
    h.repo.threads.save(threadOf('pending', { pending: ['missing'] }))
    h.repo.tickets.save(ticketOf({ id: 'ended', ended: { at: NOW, by: 'executor', outcome: 'completed' }, undelivered: ['stale'], assignments: [assignmentOf('a', { state: 'ended' })] }))
    h.engine.evaluateDue()
    expect(h.repo.threads.get('feishu:pending')!.pending).toStrictEqual([])
    h.state.paused = true
    h.engine.evaluateDue()
  })

  test('同步委派：bindThread / threadClosed / candidate / unsubscribe / policyChanged', () => {
    const h = harness()
    h.repo.tickets.save(ticketOf())
    // 先按「只为上下文」挂在话题上：bind 之后必须把 context 标记摘掉。
    h.repo.threads.save(threadOf('x', { context: ['tk1'] }))
    expect(() => h.engine.bindThread('nope', threadRef(), false)).toThrow(UserError)
    expect(h.engine.bindThread('tk1', threadRef(), true)).toMatchObject({ id: 'tk1' })
    expect(h.repo.threads.get('feishu:x')!.context).toStrictEqual([])
    h.engine.threadClosed(threadRef(), 'merged', '2026-01-01 00:00:00')
    expect(h.engine.candidate('none')).toBeUndefined()
    expect(h.engine.unsubscribe('feishu:none')).toBe(false)
    h.engine.policyChanged('v1', 'v2')
  })

  test('Executor 回调与人员动作：未知 id 走各自 UserError', () => {
    const h = harness()
    expect(codeOf(() => h.engine.assignmentStarted('nope', 'a'))).toBe('unknownTicket')
    expect(codeOf(() => h.engine.inputsDelivered('nope', 'a', []))).toBe('unknownTicket')
    expect(codeOf(() => h.engine.inputsRead('nope', []))).toBe('unknownTicket')
    expect(codeOf(() => h.engine.turnEnded('nope', 'a'))).toBe('unknownTicket')
    expect(codeOf(() => h.engine.deliveryFailed('nope', 'a', 'x'))).toBe('unknownTicket')
    expect(codeOf(() => h.engine.assignmentInterrupted('nope', 'a'))).toBe('unknownTicket')
    expect(codeOf(() => h.engine.report('nope', { state: 'progress', summary: '' }))).toBe('unknownTicket')
    expect(codeOf(() => h.engine.stopTicket('nope'))).toBe('unknownTicket')
    expect(codeOf(() => h.engine.retryTicket('nope'))).toBe('unknownTicket')
    expect(codeOf(() => h.engine.note('nope', 'x'))).toBe('unknownTicket')
    expect(codeOf(() => h.engine.markUnrelated('nope', 'feishu:x', 'x'))).toBe('unknownTicket')
    expect(codeOf(() => h.engine.followForContext('nope', threadRef()))).toBe('unknownTicket')
    expect(codeOf(() => h.engine.handback('nope', 't', 'x'))).toBe('unknownTicket')
    expect(codeOf(() => h.engine.attach('nope', 't'))).toBe('unknownTrigger')
    expect(codeOf(() => h.engine.requestStatus('nope'))).toBe('unknownTicket')
    expect(codeOf(() => h.engine.decide('nope', { kind: 'ignore', reason: 'x' }))).toBe('unknownTrigger')
    expect(codeOf(() => h.engine.reevaluate('nope'))).toBe('unknownTrigger')
    expect(codeOf(() => h.engine.dismiss('nope'))).toBe('unknownProblem')
    expect(codeOf(() => h.engine.reply({ purpose: 'result', ticketId: 'nope', text: 'x' }))).toBe('unknownTicket')
    expect(() => h.engine.candidateDelivered('nope')).not.toThrow()
  })

  test('attach：handedBack 与正常附加', () => {
    const h = harness()
    h.repo.triggers.save(triggerOf('trig1'))
    h.repo.threads.save(threadOf('x'))
    h.repo.tickets.save(ticketOf({ assignments: [assignmentOf('a', { state: 'pending' })] }))
    h.repo.triggers.saveDisposition('trig1', { fanout: [], handbacks: [{ ticketId: 'tk1', reason: 'x', at: NOW }], at: NOW })
    expect(codeOf(() => h.engine.attach('tk1', 'trig1'))).toBe('handedBackHere')

    h.repo.triggers.saveDisposition('trig1', { fanout: [], at: NOW })
    expect(h.engine.attach('tk1', 'trig1', '备注')).toMatchObject({ id: 'tk1' })
    expect(h.repo.triggers.disposition('trig1')!.fanout).toContain('tk1')
  })
})

// ── adapters/feishu/loops.ts ──────────────────────────────────────────────

function fakeKv(): { rows: Map<string, string>; handle: import('../adapters/feishu/loops.js').FeishuKvHandle } {
  const rows = new Map<string, string>()
  return {
    rows,
    handle: {
      prepare(sql: string) {
        return {
          get(keyValue: unknown) {
            const value = rows.get(String(keyValue))
            return value === undefined ? undefined : { value }
          },
          run(...args: unknown[]) {
            const [first, second] = args
            if (sql.startsWith('DELETE')) rows.delete(String(first))
            else rows.set(String(first), String(second))
            return {}
          },
          all() { return [] },
        }
      },
    },
  }
}

const ok = (data: unknown): CliResult => ({ code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' })

function fakeRun(handler: (args: readonly string[]) => CliResult | Promise<CliResult>): { calls: string[][]; run: CliRun } {
  const calls: string[][] = []
  return {
    calls,
    run: async (args) => {
      calls.push([...args])
      return handler(args)
    },
  }
}

function fakeConsume(
  lines: Array<['stdout' | 'stderr', string]>,
  done: () => Promise<CliResult> = () => new Promise<CliResult>(() => {}),
): { consume: CliConsume } {
  return {
    consume: (_args, handlers) => {
      queueMicrotask(() => {
        for (const [stream, line] of lines) handlers[stream](line)
      })
      return { stop: () => {}, done: done() }
    },
  }
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let index = 0; index < 400; index += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const BOT = { id: 'ou_bot', appId: 'cli_app' }

function sourceOf(overrides: {
  kv: ReturnType<typeof fakeKv>
  run?: CliRun
  consume?: CliConsume
  config?: { chats: readonly { chatId: string }[]; directMessages: boolean; readPageSize?: number }
  threads?: { subscribed(source: string): FeishuThread[]; latest(key: string): Trigger | undefined; patch(key: string, meta: Record<string, unknown>): unknown }
  engine?: { receive(trigger: Trigger): unknown }
  now?: () => string
  backfillEveryMs?: number
  log?: (line: string) => void
}) {
  return createFeishuSource({
    run: overrides.run ?? fakeRun(() => ok({ items: [], has_more: false })).run,
    ...(overrides.consume === undefined ? {} : { consume: overrides.consume }),
    bot: BOT,
    engine: overrides.engine ?? { receive: () => 'stored' },
    store: { handle: overrides.kv.handle },
    config: overrides.config ?? { chats: [], directMessages: false },
    ...(overrides.threads === undefined ? {} : { threads: overrides.threads }),
    now: overrides.now ?? (() => NOW),
    log: overrides.log ?? (() => {}),
    ...(overrides.backfillEveryMs === undefined ? {} : { backfillEveryMs: overrides.backfillEveryMs }),
  })
}

describe('feishu/loops：FeishuKv 的坏数据与删除', () => {
  test('非 JSON 值返回 undefined；非对象行返回 undefined；set(undefined) 删除', () => {
    const kv = fakeKv()
    kv.rows.set('bad', '{not json')
    expect(new FeishuKv(kv.handle).get('bad')).toBeUndefined()
    kv.rows.set('null', 'null')
    expect(new FeishuKv(kv.handle).get('null')).toBeNull()
    const store = new FeishuKv(kv.handle)
    store.set('x', { a: 1 })
    expect(store.get('x')).toStrictEqual({ a: 1 })
    store.set('x', undefined)
    expect(store.get('x')).toBeUndefined()
  })

  test('cursorAt 回退 5 秒；consumerRetry 指数退避封顶 60 秒', () => {
    expect(cursorAt('2026-01-01T00:01:00.000Z')).toBe('2026-01-01T00:00:55.000Z')
    expect(consumerRetry(undefined, 1)).toBe(1000)
    expect(consumerRetry(1000, 59_999)).toBe(2000)
    expect(consumerRetry(40_000, 1)).toBe(60_000)
    expect(consumerRetry(5_000, 60_000)).toBe(1000)
  })
})

describe('feishu/loops：补收的话题视野与 followedThreads 兜底', () => {
  test('订阅话题按 meta.threadId / latest 兜底保留；静 14 天的非订阅话题被裁掉', async () => {
    const kv = fakeKv()
    kv.rows.set(FEISHU_KEYS.history('oc_chat'), JSON.stringify(NOW))
    kv.rows.set(FEISHU_KEYS.chats, JSON.stringify({ oc_dm: true }))
    kv.rows.set(FEISHU_KEYS.topics('oc_chat'), JSON.stringify({ omt_1: '2026-01-01T00:00:00.000Z', omt_old: '2020-01-01T00:00:00.000Z' }))
    const received: Trigger[] = []
    const threadA: FeishuThread = { key: 'feishu:oc_chat:om_root', ref: { source: 'feishu', id: 'oc_chat:om_root' }, createdAt: NOW, meta: { threadId: 123 } }
    const threadB: FeishuThread = { key: 'feishu:oc_chat:om_b', ref: { source: 'feishu', id: 'oc_chat:om_b' }, createdAt: NOW, meta: {} }
    const latest = (key: string): Trigger | undefined =>
      key === threadA.key ? triggerOf('t', { meta: { threadId: 'omt_1' } }) : triggerOf('t2', { meta: {} })
    const { run } = fakeRun((args) => {
      const params = JSON.parse(args[args.indexOf('--params') + 1]) as { container_id_type: string }
      if (params.container_id_type === 'chat') {
        return ok({ items: [{
          message_id: 'om_new', chat_id: 'oc_chat', thread_id: 'omt_1', create_time: String(Date.parse(NOW)),
          sender: { id: 'ou_alice', sender_type: 'user' }, body: { content: JSON.stringify({ text: '新消息' }) },
        }], has_more: false })
      }
      return ok({ items: [{
        message_id: 'om_reply', chat_id: 'oc_chat', thread_id: 'omt_1', create_time: String(Date.parse(NOW) + 1000),
        sender: { id: 'ou_alice', sender_type: 'user' }, body: { content: JSON.stringify({ text: '回复' }) },
      }], has_more: false })
    })
    const source = sourceOf({
      kv,
      run: run,
      config: { chats: [{ chatId: 'oc_chat' }], directMessages: true },
      threads: { subscribed: () => [threadA, threadB], latest, patch: () => undefined },
      engine: { receive(trigger) { received.push(trigger); return 'stored' } },
      now: () => '2026-09-10T00:00:00.000Z',
    })
    await source.tick()
    const topics = JSON.parse(kv.rows.get(FEISHU_KEYS.topics('oc_chat'))!) as Record<string, string>
    expect(topics.omt_1).toBe('2026-01-01T00:00:01.000Z')
    expect(topics.omt_old).toBeUndefined()
    expect(received.map((trigger) => trigger.id)).toStrictEqual([feishuTriggerId('om_new'), feishuTriggerId('om_reply')])
  })

  test('threadRef 优先用话题 meta；缺字段时退回最新 Trigger', async () => {
    const kv = fakeKv()
    kv.rows.set(FEISHU_KEYS.initialized('feishu:oc_chat:om_root'), JSON.stringify(true))
    const patches: Array<{ key: string; meta: Record<string, unknown> }> = []
    const thread: FeishuThread = { key: 'feishu:oc_chat:om_root', ref: { source: 'feishu', id: 'oc_chat:om_root' }, createdAt: NOW, meta: {} }
    const { run } = fakeRun((args) => {
      if (args[0] === 'api' && args[2] === '/open-apis/im/v1/messages/mget') {
        return ok({ items: [{ message_id: 'om_root', chat_id: 'oc_chat', thread_id: 'omt_1' }] })
      }
      if (args[0] === 'im' && args[1] === '+threads-messages-list') {
        return ok({
          thread_id: 'omt_1', has_more: false, messages: [{
            message_id: 'om_reply', chat_id: 'oc_chat', thread_id: 'omt_1', msg_type: 'text', content: '回复',
            sender: { id: 'ou_alice', sender_type: 'user' }, create_time: String(Date.parse(NOW) + 1000),
          }],
        })
      }
      throw new Error(`unexpected call ${args.slice(0, 3).join(' ')}`)
    })
    const received: Trigger[] = []
    const source = sourceOf({
      kv,
      run,
      threads: {
        subscribed: () => [thread],
        latest: () => triggerOf('src', { meta: { chatId: 'oc_chat', messageId: 'om_root' } }),
        patch(key, meta) { patches.push({ key, meta }) },
      },
      engine: { receive(trigger) { received.push(trigger); return 'stored' } },
    })
    await source.tick()
    expect(received.map((trigger) => trigger.id)).toStrictEqual([feishuTriggerId('om_reply')])
    expect(patches.some((entry) => entry.meta.threadId === 'omt_1')).toBe(true)
  })

  test('历史里混进别的群 / 游标原地打转都当失败，不假装读完', async () => {
    const outside = fakeKv()
    outside.rows.set(FEISHU_KEYS.history('oc_chat'), JSON.stringify(NOW))
    const outsideRun = fakeRun(() => ok({
      has_more: false,
      items: [{
        message_id: 'om_other', chat_id: 'oc_other', create_time: String(Date.parse(NOW)),
        sender: { id: 'ou_alice', sender_type: 'user' }, body: { content: '不是这个群的' },
      }],
    })).run
    const outsideSource = sourceOf({
      kv: outside,
      run: outsideRun,
      config: { chats: [{ chatId: 'oc_chat' }], directMessages: false },
    })
    await outsideSource.tick()
    expect(outsideSource.status().lastError).toContain('outside the requested chat')

    const stuck = fakeKv()
    stuck.rows.set(FEISHU_KEYS.history('oc_chat'), JSON.stringify(NOW))
    const stuckRun = fakeRun(() => ok({ items: [], has_more: true, page_token: 'p1' })).run
    const stuckSource = sourceOf({
      kv: stuck,
      run: stuckRun,
      config: { chats: [{ chatId: 'oc_chat' }], directMessages: false },
    })
    await stuckSource.tick()
    expect(stuckSource.status().lastError).toContain('pagination did not advance')
  })

  test('话题读失败记进 failures 并 patch pollError，不打断其它话题', async () => {
    const kv = fakeKv()
    const failed: FeishuThread = { key: 'feishu:oc_1:om_a', ref: { source: 'feishu', id: 'oc_1:om_a' }, createdAt: NOW, meta: {} }
    const good: FeishuThread = { key: 'feishu:oc_1:om_b', ref: { source: 'feishu', id: 'oc_1:om_b' }, createdAt: NOW, meta: { sourceTriggerId: 's', chatId: 'oc_1', messageId: 'om_b' } }
    kv.rows.set(FEISHU_KEYS.initialized(good.key), JSON.stringify(true))
    const patches: Array<{ key: string; meta: Record<string, unknown> }> = []
    const { run } = fakeRun((args) => {
      if (args[0] === 'api' && args[2] === '/open-apis/im/v1/messages/mget') return ok({ items: [{ message_id: 'om_b', chat_id: 'oc_1' }] })
      if (args[0] === 'im' && args[1] === '+threads-messages-list') return ok({ thread_id: 'omt_1', has_more: false, messages: [] })
      throw new Error('boom')
    })
    const source = sourceOf({
      kv,
      run,
      threads: { subscribed: () => [failed, good], latest: () => undefined, patch(key, meta) { patches.push({ key, meta }) } },
    })
    await source.tick()
    expect(source.status().lastError).toContain('feishu:oc_1:om_a')
    expect(patches.some((entry) => entry.key === failed.key && typeof entry.meta.pollError === 'string')).toBe(true)
    expect(patches.some((entry) => entry.key === good.key && entry.meta.pollError === undefined)).toBe(true)
  })
})

describe('feishu/loops：长连接的失败、超时与补收循环异常', () => {
  test('stdout 坏 JSON 只记错，长连接继续', async () => {
    const received: Trigger[] = []
    const consumer = fakeConsume([['stderr', '[event] ready'], ['stdout', 'not json']])
    const source = sourceOf({
      kv: fakeKv(),
      consume: consumer.consume,
      engine: { receive(trigger) { received.push(trigger); return 'stored' } },
    })
    source.start()
    try {
      await until(() => source.status().lastError !== null, 'the bad line to be recorded')
      expect(received).toStrictEqual([])
      expect(source.status().lastError).toMatch(/JSON/)
    } finally {
      source.stop()
    }
  })

  test('consume 同步抛错与 done reject 都变成 lastError', async () => {
    const thrown = sourceOf({
      kv: fakeKv(),
      consume: (() => { throw new Error('spawn failed') }) as CliConsume,
      backfillEveryMs: 1_000_000,
    })
    thrown.start()
    try {
      await until(() => (thrown.status().lastError ?? '').includes('spawn failed'), 'sync throw to be logged')
    } finally {
      thrown.stop()
    }

    const rejected = sourceOf({
      kv: fakeKv(),
      consume: () => ({ stop: () => {}, done: Promise.reject(new Error('consumer died')) }),
      backfillEveryMs: 1_000_000,
    })
    rejected.start()
    try {
      await until(() => (rejected.status().lastError ?? '').includes('consumer died'), 'rejected done to be logged')
    } finally {
      rejected.stop()
    }
  })

  test('超过 1 MiB 的事件直接丢，不让畸形事件吃满内存', async () => {
    const consumer = fakeConsume([['stderr', '[event] ready'], ['stdout', 'x'.repeat(1_048_577)]])
    const source = sourceOf({ kv: fakeKv(), consume: consumer.consume, backfillEveryMs: 1_000_000 })
    source.start()
    try {
      await until(() => (source.status().lastError ?? '').includes('1 MiB'), 'huge event to be rejected')
    } finally {
      source.stop()
    }
  })

  test('abort 后流自行结束：done 先回来也按正常收尾', async () => {
    let resolveDone: (value: CliResult) => void = () => {}
    const source = sourceOf({
      kv: fakeKv(),
      consume: () => ({
        stop: () => { resolveDone({ code: 0, stdout: '', stderr: '' }) },
        done: new Promise<CliResult>((resolve) => { resolveDone = resolve }),
      }),
      backfillEveryMs: 1_000_000,
    })
    source.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    source.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(source.status().lastError).toBeNull()
  })

  test('45 秒没 ready：定时器停掉当前流，避免半死不活', async () => {
    vi.useFakeTimers()
    try {
      let stops = 0
      const source = sourceOf({
        kv: fakeKv(),
        consume: (() => ({ stop: () => { stops += 1 }, done: new Promise<CliResult>(() => {}) })) as CliConsume,
        backfillEveryMs: 1_000_000,
      })
      source.start()
      await vi.advanceTimersByTimeAsync(45_000)
      expect(stops, '超时后必须主动停流').toBeGreaterThan(0)
      source.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  test('halted 后 done 才结束：按正常收尾，不记错误', async () => {
    let resolveDone: (value: CliResult) => void = () => {}
    const source = sourceOf({
      kv: fakeKv(),
      consume: () => ({ stop: () => {}, done: new Promise<CliResult>((resolve) => { resolveDone = resolve }) }),
      backfillEveryMs: 1_000_000,
    })
    source.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    source.stop()
    resolveDone({ code: 0, stdout: '', stderr: '' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(source.status().lastError).toBeNull()
  })

  test('补收 tick 抛错进 status().lastError，循环不退出', async () => {
    const source = sourceOf({
      kv: fakeKv(),
      now: () => { throw new Error('clock exploded') },
      backfillEveryMs: 5,
    })
    source.start()
    try {
      await until(() => (source.status().lastError ?? '').includes('clock exploded'), 'backfill failure to be logged')
    } finally {
      source.stop()
    }
  })

  test('stop 后再 start 会重新起；重复 start 不叠加；halted 时 tick 提前退出', async () => {
    const source = sourceOf({ kv: fakeKv(), backfillEveryMs: 5 })
    source.start()
    source.start()
    source.stop()
    expect(source.status().connected).toBe(false)
    source.start()
    source.stop()
  })
})

// ── adapters/assessor.ts / notify.ts / service.ts ────────────────────────

describe('ManualAssessor：队列去重、重新读候选与错误隔离', () => {
  test('无 trigger 的候选不入队；同一 Eval 只入一次；release 只丢指定 Eval；clear 全丢', () => {
    const assessor = new ManualAssessor()
    assessor.request({ evalId: 'e0', triggers: [], thread: threadOf(), strength: 'explicit', policyVersion: 'v1', tickets: [] })
    assessor.request({ evalId: 'e1', triggers: [triggerOf('t1')], thread: threadOf(), strength: 'explicit', policyVersion: 'v1', tickets: [] })
    assessor.request({ evalId: 'e1', triggers: [triggerOf('t1')], thread: threadOf(), strength: 'explicit', policyVersion: 'v1', tickets: [] })
    assessor.request({ evalId: 'e2', triggers: [triggerOf('t2')], thread: threadOf(), strength: 'inferred', policyVersion: 'v1', tickets: [] })
    const decisions: string[] = []
    const engine = {
      candidate: (triggerId: string) => triggerId === 't1'
        ? { evalId: 'stale', triggers: [], thread: threadOf(), strength: 'explicit' as const, policyVersion: 'v1', tickets: [] }
        : undefined,
      decide: () => { decisions.push('called'); return {} },
    }
    // `stale` 与入队的 evalId 对不上，应当跳过；e2 的候选读不到，也跳过。
    expect(assessor.drain(engine as never)).toStrictEqual([])
    expect(decisions).toStrictEqual([])

    assessor.request({ evalId: 'e3', triggers: [triggerOf('t3')], thread: threadOf(), strength: 'inferred', policyVersion: 'v1', tickets: [] })
    const ignored: Candidate[] = []
    const engine2 = {
      candidate: () => ({ evalId: 'e3', triggers: [triggerOf('t3')], thread: threadOf(), strength: 'inferred' as const, policyVersion: 'v1', tickets: [] }),
      decide: (_triggerId: string, outcome: unknown) => { ignored.push(outcome as Candidate); return {} },
    }
    assessor.drain(engine2 as never)
    expect(ignored).toHaveLength(1)

    assessor.release('e2')
    assessor.clear()
  })

  test('单条判定抛错走 onError；默认构造吞掉', () => {
    const seen: Array<{ evalId: string; message: string }> = []
    const assessor = new ManualAssessor((error, evalId) => {
      seen.push({ evalId, message: error instanceof Error ? error.message : String(error) })
    })
    assessor.request({ evalId: 'e1', triggers: [triggerOf('t1')], thread: threadOf(), strength: 'explicit', policyVersion: 'v1', tickets: [] })
    const engine = {
      candidate: () => ({ evalId: 'e1', triggers: [triggerOf('t1')], thread: threadOf(), strength: 'explicit' as const, policyVersion: 'v1', tickets: [] }),
      decide: () => { throw new Error('evalFinished') },
    }
    expect(assessor.drain(engine as never)).toStrictEqual([])
    expect(seen).toStrictEqual([{ evalId: 'e1', message: 'evalFinished' }])

    const silent = new ManualAssessor()
    silent.request({ evalId: 'e2', triggers: [triggerOf('t2')], thread: threadOf(), strength: 'explicit', policyVersion: 'v1', tickets: [] })
    expect(() => silent.drain(engine as never)).not.toThrow()
  })

  test('titleOf：meta.title 优先、空白回落正文第一行、全空给 Untitled', () => {
    const run = (trigger: Trigger): unknown => {
      const assessor = new ManualAssessor()
      assessor.request({ evalId: 'e', triggers: [trigger], thread: threadOf(), strength: 'explicit', policyVersion: 'v1', tickets: [] })
      let outcome: unknown
      assessor.drain({
        candidate: () => ({ evalId: 'e', triggers: [trigger], thread: threadOf(), strength: 'explicit' as const, policyVersion: 'v1', tickets: [] }),
        decide: (_id: string, value: unknown) => { outcome = value; return {} },
      } as never)
      return outcome
    }
    expect(run(triggerOf('t', { meta: { title: '  标题  ' } }))).toMatchObject({ title: '标题' })
    expect(run(triggerOf('t', { meta: {}, text: '\n  第一行  \n第二行' }))).toMatchObject({ title: '第一行' })
    expect(run(triggerOf('t', { meta: {}, text: '\n   \n' }))).toMatchObject({ title: 'Untitled request' })
    const noTrigger = (() => {
      const assessor = new ManualAssessor()
      assessor.request({ evalId: 'e', triggers: [], thread: threadOf(), strength: 'explicit', policyVersion: 'v1', tickets: [] })
      let outcome: unknown
      assessor.drain({
        candidate: () => ({ evalId: 'e', triggers: [], thread: threadOf(), strength: 'explicit' as const, policyVersion: 'v1', tickets: [] }),
        decide: (_id: string, value: unknown) => { outcome = value; return {} },
      } as never)
      return outcome
    })()
    // request 阶段没有 trigger 就丢了，drain 不会再判。
    expect(noTrigger).toBeUndefined()
  })
})

describe('StoreNotifier：最近动态窗口的溢出与副本', () => {
  test('remember 超过 20 条丢最旧；未溢出不动；recent 给副本', () => {
    const notifier = new StoreNotifier({} as never)
    notifier.remember([])
    expect(notifier.recent()).toStrictEqual([])
    notifier.remember(Array.from({ length: 21 }, (_, index) => ({ at: `at-${String(index)}`, text: `t${String(index)}` })))
    const recent = notifier.recent()
    expect(recent).toHaveLength(20)
    expect(recent[0]!.text).toBe('t1')
    expect(recent.at(-1)!.text).toBe('t20')
    recent.push({ at: 'x', text: 'x' })
    expect(notifier.recent()).toHaveLength(20)
  })
})

describe('SuperagentService：默认值、指纹与降级', () => {
  function serviceOf(deps: Partial<{
    current(): unknown
    ensure(): unknown
    problem(): { code: string; detail: string } | null
    changed(): void
  }>): InstanceType<typeof SuperagentService> {
    return new SuperagentService({
      current: deps.current ?? (() => null),
      ensure: deps.ensure ?? (() => null),
      problem: deps.problem ?? (() => null),
      changed: deps.changed ?? (() => {}),
    } as never)
  }

  test('publish：空输入、非字符串 body/base 都按默认规则', async () => {
    const calls: unknown[] = []
    const runtime = {
      publish(input: unknown) { calls.push(input); return 'tk1' },
      list: () => [{ id: 'tk1' }],
      recent: () => [],
    }
    const service = serviceOf({ ensure: () => runtime })
    await expect(service.publish(undefined as never)).rejects.toThrow('标题不能为空')
    await expect(service.publish({ title: '标题', body: 42, base: 7 } as never)).resolves.toBe('tk1')
    expect(calls.at(-1)).toStrictEqual({ title: '标题', body: '标题' })
    await service.publish({ title: '标题', body: '正文', base: ' main ' })
    expect(calls.at(-1)).toStrictEqual({ title: '标题', body: '正文', base: 'main' })
  })

  test('surface / require：problem 的 detail 兜底，非 Error 异常转文本', async () => {
    const service = serviceOf({ ensure: () => null, problem: () => ({ code: 'store_unavailable', detail: '库没开' }) })
    expect(service.surface().problem).toStrictEqual({ code: 'store_unavailable', detail: '库没开' })
    await expect(service.retry('tk1')).rejects.toThrow('库没开')
    const thrown = serviceOf({ ensure: () => { throw '字符串异常' } })
    expect(thrown.surface().problem).toStrictEqual({ code: 'store_unavailable', detail: '字符串异常' })
  })

  test('tick：未建运行期不推；指纹不变不推；阶段/动态变化才推', () => {
    let changes = 0
    const stage = { stage: 'working', action: 'queued' }
    const runtime = {
      list: () => [{ id: 'a', stage }],
      recent: () => [{ at: NOW }],
      pump: () => {},
    }
    const service = serviceOf({ current: () => runtime, changed: () => { changes += 1 } })
    service.tick()
    expect(changes).toBe(1)
    service.tick()
    expect(changes).toBe(1)
    stage.action = 'running'
    service.tick()
    expect(changes).toBe(2)
    const none = serviceOf({ current: () => null })
    none.tick()
  })
})

// ── commands.ts ───────────────────────────────────────────────────────────

describe('commands：解析、前缀匹配与命令输出', () => {
  test('parseSaCommand：new 的正文缺省、list 参数、动作 id 校验、未知动作', () => {
    expect(parseSaCommand(['new', '标题'])).toStrictEqual({ kind: 'new', title: '标题', body: '标题' })
    expect(parseSaCommand(['new', '标题', '|', '正文'])).toStrictEqual({ kind: 'new', title: '标题', body: '正文' })
    expect(parseSaCommand(['new', '标题 |'])).toStrictEqual({ kind: 'new', title: '标题', body: '标题' })
    expect(parseSaCommand(['new', '  '])).toMatchObject({ kind: 'error' })
    expect(parseSaCommand(['list', '多余'])).toMatchObject({ kind: 'error' })
    expect(parseSaCommand(['stop'])).toMatchObject({ kind: 'error' })
    expect(parseSaCommand(['stop', 'a', 'b'])).toMatchObject({ kind: 'error' })
    expect(parseSaCommand(['stop', 'abc'])).toStrictEqual({ kind: 'stop', id: 'abc' })
    expect(parseSaCommand(['retry', 'abc'])).toStrictEqual({ kind: 'retry', id: 'abc' })
    expect(parseSaCommand(['clean', 'abc'])).toStrictEqual({ kind: 'clean', id: 'abc' })
    expect(parseSaCommand(['nope'])).toMatchObject({ kind: 'error' })
    expect(parseSaCommand([])).toMatchObject({ kind: 'error' })
  })

  test('resolveTicket：空、完整 id、前缀唯一、无匹配、多匹配（含 3 条以上）', () => {
    const views = [
      { id: 'aaaa1111', title: 'A', stage: { stage: 'working' }, createdAt: NOW },
      { id: 'aaaa2222', title: 'B', stage: { stage: 'idle' }, createdAt: NOW },
      { id: 'aaaa3333', title: 'C', stage: { stage: 'ended' }, createdAt: NOW },
      { id: 'aaaa4444', title: 'D', stage: { stage: 'person', action: 'review' }, createdAt: NOW },
    ] as unknown as TicketView[]
    expect(resolveTicket(views, '  ')).toMatchObject({ message: expect.stringContaining('要给') })
    expect(resolveTicket(views, 'aaaa1111')).toMatchObject({ ticket: { id: 'aaaa1111' } })
    expect(resolveTicket(views, 'aaaa1111'.toUpperCase())).toMatchObject({ ticket: { id: 'aaaa1111' } })
    expect(resolveTicket(views, 'aaaa2')).toMatchObject({ ticket: { id: 'aaaa2222' } })
    expect(resolveTicket(views, 'bbbb')).toMatchObject({ message: expect.stringContaining('没有这张工单') })
    const ambiguous = resolveTicket(views, 'aaaa') as { message: string }
    expect(ambiguous.message).toContain('有歧义')
    expect(ambiguous.message).toContain(' 等')
  })

  test('registerCommands：list 渲染各阶段，动作成功/失败/未匹配，未启动与抛错', async () => {
    type Handler = (input: { args: string[]; ui: { notice(line: string): void } }) => unknown
    const handlers: Handler[] = []
    const ctx = { commands: { register: (_spec: unknown, handler: Handler) => { handlers.push(handler); return () => {} } } } as never
    let runtimeFactory: () => unknown = () => null
    registerCommands(ctx, () => runtimeFactory() as never)
    const notices: string[] = []
    const call = (args: string[]) => handlers[0]!({ args, ui: { notice: (line) => notices.push(line) } })

    await call(['list'])
    expect(notices.at(-1)).toContain('未启动')

    runtimeFactory = () => { throw new Error('库坏了') }
    await call(['list'])
    expect(notices.at(-1)).toContain('没启动起来')

    const views = [
      { id: 'test1111', title: 'A', stage: { stage: 'working', action: 'queued' }, createdAt: NOW },
      { id: 'bbbb2222', title: 'B', stage: { stage: 'working' }, createdAt: NOW },
      { id: 'test2222', title: 'C', stage: { stage: 'person', action: 'delivery' }, createdAt: NOW },
      { id: 'dddd4444', title: 'D', stage: { stage: 'person', action: 'answer' }, createdAt: NOW },
      { id: 'eeee5555', title: 'E', stage: { stage: 'person', action: 'review' }, createdAt: NOW },
      { id: 'ffff6666', title: 'F', stage: { stage: 'person', action: 'blocked' }, createdAt: NOW },
      { id: 'gggg7777', title: 'G', stage: { stage: 'person', action: 'failed' }, createdAt: NOW },
      { id: 'hhhh8888', title: 'H', stage: { stage: 'ended' }, createdAt: NOW },
    ] as unknown as TicketView[]
    const actions: string[] = []
    const runtime = {
      list: () => views,
      stop: (id: string) => { actions.push(`stop:${id}`) },
      retry: (id: string) => { actions.push(`retry:${id}`); throw new UserError('notRetryable') },
      clean: (id: string) => { actions.push(`clean:${id}`) },
      publish: (input: { title: string }) => input.title === '失败' ? (() => { throw new Error('发布炸了') })() : 'test1111',
    }
    runtimeFactory = () => runtime
    await call(['list'])
    expect(notices.at(-1)).toContain('待派工')
    expect(notices.at(-1)).toContain('执行中')
    expect(notices.at(-1)).toContain('等你接收')
    expect(notices.at(-1)).toContain('等你回答')
    expect(notices.at(-1)).toContain('等你验收')
    expect(notices.at(-1)).toContain('卡住了')
    expect(notices.at(-1)).toContain('失败了')
    expect(notices.at(-1)).toContain('已结束')

    await call(['stop', 'test'])
    expect(notices.at(-1)).toContain('有歧义')
    await call(['stop', 'test1111'])
    expect(notices.at(-1)).toContain('工单已停止')

    await call(['retry', 'test1111'])
    expect(notices.at(-1)).toContain('重试失败')
    await call(['clean', 'test2222'])
    expect(notices.at(-1)).toContain('工作树已清理')

    await call(['new', '标题'])
    expect(notices.at(-1)).toContain('工单已建')
    await call(['new', '失败'])
    expect(notices.at(-1)).toContain('发布失败')
    runtimeFactory = () => ({ list: () => [], publish: () => 'trigger-only' })
    await call(['new', '没接单'])
    expect(notices.at(-1)).toContain('没有接单成功')
    await call(['stop', 'nope'])
    expect(notices.at(-1)).toContain('没有这张工单')
  })
})

// ── adapters/store.ts / outbox.ts ─────────────────────────────────────────

describe('store / outbox：坏行、幂等与锁的边界', () => {
  let storeSeq = 0
  function newStore(label: string) {
    storeSeq += 1
    return openStore(join(HOME, `${label}-${String(storeSeq)}.sqlite`))
  }

  function readRecord(store: ReturnType<typeof newStore>, id: string): Record<string, unknown> {
    const row = store.handle.prepare('SELECT value FROM ticket WHERE id = ?').get(id) as { value?: string }
    return JSON.parse(row.value ?? '{}') as Record<string, unknown>
  }

  test('createTicket：空标题/需求拒绝，重复 id 拒绝', () => {
    const store = newStore('ticket')
    try {
      expect(() => store.createTicket({ title: '', task: 'x' })).toThrow()
      expect(() => store.createTicket({ title: 'x', task: '' })).toThrow()
      store.createTicket({ id: 'fixed', title: 'x', task: 'y' })
      expect(() => store.createTicket({ id: 'fixed', title: 'x', task: 'y' })).toThrow()
    } finally {
      store.close()
    }
  })

  test('setTicketState：空状态拒绝，未知工单拒绝', () => {
    const store = newStore('state')
    try {
      store.createTicket({ id: 'tk', title: 'x', task: 'y' })
      expect(() => store.setTicketState('tk', '')).toThrow()
      expect(() => store.setTicketState('missing', 'working')).toThrow()
      store.setTicketState('tk', 'working')
      expect(readRecord(store, 'tk').state).toBe('working')
    } finally {
      store.close()
    }
  })

  test('outbox：空 kind 拒绝、坏行 drain 抛 outbox_corrupt、limit 校验', () => {
    const store = newStore('outbox')
    try {
      expect(() => store.enqueueOutbox({ kind: '', payload: {} })).toThrow()
      expect(() => store.drainOutbox(0)).toThrow()
      expect(() => store.drainOutbox(1.5)).toThrow()
      store.handle.prepare('INSERT INTO outbox (id, value) VALUES (?, ?)').run('bad', 'not json')
      expect(() => store.drainOutbox(10)).toThrow(/outbox/)
    } finally {
      store.close()
    }
  })

  test('StoreOutbox：已发（行被取走）后 status 为 sent；坏行读作 undefined；撤回只撤 pending', () => {
    const store = newStore('outbox-api')
    try {
      const outbox = new StoreOutbox(store)
      outbox.send({ id: 'm1', kind: 'notice', text: 'x', channel: CHANNEL })
      expect(outbox.status('m1')).toBe('pending')
      outbox.send({ id: 'm1', kind: 'notice', text: 'x', channel: CHANNEL })
      expect(store.drainOutbox(10)).toHaveLength(1)
      expect(outbox.status('m1'), '行被取走且内存记着 pending → sent').toBe('sent')
      outbox.withdraw('m1')
      expect(outbox.status('m1')).toBe('sent')

      store.handle.prepare('INSERT INTO outbox (id, value) VALUES (?, ?)').run('bad', '{bad')
      expect(outbox.status('bad')).toBeUndefined()
      expect(() => outbox.withdraw('bad')).not.toThrow()
    } finally {
      store.close()
    }
  })

  test('decodeExecution 的缺字段：null、半份、非对象都当未排到；完整三元组才保留', () => {
    const base = { id: 'e1', title: 'x', task: 'y', state: 'queued', createdAt: NOW, updatedAt: NOW }
    expect(decodeTicketValue('e1', JSON.stringify(base)).execution).toBeNull()
    expect(decodeTicketValue('e1', JSON.stringify({ ...base, execution: { name: 'n', repo: 'r' } })).execution).toBeNull()
    expect(decodeTicketValue('e1', JSON.stringify({ ...base, execution: { name: 'n', repo: 'r', branch: 'b' } })).execution)
      .toStrictEqual({ name: 'n', repo: 'r', branch: 'b' })
    expect(decodeTicketValue('e1', 'not json').execution).toBeNull()
  })
})

// ── runtime.ts ────────────────────────────────────────────────────────────

describe('SuperagentRuntime：来源桥、恢复、停止/重试/清理与泵的错误出口', () => {
  let runtimeSeq = 0
  function runtimeStore(): ReturnType<typeof openStore> {
    runtimeSeq += 1
    return openStore(join(HOME, `runtime-${String(runtimeSeq)}.sqlite`))
  }

  interface FakeExecutorCalls {
    start: string[]
    stop: string[]
  }

  function fakeExecutor(options: {
    live?: string[]
    throwStartFor?: string | string[]
    throwProbe?: boolean
    throwStop?: boolean
  } = {}): { executor: Record<string, (...args: never[]) => unknown>; calls: FakeExecutorCalls } {
    const calls: FakeExecutorCalls = { start: [], stop: [] }
    const throwing = typeof options.throwStartFor === 'string' ? [options.throwStartFor] : options.throwStartFor ?? []
    const executor = {
      start(ticket: Ticket) {
        if (throwing.includes(ticket.id)) throw new Error('start failed')
        calls.start.push(ticket.id)
      },
      deliver() {},
      stop(ticket: Ticket) {
        calls.stop.push(ticket.id)
        if (options.throwStop) throw new Error('stop failed')
      },
      workingTicketIds() {
        if (options.throwProbe) throw new Error('probe failed')
        return options.live ?? []
      },
    }
    return { executor: executor as never, calls }
  }

  test('openTickets / sourceBridge / publish 被过滤 / close 幂等', async () => {
    const store = runtimeStore()
    try {
      const logs: string[] = []
      const { executor } = fakeExecutor()
      const runtime = new SuperagentRuntime(store, {
        now: () => NOW,
        log: (line) => logs.push(line),
        executor: executor as never,
        scope: { scope: () => ({ listened: false, reason: 'nope' }) },
      })
      expect(runtime.openTickets()).toStrictEqual([])
      const published = runtime.publish({ title: '标题', body: '正文' })
      expect(typeof published).toBe('string')
      expect(published.length).toBeGreaterThan(0)
      expect(logs.some((line) => line.includes('未入库'))).toBe(true)

      const bridge = runtime.sourceBridge()
      expect(bridge.receive(triggerOf('bridge-trigger'))).toBe('filtered')
      bridge.threadClosed({ source: 'feishu', id: 'none' })
      expect(() => bridge.bindThread('nope', threadRef(), false)).toThrow()

      runtime.close()
      runtime.close()
      expect(() => runtime.openTickets()).toThrow('已关闭')
      await runtime.flushOutbox()
    } finally {
      store.close()
    }
  })

  test('模型判定异步返回空：publish 拿不到工单时回 Trigger id 并记日志', async () => {
    const store = runtimeStore()
    try {
      const logs: string[] = []
      const { executor } = fakeExecutor()
      let mode: 'boom' | 'bad' = 'boom'
      const runtime = new SuperagentRuntime(store, {
        now: () => NOW,
        log: (line) => logs.push(line),
        executor: executor as never,
        assessorModel: { provider: 'p', model: 'm' },
        assessorComplete: async () => {
          if (mode === 'boom') throw new Error('model down')
          return '不是 JSON'
        },
      })
      const id = runtime.publish({ title: '标题', body: '正文' })
      expect(typeof id).toBe('string')
      expect(logs.some((line) => line.includes('没有建出工单'))).toBe(true)
      await new Promise((resolve) => setImmediate(resolve))
      expect(logs.some((line) => line.includes('判定') && line.includes('失败'))).toBe(true)

      mode = 'bad'
      runtime.publish({ title: '标题二', body: '正文二' })
      await new Promise((resolve) => setImmediate(resolve))
      expect(logs.some((line) => line.includes('不合形状'))).toBe(true)
    } finally {
      store.close()
    }
  })

  test('recover：pending 重排、running 接续、settled 保留、在跑的跳过、start 抛错记日志', () => {
    const store = runtimeStore()
    try {
      const repos = new StoreRepositories(store.handle)
      repos.tickets.save(ticketOf({ id: 'pending', assignments: [assignmentOf('p1', { state: 'pending' })] }))
      repos.tickets.save(ticketOf({ id: 'boom', assignments: [assignmentOf('b1', { state: 'pending' })] }))
      repos.tickets.save(ticketOf({ id: 'running' }))
      repos.tickets.save(ticketOf({ id: 'settled', assignments: [assignmentOf('s1', { report: { state: 'waiting', summary: '等', at: NOW } })] }))
      repos.tickets.save(ticketOf({ id: 'live' }))
      repos.tickets.save(ticketOf({ id: 'no-assignment', assignments: [] }))
      repos.tickets.save(ticketOf({ id: 'crash-run' }))
      const logs: string[] = []
      const { executor, calls } = fakeExecutor({ live: ['live'], throwStartFor: ['boom', 'crash-run'] })
      const runtime = new SuperagentRuntime(store, {
        now: () => NOW,
        log: (line) => logs.push(line),
        executor: executor as never,
      })
      const report = runtime.recover()
      expect(report.requeued).toContain('pending')
      expect(report.resumed).toContain('running')
      expect(report.resumed).not.toContain('settled')
      expect(report.resumed).not.toContain('live')
      expect(logs.some((line) => line.includes('恢复派工失败'))).toBe(true)
      expect(logs.some((line) => line.includes('崩溃恢复未记入'))).toBe(true)
      expect(calls.start).toContain('pending')

      // 恢复通知入队失败只记日志，接续本身已经落库。
      const outbox = (runtime as unknown as { outbox: { send(message: unknown): void } }).outbox
      const originalSend = outbox.send
      outbox.send = () => { throw new Error('notice boom') }
      repos.tickets.save(ticketOf({ id: 'crash-notify' }))
      runtime.recover()
      expect(logs.some((line) => line.includes('恢复通知未入队'))).toBe(true)
      outbox.send = originalSend

      const stats = runtime.runningStats()
      expect(stats.total).toBeGreaterThanOrEqual(2)
      expect(stats.orphaned).toBeGreaterThanOrEqual(1)

      runtime.stop('pending')
      expect(calls.stop).toContain('pending')
    } finally {
      store.close()
    }
  })

  test('retry：可重试工单会起新分配；不可重试抛错', () => {
    const store = runtimeStore()
    try {
      const repos = new StoreRepositories(store.handle)
      repos.tickets.save(ticketOf({
        id: 'retryable',
        assignments: [assignmentOf('r1', { report: { state: 'blocked', summary: '卡', at: NOW } })],
      }))
      repos.tickets.save(ticketOf({ id: 'fresh' }))
      const { executor, calls } = fakeExecutor()
      const runtime = new SuperagentRuntime(store, { now: () => NOW, executor: executor as never })
      runtime.retry('retryable')
      expect(calls.start).toContain('retryable')
      expect(() => runtime.retry('fresh')).toThrow()
    } finally {
      store.close()
    }
  })

  test('clean：不存在 / 没结束 / 没配仓库 / 配了仓库但删除失败都报人话', () => {
    const store = runtimeStore()
    try {
      const repos = new StoreRepositories(store.handle)
      repos.tickets.save(ticketOf({ id: 'open' }))
      repos.tickets.save(ticketOf({ id: 'ended', ended: { at: NOW, by: 'executor', outcome: 'completed' } }))
      const { executor } = fakeExecutor()
      const noRepo = new SuperagentRuntime(store, { now: () => NOW, executor: executor as never })
      expect(() => noRepo.clean('missing')).toThrow('没有这张工单')
      expect(() => noRepo.clean('open')).toThrow('还没结束')
      expect(() => noRepo.clean('ended')).toThrow('没有配置仓库路径')

      const withRepo = new SuperagentRuntime(store, {
        now: () => NOW,
        executor: executor as never,
        worker: { repo: () => join(HOME, 'missing-repo') },
      })
      // 目录不存在时 removeWorktree 会走 git；失败与否都要求已经算出了路径。
      expect(() => withRepo.clean('ended')).toThrow()
    } finally {
      store.close()
    }
  })

  test('pump 的超时取消失败记日志；probe 抛错按没有 worker 处理', () => {
    const store = runtimeStore()
    try {
      const repos = new StoreRepositories(store.handle)
      repos.tickets.save(ticketOf({ id: 'overdue', createdAt: '2020-01-01T00:00:00.000Z' }))
      const logs: string[] = []
      const { executor } = fakeExecutor({ throwProbe: true, throwStop: true })
      const runtime = new SuperagentRuntime(store, {
        now: () => NOW,
        log: (line) => logs.push(line),
        executor: executor as never,
        timeoutSeconds: () => 1,
      })
      runtime.pump()
      expect(logs.some((line) => line.includes('超时取消失败'))).toBe(true)
      expect(runtime.runningStats()).toMatchObject({ total: 1, orphaned: 1 })
      expect(logs.some((line) => line.includes('取 worker 清单失败'))).toBe(true)

      // 会话清理遇到不能当目录名的工单 id：跳过并记日志。
      repos.tickets.save(ticketOf({ id: 'bad/id', ended: { at: '2020-01-01T00:00:00.000Z', by: 'executor', outcome: 'completed' } }))
      const swept = runtime.sweep(Date.parse('2026-01-01T00:00:00.000Z'))
      expect(swept.removed).toStrictEqual([])
      expect(logs.some((line) => line.includes('会话目录算不出来'))).toBe(true)
    } finally {
      store.close()
    }
  })

  test('flushOutbox 走发送方并记窗口；appendEvent / notify 抛错只记日志', async () => {
    const store = runtimeStore()
    try {
      const repos = new StoreRepositories(store.handle)
      repos.tickets.save(ticketOf({ id: 'record' }))
      repos.tickets.save(ticketOf({ id: 'record2' }))
      const logs: string[] = []
      const { executor } = fakeExecutor()
      const runtime = new SuperagentRuntime(store, {
        now: () => NOW,
        log: (line) => logs.push(line),
        executor: executor as never,
        senders: () => ({ feishu: async () => { throw new Error('send failed') } }),
      })
      store.enqueueOutbox({
        id: 'o1',
        kind: 'reply',
        payload: {
          at: NOW,
          message: { id: 'o1', kind: 'reply', text: '一句话', channel: { source: 'feishu', thread: 't', address: {} } },
        },
      })
      await runtime.flushOutbox()
      expect(logs.length).toBeGreaterThan(0)

      // 整轮 flush 自己抛错（例如库被关）：runtime 只记一行，不让泵停摆。
      const dispatch = (runtime as unknown as { dispatch: { flush(): Promise<void> } }).dispatch
      dispatch.flush = () => Promise.reject(new Error('dispatch boom'))
      await runtime.flushOutbox()
      expect(logs.some((line) => line.includes('出站消息未发出'))).toBe(true)

      // 没配 senders 的默认 getter 也要能跑一轮。
      const bare = new SuperagentRuntime(store, { now: () => NOW, log: (line) => logs.push(line), executor: executor as never })
      await bare.flushOutbox()
      expect(logs.length).toBeGreaterThan(0)

      store.appendEvent = (() => { throw '不是 Error' }) as never
      runtime.stop('record')
      expect(logs.some((line) => line.includes('未落库'))).toBe(true)

      const notify = (runtime as unknown as { notify: { ended(ticket: Ticket): void } }).notify
      notify.ended = () => { throw new Error('notice failed') }
      runtime.stop('record2')
      expect(logs.some((line) => line.includes('通知未入队'))).toBe(true)
    } finally {
      store.close()
    }
  })
})

// ── adapters/assessor-model.ts ───────────────────────────────────────────

describe('ModelAssessor：空候选、在飞去重、坏 JSON 与 release/clear', () => {
  function candidateOf(evalId: string, triggers: Trigger[] = [triggerOf('t1')]): Candidate {
    return { evalId, triggers, thread: threadOf(), strength: 'explicit', policyVersion: 'v1', tickets: [] }
  }

  test('无 trigger 不入队；在飞与排队都去重；drain 返回空数组', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const assessor = new ModelAssessor({
      settings: () => defaultSettings(),
      complete: async () => { await gate; return '{"decision":"ignore"}' },
      log: () => {},
    })
    assessor.request(candidateOf('e0', []))
    assessor.request(candidateOf('e1'))
    assessor.request(candidateOf('e1'))
    const engine = {
      candidate: () => candidateOf('e1'),
      candidateDelivered: () => {},
      decide: () => ({}),
    }
    expect(assessor.drain(engine as never)).toStrictEqual([])
    assessor.request(candidateOf('e1'))
    release()
    await new Promise((resolve) => setImmediate(resolve))
    assessor.clear()
  })

  test('候选读不到 / 没有 trigger 都跳过；坏 JSON 记日志；release 清队列与在飞', async () => {
    const logs: string[] = []
    const assessor = new ModelAssessor({
      settings: () => defaultSettings(),
      complete: async () => '{"decision": }',
      log: (line) => logs.push(line),
    })
    assessor.request(candidateOf('missing', [triggerOf('missing')]))
    assessor.request(candidateOf('empty', [triggerOf('empty')]))
    assessor.request(candidateOf('badjson', [triggerOf('badjson')]))
    const engine = {
      candidate: (triggerId: string) => triggerId === 'missing'
        ? undefined
        : candidateOf(triggerId, triggerId === 'empty' ? [] : [triggerOf(triggerId)]),
      candidateDelivered: () => {},
      decide: () => ({}),
    }
    await assessor.drainAsync(engine as never)
    expect(logs.some((line) => line.includes('不合形状'))).toBe(true)
    assessor.release('not-there')
    assessor.request(candidateOf('queued', [triggerOf('queued')]))
    assessor.release('queued')
    assessor.clear()

    // 队列里已经有、但同一 Eval 还在飞：drainAsync 必须跳过，不再问第二次模型。
    let asked = 0
    const whitebox = new ModelAssessor({
      settings: () => defaultSettings(),
      complete: async () => { asked += 1; return '{}' },
      log: () => {},
    })
    const internals = whitebox as unknown as { inFlight: Set<string>; queue: Array<{ evalId: string; triggerId: string }> }
    internals.inFlight.add('inflight')
    internals.queue.push({ evalId: 'inflight', triggerId: 't' })
    await whitebox.drainAsync({ candidate: () => { throw new Error('should not read') } } as never)
    expect(asked).toBe(0)
  })
})

// ── commands.ts：剩余分支 ────────────────────────────────────────────────

describe('commands：标题为空、idle 渲染与三种错误翻译', () => {
  test('new 只有分隔符时标题为空', () => {
    expect(parseSaCommand(['new', '|', '正文'])).toMatchObject({ kind: 'error' })
  })

  test('idle 工单渲染为「空闲」；unknownTicket / ticketEnded / 非 Error 各有一句人话', async () => {
    type Handler = (input: { args: string[]; ui: { notice(line: string): void } }) => unknown
    const handlers: Handler[] = []
    const views = [{ id: 'idle0001', title: '闲', stage: { stage: 'idle' }, createdAt: NOW }] as unknown as TicketView[]
    let mode: 'unknown' | 'ended' | 'string' = 'unknown'
    let runtime: unknown = null
    registerCommands({ commands: { register: (_spec: unknown, handler: Handler) => { handlers.push(handler); return () => {} } } } as never, () => runtime as never)
    const notices: string[] = []
    const call = (args: string[]) => handlers[0]!({ args, ui: { notice: (line) => notices.push(line) } })
    runtime = {
      list: () => views,
      stop: () => {
        if (mode === 'unknown') throw new UserError('unknownTicket')
        if (mode === 'ended') throw new UserError('ticketEnded')
        throw '字符串错误'
      },
    }
    await call(['list'])
    expect(notices.at(-1)).toContain('空闲')
    await call(['stop', 'idle0001'])
    expect(notices.at(-1)).toContain('没有这张工单')
    mode = 'ended'
    await call(['stop', 'idle0001'])
    expect(notices.at(-1)).toContain('已经结束')
    mode = 'string'
    await call(['stop', 'idle0001'])
    expect(notices.at(-1)).toContain('字符串错误')
  })
})

// ── store.ts：坏 outbox 行与事件边界 ─────────────────────────────────────

describe('store：非字符串 / 非对象 / 缺字段的 outbox 行与事件前置条件', () => {
  test('drain 对 null、数组、缺 id/kind 的行抛 outbox_corrupt', () => {
    const store = openStore(join(HOME, 'outbox-corrupt.sqlite'))
    try {
      const insert = (id: string, value: string) => {
        store.handle.prepare('INSERT INTO outbox (id, value) VALUES (?, ?)').run(id, value)
      }
      insert('null', 'null')
      expect(() => store.drainOutbox(1)).toThrow(/outbox/)
      insert('array', '[]')
      expect(() => store.drainOutbox(1)).toThrow(/outbox/)
      insert('missing', '{}')
      expect(() => store.drainOutbox(1)).toThrow(/outbox/)
    } finally {
      store.close()
    }
  })

  test('appendEvent：空 kind 与未知工单都拒绝', () => {
    const store = openStore(join(HOME, 'event-guard.sqlite'))
    try {
      store.createTicket({ id: 'tk', title: 'x', task: 'y' })
      expect(() => store.appendEvent('tk', '', {})).toThrow()
      expect(() => store.appendEvent('missing', 'kind', {})).toThrow()
    } finally {
      store.close()
    }
  })

  test('decodeTicketValue 对非字符串 raw 给空记录', () => {
    expect(decodeTicketValue('e1', 42)).toMatchObject({ id: 'e1', title: '', task: '', execution: null })
  })

  test('发送泵跳过读不出消息的行；manual 行只进最近动态；缺 at 用当前时刻', async () => {
    const store = openStore(join(HOME, 'dispatch-guards.sqlite'))
    try {
      store.enqueueOutbox({ id: 'p0', kind: 'x', payload: null })
      store.enqueueOutbox({ id: 'p1', kind: 'x', payload: { message: { id: '', text: 'x' } } })
      store.enqueueOutbox({ id: 'p2', kind: 'x', payload: { message: { id: 'm2', text: 'x', channel: null } } })
      store.enqueueOutbox({
        id: 'p3',
        kind: 'x',
        payload: { message: { id: 'm3', text: '只有动态', channel: { source: 'manual', thread: 't', address: {} } } },
      })
      const recent: Array<{ at: string; text: string }> = []
      const dispatcher = new OutboxDispatcher({
        store,
        senders: () => ({}),
        remember: (fresh) => { recent.push(...fresh) },
        now: () => NOW,
        log: () => {},
      })
      await dispatcher.flush()
      expect(recent).toStrictEqual([{ at: NOW, text: '只有动态' }])
      expect(store.drainOutbox(10)).toStrictEqual([])
    } finally {
      store.close()
    }
  })

  test('remember 抛错只吞掉这一拍；取队列连坏两拍后返回空', async () => {
    const rows = [{ id: 'm', kind: 'reply', payload: { message: { id: 'm', text: 'hi', channel: { source: 'manual', thread: 't', address: {} } } } }]
    const logs: string[] = []
    const explodingRemember = new OutboxDispatcher({
      store: {
        drainOutbox: () => rows,
        handle: { prepare: () => ({ all: () => [], run: () => {} }) },
      } as never,
      senders: () => ({}),
      remember: () => { throw new Error('remember boom') },
      now: () => NOW,
      log: (line) => logs.push(line),
    })
    await explodingRemember.flush()
    expect(logs.some((line) => line.includes('出站发送这一拍失败'))).toBe(true)

    const broken = new OutboxDispatcher({
      store: {
        drainOutbox: () => { throw new Error('drain boom') },
        handle: {
          prepare: (sql: string) => sql.includes('SELECT')
            ? { all: () => [{ row: 1, value: 'not json' }], run: () => {} }
            : { all: () => [], run: () => {} },
        },
      } as never,
      senders: () => ({}),
      remember: () => {},
      now: () => NOW,
      log: (line) => logs.push(line),
    })
    await broken.flush()
    expect(logs.some((line) => line.includes('取出站消息失败'))).toBe(true)
    expect(logs.some((line) => line.includes('删掉 1 行'))).toBe(true)
  })
})
