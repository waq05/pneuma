process.on('unhandledRejection', () => {})

/**
 * 「收起某一轮的路上，锚点那一行被重挂了，阅读位置也不许跳」的真机探针
 * （2026-11-12，配合 `viewport.ts` 的「按身份重构锚点」）。
 *
 * ## 为什么单独一条
 *
 * `_verify-fold-scroll.mjs` 判的是「点整轮开关时第一条可见行不动」，但它点的那个节点一直
 * 是同一个 DOM 元素。真实会话里 React 会**重挂行**：历史回填、设置到位、座位重新分组
 * （`seatPlan`）都会把整棵子树换掉——旧节点脱开文档、新节点同身份同位置。视口协调器
 * 的读历史态锚点以前记的是**元素引用**（`viewport.ts` 的 `readingAnchor()` → `{ element, top }`），
 * 于是 `land()` 每帧先问一句 `anchor.element.isConnected`：重挂之后那一问永远是否，
 * 整批剩下几十帧一次都不补 `scrollTop`——屏幕上的那行就跟着收起的高度往上飞。
 * 这条探针把「重挂」这件事**做成稳定现场**，不再靠概率撞。
 *
 * ## 现场怎么摆（稳定复现，不看运气）
 *
 * 1. 8 轮历史（和折叠探针同一套种子），打开第 3 轮，把它的组体（`.step-fold`）全摊开，
 *    于是整轮收起会把这一片从 ~331px 收到 0；
 * 2. 一次真手势（合成 wheel，deltaY < 0）让跟随松手 → 落点是「读历史」；
 * 3. 把这一轮的答案行顶到可视区顶端（`scrollTop += offset - 2`），它成为第一条可见行，
 *    也就是视口自己会选中的那个锚点；
 * 4. **记锚点行**（轮号 + 座位内行序号）之后点整轮开关；`MutationObserver` 盯 `.chat`
 *    的内联 `overflow-anchor`——它变成 `none` 的那一微任务就是批次开跑的同一刻，
 *    此刻把锚点行**原样换成一个同身份的新节点**（`replaceWith(clone)`）。
 *
 * 为什么用 `replaceWith(clone)` 而不去点一个会触发重挂的产品开关：一次真实重挂对 DOM 的
 * 全部事实就是「旧节点脱开文档、同身份同位置的新节点接上」，`replaceWith` 给的是**同一件
 * 事**，而且时刻由我们定（批次刚开、一秒不差），不用赌 React 什么时候提交。真重挂会不会
 * 发生由产品决定，这条探针只负责证明「发生了也不许跳」。
 *
 * ## 判据（修之前应当红）
 *
 *   a) 现场：批次真的开过（`none` 窗口 ≥120ms）；
 *   b) 现场：锚点行真的换过节点（旧节点 `isConnected === false`，按身份找回的仍是同一行）；
 *   c) 现场：起点是「读历史」（`.chat-to-bottom` 亮着 = `follow.paused` = 跟随已松手）——
 *      跟随态那一批本来就该钉到 floor，量出来的也是 166px 上下，**只有这一条能把两种
 *      166px 分开**：一种是跟随者的正常落点，一种是本探针要抓的漏补；
 *   d) **锚点行的屏幕 top 变化 ≤1px**（每帧采样，不是只看首末；判读窗口只取批次活着
 *      的那些帧——收工之后归跟随策略管，见下面「判读窗口」）；
 *   e) **补偿真的发生了**：`scrollTop` 变化量 > 0，且 ≥ 段高增量 × 0.8；
 *   f) **没有「找不到锚点」的降级**（`.chat` 的 `data-fold-anchor-fallback` 计数为 0；
 *      若出现，位置仍必须 ≤1px，否则记失败——降级有兜底但兜不住也算坏）；
 *   g) 批次末帧锚点行仍在原位（≤1px）。
 *
 * ## 判读窗口：只看批次活着的那些帧
 *
 * `overflow-anchor === 'none'` 的那些帧才是「收起这一批」。批次收工之后的位置归跟随策略
 * （`follow.ts` 的落定 / 钉底）管，那是另一套策略；把它混进来，会把「跟随后来钉了一次底」
 * 记成「折叠没补位置」，两件事分不开（实测：一次偶发就是批次里补得好好的、收工之后被
 * 钉回 floor，漂移数字同样是 166px）。收工之后的读数仍然打印成 `[after-batch]`，只作排查
 * 线索，不当判据。
 *
 * 修之前的读数（稳定复现，不是偶发）：`maxDrift = 200.44px`、`scrollMoved = 134px`
 * （那 134px 还是浏览器在内容变矮后自己夹的，不是产品补的）、`segDelta = 331px`，
 * 8 条断言通过 4 条、失败 4 条、退出码 1。修之后同一现场：`maxDrift = 0.65px`、
 * `scrollMoved = 334px`、降级计数 0，全部断言绿。
 *
 * 运行：node desktop/shots/_verify-fold-anchor-remount.mjs
 * 前提：`pnpm run build`（要 lib/core/session.js 写种子）与 `pnpm run build:ui` 都跑过。
 *
 * @module desktop/shots/_verify-fold-anchor-remount
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-fold-anchor-remount-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 19001
const debugPort = 9391

/**
 * 关掉 Chromium 的后台节流（与 `_probe-kit.mjs` 的 `launchDesktop` 同一组）。
 *
 * 窗口被挡在后面时 Chromium 会把定时器压到 1Hz、停掉 rAF：每帧采样掉到个位数，
 * 「重挂之后位置有没有被补」这件事就采不到。连上 CDP 后再补一条
 * `Emulation.setFocusEmulationEnabled`（见下面），让页面当自己在前台。
 */
