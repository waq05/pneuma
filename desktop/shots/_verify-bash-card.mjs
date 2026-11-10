/**
 * 「bash 工具卡是终端块」的现场探针（差距清单 S4 的第一张专用卡）。
 *
 * 改之前：所有工具共用一张通用卡——参数表里一行 `{"command":"…"}`，结果缩在「输出」那一格，
 * 读起来像参数而不是一次命令的回显。改之后：bash 系工具换一张「`$ 命令` / 输出 / 退出码徽章」
 * 的终端块，参数表与结果尾巴都不再出现。
 *
 * 这个探针造一条真的调用：假模型第一跳吐一个 `bash` 调用
 * （`{"command":"echo 自检输出; exit 3"}`，命令本身无副作用），宿主真的把它跑掉，第二跳给
 * 一句正文收工。然后在页面上核四件事：
 *
 *   1. `.tc-bash` 在场，`data-bash-state` 最终是 `done`；
 *   2. `.tc-bash-cmd` 的文本里有 `echo 自检输出`（命令原文，不是 JSON）；
 *   3. `.tc-bash-out` 的文本里有 `自检输出`，**且没有 `退出码 3` 那一行**（被摘掉了：
 *      它已经变成下面那枚徽章，正文里再出现一次就是同一句话两遍）；
 *   4. `.tc-bash-exit` 的文本里有 `3` 且 `data-exit="bad"`（非 0 走红色那一档）。
 *
 * 两处与产品设置有关的刻意做法：
 *  - `defaultPolicy: 'full-access'`：这条命令要真的跑起来，不能卡在审批卡上（与
 *    `_verify-review-fold.mjs` 同一个做法）；
 *  - `toolDefaultOpen: true` + `collapseTiming: 'next-input'`：终端块只在展开体里渲染，
 *    默认收起的话页面上根本没有 `.tc-bash`；收工后过程区也要摊着，截图才看得见。
 *    仍然留了一条真鼠标点开的兜底：万一默认档没生效，就照用户的操作点开。
 *
 * 运行：node desktop/shots/_verify-bash-card.mjs
 * 产物：desktop/shots/_bash-card.png
 *
 * 前提：`pnpm run build:ui` 已跑过（探针加载的是 lib/ui 里的插件包，不是 src）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-bash-card-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18996
const debugPort = 9376

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-bash', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-bash', '        name: Fake Bash',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
// 命令要真的跑（不能停在审批卡上）；工具卡默认展开（终端块在展开体里）。
// collapseTiming 用 next-input：跑完的最后一轮先摊着，截图才拍得到卡片本身。
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({
  defaultPolicy: 'full-access',
  ui: { toolDefaultOpen: true, collapseTiming: 'next-input' },
}))

const now = Date.now()
writeFileSync(
  join(dsc, 'sessions', 'demo', 'bash-card.jsonl'),
  [
    { type: 'meta', id: 'bash-card', cwd: work, createdAt: now - 60000 },
    { type: 'user', text: '跑一条命令，然后说一句话。', ts: now - 50000 },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n',
)

/** 探针要的那条命令：印一行中文再以 3 退出（非 0 才会让宿主写「退出码 3」那一行）。 */
const COMMAND = 'echo 自检输出; exit 3'

/** 假模型：第一跳调 bash，第二跳（历史里有 tool 结果）给正文收工。 */
const server = createServer((req, res) => {
  void (async () => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const messages = (() => {
      try {
        const parsed = JSON.parse(body)
        return Array.isArray(parsed.messages) ? parsed.messages : []
      } catch { return [] }
    })()
    const hasToolResult = messages.some((message) => message.role === 'tool')
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    if (!hasToolResult) {
      // 名字与参数一次送齐：宿主据此把这次调用挂进会话，真去跑那条命令。
      delta({
        tool_calls: [{
          index: 0,
          id: 'call_bash_card_1',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: COMMAND }) },
        }],
      })
      delta({}, 'tool_calls')
    } else {
      delta({ content: '命令跑完了，退出码不是 0。' })
      await sleep(80)
      delta({}, 'stop')
    }
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 200 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-bash] ${String(error)}\n`)
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

/** 点一下页面上某个坐标（真鼠标：mousePressed + mouseReleased）。 */
const clickAt = async (point) => {
  const base = { x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
}

/** 页面里常用的几件小工具（每次重新定义，探针之间不共享状态）。 */
const PAGE_HELPERS = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  /** 终端块此刻的样子：四段文本一次读完，免得跨帧读到半截。 */
  const bashSnap = () => {
    const card = document.querySelector('.tc-bash')
    if (card === null) return { present: false }
    const exit = card.querySelector('.tc-bash-exit')
    return {
      present: true,
      state: card.getAttribute('data-bash-state'),
      cmd: card.querySelector('.tc-bash-cmd')?.textContent ?? '',
      out: card.querySelector('.tc-bash-out')?.textContent ?? '',
      exit: exit?.textContent ?? '',
      exitTone: exit?.getAttribute('data-exit') ?? null,
      time: card.querySelector('.tc-bash-time')?.textContent ?? null,
    }
  }
  const toolHeadPoint = () => {
    const head = document.querySelector('.tool-card .tool-click')
    if (head === null) return null
    const box = head.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return null
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
  }
`

