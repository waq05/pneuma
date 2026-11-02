/**
 * 上下文压缩：把旧历史折成一条摘要消息（对应 dsh compaction 的个人版
 * 最小实现——无 span 选择/锁，只有"保头折尾"策略）。
 *
 * 摘要调用复用主对话前缀（2026-10-03，对齐 dsh summarizer 的 warm-prefix 设计）：
 * messages = [真实系统提示词, ...被折区间的原始消息, 末尾一条压缩指令]，工具目录照发——
 * 辅助调用因此成为上一次真实请求的前缀扩展，命中服务端 KV 缓存；摘要模型看到的也是
 * 对话原貌，而不是截过参数、抹平角色的转写。
 *
 * 摘要之外还附几样机械产物（见 ./compact-anchors.js）：正则抽的锚点索引、
 * 真实用户原话逐字引用、压前读过的文件状态（read-state）、细节找回指针。模型写的叙述会漏掉
 * SHA 与报错原文，前几样不走模型；read-state 则是「刚读到哪」的可读提示。
 *
 * 触发：/compact 手动，或 loop 每轮开始前的自动阈值检查
 * （估算 tokens > 80% × 模型 contextWindow）。磁盘上写 summary 记录，
 * 重放时等价折叠。
 *
 * @module dsc/core/compact
 */
import type { ChatContentPart, ChatMessage, LlmRoute, LlmStream, ToolSchema } from './llm.js'
import { contentImages, contentText } from './llm.js'
import { estimateTextTokens } from './token-estimate.js'
import type { Session } from './session.js'
import { readSpillConfig, spillText, type SpillConfig } from './spill.js'
import {
  buildAnchorIndex,
  buildReadState,
  buildRecoveryFooter,
  collectVerbatimUserMessages,
  DEFAULT_ANCHOR_BUDGET_CHARS,
  DEFAULT_READ_STATE_BUDGET_CHARS,
  DEFAULT_READ_STATE_FILES,
  DEFAULT_USER_QUOTE_BUDGET_CHARS,
  SUMMARY_BANNER,
} from './compact-anchors.js'

/** 压缩后保留的最近消息条数的缺省值（compact 插件配置没给 `keepRecent` 时用它）。 */
export const DEFAULT_KEEP_RECENT = 20

/**
 * 摘要前置裁剪的口径（T19，对标 dsh compaction-tool-result-pruner / compaction-image-offload）：
 * 历史送摘要模型之前先机械瘦身——超限工具结果裁掉留 spill 指针、老图片按预算卸载。
 * 只影响摘要输入（省 token、摘要不被日志噪音淹没）；锚点索引与原话引用仍取自原文，全量保真。
 */
export interface PruneOptions {
  /** spill 配置；给值 = 超限工具结果走 `spillText` 落盘留指针（模型可 read 找回）。 */
  spill?: SpillConfig
  /** 摘要转写里保留原图的张数，之后的图片换成占位说明。 */
  imageBudget: number
  /** 单条工具结果进摘要转写的字符预算（spill 未配置时纯截断）。 */
  toolResultChars: number
}

/** 前置裁剪的缺省口径。 */
export const DEFAULT_PRUNE_OPTIONS: PruneOptions = { imageBudget: 4, toolResultChars: 2000 }

/** 一次前置裁剪的统计与产物。 */
export interface PruneOutcome {
  /** 裁剪后的消息（新数组；原数组不动）。 */
  region: ChatMessage[]
  /** 被裁掉并落盘留指针的工具结果条数。 */
  spilledTools: number
  /** 被占位说明换掉的图片张数。 */
  offloadedImages: number
}

/**
 * 历史的前置裁剪（纯消息变换 + spill 落盘）：
 * - 超预算的 string 工具结果 → spill 预览（前几行 + 完整路径 + 续读写法）或纯截断说明；
 * - 带图工具结果的图片全部卸载为占位（截图留在历史里等于每轮重发）；
 * - 用户消息图片按预算保留，超出的换「图片已卸载」占位。
 */
