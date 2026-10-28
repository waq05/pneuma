process.on('unhandledRejection', () => {})

/**
 * 流式代码块抖动探针（临时）：真宿主 + 真界面壳，量「已输出完的代码块」在后续流式期间
 * 有没有被重建。通过 CDP 驱动 Electron，不依赖已退役的 DSC_DESKTOP_SHOT 注入。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-code-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const fakePort = 18978
const debugPort = 9334

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
  setter.call(input, '给我一段代码，然后继续写正文。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(120)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return { sent: true }
`)
console.log('start', JSON.stringify(start))

// 在页面里挂观察器：从代码块出现开始，记录 pre 元素身份、高度、class 与重建次数。
const armed = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  let body = null
  for (let i = 0; i < 120; i += 1) {
    body = document.querySelector('.entry-text .file-code-body')
    if (body !== null && body.querySelector('pre') !== null && body.textContent.includes('store')) break
    await wait(100)
  }
  if (body === null) return { error: 'no code block' }
  window.__cdProbe = { samples: [], swaps: 0, classes: new Set(), first: body.querySelector('pre') }
  const probe = window.__cdProbe
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node.nodeType === 1 && (node.matches?.('pre') || node.querySelector?.('pre') !== null)) probe.swaps += 1
      }
    }
  })
  observer.observe(body, { childList: true, subtree: true })
  const tick = () => {
    const pre = body.querySelector('pre')
    const entry = body.closest('.entry-text')
    probe.samples.push({
      t: Math.round(performance.now()),
      h: Math.round(body.getBoundingClientRect().height),
      pre: pre === probe.first,
      cls: pre === null ? null : pre.className,
      html: pre === null ? 0 : pre.innerHTML.length,
      plain: body.innerHTML.includes('file-code-plain'),
      live: entry === null ? null : entry.classList.contains('live'),
      inDoc: body.isConnected,
    })
    if (probe.samples.length < 80) window.setTimeout(tick, 60)
  }
  tick()
  return { armed: true, height: Math.round(body.getBoundingClientRect().height) }
`)
console.log('armed', JSON.stringify(armed))

await sleep(4500)
await shot('verify-code-stream.png')

const result = await evaluate(`
  const probe = window.__cdProbe
  if (!probe) return { error: 'no probe' }
  const samples = probe.samples
  const heights = samples.map((s) => s.h)
  const htmls = samples.map((s) => s.html)
  const classes = Array.from(new Set(samples.map((s) => s.cls)))
  return {
    samples: samples.length,
    swaps: probe.swaps,
    sameElementAlways: samples.every((s) => s.pre === true),
    heightMin: Math.min(...heights),
    heightMax: Math.max(...heights),
    htmlMin: Math.min(...htmls),
    htmlMax: Math.max(...htmls),
    classes,
    sawPlain: samples.some((s) => s.plain),
    distinctClasses: classes.length,
    liveSamples: samples.filter((s) => s.live === true).length,
    htmlChanges: samples.reduce((count, item, index) => (index > 0 && item.html !== samples[index - 1].html ? count + 1 : count), 0),
    detachedSamples: samples.filter((s) => s.inDoc === false).length,
    zeroHeightSamples: samples.filter((s) => s.h === 0).length,
    first: samples.slice(0, 3),
    last: samples.slice(-2),
  }
`)
console.log('result', JSON.stringify(result, null, 1))

try { ws.close() } catch {}
try { electron.kill() } catch {}
try { fake.kill() } catch {}
await sleep(600)
