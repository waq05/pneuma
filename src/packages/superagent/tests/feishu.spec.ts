/**
 * @pneuma/superagent 的飞书 Trigger 用例：归一后的形状、谁算人、id 与时间。
 *
 * 这些判据错了都不报错，只是静默跑歪：`human` 判错会让机器人自己的回复反复派活，`addressed`
 * 判错会让「@ 了它」这条请求落进准入表变成不接单，id 算错等于同一条消息派两次活。
 *
 * 纯函数，不联网、不起子进程、不碰库。
 * 迁移说明：原文件跑的是构建产物、先手工 build；现在直接 import 源码。
 *
 * @module @pneuma/superagent/tests/feishu
 */
import { expect, test } from 'vitest'
import type { Trigger } from '../core/model.js'
import type { FeishuEvent } from '../adapters/feishu/trigger.js'

const { SOURCE, feishuTrigger, feishuTriggerId, feishuThreadId, feishuTime, withMentionNames, historyEvent } =
  await import('../adapters/feishu/trigger.js')

const BOT_ID = 'ou_bot'
const BOT_APP = 'cli_app'

/** 一条归一行状的消息；按需覆盖字段。 */
function event(overrides: Partial<FeishuEvent> = {}): FeishuEvent {
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

/** 归一出一个 Trigger；归一出 `undefined` 就让用例失败，而不是在下面读属性时抛 TypeError。 */
function mustTrigger(input: unknown): Trigger {
  const trigger = feishuTrigger(input, BOT_ID, BOT_APP)
  if (trigger === undefined) throw new Error('期望归一出一个 Trigger，实际是 undefined')
  return trigger
}

/** `historyEvent` 声明返回 `unknown`（它交给 `feishuTrigger` 再解析），这里按归一后的形状断言。 */
const normalized = (value: unknown): FeishuEvent => value as FeishuEvent

test('单聊：记 direct 变成显式的「对着它说」，渠道地址带 direct 标记', () => {
  const trigger = mustTrigger(event({ chat_type: 'p2p' }))
  expect(trigger.addressed).toBe('direct')
  expect(trigger.human).toBe(true)
  expect(trigger.source).toBe(SOURCE)
  expect(trigger.channel).toStrictEqual({
    source: SOURCE, thread: 'feishu:oc_chat', address: { chatId: 'oc_chat', messageId: 'om_1', direct: 'true' },
  })
  expect(trigger.meta.direct).toBe(true)
})

test('群聊：@ 到机器人才算 addressed；没 @ 就不带这个字段', () => {
  const mentioned = mustTrigger(event({ mentions: [{ id: BOT_ID, key: '@_user_1', name: 'SuperAgent' }] }))
  expect(mentioned.addressed).toBe('mention')
  expect(mentioned.meta.mentioned, '按 id 命中就算提到了').toBe(true)
  expect(mentioned.text, '正文里没有占位就不改').toBe('把 README 里的错别字改掉')

  const plain = mustTrigger(event())
  expect(plain.addressed, '没 @ 的群消息不带 addressed，准入交给准入表').toBeUndefined()
  expect(plain.meta.mentioned).toBe(false)
})

test('机器人自己发的消息返回 undefined：两种 id 都要认', () => {
  expect(feishuTrigger(event({ sender_id: BOT_ID }), BOT_ID, BOT_APP)).toBeUndefined()
  expect(feishuTrigger(event({ sender_id: BOT_APP }), BOT_ID, BOT_APP)).toBeUndefined()
  // 别的机器人发的仍然进来，但 human 是 false —— 由准入表决定收不收，不在这一层拦。
  const otherBot = mustTrigger(event({ sender_id: 'ou_other_bot', sender_type: 'bot' }))
  expect(otherBot.human).toBe(false)
})

test('id 与线程：id 只由 message_id 算，话题按根消息分组', () => {
  expect(feishuTriggerId('om_1')).toBe(feishuTriggerId('om_1'))
  expect(feishuTriggerId('om_1')).not.toBe(feishuTriggerId('om_2'))
  expect(feishuThreadId('oc_chat', undefined, 'om_1')).toBe('oc_chat:om_1')
  expect(feishuThreadId('oc_chat', 'om_root', 'om_1')).toBe('oc_chat:om_root')
  // 同一条消息走两条读法，id 与线程都必须一样，否则会被当成两条需求。
  const fromEvent = mustTrigger(event({ root_id: 'om_root' }))
  const fromHistory = mustTrigger(historyEvent({
    message_id: 'om_1', chat_id: 'oc_chat', create_time: '1767225600000', root_id: 'om_root',
    sender: { id: 'ou_alice', sender_type: 'user' }, body: { content: '{"text":"把 README 里的错别字改掉"}' },
  }, 'oc_chat', false))
  expect(fromEvent.id).toBe(fromHistory.id)
  expect(fromEvent.threads).toStrictEqual(fromHistory.threads)
})

test('时间：毫秒时间戳与「YYYY-MM-DD HH:mm」都认，读不懂就抛', () => {
  expect(feishuTime('1767225600000')).toBe(new Date(1767225600000).toISOString())
  expect(feishuTime('2026-09-11 12:00')).toBe(new Date('2026-09-11 12:00').toISOString())
  expect(() => feishuTime('not-a-time')).toThrow()
})

test('历史接口归一：正文从 JSON 里取 text，解析失败就当纯文本；@ 占位换成人名', () => {
  const json = normalized(historyEvent({
    message_id: 'om_2', chat_id: 'oc_chat', create_time: '1767225600000',
    sender: { id: 'ou_alice', sender_type: 'user' }, body: { content: '{"text":"改一下"}' },
  }, 'oc_chat', false))
  expect(json.content).toBe('改一下')
  expect(json.sender_type).toBe('user')
  expect(json.chat_type).toBe('group')

  const plain = normalized(historyEvent({
    message_id: 'om_3', chat_id: 'oc_chat', create_time: '1767225600000',
    sender: { id: 'ou_bot_x', sender_type: 'app' }, body: { content: '系统提示' },
  }, 'oc_chat', true))
  expect(plain.content, '不是 JSON 就当纯文本').toBe('系统提示')
  expect(plain.sender_type, '非 user 一律记 bot').toBe('bot')
  expect(plain.chat_type).toBe('p2p')

  expect(withMentionNames('@_user_1 改下', [{ key: '@_user_1', name: '小明' }])).toBe('@小明 改下')
})
