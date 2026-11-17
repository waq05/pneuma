/**
 * 上游 `tests/tools.spec.ts` 的转写：主会话与执行者工具的工具名、参数 schema、拒绝文案、判定顺序与结果渲染。
 *
 * 上游那份规格起的是整套运行期（`startRuntime`：真 Engine、真 Store、真 cordis 会话），18 条 it() 里只有下面
 * 这几类能脱离 DSH / cordis 单独钉住，其余按任务约定跳过并写明理由（见文件末尾「跳过的上游用例」）：
 *   - 工具注册出来的名字、顺序、风险分级、参数 JSON schema；
 *   - `orchestrator_route` 的一批判定：每条怎么被拒、为什么那样拒、一条被拒连不累同批其他条、
 *     批内先 accept 后 ignore 的冲突、重复 accept 的「已接受」回话；
 *   - 四个 kind 映射到引擎调用与回话形状（含 ticket 卡渲染）；
 *   - 设置 / 提示词 / 回执 / 状态 / 重排 / 回复 / 退订 / 模型清单同步这些工具的判定顺序与文案；
 *   - 执行者六个工具的回执、报告、线程跟踪、交回；
 *   - `tool.ts` 的两个共享 schema（回执词数、read 工具默认 offset）。
 *
 * 假件只实现被测函数真用到的成员（宿主端口、engine、store 都是对象字面量），不建真运行期、不碰 `~/.dsc`。
 * 本仓原生适配：上游把 `Tool` 注册进 DSH 的 per-agent 工具表，本仓出口是 `ToolEntry[]`（`entryOf` 多做的
 * `z.toJSONSchema` / `risk` / 返回串成 JSON 文本三步）。所以这里断言的是 `ToolEntry` 形状，`run` 的返回值按
 * JSON 文本解析；风险分级是本仓新增位，按实现注释「纯读的四个标 read，其余按会改库 / 发消息标 write」断言。
 *
 * 跳过的上游用例（逐条理由）：
 *   - "reads the lists, a ticket, a decision, the settings, the prompts and the models as resources"：要真 Store
 *     与运行期，资源读口由 `main-tools.test.mjs` / `resources` 层覆盖；
 *   - "lists in prompts the built-in parts whose text changed..."：要 `Prompts` 运行期状态；
 *   - "keeps the main Session's resources from an Executor Session..."：会话隔离要真 `Sessions`，这里只转写了
 *     执行者 read 工具的资源清单（描述里只出现 `executor: true` 的资源名）；
 *   - "stops one follow-up for each ticket it reached"：要 `Engine.bindThread` 与真工单流转；
 *   - "ignores a proactive candidate from its card..."：要真 Eval 与卡片投递；
 *   - "returns where a reply stands: sent, or dropped..."：dropped 分支要 mock 飞书 CLI（`Commands.lark`）；
 *   - "releases the tools it registered for a Session once its agent is disposed"：本仓没有 per-agent 工具表这一层；
 *   - "reads a thread / a ticket / a trigger with the ids..."：要真 Store 与资源分页，归资源层测试；
 *   - "shows a candidate with its thread's tickets..." / "tells the main Session of the settings..."：
 *     要真 Engine 候选、真 Effects 队列；
 *   - "shows an Executor Session no id it cannot read" / "marks the threads a worker follows..." /
 *     "gives a worker the other messages..."：要真运行期与 Eval 批次。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/tools
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { mainTools } = await import('../../../../lib/packages/superagent/app/tools/main.js')
const { executorTools } = await import('../../../../lib/packages/superagent/app/tools/executor.js')
const { toolEntries } = await import('../../../../lib/packages/superagent/app/sessions.js')
const { tool, readTool, AcknowledgementSchema } = await import('../../../../lib/packages/superagent/app/tools/tool.js')
const { defaultPrompts } = await import('../../../../lib/packages/superagent/app/prompts.js')
const { RESOURCES } = await import('../../../../lib/packages/superagent/app/resources.js')
const { SettingsSchema } = await import('../../../../lib/packages/superagent/core/policy.js')
const { UserError } = await import('../../../../lib/packages/superagent/core/index.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

/** 记一条通过的 `assert.ok`。 */
function ok(value, message) {
  assert.ok(value, message)
  passed += 1
}

