/**
 * 「会话脚注与思考折叠改版」自检用的假模型端点（OpenAI 兼容 SSE）：不连真模型、不花钱。
 *
 * 只有一件事：把一段多段落的思考（`delta.reasoning_content` → 宿主的思考流）慢慢地吐出去，
 * 用来拍跑动中的折叠态。吐的顺序故意这样排：
 *   第 1 段（写完）→ 第 2 段（写完）→ 第 3 段（一直不换行，慢慢吐）
 * 于是跑动中的摘要必须停在「第二段首行」：第三段还在往外吐字，不能拿来当摘要
 * （对照 dsh ReasoningRow.tsx:16-32 的 latestCompletedParagraphFirstLine）。
 *
 * 整个思考流约 45 秒，截图的时刻落在它中间，所以那一屏是货真价实的跑动中。
 * 端口是第 1 个参数，默认 18941。
 *
 * @module desktop/shots/tf-fake-llm
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18941)

const paragraphOne = [
  '第一段：这一轮先看清三条改版各自的位置。',
  '第一段第二行：脚注、思考折叠、拖宽把手。',
  '',
  '',
].join('\n')

const paragraphTwo = [
  '第二段：折叠态的摘要取最新写完的那一段首行。',
  '第二段第二行：正在吐字的这一段不算。',
  '',
  '',
].join('\n')

/** 第三段：故意不带换行，慢慢吐——它证明「跑动中的摘要不会跟着正在写的这段字跳」。 */
const paragraphThree = '第三段：这一段正在往外写，还没有换行，所以它不能当摘要——'

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

    // 第 1、2 段先迅速写完：跑动中的摘要这时就该停在「第二段首行」
    delta({ reasoning_content: paragraphOne })
    await sleep(400)
    delta({ reasoning_content: paragraphTwo })
    await sleep(600)

    // 第 3 段慢慢吐：约 36 秒，截图的时刻落在这中间，那一屏仍是跑动中
    delta({ reasoning_content: paragraphThree })
    for (let index = 0; index < 36; index += 1) {
      await sleep(1000)
      delta({ reasoning_content: `还在写的第 ${String(index + 1)} 个字串` })
    }

    delta({ content: '想完了：折叠态确实停在第二段首行。' })
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 256, completion_tokens: 512 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[tf-fake-llm] ${String(error)}\n`)
    try {
      res.end()
    } catch {
      // 连接可能已经被对端关掉了，忽略
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[tf-fake-llm] 监听 127.0.0.1:${String(port)}\n`)
})
