// 已弃用：只打印不判定（2026-11-11 审计），用之前先补断言
process.on('unhandledRejection', () => {})

/**
 * 量「阶段组头 ↔ 后台作业通知行」两边的实际间距（一次性的排障探针）。
 *
 * 做法：把真实会话 4d864aac 的一份**拷贝**放进临时 HOME，用桌面产物打开它，
 * 再通过 CDP 把那一轮的可见盒子逐个量出来（top/height + 父容器 gap/padding/margin）。
 * 真实 ~/.dsc 一个字节都不写。
 *
 * 运行：node desktop/shots/_probe-gap.mjs
 */
import { spawn, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = 'D:/dsc'
const home = join(root, 'desktop/shots/_gap-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const debugPort = 9355

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

// 这份会话是当初报障时那一轮的真实记录（宿主把它放在 D-dsc 工作区目录下）。
// 它只在报障那台机器上存在，所以这里**先找，找不到就跳过**：以前这里写死了别人机器上的
// 绝对路径（C:/Users/waq/...），换台机器一跑就 ENOENT 抛错。
const gapSessionId = '4d864aac-d31b-456f-a92c-2992a9d1aefd.jsonl'
const findGapSession = () => {
  const sessionsRoot = join(homedir(), '.dsc', 'sessions')
  if (!existsSync(sessionsRoot)) return null
  const stack = [sessionsRoot]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === gapSessionId) return full
    }
  }
  return null
}
const gapSource = findGapSession()
if (gapSource === null) {
  console.log(`[_probe-gap] 跳过：本机 ~/.dsc/sessions 下找不到报障那条会话（${gapSessionId}）。`)
  console.log("[_probe-gap] 这条探针量的是那一轮的具体盒子间距，没有那条记录就没有可量的现场；")
  console.log("[_probe-gap] 想跑就在报障机器上跑，或把那条 jsonl 放进该目录。真实 ~/.dsc 只读不写。")
  rmSync(home, { recursive: true, force: true })
  process.exit(0)
}
const sessionFile = join(dsc, 'sessions', 'demo', gapSessionId)
copyFileSync(gapSource, sessionFile)
console.log('[_probe-gap] 用的会话副本：' + gapSource)

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-gap', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18999/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-gap', '        name: Fake Gap',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

writeFileSync(join(dsc, 'settings.json'), JSON.stringify({
  defaultPolicy: 'readonly',
  defaultEffort: null,
  marketSources: [],
  closeToTray: false,
  ui: {
    sessionSort: 'recent', sessionGroup: 'workspace', archivedFilter: 'hide',
    workspaceOrder: ['D:\\dsc'], workspaceAliases: {}, themeMode: process.env.GAP_THEME === 'dark' ? 'dark' : 'light',
    fontSize: 1, buttonScale: 1, density: 'standard', processFold: 'standard',
  },
}, null, 2))

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
  let list = []
  try { list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json() } catch { list = [] }
  const candidate = (list ?? []).find((p) => p.type === 'page' && String(p.url).startsWith('http'))
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
    } catch { try { ws.close() } catch {} }
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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800))
  return result.result?.value
}

const report = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 160; i += 1) {
    if (document.querySelector('.trigger-card[data-internal="1"]') !== null) break
    await wait(250)
  }
  await wait(800)
  // 把通知行滚进视野，再把它的整轮展开（报障画面里整轮是展开的）
  // 报障那一轮还没画出来：先把更早的轮一页页放出来（按钮文案「加载更早的 N 轮」）
  const pick = () => [...document.querySelectorAll('.turn-fold')].find((node) =>
    (node.textContent ?? '').includes('12分54秒'))
  for (let i = 0; i < 8 && pick() === undefined; i += 1) {
    const more = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('加载更早'))
    if (more === undefined) break
    more.click()
    await wait(700)
  }
  // 报障那一轮：整轮开关写着「已完成，用时 12分54秒」
  const wanted = pick() === undefined ? undefined : pick().closest('.turn-seat')
  const host = wanted === undefined ? null : wanted.querySelector('.trigger-card[data-internal="1"]')
  if (host === null) return { error: 'no internal row', seen: document.body.innerText.slice(0, 300) }
  host.scrollIntoView({ block: 'center' })
  const seat = host.closest('.turn-seat')
  const fold = seat === null ? null : seat.querySelector('button.turn-fold')
  if (fold !== null && fold.getAttribute('aria-expanded') === 'false') { fold.click(); await wait(500) }
  await wait(300)
  const box = (node) => {
    const r = node.getBoundingClientRect()
    const cs = getComputedStyle(node)
    return {
      cls: String(node.className), tag: node.tagName,
      top: Math.round(r.top), h: Math.round(r.height),
      gap: cs.rowGap, pad: cs.paddingTop + '/' + cs.paddingBottom,
      mar: cs.marginTop + '/' + cs.marginBottom,
      display: cs.display, minH: cs.minHeight, maxH: cs.maxHeight,
      hidden: node.hasAttribute('hidden') ? node.getAttribute('hidden') : null,
      text: (node.textContent ?? '').replace(/\s+/g, ' ').slice(0, 60),
    }
  }
  const kids = [...seat.children].map((child) => box(child))
  // 通知行前后那两个「段」里到底装着什么
  const segs = [...seat.querySelectorAll('.turn-process-body')].map((n) => ({
    ...box(n),
    kids: [...n.children].map((child) => ({ ...box(child), html: child.outerHTML.slice(0, 160) })),
  }))
  return { kids, segs, hostText: host.textContent }
`)
console.log(JSON.stringify(report, null, 1))

// 截一张给眼睛看（这一段是「组头 → 下一张卡」的间距）：先把悬停预览卡清掉、
// 把那一条滚回视野中央，免得卡片盖住要看的区域。
await evaluate(`
  document.querySelectorAll('.hover-preview').forEach((node) => node.remove())
  // 报障那一轮（12分54秒）里的那张卡，滚到中间再截
  const fold = [...document.querySelectorAll('.turn-fold')].find((node) => node.textContent.includes('12分54秒'))
  const seat = fold === undefined ? null : fold.closest('.turn-seat')
  const host = seat === null ? null : seat.querySelector('.trigger-card')
  if (host !== null) host.scrollIntoView({ block: 'center' })
  await new Promise((r) => setTimeout(r, 400))
  return true
`)
await sleep(400)
const diag = await evaluate(`
  return [...document.querySelectorAll('.trigger-card')].map((card) => {
    const head = card.querySelector('.trigger-head')
    const chev = card.querySelector('.trigger-chevron')
    const rect = card.getBoundingClientRect()
    return {
      title: card.querySelector('.trigger-title').textContent,
      open: head.getAttribute('aria-expanded'),
      dataOpen: head.hasAttribute('data-open') ? head.getAttribute('data-open') : null,
      transform: getComputedStyle(chev).transform,
      top: Math.round(rect.top),
      h: Math.round(rect.height),
      nextGap: card.nextElementSibling === null ? null
        : Math.round(card.nextElementSibling.getBoundingClientRect().top - rect.bottom),
    }
  })
`)
console.log('cards', JSON.stringify(diag, null, 1))
const png = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(root, 'desktop/shots/_gap-after.png'), Buffer.from(png.data, 'base64'))

try { ws.close() } catch {}
try { electron.kill() } catch {}
await sleep(400)
process.exit(0)
