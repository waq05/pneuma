/**
 * 整轮收起的**逐行动画**真机探针（视口四阶段 ④ 的验收，2026-11-11 重写）。
 *
 * ## 为什么重写
 *
 * 旧版（`:242-279`）一条断言都没有：只 `console.log` 一份报告，然后恒定 `process.exit(0)`，
 * 位置回退多少次都算通过。而且它靠「最新一条会话」这种隐式口径挑会话，实测
 * `scrollHeight === clientHeight`（根本没有可滚范围）、过程区只有 28px——打印得很热闹，
 * 什么都没证明。这里把**现场**与**判据**一起钉死：
 *
 *   · 历史用宿主自己的 `Session` 写（手搓 jsonl 与宿主的重放口径对不上，历史会整段不加载）；
 *   · 启动直接用 `DSC_RESUME_SESSION` 打开种子那条会话，不猜「最新一条」；
 *   · 视口固定 1100×900，保证有可滚范围。
 *
 * ## 两个场景，各管一半
 *
 * **A. 收尾自动收起（位置不回退）**：发一条消息，假模型先流 2 秒思考、再吐一句正文、
 * 停 600ms 才收尾。流式期间把直播思考行点开（复刻「思考先撑出一大块」那一态），于是这一轮
 * 收尾时过程区从几百像素收回 0。每帧量**最终正文行的屏幕 top**：它在收起之前就停在下缘，
 * 收起把它上面那一段抽走——少补一帧位置，这一行就会跳回几十到几百像素。
 *
 * **B. 手点开合（逐行在动）**：拿一条有多个阶段组的历史轮，展开整轮与组体，滚到读历史的位置，
 * 点收起 / 展开各一次。这一段量的是 ④ 自己的形态：**段里每一行各自变矮**（不是整段一刀切）、
 * 末帧每一行都挂 `hidden`、展开时行体原样挂回。三张观感截图就在这一段拍。
 *
 * ## 判据（每条都能红）
 *
 *   1. 在量：采样帧数 ≥ 300，读者眼前那一行被采到 ≥ 12 帧；
 *   2. 有东西可滚：`max(scrollHeight − clientHeight) > 300`；
 *   3. **位置回退 0 次**：最终正文行的屏幕 top 相邻两帧**增加**超过 1px 的次数为 0，整段漂移 ≤2px；
 *   4. 真的在动：过程区最高 > 200px，降到 0 的过程里中间高度 ≥ 5 帧；
 *   5. 末帧没有残留高度：`data-fold === 'closed'`、过程区 0、装载层 0、段里每一行都挂着 `hidden`；
 *   6. 收工后贴底：`scrollTop` 在 floor 上（±2px）、占位回 0；
 *   7. 逐行：收起中段里有行比最高那行矮、且段高在中间；收起末每行高度 0 都挂了 hidden；
 *      展开中每行高度 > 0（行体直接挂回来，没有高度过渡残留）。
 *
 * ## 2026-11-12：为什么不再盲等 11 秒 / 90ms / 450ms
 *
 * 旧版：发完消息 `await sleep(11000)` 收工；场景 B 里「点开整轮 → 等 500ms → 点开组头 →
 * 等 600ms → 点收起 → 等 90ms / 450ms 拍三张」。负载下这些固定时长都不保证条件成立：
 * 流式可能还没收尾，收起批次可能还没开，组体可能还没摊开。表现是
 * 「过程区最高 <200px」「中间高度帧数 <5」这类产品断言红——但其实是探针没等到状态。
 *
 * 现在：
 *
 *   · 起 Electron 带三条关后台节流的开关 + `Emulation.setFocusEmulationEnabled`
 *     （与 `_probe-kit` 的 `launchDesktop` + `connectCdp` 同一套）；
 *   · 场景 A 等条件：先等回合状态行出现再等它消失（流式收尾，最多 25s），随后最多再等
 *     3s 让「收尾自动收起」跑完；采样窗口由条件定，不由 11 秒定；
 *   · 判读前先过环境闸：rAF 帧数、相邻样本最大间隔、答案行帧数、收起窗口里的 rAF 帧数。
 *     达不到就只红「环境」那条，依赖采样密度的产品判据打印 `skip`；
 *   · 场景 B 的每步（展开整轮 / 摊开组体 / 收起到底 / 展开完成）都等状态，不再按毫秒猜；
 *   · 场景 A 的「收起前后漂移」只量**收起开始之后**：答案行刚出现时可能还在排版，负载下
 *     实测第一批样本差 63px，那不是收起把位置抽走。收起起点按 `data-fold` 翻 closed 找；
 *   · 「透明度先走、高度后走」按**先后**判（先出现「变淡且高度仍是满高」的一帧，之后才
 *     出现「高度掉到 80% 以下」的一帧），不按某个固定透明度判：淡出只有 70ms，负载下
 *     16ms 采样常常只落到 0.63 这一格，用 `< 0.6` 会把采样相位当成产品问题。
 *
 * 阈值来历：
 *   · `frames ≥ 150`：采样窗口现在是「发消息 → 流式 → 收尾收起」约 4–6 秒，25fps 就有
 *     100–150 帧；150 是「至少 25fps 跑满窗口」的下限（旧版 300 是按 11 秒窗口定的，
 *     窗口缩短后继续用 300 会把正常跑判红）。
 *   · `answerFrames ≥ 12`、`midFrames ≥ 5`：收起只有约 240ms；16ms 状态采样能采到 ~15 个点，
 *     5 个中间高度 = 约 80ms，足以证明「逐帧在收」而不是一帧闪没。
 *   · `rowMidFrames ≥ 3`、`procH` 中间值 ≥3 帧：同上，逐行动画 240ms 里至少 3 个中间点。
 *
 * 运行：node desktop/shots/_verify-think-collapse.mjs
 * 产物：
 *   - `desktop/shots/_think-collapse-after.png`（收工时的整屏）
 *   - `desktop/shots/_fold-motion-1-collapsing.png`（收起中：行各自变矮、透明度先走）
 *   - `desktop/shots/_fold-motion-2-collapse-end.png`（收起末：段高 0、行都挂了 hidden）
 *   - `desktop/shots/_fold-motion-3-expanding.png`（展开中：行体已经原样挂回）
 *
 * 前提：`pnpm run build`（要 lib/core/session.js 写种子）与 `pnpm run build:ui` 都跑过。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-think-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18995
const debugPort = 9375

/**
 * 关掉 Chromium 的后台节流（与 `_probe-kit.mjs` 的 `launchDesktop` 同一组）。
 * 配对的是下面的 `Emulation.setFocusEmulationEnabled`：缺任一半，窗口被挡时 rAF 会停，
 * 逐行动画的中间高度就一个都采不到。
 */
