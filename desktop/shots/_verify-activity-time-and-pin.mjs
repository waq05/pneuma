process.on('unhandledRejection', () => {})

/**
 * 「点会话不该改最近使用时间」+「图钉换新」的真机复验（2026-11-03 报障）。
 *
 * 病灶一：侧栏那列时间取的是文件 mtime；打开老会话时权限三项补默认值会追加三条
 * `state` 记账，mtime 变成现在，于是「点一下，时间就跳到刚刚」。
 * 修法：时间取最后一条带 `ts` 的对话记录；补钉改成只记内存、等下次写日志再落。
 *
 * 病灶二：置顶图钉是 45° 斜拼的三段线，13px 下糊成小哑铃。
 * 修法：换成竖向推钉、14px，已置顶的钉身填实。
 *
 * 验收口径（六条，缺一不算过）：
 *   ① 老会话（最后一步在 3 天前、文件尾部却是刚写的记账）在侧栏显示「3天」，不是「刚刚」；
 *   ② 点开它，时间仍是「3天」，文件字节数一个不少也不多（打开没有补钉写盘）；
 *   ③ 点开置顶那条（2 天前）再点回来，两条的时间都不变、两个文件都没被改；
 *   ④ 置顶行常显图钉，钉身是实心（`fill="currentColor"`）；
 *   ⑤ 未置顶行平时看不见图钉，悬浮才浮出，且是描边（`fill="none"`）；
 *   ⑥ 留三张图：整窗、图钉放大、悬浮态。
 *
 * 运行：node desktop/shots/_verify-activity-time-and-pin.mjs（依赖 desktop/out/ 与 lib/ui/）
 * 打包装的产物：DSC_PROBE_EXE=...\Pneuma.exe node desktop/shots/_verify-activity-time-and-pin.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-activity-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work', 'alpha')
const debugPort = 9363

/** 与 `src/core/session.ts` 的 slugCwd 同一口径（种子文件要落在会话自己会写的那条路上）。 */
const slugCwd = (cwd) => cwd.replace(/[\\/:]+/g, '-')

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-activity', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18997/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-activity', '        name: Fake Activity',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

const now = Date.now()
const DAY = 24 * 60 * 60 * 1000
/**
 * 种一条「最后一步是 N 天前、文件却被后来补的记账写过」的会话。
 *
 * 尾巴那条 `state` 就是打开会话时补的权限默认值（没有 ts）：修复之前它把列表时间
 * 顶成「刚刚」，修复之后应当被忽略。
 */
const seed = (id, text, ageDays) => {
  const dir = join(dsc, 'sessions', slugCwd(work))
  mkdirSync(dir, { recursive: true })
  const at = now - ageDays * DAY
  const lines = [
    { type: 'meta', id, cwd: work, createdAt: at - 1000 },
    { type: 'user', text, ts: at },
    { type: 'assistant', text: `收到，这是 ${id}`, reasoning: '', ts: at + 1000 },
    // 打开会话补的默认值：三条都没有 ts（真机上就是 permissions 那三条）
    { type: 'state', id: 'permissions', payload: { sandbox: null, policy: null, reviewer: null } },
  ]
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return file
}
const fileOld = seed('old-3d', '三天前的会话内容 A1', 3)
const filePinned = seed('pinned-2d', '两天前置顶的会话 B1', 2)
// 置顶属性走 sidecar（与真实写入同一份文件、同一个版本号）
writeFileSync(
  join(dsc, 'sessions', 'meta.json'),
  JSON.stringify({ version: 1, sessions: { 'pinned-2d': { pinnedAt: now - 2000 } } }),
)

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
  // 主进程用 app.getPath('home') 算 desktop.json（Windows 上它走系统 API，认不到
  // USERPROFILE），不显式覆盖就会读写真实 `~/.dsc/desktop.json`：隔离探针必须给这一项。
  DSC_DESKTOP_STATE: join(home, 'desktop.json'),
  DSC_RESUME_SESSION: fileOld,
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
const shot = async (name, clip) => {
  const data = await send('Page.captureScreenshot', clip === undefined ? { format: 'png' } : { format: 'png', clip })
  writeFileSync(join(shots, name), Buffer.from(data.data, 'base64'))
}
const clickRowWith = (needle) => evaluate(`
  const row = [...document.querySelectorAll('.sidebar .sess-item')]
    .find((item) => (item.textContent || '').includes(${JSON.stringify(needle)}))
  if (row === undefined) return false
  row.click()
  return true
`)
const rows = () => evaluate(`
  return [...document.querySelectorAll('.sidebar .sess-item')].map((row) => {
    const pin = row.querySelector('.lead-pin')
    const body = pin?.querySelector('path[fill]')
    return {
      text: (row.textContent || '').trim().slice(0, 40),
      when: row.querySelector('.when')?.textContent ?? null,
      active: row.classList.contains('active'),
      pinned: pin !== null && pin.classList.contains('pinned'),
      pinFill: body?.getAttribute('fill') ?? null,
      pinOpacity: pin === null ? null : getComputedStyle(pin).opacity,
      pinBox: pin === null ? null : (() => {
        const rect = pin.getBoundingClientRect()
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      })(),
    }
  })
`)
/** 等侧栏行数稳定为 n。 */
const waitRows = (n) => evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 40; i += 1) {
    if (document.querySelectorAll('.sidebar .sess-item').length >= ${n}) break
    await wait(200)
  }
  return true
