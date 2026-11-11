process.on('unhandledRejection', () => {})

/**
 * 「整轮收起态在行体重挂之后重新露出来」的真机探针（2026-11-11）。
 *
 * ## 要证的五件事（P1 / P2 / P3 / P4 / P5 分开报账）
 *
 * - **P1**：一轮收起来之后，过程行上挂着 `hidden="until-found"`；切到另一条会话（轮数相同、
 *   于是轮座位按轮号被复用、行按「会话 + 行身份」整批重挂）后，这些行**仍然**挂着 hidden，
 *   开关行也仍然是收起态。修之前这里会红：新 DOM 上没人补 hidden，收起的一轮整段露出来。
 * - **P2**：整轮**真的**收起的那一拍，里层阶段组自己的展开态要关掉（对齐 dsh 的
 *   `ChatGroupSeat.tsx:168-170`：只有「此刻正在藏」才关，不是「应该收起」就关）。验收：
 *   展开整轮 → 点开一个组 → 收起整轮 → 再展开整轮 → 那个组是关着的。
 * - **P3**：焦点在组里时整轮收起被**放行**（`useSearchableHidden` 的焦点保护），那一组不许
 *   跟着关掉（`fold-seats.tsx` 的守卫：没挂 hidden、没进收起批次就不关）。验收：
 *   展开整轮 → 点开一个组 → 焦点放到组头 → 点整轮开关 → 整轮仍展开、组仍展开。
 *   中央那段按前缀清存档的逻辑（ui.tsx 旧 `collapsedRounds`）在时会红：它不看焦点，把组关掉。
 * - **P4**（焦点场景二）：收起**动画跑到一半**再让焦点进来——开始那一拍查不到它。
 *   验收：末帧那一层没挂 `hidden`、焦点还在原处、整轮被放行成展开。
 * - **P5**（行级复位）：展开整轮 → 手动展开一条思考行 → 收起整轮（真的藏）→ 切走再切回
 *   （行整批重挂）→ 再展开整轮 → 那一条行回到默认收起态。整轮收起时没抹行存档的话，
 *   这里会带着手动展开的状态回来。
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
 * - **P6**（兄弟层，2026-11-12 补）：一轮里有**多层**可藏（阶段组 + `model-retry` 独立行 +
 *   后一个阶段组）。收起动画跑到一半，把焦点搬进**文档顺序靠后**的那一层。此时靠前那一层
 *   的 `transitionend` 先到——逐元素判定的旧实现会当场提交它、把这一层里的组关掉，随后靠后
 *   那一层被放行、整轮翻成展开：结果是「整轮展开、组却收起了」。验收：整轮展开，**而且**
 *   靠前那一层的组仍然开着（组体不挂 `hidden`、`data-open` 仍是 `1`），切走再切回也仍然开着
 *   （没有被写进手动存档 false）。修之前这条必红，红的样子就是上面那个组合。
 *
 * - **P7**（不重挂也复位，2026-11-12 补）：整轮收起时行座位抹的是**存档**，同一次挂载里的
 *   行自己还开着——收起整轮再展开，那条思考行照样摊着。参考实现的展开态带「复位代次」，
 *   座位被真藏那一拍推进代次，已挂载的那一条当场收起（`use-disclosure.ts:11-21`）。
 *   验收：展开整轮 → 点开组 → 手动展开一条思考行 → 收起整轮（真的藏）→ **不切会话**、
 *   直接再展开整轮 → 那一条行是收起的；再点开组，它仍然收起。修之前这里会红。
 * - **P8**（放行不写手动存档，2026-11-12 补）：焦点保护放行原来走 `reveal()`，而它等价于
 *   「用户点了展开」，会把整轮写进手动存档——键盘用户 Tab 一次，`collapseTiming` 的兜底
 *   之后就不再生效。验收两段：放行之后整轮开关行上的 `data-turn-manual` 缺席（`fold-state`
 *   里没有这一轮的手动存档）、`data-turn-rescue` 是 1（这一轮是靠放行摊着的）；
 *   把焦点挪开再点一次收起，照常收起。
 *
 * - **P9**（放行不跨会话残留，2026-11-12 补）：座位按**轮号**做 React key（`ui.tsx:747`），
 *   切会话时座位不重挂，放行的状态（`rescued`）原来只由 `toggleTurn` 清空，于是「动画中途
 *   焦点 Tab 进某一轮 → 切到另一条会话 → 切回来」之后，那一轮带着 `data-turn-rescue="1"`
 *   重新摊开，而存档与兜底都说该收起。验收两段：放行成立（前提：`data-turn-rescue` 是 1）
 *   → 切走再切回 → 这一轮不是靠放行摊着的（`data-turn-rescue` 缺席）、存档里没有手动展开
 *   （`data-turn-manual` 缺席）、状态与存档 / 兜底一致（折面 closed、开关行收起、座位全挂
 *   hidden）。修之前结论那条必红（实测切回后 rescue=1、fold=open、hidden=0/3）。
 *
 * ## 断言数（以实际运行输出为准）
 *
 * 跑下来 **37 条**：P1～P6 与行级复位共 29 条（`assert` 调用点 25 处，其中 3 处在
 * `ROUNDS` 轮循环里各跑两次，加 `requireScene` 记的 1 条场景断言），再加 P7 的 3 条、
 * P8 的 3 条与 P9 的 2 条。文档与提交信息都照这个数写，别再按「`assert` 出现几次」或
 * 「设计了几条」另算一套。
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

/* ───────────── P4：收起动画跑到一半，键盘焦点 Tab 进来 ───────────── */

