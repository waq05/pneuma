process.on('unhandledRejection', () => {})

/**
 * 第三层（阶段组体 `.step-body`）的限高 / 自滚 / 空白探针（#2 报障，2026-11-11 重写）。
 *
 * ## 报障是什么
 *
 * 三层折叠结构（整轮 `.turn-fold` → 阶段组头 `.step-fold` → 组体 `.step-body`）里，第三层
 * 是 `max-height: min(400px, 50vh)` + 自己滚动。报障说「跑动中工具调用与思考落在第三层级里时
 * 出现空白」——组体高度撑到限高、可内容不够高，或者滚到底之后底下还留一截空。
 *
 * ## 旧的 `_verify-level3.mjs` 为什么是假绿
 *
 * 它起假端点跑工具调用，全程 50ms 采样 `.step-body` 的高度与底边距，然后把读数打印出来
 * `process.exit(0)`：`scrollableSamples` / `pinnedSamples` 一个都没比。更糟的是它的**现场
 * 根本不存在**：`settings.json` 写的是 `processFold: 'verbose'`（不折不分组），实测
 * `.step-seat` 与 `.step-body` 全程都是 0 个（`bodyHMax: null`），也就是说它量的是一个
 * 永远不会出现的元素，绿得毫无意义。
 *
 * ## 现在怎么测（**定稿态**，不覆盖直播态）
 *
 * 用宿主自己的 `Session` 种一条历史：一轮里 20 个 read 调用挤在同一组（组体必然超限高），
 * 再加一轮只有 2 个调用（组体撑不满限高）。打开这条会话、展开整轮与两个组，然后判：
 *
 *   1. **组体在场**：展开后 `.step-body` 高度 > 0（旧版这里永远是 0 个）；
 *   2. **限高生效**：高个组体的高度 = `min(400px, 50vh)`（±1px），没有任何组体超过它；
 *   3. **内容超限高时会自滚**：高个组 `scrollHeight − clientHeight ≥ 100`；
 *   4. **滚到底没有空白**：把组体滚到底之后，最后一行底边与组体底边的距离 ≤ 8px；
 *   5. **短组不留白**：撑不满限高的组，组体高度 = 内容高度（±2px）——「空白」最典型的形状；
 *   6. **方向渐隐挂着**：可滚且到底后 `data-scroll-up` 在；
 *   7. **组内滚动不动外层**：组体滚到底之后，外层 `.chat` 的 `scrollTop` 不变（±1px）。
 *
 * **未覆盖**：直播态（跑动中）第三层。假端点跑工具调用这一轮里宿主会把同一请求重发好几次
 * （会话日志里 8 条一模一样的 assistant），直播窗口抓不稳，所以这一版只钉定稿态。
 * 用 `seed.appendAssistant(..., toolCalls)` 造历史不需要模型，定稿态因此是确定性的。
 *
 * ## 负向自检
 *
 * `PROBE_MUTATE=nolimit`：把 `.step-body` 的 `max-height` 改成 `none`（复刻「组体不限高」），
 * 判据 2 当场红。
 *
 * 运行：node desktop/shots/_verify-level3.mjs
 * 前提：`pnpm run build`（要 lib/core/session.js 写种子）
 * 产物：desktop/shots/_level3-after.png
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  assert, connectCdp, finish, launchDesktop, makeHome, requireScene, sleep, startFakeLlm, teardown,
} from './_probe-kit.mjs'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const fakePort = 18997
const debugPort = 9377
const width = Number(process.argv[2] ?? 1423)
const height = Number(process.argv[3] ?? 900)
const LIMIT = Math.min(400, Math.round(height / 2))

const home = makeHome({
  shots,
  name: '_verify-level3-home',
  dirs: ['sessions/demo', 'usage'],
  config: [
    'default:', '  provider: fake', '  model: fake-fold', 'providers:', '  fake:',
    '    displayName: 自检假端点',
    `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
    '    apiKeyEnv: DSC_FAKE_KEY',
    '    models:', '      - id: fake-fold', '        name: Fake Fold',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'),
  // standard：阶段分组存在，但已收尾的轮与组体默认收起——探针自己点开。
  // （旧版写的是 verbose，那个档位不分组，第三层压根不存在。）
  settings: { ui: { reasoningDefaultOpen: true, processFold: 'standard' } },
})
const work = home.work
mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'probe-target.txt'), '探针样张：这一行只是让 read 调用有东西可读。\n')

// ── 历史种子：必须是宿主自己的 Session 写的（手搓 jsonl 会和宿主的重放口径对不上）──────
process.env.HOME = home.home
process.env.USERPROFILE = home.home
const core = await import('../../lib/core/session.js')
const seed = core.Session.create(work)

/** 一轮里塞 toolCount 个 read 调用（同一组，组体高度随调用数线性长）。 */
const appendRound = (label, toolCount) => {
  seed.appendUser(`${label}轮：把这一段的边界条件过一遍。`)
  const calls = Array.from({ length: toolCount }, (_unused, index) => ({
    id: `call_l3_${label}_${String(index)}`,
    name: 'read',
    arguments: JSON.stringify({ path: join(work, 'probe-target.txt') }),
  }))
  seed.appendAssistant('先读一遍样张确认口径。', '思考：先把入参与返回值核对一遍。\n', calls)
  for (let index = 0; index < toolCount; index += 1) {
    seed.appendTool(`call_l3_${label}_${String(index)}`, 'read', `第 ${String(index + 1)} 次读到的样张内容（两行）。`)
  }
  seed.appendAssistant(`${label}轮收尾：口径对上了，这一轮不用改。`, '', [])
}

