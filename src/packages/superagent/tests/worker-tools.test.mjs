/**
 * worker 工具的包级测试：六个工具（五个协作工具 + 第八批的读上下文）
 * 全对着假端口，不建运行期、不碰磁盘。
 *
 * 钉的是「工具与端口之间的那一层」——参数怎么映射成引擎调用、被拒时回什么话、
 * 什么情况下一次端口都不该调。真的工单流转（回执发得出去、线程订阅真的掉了、
 * 读到的工单上下文对不对）归 `runtime.test.mjs` / `chain.test.mjs`，这里一条都不重复。
 *
 * 十四组用例：
 *   1. 六个工具都注册出来，名字 / 风险 / report 的参数名对（human_action 在、question 不在、pr_number 在）；
 *   2. ack 调到端口、参数对；端口返回 false 时给「只在 Super Agent 的 worker 会话里可用」；
 *   3. thread_unrelated：reason 超 300 字被拒，端口一次都没被调；
 *   4. thread_follow：端口返回 false 时回话是「本来就在跟」；
 *   5. trigger_handback：交回 / 没交回两种回话；
 *   6. report 三种映射：空串 → question: null；不传 → 字段不存在；两条消息 id → askedBy / answers；
 *   7. report 带 pr_number：先认领后报告；认领被拒时整份报告作废；
 *   8. WORKER_ONLY_TOOL_NAMES 是 6 条、含 superagent_context，且与注册出来的名字一致；
 *   9. host() 为 null 时六个工具都拒；
 *   10. superagent_context 注册出来、risk 是 read、参数表对（只 resource 必填、limit 上限 50）；
 *   11. ticket 资源：id / 标题 / 创建时间 / 正文 / 输入清单原样给模型，缺省分页参数对；
 *   12. thread 资源：第一页带 next_offset、最后一页不带；limit 超 50 被拒且端口一次没调；
 *   13. input:<id>：自己的能读全文（带空格的写法收成规范形状）、别人的被拒；
 *   14. 非 worker 会话调它被拒（host 按会话返回 null），端口一次都没调。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/worker-tools
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { createWorkerTools, WORKER_ONLY_TOOL_NAMES } = await import('../../../../lib/packages/superagent/tools.js')

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
async function rejects(run, pattern, message) {
  await assert.rejects(run, pattern, message)
  passed += 1
}

/** worker 会话 id；工具只拿它交给端口，端口再按它反查 worker。 */
const WORKER_SESSION = 'session-worker'

/** 一次工具调用的上下文（`ToolContext` 里工具真用到的几项）。 */
function ctxOf(sessionId) {
  return { cwd: '.', sessionId, sessionPath: '', signal: new AbortController().signal }
}

/**
 * 一台记调用的假 worker 端口：六个动作 + `changed`，返回值可按用例覆盖。
 *
 * 不实现「按会话反查」——那是运行期 / 执行器的事；这里只验证工具把参数原样交对了，
 * 以及端口说 `false` / `null` 时工具回什么话。`context` 可以给值、也可以给函数，
 * 分页用例要靠 offset 换页。
 */
function fakePort(options = {}) {
  const calls = []
  const port = {
    ack(sessionId, triggerId, text) {
      calls.push({ method: 'ack', sessionId, triggerId, text })
      return options.ack ?? true
    },
    markUnrelated(sessionId, thread, reason) {
      calls.push({ method: 'markUnrelated', sessionId, thread, reason })
      return options.markUnrelated ?? true
    },
    followForContext(sessionId, thread) {
      calls.push({ method: 'followForContext', sessionId, thread })
      return options.followForContext ?? true
    },
    handback(sessionId, triggerId, reason) {
      calls.push({ method: 'handback', sessionId, triggerId, reason })
      return options.handback ?? true
    },
    report(sessionId, report) {
      calls.push({ method: 'report', sessionId, report })
      return options.report ?? true
    },
    claimPull(sessionId, number) {
      calls.push({ method: 'claimPull', sessionId, number })
      return options.claimPull
    },
    context(sessionId, resource, offset, limit) {
      calls.push({ method: 'context', sessionId, resource, offset, limit })
      if (typeof options.context === 'function') return options.context({ sessionId, resource, offset, limit })
      return options.context ?? null
    },
    changed() {
      calls.push({ method: 'changed' })
    },
  }
  return { calls, port }
}

