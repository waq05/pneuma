/**
 * `app/resources.ts` 的补盲：`orchestrator_read` 分页资源。
 *
 * 真 `Store`（临时库）+ 真卡片 / 视图投影，宿主端口（命令、模型目录、提示词、会话）用假件；
 * 会话转录走一个只有 `messages` 的假活会话，飞书 / GitHub 原文走假 CLI 返回值。
 *
 * @module dsc/packages/superagent/tests/app-resources
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { readResource, resourceGrammar } from '../app/resources.js'
import type { ResourceHost } from '../app/resources.js'
import { Store } from '../app/store.js'
import { SettingsSchema } from '../core/policy.js'
import { feishuTriggerId } from '../sources/feishu.js'
import { defaultPrompts } from '../app/prompts.js'
import { TextCache } from '../app/cache.js'

const AT = '2026-01-01T00:00:00.000Z'
const TICKET = 'ticket-a'
const WORKER = 'worker-ticket-a'
const originalHome = process.env['DSC_HOME']

type AnyObject = Record<string, unknown>

const ticketOf = (id = TICKET, over: AnyObject = {}): AnyObject => ({
  id, title: 'Fix typo', decisionId: 'decision-1',
  mandate: { strength: 'explicit', policyVersion: 'v', scope: 'Fix typo', basis: { via: 'addressed', source: 'github', addressed: 'mention' },
    actor: { source: 'github', id: 'bob' } },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: AT, updatedAt: AT,
  origin: { triggerId: 'trigger-github', triggerIds: ['trigger-github'] }, ...over,
})
const triggerOf = (id = 'trigger-github', over: AnyObject = {}): AnyObject => ({
  id, source: 'github', threads: [{ source: 'github', id: '1' }], actor: { source: 'github', id: 'bob' },
  human: true, at: AT, text: 'Fix the typo in the header', meta: {}, ...over,
})
const threadOf = (key = 'github:1', over: AnyObject = {}): AnyObject => ({
  key, ref: { source: 'github', id: key.slice('github:'.length) }, createdAt: AT, subscriptions: [], correlated: [], pending: [], meta: {}, ...over,
})
const decisionOf = (id = 'decision-1', over: AnyObject = {}): AnyObject => ({
  id, evalId: 'eval-1', threadKey: 'github:1', triggerIds: ['trigger-github'], policyVersion: 'v', at: AT, kind: 'accept',
  reason: [{ code: 'explicitRouted' }], strength: 'explicit', ticketId: TICKET, ...over,
})

/** 一套真库 + 可配的假宿主；`pages` 用真 `TextCache`。 */
function fixture(options: { live?: boolean; llm?: boolean; mayRead?: boolean; promptsRevision?: number } = {}) {
  const directory = createTempDir('dsc-resources-')
  // 会话日志路径从 DSC_HOME 派生：指到临时目录，读完还原，绝不碰真实的 ~/.dsc。
  process.env['DSC_HOME'] = directory
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto', model: { provider: 'p', model: 'm1' } },
    executor: { model: { provider: 'p', model: 'm2' } } }))
  // `replyStatus` 在触发器的确认状态那一行用；这里让真库之外的假值统一可配。
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'replyStatus') return () => 'acked'
      return Reflect.get(target, property, receiver) as unknown
    },
  }) as unknown as Store
  const config = defaultPrompts()
  const currentPrompt = { revision: options.promptsRevision ?? 2, previousRevision: 1, savedAt: AT, source: 'panel',
    config: { ...config, skills: { mine: 'skill text' }, overrides: { 'runtime/shared': { text: 'team text' }, 'runtime/gone': { text: 'x' } } } }
  const versionOf = (revision: number): unknown => {
    if (revision === 2) return currentPrompt
    if (revision === 1) return { revision: 1, previousRevision: null, savedAt: AT, source: 'panel', config }
    // 未知版本返回 undefined：由资源路由自己拒绝。
    return undefined
  }
  const pages = new TextCache(500_000)
  const llm = { provider: 'p', model: 'm1',
    listModels: () => [{ provider: 'p', providerDisplayName: 'Provider', model: 'm1', value: 'p/m1', description: 'd', contextWindow: 8 },
      { provider: 'q', providerDisplayName: 'Other', model: 'm2', value: 'q/m2', description: 'e', contextWindow: 16 }] }
  const commands = {
    withSignal: () => commands,
    api: async (...args: unknown[]) => (args.some(arg => arg === '--paginate') ? [] : {}),
    pages: async () => [],
    lark: async (args: string[]) => {
      if (args.includes('+messages-mget')) return { messages: [{ message_id: 'om_1', chat_id: 'oc_1', msg_type: 'text',
        sender: { id: 'ou_a', sender_type: 'user' }, create_time: '1700000000000' }] }
      if (args.includes('/open-apis/im/v1/messages/mget')) return { items: [{ message_id: 'om_1', chat_id: 'oc_1' }] }
      return {}
    },
  }
  const liveSession = options.live === false ? undefined : { messages: [
    { role: 'user', content: 'Fix the typo', ts: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'On it.' }], reasoning_content: 'think', ts: 2,
      tool_calls: [{ id: 'call-1', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', content: 'done', ts: 3 },
    { role: 'system', content: 'ignored', ts: 4 },
  ] }
  const host = {
    store: proxy,
    pages,
    prompts: {
      current: () => currentPrompt,
      version: versionOf,
      history: (offset: number, limit: number) => ({ revisions: [currentPrompt, versionOf(1)].slice(offset, offset + limit), next_offset: null }),
      skills: () => [['mine', 'skill text']],
      defaultChanged: () => [{ part: 'runtime/shared' }, { part: 'runtime/gone', removed: true }],
    },
    commands,
    masterId: 'master-session',
    context: {
      get: (name: string) => name === 'agent' ? { sessionById: (id: string) => id === WORKER ? liveSession : undefined }
        : name === 'llm' ? (options.llm === false ? undefined : llm) : undefined,
    },
    promptVersion: () => versionOf(options.promptsRevision ?? 2),
    mayRead: () => options.mayRead ?? true,
    feishuPageSize: () => 20,
    sourceLink: async () => ({ source_url: 'https://example.test/1' }),
    sessions: { status: () => ({ revision: 2, notificationPending: true, sessions: [{ sessionId: 'master-session', revision: 2 }] }),
      modelRetry: () => ({ model_retry: { attempt: 1 } }) },
    settings: { view: () => ({ revision: 3 }), block: (block: string) => ({ block, revision: 4, value: { block } }) },
  }
  const read = (resource: string, offset = 0, limit?: number, ticketId?: string) =>
    readResource(host as unknown as ResourceHost, resource, offset, limit, ticketId)
  return { host, store, read, pages }
}

