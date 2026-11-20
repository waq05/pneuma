/**
 * 覆盖补齐（W12）：`app/links.ts` 的来源消息链接与候选卡片，以及 `app/source-context.ts` 的来源作用域上下文。
 *
 * `sourceLink` 决定候选卡上给模型的是原消息深链还是可读资源路径；`sourceContextOf` 是来源插件唯一能碰状态的门。
 * 两条都只把「进程外」协作方（命令执行器、引擎、发件箱）换成手写假件，判定逻辑本身是真代码。
 *
 * @module @pneuma/superagent/app
 */
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { Candidate, Thread, Ticket, Trigger } from '../core/index.js'
import { SettingsSchema } from '../core/policy.js'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { feishuKind } from '../sources/feishu.js'
import { feishuTriggerId } from '../sources/feishu-trigger.js'
import { readFeishuLink } from '../sources/feishu-read.js'
import { githubKind } from '../sources/github.js'
import { SourceRegistry } from '../sources/registry.js'
import type { SourceContextDeps } from './source-context.js'
import type { Commands } from '../infra/commands.js'
import { TextCache } from './cache.js'
import { Store } from './store.js'
import { candidateCard, repliedTo, sourceLink } from './links.js'
import { sourceContextOf } from './source-context.js'

const at = '2026-01-01T00:00:00.000Z'
const opened: Store[] = []
afterEach(() => {
  for (const store of opened.splice(0)) store.close()
})

function db() {
  const dir = createTempDir('dsc-sa-links-')
  const store = new Store(join(dir, 'orchestrator.sqlite'))
  opened.push(store)
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' },
    policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } } }))
  return store
}
const trigger = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: 'e1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_root' }], actor: { source: 'feishu', id: 'ou_alice' },
  human: true, at, text: 'please fix', meta: {}, ...overrides,
})
const thread = (overrides: Partial<Thread> = {}): Thread => ({
  key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: [],
  correlated: [], pending: [], meta: {}, ...overrides,
})
const mandate = {
  strength: 'explicit' as const, policyVersion: 'v1', basis: { via: 'listed' as const }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '',
}
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 't1', title: 'Fix the copy', decisionId: 'd1', mandate, channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: at, updatedAt: at, origin: { triggerId: 'e1', triggerIds: ['e1'] }, ...overrides,
})