export function pruneRegion(messages: readonly ChatMessage[], sessionId: string, options: PruneOptions): PruneOutcome {
  let spilledTools = 0
  let offloadedImages = 0
  let imageBudget = options.imageBudget
  const region: ChatMessage[] = messages.map((message) => {
    if (message.role === 'tool' && typeof message.content === 'string') {
      if (message.content.length <= options.toolResultChars) return message
      spilledTools += 1
      let replacement: string
      if (options.spill !== undefined) {
        const spilled = spillText(sessionId, message.content, options.spill)
        replacement = spilled.text
        // 单行巨型输出（一行几万字符的 bundle）会让「前 N 行」的预览照样巨大，
        // 预览超限时按字符再截一刀，指针单独补回去——模型照着路径 read 就能找回全文
        if (replacement.length > options.toolResultChars * 2) {
          replacement = `${replacement.slice(0, options.toolResultChars)}…（预览超限已截）\n[完整输出已落盘：${spilled.written.path}]`
        }
      } else {
        replacement = `${message.content.slice(0, options.toolResultChars)}\n…（已裁剪，原长 ${message.content.length} 字符）`
      }
      return { ...message, content: replacement }
    }
    const parts = message.content
    if (parts === null || typeof parts === 'string') return message
    const hasImage = parts.some((part) => part.type === 'image_url')
    if (!hasImage) return message
    const text = contentText(parts)
    let replaced = false
    let removedInMessage = 0
    const nextParts: ChatContentPart[] = parts.flatMap((part): ChatContentPart[] => {
      if (part.type !== 'image_url') return [part]
      if (message.role === 'user' && imageBudget > 0) {
        imageBudget -= 1
        return [part]
      }
      replaced = true
      offloadedImages += 1
      removedInMessage += 1
      return [{ type: 'text', text: '（图片已卸载，原文里这里是一张图）' }]
    })
    if (!replaced) return message
    // 工具结果整条收成一句说明（正文 + 卸载注记）；用户消息保留剩余部件与占位
    if (message.role === 'tool') {
      return { ...message, content: [{ type: 'text', text: `${text}\n（工具结果里的 ${removedInMessage} 张图已卸载）` }] }
    }
    return { ...message, content: nextParts }
  })
  return { region, spilledTools, offloadedImages }
}

/** 一次压缩的几个上限。字符预算由 compact 插件的配置给值。 */
export interface CompactLimits {
  /** 摘要之外原样保留的最近消息条数（条数下限，token 预算只可能让它留得更多）。 */
  keepRecent: number
  /**
   * 摘要之外原样保留的最近消息的 token 预算（绝对值）。
   * 缺省 0 表示不按 token 选，退回纯条数口径（与改造前的行为一致）。
   * 配了值之后，尾部至少留够这么多 token，再退到工具配对的安全边界。
   */
  retainTokens?: number
  /** 锚点索引的字符预算。 */
  anchorChars: number
  /** 摘要里逐字引用的用户原话的字符预算。 */
  userQuoteChars: number
  /** 摘要里 read-state（压前读过的文件与行范围）最多列几个文件。 */
  readStateFiles: number
  /** read-state 段的字符预算。 */
  readStateChars: number
}

/** 各上限的缺省值（compact 插件配置没给时用它）。 */
export const DEFAULT_COMPACT_LIMITS: CompactLimits = {
  keepRecent: DEFAULT_KEEP_RECENT,
  anchorChars: DEFAULT_ANCHOR_BUDGET_CHARS,
  userQuoteChars: DEFAULT_USER_QUOTE_BUDGET_CHARS,
  readStateFiles: DEFAULT_READ_STATE_FILES,
  readStateChars: DEFAULT_READ_STATE_BUDGET_CHARS,
}

/**
 * 粗略 token 估算（口径见 core/token-estimate.ts 的模块注释：中文 0.65、其余 0.33）。
 */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  let tokens = 0
  for (const message of messages) {
    const content = message.content
    if (typeof content === 'string') {
      tokens += estimateTextTokens(content)
    } else if (content !== null) {
      for (const part of content) {
        // 图像每张按 1000 token 估（与原 chars/3 时代的 4000 字符/张同口径）。
        tokens += part.type === 'text' ? estimateTextTokens(part.text) : 1_000
      }
    }
    for (const call of message.tool_calls ?? []) {
      tokens += estimateTextTokens(call.function.name + call.function.arguments)
    }
  }
  return Math.ceil(tokens)
}