const ANTI_THROTTLE = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
// Chromium 在 app ready 之前会去 %USERPROFILE%\AppData\Roaming 找配置：目录不存在会直接崩。
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-think', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-think', '        name: Fake Think',
  '        contextWindow: 128000', '        maxTokens: 4096', '', ''
].join('\n'))
// completion：已收尾的轮默认收起（场景 A 要的就是「收尾自动收起」）；
// reasoningDefaultOpen：定稿的思考行默认展开（场景 B 的历史轮要有一大块可收）；
// foldedReplies=final：中间那几句正文也进收起段，于是段里是「组 + 正文 + 组」多行，
// 逐行收起的形状（每行各自变矮）才看得见——all 档会把正文留在段外，段里只剩一个组头。
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({
  ui: { collapseTiming: 'completion', reasoningDefaultOpen: true, foldedReplies: 'final' },
}))
writeFileSync(join(work, 'probe-target.txt'), '探针样张：这一行只是让 read 调用有东西可读。\n')

// ── 历史种子：必须是宿主自己的 Session 写的（手搓 jsonl 会和宿主的重放口径对不上）──────
process.env.HOME = home
process.env.USERPROFILE = home
const core = await import('../../lib/core/session.js')
const seed = core.Session.create(work)
const HISTORY_ROUNDS = 8
/**
 * 每轮：前言+调用 → 结果 → 中间正文 → 前言+调用 → 结果 → 收尾正文。
 *
 * 为什么要那个「中间正文」：它把两个阶段组隔开，同时（foldedReplies=final）被收进整轮
 * 收起段——于是这一轮的过程区是 `[组, 正文, 组]` 三行，逐行收起才有东西可量。
 */
for (let round = 0; round < HISTORY_ROUNDS; round += 1) {
  seed.appendUser(`第 ${String(round + 1)} 轮：把这一段的边界条件过一遍，别漏了空数组那一条。`)
  seed.appendAssistant('先读一下调用方确认口径。', `思考：第 ${String(round + 1)} 轮先核对入参与返回值。\n`, [
    {
      id: `call_think_${String(round)}_a`,
      name: 'read',
      arguments: JSON.stringify({ path: join(work, 'probe-target.txt') }),
    },
  ])
  seed.appendTool(`call_think_${String(round)}_a`, 'read', `第 ${String(round + 1)} 轮第一次读到的样张内容（三行）。`)
  seed.appendAssistant(`第 ${String(round + 1)} 轮中间小结：口径对上了，再确认一处边界。`, '', [])
  seed.appendAssistant('再读一处边界。', '', [
    {
      id: `call_think_${String(round)}_b`,
      name: 'read',
      arguments: JSON.stringify({ path: join(work, 'probe-target.txt') }),
    },
  ])
  seed.appendTool(`call_think_${String(round)}_b`, 'read', `第 ${String(round + 1)} 轮第二次读到的样张内容（两行）。`)
  seed.appendAssistant(`第 ${String(round + 1)} 轮收尾：调用方口径与入参一致，这一轮不用改。`, '', [])
}
seed.close()

/**
 * 假模型：只吐「思考 + 正文」，一次请求就是一轮（不调工具）。
 *
 * 为什么不调工具：假端点的工具调用这一轮里跑不通（实测宿主会一直重发同一个请求、
 * 最后报 `连接失败：fetch failed`，`_verify-level3` 同一个毛病），拿它撑高度只会把
 * 探针写成一个时灵时不灵的东西。高度改用「把直播思考行点开」来造——这也正是报障时
 * 用户看到的形状（思考撑出一大块，收尾时整段被收走）。
 *
 * 最后那段 600ms 是留给量测的：最终正文行先上屏、静置几帧再收尾，才能量「收起前后」。
 */
