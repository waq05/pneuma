/**
 * @pneuma/superagent 后续消息中继的包级测试，转写自上游 `tests/followups.spec.ts`（303 行）。
 *
 * 上游这份 spec 是集成测试：它经 `tests/fixtures/host.ts` 起整套 Runtime，靠 `runtime.receive` /
 * `runtime.idle` / `h.route` / `h.runTool` 观察「人的后续消息走到哪、主会话听到什么」。本仓的
 * `app/` 是原生重写，没有那套 host 夹具，所以这里只转写**不依赖整套内核就能判对错**的那一层：
 * 中继消息怎么写（`app/notices.js::followupRelay` / `followupNotice`）、谁算这条消息的主人
 * （`core/model.js::followupOwners`）、回的是哪条消息（`app/links.js::repliedTo`）、
 * 工人会话读到什么（`executor/dsh.js::inputMessage`）、以及工单线程通知与域事件通知的形状。
 *
 * 明确跳过的上游用例（依赖整套 Runtime / 真 Store / 真会话，属于 `scripts/` 集成探针的地盘，
 * 本仓包级测试不写）：
 *   ① 后续消息投递到工人会话、主会话收到卡片、不产生 Eval、线程队列保持空闲（上游第 14–33 行）；
 *   ② 被工单工人接下后主会话不能另开工单、handback 后回 Eval、`orchestrator_route` 拒绝/接受
 *      （上游第 47–89、264–295 行）；
 *   ③ 主会话模型调用次数（steer 批次合并，上游第 103–116 行）；
 *   ④ 效果队列里通知的键与只发一次、重复消息返回 `duplicate`（上游第 118–133 行）；
 *   ⑤ 工人 handback 后候选卡带工人理由、拒绝二次 handback（上游第 135–155 行）；
 *   ⑥ 后续消息让结束的工单复活后主会话才收到通知（上游第 190–233 行，其中「谁有资格」这一半
 *      用 `followupOwners` 单独钉，见下）。
 * 被跳过的是执行链路；「消息写成什么样、谁决定它」这层逻辑仍然逐条断言，转写不做减法。
 *
 * 假件只有一个内存 Store（`get` / `disposition` / `tickets` / `threads`）和一个只实现
 * `repliesTo` 的来源表（飞书那条用真 `feishuKind.repliesTo`，保证父消息 id 的拼法与实现一致）。
 * 不写盘、不碰 `~/.dsc`。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/followups
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { eventNotice, followupNotice, followupRelay, threadFollowedNotice } =
  await import('../../../../lib/packages/superagent/app/notices.js')
const { repliedTo } = await import('../../../../lib/packages/superagent/app/links.js')
const { inputMessage } = await import('../../../../lib/packages/superagent/executor/dsh.js')
const { followupOwners } = await import('../../../../lib/packages/superagent/core/model.js')
const { feishuKind, feishuTriggerId } = await import('../../../../lib/packages/superagent/sources/feishu.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

/** 上游 `expect(...).toMatchObject(...)` 的等价物：对象逐键递归包含，数组等长逐项包含，其余严格相等。 */
function matchObject(actual, expected) {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `期望数组，实际是 ${typeof actual}`)
    assert.equal(actual.length, expected.length)
    expected.forEach((item, index) => matchObject(actual[index], item))
    return
  }
  if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', `期望对象，实际是 ${String(actual)}`)
    for (const [key, value] of Object.entries(expected)) matchObject(actual[key], value)
    return
  }
  assert.deepEqual(actual, expected)
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

const CHAT = 'oc_team'
const THREAD = 'feishu:om_1'

/** 上游 `feishu`：群里的一条消息，`om_<id>` 是飞书 message_id；`parentId` 让它成为某条消息的回复。 */
const message = (id, text, overrides = {}) => ({ id: feishuTriggerId(`om_${id}`), source: 'feishu', threads: [{ source: 'feishu', id: 'om_1' }],
  actor: { source: 'feishu', id: 'ou_alice' }, human: true, at: '2026-01-01T00:00:00.000Z', text,
  meta: { chatId: CHAT, direct: false, mentioned: true }, ...overrides })

