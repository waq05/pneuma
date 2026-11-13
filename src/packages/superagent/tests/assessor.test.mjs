/**
 * @pneuma/superagent 的判定器用例：配了模型走模型、没配就一步都不多走。
 *
 * 这一层最容易出的错不是「判错」，而是「悄悄多了一次模型请求」和「模型输出不合形状时
 * 把整拍打断」。所以断言的重点是：
 *   - 没配模型时，一次模型调用都不能发生（默认形态必须与 P0 逐字一致）；
 *   - 配了模型但宿主没给出口时，退回同步规则，不抛错；
 *   - 模型版必须先记 `candidateDelivered` 再等模型（否则 Eval 永远不会过期）；
 *   - 模型输出不合形状、少判一条规则、缺 intent_evidence，都只落成「这一条判不了」，
 *     不 decide、不抛到泵上。
 *
 * 全程不联网：模型用注入的假函数，引擎用假对象。不读真实 `~/.dsc`。
 *
 * @module @pneuma/superagent/tests/assessor
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'superagent-assessor-home-'))
process.env['DSC_HOME'] = home

const { defaultSettings } = await import('../../../../lib/packages/superagent/adapters/settings.js')
const { selectAssessor } = await import('../../../../lib/packages/superagent/adapters/assessor-select.js')
const { ModelAssessor, assessmentPrompt } = await import('../../../../lib/packages/superagent/adapters/assessor-model.js')

after(() => { rmSync(home, { recursive: true, force: true }) })

/** 一条手动来源的明确请求。 */
function trigger(overrides = {}) {
  return {
    id: 'trg-1',
    source: 'manual',
    threads: [{ source: 'manual', id: 'manual:trg-1' }],
    actor: { source: 'manual', id: 'operator' },
    human: true,
    addressed: 'direct',
    at: '2026-01-01T00:00:00.000Z',
    text: '把这个错别字改掉',
    meta: { title: '改错别字' },
    ...overrides,
  }
}

/** 一条候选（`Candidate` 只需要这几项就能判定）。 */
function candidate(overrides = {}) {
  return {
    evalId: 'eval-1',
    strength: 'explicit',
    triggers: [trigger()],
    // 候选收件箱要按线程分组（G1 的 `HeldCandidate.threadKey`），判定本身不读它。
    thread: { key: 'manual:trg-1', ref: { source: 'manual', id: 'manual:trg-1' } },
    ...overrides,
  }
}

/**
 * 自动接单模式的设置。
 *
 * 为什么推断候选的用例要用它：`assessmentOutcome` 在 `mode !== 'auto'` 时把推断强度的
 * accept 降成 `ignore`（带 `would_accept`，`core/policy.ts` 的 `observed` 那一支），
 * 根本到不了收件箱。默认设置是 `observe`。
 */
function autoSettings() {
  const settings = defaultSettings()
  return { ...settings, eval: { ...settings.eval, mode: 'auto' } }
}

/**
 * 假引擎：记下三件事——是否记了「候选已投递」、decide 收到了什么、candidate 读到了什么。
 *
 * `delivered` 与 `decide` 的先后顺序也要能看见，所以都记进同一个序列。
 */
function fakeEngine(givenCandidate) {
  const calls = { delivered: [], decisions: [], sequence: [] }
  const engine = {
    candidate: () => givenCandidate,
    candidateDelivered: (evalId) => { calls.delivered.push(evalId); calls.sequence.push('delivered') },
    decide: (triggerId, outcome) => {
      calls.decisions.push({ triggerId, outcome })
      calls.sequence.push('decide')
      return { ticketId: 'tkt-1' }
    },
  }
  return { engine, calls }
}

/** 一份形状正确的模型回复（两条启用规则各判一次，接单且方向明确）。 */
function acceptReply(overrides = {}) {
  return JSON.stringify({
    decision: 'accept',
    // 方向是核心的契约（`core/policy.ts:30-35`）：要改代码、目标说得清、不用另定设计，才算方向成立。
    direction: {
      implementation_requested: true,
      target_basis: 'existing-standard',
      requires_design_decision: false,
      evidence: '把这个错别字改掉',
    },
    rule_assessments: [
      { rule_id: 'copy', matched: true, reason: '明确要求改错别字' },
      { rule_id: 'visual', matched: false, reason: '不涉及样式' },
    ],
    title: '改错别字',
    scope: 'README.md',
    reason: '属于错别字修正',
    intent_evidence: '把这个错别字改掉',
    ...overrides,
  })
}

