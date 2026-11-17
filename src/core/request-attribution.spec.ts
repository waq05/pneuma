/**
 * opencode Go 会话归因头的门控与线上形状（迁自 `scripts/llm-session-header-test.mjs`
 * 的第 [1]-[3] 节）。
 *
 * 事故形状（2026-10-14）：把模型切到 opencode 的 Go 端点（`https://opencode.ai/zen/go/v1`）
 * 之后请求直接被拒——网关按**会话**做路由与 prompt 缓存，客户端没带 `x-opencode-session`
 * 就不给路由。修法：会话 id 从 core 铺到协议层，但**只在命中 Go 入口时**才发头（host 为
 * opencode.ai 或其子域、path 规范化后正好是 `/zen/go/v1`，不认 provider id——那是用户随手
 * 起的名字），顺带补一个自标识 user-agent。别家端点发出去的头与修前逐字节一样。
 *
 * 本文件管三层：
 *   1. 门控纯逻辑：host + path 组合的各种变体、会话 id 合法性（非法值只省略这个头，绝不让
 *      一个观测字段把请求弄坏）、非法 baseUrl 一律不发；
 *   2. 真 wire：`streamChat` 发出的请求头上到底带了什么（Go 端点带、deepseek 端点一个字节
 *      不多带、没有会话 id 时只留 UA）；
 *   3. 重试稳定：同一逻辑调用重试时头的值不变（会话归因靠的就是「同一个会话同一个 id」）。
 *
 * 内核端到端那一层（真回合发出的头里是不是这条会话的 `meta.id`）在
 * `tests/integration/llm-session-header.int.spec.ts`。原探针第 [5] 节是八条源码文本断言
 * （`includes('sessionId: this.session.meta.id')` 之类），按本批规矩不搬——它们钉的是
 * 「代码怎么写」，不是「发出去什么」。
 *
 * ## 为什么用 fetch 装饰器
 *
 * 断言的是**请求头**，`fakeLLM` 只记消息体、不记头；而 Go 端点的 URL 是公网地址，不能真发。
 * 所以这里让装饰器记下 URL 与头，再把请求转发给 `fakeLLM` 拿 SSE——`data:` 分片一个都没有
 * 手写。边界见 `tests/support/fake-fetch.ts`。
 *
 * @module dsc/core/request-attribution.spec
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { fakeLLM, type FakeLLM } from '../../tests/harness.js'
import { installFakeFetch, type FakeFetchHandle } from '../../tests/support/fake-fetch.js'
import {
  APP_USER_AGENT,
  OPENCODE_SESSION_HEADER,
  isOpenCodeGoBaseUrl,
  sessionAttributionHeaders,
  sessionIdHeaderValue,
} from './request-attribution.js'
import { streamChat } from './llm.js'

const GO = 'https://opencode.ai/zen/go/v1'
let fake: FakeLLM
let http: FakeFetchHandle | undefined

beforeAll(async () => {
  fake = await fakeLLM({ turns: ['收到'] })
})

afterEach(() => {
  http?.restore()
  http = undefined
})

afterAll(async () => {
  await fake.close()
})

/** 最小的一次请求（只关心头，正文随便）。 */
const BASE = { apiKey: 'k', model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] }

/** 发一次请求（成功路径由 fakeLLM 应答，头由装饰器记录）。 */
async function call(request: { baseUrl: string; sessionId?: string }): Promise<string> {
  const result = await streamChat({ ...BASE, ...request }, { onDelta() {} })
  return result.text
}

describe('① 门控：认 host + path 一起判', () => {
  test('Go 入口原文与尾斜杠两种写法都认', () => {
    expect(isOpenCodeGoBaseUrl(GO)).toBe(true)
    // 配置里两种写法都有人写。
    expect(isOpenCodeGoBaseUrl(`${GO}/`)).toBe(true)
  })

  test('大小写不敏感，子域与端口不影响（hostname 才判）', () => {
    expect(isOpenCodeGoBaseUrl('HTTPS://OpenCode.AI/Zen/Go/V1')).toBe(true)
    expect(isOpenCodeGoBaseUrl('https://www.opencode.ai/zen/go/v1')).toBe(true)
    expect(isOpenCodeGoBaseUrl('https://opencode.ai:443/zen/go/v1')).toBe(true)
  })

  test('普通 Zen（/zen/v1）不算 Go 入口', () => {
    expect(isOpenCodeGoBaseUrl('https://opencode.ai/zen/v1')).toBe(false)
  })

  test('别的 host 不算', () => {
    expect(isOpenCodeGoBaseUrl('https://api.deepseek.com/v1')).toBe(false)
  })

  test('后缀像但不是一个域（opencode.ai.evil.com）不算', () => {
    // 朴素 `endsWith('opencode.ai')` 会在这里放行，把会话 id 发给别人的域。
    expect(isOpenCodeGoBaseUrl('https://opencode.ai.evil.com/zen/go/v1')).toBe(false)
  })

  test('前缀像（notopencode.ai）不算', () => {
    expect(isOpenCodeGoBaseUrl('https://notopencode.ai/zen/go/v1')).toBe(false)
  })

  test('path 多了尾巴不算（用户把完整 URL 填进 baseUrl 时）', () => {
    expect(isOpenCodeGoBaseUrl(`${GO}/chat/completions`)).toBe(false)
  })

  test('空串 / 认不出的 URL 一律不发', () => {
    expect(isOpenCodeGoBaseUrl('')).toBe(false)
    expect(isOpenCodeGoBaseUrl('not a url')).toBe(false)
    expect(isOpenCodeGoBaseUrl(undefined)).toBe(false)
  })
})

