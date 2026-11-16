/**
 * P1 五个 + P2 三个 + P6 一个 + P7 三个主会话工具的包级测试：全用假端口，不建运行期、不碰磁盘。
 *
 * 钉的是「工具与端口之间的那一层」——参数怎么映射成引擎调用、一条被拒会不会连累别条、
 * 读面怎么分页、什么情况下回什么话。真的工单流转归 `runtime.test.mjs` / `chain.test.mjs`，
 * 这里一条都不重复。
 *
 * 二十组用例：
 *   1. 十二个工具都注册出来，名字 / 风险 / 必填参数对得上；
 *   2. route 四种 kind 各自调到对应端口方法，参数按上游映射；
 *   3. route 一条被引擎拒（UserError）不影响同一次里的其余几条；
 *   4. route 一条撞上别的异常时，拒绝里带「可以重试这一条」；
 *   5. route 缺必填字段或字段越界：该条 refused，且一次端口都没调；
 *   6. route 同一次里同一条先 accept 后 ignore：第二条自相矛盾，被拒；
 *   7. read tickets 分页带 next_offset，最后一页不带；
 *   8. read ticket:<id> 查得到 / 查不到；
 *   9. read 不认识的 resource、关着的候选收件箱、设置资源的 fields + history；
 *   10. ticket_status 两种返回各一句话；
 *   11. ticket_note 成功与空文本；
 *   12. reply 的参数映射与「排队」说明；
 *   13. worker 会话（isWorkerSession 为真）调任一工具都被拒；
 *   14. 运行期没起来（host 为 null）时五个工具都给「还没启动」；
 *   15. P2 三个工具注册出来：名字 / 风险 / 必填参数 / 描述要说清的关键约束；
 *   16. ticket_retry 调到端口、回 { ticket_id, reason }、成功后推快照，被拒时不推；
 *   17. trigger_requeue 三种情形：真排队 / 没排队 / 还归某张工单（后者一次 reevaluate 都不调）；
 *   18. thread_unsubscribe 调到端口、回 removed，掉的是给的那条线程；
 *   19. P2 三个工具在 worker 会话里同样拒；
 *   20. 运行期没起来时 P2 三个工具也拒。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/main-tools
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { createMainTools } = await import('../../../../lib/packages/superagent/main-tools.js')
const { UserError } = await import('../../../../lib/packages/superagent/core/index.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

/** 记一条通过的断言；失败照常抛给 node:test。 */
function ok(value, message) {
  assert.ok(value, message)
  passed += 1
}

/** 严格相等。 */
function equal(actual, expected, message) {
  assert.equal(actual, expected, message)
  passed += 1
}

/** 深比较（对象 / 数组）。 */
function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  passed += 1
}

/** 异步拒绝：工具都是 async 的，抛错会变成 rejected promise。 */
async function rejects(promise, pattern, message) {
  await assert.rejects(promise, pattern, message)
  passed += 1
}

/** 固定时钟：断言不依赖「跑得快慢」。 */
const AT = '2026-01-01T00:00:00.000Z'

/** 三张工单 id（32 位十六进制；与 `paths.ts` 的目录名校验同形）。 */
const TICKET_A = 'abcdef0123456789abcdef0123456789'
const TICKET_B = '11111111111111111111111111111111'
const TICKET_C = '22222222222222222222222222222222'
const TICKET_NONE = '99999999999999999999999999999999'

/** 主会话 id；工具只拿它问 `isWorkerSession`。 */
const MAIN_SESSION = 'session-main'

/** 一次工具调用的上下文（`ToolContext` 里工具真用到的几项）。 */
function ctxOf(sessionId) {
  return { cwd: '.', sessionId, sessionPath: '', signal: new AbortController().signal }
}

/**
 * 一台记调用的假端口：只回答被测工具真会问的那几样。
 *
 * @param options.decide - 覆盖 decide（抛错 / 造不同结论）；不给就按 kind 造一条正常结论
 * @param options.requestStatus - requestStatus 的返回值，缺省 true
 * @param options.followupOwners - 覆盖归属查询：返回还归哪几张工单，缺省 []
 * @param options.reevaluate - 覆盖 reevaluate（返回 true/false 或抛错）；不给就回 true
 * @param options.retryTicket - 覆盖 retryTicket（抛错 / 造工单）；不给就回 { id }
 * @param options.unsubscribe - unsubscribe 的返回值，缺省 true
 * @param options.worker - 这条会话 id 会被认成 worker
 * @param options.surface - 覆盖快照面
 */