/** 严格相等（标量 / 引用）。 */
function equal(actual, expected, message) {
  assert.equal(actual, expected, message)
  passed += 1
}

/** 深比较（对象 / 数组）。 */
function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  passed += 1
}

/** 文本匹配（拒绝文案、描述里的上限短语）。 */
function match(text, pattern, message) {
  assert.match(text, pattern, message)
  passed += 1
}

/** 异步拒绝：工具都是 async 的。 */
async function rejects(promise, pattern, message) {
  await assert.rejects(promise, pattern, message)
  passed += 1
}

/** 固定时钟：回话里的 `at` 不依赖当前时间。 */
const AT = '2026-01-01T00:00:00.000Z'
/** 假工单 id；route 的 accept / attach 回话会渲染成 ticket 卡。 */
const TICKET_A = 'ticket-a'
/** 主会话 id：提示词预览资源按它隔离。 */
const AGENT = { id: 'master-session', role: 'orchestrator' }

/** 一条工具调用上下文：`ToolEntry.run` 只读 `signal`。 */
const ctxOf = () => ({ cwd: '.', sessionId: AGENT.id, sessionPath: '', signal: new AbortController().signal })

/** 造一张能让 `ticketCard` 渲染的最小工单。 */
function fakeTicket(id = TICKET_A, over = {}) {
  return {
    id, title: 'Fix typo', decisionId: 'decision-1',
    mandate: { strength: 'explicit', scope: 'Fix typo', actor: { source: 'feishu', id: 'bob' } },
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: AT, updatedAt: AT,
    origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }, ...over,
  }
}

/** 由一次引擎判定结论造一张 Decision（`fromDecision` 只读 kind / reason / ticketId / triggerIds）。 */
function decisionOf(triggerId, outcome, over = {}) {
  const reason = typeof outcome.reason === 'string' ? [{ code: 'said', values: { text: outcome.reason } }] : [outcome.reason]
  const base = { id: `decision-${triggerId}`, kind: outcome.kind, reason, triggerIds: [triggerId], strength: 'explicit',
    threadKey: 'feishu:om_1', at: AT, ...over }
  if (outcome.kind === 'accept') return { ...base, ticketId: TICKET_A }
  if (outcome.kind === 'stop') return { ...base, ticketId: outcome.ticketId }
  return base
}

/** 主会话宿主假件：只实现 `MainToolsHost` 里被测工具会碰的成员，并记下每次端口调用。 */
function mainHost(options = {}) {
  const calls = { decide: [], attach: [], reply: [], requestStatus: [], note: [], retryTicket: [], reevaluate: [], unsubscribe: [],
    pass: 0, sendReplies: 0, warn: [], notify: [], settingsSave: [], pause: [], synced: [] }
  const tickets = new Map([[TICKET_A, fakeTicket()]])
  const triggers = new Map()
  const host = {
    context: { logger: { warn: (...args) => calls.warn.push(args) } },
    engine: {
      decide(triggerId, outcome) {
        calls.decide.push([triggerId, outcome])
        if (options.decide) return options.decide(triggerId, outcome)
        return decisionOf(triggerId, outcome)
      },
      attach(ticketId, triggerId, note) {
        calls.attach.push([ticketId, triggerId, note])
        if (options.attach) return options.attach(ticketId, triggerId, note)
        return tickets.get(ticketId) ?? fakeTicket(ticketId)
      },
      reply(message) { calls.reply.push(message); return options.reply ?? { id: 'reply-1', status: 'sent', reused: false } },
      requestStatus(id) { calls.requestStatus.push(id); return options.requestStatus ?? true },
      note(id, text) { calls.note.push([id, text]) },
      retryTicket(id) { calls.retryTicket.push(id); return tickets.get(id) ?? fakeTicket(id) },
      reevaluate(id) { calls.reevaluate.push(id); return options.reevaluate ?? true },
      unsubscribe(thread) { calls.unsubscribe.push(thread); return options.unsubscribe ?? true },
    },
    store: {
      tickets: { get: id => tickets.get(id) },
      triggers: { get: id => triggers.get(id), disposition: id => options.disposition ? options.disposition(id) : undefined },
      threads: { get: () => undefined },
      atomic: work => work(),
      replyStatus: () => options.replyStatus ?? 'sent',
      settings: () => options.settings ?? SettingsSchema.parse({}),
    },
    prompts: { preview: () => ({ scope: 'Scope', orchestrator: 'orchestrator prompt', worker: 'worker prompt' }), save: async () => ({ revision: 1 }) },
    sessions: { status: () => 'idle', notify: (...args) => calls.notify.push(args), delivery: {}, modelRetry: {} },
    settings: {
      view: () => ({}),
      block: () => ({}),
      save: async (block, value, revision, origin) => {
        calls.settingsSave.push([block, value, revision, origin])
        return { block, revision: revision + 1, context_delivery: ['panel'] }
      },
      pause: async (paused, origin) => { calls.pause.push([paused, origin]); return { paused } },
      sync: async (source) => { calls.synced.push(source); return { allowed: options.synced ?? [] } },
    },
    assessor: {
      context: async triggerId => ({ trigger_id: triggerId }),
      read: async (agent, read) => {
        calls.assessor = ['read', read]
        return { text: 'read body' }
      },
      decide: async (triggerId, result) => {
        calls.assessor = ['decide', triggerId, result]
        return options.assessorDecision ?? { state: 'accept', ticket_id: TICKET_A, reason: 'Explicit request from an allowed sender routed by the orchestrator' }
      },
    },
    resources: { pages: new Map() },
    requestPass() { calls.pass += 1 },
    sendReplies: async () => { calls.sendReplies += 1 },
    quietly(run) { return run() },
  }
  return { host, calls, tickets, triggers }
}

