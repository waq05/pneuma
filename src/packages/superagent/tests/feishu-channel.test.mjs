/**
 * @pneuma/superagent 飞书渠道与后台循环的离线用例。
 *
 * 钉六件事，每件坏了都不报错、只是静默跑歪：
 *   1. 回消息的命令行：少一个 `--idempotency-key` 就会把同一句话贴两遍；参数拼错，飞书直接拒；
 *   2. 长连接事件归一：一条 `im.message.receive_v1` 必须变成带正确 id / 话题 / 作者的 Trigger；
 *   3. 机器人自己的消息不进：不跳过它，它自己的回复会被当成新需求再派一遍；
 *   4. 补漏轮询：历史消息归一、游标落 `kv`、重叠窗口不重复投递；
 *   5. 不可回复与可重试：撤回 / 删除不重试，其余照抛——混为一谈会永远重试或错误丢弃；
 *   6. `status()`：连上、连不上、读失败三种情况各留下什么。
 * 另加一条话题轮询的用例：首轮只建立已读基线、之后按已读名单只投新回复。
 *
 * 全程离线：`run` / `consume` 都是假函数，没有真 CLI、没有网络；`kv` 用临时目录里的真库，
 * 但不碰真实的 `~/.dsc`（DSC_HOME 在 import `lib/` 之前指到临时目录，同 `recovery.test.mjs:27-36`）。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/feishu-channel
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// 必须在 import lib/ 之前设好：core/path-policy 的 DSC_HOME 是模块加载那一刻定死的。
const home = mkdtempSync(join(tmpdir(), 'superagent-feishu-channel-'))
process.env['DSC_HOME'] = home

const { sendFeishu, feishuChatLink } = await import('../../../../lib/packages/superagent/adapters/feishu/channel.js')
const { createFeishuSource, FEISHU_KEYS } = await import('../../../../lib/packages/superagent/adapters/feishu/loops.js')
const { readFeishuImage } = await import('../../../../lib/packages/superagent/adapters/feishu/image.js')
const { feishuTriggerId } = await import('../../../../lib/packages/superagent/adapters/feishu/trigger.js')
const { AttachmentStore } = await import('../../../../lib/core/attachments.js')
const { openStore } = await import('../../../../lib/packages/superagent/adapters/store.js')

const BOT = { id: 'ou_bot', appId: 'cli_app' }
const stores = []

after(() => {
  for (const store of stores) store.close()
  rmSync(home, { recursive: true, force: true })
})

/** 一条出站消息；默认回复 `om_1`。 */
function outbound(overrides = {}) {
  return {
    id: 'reply-1',
    kind: 'reply',
    text: 'README 的错别字改好了',
    channel: { source: 'feishu', thread: 'feishu:oc_chat', address: { chatId: 'oc_chat', messageId: 'om_1' } },
    ...overrides,
  }
}

/** 假 CLI：记下每次调用的参数与工作目录，结果由 `handler` 给。 */
function fakeRun(handler) {
  const calls = []
  const run = async (args, cwd) => {
    calls.push({ args: [...args], cwd })
    return handler(args, cwd)
  }
  return { calls, run }
}

/** 一次成功的信封。 */
const ok = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' })

/** 假的常驻消费器：`lines` 按 `[流, 行]` 给，`done` 决定退出结果。 */
function fakeConsume(lines, done = () => new Promise(() => {})) {
  const calls = []
  return {
    calls,
    consume(args, handlers) {
      calls.push([...args])
      queueMicrotask(() => {
        for (const [stream, line] of lines) handlers[stream](line)
      })
      return { stop() {}, done: done() }
    },
  }
}

/** 一直等到条件成立：用来等后台循环的异步结果，避免写死 sleep 时长。 */
async function until(check, what) {
  for (let index = 0; index < 400; index += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** 每个用例一个临时库：用例之间不共享游标，失败也不互相污染。 */
function newStore(label) {
  const store = openStore(join(home, `${label}.sqlite`))
  stores.push(store)
  return store
}

/** 读 `kv` 里一条（值都是 JSON）。 */
function readKv(store, key) {
  const row = store.handle.prepare('SELECT value FROM kv WHERE key = ?').get(key)
  return row === undefined ? undefined : JSON.parse(row.value)
}

/** 一条历史接口的消息；`at` 是 ISO，`create_time` 用毫秒串（飞书的形状）。 */
function historical(messageId, at) {
  return {
    message_id: messageId,
    chat_id: 'oc_chat',
    create_time: String(Date.parse(at)),
    sender: { id: 'ou_alice', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `改 ${messageId}` }) },
  }
}

