/**
 * 对话区自检用的假模型端点（OpenAI 兼容 SSE）：不连真模型、不花钱。
 *
 * 任何请求都回一段固定的两句话，正文里带上它收到的最后一条用户消息，这样截图里
 * 能直接看出「这一轮真的跑起来了」。另外留一个「挂住」的档：第 3 个参数（或环境变量
 * CONV_FAKE_HOLD_MS）大于 0 时，先吐第一段正文，然后按住 CONV_FAKE_HOLD_MS 毫秒不结束——
 * 进行中的状态行（阶段行 + 分割线 + 活动行）只在回合进行时存在，不挂住就拍不到。
 *
 * 端口是第 1 个参数（默认 18971），挂住时长是第 2 个参数（默认 0）。
 *
 * @module desktop/shots/conv-fake-llm
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18971)
const hold = Number(process.argv[3] ?? process.env.CONV_FAKE_HOLD_MS ?? 0)
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
    // 挂住：状态行要靠这段空档才拍得到
    if (Number.isFinite(hold) && hold > 0) await new Promise((resolve) => setTimeout(resolve, hold))
    else delta({ content: '这一轮走的是自检假端点，用来确认界面上的按钮位置与边界。' })
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 320, completion_tokens: 48 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[conv-fake-llm] ${String(error)}\n`)
    try {
      res.end()
    } catch {
      // 连接可能已经被对端关掉，忽略
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[conv-fake-llm] 监听 127.0.0.1:${String(port)}，挂住 ${String(hold)}ms\n`)
})
