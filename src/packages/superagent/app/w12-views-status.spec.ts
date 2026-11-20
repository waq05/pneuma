/**
 * 覆盖补齐（W12）：管理视图 `app/views/{overview,sources,settings}.ts`。
 *
 * 总览把「当前有什么问题、谁在等、执行器多忙、24 小时 Trigger 流向」拼成一块面板；
 * 来源状态与设置视图各自读来源健康、策略段与执行环境。夹具用真 SQLite 临时库 + 真 SourceRegistry。
 *
 * @module @pneuma/superagent/app
 */
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { Decision, Thread, Ticket, Trigger } from '../core/index.js'
import { SettingsSchema, policyVersion } from '../core/policy.js'
import { KV } from '../kv.js'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { feishuKind } from '../sources/feishu.js'
import { feishuChannel, feishuTriggerId } from '../sources/feishu-trigger.js'
import { githubKind } from '../sources/github.js'
import { githubChannel } from '../sources/github-trigger.js'
import { feishuLink } from '../sources/feishu-channel.js'
import { githubLink } from '../sources/github-channel.js'
import { SourceRegistry } from '../sources/registry.js'
import type { Health } from '../sources/host.js'
import { Store } from './store.js'
import { evalsHealth, overview } from './views/overview.js'
import { droppedReplies, problemOf, sourceHealth, sourcesStatus, type SetupState } from './views/sources.js'
import { settingsView } from './views/settings.js'
import type { ExecutorLoad } from './views/tickets.js'

const now = new Date().toISOString()
const hourAgo = new Date(Date.now() - 60_000).toISOString()
const twoHoursAgo = new Date(Date.now() - 7_200_000).toISOString()
/** 通道链接：按来源给兜底 URL 与触发 id。 */
const links = (channel: { source: string; address: Record<string, string> }) =>
  channel.source === 'feishu' ? feishuLink(channel.address, {}) : githubLink(channel.address, {})

const opened: Store[] = []
afterEach(() => {
  for (const store of opened.splice(0)) store.close()
})

function views() {
  const dir = createTempDir('dsc-sa-status-')
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

const message = (id: string, overrides: Partial<Trigger> = {}): Trigger => ({
  id, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_root' }], actor: { source: 'feishu', id: 'ou_alice' },
  human: true, at: now, text: `message ${id}`, meta: {}, ...overrides,
})
const thread = (overrides: Partial<Thread> = {}): Thread => ({
  key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: now, subscriptions: [],
  correlated: [], pending: [], meta: {}, ...overrides,
})
const mandate = {
  strength: 'explicit' as const, policyVersion: 'v1', basis: { via: 'listed' as const }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '',
}
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 't1', title: 'Fix the copy', decisionId: 'd1', mandate, channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: now, updatedAt: now, origin: { triggerId: 'e1', triggerIds: ['e1'] }, ...overrides,
})
const decision = (overrides: Partial<Decision> = {}): Decision => ({
  id: 'd1', evalId: 'ev1', threadKey: 'feishu:oc_1:om_root', triggerIds: ['e1'], policyVersion: 'v1', at: now,
  kind: 'accept', reason: [], strength: 'explicit', ...overrides,
})

