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
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DscCoreConfig } from '@pneuma/runtime/core/config.js'
import { hashChatMessages } from './support/hash.js'

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
 * ## 一个文件里只能调一次
 *
 * `HOME` 是进程级环境变量，第二次调用会把第一次的覆盖掉——于是「内核用 A、CLI 用 B」
 * 这种写法会让 `bootKernel` 读到 B 那份 HOME，`config.yaml` 写错位置，表现为用例莫名其妙
 * 找不到配置。需要多个目录就在同一个 `home` 下开子目录（`join(home, 'cli')`），
 * 不要再调一次。
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
  /**
   * 每轮返回什么：
   * - 字符串 = 纯文本回复
   * - { toolCall } = 一次工具调用
   * - { reasoning, content? } = 先一段 easoning_content（thinking 行）再正文
   */
  turns: Array<string | { toolCall: { name: string; args: unknown } } | { reasoning: string; content?: string }>
  /** 非 2xx 的应答：整份剧本都用这个状态码回（错误体是 { error }）。 */
  status?: number
  /** 额外响应头，例如 x-request-id；与 SSE 的 content-type 合并，同名以后者为准。 */
  headers?: Record<string, string>
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
type NormalizedTurn =
  | { content: string }
  | { toolCall: { name: string; args: unknown } }
  /** 带思考过程的轮：先 reasoning_content 再正文，真模型就是这么两段下来的。 */
  | { reasoning: string; content: string }

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
    if (turn !== null && typeof turn === 'object' && 'reasoning' in turn) {
      // 思考段：真模型的 thinking 行就是从 `reasoning_content` 增量拼出来的，
      // 剧本里不给这一段，transcript 的 thinking 行永远不会出现，相关断言要么恒空要么测不到。
      const reasoning = (turn as { reasoning?: unknown }).reasoning
      if (typeof reasoning !== 'string' || reasoning.trim() === '') {
        throw new Error(`${where} 的 reasoning 必须是非空字符串`)
      }
      const content = (turn as { content?: unknown }).content ?? ''
      if (typeof content !== 'string') throw new Error(`${where} 的 content 必须是字符串`)
      return { reasoning, content }
    }
    throw new Error(`${where} 既不是字符串，也不是 { toolCall: { name, args } } 或 { reasoning, content }`)
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
  /** 成功应答的状态码与额外响应头（缺省 200 + 只有 content-type）。 */
  status?: number
  headers?: Record<string, string>
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
  /** 成功应答的状态码与响应头：默认 200 + 只有 content-type，可由调用方覆盖。 */
  const successStatus = options.status ?? 200
  const successHeaders = options.headers ?? {}

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
        response.writeHead(successStatus, { 'content-type': 'text/event-stream', ...successHeaders })
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
      response.writeHead(successStatus, { 'content-type': 'text/event-stream', ...successHeaders })
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
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    isTitleRequest,
    ...(options.onRequest === undefined ? {} : { onRequest: options.onRequest }),
    respond(_body, turn) {
      // 用完继续用最后一条：探针里大多数回合是同一句「收到」，逐个列出来只会淹没重点。
      const turnIndex = Math.min(turn - 1, turns.length - 1)
      const scripted = turns[turnIndex]!
      if ('reasoning' in scripted) {
        // 两段分开送：先 reasoning_content 再正文，与真模型的到达顺序一致。
        const chunks: SseChunk[] = [{ reasoning: scripted.reasoning }]
        if (scripted.content !== '') chunks.push({ content: scripted.content })
        return chunks
      }
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

// ── 6.3 replayLLM ────────────────────────────────────────────────────────────

/** 录制文件里的一行 response 的 chunk 形状（见详设 §8.3）。 */
interface RecordedChunk {
  text?: string
  toolCall?: { name: string; args: unknown }
  done?: true
}

/** 解析后的录制：turn → 请求 hash / 应答增量。 */
interface Recording {
  requestHashes: Map<number, string>
  responses: Map<number, SseChunk[]>
  /** 录制路径，只用于报错文案。 */
  path: string
}

/** 校验一条 chunk 并翻成内部增量；`done` 只是终止标记，不产生帧。 */
function toSseChunks(chunks: unknown, turn: number, path: string): SseChunk[] {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error(`replayLLM：${path} 的 turn=${turn} 没有 chunks（空应答无法回放）`)
  }
  const out: SseChunk[] = []
  chunks.forEach((chunk, index) => {
    const where = `replayLLM：${path} 的 turn=${turn} chunks[${index}]`
    if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) {
      throw new Error(`${where} 必须是对象`)
    }
    const { text, toolCall, done } = chunk as Record<string, unknown>
    if (done !== undefined) {
      if (done !== true) throw new Error(`${where} 的 done 只能是 true`)
      if (text !== undefined || toolCall !== undefined) {
        throw new Error(`${where} 带了 done 就不能再带 text / toolCall`)
      }
      return
    }
    if (text !== undefined) {
      if (typeof text !== 'string') throw new Error(`${where} 的 text 必须是字符串`)
      out.push({ content: text })
      return
    }
    if (toolCall !== undefined) {
      if (toolCall === null || typeof toolCall !== 'object' || Array.isArray(toolCall)) {
        throw new Error(`${where} 的 toolCall 必须是对象 { name, args }`)
      }
      const name = (toolCall as { name?: unknown }).name
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error(`${where} 的 toolCall.name 必须是非空字符串`)
      }
      const args = (toolCall as { args?: unknown }).args
      stringifyArgs(args, where)
      out.push({ toolCall: { id: `call_replay_${turn}_${index}`, name, args } })
      return
    }
    throw new Error(`${where} 什么都不含（要 text、toolCall 或 done）`)
  })
  return out
}