const THINK_LINE = '我在核对这段逻辑的每个分支，先把边界条件摆出来再看主流程，别急着下结论。\n'
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
    for (let index = 0; index < 24; index += 1) {
      delta({ reasoning_content: THINK_LINE })
      await sleep(80)
    }
    delta({ content: '想完了，一句话：按原计划走。' })
    await sleep(600)
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 900 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-think] ${String(error)}\n`)
    try { res.end() } catch {}
  })
})
server.listen(fakePort, '127.0.0.1')

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
  // 启动就打开种子那条会话（不靠「最新一条」这种隐式口径）。
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

/**
 * 负向自检：`PROBE_MUTATE=no-scroll-write` 把 `.chat` 的 `scrollTop` 写入吞掉，模拟
 * 「视口协调器补不了位置」的真回归。场景 A 自动收起时补偿写不进去，上面的过程区一收，
 * 答案行就会被顶上去——`收起前后那一行的屏幕 top 漂移 ≤2px` 必须红。
 * 只在内存里改这一次运行，不碰产品源码。
 */
const mutateNoScrollWrite = async () => {
  if (process.env.PROBE_MUTATE !== 'no-scroll-write') return
  const result = await evaluate(`
    const chat = document.querySelector('.chat')
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
    if (descriptor === undefined || descriptor.get === undefined) {
      return { mutated: false, reason: '拿不到 scrollTop 访问器' }
    }
    Object.defineProperty(chat, 'scrollTop', {
      configurable: true,
      get() { return descriptor.get.call(chat) },
      set() {},
    })
    return { mutated: true }
  `)
  console.log('[mutate] PROBE_MUTATE=no-scroll-write：'
    + (result?.mutated === true ? '已吞掉 .chat 的 scrollTop 写入（模拟产品回归）' : `失败：${String(result?.reason)}`))
}

// 让页面当自己在前台：遮挡时 Chromium 会降频定时器、停 rAF，逐行动画的中间帧会全丢。
try { await send('Page.enable') } catch {}
try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }) } catch {}
await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(600)

// ── 场景 A：发一条消息，从这一刻起每帧采样 ───────────────────────────────────────────
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
    seats: document.querySelectorAll('.turn-seat[data-round-seat]').length,
    slack: chat.scrollHeight - chat.clientHeight,
  }
  const lastSeat = () => {
    const seats = [...chat.querySelectorAll('.turn-seat[data-round-seat]')]
    return seats.length === 0 ? null : seats[seats.length - 1]
  }
  const samples = []
  const read = () => {
    const seat = lastSeat()
    const segment = seat === null ? null : seat.querySelector('.turn-process')
    const body = segment === null ? null : segment.firstElementChild
    const rows = body === null ? [] : [...body.children]
    // 读者眼前那一行：这一轮**段外**的最后一条正文（最终回答）。
    const answer = seat === null ? null
      : [...seat.querySelectorAll('.entry-row')].filter((row) => row.closest('.turn-process') === null
        && row.querySelector('.entry-text') !== null).at(-1) ?? null
    const view = chat.getBoundingClientRect()
    const spacer = chat.querySelector('[data-chat-turn-spacer]')
    return {
      t: performance.now(),
      round: seat === null ? null : seat.getAttribute('data-round-seat'),
      chatTop: chat.scrollTop,
      sh: chat.scrollHeight,
      ch: chat.clientHeight,
      spacer: spacer === null ? -1 : spacer.offsetHeight,
      fold: segment === null ? null : (segment.getAttribute('data-fold') ?? 'open'),
      procH: segment === null ? null : Number(segment.getBoundingClientRect().height.toFixed(1)),
      bodyH: body === null ? null : Number(body.getBoundingClientRect().height.toFixed(1)),
      rows: rows.length,
      rowHs: rows.map((row) => Number(row.getBoundingClientRect().height.toFixed(1))),
      hiddenRows: rows.filter((row) => row.hasAttribute('hidden')).length,
      answerTop: answer === null ? null : Number((answer.getBoundingClientRect().top - view.top).toFixed(2)),
    }
  }
  const push = () => { if (window.__think.sampling) samples.push(read()) }
  // 另外一条 16ms 状态采样：samples 只在 rAF 上采，掉帧时收起那 240ms 可能只剩两三个点，
  // 「中间高度 ≥5 帧」就会被误判。ticks 只记段高 / 折面 / 行隐藏数，不判位置，
  // 给「逐行在动」提供不依赖帧率的证据。
  const ticks = []
  const tickState = () => {
    if (!window.__think.sampling) return
    const seat = lastSeat()
    const segment = seat === null ? null : seat.querySelector('.turn-process')
    const body = segment === null ? null : segment.firstElementChild
    const rows = body === null ? [] : [...body.children]
    ticks.push({
      t: performance.now(),
      fold: segment === null ? null : (segment.getAttribute('data-fold') ?? 'open'),
      procH: segment === null ? null : Number(segment.getBoundingClientRect().height.toFixed(1)),
      rows: rows.length,
      hiddenRows: rows.filter((row) => row.hasAttribute('hidden')).length,
    })
    setTimeout(tickState, 16)
  }
  window.__think = { samples, ticks, sampling: true, chat, read, lastSeat }
  const tick = () => {
    if (!window.__think.sampling) return
    requestAnimationFrame(tick)
    // 与 _verify-fold-scroll 同一条口径：画完这一帧再读，读到的才是屏幕上的位置。
    setTimeout(push, 0)
  }
  push()
  tickState()
  requestAnimationFrame(tick)

  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '先想很久，再给我一句话。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  // 流式期间把直播思考行点开（复刻「思考撑出一大块」）：不点开它只有 24px 的标题行，
  // 收尾时要收走的东西太少，量出来的漂移没有分量。
  //
  // 要点两次：过程行先被装进**阶段组**（组体默认收起，只有一行组头），所以先点组头
  // 把组体摊开，再点思考行自己。新的一跳可能再起一个组，所以这里每 120ms 复查一次。
  let openedGroups = 0
  let segmentHeight = 0
  const openDeadline = performance.now() + 8000
  while (performance.now() < openDeadline) {
    await wait(120)
    const seat = lastSeat()
    if (seat === null) continue
    for (const groupBtn of seat.querySelectorAll('.step-fold')) {
      if (groupBtn.getAttribute('data-open') === '1') continue
      groupBtn.click()
      openedGroups += 1
    }
    const live = seat.querySelector('.think-block.live .think-head')
    if (live !== null && live.getAttribute('aria-expanded') !== 'true') live.click()
    const segment = seat.querySelector('.turn-process')
    segmentHeight = segment === null ? 0 : segment.getBoundingClientRect().height
    if (segmentHeight > 250) break
  }
  // 把焦点从刚点的组头上挪走：点按钮会把焦点留在里面，而「收起时焦点不许被抽走」
  // 是产品有意保留的规则（焦点在子树里就展开整轮）——不挪走它，收尾时这一轮永远不会收。
  if (document.activeElement !== null && document.activeElement.blur !== undefined) document.activeElement.blur()
  return { sent: true, baseline, openedGroups, opened: segmentHeight > 250, openedHeight: Math.round(segmentHeight) }
`)
console.log('start', JSON.stringify(started))
if (started?.error !== undefined) {
  try { ws.close() } catch {}
  try { electron.kill() } catch {}
  try { server.close() } catch {}
  process.exit(1)
}

