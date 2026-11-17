/**
 * 网页抓取的传输层：校验地址、跟同源重定向、按字节封顶读响应、按 charset 解码。
 *
 * 这一段**不碰界面、不碰工具注册**，只回答「这个 URL 抓回来是什么」。分出来是为了能单独
 * 跑真代码（`tests/web-fetch.test.mjs` 直接载入本模块，用假 fetch 顶掉网络）。
 *
 * 对照的是 dsh 的 `packages/web/web-fetch-http/src/policy.ts` 与 `provider.ts`：地址规则
 * （只许 http/https、不许带账号密码、长度上限 2048）、同源重定向、字节上限、30 秒超时、
 * 只解 `text/*` 与少数结构化文本类型——两边口径一致，模型换宿主不用重新学。
 *
 * 为什么请求不带任何凭据：抓的是公开网页。带上 cookie 等于把用户的登录态交给模型手里的
 * 任意 URL，而模型会把外部内容当数据读；两个风险叠起来就是「点开一条链接，账号被读走」。
 *
 * @module dsc/plugins/web-fetch/http
 */

/** 请求 URL 的长度上限（超过基本是拼接攻击的形状，不是正常网页）。 */
export const MAX_URL_LENGTH = 2048

/** 响应体的字节上限：超过就截断，不整份读进内存。 */
export const MAX_RESPONSE_BYTES = 5_000_000

/** 同源重定向最多跟几跳。 */
export const MAX_REDIRECTS = 5

/**
 * `User-Agent`：明确写自己是程序，**不冒充浏览器**。
 *
 * 冒充浏览器能多抓到一两个站点，代价是让别人按浏览器规则发页面（甚至下发反爬脚本），
 * 而我们没有 JS 引擎。少数站点会因此回 403——那是它们的选择，不是我们要骗过的。
 */
export const USER_AGENT = 'pneuma-web-fetch/0.9'

/** 能解出来的正文种类：HTML 走转换，纯文本原样给。 */
export type FetchableKind = 'html' | 'text'

/** 一次抓取的结果。 */
export interface FetchedPage {
  /** 跟随重定向之后的最终地址。 */
  url: string
  /** 最终响应的状态码（404 也算抓到了：正文就是那张错误页，模型自己判断）。 */
  statusCode: number
  /** 正文种类。 */
  kind: FetchableKind
  /** 解码后的正文（可能已被字节或字数上限截断）。 */
  content: string
  /** 正文是不是被上限截断过。 */
  truncated: boolean
}

/** 抓取时用到的限额（来自插件设置）。 */
export interface FetchLimits {
  /** 整次抓取的超时预算（毫秒）。 */
  timeoutMs: number
  /** 解出来的正文字数上限。 */
  maxBodyChars: number
}

/**
 * 解析并校验一个待抓地址。
 *
 * 三条限制各自挡一件事：不是 http(s) 的协议（`file:` / `javascript:`）会把本机文件或别的东西
 * 拉进来；URL 里带账号密码等于把凭据塞进请求；超长 URL 是拼接攻击的典型形状。
 *
 * @param input 模型给的原始字符串
 * @returns 解析好的 URL
 */
