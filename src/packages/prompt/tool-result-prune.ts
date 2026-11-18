/**
 * 历史里超长工具结果的**确定性**修剪（对标 dsh 的 `compaction-tool-result-pruner`）。
 *
 * 为什么需要（2026-10-30）：PTC 模式下一条 `run_code` 的返回常常是整份文件原文
 * （实测一个 62 次调用的会话里，工具结果合计 43K token，最大一条 6.3K token），
 * 而这些原文在历史里每轮都重发一遍。它们读一次就够了，留着中间那几万字只是花钱。
 *
 * 四条不肯让步的规矩：
 *   1. **确定性**：同一条消息永远切成同一段文本。前缀缓存只在「第一次越过窗口」那一轮
 *      失效一次，之后逐字节稳定——如果每次请求都按当时的指针重算，缓存等于每轮都废。
 *   2. **只切中间，两头都留**：开头往往是命令 / 表头 / 关键结论，结尾往往是错误码与
 *      汇总。切掉中间之后明说「省略了多少字符、原文还在日志里」，模型知道该怎么办
 *      （重读文件、或换更窄的范围再查一次），而不是以为结果本来就那么短。
 *   3. **最近的几条不动**：刚跑完的工具结果模型马上要用，切了它等于让模型重新跑一遍。
 *   4. **攒够一批再落**（P2a，2026-11-18）：每切一条，缓存从那条起整段失效——逐条落
 *      等于每条越线断一次。改成「本会话第一次真正切之前，先把候选攒着；新增候选合计
 *      可省字符 ≥ {@link TOOL_RESULT_PRUNE_BATCH_SAVED_CHARS} 才一次切开」。已切过的
 *      条目记在粘性集合里，之后每轮继续切（前缀保持稳定，只断这一次）。
 *
 * ## 粘性集合长什么样
 *
 * key = `tool_call_id` + 内容字符长度（没有 id 的老消息回退内容 sha256 前 16 位）。
 * 为什么带长度：压缩会把历史里的旧消息改写/截短，key 对不上就自动失效，不会拿旧决定
 * 去套新内容（「压缩后消息变短时集合里失效 key 忽略即可」）。集合只增不减：一条结果
 * 一旦切过，后面每轮都必须继续切，否则同一段前缀在两次请求间翻转——那正是缓存杀手。
 * 集合落成会话状态（`tool-result-prune-batch`，写回见 packages/prompt/index.ts 的
 * noteStickyBatch）：换进程重放同一份日志时先读回来，投影输出仍逐字节相同。
 * 状态里还记着做决定时的消息条数，本轮历史变短（压缩/回退）就整份作废、重新攒批
 * （`pruneToolResultsBatch` 的 `decidedAtLength`），免得旧决定在压缩后的新历史上复活。
 *
 * 作用点：请求投影链（见 plugins/prompt.ts 的 `tool-result-prune`），只改**发给模型的
 * 那一份**；会话日志里永远是原文，重放与审计都不受影响（dsh 的 pruner 同款口径）。
 *
 * @module dsc/core/tool-result-prune
 */
import { createHash } from 'node:crypto'
import type { ChatMessage } from '../../core/llm.js'

/** 修剪口径。字符数按 Unicode 码点算，不会把 emoji 拆成两个半截。 */
export interface ToolResultPruneOptions {
  /** 合并文本超过这个字符数才修剪（默认 8192）。 */
  thresholdChars: number
  /** 保留开头多少个字符。 */
  headChars: number
  /** 保留结尾多少个字符。 */
  tailChars: number
  /** 最近多少条工具结果原样保留（不修剪）。 */
  keepRecent: number
}

/** 缺省口径：与 dsh 的 pruner 同一组数字（8K 阈值 / 4K 头 / 1K 尾），另留 4 条最近结果。 */
export const DEFAULT_TOOL_RESULT_PRUNE: ToolResultPruneOptions = {
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
  keepRecent: 4,
}

/**
 * 批量落点阈值：新增候选合计能省下 **16384 个字符**，才把这一批一起切开。
 * 单条候选自己就够 16384 字符时这一批自然成立：立刻切，不额外等。
 *
 * ## 单位是字符，不是 token；回本模型（2026-11-18 修正口径）
 *
 * 16,384 字符换算成 token 大约 4–6K（**按英文 / 代码估，中文更高**），**不是**
 * 「一次断点的量级」。真正的账是：
 *   - 切一批造成一次前缀断点：从被切的消息起，后面整段后缀要重读一次，损失 ≈
 *     `0.9 × 清理点之后的后缀 token`（0.9 是实测缓存未命中比例的经验系数，留 1 成余量）；
 *   - 攒批多留的原文在每一轮请求里都在花：每轮多付 ≈ `0.9 × 已攒字符换算的 token`；
 *   - 所以只有当「一次断点损失 ÷ 每轮省下的 token」小于「清理点之后还会发多少轮请求」时，
 *     这一批才回本。工具密集会话一轮内后缀通常是 10–20K token 量级，16,384 字符
 *     （按英文/代码 ≈4–6K token）的第一批大约 2–4 轮内回本；后续批越大回本越快。
 *
 * 数值取 16,384 是**启发式**：恰为单条工具结果修剪线（8192 字符）的两倍，且让
 * 「单条大结果（动辄几十 K 字符）自己就能成批」，不会被阈值永远压着不切；
 * 它没有与 microcompact 等其它模块的常量对齐（那边是另一套按 token 的口径）。
 */
