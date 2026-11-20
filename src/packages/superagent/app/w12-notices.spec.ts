/**
 * 覆盖补齐（W12）：`app/notices.ts` 的后台通知与转向中继。
 *
 * 这一层决定「主会话收到哪条通知、带什么 payload、能不能合并」；错一条不是抛错，而是通知丢失或重复打断。
 * 夹具：卡片投影用对象字面量；`followupNotice` 走真 SQLite 临时库 + 真 SourceRegistry，因为它的判定
 * 依赖 `followupOwners` 读库。
 *
 * @module @pneuma/superagent/app
 */
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { DomainEvent, Ticket, Trigger } from '../core/index.js'
import { SettingsSchema } from '../core/policy.js'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { feishuKind } from '../sources/feishu.js'
import { SourceRegistry } from '../sources/registry.js'
import { Store } from './store.js'
import {
  changedPaths, eventNotice, followupNotice, followupRelay, promptsNotice, receiptNotice, reportRelay, resultRelay,
  settingsNotice, subscriptionNotice, threadFollowedNotice,
} from './notices.js'

const at = '2026-01-01T00:00:00.000Z'
const mandate = {
  strength: 'explicit' as const, policyVersion: 'v1', basis: { via: 'listed' as const }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '',
}
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 't1', title: 'Fix the copy', decisionId: 'd1', mandate, channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: at, updatedAt: at, origin: { triggerId: 'e1', triggerIds: ['e1'] }, ...overrides,
})
const trigger = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: 'e1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_root' }], actor: { source: 'feishu', id: 'ou_alice' },
  human: true, at, text: 'please fix', meta: {}, ...overrides,
})

describe('notices：通知三元组与合并键', () => {
  test('保存提示词/设置的通知带合并键、读资源与摘要', () => {
    expect(promptsNotice(3)).toEqual(['prompts', { prompt_config_saved: 3, effect: 'next-request', read: 'prompts/3' },
      'Prompt configuration saved (revision 3)'])
    expect(settingsNotice('eval', ['eval.mode'])).toEqual(['settings:eval',
      { settings_saved: 'eval', changed: ['eval.mode'], read: 'settings/eval' }, 'Settings saved: eval'])
    expect(settingsNotice()).toEqual(['settings', { settings_saved: true, read: 'settings' }, 'Settings saved'])
  })

  test('一次性回执用随机名字，同名事件不会互相覆盖；线程订阅通知按线程合并', () => {
    const first = receiptNotice({ a: 1 }, 'done')
    const second = receiptNotice({ a: 1 }, 'done')
    expect(first[1]).toEqual({ a: 1 })
    expect(first[2]).toBe('done')
    expect(first[0]).toMatch(/^[0-9a-f]{32}$/)
    expect(second[0]).not.toBe(first[0])
    expect(subscriptionNotice('feishu:oc_1:om_1')).toEqual(['subscription:feishu:oc_1:om_1',
      { subscription_changes: [{ thread: 'feishu:oc_1:om_1', removed: true }] }, 'Removed the subscriptions on thread feishu:oc_1:om_1'])
    expect(subscriptionNotice('feishu:oc_1:om_1', at)[1]).toEqual({ subscription_changes: [{ thread: 'feishu:oc_1:om_1',
      removed: true }], at })
    expect(threadFollowedNotice('t1', 'github:7', 'related issue')[1]).toMatchObject({
      thread_followed: { ticket_id: 't1', thread: 'github:7', reason: 'related issue' },
      note: 'For context only: its messages reach this ticket and grant nothing.' })
  })

  test('changedPaths 取两边键的并集逐层下钻，最多 20 条', () => {
    expect(changedPaths({ a: 1 }, { a: 1 })).toEqual([])
    expect(changedPaths({ a: 1 }, { a: 2 })).toEqual(['a'])
    expect(changedPaths(1, 2)).toEqual([''])
    expect(changedPaths({ a: { b: 1 } }, { a: { b: 2, c: 3 } })).toEqual(['a.b', 'a.c'])
    expect(changedPaths({ a: 1 }, { b: 2 })).toEqual(['a', 'b'])
    const many = (offset: number) => Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, index + offset]))
    expect(changedPaths(many(0), many(1))).toHaveLength(20)
  })

  test('事件通知：工单结束/触发再评估/线程被取消订阅，其它事件不求打扰', () => {
    const ended: DomainEvent = { type: 'ticket.ended', at, data: { ticketId: 't1', by: 'executor', outcome: 'completed' } }
    const withTicket = eventNotice(ended, () => ticket({ ended: { at, by: 'executor', outcome: 'completed' } }))
    expect(withTicket?.[1]).toMatchObject({ ticket_ended: { ticket_id: 't1', state: 'completed' } })
    // 卡片里的 preview 被剥掉，避免和通知一起重复出现。
    expect((withTicket?.[1].ticket_ended as Record<string, unknown>)).not.toHaveProperty('preview')
    expect(withTicket?.[2]).toBe('Ticket t1 ended (completed)')
    const withoutTicket = eventNotice({ ...ended, data: { ...ended.data, reason: 'done' } })
    expect(withoutTicket?.[1]).toEqual({ ticket_ended: 't1', by: 'executor', outcome: 'completed', reason: 'done', at })

    const requeued: DomainEvent = { type: 'trigger.requeued', at, data: { triggerId: 'e1' } }
    expect(eventNotice(requeued)?.[1]).toEqual({ trigger_requeued: 'e1', read: 'trigger/e1', at })

    const person: DomainEvent = { type: 'thread.unsubscribed', at, data: { threadKey: 'feishu:oc_1:om_1', ticketId: 't1', by: 'person' } }
    expect(eventNotice(person)?.[0]).toBe('subscription:feishu:oc_1:om_1')

    const executor: DomainEvent = { type: 'thread.unsubscribed', at,
      data: { threadKey: 'github:7', ticketId: 't1', by: 'executor', reason: 'unrelated' } }
    expect(eventNotice(executor)?.[1]).toMatchObject({ thread_unrelated: { ticket_id: 't1', thread: 'github:7', reason: 'unrelated' }, at })
    expect(eventNotice({ type: 'policy.changed', at, data: { from: 'a', to: 'b' } })).toBeUndefined()
  })

  test('resultRelay 超过 600 字只带摘要与总长；有 answer_to 时标明回的是哪条问题', () => {
    const short = resultRelay(ticket(), 'ready', 'done')
    expect(short.id).toMatch(/^report:/)
    expect(JSON.parse(short.text)).toMatchObject({ kind: 'worker_report', state: 'ready', summary: 'done',
      trigger_id: 'e1', read: 'ticket/t1/result' })
    const long = JSON.parse(resultRelay(ticket(), 'ready', 'x'.repeat(700)).text)
    expect(long.summary).toBe('x'.repeat(600))
    expect(long.chars).toBe(700)
    expect(JSON.parse(resultRelay(ticket(), 'ready', 'ok', 'e2').text).answer_to).toBe('e2')
  })

  test('reportRelay：问题转 attention，例行 progress 不打扰，答案与结果转报告', () => {
    const asked = reportRelay(ticket({ attention: { id: 'att', question: 'Which?' } }), { state: 'blocked', summary: 'need answer',
      question: 'Which?' })
    expect(asked?.id).toBe('attention:t1:att')
    expect(JSON.parse(asked!.text)).toMatchObject({ kind: 'worker_attention', state: 'blocked', read: 'ticket/t1/result' })
    expect(reportRelay(ticket(), { state: 'progress', summary: 'half' })).toBeUndefined()
    expect(reportRelay(ticket(), { state: 'progress', summary: 'half', answers: 'i1' })?.id).toMatch(/^report:/)
    expect(reportRelay(ticket(), { state: 'ready', summary: 'done' })?.id).toMatch(/^report:/)
  })
})

