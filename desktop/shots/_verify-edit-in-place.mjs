process.on('unhandledRejection', () => {})

/**
 * 真机复验（2026-11-03 的两条界面报障）：
 *
 * ① 轮尾的「用量 · 时刻」要跟复制 / 分叉一样**悬浮才出现**（截图里那行小字常驻）；
 * ② 点铅笔重新编辑，要**留在当前会话**里截断重来——不再分叉出一条新会话。
 *
 * 口径：
 *   [1] 不悬浮时 `.round-tokens` / `.round-clock` 的 opacity 是 0（看不见）；
 *   [2] 鼠标压到这一轮的输出上，两者 opacity 变 1（看得见），且文案里有 tok 与时刻；
 *   [3] 点第一条用户消息的铅笔 → 改写 → 重发：侧栏当前会话**没换**（同一行仍亮着）；
 *   [4] 第二轮的回答从正文里消失（被作废），第一轮的题面还在；
 *   [5] 改过的文字出现在正文里，且成了最后一条；
 *   [6] 会话文件里多了一条 `rewind` 记录，原文仍在（append-only，可回查）。
 *
 * 运行：node desktop/shots/_verify-edit-in-place.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-edit-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work', 'alpha')
const debugPort = 9381
const slugCwd = (cwd) => cwd.replace(/[\\/:]+/g, '-')

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-edit', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18997/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-edit', '        name: Fake Edit',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

// ── 种子：两轮问答（第一轮要留，第二轮要被编辑作废）────────────────────────────
const now = Date.now()
const id = 'edit-in-place-0001'
const dir = join(dsc, 'sessions', slugCwd(work))
mkdirSync(dir, { recursive: true })
const file = join(dir, `${id}.jsonl`)
const lines = [
  { type: 'meta', id, cwd: work, createdAt: now - 900000 },
  { type: 'user', text: '【第一轮】请把 README 里的安装步骤写清楚。', ts: now - 899000 },
  { type: 'assistant', text: '【第一轮回答】已经写清楚了，见 README 第 3 节。', reasoning: '', ts: now - 898000 },
  { type: 'user', text: '【第二轮】再把常见问题补一节。', ts: now - 897000 },
  { type: 'assistant', text: '【第二轮回答】常见问题已经补上，共 5 条。', reasoning: '', ts: now - 896000 },
]
writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
const before = readFileSync(file, 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failed = []
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failed.push(label)
  console.log(`  FAIL ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
  DSC_RESUME_SESSION: file,
}
delete env.ELECTRON_RUN_AS_NODE
const electron = process.env.DSC_PROBE_EXE
  ? spawn(process.env.DSC_PROBE_EXE, ['--remote-debugging-port=' + debugPort], {
    cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  : spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
    join(root, 'desktop/out/main/index.js'), '--remote-debugging-port=' + debugPort,
  ], { cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
electron.stdout.on('data', (d) => { log += String(d) })
electron.stderr.on('data', (d) => { log += String(d) })

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
  try {
    const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()
    const candidate = (list ?? []).find((p) => p.type === 'page' && String(p.url).startsWith('http'))
    if (candidate) {
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
    }
  } catch {
    try { ws?.close() } catch {}
  }
  await sleep(800)
}
if (!connected) {
  console.log('FAIL 连不上 CDP：' + log.slice(-800))
  try { electron.kill() } catch {}
  process.exit(1)
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
const shot = async (name) => {
  const data = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, name), Buffer.from(data.data, 'base64'))
}
const move = async (x, y) => {
  // 挪两格：只发一次 mouseMoved 时，Chromium 偶尔要等到下一次真实移动才更新 :hover
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 1, y: y + 1 })
}

/** 等一个元素的不透明度稳定到某个值（最多 3 秒）：transition 在跑，固定 sleep 取不准。 */
const waitOpacity = (selector, want) => evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const node = document.querySelector(${JSON.stringify(selector)})
  if (node === null) return null
  for (let i = 0; i < 40; i += 1) {
    const value = Number(getComputedStyle(node).opacity)
    if (Math.abs(value - ${want}) < 0.01) return value
    await wait(80)
  }
  return Number(getComputedStyle(node).opacity)
