/**
 * 写前预览折叠自检用的假端点：回一个 write 工具调用，制造一条「文件更改预览」通知。
 * 端口是第 1 个参数，默认 18979。
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18979)
const TARGET = process.argv[3] ?? 'D:\\dsc\\.tmp-review-demo.md'

const BODY = Array.from({ length: 24 }, (_, i) => '第 ' + String(i + 1) + ' 行：折叠自检用的演示内容。').join('\n')

const server = createServer((req, res) => {
  void (async () => {
    const url = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-review', object: 'model' }] }))
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    let payload = {}
    try { payload = JSON.parse(body) } catch { payload = {} }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const hasToolResult = messages.some((m) => m.role === 'tool')

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (p) => res.write('data: ' + JSON.stringify(p) + '\n\n')
    if (hasToolResult) {
      send({ choices: [{ delta: { content: '写好了，一共 24 行。' } }] })
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    const args = JSON.stringify({ path: TARGET, content: BODY })
    send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_review_1', type: 'function', function: { name: 'write', arguments: args } }] } }] })
    send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 30 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    try { res.writeHead(500); res.end(String(error)) } catch {}
  })
})
server.listen(port, '127.0.0.1', () => { console.log('fake review llm on ' + String(port)) })
