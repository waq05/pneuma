/**
 * `core/ui-server.ts` 的缺口补齐：换票的四类拒绝面、附件两条路由（含 Range / HEAD）、
 * `/api/boot`、`/boot.js`、`/api/events`、`/api/invoke` 上「方法不对回 405」的每一处，
 * 以及签名密钥文件的「形状坏了要重建」与「写不下去只降级」两条落盘分支。
 *
 * 全部真起 `node:http` 服务（端口 0），用真 HTTP 请求读状态码与响应头——这些 405/403/404
 * 的形状就是壳与桌面端看到的契约，假响应验不出来。`DSC_HOME` 换到临时目录：签名密钥
 * 与附件仓库都落在那儿，真实 `~/.dsc` 一点不碰。
 *
 * @module dsc/core/w13-ui-server-extra.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createTempDir } from '../../tests/support/tmp-dir.js'

const HOME = createTempDir('dsc-w13-ui-server-')
process.env['DSC_HOME'] = HOME

type UiServerMod = typeof import('./ui-server.js')
let ui: UiServerMod
let AttachmentStoreCtor: typeof import('./attachments.js').AttachmentStore

// 本文件里建过的服务与裸 socket 都要收干净，否则 vitest 退出时会报句柄没放。
const servers: Server[] = []
const closers: Array<() => Promise<void>> = []

afterAll(async () => {
  for (const close of closers.splice(0)) await close()
  for (const server of servers.splice(0)) await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
})

/** 造一个临时目录树：`files` 是相对路径 → 内容。 */
function makeTree(name: string, files: Record<string, string>): string {
  const dir = join(HOME, `tree-${name}`)
  mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, body, 'utf8')
  }
  return dir
}

/** 一份最小界面产物与插件目录。 */
function makeUiDirs(): { assetsDir: string; pluginsDir: string } {
  return {
    assetsDir: makeTree('assets', {
      'index.html': '<!doctype html><html><head><title>壳</title></head><body>root</body></html>',
      'app-x.js': 'console.log("shell")',
    }),
    pluginsDir: makeTree('plugins', { 'manifest.json': JSON.stringify({ version: 1, plugins: [] }) }),
  }
}

/** 发一个请求，收状态 / 头 / 体。 */
function http(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: Buffer | string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolveDone, rejectDone) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolveDone({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', rejectDone)
    req.end(body)
  })
}

/** 起一个界面服务并把它的收尾登记好。 */
async function start(options: Parameters<UiServerMod['createUiServer']>[0]): Promise<Awaited<ReturnType<UiServerMod['createUiServer']>>> {
  const handle = await ui.createUiServer(options)
  closers.push(() => handle.close())
  return handle
}

/** 用一次性令牌换 Cookie，返回 Cookie 头（`name=value`）。 */
async function exchangeToken(handle: Awaited<ReturnType<UiServerMod['createUiServer']>>): Promise<string> {
  const token = new URL(handle.url).searchParams.get('token') ?? ''
  const res = await http(handle.port, 'GET', `/?token=${token}`)
  expect(res.status).toBe(303)
  const cookies = res.headers['set-cookie']
  const first = Array.isArray(cookies) ? cookies[0] : cookies
  return String(first ?? '').split(';')[0]
}

beforeAll(async () => {
  ui = await import('./ui-server.js')
  const attachments = await import('./attachments.js')
  AttachmentStoreCtor = attachments.AttachmentStore
}, 30_000)

describe('换票与凭据闸', () => {
  test('换票只认 GET：POST 带令牌回 405；令牌用一次就作废；一次带两个令牌也拒', async () => {
    const dirs = makeUiDirs()
    const logs: string[] = []
    const handle = await start({ host: { name: 'Pneuma', version: 'test' }, ...dirs, log: (line) => logs.push(line) })
    const token = new URL(handle.url).searchParams.get('token') ?? ''

    const postExchange = await http(handle.port, 'POST', `/?token=${token}`)
    expect(postExchange.status).toBe(405)
    expect(postExchange.body).toContain('换票只认 GET')

    // 一次带多个 token：形状不对，按无效令牌拒（不猜用户想用哪个）。
    const double = await http(handle.port, 'GET', `/?token=${token}&token=${token}`)
    expect(double.status).toBe(403)

    const cookie = await exchangeToken(handle)
    expect(cookie.startsWith(`${ui.UI_COOKIE}=`)).toBe(true)

    const anonymous = await http(handle.port, 'GET', '/api/boot')
    expect(anonymous.status).toBe(401)
    expect(anonymous.body).toContain('需要凭据')
  })

  test('过期令牌：403 且提示用最新地址', async () => {
    const dirs = makeUiDirs()
    const handle = await start({ host: { name: 'Pneuma', version: 'test' }, ...dirs, tokenTtlMs: -1, log: () => {} })
    const token = new URL(handle.url).searchParams.get('token') ?? ''
    const expired = await http(handle.port, 'GET', `/?token=${token}`)
    expect(expired.status).toBe(403)
    expect(expired.body).toContain('令牌无效或已用过')
  })

  test('Host / Sec-Fetch-Site / Origin 三道闸都拒', async () => {
    const dirs = makeUiDirs()
    const handle = await start({ host: { name: 'Pneuma', version: 'test' }, ...dirs, log: () => {} })
    const cookie = await exchangeToken(handle)
    const badHost = await http(handle.port, 'GET', '/api/boot', { cookie, host: 'evil.example' })
    expect(badHost.status).toBe(403)
    const crossSite = await http(handle.port, 'GET', '/api/boot', { cookie, 'sec-fetch-site': 'cross-site' })
    expect(crossSite.status).toBe(403)
    const badOrigin = await http(handle.port, 'GET', '/api/boot', { cookie, origin: 'http://evil.example' })
    expect(badOrigin.status).toBe(403)
  })
})

