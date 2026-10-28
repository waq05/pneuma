/**
 * 实机验证：对话流「过程区」改成了参考实现那种清爽样子（2026-10-29）。
 *
 * 复用 desktop/shots/step-seed.mjs 造出的静态样张（隔离 HOME，不碰真实 ~/.dsc），
 * 打开一条有工具调用的会话，然后截三张图：
 *   1. 静息：一行工具调用没有任何框、没有底色；
 *   2. 悬停：CDP 真发鼠标移动，页面里用 element.matches(':hover') 自证命中，
 *      同时读计算样式证明背景仍是 transparent；
 *   3. 点开：真点 .tool-click，读 .open 与展开体，证明「文字段才是开关」。
 *
 * 顺带读三组读数（写进 stdout，图之外也能核对）：
 *   - 卡片 / 头行的 border、background、height（应为 0 / transparent / 24px）；
 *   - done 态状态词为空（不再有「完成」两个字）；
 *   - 点击行尾的状态词不应展开（只有 .tool-click 触发）。
 *
 * 用法：node desktop/shots/_verify-tool-row-flat.mjs
 *
 * @module desktop/shots/_verify-tool-row-flat
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, 'step-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const debugPort = 9342
const sessionDir = join(dsc, 'sessions', 'D-dsc')

if (!existsSync(sessionDir)) throw new Error('先跑 node desktop/shots/step-seed.mjs（缺 ' + sessionDir + '）')
// 静态样张的文件名是随机 id：按大小挑最大那份（step-seed 里它含 4 轮、几十条工具）。
const sessionFile = readdirSync(sessionDir)
  .filter((name) => name.endsWith('.jsonl'))
  .map((name) => ({ name, size: statSync(join(sessionDir, name)).size }))
  .sort((a, b) => b.size - a.size)[0]
if (sessionFile === undefined) throw new Error('没有会话文件')
const sessionPath = join(sessionDir, sessionFile.name).replace(/\\/g, '/')

mkdirSync(userData, { recursive: true })
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
for (let i = 0; i < 60; i += 1) {
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

const evaluate = async (body) => {
  const result = await send('Runtime.evaluate', {
    expression: '(async () => { ' + body + ' })()',
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800))
  return result.result?.value
}

const shot = async (name) => {
  const png = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, name), Buffer.from(png.data, 'base64'))
  return name
}

await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 60; i += 1) {
    if (typeof window.dsc !== 'undefined' && document.querySelector('.composer textarea') !== null) break
    await wait(500)
  }
  await window.dsc.invoke('openSession', [${JSON.stringify(sessionPath)}])
  await wait(2200)
  // 三层显隐从外向内：整轮 → 阶段组 → 工具卡自己。全部展开，才看得到一行行工具调用。
  for (const turn of document.querySelectorAll('.turn-fold')) {
    if (turn.getAttribute('aria-expanded') === 'false') turn.click()
  }
  await wait(300)
  for (const group of document.querySelectorAll('.step-fold')) {
    if (!group.hasAttribute('data-open')) group.click()
  }
  await wait(400)
  const chat = document.querySelector('.chat')
  if (chat !== null) chat.scrollTop = chat.scrollHeight
  await wait(800)
  return { session: ${JSON.stringify(sessionFile.name)}, cards: document.querySelectorAll('.tool-card').length }
`).then((v) => console.log('boot', JSON.stringify(v)))

// 选一张 done 的工具卡，滚到视口中间；鼠标先移到角落，保证静息态没有任何 :hover。
const target = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const cards = Array.from(document.querySelectorAll('.tool-card.status-done'))
  const pick = cards.find((card) => {
    const rect = card.getBoundingClientRect()
    return rect.height > 0 && card.querySelector('.tool-click') !== null
  })
  if (!pick) return { error: 'no done card', total: document.querySelectorAll('.tool-card').length }
  pick.scrollIntoView({ block: 'center' })
  await wait(600)
  const rect = pick.getBoundingClientRect()
  const head = pick.querySelector('.tool-head')
  const click = pick.querySelector('.tool-click')
  const cardStyle = getComputedStyle(pick)
  const headStyle = getComputedStyle(head)
  return {
    text: (click && click.innerText || '').trim(),
    statusText: (pick.querySelector('.status') || {}).innerText || '',
    cardBorder: cardStyle.borderTopWidth + ' ' + cardStyle.borderTopStyle + ' ' + cardStyle.borderTopColor,
    cardBackground: cardStyle.backgroundColor,
    headBackground: headStyle.backgroundColor,
    cardHeight: Math.round(pick.getBoundingClientRect().height),
    headHeight: Math.round(head.getBoundingClientRect().height),
    clickRect: { x: Math.round(rect.left + click.getBoundingClientRect().left - rect.left), y: 0, w: Math.round(click.getBoundingClientRect().width), h: Math.round(click.getBoundingClientRect().height) },
    abs: { x: Math.round(click.getBoundingClientRect().left + click.getBoundingClientRect().width / 2), y: Math.round(click.getBoundingClientRect().top + click.getBoundingClientRect().height / 2) },
  }
`)
console.log('rest', JSON.stringify(target))
if (target.error !== undefined) {
  try { ws.close() } catch {}
  try { electron.kill() } catch {}
  throw new Error(target.error)
}

// 鼠标移到角落，等一帧，确认没有行处于 hover。
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
await sleep(250)
const restHover = await evaluate(`return { hovering: document.querySelectorAll('.tool-head:hover, .tool-click:hover').length }`)
console.log('rest-hover', JSON.stringify(restHover))
console.log('rest-shot', await shot('_verify-tool-row-flat-rest.png'))

// 悬停：真的发移动事件，页面里用 :hover 自证；再读背景色。
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.abs.x, y: target.abs.y })
await sleep(300)
const hover = await evaluate(`
  const card = Array.from(document.querySelectorAll('.tool-card.status-done')).find((c) => {
    const click = c.querySelector('.tool-click')
    return click !== null && click.matches(':hover')
  })
  if (!card) return { hovering: false }
  const head = card.querySelector('.tool-head')
  const click = card.querySelector('.tool-click')
  const verb = card.querySelector('.verb')
  const preview = card.querySelector('.preview')
  return {
    hovering: true,
    headBackground: getComputedStyle(head).backgroundColor,
    clickBackground: getComputedStyle(click).backgroundColor,
    verbColor: getComputedStyle(verb).color,
    previewColor: getComputedStyle(preview).color,
  }
`)
console.log('hover', JSON.stringify(hover))
console.log('hover-shot', await shot('_verify-tool-row-flat-hover.png'))

// 点文字段：真发一组鼠标按下/抬起（与用户点击同一条路径）。
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.abs.x, y: target.abs.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.abs.x, y: target.abs.y, button: 'left', clickCount: 1 })
await sleep(700)
const opened = await evaluate(`
  const card = Array.from(document.querySelectorAll('.tool-card')).find((c) => c.classList.contains('open'))
  if (!card) return { open: false }
  const style = getComputedStyle(card.querySelector('.tool-head'))
  const bar = card.querySelector('.tc-bar')
  return {
    open: true,
    statusText: (card.querySelector('.status') || {}).innerText || '',
    hasCompleteWord: (card.querySelector('.status') || {}).innerText === '完成',
    headHeight: Math.round(card.querySelector('.tool-head').getBoundingClientRect().height),
    headBackground: style.backgroundColor,
    bodyVisible: card.querySelector('.tool-body') !== null,
    bar: bar === null ? null : getComputedStyle(bar).position,
  }
`)
console.log('open', JSON.stringify(opened))
console.log('open-shot', await shot('_verify-tool-row-flat-open.png'))

// 负数：点行尾状态词不应展开（把刚展开的这张收起后，点状态词）。
const tailHit = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const card = Array.from(document.querySelectorAll('.tool-card.open'))[0]
  if (!card) return { skipped: true }
  card.querySelector('.tool-click').click()
  await wait(400)
  const status = card.querySelector('.status')
  if (status === null) return { skipped: true }
  status.click()
  await wait(400)
  return { stillClosed: !card.classList.contains('open') }
`)
console.log('tail-click', JSON.stringify(tailHit))

// 缩进分级：组头图标、组体竖线、组内思考星标与工具状态点各在哪一条竖线。
const indent = await evaluate(`
  const body = document.querySelector('.step-content')
  const group = document.querySelector('.step-fold')
  if (!body || !group) return { skipped: true }
  const left = (el) => (el === null ? null : Math.round(el.getBoundingClientRect().left))
  const think = body.querySelector('.think-block')
  const tool = body.querySelector('.tool-card')
  return {
    group: left(group),
    groupIcon: left(group.querySelector('.step-fold-icon')),
    body: left(body),
    think: left(think),
    thinkStar: left(think && think.querySelector('.think-star')),
    tool: left(tool),
    toolDot: left(tool && tool.querySelector('.tool-dot')),
  }
`)
console.log('indent', JSON.stringify(indent))

try { ws.close() } catch {}
try { electron.kill() } catch {}
await sleep(400)
console.log('DONE')
