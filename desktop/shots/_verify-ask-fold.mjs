
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

process.on('unhandledRejection', () => {})

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const fakePort = 18977
const debugPort = 9333

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-ask', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:' + fakePort + '/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-ask', '        name: Fake Ask',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
}
delete env.ELECTRON_RUN_AS_NODE

const fake = spawn(process.execPath, [join(shots, 'ask2-fake-llm.mjs'), 'ask3', String(fakePort)], { env, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 900))

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

async function connect() {
  let seq = 0
  const pending = new Map()
  const ws = new WebSocket((await listPages())[0].webSocketDebuggerUrl)
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
  const send = (method, params) => {
    seq += 1
    const promise = new Promise((resolve, reject) => {
      pending.set(seq, { resolve, reject })
      ws.send(JSON.stringify({ id: seq, method, params }))
    })
    // 导航会让旧 target 的挂起请求整体失败：吸收这一份，别让未处理的拒绝掀了探针。
    promise.catch(() => {})
    return promise
  }
  try {
    await send('Runtime.enable')
  } catch (error) {
    try { ws.close() } catch {}
    throw error
  }
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression: '(async () => { ' + expression + ' })()',
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600))
    return result.result?.value
  }
  return { ws, send, evaluate }
}

let page = null
for (let i = 0; i < 80; i += 1) {
  const pages = await listPages()
  // 只连 http 那个 page：file:// 那个是壳的入口页，它马上会跳到宿主伺服地址，
  // 连上去的瞬间就导航，旧 target 的挂起请求全变成 -32000。
  const candidate = pages.find((p) => String(p.url).startsWith('http'))
  if (candidate) {
    try {
      const conn = await connect()
      const ok = await conn.evaluate('await new Promise((r) => setTimeout(r, 300)); return document.readyState')
      page = conn
      log += '\n[connected] ' + String(candidate.url).slice(0, 60) + ' ready=' + String(ok)
      break
    } catch (error) {
      log += '\n[retry] ' + String(error).slice(0, 120)
    }
  }
  await sleep(800)
}
if (page === null) throw new Error('connect failed: ' + log.slice(-800))

await page.send('Page.enable')
const shot = async (name) => {
  const data = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, name), Buffer.from(data.data, 'base64'))
}

const sendTurn = await page.evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 40; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(500)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '这次要动的范围我拿不准，你一次问清楚。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  const before = input.value
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  await wait(600)
  return { before, after: input.value, cards: document.querySelectorAll('.ask-card').length }
`)
console.log('sendTurn', JSON.stringify(sendTurn))

const open = await page.evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 40; i += 1) {
    const el = document.querySelector('.ask-card')
    if (el !== null && el.querySelector('.ask-text') !== null) break
    await wait(250)
  }
  const card = document.querySelector('.ask-card')
  if (card === null) return { error: 'no card' }
  const height = (node) => Math.round(node.getBoundingClientRect().height)
  const fold = card.querySelector('.ask-fold')
  return {
    count: card.getAttribute('data-ask-count'),
    open: card.getAttribute('data-open'),
    height: height(card),
    hasHead: card.querySelector('.ask-head') !== null,
    hasHeadTitle: card.querySelector('.ask-head-title') !== null,
    hasFold: fold !== null,
    expanded: fold === null ? null : fold.getAttribute('aria-expanded'),
    foldLabel: fold === null ? null : fold.getAttribute('title'),
    progress: (card.querySelector('.ask-progress') ?? {}).textContent ?? null,
    question: card.querySelector('.ask-text') === null ? null : card.querySelector('.ask-text').textContent,
    header: card.querySelector('.ask-header') === null ? null : card.querySelector('.ask-header').textContent,
  }
`)
console.log('open', JSON.stringify(open))
await shot('verify-ask-open.png')

const folded = await page.evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const card = document.querySelector('.ask-card')
  card.querySelector('.ask-fold').click()
  await wait(250)
  const panel = card.querySelector('.ask-panel')
  const foot = card.querySelector('.ask-foot')
  const visible = (node) => node !== null && node.offsetParent !== null && node.getBoundingClientRect().height > 0
  return {
    open: card.getAttribute('data-open'),
    height: Math.round(card.getBoundingClientRect().height),
    panelVisible: visible(panel),
    footVisible: visible(foot),
    title: card.querySelector('.ask-head-title') === null ? null : card.querySelector('.ask-head-title').textContent,
    titleLines: card.querySelector('.ask-head-title') === null ? null : Math.round(card.querySelector('.ask-head-title').getBoundingClientRect().height / parseFloat(getComputedStyle(card.querySelector('.ask-head-title')).lineHeight)),
    expanded: card.querySelector('.ask-fold').getAttribute('aria-expanded'),
    foldLabel: card.querySelector('.ask-fold').getAttribute('title'),
    padding: getComputedStyle(card).padding,
    gap: getComputedStyle(card).rowGap,
  }
`)
console.log('folded', JSON.stringify(folded))
await shot('verify-ask-folded.png')

const reopened = await page.evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const card = document.querySelector('.ask-card')
  card.querySelector('.ask-fold').click()
  await wait(250)
  const pick = card.querySelector('.ask-option')
  if (pick !== null) pick.click()
  await wait(300)
  card.querySelector('.ask-fold').click()
  await wait(200)
  const foldedAgain = { open: card.getAttribute('data-open'), height: Math.round(card.getBoundingClientRect().height) }
  card.querySelector('.ask-fold').click()
  await wait(250)
  const panel = card.querySelector('.ask-panel')
  const input = card.querySelector('.ask-input')
  return {
    foldedAgain,
    open: card.getAttribute('data-open'),
    height: Math.round(card.getBoundingClientRect().height),
    index: panel === null ? null : panel.getAttribute('data-ask-index'),
    picked: Array.from(card.querySelectorAll('.ask-option.picked')).map((n) => n.textContent),
    inputValue: input === null ? null : input.value,
  }
`)
console.log('reopened', JSON.stringify(reopened))
await shot('verify-ask-reopened.png')
try { page.ws.close() } catch {}
try { electron.kill() } catch {}
try { fake.kill() } catch {}
await sleep(500)