/**
 * 读录制文件。坏行、重复 turn、缺 request 行全部直接抛：
 * 录制是进版本库的人工审核产物，坏了就该红在加载阶段，而不是回放中途给出半份剧本。
 */
function parseRecording(raw: string, path: string): Recording {
  const requestHashes = new Map<number, string>()
  const responses = new Map<number, SseChunk[]>()
  // Windows 编辑器可能给文件加 BOM；不剥掉的话第一行 JSON.parse 必失败。
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/)
  lines.forEach((line, index) => {
    if (line.trim() === '') return
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch (error) {
      throw new Error(`replayLLM：${path} 第 ${index + 1} 行不是合法 JSON（${errorText(error)}）`)
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`replayLLM：${path} 第 ${index + 1} 行不是对象`)
    }
    const { kind, turn, requestHash } = record as { kind?: unknown; turn?: unknown; requestHash?: unknown }
    if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) {
      throw new Error(`replayLLM：${path} 第 ${index + 1} 行的 turn 必须是 ≥1 的整数`)
    }
    if (kind === 'request') {
      if (requestHashes.has(turn)) {
        throw new Error(`replayLLM：${path} 里 turn=${turn} 有两条 request 行`)
      }
      if (typeof requestHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(requestHash)) {
        throw new Error(`replayLLM：${path} 第 ${index + 1} 行的 requestHash 必须是 sha256:<64 位小写十六进制>`)
      }
      requestHashes.set(turn, requestHash)
      return
    }
    if (kind === 'response') {
      if (responses.has(turn)) {
        throw new Error(`replayLLM：${path} 里 turn=${turn} 有两条 response 行`)
      }
      responses.set(turn, toSseChunks((record as { chunks?: unknown }).chunks, turn, path))
      return
    }
    throw new Error(`replayLLM：${path} 第 ${index + 1} 行的 kind 只能是 "request" 或 "response"`)
  })
  if (responses.size === 0) {
    throw new Error(`replayLLM：${path} 里没有 kind:"response" 行，没有可回放的内容`)
  }
  for (const turn of responses.keys()) {
    if (!requestHashes.has(turn)) {
      throw new Error(`replayLLM：${path} 的 turn=${turn} 只有 response 没有 request，无法校验请求形状`)
    }
  }
  return { requestHashes, responses, path }
}

/**
 * 按录制文件回放模型应答。
 *
 * 每一轮请求到达时都拿 `messages` 重算指纹，与录制里的 `requestHash` 比对；不一致就
 * **硬失败**（409 + close 时抛错），不退回「随便给一段」。这条校验存在的唯一理由，
 * 是「代码改了导致请求形状变化，回放却照样通过」——那会让整个快照层变成一层假绿。
 *
 * 返回的 `FakeLLM` 与 `fakeLLM` 同形：快照场景可以在「录制」与「回放」两种模式之间
 * 只换构造函数，其余流程完全一致。
 */