/** 造一个模型版判定器，`reply` 可以是字符串或函数。 */
function modelAssessor(reply, extra = {}) {
  const prompts = []
  const errors = []
  const logs = []
  const assessor = new ModelAssessor({
    complete: async (prompt) => {
      prompts.push(prompt)
      return typeof reply === 'function' ? reply(prompt) : reply
    },
    settings: () => defaultSettings(),
    onError: (error, evalId) => errors.push({ error, evalId }),
    log: (line) => logs.push(line),
    ...extra,
  })
  return { assessor, prompts, errors, logs }
}

// ── 1. 默认形态：不配模型就一次模型请求都不发 ───────────────────────────────

test('没配模型：走同步规则，一次模型调用都不发生', async () => {
  let called = 0
  const assessor = selectAssessor({
    model: null,
    settings: () => defaultSettings(),
    complete: async () => { called += 1; return acceptReply() },
  })
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  const created = assessor.drain(engine)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(called, 0, '没配模型时不许发请求')
  assert.deepEqual(created, ['tkt-1'])
  assert.equal(calls.decisions.length, 1)
  assert.equal(calls.decisions[0].outcome.kind, 'accept')
  assert.deepEqual(calls.delivered, [], '同步规则不需要「候选已投递」——它当场就判完了')
})

test('配了模型但宿主没给出口：退回同步规则，不抛错', async () => {
  const assessor = selectAssessor({ model: { provider: 'p', model: 'm' }, settings: () => defaultSettings() })
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  const created = assessor.drain(engine)
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(created, ['tkt-1'], '退回的是同步那一支，当场就能建单')
  assert.equal(calls.decisions.length, 1)
})

// ── 2. 模型版：先投递再等模型 ───────────────────────────────────────────────

test('模型版：先记「候选已投递」再问模型，回复合规就 decide', async () => {
  const { assessor, prompts, errors } = modelAssessor(acceptReply())
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  await assessor.drainAsync(engine)

  assert.equal(errors.length, 0, JSON.stringify(errors.map((item) => String(item.error))))
  assert.deepEqual(calls.delivered, ['eval-1'], '必须先记投递，截止时间才从这一刻开始算')
  assert.equal(calls.decisions.length, 1)
  const { outcome } = calls.decisions[0]
  assert.equal(outcome.kind, 'accept')
  assert.deepEqual(outcome.rules, ['copy'])
  assert.equal(outcome.title, '改错别字')
  assert.equal(outcome.evalId, 'eval-1')
  assert.deepEqual(calls.sequence, ['delivered', 'decide'], '顺序错了等于没有截止时间')

  // 提示词把启用规则原文与请求正文都带上，判定才有依据。
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /copy/)
  assert.match(prompts[0], /visual/)
  assert.match(prompts[0], /把这个错别字改掉/)
})

test('模型版：回复带 Markdown 围栏也能解析', async () => {
  const { assessor, errors } = modelAssessor('```json\n' + acceptReply() + '\n```')
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  await assessor.drainAsync(engine)
  assert.equal(errors.length, 0)
  assert.equal(calls.decisions.length, 1)
})

// ── 3. 模型输出不可信：三种坏输入都只落成「这一条判不了」 ────────────────────

test('模型版：输出不是 JSON → 记一条日志，不 decide，不抛', async () => {
  const { assessor, errors, logs } = modelAssessor('我觉得可以接这一单。')
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  await assessor.drainAsync(engine)

  assert.equal(calls.decisions.length, 0)
  assert.equal(errors.length, 0, '不合形状不算异常，不该走 onError')
  assert.equal(logs.length, 1)
  assert.match(logs[0], /不合形状/)
})

test('模型版：少判一条启用规则 → 核心拒收，走 onError，不 decide', async () => {
  const reply = acceptReply({ rule_assessments: [{ rule_id: 'copy', matched: true, reason: '改错别字' }] })
  const { assessor, errors } = modelAssessor(reply)
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  await assessor.drainAsync(engine)

  assert.equal(calls.decisions.length, 0, '少判一条规则时不许拿半份判定去建单')
  assert.equal(errors.length, 1)
  assert.match(String(errors[0].error.message ?? errors[0].error), /every enabled rule/)
})

test('模型版：说接单却没有 intent_evidence → 核心拒收', async () => {
  const reply = acceptReply({ intent_evidence: null })
  const { assessor, errors } = modelAssessor(reply)
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  await assessor.drainAsync(engine)

  assert.equal(calls.decisions.length, 0)
  assert.equal(errors.length, 1)
  assert.match(String(errors[0].error.message ?? errors[0].error), /intent_evidence/)
})