/** 造主会话工具表：按名字索引，`run` 统一把 JSON 文本解析回对象。 */
function mainToolsOf(options = {}) {
  const { host, calls, tickets, triggers } = mainHost(options)
  const entries = toolEntries('orchestrator', mainTools(host, AGENT))
  const tools = Object.fromEntries(entries.map(entry => [entry.name, entry]))
  const run = async (name, args) => JSON.parse(await tools[name].run(args, ctxOf()))
  return { tools, entries, calls, tickets, triggers, run, host }
}

/** 执行者宿主假件：只实现 `executorTools` 用的成员。 */
function executorHost(options = {}) {
  const calls = { report: [], reply: [], handback: [], followForContext: [], markUnrelated: [], relay: [], notify: [], sendReplies: 0 }
  const ticket = options.ticket ?? fakeTicket()
  const host = {
    engine: {
      report(id, report) {
        calls.report.push([id, report])
        if (options.report) return options.report(id, report)
        return { ...ticket, ...report.question ? { attention: { id: 'attention-1', question: report.question } } : {} }
      },
      reply(message) { calls.reply.push(message); return options.reply ?? { id: 'reply-1', status: 'sent', reused: false } },
      markUnrelated(id, thread, reason) { calls.markUnrelated.push([id, thread, reason]) },
      handback(id, triggerId, reason) { calls.handback.push([id, triggerId, reason]); return options.handback ?? true },
      followForContext(id, ref) { calls.followForContext.push([id, ref]); return options.followed ?? true },
    },
    store: { tickets: { get: () => options.stored ?? ticket }, replyStatus: () => options.replyStatus ?? 'sent',
      atomic: work => work() },
    sessions: { relay: (id, text) => calls.relay.push([id, text]), notify: (...args) => calls.notify.push(args) },
    resources: { pages: new Map() },
    github: { deployment: { github: { login: 'agent-bot' } } },
    sendReplies: async () => { calls.sendReplies += 1 },
  }
  const entries = toolEntries('worker', executorTools(host, ticket))
  const tools = Object.fromEntries(entries.map(entry => [entry.name, entry]))
  const run = async (name, args) => JSON.parse(await tools[name].run(args, ctxOf()))
  return { host, entries, tools, run, calls, ticket }
}

/** `words(n)`：造恰好 n 个词的文本，用来踩词数上限。 */
const words = count => Array.from({ length: count }, () => 'word').join(' ')

// ── 主会话工具 ───────────────────────────────────────────────────────────────