`)
const click = (x, y) =>
  send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }).then(() =>
    send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }))

await sleep(4500)

console.log('\n[1] 不悬浮：轮尾的用量与时刻看不见')
{
  const state = await evaluate(`
    const foot = document.querySelector('.turn-seat .round-foot')
    if (foot === null) return { found: false }
    const tokens = foot.querySelector('.round-tokens')
    const clock = foot.querySelector('.round-clock')
    return {
      found: true,
      tokens: tokens === null ? null : { text: tokens.textContent.trim(), opacity: getComputedStyle(tokens).opacity },
      clock: clock === null ? null : { text: clock.textContent.trim(), opacity: getComputedStyle(clock).opacity },
    }
  `)
  check('找到了轮尾', state.found === true)
  check('用量确实画出来了（只是透明）', state.tokens !== null && state.tokens.text.includes('tok'), JSON.stringify(state.tokens))
  check('用量默认 opacity 0', state.tokens !== null && Number(state.tokens.opacity) === 0, JSON.stringify(state.tokens))
  check('时刻默认 opacity 0', state.clock !== null && Number(state.clock.opacity) === 0, JSON.stringify(state.clock))
}

console.log('\n[2] 悬浮到这一轮的输出上：两者浮现')
{
  const box = await evaluate(`
    const seat = [...document.querySelectorAll('.turn-seat')].find((item) =>
      (item.textContent || '').includes('第一轮回答'))
    if (seat === undefined) return null
    const output = seat.querySelector(':scope > *:not(:first-child)')
    if (output === null) return null
    const rect = output.getBoundingClientRect()
    return { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + rect.height / 2 }
  `)
  if (box === null) {
    check('找得到第一轮的回答块', false)
  } else {
    await move(box.x, box.y)
    const shownTokens = await waitOpacity('.turn-seat .round-foot .round-tokens', 1)
    const shownClock = await waitOpacity('.turn-seat .round-foot .round-clock', 1)
    check('悬浮后用量浮现', shownTokens === 1, String(shownTokens))
    check('悬浮后时刻浮现', shownClock === 1, String(shownClock))
    const text = await evaluate(`return document.querySelector('.turn-seat .round-foot .round-tokens')?.textContent.trim() ?? ''`)
    check('浮现的是用量读数（带 tok）', text.includes('tok'), text)
    await shot('_verify-edit-1-hover.png')
    // 鼠标挪开：应该又淡回去
    await move(8, 8)
    const hidden = await waitOpacity('.turn-seat .round-foot .round-tokens', 0)
    check('鼠标离开后又隐藏', hidden === 0, String(hidden))
    await shot('_verify-edit-2-idle.png')
  }
}

console.log('\n[3] 点第一条用户消息的铅笔，改写后重发')
{
  // 先悬浮出编辑钮再点
  const btnBox = await evaluate(`
    const seat = [...document.querySelectorAll('.turn-seat')].find((item) =>
      (item.textContent || '').includes('第一轮'))
    if (seat === undefined) return null
    const user = seat.querySelector('.user-turn')
    user.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    const button = seat.querySelector('.user-actions .user-act')
    if (button === null) return null
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  `)
  check('找得到编辑钮', btnBox !== null)
  if (btnBox !== null) {
    await click(btnBox.x, btnBox.y)
    await sleep(400)
    const editing = await evaluate(`return document.querySelector('.user-edit-box') !== null`)
    check('编辑框打开了', editing === true)

    // 用原生 setter 写值（React 受控组件要这么写），再按 Enter
    await evaluate(`
      const box = document.querySelector('.user-edit-box')
      if (box === null) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(box, '【改过】请把 README 的安装步骤写成三步。')
      box.dispatchEvent(new Event('input', { bubbles: true }))
      box.focus()
      return true
    `)
    await sleep(200)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await sleep(3000)
    await shot('_verify-edit-3-after.png')
  }
}

console.log('\n[4] 结果：还在当前会话，第二轮被作废')
{
  const state = await evaluate(`
    const body = document.querySelector('.chat')?.textContent ?? ''
    const active = [...document.querySelectorAll('.sidebar .sess-item.active')].map((row) => (row.textContent || '').trim().slice(0, 40))
    return {
      hasFirst: body.includes('第一轮'),
      hasFirstAnswer: body.includes('第一轮回答'),
      hasSecondAnswer: body.includes('第二轮回答'),
      hasSecondQuestion: body.includes('再把常见问题补一节'),
      hasEdited: body.includes('写成三步'),
      activeRows: active.length,
      activeText: active[0] ?? '',
      bodyChars: body.length,
    }
  `)
  // 编辑的是**第一条**：keep = 0 等于整条会话从这一刻重来，所以第一轮的题面与回答都该没了
  check('第一轮的题面也被作废（编辑的就是它）', state.hasFirst === false, JSON.stringify(state.hasFirst))
  check('第一轮的回答也没了', state.hasFirstAnswer === false, JSON.stringify(state.hasFirstAnswer))
  check('第二轮的回答没了（被作废）', state.hasSecondAnswer === false)
  check('第二轮的问题也没了', state.hasSecondQuestion === false)
  check('改过的文字在正文里', state.hasEdited === true, `正文字符 ${state.bodyChars}`)
  check('侧栏只亮着一行（没换到新会话）', state.activeRows === 1, JSON.stringify(state.activeRows))
  // 改的是第一条：侧栏标题要跟着换成改过的这句话（否则一直写着被作废的原文）
  check('侧栏标题换成了改过的那句话', state.activeText.includes('改过'), state.activeText)
}

console.log('\n[5] 日志：多了一条 rewind，原文一条不少')
{
  const after = readFileSync(file, 'utf8')
  check('原内容仍是前缀（没删历史）', after.startsWith(before))
  const added = after.slice(before.length).trim().split('\n').filter((line) => line !== '')
  const rewinds = added.map((line) => JSON.parse(line)).filter((record) => record.type === 'rewind')
  check('追加了 rewind 记录', rewinds.length >= 1, JSON.stringify(added.slice(-3)))
  check('rewind.keep = 0（作废第一条及之后）', rewinds[0]?.keep === 0, JSON.stringify(rewinds[0]))
  const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
  check('会话目录里没有多出第二条会话', files.length === 1, files.join('、'))
}

try { electron.kill() } catch {}
await sleep(400)
console.log(failed.length === 0 ? '\nPASS 轮尾悬浮 + 编辑留在当前会话，九条口径全过' : `\nFAIL ${failed.length} 条：${failed.join('；')}`)
process.exit(failed.length === 0 ? 0 : 1)