/**
 * 焦点场景二：收起**已经开始跑**之后（动画没跑完）把焦点移进某一行。
 *
 * 为什么单独要这一条：开始收起那一拍的焦点检查看不到它——那一刻焦点还在整轮开关上。
 * 末帧 `display: none` 一旦落到后来进来的焦点元素上，焦点就掉回 body；末帧的焦点复检
 * 就是为这一拍加的（`fold-motion.ts` 的 `releaseForFocus`）。验收三段：
 * 前提（动画中途焦点真的搬进来了）→ 末帧那一行**没有**被挂 `hidden` → 焦点还在原处，
 * 并且整轮被放行成展开。
 */
const midFlight = await cdp.evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const seat = document.querySelector('.turn-seat[data-round-seat="0"]')
  if (seat === null) return { error: '没有第一轮' }
  const turn = seat.querySelector('.turn-fold:not([disabled])')
  if (turn === null) return { error: '第一轮没有整轮开关' }
  // 1. 基线：整轮摊开；焦点放在整轮开关上——开始收起那一拍的焦点检查因此不会放行。
  if (turn.getAttribute('data-open') !== '1') turn.click()
  for (let i = 0; i < 80; i += 1) {
    if (seat.querySelector('.turn-process')?.getAttribute('data-fold') === 'open') break
    await wait(50)
  }
  const head = seat.querySelector('.step-seat .think-head')
  if (head === null) return { error: '第一轮里找不到可聚焦的思考行头' }
  const owner = head.closest('.step-seat')
  turn.focus()
  turn.click()
  // 2. 等收起批次真的开跑（约 60ms：高度过渡的延迟段刚开始），再把焦点搬进这一行。
  await wait(60)
  const during = {
    fold: seat.querySelector('.turn-process')?.getAttribute('data-fold') ?? null,
    ownerHeight: owner === null ? null : Math.round(owner.getBoundingClientRect().height),
  }
  head.focus()
  const focusedNow = document.activeElement === head
  // 3. 等收起跑完（过渡 + 提交余量 + 超时兜底都在 700ms 之内）。
  await wait(700)
  return {
    during,
    focusedNow,
    after: {
      fold: seat.querySelector('.turn-process')?.getAttribute('data-fold') ?? null,
      turnOpen: turn.getAttribute('data-open'),
      ownerHidden: owner === null ? null : owner.hasAttribute('hidden'),
      ownerHeight: owner === null ? null : Math.round(owner.getBoundingClientRect().height),
      focused: document.activeElement === head,
      activeTag: document.activeElement === null ? null : document.activeElement.tagName,
      groupOpen: seat.querySelector('.step-fold')?.getAttribute('data-open') ?? null,
    },
  }
