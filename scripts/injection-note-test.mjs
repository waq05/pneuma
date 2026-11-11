/**
 * 投影注入留底探针：两条提醒（重复调用 / 待办节流）真的拼进请求时，必须同时
 * `appendNote` 落一条 note（`src/packages/session-core/loop.ts:77` 的规矩：
 * 往请求里注入日志上没有的内容，注入方自己留底）。
 *
 * 为什么用真内核：投影注册在插件 `apply` 里，纯函数测不到「有没有调 appendNote」。
 * 这里在临时 `DSC_HOME` 上装完整内核，直接调 `ctx.prompt.rewrite` 跑真投影链，
 * 再看会话的 `notes()` 与 jsonl——**把两处 appendNote 删掉，本探针必须红**。
 *
 * 断言：
 *   1. 重复调用：前两次同参调用不注入、不落 note；第三次命中阈值，请求末尾多一句，
 *      同时落一条 `repeat-reminder` note，正文与注入原文逐字相同；
 *   2. 待办：间隔调成 1 轮后，第一轮就注入 `todo-reminder`，同时落一条同名 note；
 *      请求里已经有这句提醒（幂等拒绝注入）时不重复落；清单清空后不落；
 *   3. 两条 note 都写进了会话 jsonl，且 id 各用自己的名字（没有复用 lsp / hooks 的）。
 *
 * 用法：pnpm run build && node scripts/injection-note-test.mjs
 *
 * @module dsc/scripts/injection-note-test
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-injection-note-'))
process.env.DSC_HOME = join(home, '.dsc')
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(process.env.DSC_HOME, { recursive: true })
writeFileSync(join(process.env.DSC_HOME, 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 关掉长期记忆：它会在回合收尾投递通知，混进这一轮的请求体。
writeFileSync(
  join(process.env.DSC_HOME, 'plugins.json'),
  JSON.stringify({ version: 1, entries: [{ file: 'memory', config: { enabled: false } }] }, null, 2),
  'utf8',
)

const { TODO_REMINDER_TEXT } = await import('../lib/core/todo-reminder.js')
const { planRepeatReminder } = await import('../lib/core/repeat-reminder.js')
const { createKernel } = await import('../lib/host/kernel.js')

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
}

const kernel = await createKernel({ config: {}, resumeSessionPath: null })
const session = kernel.session.current()
const notesOf = (id) => session.notes().filter((note) => note.id === id)
const textOf = (message) =>
  typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('')

/** 造一次同参工具调用（消息形态与真会话一致：assistant 带 tool_calls + 一条 tool 结果）。 */
const appendCall = (n) => {
  const id = `call_${String(n)}`
  session.appendAssistant('', '', [{ id, name: 'read', arguments: '{"path":"README.md"}' }])
  session.appendTool(id, 'read', `第 ${String(n)} 次结果`)
}

const base = [{ role: 'system', content: '系统提示（探针）' }]

console.log('[1] 重复调用提醒：真注入了才落 note')
{
  session.appendUser('把这件事办完。')
  appendCall(1)
  appendCall(2)
  const before = planRepeatReminder(session.messages)
  check('前两次同参调用不算重复（count=2，不提醒）', before.remind === false && before.count === 2, `remind=${String(before.remind)} count=${String(before.count)}`)

  const quiet = kernel.prompt.rewrite(base, session)
  check('没到阈值时不注入提醒', !quiet.some((message) => message.role === 'user' && textOf(message) === before.text && before.text !== ''))
  check('没注入就不落 repeat-reminder note', notesOf('repeat-reminder').length === 0, JSON.stringify(session.notes()))

  appendCall(3)
  const plan = planRepeatReminder(session.messages)
  check('第三次命中的是第 1 档（准备条件）', plan.remind === true && plan.tier === 1 && plan.text !== '', JSON.stringify(plan))
  const sent = kernel.prompt.rewrite(base, session)
  check(
    '第三次请求末尾真的多了提醒原文',
    sent.length > base.length && sent[sent.length - 1]?.role === 'user' && textOf(sent[sent.length - 1]) === plan.text,
    JSON.stringify(sent.slice(-1)),
  )
  const notes = notesOf('repeat-reminder')
  check('同时落了一条 repeat-reminder note', notes.length === 1, JSON.stringify(session.notes().map((note) => note.id)))
  check('note 正文就是注入原文（能回看当时注了什么）', notes[0]?.text === plan.text, String(notes[0]?.text))
  check('note 用的是自己的名字，没复用别人的 id', notes[0]?.id === 'repeat-reminder', String(notes[0]?.id))

  // 同一份历史再跑一遍（循环在请求发出前拿它做 invariant 校验，`loop.ts:452`）：
  // 那一次并没有发给模型，不该多记一条 note。
  kernel.prompt.rewrite(base, session)
  check('同一份历史的二次派生不重复落 note', notesOf('repeat-reminder').length === 1, String(notesOf('repeat-reminder').length))
}

