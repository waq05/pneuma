/**
 * @pneuma/superagent-webhook 的验收测试：「加第三种来源」到底是不是插件级扩展。
 *
 * 全用的真东西：真 `SourceRegistry`（`sources/registry.js`）、真 `HealthBoard`
 * （`infra/health.js`）、真 `SettingsSchema`（`core/policy.js`）。本包只提供 `webhookKind`，
 * 不改主包一行——如果注册表这条契约哪里接不住一个新 kind，这几条断言会先红。
 *
 * 四条验收：
 *   a) 注册后 `instances()` 多出 `webhook`，配置按 schema 补齐、`enabled` 跟设置走；
 *   b) `fields` 里的 `rows` / `fact` 能过设置契约（`SettingsField` 类型层在
 *      `tests/settings-contract.ts`，由 tsc 检查；这里看运行期投影形状）；
 *   c) `policyPart()` 给出策略段、`policy.rows()` 给出至少一行准入行；
 *   d) 体检格 `webhook` 存在，`send` 打到本地 `node:http` 临时服务且消息体正确。
 * 另外钉住 `channelAllowed` 对停用实例返回 false。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent-webhook/tests/webhook
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { after, test } from 'node:test'

const { SourceRegistry } = await import('../../../../lib/packages/superagent/sources/registry.js')
const { HealthBoard } = await import('../../../../lib/packages/superagent/infra/health.js')
const { SettingsSchema } = await import('../../../../lib/packages/superagent/core/policy.js')
const { WEBHOOK_SOURCE, WebhookConfigSchema, webhookKind } = await import('../../../../lib/packages/superagent-webhook/webhook.js')
const { contractFact, contractRows, settingsFieldOf } = await import('../../../../lib/packages/superagent-webhook/tests/settings-contract.js')
const { apply, inject, name } = await import('../../../../lib/packages/superagent-webhook/index.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 一个 http(s) 地址；只在配置校验里用，不会被真的请求。 */
const NOWHERE = 'http://127.0.0.1:1/hook'

/** 体检项名：与 `kind.health` 的第一项一致。 */
const WEBHOOK_HEALTH = webhookKind.health[0]

/** 造一份真设置：来源配置与策略段都过 `SettingsSchema`。 */
function makeSettings(sources = {}, policySources = {}) {
  return SettingsSchema.parse({ sources, policy: { sources: policySources } })
}

/** 配好一个 webhook 来源：地址、密钥、一条目标、一条策略名单。 */
function enabledSettings(url = NOWHERE) {
  return makeSettings(
    { webhook: { enabled: true, config: { url, secret: 's3cret', targets: [{ name: 'ops', address: 'http://127.0.0.1:1/ops' }] } } },
    { webhook: { allowed: [{ id: 'ops-bot', name: 'Ops bot' }] } },
  )
}

/** 真注册表 + 真健康板子；设置用取值函数给，注册表每次现读。 */
function registryOf(settings) {
  const board = new HealthBoard()
  return { registry: new SourceRegistry(() => settings, board), board }
}

/** 一条出站消息：`channel.address` 带投递地址、密钥与目标名（契约要求发送时从这里取）。 */
function message(channel) {
  return { id: 'msg-1', channel, text: '工单 #1 已完成', kind: 'notice', ticketId: 'ticket-1' }
}

/** 假执行器：webhook 的 channel 不读命令，但它要按契约形参占位。 */
const COMMANDS = { deployment: { repository: 'owner/repo' }, repository: 'owner/repo' }

// ── a) 注册与实例 ───────────────────────────────────────────────────────────

test('注册：instances() 多出 webhook，配置按 schema 补齐，enabled 跟设置走', () => {
  const settings = enabledSettings()
  const { registry } = registryOf(settings)
  // 注册前：设置里配了 webhook，但 kind 还没装 → 孤儿实例，installed=false。
  assert.deepEqual(registry.instances().map(item => [item.kind, item.installed]), [['webhook', false]])
  const off = registry.register(webhookKind)
  const [instance] = registry.instances()
  assert.deepEqual(instance, {
    id: WEBHOOK_SOURCE,
    kind: WEBHOOK_SOURCE,
    enabled: true,
    installed: true,
    config: { url: NOWHERE, secret: 's3cret', pollSeconds: 60, targets: [{ name: 'ops', address: 'http://127.0.0.1:1/ops' }] },
  })
  // 设置里只写了 enabled：schema 的默认值补齐（url 空 = 未配置，不是配置坏了）。
  const bare = registryOf(makeSettings({ webhook: {} }))
  bare.registry.register(webhookKind)
  assert.deepEqual(bare.registry.instance(WEBHOOK_SOURCE).config, { url: '', secret: '', pollSeconds: 60, targets: [] },
    '空配置走 schema 默认值，实例仍启用（否则注册表会在 parse({}) 上抛）')
  assert.throws(() => registry.register(webhookKind), /already registered/, '同名 kind 不许注册两次')
  off()
  assert.equal(registry.kind(WEBHOOK_SOURCE), undefined)
  assert.equal(registry.healthEntries([WEBHOOK_HEALTH]).size, 0, '注销时把体检格还回去')
  passed += 1
})

