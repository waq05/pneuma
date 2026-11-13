/**
 * GitHub REST 的最薄一层：拼路径、带令牌、按 `Link` 翻页，并把 HTTP 状态码放进 `GithubError.code`。
 *
 * 上游用 `gh` 子进程发请求（`infra/commands.ts:68-98`）。DSC 这边不许起子进程，换成 Node 内置
 * `fetch`（仓库既有做法见 `src/packages/web-search/index.ts:84-94`）。换掉的只是「谁去发请求」，
 * 三条边界原样留着：
 *
 * 1. **路径只能落在 `repos/<repository>/` 下**（`commands.ts:94-98`）。令牌能读机器人账号可见的
 *    一切仓库，路径一旦能被 `/` 开头、`scheme:` 或 `..` 改写，别的仓库的数据就能顺着同一个令牌
 *    流出来。翻页跟随 `Link` 时也只认 `api.github.com`：一次伪造的 `Link` 就能把 `Authorization`
 *    头带去别人的服务器，那是令牌泄漏，不是排版问题。
 * 2. **HTTP 状态码进 `GithubError.code`**（上游是 `CliError.code`）。410 永久删除、404 可重试、
 *    304 静默，这三种判定都读这个数字（`sources/github.ts:157-165/216`）；消息文本只给人看。
 * 3. **分页按 `Link` 头的 `rel="next"`**，不按「这一页不满 100 条就完事」猜：列表刚好 100 条时
 *    两种猜法结论相反，猜错就是静默漏页。
 *
 * @module dsc/packages/superagent/adapters/github/api
 */
import type { z } from 'zod'

const API = 'https://api.github.com'

/** 单次请求的上限。GitHub 偶发挂住时，轮询泵不该被一个请求拖到下一拍。 */
const TIMEOUT_MS = 30_000

/** 解析数组元素时统计被跳过的条数（照 `infra/commands.ts:42-48`）。 */
export interface Tally { skipped: number }

/**
 * 按单个 schema 解析数组，坏的跳过并计数。
 *
 * 跳过而不是整页报错：GitHub 会在同一个列表里混进新形状的条目（新的 review 状态、新字段类型），
 * 一条不认识就把整页丢掉，症状是「那一页之后的评论全没了」。
 */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap((value) => {
    const parsed = item.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
  if (tally) tally.skipped += list.length - items.length
  return items
}

/**
 * GitHub 请求失败。
 *
 * `code` 是 HTTP 状态码，网络层失败（连不上、超时）时是 `undefined`——上游 `CliError` 也是这么
 * 分的，`deleted()` 只认 410，所以「没状态码」天然走可重试那一支。
 */
export class GithubError extends Error {
  readonly code: number | undefined

  constructor(message: string, code?: number) {
    super(message)
    this.name = 'GithubError'
    this.code = code
  }
}

/** 一页响应的原文与头。`link` / `etag` / `x-poll-interval` 都从 `headers` 里读，键是小写。 */
export interface GithubPage<T> {
  status: number
  headers: Record<string, string>
  body: T
}

/** `getPage` / `slurp` 的可选参数。 */
export interface GithubPageOptions {
  /** 有值就发 `If-None-Match`；服务端回 304 时以 `GithubError`（`code: 304`）抛出。 */
  etag?: string | undefined
  /** 额外请求头，覆盖默认值。 */
  headers?: Record<string, string> | undefined
}

/**
 * 适配器只需要的四个动作。
 *
 * 不暴露「发任意请求」的入口：能拼 URL 就能绕开仓库边界（第 1 条），边界必须收在实现里，
 * 而不是靠调用方自觉。
 */
export interface GithubApi {
  readonly repository: string
  /** 读一页并解析 JSON。 */
  getPage<T>(path: string, options?: GithubPageOptions): Promise<GithubPage<T>>
  /** 读一页，只要 JSON 体。 */
  get<T>(path: string, options?: GithubPageOptions): Promise<T>
  /**
   * 读完所有页。
   *
   * 数组页拼平成条目（评论、status 这类），对象页逐页返回（check-runs 这类一页一个对象的），
   * 对应上游 `commands.pages` 与 `api(..., '--paginate', '--slurp')` 两种读法
   * （`infra/commands.ts:90-93`、`sources/github-read.ts:62`）。
   */
  slurp<T>(path: string, options?: GithubPageOptions): Promise<T[]>
  /** 发一个 JSON 体的写请求（发评论、回 review 讨论）。 */
  post<T>(path: string, body: unknown): Promise<T>
}

/** `createGithubApi` 的入参。 */
export interface GithubApiOptions {
  /** 机器人账号的令牌；空串表示不带 `Authorization`（离线测试用）。 */
  token: string
  /** `owner/name`；所有路径都会被限制在它下面。 */
  repository: string
  /** 注入的 fetch，默认 `globalThis.fetch`。 */
  fetch?: typeof globalThis.fetch
  /** 一行诊断（例如拒绝了一个站外的翻页地址）。 */
  log?: (line: string) => void
}

/** 把一页响应体收进结果：数组铺开，对象整体留着。 */
function collect(body: unknown, into: unknown[]): void {
  if (Array.isArray(body)) into.push(...body)
  else if (body !== undefined) into.push(body)
}

/** 从 `Link` 头里取 `rel="next"` 的地址（`<https://...>; rel="next"`）。 */
export function nextLink(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"/.exec(part.trim())
    if (match) return match[1]
  }
  return undefined
}

