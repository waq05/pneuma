/**
 * @pneuma/superagent `app/delivery.js` 的包级测试：按 request id 幂等地把一条消息投给会话，
 * 三种模式（queue / steer / inject）的落点、永久账与排队账、撤回与「这条会话是否持有」。
 *
 * 转写自上游 `tests/delivery.spec.ts`。本仓是原生重写（见 `app/delivery.ts` 文件头的九条差异），
 * 上游依赖的 DSH 能力换成了本仓能力，所以每条都标了对应关系：
 *
 * | 上游断言 | 本仓原生等价 | 本测试 |
 * | --- | --- | --- |
 * | 消息 id `dsh-superagent:<requestId>` + session-persistence 回放 | 投递成功写一条同 id 的 note，重启后 `session.notes()` 读得到 | 假会话的 `notes()` / `appendNote()` 就是这本账 |
 * | `agent.followup(message)` / `agent.steer(message)` | 闲置时 `agent.followup(text, undefined, origin)` | 假 agent 记下三次入参 |
 * | `agent.inbox`（nextTurn / nextStep） | 跑动中 `session.enqueueAsync(text, undefined, origin)`（持久收件箱） | 假会话的 `items` 就是收件箱 |
 * | `agent.inject(message)` | `session.appendUser(text, undefined, undefined, 'notice')` | 假会话的 `users` |
 * | `sessionPersistence.flush()` | 本仓同步落盘，没有 flush | 上游那条「flush 失败重试」在这里无等价物，已跳过 |
 * | 翻页读历史（每次 512 条） | 本仓一次从 `session.notes()` 建缓存，没有翻页 | 上游「读历史失败重试 / 翻页」两条已跳过 |
 * | 认老插件消息来源 / 老 user RPC 身份 | 本仓没有那套消息来源表（文件头第 8 条） | 上游两条 legacy 身份用例已跳过 |
 * | `ctx.reflect.provide('agents')` 判 disposed | 本仓没有 agent 注册表，目标由调用方传进来 | 上游「disposed」半边已跳过，abort 半边照测 |
 *
 * 假件只有两个：会话（`meta.id` / `notes` / `appendNote` / `appendUser` / `enqueueAsync` /
 * `asyncInbox` / `removeAsync`）与投递目标（`session` + `agent.isRunning` / `followup`）。
 * 语义照 `core/session.ts`，只实现 `AgentDelivery` 用到的成员。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/delivery
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { AgentDelivery, DELIVERY_NOTE, messageId, requestIdOf } =
  await import('../../../../lib/packages/superagent/app/delivery.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/**
 * 假会话：`notes()` 是跨重启的永久账，`items` 是持久收件箱（`asyncInbox` 的只读快照），
 * `users` 是直接落进历史的消息。写入语义照 `core/session.ts`：
 * `enqueueAsync` 只在机器来源（`notice`）时记 `origin`，`appendUser` 缺省来源是 `user`。
 */
function makeSession(id, { notes = [], inbox = [], onNotes } = {}) {
  const session = {
    meta: { id },
    noteLog: notes.map((note) => ({ ...note })),
    items: inbox.map((item) => ({ ...item })),
    users: [],
    notes() {
      onNotes?.()
      return session.noteLog
    },
    appendNote(noteId, text) {
      session.noteLog.push({ id: noteId, text, ts: 1 })
    },
    appendUser(text, images, files, origin = 'user') {
      session.users.push({ text, images, files, origin })
    },
    enqueueAsync(text, images, origin = 'user') {
      session.items.push({
        text,
        ...(images === undefined || images.length === 0 ? {} : { images }),
        ...(origin === 'notice' ? { origin } : {}),
      })
    },
    asyncInbox() {
      return session.items
    },
    removeAsync(index) {
      if (session.items[index] === undefined) return false
      session.items.splice(index, 1)
      return true
    },
  }
  return session
}

/** 假投递目标：`isRunning` 决定走「直接 followup」还是「先入箱」，`followups` 记下每次入参。 */
function makeAgent({ running = false } = {}) {
  const agent = {
    running,
    get isRunning() {
      return agent.running
    },
    followups: [],
    followup(text, images, origin) {
      agent.followups.push({ text, images, origin })
    },
  }
  return agent
}

