/**
 * 快照录制代理：坐进内核与真模型之间，转发请求、记下指纹与应答块。
 *
 * ## 它在哪条链上
 *
 * ```
 * 内核（bootKernel，providers 指向本代理） → 本代理 → 真模型 API
 * ```
 *
 * 内核以为自己在一个普通 OpenAI 兼容端点上；代理把请求转发给上游，同时算出 messages
 * 的形状指纹（`tests/support/hash.ts`，与 `replayLLM` 共用同一份实现），把 SSE 应答流一边
 * 原样透传给内核、一边解析成内部 `SseChunk` 收进录制，落盘时再翻成回放端认的
 * `{text} / {toolCall:{name,args}}` 形状（见 {@link toRecordedChunks}）。
 *
 * ## turn 编号口径（必须与回放端逐字一致）
 *
 * 标题请求不算轮（两边都认 `isTitleRequestByPrompt` 这同一份判定）；其余请求按到达顺序
 * 从 1 起。每轮写两行 jsonl：`{kind:"request", turn, requestHash}` 与
 * `{kind:"response", turn, chunks}`——这正是 `replayLLM.parseRecording` 认的格式。
 * **chunks 的字段名由回放端定死**（`tests/harness.ts:539-543` 只认 `text` / `toolCall` /
 * `done`）：代理内部叫 `content` 只是自己顺口，落盘必须翻译，否则回放读完第一轮就抛
 * 「chunks[0] 什么都不含」（实测过，这就是本层原先「录了也放不了」的原因）。
 *
 * ## 转发时只做两处「适配」，别再加第三处
 *
 * 1. **上游模型 id**（`DSC_SNAPSHOT_MODEL`）：内核配置里的模型 id 是场景随手起的假名
 *    （默认 `m`），真上游不认，照发就是 404。这里把请求体的 `model` 顶成环境变量给的
 *    真 id。为什么不在场景里直接改 `providers.real.models[0].id`：那个 id 会被拼进系统
 *    提示词的「当前模型」段（`src/packages/prompt/index.ts:320`），一改 messages 就变，
 *    录制与回放的指纹必然对不上（409）——裁定权在消息侧，适配只能发生在线上这一层。
 *    不设这个变量就**一个字节都不改**（回放/跳过模式根本不起这个代理）。
 * 2. **opencode Go 的会话归因头**：内核是打向 `http://127.0.0.1:<port>` 的，它自己的
 *    `isOpenCodeGoBaseUrl` 认不出真上游，不会带 `x-opencode-session`，网关直接 400
 *    `MissingSessionID`。见 {@link isOpencodeGoUpstream} 的门控：只对 opencode.ai 的 Go
 *    入口加，别家端点一个字节都看不到（这是端点私有头）。
 *
 * ## 单会话假设
 *
 * 一个代理实例只服务一个场景（一次录制 = 一条会话）。场景文件里起一个代理、跑完保存，
 * 不要复用——轮次计数是实例级的，混用两个会话会让编号错位。
 *
 * @module dsc/tests/snapshots/recorder
 */
import { writeFileSync } from 'node:fs'
import { createServer, type RequestListener } from 'node:http'
import type { Socket } from 'node:net'
import { hashChatMessages } from '../support/hash.js'
import { isTitleRequestByPrompt } from '../harness.js'

/** 录制文件里的一行（`replayLLM.parseRecording` 认的两种 kind）。 */
type RecordLine = { kind: 'request'; turn: number; requestHash: string } | { kind: 'response'; turn: number; chunks: unknown[] }

/** 线上一帧 delta 里可提取的三类内容。 */
interface SseChunk {
  content?: string
  reasoning?: string
  toolCall?: { id: string; name: string; args: unknown }
}

/** 录制代理的对外形态。 */
export interface RecordProxy {
  /** 内核 providers 里填的地址（`http://127.0.0.1:<port>`）。 */
  baseUrl: string
  /** 停代理；场景结束（finally）里调。 */
  close(): Promise<void>
  /** 把录制写成 jsonl。轮次不完整（有 request 没 response）时直接抛，不许落盘半截录制。 */
  save(path: string): void
}

/**
 * 录制期上游模型 id。内核配置里的 id 是假名（默认 `m`），真上游不认；设了就用它顶掉
 * 请求体的 `model`。不设 = 不改请求体（与老行为逐字节相同）。为什么不改内核配置见文件
 * 头「转发时只做两处适配」第 1 条。
 */
const RECORD_MODEL = process.env['DSC_SNAPSHOT_MODEL']?.trim() ?? ''

/** opencode Go 网关点名要的会话归因头（`src/core/request-attribution.ts:35` 同一份名字）。 */
const OPENCODE_SESSION_HEADER = 'x-opencode-session'