function fakeHost(options = {}) {
  const calls = []
  const surface = options.surface ?? {
    ready: true,
    counts: { needsYou: 1, running: 1, done: 1 },
    tickets: [
      { id: TICKET_A, title: '改登录页文案', stage: { stage: 'working', action: 'queued' }, at: AT },
      { id: TICKET_B, title: '修分页', stage: { stage: 'ended' }, at: AT },
      { id: TICKET_C, title: '加导出', stage: { stage: 'person', action: 'review' }, at: AT },
    ],
    recent: [],
    settingsHistory: [],
  }
  const host = {
    decide(triggerId, outcome) {
      calls.push(['decide', triggerId, outcome])
      if (options.decide !== undefined) return options.decide(triggerId, outcome)
      return {
        kind: outcome.kind,
        reason: [{ code: outcome.kind === 'accept' ? 'explicitRouted' : 'ignoredFromCard' }],
        ticketId: outcome.kind === 'ignore' ? undefined : TICKET_A,
        triggerIds: [triggerId],
      }
    },
    attach(ticketId, triggerId, note) {
      calls.push(['attach', ticketId, triggerId, note])
      return { id: ticketId, title: '假工单' }
    },
    reply(request) {
      calls.push(['reply', request])
      return { id: 'reply-1', status: options.replyStatus ?? 'pending', reused: false }
    },
    requestStatus(ticketId) {
      calls.push(['requestStatus', ticketId])
      return options.requestStatus ?? true
    },
    note(ticketId, text) {
      calls.push(['note', ticketId, text])
      return { id: ticketId }
    },
    retryTicket(ticketId) {
      calls.push(['retryTicket', ticketId])
      if (options.retryTicket !== undefined) return options.retryTicket(ticketId)
      return { id: ticketId, title: '假工单' }
    },
    followupOwners(triggerId) {
      calls.push(['followupOwners', triggerId])
      return options.followupOwners !== undefined ? options.followupOwners(triggerId) : []
    },
    reevaluate(triggerId) {
      calls.push(['reevaluate', triggerId])
      return options.reevaluate !== undefined ? options.reevaluate(triggerId) : true
    },
    unsubscribe(thread) {
      calls.push(['unsubscribe', thread])
      return options.unsubscribe !== undefined ? options.unsubscribe : true
    },
    // P7 的设置面：settings 资源读 host.settings()；本文件只验「结构变成 fields + history」，
    // 具体的字段与保存行为在 `eval-settings.test.mjs` 里钉。
    settings() {
      return options.settings ?? []
    },
    snapshot() {
      return surface
    },
    isWorkerSession(sessionId) {
      return sessionId === options.worker
    },
    changed() {
      calls.push(['changed'])
    },
  }
  return { host, calls }
}

/** 九个工具 + 按名字查的索引。 */
function toolsOf(host) {
  const tools = createMainTools({ host: () => host })
  return { tools, byName: new Map(tools.map((tool) => [tool.name, tool])) }
}

/** 调一个工具（默认主会话）。 */
function run(byName, name, args, sessionId = MAIN_SESSION) {
  return byName.get(name).run(args, ctxOf(sessionId))
}

