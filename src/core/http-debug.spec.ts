/**
 * 请求追踪号的取用与拼文案（迁自 `scripts/http-debug-test.mjs`，纯函数，不需要 build）。
 *
 * 这一段错的方式很隐蔽：取错了头，用户贴过来的号在服务端查不到；取太松（比如接受换行），
 * 日志会被切成两行，贴进 issue 还可能变成注入。所以这里钉三件事：
 *
 *   ① 认哪几个头、按什么优先级退（`x-request-id` → `x-openai-request-id` → …）；
 *   ② 什么号宁可不取（超长、带换行、带空格、非可见 ASCII）；
 *   ③ 拼进错误文案的形状（有号带括号、两个号用逗号连、没号是空串）。
 *
 * ## 为什么用只实现 `get()` 的桩，而不是 `Headers`
 *
 * `new Headers({...})` 会**当场拒绝**带换行的值，而「带换行的号必须丢掉」正是要验的一条。
 * 被测函数只用到 `get()`，桩就够——真实 `response.headers` 天然满足同一个接口。
 *
 * @module dsc/core/http-debug.spec
 */
import { describe, expect, test } from 'vitest'
import { formatRequestDebug, requestDebugContext, type HeaderReader } from './http-debug.js'

/** 造一个只实现 `get()` 的头读取面（大小写不敏感，与真实现同口径）。 */
function withHeaders(pairs: Array<[string, string]>): HeaderReader {
  const map = new Map(pairs.map(([name, value]) => [name.toLowerCase(), value]))
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null }
}

describe('① 认哪几个头', () => {
  test('认 x-request-id', () => {
    expect(requestDebugContext(withHeaders([['x-request-id', 'req_abc-123']]))?.requestId).toBe('req_abc-123')
  })

  test('没有 x-request-id 时退到 x-openai-request-id', () => {
    expect(requestDebugContext(withHeaders([['x-openai-request-id', 'openai_42']]))?.requestId).toBe('openai_42')
  })

  test('认 cf-ray（CDN 那一层）', () => {
    expect(requestDebugContext(withHeaders([['cf-ray', '8f1a2b3c4d5e-HKG']]))?.cfRay).toBe('8f1a2b3c4d5e-HKG')
  })

  test('两个都有时都带上', () => {
    const debug = requestDebugContext(
      withHeaders([
        ['x-request-id', 'a1'],
        ['cf-ray', 'b2'],
      ]),
    )
    expect(debug?.requestId).toBe('a1')
    expect(debug?.cfRay).toBe('b2')
  })

  test('一个都没有就返回 undefined（调用方据此「不提」而不是「提个空」）', () => {
    expect(requestDebugContext(withHeaders([['content-type', 'application/json']]))).toBeUndefined()
  })
})

describe('② 什么号宁可不取', () => {
  test('超长的不收（防止异常值把日志撑爆）', () => {
    expect(requestDebugContext(withHeaders([['x-request-id', 'x'.repeat(200)]]))).toBeUndefined()
  })

  test('带换行的不收（防止切日志 / 注入）', () => {
    expect(requestDebugContext(withHeaders([['x-request-id', 'abc\ndef']]))).toBeUndefined()
  })

  test('带空格的不收', () => {
    expect(requestDebugContext(withHeaders([['x-request-id', 'abc def']]))).toBeUndefined()
  })
})

describe('③ 拼进错误文案', () => {
  test('一个号带括号', () => {
    expect(formatRequestDebug({ requestId: 'req_1' })).toBe('（request-id req_1）')
  })

  test('两个号用逗号连', () => {
    expect(formatRequestDebug({ requestId: 'req_1', cfRay: 'r2' })).toBe('（request-id req_1，cf-ray r2）')
  })

  test('没有号时是空串（错误文案里不该出现「request-id: 空」）', () => {
    expect(formatRequestDebug(undefined)).toBe('')
  })
})