`)
process.stdout.write(`  P4 动画中途焦点 ${JSON.stringify(midFlight)}\n`)

assert(
  'P4 前提：收起动画跑到一半时焦点搬进了这一行的思考头（此刻整轮已进入收起）',
  midFlight.during !== undefined
    && midFlight.during.fold === 'closed'
    && (midFlight.during.ownerHeight ?? 0) > 0
    && midFlight.focusedNow === true,
  JSON.stringify({ during: midFlight.during, focusedNow: midFlight.focusedNow }),
)
assert(
  'P4：末帧没有把带焦点的那一层挂上 hidden（`display:none` 没落到焦点元素上）',
  midFlight.after !== undefined
    && midFlight.after.ownerHidden === false
    && (midFlight.after.ownerHeight ?? 0) > 0,
  JSON.stringify(midFlight.after ?? midFlight),
)
assert(
  'P4：焦点还停在原来那个思考头上（没有掉回 body）',
  midFlight.after !== undefined && midFlight.after.focused === true,
  JSON.stringify(midFlight.after ?? midFlight),
)
assert(
  'P4：这一轮被末帧复检放行成展开（开关行与 data-fold 都是展开，组也没被顺带关掉）',
  midFlight.after !== undefined
    && midFlight.after.turnOpen === '1'
    && midFlight.after.fold === 'open'
    && midFlight.after.groupOpen === '1',
  JSON.stringify(midFlight.after ?? midFlight),
)

/* ───────── P6：同批多层时，焦点落在靠后那一层，靠前的组不许被关 ───────── */

/**
 * 焦点场景三（2026-11-12 补，缺陷：同批兄弟层的顺序依赖）。
 *
 * 这一轮里有**三层**可藏：前一个阶段组、`model-retry` 独立行、后一个阶段组（见模块头「场景
 * 怎么造」）。焦点放在整轮开关上点收起，60ms 后搬进**文档顺序最后**的那一层。
 *
 * 旧实现逐元素判定「提交还是放行」：靠前那一层的 `transitionend` 先到 → 它当场提交
 * `hidden` → `StepGroupSeat` 的 `turnHidden` 把这一组关掉并写进存档；紧接着靠后那一层被
 * 热点放行 → 整轮翻成展开。于是「整轮展开、靠前的组却收起了」，存档里还留着 false。
 *
 * 修法是把判定提到批次级：元素收完只记账，整批收工时统一判一次。所以验收三段：
 * 整轮最后是展开的 → 靠前那一层的组还是开的（组体不挂 `hidden`、`data-open` 仍是 1）→
 * 切走再切回（组按存档重挂）它仍然是开的（没有把 false 写进手动存档）。
 */
const siblingLayers = await cdp.evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const sessionTitle = () => document.querySelector('.turn-seat[data-round-seat]')?.querySelector('.entry-user')?.textContent ?? ''
  let seat = document.querySelector('.turn-seat[data-round-seat="0"]')
  if (seat === null) return { error: '没有第一轮' }
  let turn = seat.querySelector('.turn-fold:not([disabled])')
  if (turn === null) return { error: '第一轮没有整轮开关' }
  const owners = () => [...seat.querySelectorAll('.turn-process > .turn-process-body > *')]
  const groups = () => [...seat.querySelectorAll('.step-seat')]
  const firstBody = () => {
    const first = groups()[0]
    return first === undefined ? null : first.querySelector('.step-body')
  }
  // 1. 基线：整轮摊开，且**靠前那个阶段组是点开的**（没点开就分不清「被关掉」与「本来关着」）。
  if (turn.getAttribute('data-open') !== '1') turn.click()
  for (let i = 0; i < 80; i += 1) {
    if (seat.querySelector('.turn-process')?.getAttribute('data-fold') === 'open') break
    await wait(50)
  }
  const group = seat.querySelector('.step-fold:not([disabled])')
  if (group === null) return { error: '第一轮里没有阶段组' }
  if (group.getAttribute('data-open') !== '1') group.click()
  for (let i = 0; i < 80; i += 1) {
    const body = firstBody()
    if (group.getAttribute('data-open') === '1' && body !== null && !body.hasAttribute('hidden')
      && body.getBoundingClientRect().height > 0) break
    await wait(50)
  }
  const before = {
    owners: owners().length,
    groups: groups().length,
    firstGroupOpen: groups()[0]?.querySelector('.step-fold')?.getAttribute('data-open') ?? null,
    bodyHidden: firstBody() === null ? null : firstBody().hasAttribute('hidden'),
    bodyHeight: firstBody() === null ? null : Math.round(firstBody().getBoundingClientRect().height),
  }
  // 2. 焦点先放在整轮开关上（开始收起那一拍的焦点检查因此不会放行），点收起。
  turn.focus()
  turn.click()
  // 3. 等批次真的开跑，再把焦点搬进**文档顺序最后**的那一层。
  await wait(60)
  const all = owners()
  const laterIndex = all.length - 1
  const later = all[laterIndex] ?? null
  const focusTarget = later === null
    ? null
    : (later.querySelector('.step-fold:not([disabled])') ?? later.querySelector('.think-head'))
  if (focusTarget === null) return { error: '靠后那一层里没有可聚焦的控件', before, owners: all.length }
  const during = {
    fold: seat.querySelector('.turn-process')?.getAttribute('data-fold') ?? null,
    owners: all.length,
    laterIndex,
    laterTag: later.tagName,
    laterClass: later.className,
    focusMoved: false,
  }
  focusTarget.focus()
  during.focusMoved = document.activeElement === focusTarget
  // 4. 等收起跑完（过渡 + 提交余量 + 超时兜底都在 700ms 之内）。
  await wait(700)
  const after = {
    fold: seat.querySelector('.turn-process')?.getAttribute('data-fold') ?? null,
    turnOpen: turn.getAttribute('data-open'),
    firstGroupOpen: groups()[0]?.querySelector('.step-fold')?.getAttribute('data-open') ?? null,
    bodyHidden: firstBody() === null ? null : firstBody().hasAttribute('hidden'),
    bodyHeight: firstBody() === null ? null : Math.round(firstBody().getBoundingClientRect().height),
    focused: document.activeElement === focusTarget,
    activeTag: document.activeElement === null ? null : document.activeElement.tagName,
  }
  // 5. 存档复核：切走再切回，靠前那一组若被写进手动存档 false，就再也回不到展开。
  const away = [...document.querySelectorAll('.sess-item')].find((row) =>
    (row.querySelector('.title-text')?.textContent ?? '').includes('甲'))
  if (away === undefined) return { before, during, after, error: '侧栏里找不到甲会话' }
  away.click()
  for (let i = 0; i < 300; i += 1) {
    if (sessionTitle().includes('甲')) break
    await wait(100)
  }
  await wait(300)
  const back = [...document.querySelectorAll('.sess-item')].find((row) =>
    (row.querySelector('.title-text')?.textContent ?? '').includes('乙'))
  if (back === undefined) return { before, during, after, error: '侧栏里找不到乙会话' }
  back.click()
  for (let i = 0; i < 300; i += 1) {
    if (sessionTitle().includes('乙')) break
    await wait(100)
  }
  await wait(500)
  seat = document.querySelector('.turn-seat[data-round-seat="0"]')
  if (seat === null) return { before, during, after, error: '切回之后没有第一轮' }
  return {
    before,
    during,
    after,
    remount: {
      turnOpen: seat.querySelector('.turn-fold:not([disabled])')?.getAttribute('data-open') ?? null,
      firstGroupOpen: groups()[0]?.querySelector('.step-fold')?.getAttribute('data-open') ?? null,
      bodyHidden: firstBody() === null ? null : firstBody().hasAttribute('hidden'),
    },
  }
`)
process.stdout.write(`  P6 兄弟层 ${JSON.stringify(siblingLayers)}\n`)

