/**
 * 飞书的写出面：在目标消息所在的话题里回一条，以及拼一条打开群的深链。
 *
 * 两条不能省的细节：
 *
 * 1. **回复带 `--idempotency-key`**（出站消息自己的 id）。投递是「至少一次」：超时重发、重启补发
 *    都可能把同一句话贴两遍；飞书按这个键只保留一条（上游 `feishu-channel.ts:18-23`）。
 * 2. **永久回不了的消息要认出来**：撤回、删除、非群成员这类拒绝重试一万次也一样，返回 `'gone'`
 *    让出站队列丢弃；其余错误照抛，让队列按可重试处理（上游 `feishu-channel.ts:12-17`）。
 *
 * 没搬的是 `ChannelLinks` 那层双语标签（上游 `feishu-channel.ts:32-35`）：DSC 没有 `ChannelLinks`
 * 这个概念，本文件只回 `{ url, triggerId }`，标签文案由界面按语言自己挑。缺了它只影响界面文字，
 * 不影响投递。
 *
 * @module dsc/packages/superagent/adapters/feishu/channel
 */
import type { OutboundMessage } from '../../core/ports.js'
import { CliError, lark, type CliRun } from './cli.js'
import { feishuTriggerId } from './trigger.js'

/**
 * 一条飞书消息的字数上限（上游 `infra/text.ts:3`）。
 *
 * 为什么在写出面拦：飞书一条消息塞进几百字就会被折叠成「查看全文」，工单的回复要求是
 * 「一句话说清现在到哪了」，超限说明这条消息该改写而不是该拆成几条（上游同一条规矩）。
 */
export const IM_WORDS = 100

const WORDS = new Intl.Segmenter('zh', { granularity: 'word' })

/** 中英混排的字数：只数「像词」的段，标点不算（`infra/text.ts:7-11`）。 */
export function wordCount(text: string): number {
  let count = 0
  for (const segment of WORDS.segment(text)) if (segment.isWordLike) count += 1
  return count
}

/** 超限就抛，错误里带上字数和上限，让上层知道该改写而不是重试（`infra/text.ts:13-17`）。 */
export function checkedImText(text: string): string {
  const count = wordCount(text)
  if (count > IM_WORDS) {
    throw new Error(`IM message has ${String(count)} words; maximum is ${String(IM_WORDS)}. `
      + 'Rewrite as a short high-level update. Do not split it into multiple messages.')
  }
  return text
}

/** 打开一个群的 AppLink：事件没带原消息链接时的兜底（上游 `feishu-channel.ts:9-11`）。 */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`

/**
 * 这条消息是不是「再也回不了」。
 *
 * 只认三种：撤回码 230011；错误文本里带 withdrawn；2300xx 段且带 not found。
 * 超时、限流、连不上都不算——那些重试才有用（上游 `feishu-channel.ts:12-17`）。
 */
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined
  && (error.code === 230011 || /withdrawn/i.test(error.message)
    || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))

/**
 * 在目标消息的话题里回一条。
 *
 * @param run - 注入的 CLI 执行器（不带 `--as bot --format json`，由 `lark` 补）
 * @param message - 出站消息；`channel.address.messageId` 是回复目标
 * @returns `'sent'` 已发（含飞书按幂等键吞掉的重复），`'gone'` 这条消息永久回不了
 */
export async function sendFeishu(run: CliRun, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address['messageId']
  if (!messageId) throw new Error('Missing Feishu reply target')
  const text = checkedImText(message.text)
  const reply = ['im', '+messages-reply', '--message-id', messageId, '--markdown', text, '--reply-in-thread',
    '--idempotency-key', message.id]
  try {
    await lark(run, reply)
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}

/**
 * 一个回复地址对应的网页链接。
 *
 * 地址里带 `messageId` 时同时给出那条消息的 Trigger id：界面据此把「飞书消息」链到具体的工单来源，
 * 而不只是打开群（上游把这一步放在 `feishuLink` 里，`feishu-channel.ts:31-35`）。
 */
export function feishuLink(address: Record<string, string>, brand: 'feishu' | 'lark' = 'feishu'):
  { url: string; triggerId?: string } {
  return {
    url: feishuChatLink(brand, address['chatId'] ?? ''),
    ...address['messageId'] ? { triggerId: feishuTriggerId(address['messageId']) } : {},
  }
}
