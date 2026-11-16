/**
 * @pneuma/superagent 编排轮次的包级测试，转写自上游 `tests/passes.spec.ts`（4 条用例）：
 *   1. 失败的一轮记成运行期体检项的错误，下一轮成功清掉；
 *   2. 一轮还没跑完时并发请求合并成后续一轮；
 *   3. 停止中拒绝 Trigger（引擎一条都没收到），存下的 Trigger 才起一轮；
 *   4. 停过之后再 `start` 不起定时器。
 *
 * 引擎和副作用队列都是对象字面量，只实现 `Passes` 调的那几个方法（`receive` / `evaluateDue` /
 * `kick` / `idle`）；体检项用真 `HealthBoard` 的 claim 结果——上游断言的正是「谁写进了哪一格」。
 * 第 4 条用 `node:test` 自带的 mock 定时器（`t.mock.timers`，不是 vitest 的
 * `vi.useFakeTimers`）：不假定时器就得真等 2 秒，而且分不清「没起表」和「表还没到点」。
 * 被测代码的时间只写进体检项的 `at` 字段，不参与任何判断，所以没有可注入的时钟。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。不碰 `~/.dsc`。
 *
 * @module @pneuma/superagent/tests/passes
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { Passes } = await import('../../../../lib/packages/superagent/app/passes.js')
const { HealthBoard } = await import('../../../../lib/packages/superagent/infra/health.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

/**
 * 记录调用参数的假函数：`calls` 是每次调用收到的参数数组，`once` 让下一次调用临时换实现
 * （对应 vitest 的 `mockImplementationOnce`，用来只让第一轮抛错）。
 */
function recorder(impl = () => {}) {
  const calls = []
  const once = []
  const fn = (...args) => {
    calls.push(args)
    if (once.length) return once.shift()(...args)
    return impl(...args)
  }
  fn.calls = calls
  fn.once = (replacement) => {
    once.push(replacement)
    return fn
  }
  return fn
}

/**
 * 造一套 `Passes`：真健康项（`runtime` 格）+ 假引擎 / 假队列。
 *
 * @param closing - 停止判定，默认一直不停止
 */
function passes(closing = () => false) {
  const health = new HealthBoard().claim('runtime', { state: 'starting', detail: '' })
  const engine = { receive: recorder(() => 'stored'), evaluateDue: recorder(() => {}) }
  const effects = { kick: recorder(() => {}), idle: async () => {} }
  const value = new Passes({ engine, effects, health, lifetime: new AbortController().signal, configured: () => true, closing })
  return { passes: value, engine, effects, health }
}

/** 一条 Trigger：`Passes` 只把它原样转交引擎，形状按上游夹具。 */
const trigger = { id: 't1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: 'ou_a' }, human: true,
  at: '2026-10-01T00:00:00.000Z', text: 'hi', meta: {} }

test('失败的一轮记成运行期错误，下一轮成功清掉', async () => {
  const h = passes()
  h.engine.evaluateDue.once(() => { throw new Error('database is locked') })
  h.passes.request()
  await h.passes.idle()
  assert.deepEqual([h.health.get()?.state, h.health.get()?.detail], ['error', 'A pass failed: Error: database is locked'])
  h.passes.request()
  await h.passes.idle()
  assert.deepEqual([h.health.get()?.state, h.health.get()?.detail], ['ready', 'Orchestrator is ready'], '下一轮成功要清掉错误')
  passed += 1
})

test('一轮里来的多次请求合并成一轮后续轮次', async () => {
  const h = passes()
  await Promise.all([h.passes.pump(), h.passes.pump(), h.passes.pump(), h.passes.pump()])
  assert.deepEqual([h.engine.evaluateDue.calls.length, h.effects.kick.calls.length], [2, 2], '首轮一次 + 合并出的一轮一次')
  await h.passes.pump()
  assert.equal(h.engine.evaluateDue.calls.length, 3, '后续再请求就再跑一轮')
  passed += 1
})

test('停止中拒绝 Trigger，引擎一条都没收到；存下的 Trigger 才起一轮', async () => {
  let closing = true
  const h = passes(() => closing)
  assert.throws(() => h.passes.receive(trigger), /Orchestrator is stopping/)
  assert.equal(h.engine.receive.calls.length, 0, '拒绝要发生在引擎存 Trigger 之前')
  closing = false
  assert.equal(h.passes.receive(trigger), 'stored')
  await h.passes.idle()
  assert.equal(h.engine.evaluateDue.calls.length, 1, '存下了才起一轮')
  passed += 1
})

test('停过之后再 start 不起定时器', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = passes()
  await h.passes.stop()
  h.passes.start()
  t.mock.timers.tick(10_000)
  await Promise.resolve()
  assert.equal(h.engine.evaluateDue.calls.length, 0, 'stop 之后 start 不该重新起表')
  passed += 1
})
