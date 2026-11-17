/**
 * HTTP + WebSocket 全链路：上传路由、推送路由、全局 seq 跨连接连续、lastSeq 补帧、
 * 环形缓冲滚窗与断线全量补救（迁自 `scripts/remote-host-test.mjs` 第 12 节）。
 *
 * ## 被测的是什么
 *
 * `createRemoteServer` 起真服务（桩宿主依赖），走真的 HTTP 请求与真的 WS 连接：
 *   - 推送三态：关着时 push-key 报 publicKey:null、订阅 / 退订端点回 403；开着时
 *     push-key 给 VAPID 公钥（不要 token）、订阅要设备 token（401）、订阅去重
 *     （added:true → added:false）、退订 removed:true；
 *   - 上传路由：不带 token 401、不带 filename 400、成功 200 + {ok,path,size,name}
 *     （穿越文件名安全化后落盘）、超过 20MB 413（这条路由不受 64KB 上限约束）；
 *   - WS 帧流：hello（协议版本 3、端口、开放方法清单、pushPublicKey）→ 不带 lastSeq
 *     紧跟一帧全量 → **全局 seq 跨连接连续**（不是各自从 1 数）→ 同一串帧发给所有连接
 *     （内容逐字节相同）→ 会话变化推增量（added 里是新条目）→ 拔掉一条连接帧流继续前进 →
 *     lastSeq 在窗口内按原样补帧（重发不重算）→ 补完转实时 → 连造 121 帧把环形缓冲滚过
 *     最老那帧 → 窗口外的 lastSeq 回落 hello + 一帧全量 → **一条连接都没有时发生的变化**：
 *     重连补完缓冲帧之后必须再补一帧全量。
 *
 * ## 桩与时序
 *
 * - `snapshot()` 桩 `as unknown as RemoteSnapshot`（理由同 remote-server.int.spec 文件头）；
 *   会话变化就是改这个模块级变量再 `emit()`。
 * - 探针里所有「帧是节流定时器异步出来的」的等待都换成 `waitFor` 轮询到条件成立
 *   （harness 规矩 6）；`sleep(20)` / `sleep(30)` 两处保留语义（等 socket close 落地）。
 * - 服务端口用 `freePort()`（listen 0 再关）；integration 是 forks 池每文件一进程，不撞口。
 * - throttleMs 压到 1：121 帧循环靠它才跑得快（探针原样）。
 *
 * ## 隔离
 *
 * 配对 / 票据 / 上传 / 推送的数据目录全在 tempHome 下（显式传 dir）。
 *
 * @module dsc/packages/remote/remote-ws.int.spec
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../../tests/harness.js'
import { REMOTE_PROTOCOL_VERSION } from './types.js'
import type { RemoteServerHandle, RemoteSnapshot } from './types.js'

/** 临时主目录：必须在任何内核模块被加载之前换好（理由见 prefs.int.spec 文件头）。 */
const home = tempHome('dsc-remote-ws-')

delete process.env['DSC_HOME']

type CoreModule = typeof import('@pneuma/runtime/core/remote/uploads.js')
type PairingModule = typeof import('@pneuma/runtime/core/remote/pairing.js')
type PushModule = typeof import('@pneuma/runtime/core/remote/push.js')
type TicketsModule = typeof import('@pneuma/runtime/core/remote/tickets.js')
type ServerModule = typeof import('./index.js')
let coreMod: CoreModule
let pairingMod: PairingModule
let pushMod: PushModule
let ticketsMod: TicketsModule
let serverMod: ServerModule

/** 帧正文解析出来的宽松形状（线上帧没有窄类型，收窄点在这里，与 ops-worker 迁移同款）。 */
type FrameDoc = Record<string, unknown>
const rec = (value: unknown): FrameDoc => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as FrameDoc) : {})
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** 等一个条件成立（帧是按节流定时器异步出来的，只能等）。 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(5)
  }
}

/** 由系统挑一个空闲端口（先 listen 0 再关掉，紧接着给桩服务用）。 */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:http')
  return await new Promise((resolvePort) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const chosen = (probe.address() as { port: number }).port
      probe.close(() => resolvePort(chosen))
    })
  })
}

