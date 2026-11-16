/**
 * superagent 包级测试的补盲：`wiring.spec.ts` 只碰到装配主路径（注册、设置、`/sa`、
 * 快照、两项体检的 skip/ok），这一份补它没走到的四块：
 *
 *   1. `core/replies.ts`：确认 / 回答 / 结果 / 提问四条回复规则的每个拒绝分支与幂等；
 *   2. `adapters/store-read.ts`：只读面（排序、过滤、分页夹取、坏 JSON、事件游标）；
 *   3. `health.ts`：可写失败、锁被占 / 探不了、running 卡住与读失败、飞书四档状态；
 *   4. `index.ts` 装配面：没有 health 服务时少登记、来源前置条件与启动 / 失败文案。
 *
 * 回复与只读面用真仓库（`MemoryRepositories` / `node:sqlite`），断言的是模块实际分支，
 * 不是另造一份假逻辑。`DSC_HOME` 在任何 import 之前指进临时目录，之后每条用例再换
 * 一个子目录，避免库文件与锁互相污染。
 *
 * @module dsc/packages/superagent/tests/wiring-extra.spec
 */
import type { HealthResult } from '@pneuma/runtime/services/types.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DscStore } from '../adapters/store.js'
import { acquireInstanceLock, openStore } from '../adapters/store.js'
import { openStoreRead } from '../adapters/store-read.js'
import { key } from '../core/ids.js'
import { MemoryRepositories } from '../core/memory.js'
import type { ChannelRef, Ticket, Trigger } from '../core/model.js'
import type { EngineOptions } from '../core/part.js'
import type { OutboundMessage, Outbox, Policy, ReplyStatus } from '../core/ports.js'
import { Replies } from '../core/replies.js'
import { createFeishuHealth, createSuperagentHealth } from '../health.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-superagent-extra-'))
process.env['DSC_HOME'] = HOME

/** 每条用例一个独立目录：sqlite 的 -wal/-shm 与锁不跨用例。 */
let CASE_HOME = HOME

type SuperagentIndex = typeof import('../index.js')
let index: SuperagentIndex
let warn: ReturnType<typeof vi.spyOn>

const cleanups: Array<() => void> = []
const stores: DscStore[] = []

beforeAll(async () => {
  index = await import('../index.js')
}, 60_000)

beforeEach(() => {
  CASE_HOME = mkdtempSync(join(tmpdir(), 'dsc-superagent-extra-case-'))
  process.env['DSC_HOME'] = CASE_HOME
  mkdirSync(HOME, { recursive: true })
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup()
    } catch {
      // 已经收过了
    }
  }
  warn.mockRestore()
  process.env['DSC_HOME'] = HOME
  if (CASE_HOME !== HOME) {
    try {
      rmSync(CASE_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // sqlite 的 -wal/-shm 偶尔还占着：临时目录留给系统清。
    }
  }
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 偶尔还占着 sqlite 的 -wal/-shm：临时目录留给系统清。
  }
})

// ── 共有夹具 ────────────────────────────────────────────────────────────────

const NOW = '2026-01-01T00:00:00.000Z'
const CHANNEL: ChannelRef = { source: 'feishu', thread: 't1', address: { chat: 'c1' } }

const POLICY: Policy = {
  version: '1',
  paused: false,
  gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } }),
  revalidate: () => true,
  admitsInferred: () => true,
  evalTimeoutMs: 1_000,
}

function triggerOf(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trig1',
    source: 'feishu',
    threads: [{ source: 'feishu', id: 't1' }],
    actor: { source: 'feishu', id: 'u1' },
    human: true,
    at: NOW,
    text: '请修登录',
    channel: CHANNEL,
    meta: {},
    ...overrides,
  }
}

function ticketOf(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'tk1',
    title: '修登录',
    decisionId: 'dec1',
    mandate: {
      strength: 'explicit',
      policyVersion: '1',
      basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'feishu', id: 'u1' },
      scope: 'chat',
    },
    channels: [CHANNEL],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: NOW,
    updatedAt: NOW,
    origin: { triggerId: 'trig1', triggerIds: ['trig1'] },
    ...overrides,
  }
}

