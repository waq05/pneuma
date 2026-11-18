/**
 * tool-result-prune 的**批量落点**（P2a）：攒够一批再切，别每条越线断一次缓存。
 *
 * 为什么单开一张网：`tool-result-prune.spec.ts` 钉的是「怎么切」（纯函数、确定性、最近几条
 * 不动）；这里钉的是「什么时候切」——跨请求的粘性集合、阈值判断、压缩后失效 key、
 * invariant 两次投影逐字节相同。前者的口径不变，后者是这一轮新增的语义。
 *
 * 夹具口径（照默认值算，不写死魔数）：
 *   - 每条超长结果 9000 字符，切开后实际可省约 3800 字符；
 *   - `keepRecent` 默认 4，所以末尾垫 4 条短结果，让前面的长结果都进入候选；
 *   - 4 条候选合计约 15.2K 字符 < 阈值 16K → 前四轮一条都不切；
 *   - 第 5 条进来合计约 19K ≥ 阈值 → 一次切 5 条（这就是「一次断点」）。
 *
 * @module @pneuma/prompt/tests/prune-batch
 */
import { describe, expect, test } from 'vitest'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import {
  DEFAULT_TOOL_RESULT_PRUNE,
  TOOL_RESULT_PRUNE_BATCH_SAVED_CHARS,
  collectToolResultPruneCandidates,
  pruneToolResultsBatch,
} from '../tool-result-prune.js'

/** 一条工具结果（正文是唯一会被修剪的字段）。 */
function tool(id: string, content: string): ChatMessage {
  return { role: 'tool', content, tool_call_id: id }
}

/** 超长结果：9000 字符，刚过 8192 的修剪线。 */
const LONG_CHARS = 9_000
const long = (id: string, seed = 'x'): ChatMessage => tool(id, `${seed}${'x'.repeat(LONG_CHARS - 1)}`)

/** 末尾 4 条短结果：把前面的长结果挤出「最近 4 条」保护圈。 */
const recent = (): ChatMessage[] =>
  Array.from({ length: DEFAULT_TOOL_RESULT_PRUNE.keepRecent }, (_, index) => tool(`recent-${String(index)}`, '最近的结果'))

/** 第 n 轮的历史：前面 n 条超长结果 + 4 条最近短结果。 */
const history = (round: number): ChatMessage[] => [...Array.from({ length: round }, (_, index) => long(`call-${String(index)}`)), ...recent()]

/** 一条消息里的正文（夹具里全是字符串）。 */
const textOf = (message: ChatMessage | undefined): string => (typeof message?.content === 'string' ? message.content : '')

describe('① 阈值未到：逐轮加入超长结果，一条都不切', () => {
  test('候选可省字符合计从 1 条攒到 4 条，前四轮输出逐字不变', () => {
    let kept: ReadonlySet<string> = new Set()
    for (let round = 1; round <= 4; round += 1) {
      const messages = history(round)
      const before = JSON.stringify(messages)
      const batch = pruneToolResultsBatch(messages, DEFAULT_TOOL_RESULT_PRUNE, kept)
      // 输出与输入逐字节相同：这一轮不改历史，前缀缓存不断。
      expect(JSON.stringify(batch.messages)).toBe(before)
      // 集合不前进（一条都没切）。
      expect(batch.added).toHaveLength(0)
      expect(batch.kept.size).toBe(0)
      kept = batch.kept
    }
    // 四轮攒下来仍没到阈值：验证夹具确实卡在阈值下方，免得测试自说自话。
    const pending = collectToolResultPruneCandidates(history(4), DEFAULT_TOOL_RESULT_PRUNE)
    expect(pending).toHaveLength(4)
    expect(pending.reduce((sum, candidate) => sum + candidate.savedChars, 0)).toBeLessThan(TOOL_RESULT_PRUNE_BATCH_SAVED_CHARS)
  })
})

