/**
 * 飞书的只读面：按「一条消息 / 它所在的话题页」读上下文，以及把读到的消息排成给模型看的形状。
 *
 * 所有资源路径都以一个已接收的 Trigger 为锚（`feishu/<trigger-id>/<section>`），不接受任意的
 * chat_id / message_id：路径是模型给的，能随便拼就等于把「读哪个群」交给模型决定
 * （上游 `feishu-read.ts:39-53`）。
 *
 * **没搬的是 `feishuThreadContext`（上游 `feishu-read.ts:153-171`）**：它把本文件的读法挂成上游
 * `sources/kind.ts` 的 `ThreadContext`——「按 root / parent / thread 分节增量读，回
 * `{ messages, body, status, next }` 给评估器」。DSC 的 `core/` 没有这套接口，上下文由
 * 执行器自己组织（与 `adapters/github/read.ts:4-11` 同一处取舍）。缺了它的后果不是丢事件：
 * Trigger 照样进来，只是**评估侧要自己补读一次**——用本文件的 `feishuRead(run, ref, ...)`
 * 就行，读法与上游一致。
 *
 * 也没搬的是 `images` / `image` 两个回调（上游 `feishu-read.ts:168-170`）：它们只是把
 * `feishu-image.ts` 的两个函数挂到 ThreadContext 上，那套接口既不在，这里直接把
 * `readFeishuImage` 导出给接线方调用。
 *
 * @module dsc/packages/superagent/adapters/feishu/read
 */
import { z } from 'zod'
import { lark, validItems, type CliRun, type Tally } from './cli.js'
import {
  feishuTime, withMentionNames, HistoricalMessageSchema, HistoryPageSchema, historyText,
  type FeishuRef, type HistoricalMessage,
} from './trigger.js'

/** 一条消息 id 的形状；CLI 与接口都按它校验，避免把任意字符串拼进 URL（`feishu-read.ts:12`）。 */
const messageId = z.string().regex(/^om_[a-zA-Z0-9_-]+$/)

/** 源消息的原文：只取读上下文要用的几个 id，别把整条消息带出来（`feishu-read.ts:13-16`）。 */
const sourceSchema = z.object({
  message_id: messageId, chat_id: z.string(), root_id: messageId.optional(), parent_id: messageId.optional(),
  thread_id: z.string().regex(/^omt?_[a-zA-Z0-9_-]+$/).optional(), deleted: z.boolean().optional(),
})

/** 话题页 / 单条消息的字段；`content` 是已经渲染过的正文，`mentions` 用来换人名（`feishu-read.ts:17-23`）。 */
const messageSchema = z.object({
  message_id: messageId, chat_id: z.string(), content: z.string().optional(), msg_type: z.string(),
  sender: z.object({ id: z.string(), name: z.string().optional(), open_bot_id: z.string().optional(), sender_type: z.string() }),
  create_time: z.string(), update_time: z.string().optional(), updated: z.boolean().optional(), deleted: z.boolean().optional(),
  mentions: z.array(z.object({ id: z.string(), name: z.string().optional(), key: z.string().optional() })).optional(),
  message_app_link: z.string().optional(), thread_id: z.string().optional(), root_id: z.string().optional(),
  parent_id: z.string().optional(),
})

/** 一条飞书消息（话题页 / 单条读法共用）。 */
export type FeishuMessage = z.infer<typeof messageSchema>

/** 话题页：逐条校验，坏的单独跳过并计数，不连累整页（`feishu-read.ts:25-27`）。 */
const threadSchema = z.object({
  messages: z.array(z.unknown()), has_more: z.boolean(), page_token: z.string().optional(), thread_id: z.string(),
})

/** 一页消息：`next_resource` 为 `null` 表示读完了。 */
export interface FeishuPage<M> {
  status: string
  thread_id?: string
  messages: M[]
  next_resource: string | null
  skipped?: number
}

/** 单条消息的结果；`message: null` 表示这一节本来就没有（比如根消息没有父消息）。 */
export interface FeishuOne<M> { status: string; message: M | null }

/**
 * 只读源消息自己的 AppLink，不展开话题内容。
 *
 * 为什么单独一条读法：回复时想带上原消息的链接，而展开话题可能很大；只查链接就只读一条
 * （上游 `feishu-read.ts:29-37`）。
 */
export async function readFeishuLink(run: CliRun, ref: FeishuRef): Promise<string> {
  const id = messageId.parse(ref.messageId)
  const result = z.object({
    messages: z.array(z.object({
      message_id: messageId, chat_id: z.string(), message_app_link: z.url().optional(), deleted: z.boolean().optional(),
    })),
  }).parse(await lark(run, ['im', '+messages-mget', '--message-ids', id, '--no-reactions']))
  const message = result.messages.find(item => item.message_id === id)
  if (!message || message.deleted || message.chat_id !== ref.chatId || !message.message_app_link) {
    throw new Error('Source message link unavailable')
  }
  return message.message_app_link
}

