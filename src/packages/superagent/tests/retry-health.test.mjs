/**
 * @pneuma/superagent 重试健康投影的包级测试：从会话事件流推算「哪个会话正卡在模型预算重试」，
 * 覆盖预算失败识别、会话/链路隔离、乱序与重复事件、中断输出、边界事件、快照重建、字段上限与脱敏。
 *
 * 为什么这些要单独钉：这块只读事件、不改重试策略，判错不抛错，只会让健康面板显示/不显示一条重试。
 * 最容易错的三处：把限流、鉴权、上下文超限误认成预算（白等一轮）；旧供应商的成功消息把当前链路清掉；
 * 把 `failure` 原文或 `policyKey` 带进投影（泄露提示词与服务端数据）。所以每条都断言「准不准、有没有漏」。
 *
 * 假的只有事件对象：`RetryHealth` 只读 `{type, seq, time, data}` 五个字段，所以这里用对象字面量造事件，
 * 不拉 `@deepseek-ai/dsh-llm` / `dsh-session` 的真包（本仓没装这两个依赖）。成功事件的 `message.source`
 * 按实现判据写成 `{ kind: 'model', provider, model }`，与上游 `createAssistantMessage` 的产物同形。
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/retry-health
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { RetryHealth } = await import('../../../../lib/packages/superagent/app/retry-health.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

const epoch = Date.parse('2026-09-21T08:00:00Z')
const event = (type, seq, data) => ({ type, seq, time: epoch + seq * 1000, data })

/** 一次预算重试事件；`data` 覆盖默认值。 */
const retry = (seq, data = {}) => event('llm/retry', seq, {
  retryId: 'chain-a', turn: 1, step: 2, provider: 'provider-a', mode: 'always', retry: 1, policyKey: 'opaque', delayMs: 10000,
  failure: { code: 'INVALID_REQUEST', message: 'OpenAI API error (400): {"type":"budget_exceeded","message":"Budget has been exceeded! Current cost: 100, Max budget: 99","secret":"never disclose"}' },
  ...data,
})
/** 一次成功输出；默认是触发重试的那一轮、那一步、那个供应商。 */
const success = (seq, turn = 1, step = 2, provider = 'provider-a') => ({
  type: 'assistant/message', seq, time: epoch + seq * 1000, surfaceOp: 'append',
  data: { turn, step, stream: [], message: { content: [], source: { kind: 'model', provider, model: 'test-model' } } },
})

// ── 1. 基本投影与脱敏 ───────────────────────────────────────────────────────

test('按重试次数投影状态，但不带出失败原文与策略数据', () => {
  const health = new RetryHealth()
  health.observe('worker-a', retry(1))
  health.observe('worker-a', event('llm/retry-started', 2, { retryId: 'chain-a', turn: 1, step: 2, retry: 1 }))
  assert.deepEqual(health.get('worker-a'), {
    sessionId: 'worker-a', provider: 'provider-a', attempts: 1,
    since: '2026-09-21T08:00:01.000Z', lastAt: '2026-09-21T08:00:01.000Z',
  })
  health.observe('worker-a', retry(3, { retry: 345 }))
  assert.deepEqual(health.get('worker-a'), {
    sessionId: 'worker-a', provider: 'provider-a', attempts: 345,
    since: '2026-09-21T08:00:01.000Z', lastAt: '2026-09-21T08:00:03.000Z',
  }, '同一条链路继续重试：次数与 lastAt 更新，since 保持第一次')
  assert.doesNotMatch(JSON.stringify(health.list()), /secret|Current cost|Max budget|policyKey|failure|chain-a/)
  passed += 1
})

// ── 2. 预算失败识别：结构化元数据与已知文案 ─────────────────────────────────

for (const failure of [
  { type: 'budget_exceeded', message: 'provider omitted body', code: 'INVALID_REQUEST' },
  { code: 'budget_exceeded', message: 'provider omitted body' },
  { code: 'INVALID_REQUEST', message: '{"error":{"type":"budget_exceeded"}}' },
  { code: 'INVALID_REQUEST', message: 'Budget has been exceeded! Current cost: redacted' },
]) {
  test(`认得出预算失败（元数据或已知文案）：${JSON.stringify(failure)}`, () => {
    const health = new RetryHealth()
    health.observe('master', retry(1, { failure }))
    assert.equal(health.get('master')?.attempts, 1)
    passed += 1
  })
}

// ── 3. 别把别的失败当成预算等待 ─────────────────────────────────────────────

