/**
 * 请求追踪号落进会话日志（迁自 `scripts/llm-request-note-test.mjs`）。
 *
 * 与 `src/core/llm-request-id.spec.ts` 的分工：那条验「解析头、挂到错误、回调」；这条验
 * 「llm 插件在 `stream()` 这个汇聚点真的把号写进了会话的 note 记录」——也就是用户事后按
 * 会话回查某次请求时，日志里能不能找到那一行。
 *
 * ## 为什么用 fetch 装饰器
 *
 * 要让 note 有内容，端点必须回一个 `x-request-id`；`fakeLLM` 不能设响应头，而
 * `tests/harness.ts` 在本批禁改名单里。所以 SSE 仍由 `fakeLLM` 发，装饰器只做一件事：
 * 在转发回来的响应上加那个头。边界见 `tests/support/fake-fetch.ts`。
 *
 * ## 为什么是 integration 而不是 unit
 *
 * 被测的是插件在 `ctx.session.current().appendNote` 上留的那一行：要真内核、真会话、
 * 真落盘，才能回答「日志里到底有没有它」。`llm.stream()` 是界面之外所有调用方的汇聚点
 * （回合、压缩、标题、审批都从这里过）。
 *
 * @module dsc/tests/integration/llm-request-note.int.spec
 */
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { OPENAI_COMPLETIONS_API } from '@pneuma/runtime/core/llm.js'
import { bootKernel, fakeLLM, readSessionJsonl, type BootedKernel, type FakeLLM } from '../harness.js'
import { installFakeFetch, type FakeFetchHandle } from '../support/fake-fetch.js'

/** 假端点回给这次请求的追踪号。 */
const REQUEST_ID = 'req_note_42'

/** 内核里本文件用到的服务面。 */
interface SessionView {
  filePath: string
  notes(): Array<{ id: string; text: string }>
  appendUser(text: string): void
}

interface Services {
  session: { current(): SessionView }
  llm: {
    stream(
      api: string,
      route: { baseUrl: string; apiKey: string; model: string; messages: Array<{ role: 'user'; content: string }> },
      handlers: { onDelta(delta: string): void },
    ): Promise<{ text: string }>
  }
}

let kernel: BootedKernel
let fake: FakeLLM
let http: FakeFetchHandle | undefined
let services: Services
/** 请求的返回与它落下的 note（整段场景只跑一遍，用例只读）。 */
let result: { text: string }
let notes: Array<{ id: string; text: string }>
let jsonl: Array<Record<string, unknown>>

beforeAll(async () => {
  fake = await fakeLLM({ turns: ['hi'] })
  kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
  services = kernel.ctx as unknown as Services
  http = installFakeFetch({ forwardTo: fake.baseUrl, responseHeaders: () => ({ 'x-request-id': REQUEST_ID }) })
  // 先落一条用户消息：真实现场里 note 总是长在一份有内容的会话上；同时确保日志文件
  // 真的被建出来（下面的断言读的是磁盘）。
  services.session.current().appendUser('hi')

  result = await services.llm.stream(
    OPENAI_COMPLETIONS_API,
    {
      baseUrl: fake.baseUrl,
      apiKey: 'probe-key',
      model: 'probe-model',
      messages: [{ role: 'user', content: 'hi' }],
    },
    { onDelta() {} },
  )
  notes = services.session.current().notes()

  // 写盘是流式的：等那条 note 真的刷进文件再读，否则「落进了 jsonl」会随机假红。
  const deadline = Date.now() + 3_000
  for (;;) {
    const file = services.session.current().filePath
    jsonl = existsSync(file) ? readSessionJsonl(file) : []
    if (jsonl.some((record) => record.type === 'note' && String(record.text ?? '').includes(REQUEST_ID))) break
    if (Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
})

afterAll(async () => {
  http?.restore()
  await kernel?.dispose()
  await fake?.close()
})

describe('① 请求本身成功', () => {
  test('流式正文照常解析', () => {
    expect(result.text).toBe('hi')
  })
})

describe('② 会话里留了一条追踪号', () => {
  test('至少有一条 note，id 是 llm/request-id，正文带着追踪号', () => {
    expect(notes.length).toBeGreaterThanOrEqual(1)
    expect(notes.some((note) => note.id === 'llm/request-id')).toBe(true)
    expect(notes.some((note) => String(note.text).includes(REQUEST_ID))).toBe(true)
  })
})

describe('③ 落进了会话 jsonl', () => {
  test('日志里有 type=note 且带着追踪号的记录', () => {
    const noteRecords = jsonl.filter((record) => record.type === 'note')
    expect(noteRecords.some((record) => String(record.text ?? '').includes(REQUEST_ID))).toBe(true)
    expect(noteRecords.some((record) => record.id === 'llm/request-id')).toBe(true)
  })
})
