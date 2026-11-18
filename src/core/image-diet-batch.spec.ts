/**
 * image-diet 的**批量卸载**（P2a）：攒够一批再卸，别每张越线断一次缓存。
 *
 * `src/core/image-diet.spec.ts` 钉的是「卸哪几张」（按龄/按预算的纯函数口径）；这里钉的是
 * 「什么时候卸、按什么落点」：
 *   - 新候选凑到 {@link IMAGE_DIET_BATCH_MIN_IMAGES} 张才一起卸（按张数，不按 url 字符数）；
 *   - 落点是**位置**而不是 url：同一张图出现多次时，只卸被决定的位置，最新那张按预算留；
 *   - 位置漂移（压缩改了下标）才按 hash 认旧决定，且只在该图整段消息里只出现一次时认；
 *   - 幂等、消息条数与 role 序列不变。
 *
 * @module @pneuma/runtime/core/image-diet-batch.spec
 */
import { describe, expect, test } from 'vitest'
import type { ChatContentPart, ChatMessage } from './llm.js'
import {
  IMAGE_DIET_BATCH_MIN_IMAGES,
  IMAGE_DIET_PLACEHOLDER,
  countImageParts,
  pruneImagesBatch,
} from './image-diet.js'

/** 一个纯文本片段。 */
const text = (value: string): ChatContentPart => ({ type: 'text', text: value })
/** 一张图（data URL，够断言用，不解码）。 */
const image = (url: string): ChatContentPart => ({ type: 'image_url', image_url: { url } })
/** 第 n 张图（互不相同）。 */
const url = (n: number): string => `data:image/png;base64,IMG${String(n)}`
/** 消息的片段。 */
const parts = (message: ChatMessage | undefined): ChatContentPart[] =>
  Array.isArray(message?.content) ? message.content : []
/** 一条消息里有几张图。 */
const imagesIn = (message: ChatMessage | undefined): number =>
  parts(message).filter((part) => part.type === 'image_url').length
/** 一条消息里有几个卸载占位。 */
const placeholders = (message: ChatMessage | undefined): number =>
  parts(message).filter((part) => part.type === 'text' && part.text === IMAGE_DIET_PLACEHOLDER).length

/** 默认口径收紧成「用户图留 1 张、保留最近 2 个回合」，好让候选一张张冒出来。 */
const OPTIONS = { userImageBudget: 1, toolImageBudget: 2, keepRounds: 2 } as const
/** 同一口径但预算很宽：用来造「没有候选、只剩已卸位置」的场合。 */
const GENEROUS = { userImageBudget: 4, toolImageBudget: 2, keepRounds: 2 } as const

/** 一轮用户对话：一张图 + 一条 assistant 回执。 */
const round = (imageUrl: string): ChatMessage[] => [
  { role: 'user', content: [text('看图'), image(imageUrl)] },
  { role: 'assistant', content: 'ok' },
]

/** 第 n 轮历史：每轮一张图，图互不相同。 */
function history(roundCount: number): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let index = 1; index <= roundCount; index += 1) messages.push(...round(url(index)))
  return messages
}

describe('① 按张数攒批：一张先等，凑够两张一次卸', () => {
  test('前两轮一张都不卸，第三轮候选到 2 张时一次卸两张', () => {
    let kept: ReadonlySet<string> = new Set()
    for (let index = 1; index <= 2; index += 1) {
      const messages = history(index)
      const before = JSON.stringify(messages)
      const batch = pruneImagesBatch(messages, OPTIONS, kept)
      expect(JSON.stringify(batch.messages)).toBe(before)
      expect(batch.added).toHaveLength(0)
      kept = batch.kept
    }
    // 第三轮：老回合的 img1 + 预算外的 img2，凑够 2 张 → 一次卸两张。
    const third = pruneImagesBatch(history(3), OPTIONS, kept)
    expect(third.added).toHaveLength(2)
    expect(placeholders(third.messages[0])).toBe(1)
    expect(placeholders(third.messages[2])).toBe(1)
    expect(countImageParts(third.messages)).toBe(1)
  })

  test('第 4 轮再进来：已卸位置继续卸，新候选只有 1 张先攒着', () => {
    const third = pruneImagesBatch(history(3), OPTIONS, new Set())
    const fourth = pruneImagesBatch(history(4), OPTIONS, third.kept)
    expect(fourth.added).toHaveLength(0)
    // 前两轮的图保持占位（前缀稳定），第 3、4 轮的图还在（第 3 张候选先攒着）。
    expect(JSON.stringify(fourth.messages.slice(0, 4))).toBe(JSON.stringify(third.messages.slice(0, 4)))
    expect(countImageParts(fourth.messages)).toBe(2)
  })

  test('消息条数与 role 序列逐条不变（删消息会留下孤儿 tool_call）', () => {
    const messages = history(3)
    const batch = pruneImagesBatch(messages, OPTIONS, new Set())
    expect(batch.messages).toHaveLength(messages.length)
    expect(batch.messages.map((message) => message.role)).toEqual(messages.map((message) => message.role))
  })

  test('幂等：同一份历史、同一份集合调两次逐字节相同', () => {
    const messages = history(3)
    const first = pruneImagesBatch(messages, OPTIONS, new Set())
    const second = pruneImagesBatch(messages, OPTIONS, first.kept)
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages))
    expect(second.added).toHaveLength(0)
  })

  test('单张候选永远不即时卸：url 再大也要等下一张', () => {
    const huge = `data:image/png;base64,${'A'.repeat(200_000)}`
    const single: ChatMessage[] = [{ role: 'user', content: [text('一张大图'), image(huge)] }]
    const waiting = pruneImagesBatch(single, { userImageBudget: 0, toolImageBudget: 0, keepRounds: 2 }, new Set())
    expect(waiting.added).toHaveLength(0)
    expect(countImageParts(waiting.messages)).toBe(1)
    // 第二张进来（另一轮）→ 两张一起卸。
    const two: ChatMessage[] = [...single, ...round(url(9))]
    const batch = pruneImagesBatch(two, { userImageBudget: 0, toolImageBudget: 0, keepRounds: 2 }, new Set())
    expect(batch.added).toHaveLength(2)
    expect(countImageParts(batch.messages)).toBe(0)
    expect(IMAGE_DIET_BATCH_MIN_IMAGES).toBe(2)
  })
})