/** 一次压缩的结果：压没压成，以及压前压后的 token 估算（调用方据此判断要不要再压）。 */
export interface CompactResult {
  /** 'compacted' = 真写了摘要；'noop' = 历史太短，或切点退到 0（整段都是工具结果）。 */
  outcome: 'compacted' | 'noop'
  /** 进函数时整段历史的估算 token 数（摘要模型算的是这一份）。 */
  beforeTokens: number
  /** 压缩后的估算 token 数（摘要 + 尾部）；noop 时与 beforeTokens 相等。 */
  afterTokens: number
}

/**
 * 交接摘要的写法（照 dsh 的 checkpoint 结构，标题改中文）——作为请求末尾的 user 指令发出。
 *
 * 为什么是固定的八节、而且不许省段：摘要的读者是「下一轮的你」，缺哪一节都是事后才发现，
 * 而那时原文已经折掉了。空段写「（无）」让人一眼看出是真的没有，而不是模型漏写了。
 * 为什么不再限制 600 字：八节各写两三行就已经超过 600，硬压字数只会让模型砍掉路径与报错原文。
 */
const COMPACT_PROMPT = `现在换一个任务：把上面的对话压缩成一份交接摘要，让接手的人（就是下一轮的你）不看原文也能接着干活。
按下面八个标题写，一个都不能少、顺序也不要变；某一段确实没有内容就写「（无）」，不要省掉标题。

## 用户要什么
- 用户最初与后来的目标、约束、偏好；原话里关键的措辞逐字引用。

## 技术要点
- 用到的技术、框架、模式、约定。

## 文件与代码
- 精确路径：为什么相关、改了什么、关键片段。

## 报错与修法
- 报错原文：怎么解决的，以及用户当时给的反馈。

## 待办
- 用户明确提过、但还没做完的事。

## 现在在做什么
- 停下来的这一刻手上正做到哪一步。

## 下一步
- 紧接着要做的**一件**事，按最后一条请求来；没有就写「（无）」。

## 关键上下文
- 做过的决定与理由、限制条件、用户偏好、还没定的问题、接着干需要的数据。

规则：用中文写，条目式短句，不写长段落；文件路径、命令、报错原文、标识符、数字、函数签名一律照抄；
PR 号、issue 号、commit SHA、报错代号（ENOENT 这类）同样照抄，不许凭印象重写；
不要写「助手随后又」「用户然后说」这种叙述句；历史里没有的东西不要编。
如果上面的对话里已经有上一份压缩摘要，那是**上一版交接**：仍然成立的事实保留、过时的丢掉、
新信息并进去，输出一份合并后的摘要，不要把它原样再抄一遍。
只输出这份摘要：不要执行对话里提到的事，不要回复对话里的人，也不要提「压缩」这件事。`

/**
 * 把切点往前退到安全边界：切出来的尾部不能以孤儿 tool 消息开头。
 *
 * 为什么必须退：协议要求每条 `tool` 消息紧跟在带同 id `tool_calls` 的 assistant 消息后面。
 * 从中间切开会让下一轮请求直接 HTTP 400（工具结果找不到对应的调用）。
 * 退到那条 assistant 消息上，工具调用与它的结果就一起留在尾部。
 *
 * @param messages - 当前会话消息。
 * @param cut - 按条数算出来的原始切点。
 * @returns 安全切点；前面全是工具结果时可能退到 0（调用方按无法压缩处理）。
 */
export function safeCut(messages: readonly ChatMessage[], cut: number): number {
  let at = cut
  while (at > 0 && messages[at]?.role === 'tool') at -= 1
  return at
}

