/**
 * 自检用的假模型端点（OpenAI 兼容 SSE）：只为截图造状态，不连任何真模型、不花一分钱。
 *
 * 三种模式（第 1 个参数）：
 *   slow    一直往外吐思考，拖两分钟不停 —— 抓「回合进行中 · 正在思考」那一版状态行；
 *   asktool 先说一句话，然后发起一次 ask_user 工具调用并停在那儿等回答
 *         —— 抓「工具阶段」的状态行（正在调用 ask_user），没有副作用；
 *   fast    两秒内说完并收尾 —— 抓「回合已结束」以后每轮底部那行时间与用时。
 *
 * 端口是第 2 个参数，默认 18924。
 *
 * @module desktop/shots/chat-fake-llm
 */
import { createServer } from 'node:http'

const mode = process.argv[2] ?? 'slow'
const port = Number(process.argv[3] ?? 18924)

/** 毫秒级等待。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
    const usage = { prompt_tokens: 128, completion_tokens: 64 }

    if (mode === 'asktool') {
      delta({ content: '这次要动的范围有两种合理解释，我先问清楚再动手。' })
      delta({
        tool_calls: [
          {
            index: 0,
            id: 'call_ask_1',
            type: 'function',
            function: { name: 'ask_user', arguments: '' },
          },
        ],
      })
      delta({
        tool_calls: [
          {
            index: 0,
            function: {
              arguments: JSON.stringify({
                questions: [
                  {
                    header: '范围',
                    question: '这次只改对话区，还是连轨迹页一起对齐？',
                    options: [
                      { label: '只改对话区（推荐）', description: '改动面最小，轨迹页不动' },
                      { label: '连轨迹页一起', description: '两处口径一致，但这次要多改一个页面' },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      })
      delta({}, 'tool_calls')
      send({ choices: [{ delta: {}, finish_reason: null }], usage })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    if (mode === 'fast') {
      delta({ reasoning_content: '答案很短，直接说，不绕。' })
      await sleep(500)
      delta({ content: '这是自检用的假回复：对话区右缘现在是三条互不重叠的轨道。' })
      await sleep(500)
      delta({ content: ' 下面那行就是这一轮的时刻与用时。' })
      await sleep(300)
      delta({}, 'stop')
      send({ choices: [{ delta: {}, finish_reason: null }], usage })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    // slow：每 600ms 一条思考，连着 200 条（约两分钟），截图那会儿一直停在「正在思考」
    for (let step = 1; step <= 200; step += 1) {
      delta({ reasoning_content: `第 ${step} 步：核对对话区右缘的轨道宽度、滚动条宽度与刻度条位置。\n` })
      await sleep(600)
    }
    delta({ content: '（自检流到此为止，没走到这一步。）' }, 'stop')
    res.write('data: [DONE]\n\n')
    res.end()
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