/**
 * 诊断用：`PROBE_CPU_THROTTLE=20` 让渲染进程慢 20 倍，用来验证「环境：…现场可判读」
 * 这条闸真的会红（而不是拿个位数样本去判产品）。降速放在发完消息之后，流式与收起都在
 * 慢速下跑。正常跑不要设。
 */
const cpuThrottle = Number(process.env.PROBE_CPU_THROTTLE ?? '1')
if (Number.isFinite(cpuThrottle) && cpuThrottle > 1) {
  await send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle })
  console.log(`[probe] PROBE_CPU_THROTTLE=${String(cpuThrottle)}：渲染进程降速 ${String(cpuThrottle)} 倍（发完消息之后才降）`)
}
await mutateNoScrollWrite()

// 等**条件**而不是等 11 秒：先等回合状态行出现、再等它消失（流式收尾），随后最多再等 3s
// 让「收尾自动收起」跑完。采样窗口由条件定，不再赌一个固定时长。
const finished = await evaluate(`
  const chat = window.__think.chat
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const lastSeat = window.__think.lastSeat
  const startedAt = performance.now()
  let sawStatus = false
  let statusGone = false
  while (performance.now() - startedAt < 25000) {
    const status = chat.querySelector('.turn-status') !== null
    if (status) sawStatus = true
    if (sawStatus && !status) { statusGone = true; break }
    if (!sawStatus && performance.now() - startedAt > 8000) break
    await wait(50)
  }
  if (!statusGone) statusGone = chat.querySelector('.turn-status') === null
  // 收尾自动收起：正常 240ms 跑完；负载下可能晚一两秒，给 3s。等不到就留着现场交给判据。
  const collapseDeadline = performance.now() + 3000
  while (performance.now() < collapseDeadline) {
    const seat = lastSeat()
    const segment = seat === null ? null : seat.querySelector('.turn-process')
    if (segment !== null && segment.getAttribute('data-fold') === 'closed'
      && segment.getBoundingClientRect().height === 0) break
    await wait(50)
  }
  // 末帧判据读「收起已经发生」的那一帧：再等两帧，别读到过渡末值之前。
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  window.__think.sampling = false
  return {
    sawStatus,
    statusGone,
    timedOut: !statusGone,
    elapsedMs: Math.round(performance.now() - startedAt),
    frames: window.__think.samples.length,
    ticks: window.__think.ticks.length,
  }
`)
console.log('finish', JSON.stringify(finished))

const report = await evaluate(`
  window.__think.sampling = false
  const list = window.__think.samples
  const tickList = window.__think.ticks
  const after = window.__think.read()
  // 只认**最后一轮**（跑起来那一轮）的读数：前面的历史轮也挂着 .turn-process，
  // 混在一起会把「这一轮的收起」量成别的轮。
  const liveRound = list.reduce((lastRound, s) => (s.round === null ? lastRound : s.round), null)
  const live = list.filter((s) => s.round === liveRound)
  const answerTops = live.filter((s) => s.answerTop !== null)
  const procHs = tickList.map((s) => s.procH).filter((v) => typeof v === 'number')
  const procMax = procHs.length === 0 ? 0 : Math.max(...procHs)
  const midFrames = procHs.filter((h) => h > 0.5 && h < procMax - 1).length
  // 漂移只量**收起这一段**：这一行刚出现时可能还在排版中（负载下实测第一批样本会差 60px），
  // 那不是「收起把位置抽走」。收起起点用折面翻 closed 找（点击那一刻就翻），找不到再退回
  // 「段高开始变矮」的第一帧。基线取收起前最后一个有答案行的样本。
  let collapseAt = live.findIndex((s) => s.fold === 'closed')
  if (collapseAt < 0) {
    collapseAt = live.findIndex((s) => typeof s.procH === 'number' && procMax > 0 && s.procH < procMax - 1)
  }
  const beforeCollapse = collapseAt > 0 ? live.slice(0, collapseAt).filter((s) => s.answerTop !== null) : []
  const baseTop = beforeCollapse.length > 0
    ? beforeCollapse[beforeCollapse.length - 1].answerTop
    : (answerTops.length > 0 ? answerTops[0].answerTop : null)
  const collapseTops = collapseAt >= 0
    ? live.slice(collapseAt).filter((s) => s.answerTop !== null)
    : answerTops
  let recede = 0
  for (let i = 1; i < collapseTops.length; i += 1) {
    if (collapseTops[i].answerTop - collapseTops[i - 1].answerTop > 1) recede += 1
  }
  const drift = baseTop === null || collapseTops.length === 0 ? null
    : Math.max(...collapseTops.map((s) => Math.abs(s.answerTop - baseTop)))
  const slacks = list.map((s) => s.sh - s.ch)
  let maxGap = 0
  for (let i = 1; i < list.length; i += 1) maxGap = Math.max(maxGap, list[i].t - list[i - 1].t)
  return {
    frames: list.length,
    ticks: tickList.length,
    maxGap,
    liveRound,
    liveFrames: live.length,
    answerFrames: answerTops.length,
    collapseAt,
    recede,
    drift: drift === null ? null : Number(drift.toFixed(2)),
    answerFirst: answerTops.length === 0 ? null : answerTops[0].answerTop,
    answerLast: answerTops.length === 0 ? null : answerTops[answerTops.length - 1].answerTop,
    procMax: Number(procMax.toFixed(1)),
    midFrames,
    slackMax: slacks.length === 0 ? null : Math.max(...slacks),
    foldAt: [...new Set(live.map((s) => s.fold))],
    trace: live.filter((_s, index) => index % 60 === 0).map((s) => ({
      t: Math.round(s.t), fold: s.fold, procH: s.procH, rows: s.rows,
      hidden: s.hiddenRows, answerTop: s.answerTop, top: Math.round(s.chatTop),
    })),
    after,
    activeNow: (() => {
      const el = document.activeElement
      return el === null ? null : el.tagName + '.' + String(el.className).slice(0, 40)
    })(),
    foldStore: Object.keys(localStorage)
      .filter((key) => /fold|collapse/i.test(key))
      .map((key) => ({ key, value: localStorage.getItem(key) })),
    // 收工时那一屏的现场：哪几轮在、各自几段、翻面没有、轮尾还在转没有。
    seatsNow: (() => {
      const chat = window.__think.chat
      const status = chat.querySelector('.turn-status') !== null
      return {
        status,
        seats: [...chat.querySelectorAll('.turn-seat[data-round-seat]')].map((seat) => ({
          round: seat.getAttribute('data-round-seat'),
          foldRow: seat.querySelector('.turn-fold') === null ? null
            : (seat.querySelector('.turn-fold').getAttribute('disabled') === null ? 'enabled' : 'disabled'),
          foldText: seat.querySelector('.turn-fold') === null ? null
            : seat.querySelector('.turn-fold').textContent.trim().slice(0, 24),
          segments: [...seat.querySelectorAll('.turn-process')].map((s) => ({
            fold: s.getAttribute('data-fold'),
            h: Math.round(s.getBoundingClientRect().height),
            rows: s.firstElementChild === null ? 0 : s.firstElementChild.children.length,
            bodyTag: s.firstElementChild === null ? null : s.firstElementChild.className,
            childClasses: s.firstElementChild === null ? [] : [...s.firstElementChild.children].map((c) => String(c.className).slice(0, 20)),
            live: s.querySelectorAll('.think-block.live').length,
          })),
          rows: seat.querySelectorAll('.entry-row').length,
          rowMap: [...seat.querySelectorAll('.entry-row')].map((row) => ({
            cls: String(row.firstElementChild === null ? '' : row.firstElementChild.className).slice(0, 28),
            inFold: row.closest('.turn-process') !== null,
            h: Math.round(row.getBoundingClientRect().height),
          })),
        })),
      }
    })(),
  }
`)
console.log('report', JSON.stringify(report, null, 1))