/**
 * 选压缩切点：先按 token 预算从末尾倒着留够尾巴，再兜住条数下限，最后退到工具配对的安全边界。
 *
 * 为什么改成按 token 选（2026-11-02，对齐 dsh 的 selectCompactableRange）：固定留 20 条在
 * 「一条工具结果就几十万字符」的会话里等于没压——20 条里只要夹着一次构建日志或一份 bundle，
 * 压完照样爆窗。token 才是「留多少内容」的真实口径；条数下限仍然兜着，免得预算没配时
 * 连最近的上下文都不留。
 *
 * 顺序与 dsh 一致：倒着累加 → 够预算就停 → 退到工具配对安全的位置（切出来的尾部
 * 不能以孤儿 tool 消息开头，见 {@link safeCut}）。
 *
 * @param messages - 当前会话消息。
 * @param caps - 压缩上限；`retainTokens` 缺省或 0 时退回纯条数口径。
 * @returns 安全切点；前面全是工具结果时可能退到 0（调用方按无法压缩处理）。
 */
export function selectCut(messages: readonly ChatMessage[], caps: CompactLimits): number {
  const budget = caps.retainTokens ?? 0
  let keepFrom = messages.length
  let accumulated = 0
  // 从末尾往前累加，累计到够预算（或走到 0）就停；keepFrom 因此落在这条消息上。
  // budget 为 0 时第一轮就满足，keepFrom = 最后一条，由下面的条数下限拉回去。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    accumulated += estimateTokens([messages[index]!])
    keepFrom = index
    if (accumulated >= budget) break
  }
  // 条数下限仍然生效：至少留 keepRecent 条（再小只会留得更多，不会更少）。
  const floor = Math.max(0, messages.length - Math.max(0, caps.keepRecent))
  keepFrom = Math.max(0, Math.min(keepFrom, floor))
  return safeCut(messages, keepFrom)
}

/**
 * 把一段历史渲染成纯文本——只给锚点索引/原话引用的机械抽取当输入。
 * 工具参数一字不截：SHA、路径、报错可能就藏在参数里，机械抽取要全量保真。
 * （发给摘要模型的是真实消息本身，不再经过这份转写。）
 */
function renderRegion(messages: readonly ChatMessage[]): string {
  return messages
    .map((message) => {
      const calls =
        message.tool_calls?.map((call) => `[工具调用 ${call.function.name}(${call.function.arguments})]`).join(' ') ?? ''
      return `${message.role}: ${contentText(message.content)}${calls}`
    })
    .join('\n\n')
}

