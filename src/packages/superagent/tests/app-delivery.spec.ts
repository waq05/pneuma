/**
 * `app/delivery.ts` 的补盲：按 request id 幂等地把一条消息投给会话。
 *
 * 转写自同包 `tests/delivery.test.mjs`（假会话 / 假 agent / 内存 KV Store 的写法照抄，见该文件头九条差异），
 * 另外补上「原地改正文」「槽位下标漂移」「重试哨兵」这些本仓原生分支。
 *
 * 假件只有两个：会话（`meta.id` / `notes` / `appendNote` / `appendUser` / `enqueueAsync` /
 * `asyncInbox` / `removeAsync`）与投递目标（`session` + `agent.isRunning` / `followup`）。
 *
 * @module dsc/packages/superagent/tests/app-delivery
 */
import { describe, expect, test } from 'vitest'
import type { Session } from '@pneuma/runtime/core/session.js'
import type { MiniAgent } from '@pneuma/session-core/loop.js'
import { AgentDelivery, DELIVERY_NOTE, messageId, requestIdOf } from '../app/delivery.js'
import type { Store } from '../app/store.js'

interface FakeNote { id: string; text: string; ts: number }
interface FakeItem { text: string; images?: string[]; origin?: string }

/** 假会话：`notes()` 是跨重启的永久账，`items` 是持久收件箱，`users` 是直接落进历史的消息。 */
function makeSession(id: string, options: { notes?: FakeNote[]; inbox?: FakeItem[]; onNotes?: () => void } = {}) {
  const session = {
    meta: { id },
    noteLog: (options.notes ?? []).map(note => ({ ...note })),
    items: (options.inbox ?? []).map(item => ({ ...item })),
    users: [] as { text: string; images?: string[]; files?: unknown; origin: string }[],
    notes() {
      options.onNotes?.()
      return session.noteLog
    },
    appendNote(noteId: string, text: string) {
      session.noteLog.push({ id: noteId, text, ts: 1 })
    },
    appendUser(text: string, images?: string[], files?: unknown, origin = 'user') {
      session.users.push({ text, images, files, origin })
    },
    enqueueAsync(text: string, images?: string[], origin = 'user') {
      session.items.push({ text, ...(images === undefined || images.length === 0 ? {} : { images }), ...(origin === 'notice' ? { origin } : {}) })
    },
    asyncInbox() {
      return session.items
    },
    removeAsync(index: number) {
      if (session.items[index] === undefined) return false
      session.items.splice(index, 1)
      return true
    },
    /** 照 `core/session.ts` 的 `editAsync`：原地换掉一格，下标不动。 */
    editAsync(index: number, text: string) {
      const item = session.items[index]
      if (item === undefined) return false
      session.items[index] = { ...item, text }
      return true
    },
  }
  return session
}

/** 假投递目标：`isRunning` 决定走「直接 followup」还是「先入箱」。 */
function makeAgent(options: { running?: boolean } = {}) {
  const agent = {
    running: options.running ?? false,
    get isRunning() {
      return agent.running
    },
    followups: [] as { text: string; images?: string[]; origin?: string }[],
    followup(text: string, images?: string[], origin?: string) {
      agent.followups.push({ text, images, origin })
    },
  }
  return agent
}

/** 内存版 Store：只实现 `AgentDelivery` 用到的 `get` / `set` / `delete` / `keys`。 */
function makeStore() {
  const rows = new Map<string, unknown>()
  return {
    rows,
    get: (key: string) => rows.get(key),
    set: (key: string, value: unknown) => { rows.set(key, value) },
    delete: (key: string) => { rows.delete(key) },
    keys: (prefix: string) => [...rows.keys()].filter(key => key.startsWith(prefix)),
  }
}

/** 一套夹具：内存 Store + 真 `AgentDelivery` + 一个还没中止的信号。 */
function fixture() {
  const store = makeStore()
  return { store, delivery: new AgentDelivery(store as unknown as Pick<Store, 'get' | 'set' | 'delete' | 'keys'>),
    signal: new AbortController().signal }
}

