/**
 * remote 插件装配面与传输层（`packages/remote/index.ts` + `routes.ts`）。
 *
 * 两条线：
 *   1. `createRemoteServer(deps)` 起**真** HTTP + WS 服务（端口现取，收尾 close）：
 *      覆盖 Host 总闸、配对/取票/吊销/上传/推送路由、WS 握手与帧流、invoke 白名单、
 *      重连补帧、无连接期间漏变化、广播与按设备断开、节流、端口被占。
 *   2. `remotePlugin.apply` 用假 ctx（settings / session / transcript / ui 全注入）：
 *      覆盖设置分区、save 校验、起停服务、配对码动作、吊销/让出主控、test-push、
 *      Webhook 通知（审批卡、轮完成、失败原文）、改端口重起与 open-picker 广播。
 *
 * 环境：`DSC_HOME` 在任何 import 之前指进临时目录——`core/remote/store.ts` 的
 * `REMOTE_DIR` 与 `core/path-policy.ts` 都是模块加载时算的。所有模块动态 import。
 *
 * @module dsc/packages/remote/tests/wiring.spec
 */
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import type {
  RemoteServerDeps,
  RemoteServerHandle,
  RemoteShellUi,
  RemoteSnapshot,
} from '../types.js'
import type { RemotePairing } from '@pneuma/runtime/core/remote/pairing.js'
import type { TicketStore } from '@pneuma/runtime/core/remote/tickets.js'
import type { RuntimeSnapshot } from '@pneuma/runtime/contract.js'
import type { SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import type { RemotePrefs } from '@pneuma/runtime/core/prefs.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-remote-wiring-'))
process.env['DSC_HOME'] = HOME
const WORK = join(HOME, 'work')

type RemoteModule = typeof import('../index.js')
let remote: RemoteModule
let pairingMod: typeof import('@pneuma/runtime/core/remote/pairing.js')
let ticketsMod: typeof import('@pneuma/runtime/core/remote/tickets.js')
let uploadsMod: typeof import('@pneuma/runtime/core/remote/uploads.js')

beforeAll(async () => {
  mkdirSync(WORK, { recursive: true })
  remote = await import('../index.js')
  pairingMod = await import('@pneuma/runtime/core/remote/pairing.js')
  ticketsMod = await import('@pneuma/runtime/core/remote/tickets.js')
  uploadsMod = await import('@pneuma/runtime/core/remote/uploads.js')
}, 60_000)

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // 临时目录留给系统清
  }
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(20)
  }
  throw new Error('等待条件超时')
}

/** 等端口真的能应答（`server` 字段先有值，listen 才异步完成）。 */
async function waitForHttp(url: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.status > 0) return
    } catch {
      // 还没在听
    }
    if (Date.now() >= deadline) throw new Error(`等 ${url} 超时`)
    await sleep(30)
  }
}

/** 现取一个空闲端口（listen 0 → 取号 → 关闭）。 */
async function freePort(): Promise<number> {
  const server = createHttpServer()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
  return port
}

// ── HTTP / WS 小工具 ─────────────────────────────────────────────────────────

interface RawResponse {
  status: number
  body: string
}

/** 用 node:http 发一次请求（可覆盖 Host 头；fetch 的 forbidden header 不允许）。 */
function rawRequest(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: options.headers,
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

/** 手写一条 WS 升级请求，把服务端的拒绝应答整段读回来。 */
function rawUpgrade(port: number, path: string, host: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${host}\r\n` +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      )
    })
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      data += chunk
    })
    const finish = (): void => resolve(data)
    socket.on('close', finish)
    socket.on('error', finish)
    setTimeout(() => {
      socket.destroy()
      finish()
    }, 3000).unref()
  })
}

interface WsHarness {
  ws: WebSocket
  messages: Array<Record<string, unknown>>
  waitFor(predicate: (message: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>
  waitClose(): Promise<{ code: number; reason: string }>
  close(): Promise<void>
}

async function connectWs(port: number, query = ''): Promise<WsHarness> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`)
  const messages: Array<Record<string, unknown>> = []
  const waiters: Array<{ predicate: (message: Record<string, unknown>) => boolean; resolve: (value: Record<string, unknown>) => void; timer: NodeJS.Timeout }> = []
  ws.on('message', (data) => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      parsed = { raw: data.toString() }
    }
    messages.push(parsed)
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(parsed)) continue
      clearTimeout(waiter.timer)
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(parsed)
    }
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  })
  return {
    ws,
    messages,
    waitFor(predicate, timeoutMs = 3000) {
      const existing = messages.find(predicate)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.splice(0)
          reject(new Error(`等消息超时；已收到：${JSON.stringify(messages)}`))
        }, timeoutMs)
        waiters.push({ predicate, resolve, timer })
      })
    },
    waitClose: () => closed,
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return
      ws.close()
      await closed
    },
  }
}

// ── createRemoteServer 的 deps 与用例 ────────────────────────────────────────

function snapshotOf(entries: Array<{ id: number }> = []): RemoteSnapshot {
  return {
    sessionId: 'sess-1',
    cwd: WORK,
    entries: entries as RemoteSnapshot['entries'],
    liveEntries: [],
  } as unknown as RemoteSnapshot
}

interface CaseState {
  snapshot: RemoteSnapshot
  listeners: Set<() => void>
  invoked: Array<{ method: string; args: unknown[] }>
  notices: string[]
  pushEnabled: boolean
  pushKey: string | null
  pushSubs: Array<{ payload: unknown; deviceId: string }>
  pushUnsubs: string[]
  shellUi: RemoteShellUi | null
}

