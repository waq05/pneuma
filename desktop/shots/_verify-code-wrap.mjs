process.on('unhandledRejection', () => {})

/**
 * 右侧栏文件预览「折行」的验收探针（2026-11-10 报障：超长行不折行、右半截被裁在面板外）。
 *
 * 四段事实：
 *   A 默认折行：<pre> 的 scrollWidth 不超过 clientWidth（不再横向溢出），
 *     计算样式 white-space 是 pre-wrap，整块代码的高度明显超过「逻辑行数 × 行高」
 *     （说明真的折了行），且行数没有翻倍（shiki 的行间换行符被正确折叠）。
 *   B 悬挂缩进：一条折了行的行，续行的左缘与首行文字的左缘对齐、且首行文字让开了行号列。
 *   C 关掉折行：同一份文件恢复横向滚动（scrollWidth > clientWidth），视觉行数回到逻辑行数。
 *   D 开关本身：头部有一颗 aria-pressed 的「折行」按钮，点一下 true → false。
 *
 * 两种状态各截一张图（_wrap-A-on.png / _wrap-C-off.png）。
 *
 * 运行：node desktop/shots/_verify-code-wrap.mjs
 *      DSC_PROBE_EXE=...\Pneuma.exe node desktop/shots/_verify-code-wrap.mjs（打包产物同验）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-wrap-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const fakePort = 18989
const debugPort = 9365
const sessionId = 'wrap-demo'
/** 要预览的文件：根 package.json 里既有短行，也有超长的 dependencies 行。 */
const target = join(root, 'package.json')
const targetLines = readFileSync(target, 'utf8').split('\n').length

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
  // cwd 设成仓库根：fs-read 只放行会话工作目录里的文件，根之外的读会被挡。
  { type: 'meta', id: sessionId, cwd: root, createdAt: now - 120000 },
  { type: 'user', text: '看一眼这个文件。', ts: now - 110000 },
  {
    type: 'assistant',
    text: ['点这里开预览：[package.json](' + target + ')'].join('\n'),
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

const failed = []
const check = (ok, message) => {
  if (!ok) failed.push(message)
}

/** 开预览：等正文出来 → 点文件链接 → 等预览页签把代码画出来。 */
const openPreview = async () => {
  for (let i = 0; i < 120; i += 1) {
    const ready = await evaluate(`
      return document.querySelectorAll('.chat-inner .file-md a').length > 0
    `)
    if (ready === true) break
    await sleep(250)
  }
  await sleep(800)
  const box = await evaluate(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const anchor = document.querySelector('.chat-inner .file-md a')
    if (anchor === null) return null
    anchor.scrollIntoView({ block: 'center' })
    await wait(400)
    const rect = anchor.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  `)
  if (box === null) throw new Error('正文里没找到文件链接')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  for (let i = 0; i < 40; i += 1) {
    const ready = await evaluate(`
      return document.querySelectorAll('.file-code-body .line').length > 0
    `)
    if (ready === true) break
    await sleep(250)
  }
  await sleep(600)
}

/** 同一个测量脚本，折行开/关两种状态共用。 */
const measure = `
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  await wait(300)
  const pre = document.querySelector('.file-code-body > pre.shiki')
  if (pre === null) return { error: '预览里没有 shiki 的 <pre>' }
  const lines = [...pre.querySelectorAll('code > .line')]
  const style = getComputedStyle(pre)
  const lineHeight = Number.parseFloat(style.lineHeight)
  // 折行后 .line 是块级盒子：数「折了几行」只能看高度（一根 Range 的矩形会被高亮
  // span 拆成好几段，拿去数视觉行会虚高）。
  const tall = lines.find((node) => node.getBoundingClientRect().height > lineHeight * 1.5)
  let hangs = null
  if (tall !== undefined) {
    const range = document.createRange()
    range.selectNodeContents(tall)
    const byTop = new Map()
    for (const rect of range.getClientRects()) {
      if (rect.height <= 0) continue
      const key = Math.round(rect.top)
      const seen = byTop.get(key)
      if (seen === undefined || rect.left < seen) byTop.set(key, rect.left)
    }
    const lefts = [...byTop.entries()].sort((a, b) => a[0] - b[0]).map((entry) => Math.round(entry[1]))
    hangs = {
      rows: lefts.length,
      firstLeft: lefts[0],
      secondLeft: lefts[1] === undefined ? null : lefts[1],
      boxLeft: Math.round(tall.getBoundingClientRect().left),
      height: Math.round(tall.getBoundingClientRect().height),
    }
  }
  const wrapButton = document.querySelector('.file-preview-wrap')
  return {
    lines: lines.length,
    lineHeight,
    pre: {
      scrollWidth: pre.scrollWidth,
      clientWidth: pre.clientWidth,
      scrollHeight: pre.scrollHeight,
      overflowX: style.overflowX,
      whiteSpace: style.whiteSpace,
    },
    /** 整块代码高度 ÷ 单行行高 ≈ 视觉行数（折行会让它明显超过逻辑行数） */
    visualRows: Math.round(pre.scrollHeight / lineHeight),
    wrapped: hangs,
    button: wrapButton === null
      ? null
      : { pressed: wrapButton.getAttribute('aria-pressed'), text: wrapButton.textContent.trim() },
  }
`

await openPreview()

/* ── A / B：默认折行 ── */
const on = await evaluate(measure)
console.log('A-on', JSON.stringify(on, null, 1))
check(on.error === undefined, `没量到代码视图：${String(on.error)}`)
check(on.pre !== undefined && on.pre.scrollWidth <= on.pre.clientWidth + 1, `折行后仍有横向溢出：${String(on.pre?.scrollWidth)} > ${String(on.pre?.clientWidth)}`)
check(on.pre !== undefined && on.pre.whiteSpace === 'pre-wrap', `white-space 不是 pre-wrap：${String(on.pre?.whiteSpace)}`)
check(on.lines === targetLines, `行数从 ${String(targetLines)} 变成了 ${String(on.lines)}（行间换行符没折叠，多出空行）`)
check(on.visualRows > on.lines * 1.15, `没有一行真的折行了：视觉行 ${String(on.visualRows)} / 逻辑行 ${String(on.lines)}`)
check(on.wrapped !== null && on.wrapped !== undefined, '没找到折行的行，悬挂缩进量不出来')
if (on.wrapped !== null && on.wrapped !== undefined) {
  const row = on.wrapped
  const codeOffset = row.firstLeft - row.boxLeft
  check(codeOffset >= 30, `首行文字离行盒子只有 ${String(codeOffset)}px，行号列没让开`)
  check(row.secondLeft !== null && Math.abs(row.secondLeft - row.firstLeft) <= 2, `续行没对齐代码列：差 ${String(row.secondLeft === null ? 'null' : row.secondLeft - row.firstLeft)}px`)
}
check(on.button !== null && on.button.pressed === 'true', `头部「折行」按钮不是按下态：${JSON.stringify(on.button)}`)
await shot('_wrap-A-on.png')

/* ── C：关掉折行 ── */
const off = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const button = document.querySelector('.file-preview-wrap')
  if (button === null) return { error: '找不到「折行」按钮' }
  button.click()
  await wait(500)
  return { clicked: true }
`)
if (off.clicked === true) {
  const state = await evaluate(measure)
  console.log('C-off', JSON.stringify(state, null, 1))
  check(state.pre !== undefined && state.pre.scrollWidth > state.pre.clientWidth, `关掉折行后没有恢复横向滚动：${String(state.pre?.scrollWidth)} / ${String(state.pre?.clientWidth)}`)
  check(Math.abs(state.visualRows - state.lines) <= 1, `关掉折行后仍有多行折行：视觉行 ${String(state.visualRows)} / 逻辑行 ${String(state.lines)}`)
  check(state.button !== null && state.button.pressed === 'false', `关掉后按钮仍是按下态：${JSON.stringify(state.button)}`)
  await shot('_wrap-C-off.png')
} else {
  check(false, `点不到「折行」按钮：${String(off.error)}`)
}

console.log(failed.length === 0 ? 'PASS 折行口径全过' : `FAIL ${failed.join('；')}`)

try { ws.close() } catch {}
try { electron.kill() } catch {}
try { fake.kill() } catch {}
await sleep(600)
process.exit(failed.length === 0 ? 0 : 1)
