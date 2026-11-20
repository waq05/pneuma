/**
 * web-fetch 传输层（`http.ts`）的单元测试：地址规则、同源重定向、字节/字数上限、解码。
 *
 * 网络一律用**本地 `node:http` 服务器**或 `fetch` 替身顶掉：这一层要验的是「拿到响应之后
 * 怎么判、怎么截」，真打公网会让用例受网络与站点变化影响。两种方式都用上——本地服务器
 * 那一组证明真的能抓（不是只在假对象上成立），替身那一组负责构造各种畸形响应。
 *
 * @module @pneuma/web-fetch/tests/http
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  MAX_URL_LENGTH,
  USER_AGENT,
  classifyContentType,
  decodeBody,
  fetchPage,
  isSameOrigin,
  parseCharset,
  parseFetchUrl,
} from '../http.js'

/** 一组够用的限额：超时 2 秒、正文最多 1 万字符。 */
const LIMITS = { timeoutMs: 2_000, maxBodyChars: 10_000 }

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 把一次请求的响应做成真 `Response`；不传 content-type 时用二进制 body 免得 undici 自动补类型。 */
function responseOf(body: string | Uint8Array | null, init: ResponseInit = {}): Response {
  return new Response(body, init)
}

describe('parseFetchUrl：三道地址规则', () => {
  test('正常 http/https 地址原样解析', () => {
    expect(parseFetchUrl('https://example.com/a?b=1').hostname).toBe('example.com')
    expect(parseFetchUrl('http://127.0.0.1:8080/x').port).toBe('8080')
  })

  test('空串、超长、非法、非 http(s)、带凭据都当场拒绝，且说清是哪一条', () => {
    expect(() => parseFetchUrl('   ')).toThrow(/url 不能为空/)
    expect(() => parseFetchUrl('https://example.com/' + 'a'.repeat(MAX_URL_LENGTH))).toThrow(/地址太长/)
    expect(() => parseFetchUrl('不是地址')).toThrow(/不是一个合法地址/)
    expect(() => parseFetchUrl('file:///etc/passwd')).toThrow(/只支持 http 与 https/)
    expect(() => parseFetchUrl('javascript:alert(1)')).toThrow(/只支持 http 与 https/)
    expect(() => parseFetchUrl('https://user:secret@example.com/')).toThrow(/带账号密码/)
  })
})

describe('isSameOrigin：协议 + 主机 + 端口三项全同', () => {
  test('端口、主机、协议任一不同都不算同源', () => {
    const base = new URL('https://example.com/a')
    expect(isSameOrigin(base, new URL('https://example.com/b?c=1'))).toBe(true)
    expect(isSameOrigin(base, new URL('https://example.com:8443/b'))).toBe(false)
    expect(isSameOrigin(base, new URL('http://example.com/b'))).toBe(false)
    expect(isSameOrigin(base, new URL('https://other.example.com/b'))).toBe(false)
  })
})

describe('classifyContentType / parseCharset / decodeBody', () => {
  test('Content-Type 归两档：html 与文本可解，二进制不可解', () => {
    expect(classifyContentType('text/html; charset=utf-8')).toBe('html')
    expect(classifyContentType('application/xhtml+xml')).toBe('html')
    expect(classifyContentType('text/plain')).toBe('text')
    expect(classifyContentType('text/csv')).toBe('text')
    expect(classifyContentType('application/json')).toBe('text')
    expect(classifyContentType('application/ld+json')).toBe('text')
    expect(classifyContentType('application/atom+xml')).toBe('text')
    expect(classifyContentType('image/png')).toBeUndefined()
    expect(classifyContentType('application/pdf')).toBeUndefined()
    expect(classifyContentType(null)).toBeUndefined()
  })

  test('charset 参数大小写、引号、空白都能认出来，没有就是 undefined', () => {
    expect(parseCharset('text/html; charset=UTF-8')).toBe('utf-8')
    expect(parseCharset('text/html;charset="gbk"')).toBe('gbk')
    expect(parseCharset('text/html; CHARSET = Big5')).toBe('big5')
    expect(parseCharset('text/html')).toBeUndefined()
    expect(parseCharset(null)).toBeUndefined()
  })

  test('按声明解码；不认识的标签退回 UTF-8，不去抛错', () => {
    const text = new TextEncoder().encode('中文正文')
    expect(decodeBody(text, 'text/plain; charset=utf-8')).toBe('中文正文')
    expect(decodeBody(text, 'text/plain; charset=not-a-real-charset')).toBe('中文正文')
    expect(decodeBody(text, null)).toBe('中文正文')
  })
})