interface RemoteCase {
  handle: RemoteServerHandle
  port: number
  url: string
  state: CaseState
  pairing: RemotePairing
  tickets: TicketStore
  close(): Promise<void>
}

const openCases: RemoteCase[] = []
/** apply 起的服务（断言中途失败也要在 afterEach 收掉，否则监听端口会拖住进程）。 */
const applyHarnesses: ApplyHarness[] = []

function buildDeps(overrides: {
  port: number
  throttleMs?: number
  shellUi?: RemoteShellUi | null
  assetsDir?: string
  pairing?: RemotePairing
  tickets?: TicketStore
  snapshot?: RemoteSnapshot
  invoke?: (method: string, args: unknown[]) => Promise<unknown>
}): { deps: RemoteServerDeps; state: CaseState; pairing: RemotePairing; tickets: TicketStore } {
  const pairing = overrides.pairing ?? new pairingMod.RemotePairing({ dir: mkdtempSync(join(HOME, 'pairing-')) })
  const tickets = overrides.tickets ?? new ticketsMod.TicketStore()
  const uploads = new uploadsMod.RemoteUploads({ dir: join(HOME, 'uploads') })
  const state: CaseState = {
    snapshot: overrides.snapshot ?? snapshotOf(),
    listeners: new Set(),
    invoked: [],
    notices: [],
    pushEnabled: false,
    pushKey: null,
    pushSubs: [],
    pushUnsubs: [],
    shellUi: overrides.shellUi ?? null,
  }
  const deps: RemoteServerDeps = {
    port: overrides.port,
    lan: false,
    throttleMs: overrides.throttleMs ?? 20,
    assetsDir: overrides.assetsDir ?? mkdtempSync(join(HOME, 'assets-')),
    pairing,
    tickets,
    uploads,
    invoke: async (method, args) => {
      state.invoked.push({ method, args })
      return overrides.invoke === undefined ? `ok:${method}` : await overrides.invoke(method, args)
    },
    snapshot: () => state.snapshot,
    subscribe: (listener) => {
      state.listeners.add(listener)
      return () => state.listeners.delete(listener)
    },
    notice: (text) => state.notices.push(text),
    pushEnabled: () => state.pushEnabled,
    pushPublicKey: () => state.pushKey,
    pushSubscribe: (payload, deviceId) => {
      const endpoint = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)['endpoint'] : undefined
      if (typeof endpoint !== 'string' || !/^https:\/\//i.test(endpoint)) {
        return { ok: false, error: 'endpoint 必须 https' }
      }
      state.pushSubs.push({ payload, deviceId })
      return { ok: true, added: true, total: 1 }
    },
    pushUnsubscribe: (endpoint) => {
      state.pushUnsubs.push(endpoint)
      return true
    },
    shellUi: state.shellUi,
  }
  return { deps, state, pairing, tickets }
}

async function startRemote(overrides: Parameters<typeof buildDeps>[0] = { port: 0 }): Promise<RemoteCase> {
  const port = overrides.port === 0 ? await freePort() : overrides.port
  const built = buildDeps({ ...overrides, port })
  const handle = remote.createRemoteServer(built.deps)
  await handle.ready
  const testCase: RemoteCase = {
    handle,
    port,
    url: `http://127.0.0.1:${port}`,
    state: built.state,
    pairing: built.pairing,
    tickets: built.tickets,
    async close() {
      handle.close()
      await sleep(30)
    },
  }
  openCases.push(testCase)
  return testCase
}

afterEach(async () => {
  for (const harness of applyHarnesses.splice(0)) {
    try {
      harness.dispose()
    } catch {
      // 已经收过了
    }
  }
  for (const testCase of openCases.splice(0)) {
    try {
      await testCase.close()
    } catch {
      // 已经收过了
    }
  }
})

