process.on('unhandledRejection', () => {})

/**
 * 「自动跟随中途掉线」的现场取证（2026-11-10 报障）。
 *
 * 上一轮探针在长跑里量到：169 次可滚动采样只有 4 次贴底、165 次挂着「回到底部」胶囊。
 * 这个探针只做一件事——把**是谁把 scrollTop 改成了什么**记下来，顺便核对
 * 「我量的那个 .chat 是不是真的主对话那一个」。
 *
 * 记四样：
 *   1. 页面上有几个 .chat / 几个 .chat-to-bottom，各自挂在哪个容器里（防止量错对象）；
 *   2. 每 50ms 采一次主对话的 top / sh / ch / 胶囊是否可见；
 *   3. 滚动的每一次 scroll 事件（top、当时还差多少到底）；
 *   4. 对主对话的 scrollTop 做写入拦截，记下写入值 + 三层调用栈（谁在改它）。
 *
 * 运行：node desktop/shots/_verify-follow-debug.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-follow-debug-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18998
const debugPort = 9381

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
// standard 档：第三层（阶段组体）存在但默认收起，和用户截图一致。
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({ ui: { reasoningDefaultOpen: true, processFold: 'verbose' } }))

const now = Date.now()
const sessionFile = join(dsc, 'sessions', 'demo', 'follow-demo.jsonl')
writeFileSync(sessionFile, [
  { type: 'meta', id: 'follow-demo', cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '跑一轮长的：多读几个文件，我要看跟随会不会掉。', ts: now - 50000 },
].map((line) => JSON.stringify(line)).join('\n') + '\n')

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
  DSC_RESUME_SESSION: sessionFile,
  FOLD_FAKE_TOOLS: '8',
  FOLD_FAKE_TAIL_MS: '3000',
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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 1500))
  return result.result?.value
}

await send('Emulation.setDeviceMetricsOverride', { width: 1423, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(600)

const started = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.composer textarea') !== null && document.querySelector('.entry-user') !== null) break
    await wait(250)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }

  // —— 先核对对象：到底有几个 .chat、胶囊挂在哪 ——
  const chats = [...document.querySelectorAll('.chat')]
  const pills = [...document.querySelectorAll('.chat-to-bottom')]
  const survey = {
    chats: chats.map((node) => ({
      cls: node.className,
      parent: node.parentElement?.className ?? '',
      inThread: node.closest('.thread-main, .thread-main-empty') !== null,
      h: Math.round(node.getBoundingClientRect().height),
    })),
    pills: pills.map((node) => ({
      parent: node.parentElement?.className ?? '',
      inThread: node.closest('.thread-main, .thread-main-empty') !== null,
      box: (() => { const r = node.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) } })(),
    })),
  }
  // 主对话 = 挂在 .thread-main 里的那一个
  const chat = chats.find((node) => node.closest('.thread-main, .thread-main-empty') !== null) ?? chats[0]
  if (chat === undefined) return { survey, error: 'no chat' }
  const inner = chat.querySelector('.chat-inner')

  // —— 拦截 scrollTop 写入，记调用栈 ——
  const writes = []
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  if (descriptor !== undefined && descriptor.set !== undefined && descriptor.get !== undefined) {
    const set = descriptor.set
    const get = descriptor.get
    Object.defineProperty(chat, 'scrollTop', {
      configurable: true,
      get() { return get.call(this) },
      set(value) {
        const stack = String(new Error().stack ?? '').split('\\n').slice(1, 5).join(' | ')
        writes.push({ t: Math.round(performance.now()), value: Math.round(Number(value)), stack })
        if (writes.length > 60) writes.shift()
        set.call(this, value)
      },
    })
  }

  const scrolls = []
  chat.addEventListener('scroll', () => {
    scrolls.push({
      t: Math.round(performance.now()),
      top: Math.round(chat.scrollTop),
      slack: chat.scrollHeight - chat.clientHeight,
      gap: Math.round(chat.scrollHeight - chat.clientHeight - chat.scrollTop),
    })
    if (scrolls.length > 80) scrolls.shift()
  }, { passive: true })

  const samples = []
  const timer = window.setInterval(() => {
    const pill = [...document.querySelectorAll('.chat-to-bottom')]
      .filter((node) => node.closest('.thread-main, .thread-main-empty') !== null && node.getBoundingClientRect().height > 0)
    samples.push({
      t: Math.round(performance.now()),
      top: Math.round(chat.scrollTop),
      sh: chat.scrollHeight,
      ch: chat.clientHeight,
      innerGap: inner === null ? null : Math.round(chat.getBoundingClientRect().bottom - inner.getBoundingClientRect().bottom),
      pill: pill.length > 0,
      status: document.querySelector('.turn-status') !== null,
    })
  }, 50)

  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '跑一轮长的：多读几个文件，我要看跟随会不会掉。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  window.__fd = { timer, samples, scrolls, writes }
  return { survey: { ...survey, picked: chat.className, h: Math.round(chat.getBoundingClientRect().height) } }
`)
console.log('start', JSON.stringify(started, null, 1))
await sleep(11000)

const report = await evaluate(`
  window.clearInterval(window.__fd.timer)
  const { samples, scrolls, writes } = window.__fd
  const scrollable = samples.filter((s) => s.sh - s.ch > 24)
  const pinned = scrollable.filter((s) => s.sh - s.ch - s.top <= 24)
  const firstPill = samples.findIndex((s) => s.pill)
  return {
    n: samples.length,
    scrollable: scrollable.length,
    pinned: pinned.length,
    pillSamples: samples.filter((s) => s.pill).length,
    firstPillAt: firstPill < 0 ? null : samples[firstPill],
    head: samples.slice(0, 6),
    tail: samples.slice(-4),
    scrollEvents: scrolls.length,
    firstScrolls: scrolls.slice(0, 10),
    lastScrolls: scrolls.slice(-6),
    writeCount: writes.length,
    writes: writes.slice(-8),
  }
`)
console.log('report', JSON.stringify(report, null, 1))

try { ws.close() } catch {}
try { electron.kill() } catch {}
try { fake.kill() } catch {}
await sleep(500)
process.exit(0)


