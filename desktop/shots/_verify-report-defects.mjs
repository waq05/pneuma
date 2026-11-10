process.on('unhandledRejection', () => {})

/**
 * 用户 2026-11-09 报的三条界面缺陷的验收探针（改完之后跑）。
 *
 *   ① 归档会话：点了就归档（不弹确认框），顶部给一条带「撤销 / 筛选已归档会话」的提示；
 *   ③ 点正文里的文件链接：不许多出窗口，必须在右侧栏开出预览页签；
 *   ④ 右侧栏展开时的几何：不许压到正文（正文保底 480px），预览内容在面板里可横向滚动。
 *
 * 四段事实（每段都打印，PASS/FAIL 汇总在最后）：
 *   C 点链接：页面数、右侧栏是否展开并带预览页签。
 *   D 几何：dock / thread 矩形是否重叠、dock 宽度是否被窗口夹住。
 *   E 归档：点行尾的归档钮 → 有没有确认框、提示里有没有两颗动作、点「撤销」能否恢复。
 *   F 窄窗口：窗口缩到 1100 时 dock 是否自动让位。
 *
 * 运行：node desktop/shots/_verify-report-defects.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-defects-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18987
const debugPort = 9363
const sessionId = 'defects-demo'

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-code', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-code', '        name: Fake Code',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

// 两条会话：一条给链接用（当前会话），一条留着给归档用（侧栏里挑没在跑的那条）。
const now = Date.now()
const seed = (id, title, cwd) => {
  const file = join(dsc, 'sessions', 'demo', `${id}.jsonl`)
  writeFileSync(file, [
    { type: 'meta', id, cwd, createdAt: now - 120000 },
    { type: 'user', text: title, ts: now - 110000 },
    {
      type: 'assistant',
      text: [
        '可以点的写法就是标准 markdown 链接：',
        '',
        '- 绝对路径：[package.json](D:\\dsc\\package.json)',
        '- 相对路径：[i18n 文案](src/packages/ui/core/../locale)',
      ].join('\n'),
      reasoning: '',
      ts: now - 100000,
    },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n')
  return file
}
const currentFile = seed(sessionId, '看一个文件，点一下能直接预览。', work)
seed('archive-demo', '这条留着归档', work)

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
  DSC_RESUME_SESSION: currentFile,
  DSC_NO_EXTERNAL_OPEN: '1',
}
delete env.ELECTRON_RUN_AS_NODE

const fake = spawn(process.execPath, [join(shots, '_verify-code-fake-llm.mjs'), String(fakePort)], { env, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
// 打包装的产物也能验：`DSC_PROBE_EXE=...\Pneuma.exe node this.mjs`
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

await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelectorAll('.chat-inner .entry-row').length > 1) break
    await wait(250)
  }
  await wait(800)
  return true
`)

/* ── C：点正文里的文件链接 ── */
const before = await evaluate(`
  return {
    anchors: [...document.querySelectorAll('.chat-inner .file-md a')].map((node) => ({
      text: node.textContent.trim(), href: node.getAttribute('href'), cls: node.className, target: node.getAttribute('target'),
    })),
    pages: null,
  }
`)
const pagesBefore = (await listPages()).length
console.log('C-anchors', JSON.stringify(before.anchors, null, 1))
check(before.anchors.length === 2, `正文里只有 ${String(before.anchors.length)} 个链接，应为 2`)
check(before.anchors.every((a) => a.cls.includes('md-file-link')), `链接没被接管：${JSON.stringify(before.anchors.map((a) => a.cls))}`)
check(before.anchors.every((a) => a.href !== ''), `链接的 href 是空的：${JSON.stringify(before.anchors.map((a) => a.href))}`)
check(before.anchors.every((a) => a.target === null), `链接还带 target=_blank：${JSON.stringify(before.anchors.map((a) => a.target))}`)

const box = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const first = document.querySelector('.chat-inner .file-md a')
  if (first === null) return null
  first.scrollIntoView({ block: 'center' })
  await wait(400)
  const rect = first.getBoundingClientRect()
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
`)
if (box !== null) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(1600)
}
const pagesAfter = (await listPages()).length
const after = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  await wait(300)
  const dock = document.querySelector('.dock')
  return {
    href: location.href,
    pages: null,
    dockClass: dock === null ? null : dock.className,
    chips: [...document.querySelectorAll('.dock-chip')].map((node) => node.textContent.trim()),
    path: document.querySelector('.file-preview-path')?.textContent?.trim() ?? null,
    kind: document.querySelector('.file-code-body') !== null ? 'code' : (document.querySelector('.file-preview-empty')?.textContent ?? null),
  }
`)
console.log('C-after', JSON.stringify({ ...after, pagesBefore, pagesAfter }, null, 1))
check(pagesAfter === pagesBefore, `点链接多出了窗口：${String(pagesBefore)} → ${String(pagesAfter)}`)
check(after.dockClass !== null && !after.dockClass.includes('collapsed'), `右侧栏没展开：${String(after.dockClass)}`)
check(after.chips.length >= 1 && after.chips.some((c) => c.includes('package.json')), `右侧栏没有开预览页签：${JSON.stringify(after.chips)}`)
await shot('_defects-C-link.png')