`)

const sizeOldStart = statSync(fileOld).size
const sizePinnedStart = statSync(filePinned).size
const mtimeOldStart = statSync(fileOld).mtimeMs
const mtimePinnedStart = statSync(filePinned).mtimeMs

// ── ① 打开就是那条「3 天前」的会话，时间不能是「刚刚」─────────────────────────
console.log('\n[1] 侧栏时间取最后一步')
await waitRows(2)
await sleep(1600)
let list = await rows()
console.log('  rows', JSON.stringify(list.map((r) => ({ text: r.text, when: r.when, pinned: r.pinned }))))
const rowOld = list.find((row) => row.text.includes('A1'))
const rowPinned = list.find((row) => row.text.includes('B1'))
check('两条会话都在侧栏', rowOld !== undefined && rowPinned !== undefined)
check('老会话的时间是「3天」', rowOld?.when === '3天', String(rowOld?.when))
check('它不是「刚刚」', rowOld?.when !== '刚刚')
check('置顶那条的时间是「2天」', rowPinned?.when === '2天', String(rowPinned?.when))
await shot('_verify-activity-pin-1-sidebar.png')

// ── ② 点开老会话：时间不变、文件不被改 ───────────────────────────────────────
console.log('\n[2] 点开老会话')
check('点得到那一行', await clickRowWith('A1'))
await sleep(1500)
list = await rows()
const rowOldAfter = list.find((row) => row.text.includes('A1'))
check('点开之后时间还是「3天」', rowOldAfter?.when === '3天', String(rowOldAfter?.when))
check('这一行亮着（确实切过去了）', rowOldAfter?.active === true)
check('文件字节数没变（没有补钉写盘）', statSync(fileOld).size === sizeOldStart, `${String(statSync(fileOld).size)} ≠ ${String(sizeOldStart)}`)
check('文件 mtime 没变', statSync(fileOld).mtimeMs === mtimeOldStart)

// ── ③ 点开置顶那条再点回来：两条时间都不变 ───────────────────────────────────
console.log('\n[3] 来回切两次')
check('点得到置顶那一行', await clickRowWith('B1'))
await sleep(1500)
let afterPin = await rows()
check('置顶那条切过去了', afterPin.find((row) => row.text.includes('B1'))?.active === true)
check('置顶那条时间还是「2天」', afterPin.find((row) => row.text.includes('B1'))?.when === '2天', String(afterPin.find((row) => row.text.includes('B1'))?.when))
check('老会话时间还是「3天」', afterPin.find((row) => row.text.includes('A1'))?.when === '3天')
check('两个文件都没被改', statSync(fileOld).size === sizeOldStart && statSync(filePinned).size === sizePinnedStart)
check('两个 mtime 都没被刷新', statSync(fileOld).mtimeMs === mtimeOldStart && statSync(filePinned).mtimeMs === mtimePinnedStart)

// ── ④ 置顶行常显、钉身实心 ───────────────────────────────────────────────────
console.log('\n[4] 图钉形状')
afterPin = await rows()
const pinRow = afterPin.find((row) => row.text.includes('B1'))
check('置顶行常显图钉', pinRow?.pinOpacity === '1', String(pinRow?.pinOpacity))
check('钉身是实心的（fill=currentColor）', pinRow?.pinFill === 'currentColor', String(pinRow?.pinFill))
const plainRow = afterPin.find((row) => row.text.includes('A1'))
check('未置顶行平时看不见图钉', plainRow?.pinOpacity === '0', String(plainRow?.pinOpacity))
check('未置顶的钉身是描边（fill=none）', plainRow?.pinFill === 'none', String(plainRow?.pinFill))

// ── ⑤ 悬浮未置顶那一行：图钉浮出 ─────────────────────────────────────────────
console.log('\n[5] 悬浮浮出')
const plainBox = plainRow?.pinBox
if (plainBox !== null && plainBox !== undefined) {
  const x = Math.round(plainBox.x + plainBox.width / 2)
  const y = Math.round(plainBox.y + plainBox.height / 2)
  // 悬停要两次移动：第一次进窗口、第二次进这一格，单次移动有时不触发 :hover
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 40, y })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  let opacity = '0'
  for (let i = 0; i < 20; i += 1) {
    const hovered = await evaluate(`
      const row = [...document.querySelectorAll('.sidebar .sess-item')]
        .find((item) => (item.textContent || '').includes('A1'))
      const pin = row?.querySelector('.lead-pin')
      return pin === null || pin === undefined ? null : getComputedStyle(pin).opacity
    `)
    opacity = String(hovered)
    if (opacity === '1') break
    await sleep(100)
  }
  check('悬浮之后图钉浮出', opacity === '1', opacity)
  const clip = {
    x: Math.max(0, Math.round(plainBox.x) - 12),
    y: Math.max(0, Math.round(plainBox.y) - 10),
    width: 56,
    height: 36,
    scale: 4,
  }
  await shot('_verify-activity-pin-2-zoom.png', clip)
  const pinBoxPinned = pinRow?.pinBox
  if (pinBoxPinned !== null && pinBoxPinned !== undefined) {
    await shot('_verify-activity-pin-3-pinned-zoom.png', {
      x: Math.max(0, Math.round(pinBoxPinned.x) - 12),
      y: Math.max(0, Math.round(pinBoxPinned.y) - 10),
      width: 56,
      height: 36,
      scale: 4,
    })
  }
} else {
  check('拿得到未置顶行的图钉位置', false)
}

if (failed.length > 0) {
  console.log('\n--- 宿主日志尾 ---')
  console.log(log.slice(-1500))
}
console.log('\n' + (failed.length === 0 ? 'PASS 六条口径全过' : `FAIL ${failed.join('；')}`))
try { ws.close() } catch {}
try { electron.kill() } catch {}
await sleep(800)
process.exit(failed.length === 0 ? 0 : 1)