appendRound('高', 20)
appendRound('短', 2)
seed.close()

const fake = await startFakeLlm({
  shots,
  file: 'fold-fake-llm.mjs',
  port: fakePort,
  env: { DSC_FAKE_KEY: 'sk-selfcheck-fake' },
})
const desktop = launchDesktop({
  root,
  home: home.home,
  dsc: home.dsc,
  userData: home.userData,
  debugPort,
  extraEnv: { DSC_RESUME_SESSION: seed.filePath },
})
let cdp = null
try {
  cdp = await connectCdp({ port: debugPort, log: desktop.log })
  const { evaluate, send: cdpSend } = cdp
  await cdpSend('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(700)

  const booted = await requireScene(evaluate, {
    name: '历史轮上屏（有用户气泡与阶段组）',
    timeoutMs: 40000,
    script: `
      return {
        ok: document.querySelector('.composer textarea') !== null
          && document.querySelectorAll('.entry-user').length >= 2
          && document.querySelectorAll('.step-seat').length >= 2,
        users: document.querySelectorAll('.entry-user').length,
        groups: document.querySelectorAll('.step-seat').length,
      }
    `,
  })
  if (!booted.ok) {
    teardown([{ close: () => cdp?.close() }, desktop, fake, home])
    finish('_verify-level3')
  }

  // 负向自检：撤掉限高（复刻「组体不限高」）。
  if (process.env.PROBE_MUTATE === 'nolimit') {
    await evaluate(`
      const style = document.createElement('style')
      style.textContent = '.step-body { max-height: none !important; }'
      document.head.appendChild(style)
      await new Promise((r) => setTimeout(r, 300))
      return true
    `)
    console.log('负向自检：.step-body 的 max-height 已改成 none（限高应当当场失效）')
  }

  // 展开整轮 + 每个组体（历史轮默认收起）。
  const opened = await evaluate(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    let turnOpened = 0
    for (const seat of document.querySelectorAll('.turn-seat[data-round-seat]')) {
      const button = seat.querySelector('.turn-fold:not([disabled])')
      const segment = seat.querySelector('.turn-process')
      if (button === null || segment === null) continue
      if (segment.getAttribute('data-fold') === 'closed') { button.click(); turnOpened += 1 }
    }
    await wait(500)
    let groupsOpened = 0
    for (const button of document.querySelectorAll('.step-fold')) {
      if (button.getAttribute('data-open') === '1') continue
      button.click()
      groupsOpened += 1
    }
    await wait(700)
    if (document.activeElement !== null && document.activeElement.blur !== undefined) document.activeElement.blur()
    return { turnOpened, groupsOpened, bodies: document.querySelectorAll('.step-body').length }
  `)
  console.log('opened', JSON.stringify(opened))

  const scene = await requireScene(evaluate, {
    name: '组体 .step-body 真的露出来了（旧版这里全程 0 个）',
    timeoutMs: 12000,
    intervalMs: 250,
    script: `
      const bodies = [...document.querySelectorAll('.step-body')]
      const visible = bodies.filter((node) => node.getBoundingClientRect().height > 1)
      return { ok: visible.length >= 2, bodies: bodies.length, visible: visible.length,
        heights: bodies.map((node) => Math.round(node.getBoundingClientRect().height)) }
    `,
  })
  if (!scene.ok) {
    teardown([{ close: () => cdp?.close() }, desktop, fake, home])
    finish('_verify-level3')
  }

  const measured = await evaluate(`
    const bodies = [...document.querySelectorAll('.step-body')].map((node, index) => {
      const box = node.getBoundingClientRect()
      const content = node.querySelector('.step-content')
      const rows = content === null ? [] : [...content.children]
      const rowBoxes = rows.map((row) => row.getBoundingClientRect()).filter((item) => item.height > 0)
      const lastBottom = rowBoxes.length === 0 ? null : Math.max(...rowBoxes.map((item) => item.bottom))
      return {
        index,
        h: Math.round(box.height),
        clientH: node.clientHeight,
        scrollH: node.scrollHeight,
        over: node.scrollHeight - node.clientHeight,
        rows: rows.length,
        contentH: content === null ? 0 : Math.round(content.getBoundingClientRect().height),
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        lastBottom: lastBottom === null ? null : Math.round(lastBottom),
        scrollTop: Math.round(node.scrollTop),
        maskUp: node.getAttribute('data-scroll-up'),
        maskDown: node.getAttribute('data-scroll-down'),
        hidden: node.hasAttribute('hidden'),
      }
    })
    const chat = document.querySelector('.chat')
    const inner = document.querySelector('.chat-inner')
    return {
      bodies,
      chat: {
        top: Math.round(chat.scrollTop),
        slack: chat.scrollHeight - chat.clientHeight,
        innerGap: inner === null ? null : Math.round(chat.getBoundingClientRect().bottom - inner.getBoundingClientRect().bottom),
      },
      limit: ${String(LIMIT)},
    }
  `)
  console.log('measured', JSON.stringify(measured, null, 1))

  const bodies = measured.bodies ?? []
  const tall = bodies.reduce((best, item) => (best === null || item.rows > best.rows ? item : best), null)
  const shortOnes = bodies.filter((item) => item !== tall)

  assert('组体全部露出来了（没有一个是 0 高）', bodies.length >= 2 && bodies.every((item) => item.h > 1),
    JSON.stringify(bodies.map((item) => ({ h: item.h, rows: item.rows }))))
  assert('没有任何组体超过限高 min(400px, 50vh)',
    bodies.every((item) => item.h <= measured.limit + 1),
    `上限 ${String(measured.limit)}px；实测 ${JSON.stringify(bodies.map((item) => item.h))}`)
  assert('高个组体正好卡在限高上（限高真的在起作用，不是内容碰巧不够高）',
    tall !== null && tall.h >= measured.limit - 1 && tall.h <= measured.limit + 1,
    `rows=${String(tall?.rows)} h=${String(tall?.h)} limit=${String(measured.limit)}`)
  assert('内容超限高时会自滚（scrollHeight − clientHeight ≥ 100）',
    tall !== null && tall.over >= 100, `超 ${String(tall?.over)}px`)

  // 滚到底：底部不该留空白，且方向渐隐要跟着翻。
  const bottom = await evaluate(`
    const bodies = [...document.querySelectorAll('.step-body')]
    const target = bodies.reduce((best, node) => (best === null || node.scrollHeight > best.scrollHeight ? node : best), null)
    if (target === null) return null
    const chat = document.querySelector('.chat')
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    // 先等外层自己安静下来（展开组体之后还有一小段跟随在落位），否则量到的是那段余动。
    let last = null
    let stableFrames = 0
    for (let i = 0; i < 24; i += 1) {
      const nowTop = Math.round(chat.scrollTop)
      if (nowTop === last) stableFrames += 1
      else { stableFrames = 0; last = nowTop }
      if (stableFrames >= 3) break
      await wait(150)
    }
    const before = { chatTop: chat.scrollTop }
    target.scrollTop = target.scrollHeight
    await wait(500)
    const box = target.getBoundingClientRect()
    const content = target.querySelector('.step-content')
    const rows = content === null ? [] : [...content.children]
    const rowBoxes = rows.map((row) => row.getBoundingClientRect()).filter((item) => item.height > 0)
    const lastBottom = rowBoxes.length === 0 ? null : Math.max(...rowBoxes.map((item) => item.bottom))
    return {
      h: Math.round(box.height),
      scrollTop: Math.round(target.scrollTop),
      over: target.scrollHeight - target.clientHeight,
      bottomGap: lastBottom === null ? null : Math.round(box.bottom - lastBottom),
      maskUp: target.getAttribute('data-scroll-up'),
      maskDown: target.getAttribute('data-scroll-down'),
      chatDelta: Math.round(chat.scrollTop - before.chatTop),
    }
  `)
  console.log('bottom', JSON.stringify(bottom))

  assert('滚到底之后组体底部没有空白（最后一行底边到组体底边 ≤ 8px）',
    bottom !== null && bottom.bottomGap !== null && Math.abs(bottom.bottomGap) <= 8,
    `底部空白 ${String(bottom?.bottomGap)}px`)
  assert('到底后 data-scroll-up 挂着（上缘渐隐提示还有内容在上面）',
    bottom !== null && bottom.maskUp === '1', JSON.stringify({ up: bottom?.maskUp, down: bottom?.maskDown }))
  assert('组内滚动不动外层（.chat 的 scrollTop 变化 ≤ 1px）',
    bottom !== null && Math.abs(bottom.chatDelta) <= 1, `外层位移 ${String(bottom?.chatDelta)}px`)

  if (shortOnes.length > 0) {
    const short = shortOnes[0]
    assert('撑不满限高的组不留白（组体高 = 内容高，±2px）',
      Math.abs(short.h - short.contentH) <= 2,
      `h=${String(short.h)} contentH=${String(short.contentH)} rows=${String(short.rows)}`)
  } else {
    assert('找到一组「撑不满限高」的组（短组留白是这条要防的形状）', false, '没有短组可量')
  }
  assert('外层会话区没有大空白（.chat 底边到正文列底边 ≤ 40px）',
    measured.chat.innerGap !== null && Math.abs(measured.chat.innerGap) <= 40,
    `innerGap=${String(measured.chat.innerGap)}px`)

  const shot = await cdpSend('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, '_level3-after.png'), Buffer.from(shot.data, 'base64'))
  assert('截图落盘（组体限高与渐隐可目检）', (shot.data ?? '').length > 1000, `${String((shot.data ?? '').length)} 字节`)
} finally {
  if (process.env.PROBE_KEEP_HOME === '1') home.cleanup = () => {}
  teardown([{ close: () => cdp?.close() }, desktop, fake, home])
  await sleep(300)
}

finish('_verify-level3')
