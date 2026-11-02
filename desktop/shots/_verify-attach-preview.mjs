process.on('unhandledRejection', () => {})

/**
 * 输入框上方「待发送贴图」的预览浮层（2026-11-02 报障的端到端复验）。
 *
 * 起因：用户把几张截图拖进输入框，缩略图点不开——旧界面那个 `.img-lightbox` 在移植时
 * 只剩 CSS、没有组件，<a> 又因为 data: URL 被浏览器拦住。改完之后缩略图是一颗按钮，
 * 点一下开浮层，点遮罩或 Esc 关。
 *
 * 验收口径（四条，缺一不算过）：
 *   ① 往输入框丢一张 PNG，出现一张 `data-kind="image"` 的待发贴图；
 *   ② 点缩略图，出现 `.img-lightbox` 浮层，且里面那张图的 src 与缩略图一致；
 *   ③ 按 Esc 浮层消失，缩略图还在（没把附件顺手删掉）；
 *   ④ 再点开一次、这次点遮罩，浮层也能关（两条关闭路径都要通）。
 *
 * 运行：node desktop/shots/_verify-attach-preview.mjs（依赖桌面产物 desktop/out/）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-attach-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const debugPort = 9346

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-attach', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18997/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-attach', '        name: Fake Attach',
  '        contextWindow: 128000', '        maxTokens: 4096',
  '        modalities: [text, image]', '',
].join('\n'))

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
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

const failed = []

// ① 丢一张画出来的 PNG 进输入框（合成 DataTransfer：真实 drop 事件的形状）
const dropped = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.composer') !== null) break
    await wait(250)
  }
  await wait(600)
  const target = document.querySelector('.composer')
  if (target === null) return { error: 'no composer' }
  // 现画一张 800×500 的图：小到只有 1px 的图在浮层里也是一像素，看不出位置对不对。
  const canvas = document.createElement('canvas')
  canvas.width = 800
  canvas.height = 500
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, 800, 500)
  gradient.addColorStop(0, '#3b82f6')
  gradient.addColorStop(1, '#f97316')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 800, 500)
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = 'bold 64px sans-serif'
  ctx.fillText('待发贴图预览', 150, 280)
  const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/png') })
  const file = new File([blob], 'shot.png', { type: 'image/png' })
  const dt = new DataTransfer()
  dt.items.add(file)
  for (const type of ['dragenter', 'dragover', 'drop']) {
    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
  }
  for (let i = 0; i < 80; i += 1) {
    if (document.querySelector('.attach-item[data-kind="image"] .attach-zoom') !== null) break
    await wait(100)
  }
  const thumb = document.querySelector('.attach-item[data-kind="image"] .attach-zoom')
  const item = document.querySelector('.attach-item[data-kind="image"]')
  return {
    hasItem: item !== null,
    hasZoomButton: thumb !== null,
    tagName: thumb === null ? null : thumb.tagName,
    items: document.querySelectorAll('.attach-item').length,
  }
`)
console.log('dropped', JSON.stringify(dropped))
if (!dropped.hasItem) failed.push('丢一张 PNG 之后没出现待发贴图')
if (!dropped.hasZoomButton) failed.push('待发贴图的缩略图不是可点的按钮（找不到 .attach-zoom）')
if (dropped.tagName !== 'BUTTON') failed.push(`缩略图的元素是 ${String(dropped.tagName)}，应当是 BUTTON`)

// ② 点缩略图开浮层
const openFlow = async () => evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const thumb = document.querySelector('.attach-item[data-kind="image"] .attach-zoom')
  if (thumb === null) return { error: 'no thumb' }
  const box = thumb.getBoundingClientRect()
  const image = thumb.querySelector('img')
  return {
    x: (box.left + box.right) / 2,
    y: (box.top + box.bottom) / 2,
    thumbSrc: image === null ? null : image.getAttribute('src'),
  }
`)
const spot = await openFlow()
if (spot.error === undefined) {
  await click(spot.x, spot.y)
  await sleep(500)
  const opened = await evaluate(`
    const box = document.querySelector('.img-lightbox')
    const image = box === null ? null : box.querySelector('img')
    return {
      open: box !== null,
      modal: box === null ? null : box.getAttribute('aria-modal'),
      src: image === null ? null : image.getAttribute('src'),
      thumbs: document.querySelectorAll('.attach-item[data-kind="image"]').length,
    }
  `)
  console.log('opened', JSON.stringify(opened))
  if (!opened.open) failed.push('点缩略图没出现 .img-lightbox 浮层')
  if (opened.modal !== 'true') failed.push(`浮层没有 aria-modal（${String(opened.modal)}）`)
  if (opened.src === null || spot.thumbSrc === null || opened.src.slice(0, 40) !== spot.thumbSrc.slice(0, 40)) {
    failed.push('浮层里的图与缩略图不是同一张')
  }
  await shot('_verify-attach-preview.png')

  // ③ Esc 关：浮层消失、贴图还在
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(400)
  const closed = await evaluate(`
    return {
      open: document.querySelector('.img-lightbox') !== null,
      thumbs: document.querySelectorAll('.attach-item[data-kind="image"]').length,
    }
  `)
  console.log('afterEsc', JSON.stringify(closed))
  if (closed.open) failed.push('按 Esc 之后浮层还在')
  if (closed.thumbs !== 1) failed.push(`Esc 之后待发贴图数量变成 ${String(closed.thumbs)}（不该被一起清掉）`)

  // ④ 再开一次，点遮罩关
  await click(spot.x, spot.y)
  await sleep(500)
  const reopened = await evaluate(`
    const box = document.querySelector('.img-lightbox')
    return { open: box !== null, width: window.innerWidth, height: window.innerHeight }
  `)
  if (!reopened.open) {
    failed.push('第二次点缩略图没能再打开浮层')
  } else {
    await click(reopened.width / 2, 12)
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
