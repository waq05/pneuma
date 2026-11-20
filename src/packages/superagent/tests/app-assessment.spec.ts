/**
 * `app/assessment.ts` 的包级覆盖测试：主会话判定器（`MasterAssessor`）的 schema、上下文装载顺序、
 * 越权拒绝、结论记录与读口边界。
 *
 * 上游那条规格起的是真 Engine + 内存仓储 + 真 SourceRegistry；本文件按任务约定只保留
 * 「判定器自己的行为」，依赖整套运行期的那几条用假件替代：
 *   - `AssessorHost.engine` 只实现 `candidate` / `candidateDelivered` / `decide` 三个被测函数真调的成员；
 *   - `TriggerContext` 用对象字面量，消息、分页游标、图片引用都由用例给；
 *   - `Commands` 只实现 `withSignal().api`（读文件/目录走它）；
 *   - 部署配置是普通对象（本仓 `deployment.ts` 的 `Machine` 是普通 number）。
 *
 * 覆盖：schema 边界、上下文装载顺序与窗口渲染、图片/文件/目录读、越权拒绝、慢读竞态、
 * 结论记录与 observe 降级、候选卡片按 evalId 幂等投递。
 *
 * @module @pneuma/superagent/tests/assessment
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { MasterAssessor, AssessmentSchema, EvalReadSchema, WorktreeNameSchema } from '../app/assessment.js'
import { SettingsSchema } from '../core/policy.js'
import { mainAdmissionPolicy } from '../app/context.js'

/** 严格相等（标量 / 引用）。 */
function equal(actual: unknown, expected: unknown, message?: string): void {
  assert.equal(actual, expected, message)
}
/** 深比较（对象 / 数组）。 */
function deepEqual(actual: unknown, expected: unknown, message?: string): void {
  assert.deepEqual(actual, expected, message)
}
/** 文本匹配（错误文案）。 */
function match(text: unknown, pattern: RegExp, message?: string): void {
  assert.match(String(text), pattern, message)
}
/** 异步拒绝：判定器的读口都是 async 的。 */
async function rejects(promise: Promise<unknown>, pattern: RegExp, message?: string): Promise<void> {
  await assert.rejects(promise, pattern, message)
}

/** 固定时钟：窗口里的 `at` 不依赖当前时间。 */
const AT = '2026-09-09T00:00:00.000Z'
/** 判定期间用的中止信号。 */
const SIGNAL = new AbortController().signal
/** 一个 tick：让 `seed()` 里的 `Promise.resolve().then(...)` 跑到第一次 await。 */
const tick = () => new Promise(resolve => { setTimeout(resolve, 0) })

/** 一条 GitHub Issue 触发。 */
function trigger(n: number, over: Record<string, unknown> = {}): any {
  return { id: `issue-${n}`, source: 'github', threads: [{ source: 'github', id: String(n) }],
    actor: { source: 'github', id: 'bob' }, human: true, at: new Date(Date.UTC(2026, 8, 9, 0, 0, n)).toISOString(),
    text: `issue ${n}`, url: `https://github.com/acme/widgets/issues/${n}`, meta: { number: n }, ...over }
}

/** 一条候选；默认是推断强度、单触发、无关联工单。 */
function makeCandidate(triggers: any[], over: Record<string, unknown> = {}): any {
  return { evalId: 'eval-1', strength: 'inferred', triggers, policyVersion: 'policy-v1', tickets: [],
    thread: { key: 'github:1', ref: { source: 'github', id: '1' }, createdAt: AT, subscriptions: [], correlated: [], pending: [], meta: {} },
    ...over }
}

/** 假线程上下文：消息、分页、图片引用都是用例给的；记下读图调用。 */
function makeThread(options: any = {}): { thread: any; calls: { read: any[]; image: any[] } } {
  const calls = { read: [] as any[], image: [] as any[] }
  const thread = {
    messageId: options.messageId ?? 'm0',
    async read(commands: unknown, part: unknown, cursor: unknown) {
      calls.read.push([part, cursor])
      if (options.pages) return options.pages(cursor)
      const messages = options.messages ?? []
      return { messages, body: { messages } }
    },
    images: options.images ?? (() => []),
    async image(...args: any[]) {
      calls.image.push(args)
      return options.image ? options.image(...args) : { dataUrl: 'data:,x' }
    },
  }
  return { thread, calls }
}