// ── 1. 发消息，等这次 bash 调用落地 ────────────────────────────────────────
const started = await evaluate(`
  ${PAGE_HELPERS}
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(250)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '跑一条命令，然后说一句话。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  // 等工具卡出现并落定（status-done）：命令跑完才算有退出码可读。
  let head = null
  for (let i = 0; i < 400; i += 1) {
    head = toolHeadPoint()
    const card = document.querySelector('.tool-card')
    if (head !== null && card !== null && card.classList.contains('status-done')) break
    await wait(100)
  }
  return { head, snap: bashSnap() }
`)
if (started?.error !== undefined) throw new Error(String(started.error))
console.log('started', JSON.stringify({ head: started?.head, snap: started?.snap }))

// ── 2. 收起态兜底：用真鼠标点开工具卡头（默认档没生效时才走这一步）───────────
if (started?.snap?.present !== true && started?.head != null) {
  await clickAt(started.head)
  await sleep(400)
  console.log('clicked 工具卡头（默认展开没生效，照用户的操作点开）')
}
const expanded = await evaluate(`
  ${PAGE_HELPERS}
  // 点开之后等终端块出现，并且等到这次调用落定（data-bash-state 到 done 为止）。
  let snap = bashSnap()
  for (let i = 0; i < 300 && snap.present !== true; i += 1) {
    await wait(100)
    snap = bashSnap()
  }
  for (let i = 0; i < 200 && snap.state !== 'done'; i += 1) {
    await wait(100)
    snap = bashSnap()
  }
  return snap
`)
if (expanded?.present !== true) {
  const point = await evaluate(`
    ${PAGE_HELPERS}
    return toolHeadPoint()
  `)
  if (point !== null) {
    await clickAt(point)
    await sleep(500)
  }
}
const final = await evaluate(`
  ${PAGE_HELPERS}
  let snap = bashSnap()
  for (let i = 0; i < 200 && snap.present !== true; i += 1) {
    await wait(100)
    snap = bashSnap()
  }
  return snap
`)
console.log('snap', JSON.stringify(final))
console.log('pos', JSON.stringify({ state: final?.state, cmd: final?.cmd, out: final?.out, exit: final?.exit }))

// 截图前必须确认这条卡**真的看得见**：`.tc-bash` 在 DOM 里不等于在屏幕上——阶段组默认是
// 收着的（组体 `content-visibility: hidden` + 高度 0），收着时断言全过、照片上却只有一行
// 组头。判展开看组头自己的 `data-open`（不要用高度：组体收着时里面的行照样有布局高度）。
const visible = await evaluate(`
  ${PAGE_HELPERS}
  const openGroup = () => document.querySelector('.step-fold')?.getAttribute('data-open') === '1'
  if (!openGroup()) {
    document.querySelector('.step-fold')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(400)
  }
  const block = document.querySelector('.tc-bash')
  const box = block?.getBoundingClientRect() ?? null
  return { groupOpen: openGroup(), w: Math.round(box?.width ?? 0), h: Math.round(box?.height ?? 0) }
`)
console.log('visible', JSON.stringify(visible))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (typeof shot?.data === 'string') writeFileSync(join(shots, '_bash-card.png'), Buffer.from(shot.data, 'base64'))

// ── 3. 判 ───────────────────────────────────────────────────────────────────
const failures = []
const snap = final ?? { present: false }
const outText = String(snap.out ?? '')
const exitText = String(snap.exit ?? '')
if (snap.present !== true) failures.push('页面上没有 .tc-bash（终端块没渲染出来）')
if (snap.state !== 'done') failures.push(`data-bash-state 最终不是 done（实际 ${String(snap.state)}）`)
if (!String(snap.cmd ?? '').includes('echo 自检输出')) {
  failures.push(`.tc-bash-cmd 里没有命令原文（实际「${String(snap.cmd ?? '').slice(0, 80)}」）`)
}
if (!outText.includes('自检输出')) {
  failures.push(`.tc-bash-out 里没有命令输出（实际「${outText.slice(0, 80)}」）`)
}
if (outText.includes('退出码 3')) {
  failures.push('输出正文里还留着「退出码 3」那一行（应该被摘掉、只留徽章）')
}
if (!exitText.includes('3')) failures.push(`.tc-bash-exit 里没有 3（实际「${exitText}」）`)
if (snap.exitTone !== 'bad') failures.push(`退出码徽章不是 data-exit="bad"（实际 ${String(snap.exitTone)}）`)
// 看得见才算数：DOM 里有、屏幕上没有（阶段组收着）时，上面那些断言全会假绿。
if (visible?.groupOpen !== true) failures.push('阶段组没收开（照片上只会有一行组头）')
if ((visible?.h ?? 0) < 20) failures.push(`终端块在屏幕上没有高度（实际 ${String(visible?.h)}px）`)

console.log('report', JSON.stringify({ snap, failures }))
const pass = 'PASS bash 卡是终端块（$ 命令 / 输出 / 退出码 3 徽章），退出码那一行已从正文摘掉'
console.log(failures.length === 0 ? pass : 'FAIL ' + failures.join('; '))

try { electron.kill() } catch {}
server.close()
process.exit(failures.length === 0 ? 0 : 1)
