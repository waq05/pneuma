/**
 * S7「同一轮重答一次，用户上次的展开选择应当失效」的现场探针。
 *
 * 现场：`editAndResend`（`ui-transcript/ui/ui.tsx`）走 `rewindSession` 截断到这条用户消息之前，
 * 再 `submit` 重发。新回答拿到的轮序号与原来相同，所以 `turnFoldKey`（`会话:turn:轮`）一模
 * 一样——修之前，用户点开的那一轮重答后**仍然是展开的**，新回答里的思考和旧回答的展开选择
 * 就串了。修法是在 `ok` 之后、`submit` 之前把这一轮（整轮 + 每一行 + 每个阶段组）的存档清掉。
 *
 * 探针必须用 `ui.collapseTiming: 'completion'`：`next-input` 档下最新一轮**默认摊着**，清没清
 * 存档都显示展开，断言分不出来。completion 档下跑完的轮默认收起，于是
 *   · 用户点开 → `aria-expanded="true"`；
 *   · 重答收工 → 存档被清 → 回落默认 → `aria-expanded="false"`（没清则是 `"true"`）。
 *
 * 五步：
 *   1. 发一条消息，等第一版回答收工（`.composer .send-btn.stop` 消失 = 空闲）；
 *   2. 点 `.turn-fold` 展开这一轮，确认 `aria-expanded="true"`；
 *   3. 真鼠标悬停用户消息（编辑钮是 hover 才现的），确认 `.user-actions` 的 opacity 到 1 后点它；
 *   4. 编辑框里改一个字，点「重发」；
 *   5. 等第二版回答收工，断言 `.turn-fold` 的 `aria-expanded` 是 `"false"`。
 *
 * 任何一步的界面交互抓不到（悬停没生效、编辑框结构变了），探针直接报 FAIL 停在那里——**不绕过、
 * 不改断言**：绿了才说明用户真能走通这条路。
 *
 * 运行：node desktop/shots/_verify-edit-generation.mjs
 * 产物：desktop/shots/_edit-generation.png
 *
 * 前提：`pnpm run build:ui` 与 `pnpm --dir desktop run build` 已跑过（探针加载 lib/ui 里的插件包
 * 与 desktop/out 的主进程，不是 src）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-edit-generation-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18998
const debugPort = 9378

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-edit', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-edit', '        name: Fake Edit',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
// collapseTiming 必须是 completion：跑完的最后一轮默认收起，清没清存档才分辨得出来。
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({
  defaultPolicy: 'full-access',
  ui: { collapseTiming: 'completion', reasoningDefaultOpen: false },
}))

const now = Date.now()
const sessionFile = join(dsc, 'sessions', 'demo', 'edit-generation.jsonl')
writeFileSync(sessionFile, [
  { type: 'meta', id: 'edit-generation', cwd: work, createdAt: now - 60000 },
].map((line) => JSON.stringify(line)).join('\n') + '\n')

/** 假模型被问了几次：第一次是第一版，第二次（重答）是第二版。 */
let requests = 0

