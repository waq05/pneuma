process.on('unhandledRejection', () => {})

/**
 * 「子智能体」与「智能体团队」两分区的端到端复验（2026-11-08 四条需求里的界面三条）。
 *
 * 起因：标题旁那颗「智能体团队 1」与状态面板里的「智能体 / 共 1 位」列的是同一份名册，
 * 真正的共享任务板反而没有界面；别的会话派出的队友也能在这边看到。
 *
 * 验收口径：
 *   ① 标题旁没有 `.team-btn`（重复入口已撤）；
 *   ② 状态面板有「子智能体」区（`data-sp-section="agent"`），只列本会话的队友——别会话那条不出现；
 *   ③ 有任务时另有「智能体团队」区（`data-sp-section="team"`），任务行按任务板数据画；
 *   ④ 名册与任务板都空时，两区都不画（没用到就隐藏，不留空态）。
 *
 * 分两次启动跑（不 reload：重载窗口会打断 CDP 的 evaluate）：
 *   node desktop/shots/_verify-team-split.mjs            # 有数据，验 ①②③
 *   node desktop/shots/_verify-team-split.mjs --empty    # 空数据，验 ④
 *
 * 依赖 desktop/out/ 与 lib/ui/。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const empty = process.argv.includes('--empty')
const home = join(shots, empty ? '_verify-team-split-empty-home' : '_verify-team-split-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const debugPort = empty ? 9348 : 9347
const sessionId = 'team-split-demo'
const otherSessionId = 'team-split-other'

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(join(dsc, 'team', 'boards'), { recursive: true })
mkdirSync(join(dsc, 'team', 'inbox'), { recursive: true })
mkdirSync(join(dsc, 'agents'), { recursive: true })
mkdirSync(join(dsc, 'sessions', '.teammates', 'demo'), { recursive: true })
mkdirSync(work, { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-team', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18999/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-team', '        name: Fake Team',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

// 子智能体插件默认关：两区的数据（名册 / 任务板）都由它提供的 team 服务出，所以这里必须打开。
writeFileSync(join(dsc, 'plugins.json'), `${JSON.stringify({
  version: 1,
  entries: [{ file: 'subagent', disabled: false, config: {} }],
}, null, 2)}\n`)

const now = Date.now()
const sessionFile = join(dsc, 'sessions', 'demo', `${sessionId}.jsonl`)
writeFileSync(sessionFile, [
  { type: 'meta', id: sessionId, cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '把这次拆成两条任务，派个 explorer 去看代码。', ts: now - 50000 },
  { type: 'assistant', text: '好，任务已上板。', reasoning: '', ts: now - 40000 },
].map((line) => JSON.stringify(line)).join('\n') + '\n')

/** 一位队友的运行记录（点行才读，这里只要文件存在）。 */
const mateFile = (name) => join(dsc, 'sessions', '.teammates', 'demo', `${name}.jsonl`)
for (const name of ['explorer-1', 'writer-2', 'other-9']) {
  writeFileSync(mateFile(name), [
    { type: 'meta', id: `${name}-session`, cwd: work, createdAt: now - 30000 },
    { type: 'user', text: '看看工具注册那条线。', ts: now - 29000 },
    { type: 'assistant', text: '结论：工具注册在 tools-default。', reasoning: '', ts: now - 20000 },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n')
}

if (empty) {
  writeFileSync(join(dsc, 'team', 'roster.json'), `${JSON.stringify({ teammates: [] }, null, 2)}\n`)
  writeFileSync(join(dsc, 'team', 'boards', `${sessionId}.json`), `${JSON.stringify({ version: 1, revision: 0, tasks: [] }, null, 2)}\n`)
} else {  writeFileSync(join(dsc, 'team', 'roster.json'), `${JSON.stringify({
    teammates: [
      {
        name: 'explorer-1', role: 'explorer', state: 'idle', task: '读一遍工具注册链路，给出文件:行号',
        file: mateFile('explorer-1'), cwd: work, parent: 'lead', depth: 1, rounds: 3,
        startedAt: now - 30000, finishedAt: now - 20000, sessionId,
      },
      {
        name: 'writer-2', role: 'writer', state: 'working', task: '把两区拆开的界面补上',
        file: mateFile('writer-2'), cwd: work, parent: 'lead', depth: 1, rounds: 1,
        startedAt: now - 12000, sessionId,
      },
      {
        name: 'other-9', role: 'explorer', state: 'idle', task: '别的会话派的活',
        file: mateFile('other-9'), cwd: work, parent: 'lead', depth: 1, rounds: 2,
        startedAt: now - 40000, finishedAt: now - 35000, sessionId: otherSessionId,
      },
    ],
  }, null, 2)}\n`)
  writeFileSync(join(dsc, 'team', 'boards', `${sessionId}.json`), `${JSON.stringify({
    version: 1,
    revision: 3,
    tasks: [
      {
        id: 't1', subject: '拆开成员区与任务区', description: '状态面板里分「子智能体」与「智能体团队」两区，各自按需隐藏。',
        status: 'in_progress', owner: 'writer-2', blockedBy: [], writeScopes: ['src/packages/ui-status'],
        createdAt: now - 30000, updatedAt: now - 10000,
      },
      {
        id: 't2', subject: '补一条两分区的回归探针', description: '把标题旁入口撤掉、两区分开的断言钉进探针。',
        status: 'pending', owner: null, blockedBy: ['t1'], writeScopes: ['scripts'],
        createdAt: now - 25000, updatedAt: now - 25000,
      },
    ],
  }, null, 2)}\n`)
}

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
for (let i = 0; i < 60; i += 1) {
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
  await sleep(600)
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
const mouse = async (type, x, y) => {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
}

/** 等启动图退场、胶囊上屏，返回胶囊中心（面板没展开时给点一下用的坐标）。 */
const waitReady = async () => evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 200; i += 1) {
    const splash = document.getElementById('boot-splash')
    if (splash === null && document.querySelector('.topbar .tabs .sp-host') !== null) break
    await wait(250)
  }
  await wait(1200)
  const host = document.querySelector('.topbar .tabs .sp-host')
  if (host === null) return { found: false }
  const pill = host.querySelector('.sp-mini')
  const box = (pill ?? host).getBoundingClientRect()
  const expanded = host.querySelector('.sp')?.getAttribute('data-expanded') ?? null
  const title = document.querySelector('.topbar .tabs')?.textContent ?? ''
  return {
    found: true,
    expanded,
    title,
    pillCenter: { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 },
  }
`)

const readSections = async () => evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  // 名册 3 秒、任务板 5 秒各一拍，等它们都到齐
  await wait(6500)
  const agent = document.querySelector('[data-sp-section="agent"]')
  const team = document.querySelector('[data-sp-section="team"]')
  return {
    expanded: document.querySelector('.topbar .tabs .sp-host .sp')?.getAttribute('data-expanded') ?? null,
    teamButton: document.querySelector('.team-btn') !== null,
    agentPresent: agent !== null,
    agentNames: agent === null ? [] : [...agent.querySelectorAll('[data-sp-agent]')].map((n) => n.getAttribute('data-sp-agent')),
    teamPresent: team !== null,
    taskIds: team === null ? [] : [...team.querySelectorAll('[data-sp-task]')].map((n) => n.getAttribute('data-sp-task')),
    taskText: team === null ? '' : team.textContent,
  }
`)

const failed = []
const ready = await waitReady()
if (ready.found !== true) throw new Error('状态胶囊没上屏：' + log.slice(-600))
// 名册 3 秒、任务板 5 秒各一拍：数据没到之前面板是 hidden 分支，连胶囊都还没画出来。
await sleep(8000)
const expandedNow = await evaluate(`document.querySelector('.topbar .tabs .sp-host .sp')?.getAttribute('data-expanded') ?? null`)
if (expandedNow !== '1') {
  // 直接点胶囊：CDP 的按下/松开会被拖动逻辑当成一次手势，走 element.click() 更稳。
  await evaluate(`document.querySelector('.topbar .tabs .sp-host .sp-mini')?.click(); true`)
  await sleep(1000)
}
// 两个分区默认收起：点开标题，让截图里能看见行本身。
await evaluate(`
  document.querySelector('[data-sp-section-trigger="agent"]')?.click()
  document.querySelector('[data-sp-section-trigger="team"]')?.click()
  true
`)
await sleep(600)
const state = await readSections()
state.title = ready.title
console.log(empty ? 'empty' : 'withData', JSON.stringify(state, null, 1))
await shot(empty ? '_verify-team-split-empty.png' : '_verify-team-split-with-data.png')

if (state.teamButton) failed.push('标题旁仍有 .team-btn（重复入口没撤）')
if (empty) {
  if (state.agentPresent) failed.push('没有队友时「子智能体」区还在（没按需隐藏）')
  if (state.teamPresent) failed.push('没有任务时「智能体团队」区还在（没按需隐藏）')
} else {
  if (!state.agentPresent) failed.push('没有「子智能体」区')
  if (!state.agentNames.includes('explorer-1') || !state.agentNames.includes('writer-2')) {
    failed.push('「子智能体」区缺本会话的队友：' + JSON.stringify(state.agentNames))
  }
  if (state.agentNames.includes('other-9')) failed.push('「子智能体」区出现了别的会话的队友 other-9')
  if (!state.teamPresent) failed.push('没有「智能体团队」区')
  if (!state.taskIds.includes('t1') || !state.taskIds.includes('t2')) {
    failed.push('「智能体团队」区缺任务：' + JSON.stringify(state.taskIds))
  }
  if (typeof state.taskText === 'string' && !state.taskText.includes('拆开成员区与任务区')) {
    failed.push('任务行没画出任务标题')
  }
}

console.log('')
if (failed.length === 0) console.log(empty ? '空数据：全部通过（④）' : '有数据：全部通过（①②③）')
else for (const line of failed) console.log('FAIL  ' + line)

try { electron.kill() } catch {}
process.exit(failed.length === 0 ? 0 : 1)
