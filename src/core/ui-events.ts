/**
 * 本机界面壳的数据通道：SSE 推帧 + POST 调方法。
 *
 * 为什么不用 WebSocket（遥控端那条路）：这条链路只需要「宿主 → 页面」单向推 + 一问一答，
 * 而 SSE 自带两件我们本来要手写的东西——**浏览器自动重连**，以及重连时带上
 * `Last-Event-ID`。那正好是帧 hub 的补帧语义（`resume(after)`），接起来不用自己维护重连状态机。
 * invoke 走普通 POST，复用 HTTP 层已有的请求体读取与 Host 校验。
 *
 * 与遥控端共用的是**帧的产生与缓冲**（`core/remote/frames.ts` 的 RemoteFrameHub）：
 * seq 全局单调、增量 diff、120 帧环形缓冲补帧，两边一套口径。**可调用面不同**：本机界面走
 * `core/ui-methods.ts` 那份界面子集（凭据写入、破坏性删除、任意命令执行、审批策略一律不放），
 * 实参还要过 `validateUiArgs`；遥控端另一份更小的子集。理由都一样——页面里跑着第三方 bundle。
 *
 * 与遥控端（`plugins/remote.ts`）对齐的三条纪律，别在改动里丢掉：
 *
 *   1. **一条连接都没有的期间变过 = 漏过变化**（`missedWhileIdle`）。那时不造帧，hub 的
 *      seq 不前进，重连时 `resume(after)` 返回的是**空数组**而不是 null——只看
 *      「replay 是不是 null」会把这种情况当成「补上了」，界面就永远停在旧状态。
 *   2. **hub 是所有连接共用的一份**：`build(forceFull)` 会把共享的 diff 基准重挂并推进全局
 *      seq。所以一帧全量必须广播给全体（含刚接上的那条），只写给新连接会让老连接永久少条目。
 *   3. **广播要管背压与死连接**：SSE 是长连接，socket 级错误是异步事件（try/catch 接不住），
 *      而 `res.write()` 返回 false 之后一直等不到 `drain`，说明对端压根不读了——不管就会把帧
 *      堆在宿主的写缓冲里。
 *
 * 鉴权**不在这里**：调用方（`core/ui-server.ts`）先过 Host 头与 Cookie 两道闸，
 * 再把请求交给这里。这样这个模块不依赖 cordis、也不认识凭据，能单独起真服务来测。
 *
 * @module dsc/core/ui-events
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RemoteFrameHub, type BuiltFrame, type FrameInput } from './remote/frames.js'
import { readBody, sendJson, sendText } from './web-http.js'

/** 默认推送节流（与 host-stdio / remote 同一个口径）。 */
const DEFAULT_THROTTLE_MS = 80

/** 心跳间隔：写注释行防中间设备掐掉空闲连接，也顺便发现死连接。 */
const DEFAULT_HEARTBEAT_MS = 15_000

/**
 * 断线后浏览器该等多久再连（写进流的 `retry:`）。
 *
 * 500 毫秒太急：宿主重启或网络抖一下，所有页面会以每半秒一轮打成重连风暴，
 * 而这段时间里每次重连都要走一遍握手 + 补帧。3 秒既不让用户等太久，也给宿主留出恢复时间。
 */
const RECONNECT_RETRY_MS = 3_000

/**
 * 同时最多挂几条 SSE。
 *
 * 每条连接都占一份写缓冲与一个 socket；页面开太多（脚本刷、标签页忘了关）会把宿主内存吃光。
 * 超限回 503 而不是静默丢弃，这样客户端知道该关掉多余的页面。
 */
const DEFAULT_MAX_CLIENTS = 8

/**
 * 一条连接连续多少帧「上一帧还没排空」就断开它。
 *
 * 判据不能是「`res.write()` 返回了 false」——帧比写缓冲的高水位大时（一次几 MB 的快照），
 * 一条完全健康的连接也会每帧都返回 false。真正的落后是**跨帧还没排空**：
 * 上一次 false 之后一直没等到 `drain` 事件，说明对端压根没在读。
 *
 * 断开反而是安全的：浏览器会带 `Last-Event-ID` 重连，而重连有补帧，所以断开不等于丢数据。
 */
const MAX_WRITE_LAG = 3