/** 内存版 Store：只实现 `AgentDelivery` 用到的 `get` / `set` / `delete` / `keys`。 */
function makeStore() {
  const rows = new Map()
  return {
    rows,
    get: (key) => rows.get(key),
    set: (key, value) => { rows.set(key, value) },
    delete: (key) => { rows.delete(key) },
    keys: (prefix) => [...rows.keys()].filter((key) => key.startsWith(prefix)),
  }
}

/** 一套夹具：内存 Store + 真 `AgentDelivery` + 一个还没中止的信号。 */
function fixture() {
  const store = makeStore()
  return { store, delivery: new AgentDelivery(store), signal: new AbortController().signal }
}

// ── 1. 三种模式的落点 ───────────────────────────────────────────────────────

test('闲置会话：queue / steer 都直接 followup，来源分别是 user / notice，落账后不再重投', async () => {
  for (const mode of ['queue', 'steer']) {
    const { store, delivery, signal } = fixture()
    const session = makeSession('worker-1')
    const agent = makeAgent()
    const calls = []
    assert.equal(
      await delivery.send({ session, agent }, 'request', '{"event_id":"event"}', mode, signal, () => calls.push('authorize'), () => calls.push('accepted')),
      'landed',
    )
    assert.deepEqual(agent.followups, [{ text: '{"event_id":"event"}', images: undefined, origin: mode === 'steer' ? 'notice' : 'user' }])
    assert.deepEqual(session.noteLog.map((note) => note.id), [messageId('request')], '永久账记的是投递 id')
    assert.equal(session.noteLog[0].text, mode, '备注里记这次是哪种模式，便于事后对账')
    assert.deepEqual([session.users.length, store.rows.size], [0, 0], '闲置投递不进历史（inject 才进）、不留排队账')
    assert.deepEqual(calls, ['authorize', 'accepted'])
    // 上游：同一 request 再投一次不再调 steer/followup。
    assert.equal(await delivery.send({ session, agent }, 'request', '{"event_id":"event"}', mode, signal), 'duplicate')
    assert.equal(agent.followups.length, 1, '第二次不发')
  }
  passed += 1
})

test('跑动会话：queue / steer 都先入持久收件箱，来源映射一致；claim 出账后转成永久账', async () => {
  for (const mode of ['queue', 'steer']) {
    const { store, delivery, signal } = fixture()
    const session = makeSession('worker-1')
    const agent = makeAgent({ running: true })
    const target = { session, agent }
    assert.equal(await delivery.send(target, 'request', '排队正文', mode, signal), 'queued')
    assert.deepEqual(session.items, [{ text: '排队正文', ...(mode === 'steer' ? { origin: 'notice' } : {}) }])
    assert.equal(store.rows.size, 1, '排队账也记进 KV，重启后执行器要按 requestId 撤得掉')
    assert.equal(await delivery.send(target, 'request', '排队正文', mode, signal), 'duplicate')
    assert.equal(session.items.length, 1, '重复投递不重复入箱')
    // 收件箱出账时按正文认回 requestId（本仓原生等价：上游按消息 id）。
    session.items.splice(0)
    assert.equal(delivery.claim(session, '排队正文'), 'request')
    assert.deepEqual(session.noteLog.map((note) => [note.id, note.text]), [[messageId('request'), 'queued']])
    assert.equal(store.rows.size, 0, '出账后排队账清掉')
    assert.equal(await delivery.send(target, 'request', '排队正文', mode, signal), 'duplicate')
  }
  passed += 1
})

test('inject：直接写历史、来源 notice、不唤醒，同 id 第二次不再写', async () => {
  const { delivery, signal } = fixture()
  const session = makeSession('worker-1')
  const agent = makeAgent()
  const target = { session, agent }
  assert.equal(await delivery.send(target, 'notice:settings', '{"settings_saved":"policy"}', { inject: 'Settings saved' }, signal), 'landed')
  assert.deepEqual(session.users, [{ text: '{"settings_saved":"policy"}', images: undefined, files: undefined, origin: 'notice' }])
  assert.deepEqual(session.noteLog.map((note) => note.id), [messageId('notice:settings')])
  assert.deepEqual(agent.followups, [])
  assert.equal(await delivery.send(target, 'notice:settings', '{"settings_saved":"policy"}', { inject: 'Settings saved' }, signal), 'duplicate')
  assert.equal(session.users.length, 1)
  passed += 1
})