/** 判定器假宿主：只实现 `AssessorHost` 里被测函数会碰的成员，`state` 记下引擎调用与投递。 */
function setup(options: any = {}): any {
  const state: any = {
    candidate: options.candidate === undefined ? makeCandidate([trigger(1)]) : options.candidate,
    decided: [], delivered: [], enqueued: [], handlers: [], api: [],
    settings: options.settings ?? SettingsSchema.parse({}),
  }
  const commands = {
    async api(schema: unknown) {
      state.api.push([schema])
      // 字符串首个参数是文件路径；否则是 schema（目录列举），返回 GitHub 那种条目数组。
      if (typeof schema === 'string') return schema.startsWith('contents/') ? 'export const value = 1\n' : '{}'
      return [{ name: 'b.ts' }, { name: 'a.ts' }, { name: '.hidden' }]
    },
  }
  const thread = options.thread === undefined ? makeThread().thread : options.thread
  const host: any = {
    engine: {
      candidate(id: string) {
        const candidate = state.candidate
        return candidate && candidate.triggers.some((item: any) => item.id === id) ? candidate : undefined
      },
      candidateDelivered(evalId: string) {
        state.decided.push(['delivered', evalId])
      },
      decide(triggerId: string, outcome: any) {
        state.decided.push([triggerId, outcome])
        const reason = typeof outcome.reason === 'string' ? [{ code: 'said', values: { text: outcome.reason } }] : [outcome.reason]
        return { id: 'decision-1', kind: outcome.kind, reason, triggerIds: [triggerId], strength: 'inferred',
          threadKey: 'github:1', at: AT, ...outcome.kind === 'accept' ? { ticketId: 'ticket-1' } : {} }
      },
    },
    commands: { withSignal: () => commands },
    deployment: { stateDir: '/tmp/dsh-assessment-test', admissionContextTimeoutMs: 15000, admissionContextMaxPages: 10,
      ...options.deployment },
    settings: () => state.settings,
    threadContext: () => thread,
    effects: {
      handle(kind: string, run: unknown, handlerOptions: unknown) {
        state.handlers.push({ kind, run, handlerOptions })
      },
      enqueue(kind: string, key: string, payload: unknown) {
        state.enqueued.push([kind, key, payload])
      },
    },
    paused: options.paused ?? (() => false),
    deliver: async (requestId: string, text: string) => {
      state.delivered.push([requestId, text])
    },
    candidateCard: async (candidate: any) => ({ eval_id: candidate.evalId }),
  }
  const assessor = new MasterAssessor(host)
  return { assessor, host, state, commands, thread }
}

