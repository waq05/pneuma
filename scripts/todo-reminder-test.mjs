/**
 * WS6(b) todo 节流提醒：距上次写清单过了 N 个用户回合、且还有未完成项时，往请求末尾补一条
 * user 提醒。**默认关**（不给所有会话凭空加 token），投影名为 `todo-reminder`（order 800）。
 *
 * 断言分两层：
 *  ① 纯函数 `countUserTurnsSinceLastTodoWrite` / `appendTodoReminder`：
 *     回合计数（尾部 env 快照与当前这轮不算回合）、默认不注入、到 N 注入、未到 N 不注入、
 *     无未完成项不注入、幂等、不改输入、everyTurns 夹到 ≥1；
 *  ② 端到端（真内核 + 假 SSE）：真跑 todo_write 立清单 → 多轮对话 → 抓每次请求体：
 *     默认关时即便过了 N 回合也不注入；打开后下一轮注入、是 user、落在末尾；
 *     会话日志（内存 + jsonl 文件）里没有这条提醒；清空清单后不再注入。
 *
 * 隔离：临时 HOME + 假模型端点，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm build && node scripts/todo-reminder-test.mjs
 *
 * @module dsc/scripts/todo-reminder-test
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-todo-reminder-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 关掉长期记忆：它在回合结束会投机器通知、还会多发一次模型请求，混进要观察的请求体里。
writeFileSync(
  join(home, '.dsc', 'plugins.json'),
  JSON.stringify({ version: 1, entries: [{ file: 'memory', config: { enabled: false } }] }, null, 2),
  'utf8',
)

const { TODO_REMINDER_TEXT, countUserTurnsSinceLastTodoWrite, appendTodoReminder } = await import(
  '../lib/core/todo-reminder.js'
)

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(20)
  }
}

// ── 构造历史的小工具 ─────────────────────────────────────────────────────────
const userMsg = (text) => ({ role: 'user', content: text })
const assistantMsg = (text) => ({ role: 'assistant', content: text })
const todoWriteMsg = () => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'todo_write', arguments: '{}' } }],
})
const toolResultMsg = () => ({ role: 'tool', content: '清单已更新（1/1 完成）', tool_call_id: 'c1' })
/** 请求尾部那条程序自动附的环境快照（env-facts 投影，跑在本投影之前）。 */
const envSnapshotMsg = () => ({
  role: 'user',
  content: '环境事实：\n- 今天：2026-10-15\n（本条是程序在每次请求时自动附上的当前环境快照，不是用户发言）',
})

/** 历史：开场就写了 todo_write，其后接 n 个「用户问 + 模型答」的完整回合。 */
function historyWithTurns(n) {
  const messages = [userMsg('第一步'), todoWriteMsg(), toolResultMsg(), assistantMsg('收到')]
  for (let i = 0; i < n; i += 1) {
    messages.push(userMsg(`第 ${i + 2} 步`))
    messages.push(assistantMsg('收到'))
  }
  return messages
}

console.log('[1] 纯函数：回合计数')
{
  check('提醒原文一字不差', TODO_REMINDER_TEXT === '（提醒：任务清单有未完成项，做完一步就把状态改掉）', TODO_REMINDER_TEXT)
  const noWrite = [userMsg('a'), assistantMsg('ok'), userMsg('b'), assistantMsg('ok'), userMsg('c'), assistantMsg('ok')]
  check('没有 todo_write 时从第 0 条起数（3 个完整回合）', countUserTurnsSinceLastTodoWrite(noWrite) === 3, String(countUserTurnsSinceLastTodoWrite(noWrite)))
  check('todo_write 之后数出 2 个完整回合', countUserTurnsSinceLastTodoWrite(historyWithTurns(2)) === 2, String(countUserTurnsSinceLastTodoWrite(historyWithTurns(2))))
  const withTail = [...historyWithTurns(2), userMsg('当前这轮'), envSnapshotMsg()]
  check(
    '尾部 env 快照与当前这轮（后面没有 assistant）不算回合',
    countUserTurnsSinceLastTodoWrite(withTail) === 2,
    String(countUserTurnsSinceLastTodoWrite(withTail)),
  )
}

console.log('[2] 纯函数：注入判定')
{
  const opts = { enabled: true, everyTurns: 10, hasOpenTodos: true }
  const before = historyWithTurns(9)
  const at = historyWithTurns(10)
  const beforeTail = [...before, envSnapshotMsg()]

  const off = appendTodoReminder(historyWithTurns(20), { ...opts, enabled: false })
  check(
    '默认关（enabled:false）不注入',
    off.length === historyWithTurns(20).length && !off.some((m) => m.content === TODO_REMINDER_TEXT),
    JSON.stringify(off.length),
  )

  const injected = appendTodoReminder(at, opts)
  check('到 N 回合注入一条', injected.length === at.length + 1, `${injected.length}/${at.length}`)
  check('注入的是 user 角色', injected.at(-1)?.role === 'user', injected.at(-1)?.role)
  check('注入的正文就是提醒原文', injected.at(-1)?.content === TODO_REMINDER_TEXT, String(injected.at(-1)?.content))

  const notYet = appendTodoReminder(before, opts)
  check('未到 N（9 < 10）不注入', notYet.length === before.length, String(notYet.length))
  check(
    '边界：9 个完整回合 + 尾部 env 快照仍不注入（env 快照没被当成第 10 个回合）',
    appendTodoReminder(beforeTail, opts).length === beforeTail.length,
    String(appendTodoReminder(beforeTail, opts).length),
  )

  const noOpen = appendTodoReminder(historyWithTurns(20), { ...opts, hasOpenTodos: false })
  check('没有未完成 todo 不注入', noOpen.length === historyWithTurns(20).length, String(noOpen.length))

  const once = appendTodoReminder(at, opts)
  const twice = appendTodoReminder(once, opts)
  check('幂等：同一历史重复投影长度不变', twice.length === once.length, `${twice.length}/${once.length}`)
  check('幂等：重复投影逐字节相等', JSON.stringify(twice) === JSON.stringify(once), '两次不等')

  const input = historyWithTurns(10)
  const inputLengthBefore = input.length
  const out = appendTodoReminder(input, opts)
  check('不改输入（原数组长度不变）', input.length === inputLengthBefore, String(input.length))
  check('注入返回的是新数组，不是原数组', out !== input, 'same ref')

  check(
    'everyTurns 夹到至少 1：配 0 且 0 个完整回合时不注入',
    appendTodoReminder(historyWithTurns(0), { ...opts, everyTurns: 0 }).length === historyWithTurns(0).length,
    'everyTurns=0 被当成每轮都发',
  )
  check(
    'everyTurns 为负数同样夹到 1（0 回合不发）',
    appendTodoReminder(historyWithTurns(0), { ...opts, everyTurns: -5 }).length === historyWithTurns(0).length,
    'everyTurns=-5',
  )
}