/** 压缩一次；历史太短（或没有可折的内容）返回 outcome = 'noop'，不写任何记录。 */
export async function compactSession(
  session: Session,
  /** 当前模型路由（api 字段决定走哪个协议适配器）。 */
  route: LlmRoute,
  /** 经适配器表派发的流式请求调用（由 compact 插件从 llm 服务取）。 */
  stream: LlmStream,
  signal: AbortSignal,
  /** 摘要之外要原样带过去的内容（任务清单、会话目标这类状态，不能被摘要吃掉）。 */
  extra: string | undefined,
  /** 本次压缩的各项上限；compact 插件把它的配置值传进来。 */
  limits: CompactLimits | undefined,
  /** 爆窗重试用：忽略「历史太短」的 noop 检查直接压一次（切点退到 0 时仍放弃）。 */
  force: boolean | undefined,
  /** 摘要前置裁剪（T19）；不传用缺省口径（不落盘、只按预算截断）。 */
  prune: PruneOptions | undefined,
  /**
   * 复用主对话前缀的两样东西（摘要调用因此命中服务端 KV 缓存，对齐 dsh summarizer）：
   * system = 与主对话一字不差的系统提示词；tools = 主对话那份工具目录（缺省不发）。
   * 必传：没有它摘要调用就是独立形状，缓存的账对不上。
   */
  context: { system: string; tools?: readonly ToolSchema[] },
): Promise<CompactResult> {
  const caps = limits ?? DEFAULT_COMPACT_LIMITS
  const messages = session.messages
  // 压前读数取「进函数时这份全量」：noop 时 before / after 相等，调用方据此判断是否要再压
  const beforeTokens = estimateTokens(messages)
  const noop = (): CompactResult => ({ outcome: 'noop', beforeTokens, afterTokens: beforeTokens })
  if (force !== true && messages.length <= caps.keepRecent + 2) return noop()
  const cut = selectCut(messages, caps)
  // 切点退到 0 = 整个历史都是工具结果，没有可折的内容（正常历史首条必然是用户消息）
  if (cut === 0) return noop()
  const raw = messages.slice(0, cut)
  // T19：送摘要模型前先机械瘦身（超长工具结果留 spill 指针、老图卸载）；
  // 锚点索引与原话引用仍取自原文——机械抽取要全量保真，不能跟着裁剪走
  const pruned = pruneRegion(raw, session.meta.id, prune ?? { ...DEFAULT_PRUNE_OPTIONS })
  const region = pruned.region

  // 请求形态（2026-10-03）：真实系统提示词 + 被折区间的真实消息 + 末尾一条压缩指令——
  // 整条请求是上一次真实请求的前缀扩展，服务端缓存能一直命中到指令前一个字；
  // 工具目录照发，少一样就不是前缀了。
  const result = await stream(
    route.api,
    {
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      model: route.model,
      // 摘要是**这条会话**的请求：端点按会话归因时得算在被压的会话头上，
      // 不能算成「当前查看的会话」（后台会话照样会压缩）
      sessionId: session.meta.id,
      maxTokens: route.maxTokens,
      temperature: route.temperature,
      // 压缩请求是上一次真实请求的前缀扩展：端点支持显式缓存时，断点也照打，
      // 不然这条「暖缓存」路径反而比正常请求少一层命中（缺省 false = 完全不变）
      ...(route.cacheControl === true ? { cacheControl: true } : {}),
      signal,
      ...(context.tools === undefined || context.tools.length === 0 ? {} : { tools: [...context.tools] }),
      messages: [{ role: 'system', content: context.system }, ...region, { role: 'user', content: COMPACT_PROMPT }],
    },
    { onDelta() {} },
  )
  if (result.text.trim() === '') throw new Error('摘要模型返回为空')

  // 锚点从没裁剪的原文里抽：路径与报错可能整段被裁进了 spill 文件，
  // 锚点索引是模型找回它们的最后一根线，必须全量保真
  const anchors = buildAnchorIndex(renderRegion(raw), caps.anchorChars)
  const quotes = collectVerbatimUserMessages(raw, caps.userQuoteChars)
  // read-state 与锚点一样取自**原文**：它要的是「模型最后读了哪一段」这个事实，
  // 与送摘要模型前的裁剪无关
  const readState = buildReadState(raw, caps.readStateChars, caps.readStateFiles)
  const recovery = buildRecoveryFooter({ regionMessages: region.length, sessionFile: session.filePath })
  const carry = extra === undefined || extra.trim() === '' ? '' : `\n\n${extra.trim()}`
  // 顺序固定：摘要正文 → 原样带过去的状态 → 用户原话 → 锚点 → read-state → 细节找回
  const summary = `${SUMMARY_BANNER}\n${result.text.trim()}${carry}${quotes}${anchors}${readState}${recovery}`
  // 摘要压不小就放弃（对齐 dsh：「summary is not smaller than the shadowed content」）。
  // 为什么宁可抛错也不写回去：摘要比被折的内容还长，等于用「压缩」把上下文撑得更大，
  // 下一次请求只会更接近爆窗；调用方看到失败（手动压缩会提示、自动压缩会照常继续下一轮），
  // 比历史悄悄变长好。
  const summaryTokens = estimateTokens([{ role: 'user', content: summary }])
  if (summaryTokens >= beforeTokens) {
    throw new Error(
      `压缩没有意义：摘要估算 ${summaryTokens} tokens 不小于被折叠的 ${beforeTokens} tokens`,
    )
  }
  const kept: ChatMessage[] = [{ role: 'user', content: summary }, ...messages.slice(cut)]
  const afterTokens = estimateTokens(kept)
  session.replaceWithSummary(summary, kept)
  return { outcome: 'compacted', beforeTokens, afterTokens }
}
