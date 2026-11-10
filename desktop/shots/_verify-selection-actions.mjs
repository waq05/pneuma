/**
 * 「选中文字后的浮层动作是一条槽」的现场探针（差距清单 S9）。
 *
 * 改之前：浮层只画一颗写死的「问 AI」按钮。改之后：浮层渲染 list 槽
 * `ask.selection.action`，内置那一颗也登记在链上，插件按 order 往里挂动作。
 *
 * 这个探针造一次真的选中：假模型先回一段正文，随后用 CDP 在正文上做一次**真实选区**
 * （`document.createRange` + `window.getSelection`），再照用户松手的样子发一次 mouseup。
 * 然后在页面上核三件事：
 *
 *   1. `.ask-sel-actions` 在场，里面有且只有 1 颗 `button.ask-sel-btn`——
 *      内置那一颗是**从槽里渲染出来**的（不是浮层自己画的那份兜底）；
 *   2. 那颗按钮的文本是「问 AI」；
 *   3. 定位落在容器上：`.ask-sel-actions` 有内联 left/top，且在屏幕上真占面积。
 *
 * 为什么第 1 条要数「1 颗」：兜底分支只会画一颗、槽里也只登记了内置那一颗，两种路径的
 * DOM 长得一样；数量与类名一起钉，至少能挡住「多了一颗」与「槽里没人时整排消失」。
 * 想确认「动作真的来自链上」，看的是源码钉（`scripts/ui-ask-selection-slot-test.mjs`），
 * 这里是端到端的那一半。
 *
 * 截图：`desktop/shots/_selection-actions.png`。
 *
 * 运行：node desktop/shots/_verify-selection-actions.mjs
 * 前提：`pnpm run build` 与 `pnpm run build:ui` 已跑过（探针加载的是 out/ 与 lib/ui）。
 *
 * @module dsc/desktop/shots/_verify-selection-actions
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-selection-actions-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18997
const debugPort = 9377

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-select', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-select', '        name: Fake Select',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({}))

/** 正文：要够长、够普通——选区落在正文里，浮层才该浮出来。 */
const ANSWER = '这段话是用来做选区自检的正文，请把鼠标从中间拖过去，浮层就会贴着选区右下角出现。'

