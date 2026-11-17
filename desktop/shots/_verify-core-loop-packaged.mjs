/**
 * 打包产物的核心闭环实机探针：发一句话，看模型回复能不能落到会话流里。
 *
 * 为什么单独一支：打包后跑的是 `resources/dsc-core` 里那份内核与插件包，和 dev 的
 * `desktop/out` 不是一批文件。首屏能画出来只证明文案在，发一句话走到「请求 → 流式回复 →
 * 渲染」才证明合进来的插件化装配是通的。
 *
 * 做法：本地起一个最简 OpenAI 兼容 SSE 端点（一句话，不带工具调用），隔离 HOME 起打包好的
 * `Pneuma.exe`，在输入框里打字回车，等助手气泡出现。
 *
 * 判据：
 *   1. 输入框存在且能写入；
 *   2. 回车后出现用户气泡，文字与输入一致；
 *   3. 出现助手气泡，文字含端点返回的关键词；
 *   4. 没有错误卡片；
 *   5. 截图落盘。
 *
 * 运行：node desktop/shots/_verify-core-loop-packaged.mjs
 * 产物：desktop/shots/out/core-loop-packaged.png
 */
process.on('unhandledRejection', () => {})

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-core-loop-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const outDir = join(shots, 'out')
const apiPort = 18991
const debugPort = 9382
const REPLY = '收到，我先看这段代码的结构，再给你结论。'

// ── 1. 最简假端点 ────────────────────────────────────────────────────────────
let calls = 0
const server = createServer((req, res) => {
  const url = (req.url ?? '').split('?')[0]
  if (req.method === 'GET' && url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-code', object: 'model' }] }))
    return
  }
  if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('fake')
    return
  }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    calls += 1
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (p) => res.write('data: ' + JSON.stringify(p) + '\n\n')
    send({ choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] })
    for (const piece of REPLY.match(/.{1,6}/gu)) {
      send({ choices: [{ delta: { content: piece }, finish_reason: null }] })
    }
    send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 12 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

// ── 2. 隔离 HOME + 起打包产物 ────────────────────────────────────────────────
rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
mkdirSync(outDir, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-code', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:' + String(apiPort) + '/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-code', '        name: Fake Code',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

server.listen(apiPort, '127.0.0.1')

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
}
delete env.ELECTRON_RUN_AS_NODE

const app = spawn(join(root, 'desktop/dist/win-unpacked/Pneuma.exe'), [
  '--remote-debugging-port=' + String(debugPort),
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
], { cwd: join(root, 'desktop/dist/win-unpacked'), env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
app.stdout.on('data', (d) => { log += String(d) })
app.stderr.on('data', (d) => { log += String(d) })

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
for (let i = 0; i < 100; i += 1) {
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
      await send('Page.enable')
      connected = true
      break
    } catch { try { ws.close() } catch {} }
  }
  await sleep(700)
}
if (!connected) {
  console.log('FAIL 连不上应用：' + log.slice(-500))
  try { app.kill() } catch {}
  try { server.close() } catch {}
  process.exit(1)
}

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression: '(async () => { ' + expression + ' })()',
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800))
  return result.result?.value
}

await send('Emulation.setDeviceMetricsOverride', { width: 1423, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
await sleep(600)

// ── 3. 找输入框、写入、回车 ──────────────────────────────────────────────────
const composer = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.welcome') !== null) break
    await wait(250)
  }
  const pick = () => document.querySelector('textarea') ?? document.querySelector('[contenteditable="true"]') ?? document.querySelector('[role="textbox"]')
  let el = pick()
  for (let i = 0; i < 80 && el === null; i += 1) { await wait(150); el = pick() }
  if (el === null) return { ok: false, why: 'no composer', html: document.body.innerHTML.slice(0, 300) }
  el.focus()
  const text = '帮我看一下这个仓库的入口文件'
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } else {
    el.textContent = text
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }))
  }
  return { ok: true, tag: el.tagName, value: el.value ?? el.textContent, focused: document.activeElement === el }
`)
console.log('  输入框: ' + JSON.stringify(composer))
if (composer.ok !== true) {
  console.log('FAIL 没找到可写入的输入框')
  try { app.kill() } catch {}
  try { server.close() } catch {}
  process.exit(1)
}

const pressEnter = async () => {
  const base = { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'char', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}
await pressEnter()

// ── 4. 等回复 ────────────────────────────────────────────────────────────────
const view = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const text = () => document.body.innerText
  for (let i = 0; i < 240; i += 1) {
    if (text().includes(${JSON.stringify(REPLY.slice(0, 6))}) && text().includes('帮我看一下这个仓库的入口文件')) break
    await wait(250)
  }
  const errs = [...document.querySelectorAll('.entry-system[data-level="error"], .entry-system')].map((n) => n.innerText).filter((t) => /失败|错误|failed/i.test(t))
  return {
    body: text().slice(0, 1200),
    hasUser: text().includes('帮我看一下这个仓库的入口文件'),
    hasReply: text().includes(${JSON.stringify(REPLY.slice(0, 6))}),
    errors: errs.slice(0, 3),
    model: (document.querySelector('.composer-model, .model-chip') ?? {}).textContent ?? null,
  }
`)

let failed = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + (ok ? '' : '  <- ' + String(detail)))
  if (!ok) failed += 1
}
check('输入框写入且拿到焦点', composer.ok === true && (composer.value ?? '').length > 0, JSON.stringify(composer))
check('假端点收到了请求', calls >= 1, String(calls))
check('用户消息进了会话流', view.hasUser === true, view.body.slice(0, 200))
check('助手回复渲染出来', view.hasReply === true, view.body.slice(-300))
check('没有错误条目', (view.errors ?? []).length === 0, JSON.stringify(view.errors))

const shot = await send('Page.captureScreenshot', { format: 'png' })
const file = join(outDir, 'core-loop-packaged.png')
writeFileSync(file, Buffer.from(shot.data, 'base64'))
console.log('  截图: ' + file)

try { app.kill() } catch {}
try { server.close() } catch {}
await sleep(500)
console.log('')
console.log(failed === 0 ? '打包产物核心闭环：全部通过' : '打包产物核心闭环：' + String(failed) + ' 条失败')
process.exit(failed === 0 ? 0 : 1)
