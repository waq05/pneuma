/**
 * `core/llm.ts` 的 wire 层补测（W14）：SSE 分片解析、工具调用增量、断流的两种收尾，
 * 以及 `Retry-After` 的三种写法。
 *
 * 用 `tests/support/fake-fetch.ts` 把 `globalThis.fetch` 换成可编程的替身：每个用例自己
 * 造一段 SSE 字节流，想看哪条分支就发哪一段——真端点替不出「流到一半断掉」「回包不是
 * JSON」这类现场。
 *
 * 覆盖的明细行：274（孤儿工具调用但有正文时保留消息）、627（onSanitize 回调）、
 * 641（tools 进请求体）、679（非 LlmError 的建连失败归一）、741（坏 JSON 分片跳过）、
 * 746-747（思考增量）、754（工具调用增量）、777-779（半截流打包成 StreamInterruptedError）、
 * 786-787（用户取消且已有半截正文）、908-912（Retry-After：秒数 / HTTP 日期 / 认不出）、
 * 962-963（退避期间被取消）。
 *
 * @module dsc/core/w14-llm-wire.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
import { installFakeFetch, type FakeFetchHandle } from '../../tests/support/fake-fetch.js'
import { LlmError, StreamInterruptedError, streamChat } from './llm.js'
import type { ChatMessage, StreamHandlers } from './llm.js'

const encoder = new TextEncoder()

/** 装好一个「照这个函数回包」的 fetch 替身，用例结束后自动拆。 */
function withFetch(intercept: Parameters<typeof installFakeFetch>[0]['intercept']): FakeFetchHandle {
  const handle = installFakeFetch({ intercept })
  handles.push(handle)
  return handle
}

const handles: FakeFetchHandle[] = []
afterEach(() => {
  while (handles.length > 0) handles.pop()?.restore()
})

/** SSE 分片 → `Response`（每片自带 `\n\n` 分隔符）。 */
function sse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift()
      if (next === undefined) controller.close()
      else controller.enqueue(encoder.encode(next))
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** 一条 `data:` 行（带空行分隔）。 */
function dataLine(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
}

/** 最小请求体。 */
function request(extra: Partial<Parameters<typeof streamChat>[0]> = {}): Parameters<typeof streamChat>[0] {
  return {
    baseUrl: 'https://llm.example.invalid/v1',
    apiKey: 'k',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  }
}

/** 只收增量的处理器（其余回调按需补）。 */
function handlers(extra: Partial<StreamHandlers> = {}): StreamHandlers {
  return { onDelta: () => undefined, ...extra }
}

/** 临时改一个环境变量跑一段，跑完还原。 */
async function withEnv(name: string, value: string, run: () => Promise<void>): Promise<void> {
  const original = process.env[name]
  process.env[name] = value
  try {
    await run()
  } finally {
    if (original === undefined) delete process.env[name]
    else process.env[name] = original
  }
}

describe('SSE 分片：思考 / 正文 / 工具调用 / 坏 JSON', () => {
  test('四种分片各归各的；坏 JSON 那一片被跳过而不是整条请求失败', async () => {
    withFetch(() =>
      sse([
        dataLine({ choices: [{ delta: { reasoning_content: '先想想' } }] }),
        dataLine({ choices: [{ delta: { content: '答案' } }] }),
        dataLine('不是 JSON'),
        dataLine({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-1',
                    function: { name: 'read', arguments: '{"path":' },
                  },
                  { index: 0, function: { arguments: '"a.txt"}' } },
                ],
              },
            },
          ],
        }),
        dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        dataLine('[DONE]'),
      ]),
    )
    const deltas: string[] = []
    const result = await streamChat(request(), handlers({ onDelta: (kind, text) => deltas.push(`${kind}:${text}`) }))
    expect(result.reasoning).toBe('先想想')
    expect(result.text).toBe('答案')
    expect(result.finishReason).toBe('tool_calls')
    // 同一个 index 的两片参数被累加成一条完整调用。
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]).toMatchObject({
      id: 'call-1',
      name: 'read',
      arguments: '{"path":"a.txt"}',
    })
    expect(deltas).toEqual(['reasoning:先想想', 'text:答案'])
  })
})

describe('工具孤儿清洗：回调 + 请求体里的 tools', () => {
  test('剔掉孤儿调用后报 onSanitize；有正文的 assistant 保留但不带 tool_calls；tools 进 body', async () => {
    const handle = withFetch(() => sse([dataLine('[DONE]')]))
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      // 有正文、有工具调用但没有配对的 tool 结果：调用被剔掉，正文留下（明细 274）。
      {
        role: 'assistant',
        content: '我打算读文件',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read', arguments: '{}' },
          },
        ],
      },
    ]
    const reports: { droppedCalls: number; droppedResults: number }[] = []
    await streamChat(
      request({
        messages,
        tools: [
          {
            name: 'read',
            description: '读文件',
            parameters: { type: 'object', properties: {} },
          },
        ],
      }),
      handlers({
        onSanitize: (report) => {
          reports.push({
            droppedCalls: report.droppedCalls,
            droppedResults: report.droppedResults,
          })
        },
      }),
    )
    expect(reports).toHaveLength(1)
    expect(reports[0]?.droppedCalls).toBe(1)
    // 请求体里带上了工具声明（明细 641）。
    const body = JSON.parse(handle.calls[0]!.body) as { tools?: unknown[] }
    expect(body.tools).toHaveLength(1)
  })
})

