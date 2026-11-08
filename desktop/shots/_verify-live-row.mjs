process.on('unhandledRejection', () => {})

/**
 * 回合直播行的真机复验（2026-11-08）。
 *
 * 口径：跑动中消息流末尾必须有**一行**「Numa 工作中，用时 X」，形态对齐 dsh 的
 * `RunningStatus` —— 顶上一条 0.5px 分隔线、整句扫光、用时每秒跳一次，位置在
 * 输入框正上方（`.chat-inner` 的最后一个子节点，不是窗口底部的状态栏）。
 *
 * 为什么要有这条：`scripts/ui-turn-status-test.mjs` 只能读源码文本，证明不了
 * 「这一行真的画出来了、真的在跳秒、真的贴在输入框上面」。这里用真宿主 + 真壳 +
 * 假端点（先吐思考再吐正文、最后挂住不回 finish），界面就会停在「回合进行中」。
 *
 * 运行：node desktop/shots/_verify-live-row.mjs（依赖 desktop/out/ 与 lib/ui/）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-live-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const fakePort = 18982
const debugPort = 9351

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-live', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:' + fakePort + '/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-live', '        name: Fake Live',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
}
delete env.ELECTRON_RUN_AS_NODE

const fake = spawn(process.execPath, [join(shots, '_verify-stream-caret-fake-llm.mjs'), String(fakePort)], { env, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))

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

const start = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 40; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(500)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '把行尾改成 CRLF，顺便检查一下循环导入。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(120)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return { sent: true }
`)
console.log('start', JSON.stringify(start))

/**
 * 等直播行出现，采两份读数（相隔 1.4 秒，用来看用时有没有真的在跳），再量几何与样式。
 */
const probe = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  let row = null
  for (let i = 0; i < 200; i += 1) {
    row = document.querySelector('.turn-status')
    if (row !== null) break
    await wait(100)
  }
  if (row === null) return { error: '直播行没出现', chatChildren: Array.from(document.querySelector('.chat-inner')?.children ?? []).map((el) => el.className).slice(-6) }
  const textOf = (el) => (el.querySelector('.turn-status-stage')?.textContent ?? '').trim()
  const first = textOf(row)
  const samples = [first]
  for (let i = 0; i < 5; i += 1) { await wait(900); samples.push(textOf(row)) }
  const second = samples[samples.length - 1]
  const stage = row.querySelector('.turn-status-stage')
  const cs = getComputedStyle(row)
  const stageCs = getComputedStyle(stage)
  const after = getComputedStyle(stage, '::after')
  const rect = row.getBoundingClientRect()
  const composer = document.querySelector('.composer-zone')?.getBoundingClientRect() ?? null
  const scroller = row.closest('.chat')
  return {
    first,
    second,
    samples,
    visibility: document.visibilityState,
    advanced: first !== second,
    spinPresent: row.querySelector('.turn-status-spin') !== null,
    dotsPresent: row.querySelectorAll('.turn-status-dots i').length,
    borderTop: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
    color: cs.color,
    alignSelf: cs.alignSelf,
    stageShimmer: stage.getAttribute('data-shimmer'),
    afterContent: after.content,
    afterAnimation: after.animationName + ' / ' + after.animationDuration,
    stageOverflow: stageCs.overflow + ' / ' + stageCs.whiteSpace,
    rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), width: Math.round(rect.width) },
    composerTop: composer === null ? null : Math.round(composer.top),
    aboveComposer: composer === null ? null : rect.bottom <= composer.top + 1,
    afterHasContent: (() => {
      // 直播行必须在「这一轮的最后一条内容」之后：它后面只允许有空占位（follow 的末尾锚点）
      // 与「回到底部」按钮，不许再有轮或条目。
      const all = Array.from(document.querySelectorAll('.chat-inner *'))
      const rest = all.slice(all.indexOf(row) + 1)
      return rest.some((el) => el.matches('.turn-seat, .entry-row'))
    })(),
    insideScroller: scroller !== null,
    title: row.getAttribute('title'),
  }
`)
console.log('probe', JSON.stringify(probe, null, 2))

// 截图：把视口定成固定尺寸，画面才可复现。
await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false })
await sleep(500)
const data = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(shots, 'live-row.png'), Buffer.from(data.data, 'base64'))

try { ws.close() } catch {}
electron.kill()
fake.kill()

const failures = []
if (probe.error) failures.push(probe.error)
if (!/Numa 工作中，用时 \d+/.test(probe.first ?? '')) failures.push('行面文案不是「Numa 工作中，用时 X」：' + probe.first)
if (probe.advanced !== true) failures.push('用时没有每秒跳动')
if (!/^0\.[5-7]\d*px solid/.test(String(probe.borderTop))) failures.push('顶部没有细线分隔（0.5px 按 DPI 缩放）：' + probe.borderTop)
if (probe.afterAnimation?.startsWith('dsc-think-shimmer') !== true) failures.push('整句没有扫光：' + probe.afterAnimation)
if (probe.aboveComposer !== true) failures.push('不在输入框上方：' + JSON.stringify(probe.rect) + ' vs ' + probe.composerTop)
if (probe.afterHasContent !== false) failures.push('后面还有正文/轮，没贴在流末尾')
if (probe.insideScroller !== true) failures.push('不在滚动容器 .chat 里')
if (probe.spinPresent !== true) failures.push('转圈没了')
if (probe.dotsPresent !== 3) failures.push('三点动画是 ' + probe.dotsPresent + ' 个')

console.log(failures.length === 0 ? '\nPASS 直播行：一行、带用时、扫光、贴在输入框上方' : '\nFAIL\n - ' + failures.join('\n - '))
process.exit(failures.length === 0 ? 0 : 1)