/** 记录入队 / 撤回 / 状态的假 Outbox：send 与真实实现一样按 id 幂等。 */
function fakeOutbox(): {
  outbox: Outbox
  sent: OutboundMessage[]
  statuses: Map<string, ReplyStatus>
  withdrawn: string[]
} {
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

/** 直接构造 Replies：仓库是真的，其余端口只给 Reply 用得到的形状。 */
function replyHarness(seed: { tickets?: Ticket[]; triggers?: Trigger[]; dispositions?: Array<[string, Trigger['id']]> } = {}): {
  replies: Replies
  repo: MemoryRepositories
  box: ReturnType<typeof fakeOutbox>
} {
  const repo = new MemoryRepositories()
  for (const ticket of seed.tickets ?? []) repo.tickets.save(ticket)
  for (const trigger of seed.triggers ?? []) repo.triggers.save(trigger)
  for (const [triggerId, ticketId] of seed.dispositions ?? []) {
    repo.triggers.saveDisposition(triggerId, { fanout: [ticketId], at: NOW })
  }
  const box = fakeOutbox()
  const options: EngineOptions = {
    repo,
    policy: () => POLICY,
    scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request() {} },
    executor: { start() {}, deliver() {}, stop() {} },
    outbox: box.outbox,
    now: () => NOW,
  }
  return { replies: new Replies(options), repo, box }
}

// ── 1. 回复解析 ─────────────────────────────────────────────────────────────

describe('Replies：确认（acknowledgement）', () => {
  test('acknowledgeAccepted 只在「有通道 + 人写的」原消息上排队，id 由 trigger 派生', () => {
    const { replies, box } = replyHarness()

    replies.acknowledgeAccepted('tk1', triggerOf(), '收到，我在看')
    expect(box.sent).toEqual([{
      id: key('ack', 'trig1'),
      channel: CHANNEL,
      text: '收到，我在看',
      kind: 'acknowledgement',
      ticketId: 'tk1',
    }])

    replies.acknowledgeAccepted('tk1', triggerOf({ id: 'bot', human: false }), '机器人消息不回')
    replies.acknowledgeAccepted('tk1', triggerOf({ id: 'no-channel', channel: undefined }), '没有通道不回')
    expect(box.sent).toHaveLength(1)
  })

  test('reply 确认：入队一次、记下 takeUp、第二次标 reused', () => {
    const { replies, repo, box } = replyHarness({
      tickets: [ticketOf()],
      triggers: [triggerOf()],
      dispositions: [['trig1', 'tk1']],
    })

    const first = replies.reply({ purpose: 'acknowledgement', ticketId: 'tk1', triggerId: 'trig1', text: '收到' })
    expect(first).toEqual({ id: key('ack', 'trig1'), status: 'pending', reused: false })
    expect(box.sent[0]).toMatchObject({ kind: 'acknowledgement', ticketId: 'tk1' })
    expect(repo.triggers.disposition('trig1')?.acked).toEqual(['tk1'])

    const again = replies.reply({ purpose: 'acknowledgement', ticketId: 'tk1', triggerId: 'trig1', text: '收到' })
    expect(again).toEqual({ id: key('ack', 'trig1'), status: 'pending', reused: true })
    expect(box.sent).toHaveLength(1)
  })

  test('reply 确认：工单不存在 / 已结束各自报 missing 与 refused', () => {
    const ended = ticketOf({ id: 'ended', ended: { at: NOW, by: 'human', outcome: 'stopped' } })
    const { replies } = replyHarness({ tickets: [ticketOf(), ended], triggers: [triggerOf()] })

    expect(() => replies.reply({ purpose: 'acknowledgement', ticketId: 'ghost', triggerId: 'trig1', text: 'x' }))
      .toThrow('Unknown ticket')
    expect(() => replies.reply({ purpose: 'acknowledgement', ticketId: 'ended', triggerId: 'trig1', text: 'x' }))
      .toThrow('Ticket ended; do not acknowledge historical requests')
  })

  test('reply 确认：未知 trigger、未到达、没通道、非人所写各有专用文案', () => {
    const unknown = replyHarness({ tickets: [ticketOf()], triggers: [triggerOf()] })
    expect(() => unknown.replies.reply({ purpose: 'acknowledgement', ticketId: 'tk1', triggerId: 'ghost', text: 'x' }))
      .toThrow('Unknown trigger')

    const far = replyHarness({
      tickets: [ticketOf()],
      triggers: [triggerOf({ id: 'other', threads: [{ source: 'feishu', id: 't2' }] })],
    })
    expect(() => far.replies.reply({ purpose: 'acknowledgement', ticketId: 'tk1', triggerId: 'other', text: 'x' }))
      .toThrow('Trigger does not belong to this worker')

    const noChannel = replyHarness({ tickets: [ticketOf()], triggers: [triggerOf({ channel: undefined })] })
    expect(() => noChannel.replies.reply({ purpose: 'acknowledgement', ticketId: 'tk1', triggerId: 'trig1', text: 'x' }))
      .toThrow('Acknowledgement requires an assigned human source message')

    const bot = replyHarness({ tickets: [ticketOf()], triggers: [triggerOf({ human: false })] })
    expect(() => bot.replies.reply({ purpose: 'acknowledgement', ticketId: 'tk1', triggerId: 'trig1', text: 'x' }))
      .toThrow('Use the original human trigger, not a bot, CI or worker report')
  })

  test('已排队的确认对机器人 trigger 也放行：认下 takeUp、不重发', () => {
    const { replies, repo, box } = replyHarness({
      tickets: [ticketOf()],
      triggers: [triggerOf({ human: false })],
      dispositions: [['trig1', 'tk1']],
    })
    box.outbox.send({ id: key('ack', 'trig1'), channel: CHANNEL, text: '早先排的', kind: 'acknowledgement', ticketId: 'tk1' })

    const reply = replies.reply({ purpose: 'acknowledgement', ticketId: 'tk1', triggerId: 'trig1', text: '后来这条' })
    expect(reply.reused).toBe(true)
    expect(box.sent).toHaveLength(1)
    expect(repo.triggers.disposition('trig1')?.acked).toEqual(['tk1'])
  })

  test('withdrawAttention 按 attention id 收回尚未发出的提问', () => {
    const { replies, box } = replyHarness()
    replies.withdrawAttention('att1')
    expect(box.withdrawn).toEqual([key('attention-reply', 'att1')])
  })
})