/** 配一次对，返回 token 与 deviceId。 */
async function pairViaHttp(testCase: RemoteCase, code: string, name = '测试手机'): Promise<{ token: string; deviceId: string }> {
  const response = await fetch(`${testCase.url}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: name }),
  })
  const doc = (await response.json()) as { token?: string; deviceId?: string }
  if (doc.token === undefined || doc.deviceId === undefined) throw new Error(`配对失败：${JSON.stringify(doc)}`)
  return { token: doc.token, deviceId: doc.deviceId }
}

/** 起一个设备并连上 WS（hello + 首帧全量都到手再返回）。 */
async function openSession(testCase: RemoteCase): Promise<{ session: WsHarness; token: string; deviceId: string }> {
  const issued = testCase.pairing.issueCode()
  if (issued === null) throw new Error('发不出配对码')
  const { token, deviceId } = await pairViaHttp(testCase, issued.code)
  const session = await connectWs(testCase.port, `?ticket=${testCase.tickets.issue(deviceId)}`)
  await session.waitFor((message) => message['type'] === 'hello')
  await session.waitFor((message) => message['type'] === 'snapshot')
  return { session, token, deviceId }
}

// ── 传输层：HTTP ─────────────────────────────────────────────────────────────

describe('createRemoteServer：HTTP 路由', () => {
  test('坏 Host 头一律 403（DNS rebinding 总闸）', async () => {
    const testCase = await startRemote()
    const bad = await rawRequest(testCase.port, { path: '/', headers: { host: `evil.example:${testCase.port}` } })
    expect(bad.status).toBe(403)
    expect(bad.body).toContain('Host 头不是本机地址')
    const good = await rawRequest(testCase.port, { path: '/', headers: { host: `127.0.0.1:${testCase.port}` } })
    expect(good.status).toBe(200)
  })

  test('配对：正确码换 token、下发 HttpOnly Cookie、登记设备', async () => {
    const testCase = await startRemote()
    const issued = testCase.pairing.issueCode()
    expect(issued).not.toBeNull()
    const response = await fetch(`${testCase.url}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued!.code, deviceName: '我的手机' }),
    })
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('dsc_remote=')
    expect(cookie).toContain('HttpOnly')
    const doc = (await response.json()) as { ok: boolean; token: string; name: string }
    expect(doc.ok).toBe(true)
    expect(doc.name).toBe('我的手机')
    expect(testCase.pairing.devices()).toHaveLength(1)
    expect(testCase.state.notices.join('\n')).toContain('已配对')
  })

  test('配对失败三态：错码 401、坏 JSON 400、用过的码 401', async () => {
    const testCase = await startRemote()
    const issued = testCase.pairing.issueCode()!
    const wrong = await fetch(`${testCase.url}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ZZZZZZZZ' }),
    })
    expect(wrong.status).toBe(401)
    expect(((await wrong.json()) as { error: string }).error).toContain('配对码不对')

    const malformed = await fetch(`${testCase.url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json' })
    expect(malformed.status).toBe(400)
    expect(((await malformed.json()) as { error: string }).error).toContain('不是 JSON')

    await pairViaHttp(testCase, issued.code)
    const reused = await fetch(`${testCase.url}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code }),
    })
    expect(reused.status).toBe(401)
    expect(((await reused.json()) as { error: string }).error).toContain('没有可用的配对码')
  })

  test('取票：Bearer 与设备 Cookie 都认，无凭据 401', async () => {
    const testCase = await startRemote()
    const issued = testCase.pairing.issueCode()!
    const { token } = await pairViaHttp(testCase, issued.code)

    const bearer = await fetch(`${testCase.url}/api/ticket`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    expect(bearer.status).toBe(200)
    const bearerDoc = (await bearer.json()) as { ok: boolean; ticket: string; expiresInMs: number }
    expect(bearerDoc.ok).toBe(true)
    expect(bearerDoc.ticket).not.toBe('')
    expect(bearerDoc.expiresInMs).toBe(30_000)

    const cookie = await fetch(`${testCase.url}/api/ticket`, { method: 'POST', headers: { cookie: `dsc_remote=${token}` } })
    expect(cookie.status).toBe(200)

    const none = await fetch(`${testCase.url}/api/ticket`, { method: 'POST' })
    expect(none.status).toBe(401)
  })

  test('吊销：按 token 作废凭据，并当场断开该设备的 WS 连接', async () => {
    const testCase = await startRemote()
    const { session, token, deviceId } = await openSession(testCase)
    const revoked = await fetch(`${testCase.url}/api/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' })
    expect(revoked.status).toBe(200)
    expect(((await revoked.json()) as { revoked: boolean }).revoked).toBe(true)
    const closed = await session.waitClose()
    expect(closed.code).toBe(1008)
    expect(testCase.pairing.devices()).toHaveLength(0)
    expect(deviceId).not.toBe('')

    const again = await fetch(`${testCase.url}/api/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' })
    expect(((await again.json()) as { revoked: boolean }).revoked).toBe(false)
  })

  test('上传：无凭据 401、缺 filename 400、成功落盘并通知', async () => {
    const testCase = await startRemote()
    const issued = testCase.pairing.issueCode()!
    const { token } = await pairViaHttp(testCase, issued.code)
    const auth = { authorization: `Bearer ${token}` }

    const noAuth = await fetch(`${testCase.url}/api/upload?filename=a.txt`, { method: 'POST', body: 'hi' })
    expect(noAuth.status).toBe(401)

    const noName = await fetch(`${testCase.url}/api/upload`, { method: 'POST', headers: auth, body: 'hi' })
    expect(noName.status).toBe(400)
    expect(((await noName.json()) as { error: string }).error).toContain('filename')

    const saved = await fetch(`${testCase.url}/api/upload?filename=${encodeURIComponent('../../evil.txt')}`, {
      method: 'POST',
      headers: auth,
      body: 'hello',
    })
    expect(saved.status).toBe(200)
    const doc = (await saved.json()) as { ok: boolean; path: string; name: string; size: number }
    expect(doc.ok).toBe(true)
    expect(doc.name).toBe('evil.txt')
    expect(doc.size).toBe(5)
    expect(existsSync(doc.path)).toBe(true)
    expect(readFileSync(doc.path, 'utf8')).toBe('hello')
    expect(testCase.state.notices.join('\n')).toContain('上传了')
  })

  test('推送未开启：公钥 null、订阅端点 403', async () => {
    const testCase = await startRemote()
    const key = await fetch(`${testCase.url}/api/push-key`)
    expect(await key.json()).toEqual({ ok: true, publicKey: null })
    const subscribe = await fetch(`${testCase.url}/api/push-subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(subscribe.status).toBe(403)
    expect(((await subscribe.json()) as { error: string }).error).toContain('浏览器推送没开')
  })

  test('推送开启：发公钥、订阅入库/退订、非法 endpoint 400', async () => {
    const testCase = await startRemote()
    testCase.state.pushEnabled = true
    testCase.state.pushKey = 'PUBLIC-KEY'
    expect(await (await fetch(`${testCase.url}/api/push-key`)).json()).toEqual({ ok: true, publicKey: 'PUBLIC-KEY' })

    const issued = testCase.pairing.issueCode()!
    const { token, deviceId } = await pairViaHttp(testCase, issued.code)
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` }

    const bad = await fetch(`${testCase.url}/api/push-subscribe`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ endpoint: 'http://push.example/x', keys: { p256dh: 'p', auth: 'a' } }),
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toContain('https')

    const good = await fetch(`${testCase.url}/api/push-subscribe`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }),
    })
    expect(good.status).toBe(200)
    expect(testCase.state.pushSubs[0]?.deviceId).toBe(deviceId)

    const unsubscribe = await fetch(`${testCase.url}/api/push-unsubscribe`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ endpoint: 'https://push.example/x' }),
    })
    expect(unsubscribe.status).toBe(200)
    expect(testCase.state.pushUnsubs).toEqual(['https://push.example/x'])

    const empty = await fetch(`${testCase.url}/api/push-unsubscribe`, { method: 'POST', headers: auth, body: '{}' })
    expect(empty.status).toBe(400)
    expect(((await empty.json()) as { error: string }).error).toContain('endpoint')
  })

  test('静态与服务：资产缺失给占位页、未匹配的 POST 404', async () => {
    const testCase = await startRemote()
    const page = await fetch(`${testCase.url}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('界面资产未构建')

    const missing = await fetch(`${testCase.url}/api/nope`, { method: 'POST' })
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: string }).error).toContain('没有这条路由')
  })

  test('壳档：未认证时给配对页与 /pair.js，认证后放行 boot 与数据通道', async () => {
    const calls: string[] = []
    const shell: RemoteShellUi = {
      assetsDir: mkdtempSync(join(HOME, 'shell-assets-')),
      boot: () => ({ plugins: [] }) as never,
      combos: () => ({}) as never,
      events: {
        handleInvoke: async (_req: unknown, res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body?: string) => void }) => {
          calls.push('invoke')
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true}')
        },
        handleEvents: (_req: unknown, res: { writeHead: (status: number, headers: Record<string, string>) => void; end: () => void }) => {
          calls.push('events')
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end()
        },
      } as never,
      authenticated: (req) => (req.headers['cookie'] ?? '').includes('ok=1'),
    }
    const testCase = await startRemote({ shellUi: shell, port: 0 })

    const pairingPage = await fetch(`${testCase.url}/`)
    expect(pairingPage.status).toBe(200)
    expect(await pairingPage.text()).toContain('远程配对')
    const script = await fetch(`${testCase.url}/pair.js`)
    expect(await script.text()).toContain("fetch('/api/pair'")
    const deniedInvoke = await fetch(`${testCase.url}/api/invoke`, { method: 'POST', body: '{}' })
    expect(deniedInvoke.status).toBe(401)

    const headers = { cookie: 'ok=1' }
    const boot = await fetch(`${testCase.url}/boot.js`, { headers })
    expect(await boot.text()).toContain('globalThis.__DSC_BOOT__')
    expect(await (await fetch(`${testCase.url}/api/boot`, { headers })).json()).toEqual({ plugins: [] })
    await fetch(`${testCase.url}/api/invoke`, { method: 'POST', headers, body: '{}' })
    await fetch(`${testCase.url}/api/events`, { headers })
    expect(calls).toEqual(['invoke', 'events'])
  })
})

