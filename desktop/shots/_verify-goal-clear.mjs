process.on('unhandledRejection', () => {})

/**
 * 目标条点 ✕ 清空之后，重启不会把它带回来（2026-11-02 报障的端到端复验）。
 *
 * 病灶：清空时 `persist()` 见快照是 null 就不写日志，jsonl 里最后一条 goal 记录仍是
 * 清空前那份，重启重放又读回来。
 *
 * 验收口径（四条，缺一不算过）：
 *   ① 种一条带目标的状态记录，启动之后目标条在（说明恢复链路本身是通的）；
 *   ② 点目标条上的 ✕，目标条当场消失；
 *   ③ 会话 jsonl 里**追加了一条 `goal = null`**（清空是写进日志的，不是只在内存里）；
 *   ④ 杀掉进程、用同一个会话重启，目标条不再出现（这才是用户报的那件事）。
 *
 * 运行：node desktop/shots/_verify-goal-clear.mjs（依赖 desktop/out/ 与 lib/ui/）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-goal-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const debugPort = 9357
const sessionId = 'goal-clear-demo'

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-goal', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18998/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-goal', '        name: Fake Goal',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

const snapshot = {
  id: 'goal-selfcheck',
  revision: 1,
  objective: '自检：清空目标之后重启不该回来',
  phase: 'active',
  maxRounds: 8,
  rounds: 0,
}
const now = Date.now()
const lines = [
  { type: 'meta', id: sessionId, cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '跑一轮自检。', ts: now - 50000 },
  { type: 'assistant', text: '好。', reasoning: '', ts: now - 40000 },
  { type: 'state', id: 'goal', payload: snapshot },
]
const sessionFile = join(dsc, 'sessions', 'demo', `${sessionId}.jsonl`)
writeFileSync(sessionFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failed = []

/**
 * 找「活的那份会话文件」：`Session.load` 恢复时会把后续写入落到 `sessions/<cwd 的 slug>/` 下
 * （不是用户给的那条路径），所以验收要读真正在写的那份。
 */
function liveSessionFile() {
  const dir = join(dsc, 'sessions', 'demo')
  const out = []
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl') && full !== sessionFile) out.push(full)
    }
  }
  const all = join(dsc, 'sessions')
  for (const entry of readdirSync(all, { withFileTypes: true })) {
    const full = join(all, entry.name)
    if (entry.isDirectory() && full !== dir) walk(full)
  }
  return out.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] ?? null
}

/** 起一次应用并连上 CDP，返回 { send, evaluate, shot, close }。 */
async function launch(resumePath) {
  const env = {
    ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
    DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
    DSC_RESUME_SESSION: resumePath,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
    join(root, 'desktop/out/main/index.js'), '--remote-debugging-port=' + debugPort,
  ], { cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  electron.stdout.on('data', (d) => { log += String(d) })
  electron.stderr.on('data', (d) => { log += String(d) })

  const listPages = async () => {
    try {
      const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()
      return (list ?? []).filter((p) => p.type === 'page')
    } catch { return [] }
  }

  let seq = 0
  const pending = new Map()
  let ws = null
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
        await send('Page.enable')
        connected = true
        break
      } catch {
        try { ws.close() } catch {}
      }
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
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600))
    return result.result?.value
  }
  const shot = async (name) => {
    const data = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(shots, name), Buffer.from(data.data, 'base64'))
  }
  const close = async () => {
    try { ws.close() } catch {}
    try { electron.kill() } catch {}
    // 等进程真的退出，下一个实例才能复用同一份 userData / 端口
    for (let i = 0; i < 40; i += 1) {
      if (electron.exitCode !== null) break
      await sleep(150)
    }
    await sleep(600)
  }
  return { send, evaluate, shot, close }
}

/** 等目标条出现（或确认它不出现）：返回它有没有、文案是什么。 */
const waitGoalBar = async (evaluate, wantVisible) => evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 40; i += 1) {
    const bar = document.querySelector('.goal-bar')
    if (bar !== null && ${wantVisible ? 'true' : 'false'}) return { present: true, text: bar.textContent }
    await wait(250)
  }
  const bar = document.querySelector('.goal-bar')
  return { present: bar !== null, text: bar === null ? null : bar.textContent }
`)

// ① 第一次启动：目标条应该在
const first = await launch(sessionFile)
const shown = await waitGoalBar(first.evaluate, true)
console.log('first', JSON.stringify(shown))
await first.shot('_verify-goal-before.png')
if (!shown.present) failed.push('第一次启动没画出目标条（恢复链路先坏了）')

// ② 点 ✕：目标条当场消失
if (shown.present) {
  const box = await first.evaluate(`
    const button = document.querySelector('.goal-bar .goal-btn.ghost')
    if (button === null) return null
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  `)
  if (box === null) {
    failed.push('目标条上找不到 ✕（.goal-btn.ghost）')
  } else {
    await first.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await first.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(1200)
    const afterClick = await first.evaluate(`
      return { present: document.querySelector('.goal-bar') !== null }
    `)
    console.log('afterClick', JSON.stringify(afterClick))
    await first.shot('_verify-goal-cleared.png')
    if (afterClick.present) failed.push('点了 ✕ 之后目标条还在')
  }
}
await first.close()

// ③ 日志里要有一条 goal = null（读真正在写的那份，不是种子那份）
const live = liveSessionFile()
console.log('liveSession', live)
if (live === null) {
  failed.push('找不到恢复之后真正在写的会话文件')
} else {
  const records = readFileSync(live, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
  const goalRecords = records.filter((record) => record.type === 'state' && record.id === 'goal')
  const last = goalRecords[goalRecords.length - 1]
  console.log('lastGoalRecord', JSON.stringify(last))
  if (last === undefined || last.payload !== null) {
    failed.push(`会话日志最后一条 goal 不是 null（${JSON.stringify(last?.payload)}）——清空没落盘`)
  }
}

// ④ 用这份会话重启：目标条不该再出现
if (live !== null) {
  const second = await launch(live)
  await sleep(2500)
  const revived = await waitGoalBar(second.evaluate, false)
  console.log('afterRestart', JSON.stringify(revived))
  await second.shot('_verify-goal-restarted.png')
  if (revived.present) failed.push(`重启之后目标条又出现了：${String(revived.text)}`)
  await second.close()
}

console.log(failed.length === 0 ? 'PASS 四条口径全过' : `FAIL ${failed.join('；')}`)
process.exit(failed.length === 0 ? 0 : 1)