export const TOOL_RESULT_PRUNE_BATCH_SAVED_CHARS = 16_384

/** 修剪候选：一条已经够长、又不在最近窗口里的工具结果。 */
export interface ToolResultPruneCandidate {
  /** 粘性集合里的稳定 key（见文件头）。 */
  key: string
  /** 切掉中间、换成占位之后，这一条实际少发的字符数。 */
  savedChars: number
  /** 候选在入参数组里的下标：还没进入粘性集合时按它精确落点。 */
  index: number
}

/** 一次批量落点的结果。 */
export interface ToolResultPruneBatch {
  /** 投影后的消息（没有本批与已切条目时原样返回同一个引用）。 */
  messages: ChatMessage[]
  /** 新的粘性集合（只增不减）；没到阈值时就是传入的那个引用。 */
  kept: ReadonlySet<string>
  /** 本次新并入集合的 key（没到阈值时为空）。 */
  added: readonly string[]
  /**
   * 历史比做决定时变短（压缩/回退）→ 旧粘性集合作废、本轮按空集合重新攒批。
   * 调用方据此把「作废后的空集合」写回状态，别让旧决定在历史重新变长后复活。
   */
  reset: boolean
}

/** 被切掉的那段占位。写清「省了多少」与「原文去哪儿找」，别让模型当成结果本来就短。 */
function pruneMarker(dropped: number): string {
  return (
    `\n\n…（这里省掉了 ${String(dropped)} 个字符的中间部分：完整输出还在会话日志里，` +
    '要原文请重新读那个文件，或换更窄的范围再查一次）…\n\n'
  )
}

/** 预算自洽才切：阈值必须大于头 + 尾，否则会切出负数区间。 */
function usable(options: ToolResultPruneOptions): boolean {
  return options.thresholdChars > options.headChars + options.tailChars
}

/** 按口径把一条正文切成「头 + 占位 + 尾」；不够长就返回 null。 */
function pruneContent(
  content: string,
  options: ToolResultPruneOptions,
): { text: string; savedChars: number } | null {
  // 先用 UTF-16 长度粗筛：它不小于码点数，粗筛不过的一定不够长，省一次 Array.from。
  if (content.length <= options.thresholdChars) return null
  const points = Array.from(content)
  if (points.length <= options.thresholdChars) return null
  const head = points.slice(0, options.headChars).join('')
  const tail = points.slice(points.length - options.tailChars).join('')
  const dropped = points.length - options.headChars - options.tailChars
  const text = `${head}${pruneMarker(dropped)}${tail}`
  return { text, savedChars: points.length - Array.from(text).length }
}

/**
 * 一条工具结果的粘性 key：优先 `tool_call_id` + 内容长度（同一调用结果被压缩截短后
 * 长度会变，旧 key 自然失效）；老消息没有 id 时退回内容 hash（节点 sha256 前 16 位）。
 */
function toolResultKey(message: ChatMessage, content: string): string {
  const id = message.tool_call_id
  if (typeof id === 'string' && id !== '') return `t:${id}:${String(content.length)}`
  return `h:${createHash('sha256').update(content).digest('hex').slice(0, 16)}`
}

/** 最近 `keepRecent` 条工具消息的下标（从后往前数，只数 role=tool 的）。 */
function recentToolIndexes(messages: readonly ChatMessage[], keepRecent: number): Set<number> {
  const recent = new Set<number>()
  for (let index = messages.length - 1; index >= 0 && recent.size < keepRecent; index -= 1) {
    if (messages[index]?.role === 'tool') recent.add(index)
  }
  return recent
}

/**
 * 算本轮的修剪候选：够长、不在最近窗口里的工具结果。纯函数，不读任何外部状态。
 *
 * @param messages 请求消息（已拼系统提示）
 * @param options 口径；缺省用 {@link DEFAULT_TOOL_RESULT_PRUNE}
 */
export function collectToolResultPruneCandidates(
  messages: readonly ChatMessage[],
  options: ToolResultPruneOptions = DEFAULT_TOOL_RESULT_PRUNE,
): ToolResultPruneCandidate[] {
  if (!usable(options)) return []
  const recent = recentToolIndexes(messages, options.keepRecent)
  const candidates: ToolResultPruneCandidate[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.role !== 'tool' || recent.has(index) || typeof message.content !== 'string') continue
    const pruned = pruneContent(message.content, options)
    if (pruned === null) continue
    candidates.push({ key: toolResultKey(message, message.content), savedChars: pruned.savedChars, index })
  }
  return candidates
}