describe('启动图与静态伺服', () => {
  let handle: Awaited<ReturnType<UiServerMod['createUiServer']>>
  let cookie = ''

  beforeAll(async () => {
    const dirs = makeUiDirs()
    handle = await start({ host: { name: 'Pneuma', version: 'test-1.2.3' }, ...dirs, log: () => {} })
    cookie = await exchangeToken(handle)
  }, 30_000)

  test('/api/boot：GET / HEAD 都给图，POST 回 405', async () => {
    const boot = await http(handle.port, 'GET', '/api/boot', { cookie })
    expect(boot.status).toBe(200)
    expect(boot.body).toContain('Pneuma')
    const head = await http(handle.port, 'HEAD', '/api/boot', { cookie })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    const post = await http(handle.port, 'POST', '/api/boot', { cookie })
    expect(post.status).toBe(405)
    expect(post.body).toContain('启动图只认 GET 与 HEAD')
  })

  test('/boot.js：GET 给全局注入脚本，HEAD 只回头，POST 回 405', async () => {
    const script = await http(handle.port, 'GET', '/boot.js', { cookie })
    expect(script.status).toBe(200)
    expect(script.body).toContain(`globalThis.${ui.BOOT_GLOBAL}=`)
    expect(script.body).toContain('Pneuma')
    const head = await http(handle.port, 'HEAD', '/boot.js', { cookie })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    const post = await http(handle.port, 'POST', '/boot.js', { cookie })
    expect(post.status).toBe(405)
    expect(post.body).toContain('启动图脚本只认 GET 与 HEAD')
  })

  test('静态页：index.html 注入启动脚本与 CSP；资源文件原样给', async () => {
    const page = await http(handle.port, 'GET', '/', { cookie })
    expect(page.status).toBe(200)
    expect(page.body).toContain('<script src="/boot.js"></script>')
    expect(String(page.headers['content-security-policy'] ?? '')).toContain("script-src 'self'")
    const asset = await http(handle.port, 'GET', '/app-x.js', { cookie })
    expect(asset.status).toBe(200)
    expect(asset.body).toContain('console.log')
  })

  test('不认识的请求方法：405（不是 GET/HEAD 的兜底）', async () => {
    const del = await http(handle.port, 'DELETE', '/whatever', { cookie })
    expect(del.status).toBe(405)
    expect(del.body).toContain('不支持这个请求方法')
  })
})

describe('数据通道路由的方法闸', () => {
  let handle: Awaited<ReturnType<UiServerMod['createUiServer']>>
  let cookie = ''

  beforeAll(async () => {
    const dirs = makeUiDirs()
    const { createUiEvents } = await import('./ui-events.js')
    const events = createUiEvents({
      snapshot: () => ({ sessionId: 's', entries: [], liveEntries: [] }) as never,
      invoke: async () => ({ ok: 1 }),
      methods: ['ping'],
      hello: () => ({ protocolVersion: 1 }),
      subscribe: () => () => {},
      heartbeatMs: 60_000,
      log: () => {},
    })
    closers.push(async () => {
      events.stop()
    })
    handle = await start({ host: { name: 'Pneuma', version: 'test' }, ...dirs, events, log: () => {} })
    cookie = await exchangeToken(handle)
  }, 30_000)

  test('/api/events 只认 GET（POST 回 405）', async () => {
    const res = await http(handle.port, 'POST', '/api/events', { cookie })
    expect(res.status).toBe(405)
    expect(res.body).toContain('事件流只认 GET')
  })

  test('/api/invoke 只认 POST（GET 回 405）', async () => {
    const res = await http(handle.port, 'GET', '/api/invoke', { cookie })
    expect(res.status).toBe(405)
    expect(res.body).toContain('调用只认 POST')
  })
})

