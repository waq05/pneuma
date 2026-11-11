/**
 * todo 节流提醒的**注入节流电池**：提醒是「每 N 轮一次」，不是「越过 N 轮之后每一跳都补」。
 *
 * 缺陷现场（2026-11-11 核实）：`appendTodoReminder` 的幂等判据查「历史里有没有这条提醒」，
 * 而提醒是投影注入、不落历史（`core/todo-reminder.ts` 文件头写了为什么刻意不落）。于是
 * 「距上次写清单已 ≥ N 轮」一旦成立，之后每一跳都满足，**每一跳都再补一次同一句提醒**：
 * 12 轮跑下来，第 10..13 次请求各带一条（4 条），实际只需要 1 条。
 *
 * 修法是投影侧加一笔按会话台账（`core/todo-reminder-cadence.ts`）：
 * 判据改成「本轮 − 上次注入的轮 ≥ everyRounds」，只有真注入了才记账。
 *
 * 断言分三层：
 *  ① 纯逻辑 `TodoReminderCadence` / `countRounds`：台账空 → 首次；第 N 轮注入后
 *     N+1..N+everyRounds−1 不注入；到 N+everyRounds 再注入；`everyRounds` 可配（含 0/负数
 *     夹到 1、小数向下取整）；两个会话互不影响；换会话重新从「首次必注入」开始；
 *     轮号倒退（压缩）当台账失效；**同一轮重复投影必须给同一个答案**（回合环的 invariant
 *     二次派生会比第二遍，两遍不一致就报「对不上」）。
 *  ② 源码钉：`packages/todo/index.ts` 的 todo-reminder 投影真的在调这两个方法，且
 *     `mark` 在 `appendTodoReminder` 之后、在「没补就原样返回」之后——把台账拆掉，这一层当场红。
 *  ③ 端到端（真内核 + 假 SSE）：同一条会话连跑 18 轮，抓每次请求体：提醒只出现在第 10 次
 *     （轮号 9）与第 18 次（轮号 17）请求里，其余 17 次一条都没有；会话日志里没有把提醒
 *     当成消息落盘；带 todo-reminder 的注入记录仍是 1 条（上报闸「内容没变就不记」没动）。
 *
 * 隔离：临时 HOME + 假模型端点，真实 `~/.dsc` 一个字节都不动；跑完删临时 HOME。
 * 用法：pnpm run build && node scripts/todo-reminder-cadence-test.mjs
 *
 * @module dsc/scripts/todo-reminder-cadence-test
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}

const { countRounds, TodoReminderCadence } = await import('../lib/core/todo-reminder-cadence.js')
const { TODO_REMINDER_TEXT, appendTodoReminder } = await import('../lib/core/todo-reminder.js')

// ── 构造历史的小工具（与 appendTodoReminder 的入参同形）──────────────────────
const userMsg = (text) => ({ role: 'user', content: text })
const assistantMsg = (text) => ({ role: 'assistant', content: text })
const todoWriteMsg = () => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'todo_write', arguments: '{}' } }],
})
const toolResultMsg = () => ({ role: 'tool', content: '清单已更新（1/1 完成）', tool_call_id: 'c1' })
/**
 * 造一份「正好第 round 轮」的请求：开场写了 todo_write（那条 assistant 自己算 1 轮），
 * 之后每轮一条 assistant，于是 `countRounds` 恰好等于 round、距上次写清单的轮数是 round−1。
 * 用这个而不是「写完之后再接 n 条」：本电池的判据全在轮号上，差一就整段红。
 */
function historyAtRound(round) {
  const messages = [userMsg('第一步'), todoWriteMsg(), toolResultMsg()]
  for (let i = 0; i < round - 1; i += 1) messages.push(assistantMsg(`第 ${i + 1} 轮`))
  return messages
}

/** 提醒是否在这份消息里（与投影的正文逐字比较）。 */
const hasReminder = (messages) => messages.some((m) => m.role === 'user' && m.content === TODO_REMINDER_TEXT)

/**
 * 复刻投影那两步（`due` → 试注入 → 真补了才 `mark`），返回这一跳的结论与是否真的补了。
 * 端到端那一段用的是真内核；这里只用来把「同一轮重复投影」这类边界钉死。
 */
function projectOnce(cadence, sessionId, messages, everyRounds) {
  if (!cadence.due(sessionId, countRounds(messages), everyRounds)) {
    return { injected: false, out: messages }
  }
  const out = appendTodoReminder(messages, { enabled: true, everyRounds, hasOpenTodos: true })
  if (out === messages) return { injected: false, out }
  cadence.mark(sessionId, countRounds(messages))
  return { injected: true, out }
}