/** 用一台假端口造六个工具；`hostNull` 模拟「运行期还没建」。 */
function toolsFor(port, options = {}) {
  return createWorkerTools({ host: () => (options.hostNull === true ? null : port) })
}

/** 按名字取一个工具；缺了直接失败，免得用例在 `undefined.run` 上报一句看不懂的错。 */
function byName(tools, name) {
  const found = tools.find((tool) => tool.name === name)
  assert.ok(found, `缺工具 ${name}`)
  passed += 1
  return found
}

test('六个 worker 工具都注册出来：名字 / 风险 / report 的参数名对', async () => {
  const tools = toolsFor(fakePort().port)
  deepEqual(tools.map((tool) => tool.name), [...WORKER_ONLY_TOOL_NAMES], '注册顺序要与名单一致')
  for (const tool of tools) {
    equal(tool.risk, 'read', `${tool.name} 不写文件、不跑命令，风险应为 read`)
  }
  const report = byName(tools, 'superagent_report')
  const properties = report.parameters.properties
  ok('human_action' in properties, 'report 要有 human_action（原 question 改名）')
  equal('question' in properties, false, '参数表里不该再露出旧的 question')
  ok('question_for_trigger_id' in properties, 'report 要能指名问题问在哪条人的消息上')
  ok('reply_to_trigger_id' in properties, 'report 要能指名它在回答哪条人的提问')
  ok('pr_number' in properties, 'report 要能报这张单的 PR 号')
  equal(properties.pr_number.type, 'integer', 'pr_number 是整数')
  equal(properties.pr_number.minimum, 1, 'PR 号从 1 起')
  deepEqual(report.parameters.required, ['state', 'summary'], '只有 state / summary 是必填')
})

test('ack：调到端口、参数对；端口返回 false 时给「只在 worker 会话里可用」', async () => {
  const { calls, port } = fakePort()
  const tool = byName(toolsFor(port), 'superagent_ack')
  const result = await tool.run({ trigger_id: 't-1', text: '先跑一遍测试，晚上给结果' }, ctxOf(WORKER_SESSION))
  equal(result, '已回执给人', '成功时回一句人话')
  deepEqual(calls[0], { method: 'ack', sessionId: WORKER_SESSION, triggerId: 't-1', text: '先跑一遍测试，晚上给结果' })
  ok(calls.some((call) => call.method === 'changed'), '回执成功要推一次快照')

  const refused = fakePort({ ack: false })
  await rejects(
    () => byName(toolsFor(refused.port), 'superagent_ack').run({ trigger_id: 't-2', text: '回执' }, ctxOf(WORKER_SESSION)),
    /只在 Super Agent 的 worker 会话里可用/,
    '端口说不是 worker 时，工具要翻成一句模型看得懂的话',
  )
})

test('thread_unrelated：reason 超 300 字被拒，端口一次都没被调', async () => {
  const { calls, port } = fakePort()
  const tool = byName(toolsFor(port), 'superagent_thread_unrelated')
  await rejects(
    () => tool.run({ thread: 'github:7', reason: '很'.repeat(301) }, ctxOf(WORKER_SESSION)),
    /reason 最多 300 字/,
    '超长的理由要在工具这层拦掉',
  )
  equal(calls.length, 0, '参数不合法时一次端口都不该调')

  const result = await tool.run({ thread: 'github:7', reason: '这条 PR 跟本工单无关' }, ctxOf(WORKER_SESSION))
  equal(result, '已不再跟这条线程')
  deepEqual(calls[0], {
    method: 'markUnrelated',
    sessionId: WORKER_SESSION,
    thread: 'github:7',
    reason: '这条 PR 跟本工单无关',
  })
  ok(calls.some((call) => call.method === 'changed'), '真掉了订阅才推快照')
})

test('thread_follow：端口返回 false 时回话是「本来就在跟」', async () => {
  const { calls, port } = fakePort({ followForContext: false })
  const tool = byName(toolsFor(port), 'superagent_thread_follow')
  const result = await tool.run({ thread: 'github:9', reason: '它引用了同一个 Issue' }, ctxOf(WORKER_SESSION))
  // false 在这里不是失败：引擎对「已经订阅过的线程」就返回 false（`core/tickets.ts` 的
  // `followForContext`）。工具如实说「本来就在跟」，模型不用再跟一次。
  ok(result.includes('本来就在跟'), `false 要回「本来就在跟」，实际：${result}`)
  deepEqual(calls, [{ method: 'followForContext', sessionId: WORKER_SESSION, thread: 'github:9' }])

  const followed = fakePort()
  const tool2 = byName(toolsFor(followed.port), 'superagent_thread_follow')
  const echoed = await tool2.run({ thread: 'github:9', reason: '它引用了同一个 Issue' }, ctxOf(WORKER_SESSION))
  ok(echoed.includes('跟上'), `true 要回「跟上」，实际：${echoed}`)
  ok(followed.calls.some((call) => call.method === 'changed'), '新订阅的线程要推一次快照')
})

