/**
 * @pneuma/superagent 的贯通测试：来源注册与实例解析 → 准入与 scope → 引擎摄取 → 出站发送。
 *
 * 为什么挑这四类：它们判错都不报错，只会悄悄换个行为——实例配置坏了却继续轮询、停用的来源还在收
 * 消息、一条消息建出两个工单、发不出去的消息被当成已发。所以每条都用「准不准」断言，不看「有没有
 * 抛错」。
 *
 * 上游对应（`D:\code\dsh-superagent-prototype` @ 8c32a9d）：任务点名的 `tests/sources.spec.ts`（104KB）
 * 只放 Feishu / GitHub 两种来源插件的适配细节（事件消费、轮询、话题恢复），没有下面这四类行为；
 * 这四类在上游别处，本文件按行为转写，每条的上游标题与行号写在用例注释里，便于对账：
 *   - 来源注册与实例解析 → `tests/registry.spec.ts:23 / :34 / :76 / :119`
 *   - 准入与 scope       → `tests/policy.spec.ts:32 / :40 / :49`、`tests/registry.spec.ts:126 / :137`
 *   - 触发摄取到引擎     → `tests/core-engine.spec.ts:75 / :83 / :91 / :115 / :146`
 *   - 出站发送           → `tests/registry.spec.ts:41 / :58`、`tests/outbox.spec.ts:30`
 *
 * 假的东西只有三样：假 `kind`（对象字面量，scope / channel 只实现被测行为要用的字段）、假判定器
 * （记录候选）、假执行器与假发件箱。`SourceRegistry`、`SettingsSchema` / `settingsPolicy`、`Engine`、
 * `Store`（tmpdir 下的真 sqlite）、`Effects` / `Outbox`、`HealthBoard` 全是真的。这样每条用例同时钉住
 * 「注册表给的判定」和「引擎 / 发件箱拿它做了什么」，而不是两边各测一半。
 *
 * 与 `tests/source-registry.test.mjs` 的分工：那个文件逐方法钉注册表自己的契约；这里只补它没覆盖的
 * 两件事——设置改了之后解析结果跟着变、注册表判完之后的引擎 / 出站后果，不重复它的单元断言。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/sources-integration
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, test } from 'node:test'
import { z } from 'zod'

const { Engine, key } = await import('../../../../lib/packages/superagent/core/index.js')
const { SettingsSchema, settingsPolicy } = await import('../../../../lib/packages/superagent/core/policy.js')
const { SourceRegistry } = await import('../../../../lib/packages/superagent/sources/registry.js')
const { Store } = await import('../../../../lib/packages/superagent/app/store.js')
const { Effects } = await import('../../../../lib/packages/superagent/app/effects.js')
const { Outbox } = await import('../../../../lib/packages/superagent/app/outbox.js')
const { HealthBoard } = await import('../../../../lib/packages/superagent/infra/health.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 每个用例一个临时库：真 sqlite，收尾关库并删目录。 */
let directory
let store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-sources-integration-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

/** 探针来源的配置 schema：与上游 Feishu kind 同形的「听哪些群、群里听点名还是全部」。`strict` 让多余键也算配置坏了。 */
const configSchema = z.object({
  chats: z.array(z.object({ chatId: z.string(), listen: z.enum(['mentions', 'all']) })).default([]),
  directMessages: z.boolean().default(true),
}).strict()

/** 探针来源的策略段 schema：`allowed` 之外多一个 `limit`，用来验「kind 自己校验自己那段」。 */
const policySchema = z.object({
  allowed: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([]),
  syncChat: z.string().default(''),
  limit: z.number().int().default(5),
}).strict()

/**
 * 造一个假 kind：只实现被测行为要用的字段。
 * `scope` 与上游 Feishu kind 同形——私信、已列群（点名 / 全部）、未列群，返回注册表直接透传的判定。
 */
