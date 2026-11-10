process.on('unhandledRejection', () => {})

/**
 * #2「跑动中、工具调用与思考落在**第三层级**（阶段组体 `.step-body`）里时出现空白」的取证。
 *
 * 三层折叠结构（与 dsh 同款）：
 *   1 整轮开关 `.turn-fold`（「已完成，用时 X」）
 *   2 阶段组头 `.step-fold`（「执行了命令，已读取文件…」）
 *   3 阶段组体 `.step-body`（逐条思考 / 命令 / 读取，`max-height: min(400px, 50vh)` + 自滚）
 *
 * 假模型（fold-fake-llm.mjs，FOLD_FAKE_TOOLS 张工具卡）正好把第 3 层塞满。
 * 全程 50ms 采样，量的是：
 *   · `.step-body` 的 clientHeight / scrollHeight（第 3 层自己滚不滚得动、有没有空白）；
 *   · 正文列 `.chat-inner` 底边到滚动区底边的距离（`innerGap`，内容不足一屏时的空白高度）；
 *   · `.chat` 的 slack 与 scrollTop（外层还能不能往下滚）。
 *
 * 运行：node desktop/shots/_verify-level3.mjs [宽] [高]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-level3-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18997
const debugPort = 9377
const width = Number(process.argv[2] ?? 1423)
const height = Number(process.argv[3] ?? 900)

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
// 思考默认展开 + 过程区用 verbose 档（组体默认摊开），这样第三层是真的露出来的那一态。
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({ ui: { reasoningDefaultOpen: true, processFold: 'verbose' } }))

const now = Date.now()
const sessionFile = join(dsc, 'sessions', 'demo', 'level3-demo.jsonl')
writeFileSync(sessionFile, [
  { type: 'meta', id: 'level3-demo', cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '跑一轮：多读几个文件，我要看第三层的折叠。', ts: now - 50000 },
].map((line) => JSON.stringify(line)).join('\n') + '\n')

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
  DSC_RESUME_SESSION: sessionFile,
  FOLD_FAKE_TOOLS: '8',
  FOLD_FAKE_TAIL_MS: '2500',
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
await sleep(600)

const started = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.composer textarea') !== null && document.querySelector('.entry-user') !== null) break
    await wait(250)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '跑一轮：多读几个文件，我要看第三层的折叠。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  const chat = document.querySelector('.chat')
  const inner = document.querySelector('.chat-inner')
  const samples = []
  const read = () => {
    const chatBox = chat.getBoundingClientRect()
    const innerBox = inner === null ? null : inner.getBoundingClientRect()
    const body = document.querySelector('.step-body')
    const bodyBox = body === null ? null : body.getBoundingClientRect()
    // 组体里最后一条真内容的底边：它要是离组体底边很远，就是「第三层自己留了空白」。
    let lastRowBottom = null
    if (body !== null) {
      for (const node of body.querySelectorAll('.entry-row, .think-block, .tool-row')) {
        const rect = node.getBoundingClientRect()
        if (rect.height <= 0) continue
        if (lastRowBottom === null || rect.bottom > lastRowBottom) lastRowBottom = rect.bottom
      }
    }
    return {
      t: Math.round(performance.now()),
      top: Math.round(chat.scrollTop),
      sh: chat.scrollHeight,
      ch: chat.clientHeight,
      innerGap: innerBox === null ? null : Math.round(chatBox.bottom - innerBox.bottom),
      bodyH: bodyBox === null ? null : Math.round(bodyBox.height),
      bodyScroll: body === null ? null : body.scrollHeight - body.clientHeight,
      bodyTop: body === null ? null : Math.round(body.scrollTop),
      bodyBottomGap: bodyBox === null || lastRowBottom === null ? null : Math.round(bodyBox.bottom - lastRowBottom),
      fold: (() => {
        const node = document.querySelector('.turn-process')
        return node === null ? null : (node.getAttribute('data-fold') ?? 'open')
      })(),
      status: document.querySelector('.turn-status') !== null,
      pill: [...document.querySelectorAll('.chat-to-bottom')].some((node) => node.closest('.thread-main, .thread-main-empty') !== null && node.getBoundingClientRect().height > 0),
      steps: document.querySelectorAll('.step-seat').length,
      rows: document.querySelectorAll('.step-body .entry-row').length,
    }
  }
  const timer = window.setInterval(() => samples.push(read()), 50)
  window.__l3 = { timer, samples, read }
  return { sent: true }
`)
console.log('start', JSON.stringify(started))
await sleep(11000)

const report = await evaluate(`
  window.clearInterval(window.__l3.timer)
  const list = window.__l3.samples
  const innerGaps = list.map((s) => s.innerGap).filter((v) => v !== null)
  const bodyH = list.map((s) => s.bodyH).filter((v) => v !== null)
  const withBody = list.filter((s) => s.bodyH !== null)
  const scrollable = list.filter((s) => s.sh - s.ch > 24)
  const pinned = scrollable.filter((s) => s.sh - s.ch - s.top <= 24)
  return {
    n: list.length,
    scrollableSamples: scrollable.length,
    pinnedSamples: pinned.length,
    pillSamples: list.filter((s) => s.pill).length,
    tailGaps: list.slice(-6).map((s) => ({ t: s.t, top: s.top, slack: s.sh - s.ch, pill: s.pill })),
    stepsMax: Math.max(...list.map((s) => s.steps)),
    rowsMax: Math.max(...list.map((s) => s.rows)),
    bodyHMax: Math.max(...bodyH),
    bodyScrollMax: Math.max(...list.map((s) => s.bodyScroll ?? 0)),
    innerGapMax: innerGaps.length === 0 ? null : Math.max(...innerGaps),
    innerGapLast: innerGaps.length === 0 ? null : innerGaps[innerGaps.length - 1],
    slackMax: Math.max(...list.map((s) => s.sh - s.ch)),
    finalRead: window.__l3.read(),
    aroundBody: withBody.slice(0, 3).concat(withBody.slice(-3)),
  }
`)
console.log('report', JSON.stringify(report, null, 1))

const data = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(shots, '_level3-after.png'), Buffer.from(data.data, 'base64'))

try { ws.close() } catch {}
try { electron.kill() } catch {}
try { fake.kill() } catch {}
await sleep(500)
process.exit(0)

