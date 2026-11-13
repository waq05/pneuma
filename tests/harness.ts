/**
 * 测试公共设施：临时 HOME、假 LLM 端点、录制回放、真内核、会话日志读取、真入口 CLI、golden。
 *
 * ## 为什么集中在一个文件，而不是每个 spec 各写一份
 *
 * 这七件事每个都踩过一次坑，而且是同一种坑：**忘了做隔离或忘了等落盘**。
 * 临时 HOME 少改一个环境变量，测试就往开发者真实的 `~/.dsc` 里写会话；假端点少发
 * 一个 `[DONE]`，真内核的流读永远不结束；起完真内核不 dispose，vitest 进程不退出。
 * 这些坑分散复制到几十个 spec 里，修复一次要改几十处，漏一处就是一条只在 Windows 上红、
 * 或在 CI 上挂十分钟的用例。收在一处后，上面每一条都只有一份实现。
 *
 * ## 边界
 *
 * 这里只提供「怎么起、怎么抓、怎么收」的机械能力，不写任何断言口味：
 * 期望什么请求体、会话里该有什么，由各 spec 自己判断。唯一的例外是 `expectGolden`——
 * 它本身就是一条断言封装（比对 + 差异输出），调用方要的正是那个失败输出。
 *
 * ## 失败模式的总原则
 *
 * 参数错、环境不隔离、录制文件坏了，全部**当场抛可读的错**。这些函数服务于测试，
 * 「静默降级」在这里等价于「让一条本该红的用例变绿」，比直接红更贵。
 *
 * @module dsc/tests/harness
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DscCoreConfig } from '@pneuma/runtime/core/config.js'

/** `tests/harness.ts` 所在目录与仓库根：golden、CLI 入口都从仓库根定位。 */
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const GOLDEN_DIR = join(REPO_ROOT, 'tests', 'snapshots', 'golden')
const CLI_ENTRY = join(REPO_ROOT, 'bin', 'dsc.js')

/**
 * 会话标题请求的默认特征串。
 *
 * 抄自 `scripts/todo-reminder-test.mjs:183-185` 的真实抓包：会话标题插件把
 * `TITLE_PROMPT`（`src/packages/session-title/index.ts:30`）作为 system 消息发一次。
 * 这类请求不是对话轮次，必须单独应答，否则它会吃掉一轮假模型的剧本，
 * 后面所有轮次错位——断言看起来「随机」失败。
 */
const TITLE_PROMPT_NEEDLE = '会话标题生成器'
/** 标题请求的应答正文：只要非空，标题插件就会把它 trim 成标题。 */
const TITLE_REPLY = '测试会话标题'
/** `runTurn` 等一轮结束的上限；比 integration 单条 60s 预算短，保证先给出可读错误。 */
const RUN_TURN_TIMEOUT_MS = 30_000
/** 一轮结束后等写流落盘的兜底延时，与 `scripts/todo-reminder-test.mjs:249` 同口径。 */
const SETTLE_AFTER_TURN_MS = 80

/** 临时目录/主目录的路径判定：后者在前者里面才算隔离。 */
function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 把任意抛出物转成可读文本：日志里被 `[object Object]` 盖住是最常见的排障损失。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 循环等一个条件成立；超时返回 false，由调用方决定报什么错。 */
async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

/** 路径里的正则元字符转义：Windows 临时目录带 `\`，直接塞进 RegExp 会变成转义序列。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── 6.1 tempHome ─────────────────────────────────────────────────────────────

/**
 * 建一个临时主目录，并把 `HOME` / `USERPROFILE` 指过去。
 *
 * ## 为什么两个环境变量都改
 *
 * `os.homedir()` 在 POSIX 认 `HOME`、在 Windows 认 `USERPROFILE`。只改一个，另一半平台上
 * 隔离就是空的——而这种漏法在 Linux CI 上永远看不出来（CI 只有 Linux 时，Windows 那条
 * 路径根本没人跑）。两个都改，漏改一个就会在另一个平台上立刻暴露。
 *
 * ## 为什么 `restore` 还原成原值，而不是删掉目录或设成空串
 *
 * 设成空串等于换了一个「空主目录」，`homedir()` 会退到 `/` 或 `C:\Windows` 这类更糟的
 * 位置；删目录则会毁掉失败现场。还原成调用前的值，才是「我借用了一下，还给你」。
 * 临时目录本身**刻意不删**：红了要留着看会话日志与 `.lock`，那正是排查的入口。
 *
 * ## 失败模式
 *
 * `mkdtempSync` 建不出来就让它抛。吞掉的话，后续用例会落到真实主目录——这恰好是本函数
 * 要防的事故，而且事故现场在测试结果里看不出来（用例照样绿）。前缀带路径分隔符同样直接
 * 拒绝：`tempHome('../x')` 会把目录建到临时目录外面，把「隔离」这个前提悄悄毁掉。
 */
