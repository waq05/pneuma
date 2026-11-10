/**
 * 「展开正在跑的思考，被下一次工具调用/下一段思考抢走」的现场探针（2026-11-10 报障）。
 *
 * 报障形状：任务进行中点开思考过程；模型开始调工具（或开始下一段思考）时，
 * **已展开的那一段自己收起，新的那一段自己展开**。
 *
 * 根因（修之前的代码）：直播条目 id 是「第几个直播段」的负数、定稿又换正数，而行的
 * React key 与展开态存档键都吃 entry.id——于是定稿=重挂+查不到存档（收起），
 * 下一段直播又复用同一个负 id（读到上一条的「展开」→ 自动展开）。
 *
 * 这个探针就造这个形状：假模型第一跳吐一段 reasoning → 调一次 todo_write → 第二跳再吐
 * 一段 reasoning → 正文收工。全程监听 `.think-block` 的状态：
 *
 *   · 第一段（点开的）：工具调用发生时它**必须还开着**（定稿不换身份）；
 *   · 第二段（新来的）：**必须默认收起**（不借用上一段的存档）。
 *
 * 运行：node desktop/shots/_verify-think-identity.mjs
 * 产物：desktop/shots/_think-identity.png（收工时的整屏）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-think-identity-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18997
const debugPort = 9377

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'readme.txt'), '探针用的占位文件。\n')

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-think', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-think', '        name: Fake Think',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
// 思考行不开「默认展开」：这一条探针要验的是「用户点开的那一段不被抢」，不是设置档。
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({ ui: { reasoningDefaultOpen: false } }))

const now = Date.now()
const history = [
  { type: 'meta', id: 'think-identity', cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '先想、再查、再想，最后说一句。', ts: now - 50000 },
]
writeFileSync(join(dsc, 'sessions', 'demo', 'think-identity.jsonl'), history.map((line) => JSON.stringify(line)).join('\n') + '\n')

const THINK_A = '第一段：先确认这段逻辑的分支，再决定查哪一个文件。\n'
const THINK_B = '第二段：工具已经回来了，现在核对结论。\n'

/** 假模型：第一跳「思考 12 口 → 调 todo_write」，第二跳「思考 6 口 → 正文收工」。 */
const server = createServer((req, res) => {
  void (async () => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const messages = (() => {
      try {
        const parsed = JSON.parse(body)
        return Array.isArray(parsed.messages) ? parsed.messages : []
      } catch { return [] }
    })()
    const hasToolResult = messages.some((message) => message.role === 'tool')
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    if (!hasToolResult) {
      for (let index = 0; index < 12; index += 1) {
        delta({ reasoning_content: THINK_A })
        await sleep(100)
      }
      delta({
        tool_calls: [{
          index: 0,
          id: 'call_identity_1',
          type: 'function',
          function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: '核对分支', status: 'completed' }] }) },
        }],
      })
      delta({}, 'tool_calls')
    } else {
      for (let index = 0; index < 6; index += 1) {
        delta({ reasoning_content: THINK_B })
        await sleep(100)
      }
      delta({ content: '查完了，按原计划走。' })
      await sleep(80)
      delta({}, 'stop')
    }
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 200 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-think] ${String(error)}\n`)
    try { res.end() } catch {}
  })
})
server.listen(fakePort, '127.0.0.1')

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
}
delete env.ELECTRON_RUN_AS_NODE

const electron = spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
  join(root, 'desktop/out/main/index.js'), '--remote-debugging-port=' + String(debugPort),
], { cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
electron.stdout.on('data', (d) => { log += String(d) })
electron.stderr.on('data', (d) => { log += String(d) })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const listPages = async () => {
  try {
    const list = await (await fetch('http://127.0.0.1:' + String(debugPort) + '/json/list')).json()
    return (list ?? []).filter((p) => p.type === 'page')
  } catch { return [] }
}

let ws = null
let seq = 0
const pending = new Map()
const send = (method, params) => {
  seq += 1
  const promise = new Promise((resolve, reject) => {
    pending.set(seq, { resolve, reject })
    ws.send(JSON.stringify({ id: seq, method, params }))
  })
  promise.catch(() => {})
  return promise
}
let connected = false
for (let i = 0; i < 80; i += 1) {
  const candidate = (await listPages()).find((p) => String(p.url).startsWith('http'))
  if (candidate) {
    try {
      ws = new WebSocket(candidate.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', reject, { once: true })
      })
      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          const waiter = pending.get(msg.id)
          if (!waiter) return
          pending.delete(msg.id)
          if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)))
          else waiter.resolve(msg.result)
        } catch {}
      })
      await send('Runtime.enable')
      connected = true
      break
    } catch { try { ws.close() } catch {} }
  }
  await sleep(800)
}
if (!connected) throw new Error('connect failed: ' + log.slice(-600))

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression: '(async () => { ' + expression + ' })()',
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800))
  return result.result?.value
}

const started = await evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(250)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '先想、再查、再想，最后说一句。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  const thinkBlocks = () => [...document.querySelectorAll('.think-block')]
  const snap = () => thinkBlocks().map((node) => ({
    live: node.classList.contains('live'),
    open: node.classList.contains('open'),
    summary: (node.querySelector('.think-summary-text')?.textContent ?? '').slice(0, 24),
  }))

  // 等第一段直播思考出现，然后点开它（模拟用户操作）。
  let clicked = false
  for (let i = 0; i < 200; i += 1) {
    const live = thinkBlocks().find((node) => node.classList.contains('live'))
    if (live !== undefined) {
      const head = live.querySelector('.think-head')
      head?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      clicked = true
      break
    }
    await wait(30)
  }
  // 点击到 React 提交有一帧延迟：等一拍再读，否则读到的是点击前的样子。
  await wait(120)
  const afterClick = snap()

  // 采样：从点开那一刻起，每 40ms 记一次所有思考块的状态，直到出现正文收工。
  const samples = []
  for (let i = 0; i < 300; i += 1) {
    samples.push({ t: Date.now(), blocks: snap(), tools: document.querySelectorAll('.tool-card').length })
    if (document.querySelector('.tool-card') !== null
      && thinkBlocks().length >= 2
      && thinkBlocks().every((node) => !node.classList.contains('live'))
      && document.querySelector('.round-foot') !== null) break
    await wait(40)
  }
  return { clicked, afterClick, samples }
`)
console.log('start', JSON.stringify({ clicked: started?.clicked, afterClick: started?.afterClick }).slice(0, 400))

