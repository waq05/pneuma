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
 * 但不碰真实的 `~/.dsc`（DSC_HOME 在 import 源码之前指到临时目录）。
 * 迁移说明：原文件 import `lib/` 构建产物；现在直接 import 源码，不再要求先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/feishu-channel
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { CliConsume, CliResult, CliRun } from '../adapters/feishu/cli.js'
import type { FeishuSource, FeishuThread } from '../adapters/feishu/loops.js'
import type { FeishuRef, HistoricalMessage } from '../adapters/feishu/trigger.js'
import type { OutboundMessage } from '../core/ports.js'
import type { Trigger } from '../core/model.js'
import type { DscStore } from '../adapters/store.js'

// 必须在 import 源码之前设好：core/path-policy 的 DSC_HOME 是模块加载那一刻定死的。
const home = mkdtempSync(join(tmpdir(), 'superagent-feishu-channel-'))
process.env['DSC_HOME'] = home

const { sendFeishu, feishuChatLink } = await import('../adapters/feishu/channel.js')
const { createFeishuSource, FEISHU_KEYS } = await import('../adapters/feishu/loops.js')
const { readFeishuImage } = await import('../adapters/feishu/image.js')
const { feishuTriggerId } = await import('../adapters/feishu/trigger.js')
const { AttachmentStore } = await import('../../../core/attachments.js')
const { openStore } = await import('../adapters/store.js')

const BOT = { id: 'ou_bot', appId: 'cli_app' }
const stores: DscStore[] = []

afterAll(() => {
  for (const store of stores) store.close()
  rmSync(home, { recursive: true, force: true })
})

/** 一条出站消息；默认回复 `om_1`。 */
function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: 'reply-1',
    kind: 'reply',
    text: 'README 的错别字改好了',
    channel: { source: 'feishu', thread: 'feishu:oc_chat', address: { chatId: 'oc_chat', messageId: 'om_1' } },
    ...overrides,
  }
}

/** 一次 CLI 调用的记录。 */
interface RunCall {
  args: string[]
  cwd: string | undefined
}

/** 假 CLI：记下每次调用的参数与工作目录，结果由 `handler` 给。 */
function fakeRun(handler: (args: readonly string[], cwd: string | undefined) => CliResult | Promise<CliResult>): {
  calls: RunCall[]
  run: CliRun
} {
  const calls: RunCall[] = []
  const run: CliRun = async (args, cwd) => {
    calls.push({ args: [...args], cwd })
    return handler(args, cwd)
  }
  return { calls, run }
}

