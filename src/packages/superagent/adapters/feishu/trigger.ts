/**
 * 飞书消息 → 领域 `Trigger` 的纯函数层。
 *
 * 这一层不碰网络、不碰子进程、不碰库：上游把「长连接收到的事件」「历史接口拉到的消息」
 * 「话题页读到的回复」三条路径都归一成同一个事件形状，再走同一个 `feishuTrigger`。三条路
 * 都归一，是因为同一条消息可能被两条路各读到一次——归一之后 `Trigger.id` 只由 `message_id`
 * 算出来（`feishuTriggerId`），重复读到也只会有一次入库。
 *
 * 从上游 `sources/feishu-trigger.ts`（89 行）逐函数搬过来，只改 import 扩展名。下面的判据
 * 一个字符都没动，因为改错了不报错：`human` 判错会让机器人自己的回复反复派活，`addressed`
 * 判错会让「@ 了它」这条请求落进准入表变成不接单。
 *
 * @module dsc/packages/superagent/adapters/feishu/trigger
 */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../../core/index.js'

/** 来源名；同时是 `Trigger.source`、`policy.sources` 的键与 `sources` 实例表的键。 */
export const SOURCE = 'feishu'

/**
 * 一条飞书消息的回复地址。
 *
 * `direct` 显式记进去，因为群聊与单聊的 chat_id 都以 `oc_` 开头，光看 id 分不出该不该
 * 当私聊回。
 */
export const feishuChannel = (chatId: string, messageId: string, direct = false): ChannelRef =>
  ({ source: SOURCE, thread: `feishu:${chatId}`, address: { chatId, messageId, ...(direct ? { direct: 'true' } : {}) } })

/** 一条消息的来源引用：回复它、给它发确认时要用。 */
export interface FeishuRef { triggerId: string; chatId: string; messageId: string; at: string }

/**
 * 长连接事件消费器打印出来的形状。
 *
 * 历史接口与话题页把自己读到的消息归一成这个形状（`historyEvent` / `topicEvent`），所以下游
 * 只有一条解析路径。
 */
const EventSchema = z.object({
  message_id: z.string(),
  chat_id: z.string(),
  chat_type: z.enum(['p2p', 'group']),
  sender_id: z.string(),
  sender_type: z.enum(['user', 'bot']),
  content: z.string(),
  create_time: z.string(),
  mentions: z.array(z.object({ id: z.string(), key: z.string().optional(), name: z.string().optional() })).default([]),
  root_id: z.string().optional(),
  parent_id: z.string().optional(),
  thread_id: z.string().optional(),
  message_app_link: z.url().optional(),
})
/** 归一后的一条飞书事件。 */
export type FeishuEvent = z.infer<typeof EventSchema>

/** 一条消息所在的话题：有 `root_id` 就跟根消息一组，否则自己一组。 */
export const feishuThreadId = (chatId: string, rootId: string | undefined, messageId: string): string => `${chatId}:${rootId ?? messageId}`

/**
 * 一条消息的 Trigger id：只由 `message_id` 算。
 *
 * 三条读法（长连接 / 历史接口 / 话题页）对同一条消息必须算出同一个 id——核心的 `Intake`
 * 拿 id 去重（`core/intake.ts:23`），算不一样就等于同一条消息派了两次活。
 */
export const feishuTriggerId = (messageId: string): string => key('feishu', messageId)

/** 把正文里的 `@_user_1` 之类的占位换成 `@真名`，人读起来才知道在说谁。 */
export const withMentionNames = (text: string, mentions: { key?: string | undefined; name?: string | undefined }[]): string =>
  mentions.reduce((result, mention) => mention.key && mention.name ? result.replaceAll(mention.key, `@${mention.name}`) : result, text)

/**
 * 飞书的时间字符串 → ISO。
 *
 * 长连接事件与历史接口给的是毫秒时间戳字符串，话题页给的是 `2026-09-11 12:00` 这种本地时间。
 * 两种都要认：只认一种，另一条读法整条失效，而且失效时只是「时间不对」，不会有异常提示。
 */
export function feishuTime(value: string): string {
  const time = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(`Unreadable Feishu message time: ${value}`)
  return new Date(time).toISOString()
}

/**
 * 一条事件变成一个 `Trigger`；机器人自己发的消息返回 `undefined`。
 *
 * 跳过自己发的：机器人回完话，那条回复也会走事件流回来，不跳过就会把它自己的回复当成新需求
 * 再派一遍，越滚越多。
 */
