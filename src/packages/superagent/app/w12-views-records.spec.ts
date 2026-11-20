/**
 * 覆盖补齐（W12）：管理视图 `app/views/{records,tickets,threads}.ts`。
 *
 * view 层只做投影：判错不抛错，只会让界面少说一句或多说一句（谁发的消息、线程在等什么、
 * 工单卡在哪、来源开着还是错着）。夹具用真 SQLite 临时库 + 真 SourceRegistry，因为投影读的就是库。
 *
 * @module @pneuma/superagent/app
 */
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { ChannelRef, Decision, Thread, Ticket, Trigger } from '../core/index.js'
import { SettingsSchema } from '../core/policy.js'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { feishuKind } from '../sources/feishu.js'
import { feishuChannel, feishuTriggerId } from '../sources/feishu-trigger.js'
import { githubKind } from '../sources/github.js'
import { githubChannel } from '../sources/github-trigger.js'
import { feishuLink } from '../sources/feishu-channel.js'
import { githubLink } from '../sources/github-channel.js'
import { SourceRegistry } from '../sources/registry.js'
import { Store } from './store.js'
import { awaitingEval, channelLink, decisionView, newestFirst, ownersOf, page, snapshot, threadFacts, threadSummary,
  threadTitle, ticketLine, ticketSummary, triggerView } from './views/records.js'
import { basisFacts, executorLoad, ticketDetail, ticketList, ticketRow } from './views/tickets.js'
import { decisionList, search, threadDetail, threadList } from './views/threads.js'

const at = '2026-01-01T00:00:00.000Z'
const older = '2025-12-31T00:00:00.000Z'
const links = (channel: ChannelRef) => (channel.source === 'feishu' ? feishuLink : githubLink)(channel.address, {})

const opened: Store[] = []
afterEach(() => {
  for (const store of opened.splice(0)) store.close()
})

/** 一套视图宿主：真设置（策略里各列一个允许的发送者）与注册了两个真 kind 的注册表。 */
function views() {
  const dir = createTempDir('dsc-sa-views-')
  const store = new Store(join(dir, 'orchestrator.sqlite'))
  opened.push(store)
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] },
    github: { allowed: [{ id: 'alice' }] } },
  rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix copy' }] } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(feishuKind)
  sources.register(githubKind)
  return { store, sources, links }
}

/** 一条飞书群消息（Trigger 只填判定用到的字段）。 */
const message = (id: string, actor = 'ou_alice', human = true, text = `message ${id}`): Trigger => ({
  id, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_root' }], actor: { source: 'feishu', id: actor },
  human, at, text, meta: {},
})
const thread = (overrides: Partial<Thread> = {}): Thread => ({
  key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: older, subscriptions: [],
  correlated: [], pending: [], meta: {}, ...overrides,
})
const mandate = {
  strength: 'explicit' as const, policyVersion: 'v1', basis: { via: 'listed' as const }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '',
}
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 't1', title: 'Fix the copy', decisionId: 'd1', mandate, channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: at, updatedAt: at, origin: { triggerId: 'e1', triggerIds: ['e1'] }, ...overrides,
})
const decision = (overrides: Partial<Decision> = {}): Decision => ({
  id: 'd1', evalId: 'ev1', threadKey: 'feishu:oc_1:om_root', triggerIds: ['e1'], policyVersion: 'v1', at,
  kind: 'accept', reason: [], strength: 'explicit', ...overrides,
})