test('十二个工具都注册出来：名字、风险、必填参数对', () => {
  const { tools, byName } = toolsOf(fakeHost().host)
  deepEqual(
    tools.map((tool) => tool.name),
    [
      'superagent_read', 'superagent_route', 'superagent_ticket_status', 'superagent_ticket_note', 'superagent_reply',
      'superagent_ticket_retry', 'superagent_trigger_requeue', 'superagent_thread_unsubscribe', 'superagent_prompts_save',
      'superagent_settings_save', 'superagent_eval', 'superagent_eval_decide',
    ],
    '十二个工具的注册顺序固定（P1 五个在前，P2 三个、P6 一个、P7 三个往后追加）',
  )
  deepEqual(
    tools.map((tool) => tool.risk),
    ['read', 'write', 'read', 'write', 'write', 'write', 'write', 'write', 'write', 'write', 'read', 'write'],
    '风险档位与表一致',
  )
  deepEqual(byName.get('superagent_read').parameters.required, ['resource'])
  deepEqual(byName.get('superagent_route').parameters.required, ['decisions'])
  equal(byName.get('superagent_route').parameters.properties.decisions.minItems, 1, 'decisions 至少一条')
  equal(byName.get('superagent_route').parameters.properties.decisions.maxItems, 20, 'decisions 最多二十条')
  deepEqual(byName.get('superagent_route').parameters.properties.decisions.items.required, ['kind', 'trigger_id'])
  deepEqual(byName.get('superagent_ticket_status').parameters.required, ['ticket_id'])
  deepEqual(byName.get('superagent_ticket_note').parameters.required, ['ticket_id', 'text'])
  deepEqual(byName.get('superagent_reply').parameters.required, ['purpose', 'text'])
  deepEqual(byName.get('superagent_reply').parameters.properties.purpose.enum, ['answer', 'result', 'attention'])
  deepEqual(byName.get('superagent_prompts_save').parameters.required, ['role', 'text'])
  deepEqual(byName.get('superagent_prompts_save').parameters.properties.role.enum, ['shared', 'worker'])
  deepEqual(byName.get('superagent_settings_save').parameters.required, ['key', 'value'])
  deepEqual(byName.get('superagent_eval').parameters.required, ['trigger_id'])
  deepEqual(byName.get('superagent_eval_decide').parameters.required, ['trigger_id', 'decision'])
  deepEqual(byName.get('superagent_eval_decide').parameters.properties.decision.enum, ['accept', 'ignore'])
  // 描述是模型唯一能读到的说明书：上限与「只在主会话」必须真的写进去。
  ok(byName.get('superagent_read').description.includes('next_offset'), 'read 要说清 next_offset')
  ok(byName.get('superagent_read').description.includes('只在主会话里可用'), 'read 要说清主会话限制')
  ok(byName.get('superagent_read').description.includes('prompts'), 'read 要说清 prompts 资源')
  ok(byName.get('superagent_route').description.includes('20'), 'route 要说清一次最多二十条')
  ok(byName.get('superagent_ticket_note').description.includes('500'), 'note 要说清 500 字上限')
  ok(byName.get('superagent_reply').description.includes('20000'), 'reply 要说清正文上限')
  const save = byName.get('superagent_prompts_save').description
  ok(save.includes('明确要求'), '保存提示词要说清「只在用户明确要求时用」')
  ok(save.includes('之后启动'), '要说清只对之后启动的 worker 生效')
  ok(save.includes('20000'), '要说清 20000 字上限')
  ok(save.includes('只在主会话里可用'), '要说清主会话限制')
  // P7 的三条：描述就是行为规范，最容易漂移的两处必须写在里面。
  const settingsSave = byName.get('superagent_settings_save').description
  ok(settingsSave.includes('明确要求'), '改设置要说清「只在用户明确要求时用」')
  ok(settingsSave.includes('重开宿主'), '要说清仓库路径 / 判定模型这类设置可能要重开宿主')
  ok(settingsSave.includes('fields'), '要说清 key 从 settings 资源的 fields 里取')
  ok(byName.get('superagent_eval').description.includes('不是'), 'eval 要说清「不是重新评估」')
  ok(byName.get('superagent_eval_decide').description.includes('ticket_id'), 'eval_decide 要说清 accept 回 ticket_id')
})

test('route 四种 kind 各自调到对应端口方法，参数按上游映射', async () => {
  const { host, calls } = fakeHost()
  const { byName } = toolsOf(host)
  const out = await run(byName, 'superagent_route', {
    decisions: [
      {
        kind: 'accept',
        trigger_id: 'trg-1',
        title: '改登录页文案',
        worktree_name: 'fix-login-copy',
        acknowledgement: '把登录页的错误提示改成中文',
        note: '按产品给的文案改',
      },
      { kind: 'attach', trigger_id: 'trg-2', ticket_id: TICKET_A, note: '这条属于已有的活' },
      { kind: 'stop', trigger_id: 'trg-3', ticket_id: TICKET_B, reason: '人说不做了' },
      { kind: 'ignore', trigger_id: 'trg-4', reason: '只是随口一句' },
    ],
  })
  const results = JSON.parse(out.text).results
  equal(results.length, 4, '四条结论各回一条结果')
  deepEqual(calls[0], [
    'decide',
    'trg-1',
    {
      kind: 'accept',
      title: '改登录页文案',
      scope: '改登录页文案',
      reason: { code: 'explicitRouted' },
      acknowledgement: '把登录页的错误提示改成中文',
      name: 'fix-login-copy',
      note: '按产品给的文案改',
    },
  ], 'accept 映射成 decide(trigger, { kind: accept, title=scope, explicitRouted, acknowledgement, name, note })')
  deepEqual(calls[1], ['attach', TICKET_A, 'trg-2', '这条属于已有的活'], 'attach 走 attach(ticket, trigger, note)')
  deepEqual(calls[2], ['decide', 'trg-3', { kind: 'stop', ticketId: TICKET_B, reason: '人说不做了' }], 'stop 给了 reason 就用它')
  deepEqual(calls[3], ['decide', 'trg-4', { kind: 'ignore', reason: '只是随口一句' }], 'ignore 只带 reason')
  deepEqual(calls[4], ['changed'], '整批成功后只推一次快照')
  equal(results[0].ticket_id, TICKET_A, 'accept 的工单 id 要带回来')
  equal(results[0].decision, 'accept')
  equal(results[1].ticket_id, TICKET_A, 'attach 的工单 id 要带回来')
  equal(results[2].decision, 'stop')
  equal(results[3].decision, 'ignore')
})

