process.on('unhandledRejection', () => {})

/**
 * 状态胶囊的落点与拖动（2026-11-02 报障的端到端复验）。
 *
 * 起因：用户截图里那颗胶囊（状态面板的收起态）正好压在消息流第一行「思考 · 进行中」上。
 * 改完之后它默认落在顶栏页签行（对话 / 轨迹）右端，并且可以按住拖动、位置记在本机。
 *
 * 验收口径（五条，缺一不算过）：
 *   ① 胶囊的父级是 `.topbar .tabs`（默认落点在页签行，不在正文里）；
 *   ② 胶囊的底边在正文滚动区上缘之上——不再压住任何一条消息；
 *   ③ 原地单击仍然展开面板（拖动没把点击吃掉）；
 *   ④ 按住往左下拖 60×120 之后：computed transform 的位移与松手位置一致，`dsc.statusPanel.pos` 落盘，
 *      并且拖动结束那一次 click **没有**把面板展开；
 *   ⑤ 刷新界面之后位移还在（位置是读存档回来的，不是只活在内存里）。
 *
 * 运行：node desktop/shots/_verify-status-pill.mjs（依赖桌面产物 desktop/out/）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-status-pill-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const debugPort = 9345
const sessionId = 'status-pill-demo'
const POS_KEY = 'dsc.statusPanel.pos'

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-pill', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:18998/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-pill', '        name: Fake Pill',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

// 种会话：一条在跑的待办 + 一段回答。胶囊会报「当前这条待办」，正好复现用户截图那一颗。
const now = Date.now()
const lines = [
  { type: 'meta', id: sessionId, cwd: work, createdAt: now - 60000 },
  { type: 'user', text: '继续批次1，先修安全那批。', ts: now - 50000 },
  { type: 'assistant', text: '好，先改越权那条。', reasoning: '', ts: now - 40000 },
  {
    type: 'state',
    id: 'todos',
    payload: [
      { id: 't1', content: '批次1-安全：通知角色广播越权（3 处）', status: 'in_progress' },
      { id: 't2', content: '批次1-测试：test_api_key.py', status: 'pending' },
    ],
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
const mouse = async (type, x, y, extra = {}) => {
  await send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', clickCount: 1, ...extra,
  })
}

/** 等胶囊上屏，返回它的矩形与父级信息（顺带等正文画出来）。 */
const waitPill = async () => evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.topbar .tabs .sp-host') !== null) break
    await wait(250)
  }
  await wait(600)
  const host = document.querySelector('.topbar .tabs .sp-host')
  if (host === null) return { found: false, hostParents: [...document.querySelectorAll('.sp-host')].map((n) => n.parentElement?.className ?? '') }
  const pill = host.querySelector('.sp-mini')
  const tabs = host.parentElement
  const chat = document.querySelector('.chat')
  const hostBox = host.getBoundingClientRect()
  const pillBox = (pill ?? host).getBoundingClientRect()
  return {
    found: true,
    parentClass: tabs instanceof HTMLElement ? tabs.className : null,
    hostBox: { left: hostBox.left, top: hostBox.top, right: hostBox.right, bottom: hostBox.bottom },
    pillBox: { left: pillBox.left, top: pillBox.top, right: pillBox.right, bottom: pillBox.bottom, width: pillBox.width, height: pillBox.height },
    chatTop: chat === null ? null : chat.getBoundingClientRect().top,
    expanded: host.querySelector('.sp')?.getAttribute('data-expanded') ?? null,
    pillText: pill === null ? null : pill.textContent,
    transform: getComputedStyle(host).transform,
    stored: window.localStorage.getItem('${POS_KEY}'),
  }