// ── 2. 跨重启与「是否持有」 ─────────────────────────────────────────────────

test('跨重启：note 永久账与 KV 排队账都能恢复，恢复后同一 request 不再投', async () => {
  const { delivery, signal } = fixture()
  const running = makeAgent({ running: true })
  const before = makeSession('worker-1')
  await delivery.send({ session: before, agent: running }, 'queued-request', '排队正文', 'queue', signal)
  const idle = makeAgent()
  // 重启后是新的会话对象：KV 账恢复成「还没出账」，收件箱从会话日志恢复。
  const restored = makeSession('worker-1', { inbox: [{ text: '排队正文' }] })
  assert.equal(await delivery.holds({ session: restored, agent: idle }, 'queued-request'), true)
  assert.equal(await delivery.send({ session: restored, agent: idle }, 'queued-request', '排队正文', 'queue', signal), 'duplicate')
  // 已经出账的 note 账：另一个 request 在重启后直接判重。
  const landed = makeSession('worker-1', { notes: [{ id: messageId('done-request'), text: 'steer' }] })
  assert.equal(await delivery.send({ session: landed, agent: idle }, 'done-request', '正文', 'steer', signal), 'duplicate')
  assert.deepEqual(idle.followups, [], '恢复出来的两种账都不再投')
  passed += 1
})

test('holds：收件箱里等待的、已经出账的、历史里的都算「持有」，别的 request 不算', async () => {
  // 上游第 137 行：pending 在 inbox / 已被取走 / 在会话历史里 三种位置都返回 true。
  const { delivery, signal } = fixture()
  const session = makeSession('worker-1')
  const agent = makeAgent({ running: true })
  const target = { session, agent }
  assert.equal(await delivery.holds(target, 'request'), false)
  await delivery.send(target, 'request', '排队正文', 'steer', signal)
  assert.equal(await delivery.holds(target, 'request'), true, '还在收件箱里等着')
  // 回合出账：loop 先 takeAsyncInbox 取走条目，再把这条消息写进历史，最后调 claim 转正。
  session.items.splice(0)
  delivery.claim(session, '排队正文')
  assert.equal(await delivery.holds(target, 'request'), true, '已经出账（note 账）')
  const restored = makeSession('worker-1', { notes: [{ id: messageId('request'), text: 'steer' }] })
  assert.deepEqual(
    [await delivery.holds({ session: restored, agent }, 'request'), await delivery.holds({ session: restored, agent }, 'other')],
    [true, false],
  )
  passed += 1
})

// ── 3. 认回、撤回、丢弃 ─────────────────────────────────────────────────────

test('claim：按正文认回 requestId，不认识就给 undefined，认回后排队账清掉', async () => {
  const { store, delivery, signal } = fixture()
  const session = makeSession('worker-1')
  const agent = makeAgent({ running: true })
  await delivery.send({ session, agent }, 'request', '正文 A', 'queue', signal)
  assert.equal(delivery.claim(session, '正文 B'), undefined, '没有排过这条正文')
  await delivery.send({ session, agent }, 'request-2', '正文 B', 'queue', signal)
  assert.equal(delivery.claim(session, '正文 A'), 'request')
  assert.equal(delivery.claim(session, '正文 A'), undefined, '认回一次就没了')
  assert.equal(store.rows.size, 1, '另一个 request 的排队账还在')
  passed += 1
})

