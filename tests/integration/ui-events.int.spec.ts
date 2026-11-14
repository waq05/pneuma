/**
 * 界面数据通道（宿主 → 壳）的协议行为：帧序号不变量、断线补帧、全量帧广播、
 * 心跳 / 错误帧 / 连接上限、慢客户端背压（迁自 `scripts/ui-events-test.mjs`）。
 *
 * ## 被测的是什么
 *
 * 这一层出问题的形状都是「界面某个数字不动了，而且不报错」，所以断言钉死协议语义：
 *
 * 1. `@pneuma/ui-core/frames` 的序号不变量：首帧必须全量、回退 / 重复帧丢弃、
 *    增量跳号抛可识别的 `HostFrameGapError`（它仍是 `HostFrameError`）、全量帧跳号合法。
 * 2. **断线期间的变化不能丢**：一条连接都没有时不造帧，重连带 `last-event-id` 补到的
 *    必须是**全量帧**（`resume` 空数组那条路的回归），seq 只前进一格。
 * 3. **全量帧是全体共用的**：新连接引发的全量帧要广播给老连接（hub 的 diff 基准只有一份），
 *    三条连接最终状态一致、没人被踢。
 * 4. 心跳注释行、`retry: 3000`、造帧失败发 `event: error` 并记日志（同一原因只报一次）、
 *    超上限 503 且不占名额。
 * 5. 慢客户端（从不读响应）连续多帧写不进被断开，正常客户端不误伤。
 *
 * ## 落位与隔离
 *
 * 真服务 + 真数据通道（`createUiEvents` + `createUiServer`，端口 0 系统分配）；临时 HOME
 * 由 `tests/setup/temp-home.ts` 给，夹具目录 `mkdtempSync`。SSE 读的是**真连接**。
 *
 * ## 与探针的对应
 *
 * `check()` 一条对应一个 `test`；每段的服务生命周期在段首 `beforeAll` / 段内按探针次序
 * 跑，读数记进局部对象。轮询等待用 `waitFor`（坑 6：不用固定 sleep 判成败）。
 *
 * @module dsc/tests/integration/ui-events
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { HostFrameError, HostFrameGapError, applyHostFrame } from '@pneuma/ui-core/frames.js'
import { RemoteFrameHub, type FrameInput } from '@pneuma/runtime/core/remote/frames.js'
import { createUiEvents, type UiEventsHandle } from '@pneuma/runtime/core/ui-events.js'
import { createUiServer, type UiServerHandle } from '@pneuma/runtime/core/ui-server.js'

/** 夹具总目录；失败现场留着翻，成功时 afterAll 删。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-ui-events-'))

// 探针同款：环境里带了这几个变量会把基线改掉。
delete process.env.DSC_UI_SERVER
delete process.env.DSC_UI_ASSETS
delete process.env.DSC_UI_PORT

afterAll(() => {
  try {
    rmSync(WORK, { recursive: true, force: true })
  } catch {
    // 删不掉不影响结论：临时目录会被系统清。
  }
})

const sleep = (ms: number): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, ms))

/** 轮询等一个条件成立；超时就返回它当下（多半是 false）的值。 */
async function waitFor(condition: () => boolean, timeoutMs = 1500, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await sleep(stepMs)
  }
  return condition()
}

/** 造一个临时目录树；`files` 是相对路径 → 内容。 */
function makeTree(name: string, files: Record<string, string>): string {
  const dir = join(WORK, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, body)
  }
  return dir
}

