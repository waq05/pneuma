/**
 * @pneuma/superagent 来源注册表的包级测试：注册 / 注销、健康项归属、实例解析、策略与通道分发、接收范围。
 *
 * 为什么这些要单独钉：上游把这套契约当成「加一种来源只写一个插件」的地基，判错全都不报错，只会
 * 悄悄换个行为——注册表里多留一格健康项，重启时同名的 kind 就注册不上了；实例配置坏了却不停用，
 * 轮询会拿着半份配置一直跑；`scope` 判错会让某类事件从此不被观察。所以每条都断言「准不准」。
 *
 * 假的只有两样：设置（`SettingsSchema.parse` 造的真设置）、kind（对象字面量，只实现被测行为要用的
 * 字段）。健康板子用真 `HealthBoard`（`infra/health.js`）套一层记录，只看它领了谁、还了谁——板子本身
 * 的单写者与释放语义由 `infra-health-test.mjs` 负责，这里不重复实现假板子。注册表本身跑的是构建产物，
 * 不碰 `~/.dsc`。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/source-registry
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { z } from 'zod'

const { SourceRegistry } = await import('../../../../lib/packages/superagent/sources/registry.js')
const { HealthBoard } = await import('../../../../lib/packages/superagent/infra/health.js')
const { SettingsSchema } = await import('../../../../lib/packages/superagent/core/policy.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 每个 kind 的配置 schema：两个带默认值的字段，`strict` 让多余键也算配置坏了。 */
const configSchema = z.object({ label: z.string().default('alpha'), count: z.number().int().default(1) }).strict()

/** kind 的策略段 schema：与 `SourcePolicyPart` 同形（`allowed` + 自己的字段）。 */
const policySchema = z.object({
  allowed: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([]),
  note: z.string().default(''),
}).strict()

/** 造一份真设置：传进来的 `sources` / `policySources` 过 `SettingsSchema`，缺的块由 schema 补默认值。 */
function makeSettings(sources = {}, policySources = {}) {
  return SettingsSchema.parse({ sources, policy: { sources: policySources } })
}

/** 真 `HealthBoard` 加一层记录：记下谁被领走、谁被还回来，供断言看。用组合而不是继承——板子内部自己占了 `claimed` 这个名字。 */
class TrackingBoard {
  #board = new HealthBoard()
  claimed = new Map()
  released = []
  claim(name, initial) {
    const entry = this.#board.claim(name, initial)
    this.claimed.set(name, entry)
    const release = entry.release
    entry.release = () => {
      if (!this.claimed.delete(name)) return
      this.released.push(name)
      release()
    }
    return entry
  }
}

const makeBoard = () => new TrackingBoard()

/** 造一个注册表 + 它的健康板子；`health` 传进来时用它（测「别人先占了一格」这类场景）。 */
function setup({ sources = {}, policySources = {}, registered, health = makeBoard() } = {}) {
  // 上游构造是三个位置参数：settings 取值函数、健康板子、注册回调（缺省由注册表自己兜底）。
  const registry = new SourceRegistry(() => makeSettings(sources, policySources), health, registered)
  return { registry, health }
}

/** 造一个 kind；只写被测行为用得到的字段，其余留空。 */
function kindOf(id, overrides = {}) {
  return {
    kind: id,
    title: { zh: id, en: id },
    description: { zh: `${id} 的测试来源`, en: `test source ${id}` },
    schema: configSchema,
    fields: [],
    health: [`${id}:poll`],
    ...overrides,
  }
}

/** 一条出站消息：只有 `channel.source` 参与分发。 */
function message(source) {
  return { id: 'msg-1', channel: { source, thread: 'thread-1', address: {} }, text: 'hi', kind: 'reply' }
}

/** 一条 Trigger：只有 `source` 参与 kind 查找。 */
function trigger(source) {
  return {
    id: 'trg-1', source, threads: [{ source, id: 'thread-1' }], actor: { source, id: 'alice' },
    human: true, at: '2026-01-01T00:00:00.000Z', text: 'hello', meta: {},
  }
}

/** 假执行器：来源契约只往下传，不在这里校验形状。 */
const commands = { deployment: { repository: 'owner/repo' }, repository: 'owner/repo' }