/** 一条方向已定的判定依据（`directionAllowed` 为真）。 */
const DIRECTION = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'please fix the typo' }
/** 单条启用规则的设置：让 `assessmentOutcome` 的规则覆盖校验只需一条。 */
const ONE_RULE = SettingsSchema.parse({
  policy: { rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Explicit requests to correct a typo.' }] },
})

// ── 纯 schema ────────────────────────────────────────────────────────────────

test('AssessmentSchema：三种决定、拒 reopen/stop、拒多余字段', () => {
  const base = { rule_assessments: [], direction: DIRECTION, title: 't', scope: 's', reason: 'r' }
  for (const decision of ['accept', 'ignore', 'unavailable']) {
    // accept 还要 worktree_name，见下一条；这里只验 decision 的枚举放行。
    assert.ok(AssessmentSchema.safeParse({ ...base, decision, ...decision === 'accept' ? { worktree_name: 'fix-typo' } : {} }).success, decision)
  }
  for (const decision of ['reopen', 'stop']) {
    equal(AssessmentSchema.safeParse({ ...base, decision }).success, false, decision)
  }
  // 上游把 ticket 绑定留在 decision 之外：多余键被 strict 拒绝。
  equal(AssessmentSchema.safeParse({ ...base, decision: 'ignore', ticket_id: 't' }).success, false)
  match(AssessmentSchema.safeParse({ ...base, decision: 'reopen' }).error!.issues[0]!.message, /expected one of "accept"\|"ignore"\|"unavailable"/)
})

test('AssessmentSchema：接单必须给 worktree_name 的条件、重复规则 id、标题长度', () => {
  const accept = { decision: 'accept', rule_assessments: [{ rule_id: 'copy', reason: 'typo', matched: true }], direction: DIRECTION,
    title: 'Fix typo', scope: 'Fix the typo.', reason: 'typo fix', intent_evidence: 'please fix the typo' }
  // 方向已定且至少一条规则命中：没 worktree_name 就拒。
  equal(AssessmentSchema.safeParse(accept).success, false)
  assert.ok(AssessmentSchema.safeParse({ ...accept, worktree_name: 'fix-typo' }).success)
  // 没有规则命中时，accept 本来就会在策略层降级，不要求名字。
  assert.ok(AssessmentSchema.safeParse({ ...accept, rule_assessments: [{ ...accept.rule_assessments[0], matched: false }] }).success)
  // 同一规则报两次：refine 拒绝。
  equal(AssessmentSchema.safeParse({ ...accept, worktree_name: 'fix-typo',
    rule_assessments: [accept.rule_assessments[0], accept.rule_assessments[0]] }).success, false)
  // title 上限 160。
  equal(AssessmentSchema.safeParse({ ...accept, worktree_name: 'fix-typo', title: 'x'.repeat(161) }).success, false)
  equal(WorktreeNameSchema.safeParse('fix-plan-color').success, true)
  equal(WorktreeNameSchema.safeParse('Fix-Typo').success, false)
  equal(WorktreeNameSchema.safeParse('a-b-c-d-e').success, false)
  equal(WorktreeNameSchema.safeParse('改错别字').success, false)
})

test('EvalReadSchema：四个专属参数各管各的，offset 默认 0，多余键拒绝', () => {
  const read = (args: any) => EvalReadSchema.safeParse({ trigger_id: 'issue-1', ...args })
  const thread = read({ resource: 'thread' })
  assert.ok(thread.success)
  equal((thread as { data?: { offset?: number } }).data?.offset, 0)
  assert.ok(read({ resource: 'file', path: 'src/value.ts' }).success)
  assert.ok(read({ resource: 'message', message_id: 'm1' }).success)
  assert.ok(read({ resource: 'thread', cursor: '2' }).success)
  assert.ok(read({ resource: 'image', image_id: 'm0/img-1' }).success)
  // 互斥关系与上游文案一致。
  match(read({ resource: 'file' }).error!.issues[0]!.message, /path is required only for file\/directory/)
  match(read({ resource: 'message', path: 'src/value.ts' }).error!.issues[0]!.message, /path is required only for file\/directory/)
  match(read({ resource: 'thread', cursor: '2', message_id: 'm1' }).error!.issues[0]!.message, /message_id is only for message/)
  match(read({ resource: 'message', cursor: '2' }).error!.issues[0]!.message, /cursor is only for thread/)
  match(read({ resource: 'image' }).error!.issues[0]!.message, /Images require image_id/)
  equal(read({ resource: 'thread', extra: true }).success, false)
})

test('admission 提示词不再提 reopen / decision=stop', () => {
  match(mainAdmissionPolicy, /orchestrator_eval_decide/)
  equal(/reopen|decision=stop/.test(mainAdmissionPolicy), false)
})

// ── 越权与缺失 ────────────────────────────────────────────────────────────────

test('明确候选转路由：context / read / decide 三处都拒，并点名 orchestrator_route', async () => {
  const { assessor } = setup({ candidate: makeCandidate([trigger(1)], { strength: 'explicit' }) })
  const routed = /orchestrator_route with its trigger_id and kind accept, attach, stop or ignore/
  await rejects(assessor.context('issue-1', SIGNAL), routed)
  await rejects(assessor.read({}, EvalReadSchema.parse({ trigger_id: 'issue-1', resource: 'message' }), SIGNAL), routed)
  await rejects(assessor.decide('issue-1', { decision: 'ignore', rule_assessments: [], direction: DIRECTION, title: 't', scope: 's',
    reason: 'r' }, SIGNAL), routed)
})

test('没有在判定中的 Trigger：说明已判定 / 超时 / 从未进入判定', async () => {
  const { assessor } = setup({ candidate: null })
  await rejects(assessor.context('issue-1', SIGNAL), /No assessment is in progress for this trigger; it was already decided, timed out, or never reached assessment/)
})

test('来源不给线程上下文：context 带 error、read thread 拒、trigger 自己的正文仍可读', async () => {
  const { assessor } = setup({ thread: null })
  const context = await assessor.context('issue-1', SIGNAL)
  match(context.thread.error, /gives no Thread context/)
  equal(context.thread.complete, false)
  await rejects(assessor.read({}, EvalReadSchema.parse({ trigger_id: 'issue-1', resource: 'thread' }), SIGNAL),
    /This Source gives no Thread context/)
  const message = await assessor.read({}, EvalReadSchema.parse({ trigger_id: 'issue-1', resource: 'message' }), SIGNAL)
  equal(message.text, 'issue 1')
})

// ── 上下文装载顺序与窗口渲染 ─────────────────────────────────────────────────

test('初始窗口：不带判定说明，trigger 只给一次，两个近邻 1200 字符、其他 400、窗外只留 50 字符预览', async () => {
  const bodies = Array.from({ length: 30 }, (_, i) => `comment ${i}: ${'the label reads oddly on the settings page. '.repeat(i % 4 === 0 ? 40 : 3)}`)
  const messages = bodies.map((body, i) => ({ id: `https://github.com/acme/widgets/issues/1#c${i}`, from: 'bob',
    at: new Date(Date.UTC(2026, 8, 9, 0, 0, i)).toISOString(), text: body }))
  const thread = makeThread({ messageId: messages[15]!.id, pages: (cursor: string | undefined) => cursor === undefined
    ? { messages: messages.slice(0, 20), next: 'p2', body: { messages: messages.slice(0, 20) } }
    : { messages: messages.slice(20), body: { messages: messages.slice(20) } } }).thread
  const at15 = trigger(1, { id: 'c15', text: bodies[15], url: messages[15]!.id, meta: { number: 1, kind: 'comment' } })
  const { assessor } = setup({ candidate: makeCandidate([at15]), thread })
  const result = await assessor.context('c15', SIGNAL)
  // 判定说明在主会话提示词里，不在载荷里。
  equal('instructions' in result, false)
  equal(result.text, bodies[15])
  deepEqual(result.thread, { complete: true, loaded_messages: 30, source_found: true,
    messages: result.thread.messages })
  const byId = new Map(result.thread.messages.map((message: any) => [message.id, message]))
  const at = (index: number) => byId.get(messages[index]!.id)
  // trigger 自己那条不重复给正文，只标 trigger。
  deepEqual(at(15), { id: messages[15]!.id, from: 'bob', at: messages[15]!.at, trigger: true })
  // 两个最近邻按 1200 截、次近邻按 400 截；短消息不截。
  deepEqual(at(16), { id: messages[16]!.id, from: 'bob', at: messages[16]!.at,
    text: `${bodies[16]!.slice(0, 1200)}…`, chars: bodies[16]!.length })
  deepEqual(at(12), { id: messages[12]!.id, from: 'bob', at: messages[12]!.at,
    text: `${bodies[12]!.slice(0, 400)}…`, chars: bodies[12]!.length })
  deepEqual(at(14), { id: messages[14]!.id, from: 'bob', at: messages[14]!.at, text: bodies[14] })
  // 窗外消息只是 stub，可按 id 用 orchestrator_eval_read 读全文。
  deepEqual(at(8), { id: messages[8]!.id, from: 'bob', preview: bodies[8]!.replace(/\s+/g, ' ').slice(0, 50) })
  assert.ok(JSON.stringify(result).length < 9000)
})

test('有界窗口以续读游标结尾，能从它接着读；batch 只带摘要与 read 指针', async () => {
  const page = (cursor: string | undefined) => {
    const n = cursor === undefined ? 0 : Number(cursor)
    const message = { id: `m${n}`, from: 'bob', at: new Date(Date.UTC(2026, 8, 9, 0, 0, n)).toISOString(), text: `message ${n}` }
    return { messages: [message], next: String(n + 1), body: { messages: [message] } }
  }
  const thread = makeThread({ messageId: 'm0', pages: page }).thread
  const long = trigger(2, { id: 'long', threads: trigger(1).threads, text: 'a long follow-up. '.repeat(40) })
  const { assessor } = setup({ candidate: makeCandidate([trigger(3), long]), thread, deployment: { admissionContextMaxPages: 2 } })
  const result = await assessor.context('issue-3', SIGNAL)
  equal(result.thread.next_cursor, '2')
  equal(result.thread.complete, false)
  equal(result.thread.loaded_messages, 2)
  const more = await assessor.read({}, EvalReadSchema.parse({ trigger_id: 'issue-3', resource: 'thread', cursor: '2' }), SIGNAL)
  const body = JSON.parse(more.text)
  match(JSON.stringify(body), /message 2/)
  deepEqual(body.next_read, { trigger_id: 'issue-3', resource: 'thread', cursor: '3' })
  // batch：另一个触发按 400 截断，带 chars 与 read 指针。
  deepEqual(result.batch, [{ trigger_id: 'long', actor: 'bob', at: long.at, text: `${long.text.slice(0, 400)}…`,
    chars: long.text.length, read: 'trigger/long' }])
  // 短的 batch 项不截断，也不给 chars / read。
  const short = setup({ candidate: makeCandidate([trigger(1), trigger(2)]) })
  const shortResult = await short.assessor.context('issue-1', SIGNAL)
  deepEqual(shortResult.batch, [{ trigger_id: 'issue-2', actor: 'bob', at: trigger(2).at, text: 'issue 2' }])
})

test('trigger 正文超过 4000 字符时截断并给出原长', async () => {
  const long = trigger(1, { text: 'x'.repeat(4500) })
  const thread = makeThread({ messageId: 'm0', messages: [{ id: 'm0', from: 'bob', at: AT, text: long.text }] }).thread
  const { assessor } = setup({ candidate: makeCandidate([long]), thread })
  const result = await assessor.context('issue-1', SIGNAL)
  equal(result.text, `${'x'.repeat(4000)}…`)
  equal(result.chars, 4500)
})

// ── 读口：消息 / 图片 / 文件 / 目录 ───────────────────────────────────────────

test('图片引用：窗口列出 image_id，读图按 offset 0、未知引用与错 offset 各自拒绝', async () => {
  const images = (text: string) => text === 'see @img' ? ['img-1'] : []
  const made = makeThread({ messageId: 'm0',
    messages: [{ id: 'm0', from: 'bob', at: AT, text: 'see @img' }], images })
  const { assessor } = setup({ candidate: makeCandidate([trigger(1, { text: 'see @img' })]), thread: made.thread })
  const context = await assessor.context('issue-1', SIGNAL)
  deepEqual(context.images, ['m0/img-1'])
  const image = await assessor.read({}, EvalReadSchema.parse({ trigger_id: 'issue-1', resource: 'image', image_id: 'm0/img-1' }), SIGNAL)
  deepEqual(image, { dataUrl: 'data:,x' })
  const call = made.calls.image[0]!
  deepEqual(call[2], { id: 'm0', text: 'see @img' })
  equal(call[3], 'img-1')
  equal(call[4], '/tmp/dsh-assessment-test')
  await rejects(assessor.read({}, EvalReadSchema.parse({ trigger_id: 'issue-1', resource: 'image', image_id: 'm0/nope' }), SIGNAL),
    /Unknown image reference/)
  await rejects(assessor.read({}, EvalReadSchema.parse({ trigger_id: 'issue-1', resource: 'image', image_id: 'm0/img-1', offset: 1 }), SIGNAL),
    /Images are not paginated; use offset 0/)
})

test('文件与目录读：走宿主命令，分页要先把 offset 0 读过，隐藏路径拒绝', async () => {
  const { assessor } = setup()
  await assessor.context('issue-1', SIGNAL)
  const file = await assessor.read({}, EvalReadSchema.parse({ trigger_id: 'issue-1', resource: 'file', path: 'src/value.ts' }), SIGNAL)
  equal(file.text, 'export const value = 1\n')
  equal(file.offset, 0)
  equal(file.total_chars, 'export const value = 1\n'.length)
  const page = await assessor.read({}, EvalReadSchema.parse({ trigger_id: 'issue-1', resource: 'file', path: 'src/value.ts', offset: 7 }), SIGNAL)
  equal(page.text, 'export const value = 1\n'.slice(7))
  const directory = await assessor.read({}, EvalReadSchema.parse({ trigger_id: 'issue-1', resource: 'directory', path: 'src' }), SIGNAL)
  equal(directory.text, 'a.ts\nb.ts')
  await rejects(assessor.read({}, EvalReadSchema.parse({ trigger_id: 'issue-1', resource: 'file', path: 'other.ts', offset: 3 }), SIGNAL),
    /Read this resource at offset 0 first/)
  await rejects(assessor.read({}, EvalReadSchema.parse({ trigger_id: 'issue-1', resource: 'file', path: '.env' }), SIGNAL),
    /Only non-hidden repository source paths are available/)
  await rejects(assessor.read({}, EvalReadSchema.parse({ trigger_id: 'issue-1', resource: 'message', message_id: 'nope' }), SIGNAL),
    /Unknown message reference/)
})

// ── 生命周期 ─────────────────────────────────────────────────────────────────

test('判定完成后不保留状态：release 丢掉旧缓存，下一次判定重新装载，候选没了就是「没在判定」', async () => {
  const { assessor, state } = setup()
  await assessor.context('issue-1', SIGNAL)
  equal(assessor.evals.size, 1)
  assert.ok(assessor.evals.has('eval-1'))
  assessor.release('eval-1')
  equal(assessor.evals.size, 0)
  // 同一 trigger 换了新 Eval：新判定自己装载，不继承上一轮的缓存。
  state.candidate = makeCandidate([trigger(1)], { evalId: 'eval-2' })
  await assessor.context('issue-1', SIGNAL)
  equal(assessor.evals.size, 1)
  assert.ok(assessor.evals.has('eval-2'))
  // 候选完全消失后，读口说「没在判定」而不是「已结束」。
  state.candidate = undefined
  await rejects(assessor.read({}, EvalReadSchema.parse({ trigger_id: 'issue-1', resource: 'thread' }), SIGNAL),
    /No assessment is in progress for this trigger/)
})

test('慢读在判定之后才返回：丢弃结果并报「已结束」，不把上下文留在表里', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const thread = {
    messageId: 'm0',
    async read() {
      await gate
      return { messages: [{ id: 'm0', from: 'bob', at: AT, text: 'issue 1' }], body: {} }
    },
    images: () => [],
    async image() { return { dataUrl: 'data:,x' } },
  }
  const { assessor, state } = setup({ thread })
  const details = assessor.context('issue-1', SIGNAL)
  await tick()
  // 判定先落地：候选消失、状态释放，然后慢读才返回。
  state.candidate = undefined
  assessor.release('eval-1')
  release()
  await rejects(details, /This assessment has finished/)
  equal(assessor.evals.size, 0)
})