/** 资源路径：以 Trigger 为锚，`skill` 给评估器一条固定入口（`feishu-read.ts:39-44`）。 */
export function feishuReferences(ref: FeishuRef) {
  const read = (section: string): string => `feishu/${ref.triggerId}/${section}`
  return {
    skill: 'dsh-superagent-feishu', message: read('message'), root: read('root'), parent: read('parent'),
    thread: read('thread'), around: read('around'),
  }
}

/**
 * 校验模型给过来的资源串。
 *
 * 只有 `thread` 与 `around` 带翻页游标；别的 section 带游标一律拒绝——否则模型可以拿游标
 * 拼出任意页（上游 `feishu-read.ts:46-53`）。
 */
export function feishuResource(resource: string) {
  const match = /^feishu\/([^/]+)\/(message|root|parent|thread|around)(?:\/([^/]+))?$/.exec(resource)
  if (!match || (match[3] && match[2] !== 'thread' && match[2] !== 'around')) {
    throw new Error('Use feishu/<trigger-id>/message, /root, /parent, /thread or /around; '
      + 'follow returned next_resource for another page')
  }
  return {
    triggerId: match[1]!,
    section: match[2]!,
    cursor: match[3] ? decodeURIComponent(match[3]) : undefined,
  }
}

/** 读源消息自己的 id / 群 / 根 / 父 / 话题，作为后续读法的锚（`feishu-read.ts:54-64`）。 */
async function sourceOf(run: CliRun, ref: FeishuRef) {
  const id = messageId.parse(ref.messageId)
  // 走原始 mget 接口，别让 CLI 顺手展开话题：这里只要 parent/root 两个 id。
  const params = JSON.stringify({ message_ids: [id] })
  const listed = await lark(run, ['api', 'GET', '/open-apis/im/v1/messages/mget', '--params', params])
  const sourceResult = z.object({ items: z.array(sourceSchema) }).parse(listed)
  const source = sourceResult.items.find(message => message.message_id === id)
  if (!source || source.deleted) {
    throw new Error('The source Feishu message is unavailable or deleted; retained trigger text is still readable')
  }
  if (source.chat_id !== ref.chatId) throw new Error('Feishu source chat does not match the accepted trigger')
  return source
}

/**
 * 读一条消息、或源消息所在话题的一页。
 *
 * 三处边界写死在这里，任一处放宽都会静默读错：
 * - 资源里的 trigger id 必须是被读的这条 Trigger 的 id（`feishu-read.ts:72`）；
 * - 话题页回来的消息必须同群同话题，否则抛（`feishu-read.ts:82-84`）；
 * - 翻页游标必须前进，`has_more` 给了却原地打转就抛，宁可报错也不假装读完（`feishu-read.ts:85`）。
 */
export async function readFeishu(run: CliRun, ref: FeishuRef, resource: string, pageSize: number,
  order: 'asc' | 'desc' = 'asc'): Promise<FeishuPage<FeishuMessage> | FeishuOne<FeishuMessage>> {
  const request = feishuResource(resource)
  if (request.triggerId !== ref.triggerId) throw new Error('A Feishu source trigger is required')
  if (request.section === 'around') throw new Error('The chat around a message is read with feishuRead')
  const source = await sourceOf(run, ref)
  if (request.section === 'thread') {
    if (!source.thread_id) return { status: 'no_thread', messages: [], next_resource: null }
    const args = ['im', '+threads-messages-list', '--thread', source.thread_id, '--order', order,
      '--page-size', String(pageSize), '--no-reactions']
    if (request.cursor) args.push('--page-token', request.cursor)
    const result = threadSchema.parse(await lark(run, args))
    const tally: Tally = { skipped: 0 }
    const messages = validItems(messageSchema, result.messages, tally)
    const outside = messages.some(message => message.chat_id !== source.chat_id
      || (message.thread_id && message.thread_id !== source.thread_id))
    if (result.thread_id !== source.thread_id || outside) {
      throw new Error('Feishu returned messages outside the source thread')
    }
    if (result.has_more && (!result.page_token || result.page_token === request.cursor)) {
      throw new Error('Feishu thread pagination did not advance; history is incomplete')
    }
    return {
      status: 'available', thread_id: result.thread_id, messages, ...tally.skipped ? { skipped: tally.skipped } : {},
      next_resource: result.has_more ? `feishu/${ref.triggerId}/thread/${encodeURIComponent(result.page_token!)}` : null,
    }
  }
  const target = request.section === 'root' ? source.root_id : request.section === 'parent' ? source.parent_id : source.message_id
  if (!target) return { status: `no_${request.section}`, message: null }
  // CLI 会把富文本与合并转发渲染成正文；自动展开的话题回复不要，翻页另有读法。
  const result = z.object({ messages: z.array(messageSchema) })
    .parse(await lark(run, ['im', '+messages-mget', '--message-ids', target, '--no-reactions']))
  const message = result.messages.find(item => item.message_id === target)
  if (!message) throw new Error('The requested Feishu message is unavailable; do not infer its contents')
  if (message.chat_id !== source.chat_id) throw new Error('Feishu returned a message outside the source chat')
  return { status: message.deleted ? 'deleted' : 'available', message }
}

