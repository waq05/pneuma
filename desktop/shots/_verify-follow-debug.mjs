process.on('unhandledRejection', () => {})

/**
 * 「自动跟随中途掉线」的真机探针（2026-11-10 报障，2026-11-11 修活）。
 *
 * ## 报障现场
 *
 * 上一轮探针在长跑里量到：169 次可滚动采样只有 4 次贴底、165 次挂着「回到底部」胶囊。
 * 这个探针把**是谁把 scrollTop 改成了什么**记下来，顺便核对「我量的那个 .chat 是不是真的
 * 主对话那一个」。
 *
 * ## 修了什么（修之前它是空转）
 *
 * 旧版把四样东西都记全了（几个 `.chat`／50ms 采样／scroll 事件／scrollTop 的写入栈），
 * 打印完就 `process.exit(0)`——掉不掉线都一样绿。现在每条读数都配判据：
 *
 *   1. **量的对象对**：页面里恰好 1 个 `.chat`，且它挂在 `.thread-main` 里；
 *   2. **在量**：采样 ≥ 150 帧；其中「内容高过视口」的帧 ≥ 80（不然没东西可跟随）；
 *   3. **跟随没掉**：可滚帧里贴底（`sh − ch − top ≤ 24`）的比例 ≥ 95%，且离底帧 ≤ 5 帧；
 *   4. **跑动中不弹胶囊**：胶囊一次都不该亮（报障时它是 165/169 帧亮着）；
 *   5. **真的在写**：截到的 scrollTop 写入 > 0，且每条写入栈都指向统一入口 `ViewportOwner`
 *      （报障的成因是「还有人在绕过协调器写」，这条就是那把尺子；哪天打包把类名抹了，
 *      它会红，那时改成看栈里剩下什么）；
 *   6. **跑动中确实有回合状态行**：状态行在 ≥ 30 帧里在场（证的是「跑动中跟随」，不是静止画面）。
 *
 * ## 夹具为什么从「假端点跑工具调用」改成「只吐长正文」
 *
 * 两个不确定源都排掉了：
 *
 *   · **窗口被挡时的渲染节流**：Chromium 会把定时器压到 1Hz、停掉 rAF，于是采样只有 30 来帧、
 *     跟随一次都没跑（实测同一份代码连跑三次：两次 99% 贴底、一次 69%）。现在起窗口时带回
 *     `--disable-background-timer-throttling` 等三条开关，并对页面开 `setFocusEmulationEnabled`，
 *     采样稳定在 170–223 帧。
 *   · **工具调用那一轮宿主会重发同一请求**：会话日志里能看到 8 条一模一样的 assistant 记录，
 *     内容增长节奏因此不确定。夹具换成**只吐正文的长流**（内容照样持续长高，跟随与写入栈都
 *     量得到），代价是不再覆盖「工具卡重排」那一路——那一路由 `_verify-follow-pill.mjs` 的
 *     B 段（内容自己变矮）负责。
 *
 * ## 负向自检
 *
 * `PROBE_MUTATE=nofollow`：采样期间每隔 100ms 把 `scrollTop` 往回拨 300px（模拟「跟随掉了」）。
 * 判据 3、4 当场红。
 *
 * 运行：node desktop/shots/_verify-follow-debug.mjs
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  assert, connectCdp, finish, launchDesktop, makeHome, requireScene, sleep, teardown,
} from './_probe-kit.mjs'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const fakePort = 18998
const debugPort = 9381

const home = makeHome({
  shots,
  name: '_verify-follow-debug-home',
  dirs: ['sessions/demo', 'usage'],
  config: [
    'default:', '  provider: fake', '  model: fake-follow', 'providers:', '  fake:',
    '    displayName: 自检假端点',
    `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
    '    apiKeyEnv: DSC_FAKE_KEY',
    '    models:', '      - id: fake-follow', '        name: Fake Follow',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'),
  // 思考默认展开 + verbose 档：过程区摊开，会话更高，跟随有东西可跟。
  settings: { ui: { reasoningDefaultOpen: true, processFold: 'verbose' } },
})
const work = home.work

const now = Date.now()
const sessionFile = join(home.dsc, 'sessions', 'demo', 'follow-demo.jsonl')
writeFileSync(sessionFile, [
  { type: 'meta', id: 'follow-demo', cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '跑一轮长的：我要看跟随会不会掉。', ts: now - 50000 },
].map((line) => JSON.stringify(line)).join('\n') + '\n')

/**
 * 假模型：一串长句分 180 口吐出来，持续约 8 秒。
 *
 * 不调工具（原因见文件头「夹具为什么改」）：只要内容在持续长高，跟随与写入栈就都量得到。
 */