describe('Replies：结果（result）', () => {
  test('三种结束态 completed / merged / dropped 都能交付结果', () => {
    const tickets = (['completed', 'merged', 'dropped'] as const).map((outcome) =>
      ticketOf({ id: `tk-${outcome}`, ended: { at: NOW, by: 'executor', outcome } }))
    const { replies, box } = replyHarness({ tickets })

    for (const outcome of ['completed', 'merged', 'dropped'] as const) {
      const reply = replies.reply({ purpose: 'result', ticketId: `tk-${outcome}`, text: `结果 ${outcome}` })
      expect(reply.status).toBe('pending')
    }
    expect(box.sent.map((message) => message.ticketId)).toEqual(['tk-completed', 'tk-merged', 'tk-dropped'])
    expect(box.sent.every((message) => message.kind === 'reply')).toBe(true)
  })

  test('未结束但最新分配报了 ready，也算可交付', () => {
    const ready = ticketOf({
      assignments: [{ id: 'a1', state: 'running', createdAt: NOW, report: { state: 'ready', summary: '做完了', at: NOW } }],
    })
    const { replies, box } = replyHarness({ tickets: [ready], triggers: [triggerOf()] })

    expect(replies.reply({ purpose: 'result', ticketId: 'tk1', text: '完成' }).status).toBe('pending')
    expect(box.sent[0]).toMatchObject({ text: '完成', ticketId: 'tk1' })
  })

  test('未 ready 的结果都拒绝：开着没报告、closed、stopped、找不到工单', () => {
    const open = ticketOf({ id: 'open' })
    const closed = ticketOf({ id: 'closed', ended: { at: NOW, by: 'executor', outcome: 'closed' } })
    const stopped = ticketOf({ id: 'stopped', ended: { at: NOW, by: 'human', outcome: 'stopped' } })
    const { replies } = replyHarness({
      tickets: [open, closed, stopped],
      triggers: [triggerOf({ id: 'orphan' })],
    })

    expect(() => replies.reply({ purpose: 'result', ticketId: 'open', text: '还没好' }))
      .toThrow('Ticket is not ready for delivery')
    expect(() => replies.reply({ purpose: 'result', ticketId: 'closed', text: '关了但没成' }))
      .toThrow('Ticket is not ready for delivery')
    expect(() => replies.reply({ purpose: 'result', ticketId: 'stopped', text: '人停了' }))
      .toThrow('Ticket is not ready for delivery')
    // 不带 ticketId、trigger 也没到达任何工单：ticket 为 undefined，同样走 notReady。
    expect(() => replies.reply({ purpose: 'result', triggerId: 'orphan', text: '不知道给谁' }))
      .toThrow('Ticket is not ready for delivery')
  })
})