// ── 传输层：WebSocket ────────────────────────────────────────────────────────

describe('createRemoteServer：WS 会话与生命周期', () => {
  test('升级前的三道闸：坏 Host 403、非 /ws 404、坏票据 401', async () => {
    const testCase = await startRemote()
    const badHost = await rawUpgrade(testCase.port, '/ws?ticket=x', `evil.example:${testCase.port}`)
    expect(badHost).toContain('403')
    expect(badHost).toContain('Host 头不是本机地址')
    const wrongPath = await rawUpgrade(testCase.port, '/socket?ticket=x', `127.0.0.1:${testCase.port}`)
    expect(wrongPath).toContain('404')
    const badTicket = await rawUpgrade(testCase.port, '/ws?ticket=not-a-ticket', `127.0.0.1:${testCase.port}`)
    expect(badTicket).toContain('401')
    expect(badTicket).toContain('票据无效')
  })

  test('hello 报身份与开放方法，紧跟一帧全量快照', async () => {
    const testCase = await startRemote()
    const issued = testCase.pairing.issueCode()!
    const { deviceId } = await pairViaHttp(testCase, issued.code)
    const session = await connectWs(testCase.port, `?ticket=${testCase.tickets.issue(deviceId)}`)
    const hello = await session.waitFor((message) => message['type'] === 'hello')
    expect(hello['protocolVersion']).toBe(3)
    expect(hello['app']).toBe('pneuma')
    expect(hello['port']).toBe(testCase.port)
    expect(hello['sessionId']).toBe('sess-1')
    expect(hello['cwd']).toBe(WORK)
    expect(hello['methods']).toContain('submit')
    expect(hello['pushPublicKey']).toBeNull()
    const frame = await session.waitFor((message) => message['type'] === 'snapshot')
    expect(frame['seq']).toBe(1)
    expect(frame['full']).toBe(true)
    expect(frame['entries']).toEqual([])
    await session.close()
  })

  test('invoke：白名单放行、非白名单拒绝、坏 JSON 与单值实参', async () => {
    const testCase = await startRemote()
    const { session } = await openSession(testCase)

    session.ws.send(JSON.stringify({ type: 'invoke', id: 1, method: 'submit', args: ['hi'] }))
    const ok = await session.waitFor((message) => message['type'] === 'result' && message['id'] === 1)
    expect(ok).toMatchObject({ ok: true, result: 'ok:submit' })
    expect(testCase.state.invoked[0]).toEqual({ method: 'submit', args: ['hi'] })

    session.ws.send(JSON.stringify({ type: 'invoke', id: 2, method: 'saveProvider', args: [] }))
    const denied = await session.waitFor((message) => message['type'] === 'result' && message['id'] === 2)
    expect(denied['ok']).toBe(false)
    expect(denied['error']).toContain('远程不开放这个方法')

    session.ws.send('not json')
    const malformed = await session.waitFor((message) => message['type'] === 'result' && message['id'] === null)
    expect(malformed['error']).toContain('不是 JSON')

    session.ws.send(JSON.stringify({ type: 'invoke', id: 3, method: 'submit', args: 'single' }))
    await session.waitFor((message) => message['type'] === 'result' && message['id'] === 3)
    expect(testCase.state.invoked.at(-1)).toEqual({ method: 'submit', args: ['single'] })
    await session.close()
  })

  test('重连补帧：lastSeq 在窗口内补增量，窗口外回全量', async () => {
    const testCase = await startRemote({ port: 0, throttleMs: 5 })
    const { session, deviceId } = await openSession(testCase)

    testCase.state.listeners.forEach((listener) => listener())
    const delta = await session.waitFor((message) => message['type'] === 'delta')
    expect(delta['seq']).toBe(2)
    await session.close()

    const replay = await connectWs(testCase.port, `?ticket=${testCase.tickets.issue(deviceId)}&lastSeq=1`)
    await replay.waitFor((message) => message['type'] === 'hello')
    const replayed = await replay.waitFor((message) => message['type'] === 'delta' || (message['type'] === 'snapshot' && Number(message['seq']) > 1))
    expect(replayed['type']).toBe('delta')
    expect(replayed['seq']).toBe(2)
    await replay.close()

    const outside = await connectWs(testCase.port, `?ticket=${testCase.tickets.issue(deviceId)}&lastSeq=999`)
    await outside.waitFor((message) => message['type'] === 'hello')
    const full = await outside.waitFor((message) => message['type'] === 'snapshot')
    expect(full['full']).toBe(true)
    expect(Number(full['seq'])).toBeGreaterThanOrEqual(3)
    await outside.close()
  })

  test('无连接期间发生的变化：下一条连接补一帧全量', async () => {
    const testCase = await startRemote({ port: 0, throttleMs: 5 })
    const { session, deviceId } = await openSession(testCase)
    await session.close()
    // 等服务端把这条连接的 cleanup 跑完（否则 sockets.size 还是 1，走不到「空闲期漏变化」分支）。
    await sleep(80)

    testCase.state.listeners.forEach((listener) => listener())

    const resumed = await connectWs(testCase.port, `?ticket=${testCase.tickets.issue(deviceId)}&lastSeq=1`)
    await resumed.waitFor((message) => message['type'] === 'hello')
    const full = await resumed.waitFor((message) => message['type'] === 'snapshot' && Number(message['seq']) > 1)
    expect(full['full']).toBe(true)
    expect(full['seq']).toBe(2)
    await resumed.close()
  })

  test('broadcast 发给所有连接，closeDevices 只断指定设备', async () => {
    const testCase = await startRemote()

    const first = testCase.pairing.issueCode()!
    const a = await pairViaHttp(testCase, first.code, '设备A')
    const second = testCase.pairing.issueCode({ replace: true })!
    const b = await pairViaHttp(testCase, second.code, '设备B')

    const wsA = await connectWs(testCase.port, `?ticket=${testCase.tickets.issue(a.deviceId)}`)
    const wsB = await connectWs(testCase.port, `?ticket=${testCase.tickets.issue(b.deviceId)}`)
    await wsA.waitFor((message) => message['type'] === 'hello')
    await wsB.waitFor((message) => message['type'] === 'hello')

    testCase.handle.broadcast({ type: 'ui', method: 'open-picker' })
    expect(await wsA.waitFor((message) => message['type'] === 'ui')).toMatchObject({ method: 'open-picker' })
    expect(await wsB.waitFor((message) => message['type'] === 'ui')).toMatchObject({ method: 'open-picker' })

    expect(testCase.handle.closeDevices(a.deviceId)).toBe(1)
    expect((await wsA.waitClose()).code).toBe(1008)
    expect(testCase.handle.closeDevices(a.deviceId)).toBe(0)
    expect(testCase.handle.closeDevices()).toBe(1)
    expect((await wsB.waitClose()).code).toBe(1008)
  })

  test('节流：窗口内的连续变化合并成一帧', async () => {
    const testCase = await startRemote({ port: 0, throttleMs: 60 })
    const { session } = await openSession(testCase)
    for (let index = 0; index < 5; index += 1) testCase.state.listeners.forEach((listener) => listener())
    await session.waitFor((message) => message['type'] === 'delta')
    await sleep(180)
    expect(session.messages.filter((message) => message['type'] === 'delta')).toHaveLength(1)
    await session.close()
  })

  test('端口被占：ready reject 并写一条 notice', async () => {
    const port = await freePort()
    const blocker = createHttpServer()
    await new Promise<void>((resolve) => {
      blocker.listen(port, '127.0.0.1', resolve)
    })
    const built = buildDeps({ port })
    const handle = remote.createRemoteServer(built.deps)
    await expect(handle.ready).rejects.toThrow()
    await waitUntil(() => built.state.notices.some((text) => text.includes('远程控制服务出错')))
    handle.close()
    await new Promise<void>((resolve) => {
      blocker.close(() => resolve())
    })
  })
})