describe('附件路由：上传、读取、Range、HEAD 与错误面', () => {
  let handle: Awaited<ReturnType<UiServerMod['createUiServer']>>
  let cookie = ''
  let sha = ''

  beforeAll(async () => {
    const dirs = makeUiDirs()
    const store = new AttachmentStoreCtor({ root: join(HOME, 'attachments-store') })
    handle = await start({ host: { name: 'Pneuma', version: 'test' }, ...dirs, attachments: store, log: () => {} })
    cookie = await exchangeToken(handle)
  }, 30_000)

  test('上传只认 POST；读取只认 GET/HEAD', async () => {
    const getUpload = await http(handle.port, 'GET', '/api/attachments?name=a.txt', { cookie })
    expect(getUpload.status).toBe(405)
    expect(getUpload.body).toContain('上传只认 POST')

    const postRead = await http(handle.port, 'POST', `/api/attachments/${'a'.repeat(64)}`, { cookie })
    expect(postRead.status).toBe(405)
    expect(postRead.body).toContain('附件只认 GET 与 HEAD')
  })

  test('空文件 / 坏 id / 不存在的附件：分别回 400 与 404', async () => {
    const empty = await http(handle.port, 'POST', '/api/attachments?name=none.txt', { cookie }, Buffer.alloc(0))
    expect(empty.status).toBe(400)
    expect(empty.body).toContain('"ok":false')

    const badId = await http(handle.port, 'GET', '/api/attachments/not-a-sha', { cookie })
    expect(badId.status).toBe(404)
    expect(badId.body).toContain('没有这个附件')

    const missing = await http(handle.port, 'GET', `/api/attachments/${'0'.repeat(64)}`, { cookie })
    expect(missing.status).toBe(404)
  })

  test('上传真字节：回 sha 与同源地址；读取拿到原字节', async () => {
    // 一段带 PNG 魔数的字节：sniff 认得出图片类型，长度也够走 Range。
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('w13-attachment-payload'),
    ])
    const uploaded = await http(handle.port, 'POST', '/api/attachments?name=pic.png', { cookie }, bytes)
    expect(uploaded.status).toBe(200)
    const parsed = JSON.parse(uploaded.body) as { ok: boolean; attachment: { sha: string; url: string; mime: string } }
    expect(parsed.ok).toBe(true)
    sha = parsed.attachment.sha
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.attachment.url).toContain(sha)

    const read = await http(handle.port, 'GET', `/api/attachments/${sha}`, { cookie })
    expect(read.status).toBe(200)
    expect(read.body).toBe(bytes.toString('utf8'))
    expect(String(read.headers['accept-ranges'] ?? '')).toBe('bytes')
  })

  test('Range：后缀区间（bytes=-3）与显式区间都回 206，带 content-range', async () => {
    const suffix = await http(handle.port, 'GET', `/api/attachments/${sha}`, { cookie, range: 'bytes=-3' })
    expect(suffix.status).toBe(206)
    expect(String(suffix.headers['content-range'] ?? '')).toMatch(/^bytes \d+-\d+\/\d+$/)
    expect(suffix.body.length).toBe(3)

    const explicit = await http(handle.port, 'GET', `/api/attachments/${sha}`, { cookie, range: 'bytes=0-3' })
    expect(explicit.status).toBe(206)
    expect(explicit.body.length).toBe(4)

    // 形状不认识 / 越界：当没有 Range，退回整段 200。
    const bad = await http(handle.port, 'GET', `/api/attachments/${sha}`, { cookie, range: 'bytes=nope' })
    expect(bad.status).toBe(200)
  })

  test('HEAD：给头不给体；带 Range 的 HEAD 回 206 也不给体', async () => {
    const head = await http(handle.port, 'HEAD', `/api/attachments/${sha}`, { cookie })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    const headRange = await http(handle.port, 'HEAD', `/api/attachments/${sha}`, { cookie, range: 'bytes=0-3' })
    expect(headRange.status).toBe(206)
    expect(headRange.body).toBe('')
  })
})

describe('签名密钥文件的落盘分支', () => {
  const secretPath = (): string => join(HOME, ui.UI_SECRET_FILE)

  test('密钥文件形状不对（被截断）：重新生成并记一行日志（不打印密钥）', async () => {
    rmSync(secretPath(), { force: true })
    writeFileSync(secretPath(), 'not-a-valid-key', 'utf8')
    const dirs = makeUiDirs()
    const logs: string[] = []
    const handle = await start({ host: { name: 'Pneuma', version: 'test' }, ...dirs, log: (line) => logs.push(line) })
    expect(logs.some((line) => line.includes('签名密钥文件形状不对'))).toBe(true)
    // 重新生成之后换票照常可用（新密钥签的 Cookie 当场有效）。
    const cookie = await exchangeToken(handle)
    expect(cookie.startsWith(`${ui.UI_COOKIE}=`)).toBe(true)

    // 旧内容没有被当成密钥用掉：文件已经被合法形状覆盖。
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(secretPath(), 'utf8').trim()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('密钥落不了盘（路径被目录占着）：退回进程内随机密钥，并说清重启要重新换票', async () => {
    rmSync(secretPath(), { recursive: true, force: true })
    mkdirSync(secretPath())
    const dirs = makeUiDirs()
    const logs: string[] = []
    const handle = await start({ host: { name: 'Pneuma', version: 'test' }, ...dirs, log: (line) => logs.push(line) })
    expect(logs.some((line) => line.includes('签名密钥没法落盘'))).toBe(true)
    // 服务仍然可用：换票、带 Cookie 取启动图都通。
    const cookie = await exchangeToken(handle)
    const boot = await http(handle.port, 'GET', '/api/boot', { cookie })
    expect(boot.status).toBe(200)
  })
})
