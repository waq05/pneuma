/**
 * @pneuma/superagent 的飞书 Trigger 用例：归一后的形状、谁算人、id 与时间。
 *
 * 这些判据错了都不报错，只是静默跑歪：`human` 判错会让机器人自己的回复反复派活，`addressed`
 * 判错会让「@ 了它」这条请求落进准入表变成不接单，id 算错等于同一条消息派两次活。
 *
 * 纯函数，不联网、不起子进程、不碰库。
 *
 * @module @pneuma/superagent/tests/feishu
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { SOURCE, feishuTrigger, feishuTriggerId, feishuThreadId, feishuTime, withMentionNames, historyEvent } =
  await import('../../../../lib/packages/superagent/adapters/feishu/trigger.js')

const BOT_ID = 'ou_bot'
const BOT_APP = 'cli_app'

/** 一条归一行状的消息；按需覆盖字段。 */
function event(overrides = {}) {
  return {
    message_id: 'om_1',
    chat_id: 'oc_chat',
    chat_type: 'group',
    sender_id: 'ou_alice',
    sender_type: 'user',
    content: '把 README 里的错别字改掉',
    create_time: '1767225600000',
    mentions: [],
    ...overrides,
  }
}

test('单聊：记 direct 变成显式的「对着它说」，渠道地址带 direct 标记', () => {
  const trigger = feishuTrigger(event({ chat_type: 'p2p' }), BOT_ID, BOT_APP)
  assert.equal(trigger.addressed, 'direct')
  assert.equal(trigger.human, true)
  assert.equal(trigger.source, SOURCE)
  assert.deepEqual(trigger.channel, {
    source: SOURCE, thread: 'feishu:oc_chat', address: { chatId: 'oc_chat', messageId: 'om_1', direct: 'true' },
  })
  assert.equal(trigger.meta.direct, true)
})

test('群聊：@ 到机器人才算 addressed；没 @ 就不带这个字段', () => {
  const mentioned = feishuTrigger(event({ mentions: [{ id: BOT_ID, key: '@_user_1', name: 'SuperAgent' }] }), BOT_ID, BOT_APP)
  assert.equal(mentioned.addressed, 'mention')
  assert.equal(mentioned.meta.mentioned, true, '按 id 命中就算提到了')
  assert.equal(mentioned.text, '把 README 里的错别字改掉', '正文里没有占位就不改')

  const plain = feishuTrigger(event(), BOT_ID, BOT_APP)
  assert.equal(plain.addressed, undefined, '没 @ 的群消息不带 addressed，准入交给准入表')
  assert.equal(plain.meta.mentioned, false)
})

test('机器人自己发的消息返回 undefined：两种 id 都要认', () => {
  assert.equal(feishuTrigger(event({ sender_id: BOT_ID }), BOT_ID, BOT_APP), undefined)
  assert.equal(feishuTrigger(event({ sender_id: BOT_APP }), BOT_ID, BOT_APP), undefined)
  // 别的机器人发的仍然进来，但 human 是 false —— 由准入表决定收不收，不在这一层拦。
  const otherBot = feishuTrigger(event({ sender_id: 'ou_other_bot', sender_type: 'bot' }), BOT_ID, BOT_APP)
  assert.equal(otherBot.human, false)
})

test('id 与线程：id 只由 message_id 算，话题按根消息分组', () => {
  assert.equal(feishuTriggerId('om_1'), feishuTriggerId('om_1'))
  assert.notEqual(feishuTriggerId('om_1'), feishuTriggerId('om_2'))
  assert.equal(feishuThreadId('oc_chat', undefined, 'om_1'), 'oc_chat:om_1')
  assert.equal(feishuThreadId('oc_chat', 'om_root', 'om_1'), 'oc_chat:om_root')
  // 同一条消息走两条读法，id 与线程都必须一样，否则会被当成两条需求。
  const fromEvent = feishuTrigger(event({ root_id: 'om_root' }), BOT_ID, BOT_APP)
  const fromHistory = feishuTrigger(historyEvent({
    message_id: 'om_1', chat_id: 'oc_chat', create_time: '1767225600000', root_id: 'om_root',
    sender: { id: 'ou_alice', sender_type: 'user' }, body: { content: '{"text":"把 README 里的错别字改掉"}' },
  }, 'oc_chat', false), BOT_ID, BOT_APP)
  assert.equal(fromEvent.id, fromHistory.id)
  assert.deepEqual(fromEvent.threads, fromHistory.threads)
})

test('时间：毫秒时间戳与「YYYY-MM-DD HH:mm」都认，读不懂就抛', () => {
  assert.equal(feishuTime('1767225600000'), new Date(1767225600000).toISOString())
  assert.equal(feishuTime('2026-09-11 12:00'), new Date('2026-09-11 12:00').toISOString())
  assert.throws(() => feishuTime('not-a-time'))
})

test('历史接口归一：正文从 JSON 里取 text，解析失败就当纯文本；@ 占位换成人名', () => {
  const json = historyEvent({
    message_id: 'om_2', chat_id: 'oc_chat', create_time: '1767225600000',
    sender: { id: 'ou_alice', sender_type: 'user' }, body: { content: '{"text":"改一下"}' },
  }, 'oc_chat', false)
  assert.equal(json.content, '改一下')
  assert.equal(json.sender_type, 'user')
  assert.equal(json.chat_type, 'group')

  const plain = historyEvent({
    message_id: 'om_3', chat_id: 'oc_chat', create_time: '1767225600000',
    sender: { id: 'ou_bot_x', sender_type: 'app' }, body: { content: '系统提示' },
  }, 'oc_chat', true)
  assert.equal(plain.content, '系统提示', '不是 JSON 就当纯文本')
  assert.equal(plain.sender_type, 'bot', '非 user 一律记 bot')
  assert.equal(plain.chat_type, 'p2p')

  assert.equal(withMentionNames('@_user_1 改下', [{ key: '@_user_1', name: '小明' }]), '@小明 改下')
})
