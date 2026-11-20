/**
 * `core/ui-events.ts` 的缺口补齐：启动图 / 旁问两条「不补帧」通道、派发错误、连接上限的
 * 默认日志，以及一批**只有客户端异常时才走到**的防御分支（连接已结束、写抛错、序列化失败）。
 *
 * ## 两段夹具，各有各的必要
 *
 * 1. **真服务（`node:http` 端口 0）**：正常协议（握手、帧、plugins / ask 事件、invoke 的四类
 *    错误体）只有走真连接才证明得了「浏览器那边收到的是什么字节」。
 * 2. **手写 `ServerResponse` 形状的对象**：`res.write()` 抛错、`writableEnded`、循环引用的帧
 *    ——这些在真 socket 上要么造不出来、要么要制造内核级故障才碰得到。被测函数不 mock：
 *    这些对象只是驱动 `createUiEvents` 的输入，断言的是它自己的日志与连接表变化。
 *
 * @module dsc/core/w13-ui-events-extra.spec
 */
import { EventEmitter } from 'node:events'
import { createServer, request, type Server } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createUiEvents, sendUnauthorized, type UiEventsHandle } from './ui-events.js'
import type { FrameInput } from './remote/frames.js'

const sleep = (ms: number): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, ms))

/** 一份会变的快照（帧 hub 按它算增量）。 */
function makeSnapshot(): { snapshot: () => FrameInput & Record<string, unknown>; bump: () => void; subscribe: (fn: () => void) => () => void } {
  let tick = 0
  const subscribers: Array<() => void> = []
  return {
    snapshot: () =>
      ({
        sessionId: 'sess-w13',
        tick,
        entries: [{ id: 1, kind: 'user', text: `第 ${String(tick)} 帧` }],
        liveEntries: [],
      }) as unknown as FrameInput & Record<string, unknown>,
    bump: () => {
      tick += 1
      for (const subscriber of [...subscribers]) subscriber()
    },
    subscribe: (fn) => {
      subscribers.push(fn)
      return () => {
        const at = subscribers.indexOf(fn)
        if (at >= 0) subscribers.splice(at, 1)
      }
    },
  }
}

/** 起一个真 http 服务，把两个入口挂上去；返回端口。 */
async function startEvents(
  options: Parameters<typeof createUiEvents>[0],
): Promise<{ server: Server; events: UiEventsHandle; port: number }> {
  const events = createUiEvents(options)
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/events') === true) events.handleEvents(req, res)
    else if (req.url === '/api/invoke') void events.handleInvoke(req, res)
    else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  return { server, events, port }
}

/** 发一个 HTTP 请求，收完整响应。 */
function http(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolveDone, rejectDone) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json' }, agent: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolveDone({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', rejectDone)
    req.end(body)
  })
}

/** 开一条 SSE 连接，文本累积在 `state.text` 里。 */
async function openSse(port: number, headers: Record<string, string> = {}): Promise<{ state: { text: string }; close: () => void }> {
  const state = { text: '' }
  const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/api/events', headers, agent: false }, (res) => {
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      state.text += chunk
    })
  })
  req.on('error', () => {})
  req.end()
  await sleep(150)
  return {
    state,
    close: () => {
      req.destroy()
    },
  }
}