for (const failure of [
  { code: 'RATE_LIMIT', status: 429, message: 'Too many requests' },
  { code: 'INVALID_REQUEST', status: 429, message: 'Budget has been exceeded!' },
  { code: 'AUTHENTICATION_ERROR', message: 'Budget has been exceeded!' },
  { code: 'INVALID_REQUEST', status: 401, message: 'Budget has been exceeded!' },
  { code: 'CONTEXT_LENGTH_EXCEEDED', message: 'Context budget has been exceeded!' },
  { code: 'INVALID_REQUEST', message: 'maximum context length exceeded' },
  { code: 'INVALID_REQUEST', message: 'a budget was mentioned in this error but was not exceeded' },
  null,
]) {
  test(`不把另一种失败算成预算等待：${JSON.stringify(failure)}`, () => {
    const health = new RetryHealth()
    health.observe('worker', retry(1, { failure }))
    assert.deepEqual(health.list(), [])
    passed += 1
  })
}

// ── 4. 只认「有排期重试」的失败事件 ─────────────────────────────────────────

test('引用在用户/助手正文里的预算字样不算，失败但没有排期重试也不算', () => {
  const health = new RetryHealth()
  health.observe('worker', event('user/message', 1, { content: [{ type: 'text', text: 'Budget has been exceeded!' }] }))
  health.observe('worker', event('assistant/message', 2, { turn: 1, step: 2, message: { content: [{ type: 'text', text: '{"type":"budget_exceeded"}' }] } }))
  health.observe('worker', event('assistant/attempt', 3, { turn: 1, step: 2, failure: { type: 'budget_exceeded' } }))
  assert.deepEqual(health.list(), [])
  passed += 1
})

// ── 5. 会话隔离与新链路 ─────────────────────────────────────────────────────

test('会话各自独立；换供应商或换链路就重新起一条状态', () => {
  const health = new RetryHealth()
  health.observe('a', retry(1, { retry: 12 }))
  health.observe('b', retry(1, { provider: 'provider-b' }))
  health.observe('a', retry(2, { provider: 'fallback', retry: 1 }))
  assert.deepEqual(health.get('a'), {
    sessionId: 'a', provider: 'fallback', attempts: 1,
    since: '2026-09-21T08:00:02.000Z', lastAt: '2026-09-21T08:00:02.000Z',
  })
  health.observe('a', success(3)) // 旧供应商的输出不能清掉当前链路。
  assert.equal(health.get('a')?.provider, 'fallback')
  health.observe('a', retry(4, { provider: 'fallback', retryId: 'chain-b', retry: 1 }))
  assert.equal(health.get('a')?.since, '2026-09-21T08:00:04.000Z')
  health.observe('a', success(5, 1, 2, 'fallback'))
  assert.equal(health.get('a'), undefined)
  assert.equal(health.get('b')?.provider, 'provider-b', '别的会话不受影响')
  passed += 1
})

// ── 6. 乱序、重复、旧步骤不能改写或清掉当前状态 ─────────────────────────────

test('重复、乱序、上一轮/上一步的事件都不改写也不清掉当前重试', () => {
  const health = new RetryHealth()
  health.observe('worker', retry(5, { step: 3, retry: 2 }))
  health.observe('worker', retry(5, { step: 3, retry: 99 }))
  health.observe('worker', success(4, 1, 3))
  health.observe('worker', success(6, 1, 2))
  health.observe('worker', retry(7, { step: 2, retry: 100 }))
  health.observe('worker', event('turn/end', 8, { turn: 0 }))
  health.observe('worker', retry(9, { step: 3, retry: 1 }))
  assert.deepEqual(health.get('worker'), {
    sessionId: 'worker', provider: 'provider-a', attempts: 2,
    since: '2026-09-21T08:00:05.000Z', lastAt: '2026-09-21T08:00:05.000Z',
  })
  health.observe('worker', success(10, 1, 3))
  assert.equal(health.get('worker'), undefined)
  health.observe('worker', retry(11, { step: 3, retry: 3 }))
  assert.equal(health.get('worker'), undefined, '已经成功结束的回合，晚到的重试事件不能复活状态')
  passed += 1
})

// ── 7. 中断的输出不算成功 ───────────────────────────────────────────────────

test('被中断的助手输出不当成功', () => {
  const health = new RetryHealth()
  health.observe('worker', retry(1))
  const interrupted = success(2)
  health.observe('worker', { ...interrupted, data: { ...interrupted.data, interrupted: true } })
  assert.notEqual(health.get('worker'), undefined)
  health.observe('worker', success(3))
  assert.equal(health.get('worker'), undefined)
  passed += 1
})