`)

const ui = await waitPill()
console.log('ui', JSON.stringify(ui, null, 1))
await shot('_verify-status-pill-default.png')

const failed = []
if (!ui.found) failed.push(`胶囊不在页签行里（现有 .sp-host 的父级：${JSON.stringify(ui.hostParents)}）`)
if (ui.found && ui.parentClass !== 'tabs') failed.push(`胶囊的父级不是页签行：${String(ui.parentClass)}`)
if (ui.found && ui.chatTop !== null && ui.pillBox.bottom > ui.chatTop + 0.5) {
  failed.push(`胶囊底边 ${String(Math.round(ui.pillBox.bottom))} 还在正文上缘 ${String(Math.round(ui.chatTop))} 之下（仍然压内容）`)
}

// ③ 原地单击：面板应当展开（拖动逻辑不能把点击吃掉）
if (ui.found) {
  const cx = (ui.pillBox.left + ui.pillBox.right) / 2
  const cy = (ui.pillBox.top + ui.pillBox.bottom) / 2
  await mouse('mousePressed', cx, cy)
  await mouse('mouseReleased', cx, cy)
  await sleep(450)
  const afterClick = await evaluate(`
    const host = document.querySelector('.topbar .tabs .sp-host')
    return { expanded: host === null ? null : host.querySelector('.sp')?.getAttribute('data-expanded') ?? null }
  `)
  console.log('click', JSON.stringify(afterClick))
  if (afterClick.expanded !== '1') failed.push(`单击之后面板没展开（data-expanded=${String(afterClick.expanded)}）`)

  // ③b 面板右上角那两颗图标钮要画得出来（2026-11-02 报障：只剩两个灰点）。
  // 面板整个浮层挂在 `.topbar .tabs` 里，页签行的 `padding: 0 10px` 一度灌进来把
  // 22px 的盒子挤成 2px；这里量「内容宽」与「SVG 宽」，两样都得是 13px 上下。
  const icons = await evaluate(`
    const buttons = [...document.querySelectorAll('.topbar .tabs .sp-host .sp-icon-btn')]
    return buttons.map((button) => {
      const style = getComputedStyle(button)
      const box = button.getBoundingClientRect()
      const svg = button.querySelector('svg')
      const svgBox = svg === null ? null : svg.getBoundingClientRect()
      return {
        label: button.getAttribute('aria-label'),
        box: { width: box.width, height: box.height },
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        contentWidth: box.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
        fontSize: style.fontSize,
        svg: svgBox === null ? null : { width: svgBox.width, height: svgBox.height },
      }
    })
  `)
  console.log('icons', JSON.stringify(icons, null, 1))
  await shot('_verify-panel-icons.png')
  if (icons.length !== 2) failed.push(`面板标题栏的图标钮应该 2 颗，实际 ${String(icons.length)}`)
  for (const icon of icons) {
    if (icon.contentWidth < 12) {
      failed.push(`「${String(icon.label)}」的内容宽只剩 ${String(icon.contentWidth)}px（多半是页签行的内边距漏进来了）`)
    }
    if (icon.svg === null || icon.svg.width < 11) {
      failed.push(`「${String(icon.label)}」的图标宽 ${String(icon.svg === null ? 'null' : icon.svg.width)}px，画不出来`)
    }
  }
  // 展开态没有胶囊，收起得按面板标题栏那颗「收起为胶囊」。
  const collapseBox = await evaluate(`
    const button = document.querySelector('.topbar .tabs .sp-host .sp-icon-btn[aria-label="收起为胶囊"]')
    if (button === null) return null
    const rect = button.getBoundingClientRect()
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
  `)
  if (collapseBox === null) {
    failed.push('展开态找不到「收起为胶囊」那颗按钮')
  } else {
    await mouse('mousePressed', collapseBox.x, collapseBox.y)
    await mouse('mouseReleased', collapseBox.x, collapseBox.y)
    await sleep(600)
    const collapsed = await evaluate(`
      const host = document.querySelector('.topbar .tabs .sp-host')
      const pill = host === null ? null : host.querySelector('.sp-mini')
      const rect = pill === null ? null : pill.getBoundingClientRect()
      return {
        expanded: host === null ? null : host.querySelector('.sp')?.getAttribute('data-expanded') ?? null,
        pill: rect === null ? null : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      }
    `)
    console.log('collapsed', JSON.stringify(collapsed))
    if (collapsed.expanded !== '0') failed.push(`收起为胶囊失败（data-expanded=${String(collapsed.expanded)}）`)
    if (collapsed.pill !== null) {
      ui.pillBox = collapsed.pill
    }
  }
}

// ④ 拖动：按住往左下 60×120（往右没空间：胶囊本来就在页签行右端）
let drag = null
if (ui.found) {
  const cx = (ui.pillBox.left + ui.pillBox.right) / 2
  const cy = (ui.pillBox.top + ui.pillBox.bottom) / 2
  await mouse('mousePressed', cx, cy)
  for (let step = 1; step <= 8; step += 1) {
    await mouse('mouseMoved', cx - 7.5 * step, cy + 15 * step, { buttons: 1 })
    await sleep(20)
  }
  await mouse('mouseReleased', cx - 60, cy + 120)
  await sleep(350)
  drag = await evaluate(`
    const host = document.querySelector('.topbar .tabs .sp-host')
    const box = host.getBoundingClientRect()
    const matrix = getComputedStyle(host).transform
    let tx = 0
    let ty = 0
    if (matrix !== 'none') {
      const parts = matrix.replace(/^matrix\\(|\\)$/g, '').split(',').map((n) => Number(n))
      tx = parts.length === 6 ? parts[4] : 0
      ty = parts.length === 6 ? parts[5] : 0
    }
    return {
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      transform: matrix, tx, ty,
      expanded: host.querySelector('.sp')?.getAttribute('data-expanded') ?? null,
      dragging: host.getAttribute('data-dragging'),
      stored: window.localStorage.getItem('${POS_KEY}'),
    }
  `)
  console.log('drag', JSON.stringify(drag, null, 1))
  if (Math.abs(drag.tx + 60) > 3 || Math.abs(drag.ty - 120) > 3) {
    failed.push(`拖动位移对不上：期望 (-60,120)，实际 (${String(drag.tx)},${String(drag.ty)})`)
  }
  if (drag.stored === null) failed.push('拖动之后没把位置写进 dsc.statusPanel.pos')
  if (drag.expanded !== '0') failed.push(`拖动结束那次 click 把面板打开了（data-expanded=${String(drag.expanded)}）`)
  if (drag.dragging !== null) failed.push('拖完之后 data-dragging 没摘掉')
  await shot('_verify-status-pill-dragged.png')

  // ⑤ 刷新：位移应当从存档读回来（不是只活在内存里）
  await send('Page.reload', { ignoreCache: false })
  await sleep(2200)
  const after = await waitPill()
  console.log('afterReload', JSON.stringify({ transform: after.transform, stored: after.stored }, null, 1))
  const m = after.transform === 'none' ? 0 : Number(after.transform.replace(/^matrix\(|\)$/g, '').split(',')[4])
  const n = after.transform === 'none' ? 0 : Number(after.transform.replace(/^matrix\(|\)$/g, '').split(',')[5])
  if (Math.abs(m + 60) > 3 || Math.abs(n - 120) > 3) {
    failed.push(`刷新之后位置没复原：期望 (-60,120)，实际 (${String(m)},${String(n)})`)
  }
  await shot('_verify-status-pill-reloaded.png')
}

console.log(failed.length === 0 ? 'PASS 五条口径全过' : `FAIL ${failed.join('；')}`)

try { ws.close() } catch {}
try { electron.kill() } catch {}
await sleep(600)
process.exit(failed.length === 0 ? 0 : 1)
