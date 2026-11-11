process.on('unhandledRejection', () => {})

/**
 * 「整轮收起态在行体重挂之后重新露出来」的真机探针（2026-11-11）。
 *
 * ## 要证的三件事（P1 / P2 / P3 分开报账）
 *
 * - **P1**：一轮收起来之后，过程行上挂着 `hidden="until-found"`；切到另一条会话（轮数相同、
 *   于是轮座位按轮号被复用、行按「会话 + 行身份」整批重挂）后，这些行**仍然**挂着 hidden，
 *   开关行也仍然是收起态。修之前这里会红：新 DOM 上没人补 hidden，收起的一轮整段露出来。
 * - **P2**：整轮**真的**收起的那一拍，里层阶段组自己的展开态要关掉（对齐 dsh 的
 *   `ChatGroupSeat.tsx:168-170`：只有「此刻正在藏」才关，不是「应该收起」就关）。验收：
 *   展开整轮 → 点开一个组 → 收起整轮 → 再展开整轮 → 那个组是关着的。
 * - **P3**：焦点在组里时整轮收起被**放行**（`useSearchableHidden` 的焦点保护），那一组不许
 *   跟着关掉（`fold-seats.tsx:349-353` 的守卫：没挂 hidden、没进收起批次就不关）。验收：
 *   展开整轮 → 点开一个组 → 焦点放到组头 → 点整轮开关 → 整轮仍展开、组仍展开。
 *   中央那段按前缀清存档的逻辑（ui.tsx 旧 `collapsedRounds`）在时会红：它不看焦点，把组关掉。
 *
 * ## 场景怎么造
 *
 * 两条会话（甲 / 乙），每条 2 轮，每轮都含一次工具调用（过程区非空），并且各带一条
 * **模型重试提示**（`notice` 记录 → `model-retry` 行）。为什么专门要这一条：它属于整轮
 * 过程区、却**不进阶段组**，于是它是一条真正挂在段里的独立 `.entry-row`——按「会话 + 行
 * 身份」重挂的正是这种行（组座位按 `step-<轮>-<组序>` 复用，反而是最不容易丢 hidden 的）。
 * 两条会话用同一个工作目录、同一个轮结构，轮座位才能在切会话时被 React 复用。
 *
 * 收起用真实操作完成：点整轮开关行先展开（基线必须是从展开态收起过来的），再点一次收起，
 * 等行上真的出现 `hidden="until-found"`。切会话也走真实路径：点侧栏那条会话。
 *
 * 运行：node desktop/shots/_verify-collapse-remount.mjs
 * 产物：desktop/shots/_collapse-remount.png
 *
 * 前提：`pnpm run build`（要 lib/core/session.js 写种子）与 `pnpm run build:ui` 都跑过。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assert, connectCdp, finish, launchDesktop, makeHome, requireScene, sleep, teardown,
} from './_probe-kit.mjs'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
/** 假端点的端口只写进配置：本探针只重放历史，不发请求，所以不真的起端点。 */
const FAKE_PORT = 18971
const DEBUG_PORT = 9377
const ROUNDS = 2