function kindOf(id, overrides = {}) {
  return {
    kind: id,
    title: { zh: id, en: id },
    description: { zh: `${id} 的测试来源`, en: `test source ${id}` },
    schema: configSchema,
    policy: { schema: policySchema, fields: [], explicit: { zh: '点名智能体', en: 'names the agent' } },
    fields: [],
    health: [`${id}:poll`],
    scope: ({ meta }, config) => {
      if (meta.direct === true) {
        return config.directMessages
          ? { listened: true, observed: false, row: 'direct' }
          : { listened: false, reason: 'direct_messages_not_allowed' }
      }
      const chat = config.chats.find(item => item.chatId === meta.chatId)
      if (!chat) return { listened: false, reason: 'chat_not_listed' }
      return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    },
    ...overrides,
  }
}

/** 主聊天：已列、听全部消息。 */
const CHAT = 'chat-1'

/**
 * 造一份真设置：单个 `probe` 来源；名单里有 Alice；默认 `auto` 模式（收推断候选）。
 * 传 `config` / `enabled` / `policy` 覆盖，其余块由 `SettingsSchema` 补默认值。
 */
function settingsOf({ config = { chats: [{ chatId: CHAT, listen: 'all' }] }, enabled = true, policy = { allowed: [{ id: 'alice', name: 'Alice' }] }, mode = 'auto' } = {}) {
  return SettingsSchema.parse({
    policy: { sources: { probe: policy } },
    eval: { mode },
    sources: { probe: { enabled, config } },
  })
}

/** 一条人对智能体说的话：主聊天里的点名消息，带回应地址。 */
function triggerOf(id, overrides = {}) {
  return {
    id,
    source: 'probe',
    threads: [{ source: 'probe', id: CHAT }],
    actor: { source: 'probe', id: 'alice' },
    human: true,
    addressed: 'mention',
    at: '2026-10-01T00:00:00.000Z',
    text: '把这段文案改掉',
    channel: { source: 'probe', thread: `probe:${CHAT}`, address: { chatId: CHAT } },
    meta: { chatId: CHAT },
    ...overrides,
  }
}

/**
 * 造一套「真引擎 + 真注册表 + 真库」：只把判定器 / 执行器 / 发件箱换成记录用的假件，
 * 与上游 `core-engine.spec.ts` 的 `harness()` 同形。`use()` 模拟设置页保存后策略与实例立刻按新设置解析。
 */
function setupEngine(initial = settingsOf()) {
  let current = initial
  const sources = new SourceRegistry(() => current)
  /** 判定器收到的候选：上游用它断言「该问的问了、不该问的没问」。 */
  const requests = []
  /** 发件箱收到的消息：上游断言回执与正文。 */
  const outbound = []
  /** 执行器收到的启动请求。 */
  const launches = []
  const engine = new Engine({
    repo: store,
    scope: sources,
    policy: () => settingsPolicy(current, sources),
    assessor: { request: (candidate) => { requests.push(candidate) } },
    executor: {
      start: (ticket, assignment) => { launches.push({ ticket, assignment }) },
      deliver: () => {},
      stop: () => {},
    },
    outbox: {
      send: (message) => { outbound.push(message) },
      status: (id) => outbound.some((message) => message.id === id) ? 'pending' : undefined,
      withdraw: () => {},
    },
    now: () => '2026-10-01T00:00:00.000Z',
  })
  return {
    engine,
    sources,
    requests,
    outbound,
    launches,
    use(next) { current = next },
    settings() { return current },
  }
}

// ── 1. 来源注册与实例解析 ───────────────────────────────────────────────────

test('实例解析跟设置实时走：改设置立刻生效，配置校验不过就降成停用（上游 registry.spec.ts:23 / :34）', () => {
  // 上游 "lists every installed kind with defaults, in id order, ..." / "validates submitted instances with the kind schema..."
  let current = settingsOf()
  const sources = new SourceRegistry(() => current)
  sources.register(kindOf('probe'))
  assert.deepEqual(sources.instance('probe'), {
    id: 'probe', kind: 'probe', enabled: true, config: { chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true },
  })
  // 注册之后改设置：解析用的是调用时的设置，不是注册那一刻的快照。
  current = settingsOf({ config: { chats: [{ chatId: 'chat-2', listen: 'mentions' }] } })
  assert.deepEqual(sources.instance('probe').config, { chats: [{ chatId: 'chat-2', listen: 'mentions' }], directMessages: true },
    '改设置后实例配置立刻跟着变')
  // 配置坏了：退回 schema 默认值，并把实例降成停用（否则轮询会拿着半份配置一直跑）。
  current = settingsOf({ config: { chats: 'not-an-array' } })
  assert.deepEqual(sources.instance('probe'), {
    id: 'probe', kind: 'probe', enabled: false, config: { chats: [], directMessages: true },
  }, 'schema 校验不过：默认值 + 停用')
  passed += 1
})

