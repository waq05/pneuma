/**
 * 打包产物的首屏实机探针：直接起 `desktop/dist/win-unpacked/Pneuma.exe`（不是 dev 版），
 * 在隔离 HOME 里看真实窗口画出来的东西。
 *
 * 为什么要单独一支：`_verify-welcome-align.mjs` 起的是 `desktop/out/main/index.js`（vite dev 产物），
 * 它能过不代表打好的包里过——文案在 `dsc-core/lib` 的插件包里，打包时另一批文件被复制进去，
 * 少一份就是空白。
 *
 * 判据：
 *   1. `.welcome` 出现，`h1` 有字；
 *   2. `h1` 等于当前时段那六句里的一句（按本机小时算，与 `greeting.ts` 同边界）；
 *   3. 副行提示含「直接说要做什么」；
 *   4. 四张卡都在；
 *   5. 截图落盘，人工再看一眼。
 *
 * 运行：node desktop/shots/_verify-welcome-packaged.mjs
 * 产物：desktop/shots/out/welcome-packaged.png
 */
process.on('unhandledRejection', () => {})

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-welcome-packaged-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const outDir = join(shots, 'out')
const debugPort = 9381

const SENTENCES = {
  earlyMorning: '早上好，说说今天要做什么',
  morning: '上午好，有事直接说',
  noon: '中午好，先去吃个饭',
  afternoon: '下午好，剩下的交给我',
  evening: '晚上好，今天到这儿也行',
  lateNight: '夜深了，明天再弄',
}
const slotOfHour = (hour) => {
  if (hour < 5) return 'lateNight'
  if (hour < 9) return 'earlyMorning'
  if (hour < 12) return 'morning'
  if (hour < 14) return 'noon'
  if (hour < 18) return 'afternoon'
  if (hour < 23) return 'evening'
  return 'lateNight'
}

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
mkdirSync(outDir, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-code', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18999/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-code', '        name: Fake Code',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
}
delete env.ELECTRON_RUN_AS_NODE

const exe = join(root, 'desktop/dist/win-unpacked/Pneuma.exe')
const app = spawn(exe, ['--remote-debugging-port=' + String(debugPort), '--disable-background-timer-throttling'], {
  cwd: join(root, 'desktop/dist/win-unpacked'), env, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
app.stdout.on('data', (d) => { log += String(d) })
app.stderr.on('data', (d) => { log += String(d) })

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
for (let i = 0; i < 100; i += 1) {
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
      connected = true
      break
    } catch { try { ws.close() } catch {} }
  }
  await sleep(700)
}
if (!connected) {
  console.log('FAIL 连不上应用（日志尾部）：' + log.slice(-500))
  try { app.kill() } catch {}
  process.exit(1)
}

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression: '(async () => { ' + expression + ' })()',
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800))
  return result.result?.value
}

await send('Emulation.setDeviceMetricsOverride', { width: 1423, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
await sleep(600)

const view = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.welcome') !== null) break
    await wait(250)
  }
  const h1 = document.querySelector('.welcome h1')
  const lead = document.querySelector('.welcome p')
  return {
    hasWelcome: document.querySelector('.welcome') !== null,
    title: h1 === null ? null : h1.textContent.trim(),
    lead: lead === null ? null : lead.textContent.replace(/\\s+/g, ' ').trim(),
    cards: document.querySelectorAll('.welcome-card').length,
  }
`)

const slot = slotOfHour(new Date().getHours())
const expected = SENTENCES[slot]
let failed = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + (ok ? '' : '  <- ' + String(detail)))
  if (!ok) failed += 1
}

check('首屏 .welcome 画出来了', view.hasWelcome === true, JSON.stringify(view))
check('h1 有字', typeof view.title === 'string' && view.title.length > 0, JSON.stringify(view.title))
check('h1 是当前时段（' + slot + '）那一句', view.title === expected, '实际「' + String(view.title) + '」，应为「' + expected + '」')
check('副行提示改成 Codex 式引导', typeof view.lead === 'string' && view.lead.includes('直接说要做什么'), JSON.stringify(view.lead))
check('四张能力卡都在', view.cards === 4, String(view.cards))

const shot = await send('Page.captureScreenshot', { format: 'png' })
const file = join(outDir, 'welcome-packaged.png')
writeFileSync(file, Buffer.from(shot.data, 'base64'))
console.log('  截图: ' + file)
console.log('  h1 实际内容: 「' + String(view.title) + '」')
console.log('  副行实际内容: 「' + String(view.lead) + '」')

try { app.kill() } catch {}
await sleep(500)
console.log('')
console.log(failed === 0 ? '打包产物首屏：全部通过' : '打包产物首屏：' + String(failed) + ' 条失败')
process.exit(failed === 0 ? 0 : 1)