describe('links：来源消息链接与候选卡片', () => {
  /** 链接宿主：真库 + 真注册表 + 可控命令执行器。 */
  function host(lark: (args: string[]) => Promise<unknown> = async () => {
    throw new Error('no link')
  }) {
    const store = db()
    const registry = new SourceRegistry(() => store.settings())
    registry.register(feishuKind)
    registry.register(githubKind)
    const commandsApi = { withSignal: () => commandsApi, lark }
    const commands = commandsApi as unknown as Commands
    const lifetime = new AbortController()
    return { store, sources: registry, commands, links: new TextCache(100_000), lifetime: lifetime.signal, abort: () => lifetime.abort() }
  }

  test('sourceLink：消息自带 URL 直接用；非飞书消息没有链接', async () => {
    const view = host()
    expect(await sourceLink(view as never, trigger({ url: 'https://feishu/message/1' }))).toEqual({
      source_url: 'https://feishu/message/1' })
    expect(await sourceLink(view as never, trigger({ source: 'github', meta: {} }))).toEqual({})
    // 飞书消息但 meta 里没有 chatId/messageId 也没有链接。
    expect(await sourceLink(view as never, trigger({ meta: { chatId: 'oc_1' } }))).toEqual({})
  })

  test('sourceLink：查到的链接写入缓存，第二次不再请求命令执行器', async () => {
    let calls = 0
    const view = host(async () => {
      calls += 1
      return { messages: [{ message_id: 'om_1', chat_id: 'oc_1', message_app_link: 'https://feishu/app/1' }] }
    })
    const item = trigger({ meta: { chatId: 'oc_1', messageId: 'om_1' } })
    // 先单独确认命令返回值本身能被解析成链接（这一步也走命令执行器）。
    expect(await readFeishuLink(view.commands, { triggerId: 'e1', chatId: 'oc_1', messageId: 'om_1' })).toBe('https://feishu/app/1')
    calls = 0
    expect(await sourceLink(view as never, item)).toEqual({ source_url: 'https://feishu/app/1' })
    expect(view.links.get('oc_1:om_1')).toBe('https://feishu/app/1')
    expect(await sourceLink(view as never, item)).toEqual({ source_url: 'https://feishu/app/1' })
    expect(calls).toBe(1)
  })

  test('sourceLink：查不到时退回可读资源路径；宿主已停止时把停止原因抛出来', async () => {
    const view = host()
    const item = trigger({ meta: { chatId: 'oc_1', messageId: 'om_1' } })
    expect(await sourceLink(view as never, item)).toEqual({ source_url_read: 'feishu/e1/message' })
    // 外部 signal 已取消时同样暴露取消，而不是当成「链接不可用」。
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(sourceLink(view as never, item, cancelled.signal)).rejects.toThrow()
    const stopped = host()
    stopped.abort()
    await expect(sourceLink(stopped as never, item)).rejects.toThrow()
  })

  test('repliedTo：来源说得清回复关系时回查原消息，说不清就没有', () => {
    const view = host()
    view.store.triggers.save(trigger({ id: feishuTriggerId('om_parent'), meta: { parentId: 'om_parent' } }))
    expect(repliedTo(view as never, trigger({ meta: { parentId: 'om_parent' } }))?.id).toBe(feishuTriggerId('om_parent'))
    expect(repliedTo(view as never, trigger({ source: 'github', meta: {} }))).toBeUndefined()
    // 回复关系存在、原消息不在库里时也是 undefined。
    expect(repliedTo(view as never, trigger({ meta: { parentId: 'om_gone' } }))).toBeUndefined()
  })

  test('candidateCard：显式候选给「照 dispatch 路由」，推断候选给评估指引', async () => {
    const view = host()
    const primary = trigger()
    view.store.triggers.save(primary)
    const explicit = await candidateCard(view as never, { evalId: 'ev', thread: thread(), triggers: [primary],
      strength: 'explicit', policyVersion: 'v1', tickets: [] } as Candidate)
    expect(explicit).toMatchObject({ trigger_id: 'e1', from: 'ou_alice', thread: 'feishu:oc_1:om_root',
      strength: 'explicit', mode: 'auto', related_tickets: [], tickets_total: 0,
      next_action: 'Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore.' })
    expect('batch' in explicit).toBe(false)
    expect('delivered_to' in explicit).toBe(false)

    const inferred = await candidateCard(view as never, { evalId: 'ev', thread: thread(), triggers: [primary],
      strength: 'inferred', policyVersion: 'v1', tickets: [] } as Candidate)
    expect(String(inferred.next_action)).toContain('assess it with orchestrator_eval')
  })

  test('candidateCard：批量里的其它消息进 batch，送达与交回历史都带上，相关工单按引用找', async () => {
    const view = host()
    const primary = trigger({ id: 'e1', text: 'see #12' })
    const second = trigger({ id: 'e2', text: 'second message' })
    view.store.triggers.save(primary)
    view.store.triggers.save(second)
    view.store.threads.save(thread({ key: 'github:12', ref: { source: 'github', id: '12' }, subscriptions: ['t1'] }))
    view.store.tickets.save(ticket({ title: 'Referenced work' }))
    view.store.triggers.saveDisposition('e1', { fanout: ['t1'], handbacks: [{ ticketId: 't1', reason: 'beyond scope', at }], at })
    const card = await candidateCard(view as never, { evalId: 'ev', thread: thread(), triggers: [second, primary],
      strength: 'inferred', policyVersion: 'v1', tickets: [] } as Candidate)
    expect(card.batch).toEqual([expect.objectContaining({ trigger_id: 'e2', source: 'feishu', actor: 'ou_alice',
      at, preview: 'second message', read: 'trigger/e2' })])
    expect(card.delivered_to).toEqual(['t1'])
    expect(card.handed_back).toEqual([{ trigger_id: 'e1', ticket_id: 't1', reason: 'beyond scope' }])
    // 正文里的 #12 指向订阅了 t1 的 GitHub 线程，于是把 t1 列为相关工单。
    expect(card.referenced_tickets).toEqual([expect.objectContaining({ ticket_id: 't1', title: 'Referenced work' })])
    // 回复关系也会渲染进卡片正文。
    view.store.triggers.save(trigger({ id: feishuTriggerId('om_parent'), text: 'parent message', meta: { parentId: 'om_parent' } }))
    const replyTrigger = trigger({ id: 'e3', meta: { chatId: 'oc_1', messageId: 'om_3', parentId: 'om_parent' } })
    const withReply = await candidateCard(view as never, { evalId: 'ev', thread: thread(), triggers: [replyTrigger],
      strength: 'inferred', policyVersion: 'v1', tickets: [] } as Candidate)
    expect(withReply.replies_to).toMatchObject({ trigger_id: feishuTriggerId('om_parent'), preview: 'parent message' })
  })
})

