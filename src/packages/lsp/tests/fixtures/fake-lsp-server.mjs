/**
 * 假语言服务器（LSP 客户端的自检对端）：按 Content-Length 分帧读 stdin、写 stdout。
 *
 * 用法：`node fake-lsp-server.mjs <mode>`。各档模拟的真实现象：
 *   ok       —— 四个能力都声明，didOpen 后推一条诊断；
 *   no-hover —— 不声明 hoverProvider；
 *   pull     —— 声明 diagnosticProvider，只答 textDocument/diagnostic；
 *   stale    —— 推一条比 didOpen 版本旧的诊断（应被丢掉）；
 *   utf8     —— 握手要求 utf-8 位置编码（客户端必须拒绝）；
 *   silent   —— 永不答 initialize（握手超时）；
 *   die      —— 收到 didOpen 就带 stderr 退出（请求应结账为致命失败）；
 *   apply    —— 反向请求 workspace/applyEdit 与 workspace/configuration，把客户端的
 *               答复编码进 definition 的返回列（501 = 拒绝了改文件，7 = 配置回 null）。
 *
 * @module dsc/packages/lsp/tests/fixtures/fake-lsp-server
 */
import { Buffer } from 'node:buffer'

const mode = process.argv[2] ?? 'ok'

/** 一条 Zero 位置。 */
const range = (line = 0, character = 1) => ({
  start: { line, character: 0 },
  end: { line, character },
})

let buffer = Buffer.alloc(0)
const answers = new Map()

function send(message) {
  const body = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`)
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function respondError(id, message, code) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function capabilities() {
  const caps = {
    positionEncoding: 'utf-16',
    definitionProvider: true,
    referencesProvider: true,
    implementationProvider: true,
    hoverProvider: true,
  }
  if (mode === 'no-hover') delete caps.hoverProvider
  if (mode === 'pull') caps.diagnosticProvider = {}
  if (mode === 'utf8') caps.positionEncoding = 'utf-8'
  return caps
}

function handle(message) {
  if (message.method === undefined) {
    if (typeof message.id === 'number' || typeof message.id === 'string') answers.set(message.id, message)
    return
  }
  const id = message.id
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize':
      if (mode === 'silent') return
      respond(id, { capabilities: capabilities(), serverInfo: { name: 'fake' } })
      if (mode === 'apply') {
        // 反向请求：客户端必须拒绝改文件、对配置查询回 null。
        send({ jsonrpc: '2.0', id: 99, method: 'workspace/applyEdit', params: { edit: {} } })
        send({ jsonrpc: '2.0', id: 100, method: 'workspace/configuration', params: { items: [] } })
      }
      return
    case 'initialized':
      return
    case 'textDocument/didOpen': {
      if (mode === 'die') {
        process.stderr.write('boom: 假服务器被打断了\n')
        process.exit(3)
      }
      if (mode === 'ok' || mode === 'stale') {
        const doc = params.textDocument ?? {}
        const version = mode === 'stale' ? (doc.version ?? 1) - 1 : doc.version
        send({
          jsonrpc: '2.0',
          method: 'textDocument/publishDiagnostics',
          params: {
            uri: doc.uri,
            version,
            diagnostics: [
              { range: range(), severity: 1, message: `len:${String(String(doc.text ?? '').length)}`, source: 'fake' },
            ],
          },
        })
      }
      return
    }
    case 'textDocument/definition': {
      if (mode === 'error') {
        respondError(id, '服务器不认识这个文件', -32001)
        return
      }
      if (mode === 'apply') {
        // 反向往返是异步的：等客户端把两个答复写回来再答 definition。
        setTimeout(() => {
          const edit = answers.get(99)
          const config = answers.get(100)
          const refused = edit?.error?.code === -32601
          const nullConfig = config?.result === null
          respond(id, {
            uri: params.textDocument?.uri ?? '',
            range: range(0, refused && nullConfig ? 501 : 7),
          })
        }, 100)
        return
      }
      const includeDecl = params.context?.includeDeclaration === true
      respond(id, { uri: params.textDocument?.uri ?? '', range: range(0, includeDecl ? 7 : 0) })
      return
    }
    case 'textDocument/references': {
      const includeDecl = params.context?.includeDeclaration === true
      respond(id, [
        { uri: params.textDocument?.uri ?? '', range: range(0, includeDecl ? 7 : 0) },
        { uri: params.textDocument?.uri ?? '', range: range(1, 0) },
      ])
      return
    }
    case 'textDocument/implementation':
      respond(id, null)
      return
    case 'textDocument/hover':
      respond(id, { contents: { kind: 'markdown', value: '## 标题' } })
      return
    case 'textDocument/diagnostic':
      respond(id, { items: [{ range: range(), severity: 2, message: 'pull', code: 'P1' }] })
      return
    case 'shutdown':
      respond(id, null)
      return
    case 'exit':
      process.exit(0)
      return
    default:
      if (typeof id === 'number') respond(id, null)
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const sep = buffer.indexOf('\r\n\r\n')
    if (sep < 0) return
    const header = buffer.subarray(0, sep).toString('utf8')
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (match === null) {
      buffer = buffer.subarray(sep + 4)
      continue
    }
    const length = Number(match[1])
    if (buffer.length < sep + 4 + length) return
    const body = buffer.subarray(sep + 4, sep + 4 + length).toString('utf8')
    buffer = buffer.subarray(sep + 4 + length)
    handle(JSON.parse(body))
  }
})