// ── 1. 注册 / 注销 ──────────────────────────────────────────────────────────

test('注册与注销：注销后 kind 消失、健康项还回去', () => {
  const { registry, health } = setup()
  const off = registry.register(kindOf('alpha'))
  assert.equal(registry.kind('alpha')?.kind, 'alpha')
  assert.equal(health.claimed.has('alpha:poll'), true, '注册时要领走它声明的体检项')
  assert.equal(registry.healthEntries(['alpha:poll']).size, 1, '活跃格子能按名字取到')
  assert.equal(registry.healthEntries(['alpha:poll', 'other:poll']).size, 1, '没领的名字不在结果里')
  off()
  assert.equal(registry.kind('alpha'), undefined)
  assert.equal(health.claimed.has('alpha:poll'), false, '注销后健康项要还回去，否则同名 kind 再注册会撞名')
  assert.deepEqual(health.released, ['alpha:poll'])
  assert.equal(registry.healthEntries(['alpha:poll']).size, 0, '还回去之后不再算活跃格子')
  passed += 1
})

test('registered 回调：注册成功调一次，注销时调它返回的退订函数', () => {
  const calls = []
  const { registry } = setup({ registered: (kind) => { calls.push(`register:${kind.kind}`); return () => calls.push(`unregister:${kind.kind}`) } })
  const off = registry.register(kindOf('alpha'))
  assert.deepEqual(calls, ['register:alpha'])
  off()
  assert.deepEqual(calls, ['register:alpha', 'unregister:alpha'])
  passed += 1
})

test('重复注册同名 kind 抛错，且不会动已有的登记', () => {
  const { registry, health } = setup()
  registry.register(kindOf('alpha'))
  assert.throws(() => registry.register(kindOf('alpha')), /already registered/)
  assert.equal(registry.kind('alpha')?.kind, 'alpha')
  assert.equal(health.claimed.has('alpha:poll'), true, '已有的健康项还在原处')
  assert.deepEqual(health.released, [], '重复注册不该释放任何人的格子')
  passed += 1
})

test('健康项冲突：第二个 kind 注册抛错，且它自己先领到的健康项要回滚', () => {
  const health = makeBoard()
  const { registry } = setup({ health })
  registry.register(kindOf('first'))
  // 先占住一格：模拟核心循环或别的插件已经报了 `taken`。
  health.claim('taken', { state: 'ready', detail: '' })
  assert.throws(
    () => registry.register(kindOf('second', { health: ['second:poll', 'taken', 'second:extra'] })),
    /声明了体检项 taken|declares the health entry taken|taken/,
  )
  assert.deepEqual(health.released, ['second:poll'], '冲突前领到的第二格要还回去')
  assert.equal(health.claimed.has('second:poll'), false)
  assert.equal(health.claimed.has('second:extra'), false, '冲突之后的名字一次都没领到')
  assert.equal(registry.kind('second'), undefined, '注册失败的 kind 不该留在表里')
  assert.deepEqual([...registry.healthEntries(['second:poll', 'second:extra']).keys()], [])
  assert.equal(health.claimed.has('taken'), true, '被占的那格仍归占用者')
  passed += 1
})

test('sync: 前缀的健康名被拒（那是设置层保留的）', () => {
  const { registry, health } = setup()
  assert.throws(() => registry.register(kindOf('alpha', { health: ['sync:roster'] })), /sync:/)
  assert.equal(health.claimed.size, 0, '整个注册在领格子之前就被拒了')
  assert.equal(registry.kind('alpha'), undefined)
  passed += 1
})

// ── 2. 实例解析 ─────────────────────────────────────────────────────────────