assert(
  'P6 前置：第一轮里至少有 2 层可藏（阶段组 + 组外独立行），且靠前那个组是点开的、组体看得见',
  siblingLayers.before !== undefined
    && (siblingLayers.before.owners ?? 0) >= 2
    && siblingLayers.before.firstGroupOpen === '1'
    && siblingLayers.before.bodyHidden === false
    && (siblingLayers.before.bodyHeight ?? 0) > 0,
  JSON.stringify(siblingLayers.before ?? siblingLayers),
)
assert(
  'P6 前提：收起动画跑到一半时焦点搬进了文档顺序靠后的那一层（只剩靠前那层的 transitionend 会先到）',
  siblingLayers.during !== undefined
    && siblingLayers.during.fold === 'closed'
    && siblingLayers.during.focusMoved === true
    && siblingLayers.during.laterIndex > 0,
  JSON.stringify(siblingLayers.during ?? siblingLayers),
)
assert(
  'P6：这一轮最后是展开的（靠后那一层被放行，整轮跟着翻成展开）',
  siblingLayers.after !== undefined
    && siblingLayers.after.turnOpen === '1'
    && siblingLayers.after.fold === 'open',
  JSON.stringify(siblingLayers.after ?? siblingLayers),
)
assert(
  'P6：靠前那一层的组没有被关掉（组体不挂 hidden、高度不为 0、data-open 仍是 1）',
  siblingLayers.after !== undefined
    && siblingLayers.after.firstGroupOpen === '1'
    && siblingLayers.after.bodyHidden === false
    && (siblingLayers.after.bodyHeight ?? 0) > 0,
  JSON.stringify(siblingLayers.after ?? siblingLayers),
)
assert(
  'P6：切走再切回之后靠前那一组仍然展开（没有被写进手动存档 false）',
  siblingLayers.remount !== undefined
    && siblingLayers.remount.firstGroupOpen === '1'
    && siblingLayers.remount.bodyHidden === false,
  JSON.stringify(siblingLayers.remount ?? siblingLayers),
)

/* ───────── 行级复位：整轮收起时抹掉行自己的展开存档（切走再切回） ───────── */

/**
 * 缺陷二的验收：整轮收起**真的藏了**这一行那一拍，行自己的展开存档要抹掉。
 *
 * 为什么要切走再切回：行的展开态活在行体自己的 state 里，收起 / 展开整轮不重挂行体，
 * 同一份 DOM 上的行当然还开着——那不是缺陷。缺陷的现场是行按「会话 + 行身份」整批
 * **重挂**：重挂时行体会从存档读回展开态，存档没抹就带着收起之前手动点开的状态回来。
 * 所以步骤是：展开整轮 → 手动展开一条思考行 → 收起整轮（真的藏）→ 切走再切回（重挂）
 * → 再展开整轮 → 那一条行必须回到默认收起态。
 */
const rowReset = await cdp.evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const seatOf = () => document.querySelector('.turn-seat[data-round-seat="0"]')
  let seat = seatOf()
  if (seat === null) return { error: '没有第一轮' }
  let turn = seat.querySelector('.turn-fold:not([disabled])')
  if (turn === null) return { error: '第一轮没有整轮开关' }
  // 1. 整轮摊开。
  if (turn.getAttribute('data-open') !== '1') turn.click()
  for (let i = 0; i < 80; i += 1) {
    if (seat.querySelector('.turn-process')?.getAttribute('data-fold') === 'open') break
    await wait(50)
  }
  // 2. 点开阶段组（思考行在组里；组体收起时内容仍在文档里，但走真实点击路径）。
  const group = seat.querySelector('.step-fold:not([disabled])')
  if (group === null) return { error: '第一轮里没有阶段组' }
  if (group.getAttribute('data-open') !== '1') group.click()
  await wait(250)
  // 3. 手动展开组里的一条思考行。
  const head = seat.querySelector('.entry-row .think-head')
  if (head === null) return { error: '第一轮里找不到思考行的头' }
  if (head.getAttribute('aria-expanded') !== 'true') head.click()
  await wait(150)
  const opened = head.getAttribute('aria-expanded')
  // 4. 焦点放到整轮开关上，收起整轮（不走焦点放行，这一轮真的会藏）。
  turn.focus()
  turn.click()
  let hiddenAt = false
  for (let i = 0; i < 120; i += 1) {
    const owners = [...seat.querySelectorAll('.turn-process > .turn-process-body > *')]
    if (owners.length > 0 && owners.every((owner) => owner.hasAttribute('hidden'))) {
      hiddenAt = true
      break
    }
    await wait(50)
  }
  // 5. 切走再切回：行按「会话 + 行身份」整批重挂，这才是缺陷的现场（当前在乙会话）。
  const away = [...document.querySelectorAll('.sess-item')].find((row) =>
    (row.querySelector('.title-text')?.textContent ?? '').includes('甲'))
  if (away === undefined) return { error: '侧栏里找不到甲会话' }
  away.click()
  for (let i = 0; i < 300; i += 1) {
    const first = document.querySelector('.turn-seat[data-round-seat]')?.querySelector('.entry-user')?.textContent ?? ''
    if (first.includes('甲')) break
    await wait(100)
  }
  await wait(300)
  const back = [...document.querySelectorAll('.sess-item')].find((row) =>
    (row.querySelector('.title-text')?.textContent ?? '').includes('乙'))
  if (back === undefined) return { error: '侧栏里找不到乙会话' }
  back.click()
  for (let i = 0; i < 300; i += 1) {
    const first = document.querySelector('.turn-seat[data-round-seat]')?.querySelector('.entry-user')?.textContent ?? ''
    if (first.includes('乙')) break
    await wait(100)
  }
  await wait(400)
  // 6. 再展开整轮，看那一条行回到默认收起态没有。
  seat = seatOf()
  turn = seat.querySelector('.turn-fold:not([disabled])')
  if (turn === null) return { error: '切回之后第一轮没有整轮开关' }
  if (turn.getAttribute('data-open') !== '1') turn.click()
  for (let i = 0; i < 80; i += 1) {
    if (seat.querySelector('.turn-process')?.getAttribute('data-fold') === 'open') break
    await wait(50)
  }
  await wait(250)
  const after = seat.querySelector('.entry-row .think-head')
  return {
    hiddenAt,
    opened,
    after: {
      expanded: after === null ? null : after.getAttribute('aria-expanded'),
      text: after === null ? null : (after.textContent ?? '').slice(0, 12),
    },
  }