const home = makeHome({
  shots,
  name: '_verify-collapse-remount-home',
  dirs: ['sessions', 'usage'],
  config: [
    'default:', '  provider: fake', '  model: fake-collapse-remount', 'providers:', '  fake:',
    '    displayName: 自检假端点',
    `    baseURL: http://127.0.0.1:${String(FAKE_PORT)}/v1`,
    '    apiKeyEnv: DSC_FAKE_KEY',
    '    models:', '      - id: fake-collapse-remount', '        name: Fake Collapse Remount',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'),
  // completion：收尾的轮默认收起。基线因此是「本来就收着」，探针再用真实点击把某一轮
  // 展开→收起一遍，让 hidden 由**动画末帧**提交（而不是首帧那条同步路径）。
  settings: { ui: { collapseTiming: 'completion', foldedReplies: 'all', processFold: 'standard' } },
})

// ── 历史种子：必须是宿主自己的 Session 写的（手搓 jsonl 会和宿主的重放口径对不上）──────
process.env.DSC_HOME = home.dsc
process.env.HOME = home.home
process.env.USERPROFILE = home.home
const core = await import('../../lib/core/session.js')
const target = join(home.work, 'probe-target.txt')
writeFileSync(target, '探针样张：这一行只是让 read 调用有东西可读。\n')

/**
 * 造一条会话。
 *
 * @param {string} label 会话标识（甲 / 乙）：首条用户消息带上它，侧栏标题因此可辨。
 * @returns {string} 会话文件路径
 */
function seedSession(label) {
  const session = core.Session.create(home.work)
  for (let round = 0; round < ROUNDS; round += 1) {
    session.appendUser(`${label}会话 第 ${String(round + 1)} 轮：把这一段的边界条件过一遍，别漏了空数组那一条。`)
    session.appendAssistant(
      `第 ${String(round + 1)} 轮先核对入参与返回值。`,
      `思考：${label} 第 ${String(round + 1)} 轮先核对入参与返回值，空数组那种情况最容易漏。\n`,
      [],
    )
    session.appendAssistant(`第 ${String(round + 1)} 轮读一下调用方确认口径。`, '', [
      {
        id: `call_${label}_${String(round)}`,
        name: 'read',
        arguments: JSON.stringify({ path: target }),
      },
    ])
    session.appendTool(`call_${label}_${String(round)}`, 'read', `第 ${String(round + 1)} 轮读到的样张内容（三行）。`)
    // 整轮收起时会藏起来、但不进阶段组的独立过程行（见模块头）：它必须夹在两段过程之间，
    // 才会落在整轮折叠的隐藏集合里（落在最后一段过程之后的行不归整轮管）。
    session.appendNotice({
      kind: 'model-retry',
      attempt: 1,
      maxRetries: 5,
      delayMs: 2000,
      text: `网关返回 502，${label}会话第 ${String(round + 1)} 轮稍后重试`,
    })
    session.appendAssistant(`第二阶段：${label} 第 ${String(round + 1)} 轮再读一次调用方。`, `思考：再确认一遍${label}第 ${String(round + 1)} 轮的口径。`, [
      {
        id: `call_${label}_${String(round)}_b`,
        name: 'read',
        arguments: JSON.stringify({ path: target }),
      },
    ])
    session.appendTool(`call_${label}_${String(round)}_b`, 'read', `第 ${String(round + 1)} 轮第二次读到的样张内容。`)
    session.appendAssistant(`第 ${String(round + 1)} 轮收尾：调用方口径与入参一致，这一轮不用改。`, '', [])
  }
  session.close()
  return session.filePath
}

const sessionA = seedSession('甲')
const sessionB = seedSession('乙')

const desktop = launchDesktop({
  root,
  home: home.home,
  dsc: home.dsc,
  userData: home.userData,
  debugPort: DEBUG_PORT,
  extraEnv: { DSC_RESUME_SESSION: sessionA },
})

let cdp = null
try {
  cdp = await connectCdp({ port: DEBUG_PORT, log: desktop.log, timeoutMs: 60000 })
} catch (error) {
  process.stdout.write(`[probe] 连不上桌面窗口：${String(error)}\n${desktop.log().slice(-1200)}\n`)
  teardown([desktop, home])
  finish('_verify-collapse-remount')
}
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(500)

/**
 * 页面里读一次「每一轮的过程座位」。
 *
 * 座位 = `.turn-process > .turn-process-body` 的**直接子元素**：它们才是整轮收起时由逐行
 * 动画写 `hidden` 的那些元素（`.entry-row` 或 `.step-seat`）。组体自己那一层 hidden 不数
 * 进来（那是阶段组的开合，不是整轮收起）。
 *
 * @returns 每轮一条：轮号、`data-fold`、座位数、其中挂 hidden 的数量、开关行状态。
 */
const SEAT_FACTS = `
  const seatFacts = () => [...document.querySelectorAll('.turn-seat[data-round-seat]')].map((seat) => {
    const segments = [...seat.querySelectorAll('.turn-process')]
    const owners = segments.flatMap((segment) => [...segment.querySelectorAll(':scope > .turn-process-body > *')])
    const toggle = seat.querySelector('.turn-fold')
    return {
      round: seat.getAttribute('data-round-seat'),
      segments: segments.length,
      fold: segments.map((segment) => segment.getAttribute('data-fold')),
      owners: owners.length,
      hidden: owners.filter((owner) => owner.getAttribute('hidden') === 'until-found').length,
      // 只有真盒子才看得见：hidden 缺席 + 有高度才算「露出来了」。
      shown: owners.filter((owner) => owner.getAttribute('hidden') === null && owner.getBoundingClientRect().height > 0).length,
      toggleOpen: toggle === null ? null : toggle.getAttribute('data-open'),
      ariaExpanded: toggle === null ? null : toggle.getAttribute('aria-expanded'),
    }
  })
`

const scene = await requireScene(cdp.evaluate, {
  name: '甲会话打开：两轮都画出来，每轮过程座位非空，侧栏里两条会话都在',
  timeoutMs: 40000,
  script: `
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    for (let i = 0; i < 300; i += 1) {
      const seats = document.querySelectorAll('.turn-seat[data-round-seat]')
      const items = document.querySelectorAll('.sess-item')
      if (document.querySelector('.composer textarea') !== null && seats.length >= 2 && items.length >= 2) break
      await wait(100)
    }
    const seats = [...document.querySelectorAll('.turn-seat[data-round-seat]')]
    const items = [...document.querySelectorAll('.sess-item')]
    ${SEAT_FACTS}
    const facts = seatFacts()
    return {
      ok: seats.length === ${String(ROUNDS)} && items.length === 2
        && facts.every((item) => item.owners >= 1 && item.segments >= 1),
      seats: seats.length,
      sessions: items.map((item) => item.querySelector('.title-text')?.textContent ?? ''),
      facts,
    }
  `,
})
const sceneOk = assert(
  '甲会话打开：两轮都画出来，每轮过程座位非空，侧栏里两条会话都在',
  scene.ok === true,
  `最后读到 ${JSON.stringify(scene.facts).slice(0, 600)}`,
)
if (sceneOk) {
  process.stdout.write(`  场景 ${JSON.stringify(scene.facts)}\n`)
}

if (!scene.ok) {
  teardown([cdp, desktop, home])
  finish('_verify-collapse-remount')
}

/* ────────────────────────── P1：收起态跨会话重挂 ────────────────────────── */

// 先把第一轮展开：基线必须是从「展开态点收起」过来的，hidden 才会由收起动画的末帧提交。
const expanded = await cdp.evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const seat = document.querySelector('.turn-seat[data-round-seat="0"]')
  const btn = seat === null ? null : seat.querySelector('.turn-fold:not([disabled])')
  if (seat === null || btn === null) return { error: '第一轮没有可点的整轮开关' }
  btn.click()
  for (let i = 0; i < 80; i += 1) {
    const segments = [...seat.querySelectorAll('.turn-process')]
    const owners = segments.flatMap((segment) => [...segment.querySelectorAll(':scope > .turn-process-body > *')])
    const shown = owners.filter((owner) => owner.getAttribute('hidden') === null && owner.getBoundingClientRect().height > 0).length
    if (segments.every((segment) => segment.getAttribute('data-fold') === 'open') && owners.length > 0 && shown === owners.length) break
    await wait(50)
  }
  const segments = [...seat.querySelectorAll('.turn-process')]
  const owners = segments.flatMap((segment) => [...segment.querySelectorAll(':scope > .turn-process-body > *')])
  return {
    owners: owners.length,
    shown: owners.filter((owner) => owner.getAttribute('hidden') === null && owner.getBoundingClientRect().height > 0).length,
    fold: segments.map((segment) => segment.getAttribute('data-fold')),
    toggleOpen: btn.getAttribute('data-open'),
  }
`)
process.stdout.write(`  展开第一轮 ${JSON.stringify(expanded)}\n`)

// 再点一次收起，等收起动画真的落地（行上出现 hidden="until-found"）。
const collapsed = await cdp.evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const seat = document.querySelector('.turn-seat[data-round-seat="0"]')
  const btn = seat === null ? null : seat.querySelector('.turn-fold:not([disabled])')
  if (seat === null || btn === null) return { error: '第一轮没有可点的整轮开关' }
  btn.click()
  let last = null
  for (let i = 0; i < 120; i += 1) {
    ${SEAT_FACTS}
    const facts = seatFacts()
    last = facts
    const target = facts.find((item) => item.round === '0')
    if (target !== undefined && target.owners > 0 && target.hidden === target.owners && target.shown === 0) break
    await wait(50)
  }
  ${SEAT_FACTS}
  return { facts: seatFacts(), last }
`)