// ── 假模型端点（真 SSE）：按会话请求序号分派，抓每次请求体 ──────────────────────
const sseText = (text) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n` +
  'data: [DONE]\n\n'
const sseToolCall = (id, name, args) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n` +
  'data: [DONE]\n\n'

/** 会话请求体按顺序记录（下标 1 起；标题请求不计）。 */
const convoBodies = []
let convo = 0
async function serve() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        payload = {}
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const isTitleRequest = messages.some(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('会话标题生成器'),
      )
      if (isTitleRequest) {
        res.end(sseText('节流提醒探针的会话标题'))
        return
      }
      convo += 1
      convoBodies[convo] = messages
      // 第一轮让模型立一张清单（含一条未完成项），之后都只是普通回话。
      if (convo === 1) {
        res.end(sseToolCall('t1', 'todo_write', JSON.stringify({ todos: [{ content: '修掉登录 bug', status: 'in_progress' }] })))
      } else {
        res.end(sseText('收到'))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const site = await serve()
const { createKernel } = await import('../lib/host/kernel.js')
const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: site.baseUrl,
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

/** 提醒在某一轮请求体里的位置（下标），没有返回 -1。 */
const reminderAt = (body) => body.findIndex((m) => m.role === 'user' && m.content === TODO_REMINDER_TEXT)

/** 跑一个真回合（用户说一句，等 turn-end + agent 闲下来）。 */
async function runTurn(text) {
  const ended = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', () => {
      off()
      resolve()
    })
  })
  ctx.agent.followup(text)
  await ended
  await until(() => !ctx.agent.isRunning)
  await sleep(80)
}

console.log('[3] 端到端：默认关不注入、开启后到点注入、清空后不注入')
{
  // 间隔临时设成 1，好让「开启后」很快到点；enabled 保持默认 false。
  await ctx.settings.save('todo', 'everyTurns', 1)

  await runTurn('第一步：先立清单再动手')
  const open = ctx.todo.todoView().items.some((item) => item.status === 'in_progress')
  check('端到端立起了含未完成项的清单', open, JSON.stringify(ctx.todo.todoView().items))
  check('第一轮请求体内没有提醒', reminderAt(convoBodies[1]) === -1, JSON.stringify(convoBodies[1]?.slice(-2)))

  await runTurn('第二步')
  check('第二轮（0 个完整回合）不注入', reminderAt(convoBodies[3]) === -1, String(reminderAt(convoBodies[3])))

  await runTurn('第三步')
  check(
    '默认关：已过 1 个完整回合仍不注入',
    reminderAt(convoBodies[4]) === -1,
    `reminderAt=${reminderAt(convoBodies[4])}`,
  )

  // 打开开关：下一条请求就该带提醒了
  await ctx.settings.save('todo', 'enabled', true)
  await runTurn('第四步')
  const body5 = convoBodies[5]
  check('开启后：下一轮注入一条', body5.filter((m) => m.role === 'user' && m.content === TODO_REMINDER_TEXT).length === 1, JSON.stringify(body5.slice(-3)))
  check('注入的是 user 角色', body5.at(-1)?.role === 'user' && body5.at(-1)?.content === TODO_REMINDER_TEXT, JSON.stringify(body5.at(-1)))
  check('提醒落在请求末尾（env 快照之后）', reminderAt(body5) === body5.length - 1, `at=${reminderAt(body5)}/len=${body5.length}`)

  // 不改日志：内存里的会话消息与磁盘 jsonl 都不该有这条提醒
  const inMemory = ctx.session.current().messages.some((m) => m.content === TODO_REMINDER_TEXT)
  check('会话日志（内存）里没有提醒', inMemory === false, '日志被改了')
  const fileText = readFileSync(ctx.session.current().filePath, 'utf8')
  check('会话 jsonl 文件里没有提醒', !fileText.includes(TODO_REMINDER_TEXT), ctx.session.current().filePath)

  // 清空清单：没有未完成项就不该再提醒
  ctx.todo.clearTodos()
  await runTurn('第五步')
  check(
    '清空清单后不再注入（无未完成项）',
    reminderAt(convoBodies[6]) === -1,
    `reminderAt=${reminderAt(convoBodies[6])}`,
  )
}

await ctx.dispose?.()
await site.close()
console.log('')
if (failures === 0) console.log('todo 节流提醒电池：全部通过')
else console.log(`todo 节流提醒电池：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
process.exit(failures === 0 ? 0 : 1)