test('route 一条被引擎拒（UserError）不影响同一次里的其余几条', async () => {
  const { host, calls } = fakeHost({
    decide(triggerId, outcome) {
      if (triggerId === 'trg-bad') throw new UserError('unknownTicket')
      return { kind: outcome.kind, reason: [{ code: 'explicitRouted' }], ticketId: TICKET_A, triggerIds: [triggerId] }
    },
  })
  const { byName } = toolsOf(host)
  const out = await run(byName, 'superagent_route', {
    decisions: [
      { kind: 'accept', trigger_id: 'trg-bad', title: '会被拒的', worktree_name: 'bad-one', acknowledgement: '回一句' },
      { kind: 'accept', trigger_id: 'trg-ok', title: '能接的', worktree_name: 'good-one', acknowledgement: '回一句' },
    ],
  })
  const results = JSON.parse(out.text).results
  ok(results[0].refused !== undefined, '前一条要有 refused')
  ok(results[0].refused.includes('没有这张工单'), `前一条说清为什么：${results[0].refused}`)
  equal(results[1].decision, 'accept', '后一条照常执行')
  equal(results[1].refused, undefined, '后一条没有 refused')
  equal(calls.filter((call) => call[0] === 'decide').length, 2, '两条都真的调到端口')
})

test('route 一条撞上别的异常时，拒绝里带「可以重试这一条」', async () => {
  const { host } = fakeHost({
    decide() {
      throw new Error('数据库忙')
    },
  })
  const { byName } = toolsOf(host)
  const out = await run(byName, 'superagent_route', {
    decisions: [{ kind: 'ignore', trigger_id: 'trg-1', reason: '不需要' }],
  })
  const results = JSON.parse(out.text).results
  ok(results[0].refused.includes('可以重试这一条'), `非 UserError 要提示可重试：${results[0].refused}`)
  ok(results[0].refused.includes('数据库忙'), '原因原样带回来')
})

test('route 缺必填字段或字段越界：该条 refused，端口一次都没调', async () => {
  const { host, calls } = fakeHost()
  const { byName } = toolsOf(host)
  const longTitle = '长'.repeat(201)
  const out = await run(byName, 'superagent_route', {
    decisions: [
      // accept 缺 acknowledgement
      { kind: 'accept', trigger_id: 'trg-1', title: '缺回执', worktree_name: 'no-ack' },
      // attach 缺 ticket_id
      { kind: 'attach', trigger_id: 'trg-2', note: '缺工单' },
      // ignore 缺 reason
      { kind: 'ignore', trigger_id: 'trg-3' },
      // worktree_name 不是 kebab-case 小写英文
      { kind: 'accept', trigger_id: 'trg-4', title: '名字不对', worktree_name: 'Fix_Login', acknowledgement: '回一句' },
      // title 超过 200 字
      { kind: 'accept', trigger_id: 'trg-5', title: longTitle, worktree_name: 'long-title', acknowledgement: '回一句' },
      // kind 不认识
      { kind: 'reopen', trigger_id: 'trg-6' },
    ],
  })
  const results = JSON.parse(out.text).results
  equal(results.length, 6, '六条各回一条结果')
  for (const item of results) {
    ok(item.refused !== undefined, `${item.trigger_id} 要被拒：${JSON.stringify(item)}`)
  }
  ok(results[0].refused.includes('acknowledgement'), '缺 acknowledgement 要说缺哪一项')
  ok(results[1].refused.includes('ticket_id'), '缺 ticket_id 要说缺哪一项')
  ok(results[2].refused.includes('reason'), '缺 reason 要说缺哪一项')
  ok(results[3].refused.includes('kebab-case'), '名字形状不对要说清怎么填')
  ok(results[4].refused.includes('200'), 'title 超长要说上限')
  ok(results[5].refused.includes('kind'), 'kind 不认识要直说')
  equal(calls.length, 0, '全部被拒时一次端口都不调，也不推快照')
})