const beforeSwitch = collapsed.facts ?? []
const targetRound = beforeSwitch.find((item) => item.round === '0')
assert(
  '收起成功：第一轮的过程座位全部挂上 hidden="until-found"（由收起动画末帧提交）',
  targetRound !== undefined && targetRound.owners >= 2 && targetRound.hidden === targetRound.owners && targetRound.shown === 0,
  JSON.stringify(targetRound),
)
assert(
  '收起成功：第一轮的开关行回到收起态（data-open 缺席、aria-expanded=false）',
  targetRound !== undefined && targetRound.toggleOpen === null && targetRound.ariaExpanded === 'false',
  `data-open=${JSON.stringify(targetRound?.toggleOpen)} aria-expanded=${JSON.stringify(targetRound?.ariaExpanded)}`,
)
const baselineOk = assert(
  '基线：切走前每一轮都处于收起态（座位全挂 hidden、开关行收起）',
  beforeSwitch.length === ROUNDS
    && beforeSwitch.every((item) => item.owners >= 2 && item.hidden === item.owners && item.toggleOpen === null),
  JSON.stringify(beforeSwitch),
)
process.stdout.write(`  基线 ${JSON.stringify(beforeSwitch)}\n`)

// 切会话走真实用户路径：点侧栏那条「乙」。
const switched = await cdp.evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const item = [...document.querySelectorAll('.sess-item')].find((row) =>
    (row.querySelector('.title-text')?.textContent ?? '').includes('乙'))
  if (item === undefined) return { error: '侧栏里找不到乙会话' }
  item.click()
  for (let i = 0; i < 300; i += 1) {
    const seats = [...document.querySelectorAll('.turn-seat[data-round-seat]')]
    const first = seats[0]?.querySelector('.entry-user')?.textContent ?? ''
    const ready = seats.length >= ${String(ROUNDS)} && first.includes('乙')
      && seats.every((seat) => seat.querySelectorAll('.turn-process > .turn-process-body > *').length > 0)
    if (ready) break
    await wait(100)
  }
  // 渲染稳定：收起动画、批次收尾、行重挂都在前几百毫秒里落定。
  await wait(600)
  ${SEAT_FACTS}
  const seats = [...document.querySelectorAll('.turn-seat[data-round-seat]')]
  return {
    seats: seats.length,
    first: seats[0]?.querySelector('.entry-user')?.textContent?.slice(0, 24) ?? null,
    facts: seatFacts(),
  }
