/**
 * @pneuma/superagent 的发送泵测试：离线、不联网、不读用户真实的 `~/.dsc`。
 *
 * 十一条用例，每条钉一件「不做就会静默出事」的判断：
 *   1. 发出去：有发送方的消息被送出、行删掉、那句话进「最近动态」（时刻用入队时刻）；
 *   2. 发失败：行按原 id 放回队列（状态回到 pending，不是重新插一行），退避没到点时下一拍不再试；
 *   3. 退避到点：再试一次，成功就删行；
 *   4. 永久发不出（`'gone'`）：删行、不重试，日志说清是永久失败；
 *   5. 来源没起来：按退避等，试满八次才丢弃（约 10 分钟），日志两次口径不同；
 *   6. `manual` 通道：只进最近动态，不调发送方、不留行；
 *   7. 窗口容量：第 21 条挤掉最旧的；
 *   8. 别家写的行（读不出消息）：删掉，不抛、不进窗口；
 *   9. 坏行（不是 JSON、或能解析但缺 id/kind）：自救删掉，同批的好消息照发——一行坏数据不能挡住所有回复；
 *  10. 放回队列失败：那条消息在库里停在 sending，内存里留一份，下一拍补试，不能静默丢；
 *  11. 发送途中：行是 `sending` 而不是被删——这就是「崩在中间不丢消息」的依据。
 *
 * 为什么第 11 条重要：v1 的做法是「取出即删」，进程崩在一批中间，还没发的那几条就没了；
 * 现在认领只改状态，库里的行还在，重开库时 `store.ts` 的 `recoverSendingOutbox` 把它们
 * 放回 `pending`。这条用例就是钉住「取出之后行还在」这个前提。
 *
 * 时钟由 `now` 注入，库在 `tmpdir()` 下的临时 `DSC_HOME` 里。
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/dispatch
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// 必须在 import lib/ 之前把 DSC_HOME 指到临时目录，否则会读走开发者真实的 ~/.dsc。
const home = mkdtempSync(join(tmpdir(), 'superagent-dispatch-home-'))
const previousHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = home

const { openStore } = await import('../../../../lib/packages/superagent/adapters/store.js')
const { OutboxDispatcher } = await import('../../../../lib/packages/superagent/adapters/dispatch.js')
const { StoreNotifier, RECENT_CAP } = await import('../../../../lib/packages/superagent/adapters/notify.js')

const STARTED = '2026-09-10T00:00:00.000Z'
const roots = [home]

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = previousHome
})

/** 一个用例一份临时根目录与一个库；用完关库、留目录给 after 清。 */
async function withStore(work) {
  const root = mkdtempSync(join(tmpdir(), 'superagent-dispatch-'))
  roots.push(root)
  process.env['DSC_HOME'] = root
  const store = openStore()
  try {
    return await work(store)
  } finally {
    store.close()
  }
}

/** 一条出站消息；`messageId` 是回话目标，`source` 决定谁来发。 */
const message = (id, source = 'feishu', text = '好的，我开始了', at = STARTED) => ({
  id,
  channel: { source, thread: `${source}:1`, address: { messageId: 'om_1', chatId: 'oc_1' } },
  text,
  kind: 'reply',
  ticketId: 't1',
  ...{ at },
})

/** 往队列里放一条；`payload.at` 是入队时刻，与生产代码写的那一行同形（`notify.ts`）。 */
const seed = (store, item) => {
  store.enqueueOutbox({ id: item.id, kind: item.kind, payload: { message: item, at: item.at ?? STARTED } })
}

/** 库里某一行的队列状态（`pending` / `sending`）；行不在返回 undefined。 */
const stateOf = (store, id) => store.handle.prepare('SELECT state FROM outbox WHERE id = ?').get(id)?.state

/**
 * 装一个发送泵：时钟可由 `tick` 推进，窗口与日志都留在外面给断言看。
 *
 * @param options.senders - 换成别的发送方表（默认只有 feishu，且总成功）
 * @param options.send - 默认发送方的行为
 */