test('trigger_handback：交回 / 没交回两种回话', async () => {
  const accepted = fakePort()
  const tool = byName(toolsFor(accepted.port), 'superagent_trigger_handback')
  const result = await tool.run({ trigger_id: 't-9', reason: '它要的是另一张工单的活' }, ctxOf(WORKER_SESSION))
  equal(result, '已交回：它会重新判定归哪张工单')
  deepEqual(accepted.calls[0], {
    method: 'handback',
    sessionId: WORKER_SESSION,
    triggerId: 't-9',
    reason: '它要的是另一张工单的活',
  })
  ok(accepted.calls.some((call) => call.method === 'changed'), '交回成功要推一次快照')

  // 端口说交不回来（另一张工单还在决定它 / 本来不归它）：工具要说起因，不能只说失败。
  const refused = fakePort({ handback: false })
  const notQueued = await byName(toolsFor(refused.port), 'superagent_trigger_handback')
    .run({ trigger_id: 't-9', reason: '越界' }, ctxOf(WORKER_SESSION))
  ok(notQueued.includes('没交回'), `false 要回「没交回」，实际：${notQueued}`)
  ok(notQueued.includes('另一张工单还在决定它'), '要说清是哪种情况，模型才知道不必重试')
})

test('report 三种映射：空串 → question: null；不传 → 字段不存在；两条消息 id → askedBy / answers', async () => {
  const { calls, port } = fakePort()
  const tools = toolsFor(port)
  const report = byName(tools, 'superagent_report')
  /** 端口收到的报告（`changed` 夹在中间，所以按方法过滤，不按下标取）。 */
  const reports = () => calls.filter((call) => call.method === 'report').map((call) => call.report)

  // 1. 传空串 = 清掉原来那个待回答的问题；引擎要的是 null（undefined 是「保留」）。
  await report.run({ state: 'blocked', summary: '人已经答了，不用再问', human_action: '' }, ctxOf(WORKER_SESSION))
  equal(reports()[0].question, null, 'human_action 空串要映射成 question: null')
  equal('askedBy' in reports()[0], false, '没给 question_for_trigger_id 时不该带 askedBy')

  // 2. 不传 = 保留原来的问题：字段整个不该出现。
  await report.run({ state: 'progress', summary: '跑了一半' }, ctxOf(WORKER_SESSION))
  equal('question' in reports()[1], false, '不传 human_action 时不该带 question 字段')
  equal('askedBy' in reports()[1], false)
  equal('answers' in reports()[1], false)

  // 3. 两条消息 id 映射成引擎的 askedBy / answers（问题问在哪、这份报告回答谁）。
  await report.run({
    state: 'blocked',
    summary: '要人拍板',
    human_action: '用方案 A 还是 B？',
    question_for_trigger_id: 't-ask',
    reply_to_trigger_id: 't-answer',
  }, ctxOf(WORKER_SESSION))
  const mapped = reports()[2]
  equal(mapped.question, '用方案 A 还是 B？')
  equal(mapped.askedBy, 't-ask', 'question_for_trigger_id 要映射成 askedBy')
  equal(mapped.answers, 't-answer', 'reply_to_trigger_id 要映射成 answers')
  ok(calls.some((call) => call.method === 'changed'), '报告真的写进工单后才推快照')
})