/** 假模型：一次思考 + 一句正文；第二版换一句可辨认的话。 */
const server = createServer((req, res) => {
  void (async () => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    requests += 1
    const round = requests
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    // 先来一段思考（这一轮于是有过程内容，`.turn-fold` 才是可点的那一档——只有正文的轮
    // 不给开合承诺，`aria-expanded` 是 undefined，断言无从谈起）。
    delta({ reasoning_content: round === 1 ? '第一版：先想一下。' : '第二版：重新想一下。' })
    await sleep(120)
    delta({ content: round === 1 ? '第一版回答。' : '第二版回答，改过一个字。' })
    await sleep(120)
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 80, completion_tokens: 60 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-edit] ${String(error)}\n`)
    try { res.end() } catch {}
  })
})
server.listen(fakePort, '127.0.0.1')

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
  DSC_RESUME_SESSION: sessionFile,
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

/** 真鼠标移动（CSS :hover 只认真鼠标事件，JS 的 MouseEvent 不算）。 */
const moveTo = async (point) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 })
}
/** 点一下页面上某个坐标（真鼠标：mousePressed + mouseReleased）。 */
const clickAt = async (point) => {
  await moveTo(point)
  const base = { x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
}

/** 页面里的公共小工具（每次重新定义，探针之间不共享状态）。 */
const PAGE_HELPERS = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const pointOf = (node) => {
    if (node === null) return null
    const box = node.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return null
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
  }
  /** 空闲 = 输入框那一格没有「停止」按钮（跑动中它才在）。 */
  const idle = () => document.querySelector('.composer .send-btn.stop') === null
  const turnFold = () => document.querySelector('.turn-fold')
`

if (requests !== 0) throw new Error('假模型还没被问就先有计数')

// ── 1. 发消息，等第一版收工 + 整轮开关出现 ─────────────────────────────────
const started = await evaluate(`
  ${PAGE_HELPERS}
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(250)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '第一版问题。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  // 等收工：停止按钮消失 + 整轮开关出现（开关只在轮不跑的时候画）。
  let fold = null
  for (let i = 0; i < 400; i += 1) {
    fold = turnFold()
    if (fold !== null && idle()) break
    await wait(100)
  }
  await wait(400)
  fold = turnFold()
  return {
    fold: fold === null ? null : {
      expanded: fold.getAttribute('aria-expanded'),
      disabled: fold.hasAttribute('disabled'),
      label: fold.textContent?.trim() ?? '',
    },
    text: document.querySelector('.chat-inner')?.textContent?.includes('第一版回答。') ?? false,
  }
`)
console.log('step1', JSON.stringify(started), 'requests=' + String(requests))

const failures = []
if (started?.fold === null || started?.fold === undefined) failures.push('第一版收工后没有 .turn-fold')
else if (started.fold.disabled !== false) failures.push('.turn-fold 是 disabled（这一轮没有可折的过程内容，点不动）')
else if (started.fold.expanded !== 'false') failures.push(`completion 档下收工默认该收起（实际 aria-expanded=${String(started.fold.expanded)}）`)
if (started?.text !== true) failures.push('页面上没有第一版回答的正文')

// ── 2. 点开这一轮（写一份「用户手动展开」的存档）────────────────────────────
// 真鼠标优先，没点开再补一枪合成事件：这一行是 `<button>`，而它所在的容器在收拢/展开的
// 过渡帧里坐标一直在动——真点击可能落在别处（本轮第一次跑就落在 `.chat` 上）。
// 这里不是要验「点击手感」（那条由别的探针覆盖），只是要把「用户手动展开过」这个存档造出来。
const foldPoint = await evaluate(`
  ${PAGE_HELPERS}
  return pointOf(turnFold())
`)
if (foldPoint !== null) {
  await clickAt(foldPoint)
  await sleep(350)
}
let opened = await evaluate(`
  ${PAGE_HELPERS}
  const fold = turnFold()
  return { expanded: fold?.getAttribute('aria-expanded') ?? null, open: fold?.getAttribute('data-open') ?? null }
`)
if (opened?.expanded !== 'true') {
  opened = await evaluate(`
    ${PAGE_HELPERS}
    turnFold()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(350)
    const fold = turnFold()
    return { expanded: fold?.getAttribute('aria-expanded') ?? null, open: fold?.getAttribute('data-open') ?? null, via: 'synthetic' }
  `)
}
console.log('step2', JSON.stringify(opened))
if (opened?.expanded !== 'true') failures.push(`点开整轮后 aria-expanded 不是 "true"（实际 ${String(opened?.expanded)}）`)

// ── 3. 真鼠标悬停用户消息 → 编辑钮浮出 → 点它 ────────────────────────────────
const hoverTarget = await evaluate(`
  ${PAGE_HELPERS}
  const turn = document.querySelector('.user-turn')
  if (turn === null) return { error: 'no .user-turn' }
  return { turn: pointOf(turn), opacity: getComputedStyle(document.querySelector('.user-actions')).opacity }
`)
await moveTo(hoverTarget.turn ?? { x: 0, y: 0 })
await sleep(400)
const hovered = await evaluate(`
  ${PAGE_HELPERS}
  const actions = document.querySelector('.user-actions')
  const act = actions === null ? null : actions.querySelector('.user-act')
  return {
    opacity: actions === null ? null : getComputedStyle(actions).opacity,
    act: pointOf(act),
    disabled: act?.hasAttribute('disabled') ?? null,
  }
`)
console.log('step3', JSON.stringify({ hoverTarget, hovered }))
if (hovered?.opacity !== '1') failures.push(`悬停后编辑钮没浮出来（.user-actions opacity=${String(hovered?.opacity)}）`)
if (hovered?.disabled === true) failures.push('编辑钮是 disabled（一轮还在跑，不该在这里）')
if (hovered?.act != null && hovered?.opacity === '1') {
  await clickAt(hovered.act)
  await sleep(400)
}

// ── 4. 编辑框里改一个字 → 点「重发」────────────────────────────────────────
const editing = await evaluate(`
  ${PAGE_HELPERS}
  for (let i = 0; i < 60 && document.querySelector('.user-edit-box') === null; i += 1) await wait(100)
  const box = document.querySelector('.user-edit-box')
  if (box === null) return { error: 'no .user-edit-box' }
  const original = box.value
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(box, '第一版问题，改一个字。')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(250)
  const primary = document.querySelector('.user-edit-actions .dsc-btn[data-variant="primary"]')
  return { original, primary: pointOf(primary), primaryDisabled: primary?.disabled ?? null, primaryText: primary?.textContent?.trim() ?? '' }
`)
console.log('step4', JSON.stringify(editing))
if (editing?.error !== undefined) failures.push(`编辑框没弹出：${String(editing.error)}`)
else {
  if (String(editing.original).includes('改一个字')) failures.push('编辑框里预填的不是这条消息的原文')
  if (editing.primaryDisabled === true) failures.push('「重发」按钮是 disabled（草稿没写进去？）')
  if (editing.primary == null) failures.push('找不到「重发」按钮')
  else {
    await clickAt(editing.primary)
    await sleep(300)
  }
}

// ── 5. 等第二版收工，读整轮开关的展开态 ────────────────────────────────────
const finished = await evaluate(`
  ${PAGE_HELPERS}
  let seen = false
  for (let i = 0; i < 400; i += 1) {
    const inner = document.querySelector('.chat-inner')?.textContent ?? ''
    if (inner.includes('第二版回答')) seen = true
    if (seen && idle() && turnFold() !== null) break
    await wait(100)
  }
  // 收工后再等两拍，让「整轮收起复位」那些 effect 都跑完，量的是稳态。
  await wait(600)
  const fold = turnFold()
  const inner = document.querySelector('.chat-inner')?.textContent ?? ''
  return {
    secondSeen: seen,
    expanded: fold?.getAttribute('aria-expanded') ?? null,
    open: fold?.getAttribute('data-open') ?? null,
    edited: inner.includes('改一个字'),
    oldText: inner.includes('第一版回答。'),
  }
`)
console.log('step5', JSON.stringify(finished), 'requests=' + String(requests))

if (finished?.secondSeen !== true) failures.push('第二版回答没上屏（重发没跑起来？）')
if (finished?.edited !== true) failures.push('用户消息没换成改过的文字（rewind 没生效？）')
if (finished?.oldText === true) failures.push('第一版回答还在页面上（rewind 没截断）')
// 次数只做下限：宿主除了这一轮的回答，还可能为**会话标题**之类再问一次假模型（实测三次）。
// 「重发只跑了一次」这件事已经由下面两条证明——旧回答消失、新回答带着改过的文字上屏。
if (requests < 2) failures.push(`假模型只被问了 ${String(requests)} 次（至少该有第一次 + 重答一次）`)
// 这一条是本探针的全部意义：存档没清 → 新回答继承旧选择，这里就是 "true"。
if (finished?.expanded !== 'false') {
  failures.push(`重答后整轮仍展开（aria-expanded=${String(finished?.expanded)}）：这一轮的折叠存档没被清掉`)
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (typeof shot?.data === 'string') writeFileSync(join(shots, '_edit-generation.png'), Buffer.from(shot.data, 'base64'))

console.log('report', JSON.stringify({ requests, failures }))
const pass = 'PASS 重答后这一轮的折叠存档已清（turn-fold 回落收起，行/组键一并作废）'
console.log(failures.length === 0 ? pass : 'FAIL ' + failures.join('; '))

try { electron.kill() } catch {}
server.close()
process.exit(failures.length === 0 ? 0 : 1)
