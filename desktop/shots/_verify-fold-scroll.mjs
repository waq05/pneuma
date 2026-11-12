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
 * ## 2026-11-12：为什么不再「点完等 900ms」（这一节比上面的判据更重要）
 *
 * 旧版点完开关就 `await new Promise(r => setTimeout(r, 900))`，然后直接拿这 900ms 里的
 * 样本判读。负载下（并发构建、别的探针也在跑 Electron）这套写法有两个坑：
 *
 *   · **批次的起点不在采样窗口里**：一次收起 / 展开的批次只有 `--dsc-dur-slow` + 60ms
 *     提交余量（默认 240ms），而批次是点下去之后由 React 布局效果→微任务开出来的。
 *     页面忙的时候，这 240ms 可能整段落在一个采样间隔之外：读到的 `noneFrames` 是 0、
 *     `scrollTop` 差值是 0——看起来像产品「批次没开」，其实只是没采到。
 *   · **点击用的是一个几百毫秒前缓存的按钮**：放置阶段把 `.turn-fold` 元素存进
 *     `window.__foldProbe`，之后 React 只要重挂过这一轮（切会话 / 历史回填 / 设置到位），
 *     存下来的节点就已经脱离文档，`.click()` 什么都不做。样本于是「全 0」，同样像产品坏了。
 *
 * 现在的口径：
 *
 *   1. 每次点击前**按轮号重新解析**座位与开关（`seatNow()` / `btnNow()`），节点不在文档里
 *      就当场记「环境未就绪」，不拿空样本去判产品；
 *   2. 点击后**轮询批次条件**：`MutationObserver` 盯 `.chat` 的内联 `overflow-anchor`
 *      变成 `none` 再回到空串；同时 16ms 采一次状态（内联值 / 段高 / 行内联高度）。
 *      等到条件成立（或超时）才停采样，不再猜时长；
 *   3. 判读前先要求「有效帧 ≥ 24、状态采样 ≥ 10」。达不到就只红一条
 *      **「环境：现场可判读」**，后面的产品判据全部跳过（打印 `skip`），
 *      绝不用个位数样本去判产品。环境闸只管量尺（帧数 / 状态采样点数 / 采样间隔）；
 *      「点击生效：折面 closed → open」这类是**产品判据**，单独记，坏在机器性能之外。
 *
 * 阈值怎么来的见各条断言旁的注释。
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

/**
 * 关掉 Chromium 的后台节流（与 `_probe-kit.mjs` 的 `launchDesktop` 同一组）。
 *
 * 窗口被挡在后面时 Chromium 会把定时器压到 1Hz、并停掉 rAF：采样掉到个位数，
 * 「批次活跃期间」一帧都采不到，看起来像产品没补位置。连上 CDP 后再补一条
 * `Emulation.setFocusEmulationEnabled`（见下面），让页面当自己在前台。
 */
const ANTI_THROTTLE = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

/** 采样窗口最少要多少帧才值得判读。见判读前的环境闸。 */
const FRAME_FLOOR = 24
/** 16ms 状态采样最少要多少次。 */
const TICK_FLOOR = 10
/**
 * 采样节奏的上限（环境闸）。
 *
 * rAF 样本间隔 >100ms（<10fps）时，位置漂移的「相邻帧」判读就不可信。批次是否开跑
 * 不靠帧率判——那条由 `MutationObserver` 记的内联 `overflow-anchor` 起止时间戳证明，
 * 定时器/帧率再抖也读得到。实测把渲染进程降速 20 倍时样本间隔到 3.2s，这个闸会红在
 * 「环境」，而不是拿残样去判产品。
 */
const SAMPLE_GAP_MAX = 100
/**
 * 批次活跃窗口的下限（ms）。
 *
 * 默认批次 = `--dsc-dur-slow`(180ms) + 提交余量(60ms) = 240ms；`MutationObserver` 记到
 * 的起点→终点实测 225–259ms。要求 ≥120ms（窗口的一半）：容一次迟到的回调，又能把
 * 「只闪了一下」和「根本没开」分开。旧版按「采到 ≥4 帧 none」判，掉帧时这个数字会
 * 凭空变小；改为直接量窗口长度，结论不依赖采样节奏。
 */
const NONE_WINDOW_FLOOR = 120
/**
 * 补位量下限的比例。
 *
 * 实测：展开 / 收起把过程区从 0 拉到 331.2px，`scrollTop` 补了 334px（差 3px 是
 * 亚像素与 1px 取整）。要求补位量 ≥ 段高增量的 80%：既拦住「批次没开、根本没补」，
 * 也允许采样刚好落在过渡末帧之前。
 */
const COMPENSATION_RATIO = 0.8

/**
 * 负向自检（`PROBE_MUTATE`）认识的值。**只认这几个精确字符串**。
 *
 * 拼错（`noanchor`）或写成另一条探针的名字（`shove` / `no-scroll-write`）时以前是直接
 * `return`：变异没打上、日志没有、退出码 0，操作者会以为「判据改完仍能红」。现在有值但
 * 不认识就当场报错退出（列认识的值），别让一次拼写错误冒充一次负向自检。
 */
const MUTATIONS = ['no-anchor']
const requestedMutation = process.env.PROBE_MUTATE ?? ''
if (requestedMutation !== '' && !MUTATIONS.includes(requestedMutation)) {
  console.error(`  FAIL 环境：PROBE_MUTATE=${requestedMutation} 不认识（认识的值：${MUTATIONS.join('、')}；不设 = 不跑变异）`)
  process.exit(1)
}

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

// 与 _probe-kit 的 connectCdp 同一条：让页面当自己在前台（Rendering 不被降频）。
try { await send('Page.enable') } catch {}
try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }) } catch {}
await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(600)

/**
 * 诊断用：`PROBE_CPU_THROTTLE=20` 在**摆好位置之后**让渲染进程慢 20 倍，用来验证
 * 「环境：现场可判读」这条闸真的会红（而不是拿个位数样本去判产品）。
 * 放在摆位之后：摆位本身也要 React 提交，先降速就摆不出可判读的现场。
 * 正常跑不要设。
 */
const cpuThrottle = Number(process.env.PROBE_CPU_THROTTLE ?? '1')

// 「减少动态效果」开着时，折叠批次是同步开的又同步收的（fold-motion 的 reduced-motion 分支），
// 中间没有可观测的活跃窗口——这时判「批次活跃期间」没有意义。先当环境问题报出来。
const reducedMotion = await evaluate('return window.matchMedia("(prefers-reduced-motion: reduce)").matches')
if (reducedMotion === true) {
  console.log('  FAIL 环境：系统没有开启「减少动态效果」：prefers-reduced-motion: reduce 让批次同步开合，无法按时间判读；请在系统里关掉再跑')
  try { ws.close() } catch {}
  try { electron.kill() } catch {}
  process.exit(1)
}

/**
 * 负向自检：`PROBE_MUTATE=no-anchor` 时把 `.chat` 的内联 `overflowAnchor` 写入吞掉，
 * 模拟「`viewport.beginBatch` 里 `scroller.style.overflowAnchor = 'none'` 那行被删掉」。
 *
 * 批次本身照跑、位置照补，所以补位量与漂移仍然绿——只有「批次活跃期间内联值是 none」
 * 该红。这条用来证明改完的探针没有把产品判据改弱成必然通过。
 *
 * 打上变异之后**当场证明它真的生效**：按产品那一下写 `none`，读回来必须是空串（写入被吞）。
 * 不生效就没法红，看到的全绿是假绿（见文件顶部的值白名单）。
 *
 * @returns {{ requested: boolean, applied: boolean, observed: string | null, error?: string }}
 */
const mutateNoAnchor = async () => {
  if (process.env.PROBE_MUTATE !== 'no-anchor') return { requested: false, applied: false, observed: null }
  const result = await evaluate(`
    const chat = document.querySelector('.chat')
    if (chat === null) return { applied: false, reason: '没有 .chat' }
    Object.defineProperty(chat.style, 'overflowAnchor', {
      configurable: true,
      get() { return '' },
      set() {},
    })
    chat.style.overflowAnchor = 'none'
    const after = chat.style.overflowAnchor
    return { applied: after === '', after }
  `)
  console.log(`[mutate] PROBE_MUTATE=no-anchor：${result?.applied === true ? '已吞掉 .chat 的 overflowAnchor 写入（模拟产品回归）' : `没打上：${String(result?.reason ?? JSON.stringify(result))}`}`)
  return {
    requested: true,
    applied: result?.applied === true,
    observed: result?.after ?? null,
    ...(result?.reason === undefined ? {} : { error: String(result.reason) }),
  }
}


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
  //
  // 等排版真的落定再取：目标轮的答案行刚才被顶到可视区顶端，正常情况下第一条可见行就是它。
  // 负载 / 降速下 React 的提交会晚几百毫秒，不等就会取到相邻轮的行——那时后面量的是
  // 另一处的位置，漂移与补位量都失去意义（实测 20 倍降速时取到过锚点行不在目标轮里）。
  let anchor = null
  const anchorDeadline = performance.now() + 5000
  while (performance.now() < anchorDeadline) {
    const current = [...chat.querySelectorAll('.entry-row')]
    anchor = current.find((row) => visible(row) && row.closest('.turn-process') === null) ?? null
    if (anchor !== null && anchor.closest('.turn-seat') === target.seat) break
    await wait(50)
  }
  if (anchor === null) return { error: '没有可见的锚点行' }
  if (anchor.closest('.turn-seat') !== target.seat) {
    return {
      error: '锚点行不在被点的那一轮里（排版没落定）',
      anchorTop: Math.round(anchor.getBoundingClientRect().top - view.top),
    }
  }
  const spacer = chat.querySelector('[data-chat-turn-spacer]')
  const isAlone = anchor.closest('.turn-seat') === target.seat
  // 按「轮号 + 座位内行序号」记住锚点：React 重挂之后同一个逻辑行还是同一个序号，
  // 而元素引用会失效。点击前也会按轮号重新解析开关（见模块头「为什么不再等 900ms」）。
  const seatRows = [...target.seat.querySelectorAll('.entry-row')]
  const anchorIndex = seatRows.indexOf(anchor)

  window.__foldProbe = {
    chat, spacer,
    round: target.seat.getAttribute('data-round-seat'),
    anchorIndex,
    anchor,
    samples: [], ticks: [], sampling: false, baseline: 0,
    sawNone: false, noneFirst: null, noneLast: null, noneEnd: null, mutation: null,
    seatNow() {
      return this.chat.querySelector('.turn-seat[data-round-seat="' + this.round + '"]')
    },
    btnNow() {
      const seat = this.seatNow()
      return seat === null ? null : seat.querySelector('.turn-fold:not([disabled])')
    },
    anchorNow() {
      const seat = this.seatNow()
      if (seat === null) return null
      const list = [...seat.querySelectorAll('.entry-row')]
      return list[this.anchorIndex] ?? null
    },
    segmentNow() {
      const seat = this.seatNow()
      return seat === null ? null : seat.querySelector('.turn-process')
    },
    read() {
      const segment = this.segmentNow()
      const list = segment === null ? [] : [...segment.querySelectorAll('.entry-row')]
      return {
        fold: segment === null ? null : segment.getAttribute('data-fold'),
        segH: segment === null ? null : Number(segment.getBoundingClientRect().height.toFixed(1)),
        inline: this.chat.style.overflowAnchor,
        rowInline: list.filter((row) => row.style.height !== '').length,
        top: this.chat.scrollTop,
        sh: this.chat.scrollHeight,
        spacer: this.spacer === null ? -1 : this.spacer.offsetHeight,
      }
    },
  }
  return {
    rounds: seats.length,
    round: target.seat.getAttribute('data-round-seat'),
    anchorIndex,
    grown: Math.round(target.grown),
    scrollTop: Math.round(chat.scrollTop),
    floor: Math.round(target.floor),
    anchorIsTargetRound: isAlone,
    anchorTop: Math.round(anchor.getBoundingClientRect().top - view.top),
    anchorInFold: anchor.closest('.turn-process') !== null,
    rows: chat.querySelectorAll('.entry-row').length,
    canScrollUp: Math.round(chat.scrollTop),
    canScrollDown: Math.round(target.floor - chat.scrollTop),
  }
