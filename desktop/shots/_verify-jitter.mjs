process.on('unhandledRejection', () => {})

/**
 * #2「任务进行中上下抽搐」的真机探针（2026-11-09 报障，2026-11-11 修活）。
 *
 * ## 修了什么（修之前它是空转）
 *
 * 旧版不传 `DSC_RESUME_SESSION`，靠「最新一条会话」这种隐式口径挑会话，历史是一段手搓
 * jsonl；实测跑出来 `.entry-user` 一直是 null（历史根本没加载）、`anchorFlips 0`、
 * `scrollHeight === clientHeight`（根本没有可滚范围），然后 `process.exit(0)`——
 * 一条断言都没有，什么都没证明。现在：
 *
 *   · 历史用宿主自己的 `Session` 写（手搓 jsonl 与宿主的重放口径对不上）；
 *   · 启动直接用 `DSC_RESUME_SESSION` 打开种子那条会话；
 *   · 视口固定 1100×900，会话内容远高于一屏。
 *
 * ## 判据（每条都能红）
 *
 *   1. **在量**：采样 ≥ 120 帧，锚点行被采到 ≥ 100 帧；
 *   2. **有东西可滚**：`max(scrollHeight − clientHeight) > 200`（旧版这里是 0）；
 *   3. **不抽搐**：锚点行（最后一条用户消息）的屏幕 `top` 相邻两帧**反向**（往上走的过程中
 *      又往下走）的次数必须是 0；
 *   4. **真的在动**：全程锚点行净上移 ≥ 40px（内容真的在长；只证第 3 条的话，界面卡死也能过）；
 *   5. **收工贴底**：结束时回合状态行消失、`scrollTop` 在 floor 上（±2px）。
 *
 * 运行：node desktop/shots/_verify-jitter.mjs [宽] [高]
 * 产物：desktop/shots/_jitter-after.png
 *
 * 前提：`pnpm run build`（要 lib/core/session.js 写种子）与 `pnpm run build:ui` 都跑过。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-jitter-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18993
const debugPort = 9371
const width = Number(process.argv[2] ?? 1100)
const height = Number(process.argv[3] ?? 900)

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
// Chromium 在 app ready 之前会去 %USERPROFILE%\AppData\Roaming 找配置：目录不存在会直接崩。
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-fold', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-fold', '        name: Fake Fold',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
writeFileSync(join(work, 'probe-target.txt'), '探针样张：这一行只是让 read 调用有东西可读。\n')

// ── 历史种子：必须是宿主自己的 Session 写的（手搓 jsonl 会和宿主的重放口径对不上）──────
process.env.HOME = home
process.env.USERPROFILE = home
const core = await import('../../lib/core/session.js')
const seed = core.Session.create(work)
const HISTORY_ROUNDS = 8
for (let round = 0; round < HISTORY_ROUNDS; round += 1) {
  seed.appendUser(`第 ${String(round + 1)} 轮：先看一遍这一段的边界条件，再决定要不要动它。`)
  seed.appendAssistant(
    `第 ${String(round + 1)} 轮的结论：边界条件没问题，下面那条读取是为了确认调用方。`,
    `思考：第 ${String(round + 1)} 轮先核对入参与返回值，别漏掉空数组那种情况。\n`,
    [],
  )
  seed.appendAssistant('读一下调用方确认口径。', '', [
    {
      id: `call_jitter_${String(round)}`,
      name: 'read',
      arguments: JSON.stringify({ path: join(work, 'probe-target.txt') }),
    },
  ])
  seed.appendTool(`call_jitter_${String(round)}`, 'read', `第 ${String(round + 1)} 轮读到的样张内容（三行）。`)
}
seed.close()

/**
 * 假模型：只吐正文（不调工具），一串长句分 30 口吐出来。
 *
 * 为什么不调工具：假端点的工具调用这一轮里跑不通（实测宿主会一直重发同一个请求、
 * 最后报 `连接失败：fetch failed`）。这里要证的是「内容持续增长时位置不抽搐」，
 * 正文流就够了。
 */
