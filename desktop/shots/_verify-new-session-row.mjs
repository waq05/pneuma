process.on('unhandledRejection', () => {})

/**
 * 「点新会话要看得见一行」的真机复验（2026-11-03 报障）。
 *
 * 病灶：正文切到了空会话，侧栏却什么都不多——用户点完只觉得没反应。
 * 修法：宿主 `refresh()` 给**当前**那条还没落盘的会话补一行临时行（`unsaved`），
 * 切走就消失；界面把它当只读回执画（不给改名 / 置顶 / 归档 / 右键菜单）。
 *
 * 验收口径（六条，缺一不算过）：
 *   ① 打开一条有内容的会话：那一行亮着（`.sess-item.active`），正文不是空态；
 *   ② 点「新会话」：侧栏多出**一行**「新会话」且亮着，正文换成空态；
 *   ③ 这一行是回执不是真会话：没有图钉、没有归档钮；
 *   ④ 在新会话里打字、点回老会话：那行消失（列表回到 N 行），输入框清空；
 *   ⑤ 再点「新会话」：半截话被捡回来（草稿按工作区分槽，0.6.70 的口径没破）；
 *   ⑥ 全过程中磁盘上没有为零消息会话建出文件。
 *
 * 运行：node desktop/shots/_verify-new-session-row.mjs（依赖 desktop/out/ 与 lib/ui/）
 * 打包装的产物：DSC_PROBE_EXE=...\Pneuma.exe node desktop/shots/_verify-new-session-row.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-new-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const workA = join(home, 'work', 'alpha')
const workB = join(home, 'work', 'beta')
const debugPort = 9361

/** 与 `src/core/session.ts` 的 slugCwd 同一口径（种子文件要落在会话自己会写的那条路上）。 */
const slugCwd = (cwd) => cwd.replace(/[\\/:]+/g, '-')

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(workA, { recursive: true })
mkdirSync(workB, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-new', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18998/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-new', '        name: Fake New',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

const now = Date.now()
const seed = (id, cwd, text, age) => {
  const dir = join(dsc, 'sessions', slugCwd(cwd))
  mkdirSync(dir, { recursive: true })
  const lines = [
    { type: 'meta', id, cwd, createdAt: now - age },
    { type: 'user', text, ts: now - age + 1000 },
    { type: 'assistant', text: '收到，这是 ' + id, reasoning: '', ts: now - age + 2000 },
  ]
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return file
}
// 两条都种在同一个工作区：那一组是「当前工作区」，默认展开，行才画得出来
// （别的工作区默认收着，看不到行不代表没进列表）。
const fileA = seed('alpha-1', workA, '这条是 alpha 会话的消息 A1', 120000)
seed('alpha-2', workA, '这条是 alpha 会话的第二条 A2', 90000)
seed('beta-1', workB, '这条是 beta 会话的消息 B1', 60000)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failed = []
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failed.push(label)
  console.log(`  FAIL ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
  DSC_RESUME_SESSION: fileA,
}
delete env.ELECTRON_RUN_AS_NODE
const electron = process.env.DSC_PROBE_EXE
  ? spawn(process.env.DSC_PROBE_EXE, ['--remote-debugging-port=' + debugPort], {
    cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  : spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
    join(root, 'desktop/out/main/index.js'), '--remote-debugging-port=' + debugPort,
  ], { cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
electron.stdout.on('data', (d) => { log += String(d) })
electron.stderr.on('data', (d) => { log += String(d) })

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

let connected = false
for (let i = 0; i < 80; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()
    const candidate = (list ?? []).find((p) => p.type === 'page' && String(p.url).startsWith('http'))
    if (candidate) {
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
      connected = true
      break
    }
  } catch {
    try { ws?.close() } catch {}
  }
  await sleep(800)
}
if (!connected) {
  console.log('FAIL 连不上 CDP：' + log.slice(-800))
  try { electron.kill() } catch {}
  process.exit(1)
}

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
const mouse = (x, y) =>
  send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }).then(() =>
    send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }))

/** 现场：侧栏行 + 正文空态 + 输入框 + 提示条（失败时看得到宿主说了什么）。 */
const diag = () => evaluate(`
  const rows = [...document.querySelectorAll('.sidebar .sess-item')]
  return {
    rows: rows.map((row) => ({
      text: (row.textContent || '').trim().slice(0, 24),
      active: row.classList.contains('active'),
      pin: row.querySelector('.lead-pin') !== null,
      archiveBtn: row.querySelector('.row-actions .icon-btn') !== null,
    })),
    welcome: document.querySelector('.welcome') !== null,
    composer: document.querySelector('.composer textarea')?.value ?? null,
    notices: [...document.querySelectorAll('.notice, .toast, .entry-notice')].map((el) => (el.textContent || '').trim().slice(0, 80)),
  }
`)

const clickNew = async (via = 'mouse') => {
  if (via === 'dom') {
    return evaluate(`
      const button = document.querySelector('.btn-new')
      if (button === null) return false
      button.click()
      return true
    `)
  }
  const box = await evaluate(`
    const button = document.querySelector('.btn-new')
    if (button === null) return null
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  `)
  if (box === null) return false
  await mouse(box.x, box.y)
  return true
}

/** 点标题里带某段文字的那一行（别拿“第一行”当锚：新会话行可能排在最上面）。 */
const clickRowWith = async (needle, via = 'mouse') => {
  if (via === 'dom') {
    return evaluate(`
      const row = [...document.querySelectorAll('.sidebar .sess-item')]
        .find((item) => (item.textContent || '').includes(${JSON.stringify(needle)}))
      if (row === undefined) return false
      row.click()
      return true
    `)
  }
  const box = await evaluate(`
    const row = [...document.querySelectorAll('.sidebar .sess-item')]
      .find((item) => (item.textContent || '').includes(${JSON.stringify(needle)}))
    if (row === undefined) return null
    const rect = row.getBoundingClientRect()
    return { x: rect.left + Math.min(rect.width / 2, 60), y: rect.top + rect.height / 2 }
  `)
  if (box === null) return false
  await mouse(box.x, box.y)
  return true
}

/** 等侧栏行数变成 n。 */
const waitRows = (n) => evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 40; i += 1) {
    if (document.querySelectorAll('.sidebar .sess-item').length === ${n}) break
    await wait(200)
  }
  return true
`)

const typeInto = async (text) => {
  const box = await evaluate(`
    const area = document.querySelector('.composer textarea')
    if (area === null) return null
    const rect = area.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  `)
  if (box === null) return
  await mouse(box.x, box.y)
  await send('Input.insertText', { text })
  await sleep(400)
}
/** 磁盘上有没有为零消息会话建出文件：这里只该有种子那三条。 */
const sessionFiles = () => {
  const out = []
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl')) out.push(full.split(/[\\/]/).pop())
    }
  }
  walk(join(dsc, 'sessions'))
  return out
}