`)
console.log('place', JSON.stringify(placed))
if (placed?.error !== undefined) {
  console.log(`  FAIL 环境：摆不出可判读的现场：${String(placed.error)}`)
  try { ws.close() } catch {}
  try { electron.kill() } catch {}
  process.exit(1)
}
const mutation = await mutateNoAnchor()
if (Number.isFinite(cpuThrottle) && cpuThrottle > 1) {
  await send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle })
  console.log(`[probe] PROBE_CPU_THROTTLE=${String(cpuThrottle)}：渲染进程降速 ${String(cpuThrottle)} 倍（摆位之后才降，见注释）`)
}

/**
 * 开一段采样。
 *
 * 为什么在 rAF 里再挂一个 `setTimeout(0)` 才量：视口协调器的补位写在同一帧的
 * rAF / ResizeObserver 里，而探针自己的 rAF 回调排在它前面（先注册）。直接在 rAF 里读，
 * 读到的是「这一帧动画又长了一点、补位还没写」的那一瞬——量到的是补偿前的差值，
 * 不是屏幕上的位置。计时器任务跑在这一帧画完之后、下一帧开始之前，读到的是真正画出来的位置。
 *
 * 为什么另外还要一条 16ms 的状态采样：`samples` 只在 rAF 上采，掉帧时「补位量 / 段高增量」
 * 这些逐帧读数会变稀。`ticks` 只记内联值 / 段高 / 行内联高度，不判位置，用来证明
 * 「这一批的行确实被写过内联高度」；批次**起止窗口**不靠它——那是 `MutationObserver`
 * 记的 `overflow-anchor` 时间戳，定时器降频也读得到。
 */
const beginSample = () => evaluate(`
  const p = window.__foldProbe
  const chat = p.chat
  const anchor = p.anchorNow()
  if (anchor === null) {
    p.sampling = false
    return { error: '采样开始时锚点行不在 DOM 里（这一轮可能刚被重挂）' }
  }
  p.samples = []
  p.ticks = []
  p.sawNone = false
  p.noneFirst = null
  p.noneLast = null
  p.noneEnd = null
  p.noneComputed = true
  p.sampling = true
  p.baseline = anchor.getBoundingClientRect().top
  if (p.mutation !== null) { p.mutation.disconnect(); p.mutation = null }
  // 内联 style 的变更由微任务投递，不受 rAF / 定时器降频影响：批次起止时刻以它为准。
  // 这里同时记 computed 值——写入被吞掉的回归（见 PROBE_MUTATE）就靠这一对判据抓。
  p.mutation = new MutationObserver(() => {
    const value = chat.style.overflowAnchor
    if (value === 'none') {
      p.sawNone = true
      if (p.noneFirst === null) p.noneFirst = performance.now()
      p.noneLast = performance.now()
      if (getComputedStyle(chat).overflowAnchor !== 'none') p.noneComputed = false
    } else if (p.noneFirst !== null && p.noneEnd === null) {
      p.noneEnd = performance.now()
    }
  })
  p.mutation.observe(chat, { attributes: true, attributeFilter: ['style'] })
  const push = () => {
    if (!p.sampling) return
    let row = p.anchor
    if (row === null || !row.isConnected) row = p.anchorNow()
    if (row === null) return
    const segment = p.segmentNow()
    p.samples.push({
      t: performance.now(),
      top: row.getBoundingClientRect().top,
      h: row.getBoundingClientRect().height,
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
  const tickState = () => {
    if (!p.sampling) return
    const segment = p.segmentNow()
    const list = segment === null ? [] : [...segment.querySelectorAll('.entry-row')]
    p.ticks.push({
      t: performance.now(),
      inline: chat.style.overflowAnchor,
      computed: getComputedStyle(chat).overflowAnchor,
      top: chat.scrollTop,
      sh: chat.scrollHeight,
      fold: segment === null ? null : segment.getAttribute('data-fold'),
      segH: segment === null ? null : Number(segment.getBoundingClientRect().height.toFixed(1)),
      rowInline: list.filter((row) => row.style.height !== '').length,
      spacer: p.spacer === null ? -1 : p.spacer.offsetHeight,
    })
    setTimeout(tickState, 16)
  }
  // 收手时补最后一条：循环在 16ms 的状态采样上看到「批次已收工」，而最后一条
  // rAF 样本可能还停在上一帧（那时内联值还是 none）。不补这一条，末帧判据会误读。
  p.pushSample = push
  // 先当场记一条「点之前」的样子：补位量要拿它当起点（收起方向可能在第一帧里
  // 就把整片内容撤掉，等第一个帧后再记，起点已经是被补过的位置了）。
  push()
  tickState()
  requestAnimationFrame(tick)
  return { baseline: p.baseline }
`)

/**
 * 点击这一轮的整轮开关，然后**等条件**，不是等固定时长。
 *
 * 等的条件：
 *   · 先等「点下去有用」——折面翻面 / 段高变化 / 行上出现内联高度 / `scrollHeight` 变化；
 *   · 再等「批次开过又收工」——`sawNone` 为真且内联值不再是 `none`；
 *   · 最后等到采样攒够 `FRAME_FLOOR` 帧（末帧状态要在批次结束之后才读得到）。
 *
 * 状态变了却一直没看到批次时只再给 700ms：那已经够一次微任务开批 + 一帧，再等下去
 * 就不是环境慢，而是这一批根本没开——那是产品判据要红的事，不能在这里被等没。
 *
 * @param {'open' | 'closed'} expectedFold 点完之后这一轮应收到的折面
 */
const toggleAndWatch = (expectedFold) => evaluate(`
  const p = window.__foldProbe
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const btn = p.btnNow()
  if (btn === null) {
    return { clicked: false, reason: '点击前这一轮没有可点的整轮开关（已重挂或被禁用）', before: p.read() }
  }
  if (!btn.isConnected) {
    return { clicked: false, reason: '拿到的开关不在文档里（重挂后的旧节点）', before: p.read() }
  }
  const before = p.read()
  btn.click()
  const started = performance.now()
  let actuatedAt = null
  let after = before
  while (performance.now() - started < 4000) {
    await wait(16)
    after = p.read()
    if (actuatedAt === null
      && (after.fold !== before.fold
        || after.segH !== before.segH
        || after.rowInline > before.rowInline
        || after.sh !== before.sh)) {
      actuatedAt = performance.now()
    }
    // 批次收工：内联 overflow-anchor 已经进过 none，现在不是 none 了。
    if (p.sawNone && after.inline !== 'none') break
    // 状态变了、却一直没看到批次：再给 700ms（微任务开批 + 一帧），之后交给判据。
    if (actuatedAt !== null && performance.now() - actuatedAt > 700) break
  }
  const frameDeadline = performance.now() + 3000
  while (p.samples.length < ${String(FRAME_FLOOR)} && performance.now() < frameDeadline) await wait(32)
  if (typeof p.pushSample === 'function') p.pushSample()
  p.sampling = false
  if (p.mutation !== null) { p.mutation.disconnect(); p.mutation = null }
  return {
    clicked: true,
    before,
    after,
    actuated: actuatedAt !== null,
    actuatedInMs: actuatedAt === null ? null : Math.round(actuatedAt - started),
    sawNone: p.sawNone,
    noneFirst: p.noneFirst,
    noneLast: p.noneLast,
    noneEnd: p.noneEnd,
    noneComputed: p.noneComputed,
    expectedFold: ${JSON.stringify(expectedFold)},
    samples: p.samples,
    ticks: p.ticks,
    baseline: p.baseline,
    frames: p.samples.length,
    tickCount: p.ticks.length,
  }
`)

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

// 负向自检先自证：变异没打上就红不了，那时候看到的全绿是假绿（值拼错在文件顶部就退出了）。
if (mutation.requested) {
  check('变异：PROBE_MUTATE=no-anchor 真的生效（按产品那一下写入 overflow-anchor 后读回空串）',
    mutation.applied === true,
    mutation.error ?? `读回 ${JSON.stringify(mutation.observed)}`)
}

/**
 * 判读前的环境闸：只问「量尺准不准」——有效帧、16ms 状态采样点数、rAF 采样间隔。
 * 不满足就记一条「环境：现场可判读」失败，并告诉调用方跳过产品判据。
 * 返回 `{ ok, why }`；`why` 给 `skip` 用。
 *
 * 为什么「点下去有没有可见变化」「折面翻没翻」不在这里：那是产品判据（见
 * {@link checkActuation}）。塞进环境闸的话，产品真坏（按钮没接上、折面不翻）会被记成
 * 「环境：…」，后面 7 条产品判据全部 skip，排查方向被引去机器性能。
 */
const envReady = (label, run) => {
  const problems = []
  const maxGap = (list) => {
    let worst = 0
    for (let at = 1; at < list.length; at += 1) worst = Math.max(worst, list[at].t - list[at - 1].t)
    return worst
  }
  if ((run?.frames ?? 0) < FRAME_FLOOR) problems.push(`有效帧 ${String(run?.frames ?? 0)} 帧 < ${String(FRAME_FLOOR)}（页面被节流或掉帧）`)
  if ((run?.tickCount ?? 0) < TICK_FLOOR) problems.push(`状态采样 ${String(run?.tickCount ?? 0)} 次 < ${String(TICK_FLOOR)}`)
  if ((run?.samples?.length ?? 0) >= 2 && maxGap(run.samples) > SAMPLE_GAP_MAX) {
    problems.push(`rAF 采样最长间隔 ${String(Math.round(maxGap(run.samples)))}ms > ${String(SAMPLE_GAP_MAX)}ms（掉帧，位置判读不可信）`)
  }
  if (problems.length === 0) return { ok: true, why: '' }
  const why = problems.join('；')
  check(`环境：${label} 的现场可判读`, false, why)
  return { ok: false, why }
}

/**
 * 产品判据：这一下点击真的接上了——(a) 这一轮出现可见状态变化，(b) 折面翻到了期望的那一面。
 *
 * 这两条以前塞在 `envReady` 里，于是「按钮没接上 / 折面不翻」会被记成「环境」、把后面 7 条
 * 产品判据全 skip 掉。现在它们各自记账：环境再差也只红环境那一条，产品坏了就直接红在
 * 「点击生效」上。
 *
 * @param {string} label 场景名（展开 / 收起 / 贴底展开）
 * @param {any} run `toggleAndWatch` / 贴底那一段的返回值
 */
const checkActuation = (label, run) => {
  const clicked = run?.clicked === true
  check(`${label}：点击生效（这一轮出现可见状态变化）`,
    clicked && run?.actuated === true,
    `${clicked ? '' : `${String(run?.reason ?? '点击没有发生')}；`}actuated=${String(run?.actuated)}，点击前后折面 ${JSON.stringify(run?.before?.fold ?? null)} → ${JSON.stringify(run?.after?.fold ?? null)}`)
  check(`${label}：点击生效（折面 ${JSON.stringify(run?.before?.fold ?? null)} → ${JSON.stringify(run?.expectedFold ?? null)}）`,
    clicked && run?.after?.fold === run?.expectedFold,
    `期望 ${JSON.stringify(run?.expectedFold ?? null)}，实际 ${JSON.stringify(run?.after?.fold ?? null)}${clicked ? '' : `（${String(run?.reason ?? '点击没有发生')}）`}`)
}


/**
 * 一段采样的判读。
 *
 * `moved` 用 `samples`（rAF，已由环境闸保证间隔 ≤100ms）算；`maxDrift` 也只用 `samples`
 * （每帧画完之后才读），这样量到的才是屏幕上的位置。段高增量用 `ticks`（16ms 状态采样，
 * 比 rAF 密）；批次**起止窗口**由 `MutationObserver` 的时间戳单独算（`noneWindowMs`），
 * 不依赖帧率。
 */
const judge = (label, run) => {
  const samples = run.samples ?? []
  const ticks = run.ticks ?? []
  const baseline = run.baseline ?? 0
  const drifts = samples.map((s) => Math.abs(s.top - baseline))
  const maxDrift = drifts.length === 0 ? 0 : Math.max(...drifts)
  const worst = samples[drifts.indexOf(maxDrift)]
  const noneTicks = ticks.filter((s) => s.inline === 'none')
  const noneSpanMs = noneTicks.length === 0
    ? 0
    : Math.round(noneTicks[noneTicks.length - 1].t - noneTicks[0].t)
  // 批次窗口用 MutationObserver 的时间戳算，不用「采到几帧」：帧率一掉，「帧数」就不代表窗口。
  const noneWindowMs = run.noneFirst === null || run.noneFirst === undefined
    ? 0
    : Math.round((run.noneEnd ?? run.noneLast ?? run.noneFirst) - run.noneFirst)
  const computedNone = run.sawNone === true && run.noneComputed === true
  const segHeights = ticks.map((s) => s.segH).filter((v) => typeof v === 'number')
  const segFrom = segHeights.length === 0 ? null : Math.min(...segHeights)
  const segTo = segHeights.length === 0 ? null : Math.max(...segHeights)
  const segDelta = segFrom === null || segTo === null ? 0 : segTo - segFrom
  const moved = samples.length < 2 ? 0 : Math.abs(samples[samples.length - 1].scrollTop - samples[0].scrollTop)
  const last = samples[samples.length - 1] ?? ticks[ticks.length - 1] ?? {}
  const first = samples[0] ?? ticks[0] ?? {}
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
    ticks: ticks.length,
    baseline: Math.round(baseline),
    maxDrift: Number(maxDrift.toFixed(2)),
    worstAt: worst === undefined ? null : { t: Math.round(worst.t), top: Number(worst.top.toFixed(2)), scrollTop: Math.round(worst.scrollTop) },
    noneTicks: noneTicks.length,
    noneSpanMs,
    noneWindowMs,
    sawNone: run.sawNone === true,
    computedNone,
    scrollMoved: Math.round(moved),
    segFrom,
    segTo,
    segDelta: Math.round(segDelta),
    foldAt: [...new Set(ticks.map((s) => s.fold))],
    endInline: last.inline ?? null,
    endSpacer: last.spacer ?? null,
    endSpacerInline: last.spacerInline ?? null,
    endTop: last.top === undefined ? null : Number(last.top.toFixed(2)),
    actuatedInMs: run.actuatedInMs ?? null,
  }))
  // 只在没达标时把逐帧轨迹摊开：通过的时候它是噪音，失败的时候它是唯一的证据。
  if (maxDrift > 1) console.log(`${label} trace`, JSON.stringify(trace))
  return { maxDrift, noneTicks: noneTicks.length, noneSpanMs, noneWindowMs, last, first, moved, computedNone, segDelta, samples, ticks }
}

/** 一条「补位量」判据：要求补的像素 ≥ 段高增量 × 0.8。 */
const compensationOk = (verdict, floorPx) => verdict.segDelta > 0
  && verdict.moved >= Math.max(floorPx, Math.round(verdict.segDelta * COMPENSATION_RATIO))

// ── 方向一：展开（这几轮默认收起）─────────────────────────────────────────────
const expandStart = await beginSample()
if (expandStart?.error !== undefined) {
  console.log(`  FAIL 环境：展开场景采样起不来：${String(expandStart.error)}`)
  try { ws.close() } catch {}
  try { electron.kill() } catch {}
  process.exit(1)
}
const expandRun = await toggleAndWatch('open')
const expandEnv = envReady('展开', expandRun)
checkActuation('展开', expandRun)
const expand = judge('[expand]', expandRun)
if (expandEnv.ok) {
  check('展开：第一条可见行的屏幕 top 变化 ≤1px', expand.maxDrift <= 1, `实测 ${expand.maxDrift.toFixed(2)}px`)
  // 补位量 = 段高增量 × 0.8（实测 334 / 331，见文件头 COMPENSATION_RATIO 注释）；40px 是保底。
  check('展开：scrollTop 真的补过（不是「本来就不动」）', compensationOk(expand, 40),
    `实测补了 ${Math.round(expand.moved)}px、段高增量 ${Math.round(expand.segDelta)}px`)
  // 批次窗口由 MutationObserver 时间戳量出（实测 225–259ms，门槛 120ms，见 NONE_WINDOW_FLOOR）。
  check('展开：批次活跃期间 .chat 的内联 overflow-anchor 是 none',
    expandRun.sawNone === true && expand.noneWindowMs >= NONE_WINDOW_FLOOR,
    `批次窗口 ${String(expand.noneWindowMs)}ms（noneTicks ${String(expand.noneTicks)} 次，诊断用）`)
  check('展开：批次期间的计算值也是 none', expand.computedNone === true,
    `sawNone=${String(expandRun.sawNone)}, noneComputed=${String(expandRun.noneComputed)}`)
  // 下面三条在「点击没生效、什么都没发生」时**天然成立**：内联值本来就是空串、占位本来就
  // 是 0、锚点行本来就没动。不先要求这一下真的接上了，它们就是假绿（审查 2026-11-12 指出）。
  // 所以先看 `actuated`：没接上就记 skip，别让「没动」冒充「还原对了」。
  if (expandRun?.actuated === true) {
    check('展开：批次结束后内联 overflow-anchor 还原成空串', expand.last.inline === '', `实际 ${JSON.stringify(expand.last.inline)}`)
    check('展开：末帧占位高度回到 0', expand.last.spacer === 0 && expand.last.spacerInline === '',
      `offsetHeight=${String(expand.last.spacer)} inline=${JSON.stringify(expand.last.spacerInline)}`)
    check('展开：末帧锚点行仍在原位', Math.abs((expand.last.top ?? 0) - expandRun.baseline) <= 1)
  } else {
    for (const name of [
      '展开：批次结束后内联 overflow-anchor 还原成空串',
      '展开：末帧占位高度回到 0',
      '展开：末帧锚点行仍在原位',
    ]) skip(name, '点击没生效')
  }
} else {
  for (const name of [
    '展开：第一条可见行的屏幕 top 变化 ≤1px',
    '展开：scrollTop 真的补过（不是「本来就不动」）',
    '展开：批次活跃期间 .chat 的内联 overflow-anchor 是 none',
    '展开：批次期间的计算值也是 none',
    '展开：批次结束后内联 overflow-anchor 还原成空串',
    '展开：末帧占位高度回到 0',
    '展开：末帧锚点行仍在原位',
  ]) skip(name, expandEnv.why)
}

// 展开之后锚点行不该换人：收起方向就在同一个起点上比。
const rearm = await evaluate(`
  const p = window.__foldProbe
  const row = p.anchorNow()
  if (row === null) return { missing: true }
  const rect = row.getBoundingClientRect()
  const chatRect = p.chat.getBoundingClientRect()
  const seat = p.seatNow()
  return {
    connected: row.isConnected,
    top: Number(rect.top.toFixed(2)),
    relative: Number((rect.top - chatRect.top).toFixed(2)),
    height: Number(rect.height.toFixed(2)),
    same: seat !== null && row.closest('.turn-seat') === seat,
  }
`)
console.log('rearm', JSON.stringify(rearm))
if (expandEnv.ok) {
  check('展开之后锚点行没换人（收起方向在同一个起点上比）',
    rearm.connected === true && rearm.same === true && Math.abs(rearm.relative - 2) <= 1,
    JSON.stringify(rearm))
} else {
  skip('展开之后锚点行没换人（收起方向在同一个起点上比）', expandEnv.why)
}

// ── 方向二：收起 ─────────────────────────────────────────────────────────────
const collapseStart = await beginSample()
if (collapseStart?.error !== undefined) {
  console.log(`  FAIL 环境：收起场景采样起不来：${String(collapseStart.error)}`)
  try { ws.close() } catch {}
  try { electron.kill() } catch {}
  process.exit(1)
}
const collapseRun = await toggleAndWatch('closed')
const collapseEnv = envReady('收起', collapseRun)
checkActuation('收起', collapseRun)
const collapse = judge('[collapse]', collapseRun)
if (collapseEnv.ok) {
  check('收起：第一条可见行的屏幕 top 变化 ≤1px', collapse.maxDrift <= 1, `实测 ${collapse.maxDrift.toFixed(2)}px`)
  check('收起：scrollTop 真的补过', compensationOk(collapse, 40),
    `实测补了 ${Math.round(collapse.moved)}px、段高增量 ${Math.round(collapse.segDelta)}px`)
  check('收起：批次活跃期间 .chat 的内联 overflow-anchor 是 none',
    collapseRun.sawNone === true && collapse.noneWindowMs >= NONE_WINDOW_FLOOR,
    `批次窗口 ${String(collapse.noneWindowMs)}ms（noneTicks ${String(collapse.noneTicks)} 次，诊断用）`)
  check('收起：批次期间的计算值也是 none', collapse.computedNone === true,
    `sawNone=${String(collapseRun.sawNone)}, noneComputed=${String(collapseRun.noneComputed)}`)
  // 同展开那三条：点击没生效时它们天然成立，先要求这一下真的接上了（`actuated`），
  // 不成立就 skip，理由写「点击没生效」。
  if (collapseRun?.actuated === true) {
    check('收起：批次结束后内联 overflow-anchor 还原成空串', collapse.last.inline === '', `实际 ${JSON.stringify(collapse.last.inline)}`)
    check('收起：末帧占位高度回到 0', collapse.last.spacer === 0 && collapse.last.spacerInline === '',
      `offsetHeight=${String(collapse.last.spacer)} inline=${JSON.stringify(collapse.last.spacerInline)}`)
    check('收起：末帧锚点行仍在原位', Math.abs((collapse.last.top ?? 0) - collapseRun.baseline) <= 1)
  } else {
    for (const name of [
      '收起：批次结束后内联 overflow-anchor 还原成空串',
      '收起：末帧占位高度回到 0',
      '收起：末帧锚点行仍在原位',
    ]) skip(name, '点击没生效')
  }
} else {
  for (const name of [
    '收起：第一条可见行的屏幕 top 变化 ≤1px',
    '收起：scrollTop 真的补过',
    '收起：批次活跃期间 .chat 的内联 overflow-anchor 是 none',
    '收起：批次期间的计算值也是 none',
    '收起：批次结束后内联 overflow-anchor 还原成空串',
    '收起：末帧占位高度回到 0',
    '收起：末帧锚点行仍在原位',
  ]) skip(name, collapseEnv.why)
}

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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const floorNow = () => chat.scrollHeight - (p.spacer === null ? 0 : p.spacer.offsetHeight) - chat.clientHeight
  const pill = document.querySelector('.chat-to-bottom')
  if (pill !== null) pill.click()
  // 等真的落到底（胶囊点击 / 跟随要跑一帧），不再盲等 260ms。
  const pinDeadline = performance.now() + 3000
  while (performance.now() < pinDeadline) {
    if (Math.abs(chat.scrollTop - floorNow()) <= 2) break
    await wait(32)
  }
  chat.scrollTop = chat.scrollHeight
  const settleDeadline = performance.now() + 2000
  while (performance.now() < settleDeadline) {
    if (Math.abs(chat.scrollTop - floorNow()) <= 2) break
    await wait(32)
  }
  // 换一个还没动过的整轮（最后一轮）：它的折叠区在底部上方，展开会改 floor。
  const seats = [...chat.querySelectorAll('.turn-seat[data-round-seat]')]
  let round = null
  for (let index = seats.length - 1; index >= 0; index -= 1) {
    const attr = seats[index].getAttribute('data-round-seat')
    if (attr === p.round) continue
    if (seats[index].querySelector('.turn-fold:not([disabled])') === null) continue
    round = attr
    break
  }
  if (round === null) return { error: '没有第二个可折的整轮' }
  p.tail = { round, samples: [], ticks: [], sampling: false }
  const segment = seats.find((seat) => seat.getAttribute('data-round-seat') === round).querySelector('.turn-process')
  return {
    pill: pill !== null,
    top: Math.round(chat.scrollTop),
    floor: Math.round(floorNow()),
    round,
    collapsed: segment === null || segment.getAttribute('data-fold') === 'closed',
  }
`)
console.log('toBottom', JSON.stringify(toBottom))
if (toBottom?.error === undefined) {
  const tailStarted = await evaluate(`
    const p = window.__foldProbe
    const t = p.tail
    const chat = p.chat
    const seatNow = () => chat.querySelector('.turn-seat[data-round-seat="' + t.round + '"]')
    const segmentNow = () => {
      const seat = seatNow()
      return seat === null ? null : seat.querySelector('.turn-process')
    }
    t.seatNow = seatNow
    t.segmentNow = segmentNow
    t.btnNow = () => {
      const seat = seatNow()
      return seat === null ? null : seat.querySelector('.turn-fold:not([disabled])')
    }
    t.samples = []
    t.ticks = []
    t.sawNone = false
    t.noneFirst = null
    t.noneLast = null
    t.noneEnd = null
    t.noneComputed = true
    t.sampling = true
    const spacer = p.spacer
    if (t.mutation !== undefined && t.mutation !== null) t.mutation.disconnect()
    t.mutation = new MutationObserver(() => {
      const value = chat.style.overflowAnchor
      if (value === 'none') {
        t.sawNone = true
        if (t.noneFirst === null) t.noneFirst = performance.now()
        t.noneLast = performance.now()
        if (getComputedStyle(chat).overflowAnchor !== 'none') t.noneComputed = false
      } else if (t.noneFirst !== null && t.noneEnd === null) {
        t.noneEnd = performance.now()
      }
    })
    t.mutation.observe(chat, { attributes: true, attributeFilter: ['style'] })
    const push = () => {
      if (!t.sampling) return
      const segment = segmentNow()
      t.samples.push({
        t: performance.now(),
        top: chat.scrollTop,
        floor: chat.scrollHeight - (spacer === null ? 0 : spacer.offsetHeight) - chat.clientHeight,
        sh: chat.scrollHeight,
        inline: chat.style.overflowAnchor,
        spacer: spacer === null ? -1 : spacer.offsetHeight,
        fold: segment === null ? null : segment.getAttribute('data-fold'),
        segH: segment === null ? null : Number(segment.getBoundingClientRect().height.toFixed(1)),
      })
    }
    const tick = () => {
      if (!t.sampling) return
      requestAnimationFrame(tick)
      setTimeout(push, 0)
    }
    const tickState = () => {
      if (!t.sampling) return
      const segment = segmentNow()
      t.ticks.push({
        t: performance.now(),
        top: chat.scrollTop,
        floor: chat.scrollHeight - (spacer === null ? 0 : spacer.offsetHeight) - chat.clientHeight,
        inline: chat.style.overflowAnchor,
        fold: segment === null ? null : segment.getAttribute('data-fold'),
        segH: segment === null ? null : Number(segment.getBoundingClientRect().height.toFixed(1)),
      })
      setTimeout(tickState, 16)
    }
    push()
    t.pushSample = push
    tickState()
    requestAnimationFrame(tick)
    return { ok: true }
  `)
  if (tailStarted?.error !== undefined) {
    check('环境：贴底场景能开始采样', false, String(tailStarted.error))
  }
  const tailRun = tailStarted?.error !== undefined ? null : await evaluate(`
    const p = window.__foldProbe
    const t = p.tail
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const btn = t.btnNow()
    const before = {
      fold: (() => { const s = t.segmentNow(); return s === null ? null : s.getAttribute('data-fold') })(),
      segH: (() => { const s = t.segmentNow(); return s === null ? null : Number(s.getBoundingClientRect().height.toFixed(1)) })(),
      inline: p.chat.style.overflowAnchor,
      top: p.chat.scrollTop,
      sh: p.chat.scrollHeight,
    }
    if (btn === null) {
      t.sampling = false
      if (t.mutation !== null && t.mutation !== undefined) t.mutation.disconnect()
      return { clicked: false, reason: '贴底这一轮没有可点的整轮开关', before }
    }
    btn.click()
    const started = performance.now()
    let actuatedAt = null
    let after = before
    while (performance.now() - started < 4000) {
      await wait(16)
      const segment = t.segmentNow()
      after = {
        fold: segment === null ? null : segment.getAttribute('data-fold'),
        segH: segment === null ? null : Number(segment.getBoundingClientRect().height.toFixed(1)),
        inline: p.chat.style.overflowAnchor,
        top: p.chat.scrollTop,
        sh: p.chat.scrollHeight,
      }
      if (actuatedAt === null
        && (after.fold !== before.fold || after.segH !== before.segH || after.sh !== before.sh)) {
        actuatedAt = performance.now()
      }
      if (t.sawNone && after.inline !== 'none') break
      if (actuatedAt !== null && performance.now() - actuatedAt > 700) break
    }
    const frameDeadline = performance.now() + 3000
    while (t.samples.length < ${String(FRAME_FLOOR)} && performance.now() < frameDeadline) await wait(32)
    if (typeof t.pushSample === 'function') t.pushSample()
    t.sampling = false
    if (t.mutation !== null && t.mutation !== undefined) t.mutation.disconnect()
    return {
      clicked: true,
      before,
      after,
      actuated: actuatedAt !== null,
      actuatedInMs: actuatedAt === null ? null : Math.round(actuatedAt - started),
      sawNone: t.sawNone,
      noneFirst: t.noneFirst,
      noneLast: t.noneLast,
      noneEnd: t.noneEnd,
      noneComputed: t.noneComputed,
      samples: t.samples,
      ticks: t.ticks,
      tickCount: t.ticks.length,
      frames: t.samples.length,
      expectedFold: 'open',
    }
  `)
  const tailEnv = tailRun === null
    ? { ok: false, why: '贴底场景的采样没起来' }
    : envReady('贴底展开', tailRun)
  if (tailRun !== null) checkActuation('贴底展开', tailRun)
  const tailSamples = tailRun?.samples ?? []
  const tailTicks = tailRun?.ticks ?? []
  const slack = tailSamples.map((s) => Math.abs(s.top - s.floor))
  const worstSlack = slack.length === 0 ? 0 : Math.max(...slack)
  const noneTicks = tailTicks.filter((s) => s.inline === 'none')
  const noneSpanMs = noneTicks.length === 0 ? 0 : Math.round(noneTicks[noneTicks.length - 1].t - noneTicks[0].t)
  const noneWindowMs = tailRun?.noneFirst === null || tailRun?.noneFirst === undefined
    ? 0
    : Math.round((tailRun.noneEnd ?? tailRun.noneLast ?? tailRun.noneFirst) - tailRun.noneFirst)
  const floorValues = tailSamples.map((s) => s.floor)
  const floorDelta = floorValues.length === 0 ? 0 : Math.max(...floorValues) - Math.min(...floorValues)
  const moved = tailSamples.length < 2
    ? 0
    : Math.abs(tailSamples[tailSamples.length - 1].top - tailSamples[0].top)
  const last = tailSamples[tailSamples.length - 1] ?? tailTicks[tailTicks.length - 1] ?? {}
  console.log('[tail]', JSON.stringify({
    frames: tailSamples.length,
    ticks: tailTicks.length,
    worstSlack: Number(worstSlack.toFixed(2)),
    noneTicks: noneTicks.length,
    noneSpanMs,
    noneWindowMs,
    sawNone: tailRun?.sawNone === true,
    moved: Math.round(moved),
    floorDelta: Math.round(floorDelta),
    actuatedInMs: tailRun?.actuatedInMs ?? null,
    endTop: Math.round(last.top ?? 0),
    endFloor: Math.round(last.floor ?? 0),
    endSpacer: last.spacer ?? null,
  }))
  if (tailEnv.ok) {
    check('贴底：批次里每次都停在 floor（离底 ≤2px）', worstSlack <= 2, `最大差 ${worstSlack.toFixed(2)}px`)
    // 补位量同样按「floor 增量 × 0.8」卡：最后一轮的折叠区只有组头（实测 floor 长 31–65px），
    // 20px 是保底。旧版写死 20，把「补位量只有一半」也放过；这里要求跟实际内容增量对得上。
    check('贴底：批次里 floor 真的变了（不是「本来就在底」）',
      floorDelta > 0 && moved >= Math.max(20, Math.round(floorDelta * COMPENSATION_RATIO)),
      `实测补了 ${Math.round(moved)}px、floor 增量 ${Math.round(floorDelta)}px`)
    check('贴底：批次活跃期间内联 overflow-anchor 也是 none',
      tailRun?.sawNone === true && noneWindowMs >= NONE_WINDOW_FLOOR,
      `批次窗口 ${String(noneWindowMs)}ms（noneTicks ${String(noneTicks.length)} 次，诊断用）`)
    check('贴底：末帧在 floor 上', Math.abs((last.top ?? 0) - (last.floor ?? 0)) <= 2)
  } else {
    for (const name of [
      '贴底：批次里每次都停在 floor（离底 ≤2px）',
      '贴底：批次里 floor 真的变了（不是「本来就在底」）',
      '贴底：批次活跃期间内联 overflow-anchor 也是 none',
      '贴底：末帧在 floor 上',
    ]) skip(name, tailEnv.why)
  }
} else {
  // 贴底场景摆不出来（没有第二个可折的整轮）：以前这里没有 else，后面 4 条贴底判据一条都
  // 不记，断言总数变少而失败数是 0，脚本照常 exit 0。现在补一条明确失败，与「采样起不来」
  // 那两处同一写法。
  check('环境：贴底场景能摆出来（有第二个可折的整轮）', false, String(toBottom?.error))
  for (const name of [
    '贴底：批次里每次都停在 floor（离底 ≤2px）',
    '贴底：批次里 floor 真的变了（不是「本来就在底」）',
    '贴底：批次活跃期间内联 overflow-anchor 也是 none',
    '贴底：末帧在 floor 上',
  ]) skip(name, String(toBottom?.error))
}

// ── 口径合并：「到底」只有 floor() 一个定义（2026-11-12）────────────────────────
//
// 刻度条以前自己算 `scrollHeight − clientHeight − scrollTop`（没减底部占位）。占位恒 0 时
// 它与 `viewport.floor()` 逐像素相同，所以两套口径一直没露馅。这条断言把占位临时撑到
// 2000px，站到一个**两个算式给出不同答案**的位置上，再读刻度条的高亮：
//   · 旧算式：`scrollHeight − clientHeight − scrollTop` = 2000 > 32 → 判「不在底」，
//     于是走命中测试，给的是更早的那一轮；
//   · 视口的 floor：`scrollHeight − 占位 − clientHeight − scrollTop` = 0 → 判「在底」，
//     给最后一轮。
// 高亮落在最后一轮 = 刻度条真的改用 floor 了；两套口径若还各自为政，这里会亮在更早的轮上。
const SPACER_PROBE_PX = 2000
/** 刻度条的贴底阈值（`jump-rail.tsx` 的 AT_BOTTOM_EPS）。探针复算旧算法时要用同一个数。 */
const RAIL_AT_BOTTOM_EPS = 32
const spacerProbe = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const chat = document.querySelector('.chat')
  if (chat === null) return { error: '没有 .chat' }
  const spacer = chat.querySelector('[data-chat-turn-spacer]')
  if (spacer === null) return { error: '没有 [data-chat-turn-spacer]（这条断言要临时把它撑高）' }
  const floorNow = () => chat.scrollHeight - (spacer.offsetHeight || 0) - chat.clientHeight
  // 先回到跟随态并落到底：位置要是当前已经在 floor，写同一个值不会发 scroll 事件。
  const pill = document.querySelector('.chat-to-bottom')
  if (pill !== null) pill.click()
  const pinDeadline = performance.now() + 3000
  while (performance.now() < pinDeadline) {
    if (Math.abs(chat.scrollTop - floorNow()) <= 2) break
    await wait(32)
  }
  // 把最后一轮收起来：它的盒子变矮之后，可视区顶端才落在更早的轮上——这样「旧算式在这个
  // 位置会给哪一轮」与「最后一轮」真的分得开，不会出现命中测试也蒙对最后一轮。
  const seats = [...chat.querySelectorAll('.turn-seat[data-round-seat]')]
  const lastSeat = seats.length === 0 ? null : seats[seats.length - 1]
  const lastRound = lastSeat === null ? -1 : Number(lastSeat.getAttribute('data-round-seat'))
  const foldBtn = lastSeat === null ? null : lastSeat.querySelector('.turn-fold:not([disabled])')
  const segment = lastSeat === null ? null : lastSeat.querySelector('.turn-process')
  let collapsed = segment === null ? false : segment.getAttribute('data-fold') === 'closed'
  if (lastSeat !== null && foldBtn !== null && segment !== null && !collapsed) {
    foldBtn.click()
    const foldDeadline = performance.now() + 3000
    while (performance.now() < foldDeadline) {
      await wait(32)
      const seat = chat.querySelector('.turn-seat[data-round-seat="' + String(lastRound) + '"]')
      const seg = seat === null ? null : seat.querySelector('.turn-process')
      if (seg === null || seg.getAttribute('data-fold') === 'closed') { collapsed = true; break }
    }
  }
  // 批次收工才会把占位清零（closeBatch 里 setSpacer(0)）：等内联 overflow-anchor 回到空串
  // 再去撑占位，否则我们写的高度会被它当场清掉。
  const batchDeadline = performance.now() + 2000
  while (performance.now() < batchDeadline) {
    if (chat.style.overflowAnchor === '') break
    await wait(32)
  }
  // 收起改了 floor，跟随态会重新钉底：等它落定，免得读到过渡中间的位置。
  const settleDeadline = performance.now() + 3000
  while (performance.now() < settleDeadline) {
    if (Math.abs(chat.scrollTop - floorNow()) <= 1) break
    await wait(32)
  }
  // 撑高占位只让 scrollHeight 变大，floor 不变、scrollTop 也不动（内容长在下方）。
  spacer.style.height = '${String(SPACER_PROBE_PX)}px'
  await wait(80)
  // 位置没变就不会有 scroll 事件，刻度条不会重测：补一条合成事件（它就是靠 scroll 重测的）。
  chat.dispatchEvent(new Event('scroll'))
  await wait(200)

  const floor = floorNow()
  const top = chat.scrollTop
  const spacerH = spacer.offsetHeight
  const oldSlack = chat.scrollHeight - chat.clientHeight - top
  const box = chat.getBoundingClientRect()
  // 旧算法（改之前的 measureCurrent）原样复算一遍：它用来证明两套口径真的给出了不同答案。
  const rows = []
  for (const row of chat.querySelectorAll('[data-round]')) {
    const value = Number(row.getAttribute('data-round'))
    if (!Number.isInteger(value) || value < 0) continue
    if (row.getClientRects().length === 0) continue
    rows.push({ round: value, top: row.getBoundingClientRect().top - box.top + top })
  }
  const seen = new Set()
  const anchors = []
  for (const row of rows) {
    if (seen.has(row.round)) continue
    seen.add(row.round)
    anchors.push(row)
  }
  const hit = document.elementFromPoint(box.left + chat.clientWidth / 2, box.top + 8)
  let hitRound = null
  if (hit !== null && chat.contains(hit)) {
    const row = hit.closest('[data-round]')
    const value = row === null ? Number.NaN : Number(row.getAttribute('data-round'))
    if (Number.isInteger(value) && value >= 0) hitRound = value
  }
  const probeTop = top + 8
  const oldMaxScroll = chat.scrollHeight - chat.clientHeight
  const oldAtBottom = oldMaxScroll > 0 && oldMaxScroll - top <= ${String(RAIL_AT_BOTTOM_EPS)}
  let oldAnswer
  if (oldAtBottom) oldAnswer = lastRound
  else if (hitRound !== null) oldAnswer = hitRound
  else if (anchors.length === 0) oldAnswer = -1
  else {
    let current = -1
    for (const anchor of anchors) {
      if (anchor.top <= probeTop) current = anchor.round
      else break
    }
    oldAnswer = current === -1 ? anchors[0].round : current
  }
  const tick = document.querySelector('.jump-tick[aria-current="true"]')
  return {
    lastRound,
    collapsed,
    spacerH,
    spacerInline: spacer.style.height,
    floor,
    top,
    gap: floor - top,
    oldSlack,
    oldAtBottom,
    oldAnswer,
    hitRound,
    anchors: anchors.length,
    railActive: tick === null ? null : Number(tick.getAttribute('data-turn')),
    tickCount: document.querySelectorAll('.jump-tick').length,
  }
`)
console.log('[spacer]', JSON.stringify(spacerProbe))
const restoreSpacer = async () => {
  await evaluate(`
    const chat = document.querySelector('.chat')
    const spacer = chat === null ? null : chat.querySelector('[data-chat-turn-spacer]')
    if (spacer !== null) spacer.style.height = ''
    if (chat !== null) chat.dispatchEvent(new Event('scroll'))
    await new Promise((r) => setTimeout(r, 200))
  `)
}
if (spacerProbe?.error !== undefined) {
  check('环境：占位能临时撑高（这条「两套口径合并」断言的前提）', false, String(spacerProbe.error))
  await restoreSpacer()
} else if ((spacerProbe.tickCount ?? 0) < 2 || spacerProbe.lastRound < 0) {
  check('环境：刻度条已画出（≥2 枚刻度、能读出最后一轮）', false,
    `刻度 ${String(spacerProbe.tickCount)} 枚、lastRound=${String(spacerProbe.lastRound)}`)
  await restoreSpacer()
} else {
  // 现场可分辨闸：占位必须真的比阈值高，且旧算式在同一位置给出的**不是**最后一轮。
  // 不满足就说明这个现场证明不了「两套口径已经分开」，宁可红在现场上，也不要一条假绿。
  const distinguishable = spacerProbe.spacerH > RAIL_AT_BOTTOM_EPS
    && spacerProbe.oldAtBottom === false
    && spacerProbe.oldAnswer !== spacerProbe.lastRound
  check('现场：占位非 0 时旧算式与最后一轮给出不同答案（否则这条断言证明不了口径合并）',
    distinguishable,
    JSON.stringify({
      spacerH: spacerProbe.spacerH,
      oldSlack: spacerProbe.oldSlack,
      oldAtBottom: spacerProbe.oldAtBottom,
      oldAnswer: spacerProbe.oldAnswer,
      hitRound: spacerProbe.hitRound,
      lastRound: spacerProbe.lastRound,
    }))
  if (distinguishable) {
    // 核心断言：停在 floor 的那一帧，刻度条判「在底」（高亮最后一轮），并且它用的 floor 与
    // 视口的 floor 是同一个数——离底 ≤1px。旧算式在同一位置会说「不在底」（差 2000px）。
    check('占位非 0 时刻度条的「到底」与 viewport.floor() 同一口径（离底 ≤1px、高亮最后一轮）',
      Math.abs(spacerProbe.gap) <= 1 && spacerProbe.railActive === spacerProbe.lastRound,
      JSON.stringify({
        gap: spacerProbe.gap,
        floor: spacerProbe.floor,
        scrollTop: spacerProbe.top,
        railActive: spacerProbe.railActive,
        lastRound: spacerProbe.lastRound,
      }))
    check('刻度条不再沿用旧算式（旧算式在这个位置会给更早的轮）',
      spacerProbe.railActive !== spacerProbe.oldAnswer,
      `旧 ${String(spacerProbe.oldAnswer)} / 实际 ${String(spacerProbe.railActive)}`)
  } else {
    skip('占位非 0 时刻度条的「到底」与 viewport.floor() 同一口径（离底 ≤1px、高亮最后一轮）',
      '现场分不开两套口径')
    skip('刻度条不再沿用旧算式（旧算式在这个位置会给更早的轮）', '现场分不开两套口径')
  }
  await restoreSpacer()
  // 占位收回 0 之后必须还能正确判底（别把现场改坏）：再读一次高亮。
  const afterRestore = await evaluate(`
    const chat = document.querySelector('.chat')
    const spacer = chat === null ? null : chat.querySelector('[data-chat-turn-spacer]')
    const tick = document.querySelector('.jump-tick[aria-current="true"]')
    return {
      spacerInline: spacer === null ? null : spacer.style.height,
      spacerH: spacer === null ? -1 : spacer.offsetHeight,
      railActive: tick === null ? null : Number(tick.getAttribute('data-turn')),
    }
  `)
  console.log('[spacer-restored]', JSON.stringify(afterRestore))
  check('占位收回到 0 之后刻度条仍高亮最后一轮（现场没被改坏）',
    afterRestore?.spacerH === 0 && afterRestore?.railActive === spacerProbe.lastRound,
    JSON.stringify(afterRestore))
}

// ── 跳轮也走视口：`scrollIntoView` → 「算偏移 → scrollToOffset」（2026-11-12）────────
//
// 改之前刻度条点一下是 `node.scrollIntoView({ behavior: 'smooth', block: 'start' })`：
// 它会把祖先一起带动、也不经过视口的写入通道（跟随策略认不出这是我们自己滚的）。
// 现在是 `offsetOf(行) → scrollToOffset(偏移, 'smooth')`。这一条按真实路径走：先往上读
// 一段（跟随松手），再点第二轮刻度——落点必须等于「该轮首行在内容坐标里的偏移」（±1px）、
// 刻度条必须跟着亮到第二轮，而且不能被落定逻辑拽回底部。
const jumpProbe = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const chat = document.querySelector('.chat')
  const ticks = [...document.querySelectorAll('.jump-tick')]
  if (chat === null) return { error: '没有 .chat' }
  if (ticks.length < 3) return { error: '刻度不足 3 枚（没法从底上跳到更早的轮）' }
  const seat = [...chat.querySelectorAll('.turn-seat[data-round-seat]')][1] ?? null
  if (seat === null) return { error: '没有第二轮座位' }
  const targetRound = Number(seat.getAttribute('data-round-seat'))
  const tick = ticks.find((node) => Number(node.getAttribute('data-turn')) === targetRound) ?? null
  if (tick === null) return { error: '找不到第 ' + String(targetRound) + ' 轮的刻度' }
  const row = seat.querySelector('[data-round]') ?? seat
  const spacer = chat.querySelector('[data-chat-turn-spacer]')
  const floorNow = () => chat.scrollHeight - (spacer === null ? 0 : spacer.offsetHeight) - chat.clientHeight
  // 先确保在底部（跟随态），这样"跳上去"才有方向可验。
  const pill = document.querySelector('.chat-to-bottom')
  if (pill !== null) pill.click()
  const pinDeadline = performance.now() + 3000
  while (performance.now() < pinDeadline) {
    if (Math.abs(chat.scrollTop - floorNow()) <= 2) break
    await wait(32)
  }
  const box = chat.getBoundingClientRect()
  // 真实场景：读者先往上读到历史里，才会去点早轮的刻度。先松跟随——保留「贴底时点早轮」
  // 那一态的话，tween 收尾的 scrollend 落定会按「还在跟随」把位置钉回底部（这是改动前
  // 就有的行为，scrollIntoView 更早，第一帧的 scroll 就会被钉回去；follow.ts 不在本次
  // 改动范围里）。所以这里验的是「读历史时点刻度」这一条真实路径。
  chat.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }))
  await wait(30)
  // 手势之后必须真的离开底部：落定（180ms）看的是「离 floor ≤24px」，停在底部会被重新跟随。
  chat.scrollTop = Math.max(0, floorNow() - 220)
  await wait(320)
  const before = chat.scrollTop
  const expected = row.getBoundingClientRect().top - (box.top - chat.scrollTop)
  // 诊断：把点击背后的异常抓下来（异步 IIFE 里抛错时页面侧不会有人报）。
  window.__jumpErrors = []
  window.addEventListener('error', (event) => { window.__jumpErrors.push(String(event.message)) })
  window.addEventListener('unhandledrejection', (event) => { window.__jumpErrors.push(String(event.reason)) })
  const railNode = document.querySelector('.jump-rail')
  const tickRect = tick.getBoundingClientRect()
  const userNode = seat.querySelector('.entry-user')
  tick.click()
  await wait(120)
  const afterClick = chat.scrollTop
  // 等补间落定：连续 3 次采样位置不变（补间是 rAF 逐帧写的，不靠固定时长猜）。
  let last = chat.scrollTop
  let stable = 0
  const settleDeadline = performance.now() + 4000
  while (performance.now() < settleDeadline) {
    await wait(50)
    const now = chat.scrollTop
    stable = Math.abs(now - last) <= 0.5 ? stable + 1 : 0
    last = now
    if (stable >= 3) break
  }
  await wait(200)
  const active = document.querySelector('.jump-tick[aria-current="true"]')
  return {
    targetRound,
    before,
    afterClick,
    after: chat.scrollTop,
    expected,
    gap: chat.scrollTop - expected,
    floor: floorNow(),
    active: active === null ? null : Number(active.getAttribute('data-turn')),
    spacerH: spacer === null ? -1 : spacer.offsetHeight,
    jumpedUp: before - chat.scrollTop,
    railHidden: railNode !== null && railNode.hasAttribute('hidden'),
    tickRect: [Math.round(tickRect.width), Math.round(tickRect.height)],
    userNode: userNode !== null && userNode.getClientRects().length > 0,
    errors: window.__jumpErrors.slice(0, 4),
  }
`)
console.log('[jump]', JSON.stringify(jumpProbe))
if (jumpProbe?.error !== undefined) {
  check('环境：跳轮现场摆得出来（≥3 枚刻度、第二轮座位在 DOM 里）', false, String(jumpProbe.error))
} else {
  check('跳轮：落到该轮首行在内容坐标里的偏移（±1px）',
    Math.abs(jumpProbe.gap) <= 1,
    JSON.stringify({ gap: jumpProbe.gap, expected: jumpProbe.expected, after: jumpProbe.after }))
  check('跳轮：真的往上跳了一段（不是本来就停在那儿）',
    jumpProbe.jumpedUp >= 40,
    `净上移 ${String(Math.round(jumpProbe.jumpedUp))}px`)
  check('跳轮：刻度条跟着亮到目标轮',
    jumpProbe.active === jumpProbe.targetRound,
    `目标 ${String(jumpProbe.targetRound)} / 实际 ${String(jumpProbe.active)}`)
  check('跳轮：没被跟随策略拽回底部（落点仍在内容区里、不在 floor 上）',
    jumpProbe.after < jumpProbe.floor - 40,
    JSON.stringify({ after: jumpProbe.after, floor: jumpProbe.floor }))
}

// ── 贴底直接点刻度：跟随态下点早轮，落点不许被落定逻辑钉回底部（2026-11-12）─────────
//
// 上面那条跳轮探针先合成了一次上滚手势把跟随关掉，所以抓不到这条缺陷。真实用法是
// **就贴在底部**（跟随态）点一个早轮刻度：改之前，补间逐帧写 `scrollTop`、每帧都经
// `reader.wrote` 回报，跟随策略一路认为「位置是我写的」；补间收尾那条 `scrollend` 走到
// `settle()` 时 `following` 还是 true，于是补一次 `pin()`——跳上去约 100ms 后被拽回
// floor，高亮也跟着跳回最后一轮。
//
// 修好之后：视口把落点交回跟随策略（`following = atFloor(24)`），没落在底上就脱离跟随，
// 一秒之后位置还在原处。
const bottomJump = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const chat = document.querySelector('.chat')
  const ticks = [...document.querySelectorAll('.jump-tick')]
  if (chat === null) return { error: '没有 .chat' }
  if (ticks.length < 3) return { error: '刻度不足 3 枚（没法从底上跳到更早的轮）' }
  const spacer = chat.querySelector('[data-chat-turn-spacer]')
  const floorNow = () => chat.scrollHeight - (spacer === null ? 0 : spacer.offsetHeight) - chat.clientHeight
  // 回到底部并保持跟随：胶囊的点击就是 follow.resume()，把跟随意图重新立起来。
  const pill = document.querySelector('.chat-to-bottom')
  if (pill !== null) pill.click()
  const pinDeadline = performance.now() + 3000
  while (performance.now() < pinDeadline) {
    if (Math.abs(chat.scrollTop - floorNow()) <= 2) break
    await wait(32)
  }
  // 落定（180ms）与它的补钉都跑完，跟随态才是稳的——这一步之后才是「贴底」的现场。
  await wait(320)
  if (Math.abs(chat.scrollTop - floorNow()) > 2) {
    return { error: '回不到底部（跟随态没立起来）：离底 ' + String(Math.round(floorNow() - chat.scrollTop)) + 'px' }
  }
  const box = chat.getBoundingClientRect()
  const offsetOf = (row) => row.getBoundingClientRect().top - (box.top - chat.scrollTop)
  const seats = [...chat.querySelectorAll('.turn-seat[data-round-seat]')]
  let target = null
  for (const seat of seats) {
    const round = Number(seat.getAttribute('data-round-seat'))
    if (!Number.isInteger(round)) continue
    const tick = ticks.find((node) => Number(node.getAttribute('data-turn')) === round) ?? null
    if (tick === null) continue
    const row = seat.querySelector('[data-round]') ?? seat
    const offset = offsetOf(row)
    // 落点要离底够远：「被拽回 floor」这件事才看得出来（不然两个位置本来就挨着）。
    if (floorNow() - offset < 200) continue
    target = { round, tick, offset }
    break
  }
  if (target === null) return { error: '没有离底 200px 以上的早轮刻度可点' }
  const start = chat.scrollTop
  // 落点用**落定之后**重新量的偏移来判：机器忙的时候从「量偏移」到「点下去」之间排版可能
  // 又动了一下（实测降速时整页会挪几百像素），拿点击前的旧读数判会把产品判错。
  const rowFor = () => {
    const seatsNow = [...chat.querySelectorAll('.turn-seat[data-round-seat]')]
    const seat = seatsNow.find((node) => Number(node.getAttribute('data-round-seat')) === target.round) ?? null
    return seat === null ? null : (seat.querySelector('[data-round]') ?? seat)
  }
  // 什么都不先滚，直接点：这就是「贴底点刻度」那一态。
  target.tick.click()
  // 等补间落定：连续 3 次 50ms 采样位置不变（不按固定时长猜）。
  let last = chat.scrollTop
  let stable = 0
  const settleDeadline = performance.now() + 4000
  while (performance.now() < settleDeadline) {
    await wait(50)
    const now = chat.scrollTop
    stable = Math.abs(now - last) <= 0.5 ? stable + 1 : 0
    last = now
    if (stable >= 3) break
  }
  const landed = chat.scrollTop
  const rowNow = rowFor()
  const expectedNow = rowNow === null ? null : offsetOf(rowNow)
  const activeNow = document.querySelector('.jump-tick[aria-current="true"]')
  // 一秒之后再看一次：缺陷的样子是「约 100ms 后被拽回 floor」，一秒站得住才算修好。
  await wait(700)
  const later = chat.scrollTop
  const rowLater = rowFor()
  const expectedLater = rowLater === null ? null : offsetOf(rowLater)
  const activeLater = document.querySelector('.jump-tick[aria-current="true"]')
  return {
    round: target.round,
    start,
    expectedBefore: target.offset,
    expectedNow,
    expectedLater,
    landed,
    later,
    floor: floorNow(),
    gapLanded: expectedNow === null ? null : landed - expectedNow,
    gapLater: expectedLater === null ? null : later - expectedLater,
    bottomGap: floorNow() - later,
    active: activeNow === null ? null : Number(activeNow.getAttribute('data-turn')),
    activeLater: activeLater === null ? null : Number(activeLater.getAttribute('data-turn')),
    ticks: ticks.length,
  }
`)
console.log('[bottom-jump]', JSON.stringify(bottomJump))
if (bottomJump?.error !== undefined) {
  check('环境：贴底点刻度的现场摆得出来（有离底 200px 以上的早轮刻度）', false, String(bottomJump.error))
  for (const name of [
    '贴底点刻度：落到该轮首行在内容坐标里的偏移（±1px）',
    '贴底点刻度：1 秒后仍在落点、没被拽回 floor',
    '贴底点刻度：刻度条亮的是目标轮',
  ]) skip(name, '现场摆不出来')
} else {
  check('贴底点刻度：落到该轮首行在内容坐标里的偏移（±1px）',
    bottomJump.gapLanded !== null && Math.abs(bottomJump.gapLanded) <= 1,
    JSON.stringify({ gap: bottomJump.gapLanded, expected: bottomJump.expectedNow, landed: bottomJump.landed }))
  check('贴底点刻度：1 秒后仍在落点、没被拽回 floor',
    bottomJump.gapLater !== null && Math.abs(bottomJump.gapLater) <= 1 && bottomJump.bottomGap > 40,
    JSON.stringify({
      later: bottomJump.later,
      expected: bottomJump.expectedLater,
      floor: bottomJump.floor,
      bottomGap: bottomJump.bottomGap,
    }))
  check('贴底点刻度：刻度条亮的是目标轮',
    bottomJump.activeLater === bottomJump.round,
    `目标 ${String(bottomJump.round)} / 1 秒后亮的是 ${String(bottomJump.activeLater)}（落定时是 ${String(bottomJump.active)}）`)
}

// ── 补间被打断：跳轮补间进行中滚一下，位置要听用户的手（审查 P2，2026-11-12）──────────
//
// 改之前 `stopTween()` 只在 `scrollToOffset` 开头与 `detach()` 里调：补间跑到一半时
// 滚轮一来，`follow.ts` 只改了跟随意图，补间照旧每帧写 `scrollTop`，手滚出来的位置
// 下一帧就被盖回去。现在滚轮 / 拖动 / 触摸都先 `viewport.cancelMotion()`。
//
// 判据不用固定时长猜：点完之后**按位置**等补间走到一成以上（起点与落点都已知，进度 =
// 已走 / 总距离），确认「补间真的动了、且离目标还很远」再滚；之后 420ms 内位置必须不再变。
// 合成滚轮不会真的滚动页面，所以「位置没再变」只可能来自补间被取消。
const interruptProbe = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const raf = () => new Promise((r) => requestAnimationFrame(r))
  const chat = document.querySelector('.chat')
  const ticks = [...document.querySelectorAll('.jump-tick')]
  if (chat === null) return { error: '没有 .chat' }
  const spacer = chat.querySelector('[data-chat-turn-spacer]')
  const floorNow = () => chat.scrollHeight - (spacer === null ? 0 : spacer.offsetHeight) - chat.clientHeight
  const backToBottom = async () => {
    const pill = document.querySelector('.chat-to-bottom')
    if (pill !== null) pill.click()
    const pinDeadline = performance.now() + 3000
    while (performance.now() < pinDeadline) {
      if (Math.abs(chat.scrollTop - floorNow()) <= 2) break
      await wait(32)
    }
    await wait(320)
  }
  const attempts = []
  // 最多试三次：机器忙的时候「点下去」到「第一帧」之间可能已经过了补间的大半（掉帧），
  // 那一下打断证明不了什么——回到底部重来，而不是拿一次失败的采样判产品。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // 从底部起跳：被打断的位置离 floor 很远，「停在原地」与「被钉回底部」也分得开。
    await backToBottom()
    const start = chat.scrollTop
    const box = chat.getBoundingClientRect()
    const offsetOf = (row) => row.getBoundingClientRect().top - (box.top - chat.scrollTop)
    const seats = [...chat.querySelectorAll('.turn-seat[data-round-seat]')]
    let target = null
    let best = 0
    for (const seat of seats) {
      const round = Number(seat.getAttribute('data-round-seat'))
      if (!Number.isInteger(round)) continue
      const tick = ticks.find((node) => Number(node.getAttribute('data-turn')) === round) ?? null
      if (tick === null) continue
      const row = seat.querySelector('[data-round]') ?? seat
      const offset = offsetOf(row)
      // 取**最远**的那一轮（不写死某个轮号）：补间越长，「走到一半」与「走完」分得越开。
      const distance = start - offset
      if (distance <= best) continue
      best = distance
      target = { round, tick, offset }
    }
    if (target === null || best < 300) {
      return {
        error: '没有相距 300px 以上的早轮可跳（补间太短，分不出打断）：最远 ' + String(Math.round(best)) + 'px',
        attempts,
      }
    }
    const distance = start - target.offset
    target.tick.click()
    // 等补间**按位置**走到半路（不按帧数猜：掉帧、缓动曲线都会让「第两帧走到几成」变样）。
    // 起点与落点都是已知的，进度 = 已走 / 总距离；走到 12% 以上就打断，此时离目标还有
    // 八成以上，补间要是没停，位置一定会明显继续往下走。
    let atWheel = null
    const watch = []
    const watchDeadline = performance.now() + 3000
    while (performance.now() < watchDeadline) {
      await raf()
      const now = chat.scrollTop
      watch.push({ t: Math.round(performance.now()), top: Number(now.toFixed(1)) })
      if ((start - now) / distance >= 0.12) {
        atWheel = now
        break
      }
    }
    if (atWheel === null) {
      attempts.push({ attempt, error: '补间三秒内没走到一成', start, target: target.offset, watch: watch.slice(0, 8) })
      continue
    }
    const remaining = Math.abs(target.offset - atWheel)
    if (remaining < 60) {
      // 这一帧来得太晚（掉帧 / 页面被降速），补间已经快走完：这一下打断证明不了什么，重来。
      attempts.push({ attempt, tooLate: true, atWheel, remaining, watch: watch.slice(0, 8) })
      await wait(300)
      continue
    }
    chat.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }))
    const trace = []
    const deadline = performance.now() + 420
    while (performance.now() < deadline) {
      await raf()
      trace.push(Number(chat.scrollTop.toFixed(1)))
    }
    const after = chat.scrollTop
    return {
      round: target.round,
      start,
      target: target.offset,
      atWheel,
      after,
      // 往上走是 scrollTop 变小：正数 = 已经往上离开了起点。
      moved: start - atWheel,
      remaining,
      drift: after - atWheel,
      floor: floorNow(),
      attempts,
      watch: watch.slice(0, 24),
      trace: trace.slice(0, 24),
    }
  }
  return { error: '三次都没能在补间半路打断（页面被降速或掉帧）', attempts }
`)
console.log('[interrupt]', JSON.stringify(interruptProbe))
if (interruptProbe?.error !== undefined) {
  check('环境：补间打断的现场摆得出来（有相距 300px 以上的早轮可跳）', false, String(interruptProbe.error))
  skip('补间打断：滚轮之后位置不再变（补间没有继续把它覆盖）', '现场摆不出来')
} else {
  // 前置：滚轮到达的那一刻，补间真的在跑（已经离开起点、且离目标还很远）。
  // 少了这一条，「本来就没动」会被当成「打断成功」。
  const midFlight = interruptProbe.moved > 4 && interruptProbe.remaining > 40
  check('现场：滚轮到达时补间还在半路（已移动 >4px、离目标 >40px）', midFlight,
    JSON.stringify({
      moved: Math.round(interruptProbe.moved),
      remaining: Math.round(interruptProbe.remaining),
      atWheel: Math.round(interruptProbe.atWheel),
      target: Math.round(interruptProbe.target),
    }))
  if (midFlight) {
    check('补间打断：滚轮之后位置不再变（补间没有继续把它覆盖）',
      Math.abs(interruptProbe.drift) <= 2,
      JSON.stringify({
        atWheel: Math.round(interruptProbe.atWheel),
        after: Math.round(interruptProbe.after),
        drift: Number(interruptProbe.drift.toFixed(1)),
        target: Math.round(interruptProbe.target),
      }))
  } else {
    skip('补间打断：滚轮之后位置不再变（补间没有继续把它覆盖）', '补间没跑到半路')
  }
}

