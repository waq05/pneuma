/**
 * @pneuma/superagent 工单阶段分类与重试资格的包级测试，转写自上游 `tests/stage.spec.ts`。
 *
 * 上游 spec 的 import 头是 `../src/core/index.ts` 的 `canRetry` / `ticketStage` / `Assignment` / `ReportState` / `Ticket`，
 * 映射到本仓就是 `core/stage.ts`（由 `core/index.ts:6` 转出），逐行对应，没有跳过的用例。
 *
 * 为什么这些要单独钉：这两条判据决定面板给不给「重试」按钮、工单算「待你处理」还是「执行中」。判错不抛错，
 * 只会让人点不到该点的按钮，或者点了把正在干活的 worker 打断。用例表照 `docs/003` 的行序，先匹配的行赢。
 *
 * 夹具是对象字面量，只写 `ticketStage` / `canRetry` 真会读的字段（`ended` / `delivery` / `attention` /
 * `assignments` / `inputs`）。这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/stage
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { canRetry, ticketStage } = await import('../../../../lib/packages/superagent/core/index.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具（照上游 spec 的同名工厂，只留运行期真读的字段）─────────────────────

/** 一条分配；`report` 由 `reported` 补。 */
const assignment = (overrides = {}) => ({ id: 'a', state: 'running', createdAt: '', ...overrides })

/** 带结论的一条分配。 */
const reported = (state, overrides = {}) => assignment({ report: { state, summary: '', at: '' }, ...overrides })

/** 一张工单：默认最新分配在跑。 */
const ticket = (overrides = {}) => ({
  id: 't', title: 'x', decisionId: 'd', channels: [], assignments: [assignment()], inputs: [], undelivered: [],
  createdAt: '', updatedAt: '', ...overrides,
})

/** 一个等人回答的问题。 */
const attention = { id: 'q', question: '?' }

/** 一条在报告之后到工单的人的消息。 */
const answered = { inputs: [{ id: 'i', kind: 'trigger', triggerId: 'e', at: 'later', human: true }] }

/** 结论时间早于 `answered` 里那条消息的分配：人已经接过话。 */
const reportedAt = (state) => reported(state, { report: { state, summary: '', at: 'earlier' } })

/** 已经结束的工单。 */
const ended = { at: '', by: 'executor', reason: 'closed', outcome: 'closed' }

// ── 1. ticketStage ──────────────────────────────────────────────────────────

// docs/003 的表格行，按顺序；一张工单命中多行时取第一行。
const STAGE_ROWS = [
  ['一条没投递出去的 Input', ticket({ delivery: { error: 'offline', at: '' } }), { stage: 'person', action: 'delivery' }],
  ['投递失败排在回答与复核之前', ticket({ delivery: { error: 'offline', at: '' }, attention, assignments: [reported('ready')] }), { stage: 'person', action: 'delivery' }],
  ['一个待回答的问题', ticket({ attention }), { stage: 'person', action: 'answer' }],
  ['回答问题排在复核之前', ticket({ attention, assignments: [reported('ready')] }), { stage: 'person', action: 'answer' }],
  ['回答问题排在失败之前', ticket({ attention, assignments: [reported('failed')] }), { stage: 'person', action: 'answer' }],
  ['一条 ready 的结论', ticket({ assignments: [reported('ready')] }), { stage: 'person', action: 'review' }],
  ['一条来自已结束分配的 ready 结论', ticket({ assignments: [reported('ready', { state: 'ended' })] }), { stage: 'person', action: 'review' }],
  ['一条 blocked 的结论', ticket({ assignments: [reported('blocked')] }), { stage: 'person', action: 'blocked' }],
  ['一条 failed 的结论', ticket({ assignments: [reported('failed')] }), { stage: 'person', action: 'failed' }],
  ['人已接过话的 blocked 结论', ticket({ ...answered, assignments: [reportedAt('blocked')] }), { stage: 'working' }],
  ['没有分配', ticket({ assignments: [] }), { stage: 'working', action: 'queued' }],
  ['最新分配在 pending', ticket({ assignments: [reported('failed', { state: 'ended' }), assignment({ state: 'pending' })] }), { stage: 'working', action: 'queued' }],
  ['一条 waiting 的结论', ticket({ assignments: [reported('waiting')] }), { stage: 'idle' }],
  ['一条已结束的分配', ticket({ assignments: [assignment({ state: 'ended' })] }), { stage: 'idle' }],
  ['一条在跑的分配', ticket(), { stage: 'working' }],
  ['一条 progress 结论', ticket({ assignments: [reported('progress')] }), { stage: 'working' }],
  ['一张已结束的工单', ticket({ ended, attention, assignments: [reported('failed')] }), { stage: 'ended' }],
]

for (const [name, value, stage] of STAGE_ROWS) {
  test(`ticketStage：${name}`, () => {
    assert.deepEqual(ticketStage(value), stage)
    passed += 1
  })
}

// ── 2. canRetry ─────────────────────────────────────────────────────────────

const RETRY_ROWS = [
  ['一张 failed 的未结束工单', true, ticket({ assignments: [reported('failed')] })],
  ['一张 blocked 的未结束工单', true, ticket({ assignments: [reported('blocked')] })],
  ['一张 failed 同时还在等回答的工单', true, ticket({ attention, assignments: [reported('failed')] })],
  ['一张 blocked 且 Input 没投递出去的工单', true, ticket({ delivery: { error: 'offline', at: '' }, assignments: [reported('blocked')] })],
  ['一张 failed 但已结束的工单', false, ticket({ ended, assignments: [reported('failed')] })],
  ['一张已重试过、新分配在 pending 的工单', false, ticket({ assignments: [reported('failed', { state: 'ended' }), assignment({ state: 'pending' })] })],
  ['一张 ready 的工单', false, ticket({ assignments: [reported('ready')] })],
  ['一张在跑的工单', false, ticket()],
  ['一张没有分配的工单', false, ticket({ assignments: [] })],
  // worker 已经拿到人那条消息（阶段判据如此），再重试只会打断它。
  ['一张人已接过话的 failed 工单', false, ticket({ ...answered, assignments: [reportedAt('failed')] })],
  // 除非那条消息没投递出去：新分配会重启 worker 并把消息交给它。
  ['一张人已接过话、但投递失败的 failed 工单', true,
    ticket({ ...answered, delivery: { error: 'offline', at: '' }, assignments: [reportedAt('failed')] })],
  ['一张 Input 没能投递的在跑工单', true, ticket({ delivery: { error: 'offline', at: '' } })],
  ['一张 Input 没能投递的已结束工单', false, ticket({ ended, delivery: { error: 'offline', at: '' } })],
]

for (const [name, expected, value] of RETRY_ROWS) {
  test(`canRetry：${name}`, () => {
    assert.equal(canRetry(value), expected)
    passed += 1
  })
}

test('每个新分配能补救的「待人」阶段都允许重试', () => {
  const delivery = ticket({ ...answered, delivery: { error: 'offline', at: '' }, assignments: [reportedAt('failed')] })
  assert.deepEqual(ticketStage(delivery), { stage: 'person', action: 'delivery' })
  assert.equal(canRetry(delivery), true)
  passed += 1
})