export async function replayLLM(recordingPath: string): Promise<FakeLLM> {
  if (typeof recordingPath !== 'string' || recordingPath.trim() === '') {
    throw new TypeError('replayLLM：recordingPath 必须是非空字符串')
  }
  let raw: string
  try {
    raw = readFileSync(recordingPath, 'utf8')
  } catch (error) {
    throw new Error(`replayLLM：读不到录制文件 ${recordingPath}（${errorText(error)}）`)
  }
  const recording = parseRecording(raw, recordingPath)
  return startFakeServer({
    label: `replayLLM(${recordingPath})`,
    // 录制里没有标题请求（它不是对话轮次）；仍然按提示词识别并单独应答，
    // 否则标题插件会消费掉第一轮剧本，后续轮次整体错位。
    isTitleRequest: isTitleRequestByPrompt,
    respond(body, turn) {
      const expected = recording.requestHashes.get(turn)
      if (expected === undefined) {
        return {
          status: 409,
          message: `replayLLM：录制里没有 turn=${turn} 的 request 行，回放无法校验请求形状`,
        }
      }
      const messages = (body as { messages: unknown[] }).messages
      let actual: string
      try {
        actual = hashChatMessages(messages)
      } catch (error) {
        return { status: 409, message: `replayLLM：turn=${turn} 的 messages 无法计算指纹（${errorText(error)}）` }
      }
      if (actual !== expected) {
        return {
          status: 409,
          message:
            `replayLLM：turn=${turn} 的 requestHash 不符——录制的请求形状变了。\n` +
            `  录制：${expected}\n  实际：${actual}\n` +
            '  改过系统提示 / 工具 schema / 历史组装的话，请重新录制；不要放宽这条校验。',
        }
      }
      const chunks = recording.responses.get(turn)
      if (chunks === undefined) {
        return { status: 409, message: `replayLLM：录制里没有 turn=${turn} 的 response 行` }
      }
      return chunks
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

// ── 6.4 bootKernel ───────────────────────────────────────────────────────────

/** `bootKernel` 的入参。 */
export interface BootKernelOptions {
  /** 假模型的 baseUrl；内核会把它装成一个名为 `test` 的供应商。 */
  providerBaseUrl: string
  /** 覆盖默认配置的顶层字段（providers 要整份给，不做深合并）。 */
  config?: Record<string, unknown>
  /**
   * 从一份已有会话接着起（对应 createKernel 的 esumeSessionPath）。
   *
   * 给「启动回填」这类用例用：不传就是新建会话，session.resumedStartup 永远是 false，
   * 那条路径根本走不到。传了才验得到启动时读旧会话的行为。
   */
  resumeSessionPath?: string | null
}

/** 起好的真内核。 */
export interface BootedKernel {
  /** cordis 根 Context；按需断言服务时再窄化。 */
  ctx: unknown
  /** 跑一个真回合：发消息 → 等 turn-end → 等 agent 空闲 → 等落盘。 */
  runTurn(text: string): Promise<void>
  /** 卸载内核；可重复调用。 */
  dispose(): Promise<void>
}

/** 内核里 harness 用到的服务面：只声明用到的，不把整个 Context 类型拖进来。 */
interface KernelSurface {
  on(event: 'dsc/turn-end', listener: (reason: string) => void): () => void
  emit(event: 'dsc/exit'): void
  registry: { keys(): Iterable<unknown>; delete(plugin: unknown): unknown }
  agent: { followup(text: string): void; isRunning(filePath: string): boolean }
  session: { current(): { filePath: string } }
}

/** 默认供应商配置：形状照抄 `scripts/todo-reminder-test.mjs:207-233` 的可用组合。 */
function defaultKernelConfig(baseUrl: string): DscCoreConfig {
  return {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl,
        apiKey: 'k',
        models: [
          {
            id: 'm',
            name: 'm',
            contextWindow: 100000,
            maxTokens: 500,
            modalities: ['text'],
            thinkingLevels: [],
            thinkingParam: 'none',
            effortMap: {},
          },
        ],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  }
}

/**
 * 确认「现在的主目录是临时的」，并返回它。
 *
 * ## 为什么必须在起内核前判一次
 *
 * `core/path-policy.ts` 的 `DSC_HOME` 是模块顶层常量，由 `homedir()/.dsc` 一次算定；
 * 一旦落到真实主目录，内核就会往开发者自己的 `~/.dsc` 写会话、抢真实会话的写租约。
 * 失败的样子不是报错，是「测试绿了、用户数据脏了」——这类事故只能在入口处拦住。
 *
 * 判据用「路径是否在系统临时目录里」，不依赖调用过 `tempHome()` 的记账：integration 层
 * 的 setup（`tests/setup/temp-home.ts`）也是一样建临时目录的，两套入口都该被放行。
 * 顺带覆盖 `DSC_HOME` 被外部环境变量指向真实目录的情况。
 */
function assertIsolatedHome(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home === undefined || home.trim() === '') {
    throw new Error('bootKernel：HOME / USERPROFILE 都没设，先调 tempHome() 再起内核（否则会写真实 ~/.dsc）')
  }
  const temp = tmpdir()
  const dscHome = process.env.DSC_HOME ?? join(home, '.dsc')
  if (!isInside(home, temp) || !isInside(dscHome, temp)) {
    throw new Error(
      'bootKernel：拒绝在真实主目录上起内核。\n' +
        `  HOME=${home}\n  DSC_HOME=${dscHome}\n  临时目录=${temp}\n` +
        '  先调 tempHome()（integration 层由 tests/setup/temp-home.ts 兜底）。',
    )
  }
  return home
}

/**
 * 铺一份最小的隔离主目录：关掉长期记忆与 OS 沙箱，`config.yaml` 给个模型名。
 *
 * 为什么关记忆：它在回合结束会投机器通知、还会**多发一次模型请求**（探针
 * `scripts/todo-reminder-test.mjs:32-37` 踩过）。假模型按请求序号发剧本，多出来的这次
 * 请求会吃掉下一轮剧本，断言结果看起来随机错位。
 *
 * 为什么关沙箱：Windows 上它启动时要做账号/网络体检（`sandbox/win/doctor.ts:176`），
 * 会 spawn 一个 PowerShell 子进程；实测这个子进程在测试 worker 里可能一直挂着，
 * vitest 跑完不退出。harness 的目标是「起真内核跑假模型」，工具执行的 OS 隔离不在
 * 这一层验证；需要沙箱行为的用例自己预置 `plugins.json` 覆盖本清单。
 *
 * 为什么关标题插件：它会在回合之间**多发一次请求**去起标题。假模型按请求序号发剧本，
 * 这一次会吃掉下一轮剧本——症状是「第一个回合绿、后面回合悄悄不调工具」，而且不像报错，
 * 像模型自己改了主意。`isTitleRequestByPrompt` 认的是内置提示词，插件换了措辞就漏判，
 * 所以这里直接停用，比靠提示词识别可靠。要验标题行为就在 `fakeLLM` 里给
 * `isTitleRequest`，或自己预置清单把它打开。
 *
 * 只在文件不存在时写：调用方预置的清单优先。
 */
function prepareIsolatedHome(home: string): void {
  const dscHome = process.env.DSC_HOME ?? join(home, '.dsc')
  mkdirSync(dscHome, { recursive: true })
  const pluginsFile = join(dscHome, 'plugins.json')
  if (!existsSync(pluginsFile)) {
    const plugins = {
      version: 1,
      // memory 走 config.enabled（插件自己的开关）；sandbox 与 session-title 走 disabled
      // （条目树的总开关）。三条理由见上方注释：多一次请求就会吃掉一轮剧本。
      entries: [
        { file: 'memory', config: { enabled: false } },
        { file: 'sandbox', disabled: true },
        { file: 'session-title', disabled: true },
      ],
    }
    writeFileSync(pluginsFile, `${JSON.stringify(plugins, null, 2)}\n`, 'utf8')
  }
  const configFile = join(dscHome, 'config.yaml')
  if (!existsSync(configFile)) {
    writeFileSync(configFile, 'model:\n  name: test\n', 'utf8')
  }
}

/**
 * 起真内核：装配全部行与插件，供应商指向假端点。
 *
 * 返回的 `runTurn` 是探针里那段等待逻辑的封装（`scripts/todo-reminder-test.mjs:239-250`）：
 * 先挂 `dsc/turn-end` 再 `followup`（反过来会漏掉同步结束的回合），然后等 agent 空闲，
 * 最后给 80ms 让会话写流落盘。少了最后这一拍，紧跟其后的 `readSessionJsonl` 会随机
 * 读到缺少最后一条记录的日志——这是最容易被误判成「会话丢消息」的假失败。
 */
/**
 * 建一个临时 git 仓库并把进程 cwd 挪进去，返回 `{ dir, restore }`。
 *
 * ## 为什么需要它
 *
 * 内核的 `turnDiff` 与会话 `meta.cwd` 都取自**进程当前工作目录**，`env-facts` 还直接跑
 * `git` 读工作区状态。用例若跑在仓库自己的工作区里，就会把**开发机上未提交的改动**当成
 * 「这一轮改了这些文件」——别人同时在写文件时，实时路径与重放路径对不上，用例红得莫名其妙
 * （实测：`transcript-metadata` 的 `turnDiff` 里出现了另一个代理刚建的文件）。
 *
 * 换到独立仓库之后，工作区只含这条用例自己写的东西，实时与重放才可比。
 *
 * ## 用法
 *
 * ```ts
 * const repo = tempRepo()
 * afterAll(repo.restore)
 * ```
 *
 * `restore` 只 chdir 回去，**不删目录**：失败了要留着看 git 状态。vitest 的 forks 池下
 * 每个测试文件一个进程，`process.chdir` 不会影响别的文件。
 */
export function tempRepo(prefix = 'dsc-repo-'): { dir: string; restore: () => void } {
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    throw new TypeError('tempRepo：prefix 必须是非空字符串')
  }
  if (prefix.includes('/') || prefix.includes('\\') || prefix.includes('..')) {
    throw new TypeError('tempRepo：prefix 不能带路径分隔符或 ..（会把仓库建到临时目录外）')
  }
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  git(['init', '-q'])
  // 没有这两个身份，git 在干净机器上会拒绝提交，用例红在建仓库这一步而不是被测逻辑。
  git(['config', 'user.email', 'dsc-test@example.com'])
  git(['config', 'user.name', 'dsc-test'])
  const before = process.cwd()
  process.chdir(dir)
  return {
    dir,
    restore: () => {
      process.chdir(before)
    },
  }
}

/**
 * `bootKernel` 之前必须先确认 `lib/` 不比 `src/` 旧。
 *
 * ## 为什么这条守卫是必须的
 *
 * 内核启动时会经 `core/plugin-loader.ts` 的 `APP_INSTALL_DIR` 去
 * `<仓库根>/lib/node_modules/@pneuma/*` 装配插件，那些包是构建产物、由 Node 直接 import，
 * **不走 Vite 的 `@pneuma/runtime → src` 别名**。于是 `bootKernel` 起的其实是「宿主来自
 * src、插件来自 lib」的混合装配。
 *
 * 后果不是报错，是**绿着放过回归**：改了 `src/core/*.ts` 却没 `pnpm build`，
 * 内核跑的仍是旧的 `lib/core/*.js`，integration 用例照样全绿。这种假绿比红危险得多，
 * 只能在启动前判一次。
 *
 * 判据用文件时间而不是内容摘要：`tsc` 的增量构建会让 lib 的 mtime 晚于源文件，
 * 反过来「源文件比 lib 新」就一定是没构建。代价是一次目录遍历（约 900 个 .ts）。
 */
function assertBuildIsFresh(): void {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const marker = join(root, 'lib', 'core', 'session.js')
  if (!existsSync(marker)) {
    throw new Error('bootKernel：没有 lib/ 构建产物。先跑 `pnpm run build`（integration 层跑的是 lib 平面）')
  }
  const builtAt = statSync(marker).mtimeMs
  let newest = { file: '', at: 0 }
  for (const area of ['core', 'host', 'packages', 'services', 'contract']) {
    const dir = join(root, 'src', area)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      // 测试文件与类型声明不参与构建，别让它们把守卫唤醒。
      if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.int.spec.ts') || entry.name.endsWith('.d.ts')) continue
      const file = join(entry.parentPath, entry.name)
      const at = statSync(file).mtimeMs
      if (at > newest.at) newest = { file, at }
    }
  }
  if (newest.at > builtAt) {
    const rel = newest.file.slice(root.length).replace(/\\/g, '/')
    throw new Error(
      'bootKernel：lib/ 比源码旧，内核会跑旧的构建产物（假绿）。先跑 `pnpm run build`。\n' +
        `  最新的源文件：${rel}\n` +
        `  lib 构建时间：${new Date(builtAt).toISOString()}\n` +
        `  源文件时间：  ${new Date(newest.at).toISOString()}`,
    )
  }
}

export async function bootKernel(options: BootKernelOptions): Promise<BootedKernel> {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('bootKernel：options 必须是 { providerBaseUrl, config? }')
  }  const baseUrl = options.providerBaseUrl
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    throw new TypeError(`bootKernel：providerBaseUrl 必须是 http(s):// 地址（收到 ${JSON.stringify(baseUrl)}）`)
  }
  if (options.config !== undefined && (options.config === null || typeof options.config !== 'object' || Array.isArray(options.config))) {
    throw new TypeError('bootKernel：config 必须是普通对象')
  }
  const home = assertIsolatedHome()
  if (!existsSync(CLI_ENTRY)) {
    // bin/dsc.js 与测试同仓；缺了说明工作树不对（比如只 checkout 了部分目录）。
    throw new Error(`bootKernel：找不到内核入口 ${CLI_ENTRY}，工作树不完整？`)
  }
  assertBuildIsFresh()
  prepareIsolatedHome(home)
  const config = { ...defaultKernelConfig(baseUrl), ...(options.config ?? {}) } as unknown as DscCoreConfig
  // 动态 import：unit 层的用例只用 tempHome / fakeLLM 时，不该把整张内核插件图拖进来
  // （那会让单条用例从 5ms 变成上百毫秒，也让「unit 不碰真内核」这条规矩更难守）。
  //
  // 说明符带 `.js` 是 NodeNext 的要求；`tsconfig.spec.json` 的 include 里有整棵 `src`，
  // 所以 cordis 的 `Context` 声明合并也在程序里，这里不需要任何类型绕过。
  const kernelModule = (await import('@pneuma/runtime/host/kernel.js')) as {
    createKernel: (bootOptions: { config: DscCoreConfig; resumeSessionPath: string | null }) => Promise<unknown>
  }
  const ctx = await kernelModule.createKernel({ config, resumeSessionPath: options.resumeSessionPath ?? null })
  const surface = ctx as unknown as KernelSurface
  const missing = [
    typeof surface.on === 'function' ? undefined : 'ctx.on',
    typeof surface.emit === 'function' ? undefined : 'ctx.emit',
    typeof surface.registry?.keys === 'function' ? undefined : 'ctx.registry.keys',
    typeof surface.registry?.delete === 'function' ? undefined : 'ctx.registry.delete',
    typeof surface.agent?.followup === 'function' ? undefined : 'ctx.agent.followup',
    typeof surface.agent?.isRunning === 'function' ? undefined : 'ctx.agent.isRunning',
    typeof surface.session?.current === 'function' ? undefined : 'ctx.session.current',
  ].filter((item): item is string => item !== undefined)
  if (missing.length > 0) {
    // 内核起来了但服务没挂全：没有可用的卸载口也要尽量先收尾，别把定时器留在进程里。
    try {
      surface.emit?.('dsc/exit')
    } catch {
      // 装配都不完整，这一步失败只会掩盖真正缺的服务名。
    }
    throw new Error(`bootKernel：内核装配不完整，缺少 ${missing.join('、')}`)
  }

  let disposed = false
  const isRunning = (): boolean => surface.agent.isRunning(surface.session.current().filePath)

  const runTurn = async (text: string): Promise<void> => {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError('bootKernel.runTurn：text 必须是非空字符串')
    }
    if (disposed) throw new Error('bootKernel.runTurn：内核已 dispose，不能再跑回合')
    let off = (): void => {}
    const ended = new Promise<void>((resolveTurn, rejectTurn) => {
      const timer = setTimeout(() => {
        off()
        rejectTurn(
          new Error(
            `bootKernel.runTurn：${RUN_TURN_TIMEOUT_MS}ms 内没等到 dsc/turn-end（假端点关了吗？回合卡在哪一步？）`,
          ),
        )
      }, RUN_TURN_TIMEOUT_MS)
      off = surface.on('dsc/turn-end', (reason: string) => {
        clearTimeout(timer)
        off()
        if (reason === 'completed') resolveTurn()
        // 非正常结束必须让调用方看到：把 error 当成功吞掉，会让「模型请求被拒」这类
        // 事故变成一条「回合跑完了但会话是空的」的诡异断言，排查方向完全错。
        else rejectTurn(new Error(`bootKernel.runTurn：回合以 ${reason} 结束，不是 completed`))
      })
    })
    surface.agent.followup(text)
    await ended
    const idle = await until(() => !isRunning(), RUN_TURN_TIMEOUT_MS)
    if (!idle) {
      throw new Error(`bootKernel.runTurn：turn-end 之后 ${RUN_TURN_TIMEOUT_MS}ms 仍未空闲，内核可能卡在写租约或收尾`)
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, SETTLE_AFTER_TURN_MS))
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    const failures: Error[] = []
    // 先发应用层收尾事件：session / agent / tui 这些插件在 `dsc/exit` 上关文件、停回合
    // （`src/packages/session/index.ts:351`、`src/packages/agent/index.ts:323`）。
    try {
      surface.emit('dsc/exit')
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(errorText(error)))
    }
    // 再逐个卸载插件 fiber：只发 dsc/exit 不够——定时器、监听器、子进程是插件 disposer
    // 收的，不卸载它们，vitest 的 worker 会被句柄钉住（实测：不卸载时进程 5 秒仍不退出）。
    // cordis 4.1 的根 Context 没有 `dispose()`（很多探针里的 `ctx.dispose?.()` 实际是空操作），
    // 能用的卸载口是 registry：`delete(plugin)` 会 dispose 该插件的全部 fiber。
    for (const plugin of [...surface.registry.keys()]) {
      try {
        surface.registry.delete(plugin)
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(errorText(error)))
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `bootKernel.dispose：${failures.length} 个插件收尾失败`)
    }
  }

  return { ctx, runTurn, dispose }
}