console.log('[2] 待办提醒：真注入了才落 note，幂等与清空都不落')
{
  await kernel.settings.save('todo', 'everyRounds', 1)
  kernel.todo.writeTodos([{ content: '修掉登录 bug', status: 'pending' }], false)
  const messages = [...base, { role: 'user', content: '接着做。' }, { role: 'assistant', content: '好。' }]
  const sent = kernel.prompt.rewrite(messages, session)
  check(
    '间隔调成 1 轮后第一轮请求里就有待办提醒',
    sent.some((message) => message.role === 'user' && textOf(message) === TODO_REMINDER_TEXT),
    JSON.stringify(sent.map(textOf).slice(-3)),
  )
  const notes = notesOf('todo-reminder')
  check('同时落了一条 todo-reminder note', notes.length === 1, JSON.stringify(session.notes().map((note) => note.id)))
  check('note 正文就是提醒原文', notes[0]?.text === TODO_REMINDER_TEXT, String(notes[0]?.text))
  check('note 用自己的名字，没复用别人的 id', notes[0]?.id === 'todo-reminder', String(notes[0]?.id))

  // 幂等：请求里已经带着这句提醒 → appendTodoReminder 原样返回，不注入也不再落 note。
  const already = [
    ...messages,
    { role: 'assistant', content: '继续。' },
    { role: 'user', content: TODO_REMINDER_TEXT },
  ]
  kernel.prompt.rewrite(already, session)
  check('请求里已经有提醒时不再重复落 note', notesOf('todo-reminder').length === 1, String(notesOf('todo-reminder').length))

  // 清单清空 → 没有未完成项，不注入也不落 note。
  kernel.todo.clearTodos()
  const afterClear = [...already, { role: 'assistant', content: '收工。' }]
  kernel.prompt.rewrite(afterClear, session)
  check('清单清空后不再落 todo-reminder note', notesOf('todo-reminder').length === 1, String(notesOf('todo-reminder').length))
}

console.log('[3] 两条 note 都落进了会话 jsonl')
{
  // 写盘走流（createWriteStream），给它一拍把最后几条刷出去再读文件。
  await new Promise((resolve) => setTimeout(resolve, 400))
  const records = readFileSync(session.filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const noteRecords = records.filter((record) => record.type === 'note')
  check('jsonl 里有 repeat-reminder note', noteRecords.some((record) => record.id === 'repeat-reminder'), JSON.stringify(noteRecords.map((record) => record.id)))
  check('jsonl 里有 todo-reminder note', noteRecords.some((record) => record.id === 'todo-reminder'), JSON.stringify(noteRecords.map((record) => record.id)))
  check(
    '两条 note 没有借用 lsp / hooks 的 id',
    !noteRecords.some((record) => record.id === 'lsp-write-diagnostics' || record.id === 'lifecycle-hooks'),
    JSON.stringify(noteRecords.map((record) => record.id)),
  )
}

try {
  await kernel.dispose()
} catch {
  // 收尾失败不影响结论
}
if (failures === 0) rmSync(home, { recursive: true, force: true })
console.log('')
if (failures === 0) console.log('投影注入留底探针：全部通过')
else console.log(`投影注入留底探针：${String(failures)} 条失败（临时 HOME 留在 ${home} 供排查）`)
process.exit(failures === 0 ? 0 : 1)
