process.on('unhandledRejection', () => {})

/**
 * 一次性子智能体的界面复验（2026-11-08）：
 *   ① 状态面板里，一次性那一行带不带「一次性」标（普通队友不带）；
 *   ② 点开一次性那行，运行记录页的「发话」是不是置灰、旁边有没有说明。
 *
 * 名册由脚本直接种好（mode: 'one-shot'），不真派队友——派活要跑模型，
 * 这条要看的是界面怎么渲染那个字段。
 *
 * 跑法：node desktop/shots/_verify-one-shot.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-one-shot-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const debugPort = 9352
const sessionId = 'one-shot-demo'

rmSync(home, { recursive: true, force: true })
for (const rel of ['sessions/demo', 'usage', 'team/boards', 'team/inbox', 'agents', 'sessions/.teammates/demo']) {
  mkdirSync(join(dsc, rel), { recursive: true })
}
mkdirSync(work, { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-oneshot', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18997/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-oneshot', '        name: Fake OneShot',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
writeFileSync(join(dsc, 'plugins.json'), `${JSON.stringify({ version: 1, entries: [{ file: 'subagent', disabled: false, config: {} }] }, null, 2)}\n`)

const now = Date.now()
const sessionFile = join(dsc, 'sessions', 'demo', `${sessionId}.jsonl`)
writeFileSync(sessionFile, [
  { type: 'meta', id: sessionId, cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '查一下这两个版本号。', ts: now - 50000 },
  { type: 'assistant', text: '好，派一个只跑一次的去查。', reasoning: '', ts: now - 40000 },
].map((line) => JSON.stringify(line)).join('\n') + '\n')

const mateFile = (name) => join(dsc, 'sessions', '.teammates', 'demo', `${name}.jsonl`)
for (const name of ['explorer-1', 'once-1']) {
  writeFileSync(mateFile(name), [
    { type: 'meta', id: `${name}-session`, cwd: work, createdAt: now - 30000 },
    { type: 'user', text: '查版本号。', ts: now - 29000 },
    { type: 'assistant', text: '结论：根 0.9.0，桌面端 0.9.0。', reasoning: '', ts: now - 20000 },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n')
}
writeFileSync(join(dsc, 'team', 'roster.json'), `${JSON.stringify({
  teammates: [
    {
      name: 'explorer-1', role: 'explorer', state: 'idle', task: '读一遍工具注册链路',
      file: mateFile('explorer-1'), cwd: work, parent: 'lead', depth: 1, rounds: 2,
      startedAt: now - 30000, finishedAt: now - 20000, sessionId, mode: 'continuable',
    },
    {
      name: 'once-1', role: 'explorer', state: 'idle', task: '查两个版本号',
      file: mateFile('once-1'), cwd: work, parent: 'lead', depth: 1, rounds: 1,
      startedAt: now - 29000, finishedAt: now - 19000, sessionId, mode: 'one-shot',
    },
  ],
}, null, 2)}\n`)

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

let pages = []
for (let i = 0; i < 60; i += 1) {
  try { pages = (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).filter((p) => p.type === 'page') } catch { pages = [] }
  if (pages.length > 0) break
  await sleep(600)
}
if (pages.length === 0) { console.log('LOG', log.slice(-800)); electron.kill(); process.exit(1) }

const ws = new WebSocket(pages[0].webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data))
  const w = pending.get(m.id)
  if (w) { pending.delete(m.id); m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result) }
})
const send = (method, params) => new Promise((resolve, reject) => { seq += 1; pending.set(seq, { resolve, reject }); ws.send(JSON.stringify({ id: seq, method, params })) })
await send('Runtime.enable')
await send('Page.enable')

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression: '(async () => { ' + expression + ' })()', awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result?.value
}
const shot = async (name) => {
  const data = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, name), Buffer.from(data.data, 'base64'))
}

// 启动图退场 + 名册轮询到齐
for (let i = 0; i < 200; i += 1) {
  const ok = await evaluate(`document.getElementById('boot-splash') !== null ? false : document.querySelector('.topbar .tabs .sp-host') !== null`)
  if (ok) break
  await sleep(250)
}
await sleep(8000)
await evaluate(`document.querySelector('.topbar .tabs .sp-host .sp-mini')?.click(); true`)
await sleep(900)
await evaluate(`document.querySelector('[data-sp-section-trigger="agent"]')?.click(); true`)
await sleep(800)

const rows = await evaluate(`
  const list = [...document.querySelectorAll('[data-sp-section="agent"] .sp-row')]
  return list.map((row) => ({
    name: row.querySelector('[data-sp-agent]')?.getAttribute('data-sp-agent') ?? null,
    mode: row.getAttribute('data-sp-agent-mode'),
    badge: row.querySelector('.sp-row-mode')?.textContent ?? null,
  }))
`)
console.log('rows', JSON.stringify(rows, null, 1))

const onceBadge = rows.find((row) => row.name === 'once-1')?.badge ?? null
const normalBadge = rows.find((row) => row.name === 'explorer-1')?.badge ?? null
const checks = []
checks.push(['一次性那行有 mode 属性', rows.find((row) => row.name === 'once-1')?.mode === 'one-shot'])
checks.push(['一次性那行显示「一次性」', onceBadge === '一次性'])
checks.push(['普通队友那行不显示一次性标', normalBadge === null])

// 点开一次性那行：运行记录页的发话按钮该是置灰的
const reader = await evaluate(`
  const open = document.querySelector('[data-sp-section="agent"] [data-sp-agent="once-1"]')
  if (open === null) return { found: false }
  open.click()
  await new Promise((r) => setTimeout(r, 1500))
  const head = document.querySelector('.team-reader .team-reader-head')
  const buttons = head === null ? [] : [...head.querySelectorAll('button')]
  const message = buttons.find((b) => (b.textContent ?? '').trim() === '发话')
  return {
    found: true,
    reader: document.querySelector('.team-reader') !== null,
    messageButton: message === undefined ? null : { disabled: message.disabled, tip: message.getAttribute('data-tip') },
    note: document.querySelector('.team-reader .team-reader-note')?.textContent ?? null,
    buttons: buttons.map((b) => (b.textContent ?? '').trim()),
  }
`)
console.log('reader', JSON.stringify(reader, null, 1))
checks.push(['点开一次性那行能打开运行记录', reader.reader === true])
checks.push(['没有发话按钮（换成一句说明）', reader.messageButton === null])
checks.push(['说明里讲清「不支持后续消息」', typeof reader.note === 'string' && reader.note.includes('一次性')])
checks.push(['停止 / 移除 / 返回这些动作还在', (reader.buttons ?? []).includes('移除') && (reader.buttons ?? []).includes('返回原会话')])
// 先出一张列表图（面板展开，看得见「一次性」标），再藏掉浮层出一张头部图——
// 面板悬在右上角会压住头部那句说明，纯粹是截图取景问题，不是布局问题。
await shot('_verify-one-shot-row.png')
await evaluate(`
  const host = document.querySelector('.topbar .tabs .sp-host')
  if (host !== null) host.style.display = 'none'
  true
`)
await sleep(400)
await shot('_verify-one-shot-reader.png')

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed += 1
}
console.log(`${checks.length - failed}/${checks.length} 通过`)
console.log('LOG-tail', log.slice(-300))
electron.kill()
process.exit(failed === 0 ? 0 : 1)