test('route 同一次里同一条先 accept 后 ignore：第二条自相矛盾，被拒', async () => {
  const { host, calls } = fakeHost()
  const { byName } = toolsOf(host)
  const out = await run(byName, 'superagent_route', {
    decisions: [
      { kind: 'accept', trigger_id: 'trg-1', title: '接它', worktree_name: 'take-it', acknowledgement: '回一句' },
      { kind: 'ignore', trigger_id: 'trg-1', reason: '又想忽略' },
    ],
  })
  const results = JSON.parse(out.text).results
  equal(results[0].decision, 'accept')
  ok(results[1].refused.includes('已经跟着 trg-1'), `第二条要说清冲突：${results[1].refused}`)
  equal(calls.filter((call) => call[0] === 'decide').length, 1, '第二条没有真的调端口')
})

test('read tickets 分页：有下一页带 next_offset，最后一页不带', async () => {
  const { host } = fakeHost()
  const { byName } = toolsOf(host)
  const first = JSON.parse((await run(byName, 'superagent_read', { resource: 'tickets', limit: 2 })).text)
  equal(first.resource, 'tickets')
  equal(first.offset, 0)
  equal(first.total, 3)
  equal(first.items.length, 2)
  equal(first.next_offset, 2, '三张、每页两张：下一页从第 2 条开始')
  const second = JSON.parse((await run(byName, 'superagent_read', { resource: 'tickets', offset: first.next_offset, limit: 2 })).text)
  equal(second.items.length, 1)
  equal(second.next_offset, undefined, '没有下一页就不带这一项')
  equal(second.items[0].id, TICKET_C)
  // 缺省 offset 0、limit 20：三张一次读完。
  const all = JSON.parse((await run(byName, 'superagent_read', { resource: 'tickets' })).text)
  equal(all.items.length, 3)
  equal(all.next_offset, undefined)
  await rejects(run(byName, 'superagent_read', { resource: 'tickets', limit: 101 }), /limit/, 'limit 超过 100 要说清楚')
})

test('read ticket:<id>：查得到给一张，查不到说人话', async () => {
  const { host } = fakeHost()
  const { byName } = toolsOf(host)
  const found = JSON.parse((await run(byName, 'superagent_read', { resource: `ticket:${TICKET_B}` })).text)
  equal(found.items.length, 1)
  equal(found.items[0].id, TICKET_B)
  equal(found.items[0].title, '修分页')
  await rejects(
    run(byName, 'superagent_read', { resource: `ticket:${TICKET_NONE}` }),
    /没有这张工单/,
    '查不到要说「没有这张工单」，不是给空清单',
  )
  await rejects(run(byName, 'superagent_read', { resource: 'ticket:' }), /少了一个 id/, 'ticket: 后面空着也要说清楚')
})

test('read：不认识的 resource 会说支持哪几个；候选关着时带一句说明', async () => {
  const { host } = fakeHost()
  const { byName } = toolsOf(host)
  await rejects(run(byName, 'superagent_read', { resource: 'threads' }), /不认识的 resource/, '不认识的 resource 要报错')
  const candidates = JSON.parse((await run(byName, 'superagent_read', { resource: 'candidates' })).text)
  equal(candidates.items.length, 0)
  ok(candidates.note.includes('候选收件箱没开'), `关着时要说怎么打开：${candidates.note}`)
  const settings = JSON.parse((await run(byName, 'superagent_read', { resource: 'settings' })).text)
  equal(settings.resource, 'settings')
  deepEqual(settings.fields, [], '假端口没给字段时 fields 是空表')
  deepEqual(settings.history, [], '还没改过设置时 history 是空表')
  const recent = JSON.parse((await run(byName, 'superagent_read', { resource: 'recent' })).text)
  equal(recent.items.length, 0)
})