// ── 4. 幂等：同一个 Eval 不重复问模型 ───────────────────────────────────────

test('模型版：同一个 Eval 投递两次只问一次模型', async () => {
  const { assessor, prompts } = modelAssessor(acceptReply())
  const { engine } = fakeEngine(candidate())
  assessor.request(candidate())
  await assessor.drainAsync(engine)
  // 第二拍：队列里已经没有它了。
  await assessor.drainAsync(engine)
  assert.equal(prompts.length, 1)
})

test('模型版：在飞时再投递同一 Eval 不会重复问', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { assessor, prompts } = modelAssessor(async () => { await gate; return acceptReply() })
  const { engine } = fakeEngine(candidate())
  assessor.request(candidate())
  const first = assessor.drainAsync(engine)
  assessor.request(candidate())
  await assessor.drainAsync(engine)
  release()
  await first
  assert.equal(prompts.length, 1, '在飞期间不该再排一次')
})

// ── 5. 提示词本身 ───────────────────────────────────────────────────────────

// ── G1：推断候选挂起等人点头 ──────────────────────────────────────────────
//
// 开了「先等我确认」时，推断强度的 accept 不直接建工单：先交给收件箱，并把 Eval
// 结束掉（记一条 ignore）——不结束它会挂到超时、重排、再判一次、再进一次收件箱。
test('模型版：开了先确认，推断候选挂起而不建工单', async () => {
  const held = []
  const { assessor, errors } = modelAssessor(acceptReply(), {
    settings: () => autoSettings(),
    holdCandidate: (hold) => held.push(hold),
  })
  const inferred = candidate({ strength: 'inferred' })
  const { engine, calls } = fakeEngine(inferred)
  assessor.request(inferred)
  await assessor.drainAsync(engine)

  assert.equal(errors.length, 0, JSON.stringify(errors.map((item) => String(item.error))))
  assert.equal(held.length, 1, '候选要交给收件箱')
  assert.equal(held[0].evalId, 'eval-1')
  assert.equal(held[0].triggerId, 'trg-1')
  assert.equal(held[0].title, '改错别字')
  assert.equal(held[0].source, 'manual')
  assert.equal(held[0].outcome.kind, 'accept', '交出去的是原样的 accept 结论')
  assert.equal(calls.decisions.length, 1, 'Eval 要结束，否则会挂到超时重排')
  assert.equal(calls.decisions[0].outcome.kind, 'ignore', '记一条 ignore 表示这次判定没有接单')
})

// 明确请求不走收件箱：那是人自己敲的，不需要再问一次。
test('模型版：开了先确认，明确请求照旧直接接单', async () => {
  const held = []
  const { assessor, errors } = modelAssessor(acceptReply(), {
    settings: () => autoSettings(),
    holdCandidate: (hold) => held.push(hold),
  })
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  await assessor.drainAsync(engine)

  assert.equal(errors.length, 0, JSON.stringify(errors.map((item) => String(item.error))))
  assert.deepEqual(held, [], '明确请求不该进收件箱')
  assert.equal(calls.decisions.length, 1)
  assert.equal(calls.decisions[0].outcome.kind, 'accept', '照旧直接接单')
})

// 没开「先等我确认」时，推断候选也照旧判定即接单（与上游一致）。
test('模型版：没开先确认，推断候选判定即接单', async () => {
  const { assessor, errors } = modelAssessor(acceptReply(), { settings: () => autoSettings() })
  const inferred = candidate({ strength: 'inferred' })
  const { engine, calls } = fakeEngine(inferred)
  assessor.request(inferred)
  await assessor.drainAsync(engine)

  assert.equal(errors.length, 0, JSON.stringify(errors.map((item) => String(item.error))))
  assert.equal(calls.decisions.length, 1)
  assert.equal(calls.decisions[0].outcome.kind, 'accept')
})

test('提示词：把每条启用规则的原文与请求正文都写进去', () => {
  const settings = defaultSettings()
  const prompt = assessmentPrompt(trigger(), settings)
  for (const rule of settings.policy.rules.filter((item) => item.enabled)) {
    assert.ok(prompt.includes(rule.id), `缺规则 ${rule.id}`)
    assert.ok(prompt.includes(rule.instruction.slice(0, 40)), `缺规则 ${rule.id} 的说明原文`)
  }
  assert.match(prompt, /只输出一个 JSON 对象/)
  assert.match(prompt, /rule_assessments/)
})