const ANTI_THROTTLE = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

/** 采样窗口最少要多少帧才值得判读（与折叠探针同一门槛）。 */
const FRAME_FLOOR = 24
/** 16ms 状态采样最少要多少次。 */
const TICK_FLOOR = 10
/**
 * 批次活跃窗口的下限（ms）：默认批次 = `--dsc-dur-slow`(180ms) + 提交余量(60ms)，
 * 实测 225–259ms；门槛取一半，容一次迟到的回调，又能把「只闪了一下」和「根本没开」分开。
 */
const NONE_WINDOW_FLOOR = 120
/**
 * 补位量下限的比例：段高增量 × 0.8。
 *
 * 实测段高增量 ≈ 331px、`scrollTop` 补 ≈ 334px（差几 px 是亚像素与 1px 取整）。
 * 要求 ≥80% 既拦住「批次没开、根本没补」，也允许采样刚好落在过渡末帧之前。
 */
const COMPENSATION_RATIO = 0.8
/** 判「没动」的阈值（px）：与视口自己的 `MOVE_EPS` 同一条口径。 */
const MOVE_EPS = 1

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(join(work), { recursive: true })
// Chromium 在 app ready 之前会去 %USERPROFILE%\AppData\Roaming 找配置：目录不存在会直接崩。
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-fold-anchor', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-fold-anchor', '        name: Fake Fold Anchor',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
// completion：已收尾的轮默认收起，于是点一下就是「展开」方向，再点一下是「收起」方向。
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({ ui: { collapseTiming: 'completion' } }))

// ── 历史种子：必须是宿主自己的 Session 写的（手搓 jsonl 会和宿主的重放口径对不上）──────
process.env.HOME = home
process.env.USERPROFILE = home
const core = await import('../../lib/core/session.js')
const seed = core.Session.create(work)
const HISTORY_ROUNDS = 8
/** 每轮的过程行数：折叠区要够高，收起时的位移才可能到几百像素。 */
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
        id: `call_fold_anchor_${String(round)}_${String(step)}`,
        name: 'read',
        arguments: JSON.stringify({ path: join(work, 'probe-target.txt') }),
      },
    ])
    seed.appendTool(
      `call_fold_anchor_${String(round)}_${String(step)}`,
      'read',
      `第 ${String(round + 1)} 轮第 ${String(step + 1)} 步读到的样张内容（三行）。`,
    )
  }
  // 收尾的定稿正文：过程区之外的那一行，读者在读历史时盯的就是它，也是本探针的锚点行。
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

// 「减少动态效果」开着时，折叠批次是同步开又同步收的，中间没有可观测的活跃窗口——
// 这时判「批次活跃期间」没有意义。先当环境问题报出来。
/**
 * 负向对照（`PROBE_NO_REMOUNT=1`）：**不换节点**，其余现场一模一样。
 *
 * 它的用处是分辨「探针红在哪一层」：不换节点还红，说明位置本来就在漂（产品别的路径），
 * 跟重挂无关；不换节点是绿的，才说明红是重挂那一下造成的。默认不设 = 正常跑。
 */
const noRemount = process.env.PROBE_NO_REMOUNT === '1'
const reducedMotion = await evaluate('return window.matchMedia("(prefers-reduced-motion: reduce)").matches')
if (reducedMotion === true) {
  console.log('  FAIL 环境：系统没有开启「减少动态效果」：prefers-reduced-motion: reduce 让批次同步开合，无法按时间判读；请在系统里关掉再跑')
  try { ws.close() } catch {}
  try { electron.kill() } catch {}
  process.exit(1)
}

