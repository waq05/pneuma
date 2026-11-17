/**
 * 通知 Webhook：Bark 占位符 GET / ntfy JSON POST 两种格式打到一个真的假服务上
 * （迁自 `scripts/remote-host-test.mjs` 第 11 节）。
 *
 * ## 被测的是什么
 *
 * `sendWebhook` 的两种格式由 URL 自己决定（notify.ts 文件头）：
 *   - URL 带 `{title}` / `{body}` / `{url}` 占位符 → **GET**（Bark 风格），值先
 *     `encodeURIComponent` 再替换，中文、空格、斜杠都不会把 URL 拆坏；
 *   - URL 不带占位符 → **POST JSON**（ntfy 风格），body 是 `{title, body, url}`；
 *   - 对面回 500 → ok:false（失败写 notice，不抛）；连不上 → ok:false（不抛，宿主照常干活）；
 *   - 空地址 → ok:false；
 *   - 占位符识别（webhookHasPlaceholder）与地址校验（isHttpUrl）是纯函数，设置页两处共用。
 *
 * 假服务由 `node:http` 起在系统挑的空闲端口上，收下每个请求的 method / url / body。
 *
 * ## 隔离
 *
 * 这里仍按 integration 层惯例换好临时 HOME 再加载内核侧模块（时序要求见
 * prefs.int.spec 文件头）。
 *
 * @module dsc/core/remote/notify.int.spec
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../../tests/harness.js'

/** 临时主目录：必须在任何内核模块被加载之前换好（理由见 prefs.int.spec 文件头）。 */
const home = tempHome('dsc-remote-notify-')

delete process.env['DSC_HOME']

afterAll(() => {
  home.restore()
})

type NotifyModule = typeof import('@pneuma/runtime/core/remote/notify.js')
let mod: NotifyModule

/** JSON 解析结果的宽松读法（收窄点在这里，与 ops-worker 迁移同款）。 */
type JsonDoc = Record<string, unknown>
const rec = (value: unknown): JsonDoc => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonDoc) : {})

beforeAll(async () => {
  mod = await import('@pneuma/runtime/core/remote/notify.js')
})

/** 假服务收到的一个请求。 */
interface ReceivedRequest {
  method: string | undefined
  url: string | undefined
  body: string
}

describe('通知 Webhook（Bark 占位符 GET / ntfy JSON POST）', () => {
  /** 探针的假服务：/fail 回 500，其余回 200。 */
  let fake: Server
  let fakePort: number
  let base: string
  const received: ReceivedRequest[] = []
  const message = { title: 'Pneuma 等待审批', body: 'write AGENTS.md', url: 'http://192.168.1.5:17321/' }

  beforeAll(async () => {
    fake = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') })
        if ((req.url ?? '').startsWith('/fail')) {
          res.writeHead(500, { 'content-type': 'text/plain' }).end('boom')
          return
        }
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
      })
    })
    fakePort = await new Promise((resolvePort) =>
      fake.listen(0, '127.0.0.1', () => {
        const address = fake.address()
        resolvePort(typeof address === 'object' && address !== null ? address.port : 0)
      }),
    )
    base = `http://127.0.0.1:${String(fakePort)}`
  })

  afterAll(async () => {
    await new Promise((resolveClose) => fake.close(resolveClose))
  })

  test('URL 不带占位符 → POST JSON（ntfy 风格）', async () => {
    const posted = await mod.sendWebhook(`${base}/ntfy-topic`, message)
    const lastPost = received[received.length - 1]
    expect(posted.ok).toBe(true)
    expect(posted.ok === true ? posted.mode : '').toBe('post')
    expect(lastPost?.method).toBe('POST')
    const body = rec(JSON.parse(lastPost?.body ?? '{}') as unknown)
    expect(body['title']).toBe(message.title)
    expect(body['body']).toBe(message.body)
    expect(body['url']).toBe(message.url)
  })

  test('URL 带占位符 → GET，且值先 encodeURIComponent 再替换（Bark 风格）', async () => {
    const got = await mod.sendWebhook(`${base}/push/{title}/{body}?url={url}`, message)
    const lastGet = received[received.length - 1]
    const expectedPath =
      `/push/${encodeURIComponent(message.title)}/${encodeURIComponent(message.body)}` +
      `?url=${encodeURIComponent(message.url)}`
    expect(got.ok).toBe(true)
    expect(got.ok === true ? got.mode : '').toBe('get')
    expect(lastGet?.method).toBe('GET')
    expect(lastGet?.url).toBe(expectedPath)
  })

  test('占位符识别与地址校验是纯函数，设置页两处共用', () => {
    expect(mod.webhookHasPlaceholder('https://x/{title}')).toBe(true)
    expect(mod.webhookHasPlaceholder('https://x/hook')).toBe(false)
    expect(mod.isHttpUrl('https://x/y')).toBe(true)
    expect(mod.isHttpUrl('http://x/y')).toBe(true)
    expect(mod.isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(mod.isHttpUrl('ftp://x/y')).toBe(false)
    expect(mod.isHttpUrl('x/y')).toBe(false)
  })

  test('对面回 500 → ok:false（失败写 notice，不抛）', async () => {
    const failed = await mod.sendWebhook(`${base}/fail`, message)
    expect(failed.ok).toBe(false)
    if (failed.ok === false) expect(failed.error.includes('500')).toBe(true)
  })

  test('连不上 → ok:false（不抛，宿主照常干活）', async () => {
    // 端口 1 没人听：连接被当场拒绝（不是超时，走 catch 也不抛）
    const refused = await mod.sendWebhook('http://127.0.0.1:1/hook', message)
    expect(refused.ok).toBe(false)
    expect(refused.ok === false ? typeof refused.error === 'string' : false).toBe(true)
  })

  test('空地址 → ok:false', async () => {
    const empty = await mod.sendWebhook('   ', message)
    expect(empty.ok).toBe(false)
  })
})
