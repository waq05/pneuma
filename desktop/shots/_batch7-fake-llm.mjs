/**
 * 第七批自检用的假模型端点（OpenAI 兼容 SSE）：只为让轨迹页长出「真跑出来的一条工具调用」。
 *
 * 为什么要真跑：工具卡的 `startedAt` / `durationMs` 是**实时路径**上记的（落盘时会被剔掉，
 * 见 src/plugins/transcript.ts），所以历史会话重放出来的轨迹里工具只有起点刻度、
 * 没有耗时条。要看「有宽度的条」与「用时」读数，必须让一个工具真的跑过去。
 *
 * 两种节奏（都按请求形状分派，不看参数）：
 *   - 请求里还没有 role=tool 的消息 → 先吐一句正文，再发起一次 read 工具调用（只读、无需审批）；
 *   - 已经带着工具结果回来 → 说一句收尾正文结束这一轮。
 *
 * 端口是第 1 个参数，默认 18927。
 *
 * @module dsc/desktop/shots/batch7-fake-llm
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18927)

/**
 * 这一进程收过几次 /chat/completions。
 *
 * 为什么不信「请求体里有没有 role=tool」：那套判定在自检里出过一次事故（回合陷入
 * 无限工具循环，对话页长出 741 张工具卡）。请求形状会随客户端的消息组装漂移，
 * 而「这一轮自检要几次请求」是固定的（第一拍发工具、第二拍收尾），计数器不会漂。
 * 请求体照读不误（keep-alive 不读会错位），只用来打一行诊断。
 */
let calls = 0

const server = createServer((req, res) => {
  void (async () => {
    // 模型发现（设置 → 模型 → 拉取清单）会 GET {baseUrl}/models —— 自检要让那条路真的走通。
    if (req.method === 'GET' && (req.url ?? '').split('?')[0].endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'fake-trace', object: 'model' }, { id: 'fake-fast', object: 'model' }, { id: 'fake-pro', object: 'model' }],
        }),
      )
      return
    }
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('fake endpoint: 只有 /chat/completions')
      return
    }
    // 请求体读干净：keep-alive 连接不读会错位；顺带数一下这一拍有几个 tool 消息当诊断。
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    await new Promise((resolve) => req.on('end', resolve))
    let toolMessages = -1
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const messages = Array.isArray(body.messages) ? body.messages : []
      toolMessages = messages.filter((message) => message !== null && typeof message === 'object' && message.role === 'tool').length
    } catch {
      toolMessages = -2
    }
    calls += 1
    process.stderr.write(`[batch7-fake-llm] 第 ${String(calls)} 次请求（tool 消息 ${String(toolMessages)} 条）\n`)
    const afterTool = calls > 1

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const usage = { prompt_tokens: 120, completion_tokens: 40 }

    if (!afterTool) {
      delta({ reasoning_content: '先读一眼工作区里的说明文件，再回答。' })
      delta({ content: '我看一下工作区里的说明文件。' })
      delta({
        tool_calls: [
          {
            index: 0,
            id: 'call_trace_read_1',
            type: 'function',
            function: { name: 'read', arguments: '' },
          },
        ],
      })
      delta({
        tool_calls: [
          { index: 0, function: { arguments: JSON.stringify({ path: 'readme.txt' }) } },
        ],
      })
      delta({}, 'tool_calls')
      send({ choices: [{ delta: {}, finish_reason: null }], usage })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    delta({ content: '说明文件读完了：这是一条自检会话，轨迹页应当能看到刚才那次 read 的耗时。' })
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[batch7-fake-llm] ${String(error)}\n`)
    try {
      res.end()
    } catch {
      // 对端可能已经关掉连接，忽略
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[batch7-fake-llm] 监听 127.0.0.1:${String(port)}\n`)
})
