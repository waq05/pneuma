/**
 * @pneuma/superagent 管理视图的包级测试（移植自上游 `tests/views.spec.ts`，15 条用例）。
 *
 * 为什么这些要单独钉：视图层只做投影（把库里的事实翻成界面读的结构），判错不抛错，只会让界面
 * 少说一句或多说一句——谁发的消息、线程在等什么、工单卡在哪、来源是开着还是错着。每条断言都钉
 * 「这个投影按规则给出的值」，不是「函数不崩」。
 *
 * 假件：只有 `links`（通道链接）用对象字面量，因为它只给 URL 与触发 id；`Store`、`SourceRegistry`、
 * `feishuKind` / `githubKind`、`SettingsSchema` 全是真的，数据落在 tmpdir 的临时库里。这里 import
 * 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * 与上游的差异只有测试框架：vitest 的 `describe/it/expect/vi` 换成 `node:test` +
 * `node:assert/strict`；`toMatchObject` 用本文件底部的 `matches` 实现，`vi.spyOn` 换成手工计数。
 *
 * @module @pneuma/superagent/tests/views
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, test } from 'node:test'

const { Store } = await import('../../../../lib/packages/superagent/app/store.js')
const { SettingsSchema } = await import('../../../../lib/packages/superagent/core/policy.js')
const { SourceRegistry } = await import('../../../../lib/packages/superagent/sources/registry.js')
const { feishuKind } = await import('../../../../lib/packages/superagent/sources/feishu.js')
const { githubKind } = await import('../../../../lib/packages/superagent/sources/github.js')
const { snapshot, threadSummary, ticketSummary, triggerView } = await import('../../../../lib/packages/superagent/app/views/records.js')
const { basisFacts, ticketDetail } = await import('../../../../lib/packages/superagent/app/views/tickets.js')
const { threadDetail } = await import('../../../../lib/packages/superagent/app/views/threads.js')
const { droppedReplies, sourcesStatus } = await import('../../../../lib/packages/superagent/app/views/sources.js')
const { overview } = await import('../../../../lib/packages/superagent/app/views/overview.js')
const { markdown, plain } = await import('../../../../lib/packages/superagent/app/views/text.js')
const { policyHistory } = await import('../../../../lib/packages/superagent/app/settings-history.js')
const { KV } = await import('../../../../lib/packages/superagent/kv.js')
const { feishuLink } = await import('../../../../lib/packages/superagent/sources/feishu-channel.js')
const { feishuChannel, feishuTriggerId } = await import('../../../../lib/packages/superagent/sources/feishu-trigger.js')
const { githubLink } = await import('../../../../lib/packages/superagent/sources/github-channel.js')
const { githubChannel } = await import('../../../../lib/packages/superagent/sources/github-trigger.js')
const { followupOwners } = await import('../../../../lib/packages/superagent/core/index.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 临时库：每个用例一个，收尾关库并删目录。 */
let directory
let store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-views-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

/** 通道链接：只按来源给 URL（视图只用它的 `url` / `label` / `triggerId`）。 */
const links = (channel) => (channel.source === 'feishu' ? feishuLink : githubLink)(channel.address, {})

/** 一条被丢弃的回复回执：加进 outbox 再标成 `channelGone`。 */
const drop = (id, channel, ticketId) => {
  const message = { id, channel, text: id, kind: 'reply', ...ticketId ? { ticketId } : {} }
  store.receipts.add(message)
  store.receipts.settle(message, 'channelGone')
}

/** 一套视图宿主：真设置（策略里各列一个允许的发送者）与注册了两个真 kind 的注册表。 */
function views() {
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] },
    github: { allowed: [{ id: 'alice' }] } },
  rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix copy' }] } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(feishuKind)
  sources.register(githubKind)
  return { store, sources, links }
}

const at = new Date().toISOString()

/** 一张没有 Assignment 的开放工单：跟随消息的归属判定需要它。 */
const live = (id) => store.tickets.save({ id, title: id, decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
  origin: { triggerId: 'e0', triggerIds: ['e0'] }, assignments: [], inputs: [] })

/** 一条飞书群消息（Trigger 只填判定用到的字段）。 */
const message = (id, actor, human = true) => ({ id, source: actor.source, threads: [{ source: 'feishu', id: 'oc_1:om_root' }], actor,
  human, at, text: `message ${id}`, meta: {} })

/** `toMatchObject` 的等价物：只比 expected 里写出的键，数组要求等长且逐项匹配。 */
function matches(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => matches(actual[index], item))
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false
    return Object.entries(expected).every(([name, value]) => name in actual && matches(actual[name], value))
  }
  return Object.is(actual, expected)
}

