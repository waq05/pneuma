process.on('unhandledRejection', () => {})

/**
 * 流式光标（那根浅棕色竖条）的复现探针（2026-11-02）。
 *
 * 报障现场：正文左下角多出一根 6×25 的浅棕色短竖条。原因是 `.live::after { content: '▍' }`
 * 挂在块级容器上，行内伪元素被挤到下一行行首。修法是把光标删掉（见
 * `ui-shell/src/legacy/views.css` 里那一段注释）。
 *
 * 这条探针是本仓库里唯一能直接看见它的东西：真宿主 + 真界面壳（CDP 驱动），假端点先吐
 * 思考再吐正文，界面于是有「直播中的思考行 + 直播中的正文」；随后扫对话区 DOM，把
 * `.live` 的 `::after` 连同所有「宽 ≤ 10px、高 12–80px」的元素打出来。
 *
 * **验收口径**：两个 `.live` 的 `::after` 都必须是 `content: "none"`，`pseudos` 为空，
 * 截图里正文下方不再有竖条。
 *
 * 运行：node desktop/shots/_verify-stream-caret.mjs（依赖桌面产物 desktop/out/）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-caret-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const fakePort = 18980
const debugPort = 9341

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-bar', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:' + fakePort + '/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-bar', '        name: Fake Bar',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
}
delete env.ELECTRON_RUN_AS_NODE

const fake = spawn(process.execPath, [join(shots, '_verify-stream-caret-fake-llm.mjs'), String(fakePort)], { env, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))

const electron = spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
  join(root, 'desktop/out/main/index.js'), '--remote-debugging-port=' + debugPort,
], { cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
electron.stdout.on('data', (d) => { log += String(d) })
electron.stderr.on('data', (d) => { log += String(d) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function listPages() {
  try {
    const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()
    return (list ?? []).filter((p) => p.type === 'page')
  } catch { return [] }
}

let seq = 0
const pending = new Map()
let ws = null
const send = (method, params) => {
  seq += 1
  const promise = new Promise((resolve, reject) => {
    pending.set(seq, { resolve, reject })
    ws.send(JSON.stringify({ id: seq, method, params }))
  })
  promise.catch(() => {})
  return promise
}

let page = null
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
      await send('Page.enable')
      page = candidate
      break
    } catch {
      try { ws.close() } catch {}
    }
  }
  await sleep(800)
}
if (page === null) throw new Error('connect failed: ' + log.slice(-600))

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression: '(async () => { ' + expression + ' })()',
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600))
  return result.result?.value
}
const shot = async (name) => {
  const data = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, name), Buffer.from(data.data, 'base64'))
}

const start = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 40; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(500)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '把后端改成 CRLF 行尾，顺便看看循环导入。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(120)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return { sent: true }
`)
console.log('start', JSON.stringify(start))

// 等到正文开始流（.entry-text.live 出现），再扫。
const scan = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  let text = null
  for (let i = 0; i < 150; i += 1) {
    text = document.querySelector('.entry-text.live, .think-block.live')
    if (text !== null) break
    await wait(100)
  }
  await wait(1500)
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--dsc-accent').trim()
  const path = (el) => {
    const parts = []
    let node = el
    let depth = 0
    while (node !== null && node.nodeType === 1 && depth < 5) {
      let part = node.tagName.toLowerCase()
      if (node.id !== '') part += '#' + node.id
      const cls = (node.getAttribute('class') ?? '').trim()
      if (cls !== '') part += '.' + cls.split(/\\s+/).join('.')
      parts.unshift(part)
      node = node.parentElement
      depth += 1
    }
    return parts.join(' > ')
  }
  const describe = (el, pseudo) => {
    const rect = el.getBoundingClientRect()
    const cs = getComputedStyle(el, pseudo ?? null)
    return {
      path: path(el) + (pseudo ?? ''),
      w: Math.round(rect.width * 100) / 100,
      h: Math.round(rect.height * 100) / 100,
      left: Math.round(rect.left * 100) / 100,
      top: Math.round(rect.top * 100) / 100,
      bg: cs.backgroundColor,
      color: cs.color,
      bl: cs.borderLeftWidth + ' ' + cs.borderLeftStyle + ' ' + cs.borderLeftColor,
      content: cs.content,
      text: (el.textContent ?? '').slice(0, 24),
    }
  }
  const out = []
  for (const el of document.querySelectorAll('.chat *')) {
    const rect = el.getBoundingClientRect()
    if (rect.width > 10 || rect.width < 1 || rect.height < 10 || rect.height > 80) continue
    out.push(describe(el, null))
  }
  // 伪元素单独看：::after / ::before 的 content 非 none 的小元素
  const pseudos = []
  for (const el of document.querySelectorAll('.chat *')) {
    for (const pseudo of ['::before', '::after']) {
      const cs = getComputedStyle(el, pseudo)
      if (cs.content === 'none' || cs.content === 'normal') continue
      const rect = el.getBoundingClientRect()
      const color = cs.color
      if (!/rgba?\\(\\s*2/.test(color) && color !== 'rgb(217, 119, 87)') continue
      pseudos.push({ ...describe(el, pseudo), hostW: Math.round(rect.width), hostH: Math.round(rect.height) })
    }
  }
  const liveCaret = []
  for (const el of document.querySelectorAll('.live')) {
    liveCaret.push(describe(el, '::after'))
  }
  return { accent, narrow: out, pseudos, liveCaret, chatW: Math.round(document.querySelector('.chat')?.getBoundingClientRect().width ?? 0) }
`)

console.log('scan', JSON.stringify(scan, null, 1))
await shot('_verify-stream-caret.png')

try { ws.close() } catch {}
try { electron.kill() } catch {}
try { fake.kill() } catch {}
await sleep(600)