// ── 8. 换成另一种失败时才清掉，重试开始本身不清 ─────────────────────────────

test('当前请求改成重试另一种失败时才清状态，重试开始不清', () => {
  const health = new RetryHealth()
  health.observe('worker', retry(1))
  health.observe('worker', event('llm/retry-started', 2, { retryId: 'chain-a', turn: 1, step: 2, retry: 1 }))
  assert.notEqual(health.get('worker'), undefined)
  health.observe('worker', retry(3, { retry: 2, failure: { code: 'RATE_LIMIT', status: 429, message: 'Try later' } }))
  assert.equal(health.get('worker'), undefined)
  health.observe('worker', retry(4, { retry: 3 }))
  assert.equal(health.get('worker')?.since, '2026-09-21T08:00:04.000Z')
  passed += 1
})

// ── 9. 回合/步骤边界 ────────────────────────────────────────────────────────

for (const boundary of ['turn/end', 'turn/start', 'step/start', 'idle', 'disposed']) {
  test(`${boundary} 处清掉活动状态，晚到的事件不再复活`, () => {
    const health = new RetryHealth()
    health.observe('worker', retry(1))
    if (boundary === 'idle' || boundary === 'disposed') health.clear('worker')
    else {
      const data = boundary === 'turn/start' ? { turn: 2 } : boundary === 'step/start' ? { turn: 1, step: 3 } : { turn: 1 }
      health.observe('worker', event(boundary, 2, data))
    }
    assert.equal(health.get('worker'), undefined)
    health.observe('worker', retry(3, { retry: 2 }))
    assert.equal(health.get('worker'), undefined)
    health.observe('worker', retry(4, { turn: 3, step: 1 }))
    assert.equal(health.get('worker')?.attempts, 1)
    passed += 1
  })
}

// ── 10. 快照重建 ────────────────────────────────────────────────────────────

test('从恢复的事件快照只重建当前这条等待，并允许空闲清理', () => {
  const health = new RetryHealth()
  const history = [
    retry(1), success(2), event('step/start', 3, { turn: 1, step: 3 }),
    retry(4, { step: 3, retryId: 'chain-b' }), event('llm/retry-started', 5, { turn: 1, step: 3, retryId: 'chain-b', retry: 1 }),
  ]
  health.restore('worker', history)
  assert.deepEqual(health.get('worker'), {
    sessionId: 'worker', provider: 'provider-a', attempts: 1,
    since: '2026-09-21T08:00:04.000Z', lastAt: '2026-09-21T08:00:04.000Z',
  })
  health.restore('worker', history)
  assert.equal(health.list().length, 1, '重复恢复同一条历史不该多出一条')
  health.restore('worker', [...history, event('turn/end', 6, { turn: 1 })])
  assert.deepEqual(health.list(), [])
  health.restore('worker', history); health.clear('worker')
  assert.deepEqual(health.list(), [])
  passed += 1
})

// ── 11. 字段上限与只读投影 ──────────────────────────────────────────────────

test('次数封顶到安全整数、供应商标签非法就写 unknown，返回的是可改副本', () => {
  const health = new RetryHealth()
  health.observe('worker', retry(1, { retry: Number.MAX_VALUE, provider: 'provider-a\nAuthorization: Bearer secret' }))
  assert.deepEqual(health.get('worker'), {
    sessionId: 'worker', provider: 'unknown', attempts: Number.MAX_SAFE_INTEGER,
    since: '2026-09-21T08:00:01.000Z', lastAt: '2026-09-21T08:00:01.000Z',
  })
  assert.equal(JSON.stringify(health.list()).includes('secret'), false)
  const status = health.get('worker')
  status.provider = 'mutated'
  health.list()[0].attempts = 0
  assert.deepEqual(health.get('worker'), {
    sessionId: 'worker', provider: 'unknown', attempts: Number.MAX_SAFE_INTEGER,
    since: '2026-09-21T08:00:01.000Z', lastAt: '2026-09-21T08:00:01.000Z',
  }, '改返回值不能改到内部状态')
  passed += 1
})

// ── 12. 非法重试次数 ────────────────────────────────────────────────────────

for (const attempts of [NaN, Infinity, -1, 1.5]) {
  test(`忽略不合法的重试次数：${attempts}`, () => {
    const health = new RetryHealth()
    health.observe('worker', retry(1, { retry: attempts }))
    assert.deepEqual(health.list(), [])
    passed += 1
  })
}