// ── 插件 apply ───────────────────────────────────────────────────────────────

interface ApplyHarness {
  prefs: { remote: RemotePrefs }
  notices: string[]
  sections: SettingsSectionSpec[]
  sectionOptions: Array<{ inSettings?: boolean } | undefined>
  snapshot: { value: RuntimeSnapshot }
  invocations: Array<{ method: string; args: unknown[] }>
  decisions: Array<Record<string, unknown>>
  handlers: Map<string, Set<(...args: unknown[]) => unknown>>
  fireTranscript(): void
  fire(name: string, ...args: unknown[]): void
  setPrefs(patch: { remote: RemotePrefs }): void
  section(): SettingsSectionSpec
  dispose(): void
}

function baseSnapshot(overrides: Record<string, unknown> = {}): RuntimeSnapshot {
  return {
    entries: [],
    status: { turnState: 'idle', sessionPath: join(WORK, 'sess.jsonl') },
    surfaces: { pendingApproval: null, pendingPlan: null, pendingQuestion: null },
    ...overrides,
  } as unknown as RuntimeSnapshot
}

function mountPlugin(options: { prefs?: Partial<RemotePrefs>; snapshot?: RuntimeSnapshot } = {}): ApplyHarness {
  const prefs = {
    remote: {
      enabled: false,
      port: 17_321,
      lan: false,
      push: false,
      notifyWebhook: '',
      ...options.prefs,
    },
  }
  const notices: string[] = []
  const sections: SettingsSectionSpec[] = []
  const sectionOptions: Array<{ inSettings?: boolean } | undefined> = []
  const watchers = new Set<() => void>()
  const transcriptListeners = new Set<() => void>()
  const handlers = new Map<string, Set<(...args: unknown[]) => unknown>>()
  const effects: Array<() => void> = []
  const invocations: Array<{ method: string; args: unknown[] }> = []
  const decisions: Array<Record<string, unknown>> = []
  const snapshot = { value: options.snapshot ?? baseSnapshot() }

  const on = (name: string, handler: (...args: unknown[]) => unknown): (() => void) => {
    if (!handlers.has(name)) handlers.set(name, new Set())
    handlers.get(name)!.add(handler)
    return () => handlers.get(name)?.delete(handler)
  }

  const runtime = {
    getSnapshot: () => snapshot.value,
    submit: async (...args: unknown[]) => {
      invocations.push({ method: 'submit', args })
      return 'submitted'
    },
    answerApproval: async (...args: unknown[]) => {
      invocations.push({ method: 'answerApproval', args })
      return { ok: true }
    },
  }

  const ctx = {
    ui: runtime,
    settings: {
      prefs: () => prefs,
      setPrefs: (patch: { remote: RemotePrefs }) => {
        prefs.remote = { ...prefs.remote, ...patch.remote }
        for (const watcher of watchers) watcher()
        return prefs
      },
      watchPrefs: (listener: () => void) => {
        watchers.add(listener)
        return () => watchers.delete(listener)
      },
      registerSection: (spec: SettingsSectionSpec, sectionOptionsArg?: { inSettings?: boolean }) => {
        sections.push(spec)
        sectionOptions.push(sectionOptionsArg)
        return () => {
          const index = sections.indexOf(spec)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    session: {
      current: () => ({ meta: { id: 'sess-1', cwd: WORK }, filePath: join(WORK, 'sess.jsonl') }),
    },
    transcript: {
      subscribe: (listener: () => void) => {
        transcriptListeners.add(listener)
        return () => transcriptListeners.delete(listener)
      },
    },
    emit: (name: string, ...args: unknown[]) => {
      if (name === 'dsc/notice') notices.push(String(args[0] ?? ''))
      for (const handler of handlers.get(name) ?? []) handler(...args)
    },
    on,
    effect: (execute: () => unknown) => {
      const off = execute()
      const dispose = typeof off === 'function' ? (off as () => void) : (): void => undefined
      effects.push(dispose)
      return dispose
    },
    logger: { warn: () => undefined },
    get: () => undefined,
  }

  remote.remotePlugin.apply(ctx as never, {})

  const harness: ApplyHarness = {
    prefs,
    notices,
    sections,
    sectionOptions,
    snapshot,
    invocations,
    decisions,
    handlers,
    fireTranscript: () => {
      for (const listener of transcriptListeners) listener()
    },
    fire: (name, ...args) => {
      for (const handler of handlers.get(name) ?? []) handler(...args)
    },
    setPrefs: (patch) => {
      prefs.remote = { ...prefs.remote, ...patch.remote }
      for (const watcher of watchers) watcher()
    },
    section: () => {
      const section = sections[0]
      if (section === undefined) throw new Error('没有注册 remote 设置分区')
      return section
    },
    dispose: () => {
      for (const handler of handlers.get('dsc/exit') ?? []) handler()
      for (const off of effects.splice(0)) {
        try {
          off()
        } catch {
          // 幂等收尾
        }
      }
    },
  }
  applyHarnesses.push(harness)
  return harness
}

function fieldText(section: SettingsSectionSpec, labelPart: string): string {
  const field = section.fields().find((item) => item.label?.includes(labelPart) === true)
  return typeof field === 'object' && field !== null && 'text' in field ? String(field.text) : ''
}

/** 起一个本地 Webhook 接收器（真 fetch 打过来）。 */
async function startReceiver(): Promise<{
  url: string
  received: Array<{ method: string; body: string }>
  waitForCount(count: number, timeoutMs?: number): Promise<{ method: string; body: string }>
  close(): Promise<void>
}> {
  const received: Array<{ method: string; body: string }> = []
  const server = createHttpServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      received.push({ method: req.method ?? 'GET', body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    async waitForCount(count, timeoutMs = 4000) {
      await waitUntil(() => received.length >= count, timeoutMs)
      const item = received[count - 1]
      if (item === undefined) throw new Error('没有收到 Webhook')
      return item
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}

describe('remotePlugin.apply：设置分区与生命周期', () => {
  test('注册远程分区（inSettings、order 40），fields/values 反映关闭状态', () => {
    const harness = mountPlugin()
    const section = harness.section()
    expect(section.id).toBe('remote')
    expect(section.order).toBe(40)
    expect(harness.sectionOptions[0]).toEqual({ inSettings: true })

    const fields = section.fields()
    const keys = fields.flatMap((field) => ('key' in field && field.key !== undefined ? [field.key] : []))
    expect(keys).toEqual(expect.arrayContaining(['enabled', 'port', 'lan', 'push', 'notifyWebhook']))
    expect(fieldText(section, '运行状态')).toBe('已关闭')
    expect(fieldText(section, '访问地址')).toMatch(/^http:\/\/127\.0\.0\.1:17321\/$/)
    expect(fieldText(section, '已配对设备')).toBe('还没有设备')
    expect(fields.some((field) => 'action' in field && field.action === 'regenerate-code')).toBe(true)
    expect(section.values()).toMatchObject({ enabled: false, port: 17_321, lan: false, push: false })
    harness.dispose()
  })

  test('save 校验端口范围与 Webhook 地址，未知键报错', () => {
    const harness = mountPlugin()
    const section = harness.section()
    expect(() => section.save!('port', 80)).toThrow(/1024/)
    expect(() => section.save!('port', 'abc')).toThrow(/1024/)
    expect(() => section.save!('notifyWebhook', 'ftp://x')).toThrow(/http/)
    expect(() => section.save!('nope', 1)).toThrow(/未知/)
    section.save!('notifyWebhook', 'https://example.com/hook')
    expect(harness.prefs.remote.notifyWebhook).toBe('https://example.com/hook')
    section.save!('port', 20_000)
    expect(harness.prefs.remote.port).toBe(20_000)
    section.save!('lan', true)
    expect(harness.prefs.remote.lan).toBe(true)
    harness.dispose()
  })

  test('打开开关起服务、关掉开关停服务并通知（壳产物缺失时降级）', async () => {
    const port = await freePort()
    const harness = mountPlugin({ prefs: { enabled: false, port } })
    const section = harness.section()
    expect(fieldText(section, '运行状态')).toBe('已关闭')

    harness.setPrefs({ remote: { ...harness.prefs.remote, enabled: true } })
    await waitUntil(() => fieldText(section, '运行状态').includes('运行中'))
    expect(fieldText(section, '运行状态')).toContain(`127.0.0.1:${port}`)
    expect(harness.notices.join('\n')).toContain('远程壳产物不存在')

    await waitForHttp(`http://127.0.0.1:${port}/`)
    const page = await fetch(`http://127.0.0.1:${port}/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('界面资产未构建')

    harness.setPrefs({ remote: { ...harness.prefs.remote, enabled: false } })
    expect(harness.notices).toContain('远程控制已关闭，已连接的设备已断开')
    expect(fieldText(section, '运行状态')).toBe('已关闭')
    harness.dispose()
  })

  test('配对码：regenerate-code 服务未起时 reach=down；pair-code-lan 打开开关后不再 down', async () => {
    const port = await freePort()
    const harness = mountPlugin({ prefs: { enabled: false, port, lan: false } })
    const section = harness.section()

    const first = (await section.action!('regenerate-code')) as { notice: string; data: { kind: string; code: string; url: string; reach: string } }
    expect(first.data.kind).toBe('pair-code')
    expect(first.data.code).toMatch(/^[A-Z2-9]{8}$/)
    expect(first.data.reach).toBe('down')
    expect(first.data.url).toContain(`?code=${first.data.code}`)
    expect(first.notice).toContain('半小时内有效')

    const lan = (await section.action!('pair-code-lan')) as { data: { reach: string; code: string } }
    expect(harness.prefs.remote.enabled).toBe(true)
    expect(harness.prefs.remote.lan).toBe(true)
    expect(lan.data.reach).not.toBe('down')
    expect(lan.data.reach).toMatch(/^(lan|local)$/)
    harness.dispose()
  })

  test('动作：revoke-all / revoke-device / release-owner 与重新打开解除让位', async () => {
    const port = await freePort()
    const harness = mountPlugin({ prefs: { enabled: true, port, lan: false } })
    const section = harness.section()
    await waitUntil(() => fieldText(section, '运行状态').includes('运行中'))
    await waitForHttp(`http://127.0.0.1:${port}/`)

    expect(await section.action!('revoke-all')).toContain('本来就没有')
    expect(await section.action!('revoke-device:missing')).toContain('已经不在了')

    const issued = (await section.action!('regenerate-code')) as { data: { code: string } }
    await pairViaHttp({ url: `http://127.0.0.1:${port}` } as RemoteCase, issued.data.code, '客厅手机')
    const rows = section.fields()
    const revokeButton = rows.find((field) => 'action' in field && String(field.action).startsWith('revoke-device:'))
    expect(revokeButton).toBeDefined()
    const deviceId = String((revokeButton as { action: string }).action).slice('revoke-device:'.length)
    expect(await section.action!(`revoke-device:${deviceId}`)).toContain('已吊销')
    expect(fieldText(section, '已配对设备')).toBe('还没有设备')

    expect(await section.action!('release-owner')).toContain('已让出主控位')
    expect(fieldText(section, '运行状态')).toContain('已让出主控位')
    section.save!('enabled', true)
    await waitUntil(() => fieldText(section, '运行状态').includes('运行中'))
    harness.dispose()
  })

  test('test-push：未开启时两条腿都说没开；配了 Webhook 时真发 POST', async () => {
    const receiver = await startReceiver()
    const harness = mountPlugin({ prefs: { enabled: false, push: false, notifyWebhook: '' } })
    const section = harness.section()

    const off = String(await section.action!('test-push'))
    expect(off).toContain('浏览器推送：没开')
    expect(off).toContain('通知 Webhook：没配')

    harness.setPrefs({ remote: { ...harness.prefs.remote, notifyWebhook: receiver.url } })
    const on = String(await section.action!('test-push'))
    expect(on).toContain('通知 Webhook：已发送（POST JSON）')
    const got = await receiver.waitForCount(1)
    const body = JSON.parse(got.body) as { title: string }
    expect(body.title).toBe('Pneuma 测试推送')
    await receiver.close()
    harness.dispose()
  })

  test('审批卡从无到有 → Webhook 通知（标题与参数摘要）', async () => {
    const receiver = await startReceiver()
    const harness = mountPlugin({ prefs: { notifyWebhook: receiver.url } })
    harness.snapshot.value = baseSnapshot({
      surfaces: { pendingApproval: { id: 'a1', toolName: 'bash', argsSummary: 'rm -rf build' }, pendingPlan: null, pendingQuestion: null },
    })
    harness.fireTranscript()
    const got = await receiver.waitForCount(1)
    const body = JSON.parse(got.body) as { title: string; body: string; url: string }
    expect(body.title).toBe('Pneuma 等待审批')
    expect(body.body).toBe('rm -rf build')
    expect(body.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    await receiver.close()
    harness.dispose()
  })

  test('轮完成：短轮但有审批卡也推一条', async () => {
    const receiver = await startReceiver()
    const harness = mountPlugin({ prefs: { notifyWebhook: receiver.url } })
    const sessionPath = join(WORK, 'sess.jsonl')

    harness.snapshot.value = baseSnapshot({ status: { turnState: 'running', sessionPath } })
    harness.fireTranscript()
    harness.snapshot.value = baseSnapshot({
      status: { turnState: 'running', sessionPath },
      surfaces: { pendingApproval: { id: 'a1', toolName: 'bash', argsSummary: 'ls' }, pendingPlan: null, pendingQuestion: null },
    })
    harness.fireTranscript()
    await receiver.waitForCount(1)

    harness.snapshot.value = baseSnapshot({ status: { turnState: 'idle', sessionPath } })
    harness.fireTranscript()
    harness.fire('dsc/turn-end', 'completed', { sessionPath })
    const second = await receiver.waitForCount(2)
    const body = JSON.parse(second.body) as { title: string; body: string }
    expect(body.title).toBe('Pneuma 轮完成')
    expect(body.body).toMatch(/用时 \d+s/)
    await receiver.close()
    harness.dispose()
  })

  test('轮失败：带错误原文推送；中断不推', async () => {
    const receiver = await startReceiver()
    const harness = mountPlugin({ prefs: { notifyWebhook: receiver.url } })
    const sessionPath = join(WORK, 'sess.jsonl')
    harness.snapshot.value = baseSnapshot({
      status: { turnState: 'running', sessionPath },
      entries: [{ kind: 'system', level: 'error', text: '错误：boom\n第二行' }],
    })
    harness.fireTranscript()
    harness.fire('dsc/turn-end', 'error', { sessionPath })
    const got = await receiver.waitForCount(1)
    const body = JSON.parse(got.body) as { title: string; body: string }
    expect(body.title).toBe('Pneuma 任务失败')
    expect(body.body).toContain('boom 第二行')

    harness.fire('dsc/turn-end', 'aborted', { sessionPath })
    await sleep(120)
    expect(receiver.received).toHaveLength(1)
    await receiver.close()
    harness.dispose()
  })

  test('改端口会重起监听；open-picker 转成广播；dispose 幂等', async () => {
    const firstPort = await freePort()
    const secondPort = await freePort()
    const harness = mountPlugin({ prefs: { enabled: true, port: firstPort } })
    const section = harness.section()
    await waitUntil(() => fieldText(section, '运行状态').includes(`:${firstPort}`))
    await waitForHttp(`http://127.0.0.1:${firstPort}/`)

    // 配一台设备并把 WS 连上：open-picker 的广播要有人收。
    const issued = (await section.action!('regenerate-code')) as { data: { code: string } }
    const paired = await pairViaHttp({ url: `http://127.0.0.1:${firstPort}` } as RemoteCase, issued.data.code)
    const ticketResponse = await fetch(`http://127.0.0.1:${firstPort}/api/ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${paired.token}` },
    })
    const ticket = ((await ticketResponse.json()) as { ticket: string }).ticket
    const session = await connectWs(firstPort, `?ticket=${ticket}`)
    await session.waitFor((message) => message['type'] === 'hello')
    harness.fire('dsc/open-picker')
    expect(await session.waitFor((message) => message['type'] === 'ui')).toMatchObject({ method: 'open-picker' })
    await session.close()

    harness.setPrefs({ remote: { ...harness.prefs.remote, port: secondPort } })
    await waitUntil(() => fieldText(section, '运行状态').includes(`:${secondPort}`))
    await waitForHttp(`http://127.0.0.1:${secondPort}/`)
    const page = await fetch(`http://127.0.0.1:${secondPort}/`)
    expect(page.status).toBe(200)

    harness.dispose()
    harness.dispose()
    await expect(fetch(`http://127.0.0.1:${secondPort}/`)).rejects.toThrow()
    expect(fieldText(section, '运行状态')).not.toContain('运行中')
  })
})
