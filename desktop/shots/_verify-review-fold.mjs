/**
 * 「写前预览」折叠自检：真宿主 + 真壳 + CDP。
 *
 * 假端点回一个 write 调用 → 宿主在落盘前发一条「文件更改预览」→ 壳把它画成一行头。
 * 断言：默认收起（data-open=false、diff 不可见、头行高 ≈ 一行）、点开可见 diff、再点收起；
 * 轮尾汇总卡出现「已编辑 1 个文件」。
 * 截图：verify-review-folded.png（收起）/ verify-review-open.png（展开）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

process.on('unhandledRejection', () => {})

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-home-review')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18979
const debugPort = 9335
// 目标放在沙箱的临时可写根里：写盘真落地，轮尾那张汇总卡才会长出来（放 work/ 会被沙箱边界拦住）
mkdirSync(join(dsc, 'sandbox', 'tmp'), { recursive: true })
const target = join(dsc, 'sandbox', 'tmp', 'demo-review.md')

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-review', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:' + fakePort + '/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-review', '        name: Fake Review',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
// 全权放行：这条探针只看「写前预览长什么样」，不想被审批卡挡住写盘与轮尾汇总卡。
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({ defaultPolicy: 'full-access' }, null, 2), 'utf8')

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
}
delete env.ELECTRON_RUN_AS_NODE

const fake = spawn(process.execPath, [join(shots, '_verify-review-fake-llm.mjs'), String(fakePort), target], { env, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 900))

const electron = spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
  join(root, 'desktop/out/main/index.js'), '--remote-debugging-port=' + debugPort,
], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
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

const sent = await page.evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 40; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(500)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '写一个演示文件，我想看看改动预览长什么样。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  await wait(600)
  return { after: input.value }
`)
console.log('send', JSON.stringify(sent))

const folded = await page.evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  let card = null
  for (let i = 0; i < 60; i += 1) {
    card = document.querySelector('.entry-review')
    if (card !== null) break
    await wait(250)
  }
  if (card === null) return { error: 'no .entry-review' }
  await wait(1200)
  const head = card.querySelector('.entry-review-head')
  const diff = card.querySelector('.entry-review-diff')
  return {
    open: card.getAttribute('data-open'),
    headHeight: Math.round(head.getBoundingClientRect().height),
    headText: (head.textContent || '').trim().slice(0, 80),
    ariaExpanded: head.getAttribute('aria-expanded'),
    diffPresent: diff !== null,
    diffVisible: diff === null ? false : diff.offsetParent !== null,
    cardHeight: Math.round(card.getBoundingClientRect().height),
  }
`)
console.log('folded', JSON.stringify(folded))
await shot('verify-review-folded.png')

const opened = await page.evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const card = document.querySelector('.entry-review')
  if (card === null) return { error: 'no card' }
  card.querySelector('.entry-review-head').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(600)
  const diff = card.querySelector('.entry-review-diff')
  return {
    open: card.getAttribute('data-open'),
    ariaExpanded: card.querySelector('.entry-review-head').getAttribute('aria-expanded'),
    diffVisible: diff === null ? false : diff.offsetParent !== null,
    diffHeight: diff === null ? 0 : Math.round(diff.getBoundingClientRect().height),
    lines: diff === null ? 0 : diff.querySelectorAll('.entry-review-line').length,
  }
`)
console.log('opened', JSON.stringify(opened))
await shot('verify-review-open.png')

// 审批卡大概率已经弹在预览卡下面（预览是先发的，审批是后到的）：点「这次允许」让写盘落地，
// 轮尾才会长出一张「已编辑 N 个文件」。点不到也没关系，后面的断言会如实说没等到。
const allowed = await page.evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  let clicked = null
  for (let i = 0; i < 24; i += 1) {
    // 按钮文字带快捷键尾巴（「这次允许 y」），用前缀匹配，别用等号
    const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('这次允许'))
    if (button !== undefined) {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      clicked = '这次允许'
      break
    }
    await wait(250)
  }
  await wait(600)
  return { clicked }
`)
console.log('allow', JSON.stringify(allowed))

const refolded = await page.evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const card = document.querySelector('.entry-review')
  card.querySelector('.entry-review-head').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(400)
  const diff = card.querySelector('.entry-review-diff')
  // 轮尾汇总卡要等回合收尾（turn/end 之后的 git 差集聚合），最多等 8 秒
  let changes = null
  for (let i = 0; i < 32; i += 1) {
    changes = document.querySelector('.changes-card .changes-title')
    if (changes !== null) break
    await wait(250)
  }
  return {
    open: card.getAttribute('data-open'),
    diffVisible: diff === null ? false : diff.offsetParent !== null,
    changesTitle: changes === null ? null : (changes.textContent || '').trim(),
    status: document.body.textContent.includes('回合进行中') ? 'running' : 'idle',
  }
`)
console.log('refolded', JSON.stringify(refolded))

const problems = []
if (folded.error !== undefined) problems.push('折叠态没拿到卡：' + JSON.stringify(folded))
if (folded.open !== 'false') problems.push('默认不是收起：data-open=' + String(folded.open))
if (folded.diffVisible !== false) problems.push('收起时 diff 还可见')
if (!(folded.headHeight > 0 && folded.headHeight < 44)) problems.push('头行高不是一行：' + String(folded.headHeight))
if (opened.open !== 'true' || opened.diffVisible !== true) problems.push('点开没展开：' + JSON.stringify(opened))
if (!(opened.lines > 10)) problems.push('展开后 diff 行数不对：' + String(opened.lines))
if (refolded.open !== 'false' || refolded.diffVisible !== false) problems.push('再点没收回：' + JSON.stringify(refolded))
// 只改了一个文件时，汇总卡的标题是文件名本身（多文件才写「已编辑 N 个文件」，见 ChangesCard）。
if (refolded.changesTitle !== 'demo-review.md') problems.push('轮尾汇总卡标题不对：' + String(refolded.changesTitle))

console.log('')
console.log(problems.length === 0 ? 'PASS 写前预览折叠自检全绿' : 'FAIL ' + problems.join(' | '))
try { page.ws.close() } catch {}
electron.kill()
fake.kill()
await sleep(400)
process.exit(problems.length === 0 ? 0 : 1)