`)
process.stdout.write(`  行级复位 ${JSON.stringify(rowReset)}\n`)

assert(
  '行级复位前提：手动展开的那条思考行当时是开着的，且整轮收起真的落地（座位全挂 hidden）',
  rowReset.opened === 'true' && rowReset.hiddenAt === true,
  JSON.stringify({ opened: rowReset.opened, hiddenAt: rowReset.hiddenAt, error: rowReset.error }),
)
assert(
  '行级复位：切走再切回、再展开整轮之后，那一条思考行回到默认收起态（存档已抹掉）',
  rowReset.after !== undefined && rowReset.after.expanded === 'false',
  JSON.stringify(rowReset.after ?? rowReset),
)

/* ────── P7：不重挂也复位（复位代次，2026-11-12）────────── */

/**
 * 缺陷：整轮收起时行座位把**存档**抹了，可同一次挂载里的行自己还开着——收起整轮再展开，
 * 那条思考行照样摊在屏幕上；只有切走再切回（重挂）才回默认收起态。参考实现不是这样：
 * 它的展开态带一个「复位代次」，座位被真藏那一拍推进代次，**已挂载的**那一条当场收起
 * （`use-disclosure.ts:11-21`）。
 *
 * 修法见 `fold-hook.ts` 模块头「复位代次」：座位实例持有一份代次，真挂上 `hidden` 那一拍
 * 推进一位；行用 `useSyncExternalStore` 订阅，代次推进只惊动订阅了它的那几行。
 *
 * 验收：展开整轮 → 点开组 → 手动展开其中一条思考行 → 收起整轮（真的藏）→ **不切会话**、
 * 直接把整轮再展开 → 那一条行必须是收起的；再点开那个组，它仍然是收起的（可见时也对）。
 */
const mountedReset = await cdp.evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const seatOf = () => document.querySelector('.turn-seat[data-round-seat="0"]')
  const seat = seatOf()
  if (seat === null) return { error: '没有第一轮' }
  const turn = seat.querySelector('.turn-fold:not([disabled])')
  if (turn === null) return { error: '第一轮没有整轮开关' }
  const groupOf = () => seat.querySelector('.step-fold:not([disabled])')
  const headOf = () => seat.querySelector('.step-seat .think-head')
  const ownersOf = () => [...seat.querySelectorAll('.turn-process > .turn-process-body > *')]
  // 1. 整轮摊开。
  if (turn.getAttribute('data-open') !== '1') turn.click()
  for (let i = 0; i < 80; i += 1) {
    if (seat.querySelector('.turn-process')?.getAttribute('data-fold') === 'open') break
    await wait(50)
  }
  // 2. 点开阶段组（思考行在组里）。
  const group = groupOf()
  if (group === null) return { error: '第一轮里没有阶段组' }
  if (group.getAttribute('data-open') !== '1') group.click()
  await wait(250)
  // 3. 手动展开组里的一条思考行。
  const head = headOf()
  if (head === null) return { error: '第一轮里找不到思考行的头' }
  if (head.getAttribute('aria-expanded') !== 'true') head.click()
  await wait(150)
  const opened = head.getAttribute('aria-expanded')
  // 4. 焦点放在整轮开关上，收起整轮（不走焦点放行，这一轮真的会藏）。
  turn.focus()
  turn.click()
  let hiddenAt = false
  for (let i = 0; i < 120; i += 1) {
    const owners = ownersOf()
    if (owners.length > 0 && owners.every((owner) => owner.hasAttribute('hidden'))) {
      hiddenAt = true
      break
    }
    await wait(50)
  }
  // 5. **不切会话**，直接把整轮再展开，看那一条行有没有当场回到默认收起态。
  if (turn.getAttribute('data-open') === '1') return { error: '收起没有落地，开关仍展开', opened, hiddenAt }
  turn.click()
  for (let i = 0; i < 80; i += 1) {
    if (seat.querySelector('.turn-process')?.getAttribute('data-fold') === 'open') break
    await wait(50)
  }
  await wait(250)
  const justReopened = {
    turnOpen: turn.getAttribute('data-open'),
    expanded: headOf() === null ? null : headOf().getAttribute('aria-expanded'),
    groupOpen: groupOf() === null ? null : groupOf().getAttribute('data-open'),
  }
  // 6. 再把组点开：这一条行真的看得见的时候，它也得是收起的。
  const groupAgain = groupOf()
  if (groupAgain !== null && groupAgain.getAttribute('data-open') !== '1') groupAgain.click()
  await wait(300)
  const visibleAgain = {
    groupOpen: groupOf() === null ? null : groupOf().getAttribute('data-open'),
    expanded: headOf() === null ? null : headOf().getAttribute('aria-expanded'),
    // 收起态的那条行**不渲染**展开区（think-row 的条件渲染），所以这里判「展开区在不在」。
    bodyPresent: (() => {
      const block = headOf() === null ? null : headOf().closest('.think-block')
      return block === null ? null : block.querySelector('.think-body') !== null
    })(),
  }
  return { opened, hiddenAt, justReopened, visibleAgain }
`)
process.stdout.write(`  不重挂复位 ${JSON.stringify(mountedReset)}\n`)