test('回消息：命令行按 lark-cli 的形状拼，成功返回 sent', async () => {
  const { calls, run } = fakeRun(() => ok({ message_id: 'om_sent' }))
  const result = await sendFeishu(run, outbound())
  assert.equal(result, 'sent')
  assert.deepEqual(calls.map((call) => call.args), [[
    'im', '+messages-reply', '--message-id', 'om_1', '--markdown', 'README 的错别字改好了',
    '--reply-in-thread', '--idempotency-key', 'reply-1', '--as', 'bot', '--format', 'json',
  ]])
  assert.equal(calls[0].cwd, undefined, '回消息不需要工作目录')
  assert.equal(feishuChatLink('lark', 'oc_a b'), 'https://applink.larksuite.com/client/chat/open?openChatId=oc_a%20b')
})

test('回消息：退出码非 0 时报出 stderr 与退出码，不伪造飞书错误码', async () => {
  const { run } = fakeRun(() => ({ code: 1, stdout: '', stderr: 'lark-cli: token expired' }))
  await assert.rejects(sendFeishu(run, outbound()), (error) => {
    assert.match(error.message, /token expired/)
    assert.equal(error.exitCode, 1)
    assert.equal(error.code, undefined, 'stderr 里没有飞书信封时不猜一个码')
    return true
  })
})

test('长连接：一条 receive_v1 事件变成一条正确的 Trigger，并记下已连上', async () => {
  const event = {
    message_id: 'om_9', chat_id: 'oc_chat', chat_type: 'group', sender_id: 'ou_alice', sender_type: 'user',
    content: '@_user_1 把 README 里的错别字改掉', create_time: '1767225600000',
    mentions: [{ id: BOT.id, key: '@_user_1', name: 'SuperAgent' }],
    root_id: 'om_root', thread_id: 'omt_1', message_app_link: 'https://applink.feishu.cn/client/message/link',
  }
  const received = []
  const consumer = fakeConsume([['stderr', '[event] ready'], ['stdout', JSON.stringify(event)]])
  const source = createFeishuSource({
    run: fakeRun(() => ok({ items: [], has_more: false })).run,
    consume: consumer.consume,
    bot: BOT,
    engine: { receive(trigger) { received.push(trigger); return 'stored' } },
    store: newStore('live'),
    config: { chats: [], directMessages: false },
    now: () => '2026-01-01T00:00:00.000Z',
    log: () => {},
  })
  source.start()
  try {
    await until(() => received.length === 1, 'the event to reach the engine')
    assert.deepEqual(consumer.calls, [['event', 'consume', 'im.message.receive_v1', '--as', 'bot']])
    const [trigger] = received
    assert.equal(trigger.id, feishuTriggerId('om_9'), 'id 只由 message_id 算，重读同一条不会派两次活')
    assert.deepEqual(trigger.threads, [{ source: 'feishu', id: 'oc_chat:om_root' }])
    assert.deepEqual(trigger.actor, { source: 'feishu', id: 'ou_alice' })
    assert.equal(trigger.human, true)
    assert.equal(trigger.addressed, 'mention')
    assert.equal(trigger.text, '@SuperAgent 把 README 里的错别字改掉')
    assert.equal(trigger.url, event.message_app_link)
    assert.deepEqual(trigger.meta, {
      chatId: 'oc_chat', messageId: 'om_9', direct: false, mentioned: true, rootId: 'om_root', threadId: 'omt_1',
    })
    assert.deepEqual(source.status(), { connected: true, lastPollAt: '2026-01-01T00:00:00.000Z', lastError: null })
  } finally {
    source.stop()
  }
})