test('report 带 pr_number：先认领后报告；认领被拒时整份报告作废', async () => {
  // 认领被拒：把原因原样抛给模型（它会改参数或去掉 pr_number），一条报告都不许写。
  const refused = fakePort({ claimPull: 'PR #12 不属于这张工单：没有 PR 就别传 pr_number' })
  const refusedTool = byName(toolsFor(refused.port), 'superagent_report')
  await rejects(
    () => refusedTool.run({ state: 'ready', summary: '交付了', pr_number: 12 }, ctxOf(WORKER_SESSION)),
    /PR #12 不属于这张工单/,
    '认领的拒绝原因要原样抛出去',
  )
  deepEqual(
    refused.calls.map((call) => call.method),
    ['claimPull'],
    '认领被拒之后不能再写报告',
  )

  // 认领通过：先认领、再写报告、最后推快照——顺序反了会把「PR 没挂上」的状态先写进工单。
  const accepted = fakePort()
  const okTool = byName(toolsFor(accepted.port), 'superagent_report')
  const result = await okTool.run({ state: 'ready', summary: '交付了', pr_number: 12 }, ctxOf(WORKER_SESSION))
  equal(result, '已报 ready：工单按交付收尾。')
  deepEqual(
    accepted.calls.map((call) => call.method),
    ['claimPull', 'report', 'changed'],
    '顺序必须是先认领、再报告、最后推快照',
  )
  deepEqual(
    accepted.calls[0],
    { method: 'claimPull', sessionId: WORKER_SESSION, number: 12 },
    '认领要用这条会话与报上来的 PR 号',
  )
  equal(accepted.calls[1].report.state, 'ready', '认领通过后再按原逻辑写这份报告')

  // 不给 / 给 null：当成「没有 PR」，一次认领都不该发生（模型偶尔会把可选参数写成 null）。
  const absent = fakePort()
  const absentTool = byName(toolsFor(absent.port), 'superagent_report')
  await absentTool.run({ state: 'progress', summary: '跑了一半', pr_number: null }, ctxOf(WORKER_SESSION))
  equal(absent.calls.some((call) => call.method === 'claimPull'), false, 'pr_number 为空时不该认领')
})

test('WORKER_ONLY_TOOL_NAMES 是 6 条、含 superagent_context，且与注册出来的名字一致', () => {
  equal(WORKER_ONLY_TOOL_NAMES.length, 6, 'worker 专用工具正好六个')
  ok(WORKER_ONLY_TOOL_NAMES.includes('superagent_context'), '读自己工单上下文的工具也只给 worker')
  deepEqual([...WORKER_ONLY_TOOL_NAMES], toolsFor(fakePort().port).map((tool) => tool.name))
  // 主会话工具不能混进来：投影只该藏 worker 专用的那六个。
  ok(!WORKER_ONLY_TOOL_NAMES.includes('superagent_read'), '主会话的读工具不在名单里')
  ok(!WORKER_ONLY_TOOL_NAMES.includes('superagent_route'), '主会话的路由工具不在名单里')
})

test('host() 为 null 时六个工具都拒', async () => {
  const tools = toolsFor(null, { hostNull: true })
  equal(tools.length, 6)
  for (const tool of tools) {
    await rejects(
      // 报告参数的「resource」这几条工具都不读；context 工具在参数校验之前就先查身份。
      () => tool.run({ state: 'progress', summary: '跑了一半', resource: 'ticket' }, ctxOf(WORKER_SESSION)),
      /只在 Super Agent 的 worker 会话里可用/,
      `${tool.name} 在运行期没起来时也要给同一句话`,
    )
  }
})

test('superagent_context 注册出来：risk 是 read，参数表对', () => {
  const tool = byName(toolsFor(fakePort().port), 'superagent_context')
  equal(tool.risk, 'read', '读上下文不写任何东西，风险应为 read')
  equal(tool.parameters.properties.resource.type, 'string', 'resource 是字符串')
  deepEqual(tool.parameters.required, ['resource'], '只有 resource 是必填')
  equal(tool.parameters.properties.limit.maximum, 50, 'limit 上限 50')
  equal(tool.parameters.properties.offset.minimum, 0, 'offset 从 0 起')
  ok(tool.description.includes('input:<id>'), '描述里要说清 input:<id> 这种写法')
  ok(tool.description.includes('不是读整个系统'), '描述里要写清只读自己这张工单')
})

