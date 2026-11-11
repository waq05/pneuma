/**
 * 重复调用提醒的纯逻辑（投影本体注册在 `packages/agent`，这里是可被探针直读的那层）。
 *
 * 为什么要有这条提醒：回合环（`packages/session-core/loop.ts:362` 那个 `for (;;)`）**没有步数
 * 上限**，只在「这一步没有工具调用」或「用户取消」时退出。模型若一直要求调工具，这一轮会
 * 无限跑下去（现场：假端点每次都回同一个 `tool_call`，跑到连接断掉才停）。加一个步数上限
 * 会斩断正常的长活（一次改造跑三十多步是常态），所以这里走**建议性**的一条：检测「连续
 * 重复的同一工具 + 完全相同的规范化参数」，到阈值就往请求末尾补一句 user 提醒。
 * **不否决、不改写调用**——工具照常执行，模型看不看这句由它自己决定。
 *
 * ## 为什么走投影、不改循环
 *
 * 提醒要落在「模型下一次请求看见的那份消息」上，而这件事的唯一归属是投影链
 * （`prompt.rewrite`：日志存原文，模型看见的是「原文 + 按序投影」，可复算）。循环那边
 * 不用加任何一步：它在请求组装完时本来就会取走注入清单（`takeContextInjections`）落一条
 * `context/injected`，本投影的提醒因此自动有卡、有日志，不需要新事件、也不动 `loop.ts`。
 *
 * ## 为什么只在「跨过阈值」的那一次提醒
 *
 * 阈值默认 `[3, 5, 8]`，意思是**第 3、5、8 次**各提醒一条，其余步一条都不发。两个理由：
 *   1. 提醒是往每轮请求里加的固定开销（几十个 token）。从第 3 次起每步都发，等于模型每步
 *      都在读同一句话，反而被训练成忽略它；
 *   2. 间隔越来越宽（3 → 5 → 8）对应「模型可能只是需要多试几次」到「它真的在原地打转」
 *      的升级：第一次温和提醒，后面两档把工具名、连续次数与参数摆出来，让它能自己判断。
 * 跨过最后一档（第 9 次起）不再提醒：那时该做的事已经做完了，再多说只是噪声；是否收手
 * 由用户与模型自己决定（本模块不否决任何调用）。
 *
 * ## 参数怎么规范化
 *
 * 判据是「**键名排序后的 JSON**」，不是原始字符串：模型两次给的参数 `{"a":1,"b":2}` 与
 * `{"b":2,"a":1}` 是同一份调用，按原文比会漏判。做法是解析成值、递归按 key 排序、再
 * `JSON.stringify`；数组**保序**（顺序是值的一部分），非对象值原样。解析不了（模型偶尔会
 * 给半截 JSON）就退回 trim 后的原文——宁可漏判一次，也不能因为一条坏参数把整条链抛崩。
 * 参数预览（详细档里贴给模型看的那段）另按 `argumentsPreviewChars` 截断，**判定永远用
 * 完整规范化串**，截断只影响文案。
 *
 * 纯函数、不改输入、不碰日志：与 `core/todo-reminder.ts` 同一条纪律（提醒是提示不是事实，
 * 落成日志条目会污染历史、还会在下次被当作用户原话引用）。
 *
 * @module dsc/core/repeat-reminder
 */
import type { ChatMessage } from './llm.js'

/**
 * 默认阈值：连续第 3、5、8 次各提醒一条（口径与理由见模块头）。
 *
 * 写成导出常量而不是内联数组：探针要能断言「默认就是这三档」，调用方也才有稳定的参照点。
 */
export const DEFAULT_REPEAT_THRESHOLDS: readonly number[] = [3, 5, 8]

/** 详细档里参数预览的默认字数上限（与参照实现同量级：够认出是哪一次调用，又不至于灌满上下文）。 */
export const DEFAULT_ARGUMENTS_PREVIEW_CHARS = 500

/**
 * 提醒文案（模型可见，**不进界面字典**）。
 *
 * 为什么是中文常量而不是 `locale/ui.zh.json`：这类话是**给模型的指令性提醒**，与工具说明、
 * 提示词同一条纪律（`scripts/ui-locale-test.mjs` 明确把工具说明排除在界面文案之外）——
 * 翻了等于改提示词。集中在同一个对象里、可由调用方整份替换（{@link RepeatReminderOptions.texts}），
 * 所以「换一套话」只改这一处，构建函数里一个中文字面量都没有。
 *
 * 占位符：`{tool}` 工具名、`{count}` 连续次数、`{limit}` 预览上限、`{args}` 参数预览。
 */