describe('② 到阈值：一次切掉一批，之后每轮继续切', () => {
  /** 第 5 轮：5 条候选合计过阈值，一次全切。 */
  const round5 = history(5)

  test('第 5 条进来时一次切 5 条，最近 4 条原样不动', () => {
    const batch = pruneToolResultsBatch(round5, DEFAULT_TOOL_RESULT_PRUNE, new Set())
    expect(batch.added).toHaveLength(5)
    expect(batch.kept.size).toBe(5)
    for (const message of batch.messages.slice(0, 5)) {
      expect(textOf(message)).toContain('省掉了')
      expect(textOf(message).length).toBeLessThan(LONG_CHARS)
    }
    // 最近 4 条在保护圈里，一条都不许动。
    for (const message of batch.messages.slice(5)) expect(textOf(message)).toBe('最近的结果')
  })

  test('第 6 轮（历史不变）输出与第 5 轮逐字节相同：已切条目继续切', () => {
    const first = pruneToolResultsBatch(round5, DEFAULT_TOOL_RESULT_PRUNE, new Set())
    const second = pruneToolResultsBatch(round5, DEFAULT_TOOL_RESULT_PRUNE, first.kept)
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages))
    expect(second.added).toHaveLength(0)
  })

  test('同一份历史、同一份集合调两次逐字节相同（loop 的 invariant 会跑两遍）', () => {
    // 未到阈值的那一轮也要逐字相同。
    const below = history(4)
    const a = pruneToolResultsBatch(below, DEFAULT_TOOL_RESULT_PRUNE, new Set())
    const b = pruneToolResultsBatch(below, DEFAULT_TOOL_RESULT_PRUNE, a.kept)
    expect(JSON.stringify(b.messages)).toBe(JSON.stringify(a.messages))
    // 刚过阈值的那一轮同样。
    const c = pruneToolResultsBatch(round5, DEFAULT_TOOL_RESULT_PRUNE, new Set())
    const d = pruneToolResultsBatch(round5, DEFAULT_TOOL_RESULT_PRUNE, c.kept)
    expect(JSON.stringify(d.messages)).toBe(JSON.stringify(c.messages))
    expect(d.added).toHaveLength(0)
  })

  test('新增一条超长结果不够再攒一批时，下一轮也不切（阈值仍然生效）', () => {
    const first = pruneToolResultsBatch(round5, DEFAULT_TOOL_RESULT_PRUNE, new Set())
    const round6 = [...round5, long('call-5')]
    const second = pruneToolResultsBatch(round6, DEFAULT_TOOL_RESULT_PRUNE, first.kept)
    // 第 6 条自己只有约 3.8K 可省，不够 16K：不切；前面已切的 5 条继续切。
    expect(second.added).toHaveLength(0)
    expect(JSON.stringify(second.messages.slice(0, 5))).toBe(JSON.stringify(first.messages.slice(0, 5)))
    expect(textOf(second.messages[5])).toBe(textOf(round6[5]))
  })
})

describe('③ 压缩后消息变短：失效 key 忽略，不炸', () => {
  test('历史被改写/截短后旧 key 对不上，按新内容重新判断', () => {
    const first = pruneToolResultsBatch(history(5), DEFAULT_TOOL_RESULT_PRUNE, new Set())
    expect(first.added.length).toBe(5)
    // 模拟压缩：第 1 条被截短成一句摘要（key 里的内容长度变了）。
    const compacted = history(5).map((message, index) =>
      index === 0 ? tool('call-0', '（压缩摘要：原结果已被总结）') : message,
    )
    const after = pruneToolResultsBatch(compacted, DEFAULT_TOOL_RESULT_PRUNE, first.kept)
    // 旧 key 不匹配这条短消息 → 它保持摘要原文；其余已切条目继续切。
    expect(textOf(after.messages[0])).toBe('（压缩摘要：原结果已被总结）')
    for (const message of after.messages.slice(1, 5)) expect(textOf(message)).toContain('省掉了')
    expect(after.added).toHaveLength(0)
  })

  test('整体变短到没有候选时也不炸：输出就是输入', () => {
    const first = pruneToolResultsBatch(history(5), DEFAULT_TOOL_RESULT_PRUNE, new Set())
    // 压缩后只剩一条短结果（key 与集合里任何一条都对不上）→ 没有候选，原样输出。
    const compacted: ChatMessage[] = [tool('call-9', '（压缩摘要：原结果已被总结）'), ...recent()]
    const after = pruneToolResultsBatch(compacted, DEFAULT_TOOL_RESULT_PRUNE, first.kept)
    expect(JSON.stringify(after.messages)).toBe(JSON.stringify(compacted))
    expect(after.added).toHaveLength(0)
  })
})

describe('④ 单个候选自己就够阈值：立即切，不额外等', () => {
  test('一条 30K 字符的结果一轮就切', () => {
    // 最近 4 条短结果护住窗口；30K 那条放最前面，自己就可省约 24K ≥ 阈值。
    const withGuard = [tool('huge', 'x'.repeat(30_000)), ...recent()]
    const batch = pruneToolResultsBatch(withGuard, DEFAULT_TOOL_RESULT_PRUNE, new Set())
    expect(batch.added).toHaveLength(1)
    expect(textOf(batch.messages[0])).toContain('省掉了')
  })
})