/** 把假会话 / 假 agent 塞进 `DeliveryTarget` 的形状（结构上的，不需要真 Session）。 */
const targetOf = (session: ReturnType<typeof makeSession>, agent: ReturnType<typeof makeAgent>) =>
  ({ session, agent } as unknown as { session: Session; agent: MiniAgent })

describe('三种模式的落点', () => {
  test('闲置会话：queue / steer 都直接 followup，来源 user / notice，落账后不再重投', async () => {
    for (const mode of ['queue', 'steer'] as const) {
      const { store, delivery, signal } = fixture()
      const session = makeSession('worker-1')
      const agent = makeAgent()
      const calls: string[] = []
      expect(await delivery.send(targetOf(session, agent), 'request', '{"event_id":"event"}', mode, signal,
        () => calls.push('authorize'), () => calls.push('accepted'))).toBe('landed')
      expect(agent.followups).toStrictEqual([{ text: '{"event_id":"event"}', images: undefined, origin: mode === 'steer' ? 'notice' : 'user' }])
      expect(session.noteLog.map(note => note.id)).toStrictEqual([messageId('request')])
      expect(session.noteLog[0]!.text).toBe(mode)
      expect([session.users.length, store.rows.size]).toStrictEqual([0, 0])
      expect(calls).toStrictEqual(['authorize', 'accepted'])
      expect(await delivery.send(targetOf(session, agent), 'request', '{"event_id":"event"}', mode, signal)).toBe('duplicate')
      expect(agent.followups).toHaveLength(1)
    }
  })

  test('跑动会话：queue / steer 都先入收件箱，claim 出账后转成永久账', async () => {
    for (const mode of ['queue', 'steer'] as const) {
      const { store, delivery, signal } = fixture()
      const session = makeSession('worker-1')
      const agent = makeAgent({ running: true })
      const target = targetOf(session, agent)
      expect(await delivery.send(target, 'request', '排队正文', mode, signal)).toBe('queued')
      expect(session.items).toStrictEqual([{ text: '排队正文', ...(mode === 'steer' ? { origin: 'notice' } : {}) }])
      expect(store.rows.size).toBe(1)
      expect(await delivery.send(target, 'request', '排队正文', mode, signal)).toBe('duplicate')
      expect(session.items).toHaveLength(1)
      session.items.splice(0)
      expect(delivery.claim(session as unknown as Session, '排队正文')).toBe('request')
      expect(session.noteLog.map(note => [note.id, note.text])).toStrictEqual([[messageId('request'), 'queued']])
      expect(store.rows.size).toBe(0)
      expect(await delivery.send(target, 'request', '排队正文', mode, signal)).toBe('duplicate')
    }
  })

  test('inject：直接写历史、来源 notice、不唤醒，同 id 第二次不再写', async () => {
    const { delivery, signal } = fixture()
    const session = makeSession('worker-1')
    const agent = makeAgent()
    const target = targetOf(session, agent)
    expect(await delivery.send(target, 'notice:settings', '{"settings_saved":"policy"}', { inject: 'Settings saved' }, signal)).toBe('landed')
    expect(session.users).toStrictEqual([{ text: '{"settings_saved":"policy"}', images: undefined, files: undefined, origin: 'notice' }])
    expect(session.noteLog.map(note => note.id)).toStrictEqual([messageId('notice:settings')])
    expect(agent.followups).toStrictEqual([])
    expect(await delivery.send(target, 'notice:settings', '{"settings_saved":"policy"}', { inject: 'Settings saved' }, signal)).toBe('duplicate')
    expect(session.users).toHaveLength(1)
  })
})

