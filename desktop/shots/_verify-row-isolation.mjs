/**
 * 「非尾行在流式期间一个字都不许动」的真机探针（差距清单 S2 彻底方案，2026-11-10）。
 *
 * 要证的不变量只有两条，缺一条另一条就能作弊：
 *   1. **静止**：一条行一旦不在尾部（上面没有新内容再长进来），流式期间它的 DOM 必须
 *      **零变动**——childList 与 characterData 都算。零变动 = 行体没重渲染、React 没写 DOM。
 *   2. **在长**：同一段时间里尾部确实在长（尾行字符数在涨、行数在增）。只证第 1 条的话，
 *      界面卡死也能「通过」。
 *
 * 怎么判「尾部」：每帧记一次 DOM 里 `.entry-row` 的顺序，最后两条算尾窗（行体定稿那一拍
 * 会从「直播行」变成普通行，那一拍它在尾窗里，允许重画一次；之后必须冻住）。一条变动算
 * 违规，要同时满足：目标行不在任何一次尾窗里、也不是刚出生 250ms 内的新行。
 *
 * 现场：8 轮历史（每轮 user + 思考 + 工具调用 + 结果）先落盘 → 打开会话 → 让假模型在
 * 4 秒里连做 3 次工具调用 + 最后一段正文。历史行从头到尾都是非尾行，它们是最硬的那组证据。
 *
 * 运行：node desktop/shots/_verify-row-isolation.mjs
 * 产物：desktop/shots/_row-isolation.png（收工时的整屏，旁证「画面确实在长」）
 *
 * 前提：`pnpm run build`（要 lib/core/session.js 写种子）与 `pnpm run build:ui` 都跑过。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-row-isolation-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18993
const debugPort = 9373

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(join(work), { recursive: true })
// Chromium 在 app ready 之前会去 %USERPROFILE%\AppData\Roaming 找配置：目录不存在会直接崩。
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-rows', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-rows', '        name: Fake Rows',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
// next-input：跑完的最后一轮先摊着，收工时不会有一大片折叠动画混进观测窗口。
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({ ui: { collapseTiming: 'next-input' } }))

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
      id: `call_seed_${String(round)}`,
      name: 'read',
      arguments: JSON.stringify({ path: join(work, 'probe-target.txt') }),
    },
  ])
  seed.appendTool(`call_seed_${String(round)}`, 'read', `第 ${String(round + 1)} 轮读到的样张内容（三行）。`)
}
seed.close()

// ── 假模型：三跳工具调用 + 一跳正文；每跳都先流 10 口思考（约 1.1 秒）───────────────
const THINK = '核对这一段：入参、返回值、空数组、超时，逐项过一遍再动。\n'
const server = createServer((req, res) => {
  void (async () => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const messages = (() => {
      try {
        const parsed = JSON.parse(body)
        return Array.isArray(parsed.messages) ? parsed.messages : []
      } catch { return [] }
    })()
    const toolResults = messages.filter((message) => message.role === 'tool').length
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    if (toolResults < 3) {
      for (let index = 0; index < 10; index += 1) {
        delta({ reasoning_content: THINK })
        await sleep(95)
      }
      delta({
        tool_calls: [{
          index: 0,
          id: `call_live_${String(toolResults)}`,
          type: 'function',
          function: {
            name: 'read',
            arguments: JSON.stringify({ path: join(work, 'probe-target.txt') }),
          },
        }],
      })
      delta({}, 'tool_calls')
    } else {
      // 最后一段走**正文**流：尾行是一条正在长的正文行，字符数单调上涨——
      // 「零变动」才不能靠「界面卡死」骗过去（收起的思考行只有一行摘要，涨不动）。
      const sentence = '这一段是把三跳的结论并起来的正文：入参、返回值、空数组、超时四项都核对过，'
      for (let index = 0; index < 40; index += 1) {
        delta({ content: sentence })
        await sleep(80)
      }
      delta({ content: '没有漏项。' })
      await sleep(80)
      delta({}, 'stop')
    }
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 120, completion_tokens: 90 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-rows] ${String(error)}\n`)
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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

const observation = await evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  for (let i = 0; i < 160; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(250)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const root = document.querySelector('.chat') ?? document.body
  // 等历史行真的画上来（种子会话经 DSC_RESUME_SESSION 打开，重放要一点时间）：
  // 观测窗口里必须已经有「一上来就不是尾行」的那批行，否则这条探针什么都没证。
  for (let i = 0; i < 120; i += 1) {
    if (root.querySelectorAll('.entry-row').length >= 8) break
    await wait(100)
  }

  // 行 id：元素 → 序号（WeakMap，不往 DOM 上写属性，免得自己制造变动）。
  const ids = new WeakMap()
  let nextId = 0
  const bornAt = new WeakMap()
  const idOf = (element) => {
    const known = ids.get(element)
    if (known !== undefined) return known
    const id = nextId++
    ids.set(element, id)
    bornAt.set(element, performance.now())
    return id
  }
  const rowsInDom = () => [...root.querySelectorAll('.entry-row')]
  // 观测前先给现存的每一行发号：**它们从头到尾都不是尾行**，是最硬的那组证据。
  const preexisting = rowsInDom().map(idOf)

  const mutations = []
  const outside = []
  const observer = new MutationObserver((records) => {
    const now = performance.now()
    for (const record of records) {
      const node = record.target
      const element = node.nodeType === 3 ? node.parentElement : node
      const row = element === null || element === undefined ? null : element.closest('.entry-row')
      if (row === null) {
        outside.push({ t: now, type: record.type })
        continue
      }
      mutations.push({
        t: now,
        type: record.type,
        id: idOf(row),
        added: record.addedNodes?.length ?? 0,
        removed: record.removedNodes?.length ?? 0,
        chars: row.textContent?.length ?? 0,
      })
    }
  })
  observer.observe(root, { childList: true, subtree: true, characterData: true, characterDataOldValue: false })

  // 每帧一条样本：尾窗（最后两行）、行数、尾行字符数。
  const samples = []
  let sampling = true
  const tick = () => {
    if (!sampling) return
    const rows = rowsInDom()
    const rowsIds = rows.map(idOf)
    samples.push({
      t: performance.now(),
      tail: rowsIds.slice(-2),
      rowsIds,
      rows: rows.length,
      tailChars: rows.length === 0 ? 0 : (rows[rows.length - 1].textContent?.length ?? 0),
    })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '接着把这三段边界条件核对一遍，最后给一句结论。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  const startedAt = performance.now()
  const rowsAtStart = rowsInDom().length
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  // 等这一轮**真的开跑**（状态行出现）：历史里本来就有轮尾，只看 .round-foot 会当场收工。
  let sawRunning = false
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.turn-status') !== null) {
      sawRunning = true
      break
    }
    await wait(50)
  }
  // 再等收工：状态行消失，且行数确实长了（不然只是「还没开始」）。
  let doneMs = 0
  for (let i = 0; i < 900; i += 1) {
    const running = document.querySelector('.turn-status') !== null
    if (!running && rowsInDom().length > rowsAtStart + 1) {
      doneMs = performance.now() - startedAt
      break
    }
    await wait(50)
  }
  await wait(400)
  // 观测器自检：故意动一条非尾行，确认这套「变动 → 行 id」的判定真的看得见东西。
  // 没有这一步，「0 次变动」也可能是观测器压根没挂上——那是最容易骗过自己的一种通过。
  const selfTestAt = performance.now()
  const bystander = rowsInDom()[0]
  let selfTestSeen = false
  if (bystander !== undefined) {
    const marker = document.createElement('span')
    marker.textContent = '自检'
    const bystanderId = idOf(bystander)
    bystander.appendChild(marker)
    // MutationObserver 的回调是微任务之后才投递的：不 await 一拍，读到的永远是「没听见」。
    await wait(50)
    selfTestSeen = mutations.some((item) => item.id === bystanderId && item.t >= selfTestAt)
    bystander.removeChild(marker)
  }
  await wait(60)
  sampling = false
  observer.disconnect()
  const rows = rowsInDom()
  return {
    selfTestAt,
    selfTestSeen,
    startedAt,
    sawRunning,
    doneMs: Math.round(doneMs),
    rowsAtStart,
    rowsAtEnd: rows.length,
    preexisting,
    mutations: mutations.slice(-4000),
    mutationCount: mutations.length,
    outsideCount: outside.length,
    samples,
    tailCharsAtEnd: rows.length === 0 ? 0 : (rows[rows.length - 1].textContent?.length ?? 0),
  }
`)
if (observation?.error !== undefined) throw new Error(String(observation.error))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (typeof shot?.data === 'string') writeFileSync(join(shots, '_row-isolation.png'), Buffer.from(shot.data, 'base64'))

// ── 判定 ────────────────────────────────────────────────────────────────────────
const samples = observation.samples ?? []
const mutations = observation.mutations ?? []
/**
 * 判定一条变动算不算「非尾行」：
 *   · 尾窗内：变动时刻 ±250ms 里有任何一条采样把这一行算在最后两行里 → 这是定稿 / 新增那一拍，放行；
 *   · 刚出生：这一行第一次出现在采样里的时刻**晚于**这次变动（说明它正在被创建）→ 放行。
 * 其余一律算违规——那正是「内容没变却重渲染」的现场。
 */
