/**
 * 流式代码块抖动自检用的假端点（临时）：先吐一个已闭合的 js 代码块，再慢慢吐正文。
 *
 * 场景就是用户报的那个：代码块在对话顶部已经输出完，后面的正文还在一个字一个字地长。
 * 修好之后顶部那块应当连 DOM 都不重建（高度恒定、pre 元素身份不变）。
 *
 * 端口是第 1 个参数，默认 18978。
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18978)

const CODE = [
  '```js',
  'const store = new Map()',
  '',
  'export function put(key, value) {',
  '  if (typeof key !== "string") throw new TypeError("key must be a string")',
  '  store.set(key, value)',
  '  return store.size',
  '}',
  '',
  'export function read(key) {',
  '  return store.has(key) ? store.get(key) : null',
  '}',
  '```',
].join('\n')

const TAIL = '这一行是流式追加的正文，用来让代码块后面持续增长。'

const server = createServer((req, res) => {
  void (async () => {
    const url = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-code', object: 'model' }] }))
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

    delta({ content: '先给你一段已完成的代码，然后我继续写正文：\n\n' })
    await sleep(80)
    delta({ content: CODE })
    await sleep(80)
    delta({ content: '\n\n' })

    // 30 口正文，每口 100ms：代码块在这 3 秒里一直是已完成的旧块。
    // 第 2 个参数是 fast：每口 400 字、间隔 10ms，用来复现「内容长得比钉底快」，
    // 那是「回到底部」胶囊抖动最可能的现场。
    const fast = process.argv[3] === 'fast'
    const rounds = fast ? 800 : 100
    const chunk = fast ? TAIL.repeat(7) : TAIL
    for (let i = 0; i < rounds; i += 1) {
      delta({ content: chunk })
      await sleep(fast ? 10 : 60)
    }
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 900 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-code] ${String(error)}\n`)
    try { res.end() } catch {}
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[fake-code] 监听 127.0.0.1:${String(port)}\n`)
})