test('实例解析：能过 schema 用设置里的；过不了用默认值并停用；没配置用默认值且启用', () => {
  const good = setup({ sources: { alpha: { config: { label: '设置里的', count: 7 } } } })
  good.registry.register(kindOf('alpha'))
  assert.deepEqual(good.registry.instance('alpha'),
    { id: 'alpha', kind: 'alpha', enabled: true, config: { label: '设置里的', count: 7 } })

  const broken = setup({ sources: { alpha: { enabled: true, config: { label: 5 } } } })
  broken.registry.register(kindOf('alpha'))
  assert.deepEqual(broken.registry.instance('alpha'),
    { id: 'alpha', kind: 'alpha', enabled: false, config: { label: 'alpha', count: 1 } },
    '配置校验不过：退回 schema 默认值，并降成停用')

  const missing = setup()
  missing.registry.register(kindOf('alpha'))
  assert.deepEqual(missing.registry.instance('alpha'),
    { id: 'alpha', kind: 'alpha', enabled: true, config: { label: 'alpha', count: 1 } },
    '设置里没有这个 kind：用默认值，enabled 跟随默认 true')
  assert.equal(missing.registry.instance('ghost'), undefined, '没装的 kind 没有实例')
  passed += 1
})

test('validate：能过就回解析后的配置，没装的 kind 抛错', () => {
  const { registry } = setup()
  registry.register(kindOf('alpha'))
  assert.deepEqual(registry.validate('alpha', { enabled: false, config: { label: 'v' } }), { enabled: false, config: { label: 'v', count: 1 } })
  assert.throws(() => registry.validate('ghost', { enabled: true, config: {} }), /not installed/)
  assert.throws(() => registry.validate('alpha', { enabled: true, config: { label: 5 } }))
  passed += 1
})

test('instances：已装的按 ID 在前，设置里残留的孤儿实例带 installed=false 在后', () => {
  const { registry } = setup({ sources: { ghost: { enabled: false, config: { anything: 1 } }, alpha: { config: {} } } })
  registry.register(kindOf('beta'))
  registry.register(kindOf('alpha'))
  const list = registry.instances()
  assert.deepEqual(list.map((item) => [item.kind, item.installed]), [['alpha', true], ['beta', true], ['ghost', false]])
  assert.equal(list[2].id, 'ghost')
  assert.equal(list[2].enabled, false)
  assert.deepEqual(list[2].config, { anything: 1 }, '孤儿实例的配置原样保留，不按任何 schema 解析')
  passed += 1
})

// ── 3. 策略段 ───────────────────────────────────────────────────────────────

test('validatePolicy：有 policy 的 kind 校验自己那段，没装的 kind 原样保留', () => {
  const { registry } = setup()
  registry.register(kindOf('alpha', { policy: { schema: policySchema, fields: [], explicit: { zh: '点名智能体', en: 'names the agent' } } }))
  const validated = registry.validatePolicy({
    alpha: { allowed: [{ id: 'alice' }], note: 'n', admission: { direct: { unlistedAddressed: 'explicit' } } },
    ghost: { allowed: [{ id: 'bob' }], whatever: 1 },
  })
  assert.deepEqual(validated['alpha'], {
    allowed: [{ id: 'alice' }], note: 'n', admission: { direct: { unlistedAddressed: 'explicit' } },
  }, 'admission 由共享表校验，其余由 kind 自己校验')
  assert.deepEqual(validated['ghost'], { allowed: [{ id: 'bob' }], whatever: 1 }, '没装的 kind：原样保留')
  assert.throws(() => registry.validatePolicy({ alpha: { allowed: 'not-an-array' } }))
  passed += 1
})

test('policyPart：有 policy 回解析后的策略段，没装的返回 undefined', () => {
  const { registry } = setup({ policySources: { alpha: { allowed: [{ id: 'alice', name: 'Alice' }], admission: { direct: { unlistedAddressed: 'inferred' } } } } })
  registry.register(kindOf('alpha', { policy: { schema: policySchema, fields: [], explicit: { zh: '点名智能体', en: 'names the agent' } } }))
  assert.deepEqual(registry.policyPart('alpha'), {
    allowed: [{ id: 'alice', name: 'Alice' }], note: '', admission: { direct: { unlistedAddressed: 'inferred' } },
  })
  assert.equal(registry.policyPart('ghost'), undefined)
  passed += 1
})

// ── 4. 通道 ─────────────────────────────────────────────────────────────────

