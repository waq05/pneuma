process.on('unhandledRejection', () => {})

/**
 * 「读历史时整轮折叠 / 展开，眼前那行不许跳」的真机探针（视口四阶段 ③ 的验收，2026-11-11）。
 *
 * 要证的是三件事，缺一条另外两条都能作弊：
 *   1. **不动**：滚到「读历史」的位置（不是贴底）之后点整轮折叠 / 展开，**第一条可见行**
 *      的屏幕 `top` 变化 ≤1px（每帧采样，不是只看首末两帧）；
 *   2. **在动**：同一段时间里 `scrollTop` 真的被补过（折叠 / 展开把上面那段的高度改了多少，
 *      就该补多少）。只证第 1 条的话，「什么都不做、正好这行本来就不动」也能通过；
 *   3. **`overflow-anchor` 按时间开关**：批次活跃期间 `.chat` 的内联值是 `none`，
 *      批次结束后是空串（落回样式表那条常态口径）；末帧占位高度是 0。
 *
 * 现场：8 轮历史（user + 思考 + 过程正文 + 工具调用 + 结果）先落盘 → 打开会话 →
 * 用一个**真实的上滚手势**（合成 wheel，deltaY < 0）让跟随松手 → 把某一轮的答案行
 * 顶到可视区顶端 → 先展开（这几轮默认收起）、再收起，各采一段。
 *
 * 为什么必须用真机：几何、CSS 过渡、`ResizeObserver` 的投递时机都是浏览器行为，
 * Node 里既没有布局也没有帧。
 *
 * 运行：node desktop/shots/_verify-fold-scroll.mjs
 * 产物：desktop/shots/_fold-scroll.png（收工时的整屏）
 *
 * 前提：`pnpm run build`（要 lib/core/session.js 写种子）与 `pnpm run build:ui` 都跑过。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-fold-scroll-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18994
const debugPort = 9374

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(join(work), { recursive: true })
// Chromium 在 app ready 之前会去 %USERPROFILE%\AppData\Roaming 找配置：目录不存在会直接崩。
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-fold-scroll', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-fold-scroll', '        name: Fake Fold Scroll',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
// completion：已收尾的轮默认收起，于是「先展开、再收起」两个方向各有一批要跑。
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({ ui: { collapseTiming: 'completion' } }))

// ── 历史种子：必须是宿主自己的 Session 写的（手搓 jsonl 会和宿主的重放口径对不上）──────
process.env.HOME = home
process.env.USERPROFILE = home
const core = await import('../../lib/core/session.js')
const seed = core.Session.create(work)
const HISTORY_ROUNDS = 8
/** 每轮的过程行数：折叠区要够高，补位量（scrollTop 变化）才有几百像素，断言才有分量。 */
const STEPS_PER_ROUND = 4
for (let round = 0; round < HISTORY_ROUNDS; round += 1) {
  seed.appendUser(`第 ${String(round + 1)} 轮：把这一段的边界条件过一遍，别漏了空数组那一条。`)
  seed.appendAssistant(
    `第 ${String(round + 1)} 轮的结论：边界条件没问题，下面那条读取只是确认调用方。`,
    `思考：第 ${String(round + 1)} 轮先核对入参与返回值，空数组那种情况最容易漏。\n`,
    [],
  )
  for (let step = 0; step < STEPS_PER_ROUND; step += 1) {
    seed.appendAssistant(`第 ${String(step + 1)} 步：读一下调用方确认口径。`, '', [
      {
        id: `call_fold_${String(round)}_${String(step)}`,
        name: 'read',
        arguments: JSON.stringify({ path: join(work, 'probe-target.txt') }),
      },
    ])
    seed.appendTool(
      `call_fold_${String(round)}_${String(step)}`,
      'read',
      `第 ${String(round + 1)} 轮第 ${String(step + 1)} 步读到的样张内容（三行）。`,
    )
  }
  // 收尾的定稿正文：过程区之外的那一行，读者在读历史时盯的就是它，
  // 也是探针的「第一条可见行」（过程行都在 .turn-process 里，会被避开）。
  seed.appendAssistant(`第 ${String(round + 1)} 轮收尾：调用方口径与入参一致，这一轮不用改。`, '', [])
}
seed.close()

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

await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(600)