/** 一个最小 HTTP 调用器：body 可以是字符串也可以是 Buffer（原始字节）。 */
interface HttpCallOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
}
const httpCall = (port: number, path: string, options: HttpCallOptions = {}): Promise<{ status: number | undefined; body: string }> =>
  new Promise((resolveCall, rejectCall) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    if (typeof options.body === 'string') headers['content-length'] = String(Buffer.byteLength(options.body))
    if (Buffer.isBuffer(options.body)) headers['content-length'] = String(options.body.length)
    const req = httpRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolveCall({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', rejectCall)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })

/** 探针的最小快照桩（为什么可以不完整：见文件头「桩与时序」）。 */
const snapshotOf = (): RemoteSnapshot =>
  ({
    sessionId: 's1',
    cwd: 'D:\\dsc',
    status: {},
    surfaces: {},
    sessions: [],
    sessionsLoading: false,
    entries: [],
    liveEntries: [],
  }) as unknown as RemoteSnapshot

/** 一条 WS 客户端连接：收到的每帧（原样文本 + 解析结果）。 */
interface WsClient {
  socket: WebSocket
  frames: Array<{ text: string; frame: FrameDoc }>
}

/** 桩服务的端口与共享实例（beforeAll 里构造：模块 must 先 import，见文件头「桩与时序」）。 */
let stubPort = 0
let uploads: InstanceType<CoreModule['RemoteUploads']>
let pushStore: InstanceType<PushModule['RemotePush']>
let httpPairing: InstanceType<PairingModule['RemotePairing']>
let httpTickets: InstanceType<TicketsModule['TicketStore']>
let pushOn = false
let server: RemoteServerHandle
const uploadDir = join(home.home, 'uploads-http')
const pushDir = join(home.home, 'push-http')

let snapshotState: Record<string, unknown> = {
  sessionId: 's1',
  cwd: 'D:\\dsc',
  status: { turnState: 'idle' },
  surfaces: {},
  sessions: [],
  sessionsLoading: false,
  entries: [{ id: 1, kind: 'text', text: '第一条' }],
  liveEntries: [],
}
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const listener of [...listeners]) listener()
}

/** 设备凭据（beforeAll 里配对拿到）：HTTP 上传与推送订阅路由共用。 */
let auth: Record<string, string>

/** 打一条 WS：每次现取一张票据（一次性），带 lastSeq 时拼在查询串上。 */
const openWs = (lastSeq?: number): Promise<WsClient> =>
  new Promise((resolveWs, rejectWs) => {
    const ticket = httpTickets.issue('dev-1')
    const suffix = lastSeq === undefined ? '' : `&lastSeq=${String(lastSeq)}`
    const socket = new WebSocket(`ws://127.0.0.1:${String(stubPort)}/ws?ticket=${encodeURIComponent(ticket)}${suffix}`)
    const frames: WsClient['frames'] = []
    socket.on('message', (data: unknown) => {
      const text = String(data)
      frames.push({ text, frame: rec(JSON.parse(text) as unknown) })
    })
    socket.on('open', () => resolveWs({ socket, frames }))
    socket.on('error', rejectWs)
  })
const newestSeq = (client: WsClient): number => {
  let newest = 0
  for (const item of client.frames) {
    const seq = item.frame['seq']
    if (typeof seq === 'number' && seq > newest) newest = seq
  }
  return newest
}
const frameOf = (client: WsClient, seq: number): WsClient['frames'][number] | undefined =>
  client.frames.find((item) => item.frame['seq'] === seq)

beforeAll(async () => {
  coreMod = await import('@pneuma/runtime/core/remote/uploads.js')
  pairingMod = await import('@pneuma/runtime/core/remote/pairing.js')
  pushMod = await import('@pneuma/runtime/core/remote/push.js')
  ticketsMod = await import('@pneuma/runtime/core/remote/tickets.js')
  serverMod = await import('./index.js')
  uploads = new coreMod.RemoteUploads({ dir: uploadDir, now: () => Date.UTC(2026, 0, 2, 3, 4, 5) })
  pushStore = new pushMod.RemotePush({ dir: pushDir, sender: async () => {} })
  httpPairing = new pairingMod.RemotePairing({ dir: join(home.home, 'pairing-http') })
  httpTickets = new ticketsMod.TicketStore()
  stubPort = await freePort()
  const created = serverMod.createRemoteServer({
    port: stubPort,
    lan: false,
    // 节流调到最小：下面要连造 121 帧把环形缓冲滚一圈，靠它才跑得快
    throttleMs: 1,
    assetsDir: join(home.home, '没有这个目录'),
    pairing: httpPairing,
    tickets: httpTickets,
    // shellUi 显式给 null（探针第 12 节没传这个键：JS 不查必填，这一段只打 /api/* 与 /ws
    // 路由才没炸）。理由与探针第 6 节的注释相同：路由按 `!== null` 判空，undefined 会掉进
    // 壳档分支，类型上也必填。
    shellUi: null,
    uploads,
    invoke: async () => null,
    snapshot: () => snapshotState as unknown as RemoteSnapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notice: () => {},
    pushEnabled: () => pushOn,
    pushPublicKey: () => (pushOn ? pushStore.publicKey() : null),
    pushSubscribe: (payload: unknown, deviceId: string) => pushStore.add(payload, deviceId),
    pushUnsubscribe: (endpoint: string) => pushStore.remove(endpoint),
  })
  await created.ready
  server = created
  // 认一台设备：配对码换 token（探针同款，放在起服务之后）
  const issued = httpPairing.issueCode()
  const paired = httpPairing.verifyCode(issued?.code ?? '', '探针手机')
  const token = paired.ok === true ? paired.token : ''
  auth = { authorization: `Bearer ${token}` }
})

afterAll(() => {
  server?.close()
  home.restore()
})

describe('HTTP 与 WebSocket（上传 / 推送订阅 / 帧流）', () => {
  test('hello 报的协议版本是 3', () => {
    expect(REMOTE_PROTOCOL_VERSION).toBe(3)
  })

  test('推送关着时 push-key 返回 publicKey:null', async () => {
    const response = await httpCall(stubPort, '/api/push-key')
    expect(response.body.includes('"publicKey":null')).toBe(true)
  })

  test('推送关着时订阅端点回 403', async () => {
    const subOff = await httpCall(stubPort, '/api/push-subscribe', { method: 'POST', headers: auth })
    expect(subOff.status).toBe(403)
  })

  test('推送关着时退订端点也回 403', async () => {
    const unsubOff = await httpCall(stubPort, '/api/push-unsubscribe', { method: 'POST', headers: auth })
    expect(unsubOff.status).toBe(403)
  })

  test('推送开着时 push-key 给出 VAPID 公钥（不要 token）', async () => {
    pushOn = true
    const pushKey = rec(JSON.parse((await httpCall(stubPort, '/api/push-key')).body) as unknown)
    expect(pushKey['ok']).toBe(true)
    expect(typeof pushKey['publicKey']).toBe('string')
    expect(typeof pushKey['publicKey'] === 'string' ? (pushKey['publicKey'] as string).length : 0).toBeGreaterThan(80)
  })

  test('订阅端点要设备 token（没有 → 401）', async () => {
    const subNoAuth = await httpCall(stubPort, '/api/push-subscribe', { method: 'POST' })
    expect(subNoAuth.status).toBe(401)
  })

  test('订阅入库：第一次 added:true，同一个 endpoint 再来一次 added:false（总数还是 1）', async () => {
    const subscription = JSON.stringify({ endpoint: 'https://push.example/mobile', keys: { p256dh: 'pp', auth: 'aa' } })
    const sub1 = rec(JSON.parse((await httpCall(stubPort, '/api/push-subscribe', { method: 'POST', headers: auth, body: subscription })).body) as unknown)
    const sub2 = rec(JSON.parse((await httpCall(stubPort, '/api/push-subscribe', { method: 'POST', headers: auth, body: subscription })).body) as unknown)
    expect(sub1['ok']).toBe(true)
    expect(sub1['added']).toBe(true)
    expect(sub1['total']).toBe(1)
    expect(sub2['ok']).toBe(true)
    expect(sub2['added']).toBe(false)
    expect(sub2['total']).toBe(1)
  })

  test('退订删掉那一条（removed:true）', async () => {
    const unsub = rec(
      JSON.parse(
        (
          await httpCall(stubPort, '/api/push-unsubscribe', {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ endpoint: 'https://push.example/mobile' }),
          })
        ).body,
      ) as unknown,
    )
    expect(unsub['ok']).toBe(true)
    expect(unsub['removed']).toBe(true)
    expect(pushStore.count()).toBe(0)
  })

  test('上传不带 token → 401', async () => {
    const noAuth = await httpCall(stubPort, '/api/upload?filename=a.txt', { method: 'POST' })
    expect(noAuth.status).toBe(401)
  })

  test('上传不带 filename → 400', async () => {
    const noName = await httpCall(stubPort, '/api/upload', { method: 'POST', headers: auth, body: 'x' })
    expect(noName.status).toBe(400)
  })

  test('上传成功：200 + {ok,path,size,name}，穿越文件名被安全化后落在 uploads 里', async () => {
    const uploaded = rec(
      JSON.parse(
        (
          await httpCall(stubPort, `/api/upload?filename=${encodeURIComponent('../../照片 1.png')}`, {
            method: 'POST',
            headers: auth,
            body: Buffer.from('PNG 假数据', 'utf8'),
          })
        ).body,
      ) as unknown,
    )
    expect(uploaded['ok']).toBe(true)
    expect(uploaded['size']).toBe(Buffer.byteLength('PNG 假数据', 'utf8'))
    expect(uploaded['name']).toBe('照片 1.png')
    expect(typeof uploaded['path'] === 'string' ? (uploaded['path'] as string).startsWith(uploadDir) : false).toBe(true)
    expect(readFileSync(uploaded['path'] as string, 'utf8')).toBe('PNG 假数据')
  })

  test('上传超过 20MB → 413（这条路由不受 64KB 上限约束，20MB 才拦）', async () => {
    const overLimit = await httpCall(stubPort, '/api/upload?filename=huge.bin', {
      method: 'POST',
      headers: auth,
      body: Buffer.alloc(20 * 1024 * 1024 + 1, 1),
    })
    expect(overLimit.status).toBe(413)
  })

  // ── WS：全局 seq 跨连接连续 ──────────────────────────────────────────────
  let first: WsClient
  let sawSeq1 = 0
  let second: WsClient
  let forced = 0
  let lastSeen = 0
  let topSeq = 0
  let third: WsClient
  let liveSeq = 0
  let rolled = 0
  let outside: WsClient

  test('hello：协议版本 3、端口、开放方法清单、pushPublicKey（推送开着 → 公钥字符串）', async () => {
    first = await openWs()
    await waitFor(() => newestSeq(first) >= 1, '第一帧')
    const hello1 = first.frames[0]?.frame ?? {}
    expect(hello1['type']).toBe('hello')
    expect(hello1['protocolVersion']).toBe(3)
    expect(hello1['port']).toBe(stubPort)
    expect(Array.isArray(hello1['methods'])).toBe(true)
    expect(arr(hello1['methods']).includes('submit')).toBe(true)
    expect(typeof hello1['pushPublicKey']).toBe('string')
    expect(typeof hello1['pushPublicKey'] === 'string' ? (hello1['pushPublicKey'] as string).length : 0).toBeGreaterThan(80)
  })

  test('不带 lastSeq 的新连接：hello 之后紧跟一帧全量', () => {
    const snapshot = frameOf(first, 1)
    expect(snapshot?.frame['full']).toBe(true)
    expect(snapshot?.frame['type']).toBe('snapshot')
  })

  test('全局 seq 跨连接连续：第二条连接把帧号接着往下推（不是各自从 1 数）', async () => {
    sawSeq1 = newestSeq(first)
    second = await openWs()
    await waitFor(() => newestSeq(second) > sawSeq1, '第二条连接触发的新帧')
    forced = newestSeq(second)
    expect(forced).toBe(sawSeq1 + 1)
    expect(frameOf(second, forced)?.frame['full']).toBe(true)
  })

  test('同一串帧发给所有连接（第一条连接也收到了第二条连接触发的那一帧，内容逐字节相同）', async () => {
    // 两条连接各自一个 socket，帧到达的先后不一定：先等第一条也收到这一帧
    const seenByFirst = await waitFor(() => frameOf(first, forced) !== undefined, '第一条连接收到同一帧')
    expect(seenByFirst).toBe(true)
    expect(frameOf(first, forced)?.text).toBe(frameOf(second, forced)?.text)
  })

  test('会话变化推的是增量帧（type=delta，added 里是那条新条目）', async () => {
    snapshotState = {
      ...snapshotState,
      entries: [...(snapshotState['entries'] as Array<Record<string, unknown>>), { id: 2, kind: 'text', text: '第二条' }],
    }
    emit()
    const deltaSeq = forced + 1
    const deltaOk = await waitFor(() => frameOf(second, deltaSeq) !== undefined, 'delta 帧')
    const delta = frameOf(second, deltaSeq)?.frame
    expect(deltaOk).toBe(true)
    expect(delta?.['type']).toBe('delta')
    expect(delta?.['full']).toBe(false)
    expect(arr(delta?.['added']).length).toBe(1)
    expect(rec(arr(delta?.['added'])[0])['id']).toBe(2)
    expect(rec(delta?.['meta'])['sessionId']).toBe('s1')
  })

  test('拔掉一条连接之后帧流继续前进（另一条还连着）', async () => {
    lastSeen = newestSeq(second)
    second.socket.close()
    await sleep(20)
    emit()
    const afterOne = await waitFor(() => newestSeq(first) > lastSeen, '断开期间第一帧')
    const midSeq = newestSeq(first)
    emit()
    const afterTwo = await waitFor(() => newestSeq(first) > midSeq, '断开期间第二帧')
    topSeq = newestSeq(first)
    expect(afterOne).toBe(true)
    expect(afterTwo).toBe(true)
    expect(topSeq).toBe(lastSeen + 2)
  })

  test('N 落在窗口内：补发 N 之后的所有缓冲帧，seq 与原帧一一对应', async () => {
    third = await openWs(lastSeen)
    const replayed = await waitFor(() => newestSeq(third) >= topSeq, '补帧')
    const replayedFrames = third.frames.filter((item) => item.frame['type'] !== 'hello')
    expect(replayed).toBe(true)
    expect(replayedFrames.length).toBe(2)
    expect(replayedFrames[0]?.frame['seq']).toBe(lastSeen + 1)
    expect(replayedFrames[1]?.frame['seq']).toBe(lastSeen + 2)
  })

  test('补的是原样的 JSON 文本（重发不重算：与当时发给另一条连接的字节一致）', () => {
    const replayedFrames = third.frames.filter((item) => item.frame['type'] !== 'hello')
    expect(replayedFrames[0]?.text).toBe(frameOf(first, lastSeen + 1)?.text)
    expect(replayedFrames[1]?.text).toBe(frameOf(first, lastSeen + 2)?.text)
  })

  test('补完帧之后转实时（后续新帧照常收到）', async () => {
    emit()
    liveSeq = topSeq + 1
    const live = await waitFor(() => frameOf(third, liveSeq) !== undefined, '补完转实时')
    expect(live).toBe(true)
    expect(frameOf(third, liveSeq)?.frame['type']).toBe('delta')
  })

  test('连造 121 帧后缓冲滚过最老那帧（缓冲仍是 120 帧）', async () => {
    // 环形缓冲：连造 121 帧，把最老那帧挤出窗口，然后用窗口外的 lastSeq 重连
    rolled = newestSeq(first)
    for (let i = 0; i < 121; i += 1) {
      emit()
      const before = rolled
      const advanced = await waitFor(() => newestSeq(first) > before, `第 ${String(i + 1)} 帧`)
      if (!advanced) break
      rolled = newestSeq(first)
    }
    expect(rolled).toBeGreaterThanOrEqual(liveSeq + 121)
  })

  test('lastSeq 在缓冲窗口之外 → 回落 hello + 一帧全量（不是一帧不发）', async () => {
    outside = await openWs(1)
    await waitFor(() => newestSeq(outside) >= rolled + 1, '窗口外回落')
    const outsideFrames = outside.frames.filter((item) => item.frame['type'] !== 'hello')
    expect(outsideFrames.length).toBeGreaterThanOrEqual(1)
    expect(outsideFrames[0]?.frame['full']).toBe(true)
    expect(outsideFrames[0]?.frame['type']).toBe('snapshot')
  })

  test('一条连接都没有时发生的变化：重连补完缓冲帧之后必须再补一帧全量', async () => {
    // 一条连接都没有时发生的变化：重连要补一帧全量对上
    for (const client of [first, third, outside]) client.socket.close()
    await sleep(30)
    emit()
    emit()
    const back = await openWs(rolled)
    const caught = await waitFor(() => frameOf(back, rolled + 2) !== undefined, '断线期间变化的全量补救')
    expect(caught).toBe(true)
    expect(frameOf(back, rolled + 2)?.frame['full']).toBe(true)
    back.socket.close()
  })
})
