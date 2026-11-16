/**
 * 假 MCP server（stdio，按行 JSON-RPC）：给 `openConnection` 的自检当对端。
 *
 * 用法：`node fake-mcp-server.mjs <mode>`。模式只影响 initialize 与 tools/call：
 *   ok        —— 回旧一点的合法协议版本、带 instructions 与 resources/prompts 能力；
 *   bad-version —— 回一条 dsc 不支持的版本（握手必须失败）；
 *   silent    —— 永不回应（握手超时）；
 *   error     —— tools/call 回 JSON-RPC error；
 *   elicit    —— 调 `ask` 时反向发 elicitation/create，把客户端答复的动作拼进结果；
 *   pages     —— tools/list 翻两页，第二页的游标兜圈（客户端必须收手）。
 *
 * @module dsc/packages/mcp/tests/fixtures/fake-mcp-server
 */
import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'ok'
let pendingElicitation = null

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

const handlers = {
  initialize(params) {
    if (mode === 'silent') return undefined
    return {
      id: params.id,
      result: {
        protocolVersion: mode === 'bad-version' ? '1999-01-01' : '2025-03-26',
        instructions: '这是假 server 的用法说明',
        capabilities:
          mode === 'ok' || mode === 'ellicit' || mode === 'pages'
            ? { resources: {}, prompts: {}, tools: {} }
            : {},
      },
    }
  },
  'tools/list'(params) {
    if (mode === 'pages') {
      if (params.params?.cursor === 'p2') {
        return { id: params.id, result: { tools: [{ name: 'second', inputSchema: { type: 'object' } }], nextCursor: 'p2' } }
      }
      return {
        id: params.id,
        result: {
          tools: [{ name: 'first', description: '第一个', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } }, { nope: true }],
          nextCursor: 'p2',
        },
      }
    }
    return { id: params.id, result: { tools: [{ name: 'echo', description: '回声', inputSchema: { type: 'object' } }] } }
  },
  'tools/call'(params) {
    if (mode === 'error') return { error: { id: params.id, code: -32000, message: '工具炸了' } }
    if (mode === 'elicit' && params.params?.name === 'ask') {
      const requestId = 900
      send({ jsonrpc: '2.0', id: requestId, method: 'elicitation/create', params: { message: '要确认吗', requestedSchema: {} } })
      return { pending: requestId, call: params.id }
    }
    const args = params.params?.arguments ?? {}
    return {
      id: params.id,
      result: {
        isError: false,
        content: [
          { type: 'text', text: `echo:${String(args.text ?? '')}` },
          { type: 'image', data: 'AA==' },
        ],
      },
    }
  },
  'resources/list'(params) {
    return {
      id: params.id,
      result: { resources: [{ uri: 'file:///a.txt', name: 'A', mimeType: 'text/plain' }, { nope: 1 }] },
    }
  },
  'resources/read'(params) {
    return {
      id: params.id,
      result: { contents: [{ text: '第一段' }, { blob: 'AA==', mimeType: 'image/png' }, 'bad'] },
    }
  },
  'prompts/list'(params) {
    return {
      id: params.id,
      result: { prompts: [{ name: 'greet', description: '打招呼', arguments: [{ name: 'who' }, { nope: 1 }] }, { nope: true }] },
    }
  },
  'prompts/get'(params) {
    return {
      id: params.id,
      result: { messages: [{ role: 'user', content: { type: 'text', text: `你好 ${String(params.params?.arguments?.who ?? '')}` } }] },
    }
  },
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  // 反向请求的应答（没有 method）：把 elicitation 的结果交给等着的 tools/call。
  if (message.method === undefined && message.id === 900) {
    const action = message.error === undefined ? String(message.result?.action ?? 'unknown') : 'refused'
    if (pendingElicitation !== null) {
      respond(pendingElicitation, { content: [{ type: 'text', text: `elicit:${action}` }] })
      pendingElicitation = null
    }
    return
  }
  if (message.method === 'notifications/initialized') return
  const handler = handlers[message.method]
  if (handler === undefined) {
    if (typeof message.id === 'number') respondError(message.id, -32601, `不支持 ${String(message.method)}`)
    return
  }
  const reply = handler({ id: message.id, params: message.params })
  if (reply === undefined) return
  if (reply.pending !== undefined) {
    pendingElicitation = reply.call
    return
  }
  if (reply.error !== undefined) {
    send({ jsonrpc: '2.0', id: reply.error.id, error: { code: reply.error.code, message: reply.error.message } })
    return
  }
  send({ jsonrpc: '2.0', id: reply.id, result: reply.result })
})