test('注销后同名 kind 能再注册（健康项重新领取），设置里留下的配置成为孤儿实例（上游 registry.spec.ts:76 / :119 / :23）', () => {
  // 上游 "refuses a kind that declares a health entry ... and gives up its entries at unregister"
  //      "refuses a second registration of one kind and forgets a kind after its disposer runs"
  const current = settingsOf()
  const sources = new SourceRegistry(() => current)
  const dispose = sources.register(kindOf('probe'))
  assert.equal(sources.healthEntries(['probe:poll']).size, 1, '注册时领走它声明的体检项')
  dispose()
  assert.equal(sources.healthEntries(['probe:poll']).size, 0, '注销后体检项要还回去')
  assert.deepEqual(sources.instances(), [{
    id: 'probe', kind: 'probe', enabled: true, config: { chats: [{ chatId: CHAT, listen: 'all' }] }, installed: false,
  }], '设置里留着配置、kind 没装：算孤儿实例，配置原样保留')
  // 还回去了才能再注册（同名体检项若没释放，这里会抛「已被人报」）。
  sources.register(kindOf('probe'))
  assert.equal(sources.healthEntries(['probe:poll']).size, 1, '再注册重新领到一格')
  assert.equal(sources.instance('probe').enabled, true)
  passed += 1
})

// ── 2. 准入与 scope ─────────────────────────────────────────────────────────

test('scope 四分支落到引擎摄取：没装 / 停用 / 配置坏 / kind 自己判不监听都进不来（上游 policy.spec.ts:32 / :40 / :49）', () => {
  // 上游 "listens to configured chats, reads every message only where configured, and follows the direct-message switch"
  //      "listens to nothing from a configured Source whose plugin is not loaded, and keeps an invalid stored configuration disabled"
  //      "filters everything from a disabled Source"
  const h = setupEngine()
  const dispose = h.sources.register(kindOf('probe'))
  assert.equal(h.engine.receive(triggerOf('listened')), 'stored', 'kind 说监听：存下并排队')
  assert.equal(h.engine.receive(triggerOf('unlisted', { meta: { chatId: 'chat-9' } })), 'filtered', 'kind 自己判不监听')
  assert.deepEqual(store.triggers.disposition('unlisted').filtered, { code: 'chat_not_listed' }, '过滤原因用 kind 给的原话')
  h.use(settingsOf({ enabled: false }))
  assert.equal(h.engine.receive(triggerOf('off')), 'filtered', '停用的来源一条都不听')
  assert.deepEqual(store.triggers.disposition('off').filtered, { code: 'source_disabled' })
  h.use(settingsOf({ config: { chats: 'not-an-array' } }))
  assert.equal(h.engine.receive(triggerOf('broken')), 'filtered', '配置校验不过 = 实例降成停用')
  assert.deepEqual(store.triggers.disposition('broken').filtered, { code: 'source_disabled' })
  dispose()
  h.use(settingsOf())
  assert.equal(h.engine.receive(triggerOf('ghost')), 'filtered', '设置里配了、插件没装：判「没装」而不是「没配」')
  assert.deepEqual(store.triggers.disposition('ghost').filtered, { code: 'source_not_installed' })
  passed += 1
})