describe('跨重启与「是否持有」', () => {
  test('跨重启：note 永久账与 KV 排队账都能恢复，恢复后同一 request 不再投', async () => {
    const { delivery, signal } = fixture()
    const running = makeAgent({ running: true })
    await delivery.send(targetOf(makeSession('worker-1'), running), 'queued-request', '排队正文', 'queue', signal)
    const idle = makeAgent()
    const restored = makeSession('worker-1', { inbox: [{ text: '排队正文' }] })
    expect(await delivery.holds(targetOf(restored, idle), 'queued-request')).toBe(true)
    expect(await delivery.send(targetOf(restored, idle), 'queued-request', '排队正文', 'queue', signal)).toBe('duplicate')
    const landed = makeSession('worker-1', { notes: [{ id: messageId('done-request'), text: 'steer', ts: 1 }] })
    expect(await delivery.send(targetOf(landed, idle), 'done-request', '正文', 'steer', signal)).toBe('duplicate')
    expect(idle.followups).toStrictEqual([])
  })

  test('holds：收件箱里等待的、已经出账的都算「持有」，别的 request 不算', async () => {
    const { delivery, signal } = fixture()
    const session = makeSession('worker-1')
    const agent = makeAgent({ running: true })
    const target = targetOf(session, agent)
    expect(await delivery.holds(target, 'request')).toBe(false)
    await delivery.send(target, 'request', '排队正文', 'steer', signal)
    expect(await delivery.holds(target, 'request')).toBe(true)
    session.items.splice(0)
    delivery.claim(session as unknown as Session, '排队正文')
    expect(await delivery.holds(target, 'request')).toBe(true)
    const restored = makeSession('worker-1', { notes: [{ id: messageId('request'), text: 'steer', ts: 1 }] })
    expect([await delivery.holds(targetOf(restored, agent), 'request'), await delivery.holds(targetOf(restored, agent), 'other')])
      .toStrictEqual([true, false])
  })
})

describe('认回、撤回、丢弃', () => {
  test('claim：按正文认回 requestId，不认识给 undefined，认回后排队账清掉', async () => {
    const { store, delivery, signal } = fixture()
    const session = makeSession('worker-1')
    const agent = makeAgent({ running: true })
    await delivery.send(targetOf(session, agent), 'request', '正文 A', 'queue', signal)
    expect(delivery.claim(session as unknown as Session, '正文 B')).toBeUndefined()
    await delivery.send(targetOf(session, agent), 'request-2', '正文 B', 'queue', signal)
    expect(delivery.claim(session as unknown as Session, '正文 A')).toBe('request')
    expect(delivery.claim(session as unknown as Session, '正文 A')).toBeUndefined()
    expect(store.rows.size).toBe(1)
  })

  test('forget：撤掉还没出账的那条并清 KV；已出账或没排过返回 false', async () => {
    const { store, delivery, signal } = fixture()
    const session = makeSession('worker-1')
    const running = makeAgent({ running: true })
    await delivery.send(targetOf(session, running), 'request', '排队正文', 'queue', signal)
    expect(delivery.forget(session as unknown as Session, 'request')).toBe(true)
    expect(session.items).toStrictEqual([])
    expect(store.rows.size).toBe(0)
    expect(await delivery.holds(targetOf(session, running), 'request')).toBe(false)
    expect(delivery.forget(session as unknown as Session, 'request')).toBe(false)
    const landed = makeSession('worker-2')
    await delivery.send(targetOf(landed, makeAgent()), 'landed', '正文', 'queue', signal)
    expect(delivery.forget(landed as unknown as Session, 'landed')).toBe(false)
  })

  test('discard：清掉这个会话所有还没出账的登记，收件箱条目留给会话自己处置', async () => {
    const { store, delivery, signal } = fixture()
    const session = makeSession('worker-1')
    const agent = makeAgent({ running: true })
    const target = targetOf(session, agent)
    await delivery.send(target, 'a', '正文 A', 'queue', signal)
    await delivery.send(target, 'b', '正文 B', 'steer', signal)
    expect(store.rows.size).toBe(2)
    delivery.discard(session as unknown as Session)
    expect(store.rows.size).toBe(0)
    expect(await delivery.holds(target, 'a')).toBe(false)
    expect(await delivery.holds(target, 'b')).toBe(false)
    expect(session.items).toHaveLength(2)
  })
})