describe('fetchPage：真抓本地服务器', () => {
  test('抓 127.0.0.1 上的 HTML：状态码、最终地址、正文与种类都对', async () => {
    const server = createServer((request, response) => {
      // 断言请求确实带了我们声明的 UA 与 accept。
      expect(request.headers['user-agent']).toBe(USER_AGENT)
      expect(String(request.headers['accept'])).toContain('text/html')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<h1>本地页面</h1><p>正文内容</p>')
    })
    server.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const { port } = server.address() as AddressInfo
    try {
      const page = await fetchPage(`http://127.0.0.1:${String(port)}/page`, LIMITS, new AbortController().signal)
      expect(page.statusCode).toBe(200)
      expect(page.kind).toBe('html')
      expect(page.url).toBe(`http://127.0.0.1:${String(port)}/page`)
      expect(page.content).toContain('本地页面')
      expect(page.truncated).toBe(false)
    } finally {
      server.close()
      await new Promise<void>((resolve) => server.once('close', () => resolve()))
    }
  })

  test('同源 302 会跟过去；最终地址与内容取最后一跳', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { location: '/final' })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('最后一跳的正文')
    })
    server.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const { port } = server.address() as AddressInfo
    const base = `http://127.0.0.1:${String(port)}`
    try {
      const page = await fetchPage(`${base}/start`, LIMITS, new AbortController().signal)
      expect(page.url).toBe(`${base}/final`)
      expect(page.kind).toBe('text')
      expect(page.content).toBe('最后一跳的正文')
    } finally {
      server.close()
      await new Promise<void>((resolve) => server.once('close', () => resolve()))
    }
  })
})