test('forget：撤掉还没出账的那条并清 KV；已出账或没排过都返回 false', async () => {
  const { store, delivery, signal } = fixture()
  const session = makeSession('worker-1')
  const running = makeAgent({ running: true })
  await delivery.send({ session, agent: running }, 'request', '排队正文', 'queue', signal)
  assert.equal(delivery.forget(session, 'request'), true)
  assert.deepEqual(session.items, [], '收件箱里的那条撤掉')
  assert.equal(store.rows.size, 0, 'KV 排队账一起清')
  assert.equal(await delivery.holds({ session, agent: running }, 'request'), false)
  assert.equal(delivery.forget(session, 'request'), false, '已经撤过')
  const landed = makeSession('worker-2')
  await delivery.send({ session: landed, agent: makeAgent() }, 'landed', '正文', 'queue', signal)
  assert.equal(delivery.forget(landed, 'landed'), false, '已出账的不能撤')
  passed += 1
})

test('discard：清掉这个会话所有还没出账的登记（收件箱条目留给会话自己处置）', async () => {
  const { store, delivery, signal } = fixture()
  const session = makeSession('worker-1')
  const agent = makeAgent({ running: true })
  const target = { session, agent }
  await delivery.send(target, 'a', '正文 A', 'queue', signal)
  await delivery.send(target, 'b', '正文 B', 'steer', signal)
  assert.equal(store.rows.size, 2)
  delivery.discard(session)
  assert.equal(store.rows.size, 0)
  assert.equal(await delivery.holds(target, 'a'), false)
  assert.equal(await delivery.holds(target, 'b'), false)
  // 本仓 discard 只清登记，不动收件箱（`core/session.ts` 的条目由停会话的调用方处置）。
  assert.equal(session.items.length, 2)
  passed += 1
})

// ── 4. 取消与授权钩子 ───────────────────────────────────────────────────────

test('投递前已中止直接抛 AbortError，authorize 都不调；读永久账期间中止也不投', async () => {
  const { delivery } = fixture()
  const aborted = new AbortController()
  aborted.abort()
  let authorized = 0
  const session = makeSession('worker-1')
  const target = { session, agent: makeAgent() }
  await assert.rejects(delivery.send(target, 'request', '正文', 'queue', aborted.signal, () => { authorized += 1 }), (error) => error.name === 'AbortError')
  assert.equal(authorized, 0, '先查信号再授权')
  // 读 note 账（holds 的第一步）期间中止：await 回来后第二次 throwIfAborted 拦住投递。
  const mid = new AbortController()
  const slow = makeSession('worker-2', { onNotes: () => mid.abort() })
  const idle = makeAgent()
  await assert.rejects(delivery.send({ session: slow, agent: idle }, 'request', '正文', 'queue', mid.signal), (error) => error.name === 'AbortError')
  assert.deepEqual(idle.followups, [])
  passed += 1
})

test('authorize 在动手前调、accepted 在投出去后调；重投也调 accepted，authorize 抛错则一条都不投', async () => {
  const { delivery, signal } = fixture()
  const calls = []
  const session = makeSession('worker-1')
  const agent = makeAgent()
  const target = { session, agent }
  const authorize = () => calls.push('authorize')
  const accepted = () => calls.push('accepted')
  assert.equal(await delivery.send(target, 'request', '正文', 'steer', signal, authorize, accepted), 'landed')
  assert.equal(await delivery.send(target, 'request', '正文', 'steer', signal, authorize, accepted), 'duplicate')
  assert.deepEqual(calls, ['authorize', 'accepted', 'authorize', 'accepted'])
  const failing = makeAgent()
  await assert.rejects(
    delivery.send({ session: makeSession('worker-2'), agent: failing }, 'request', '正文', 'steer', signal, () => { throw new Error('没授权') }),
    /没授权/,
  )
  assert.deepEqual(failing.followups, [], '授权失败一条都不投')
  passed += 1
})

// ── 5. 导出的小账本工具 ─────────────────────────────────────────────────────

test('messageId / requestIdOf：投递 id 往返一致，外来 id 不认', () => {
  assert.equal(DELIVERY_NOTE, 'dsh-superagent:')
  assert.equal(messageId('request'), 'dsh-superagent:request')
  assert.equal(requestIdOf('dsh-superagent:request'), 'request')
  assert.equal(requestIdOf('someone-else:request'), undefined)
  passed += 1
})