describe('收件箱槽位：正文被原地改过仍认得出、下标漂移后按对象认回', () => {
  test('editAsync 原地改正文后 forget 仍能撤掉；同下标换出来的新对象不会被误认', async () => {
    const { delivery, signal } = fixture()
    const session = makeSession('worker-1')
    const running = makeAgent({ running: true })
    const target = targetOf(session, running)
    await delivery.send(target, 'request', '原文', 'queue', signal)
    // 用户编辑排队正文：对象换了、下标没动。
    expect(session.editAsync(0, '改过的正文')).toBe(true)
    expect(await delivery.holds(target, 'request')).toBe(true)
    expect(delivery.forget(session as unknown as Session, 'request')).toBe(true)
    expect(session.items).toHaveLength(0)
  })

  test('前面出账把下标挪了，仍按对象认回；重投第二次不重复入箱', async () => {
    const { delivery, signal } = fixture()
    const session = makeSession('worker-1')
    const running = makeAgent({ running: true })
    const target = targetOf(session, running)
    await delivery.send(target, 'first', '第一条', 'queue', signal)
    await delivery.send(target, 'second', '第二条', 'queue', signal)
    // 第一条先出账，第二条从下标 1 漂到 0。
    session.items.splice(0, 1)
    expect(await delivery.holds(target, 'second')).toBe(true)
    expect(delivery.claim(session as unknown as Session, '第二条')).toBe('second')
    expect(await delivery.send(target, 'second', '第二条', 'queue', signal)).toBe('duplicate')
  })
})

describe('取消与授权钩子', () => {
  test('投递前已中止直接抛 AbortError，authorize 都不调；读永久账期间中止也不投', async () => {
    const { delivery } = fixture()
    const aborted = new AbortController()
    aborted.abort()
    let authorized = 0
    const session = makeSession('worker-1')
    await expect(delivery.send(targetOf(session, makeAgent()), 'request', '正文', 'queue', aborted.signal,
      () => { authorized += 1 })).rejects.toMatchObject({ name: 'AbortError' })
    expect(authorized).toBe(0)
    const mid = new AbortController()
    const slow = makeSession('worker-2', { onNotes: () => mid.abort() })
    const idle = makeAgent()
    await expect(delivery.send(targetOf(slow, idle), 'request', '正文', 'queue', mid.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(idle.followups).toStrictEqual([])
  })

  test('authorize 在动手前调、accepted 在投出去后调；重投也调 accepted，authorize 抛错则一条都不投', async () => {
    const { delivery, signal } = fixture()
    const calls: string[] = []
    const session = makeSession('worker-1')
    const agent = makeAgent()
    const target = targetOf(session, agent)
    const authorize = () => calls.push('authorize')
    const accepted = () => calls.push('accepted')
    expect(await delivery.send(target, 'request', '正文', 'steer', signal, authorize, accepted)).toBe('landed')
    expect(await delivery.send(target, 'request', '正文', 'steer', signal, authorize, accepted)).toBe('duplicate')
    expect(calls).toStrictEqual(['authorize', 'accepted', 'authorize', 'accepted'])
    const failing = makeAgent()
    await expect(delivery.send(targetOf(makeSession('worker-2'), failing), 'request', '正文', 'steer', signal,
      () => { throw new Error('没授权') })).rejects.toThrow(/没授权/)
    expect(failing.followups).toStrictEqual([])
  })
})

describe('导出的小账本工具', () => {
  test('messageId / requestIdOf：投递 id 往返一致，外来 id 不认', () => {
    expect(DELIVERY_NOTE).toBe('dsh-superagent:')
    expect(messageId('request')).toBe('dsh-superagent:request')
    expect(requestIdOf('dsh-superagent:request')).toBe('request')
    expect(requestIdOf('someone-else:request')).toBeUndefined()
  })
})
