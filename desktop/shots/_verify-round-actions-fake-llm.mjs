/**
 * 轮尾动作探针的假端点：吐一句思考 + 两段正文，然后正常收尾（finish_reason: stop）。
 *
 * 配 `_verify-round-actions.mjs` 用：先看跑动中没有复制 / 分叉，收尾后看它们默认透明、
 * 鼠标压到输出上才现。端口是第 1 个参数，默认 18981。
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18981)

const server = createServer((req, res) => {
  void (async () => {
    const url = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-act', object: 'model' }] }))
      return
    }
    for await (const _chunk of req) { /* 读完请求体 */ }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    delta({ reasoning_content: '先看一下这轮要答什么。' })
    await sleep(300)
    delta({ content: '这一轮的回答是两行。\n\n' })
    await sleep(300)
    delta({ content: '第二段用来给鼠标留一个可以压上去的位置。' })
    await sleep(200)
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 40, completion_tokens: 30 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-act] ${String(error)}\n`)
    try { res.end() } catch {}
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[fake-act] 监听 127.0.0.1:${String(port)}\n`)
})
