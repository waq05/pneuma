process.on('unhandledRejection', () => {})

/**
 * 正文列宽拖拽的现场量测（2026-11-10 报障：会话区大小拖不动，只有输入框在变）。
 *
 * 只量事实，不下结论：
 *   G 初始几何：`.thread-main` / `.chat-inner` / `.composer-zone` / `.composer` 的左右缘，
 *     根上 `--dsc-thread-max` 与 `--dsc-thread-user-max` 的取值，正文列与输入框是否同宽。
 *   H 两条拖拽条：`.thread-handle` 的矩形、计算样式（宽/opacity/pointer-events）、
 *     以及**矩形中心点上真正接住鼠标的元素是谁**（elementFromPoint）。
 *   I 拖动一遍（左把手向外 200px）：拖完再量一次，看正文列宽与输入框宽各变了多少。
 *
 * 运行：node desktop/shots/_verify-thread-drag.mjs
 *      DSC_PROBE_EXE=...\Pneuma.exe node desktop/shots/_verify-thread-drag.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-thread-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const fakePort = 18991
const debugPort = 9367
const sessionId = 'thread-demo'

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-code', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-code', '        name: Fake Code',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

const now = Date.now()
const file = join(dsc, 'sessions', 'demo', `${sessionId}.jsonl`)
writeFileSync(file, [
  { type: 'meta', id: sessionId, cwd: root, createdAt: now - 120000 },
  { type: 'user', text: '这是一段测试正文，看看列宽拖不拖得动。', ts: now - 110000 },
  {
    type: 'assistant',
    text: '好，这一段够长了吗？再补一句，让正文列有内容可以量宽度。',
    reasoning: '',
    ts: now - 100000,
  },
].map((line) => JSON.stringify(line)).join('\n') + '\n')

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
  DSC_RESUME_SESSION: file,
  DSC_NO_EXTERNAL_OPEN: '1',
}
delete env.ELECTRON_RUN_AS_NODE

const fake = spawn(process.execPath, [join(shots, '_verify-code-fake-llm.mjs'), String(fakePort)], { env, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const electron = process.env.DSC_PROBE_EXE
  ? spawn(process.env.DSC_PROBE_EXE, ['--remote-debugging-port=' + String(debugPort)], {
    cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  : spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
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

// 复现报障时的窗口尺寸：PROBE_SIZE=2396x1527 node ...
if (process.env.PROBE_SIZE !== undefined && process.env.PROBE_SIZE !== '') {
  const [w, h] = process.env.PROBE_SIZE.split('x').map(Number)
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await sleep(900)
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
const shot = async (name) => {
  const data = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, name), Buffer.from(data.data, 'base64'))
}

/** 一段通用的几何量测脚本。 */
const geometry = `
  const rectOf = (selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    const rect = node.getBoundingClientRect()
    return { left: Math.round(rect.left), right: Math.round(rect.right), w: Math.round(rect.width) }
  }
  const varOf = (node, name) => node === null ? null : getComputedStyle(node).getPropertyValue(name).trim()
  const root = document.documentElement
  const inner = document.querySelector('.chat-inner')
  const composer = document.querySelector('.composer')
  return {
    win: { w: window.innerWidth, h: window.innerHeight },
    thread: rectOf('.thread-main'),
    inner: rectOf('.chat-inner'),
    zone: rectOf('.composer-zone'),
    composer: rectOf('.composer'),
    entryRow: rectOf('.entry-row'),
    entryText: rectOf('.entry-text'),
    markdown: rectOf('.entry-text .markdown'),
    chain: ['.thread-main', '.chat-wrap', '.chat', '.chat-inner', '.composer-zone', '.composer'].map((selector) => {
      const node = document.querySelector(selector)
      if (node === null) return { selector, missing: true }
      const box = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return {
        selector,
        w: Math.round(box.width),
        left: Math.round(box.left),
        maxW: style.maxWidth,
        width: style.width,
        padL: style.paddingLeft,
        padR: style.paddingRight,
        marL: style.marginLeft,
        marR: style.marginRight,
        parentW: node.parentElement === null ? null : Math.round(node.parentElement.getBoundingClientRect().width),
        parent: node.parentElement === null ? null : node.parentElement.className.toString().slice(0, 40),
      }
    }),
    vars: {
      rootMax: varOf(root, '--dsc-thread-max'),
      rootUser: varOf(root, '--dsc-thread-user-max'),
      innerMax: varOf(inner, '--dsc-thread-max'),
      composerMax: varOf(composer, '--dsc-thread-max'),
    },
  }
`

const handles = `
  const handles = [...document.querySelectorAll('.thread-handle')].map((node) => {
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const cx = Math.round(rect.left + rect.width / 2)
    const cy = Math.round(rect.top + rect.height / 2)
    const hit = document.elementFromPoint(cx, cy)
    return {
      side: node.getAttribute('data-side'),
      rect: { left: Math.round(rect.left), top: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height), cx, cy },
      style: {
        display: style.display,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        position: style.position,
        cursor: style.cursor,
        zIndex: style.zIndex,
        width: style.width,
      },
      hit: hit === null ? null : (hit.className || hit.tagName).toString().slice(0, 80),
      isHandle: hit !== null && hit.closest('.thread-handle') !== null,
    }
  })
  return { count: handles.length, handles }
`

await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.chat-inner .entry-row') !== null) break
    await wait(250)
  }
  await wait(900)
  return true
`)

const before = await evaluate(geometry)
console.log('G-before', JSON.stringify(before, null, 1))
const handleInfo = await evaluate(handles)
console.log('H-handles', JSON.stringify(handleInfo, null, 1))
await shot('_thread-before.png')

/* ── I：拖左把手向外 200px ── */
const left = (handleInfo.handles ?? []).find((item) => item.side === 'left')
if (left === undefined) {
  console.log('没有左把手，跳过拖动')
} else {
  const x0 = left.rect.cx
  const y0 = left.rect.cy
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 })
  for (let step = 1; step <= 10; step += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 - step * 20, y: y0, button: 'left', buttons: 1 })
    await sleep(40)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 - 200, y: y0, button: 'left', clickCount: 1 })
  await sleep(700)
  const after = await evaluate(geometry)
  console.log('I-after', JSON.stringify(after, null, 1))
  console.log('I-delta', JSON.stringify({
    inner: (after.inner?.w ?? 0) - (before.inner?.w ?? 0),
    entryText: (after.entryText?.w ?? 0) - (before.entryText?.w ?? 0),
    markdown: (after.markdown?.w ?? 0) - (before.markdown?.w ?? 0),
    composer: (after.composer?.w ?? 0) - (before.composer?.w ?? 0),
    zone: (after.zone?.w ?? 0) - (before.zone?.w ?? 0),
    rootUser: after.vars?.rootUser,
  }, null, 1))
  await shot('_thread-after.png')
}

try { ws.close() } catch {}
try { electron.kill() } catch {}
try { fake.kill() } catch {}
await sleep(600)
process.exit(0)