// ── 摆位置：真手势松跟随 → 把某轮的答案行顶到可视区顶端 ─────────────────────────────
const placed = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 240; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(100)
  }
  const chat = document.querySelector('.chat')
  if (chat === null) return { error: '没有 .chat' }
  for (let i = 0; i < 240; i += 1) {
    if (chat.querySelectorAll('.entry-row').length >= 20) break
    await wait(100)
  }
  // 上滚手势：跟随的策略靠「有手势作证」才认读者在读历史（follow.ts 第 4 条规矩）。
  // 不先做这一下，后面把 scrollTop 挪走会被当成排版抖动，下一帧又被钉回底部。
  chat.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }))
  await wait(260)

  const seats = [...chat.querySelectorAll('.turn-seat[data-round-seat]')]
  const trials = []
  const pick = async () => {
    for (let index = 1; index < seats.length - 1; index += 1) {
      const seat = seats[index]
      const btn = seat.querySelector('.turn-fold:not([disabled])')
      const text = seat.querySelector('.entry-text')
      const segment = seat.querySelector('.turn-process')
      const trial = {
        round: seat.getAttribute('data-round-seat'),
        btn: btn !== null,
        text: text !== null,
        segment: segment !== null,
        rows: [...seat.querySelectorAll('.entry-row')].map((row) => row.firstElementChild?.className ?? '(空)'),
      }
      if (btn === null || text === null || segment === null) { trials.push(trial); continue }
      const answer = text.closest('.entry-row')
      if (answer === null) { trial.noAnswerRow = true; trials.push(trial); continue }
      // 整轮折叠区里装的是阶段组，组体默认收起——不先摊开，整轮折叠只动 28px 的组头，
      // 量出来的补位量没有分量。组头的开合不走 data-fold（不是视口批次），可以提前点开。
      let opened = 0
      for (const groupBtn of seat.querySelectorAll('.step-fold')) {
        if (groupBtn.getAttribute('data-open') === '1') continue
        groupBtn.click()
        opened += 1
      }
      if (opened > 0) await wait(420)
      // 展开后会长多高：组体收起时高度是 0，但内容还在，scrollHeight 量得到。
      const bodies = [...seat.querySelectorAll('.step-body')]
      trial.openState = [...seat.querySelectorAll('.step-fold')].map((node) => node.getAttribute('data-open'))
      trial.bodyShape = bodies.map((body) => [Math.round(body.scrollHeight), Math.round(body.offsetHeight), body.hasAttribute('hidden') ? 'H' : ''].join('/'))
      const grown = bodies.reduce((sum, body) => sum + Math.max(body.scrollHeight, body.offsetHeight), 0)
        + bodies.length * 28
      const offset = answer.getBoundingClientRect().top - chat.getBoundingClientRect().top
      chat.scrollTop += offset - 2
      const above = chat.scrollTop
      const below = chat.scrollHeight - chat.clientHeight - chat.scrollTop
      trial.grown = Math.round(grown)
      trial.above = Math.round(above)
      trial.below = Math.round(below)
      trial.opened = opened
      // 组体在这一态量不到高度（整轮的组座位挂着 hidden），所以不按 grown 卡；
      // 只要求「上方能抹平一次展开、下方还能滚一小段」。
      if (above < 420 || below < 60) { trials.push(trial); continue }
      return { seat, btn, answer, grown, floor: chat.scrollHeight - chat.clientHeight }
    }
    return null
  }
  const target = await pick()
  if (target === null) return { error: '没有找到合适的整轮（上下空间都不够）', trials, total: seats.length }
  await wait(320)

  const view = chat.getBoundingClientRect()
  const visible = (row) => {
    const rect = row.getBoundingClientRect()
    return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom && row.closest('[hidden]') === null
  }
  // 与视口协调器同一条口径：第一条可见、且不被这一批搬动的行（不在任何 .turn-process 里）。
  const rows = [...chat.querySelectorAll('.entry-row')]
  const anchor = rows.find((row) => visible(row) && row.closest('.turn-process') === null) ?? null
  if (anchor === null) return { error: '没有可见的锚点行' }
  const spacer = chat.querySelector('[data-chat-turn-spacer]')
  const isAlone = anchor.closest('.turn-seat') === target.seat

  window.__foldProbe = {
    chat, anchor, spacer, target,
    sampling: false, samples: [], baseline: 0,
  }
  return {
    rounds: seats.length,
    round: target.seat.getAttribute('data-round-seat'),
    grown: Math.round(target.grown),
    scrollTop: Math.round(chat.scrollTop),
    floor: Math.round(target.floor),
    anchorIsTargetRound: isAlone,
    anchorTop: Math.round(anchor.getBoundingClientRect().top - view.top),
    anchorInFold: anchor.closest('.turn-process') !== null,
    rows: rows.length,
    canScrollUp: Math.round(chat.scrollTop),
    canScrollDown: Math.round(target.floor - chat.scrollTop),
  }