describe('Replies：提问（attention）与回答（answer）', () => {
  test('提问回复去「提问人那条消息」的通道；没有提问人时退回工单起始通道', () => {
    const askerChannel: ChannelRef = { source: 'feishu', thread: 't9', address: { chat: 'c9' } }
    const withAsker = ticketOf({
      id: 'with-asker',
      attention: { id: 'att1', question: '要合并吗？', triggerId: 'asker' },
    })
    const noAsker = ticketOf({ id: 'no-asker', attention: { id: 'att2', question: '继续吗？' } })
    const { replies, box } = replyHarness({
      tickets: [withAsker, noAsker],
      triggers: [triggerOf(), triggerOf({ id: 'asker', channel: askerChannel })],
    })

    replies.reply({ purpose: 'attention', ticketId: 'with-asker', question: '要合并吗？', text: '可以' })
    expect(box.sent.at(-1)).toMatchObject({ id: key('attention-reply', 'att1'), channel: askerChannel, text: '可以' })

    replies.reply({ purpose: 'attention', ticketId: 'no-asker', question: '继续吗？', text: '继续' })
    expect(box.sent.at(-1)).toMatchObject({ id: key('attention-reply', 'att2'), channel: CHANNEL, text: '继续' })
  })

  test('提问回复：问题文本对不上、工单根本没有提问，都拒绝', () => {
    const asked = ticketOf({ id: 'asked', attention: { id: 'att1', question: '要合并吗？' } })
    const quiet = ticketOf({ id: 'quiet' })
    const { replies } = replyHarness({ tickets: [asked, quiet], triggers: [triggerOf()] })

    expect(() => replies.reply({ purpose: 'attention', ticketId: 'asked', question: '另一个问题', text: 'x' }))
      .toThrow('Attention requires the ticket')
    expect(() => replies.reply({ purpose: 'attention', ticketId: 'quiet', question: '要合并吗？', text: 'x' }))
      .toThrow('Attention requires the ticket')
  })

  test('回答人问题：发到原消息通道、带上工单 id，并把 answers 里的 trigger 消掉', () => {
    const { replies, repo, box } = replyHarness({
      tickets: [ticketOf({ answers: ['trig1'] })],
      triggers: [triggerOf()],
    })

    const reply = replies.reply({ purpose: 'answer', ticketId: 'tk1', triggerId: 'trig1', text: '修好了' })
    expect(reply.id).toBe(key('reply', 'trig1', '修好了'))
    expect(box.sent[0]).toMatchObject({ id: reply.id, channel: CHANNEL, text: '修好了', kind: 'reply', ticketId: 'tk1' })
    expect(repo.tickets.get('tk1')?.answers).toEqual([])
  })

  test('回答拒绝：非人所写、没有待回答、trigger 不存在', () => {
    const bot = replyHarness({ tickets: [ticketOf()], triggers: [triggerOf({ human: false })] })
    expect(() => bot.replies.reply({ purpose: 'answer', ticketId: 'tk1', triggerId: 'trig1', text: 'x' }))
      .toThrow('An answer must target the original human question')

    const unasked = replyHarness({ tickets: [ticketOf({ answers: [] })], triggers: [triggerOf()] })
    expect(() => unasked.replies.reply({ purpose: 'answer', ticketId: 'tk1', triggerId: 'trig1', text: 'x' }))
      .toThrow('No worker answer is ready')

    const unknown = replyHarness({ tickets: [ticketOf()], triggers: [triggerOf()] })
    expect(() => unknown.replies.reply({ purpose: 'answer', ticketId: 'tk1', triggerId: 'ghost', text: 'x' }))
      .toThrow('Unknown trigger')
  })

  test('不带 ticketId 时按 trigger 找到它到达的工单；已排队的不重复入队', () => {
    const { replies, repo, box } = replyHarness({
      tickets: [ticketOf({ answers: ['trig1'] })],
      triggers: [triggerOf()],
    })

    const first = replies.reply({ purpose: 'answer', triggerId: 'trig1', text: '答案' })
    expect(first.reused).toBe(false)
    expect(box.sent[0]).toMatchObject({ ticketId: 'tk1', text: '答案' })
    expect(repo.tickets.get('tk1')?.answers).toEqual([])

    // 同一条回答再发一次：id 相同，outbox 说已存在，于是 reused 而不是 noAnswer。
    const again = replies.reply({ purpose: 'answer', triggerId: 'trig1', text: '答案' })
    expect(again.reused).toBe(true)
    expect(box.sent).toHaveLength(1)
  })

  test('结果回复没有可用通道时报 noChannel（工单与原始 trigger 都没有通道）', () => {
    const bare = ticketOf({
      id: 'bare',
      channels: [],
      ended: { at: NOW, by: 'executor', outcome: 'completed' },
    })
    const { replies } = replyHarness({ tickets: [bare] })
    expect(() => replies.reply({ purpose: 'result', ticketId: 'bare', text: '结果' }))
      .toThrow('No reply channel for this ticket or trigger')
  })
})

