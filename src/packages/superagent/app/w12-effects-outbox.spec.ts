/**
 * 覆盖补齐（W12）：`app/effects.ts` 的持久化副作用队列与 `app/outbox.ts` 的出站投递。
 *
 * 这两个模块坏了的症状是静默的：副作用丢一行、失败不重试、同一会话的消息乱序、丢弃不回执。
 * 因此 `Effects` 用真 SQLite 临时库 + 真 `HealthBoard`，断言读的是「库里真实的行与体检项」；
 * `Outbox` 只把「进程外」的协作方（Effects、来源注册表、命令执行器）换成手写假件，投递判定本身是真代码。
 *
 * @module @pneuma/superagent/app
 */
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { OutboundMessage } from '../core/index.js'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { HealthBoard } from '../infra/health.js'
import { Store } from './store.js'
import { Effects, FAILURES_BEFORE_ERROR, Later } from './effects.js'
import { Outbox } from './outbox.js'

const opened: Store[] = []
afterEach(() => {
  for (const store of opened.splice(0)) store.close()
})

function db() {
  const dir = createTempDir('dsc-sa-effects-')
  const store = new Store(join(dir, 'orchestrator.sqlite'))
  opened.push(store)
  return store
}
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const row = (store: Store, kind: string, key: string) =>
  store.db.prepare('SELECT seq, generation, attempts, error, due FROM effect WHERE kind = ? AND key = ?').get(kind, key) as
    { seq: number; generation: number; attempts: number; error: string; due: number } | undefined