/** 一条 HTTP 响应的读数。 */
interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** 发一个 HTTP 请求（要自定义 Host 头、Cookie 与请求体，所以用 node:http）。 */
function http(method: string, port: number, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

/** 假宿主：一份会变的快照 + 手动触发「宿主变了」的入口。 */
function makeHost(text: (tick: number) => string = (tick) => `第 ${String(tick)} 帧`): {
  snapshot: () => FrameInput & Record<string, unknown>
  subscribe: (onChange: () => void) => () => void
  notify: () => void
  setTick: (next: number) => void
} {
  let tick = 0
  const subscribers: Array<() => void> = []
  return {
    snapshot: () =>
    ({
      sessionId: 'sess-1',
      tick,
      entries: [{ id: 1, kind: 'user', text: text(tick) }],
      liveEntries: [],
    }) as unknown as FrameInput & Record<string, unknown>,
    subscribe: (onChange) => {
      subscribers.push(onChange)
      return () => {
        const at = subscribers.indexOf(onChange)
        if (at >= 0) subscribers.splice(at, 1)
      }
    },
    notify: () => {
      for (const notify of [...subscribers]) notify()
    },
    setTick: (next: number) => {
      tick = next
    },
  }
}

/** 一条 SSE 连接的读数。 */
interface SseStream {
  state: { text: string }
  close: () => void
}

/** 起一个真界面服务（带数据通道），返回端口、Cookie 与通道句柄。 */
async function startServer(options: {
  host: ReturnType<typeof makeHost>
  throttleMs?: number
  heartbeatMs?: number
  maxClients?: number
  snapshot?: () => FrameInput & Record<string, unknown>
  log?: (line: string) => void
}): Promise<{ events: UiEventsHandle; port: number; cookie: string; close: () => Promise<void> }> {
  let treeSeq = 0
  const assetsDir = makeTree(`events-assets-${String(++treeSeq)}`, {
    'index.html': '<!doctype html><html><body>壳</body></html>',
  })
  const pluginsDir = makeTree(`events-plugins-${String(treeSeq)}`, {
    'manifest.json': JSON.stringify({ version: 1, plugins: [] }),
  })
  const events = createUiEvents({
    snapshot: options.snapshot ?? options.host.snapshot,
    invoke: async (method, args) => ({ method, args }),
    methods: ['ping'],
    hello: () => ({ protocolVersion: 1, methods: ['ping'], host: { name: 'Pneuma', version: 'test' } }),
    subscribe: options.host.subscribe,
    log: options.log ?? ((): void => {}),
    ...(options.throttleMs === undefined ? {} : { throttleMs: options.throttleMs }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.maxClients === undefined ? {} : { maxClients: options.maxClients }),
  })
  const server = await createUiServer({
    host: { name: 'Pneuma', version: 'test' },
    assetsDir,
    pluginsDir,
    events,
    log: () => {},
  })
  const token = new URL(server.url).searchParams.get('token') ?? ''
  const handshake = await http('GET', server.port, `/?token=${token}`)
  const cookie = String(handshake.headers['set-cookie']?.[0] ?? '').split(';')[0]
  return {
    events,
    port: server.port,
    cookie,
    close: async () => {
      events.stop()
      await server.close()
    },
  }
}

/** 开一条 SSE 连接，收一小段文本。 */
function sseOpener(port: number): (headers?: Record<string, string>) => Promise<SseStream> {
  return async (headers = {}) => {
    const state = { text: '' }
    const req = request(
      { host: '127.0.0.1', port, method: 'GET', path: '/api/events', headers, agent: false },
      (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          state.text += chunk
        })
      },
    )
    // 主动断开时 socket 可能报 ECONNRESET：这里吞掉，别让它把测试进程带走
    req.on('error', () => {})
    req.end()
    await sleep(120)
    return { state, close: (): void => {
      req.destroy()
    } }
  }
}

/** 把 SSE 文本拆成帧对象（只取 `event: frame` 的 data）。 */
function readFrames(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const block of text.split('\n\n')) {
    let event = ''
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (event === 'frame' && data !== '') out.push(JSON.parse(data) as Record<string, unknown>)
  }
  return out
}

/** 模拟壳：把收到的帧按序并起来。缺口/认不出时返回带 failed 的标记（断言会报出来）。 */
function settle(text: string): Record<string, unknown> | null {
  try {
    return readFrames(text).reduce<Record<string, unknown> | null>(
      (state, frame) => applyHostFrame(state as never, frame) as unknown as Record<string, unknown>,
      null,
    )
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) }
  }
}