assert(
  'P7 前提：手动展开的那条思考行当时是开着的，且整轮收起真的落地（座位全挂 hidden）',
  mountedReset.opened === 'true' && mountedReset.hiddenAt === true,
  JSON.stringify({ opened: mountedReset.opened, hiddenAt: mountedReset.hiddenAt, error: mountedReset.error }),
)
assert(
  'P7：不切会话、整轮收起再展开之后，那条思考行当场回到默认收起态（复位代次推进了）',
  mountedReset.justReopened !== undefined
    && mountedReset.justReopened.turnOpen === '1'
    && mountedReset.justReopened.expanded === 'false',
  JSON.stringify(mountedReset.justReopened ?? mountedReset),
)
assert(
  'P7：再把阶段组点开，那一条思考行仍然是收起的（看得见的那一态也对）',
  mountedReset.visibleAgain !== undefined
    && mountedReset.visibleAgain.groupOpen === '1'
    && mountedReset.visibleAgain.expanded === 'false'
    && mountedReset.visibleAgain.bodyPresent === false,
  JSON.stringify(mountedReset.visibleAgain ?? mountedReset),
)

/* ────── P8：焦点放行不写手动存档（2026-11-12）────────── */

/**
 * 缺陷：焦点保护放行时走 `reveal()`，而它等价于「用户点了展开」——把整轮写进手动存档。
 * 键盘用户中途 Tab 一次，`collapseTiming` 的兜底之后就不再生效（切走再切回那一轮也还是开着的）。
 *
 * 修法见 `render.tsx` 的 `revealAction`：放行只在**这一份内存**里把这一轮摊着（记的是
 * 「哪一条会话的哪一轮」），用户点击才写存档；用户自己点开关、换会话，这份放行就作废。
 *
 * 验收看的是**存档本身**（`render.tsx` 给整轮开关行留的两个读数）：
 * - `data-turn-manual`：这一轮的键在 `fold-state` 里有没有用户手动存档（`hasFold`）；
 * - `data-turn-rescue`：这一轮此刻是不是靠焦点放行摊着的。
 *
 * 三段：
 * - **P8 前提**：焦点在组里点收起 → 被放行（整轮仍展开、组没被关、`data-turn-rescue` 是 1）。
 * - **P8 结论**：同一时刻 `data-turn-manual` 缺席 —— 放行**没有**被写成手动存档。
 *   修之前这里会红：`reveal()` 调的是 `foldMemory.set(turnKey, true)`，那一格就是手动存档。
 * - **P8b**：放行之后把焦点挪到整轮开关（离开组里）再点一次收起，这一轮照常收起
 *   （放行没有把这一轮钉死在展开上）。
 */
const releaseNoArchive = await cdp.evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const seatOf = () => document.querySelector('.turn-seat[data-round-seat="0"]')
  let seat = seatOf()
  if (seat === null) return { error: '没有第一轮' }
  let turn = seat.querySelector('.turn-fold:not([disabled])')
  if (turn === null) return { error: '第一轮没有整轮开关' }
  const groupOf = () => seat.querySelector('.step-fold:not([disabled])')
  /** 这一轮开关行上的三个读数（见模块头 P8 那段）。 */
  const readOut = () => {
    const row = turn === null ? null : turn.closest('.entry-row')
    const owners = [...seat.querySelectorAll('.turn-process > .turn-process-body > *')]
    return {
      turnOpen: turn === null ? null : turn.getAttribute('data-open'),
      rescue: row === null ? null : row.getAttribute('data-turn-rescue'),
      manual: row === null ? null : row.getAttribute('data-turn-manual'),
      fold: seat.querySelector('.turn-process')?.getAttribute('data-fold') ?? null,
      owners: owners.length,
      hidden: owners.filter((owner) => owner.hasAttribute('hidden')).length,
    }
  }
  // 1. 整轮摊开 + 点开组（焦点保护才有「焦点在里面」这一层可护）。
  if (turn.getAttribute('data-open') !== '1') turn.click()
  for (let i = 0; i < 80; i += 1) {
    if (seat.querySelector('.turn-process')?.getAttribute('data-fold') === 'open') break
    await wait(50)
  }
  let group = groupOf()
  if (group === null) return { error: '第一轮里没有阶段组' }
  if (group.getAttribute('data-open') !== '1') group.click()
  for (let i = 0; i < 80; i += 1) {
    const body = seat.querySelector('.step-body')
    if (group.getAttribute('data-open') === '1' && body !== null && !body.hasAttribute('hidden')) break
    await wait(50)
  }
  // 2. 焦点放进组里，程序化点整轮开关：焦点没被搬走，这一轮会被焦点保护放行。
  group.focus()
  const before = {
    turnOpen: turn.getAttribute('data-open'),
    groupOpen: group.getAttribute('data-open'),
    focused: document.activeElement === group,
  }
  turn.click()
  for (let i = 0; i < 100; i += 1) {
    const fold = seat.querySelector('.turn-process')
    const stepSeat = group.closest('.step-seat')
    if (fold?.getAttribute('data-fold') === 'open'
      && turn.getAttribute('data-open') === '1'
      && stepSeat !== null && !stepSeat.hasAttribute('hidden')) break
    await wait(50)
  }
  await wait(400)
  const foldRow = seat.querySelector('.turn-process')
  const stepSeat = group.closest('.step-seat')
  const released = {
    turnOpen: turn.getAttribute('data-open'),
    turnFold: foldRow === null ? null : foldRow.getAttribute('data-fold'),
    seatHidden: stepSeat === null ? null : stepSeat.hasAttribute('hidden'),
    groupOpen: group.getAttribute('data-open'),
  }
  // 3. 读数：这一轮此刻靠「放行」摊着，存档里没有「手动展开」那一笔。
  const afterRelease = readOut()
  return { before, released, afterRelease }
