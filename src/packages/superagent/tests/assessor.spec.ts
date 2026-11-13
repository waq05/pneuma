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
 * 迁移说明：原文件 import `lib/` 构建产物；现在直接 import 源码。
 *
 * @module @pneuma/superagent/tests/assessor
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { Engine, Candidate } from '../core/index.js'
import type { ModelAssessorOptions } from '../adapters/assessor-model.js'
import type { Trigger } from '../core/model.js'

const home = mkdtempSync(join(tmpdir(), 'superagent-assessor-home-'))
process.env['DSC_HOME'] = home

const { defaultSettings } = await import('../adapters/settings.js')
const { selectAssessor } = await import('../adapters/assessor-select.js')
const { ModelAssessor, assessmentPrompt } = await import('../adapters/assessor-model.js')

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 一条手动来源的明确请求。 */
function trigger(overrides: Record<string, unknown> = {}): Trigger {
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
  } as unknown as Trigger
}

/** 一条候选（`Candidate` 只需要这几项就能判定；线程与工单列表本文件用不到）。 */
function candidate(overrides: Record<string, unknown> = {}): Candidate {
  return { evalId: 'eval-1', strength: 'explicit', triggers: [trigger()], ...overrides } as unknown as Candidate
}

/** decide 收到的结果里测试读得到的字段。 */
interface RecordedOutcome {
  kind: string
  rules?: string[]
  title?: string
  evalId?: string
}

/** 假引擎记下的调用。 */
interface EngineCalls {
  delivered: string[]
  decisions: Array<{ triggerId: string; outcome: RecordedOutcome }>
  sequence: string[]
}

/**
 * 假引擎：记下三件事——是否记了「候选已投递」、decide 收到了什么、candidate 读到了什么。
 *
 * `delivered` 与 `decide` 的先后顺序也要能看见，所以都记进同一个序列。
 */
function fakeEngine(givenCandidate: Candidate): { engine: Engine; calls: EngineCalls } {
  const calls: EngineCalls = { delivered: [], decisions: [], sequence: [] }
  const engine = {
    candidate: () => givenCandidate,
    candidateDelivered: (evalId: string) => {
      calls.delivered.push(evalId)
      calls.sequence.push('delivered')
    },
    decide: (triggerId: string, outcome: RecordedOutcome) => {
      calls.decisions.push({ triggerId, outcome })
      calls.sequence.push('decide')
      return { ticketId: 'tkt-1' }
    },
  }
  return { engine: engine as unknown as Engine, calls }
}