// ── 1. 帧归并的序号不变量（P1-3） ───────────────────────────────────────────────
describe('帧归并的序号不变量（applyHostFrame）', () => {
  const hub = new RemoteFrameHub()
  const snap = (text: string): FrameInput & Record<string, unknown> =>
    ({
      sessionId: 's-1',
      entries: [{ id: 1, kind: 'user', text }],
      liveEntries: [],
    }) as unknown as FrameInput & Record<string, unknown>
  const full = JSON.parse(hub.build(snap('甲'), true).text) as Record<string, unknown>
  const delta = JSON.parse(hub.build(snap('乙'), false).text) as Record<string, unknown>
  const state = applyHostFrame(null, full)

  test('第一帧是增量帧时当场报错，报错说清是「首帧必须全量」这条规则', () => {
    expect(() => applyHostFrame(null, delta)).toThrow(HostFrameError)
    expect(() => applyHostFrame(null, delta)).toThrow(/全量/)
  })

  test('第一帧是全量帧时成功', () => {
    expect(applyHostFrame(null, full).entries.length).toBe(1)
  })

  test('回退帧被丢弃（返回原状态）', () => {
    expect(applyHostFrame(state, { ...full, seq: (full['seq'] as number) - 1 })).toBe(state)
  })

  test('重复帧被丢弃（返回原状态）', () => {
    expect(applyHostFrame(state, { ...full })).toBe(state)
  })

  test('增量跳号抛可识别的 HostFrameGapError，缺口错误仍是 HostFrameError', () => {
    const gap = (): unknown =>
      applyHostFrame(state, {
        type: 'delta',
        full: false,
        seq: state.seq + 5,
        meta: {},
        added: [],
        updated: [],
        removedIds: [],
        liveEntries: [],
      })
    expect(gap).toThrow(HostFrameGapError)
    expect(gap).toThrow(HostFrameError)
  })

  test('全量帧跳号不算缺口（它自带完整状态），跳号之后接着收增量也认', () => {
    const jumped = applyHostFrame(state, { ...full, seq: state.seq + 9 })
    expect(jumped.seq).toBe(state.seq + 9)
    expect(applyHostFrame(jumped, { ...delta, seq: jumped.seq + 1 }).seq).toBe(jumped.seq + 1)
  })
})

// ── 2. 断线期间的变化不许丢（P0-1） ─────────────────────────────────────────────
describe('断线期间发生的变化（P0-1）', () => {
  const facts: Record<string, unknown> = {}

  beforeAll(async () => {
    const host = makeHost()
    const harness = await startServer({ host, throttleMs: 20 })
    const open = sseOpener(harness.port)

    const first = await open({ cookie: harness.cookie })
    const firstFrames = readFrames(first.state.text)
    facts['firstFull'] = firstFrames.length === 1 && firstFrames[0]?.['full'] === true
    facts['firstSeqType'] = typeof firstFrames[0]?.['seq']
    const lastSeq = firstFrames[0]?.['seq'] as number

    first.close()
    facts['clientsDropped'] = await waitFor(() => harness.events.clients === 0)

    // 一条连接都没有的时候宿主变了一次：这时不造帧，于是 hub 的 seq 不前进，
    // 重连时 resume(lastSeq) 返回的是空数组——只判 null 的实现会一帧都不补。
    host.setTick(1)
    host.notify()
    await sleep(80)

    const back = await open({ cookie: harness.cookie, 'last-event-id': String(lastSeq) })
    const backFrames = readFrames(back.state.text)
    facts['backFull'] = backFrames.length === 1 && backFrames[0]?.['full'] === true
    facts['backText'] = (backFrames[0]?.['entries'] as Array<{ text?: string }> | undefined)?.[0]?.text
    facts['backSeq'] = backFrames[0]?.['seq']
    facts['settledText'] = (settle(back.state.text)?.['entries'] as Array<{ text?: string }> | undefined)?.[0]?.text
    back.close()
    await harness.close()
    facts['lastSeq'] = lastSeq
  })

  test('接上先给一帧全量，全量帧带 seq', () => {
    expect(facts['firstFull']).toBe(true)
    expect(facts['firstSeqType']).toBe('number')
  })
  test('客户端断开后宿主摘掉这条连接', () => {
    expect(facts['clientsDropped']).toBe(true)
  })
  test('重连带 last-event-id 时补到的是全量帧（不是「补了个空数组」）', () => {
    expect(facts['backFull']).toBe(true)
  })
  test('补的这一帧是最新状态（断线期间的变化补上了）', () => {
    expect(facts['backText']).toBe('第 1 帧')
  })
  test('空转期间确实没造帧（seq 只前进一格）', () => {
    expect(facts['backSeq']).toBe((facts['lastSeq'] as number) + 1)
  })
  test('壳把这一帧并进去就是最新状态', () => {
    expect(facts['settledText']).toBe('第 1 帧')
  })
})