// ── 2. 只读查询面 ──────────────────────────────────────────────────────────

/** 建一个真库并种三张工单（t1 → t3 为插入顺序，读出来应当倒序）。 */
function seededStore(): DscStore {
  const store = openStore()
  stores.push(store)
  store.createTicket({ id: 't1', title: '第一张', task: 'a', state: 'queued', at: '2026-01-01T00:00:01.000Z' })
  store.createTicket({ id: 't2', title: '第二张', task: 'b', state: 'merged', at: '2026-01-01T00:00:02.000Z' })
  store.createTicket({ id: 't3', title: '第三张', task: 'c', state: 'queued', at: '2026-01-01T00:00:03.000Z' })
  return store
}

describe('store-read：只读查询面', () => {
  test('库不存在报 store_missing，不替写方建库', () => {
    const missing = join(CASE_HOME, 'superagent', 'never-created.sqlite')
    let caught: unknown
    try {
      openStoreRead(missing)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'store_missing' })
    expect(String((caught as Error).message)).toContain('还没有编排库')
  })

  test('listTickets 新的在前；limit 夹到 1–500、offset 夹到 0 起', () => {
    seededStore()
    const read = openStoreRead()
    try {
      expect(read.listTickets().map((ticket) => ticket.id)).toEqual(['t3', 't2', 't1'])
      expect(read.listTickets({ limit: 0 }).map((ticket) => ticket.id)).toEqual(['t3'])
      expect(read.listTickets({ limit: 9_999 }).map((ticket) => ticket.id)).toEqual(['t3', 't2', 't1'])
      expect(read.listTickets({ limit: 1, offset: 1 }).map((ticket) => ticket.id)).toEqual(['t2'])
      expect(read.listTickets({ offset: -5 })).toHaveLength(3)
    } finally {
      read.close()
    }
  })

  test('listTickets 按状态过滤；坏 JSON 行不参与过滤但会以 unknown 出现在全量里', () => {
    const store = seededStore()
    store.handle.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run('bad', '{broken')
    store.handle.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run('empty', JSON.stringify({ state: '' }))

    const read = openStoreRead()
    try {
      expect(read.listTickets({ state: 'merged' }).map((ticket) => ticket.id)).toEqual(['t2'])
      // 坏行只影响全量：decodeTicketValue 把它收敛成 id + 缺省值，而不是让列表抛错。
      const bad = read.listTickets().find((ticket) => ticket.id === 'bad')
      expect(bad).toMatchObject({ id: 'bad', title: '', task: '', state: 'unknown' })
    } finally {
      read.close()
    }
  })

  test('getTicket 不存在给 null；坏 JSON 行回落缺省字段', () => {
    const store = seededStore()
    store.handle.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run('bad', 'not-json')
    const read = openStoreRead()
    try {
      expect(read.getTicket('t1')).toMatchObject({ id: 't1', title: '第一张', state: 'queued' })
      expect(read.getTicket('nope')).toBeNull()
      expect(read.getTicket('bad')).toMatchObject({ id: 'bad', title: '', state: 'unknown' })
    } finally {
      read.close()
    }
  })

  test('listEvents 按 seq 升序、sinceSeq 只取之后；非法游标报 event_invalid', () => {
    const store = seededStore()
    store.appendEvent('t1', 'created', { by: 'alice' })
    store.appendEvent('t1', 'progress', null)
    store.appendEvent('t1', 'done', 'ok')
    store.handle
      .prepare('INSERT INTO event (ticket, seq, kind, payload, at) VALUES (?, ?, ?, ?, ?)')
      .run('t1', 4, 'raw', '{broken', NOW)

    const read = openStoreRead()
    try {
      const all = read.listEvents('t1')
      expect(all.map((event) => event.seq)).toEqual([1, 2, 3, 4])
      expect(all[0]?.payload).toEqual({ by: 'alice' })
      expect(all[1]?.payload).toBeNull()
      expect(all[3]?.payload).toBe('{broken') // 认不出就交回原文，不毁整段历史

      expect(read.listEvents('t1', 2).map((event) => event.seq)).toEqual([3, 4])

      for (const bad of [-1, 1.5, Number.NaN]) {
        let caught: unknown
        try {
          read.listEvents('t1', bad)
        } catch (error) {
          caught = error
        }
        expect(caught).toMatchObject({ code: 'event_invalid' })
      }
    } finally {
      read.close()
    }
  })

  test('countByState 汇总各状态，空状态与坏 JSON 都归 unknown；close 可重复调', () => {
    const store = seededStore()
    store.createTicket({ id: 't4', title: '第四张', task: 'd', state: 'completed' })
    store.handle.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run('bad', '{broken')
    store.handle.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run('empty', JSON.stringify({ state: '' }))

    const read = openStoreRead()
    try {
      expect(read.countByState()).toEqual({ queued: 2, merged: 1, completed: 1, unknown: 2 })
    } finally {
      read.close()
      expect(() => read.close()).not.toThrow()
    }
  })
})