describe('② 会话 id 的合法性：非法值只省略这个头', () => {
  test('uuid 原样过（宿主会话 id 就是这个形状）', () => {
    expect(sessionIdHeaderValue('7b1e0f1a-2c3d-4e5f-8a9b-0c1d2e3f4a5b')).toBe('7b1e0f1a-2c3d-4e5f-8a9b-0c1d2e3f4a5b')
  })

  test('下划线冒号点也放行（别的来源的 id 不许因此丢头）', () => {
    expect(sessionIdHeaderValue('sess_a:b.c')).toBe('sess_a:b.c')
  })

  test('带空格或换行 → 省略（换行会让 fetch 直接抛，把整次请求弄坏）', () => {
    expect(sessionIdHeaderValue('has space')).toBeUndefined()
    expect(sessionIdHeaderValue('a\nb')).toBeUndefined()
  })

  test('空 / 缺 → 省略', () => {
    expect(sessionIdHeaderValue('')).toBeUndefined()
    expect(sessionIdHeaderValue('   ')).toBeUndefined()
    expect(sessionIdHeaderValue(undefined)).toBeUndefined()
  })

  test('超长（>128）→ 省略，128 正好保留', () => {
    expect(sessionIdHeaderValue('a'.repeat(129))).toBeUndefined()
    expect(sessionIdHeaderValue('a'.repeat(128))).toBe('a'.repeat(128))
  })
})

describe('③ 头构造：只认 Go 入口', () => {
  test('Go + 会话 id：自标识 UA + 会话头，且 UA 不是 node / undici', () => {
    const headers = sessionAttributionHeaders(GO, 'sid-1')
    expect(headers['user-agent']).toBe(APP_USER_AGENT)
    expect(headers[OPENCODE_SESSION_HEADER]).toBe('sid-1')
    expect(APP_USER_AGENT).toMatch(/^pneuma\/\S+$/)
    expect(APP_USER_AGENT).not.toMatch(/node|undici/i)
  })

  test('Go 但没有会话 id：只留 UA（网关照旧报 MissingSessionID，报错原文比编的 id 好查）', () => {
    const headers = sessionAttributionHeaders(GO, undefined)
    expect(headers[OPENCODE_SESSION_HEADER]).toBeUndefined()
    expect(headers['user-agent']).toBe(APP_USER_AGENT)
  })

  test('非 Go 端点：空表（deepseek / glm 一个字节都看不到）', () => {
    expect(Object.keys(sessionAttributionHeaders('https://api.deepseek.com/v1', 'sid-1'))).toHaveLength(0)
  })
})

describe('④ 真 wire：Go 端点上真的带了那两个头', () => {
  test('URL 是 Go 的 chat/completions，会话头与 UA 都在，原有头没被挤掉', async () => {
    http = installFakeFetch({ forwardTo: fake.baseUrl })
    expect(await call({ baseUrl: GO, sessionId: 'sid-wire' })).toBe('收到')

    const sent = http.calls.at(-1)!
    expect(sent.url).toBe(`${GO}/chat/completions`)
    expect(sent.headers[OPENCODE_SESSION_HEADER]).toBe('sid-wire')
    expect(sent.headers['user-agent']).toBe(APP_USER_AGENT)
    // 补头不能挤掉协议必需的那两个。
    expect(sent.headers['content-type']).toBe('application/json')
    expect(sent.headers.authorization).toBe('Bearer k')
    // 整份头对 HTTP 合法：非法值不会把请求弄坏。
    expect(() => new Headers(sent.headers)).not.toThrow()
  })

  test('Go 端点没给会话 id：不发那个头，但留着 UA', async () => {
    http = installFakeFetch({ forwardTo: fake.baseUrl })
    expect(await call({ baseUrl: GO })).toBe('收到')
    const sent = http.calls.at(-1)!
    expect(sent.headers[OPENCODE_SESSION_HEADER]).toBeUndefined()
    expect(sent.headers['user-agent']).toBe(APP_USER_AGENT)
  })

  test('反证：deepseek 端点一个字节都不多带（这是「不能无条件加头」那条教训的守门员）', async () => {
    http = installFakeFetch({ forwardTo: fake.baseUrl })
    await call({ baseUrl: 'https://api.deepseek.com/v1', sessionId: 'sid-wire' })
    const sent = http.calls.at(-1)!
    const keys = Object.keys(sent.headers).sort()
    expect(keys).toEqual(['authorization', 'content-type'])
    // UA 没被顺带改掉：undici 的缺省照旧。
    expect(sent.headers['user-agent']).toBeUndefined()
  })

  test('配置写成大写 + 尾斜杠照样命中门控', async () => {
    http = installFakeFetch({ forwardTo: fake.baseUrl })
    await call({ baseUrl: 'https://OpenCode.AI/zen/go/v1/', sessionId: 'sid-wire' })
    expect(http.calls.at(-1)!.headers[OPENCODE_SESSION_HEADER]).toBe('sid-wire')
  })
})

describe('⑤ 重试：头的值不随物理请求变', () => {
  test('5xx 之后重试一次，两次物理请求带的会话 id 完全一致', async () => {
    // 网关按这个 id 做路由：重试时变一次就等于换了会话，缓存与账全丢。
    http = installFakeFetch({
      forwardTo: fake.baseUrl,
      intercept: (_call, index) =>
        index === 0 ? new Response('{"error":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } }) : undefined,
    })
    expect(await call({ baseUrl: GO, sessionId: 'sid-stable' })).toBe('收到')

    expect(http.calls).toHaveLength(2)
    expect(http.calls.map((item) => item.headers[OPENCODE_SESSION_HEADER])).toEqual(['sid-stable', 'sid-stable'])
  })
})
