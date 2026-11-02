process.on('unhandledRejection', () => {})

/**
 * 会话里的链接不许把主窗口导航走（2026-11-02 报障「点会话里的网址直接白屏」）。
 *
 * 病灶：正文里的 `<a href>` 没有 `target`，主窗口也没有 `will-navigate` / 开窗闸门，
 * 点一下主窗口就导航到那个网址——整片界面被换掉，加载不出来就是白屏，且没有后退路。
 *
 * 验收口径（四条，缺一不算过）：
 *   ① 点之前页面上有一颗指向外链的 `<a>`（说明种会话 / 渲染都对）；
 *   ② 点之后主窗口的地址没变（没被导航走）；
 *   ③ 应用壳还在（`#root` 里仍有 `.app`），不是白屏；
 *   ④ 原生侧把这次点击记成「交给系统浏览器」——`DSC_NO_EXTERNAL_OPEN=1` 时只记账不开窗，
 *      所以还能顺带断言「没有多出第二个页面」（没有新开 Electron 窗口）。
 *
 * 运行：node desktop/shots/_verify-link-open.mjs（依赖 desktop/out/ 与 lib/ui/）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-link-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const debugPort = 9351
const sessionId = 'link-open-demo'
const link = 'https://github.com/waq05/huixue-classroom'

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-link', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18998/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-link', '        name: Fake Link',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

// 种会话：一条用户消息 + 一段带 markdown 链接的回答（就是用户截图里那一句）。
const now = Date.now()
const lines = [
  { type: 'meta', id: sessionId, cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '将当前最终项目提交到新的 github 仓库里。', ts: now - 50000 },
  {
    type: 'assistant',
    text: `提交完成，兄弟。\n\n仓库：[huixue-classroom](${link})（私有）`,
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
  // 只记账、不真开系统浏览器：探针验的是「主窗口没被导航走」，不该给用户弹网页。
  DSC_NO_EXTERNAL_OPEN: '1',
}
delete env.ELECTRON_RUN_AS_NODE

const electron = process.env.DSC_PROBE_EXE
  ? // 打包装的产物也能验：`DSC_PROBE_EXE=...\Pneuma.exe node this.mjs`
    spawn(process.env.DSC_PROBE_EXE, ['--remote-debugging-port=' + debugPort], {
      cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'],
    })
  : spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
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

const failed = []

/** 等正文里那颗外链 `<a>` 上屏，返回它的文字、href 与矩形。 */
const waitLink = async () => evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  let found = null
  for (let i = 0; i < 120; i += 1) {
    found = [...document.querySelectorAll('.file-md a, .entry-text a, a')]
      .find((node) => String(node.getAttribute('href') ?? '').startsWith('https://')) ?? null
    if (found !== null) break
    await wait(250)
  }
  await wait(600)
  if (found === null) {
    return { found: false, href: location.href, bodyChars: document.body.innerText.length, body: document.body.innerText.slice(0, 300) }
  }
  const rect = found.getBoundingClientRect()
  return {
    found: true,
    href: location.href,
    text: found.textContent,
    link: found.getAttribute('href'),
    target: found.getAttribute('target'),
    box: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height },
  }
`)

const before = await waitLink()
console.log('before', JSON.stringify(before, null, 1))
await shot('_verify-link-before.png')
const pagesBefore = (await listPages()).length

if (!before.found) {
  failed.push('页面上找不到那颗外链（会话没渲染出来，或链接不是 https）')
} else {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: before.box.x, y: before.box.y, button: 'left', clickCount: 1,
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: before.box.x, y: before.box.y, button: 'left', clickCount: 1,
  })
  await sleep(1200)

  const after = await evaluate(`
    return {
      href: location.href,
      hasApp: document.querySelector('.app') !== null,
      bodyChars: document.body.innerText.length,
    }
  `)
  const pagesAfter = (await listPages()).length
  console.log('after', JSON.stringify({ ...after, pagesBefore, pagesAfter }, null, 1))
  await shot('_verify-link-after.png')

  if (after.href !== before.href) failed.push(`主窗口被导航走了：${before.href} → ${after.href}`)
  if (!after.hasApp) failed.push('应用壳没了（#root 里找不到 .app，就是白屏那种）')
  if (after.bodyChars < 40) failed.push(`点完正文只剩 ${String(after.bodyChars)} 个字符（空页面）`)
  if (pagesAfter !== pagesBefore) failed.push(`多出了页面：${String(pagesBefore)} → ${String(pagesAfter)}（不该新开窗口）`)
}

// ④ 原生侧确实把这次点击交给了「系统浏览器」这条路（自检档只记账）。
if (!log.includes('跳过打开外部链接：' + link)) {
  failed.push(`原生侧没有记录这次外链点击（stderr 里找不到「跳过打开外部链接：${link}」）`)
}

console.log(failed.length === 0 ? 'PASS 四条口径全过' : `FAIL ${failed.join('；')}`)

try { ws.close() } catch {}
try { electron.kill() } catch {}
await sleep(600)
process.exit(failed.length === 0 ? 0 : 1)