// ── 6.6 runCli ───────────────────────────────────────────────────────────────

/** `runCli` 的可选项。 */
export interface RunCliOptions {
  /** 超时毫秒，默认 60_000；超时后 SIGKILL 并返回，不抛。 */
  timeoutMs?: number
  /** 写进 stdin 的内容；给了就写完即关。 */
  input?: string
  /** 追加/覆盖的环境变量。 */
  env?: Record<string, string>
  /** 子进程工作目录，默认本次调用新建的临时目录。 */
  cwd?: string
}

/** `runCli` 的结果。 */
export interface RunCliResult {
  /** 退出码；被超时杀掉时可能是 null（POSIX）或 1（Windows）。 */
  code: number | null
  /** 结束信号；正常退出是 null。 */
  signal: string | null
  stdout: string
  stderr: string
  /**
   * 是否由 `timeoutMs` 杀掉。
   *
   * 为什么加这个字段：Windows 上被 kill 的进程报 `code=1, signal=null`，与「CLI 自己
   * 退出 1」无法区分；只看 spec 里那四个字段，超时用例在 Windows 上没法断言。
   * 这是对 §6.6 返回形状的**加法**，不影响按位置读四个字段的调用方。
   */
  timedOut: boolean
}

/**
 * 用真入口 `bin/dsc.js` 起一次 CLI。
 *
 * ## 为什么要临时 HOME + 删掉继承的 DSC_HOME
 *
 * 真入口会读写 `~/.dsc`：配置、会话、锁文件。测试若继承开发者的 `DSC_HOME`
 * （有人为了多工作区并设过这个变量），隔离就整个失效，而且失效时不会报错——
 * CLI 只是安静地把测试会话写进了真实目录。删掉再允许 `opts.env` 显式覆盖，是
 * 「默认隔离、要越界必须明说」。
 *
 * ## 为什么超时不抛
 *
 * 超时是**被测行为**的一部分（CLI 卡死了吗），不是 harness 的故障。harness 抛错会让
 * 调用方没法把「卡死」和「CLI 正常退出但退出码不对」分开断言。所以超时只杀进程、
 * 把 `timedOut` 与已收到的输出交回去，红不红由调用方的断言决定。
 */