/** 记一条通过：深比较（对象 / 数组 / 原始值都适用）。 */
function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  passed += 1
}

/** 记一条通过：部分匹配。 */
function matched(actual, expected, message) {
  assert.ok(matches(actual, expected), message)
  passed += 1
}

/** 记一条通过：布尔条件。 */
function ok(value, message) {
  assert.ok(value, message)
  passed += 1
}

// ── 用例 ────────────────────────────────────────────────────────────────────

test('每条被丢弃的消息都标出它所属的 Thread：回答它的 Channel 那个 Trigger 的，或 Channel 自己的', () => {
  // 飞书 Channel 说得出自己的群；它回答的消息属于话题根消息的 Thread。
  store.triggers.save({ id: feishuTriggerId('om_reply'), source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_root' }],
    actor: { source: 'feishu', id: 'ou_a' }, human: true, at: new Date().toISOString(), text: 'please', meta: {} })
  store.threads.save({ key: 'github:42', ref: { source: 'github', id: '42' }, createdAt: '', subscriptions: [], correlated: [], pending: [],
    meta: {} })
  drop('a', feishuChannel('oc_1', 'om_reply'))
  drop('b', githubChannel(42))
  // 库里的 Trigger 和 Thread 都没了的消息，哪儿都不指。
  drop('c', feishuChannel('oc_2', 'om_gone'))
  equal(Object.fromEntries(droppedReplies({ store, links }).map(item => [item.id, item.thread])),
    { a: 'feishu:oc_1:om_root', b: 'github:42', c: undefined })
})

test('每个发送者按 Policy 列的名字称呼：能按 id 认出的用 id，认不出的按来源自己的叫法', () => {
  const view = snapshot(views())
  equal([view.actor({ source: 'feishu', id: 'OU_ALICE' }), view.actor({ source: 'github', id: 'alice' }), view.actor({ source: 'github',
    id: 'bob' }),
    view.actor({ source: 'feishu', id: 'ou_bob' }), view.actor({ source: 'feishu', id: 'ou_bot' }, false), view.actor({ source: 'feishu',
      id: '' })],
    [{ source: 'feishu', id: 'OU_ALICE', name: { zh: 'Alice', en: 'Alice' } }, { source: 'github', id: 'alice',
      name: { zh: 'alice', en: 'alice' } },
      { source: 'github', id: 'bob', name: { zh: 'bob', en: 'bob' } }, { source: 'feishu', id: 'ou_bob',
        name: feishuKind.policy.unnamed.person },
      { source: 'feishu', id: 'ou_bot', name: feishuKind.policy.unnamed.bot }, { source: 'feishu', id: '' }])
  equal(view.rule('copy'), { id: 'copy', name: 'Copy fixes' })
  equal(view.rule('gone'), { id: 'gone', name: 'gone' })
})

test('按线程正在做的事给它分类，并给一个人发的 Trigger 提供「再送评估」', () => {
  const host = views()
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: [],
    correlated: [],
    pending: ['e2'], meta: {} })
  store.triggers.save(message('e1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.save(message('e2', { source: 'feishu', id: 'ou_bob' }))
  store.triggers.save(message('e3', { source: 'feishu', id: 'ou_bot' }, false))
  for (const id of ['e1', 'e3']) store.triggers.saveDisposition(id, { filtered: { code: 'not_a_member' }, fanout: [], at })
  const view = snapshot(host)
  equal(threadSummary(view, store.threads.get('feishu:oc_1:om_root')).stage, 'queued')
  const rows = ['e1', 'e2', 'e3'].map(id => triggerView(view, store.triggers.get(id)))
  // 排队的 Trigger 已经在等评估；自动发的 Trigger 不给人「再送评估」。
  equal(rows.map(row => row.actions.requeue), [true, false, false])
  equal(rows[0].actor.name, { zh: 'Alice', en: 'Alice' })
})

test('每个来源按第一个成立的状态说话', () => {
  const host = views()
  const states = (setup, health = {}) => Object.fromEntries(sourcesStatus(host, health, setup).map(source => [source.id, source.state]))
  equal(states({}), { feishu: 'starting', github: 'starting' })
  equal(states({}, { feishu: { state: 'ready', detail: '' }, history: { state: 'paused', detail: '' }, github: { state: 'error',
    detail: 'x' } }), { feishu: 'paused', github: 'error' })
  const problem = { place: 'deployment', code: 'stateDirUnset', values: {}, detail: '' }
  equal(states({ problem }, { feishu: { state: 'ready', detail: '' }, history: { state: 'ready', detail: '' }, github: { state: 'ready',
    detail: '' } }), { feishu: 'setup', github: 'setup' })
})