test('channelAllowed 跟着实时设置与实例解析走：配置坏了实例停用，就不许再回话（上游 registry.spec.ts:137）', async () => {
  // 上游 "allows a reply only on a Channel whose Source still listens to its chat"
  let current = settingsOf()
  const sources = new SourceRegistry(() => current)
  const posted = []
  sources.register(kindOf('probe', { channel: {
    allowed: (address) => address.chatId === CHAT,
    send: async () => { posted.push('probe'); return 'sent' },
    link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }),
  } }))
  const channel = { source: 'probe', address: { chatId: CHAT } }
  const message = { id: 'reply-1', channel: { source: 'probe', thread: `probe:${CHAT}`, address: { chatId: CHAT } }, text: 'done', kind: 'reply' }
  assert.equal(sources.channelAllowed(channel), true, '启用的来源、地址在 allowed 里：可以回')
  assert.equal(await sources.send(message, {}), 'sent', '有 channel 的 kind：透传它自己的结果')
  assert.deepEqual(posted, ['probe'])
  current = settingsOf({ config: { chats: 'not-an-array' } })
  assert.equal(sources.channelAllowed(channel), false, '配置校验不过 → 实例停用 → 渠道判不许')
  current = settingsOf({ enabled: false })
  assert.equal(sources.channelAllowed(channel), false, '来源关闭：不许回')
  current = settingsOf({ config: { chats: [{ chatId: CHAT, listen: 'mentions' }] } })
  assert.equal(sources.channelAllowed(channel), true, '重新启用后又允许')
  passed += 1
})

test('policyPart 与 validatePolicy：kind 自己那段坏了退回默认值，准入表由共享 schema 单独管（上游 registry.spec.ts:126）', () => {
  // 上游 "validates each Source's part of the Policy with its kind, keeping parts of kinds that are not installed as stored"
  // kind 升级后 schema 变严（`limit` 从数字变必填校验）会撞上旧存盘：那段读不出来时退回默认值，而不是让整份策略读不出。
  const current = SettingsSchema.parse({
    policy: { sources: { probe: { allowed: [{ id: 'alice' }], limit: 'not-a-number', admission: { row1: { listedUnaddressed: 'inferred' } } } } },
    sources: { probe: { config: {} } },
  })
  const sources = new SourceRegistry(() => current)
  sources.register(kindOf('probe'))
  assert.deepEqual(sources.policyPart('probe'), {
    allowed: [], syncChat: '', limit: 5, admission: { row1: { listedUnaddressed: 'inferred' } },
  }, 'kind 自己那段校验不过：退回 schema 默认值；admission 单独校验、原样保留')
  assert.throws(
    () => sources.validatePolicy({ probe: { allowed: [{ id: 'alice' }], admission: { row1: { listedUnaddressed: 'explicit' } } } }),
    z.ZodError,
    '准入表的格值只允许 inferred / ignore，explicit 要拒',
  )
  assert.deepEqual(sources.validatePolicy({ probe: { allowed: [{ id: 'alice' }] } }), {
    probe: { allowed: [{ id: 'alice' }], syncChat: '', limit: 5, admission: {} },
  }, '提交时 admission 缺省补空表，其余交给 kind 自己的 schema')
  assert.equal(sources.policyPart('ghost'), undefined, '没装的 kind 没有策略段')
  passed += 1
})

// ── 3. 触发摄取到引擎 ───────────────────────────────────────────────────────

test('收到 Trigger 只存一次：重复的回 duplicate，不再排队（上游 core-engine.spec.ts:75）', () => {
  // 上游 "stores a trigger once and records source filtering"
  const h = setupEngine()
  h.sources.register(kindOf('probe'))
  assert.equal(h.engine.receive(triggerOf('1')), 'stored')
  assert.equal(h.engine.receive(triggerOf('1')), 'duplicate', '同一个 id 第二次来只算重复')
  assert.deepEqual(store.threads.get(`probe:${CHAT}`).pending, ['1'], '只排一条，不会重复评估')
  assert.deepEqual(store.triggers.disposition('1'), {
    fanout: [], at: '2026-10-01T00:00:00.000Z',
  }, '没人订阅时就记一条空的分发记录')
  passed += 1
})

test('一条 Trigger 落在多个线程上：只在主线程排队评估，其余线程只记关联（上游 core-engine.spec.ts:83）', () => {
  // 上游 "records correlation for a trigger on several threads and evaluates only on the primary one"
  const h = setupEngine()
  h.sources.register(kindOf('probe'))
  h.engine.receive(triggerOf('1', { threads: [{ source: 'probe', id: 'pr-7' }, { source: 'probe', id: 'run-9' }] }))
  assert.deepEqual(store.threads.get('probe:pr-7').pending, ['1'], '主线程（threads[0]）承载这次评估')
  assert.deepEqual(store.threads.get('probe:pr-7').correlated, ['probe:run-9'])
  assert.deepEqual(store.threads.get('probe:run-9').pending, [], '其余线程不排队')
  assert.deepEqual(store.threads.get('probe:run-9').correlated, ['probe:pr-7'], '关联是双向的')
  passed += 1
})