export function runCli(args: string[], opts: RunCliOptions = {}): Promise<RunCliResult> {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('runCli：args 必须是字符串数组')
  }
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError('runCli：opts 必须是对象')
  }
  const timeoutMs = opts.timeoutMs ?? 60_000
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`runCli：timeoutMs 必须是正数（收到 ${JSON.stringify(opts.timeoutMs)}）`)
  }
  if (opts.input !== undefined && typeof opts.input !== 'string') {
    throw new TypeError('runCli：input 必须是字符串')
  }
  if (opts.env !== undefined) {
    if (opts.env === null || typeof opts.env !== 'object' || Array.isArray(opts.env)) {
      throw new TypeError('runCli：env 必须是 { 名字: 值 } 对象')
    }
    for (const [key, value] of Object.entries(opts.env)) {
      if (typeof value !== 'string') throw new TypeError(`runCli：环境变量 ${key} 的值必须是字符串`)
    }
  }
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`runCli：找不到 CLI 入口 ${CLI_ENTRY}`)
  }
  const home = mkdtempSync(join(tmpdir(), 'dsc-cli-'))
  const env: NodeJS.ProcessEnv = { ...process.env }
  // 继承来的 DSC_HOME 指到真实目录时，HOME 换了也没用（path-policy 优先读它）。
  delete env.DSC_HOME
  Object.assign(env, { HOME: home, USERPROFILE: home, NO_COLOR: '1', FORCE_COLOR: '0' }, opts.env ?? {})

  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    cwd: opts.cwd ?? home,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  return new Promise<RunCliResult>((resolveRun, rejectRun) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      // SIGKILL：CLI 可能装着信号处理器（Ctrl+C 收尾），SIGTERM 会被它接住继续跑。
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.stdin.on('error', () => {
      // 子进程提前退出时写 stdin 会 EPIPE；这不是被测行为，忽略即可。
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectRun(new Error(`runCli：启动 ${process.execPath} 失败（${error.message}）`))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ code, signal, stdout, stderr, timedOut })
    })
    child.stdin.end(opts.input ?? '')
  })
}

