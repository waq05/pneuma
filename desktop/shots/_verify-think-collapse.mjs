/**
 * #2「思考先撑出一大块、跑完迅速收起、收起后空白没收走」的现场取证。
 *
 * 用户 2026-11-10 的描述给了明确的形状：跑动中过程区是展开的（整轮不折叠），
 * 思考流式长出来一大块；这一轮结束时整轮过程区收起（`.turn-process[data-fold='closed']`
 * → `grid-template-rows: 0fr`，180ms），内容一下矮掉几百像素。
 *
 * 这个探针就照这个形状造：假模型先吐 2.5 秒的 reasoning（一大块），再吐一句正文收工。
 * 全程 50ms 采样，并**每 25ms 读一次**「最后一条内容的底边到滚动容器底边还有多远」。
 *
 * 判据：
 *   · 跑动中是否出现「位置往回走」（抽搐 = 同一条内容的屏幕位置反复上下）；
 *   · 收工后 gap 是否还 > 8px 且 slack > 8px（= 能往下滚进空白）。
 *
 * 运行：node desktop/shots/_verify-think-collapse.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-think-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18995
const debugPort = 9373

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-think', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-think', '        name: Fake Think',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

const now = Date.now()
// 历史先垫三轮回合，把正文垫得比视口高——用户报障时的会话都是这种长会话，
// 只有内容超过一屏，「收走几百像素之后留不留空白」才量得出来。
const longText = Array.from({ length: 14 }, (_, i) => `第 ${String(i + 1)} 条明细：这一行只是把正文垫高，用来让对话超过一屏。`).join('\n\n')
const history = [
  { type: 'meta', id: 'think-demo', cwd: work, createdAt: now - 600000 },
  { type: 'user', text: '先想很久，再给我一句话。', ts: now - 590000 },
]
for (let round = 0; round < 12; round += 1) {
  history.push({ type: 'assistant', text: `第 ${String(round + 1)} 轮回答：\n\n${longText}`, reasoning: '', ts: now - 580000 + round * 1000 })
  history.push({ type: 'user', text: `继续，第 ${String(round + 2)} 个问题。`, ts: now - 575000 + round * 1000 })
}
writeFileSync(join(dsc, 'sessions', 'demo', 'think-demo.jsonl'), history.map((line) => JSON.stringify(line)).join('\n') + '\n')
// 「定稿的思考行默认展开」打开：跑动中思考块是摊开的（用户描述的那一态）。
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({ ui: { reasoningDefaultOpen: true } }))

/** 假模型：先吐 25 段 reasoning（一大块），再吐一句正文收工。 */
const THINK_LINE = '我在核对这段逻辑的每个分支，先把边界条件摆出来再看主流程，别急着下结论。\n'
const server = createServer((req, res) => {
  void (async () => {
    for await (const _chunk of req) { /* 读完请求体 */ }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 25; i += 1) {
      delta({ reasoning_content: THINK_LINE })
      await sleep(100)
    }
    delta({ content: '想完了，一句话：按原计划走。' })
    await sleep(80)
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 900 } })
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(250)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '先想很久，再给我一句话。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  const chat = document.querySelector('.chat')
  const inner = document.querySelector('.chat-inner')
  /**
   * 最后一条「真占高度」的内容的底边。
   *
   * 不能直接取 .chat-inner 的最后一个子节点：条目外面套着 .slot-entry，它是
   * display: contents（盒子恒为 0 高、位置还是负的），量它会得到假数（第一版探针就
   * 栽在这上面）。这里改成遍历所有子孙，挑出真的有高度、最靠下的那一个。
   */
  const lastVisibleBottom = () => {
    let bottom = null
    for (const node of inner.querySelectorAll('*')) {
      const rect = node.getBoundingClientRect()
      if (rect.height <= 0 || rect.width <= 0) continue
      if (bottom === null || rect.bottom > bottom) bottom = rect.bottom
    }
    return bottom
  }
  const samples = []
  const read = () => {
    const chatBox = chat.getBoundingClientRect()
    const bottom = lastVisibleBottom()
    const innerBox = inner === null ? null : inner.getBoundingClientRect()
    const process = document.querySelector('.turn-process')
    return {
      t: Math.round(performance.now()),
      top: Math.round(chat.scrollTop),
      sh: chat.scrollHeight,
      ch: chat.clientHeight,
      gapBelow: bottom === null ? null : Math.round(chatBox.bottom - bottom),
      /** 正文列（.chat-inner，真盒子）底边到滚动区底边：内容不足一屏时它就是「空白」的高度。 */
      innerGap: innerBox === null ? null : Math.round(chatBox.bottom - innerBox.bottom),
      status: document.querySelector('.turn-status') !== null,
      fold: process === null ? null : (process.getAttribute('data-fold') ?? 'open'),
      procH: process === null ? null : Math.round(process.getBoundingClientRect().height),
      thinkH: (() => {
        const think = document.querySelector('.think-block')
        return think === null ? null : Math.round(think.getBoundingClientRect().height)
      })(),
    }
  }
  const timer = window.setInterval(() => samples.push(read()), 50)
  window.__think = { timer, samples, read, chat }
  return { sent: true }