test('接受（accept）建工单：授权、订阅、回执、启动任务一起落地（上游 core-engine.spec.ts:115）', () => {
  // 上游 "accept creates a ticket with a mandate, subscribes the thread, queues the acknowledgement and starts an assignment"
  const h = setupEngine()
  h.sources.register(kindOf('probe'))
  const trigger = triggerOf('1')
  assert.equal(h.engine.receive(trigger), 'stored')
  h.engine.evaluateDue()
  assert.equal(h.requests.length, 1, '排队的一条消息开一次评估')
  const candidate = h.requests[0]
  assert.equal(candidate.strength, 'explicit', '名单内的人点名 → explicit')
  const decision = h.engine.decide(candidate.triggers[0].id, {
    kind: 'accept', title: 'Fix the copy', scope: 'small', reason: 'requested', acknowledgement: 'on it', evalId: candidate.evalId,
  })
  assert.equal(decision.kind, 'accept')
  const ticket = store.tickets.get(decision.ticketId)
  assert.equal(ticket.title, 'Fix the copy')
  assert.equal(ticket.ended, undefined, '新工单是活的')
  assert.equal(ticket.mandate.strength, 'explicit')
  assert.equal(ticket.mandate.basis.via, 'addressed', '授权来源记的是「点名」')
  assert.equal(ticket.mandate.actor.id, 'alice')
  assert.equal(ticket.mandate.policyVersion, decision.policyVersion, '授权绑定判定时的策略版本')
  assert.deepEqual(ticket.channels, [trigger.channel])
  assert.deepEqual(ticket.origin, { triggerId: '1', triggerIds: ['1'] })
  assert.deepEqual(store.threads.get(`probe:${CHAT}`).subscriptions, [ticket.id], '工单订阅来源的线程')
  assert.deepEqual(h.outbound, [{
    id: key('ack', '1'), channel: trigger.channel, text: 'on it', kind: 'acknowledgement', ticketId: ticket.id,
  }], '先发一条收到回执')
  assert.equal(h.launches.length, 1, '执行器拿到一次启动请求')
  assert.equal(h.launches[0].ticket.id, ticket.id)
  h.engine.assignmentStarted(ticket.id, ticket.assignments[0].id)
  assert.equal(store.tickets.get(ticket.id).assignments[0].state, 'running', '执行器报告已启动后任务在跑')
  passed += 1
})

test('进门就被拦住的消息不叫判定器，直接记 ignore 决策（上游 core-engine.spec.ts:91）', () => {
  // 上游 "ignores at the gate without an assessor when nothing is admissible"
  const h = setupEngine()
  h.sources.register(kindOf('probe'))
  h.engine.receive(triggerOf('stranger', { actor: { source: 'probe', id: 'mallory' } }))
  h.engine.evaluateDue()
  assert.equal(h.requests.length, 0, '名单外的人不花判定器的钱')
  const [decision] = store.decisions.byThread(`probe:${CHAT}`)
  assert.equal(decision.kind, 'ignore')
  assert.deepEqual(decision.reason.map((item) => item.code), ['not_a_member'])
  assert.equal(store.triggers.disposition('stranger').decisionId, decision.id, '消息上记下是哪条决策处理了它')
  passed += 1
})

test('判定期间策略版本变了：不按旧授权建工单，记 unavailable 并把消息排回队列（上游 core-engine.spec.ts:146）', () => {
  // 上游 "records unavailable when the policy version changed during assessment"
  const h = setupEngine()
  h.sources.register(kindOf('probe'))
  h.engine.receive(triggerOf('1'))
  h.engine.evaluateDue()
  const candidate = h.requests[0]
  // 判定器还在想，设置页把名单改了：策略版本随 `policy.sources` 变化。
  h.use(settingsOf({ policy: { allowed: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }] } }))
  assert.notEqual(settingsPolicy(h.settings(), h.sources).version, candidate.policyVersion)
  const decision = h.engine.decide(candidate.triggers[0].id, {
    kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', evalId: candidate.evalId,
  })
  assert.equal(decision.kind, 'unavailable', '旧版本下的判定作废')
  assert.deepEqual(decision.reason.map((item) => item.code), ['policyChanged'])
  assert.deepEqual(store.tickets.list(), [], '不按旧授权建工单')
  assert.deepEqual(store.threads.get(`probe:${CHAT}`).pending, ['1'], '消息排回队列，等新版本重新评估')
  passed += 1
})

