/**
 * 流式光标探针的假端点：先吐一段 reasoning（思考），再吐正文，最后挂住不回 finish。
 *
 * 用途是让界面停在「直播中的思考行 + 直播中的正文」，配 `_verify-stream-caret.mjs` 看
 * `.live::after` 还画不画光标。端口是第 1 个参数，默认 18980。
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18980)

const THINK = [
  '用户要改行尾。detect 循环导入：api_key_service 导入 backend.database.session 的 SessionLocal。',
  '所有既有文件都是 CRLF，我用「新建文件 + 一次性补丁脚本」的办法，避免反复匹配失败。',
].join('\n\n')

const BODY = '先写密钥服务，再补模型和路由。'

const server = createServer((req, res) => {
  void (async () => {
    const url = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-bar', object: 'model' }] }))
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

    for (const piece of THINK.split(/(?<=。)/)) {
      delta({ reasoning_content: piece })
      await sleep(120)
    }
    await sleep(400)
    for (const piece of BODY.split(/(?<=。)/)) {
      delta({ content: piece })
      await sleep(600)
    }
    // 停在这里不回 finish：界面保持「回合进行中」，探针有时间量。
    await sleep(60000)
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 90 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-bar] ${String(error)}\n`)
    try { res.end() } catch {}
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[fake-bar] 监听 127.0.0.1:${String(port)}\n`)
})