const now = Date.now()
writeFileSync(
  join(dsc, 'sessions', 'demo', 'selection-actions.jsonl'),
  [
    { type: 'meta', id: 'selection-actions', cwd: work, createdAt: now - 60000 },
    { type: 'user', text: '说一段话，我要拿它试选区。', ts: now - 50000 },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n',
)

/** 假模型：一次正文，不调工具。 */
const server = createServer((req, res) => {
  void (async () => {
    for await (const _chunk of req) { /* 请求体用不上：永远回同一段正文 */ }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    delta({ content: ANSWER })
    await new Promise((resolve) => setTimeout(resolve, 80))
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 80 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-select] ${String(error)}\n`)
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

const shot = async (name) => {
  const image = await send('Page.captureScreenshot', { format: 'png' })
  if (typeof image?.data === 'string') writeFileSync(join(shots, name), Buffer.from(image.data, 'base64'))
}

/** 页面里常用的几件小工具（每次重新定义，探针之间不共享状态）。 */
const PAGE_HELPERS = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  /** 浮层此刻的样子：数量、文本、定位一次读完，免得跨帧读到半截。 */
  const bubbleSnap = () => {
    const box = document.querySelector('.ask-sel-actions')
    if (box === null) return { present: false }
    const pills = [...box.querySelectorAll('button.ask-sel-btn')]
    const rect = box.getBoundingClientRect()
    return {
      present: true,
      count: pills.length,
      texts: pills.map((pill) => (pill.textContent ?? '').trim()),
      left: box.style.left,
      top: box.style.top,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
    }
  }
`

// ── 1. 发消息，等正文画出来 ────────────────────────────────────────────────
const started = await evaluate(`
  ${PAGE_HELPERS}
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(250)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '说一段话，我要拿它试选区。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  // 等助手正文**整段**落地再动手：流式期间条目还是临时的，定稿时会换 key 重挂，
  // 提前做选区会在那一瞬间被丢掉，浮层跟着消失（探针会误报成「浮层没出来」）。
  let text = ''
  for (let i = 0; i < 400; i += 1) {
    const bodies = [...document.querySelectorAll('.chat .entry-text')]
    const last = bodies.at(-1)
    text = (last?.textContent ?? '').trim()
    if (text.includes('浮层就会贴着选区右下角出现')) break
    await wait(100)
  }
  await wait(800)
  return { textLen: text.length, settled: text.includes('浮层就会贴着选区右下角出现') }
`)
if (started?.error !== undefined) throw new Error(String(started.error))
console.log('started', JSON.stringify(started))

// ── 2. 真选区：在最后一段正文里选中一截，再照用户松手的样子发 mouseup ──────────
const selected = await evaluate(`
  ${PAGE_HELPERS}
  const bodies = [...document.querySelectorAll('.chat .entry-text')]
  const last = bodies.at(-1)
  if (last === undefined) return { error: '正文里没有 .entry-text' }
  // 先把它滚进视野：选区不在屏幕上时，锚点会被夹到视口边上，截图就看不出「贴着选区」。
  last.scrollIntoView({ block: 'center' })
  await wait(300)
  // 找到第一个够长的文本节点来选（正文中间可能被 markdown 拆成好几段）。
  const walker = document.createTreeWalker(last, NodeFilter.SHOW_TEXT)
  let node = null
  while (walker.nextNode()) {
    const candidate = walker.currentNode
    if ((candidate.textContent ?? '').trim().length >= 12) { node = candidate; break }
  }
  if (node === null) return { error: '正文里没有够长的文本节点' }
  // 从节点中间切 12 个字：避开行首缩进与被拆开的行内标记，稳稳超过浮层的 4 字门槛。
  const whole = node.textContent.length
  const start = Math.max(0, Math.min(whole - 12, Math.floor(whole / 2) - 6))
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, Math.min(whole, start + 12))
  const selection = window.getSelection()
  if (selection === null) return { error: '拿不到 selection' }
  selection.removeAllRanges()
  selection.addRange(range)
  // 浮层挂在 document 的 mouseup 上（用户拖完松手那一下）：照样子发一次。
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  await wait(400)
  return { picked: selection.toString(), inChat: node.parentElement?.closest('.chat') !== null }
`)
if (selected?.error !== undefined) throw new Error(String(selected.error))
console.log('selected', JSON.stringify(selected))

// ── 3. 等浮层出现并读它 ─────────────────────────────────────────────────────
const final = await evaluate(`
  ${PAGE_HELPERS}
  let snap = bubbleSnap()
  for (let i = 0; i < 200 && snap.present !== true; i += 1) {
    await wait(100)
    snap = bubbleSnap()
  }
  return snap
`)
console.log('bubble', JSON.stringify(final))

await shot('_selection-actions.png')

// ── 4. 判 ───────────────────────────────────────────────────────────────────
const failures = []
// 正文没等齐时后面的断言会全部指向「浮层」，先把真正的原因单独报出来。
if (started?.settled !== true) failures.push(`正文没等齐（最后一段只有 ${String(started?.textLen)} 字）`)
const snap = final ?? { present: false }
if (snap.present !== true) failures.push('页面上没有 .ask-sel-actions（浮层没浮出来）')
if (snap.present === true && snap.count !== 1) {
  failures.push(`.ask-sel-actions 里的 button.ask-sel-btn 不是 1 颗（实际 ${String(snap.count)} 颗）`)
}
if (snap.present === true && !String(snap.texts?.[0] ?? '').includes('问 AI')) {
  failures.push(`内置那颗的文本不是「问 AI」（实际「${String(snap.texts?.[0] ?? '')}」）`)
}
// 定位在容器上：内联 left/top 必须有，而且在屏幕上真占面积（0×0 说明被裁掉了）。
if (snap.present === true && (String(snap.left ?? '') === '' || String(snap.top ?? '') === '')) {
  failures.push(`.ask-sel-actions 没有内联 left/top（定位没交给容器：left=${String(snap.left)} top=${String(snap.top)}）`)
}
if (snap.present === true && ((snap.w ?? 0) < 40 || (snap.h ?? 0) < 16)) {
  failures.push(`浮层在屏幕上没有面积（${String(snap.w)}×${String(snap.h)}）`)
}

console.log('report', JSON.stringify({ selected, snap, failures }))
const pass = 'PASS 选中正文后浮层从槽里渲染出 1 颗「问 AI」，定位落在 .ask-sel-actions 容器上'
console.log(failures.length === 0 ? pass : 'FAIL ' + failures.join('; '))

try { electron.kill() } catch {}
server.close()
process.exit(failures.length === 0 ? 0 : 1)