describe('views/overview：不可用评估与总览问题清单', () => {
  test('evalsHealth：近一小时没有不可用评估就是 ready', () => {
    const host = views()
    expect(evalsHealth(host.store)).toEqual({ state: 'ready', detail: 'No unavailable Eval in the last hour' })
    // 超过一小时的评估不再算「最近」。
    host.store.threads.save(thread())
    host.store.decisions.save(decision({ id: 'old', kind: 'unavailable', at: twoHoursAgo, reason: [{ code: 'unavailable' }] }))
    expect(evalsHealth(host.store)).toEqual({ state: 'ready', detail: 'No unavailable Eval in the last hour' })
  })

  test('evalsHealth：最新判定是未处理的不可用评估时报错，并数出条数与最近一条', () => {
    const host = views()
    const { store } = host
    store.threads.save(thread())
    store.decisions.save(decision({ id: 'd-un', kind: 'unavailable', at: hourAgo, reason: [{ code: 'noModel' }] }))
    const health = evalsHealth(store)
    expect(health.state).toBe('error')
    expect(health.at).toBe(hourAgo)
    expect(health.detail).toContain('1 Eval(s) unavailable in the last hour')
    expect(health.detail).toContain('feishu:oc_1:om_root')
  })

  test('evalsHealth 的排除项：已忽略、线程不在、正在评估、队列里还有工单决定的跟进、已有更新判定', () => {
    const dismissing = views()
    dismissing.store.threads.save(thread())
    dismissing.store.decisions.save(decision({ id: 'd', kind: 'unavailable', at: hourAgo, dismissed: true }))
    expect(evalsHealth(dismissing.store).state).toBe('ready')

    const gone = views()
    gone.store.decisions.save(decision({ id: 'd', kind: 'unavailable', at: hourAgo }))
    expect(evalsHealth(gone.store).state).toBe('ready')

    const evaluating = views()
    evaluating.store.threads.save(thread({ evaluating: { id: 'ev', threadKey: 'feishu:oc_1:om_root', triggerIds: ['e1'],
      strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed' }, policyVersion: 'v',
      startedAt: now, deadline: now } }))
    evaluating.store.decisions.save(decision({ id: 'd', kind: 'unavailable', at: hourAgo }))
    expect(evalsHealth(evaluating.store).state).toBe('ready')

    const queued = views()
    queued.store.threads.save(thread({ pending: ['e1'] }))
    queued.store.decisions.save(decision({ id: 'd', kind: 'unavailable', at: hourAgo }))
    expect(evalsHealth(queued.store).state).toBe('ready')

    const judged = views()
    judged.store.threads.save(thread())
    judged.store.decisions.save(decision({ id: 'old-unavailable', kind: 'unavailable', at: hourAgo }))
    judged.store.decisions.save(decision({ id: 'newer', kind: 'ignore', at: now }))
    expect(evalsHealth(judged.store).state).toBe('ready')
  })

  test('overview 的问题清单按类别逐条给出：setup、无来源、无发送者、来源错误、暂停、运行时错误、逾期与不可用评估', () => {
    const host = views()
    const { store, sources } = host
    const load: ExecutorLoad = { running: 1, queued: 0 }
    const base = overview(host, {}, 'v1', load)
    expect(base.problems).toEqual([])
    expect(base.executor).toMatchObject({ running: 1, queued: 0, maxWorkers: store.settings().executor.maxWorkers })
    expect(base.policyVersion).toBe('v1')

    const setup = { place: 'deployment' as const, code: 'environmentFailed' as const, values: {}, detail: 'set the state dir' }
    expect(overview(host, {}, 'v1', load, setup).problems).toEqual([{ kind: 'setup', ...setup }])

    // 没有允许的发送者，也没有来源在跑。
    store.saveSettings({ ...store.settings(), policy: { ...store.settings().policy, sources: {} },
      sources: { feishu: { enabled: false, config: {} }, github: { enabled: false, config: {} } } })
    const empty = overview(host, {}, 'v1', load).problems.map(item => item.kind)
    expect(empty).toEqual(['no-source', 'no-allowed'])
    // 停用全局处理。
    store.saveSettings({ ...store.settings(), paused: true })
    expect(overview(host, {}, 'v1', load).problems.map(item => item.kind)).toEqual(['no-source', 'no-allowed',
      'executor-paused'])
    // 来源报错：只有已启用、已安装的来源才计入。
    store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } }))
    const sourceError: Health = { state: 'error', detail: 'socket closed' }
    const withSourceError = overview(host, { feishu: sourceError, history: { state: 'ready', detail: '' } }, 'v1', load)
      .problems.filter(item => item.kind === 'source-error')
    expect(withSourceError).toEqual([{ kind: 'source-error', source: { id: 'feishu', title: feishuKind.title,
      health: { name: 'feishu', state: 'error', detail: 'socket closed' } } }])
    // 运行时报错：来源自己的体检格与 sync: 前缀、evals 格都不算。
    const runtime = overview(host, { relay: sourceError, history: { state: 'error', detail: 'x' }, 'sync:feishu': sourceError,
      evals: sourceError }, 'v1', load).problems.filter(item => item.kind === 'runtime-error')
    expect(runtime).toEqual([{ kind: 'runtime-error', name: 'relay', detail: 'socket closed' }])
    // 越过截止时间的评估。
    store.threads.save(thread({ evaluating: { id: 'ev', threadKey: 'feishu:oc_1:om_root', triggerIds: ['e1'],
      strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed' }, policyVersion: 'v',
      startedAt: twoHoursAgo, deadline: twoHoursAgo } }))
    const overdue = overview(host, {}, 'v1', load).problems.filter(item => item.kind === 'eval-overdue')
    expect(overdue).toEqual([{ kind: 'eval-overdue', thread: expect.objectContaining({ key: 'feishu:oc_1:om_root' }) }])
    // 不可用评估（24 小时窗口）逐条列出。
    store.threads.save(thread())
    store.decisions.save(decision({ id: 'd-un', kind: 'unavailable', at: hourAgo, reason: [{ code: 'noModel' }],
      triggerIds: ['e1'] }))
    const unavailable = overview(host, {}, 'v1', load).problems.filter(item => item.kind === 'eval-unavailable')
    expect(unavailable).toEqual([{ kind: 'eval-unavailable', decisionId: 'd-un', thread: expect.objectContaining({
      key: 'feishu:oc_1:om_root' }), reason: [{ code: 'noModel' }], triggerId: 'e1' }])
  })

  test('overview 的 outgoing、person、idle 与 24 小时流向', () => {
    const host = views()
    const { store } = host
    store.triggers.save(message('e1'))
    store.tickets.save(ticket({ id: 'waiting', updatedAt: '2026-01-02T00:00:00.000Z',
      attention: { id: 'att', question: 'Which?' } }))
    store.tickets.save(ticket({ id: 'idle', updatedAt: '2026-01-01T00:00:00.000Z',
      assignments: [{ id: 'a', state: 'ended', createdAt: now, report: { state: 'waiting', summary: 'waiting', at: now } }] }))
    store.decisions.save(decision({ id: 'd-accept', kind: 'accept', triggerIds: ['e1'] }))
    // 一条投递失败的回复：收据落在 outbox，失败次数落在 effect 行。
    const receipt = { id: 'm1', channel: feishuChannel('oc_1', 'om_1'), text: 'reply text', kind: 'reply' as const }
    store.receipts.add(receipt)
    store.db.prepare(`INSERT INTO effect (kind, key, value, seq, generation, attempts, error, due, since)
      VALUES ('reply', ?, ?, 1, 0, 2, 'boom', 0, ?)`).run('m1', '{}', now)
    // 一条被丢弃的回复计入 dropped。
    const dropped = { id: 'm2', channel: feishuChannel('oc_1', 'om_2'), text: 'gone', kind: 'reply' as const }
    store.receipts.add(dropped)
    store.receipts.settle(dropped, 'channelGone')

    const view = overview(host, {}, 'v1', { running: 2, queued: 1 })
    expect(view.problems.filter(item => item.kind === 'outgoing')).toEqual([{ kind: 'outgoing',
      outgoing: { id: 'm1', channel: receipt.channel, text: 'reply text', attempts: 2, error: 'boom' } }])
    expect(view.person.map(item => item.id)).toEqual(['waiting'])
    expect(view.executor.idle).toBe(1)
    expect(view.flow).toMatchObject({ received: 1, filtered: 0, triggers: 1, judged: 1, accepted: 1, evaluating: 0, dropped: 1 })
    // 逾期评估也算进 evaluating 数。
    store.threads.save(thread({ evaluating: { id: 'ev', threadKey: 'feishu:oc_1:om_root', triggerIds: [], strength: 'explicit',
      actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed' }, policyVersion: 'v', startedAt: now, deadline: now } }))
    expect(overview(host, {}, 'v1', { running: 0, queued: 0 }).flow.evaluating).toBe(1)
  })
})

describe('views/sources：来源健康、状态与丢弃回复', () => {
  test('sourceHealth：缺体检格与已停用的旧报告都当作 starting', () => {
    const host = views()
    const instance = { id: 'feishu', kind: 'feishu', enabled: true, config: {} }
    expect(sourceHealth(host.sources, instance, {})).toEqual({ id: 'feishu', title: feishuKind.title,
      health: [{ name: 'feishu', state: 'starting', detail: '' }, { name: 'history', state: 'starting', detail: '' }] })
    expect(sourceHealth(host.sources, instance, { feishu: { state: 'error', detail: 'x' },
      history: { state: 'ready', code: 'sourceOff', detail: '' } }).health).toEqual([
      { name: 'feishu', state: 'error', detail: 'x' },
      { name: 'history', state: 'starting', detail: '' },
    ])
    // 停用的来源保留它自己的旧报告。
    const off = { ...instance, enabled: false }
    expect(sourceHealth(host.sources, off, { feishu: { state: 'ready', code: 'sourceOff', detail: '' } }).health[0])
      .toEqual({ name: 'feishu', state: 'ready', code: 'sourceOff', detail: '' })
    // 没注册的 kind 用实例 id 当标题。
    expect(sourceHealth(host.sources, { id: 'jira', kind: 'jira', enabled: true, config: {} }, {})).toEqual({
      id: 'jira', title: { zh: 'jira', en: 'jira' }, health: [] })
  })

  test('problemOf 只认 place 对得上的那个问题；setup 与 feishuProblem 都参与', () => {
    const setup: SetupState = { problem: { place: 'deployment', code: 'environmentFailed' as const, values: {}, detail: 'x' },
      feishuProblem: { place: 'feishu', code: 'feishuNoApp', values: {}, detail: 'y' } }
    expect(problemOf('feishu', setup)?.code).toBe('feishuNoApp')
    expect(problemOf('deployment', setup)?.code).toBe('environmentFailed')
    expect(problemOf('github', setup)).toBeUndefined()
    expect(problemOf('feishu', {})).toBeUndefined()
  })

  test('sourcesStatus：每个来源按第一个成立的状态说话，并带 24 小时统计与过滤列表', () => {
    const host = views()
    const { store } = host
    const state = (setup: SetupState, health: Record<string, Health> = {}) =>
      Object.fromEntries(sourcesStatus(host, health, setup).map(source => [source.id, source.state]))
    expect(state({})).toEqual({ feishu: 'starting', github: 'starting' })
    expect(state({}, { feishu: { state: 'ready', detail: '' }, history: { state: 'paused', detail: '' },
      github: { state: 'error', detail: 'x' } })).toEqual({ feishu: 'paused', github: 'error' })
    const problem = { place: 'deployment' as const, code: 'environmentFailed' as const, values: {}, detail: '' }
    expect(state({ problem }, { feishu: { state: 'ready', detail: '' }, history: { state: 'ready', detail: '' },
      github: { state: 'ready', detail: '' } })).toEqual({ feishu: 'setup', github: 'setup' })
    // 来源自己的问题让它 error；未安装（设置里存了、kind 没装）是 missing；停用是 off。
    expect(state({ feishuProblem: { place: 'feishu', code: 'feishuNoApp', values: {}, detail: '' } },
      { feishu: { state: 'ready', detail: '' }, history: { state: 'ready', detail: '' },
        github: { state: 'ready', detail: '' } })).toEqual({ feishu: 'error', github: 'ready' })
    store.saveSettings({ ...store.settings(), sources: { ...store.settings().sources,
      feishu: { enabled: false, config: {} }, jira: { enabled: true, config: { site: 'acme' } } } })
    expect(Object.fromEntries(sourcesStatus(host, {}, {}).map(source => [source.id, [source.state, source.installed]])))
      .toEqual({ feishu: ['off', true], github: ['starting', true], jira: ['missing', false] })

    // 24 小时统计与最近被过滤的消息。
    store.saveSettings({ ...store.settings(), sources: { ...store.settings().sources,
      feishu: { enabled: true, config: {} }, jira: { enabled: true, config: { site: 'acme' } } } })
    store.triggers.save(message('e1'))
    store.triggers.saveDisposition('e1', { fanout: [], filtered: { code: 'not_a_member' }, at: now })
    const feishu = sourcesStatus(host, {}, {}).find(source => source.id === 'feishu')!
    expect(feishu.stats).toEqual({ received: 1, filtered: 1, lastAt: now })
    expect(feishu.filtered).toEqual([{ id: 'e1', at: now, actor: { source: 'feishu', id: 'ou_alice',
      name: { zh: 'Alice', en: 'Alice' } }, preview: 'message e1', reason: { code: 'not_a_member' } }])
    // 没收到东西的来源给零值。
    expect(sourcesStatus(host, {}, {}).find(source => source.id === 'jira')!.stats).toEqual({ received: 0, filtered: 0,
      lastAt: '' })
  })

  test('droppedReplies 给丢弃的回复补上工单与线程：回答它的 Channel、或 Channel 自己说的线程', () => {
    const host = views()
    const { store } = host
    // 飞书 Channel 说得出自己的群；它回答的消息属于话题根消息的 Thread。
    store.triggers.save({ ...message(feishuTriggerId('om_reply')), threads: [{ source: 'feishu', id: 'oc_1:om_root' }] })
    store.threads.save(thread({ key: 'github:42', ref: { source: 'github', id: '42' } }))
    store.tickets.save(ticket({ id: 't1' }))
    const drop = (id: string, channel: ReturnType<typeof feishuChannel> | ReturnType<typeof githubChannel>, ticketId?: string) => {
      const receipt = { id, channel, text: `text ${id}`, kind: 'reply' as const, ...ticketId ? { ticketId } : {} }
      store.receipts.add(receipt)
      store.receipts.settle(receipt, 'channelGone')
    }
    drop('a', feishuChannel('oc_1', 'om_reply'), 't1')
    drop('b', githubChannel(42))
    drop('c', feishuChannel('oc_2', 'om_gone'))
    const rows = droppedReplies({ store, links })
    expect(Object.fromEntries(rows.map(item => [item.id, [item.thread, item.ticket?.id]]))).toEqual({
      a: ['feishu:oc_1:om_root', 't1'],
      b: ['github:42', undefined],
      c: [undefined, undefined],
    })
    expect(rows.find(item => item.id === 'a')).toMatchObject({ id: 'a', kind: 'reply',
      dropped: { reason: 'channelGone' }, preview: 'text a' })
  })
})

describe('views/settings：设置块、来源表单与执行环境', () => {
  test('settingsView 拼出带修订号的配置块、每个来源的表单/事实/策略与执行环境', () => {
    const host = views()
    const { store, sources } = host
    store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice' }],
      syncChat: 'oc_1' } } },
    sources: { feishu: { enabled: true, config: { cli: 'lark-cli', chats: [{ chatId: 'oc_1', listen: 'all' }] } },
      github: { enabled: true, config: { repository: 'o/r', cli: 'gh' } }, jira: { enabled: true, config: { site: 'acme' } } },
    executor: { directory: '' } }), { block: 'eval', source: 'internal', policyVersion: 'v1', policyChanged: false, notified: [] })
    store.set(KV.sources.labels('feishu'), { 'oc_1': 'Team chat' })
    const view = settingsView(store, sources, {}, {}, '/srv/state')
    expect(view.policyVersion).toBe(policyVersion(store.settings()))
    expect(view.blocks.policy.revision).toBe(0)
    expect(view.blocks.eval.revision).toBe(1)
    expect(view.blocks.executor.value).toEqual(store.settings().executor)

    const feishu = view.sources.find(source => source.id === 'feishu')!
    expect(feishu).toMatchObject({ kind: 'feishu', title: feishuKind.title, installed: true,
      description: feishuKind.description, value: { enabled: true, config: store.settings().sources.feishu!.config },
      restarts: expect.any(Array), fields: feishuKind.fields, labels: { 'oc_1': 'Team chat' } })
    expect(feishu.facts).toEqual({})
    // Feishu 的策略段带行（群 + 其他群 + 私聊）与同步按钮，同步就绪看 syncChat。
    expect(feishu.policy).toMatchObject({ fields: feishuKind.policy!.fields,
      sync: { label: feishuKind.policy!.sync!.label, ready: true } })
    expect((feishu.policy as { rows: { id: string }[] }).rows.map(row => row.id)).toEqual(['oc_1', 'other', 'direct'])
    // 设置里存了、kind 没装的来源原样列出。
    const jira = view.sources.find(source => source.id === 'jira')!
    expect(jira).toMatchObject({ kind: 'jira', installed: false, description: { zh: '', en: '' }, fields: [], facts: {},
      labels: {}, restarts: [] })
    expect('policy' in jira).toBe(false)
    // 执行环境的默认根目录是 stateDir/work，变量按 owner 分组。
    expect(view.environment.root).toBe(join('/srv/state', 'work'))
    expect(view.environment.variables.map(item => item.owner)).toEqual(['executor', 'feishu', 'github'])
    expect(view.environment.variables.find(item => item.owner === 'github')!.enabled).toBe(true)
  })

  test('settingsView 把 setup 问题与部署事实带进对应来源，并给可读的目录', () => {
    const host = views()
    const { store, sources } = host
    const deployment = { stateDir: '/srv/state', promptMaxChars: 100_000, admissionContextMaxPages: 10,
      admissionContextTimeoutMs: 1000, repository: 'o/r', github: { cli: 'gh', login: 'agent', noreply: 'a@b' },
      feishu: { cli: 'lark-cli', appId: 'app', brand: 'feishu' as const, botId: 'bot', name: 'Bot' } }
    const view = settingsView(store, sources, { feishu: { state: 'error', detail: 'x' } },
      { deployment, feishuProblem: { place: 'feishu', code: 'feishuNoBot', values: {}, detail: 'no bot' } }, '/srv/state')
    const feishu = view.sources.find(source => source.id === 'feishu')!
    expect(feishu.problem).toMatchObject({ code: 'feishuNoBot' })
    expect(feishu.facts).toEqual({ cli: { zh: '当前机器人 Bot', en: 'Current bot Bot' } })
    // health 里没有 sync: 条目时同步块仍给 ready（配置里有 syncChat 才 ready）。
    expect(feishu.policy).toMatchObject({ sync: { ready: false, health: undefined } })
    // 配了执行目录时根目录用它。
    store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, directory: '/custom/work' } })
    expect(settingsView(store, sources, {}, {}, '/srv/state').environment.root).toBe('/custom/work')
    // 没有任何部署事实时，每个来源的 facts 是空对象。
    expect(settingsView(store, sources, {}, {}, '/srv/state').sources.map(source => source.facts)).toEqual([{}, {}])
  })
})
