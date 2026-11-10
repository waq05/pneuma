/**
 * 流式期间的主线程占用测量（差距清单 S2 的验收工具）。
 *
 * 为什么要它：S2 说的是「每次 delta 整棵行树重渲染」。这种开销**不会**在 DOM 上留痕迹——
 * React 对没有变化的节点不写 DOM，所以数 DOM 变动是测不出来的。能测的是**主线程忙不忙**：
 * 流式期间用 `requestAnimationFrame` 采样每帧间隔，再看两档数字：
 *
 *   · `p50` / `p95` 帧间隔（ms）—— 主线程被 React 占住时，帧就被推后；
 *   · `over50` —— 间隔超过 50ms 的帧数（一次整树重渲染通常正好摔在这一档）。
 *
 * 造现场：一条**很长**的回合（假模型连做 20 轮「思考 + todo_write 调用」，最后给正文），
 * 全程约 20 秒、几百条条目流式进来。同一条脚本在改前 / 改后各跑一次，两组数字直接比。
 *
 * 运行：node desktop/shots/_perf-stream.mjs            （JSON 一行打在最后，便于抄数）
 * 产物：desktop/shots/_perf-stream.png（收工后的整屏，仅作旁证）
 *
 * 前提：`pnpm run build:ui` 已跑过（加载的是 lib/ui 里的插件包）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_perf-stream-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18999
const debugPort = 9379

const ROUNDS = Number(process.env.PERF_ROUNDS ?? 20)
const DELTAS_PER_ROUND = 8

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-perf', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-perf', '        name: Fake Perf',
  '        contextWindow: 128000', '        maxTokens: 8192', '',
].join('\n'))
// next-input：跑完的最后一轮先摊着，收工时过程区不会被折起来（测量时不夹带折叠动画）。
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({ ui: { collapseTiming: 'next-input' } }))

const now = Date.now()
writeFileSync(
  join(dsc, 'sessions', 'demo', 'perf-stream.jsonl'),
  [
    { type: 'meta', id: 'perf-stream', cwd: work, createdAt: now - 60000 },
    { type: 'user', text: '连做二十轮抽查，最后汇总。', ts: now - 50000 },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n',
)

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
    const calls = messages.filter((message) => message.role === 'assistant')
    const round = calls.length
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    if (round < ROUNDS) {
      // 每轮：几句思考 + 一次 todo_write。条目一条条长出来，正好压住整棵行树。
      const line = `第 ${String(round + 1)} 轮：核对这一批的边界条件，别漏掉空数组。\n`
      for (let index = 0; index < DELTAS_PER_ROUND; index += 1) {
        delta({ reasoning_content: line })
        await sleep(25)
      }
      delta({
        tool_calls: [{
          index: 0,
          id: `call_perf_${String(round)}`,
          type: 'function',
          function: {
            name: 'todo_write',
            arguments: JSON.stringify({ todos: [{ content: `第 ${String(round + 1)} 轮`, status: 'completed' }] }),
          },
        }],
      })
      delta({}, 'tool_calls')
      send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 50 } })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    delta({ content: '二十轮都过了一遍，没有发现漏项。' })
    await sleep(60)
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 50 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-perf] ${String(error)}\n`)
    try { res.end() } catch {}
  })
})
server.listen(fakePort, '127.0.0.1')

const env = { ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home, DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData }
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

// 渲染进程自己的耗时账（CDP 的 Performance 域）：TaskDuration / ScriptDuration 是**进程累积
// 秒数**，A/B 两次跑同一段流式，差值直接可比。比数帧间隔灵敏——帧间隔只能看出主线程有没有
// 被压垮（这套规模下压不垮），看不出「少干了多少活」。
await evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(250)
  }
  return null
`)
await send('Performance.enable')
const metricsOf = async () => {
  const result = await send('Performance.getMetrics')
  const map = {}
  for (const item of result.metrics ?? []) map[item.name] = item.value
  return map
}
const beforeMetrics = await metricsOf()

const started = await evaluate(`
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }

  // 采样：从发消息到收工的每一帧间隔（这是主线程忙不忙的直接读数）。
  const frames = []
  const longTasks = []
  let last = performance.now()
  let sampling = true
  const tick = () => {
    const now = performance.now()
    frames.push(now - last)
    last = now
    if (sampling) requestAnimationFrame(tick)
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration)
    }).observe({ entryTypes: ['longtask'] })
  } catch {}

  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '连做二十轮抽查，最后汇总。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(120)
  const t0 = performance.now()
  requestAnimationFrame(tick)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  // 等收工：轮尾出现、且这一轮不再活。
  let doneMs = 0
  for (let i = 0; i < 1200; i += 1) {
    if (document.querySelector('.round-foot') !== null && document.querySelector('.turn-status') === null) {
      doneMs = performance.now() - t0
      break
    }
    await wait(100)
  }
  await wait(600)
  sampling = false
  return {
    frames,
    longTasks,
    doneMs: Math.round(doneMs),
    rows: document.querySelectorAll('.entry-row').length,
    thinkBlocks: document.querySelectorAll('.think-block').length,
    toolCards: document.querySelectorAll('.tool-card').length,
  }
`)
if (started?.error !== undefined) throw new Error(String(started.error))

const afterMetrics = await metricsOf()
/** 两次快照之间这段时间里，渲染进程干了多少毫秒的活。 */
const spent = (name) => Math.round(((afterMetrics[name] ?? 0) - (beforeMetrics[name] ?? 0)) * 1000)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (typeof shot?.data === 'string') writeFileSync(join(shots, '_perf-stream.png'), Buffer.from(shot.data, 'base64'))

const frames = (started.frames ?? []).filter((value) => Number.isFinite(value) && value > 0)
const sorted = [...frames].sort((a, b) => a - b)
const at = (q) => (sorted.length === 0 ? 0 : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10)
const over = (limit) => frames.filter((value) => value > limit).length
const tasks = started.longTasks ?? []
const result = {
  rounds: ROUNDS,
  rows: started.rows,
  thinkBlocks: started.thinkBlocks,
  toolCards: started.toolCards,
  doneMs: started.doneMs,
  frames: frames.length,
  frameP50: at(0.5),
  frameP95: at(0.95),
  frameMax: Math.round(Math.max(0, ...frames) * 10) / 10,
  over50: over(50),
  over100: over(100),
  longTasks: tasks.length,
  longTaskMs: Math.round(tasks.reduce((sum, value) => sum + value, 0)),
  // 渲染进程在这一段里的真实开销（毫秒）：任务总时长 / 脚本 / 样式重算 / 布局。
  taskMs: spent('TaskDuration'),
  scriptMs: spent('ScriptDuration'),
  styleMs: spent('RecalcStyleDuration'),
  layoutMs: spent('LayoutDuration'),
}
console.log('PERF ' + JSON.stringify(result))

try { electron.kill() } catch {}
server.close()
process.exit(0)