/** 录制期的会话头值：网关只要求非空，固定串便于在网关日志里认出这是快照录制。 */
const RECORD_SESSION_ID = 'dsc-snapshot-record'

/** Go 入口的 path 形状：`/zen/go/v1`（内核认的那个）与 `/inference/go/v1`（实际网关）。 */
const OPENCODE_GO_PATH = /^\/(?:zen|inference)\/go\/v\d+$/

/**
 * 这个上游是不是 opencode Go 入口：**host 与 path 一起判**，不认 provider id。
 *
 * 判错了的代价不对称：漏判 → 网关 400，录制当场失败（看得见）；误判 → 把端点私有的
 * 会话头发给别家（看不见，且可能被挑剔的网关判 400）。所以宁可写死两种已知 path 形状，
 * 也不放宽成「含 /go/ 就算」。
 *
 * @param upstream - 录制代理的上游基地址（`DSC_SNAPSHOT_BASE_URL`）
 */
function isOpencodeGoUpstream(upstream: string): boolean {
  let url: URL
  try {
    url = new URL(upstream)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  const path = url.pathname.replace(/\/+$/, '').toLowerCase()
  return (host === 'opencode.ai' || host.endsWith('.opencode.ai')) && OPENCODE_GO_PATH.test(path)
}

/**
 * 起录制代理。上游给**不含路径**的基地址（如 `https://api.example.com/v1`），
 * 转发时按内核请求的原路径拼接；鉴权头由内核配置里的 key 原样带上，代理不碰。
 *
 * @param upstream - 真模型的基地址（内核请求的 path 直接拼在它后面）
 * @param port - 指定 0 让系统挑空闲端口
 */
export async function startRecordProxy(upstream: string, port = 0): Promise<RecordProxy> {
  const lines: RecordLine[] = []
  let nonTitleSeen = 0
  /** 当前未完成轮的暂存：request 行在收到体时写，response 行在流结束时写。 */
  let pending: { turn: number; chunks: SseChunk[] } | null = null

  const handler: RequestListener = (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        res.writeHead(400).end('录制代理：请求体不是合法 JSON')
        return
      }
      if (isTitleRequestByPrompt(body)) {
        // 标题请求：转发但不记（回放端也不给它 turn 编号，两边口径一致）。
        void forward(req, res, body)
        return
      }
      nonTitleSeen += 1
      const turn = nonTitleSeen
      let requestHash: string
      try {
        requestHash = hashChatMessages((body as { messages?: unknown }).messages)
      } catch (error) {
        res.writeHead(500).end(`录制代理：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      lines.push({ kind: 'request', turn, requestHash })
      pending = { turn, chunks: [] }
      void forward(req, res, body, pending.chunks)
    })
  }

  /** 把请求转发给上游；`capture` 给了就边透传边把 SSE delta 解析进数组。 */
  async function forward(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    body: unknown,
    capture?: SseChunk[],
  ): Promise<void> {
    const url = `${upstream}${req.url ?? '/chat/completions'}`
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && !['host', 'content-length', 'connection'].includes(name)) {
        headers[name] = value
      }
    }
    // 只对 opencode Go 入口补会话头；已有同名头就不覆盖（内核哪天自己会带时以它为准）。
    if (isOpencodeGoUpstream(upstream) && headers[OPENCODE_SESSION_HEADER] === undefined) {
      headers[OPENCODE_SESSION_HEADER] = RECORD_SESSION_ID
    }
    // 模型 id 的线上适配（理由见文件头）：只在录制期设了变量时改，且不改 messages。
    const wireBody =
      RECORD_MODEL === '' || body === null || typeof body !== 'object' || Array.isArray(body)
        ? body
        : { ...(body as Record<string, unknown>), model: RECORD_MODEL }
    try {
      const upstreamRes = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(wireBody),
      })
      res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers.entries()))
      if (!upstreamRes.body || !capture) {
        // 非流式（错误体等）或不需要录制：管道直通。
        const buffer = Buffer.from(await upstreamRes.arrayBuffer())
        if (capture && pending !== null) {
          lines.push({ kind: 'response', turn: pending.turn, chunks: capture })
          pending = null
        }
        res.end(buffer)
        return
      }
      const reader = upstreamRes.body.getReader()
      let carry = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(Buffer.from(value))
        carry += new TextDecoder().decode(value, { stream: true })
        // SSE 帧以空行分隔；最后一段可能不完整，留在 carry 里。
        const frames = carry.split('\n\n')
        carry = frames.pop() ?? ''
        for (const frame of frames) parseFrame(frame, capture)
      }
      if (carry.trim() !== '') parseFrame(carry, capture)
      if (pending !== null) {
        lines.push({ kind: 'response', turn: pending.turn, chunks: capture })
        pending = null
      }
      res.end()
    } catch (error) {
      res.writeHead(502).end(`录制代理转发失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 一帧 SSE 里的 `data: {choices:[{delta:{…}}]}` 摊平成 SseChunk（终帧与 usage 块跳过）。 */
  function parseFrame(frame: string, capture: SseChunk[]): void {
    for (const line of frame.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(payload)
      } catch {
        continue
      }
      const delta = (
        parsed as { choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown } }> }
      ).choices?.[0]?.delta
      if (delta === undefined) continue
      const chunk: SseChunk = {}
      if (typeof delta.content === 'string' && delta.content !== '') chunk.content = delta.content
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') chunk.reasoning = delta.reasoning_content
      const call = Array.isArray(delta.tool_calls) ? delta.tool_calls[0] : undefined
      const fn = (call as { function?: { name?: unknown; arguments?: unknown } } | undefined)?.function
      if (fn !== undefined) {
        chunk.toolCall = {
          id: String((call as { id?: unknown }).id ?? 'recorded'),
          name: String(fn.name ?? ''),
          args: safeArgs(fn.arguments),
        }
      }
      if (chunk.content !== undefined || chunk.reasoning !== undefined || chunk.toolCall !== undefined) {
        capture.push(chunk)
      }
    }
  }

  /** 工具参数尽力解析成对象；解析不了就存原串（replayLLM 回放时原样发回）。 */
  function safeArgs(raw: unknown): unknown {
    if (typeof raw !== 'string' || raw === '') return raw ?? {}
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return raw
    }
  }

  /**
   * 把代理内部的 `SseChunk` 翻成回放端认的 chunks。
   *
   * 回放端 `replayLLM` 的 `toSseChunks`（`tests/harness.ts:554-593`）只认 `text` /
   * `toolCall:{name,args}` / `done` 三种字段，遇到别的形状直接抛错——代理内部用的
   * `content` / `reasoning` 不翻译就落盘，回放第一轮必抛「什么都不含」。
   *
   * **思考段（reasoning）只能丢**：那个解析器没有 reasoning 字段（录制格式是它定的，
   * `tests/harness.ts:539-543`），硬塞进 `text` 会把 thinking 行伪装成正文，回放出来的
   * 转录比录制少一条 thinking 却多一段正文——那是更坏的失真。丢之前记一条 warn：场景若
   * 依赖 thinking（断言 reasoning 内容），必须由主线扩录制格式，别在这里绕。
   */
  function toRecordedChunks(chunks: readonly SseChunk[]): unknown[] {
    const out: unknown[] = []
    let droppedReasoning = 0
    for (const chunk of chunks) {
      if (chunk.reasoning !== undefined) droppedReasoning += 1
      if (chunk.content !== undefined) out.push({ text: chunk.content })
      if (chunk.toolCall !== undefined) {
        out.push({ toolCall: { name: chunk.toolCall.name, args: chunk.toolCall.args } })
      }
    }
    if (droppedReasoning > 0) {
      console.warn(
        `[snapshot] 录制里有 ${String(droppedReasoning)} 段思考（reasoning_content）被丢弃：` +
          '回放格式（tests/harness.ts 的 RecordedChunk）没有 reasoning 字段，' +
          '依赖 thinking 的断言在回放侧会看不到它。要保留得先扩录制格式。',
      )
    }
    return out
  }

  const server = createServer(handler)
  /**
   * 已建立的连接。**必须自己记、自己销毁**：内核（undici）会 keep-alive，`server.close()`
   * 只等连接自己结束，于是 afterAll 里的 `close()` 永远不返回，vitest 超时后强杀 worker
   * （实测日志：`[vitest-pool]: Timeout terminating forks worker`，还留下删不掉的临时 HOME）。
   * 与 `tests/harness.ts:440-443` 的假端点同一套做法：先销毁连接，关闭才是立即生效的。
   */
  const sockets = new Set<Socket>()
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolveListen) => server.listen(port, '127.0.0.1', () => resolveListen()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('录制代理：拿不到监听地址')

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
    save(path: string) {
      if (pending !== null) throw new Error(`录制代理：turn=${pending.turn} 的应答还没收完，不许落盘半截录制`)
      const requestTurns = lines.filter((line) => line.kind === 'request').length
      const responseTurns = lines.filter((line) => line.kind === 'response').length
      if (requestTurns === 0 || requestTurns !== responseTurns) {
        throw new Error(`录制代理：request ${String(requestTurns)} 轮 / response ${String(responseTurns)} 轮对不齐，拒绝落盘`)
      }
      const serialized = lines.map((line) =>
        line.kind === 'response'
          ? JSON.stringify({ kind: line.kind, turn: line.turn, chunks: toRecordedChunks(line.chunks as SseChunk[]) })
          : JSON.stringify(line),
      )
      writeFileSync(path, `${serialized.join('\n')}\n`, 'utf8')
    },
  }
}
