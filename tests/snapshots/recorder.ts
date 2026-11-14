/**
 * 快照录制代理：坐进内核与真模型之间，转发请求、记下指纹与应答块。
 *
 * ## 它在哪条链上
 *
 * ```
 * 内核（bootKernel，providers 指向本代理） → 本代理 → 真模型 API
 * ```
 *
 * 内核以为自己在一个普通 OpenAI 兼容端点上；代理把每个请求**原样转发**给上游（只改
 * Host），同时算出 messages 的形状指纹（`tests/support/hash.ts`，与 `replayLLM` 共用同一
 * 份实现），把 SSE 应答流一边原样透传给内核、一边解析成 `SseChunk` 收进录制。
 *
 * ## turn 编号口径（必须与回放端逐字一致）
 *
 * 标题请求不算轮（两边都认 `isTitleRequestByPrompt` 这同一份判定）；其余请求按到达顺序
 * 从 1 起。每轮写两行 jsonl：`{kind:"request", turn, requestHash}` 与
 * `{kind:"response", turn, chunks}`——这正是 `replayLLM.parseRecording` 认的格式。
 *
 * ## 单会话假设
 *
 * 一个代理实例只服务一个场景（一次录制 = 一条会话）。场景文件里起一个代理、跑完保存，
 * 不要复用——轮次计数是实例级的，混用两个会话会让编号错位。
 *
 * @module dsc/tests/snapshots/recorder
 */
import { createServer, type RequestListener } from 'node:http'
import { writeFileSync } from 'node:fs'
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
    try {
      const upstreamRes = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
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

  const server = createServer(handler)
  await new Promise<void>((resolveListen) => server.listen(port, '127.0.0.1', () => resolveListen()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('录制代理：拿不到监听地址')

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
    save(path: string) {
      if (pending !== null) throw new Error(`录制代理：turn=${pending.turn} 的应答还没收完，不许落盘半截录制`)
      const requestTurns = lines.filter((line) => line.kind === 'request').length
      const responseTurns = lines.filter((line) => line.kind === 'response').length
      if (requestTurns === 0 || requestTurns !== responseTurns) {
        throw new Error(`录制代理：request ${String(requestTurns)} 轮 / response ${String(responseTurns)} 轮对不齐，拒绝落盘`)
      }
      writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
    },
  }
}