// ── 3. 全量帧必须广播给全体（P0-2） ─────────────────────────────────────────────
describe('新连接引发的全量帧要广播给全体（P0-2）', () => {
  const facts: Record<string, unknown> = {}
  const streams: SseStream[] = []

  beforeAll(async () => {
    const host = makeHost()
    // 节流窗口拉长到 400 毫秒：这样「宿主变了但还没进帧流」这段一定存在，
    // 新连接正是在这个窗口里插进来的（现实里就是一个新标签页刚被打开）。
    const harness = await startServer({ host, throttleMs: 400 })
    const open = sseOpener(harness.port)

    const a = await open({ cookie: harness.cookie })
    const b = await open({ cookie: harness.cookie })
    streams.push(a, b)
    facts['aAndBFull'] = readFrames(a.state.text).at(-1)?.['full'] === true && readFrames(b.state.text).at(-1)?.['full'] === true

    host.setTick(1)
    host.notify()
    // 趁节流没到点，第三个连接插进来：它接不上缓冲，宿主会造一帧全量
    const c = await open({ cookie: harness.cookie })
    streams.push(c)
    const broadcast = readFrames(c.state.text).at(-1)
    facts['cFull'] = broadcast?.['full'] === true
    facts['cText'] = (broadcast?.['entries'] as Array<{ text?: string }> | undefined)?.[0]?.text

    // 等节流那一帧真的到点（它现在算出来是「相对新基准没有变化」）
    await sleep(700)
    facts['aGotBroadcast'] = readFrames(a.state.text).some((frame) => frame['seq'] === broadcast?.['seq'] && frame['full'] === true)
    facts['bGotBroadcast'] = readFrames(b.state.text).some((frame) => frame['seq'] === broadcast?.['seq'] && frame['full'] === true)

    const settleOf = (stream: SseStream): string | undefined =>
      (settle(stream.state.text)?.['entries'] as Array<{ text?: string }> | undefined)?.[0]?.text
    facts['aFinal'] = settleOf(a)
    facts['bFinal'] = settleOf(b)
    facts['cFinal'] = settleOf(c)
    facts['aAndBEqual'] = JSON.stringify(settle(a.state.text)?.['entries']) === JSON.stringify(settle(b.state.text)?.['entries'])
    facts['clients'] = harness.events.clients

    for (const stream of streams.splice(0)) stream.close()
    await harness.close()
  })

  test('两条连接各自拿到全量帧', () => {
    expect(facts['aAndBFull']).toBe(true)
  })
  test('新连接拿到的这一帧是全量，且带着刚发生的变化', () => {
    expect(facts['cFull']).toBe(true)
    expect(facts['cText']).toBe('第 1 帧')
  })
  test('两个老连接都收到了那一帧全量（帧号一模一样）', () => {
    expect(facts['aGotBroadcast']).toBe(true)
    expect(facts['bGotBroadcast']).toBe(true)
  })
  test('三条连接的最终状态都是最新的（条目没丢）', () => {
    expect(facts['aFinal']).toBe('第 1 帧')
    expect(facts['bFinal']).toBe('第 1 帧')
    expect(facts['cFinal']).toBe('第 1 帧')
  })
  test('两个老连接的最终状态逐字节一致', () => {
    expect(facts['aAndBEqual']).toBe(true)
  })
  test('三条连接都还在（没有谁被踢掉）', () => {
    expect(facts['clients']).toBe(3)
  })
})

