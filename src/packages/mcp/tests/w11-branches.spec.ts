/**
 * mcp 协议层与清单解析的分支补测（w11）。
 *
 * 两条线：
 *   1. `parseServerList` 的每一种坏项（缺字段、类型不对、transport/risk 越界）；
 *   2. `openConnection` 的 HTTP 通道（streamable-http）：握手、会话 id 回填、SSE 分帧、
 *      非 200/空体/坏 JSON/非对象/网络错误、通知与 close 的 DELETE、翻页到上限。
 *
 * 不出网、不起子进程：`fetch` 换成按 JSON-RPC 方法应答的桩。
 *
 * @module dsc/packages/mcp/tests/w11-branches
 */
import { afterEach, expect, test, vi } from 'vitest'
import {
  MCP_PROTOCOL_VERSIONS,
  openConnection,
  parseServerList,
  type McpConnection,
  type McpServerConfig,
} from '../mcp.js'

const open: McpConnection[] = []

afterEach(() => {
  for (const connection of open.splice(0)) {
    try {
      connection.close()
    } catch {
      // 已经断了
    }
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const signal = (): AbortSignal => AbortSignal.timeout(2_000)

function entry(patch: Record<string, unknown>): unknown {
  return { name: 'srv', command: 'node', ...patch }
}

function problemOf(items: unknown[]): string {
  const parsed = parseServerList(JSON.stringify(items), 'read')
  expect(parsed.servers).toEqual([])
  expect(parsed.problem).not.toBeNull()
  return String(parsed.problem)
}

test('清单解析：每一项的坏形状都报清楚', () => {
  expect(problemOf([null])).toContain('不是一个对象')
  expect(problemOf([entry({ name: undefined })])).toContain('缺 name')
  expect(problemOf([entry({ name: 'bad name!' })])).toContain('只能用字母')
  expect(problemOf([entry({ transport: 'sse' })])).toContain('transport 只能是')
  expect(problemOf([entry({ args: 'x' })])).toContain('args 要是一个字符串数组')
  expect(problemOf([entry({ args: ['ok', 1] })])).toContain('args 要是一个字符串数组')
  expect(problemOf([entry({ env: [] })])).toContain('env 要是')
  expect(problemOf([entry({ env: { A: 1 } })])).toContain('env 要是')
  expect(problemOf([entry({ headers: 'x' })])).toContain('headers 要是')
  expect(problemOf([entry({ risk: [] })])).toContain('risk 要是')
  expect(problemOf([entry({ risk: { tool: 'admin' } })])).toContain('risk 要是')
  expect(problemOf([entry({ defaultRisk: 'admin' })])).toContain('defaultRisk 只能是')
  expect(problemOf([entry({ command: '' })])).toContain('必须写 command')
  expect(problemOf([entry({ transport: 'http', url: 'ftp://x' })])).toContain('url 要以')
  expect(problemOf([entry({}), entry({})])).toContain('name 与前面重了')
})

test('清单解析：空串与合法项都不报问题，坏 JSON / 非数组给出直白原因', () => {
  expect(parseServerList('   ', 'exec')).toEqual({ servers: [], problem: null })
  const good = parseServerList(JSON.stringify([{ name: 'a', transport: 'http', url: 'https://x' }]), 'exec')
  expect(good.problem).toBeNull()
  expect(good.servers[0]).toMatchObject({ name: 'a', transport: 'http', defaultRisk: 'exec' })
  expect(parseServerList('{', 'read').problem).toContain('不是合法 JSON')
  expect(parseServerList('{}', 'read').problem).toContain('JSON 数组')
})

// ── HTTP 通道 ────────────────────────────────────────────────────────────────

interface RpcBody {
  id?: number
  method: string
  params?: Record<string, unknown>
}

function config(): McpServerConfig {
  return {
    name: 'http',
    transport: 'http',
    command: '',
    args: [],
    cwd: '',
    env: {},
    url: 'http://mcp.test/rpc',
    headers: { authorization: 'Bearer x' },
    risk: {},
    defaultRisk: 'read',
  }
}

const json = (value: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...headers } })

const initResult = {
  protocolVersion: MCP_PROTOCOL_VERSIONS[0],
  instructions: '用法',
  capabilities: { resources: {}, prompts: {} },
}

type Responder = (body: RpcBody, init: RequestInit | undefined) => Response | Promise<Response>

async function connect(responder: Responder): Promise<McpConnection> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as RpcBody
      return await responder(body, init)
    }),
  )
  const connection = await openConnection(config(), {
    connectTimeoutMs: 1_000,
    callTimeoutMs: 1_000,
    onClose: () => undefined,
  })
  open.push(connection)
  return connection
}