console.log('[1] 轮号：一轮 = 一条 assistant 消息')
{
  const history = historyAtRound(3)
  check('3 轮 = 3', countRounds(history) === 3, String(countRounds(history)))
  check('空历史是第 0 轮', countRounds([]) === 0, String(countRounds([])))
  check('user / tool 不算轮', countRounds([userMsg('a'), toolResultMsg(), userMsg('b')]) === 0)
  check('todo_write 自己那条 assistant 算一轮', countRounds([userMsg('a'), todoWriteMsg(), toolResultMsg()]) === 1)
  check('环境快照那条 user 不算轮', countRounds([...history, userMsg('当前这轮'), userMsg('环境事实：…')]) === 3)
}

console.log('[2] 台账：首次必注入、之后每 everyRounds 轮一次')
{
  const every = 8
  const cadence = new TodoReminderCadence()
  check('① 台账空 → 首次注入（due 为 true）', cadence.due('s1', 0, every) === true)

  // 第 9 轮（0 基第 9 条 assistant）真的补上了，于是记账。
  const injected = projectOnce(cadence, 's1', historyAtRound(9), every)
  check('① 首次：真的往请求末尾补了一条', injected.injected && hasReminder(injected.out), String(injected.out.length))
  check('首次注入的那一轮就是现在这一轮', cadence.due('s1', 9, every) === true, '同一轮重复投影必须仍然 due')

  // ② N+1 … N+everyRounds−1 不注入
  const blocked = []
  for (let round = 10; round <= 16; round += 1) blocked.push(cadence.due('s1', round, every))
  check('② 第 10..16 轮不注入（N+1..N+everyRounds−1 全 false）', blocked.every((value) => value === false), JSON.stringify(blocked))
  const skipped = projectOnce(cadence, 's1', historyAtRound(12), every)
  check('② 第 12 轮投影一次：没有补提醒', skipped.injected === false && !hasReminder(skipped.out))

  // ③ 到 N+everyRounds 轮再注入
  check('③ 第 17 轮（9+8）又该注入', cadence.due('s1', 17, every) === true)
  check('③ 第 16 轮仍然不注入（差一轮也不行）', cadence.due('s1', 16, every) === false)
  const again = projectOnce(cadence, 's1', historyAtRound(17), every)
  check('③ 第 17 轮真的又补了一条', again.injected && hasReminder(again.out))
  check('③ 记完账之后立刻又沉下去（第 18 轮不注入）', cadence.due('s1', 18, every) === false)
}

console.log('[3] everyRounds 可配')
{
  const cadence = new TodoReminderCadence()
  cadence.mark('s1', 100)
  check('everyRounds=3：+1 轮不注入', cadence.due('s1', 101, 3) === false)
  check('everyRounds=3：+2 轮不注入', cadence.due('s1', 102, 3) === false)
  check('everyRounds=3：+3 轮注入', cadence.due('s1', 103, 3) === true)
  check('everyRounds=1：下一轮就注入', cadence.due('s1', 101, 1) === true)
  check('everyRounds=0 夹到 1（下一轮就注入，不是永远）', cadence.due('s1', 101, 0) === true)
  check('everyRounds 为负数同样夹到 1', cadence.due('s1', 101, -5) === true)
  check('everyRounds=2.9 向下取整成 2：+1 不注入', cadence.due('s1', 101, 2.9) === false)
  check('everyRounds=2.9 向下取整成 2：+2 注入', cadence.due('s1', 102, 2.9) === true)
}

console.log('[4] 两个会话互不影响 / 换会话重新开始')
{
  const cadence = new TodoReminderCadence()
  cadence.mark('s1', 9)
  cadence.mark('s2', 3)
  check('⑤ s1 刚提醒过（第 10 轮不注入）', cadence.due('s1', 10, 8) === false)
  check('⑤ s2 自己那一轮还早（第 4 轮不注入）', cadence.due('s2', 4, 8) === false)
  check('⑤ s2 到点照样注入（3+8=11）', cadence.due('s2', 11, 8) === true)
  check('⑤ s2 注入不影响 s1 的账', cadence.due('s1', 11, 8) === false)
  check('⑥ 新会话 id（台账里没有）→ 首次必注入', cadence.due('s3', 11, 8) === true)
  check('⑥ 新会话即使轮号很大也照样注入（是「这一条会话」没记过）', cadence.due('s4', 500, 8) === true)
}