// ── 4. 心跳、造帧失败、连接上限 ────────────────────────────────────────────────
describe('心跳、错误帧、连接上限', () => {
  const facts: Record<string, unknown> = {}
  let a: SseStream
  let b: SseStream
  let c: SseStream
  let harness: Awaited<ReturnType<typeof startServer>>

  beforeAll(async () => {
    const host = makeHost()
    const logs: string[] = []
    let snapshotOk = true
    const brokenSnapshot = { sessionId: 'sess-1', tick: 9, entries: 3, liveEntries: [] } // entries 不是数组 → 造帧会抛
    harness = await startServer({
      host,
      snapshot: () => (snapshotOk ? host.snapshot() : (brokenSnapshot as unknown as FrameInput & Record<string, unknown>)),
      throttleMs: 20,
      heartbeatMs: 60,
      maxClients: 3,
      log: (line) => logs.push(line),
    })
    const open = sseOpener(harness.port)

    a = await open({ cookie: harness.cookie })
    facts['retry3000'] = a.state.text.includes('retry: 3000')
    facts['keepAlive'] = await waitFor(() => a.state.text.includes(': keep-alive'), 1200)

    snapshotOk = false
    host.setTick(1)
    host.notify()
    await sleep(150)
    facts['errorEvent'] = a.state.text.includes('event: error')
    facts['errorPayload'] = /event: error\ndata: \{"error":".+"\}/.test(a.state.text)
    facts['errorLogged'] = logs.some((line) => line.includes('造帧失败'))
    facts['clientsAfterError'] = harness.events.clients

    const errorsSoFar = (a.state.text.match(/event: error/g) ?? []).length
    host.setTick(2)
    host.notify()
    await sleep(150)
    facts['errorOnce'] = (a.state.text.match(/event: error/g) ?? []).length === errorsSoFar

    snapshotOk = true
    host.setTick(3)
    host.notify()
    await sleep(150)
    facts['resumedFrames'] = readFrames(a.state.text).some((frame) => JSON.stringify(frame).includes('第 3 帧'))

    b = await open({ cookie: harness.cookie })
    c = await open({ cookie: harness.cookie })
    facts['clientsAtLimit'] = harness.events.clients
    const denied = await http('GET', harness.port, '/api/events', { cookie: harness.cookie })
    facts['overLimit'] = denied.status
    facts['overLimitLogged'] = logs.some((line) => line.includes('上限'))
    facts['clientsAfterDeny'] = harness.events.clients
    facts['logs'] = logs.join(' | ')
  })

  afterAll(async () => {
    a.close()
    b.close()
    c.close()
    await harness.close()
  })

  test('流的 retry 是 3000 毫秒（500 会打成重连风暴）', () => {
    expect(facts['retry3000'], String(facts['logs'])).toBe(true)
  })
  test('心跳注释行按时到达', () => {
    expect(facts['keepAlive'], String(facts['logs'])).toBe(true)
  })
  test('造帧失败给页面发 event: error（不再静默吞掉），错误事件里带得出原因', () => {
    expect(facts['errorEvent'], String(facts['logs'])).toBe(true)
    expect(facts['errorPayload'], String(facts['logs'])).toBe(true)
  })
  test('造帧失败记了日志，且不会把已经连上的页面弄断', () => {
    expect(facts['errorLogged'], String(facts['logs'])).toBe(true)
    expect(facts['clientsAfterError']).toBe(1)
  })
  test('同一个原因只报一次（不刷屏）', () => {
    expect(facts['errorOnce']).toBe(true)
  })
  test('快照恢复正常后继续推帧', () => {
    expect(facts['resumedFrames']).toBe(true)
  })
  test('上限之内还能连（第 2、3 条）；超上限回 503 且不占名额', () => {
    expect(facts['clientsAtLimit']).toBe(3)
    expect(facts['overLimit']).toBe(503)
    expect(facts['clientsAfterDeny']).toBe(3)
  })
  test('超限记了日志', () => {
    expect(facts['overLimitLogged'], String(facts['logs'])).toBe(true)
  })
})

// ── 5. 慢客户端被断开（写背压） ────────────────────────────────────────────────
describe('慢客户端不把帧堆在宿主内存里（背压）', () => {
  const facts: Record<string, unknown> = {}
  let watcher: SseStream
  let slow: ReturnType<typeof connect> | null = null
  let harness: Awaited<ReturnType<typeof startServer>>

  beforeAll(async () => {
    const host = makeHost((tick) => `第 ${String(tick)} 帧 ${'x'.repeat(2 * 1024 * 1024)}`)
    harness = await startServer({ host, throttleMs: 5, heartbeatMs: 60_000 })
    const open = sseOpener(harness.port)

    watcher = await open({ cookie: harness.cookie })
    facts['watcherRegistered'] = harness.events.clients === 1

    // 一条只发请求、从不读响应的连接：它的写缓冲一定会满
    slow = connect(harness.port, '127.0.0.1')
    await new Promise<void>((resolveConnected) => slow?.once('connect', resolveConnected))
    slow.on('error', () => {})
    slow.pause()
    slow.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${String(harness.port)}\r\nCookie: ${harness.cookie}\r\n\r\n`)
    await sleep(150)
    facts['slowRegistered'] = harness.events.clients === 2

    for (let i = 0; i < 6; i += 1) {
      host.setTick(i + 1)
      host.notify()
      // 间隔给足：正常客户端能排空写缓冲（所以它不该被误伤），慢客户端永远排不空
      await sleep(120)
    }
    facts['slowDisconnected'] = await waitFor(() => harness.events.clients === 1, 3000)
    facts['clientsAtEnd'] = harness.events.clients
  })

  afterAll(async () => {
    slow?.destroy()
    watcher.close()
    await harness.close()
  })

  test('正常客户端已经登记', () => {
    expect(facts['watcherRegistered']).toBe(true)
  })
  test('慢客户端也被登记了', () => {
    expect(facts['slowRegistered']).toBe(true)
  })
  test('连续多帧写不进就断开它（不再无限堆帧）', () => {
    expect(facts['slowDisconnected'], `clients=${String(facts['clientsAtEnd'])}`).toBe(true)
  })
  test('正常客户端没被误伤', () => {
    expect(facts['clientsAtEnd']).toBe(1)
  })
})