describe('② 同一张图重复出现：只卸决定过的位置，最新那张必须留着', () => {
  /**
   * 三个用户回合贴的是**同一张图**（同 url）。url 取 20,000 字符：审核复现事故时用的是
   * 这个量级——旧实现按 hash 全场扫，最坏情况下 3 张全被卸（imagesLeft:0）。
   */
  const same = (tag: string): string => `data:image/png;base64,${'S'.repeat(20_000)}${tag}`
  const repeated = (count: number): ChatMessage[] => {
    const messages: ChatMessage[] = []
    for (let index = 1; index <= count; index += 1) messages.push(...round(same('SAME')))
    return messages
  }

  test('3 个回合同一张图：前两轮不动，第三轮卸掉旧的两张、第 3 轮最新那张保留', () => {
    const first = pruneImagesBatch(repeated(2), OPTIONS, new Set())
    // 第二轮只有 1 张候选（第 1 轮那张），不够一批 → 一张都不卸。
    expect(first.added).toHaveLength(0)
    expect(countImageParts(first.messages)).toBe(2)
    const second = pruneImagesBatch(repeated(3), OPTIONS, first.kept)
    // 第三轮候选是第 1、2 轮两张 → 卸两个**位置**，第 3 轮的同一张图不受牵连。
    expect(second.added).toHaveLength(2)
    expect(countImageParts(second.messages)).toBe(1)
    expect(imagesIn(second.messages[4])).toBe(1) // 第 3 轮（最新）那张还在
    expect(placeholders(second.messages[0])).toBe(1)
    expect(placeholders(second.messages[2])).toBe(1)
  })

  test('同 url 的新位置不在粘性集合里，不得被误卸（第 4 轮重发同一张图）', () => {
    const advanced = pruneImagesBatch(repeated(3), OPTIONS, new Set())
    const fourth = pruneImagesBatch(repeated(4), OPTIONS, advanced.kept)
    // 第 4 轮新增的候选只有第 3 轮那张（预算 1 张之外），不够一批 → 不卸。
    expect(fourth.added).toHaveLength(0)
    // 已卸的只有第 1、2 轮两个位置；第 3、4 轮的两张同 url 图都在。
    expect(countImageParts(fourth.messages)).toBe(2)
    expect(imagesIn(fourth.messages[4])).toBe(1)
    expect(imagesIn(fourth.messages[6])).toBe(1)
    expect(placeholders(fourth.messages[6])).toBe(0)
  })
})

describe('③ 位置漂移（压缩改下标）：hash 兜底认旧决定', () => {
  test('消息下标整体后移后，已卸的图继续卸（各自整段消息里只出现一次）', () => {
    const original: ChatMessage[] = [
      { role: 'user', content: [text('A'), image(url(1))] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [text('B'), image(url(2))] },
    ]
    // 预算全 0 → 两张都是候选 → 一批卸掉（位置 0 与 2）。
    const zeros = { userImageBudget: 0, toolImageBudget: 0, keepRounds: 2 } as const
    const first = pruneImagesBatch(original, zeros, new Set())
    expect(first.added).toHaveLength(2)
    // 模拟压缩：前面插进一条 assistant，两张图的下标变成 1 与 3。
    const shifted: ChatMessage[] = [
      { role: 'assistant', content: '（压缩摘要）' },
      { role: 'user', content: [text('A'), image(url(1))] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [text('B'), image(url(2))] },
    ]
    // 用宽预算跑：没有新候选，只剩「位置漂移怎么认旧决定」这一条路。
    const after = pruneImagesBatch(shifted, GENEROUS, first.kept)
    expect(after.added).toHaveLength(0)
    expect(countImageParts(after.messages)).toBe(0)
    expect(placeholders(after.messages[1])).toBe(1)
    expect(placeholders(after.messages[3])).toBe(1)
  })
})