// ── b) 设置契约：rows / fact ────────────────────────────────────────────────

test('设置契约：rows / fact 两种字段能投影成 SettingsField', () => {
  const rows = webhookKind.fields.find(field => field.type === 'rows')
  assert.ok(rows !== undefined, 'fields 里有 rows 字段')
  assert.deepEqual(rows.columns.map(column => [column.key, column.type]), [['name', 'text'], ['address', 'text']],
    '目标表两列：名字与地址')
  const fact = webhookKind.fields.find(field => field.type === 'fact')
  assert.equal(fact.key, 'delivery', 'fields 里有 fact 字段')
  // 类型层在 tests/settings-contract.ts 由 tsc 检查；这里核对运行期投影形状与契约两个分支一致。
  assert.deepEqual(contractRows, {
    type: 'rows', key: 'targets', label: '通知目标',
    help: '每条记录一个投递目标：名字做标识，地址是 POST 的 http(s) URL。没有记录时用上面的默认地址。',
    columns: [{ key: 'name', label: '名字', type: 'text' }, { key: 'address', label: '地址', type: 'text' }],
  })
  assert.deepEqual(contractFact, { type: 'fact', key: 'delivery', label: '投递方式' })
  // 每个字段都能投影，且 type 落在设置契约的六支里（text / number / select / switch / fact / rows）。
  const tags = new Set(['text', 'number', 'select', 'switch', 'fact', 'rows'])
  for (const field of webhookKind.fields) {
    const projected = settingsFieldOf(field)
    assert.ok(tags.has(projected.type), `${field.key} 投影成设置控件`)
  }
  passed += 1
})

// ── c) 策略段与准入行 ───────────────────────────────────────────────────────

test('策略：policyPart 给出 allowed，rows() 至少一行准入行', () => {
  const settings = enabledSettings()
  const { registry } = registryOf(settings)
  registry.register(webhookKind)
  const part = registry.policyPart(WEBHOOK_SOURCE)
  assert.deepEqual(part, { allowed: [{ id: 'ops-bot', name: 'Ops bot' }], admission: {} },
    '策略段用 kind 自己的 schema 解析，admission 由共享表补空')
  // validatePolicy 走同一条 kind 自己的 schema；多余的键会被拒。
  assert.deepEqual(registry.validatePolicy({ webhook: { allowed: [{ id: 'ops-bot' }] } }).webhook.allowed, [{ id: 'ops-bot' }])
  assert.throws(() => registry.validatePolicy({ webhook: { allowed: [{ id: 'ops-bot', unknown: 1 }] } }))
  // rows(config) 拿的是来源配置（`app/views/settings.ts:26-28` 就是这么调的），产出准入行。
  const rows = webhookKind.policy.rows(settings.sources[WEBHOOK_SOURCE].config)
  assert.ok(rows.length >= 1, 'rows() 至少一行')
  assert.deepEqual(rows.map(row => row.id), ['ops'], '每个目标一行，id 用目标名')
  assert.deepEqual(Object.keys(rows[0].cells), ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed'],
    '准入行三格齐全（本来源全 false：从不接收消息）')
  assert.deepEqual(webhookKind.policy.rows(WebhookConfigSchema.parse({})).map(row => row.id), ['outbound'],
    '没有配置目标时也有一行兜底说明')
  passed += 1
})

// ── d) 体检格与出站发送 ─────────────────────────────────────────────────────

test('体检与范围：注册表替它领 webhook 格，scope 只发不收', () => {
  const { registry, board } = registryOf(enabledSettings())
  registry.register(webhookKind)
  assert.deepEqual([...registry.healthEntries([WEBHOOK_HEALTH, 'feishu']).keys()], [WEBHOOK_HEALTH],
    '只取到自己声明的格子，同名别的来源不会混进来')
  assert.equal(board.all[WEBHOOK_HEALTH].state, 'starting', '注册时注册表按 starting 占格')
  // 来源上下文写的格子与板子是同一格（插件轮询走的就是这条路）。
  registry.healthEntries([WEBHOOK_HEALTH]).get(WEBHOOK_HEALTH).set({ state: 'ready', detail: 'Outbound only; 1 target(s)' })
  assert.equal(board.all[WEBHOOK_HEALTH].state, 'ready')
  assert.deepEqual(registry.scope({ source: WEBHOOK_SOURCE, meta: {} }), { listened: true, observed: false },
    '只发不收：听自己产出的全部、一条也不观察')
  passed += 1
})