const data = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(shots, '_think-collapse-after.png'), Buffer.from(data.data, 'base64'))

// ── 场景 B：手点开合 + 三张观感截图 ─────────────────────────────────────────────────
/** 拍一张并记下那一刻的段高与每一行高度（截图与读数一起，图片才可解释）。 */
const readStage = () => evaluate(`
  const chat = document.querySelector('.chat')
  const seat = document.querySelector('.turn-seat[data-round-seat="' + window.__stage.round + '"]')
  if (seat === null) return { error: '目标轮不在 DOM 里' }
  const segment = seat.querySelector('.turn-process')
  const body = segment === null ? null : segment.firstElementChild
  return {
    fold: segment === null ? null : segment.getAttribute('data-fold'),
    procH: segment === null ? null : Number(segment.getBoundingClientRect().height.toFixed(1)),
    segmentTop: segment === null ? null
      : Number((segment.getBoundingClientRect().top - chat.getBoundingClientRect().top).toFixed(1)),
    rowHs: body === null ? [] : [...body.children].map((row) => Number(row.getBoundingClientRect().height.toFixed(1))),
    hiddenRows: body === null ? 0 : [...body.children].filter((row) => row.hasAttribute('hidden')).length,
    scrollTop: Math.round(chat.scrollTop),
    floor: Math.round(chat.scrollHeight - chat.clientHeight),
  }
`)
const shoot = async (name) => {
  const state = await readStage()
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, name), Buffer.from(shot.data, 'base64'))
  console.log(`shot ${name}`, JSON.stringify(state))
  return state
}

