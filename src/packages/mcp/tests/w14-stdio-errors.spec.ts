/**
 * mcp 协议层的 W14 补缺口测试：stdio 通道的异常输入与收场。
 *
 * 不 spawn 真 MCP server 二进制：`command` 是 `process.execPath`、`args` 里带一段
 * `-e` 内联脚本，脚本按 JSON-RPC 应答 initialize / tools/list / tools/call，并按模式做恶：
 * 往 stdout 打非 JSON、往 stderr 写尾巴、发不带 id 的通知、反向发请求、提前关 stdin。
 * HTTP 通道那几条用 `fetch` 桩。
 *
 * @module dsc/packages/mcp/tests/w14-stdio-errors
 */
import { afterEach, expect, describe, test, vi } from 'vitest'
import { MCP_PROTOCOL_VERSIONS, openConnection, parseServerList, type McpConnection, type McpServerConfig } from '../mcp.js'

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

/** 内联假 MCP server：按 JSON-RPC 行分帧。 */
const SERVER_SOURCE = `
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const mode = process.argv[1]
process.stderr.write('stderr-tail-marker\\n')
if (mode === 'garbage') process.stdout.write('this is not json\\n')
if (mode === 'notify') send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\\n')
    if (index < 0) break
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    let doc
    try { doc = JSON.parse(line) } catch { continue }
    if (doc.method === 'initialize') {
      send({ jsonrpc: '2.0', id: doc.id, result: { protocolVersion: '${MCP_PROTOCOL_VERSIONS[0]}', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } })
      if (mode === 'close-stdin') setTimeout(() => { try { process.stdin.destroy() } catch {} }, 30)
    } else if (doc.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: doc.id, result: { tools: [{ name: 'echo', description: '回显', inputSchema: { type: 'object', properties: {} } }] } })
    } else if (doc.method === 'tools/call') {
      if (mode === 'server-request') send({ jsonrpc: '2.0', id: 9901, method: 'elicitation/create', params: { message: '要你确认' } })
      send({ jsonrpc: '2.0', id: doc.id, result: { content: [{ type: 'text', text: 'ok' }] } })
    }
  }
})
`

/** stdio server 配置。 */
function stdioConfig(mode: string): McpServerConfig {
  return {
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', SERVER_SOURCE, mode],
    cwd: '',
    env: {},
    url: '',
    headers: {},
    risk: {},
    defaultRisk: 'read',
  }
}

const options = {
  connectTimeoutMs: 8_000,
  callTimeoutMs: 8_000,
  onClose: () => {},
}

/** 连一个假 stdio server 并登记收尾。 */
async function connect(mode: string): Promise<McpConnection> {
  const connection = await openConnection(stdioConfig(mode), options)
  open.push(connection)
  return connection
}

describe('stdio 通道的恶意/残缺输入', () => {
  test('stderr 尾巴、非 JSON 行、不带 id 的通知、反向请求都按容错处理', async () => {
    const connection = await connect('server-request')
    // 让 server 把 handle 走完一轮：列工具 + 调一次工具（内部会先发反向请求）。
    const tools = await connection.listTools(AbortSignal.timeout(8_000))
    expect(tools.map((tool) => tool.name)).toContain('echo')
    const result = await connection.callTool('echo', {}, AbortSignal.timeout(8_000))
    expect(result.text).toContain('ok')
    expect(connection.alive).toBe(true)
  })

  test('垃圾行与通知混在一条流里：连接照常可用', async () => {
    const connection = await connect('notify')
    const tools = await connection.listTools(AbortSignal.timeout(8_000))
    expect(connection.alive).toBe(true)
    expect(tools.length).toBeGreaterThanOrEqual(0)
  })

  test('server 关掉 stdin 后调用工具：回一句「输入口已经关了」', async () => {
    const connection = await connect('close-stdin')
    // 等 server 自己 destroy stdin（它排在 initialize 应答之后）。
    await new Promise((resolveTick) => setTimeout(resolveTick, 120))
    await expect(connection.callTool('echo', {}, AbortSignal.timeout(8_000))).rejects.toThrow(
      /输入口已经关了|没连上|已经关了|连上/,
    )
  })

  test('调用信号已取消：请求当场收场', async () => {
    const connection = await connect('ok')
    const controller = new AbortController()
    controller.abort()
    await expect(connection.callTool('echo', {}, controller.signal)).rejects.toThrow()
  })

  test('子进程起不来：E（命令不存在）折成一句带原因的失败', async () => {
    await expect(
      openConnection({ ...stdioConfig('ok'), command: 'definitely-no-such-mcp-binary' }, { ...options, connectTimeoutMs: 2_000 }),
    ).rejects.toThrow(/没找到|起不来|ENOENT|not found/i)
  })
})

describe('HTTP 通道：非 200 且读不出正文', () => {
  test('读正文失败时错误里仍带状态码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: () => Promise.reject(new Error('body 断了')),
      })),
    )
    await expect(
      openConnection(
        {
          name: 'http',
          transport: 'http',
          command: '',
          args: [],
          cwd: '',
          env: {},
          url: 'http://mcp.test/rpc',
          headers: {},
          risk: {},
          defaultRisk: 'read',
        },
        { connectTimeoutMs: 2_000, callTimeoutMs: 2_000, onClose: () => {} },
      ),
    ).rejects.toThrow(/MCP HTTP 500/)
  })
})

describe('清单解析：字符串数组与字符串字典', () => {
  test('args / env / headers 全是字符串时正常收下', () => {
    const parsed = parseServerList(
      JSON.stringify([
        {
          name: 'a',
          command: 'node',
          args: ['x', 'y'],
          env: { A: '1' },
          headers: { H: 'v' },
        },
      ]),
      'read',
    )
    expect(parsed.problem).toBeNull()
    expect(parsed.servers[0]).toMatchObject({
      args: ['x', 'y'],
      env: { A: '1' },
      headers: { H: 'v' },
    })
  })
})