function makeDispatcher(store, options = {}) {
  let at = STARTED
  const window = []
  const lines = []
  const sent = []
  const send = options.send ?? (async () => 'sent')
  const dispatcher = new OutboxDispatcher({
    store,
    senders: options.senders ?? (() => ({
      feishu: async (item) => {
        sent.push(item)
        return await send(item)
      },
    })),
    remember: (fresh) => { window.push(...fresh) },
    now: () => at,
    log: (line) => { lines.push(line) },
  })
  return {
    dispatcher,
    window,
    lines,
    sent,
    /** 把时钟往前推，模拟「下一拍」。 */
    tick: (ms) => { at = new Date(Date.parse(at) + ms).toISOString() },
    rows: () => store.handle.prepare('SELECT id FROM outbox ORDER BY rowid').all().map((row) => row.id),
  }
}

test('1. 发出去：调用发送方、删行、那句话进最近动态', async () => {
  await withStore(async (store) => {
    seed(store, message('m1'))
    const probe = makeDispatcher(store)
    await probe.dispatcher.flush()

    assert.equal(probe.sent.length, 1)
    assert.equal(probe.sent[0].id, 'm1')
    assert.deepEqual(probe.rows(), [], '发成功应删行')
    assert.deepEqual(probe.window, [{ at: STARTED, text: '好的，我开始了' }], '时刻要用入队时刻，不是现在')
  })
})

test('2. 发失败：行按原 id 放回，退避没到点不再试', async () => {
  await withStore(async (store) => {
    seed(store, message('m1'))
    const probe = makeDispatcher(store, {
      send: async () => { throw new Error('502 bad gateway') },
    })
    await probe.dispatcher.flush()
    assert.deepEqual(probe.rows(), ['m1'], '失败要放回队列，不能丢')
    assert.equal(stateOf(store, 'm1'), 'pending', '放回队列是状态改回 pending，不是重新插一行')
    assert.equal(store.handle.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1, '不能变成两行')
    assert.equal(probe.window.length, 1, '说了什么仍要记进最近动态')
    assert.match(probe.lines[0], /稍后重试：发送失败：502 bad gateway/u)

    await probe.dispatcher.flush()
    assert.equal(probe.sent.length, 1, '退避没到点，第二拍不该再发')
    assert.deepEqual(probe.rows(), ['m1'])
  })
})

test('3. 退避到点：再试一次，成功就删行', async () => {
  await withStore(async (store) => {
    seed(store, message('m1'))
    let failing = true
    const probe = makeDispatcher(store, {
      send: async () => {
        if (failing) throw new Error('timeout')
        return 'sent'
      },
    })
    await probe.dispatcher.flush()
    failing = false
    probe.tick(5000)
    await probe.dispatcher.flush()

    assert.equal(probe.sent.length, 2, '到点后应重试一次')
    assert.deepEqual(probe.rows(), [])
    assert.equal(probe.window.length, 1, '重投的同一条不该在窗口里出现两遍')
  })
})

test('4. 永久发不出：删行、不重试', async () => {
  await withStore(async (store) => {
    seed(store, message('m1'))
    const probe = makeDispatcher(store, { send: async () => 'gone' })
    await probe.dispatcher.flush()

    assert.deepEqual(probe.rows(), [], '永久发不出的行要丢掉，否则每拍都会重试')
    assert.equal(probe.sent.length, 1)
    assert.match(probe.lines[0], /永久发不出/u)
  })
})

test('5. 来源没起来：退避等着，试满八次才丢弃', async () => {
  await withStore(async (store) => {
    seed(store, message('m1'))
    const probe = makeDispatcher(store, { senders: () => ({}) })

    // 前七次都在等：每拍之间把时钟推到这一次退避到点（5、10、20、40、80、160、300 秒）。
    const waits = [0, 5000, 10000, 20000, 40000, 80000, 160_000]
    for (const ms of waits) {
      if (ms > 0) probe.tick(ms)
      await probe.dispatcher.flush()
      assert.deepEqual(probe.rows(), ['m1'], '来源没起来时要保留，不能立刻丢')
    }
    assert.match(probe.lines.at(-1), /还没起来/u)

    probe.tick(300_000)
    await probe.dispatcher.flush()
    assert.deepEqual(probe.rows(), [], '第八次之后丢弃')
    assert.match(probe.lines.at(-1), /放弃投递/u)
  })
})

test('6. manual 通道：只进最近动态，不调发送方', async () => {
  await withStore(async (store) => {
    seed(store, message('m1', 'manual', '工单「改文案」已完成'))
    const probe = makeDispatcher(store)
    await probe.dispatcher.flush()

    assert.equal(probe.sent.length, 0, 'manual 是没有真实会话的占位，不该调发送方')
    assert.deepEqual(probe.rows(), [])
    assert.equal(probe.window.length, 1)
  })
})