`)
const afterSwitch = switched.facts ?? []
process.stdout.write(`  切换后 ${JSON.stringify(afterSwitch)}\n`)

assert(
  '切会话真的发生：侧栏点「乙」之后主区换成乙会话的两轮',
  switched.seats === ROUNDS && typeof switched.first === 'string' && switched.first.includes('乙'),
  `seats=${String(switched.seats)} first=${JSON.stringify(switched.first)}`,
)

for (let round = 0; round < ROUNDS; round += 1) {
  const before = beforeSwitch.find((item) => item.round === String(round))
  const after = afterSwitch.find((item) => item.round === String(round))
  assert(
    `第 ${String(round + 1)} 轮：切换后挂 hidden 的过程座位数与基线一致`,
    before !== undefined && after !== undefined && before.owners === after.owners && before.hidden === after.hidden,
    `基线 ${JSON.stringify(before)} / 切换后 ${JSON.stringify(after)}`,
  )
  assert(
    `第 ${String(round + 1)} 轮：切换后没有过程座位露出来（hidden 数 = 座位数）`,
    after !== undefined && after.owners > 0 && after.hidden === after.owners && after.shown === 0,
    JSON.stringify(after),
  )
  assert(
    `第 ${String(round + 1)} 轮：切换后开关行仍然是收起态（data-open 缺席、aria-expanded=false）`,
    after !== undefined && after.toggleOpen === null && after.ariaExpanded === 'false',
    `data-open=${JSON.stringify(after?.toggleOpen)} aria-expanded=${JSON.stringify(after?.ariaExpanded)}`,
  )
}

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(shots, '_collapse-remount.png'), Buffer.from(shot.data, 'base64'))

/* ────────────────────────── P2：收起时关掉里层的组 ────────────────────────── */

// 前置：展开第一轮，点开它里面的阶段组，证明「组开着」。
const groupOpened = await cdp.evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const seat = document.querySelector('.turn-seat[data-round-seat="0"]')
  if (seat === null) return { error: '没有第一轮' }
  const turn = seat.querySelector('.turn-fold:not([disabled])')
  if (turn === null) return { error: '第一轮没有整轮开关' }
  if (turn.getAttribute('data-open') !== '1') turn.click()
  for (let i = 0; i < 80; i += 1) {
    if (seat.querySelector('.turn-process')?.getAttribute('data-fold') === 'open') break
    await wait(50)
  }
  const group = seat.querySelector('.step-fold:not([disabled])')
  if (group === null) return { error: '第一轮里没有阶段组' }
  if (group.getAttribute('data-open') !== '1') group.click()
  for (let i = 0; i < 80; i += 1) {
    const body = seat.querySelector('.step-body')
    if (group.getAttribute('data-open') === '1' && body !== null && !body.hasAttribute('hidden') && body.offsetHeight > 0) break
    await wait(50)
  }
  const body = seat.querySelector('.step-body')
  return {
    roundOpen: turn.getAttribute('data-open'),
    groupOpen: group.getAttribute('data-open'),
    bodyHidden: body === null ? null : body.hasAttribute('hidden'),
    bodyHeight: body === null ? null : Math.round(body.getBoundingClientRect().height),
  }
`)
process.stdout.write(`  展开并点开组 ${JSON.stringify(groupOpened)}\n`)
assert(
  'P2 前置：展开整轮并点开阶段组之后，组体是看得见的',
  groupOpened.groupOpen === '1' && groupOpened.bodyHidden === false && (groupOpened.bodyHeight ?? 0) > 0,
  JSON.stringify(groupOpened),
)