test('跟着工单的阶段走：blocked 的工单此后有人回答过就是在干活，不带重试、备注与回合结束', () => {
  const host = views()
  const blocked = { state: 'blocked', summary: 'Needs the design file', at: '2026-09-22T00:01:00Z' }
  const ticket = { id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu',
      id: 'ou_alice' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [{ id: 'a1', state: 'running', createdAt: at, startedAt: at,
      report: blocked }],
    inputs: [] }
  store.tickets.save(ticket)
  const row = ticketSummary(store.tickets.get('t1'))
  matched(row, { stage: 'person', action: 'blocked', actions: { retry: true }, note: { text: 'Needs the design file',
    error: false } })
  matched(ticketDetail(host, 't1').assignments[0], { turnEndedAt: blocked.at })
  store.tickets.save({ ...ticket, inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:02:00Z', human: true }] })
  const answered = ticketSummary(store.tickets.get('t1'))
  matched(answered, { stage: 'working', actions: { retry: false } })
  ok(!('note' in answered), '有人回答之后不再有「等回答」的备注')
  ok(!('turnEndedAt' in ticketDetail(host, 't1').assignments[0]), '恢复之后这次 Assignment 的回合不算结束')
})

test('已经进入工单的跟帖不显示成在等评估，哪怕旧版本把它排进了队列', () => {
  const host = views()
  live('t1')
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  store.triggers.save(message('f2', { source: 'feishu', id: 'ou_bob' }))
  store.triggers.saveDisposition('f2', { fanout: ['t1'], requeued: true, at })
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: ['f1'], meta: {} })
  const view = snapshot(host)
  matched(threadSummary(view, store.threads.get('feishu:oc_1:om_root')), { stage: 'subscribed', pending: 0 })
  equal(triggerView(view, store.triggers.get('f1')).disposition.queued, false)
  // 被人重新送去评估的那条才在等。
  store.threads.save({ ...store.threads.get('feishu:oc_1:om_root'), pending: ['f1', 'f2'] })
  matched(threadSummary(snapshot(host), store.threads.get('feishu:oc_1:om_root')), { stage: 'queued', pending: 1 })
})

const load = { running: 0, queued: 0 }
const problems = (host, health = {}) => overview(host, health, 'v1', load).problems

test('列出过了截止时间的评估；dsh-superagent 自己的错误只报来源与 Policy 同步都不负责的那几格', () => {
  const host = views()
  const evaluating = { id: 'e1', threadKey: 'github:1', triggerIds: ['t1'], strength: 'explicit', actor: { source: 'github',
    id: 'alice' },
    basis: { via: 'addressed', addressed: 'mention' }, policyVersion: 'v1', startedAt: '2026-01-01T00:00:00Z',
    deadline: '2026-01-01T00:02:00Z' }
  store.threads.save({ key: 'github:1', ref: { source: 'github', id: '1' }, createdAt: at, subscriptions: [], correlated: [], pending: [],
    evaluating, meta: {} })
  const error = (detail) => ({ state: 'error', detail })
  const health = { relay: error('relay failing'), reply: error('reply failing'), feishu: error('socket closed'),
    history: error('read failed'),
    'sync:feishu': error('sync failed'), evals: error('unavailable'), launch: { state: 'ready', detail: '' } }
  const found = problems(host, health)
  const overdue = found.find(item => item.kind === 'eval-overdue')
  matched(overdue, { thread: { key: 'github:1', stage: 'evaluating' } })
  // Effects 是 dsh-superagent 自己的；来源报自己的体检格与 Policy 同步，评估则一条一条列。
  equal(found.filter(item => item.kind === 'runtime-error'), [{ kind: 'runtime-error', name: 'relay', detail: 'relay failing' },
    { kind: 'runtime-error', name: 'reply', detail: 'reply failing' }])
  equal(found.filter(item => item.kind === 'source-error').map(item => item.source.health.name), ['feishu', 'history'])
})

test('所有来源都关时说没有来源在跑，并标出缺失或关掉的来源', () => {
  const host = views()
  equal(problems(host).map(item => item.kind).includes('no-source'), false)
  const settings = store.settings()
  store.saveSettings({ ...settings, sources: { feishu: { enabled: false, config: {} }, github: { enabled: false, config: {} },
    jira: { enabled: true, config: { site: 'acme' } } } })
  equal(problems(host).map(item => item.kind).includes('no-source'), true)
  equal(Object.fromEntries(sourcesStatus(host, {}, {}).map(source => [source.id, [source.state, source.installed]])),
    { feishu: ['off', true], github: ['off', true], jira: ['missing', false] })
})

