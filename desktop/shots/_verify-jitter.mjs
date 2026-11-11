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
 * ## 2026-11-12：收工不再盲等 9 秒
 *
 * 旧版发完消息就 `await sleep(9000)`，然后拿这段时间的样本判读。负载下窗口被挡时
 * Chromium 会把定时器压到 1Hz、停掉 rAF：采样只有个位数帧、内容还没开始长，于是
 * 「在量」「真的在动」「状态行帧数」一起红——看起来像产品不跟随，其实是页面被节流了。
 *
 * 现在：
 *
 *   · 起 Electron 时带三条关后台节流的开关，连上 CDP 后开
 *     `Emulation.setFocusEmulationEnabled`（与 `_probe-kit` 的 `launchDesktop` + `connectCdp`
 *     同一套；这套配对缺一半，遮挡时仍会退化）；
 *   · 采样等**条件**：先等回合状态行出现，再等它消失（流式收尾），最多 25s；不再写死 9s；
 *   · 判读前先过环境闸：帧数 ≥120、锚点行采到、有可滚范围、跑动中状态行 ≥30 帧、
 *     相邻样本最大间隔 ≤500ms。达不到就只红「环境」那条，产品判据打印 `skip`。
 *
 * 阈值来历：采样窗口现在是「发消息 → 流式收尾 → 再补 160 帧」，正常 4–6 秒；30fps 下
 * 就有 120–180 帧，所以 120 是「至少 30fps 跑满了窗口」的下限。`travel ≥ 40` 来自实测
 * 841px（8 轮历史 + 30 段流式正文），40px 只要求「确实往上走了」，不锁内容长度。
 * 相邻样本间隔 500ms 是「页面被冻住」的判据：实测安静环境里也有 184ms 的单次长帧
 * （流式正文一大段提交时的排版），那一次不该把整轮判成不可读；真正的节流是秒级间隔，
 * 与 500ms 差一个数量级。
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

/**
 * 关掉 Chromium 的后台节流（与 `_probe-kit.mjs` 的 `launchDesktop` 同一组）。
 * 配对的是下面的 `Emulation.setFocusEmulationEnabled`：缺任一半，窗口被挡时采样会掉到
 * 个位数帧，判读就成了掷骰子。
 */
const ANTI_THROTTLE = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

/**
 * 负向自检（`PROBE_MUTATE`）认识的值。**只认这几个精确字符串**。
 *
 * 拼错（`shovee`）或写成另一条探针的名字（`no-anchor` / `no-scroll-write`）时以前是直接
 * 不装那个定时器：变异没打上、日志没有、退出码 0，操作者会以为「判据改完仍能红」。现在
 * 有值但不认识就当场报错退出（列认识的值）。
 */
const MUTATIONS = ['shove']
const requestedMutation = process.env.PROBE_MUTATE ?? ''
if (requestedMutation !== '' && !MUTATIONS.includes(requestedMutation)) {
  console.error(`  FAIL 环境：PROBE_MUTATE=${requestedMutation} 不认识（认识的值：${MUTATIONS.join('、')}；不设 = 不跑变异）`)
  process.exit(1)
}

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
  ...ANTI_THROTTLE,
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

// 让页面当自己在前台：遮挡时 Chromium 会降频定时器、停 rAF，采样只剩个位数帧。
try { await send('Page.enable') } catch {}
try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }) } catch {}
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
  // 负向自检：PROBE_MUTATE=shove 时每 100ms 把 scrollTop 往回拨 300px，模拟「还有人在写滚动」
  // （与 _verify-follow-debug 的 PROBE_MUTATE=nofollow 同一路数）。跟随没掉的话它会被钉回去；
  // 跟随掉了就会在「收工贴底」上红，抽搐计数也可能捕捉到反向。
  // 拨了几次也记下来：变异没真的跑起来（定时器没装上）时全绿是假绿，判据见下面「变异」那条。
  window.__jitter.mutation = { requested: ${JSON.stringify(process.env.PROBE_MUTATE ?? '')}, shoves: 0 }
  if (window.__jitter.mutation.requested === 'shove') {
    window.__jitterShove = setInterval(() => {
      window.__jitter.mutation.shoves += 1
      chat.scrollTop = Math.max(0, chat.scrollTop - 300)
    }, 100)
  }
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

/**
 * 诊断用：`PROBE_CPU_THROTTLE=20` 在发完消息之后让渲染进程慢 20 倍，用来验证
 * 「环境：这次的采样现场可判读」这条闸真的会红（而不是拿个位数样本去判产品）。
 * 正常跑不要设。
 */
const cpuThrottle = Number(process.env.PROBE_CPU_THROTTLE ?? '1')
if (Number.isFinite(cpuThrottle) && cpuThrottle > 1) {
  await send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle })
  console.log(`[probe] PROBE_CPU_THROTTLE=${String(cpuThrottle)}：渲染进程降速 ${String(cpuThrottle)} 倍（发完消息之后才降）`)
}