test('主会话 14 个工具：名字、顺序、风险分级与严格参数 schema', () => {
  const { tools, entries } = mainToolsOf()
  deepEqual(entries.map(entry => entry.name), ['orchestrator_read', 'orchestrator_route', 'orchestrator_ticket_retry',
    'orchestrator_ticket_request_status', 'orchestrator_ticket_note', 'orchestrator_trigger_requeue', 'orchestrator_eval',
    'orchestrator_eval_read', 'orchestrator_eval_decide', 'orchestrator_reply', 'orchestrator_thread_unsubscribe',
    'orchestrator_settings_save', 'orchestrator_policy_sync', 'orchestrator_prompts_save'])
  // 本仓原生适配：上游 DSH 没有 risk，本仓纯读的四个标 read，其余标 write。
  deepEqual(entries.filter(entry => entry.risk === 'read').map(entry => entry.name),
    ['orchestrator_read', 'orchestrator_ticket_request_status', 'orchestrator_eval', 'orchestrator_eval_read'])
  // 参数 schema 由 `z.toJSONSchema` 出：严格对象，多余键拒绝。
  const params = tools.orchestrator_read.parameters
  equal(params.type, 'object')
  equal(params.additionalProperties, false)
  ok(params.required.includes('resource'))
  equal(params.properties.offset.default, 0)
  equal(params.properties.limit.maximum, 8000)
})

test('执行者 read 工具只列本工单能读的资源，且六个工具都标 read', () => {
  const { entries, tools } = executorHost()
  deepEqual(entries.map(entry => entry.name), ['orchestrator_read', 'orchestrator_ack', 'orchestrator_thread_unrelated',
    'orchestrator_thread_follow', 'orchestrator_trigger_handback', 'orchestrator_report'])
  equal(entries.every(entry => entry.risk === 'read'), true)
  const read = tools.orchestrator_read
  const offered = read.description + read.parameters.properties.resource.description
  // 上游断言：清单里每个资源名是否出现，恰好等于它有没有 executor 标记。
  deepEqual(RESOURCES.filter(resource => offered.includes(`${resource.name}:`) !== !!resource.executor).map(resource => resource.name), [])
  ok(!/preview/i.test(offered))
})

test('route 每个字段的 description 写明上限与约束（上游逐字）', () => {
  const { tools } = mainToolsOf()
  const fields = tools.orchestrator_route.parameters.properties.decisions.items.properties
  const limits = {
    title: ['200 characters'],
    worktree_name: ['kebab-case', '32 characters'],
    acknowledgement: ['100 words'],
    note: ['30 words', 'Never add implementation instructions'],
    reason: ['500 characters'],
  }
  for (const [field, phrases] of Object.entries(limits)) {
    for (const phrase of phrases) match(fields[field].description, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), field)
  }
  deepEqual(fields.kind.enum, ['accept', 'attach', 'ignore', 'stop'])
})

test('route 一条缺字段或越界只拒这一条，并点名那个字段；别的 kind 的字段不读', async () => {
  const { tools, calls, run } = mainToolsOf()
  const result = await run('orchestrator_route', { decisions: [
    { kind: 'accept', trigger_id: 'a', title: 'Fix', acknowledgement: '收到。' },
    { kind: 'accept', trigger_id: 'b', title: 'Fix', worktree_name: 'one-two-three-four-five', acknowledgement: '收到。' },
    { kind: 'accept', trigger_id: 'c', title: 'Fix', worktree_name: 'fix-c', acknowledgement: '收到。', note: words(31) },
    { kind: 'accept', trigger_id: 'd', title: '', worktree_name: 'fix-d', acknowledgement: '收到。' },
    { kind: 'ignore', trigger_id: 'e', reason: 'chat', ticket_id: null, title: null, note: null },
  ] })
  deepEqual(result.results[0], { trigger_id: 'a', kind: 'accept', refused: 'accept needs worktree_name' })
  match(result.results[1].refused, /^worktree_name: Use 1–4 short English words/)
  match(result.results[2].refused, /^note: Routing note must not exceed 30 words/)
  deepEqual(result.results[3], { trigger_id: 'd', kind: 'accept', refused: 'accept needs title' })
  // 第五条是 ignore：ticket_id / title / note 都为 null 也不读，照常判。
  deepEqual(result.results[4], { trigger_id: 'e', kind: 'ignore', decision: 'ignore', reason: 'chat' })
  // 只有第五条真跑到了引擎，前四条一个端口都没调。
  equal(calls.decide.length, 1)
  equal(calls.decide[0][0], 'e')
})