console.log('[5] 边角：轮号倒退、同一轮重复投影、同一轮真的重试')
{
  const cadence = new TodoReminderCadence()
  cadence.mark('s1', 100)
  check('压缩后轮号倒退（100 → 20）→ 台账失效，当首次', cadence.due('s1', 20, 8) === true)
  cadence.mark('s1', 20)
  check('倒退之后再记账，回到正常周期', cadence.due('s1', 21, 8) === false)

  // invariant 二次派生：同一份输入跑两遍，结论与产物必须逐字一致。
  const cadence2 = new TodoReminderCadence()
  const history = historyAtRound(9)
  const first = projectOnce(cadence2, 's1', history, 8)
  const second = projectOnce(cadence2, 's1', history, 8)
  check('同一轮重复投影：两遍都补提醒', first.injected === true && second.injected === true)
  check('同一轮重复投影：两遍产物逐字节相同', JSON.stringify(first.out) === JSON.stringify(second.out))

  // 流中断后的整轮重试：同一轮再组装一次，必须仍带提醒，否则模型第二次看到的是另一份请求。
  check('同一轮重试（轮号不变）仍然 due', cadence2.due('s1', 9, 8) === true)
  check('重试之后下一轮照常沉下去', cadence2.due('s1', 10, 8) === false)
}

console.log('[6] 源码钉：投影真的在用这笔台账（拆掉就红）')
{
  // 先把注释行剥掉再扫：注释里写着这段的理由、也引用了方法名，留着会让「删掉调用」也被判成绿。
  const source = readFileSync(new URL('../src/packages/todo/index.ts', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => {
      const text = line.trim()
      return !(text.startsWith('//') || text.startsWith('*') || text.startsWith('/*') || text.startsWith('*/'))
    })
    .join('\n')
  check('投影 import 了台账模块', source.includes("from '@pneuma/runtime/core/todo-reminder-cadence.js'"))
  check('投影构造了台账', /const reminderCadence = new TodoReminderCadence\(\)/.test(source))
  const dueAt = source.indexOf('reminderCadence.due(')
  const appendAt = source.indexOf('appendTodoReminder(messages, {')
  const guardAt = source.indexOf('if (out === messages) return out')
  const markAt = source.indexOf('reminderCadence.mark(')
  check('投影按 `due` 判这一跳要不要试', dueAt >= 0, String(dueAt))
  check('`due` 在试注入之前', dueAt >= 0 && appendAt > dueAt, `due=${String(dueAt)} append=${String(appendAt)}`)
  check('「没补就原样返回」在 `mark` 之前（只有真注入才记账）', guardAt >= 0 && markAt > guardAt, `guard=${String(guardAt)} mark=${String(markAt)}`)
  check('`mark` 在 `appendTodoReminder` 之后', markAt > appendAt, `append=${String(appendAt)} mark=${String(markAt)}`)
  check('提醒正文没被改动', TODO_REMINDER_TEXT === '（提醒：任务清单有未完成项，做完一步就把状态改掉）', TODO_REMINDER_TEXT)
}

// ── 端到端：真内核 + 假 SSE，同一条会话连跑 18 轮 ────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'dsc-todo-cadence-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 关掉会在回合前后自己发请求的插件：序号一乱，判据就全错。
writeFileSync(
  join(home, '.dsc', 'plugins.json'),
  JSON.stringify({
    version: 1,
    entries: [
      { file: 'memory', disabled: true },
      { file: 'session-title', disabled: true },
      { file: 'self-improve', disabled: true },
    ],
  }, null, 2),
  'utf8',
)

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

/** 每次会话请求的 messages（按请求顺序）。 */
const bodies = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let payload = {}
    try { payload = JSON.parse(body) } catch { payload = {} }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const isTitleRequest = messages.some(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('会话标题生成器'),
    )
    if (isTitleRequest) {
      res.end(sseText('节流电池的会话标题'))
      return
    }
    bodies.push(messages)
    // 第一轮让模型立一张含未完成项的清单，之后都只是普通回话（每轮一次请求）。
    res.end(bodies.length === 1
      ? sseToolCall('t1', 'todo_write', JSON.stringify({ todos: [{ content: '跑完 18 轮', status: 'in_progress' }] }))
      : sseText('收到'))
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** 服务是插件挂载出来的：等它出现，别拿「刚好还没挂上」当失败（也把真失败说清楚）。 */
for (let i = 0; i < 100 && ctx.get('agent') === undefined; i += 1) await sleep(50)
if (ctx.get('agent') === undefined) {
  check('内核挂起来了（agent 服务在）', false, 'agent 服务没挂上，后面的回合跑不了')
  await ctx.dispose?.()
  server.close()
  server.closeAllConnections?.()
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}
const until = async (fn, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(20)
  }
}