/** 主会话看到的后续消息：回复 om_1 的人话。 */
const followup = (id, text, overrides = {}) => message(id, text, { meta: { chatId: CHAT, direct: false, mentioned: false, parentId: 'om_1' }, ...overrides })

/** 工单：一个还在跑（assignment 已启动、无报告）的工单，卡片状态因此是 working。 */
function makeTicket(overrides = {}) {
  return { id: 'ticket', title: '修一下回归', createdAt: '2026-01-01T00:00:00.000Z', mandate: { strength: 'explicit' },
    origin: { triggerId: 'feishu:1', triggerIds: ['feishu:1'], thread: THREAD },
    assignments: [{ id: 'a1', at: '2026-01-01T00:00:01.000Z', state: 'running' }],
    inputs: [], undelivered: [], follows: [], attention: undefined, ended: undefined, delivery: undefined, ...overrides }
}

/** 内存 Store：`followupNotice` / `followupOwners` / `repliedTo` 只读这几个方法。 */
function makeStore({ triggers = [], tickets = [], dispositions = {}, threads = {} } = {}) {
  const triggerMap = new Map(triggers.map(item => [item.id, item]))
  const ticketMap = new Map(tickets.map(item => [item.id, item]))
  return { triggers: { get: id => triggerMap.get(id), disposition: id => dispositions[id] }, tickets: { get: id => ticketMap.get(id) },
    threads: { get: key => threads[key] } }
}

/** 只实现 `repliesTo` 的来源表；飞书那条用真 kind，父消息 id 的拼法与实现一致。 */
const feishuSources = { repliesTo: trigger => feishuKind.repliesTo(trigger) }

/** 解析 `followupNotice` 的 JSON 中继正文。 */
const relayBody = (relay) => JSON.parse(relay.text)

// ── 中继正文 ────────────────────────────────────────────────────────────────

test('中继正文：kind 是 follow_up，键是 followup:<trigger id>，带上工单与“工人决定”的提示', () => {
  const triggerId = feishuTriggerId('om_2')
  const relay = followupRelay({ trigger_id: triggerId, from: 'ou_alice', text: '顺便把标题也改了' },
    [{ ticket_id: 'ticket', title: '修一下回归', state: 'working' }])
  assert.equal(relay.id, `followup:${triggerId}`)
  const body = relayBody(relay)
  matchObject(body, { kind: 'follow_up', trigger_id: triggerId, from: 'ou_alice', text: '顺便把标题也改了',
    delivered_to: [{ ticket_id: 'ticket', title: '修一下回归', state: 'working' }] })
  assert.ok(body.note.includes('worker has it and decides'), '提示要写明工单的工人决定这条消息')
  assert.ok(body.note.includes('orchestrator_route kind stop'), '提示要写明主会话只能按它停这块工作')
  assert.ok(body.note.includes('stop with this trigger_id'), '提示要写明停机要用这条 trigger_id')
  passed += 1
})

test('后续通知：人的消息到了活工单，主会话收到带回复关系与工单状态的卡片', () => {
  const parent = message('1', '@bot 修一下回归')
  const trigger = followup('2', '顺便把标题也改了')
  const ticket = makeTicket()
  const store = makeStore({ triggers: [parent, trigger], tickets: [ticket], dispositions: { [trigger.id]: { fanout: [ticket.id], at: trigger.at } } })
  const relay = followupNotice(store, feishuSources, trigger.id)
  assert.ok(relay, '活工单的后续消息要通知主会话')
  const body = relayBody(relay)
  assert.equal(relay.id, `followup:${trigger.id}`)
  matchObject(body, { kind: 'follow_up', trigger_id: trigger.id, from: 'ou_alice', thread: THREAD, at: trigger.at,
    text: '顺便把标题也改了',
    replies_to: { trigger_id: parent.id, preview: '@bot 修一下回归' },
    delivered_to: [{ ticket_id: ticket.id, title: ticket.title, state: 'working' }] })
  assert.ok(body.note.includes('worker has it and decides'))
  passed += 1
})

