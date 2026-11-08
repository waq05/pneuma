process.on('unhandledRejection', () => {})

/**
 * 状态面板两处报障的现场复验（2026-11-08）：
 *   ① Git 区 / 进程区还在不在（造出脏仓库 + 任务清单，看它们画不画）；
 *   ② 点「子智能体」一行，正文区只读运行记录打不打得开；
 *   ③ hover 任务行时底色有没有铺满到卡片右缘（量宽度，不靠眼睛）。
 *
 * 跑法：node desktop/shots/_verify-status-rows.mjs
 */
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-status-rows-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const debugPort = 9351
const sessionId = 'status-rows-demo'

rmSync(home, { recursive: true, force: true })
for (const rel of ['sessions/demo', 'usage', 'team/boards', 'team/inbox', 'agents', 'sessions/.teammates/demo']) {
  mkdirSync(join(dsc, rel), { recursive: true })
}
mkdirSync(work, { recursive: true })

// 脏仓库：一次提交之后改一个文件，git-status 才会报「1 个文件」。
execSync('git init -q && git config user.email t@t && git config user.name t && echo a > a.txt && git add . && git commit -qm init', { cwd: work })
writeFileSync(join(work, 'a.txt'), 'changed\n')

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-rows', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18997/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-rows', '        name: Fake Rows',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
writeFileSync(join(dsc, 'plugins.json'), `${JSON.stringify({ version: 1, entries: [{ file: 'subagent', disabled: false, config: {} }] }, null, 2)}\n`)

const now = Date.now()
const sessionFile = join(dsc, 'sessions', 'demo', `${sessionId}.jsonl`)
writeFileSync(sessionFile, [
  { type: 'meta', id: sessionId, cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '把这次拆成两条任务。', ts: now - 50000 },
  {
    type: 'state',
    id: 'todos',
    payload: [
      { id: 't1', content: '拆开成员区与任务区', status: 'in_progress' },
      { id: 't2', content: '补一条回归探针', status: 'pending' },
    ],
  },
  { type: 'assistant', text: '好，任务已上板。', reasoning: '', ts: now - 40000 },
].map((line) => JSON.stringify(line)).join('\n') + '\n')