export function tempHome(prefix = 'dsc-test-'): { home: string; restore: () => void } {
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    throw new TypeError('tempHome：prefix 必须是非空字符串')
  }
  if (prefix.includes('/') || prefix.includes('\\') || prefix.includes('..')) {
    throw new Error(`tempHome：prefix 不能包含路径分隔符或 ".."（收到 ${JSON.stringify(prefix)}）`)
  }
  // 先记住原值：restore 要还成「原来是什么」，包括「原来根本没设」。
  const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  // 不 try/catch：建不出来就让调用方看到原始错误，而不是带着未隔离的环境继续跑。
  const home = mkdtempSync(join(tmpdir(), prefix))
  process.env.HOME = home
  process.env.USERPROFILE = home
  let restored = false
  const restore = (): void => {
    // 幂等：`afterEach(h.restore)` 与 `afterAll(h.restore)` 同时注册是常见写法，
    // 第二次调用不能再把环境改成「还原后的值」以外的东西。
    if (restored) return
    restored = true
    if (original.HOME === undefined) delete process.env.HOME
    else process.env.HOME = original.HOME
    if (original.USERPROFILE === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = original.USERPROFILE
  }
  return { home, restore }
}

// ── 6.2 fakeLLM ──────────────────────────────────────────────────────────────

/** `fakeLLM` 的剧本与钩子。 */
export interface FakeLLMOptions {
  /** 每轮返回什么：字符串 = 纯文本回复；对象 = 一次工具调用。 */
  turns: Array<string | { toolCall: { name: string; args: unknown } }>
  /** 每次请求到达时的钩子，用于断言请求体；标题请求的 turn 是 0。 */
  onRequest?: (body: unknown, turn: number) => void
  /** 自定义「这是标题请求」的判据；给了就**替换**默认判据，而不是叠加。 */
  isTitleRequest?: (body: unknown) => boolean
}

/** 假 LLM 端点的对外形态。 */
export interface FakeLLM {
  /** `http://127.0.0.1:<系统分配的端口>`。 */
  baseUrl: string
  /** 每次会话请求的 `messages`，按到达顺序；标题请求不记录也不占轮次。 */
  bodies: unknown[]
  /** 已到达的会话请求数；标题请求不计。 */
  requestCount: number
  /** 关服务；失败（录制校验不通过等）在这里抛出，不静默。 */
  close(): Promise<void>
}

/** 一条 SSE 增量；与 `src/core/llm.ts:660-677` 认的线上形状一一对应。 */
interface SseChunk {
  content?: string
  reasoning?: string
  toolCall?: { id: string; name: string; args: unknown }
}

/** 剧本校验后的内部形状：字符串轮直接摊平成正文增量。 */
type NormalizedTurn = { content: string } | { toolCall: { name: string; args: unknown } }

/**
 * SSE 帧。协议逐字节照抄 `scripts/todo-reminder-test.mjs:154-163` 的抓包：
 * 正文/工具增量 → `finish_reason` → usage 空 choices 块 → `data: [DONE]`。
 *
 * 为什么末尾三帧一条都不能省：`src/core/llm.ts:694-709` 靠 `finish_reason` 判回合形态、
 * 靠 usage 块记 token、靠 `[DONE]` 结束流。少 `[DONE]` 时流会挂到空闲超时，用例不是红，
 * 是卡满 60 秒；少 usage 则用量断言恒为 0，把一个真 bug 放成绿。
 */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 把若干增量拼成一次完整的 SSE 应答。 */
function sseBody(chunks: readonly SseChunk[]): string {
  let body = ''
  for (const chunk of chunks) {
    if (chunk.reasoning !== undefined) {
      body += frame({ choices: [{ delta: { reasoning_content: chunk.reasoning } }] })
    }
    if (chunk.content !== undefined) {
      body += frame({ choices: [{ delta: { content: chunk.content } }] })
    }
    if (chunk.toolCall !== undefined) {
      body += frame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: chunk.toolCall.id,
                  type: 'function',
                  function: { name: chunk.toolCall.name, arguments: stringifyArgs(chunk.toolCall.args) },
                },
              ],
            },
          },
        ],
      })
    }
  }
  const finishReason = chunks.some((chunk) => chunk.toolCall !== undefined) ? 'tool_calls' : 'stop'
  body += frame({ choices: [{ delta: {}, finish_reason: finishReason }] })
  body += frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })
  body += 'data: [DONE]\n\n'
  return body
}

/**
 * 工具参数在线上是 JSON **字符串**（见 `src/core/llm.ts:46`）。
 *
 * 提前序列化而不是等请求到达：`args` 里塞了循环引用或 BigInt 时，应该在 `fakeLLM()`
 * 调用处就报错并指向第几轮，而不是第一个请求进来时返回 500、让内核报一句
 * 「HTTP 500」再重试三次。错误的定位点差着三层调用栈。
 */
