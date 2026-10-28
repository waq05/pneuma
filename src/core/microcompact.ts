/**
 * 每轮旧工具结果微压缩（对照 ZCode 的 compact/microcompact.ts）。
 *
 * 长会话里最重的一块历史是**早期的工具结果**：它们每轮原样重发，模型却早就不再回头读。
 * 全量摘要（compact 插件）只在用量逼近窗口上限时才动一次，这中间几十轮没人管——本模块补
 * 的就是这一层：请求组装时把较旧的工具结果正文换成一句占位符。
 *
 * 它只动**请求体**：会话日志存的是原文，模型看见的是「原文 + 投影链」——投影是命名纯函数，
 * 任何人拿日志都能复算（dsh 的 Model-visible ⟺ logged 的个人版）。
 *
 * 保守是刻意的（默认只清最近 5 条以外、单条省不到 256 token 的也放过）：被清掉的正是
 * 模型回头可能要用的现场证据，宁可少清一点，也别让一个正在排查的长回合丢掉上下文。
 *
 * @module dsc/core/microcompact
 */
import type { ChatMessage } from './llm.js'
import { estimateTextTokens } from './token-estimate.js'
import { TODO_REMINDER_TEXT } from './todo-reminder.js'

/** 占位符前缀：既是给模型看的正文，也是幂等的锚点——已经是占位符的条目不处理第二遍。 */
export const CLEARED_TOOL_RESULT_PREFIX = '[旧工具结果已清理'

/** 最近多少条工具结果原样保留（默认值；与 ZCode 的 DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS 同值）。 */
export const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 5

/** 单条至少要省下多少 token 才值得清（默认值；照 ZCode 的 DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS）。 */
export const DEFAULT_MIN_SAVE_TOKENS = 256

/** spill 落盘后留在正文里的指针：这种结果已经「被处理过」，微压缩不再动它。 */
const SPILL_POINTER = '[完整输出已落盘：'

/** 已经是占位符的正文（带工具名，或只有光杆一句）。 */
const CLEARED_PLACEHOLDER = /^\[旧工具结果已清理(?::[^\]]*)?\]$/

/** 微压缩的可调值。 */
export interface MicrocompactOptions {
  /** 最近多少条工具结果以内一律不碰（默认 {@link DEFAULT_KEEP_RECENT_TOOL_RESULTS}）。 */
  keepRecent?: number
  /** 单条估算省下的 token 少于这个数就不清（默认 {@link DEFAULT_MIN_SAVE_TOKENS}）。 */
  minSaveTokens?: number
  /**
   * 失败/被拒的工具调用 id 集合。
   *
   * 为什么要从外面传：dsc 把异常标记放在会话旁路（`Session.toolErrors`），**不挂协议消息**
   * —— 跟 `ts` 一样，多带一个未知字段挑剔的网关会直接 400。纯函数因此不认识会话，由调用方
   * （插件）把这集合递进来。失败结果往往就是证据，一律不清。
   */
  errorCallIds?: ReadonlySet<string>
}

/**
 * 把较旧的工具结果正文换成占位符，返回新数组（**不就地改输入**）。
 *
 * 跳过规则：最近 keepRecent 条 / 失败或被拒 / 带图（数组正文）/ 正文里提到 image_url /
 * 已 spill 落盘 / 已是占位符 / 单条省不到 minSaveTokens。同一条消息跑两遍结果一样
 * （第二遍时旧结果已是占位符，既短又命中幂等锚点）。
 *
 * @param messages - 已 fold-system 之后的那份请求消息（system 在头部，工具结果在各自 assistant 之后）。
 * @param options - 可调值与错误 id 集合。
 */