// ── 6.7 expectGolden ─────────────────────────────────────────────────────────

/** `expectGolden` 的可选项。 */
export interface ExpectGoldenOptions {
  /** 为 true 时写盘而不是比对；与 `UPDATE_GOLDEN=1` 等效。 */
  update?: boolean
}

/** 路径占位替换时的「路径到此为止」字符：空白、引号与常见中英文标点。 */
const GOLDEN_PATH_STOP = '\\s"\'`，。、；：（）,;:()\\[\\]{}<>'

/** 把以临时目录开头的一整段路径换成 `<TMP>`（连同随机后缀，否则 golden 每跑一次都不一样）。 */
function replaceTempSubtree(text: string, temp: string): string {
  let out = text
  // Windows 上同一路径可能以正斜杠形式出现；大小写也不保证一致（盘符/用户目录）。
  for (const variant of new Set([temp, temp.replaceAll('\\', '/'), temp.replaceAll('/', '\\')])) {
    out = out.replace(new RegExp(`${escapeRegExp(variant)}[^${GOLDEN_PATH_STOP}]*`, 'gi'), '<TMP>')
  }
  return out
}

/** 把一段文本里的绝对路径/时间/PID 换成占位符，让 golden 跨机器可比。 */
function normalizeGolden(text: string): string {
  // 先统一换行：Windows 检出的 LF/CRLF 差异不是被测内容，不该出现在 golden 差异里。
  let out = text.replace(/\r\n/g, '\n')
  // 临时目录整段替换：tempHome 与 runCli 的目录名带随机后缀，只换掉前缀的话，
  // 每次运行剩下的 `-a1b2c3` 仍然不同，golden 会一直红——那等于逼着每条用例都去
  // 更新 golden，最后没人再看 diff。
  out = replaceTempSubtree(out, tmpdir())
  // 主目录只换前缀：`<HOME>/.dsc/sessions/x.jsonl` 里后半段是稳定的、
  // 有排查价值的信息（哪个会话文件），整段吃掉就看不见了。
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home !== undefined && home.trim() !== '') {
    out = out.split(home).join('<HOME>')
    out = out.split(home.replaceAll('\\', '/')).join('<HOME>')
    out = out.split(home.replaceAll('/', '\\')).join('<HOME>')
  }
  // 时间戳分三层：带时区的 ISO 时间、纯日期、纯时间。顺序不能反——先换 ISO，
  // 否则其中的日期与时间会被后两条规则拆成两个占位符，golden 反而更难读。
  out = out.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<TIMESTAMP>')
  out = out.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<DATE>')
  out = out.replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<TIME>')
  out = out.replace(/\b(?:pid|PID|Pid)\s*[:=]?\s*\d+\b/g, '<PID>')
  // 末尾换行不参与比对：编辑器保存时常补一个，差异里只有它等于噪声。
  return out.replace(/\n+$/, '')
}

