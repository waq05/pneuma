/**
 * 覆盖补齐（W12）：`app/cards.ts` 的模型侧卡片投影。
 *
 * 这些投影只做「把库里的事实压成模型读得懂的短卡片」，判错不抛错，只会让模型少看或多看一条；
 * 因此每个用例都钉住「哪个状态给出哪张卡、带哪些字段」，不钉函数不崩。
 *
 * @module @pneuma/superagent/app
 */
import { describe, expect, test } from 'vitest'
import type { Assignment, Decision, Ticket, TicketInput, Thread, Trigger, TriggerDisposition } from '../core/index.js'
import {
  assignmentLine, decisionCard, decisionDetails, inputLine, newestPage, preview, relatedTickets, textPage, threadCard,
  ticketCard, ticketDetails, triggerCard,
} from './cards.js'

const at = '2026-01-01T00:00:00.000Z'

const trigger = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: 'e1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_root' }], actor: { source: 'feishu', id: 'ou_alice' },
  human: true, at, text: 'please fix the copy', meta: {}, ...overrides,
})
const mandate = {
  strength: 'explicit' as const, policyVersion: 'v1', basis: { via: 'listed' as const }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '',
}
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 't1', title: 'Fix the copy', decisionId: 'd1', mandate, channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: at, updatedAt: at, origin: { triggerId: 'e1', triggerIds: ['e1'] }, ...overrides,
})
const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({ id: 'a1', state: 'running', createdAt: at, ...overrides })
const decision = (overrides: Partial<Decision> = {}): Decision => ({
  id: 'd1', evalId: 'e1', threadKey: 'feishu:oc_1:om_root', triggerIds: ['e1'], policyVersion: 'v1', at, kind: 'ignore',
  reason: [], strength: 'explicit', ...overrides,
})
const thread = (overrides: Partial<Thread> = {}): Thread => ({
  key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: [], correlated: [],
  pending: [], meta: {}, ...overrides,
})