test('长连接：机器人自己发的消息（两种 id）都不进 engine.receive', async () => {
  const mine = (senderId) => JSON.stringify({
    message_id: `om_${senderId}`, chat_id: 'oc_chat', chat_type: 'p2p', sender_id: senderId, sender_type: 'bot',
    content: '我自己刚回的', create_time: '1767225600000', mentions: [],
  })
  const received = []
  const source = createFeishuSource({
    run: fakeRun(() => ok({})).run,
    consume: fakeConsume([
      ['stderr', '[event] ready'],
      ['stdout', mine(BOT.id)],
      ['stdout', mine(BOT.appId)],
    ]).consume,
    bot: BOT,
    engine: { receive(trigger) { received.push(trigger); return 'stored' } },
    store: newStore('own'),
    config: { chats: [], directMessages: false },
    now: () => '2026-01-01T00:00:00.000Z',
    log: () => {},
  })
  source.start()
  try {
    await until(() => source.status().connected, 'the consumer to become ready')
    // 两行都是自己的：给处理链两个微任务的时间，再断言它一条都没交出去。
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(received, [])
  } finally {
    source.stop()
  }
})

test('补漏轮询：历史归一成 Trigger、游标写进 kv、重叠窗口不重复投递', async () => {
  const messages = [historical('om_a', '2026-01-01T00:00:30.000Z'), historical('om_b', '2026-01-01T00:00:58.000Z')]
  const { calls, run } = fakeRun((args) => {
    // 只走历史接口；按接口的 start_time / end_time 过滤，模拟服务端窗口。
    const params = JSON.parse(args[args.indexOf('--params') + 1])
    const from = Number(params.start_time) * 1000
    const to = Number(params.end_time) * 1000
    const items = messages.filter((message) => {
      const at = Number(message.create_time)
      return at >= from && at < to
    })
    return ok({ items, has_more: false })
  })
  const store = newStore('backfill')
  const received = []
  let clock = '2026-01-01T00:00:10.000Z'
  const source = createFeishuSource({
    run,
    bot: BOT,
    engine: { receive(trigger) { received.push(trigger); return 'stored' } },
    store,
    config: { chats: [{ chatId: 'oc_chat' }], directMessages: false },
    now: () => clock,
    log: () => {},
  })

  // 第一拍只记起点：装好就把整段历史倒进来是错的。
  await source.tick()
  assert.deepEqual(received, [])
  assert.equal(readKv(store, FEISHU_KEYS.history('oc_chat')), '2026-01-01T00:00:10.000Z')

  clock = '2026-01-01T00:01:00.000Z'
  await source.tick()
  assert.deepEqual(received.map((trigger) => trigger.id), [feishuTriggerId('om_a'), feishuTriggerId('om_b')])
  assert.equal(received[0].text, '改 om_a')
  assert.equal(received[0].human, true)
  assert.deepEqual(received[0].threads, [{ source: 'feishu', id: 'oc_chat:om_a' }])
  assert.equal(received[0].at, '2026-01-01T00:00:30.000Z')
  // 游标回退 5 秒，迟到的远端事件才不漏。
  assert.equal(readKv(store, FEISHU_KEYS.history('oc_chat')), '2026-01-01T00:00:55.000Z')
  assert.deepEqual(calls.at(-1).args.slice(0, 3), ['api', 'GET', '/open-apis/im/v1/messages'])

  // 第三拍从 00:00:55 起读，服务端把 00:00:58 那条再给一次：已在名单里，不再投递。
  clock = '2026-01-01T00:01:30.000Z'
  await source.tick()
  assert.equal(received.length, 2, '重叠窗口里的消息不该再进一次 engine.receive')
  assert.equal(readKv(store, FEISHU_KEYS.history('oc_chat')), '2026-01-01T00:01:25.000Z')
})