/** 一份形状正确的模型回复（两条启用规则各判一次，接单且方向明确）。 */
function acceptReply(overrides: Record<string, unknown> = {}): string {
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
function modelAssessor(
  reply: string | ((prompt: string) => string | Promise<string>),
  extra: Partial<ModelAssessorOptions> = {},
): { assessor: InstanceType<typeof ModelAssessor>; prompts: string[]; errors: Array<{ error: unknown; evalId: string }>; logs: string[] } {
  const prompts: string[] = []
  const errors: Array<{ error: unknown; evalId: string }> = []
  const logs: string[] = []
  const assessor = new ModelAssessor({
    complete: async (prompt: string) => {
      prompts.push(prompt)
      return typeof reply === 'function' ? reply(prompt) : reply
    },
    settings: () => defaultSettings(),
    onError: (error: unknown, evalId: string) => errors.push({ error, evalId }),
    log: (line: string) => logs.push(line),
    ...extra,
  })
  return { assessor, prompts, errors, logs }
}

/** 把 unknown 异常压成一行文本，供正则断言用。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// ── 1. 默认形态：不配模型就一次模型请求都不发 ───────────────────────────────

test('没配模型：走同步规则，一次模型调用都不发生', async () => {
  let called = 0
  const assessor = selectAssessor({
    model: null,
    settings: () => defaultSettings(),
    complete: async () => {
      called += 1
      return acceptReply()
    },
  })
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  const created = assessor.drain(engine)
  await new Promise((resolve) => setImmediate(resolve))

  expect(called, '没配模型时不许发请求').toBe(0)
  expect(created).toStrictEqual(['tkt-1'])
  expect(calls.decisions.length).toBe(1)
  expect(calls.decisions[0].outcome.kind).toBe('accept')
  expect(calls.delivered, '同步规则不需要「候选已投递」——它当场就判完了').toStrictEqual([])
})

test('配了模型但宿主没给出口：退回同步规则，不抛错', async () => {
  const assessor = selectAssessor({ model: { provider: 'p', model: 'm' }, settings: () => defaultSettings() })
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  const created = assessor.drain(engine)
  await new Promise((resolve) => setImmediate(resolve))

  expect(created, '退回的是同步那一支，当场就能建单').toStrictEqual(['tkt-1'])
  expect(calls.decisions.length).toBe(1)
})

// ── 2. 模型版：先投递再等模型 ───────────────────────────────────────────────

test('模型版：先记「候选已投递」再问模型，回复合规就 decide', async () => {
  const { assessor, prompts, errors } = modelAssessor(acceptReply())
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  await assessor.drainAsync(engine)

  expect(errors.length, JSON.stringify(errors.map((item) => messageOf(item.error)))).toBe(0)
  expect(calls.delivered, '必须先记投递，截止时间才从这一刻开始算').toStrictEqual(['eval-1'])
  expect(calls.decisions.length).toBe(1)
  const { outcome } = calls.decisions[0]
  expect(outcome.kind).toBe('accept')
  expect(outcome.rules).toStrictEqual(['copy'])
  expect(outcome.title).toBe('改错别字')
  expect(outcome.evalId).toBe('eval-1')
  expect(calls.sequence, '顺序错了等于没有截止时间').toStrictEqual(['delivered', 'decide'])

  // 提示词把启用规则原文与请求正文都带上，判定才有依据。
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toMatch(/copy/)
  expect(prompts[0]).toMatch(/visual/)
  expect(prompts[0]).toMatch(/把这个错别字改掉/)
})

test('模型版：回复带 Markdown 围栏也能解析', async () => {
  const { assessor, errors } = modelAssessor('```json\n' + acceptReply() + '\n```')
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  await assessor.drainAsync(engine)
  expect(errors.length).toBe(0)
  expect(calls.decisions.length).toBe(1)
})

// ── 3. 模型输出不可信：三种坏输入都只落成「这一条判不了」 ────────────────────

test('模型版：输出不是 JSON → 记一条日志，不 decide，不抛', async () => {
  const { assessor, errors, logs } = modelAssessor('我觉得可以接这一单。')
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  await assessor.drainAsync(engine)

  expect(calls.decisions.length).toBe(0)
  expect(errors.length, '不合形状不算异常，不该走 onError').toBe(0)
  expect(logs.length).toBe(1)
  expect(logs[0]).toMatch(/不合形状/)
})

test('模型版：少判一条启用规则 → 核心拒收，走 onError，不 decide', async () => {
  const reply = acceptReply({ rule_assessments: [{ rule_id: 'copy', matched: true, reason: '改错别字' }] })
  const { assessor, errors } = modelAssessor(reply)
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  await assessor.drainAsync(engine)

  expect(calls.decisions.length, '少判一条规则时不许拿半份判定去建单').toBe(0)
  expect(errors.length).toBe(1)
  expect(messageOf(errors[0].error)).toMatch(/every enabled rule/)
})

test('模型版：说接单却没有 intent_evidence → 核心拒收', async () => {
  const reply = acceptReply({ intent_evidence: null })
  const { assessor, errors } = modelAssessor(reply)
  const { engine, calls } = fakeEngine(candidate())
  assessor.request(candidate())
  await assessor.drainAsync(engine)

  expect(calls.decisions.length).toBe(0)
  expect(errors.length).toBe(1)
  expect(messageOf(errors[0].error)).toMatch(/intent_evidence/)
})

// ── 4. 幂等：同一个 Eval 不重复问模型 ───────────────────────────────────────

test('模型版：同一个 Eval 投递两次只问一次模型', async () => {
  const { assessor, prompts } = modelAssessor(acceptReply())
  const { engine } = fakeEngine(candidate())
  assessor.request(candidate())
  await assessor.drainAsync(engine)
  // 第二拍：队列里已经没有它了。
  await assessor.drainAsync(engine)
  expect(prompts.length).toBe(1)
})

test('模型版：在飞时再投递同一 Eval 不会重复问', async () => {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { assessor, prompts } = modelAssessor(async () => {
    await gate
    return acceptReply()
  })
  const { engine } = fakeEngine(candidate())
  assessor.request(candidate())
  const first = assessor.drainAsync(engine)
  assessor.request(candidate())
  await assessor.drainAsync(engine)
  release()
  await first
  expect(prompts.length, '在飞期间不该再排一次').toBe(1)
})

// ── 5. 提示词本身 ───────────────────────────────────────────────────────────

test('提示词：把每条启用规则的原文与请求正文都写进去', () => {
  const settings = defaultSettings()
  const prompt = assessmentPrompt(trigger(), settings)
  for (const rule of settings.policy.rules.filter((item) => item.enabled)) {
    expect(prompt, `缺规则 ${rule.id}`).toContain(rule.id)
    expect(prompt, `缺规则 ${rule.id} 的说明原文`).toContain(rule.instruction.slice(0, 40))
  }
  expect(prompt).toMatch(/只输出一个 JSON 对象/)
  expect(prompt).toMatch(/rule_assessments/)
})