test('ticket_status：两种返回各一句话', async () => {
  const asked = fakeHost({ requestStatus: true })
  const askedTools = toolsOf(asked.host)
  const yes = await run(askedTools.byName, 'superagent_ticket_status', { ticket_id: TICKET_A })
  ok(yes.text.includes('已请它报一次状态'), `true 要说「已请它报一次状态」：${yes.text}`)
  deepEqual(asked.calls[0], ['requestStatus', TICKET_A])
  deepEqual(asked.calls[1], ['changed'], '催过之后推一次快照')

  const silent = fakeHost({ requestStatus: false })
  const silentTools = toolsOf(silent.host)
  const no = await run(silentTools.byName, 'superagent_ticket_status', { ticket_id: TICKET_A })
  ok(no.text.includes('它没在等'), `false 要说「它没在等」：${no.text}`)
  ok(no.text.includes('什么都没发'), '还要说清什么都没发')
  equal(silent.calls.filter((call) => call[0] === 'changed').length, 0, '什么都没发就不推快照')

  await rejects(
    run(askedTools.byName, 'superagent_ticket_status', { ticket_id: '' }),
    /ticket_id 不能为空/,
    '空 id 要被拦下',
  )
})

test('ticket_note：记给执行者，空文本被拒', async () => {
  const { host, calls } = fakeHost()
  const { byName } = toolsOf(host)
  const out = await run(byName, 'superagent_ticket_note', { ticket_id: TICKET_A, text: '另一张工单查到接口要传 date' })
  ok(out.text.includes('已记给执行者'), `成功要说「已记给执行者」：${out.text}`)
  deepEqual(calls[0], ['note', TICKET_A, '另一张工单查到接口要传 date'])
  deepEqual(calls[1], ['changed'])
  await rejects(run(byName, 'superagent_ticket_note', { ticket_id: TICKET_A, text: '   ' }), /text 不能为空/, '空文本被拒')
  await rejects(
    run(byName, 'superagent_ticket_note', { ticket_id: TICKET_A, text: '长'.repeat(501) }),
    /最多 500 字/,
    '超过 500 字被拒',
  )
})

test('reply：参数映射到 ReplyRequest，排队时说明下一拍发', async () => {
  const { host, calls } = fakeHost()
  const { byName } = toolsOf(host)
  const out = await run(byName, 'superagent_reply', {
    purpose: 'answer',
    text: '分页改好了，现在每页 20 条',
    trigger_id: 'trg-9',
    ticket_id: TICKET_A,
  })
  deepEqual(calls[0], [
    'reply',
    { purpose: 'answer', text: '分页改好了，现在每页 20 条', ticketId: TICKET_A, triggerId: 'trg-9' },
  ], 'reply 收 { purpose, text, ticketId, triggerId }')
  const body = JSON.parse(out.text)
  equal(body.status, 'pending')
  ok(body.note.includes('已排队'), `pending 要说明已经排队：${body.note}`)

  const attention = fakeHost()
  const attentionTools = toolsOf(attention.host)
  await run(attentionTools.byName, 'superagent_reply', {
    purpose: 'attention',
    text: '需要你确认用哪个接口',
    ticket_id: TICKET_A,
    human_action: '用 A 接口还是 B 接口？',
  })
  deepEqual(attention.calls[0], [
    'reply',
    { purpose: 'attention', text: '需要你确认用哪个接口', ticketId: TICKET_A, question: '用 A 接口还是 B 接口？' },
  ], 'attention 把 human_action 映射成 question')
  await rejects(
    run(attentionTools.byName, 'superagent_reply', { purpose: 'attention', text: '请拍板', ticket_id: TICKET_A }),
    /attention 要给 human_action/,
    'attention 缺 human_action 被拒',
  )
  await rejects(
    run(attentionTools.byName, 'superagent_reply', { purpose: 'progress', text: '做了一半' }),
    /purpose 只能是/,
    '闸门只有三种用途',
  )
  await rejects(
    run(attentionTools.byName, 'superagent_reply', { purpose: 'result', text: '   ' }),
    /text 不能为空/,
    '空正文被拒',
  )
})

test('worker 会话里五个工具都拒：只在主会话里可用', async () => {
  const { host } = fakeHost({ worker: 'session-worker' })
  const { byName } = toolsOf(host)
  const calls = [
    ['superagent_read', { resource: 'tickets' }],
    ['superagent_route', { decisions: [{ kind: 'ignore', trigger_id: 'trg-1', reason: '不需要' }] }],
    ['superagent_ticket_status', { ticket_id: TICKET_A }],
    ['superagent_ticket_note', { ticket_id: TICKET_A, text: '一句事实' }],
    ['superagent_reply', { purpose: 'answer', text: '一句答案', trigger_id: 'trg-1' }],
  ]
  for (const [name, args] of calls) {
    await rejects(run(byName, name, args, 'session-worker'), /只在主会话里可用/, `${name} 在 worker 会话里要拒`)
  }
})

