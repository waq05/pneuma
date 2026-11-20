/**
 * 飞书来源后台循环（`sources/feishu-loops.ts`）的测试：历史补收、群名刷新、订阅线程轮询，
 * 以及从 `startFeishu` 起的三条循环（事件长连接 / 补收 / 群名）在「配置在但没消息」时的行为。
 *
 * 为什么值得钉：这一层是飞书来源里最容易「悄悄漏消息」的地方——补收游标推进早了丢历史、
 * 分页不前进就死循环、首次轮询把历史上下文当新消息灌进评估。所以每条都用「收了几条 Trigger、
 * 游标与 topics 变成什么」断言。
 *
 * 假的只有 `Commands`（按 lark-cli 的参数分派）与 `SourceContext`（内存 state、记录 receive /
 * report / patch）；`backfillChat` / `pollThreads` / `refreshChatNames` / `consumerRetry` 与
 * zod schema 全是源码。不起真 lark-cli、不联网、不碰 `~/.dsc`。
 *
 * @module @pneuma/superagent/tests/sources-feishu-loops
 */
import { describe, expect, it } from 'vitest'
import type { Commands } from '../infra/commands.js'
import type { Thread, Trigger } from '../core/index.js'
import { KV } from '../kv.js'
import type { SourceContext, SourceHost } from '../sources/host.js'
import {
  backfillChat,
  consumerRetry,
  pollThreads,
  refreshChatNames,
  threadRef,
} from '../sources/feishu-loops.js'
import { startFeishu } from '../sources/feishu.js'

// ── 假件 ────────────────────────────────────────────────────────────────────

const bot = { cli: 'lark-cli', appId: 'cli_app', brand: 'feishu' as const, botId: 'ou_bot', name: 'Bot' }
const deployment = {
  repository: 'acme/widgets', github: { cli: 'gh', login: 'agent', noreply: 'x' },
  feishu: bot, stateDir: '/tmp/state', promptMaxChars: 1, admissionContextMaxPages: 1, admissionContextTimeoutMs: 1,
}

/** 一条历史 API 消息；`parseable: false` 时故意缺字段，用来测「单条不可读只跳过」。 */
const historical = (over: Record<string, unknown> = {}) => ({
  message_id: 'om_1', chat_id: 'oc_a', create_time: '1757000000000', root_id: 'om_root', thread_id: 'omt_1',
  sender: { id: 'ou_carol', sender_type: 'user' },
  body: { content: JSON.stringify({ text: 'hello' }) },
  ...over,
})

/** 一条话题页消息（`im +threads-messages-list` 的形状）。 */
const topicMessage = (over: Record<string, unknown> = {}) => ({
  message_id: 'om_2', chat_id: 'oc_a', content: 'reply', msg_type: 'text', create_time: '1757000000000',
  sender: { id: 'ou_carol', name: 'Carol', sender_type: 'user' }, thread_id: 'omt_1',
  ...over,
})

interface ContextOptions {
  config?: unknown
  lark: (args: string[]) => unknown
  state?: Map<string, unknown>
  threads?: Thread[]
  triggers?: Record<string, Trigger>
  feishu?: Record<string, unknown> | undefined
}

function fakeContext(options: ContextOptions) {
  const state = options.state ?? new Map<string, unknown>()
  const larkCalls: string[][] = []
  const received: Trigger[] = []
  const reports: { entry: string; health: unknown }[] = []
  const patches: unknown[][] = []
  const described: unknown[][] = []
  const commands = {
    deployment,
    withSignal: () => commands,
    lark: async (args: string[]) => { larkCalls.push(args); return options.lark(args) },
  } as unknown as Commands
  const context = {
    deployment: { ...deployment, feishu: options.feishu === undefined ? bot : options.feishu },
    commands,
    ready: Promise.resolve(),
    configured: () => true,
    problem: undefined,
    config: () => options.config,
    receive: async (trigger: Trigger) => { received.push(trigger); return {} as never },
    atomic: <T>(work: () => T) => work(),
    state: {
      get: (key: string) => state.get(key),
      set: (key: string, value: unknown) => { value === undefined ? state.delete(key) : state.set(key, value) },
      keys: () => [...state.keys()],
    },
    threads: {
      get: (key: string) => (options.threads ?? []).find(thread => thread.key === key),
      subscribed: () => options.threads ?? [],
      describe: (...args: unknown[]) => described.push(args),
      patch: (...args: unknown[]) => patches.push(args),
    },
    tickets: {
      get: () => undefined,
      open: () => [],
      bindThread: () => {},
      threadClosed: () => {},
    },
    triggers: { get: (id: string) => options.triggers?.[id], latest: (key: string) => options.triggers?.[key] },
    notify: () => {},
    report: (entry: string, health: unknown) => reports.push({ entry, health }),
  }
  return { context: context as unknown as SourceContext, received, reports, patches, described, larkCalls, state }
}

