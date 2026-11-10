process.on('unhandledRejection', () => {})

/**
 * #2「任务进行中上下抽搐、能滚进空白」的现场取证（2026-11-09 报障）。
 *
 * 假模型一轮里会吐「思考 → 正文 → 工具卡 → 思考 → 正文」（见 fold-fake-llm.mjs），
 * 于是过程区会真的长出思考行、工具卡与阶段组，和用户截图里的形状一致。
 *
 * 每 60ms 采一次样，记三样东西：
 *   · `.chat` 的 scrollTop / scrollHeight / clientHeight（滚动余量 = 能滚进多少空白）；
 *   · **第一条用户消息在屏幕上的 y**（它不该动；动了就是抽搐）；
 *   · 阶段组体的高度（组收口 / 展开会改高度，是抽搐的常见来源）。
 *
 * 输出：位置翻转次数、最大滚动余量、余量最大的那一刻的现场。
 *
 * 运行：node desktop/shots/_verify-jitter.mjs [宽] [高]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-jitter-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18993
const debugPort = 9371
const width = Number(process.argv[2] ?? 1100)
const height = Number(process.argv[3] ?? 1200)

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-fold', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-fold', '        name: Fake Fold',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

const now = Date.now()
writeFileSync(join(dsc, 'sessions', 'demo', 'jitter-demo.jsonl'), [
  { type: 'meta', id: 'jitter-demo', cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '这是一条用来量位置的用户消息，跑起来之后它会一直往上走。', ts: now - 50000 },
  { type: 'assistant', text: '好，我先读两个文件看看。', reasoning: '', ts: now - 40000 },
].map((line) => JSON.stringify(line)).join('\n') + '\n')

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
  FOLD_FAKE_TOOLS: '6',
}
delete env.ELECTRON_RUN_AS_NODE

const fake = spawn(process.execPath, [join(shots, 'fold-fake-llm.mjs'), String(fakePort)], { env, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 900))
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

await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
await sleep(500)

const started = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.composer textarea') !== null && document.querySelector('.entry-user') !== null) break
    await wait(250)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '跑一轮，我要看位置会不会抖。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(120)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  const chat = document.querySelector('.chat')
  const anchorRow = document.querySelector('.entry-user')
  const samples = []
  const timer = window.setInterval(() => {
    const groups = [...document.querySelectorAll('.step-group-body')].map((node) => Math.round(node.getBoundingClientRect().height))
    samples.push({
      t: Math.round(performance.now()),
      top: Math.round(chat.scrollTop),
      sh: Math.round(chat.scrollHeight),
      ch: Math.round(chat.clientHeight),
      anchor: anchorRow === null ? null : Math.round(anchorRow.getBoundingClientRect().top),
      groups,
      status: document.querySelector('.turn-status') !== null,
    })
  }, 60)
  window.__jitter = { timer, samples }
  return { sent: true }
`)
console.log('start', JSON.stringify(started))
await sleep(9000)

const report = await evaluate(`
  window.clearInterval(window.__jitter.timer)
  const list = window.__jitter.samples
  const anchors = list.map((s) => s.anchor).filter((v) => v !== null)
  let flips = 0
  let dir = 0
  for (let i = 1; i < anchors.length; i += 1) {
    const step = Math.sign(anchors[i] - anchors[i - 1])
    if (step !== 0 && dir !== 0 && step !== dir) flips += 1
    if (step !== 0) dir = step
  }
  const slack = list.map((s) => s.sh - s.ch)
  const worst = slack.indexOf(Math.max(...slack))
  const chat = document.querySelector('.chat')
  return {
    n: list.length,
    anchorFlips: flips,
    anchorMin: anchors.length === 0 ? null : Math.min(...anchors),
    anchorMax: anchors.length === 0 ? null : Math.max(...anchors),
    slackMax: Math.max(...slack),
    worstSample: list[worst],
    final: { sh: chat.scrollHeight, ch: chat.clientHeight, top: Math.round(chat.scrollTop) },
    last8: list.slice(-8),
  }
`)
console.log('jitter', JSON.stringify(report, null, 1))

const data = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(shots, '_jitter-after.png'), Buffer.from(data.data, 'base64'))

try { ws.close() } catch {}
try { electron.kill() } catch {}
try { fake.kill() } catch {}
await sleep(500)
process.exit(0)