const prepared = await evaluate(`
  const chat = document.querySelector('.chat')
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  // 挑一条**内容最多**、且带阶段组的历史轮：它的段里有多个行，逐行收起才看得见。
  let best = null
  for (const seat of chat.querySelectorAll('.turn-seat[data-round-seat]')) {
    const segment = seat.querySelector('.turn-process')
    const btn = seat.querySelector('.turn-fold:not([disabled])')
    if (segment === null || btn === null) continue
    const score = segment.querySelectorAll('.step-seat').length * 100 + segment.querySelectorAll('.entry-row').length
    if (best === null || score > best.score) best = { seat, segment, btn, score }
  }
  if (best === null) return { error: '没有可折的历史轮' }
  const round = best.seat.getAttribute('data-round-seat')
  // 点击后 React 可能重挂这一轮的 DOM：之后一律按轮号重新解析，别拿点击前的元素引用。
  const seatNow = () => chat.querySelector('.turn-seat[data-round-seat="' + round + '"]')
  const btnNow = () => {
    const seat = seatNow()
    return seat === null ? null : seat.querySelector('.turn-fold:not([disabled])')
  }
  // 这几轮默认是收起态：先摊开，再把每个阶段组点开（组体不点开就只有一行组头）。
  if (best.segment.getAttribute('data-fold') === 'closed') {
    const btn = btnNow()
    if (btn === null) return { error: '展开前找不到整轮开关' }
    btn.click()
  }
  // 等整轮真的展开（data-fold=open），不再等 500ms。
  const openDeadline = performance.now() + 5000
  while (performance.now() < openDeadline) {
    const seat = seatNow()
    const segment = seat === null ? null : seat.querySelector('.turn-process')
    if (segment !== null && segment.getAttribute('data-fold') === 'open') break
    await wait(50)
  }
  let openedGroups = 0
  for (const groupBtn of seatNow().querySelectorAll('.step-fold')) {
    if (groupBtn.getAttribute('data-open') === '1') continue
    groupBtn.click()
    openedGroups += 1
  }
  // 等组体真的摊开（每个组头 data-open=1 且组体有高度），不再等 600ms。
  const groupDeadline = performance.now() + 5000
  while (performance.now() < groupDeadline) {
    const seat = seatNow()
    if (seat === null) { await wait(50); continue }
    const groups = [...seat.querySelectorAll('.step-fold')]
    const bodies = [...seat.querySelectorAll('.step-body')]
    const groupsOpen = groups.length > 0 && groups.every((node) => node.getAttribute('data-open') === '1')
    const bodiesOpen = bodies.length > 0 && bodies.every((body) => body.getBoundingClientRect().height > 0)
    if (groupsOpen && bodiesOpen) break
    await wait(50)
  }
  // 上滚手势松掉跟随（读历史态），再把这一轮顶到可视区上缘附近：收起过程要整个看得见。
  chat.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }))
  await wait(200)
  // 等滚动落到目标位置（等条件，最多 3s），别按 3×220ms 猜。
  const scrollDeadline = performance.now() + 3000
  while (performance.now() < scrollDeadline) {
    const seat = seatNow()
    if (seat === null) break
    const top = seat.getBoundingClientRect().top - chat.getBoundingClientRect().top
    if (Math.abs(top - 90) <= 4) break
    chat.scrollTop += top - 90
    await wait(120)
  }
  window.__stage = { round }
  const seat = seatNow()
  const segment = seat === null ? null : seat.querySelector('.turn-process')
  const body = segment === null ? null : segment.firstElementChild
  return {
    round,
    openedGroups,
    rows: body === null ? 0 : body.children.length,
    rowHeights: body === null ? [] : [...body.children].map((row) => Math.round(row.getBoundingClientRect().height)),
    segmentTop: segment === null ? null
      : Math.round(segment.getBoundingClientRect().top - chat.getBoundingClientRect().top),
    scrollTop: Math.round(chat.scrollTop),
    canScrollUp: Math.round(chat.scrollTop),
    canScrollDown: Math.round(chat.scrollHeight - chat.clientHeight - chat.scrollTop),
  }
`)
console.log('prepared', JSON.stringify(prepared))
if (prepared?.error !== undefined) {
  try { ws.close() } catch {}
  try { electron.kill() } catch {}
  try { server.close() } catch {}
  process.exit(1)
}

/**
 * 在页面里逐帧记一段收起过程。
 *
 * 为什么不信截图那一刻的读数：CDP 一次往返几十毫秒，而收起只有 200ms——第一张读数落在
 * 「高度还没开始动」（高度延迟 62ms），第二张就已经收完了。数字由页面自己的 rAF 记，
 * 截图只负责给人看形状。
 */
const startRecorder = () => evaluate(`
  const seat = document.querySelector('.turn-seat[data-round-seat="' + window.__stage.round + '"]')
  const segment = seat === null ? null : seat.querySelector('.turn-process')
  window.__rec = { on: true, list: [], t0: performance.now() }
  const sample = () => {
    const body = segment === null ? null : segment.firstElementChild
    return {
      t: Math.round(performance.now() - window.__rec.t0),
      procH: segment === null ? null : Number(segment.getBoundingClientRect().height.toFixed(1)),
      fold: segment === null ? null : segment.getAttribute('data-fold'),
      rowHs: body === null ? [] : [...body.children].map((row) => Number(row.getBoundingClientRect().height.toFixed(1))),
      opacities: body === null ? [] : [...body.children].map((row) => Number(Number(getComputedStyle(row).opacity).toFixed(2))),
      hidden: body === null ? 0 : [...body.children].filter((row) => row.hasAttribute('hidden')).length,
    }
  }
  const tick = () => {
    if (!window.__rec.on) return
    window.__rec.list.push(sample())
    requestAnimationFrame(tick)
  }
  // 再挂一条 16ms 的定时采样：淡出只有约 70ms，rAF 被 CPU 抢占时可能整个跳过
  // 「透明度已降、高度还没降」那一瞬（实测负载下出现过 0.63 → 0 的 91ms 跳格）。
  const tickTimer = () => {
    if (!window.__rec.on) return
    window.__rec.list.push(sample())
    setTimeout(tickTimer, 16)
  }
  requestAnimationFrame(tick)
  setTimeout(tickTimer, 16)
  return { ok: true }
`)
const readRecorder = async () => {
  const list = await evaluate(`window.__rec.on = false; return window.__rec.list`)
  return list
}

/**
 * 点一下目标轮的整轮开关。
 *
 * 先把焦点放到开关上再点：真实的鼠标点击本来就会把焦点落在这个按钮上，而
 * 「收起时焦点在子树里就展开整轮」是产品有意保留的规则——焦点要是还停在段里某个组头上，
 * 这一轮会被放行展开，量到的就不是收起。
 */
const toggleStage = () => evaluate(`
  const seat = document.querySelector('.turn-seat[data-round-seat="' + window.__stage.round + '"]')
  const btn = seat === null ? null : seat.querySelector('.turn-fold:not([disabled])')
  if (btn === null) return { error: '目标轮没有可折的开关' }
  btn.focus()
  btn.click()
  return { clicked: true }
`)