// 收工时的整屏：这时这一轮是收起态（第二次点过），画面里能看出历史位置。
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(shots, '_fold-scroll.png'), Buffer.from(shot.data, 'base64'))

// ── 短会话（内容不满一屏）：atFloor 不再被 floor()===0 挡掉（2026-11-12）────────────
//
// 现场怎么摆：把**视口拉得比内容还高**（CDP 的 `Emulation.setDeviceMetricsOverride`），
// 于是 `floor() = scrollHeight − 占位 − clientHeight` 就是 0——这正是短会话的几何。
// 为什么不另造一条 1 轮的会话：种子会话是宿主 `Session` 写的、启动就打开它
// （`DSC_RESUME_SESSION`），中途换会话要走界面或宿主通道，比拉高视口脆得多；而 atFloor
// 的判据只跟「内容高 vs 可视高」有关，与轮数无关。拉高之前先量一次内容高，再留 800px
// 余量（下面还要展开一轮，内容会长几百像素）。
//
// 对照起点：先在长视口里摆出「不跟随 + 胶囊亮着」（合成上滚手势 + 把位置挪走），这样
// 「拉成短会话之后胶囊自己收回」才有判别力——它证明 `settle` 用 `atFloor(24)` 判出了
// 「在底」。旧守卫（`floor() <= 0 → false`）下这一条会红：胶囊会一直亮着。
const SHORT_CHECKS = [
  '短会话：floorSlack() 就是 0（atFloor(任何 slack) 都为真）',
  '短会话：跟随策略判「在底」（读者松手后落定自己回到跟随，胶囊收回）',
  '短会话：刻度条判「在底」并高亮最后一轮',
  '短会话：折叠操作不引起滚动跳变（不能滚就不该动）',
]
const contentHeight = await evaluate(`
  const chat = document.querySelector('.chat')
  return chat === null ? null : Math.ceil(chat.scrollHeight)
`)
if (typeof contentHeight !== 'number' || contentHeight <= 0) {
  check('环境：短会话的对照起点摆得出来（先不跟随、胶囊亮着）', false,
    `量不到 .chat 的内容高：${JSON.stringify(contentHeight)}`)
  for (const name of SHORT_CHECKS) skip(name, '现场摆不出来')
} else {
  // ① 长视口里先摆出「不跟随、胶囊亮着」。
  const paused = await evaluate(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const chat = document.querySelector('.chat')
    if (chat === null) return { error: '没有 .chat' }
    const spacer = chat.querySelector('[data-chat-turn-spacer]')
    const floorNow = () => chat.scrollHeight - (spacer === null ? 0 : spacer.offsetHeight) - chat.clientHeight
    const pill = document.querySelector('.chat-to-bottom')
    if (pill !== null) pill.click()
    const pinDeadline = performance.now() + 3000
    while (performance.now() < pinDeadline) {
      if (Math.abs(chat.scrollTop - floorNow()) <= 2) break
      await wait(32)
    }
    await wait(300)
    // 真手势往上，再把位置挪走：落定（180ms）之后就是「不跟随 + 胶囊亮着」。
    chat.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }))
    await wait(30)
    chat.scrollTop = Math.max(0, floorNow() - 220)
    // 等胶囊真的亮起来（跟随松手 + React 重渲染），不按固定时长猜：机器忙的时候
    // 320ms 可能还没渲染完，那会把「场景没摆好」误判成产品。
    const pillDeadline = performance.now() + 3000
    while (performance.now() < pillDeadline) {
      if (document.querySelector('.chat-to-bottom') !== null) break
      await wait(32)
    }
    return { floor: floorNow(), top: chat.scrollTop, pill: document.querySelector('.chat-to-bottom') !== null }
  `)
  console.log('[short-pre]', JSON.stringify(paused))
  if (paused?.error !== undefined || paused?.pill !== true) {
    check('环境：短会话的对照起点摆得出来（先不跟随、胶囊亮着）', false,
      String(paused?.error ?? `胶囊没亮：${JSON.stringify(paused)}`))
    for (const name of SHORT_CHECKS) skip(name, '对照起点摆不出来')
  } else {
    check('环境：短会话的对照起点摆得出来（先不跟随、胶囊亮着）', true)
    // ② 把视口拉得比内容还高：floor() 变成 0，就是短会话。
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1100,
      height: Math.ceil(contentHeight) + 800,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(500)
    const short = await evaluate(`
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const chat = document.querySelector('.chat')
      if (chat === null) return { error: '没有 .chat' }
      const spacer = chat.querySelector('[data-chat-turn-spacer]')
      const floorNow = () => chat.scrollHeight - (spacer === null ? 0 : spacer.offsetHeight) - chat.clientHeight
      const seats = [...chat.querySelectorAll('.turn-seat[data-round-seat]')]
      const rounds = seats
        .map((seat) => Number(seat.getAttribute('data-round-seat')))
        .filter((value) => Number.isInteger(value))
      if (rounds.length === 0) return { error: '没有轮座位' }
      const lastRound = Math.max(...rounds)
      const floor = floorNow()
      const top = chat.scrollTop
      if (floor > 1) return { error: '视口没拉够高：floor() 还是 ' + String(Math.round(floor)) + 'px' }
      const active = document.querySelector('.jump-tick[aria-current="true"]')
      const railActive = active === null ? null : Number(active.getAttribute('data-turn'))
      // 判别力诊断：旧守卫（floor() <= 0 → false）下 atBottom 是 false，刻度条会走命中测试 /
      // 几何兜底。把旧口径**原样复算**一遍（同 jump-rail 的 pickCurrentRound：命中优先，
      // 否则按锚点与探针线比），它给出的轮必须不是最后一轮，下面那条断言才有判别力。
      const box = chat.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + chat.clientWidth / 2, box.top + 8)
      let hitRound = null
      if (hit !== null && chat.contains(hit)) {
        const row = hit.closest('[data-round]')
        const value = row === null ? Number.NaN : Number(row.getAttribute('data-round'))
        if (Number.isInteger(value) && value >= 0) hitRound = value
      }
      const anchors = []
      const seenRounds = new Set()
      for (const row of chat.querySelectorAll('[data-round]')) {
        const value = Number(row.getAttribute('data-round'))
        if (!Number.isInteger(value) || value < 0) continue
        if (row.getClientRects().length === 0) continue
        if (seenRounds.has(value)) continue
        seenRounds.add(value)
        anchors.push({ round: value, top: row.getBoundingClientRect().top - box.top + chat.scrollTop })
      }
      const probeTop = chat.scrollTop + 8
      let oldAnswer
      if (hitRound !== null) oldAnswer = hitRound
      else if (anchors.length === 0) oldAnswer = -1
      else {
        let current = -1
        for (const anchor of anchors) {
          if (anchor.top <= probeTop) current = anchor.round
          else break
        }
        oldAnswer = current === -1 ? anchors[0].round : current
      }
      const pillAfter = document.querySelector('.chat-to-bottom') !== null
      // 对照：短会话里折叠最后一轮，位置不该动（不能滚就没地方动）。
      const seatNow = () => chat.querySelector('.turn-seat[data-round-seat="' + String(lastRound) + '"]')
      const segmentNow = () => {
        const seat = seatNow()
        return seat === null ? null : seat.querySelector('.turn-process')
      }
      const foldNow = () => {
        const segment = segmentNow()
        return segment === null ? null : segment.getAttribute('data-fold')
      }
      const btn = seatNow() === null ? null : seatNow().querySelector('.turn-fold:not([disabled])')
      const foldFrom = foldNow()
      const topBeforeFold = chat.scrollTop
      const heightBeforeFold = chat.scrollHeight
      const segBefore = segmentNow() === null ? null : Number(segmentNow().getBoundingClientRect().height.toFixed(1))
      const rowsBefore = segmentNow() === null ? -1 : [...segmentNow().querySelectorAll('.entry-row')]
        .filter((row) => row.getClientRects().length > 0).length
      const seatHiddenBefore = seatNow() === null ? null : seatNow().hasAttribute('hidden')
      let foldActuated = false
      if (btn !== null) {
        btn.click()
        const foldDeadline = performance.now() + 4000
        while (performance.now() < foldDeadline) {
          await wait(16)
          if (foldNow() !== foldFrom) foldActuated = true
          // 批次收工：内联 overflow-anchor 进过 none 又回到空串（与别的场景同一判据）。
          if (foldActuated && chat.style.overflowAnchor === '') break
        }
        await wait(300)
      }
      return {
        floor,
        top,
        lastRound,
        railActive,
        hitRound,
        oldAnswer,
        pillAfter,
        foldFrom,
        foldTo: foldNow(),
        foldActuated,
        topBeforeFold,
        topAfterFold: chat.scrollTop,
        floorAfterFold: floorNow(),
        heightBeforeFold,
        heightAfterFold: chat.scrollHeight,
        segBefore,
        segAfter: segmentNow() === null ? null : Number(segmentNow().getBoundingClientRect().height.toFixed(1)),
        rowsBefore,
        rowsAfter: segmentNow() === null ? -1 : [...segmentNow().querySelectorAll('.entry-row')]
          .filter((row) => row.getClientRects().length > 0).length,
        seatHiddenBefore,
        seatHiddenAfter: seatNow() === null ? null : seatNow().hasAttribute('hidden'),
      }
    `)
    console.log('[short]', JSON.stringify(short))
    if (short?.error !== undefined) {
      check('环境：短会话现场摆得出来（视口拉得比内容高，floor()===0）', false, String(short.error))
      for (const name of SHORT_CHECKS) skip(name, String(short.error))
    } else {
      // floor 0 且 scrollTop 0 ⇒ floorSlack() === 0 ⇒ atFloor(任何 slack >= 0) 都为真。
      check(SHORT_CHECKS[0], short.floor === 0 && short.top === 0,
        JSON.stringify({ floor: short.floor, top: short.top }))
      // 跟随策略那条走 atFloor(24)：对照起点是「胶囊亮着」，拉成短会话后胶囊必须自己收回。
      check(SHORT_CHECKS[1], short.pillAfter === false,
        JSON.stringify({ pillAfter: short.pillAfter, floor: short.floor }))
      // 刻度条那条走 atFloor(32)：短会话里「在底」= 最后一轮。
      // 判别力：旧守卫下会走命中测试 / 几何兜底，亮的是 oldAnswer；它不等于最后一轮时
      // 这条断言才有意义（否则命中测试也蒙对最后一轮，断言就是假绿）。
      check(SHORT_CHECKS[2], short.railActive === short.lastRound && short.oldAnswer !== short.lastRound,
        `最后一轮 ${String(short.lastRound)} / 刻度条亮的是 ${String(short.railActive)}（旧口径会亮 ${String(short.oldAnswer)}）`)
      if (short.foldActuated === true) {
        check(SHORT_CHECKS[3],
          Math.abs(short.topAfterFold - short.topBeforeFold) <= 1 && short.floorAfterFold === 0,
          JSON.stringify({
            topBefore: short.topBeforeFold,
            topAfter: short.topAfterFold,
            floorAfter: short.floorAfterFold,
            contentGrew: short.heightAfterFold - short.heightBeforeFold,
          }))
      } else {
        skip(SHORT_CHECKS[3], '折叠点击没生效')
      }
    }
  }
}

console.log(`\n[_verify-fold-scroll] 断言 ${String(passed + failures)} 条，通过 ${String(passed)} 条，失败 ${String(failures)} 条，环境跳过 ${String(skipped)} 条`)
try { ws.close() } catch {}
try { electron.kill() } catch {}
await sleep(400)
process.exit(failures === 0 ? 0 : 1)
