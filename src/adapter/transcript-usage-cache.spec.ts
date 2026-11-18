/**
 * transcript 的「每轮缓存明细」（contract 的 `TurnUsageView`，P2b 新增）。
 *
 * 口径与 `transcript-usage.int.spec.ts` 的 input/output 一致，只是多两栏：
 * - 端点上报了缓存明细的请求才累计命中/未命中，没上报的请求两栏都不加（命中率不被稀释）；
 * - 两栏同进同退（写入端一次写两个键），不存在只加一侧的状态；
 * - 换新一轮清零，不把上一轮的缓存数带进下一轮页脚。
 *
 * 为什么不产业务内核：记账在 `Transcript.reduce()` 这条纯 reducer 上，喂事件读条目即可，
 * 起真内核只会被流与标题请求的时序拖脆。
 *
 * @module dsc/adapter/transcript-usage-cache.spec
 */
import { describe, expect, test } from 'vitest'
import type { TranscriptEntry } from '../contract.js'
import { Transcript } from './transcript.js'

/** 取条目表里某一类的最后一条；类型跟着 kind 收窄。 */
function lastOf<K extends TranscriptEntry['kind']>(
  transcript: Transcript,
  kind: K,
): Extract<TranscriptEntry, { kind: K }> | undefined {
  const entries = transcript.entries
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.kind === kind) return entry as Extract<TranscriptEntry, { kind: K }>
  }
  return undefined
}

describe('每轮缓存明细', () => {
  test('端点上报了才累计：上报的那笔加，没上报的不加', () => {
    const transcript = new Transcript()
    transcript.reduce({ type: 'user', text: '问' })
    transcript.reduce({ type: 'turn/start' })
    transcript.reduce({ type: 'message', text: '答', reasoning: '' })
    transcript.reduce({ type: 'usage', inputTokens: 100, outputTokens: 10, cacheHitTokens: 60, cacheMissTokens: 40 })
    // 端点没回缓存明细的请求：命中/未命中两栏都不动。
    transcript.reduce({ type: 'usage', inputTokens: 50, outputTokens: 5 })
    transcript.reduce({ type: 'turn/end', reason: 'completed' })

    expect(lastOf(transcript, 'text')?.usage).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      cacheHitTokens: 60,
      cacheMissTokens: 40,
    })
    // 会话累计同一口径（与 core/usage-log 的 ch/cm 一致）。
    expect(transcript.usage).toMatchObject({ cacheHitTokens: 60, cacheMissTokens: 40 })
  })

  test('两笔都上报时相加', () => {
    const transcript = new Transcript()
    transcript.reduce({ type: 'user', text: '问' })
    transcript.reduce({ type: 'message', text: '答', reasoning: '' })
    transcript.reduce({ type: 'usage', inputTokens: 100, outputTokens: 10, cacheHitTokens: 60, cacheMissTokens: 40 })
    transcript.reduce({ type: 'usage', inputTokens: 50, outputTokens: 5, cacheHitTokens: 30, cacheMissTokens: 20 })
    transcript.reduce({ type: 'turn/end', reason: 'completed' })
    expect(lastOf(transcript, 'text')?.usage).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      cacheHitTokens: 90,
      cacheMissTokens: 60,
    })
  })

  test('一次都没上报明细：不带缓存字段（不写 0 冒充「全未命中」）', () => {
    const transcript = new Transcript()
    transcript.reduce({ type: 'user', text: '问' })
    transcript.reduce({ type: 'message', text: '答', reasoning: '' })
    transcript.reduce({ type: 'usage', inputTokens: 9, outputTokens: 1 })
    transcript.reduce({ type: 'turn/end', reason: 'completed' })
    const usage = lastOf(transcript, 'text')?.usage
    expect(usage).toEqual({ inputTokens: 9, outputTokens: 1 })
    expect(Object.hasOwn(usage!, 'cacheHitTokens')).toBe(false)
    expect(Object.hasOwn(usage!, 'cacheMissTokens')).toBe(false)
    expect(Object.hasOwn(transcript.usage, 'cacheHitTokens')).toBe(false)
  })

  test('新用户消息后本轮缓存两栏清零，上一轮的条目数字不动', () => {
    const transcript = new Transcript()
    transcript.reduce({ type: 'user', text: '第一轮' })
    transcript.reduce({ type: 'message', text: '答一', reasoning: '' })
    transcript.reduce({ type: 'usage', inputTokens: 100, outputTokens: 10, cacheHitTokens: 60, cacheMissTokens: 40 })
    transcript.reduce({ type: 'turn/end', reason: 'completed' })

    transcript.reduce({ type: 'user', text: '第二轮' })
    transcript.reduce({ type: 'message', text: '答二', reasoning: '' })
    transcript.reduce({ type: 'usage', inputTokens: 10, outputTokens: 1, cacheHitTokens: 4, cacheMissTokens: 6 })
    transcript.reduce({ type: 'turn/end', reason: 'completed' })

    expect(lastOf(transcript, 'text')?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 1,
      cacheHitTokens: 4,
      cacheMissTokens: 6,
    })
    // 第一轮的条目保持自己的那一份，不被第二轮覆盖。
    const first = transcript.entries.find((entry) => entry.kind === 'text' && entry.text === '答一')
    expect(first !== undefined && (first.kind === 'text' || first.kind === 'tool') ? first.usage : undefined).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cacheHitTokens: 60,
      cacheMissTokens: 40,
    })
  })

  test('一轮以工具结果收尾时，缓存明细跟着落到 tool 卡上', () => {
    const transcript = new Transcript()
    transcript.reduce({ type: 'user', text: '读文件' })
    transcript.reduce({ type: 'turn/start' })
    transcript.reduce({ type: 'tool/call', callId: 'c1', name: 'read', args: '{}' })
    transcript.reduce({ type: 'usage', inputTokens: 50, outputTokens: 5, cacheHitTokens: 35, cacheMissTokens: 15 })
    transcript.reduce({ type: 'tool/result', callId: 'c1', text: '内容' })
    transcript.reduce({ type: 'turn/end', reason: 'completed' })
    expect(lastOf(transcript, 'tool')?.usage).toEqual({
      inputTokens: 50,
      outputTokens: 5,
      cacheHitTokens: 35,
      cacheMissTokens: 15,
    })
  })
})