test('运行期没起来时五个工具都给「还没启动」', async () => {
  const tools = createMainTools({ host: () => null })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const calls = [
    ['superagent_read', { resource: 'tickets' }],
    ['superagent_route', { decisions: [{ kind: 'ignore', trigger_id: 'trg-1', reason: '不需要' }] }],
    ['superagent_ticket_status', { ticket_id: TICKET_A }],
    ['superagent_ticket_note', { ticket_id: TICKET_A, text: '一句事实' }],
    ['superagent_reply', { purpose: 'answer', text: '一句答案', trigger_id: 'trg-1' }],
  ]
  for (const [name, args] of calls) {
    await rejects(run(byName, name, args), /还没启动/, `${name} 在运行期没起来时要给一句人话`)
  }
})

test('P2 三个工具注册出来：名字、风险、必填参数与描述的关键约束', () => {
  const { byName } = toolsOf(fakeHost().host)
  for (const name of ['superagent_ticket_retry', 'superagent_trigger_requeue', 'superagent_thread_unsubscribe']) {
    ok(byName.has(name), `${name} 要注册出来`)
    equal(byName.get(name).risk, 'write', `${name} 是写操作`)
    ok(byName.get(name).description.includes('只在主会话里可用'), `${name} 要说清主会话限制`)
  }
  deepEqual(byName.get('superagent_ticket_retry').parameters.required, ['ticket_id'])
  deepEqual(byName.get('superagent_trigger_requeue').parameters.required, ['trigger_id'])
  deepEqual(byName.get('superagent_thread_unsubscribe').parameters.required, ['thread'])
  const thread = byName.get('superagent_thread_unsubscribe').description
  ok(thread.includes('github:123'), `线程键要举例 github:123：${thread}`)
  ok(thread.includes('feishu:<chat>:<root>'), '线程键要举例 feishu:<chat>:<root>')
  ok(thread.includes('工单自己开的线程'), '要说清工单自己开的线程也能掉')
  ok(
    byName.get('superagent_trigger_requeue').description.includes('queued=false'),
    'queued=false 的含义要写进描述，模型才知道那不是失败',
  )
})

test('ticket_retry：调端口、回 { ticket_id, reason }、成功后推快照', async () => {
  const { host, calls } = fakeHost()
  const { byName } = toolsOf(host)
  const out = await run(byName, 'superagent_ticket_retry', { ticket_id: TICKET_A })
  deepEqual(calls[0], ['retryTicket', TICKET_A], '走 retryTicket(ticket_id)')
  const body = JSON.parse(out.text)
  equal(body.ticket_id, TICKET_A, '返回里带工单 id')
  ok(body.reason.includes('新分配'), `reason 要说清起了新分配：${body.reason}`)
  deepEqual(calls[1], ['changed'], '重试改了库，推一次快照')

  await rejects(
    run(byName, 'superagent_ticket_retry', { ticket_id: '  ' }),
    /ticket_id 不能为空/,
    '空 id 被拦下',
  )

  const refused = fakeHost({
    retryTicket() {
      throw new UserError('notRetryable')
    },
  })
  const refusedTools = toolsOf(refused.host)
  await rejects(
    run(refusedTools.byName, 'superagent_ticket_retry', { ticket_id: TICKET_A }),
    /才能重试/,
    'notRetryable 要翻成中文，别把英文原文丢给模型',
  )
  equal(refused.calls.filter((call) => call[0] === 'changed').length, 0, '被拒时没有改库，不推快照')
})