test('出站：send POST 到本地 http 服务，消息体与密钥头正确；停用实例不许回话', async () => {
  const settings = enabledSettings()
  const { registry } = registryOf(settings)
  registry.register(webhookKind)
  /** 收到的请求：路由 /notify 记下来，/gone 回 410，/fail 回 500。 */
  const received = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      if (request.url === '/gone') { response.writeHead(410, { 'content-type': 'application/json' }); response.end('{}'); return }
      if (request.url === '/fail') { response.writeHead(500, { 'content-type': 'application/json' }); response.end('{}'); return }
      received.push({ method: request.method, headers: request.headers, body: JSON.parse(body) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  const channel = { source: WEBHOOK_SOURCE, thread: 'webhook:ops', address: { url: `http://127.0.0.1:${String(port)}/notify`, secret: 's3cret', target: 'ops' } }
  try {
    assert.equal(await registry.send(message(channel), COMMANDS), 'sent', '2xx 算送达')
    assert.equal(received.length, 1)
    assert.equal(received[0].method, 'POST')
    assert.equal(received[0].headers['content-type'], 'application/json')
    assert.equal(received[0].headers['x-webhook-secret'], 's3cret', '地址里的 secret 进请求头')
    assert.deepEqual(received[0].body, {
      source: WEBHOOK_SOURCE, id: 'msg-1', kind: 'notice', text: '工单 #1 已完成', ticketId: 'ticket-1', target: 'ops',
    }, '消息体：来源、ID、种类、正文、工单与目标')
    // 404 / 410 = 目标已经不要这类消息，返回 gone 而不是抛（出站队列据此丢弃）。
    assert.equal(await registry.send(message({ ...channel, address: { url: `http://127.0.0.1:${String(port)}/gone` } }), COMMANDS), 'gone')
    // 其余非 2xx 是可重试的投递失败：抛给出站队列。
    await assert.rejects(registry.send(message({ ...channel, address: { url: `http://127.0.0.1:${String(port)}/fail` } }), COMMANDS), /HTTP 500/)
    await assert.rejects(registry.send(message({ ...channel, address: { url: 'ftp://nope' } }), COMMANDS), /not an http\(s\) URL/)
    // 通道检查：配好地址才许回话；实例停用一律 false（注册表先拦）。
    assert.equal(registry.channelAllowed(channel), true)
    assert.equal(registry.channelAllowed(channel, makeSettings({ webhook: { enabled: false, config: settings.sources[WEBHOOK_SOURCE].config } })), false,
      '停用的实例不许回话')
    assert.equal(registry.channelAllowed({ ...channel, address: { url: 'ftp://nope' } }), false, '非 http(s) 地址不许回话')
    assert.equal(registry.channelAllowed({ ...channel, source: 'nobody' }), false, '没装的 kind 一律不许')
  } finally {
    server.close()
    await once(server, 'close')
  }
  passed += 1
})

// ── 插件入口：name / inject / apply 的起停 ───────────────────────────────────

/**
 * 假 cordis 上下文：只实现 apply 用到的那几样（`get` / `logger.warn` / `effect`），
 * effect 立即执行回调并收下返回的清理函数，这样能真的看到「注册了什么、报了什么」。
 */
function fakeContext(config) {
  const effects = []
  const reports = []
  const registered = []
  const unregistered = []
  const host = {
    sources: { register: kind => { registered.push(kind.kind); return () => unregistered.push(kind.kind) } },
    context: kind => ({ config: () => config, report: (entry, health) => reports.push([kind.kind, entry, health.state]) }),
  }
  const ctx = {
    get: service => service === 'orchestrator' ? host : undefined,
    logger: { warn: () => {} },
    effect: (run, label) => { effects.push({ label, dispose: run() }) },
  }
  return { ctx, effects, reports, registered, unregistered }
}

test('插件入口：inject orchestrator，apply 注册 kind 并无泄漏地起停体检轮询', () => {
  assert.equal(name, 'superagent-webhook')
  assert.deepEqual(inject, ['orchestrator'], '只依赖来源宿主这一个服务')
  // 配好地址：apply 里第一轮就报 ready（间隔 5 秒的定时器被 unref，不会拖住进程退出）。
  const ready = fakeContext({ url: NOWHERE, secret: '', pollSeconds: 5, targets: [{ name: 'ops', address: 'http://127.0.0.1:1/ops' }] })
  apply(ready.ctx)
  assert.deepEqual(ready.registered, [WEBHOOK_SOURCE], 'apply 把 webhook kind 登记进注册表')
  assert.deepEqual(ready.reports, [[WEBHOOK_SOURCE, WEBHOOK_SOURCE, 'ready']], '第一轮体检报告 ready')
  assert.deepEqual(ready.effects.map(effect => effect.label), ['superagent-webhook: sources.register', 'superagent-webhook: health.poll'])
  for (const effect of [...ready.effects].reverse()) effect.dispose()
  assert.deepEqual(ready.unregistered, [WEBHOOK_SOURCE], '停用插件时注销 kind、把体检格还回去')
  // 没配置地址：报 paused，不假装已就绪。
  const waiting = fakeContext({ url: '', secret: '', pollSeconds: 5, targets: [] })
  apply(waiting.ctx)
  assert.deepEqual(waiting.reports, [[WEBHOOK_SOURCE, WEBHOOK_SOURCE, 'paused']])
  for (const effect of waiting.effects) effect.dispose()
  passed += 1
})