// ── 1. 真连接上的三条事件通道 ───────────────────────────────────────────────────
describe('真服务：帧、启动图、旁问三条事件通道', () => {
  let server: Server | null = null
  let events: UiEventsHandle | null = null
  let stream: { state: { text: string }; close: () => void } | null = null

  afterEach(async () => {
    stream?.close()
    stream = null
    events?.stop()
    events = null
    if (server !== null) await new Promise<void>((resolveClose) => server?.close(() => resolveClose()))
    server = null
  })

  test('握手（hello/retry）→ 首帧全量 → 宿主变化推增量帧；启动图与旁问各自走独立事件名', async () => {
    const snap = makeSnapshot()
    const pluginsListeners: Array<(frame: unknown) => void> = []
    const askListeners: Array<(chunk: unknown) => void> = []
    const started = await startEvents({
      snapshot: snap.snapshot,
      invoke: async (method, args) => ({ method, args }),
      methods: ['ping'],
      hello: () => ({ protocolVersion: 1, methods: ['ping'] }),
      subscribe: snap.subscribe,
      plugins: {
        initial: () => ({ entries: [{ id: 'demo' }], changed: [], removed: [] }),
        subscribe: (listener) => {
          pluginsListeners.push(listener)
          return () => {
            const at = pluginsListeners.indexOf(listener)
            if (at >= 0) pluginsListeners.splice(at, 1)
          }
        },
      },
      ask: {
        subscribe: (listener) => {
          askListeners.push(listener)
          return () => {
            const at = askListeners.indexOf(listener)
            if (at >= 0) askListeners.splice(at, 1)
          }
        },
      },
      throttleMs: 20,
      heartbeatMs: 60_000,
    })
    server = started.server
    events = started.events
    stream = await openSse(started.port)

    expect(stream.state.text).toContain('retry: 3000')
    expect(stream.state.text).toContain('event: hello')
    expect(stream.state.text).toContain('event: frame')
    expect(stream.state.text).toContain('"full":true')

    // 启动图初始帧：紧跟 hello 之后单独一条事件，不进帧 hub（没有 seq）。
    expect(stream.state.text).toContain('event: plugins')
    expect(stream.state.text).toContain('"demo"')

    // 旁问增量：直接广播，不进帧 hub。
    askListeners[0]?.({ delta: '半个答案' })
    await sleep(30)
    expect(stream.state.text).toContain('event: ask')
    expect(stream.state.text).toContain('半个答案')

    // 启动图变更帧。
    pluginsListeners[0]?.({ entries: [{ id: 'demo2' }], changed: ['demo2'], removed: [] })
    await sleep(30)
    expect(stream.state.text).toContain('demo2')

    // 宿主变化 → 节流后推一帧增量。
    snap.bump()
    await sleep(120)
    expect(stream.state.text).toContain('第 1 帧')
  })

  test('invoke 的四类错误体：坏 JSON / 非对象 / 缺 method / 不在白名单 / 方法抛错', async () => {
    const started = await startEvents({
      snapshot: makeSnapshot().snapshot,
      invoke: async (method) => {
        if (method === 'boom') throw new Error('方法内部炸了')
        return { ok: 'yes' }
      },
      methods: ['ping', 'boom'],
      hello: () => ({ protocolVersion: 1 }),
      subscribe: () => () => {},
      heartbeatMs: 60_000,
    })
    server = started.server
    events = started.events

    const badJson = await http(started.port, 'POST', '/api/invoke', '{not json')
    expect(badJson.status).toBe(400)
    expect(badJson.body).toContain('请求体不是 JSON')

    const notObject = await http(started.port, 'POST', '/api/invoke', '[1,2,3]')
    expect(notObject.status).toBe(400)
    expect(notObject.body).toContain('请求体必须是对象')

    const noMethod = await http(started.port, 'POST', '/api/invoke', '{}')
    expect(noMethod.status).toBe(400)
    expect(noMethod.body).toContain('缺少 method')

    const notAllowed = await http(started.port, 'POST', '/api/invoke', JSON.stringify({ method: 'rm-rf' }))
    expect(notAllowed.status).toBe(403)
    expect(notAllowed.body).toContain('协议不允许调用')

    const ok = await http(started.port, 'POST', '/api/invoke', JSON.stringify({ method: 'ping', args: [1] }))
    expect(ok.status).toBe(200)
    expect(ok.body).toContain('"ok":true')

    // 方法抛错仍是 HTTP 200 + ok:false（客户端只看 ok，不必区分协议错与方法错）。
    const failed = await http(started.port, 'POST', '/api/invoke', JSON.stringify({ method: 'boom' }))
    expect(failed.status).toBe(200)
    expect(failed.body).toContain('"ok":false')
    expect(failed.body).toContain('方法内部炸了')
  })

  test('空请求体按 {} 处理；还须能取到具体方法的执行结果', async () => {
    const started = await startEvents({
      snapshot: makeSnapshot().snapshot,
      invoke: async (method, args) => ({ method, args }),
      methods: ['ping'],
      hello: () => ({}),
      subscribe: () => () => {},
      heartbeatMs: 60_000,
    })
    server = started.server
    events = started.events
    const empty = await http(started.port, 'POST', '/api/invoke', '')
    expect(empty.status).toBe(400)
    expect(empty.body).toContain('缺少 method')
    const called = await http(started.port, 'POST', '/api/invoke', JSON.stringify({ method: 'ping', args: 'not-array' }))
    expect(called.status).toBe(200)
    expect(called.body).toContain('"args":[]')
  })

  test('连接数超上限回 503（默认日志写 stderr），且不占名额', async () => {
    const started = await startEvents({
      snapshot: makeSnapshot().snapshot,
      invoke: async () => null,
      methods: ['ping'],
      hello: () => ({}),
      subscribe: () => () => {},
      maxClients: 0,
      heartbeatMs: 60_000,
    })
    server = started.server
    events = started.events
    const denied = await http(started.port, 'GET', '/api/events')
    expect(denied.status).toBe(503)
    expect(events.clients).toBe(0)
  })

  test('sendUnauthorized：没凭据的回话是 401 + 中文说明', async () => {
    const chunks: string[] = []
    let status = 0
    const res = {
      writeHead(code: number) {
        status = code
        return this
      },
      end(body?: string) {
        if (body !== undefined) chunks.push(body)
        return this
      },
    } as unknown as ServerResponse
    sendUnauthorized(res)
    expect(status).toBe(401)
    expect(chunks.join('')).toContain('需要界面凭据')
  })
})