test('trigger_requeue：真排队 / 没排队 / 还归某张工单 三种情形', async () => {
  // 真排队：先查归属（不归工单），才重新排队。
  const queued = fakeHost({ reevaluate: () => true })
  const queuedTools = toolsOf(queued.host)
  const yes = JSON.parse((await run(queuedTools.byName, 'superagent_trigger_requeue', { trigger_id: 'trg-1' })).text)
  deepEqual(queued.calls[0], ['followupOwners', 'trg-1'], '先查这条消息还归不归工单')
  deepEqual(queued.calls[1], ['reevaluate', 'trg-1'], '不归工单才重新排队')
  deepEqual(queued.calls[2], ['changed'], '重新排队改了库，推一次快照')
  equal(yes.queued, true, '真排上队时 queued=true')

  // 没排队：不是失败，要单独给一句解释。
  const idle = fakeHost({ reevaluate: () => false })
  const idleTools = toolsOf(idle.host)
  const no = JSON.parse((await run(idleTools.byName, 'superagent_trigger_requeue', { trigger_id: 'trg-2' })).text)
  equal(no.queued, false)
  ok(no.note.includes('另一张工单') && no.note.includes('本来就不归'), `false 要说清两种可能：${no.note}`)
  equal(idle.calls.filter((call) => call[0] === 'changed').length, 0, '没排队就没改库，不推快照')

  // 还归某张工单：拒绝，而且一次 reevaluate 都不能调。
  const owned = fakeHost({ followupOwners: () => [TICKET_A, TICKET_B] })
  const ownedTools = toolsOf(owned.host)
  const message = await run(ownedTools.byName, 'superagent_trigger_requeue', { trigger_id: 'trg-3' })
    .then(() => '', (error) => error.message)
  ok(message.includes('还归工单'), `还归工单时要拒绝：${message}`)
  ok(message.includes(TICKET_A) && message.includes(TICKET_B), `拒绝里要说清是哪几张工单：${message}`)
  equal(owned.calls.filter((call) => call[0] === 'reevaluate').length, 0, '还归工单时不许重新排队')
  equal(owned.calls.filter((call) => call[0] === 'changed').length, 0, '被拒时也不推快照')

  // 查不到这条消息：引擎的 unknownTrigger 照 refusalOf 翻中文。
  const missing = fakeHost({
    reevaluate() {
      throw new UserError('unknownTrigger')
    },
  })
  const missingTools = toolsOf(missing.host)
  await rejects(
    run(missingTools.byName, 'superagent_trigger_requeue', { trigger_id: 'trg-none' }),
    /没有这条候选/,
    '未知 trigger 要说「没有这条候选 / 消息」',
  )
})

test('thread_unsubscribe：调端口、回 removed，掉的是给的那条线程', async () => {
  const { host, calls } = fakeHost()
  const { byName } = toolsOf(host)
  const body = JSON.parse((await run(byName, 'superagent_thread_unsubscribe', { thread: 'github:123' })).text)
  deepEqual(calls[0], ['unsubscribe', 'github:123'], '按线程键掉订阅')
  deepEqual(calls[1], ['changed'], '真掉掉了订阅才推快照')
  equal(body.thread, 'github:123', '返回里带线程键')
  equal(body.removed, true)

  const none = fakeHost({ unsubscribe: false })
  const noneTools = toolsOf(none.host)
  const no = JSON.parse((await run(noneTools.byName, 'superagent_thread_unsubscribe', { thread: 'feishu:oc_x:om_y' })).text)
  equal(no.thread, 'feishu:oc_x:om_y', '飞书形状的线程键原样带回')
  equal(no.removed, false)
  equal(none.calls.filter((call) => call[0] === 'changed').length, 0, '本来就没订阅，不推快照')
  await rejects(
    run(noneTools.byName, 'superagent_thread_unsubscribe', { thread: '   ' }),
    /thread 不能为空/,
    '空线程键被拦下',
  )
})

test('P2 三个工具在 worker 会话里同样拒：只在主会话里可用', async () => {
  const { host } = fakeHost({ worker: 'session-worker' })
  const { byName } = toolsOf(host)
  const calls = [
    ['superagent_ticket_retry', { ticket_id: TICKET_A }],
    ['superagent_trigger_requeue', { trigger_id: 'trg-1' }],
    ['superagent_thread_unsubscribe', { thread: 'github:123' }],
  ]
  for (const [name, args] of calls) {
    await rejects(run(byName, name, args, 'session-worker'), /只在主会话里可用/, `${name} 在 worker 会话里要拒`)
  }
})

test('运行期没起来时 P2 三个工具也拒', async () => {
  const tools = createMainTools({ host: () => null })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const calls = [
    ['superagent_ticket_retry', { ticket_id: TICKET_A }],
    ['superagent_trigger_requeue', { trigger_id: 'trg-1' }],
    ['superagent_thread_unsubscribe', { thread: 'github:123' }],
  ]
  for (const [name, args] of calls) {
    await rejects(run(byName, name, args), /还没启动/, `${name} 在运行期没起来时要给一句人话`)
  }
})