`)
console.log('place', JSON.stringify(placed))
if (placed?.error !== undefined) {
  try { ws.close() } catch {}
  try { electron.kill() } catch {}
  process.exit(1)
}

/**
 * 开一段采样。
 *
 * 为什么在 rAF 里再挂一个 `setTimeout(0)` 才量：视口协调器的补位写在同一帧的
 * rAF / ResizeObserver 里，而探针自己的 rAF 回调排在它前面（先注册）。直接在 rAF 里读，
 * 读到的是「这一帧动画又长了一点、补位还没写」的那一瞬——量到的是补偿前的差值，
 * 不是屏幕上的位置。计时器任务跑在这一帧画完之后、下一帧开始之前，读到的是真正画出来的位置。
 */
const beginSample = () => evaluate(`
  const p = window.__foldProbe
  p.samples = []
  p.sampling = true
  p.baseline = p.anchor.getBoundingClientRect().top
  const chat = p.chat
  const segment = p.target.seat.querySelector('.turn-process')
  const push = () => {
    if (!p.sampling) return
    const rect = p.anchor.getBoundingClientRect()
    p.samples.push({
      t: performance.now(),
      top: rect.top,
      h: rect.height,
      scrollTop: chat.scrollTop,
      sh: chat.scrollHeight,
      fold: segment === null ? null : segment.getAttribute('data-fold'),
      segH: segment === null ? null : Number(segment.getBoundingClientRect().height.toFixed(1)),
      inline: chat.style.overflowAnchor,
      computed: getComputedStyle(chat).overflowAnchor,
      spacer: p.spacer === null ? -1 : p.spacer.offsetHeight,
      spacerInline: p.spacer === null ? '' : p.spacer.style.height,
    })
  }
  const tick = () => {
    if (!p.sampling) return
    requestAnimationFrame(tick)
    setTimeout(push, 0)
  }
  // 先当场记一条「点之前」的样子：补位量要拿它当起点（收起方向可能在第一帧里
  // 就把整片内容撤掉，等第一个帧后再记，起点已经是被补过的位置了）。
  push()
  requestAnimationFrame(tick)
  return { baseline: p.baseline }
`)

/** 点一下整轮开关，跑满一个批次窗口（过渡 180ms + 尾巴）再多等一截，然后停采样。 */
const toggle = (ms = 900) => evaluate(`
  window.__foldProbe.target.btn.click()
  await new Promise((r) => setTimeout(r, ${String(ms)}))
  window.__foldProbe.sampling = false
  const p = window.__foldProbe
  const last = p.samples[p.samples.length - 1]
  return { samples: p.samples, baseline: p.baseline, last }
