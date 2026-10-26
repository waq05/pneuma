/**
 * 兼容层的**合成验收**（离线）：一个 dsh 风格的插件，同时吃三条面——
 * `llm/stream`（实时用量）、`session/event`（回合过程）、`sessionPersistence`（历史）。
 *
 * 为什么要这条：真包验收（`dsh-real-package-e2e.mjs`）要联网装 `dsh-cost-meter`，进不了
 * 默认门禁；而三条面各自的自检只能证明「单条通」。真插件是**三条一起用**的：先听事件
 * 记账、再用历史补空、最后按回合计。只测单条，接缝上的顺序错（用量晚于消息、历史还没
 * 落盘就去读）照样能全绿。
 *
 * 所以这里跑一个真回合（真内核 + 本地假端点，不碰网络），由一个探针插件把三条面都走一遍：
 *   [1] 挂载：插件装上、没有报问题
 *   [2] llm/stream：拿到这一轮真实的用量 chunk（输入/输出与服务端一致）
 *   [3] session/event：turn/start → step/start → assistant/message(带用量) → tool/* → step/end → turn/end
 *   [4] sessionPersistence：回合结束后真能读回这个会话（历史里有这一轮）
 *   [5] 不打架：三条面同时在听时，探针自己没报错
 *
 * 跑法：cd D:\dsc && pnpm run build && node scripts/dsh-compat-live-check.mjs
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-compat-live-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dsc = join(home, '.dsc')
mkdirSync(join(dsc, 'plugins'), { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${extra === '' ? '' : ` — ${extra}`}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(20)
  }
}

// ── 假端点：两步（先调一个工具，再收尾），两次调用各上报一次用量 ──────────────────
const delta = (o) => `data: ${JSON.stringify({ choices: [{ delta: o }] })}\n\n`
const fin = (r) => `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: r }] })}\n\n`
const usage = (i, o) => `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: i, completion_tokens: o } })}\n\n`
const call = (id, name, args) =>
  delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] })
const STEPS = [
  { text: '先看一眼文件。', tools: [call('c1', 'read', '{"path":"a.ts"}')], usage: [100, 20] },
  { text: '看完了。', tools: [], usage: [300, 90] },
]

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    let payload = {}
    try {
      payload = JSON.parse(body)
    } catch {
      payload = {}
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const isTitle = messages.some(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('会话标题生成器'),
    )
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (isTitle) {
      res.end(delta({ content: '兼容层合成验收的标题' }) + fin('stop') + usage(10, 5) + 'data: [DONE]\n\n')
      return
    }
    const step = Math.min(messages.filter((m) => m.role === 'tool').length, STEPS.length - 1)
    const spec = STEPS[step]
    let out = delta({ content: spec.text })
    for (const tool of spec.tools) out += tool
    res.end(out + fin(spec.tools.length === 0 ? 'stop' : 'tool_calls') + usage(spec.usage[0], spec.usage[1]) + 'data: [DONE]\n\n')
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`

// ── 探针插件：三条面一起听，结果挂在 globalThis 上 ────────────────────────────────
writeFileSync(
  join(dsc, 'plugins', 'dsh-live-probe.js'),
  `export const name = 'dsh-live-probe'

export function apply(ctx) {
  const heard = { chunks: [], events: [], history: null, problems: [] }
  globalThis.__liveProbe = heard

  // 1) 实时用量：waterfall，包住下游流，读 usage chunk 再原样吐出去
  try {
    ctx.on('llm/stream', (options, next) => {
      const downstream = next()
      return (async function* wrapper() {
        for await (const chunk of downstream) {
          if (chunk?.type === 'usage') {
            heard.chunks.push({
              sessionId: options?.sessionId,
              provider: options?.provider,
              model: options?.model,
              input: chunk.usage?.inputTokens,
              output: chunk.usage?.outputTokens,
            })
          }
          yield chunk
        }
      })()
    })
  } catch (error) {
    heard.problems.push('llm/stream: ' + error.message)
  }

  // 2) 回合过程：事件到手就记，turn/end 时顺手用 3) 的历史面读一次
  try {
    ctx.on('session/event', (session, event) => {
      heard.events.push({
        id: session?.header?.id,
        type: event?.type,
        seq: event?.seq,
        turn: event?.data?.turn,
        step: event?.data?.step,
        usage: event?.data?.usage?.inputTokens,
        reason: event?.data?.reason?.kind,
      })
      if (event?.type === 'turn/end') {
        try {
          const persistence = ctx.get('sessionPersistence')
          const sessions = ctx.get('sessions')
          const first = sessions.list()[0]
          const stat = persistence.stat(first.sessionId)
          const handle = persistence.open(first.sessionId, 'read')
          const page = handle.read({ maxMessages: 50 })
          handle.close()
          const assistant = page.events.find((item) => item.type === 'assistant/message' && item.data?.usage != null)
          heard.history = {
            sessionCount: sessions.list().length,
            eventCount: stat?.eventCount ?? -1,
            pageSize: page.events.length,
            hasUserMessage: page.events.some((item) => item.type === 'user/message'),
            types: page.events.map((item) => item.type),
            usage: assistant?.data?.usage,
          }
        } catch (error) {
          heard.problems.push('history: ' + error.message)
        }
      }
    })
  } catch (error) {
    heard.problems.push('session/event: ' + error.message)
  }

  return () => {
    delete globalThis.__liveProbe
  }
}
`,
  'utf8',
)

const { createKernel } = await import('../lib/host/kernel.js')
const { mountAllExternalPlugins } = await import('../lib/core/plugin-loader.js')
const { writePluginEnabled, writePluginConfig } = await import('../lib/core/plugin-registry.js')
writePluginEnabled('dsh-compat', true)
writePluginEnabled('dsh-live-probe.js', true)
writePluginConfig('dsh-live-probe.js', { risk: 'read' })

const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl,
        apiKey: 'k',
        models: [
          {
            id: 'm',
            name: 'm',
            contextWindow: 100000,
            maxTokens: 500,
            modalities: ['text'],
            thinkingLevels: [],
            thinkingParam: 'none',
            effortMap: {},
          },
        ],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

ctx.tools.register({
  name: 'read',
  description: '测试用读取工具',
  parameters: { type: 'object', properties: {} },
  risk: 'read',
  run: async () => '结果：a.ts 里有一行 export const a = 1',
})

console.log('[1] 挂载')
const failures = await mountAllExternalPlugins(ctx, [])
const failure = failures.find((row) => row.file === 'dsh-live-probe.js')
check('探针插件挂上了', failure === undefined, failure === undefined ? '' : failure.problem)

console.log('[2] 真回合（真内核 + 本地假端点）')
const ended = new Promise((resolve) => {
  const off = ctx.on('dsc/turn-end', () => {
    off()
    resolve()
  })
})
ctx.agent.followup('看看 a.ts')
const finished = await Promise.race([ended.then(() => true), sleep(15000).then(() => false)])
check('回合跑完了', finished === true)
await until(() => !ctx.agent.isRunning || false, 3000).catch(() => undefined)
await sleep(400)

const probe = globalThis.__liveProbe
check('探针拿到了账本', probe !== undefined)
const events = probe?.events ?? []
const types = events.map((row) => row.type)
const chunks = probe?.chunks ?? []

console.log('[3] llm/stream：实时用量')
check('收到两次调用的用量 chunk', chunks.length === 2, JSON.stringify(chunks))
check('第一次的 token 数与端点一致', chunks[0]?.input === 100 && chunks[0]?.output === 20, JSON.stringify(chunks[0]))
check('第二次也对', chunks[1]?.input === 300 && chunks[1]?.output === 90, JSON.stringify(chunks[1]))
check('chunk 带着会话 / 供应商 / 模型', typeof chunks[0]?.sessionId === 'string' && chunks[0]?.provider === 'test' && chunks[0]?.model === 'm', JSON.stringify(chunks[0]))

console.log('[4] session/event：回合过程')
check('听到 turn/start 与 turn/end', types[0] === 'turn/start' && types[types.length - 1] === 'turn/end', types.join(','))
check('两步各有一对 step/start · step/end', types.filter((t) => t === 'step/start').length === 2 && types.filter((t) => t === 'step/end').length === 2, types.join(','))
check('有两条 assistant/message', types.filter((t) => t === 'assistant/message').length === 2, types.join(','))
const assistants = events.filter((row) => row.type === 'assistant/message')
check('assistant/message 带着这一步的真实用量', assistants[0]?.usage === 100 && assistants[1]?.usage === 300, JSON.stringify(assistants.map((row) => row.usage)))
check('工具调用与结果都在', types.includes('tool/call') && types.includes('tool/result'), types.join(','))
check('turn/end 的原因是 completed', events[events.length - 1]?.reason === 'completed', String(events[events.length - 1]?.reason))
check('事件带着会话 id', events.every((row) => typeof row.id === 'string' && row.id === events[0]?.id), JSON.stringify(events[0]))

console.log('[5] sessionPersistence：回头能读到这一轮')
const history = probe?.history
check('读到了 1 个会话', history?.sessionCount === 1, JSON.stringify(history))
check('历史里有这一轮的用户消息', history?.hasUserMessage === true, JSON.stringify(history?.types))
check('历史页里也有助手消息与工具结果（dsh 的事件类型）', Array.isArray(history?.types) && history.types.includes('assistant/message') && history.types.includes('tool/result'), JSON.stringify(history?.types))
check('助手消息上挂着这一轮的用量（历史侧也能对账）', history?.usage !== undefined, JSON.stringify(history?.usage))

console.log('[6] 三条面一起时互不打架')
check('探针没报问题', Array.isArray(probe?.problems) && probe.problems.length === 0, JSON.stringify(probe?.problems))

ctx.emit('dsc/exit')
server.close()
const fiber = ctx?.fiber
if (fiber !== null && fiber !== undefined && typeof fiber.dispose === 'function') await fiber.dispose()

console.log(String.fromCharCode(10) + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