export interface RepeatReminderTexts {
  /** 第一档：温和，不点名参数（第 3 次）。 */
  gentle: string
  /** 后续档：详细，工具名 + 连续次数 + 参数预览（第 5、8 次）。 */
  detailed: string
}

/** 默认的两档文案（口径见 {@link RepeatReminderTexts}）。 */
export const REPEAT_REMINDER_TEXTS: RepeatReminderTexts = {
  gentle: '（提醒：你在用完全相同的参数重复调用同一个工具，先看上一次的结果，再决定要不要继续）',
  detailed:
    '（提醒：工具 {tool} 已经用完全相同的参数连续调用了 {count} 次。先读上一次的结果；' +
    '本次参数（最多 {limit} 字）：{args}）',
}

/** {@link planRepeatReminder} 的可调项。 */
export interface RepeatReminderOptions {
  /** 阈值档位（升序比较、重复值去重、小于 1 的丢掉）；缺省 {@link DEFAULT_REPEAT_THRESHOLDS}。 */
  thresholds?: readonly number[]
  /** 详细档参数预览的字数上限（夹在 1..100000）；缺省 {@link DEFAULT_ARGUMENTS_PREVIEW_CHARS}。 */
  argumentsPreviewChars?: number
  /** 提醒文案字典（缺省 {@link REPEAT_REMINDER_TEXTS}）；换语言 / 换措辞只换这一份。 */
  texts?: RepeatReminderTexts
}

/** 历史尾部那串连续重复的调用（`null` = 尾部根本没有工具调用）。 */
export interface RepeatedTail {
  /** 工具名。 */
  tool: string
  /** 规范化后的参数（判定口径，见模块头）。 */
  normalized: string
  /** 最近一次的原始参数文本（详细档给模型看的就是它，截断前）。 */
  arguments: string
  /** 连续了多少次（含最近这一次）。 */
  count: number
}

/** 这一跳要不要提醒、提醒哪一档、文本是什么。 */
export interface RepeatReminderPlan {
  /** 这一跳要不要追加提醒。 */
  remind: boolean
  /** 历史尾部连续重复了几次（没有工具调用时是 0）。 */
  count: number
  /** 命中的档位（1 起）；0 = 这一跳不提醒。 */
  tier: number
  /** 尾部那次调用的工具名（没有工具调用时是空串）。 */
  tool: string
  /** 提醒正文；不提醒时是空串。 */
  text: string
}

/**
 * 把一个值按「键名递归排序」重建一份（数组保序）。
 *
 * 为什么要重建而不是给 `JSON.stringify` 传一个排序器：序列化器的第二个参数是**白名单**，
 * 不是排序器；想稳定就得先把对象重排一遍。
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key])
  return out
}

/**
 * 把一条工具调用的参数文本规范化成「可比较的同一份」。
 *
 * 口径：解析 → 键名递归排序 → `JSON.stringify`；数组保序。解析不了退回 trim 后的原文
 * （半截 JSON 是模型偶尔会犯的错，为它把整条投影链抛崩不值得）。
 *
 * @param raw - `tool_call.function.arguments`（模型给的 JSON 文本）
 * @returns 规范化串；空参数给空串
 */
export function normalizeToolArguments(raw: string | null | undefined): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return ''
  try {
    return JSON.stringify(sortKeys(JSON.parse(text)))
  } catch {
    return text
  }
}

/**
 * 数「历史尾部连着用同一份参数调了几次同一个工具」。
 *
 * 走法是从最后一条往前：`tool` 消息（工具结果）属于它前面那次调用，跳过不算断；带
 * `tool_calls` 的 assistant 消息按**调用顺序倒着**展开成一个个「步」；碰到任何别的消息
 * （用户发言、没有工具调用的 assistant、系统提示……）立刻停——那才是「换了一件事」。
 * 同一跳里并行发的多个调用各算一步（它们本来就是一个挨一个的调用）。
 *
 * 只看尾部这一段，不扫全历史：阈值最大是 8，扫到第一个断点就够；会话再长也是 O(阈值)。
 *
 * @param messages - 会话历史（`session.messages`，不含任何投影注入）
 * @returns 尾部那串连续重复的调用；尾部没有工具调用时是 null
 */
