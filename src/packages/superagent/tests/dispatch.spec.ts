/**
 * @pneuma/superagent 的发送泵测试：离线、不联网、不读用户真实的 `~/.dsc`。
 *
 * 十条用例，每条钉一件「不做就会静默出事」的判断：
 *   1. 发出去：有发送方的消息被送出、行删掉、那句话进「最近动态」（时刻用入队时刻）；
 *   2. 发失败：行按原 id 写回队列，退避没到点时下一拍不再试；
 *   3. 退避到点：再试一次，成功就删行；
 *   4. 永久发不出（`'gone'`）：删行、不重试，日志说清是永久失败；
 *   5. 来源没起来：按退避等，试满八次才丢弃（约 10 分钟），日志两次口径不同；
 *   6. `manual` 通道：只进最近动态，不调发送方、不留行；
 *   7. 窗口容量：第 21 条挤掉最旧的；
 *   8. 别家写的行（读不出消息）：删掉，不抛、不进窗口；
 *   9. 坏行（不是 JSON、或能解析但缺 id/kind）：自救删掉，同批的好消息照发——一行坏数据不能挡住所有回复；
 *   10. 写回队列失败：那条消息只剩内存这一份，下一拍补写回去，不能静默丢。
 *
 * 时钟由 `now` 注入，库在 `tmpdir()` 下的临时 `DSC_HOME` 里。
 * 迁移说明：原文件 import `lib/` 构建产物；现在直接 import 源码，不再要求先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/dispatch
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { OutboundMessage } from '../core/ports.js'
import type { DscStore } from '../adapters/store.js'
import type { MessageSender } from '../adapters/dispatch.js'
import type { RecentNotice } from '../adapters/notify.js'

// 必须在 import 源码之前把 DSC_HOME 指到临时目录，否则会读走开发者真实的 ~/.dsc。
const home = mkdtempSync(join(tmpdir(), 'superagent-dispatch-home-'))
const previousHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = home

const { openStore } = await import('../adapters/store.js')
const { OutboxDispatcher } = await import('../adapters/dispatch.js')
const { StoreNotifier, RECENT_CAP } = await import('../adapters/notify.js')

const STARTED = '2026-09-10T00:00:00.000Z'
const roots: string[] = [home]

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = previousHome
})

/** 一个用例一份临时根目录与一个库；用完关库、留目录给 afterAll 清。 */
async function withStore<T>(work: (store: DscStore) => Promise<T>): Promise<T> {
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

/** 出站消息 + 入队时刻（`notify.ts` 写进 payload 的那两个字段之一）。 */
interface QueuedMessage extends OutboundMessage {
  at?: string
}

/** 一条出站消息；`messageId` 是回话目标，`source` 决定谁来发。 */
const message = (id: string, source = 'feishu', text = '好的，我开始了', at = STARTED): QueuedMessage => ({
  id,
  channel: { source, thread: `${source}:1`, address: { messageId: 'om_1', chatId: 'oc_1' } },
  text,
  kind: 'reply',
  ticketId: 't1',
  at,
})

/** 往队列里放一条；`payload.at` 是入队时刻，与生产代码写的那一行同形（`notify.ts`）。 */
const seed = (store: DscStore, item: QueuedMessage): void => {
  store.enqueueOutbox({ id: item.id, kind: item.kind, payload: { message: item, at: item.at ?? STARTED } })
}

/** 发送泵的探针：窗口、日志、已发消息都留在外面给断言看。 */
interface DispatchProbe {
  dispatcher: InstanceType<typeof OutboxDispatcher>
  window: RecentNotice[]
  lines: string[]
  sent: QueuedMessage[]
  /** 把时钟往前推，模拟「下一拍」。 */
  tick: (ms: number) => void
  rows: () => string[]
}

/** `makeDispatcher` 的可选项。 */
interface DispatchFixtureOptions {
  send?: MessageSender
  senders?: () => Partial<Record<string, MessageSender>>
}

/**
 * 装一个发送泵：时钟可由 `tick` 推进，窗口与日志都留在外面给断言看。
 *
 * @param options.senders - 换成别的发送方表（默认只有 feishu，且总成功）
 * @param options.send - 默认发送方的行为
 */
function makeDispatcher(store: DscStore, options: DispatchFixtureOptions = {}): DispatchProbe {
  let at = STARTED
  const window: RecentNotice[] = []
  const lines: string[] = []
  const sent: QueuedMessage[] = []
  const send: MessageSender = options.send ?? (async () => 'sent')
  const dispatcher = new OutboxDispatcher({
    store,
    senders: options.senders ?? (() => ({
      feishu: async (item: OutboundMessage) => {
        sent.push(item as QueuedMessage)
        return await send(item)
      },
    })),
    remember: (fresh: readonly RecentNotice[]) => {
      window.push(...fresh)
    },
    now: () => at,
    log: (line: string) => {
      lines.push(line)
    },
  })
  return {
    dispatcher,
    window,
    lines,
    sent,
    /** 把时钟往前推，模拟「下一拍」。 */
    tick: (ms) => {
      at = new Date(Date.parse(at) + ms).toISOString()
    },
    rows: () =>
      (store.handle.prepare('SELECT id FROM outbox ORDER BY rowid').all() as Array<{ id: string }>).map((row) => row.id),
  }
}

test('1. 发出去：调用发送方、删行、那句话进最近动态', async () => {
  await withStore(async (store) => {
    seed(store, message('m1'))
    const probe = makeDispatcher(store)
    await probe.dispatcher.flush()

    expect(probe.sent.length).toBe(1)
    expect(probe.sent[0].id).toBe('m1')
    expect(probe.rows(), '发成功应删行').toStrictEqual([])
    expect(probe.window, '时刻要用入队时刻，不是现在').toStrictEqual([{ at: STARTED, text: '好的，我开始了' }])
  })
})

test('2. 发失败：行按原 id 写回，退避没到点不再试', async () => {
  await withStore(async (store) => {
    seed(store, message('m1'))
    const probe = makeDispatcher(store, {
      send: async () => {
        throw new Error('502 bad gateway')
      },
    })
    await probe.dispatcher.flush()
    expect(probe.rows(), '失败要写回队列，不能丢').toStrictEqual(['m1'])
    expect(probe.window.length, '说了什么仍要记进最近动态').toBe(1)
    expect(probe.lines[0]).toMatch(/稍后重试：发送失败：502 bad gateway/u)

    await probe.dispatcher.flush()
    expect(probe.sent.length, '退避没到点，第二拍不该再发').toBe(1)
    expect(probe.rows()).toStrictEqual(['m1'])
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

    expect(probe.sent.length, '到点后应重试一次').toBe(2)
    expect(probe.rows()).toStrictEqual([])
    expect(probe.window.length, '重投的同一条不该在窗口里出现两遍').toBe(1)
  })
})

test('4. 永久发不出：删行、不重试', async () => {
  await withStore(async (store) => {
    seed(store, message('m1'))
    const probe = makeDispatcher(store, { send: async () => 'gone' })
    await probe.dispatcher.flush()

    expect(probe.rows(), '永久发不出的行要丢掉，否则每拍都会重试').toStrictEqual([])
    expect(probe.sent.length).toBe(1)
    expect(probe.lines[0]).toMatch(/永久发不出/u)
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
      expect(probe.rows(), '来源没起来时要保留，不能立刻丢').toStrictEqual(['m1'])
    }
    expect(probe.lines.at(-1) ?? '').toMatch(/还没起来/u)

    probe.tick(300_000)
    await probe.dispatcher.flush()
    expect(probe.rows(), '第八次之后丢弃').toStrictEqual([])
    expect(probe.lines.at(-1) ?? '').toMatch(/放弃投递/u)
  })
})