describe('notices：跟帖中继（真库）', () => {
  const opened: Store[] = []
  afterEach(() => {
    for (const store of opened.splice(0)) store.close()
  })
  function host() {
    const dir = createTempDir('dsc-sa-notices-')
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    opened.push(store)
    store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } } }))
    const sources = new SourceRegistry(() => store.settings())
    sources.register(feishuKind)
    return { store, sources }
  }

  test('跟帖有活工单决定时转给主会话；没有工单接手或工单已结束时静默', () => {
    const { store, sources } = host()
    expect(followupNotice(store, sources, 'missing')).toBeUndefined()

    store.triggers.save(trigger())
    expect(followupNotice(store, sources, 'e1')).toBeUndefined()

    store.tickets.save(ticket())
    store.triggers.saveDisposition('e1', { fanout: ['t1'], at })
    const relay = followupNotice(store, sources, 'e1')
    expect(relay?.id).toBe('followup:e1')
    const payload = JSON.parse(relay!.text)
    expect(payload).toMatchObject({ kind: 'follow_up', trigger_id: 'e1',
      delivered_to: [{ ticket_id: 't1', title: 'Fix the copy', state: 'working/queued' }] })
    expect(payload.note).toContain('Its ticket\'s worker has it and decides')

    // 只作上下文跟随的工单不算决定这条消息，中继静默。
    store.triggers.saveDisposition('e1', { fanout: ['t1'], context: ['t1'], at })
    expect(followupNotice(store, sources, 'e1')).toBeUndefined()

    // 工单结束后不再有工单决定这条消息。
    store.tickets.save({ ...store.tickets.get('t1')!, ended: { at, by: 'executor', outcome: 'completed' } })
    expect(followupNotice(store, sources, 'e1')).toBeUndefined()
  })

  test('followupRelay 的正文是稳定 JSON：id 按 trigger 命名，带上送达工单与说明', () => {
    const relay = followupRelay({ trigger_id: 'e1' }, [{ ticket_id: 't1', title: 'Fix', state: 'working' }])
    expect(relay.id).toBe('followup:e1')
    expect(JSON.parse(relay.text)).toEqual({ kind: 'follow_up', trigger_id: 'e1',
      delivered_to: [{ ticket_id: 't1', title: 'Fix', state: 'working' }],
      note: 'Its ticket\'s worker has it and decides; act only if the person asks to stop the work '
        + '(orchestrator_route kind stop with this trigger_id).' })
  })
})
