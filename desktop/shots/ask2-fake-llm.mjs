/**
 * 提问卡自检用的假模型端点（OpenAI 兼容 SSE）：只为截图造状态，不连真模型、不花钱。
 *
 * 两种模式（第 1 个参数）：
 *   ask3  先说一句话，再发一次 ask_user，一次要问 3 题 —— 第 1 题单选带选项、
 *         第 2 题多选带选项、第 3 题只有自由输入（覆盖三种题面）。
 *   ask1  同上，只问 1 题 —— 单题场景不回归用。
 *
 * 两处关键行为：
 *   1. 宿主把用户答案作为工具结果送回来时（第 2 次请求，messages 里出现 role: 'tool'），
 *      这里把收到的原文**原样回显**成一条助手消息 —— 这张回显就是「宿主确实收到了答案」
 *      的直接证据，不用去猜界面之外发生了什么；
 *   2. 每次请求都是当场决定的：没有工具结果就发提问，有工具结果就回显并收尾，
 *      所以同一份脚本能连着跑完「提问 → 逐题作答 → 提交 → 回显」整条链路。
 *
 * 端口是第 2 个参数，默认 18931。
 *
 * @module desktop/shots/ask2-fake-llm
 */
import { createServer } from 'node:http'

const mode = process.argv[2] ?? 'ask3'
const port = Number(process.argv[3] ?? 18931)

/** 3 题版本：单选、多选、只有自由输入各一题。 */
const THREE = [
  {
    header: '范围',
    question: '这次只改对话区，还是连轨迹页一起对齐？',
    options: [
      { label: '只改对话区（推荐）', description: '改动面最小，轨迹页不动' },
      { label: '连轨迹页一起', description: '两处口径一致，但这次要多改一个页面' },
    ],
  },
  {
    header: '口径',
    question: '两条轨道的宽度以哪边为准？',
    multiSelect: true,
    options: [
      { label: '以正文列宽为准' },
      { label: '以渲染层量到的现值为准' },
      { label: '两个都留着，冲突时正文优先' },
    ],
  },
  {
    header: '备注',
    question: '还有什么要我一并处理的？（不写就直说没有）',
  },
]

/** 1 题版本。 */
const ONE = [THREE[0]]

const server = createServer((req, res) => {
  void (async () => {
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('fake endpoint: 只有 /chat/completions')
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    /** 上一次请求的对话内容；读不干净的话 keep-alive 连接会错位。 */
    let messages = []
    try {
      const parsed = JSON.parse(body)
      if (Array.isArray(parsed?.messages)) messages = parsed.messages
    } catch {
      messages = []
    }
    /** 宿主交回来的工具结果（有它就说明用户答完了）。 */
    const toolResult = [...messages].reverse().find((message) => message?.role === 'tool')

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const usage = { prompt_tokens: 256, completion_tokens: 96 }

    if (toolResult !== undefined) {
      delta({ content: '收到你的回答，自检回显如下：\n\n' })
      delta({ content: String(toolResult.content ?? '') })
      delta({}, 'stop')
      send({ choices: [{ delta: {}, finish_reason: null }], usage })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    const questions = mode === 'ask1' ? ONE : THREE
    delta({ content: '这次要动的范围有两种合理解释，我一次问清楚再动手。' })
    delta({
      tool_calls: [
        {
          index: 0,
          id: 'call_ask2_1',
          type: 'function',
          function: { name: 'ask_user', arguments: '' },
        },
      ],
    })
    delta({
      tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ questions }) } }],
    })
    delta({}, 'tool_calls')
    send({ choices: [{ delta: {}, finish_reason: null }], usage })
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
  process.stdout.write(`[fake-llm] 提问卡模式 ${mode}，监听 127.0.0.1:${String(port)}\n`)
})
