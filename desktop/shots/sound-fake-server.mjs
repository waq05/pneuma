/**
 * 完成提醒走查的极简假端点：一律回纯文本「提醒走查完成」，让一轮干净跑完
 * （working → idle 跳变 → 完成 effect）。比 v1-fake-server 更小——不需要工具调用与审批卡。
 * 每个请求往 sound-home/server-log.jsonl 追加一行 {t, kind, n}，走查脚本用它对账
 * （chat + title 两行 = 回合真的跑完且标题请求发出）。
 */
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const PORT = 18961
const LOG = 'D:/dsc/desktop/shots/sound-home/server-log.jsonl'

const chunk = (delta, finish = null) => ({
  id: 'chatcmpl-sound',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'fake-chat',
  choices: [{ index: 0, delta, finish_reason: finish }],
})

function classify(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const first = messages[0]
  if (first?.role === 'system' && typeof first.content === 'string' && first.content.includes('会话标题生成器')) {
    return 'title'
  }
  return 'chat'
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-chat', object: 'model' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404)
    res.end()
    return
  }
  let raw = ''
  req.on('data', (data) => {
    raw += data
  })
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {}
    const kind = classify(body)
    try {
      mkdirSync(dirname(LOG), { recursive: true })
      appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), kind, n: body?.messages?.length ?? 0 })}\n`, 'utf8')
    } catch {}
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    setTimeout(() => {
      const content = kind === 'title' ? 'E2E 提醒走查' : '提醒走查完成'
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content }))}\n\n`)
      res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`)
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-sound',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fake-chat',
          choices: [],
          usage: { prompt_tokens: 16, completion_tokens: 8 },
        })}\n\n`,
      )
      res.write('data: [DONE]\n\n')
      res.end()
      console.log(`[fake] ${kind} (${body?.messages?.length ?? 0} msgs)`)
    }, 400)
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`[fake] listening http://127.0.0.1:${PORT}/v1`))