/* ── D：右侧栏与正文的几何 ── */
const geo = await evaluate(`
  const pick = (selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    const rect = node.getBoundingClientRect()
    return { left: Math.round(rect.left), right: Math.round(rect.right), w: Math.round(rect.width) }
  }
  const dock = pick('.dock:not(.collapsed)') ?? pick('.dock')
  const thread = pick('.thread-main')
  const pre = document.querySelector('.file-code-body pre') ?? document.querySelector('.file-preview-body pre')
  return {
    win: window.innerWidth,
    dock, thread,
    overlap: dock === null || thread === null ? null : Math.max(0, thread.right - dock.left),
    threadWidth: thread === null ? null : thread.w,
    pre: pre === null ? null : { scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth, overflowX: getComputedStyle(pre).overflowX },
  }
`)
console.log('D-geometry', JSON.stringify(geo, null, 1))
check(geo.overlap === 0, `右侧栏压到正文：重叠 ${String(geo.overlap)}px`)
check(geo.dock !== null && geo.dock.w <= 820, `右侧栏超过上限：${String(geo.dock?.w)}`)
await shot('_defects-D-dock.png')

/* ── E：归档一键 + 撤销 ── */
const archive = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  // 侧栏里挑一条**不是当前会话**的行（当前那条点归档会把界面里的会话拽走）。
  const rows = [...document.querySelectorAll('.sess-item')]
  const row = rows.find((node) => !node.classList.contains('active') && node.querySelector('[data-tip="归档会话"]') !== null)
  const button = row?.querySelector('[data-tip="归档会话"]')
  if (button === null || button === undefined) {
    return { error: '找不到归档按钮', rows: rows.length, tips: [...document.querySelectorAll('.sess-item [data-tip]')].map((n) => n.getAttribute('data-tip')).slice(0, 12) }
  }
  const title = row.querySelector('.title')?.textContent?.trim() ?? ''
  button.click()
  await wait(1200)
  const modal = document.querySelector('[role="dialog"], .dsc-modal, .confirm-box')
  const toast = document.querySelector('.dsc-toast')
  return {
    title,
    hasModal: modal !== null,
    toastText: toast?.textContent?.trim() ?? null,
    actions: [...document.querySelectorAll('.dsc-toast__act')].map((node) => node.textContent.trim()),
  }
`)
console.log('E-archive', JSON.stringify(archive, null, 1))
check(archive.error === undefined, `归档按钮没找到：${JSON.stringify(archive)}`)
check(archive.hasModal === false, '点归档仍然弹了确认框')
check(typeof archive.toastText === 'string' && archive.toastText.includes('已归档'), `提示没出现：${String(archive.toastText)}`)
check((archive.actions ?? []).length === 2, `提示里应有「撤销 / 筛选已归档会话」两颗：${JSON.stringify(archive.actions)}`)
await shot('_defects-E-toast.png')

const undo = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const button = [...document.querySelectorAll('.dsc-toast__act')].find((node) => node.textContent.trim() === '撤销')
  if (button === undefined) return { clicked: false }
  button.click()
  await wait(1500)
  const before = document.querySelectorAll('.sess-item').length
  return {
    clicked: true,
    toast: document.querySelector('.dsc-toast')?.textContent?.trim() ?? null,
    rows: before,
    activeRows: [...document.querySelectorAll('.sess-item')].map((node) => ({
      title: node.querySelector('.title')?.textContent?.trim() ?? '',
      archived: node.className.includes('archived'),
    })),
  }
`)
console.log('E-undo', JSON.stringify(undo, null, 1))
check(undo.clicked === true, '提示里没找到「撤销」')
check(undo.toast !== null && undo.toast.includes('已恢复'), `撤销后没有回执：${String(undo.toast)}`)
check((undo.rows ?? 0) >= 2, `撤销之后侧栏只有 ${String(undo.rows)} 条（会话没回到列表里）`)
await shot('_defects-E-undo.png')

/* ── F：窄窗口下 dock 让位 ── */
await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false })
await sleep(1400)
const narrow = await evaluate(`
  const pick = (selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    const rect = node.getBoundingClientRect()
    return { left: Math.round(rect.left), right: Math.round(rect.right), w: Math.round(rect.width) }
  }
  const dock = pick('.dock:not(.collapsed)') ?? pick('.dock')
  const thread = pick('.thread-main')
  return {
    win: window.innerWidth,
    dock, thread,
    overlap: dock === null || thread === null ? null : Math.max(0, thread.right - dock.left),
    fullscreen: document.querySelector('.dock')?.className ?? null,
  }
`)
console.log('F-narrow', JSON.stringify(narrow, null, 1))
check(narrow.overlap === 0, `窄窗口下右侧栏压到正文：${String(narrow.overlap)}px`)
check(narrow.thread === null || narrow.thread.w >= 400, `窄窗口下正文只有 ${String(narrow.thread?.w)}px`)
await shot('_defects-F-narrow.png')

console.log(failed.length === 0 ? 'PASS 六条口径全过' : `FAIL ${failed.join('；')}`)

try { ws.close() } catch {}
try { electron.kill() } catch {}
try { fake.kill() } catch {}
await sleep(600)
process.exit(failed.length === 0 ? 0 : 1)