// ── 结论记录 ─────────────────────────────────────────────────────────────────

test('decide 把 ignore 连同审计交给 Engine.decide，并回传结论与理由', async () => {
  const { assessor, state } = setup({ settings: ONE_RULE })
  const assessment = { decision: 'ignore', rule_assessments: [{ rule_id: 'copy', reason: 'chatter', matched: false }],
    direction: DIRECTION, title: 't', scope: 's', reason: 'chatter' }
  deepEqual(await assessor.decide('issue-1', assessment, SIGNAL), { state: 'ignore', reason: 'chatter' })
  equal(state.decided.length, 1)
  const [triggerId, outcome] = state.decided[0]
  equal(triggerId, 'issue-1')
  equal(outcome.kind, 'ignore')
  equal(outcome.evalId, 'eval-1')
  deepEqual(outcome.audit.rule_assessments, assessment.rule_assessments)
  deepEqual(outcome.audit.direction, DIRECTION)
})

test('推断候选在 observe 模式接单会降级成 ignore，并留下 would_accept 提案', async () => {
  const { assessor, state } = setup({ settings: ONE_RULE })
  const assessment = { decision: 'accept', rule_assessments: [{ rule_id: 'copy', reason: 'typo', matched: true }],
    direction: DIRECTION, title: 'Fix typo', scope: 'Fix the typo.', reason: 'typo fix', intent_evidence: 'please fix the typo',
    worktree_name: 'fix-typo' }
  const result = await assessor.decide('issue-1', assessment, SIGNAL)
  equal(result.state, 'ignore')
  equal(result.reason, 'Observe mode: would accept (typo fix)')
  const outcome = state.decided[0][1]
  equal(outcome.kind, 'ignore')
  equal(outcome.audit.would_accept, true)
  deepEqual(outcome.audit.proposal, { title: 'Fix typo', scope: 'Fix the typo.', worktree_name: 'fix-typo' })
})