`)
process.stdout.write(`  放行不写存档 ${JSON.stringify(releaseNoArchive)}\n`)

assert(
  'P8 前提：焦点在组里时点整轮收起，这一轮被焦点保护放行了（整轮仍展开、组的座位没挂 hidden，读数是「放行」）',
  releaseNoArchive.before !== undefined
    && releaseNoArchive.before.turnOpen === '1'
    && releaseNoArchive.before.focused === true
    && releaseNoArchive.released !== undefined
    && releaseNoArchive.released.turnOpen === '1'
    && releaseNoArchive.released.turnFold === 'open'
    && releaseNoArchive.released.seatHidden === false
    && releaseNoArchive.afterRelease !== undefined
    && releaseNoArchive.afterRelease.rescue === '1',
  JSON.stringify({ before: releaseNoArchive.before, released: releaseNoArchive.released, afterRelease: releaseNoArchive.afterRelease, error: releaseNoArchive.error }),
)
assert(
  'P8：放行没有把这一轮写成手动存档（`data-turn-manual` 缺席，`fold-state` 里没有手动展开）',
  releaseNoArchive.afterRelease !== undefined
    && releaseNoArchive.afterRelease.turnOpen === '1'
    && releaseNoArchive.afterRelease.manual === null,
  JSON.stringify(releaseNoArchive.afterRelease ?? releaseNoArchive),
)

/* ────── P8b：放行之后把焦点挪开，再点一次收起要照常收起 ────── */

/**
 * 放行只让这一层**这次**不藏：焦点离开之后（这里放到整轮开关上）再点一次收起，
 * 必须真的收起来。这条钉的是「放行没有把这一轮钉死在展开上」——只留一份失忆的本地
 * 放行态、却忘了在用户点击时把它作废，就会在这儿红。
 */
const releaseThenCollapse = await cdp.evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const seat = document.querySelector('.turn-seat[data-round-seat="0"]')
  if (seat === null) return { error: '没有第一轮' }
  const turn = seat.querySelector('.turn-fold:not([disabled])')
  if (turn === null) return { error: '第一轮没有整轮开关' }
  const group = seat.querySelector('.step-fold:not([disabled])')
  if (group === null) return { error: '第一轮里没有阶段组' }
  const ownersOf = () => [...seat.querySelectorAll('.turn-process > .turn-process-body > *')]
  // 1. 整轮摊开 + 点开组。
  if (turn.getAttribute('data-open') !== '1') turn.click()
  for (let i = 0; i < 80; i += 1) {
    if (seat.querySelector('.turn-process')?.getAttribute('data-fold') === 'open') break
    await wait(50)
  }
  if (group.getAttribute('data-open') !== '1') group.click()
  await wait(250)
  // 2. 焦点在组里 → 点收起 → 被放行。
  group.focus()
  turn.click()
  for (let i = 0; i < 100; i += 1) {
    if (seat.querySelector('.turn-process')?.getAttribute('data-fold') === 'open'
      && turn.getAttribute('data-open') === '1') break
    await wait(50)
  }
  await wait(400)
  const released = { turnOpen: turn.getAttribute('data-open'), focused: document.activeElement === group }
  // 3. 焦点挪到整轮开关上（离开里层），再点一次收起：这次要真的收。
  turn.focus()
  turn.click()
  let collapsed = null
  for (let i = 0; i < 120; i += 1) {
    const owners = ownersOf()
    if (owners.length > 0 && owners.every((owner) => owner.hasAttribute('hidden'))) {
      collapsed = {
        owners: owners.length,
        hidden: owners.filter((owner) => owner.hasAttribute('hidden')).length,
        turnOpen: turn.getAttribute('data-open'),
        fold: seat.querySelector('.turn-process')?.getAttribute('data-fold') ?? null,
      }
      break
    }
    await wait(50)
  }
  await wait(200)
  return {
    released,
    collapsed: collapsed ?? {
      owners: ownersOf().length,
      hidden: ownersOf().filter((owner) => owner.hasAttribute('hidden')).length,
      turnOpen: turn.getAttribute('data-open'),
      fold: seat.querySelector('.turn-process')?.getAttribute('data-fold') ?? null,
    },
  }
`)
process.stdout.write(`  放行后再收起 ${JSON.stringify(releaseThenCollapse)}\n`)

assert(
  'P8b：放行之后把焦点移开、再点一次收起，这一轮照常收起（放行只让这一层这次不藏）',
  releaseThenCollapse.released !== undefined
    && releaseThenCollapse.released.turnOpen === '1'
    && releaseThenCollapse.collapsed !== undefined
    && releaseThenCollapse.collapsed.owners > 0
    && releaseThenCollapse.collapsed.hidden === releaseThenCollapse.collapsed.owners
    && releaseThenCollapse.collapsed.turnOpen === null
    && releaseThenCollapse.collapsed.fold === 'closed',
  JSON.stringify(releaseThenCollapse),
)

/* ────── P9：放行不跨会话残留（2026-11-12）────────── */

