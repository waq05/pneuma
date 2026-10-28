/**
 * 实机验证：右侧刻度条「当前轮」高亮 + 新会话不再刷权限切换提示（2026-10-28 报障）。
 *
 * A 段：把用户那条真会话（人类 1 轮 + 子代理汇报 1 轮；汇报渲染成触发行、没有用户气泡）
 *       复制进隔离 HOME，打开后滚到底部读刻度条：
 *         - 刻度数 = 2
 *         - 高亮的刻度 = 第 1 轮（贴底就该是最新一轮）
 *         - 同时数出「带用户气泡的轮」只有 1 个 —— 这正是旧算法读成第 0 轮的原因
 * B 段：开一条全新会话，数对话里那三类权限提示，必须为 0。
 *
 * 隔离 HOME，不碰真实配置。用法：node desktop/shots/_verify-rail-current.mjs
 */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-rail-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const debugPort = 9341
const source = 'C:/Users/waq/.dsc/sessions/D-dsc/bb13f0b5-063a-4f37-8361-7a4118db4e27.jsonl'
const sessionRel = 'sessions/D-dsc/bb13f0b5-063a-4f37-8361-7a4118db4e27.jsonl'
const sessionPath = home.replace(/\\/g, '/') + '/.dsc/' + sessionRel

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'D-dsc'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(userData, { recursive: true })
copyFileSync(source, join(dsc, sessionRel))

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-code', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18981/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-code', '        name: Fake Code',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
// 偏好照用户那份来（这正是启动时被复算两三遍的那组值）
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({
  defaultPolicy: 'auto-edit',
  defaultReviewer: 'user',
  defaultPermissionPreset: 'workspace',
  defaultEffort: 'default',
  defaultPreset: '',
  marketSources: [],
  closeToTray: false,
  updateCheck: 'off',
  configFile: '',
}, null, 2))

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
}
delete env.ELECTRON_RUN_AS_NODE

const electron = spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
  join(root, 'desktop/out/main/index.js'), '--remote-debugging-port=' + debugPort,
], { cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
electron.stdout.on('data', (d) => { log += String(d) })
electron.stderr.on('data', (d) => { log += String(d) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const listPages = async () => {
  try {
    const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()
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
      connected = true
      break
    } catch {
      try { ws.close() } catch {}
    }
  }
  await sleep(800)
}
if (!connected) throw new Error('connect failed: ' + log.slice(-600))

const evaluate = async (body) => {
  const result = await send('Runtime.evaluate', {
    expression: '(async () => { ' + body + ' })()',
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800))
  return result.result?.value
}

const shot = async (name) => {
  const png = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, name), Buffer.from(png.data, 'base64'))
}

const boot = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 60; i += 1) {
    if (typeof window.dsc !== 'undefined' && document.querySelector('.composer textarea') !== null) break
    await wait(500)
  }
  return { ready: typeof window.dsc !== 'undefined' }
`)
console.log('boot', JSON.stringify(boot))

// ── B 段：全新会话里不许有权限切换提示 ──
const fresh = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  await window.dsc.invoke('openSession', [])
  await wait(1200)
  const rows = Array.from(document.querySelectorAll('.entry-system')).map((el) => el.innerText)
  const hits = rows.filter((t) => t.includes('权限模式切换为') || t.includes('审批审阅者切换为') || t.includes('权限预设切到'))
  const text = document.body.innerText
  return {
    noticeRows: hits,
    hasPolicyLine: text.includes('权限模式切换为'),
    hasReviewerLine: text.includes('审批审阅者切换为'),
    hasPresetLine: text.includes('权限预设切到'),
    systemRows: rows.length,
  }
`)
console.log('fresh', JSON.stringify(fresh))
await shot('_verify-rail-fresh.png')

// ── A 段：真会话滚到底，读刻度条 ──
const rail = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  await window.dsc.invoke('openSession', [${JSON.stringify(sessionPath)}])
  await wait(2000)
  const chat = document.querySelector('.chat')
  if (chat === null) return { error: 'no .chat' }
  chat.scrollTop = chat.scrollHeight
  await wait(1400)
  const ticks = Array.from(document.querySelectorAll('.jump-tick'))
  const active = ticks.filter((t) => t.getAttribute('aria-current') === 'true').map((t) => t.getAttribute('data-turn'))
  const roundRows = Array.from(chat.querySelectorAll('[data-round]')).map((el) => el.getAttribute('data-round'))
  return {
    ticks: ticks.length,
    active,
    humanAnchors: chat.querySelectorAll('.entry-user').length,
    roundsSeen: Array.from(new Set(roundRows)),
    gap: Math.round(chat.scrollHeight - chat.clientHeight - chat.scrollTop),
    railVisible: (() => { const r = document.querySelector('.jump-rail'); return r !== null && !r.hasAttribute('hidden') })(),
  }
`)
console.log('rail', JSON.stringify(rail))
await shot('_verify-rail-bottom.png')

try { ws.close() } catch {}
try { electron.kill() } catch {}
await sleep(400)
console.log('DONE')