/** 时间读不懂就照原样交出：展示用，不该因为一个怪时间整段读失败（`feishu-read.ts:98-100`）。 */
function isoTime(value: string): string {
  try {
    return feishuTime(value)
  } catch {
    return value
  }
}

/** 一条给模型看的飞书消息。上游叫 `ContextMessage`（`sources/kind.ts:58-61`），DSC 没有这个模块，这里只留字段。 */
export interface FeishuContextMessage {
  id: string
  from: string
  at: string
  text: string
  bot?: true
  deleted?: true
  reply_to?: string
  url?: string
}

/** 话题页的一条消息 → 模型能读的形状；删掉的消息保留 id 但正文空（`feishu-read.ts:101-106`）。 */
export function feishuView(message: FeishuMessage): FeishuContextMessage {
  return {
    id: message.message_id, from: message.sender.name || message.sender.id, at: isoTime(message.create_time),
    text: message.deleted ? '' : withMentionNames(message.content ?? '', message.mentions ?? []),
    ...message.sender.sender_type !== 'user' ? { bot: true as const } : {},
    ...message.deleted ? { deleted: true as const } : {},
    ...message.parent_id ? { reply_to: message.parent_id } : {},
    ...message.message_app_link ? { url: message.message_app_link } : {},
  }
}

/** 历史接口的一条消息 → 模型能读的形状；历史接口只给 open_id，没有名字（`feishu-read.ts:107-113`）。 */
function historyView(message: HistoricalMessage): FeishuContextMessage {
  return {
    id: message.message_id, from: message.sender.id, at: isoTime(message.create_time),
    text: message.deleted ? '' : withMentionNames(historyText(message), message.mentions ?? []),
    ...message.sender.sender_type !== 'user' ? { bot: true as const } : {},
    ...message.deleted ? { deleted: true as const } : {},
    ...message.parent_id ? { reply_to: message.parent_id } : {},
    ...message.message_app_link ? { url: message.message_app_link } : {},
  }
}

/**
 * 读源消息前后各几条群消息（首读前 5、后 5；翻页一次 10 条更早的）。
 *
 * 为什么按时间而不是按 id：飞书的历史接口只认时间范围；`before + 1` 是因为源消息自己也落在
 * 「更早」那一侧，不少取一条就把它丢了（上游 `feishu-read.ts:114-135`）。
 */
async function chatAround(run: CliRun, ref: FeishuRef, cursor: string | undefined, before = 5,
  after = 5): Promise<FeishuPage<FeishuContextMessage>> {
  const time = Date.parse(ref.at)
  if (!Number.isFinite(time)) throw new Error('The source Feishu message has no time to read the chat around')
  const list = async (parameters: Record<string, unknown>) => {
    const params = JSON.stringify({ container_id_type: 'chat', container_id: ref.chatId, ...parameters })
    const page = HistoryPageSchema.parse(await lark(run, ['api', 'GET', '/open-apis/im/v1/messages', '--params', params]))
    return {
      ...page,
      items: validItems(HistoricalMessageSchema, page.items).filter(item => item.chat_id === ref.chatId),
    }
  }
  // 飞书按整秒收时间；源消息算在「更早」那堆里，所以 before + 1 既含它自己、也含它之前的。
  const earlier = await list({
    end_time: String(Math.ceil(time / 1000)), sort_type: 'ByCreateTimeDesc',
    page_size: cursor ? 10 : before + 1, ...cursor ? { page_token: cursor } : {},
  })
  const later = cursor || !after
    ? []
    : (await list({ start_time: String(Math.floor(time / 1000)), sort_type: 'ByCreateTimeAsc', page_size: after + 1 })).items
  const seen = new Set<string>()
  const messages = [...earlier.items.reverse(), ...later]
    .filter(item => !seen.has(item.message_id) && seen.add(item.message_id))
    .map(historyView)
  const more = earlier.has_more && earlier.page_token && earlier.page_token !== cursor
  return {
    status: 'available', messages,
    next_resource: more ? `feishu/${ref.triggerId}/around/${encodeURIComponent(earlier.page_token!)}` : null,
  }
}

/**
 * 读上下文的主入口：`around` 走时间，其余走 `readFeishu` 再转成模型可读的形状。
 *
 * `around` 要先确认源消息还在：时间取的是它自己的 `at`，源消息没了这个时间也就不可信
 * （上游 `feishu-read.ts:136-147`）。
 */
export async function feishuRead(run: CliRun, ref: FeishuRef, resource: string,
  pageSize: number): Promise<FeishuPage<FeishuContextMessage> | FeishuOne<FeishuContextMessage>> {
  const request = feishuResource(resource)
  if (request.section === 'around') {
    if (request.triggerId !== ref.triggerId) throw new Error('A Feishu source trigger is required')
    await sourceOf(run, ref)
    return chatAround(run, ref, request.cursor)
  }
  const result = await readFeishu(run, ref, resource, pageSize)
  if ('messages' in result) return { ...result, messages: result.messages.map(feishuView) }
  return { status: result.status, message: result.message ? feishuView(result.message) : null }
}