describe('effects：持久化副作用队列', () => {
  test('enqueue 落库并按 kind+key 合并：保留队列位置、payload 更新、失败计数清零', () => {
    const store = db()
    let clock = 1000
    const effects = new Effects(store, new HealthBoard(), () => clock)
    effects.enqueue('relay', 'r1', { text: 'one' })
    expect(row(store, 'relay', 'r1')).toMatchObject({ seq: 1, generation: 0, attempts: 0, error: '' })
    clock = 2000
    store.db.prepare("UPDATE effect SET attempts = 2, error = 'old' WHERE kind = 'relay' AND key = 'r1'").run()
    effects.enqueue('relay', 'r1', { text: 'two' })
    const merged = row(store, 'relay', 'r1')!
    expect(merged).toMatchObject({ seq: 1, generation: 1, attempts: 0, error: '', due: 2000 })
    expect(JSON.parse(String(store.db.prepare("SELECT value FROM effect WHERE key = 'r1'").get()?.value))).toEqual({ text: 'two' })
    // 构造时把已有行的最大 seq 读成起点，新行接在后面。
    const reopened = new Effects(store, new HealthBoard(), () => clock)
    reopened.enqueue('relay', 'r2', { text: 'three' })
    expect(row(store, 'relay', 'r2')?.seq).toBe(2)
    expect(effects.pending('relay')).toBe(true)
    expect(effects.pending('relay', 'r1')).toBe(true)
    expect(effects.pending('relay', 'missing')).toBe(false)
    expect(effects.pending('launch')).toBe(false)
  })

  test('handle 每种 kind 只能注册一次；start 之前不派发，start 之后成功即删行并刷新体检', async () => {
    const store = db()
    const board = new HealthBoard()
    const effects = new Effects(store, board)
    const seen: string[] = []
    effects.handle('relay', async (payload: { text: string }, key) => { seen.push(`${key}:${payload.text}`) })
    expect(() => effects.handle('relay', async () => {})).toThrow('The relay effects already have a handler')

    effects.enqueue('relay', 'r1', { text: 'hello' })
    await settle()
    expect(seen).toEqual([])
    expect(effects.pending('relay', 'r1')).toBe(true)

    effects.start()
    await effects.idle()
    expect(seen).toEqual(['r1:hello'])
    expect(effects.pending('relay', 'r1')).toBe(false)
    expect(board.all.relay).toMatchObject({ state: 'ready', detail: 'Nothing waiting' })
    await effects.drain()
  })

  test('Later 只把 due 往后推、不加失败次数；普通失败按指数退避记错误', async () => {
    const store = db()
    let clock = 10_000
    const board = new HealthBoard()
    const effects = new Effects(store, board, () => clock)
    let mode: 'later' | 'fail' | 'ok' = 'later'
    effects.handle('launch', async () => {
      if (mode === 'later') throw new Later('not now')
      if (mode === 'fail') throw new Error('boom')
    }, { retry: [100, 1000] })
    effects.enqueue('launch', 'a1', { ticketId: 't1', assignmentId: 'a1' })
    effects.start()

    await effects.idle()
    expect(row(store, 'launch', 'a1')).toMatchObject({ attempts: 0, error: '', due: 10_100 })

    mode = 'fail'
    clock = 20_000
    store.db.prepare("UPDATE effect SET due = 15000 WHERE kind = 'launch'").run()
    await effects.idle()
    expect(row(store, 'launch', 'a1')).toMatchObject({ attempts: 1, error: 'Error: boom', due: 20_100 })

    // 第二次失败：向量翻倍到 200ms。
    store.db.prepare("UPDATE effect SET due = 20100 WHERE kind = 'launch'").run()
    clock = 30_000
    await effects.idle()
    expect(row(store, 'launch', 'a1')).toMatchObject({ attempts: 2, due: 30_200 })

    // 第三次失败后体检项转 error（阈值 3），并带上最后一次错误。
    store.db.prepare("UPDATE effect SET due = 30200 WHERE kind = 'launch'").run()
    clock = 40_000
    await effects.idle()
    expect(row(store, 'launch', 'a1')?.attempts).toBe(3)
    expect(board.all.launch).toMatchObject({ state: 'error' })
    expect(String(board.all.launch?.detail)).toContain('the last failure: Error: boom')

    mode = 'ok'
    store.db.prepare("UPDATE effect SET due = 0 WHERE kind = 'launch'").run()
    await effects.idle()
    expect(effects.pending('launch', 'a1')).toBe(false)
    // 成功派发之后体检项回到 ready。
    expect(board.all.launch).toMatchObject({ state: 'ready' })
    await effects.drain()
  })

  test('错误文本只留前 1000 个字符；quiet 的 kind 反复失败也不把体检项标成 error', async () => {
    const store = db()
    const board = new HealthBoard()
    let clock = 1000
    const effects = new Effects(store, board, () => clock)
    effects.handle('reply', async () => { throw new Error('x'.repeat(1200)) }, { quiet: true, retry: [100, 1000] })
    effects.enqueue('reply', 'm1', {})
    effects.start()
    // 每轮失败后 due 往后推，推进时钟才会再跑一轮（退避不能用 0，否则 idle 会一直重试）。
    await effects.idle()
    clock = 2000
    await effects.idle()
    clock = 3000
    await effects.idle()
    expect(row(store, 'reply', 'm1')?.attempts).toBe(FAILURES_BEFORE_ERROR)
    expect(row(store, 'reply', 'm1')!.error.length).toBe(1000)
    expect(board.all.reply?.state).toBe('ready')
    await effects.drain()
  })

  test('ordered 的 kind 一次一行，前一行没跑完后面的不插队；limit=0 时整个 kind 停住', async () => {
    const store = db()
    const board = new HealthBoard()
    const effects = new Effects(store, board)
    const ran: string[] = []
    effects.handle('reply', async (_payload, key) => { ran.push(key) }, { ordered: true, retry: [10_000, 10_000] })
    effects.enqueue('reply', 'first', {})
    effects.enqueue('reply', 'second', {})
    effects.start()
    await effects.idle()
    // ordered 只取最旧的一行，一次跑完；这里两行都跑（第一行成功后第二轮才轮到第二行）。
    expect(ran).toEqual(['first', 'second'])

    const paused = db()
    const pausedBoard = new HealthBoard()
    const pausedEffects = new Effects(paused, pausedBoard)
    let pausedRuns = 0
    pausedEffects.handle('launch', async () => { pausedRuns += 1 }, { limit: () => 0 })
    pausedEffects.enqueue('launch', 'a1', { ticketId: 't1', assignmentId: 'a1' })
    pausedEffects.start()
    await pausedEffects.idle()
    expect(pausedRuns).toBe(0)
    expect(pausedEffects.pending('launch', 'a1')).toBe(true)
    await pausedEffects.drain()
  })

  test('cancel 删行并立刻刷新体检；drain 之后不再派发，运行中的等它跑完', async () => {
    const store = db()
    const board = new HealthBoard()
    const effects = new Effects(store, board)
    const ran: string[] = []
    let release: () => void = () => {}
    effects.handle('relay', async (_payload, key) => { ran.push(key); await new Promise<void>(resolve => { release = resolve }) })
    effects.enqueue('relay', 'slow', { text: 'x' })
    effects.enqueue('relay', 'cancel-me', { text: 'y' })
    effects.start()
    // 让第一轮派发起步：慢任务挂住，第二行在后面排队。
    await settle()
    effects.cancel('relay', 'cancel-me')
    expect(effects.pending('relay', 'cancel-me')).toBe(false)
    expect(board.all.relay).toMatchObject({ state: 'ready' })
    const draining = effects.drain()
    release()
    await draining
    expect(ran).toEqual(['slow'])
    // drain 之后新行留在库里等下次启动。
    effects.enqueue('relay', 'after', { text: 'z' })
    await settle()
    expect(ran).toEqual(['slow'])
    expect(effects.pending('relay', 'after')).toBe(true)
  })
})