const GRACE_MS = 250
const firstSeen = new Map()
for (const sample of samples) {
  for (const id of sample.tail ?? []) if (!firstSeen.has(id)) firstSeen.set(id, sample.t)
  for (const id of sample.rowsIds ?? []) if (!firstSeen.has(id)) firstSeen.set(id, sample.t)
}
const inTailWindow = (id, at) =>
  samples.some((sample) => Math.abs(sample.t - at) <= GRACE_MS && (sample.tail ?? []).includes(id))
const violations = []
let tailMutations = 0
// 自检那一下之后产生的变动是探针自己造的，不参与判定。
const judged = mutations.filter((mutation) => mutation.t < (observation.selfTestAt ?? Infinity))
for (const mutation of judged) {
  const seen = firstSeen.get(mutation.id)
  if (inTailWindow(mutation.id, mutation.t) || (seen !== undefined && seen > mutation.t)) {
    tailMutations += 1
    continue
  }
  violations.push(mutation)
}
const preexistingIds = new Set(observation.preexisting ?? [])
const preexistingViolations = violations.filter((mutation) => preexistingIds.has(mutation.id))

const tailChars = samples.map((sample) => sample.tailChars)
const grewSteps = tailChars.reduce((count, value, index) => (index > 0 && value > tailChars[index - 1] ? count + 1 : count), 0)
const growth = Math.max(...tailChars) - Math.min(...tailChars)
const rowsGrowth = (observation.rowsAtEnd ?? 0) - (observation.rowsAtStart ?? 0)