// ── ① 打开有内容的那条会话 ───────────────────────────────────────────────────────
console.log('\n[1] 打开一条有内容的会话')
await waitRows(2)
await sleep(1200)
const start = await diag()
console.log('  start', JSON.stringify(start))
const baseRows = start.rows.length
check('起始列表里有两条（同组两条种子）', baseRows === 2, String(baseRows))
check('当前那条亮着', start.rows.some((row) => row.active && row.text.includes('A1')), JSON.stringify(start.rows))
check('正文不是空态', start.welcome === false)
await shot('_verify-new-session-1-opened.png')

// ── ② 点「新会话」：多一行、亮着、正文空态 ───────────────────────────────────────
console.log('\n[2] 点「新会话」')
check('点得到那顆钮', await clickNew())
await waitRows(baseRows + 1)
await sleep(1000)
const afterNew = await diag()
console.log('  afterNew', JSON.stringify(afterNew))
check('侧栏多出一行', afterNew.rows.length === baseRows + 1, String(afterNew.rows.length))
const blank = afterNew.rows.find((row) => row.text.includes('新会话'))
check('那一行就是「新会话」', blank !== undefined)
check('那一行亮着（当前会话）', blank !== undefined && blank.active === true)
check('正文换成空态', afterNew.welcome === true)
check('输入框是空的', afterNew.composer === '')
await shot('_verify-new-session-2-after.png')

// ── ③ 回执行不给磁盘类动作 ───────────────────────────────────────────────────────
console.log('\n[3] 临时行是只读回执')
check('没有图钉钮', blank !== undefined && blank.pin === false)
check('没有归档钮', blank !== undefined && blank.archiveBtn === false)

// ── ④ 打字后切回老会话：那行消失、输入框清空 ──────────────────────────────────────
console.log('\n[4] 打字后切回老会话')
await typeInto('新会话里写了半截话 XYZ')
const typed = await diag()
check('新会话里打进了字', typed.composer === '新会话里写了半截话 XYZ', String(typed.composer))
await shot('_verify-new-session-3-typed.png')
check('点得到老会话那一行', await clickRowWith('A1'))
await waitRows(baseRows)
await sleep(1200)
let back = await diag()
if (!back.rows.some((row) => row.active && row.text.includes('A1'))) {
  console.log('  真实指针没切开，退回 DOM click 再试一次')
  check('DOM click 点得到老会话那一行', await clickRowWith('A1', 'dom'))
  await waitRows(baseRows)
  await sleep(1200)
  back = await diag()
}
console.log('  back', JSON.stringify(back))
check('老会话切回来了（那一行亮着）', back.rows.some((row) => row.active && row.text.includes('A1')), JSON.stringify(back.rows))
check('临时行消失了（列表回到起始行数）', back.rows.length === baseRows, String(back.rows.length))
check('侧栏里再没有「新会话」那一行', !back.rows.some((row) => row.text.includes('新会话')))
check('输入框跟着换回老会话的（空）', back.composer === '', String(back.composer))
await shot('_verify-new-session-4-back.png')

// ── ⑤ 再点「新会话」：半截话捡回来 ───────────────────────────────────────────────
console.log('\n[5] 再点「新会话」')
check('点得到那顆钮', await clickNew())
await waitRows(baseRows + 1)
await sleep(1000)
const again = await diag()
console.log('  again', JSON.stringify(again))
check('又多出一行', again.rows.length === baseRows + 1, String(again.rows.length))
check('半截话捡回来了', again.composer === '新会话里写了半截话 XYZ', String(again.composer))
await shot('_verify-new-session-5-again.png')

// ── ⑥ 磁盘上没为零消息会话建文件 ─────────────────────────────────────────────────
console.log('\n[6] 磁盘')
const files = sessionFiles()
console.log('  files', JSON.stringify(files))
check('会话目录里只有种子那三条', files.length === 3, String(files.length))

if (failed.length > 0) {
  console.log('\n--- 宿主日志尾 ---')
  console.log(log.slice(-1500))
}
console.log('\n' + (failed.length === 0 ? 'PASS 六条口径全过' : `FAIL ${failed.join('；')}`))
try { ws.close() } catch {}
try { electron.kill() } catch {}
await sleep(800)
process.exit(failed.length === 0 ? 0 : 1)