describe('fetchPage：替身响应里的各条边界', () => {
  test('非 2xx 不抛错：404 的正文照样交给模型', async () => {
    vi.stubGlobal('fetch', async () => responseOf('这张页面已经不在了', { status: 404, headers: { 'content-type': 'text/plain' } }))
    const page = await fetchPage('https://example.com/gone', LIMITS, new AbortController().signal)
    expect(page.statusCode).toBe(404)
    expect(page.content).toBe('这张页面已经不在了')
  })

  test('服务器没声明类型时按内容认 HTML；既不像 HTML 又没类型就报「不支持」', async () => {
    vi.stubGlobal('fetch', async () => responseOf(new TextEncoder().encode('<!doctype html><html><body>hi</body></html>')))
    const html = await fetchPage('https://example.com/guess', LIMITS, new AbortController().signal)
    expect(html.kind).toBe('html')

    vi.stubGlobal('fetch', async () => responseOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47])))
    await expect(fetchPage('https://example.com/png', LIMITS, new AbortController().signal)).rejects.toThrow(
      /不是能读的网页或文本/,
    )
  })

  test('Content-Length 直接超过字节上限：不读正文就拒绝', async () => {
    vi.stubGlobal('fetch', async () =>
      responseOf('tiny', { headers: { 'content-type': 'text/plain', 'content-length': String(MAX_RESPONSE_BYTES + 1) } }),
    )
    await expect(fetchPage('https://example.com/huge', LIMITS, new AbortController().signal)).rejects.toThrow(
      /这个页面太大了/,
    )
  })

  test('流式吐超过字节上限：截断并标记 truncated，不整份读进内存', async () => {
    const first = new Uint8Array(4_000_000).fill(0x61)
    const second = new Uint8Array(2_000_000).fill(0x62)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first)
        controller.enqueue(second)
        controller.close()
      },
    })
    vi.stubGlobal('fetch', async () => new Response(stream, { headers: { 'content-type': 'text/plain' } }))
    const page = await fetchPage('https://example.com/stream', { timeoutMs: 5_000, maxBodyChars: 10_000 }, new AbortController().signal)
    expect(page.truncated).toBe(true)
    expect(page.content.length).toBe(10_000)
    // 正文前 1 万字全是 a：截断发生在字节层，字符层再截一次。
    expect(page.content).toBe('a'.repeat(10_000))
  })

  test('正文超过字数上限：按字符截断并标 truncated', async () => {
    vi.stubGlobal('fetch', async () => responseOf('x'.repeat(2_001), { headers: { 'content-type': 'text/plain' } }))
    const page = await fetchPage('https://example.com/long', { timeoutMs: 1_000, maxBodyChars: 2_000 }, new AbortController().signal)
    expect(page.content).toHaveLength(2_000)
    expect(page.truncated).toBe(true)
  })

  test('404 之外的重定向：缺 Location、跨源、超跳数、跳转目标不合法都拒绝', async () => {
    const redirect = (location?: string): Response =>
      location === undefined
        ? responseOf('', { status: 302 })
        : responseOf('', { status: 301, headers: { location } })

    vi.stubGlobal('fetch', async () => redirect())
    await expect(fetchPage('https://example.com/a', LIMITS, new AbortController().signal)).rejects.toThrow(
      /却没给目标地址/,
    )

    vi.stubGlobal('fetch', async () => redirect('https://other.example.com/b'))
    await expect(fetchPage('https://example.com/a', LIMITS, new AbortController().signal)).rejects.toThrow(
      /跨域，不自动跟随/,
    )

    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      // 每次都给同源重定向：六跳必然超过 MAX_REDIRECTS。
      void init
      return redirect('https://example.com/next')
    })
    await expect(fetchPage('https://example.com/a', LIMITS, new AbortController().signal)).rejects.toThrow(
      new RegExp(String(MAX_REDIRECTS)),
    )

    vi.stubGlobal('fetch', async () => redirect('ftp://example.com/b'))
    await expect(fetchPage('https://example.com/a', LIMITS, new AbortController().signal)).rejects.toThrow(
      /只支持 http 与 https/,
    )
  })

  test('303 / 307 / 308 与 301 / 302 一样按重定向处理', async () => {
    for (const status of [303, 307, 308]) {
      vi.stubGlobal('fetch', async (url: string) =>
        String(url).endsWith('/final')
          ? responseOf('到了', { headers: { 'content-type': 'text/plain' } })
          : responseOf('', { status, headers: { location: '/final' } }),
      )
      const page = await fetchPage('https://example.com/start', LIMITS, new AbortController().signal)
      expect(page.content).toBe('到了')
    }
  })

  test('响应没有 body（204）：返回空正文，不抛错', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200, headers: { 'content-type': 'text/html' } }))
    const page = await fetchPage('https://example.com/empty', LIMITS, new AbortController().signal)
    expect(page.content).toBe('')
    expect(page.truncated).toBe(false)
  })

  test('连不上、超时、取消三种失败各给一句能照做的话', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(fetchPage('https://example.com/a', LIMITS, new AbortController().signal)).rejects.toThrow(/连不上/)

    vi.stubGlobal(
      'fetch',
      async (_url: string, init: RequestInit) => {
        // 已经取消过的信号不会再有 abort 事件：真 fetch 这时直接拒绝，替身照做。
        if (init.signal?.aborted === true) throw new Error('aborted')
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      },
    )
    await expect(fetchPage('https://example.com/slow', { timeoutMs: 10, maxBodyChars: 100 }, new AbortController().signal)).rejects.toThrow(
      /抓取超时/,
    )

    const aborted = new AbortController()
    aborted.abort()
    await expect(fetchPage('https://example.com/a', LIMITS, aborted.signal)).rejects.toThrow(/被取消了/)
  })
})