test('ticket 资源：id / 标题 / 创建时间 / 正文 / 输入清单原样给模型', async () => {
  const view = {
    id: 'ticket-1',
    title: '改登录页文案',
    createdAt: '2026-01-01T00:00:00.000Z',
    body: '把「登录」按钮改成「进入」',
    inputs: [
      { id: 'input-1', source: 'feishu', at: '2026-01-01T00:00:01.000Z', text: '英文文案也要改' },
      { id: 'input-2', source: 'main', at: '2026-01-01T00:00:02.000Z', text: '背景：这个按钮在首页' },
    ],
    inputTotal: 2,
  }
  const { calls, port } = fakePort({ context: view })
  const tool = byName(toolsFor(port), 'superagent_context')
  const out = JSON.parse((await tool.run({ resource: 'ticket' }, ctxOf(WORKER_SESSION))).text)
  // 工具不该改写内容：运行期装配成什么样，模型就吃到什么样。
  deepEqual(out, view, '工单本身与输入清单三块都要在')
  equal(out.inputs.length, 2, '输入清单每条都在')
  deepEqual(
    calls[0],
    { method: 'context', sessionId: WORKER_SESSION, resource: 'ticket', offset: 0, limit: 20 },
    '缺省 offset 0 / limit 20，resource 原样交给端口',
  )
})

test('thread 资源：第一页带 next_offset、最后一页不带；limit 超 50 被拒', async () => {
  const pages = {
    0: {
      thread: 'feishu:c1:r1',
      offset: 0,
      limit: 2,
      total: 3,
      messages: [
        { at: 't1', actor: 'u1', text: '第一条' },
        { at: 't2', actor: 'u2', text: '第二条' },
      ],
      next_offset: 2,
    },
    2: {
      thread: 'feishu:c1:r1',
      offset: 2,
      limit: 2,
      total: 3,
      messages: [{ at: 't3', actor: 'u1', text: '第三条' }],
    },
  }
  const { calls, port } = fakePort({ context: ({ offset }) => pages[offset] ?? null })
  const tool = byName(toolsFor(port), 'superagent_context')

  const first = JSON.parse((await tool.run({ resource: 'thread', offset: 0, limit: 2 }, ctxOf(WORKER_SESSION))).text)
  equal(first.next_offset, 2, '还有下一页时带 next_offset')
  equal(first.messages.length, 2, '一页给 limit 条')
  deepEqual(
    calls.at(-1),
    { method: 'context', sessionId: WORKER_SESSION, resource: 'thread', offset: 0, limit: 2 },
    'offset / limit 原样交给端口',
  )

  const last = JSON.parse((await tool.run({ resource: 'thread', offset: 2, limit: 2 }, ctxOf(WORKER_SESSION))).text)
  equal('next_offset' in last, false, '最后一页不带 next_offset')

  const before = calls.length
  await rejects(
    () => tool.run({ resource: 'thread', limit: 51 }, ctxOf(WORKER_SESSION)),
    /limit 要是 1~50 之间的整数/,
    '超过 50 要在这层拦住',
  )
  equal(calls.length, before, '参数不合法时一次端口都不该调')
})

test('input:<id>：自己的输入能读全文，别人的输入被拒', async () => {
  const full = { id: 'input-1', source: 'feishu', at: '2026-01-01T00:00:01.000Z', text: '完整原文：把登录改成进入，英文也改' }
  const { calls, port } = fakePort({ context: ({ resource }) => (resource === 'input:input-1' ? full : null) })
  const tool = byName(toolsFor(port), 'superagent_context')

  // 带空格的写法应收成规范形状：前缀只在一处拼，别让两个写法各自拼一遍。
  const out = JSON.parse((await tool.run({ resource: 'input: input-1' }, ctxOf(WORKER_SESSION))).text)
  deepEqual(out, full, '拿到的是不截断的完整原文')
  equal(calls[0].resource, 'input:input-1', 'input:<id> 的写法要规范化再交给端口')

  await rejects(
    () => tool.run({ resource: 'input:input-other' }, ctxOf(WORKER_SESSION)),
    /这条输入不属于这张工单/,
    '别人的输入要拒，且说清是哪一种拒绝',
  )
})

test('非 worker 会话调 superagent_context 被拒：端口一次都没调', async () => {
  const { calls, port } = fakePort()
  // 与 `index.ts` 同形：host 先按会话判身份，不是 worker 就给 null。
  const tools = createWorkerTools({ host: (sessionId) => (sessionId === WORKER_SESSION ? port : null) })
  const tool = byName(tools, 'superagent_context')
  await rejects(
    () => tool.run({ resource: 'ticket' }, ctxOf('session-main')),
    /只在 Super Agent 的 worker 会话里可用/,
    '非 worker 会话要在拿端口这一步就被拒',
  )
  equal(calls.length, 0, '被拒时一次端口都不该调')
})