`)

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

/** 一段采样的判读。 */
const judge = (label, run) => {
  const samples = run.samples
  const baseline = run.baseline
  const drifts = samples.map((s) => Math.abs(s.top - baseline))
  const maxDrift = drifts.length === 0 ? 0 : Math.max(...drifts)
  const worst = samples[drifts.indexOf(maxDrift)]
  const none = samples.filter((s) => s.inline === 'none')
  const last = samples[samples.length - 1] ?? {}
  const first = samples[0] ?? {}
  const moved = Math.abs((last.scrollTop ?? 0) - (first.scrollTop ?? 0))
  const computedNone = none.every((s) => s.computed === 'none')
  const segHeights = samples.map((s) => s.segH).filter((v) => typeof v === 'number')
  const trace = samples.slice(0, 30).map((s) => ({
    t: Math.round(s.t),
    top: Number(s.top.toFixed(1)),
    st: Math.round(s.scrollTop),
    sh: Math.round(s.sh),
    seg: s.segH,
    f: s.fold,
    a: s.inline === 'none' ? 'n' : '',
  }))
  console.log(`${label}`, JSON.stringify({
    frames: samples.length,
    baseline: Math.round(baseline),
    maxDrift: Number(maxDrift.toFixed(2)),
    worstAt: worst === undefined ? null : { t: Math.round(worst.t), top: Number(worst.top.toFixed(2)), scrollTop: Math.round(worst.scrollTop) },
    noneFrames: none.length,
    computedNone,
    scrollMoved: Math.round(moved),
    segFrom: segHeights.length === 0 ? null : Math.min(...segHeights),
    segTo: segHeights.length === 0 ? null : Math.max(...segHeights),
    foldAt: [...new Set(samples.map((s) => s.fold))],
    endInline: last.inline ?? null,
    endSpacer: last.spacer ?? null,
    endSpacerInline: last.spacerInline ?? null,
    endTop: last.top === undefined ? null : Number(last.top.toFixed(2)),
  }))
  // 只在没达标时把逐帧轨迹摊开：通过的时候它是噪音，失败的时候它是唯一的证据。
  if (maxDrift > 1) console.log(`${label} trace`, JSON.stringify(trace))
  return { maxDrift, noneFrames: none.length, last, first, moved, computedNone, samples }
}

// ── 方向一：展开（这几轮默认收起）─────────────────────────────────────────────
await beginSample()
const expandRun = await toggle()
const expand = judge('[expand]', expandRun)
check('展开：第一条可见行的屏幕 top 变化 ≤1px', expand.maxDrift <= 1, `实测 ${expand.maxDrift.toFixed(2)}px`)
check('展开：scrollTop 真的补过（不是「本来就不动」）', expand.moved >= 40, `实测补了 ${Math.round(expand.moved)}px`)
check('展开：批次活跃期间 .chat 的内联 overflow-anchor 是 none', expand.noneFrames >= 4, `只有 ${String(expand.noneFrames)} 帧`)
check('展开：批次期间的计算值也是 none', expand.computedNone === true)
check('展开：批次结束后内联 overflow-anchor 还原成空串', expand.last.inline === '', `实际 ${JSON.stringify(expand.last.inline)}`)
check('展开：末帧占位高度回到 0', expand.last.spacer === 0 && expand.last.spacerInline === '',
  `offsetHeight=${String(expand.last.spacer)} inline=${JSON.stringify(expand.last.spacerInline)}`)
check('展开：末帧锚点行仍在原位', Math.abs((expand.last.top ?? 0) - expandRun.baseline) <= 1)

// 展开之后锚点行不该换人：收起方向就在同一个起点上比。
const rearm = await evaluate(`
  const p = window.__foldProbe
  const rect = p.anchor.getBoundingClientRect()
  const chatRect = p.chat.getBoundingClientRect()
  return {
    connected: p.anchor.isConnected,
    top: Number(rect.top.toFixed(2)),
    relative: Number((rect.top - chatRect.top).toFixed(2)),
    height: Number(rect.height.toFixed(2)),
    same: p.anchor.closest('.turn-seat') === p.target.seat,
  }
`)
console.log('rearm', JSON.stringify(rearm))
check('展开之后锚点行没换人（收起方向在同一个起点上比）',
  rearm.connected === true && rearm.same === true && Math.abs(rearm.relative - 2) <= 1,
  JSON.stringify(rearm))

// ── 方向二：收起 ─────────────────────────────────────────────────────────────
await beginSample()
const collapseRun = await toggle()
const collapse = judge('[collapse]', collapseRun)
check('收起：第一条可见行的屏幕 top 变化 ≤1px', collapse.maxDrift <= 1, `实测 ${collapse.maxDrift.toFixed(2)}px`)
check('收起：scrollTop 真的补过', collapse.moved >= 40, `实测补了 ${Math.round(collapse.moved)}px`)
check('收起：批次活跃期间 .chat 的内联 overflow-anchor 是 none', collapse.noneFrames >= 4, `只有 ${String(collapse.noneFrames)} 帧`)
check('收起：批次期间的计算值也是 none', collapse.computedNone === true)
check('收起：批次结束后内联 overflow-anchor 还原成空串', collapse.last.inline === '', `实际 ${JSON.stringify(collapse.last.inline)}`)
check('收起：末帧占位高度回到 0', collapse.last.spacer === 0 && collapse.last.spacerInline === '',
  `offsetHeight=${String(collapse.last.spacer)} inline=${JSON.stringify(collapse.last.spacerInline)}`)
check('收起：末帧锚点行仍在原位', Math.abs((collapse.last.top ?? 0) - collapseRun.baseline) <= 1)

// 位置本身的前提（不然上面那些数字没有意义）：真的在「读历史」，不是贴底也不是到顶。
check('起始位置在读历史（不是贴底、也不是到顶）',
  typeof placed.canScrollUp === 'number' && placed.canScrollUp > 80
    && typeof placed.canScrollDown === 'number' && placed.canScrollDown > 60,
  `上方 ${String(placed.canScrollUp)}px、下方 ${String(placed.canScrollDown)}px`)
check('锚点行不在这一批会动的段里', placed.anchorInFold === false)
check('锚点行属于被点的那一轮（读者眼睛就在这一轮上）', placed.anchorIsTargetRound === true)

// ── 方向三：跟随态（贴底）下的同一批，落点必须是 floor ─────────────────────────
// 两种落点各验一遍：读历史态保锚点行，贴底态要一直停在 floor（批次里内容长高了，
// floor 也跟着长，钉底的人看到的是「最后一行不动」）。
const toBottom = await evaluate(`
  const p = window.__foldProbe
  const chat = p.chat
  const pill = document.querySelector('.chat-to-bottom')
  if (pill !== null) pill.click()
  await new Promise((r) => setTimeout(r, 260))
  chat.scrollTop = chat.scrollHeight
  await new Promise((r) => setTimeout(r, 320))
  // 换一个还没动过的整轮（最后一轮）：它的折叠区在底部上方，展开会改 floor。
  const seats = [...chat.querySelectorAll('.turn-seat[data-round-seat]')]
  let target = null
  for (let index = seats.length - 1; index >= 0; index -= 1) {
    const btn = seats[index].querySelector('.turn-fold:not([disabled])')
    if (btn === null || seats[index] === p.target.seat) continue
    target = { seat: seats[index], btn }
    break
  }
  if (target === null) return { error: '没有第二个可折的整轮' }
  p.tail = { target, samples: [] }
  return {
    pill: pill !== null,
    top: Math.round(chat.scrollTop),
    floor: Math.round(chat.scrollHeight - chat.clientHeight),
    round: target.seat.getAttribute('data-round-seat'),
    collapsed: target.seat.querySelector('.turn-process') === null
      || target.seat.querySelector('.turn-process').getAttribute('data-fold') === 'closed',
  }