describe('cards：trigger / ticket 卡片', () => {
  test('preview 压掉空白并截到 160 个字符', () => {
    expect(preview('a\n\n b\t c')).toBe('a b c')
    expect(preview('x'.repeat(200))).toHaveLength(160)
  })

  test('triggerCard 带外部链接与处置摘要；没有处置时一个字段都不多给', () => {
    const bare = triggerCard(trigger())
    expect(bare).toMatchObject({ trigger_id: 'e1', source: 'feishu', actor: 'ou_alice', thread: 'feishu:oc_1:om_root',
      human: true, chars: 19, read: 'trigger/e1' })
    expect('source_url' in bare).toBe(false)
    expect('disposition' in bare).toBe(false)

    const disposition: TriggerDisposition = { fanout: ['t1'], decisionId: 'd1', filtered: { code: 'maybe_related' }, at }
    expect(triggerCard(trigger({ url: 'https://x/1' }), disposition)).toMatchObject({
      source_url: 'https://x/1', disposition: { filtered: 'maybe_related', decision_id: 'd1', delivered_to: ['t1'] } })
  })

  test('ticketCard 的状态按工单阶段走，结束的工单给结果，有关注点时带问题', () => {
    const states = [
      ticket({ delivery: { error: 'channel gone', at } }),
      ticket({ attention: { id: 'att', question: 'Which copy?', triggerId: 'e2' } }),
      ticket({ assignments: [assignment({ report: { state: 'ready', summary: 'done', at } })] }),
      ticket({ assignments: [assignment({ report: { state: 'blocked', summary: 'need files', at } })] }),
      ticket(),
      ticket({ assignments: [assignment({ state: 'pending' })] }),
      ticket({ ended: { at, by: 'executor', outcome: 'completed', reason: 'done' } }),
    ].map(item => ticketCard(item).state)
    expect(states).toEqual(['person/delivery', 'person/answer', 'person/review', 'person/blocked', 'working/queued',
      'working/queued', 'completed'])

    expect(ticketCard(ticket({ attention: { id: 'att', question: 'Which?', triggerId: 'e2' } })).attention)
      .toEqual({ question: 'Which?', trigger_id: 'e2' })
    expect(ticketCard(ticket({ attention: { id: 'att', question: 'Which?' } })).attention).toEqual({ question: 'Which?' })
    expect(ticketCard(ticket({ ended: { at, by: 'human', outcome: 'stopped', reason: 'asked' } })).ended)
      .toEqual({ at, by: 'human', reason: 'asked' })
    // 未结束的工单不带 ended；PR 线程给出 pr_number。
    expect('ended' in ticketCard(ticket())).toBe(false)
    expect(ticketCard(ticket({ follows: [{ thread: 'github:42', own: true }] })).pr_number).toBe(42)
    // 最新报告摘要放在 preview，正文用 read 指向资源。
    expect(ticketCard(ticket({ assignments: [assignment({ report: { state: 'progress', summary: 'half way', at } })] })).preview)
      .toBe('half way')
  })

  test('inputLine 按输入种类给引用或正文，worker 不看决定 ID', () => {
    const owner = ticket({ undelivered: ['i2'] })
    const triggerInput: TicketInput = { id: 'i1', kind: 'trigger', triggerId: 'e9', at }
    expect(inputLine(owner, triggerInput)).toEqual({ kind: 'trigger', at, trigger_id: 'e9' })
    const shortText: TicketInput = { id: 'i1', kind: 'text', text: 'short', at }
    expect(inputLine(owner, shortText)).toEqual({ kind: 'text', at, text: 'short' })
    const longText: TicketInput = { id: 'i1', kind: 'text', text: 'x'.repeat(100), at }
    expect(inputLine(owner, longText)).toMatchObject({ kind: 'text', at, chars: 100, read: expect.stringContaining('ticket/t1/input/') })
    // note 不当正文给：它和 policy-changed 一样只给可读资源引用。
    expect(inputLine(owner, { id: 'i2', kind: 'note', text: 'note', at })).toMatchObject({ kind: 'note', at,
      read: expect.stringContaining('ticket/t1/input/'), undelivered: true })
    expect(inputLine(owner, { id: 'i3', kind: 'reopen', decisionId: 'd2', at })).toEqual({ kind: 'reopen', at, decision_id: 'd2' })
    expect(inputLine(owner, { id: 'i3', kind: 'reopen', decisionId: 'd2', at }, true)).toMatchObject({ read: expect.any(String) })
    expect(inputLine(owner, { id: 'i4', kind: 'resumed', triggerId: 'e1', at })).toEqual({ kind: 'resumed', at, trigger_id: 'e1' })
    expect(inputLine(owner, { id: 'i5', kind: 'policy-changed', from: 'a', to: 'b', at })).toMatchObject({ read: expect.any(String) })
  })

  test('assignmentLine 带结束原因与报告摘要', () => {
    const owner = ticket()
    expect(assignmentLine(owner, assignment({ endedReason: 'completed', report: { state: 'ready', summary: 'y'.repeat(120), at } })))
      .toMatchObject({ id: 'a1', state: 'running', ended_reason: expect.any(String),
        report: { state: 'ready', chars: 120, read: 'ticket/t1/report/a1', preview: 'y'.repeat(100) } })
    expect('report' in assignmentLine(owner, assignment())).toBe(false)
    expect('ended_reason' in assignmentLine(owner, assignment())).toBe(false)
  })

  test('newestPage 从新往旧翻页，还有更旧的就给 next_offset', () => {
    const line = (value: number) => value * 10
    expect(newestPage([1, 2, 3], 0, 2, line, 'res')).toEqual({ items: [30, 20], next_resource: 'res', next_offset: 2 })
    expect(newestPage([1, 2, 3], 2, 2, line, 'res')).toEqual({ items: [10] })
  })

  test('ticketDetails 拼上批次、线程、分页的 assignment 与 input；worker 视角不给 decision_id', () => {
    const batch = [trigger({ id: 'e2', text: 'second' })]
    const view = ticketDetails(ticket({ execution: { name: 'fix', directory: '/work/t1', assignment: 'do it' },
      inputs: [{ id: 'i1', kind: 'text', text: 'hi', at }] }), [{ thread: 'feishu:oc_1:om_root', context: true }], batch)
    expect(view).toMatchObject({ ticket_id: 't1', trigger_id: 'e1', decision_id: 'd1', directory: '/work/t1', scope: '',
      requested_by: 'ou_alice', threads: [{ thread: 'feishu:oc_1:om_root', context: true }],
      batch: [{ trigger_id: 'e2', from: 'ou_alice', preview: 'second', read: 'trigger/e2' }] })
    expect(view.assignments.items).toEqual([])
    expect(view.inputs.items).toHaveLength(1)
    expect('preview' in view).toBe(false)
    expect('decision_id' in ticketDetails(ticket(), [], [], true)).toBe(false)
    expect(ticketDetails(ticket(), [], [], true).trigger_id).toBe('e1')
  })

  test('threadCard 带评估窗口、待处理数、轮询错误与链接', () => {
    expect(threadCard(thread(), 'Copy')).toMatchObject({ thread: 'feishu:oc_1:om_root', label: 'Copy', source: 'feishu',
      tickets: [], pending: 0, read: 'thread/feishu:oc_1:om_root' })
    expect(threadCard(thread({ pending: ['e1'], meta: { pollError: 'boom', url: 'https://x' },
      evaluating: { id: 'ev', threadKey: 'feishu:oc_1:om_root', triggerIds: ['e1'], strength: 'explicit',
        actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed' }, policyVersion: 'v', startedAt: at,
        deadline: at } }), 'Copy')).toMatchObject({ pending: 1, error: 'boom', url: 'https://x',
      evaluating: { since: at, deadline: at } })
  })

  test('decisionCard / decisionDetails 给出理由、强度与可选的 mandate、audit', () => {
    expect(decisionCard(decision({ reason: [{ code: 'said', values: { text: 'do it' } }], ticketId: 't1' })))
      .toMatchObject({ decision_id: 'd1', kind: 'ignore', reason: 'do it', strength: 'explicit', ticket_id: 't1',
        trigger_ids: ['e1'], read: 'decision/d1' })
    expect('ticket_id' in decisionCard(decision())).toBe(false)
    const full = decisionDetails(decision({ mandate, audit: { would_accept: true } }))
    expect(full).toMatchObject({ audit: { would_accept: true }, mandate: { strength: 'explicit', basis: { via: 'listed' } } })
    // policyVersion 是内部哈希，不往外给。
    expect('policyVersion' in full.mandate!).toBe(false)
    expect('mandate' in decisionDetails(decision())).toBe(false)
  })

  test('textPage 按 UTF-16 码元切片，拼接能还原原文', () => {
    const text = 'abcdef'
    expect(textPage('r', text, 0, 2)).toEqual({ resource: 'r', offset: 0, total_chars: 6, next_offset: 2, text: 'ab' })
    expect(textPage('r', text, 4, 10)).toEqual({ resource: 'r', offset: 4, total_chars: 6, next_offset: null, text: 'ef' })
  })

  test('relatedTickets 未结束的排前面、新的在前，最多 8 张', () => {
    const cards = Array.from({ length: 10 }, (_, index) => ticket({ id: `t${index}`, createdAt: `2026-01-${String(index + 1).padStart(2, '0')}`,
      ...index === 0 ? { ended: { at, by: 'executor' as const, outcome: 'completed' as const } } : {} }))
    const view = relatedTickets(cards)
    expect(view.tickets_total).toBe(10)
    expect(view.related_tickets).toHaveLength(8)
    expect(view.related_tickets[0]!.ticket_id).toBe('t9')
    // 唯一的结束工单排最后。
    expect(view.related_tickets.at(-1)!.ticket_id).toBe('t2')
  })
})