/** 从 GitHub 的错误体里摸出人话；摸不到就用原文前 300 字。 */
function detailOf(text: string): string {
  try {
    const value: unknown = JSON.parse(text)
    if (value !== null && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
      return (value as { message: string }).message
    }
  } catch {
    // 错误体不是 JSON（代理页、HTML 错误页）时退回原文
  }
  return text.trim().slice(0, 300)
}

/**
 * 造一个 GitHub API 客户端。
 *
 * @param options - 令牌、仓库、注入的 fetch 与日志
 * @returns 窄接口；路径越界直接在本地抛错，不会发出请求
 */
export function createGithubApi(options: GithubApiOptions): GithubApi {
  const doFetch = options.fetch ?? ((input: string, init: RequestInit): Promise<Response> => globalThis.fetch(input, init))
  const repository = options.repository
  const log = options.log ?? (() => {})
  const token = options.token.trim()

  /** 路径 → 带仓库前缀的路径；这一句就是「不许碰别的仓库」那条边界。 */
  function scoped(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return path === '' ? `repos/${repository}` : `repos/${repository}/${path}`
  }

  async function fetchPage(url: string, init: {
    method: 'GET' | 'POST'
    etag?: string | undefined
    headers?: Record<string, string> | undefined
    body?: unknown
  }): Promise<GithubPage<unknown>> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'pneuma-superagent',
    }
    if (token !== '') headers.authorization = `Bearer ${token}`
    if (init.etag !== undefined) headers['if-none-match'] = init.etag
    Object.assign(headers, init.headers)
    const body = init.body === undefined ? undefined : JSON.stringify(init.body)
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response: Response
    try {
      response = await doFetch(url, { method: init.method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (error) {
      // 上游把 AbortError 原样往外抛（`infra/commands.ts:19`）：取消不是失败，不该被包成一次「读失败」。
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new GithubError(`GitHub request failed: ${String(error)}`)
    }
    const text = await response.text()
    const received: Record<string, string> = {}
    response.headers.forEach((value, name) => { received[name] = value })
    if (!response.ok) {
      const detail = detailOf(text) || response.statusText
      throw new GithubError(`${detail} (HTTP ${String(response.status)})`, response.status)
    }
    const parsed: unknown = text === '' ? undefined : JSON.parse(text)
    return { status: response.status, headers: received, body: parsed }
  }

  async function page<T>(path: string, options_: GithubPageOptions | undefined): Promise<GithubPage<T>> {
    const got = await fetchPage(`${API}/${scoped(path)}`, { method: 'GET', ...options_ })
    return got as GithubPage<T>
  }

  return {
    repository,
    getPage: page,
    async get<T>(path: string, options_: GithubPageOptions = {}): Promise<T> {
      return (await page<T>(path, options_)).body
    },
    async slurp<T>(path: string, options_: GithubPageOptions | undefined): Promise<T[]> {
      const out: unknown[] = []
      let current = await page<unknown>(path, options_)
      collect(current.body, out)
      let next = nextLink(current.headers.link)
      while (next !== undefined) {
        if (!next.startsWith(`${API}/`)) {
          // 站外地址一律不跟：跟过去就等于把令牌交给那个地址。
          log(`github: refused pagination outside ${API}: ${next}`)
          break
        }
        // `If-None-Match` 只对第一页有意义：续页是另一个 URL，带上去只会换来一次 304。
        current = await fetchPage(next, { method: 'GET' })
        collect(current.body, out)
        next = nextLink(current.headers.link)
      }
      return out as T[]
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      return (await fetchPage(`${API}/${scoped(path)}`, { method: 'POST', body })).body as T
    },
  }
}
