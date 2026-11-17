/**
 * @pneuma/superagent 模型卡片投影的包级测试：trigger 卡、ticket 卡与详情、decision 卡与详情、thread 卡，
 * 以及「预览只压空白、不动正文写法」这条。
 *
 * 为什么这些要单独钉：这些投影是模型唯一看得到的上下文入口，判错不报错，只会让模型读错：状态词错了
 * （`person/review` 写成 `working`）会重复催工；工单输入翻页按旧到新排会把最新一条挤掉；把 Decision 的
 * 内部哈希（`eval_id` / `policy_version`）吐给模型会诱导它按哈希找资源；预览顺手删掉反引号或链接会把
 * 「照原文读」变成「读残文」。所以断言按字段逐个盯。
 *
 * 假的只有对象字面量：Ticket / Trigger / Decision / Thread 的字段按 `core/model.ts` 的形状手写，
 * 只填被测投影会读的字段。`key()` / `said()` 用真的，因为输入资源路径与原因文案就是被测行为的一部分。
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * 说明：上游 `tests/cards.spec.ts` 前半段（约 1~118 行）测的是 `app/context.ts` / `app/prompts.ts` /
 * `app/skill-files.ts` 的提示词契约，不是本文件被测的 `app/cards.ts`，且本仓 worker 提示词已中文化重写
 * （见报告），故不在此转写；本文件只覆盖上游同 spec 里 cards.ts 的五组用例。
 *
 * @module @pneuma/superagent/tests/cards
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { TICKET_STATES, decisionCard, decisionDetails, threadCard, ticketCard, ticketDetails, triggerCard }
  = await import('../../../../lib/packages/superagent/app/cards.js')
const { key, said } = await import('../../../../lib/packages/superagent/core/index.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

const at = '2026-09-09T00:00:00Z'
const trigger = {
  id: 'request-1', source: 'github', threads: [{ source: 'github', id: '42' }],
  actor: { source: 'github', id: 'alice' }, human: true, at,
  text: 'Please inspect the failing check.\n' + 'Additional context. '.repeat(20), meta: {},
}
const SUMMARY = 'The focused check passed.\n' + 'Detailed evidence. '.repeat(20)
const ticket = {
  id: 'ticket-1', title: 'Inspect failing check', decisionId: 'd1', channels: [], inputs: [], undelivered: [],
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed', sender: 'Alice' }, actor: trigger.actor, scope: 'small' },
  assignments: [{ id: 'a1', state: 'running', createdAt: at, startedAt: at, report: { state: 'ready', summary: SUMMARY, at: '' } }],
  createdAt: at, updatedAt: at,
  origin: { triggerId: 'request-1', triggerIds: ['request-1'] },
  execution: { name: 'ticket-1', directory: '/worktrees/ticket-1', assignment: 'Inspect the check.' },
  follows: [{ thread: 'github:42', own: true }],
}

// ── 1. trigger 卡与 ticket 详情：短预览 + 指向正文的资源名 ──────────────────

test('trigger 卡与 ticket 详情：预览截断到 160 字，正文留在可读资源里', () => {
  const card = triggerCard(trigger, { fanout: ['ticket-1'], evalId: 'e1', decisionId: 'd1', at: '' })
  const { preview: shown, ...rest } = card
  assert.deepEqual(rest, {
    trigger_id: 'request-1', source: 'github', actor: 'alice', thread: 'github:42', human: true, at,
    chars: trigger.text.length, read: 'trigger/request-1',
    disposition: { decision_id: 'd1', delivered_to: ['ticket-1'] },
  })
  assert.equal(shown.length, 160)
  assert.match(shown, /^Please inspect the failing check\. Additional context\. /)

  const threads = [{ thread: 'github:42', bound: true }]
  const batch = [{ ...trigger, id: 'request-2', text: 'Also the flaky one.' }]
  const details = ticketDetails(ticket, threads, batch)
  const assignment = details.assignments.items[0]
  assert.match(assignment.report.preview, /^The focused/)
  assert.equal(assignment.report.preview.length, 100, 'assignment 行的预览截到 100 字')
  assert.deepEqual(details, {
    ticket_id: 'ticket-1', title: 'Inspect failing check', state: 'person/review', strength: 'explicit', pr_number: 42,
    read: 'ticket/ticket-1', trigger_id: 'request-1', decision_id: 'd1',
    batch: [{ trigger_id: 'request-2', from: 'alice', at, preview: 'Also the flaky one.', read: 'trigger/request-2' }],
    threads, directory: '/worktrees/ticket-1', scope: 'small', requested_by: 'alice',
    inputs: { items: [] },
    assignments: { items: [{ id: 'a1', state: 'running', at, report: { state: 'ready', at: '', preview: assignment.report.preview,
      chars: SUMMARY.length, read: 'ticket/ticket-1/report/a1' } }] },
    assignment: 'ticket/ticket-1/assignment', result: 'ticket/ticket-1/result', transcript: 'ticket/ticket-1/transcript',
  })
  passed += 1
})

test('worker 视角不出现 Decision 的 id；最近 10 条输入按新到旧分页，短文本内联长文本给预览', () => {
  // 同一张工单，带一条 reopen 输入：主人视角看得见 decision_id，worker 视角看不见。
  const reopened = { ...ticket, inputs: [{ id: 'r', kind: 'reopen', decisionId: 'd2', at: '1' }] }
  const ownerView = ticketDetails(reopened, [], [])
  assert.equal(ownerView.inputs.items[0].decision_id, 'd2')
  const workerView = ticketDetails(reopened, [], [], true)
  assert.deepEqual(workerView.inputs.items[0], { kind: 'reopen', at: '1', read: `ticket/ticket-1/input/${key('r')}` })
  assert.doesNotMatch(JSON.stringify(workerView), /"d[12]"/, 'worker 不认任何 Decision 的 id')

  const inputs = Array.from({ length: 12 }, (_, n) => ({ id: `text:${n}`, kind: 'text', text: `Note ${n}`, at: String(n) }))
  const page = ticketDetails({
    ...ticket,
    inputs: [...inputs, { id: 'text:long', kind: 'text', text: 'Long note. '.repeat(10), at: '12' }],
    undelivered: ['text:11'],
  }, [], []).inputs
  assert.equal(page.items.length, 10, '一页最多 10 条')
  const newest = page.items[0]
  assert.deepEqual({ ...newest, preview: undefined }, {
    kind: 'text', at: '12', preview: undefined, chars: 110, read: `ticket/ticket-1/input/${key('text:long')}`,
  })
  assert.match(newest.preview, /^Long note\./)
  assert.equal(newest.text, undefined, '超 80 字的文本只给预览，正文走资源')
  assert.deepEqual(page.items[1], { kind: 'text', at: '11', text: 'Note 11', undelivered: true })
  assert.equal(page.next_resource, 'ticket/ticket-1/inputs')
  assert.equal(page.next_offset, 10)
  passed += 1
})

// ── 2. ticket 卡状态取自闭合集合 ───────────────────────────────────────────

test('ticket 卡状态：未结束的取阶段，结束的取结果，且一定落在 TICKET_STATES 里', () => {
  const report = (state) => ({ ...ticket, assignments: [{ ...ticket.assignments[0], report: { state, summary: '', at: '' } }] })
  const cases = [
    [ticket, 'person/review'],
    [report('blocked'), 'person/blocked'],
    [report('failed'), 'person/failed'],
    [report('waiting'), 'idle'],
    [report('progress'), 'working'],
    [{ ...ticket, attention: { id: 'q', question: 'Desktop too?' } }, 'person/answer'],
    [{ ...ticket, delivery: { error: 'gone', at: '' } }, 'person/delivery'],
    [{ ...ticket, assignments: [{ ...ticket.assignments[0], state: 'pending', report: undefined }] }, 'working/queued'],
    [{ ...ticket, ended: { at: 'e', by: 'human', reason: 'Not needed after all', outcome: 'stopped' } }, 'stopped'],
    [{ ...ticket, ended: { at: 'e', by: 'executor', reason: 'merged', outcome: 'merged' } }, 'merged'],
  ]
  for (const [item, state] of cases) assert.equal(ticketCard(item).state, state)
  assert.equal(cases.every(([item]) => TICKET_STATES.includes(ticketCard(item).state)), true)
  assert.deepEqual(ticketCard(cases[8][0]).ended, { at: 'e', by: 'human', reason: 'Not needed after all' })
  assert.deepEqual({ ticket_id: ticketCard(ticket).ticket_id, pr_number: ticketCard(ticket).pr_number, strength: ticketCard(ticket).strength },
    { ticket_id: 'ticket-1', pr_number: 42, strength: 'explicit' })
  assert.equal('attention' in ticketCard(ticket), false)
  assert.deepEqual(ticketCard({ ...ticket, attention: { id: 'q', question: 'Desktop too?' } }).attention, { question: 'Desktop too?' })
  passed += 1
})

// ── 3. decision 卡与详情 ────────────────────────────────────────────────────

test('decision 卡：snake_case 键 + 指向详情的资源名；详情不吐内部哈希', () => {
  const decision = {
    id: 'd1', evalId: 'e1', threadKey: 'github:42', triggerIds: ['request-1'], policyVersion: 'v1', at: 'a', kind: 'accept',
    reason: [said('r')], strength: 'explicit', ticketId: 'ticket-1', audit: { matches: [] },
  }
  assert.deepEqual(decisionCard(decision), {
    decision_id: 'd1', kind: 'accept', reason: 'r', strength: 'explicit', thread: 'github:42',
    trigger_ids: ['request-1'], ticket_id: 'ticket-1', at: 'a', read: 'decision/d1',
  })
  assert.deepEqual({ decision_id: decisionDetails(decision).decision_id, audit: decisionDetails(decision).audit },
    { decision_id: 'd1', audit: { matches: [] } })
  assert.equal('eval_id' in decisionDetails(decision), false, 'Eval 的 id 是哈希，没人按它取资源')
  assert.equal('policy_version' in decisionDetails(decision), false)
  passed += 1
})

// ── 4. thread 卡 ────────────────────────────────────────────────────────────

test('thread 卡带上订阅工单与评估状态，pending 只给条数', () => {
  const evaluating = {
    id: 'e1', threadKey: 'github:42', triggerIds: ['x'], strength: 'inferred', actor: trigger.actor, basis: { via: 'followup' },
    policyVersion: 'v1', startedAt: 's', deadline: 'd',
  }
  const thread = {
    key: 'github:42', ref: { source: 'github', id: '42' }, createdAt: '', subscriptions: ['ticket-1'],
    correlated: [], pending: ['x'], evaluating, meta: { pollError: 'boom' },
  }
  assert.deepEqual(threadCard(thread, 'Fix the margin'), {
    thread: 'github:42', label: 'Fix the margin', source: 'github', tickets: ['ticket-1'],
    evaluating: { since: 's', deadline: 'd' }, pending: 1, error: 'boom', read: 'thread/github:42',
  })
  passed += 1
})

// ── 5. 预览只压空白 ─────────────────────────────────────────────────────────

test('预览只把空白压成一个空格，代码、尖括号与链接目标照原文留着', () => {
  const text = 'Fix `Map<string, T>` typing, see [the issue](https://github.com/acme/widgets/issues/7)\n\n  **now**'
  assert.equal(triggerCard({ ...trigger, text }).preview,
    'Fix `Map<string, T>` typing, see [the issue](https://github.com/acme/widgets/issues/7) **now**')
  passed += 1
})
