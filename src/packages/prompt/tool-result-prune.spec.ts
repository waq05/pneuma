/**
 * 历史里超长工具结果的确定性修剪（迁自 `scripts/context-segments-test.mjs` 的第 [2]-[4] 节）。
 *
 * 三条不肯让步的规矩，逐条钉在这里：
 *   1. **确定性**：同一条消息永远切成同一段文本。前缀缓存只在「第一次越过窗口」那一轮
 *      失效一次，之后逐字节稳定——每次请求都按当时指针重算，缓存等于每轮都废。
 *   2. **只切中间，两头都留**，并明说「省掉了多少字符」：模型要知道该怎么办（重读文件、
 *      换更窄的范围），而不是以为结果本来就那么短。
 *   3. **最近几条不动**：刚跑完的工具结果模型马上要用。
 *
 * ## 原探针另外两节去哪了
 *
 *   - 第 [1] 节（`estimateRequestSegments` 的 schema 段与 tools 段分开算）已经在
 *     `src/core/token-estimate.spec.ts` 里逐条覆盖（`toolSchema 归 schema 段`、
 *     `不传 toolSchema 时 schema 段为 0`）。
 *   - 第 [5] 节（沙箱 / 模式说明落在请求末尾的快照里、切模式后系统提示词不变）要真内核的
 *     `prompt.systemPrompt` / `prompt.rewrite`，已迁到
 *     `tests/integration/context-segments.int.spec.ts`。
 *
 * ## 为什么这是 unit 层
 *
 * 修剪是纯函数：吃一份消息数组、吐一份新数组，不读环境、不碰网络。`keepRecent` 的默认值
 * 是 4，所以「最近几条不动」这条要显式传参才测得到（见各用例）。
 *
 * @module dsc/packages/prompt/tool-result-prune.spec
 */
import { describe, expect, test } from 'vitest'
import type { ChatMessage } from '../../core/llm.js'
import { DEFAULT_TOOL_RESULT_PRUNE, pruneToolResults } from './tool-result-prune.js'

/** 造一条工具结果消息（正文是唯一会被修剪的字段）。 */
function tool(content: string): ChatMessage {
  return { role: 'tool', content }
}

describe('① 只切中间：两头都留，中间写明省了多少', () => {
  /** 3000 个 A + 20000 个 M + 3000 个 Z：头尾各有特征，中间那段必须被切掉。 */
  const long = `${'A'.repeat(3_000)}${'M'.repeat(20_000)}${'Z'.repeat(3_000)}`

  test('超长结果被切短，开头 4096 与结尾 1024 都在', () => {
    // keepRecent 设 0：这一段单独验「怎么切」，不掺「最近几条不动」。
    const pruned = pruneToolResults([tool(long)], { ...DEFAULT_TOOL_RESULT_PRUNE, keepRecent: 0 })
    const text = pruned[0]!.content as string
    expect(text.length).toBeLessThan(long.length)
    // 开头保留 4096 个字符：前 3000 个 A 一个不少。
    expect(text.startsWith('A'.repeat(3_000))).toBe(true)
    expect(text.slice(0, 4_096)).toBe(long.slice(0, 4_096))
    // 结尾保留 1024 个字符：全是 Z。
    expect(text.endsWith('Z'.repeat(1_024))).toBe(true)
  })

  test('中间有「省掉了多少字符」的说明（数字对得上，不是编的）', () => {
    const pruned = pruneToolResults([tool(long)], { ...DEFAULT_TOOL_RESULT_PRUNE, keepRecent: 0 })
    const text = pruned[0]!.content as string
    expect(text).toContain('省掉了')
    // 26000 个字符 - 4096 头 - 1024 尾 = 20880。
    expect(text).toContain('省掉了 20880 个字符')
  })

  test('短结果原样不动，输入数组不被就地修改', () => {
    const messages = [tool(long), tool('B'.repeat(20))]
    const pruned = pruneToolResults(messages, { ...DEFAULT_TOOL_RESULT_PRUNE, keepRecent: 0 })
    expect(pruned[1]!.content).toBe('B'.repeat(20))
    expect(messages[0]!.content).toBe(long)
  })

  test('阈值以下完全不碰：返回同一个数组引用（不白造副本）', () => {
    const messages = [tool('short')]
    expect(pruneToolResults(messages)).toBe(messages)
  })
})

describe('② 确定性：同一条消息两次切出逐字节相同的文本', () => {
  test('两次结果逐字节相同（前缀缓存靠这条）', () => {
    const messages = [tool('x'.repeat(30_000))]
    const options = { ...DEFAULT_TOOL_RESULT_PRUNE, keepRecent: 0 }
    const first = pruneToolResults(messages, options)[0]!.content
    const second = pruneToolResults(messages, options)[0]!.content
    expect(first).toBe(second)
  })

  test('修剪过的消息不共享原对象（新数组、新对象）', () => {
    const messages = [tool('x'.repeat(30_000))]
    const pruned = pruneToolResults(messages, { ...DEFAULT_TOOL_RESULT_PRUNE, keepRecent: 0 })
    expect(pruned).not.toBe(messages)
    expect(pruned[0]).not.toBe(messages[0])
  })
})

describe('③ 最近 keepRecent 条不修剪', () => {
  test('五条各 30000 字符时，前三条被切短、最近两条原样', () => {
    const long = 'z'.repeat(30_000)
    const messages = [0, 1, 2, 3, 4].map(() => tool(long))
    const pruned = pruneToolResults(messages, { ...DEFAULT_TOOL_RESULT_PRUNE, keepRecent: 2 })
    expect(pruned.slice(0, 3).every((message) => (message.content as string).length < long.length)).toBe(true)
    expect(pruned.slice(3).every((message) => message.content === long)).toBe(true)
  })

  test('只数工具消息：中间的 user / assistant 不占 keepRecent 的名额', () => {
    // keepRecent 数的是「最近几条**工具**结果」；把它写成「最近几条消息」的话，一轮
    // 对话里夹着的正文会把刚跑完的工具结果挤出保护圈，模型当场就得重跑一次。
    const long = 'z'.repeat(30_000)
    const messages: ChatMessage[] = [
      tool(long),
      { role: 'assistant', content: '看一眼' },
      { role: 'user', content: '继续' },
    ]
    const pruned = pruneToolResults(messages, { ...DEFAULT_TOOL_RESULT_PRUNE, keepRecent: 1 })
    expect(pruned[0]!.content).toBe(long)
  })
})

describe('④ 预算不自洽时当没开（不切出负数区间）', () => {
  test('阈值小于等于头 + 尾时原样返回', () => {
    const messages = [tool('x'.repeat(30_000))]
    const broken = { thresholdChars: 5_000, headChars: 4_096, tailChars: 1_024, keepRecent: 0 }
    expect(pruneToolResults(messages, broken)).toBe(messages)
  })
})
