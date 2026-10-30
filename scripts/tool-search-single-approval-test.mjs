/**
 * 「桥接工具一次调用只问一遍守卫链」的内核级探针（2026-10-30）。
 *
 * 背景：模型调 `tool_call` 转调撤下的工具时，以前会弹**两张**审批卡——第一张写的是
 * 「调用 tool_call」（用户看不出要动什么），点过之后桥自己再按真名判一遍，第二张才写
 * 真实工具。现在的做法是桥在循环里交出目标身份（`ToolEntry.gateAs`），只问一遍。
 *
 * 这一节用真内核 + 假端点跑三个回合，钉住五件事：
 *   [1] 撤下的 exec 工具（bash）：守卫链**只被问一次**，看到的是 `bash` 而不是 `tool_call`；
 *       只弹一张卡，卡上写的是 bash；点「拒绝」之后工具没执行；
 *   [1b] 点「这次允许」时仍然只有一张卡，放行后 bash 真的跑了；
 *   [2] 台面上的只读工具经 `tool_call` 转调时按 `read` 判定（只读免卡，结果原样回来）；
 *   [3] `tool_call` 这个名字一次都没出现在守卫链上（旧实现会在第一张卡上出现）。
 *
 * 隔离：临时 HOME，真实 ~/.dsc 一个字节都不动。用法：pnpm run build && node scripts/tool-search-single-approval-test.mjs
 *
 * @module dsc/scripts/tool-search-single-approval-test
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-single-approval-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dsc = join(home, '.dsc')
mkdirSync(dsc, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 官方可开关插件：打开 tool-search，并让 bash（exec）命中延后规则
writeFileSync(
  join(dsc, 'plugins.json'),
  JSON.stringify({ version: 1, entries: [{ file: 'tool-search', disabled: false, config: { deferRules: ['bash'] } }] }, null, 2),
  'utf8',
)

/** 「跑一下命令」这条探针要在工作目录里建的临时目录（放行路径会真的建出来，跑完删掉）。 */
const probeDir = join(process.cwd(), 'dsc-single-approval-probe')

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${extra === '' ? '' : ` — ${extra}`}`)
  }
}

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const sseText = (text) =>
  sse({ choices: [{ delta: { content: text } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
  sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) +
  'data: [DONE]\n\n'
const sseToolCall = (id, name, args) =>
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
  sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) +
  'data: [DONE]\n\n'

/** 已经发过工具调用的提问原文：同一句再进来就是「这一轮工具回来了」，该收尾了。 */
const servedPrompts = new Set()

/** 假端点：按这一轮的提问决定第一次回哪个工具调用；有工具结果就收尾。 */
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
    // 末尾那条 user 是程序自动附上的环境快照，不是用户说的话（与 preset-scope 探针同口径）
    const lastUser = [...messages]
      .reverse()
      .find((message) => message.role === 'user' && !(typeof message.content === 'string' && message.content.includes('不是用户发言')))
    const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    // 这一句提问已经发过工具调用 → 这一轮收尾。按「提问原文」记账，不能看「有没有 tool 消息」：
    // 上一轮的工具结果留在历史里，会把新一轮误判成已调过。
    if (servedPrompts.has(text.trim())) {
      res.end(sseText('工具回来了'))
      return
    }
    if (text.includes('跑一下命令')) {
      servedPrompts.add(text.trim())
      // 外层是桥，里层是真名：旧实现会先按 tool_call 弹一张卡，再按 bash 弹一张
      // 用一条「写」命令，保证走到审批（只读命令会被 auto-edit 档直接放行，测不到那张卡）
      res.end(sseToolCall('t_bash', 'tool_call', JSON.stringify({ name: 'bash', arguments: { command: 'mkdir dsc-single-approval-probe' } })))
      return
    }
    if (text.includes('读一个文件')) {
      servedPrompts.add(text.trim())
      res.end(sseToolCall('t_read', 'tool_call', JSON.stringify({ name: 'read', arguments: { path: 'package.json' } })))
      return
    }
    res.end(sseText('收到'))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

const { createKernel } = await import('../lib/host/kernel.js')
const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: `http://127.0.0.1:${String(port)}`,
        apiKey: 'k',
        models: [{ id: 'm', name: 'm', contextWindow: 100000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

// 装一个「有人在看」的界面信号：没有它，审批插件判定「没人能答」，卡根本不弹（直接按拒），
// 探针也就看不到那张卡。tui 插件的报法就是这样，这里照抄一份。
ctx.provide('interactive', { kind: 'tui', reachable: () => true })

/** 守卫链上被问到的每一次（插件按 order 20 插一条只记账、不表态的守卫）。 */
const seen = []
ctx.guards.register({
  id: 'probe-count',
  order: 20,
  decide(input) {
    seen.push({ tool: input.toolName, risk: input.risk, args: input.args })
    return { action: 'defer' }
  },
})

const toolTexts = (session) => session.messages.filter((message) => message.role === 'tool').map((message) => String(message.content))

/** 这一轮冒出来的审批卡（按出现顺序记 toolName；同一张卡只记一次）。 */
const cards = []
/**
 * 第一张卡答完之后置 true：再冒出来的卡自动按拒收掉。
 * 本探针要抓的回归正是「多出第二张卡」——多出来那张不能把整批自检挂到 300 秒超时。
 */
let rejectExtras = false
const cardWatcher = setInterval(() => {
  const view = ctx.approval.pendingView()
  if (view !== null && view !== undefined && !cards.some((card) => card.id === view.id)) {
    cards.push({ id: view.id, tool: view.toolName, argsSummary: view.argsSummary })
    if (rejectExtras) ctx.approval.answer('reject')
  }
}, 10)
cardWatcher.unref?.()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return true
    if (Date.now() > deadline) return false
    await sleep(20)
  }
}