afterEach(() => {
  if (originalHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = originalHome
})

describe('ticks 清单与语法', () => {
  test('resourceGrammar 按 executor 过滤；主会话清单含只读资源，执行者清单不含', () => {
    expect(resourceGrammar(false)).toContain('tickets: ')
    expect(resourceGrammar(false)).toContain('settings: ')
    expect(resourceGrammar(true)).toContain('ticket/<id>: ')
    expect(resourceGrammar(true)).not.toContain('settings: ')
  })
})

describe('列表类资源', () => {
  test('tickets：分页、模型重试附加与 next_offset；执行者读主会话资源被拒', async () => {
    const f = fixture()
    f.store.tickets.save(ticketOf('ticket-1') as never)
    f.store.tickets.save(ticketOf('ticket-2') as never)
    f.store.tickets.save(ticketOf('ticket-3', { ended: { at: AT, by: 'human', outcome: 'completed' } }) as never)
    const page = await f.read('tickets', 0, 2) as { items: AnyObject[]; next_offset: number | null }
    expect(page.items).toHaveLength(2)
    expect(page.next_offset).toBe(2)
    expect(page.items[0]!.read).toMatch(/^ticket\//)
    // 分页取到底。
    const last = await f.read('tickets', 2, 2) as { items: AnyObject[]; next_offset: number | null }
    expect(last.items).toHaveLength(1)
    expect(last.next_offset).toBeNull()
    await expect(f.read('tickets', 0, undefined, TICKET)).rejects.toThrow('This resource belongs to the main Session')
  })

  test('triggers / threads / decisions：新在前、卡片字段与触发去向', async () => {
    const f = fixture()
    f.store.triggers.save(triggerOf('trigger-1', { at: '2026-01-01T00:00:01.000Z' }) as never)
    f.store.triggers.save(triggerOf('trigger-2', { at: '2026-01-01T00:00:02.000Z' }) as never)
    f.store.triggers.saveDisposition('trigger-2', { fanout: [TICKET], decisionId: 'decision-1' } as never)
    f.store.threads.save(threadOf('github:1', { subscriptions: [TICKET], lastAt: AT }) as never)
    f.store.threads.save(threadOf('github:2', { subscriptions: [], createdAt: '2025-12-31T00:00:00.000Z' }) as never)
    f.store.decisions.save(decisionOf('decision-1') as never)
    const triggers = await f.read('triggers', 0, 10) as { items: AnyObject[] }
    expect(triggers.items.map(item => item['trigger_id'])).toStrictEqual(['trigger-2', 'trigger-1'])
    expect(triggers.items[0]!['disposition']).toStrictEqual({ decision_id: 'decision-1', delivered_to: [TICKET] })
    const threads = await f.read('threads', 0, 10) as { items: AnyObject[] }
    // 只列有订阅的线程（`subscribed` 生成列口径）。
    expect(threads.items.map(item => item['thread'])).toStrictEqual(['github:1'])
    expect(threads.items[0]!['tickets']).toStrictEqual([TICKET])
    const decisions = await f.read('decisions', 0, 10) as { items: AnyObject[] }
    expect(decisions.items[0]).toMatchObject({ decision_id: 'decision-1', kind: 'accept', ticket_id: TICKET })
    // 单张决策带审计。
    f.store.decisions.save(decisionOf('decision-2', { audit: { rule: 'copy' } }) as never)
    expect(await f.read('decision/decision-2')).toMatchObject({ audit: { rule: 'copy' } })
    await expect(f.read('decision/missing')).rejects.toThrow('Unknown decision')
  })

  test('thread/<key>：主会话带工单与最近决策；执行者只读自己订阅或跟随的线程', async () => {
    const f = fixture()
    f.store.threads.save(threadOf('github:1', { subscriptions: [TICKET], pending: ['trigger-github'] }) as never)
    f.store.tickets.save(ticketOf(TICKET) as never)
    f.store.decisions.save(decisionOf('decision-1') as never)
    f.store.triggers.save(triggerOf('trigger-github') as never)
    const main = await f.read('thread/github:1') as AnyObject
    expect(main['tickets']).toHaveLength(1)
    expect(main['decisions']).toHaveLength(1)
    // 执行者：订阅这张工单的线程可读，别的线程不可读。
    expect(((await f.read('thread/github:1', 0, undefined, TICKET)) as AnyObject)['tickets']).toBeUndefined()
    await expect(f.read('thread/github:2', 0, undefined, TICKET)).rejects.toThrow('Unknown or inaccessible thread')
    await expect(f.read('thread/missing')).rejects.toThrow('Unknown or inaccessible thread')
  })
})

describe('设置 / 提示词 / 模型资源', () => {
  test('settings 与 settings/<block> 只有主会话能读', async () => {
    const f = fixture()
    expect(await f.read('settings')).toStrictEqual({ revision: 3 })
    const block = await f.read('settings/policy') as { resource: string; text: string }
    expect(block.resource).toBe('settings/policy')
    expect(JSON.parse(block.text)).toStrictEqual({ block: 'policy', revision: 4, value: { block: 'policy' } })
    await expect(f.read('settings', 0, undefined, TICKET)).rejects.toThrow('This resource belongs to the main Session')
  })

  test('prompts：当前版本、历史、技能分组、默认被改与已移除的段落', async () => {
    const f = fixture()
    const prompts = await f.read('prompts', 0, 10) as AnyObject
    expect(prompts).toMatchObject({ revision: 2, read: 'prompts/2', notification_pending: true,
      default_changed: ['runtime/shared'], removed_parts: ['runtime/gone'] })
    expect(prompts['sessions']).toStrictEqual([{ session_id: 'master-session', revision: 2 }])
    expect(prompts['skills']).toStrictEqual({ built_in: [], team: ['dsh-superagent-mine'] })
    expect((prompts['items'] as AnyObject[])[0]).toMatchObject({ revision: 2, previous_revision: 1 })

    const current = JSON.parse((await f.read('prompts/current', 0, 100_000) as { text: string }).text) as AnyObject
    expect(current['revision']).toBe(2)
    const defaults = JSON.parse((await f.read('prompts/defaults', 0, 100_000) as { text: string }).text) as AnyObject
    expect(defaults['revision']).toBe(0)
    expect(Object.keys(defaults['parts'] as AnyObject).length).toBeGreaterThan(0)
    // 数字版本：0 只在当前就是 0 时取当前，否则按版本号读；执行者要 mayRead 放行。
    const byNumber = JSON.parse((await f.read('prompts/1', 0, 100_000) as { text: string }).text) as AnyObject
    expect(byNumber['revision']).toBe(1)
    await expect(f.read('prompts/99')).rejects.toThrow('Unknown or inaccessible prompt version')
    const refused = fixture({ mayRead: false })
    await expect(refused.read('prompts/current', 0, undefined, TICKET)).rejects.toThrow('Unknown or inaccessible prompt version')
    // 执行者读 defaults 不放开（只有主会话能读内置配置）。
    await expect(f.read('prompts/defaults', 0, undefined, TICKET)).rejects.toThrow('Unknown or inaccessible prompt version')
  })

  test('prompt-preview/<id> 只在本会话刚预览过时读得到', async () => {
    const f = fixture()
    f.pages.set(`master-session:prompt-preview/abc`, '{"preview":true}')
    expect((await f.read('prompt-preview/abc') as { text: string }).text).toBe('{"preview":true}')
    await expect(f.read('prompt-preview/def')).rejects.toThrow('Unknown preview for this Session')
    // 预览资源只对主会话开放。
    await expect(f.read('prompt-preview/abc', 0, undefined, TICKET)).rejects.toThrow('This resource belongs to the main Session')
  })

  test('models 按 provider 分组；models/<provider> 分页；没有 llm 服务时明确报错', async () => {
    const f = fixture()
    expect(await f.read('models')).toStrictEqual({
      default: { provider: 'p', model: 'm1' },
      roles: { orchestrator: { provider: 'p', model: 'm1' }, worker: { provider: 'p', model: 'm2' } },
      failures: [],
      providers: [{ id: 'p', name: 'Provider', count: 1, read: 'models/p' }, { id: 'q', name: 'Other', count: 1, read: 'models/q' }],
    })
    const page = await f.read('models/q') as { items: AnyObject[] }
    expect(page.items[0]).toMatchObject({ id: 'm2', value: 'q/m2', context_window: 16 })
    await expect(f.read('models/nope')).rejects.toThrow('Unknown model provider')
    await expect(fixture({ llm: false }).read('models')).rejects.toThrow('Model catalog unavailable')
    await expect(fixture({ llm: false }).read('models/q')).rejects.toThrow('Model catalog unavailable')
  })
})

describe('来源原文资源', () => {
  test('github/commits/<sha>/checks：成功读一页并缓存，第二页从缓存切', async () => {
    const f = fixture()
    const first = await f.read('github/commits/abcdef1/checks', 0, 5000) as { text: string; next_offset: number | null }
    expect(JSON.parse(first.text)).toStrictEqual({ head: 'abcdef1', checks: [], statuses: [] })
    expect(first.next_offset).toBeNull()
    const cached = await f.read('github/commits/abcdef1/checks', 5, 5) as { text: string }
    expect(cached.text).toBe(first.text.slice(5, 10))
    // 没有缓存过的资源从非 0 偏移读不出东西。
    await expect(f.read('github/commits/zzzzzzz/checks', 3, 5)).rejects.toThrow('Read this GitHub resource from offset 0 first')
  })

  test('feishu/<trigger>/message 读原消息；缺 ref 的触发器明确报错', async () => {
    const f = fixture()
    f.store.triggers.save(triggerOf('trigger-feishu', { id: 'trigger-feishu', source: 'feishu',
      threads: [{ source: 'feishu', id: 'om_1' }], meta: { chatId: 'oc_1', messageId: 'om_1' } }) as never)
    const read = await f.read('feishu/trigger-feishu/message', 0, 5000) as { text: string }
    expect(JSON.parse(read.text)).toMatchObject({ status: 'available',
      message: { id: 'om_1', from: 'ou_a', at: '2023-11-14T22:13:20.000Z', text: '' } })
    f.store.triggers.save(triggerOf('trigger-noref', { source: 'feishu', meta: {} }) as never)
    await expect(f.read('feishu/trigger-noref/message')).rejects.toThrow('A Feishu source trigger is required')
    await expect(f.read('feishu/missing/message')).rejects.toThrow('Unknown trigger')
  })
})

describe('trigger/<id>', () => {
  test('主会话：整段正文、来源链接、回复对象、上下文引用与确认状态', async () => {
    const f = fixture()
    const long = 'x'.repeat(5000)
    f.store.triggers.save(triggerOf('trigger-feishu', { id: 'trigger-feishu', source: 'feishu', text: long,
      threads: [{ source: 'feishu', id: 'om_1' }], meta: { chatId: 'oc_1', messageId: 'om_1', parentId: 'om_0' } }) as never)
    // 回复对象的 id 是 `feishuTriggerId(父消息 id)`，不是随意起的名字。
    f.store.triggers.save(triggerOf(feishuTriggerId('om_0'), { source: 'feishu', threads: [{ source: 'feishu', id: 'om_1' }],
      text: 'parent message', at: '2025-12-31T23:00:00.000Z', meta: { chatId: 'oc_1' } }) as never)
    f.store.threads.save(threadOf('feishu:om_1', { ref: { source: 'feishu', id: 'om_1' } }) as never)
    f.store.triggers.saveDisposition('trigger-feishu', { fanout: [], decisionId: 'decision-1' } as never)
    const trigger = await f.read('trigger/trigger-feishu') as AnyObject
    // 默认一页 4000 字符，长正文分页读。
    expect(String(trigger['text'])).toHaveLength(4000)
    expect(trigger['source_url']).toBe('https://example.test/1')
    expect(trigger['acknowledgement']).toBe('acked')
    expect(trigger['context']).toMatchObject({ skill: 'dsh-superagent-feishu' })
    expect(trigger['replied_to']).toMatchObject({ trigger_id: feishuTriggerId('om_0') })
    // 卡片里的 preview / chars / read 被省掉：这个资源返回全文。
    expect(trigger['preview']).toBeUndefined()
    // 第二页只给正文切片，不再带上文与时序邻居。
    const second = await f.read('trigger/trigger-feishu', 4000, 100) as AnyObject
    expect(second['replied_to']).toBeUndefined()
    expect(String(second['text'])).toHaveLength(100)
    await expect(f.read('trigger/missing')).rejects.toThrow('Unknown trigger')
    await expect(f.read('trigger/a/b')).rejects.toThrow('Unknown context resource')
  })

  test('执行者：不可达的触发器不给读；可达时隐去决策号与别的工单', async () => {
    const f = fixture()
    f.store.tickets.save(ticketOf(TICKET, { origin: { triggerId: 'trigger-github', triggerIds: ['trigger-github'] } }) as never)
    f.store.triggers.save(triggerOf('trigger-github') as never)
    f.store.triggers.save(triggerOf('trigger-other', { threads: [{ source: 'github', id: '2' }] }) as never)
    f.store.triggers.saveDisposition('trigger-github', { fanout: [TICKET, 'ticket-b'], decisionId: 'decision-1' } as never)
    const mine = await f.read('trigger/trigger-github', 0, undefined, TICKET) as AnyObject
    expect(mine['disposition']).toStrictEqual({ delivered_to: [TICKET] })
    expect(mine['decision_id']).toBeUndefined()
    await expect(f.read('trigger/trigger-other', 0, undefined, TICKET)).rejects.toThrow('Trigger does not belong to this worker')
  })
})

describe('ticket/<id> 与各分段', () => {
  test('详情：线程（订阅 + 跟随去重）、批次、最近分配与输入；执行者版隐去决策号', async () => {
    const f = fixture()
    const t = ticketOf(TICKET, {
      origin: { triggerId: 'trigger-github', triggerIds: ['trigger-github', 'trigger-b'] },
      follows: [{ thread: 'github:9', own: true }],
      execution: { name: 'fix-typo', directory: '/work/fix-typo', assignment: 'Do the work' },
      assignments: [
        { id: 'a1', state: 'ended', createdAt: AT, endedReason: 'superseded', report: { state: 'ready', summary: 'Done.', at: AT } },
        { id: 'a2', state: 'running', createdAt: AT },
      ],
      inputs: [
        { id: 'input-trigger', kind: 'trigger', triggerId: 'trigger-b', at: AT },
        { id: 'input-text', kind: 'text', text: 'a short message', at: AT },
        { id: 'input-long', kind: 'text', text: 'y'.repeat(200), at: AT },
      ],
    })
    f.store.tickets.save(t as never)
    f.store.triggers.save(triggerOf('trigger-github') as never)
    f.store.triggers.save(triggerOf('trigger-b', { threads: [{ source: 'github', id: '1' }], at: '2026-01-02T00:00:00.000Z' }) as never)
    f.store.threads.save(threadOf('github:1', { subscriptions: [TICKET] }) as never)
    f.store.threads.save(threadOf('github:9', { subscriptions: [TICKET] }) as never)
    const detail = await f.read(`ticket/${TICKET}`) as AnyObject
    expect(detail).toMatchObject({ ticket_id: TICKET, trigger_id: 'trigger-github', decision_id: 'decision-1', scope: 'Fix typo', requested_by: 'bob' })
    expect(detail['threads']).toStrictEqual([{ thread: 'github:1' }, { thread: 'github:9', bound: true }])
    expect(detail['batch']).toHaveLength(1)
    expect(detail['assignments']).toMatchObject({ items: [{ id: 'a2' }, { id: 'a1' }] })
    expect((detail['inputs'] as { items: AnyObject[] }).items[0]).toMatchObject({ kind: 'text', preview: expect.stringContaining('yyy') })
    const worker = await f.read(`ticket/${TICKET}`, 0, undefined, TICKET) as AnyObject
    expect(worker['decision_id']).toBeUndefined()
    await expect(f.read('ticket/other', 0, undefined, TICKET)).rejects.toThrow('Ticket does not belong to this worker')
    await expect(f.read('ticket/missing')).rejects.toThrow('Unknown ticket')
    await expect(f.read(`ticket/${TICKET}/nope/x`)).rejects.toThrow('Unknown context resource')
  })

  test('assignments / inputs 分页；input 分段按短键或全 id 认回输入', async () => {
    const f = fixture()
    f.store.tickets.save(ticketOf(TICKET, {
      assignments: [{ id: 'a1', state: 'ended', createdAt: AT, report: { state: 'ready', summary: 'Done.', at: AT } }],
      inputs: [
        { id: 'input-trigger', kind: 'trigger', triggerId: 'trigger-b', at: AT },
        { id: 'input-text', kind: 'text', text: 'a short message', at: AT },
        { id: 'input-policy', kind: 'policy-changed', from: 'v1', to: 'v2', at: AT },
        { id: 'input-reopen', kind: 'reopen', decisionId: 'decision-1', at: AT },
        { id: 'input-note', kind: 'note', text: 'from another ticket', at: AT },
        { id: 'input-resumed', kind: 'resumed', triggerId: 'trigger-b', at: AT },
      ],
    }) as never)
    f.store.triggers.save(triggerOf('trigger-b', { threads: [{ source: 'github', id: '1' }] }) as never)
    const assignments = await f.read(`ticket/${TICKET}/assignments`) as AnyObject
    expect((assignments['items'] as AnyObject[])[0]).toMatchObject({ id: 'a1', report: { state: 'ready' } })
    expect(assignments['next_offset']).toBeNull()
    const inputs = await f.read(`ticket/${TICKET}/inputs`) as AnyObject
    expect((inputs['items'] as AnyObject[]).map(item => item['kind'])).toStrictEqual(['resumed', 'note', 'reopen', 'policy-changed', 'text', 'trigger'])
    // 按短键（input id 的 key 形态）与全 id 都能认回。
    const byId = (await f.read(`ticket/${TICKET}/input/input-text`) as { text: string }).text
    expect(byId).toBe('a short message')
    const byTrigger = JSON.parse((await f.read(`ticket/${TICKET}/input/input-trigger`) as { text: string }).text) as AnyObject
    expect(byTrigger).toMatchObject({ trigger_id: 'trigger-b' })
    const note = (await f.read(`ticket/${TICKET}/input/input-note`) as { text: string }).text
    expect(note).toContain('from another ticket')
    const policy = (await f.read(`ticket/${TICKET}/input/input-policy`) as { text: string }).text
    expect(policy).toContain('Policy change')
    const resumed = (await f.read(`ticket/${TICKET}/input/input-resumed`) as { text: string }).text
    expect(resumed).toContain('resumed it')
    // 历史型 reopen 输入没有可渲染的消息。
    await expect(f.read(`ticket/${TICKET}/input/input-reopen`)).rejects.toThrow('Unknown ticket input')
    await expect(f.read(`ticket/${TICKET}/input/missing`)).rejects.toThrow('Unknown ticket input')
  })

  test('assignment / result / report 分段与三种 transcript 读法', async () => {
    const f = fixture()
    f.store.tickets.save(ticketOf(TICKET, {
      execution: { name: 'fix-typo', directory: '/work/fix-typo', assignment: 'Do the work' },
      assignments: [{ id: 'a1', state: 'ended', createdAt: AT, report: { state: 'ready', summary: 'Done.', at: AT } }],
    }) as never)
    expect((await f.read(`ticket/${TICKET}/assignment`) as { text: string }).text).toBe('Do the work')
    expect((await f.read(`ticket/${TICKET}/result`) as { text: string }).text).toBe('Done.')
    expect((await f.read(`ticket/${TICKET}/report/a1`) as { text: string }).text).toBe('Done.')
    await expect(f.read(`ticket/${TICKET}/report/missing`)).rejects.toThrow('Unknown assignment report')
    // 转录：活会话的四条消息里 system 被丢掉，其余三条按 dsh 事件投影。
    const message = JSON.parse((await f.read(`ticket/${TICKET}/message/0`) as { text: string }).text) as AnyObject
    expect(message).toMatchObject({ type: 'user/message', message: { role: 'user', content: [{ type: 'text', text: 'Fix the typo' }] } })
    const assistant = JSON.parse((await f.read(`ticket/${TICKET}/message/1`) as { text: string }).text) as AnyObject
    expect(assistant).toMatchObject({ type: 'assistant/message' })
    expect(JSON.stringify(assistant)).not.toContain('think')
    await expect(f.read(`ticket/${TICKET}/message/3`)).rejects.toThrow('Unknown transcript entry')
    await expect(f.read(`ticket/${TICKET}/message/x`)).rejects.toThrow('Unknown context resource')
    const transcript = (await f.read(`ticket/${TICKET}/transcript`) as { text: string }).text.split('\n')
    expect(transcript).toHaveLength(3)
    expect(JSON.parse(transcript[0]!) as AnyObject).toMatchObject({ type: 'tool/result' })
    // 没有活会话、也没有日志：转录是空表。
    const quiet = fixture({ live: false })
    quiet.store.tickets.save(ticketOf(TICKET) as never)
    expect((await quiet.read(`ticket/${TICKET}/transcript`) as { text: string }).text).toBe('')
    await expect(quiet.read(`ticket/${TICKET}/message/0`)).rejects.toThrow('Unknown transcript entry')
  })
})

describe('旧前缀与未知资源', () => {
  test('event/ task/ observation/ 旧前缀仍可读；未知资源明确报错', async () => {
    const f = fixture()
    f.store.triggers.save(triggerOf('trigger-github') as never)
    f.store.tickets.save(ticketOf(TICKET) as never)
    f.store.decisions.save(decisionOf('decision-1') as never)
    expect(await f.read('event/trigger-github', 0, 10)).toMatchObject({ resource: 'trigger/trigger-github' })
    expect(await f.read('task/ticket-a', 0, 10)).toMatchObject({ ticket_id: TICKET })
    expect(await f.read('observation/decision-1')).toMatchObject({ decision_id: 'decision-1' })
    await expect(f.read('bogus')).rejects.toThrow('Unknown context resource')
    await expect(f.read('ticket/a/b/c/d')).rejects.toThrow('Unknown context resource')
    await expect(f.read(`ticket/${TICKET}/nope`)).rejects.toThrow('Unknown context resource')
  })
})

