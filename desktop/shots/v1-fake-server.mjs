/**
 * V1 实机走查假模型端点：OpenAI 兼容 /chat/completions（SSE），按请求形状分三类应答。
 *
 *   tool-call  ：主对话首轮（最后一条是 user）→ 回一个 write 工具调用，
 *                落盘探测文件（绝对路径在 ui-home 内，不碰真实工作区）
 *   after-tool ：工具结果回传轮（最后一条是 tool）→ 纯文本收尾
 *   title      ：system 提示词含「会话标题生成器」（T16 的标题小请求）→ 短标题
 *
 * 每个请求往 ui-home/e2e-server-log.jsonl 追加一行 {t, kind, n}，走查脚本用它对账。
 * 配套 config.yaml 见 ui-seed.mjs（baseURL 指向 127.0.0.1:18960/v1）。
 */
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const PORT = 18960
const LOG = 'D:/dsc/desktop/shots/ui-home/e2e-server-log.jsonl'
/** 探测文件的落盘目标：走查脚本经 DSC_V1_PROBE_TARGET 注入工作区外的真实路径（auto-edit 档才会弹审批卡）。 */
const PROBE_FILE = process.env.DSC_V1_PROBE_TARGET ?? 'D:/dsc/desktop/shots/ui-home/e2e-out/probe.md'
/** 应答前的模拟网络延迟：让「working」状态点窗口长到可采样（60ms 轮询）。 */
const THINK_MS = 800

const chunk = (delta, finish = null) => ({
  id: 'chatcmpl-e2e',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'fake-chat',
  choices: [{ index: 0, delta, finish_reason: finish }],
})

function classify(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const last = messages[messages.length - 1]
  const first = messages[0]
  if (first?.role === 'system' && typeof first.content === 'string' && first.content.includes('会话标题生成器')) {
    return 'title'
  }
  if (last?.role === 'tool') return 'after-tool'
  return 'tool-call'
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
      if (kind === 'tool-call') {
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: null }))}\n\n`)
      res.write(
        `data: ${JSON.stringify(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'call_e2e_1',
                function: {
                  name: 'write',
                  arguments: JSON.stringify({
                    path: PROBE_FILE,
                    content: 'e2e 探测：write 工具落盘成功\n',
                    // Temp 在所有可写根之外：带一次性升权请求，沙箱不再当场拒，转审批卡
                    sandbox_permissions: 'danger-full-access',
                    justification: '走查验证：写探测文件到系统临时目录，验证审批卡与状态点流转',
                  }),
                },
              },
            ],
          }),
        )}\n\n`,
      )
      res.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`)
    } else if (kind === 'after-tool') {
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '探测' }))}\n\n`)
      res.write(`data: ${JSON.stringify(chunk({ content: '文件已写好。' }))}\n\n`)
      res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`)
    } else {
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'E2E 状态点导出走查' }))}\n\n`)
      res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`)
    }
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-e2e',
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
    }, THINK_MS)
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`[fake] listening http://127.0.0.1:${PORT}/v1`))