/** 一次成功的信封。 */
const ok = (data: unknown): CliResult => ({ code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' })

/** 假的常驻消费器：`lines` 按 `[流, 行]` 给，`done` 决定退出结果。 */
function fakeConsume(
  lines: Array<['stdout' | 'stderr', string]>,
  done: () => Promise<CliResult> = () => new Promise<CliResult>(() => {}),
): { calls: string[][]; consume: CliConsume } {
  const calls: string[][] = []
  const consume: CliConsume = (args, handlers) => {
    calls.push([...args])
    queueMicrotask(() => {
      for (const [stream, line] of lines) handlers[stream](line)
    })
    return { stop: () => {}, done: done() }
  }
  return { calls, consume }
}

/** 一直等到条件成立：用来等后台循环的异步结果，避免写死 sleep 时长。 */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let index = 0; index < 400; index += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** 每个用例一个临时库：用例之间不共享游标，失败也不互相污染。 */
function newStore(label: string): DscStore {
  const store = openStore(join(home, `${label}.sqlite`))
  stores.push(store)
  return store
}

/** 读 `kv` 里一条（值都是 JSON）。 */
function readKv(store: DscStore, key: string): unknown {
  const row = store.handle.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined
  return row?.value === undefined ? undefined : (JSON.parse(row.value) as unknown)
}

/** 一条历史接口的消息；`at` 是 ISO，`create_time` 用毫秒串（飞书的形状）。 */
function historical(messageId: string, at: string): HistoricalMessage {
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
  expect(result).toBe('sent')
  expect(calls.map((call) => call.args)).toStrictEqual([
    [
      'im', '+messages-reply', '--message-id', 'om_1', '--markdown', 'README 的错别字改好了',
      '--reply-in-thread', '--idempotency-key', 'reply-1', '--as', 'bot', '--format', 'json',
    ],
  ])
  expect(calls[0].cwd, '回消息不需要工作目录').toBeUndefined()
  expect(feishuChatLink('lark', 'oc_a b')).toBe('https://applink.larksuite.com/client/chat/open?openChatId=oc_a%20b')
})

test('回消息：退出码非 0 时报出 stderr 与退出码，不伪造飞书错误码', async () => {
  const { run } = fakeRun(() => ({ code: 1, stdout: '', stderr: 'lark-cli: token expired' }))
  let thrown: unknown
  try {
    await sendFeishu(run, outbound())
  } catch (error) {
    thrown = error
  }
  const failure = thrown as { message?: string; exitCode?: number; code?: number }
  expect(failure.message ?? '').toMatch(/token expired/)
  expect(failure.exitCode).toBe(1)
  expect(failure.code, 'stderr 里没有飞书信封时不猜一个码').toBeUndefined()
})

test('长连接：一条 receive_v1 事件变成一条正确的 Trigger，并记下已连上', async () => {
  const event = {
    message_id: 'om_9', chat_id: 'oc_chat', chat_type: 'group', sender_id: 'ou_alice', sender_type: 'user',
    content: '@_user_1 把 README 里的错别字改掉', create_time: '1767225600000',
    mentions: [{ id: BOT.id, key: '@_user_1', name: 'SuperAgent' }],
    root_id: 'om_root', thread_id: 'omt_1', message_app_link: 'https://applink.feishu.cn/client/message/link',
  }
  const received: Trigger[] = []
  const consumer = fakeConsume([['stderr', '[event] ready'], ['stdout', JSON.stringify(event)]])
  const source = createFeishuSource({
    run: fakeRun(() => ok({ items: [], has_more: false })).run,
    consume: consumer.consume,
    bot: BOT,
    engine: { receive(trigger: Trigger) { received.push(trigger); return 'stored' } },
    store: newStore('live'),
    config: { chats: [], directMessages: false },
    now: () => '2026-01-01T00:00:00.000Z',
    log: () => {},
  })
  source.start()
  try {
    await until(() => received.length === 1, 'the event to reach the engine')
    expect(consumer.calls).toStrictEqual([['event', 'consume', 'im.message.receive_v1', '--as', 'bot']])
    const [trigger] = received
    expect(trigger.id, 'id 只由 message_id 算，重读同一条不会派两次活').toBe(feishuTriggerId('om_9'))
    expect(trigger.threads).toStrictEqual([{ source: 'feishu', id: 'oc_chat:om_root' }])
    expect(trigger.actor).toStrictEqual({ source: 'feishu', id: 'ou_alice' })
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('mention')
    expect(trigger.text).toBe('@SuperAgent 把 README 里的错别字改掉')
    expect(trigger.url).toBe(event.message_app_link)
    expect(trigger.meta).toStrictEqual({
      chatId: 'oc_chat', messageId: 'om_9', direct: false, mentioned: true, rootId: 'om_root', threadId: 'omt_1',
    })
    expect(source.status()).toStrictEqual({ connected: true, lastPollAt: '2026-01-01T00:00:00.000Z', lastError: null })
  } finally {
    source.stop()
  }
})

test('长连接：机器人自己发的消息（两种 id）都不进 engine.receive', async () => {
  const mine = (senderId: string): string => JSON.stringify({
    message_id: `om_${senderId}`, chat_id: 'oc_chat', chat_type: 'p2p', sender_id: senderId, sender_type: 'bot',
    content: '我自己刚回的', create_time: '1767225600000', mentions: [],
  })
  const received: Trigger[] = []
  const source = createFeishuSource({
    run: fakeRun(() => ok({})).run,
    consume: fakeConsume([
      ['stderr', '[event] ready'],
      ['stdout', mine(BOT.id)],
      ['stdout', mine(BOT.appId)],
    ]).consume,
    bot: BOT,
    engine: { receive(trigger: Trigger) { received.push(trigger); return 'stored' } },
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
    expect(received).toStrictEqual([])
  } finally {
    source.stop()
  }
})

test('补漏轮询：历史归一成 Trigger、游标写进 kv、重叠窗口不重复投递', async () => {
  const messages = [historical('om_a', '2026-01-01T00:00:30.000Z'), historical('om_b', '2026-01-01T00:00:58.000Z')]
  const { calls, run } = fakeRun((args) => {
    // 只走历史接口；按接口的 start_time / end_time 过滤，模拟服务端窗口。
    const params = JSON.parse(args[args.indexOf('--params') + 1]) as { start_time: string; end_time: string }
    const from = Number(params.start_time) * 1000
    const to = Number(params.end_time) * 1000
    const items = messages.filter((message) => {
      const at = Number(message.create_time)
      return at >= from && at < to
    })
    return ok({ items, has_more: false })
  })
  const store = newStore('backfill')
  const received: Trigger[] = []
  let clock = '2026-01-01T00:00:10.000Z'
  const source = createFeishuSource({
    run,
    bot: BOT,
    engine: { receive(trigger: Trigger) { received.push(trigger); return 'stored' } },
    store,
    config: { chats: [{ chatId: 'oc_chat' }], directMessages: false },
    now: () => clock,
    log: () => {},
  })

  // 第一拍只记起点：装好就把整段历史倒进来是错的。
  await source.tick()
  expect(received).toStrictEqual([])
  expect(readKv(store, FEISHU_KEYS.history('oc_chat'))).toBe('2026-01-01T00:00:10.000Z')

  clock = '2026-01-01T00:01:00.000Z'
  await source.tick()
  expect(received.map((trigger) => trigger.id)).toStrictEqual([feishuTriggerId('om_a'), feishuTriggerId('om_b')])
  expect(received[0].text).toBe('改 om_a')
  expect(received[0].human).toBe(true)
  expect(received[0].threads).toStrictEqual([{ source: 'feishu', id: 'oc_chat:om_a' }])
  expect(received[0].at).toBe('2026-01-01T00:00:30.000Z')
  // 游标回退 5 秒，迟到的远端事件才不漏。
  expect(readKv(store, FEISHU_KEYS.history('oc_chat'))).toBe('2026-01-01T00:00:55.000Z')
  expect(calls.at(-1)!.args.slice(0, 3)).toStrictEqual(['api', 'GET', '/open-apis/im/v1/messages'])

  // 第三拍从 00:00:55 起读，服务端把 00:00:58 那条再给一次：已在名单里，不再投递。
  clock = '2026-01-01T00:01:30.000Z'
  await source.tick()
  expect(received.length, '重叠窗口里的消息不该再进一次 engine.receive').toBe(2)
  expect(readKv(store, FEISHU_KEYS.history('oc_chat'))).toBe('2026-01-01T00:01:25.000Z')
})

test('不可回复与可重试：撤回 / 删除回 gone，限流与连不上照抛', async () => {
  const reply = (stderr: string, code = 1, stdout = ''): CliRun => fakeRun(() => ({ code, stdout, stderr })).run
  // 撤回：230011 直接判死。
  expect(await sendFeishu(reply(JSON.stringify({ ok: false, error: { code: 230011, message: 'message withdrawn' } })), outbound())).toBe('gone')
  // 删除：2300xx 段带 not found 也判死。
  expect(await sendFeishu(reply('', 0, JSON.stringify({ ok: false, error: { code: 230099, message: 'message not found' } })), outbound())).toBe('gone')
  // 不是「回不了」：连不上，重试才有用；没有飞书码，不该被 gone 吞掉。
  await expect(sendFeishu(reply('connection reset by peer'), outbound())).rejects.toThrow(/connection reset/)
  // 限流同理：带码但不在 gone 的判据里，照抛，让队列退避重试。
  let thrown: unknown
  try {
    await sendFeishu(reply(JSON.stringify({ ok: false, error: { code: 230020, message: 'rate limited' } })), outbound())
  } catch (error) {
    thrown = error
  }
  expect((thrown as { code?: number }).code).toBe(230020)
})

test('status：连上后 connected 为真且 lastError 清空；连不上与补收失败各留原因', async () => {
  const base = {
    run: fakeRun(() => ok({ items: [], has_more: false })).run,
    bot: BOT,
    engine: { receive() { return 'stored' } },
    config: { chats: [], directMessages: false },
    now: () => '2026-01-01T00:00:00.000Z',
    log: () => {},
  }
  const connected = createFeishuSource({
    ...base,
    store: newStore('status-ok'),
    consume: fakeConsume([['stderr', '[event] ready']]).consume,
  })
  connected.start()
  try {
    await until(() => connected.status().connected, 'the consumer to become ready')
    expect(connected.status()).toStrictEqual({ connected: true, lastPollAt: '2026-01-01T00:00:00.000Z', lastError: null })
  } finally {
    connected.stop()
  }
  expect(connected.status().connected, '停掉之后不该还显示连着').toBe(false)

  // 长连接报错后退出：connected 为假，原因留在 lastError。
  const failing: FeishuSource = createFeishuSource({
    ...base,
    store: newStore('status-consume'),
    consume: fakeConsume(
      [['stderr', '[event] error: connection reset']],
      () => new Promise<CliResult>((resolve) => setTimeout(() => resolve({ code: 1, stdout: '', stderr: 'connection reset' }), 5)),
    ).consume,
  })
  failing.start()
  try {
    await until(() => failing.status().lastError !== null, 'the consumer failure to be recorded')
    expect(failing.status().connected).toBe(false)
    expect(failing.status().lastError ?? '').toMatch(/connection reset/)
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
  expect(broken.status().lastError ?? '').toMatch(/history exploded/)
  expect(broken.status().connected, '没有长连接时 connected 恒为假').toBe(false)
})

test('话题轮询：首轮只建立已读基线，之后只投递新回复', async () => {
  const source = { message_id: 'om_root', chat_id: 'oc_chat', thread_id: 'omt_1' }
  const page = (messageId: string, at: string): Record<string, unknown> => ({
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
  const patches: Array<{ key: string; meta: Record<string, unknown> }> = []
  const received: Trigger[] = []
  const thread: FeishuThread = {
    key: 'feishu:oc_chat:om_root',
    ref: { source: 'feishu', id: 'oc_chat:om_root' },
    createdAt: '2026-01-01T00:00:00.000Z',
    meta: { chatId: 'oc_chat', messageId: 'om_root', sourceTriggerId: 'src', threadId: 'omt_1' },
  }
  const sourceOptions = {
    run,
    bot: BOT,
    engine: { receive(trigger: Trigger) { received.push(trigger); return 'stored' } },
    store: newStore('topics'),
    config: { chats: [], directMessages: false },
    threads: {
      subscribed() { return [thread] },
      latest() { return undefined },
      patch(key: string, meta: Record<string, unknown>) { patches.push({ key, meta }) },
    },
    now: () => '2026-01-01T00:03:00.000Z',
    log: () => {},
  }
  const feishu = createFeishuSource(sourceOptions)

  // 首轮：比订阅更早的根消息与旧回复都不算新需求，只投 reply1。
  await feishu.tick()
  expect(received.map((trigger) => trigger.meta.messageId)).toStrictEqual(['om_r1'])
  expect(received[0].threads).toStrictEqual([{ source: 'feishu', id: 'oc_chat:om_root' }])
  expect(readKv(sourceOptions.store, FEISHU_KEYS.initialized(thread.key))).toBe(true)

  // 第二轮：服务端把 reply1 与 reply2 一起给；reply1 已读，只投 reply2。
  listing = [reply2, reply1]
  await feishu.tick()
  expect(received.map((trigger) => trigger.meta.messageId)).toStrictEqual(['om_r1', 'om_r2'])

  // 第三轮：同一页再给一次，reply2 也已在名单里，不再投递。
  await feishu.tick()
  expect(received.length).toBe(2)
  expect(patches.filter((entry) => entry.meta.threadId !== undefined), '话题 id 没变就不该重复 patch').toStrictEqual([])
  expect(readKv(sourceOptions.store, FEISHU_KEYS.seen(thread.key)) as string[]).toContain('om_r2')
})

test('图片：下载的字节进 AttachmentStore，key 必须出自本条消息', async () => {
  const root = mkdtempSync(join(home, 'attachments-'))
  const store = new AttachmentStore({ root })
  // 只给 PNG 魔数就够：类型由仓库按魔数判，不看扩展名。
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)])
  const { calls, run } = fakeRun(async (args, cwd) => {
    const dir = cwd ?? home
    await writeFile(join(dir, 'image.png'), png)
    return ok({ saved_path: join(dir, 'image.png') })
  })
  const ref: FeishuRef = { triggerId: 'src', chatId: 'oc_chat', messageId: 'om_1', at: '2026-01-01T00:00:00.000Z' }
  const result = await readFeishuImage(run, store, ref, '![Image](img_one) 看这张图', 'img_one', { workDirectory: home })
  expect(result.source_message_id).toBe('om_1')
  expect(result.image.kind).toBe('image')
  expect(result.image.mime).toBe('image/png')
  expect(result.image.bytes).toBe(png.length)
  expect(result.image.name).toBe('img_one.png')
  expect(existsSync(join(root, 'objects', result.image.sha.slice(0, 2), result.image.sha)), '字节按内容寻址落在仓库里').toBe(true)
  expect(calls[0].args.slice(0, 8)).toStrictEqual([
    'im', '+messages-resources-download', '--message-id', 'om_1', '--file-key', 'img_one', '--type', 'image',
  ])
  const workdir = calls[0].cwd ?? ''
  expect(workdir.startsWith(home), '下载落在临时目录里').toBe(true)
  expect(workdir).toMatch(/feishu-image-/)
  expect(existsSync(workdir), '读完就把临时目录删掉').toBe(false)

  // 正文里没有这个 key：一条命令都不该发出去。
  const before = calls.length
  await expect(readFeishuImage(run, store, ref, '正文里没有图片', 'img_other')).rejects.toThrow(/source message/)
  expect(calls.length).toBe(before)
})