test('不可回复与可重试：撤回 / 删除回 gone，限流与连不上照抛', async () => {
  const reply = (stderr, code = 1, stdout = '') => fakeRun(() => ({ code, stdout, stderr })).run
  // 撤回：230011 直接判死。
  assert.equal(await sendFeishu(reply(JSON.stringify({ ok: false, error: { code: 230011, message: 'message withdrawn' } })), outbound()), 'gone')
  // 删除：2300xx 段带 not found 也判死。
  assert.equal(await sendFeishu(reply('', 0, JSON.stringify({ ok: false, error: { code: 230099, message: 'message not found' } })), outbound()), 'gone')
  // 不是「回不了」：连不上，重试才有用；没有飞书码，不该被 gone 吞掉。
  await assert.rejects(sendFeishu(reply('connection reset by peer'), outbound()), /connection reset/)
  // 限流同理：带码但不在 gone 的判据里，照抛，让队列退避重试。
  await assert.rejects(sendFeishu(reply(JSON.stringify({ ok: false, error: { code: 230020, message: 'rate limited' } })), outbound()), (error) => {
    assert.equal(error.code, 230020)
    return true
  })
})

test('status：连上后 connected 为真且 lastError 清空；连不上与补收失败各留原因', async () => {
  const base = {
    run: fakeRun(() => ok({ items: [], has_more: false })).run,
    bot: BOT,
    engine: { receive() { return 'stored' } },
    store: newStore('status-ok'),
    config: { chats: [], directMessages: false },
    now: () => '2026-01-01T00:00:00.000Z',
    log: () => {},
  }
  const connected = createFeishuSource({ ...base, consume: fakeConsume([['stderr', '[event] ready']]).consume })
  connected.start()
  try {
    await until(() => connected.status().connected, 'the consumer to become ready')
    assert.deepEqual(connected.status(), { connected: true, lastPollAt: '2026-01-01T00:00:00.000Z', lastError: null })
  } finally {
    connected.stop()
  }
  assert.equal(connected.status().connected, false, '停掉之后不该还显示连着')

  // 长连接报错后退出：connected 为假，原因留在 lastError。
  const failing = createFeishuSource({
    ...base,
    store: newStore('status-consume'),
    consume: fakeConsume([['stderr', '[event] error: connection reset']],
      () => new Promise((resolve) => setTimeout(() => resolve({ code: 1, stdout: '', stderr: 'connection reset' }), 5))).consume,
  })
  failing.start()
  try {
    await until(() => failing.status().lastError !== null, 'the consumer failure to be recorded')
    assert.equal(failing.status().connected, false)
    assert.match(failing.status().lastError, /connection reset/)
  } finally {
    failing.stop()
  }

  // 补收读失败：tick 不抛（一轮里各群各自失败），原因进 lastError。
  const broken = createFeishuSource({
    run: fakeRun(() => ({ code: 1, stdout: '', stderr: 'history exploded' })).run,
    bot: BOT,
    engine: { receive() { return 'stored' } },
    store: newStore('status-poll'),
    config: { chats: [{ chatId: 'oc_chat' }], directMessages: false },
    now: () => '2026-01-01T00:01:00.000Z',
    log: () => {},
  })
  await broken.tick()
  await broken.tick()
  assert.match(broken.status().lastError, /history exploded/)
  assert.equal(broken.status().connected, false, '没有长连接时 connected 恒为假')
})

