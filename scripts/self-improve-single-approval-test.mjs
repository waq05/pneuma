/**
 * 技能写入只弹一张审批卡（2026-10-30）。
 *
 * 旧行为：skill_write 是 write 档，循环先按它问一遍通用审批卡（卡上只说「工作区外的改动
 * 需要确认」），点过之后工具自己执行前又按「create 哪个技能」问一遍——同一件事两张卡。
 * 现在自我改进插件在守卫链 order 29 让 skill_write 跳过 order 30 的审批（只跳这一格），
 * 由工具自己那张信息更全的卡把关。
 *
 * 钉住三件事：
 *   [1] 一次写入只弹一张卡；
 *   [2] 卡上是 skill_write，摘要里带技能名（证明留下的是插件自己那张，不是通用卡）；
 *   [3] 点「这次允许」之后技能真的落盘（没被两层审批卡夹成「批了也没写」）。
 *
 * 隔离：临时 HOME（DSC_HOME 跟着它），真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm run build && node scripts/self-improve-single-approval-test.mjs
 *
 * @module dsc/scripts/self-improve-single-approval-test
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-skill-approval-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dsc = join(home, '.dsc')
mkdirSync(dsc, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')
writeFileSync(
  join(dsc, 'plugins.json'),
  JSON.stringify({ version: 1, entries: [{ file: 'self-improve', disabled: false }] }, null, 2),
  'utf8',
)

let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) {
    pass += 1
    console.log('  PASS ' + name)
  } else {
    fail += 1
    console.log('  FAIL ' + name + (extra === undefined || extra === '' ? '' : ' — ' + extra))
  }
}

const sse = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n'
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

const SKILL_MARKDOWN = [
  '---',
  'name: probe-skill',
  'description: 探针用技能（只写在临时 HOME 里）',
  'whenToUse: 自检时',
  '---',
  '',
  '# 探针技能',
  '',
  '这段正文是自检写的。',
].join('\n')

/** 这一句提问已经发过工具调用 → 收尾。 */
const servedPrompts = new Set()

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
    const lastUser = [...messages]
      .reverse()
      .find((message) => message.role === 'user' && !(typeof message.content === 'string' && message.content.includes('不是用户发言')))
    const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (servedPrompts.has(text.trim())) {
      res.end(sseText('好了'))
      return
    }
    if (text.includes('建一个技能')) {
      servedPrompts.add(text.trim())
      res.end(
        sseToolCall(
          't_skill',
          'skill_write',
          JSON.stringify({ action: 'create', name: 'probe-skill', content: SKILL_MARKDOWN }),
        ),
      )
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
        baseUrl: 'http://127.0.0.1:' + String(port),
        apiKey: 'k',
        models: [{ id: 'm', name: 'm', contextWindow: 100000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

// 有人在看：没有这个信号，审批插件判定「没人能答」，卡不弹。
ctx.provide('interactive', { kind: 'tui', reachable: () => true })

/** 守卫链现状：这个探针要确认自我改进那位（order 29）真的挂上了。 */
const chain = ctx.guards.chain.map((guard) => guard.id + '@' + String(guard.order))

const cards = []
let rejectExtras = false
const cardWatcher = setInterval(() => {
  const view = ctx.approval.pendingView()
  if (view !== null && view !== undefined && !cards.some((card) => card.id === view.id)) {
    cards.push({ id: view.id, tool: view.toolName, summary: view.argsSummary })
    if (rejectExtras) ctx.approval.answer('reject')
  }
}, 10)
cardWatcher.unref?.()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return true
    if (Date.now() > deadline) return false
    await sleep(20)
  }
}

const session = ctx.session.current()
const done = new Promise((resolve) => {
  const off = ctx.on('dsc/turn-end', (reason, signal) => {
    if (signal !== undefined && signal.sessionId !== session.meta.id) return
    off()
    resolve(reason)
  })
})
ctx.agent.followup('建一个技能')
await until(() => cards.length > 0)
await sleep(150)
ctx.approval.answer('allow-once')
rejectExtras = true
const reason = await done

console.log('技能写入单次审批')
check('自我改进的守卫挂在 order 29', chain.includes('self-improve@29'), JSON.stringify(chain))
check('回合正常收尾', reason === 'completed', String(reason))
check('只弹了一张审批卡', cards.length === 1, JSON.stringify(cards.map((card) => card.tool)))
check('卡上是 skill_write', cards[0]?.tool === 'skill_write', JSON.stringify(cards[0]))
check('卡摘要里带技能名（留下的是插件自己那张）', typeof cards[0]?.summary === 'string' && cards[0].summary.includes('probe-skill'), String(cards[0]?.summary))

const texts = session.messages.filter((message) => message.role === 'tool').map((message) => String(message.content))
check('工具结果说写成功了', texts.some((item) => item.includes('新建') || item.includes('创建') || item.includes('probe-skill')), JSON.stringify(texts.slice(-1)).slice(0, 200))
check('技能真的落盘了', existsSync(join(dsc, 'skills', 'probe-skill', 'SKILL.md')), join(dsc, 'skills', 'probe-skill', 'SKILL.md'))

clearInterval(cardWatcher)
ctx.emit('dsc/exit')
console.log('')
console.log(String(pass) + ' PASS / ' + String(fail) + ' FAIL')
await new Promise((resolve) => {
  server.close(resolve)
  server.closeAllConnections?.()
})
setTimeout(() => {
  process.exit(fail === 0 ? 0 : 1)
}, 300).unref()
process.exitCode = fail === 0 ? 0 : 1