// 延迟解析 SourceRegistry，避免在文件顶部引入未使用的符号。

describe('source-context：来源能看到的全部状态入口', () => {
  /** 手写依赖：所有调用都记进 `calls`，读状态走内存 Map。 */
  function deps(options: { configured?: boolean } = {}) {
    const state = new Map<string, unknown>()
    const calls: [string, unknown[]][] = []
    const record = (name: string) => (...args: unknown[]) => { calls.push([name, args]); return undefined }
    const health = new Map<string, { get(): unknown; set(value: unknown): void }>()
    const settings = new Map<string, { state?: unknown }>()
    const store = {
      atomic: <T>(work: () => T) => { calls.push(['atomic', []]); return work() },
      get: (name: string) => { calls.push(['get', [name]]); return state.get(name) },
      set: (name: string, value: unknown) => { calls.push(['set', [name, value]]); state.set(name, value) },
      delete: (name: string) => { calls.push(['delete', [name]]); state.delete(name) },
      keys: (family: string | { prefix: string }) => {
        const prefix = typeof family === 'string' ? family : (family as { prefix: string }).prefix
        calls.push(['keys', [prefix]])
        return [...state.keys()].filter(key => key.startsWith(prefix))
      },
      threads: {
        get: (key: string) => { calls.push(['threads.get', [key]]); return { key } },
        describe: record('threads.describe'), patchMeta: record('threads.patchMeta'),
      },
      tickets: { get: record('tickets.get'), open: () => { calls.push(['tickets.open', []]); return [] } },
      read: {
        subscribedThreads: (source?: string) => { calls.push(['read.subscribedThreads', [source]]); return [] },
        threadTriggers: (key: string, limit: number) => { calls.push(['read.threadTriggers', [key, limit]]); return [{ id: 'latest' }] },
      },
      triggers: { get: record('triggers.get') },
    }
    const engine = { bindThread: record('engine.bindThread'), threadClosed: record('engine.threadClosed') }
    const outbox = { send: record('outbox.send') }
    const sources = { healthEntries: (names: readonly string[]) => new Map(names.map(name => [name, health.get(name)!])) }
    const commands = {}
    const setupProblem = { place: 'feishu' as const, code: 'feishuNoApp' as const, values: {}, detail: 'no app' }
    const feishuProblem = { place: 'feishu' as const, code: 'feishuNoBot' as const, values: {}, detail: 'no bot' }
    const deployment = { stateDir: '/srv/state', repository: 'o/r', github: { cli: 'gh', login: 'a', noreply: 'a@b' } }
    let received = 0
    const value: SourceContextDeps = {
      store: store as never, outbox: outbox as never, engine: engine as never, commands: commands as never,
      sources: sources as never, deployment: deployment as never, ready: Promise.resolve(),
      configured: () => options.configured ?? true, setupProblem, feishuProblem,
      receive: () => { received += 1; return 'stored' },
    }
    return { deps: value, calls, state, health, received: () => received, setupProblem, feishuProblem }
  }
  function entry() {
    const written: unknown[] = []
    return { get: () => undefined, set: (value: unknown) => { written.push(value) }, release: () => {}, written }
  }

  test('deployment 与 problem 按来源 kind 取；ready/configured 原样透传', async () => {
    const harness = deps()
    const context = sourceContextOf(harness.deps, feishuKind)
    expect(context.deployment).toMatchObject({ repository: 'o/r' })
    expect(context.problem).toMatchObject({ code: 'feishuNoBot' })
    expect(context.configured()).toBe(true)
    await expect(context.ready).resolves.toBeUndefined()
    // 没有匹配 place 的问题就没有 problem。
    expect(sourceContextOf(harness.deps, githubKind).problem).toBeUndefined()
  })

  test('state 读写：set 传 undefined 等于删除；keys 按前缀列', () => {
    const harness = deps()
    const context = sourceContextOf(harness.deps, feishuKind)
    context.state.set('cursor', 'c1')
    expect(context.state.get('cursor')).toBe('c1')
    context.state.set('cursor', undefined)
    expect(harness.calls.some(([name]) => name === 'delete')).toBe(true)
    harness.state.set('other', 1)
    const prefix = (name: string) => Object.assign((part: string) => `${name}:${part}`, { prefix: name })
    expect(context.state.keys(prefix('cur') as never)).toEqual([])
    expect(context.state.keys(prefix('oth') as never)).toEqual(['other'])
    expect(context.atomic(() => 42)).toBe(42)
  })

  test('threads / tickets / triggers 的读写都走注入的依赖与引擎', () => {
    const harness = deps()
    const context = sourceContextOf(harness.deps, feishuKind)
    expect(context.threads.get('feishu:oc_1:om_root')).toEqual({ key: 'feishu:oc_1:om_root' })
    context.threads.subscribed('feishu')
    context.threads.describe('feishu:oc_1:om_root', { label: 'L' })
    context.threads.patch('feishu:oc_1:om_root', { x: 1 })
    context.tickets.get('t1')
    context.tickets.open()
    context.tickets.bindThread('t1', { source: 'feishu', id: 'oc_1:om_root' }, true)
    context.tickets.threadClosed({ source: 'feishu', id: 'oc_1:om_root' }, 'merged', at)
    context.triggers.get('e1')
    expect(context.triggers.latest('feishu:oc_1:om_root')).toEqual({ id: 'latest' })
    expect(harness.calls.map(([name]) => name)).toEqual(expect.arrayContaining(['read.subscribedThreads',
      'threads.describe', 'threads.patchMeta', 'tickets.get', 'tickets.open', 'engine.bindThread',
      'engine.threadClosed', 'triggers.get', 'read.threadTriggers']))

    // receive 交给宿主处理，notify 交给发件箱。
    expect(context.receive(trigger())).toBe('stored')
    expect(harness.received()).toBe(1)
    context.notify({ id: 'm1' } as never)
    expect(harness.calls.find(([name]) => name === 'outbox.send')?.[1]).toEqual([{ id: 'm1' }])
  })

  test('config：启用的来源给配置，停用的给 undefined', () => {
    const harness = deps()
    ;(harness.deps as { sources: unknown }).sources = { ...harness.deps.sources, instance: ((id: string) =>
      id === 'feishu' ? { id, kind: 'feishu', enabled: true, config: { cli: 'lark-cli' } }
        : id === 'off' ? { id, kind: 'off', enabled: false, config: {} } : undefined) } as never
    const context = sourceContextOf(harness.deps, feishuKind)
    expect(context.config('feishu')).toEqual({ cli: 'lark-cli' })
    expect(context.config('off')).toBeUndefined()
    expect(context.config('missing')).toBeUndefined()
  })

  test('report 只写本来源声明过的体检格，写别的一律拒绝', () => {
    const harness = deps()
    const health = entry()
    harness.health.set('feishu', health)
    const context = sourceContextOf(harness.deps, feishuKind)
    const value = { state: 'ready' as const, detail: 'ok' }
    context.report('feishu', value)
    expect(health.written).toEqual([value])
    expect(() => context.report('not-mine', value)).toThrow('The feishu Source has no health entry not-mine')
  })
})
