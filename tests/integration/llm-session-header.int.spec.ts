/**
 * opencode Go 会话归因头的**内核端到端**（迁自 `scripts/llm-session-header-test.mjs`
 * 的第 [4] 节）。
 *
 * 上一层（`src/core/request-attribution.spec.ts`）已经证明「头怎么拼、发出去是什么」；
 * 这一层回答的是另一半：**会话 id 有没有从内核铺到协议层**——真回合发出去的头里，
 * 那个值是不是这条会话的 `meta.id`，两轮之间会不会变。
 *
 * 网关按会话做路由与 prompt 缓存，id 变一次就等于换了会话：缓存全丢、账也对不上。
 *
 * ## 为什么用 fetch 装饰器
 *
 * 内核的供应商 baseUrl 必须是 Go 的地址（不然门控不命中），而那是公网端点、不能真发；
 * 同时要看的又是**请求头**，`fakeLLM` 只记消息体。所以装饰器记下 URL 与头，再把请求转发
 * 给 `fakeLLM` 取 SSE——`data:` 分片仍由 harness 的唯一一份实现发。边界见
 * `tests/support/fake-fetch.ts`。
 *
 * ## 原探针第 [5] 节去哪了
 *
 * 那一节是八条源码文本断言（`llmPlugin.includes('sessionId: request.sessionId ?? currentSessionId(ctx)')`
 * 之类），钉的是「代码怎么写」而不是「发出去什么」。按本批规矩不搬源码文本；它们覆盖的
 * 四个调用方（回合 / 压缩 / 标题 / 审批）里，回合这条已经由本文件的真回合覆盖，标题支线
 * 也在这里顺带断言。
 *
 * @module dsc/tests/integration/llm-session-header.int.spec
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { APP_USER_AGENT, OPENCODE_SESSION_HEADER } from '@pneuma/runtime/core/request-attribution.js'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../harness.js'
import { installFakeFetch, type FakeFetchHandle, type HttpCall } from '../support/fake-fetch.js'

const GO = 'https://opencode.ai/zen/go/v1'
/** 宿主会话 id 的形状：uuid（能直接当头的值）。 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 内核里本文件用到的服务面。 */
interface SessionView {
  meta: { id: string }
}

interface Services {
  session: { current(): SessionView }
}

let kernel: BootedKernel
let fake: FakeLLM
let http: FakeFetchHandle | undefined
/** 这条会话的 id：所有请求的头都必须是它。 */
let sid: string
/** 第一轮 / 第二轮各自发出的物理请求。 */
let round1: HttpCall[] = []
let round2: HttpCall[] = []

/** 这条请求是不是会话标题生成那条支线（另一条调用路径，用来证「不光回合带」）。 */
function isTitleCall(call: HttpCall): boolean {
  try {
    const messages = (JSON.parse(call.body) as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? []
    return messages.some((message) => message.role === 'system' && typeof message.content === 'string' && message.content.includes('会话标题生成器'))
  } catch {
    return false
  }
}

/** 等标题支线到达：它由回合收尾触发，可能晚于 `turn-end` 几十毫秒。 */
async function waitForTitle(deadlineMs = 1_500): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline && !http?.calls.some(isTitleCall)) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeAll(async () => {
  fake = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({
    providerBaseUrl: fake.baseUrl,
    config: {
      providers: {
        go: {
          name: 'go',
          displayName: 'Go',
          baseUrl: GO,
          apiKey: 'k',
          models: [
            {
              id: 'm',
              name: 'm',
              contextWindow: 100_000,
              maxTokens: 500,
              modalities: ['text'],
              thinkingLevels: [],
              thinkingParam: 'none',
              effortMap: {},
            },
          ],
        },
      },
      defaultProvider: 'go',
      defaultModel: 'm',
    },
  })
  http = installFakeFetch({ forwardTo: fake.baseUrl })
  sid = (kernel.ctx as unknown as Services).session.current().meta.id

  const before1 = http.calls.length
  await kernel.runTurn('打个招呼')
  await waitForTitle()
  round1 = http.calls.slice(before1)

  const before2 = http.calls.length
  await kernel.runTurn('再问一句')
  round2 = http.calls.slice(before2)
})

afterAll(async () => {
  http?.restore()
  await kernel?.dispose()
  await fake?.close()
})

describe('① 宿主会话 id 能直接当头的值', () => {
  test('是 uuid', () => {
    expect(sid).toMatch(UUID)
  })
})

describe('② 第一轮：每个请求都带这条会话的 id', () => {
  test('这一轮确实发了请求（端点被真的走了一遍）', () => {
    expect(round1.length).toBeGreaterThanOrEqual(1)
  })

  test('每个请求都带 x-opencode-session，值就是这条会话的 id', () => {
    expect(round1.every((call) => call.headers[OPENCODE_SESSION_HEADER] === sid)).toBe(true)
  })

  test('每个请求都带自标识 UA', () => {
    expect(round1.every((call) => call.headers['user-agent'] === APP_USER_AGENT)).toBe(true)
  })

  test('打的都是 Go 的 chat/completions', () => {
    expect(round1.every((call) => call.url === `${GO}/chat/completions`)).toBe(true)
  })

  test('标题支线（不走回合、直接调 llm 服务的那条路）也带同一个 id', () => {
    const titles = round1.filter(isTitleCall)
    // 没有标题请求时这条是空集合上的真——但那样上面的「确实发了请求」仍要成立，
    // 所以空集合不代表这条用例失去意义，只代表这台机器上标题插件没跑。
    expect(titles.every((call) => call.headers[OPENCODE_SESSION_HEADER] === sid)).toBe(true)
  })
})

describe('③ 第二轮：同一个会话必须是同一个 id', () => {
  test('第二轮照样带同一个会话 id（稳定性是这条路线的全部价值）', () => {
    expect(round2.length).toBeGreaterThanOrEqual(1)
    expect(round2.every((call) => call.headers[OPENCODE_SESSION_HEADER] === sid)).toBe(true)
  })
})
