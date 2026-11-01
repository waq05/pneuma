/**
 * 自检用的假端点：按「请求里已经有几条 tool 结果」决定下一步，连着发 N 个 write 调用，
 * 最后一个请求才回正文。
 *
 * 为什么要它：轮尾「已编辑 N 个文件」卡的时机（2026-11-01 报障：一轮还没跑完就先挂出来）
 * 与执行任务期间的内存都要在**真回合**里才看得见。默认那条 `_fake-llm.mjs` 只发一次
 * bash，制造不出「多刀改动 + 中间的等待窗口」。
 *
 * 环境变量：
 *   DSC_PROBE_PORT        监听端口（默认 17421）
 *   DSC_PROBE_STEPS       这一轮发几个 write（默认 3）
 *   DSC_PROBE_STEP_DELAY  每次响应前等多久毫秒（默认 3000；用来留出「回合进行中」的窗口）
 *   DSC_PROBE_BODY_KB     每个文件正文多少 KB（默认 8；内存探针要它才有份量）
 *
 * @module desktop/shots/tail-probe-llm
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.DSC_PROBE_PORT ?? 17_421)
const STEPS = Number(process.env.DSC_PROBE_STEPS ?? 3)
const STEP_DELAY = Number(process.env.DSC_PROBE_STEP_DELAY ?? 3000)
const BODY_KB = Number(process.env.DSC_PROBE_BODY_KB ?? 8)

const MODEL = 'probe-model'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一个文件正文：够大才有内存份量，行内容可读（自检截图里好认）。 */
function bodyFor(step) {
  const lines = []
  const perLine = 40
  const count = Math.max(1, Math.round((BODY_KB * 1024) / perLine))
  for (let index = 0; index < count; index += 1) {
    lines.push(`第 ${String(step)} 刀第 ${String(index + 1)} 行：轮尾卡时机与内存自检用的演示内容。`)
  }
  return lines.join('\n')
}

const server = createServer((req, res) => {
  void (async () => {
    const url = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }))
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    let payload = {}
    try {
      payload = JSON.parse(body)
    } catch {
      payload = {}
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const done = messages.filter((message) => message.role === 'tool').length
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`)
    await sleep(STEP_DELAY)
    if (done < STEPS) {
      const index = done + 1
      const args = JSON.stringify({ path: `.probe/step-${String(index)}.md`, content: bodyFor(index) })
      send({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: `call_probe_${String(index)}`, type: 'function', function: { name: 'write', arguments: args } },
              ],
            },
          },
        ],
      })
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
      send({ choices: [], usage: { prompt_tokens: 100 + done, completion_tokens: 30 } })
    } else {
      send({ choices: [{ delta: { content: `写完了，一共 ${String(STEPS)} 个文件。` } }] })
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      send({ choices: [], usage: { prompt_tokens: 100 + done, completion_tokens: 20 } })
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    try {
      res.writeHead(500)
      res.end(String(error))
    } catch {
      // 已经写头了，忽略
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`probe-llm on ${String(PORT)}（${String(STEPS)} 刀，每刀前等 ${String(STEP_DELAY)}ms）\n`)
})
