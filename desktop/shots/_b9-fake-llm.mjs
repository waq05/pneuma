/**
 * 第九批走查用的假模型端点（开发辅助，不进测试电池）：OpenAI 兼容 SSE，两拍。
 *
 *   第一拍：**慢速**吐一段 reasoning（每口之间停 700ms，留出直播观察窗），
 *           然后调 `write` 在工作区里落一个未跟踪文件（同时驱动三件事：
 *           宿主 file-review 的写前预览 → 对话流里那条通知；
 *           write 工具卡落地 → `call.change` 缝回卡上；
 *           仓库变脏 → 状态面板的 Git 区与胶囊该亮）。
 *   第二拍：再来一小段 reasoning + 收尾正文，结束回合。
 *
 * 端口是第 1 个参数，默认 18929。
 *
 * @module dsc/desktop/shots/b9-fake-llm
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18_929)
const WORKSPACE = process.env.DSC_B9_WS ?? ''

let calls = 0

const server = createServer((req, res) => {
  void (async () => {
    const url = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'b9-flow', object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('fake endpoint: 只有 /chat/completions')
      return
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    await new Promise((resolve) => req.on('end', resolve))
    calls += 1
    process.stderr.write(`[b9-fake-llm] 第 ${String(calls)} 次请求\n`)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const usage = { prompt_tokens: 300, completion_tokens: 80 }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const end = (finish) => {
      delta({}, finish)
      send({ choices: [{ delta: {}, finish_reason: null }], usage })
      res.write('data: [DONE]\n\n')
      res.end()
    }
    const toolCall = (id, name, args, finish) => {
      delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] })
      delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] })
      end(finish)
    }

    if (calls === 1) {
      // 段落之间留空行：折叠行的摘要是「最新一个写完的段落的首行」，靠空行分段。
      const parts = [
        '先把这件事拆开看。\n',
        '第一步，确认工作区里有什么。\n\n',
        '第二步，把自我介绍落成一份文档。\n',
        '这一步会写文件，写之前先想清楚放哪。\n\n',
        '想完了，落盘。\n',
      ]
      for (const part of parts) {
        delta({ reasoning_content: part })
        await sleep(700)
      }
      const target = WORKSPACE === '' ? '自我介绍.md' : `${WORKSPACE}\\自我介绍.md`
      toolCall(
        'call_b9_write',
        'write',
        {
          path: target,
          justification: '用户要求把自我介绍写成一份文档；写进当前工作区，不越界。',
          sandbox_permissions: 'workspace-write',
          content:
            '# Muse Code · 自我介绍\n\n> 写于第九批走查\n\n## 一、我是谁\n\n我是跑在你桌面里的编程助手，说话算数、改完自查。\n\n## 二、做事的规矩\n\n1. **先看代码再动手。**\n2. **指代代码写行号。**\n3. **不确定就说不确定。**\n',
        },
        'tool_calls',
      )
      return
    }

    delta({ reasoning_content: '写完了，复核一下再汇报。\n\n汇报。\n' })
    await sleep(400)
    delta({ content: '文档写好了：工作区里的「自我介绍.md」，三段共二十来行。' })
    end('stop')
  })()
})

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`[b9-fake-llm] 听着 http://127.0.0.1:${String(port)}/v1\n`)
})