test('发送不带 HTML 的文本（实体编码的标签也算），图片按名字标出', () => {
  const text = '<div>Hello <b>there</b></div> &lt;script&gt;alert(1)&lt;/script&gt; <!-- note --> ![shot](https://x/y.png) [Image: diagram]'
  equal(plain(text), 'Hello there alert(1) [image] [image]')
  equal(markdown(`**Fix** ${text}\n\n- one`), '**Fix** Hello there alert(1)  [image] [image]\n\n- one')
  equal(plain('[the docs](https://example.com) and `code` &amp; more'), 'the docs and code & more')
})

test('每次设置保存只说它相对上一次改了什么；历史断了就什么都不说', () => {
  const host = views()
  const first = store.settings()
  const allowed = (entries) => ({ ...first.policy, sources: { ...first.policy.sources,
    feishu: { ...first.policy.sources.feishu, allowed: entries } } })
  const alice = { id: 'ou_alice', name: 'Alice Liu' }, bob = { id: 'ou_bob', name: 'Bob' }
  store.saveSettings({ ...first, policy: allowed([alice, bob, { id: 'ou_carol' }]), paused: true,
    sources: { ...first.sources, feishu: { enabled: false, config: {} } },
    executor: { ...first.executor, directory: '/srv/work', prepare: 'npm ci', blockedCommands: ['rm', 'curl'] } })
  const second = store.settings()
  store.saveSettings({ ...second, policy: allowed([alice, { id: 'ou_carol' }]), paused: false, sources: { ...second.sources,
    feishu: { enabled: true, config: {} } } })
  const changes = (revision) => policyHistory(store, host.sources, 'v').items.find(item => item.revision === revision).changes
  const revision = store.get(KV.settings.revision)
  equal(changes(revision - 1), [
    { code: 'sourceRowsAdded', source: 'feishu', part: true, field: 'allowed', items: ['Bob', 'ou_carol'] },
    { code: 'sourceRowsChanged', source: 'feishu', part: true, field: 'allowed', items: ['Alice Liu'] },
    { code: 'paused' }, { code: 'executionDirectory', from: '', to: '/srv/work' }, { code: 'prepareCommand' },
    { code: 'blockedCommands', from: '', to: 'rm curl' }, { code: 'sourceDisabled', source: 'feishu' }])
  equal(changes(revision), [{ code: 'sourceRowsRemoved', source: 'feishu', part: true, field: 'allowed', items: ['Bob'] },
    { code: 'resumed' }, { code: 'sourceEnabled', source: 'feishu' }])
  // 前一个版本不在历史里时，这次保存没有可比的基准。
  store.delete(KV.settings.version(revision))
  store.saveSettings({ ...store.settings(), paused: true })
  equal(changes(revision + 1), null)
})

test('按 Policy 列出机器人名字，并给机器人的 Mandate 一条自己的 basis 事实', () => {
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [], bots: [{ id: 'cli_review', name: '评审机器人' }] } } } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(feishuKind)
  const view = snapshot({ store, sources, links })
  equal(view.actor({ source: 'feishu', id: 'cli_review' }, false).name, { zh: '评审机器人', en: '评审机器人' })
  equal(basisFacts({ via: 'bot', sender: '评审机器人', addressed: 'mention', observation: { mode: 'auto' } }, view.rule).facts,
    [{ name: 'sender', value: '评审机器人' }, { name: 'bot' }, { name: 'addressed', value: 'mention' }, { name: 'mode', value: 'auto' }])
})

