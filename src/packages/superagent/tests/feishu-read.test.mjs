/**
 * @pneuma/superagent 飞书上下文读取器的包级测试：来源元数据 / 话题分页 / 单条消息 / 聊天邻域 / 来源链接。
 *
 * 上游 `tests/feishu-read.spec.ts` 的八条用例逐条转写。被钉住的都是「模型看到什么、CLI 收到什么」：
 * 来源消息必须先校验 chat 归属、话题分页的 cursor 要原样传回 CLI、读不出来的消息单独跳过并计数、
 * 翻页不前进要报错；`feishuRead` 再把原始记录转成 `{ id, from, at, text, reply_to?, url }`。
 *
 * 假的只有 `Commands`（`fixtures-commands.mjs` 的对象字面量）：`lark` 按调用次序返回
 * 预置的 JSON，断言里直接看假件记下的参数，不跑 lark-cli。被测模块跑的是 `lib/` 构建产物，
 * 跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/feishu-read
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fakeCommands, queued } from './fixtures-commands.mjs'

const { feishuRead, readFeishu, readFeishuLink } = await import('../../../../lib/packages/superagent/sources/feishu-read.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

/** 被接受的来源 trigger：来源消息 `om_source` 在 `oc_chat`。 */
const event = { triggerId: 'source', chatId: 'oc_chat', messageId: 'om_source' }
/** `messages/mget` 返回的来源元数据：根消息、父消息、话题 ID 都齐。 */
const source = { message_id: 'om_source', chat_id: 'oc_chat', parent_id: 'om_parent', root_id: 'om_root', thread_id: 'omt_thread' }
/** 话题里的一条消息；`content` 故意带一段合并转发文本，用来验证自动展开不会混进来。 */
const message = {
  message_id: 'om_root', chat_id: 'oc_chat', msg_type: 'merge_forward',
  content: '<forwarded_messages>Earlier discussion ![Image](img_one)</forwarded_messages>',
  sender: { id: 'ou_user', name: 'User', sender_type: 'user' }, create_time: '2026-09-11 12:00',
}

test('解析旧版来源元数据并读合并转发，不夹带自动展开的线程回复', async () => {
  const commands = fakeCommands({
    lark: queued(
      { items: [source] },
      { messages: [{ ...message, thread_replies: [{ content: 'Automatic expansion omitted' }] }] },
    ),
  })
  const result = await readFeishu(commands, event, 'feishu/source/root', 20)
  assert.partialDeepStrictEqual(result, { status: 'available', message: { content: message.content } })
  assert.equal('limitations' in result, false, '读接口自己不说限制，限制只在 skill 里说一次')
  assert.equal(JSON.stringify(result).includes('Automatic expansion omitted'), false,
    '自动展开的线程回复不能出现在结果里')
  assert.deepEqual(commands.calls.lark[1].args, ['im', '+messages-mget', '--message-ids', 'om_root', '--no-reactions'],
    '要按 root_id 读这一条，并显式关掉 reactions')
  passed += 1
})

test('用不透明 cursor 翻来源话题页，保留作者与编辑时间', async () => {
  const commands = fakeCommands({
    lark: queued(
      { items: [source] },
      { thread_id: 'omt_thread', has_more: true, page_token: 'a/b+next=',
        messages: [{ ...message, message_id: 'om_reply', thread_id: 'omt_thread', updated: true, update_time: '2026-09-11 12:01' }] },
      { items: [source] },
      { thread_id: 'omt_thread', has_more: false, messages: [] },
    ),
  })
  const first = await readFeishu(commands, event, 'feishu/source/thread', 2)
  assert.partialDeepStrictEqual(first, {
    next_resource: 'feishu/source/thread/a%2Fb%2Bnext%3D',
    messages: [{ sender: message.sender, updated: true }],
  })
  await readFeishu(commands, event, 'feishu/source/thread/a%2Fb%2Bnext%3D', 2)
  assert.ok(commands.calls.lark.at(-1).args.includes('a/b+next='),
    '下一页要带着解码后的 cursor 原样传给 CLI')
  passed += 1
})

test('话题里读不出来的那条单独跳过并计数，其余照读', async () => {
  const commands = fakeCommands({
    lark: queued(
      { items: [source] },
      { thread_id: 'omt_thread', has_more: false,
        messages: [
          { ...message, message_id: 'om_reply', thread_id: 'omt_thread' },
          { ...message, message_id: 'om_odd', sender: { sender_type: 'app' } },
        ] },
    ),
  })
  const page = await readFeishu(commands, event, 'feishu/source/thread', 20)
  assert.partialDeepStrictEqual(page, { skipped: 1, messages: [{ message_id: 'om_reply' }] })
  passed += 1
})

test('拒绝不属于本来源的路径、缺失的来源、跨会话结果与不推进的分页', async () => {
  const commands = fakeCommands({
    lark: queued(
      { items: [] },
      { items: [{ ...source, chat_id: 'oc_elsewhere' }] },
      { items: [source] },
      { thread_id: 'omt_thread', has_more: true, messages: [] },
    ),
  })
  await assert.rejects(readFeishu(commands, event, 'feishu/other/thread', 20), /source trigger/)
  await assert.rejects(readFeishu(commands, event, 'feishu/source/root/cursor', 20), /Use feishu/)
  assert.equal(commands.calls.lark.length, 0, '这两类校验失败要在发请求之前抛')
  await assert.rejects(readFeishu(commands, event, 'feishu/source/message', 20), /unavailable/)
  await assert.rejects(readFeishu(commands, event, 'feishu/source/root', 20), /chat does not match/)
  await assert.rejects(readFeishu(commands, event, 'feishu/source/thread', 20), /did not advance/)
  passed += 1
})