// ── 3. 健康检查 ────────────────────────────────────────────────────────────

/** 可写 / 不可写的假库：体检只用到 `atomic`。 */
function fakeStore(problem?: Error): DscStore {
  return {
    atomic<T>(work: () => T): T {
      if (problem !== undefined) throw problem
      return work()
    },
  } as unknown as DscStore
}

/** 体检实现是同步的；类型允许返回 Promise，这里收成同步结果。 */
function runNow(check: { run(): HealthResult | Promise<HealthResult> }): HealthResult {
  return check.run() as HealthResult
}

function orchestratorHealth(options: {
  store?: DscStore | null
  running?: () => { total: number; orphaned: number }
} = {}): ReturnType<typeof createSuperagentHealth> {
  return createSuperagentHealth({
    store: () => (options.store === undefined ? fakeStore() : options.store),
    running: options.running ?? (() => ({ total: 0, orphaned: 0 })),
  })
}

describe('health：编排库', () => {
  test('库还没打开 → skip，detail 仍给出库路径', () => {
    const result = runNow(orchestratorHealth({ store: null }))
    expect(result.status).toBe('skip')
    expect(result.summary).toContain('还没启动')
    expect(result.detail).toContain('orchestrator.sqlite')
  })

  test('库不可写 → fail，summary 与 fix 指向磁盘 / 只读 / 独占', () => {
    const result = runNow(orchestratorHealth({ store: fakeStore(new Error('disk full')) }))
    expect(result.status).toBe('fail')
    expect(result.summary).toBe('编排库不可写，工单派不出去')
    expect(result.detail).toContain('写：不可写（disk full）')
    expect(result.fix).toContain('磁盘是否满')
  })

  test('锁被另一个实例占着 → warn，并提示关掉多余的 Pneuma', () => {
    const held = acquireInstanceLock()
    try {
      const result = runNow(orchestratorHealth())
      expect(result.status).toBe('warn')
      expect(result.summary).toBe('编排库的锁被另一个进程占着')
      expect(result.detail).toContain('锁：被另一个进程占着')
      expect(result.fix).toContain('第二个 Pneuma')
    } finally {
      held.release()
    }
  })

  test('锁探测本身失败 → warn「锁探测失败（库本身可写）」并把原因写进 detail', () => {
    // 让 `<DSC_HOME>/superagent` 是一个文件：锁目录建不出来，acquireInstanceLock 抛普通错误。
    const blocked = join(HOME, 'health-blocked')
    mkdirSync(blocked, { recursive: true })
    writeFileSync(join(blocked, 'superagent'), 'not a directory', 'utf8')
    process.env['DSC_HOME'] = blocked
    try {
      const result = runNow(orchestratorHealth())
      expect(result.status).toBe('warn')
      expect(result.summary).toBe('锁探测失败（库本身可写）')
      expect(result.detail).toContain('锁：探不了（')
    } finally {
      process.env['DSC_HOME'] = CASE_HOME
    }
  })

  test('有工单卡在 running → warn，detail 同时给总数与没有 worker 的张数', () => {
    const result = runNow(orchestratorHealth({ running: () => ({ total: 3, orphaned: 2 }) }))
    expect(result.status).toBe('warn')
    expect(result.summary).toBe('2 张工单卡在 running，进程里没有 worker')
    expect(result.detail).toContain('running 工单：3 张（其中 2 张进程里没有 worker）')
    expect(result.fix).toContain('/sa retry')
  })

  test('running 读数抛错只记一句，不把整项判失败', () => {
    const result = runNow(orchestratorHealth({
      running: () => {
        throw new Error('db is locked')
      },
    }))
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('running 工单：读不出来（db is locked）')
    expect(result.detail).toContain('running 工单：没有')
  })
})