/** 造这个通道要给的几样东西。 */
export interface UiEventsOptions {
  /** 取当前快照（每次推送都重新取）。 */
  snapshot(): FrameInput & Record<string, unknown>
  /** 执行一个方法（白名单已由调用方校验过；这里只负责执行与包错误）。 */
  invoke(method: string, args: unknown[]): Promise<unknown>
  /** 允许的方法名（握手报给客户端，派发前再校验一次）。 */
  methods: readonly string[]
  /** 握手帧内容（宿主身份、协议版本）。 */
  hello(): Record<string, unknown>
  /** 订阅宿主变化；返回退订函数。 */
  subscribe(onChange: () => void): () => void
  /**
   * 启动图热更源（可选）：连接建立即发一帧当前图，之后有变更就推。
   *
   * 为什么另开 `event: plugins` 而不塞进 `frame`：`frame` 帧参与帧 hub 的 seq/全量不变量
   * （跳号要重开连接、首帧必须全量），把插件图混进去会破坏那套判定（`ui-events-test.mjs`
   * 钉着它）。新事件名对旧壳向前兼容——浏览器对没监听的事件名直接忽略。
   */
  plugins?: {
    /** 握手后立刻发的那一帧（当前图；`changed`/`removed` 为空）。 */
    initial(): unknown
    /** 订阅变更帧；返回退订函数。 */
    subscribe(listener: (frame: unknown) => void): () => void
  }
  throttleMs?: number
  heartbeatMs?: number
  /** 同时最多几条 SSE，缺省 8。 */
  maxClients?: number
  /** 日志（缺省写 stderr，与 `core/ui-server.ts` 同一个口径）。 */
  log?(line: string): void
}

/** 交给 HTTP 服务挂上去的两个入口。 */
export interface UiEventsHandle {
  /** `GET /api/events`：SSE。 */
  handleEvents(req: IncomingMessage, res: ServerResponse): void
  /** `POST /api/invoke`：`{method, args}` → `{ok, value|error}`。 */
  handleInvoke(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** 当前连着几个页面（诊断）。 */
  readonly clients: number
  /** 退订并断开所有连接（插件卸载时调）。 */
  stop(): void
}

/** 写一条 SSE 事件；返回 `res.write` 的结果（false = 对端跟不上，写进缓冲了）。 */
function writeEvent(res: ServerResponse, event: string, data: string, id?: number): boolean {
  const head = `${id === undefined ? '' : `id: ${String(id)}\n`}event: ${event}\n`
  return res.write(`${head}data: ${data}\n\n`)
}

/** 从帧文本里挑出 seq（补发时当 `id:` 用，浏览器下次重连才能把号带回来）。 */
function frameSeqOf(text: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    const candidate = (parsed as { seq?: unknown }).seq
    return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
  } catch {
    // 缓冲里存的就是自己序列化出来的文本，理论上不会解析失败；真坏了就不带 id 发。
    return undefined
  }
}

/**
 * 造数据通道。
 * @param options - 快照来源、派发器、白名单与握手内容
 */
