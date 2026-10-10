/**
 * 假模型端点（开发辅助，不进测试电池）：一个只会说 OpenAI SSE 的本地 HTTP 服务，
 * 用来在不接真模型的前提下驱动真界面走完整回合。
 *
 * 为什么需要它：界面上的输入框、审批卡、排队条、状态条读数都只在**真回合**里才活起来，
 * 而真回合需要模型端点。没有 `_` 前缀的脚本会被测试电池收走，所以这个脚本加了下划线前缀。
 *
 * 按请求形状分派（不是按轮次计数）：
 *   - 历史里还没有 assistant 的 tool_calls → 回一个 `bash` 工具调用（写工作区之外的文件，
 *     按 auto-edit 档位必然要审批），用来把审批卡顶出来；
 *   - 历史里已经有 tool_calls → 回一段正文，慢慢吐（`DSC_FAKE_LLM_DELAY` 毫秒），
 *     留出一个「回合进行中」的窗口，好在里面测排队与插话。
 *
 * 环境变量：
 *   DSC_FAKE_LLM_PORT   监听端口（默认 17399）
 *   DSC_FAKE_LLM_DELAY  正文开吐前的等待毫秒（默认 8000，设 0 可以快跑）
 *   DSC_FAKE_LLM_LOG    每次请求追加一行的日志文件（可选）
 *
 * @module dsc/scripts/fake-llm
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const PORT = Number(process.env.DSC_FAKE_LLM_PORT ?? 17_399)
const DELAY_MS = Number(process.env.DSC_FAKE_LLM_DELAY ?? 8000)
const LOG = process.env.DSC_FAKE_LLM_LOG

const MODEL = 'fake-model'
/** 审批探针命令：写隔离 HOME 下的一个文件。auto-edit 档位下「工作区之外」必须问一次。 */
const PROBE_COMMAND =
  "Set-Content -Path (Join-Path $env:USERPROFILE 'dsc-approval-probe.txt') -Value dsc-approval-probe"

const log = (line) => {
  const text = `[fake-llm] ${line}`
  process.stdout.write(`${text}\n`)
  if (LOG !== undefined) {
    try {
      appendFileSync(LOG, `${text}\n`)
    } catch {
      // 日志落不下不影响吐流
    }
  }
}

/** 一帧 SSE。 */
function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function frame(delta, finish = null) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

function usage(promptTokens, completionTokens) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 回一个工具调用（一口气吐完，不急）。 */
function streamToolCall(res, body) {
  send(res, frame({ role: 'assistant', content: '' }))
  send(
    res,
    frame({
      tool_calls: [
        {
          index: 0,
          id: 'call_fake_1',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: PROBE_COMMAND }) },
        },
      ],
    }),
  )
  send(res, frame({}, 'tool_calls'))
  send(res, usage(body.messages.length * 10, 12))
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 回一段慢慢吐的正文。 */
async function streamText(res, body, text) {
  send(res, frame({ role: 'assistant', content: '' }))
  if (DELAY_MS > 0) await sleep(DELAY_MS)
  const parts = text.match(/[^\n]{1,12}/g) ?? [text]
  for (const part of parts) {
    send(res, frame({ content: part }))
    await sleep(60)
  }
  send(res, frame({}, 'stop'))
  send(res, usage(body.messages.length * 10, text.length))
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('只有 POST /v1/chat/completions')
    return
  }
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('body 不是 JSON')
      return
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    const calledAlready = messages.some(
      (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
    )
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    log(
      `请求：${String(messages.length)} 条消息，${
        calledAlready ? '已调过工具 → 回正文' : '没调过工具 → 回工具调用'
      }`,
    )
    if (calledAlready) {
      void streamText(res, body, '假端点收尾：工具已经处理过了，这一轮到此结束。')
    } else {
      streamToolCall(res, body)
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  log(`在 127.0.0.1:${String(PORT)} 上听着（正文延迟 ${String(DELAY_MS)}ms）`)
})