/**
 * 跑一个回合，返回 turn-end 的原因。
 *
 * @param cardAnswer - null = 这一轮不该弹卡；否则是探针替用户点的答案（'reject' / 'allow-once'）。
 *                     没人点的话内核会挂满超时（300 秒），整批自检会被拖死。
 */
async function turn(text, cardAnswer = null) {
  seen.length = 0
  cards.length = 0
  rejectExtras = false
  const session = ctx.session.current()
  const done = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', (reason, signal) => {
      if (signal !== undefined && signal.sessionId !== session.meta.id) return
      off()
      resolve(reason)
    })
  })
  ctx.agent.followup(text)
  if (cardAnswer !== null) {
    // 给卡一点时间冒出来再点；不给答案就会挂到超时（300 秒）
    await until(() => cards.length > 0, 10000)
    await sleep(150)
    ctx.approval.answer(cardAnswer)
    rejectExtras = true
  }
  const reason = await done
  return { reason, session }
}

console.log('桥接工具单次审批测试')
{
  check('bash 已被 tool-search 撤下（前提）', !ctx.tools.list().some((tool) => tool.name === 'bash'))
  check('tool_call 在台面上（前提）', ctx.tools.list().some((tool) => tool.name === 'tool_call'))
}

console.log('[1] 撤下的 exec 工具：守卫链只问一次，问的是真名')
{
  const first = await turn('跑一下命令', 'reject')
  check('回合正常收尾', first.reason === 'completed', first.reason)
  check('只弹了一张审批卡（不是「tool_call + bash」两张）', cards.length === 1, JSON.stringify(cards.map((card) => card.tool)))
  check('卡上写的是真实工具名 bash', cards[0]?.tool === 'bash', JSON.stringify(cards))
  check('守卫链只被问了一次', seen.length === 1, JSON.stringify(seen.map((item) => item.tool)))
  check('问的是 bash（不是 tool_call）', seen[0]?.tool === 'bash', JSON.stringify(seen))
  check('风险按真实工具给（exec）', seen[0]?.risk === 'exec', JSON.stringify(seen))
  check('参数是真参数（command=mkdir …）', seen[0]?.args?.command === 'mkdir dsc-single-approval-probe', JSON.stringify(seen[0]?.args))
  check('tool_call 这个名字一次都没出现在守卫链上', !seen.some((item) => item.tool === 'tool_call'), JSON.stringify(seen.map((item) => item.tool)))
  const texts = toolTexts(first.session)
  check('点「拒绝」之后工具被拒（结果里是那句拒绝文案）', texts.some((text) => text.includes('用户拒绝了这次工具调用')), JSON.stringify(texts.slice(-1)))
  check('bash 真的没被执行（目录没被建出来）', existsSync(probeDir) === false, '目录竟然建出来了')
}

console.log('[1b] 点「这次允许」：仍然只有一张卡，放行后工具真的跑了')
{
  const allowed = await turn('跑一下命令再来一次', 'allow-once')
  check('回合正常收尾', allowed.reason === 'completed', allowed.reason)
  check('放行路径也只弹了一张卡', cards.length === 1, JSON.stringify(cards.map((card) => card.tool)))
  check('卡上写的仍是 bash', cards[0]?.tool === 'bash', JSON.stringify(cards))
  check('bash 被执行了（目录建出来了）', existsSync(probeDir) === true, '目录没建出来')
  rmSync(probeDir, { recursive: true, force: true })
}

console.log('[2] 台面上的只读工具：经桥转调仍按 read 判定（免卡、结果原样回来）')
{
  const second = await turn('读一个文件')
  check('回合正常收尾', second.reason === 'completed', second.reason)
  check('只读工具没有弹卡', cards.length === 0, JSON.stringify(cards))
  check('守卫链只被问了一次', seen.length === 1, JSON.stringify(seen.map((item) => item.tool)))
  check('问的是 read 且风险是 read', seen[0]?.tool === 'read' && seen[0]?.risk === 'read', JSON.stringify(seen))
  const texts = toolTexts(second.session)
  check('read 真的执行了（拿到了 package.json 的正文）', texts.some((text) => text.includes('"name"')), JSON.stringify(texts.slice(-1)).slice(0, 200))
  check('这次没有被拒', !texts.some((text) => text.includes('没有界面能回答审批卡')), JSON.stringify(texts.slice(-1)).slice(0, 200))
}

// 探针中途失败也要把临时目录收掉：它建在仓库根下，留着会变成脏文件
rmSync(probeDir, { recursive: true, force: true })
ctx.emit('dsc/exit')
console.log('')
console.log(`${String(pass)} PASS / ${String(fail)} FAIL`)
await new Promise((resolve) => {
  server.close(resolve)
  server.closeAllConnections?.()
})
setTimeout(() => {
  process.exit(fail === 0 ? 0 : 1)
}, 300).unref()
process.exitCode = fail === 0 ? 0 : 1
