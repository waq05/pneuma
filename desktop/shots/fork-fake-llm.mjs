/**
 * 「每轮分叉与编辑重发」自检用的假模型端点（OpenAI 兼容 SSE）：不连真模型、不花钱。
 *
 * 只做一件事：任何请求都回一句短正文。编辑重发要验的是「改后的正文进了新会话、
 * 并且立刻跑了一轮」，不需要工具调用；回一句能看清的正文最省事。
 * 第二段会带上它收到的最后一条用户消息，这样截图里能直接看见改后的文本确实发出去了。
 *
 * 端口是第 1 个参数，默认 18961。
 *
 * @module desktop/shots/fork-fake-llm
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18961)
let requests = 0

const server = createServer((req, res) => {
  void (async () => {
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('fake endpoint: 只有 /chat/completions')
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    await new Promise((resolve) => req.on('end', resolve))
    requests += 1

    // 取最后一条用户消息：截图证据里要能看出「发的是改后的那一句」
    let lastUser = ''
    try {
      const parsed = JSON.parse(body)
      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === 'user') {
          lastUser = String(messages[index].content ?? '').slice(0, 40)
          break
        }
      }
    } catch {
      // 请求体解析不了也照常回话：这是自检端点，不校验协议
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    delta({ content: `收到第 ${String(requests)} 次请求，最新一条用户消息是：「${lastUser}」。` })
    delta({ content: '这一轮走的是自检假端点，用来确认编辑后的正文确实发到了新会话里。' })
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 320, completion_tokens: 48 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fork-fake-llm] ${String(error)}\n`)
    try {
      res.end()
    } catch {
      // 连接可能已经被对端关掉，忽略
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[fork-fake-llm] 监听 127.0.0.1:${String(port)}\n`)
})
