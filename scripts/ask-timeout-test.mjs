/**
 * 提问卡的等待时限（2026-10-29 报障：ask_user 超时后用户再答，对话不动）。
 *
 * 钉两件事：
 *   ① 等人的时间不算 PTC 脚本的时间：脚本里 `await sdk.ask_user(...)` 挂起超过脚本时限，
 *      脚本仍然活着；用户答完后脚本拿到答案正常返回（以前 120 秒先把脚本掐死，
 *      答案回来没人接，正文里只留一句「脚本跑了超过 120 秒」）。
 *   ② 提问卡有自己的等待时限（配置 `ask.waitMs`，默认 15 分钟、夹在 10 秒~1 小时）：
 *      等满了自己收尾——卡片撤掉、模型拿到「用户没有回答」的实话，接着往下走。
 *
 * 隔离：临时 HOME + 临时工作区，真实 ~/.dsc 一个字节不动；不连真模型。
 * 运行：pnpm build && node scripts/ask-timeout-test.mjs
 *
 * @module dsc/scripts/ask-timeout-test
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-ask-timeout-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dsc = join(home, '.dsc')
mkdirSync(dsc, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 等待时限给一个比下限还小的值：探针要验「夹到 10 秒」，同时别真等 15 分钟。
writeFileSync(
  join(dsc, 'plugins.json'),
  JSON.stringify({ version: 1, entries: [{ file: 'ask', config: { waitMs: 1000 } }] }, null, 2),
  'utf8',
)
const cwd = join(home, 'ws')
mkdirSync(cwd, { recursive: true })

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
const until = async (fn, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(20)
  }
}

const { createKernel } = await import('../lib/host/kernel.js')
const { PTC_LIMITS } = await import('../lib/core/ptc.js')

const kernel = await createKernel({ config: {} })
const ask = kernel.get('ask')
const session = kernel.get('session')
const tools = kernel.get('tools')
const runCode = tools.list().find((entry) => entry.name === 'run_code')
const askTool = tools.list().find((entry) => entry.name === 'ask_user')
/** run_code 的回包可能是字符串，也可能是 `{ text }` 对象：探针统一取正文。 */
const asText = (result) => (typeof result === 'string' ? result : String(result?.text ?? ''))

const runCtx = () => ({
  cwd,
  signal: new AbortController().signal,
  sessionId: session.current().meta.id,
  sessionPath: session.current().filePath,
})

console.log('\n[1] 提问卡的等待时限来自 ask.waitMs，且夹在 10 秒~1 小时')
{
  // 配置里写的是 1000ms（1 秒），下限 10 秒，所以对外读数是 10 秒
  check('工具描述里写的是夹过之后的读数（10 秒）', askTool.description.includes('10 秒'), askTool.description.slice(-160))
  check('描述里点明了「没回答」不是用户的答案', askTool.description.includes('不是用户说的话'))
  check('ask_user 声明了自己是在等人（PTC 靠这一位停表）', askTool.waitsForHuman === true)
}

console.log('\n[2] 脚本里等提问卡：等人的时间不算脚本时限')
{
  const original = PTC_LIMITS.deadlineMs
  // 真值是 120 秒，等它不现实：探针把时限调到 300ms，等价性靠「结构相同」保证
  PTC_LIMITS.deadlineMs = 300
  const running = runCode.run(
    { code: "const a = await sdk.ask_user({ questions: [{ question: '选哪个' }] }); return a" },
    runCtx(),
  )
  const appeared = await until(() => ask.pendingQuestion() !== null)
  check('提问卡挂起来了', appeared)
  await sleep(800) // 已经超过脚本时限两倍多
  check('脚本时限没有在半路掐断它（卡还挂着）', ask.pendingQuestion() !== null)
  await ask.answerQuestion('我选 B')
  // 2026-10-30 起 run_code 的回包是对象（`{ text, changesList? }`：一次脚本可能改多个文件），
  // 纯文本时也走对象形状，所以这里先取正文再断言。
  const text = asText(await running)
  check('答完之后脚本拿到答案，正常返回', text.includes('我选 B'), text.slice(0, 200))
  check('结果里没有被掐断的记录', !text.includes('被掐断'))
  check('答完之后卡片撤掉了', ask.pendingQuestion() === null)

  // 反例：不等人时，脚本自己拖时间照样会被掐断（停表不是把时限关了）
  PTC_LIMITS.deadlineMs = 200
  const killed = asText(await runCode.run({ code: "await sleep(600); return 'ok'" }, runCtx()))
  check('不等人时按脚本时限掐断', killed.includes('被掐断'), killed.slice(0, 120))
  PTC_LIMITS.deadlineMs = original
}

console.log('\n[3] 等满时限：卡片撤掉，模型拿到「没回答」的实话')
{
  const startedAt = Date.now()
  const pending = ask.askMany(
    [{ question: '还在吗', options: [], multiSelect: false, allowFreeText: true }],
    new AbortController().signal,
  )
  const appeared = await until(() => ask.pendingQuestion() !== null)
  check('提问卡挂起来了', appeared)
  const answers = await pending
  const waited = Date.now() - startedAt
  check('等满 10 秒才收尾（下限生效）', waited >= 9500 && waited < 15000, `等了 ${waited}ms`)
  check('交回的是「没回答」的实话', String(answers[0]).includes('用户没有回答'), String(answers[0]))
  check('实话里写了等多久', String(answers[0]).includes('10 秒'), String(answers[0]))
  check('卡片在界面上撤掉了（不留幽灵卡）', ask.pendingQuestion() === null)
}

console.log('\n[4] 时限内作答：照旧一次交回，卡片撤掉')
{
  const pending = ask.askMany(
    [{ question: '走哪条路', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, allowFreeText: true }],
    new AbortController().signal,
  )
  await until(() => ask.pendingQuestion() !== null)
  ask.answerQuestion('B')
  const answers = await pending
  check('拿到用户的答案', answers[0] === 'B', String(answers[0]))
  await sleep(500) // 若计时器没撤掉，这里会出现二次收尾
  check('收尾之后卡片仍然撤掉、没有二次收尾', ask.pendingQuestion() === null)
}

await kernel.dispose?.()
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`)
process.exit(failures === 0 ? 0 : 1)
