process.on('unhandledRejection', () => {})

/**
 * 后台作业完成通知画成「唤醒卡」，不是用户气泡（2026-11-02 报障、2026-11-08 换成卡片）。
 *
 * 这条探针走的是**重放**那条路（比「真起一个后台作业」确定得多）：种一份会话日志，
 * 里面有一条 `origin: 'notice'` 的 user 记录（内核收工通知落库后的形状），然后让真宿主
 * 打开它。修的判据正好在重放链路上：日志 → Session 解析 → replayHistory → reduce → 界面。
 *
 * 验收口径（六条，缺一不算过）：
 *   ① 有一条 `.trigger-card[data-trigger="job"]`（唤醒卡），标题是「后台作业 job-3 完成了」；
 *   ② 它**默认收起**（aria-expanded=false），点一下展开（true）；
 *   ③ 展开后正文是通知全文（pre 里那段原文，信息没丢）；
 *   ④ 人打的那条仍是 `.entry-user` 气泡，且**没有任何气泡**的正文含「后台作业」；
 *   ⑤ 卡上不挂编辑 / 重发按钮（它不是人说的话，不能改）；
 *   ⑥ 卡与上一行的间距是过程区的 3px，不是「空盒子叠出来的一片白」。
 *
 * 运行：node desktop/shots/_verify-notice-row.mjs（依赖桌面产物 desktop/out/）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-notice-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const debugPort = 9344
const sessionId = 'notice-row-demo'

const JOB_DONE = '后台作业 job-3（Set-Location group4\最终项目\frontend; npm run build）成功完成。用 job_output(job_id="job-3") 查看输出，job_list 清点全部作业。'
const HUMAN = '先起一个后台构建，我等着它收工。'

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-notice', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18999/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-notice', '        name: Fake Notice',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

// 种会话：人打的字 + 一条机器投递的通知（内核落库后的形状，只有 origin 这一个区别）
const now = Date.now()
const lines = [
  { type: 'meta', id: sessionId, cwd: work, createdAt: now - 60000 },
  { type: 'user', text: HUMAN, ts: now - 50000 },
  { type: 'assistant', text: '先把后台构建起起来，我等它收工。', reasoning: '', ts: now - 40000 },
  { type: 'user', text: JOB_DONE, origin: 'notice', ts: now - 30000 },
  { type: 'assistant', text: '收到，去读 job-3 的输出。', reasoning: '', ts: now - 20000 },
]
const sessionFile = join(dsc, 'sessions', 'demo', `${sessionId}.jsonl`)
writeFileSync(sessionFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
  DSC_RESUME_SESSION: sessionFile,
}
delete env.ELECTRON_RUN_AS_NODE

const electron = spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
  join(root, 'desktop/out/main/index.js'), '--remote-debugging-port=' + debugPort,
], { cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
electron.stdout.on('data', (d) => { log += String(d) })
electron.stderr.on('data', (d) => { log += String(d) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function listPages() {
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

let page = null
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
      page = candidate
      break
    } catch {
      try { ws.close() } catch {}
    }
  }
  await sleep(800)
}
if (page === null) throw new Error('connect failed: ' + log.slice(-600))

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

const ui = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.entry-user, .trigger-card') !== null) break
    await wait(250)
  }
  await wait(800)
  const cards = [...document.querySelectorAll('.trigger-card')]
  const card = cards[0]
  const head = card === undefined ? null : card.querySelector('.trigger-head')
  const collapsed = head === null ? null : head.getAttribute('aria-expanded')
  if (head !== null) head.click()
  await wait(250)
  const body = card === null ? null : (card.querySelector('.trigger-text')?.textContent ?? null)
  const bubbles = [...document.querySelectorAll('.entry-user')]
  // 与上一行的间距：过程区是 gap: 3px 的 flex 列，空盒子会叠出额外的一片白
  const seat = card === null ? null : card.closest('.turn-seat')
  const prev = card === null ? null : card.closest('.entry-row')?.previousElementSibling
  const gap = prev === undefined || prev === null || card === null
    ? null
    : Math.round(card.getBoundingClientRect().top - prev.getBoundingClientRect().bottom)
  return {
    count: cards.length,
    kind: card === undefined ? null : card.getAttribute('data-trigger'),
    title: card === undefined ? null : (card.querySelector('.trigger-title')?.textContent ?? null),
    collapsed,
    expanded: head === null ? null : head.getAttribute('aria-expanded'),
    body,
    hasAct: card !== null && card.querySelector('.user-act, .user-edit') !== null,
    bubbles: bubbles.map((node) => node.textContent),
    bubblesWithJob: bubbles.filter((node) => node.textContent.includes('job_output')).length,
    gap,
    seatCls: seat === null ? null : String(seat.className),
  }
`)
console.log('ui', JSON.stringify(ui, null, 1))

const failed = []
if (ui.count !== 1) failed.push(`唤醒卡应当是 1 张，实际 ${String(ui.count)}`)
if (ui.kind !== 'job') failed.push(`来源档位不对：${String(ui.kind)}`)
if (ui.title !== '后台作业 job-3 完成了') failed.push(`标题不对：${String(ui.title)}`)
if (ui.collapsed !== 'false') failed.push(`默认应当是收起的，实际 aria-expanded=${String(ui.collapsed)}`)
if (ui.expanded !== 'true') failed.push('点一下没有展开')
if (ui.body === null || !ui.body.includes('job_output')) failed.push(`展开后不是通知原文：${String(ui.body)}`)
if (ui.hasAct) failed.push('唤醒卡上挂了编辑 / 重发按钮')
if (ui.bubblesWithJob !== 0) failed.push(`仍有 ${String(ui.bubblesWithJob)} 个气泡的正文是通知原文`)
if (!ui.bubbles.some((text) => text.includes('先起一个后台构建'))) failed.push('人打的那条气泡不见了')
if (ui.gap !== null && ui.gap !== 3) failed.push(`与上一行的间距应当是 3px，实际 ${String(ui.gap)}px`)

console.log(failed.length === 0 ? 'PASS 六条口径全过' : `FAIL ${failed.join('；')}`)
await shot('_verify-notice-row.png')

try { ws.close() } catch {}
try { electron.kill() } catch {}
await sleep(600)
process.exit(failed.length === 0 ? 0 : 1)