// 收起整轮 → 等收起落地 → 再展开整轮。
const groupAfter = await cdp.evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ${SEAT_FACTS}
  const seat = document.querySelector('.turn-seat[data-round-seat="0"]')
  if (seat === null) return { error: '没有第一轮' }
  const turn = seat.querySelector('.turn-fold:not([disabled])')
  if (turn === null) return { error: '第一轮没有整轮开关' }
  // 焦点必须先挪出组体：点开组那一下组头自己会 focus（step-group-row.tsx 的 onClick），
  // 焦点留在组里时整轮收起会被焦点保护放行、这一轮根本不会藏——P2 要考的是「真的收起」，
  // 所以这里把焦点放到整轮开关上（键盘用户收整轮时的真实位置）。
  turn.focus()
  turn.click()
  let collapsedFacts = null
  for (let i = 0; i < 120; i += 1) {
    collapsedFacts = seatFacts().find((item) => item.round === '0') ?? null
    if (collapsedFacts !== null && collapsedFacts.owners > 0 && collapsedFacts.hidden === collapsedFacts.owners) break
    await wait(50)
  }
  // 再展开整轮：这一步只放行整轮，不许把里面那一组也一并打开。
  turn.click()
  for (let i = 0; i < 80; i += 1) {
    if (seat.querySelector('.turn-process')?.getAttribute('data-fold') === 'open') break
    await wait(50)
  }
  await wait(400)
  const group = seat.querySelector('.step-fold')
  const body = seat.querySelector('.step-body')
  return {
    collapsedFacts,
    roundOpen: turn.getAttribute('data-open'),
    groupOpen: group === null ? null : group.getAttribute('data-open'),
    bodyHidden: body === null ? null : body.hasAttribute('hidden'),
    bodyHeight: body === null ? null : Math.round(body.getBoundingClientRect().height),
    turnFold: seat.querySelector('.turn-process')?.getAttribute('data-fold') ?? null,
  }
