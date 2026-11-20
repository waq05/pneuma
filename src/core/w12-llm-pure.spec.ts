/**
 * LLM 纯函数边角（`core/llm.ts`）：多模态取图、折叠系统消息时去掉空的 tool_calls 字段、
 * 显式缓存断点挂在块数组的最后一块上、无正文消息原样过。
 *
 * @module dsc/core/w12-llm-pure.spec
 */
import { describe, expect, test } from 'vitest'
import { applyExplicitCache, contentImages, foldSystemMessages } from './llm.js'
import type { ChatMessage } from './llm.js'

describe('contentImages', () => {
  test('字符串 / null / undefined 没有图；块数组里只取 image_url', () => {
    expect(contentImages('纯文本')).toEqual([])
    expect(contentImages(null)).toEqual([])
    expect(contentImages(undefined)).toEqual([])
    const blocks = [
      { type: 'text' as const, text: '看图' },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url' as const, image_url: { url: 'https://example.com/b.png' } },
    ]
    expect(contentImages(blocks)).toEqual(['data:image/png;base64,AAAA', 'https://example.com/b.png'])
  })
})

describe('foldSystemMessages', () => {
  test('没有系统消息时原样返回，并把空的 tool_calls 字段去掉', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello', tool_calls: undefined },
    ]
    const folded = foldSystemMessages(messages)
    expect(folded).toHaveLength(2)
    expect(folded[0]!.content).toBe('hi')
    // tool_calls 为 undefined 时输出对象里不该再留这个键
    expect(folded[1]!.tool_calls).toBeUndefined()
  })

  test('有系统消息时折叠成一条，位置保持不变', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '规则一' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: '规则二' },
    ]
    const folded = foldSystemMessages(messages)
    expect(folded).toHaveLength(2)
    expect(folded[0]!.role).toBe('system')
    expect(folded[0]!.content).toContain('规则一')
    expect(folded[0]!.content).toContain('规则二')
    expect(folded[1]!.role).toBe('user')
  })
})

describe('applyExplicitCache', () => {
  test('字符串正文：断点挂在最后一个文本块上', () => {
    const cached = applyExplicitCache([{ role: 'user', content: 'hello' }]) as Array<{
      content: Array<{ type: string; text?: string; cache_control?: unknown }>
    }>
    const blocks = cached[0]!.content
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('text')
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('块数组正文：前面的块原样不动，断点只追加到最后一块', () => {
    const input = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '第一段' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]
    const cached = applyExplicitCache(input) as Array<{
      content: Array<{ type: string; cache_control?: unknown; text?: string }>
    }>
    const blocks = cached[0]!.content
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.cache_control).toBeUndefined()
    expect(blocks[1]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('没有正文（只有 tool_calls）的消息原样返回，不打断点', () => {
    const input = [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] }]
    const cached = applyExplicitCache(input) as Array<{ content: unknown; tool_calls?: unknown }>
    expect(cached[0]!.content).toBeNull()
    expect(cached[0]!.tool_calls).toBeDefined()
  })
})