test('进入工单的跟帖显示成已送达；交回的 Trigger 显示退回原因；工单为上下文跟随的 Thread 也标出来', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: [], meta: {} })
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  store.triggers.save(message('f2', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f2', { fanout: ['t1'], requeued: true, handbacks: [{ ticketId: 't1', reason: 'Asks for a new feature', at }], at })
  const view = snapshot(host)
  matched(triggerView(view, store.triggers.get('f1')).disposition, { delivered: true, queued: false, handbacks: [] })
  // 交回的 Trigger 像线程上任何消息一样去评估；交回它的工单有标题之后按标题叫。
  matched(triggerView(view, store.triggers.get('f2')).disposition, { delivered: false,
    handbacks: [{ ticketId: 't1', title: 't1', reason: 'Asks for a new feature' }] })
  store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: at, subscriptions: ['t1'], context: ['t1'],
    correlated: [], pending: [], meta: {} })
  equal(threadDetail(host, 'github:7', undefined, 50).context, ['t1'])
  store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [],
    inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'f1', at }, { id: 'i2', kind: 'trigger', triggerId: 'f2', at }] })
  const page = ticketDetail(host, 't1')
  equal(Object.fromEntries(page.threads.map(thread => [thread.key, !!thread.context])), { 'feishu:oc_1:om_root': false,
    'github:7': true })
  equal(page.inputs.map(input => input.kind === 'trigger' && input.trigger?.handback), [{ reason: 'Asks for a new feature', at },
    undefined])
  equal(triggerView(snapshot(host), store.triggers.get('f2')).disposition.handbacks[0]?.title, 'Fix')
})

test('Policy 不再列出机器人之后，机器人 Mandate 仍按机器人叫', () => {
  const host = views()
  const mandate = { strength: 'inferred', policyVersion: 'v', basis: { via: 'bot',
    observation: { mode: 'auto' } },
    actor: { source: 'feishu', id: 'cli_removed' }, scope: '' }
  store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at, mandate,
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [], inputs: [] })
  equal(ticketDetail(host, 't1').mandate.actor, { source: 'feishu', id: 'cli_removed', name: feishuKind.policy.unnamed.bot })
})

test('工单决定跟帖期间、或再也没有工单决定它时，都允许人把它再送去评估', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: [], meta: {} })
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  const row = () => triggerView(snapshot(host), store.triggers.get('f1'))
  matched(row(), { actions: { requeue: true }, disposition: { delivered: true } })
  // worker 干完之后结束的工单不再归任何人：人仍可以把它送去评估。
  store.tickets.save({ ...store.tickets.get('t1'), ended: { at, by: 'executor', reason: 'done', outcome: 'completed' } })
  matched(row(), { actions: { requeue: true }, disposition: { delivered: false } })
  // worker 确认收下之后不行（收下就是拿走了它）；针对它的 stop 只决定工单的活。
  store.triggers.saveDisposition('f1', { fanout: ['t1'], acked: ['t1'], at })
  equal(row().actions.requeue, false)
  store.decisions.save({ id: 'stop', evalId: 'e', threadKey: 'feishu:oc_1:om_root', triggerIds: ['f1'], policyVersion: 'v', at, kind: 'stop',
    reason: [{ code: 'humanStop' }], strength: 'explicit', ticketId: 't1' })
  store.triggers.saveDisposition('f1', { fanout: ['t1'], decisionId: 'stop', at })
  equal(row().actions.requeue, true)
  // stop 结束工单、工单放开消息之后，也还能送（Engine 就是这么记的）。
  store.triggers.saveDisposition('f1', { fanout: [], decisionId: 'stop', at })
  equal(row().actions.requeue, true)
  // 送去之后就在等评估了。
  store.threads.save({ ...store.threads.get('feishu:oc_1:om_root'), pending: ['f1'] })
  store.triggers.saveDisposition('f1', { fanout: ['t1'], requeued: true, at })
  matched(row(), { actions: { requeue: false }, disposition: { queued: true } })
})

test('一页里的跟帖，每张工单只读一次；没有任何工单能决定的消息一次都不读', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [], pending: [], meta: {} })
  for (const id of ['f1', 'f2', 'f3']) {
    store.triggers.save(message(id, { source: 'feishu', id: 'ou_alice' }))
    store.triggers.saveDisposition(id, { fanout: ['t1'], at })
  }
  const view = snapshot(host)
  const read = store.tickets.get
  let reads = 0
  store.tickets.get = (id) => {
    reads += 1
    return read(id)
  }
  try {
    equal(['f1', 'f2', 'f3'].map(id => triggerView(view, store.triggers.get(id)).disposition.delivered), [true, true, true])
    equal(reads, 1)
  } finally {
    store.tickets.get = read
  }
  // 被工单交回的消息没有任何工单决定它，一次读都不用。
  store.triggers.saveDisposition('f3', { fanout: ['t1'], handbacks: [{ ticketId: 't1', reason: 'Another change', at }], at })
  let ticketReads = 0, threadReads = 0
  const records = { tickets: { get: () => { ticketReads += 1 } }, threads: { get: () => { threadReads += 1 } }, triggers: store.triggers }
  equal(followupOwners(store.triggers.get('f3'), records), [])
  equal([ticketReads, threadReads], [0, 0])
})
