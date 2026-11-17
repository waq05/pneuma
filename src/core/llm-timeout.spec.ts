/**
 * LLM 的时限与重试（迁自 `scripts/llm-timeout-test.mjs`）。
 *
 * 由来：端点连不上时，默认要等**连接超时 30 秒 × 6 次尝试 ≈ 3 分钟**才浮到界面上——
 * 慢的不是界面，是这个等待。这一批把两个超时做成环境变量可覆盖：
 *
 *   - `DSC_LLM_CONNECT_TIMEOUT_MS`：建连 + 响应头（默认 30s）；
 *   - `DSC_LLM_STREAM_IDLE_MS`：流空闲（默认 180s，SSE 心跳也算字节会重置计时）。
 *
 * 断言三层：① 读数纯函数（缺省 / 覆盖 / 上下夹住 / 垃圾值回落）；② 真 wire——「永不回应」
 * 的端点上连接超时按覆盖值提前掐断、报的秒数就是覆盖值；③ 流空闲同理（一个字节都不吐的
 * 流）。另加一层退避曲线与重试预算（2026-11-07 的 429 报障：dsh 给 5 次重试、退避
 * 500ms→10s，dsc 原来只给 2 次、共 1.5 秒，一次车队式限流就整轮报错）。
 *
 * ## 为什么用 fetch 装饰器
 *
 * 「永不回应」「开了流却不吐字节」这两种端点，`fakeLLM` 造不出来（它总在响应结束时把整段
 * SSE 一次写出去），而 `tests/harness.ts` 在本批禁改名单里。成功路径仍转发给 `fakeLLM`：
 * 429 那两条用例只在装饰器里短路两次，第三次放行给 harness 的真端点——**一个 `data:` 分片
 * 都没有在这里手写**。装饰器的边界见 `tests/support/fake-fetch.ts`。
 *
 * @module dsc/core/llm-timeout.spec
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { fakeLLM, type FakeLLM } from '../../tests/harness.js'
import { installFakeFetch, type FakeFetchHandle } from '../../tests/support/fake-fetch.js'
import { LlmError, readRetryAttempts, readTimeoutMs, retryDelayMs, streamChat } from './llm.js'

/** 本文件会改的环境变量：一律在 afterEach 还原，避免渗到别的用例。 */
const ENV_NAMES = [
  'DSC_TEST_TIMEOUT_MS',
  'DSC_LLM_CONNECT_TIMEOUT_MS',
  'DSC_LLM_STREAM_IDLE_MS',
  'DSC_LLM_RETRY_ATTEMPTS',
] as const
const ORIGINAL_ENV = new Map(ENV_NAMES.map((name) => [name, process.env[name]]))

let fake: FakeLLM
let http: FakeFetchHandle | undefined

beforeAll(async () => {
  fake = await fakeLLM({ turns: ['收到'] })
})

afterEach(() => {
  http?.restore()
  http = undefined
  for (const name of ENV_NAMES) {
    const original = ORIGINAL_ENV.get(name)
    if (original === undefined) delete process.env[name]
    else process.env[name] = original
  }
})

afterAll(async () => {
  await fake.close()
})

/** 最小的一次请求（正文随便，值为空都可以：`streamChat` 不校验 messages）。 */
const REQUEST = { apiKey: 'k', model: 'm', baseUrl: 'https://example.invalid/v1', messages: [{ role: 'user' as const, content: 'hi' }] }

/** 发一次请求，把错误（或 undefined）捞出来。 */
async function catchError(handlers: Parameters<typeof streamChat>[1] = { onDelta() {} }): Promise<unknown> {
  try {
    await streamChat(REQUEST, handlers)
    return undefined
  } catch (error) {
    return error
  }
}

describe('① 读数纯函数 `readTimeoutMs`', () => {
  const NAME = 'DSC_TEST_TIMEOUT_MS'

  test('缺省用回默认值', () => {
    delete process.env[NAME]
    expect(readTimeoutMs(NAME, 30_000)).toBe(30_000)
  })

  test('覆盖值给几就是几', () => {
    process.env[NAME] = '8000'
    expect(readTimeoutMs(NAME, 30_000)).toBe(8_000)
  })

  test('下界夹住：写 10 毫秒不会让请求全秒失败', () => {
    process.env[NAME] = '10'
    expect(readTimeoutMs(NAME, 30_000)).toBe(1_000)
  })

  test('上界夹住：写一天也不会把端点等死', () => {
    process.env[NAME] = '99999999'
    expect(readTimeoutMs(NAME, 30_000)).toBe(600_000)
  })

  test('垃圾值与 0 都回落默认', () => {
    process.env[NAME] = 'abc'
    expect(readTimeoutMs(NAME, 30_000)).toBe(30_000)
    // 0 会被读成「立刻超时」，等于把重试环全变成失败。
    process.env[NAME] = '0'
    expect(readTimeoutMs(NAME, 30_000)).toBe(30_000)
  })

  test('小数取整', () => {
    process.env[NAME] = '1234.6'
    expect(readTimeoutMs(NAME, 30_000)).toBe(1_235)
  })
})