function stringifyArgs(args: unknown, where = 'SSE 工具调用'): string {
  let text: string | undefined
  try {
    text = JSON.stringify(args ?? {})
  } catch (error) {
    throw new Error(`${where}：工具参数不能序列化成 JSON（${errorText(error)}）`)
  }
  if (text === undefined) {
    throw new Error(`${where}：工具参数序列化后是 undefined，检查 args 是不是函数或 undefined`)
  }
  return text
}

/** 默认的标题请求判据，形状同探针：system 正文里含标题生成器提示词。 */
function isTitleRequestByPrompt(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return false
  return messages.some((message) => {
    if (message === null || typeof message !== 'object') return false
    const { role, content } = message as { role?: unknown; content?: unknown }
    return role === 'system' && typeof content === 'string' && content.includes(TITLE_PROMPT_NEEDLE)
  })
}

/** 校验剧本；错在第几轮、错在哪一项都要能直接读到。 */
function normalizeTurns(input: unknown): NormalizedTurn[] {
  if (!Array.isArray(input)) {
    throw new TypeError('fakeLLM：turns 必须是数组')
  }
  if (input.length === 0) {
    // 空剧本配「用完续用最后一条」没有定义：请求会永远拿不到应答，表现为用例挂满超时。
    throw new Error('fakeLLM：turns 不能为空（至少给一轮，假模型不会自己编）')
  }
  return input.map((turn, index) => {
    const where = `fakeLLM：第 ${index + 1} 轮`
    if (typeof turn === 'string') return { content: turn }
    if (turn !== null && typeof turn === 'object' && 'toolCall' in turn) {
      const call = (turn as { toolCall?: unknown }).toolCall
      if (call === null || typeof call !== 'object') {
        throw new Error(`${where} 的 toolCall 必须是对象 { name, args }`)
      }
      const name = (call as { name?: unknown }).name
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error(`${where} 的 toolCall.name 必须是非空字符串`)
      }
      const args = (call as { args?: unknown }).args
      stringifyArgs(args, where)
      return { toolCall: { name, args } }
    }
    throw new Error(`${where} 既不是字符串，也不是 { toolCall: { name, args } }`)
  })
}

/** 一个假端点服务端：fakeLLM 与 replayLLM 共用这套收发与记录逻辑。 */
interface FakeServerOptions {
  /** 报错前缀：红的时候要能一眼看出是哪个假端点。 */
  label: string
  /** 是否标题请求；为真时不应答剧本、不占轮次。 */
  isTitleRequest: (body: unknown) => boolean
  /** 请求到达钩子。 */
  onRequest?: (body: unknown, turn: number) => void
  /** 给出这一轮的应答；返回错误形态表示「这次请求不该被正常应答」。 */
  respond: (body: unknown, turn: number) => SseChunk[] | { status: number; message: string }
}

/**
 * 起一个假端点。端口用 `listen(0, '127.0.0.1')`：随机端口避免并行用例与开发机上别的
 * 进程撞端口；只绑回环地址，测试不会意外对局域网开放一个「谁来都答」的模型端点。
 *
 * `close()` 会先销毁连接再关服务：`server.close()` 只等已有连接自己结束，浏览器/客户端
 * 的 keep-alive 会让它一直等，表现为 vitest 跑完不退出。销毁连接是让「关」这个动作
 * 真的立刻生效，而不是等 OS 超时。
 */
