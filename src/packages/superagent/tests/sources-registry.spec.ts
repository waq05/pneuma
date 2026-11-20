/**
 * 来源注册表（`sources/registry.ts`）与飞书来源 kind（`sources/feishu.ts`）的单元测试。
 *
 * 为什么挑这两块：注册表是「已装来源 kind ↔ 设置里的实例 ↔ 策略段 ↔ 引擎的 SourceScope」
 * 唯一的翻译层，它判错不抛异常——停用的来源照样轮询、坏配置照样当默认值用、别的 kind 的
 * 体检格被覆盖，症状全是「看起来正常」。飞书 kind 同理：`scope()` 决定一条消息算不算「听到」，
 * `channel.allowed()` 决定回复发不发得出去。
 *
 * 假的只有 kind（对象字面量）与 `Commands`（只实现被调到的 `lark`）；`SourceRegistry`、
 * `HealthBoard`、`SettingsSchema`、`AdmissionTableSchema`、zod schema 全是真源码。
 * 不联网、不跑 lark-cli、不碰 `~/.dsc`。
 *
 * @module @pneuma/superagent/tests/sources-registry
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SettingsSchema, type Settings } from '../core/policy.js'
import type { Commands } from '../infra/commands.js'
import type { Deployment } from '../deployment.js'
import { HealthBoard } from '../infra/health.js'
import type { SourceHost } from '../sources/host.js'
import { SourceRegistry } from '../sources/registry.js'
import { feishuKind, feishuSettings, feishuTriggerId, startFeishu } from '../sources/feishu.js'
import type { SourceKind } from '../sources/kind.js'

const settingsOf = (sources: Record<string, unknown> = {}): Settings => SettingsSchema.parse({ sources })
const kindOf = (over: Record<string, unknown> = {}): SourceKind<Record<string, unknown>> => ({
  kind: 'probe',
  title: { zh: '探针', en: 'Probe' },
  description: { zh: '测试来源', en: 'Test source' },
  schema: z.object({ chat: z.string().default(''), pages: z.number().int().default(3) }).strict(),
  fields: [],
  health: [],
  ...over,
} as unknown as SourceKind<Record<string, unknown>>)

const policyKind = () => kindOf({
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string(), name: z.string().optional() }).strict()).default([]),
      extra: z.string().default('') }).strict(),
    fields: [],
    explicit: { zh: '点名', en: 'mentions' },
  },
})

describe('SourceRegistry 注册', () => {
  it('注册返回注销函数：重复注册抛错，注销后可以再注册', () => {
    const registry = new SourceRegistry(() => settingsOf())
    const unregister = registry.register(kindOf())
    expect(registry.kind('probe')?.kind).toBe('probe')
    expect(() => registry.register(kindOf())).toThrow('Source kind already registered: probe')
    unregister()
    expect(registry.kind('probe')).toBeUndefined()
    expect(() => registry.register(kindOf())).not.toThrow()
  })

  it('注册时替 kind 领走它声明的体检格，注销时还回去', () => {
    const board = new HealthBoard()
    const registry = new SourceRegistry(() => settingsOf(), board)
    const unregister = registry.register(kindOf({ health: ['probe', 'probe:history'] }))
    expect([...registry.healthEntries(['probe', 'probe:history', 'other']).keys()]).toEqual(['probe', 'probe:history'])
    expect(() => board.claim('probe')).toThrow(/reported by another part/)
    unregister()
    expect(registry.healthEntries(['probe']).size).toBe(0)
    expect(() => board.claim('probe'), '注销后体检格空出来了').not.toThrow()
  })

  it('拒绝 sync: 前缀与已被别人占用的体检格，且注册失败时不留下半个 kind', () => {
    const board = new HealthBoard()
    board.claim('probe:history')
    const registry = new SourceRegistry(() => settingsOf(), board)
    expect(() => registry.register(kindOf({ health: ['sync:github'] }))).toThrow(/which another part reports/)
    expect(() => registry.register(kindOf({ health: ['probe:history'] }))).toThrow(/another part/)
    expect(registry.kind('probe')).toBeUndefined()
    expect(() => registry.register(kindOf({ health: ['probe'] }))).not.toThrow()
  })

  it('注册回调拿到 kind，注销时回调不重复调用', () => {
    const registered = vi.fn(() => vi.fn())
    const registry = new SourceRegistry(() => settingsOf(), undefined, registered)
    const unregister = registry.register(kindOf())
    expect(registered).toHaveBeenCalledTimes(1)
    expect((registered.mock.calls[0] as unknown[])[0]).toMatchObject({ kind: 'probe' })
    unregister()
    unregister()
    expect(registered).toHaveBeenCalledTimes(1)
  })
})

describe('SourceRegistry 实例解析', () => {
  it('instances：已装 kind 按 ID 排序在前，未装但设置里有的孤儿实例在后', () => {
    const registry = new SourceRegistry(() => settingsOf({
      probe: { enabled: true, config: { chat: 'c1', pages: 5 } },
      zeta: { enabled: false, config: {} },
      alpha: { enabled: true, config: { orphan: true } },
    }))
    registry.register(kindOf({ kind: 'zeta' }))
    registry.register(kindOf({ kind: 'probe' }))
    expect(registry.instances()).toEqual([
      { id: 'probe', kind: 'probe', enabled: true, config: { chat: 'c1', pages: 5 }, installed: true },
      { id: 'zeta', kind: 'zeta', enabled: false, config: { chat: '', pages: 3 }, installed: true },
      { id: 'alpha', kind: 'alpha', enabled: true, config: { orphan: true }, installed: false },
    ])
  })

  it('instance：只有已装 kind 才有实例，配置校验不过时退回默认值并停用', () => {
    const registry = new SourceRegistry(() => settingsOf({
      probe: { enabled: true, config: { chat: 'c1', pages: 'not a number' } },
    }))
    registry.register(kindOf())
    expect(registry.instance('probe')).toEqual({ id: 'probe', kind: 'probe', enabled: false, config: { chat: '', pages: 3 } })
    expect(registry.instance('missing')).toBeUndefined()
    const good = registry.instance('probe', settingsOf({ probe: { enabled: false, config: { chat: 'x' } } }))
    expect(good, '显式传设置时不看构造时那份').toEqual({ id: 'probe', kind: 'probe', enabled: false, config: { chat: 'x', pages: 3 } })
  })

  it('validate：没装的 kind 抛错，装了的用 kind 自己的 schema 解析', () => {
    const registry = new SourceRegistry(() => settingsOf())
    registry.register(kindOf())
    expect(registry.validate('probe', { enabled: true, config: { chat: 'c' } })).toEqual({ enabled: true, config: { chat: 'c', pages: 3 } })
    expect(() => registry.validate('probe', { enabled: true, config: { unknown: 1 } })).toThrow()
    expect(() => registry.validate('missing', { enabled: true, config: {} })).toThrow('Source kind not installed: missing')
  })
})

describe('SourceRegistry 策略段', () => {
  it('validatePolicy：kind 有策略时校验自己那段，admission 由公共表校验；没装的 kind 原样保留', () => {
    const registry = new SourceRegistry(() => settingsOf())
    registry.register(policyKind())
    const result = registry.validatePolicy({
      probe: { allowed: [{ id: 'alice', name: 'Alice' }], extra: 'x' },
      orphan: { allowed: [], something: 1 },
    })
    expect(result.probe).toEqual({ allowed: [{ id: 'alice', name: 'Alice' }], extra: 'x', admission: {} })
    expect(result.orphan).toEqual({ allowed: [], something: 1 })
    expect(() => registry.validatePolicy({ probe: { allowed: [{ id: 'alice', extra: true }] } })).toThrow()
  })

  it('validatePolicy 把非法 admission 拦下，不静默吞掉', () => {
    const registry = new SourceRegistry(() => settingsOf())
    registry.register(policyKind())
    expect(() => registry.validatePolicy({ probe: { allowed: [], admission: { row: { cells: 'bad' } } } })).toThrow()
  })

  it('policyPart：没策略的 kind 返回 undefined；有策略时坏值退回默认值', () => {
    const registry = new SourceRegistry(() => settingsOf({
      probe: { enabled: true, config: {} },
      broken: { enabled: true, config: {} },
    }))
    registry.register(kindOf({ kind: 'broken' }))
    registry.register(policyKind())
    expect(registry.policyPart('broken', settingsOf({ broken: { enabled: true, config: {} } }))).toBeUndefined()
    const part = registry.policyPart('probe', SettingsSchema.parse({
      policy: { sources: { probe: { allowed: [{ id: 'alice' }], extra: 'e', admission: { direct: { listedUnaddressed: 'inferred', unlistedAddressed: 'explicit' } } } } },
      sources: { probe: { enabled: true, config: {} } },
    }))
    expect(part).toEqual({
      allowed: [{ id: 'alice' }], extra: 'e',
      admission: { direct: { listedUnaddressed: 'inferred', unlistedAddressed: 'explicit' } },
    })
    const fallback = registry.policyPart('probe', SettingsSchema.parse({ policy: { sources: { probe: { allowed: [], extra: 5 } } } }))
    expect(fallback, '坏值退回 schema 默认').toEqual({ allowed: [], extra: '', admission: {} })
  })
})

describe('SourceRegistry 通道与能力声明', () => {
  it('channelAllowed：没装 → false，停用 → false，kind 无 allowed 时默认放行', () => {
    const registry = new SourceRegistry(() => settingsOf({
      probe: { enabled: false, config: {} },
      open: { enabled: true, config: {} },
    }))
    registry.register(kindOf({ kind: 'open' }))
    expect(registry.channelAllowed({ source: 'missing', address: {} })).toBe(false)
    expect(registry.channelAllowed({ source: 'probe', address: {} })).toBe(false)
    expect(registry.channelAllowed({ source: 'open', address: { chat: 'c' } })).toBe(true)
    registry.register(kindOf({ kind: 'closed', channel: { allowed: () => false, send: async () => 'sent', link: () => ({ url: '', label: { zh: '', en: '' } }) } }))
    expect(registry.channelAllowed({ source: 'closed', address: {} }, settingsOf({ closed: { enabled: true, config: {} } }))).toBe(false)
  })

  it('declarations / environments：只列声明了环境的 kind，environments 只含启用的实例', () => {
    const registry = new SourceRegistry(() => settingsOf({
      probe: { enabled: true, config: {} },
      off: { enabled: false, config: {} },
    }))
    registry.register(kindOf({ kind: 'off', health: [], environment: { variables: [{ key: 'OFF_VAR', description: { zh: '关', en: 'off' } }], values: () => ({}) } }))
    registry.register(kindOf({ kind: 'plain' }))
    registry.register(kindOf({ kind: 'probe', health: [], environment: { variables: [{ key: 'PROBE_VAR', description: { zh: '探', en: 'probe' } }], values: () => ({}) } }))
    expect(registry.declarations().map(item => item.kind)).toEqual(['off', 'probe'])
    expect(registry.declarations()[0]!.variables).toEqual([{ key: 'OFF_VAR', description: { zh: '关', en: 'off' } }])
    expect(registry.environments().map(item => (item.kind as unknown as { kind: string }).kind)).toEqual(['probe'])
  })

  it('send：kind 没装等（waiting），没有通道（gone），有通道就交给它', async () => {
    const registry = new SourceRegistry(() => settingsOf({ probe: { enabled: true, config: {} } }))
    registry.register(kindOf({ channel: { send: async () => 'sent', link: () => ({ url: '', label: { zh: '', en: '' } }) } }))
    registry.register(kindOf({ kind: 'chatless' }))
    const message = { id: 'r1', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'hi', kind: 'reply' as const }
    expect(await registry.send({ ...message, channel: { ...message.channel, source: 'missing' } }, {} as never)).toBe('waiting')
    expect(await registry.send({ ...message, channel: { ...message.channel, source: 'chatless' } }, {} as never)).toBe('gone')
    expect(await registry.send(message, {} as never)).toBe('sent')
  })

  it('link：kind 没装或没声明 link 时给中性兜底标签', () => {
    const registry = new SourceRegistry(() => settingsOf())
    registry.register(kindOf())
    expect(registry.link({ source: 'missing', thread: 'x', address: {} }, {})).toEqual({ url: '', label: { zh: 'missing', en: 'missing' } })
    expect(registry.link({ source: 'probe', thread: 'x', address: {} }, {})).toEqual({ url: '', label: { zh: 'probe', en: 'probe' } })
    registry.register(kindOf({ kind: 'linked', channel: { send: async () => 'sent', link: () => ({ url: 'https://x', label: { zh: '链接', en: 'link' } }) } }))
    expect(registry.link({ source: 'linked', thread: 'x', address: {} }, {})).toEqual({ url: 'https://x', label: { zh: '链接', en: 'link' } })
  })

  it('find 合并去重、repliesTo 只问声明了的 kind', () => {
    const registry = new SourceRegistry(() => settingsOf())
    registry.register(kindOf({ find: () => ({ threads: ['probe:1'], terms: ['t1'] }) }))
    registry.register(kindOf({ kind: 'second', find: () => ({ threads: ['probe:1', 'second:2'], terms: ['t1', 't2'] }) }))
    registry.register(kindOf({ kind: 'silent' }))
    expect(registry.find('x')).toEqual({ threads: ['probe:1', 'second:2'], terms: ['t1', 't2'] })
    expect(registry.repliesTo({ source: 'silent' } as never)).toBeUndefined()
    expect(registry.repliesTo({ source: 'missing' } as never)).toBeUndefined()
    registry.register(kindOf({ kind: 'replier', repliesTo: () => 'parent-id' }))
    expect(registry.repliesTo({ source: 'replier' } as never)).toBe('parent-id')
  })
})

describe('SourceRegistry 线程上下文', () => {
  const commands = { lark: async () => ({}) } as unknown as Commands
  const base = {
    messageId: () => 'm1',
    read: async () => ({ messages: [], body: {} }),
    images: () => ['img_1'],
    image: async () => ({ saved: true }),
  }

  it('threadContext：没装 kind 或 kind 没声明上下文时返回 undefined', () => {
    const registry = new SourceRegistry(() => settingsOf())
    expect(registry.threadContext({ source: 'missing' } as never)).toBeUndefined()
    registry.register(kindOf())
    expect(registry.threadContext({ source: 'probe' } as never)).toBeUndefined()
  })

  it('threadContext 把实例配置绑进 read，images 有则用、无则空数组', async () => {
    const registry = new SourceRegistry(() => settingsOf({ probe: { enabled: true, config: { chat: 'c1' } } }))
    const reads: unknown[][] = []
    registry.register(kindOf({
      threadContext: {
        messageId: () => 'm1',
        read: async (...args: unknown[]) => { reads.push(args); return { messages: [], body: {} } },
        images: () => ['img_1'],
      },
      health: [],
    }))
    const context = registry.threadContext({ source: 'probe' } as never)!
    expect(context.messageId).toBe('m1')
    await context.read(commands, 'thread', undefined)
    expect(reads[0]!.at(-1), 'read 拿到 kind 实例配置').toEqual({ chat: 'c1', pages: 3 })
    expect(context.images('anything')).toEqual(['img_1'])

    const plain = new SourceRegistry(() => settingsOf({ probe: { enabled: true, config: {} } }))
    plain.register(kindOf({ threadContext: { messageId: () => 'm2', read: async () => ({ messages: [], body: {} }) } }))
    expect(plain.threadContext({ source: 'probe' } as never)!.images('x')).toEqual([])
  })

  it('threadContext.image：kind 不支持图片时抛错，支持时把触发器里的图文参数传下去', async () => {
    const registry = new SourceRegistry(() => settingsOf({ probe: { enabled: true, config: {} } }))
    registry.register(kindOf({ threadContext: { messageId: () => 'm1', read: async () => ({ messages: [], body: {} }) } }))
    const noImage = registry.threadContext({ source: 'probe' } as never)!
    await expect(noImage.image({}, commands, { id: 'm1', text: 't' }, 'img_1', '', new AbortController().signal))
      .rejects.toThrow('The probe Source has no images')

    const delegated = new SourceRegistry(() => settingsOf({ probe: { enabled: true, config: {} } }))
    const seen: unknown[][] = []
    delegated.register(kindOf({
      threadContext: {
        messageId: () => 'm1', read: async () => ({ messages: [], body: {} }),
        image: async (...args: unknown[]) => { seen.push(args); return { saved: true } },
      },
    }))
    const withImage = delegated.threadContext({ source: 'probe' } as never)!
    await expect(withImage.image({ agent: true }, commands, { id: 'm1', text: 't' }, 'img_1', '/tmp/state', new AbortController().signal))
      .resolves.toEqual({ saved: true })
    expect(seen[0]!.slice(0, 4), 'image 收到 agent / commands / trigger / message').toEqual([{ agent: true }, commands, { source: 'probe' }, { id: 'm1', text: 't' }])
    expect(seen[0]!.slice(4, 6), '再往后是 key 与 stateDir').toEqual(['img_1', '/tmp/state'])
  })

  it('threadContext 接受最小切片对象（base）', async () => {
    const registry = new SourceRegistry(() => settingsOf({ probe: { enabled: true, config: {} } }))
    registry.register(kindOf({ threadContext: base as never }))
    expect(await registry.threadContext({ source: 'probe' } as never)!.read(commands, 'thread', undefined)).toEqual({ messages: [], body: {} })
  })
})

describe('SourceRegistry scope', () => {
  it('没安装的 kind：设置里配了就不听，没配就只听不观察', () => {
    const registry = new SourceRegistry(() => settingsOf({ ghost: { enabled: true, config: {} } }))
    expect(registry.scope({ source: 'ghost', meta: {} })).toEqual({ listened: false, reason: 'source_not_installed' })
    expect(registry.scope({ source: 'unknown', meta: {} })).toEqual({ listened: true, observed: false })
  })

  it('停用的实例不听；启用且 kind 有 scope 时把配置与 meta 交给它', () => {
    const registry = new SourceRegistry(() => settingsOf({
      off: { enabled: false, config: {} },
      probe: { enabled: true, config: { chat: 'c1' } },
      plain: { enabled: true, config: {} },
    }))
    registry.register(kindOf({ kind: 'off' }))
    registry.register(kindOf({ kind: 'probe', scope: ({ meta }: { meta: Record<string, unknown> }, config: { chat?: string }) => ({ listened: true, observed: config.chat === 'c1', row: String(meta.kind) }) }))
    registry.register(kindOf({ kind: 'plain' }))
    expect(registry.scope({ source: 'off', meta: {} })).toEqual({ listened: false, reason: 'source_disabled' })
    expect(registry.scope({ source: 'probe', meta: { kind: 'issue' } })).toEqual({ listened: true, observed: true, row: 'issue' })
    expect(registry.scope({ source: 'plain', meta: {} })).toEqual({ listened: true, observed: false })
  })
})

// ── 飞书来源 kind ───────────────────────────────────────────────────────────

describe('feishuKind', () => {
  const config = (over: Record<string, unknown> = {}) => feishuKind.schema.parse({ cli: 'lark-cli', ...over })

  it('scope：私聊看 directMessages，列出的群按 listen，其他群看 otherChats', () => {
    const limited = config({ directMessages: false, chats: [{ chatId: 'oc_a', listen: 'mentions' }], otherChats: 'none' })
    expect(feishuKind.scope!({ meta: { direct: true } }, limited)).toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
    expect(feishuKind.scope!({ meta: { chatId: 'oc_a' } }, limited)).toEqual({ listened: true, observed: false, row: 'oc_a' })
    expect(feishuKind.scope!({ meta: { chatId: 'oc_other' } }, limited)).toEqual({ listened: false, reason: 'chat_not_allowed' })
    const all = config({ chats: [{ chatId: 'oc_a', listen: 'all' }], otherChats: 'mentions' })
    expect(feishuKind.scope!({ meta: { chatId: 'oc_a' } }, all)).toEqual({ listened: true, observed: true, row: 'oc_a' })
    expect(feishuKind.scope!({ meta: { chatId: 'oc_other' } }, all)).toEqual({ listened: true, observed: false, row: 'other' })
    expect(feishuKind.scope!({ meta: { direct: true } }, all)).toEqual({ listened: true, observed: false, row: 'direct' })
  })

  it('channel.allowed 只允许仍然接收的群回复', () => {
    const cfg = config({ chats: [{ chatId: 'oc_a', listen: 'mentions' }] })
    expect(feishuKind.channel!.allowed!({ chatId: 'oc_a' }, cfg)).toBe(true)
    expect(feishuKind.channel!.allowed!({ chatId: 'oc_other' }, cfg)).toBe(false)
    expect(feishuKind.channel!.allowed!({ chatId: 'oc_dm', direct: 'true' }, config())).toBe(true)
  })

  it('find 只认 om_ 消息 ID，repliesTo 用父消息 ID', () => {
    expect(feishuKind.find!('看 om_abc 和 om_abc 还有 om_def')).toEqual({ threads: [], terms: ['om_abc', 'om_def'] })
    expect(feishuKind.find!('没有消息 ID')).toEqual({ threads: [], terms: [] })
    expect(feishuKind.repliesTo!({ source: 'feishu', meta: { parentId: 'om_p' } } as never)).toBe(feishuTriggerId('om_p'))
    expect(feishuKind.repliesTo!({ source: 'feishu', meta: {} } as never)).toBeUndefined()
  })

  it('policy.rows 把配置翻成准入表的行', () => {
    const rows = feishuKind.policy!.rows!(config({
      chats: [{ chatId: 'oc_a', name: 'Team', listen: 'all' }, { chatId: 'oc_b', listen: 'mentions' }],
      otherChats: 'mentions', directMessages: false,
    }))
    expect(rows.map(row => row.id)).toEqual(['oc_a', 'oc_b', 'other', 'direct'])
    expect(rows[0]).toMatchObject({ label: 'Team', cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } })
    expect(rows[1]).toMatchObject({ label: 'oc_b', cells: { listedUnaddressed: false } })
    expect(rows[2]).toMatchObject({ note: { zh: '仅 @' }, cells: { unlistedAddressed: true } })
    expect(rows[3]).toMatchObject({ note: { zh: '不接收' }, cells: { listedUnaddressed: false } })
    expect(feishuKind.policy!.rows!(config({ otherChats: 'none' }))[0]!.note).toEqual({ zh: '不接收', en: 'Not received' })
  })

  it('policy.sync：没配群时不 ready，配了就把群成员同步成名单并保留顺序/名字', async () => {
    const empty = feishuKind.policy!.schema.parse({ allowed: [], syncChat: '' })
    expect(feishuKind.policy!.sync!.ready!(empty)).toBe(false)
    const part = feishuKind.policy!.schema.parse({ allowed: [{ id: 'ou_alice', name: 'Alice' }, { id: 'ou_gone', name: 'Gone' }], syncChat: 'oc_a' })
    expect(feishuKind.policy!.sync!.ready!(part)).toBe(true)

    const larkCalls: string[][] = []
    const host = {
      context: () => ({
        commands: {
          withSignal: () => ({
            lark: async (args: string[]) => {
              larkCalls.push(args)
              return { users: [{ member_id: 'ou_alice', name: 'Alice2' }, { member_id: 'ou_bob', name: 'Bob' }], has_more: false, truncations: [] }
            },
          }),
        },
      }),
    }
    const synced = await feishuKind.policy!.sync!.run(host as unknown as SourceHost, part, new AbortController().signal)
    expect(larkCalls[0]).toEqual(['im', '+chat-members-list', '--chat-id', 'oc_a', '--member-types', 'user', '--page-all', '--page-limit', '0'])
    expect(synced.allowed).toEqual([{ id: 'ou_alice', name: 'Alice2' }, { id: 'ou_bob', name: 'Bob' }])

    const truncated = {
      context: () => ({ commands: { withSignal: () => ({ lark: async () => ({ users: [], has_more: true }) }) } }),
    }
    await expect(feishuKind.policy!.sync!.run(truncated as unknown as SourceHost, part, new AbortController().signal))
      .rejects.toThrow('Feishu returned an incomplete member list')
  })

  it('environment.values 与 facts 从部署取机器人信息', () => {
    const deployment = {
      feishu: { cli: 'lark-cli', appId: 'cli_app', brand: 'feishu' as const, botId: 'ou_bot', name: 'Bot' },
      repository: 'acme/widgets', github: { cli: 'gh', login: 'agent', noreply: '1+agent@users.noreply.github.com' },
      stateDir: '/tmp/state', promptMaxChars: 1, admissionContextMaxPages: 1, admissionContextTimeoutMs: 1,
    } as unknown as Deployment
    expect(feishuKind.environment!.values({ deployment, config: config(), trigger: { source: 'feishu', meta: { chatId: 'oc_a' } } as never }))
      .toEqual({ DSH_SUPERAGENT_FEISHU_BOT: 'Bot', DSH_SUPERAGENT_FEISHU_CHAT: 'oc_a' })
    expect(feishuKind.environment!.values({ deployment, config: config(), trigger: { source: 'github', meta: {} } as never }))
      .toEqual({ DSH_SUPERAGENT_FEISHU_BOT: 'Bot', DSH_SUPERAGENT_FEISHU_CHAT: '' })
    const unnamed = { ...deployment, feishu: { ...deployment.feishu!, name: '' } } as unknown as Deployment
    expect(feishuKind.environment!.values({ deployment: unnamed, config: config() }).DSH_SUPERAGENT_FEISHU_BOT, '没有应用名时用 open_id').toBe('ou_bot')
    expect(feishuKind.facts!(deployment as never)).toEqual({ cli: { zh: '当前机器人 Bot', en: 'Current bot Bot' } })
    expect(feishuKind.facts!(undefined)).toEqual({})
  })

  it('feishuSettings 在插件没装/没配时退回默认值', () => {
    const registry = new SourceRegistry(() => settingsOf())
    expect(feishuSettings(registry)).toEqual(feishuKind.schema.parse({}))
    registry.register(feishuKind)
    expect(feishuSettings(registry)).toEqual(feishuKind.schema.parse({}))
    const configured = new SourceRegistry(() => settingsOf({ feishu: { enabled: true, config: { cli: 'lark-cli', readPageSize: 10 } } }))
    configured.register(feishuKind)
    expect(feishuSettings(configured))
      .toMatchObject({ cli: 'lark-cli', readPageSize: 10 })
  })
})

describe('startFeishu', () => {
  const hostOf = (options: { configured: boolean; feishu?: boolean; config?: unknown }) => {
    const reports: unknown[][] = []
    const unregister = vi.fn()
    const context = {
      deployment: options.feishu === false ? { repository: 'acme/widgets', github: { login: 'agent' } }
        : { repository: 'acme/widgets', github: { login: 'agent' }, feishu: { cli: 'lark-cli', appId: 'cli_app', brand: 'feishu', botId: 'ou_bot', name: 'Bot' } },
      commands: { withSignal: () => ({ lark: async () => ({ chats: [] }) }) },
      ready: Promise.resolve(),
      configured: () => options.configured,
      problem: undefined,
      config: () => options.config,
      receive: async () => ({ received: true }),
      atomic: <T>(work: () => T) => work(),
      state: { get: () => undefined, set: () => {}, keys: () => [] },
      threads: { get: () => undefined, subscribed: () => [], describe: () => {}, patch: () => {} },
      tickets: { get: () => undefined, open: () => [], bindThread: () => {}, threadClosed: () => {} },
      triggers: { get: () => undefined, latest: () => undefined },
      notify: () => {},
      report: (...args: unknown[]) => reports.push(args),
    }
    const host = {
      sources: { register: () => unregister },
      context: () => context,
    }
    return { host: host as unknown as SourceHost, reports, unregister }
  }

  it('启动即注册 kind，信号中止后注销（等就绪失败时只报暂停，不起任何循环）', async () => {
    const { host, reports, unregister } = hostOf({ configured: false })
    const controller = new AbortController()
    const stop = startFeishu(host, controller.signal)
    controller.abort()
    stop()
    stop()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(unregister).toHaveBeenCalled()
    const codes = reports.map(report => (report[1] as { code?: string }).code)
    expect(new Set(codes), '没配置好时只报 setupPending 与 feishuBotMissing').toEqual(new Set(['setupPending', 'feishuBotMissing']))
    expect(codes.length).toBeGreaterThanOrEqual(2)
  })

  it('配置好但来源被关时，循环报告 sourceOff 后随中止退出', async () => {
    const { host, reports } = hostOf({ configured: true, config: undefined })
    const controller = new AbortController()
    startFeishu(host, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 10))
    const details = reports.map(report => (report[1] as { detail?: string; code?: string }))
    expect(details.some(report => report.code === 'sourceOff')).toBe(true)
    expect(details.some(report => report.code === 'feishuBotMissing'), '有机器人后不再报 feishuBotMissing').toBe(false)
  })
})