// ── 2. 客户端异常时的防御分支（手写 ServerResponse 形状） ─────────────────────────
/** 一个够 `createUiEvents` 用的假响应：可控制 `write()` 抛不抛、是否已结束。 */
class FakeRes extends EventEmitter {
  writableEnded = false
  destroyed = false
  status = 0
  body = ''
  /** write 调用序号（从 1 起）；命中的序号抛错。 */
  throwOnWriteCall: number | null = null
  writeCalls = 0

  writeHead(code: number): this {
    this.status = code
    return this
  }

  write(chunk: string): boolean {
    this.writeCalls += 1
    if (this.throwOnWriteCall !== null && this.writeCalls === this.throwOnWriteCall) throw new Error('写失败（对端没了）')
    this.body += chunk
    return true
  }

  end(): this {
    this.writableEnded = true
    return this
  }
}

/** 一个够 `handleEvents` 用的假请求。 */
class FakeReq extends EventEmitter {
  url = '/api/events'
  headers: Record<string, string> = {}
  method = 'GET'
}

/** 把一条假连接登记进通道（走真正的 handleEvents 入口，不越过它）。 */
function registerFake(events: UiEventsHandle): { res: FakeRes; req: FakeReq } {
  const res = new FakeRes()
  const req = new FakeReq()
  events.handleEvents(req as unknown as IncomingMessage, res as unknown as ServerResponse)
  return { res, req }
}