test('auto 模式接受：worktree 名与回执一起进结论；回执超词在交给引擎前就拒', async () => {
  const settings = SettingsSchema.parse({ eval: { mode: 'auto' }, policy: { rules: ONE_RULE.policy.rules } })
  const { assessor, state } = setup({ settings })
  const assessment = { decision: 'accept', rule_assessments: [{ rule_id: 'copy', reason: 'typo', matched: true }],
    direction: DIRECTION, title: 'Fix typo', scope: 'Fix the typo.', reason: 'typo fix', intent_evidence: 'please fix the typo',
    worktree_name: 'fix-typo', acknowledgement: '收到。' }
  deepEqual(await assessor.decide('issue-1', assessment, SIGNAL),
    { state: 'accept', ticket_id: 'ticket-1', reason: 'typo fix' })
  const outcome = state.decided[0][1]
  equal(outcome.kind, 'accept')
  equal(outcome.name, 'fix-typo')
  equal(outcome.acknowledgement, '收到。')
  deepEqual(outcome.rules, ['copy'])
  // 回执按 IM 词数上限卡，超了就不交给引擎。
  const long = setup({ settings })
  await rejects(long.assessor.decide('issue-1', { ...assessment, acknowledgement: Array.from({ length: 101 }, () => 'word').join(' ') },
    SIGNAL), /IM message has 101 words; maximum is 100/)
  equal(long.state.decided.length, 0)
})

// ── 候选卡片投递 ──────────────────────────────────────────────────────────────

test('构造函数注册 assessment 处理器：按 evalId 幂等投递候选卡片，错 eval 不投', async () => {
  const { assessor, state } = setup()
  equal(state.handlers.length, 1)
  const handler = state.handlers[0]
  equal(handler.kind, 'assessment')
  equal(handler.handlerOptions.limit(), 4)
  equal(setup({ paused: () => true }).state.handlers[0].handlerOptions.limit(), 0)
  await handler.run({ triggerId: 'issue-1' }, 'eval-1')
  equal(state.delivered.length, 1)
  equal(state.delivered[0][0], 'candidate:eval-1')
  deepEqual(JSON.parse(state.delivered[0][1]), { kind: 'candidate', eval_id: 'eval-1' })
  deepEqual(state.decided, [['delivered', 'eval-1']])
  // evalId 对不上（已被更新的一次判定取代）就不投。
  await handler.run({ triggerId: 'issue-1' }, 'eval-other')
  equal(state.delivered.length, 1)
  // request 只是把 assessment 效果入队。
  assessor.request(makeCandidate([trigger(1)]))
  deepEqual(state.enqueued, [['assessment', 'eval-1', { triggerId: 'issue-1' }]])
})