const threadOf = (over: Partial<Thread> = {}): Thread => ({
  key: 'feishu:oc_a:om_root', ref: { source: 'feishu', id: 'oc_a:om_root' }, createdAt: '2025-01-01T00:00:00.000Z',
  lastAt: new Date().toISOString(), subscriptions: [], correlated: [], pending: [], meta: {}, ...over,
})

// ── 纯函数 ──────────────────────────────────────────────────────────────────

describe('consumerRetry', () => {
  it('首次 1 秒；撑过一分钟仍是 1 秒；否则翻倍封顶 60 秒', () => {
    expect(consumerRetry(undefined, 100)).toBe(1000)
    expect(consumerRetry(1000, 60_000)).toBe(1000)
    expect(consumerRetry(1000, 59_999)).toBe(2000)
    expect(consumerRetry(30_000, 10)).toBe(60_000)
    expect(consumerRetry(60_000, 10)).toBe(60_000)
  })
})

// ── 群名刷新 ────────────────────────────────────────────────────────────────

describe('refreshChatNames', () => {
  it('把 chat_id → 群名 存进来源标签，没名字的群不记', async () => {
    const context = fakeContext({
      lark: (args) => {
        expect(args).toEqual(['im', '+chat-list', '--page-all', '--page-size', '100'])
        return { chats: [{ chat_id: 'oc_a', name: 'Team' }, { chat_id: 'oc_b', name: null }, { chat_id: 'oc_c' }] }
      },
    })
    await expect(refreshChatNames(context.context)).resolves.toEqual({ oc_a: 'Team' })
    expect(context.state.get(KV.sources.labels('feishu'))).toEqual({ oc_a: 'Team' })
  })
})

// ── 历史补收 ────────────────────────────────────────────────────────────────

