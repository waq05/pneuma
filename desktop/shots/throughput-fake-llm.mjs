/**
 * 自检用的假模型端点：专门造「有首字等待、有一段纯解码」的流，用来验证输出速度口径。
 *
 * 两种模式（第 1 个参数）：
 *   timed  首字等 1500ms，之后每 25ms 一片共 40 片（解码约 1.0s），usage 报 40 个输出 token
 *          —— 期望读数：首字延迟 ≈1.5s、LLM 耗时 ≈2.5s、输出速度 ≈40 tok/s；
 *   tool   第一步先看一眼再调 read 工具（好让用量日志落一条工具行），第二次请求收尾
 *          —— 期望卡片里多出「工具耗时」一行。
 *
 * 端口是第 2 个参数，默认 18931。
 *
 * @module desktop/shots/throughput-fake-llm
 */
import { createServer } from 'node:http'

const mode = process.argv[2] ?? 'timed'
const port = Number(process.argv[3] ?? 18931)

/** 毫秒级等待。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let requests = 0

const server = createServer((req, res) => {
  void (async () => {
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('fake endpoint: 只有 /chat/completions')
      return
    }
    // 请求体必须读干净，否则 keep-alive 连接会错位
    req.resume()
    await new Promise((resolve) => req.on('end', resolve))
    requests += 1

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const finish = (completion) => {
      send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 128, completion_tokens: completion } })
      res.write('data: [DONE]\n\n')
      res.end()
    }

    if (mode === 'tool' && requests > 1) {
      // 工具结果已经回填：收尾这一轮
      await sleep(600)
      delta({ content: '读完了，就这样。' })
      await sleep(200)
      delta({}, 'stop')
      finish(6)
      return
    }

    if (mode === 'tool') {
      await sleep(400)
      delta({ content: '先看一眼 package.json。' })
      delta({
        tool_calls: [
          { index: 0, id: 'call_tool_1', type: 'function', function: { name: 'read', arguments: '' } },
        ],
      })
      delta({
        tool_calls: [
          { index: 0, function: { arguments: JSON.stringify({ path: 'D:\\dsc\\package.json' }) } },
        ],
      })
      delta({}, 'tool_calls')
      finish(8)
      return
    }

    // timed：首字等 1.5 秒，之后 40 片 × 25ms（解码期约 1 秒）
    await sleep(1500)
    for (let step = 1; step <= 40; step += 1) {
      delta({ content: `第${String(step)}片。` })
      await sleep(25)
    }
    delta({}, 'stop')
    finish(40)
  })().catch((error) => {
    process.stderr.write(`[fake-llm] ${String(error)}\n`)
    try {
      res.end()
    } catch {
      // 连接可能已经被对端关掉了，忽略
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[fake-llm] 模式 ${mode}，监听 127.0.0.1:${String(port)}\n`)
})