/**
 * 缺陷：`rescued` 只活在这份座位实例里，而座位按**轮号**做 React key（`ui.tsx:747` 的
 * `key={seat.round}`）——切会话时座位不重挂。放行记的键 `会话|轮号` 在切走时对不上、
 * 切回来又对上了（`render.tsx` 原来的 `rescued === rescueKey`），于是那一轮带着
 * `data-turn-rescue="1"` 重新摊开，而存档（这一轮是手动收起）与兜底（`completion` 档 =
 * 收起）都说该收起。修法见 `render.tsx` 的 `rescueKeyRef`：键一变就当场把放行清掉。
 *
 * 验收两段（切会话都走真实用户路径：点侧栏那条会话）：
 * - **P9 前提**：收起动画跑到一半把焦点 Tab 进这一轮 → 被末帧复检放行（`data-turn-rescue`
 *   是 1、整轮展开）；
 * - **P9 结论**：切到另一条会话再切回来 → 这一轮**不是**靠放行摊着的（`data-turn-rescue`
 *   缺席）、存档里没有手动展开（`data-turn-manual` 缺席）、状态与存档 / 兜底一致
 *   （折面 closed、开关行收起、过程座位全挂 hidden）。
 */
const crossSessionRescue = await cdp.evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const seatOf = () => document.querySelector('.turn-seat[data-round-seat="0"]')
  const titleOf = () => document.querySelector('.turn-seat[data-round-seat]')?.querySelector('.entry-user')?.textContent ?? ''
  const clickSession = async (label) => {
    const item = [...document.querySelectorAll('.sess-item')].find((row) =>
      (row.querySelector('.title-text')?.textContent ?? '').includes(label))
    if (item === undefined) return false
    item.click()
    for (let i = 0; i < 300; i += 1) {
      if (titleOf().includes(label)) break
      await wait(100)
    }
    await wait(400)
    return titleOf().includes(label)
  }
  /** 第一轮开关行 / 折面 / 过程座位的读数（放行与手动存档各一个属性，见模块头 P8）。 */
  const readRound = () => {
    const seat = seatOf()
    if (seat === null) return null
    const toggle = seat.querySelector('.turn-fold:not([disabled])')
    const row = toggle === null ? null : toggle.closest('.entry-row')
    const segment = seat.querySelector('.turn-process')
    const owners = [...seat.querySelectorAll('.turn-process > .turn-process-body > *')]
    return {
      turnOpen: toggle === null ? null : toggle.getAttribute('data-open'),
      fold: segment === null ? null : segment.getAttribute('data-fold'),
      rescue: row === null ? null : row.getAttribute('data-turn-rescue'),
      manual: row === null ? null : row.getAttribute('data-turn-manual'),
      owners: owners.length,
      hidden: owners.filter((owner) => owner.getAttribute('hidden') !== null).length,
      shown: owners.filter((owner) => owner.getAttribute('hidden') === null && owner.getBoundingClientRect().height > 0).length,
    }
  }
  let seat = seatOf()
  if (seat === null) return { error: '没有第一轮' }
  let turn = seat.querySelector('.turn-fold:not([disabled])')
  if (turn === null) return { error: '第一轮没有整轮开关' }
  const current = titleOf().includes('甲') ? '甲' : (titleOf().includes('乙') ? '乙' : null)
  if (current === null) return { error: '认不出当前是哪条会话' }
  const other = current === '甲' ? '乙' : '甲'
  // 1. 基线：整轮摊开、组点开；焦点先放整轮开关上（开始收起那一拍的焦点检查不会放行）。
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
    if (group.getAttribute('data-open') === '1' && body !== null && !body.hasAttribute('hidden')) break
    await wait(50)
  }
  const head = seat.querySelector('.step-seat .think-head')
  if (head === null) return { error: '第一轮里找不到可聚焦的思考行头' }
  turn.focus()
  turn.click()
  // 2. 收起动画跑到一半（约 60ms），把焦点 Tab 进这一轮：末帧复检放行，这一轮停在展开，
  //    存档没有被动过（上一步点收起写的是「手动收起」）。
  await wait(60)
  head.focus()
  await wait(700)
  const released = readRound()
  if (released === null) return { error: '放行之后没有第一轮' }
  // 3. 切走再切回：座位按轮号复用、不重挂，看放行会不会跟着留到下一次打开。
  const wentAway = await clickSession(other)
  const cameBack = await clickSession(current)
  return {
    current,
    other,
    wentAway,
    cameBack,
    released,
    afterBack: readRound(),
    titleBack: titleOf().slice(0, 24),
  }
`)
process.stdout.write(`  放行跨会话 ${JSON.stringify(crossSessionRescue)}\n`)

assert(
  'P9 前提：收起动画跑到一半时焦点 Tab 进这一轮，这一轮被放行成展开（`data-turn-rescue` 是 1）',
  crossSessionRescue.released !== undefined
    && crossSessionRescue.released !== null
    && crossSessionRescue.released.rescue === '1'
    && crossSessionRescue.released.turnOpen === '1'
    && crossSessionRescue.released.fold === 'open',
  JSON.stringify({ released: crossSessionRescue.released, error: crossSessionRescue.error }),
)
assert(
  'P9：切走再切回之后，这一轮不是靠放行摊着的（`data-turn-rescue` 缺席），状态与存档/兜底一致（折面 closed、开关行收起、座位全挂 hidden）',
  crossSessionRescue.wentAway === true
    && crossSessionRescue.cameBack === true
    && crossSessionRescue.afterBack !== null
    && crossSessionRescue.afterBack !== undefined
    && crossSessionRescue.afterBack.rescue === null
    && crossSessionRescue.afterBack.manual === null
    && crossSessionRescue.afterBack.turnOpen === null
    && crossSessionRescue.afterBack.fold === 'closed'
    && crossSessionRescue.afterBack.owners > 0
    && crossSessionRescue.afterBack.hidden === crossSessionRescue.afterBack.owners,
  JSON.stringify(crossSessionRescue.afterBack ?? crossSessionRescue),
)

teardown([cdp, desktop, home])
finish('_verify-collapse-remount')