// ── 4. 出站发送 ─────────────────────────────────────────────────────────────

test('registry.send 三态：没装 waiting、没 channel gone、有 channel sent（上游 registry.spec.ts:41 / :58）', async () => {
  // 上游 "sends, links and reads a kind's Threads through its own channel and context, and nothing for a kind without them"
  const sources = new SourceRegistry(() => settingsOf())
  const seen = []
  sources.register(kindOf('alpha', { channel: {
    send: async (host, message) => { seen.push({ host, message }); return 'sent' },
    link: () => ({ url: '', label: { zh: '', en: '' } }),
  } }))
  sources.register(kindOf('beta'))
  const commands = { deployment: { repository: 'owner/repo' }, repository: 'owner/repo' }
  const message = (source) => ({ id: 'reply-1', channel: { source, thread: `${source}:1`, address: { chatId: CHAT } }, text: 'done', kind: 'reply' })
  assert.equal(await sources.send(message('alpha'), commands), 'sent', 'kind 的 channel 说发出去了')
  assert.deepEqual(seen[0].message, message('alpha'))
  assert.equal(seen[0].host.commands, commands, 'commands 原样交给 channel')
  assert.equal(await sources.send(message('beta'), commands), 'gone', '没有 channel 的 kind 永远发不出去')
  assert.equal(await sources.send(message('ghost'), commands), 'waiting', 'kind 没装：等它装上再发')
  passed += 1
})

test('Outbox 把出站三态落成三种收条：sent / 丢弃 channelGone / 继续等（上游 outbox.spec.ts:30）', async () => {
  // 上游 "keeps a message for a Source that is not installed waiting, and sends it once the Source's kind registers"
  const board = new HealthBoard()
  let clock = Date.parse('2026-10-01T00:00:00Z')
  const effects = new Effects(store, board, () => clock)
  const current = SettingsSchema.parse({ sources: { alpha: { config: {} }, beta: { config: {} }, gamma: { config: {} } } })
  const sources = new SourceRegistry(() => current, new HealthBoard())
  const posted = []
  const link = () => ({ url: '', label: { zh: '', en: '' } })
  sources.register(kindOf('alpha', { channel: { send: async () => { posted.push('alpha'); return 'sent' }, link } }))
  sources.register(kindOf('beta'))
  const outbox = new Outbox({ store, effects, sources, commands: {}, paused: () => false })
  effects.start()
  const message = (id, source) => ({ id, channel: { source, thread: `${source}:1`, address: {} }, text: 'done', kind: 'notice' })
  outbox.send(message('reply-alpha', 'alpha'))
  outbox.send(message('reply-beta', 'beta'))
  outbox.send(message('reply-gamma', 'gamma'))
  await outbox.sent()
  assert.equal(outbox.status('reply-alpha'), 'sent', "channel 回 'sent'：收条结 sent")
  assert.equal(outbox.status('reply-beta'), 'dropped', "没有 channel 回 'gone'：收条丢弃，不重试")
  assert.equal(store.receipts.get('reply-beta').dropped.reason, 'channelGone')
  assert.equal(outbox.status('reply-gamma'), 'pending', "kind 没装回 'waiting'：收条留着等它装上")
  // 装上 kind 后按首次退避（5 秒）重试：消息真的发出去。
  sources.register(kindOf('gamma', { channel: { send: async () => { posted.push('gamma'); return 'sent' }, link } }))
  clock += 5000
  await outbox.sent()
  assert.equal(outbox.status('reply-gamma'), 'sent', '5 秒后重试并结 sent')
  assert.deepEqual(posted, ['alpha', 'gamma'])
  passed += 1
})