/** 跑一个真回合：发一句、等回合结束、等 agent 真的闲下来。 */
async function runTurn(text) {
  const ended = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', () => {
      off()
      resolve()
    })
  })
  ctx.agent.followup(text)
  await ended
  await until(() => !ctx.agent.isRunning(ctx.session.current().filePath))
  await sleep(40)
}

console.log('[7] 端到端：18 轮只注入 2 次（轮号 9 与 17）')
try {
  const TURNS = 18
  for (let turn = 1; turn <= TURNS; turn += 1) await runTurn(`第 ${String(turn)} 轮`)

  const perRequest = bodies.map((messages, index) => ({
    request: index + 1,
    rounds: countRounds(messages),
    reminder: hasReminder(messages),
  }))
  const reminderRequests = perRequest.filter((item) => item.reminder)
  const rounds = reminderRequests.map((item) => item.rounds)

  check('18 轮发出 19 次会话请求（第 1 轮 2 次：带 todo_write 与收尾）', bodies.length === TURNS + 1, String(bodies.length))
  check('只注入 2 次提醒（改前：第 10..19 次请求每跳一条，共 10 次）', reminderRequests.length === 2,
    JSON.stringify(reminderRequests.map((item) => item.request)))
  check('两次注入的轮号是 9 与 17（间隔正好 everyRounds=8）', JSON.stringify(rounds) === '[9,17]', JSON.stringify(rounds))
  check('第 10 次请求（轮号 9）是第一次注入',
    perRequest.find((item) => item.request === 10)?.reminder === true && rounds[0] === 9)
  check('第 18 次请求（轮号 17）是第二次注入', perRequest.find((item) => item.request === 18)?.reminder === true)
  check('中间的 10 轮（第 11..17 次请求）一条都没有',
    perRequest.filter((item) => item.request >= 11 && item.request <= 17).every((item) => item.reminder === false),
    JSON.stringify(perRequest.filter((item) => item.request >= 11 && item.request <= 17).map((item) => item.reminder)))
  check('首次之前（第 1..9 次请求）一条都没有',
    perRequest.filter((item) => item.request <= 9).every((item) => item.reminder === false))
  check('提醒每次都落在请求末尾（环境快照之后那个位置）',
    reminderRequests.every((item) => {
      const messages = bodies[item.request - 1]
      return messages.at(-1)?.role === 'user' && messages.at(-1)?.content === TODO_REMINDER_TEXT
    }))
  check('注入的正文一字不差',
    reminderRequests.every((item) => bodies[item.request - 1].at(-1)?.content === TODO_REMINDER_TEXT))

  // 不改日志：内存里的会话消息没有提醒；jsonl 里没有把它当成 user / assistant 消息。
  check('会话日志（内存）里没有这条提醒',
    ctx.session.current().messages.some((m) => m.content === TODO_REMINDER_TEXT) === false)
  const records = readFileSync(ctx.session.current().filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
  const asMessage = records.some(
    (record) => (record.type === 'user' || record.type === 'assistant')
      && JSON.stringify(record).includes(TODO_REMINDER_TEXT),
  )
  check('会话 jsonl 里没有把提醒当成消息落盘', asMessage === false, ctx.session.current().filePath)

  // 上报闸没动：正文固定，所以只在第一次注入时记一条注入记录（卡片语义是「这一跳新增了什么」）。
  const injected = records.filter((record) => record.type === 'state' && record.id === 'context-injected')
  const withTodo = injected.filter((record) =>
    (record.payload?.parts ?? []).some((part) => part.kind === 'todo-reminder'))
  check('带 todo-reminder 的注入记录仍是 1 条（上报闸按「内容没变就不记」）', withTodo.length === 1,
    `注入记录共 ${String(injected.length)} 条，其中 todo-reminder ${String(withTodo.length)} 条`)
  check('注入记录里记的是提醒的来源与位置',
    withTodo.every((record) => {
      const part = (record.payload?.parts ?? []).find((item) => item.kind === 'todo-reminder')
      return part.source === 'todo-reminder' && part.where === 'user-tail' && part.preview === TODO_REMINDER_TEXT
    }), JSON.stringify(withTodo[0]?.payload?.parts ?? null))
} finally {
  await ctx.dispose?.()
  server.close()
  server.closeAllConnections?.()
  // 会话状态是异步落盘的：收摊之后再等一拍，别让「删临时 HOME」与最后一次写撞车
  //（撞上就是一条 ENOENT 把整个电池带崩，看起来像断言失败，其实只是清理抢跑）。
  await sleep(500)
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {}
}

console.log('')
if (failures === 0) console.log('todo 节流提醒（按轮）电池：全部通过')
else console.log(`todo 节流提醒（按轮）电池：${failures} 条失败`)
process.exit(failures === 0 ? 0 : 1)