await sleep(1500)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (typeof shot?.data === 'string') writeFileSync(join(shots, '_think-identity.png'), Buffer.from(shot.data, 'base64'))

const report = await evaluate(`
  const samples = ${JSON.stringify(started?.samples ?? [])}
  // 第一段：点开后它必须是开着的；之后工具调用出现（第一段定稿）时，它必须还开着。
  const firstEver = samples.find((s) => s.tools > 0 && s.blocks.length >= 1)
  const firstBlockAtToolTime = firstEver?.blocks[0]
  // 第二段：出现时不能自带 open（不借用上一段的展开存档）。
  let secondFirstSeen = null
  for (const s of samples) {
    if (s.blocks.length >= 2) { secondFirstSeen = s.blocks[1]; break }
  }
  // 收工时两段的状态。
  const last = samples[samples.length - 1]
  return {
    clicks: ${String(Boolean(started?.clicked))},
    afterClick: ${JSON.stringify(started?.afterClick ?? [])},
    firstAtToolTime: firstBlockAtToolTime ?? null,
    secondFirstSeen: secondFirstSeen,
    finalBlocks: last?.blocks ?? [],
    toolSeen: samples.some((s) => s.tools > 0),
  }
`)

const failures = []
if (report.clicks !== true) failures.push('没点到第一段直播思考（探针没造出现场）')
if (report.afterClick?.[0]?.open !== true) failures.push('点开之后第一段不是展开态')
if (report.firstAtToolTime === null) failures.push('工具调用到来时没采到第一段')
else if (report.firstAtToolTime.open !== true) failures.push('工具调用（第一段定稿）之后，第一段被收起了 —— 这就是报障')
else if (report.firstAtToolTime.live === true) failures.push('工具调用之后第一段还是 live（定稿没发生，探针时序不对）')
if (report.secondFirstSeen === null) failures.push('没采集到第二段思考')
else if (report.secondFirstSeen.open === true) failures.push('第二段思考出现的瞬间是展开的 —— 借用了上一段的存档')

console.log('report', JSON.stringify(report))
console.log(failures.length === 0 ? 'PASS 直播思考的展开态跨过了「工具调用 / 下一段思考」' : 'FAIL ' + failures.join('; '))

try { electron.kill() } catch {}
server.close()
process.exit(failures.length === 0 ? 0 : 1)