/** 把集合里这些 key 对应的工具结果切掉；一个都没命中就原样返回同一个数组。 */
export function applyToolResultPrune(
  messages: readonly ChatMessage[],
  options: ToolResultPruneOptions = DEFAULT_TOOL_RESULT_PRUNE,
  kept: ReadonlySet<string> = new Set(),
): ChatMessage[] {
  if (kept.size === 0 || !usable(options)) return messages as ChatMessage[]
  let changed = false
  const out = messages.map((message) => {
    if (message.role !== 'tool' || typeof message.content !== 'string') return message
    if (!kept.has(toolResultKey(message, message.content))) return message
    const pruned = pruneContent(message.content, options)
    if (pruned === null) return message
    changed = true
    return { ...message, content: pruned.text }
  })
  return changed ? out : (messages as ChatMessage[])
}

/**
 * 批量落点：先算候选，只有「新增候选合计可省字符 ≥ 阈值」才把它们并进粘性集合并切开。
 *
 * 同一份历史、同一份集合调两次，输出逐字节相同（loop.ts 的 invariant 会把投影链跑两遍）：
 * 第一次并集之后，第二次的新增候选为空，阈值判断落到「不改」；已切条目照旧切。
 *
 * @param messages 请求消息（已拼系统提示）
 * @param options 口径；缺省用 {@link DEFAULT_TOOL_RESULT_PRUNE}
 * @param kept 该会话的粘性已切集合（只增不减）
 * @param minSaved 批量阈值（字符）；缺省用 {@link TOOL_RESULT_PRUNE_BATCH_SAVED_CHARS}
 * @param decidedAtLength 上次做决定时的消息条数（会话状态里记着）；本轮 `messages.length`
 *   比它短说明历史被压缩/回退，旧集合作废、按空集合重新攒批（与 image-diet 同一条规矩）
 */
export function pruneToolResultsBatch(
  messages: readonly ChatMessage[],
  options: ToolResultPruneOptions = DEFAULT_TOOL_RESULT_PRUNE,
  kept: ReadonlySet<string> = new Set(),
  minSaved: number = TOOL_RESULT_PRUNE_BATCH_SAVED_CHARS,
  decidedAtLength?: number,
): ToolResultPruneBatch {
  const reset = decidedAtLength !== undefined && messages.length < decidedAtLength
  const base: ReadonlySet<string> = reset ? new Set<string>() : kept
  const candidates = collectToolResultPruneCandidates(messages, options)
  const added: string[] = []
  const seen = new Set<string>()
  let saved = 0
  for (const candidate of candidates) {
    if (base.has(candidate.key) || seen.has(candidate.key)) continue
    seen.add(candidate.key)
    added.push(candidate.key)
    saved += candidate.savedChars
  }
  if (added.length === 0 || saved < minSaved) {
    // 没到阈值：本批一条都不切，但已切的条目必须继续切（前缀稳定）。
    return { messages: applyToolResultPrune(messages, options, base), kept: base, added: [], reset }
  }
  const next = new Set(base)
  for (const key of added) next.add(key)
  return { messages: applyToolResultPrune(messages, options, next), kept: next, added, reset }
}

/**
 * 一次性修剪（不做粘性：把**本轮**所有候选都切掉）。批量落点请用
 * {@link pruneToolResultsBatch}；这个入口留给不需要跨请求记忆的调用方与单测。
 *
 * 给了 `kept` 就只切集合里的条目（候选仍未到阈值时保持原样），这样同一个函数既能
 * 单独用，也能给批量流程当「应用」那一半。
 *
 * @param messages 请求消息（已拼系统提示）
 * @param options 口径；缺省用 {@link DEFAULT_TOOL_RESULT_PRUNE}
 * @param kept 粘性已切集合；省略时等价于「本轮候选全部切」
 * @returns 新的消息数组（原数组不动）；没有需要修剪的就原样返回同一个引用
 */
export function pruneToolResults(
  messages: ChatMessage[],
  options: ToolResultPruneOptions = DEFAULT_TOOL_RESULT_PRUNE,
  kept?: ReadonlySet<string>,
): ChatMessage[] {
  if (kept !== undefined) return applyToolResultPrune(messages, options, kept)
  const candidates = collectToolResultPruneCandidates(messages, options)
  if (candidates.length === 0) return messages
  const indexes = new Set(candidates.map((candidate) => candidate.index))
  let changed = false
  const out = messages.map((message, index) => {
    if (!indexes.has(index) || typeof message.content !== 'string') return message
    const pruned = pruneContent(message.content, options)
    if (pruned === null) return message
    changed = true
    return { ...message, content: pruned.text }
  })
  return changed ? out : messages
}
