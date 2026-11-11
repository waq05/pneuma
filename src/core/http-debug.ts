/**
 * 从 HTTP 响应头里捞出「能拿去问服务端」的追踪号。
 *
 * **为什么值得单独一个文件**：`request-id` 这类头每家叫法不一样（OpenAI 用
 * `x-request-id`、Cloudflare 前面挂一层会有 `cf-ray`、AWS 系是 `x-amzn-requestid`），
 * 而取值、规整、拼进错误文案这套逻辑要能被测试直接调——埋在 fetch 的 catch 里
 * 就只能靠真发请求来验。
 *
 * 用途只有一个：用户报「接口一直 500」时，让他把这句话原样贴过来，服务端就能按这个号
 * 找到那一次请求。**不参与重试判断，也不改变请求体。**
 *
 * @module dsc/core/http-debug
 */

/** 一家端点可能给的追踪号。`requestId` 用来对服务端日志，`cfRay` 用来对 CDN。 */
export interface HttpDebugContext {
  requestId?: string
  cfRay?: string
}

/**
 * 各家的 `request-id` 头名，按可信度排序。
 *
 * 只认这几家：没见过的头不猜，免得把 `x-trace-id` 这类内部链路号误当成对账凭据。
 */
const REQUEST_ID_HEADERS = ['x-request-id', 'x-openai-request-id', 'request-id', 'x-amzn-requestid'] as const

/** 追踪号的长度上限：正常 20–40 字符，超过这个数的一律当异常值丢掉。 */
const MAX_ID_LENGTH = 128

/** 只留可见 ASCII：头里混进换行会把日志切成两行，也会让「贴给客服」变成注入点。 */
function sanitize(raw: string | null): string | undefined {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > MAX_ID_LENGTH) return undefined
  return /^[A-Za-z0-9._:\-]+$/.test(trimmed) ? trimmed : undefined
}

/**
 * 只依赖 `get()` 的最小头读取面。
 *
 * 不用 `Headers` 类型当参数，是因为 `new Headers({...})` 会**当场拒绝**带换行的值，
 * 而「带换行的号要丢掉」恰恰是这里必须测的一条——传 `Headers` 就测不到它。
 * 真实的 `response.headers` 天然满足这个接口。
 */
export interface HeaderReader {
  get(name: string): string | null
}

/**
 * 读出一副响应头里的追踪号。
 *
 * @param headers 响应头（`fetch` 的 `response.headers`）。
 * @returns 一个都没有时返回 `undefined`——调用方据此决定「不提」而不是「提个空」。
 */
export function requestDebugContext(headers: HeaderReader): HttpDebugContext | undefined {
  let requestId: string | undefined
  for (const name of REQUEST_ID_HEADERS) {
    requestId = sanitize(headers.get(name))
    if (requestId !== undefined) break
  }
  const cfRay = sanitize(headers.get('cf-ray'))
  if (requestId === undefined && cfRay === undefined) return undefined
  return { ...(requestId === undefined ? {} : { requestId }), ...(cfRay === undefined ? {} : { cfRay }) }
}

/**
 * 拼进错误文案的尾巴。
 *
 * 形如 `（request-id: 6f1c…）`，没有号时返回空串——错误文案不该出现「request-id: 空」。
 *
 * @param debug {@link requestDebugContext} 的结果。
 */
export function formatRequestDebug(debug: HttpDebugContext | undefined): string {
  if (debug === undefined) return ''
  const parts: string[] = []
  if (debug.requestId !== undefined) parts.push(`request-id ${debug.requestId}`)
  if (debug.cfRay !== undefined) parts.push(`cf-ray ${debug.cfRay}`)
  return parts.length === 0 ? '' : `（${parts.join('，')}）`
}
