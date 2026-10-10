/**
 * 本机界面壳的数据通道：SSE 推帧 + POST 调方法。
 *
 * 为什么不用 WebSocket（遥控端那条路）：这条链路只需要「宿主 → 页面」单向推 + 一问一答，
 * 而 SSE 自带两件我们本来要手写的东西——**浏览器自动重连**，以及重连时带上
 * `Last-Event-ID`。那正好是帧 hub 的补帧语义（`resume(after)`），接起来不用自己维护重连状态机。
 * invoke 走普通 POST，复用 HTTP 层已有的请求体读取与 Host 校验。
 *
 * 与遥控端共用的是**帧的产生与缓冲**（`core/remote/frames.ts` 的 RemoteFrameHub）：
 * seq 全局单调、增量 diff、120 帧环形缓冲补帧，两边一套口径。白名单不同：本机界面服务是
 * 同机回环 + Cookie 认证，用整张 `INVOKABLE_METHODS`（与桌面 IPC 那条路同等信任）；
 * 遥控端另有更小的子集（凭据类与宿主生命周期操作不开）。
 *
 * 鉴权**不在这里**：调用方（`core/ui-server.ts`）先过 Host 头与 Cookie 两道闸，
 * 再把请求交给这里。这样这个模块不依赖 cordis、也不认识凭据，能单独起真服务来测。
 *
 * @module dsc/core/ui-events
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RemoteFrameHub, type FrameInput } from './remote/frames.js'
import { readBody, sendJson, sendText } from './web-http.js'

/** 默认推送节流（与 host-stdio / remote 同一个口径）。 */
const DEFAULT_THROTTLE_MS = 80

/** 心跳间隔：写注释行防中间设备掐掉空闲连接，也顺便发现死连接。 */
const DEFAULT_HEARTBEAT_MS = 15_000

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
  throttleMs?: number
  heartbeatMs?: number
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

/** 写一条 SSE 事件。 */
function writeEvent(res: ServerResponse, event: string, data: string, id?: number): void {
  const head = `${id === undefined ? '' : `id: ${String(id)}\n`}event: ${event}\n`
  res.write(`${head}data: ${data}\n\n`)
}

/**
 * 造数据通道。
 * @param options - 快照来源、派发器、白名单与握手内容
 */
export function createUiEvents(options: UiEventsOptions): UiEventsHandle {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const hub = new RemoteFrameHub()
  const clients = new Set<ServerResponse>()

  /** 给一个已经握过手的连接写一帧（写不进去就从连接表里摘掉）。 */
  const writeFrame = (res: ServerResponse, frame: { seq: number; text: string }): void => {
    try {
      writeEvent(res, 'frame', frame.text, frame.seq)
    } catch {
      clients.delete(res)
    }
  }

  /** 造一帧并广播（节流触发）。 */
  const push = (forceFull = false): void => {
    if (clients.size === 0) return
    let frame: { seq: number; text: string }
    try {
      frame = hub.build(options.snapshot(), forceFull)
    } catch {
      // 造帧失败（快照形状意外）不该把已经连上的页面弄断：跳过这一帧，等下一次变化。
      return
    }
    for (const res of [...clients]) writeFrame(res, frame)
  }

  // 宿主变化 → 节流 → 推一帧。
  let timer: NodeJS.Timeout | null = null
  let dirty = false
  const onHostChange = (): void => {
    dirty = true
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      if (!dirty) return
      dirty = false
      push()
    }, throttleMs)
  }
  const unsubscribe = options.subscribe(onHostChange)

  const heartbeat = setInterval(() => {
    for (const res of [...clients]) {
      try {
        res.write(': keep-alive\n\n')
      } catch {
        clients.delete(res)
      }
    }
  }, heartbeatMs)
  heartbeat.unref?.()

  return {
    get clients() {
      return clients.size
    },

    handleEvents(req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // 反向代理（有人把它挂出去时）不要缓冲这个流
        'x-accel-buffering': 'no',
      })
      res.write('retry: 500\n\n')
      writeEvent(res, 'hello', JSON.stringify(options.hello()))

      // 重连补帧：浏览器会把上一帧的 id 放进 Last-Event-ID（手工接的客户端可以用 ?lastSeq=）。
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const rawAfter = req.headers['last-event-id'] ?? url.searchParams.get('lastSeq') ?? '0'
      const after = Number(Array.isArray(rawAfter) ? rawAfter[0] : rawAfter)
      const replay = Number.isFinite(after) ? hub.resume(after) : null
      if (replay !== null) {
        for (const text of replay) {
          let seq: number | undefined
          try {
            const parsed: unknown = JSON.parse(text)
            const candidate = (parsed as { seq?: unknown }).seq
            if (typeof candidate === 'number' && Number.isFinite(candidate)) seq = candidate
          } catch {
            seq = undefined
          }
          writeEvent(res, 'frame', text, seq)
        }
      } else {
        // 接不上缓冲（第一次连、或漏的帧已经滚出窗口）：立刻给一帧全量。
        writeFrame(res, hub.build(options.snapshot(), true))
      }

      clients.add(res)
      req.on('close', () => {
        clients.delete(res)
      })
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
      for (const res of [...clients]) {
        try {
          res.end()
        } catch {
          // 已经断了的连接不用管
        }
      }
      clients.clear()
    },
  }
}

/** 没凭据时的回话（与 ui-server 的 401 一致，独立成量是因为它也被测试直接比对）。 */
export function sendUnauthorized(res: ServerResponse): void {
  sendText(res, 401, '需要界面凭据')
}
