/**
 * 「对话区修正批」自检用的假模型端点（OpenAI 兼容 SSE）：不连真模型、不花钱。
 *
 * 只有一件事：慢慢吐一段很长的正文（`delta.content` → 宿主的助手正文流），
 * 让滚动容器在三十秒里持续长高——自检脚本就在这段时间里先往上翻、再滚回底部，
 * 验证「用户主动往上滚就暂停跟随 / 滚回底部就恢复跟随」。
 *
 * 吐的顺序：
 *   1. 开场先一次性吐 20 行（让内容立刻超过一屏）；
 *   2. 之后每 200ms 一行，共 150 行（约 30 秒），整段流一直不停，
 *      所以自检的两个窗口（暂停观察 1.5s、恢复观察 3s）里一定还有新块在到。
 *
 * 端口是第 1 个参数，默认 18951。
 *
 * @module desktop/shots/fix2-fake-llm
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18951)

const line = (text) => `　${text}\n`

const server = createServer((req, res) => {
  void (async () => {
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('fake endpoint: 只有 /chat/completions')
      return
    }
    // 请求体必须读干净，否则 keep-alive 连接会错位
    req.resume()
    await new Promise((resolve) => req.on('end', resolve))

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    // 1) 开场 20 行：一次性把内容顶过一屏
    delta({ content: '这条回复是慢慢写的，专门用来验证流式输出时的滚动行为。\n\n' })
    for (let index = 0; index < 20; index += 1) {
      delta({ content: line(`开场第 ${String(index + 1)} 行：先铺满一屏，好让往上翻有内容可翻。`) })
    }

    // 2) 之后每 200ms 一行，约 30 秒
    for (let index = 0; index < 150; index += 1) {
      await sleep(200)
      delta({ content: line(`流式第 ${String(index + 1)} 行：这一行是慢慢吐出来的，自检会在这中间往上翻一次。`) })
    }

    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 256, completion_tokens: 512 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fix2-fake-llm] ${String(error)}\n`)
    try {
      res.end()
    } catch {
      // 连接可能已经被对端关掉了，忽略
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[fix2-fake-llm] 监听 127.0.0.1:${String(port)}\n`)
})