test('6. manual 通道：只进最近动态，不调发送方', async () => {
  await withStore(async (store) => {
    seed(store, message('m1', 'manual', '工单「改文案」已完成'))
    const probe = makeDispatcher(store)
    await probe.dispatcher.flush()

    expect(probe.sent.length, 'manual 是没有真实会话的占位，不该调发送方').toBe(0)
    expect(probe.rows()).toStrictEqual([])
    expect(probe.window.length).toBe(1)
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
      remember: (fresh: readonly RecentNotice[]) => {
        notifier.remember(fresh)
      },
      now: () => STARTED,
      log: () => {},
    })
    await dispatcher.flush()

    const window = notifier.recent()
    expect(window.length).toBe(RECENT_CAP)
    expect(window.some((item) => item.text.includes('通知 01')), '最旧的那条应被挤掉').toBe(false)
    expect(window.at(-1)?.text ?? '').toMatch(/通知 21/)
    expect(window.at(-1)?.text ?? '', '最新的在末尾').toContain('通知 21')
  })
})

test('8. 别家写的行：删掉，不抛、不进窗口', async () => {
  await withStore(async (store) => {
    store.enqueueOutbox({ id: 'other', kind: 'reply', payload: { hello: 'world' } })
    const probe = makeDispatcher(store)
    await probe.dispatcher.flush()

    expect(probe.rows()).toStrictEqual([])
    expect(probe.window.length).toBe(0)
    expect(probe.sent.length).toBe(0)
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

    expect(probe.sent.length, '一行坏数据不能挡住所有回复').toBe(1)
    expect(probe.rows(), '坏行与好消息都应清掉').toStrictEqual([])
    expect(probe.lines.some((line) => line.includes('取出站消息失败')), '要先说清取队列失败了').toBe(true)
    expect(probe.lines.some((line) => line.includes('删掉 2 行读不出来的数据')), '两种坏行都要删掉').toBe(true)
  })
})

test('10. 写回队列失败：留在内存里，下一拍补写回去', async () => {
  await withStore(async (store) => {
    seed(store, message('m1'))
    let failing = true
    const probe = makeDispatcher(store, {
      send: async () => {
        if (failing) throw new Error('502 bad gateway')
        return 'sent'
      },
    })
    // 让「写回队列」这一步失败：那一行已经被 drainOutbox 从库里取走删掉了，只剩内存这一份。
    const original = store.enqueueOutbox.bind(store)
    store.enqueueOutbox = () => {
      throw new Error('database is locked')
    }
    await probe.dispatcher.flush()
    expect(probe.rows(), '这一拍确实没写回库里').toStrictEqual([])
    expect(probe.lines.some((line) => line.includes('写回队列失败')), '失败要留痕迹').toBe(true)

    store.enqueueOutbox = original
    failing = false
    probe.tick(5000)
    await probe.dispatcher.flush()
    expect(probe.sent.length, '下一拍要重试那条消息').toBe(2)
    expect(probe.rows(), '发成功之后不该留行').toStrictEqual([])
  })
})