export function microcompact(messages: readonly ChatMessage[], options: MicrocompactOptions = {}): ChatMessage[] {
  const keepRecent = Math.max(0, Math.floor(options.keepRecent ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS))
  const minSaveTokens = Math.max(0, options.minSaveTokens ?? DEFAULT_MIN_SAVE_TOKENS)
  // 「最近 N 条工具结果」按消息流里的位置算（不看内容）：连续的工具结果各算一条。
  // ZCode 按 assistant 调用分组计数，dsc 一条 tool 消息对一次调用，位置口径更直白。
  const toolIndexes: number[] = []
  messages.forEach((message, index) => {
    if (message.role === 'tool') toolIndexes.push(index)
  })
  if (toolIndexes.length === 0) return [...messages]
  const protectedIndexes = new Set(toolIndexes.slice(Math.max(0, toolIndexes.length - keepRecent)))
  const names = toolCallNames(messages)
  return messages.map((message, index) => {
    if (message.role !== 'tool') return message
    if (protectedIndexes.has(index)) return message
    // 只处理纯文本正文：数组形态（带图）归图片投影管，别在这里动。
    if (typeof message.content !== 'string') return message
    const content = message.content
    if (CLEARED_PLACEHOLDER.test(content)) return message
    // 正文里提到 image_url 的（例如 read 出来的一段配置）也放过：它可能就是模型
    // 正要拿来对照的那几行。
    if (content.includes('image_url')) return message
    if (content.includes(SPILL_POINTER)) return message
    if (message.tool_call_id !== undefined && options.errorCallIds?.has(message.tool_call_id) === true) return message
    if ((message as { error?: unknown }).error !== undefined) return message
    const placeholder = placeholderFor(names.get(message.tool_call_id ?? ''))
    if (estimateTextTokens(content) - estimateTextTokens(placeholder) < minSaveTokens) return message
    return { ...message, content: placeholder }
  })
}

/** 占位符正文：带得上是哪个工具的结果就带上（模型据此知道丢了什么、要不要重跑）。 */
function placeholderFor(toolName: string | undefined): string {
  return toolName === undefined || toolName === ''
    ? `${CLEARED_TOOL_RESULT_PREFIX}]`
    : `${CLEARED_TOOL_RESULT_PREFIX}：${toolName}]`
}

/**
 * 一次清理的「计划」：callId → 要换成的占位符正文。
 *
 * 为什么要把计划单独留一份（2026-10-28）：每轮请求都重新数「最近 5 条」，
 * 工具结果一多，几乎每一步都会有一条刚滑出窗口被清掉——清理点一改，从那条往后
 * 整段前缀作废，服务端前缀缓存命中率被拖到 60% 上下（实测会话 bb13f0b5）。
 * 把计划冻结到「轮到轮之间」复用，同一轮内 30 多步的前缀就是稳的。
 */
export type MicrocompactPlan = ReadonlyMap<string, string>

/** 算出这次该清哪些工具结果（callId → 占位符）；纯函数，不改输入。 */
export function planMicrocompact(messages: readonly ChatMessage[], options: MicrocompactOptions = {}): MicrocompactPlan {
  const out = microcompact(messages, options)
  const plan = new Map<string, string>()
  messages.forEach((message, index) => {
    if (message.role !== 'tool') return
    const id = message.tool_call_id
    if (id === undefined || id === '') return
    if (out[index]!.content === message.content) return
    plan.set(id, typeof out[index]!.content === 'string' ? out[index]!.content : '')
  })
  return plan
}

/**
 * 按冻结的计划改写请求体（只换 callId 命中且内容确实不同的那几条）。
 * 计划里已经不在本次消息里的条目直接跳过（压缩可能把整段历史换掉了）。
 */
export function applyMicrocompactPlan(messages: readonly ChatMessage[], plan: MicrocompactPlan): ChatMessage[] {
  if (plan.size === 0) return [...messages]
  return messages.map((message) => {
    if (message.role !== 'tool') return message
    const id = message.tool_call_id
    if (id === undefined) return message
    const placeholder = plan.get(id)
    if (placeholder === undefined || message.content === placeholder) return message
    return { ...message, content: placeholder }
  })
}