export function parseFetchUrl(input: string): URL {
  if (input.trim() === '') throw new Error('url 不能为空')
  if (input.length > MAX_URL_LENGTH) {
    throw new Error(`地址太长（${input.length} 字，上限 ${MAX_URL_LENGTH}）：只给真正要抓的那个页面地址`)
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(`这不是一个合法地址：${input}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只支持 http 与 https 地址，不支持 ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('地址里带账号密码，不允许：本工具不发送任何凭据，把凭据去掉再抓')
  }
  return url
}

/**
 * 两个地址是不是同一个源（协议 + 主机 + 端口都相同）。
 *
 * 跨源重定向不自动跟：跟过去等于替模型访问了它没要求的那个域，而那个域可能是内网地址。
 * 拒绝时把目标地址告诉模型，它想抓可以直接再来一次——选择权留在它手上，风险留在明面上。
 */
export function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

/**
 * 把响应的 `Content-Type` 归成两档。
 *
 * @param contentType 原始头（可能带 charset），没有就是 null
 * @returns 能解的档位；解不了（图片、PDF、压缩包）返回 undefined
 */
export function classifyContentType(contentType: string | null): FetchableKind | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml') return 'text'
  if (mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

/** 取 `Content-Type` 里的 charset 参数（小写），没有就 undefined。 */
export function parseCharset(contentType: string | null): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')
  return match?.[1]?.trim().toLowerCase()
}

/**
 * 按声明的 charset 解码；不认识这个标签就退回 UTF-8。
 *
 * 为什么不用 `fatal` 解码器：真实网页的编码声明经常是错的（声明 utf-8 实际 GBK、或者干脆没
 * 声明），一次解码失败就整页作废，代价远大于页尾几个乱码。所以这里一律宽容解码。
 *
 * @param bytes 响应体原始字节（可能被字节上限截断，尾部是半个多字节字符）
 * @param contentType 原始 `Content-Type`
 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const charset = parseCharset(contentType)
  // 不写类型标注：`TextDecoder` 在这里只有值、没有可直接用的类型名（本仓不装 DOM 类型）。
  let decoder: InstanceType<typeof TextDecoder>
  try {
    decoder = new TextDecoder(charset ?? 'utf-8')
  } catch {
    decoder = new TextDecoder('utf-8')
  }
  return decoder.decode(bytes)
}

/** 正文像不像 HTML（只在服务器没给 `Content-Type` 时用它兜底认）。 */
function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 512)).trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html')
}

/** 301/302 这类「带 Location 的重定向」。 */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/**
 * 读响应体，最多读 `maxBytes`。
 *
 * `Content-Length` 超过上限就当场拒绝（不读、不占内存）；服务器谎报或流式吐数据时读够就停，
 * 并把 `truncatedByBytes` 置真。**只有丢掉的字节才算截断**：正好填满上限的那种不算。
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel()
      throw new Error(`这个页面太大了（约 ${Math.round(length / 1024 / 1024)} MB）：换一个更具体的页面或章节`)
    }
  }
  if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }

  const chunks: Uint8Array[] = []
  let total = 0
  let truncatedByBytes = false
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = maxBytes - total
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining))
        total += remaining
        truncatedByBytes = true
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    // 读到上限后再 cancel 是收尾动作：已经拿到的字节不受影响，失败也不必上报。
    await reader.cancel().catch(() => {})
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncatedByBytes }
}

/**
 * 抓一个地址：校验 → 跟同源重定向 → 读字节 → 解码 → 截到字数上限。
 *
 * 非 2xx 不抛错：404 的正文往往正是「这页没了」这句话，把它交给模型比我猜一句更有用
 * （与 dsh 同一取舍）。
 *
 * @param input 模型给的地址
 * @param limits 超时与字数上限
 * @param signal 回合取消信号
 */
export async function fetchPage(input: string, limits: FetchLimits, signal: AbortSignal): Promise<FetchedPage> {
  const deadline = Date.now() + limits.timeoutMs
  let currentUrl = parseFetchUrl(input)
  let redirects = 0

  for (;;) {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    if (signal.aborted) controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), Math.max(deadline - Date.now(), 1))

    try {
      let response: Response
      try {
        response = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
          },
          signal: controller.signal,
        })
      } catch (error) {
        if (signal.aborted) throw new Error('这次抓取被取消了')
        if (controller.signal.aborted) {
          throw new Error(`抓取超时（超过 ${Math.round(limits.timeoutMs / 1000)} 秒）：站点可能很慢或连不上，换个地址再试`)
        }
        throw new Error(`连不上 ${currentUrl.toString()}：${error instanceof Error ? error.message : String(error)}`)
      }

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (location === null) throw new Error(`服务器回了 ${response.status} 重定向，却没给目标地址`)
        if (redirects >= MAX_REDIRECTS) {
          throw new Error(`重定向超过 ${MAX_REDIRECTS} 跳，停下了：直接抓最后那个地址`)
        }
        const target = parseFetchUrl(new URL(location, currentUrl).toString())
        if (!isSameOrigin(target, currentUrl)) {
          throw new Error(`这个地址被重定向到了 ${target.toString()}（跨域，不自动跟随）：直接抓那个地址`)
        }
        currentUrl = target
        redirects += 1
        continue
      }

      const contentType = response.headers.get('content-type')
      const { bytes, truncatedByBytes } = await readCapped(response, MAX_RESPONSE_BYTES)
      // 服务器没声明类型时按内容认（有些静态服务器漏发这个头）；声明了就是声明了，不猜。
      const declared = classifyContentType(contentType)
      const kind = declared ?? (looksLikeHtml(bytes) ? 'html' : undefined)
      if (kind === undefined) {
        // 既没给出能解的类型、内容也不像 HTML：多半是图片 / PDF 这类二进制，硬转只会给一屏乱码。
        throw new Error(`这个地址返回的是 ${contentType ?? '未声明类型的内容'}，不是能读的网页或文本（PDF、图片、压缩包都不支持）`)
      }
      const decoded = decodeBody(bytes, contentType)
      const truncatedByChars = decoded.length > limits.maxBodyChars
      return {
        url: currentUrl.toString(),
        statusCode: response.status,
        kind,
        content: truncatedByChars ? decoded.slice(0, limits.maxBodyChars) : decoded,
        truncated: truncatedByBytes || truncatedByChars,
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }
}
