/**
 * 折叠三缺陷截图用例的假模型端点（OpenAI 兼容 SSE）：不连真模型、不花钱。
 *
 * 第一跳吐「一段思考 → 一句正文 → 两个工具调用」：read（秒回）与 bash（睡 60 秒）。
 * 于是这一轮的过程区里有一组「两条工具、最后一条还在跑」的阶段组——自检就在 bash 睡着的
 * 那段时间截图，验标准档组头带实时详情、紧凑档不带。
 *
 * 端口是第 1 个参数，默认 18952；read 读的文件由 FOLD_FIX_TARGET 给。
 *
 * @module dsc/scripts/ui-fold-fix-fake-llm
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18952)
const target = process.env.FOLD_FIX_TARGET ?? ''
/** 这一轮已经收到第几次请求（每条用户消息开头重置为 1）。 */
let hop = 0

const server = createServer((req, res) => {
  void (async () => {
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('fake endpoint: 只有 /chat/completions')
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    await new Promise((resolve) => req.on('end', resolve))

    const lastRole = (() => {
      try {
        const messages = JSON.parse(body).messages ?? []
        const last = messages[messages.length - 1]
        return last === null || typeof last !== 'object' ? '' : String(last.role ?? '')
      } catch {
        return ''
      }
    })()
    hop = lastRole === 'user' ? 1 : hop + 1

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n')
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    if (hop === 1) {
      delta({ reasoning_content: '第一跳思考：先读样张，再跑一次构建看看。\n' })
      await sleep(300)
      delta({ content: '先读样张文件，再跑一轮构建。' })
      await sleep(200)
      delta(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call_fix_read',
              type: 'function',
              function: { name: 'read', arguments: JSON.stringify({ path: target }) },
            },
            {
              index: 1,
              id: 'call_fix_bash',
              type: 'function',
              // 睡 90 秒并显式放宽超时（bash 默认 30 秒会超时，一超时这一轮就往下走了，
              // 截图窗口和「正在运行」两件事都会变样）。截图完由 ps1 杀进程树。
              function: {
                name: 'bash',
                arguments: JSON.stringify({ command: 'Start-Sleep -Seconds 90', timeoutMs: 120000 }),
              },
            },
          ],
        },
        'tool_calls',
      )
    } else {
      delta({ content: '构建还在跑。' })
      delta({}, 'stop')
    }
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 10 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write('[fold-fix-fake-llm] ' + String(error) + '\n')
    try {
      res.end()
    } catch {
      // 连接可能已经被对端关掉
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('[fold-fix-fake-llm] 监听 127.0.0.1:' + String(port) + '\n')
})