`)
console.log('start', JSON.stringify(started))

await sleep(12000)

const report = await evaluate(`
  window.clearInterval(window.__think.timer)
  const list = window.__think.samples
  const after = window.__think.read()
  const gaps = list.map((s) => s.gapBelow).filter((v) => v !== null)
  let flips = 0
  let dir = 0
  for (let i = 1; i < gaps.length; i += 1) {
    const step = Math.sign(gaps[i] - gaps[i - 1])
    if (step !== 0 && dir !== 0 && step !== dir) flips += 1
    if (step !== 0) dir = step
  }
  const slacks = list.map((s) => s.sh - s.ch)
  // 找「过程区从展开变收起」前后那几帧，看高度与滚动位置怎么走。
  const firstClosed = list.findIndex((s) => s.fold === 'closed')
  const around = firstClosed <= 0 ? [] : list.slice(Math.max(0, firstClosed - 4), firstClosed + 8)
  return {
    n: list.length,
    gapFlips: flips,
    gapMin: gaps.length === 0 ? null : Math.min(...gaps),
    gapMax: gaps.length === 0 ? null : Math.max(...gaps),
    slackMax: Math.max(...slacks),
    procHMax: Math.max(...list.map((s) => s.procH ?? 0)),
    innerGapLast: list.length === 0 ? null : list[list.length - 1].innerGap,
    innerGapMax: Math.max(...list.map((s) => s.innerGap ?? 0)),
    around: around.map((s) => ({ t: s.t, top: s.top, sh: s.sh, ch: s.ch, gap: s.gapBelow, innerGap: s.innerGap, fold: s.fold, procH: s.procH, thinkH: s.thinkH, status: s.status })),
    after,
  }
`)
console.log('report', JSON.stringify(report, null, 1))

const data = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(shots, '_think-collapse-after.png'), Buffer.from(data.data, 'base64'))

// 收工之后再量一次「能不能往下滚进空白」。
const scrollTest = await evaluate(`
  const chat = document.querySelector('.chat')
  const before = chat.scrollTop
  chat.scrollTop = chat.scrollHeight
  await new Promise((r) => setTimeout(r, 200))
  return {
    slack: chat.scrollHeight - chat.clientHeight,
    before: Math.round(before),
    afterSet: Math.round(chat.scrollTop),
    moved: Math.round(chat.scrollTop - before),
  }
`)
console.log('scrollTest', JSON.stringify(scrollTest))

try { ws.close() } catch {}
try { electron.kill() } catch {}
try { server.close() } catch {}
await sleep(500)
process.exit(0)