export function createUiEvents(options: UiEventsOptions): UiEventsHandle {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS
  const log =
    options.log ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`)
    })

  const hub = new RemoteFrameHub()
  /** 连着的页面：hub 只有一份，每一帧广播给这里每一条。 */
  const clients = new Set<ServerResponse>()
  /** 每条连接连续几次「跨帧还没排空」；排空了就清掉。 */
  const lag = new Map<ServerResponse, number>()
  /** 正在等 `drain`（上一次写返回 false 之后就进这里）。 */
  const draining = new Set<ServerResponse>()
  /**
   * 「一条连接都没有的那段时间里，宿主变过」。
   * 必须记：那时不造帧，hub 的 seq 不前进，重连时补帧补不出这段变化，得补一帧全量。
   */
  let missedWhileIdle = false
  /** 上一次造帧失败的原因：同一个原因只报一次，别把日志和页面刷爆。 */
  let lastBuildError: string | null = null

  /** 把一条连接从表里摘掉（断开、写失败、报错都走这里）。 */
  const forget = (res: ServerResponse): void => {
    clients.delete(res)
    lag.delete(res)
    draining.delete(res)
  }

  /**
   * 给一条连接写一帧。
   *
   * 写不进去（`res.write()` 返回 false）时要盯着 `drain`：连着几帧都等不到 drain 就说明
   * 对端真的不读了，断开它并等它重连（重连有补帧，所以断开不丢数据）。只看单次返回值
   * 会把「帧比写缓冲大」误判成落后——那是每一帧都返回 false 的正常情况。
   */
  const writeFrame = (res: ServerResponse, frame: BuiltFrame): void => {
    if (res.writableEnded || res.destroyed) {
      forget(res)
      return
    }
    let flushed: boolean
    try {
      flushed = writeEvent(res, 'frame', frame.text, frame.seq)
    } catch {
      // 写到一半对端没了：这条连接不用再管
      forget(res)
      return
    }
    if (flushed) {
      lag.delete(res)
      draining.delete(res)
      return
    }
    const missed = draining.has(res) ? (lag.get(res) ?? 0) + 1 : 1
    lag.set(res, missed)
    if (!draining.has(res)) {
      draining.add(res)
      res.once('drain', () => {
        draining.delete(res)
        lag.delete(res)
      })
    }
    if (missed >= MAX_WRITE_LAG) {
      log(`[ui-events] 这个页面连续 ${String(missed)} 帧等不到写缓冲排空，断开它等它带着 Last-Event-ID 重连`)
      try {
        res.end()
      } catch {
        // 已经断了
      }
      forget(res)
    }
  }

  /**
   * 把造帧失败报给所有页面（同一原因只报一次），并记日志。
   *
   * 为什么不能像以前那样静默 return：界面停在最后一帧、宿主这边一声不吭，
   * 「快照形状意外」这种最好查的故障会变成最难查的（用户只看到界面不动了）。
   */
  const reportBuildFailure = (reason: string): void => {
    if (reason === lastBuildError) return
    lastBuildError = reason
    log(`[ui-events] 造帧失败，界面会停在最后一帧：${reason}`)
    const data = JSON.stringify({ error: reason })
    for (const res of [...clients]) {
      try {
        writeEvent(res, 'error', data)
      } catch {
        forget(res)
      }
    }
  }

  /**
   * 造一帧并广播给所有连接（含刚接上的那一条）。
   *
   * 为什么必须广播而不是只写给某一条：全量帧会把 hub 共享的 diff 基准重挂到当前快照。
   * 只写给新连接的话，老连接之后的增量是相对新基准算的，「已发生但还没进帧流」的变化
   * 在增量里根本不出现——老标签页永久少条目，而且不报任何错。
   *
   * @returns 造出来的帧；造帧失败时 null（已经报过错了）
   */
  const emitFrame = (forceFull: boolean): BuiltFrame | null => {
    let frame: BuiltFrame
    try {
      frame = hub.build(options.snapshot(), forceFull)
    } catch (error) {
      reportBuildFailure(error instanceof Error ? error.message : String(error))
      // 造帧失败不该把已经连上的页面弄断：跳过这一帧，等下一次变化。
      return null
    }
    lastBuildError = null
    for (const res of [...clients]) writeFrame(res, frame)
    // 这一帧已经把所有连接（含漏过变化的那些）对齐到当前快照了
    missedWhileIdle = false
    return frame
  }

  // 宿主变化 → 节流 → 推一帧。
  let timer: NodeJS.Timeout | null = null
  let dirty = false
  const scheduleFrame = (): void => {
    if (clients.size === 0) {
      // 没人连着：不造帧（造了也没人收），但要记住这段时间变过——
      // seq 不前进意味着重连补帧是空数组，不补全量就永远对不上。
      missedWhileIdle = true
      return
    }
    dirty = true
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      if (!dirty) return
      dirty = false
      if (clients.size === 0) {
        // 攒的这一段时间里页面全走了：同样按「漏过变化」记账
        missedWhileIdle = true
        return
      }
      emitFrame(false)
    }, throttleMs)
  }
  const unsubscribe = options.subscribe(scheduleFrame)

  /**
   * 启动图帧的广播面：与快照帧共用连接集合，但**不进帧 hub**——没有 seq/id、不参与补帧，
   * 断线期间漏掉的帧靠重连时那一帧 `initial()` 重新对齐（图是幂等的全量）。
   */
  const writePlugins = (res: ServerResponse, data: string): void => {
    if (res.writableEnded || res.destroyed) {
      forget(res)
      return
    }
    try {
      writeEvent(res, 'plugins', data)
    } catch {
      forget(res)
    }
  }
  const unsubscribePlugins = options.plugins?.subscribe((frame) => {
    let data: string
    try {
      data = JSON.stringify(frame)
    } catch (error) {
      log(`[ui-events] 启动图帧序列化失败，丢弃这一帧：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const res of [...clients]) writePlugins(res, data)
  })

  const heartbeat = setInterval(() => {
    for (const res of [...clients]) {
      if (res.writableEnded || res.destroyed) {
        forget(res)
        continue
      }
      try {
        res.write(': keep-alive\n\n')
      } catch {
        forget(res)
      }
    }
  }, heartbeatMs)
  heartbeat.unref?.()

  return {
    get clients() {
      return clients.size
    },

    handleEvents(req, res) {
      if (clients.size >= maxClients) {
        log(`[ui-events] SSE 连接数已达上限 ${String(maxClients)}，拒绝新连接`)
        sendText(res, 503, '界面数据通道的连接数已满，请关掉多余的页面再刷新')
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // 反向代理（有人把它挂出去时）不要缓冲这个流
        'x-accel-buffering': 'no',
      })
      res.write(`retry: ${String(RECONNECT_RETRY_MS)}\n\n`)
      writeEvent(res, 'hello', JSON.stringify(options.hello()))

      // socket 级错误（ECONNRESET 之类）是异步事件，try/catch 接不住：靠 error/close 摘连接。
      res.on('error', () => {
        forget(res)
      })
      req.on('close', () => {
        forget(res)
      })
      // 先登记再补帧：接不上缓冲时那一帧全量是广播出去的，新连接也得在那一次广播里。
      clients.add(res)

      // 启动图：紧跟 hello 之后发一帧当前图（重连也一样），壳据此对齐 HMR 的起点。
      if (options.plugins !== undefined) {
        try {
          writePlugins(res, JSON.stringify(options.plugins.initial()))
        } catch (error) {
          log(`[ui-events] 启动图初始帧序列化失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // 重连补帧：浏览器会把上一帧的 id 放进 Last-Event-ID（手工接的客户端可以用 ?lastSeq=）。
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const rawAfter = req.headers['last-event-id'] ?? url.searchParams.get('lastSeq') ?? '0'
      const after = Number(Array.isArray(rawAfter) ? rawAfter[0] : rawAfter)
      const replay = Number.isFinite(after) ? hub.resume(after) : null
      if (replay === null) {
        // 接不上缓冲（第一次连、漏的帧已滚出窗口、或宿主重启过）：立刻补一帧全量。
        emitFrame(true)
      } else {
        // 只补这条连接漏掉的帧（缓冲里存的是原样文本，直接照发）
        for (const text of replay) {
          try {
            writeEvent(res, 'frame', text, frameSeqOf(text))
          } catch {
            forget(res)
            break
          }
        }
        // 一条连接都没有的期间发生的变化不在补帧里（那时根本没造帧）：再补一帧全量把它对上。
        if (missedWhileIdle) emitFrame(true)
      }
    },

    async handleInvoke(req, res) {
      let parsed: unknown
      try {
        const text = await readBody(req)
        parsed = JSON.parse(text === '' ? '{}' : text)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: `请求体不是 JSON：${error instanceof Error ? error.message : String(error)}` })
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, { ok: false, error: '请求体必须是对象' })
        return
      }
      const record = parsed as Record<string, unknown>
      const method = record['method']
      if (typeof method !== 'string' || method === '') {
        sendJson(res, 400, { ok: false, error: '缺少 method' })
        return
      }
      if (!options.methods.includes(method)) {
        sendJson(res, 403, { ok: false, error: `协议不允许调用的方法：${method}` })
        return
      }
      const args = Array.isArray(record['args']) ? record['args'] : []
      try {
        const value = (await options.invoke(method, args)) ?? null
        sendJson(res, 200, { ok: true, value })
      } catch (error) {
        // 执行失败照 host-stdio 的口径回一条结果（HTTP 200 + ok:false），
        // 客户端只需看 ok，不必区分「协议错」与「方法抛错」两条路。
        sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    stop() {
      clearInterval(heartbeat)
      if (timer !== null) clearTimeout(timer)
      timer = null
      unsubscribe()
      unsubscribePlugins?.()
      for (const res of [...clients]) {
        try {
          res.end()
        } catch {
          // 已经断了的连接不用管
        }
      }
      clients.clear()
      lag.clear()
      draining.clear()
    },
  }
}

/** 没凭据时的回话（与 ui-server 的 401 一致，独立成量是因为它也被测试直接比对）。 */
export function sendUnauthorized(res: ServerResponse): void {
  sendText(res, 401, '需要界面凭据')
}