`)
process.stdout.write(`  收起再展开后 ${JSON.stringify(groupAfter)}\n`)
assert(
  'P2 前提：整轮真的收起了（收起落地时座位全挂 hidden、开关行收起）',
  groupAfter.collapsedFacts !== null
    && groupAfter.collapsedFacts !== undefined
    && groupAfter.collapsedFacts.owners > 0
    && groupAfter.collapsedFacts.hidden === groupAfter.collapsedFacts.owners
    && groupAfter.collapsedFacts.toggleOpen === null,
  JSON.stringify(groupAfter.collapsedFacts ?? groupAfter),
)
assert(
  'P2：整轮收起之后再把整轮展开，里层的组是关着的（组体挂 hidden、高度 0）',
  groupAfter.groupOpen !== '1' && groupAfter.bodyHidden === true && (groupAfter.bodyHeight ?? -1) === 0,
  JSON.stringify(groupAfter),
)

/* ──────────────────── P3：焦点在组里时整轮收起要放行 ──────────────────── */

/**
 * 焦点保护的验收：焦点落在组头按钮上时点整轮开关收起，这一轮**不能真的藏**（`hidden` 一挂，
 * 键盘用户脚下的地板就没了），于是组级守卫也不该把它关掉。
 *
 * 为什么点用 `.click()` 而不是真鼠标：程序化 click 不搬焦点，焦点仍停在组头——这正是
 * 「键盘用户已经把焦点放进组里」那一刻的位置。真鼠标点在整轮开关上会把焦点搬走，反而
 * 造不出这个场景。
 *
 * 三段读数分开报，红了能看出是前提没成立还是结论错：
 * - `before`：点收起之前——组开着、组体看得见、焦点真的在组头上（前置）；
 * - `released`：点收起之后——整轮仍展开、组的座位没挂 hidden（前提：焦点保护放行了）；
 * - `after`：同一时刻组自己的展开态（结论：组不能被关掉）。
 */
const focusKept = await cdp.evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const seat = document.querySelector('.turn-seat[data-round-seat="0"]')
  if (seat === null) return { error: '没有第一轮' }
  const turn = seat.querySelector('.turn-fold:not([disabled])')
  if (turn === null) return { error: '第一轮没有整轮开关' }
  const group = seat.querySelector('.step-fold:not([disabled])')
  if (group === null) return { error: '第一轮里没有阶段组' }
  const body = seat.querySelector('.step-body')
  // 1. 整轮摊开（P2 结束时它已经是展开的，这里不假定）。
  if (turn.getAttribute('data-open') !== '1') turn.click()
  for (let i = 0; i < 80; i += 1) {
    if (seat.querySelector('.turn-process')?.getAttribute('data-fold') === 'open') break
    await wait(50)
  }
  // 2. 点开那个阶段组。
  if (group.getAttribute('data-open') !== '1') group.click()
  for (let i = 0; i < 80; i += 1) {
    if (group.getAttribute('data-open') === '1'
      && body !== null && !body.hasAttribute('hidden') && body.getBoundingClientRect().height > 0) break
    await wait(50)
  }
  // 3. 键盘位置：焦点落到组头按钮上（组头的 onClick 自己会 focus，这里显式再放一次，
  //    不依赖点击路径；也顺带证明这个按钮真的可聚焦）。
  group.focus()
  const before = {
    turnOpen: turn.getAttribute('data-open'),
    groupOpen: group.getAttribute('data-open'),
    bodyHidden: body === null ? null : body.hasAttribute('hidden'),
    bodyHeight: body === null ? null : Math.round(body.getBoundingClientRect().height),
    focused: document.activeElement === group,
  }
  // 4. 点整轮开关收起：焦点留在组里，交给焦点保护判「这一轮能不能真的藏」。
  turn.click()
  for (let i = 0; i < 100; i += 1) {
    const fold = seat.querySelector('.turn-process')
    const stepSeat = group.closest('.step-seat')
    if (fold?.getAttribute('data-fold') === 'open'
      && turn.getAttribute('data-open') === '1'
      && stepSeat !== null && !stepSeat.hasAttribute('hidden')
      && stepSeat.getBoundingClientRect().height > 0) break
    await wait(50)
  }
  // 5. 让这一拍里的复位逻辑落定（旧实现是 ui.tsx 的 useEffect 按前缀清存档，反应在下一帧）。
  await wait(400)
  const fold = seat.querySelector('.turn-process')
  const stepSeat = group.closest('.step-seat')
  return {
    before,
    released: {
      turnOpen: turn.getAttribute('data-open'),
      turnFold: fold === null ? null : fold.getAttribute('data-fold'),
      seatHidden: stepSeat === null ? null : stepSeat.hasAttribute('hidden'),
      seatHeight: stepSeat === null ? null : Math.round(stepSeat.getBoundingClientRect().height),
      focused: document.activeElement === group,
    },
    after: {
      groupOpen: group.getAttribute('data-open'),
      bodyHidden: body === null ? null : body.hasAttribute('hidden'),
      bodyHeight: body === null ? null : Math.round(body.getBoundingClientRect().height),
    },
  }
`)
process.stdout.write(`  P3 焦点场景 ${JSON.stringify(focusKept)}\n`)

