/**
 * `core/ui-server.ts`：请求处理器里抛出的异常要折成 500，而不是让连接悬着。
 *
 * 真起 `node:http` 服务（端口 0），用一个 URL 解析会失败的原样路径触发 `handleRequest` 的
 * 顶层 catch；`DSC_HOME` 指到临时目录（签名密钥与附件仓库都落在那儿）。
 *
 * @module dsc/core/w14b-ui-server-edges.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14b-ui-server-'))
process.env['DSC_HOME'] = HOME

type UiServerMod = typeof import('./ui-server.js')
let ui: UiServerMod
const closers: Array<() => Promise<void>> = []

beforeAll(async () => {
  ui = await import('./ui-server.js')
}, 30_000)

afterAll(async () => {
  for (const close of closers.splice(0)) await close()
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5 })
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

/** 发一个请求，收状态、头与体。 */
function http(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
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
    req.end()
  })
}

/** 起一个界面服务并把收尾登记好。 */
async function start(): Promise<Awaited<ReturnType<UiServerMod['createUiServer']>>> {
  const handle = await ui.createUiServer({
    host: { name: 'Pneuma', version: 'test' },
    assetsDir: makeTree('assets', { 'index.html': '<!doctype html><html><head></head><body>root</body></html>' }),
    pluginsDir: makeTree('plugins', { 'manifest.json': JSON.stringify({ version: 1, plugins: [] }) }),
    log: () => {},
  })
  closers.push(() => handle.close())
  return handle
}

/** 用一次性令牌换 Cookie 头。 */
async function exchangeToken(handle: Awaited<ReturnType<UiServerMod['createUiServer']>>): Promise<string> {
  const token = new URL(handle.url).searchParams.get('token') ?? ''
  const res = await http(handle.port, 'GET', `/?token=${token}`)
  const cookies = res.headers['set-cookie']
  const first = Array.isArray(cookies) ? cookies[0] : cookies
  return String(first ?? '').split(';')[0]
}

describe('请求处理器顶层异常', () => {
  test('URL 解析失败：回 500「内部错误」，连接照常结束', async () => {
    const handle = await start()
    const cookie = await exchangeToken(handle)
    expect(cookie.startsWith(`${ui.UI_COOKIE}=`)).toBe(true)
    // `//[` 作为相对 URL 的 authority 不合法：`new URL(...)` 这时会抛，正好走顶层 catch。
    const broken = await http(handle.port, 'GET', '//[', { cookie })
    expect(broken.status).toBe(500)
    expect(broken.body).toContain('内部错误')
  })
})
