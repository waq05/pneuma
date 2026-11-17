/**
 * 诊断：侧栏「插件 / 技能」到底点不点得开。
 *
 * 两条路各试一次，看是哪一边的问题：
 *   A. `el.click()` —— 只派发 click 事件，不移动鼠标；
 *   B. CDP `Input.dispatchMouseEvent` 在元素中心按下/抬起 —— 真实鼠标路径。
 *
 * 同时打印节点结构（tag/class/disabled/rect），以及点击后 3 秒的正文长度与首屏是否消失。
 *
 * 运行：node desktop/shots/_diag-plugins.mjs
 */
process.on('unhandledRejection', () => {})

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_diag-plugins-home')
const dsc = join(home, '.dsc')
const debugPort = 9385

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-code', 'providers:', '  fake:',
  '    displayName: 自检假端点', '    baseURL: http://127.0.0.1:18999/v1',
  '    apiKeyEnv: DSC_FAKE_KEY', '    models:', '      - id: fake-code', '        name: Fake Code',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

const env = { ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home, DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: join(home, 'electron-userdata') }
delete env.ELECTRON_RUN_AS_NODE

const useDev = process.env.DIAG_DEV === '1'
const launch = useDev
  ? {
      exe: join(root, 'desktop/node_modules/electron/dist/electron.exe'),
      args: [join(root, 'desktop/out/main/index.js'), '--remote-debugging-port=' + String(debugPort)],
    }
  : {
      exe: join(root, 'desktop/dist/win-unpacked/Pneuma.exe'),
      args: ['--remote-debugging-port=' + String(debugPort)],
    }
console.log('目标: ' + (useDev ? 'dev (desktop/out)' : '打包产物 (dist/win-unpacked)'))

const app = spawn(launch.exe, launch.args, {
  cwd: useDev ? join(root, 'desktop') : join(root, 'desktop/dist/win-unpacked'), env, stdio: 'ignore',
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws = null
for (let i = 0; i < 100 && ws === null; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + String(debugPort) + '/json/list')).json()
    const page = (list ?? []).find((p) => p.type === 'page' && String(p.url).startsWith('http'))
    if (page !== undefined) {
      ws = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', reject, { once: true })
      })
    }
  } catch {}
  if (ws === null) await sleep(600)
}
if (ws === null) { console.log('连不上 CDP'); process.exit(1) }

let seq = 0
const pending = new Map()
const events = []
ws.addEventListener('message', (event) => {
  try {
    const msg = JSON.parse(String(event.data))
    if (msg.method !== undefined) { events.push(msg.method + ' ' + JSON.stringify(msg.params).slice(0, 300)); return }
    const waiter = pending.get(msg.id)
    if (waiter === undefined) return
    pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)))
    else waiter.resolve(msg.result)
  } catch {}
})
const send = (method, params) => {
  seq += 1
  const promise = new Promise((resolve, reject) => {
    pending.set(seq, { resolve, reject })
    ws.send(JSON.stringify({ id: seq, method, params }))
  })
  promise.catch(() => {})
  return promise
}
await send('Runtime.enable')
await send('Page.enable')
await send('Log.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1423, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression: '(async () => { ' + expression + ' })()', awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600))
  return result.result?.value
}

await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 160; i += 1) { if (document.querySelector('.welcome') !== null) break; await wait(250) }
  await wait(600)
  return true
`)

const info = await evaluate(`
  const label = '插件'
  const all = [...document.querySelectorAll('*')]
  const exact = all.filter((n) => (n.textContent ?? '').trim() === label && n.children.length <= 2)
  return exact.slice(0, 6).map((n) => {
    const r = n.getBoundingClientRect()
    const p = n.parentElement
    return {
      tag: n.tagName,
      cls: String(n.className).slice(0, 60),
      disabled: n.disabled ?? null,
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      parentTag: p === null ? null : p.tagName + '.' + String(p.className).slice(0, 50),
      grandTag: p?.parentElement === null ? null : p?.parentElement?.tagName + '.' + String(p?.parentElement?.className).slice(0, 50),
      text: (n.textContent ?? '').trim().slice(0, 20),
    }
  })
`)
console.log('候选节点：')
for (const item of info ?? []) console.log('  ' + JSON.stringify(item))

const snapshot = async (tag) => {
  const now = await evaluate(`
    return {
      welcome: document.querySelector('.welcome') !== null,
      len: document.body.innerText.length,
      head: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 90),
      dialogs: document.querySelectorAll('[role="dialog"]').length,
    }
  `)
  console.log('  [' + tag + '] ' + JSON.stringify(now))
  return now
}

await snapshot('点击前')

// A. 元素 click
await evaluate(`
  const label = '插件'
  const hit = [...document.querySelectorAll('button, a, [role="button"], li, div')]
    .filter((n) => (n.textContent ?? '').trim() === label).pop()
  if (hit !== undefined) hit.click()
  await new Promise((r) => setTimeout(r, 2500))
  return true
`)
await snapshot('A: el.click()')

// B. 真实鼠标
const target = (info ?? [])[0]
if (target !== undefined) {
  const [x, y, w, h] = target.rect
  const cx = x + Math.round(w / 2)
  const cy = y + Math.round(h / 2)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: cx, y: cy, button: 'left', clickCount: 1 })
    await sleep(120)
  }
  await sleep(2500)
  await snapshot('B: 真实鼠标(' + cx + ',' + cy + ')')
}

// B2. 如果 A/B 都没动，试试父节点
await evaluate(`
  const label = '插件'
  const hit = [...document.querySelectorAll('*')]
    .filter((n) => (n.textContent ?? '').trim() === label).pop()
  const p = hit?.parentElement
  if (p) p.click()
  await new Promise((r) => setTimeout(r, 2500))
  return true
`)
await snapshot('C: 父节点 click()')

console.log('事件（末尾 10 条）：')
for (const e of events.slice(-10)) console.log('  ' + e)

try { app.kill() } catch {}
process.exit(0)