test('后续通知：消息按工人读到的样子给出，长文截到 600 字并留 chars 与读取路径', () => {
  const parent = message('1', '@bot 修一下回归')
  const long = `另外，${'导出按钮的文案也需要改。'.repeat(60)}`
  const trigger = followup('2', long)
  const ticket = makeTicket()
  const store = makeStore({ triggers: [parent, trigger], tickets: [ticket], dispositions: { [trigger.id]: { fanout: [ticket.id], at: trigger.at } } })
  const body = relayBody(followupNotice(store, feishuSources, trigger.id))
  assert.equal(body.text, `${long.slice(0, 600)}…`)
  assert.equal(body.chars, long.length)
  assert.equal(body.read, `trigger/${trigger.id}`)
  matchObject(body, { replies_to: { trigger_id: parent.id, preview: '@bot 修一下回归' } })
  passed += 1
})

test('后续通知：只到活工单才发；工单已结束就没有通知', () => {
  const trigger = followup('2', '再改一下标题')
  const live = makeTicket()
  const ended = makeTicket({ ended: { at: '2026-01-02T00:00:00.000Z', by: 'executor', outcome: 'closed', reason: 'done' } })
  const store = makeStore({ triggers: [trigger], tickets: [live], dispositions: { [trigger.id]: { fanout: [live.id], at: trigger.at } } })
  assert.ok(followupNotice(store, feishuSources, trigger.id), '活工单要发')
  const dead = makeStore({ triggers: [trigger], tickets: [ended], dispositions: { [trigger.id]: { fanout: [ended.id], at: trigger.at } } })
  assert.equal(followupNotice(dead, feishuSources, trigger.id), undefined, '结束的工单不发')
  passed += 1
})

test('后续通知：机器人消息、没分配过的消息、已被要求重评的消息都不发', () => {
  const human = followup('2', '补充一点')
  const store = makeStore({ triggers: [human], tickets: [makeTicket()] })
  assert.equal(followupNotice(store, feishuSources, human.id), undefined, '没有 disposition 的消息不发')
  const bot = followup('3', '机器人补充', { human: false })
  const botStore = makeStore({ triggers: [bot], tickets: [makeTicket()], dispositions: { [bot.id]: { fanout: ['ticket'], at: bot.at } } })
  assert.equal(followupNotice(botStore, feishuSources, bot.id), undefined, '机器人消息不发')
  const requeued = followup('4', '重评一下')
  const requeuedStore = makeStore({ triggers: [requeued], tickets: [makeTicket()],
    dispositions: { [requeued.id]: { fanout: ['ticket'], at: requeued.at, requeued: true } } })
  assert.equal(followupNotice(requeuedStore, feishuSources, requeued.id), undefined, '已要求重评的消息交给 Eval，不发')
  passed += 1
})

test('后续通知：工人把手上的消息交回后，主会话不再收到后续通知', () => {
  const trigger = followup('2', '另外把导出按钮也加上')
  const ticket = makeTicket()
  const store = makeStore({ triggers: [trigger], tickets: [ticket],
    dispositions: { [trigger.id]: { fanout: [ticket.id], at: trigger.at, handbacks: [{ ticketId: ticket.id, reason: 'It asks for an export button.', at: trigger.at }] } } })
  assert.equal(followupNotice(store, feishuSources, trigger.id), undefined)
  assert.deepEqual(followupOwners(trigger, store), [])
  passed += 1
})

test('后续通知：只为上下文订阅的工单不算主人，消息照旧去 Eval；另有主人时它带 context 标记列出', () => {
  const trigger = followup('2', '@bot 把这里的按钮也改了')
  const contextOnly = makeTicket({ id: 'ticket-ctx' })
  const owner = makeTicket({ id: 'ticket-own' })
  const onlyContext = makeStore({ triggers: [trigger], tickets: [contextOnly],
    dispositions: { [trigger.id]: { fanout: [contextOnly.id], at: trigger.at, context: [contextOnly.id] } } })
  assert.deepEqual(followupOwners(trigger, onlyContext), [], '只为上下文订阅的工单不决定这条消息')
  assert.equal(followupNotice(onlyContext, feishuSources, trigger.id), undefined)
  const mixed = makeStore({ triggers: [trigger], tickets: [contextOnly, owner],
    dispositions: { [trigger.id]: { fanout: [contextOnly.id, owner.id], at: trigger.at, context: [contextOnly.id] } } })
  assert.deepEqual(followupOwners(trigger, mixed), [owner.id])
  matchObject(relayBody(followupNotice(mixed, feishuSources, trigger.id)), { delivered_to: [{ ticket_id: contextOnly.id, context: true },
    { ticket_id: owner.id }] })
  passed += 1
})