/** 一行 diff。 */
interface DiffOp {
  type: ' ' | '-' | '+'
  text: string
}

/** 超长文本退化成「公共前后缀之外整段替换」，避免 LCS 的 O(n·m) 内存把测试拖死。 */
function fallbackDiff(expected: readonly string[], actual: readonly string[]): DiffOp[] {
  let start = 0
  while (start < expected.length && start < actual.length && expected[start] === actual[start]) start += 1
  let endExpected = expected.length - 1
  let endActual = actual.length - 1
  while (endExpected >= start && endActual >= start && expected[endExpected] === actual[endActual]) {
    endExpected -= 1
    endActual -= 1
  }
  const ops: DiffOp[] = []
  for (let index = 0; index < start; index += 1) ops.push({ type: ' ', text: expected[index]! })
  for (let index = start; index <= endExpected; index += 1) ops.push({ type: '-', text: expected[index]! })
  for (let index = start; index <= endActual; index += 1) ops.push({ type: '+', text: actual[index]! })
  for (let index = endExpected + 1; index < expected.length; index += 1) ops.push({ type: ' ', text: expected[index]! })
  return ops
}

/** 逐行 LCS，给出保持顺序的最小编辑序列（长度上限内）。 */
function diffOps(expected: readonly string[], actual: readonly string[]): DiffOp[] {
  // 1000×1000 是 4MB 的表格；golden 是给人看的文本快照，超过这个规模说明选错了比对方式。
  if (expected.length * actual.length > 1_000_000) return fallbackDiff(expected, actual)
  const table: number[][] = Array.from({ length: expected.length + 1 }, () => new Array<number>(actual.length + 1).fill(0))
  for (let i = expected.length - 1; i >= 0; i -= 1) {
    for (let j = actual.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        expected[i] === actual[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < expected.length && j < actual.length) {
    if (expected[i] === actual[j]) {
      ops.push({ type: ' ', text: expected[i]! })
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ type: '-', text: expected[i]! })
      i += 1
    } else {
      ops.push({ type: '+', text: actual[j]! })
      j += 1
    }
  }
  while (i < expected.length) {
    ops.push({ type: '-', text: expected[i]! })
    i += 1
  }
  while (j < actual.length) {
    ops.push({ type: '+', text: actual[j]! })
    j += 1
  }
  return ops
}