describe('backfillChat', () => {
  it('补收聊天页与话题页，把历史消息灌成 Trigger 并记下活跃话题', async () => {
    const context = fakeContext({
      config: { chats: [], directMessages: true },
      lark: (args) => {
        if (args[0] === 'api') {
          const parameters = JSON.parse(args[4]!) as { container_id_type: string; container_id: string }
          const items = parameters.container_id_type === 'chat'
            ? [historical({ create_time: String(Date.now()) }), historical({ message_id: 'om_2', create_time: String(Date.now()), sender: { id: 'ou_bob', sender_type: 'user' } })]
            : [historical({ message_id: 'om_3', create_time: String(Date.now()), thread_id: 'omt_1' })]
          return { items, has_more: false }
        }
        throw new Error(`意外的 lark 调用：${args.join(' ')}`)
      },
    })
    const until = new Date().toISOString()
    await backfillChat(context.context, 'oc_a', false, '2026-09-01T00:00:00.000Z', until, new AbortController().signal)
    expect(context.received.map(trigger => trigger.meta.messageId)).toEqual(['om_1', 'om_2', 'om_3'])
    expect(context.received[0]).toMatchObject({ source: 'feishu', text: 'hello', meta: { chatId: 'oc_a', threadId: 'omt_1' } })
    expect(context.state.get(KV.feishu.topics('oc_a')), '话题记到最后一条消息时间').toMatchObject({ omt_1: expect.any(String) })
    const latest = context.larkCalls.at(-1)!
    expect(latest.slice(0, 3)).toEqual(['api', 'GET', '/open-apis/im/v1/messages'])
    expect(JSON.parse(latest[4]!)).toMatchObject({ container_id_type: 'thread', container_id: 'omt_1', sort_type: 'ByCreateTimeAsc' })
  })

  it('跳过已删除消息，单条不可读只计入 skipped', async () => {
    const context = fakeContext({
      config: { chats: [], directMessages: true },
      lark: (args) => {
        if (args[0] !== 'api') throw new Error('不该有这个 lark 调用')
        if (JSON.parse(args[4]!).container_id_type === 'thread') return { items: [], has_more: false }
        return {
          items: [historical({ deleted: true })],
          has_more: false,
        }
      },
    })
    const tally = { skipped: 0 }
    const state = context.state
    state.set(KV.feishu.topics('oc_a'), {})
    await backfillChat(context.context, 'oc_a', false, '2026-09-01T00:00:00.000Z', '2026-09-11T00:00:00.000Z', new AbortController().signal, tally)
    expect(context.received, '删除的消息不灌').toHaveLength(0)
    expect(tally.skipped).toBe(0)
  })

  it('补收后把超出 horizon 且没被订阅的话题删掉，被订阅的保留', async () => {
    const old = '2026-01-01T00:00:00.000Z'
    const state = new Map<string, unknown>()
    state.set(KV.feishu.topics('oc_a'), { omt_old: old, omt_keep: old })
    const subscribed = threadOf({
      key: 'feishu:oc_a:om_keep', ref: { source: 'feishu', id: 'oc_a:om_keep' },
      meta: { threadId: 'omt_keep' }, lastAt: new Date().toISOString(),
    })
    const context = fakeContext({
      config: { chats: [], directMessages: true },
      state,
      threads: [subscribed],
      lark: (args) => {
        if (args[0] !== 'api') throw new Error('不该有这个 lark 调用')
        return { items: [], has_more: false }
      },
    })
    await backfillChat(context.context, 'oc_a', false, '2026-09-01T00:00:00.000Z', new Date().toISOString(), new AbortController().signal)
    expect(context.state.get(KV.feishu.topics('oc_a'))).toEqual({ omt_keep: old })
  })

  it('分页不前进时抛错；返回别的群的消息时抛错；中止信号立刻抛', async () => {
    const stuck = fakeContext({
      lark: (args) => args[0] === 'api' ? { items: [], has_more: true, page_token: 'same' } : undefined,
    })
    await expect(backfillChat(stuck.context, 'oc_a', false, '2026-09-01T00:00:00.000Z', '2026-09-11T00:00:00.000Z', new AbortController().signal))
      .rejects.toThrow(/pagination did not advance/)

    const outside = fakeContext({
      lark: (args) => args[0] === 'api' ? { items: [historical({ chat_id: 'oc_other' })], has_more: false } : undefined,
    })
    await expect(backfillChat(outside.context, 'oc_a', false, '2026-09-01T00:00:00.000Z', '2026-09-11T00:00:00.000Z', new AbortController().signal))
      .rejects.toThrow(/outside the requested chat or thread/)

    const controller = new AbortController()
    controller.abort()
    const aborted = fakeContext({ lark: () => { throw new Error('不该发请求') } })
    await expect(backfillChat(aborted.context, 'oc_a', false, '2026-09-01T00:00:00.000Z', '2026-09-11T00:00:00.000Z', controller.signal))
      .rejects.toBeDefined()
  })
})

// ── 订阅线程轮询 ────────────────────────────────────────────────────────────

describe('threadRef', () => {
  it('优先用线程 meta 里的来源消息，其次回落到最新 Trigger', () => {
    const context = fakeContext({ lark: () => ({}) })
    expect(threadRef(context.context, threadOf({ meta: { chatId: 'oc_a', messageId: 'om_1', sourceTriggerId: 'trig-1' } })))
      .toEqual({ triggerId: 'trig-1', chatId: 'oc_a', messageId: 'om_1' })
    const fallback = fakeContext({
      lark: () => ({}),
      triggers: { 'feishu:oc_a:om_root': { id: 'trig-9', source: 'feishu', meta: { chatId: 'oc_a', messageId: 'om_9' }, at: '2026-09-09T00:00:00.000Z' } as unknown as Trigger },
    })
    expect(threadRef(fallback.context, threadOf())).toEqual({ triggerId: 'trig-9', chatId: 'oc_a', messageId: 'om_9', at: '2026-09-09T00:00:00.000Z' })
    expect(threadRef(context.context, threadOf({ meta: {} })), '没有来源消息时不猜').toBeUndefined()
  })
})