// 等**条件**而不是等 9 秒：先等回合状态行出现，再等它消失（流式真的收尾）。
// 状态行一次都没出现，说明这一轮没跑起来——最多等 8s 就收手，让环境闸去红。
const finished = await evaluate(`
  const chat = window.__jitter.chat
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const startedAt = performance.now()
  let sawStatus = false
  let statusGone = false
  while (performance.now() - startedAt < 25000) {
    const status = document.querySelector('.turn-status') !== null
    if (status) sawStatus = true
    if (sawStatus && !status) { statusGone = true; break }
    if (!sawStatus && performance.now() - startedAt > 8000) break
    await wait(50)
  }
  if (!statusGone) statusGone = document.querySelector('.turn-status') === null
  // 收工后再采一小段：末帧（状态行消失、贴底）要有样本可读。
  const settleDeadline = performance.now() + 2500
  while (window.__jitter.samples.length < 160 && performance.now() < settleDeadline) await wait(32)
  window.__jitter.sampling = false
  return {
    sawStatus,
    statusGone,
    timedOut: !statusGone,
    elapsedMs: Math.round(performance.now() - startedAt),
    frames: window.__jitter.samples.length,
  }
`)
console.log('finish', JSON.stringify(finished))

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
  let maxGap = 0
  for (let i = 1; i < list.length; i += 1) maxGap = Math.max(maxGap, list[i].t - list[i - 1].t)
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
    maxGap,
    endStatus: document.querySelector('.turn-status') !== null,
    mutation: window.__jitter.mutation ?? null,
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
let skipped = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}
/** 环境不满足时跳过产品判据：只打印，不计入通过也不计入失败（环境那条已经红了）。 */
const skip = (name, why) => {
  skipped += 1
  console.log(`  skip ${name}（环境未就绪：${why}）`)
}

// 负向自检先自证：变异没打上（定时器没装、一次都没拨）就红不了，全绿是假绿。
if (report.mutation?.requested === 'shove') {
  check('变异：PROBE_MUTATE=shove 真的生效（每 100ms 真的往回拨过 scrollTop）',
    (report.mutation.shoves ?? 0) > 0,
    `拨了 ${String(report.mutation.shoves ?? 0)} 次`)
}

// ── 环境闸：先证明「采样这件事本身可信」，再判产品 ───────────────────────────────
// 这些数字不是产品指标，是「量尺准不准」。达不到就只红这几条，产品判据全部 skip。
const envProblems = []
if (report.frames < 120) envProblems.push(`采样 ${String(report.frames)} 帧 < 120（窗口内不足 30fps）`)
if (report.anchorFirst === null || report.anchorLast === null) envProblems.push('锚点行没被采到')
if (report.slackMax === null || report.slackMax <= 200) envProblems.push(`没有可滚范围（max(sh-ch)=${String(report.slackMax)}）`)
if (report.statusFrames < 30) envProblems.push(`跑动中状态行只有 ${String(report.statusFrames)} 帧 < 30（量的是静止画面）`)
if (report.maxGap > 500) envProblems.push(`相邻样本最大间隔 ${String(Math.round(report.maxGap))}ms > 500ms（页面被冻住，反向判读不可信）`)
if (finished.sawStatus !== true) envProblems.push('整段采样里没见到回合状态行（这一轮可能没跑起来）')
const envOk = envProblems.length === 0
check('环境：这次的采样现场可判读', envOk, envProblems.join('；'))

if (envOk) {
  check('位置不抽搐：锚点行反向移动 0 次', report.anchorFlips === 0, `实测 ${String(report.anchorFlips)} 次`)
  // 实测净上移 841px（8 轮历史 + 30 段流式正文）；40px 只要求「确实往上走了」。
  check('真的在动：锚点行全程净上移 ≥ 40px', report.travel >= 40, `实测 ${String(report.travel)}px`)
  check('收工时回合状态行已经消失', report.endStatus === false,
    finished.timedOut === true ? `等了 ${String(finished.elapsedMs)}ms 状态行仍在` : '')
  check('收工贴底：scrollTop 在 floor 上（±2px）', Math.abs(report.end.top - report.end.floor) <= 2, JSON.stringify(report.end))
} else {
  for (const name of [
    '位置不抽搐：锚点行反向移动 0 次',
    '真的在动：锚点行全程净上移 ≥ 40px',
    '收工时回合状态行已经消失',
    '收工贴底：scrollTop 在 floor 上（±2px）',
  ]) skip(name, envProblems.join('；'))
}

console.log(`\n[_verify-jitter] 断言 ${String(passed + failures)} 条，通过 ${String(passed)} 条，失败 ${String(failures)} 条，环境跳过 ${String(skipped)} 条`)
try { ws.close() } catch {}
try { electron.kill() } catch {}
try { server.close() } catch {}
await sleep(400)
process.exit(failures === 0 ? 0 : 1)