test('7. 窗口容量：第 21 条挤掉最旧的', async () => {
  await withStore(async (store) => {
    for (let index = 1; index <= RECENT_CAP + 1; index += 1) {
      const label = String(index).padStart(2, '0')
      seed(store, message(`m${label}`, 'manual', `通知 ${label}`))
    }
    // 窗口容量住在通知那个类里（`notify.ts` 的 `remember`），所以这条用例接真的它，
    // 而不是一个数数组长度的假实现——假实现永远数得出 21。
    const notifier = new StoreNotifier(store)
    const dispatcher = new OutboxDispatcher({
      store,
      senders: () => ({}),
      remember: (fresh) => { notifier.remember(fresh) },
      now: () => STARTED,
      log: () => {},
    })
    await dispatcher.flush()

    const window = notifier.recent()
    assert.equal(window.length, RECENT_CAP)
    assert.ok(!window.some((item) => item.text.includes('通知 01')), '最旧的那条应被挤掉')
    assert.match(window.at(-1).text, /通知 21/, '最新的在末尾')
  })
})

test('8. 别家写的行：删掉，不抛、不进窗口', async () => {
  await withStore(async (store) => {
    store.enqueueOutbox({ id: 'other', kind: 'reply', payload: { hello: 'world' } })
    const probe = makeDispatcher(store)
    await probe.dispatcher.flush()

    assert.deepEqual(probe.rows(), [])
    assert.equal(probe.window.length, 0)
    assert.equal(probe.sent.length, 0)
  })
})

test('9. 坏行：自救删掉，同批的好消息照发', async () => {
  await withStore(async (store) => {
    // 两种坏法都要认：不是 JSON，以及能解析但缺 id/kind（decodeOutboxItem 对两者都抛）。
    store.handle.prepare('INSERT INTO outbox (id, value) VALUES (?, ?)').run('bad-json', 'not json')
    store.handle.prepare('INSERT INTO outbox (id, value) VALUES (?, ?)').run('bad-shape', '{"hello":"world"}')
    seed(store, message('m1'))
    const probe = makeDispatcher(store)
    await probe.dispatcher.flush()

    assert.equal(probe.sent.length, 1, '一行坏数据不能挡住所有回复')
    assert.deepEqual(probe.rows(), [], '坏行与好消息都应清掉')
    assert.ok(probe.lines.some((line) => line.includes('取出站消息失败')), '要先说清取队列失败了')
    assert.ok(probe.lines.some((line) => line.includes('删掉 2 行读不出来的数据')), '两种坏行都要删掉')
  })
})

test('10. 放回队列失败：行停在 sending，内存留一份，下一拍补试', async () => {
  await withStore(async (store) => {
    seed(store, message('m1'))
    let failing = true
    const probe = makeDispatcher(store, {
      send: async () => {
        if (failing) throw new Error('502 bad gateway')
        return 'sent'
      },
    })
    // 让「放回队列」这一步失败：行会停在 sending（库里还在，但这一进程不会再认领它）。
    const original = store.requeueOutbox.bind(store)
    store.requeueOutbox = () => { throw new Error('database is locked') }
    await probe.dispatcher.flush()
    assert.deepEqual(probe.rows(), ['m1'], '行没被删，只是状态改不回去')
    assert.equal(stateOf(store, 'm1'), 'sending', '这一拍确实没放回队列')
    assert.ok(probe.lines.some((line) => line.includes('放回队列失败')), '失败要留痕迹')

    store.requeueOutbox = original
    failing = false
    probe.tick(5000)
    await probe.dispatcher.flush()
    assert.equal(probe.sent.length, 2, '下一拍要重试那条消息')
    assert.deepEqual(probe.rows(), [], '发成功之后不该留行')
  })
})

test('11. 发送途中行是 sending（不是取出即删），发完才删', async () => {
  await withStore(async (store) => {
    seed(store, message('m1'))
    // 发送方在被调用的那一刻回头看库：这时行应该还在，状态是 sending。
    let duringSend
    const probe = makeDispatcher(store, {
      send: async () => {
        duringSend = { rows: probe.rows(), state: stateOf(store, 'm1') }
        return 'sent'
      },
    })
    await probe.dispatcher.flush()

    assert.deepEqual(duringSend, { rows: ['m1'], state: 'sending' }, '发送途中行要在库里、状态是 sending')
    assert.deepEqual(probe.rows(), [], '发成功之后才删行')
  })
})