describe('pollThreads（飞书）', () => {
  /** 一条完整的 lark 分派：mget 取来源，root/parent 取单条，thread 取话题页。 */
  const larkOf = (options: {
    threadId?: string | undefined
    pages?: Record<string, unknown>[]
    root?: Record<string, unknown> | undefined
    parent?: Record<string, unknown> | undefined
  } = {}) => (args: string[]): unknown => {
    if (args[0] === 'api' && args[2] === '/open-apis/im/v1/messages/mget') {
      return { items: [{ message_id: 'om_1', chat_id: 'oc_a', root_id: options.root ? 'om_root' : undefined, parent_id: options.parent ? 'om_parent' : undefined, thread_id: options.threadId }] }
    }
    if (args[0] === 'im' && args[1] === '+messages-mget') {
      const target = args[args.indexOf('--message-ids') + 1]
      const message = target === 'om_root' ? options.root : options.parent
      return { messages: message ? [message] : [] }
    }
    if (args[0] === 'im' && args[1] === '+threads-messages-list') {
      const pages = options.pages ?? [{ thread_id: options.threadId, has_more: false, messages: [] }]
      return pages.shift() ?? { thread_id: options.threadId, has_more: false, messages: [] }
    }
    throw new Error(`意外的 lark 调用：${args.join(' ')}`)
  }
  const refMeta = { sourceTriggerId: 'trig-1', chatId: 'oc_a', messageId: 'om_1' }

  it('首次轮询先记下根/父消息，再把新回复灌成 Trigger，并标记已初始化', async () => {
    const message = topicMessage({ message_id: 'om_2', thread_id: 'omt_1' })
    const context = fakeContext({
      config: { chats: [], directMessages: true, readPageSize: 20 },
      threads: [threadOf({ meta: refMeta })],
      lark: larkOf({
        threadId: 'omt_1',
        pages: [{ thread_id: 'omt_1', has_more: false, messages: [message] }],
        root: { message_id: 'om_root', chat_id: 'oc_a', msg_type: 'text', sender: { id: 'ou_carol', sender_type: 'user' }, create_time: '1757000000000' },
        parent: { message_id: 'om_parent', chat_id: 'oc_a', msg_type: 'text', sender: { id: 'ou_carol', sender_type: 'user' }, create_time: '1757000000000' },
      }),
    })
    context.state.set(KV.feishu.chats, { oc_a: false })
    const tally = { skipped: 0 }
    await pollThreads(context.context, new AbortController().signal, tally)
    expect(context.received).toHaveLength(1)
    expect(context.received[0]).toMatchObject({ source: 'feishu', text: 'reply', meta: { chatId: 'oc_a', threadId: 'omt_1' } })
    expect(context.state.get(KV.feishu.initialized('feishu:oc_a:om_root'))).toBe(true)
    const seen = context.state.get(KV.feishu.seen('feishu:oc_a:om_root')) as string[]
    expect(seen, '根/父/新消息都记已读').toEqual(expect.arrayContaining(['om_root', 'om_parent', 'om_2']))
  })

  it('已初始化时遇到已读消息就停，不再翻下一页', async () => {
    const context = fakeContext({
      config: { chats: [], directMessages: true, readPageSize: 20 },
      threads: [threadOf({ meta: refMeta })],
      lark: larkOf({
        threadId: 'omt_1',
        pages: [{ thread_id: 'omt_1', has_more: true, page_token: 'p2', messages: [topicMessage({ message_id: 'om_2' }), topicMessage({ message_id: 'om_1' })] }],
      }),
    })
    context.state.set(KV.feishu.initialized('feishu:oc_a:om_root'), true)
    context.state.set(KV.feishu.seen('feishu:oc_a:om_root'), ['om_1'])
    await pollThreads(context.context, new AbortController().signal)
    expect(context.received).toHaveLength(1)
    expect(context.larkCalls.some(args => args.includes('--page-token')), '遇到已读就不再翻页').toBe(false)
  })

  it('话题 id 变了就 patch 线程，并能接着翻下一页', async () => {
    const context = fakeContext({
      config: { chats: [], directMessages: true, readPageSize: 20 },
      threads: [threadOf({ meta: refMeta })],
      lark: larkOf({
        threadId: 'omt_1',
        pages: [
          { thread_id: 'omt_1', has_more: true, page_token: 'p2', messages: [topicMessage({ message_id: 'om_2' })] },
          { thread_id: 'omt_1', has_more: false, messages: [topicMessage({ message_id: 'om_3' })] },
        ],
      }),
    })
    context.state.set(KV.feishu.initialized('feishu:oc_a:om_root'), true)
    context.state.set(KV.feishu.seen('feishu:oc_a:om_root'), ['om_1'])
    await pollThreads(context.context, new AbortController().signal)
    expect(context.patches).toContainEqual(['feishu:oc_a:om_root', { threadId: 'omt_1' }])
    expect(context.received.map(trigger => trigger.meta.messageId)).toEqual(['om_2', 'om_3'])
    expect(context.larkCalls.filter(args => args.includes('--page-token')).length).toBe(1)
  })

  it('来源被关时不轮询；线程没有来源消息时记 pollError', async () => {
    const off = fakeContext({ config: undefined, lark: () => ({}), threads: [threadOf({ meta: refMeta })] })
    off.state.set(KV.feishu.initialized('feishu:oc_a:om_root'), true)
    await pollThreads(off.context, new AbortController().signal)
    expect(off.larkCalls).toHaveLength(0)

    const orphan = fakeContext({
      config: { chats: [], directMessages: true, readPageSize: 20 },
      lark: () => ({}),
      threads: [threadOf({ meta: {} })],
    })
    await pollThreads(orphan.context, new AbortController().signal)
    expect(orphan.patches).toContainEqual(['feishu:oc_a:om_root', { pollError: 'Error: Subscribed thread has no retained source message' }])
  })

  it('私聊线程的回复带上 direct 事实', async () => {
    const context = fakeContext({
      config: { chats: [], directMessages: true, readPageSize: 20 },
      lark: larkOf({
        threadId: 'omt_1',
        pages: [{ thread_id: 'omt_1', has_more: false, messages: [topicMessage({ message_id: 'om_2' })] }],
      }),
      threads: [threadOf({ meta: refMeta })],
    })
    context.state.set(KV.feishu.chats, { oc_a: true })
    context.state.set(KV.feishu.initialized('feishu:oc_a:om_root'), true)
    context.state.set(KV.feishu.seen('feishu:oc_a:om_root'), ['om_1'])
    await pollThreads(context.context, new AbortController().signal)
    expect(context.received).toHaveLength(1)
    expect(context.received[0]!.channel!.address.direct).toBe('true')
  })
})

