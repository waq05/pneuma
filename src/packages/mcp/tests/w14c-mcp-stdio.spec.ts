/**
 * mcp 协议层的 W14-C 补测：stdio 通道的三条边角（`packages/mcp/mcp.ts`）。
 *
 * 不 spawn 真 MCP server 二进制：`command` 是 `process.execPath`、`args` 里带一段
 * `-e` 内联脚本，脚本按行 JSON-RPC 应答，并按模式做恶：
 *   - `garbage`：stdout 混入非 JSON 行（必须被丢掉、连接照常可用）；
 *   - `early-request`：initialize 应答**之前**就反向发请求（此时还没挂处理缝，必须回
 *     method-not-found 错误而不是把连接卡住）；
 *   - `bad-cwd`：起进程的 cwd 不存在（走 child `error` 事件那条收场）。
 *
 * 这一层不 mock 模块；`spawn` 的 stdin 已毁分支走不到公开 API，单独在
 * `w14c-mcp-spawn.spec.ts` 用假 ChildProcess 钉。
 *
 * @module dsc/packages/mcp/tests/w14c-mcp-stdio
 */
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { MCP_PROTOCOL_VERSIONS, openConnection, type McpConnection, type McpServerConfig } from '../mcp.js'

const open: McpConnection[] = []

afterEach(() => {
  for (const connection of open.splice(0)) {
    try {
      connection.close()
    } catch {
      // 已经断了
    }
  }
})

/** 内联假 MCP server：按行分帧；`mode` 决定在握手前后做什么恶。 */
const SERVER_SOURCE = `
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const mode = process.argv[1]
if (mode === 'garbage') {
  process.stdout.write('这是一行日志，不是 JSON\\n')
  process.stdout.write('{"jsonrpc":"2.0","method":"notifications/message","params":{}}\\n')
}
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
      if (mode === 'early-request') {
        send({ jsonrpc: '2.0', id: 9001, method: 'elicitation/create', params: { message: '早到的反向请求' } })
      }
      send({ jsonrpc: '2.0', id: doc.id, result: { protocolVersion: '${MCP_PROTOCOL_VERSIONS[0]}', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } })
    } else if (doc.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: doc.id, result: { tools: [{ name: 'echo', description: '回显', inputSchema: { type: 'object', properties: {} } }] } })
    } else if (doc.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: doc.id, result: { content: [{ type: 'text', text: 'ok' }] } })
    } else if (typeof doc.id === 'number') {
      send({ jsonrpc: '2.0', id: doc.id, result: null })
    }
  }
})
`

/** stdio server 配置。 */
function stdioConfig(mode: string, cwd = ''): McpServerConfig {
  return {
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', SERVER_SOURCE, mode],
    cwd,
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

async function connect(mode: string, cwd = ''): Promise<McpConnection> {
  const connection = await openConnection(stdioConfig(mode, cwd), options)
  open.push(connection)
  return connection
}

describe('stdio 通道的残余边角', () => {
  test('stdout 混入非 JSON 日志行：丢掉，连接照常列工具', async () => {
    const connection = await connect('garbage')
    const tools = await connection.listTools(AbortSignal.timeout(8_000))
    expect(tools.map((tool) => tool.name)).toContain('echo')
    expect(connection.alive).toBe(true)
  })

  test('握手前就反向请求：还没有处理缝，按 client-not-supported 拒掉，不卡住握手', async () => {
    const connection = await connect('early-request')
    const tools = await connection.listTools(AbortSignal.timeout(8_000))
    expect(tools.map((tool) => tool.name)).toContain('echo')
    expect(connection.alive).toBe(true)
  })

  test('起进程的 cwd 不存在：走 child 的 error 事件收场，原因说「起不来」', async () => {
    await expect(openConnection(stdioConfig('garbage', join('no-such-dir-w14c', 'nested')), options)).rejects.toThrow(
      /起不来|ENOENT|not found|spawn/i,
    )
  })
})