const SENTENCE = '这一段是把边界条件逐条核对的记录：入参、返回值、空数组、超时，一项一项过，'
let served = 0
const server = createServer((req, res) => {
  void (async () => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    await new Promise((resolve) => req.on('end', resolve))
    served += 1
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    for (let index = 0; index < 30; index += 1) {
      delta({ content: SENTENCE })
      await sleep(100)
    }
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 300 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-jitter] ${String(error)}\n`)
    try { res.end() } catch {}
  })
})
server.listen(fakePort, '127.0.0.1')

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
  // 启动就打开**种子那条会话**（不靠「最新一条」这种隐式口径，换台机器也稳）。
  DSC_RESUME_SESSION: seed.filePath,
}
delete env.ELECTRON_RUN_AS_NODE

const electron = spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
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

await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
await sleep(600)

const started = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 240; i += 1) {
    if (document.querySelector('.composer textarea') !== null
      && document.querySelectorAll('.entry-row').length >= 20) break
    await wait(100)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea（会话没打开）' }
  const chat = document.querySelector('.chat')
  if (chat === null) return { error: 'no chat' }
  const baseline = {
    rows: document.querySelectorAll('.entry-row').length,
    users: document.querySelectorAll('.entry-user').length,
    slack: chat.scrollHeight - chat.clientHeight,
  }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '跑一轮，我要看位置会不会抖。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(120)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  await wait(320)

  // 锚点＝**最后一条**用户消息（就是刚发出去的这条）：它下面那一轮在不断长，它被往上推；
  // 任何一次「推上去又弹回来」都是抽搐。
  const anchorRow = [...document.querySelectorAll('.entry-user')].at(-1) ?? null
  if (anchorRow === null) return { error: '没有 .entry-user（历史没加载或消息没发出去）', baseline }
  const view = chat.getBoundingClientRect()
  const samples = []
  const push = () => {
    if (!window.__jitter.sampling) return
    samples.push({
      t: Math.round(performance.now()),
      top: Math.round(chat.scrollTop),
      sh: chat.scrollHeight,
      ch: chat.clientHeight,
      anchor: Math.round(anchorRow.getBoundingClientRect().top - view.top),
      status: document.querySelector('.turn-status') !== null,
    })
  }
  window.__jitter = { samples, sampling: true, chat, anchorRow }
  const tick = () => {
    if (!window.__jitter.sampling) return
    requestAnimationFrame(tick)
    // 画完这一帧再读，读到的才是屏幕上的位置（同 _verify-fold-scroll 的口径）。
    setTimeout(push, 0)
  }
  push()
  requestAnimationFrame(tick)
  return { sent: true, baseline }
`)
console.log('start', JSON.stringify(started))
if (started?.error !== undefined) {
  try { ws.close() } catch {}
  try { electron.kill() } catch {}
  try { server.close() } catch {}
  process.exit(1)
}

await sleep(9000)

const report = await evaluate(`
  window.__jitter.sampling = false
  const list = window.__jitter.samples
  const chat = window.__jitter.chat
  const anchors = list.map((s) => s.anchor)
  let flips = 0
  let dir = 0
  for (let i = 1; i < anchors.length; i += 1) {
    const step = Math.sign(anchors[i] - anchors[i - 1])
    if (step !== 0 && dir !== 0 && step !== dir) flips += 1
    if (step !== 0) dir = step
  }
  const slacks = list.map((s) => s.sh - s.ch)
  const spacer = chat.querySelector('[data-chat-turn-spacer]')
  const floor = chat.scrollHeight - (spacer === null ? 0 : spacer.offsetHeight) - chat.clientHeight
  return {
    frames: list.length,
    anchorFlips: flips,
    anchorFirst: anchors[0] ?? null,
    anchorLast: anchors[anchors.length - 1] ?? null,
    anchorMin: anchors.length === 0 ? null : Math.min(...anchors),
    anchorMax: anchors.length === 0 ? null : Math.max(...anchors),
    travel: anchors.length === 0 ? 0 : Math.abs(anchors[anchors.length - 1] - anchors[0]),
    slackMax: slacks.length === 0 ? null : Math.max(...slacks),
    statusFrames: list.filter((s) => s.status).length,
    endStatus: document.querySelector('.turn-status') !== null,
    end: {
      top: Math.round(chat.scrollTop),
      floor: Math.round(floor),
      sh: chat.scrollHeight,
      ch: chat.clientHeight,
    },
    trace: list.filter((_s, index) => index % 40 === 0).map((s) => ({
      t: s.t, anchor: s.anchor, top: s.top, slack: s.sh - s.ch, status: s.status,
    })),
  }
`)
console.log('jitter', JSON.stringify(report, null, 1))

const data = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(shots, '_jitter-after.png'), Buffer.from(data.data, 'base64'))

let passed = 0
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

check('在量：采样 ≥ 120 帧', report.frames >= 120, `实测 ${String(report.frames)} 帧`)
check('锚点行被采到（最后一条用户消息；旧版这里一直是 null）', report.anchorFirst !== null && report.anchorLast !== null)
check('会话真的有可滚范围（旧版 sh == ch，等于什么都没量）', report.slackMax !== null && report.slackMax > 200, `max(sh-ch)=${String(report.slackMax)}`)
check('位置不抽搐：锚点行反向移动 0 次', report.anchorFlips === 0, `实测 ${String(report.anchorFlips)} 次`)
check('真的在动：锚点行全程净上移 ≥ 40px', report.travel >= 40, `实测 ${String(report.travel)}px`)
check('跑动中确实有回合状态行（不然量的是静止画面）', report.statusFrames >= 30, `只有 ${String(report.statusFrames)} 帧`)
check('收工时回合状态行已经消失', report.endStatus === false)
check('收工贴底：scrollTop 在 floor 上（±2px）', Math.abs(report.end.top - report.end.floor) <= 2, JSON.stringify(report.end))

console.log(`\n[_verify-jitter] 断言 ${String(passed + failures)} 条，通过 ${String(passed)} 条，失败 ${String(failures)} 条`)
try { ws.close() } catch {}
try { electron.kill() } catch {}
try { server.close() } catch {}
await sleep(400)
process.exit(failures === 0 ? 0 : 1)
