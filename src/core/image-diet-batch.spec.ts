/**
 * image-diet 的**批量卸载**（P2a）：攒够一批再卸，别每张越线断一次缓存。
 *
 * `src/core/image-diet.spec.ts` 钉的是「卸哪几张」（按龄/按预算的纯函数口径）；这里钉的是
 * 「什么时候卸」——跨请求的粘性集合、阈值判断、幂等、消息条数与 role 序列不变。
 *
 * 夹具口径：url 约 6000 字符（data URL 的字符数就是它每轮要重发的量），默认阈值 16K。
 * 四轮各加一张用户图后，候选是第 1、2 张（更早回合全卸）+ 第 3 张（用户图预算 1 张），
 * 合计约 18K ≥ 阈值 → 一次卸 3 张；前几轮一张都不卸。
 *
 * @module @pneuma/runtime/core/image-diet-batch.spec
 */
import { describe, expect, test } from 'vitest'
import type { ChatContentPart, ChatMessage } from './llm.js'
import {
  IMAGE_DIET_BATCH_SAVED_CHARS,
  IMAGE_DIET_PLACEHOLDER,
  countImageParts,
  pruneImagesBatch,
} from './image-diet.js'

/** 一个纯文本片段。 */
const text = (value: string): ChatContentPart => ({ type: 'text', text: value })
/** 一张图（data URL，长度够跨过批量阈值的一批）。 */
const image = (url: string): ChatContentPart => ({ type: 'image_url', image_url: { url } })
/** 第 n 张图：6000 多字符，四张合计就够一批。 */
const url = (n: number): string => `data:image/png;base64,${'A'.repeat(6_000)}${String(n)}`
/** 消息的片段。 */
const parts = (message: ChatMessage | undefined): ChatContentPart[] =>
  Array.isArray(message?.content) ? message.content : []
/** 一条消息里有几个卸载占位。 */
const placeholders = (message: ChatMessage | undefined): number =>
  parts(message).filter((part) => part.type === 'text' && part.text === IMAGE_DIET_PLACEHOLDER).length

/** 默认口径：用户图留 4 张、工具图留 2 张、保留最近 2 个回合。 */
const OPTIONS = { userImageBudget: 1, toolImageBudget: 2, keepRounds: 2 } as const

/** 第 n 轮历史：n 个用户回合，每轮一张图。 */
function history(round: number): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let index = 1; index <= round; index += 1) {
    messages.push({ role: 'user', content: [text(`第${String(index)}轮`), image(url(index))] })
    messages.push({ role: 'assistant', content: 'ok' })
  }
  return messages
}

describe('① 阈值未到：四轮各加一张图，一张都不卸', () => {
  test('前三轮输出逐字节不变、没有占位', () => {
    let kept: ReadonlySet<string> = new Set()
    for (let round = 1; round <= 3; round += 1) {
      const messages = history(round)
      const before = JSON.stringify(messages)
      const batch = pruneImagesBatch(messages, OPTIONS, kept)
      expect(JSON.stringify(batch.messages)).toBe(before)
      expect(batch.added).toHaveLength(0)
      expect(placeholders(batch.messages[0])).toBe(0)
      kept = batch.kept
    }
    expect(kept.size).toBe(0)
  })
})

describe('② 到阈值：一次卸多张，消息与 role 序列不变', () => {
  /** 第 4 轮：候选 3 张、合计约 18K → 一批卸掉。 */
  const round4 = history(4)

  test('四张图跨四轮，第 4 轮一次卸 3 张、留最新 1 张', () => {
    const batch = pruneImagesBatch(round4, OPTIONS, new Set())
    expect(batch.added).toHaveLength(3)
    expect(batch.kept.size).toBe(3)
    // 被卸的是第 1、2、3 张；每个位置都换成占位文本，不是删部件。
    expect(placeholders(batch.messages[0])).toBe(1)
    expect(placeholders(batch.messages[2])).toBe(1)
    expect(placeholders(batch.messages[4])).toBe(1)
    // 最新那张（第 4 轮）还在。
    expect(countImageParts(batch.messages)).toBe(1)
  })

  test('消息条数与 role 序列逐条不变（删消息会留下孤儿 tool_call）', () => {
    const batch = pruneImagesBatch(round4, OPTIONS, new Set())
    expect(batch.messages).toHaveLength(round4.length)
    expect(batch.messages.map((message) => message.role)).toEqual(round4.map((message) => message.role))
  })

  test('幂等：同一份历史、同一份集合调两次逐字节相同', () => {
    const first = pruneImagesBatch(round4, OPTIONS, new Set())
    const second = pruneImagesBatch(round4, OPTIONS, first.kept)
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages))
    expect(second.added).toHaveLength(0)
  })

  test('第 5 轮再进来：已卸的 3 张继续卸，新候选不够一批先不动', () => {
    const first = pruneImagesBatch(round4, OPTIONS, new Set())
    const round5 = history(5)
    const second = pruneImagesBatch(round5, OPTIONS, first.kept)
    // 第 1、2 张（更早回合）+ 第 4 张（预算 1 张之外）是候选；前两张已卸、第 4 张单独不到阈值。
    expect(JSON.stringify(second.messages.slice(0, 4))).toBe(JSON.stringify(first.messages.slice(0, 4)))
    expect(second.added).toHaveLength(0)
    expect(countImageParts(second.messages)).toBe(2)
  })
})

describe('③ 单张 ≥ 阈值：立即卸，不压着等', () => {
  test('一张 20K 字符的图一轮就卸', () => {
    const huge = `data:image/png;base64,${'A'.repeat(20_000)}`
    const messages: ChatMessage[] = [{ role: 'user', content: [text('看图'), image(huge)] }]
    const batch = pruneImagesBatch(messages, { ...OPTIONS, userImageBudget: 0 }, new Set())
    expect(batch.added).toHaveLength(1)
    expect(countImageParts(batch.messages)).toBe(0)
    expect(placeholders(batch.messages[0])).toBe(1)
  })
})

describe('④ 阈值确实卡在导出常量上', () => {
  test('两张各一半的图凑够阈值才会一起卸', () => {
    // 每张 url 约 8.2K 字符：单独一张不到 16K，两张合计超过。
    const half = (n: number): string => `data:image/png;base64,${'B'.repeat(8_192)}${String(n)}`
    // 预算全 0：最近 2 个回合里的所有用户图都算候选，只留阈值这一道闸。
    const none = { userImageBudget: 0, toolImageBudget: 0, keepRounds: 2 } as const
    const oneRound: ChatMessage[] = [{ role: 'user', content: [text('第一张'), image(half(1))] }]
    const first = pruneImagesBatch(oneRound, none, new Set())
    // 第一轮只有一张（约 8.2K，不到 16K）→ 先不动。
    expect(first.added).toHaveLength(0)
    expect(half(1).length < IMAGE_DIET_BATCH_SAVED_CHARS).toBe(true)
    // 第二轮添一张：两张合计 ≥ 阈值 → 一次卸两张。
    const twoRounds: ChatMessage[] = [
      { role: 'user', content: [text('第一张'), image(half(1))] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [text('第二张'), image(half(2))] },
    ]
    const second = pruneImagesBatch(twoRounds, none, first.kept)
    expect(2 * half(1).length >= IMAGE_DIET_BATCH_SAVED_CHARS).toBe(true)
    expect(second.added).toHaveLength(2)
  })
})