async function startFakeServer(options: FakeServerOptions): Promise<FakeLLM> {
  const bodies: unknown[] = []
  /** 需要让 close() 抛出的失败：不能让「录制对不上」随着请求结束被忘掉。 */
  const failures: Error[] = []
  const sockets = new Set<Socket>()
  let requestCount = 0
  let closed = false

  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      const fail = (status: number, message: string): void => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: message }))
      }
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        fail(400, `${options.label}：请求体不是合法 JSON（${errorText(error)}）`)
        return
      }
      const messages = (body as { messages?: unknown } | null)?.messages
      if (!Array.isArray(messages)) {
        // 内核发的请求一定有 messages；这里收到别的形状说明请求组装被改坏了，
        // 必须让调用方看到 400，而不是拿一个空轮次继续。
        fail(400, `${options.label}：请求体里没有 messages 数组`)
        return
      }

      if (options.isTitleRequest(body)) {
        try {
          options.onRequest?.(body, 0)
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(errorText(error)))
          fail(400, `${options.label}：onRequest 在标题请求上抛错（${errorText(error)}）`)
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(sseBody([{ content: TITLE_REPLY }]))
        return
      }

      requestCount += 1
      const turn = requestCount
      // 会话请求体只记录 messages：这既是模型真正看到的那一份，也是 requestHash 的输入。
      bodies.push(messages)
      try {
        options.onRequest?.(body, turn)
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(errorText(error)))
        fail(400, `${options.label}：onRequest 在第 ${turn} 轮抛错（${errorText(error)}）`)
        return
      }

      let reply: SseChunk[] | { status: number; message: string }
      try {
        reply = options.respond(body, turn)
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(errorText(error)))
        fail(400, `${options.label}：第 ${turn} 轮应答时抛错（${errorText(error)}）`)
        return
      }
      if (!Array.isArray(reply)) {
        // 非 2xx 都是「这次请求不该通过」：录制校验失败必须让内核侧也失败，
        // 不能悄悄回一段正常 SSE 让用例绿着。
        const failure = new Error(reply.message)
        failures.push(failure)
        fail(reply.status, reply.message)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(sseBody(reply))
    })
  })
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      rejectListen(new Error(`${options.label}：假端点起不来（${error.message}）`))
    }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolveListen()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error(`${options.label}：listen 后拿不到端口`)
  }

  const close = async (): Promise<void> => {
    if (!closed) {
      closed = true
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose()
        })
      })
    }
    if (failures.length > 0) {
      // 关的时候再抛一次：即便调用方没检查某一轮的应答，录制对不上也不能随 close 消失。
      throw new AggregateError(failures, `${options.label}：${failures.length} 次请求没有被正常应答`)
    }
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    bodies,
    get requestCount(): number {
      return requestCount
    },
    close,
  }
}

/**
 * 起一个 OpenAI 兼容的假模型端点，按轮返回剧本。
 *
 * 协议不是自己编的：`SseChunk` 的四段应答逐字节照抄 `scripts/todo-reminder-test.mjs`
 * 的 `sseText` / `sseToolCall`（第 154-163 行），标题请求判据照抄同文件第 183-190 行。
 * 24 条探针都这么起服务，说明这是内核真正认的形状；换一种「看起来等价」的写法
 * （比如省掉 usage 块）在探针里可能也绿，但会悄悄改变被观察的行为。
 */
export async function fakeLLM(options: FakeLLMOptions): Promise<FakeLLM> {
  const turns = normalizeTurns(options?.turns)
  if (options.onRequest !== undefined && typeof options.onRequest !== 'function') {
    throw new TypeError('fakeLLM：onRequest 必须是函数')
  }
  if (options.isTitleRequest !== undefined && typeof options.isTitleRequest !== 'function') {
    throw new TypeError('fakeLLM：isTitleRequest 必须是函数')
  }
  const isTitleRequest = options.isTitleRequest ?? isTitleRequestByPrompt
  return startFakeServer({
    label: 'fakeLLM',
    isTitleRequest,
    ...(options.onRequest === undefined ? {} : { onRequest: options.onRequest }),
    respond(_body, turn) {
      // 用完继续用最后一条：探针里大多数回合是同一句「收到」，逐个列出来只会淹没重点。
      const turnIndex = Math.min(turn - 1, turns.length - 1)
      const scripted = turns[turnIndex]!
      if ('content' in scripted) return [{ content: scripted.content }]
      return [
        {
          toolCall: {
            // 每轮一个唯一 id：同一 id 重复出现时，会话层的「同 callId 只留首条」
            // 会替测试兜掉重复结果，断言就看不出「工具被调了两次」。
            id: `call_fake_${turn}`,
            name: scripted.toolCall.name,
            args: scripted.toolCall.args,
          },
        },
      ]
    },
  })
}

// ── 6.5 readSessionJsonl ─────────────────────────────────────────────────────

/**
 * 读一份会话 jsonl 成对象数组。
 *
 * ## 为什么坏行丢掉、而文件读不到就抛
 *
 * 会话日志是**运行时产物**，不是夹具：进程被杀时最后一行只写了半截是正常事故形态，
 * 一条坏行不该让「读日志」这件事整体失败（现有探针 `scripts/todo-reminder-test.mjs:279-288`
 * 也是这么剥的）。但路径不存在是另一回事——那说明调用方拿错了路径，返回空数组会让
 * 「日志里没有 X」这类断言恒真，变成假绿。
 *
 * 空行跳过；解析出来不是对象的（数组、数字、null）同样跳过：调用方拿到的每一项都能
 * 直接按字段读，不必每处再判一次类型。
 */
export function readSessionJsonl(path: string): Array<Record<string, unknown>> {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new TypeError('readSessionJsonl：path 必须是非空字符串')
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`readSessionJsonl：读不到会话文件 ${path}（${errorText(error)}）`)
  }
  // BOM 会让第一行的 JSON.parse 必失败，然后被当成坏行丢掉——第一条记录静默消失。
  const text = raw.replace(/^\uFEFF/, '')
  const records: Array<Record<string, unknown>> = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    records.push(value as Record<string, unknown>)
  }
  return records
}