assert(
  'P3 前置：点收起之前整轮展开、组开着、组体看得见、焦点在组头按钮上',
  focusKept.before !== undefined
    && focusKept.before.turnOpen === '1'
    && focusKept.before.groupOpen === '1'
    && focusKept.before.bodyHidden === false
    && (focusKept.before.bodyHeight ?? 0) > 0
    && focusKept.before.focused === true,
  JSON.stringify(focusKept.before ?? focusKept),
)
assert(
  'P3 前提：焦点在组里时点整轮收起，这一轮被放行（整轮仍展开、组的座位没挂 hidden）',
  focusKept.released !== undefined
    && focusKept.released.turnOpen === '1'
    && focusKept.released.turnFold === 'open'
    && focusKept.released.seatHidden === false
    && (focusKept.released.seatHeight ?? 0) > 0
    && focusKept.released.focused === true,
  JSON.stringify(focusKept.released ?? focusKept),
)
assert(
  'P3：整轮收起被焦点保护放行之后，里层那一组仍然是展开的（组体不挂 hidden、高度不为 0）',
  focusKept.after !== undefined
    && focusKept.after.groupOpen === '1'
    && focusKept.after.bodyHidden === false
    && (focusKept.after.bodyHeight ?? 0) > 0,
  JSON.stringify(focusKept.after ?? focusKept),
)

teardown([cdp, desktop, home])
finish('_verify-collapse-remount')