test('后续通知：没人决定时不发，人自己发去 Eval 的消息也不发', () => {
  const trigger = followup('2', '顺便看看日志')
  const ticket = makeTicket()
  const noDisposition = makeStore({ triggers: [trigger], tickets: [ticket] })
  assert.equal(followupNotice(noDisposition, feishuSources, trigger.id), undefined)
  const empty = makeStore({ triggers: [trigger], tickets: [ticket], dispositions: { [trigger.id]: { fanout: [], at: trigger.at } } })
  assert.equal(followupNotice(empty, feishuSources, trigger.id), undefined)
  passed += 1
})

// ── 谁决定一条后续消息 ──────────────────────────────────────────────────────

test('主人判定：结束的工单在它的工人手里还有未投递的这条消息时仍算主人，复活后才算活工单', () => {
  const trigger = followup('2', '再改一下标题')
  const ended = makeTicket({ ended: { at: '2026-01-02T00:00:00.000Z', by: 'executor', outcome: 'closed', reason: 'done' },
    inputs: [{ id: 'i1', kind: 'trigger', triggerId: trigger.id, human: true, at: trigger.at }], undelivered: ['i1'] })
  const store = makeStore({ triggers: [trigger], tickets: [ended], dispositions: { [trigger.id]: { fanout: [ended.id], at: trigger.at } } })
  assert.deepEqual(followupOwners(trigger, store), [ended.id], '未投递的续做消息仍由原工单决定')
  // 通知要等工单复活（`ended` 清掉、成为活工单）之后才发。
  assert.equal(followupNotice(store, feishuSources, trigger.id), undefined)
  const resumed = makeStore({ triggers: [trigger], tickets: [makeTicket()], dispositions: { [trigger.id]: { fanout: ['ticket'], at: trigger.at } } })
  matchObject(relayBody(followupNotice(resumed, feishuSources, trigger.id)), { trigger_id: trigger.id, delivered_to: [{ ticket_id: 'ticket' }] })
  passed += 1
})

test('主人判定：被人都停掉（人结束的工单）不再算主人，没被停的结束工单才算', () => {
  const trigger = followup('2', '先停一下')
  const stopped = makeTicket({ ended: { at: '2026-01-02T00:00:00.000Z', by: 'human', outcome: 'stopped' },
    inputs: [{ id: 'i1', kind: 'trigger', triggerId: trigger.id, human: true, at: trigger.at }], undelivered: ['i1'] })
  const store = makeStore({ triggers: [trigger], tickets: [stopped], dispositions: { [trigger.id]: { fanout: [stopped.id], at: trigger.at } } })
  assert.deepEqual(followupOwners(trigger, store), [])
  passed += 1
})

// ── 回复关系 ────────────────────────────────────────────────────────────────

test('回复关系：从来源 kind 找回被回复的消息，来源不认就返回 undefined', () => {
  const parent = message('1', 'the earlier message')
  const reply = message('2', 'a reply', { meta: { chatId: CHAT, direct: false, mentioned: true, parentId: '1' }, source: 'other' })
  const store = makeStore({ triggers: [parent] })
  assert.deepEqual(repliedTo({ store, sources: { repliesTo: trigger => trigger.id === reply.id ? parent.id : undefined } }, reply), parent)
  assert.equal(repliedTo({ store, sources: { repliesTo: () => undefined } }, reply), undefined)
  assert.deepEqual(repliedTo({ store, sources: feishuSources }, message('3', 'yes', { meta: { chatId: CHAT, direct: false, mentioned: true, parentId: 'om_1' } })), parent)
  passed += 1
})

// ── 工人会话读到的内容 ──────────────────────────────────────────────────────