describe('② 真 wire：连接超时按覆盖值掐断', () => {
  test('≈1.2 秒失败（不是默认 30 秒），文案与秒数是覆盖值，且标成可重试', async () => {
    // 「永不回应」的端点：只在被 abort 时把 abort 的 reason 抛回去（undici 同形）。
    http = installFakeFetch({
      intercept: (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener(
            'abort',
            () => {
              reject(call.init.signal?.reason)
            },
            { once: true },
          )
        }),
    })
    process.env['DSC_LLM_CONNECT_TIMEOUT_MS'] = '1200'
    // 这一节测的是「超时怎么掐断」，不是「重试怎么退避」：预算压到 1 次。
    process.env['DSC_LLM_RETRY_ATTEMPTS'] = '1'

    const started = Date.now()
    const error = (await catchError()) as LlmError
    const elapsed = Date.now() - started

    expect(elapsed).toBeGreaterThanOrEqual(1_000)
    expect(elapsed).toBeLessThan(6_000)
    expect(error).toBeInstanceOf(LlmError)
    expect(error.message).toContain('连接超时（1 秒无响应）')
    // 超时进重试环，而不是当致命错：网络瞬断值得再试一次。
    expect(error.retryable).toBe(true)
  })
})

describe('③ 真 wire：流空闲按覆盖值掐断', () => {
  test('≈1.2 秒判定挂起；零字节按连接失败处理（可重试，T33 既定口径）', async () => {
    // 建连成功、SSE 头就绪，但一个字节都不吐（服务端挂起的形状）。
    http = installFakeFetch({
      intercept: () =>
        new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    })
    process.env['DSC_LLM_STREAM_IDLE_MS'] = '1200'
    process.env['DSC_LLM_RETRY_ATTEMPTS'] = '1'

    const started = Date.now()
    const error = (await catchError()) as LlmError
    const elapsed = Date.now() - started

    expect(elapsed).toBeGreaterThanOrEqual(1_000)
    expect(elapsed).toBeLessThan(6_000)
    expect(error).toBeInstanceOf(LlmError)
    expect(error.message).toContain('流空闲超过 1 秒')
    expect(error.retryable).toBe(true)
  })
})

describe('④ 退避曲线与重试预算（纯函数）', () => {
  test('倍数退避：500 / 1000 / 8000 毫秒，再往后封顶 10 秒', () => {
    // random 传 0.5 就是中线，把 ±10% 抖动钉死成期望值。
    expect(retryDelayMs(1, () => 0.5)).toBe(500)
    expect(retryDelayMs(2, () => 0.5)).toBe(1_000)
    expect(retryDelayMs(5, () => 0.5)).toBe(8_000)
    expect(retryDelayMs(9, () => 0.5)).toBe(10_000)
  })

  test('抖动两侧：−10% 与 +10%', () => {
    expect(retryDelayMs(1, () => 0)).toBe(450)
    expect(retryDelayMs(1, () => 1)).toBe(550)
  })

  test('预算缺省 6 次尝试、可覆盖、夹在 1~20（0 关不掉重试）', () => {
    delete process.env['DSC_LLM_RETRY_ATTEMPTS']
    expect(readRetryAttempts()).toBe(6)
    process.env['DSC_LLM_RETRY_ATTEMPTS'] = '3'
    expect(readRetryAttempts()).toBe(3)
    process.env['DSC_LLM_RETRY_ATTEMPTS'] = '0'
    expect(readRetryAttempts()).toBe(6)
    process.env['DSC_LLM_RETRY_ATTEMPTS'] = '999'
    expect(readRetryAttempts()).toBe(20)
  })
})

describe('⑤ 真 wire：429 之后重试，每次重试都报「第几次 / 允许几次 / 等多久」', () => {
  test('两次 429 之后成功收下：三次物理请求、两条重试、退避 500 → 1000', async () => {
    process.env['DSC_LLM_RETRY_ATTEMPTS'] = '3'
    // 前两次 429（纯 JSON，不带流体），第三次放行给 fakeLLM 的真 SSE。
    http = installFakeFetch({
      forwardTo: fake.baseUrl,
      intercept: (_call, index) =>
        index < 2
          ? new Response(JSON.stringify({ error: { message: 'the cell is at capacity' } }), {
              status: 429,
              headers: { 'content-type': 'application/json' },
            })
          : undefined,
    })
    const retries: Array<{ attempt: number; maxRetries: number; delayMs: number; reason: string }> = []
    const result = await streamChat(REQUEST, {
      onDelta() {},
      onRetry: (attempt, reason, info) => retries.push({ attempt, reason, ...info }),
    })

    expect(http.calls).toHaveLength(3)
    expect(retries).toHaveLength(2)
    // 界面上的分子是「第几次重试」，分母是允许的重试次数（预算 3 = 首试 + 2 次重试）。
    expect(retries.map((item) => item.attempt)).toEqual([1, 2])
    expect(retries.every((item) => item.maxRetries === 2)).toBe(true)
    expect(retries[0]?.delayMs).toBeGreaterThanOrEqual(450)
    expect(retries[0]?.delayMs).toBeLessThanOrEqual(550)
    expect(retries[1]?.delayMs).toBeGreaterThanOrEqual(900)
    expect(retries[1]?.delayMs).toBeLessThanOrEqual(1_100)
    // 失败原因带着上游报文：界面那行「为什么重试」读的就是它。
    expect(String(retries[0]?.reason)).toContain('429')
    expect(result.text).toBe('收到')
  })

  test('预算用完就如实报错，不许假装还在重试', async () => {
    process.env['DSC_LLM_RETRY_ATTEMPTS'] = '2'
    http = installFakeFetch({
      intercept: () => new Response(JSON.stringify({ error: { message: 'capacity' } }), { status: 429 }),
    })
    const retries: unknown[] = []
    const error = (await catchError({
      onDelta() {},
      onRetry: (attempt, _reason, info) => retries.push({ attempt, ...info }),
    })) as LlmError

    // 预算 2 = 首试 + 1 次重试。
    expect(http.calls).toHaveLength(2)
    expect(retries).toHaveLength(1)
    expect(error).toBeInstanceOf(LlmError)
    expect(error.message).toContain('HTTP 429')
  })
})