test('route 按顺序执行：一条被引擎拒（UserError）或意外失败，不影响同批其他条', async () => {
  const { tools, calls, run } = mainToolsOf({
    attach: (ticketId, triggerId) => {
      if (triggerId === 'more') throw new Error('database is locked')
      if (ticketId === 'no-such-ticket') throw new UserError('unknownTicket')
      return fakeTicket(ticketId)
    },
  })
  const result = await run('orchestrator_route', { decisions: [
    { kind: 'ignore', trigger_id: 'thanks', reason: 'Thanks only.' },
    { kind: 'stop', trigger_id: 'request' },
    { kind: 'accept', trigger_id: 'request', title: 'Other', worktree_name: 'fix-other', acknowledgement: '收到。' },
    { kind: 'attach', trigger_id: 'other', ticket_id: 'no-such-ticket' },
    { kind: 'attach', trigger_id: 'more', ticket_id: TICKET_A },
  ] })
  const results = result.results
  deepEqual(results[0], { trigger_id: 'thanks', kind: 'ignore', decision: 'ignore', reason: 'Thanks only.' })
  deepEqual(results[1], { trigger_id: 'request', kind: 'stop', refused: 'stop needs ticket_id' })
  equal(results[2].decision, 'accept')
  equal(results[2].ticket.ticket_id, TICKET_A)
  deepEqual(results[3], { trigger_id: 'other', kind: 'attach', refused: 'Unknown ticket' })
  deepEqual(results[4], { trigger_id: 'more', kind: 'attach', refused: 'Not recorded: database is locked; retry this item' })
  // 意外失败要留一条 warn 日志，UserError 不用。
  equal(calls.warn.length, 1)
  equal(calls.warn[0][1], 'more')
})

test('route 一条决定了一个 trigger 的整批：同批再 ignore 它被拒，再 accept 说「已接受」', async () => {
  const { tools, run } = mainToolsOf({
    // 第一条 accept 的决定覆盖整批；第二条 accept 撞上同一条 Decision，返回「已接受」。
    decide: (triggerId, outcome) => triggerId === 'first'
      ? decisionOf(triggerId, outcome, { triggerIds: ['first', 'second'] })
      : decisionOf(triggerId, outcome, { id: 'decision-first' }),
    disposition: triggerId => triggerId === 'second' ? { decisionId: 'decision-first' } : undefined,
  })
  const result = await run('orchestrator_route', { decisions: [
    { kind: 'accept', trigger_id: 'first', title: 'Retitle', worktree_name: 'retitle', acknowledgement: '收到。' },
    { kind: 'accept', trigger_id: 'second', title: 'Another', worktree_name: 'fix-other', acknowledgement: '收到。' },
    { kind: 'ignore', trigger_id: 'second', reason: 'chat' },
  ] })
  const results = result.results
  equal(results[0].decision, 'accept')
  equal(results[1].decision, 'accept')
  equal(results[1].reason, `Already accepted as ${TICKET_A}; title and acknowledgement unchanged`)
  deepEqual(results[2], { trigger_id: 'second', kind: 'ignore', refused: 'Decided in this call with first, whose Decision took its batch' })
})

test('route 四个 kind 各自映射到引擎调用并渲染回话（含 ticket 卡）', async () => {
  const { tools, calls, run } = mainToolsOf()
  const result = await run('orchestrator_route', { decisions: [
    { kind: 'accept', trigger_id: 'a', title: 'Fix', worktree_name: 'fix-typo', acknowledgement: '收到。', note: 'Copy fix.' },
    { kind: 'attach', trigger_id: 'b', ticket_id: TICKET_A, note: 'Same ticket.' },
    { kind: 'stop', trigger_id: 'c', ticket_id: TICKET_A, reason: 'Not needed after all' },
    { kind: 'ignore', trigger_id: 'd', reason: 'Thanks only.' },
  ] })
  const results = result.results
  equal(results[0].decision, 'accept')
  equal(results[0].reason, 'Explicit request from an allowed sender routed by the orchestrator')
  deepEqual(results[0].ticket, { ticket_id: TICKET_A, title: 'Fix typo', state: 'working/queued', strength: 'explicit', preview: '',
    read: `ticket/${TICKET_A}` })
  equal(results[1].reason, 'Attached: the ticket follows the trigger\'s thread and receives the trigger')
  deepEqual(calls.attach, [[TICKET_A, 'b', 'Same ticket.']])
  equal(results[2].decision, 'stop')
  equal(results[2].reason, 'Not needed after all')
  equal(results[3].decision, 'ignore')
  equal(results[3].reason, 'Thanks only.')
  // accept 带 note、stop 的 reason 都进了引擎判定；ignore 的 reason 是字符串。
  deepEqual(calls.decide.map(([, outcome]) => [outcome.kind, outcome.reason]), [
    ['accept', { code: 'explicitRouted' }],
    ['stop', 'Not needed after all'],
    ['ignore', 'Thanks only.'],
  ])
  equal(calls.pass, 1)
})