test('工人消息：续做的工单要求把越界或属于别处的消息交回，并报 dropped', () => {
  const text = inputMessage({ id: 'r', kind: 'resumed', triggerId: 't', at: '' })
  assert.ok(text.includes('hand it back with orchestrator_trigger_handback'), '续做提示要写明交回工具')
  assert.ok(text.includes('beyond that scope'), '续做提示要写明越界就交回')
  assert.ok(text.includes('report dropped'), '续做提示要写明交回后报 dropped')
  passed += 1
})

test('工人消息：主会话的备注按“仅为上下文”交给工人', () => {
  assert.equal(inputMessage({ kind: 'note', text: 'Ticket B renamed the setting.' }),
    'Note from the orchestrator, for context only: Ticket B renamed the setting.')
  passed += 1
})

test('工人消息：只为上下文订阅的触发带上 context 标记，普通触发不带', () => {
  assert.deepEqual(JSON.parse(inputMessage({ kind: 'trigger', triggerId: 'feishu:2', context: true }, { trigger_id: 'feishu:2', from: 'ou_alice' })),
    { trigger_id: 'feishu:2', from: 'ou_alice', context: true })
  assert.deepEqual(JSON.parse(inputMessage({ kind: 'trigger', triggerId: 'feishu:2' }, { trigger_id: 'feishu:2', from: 'ou_alice' })),
    { trigger_id: 'feishu:2', from: 'ou_alice' })
  passed += 1
})

// ── 线程通知与域事件通知 ────────────────────────────────────────────────────

test('工件通知：工单只为上下文关注线程时，通知写明“仅为上下文、不给授权”', () => {
  const notice = threadFollowedNotice('ticket', 'github:7', 'The issue it fixes.')
  // 一次性通知的键是内容哈希，同一条事件重复生成也互不相同（不会被合并成一条）。
  assert.match(notice[0], /^[0-9a-f]{32}$/)
  assert.notEqual(threadFollowedNotice('ticket', 'github:7', 'The issue it fixes.')[0], notice[0])
  matchObject(notice[1], { thread_followed: { ticket_id: 'ticket', thread: 'github:7', reason: 'The issue it fixes.' } })
  assert.ok(notice[1].note.includes('For context only'), '提示要写明仅为上下文')
  assert.ok(notice[1].note.includes('grant nothing'), '提示要写明不授予任何权限')
  assert.ok(notice[2].includes('github:7'))
  passed += 1
})

test('域事件通知：重排的 Trigger 带读取路径与时间，人的退订合并到线程键，其他事件不发', () => {
  const requeued = eventNotice({ type: 'trigger.requeued', at: '2026-01-01T00:00:00.000Z', data: { triggerId: feishuTriggerId('9') } })
  assert.match(requeued[0], /^[0-9a-f]{32}$/)
  matchObject(requeued[1], { trigger_requeued: feishuTriggerId('9'), read: `trigger/${feishuTriggerId('9')}`, at: '2026-01-01T00:00:00.000Z' })
  const unsubscribed = eventNotice({ type: 'thread.unsubscribed', at: '2026-01-01T00:00:00.000Z',
    data: { threadKey: THREAD, ticketId: 'ticket', by: 'person' } })
  assert.equal(unsubscribed[0], `subscription:${THREAD}`)
  matchObject(unsubscribed[1], { subscription_changes: [{ thread: THREAD, removed: true }] })
  assert.equal(eventNotice({ type: 'policy.changed', at: '2026-01-01T00:00:00.000Z', data: { from: 'a', to: 'b' } }), undefined)
  passed += 1
})

test('域事件通知：执行器发现线程无关时的退订给工单、线程与原因', () => {
  const notice = eventNotice({ type: 'thread.unsubscribed', at: '2026-01-01T00:00:00.000Z',
    data: { threadKey: 'github:7', ticketId: 'ticket', by: 'executor', reason: 'different request' } })
  matchObject(notice[1], { thread_unrelated: { ticket_id: 'ticket', thread: 'github:7', reason: 'different request' } })
  assert.ok(notice[1].note.includes('Its Executor found this thread unrelated'))
  passed += 1
})