export function feishuTrigger(input: unknown, botId: string, botAppId: string): Trigger | undefined {
  const event = EventSchema.parse(input)
  if (event.sender_id === botId || event.sender_id === botAppId) return
  const direct = event.chat_type === 'p2p'
  const mentioned = event.mentions.some(mention => mention.id === botId || mention.id === botAppId)
  const thread = feishuThreadId(event.chat_id, event.root_id, event.message_id)
  return {
    id: feishuTriggerId(event.message_id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: event.sender_id },
    human: event.sender_type === 'user',
    ...(direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {}),
    at: feishuTime(event.create_time),
    text: withMentionNames(event.content, event.mentions),
    channel: feishuChannel(event.chat_id, event.message_id, direct),
    ...(event.message_app_link ? { url: event.message_app_link } : {}),
    meta: {
      chatId: event.chat_id, messageId: event.message_id, direct, mentioned,
      ...(event.root_id ? { rootId: event.root_id } : {}),
      ...(event.parent_id ? { parentId: event.parent_id } : {}),
      ...(event.thread_id ? { threadId: event.thread_id } : {}),
    },
  }
}

/** 这条消息在回谁（`parent_id`）；不是飞书来源就是 `undefined`。 */
export const feishuParent = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.parentId === 'string' ? feishuTriggerId(trigger.meta.parentId) : undefined

/** 从 `Trigger.meta` 还原出回复地址；缺字段就返回 `undefined`，不猜。 */
export function feishuRef(trigger: Trigger): FeishuRef | undefined {
  const meta = trigger.meta as { chatId?: string; messageId?: string }
  if (trigger.source !== SOURCE || !meta.chatId || !meta.messageId) return undefined
  return { triggerId: trigger.id, chatId: meta.chatId, messageId: meta.messageId, at: trigger.at }
}

/** 历史接口的一条消息；被删掉的消息可能没有 `body`/`content`。 */
export const HistoricalMessageSchema = z.looseObject({
  message_id: z.string(), chat_id: z.string(), create_time: z.string(),
  root_id: z.string().optional(), parent_id: z.string().optional(), thread_id: z.string().optional(),
  deleted: z.boolean().optional(), message_app_link: z.string().optional(),
  sender: z.looseObject({ id: z.string().default(''), sender_type: z.string() }),
  body: z.looseObject({ content: z.string() }).optional(),
  mentions: z.array(z.looseObject({ id: z.string(), key: z.string().optional(), name: z.string().optional() })).optional(),
})
/** 历史接口的一条消息。 */
export type HistoricalMessage = z.infer<typeof HistoricalMessageSchema>

/** 历史接口的一页：逐条解析，读不懂的那条单独跳过，不连累整页。 */
export const HistoryPageSchema = z.looseObject({
  items: z.array(z.unknown()).default([]), has_more: z.boolean().default(false), page_token: z.string().optional(),
})

/** 历史接口的正文：`body.content` 是 JSON 字符串，解析失败时它也可能就是纯文本（系统消息）。 */
export function historyText(message: HistoricalMessage): string {
  let content: unknown
  try {
    content = JSON.parse(message.body?.content ?? '')
  } catch {
    content = message.body?.content ?? ''
  }
  const plain = content && typeof content === 'object' && 'text' in content && typeof content.text === 'string' ? content.text : undefined
  return typeof content === 'string' ? content : plain ?? JSON.stringify(content)
}

/** 把历史接口的一条消息归一成事件形状，交给 `feishuTrigger`。 */
export function historyEvent(message: HistoricalMessage, chatId: string, direct: boolean): unknown {
  return {
    message_id: message.message_id, chat_id: chatId, chat_type: direct ? 'p2p' : 'group', create_time: message.create_time,
    sender_id: message.sender.id, sender_type: message.sender.sender_type === 'user' ? 'user' : 'bot', content: historyText(message),
    mentions: message.mentions ?? [], root_id: message.root_id, parent_id: message.parent_id, thread_id: message.thread_id,
    message_app_link: message.message_app_link,
  }
}

/**
 * 话题页的一条消息：字段比历史接口碎，归一成事件形状。
 *
 * 两处回落值得留意：飞书有时不给回复消息的 `root_id`，这时用调用方给的 `root`；应用发的
 * 消息里真人 id 是 `open_bot_id`，不是 `sender.id`。
 */
export function topicEvent(message: {
  message_id: string
  create_time: string
  sender: { id: string; open_bot_id?: string | null; sender_type: string }
  content?: string | null
  mentions?: { id: string; key?: string; name?: string }[] | null
  parent_id?: string | null
  thread_id?: string | null
  root_id?: string | null
  message_app_link?: string | null
}, chatId: string, direct: boolean, root: string): unknown {
  return {
    message_id: message.message_id, chat_id: chatId, chat_type: direct ? 'p2p' : 'group', create_time: message.create_time,
    sender_id: message.sender.open_bot_id ?? message.sender.id, sender_type: message.sender.sender_type === 'user' ? 'user' : 'bot',
    content: message.content ?? '', mentions: message.mentions ?? [], parent_id: message.parent_id, thread_id: message.thread_id,
    root_id: message.root_id ?? (message.message_id === root ? undefined : root), message_app_link: message.message_app_link,
  }
}