test('明确报告父消息 / 话题缺失与内容已删除', async () => {
  const onlySource = { message_id: 'om_source', chat_id: 'oc_chat' }
  const commands = fakeCommands({
    lark: queued(
      { items: [onlySource] },
      { items: [onlySource] },
      { items: [source] },
      { messages: [{ ...message, deleted: true }] },
    ),
  })
  assert.partialDeepStrictEqual(await readFeishu(commands, event, 'feishu/source/thread', 20),
    { status: 'no_thread', next_resource: null })
  assert.partialDeepStrictEqual(await readFeishu(commands, event, 'feishu/source/parent', 20),
    { status: 'no_parent', message: null })
  assert.partialDeepStrictEqual(await readFeishu(commands, event, 'feishu/source/root', 20),
    { status: 'deleted' })
  passed += 1
})

test('只读来源消息的链接，缺失、已删除或跨会话都拒绝', async () => {
  const linked = { message_id: 'om_source', chat_id: 'oc_chat',
    message_app_link: 'https://applink.feishu.cn/client/message/link/open?token=source' }
  const other = { ...linked, message_id: 'om_other', message_app_link: 'https://example.com/other' }
  const commands = fakeCommands({
    lark: queued(
      { messages: [other, linked] },
      ...[[{ ...linked, deleted: true }], [{ ...linked, chat_id: 'oc_elsewhere' }],
        [{ ...linked, message_app_link: undefined }], [{ ...linked, message_id: 'om_other' }]]
        .map((rows) => ({ messages: rows })),
    ),
  })
  assert.equal(await readFeishuLink(commands, event), linked.message_app_link,
    '多条里只认来源消息 ID 那一条，别的链接不采用')
  assert.deepEqual(commands.calls.lark[0].args, ['im', '+messages-mget', '--message-ids', 'om_source', '--no-reactions'])
  for (const why of ['已删除', '跨会话', '没有链接', 'ID 对不上']) {
    await assert.rejects(readFeishuLink(commands, event), /unavailable/, why)
  }
  passed += 1
})

test('把话题页读成模型能读的消息：id、作者、ISO 时间、正文与被回复的消息', async () => {
  const commands = fakeCommands({
    lark: queued(
      { items: [source] },
      { thread_id: 'omt_thread', has_more: false,
        messages: [
          { ...message, message_id: 'om_reply', thread_id: 'omt_thread', parent_id: 'om_root',
            message_app_link: 'https://applink.feishu.cn/x' },
          { ...message, message_id: 'om_bot', sender: { id: 'cli_bot', name: 'Bot', sender_type: 'app' } },
        ] },
    ),
  })
  assert.deepEqual(await feishuRead(commands, event, 'feishu/source/thread', 20), {
    status: 'available', thread_id: 'omt_thread', next_resource: null,
    messages: [
      { id: 'om_reply', from: 'User', at: new Date('2026-09-11 12:00').toISOString(), text: message.content,
        reply_to: 'om_root', url: 'https://applink.feishu.cn/x' },
      { id: 'om_bot', from: 'Bot', at: new Date('2026-09-11 12:00').toISOString(), text: message.content, bot: true },
    ],
  })
  passed += 1
})

test('按时间读来源消息附近的聊天：前五条、本条、后五条，再往前翻页', async () => {
  const at = Date.parse('2026-09-11T12:00:00Z')
  const item = (n) => ({
    message_id: `om_${n}`, chat_id: 'oc_chat', create_time: String(at + n * 1000),
    sender: { id: 'ou_user', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `message ${n}` }) },
  })
  const commands = fakeCommands({
    lark: queued(
      { items: [source] },
      { items: [0, -1, -2, -3, -4, -5].map(item), has_more: true, page_token: 'older' },
      { items: [0, 1, 2].map(item), has_more: false },
      { items: [source] },
      { items: [-6, -7].map(item), has_more: false },
    ),
  })
  const ref = { ...event, at: new Date(at).toISOString() }
  const around = await feishuRead(commands, ref, 'feishu/source/around', 20)
  assert.partialDeepStrictEqual(around, { status: 'available', next_resource: 'feishu/source/around/older' })
  assert.ok('messages' in around, 'around 读法要回消息列表')
  assert.deepEqual(around.messages.map((row) => [row.id, row.text]),
    [-5, -4, -3, -2, -1, 0, 1, 2].map((n) => [`om_${n}`, `message ${n}`]),
    '按时间升序拼成一条时间线，来源消息本身只出现一次')
  const params = (call) => JSON.parse(commands.calls.lark[call].args.at(-1))
  assert.partialDeepStrictEqual(params(1),
    { container_id: 'oc_chat', sort_type: 'ByCreateTimeDesc', end_time: String(at / 1000), page_size: 6 },
    '首次读更早的消息：以来源时间为终点、倒序、最多六条（含来源消息）')
  assert.partialDeepStrictEqual(params(2),
    { sort_type: 'ByCreateTimeAsc', start_time: String(at / 1000), page_size: 6 },
    '首次读更晚的消息：以来源时间为起点、正序、最多六条')
  const earlier = await feishuRead(commands, ref, 'feishu/source/around/older', 20)
  assert.ok('messages' in earlier, '翻页读法也要回消息列表')
  assert.deepEqual(earlier.messages.map((row) => row.id), ['om_-7', 'om_-6'], '更早一页同样按时间升序')
  assert.partialDeepStrictEqual(params(4), { page_token: 'older', page_size: 10 },
    '带 cursor 的翻页只读更早的十条，不再读更晚那侧')
  passed += 1
})