test('settings_save：block=source 必须点名 Source；pause 走 pause；返回值剥掉 context_delivery', async () => {
  const { tools, calls, run } = mainToolsOf()
  await rejects(run('orchestrator_settings_save', { block: 'source', value: { enabled: false, config: {} }, revision: 0 }),
    /source names the Source instance, with block source only/)
  const saved = await run('orchestrator_settings_save', { block: 'eval', value: { mode: 'auto' }, revision: 3 })
  deepEqual(saved, { block: 'eval', revision: 4 })
  deepEqual(calls.settingsSave, [['eval', { mode: 'auto' }, 3, 'tool']])
  const bySource = await run('orchestrator_settings_save', { block: 'source', source: 'github', value: { enabled: false, config: {} }, revision: 1 })
  equal(bySource.block, 'source:github')
  deepEqual(JSON.parse(await tools.orchestrator_settings_save.run({ block: 'pause', value: { paused: true }, revision: 0 }, ctxOf())), { paused: true })
  deepEqual(calls.pause, [[true, 'tool']])
})

test('prompts_save：preview 两个角色各出一个可读资源，缺 baseRevision 时拒绝保存', async () => {
  const { tools, host, run } = mainToolsOf()
  const preview = await run('orchestrator_prompts_save', { config: defaultPrompts(), preview: true })
  deepEqual(preview.previews.map(item => item.role), ['orchestrator', 'worker'])
  equal(preview.previews[0].chars, 'orchestrator prompt'.length)
  equal(host.resources.pages.size, 2)
  ok([...host.resources.pages.keys()].every(key => key.startsWith(`${AGENT.id}:prompt-preview/`)))
  await rejects(run('orchestrator_prompts_save', { config: defaultPrompts() }), /Saving needs baseRevision/)
})

test('状态、留言、重排、回复、退订：各自判定与回话', async () => {
  const { tools, calls, run, triggers } = mainToolsOf({ requestStatus: false, replyStatus: 'dropped' })
  const status = await run('orchestrator_ticket_request_status', { ticket_id: TICKET_A })
  equal(status.reason, 'The worker is not waiting; nothing was sent')
  equal(status.ticket.ticket_id, TICKET_A)
  const requestedTrue = mainToolsOf()
  equal((await requestedTrue.run('orchestrator_ticket_request_status', { ticket_id: TICKET_A })).reason, 'Asked the worker for a status report')
  await rejects(run('orchestrator_ticket_note', { ticket_id: TICKET_A, text: words(101) }), /At most 100 words/)
  const noted = await run('orchestrator_ticket_note', { ticket_id: TICKET_A, text: 'From another ticket.' })
  equal(noted.reason, 'Noted for the worker')
  deepEqual(calls.note, [[TICKET_A, 'From another ticket.']])
  // 归属某张工单的 follow-up：主会话不能重排，报出接手它的工单。
  triggers.set('owned', { id: 'owned', human: true, threads: [{ source: 'feishu', id: 'om_1' }] })
  const ownedHost = mainToolsOf({ disposition: () => ({ fanout: [TICKET_A] }) })
  ownedHost.triggers.set('owned', { id: 'owned', human: true, threads: [{ source: 'feishu', id: 'om_1' }] })
  await rejects(ownedHost.run('orchestrator_trigger_requeue', { trigger_id: 'owned' }), /This message reached ticket ticket-a/)
  equal(ownedHost.calls.reevaluate.length, 0)
  deepEqual(await run('orchestrator_trigger_requeue', { trigger_id: 'nowhere' }), { queued: true })
  deepEqual(calls.reevaluate, ['nowhere'])
  // request_status、note、requeue 都排一拍 pass。
  equal(calls.pass, 3)
  const replied = await run('orchestrator_reply', { ticket_id: TICKET_A, purpose: 'result', text: 'Done.' })
  deepEqual(replied, { status: 'dropped' })
  deepEqual(calls.reply, [{ purpose: 'result', text: 'Done.', ticketId: TICKET_A }])
  const unsubscribed = await run('orchestrator_thread_unsubscribe', { thread: 'github:123' })
  deepEqual(unsubscribed, { removed: true, thread: 'github:123' })
  deepEqual(calls.unsubscribe, ['github:123'])
  equal(calls.sendReplies, 1)
})