describe('health：飞书来源', () => {
  test('来源没启动 → skip，而不是把「没这回事」报成 ok', () => {
    const result = runNow(createFeishuHealth({ status: () => null }))
    expect(result.status).toBe('skip')
    expect(result.summary).toContain('未启动')
    expect(result.detail).toContain('默认关')
  })

  test('有 lastError 且长连接还在 → warn；连接也断了 → warn 说没连上', () => {
    const connected = runNow(createFeishuHealth({
      status: () => ({ connected: true, lastPollAt: NOW, lastError: '限流 429' }),
    }))
    expect(connected.status).toBe('warn')
    expect(connected.summary).toBe('飞书长连接连着，但最近一轮读取失败')
    expect(connected.detail).toContain('最近一条错误：限流 429')
    expect(connected.fix).toContain('lark-cli auth status')

    const disconnected = runNow(createFeishuHealth({
      status: () => ({ connected: false, lastPollAt: null, lastError: '鉴权失败' }),
    }))
    expect(disconnected.status).toBe('warn')
    expect(disconnected.summary).toBe('飞书长连接没连上')
    expect(disconnected.detail).toContain('补收：还没跑过一轮')
  })

  test('没有错误但长连接没连上 → warn「在补收，但长连接没连上」', () => {
    const result = runNow(createFeishuHealth({
      status: () => ({ connected: false, lastPollAt: NOW, lastError: null }),
    }))
    expect(result.status).toBe('warn')
    expect(result.summary).toBe('飞书来源在补收，但长连接没连上')
    expect(result.detail).toContain(`补收：上一轮在 ${NOW}`)
  })

  test('连接正常 → ok，detail 说明上一轮时间', () => {
    const fresh = runNow(createFeishuHealth({
      status: () => ({ connected: true, lastPollAt: null, lastError: null }),
    }))
    expect(fresh.status).toBe('ok')
    expect(fresh.detail).toContain('补收：还没跑过一轮')

    const polled = runNow(createFeishuHealth({
      status: () => ({ connected: true, lastPollAt: NOW, lastError: null }),
    }))
    expect(polled.status).toBe('ok')
    expect(polled.summary).toContain('飞书来源正常')
    expect(polled.detail).toContain(`补收：上一轮在 ${NOW}`)
  })
})

