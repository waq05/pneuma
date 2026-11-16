/**
 * `superagentAnswer` 的链路用例：面板上的一句话怎么变成工单的一条 Input。
 *
 * 为什么单独一份：这条链路最容易「看着通、其实没接上」的两处都不报错——
 *
 *   - Trigger 的 `threads` 写错：`Intake` 只按线程订阅扇出（`core/intake.ts:34-59`），
 *     写了一条新线程的话，消息照样入库，只是**哪张工单都收不到**；
 *   - Trigger 的 id 没掺随机量：同一个人把同一句话连发两次，第二次会被 `Intake`
 *     判 `duplicate` **静默吞掉**（`core/intake.ts:23`）。
 *
 * 所以这里不只断言「没抛错」，还要从库里读出那条 Trigger，核对它的线程、`human` 标记，
 * 以及两次同样的回答是不是真的都进了工单。
 *
 * 执行器用假的：本例要证的是「回答挂到工单上了」，不是「worker 真的接着跑」。
 *
 * 全程用 `tmpdir()` 下的临时目录，不碰用户真实的 `~/.dsc`；import 的是 `lib/` 的构建
 * 产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/answer
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'superagent-answer-home-'))
process.env['DSC_HOME'] = home

const { openStore } = await import('../../../../lib/packages/superagent/adapters/store.js')
const { SuperagentRuntime } = await import('../../../../lib/packages/superagent/runtime.js')
const { SuperagentService } = await import('../../../../lib/packages/superagent/service.js')

after(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

/** 固定时钟：Trigger id 里已经有随机量，时间固定只为让断言不依赖跑得快慢。 */
const AT = '2026-01-01T00:00:00.000Z'

/**
 * 装一套运行期跑完 `work`，结束时按「运行期 → 库 → 环境变量」的顺序收尾。
 *
 * 注入假执行器：不启动会话、不投递，`undelivered` 就停在原地，断言才有东西可看。
 *
 * @param work - 拿到运行期、库与调用计数之后做什么
 */
async function withRuntime(work) {
  const previous = process.env['DSC_HOME']
  const root = mkdtempSync(join(tmpdir(), 'superagent-answer-run-'))
  process.env['DSC_HOME'] = root
  const store = openStore()
  const calls = { start: 0, deliver: 0, stop: 0 }
  const runtime = new SuperagentRuntime(store, {
    now: () => AT,
    log: () => {},
    executor: {
      start() { calls.start += 1 },
      deliver() { calls.deliver += 1 },
      stop() { calls.stop += 1 },
    },
  })
  try {
    return await work({ runtime, store, calls })
  } finally {
    runtime.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
    if (previous === undefined) delete process.env['DSC_HOME']
    else process.env['DSC_HOME'] = previous
  }
}

/** 表里一行的 `value` 列反序列化；没有这行返回 `undefined`。 */
function rowOf(store, sql, id) {
  const row = store.handle.prepare(sql).get(id)
  return row === undefined ? undefined : JSON.parse(String(row.value))
}

/** 一张工单的原文（库里的 `ticket.value`）。 */
function ticketOf(store, id) {
  return rowOf(store, 'SELECT value FROM ticket WHERE id = ?', id)
}

/** 一条 Trigger 的原文（库里的 `trigger.value`）。 */
function triggerOf(store, id) {
  return rowOf(store, 'SELECT value FROM trigger WHERE id = ?', id)
}

/** 全部线程原文。 */
function threadsOf(store) {
  return store.handle.prepare('SELECT value FROM thread').all().map((row) => JSON.parse(String(row.value)))
}

/** 发布一张最简工单，返回它的 id（用真判定器 + 默认设置，与 `/sa new` 同一条路）。 */
function publish(runtime) {
  return runtime.publish({ title: '登录页文案', body: '把错误提示改成中文' })
}

test('未知工单 id：抛「没有这张工单」', async () => {
  await withRuntime(({ runtime }) => {
    assert.throws(() => runtime.answer('0'.repeat(32), '在的'), /没有这张工单/)
    passed += 1
  })
})

test('已结束的工单：抛「已经结束」，不会把话塞进一张收口的单', async () => {
  await withRuntime(({ runtime }) => {
    const id = publish(runtime)
    runtime.stop(id)
    assert.throws(() => runtime.answer(id, '合并吧'), /已经结束/)
    passed += 1
  })
})

test('正常回答：多一条 trigger Input，Trigger 挂的正是工单那条线程且 human 为真', async () => {
  await withRuntime(({ runtime, store }) => {
    const id = publish(runtime)
    assert.equal(ticketOf(store, id).inputs.length, 0, '刚建出来的工单不该已有 Input')

    runtime.answer(id, '用方案 A')

    const ticket = ticketOf(store, id)
    const added = ticket.inputs.at(-1)
    assert.equal(added.kind, 'trigger', '回答应当是一条 trigger 类型的 Input')
    assert.ok(ticket.undelivered.includes(added.id), '人的回答要进 undelivered，等着投递给 worker')

    const trigger = triggerOf(store, added.triggerId)
    assert.equal(trigger.human, true, 'answering 是人写的消息，human 必须为真（wake 靠它）')
    // 线程订阅是扇出的唯一依据：Trigger 的线程必须就是工单订阅着的那条。
    const thread = threadsOf(store).find((item) => item.subscriptions.includes(id))
    assert.ok(thread !== undefined, '建单之后该有一条订阅这张工单的线程')
    assert.deepEqual(trigger.threads, [thread.ref], 'Trigger 的 threads 必须是工单那条线程')
    assert.equal(trigger.text, '用方案 A')
    passed += 1
  })
})

test('没有线程的工单：抛「没有可回话的线程」', async () => {
  await withRuntime(({ runtime, store }) => {
    const id = publish(runtime)
    // 把线程表清空：模拟「这张工单的线程不是可回话来源」的局面（库里被手工改过也一样）。
    store.handle.prepare('DELETE FROM thread').run()
    assert.throws(() => runtime.answer(id, '喂'), /没有可回话的线程/)
    passed += 1
  })
})

test('空回答：服务层拒绝，不建 Trigger', async () => {
  await withRuntime(async ({ runtime }) => {
    const id = publish(runtime)
    const service = new SuperagentService({
      current: () => runtime,
      ensure: () => runtime,
      problem: () => null,
      changed: () => {},
    })
    await assert.rejects(service.answer({ ticketId: id, text: '   ' }), /回答不能为空/)
    passed += 1
  })
})

test('重复回答：同一句话连发两次不能被去重吞掉，两条都要进工单', async () => {
  await withRuntime(({ runtime, store }) => {
    const id = publish(runtime)
    runtime.answer(id, '同一句话')
    runtime.answer(id, '同一句话')

    const triggers = ticketOf(store, id).inputs.filter((input) => input.kind === 'trigger')
    assert.equal(triggers.length, 2, '两次回答应各自成为一条 Input')
    assert.notEqual(triggers[0].triggerId, triggers[1].triggerId, '两条回答的 Trigger id 不能相同')
    const texts = triggers.map((input) => triggerOf(store, input.triggerId).text)
    assert.deepEqual(texts, ['同一句话', '同一句话'], '两句话都要原样进去')
    passed += 1
  })
})

after(() => {
  console.log(`通过 ${passed}`)
})