describe('outbox：出站消息先落回执再逐条投递', () => {
  /** 一组手写宿主：真 Store 存回执，假 Effects 交出 reply handler，假来源注册表给投递结果。 */
  function host(options: { enabled?: boolean; allowed?: boolean; send?: 'sent' | 'gone' | 'waiting'; paused?: boolean } = {}) {
    const dir = createTempDir('dsc-sa-outbox-')
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    opened.push(store)
    const queued: { kind: string; key: string; payload: unknown }[] = []
    const cancelled: { kind: string; key: string }[] = []
    let handler: ((payload: never, key: string) => Promise<void>) | undefined
    let handlerOptions: { limit: () => number; retry: readonly [number, number] } | undefined
    const effects = {
      handle: (kind: string, run: (payload: never, key: string) => Promise<void>, extra: { limit: () => number
        retry: readonly [number, number] }) => {
        expect(kind).toBe('reply')
        handler = run
        handlerOptions = extra
      },
      enqueue: (kind: string, key: string, payload: unknown) => { queued.push({ kind, key, payload }) },
      cancel: (kind: string, key: string) => { cancelled.push({ kind, key }) },
      idle: async () => {},
    }
    const sends: OutboundMessage[] = []
    const sources = {
      instance: (id: string) => id === 'feishu' ? (options.enabled === false ? { enabled: false } : { enabled: true }) : undefined,
      channelAllowed: () => options.allowed ?? true,
      send: async (message: OutboundMessage) => { sends.push(message); return options.send ?? 'sent' },
    }
    const commands = {} as never
    const outbox = new Outbox({ store, effects: effects as never, sources: sources as never, commands,
      paused: () => options.paused ?? false })
    return { store, outbox, queued, cancelled, sends, run: (key: string) => handler!({} as never, key),
      handlerOptions: () => handlerOptions }
  }
  const message = (id: string, ticketId?: string, text = `text ${id}`): OutboundMessage => ({
    id, channel: { source: 'feishu', thread: 'oc_1:om_1', address: { chatId: 'oc_1', messageId: 'om_1' } },
    text, kind: 'reply', ...ticketId === undefined ? {} : { ticketId },
  })

  test('send 原子地写回执并入队；重复 ID 只入队一次，暂停时 limit 为 0', () => {
    const paused = host({ paused: true })
    expect(paused.handlerOptions()!.limit()).toBe(0)
    expect(paused.handlerOptions()!.retry).toEqual([5000, 300_000])
    paused.outbox.send(message('m1', 't1'))
    expect(paused.queued).toEqual([{ kind: 'reply', key: 'm1', payload: {} }])
    paused.outbox.send(message('m1', 't1'))
    expect(paused.queued).toHaveLength(1)
    expect(paused.outbox.status('m1')).toBe('pending')
    expect(paused.outbox.status('missing')).toBeUndefined()
  })

  test('withdraw 只撤还没发出去的回执，并取消对应的 reply 效果', () => {
    const only = host()
    only.outbox.send(message('m1'))
    only.outbox.withdraw('m1')
    expect(only.cancelled).toEqual([{ kind: 'reply', key: 'm1' }])
    expect(only.outbox.status('m1')).toBeUndefined()
    // 已经发出或已丢弃的回执撤不了。
    only.store.receipts.add(message('m2'))
    only.store.receipts.settle(message('m2'), 'sent')
    only.outbox.withdraw('m2')
    expect(only.cancelled).toEqual([{ kind: 'reply', key: 'm1' }])
    expect(only.outbox.status('m2')).toBe('sent')
  })

  test('deliver：来源开着、通道允许、发送成功才标记 sent', async () => {
    const harness = host()
    harness.outbox.send(message('m1', 't1'))
    await harness.run('m1')
    expect(harness.sends.map(item => item.id)).toEqual(['m1'])
    expect(harness.outbox.status('m1')).toBe('sent')
    // 重复投递已 sent 的回执是空操作。
    await harness.run('m1')
    expect(harness.sends).toHaveLength(1)
    // 不存在的回执也一样。
    await harness.run('missing')
    expect(harness.sends).toHaveLength(1)
  })

  test('deliver：来源关闭/未装、同会话前一条挡着、来源还没装上都返回 Later 等重试', async () => {
    const off = host({ enabled: false })
    off.outbox.send(message('m1'))
    await expect(off.run('m1')).rejects.toBeInstanceOf(Later)

    const waiting = host({ send: 'waiting' })
    waiting.outbox.send(message('m1'))
    await expect(waiting.run('m1')).rejects.toBeInstanceOf(Later)

    const blocked = host()
    blocked.outbox.send(message('earlier', 't1'))
    blocked.outbox.send(message('later', 't1'))
    await expect(blocked.run('later')).rejects.toBeInstanceOf(Later)
    // 前一条发出去之后，后一条就能发。
    await blocked.run('earlier')
    await blocked.run('later')
    expect(blocked.sends.map(item => item.id)).toEqual(['earlier', 'later'])
  })

  test('deliver：通道不再监听时结算成 channelIgnored，目标永远找不到时结算成 channelGone', async () => {
    const ignored = host({ allowed: false })
    ignored.outbox.send(message('m1'))
    await ignored.run('m1')
    expect(ignored.sends).toEqual([])
    expect(ignored.outbox.status('m1')).toBe('dropped')

    const gone = host({ send: 'gone' })
    gone.outbox.send(message('m1'))
    await gone.run('m1')
    expect(gone.outbox.status('m1')).toBe('dropped')
  })
})