test('policy_sync 只回报数量与增删的名字，不吐整张名单', async () => {
  const { run } = mainToolsOf({
    settings: SettingsSchema.parse({ policy: { sources: { github: { allowed: [{ id: 'ou_a', name: 'Alice' }] } } } }),
    synced: [{ id: 'ou_a', name: 'Alice' }, { id: 'ou_b', name: 'Bob' }],
  })
  deepEqual(await run('orchestrator_policy_sync', { source: 'github' }), { source: 'github', allowed: 2, added: ['Bob'], removed: [] })
})

test('判定三工具：eval 取上下文、eval_read 透传参数、eval_decide 记录并回路由结果', async () => {
  const { tools, calls, run } = mainToolsOf()
  deepEqual(await run('orchestrator_eval', { trigger_id: 'trigger-1' }), { trigger_id: 'trigger-1' })
  deepEqual(await run('orchestrator_eval_read', { trigger_id: 'trigger-1', resource: 'thread' }), { text: 'read body' })
  equal(calls.assessor[1].offset, 0)
  await rejects(run('orchestrator_eval_read', { trigger_id: 'trigger-1', resource: 'file' }),
    /path is required only for file\/directory/)
  const direction = { implementation_requested: false, target_basis: 'undetermined', requires_design_decision: false, evidence: 'chatter' }
  const decided = await run('orchestrator_eval_decide', { trigger_id: 'trigger-1', decision: 'ignore', rule_assessments: [],
    direction, title: 't', scope: 's', reason: 'r' })
  equal(decided.decision, 'accept')
  equal(decided.reason, 'Explicit request from an allowed sender routed by the orchestrator')
  equal(decided.ticket.ticket_id, TICKET_A)
  equal(calls.assessor[0], 'decide')
  equal(calls.assessor[1], 'trigger-1')
  // 越权 / 多余字段由参数 schema 拦住。
  await rejects(run('orchestrator_eval_decide', { trigger_id: 'trigger-1', decision: 'ignore', rule_assessments: [], direction,
    title: 't', scope: 's', reason: 'r', ticket_id: 'extra' }), /unrecognized keys|Unrecognized key/)
  await rejects(run('orchestrator_eval_decide', { trigger_id: 'trigger-1', rule_assessments: [], direction, title: 't', scope: 's', reason: 'r' }),
    /decision/)
})

// ── 执行者工具 ───────────────────────────────────────────────────────────────

test('ack：回执经引擎排队，返回回复状态与 reused；命令未出账时补发', async () => {
  const sent = executorHost()
  deepEqual(await sent.run('orchestrator_ack', { trigger_id: 'trigger-1', text: '收到' }),
    { trigger_id: 'trigger-1', acknowledgement: 'sent', reused: false })
  deepEqual(sent.calls.reply, [{ purpose: 'acknowledgement', ticketId: TICKET_A, triggerId: 'trigger-1', text: '收到' }])
  equal(sent.calls.sendReplies, 0)
  const pending = executorHost({ reply: { id: 'reply-1', status: 'pending', reused: false }, replyStatus: 'pending' })
  deepEqual(await pending.run('orchestrator_ack', { trigger_id: 'trigger-1', text: '收到' }),
    { trigger_id: 'trigger-1', acknowledgement: 'pending', reused: false })
  equal(pending.calls.sendReplies, 1)
  await rejects(sent.run('orchestrator_ack', { trigger_id: 'trigger-1', text: words(101) }),
    /An acknowledgement has at most 100 words/)
})