`)
console.log('toBottom', JSON.stringify(toBottom))
if (toBottom?.error === undefined) {
  await evaluate(`
    const p = window.__foldProbe
    const chat = p.chat
    p.tail.samples = []
    p.tail.sampling = true
    const push = () => {
      if (!p.tail.sampling) return
      p.tail.samples.push({
        t: performance.now(),
        top: chat.scrollTop,
        floor: chat.scrollHeight - (p.spacer === null ? 0 : p.spacer.offsetHeight) - chat.clientHeight,
        inline: chat.style.overflowAnchor,
        spacer: p.spacer === null ? -1 : p.spacer.offsetHeight,
      })
    }
    const tick = () => {
      if (!p.tail.sampling) return
      requestAnimationFrame(tick)
      setTimeout(push, 0)
    }
    push()
    requestAnimationFrame(tick)
    return { ok: true }
  `)
  const tailRun = await evaluate(`
    const p = window.__foldProbe
    p.tail.target.btn.click()
    await new Promise((r) => setTimeout(r, 900))
    p.tail.sampling = false
    const samples = p.tail.samples
    const last = samples[samples.length - 1]
    return { samples, last }
  `)
  const slack = tailRun.samples.map((s) => Math.abs(s.top - s.floor))
  const worstSlack = slack.length === 0 ? 0 : Math.max(...slack)
  const noneFrames = tailRun.samples.filter((s) => s.inline === 'none').length
  const moved = tailRun.samples.length === 0
    ? 0
    : Math.abs(tailRun.samples[tailRun.samples.length - 1].top - tailRun.samples[0].top)
  console.log('[tail]', JSON.stringify({
    frames: tailRun.samples.length,
    worstSlack: Number(worstSlack.toFixed(2)),
    noneFrames,
    moved: Math.round(moved),
    endTop: Math.round(tailRun.last.top),
    endFloor: Math.round(tailRun.last.floor),
    endSpacer: tailRun.last.spacer,
  }))
  check('贴底：批次里每次都停在 floor（离底 ≤2px）', worstSlack <= 2, `最大差 ${worstSlack.toFixed(2)}px`)
  check('贴底：批次里 floor 真的变了（不是「本来就在底」）', moved >= 20, `实测 ${Math.round(moved)}px`)
  check('贴底：批次活跃期间内联 overflow-anchor 也是 none', noneFrames >= 4, `只有 ${String(noneFrames)} 帧`)
  check('贴底：末帧在 floor 上', Math.abs(tailRun.last.top - tailRun.last.floor) <= 2)
}

// 收工时的整屏：这时这一轮是收起态（第二次点过），画面里能看出历史位置。
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(shots, '_fold-scroll.png'), Buffer.from(shot.data, 'base64'))

console.log(`\n[_verify-fold-scroll] 断言 ${String(passed + failures)} 条，通过 ${String(passed)} 条，失败 ${String(failures)} 条`)
try { ws.close() } catch {}
try { electron.kill() } catch {}
await sleep(400)
process.exit(failures === 0 ? 0 : 1)