// ── 摆位置：真手势松跟随 → 摊开目标轮的组体 → 把答案行顶到可视区顶端 ───────────────
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
  // 上滚手势：跟随策略靠「有手势作证」才认读者在读历史（follow.ts 的规矩）。
  // 不先做这一下，后面把 scrollTop 挪走会被当成排版抖动，下一帧又被钉回底部。
  chat.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }))
  await wait(260)

  const seats = [...chat.querySelectorAll('.turn-seat[data-round-seat]')]
  const trials = []
  let target = null
  for (let index = 1; index < seats.length - 1; index += 1) {
    const seat = seats[index]
    const btn = seat.querySelector('.turn-fold:not([disabled])')
    const segment = seat.querySelector('.turn-process')
    const answer = [...seat.querySelectorAll('.entry-text')]
      .map((node) => node.closest('.entry-row'))
      .find((row) => row !== null && row.closest('.turn-process') === null) ?? null
    const trial = {
      round: seat.getAttribute('data-round-seat'),
      btn: btn !== null,
      segment: segment !== null,
      answer: answer !== null,
      rows: [...seat.querySelectorAll('.entry-row')].length,
    }
    if (btn === null || segment === null || answer === null) { trials.push(trial); continue }
    // 整轮折叠区里装的是阶段组，组体默认收起——不先摊开，整轮收起只动 28px 的组头，
    // 量出来的补位量没有分量。组头的开合不走 data-fold（不是视口批次），可以提前点开。
    let opened = 0
    for (const groupBtn of seat.querySelectorAll('.step-fold')) {
      if (groupBtn.getAttribute('data-open') === '1') continue
      groupBtn.click()
      opened += 1
    }
    if (opened > 0) await wait(420)
    trial.opened = opened
    // 本探针要测的是**收起**方向，所以先让这一轮处在展开态。默认 completion 档下
    // 已收尾的轮是收起的；点开它、等这一批收工，再重新解析节点（点开本身也可能重挂行）。
    const roundKey = seat.getAttribute('data-round-seat')
    if (segment.getAttribute('data-fold') !== 'open') {
      const openBtn = seat.querySelector('.turn-fold:not([disabled])')
      if (openBtn === null) { trial.reason = '没有可点的开关'; trials.push(trial); continue }
      openBtn.click()
      const openDeadline = performance.now() + 5000
      while (performance.now() < openDeadline) {
        await wait(32)
        if (chat.style.overflowAnchor === '') {
          const now = chat.querySelector('.turn-seat[data-round-seat="' + roundKey + '"] .turn-process')
          if (now !== null && now.getAttribute('data-fold') === 'open') break
        }
      }
      await wait(160)
    }
    const seat2 = chat.querySelector('.turn-seat[data-round-seat="' + roundKey + '"]')
    const segment2 = seat2 === null ? null : seat2.querySelector('.turn-process')
    const answer2 = seat2 === null
      ? null
      : [...seat2.querySelectorAll('.entry-text')]
        .map((node) => node.closest('.entry-row'))
        .find((row) => row !== null && row.closest('.turn-process') === null) ?? null
    const btn2 = seat2 === null ? null : seat2.querySelector('.turn-fold:not([disabled])')
    if (seat2 === null || segment2 === null || answer2 === null || btn2 === null) {
      trial.reason = '展开之后找不到座位/过程区/答案行'
      trials.push(trial)
      continue
    }
    trial.foldAfterOpen = segment2.getAttribute('data-fold')
    if (trial.foldAfterOpen !== 'open') { trial.reason = '点不开这一轮'; trials.push(trial); continue }
    const offset = answer2.getBoundingClientRect().top - chat.getBoundingClientRect().top
    chat.scrollTop += offset - 2
    const above = chat.scrollTop
    const below = chat.scrollHeight - chat.clientHeight - chat.scrollTop
    trial.above = Math.round(above)
    trial.below = Math.round(below)
    trial.grown = Math.round(
      [...segment2.querySelectorAll('.step-body')]
        .reduce((sum, body) => sum + Math.max(body.scrollHeight, body.offsetHeight), 0)
      + segment2.querySelectorAll('.step-body').length * 28,
    )
    // 上方要能抹平一次收起（300px 以上），下方还要能滚动一小段（不然量到的是夹住的位置）。
    if (above < 420 || below < 60) { trials.push(trial); continue }
    target = { seat: seat2, btn: btn2, answer: answer2, segment: segment2 }
    break
  }
  if (target === null) return { error: '没有找到合适的整轮（上下空间都不够）', trials, total: seats.length }
  await wait(320)

  const view = chat.getBoundingClientRect()
  const visible = (row) => {
    const rect = row.getBoundingClientRect()
    return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom && row.closest('[hidden]') === null
  }
  // 与视口协调器同一条口径：第一条可见、且不被这一批搬动的行（不在任何 .turn-process 里）。
  // 等排版真的落定再取：负载下 React 的提交会晚几百毫秒，不等就会取到相邻轮的行。
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
  const seatRows = [...target.seat.querySelectorAll('.entry-row')]
  const anchorIndex = seatRows.indexOf(anchor)
  const spacer = chat.querySelector('[data-chat-turn-spacer]')

  window.__remountProbe = {
    chat, spacer,
    round: target.seat.getAttribute('data-round-seat'),
    anchorIndex,
    anchor,
    baseline: anchor.getBoundingClientRect().top,
    samples: [], ticks: [], sampling: false,
    sawNone: false, noneFirst: null, noneLast: null, noneEnd: null, noneComputed: true,
    remount: { done: false, at: null, late: false, oldConnected: null, newIsClone: false, sameRound: null, sameIndex: null },
    seatNow() {
      return this.chat.querySelector('.turn-seat[data-round-seat="' + this.round + '"]')
    },
    rowsNow() {
      const seat = this.seatNow()
      return seat === null ? [] : [...seat.querySelectorAll('.entry-row')]
    },
    anchorNow() {
      return this.rowsNow()[this.anchorIndex] ?? null
    },
    btnNow() {
      const seat = this.seatNow()
      return seat === null ? null : seat.querySelector('.turn-fold:not([disabled])')
    },
    segmentNow() {
      const seat = this.seatNow()
      return seat === null ? null : seat.querySelector('.turn-process')
    },
    fallbacks() {
      return Number(this.chat.dataset.foldAnchorFallback ?? '0')
    },
    /**
     * 把锚点行换成一个同身份的新节点：这正是 React 重挂对这一行做的那件事。
     * 旧节点脱开文档、新节点在同一位置、同样的 data-round 与同一个座位内序号。
     */
    remountNow(note) {
      const current = this.anchorNow()
      if (current === null) return false
      const clone = current.cloneNode(true)
      current.replaceWith(clone)
      const back = this.anchorNow()
      this.remount = {
        done: true,
        at: performance.now(),
        late: note === 'late',
        oldConnected: current.isConnected,
        newIsClone: back === clone,
        sameRound: back !== null && back.getAttribute('data-round') === current.getAttribute('data-round'),
        sameIndex: this.rowsNow().indexOf(back) === this.anchorIndex,
      }
      return true
    },
    read() {
      const row = this.anchorNow()
      const segment = this.segmentNow()
      return {
        t: performance.now(),
        top: row === null ? null : Number(row.getBoundingClientRect().top.toFixed(2)),
        h: row === null ? null : Number(row.getBoundingClientRect().height.toFixed(2)),
        scrollTop: chat.scrollTop,
        sh: chat.scrollHeight,
        inline: chat.style.overflowAnchor,
        computed: getComputedStyle(chat).overflowAnchor,
        fold: segment === null ? null : segment.getAttribute('data-fold'),
        segH: segment === null ? null : Number(segment.getBoundingClientRect().height.toFixed(1)),
        spacer: spacer === null ? -1 : spacer.offsetHeight,
        fallbacks: this.fallbacks(),
        // 诊断用：跟随策略有没有在批次中途又把手接回去（胶囊一消失 = follow.paused
        // 变 false = 跟随重新立起来），以及此刻离内容底还有多少。跑挂时这两样是唯一
        // 能分清「产品没补」与「补完之后又被跟随钉回底部」的读数。
        pill: document.querySelector('.chat-to-bottom') !== null,
        slack: Math.round((chat.scrollHeight - (spacer === null ? 0 : spacer.offsetHeight) - chat.clientHeight) - chat.scrollTop),
      }
    },
  }
  return {
    rounds: seats.length,
    round: target.seat.getAttribute('data-round-seat'),
    anchorIndex,
    anchorRound: anchor.getAttribute('data-round'),
    seatRows: seatRows.length,
    anchorTop: Number((anchor.getBoundingClientRect().top - view.top).toFixed(2)),
    // 「回头路」胶囊只在 follow.paused 时画（ui.tsx 的 .chat-to-bottom）。它亮着 = 跟随
    // 已经松手 = 这一批的落点是「读历史」。不亮的话下面量到的漂移没有意义：那一批本来就
    // 该钉到 floor（跟随者的落点），漂多少都不算缺陷。
    pill: document.querySelector('.chat-to-bottom') !== null,
    scrollTop: Math.round(chat.scrollTop),
    canScrollUp: Math.round(chat.scrollTop),
    canScrollDown: Math.round(chat.scrollHeight - chat.clientHeight - chat.scrollTop),
    segmentHeight: Number(target.segment.getBoundingClientRect().height.toFixed(1)),
    fold: target.segment.getAttribute('data-fold'),
  }