await startRecorder()
const collapseClick = await toggleStage()
const collapsing = await shoot('_fold-motion-1-collapsing.png')
await sleep(90)
const mid = await shoot('_fold-motion-2-collapse-mid.png')
// 等收起真的到底（fold=closed 且段高 0），不再盲等 450ms。等不到就留着现场让判据红。
const collapseSettled = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const deadline = performance.now() + 5000
  let state = { fold: null, procH: null }
  while (performance.now() < deadline) {
    const seat = document.querySelector('.turn-seat[data-round-seat="' + window.__stage.round + '"]')
    const segment = seat === null ? null : seat.querySelector('.turn-process')
    state = {
      fold: segment === null ? null : segment.getAttribute('data-fold'),
      procH: segment === null ? null : Number(segment.getBoundingClientRect().height.toFixed(1)),
    }
    if (state.fold === 'closed' && state.procH === 0) break
    await wait(50)
  }
  return state
`)
console.log('collapseSettled', JSON.stringify(collapseSettled))
const collapsed = await shoot('_fold-motion-3-collapse-end.png')
const collapseFrames = await readRecorder()
console.log('collapseFrames', JSON.stringify(collapseFrames.filter((_f, index) => index % 2 === 0)))
const expandClick = await toggleStage()
// 展开是瞬时的：只等 data-fold 翻成 open（不等行高，否则「行体挂回来」这条就自证了）。
const expandOpened = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const deadline = performance.now() + 5000
  let fold = null
  while (performance.now() < deadline) {
    const seat = document.querySelector('.turn-seat[data-round-seat="' + window.__stage.round + '"]')
    const segment = seat === null ? null : seat.querySelector('.turn-process')
    fold = segment === null ? null : segment.getAttribute('data-fold')
    if (fold === 'open') break
    await wait(50)
  }
  return { fold }
`)
console.log('expandOpened', JSON.stringify(expandOpened))
const expanding = await shoot('_fold-motion-4-expanding.png')

// ── 判据 ───────────────────────────────────────────────────────────────────────────
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

const last = report.after
const floor = last.sh - (last.spacer > 0 ? last.spacer : 0) - last.ch
const tallest = prepared.rowHeights.length === 0 ? 0 : Math.max(...prepared.rowHeights)

// ── 环境闸 A：先证明「场景 A 的采样可信」，再判产品 ─────────────────────────────
const envA = []
if (report.frames < 150) envA.push(`rAF 样本 ${String(report.frames)} 帧 < 150（窗口内不足 25fps）`)
if (report.maxGap > 500) envA.push(`相邻样本最大间隔 ${String(Math.round(report.maxGap))}ms > 500ms（页面被冻住）`)
if (report.answerFrames < 12) envA.push(`答案行只被采到 ${String(report.answerFrames)} 帧 < 12`)
if (started.opened !== true || report.procMax <= 200) {
  envA.push(`流式过程区没摊开（opened=${String(started.opened)}，最高 ${String(report.procMax)}px）`)
}
if (report.slackMax === null || report.slackMax <= 300) envA.push(`没有可滚范围（max(sh-ch)=${String(report.slackMax)}）`)
if (finished.sawStatus !== true) envA.push('整段采样里没见到回合状态行（这一轮可能没跑起来）')
const envAOk = envA.length === 0
check('环境：场景 A 的采样现场可判读', envAOk, envA.join('；'))

if (envAOk) {
  check('位置回退 0 次（相邻帧 top 增加 > 1px 的次数）', report.recede === 0, `实测回退 ${String(report.recede)} 次`)
  check('收起前后那一行的屏幕 top 漂移 ≤ 2px', report.drift !== null && report.drift <= 2, `实测 ${String(report.drift)}px`)
  // 16ms 状态采样在 240ms 的收起里能采 ~15 个点；中间高度 ≥5 帧 = 至少 80ms 在过渡中。
  check('收尾的过程区真的有一大块：最高 > 200px，中间高度 ≥ 5 帧',
    report.procMax > 200 && report.midFrames >= 5,
    `满高 ${String(report.procMax)}px、中间帧 ${String(report.midFrames)}（状态采样 ${String(report.ticks)} 次）`)
  check('末帧：data-fold 已翻成 closed', last.fold === 'closed', `实际 ${JSON.stringify(last.fold)}`)
  check('末帧没有残留高度：过程区与装载层都是 0', last.procH === 0 && last.bodyH === 0, `procH=${String(last.procH)} bodyH=${String(last.bodyH)}`)
  check('末帧：段里每一行都挂了 hidden', last.rows >= 1 && last.hiddenRows === last.rows, `${String(last.hiddenRows)}/${String(last.rows)}`)
  check('收工后贴底：scrollTop 在 floor 上（±2px）', Math.abs(last.chatTop - floor) <= 2, `top=${String(Math.round(last.chatTop))} floor=${String(Math.round(floor))}`)
  check('收工后占位回 0（空白没有被占位吃住）', last.spacer === 0, `实测 ${String(last.spacer)}`)
} else {
  for (const name of [
    '位置回退 0 次（相邻帧 top 增加 > 1px 的次数）',
    '收起前后那一行的屏幕 top 漂移 ≤ 2px',
    '收尾的过程区真的有一大块：最高 > 200px，中间高度 ≥ 5 帧',
    '末帧：data-fold 已翻成 closed',
    '末帧没有残留高度：过程区与装载层都是 0',
    '末帧：段里每一行都挂了 hidden',
    '收工后贴底：scrollTop 在 floor 上（±2px）',
    '收工后占位回 0（空白没有被占位吃住）',
  ]) skip(name, envA.join('；'))
}