test('channelAllowed：停用 / channel.allowed 拒 / 没有 channel / 没装', () => {
  const { registry } = setup({ sources: { alpha: { config: { label: 'ok' } }, off: { enabled: false }, beta: {} } })
  registry.register(kindOf('alpha', { channel: {
    allowed: (address, config) => address['chat'] === config.label,
    send: async () => 'sent',
    link: () => ({ url: '', label: { zh: '', en: '' } }),
  } }))
  registry.register(kindOf('beta'))
  registry.register(kindOf('off'))
  assert.equal(registry.channelAllowed({ source: 'alpha', address: { chat: 'ok' } }), true)
  assert.equal(registry.channelAllowed({ source: 'alpha', address: { chat: 'nope' } }), false, 'channel.allowed 拒绝：不许回话')
  assert.equal(registry.channelAllowed({ source: 'off', address: {} }), false, '停用的来源一律不许回话')
  assert.equal(registry.channelAllowed({ source: 'beta', address: {} }), true, '没有 channel 的 kind 不拦')
  assert.equal(registry.channelAllowed({ source: 'ghost', address: {} }), false, '没装的 kind 一律不许')
  passed += 1
})

test('send：没装 waiting、没有 channel gone、有 channel 透传返回值并收到 commands', async () => {
  const { registry } = setup({ sources: { alpha: {} } })
  assert.equal(await registry.send(message('ghost'), commands), 'waiting', 'kind 没装：等它装上再发')
  registry.register(kindOf('beta'))
  assert.equal(await registry.send(message('beta'), commands), 'gone', '没有 channel 的 kind 永远发不出去')
  let seen = null
  registry.register(kindOf('alpha', { channel: {
    send: async (host, msg) => { seen = { host, msg }; return 'gone' },
    link: () => ({ url: '', label: { zh: '', en: '' } }),
  } }))
  assert.equal(await registry.send(message('alpha'), commands), 'gone', 'kind 的返回值原样透传')
  assert.equal(seen.host.commands, commands, 'commands 原样交给 channel')
  assert.equal(seen.msg.channel.source, 'alpha')
  passed += 1
})

test('link：有 channel 用它的链接，没有就回空 URL + 来源名', () => {
  const { registry } = setup()
  registry.register(kindOf('alpha', { channel: {
    send: async () => 'sent',
    link: (address, links) => ({ url: `https://example.test/${links.repository ?? ''}/${address['number'] ?? ''}`, label: { zh: '甲', en: 'Alpha' } }),
  } }))
  registry.register(kindOf('beta'))
  assert.deepEqual(registry.link({ source: 'alpha', thread: 't', address: { number: '7' } }, { repository: 'owner/repo' }),
    { url: 'https://example.test/owner/repo/7', label: { zh: '甲', en: 'Alpha' } })
  assert.deepEqual(registry.link({ source: 'beta', thread: 't', address: {} }, {}),
    { url: '', label: { zh: 'beta', en: 'beta' } }, '没有 channel：空 URL，标签用来源名')
  assert.deepEqual(registry.link({ source: 'ghost', thread: 't', address: {} }, {}),
    { url: '', label: { zh: 'ghost', en: 'ghost' } })
  passed += 1
})

// ── 5. 搜索与回复关系 ───────────────────────────────────────────────────────

test('find / repliesTo：有就合并去重，没有就回空、不猜', () => {
  const { registry } = setup()
  registry.register(kindOf('alpha', {
    find: (query) => ({ threads: [`alpha:${query}`], terms: [query] }),
    repliesTo: (item) => `replies-${item.id}`,
  }))
  registry.register(kindOf('beta', { find: (query) => ({ threads: [`alpha:${query}`, `beta:${query}`], terms: [] }) }))
  registry.register(kindOf('gamma'))
  assert.deepEqual(registry.find('12'), { threads: ['alpha:12', 'beta:12'], terms: ['12'] })
  const plain = setup()
  plain.registry.register(kindOf('gamma'))
  assert.deepEqual(plain.registry.find('12'), { threads: [], terms: [] }, '一个声明 find 的 kind 都没有：回空')
  assert.equal(registry.repliesTo(trigger('alpha')), 'replies-trg-1')
  assert.equal(registry.repliesTo(trigger('gamma')), undefined, '没声明 repliesTo 的 kind 不猜')
  passed += 1
})

// ── 6. 线程上下文 ───────────────────────────────────────────────────────────