const mateFile = (name) => join(dsc, 'sessions', '.teammates', 'demo', `${name}.jsonl`)
for (const name of ['explorer-1', 'sub-a', 'team-b']) {
  writeFileSync(mateFile(name), [
    { type: 'meta', id: `${name}-session`, cwd: work, createdAt: now - 30000 },
    { type: 'user', text: '看看工具注册那条线。', ts: now - 29000 },
    { type: 'assistant', text: '结论：工具注册在 tools-default。', reasoning: '', ts: now - 20000 },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n')
}
writeFileSync(join(dsc, 'team', 'roster.json'), `${JSON.stringify({
  teammates: ['explorer-1', 'sub-a', 'team-b'].map((name, index) => ({
    name, role: 'explorer', state: 'idle', task: '读一遍工具注册链路',
    file: mateFile(name), cwd: work, parent: 'lead', depth: 1, rounds: 2,
    startedAt: now - 30000 + index, finishedAt: now - 20000, sessionId,
  })),
}, null, 2)}\n`)
writeFileSync(join(dsc, 'team', 'boards', `${sessionId}.json`), `${JSON.stringify({
  version: 1,
  revision: 1,
  tasks: [{
    id: 't1',
    subject: '交互演示：认领后一句话汇报',
    description: '这是一条演示任务，用来观察「队友 + 共享任务板」的协作链路。要求：认领本任务的队友，认领成功后只回一句话，内容包含你的队友名、本任务 id、当前状态（应为 in_progress）。不要读文件，不要改代码，不要做其他事。',
    status: 'completed', owner: 'lead', blockedBy: [], writeScopes: [],
    createdAt: now - 25000, updatedAt: now - 20000,
  }],
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

// 启动图退场 + 数据轮询到齐（名册 3 秒 / 任务板 5 秒 / git 12 秒档）。
for (let i = 0; i < 200; i += 1) {
  const ok = await evaluate(`document.getElementById('boot-splash') !== null ? false : document.querySelector('.topbar .tabs .sp-host') !== null`)
  if (ok) break
  await sleep(250)
}
await sleep(14000)
await evaluate(`document.querySelector('.topbar .tabs .sp-host .sp-mini')?.click(); true`)
await sleep(900)
await evaluate(`
  for (const id of ['git', 'todo', 'agent', 'team']) document.querySelector('[data-sp-section-trigger="' + id + '"]')?.click()
  true
`)
await sleep(800)

const measures = await evaluate(`
  const host = document.querySelector('.topbar .tabs .sp-host')
  const sp = host.querySelector('.sp')
  const card = sp.getBoundingClientRect()
  const pick = (selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    const box = node.getBoundingClientRect()
    return { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) }
  }
  const row = document.querySelector('[data-sp-section="team"] .sp-row')
  const list = document.querySelector('[data-sp-section="team"] .sp-list')
  const scroll = document.querySelector('[data-sp-section="team"] .sp-section-scroll')
  return {
    card: { left: Math.round(card.left), right: Math.round(card.right), width: Math.round(card.width) },
    sections: [...document.querySelectorAll('[data-sp-section]')].map((n) => n.getAttribute('data-sp-section')),
    row: row === null ? null : pick('[data-sp-section="team"] .sp-row'),
    rowOpen: pick('[data-sp-section="team"] .sp-row .sp-row-open'),
    detail: pick('[data-sp-section="team"] .sp-task-detail'),
    list: list === null ? null : { right: Math.round(list.getBoundingClientRect().right), width: Math.round(list.getBoundingClientRect().width) },
    scroll: scroll === null ? null : { right: Math.round(scroll.getBoundingClientRect().right), width: Math.round(scroll.getBoundingClientRect().width), paddingRight: getComputedStyle(scroll).paddingRight },
    styleOfRow: row === null ? null : ((s) => ({ paddingRight: s.paddingRight, paddingLeft: s.paddingLeft, width: s.width, display: s.display, flexWrap: s.flexWrap }))(getComputedStyle(row)),
  }
`)
console.log('measures', JSON.stringify(measures, null, 1))

// 展开任务详情，再 hover 任务行：用户报的「底色没铺满」出现在详情展开时。
await evaluate(`
  const open = document.querySelector('[data-sp-section="team"] .sp-row [data-sp-task]')
  open?.click()
  true
`)
await sleep(500)
const detailMeasures = await evaluate(`
  const row = document.querySelector('[data-sp-section="team"] .sp-row')
  const detail = row?.querySelector('.sp-task-detail')
  const card = document.querySelector('.topbar .tabs .sp-host .sp').getBoundingClientRect()
  const box = row?.getBoundingClientRect()
  const detailBox = detail?.getBoundingClientRect()
  const style = detail === null || detail === undefined ? null : getComputedStyle(detail)
  return {
    cardRight: Math.round(card.right),
    rowRight: box === undefined ? null : Math.round(box.right),
    rowWidth: box === undefined ? null : Math.round(box.width),
    detailRight: detailBox === undefined ? null : Math.round(detailBox.right),
    detailWidth: detailBox === undefined ? null : Math.round(detailBox.width),
    detailPaddingRight: style === null ? null : style.paddingRight,
    detailFlexBasis: style === null ? null : style.flexBasis,
  }
`)
console.log('detail', JSON.stringify(detailMeasures, null, 1))

// hover 任务行，再截一张（看底色有没有铺满）
const hoverPoint = await evaluate(`
  const row = document.querySelector('[data-sp-section="team"] .sp-row')
  if (row === null) return null
  const box = row.getBoundingClientRect()
  return { x: Math.round((box.left + box.right) / 2), y: Math.round(box.top + 8) }
`)
if (hoverPoint !== null) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverPoint.x, y: hoverPoint.y })
  await sleep(400)
}
await shot('_verify-status-rows-hover.png')

// 点子智能体第一行：正文区该出现只读运行记录
const clicked = await evaluate(`
  const row = document.querySelector('[data-sp-section="agent"] .sp-row [data-sp-agent]')
  if (row === null) return { found: false }
  row.click()
  await new Promise((r) => setTimeout(r, 1500))
  return {
    found: true,
    reader: document.querySelector('.team-reader') !== null,
    threadChildren: (document.querySelector('[data-thread-area]')?.children.length ?? -1),
    bodyText: document.body.innerText.slice(0, 200),
  }
`)
console.log('click', JSON.stringify(clicked, null, 1))
await shot('_verify-status-rows-click.png')

console.log('LOG-tail', log.slice(-300))
electron.kill()
process.exit(0)
