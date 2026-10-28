/**
 * 工具卡折叠自检用的假模型端点（OpenAI 兼容 SSE）：不连真模型、不花钱。
 *
 * 两种模式（第 1 个参数），都用来造「工具卡真的在跑」这条路径：
 *   asktool —— 第 1 次请求发起 ask_user（提问卡等用户点选项，工具会一直 running）；
 *              用户点完以后第 2 次请求收尾。既能拍「进行中」，也能拍「完成 · 用时 N秒」。
 *   toolrun —— 第 1 次请求发起 read（只读、无需审批），第 2 次请求收尾。
 *              read 太快，卡片往往第一次渲染就已经完成（量不到耗时），留作对照。
 *
 * 端口是第 2 个参数，默认 18931。
 *
 * @module desktop/shots/tc-fake-llm
 */
import { createServer } from 'node:http'

const mode = process.argv[2] === 'toolrun' ? 'toolrun' : 'asktool'
const port = Number(process.argv[3] ?? 18931)
let requests = 0

/** 问题写长一点：参数块自然高度超过 400px，「进行中的吸附快捷栏」才拍得到。 */
const longQuestion =
  '这次工具卡要落到哪一档？请按「默认折叠成一行、展开超过 400px 才给吸附快捷栏」这条线选，'
  + '并把状态色、hover 底色、以及展开区顶部那条收起栏要不要跟着换主题一起考虑进去。'
const askArgs = {
  questions: [
    {
      header: '范围',
      question: longQuestion,
      options: [
        {
          label: '只改对话流里的工具卡',
          description:
            '改动面最小：只动 ToolCard.tsx、icons.tsx、styles.css 三处，轨迹页与审批卡不动，'
            + '验证也只跑这一条路径；代价是轨迹页的折叠态跟对话流不完全一致。',
        },
        {
          label: '连轨迹页一起对齐',
          description:
            '两处口径一致，轨迹页的步骤行也跟着折叠；代价是要多动一个页面，回归面变大，'
            + '而且轨迹页本来就更紧凑，折叠的收益没有对话流明显。',
        },
      ],
    },
  ],
}

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
    const usage = { prompt_tokens: 256, completion_tokens: 32 }
    const callTool = (id, name, args, lead) => {
      delta({ content: lead })
      delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] })
      delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] })
      delta({}, 'tool_calls')
      send({ choices: [{ delta: {}, finish_reason: null }], usage })
      res.write('data: [DONE]\n\n')
      res.end()
    }
    const finish = (text) => {
      delta({ content: text })
      delta({}, 'stop')
      send({ choices: [{ delta: {}, finish_reason: null }], usage })
      res.write('data: [DONE]\n\n')
      res.end()
    }

    if (requests === 1) {
      if (mode === 'toolrun') {
        callTool('call_live_read_1', 'read', { path: 'D:\\dsc\\desktop\\src\\renderer\\ToolCard.tsx' }, '我先读一眼改动落在哪个文件里。')
        return
      }
      callTool('call_live_ask_1', 'ask_user', askArgs, '这次要动的范围有两种合理解释，我先问清楚再动手。')
      return
    }

    finish('读到了：这张卡现在默认折成一行，展开超过 400px 才有吸附快捷栏。')
  })().catch((error) => {
    process.stderr.write(`[tc-fake-llm] ${String(error)}\n`)
    try {
      res.end()
    } catch {
      // 连接可能已经被对端关掉了，忽略
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[tc-fake-llm] 模式 ${mode}，监听 127.0.0.1:${String(port)}\n`)
})