const report = {
  streamMs: observation.doneMs,
  rowsAtStart: observation.rowsAtStart,
  rowsAtEnd: observation.rowsAtEnd,
  rowsGrowth,
  preexistingRows: preexistingIds.size,
  frames: samples.length,
  mutations: observation.mutationCount,
  mutationsInRows: mutations.length,
  tailMutations,
  outsideRows: observation.outsideCount,
  violations: violations.length,
  selfTestSeen: observation.selfTestSeen === true,
  preexistingViolations: preexistingViolations.length,
  violationSample: violations.slice(0, 5),
  tailCharsGrowth: growth,
  tailCharsGrewSteps: grewSteps,
  tailCharsAtEnd: observation.tailCharsAtEnd,
}
console.log('ROW-ISOLATION ' + JSON.stringify(report))

const failures = []
if (observation.sawRunning !== true) failures.push('没看到回合真的开跑（状态行没出现，这轮没造出流式现场）')
if ((observation.doneMs ?? 0) < 3000) failures.push(`流式只跑了 ${String(observation.doneMs)}ms（要 ≥3 秒，太短不算证据）`)
if (preexistingIds.size < 8) failures.push(`观测前只有 ${String(preexistingIds.size)} 条行（历史种子没落上，现场不成立）`)
if ((observation.mutations ?? 0) === 0) failures.push('一条 DOM 变动都没采到（观测器没挂上，或界面根本没动）')
if (observation.selfTestSeen !== true) failures.push('观测器自检没通过（故意动了一条非尾行却没采到变动：观测器没挂上）')
if (violations.length > 0) {
  failures.push(`非尾行发生 ${String(violations.length)} 次 DOM 变动（应当为 0；样例 ${JSON.stringify(violations.slice(0, 2))}）`)
}
if (growth < 100) failures.push(`尾行字符数只涨了 ${String(growth)}（画面没真的在长，零变动不可信）`)
if (grewSteps < 8) failures.push(`尾行字符数只增了 ${String(grewSteps)} 个采样点（增长太断续）`)
if (rowsGrowth < 3) failures.push(`行数只涨了 ${String(rowsGrowth)}（流式没长出新行，现场不成立）`)

console.log(
  failures.length === 0
    ? `PASS 非尾行零变动（${String(preexistingIds.size)} 条历史行 + 尾窗外的行都没被碰），同时尾行在长（+${String(growth)} 字符 / ${String(rowsGrowth)} 行）`
    : 'FAIL ' + failures.join('; '),
)

try { electron.kill() } catch {}
server.close()
process.exit(failures.length === 0 ? 0 : 1)