function standard(extra: (body: RpcBody) => Response | undefined = () => undefined): Responder {
  return (body) => {
    const custom = extra(body)
    if (custom !== undefined) return custom
    if (body.method === 'initialize') {
      return json({ jsonrpc: '2.0', id: body.id, result: initResult }, { 'mcp-session-id': 'sess-1' })
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    return json({ jsonrpc: '2.0', id: body.id, result: {} })
  }
}

test('HTTP 握手：会话 id 回填到后续请求，close 时发 DELETE', async () => {
  const calls: Array<{ method: string; session: string | null }> = []
  const connection = await connect((body, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ method: body.method ?? String(init?.method ?? ''), session: headers['mcp-session-id'] ?? null })
    return standard()(body, init)
  })
  expect(connection.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0])
  expect(connection.instructions).toBe('用法')
  expect(connection.capabilities).toEqual({ resources: true, prompts: true })
  await connection.listTools(signal())
  expect(calls.find((call) => call.method === 'tools/list')?.session).toBe('sess-1')

  connection.close()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(calls.some((call) => call.method === 'DELETE')).toBe(true)
  expect(connection.alive).toBe(false)
  await expect(connection.listTools(signal())).rejects.toThrow(/已经关了/)
})

test('HTTP 错误路径：非 200、空体、坏 JSON、非对象、网络错误、JSON-RPC error', async () => {
  await expect(
    connect(() => new Response('boom', { status: 500 })),
  ).rejects.toThrow(/MCP HTTP 500：boom/)

  await expect(connect(() => new Response('', { status: 200 }))).rejects.toThrow(/协议版本/)

  await expect(connect(() => new Response('not-json', { status: 200 }))).rejects.toThrow(/不是 JSON/)

  await expect(connect(() => json([]))).rejects.toThrow(/不是一个 JSON-RPC 对象/)

  await expect(
    connect(() => {
      throw new Error('dns down')
    }),
  ).rejects.toThrow(/请求发不出去/)

  await expect(
    connect(() => json({ jsonrpc: '2.0', id: 1, error: 'primitive' })),
  ).rejects.toThrow(/MCP 错误：primitive/)

  await expect(
    connect(() => json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: '炸了' } })),
  ).rejects.toThrow(/MCP 错误 -32000：炸了/)
})

function sse(chunks: string[], close = false): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      if (close) controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('SSE：跳过心跳与别人家 id，拿到目标应答就取消读取', async () => {
  const connection = await connect((body) => {
    if (body.method !== 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: {} })
    return sse([
      ': heartbeat\n',
      'data: not-json\n',
      'data: {"jsonrpc":"2.0","id":99,"result":{}}\n',
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: initResult })}\n`,
    ])
  })
  expect(connection.alive).toBe(true)
  expect(connection.instructions).toBe('用法')
})

test('SSE：没有响应体、流读完仍没等到应答都报清楚', async () => {
  await expect(
    connect(() => new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
  ).rejects.toThrow(/没有响应体/)

  await expect(
    connect(() => sse(['data: {"jsonrpc":"2.0","id":99,"result":{}}\n'], true)),
  ).rejects.toThrow(/SSE 流读完了/)
})

test('翻页到上限：一直给新游标也能收手（不无限转）', async () => {
  let page = 0
  const connection = await connect(
    standard((body) => {
      if (body.method !== 'tools/list') return undefined
      page += 1
      return json({
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: [{ name: `t${String(page)}` }], nextCursor: `c${String(page)}` },
      })
    }),
  )
  const tools = await connection.listTools(signal())
  expect(tools.length).toBe(100)
})

test('结果归并：content 不是数组、坏项与非文本内容都有兜底文案', async () => {
  const connection = await connect(
    standard((body) => {
      if (body.method !== 'tools/call') return undefined
      const args = body.params?.['arguments'] as Record<string, unknown>
      if (args?.['shape'] === 'none') return json({ jsonrpc: '2.0', id: body.id, result: {} })
      return json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [null, { type: 'text', text: '正文' }, { type: 'image' }],
        },
      })
    }),
  )
  const none = await connection.callTool('t', { shape: 'none' }, signal())
  expect(none.text).toContain('没有返回内容')

  const mixed = await connection.callTool('t', {}, signal())
  expect(mixed.text).toContain('正文')
  expect(mixed.text).toContain('[image 类型的内容')
})