describe('客户端异常时的防御分支', () => {
  test('连接已结束（writableEnded）：广播时摘掉它，不往上写', async () => {
    const logs: string[] = []
    const snap = makeSnapshot()
    const events = createUiEvents({
      snapshot: snap.snapshot,
      invoke: async () => null,
      methods: [],
      hello: () => ({}),
      subscribe: snap.subscribe,
      throttleMs: 5,
      heartbeatMs: 60_000,
      log: (line) => logs.push(line),
    })
    const { res } = registerFake(events)
    res.writableEnded = true
    snap.bump()
    await sleep(60)
    expect(events.clients).toBe(0)
    events.stop()
  })

  test('写帧抛错（对端在写之前没了）：摘掉连接，不把异常抛给宿主', async () => {
    const snap = makeSnapshot()
    const events = createUiEvents({
      snapshot: snap.snapshot,
      invoke: async () => null,
      methods: [],
      hello: () => ({}),
      subscribe: snap.subscribe,
      throttleMs: 5,
      heartbeatMs: 60_000,
      log: () => {},
    })
    const { res } = registerFake(events)
    expect(events.clients).toBe(1)
    // 握手写了两笔（retry、hello），第三笔（帧）开始抛：正是 writeFrame 的 catch。
    res.throwOnWriteCall = res.writeCalls + 1
    snap.bump()
    await sleep(60)
    expect(events.clients).toBe(0)
    events.stop()
  })

  test('造帧失败时给页面发 event: error；写这条错误帧也失败就摘连接', async () => {
    const logs: string[] = []
    const snap = makeSnapshot()
    let broken = false
    const events = createUiEvents({
      snapshot: () => (broken ? ({ entries: 3 } as unknown as FrameInput & Record<string, unknown>) : snap.snapshot()),
      invoke: async () => null,
      methods: [],
      hello: () => ({}),
      subscribe: snap.subscribe,
      throttleMs: 5,
      heartbeatMs: 60_000,
      log: (line) => logs.push(line),
    })
    const { res } = registerFake(events)
    broken = true
    res.throwOnWriteCall = res.writeCalls + 1
    snap.bump()
    await sleep(60)
    expect(logs.some((line) => line.includes('造帧失败'))).toBe(true)
    expect(events.clients).toBe(0)
    events.stop()
  })

  test('响应 error 事件与请求 close 事件都会摘连接', async () => {
    const snap = makeSnapshot()
    const events = createUiEvents({
      snapshot: snap.snapshot,
      invoke: async () => null,
      methods: [],
      hello: () => ({}),
      subscribe: snap.subscribe,
      heartbeatMs: 60_000,
      log: () => {},
    })
    const first = registerFake(events)
    expect(events.clients).toBe(1)
    first.res.emit('error', new Error('socket 级错误'))
    expect(events.clients).toBe(0)

    const second = registerFake(events)
    expect(events.clients).toBe(1)
    second.req.emit('close')
    expect(events.clients).toBe(0)
    events.stop()
  })

  test('攒帧期间页面全走了：节流到点发现没人，按「漏过变化」记账而不是空转', async () => {
    const snap = makeSnapshot()
    const events = createUiEvents({
      snapshot: snap.snapshot,
      invoke: async () => null,
      methods: [],
      hello: () => ({}),
      subscribe: snap.subscribe,
      throttleMs: 40,
      heartbeatMs: 60_000,
      log: () => {},
    })
    const { req } = registerFake(events)
    snap.bump() // 起一个节流定时器
    req.emit('close') // 定时器到点前连接走了
    expect(events.clients).toBe(0)
    await sleep(120)
    // 再进来的连接：拿到的必须是全量帧（漏过变化已记账），而不是空白。
    const back = registerFake(events)
    expect(events.clients).toBe(1)
    expect(back.res.body).toContain('"full":true')
    events.stop()
  })

  test('启动图初始帧序列化失败只记日志，不影响握手', async () => {
    const logs: string[] = []
    const snap = makeSnapshot()
    const events = createUiEvents({
      snapshot: snap.snapshot,
      invoke: async () => null,
      methods: [],
      hello: () => ({}),
      subscribe: snap.subscribe,
      plugins: {
        initial: () => {
          throw new Error('图坏了')
        },
        subscribe: () => () => {},
      },
      heartbeatMs: 60_000,
      log: (line) => logs.push(line),
    })
    const { res } = registerFake(events)
    expect(logs.some((line) => line.includes('启动图初始帧序列化失败'))).toBe(true)
    expect(res.body).toContain('event: hello')
    expect(events.clients).toBe(1)
    events.stop()
  })

  test('启动图变更帧序列化失败：丢弃这一帧并记日志；旁问增量同理（静默丢弃）', async () => {
    const logs: string[] = []
    const snap = makeSnapshot()
    const pluginListeners: Array<(frame: unknown) => void> = []
    const askListeners: Array<(chunk: unknown) => void> = []
    const events = createUiEvents({
      snapshot: snap.snapshot,
      invoke: async () => null,
      methods: [],
      hello: () => ({}),
      subscribe: snap.subscribe,
      plugins: {
        initial: () => ({}),
        subscribe: (listener) => {
          pluginListeners.push(listener)
          return () => {}
        },
      },
      ask: {
        subscribe: (listener) => {
          askListeners.push(listener)
          return () => {}
        },
      },
      heartbeatMs: 60_000,
      log: (line) => logs.push(line),
    })
    const { res } = registerFake(events)
    const circular: Record<string, unknown> = {}
    circular['self'] = circular

    pluginListeners[0]?.(circular)
    expect(logs.some((line) => line.includes('启动图帧序列化失败'))).toBe(true)
    askListeners[0]?.(circular)
    // 循环引用这一帧被丢掉，没写进连接。
    expect(res.body).not.toContain('event: ask')
    events.stop()
  })

  test('启动图 / 旁问变更帧写不进（连接已结束、写抛错）时摘连接', async () => {
    const snap = makeSnapshot()
    const pluginListeners: Array<(frame: unknown) => void> = []
    const askListeners: Array<(chunk: unknown) => void> = []
    const events = createUiEvents({
      snapshot: snap.snapshot,
      invoke: async () => null,
      methods: [],
      hello: () => ({}),
      subscribe: snap.subscribe,
      plugins: {
        initial: () => ({}),
        subscribe: (listener) => {
          pluginListeners.push(listener)
          return () => {}
        },
      },
      ask: {
        subscribe: (listener) => {
          askListeners.push(listener)
          return () => {}
        },
      },
      heartbeatMs: 60_000,
      log: () => {},
    })

    const ended = registerFake(events)
    ended.res.writableEnded = true
    pluginListeners[0]?.({ ok: 1 })
    askListeners[0]?.({ ok: 1 })
    expect(events.clients).toBe(0)

    const throwing = registerFake(events)
    throwing.res.throwOnWriteCall = throwing.res.writeCalls + 1
    pluginListeners[0]?.({ ok: 1 })
    expect(events.clients).toBe(0)

    const throwingAsk = registerFake(events)
    throwingAsk.res.throwOnWriteCall = throwingAsk.res.writeCalls + 1
    askListeners[0]?.({ ok: 1 })
    expect(events.clients).toBe(0)
    events.stop()
  })

  test('心跳：已结束的连接摘掉，写心跳抛错的也摘掉，正常连接继续收 keep-alive', async () => {
    const snap = makeSnapshot()
    const events = createUiEvents({
      snapshot: snap.snapshot,
      invoke: async () => null,
      methods: [],
      hello: () => ({}),
      subscribe: snap.subscribe,
      heartbeatMs: 25,
      log: () => {},
    })
    const ended = registerFake(events)
    ended.res.writableEnded = true
    await sleep(80)
    expect(events.clients).toBe(0)

    const throwing = registerFake(events)
    throwing.res.throwOnWriteCall = throwing.res.writeCalls + 1
    await sleep(80)
    expect(events.clients).toBe(0)

    const healthy = registerFake(events)
    await sleep(80)
    expect(healthy.res.body).toContain(': keep-alive')
    expect(events.clients).toBe(1)
    events.stop()
  })

  test('重连补帧时写不进去：停止补发并摘连接', async () => {
    const snap = makeSnapshot()
    const events = createUiEvents({
      snapshot: snap.snapshot,
      invoke: async () => null,
      methods: [],
      hello: () => ({}),
      subscribe: snap.subscribe,
      throttleMs: 5,
      heartbeatMs: 60_000,
      log: () => {},
    })
    // 先造出两帧进缓冲（seq 1、2）。
    const live = registerFake(events)
    snap.bump()
    await sleep(40)
    snap.bump()
    await sleep(40)
    expect(live.res.body).toContain('event: frame')

    // 再拿一条「重连」的假连接：带 last-event-id，补帧第一笔就抛错。
    const res = new FakeRes()
    const req = new FakeReq()
    req.headers = { 'last-event-id': '1' }
    res.throwOnWriteCall = 4 // retry、hello、补的第一帧……按实现笔数设，写失败即走 catch
    events.handleEvents(req as unknown as IncomingMessage, res as unknown as ServerResponse)
    await sleep(30)
    expect(events.clients).toBe(1) // 只剩先前那条 live；重连这条被摘掉
    events.stop()
  })
})
