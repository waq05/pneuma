process.on('unhandledRejection', () => {})

/**
 * 「回到底部」胶囊行为探针：真宿主 + 真壳，两段实验。
 *
 *   A 内容自己变矮（工具卡收起那类重排）：修复前浏览器夹 scrollTop 会发一条 scroll，
 *     被当成「读者往上滚」，胶囊闪出来又被落定收回。期望：胶囊不出现。
 *   B 读者真的往上滚：胶囊必须出现；点它回到底部后必须消失并贴底。
 *
 * 通过 CDP 驱动 Electron，隔离 HOME，不碰真实配置。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-pill-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const fakePort = 18979
const debugPort = 9335

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-code', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:' + fakePort + '/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-code', '        name: Fake Code',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
}
delete env.ELECTRON_RUN_AS_NODE

const fake = spawn(process.execPath, [join(shots, '_verify-code-fake-llm.mjs'), String(fakePort)], { env, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const electron = spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
  join(root, 'desktop/out/main/index.js'), '--remote-debugging-port=' + debugPort,
], { cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
electron.stdout.on('data', (d) => { log += String(d) })
electron.stderr.on('data', (d) => { log += String(d) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const listPages = async () => {
  try {
    const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()
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
    } catch {
      try { ws.close() } catch {}
    }
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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600))
  return result.result?.value
}

const started = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 40; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(500)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '给我一段长代码和一个长结论。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(120)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  const chat = document.querySelector('.chat')
  const probe = { shows: 0, hides: 0, events: [], last: false }
  window.__pillProbe = probe
  const seen = () => document.querySelector('.chat-to-bottom') !== null
  probe.last = seen()
  const snap = (kind) => ({
    kind,
    t: Math.round(performance.now()),
    top: Math.round(chat.scrollTop),
    gap: Math.round(chat.scrollHeight - chat.clientHeight - chat.scrollTop),
    sh: Math.round(chat.scrollHeight),
  })
  const observer = new MutationObserver(() => {
    const now = seen()
    if (now === probe.last) return
    probe.last = now
    if (now) { probe.shows += 1; probe.events.push(snap('show')) }
    else { probe.hides += 1; probe.events.push(snap('hide')) }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return { sent: true }
`)
console.log('started', JSON.stringify(started))

// 等内容长过一屏，再开始两段实验。
await sleep(1500)

const collapse = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const chat = document.querySelector('.chat')
  const probe = window.__pillProbe
  const before = { shows: probe.shows, hides: probe.hides, sh: Math.round(chat.scrollHeight) }
  // A：内容自己变矮（工具卡收起/步骤组收合的形状）——不派发任何手势。
  const blocks = Array.from(document.querySelectorAll('.chat-inner > *'))
  const victim = blocks.find((node) => node.getBoundingClientRect().height > 120) ?? blocks[0]
  if (victim === undefined) return { error: 'no block' }
  const keep = victim.style.display
  victim.style.display = 'none'
  await wait(900)
  const during = { shows: probe.shows - before.shows, hides: probe.hides - before.hides, sh: Math.round(chat.scrollHeight), gap: Math.round(chat.scrollHeight - chat.clientHeight - chat.scrollTop) }
  victim.style.display = keep
  await wait(400)
  return { before, during, events: probe.events.slice(-6) }
`)
console.log('collapse', JSON.stringify(collapse))

const rect = await evaluate(`
  const chat = document.querySelector('.chat')
  const box = chat.getBoundingClientRect()
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
`)

// 真滚轮：合成的 WheelEvent 不会产生默认滚动，走 CDP 的输入管线才有滚动 + scroll 事件。
for (let i = 0; i < 4; i += 1) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: -120, modifiers: 0,
  })
  await sleep(80)
}
await sleep(700)

const scrollAway = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const chat = document.querySelector('.chat')
  const probe = window.__pillProbe
  const before = { shows: probe.shows, hides: probe.hides }
  // A 段把 scrollTop 夹到过 0，这里先滚回底部（程序滚动会被跟随判成「读过手」，
  // 但落定后按距离恢复，正好也验一次恢复），再真正做「读者往上滚」。
  const atBottom = { top: Math.round(chat.scrollTop), sh: Math.round(chat.scrollHeight), gap: Math.round(chat.scrollHeight - chat.clientHeight - chat.scrollTop) }
  const beforeScroll = { top: Math.round(chat.scrollTop), gap: Math.round(chat.scrollHeight - chat.clientHeight - chat.scrollTop) }
  await wait(600)
  const pill = document.querySelector('.chat-to-bottom')
  const shown = pill !== null
  if (pill !== null) pill.click()
  await wait(700)
  const after = { shows: probe.shows - before.shows, hides: probe.hides - before.hides }
  return {
    atBottom,
    beforeScroll,
    shownAfterScroll: shown,
    goneAfterClick: document.querySelector('.chat-to-bottom') === null,
    gapAfterClick: Math.round(chat.scrollHeight - chat.clientHeight - chat.scrollTop),
    after,
  }
`)
console.log('scrollAway', JSON.stringify(scrollAway))

try { ws.close() } catch {}
try { electron.kill() } catch {}
try { fake.kill() } catch {}
await sleep(500)