// ── 环境闸 B：场景 B 的现场与采样密度 ────────────────────────────────────────────
const envB = []
let maxRecGap = 0
for (let at = 1; at < collapseFrames.length; at += 1) {
  maxRecGap = Math.max(maxRecGap, collapseFrames[at].t - collapseFrames[at - 1].t)
}
if (collapseClick?.error !== undefined) envB.push(`收起点击无效：${String(collapseClick.error)}`)
if (expandClick?.error !== undefined) envB.push(`展开点击无效：${String(expandClick.error)}`)
if (prepared.rows < 1 || tallest <= 100) envB.push(`段里没有真高度（rows=${String(prepared.rows)}, tallest=${String(tallest)}）`)
if (!(prepared.canScrollUp > 60 && prepared.canScrollDown > 20)) envB.push(`上下滚动空间不够（上 ${String(prepared.canScrollUp)} / 下 ${String(prepared.canScrollDown)}）`)
if (!(prepared.segmentTop >= 40 && prepared.segmentTop <= 240)) envB.push(`整段不在可视区里（top=${String(prepared.segmentTop)}）`)
// 收起 240ms；按 60fps 应有 ~14 帧。少于 15 帧说明采样太稀，逐行中间值判不了
// （阈值 15 是「240ms × 60fps ≈ 14」取整，宁严不松）。
if (collapseFrames.length < 15) envB.push(`收起窗口只有 ${String(collapseFrames.length)} 帧 rAF 样本 < 15`)
// 收起 240ms；rAF 间隔 >100ms（<10fps）时，逐行中间值最多采到 2 个点，判不了「行自己在变矮」。
// 实测正常 5–12ms，降速 20 倍时到 226ms——两者差一个数量级，100ms 不会误伤安静环境。
if (maxRecGap > 100) envB.push(`收起采样最长间隔 ${String(Math.round(maxRecGap))}ms > 100ms（逐行中间值不可信）`)
const envBOk = envB.length === 0
check('环境：场景 B 的现场可判读', envBOk, envB.join('；'))

if (envBOk) {
  const rowMidFrames = collapseFrames.filter((frame) => frame.rowHs.some((h) => h > 0.5 && h < tallest - 2))
  check(
    '收起中：**行自己**在变矮（不是整段一刀切——那样行的实测高度会一直等于满高）',
    rowMidFrames.length >= 3 && collapseFrames.some((frame) => frame.procH > 0),
    `行高度走中间值的帧 ${String(rowMidFrames.length)} 帧；tallest=${String(tallest)}`,
  )
  // 「透明度先走、高度后走」按**先后**判，不按某个固定透明度判：
  // 淡出只有 70ms，负载下 16ms 采样可能只落到 0.63 这一格（实测），用 `< 0.6` 会把
  // 采样相位问题当成产品问题。这里要求：先出现「已经变淡（<0.9）且高度仍是满高」的一帧，
  // 之后才出现「高度掉到 80% 以下」的一帧。去掉淡出、或高度与透明度同时走，这条都会红。
  const fadeFrame = collapseFrames.find((frame) => frame.opacities.length > 0 && frame.opacities[0] < 0.9)
  const shrinkFrame = collapseFrames.find((frame) => frame.rowHs.length > 0 && frame.rowHs[0] < tallest * 0.8)
  check(
    '收起中：透明度先走、高度后走（淡出约 44%，高度延迟约 31%）',
    fadeFrame !== undefined && shrinkFrame !== undefined && fadeFrame.t <= shrinkFrame.t
      && fadeFrame.rowHs[0] > tallest * 0.8,
    JSON.stringify({
      fadeAt: fadeFrame?.t ?? null,
      fadeOpacity: fadeFrame?.opacities[0] ?? null,
      fadeRowH: fadeFrame?.rowHs[0] ?? null,
      shrinkAt: shrinkFrame?.t ?? null,
      shrinkRowH: shrinkFrame?.rowHs[0] ?? null,
      tallest,
    }),
  )
  const procMaxSeen = Math.max(0, ...collapseFrames.map((frame) => typeof frame.procH === 'number' ? frame.procH : 0))
  const procMidFrames = collapseFrames.filter((frame) => typeof frame.procH === 'number'
    && frame.procH > 0.5 && frame.procH < procMaxSeen - 2).length
  check(
    '收起中：段高出现中间值（不是一帧闪没）',
    procMidFrames >= 3,
    JSON.stringify({ procMidFrames, procMaxSeen, firstProc: collapsing.procH, midProc: mid.procH }),
  )
  check(
    '收起末：段高 0、每一行高度 0 且都挂了 hidden',
    collapsed.fold === 'closed' && collapsed.procH === 0
      && collapsed.rowHs.every((h) => h === 0) && collapsed.hiddenRows === collapsed.rowHs.length,
    JSON.stringify({ fold: collapsed.fold, procH: collapsed.procH, hidden: collapsed.hiddenRows, rowHs: collapsed.rowHs }),
  )
  check(
    '展开中：行体原样挂回（没有高度过渡残留）',
    expanding.fold === 'open' && expanding.rowHs.every((h) => h > 0) && expanding.hiddenRows === 0,
    JSON.stringify({ fold: expanding.fold, hidden: expanding.hiddenRows, rowHs: expanding.rowHs }),
  )
} else {
  for (const name of [
    '收起中：**行自己**在变矮（不是整段一刀切——那样行的实测高度会一直等于满高）',
    '收起中：透明度先走、高度后走（淡出约 44%，高度延迟约 31%）',
    '收起中：段高出现中间值（不是一帧闪没）',
    '收起末：段高 0、每一行高度 0 且都挂了 hidden',
    '展开中：行体原样挂回（没有高度过渡残留）',
  ]) skip(name, envB.join('；'))
}

console.log(`\n[_verify-think-collapse] 断言 ${String(passed + failures)} 条，通过 ${String(passed)} 条，失败 ${String(failures)} 条，环境跳过 ${String(skipped)} 条`)
try { ws.close() } catch {}
try { electron.kill() } catch {}
try { server.close() } catch {}
await sleep(500)
process.exit(failures === 0 ? 0 : 1)