describe('views/records：分页、发送者与工单/线程摘要', () => {
  test('page 截一段并给出下一页偏移；newestFirst 按更新时间倒序', () => {
    expect(page([1, 2, 3], 0, 2)).toEqual({ items: [1, 2], total: 3, next_offset: 2 })
    expect(page([1, 2, 3], 2, 2)).toEqual({ items: [3], total: 3, next_offset: null })
    const a = ticket({ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' })
    const b = ticket({ id: 'b', updatedAt: '2026-02-01T00:00:00.000Z' })
    expect([a, b].sort(newestFirst).map(item => item.id)).toEqual(['b', 'a'])
  })

  test('发送者按 Policy 名单称呼，认不出的按来源自己的叫法，空 id 不编名字', () => {
    const host = views()
    host.store.saveSettings({ ...host.store.settings(), policy: { ...host.store.settings().policy,
      sources: { ...host.store.settings().policy.sources,
        feishu: { ...host.store.settings().policy.sources.feishu, bots: [{ id: 'cli_review', name: '评审机器人' }] } } } })
    const view = snapshot(host)
    expect(view.actor({ source: 'feishu', id: 'ou_alice' })).toEqual({ source: 'feishu', id: 'ou_alice',
      name: { zh: 'Alice', en: 'Alice' } })
    expect(view.actor({ source: 'feishu', id: 'cli_review' }, false).name).toEqual({ zh: '评审机器人', en: '评审机器人' })
    expect(view.actor({ source: 'feishu', id: 'ou_bob' }).name).toEqual(feishuKind.policy!.unnamed!.person)
    expect(view.actor({ source: 'feishu', id: 'ou_bob' }, false).name).toEqual(feishuKind.policy!.unnamed!.bot)
    // GitHub 没有 unnamed 叫法，退回 id 本身。
    expect(view.actor({ source: 'github', id: 'bob' }).name).toEqual({ zh: 'bob', en: 'bob' })
    expect(view.actor({ source: 'github', id: 'bob' }, false).name).toEqual({ zh: 'bob', en: 'bob' })
    expect(view.actor({ source: 'github', id: '' })).toEqual({ source: 'github', id: '' })
    expect(view.rule('copy')).toEqual({ id: 'copy', name: 'Copy fixes' })
    expect(view.rule('gone')).toEqual({ id: 'gone', name: 'gone' })
  })

  test('threadsOf 按订阅倒排：一张工单订阅了几个线程都给出来', () => {
    const host = views()
    host.store.threads.save(thread({ subscriptions: ['t1'] }))
    host.store.threads.save(thread({ key: 'github:7', ref: { source: 'github', id: '7' }, subscriptions: ['t1'] }))
    host.store.threads.save(thread({ key: 'github:8', ref: { source: 'github', id: '8' }, subscriptions: [] }))
    const view = snapshot(host)
    expect(view.threadsOf('t1').map(item => item.key)).toEqual(['feishu:oc_1:om_root', 'github:7'])
    expect(view.threadsOf('missing')).toEqual([])
  })

  test('triggerView 按处置给出排队/送达/评估中，人的消息只在「没被决定」时能再送评估', () => {
    const host = views()
    const { store } = host
    store.threads.save(thread({ pending: ['e1'] }))
    store.triggers.save(message('e1'))
    const queued = triggerView(snapshot(host), store.triggers.get('e1')!)
    expect(queued.disposition).toMatchObject({ queued: true, delivered: false })
    expect(queued.actions.requeue).toBe(false)
    expect(queued.threads).toEqual(['feishu:oc_1:om_root'])
    expect(queued.actor).toEqual({ source: 'feishu', id: 'ou_alice', name: { zh: 'Alice', en: 'Alice' } })

    // 进入活工单：算送达，界面允许人再送评估；机器人发的则不给这个动作。
    store.tickets.save(ticket())
    store.triggers.saveDisposition('e1', { fanout: ['t1'], at })
    const delivered = triggerView(snapshot(host), store.triggers.get('e1')!)
    expect(delivered.disposition).toMatchObject({ queued: false, delivered: true })
    expect(delivered.actions.requeue).toBe(true)
    store.triggers.save(message('e2', 'ou_bot', false))
    store.triggers.saveDisposition('e2', { fanout: ['t1'], at })
    expect(triggerView(snapshot(host), store.triggers.get('e2')!).actions.requeue).toBe(false)

    // 工单收下（acked）之后由它决定；工单随后结束时没有工单再决定它，但收下过就不给再送。
    store.triggers.saveDisposition('e1', { fanout: ['t1'], acked: ['t1'], at })
    store.tickets.save({ ...ticket(), ended: { at, by: 'executor', outcome: 'completed' } })
    const acked = triggerView(snapshot(host), store.triggers.get('e1')!)
    expect(acked.disposition.delivered).toBe(false)
    expect(acked.actions.requeue).toBe(false)

    // 源过滤掉的、评估不可用的、以及只有 stop 决定的都算「没被决定」，人可以再送。
    store.threads.save(thread())
    store.triggers.saveDisposition('e1', { fanout: [], filtered: { code: 'not_a_member' }, at })
    expect(triggerView(snapshot(host), store.triggers.get('e1')!).disposition.filtered).toEqual({ code: 'not_a_member' })
    store.decisions.save(decision({ id: 'd-un', kind: 'unavailable', reason: [{ code: 'unavailable' }] }))
    expect(triggerView(snapshot(host), store.triggers.get('e1')!).actions.requeue).toBe(true)
    store.decisions.save(decision({ id: 'd-stop', kind: 'stop', reason: [{ code: 'humanStop' }] }))
    const stopped = triggerView(snapshot(host), store.triggers.get('e1')!)
    expect(stopped.disposition.decision).toMatchObject({ id: 'd-stop', outcome: 'stop' })
    expect(stopped.actions.requeue).toBe(true)
  })

  test('triggerView 的评估中/交回标题/显式传入的判定', () => {
    const host = views()
    const { store } = host
    const evaluating = { id: 'ev', threadKey: 'feishu:oc_1:om_root', triggerIds: ['e1'], strength: 'explicit' as const,
      actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed' as const }, policyVersion: 'v', startedAt: at, deadline: at }
    store.threads.save(thread({ evaluating }))
    store.triggers.save(message('e1'))
    expect(triggerView(snapshot(host), store.triggers.get('e1')!).disposition.evaluating).toBe(true)
    expect(triggerView(snapshot(host), store.triggers.get('e1')!).actions.requeue).toBe(false)

    // 交回的消息用来源工单的标题，不再显示工单 id。
    store.tickets.save(ticket())
    store.triggers.saveDisposition('e1', { fanout: ['t1'], handbacks: [{ ticketId: 't1', reason: 'Asks for more', at }], at })
    expect(triggerView(snapshot(host), store.triggers.get('e1')!).disposition.handbacks)
      .toEqual([{ ticketId: 't1', title: 'Fix the copy', reason: 'Asks for more', at }])

    // 显式传入的判定优先于按线程查出来的。
    store.triggers.save(message('e2'))
    const explicit = decision({ id: 'd2', kind: 'ignore', triggerIds: ['e2'] })
    expect(triggerView(snapshot(host), store.triggers.get('e2')!, [explicit]).disposition.decision)
      .toMatchObject({ id: 'd2', outcome: 'ignore' })
  })

  test('decisionView 读审计里的规则评估，兼容旧版 matches，ignore 在观察模式下给 wouldAccept', () => {
    const host = views()
    const { store } = host
    store.triggers.save(message('e1', 'ou_alice', true, 'please fix copy'))
    store.tickets.save(ticket())
    store.threads.save(thread())
    const view = snapshot(host)
    const full = decisionView(view, decision({ kind: 'ignore', ticketId: 't1', audit: { would_accept: true,
      rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'mentions copy' }],
      direction: { implementation_requested: true, target_basis: 'repo', requires_design_decision: false, evidence: 'diff' } } }))
    expect(full.outcome).toBe('wouldAccept')
    expect(full.rules).toEqual([{ id: 'copy', name: 'Copy fixes', matched: true, reason: 'mentions copy' }])
    expect(full.direction).toMatchObject({ implementation_requested: true })
    expect(full).toMatchObject({ thread: 'feishu:oc_1:om_root', threadTitle: 'please fix copy', preview: 'please fix copy',
      ticketTitle: 'Fix the copy' })

    // 旧版本把评估写在 matches 里，读出来都算 matched；audit 形状不对时整体降级成空审计。
    const legacy = decisionView(view, decision({ audit: { matches: [{ rule_id: 'copy', reason: 'old' }] } }))
    expect(legacy.rules).toEqual([{ id: 'copy', name: 'Copy fixes', matched: true, reason: 'old' }])
    expect(legacy.outcome).toBe('accept')
    expect(decisionView(view, decision({ audit: { would_accept: 'nope' } })).outcome).toBe('accept')
    expect(decisionView(view, decision({ ticketId: 'missing' })).ticketTitle).toBeUndefined()
  })

  test('线程标题：描述优先，其次最早的人发消息，再其次最早的任意消息，都没有就用 key', () => {
    const host = views()
    const { store } = host
    const bare = thread({ key: 'github:9', ref: { source: 'github', id: '9' } })
    store.threads.save(bare)
    expect(threadTitle(store, bare)).toBe('github:9')

    store.triggers.save({ ...message('e-old'), threads: [{ source: 'github', id: '9' }], source: 'github', human: false,
      at: older, text: 'automated' })
    expect(threadTitle(store, bare)).toBe('automated')
    store.triggers.save({ ...message('e-human'), threads: [{ source: 'github', id: '9' }], source: 'github', human: true,
      at: '2025-12-31T12:00:00.000Z', text: 'a person wrote this' })
    expect(threadTitle(store, bare)).toBe('a person wrote this')

    const described = thread({ subscriptions: ['t1'], meta: { label: 'Named thread', url: 'https://thread' } })
    store.threads.save(described)
    expect(threadTitle(store, described)).toBe('Named thread')
    expect(threadFacts(store, described)).toEqual({ key: 'feishu:oc_1:om_root', source: 'feishu', title: 'Named thread',
      url: 'https://thread', facts: {} })
    // 没有描述时用最早一条消息的 url。
    expect(threadFacts(store, thread()).url).toBeUndefined()
  })

  test('线程阶段：轮询错 > 评估中 > 排队 > 有开放工单订阅 > 只有结束工单 > 无人订阅', () => {
    const host = views()
    const { store } = host
    const view = snapshot(host)
    const stage = (item: Thread) => threadSummary(view, item).stage
    expect(stage(thread({ meta: { pollError: 'boom' } }))).toBe('error')
    expect(stage(thread({ evaluating: { id: 'ev', threadKey: 'feishu:oc_1:om_root', triggerIds: [], strength: 'explicit',
      actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed' }, policyVersion: 'v', startedAt: at, deadline: at } })))
      .toBe('evaluating')
    store.triggers.save(message('e1'))
    expect(stage(thread({ pending: ['e1'] }))).toBe('queued')
    // 已在工单里的跟进不算在等评估（旧版本可能还把它留在队列里）。
    store.tickets.save(ticket())
    store.triggers.saveDisposition('e1', { fanout: ['t1'], at })
    expect(stage(thread({ subscriptions: ['t1'], pending: ['e1'] }))).toBe('subscribed')
    store.tickets.save({ ...ticket(), ended: { at, by: 'executor', outcome: 'completed' } })
    expect(stage(thread({ subscriptions: ['t1'] }))).toBe('dormant')
    expect(stage(thread())).toBe('unsubscribed')
  })

  test('threadSummary 的订阅明细、最新消息、评估窗口与待评估数都能读出来', () => {
    const host = views()
    const { store } = host
    store.tickets.save(ticket())
    store.tickets.save(ticket({ id: 't2', title: 'Second', ended: { at, by: 'human', outcome: 'stopped' } }))
    store.triggers.save(message('e1', 'ou_alice', true, 'latest on thread'))
    const summary = threadSummary(snapshot(host), thread({ key: 'feishu:oc_1:om_root', subscriptions: ['t1', 't2', 'gone'],
      pending: ['e-missing'] }))
    expect(summary.tickets).toEqual([
      { id: 't1', title: 'Fix the copy', state: 'open' },
      { id: 't2', title: 'Second', state: 'ended' },
      { id: 'gone', title: 'gone', state: 'unknown' },
    ])
    // 队列里已没有存储记录的 Trigger 仍在等评估。
    expect(summary.pending).toBe(1)
    expect(summary.latest).toMatchObject({ actor: { id: 'ou_alice' }, human: true, preview: 'latest on thread' })
    expect(summary.lastAt).toBe(older)
    expect(summary.evaluating).toBeUndefined()
    store.triggers.saveDisposition('e1', { fanout: ['t1'], at })
    expect(ownersOf(store)(store.triggers.get('e1')!)).toEqual(['t1'])
  })

  test('channelLink：消息自带 URL 时优先用它，否则用来源给的链接', () => {
    const host = views()
    const { store } = host
    store.triggers.save({ ...message('e1'), url: 'https://feishu/message/1' })
    const channel = feishuChannel('oc_1', 'om_1')
    expect(channelLink(host, channel)).toMatchObject({ url: expect.stringContaining('applink'), source: 'feishu' })
    // 链接指向的 Trigger 有 URL 时覆盖来源的兜底链接。
    expect(channelLink(host, { ...channel, address: { chatId: 'oc_1', messageId: 'om_1' } }).url)
      .toContain('applink')
    store.triggers.save({ ...message(feishuTriggerId('om_1'), 'ou_alice', true), threads: [], url: 'https://direct' })
    expect(channelLink(host, channel).url).toBe('https://direct')
    expect(channelLink(host, githubChannel(42)).label).toEqual({ zh: 'GitHub #42', en: 'GitHub #42' })
  })

  test('ticketSummary 与 ticketLine：阶段、备注、重试、会话与目录', () => {
    const host = views()
    const { store } = host
    const view = snapshot(host)
    // 等回答：备注是问题正文（去掉行内标记后的纯文本），不能重试。
    const asking = ticket({ attention: { id: 'att', question: '**Which** copy?' } })
    expect(ticketSummary(asking)).toMatchObject({ stage: 'person', action: 'answer', actions: { retry: false, stop: true },
      note: { text: 'Which copy?', error: false }, attention: { question: '**Which** copy?' } })
    // 交付失败：备注是错误，可以重试。
    const delivery = ticket({ delivery: { error: 'channel gone', at } })
    expect(ticketSummary(delivery)).toMatchObject({ action: 'delivery', actions: { retry: true },
      note: { text: 'channel gone', error: true }, deliveryError: 'channel gone' })
    // blocked/failed 的报告：备注是第一行摘要。
    const blocked = ticket({ assignments: [{ id: 'a1', state: 'running', createdAt: at, startedAt: at,
      report: { state: 'blocked', summary: 'Need files\nmore', at } }] })
    expect(ticketSummary(blocked)).toMatchObject({ action: 'blocked', note: { text: 'Need files', error: false },
      sessionId: 'worker-t1' })
    const failed = ticket({ assignments: [{ id: 'a1', state: 'running', createdAt: at, startedAt: at,
      report: { state: 'failed', summary: 'Broke', at } }] })
    expect(ticketSummary(failed)).toMatchObject({ action: 'failed', note: { text: 'Broke', error: true } })
    // 有结果待验收：没有备注。
    const review = ticket({ assignments: [{ id: 'a1', state: 'ended', createdAt: at,
      report: { state: 'ready', summary: 'done', at } }] })
    expect(ticketSummary(review)).toMatchObject({ action: 'review', state: 'open', summary: 'done' })
    expect('note' in ticketSummary(review)).toBe(false)
    // 已结束的工单 state=ended，且给出结束原因与运行目录。
    expect(ticketSummary(ticket({ ended: { at, by: 'executor', outcome: 'merged' },
      execution: { name: 'fix', directory: '/work/t1', assignment: '' } }))).toMatchObject({ state: 'ended',
      ended: { outcome: 'merged' }, directory: '/work/t1' })
    // 没有 startedAt 的 assignment 不算有 worker 会话。
    expect(ticketSummary(ticket({ assignments: [{ id: 'a1', state: 'pending', createdAt: at }] })).sessionId).toBe('')
    store.tickets.save(ticket())
    expect(ticketLine(view, store.tickets.get('t1')!)).toMatchObject({ id: 't1', threads: [] })
  })

  test('ticketRow：person 阶段且有 Channel 时给回复链接', () => {
    const host = views()
    const { store } = host
    const view = snapshot(host)
    const withChannel = ticket({ attention: { id: 'att', question: 'Which?' }, channels: [feishuChannel('oc_1', 'om_1')] })
    expect(ticketRow(view, withChannel).reply).toMatchObject({ source: 'feishu' })
    expect('reply' in ticketRow(view, ticket())).toBe(false)
    store.tickets.save(withChannel)
    expect(store.tickets.open().map(item => item.id)).toEqual(['t1'])
  })
})

describe('views/tickets：依据事实、列表、详情与执行器负载', () => {
  test('basisFacts 按 via 展开，旧记录的 authority 标成 legacy', () => {
    const host = views()
    const rule = snapshot(host).rule
    expect(basisFacts({ via: 'admission', cell: 'listedUnaddressed', sender: 'Alice', addressed: 'mention',
      observation: { mode: 'auto' } }, rule).facts).toEqual([{ name: 'sender', value: 'Alice' },
      { name: 'addressed', value: 'mention' }, { name: 'admission', value: 'listedUnaddressed' }, { name: 'observation' },
      { name: 'mode', value: 'auto' }])
    expect(basisFacts({ via: 'followup' }, rule).facts).toEqual([{ name: 'followup' }])
    expect(basisFacts({ via: 'followup', authority: 'listed' }, rule)).toEqual({ facts: [{ name: 'legacyAuthority',
      value: 'listed' }], legacy: true })
    expect(basisFacts({ via: 'listed', addressed: 'direct', observation: { mode: 'observe' }, authority: 'gate',
      rules: ['copy'] }, rule).facts).toEqual([{ name: 'addressed', value: 'direct' }, { name: 'observation' },
      { name: 'mode', value: 'observe' }, { name: 'rules', value: [{ id: 'copy', name: 'Copy fixes' }] },
      { name: 'legacyAuthority', value: 'gate' }])
    // 机器人消息只从 observation 取 accept mode，不显示「观察」这条事实。
    expect(basisFacts({ via: 'bot', observation: { mode: 'auto' } }, rule).facts).toEqual([{ name: 'bot' },
      { name: 'mode', value: 'auto' }])
    expect(basisFacts({ via: 'addressed', addressed: 'mention' }, rule)).toEqual({ facts: [{ name: 'addressed',
      value: 'mention' }], legacy: false })
  })

  test('ticketList 按 open / ended / 具体阶段筛选并分页', () => {
    const host = views()
    const { store } = host
    store.tickets.save(ticket({ id: 'open1', updatedAt: '2026-01-03T00:00:00.000Z' }))
    store.tickets.save(ticket({ id: 'open2', updatedAt: '2026-01-02T00:00:00.000Z',
      attention: { id: 'att', question: 'Which?' } }))
    store.tickets.save(ticket({ id: 'done', updatedAt: '2026-01-01T00:00:00.000Z',
      ended: { at, by: 'executor', outcome: 'completed' } }))
    expect(ticketList(host, 'open', 0, 1)).toMatchObject({ total: 2, next_offset: 1,
      items: [{ id: 'open1' }] })
    expect(ticketList(host, 'open', 1, 5).items.map(item => item.id)).toEqual(['open2'])
    expect(ticketList(host, 'ended', 0, 5).items.map(item => item.id)).toEqual(['done'])
    expect(ticketList(host, 'person', 0, 5).items.map(item => item.id)).toEqual(['open2'])
    expect(ticketList(host, 'idle', 0, 5).items).toEqual([])
  })

  test('executorLoad 只数排队等槽位的工单', () => {
    const host = views()
    const { store } = host
    store.tickets.save(ticket({ id: 'queued', assignments: [{ id: 'a', state: 'pending', createdAt: at }] }))
    store.tickets.save(ticket({ id: 'running', assignments: [{ id: 'a', state: 'running', createdAt: at, startedAt: at }] }))
    store.tickets.save(ticket({ id: 'ended', ended: { at, by: 'executor', outcome: 'completed' } }))
    expect(executorLoad(store, 3)).toEqual({ running: 3, queued: 1 })
  })

  test('ticketDetail 拼出 decision、channel、输入、assignment 回合与上下文线程', () => {
    const host = views()
    const { store } = host
    store.triggers.save(message('e1'))
    store.triggers.saveDisposition('e1', { fanout: [], handbacks: [{ ticketId: 't1', reason: 'beyond scope', at }], at })
    store.decisions.save(decision({ ticketId: 't1' }))
    store.threads.save(thread({ subscriptions: ['t1'], context: ['t1'] }))
    store.tickets.save(ticket({ channels: [feishuChannel('oc_1', 'om_1')],
      assignments: [{ id: 'a1', state: 'running', createdAt: at, startedAt: at,
        report: { state: 'ready', summary: 'done', at } }],
      inputs: [
        { id: 'in1', kind: 'trigger', triggerId: 'e1', at },
        { id: 'in2', kind: 'text', text: '**note**', at },
        { id: 'in3', kind: 'trigger', triggerId: 'missing', at },
      ], undelivered: ['in2'] }))
    const view = ticketDetail(host, 't1')!
    expect(view.paused).toBe(false)
    expect(view.decision).toMatchObject({ id: 'd1' })
    expect(view.channels).toEqual([expect.objectContaining({ source: 'feishu' })])
    // 输入倒序给出；找不到 Trigger 的那条没有 trigger 字段。
    expect(view.inputs.map(item => [item.id, 'trigger' in item])).toEqual([
      ['in3', false], ['in2', false], ['in1', true]])
    expect(view.inputs[2]).toMatchObject({ delivered: true, trigger: { handback: { reason: 'beyond scope', at } } })
    expect(view.inputs[1]).toMatchObject({ delivered: false, text: '**note**' })
    // 已启动的 assignment 带 worker 会话；ready 报告且工单不在 working，带上回合结束时间。
    expect(view.assignments[0]).toMatchObject({ ref: 'worker-t1', turnEndedAt: at })
    // 上下文跟随的线程标 context。
    expect(view.threads).toEqual([expect.objectContaining({ key: 'feishu:oc_1:om_root', context: true })])
    expect(ticketDetail(host, 'missing')).toBeUndefined()
  })

  test('ticketDetail 的机器人 Mandate 仍按机器人称呼', () => {
    const host = views()
    host.store.tickets.save(ticket({ id: 'bot', mandate: { strength: 'inferred', policyVersion: 'v',
      basis: { via: 'bot', observation: { mode: 'auto' } }, actor: { source: 'feishu', id: 'cli_removed' }, scope: '' } }))
    expect(ticketDetail(host, 'bot')!.mandate.actor).toEqual({ source: 'feishu', id: 'cli_removed',
      name: feishuKind.policy!.unnamed!.bot })
  })
})

describe('views/threads：列表、时间线、搜索与判定列表', () => {
  test('threadList 四种过滤：全部、最近、有活工单订阅、在评估或排队', () => {
    const host = views()
    const { store } = host
    const now = new Date().toISOString()
    store.tickets.save(ticket())
    store.threads.save(thread({ key: 'feishu:a', ref: { source: 'feishu', id: 'a' }, subscriptions: ['t1'], lastAt: now }))
    store.threads.save(thread({ key: 'github:b', ref: { source: 'github', id: 'b' }, lastAt: '2025-01-01T00:00:00.000Z' }))
    store.threads.save(thread({ key: 'github:c', ref: { source: 'github', id: 'c' }, createdAt: now, pending: ['gone'] }))
    const keys = (filter: 'all' | 'recent' | 'subscribed' | 'evaluating') =>
      threadList(host, filter, 0, 10).items.map(item => item.key)
    expect(keys('all')).toEqual(['feishu:a', 'github:c', 'github:b'])
    expect(keys('recent')).toEqual(['feishu:a', 'github:c'])
    expect(keys('subscribed')).toEqual(['feishu:a'])
    expect(keys('evaluating')).toEqual(['github:c'])
    expect(threadList(host, 'all', 0, 1)).toMatchObject({ total: 3, next_offset: 1 })
  })

  test('threadDetail 返回时间线、判定、工单、相关线程与分页游标', () => {
    const host = views()
    const { store } = host
    expect(threadDetail(host, 'missing', undefined, 50)).toBeUndefined()
    store.triggers.save(message('e1'))
    store.triggers.save(message('e2'))
    store.triggers.save(message('e3'))
    store.threads.save(thread({ key: 'feishu:oc_1:om_root', subscriptions: ['t1'], correlated: ['github:7', 'github:8'],
      context: ['t1'] }))
    store.threads.save(thread({ key: 'github:7', ref: { source: 'github', id: '7' }, meta: { label: 'Related PR' } }))
    store.tickets.save(ticket())
    store.decisions.save(decision({ id: 'd1', triggerIds: ['e1'] }))
    const page = threadDetail(host, 'feishu:oc_1:om_root', undefined, 2)!
    // limit=2，取 3 条后丢掉最旧的一条，earlier 指向剩下最早的一条。
    expect(page.timeline.map(item => item.id)).toEqual(['e2', 'e3'])
    expect(page.earlier).toBe(`${at}|e2`)
    expect(page.decisions.map(item => item.id)).toEqual(['d1'])
    expect(page.tickets.map(item => item.id)).toEqual(['t1'])
    expect(page.correlated).toEqual([{ key: 'github:7', title: 'Related PR' }, { key: 'github:8', title: 'github:8' }])
    expect(page.context).toEqual(['t1'])
    // before 游标往前翻页。
    const before = threadDetail(host, 'feishu:oc_1:om_root', `${at}|e3`, 1)!
    expect(before.timeline.map(item => item.id)).toEqual(['e2'])
    // around 锚定在指定消息，含它自己。
    const around = threadDetail(host, 'feishu:oc_1:om_root', undefined, 5, 'e2')!
    expect(around.timeline.map(item => item.id)).toEqual(['e1', 'e2'])
    // thread 自己的 url 优先，其次最早消息的 url，最后用来源链接。
    store.threads.save(thread({ key: 'feishu:oc_1:om_root', meta: { url: 'https://thread' }, correlated: [] }))
    expect(threadDetail(host, 'feishu:oc_1:om_root', undefined, 5)!.url).toBe('https://thread')
  })

  test('search：空词直接空结果；GitHub 编号命中线程；标题与链接缓存都能搜到', () => {
    const host = views()
    const { store } = host
    expect(search(host, '   ', new Map() as never)).toEqual({ tickets: [], items: [], threads: [] })
    store.threads.save(thread({ key: 'github:12', ref: { source: 'github', id: '12' } }))
    store.triggers.save({ ...message('e1', 'ou_alice', false, 'see #12'), source: 'github', human: false,
      threads: [{ source: 'github', id: '12' }], actor: { source: 'github', id: 'alice' } })
    const found = search(host, '#12', new Map() as never)
    expect(found.threads.map(item => item.key)).toEqual(['github:12'])
    // 自动消息所在的线程已经在 threads 里，items 不再重复列。
    expect(found.items).toEqual([])
    // 工单按标题命中。
    store.tickets.save(ticket({ title: 'Rewrite the release notes' }))
    expect(search(host, 'release notes', new Map() as never).tickets.map(item => item.id)).toEqual(['t1'])
    // 链接缓存：值就是搜索词时，取 key 的最后一段当搜索词。
    store.triggers.save({ ...message('e2', 'ou_alice', true, 'link message'), meta: { messageId: 'om_9' } })
    const cache = new Map([['oc_1:om_9', 'https://feishu/x']])
    expect(search(host, 'https://feishu/x', cache as never).items.map(item => item.id)).toEqual(['e2'])
    // 被源过滤、没有线程记录的消息把过滤原因带出来。
    store.triggers.save({ ...message('e3'), threads: [{ source: 'feishu', id: 'oc_missing' }] })
    store.triggers.saveDisposition('e3', { fanout: [], filtered: { code: 'not_a_member' }, at })
    expect(search(host, 'message e3', new Map() as never).items[0]).toMatchObject({ id: 'e3',
      filtered: { code: 'not_a_member' } })
  })

  test('search 里命中来源的术语集合也参与搜索', () => {
    const host = views()
    const { store } = host
    // github kind 的 find 只给线程，不给术语；feishu 没有 find。
    expect(host.sources.find('#4')).toEqual({ threads: ['github:4'], terms: [] })
    store.threads.save(thread({ key: 'github:4', ref: { source: 'github', id: '4' } }))
    expect(search(host, '4', new Map() as never).threads.map(item => item.key)).toEqual(['github:4'])
  })

  test('decisionList 分页并给 next_offset', () => {
    const host = views()
    const { store } = host
    store.triggers.save(message('e1'))
    store.decisions.save(decision({ id: 'd1' }))
    store.decisions.save(decision({ id: 'd2', kind: 'ignore', triggerIds: ['e1'] }))
    expect(decisionList(host, [], 0, 1)).toMatchObject({ next_offset: 1, items: [{ id: 'd2' }] })
    expect(decisionList(host, ['ignore'], 0, 5).items.map(item => item.id)).toEqual(['d2'])
    expect(decisionList(host, [], 0, 5).items).toHaveLength(2)
  })
})