const SENTENCE = '这一段是把边界条件逐条核对的记录：入参、返回值、空数组、超时，一项一项过，'
  + '顺带把调用方的口径再对一遍，确认没有漏掉空数组与超时这两条。'
  + '这一轮只看跟随，不看结论，所以句子重复三遍把内容堆高。'
const CHUNKS = 45
const GAP_MS = 180
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
    for (let index = 0; index < CHUNKS; index += 1) {
      delta({ content: SENTENCE })
      await sleep(GAP_MS)
    }
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 900 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-follow] ${String(error)}\n`)
    try { res.end() } catch {}
  })
})
server.listen(fakePort, '127.0.0.1')
const serverHandle = { stop() { try { server.close() } catch {} } }

const desktop = launchDesktop({
  root,
  home: home.home,
  dsc: home.dsc,
  userData: home.userData,
  debugPort,
  extraEnv: { DSC_RESUME_SESSION: sessionFile },
})

let cdp = null
try {
  cdp = await connectCdp({ port: debugPort, log: desktop.log })
  const { evaluate } = cdp
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1423, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(600)

  const booted = await requireScene(evaluate, {
    name: '会话打开（有用户气泡 + 输入框）',
    timeoutMs: 40000,
    script: `
      return {
        ok: document.querySelector('.composer textarea') !== null && document.querySelector('.entry-user') !== null,
        textarea: document.querySelector('.composer textarea') !== null,
        users: document.querySelectorAll('.entry-user').length,
      }
    `,
  })
  if (!booted.ok) {
    teardown([{ close: () => cdp?.close() }, desktop, serverHandle, home])
    finish('_verify-follow-debug')
  }

  const started = await evaluate(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const input = document.querySelector('.composer textarea')
    if (input === null) return { error: 'no textarea' }

    // —— 先核对对象：到底有几个 .chat、胶囊挂在哪 ——
    const chats = [...document.querySelectorAll('.chat')]
    const pills = [...document.querySelectorAll('.chat-to-bottom')]
    const survey = {
      chats: chats.map((node) => ({
        cls: node.className,
        parent: node.parentElement?.className ?? '',
        inThread: node.closest('.thread-main, .thread-main-empty') !== null,
        h: Math.round(node.getBoundingClientRect().height),
      })),
      pills: pills.map((node) => ({
        parent: node.parentElement?.className ?? '',
        inThread: node.closest('.thread-main, .thread-main-empty') !== null,
      })),
    }
    // 主对话 = 挂在 .thread-main 里的那一个
    const chat = chats.find((node) => node.closest('.thread-main, .thread-main-empty') !== null) ?? chats[0]
    if (chat === undefined) return { survey, error: 'no chat' }
    const inner = chat.querySelector('.chat-inner')

    // —— 拦截 scrollTop 写入，记调用栈 ——
    const writes = []
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
    if (descriptor !== undefined && descriptor.set !== undefined && descriptor.get !== undefined) {
      const set = descriptor.set
      const get = descriptor.get
      Object.defineProperty(chat, 'scrollTop', {
        configurable: true,
        get() { return get.call(this) },
        set(value) {
          const stack = String(new Error().stack ?? '').split('\\n').slice(1, 5).join(' | ')
          writes.push({ t: Math.round(performance.now()), value: Math.round(Number(value)), stack })
          if (writes.length > 60) writes.shift()
          set.call(this, value)
        },
      })
    }

    const scrolls = []
    chat.addEventListener('scroll', () => {
      scrolls.push({
        t: Math.round(performance.now()),
        top: Math.round(chat.scrollTop),
        gap: Math.round(chat.scrollHeight - chat.clientHeight - chat.scrollTop),
      })
      if (scrolls.length > 80) scrolls.shift()
    }, { passive: true })

    const samples = []
    const timer = window.setInterval(() => {
      const pill = [...document.querySelectorAll('.chat-to-bottom')]
        .filter((node) => node.closest('.thread-main, .thread-main-empty') !== null && node.getBoundingClientRect().height > 0)
      samples.push({
        t: Math.round(performance.now()),
        top: Math.round(chat.scrollTop),
        sh: chat.scrollHeight,
        ch: chat.clientHeight,
        innerGap: inner === null ? null : Math.round(chat.getBoundingClientRect().bottom - inner.getBoundingClientRect().bottom),
        pill: pill.length > 0,
        status: document.querySelector('.turn-status') !== null,
      })
    }, 50)

    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, '跑一轮长的：我要看跟随会不会掉。')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(150)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

    window.__fd = { timer, samples, scrolls, writes, chat }
    return { survey: { ...survey, picked: chat.className, h: Math.round(chat.getBoundingClientRect().height) } }
  `)
  console.log('start', JSON.stringify(started, null, 1))
  assert('主对话只有一个 .chat 且挂在 .thread-main 里（防量错对象）',
    started?.survey?.chats?.length === 1 && started.survey.chats[0].inThread === true,
    JSON.stringify(started?.survey?.chats))

  // 负向自检：采样期间不停把 scrollTop 拽回顶部（模拟「跟随掉了、有人还在往上拽」）。
  if (process.env.PROBE_MUTATE === 'nofollow') {
    await evaluate(`
      const chat = window.__fd.chat
      window.__fd.mutate = window.setInterval(() => { chat.scrollTop = 0 }, 16)
      return true
    `)
    console.log('负向自检：每 16ms 把 scrollTop 拽回顶部（跟随应当当场掉线）')
  }

  await sleep(11000)

  const report = await evaluate(`
    window.clearInterval(window.__fd.timer)
    if (window.__fd.mutate !== undefined) window.clearInterval(window.__fd.mutate)
    const { samples, scrolls, writes } = window.__fd
    const scrollable = samples.filter((s) => s.sh - s.ch > 24)
    const pinned = scrollable.filter((s) => s.sh - s.ch - s.top <= 24)
    const firstPill = samples.findIndex((s) => s.pill)
    return {
      n: samples.length,
      scrollable: scrollable.length,
      pinned: pinned.length,
      offBottom: scrollable.length - pinned.length,
      pinnedRatio: scrollable.length === 0 ? 0 : Number((pinned.length / scrollable.length).toFixed(4)),
      pillSamples: samples.filter((s) => s.pill).length,
      statusFrames: samples.filter((s) => s.status).length,
      firstPillAt: firstPill < 0 ? null : samples[firstPill],
      head: samples.slice(0, 6),
      tail: samples.slice(-4),
      slackMax: samples.reduce((max, s) => Math.max(max, s.sh - s.ch), 0),
      scrollEvents: scrolls.length,
      writeCount: writes.length,
      foreignWrites: writes.filter((w) => !String(w.stack).includes('ViewportOwner')).length,
      writeStacks: [...new Set(writes.map((w) => String(w.stack).split(' | ').slice(0, 2).join(' | ')))].slice(0, 3),
    }
  `)
  console.log('report', JSON.stringify(report, null, 1))

  assert('在量：采样 ≥ 150 帧', report.n >= 150, `${String(report.n)} 帧`)
  assert('有东西可跟随：可滚帧 ≥ 80、可滚高度 > 500px',
    report.scrollable >= 80 && report.slackMax > 500,
    `可滚 ${String(report.scrollable)} 帧 / max(sh−ch)=${String(report.slackMax)}`)
  assert('跟随没掉：可滚帧里贴底比例 ≥ 95%、离底 ≤ 5 帧',
    report.pinnedRatio >= 0.95 && report.offBottom <= 5,
    `${String(report.pinned)}/${String(report.scrollable)}（${String(report.pinnedRatio)}），离底 ${String(report.offBottom)} 帧`)
  assert('跑动中「回到底部」胶囊一次都不亮（报障时是 165/169 帧亮着）',
    report.pillSamples === 0, `${String(report.pillSamples)} 帧亮着`)
  assert('真的在写 scrollTop（不然第 3 条可能是巧合）', report.writeCount > 0, `${String(report.writeCount)} 次写入`)
  assert('每次写入都走统一入口 ViewportOwner（没有绕过协调器的第二只手）',
    report.foreignWrites === 0,
    `外部写入 ${String(report.foreignWrites)} 条；栈样例 ${JSON.stringify(report.writeStacks)}`)
  assert('跟随时确实滚动过（scroll 事件 ≥ 10）', report.scrollEvents >= 10, `${String(report.scrollEvents)} 次`)
  assert('跑动中确实有回合状态行（量的是跑动中的跟随，不是静止画面）',
    report.statusFrames >= 30, `${String(report.statusFrames)} 帧`)
} finally {
  if (process.env.PROBE_KEEP_HOME === '1') home.cleanup = () => {}
  teardown([{ close: () => cdp?.close() }, desktop, serverHandle, home])
  await sleep(300)
}

finish('_verify-follow-debug')