test('threadContext：没有实现就 undefined；有就带上实例配置与 commands；没有图片能力时抛错', async () => {
  const { registry } = setup({ sources: { alpha: { config: { label: 'ctx' } } } })
  registry.register(kindOf('beta'))
  assert.equal(registry.threadContext(trigger('beta')), undefined, '没有 threadContext 的 kind 读不到上下文')
  assert.equal(registry.threadContext(trigger('ghost')), undefined, '没装的 kind 也一样')
  let seen = null
  registry.register(kindOf('alpha', { threadContext: {
    messageId: (item) => `m-${item.id}`,
    read: async (executor, item, part, cursor, config) => {
      seen = { commands: executor, trigger: item, part, cursor, config }
      return { messages: [], body: {} }
    },
  } }))
  const context = registry.threadContext(trigger('alpha'))
  assert.equal(context.messageId, 'm-trg-1')
  assert.deepEqual(await context.read(commands, 'thread', 'cursor-2'), { messages: [], body: {} })
  assert.equal(seen.commands, commands)
  assert.equal(seen.trigger.id, 'trg-1')
  assert.equal(seen.part, 'thread')
  assert.equal(seen.cursor, 'cursor-2')
  assert.deepEqual(seen.config, { label: 'ctx', count: 1 }, 'kind 的 read 拿到解析后的实例配置')
  assert.deepEqual(context.images('no image keys'), [], '没实现 images：回空数组')
  await assert.rejects(context.image({}, commands, { id: 'm', text: '' }, 'img_1', '/tmp', new AbortController().signal), /has no images/)
  passed += 1
})

// ── 7. 接收范围（引擎的 SourceScope）────────────────────────────────────────

test('scope：没装 / 停用 / kind 自己的判定 / 没有 scope 的 kind', () => {
  const { registry } = setup({
    sources: { ghost: { enabled: true }, off: { enabled: false }, alpha: { config: { label: 'lobby' } }, beta: {} },
  })
  registry.register(kindOf('off'))
  registry.register(kindOf('alpha', { scope: (input, config) => ({ listened: true, observed: true, row: `row-${config.label}` }) }))
  registry.register(kindOf('beta'))
  assert.deepEqual(registry.scope({ source: 'ghost', meta: {} }), { listened: false, reason: 'source_not_installed' },
    '设置里配了、插件没装：判「没装」而不是「没配」')
  assert.deepEqual(registry.scope({ source: 'nobody', meta: {} }), { listened: true, observed: false },
    '设置里也没有、kind 也没装：不受影响')
  assert.deepEqual(registry.scope({ source: 'off', meta: {} }), { listened: false, reason: 'source_disabled' })
  assert.deepEqual(registry.scope({ source: 'alpha', meta: {} }), { listened: true, observed: true, row: 'row-lobby' },
    'kind 自己的判定原样透传')
  assert.deepEqual(registry.scope({ source: 'beta', meta: {} }), { listened: true, observed: false },
    '没有 scope 的 kind：听自己产出的全部，一条也不观察')
  passed += 1
})

// ── 8. 执行环境变量 ─────────────────────────────────────────────────────────

test('declarations / environments：只列有 environment 的 kind，停用的不列 environments', () => {
  const { registry } = setup({ sources: { alpha: { enabled: false }, beta: { config: { label: 'b' } } } })
  const alphaVariables = [{ key: 'ALPHA', description: { zh: '甲', en: 'Alpha' } }]
  const betaVariables = [{ key: 'BETA', description: { zh: '乙', en: 'Beta' } }]
  registry.register(kindOf('alpha', { environment: { variables: alphaVariables, values: () => ({ ALPHA: '1' }) } }))
  registry.register(kindOf('beta', { environment: { variables: betaVariables, values: () => ({ BETA: '2' }) } }))
  registry.register(kindOf('gamma'))
  assert.deepEqual(registry.declarations(), [
    { kind: 'alpha', variables: alphaVariables },
    { kind: 'beta', variables: betaVariables },
  ], '停用的 kind 也要声明变量名（工作树里拼命令要用到），只是不取值')
  const environments = registry.environments()
  assert.equal(environments.length, 1, '停用的 alpha 不进去')
  assert.equal(environments[0].kind.kind, 'beta')
  assert.deepEqual(environments[0].config, { label: 'b', count: 1 }, '环境拿到解析后的实例配置')
  passed += 1
})
