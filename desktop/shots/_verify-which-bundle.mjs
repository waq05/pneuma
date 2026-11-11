// 已弃用：只打印不判定（2026-11-11 审计），用之前先补断言
process.on('unhandledRejection', () => {})

/**
 * 只回答一个问题：探针里那个 Electron 窗口到底加载的是哪一份 app-*.js，
 * 以及正文里的文件链接此刻的 outerHTML 长什么样。
 *
 * 运行：node desktop/shots/_verify-which-bundle.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-bundle-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const debugPort = 9367
const sessionId = 'bundle-demo'

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-code', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18988/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-code', '        name: Fake Code',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

const now = Date.now()
const lines = [
  { type: 'meta', id: sessionId, cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '点一下能直接预览吗？', ts: now - 50000 },
  {
    type: 'assistant',
    text: '- 文件：[package.json](D:\\dsc\\package.json)\n- 目录：[docs](D:\\dsc\\docs)',
    reasoning: '',
    ts: now - 40000,
  },
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
  join(root, 'desktop/out/main/index.js'), '--remote-debugging-port=' + String(debugPort),
], { cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
electron.stdout.on('data', (d) => { log += String(d) })
electron.stderr.on('data', (d) => { log += String(d) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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

const report = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelectorAll('.chat-inner .entry-row').length > 1) break
    await wait(250)
  }
  await wait(800)
  const scripts = [...document.scripts].map((node) => node.src)
  let bundleHasMarker = null
  try {
    const app = scripts.find((src) => src.includes('app-')) ?? ''
    const text = await (await fetch(app)).text()
    // 探针最关心的一件事：伺服出来的这份 app-*.js 里到底有没有本次改动的标记。
    bundleHasMarker = {
      app,
      len: text.length,
      mdFileLink: text.includes('md-file-link'),
      fileLinkOpener: text.includes('registerFileLinkOpener'),
      keepLocalHref: text.includes('defaultUrlTransform'),
    }
  } catch (error) { bundleHasMarker = { error: String(error) } }
  const anchors = [...document.querySelectorAll('.file-md a')].map((node) => node.outerHTML)
  return {
    href: location.href,
    scripts,
    bundleHasMarker,
    markdownBlocks: document.querySelectorAll('.file-md').length,
    anchors,
    text: (document.querySelector('.file-md')?.innerText ?? '').slice(0, 200),
  }
`)
console.log(JSON.stringify(report, null, 1))

try { ws.close() } catch {}
try { electron.kill() } catch {}
await sleep(400)
process.exit(0)