test('report：工单已结束就拒绝并让人别续；progress 只记内部、questions 转成 attention 中继', async () => {
  const ended = executorHost({ stored: fakeTicket(TICKET_A, { ended: { at: AT, by: 'human', outcome: 'stopped' } }) })
  await rejects(ended.run('orchestrator_report', { state: 'progress', summary: 'Still going.' }),
    /Ticket ended \(PR was closed or work finished\); do not resume it/)
  equal(ended.calls.report.length, 0)
  const progress = executorHost()
  deepEqual(await progress.run('orchestrator_report', { state: 'progress', summary: 'Needs a decision.' }),
    { reported: true, notification: 'internal_only' })
  equal(progress.calls.relay.length, 0)
  const attention = executorHost()
  const reported = await attention.run('orchestrator_report', { state: 'progress', summary: 'Needs a decision.', human_action: 'Desktop too?' })
  equal(reported.notification, 'orchestrator')
  equal(reported.attention.question, 'Desktop too?')
  equal(attention.calls.relay.length, 1)
  equal(attention.calls.relay[0][0], `attention:${TICKET_A}:attention-1`)
  deepEqual(JSON.parse(attention.calls.relay[0][1]), { kind: 'worker_attention', ticket: { ticket_id: TICKET_A, title: 'Fix typo',
    state: 'person/answer', strength: 'explicit', attention: { question: 'Desktop too?' }, read: `ticket/${TICKET_A}` },
  state: 'progress', read: `ticket/${TICKET_A}/result` })
})

test('线程工具：跟踪只收 <source>:<id> 并通知，弃跟与交回各自落账', async () => {
  const { tools, run, calls } = executorHost()
  await rejects(run('orchestrator_thread_follow', { thread: 'github', reason: 'Related.' }), /A thread key is <source>:<id>, such as github:<number>/)
  equal(calls.followForContext.length, 0)
  const followed = await run('orchestrator_thread_follow', { thread: 'github:9', reason: 'The Issue it fixes.' })
  deepEqual(followed, { followed: true, thread: 'github:9' })
  deepEqual(calls.followForContext, [[TICKET_A, { source: 'github', id: '9' }]])
  equal(calls.notify.length, 1)
  // 通知名是一次性 receipt 的哈希键（`receiptNotice` 用 randomUUID 造，防合并），值里带线程与工单。
  match(calls.notify[0][0], /^[0-9a-f]{32}$/)
  equal(calls.notify[0][1].thread_followed.thread, 'github:9')
  equal(calls.notify[0][1].thread_followed.ticket_id, TICKET_A)
  const quiet = executorHost({ followed: false })
  deepEqual(await quiet.run('orchestrator_thread_follow', { thread: 'github:9', reason: 'Related.' }), { followed: false, thread: 'github:9' })
  equal(quiet.calls.notify.length, 0)
  deepEqual(await run('orchestrator_thread_unrelated', { thread: 'feishu:oc_1:om_1', reason: 'Another topic.' }),
    { removed: true, thread: 'feishu:oc_1:om_1' })
  deepEqual(calls.markUnrelated, [[TICKET_A, 'feishu:oc_1:om_1', 'Another topic.']])
  deepEqual(await run('orchestrator_trigger_handback', { trigger_id: 'trigger-2', reason: 'Another change.' }),
    { trigger_id: 'trigger-2', queued: true })
  deepEqual(calls.handback, [[TICKET_A, 'trigger-2', 'Another change.']])
  equal(tools.orchestrator_report.parameters.additionalProperties, false)
})

// ── 共享原语 ─────────────────────────────────────────────────────────────────

test('tool 原样返回定义；readTool 解析 offset 默认值并把参数透传；AcknowledgementSchema 按词数卡', async () => {
  const definition = { name: 'probe', description: 'Probe.', schema: { parse: value => value }, execute: async () => 'ok' }
  equal(tool(definition), definition)
  const seen = []
  const read = readTool('Read page.', false, async (...args) => { seen.push(args); return 'body' })
  equal(read.name, 'orchestrator_read')
  // `readTool` 的 execute 收的是已解析参数；默认 offset 由 schema 补（宿主 `entryOf` 负责 parse）。
  equal(await read.execute(read.schema.parse({ resource: 'tickets' }), new AbortController().signal), 'body')
  equal(seen[0][1], 0)
  equal(seen[0][2], undefined)
  equal(read.schema.safeParse({ resource: 'tickets', limit: 8001 }).success, false)
  equal(read.schema.safeParse({ resource: 'tickets', extra: true }).success, false)
  equal(AcknowledgementSchema.safeParse(words(100)).success, true)
  equal(AcknowledgementSchema.safeParse(words(101)).success, false)
  equal(AcknowledgementSchema.safeParse('   ').success, false)
})