export function countRepeatedTail(messages: readonly ChatMessage[]): RepeatedTail | null {
  /** 倒着收集的调用：下标 0 是最近这一次。 */
  const tail: { tool: string; normalized: string; arguments: string }[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'tool') continue
    const calls = message.role === 'assistant' ? message.tool_calls : undefined
    if (calls === undefined || calls.length === 0) break
    for (let at = calls.length - 1; at >= 0; at -= 1) {
      const call = calls[at]!
      const raw = call.function.arguments
      tail.push({
        tool: call.function.name,
        normalized: normalizeToolArguments(raw),
        arguments: typeof raw === 'string' ? raw : '',
      })
    }
    // 一条 assistant 里可能有多个调用：倒序展开后，相邻的两次就是「连续」的两次。
    continue
  }
  if (tail.length === 0) return null
  const latest = tail[0]!
  let count = 1
  while (
    count < tail.length &&
    tail[count]!.tool === latest.tool &&
    tail[count]!.normalized === latest.normalized
  ) {
    count += 1
  }
  return { tool: latest.tool, normalized: latest.normalized, arguments: latest.arguments, count }
}

/** 读阈值：丢掉非数、小于 1 与重复值，升序返回（空数组 = 永不提醒）。 */
function readThresholds(raw: readonly number[] | undefined): number[] {
  if (raw === undefined) return [...DEFAULT_REPEAT_THRESHOLDS]
  const out: number[] = []
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const rounded = Math.round(value)
    if (rounded < 1 || out.includes(rounded)) continue
    out.push(rounded)
  }
  return out.sort((left, right) => left - right)
}

/** 读预览上限：夹在 1..100000（配成 0 会让详细档里出现空括号，配太大等于没截断）。 */
function readPreviewChars(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_ARGUMENTS_PREVIEW_CHARS
  return Math.min(Math.max(Math.round(raw), 1), 100_000)
}

/** 填占位符：认不出的占位符原样留着（别把 `{args}` 这类拼错的键悄悄吃掉）。 */
function fillTemplate(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => params[key] ?? whole)
}

/**
 * 这一跳要不要提醒、哪一档、文本是什么——纯函数。
 *
 * 「命中」是**等于**某一档，不是「大于等于」：第 4 次（阈值 3 已过、5 未到）不提醒，
 * 这样模型看到的是一句偶尔出现的提醒，而不是每步都有的背景音（理由见模块头）。
 *
 * @param messages - 会话历史（`session.messages`）
 * @param options - 阈值 / 预览上限 / 文案字典
 * @returns 决定与文本；不提醒时 `remind:false` 且 `text:''`
 */
export function planRepeatReminder(
  messages: readonly ChatMessage[],
  options: RepeatReminderOptions = {},
): RepeatReminderPlan {
  const repeated = countRepeatedTail(messages)
  if (repeated === null) return { remind: false, count: 0, tier: 0, tool: '', text: '' }
  const tier = readThresholds(options.thresholds).indexOf(repeated.count) + 1
  if (tier === 0) {
    return { remind: false, count: repeated.count, tier: 0, tool: repeated.tool, text: '' }
  }
  const limit = readPreviewChars(options.argumentsPreviewChars)
  const preview =
    repeated.arguments.length > limit ? repeated.arguments.slice(0, limit) + '…' : repeated.arguments
  const texts = options.texts ?? REPEAT_REMINDER_TEXTS
  const template = tier === 1 ? texts.gentle : texts.detailed
  const text = fillTemplate(template, {
    tool: repeated.tool,
    count: String(repeated.count),
    limit: String(limit),
    args: preview,
  })
  return { remind: true, count: repeated.count, tier, tool: repeated.tool, text }
}

/**
 * 把提醒追加成**末尾一条 user 消息**（不拼进最后一条）。
 *
 * 为什么不拼进已有消息：投影链的既有约定是「只往历史尾巴追加」（`prompt/index.ts:211` 的
 * 环境快照、`core/todo-reminder.ts:78` 的待办提醒都是这个写法）。拼进上一条会改动已经发过
 * 的字节，服务端前缀缓存从改动点之后整段失效。
 *
 * 幂等：末尾已经是同一条提醒就不再追加（同一份历史重复投影——校验重算、流中断后的整轮
 * 重试——必须逐字节同结果）。没追加时**原样返回同一个数组**，调用方据此判断「这一跳真补了
 * 东西没有」（注入卡只在这时才该报）。
 *
 * @param messages - 这一轮要发给模型的消息（已含前序投影的注入）
 * @param plan - {@link planRepeatReminder} 的决定
 * @returns 新数组，或原数组（不提醒 / 已经在了）
 */
export function appendRepeatReminder(
  messages: ChatMessage[],
  plan: RepeatReminderPlan,
): ChatMessage[] {
  if (!plan.remind) return messages
  const last = messages[messages.length - 1]
  if (last !== undefined && last.role === 'user' && last.content === plan.text) return messages
  return [...messages, { role: 'user', content: plan.text }]
}