// ── 4. 装配面补盲 ──────────────────────────────────────────────────────────

interface Harness {
  sections: Array<Record<string, unknown> & {
    values(): Record<string, unknown>
    save(key: string, value: unknown): string | void
  }>
  services: Map<string, unknown>
  events: string[]
  checks: Array<{ id: string }>
  disposers: Array<() => void>
}

/** 与 `wiring.spec.ts` 同形的假 ctx：只收挂载点，`effect` 真执行并攒 disposer。 */
function runApply(passed?: unknown, options: { health?: unknown } = {}): Harness {
  const sections: Harness['sections'] = []
  const services = new Map<string, unknown>()
  const events: string[] = []
  const disposers: Harness['disposers'] = []
  const checks: Harness['checks'] = []
  if (options.health !== undefined) services.set('health', options.health)

  const ctx = {
    effect(fn: () => unknown) {
      const off = fn()
      if (typeof off === 'function') disposers.push(off as () => void)
      return () => {}
    },
    get: (name: string) => services.get(name),
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    emit(event: string) {
      events.push(event)
    },
    settings: {
      registerSection(section: Harness['sections'][number]) {
        sections.push(section)
        return () => {}
      },
    },
    commands: { register: () => () => {} },
    surfaces: { register: () => () => {} },
    transcript: { system: () => {} },
  }
  index.apply(ctx as never, passed)
  const harness: Harness = { sections, services, events, checks, disposers }
  cleanups.push(() => {
    for (const off of disposers.splice(0).reverse()) off()
  })
  return harness
}

function serviceOf(harness: Harness): { surface(): Record<string, unknown> } {
  return harness.services.get('superagent') as { surface(): Record<string, unknown> }
}

function warned(): string {
  return warn.mock.calls.flat().join('\n')
}

describe('装配面补盲', () => {
  test('没有 health 服务时照常装配，只是少登记两项体检', () => {
    const harness = runApply()
    expect(harness.services.get('superagent')).toBeDefined()
    expect(harness.checks).toEqual([])
    expect(serviceOf(harness).surface()).toMatchObject({ ready: true })
  })

  test('设置面 values() 的缺省值：数字回落、名单是空串、开关是 false', () => {
    const values = runApply().sections[0]!.values()
    expect(values).toMatchObject({
      repoPath: '',
      maxWorkers: 2,
      ticketTimeoutSeconds: 1800,
      githubAllowed: '',
      githubTokenEnv: 'GITHUB_TOKEN',
      feishuChats: '',
      feishuEnabled: false,
      feishuDirect: false,
      assessorModel: '',
    })
  })

  test('GitHub 三字段配全且环境变量有令牌 → 来源启动，日志说明仓库与 30 秒一拍', () => {
    process.env['DSC_EXTRA_GH_TOKEN'] = 'ghp_test_only'
    try {
      const harness = runApply({
        githubRepository: 'owner/name',
        githubLogin: 'bot',
        githubAllowed: 'alice',
        githubTokenEnv: 'DSC_EXTRA_GH_TOKEN',
      })
      serviceOf(harness).surface()
      expect(warned()).toContain('GitHub 来源已启动：owner/name，每 30 秒一拍')
    } finally {
      delete process.env['DSC_EXTRA_GH_TOKEN']
    }
  })

  test('飞书开关打开、群也填了，但 CLI 解析不到 → 只记一行「没启动」，不抛', () => {
    const harness = runApply({
      feishuEnabled: true,
      feishuChats: 'oc_1',
      feishuCli: join(CASE_HOME, 'no-such-dir', 'lark-cli'),
    })
    expect(() => serviceOf(harness).surface()).not.toThrow()
    expect(warned()).toContain('飞书来源没启动：')
    expect(warned()).not.toContain('飞书来源已启动')
  })
})
