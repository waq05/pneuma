/**
 * 历史里超长工具结果的**确定性**修剪（对标 dsh 的 `compaction-tool-result-pruner`）。
 *
 * 为什么需要（2026-10-30）：PTC 模式下一条 `run_code` 的返回常常是整份文件原文
 * （实测一个 62 次调用的会话里，工具结果合计 43K token，最大一条 6.3K token），
 * 而这些原文在历史里每轮都重发一遍。它们读一次就够了，留着中间那几万字只是花钱。
 *
 * 三条不肯让步的规矩：
 *   1. **确定性**：同一条消息永远切成同一段文本。前缀缓存只在「第一次越过窗口」那一轮
 *      失效一次，之后逐字节稳定——如果每次请求都按当时的指针重算，缓存等于每轮都废。
 *   2. **只切中间，两头都留**：开头往往是命令 / 表头 / 关键结论，结尾往往是错误码与
 *      汇总。切掉中间之后明说「省略了多少字符、原文还在日志里」，模型知道该怎么办
 *      （重读文件、或换更窄的范围再查一次），而不是以为结果本来就那么短。
 *   3. **最近的几条不动**：刚跑完的工具结果模型马上要用，切了它等于让模型重新跑一遍。
 *
 * 作用点：请求投影链（见 plugins/prompt.ts 的 `tool-result-prune`），只改**发给模型的
 * 那一份**；会话日志里永远是原文，重放与审计都不受影响（dsh 的 pruner 同款口径）。
 *
 * @module dsc/core/tool-result-prune
 */
import type { ChatMessage } from './llm.js'

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

/** 被切掉的那段占位。写清「省了多少」与「原文去哪儿找」，别让模型当成结果本来就短。 */
function pruneMarker(dropped: number): string {
  return (
    `\n\n…（这里省掉了 ${String(dropped)} 个字符的中间部分：完整输出还在会话日志里，` +
    '要原文请重新读那个文件，或换更窄的范围再查一次）…\n\n'
  )
}

/**
 * 修剪历史里的超长工具结果。
 *
 * @param messages 请求消息（已拼系统提示）
 * @param options 口径；缺省用 {@link DEFAULT_TOOL_RESULT_PRUNE}
 * @returns 新的消息数组（原数组不动）；没有需要修剪的就原样返回同一个引用
 */
export function pruneToolResults(
  messages: ChatMessage[],
  options: ToolResultPruneOptions = DEFAULT_TOOL_RESULT_PRUNE,
): ChatMessage[] {
  const { thresholdChars, headChars, tailChars, keepRecent } = options
  // 预算不自洽时别硬切（会切出负数区间）：调用方把配置写错了，就当没开
  if (thresholdChars <= headChars + tailChars) return messages
  // 先从后往前找「最近 keepRecent 条工具消息」的下标，那几条一律不动
  const recent = new Set<number>()
  for (let index = messages.length - 1; index >= 0 && recent.size < keepRecent; index -= 1) {
    if (messages[index]?.role === 'tool') recent.add(index)
  }
  let changed = false
  const out = messages.map((message, index) => {
    if (message.role !== 'tool' || recent.has(index)) return message
    if (typeof message.content !== 'string') return message
    const points = Array.from(message.content)
    if (points.length <= thresholdChars) return message
    const head = points.slice(0, headChars).join('')
    const tail = points.slice(points.length - tailChars).join('')
    const dropped = points.length - headChars - tailChars
    changed = true
    return { ...message, content: `${head}${pruneMarker(dropped)}${tail}` }
  })
  return changed ? out : messages
}
