/**
 * 给 `globalThis.fetch` 套一层：记录「发了什么请求」，再决定「回什么响应」。
 *
 * ## 为什么需要它，而不是直接用 `fakeLLM`
 *
 * `fakeLLM` 起的是真端点，但它固定回 200、且没有任何办法设响应头。而这一批里有一类断言
 * 只能从**响应头与状态码**上看出来：
 *
 *   - `x-request-id` 有没有挂到 `LlmError.requestId` 与错误文案上（端点 500 时才看得见）；
 *   - 非 2xx 的 429 之后重不重试、重试几次、退避多久；
 *   - 同一逻辑调用重试时 `x-opencode-session` 的值有没有变（网关按它做路由）；
 *   - 建连超时是不是按配置值提前掐断（端点永不回应）。
 *
 * `tests/harness.ts` 在这个批次的禁改名单里，所以缺口只能在这边补。
 *
 * ## 边界：这里不造 SSE
 *
 * 成功路径的 SSE 一律**转发给 `fakeLLM`**（`forwardTo`），由 harness 那唯一一份实现发出。
 * 本装饰器只做三件事：记录请求、往转发回来的响应上补头、或整体短路成一个不带流体的响应
 * （纯 JSON 的 4xx/5xx、永不 resolve 的 promise）。谁在这里拼 `data:` 分片，就是把手写假
 * 服务换个马甲搬回来了。
 *
 * ## 为什么 `intercept` 拿得到 `init`
 *
 * 「建连超时」的现场是：端点一个字节都不回，客户端到点 abort。要复刻它，短路函数必须能挂
 * 到 `init.signal` 上——拒得晚一步，被测的就是客户端的超时判定，早一步就测成「立刻失败」。
 *
 * @module dsc/tests/support/fake-fetch
 */
import { vi } from 'vitest'

/** 一次被装饰器看到的物理请求。 */
export interface HttpCall {
  /** 客户端以为自己在请求的 URL（转发前的那一份，断言门控与路径靠它）。 */
  url: string
  /** 请求头，键统一小写（`llm.ts` 自己就写小写，这里只是把别的来源拉齐）。 */
  headers: Record<string, string>
  /** 原始请求体（字符串形式；`streamChat` 发的是 JSON）。 */
  body: string
  /** 原始 `RequestInit`：测超时的用例要从这里拿 `signal`。 */
  init: RequestInit
}

/** 装好之后的把手。 */
export interface FakeFetchHandle {
  /** 按到达顺序记录；下标即物理请求序号（重试会多几条）。 */
  readonly calls: HttpCall[]
  /** 拆掉装饰，恢复真正的 `fetch`。 */
  restore(): void
}

/** 装饰器选项。 */
export interface FakeFetchOptions {
  /**
   * 转发目标，通常是 `fakeLLM` 的 `baseUrl`：路径与查询原样接上，SSE 由它发。
   *
   * 不给就只能短路：每一条请求都必须被 `intercept` 接住，否则当场抛错（不静默回一个
   * 空响应让用例绿着）。
   */
  forwardTo?: string
  /**
   * 先过它：返回 `Response` 就短路（可以是 promise，也可以 reject——「建连被拒/被 abort」
   * 就是 reject）；返回 `undefined` 表示放行到 `forwardTo`。
   */
  intercept?: (call: HttpCall, index: number) => Response | Promise<Response> | undefined
  /**
   * 给「转发回来的响应」补头。短路响应不经过它——短路就是调用方要的最终状态，
   * 再补头只会让「这条 500 到底带没带 request-id」这件事变得不可读。
   */
  responseHeaders?: (call: HttpCall, index: number) => Record<string, string> | undefined
}

/**
 * 把请求头的任何写法拉平成小写键的对象（断言里直接下标读）。
 *
 * 参数收 `unknown` 而不是 `HeadersInit`：根 `tsconfig.spec.json` 是 node 环境、没装 DOM 库，
 * `HeadersInit` 这个类型名在那里不存在（`Headers` / `Response` 由 `@types/node` 提供）。
 */
function headerRecord(headers: unknown): Record<string, string> {
  if (headers === undefined || headers === null) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers)
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [String(key).toLowerCase(), String(value)]))
  return Object.fromEntries(Object.entries(headers as Record<string, unknown>).map(([key, value]) => [key.toLowerCase(), String(value)]))
}

/** 请求体：`streamChat` 发字符串；别的形态按空串记（不抛，断言里看得到 `''`）。 */
function bodyText(body: unknown): string {
  return typeof body === 'string' ? body : ''
}

/** 把路径接到转发目标上：目标自带路径前缀时也不会把请求路径吃掉。 */
function forwardUrl(forwardTo: string, url: string): string {
  const parsed = new URL(url)
  return `${forwardTo.replace(/\/$/, '')}${parsed.pathname}${parsed.search}`
}

/**
 * 装上装饰，返回记录与拆装把手。
 *
 * 失败模式一律当场抛（找不到转发目标、转发目标不是 http(s)）：静默降级在这里等价于
 * 「让一条本该红的用例变绿」。
 */
export function installFakeFetch(options: FakeFetchOptions): FakeFetchHandle {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('installFakeFetch：options 必须是对象')
  }
  if (options.forwardTo !== undefined && !/^https?:\/\//.test(options.forwardTo)) {
    throw new TypeError(`installFakeFetch：forwardTo 必须是 http(s):// 地址（收到 ${JSON.stringify(options.forwardTo)}）`)
  }
  if (options.intercept !== undefined && typeof options.intercept !== 'function') {
    throw new TypeError('installFakeFetch：intercept 必须是函数')
  }
  if (options.responseHeaders !== undefined && typeof options.responseHeaders !== 'function') {
    throw new TypeError('installFakeFetch：responseHeaders 必须是函数')
  }
  // 先抓住真正的 fetch：后面所有转发都走它，避免装完之后自己调自己。
  const realFetch = globalThis.fetch.bind(globalThis)
  const calls: HttpCall[] = []

  const decorated = async (input: string | URL | { url: string }, init?: RequestInit): Promise<Response> => {
    const request = init ?? {}
    const call: HttpCall = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      headers: headerRecord(request.headers),
      body: bodyText(request.body),
      init: request,
    }
    const index = calls.length
    calls.push(call)

    const short = options.intercept?.(call, index)
    if (short !== undefined) return await short
    if (options.forwardTo === undefined) {
      throw new Error(`installFakeFetch：第 ${index + 1} 条请求没有被 intercept 接住，也没有 forwardTo（${call.url}）`)
    }

    const response = await realFetch(forwardUrl(options.forwardTo, call.url), request)
    const extra = options.responseHeaders?.(call, index)
    if (extra === undefined) return response
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(extra)) headers.set(key, value)
    // 重建一个 Response 而不是改原对象：`Response.headers` 在某些实现里是只读的守卫，
    // 而且 `streamChat` 读的是 `response.body`，包一层不会把流读坏（服务端是内存里的假端点）。
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }

  vi.stubGlobal('fetch', decorated)
  let restored = false
  return {
    calls,
    restore(): void {
      // 幂等：`afterEach` 与 `afterAll` 同时拆是常见写法。
      if (restored) return
      restored = true
      vi.unstubAllGlobals()
    },
  }
}
