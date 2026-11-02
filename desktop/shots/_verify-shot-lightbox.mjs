process.on('unhandledRejection', () => {})

/**
 * 已发送消息里的贴图：点一下开浮层（2026-11-02 统一观感后的端到端复验）。
 *
 * 之前那支是 `<a target="_blank">`——地址是同源的 `/api/attachments/<sha>`，所以点得开，
 * 但点开是另开一个 Electron 窗口，跟输入框待发贴图那套浮层不是一回事。统一之后：
 * 缩略图是按钮，点开是 `.img-lightbox` 浮层，不新开窗口。
 *
 * 验收口径（四条，缺一不算过）：
 *   ① 气泡里的贴图是 `<button class="entry-shot">`，里面没有 `<a href>`；
 *   ② 点它 → 出现 `.img-lightbox`，浮层里的图与缩略图同一张，且**没有新开窗口**；
 *   ③ Esc 关掉，贴图本身还在；
 *   ④ 再点一次、点遮罩也能关。
 *
 * 运行：node desktop/shots/_verify-shot-lightbox.mjs（依赖桌面产物 desktop/out/）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-shot-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const debugPort = 9347
const sessionId = 'shot-lightbox-demo'

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-shot', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18996/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-shot', '        name: Fake Shot',
  '        contextWindow: 128000', '        maxTokens: 4096',
  '        modalities: [text, image]', '',
].join('\n'))

// 种两张贴图：用 SVG 的 data URL，画得大、看得清位置（贴图本来就是 dataURL 这一族）。
const svg = (title, from, to) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500">` +
  `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
  `<rect width="800" height="500" fill="url(#g)"/>` +
  `<text x="400" y="270" font-family="sans-serif" font-size="64" font-weight="bold" fill="white" text-anchor="middle">${title}</text></svg>`
const dataUrl = (markup) => `data:image/svg+xml;base64,${Buffer.from(markup, 'utf8').toString('base64')}`
const SHOT_ONE = dataUrl(svg('已发送贴图一', '#3b82f6', '#8b5cf6'))
const SHOT_TWO = dataUrl(svg('已发送贴图二', '#f97316', '#ef4444'))

const now = Date.now()
const lines = [
  { type: 'meta', id: sessionId, cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '看这两张图。', images: [SHOT_ONE, SHOT_TWO], ts: now - 50000 },
  { type: 'assistant', text: '收到，两张都看到了。', reasoning: '', ts: now - 40000 },
]
const sessionFile = join(dsc, 'sessions', 'demo', `${sessionId}.jsonl`)
writeFileSync(sessionFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
  DSC_RESUME_SESSION: sessionFile,
}
delete env.ELECTRON_RUN_AS_NODE

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
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
const pressEsc = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}

const failed = []

// ① 气泡里的贴图是按钮
const bubbles = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.entry-user-images .entry-shot') !== null) break
    await wait(250)
  }
  await wait(500)
  const thumbs = [...document.querySelectorAll('.entry-user-images .entry-shot')]
  const box = thumbs.length === 0 ? null : thumbs[0].getBoundingClientRect()
  return {
    count: thumbs.length,
    tag: thumbs.length === 0 ? null : thumbs[0].tagName,
    hasAnchor: document.querySelectorAll('.entry-user-images a').length,
    src: thumbs.length === 0 ? null : thumbs[0].querySelector('img')?.getAttribute('src')?.slice(0, 40) ?? null,
    spot: box === null ? null : { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 },
  }
`)
console.log('bubbles', JSON.stringify(bubbles))
if (bubbles.count !== 2) failed.push(`气泡里应当有 2 张贴图，实际 ${String(bubbles.count)}`)
if (bubbles.tag !== 'BUTTON') failed.push(`贴图的元素是 ${String(bubbles.tag)}，应当是 BUTTON`)
if (bubbles.hasAnchor !== 0) failed.push(`气泡里还有 ${String(bubbles.hasAnchor)} 个 <a>（应当全换成按钮）`)

// ② 点开浮层，且不新开窗口
if (bubbles.spot !== null) {
  const pagesBefore = (await listPages()).length
  await click(bubbles.spot.x, bubbles.spot.y)
  await sleep(600)
  const opened = await evaluate(`
    const box = document.querySelector('.img-lightbox')
    const image = box === null ? null : box.querySelector('img')
    return {
      open: box !== null,
      modal: box === null ? null : box.getAttribute('aria-modal'),
      src: image === null ? null : image.getAttribute('src')?.slice(0, 40) ?? null,
      thumbs: document.querySelectorAll('.entry-user-images .entry-shot').length,
    }
  `)
  console.log('opened', JSON.stringify(opened))
  if (!opened.open) failed.push('点贴图没出现 .img-lightbox 浮层')
  if (opened.modal !== 'true') failed.push(`浮层没有 aria-modal（${String(opened.modal)}）`)
  if (opened.src !== bubbles.src) failed.push('浮层里的图与缩略图不是同一张')
  const pagesAfter = (await listPages()).length
  if (pagesAfter > pagesBefore) failed.push(`点开贴图新开了 ${String(pagesAfter - pagesBefore)} 个窗口（应当就地开浮层）`)
  await shot('_verify-shot-lightbox.png')

  // ③ Esc 关
  await pressEsc()
  await sleep(400)
  const closed = await evaluate(`
    return {
      open: document.querySelector('.img-lightbox') !== null,
      thumbs: document.querySelectorAll('.entry-user-images .entry-shot').length,
    }
  `)
  console.log('afterEsc', JSON.stringify(closed))
  if (closed.open) failed.push('按 Esc 之后浮层还在')
  if (closed.thumbs !== 2) failed.push(`Esc 之后贴图数量变成 ${String(closed.thumbs)}（气泡不该受影响）`)

  // ④ 再开一次，点遮罩关
  await click(bubbles.spot.x, bubbles.spot.y)
  await sleep(600)
  const reopened = await evaluate(`
    return {
      open: document.querySelector('.img-lightbox') !== null,
      width: window.innerWidth,
      height: window.innerHeight,
    }
  `)
  if (!reopened.open) {
    failed.push('第二次点贴图没能再打开浮层')
  } else {
    await click(reopened.width / 2, 10)
    await sleep(400)
    const closedByMask = await evaluate(`return { open: document.querySelector('.img-lightbox') !== null }`)
    console.log('afterMask', JSON.stringify(closedByMask))
    if (closedByMask.open) failed.push('点遮罩之后浮层还在')
  }
}

console.log(failed.length === 0 ? 'PASS 四条口径全过' : `FAIL ${failed.join('；')}`)

try { ws.close() } catch {}
try { electron.kill() } catch {}
await sleep(600)
process.exit(failed.length === 0 ? 0 : 1)