/** 把编辑序列渲染成带 hunk 头的 unified diff，最多 `maxLines` 行。 */
function unifiedDiff(
  expected: string,
  actual: string,
  expectedLabel: string,
  actualLabel: string,
  maxLines = 40,
): string {
  const ops = diffOps(expected.split('\n'), actual.split('\n'))
  // 每个下标之前各有几行属于 expected / actual：hunk 头的行号从这里取。
  const expectedBefore = [0]
  const actualBefore = [0]
  for (const op of ops) {
    expectedBefore.push(expectedBefore[expectedBefore.length - 1]! + (op.type === '+' ? 0 : 1))
    actualBefore.push(actualBefore[actualBefore.length - 1]! + (op.type === '-' ? 0 : 1))
  }
  const lines: string[] = [`--- ${expectedLabel}`, `+++ ${actualLabel}`]
  let index = 0
  while (index < ops.length) {
    while (index < ops.length && ops[index]!.type === ' ') index += 1
    if (index >= ops.length) break
    const start = Math.max(0, index - 3)
    let end = index
    while (end < ops.length) {
      if (ops[end]!.type !== ' ') {
        end += 1
        continue
      }
      // 两处改动之间隔了 6 行以上就断开成两个 hunk：中间那段上下文对读者没有价值。
      let runEnd = end
      while (runEnd < ops.length && ops[runEnd]!.type === ' ') runEnd += 1
      if (runEnd - end > 6 && runEnd < ops.length) {
        end += 3
        break
      }
      end = runEnd
    }
    lines.push(`@@ -${expectedBefore[start]! + 1} +${actualBefore[start]! + 1} @@`)
    for (let at = start; at < end; at += 1) lines.push(`${ops[at]!.type}${ops[at]!.text}`)
    index = end
  }
  if (lines.length <= maxLines) return lines.join('\n')
  return `${lines.slice(0, maxLines).join('\n')}\n…（差异共 ${lines.length} 行，已截断）`
}

/** golden 名字校验：拒绝绝对路径与 `..`，否则 `expectGolden('x', '../x')` 能写到仓库外。 */
function goldenFileOf(name: string): { file: string; label: string } {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('expectGolden：name 必须是非空字符串')
  }
  if (isAbsolute(name)) {
    throw new Error(`expectGolden：name 不能是绝对路径（收到 ${JSON.stringify(name)}）`)
  }
  const normalized = name.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new Error(`expectGolden：name 不能包含 ".." 或空路径段（收到 ${JSON.stringify(name)}）`)
  }
  const file = join(GOLDEN_DIR, normalized.endsWith('.txt') ? normalized : `${normalized}.txt`)
  if (!isInside(file, GOLDEN_DIR)) {
    throw new Error(`expectGolden：name 逃出了 golden 目录（收到 ${JSON.stringify(name)}）`)
  }
  return { file, label: relative(REPO_ROOT, file).replaceAll('\\', '/') }
}

/**
 * golden 比对：把当前输出与 `tests/snapshots/golden/<name>.txt` 比。
 *
 * ## 为什么归一化只做这几件事
 *
 * golden 是「人眼要读的文本快照」（TUI 帧、CLI 输出），不是逐字节的序列化产物。
 * 临时路径、时间戳、PID 每次运行都不同，不归一会让每条 golden 用例一跑就红；
 * 但归一化过度（比如把所有数字都抹掉）会让 golden 失去发现真变化的能力。
 * 所以只替换**确定性为「每次必然不同」**的三类东西，别的原样比。
 *
 * ## 更新模式
 *
 * `UPDATE_GOLDEN=1` 或 `opts.update` 时写盘并直接返回。写盘前同样归一化——
 * 存进去的必须是归一化后的版本，否则下次比对永远对不上。
 */
export function expectGolden(actual: string, name: string, opts: ExpectGoldenOptions = {}): void {
  if (typeof actual !== 'string') {
    throw new TypeError('expectGolden：actual 必须是字符串')
  }
  const { file, label } = goldenFileOf(name)
  const normalized = normalizeGolden(actual)
  const update = opts.update === true || process.env.UPDATE_GOLDEN === '1'
  if (update) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${normalized}\n`, 'utf8')
    return
  }
  if (!existsSync(file)) {
    // 不存在时给出可执行的下一步，而不是一句「期望 undefined」。
    throw new Error(`golden 不存在：${label}\n用 UPDATE_GOLDEN=1 重新生成（人工审一遍再提交）`)
  }
  const expected = normalizeGolden(readFileSync(file, 'utf8'))
  if (normalized === expected) return
  const diff = unifiedDiff(expected, normalized, label, '本次实际输出')
  throw new Error(
    `golden 不匹配：${label}\n` +
      `  expected ${expected.split('\n').length} 行 / actual ${normalized.split('\n').length} 行\n` +
      '  确认是有意改动后用 UPDATE_GOLDEN=1 重新生成，并人工审 diff。\n' +
      diff,
  )
}
