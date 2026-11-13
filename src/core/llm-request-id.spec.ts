/**
 * 请求追踪号（`x-request-id`）的解析与挂载（迁自 `scripts/llm-request-id-test.mjs`）。
 *
 * 钉三件事：失败时号挂到 `LlmError.requestId` 与错误文案上、成功时走 `onRequestDebug`、
 * 端点不给号时不许硬凑一个。
 *
 * ## 为什么用 fetch 装饰器 + `fakeLLM`，而不是原探针的本地 http 服务
 *
 * 原探针「为什么不用假的 fetch」的理由是：值就在真实的 `Headers` 里。但这批的手工约束是
 * 成功路径的 SSE 必须来自 harness —— 所以这里拆成两半：
 *
 *   - 500 / 400 两条**不带流体**（纯 JSON），由 `installFakeFetch` 短路；
 *   - 成功那条转发给 `fakeLLM`，只在响应上加一个 `x-request-id` 头。
 *
 * 装饰器的边界见 `tests/support/fake-fetch.ts`：它不拼任何 `data:` 分片。`fakeLLM` 固定回
 * 200 且没有响应头入参，所以「状态码与响应头」这两个接缝只能靠这层补——这是 harness 的
 * 真实缺口，不是这里图省事。
 *
 * @module dsc/core/llm-request-id.spec
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { fakeLLM, type FakeLLM } from '../../tests/harness.js'
import { installFakeFetch, type FakeFetchHandle } from '../../tests/support/fake-fetch.js'
import type { HttpDebugContext } from './http-debug.js'
import { LlmError, streamChat } from './llm.js'

let fake: FakeLLM
let http: FakeFetchHandle | undefined
/** 请求的重试预算：重试会把「500 该红」拖成十几秒，这里只要第一次的结果。 */
const ORIGINAL_ATTEMPTS = process.env['DSC_LLM_RETRY_ATTEMPTS']

beforeAll(async () => {
  process.env['DSC_LLM_RETRY_ATTEMPTS'] = '1'
  fake = await fakeLLM({ turns: ['hi'] })
})

afterEach(() => {
  http?.restore()
  http = undefined
})

afterAll(async () => {
  if (ORIGINAL_ATTEMPTS === undefined) delete process.env['DSC_LLM_RETRY_ATTEMPTS']
  else process.env['DSC_LLM_RETRY_ATTEMPTS'] = ORIGINAL_ATTEMPTS
  await fake.close()
})

/** 发一次请求并把错误捞出来（成功时返回 undefined）。 */
async function catchError(
  baseUrl: string,
  handlers: Parameters<typeof streamChat>[1] = { onDelta() {} },
): Promise<unknown> {
  try {
    await streamChat({ baseUrl, apiKey: 'probe-key', model: 'probe', messages: [] }, handlers)
    return undefined
  } catch (error) {
    return error
  }
}

describe('① 端点回 500 且带 x-request-id', () => {
  /** 这一节共用的现场：一次 500，外加记下 onRequestDebug 收到的内容。 */
  let error: unknown
  let failedDebug: HttpDebugContext | undefined

  beforeAll(async () => {
    http = installFakeFetch({
      intercept: () =>
        new Response('{"error":"boom"}', {
          status: 500,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req_probe_500' },
        }),
    })
    error = await catchError('https://example.invalid/v1', {
      onDelta() {},
      onRequestDebug: (debug) => {
        failedDebug = debug
      },
    })
  })

  test('500 会抛错，状态码是 500', () => {
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).status).toBe(500)
  })

  test('requestId 挂到了错误对象上', () => {
    expect((error as LlmError).requestId).toBe('req_probe_500')
  })

  test('文案里带得上追踪号（用户能直接把这一串贴给服务端）', () => {
    expect(String((error as Error).message)).toContain('（request-id req_probe_500）')
  })

  test('失败时也回调 onRequestDebug', () => {
    expect(failedDebug?.requestId).toBe('req_probe_500')
  })
})

describe('② 成功响应也带追踪号', () => {
  test('onRequestDebug 收到号，正文照常解析', async () => {
    let okDebug: HttpDebugContext | undefined
    http = installFakeFetch({
      forwardTo: fake.baseUrl,
      responseHeaders: () => ({ 'x-request-id': 'req_ok_1' }),
    })
    const result = await streamChat(
      { baseUrl: 'https://example.invalid/v1', apiKey: 'probe-key', model: 'probe', messages: [] },
      {
        onDelta() {},
        onRequestDebug: (debug) => {
          okDebug = debug
        },
      },
    )
    expect(okDebug?.requestId).toBe('req_ok_1')
    expect(result.text).toBe('hi')
  })
})

describe('③ 端点不给号时不硬凑', () => {
  test('requestId 是 undefined，文案里不出现 request-id', async () => {
    http = installFakeFetch({
      intercept: () => new Response('{"error":"bad"}', { status: 400, headers: { 'content-type': 'application/json' } }),
    })
    const bare = (await catchError('https://example.invalid/v1')) as LlmError
    expect(bare).toBeInstanceOf(LlmError)
    expect(bare.requestId).toBeUndefined()
    // 没有号却写「request-id」会让用户去服务端找一串根本不存在的东西。
    expect(String(bare.message)).not.toContain('request-id')
  })
})