// ── 三条循环的空转行为 ──────────────────────────────────────────────────────

describe('runFeishu 循环', () => {
  it('配置在但没消息时，补收循环跑完一轮并报 ready，中止后退出', async () => {
    const state = new Map<string, unknown>()
    state.set(KV.feishu.history('oc_a'), '2026-09-01T00:00:00.000Z')
    const larkCalls: string[][] = []
    const reports: { entry: string; health: unknown }[] = []
    const unregister = (): void => {}
    const context = {
      deployment: { ...deployment, feishu: { ...bot, cli: '/nonexistent-lark-cli-for-test' } },
      commands: {
        withSignal: () => ({
          lark: async (args: string[]) => { larkCalls.push(args); return { items: [], has_more: false } },
        }),
      },
      ready: Promise.resolve(),
      configured: () => true,
      problem: undefined,
      config: () => ({ chats: [{ chatId: 'oc_a', listen: 'all' }], directMessages: true, readPageSize: 20 }),
      state: {
        get: (key: string) => state.get(key),
        set: (key: string, value: unknown) => { state.set(key, value) },
        keys: () => [...state.keys()],
      },
      threads: { get: () => undefined, subscribed: () => [], describe: () => {}, patch: () => {} },
      tickets: { get: () => undefined, open: () => [], bindThread: () => {}, threadClosed: () => {} },
      triggers: { get: () => undefined, latest: () => undefined },
      receive: async () => ({}),
      notify: () => {},
      report: (entry: string, health: unknown) => reports.push({ entry, health }),
    }
    const host = { sources: { register: () => unregister }, context: () => context } as unknown as SourceHost
    const controller = new AbortController()
    startFeishu(host, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 30))
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(larkCalls.length, '补收至少读了一次历史').toBeGreaterThan(0)
    const historyReport = reports.filter(report => report.entry === 'history').at(-1)
    expect(historyReport?.health).toMatchObject({ state: 'ready' })
    expect(state.get(KV.feishu.history('oc_a')), '补收完推进游标').not.toBe('2026-09-01T00:00:00.000Z')
  })
})