/** 一条消息正文的字符数：字符串按长度算，数组只数 text 部件（图片本身不按 url 长度算钱）。 */
function messageChars(message: ChatMessage): number {
  const content = message.content
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') total += part.text.length
  }
  return total
}

/** 整段提示词的字符数：把所有消息正文加起来，不数 JSON 外壳与 tool_calls 参数（大头是正文）。 */
export function promptCharsOf(messages: readonly ChatMessage[]): number {
  let total = 0
  for (const message of messages) total += messageChars(message)
  return total
}

/**
 * 计划能省下的字符数：被替换正文长度减占位符长度，只算这次确实会改的那几条。
 * 跟 {@link applyMicrocompactPlan} 用同一套命中条件（callId 在计划里且内容不同）。
 */
export function planFreeChars(messages: readonly ChatMessage[], plan: MicrocompactPlan): number {
  let freed = 0
  for (const message of messages) {
    if (message.role !== 'tool') continue
    const id = message.tool_call_id
    if (id === undefined) continue
    const placeholder = plan.get(id)
    if (placeholder === undefined || message.content === placeholder) continue
    if (typeof message.content !== 'string') continue
    freed += message.content.length - placeholder.length
  }
  return freed
}

/**
 * 这份计划值不值得应用：省下的字符占整段提示词的百分比要达到门槛。
 *
 * 为什么要有这道门槛：前缀缓存里命中的 token 大约只按 1/10 价收，没命中的整段按全价
 * 重读。清 1 个 token 只省下 1/10 的钱，可清理点一动、从那儿往后整段前缀作废，要按
 * 全价重读一遍——省得少还不如不清。所以比例不够就先不动，等攒够一轮再说。
 *
 * @param minFreePercent - 门槛百分比（0–100）；0 表示只要能省就应用。
 */
export function planWorthApplying(messages: readonly ChatMessage[], plan: MicrocompactPlan, minFreePercent: number): boolean {
  if (plan.size === 0) return false
  const total = promptCharsOf(messages)
  if (total <= 0) return false
  const threshold = Math.max(0, Math.min(100, minFreePercent))
  return (planFreeChars(messages, plan) / total) * 100 >= threshold
}

/**
 * 这条 user 消息是不是「程序塞进来的」（环境快照 / 任务清单提醒 / 钩子产出 / 队友汇报），
 * 不算用户新开的一轮。轮次键只数真人发言，否则同一轮里 env 快照一刷就被判成
 * 新一轮，冻结计划又白做了。
 *
 * 队友汇报（`<teammate-report `）也算：它是子代理干完活后由程序投进来的，不是真人开口。
 * 如果把它算成新一轮，队友每汇报一次就翻一轮，冻结计划重算、清理点跟着移动，等于每份
 * 汇报都花一次整段前缀重读的钱——汇报越勤，前缀缓存越碎。
 */
export function isSyntheticUserMessage(message: ChatMessage): boolean {
  if (message.role !== 'user') return false
  const text = typeof message.content === 'string' ? message.content : ''
  if (text === TODO_REMINDER_TEXT) return true
  if (text.includes('（本条是程序在每次请求时自动附上的当前环境快照')) return true
  if (text.startsWith('<external_content source="hook:')) return true
  if (text.startsWith('<teammate-report ')) return true
  return false
}

/** 这次请求属于第几轮（真人 user 消息条数）；同一轮内计划可以冻结复用。 */
export function roundKeyOf(messages: readonly ChatMessage[]): number {
  let count = 0
  for (const message of messages) {
    if (message.role === 'user' && !isSyntheticUserMessage(message)) count += 1
  }
  return count
}

/** 扫一遍 assistant 的 tool_calls，建 callId → 工具名 的表（占位符要回填真名）。 */
function toolCallNames(messages: readonly ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name)
  }
  return names
}