`)
console.log('place', JSON.stringify(placed))
if (placed?.error !== undefined) {
  console.log(`  FAIL 环境：摆不出可判读的现场：${String(placed.error)}`)
  try { ws.close() } catch {}
  try { electron.kill() } catch {}
  process.exit(1)
}

/**
 * 开采样 → 点开关 → **在批次开跑的那一微任务里换掉锚点行** → 等批次收工。
 *
 * 为什么换节点放在 `MutationObserver` 回调里：批次开跑的同一刻会写 `.chat` 的内联
 * `overflow-anchor = none`（`viewport.beginBatch`），那条 attribute 变更的通知是微任务，
 * 跑在当前任务之后、布局与绘制之前。在这一刻换节点，保证「重挂」发生在视口第一次
 * `land()` **之前**——修之前是整整一批都不补，修之后是每一帧都按身份找回新节点。
 * 观察器没来得及（批次没开、或 inline 值被别的路径写）时，rAF 看门狗补一次并记 `late`。
 */
const run = await evaluate(`
  const p = window.__remountProbe
  const chat = p.chat
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const afterPaint = () => new Promise((r) => { requestAnimationFrame(() => { setTimeout(r, 0) }) })
  const btn = p.btnNow()
  if (btn === null) return { clicked: false, reason: '这一轮没有可点的整轮开关（已重挂或被禁用）', before: p.read() }
  if (!btn.isConnected) return { clicked: false, reason: '拿到的开关不在文档里（重挂后的旧节点）', before: p.read() }
  const before = p.read()
  // 诊断：记账每一次 scrollTop 写入（只在本探针的窗口里、只在跑挂时打印大额的那几笔）。
  // 为什么要它：位置跳了 166px 有两种来源——产品没补，或者补完之后被别的路径写走
  // （跟随策略钉底、浏览器夹持）。只量锚点的 top 分不开这两种，写入的方向与调用栈能分。
  const scrollOwner = (() => {
    let node = chat
    while (node !== null && Object.getOwnPropertyDescriptor(node, 'scrollTop') === undefined) {
      node = Object.getPrototypeOf(node)
    }
    return node
  })()
  const scrollDesc = scrollOwner === null ? null : Object.getOwnPropertyDescriptor(scrollOwner, 'scrollTop')
  const writes = []
  if (scrollDesc !== null && scrollDesc.get !== undefined && scrollDesc.set !== undefined) {
    Object.defineProperty(chat, 'scrollTop', {
      configurable: true,
      get() { return scrollDesc.get.call(chat) },
      set(value) {
        const from = scrollDesc.get.call(chat)
        scrollDesc.set.call(chat, value)
        const to = scrollDesc.get.call(chat)
        if (Math.abs(to - from) > 20) {
          writes.push({
            t: Math.round(performance.now()),
            from: Math.round(from),
            to: Math.round(to),
            floor: Math.round(chat.scrollHeight - (p.spacer === null ? 0 : p.spacer.offsetHeight) - chat.clientHeight),
            stack: String(new Error().stack ?? '').split('\\n').slice(1, 5).map((line) => line.trim()).join(' | '),
          })
        }
      },
    })
  }
  p.samples = []
  p.ticks = []
  p.sawNone = false
  p.noneFirst = null
  p.noneLast = null
  p.noneEnd = null
  p.noneComputed = true
  p.sampling = true
  const push = () => { if (p.sampling) p.samples.push(p.read()) }
  const tick = () => {
    if (!p.sampling) return
    requestAnimationFrame(tick)
    setTimeout(push, 0)
  }
  const tickState = () => {
    if (!p.sampling) return
    p.ticks.push(p.read())
    setTimeout(tickState, 16)
  }
  p.pushSample = push
  // 先当场记一条「点之前」的样子：补位量要拿它当起点（收起方向第一帧就可能把内容撤掉）。
  push()
  tickState()
  requestAnimationFrame(tick)

  // 批次起止以 .chat 的内联 overflow-anchor 为准（微任务投递，不受 rAF / 定时器降频影响）。
  const batchWatch = new MutationObserver(() => {
    const value = chat.style.overflowAnchor
    if (value === 'none') {
      p.sawNone = true
      if (p.noneFirst === null) p.noneFirst = performance.now()
      p.noneLast = performance.now()
      if (getComputedStyle(chat).overflowAnchor !== 'none') p.noneComputed = false
      // 批次刚开：此刻换节点 = 「收起的过程中锚点那一行重挂」（PROBE_NO_REMOUNT=1 时不换）。
      if (!${String(noRemount)} && !p.remount.done) p.remountNow('batch')
    } else if (p.noneFirst !== null && p.noneEnd === null) {
      p.noneEnd = performance.now()
    }
  })
  batchWatch.observe(chat, { attributes: true, attributeFilter: ['style'] })
  btn.click()
  // 看门狗：上下文没准时开批（或 inline 值这一批没写），三帧之后也换一次，但记 late。
  for (let i = 0; i < 3; i += 1) {
    await afterPaint()
    if (p.remount.done) break
  }
  if (!${String(noRemount)} && !p.remount.done) p.remountNow('late')

  const started = performance.now()
  let actuatedAt = p.remount.at
  // 等条件，不等固定时长：批次开过又收工（inline 进过 none、现在不是 none）。
  while (performance.now() - started < 4000) {
    await wait(16)
    if (p.sawNone && chat.style.overflowAnchor !== 'none') break
    // 重挂之后连批次都没开：再给 700ms 让它开，之后交给判据。
    if (actuatedAt !== null && performance.now() - actuatedAt > 700 && p.sawNone === false) break
  }
  const frameDeadline = performance.now() + 3000
  while (p.samples.length < ${String(FRAME_FLOOR)} && performance.now() < frameDeadline) await wait(32)
  push()
  p.sampling = false
  batchWatch.disconnect()

  // 收工之后再看一眼：批次末尾那几帧有没有把位置还回来。
  await wait(220)
  const end = p.read()

  const samples = p.samples
  const ticks = p.ticks
  /**
   * 判读窗口只认**批次活着**的那些帧（内联 overflow-anchor 是 none）。
   *
   * 为什么掐在批次里：本探针要证的是「收起这一批的过程中，锚点那一行不动」。批次收工之后
   * 的位置归跟随策略（follow.ts 的落定 / 钉底）管——那是另一套策略，不在这一条判据里；
   * 混进来会把「跟随后来钉了一次底」记成「折叠没补位置」，两件事分不开。收工之后的位置
   * 仍然打印（afterTop / afterWrites），只是不当判据。
   */
  const inBatch = samples.filter((s) => s.inline === 'none' && s.top !== null)
  const judged = inBatch.length >= 2 ? inBatch : samples.filter((s) => s.top !== null)
  const drifts = judged.map((s) => Math.abs(s.top - p.baseline))
  const maxDrift = drifts.length === 0 ? 0 : Math.max(...drifts)
  const worst = judged.find((s) => Math.abs(s.top - p.baseline) === maxDrift) ?? null
  const segHeights = ticks.map((s) => s.segH).filter((v) => typeof v === 'number')
  const segFrom = segHeights.length === 0 ? null : Math.min(...segHeights)
  const segTo = segHeights.length === 0 ? null : Math.max(...segHeights)
  // 收起方向段高是「从 331 掉到 0」：增量按绝对值算，判据只关心「收掉了多少」。
  const segDelta = segFrom === null || segTo === null ? 0 : Math.abs(segTo - segFrom)
  // 补偿量同样只在批次窗口里量：收工之后若有跟随钉底，那是另一笔写入，不该算进「补了多少」。
  const scrollMoved = judged.length < 2 ? 0 : Math.abs(judged[judged.length - 1].scrollTop - judged[0].scrollTop)
  const noneWindowMs = p.noneFirst === null ? 0 : Math.round((p.noneEnd ?? p.noneLast ?? p.noneFirst) - p.noneFirst)
  const fallbackAfter = p.fallbacks()
  // 批次收工之后的大额写入：只打印，不判。它说明「位置是被谁写走的」，供排查用。
  const afterWrites = writes.filter((w) => p.noneEnd !== null && w.t > p.noneEnd)
  const maxGap = (() => {
    let worstGap = 0
    for (let at = 1; at < samples.length; at += 1) {
      worstGap = Math.max(worstGap, samples[at].t - samples[at - 1].t)
    }
    return worstGap
  })()
  return {
    clicked: true,
    before,
    end,
    remount: p.remount,
    baseline: p.baseline,
    frames: samples.length,
    batchFrames: judged.length,
    ticks: ticks.length,
    maxGap: Math.round(maxGap),
    maxDrift: Number(maxDrift.toFixed(2)),
    worst: worst === null ? null : { t: Math.round(worst.t), top: worst.top, scrollTop: Math.round(worst.scrollTop) },
    sawNone: p.sawNone,
    noneWindowMs,
    noneComputed: p.noneComputed,
    segFrom,
    segTo,
    segDelta: Math.round(segDelta),
    scrollMoved: Math.round(scrollMoved),
    foldAt: [...new Set(ticks.map((s) => s.fold))],
    fallbackAfter,
    // 批前基数：data-fold-anchor-fallback 是全会话累计（只在换容器时清零），
    // 判「这一批有没有降级」必须用增量，不能直接拿累计值跟 0 比——摆现场阶段的两次
    // 折叠批次只要降级过一次，累计值就永远非 0，那条断言就成了恒真（审查 2026-11-12）。
    fallbackBefore: before.fallbacks,
    // 批次里最后一帧的位置（「收工那一刻」），与 220ms 之后的读数分开。
    batchEndTop: judged.length === 0 ? null : judged[judged.length - 1].top,
    afterTop: end.top,
    afterWrites,
    endTop: end.top,
    endSpacer: end.spacer,
    endInline: end.inline,
    trace: samples.slice(0, 30).map((s) => ({
      t: Math.round(s.t),
      top: s.top,
      st: Math.round(s.scrollTop),
      h: Math.round(s.segH ?? -1),
      f: s.fold,
      a: s.inline === 'none' ? 'n' : '',
      fb: s.fallbacks,
      p: s.pill ? 'P' : '',
      sl: s.slack,
    })),
    bigWrites: writes,
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
const skip = (name, why) => {
  skipped += 1
  console.log(`  skip ${name}（环境未就绪：${why}）`)
}

if (run?.clicked !== true) {
  check('环境：点击生效（这一轮出现可见状态变化）', false, String(run?.reason ?? '点击没有发生'))
  for (const name of [
    '现场：批次真的开过（内联 overflow-anchor 进过 none，窗口 ≥120ms）',
    '现场：锚点行真的换过节点（旧节点脱开、按身份找回同一行）',
    '收起中重挂：锚点行的屏幕 top 变化 ≤1px',
    '收起中重挂：scrollTop 真的补过（≥ 段高增量 × 0.8）',
    '收起中重挂：没有「找不到锚点」的降级（data-fold-anchor-fallback 计数 0）',
    '收起中重挂：批次收工后锚点行仍在原位（≤1px）',
  ]) skip(name, '点击没发生')
  console.log(`\n[_verify-fold-anchor-remount] 断言 ${String(passed + failures)} 条，通过 ${String(passed)} 条，失败 ${String(failures)} 条，环境跳过 ${String(skipped)} 条`)
  try { ws.close() } catch {}
  try { electron.kill() } catch {}
  await sleep(400)
  process.exit(1)
}

console.log('[run]', JSON.stringify({
  before: run.before, remount: run.remount, baseline: run.baseline, frames: run.frames,
  ticks: run.ticks, maxGap: run.maxGap, maxDrift: run.maxDrift, worst: run.worst,
  sawNone: run.sawNone, noneWindowMs: run.noneWindowMs, noneComputed: run.noneComputed,
  segFrom: run.segFrom, segTo: run.segTo, segDelta: run.segDelta, scrollMoved: run.scrollMoved,
  foldAt: run.foldAt, fallbackBefore: run.fallbackBefore, fallbackAfter: run.fallbackAfter, endTop: run.endTop,
  endSpacer: run.endSpacer, endInline: run.endInline,
}))
if (run.maxDrift > MOVE_EPS) console.log('[run trace]', JSON.stringify(run.trace))
if (run.maxDrift > MOVE_EPS && (run.bigWrites ?? []).length > 0) console.log('[run writes]', JSON.stringify(run.bigWrites))

// ── 环境闸：只问「量尺准不准」，不问产品对错 ─────────────────────────────────────────
const envProblems = []
if (run.frames < FRAME_FLOOR) envProblems.push(`有效帧 ${String(run.frames)} 帧 < ${String(FRAME_FLOOR)}（页面被节流或掉帧）`)
if (run.ticks < TICK_FLOOR) envProblems.push(`状态采样 ${String(run.ticks)} 次 < ${String(TICK_FLOOR)}`)
if (run.frames >= 2 && run.maxGap > 100) envProblems.push(`rAF 采样最长间隔 ${String(run.maxGap)}ms > 100ms（掉帧，位置判读不可信）`)
const envOk = envProblems.length === 0
if (envOk) {
  check('环境：现场可判读', true)
} else {
  check('环境：现场可判读', false, envProblems.join('；'))
}

// ── 现场：两次「真的发生了」──否则产品判据可以靠「什么都没发生」白拿 ─────────────────
const remountOk = run.remount?.done === true
  && run.remount?.oldConnected === false
  && run.remount?.newIsClone === true
  && run.remount?.sameIndex === true
if (noRemount) {
  skip('现场：锚点行真的换过节点（旧节点脱开、按身份找回同一行）', 'PROBE_NO_REMOUNT=1（负向对照：故意不换）')
} else {
  check('现场：锚点行真的换过节点（旧节点脱开、按身份找回同一行）', remountOk,
    JSON.stringify(run.remount))
}
check('现场：批次真的开过（内联 overflow-anchor 进过 none，窗口 ≥120ms）',
  run.sawNone === true && run.noneWindowMs >= NONE_WINDOW_FLOOR && run.noneComputed === true,
  JSON.stringify({ sawNone: run.sawNone, noneWindowMs: run.noneWindowMs, noneComputed: run.noneComputed }))
// 起点必须是「读历史」：胶囊（`.chat-to-bottom`）亮着 = `follow.paused` = 跟随已松手。
// 少了这一条，跟随态那一批会照规矩钉到 floor，量出来的 166px 是跟随者的正常落点，
// 不是本探针要抓的缺陷（两者数字一模一样，只有这一条能把它们分开）。
check('现场：起点是读历史（回头路胶囊亮着，跟随已松手）', placed.pill === true,
  JSON.stringify({ pill: placed.pill, scrollTop: placed.scrollTop, canScrollDown: placed.canScrollDown }))

const productNames = [
  '收起中重挂：锚点行的屏幕 top 变化 ≤1px',
  '收起中重挂：scrollTop 真的补过（≥ 段高增量 × 0.8）',
  '收起中重挂：没有「找不到锚点」的降级（data-fold-anchor-fallback 计数 0）',
  '收起中重挂：批次末帧锚点行仍在原位（≤1px）',
]
if (!envOk) {
  for (const name of productNames) skip(name, envProblems.join('；'))
} else {
  check(productNames[0], run.maxDrift <= MOVE_EPS, `实测 ${String(run.maxDrift)}px（最差一帧 ${JSON.stringify(run.worst)}）`)
  // 补偿量：段高增量 × 0.8，且至少 40px（段高增量很小的时候「补了 3px」也算不上补偿）。
  check(productNames[1],
    run.segDelta > 0 && run.scrollMoved >= Math.max(40, Math.round(run.segDelta * COMPENSATION_RATIO)),
    `实测补了 ${String(run.scrollMoved)}px、段高增量 ${String(run.segDelta)}px`)
  // 降级计数：判的是**这一批**的增量（累计值只在换容器时清零，拿它跟 0 比会恒真）。
  check(productNames[2],
    run.fallbackAfter === run.fallbackBefore,
    `本批降级 ${String(run.fallbackAfter - run.fallbackBefore)} 次（批前 ${String(run.fallbackBefore)}、批后 ${String(run.fallbackAfter)}），位置漂移 ${String(run.maxDrift)}px`)
  check(productNames[3],
    run.batchEndTop !== null && Math.abs(run.batchEndTop - run.baseline) <= MOVE_EPS,
    `批次末帧 top ${String(run.batchEndTop)}、起点 ${String(run.baseline)}`)
}
// 收工之后的位置只打印：那是跟随策略的地盘（见上面 `inBatch` 的注释）。若这里出现大额移动，
// 说明批次之外还有一只手在写 `scrollTop`，排查时先看它、别去翻折叠那一套。
const afterJump = run.afterTop === null ? 0 : Math.abs(run.afterTop - run.baseline)
if (afterJump > MOVE_EPS || (run.afterWrites ?? []).length > 0) {
  console.log('[after-batch]', JSON.stringify({
    afterTop: run.afterTop,
    baseline: run.baseline,
    drift: Number(afterJump.toFixed(2)),
    writes: run.afterWrites ?? [],
  }))
}

try {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, '_fold-anchor-remount.png'), Buffer.from(shot.data, 'base64'))
} catch {}

console.log(`\n[_verify-fold-anchor-remount] 断言 ${String(passed + failures)} 条，通过 ${String(passed)} 条，失败 ${String(failures)} 条，环境跳过 ${String(skipped)} 条`)
try { ws.close() } catch {}
try { electron.kill() } catch {}
await sleep(400)
process.exit(failures === 0 ? 0 : 1)
