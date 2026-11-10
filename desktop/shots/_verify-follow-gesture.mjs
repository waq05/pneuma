process.on('unhandledRejection', () => {})

/**
 * 「自动跟随有没有掉线、该松手时会不会松手」的行为验收（2026-11-10）。
 *
 * 三段实验，缺一不算过：
 *   P **没有手势的滚动不算读者**：把 scrollTop 直接改到 0（模拟排版滞后 / 夹持那种
 *     「自己变的位置」），跟随必须原地补钉底、胶囊不许亮。
 *   W **真手势必须松手**：发真的滚轮往上（CDP 输入管线，会产出 wheel + scroll + scrollend），
 *     胶囊必须亮起来。
 *   R **点胶囊回到底部**：胶囊消失、离底 ≤ 24px。
 *
 * 另外全程采样，断言跑动过程中胶囊一次都不亮（上一轮的报障形态）。
 *
 * 运行：node desktop/shots/_verify-follow-gesture.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-gesture-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18996
const debugPort = 9383

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
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({ ui: { processFold: 'verbose' } }))

const now = Date.now()
const sessionFile = join(dsc, 'sessions', 'demo', 'gesture-demo.jsonl')
writeFileSync(sessionFile, [
  { type: 'meta', id: 'gesture-demo', cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '跑一轮长的，我要验跟随。', ts: now - 50000 },
].map((line) => JSON.stringify(line)).join('\n') + '\n')

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
  DSC_RESUME_SESSION: sessionFile,
  FOLD_FAKE_TOOLS: '8',
  FOLD_FAKE_TAIL_MS: '6000',
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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 1200))
  return result.result?.value
}

await send('Emulation.setDeviceMetricsOverride', { width: 1423, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(600)

const READ = `
  const chat = [...document.querySelectorAll('.chat')].find((node) => node.closest('.thread-main, .thread-main-empty') !== null)
  const pill = [...document.querySelectorAll('.chat-to-bottom')].some((node) => node.closest('.thread-main, .thread-main-empty') !== null && node.getBoundingClientRect().height > 0)
  const slack = chat.scrollHeight - chat.clientHeight
  return {
    top: Math.round(chat.scrollTop),
    slack,
    gap: Math.round(slack - chat.scrollTop),
    pill,
    box: (() => { const r = chat.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })(),
  }
`

const started = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.composer textarea') !== null && document.querySelector('.entry-user') !== null) break
    await wait(250)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '跑一轮长的，我要验跟随。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  // 全程盯胶囊：跑动中它一次都不许自己亮。
  window.__pills = 0
  const sample = () => {
    const pill = [...document.querySelectorAll('.chat-to-bottom')]
      .some((node) => node.closest('.thread-main, .thread-main-empty') !== null && node.getBoundingClientRect().height > 0)
    if (pill) window.__pills += 1
  }
  window.__pillTimer = window.setInterval(sample, 40)
  return { sent: true }
`)
console.log('start', JSON.stringify(started))

// 等内容长过一屏。
let ready = null
for (let i = 0; i < 40; i += 1) {
  await sleep(500)
  ready = await evaluate(READ)
  if (ready.slack > 400) break
}
console.log('ready', JSON.stringify(ready))
// 先把「跑动中自己亮」这一项读出来并停表：后面 P/W/R 是**故意**让它亮的，不能混算。
const pillsDuringRun = await evaluate('window.clearInterval(window.__pillTimer); return window.__pills')

/* ── P：没有手势的滚动不算读者 ── */
await evaluate(`
  const chat = [...document.querySelectorAll('.chat')].find((node) => node.closest('.thread-main, .thread-main-empty') !== null)
  chat.scrollTop = 0
  return true
`)
await sleep(700)
const phaseP = await evaluate(READ)
console.log('P-noGesture', JSON.stringify(phaseP))

/* ── W：真滚轮往上，必须松手 ── */
for (let i = 0; i < 4; i += 1) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: phaseP.box.x, y: phaseP.box.y, deltaX: 0, deltaY: -140, modifiers: 0,
  })
  await sleep(80)
}
await sleep(900)
const phaseW = await evaluate(READ)
console.log('W-gesture', JSON.stringify(phaseW))

/* ── R：点胶囊回到底部 ── */
await evaluate(`
  const pill = [...document.querySelectorAll('.chat-to-bottom')]
    .find((node) => node.closest('.thread-main, .thread-main-empty') !== null && node.getBoundingClientRect().height > 0)
  if (pill !== undefined) pill.click()
  return true
`)
await sleep(900)
const phaseR = await evaluate(READ)
console.log('R-resume', JSON.stringify(phaseR))

const pillsEnd = await evaluate('return window.__pills')

const failed = []
if (phaseP.pill) failed.push('没有手势的滚动也把跟随松掉了（胶囊亮了）')
if (phaseP.gap > 24) failed.push(`没有手势的滚动之后没补回底部：还差 ${String(phaseP.gap)}px`)
if (!phaseW.pill) failed.push('真滚轮往上之后胶囊没亮（该松手时没松手）')
if (phaseR.pill) failed.push('点了胶囊之后胶囊还在')
if (phaseR.gap > 24) failed.push(`点胶囊之后没贴底：还差 ${String(phaseR.gap)}px`)
if (pillsEnd > 2) failed.push(`跑动中胶囊自己亮了 ${String(pillsEnd)} 次`)

console.log('pillsDuringRun', pillsDuringRun, 'pillsTotal', pillsEnd)
console.log(failed.length === 0 ? 'PASS 三段全过' : `FAIL ${failed.join('；')}`)

try { ws.close() } catch {}
try { electron.kill() } catch {}
try { fake.kill() } catch {}
await sleep(500)
process.exit(failed.length === 0 ? 0 : 1)