test('话题轮询：首轮只建立已读基线，之后只投递新回复', async () => {
  const source = { message_id: 'om_root', chat_id: 'oc_chat', thread_id: 'omt_1' }
  const page = (messageId, at) => ({
    message_id: messageId, chat_id: 'oc_chat', thread_id: 'omt_1', msg_type: 'text', content: `回复 ${messageId}`,
    sender: { id: 'ou_guest', name: 'Guest', sender_type: 'user' }, create_time: String(Date.parse(at)),
  })
  // 根消息与旧回复都比订阅早：首轮只建立已读基线，不该把它们当新需求。
  const rootMessage = page('om_root', '2025-12-31T23:30:00.000Z')
  const old = page('om_old', '2025-12-31T23:00:00.000Z')
  const reply1 = page('om_r1', '2026-01-01T00:01:00.000Z')
  const reply2 = page('om_r2', '2026-01-01T00:02:00.000Z')
  let listing = [rootMessage, old, reply1]
  const { run } = fakeRun((args) => {
    if (args[0] === 'api' && args[2] === '/open-apis/im/v1/messages/mget') return ok({ items: [source] })
    if (args[0] === 'im' && args[1] === '+threads-messages-list') {
      return ok({ thread_id: 'omt_1', has_more: false, messages: listing })
    }
    throw new Error(`unexpected lark-cli call: ${args.slice(0, 3).join(' ')}`)
  })
  const patches = []
  const received = []
  const thread = {
    key: 'feishu:oc_chat:om_root',
    ref: { source: 'feishu', id: 'oc_chat:om_root' },
    createdAt: '2026-01-01T00:00:00.000Z',
    meta: { chatId: 'oc_chat', messageId: 'om_root', sourceTriggerId: 'src', threadId: 'omt_1' },
  }
  const sourceOptions = {
    run,
    bot: BOT,
    engine: { receive(trigger) { received.push(trigger); return 'stored' } },
    store: newStore('topics'),
    config: { chats: [], directMessages: false },
    threads: {
      subscribed() { return [thread] },
      latest() { return undefined },
      patch(key, meta) { patches.push({ key, meta }) },
    },
    now: () => '2026-01-01T00:03:00.000Z',
    log: () => {},
  }
  const feishu = createFeishuSource(sourceOptions)

  // 首轮：比订阅更早的根消息与旧回复都不算新需求，只投 reply1。
  await feishu.tick()
  assert.deepEqual(received.map((trigger) => trigger.meta.messageId), ['om_r1'])
  assert.deepEqual(received[0].threads, [{ source: 'feishu', id: 'oc_chat:om_root' }])
  assert.equal(readKv(sourceOptions.store, FEISHU_KEYS.initialized(thread.key)), true)

  // 第二轮：服务端把 reply1 与 reply2 一起给；reply1 已读，只投 reply2。
  listing = [reply2, reply1]
  await feishu.tick()
  assert.deepEqual(received.map((trigger) => trigger.meta.messageId), ['om_r1', 'om_r2'])

  // 第三轮：同一页再给一次，reply2 也已在名单里，不再投递。
  await feishu.tick()
  assert.equal(received.length, 2)
  assert.deepEqual(patches.filter((entry) => entry.meta.threadId !== undefined), [], '话题 id 没变就不该重复 patch')
  assert.ok(readKv(sourceOptions.store, FEISHU_KEYS.seen(thread.key)).includes('om_r2'))
})

test('图片：下载的字节进 AttachmentStore，key 必须出自本条消息', async () => {
  const root = mkdtempSync(join(home, 'attachments-'))
  const store = new AttachmentStore({ root })
  // 只给 PNG 魔数就够：类型由仓库按魔数判，不看扩展名。
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)])
  const { calls, run } = fakeRun(async (args, cwd) => {
    await writeFile(join(cwd, 'image.png'), png)
    return ok({ saved_path: join(cwd, 'image.png') })
  })
  const ref = { triggerId: 'src', chatId: 'oc_chat', messageId: 'om_1', at: '2026-01-01T00:00:00.000Z' }
  const result = await readFeishuImage(run, store, ref, '![Image](img_one) 看这张图', 'img_one', { workDirectory: home })
  assert.equal(result.source_message_id, 'om_1')
  assert.equal(result.image.kind, 'image')
  assert.equal(result.image.mime, 'image/png')
  assert.equal(result.image.bytes, png.length)
  assert.equal(result.image.name, 'img_one.png')
  assert.ok(existsSync(join(root, 'objects', result.image.sha.slice(0, 2), result.image.sha)), '字节按内容寻址落在仓库里')
  assert.deepEqual(calls[0].args.slice(0, 8), [
    'im', '+messages-resources-download', '--message-id', 'om_1', '--file-key', 'img_one', '--type', 'image',
  ])
  assert.ok(calls[0].cwd.startsWith(home), '下载落在临时目录里')
  assert.match(calls[0].cwd, /feishu-image-/)
  assert.equal(existsSync(calls[0].cwd), false, '读完就把临时目录删掉')

  // 正文里没有这个 key：一条命令都不该发出去。
  const before = calls.length
  await assert.rejects(readFeishuImage(run, store, ref, '正文里没有图片', 'img_other'), /source message/)
  assert.equal(calls.length, before)
})