describe('建连失败：不是 LlmError 的异常也归一成可重试的连接失败', () => {
  test('fetch 直接拒绝：报「连接失败」并标 retryable', async () => {
    withFetch(() => Promise.reject(new TypeError('fetch failed')))
    await withEnv('DSC_LLM_RETRY_ATTEMPTS', '1', async () => {
      const error = await streamChat(request(), handlers()).catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(LlmError)
      if (error instanceof LlmError) {
        expect(error.message).toContain('连接失败')
        expect(error.message).toContain('fetch failed')
        expect(error.retryable).toBe(true)
      }
    })
  })
})

describe('断流收尾', () => {
  test('已经收到半截内容：打包成 StreamInterruptedError（工具调用按 index 排好）', async () => {
    withFetch(() => {
      let step = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          step += 1
          if (step === 1) {
            controller.enqueue(
              encoder.encode(
                dataLine({ choices: [{ delta: { content: '半截' } }] }) +
                  dataLine({
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            {
                              index: 1,
                              id: 'b',
                              function: { name: 'second', arguments: '{}' },
                            },
                            {
                              index: 0,
                              id: 'a',
                              function: { name: 'first', arguments: '{}' },
                            },
                          ],
                        },
                      },
                    ],
                  }),
              ),
            )
            return
          }
          controller.error(new Error('对端把连接掐了'))
        },
      })
      return new Response(stream, { status: 200 })
    })
    await withEnv('DSC_LLM_RETRY_ATTEMPTS', '1', async () => {
      const error = await streamChat(request(), handlers()).catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(StreamInterruptedError)
      if (error instanceof StreamInterruptedError) {
        expect(error.message).toContain('流中断')
        expect(error.message).toContain('对端把连接掐了')
      }
    })
  })

  test('用户按了停止且已有半截正文：不抛错，结果标 aborted', async () => {
    const controller = new AbortController()
    withFetch(() => {
      let step = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(streamController) {
          step += 1
          if (step === 1) {
            streamController.enqueue(encoder.encode(dataLine({ choices: [{ delta: { content: '半截' } }] })))
            return
          }
          // 第二次读之前用户点了停止：信号先 abort，再让流报错。
          controller.abort(new Error('用户停止'))
          streamController.error(new Error('aborted'))
        },
      })
      return new Response(stream, { status: 200 })
    })
    const result = await streamChat(request({ signal: controller.signal }), handlers())
    expect(result.finishReason).toBe('aborted')
    expect(result.text).toBe('半截')
  })
})

describe('Retry-After：秒数 / HTTP 日期 / 认不出', () => {
  /** 发一次必失败的 429，把 LlmError 捞出来（attempts=1，不真的等退避）。 */
  async function retryAfterError(value: string): Promise<LlmError> {
    withFetch(
      () =>
        new Response('限流', {
          status: 429,
          headers: { 'retry-after': value },
        }),
    )
    let caught: unknown
    await withEnv('DSC_LLM_RETRY_ATTEMPTS', '1', async () => {
      caught = await streamChat(request(), handlers()).catch((reason: unknown) => reason)
    })
    expect(caught).toBeInstanceOf(LlmError)
    return caught as LlmError
  }

  test('纯秒数：换算成毫秒', async () => {
    expect((await retryAfterError('5')).retryAfterMs).toBe(5_000)
  })

  test('HTTP 日期：解析成毫秒（过去的日期夹到 0）', async () => {
    expect((await retryAfterError('Wed, 21 Oct 2015 07:28:00 GMT')).retryAfterMs).toBe(0)
  })

  test('两种都认不出：不设退避', async () => {
    // 只用 ASCII：HTTP 头里的非 ASCII 值在构造 Response 时就会抛，测不到解析分支。
    expect((await retryAfterError('not-a-date')).retryAfterMs).toBeUndefined()
  })
})

describe('退避期间被取消', () => {
  test('第一次 500 之后点停止：退避的 Promise 用取消原因拒绝，不再重试', async () => {
    const controller = new AbortController()
    withFetch(() => new Response('服务端炸了', { status: 500 }))
    await withEnv('DSC_LLM_RETRY_ATTEMPTS', '3', async () => {
      const error = await streamChat(
        request({ signal: controller.signal }),
        handlers({
          onRetry: () => {
            // 退避的定时器与 abort 监听在 delay() 里同步挂好；用微任务在它们就位之后再取消，
            // 才测得到「等退避的时候被叫停」这条分支（明细 962-963）。
            queueMicrotask(() => controller.abort(new Error('用户停止')))
          },
        }),
      ).catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('用户停止')
    })
  })
})
