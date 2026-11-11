// 已弃用：只打印不判定（2026-11-11 审计），用之前先补断言
/**
 * 一次性自检脚本：通过 CDP 操作正在跑的隔离实例，验证
 *「审查 / Git 改动预览统一到右侧栏预览页签，且 markdown 改动块有标色」。
 *
 * 用法：node desktop/shots/_verify-dock-cdp.mjs [probe|open]
 * 要求实例带 --remote-debugging-port=9333 启动。
 */
import WebSocket from 'ws'

const PORT = 9333

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (page === undefined) throw new Error('没有 page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
  const pending = new Map()
  let seq = 0
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw))
    const hit = pending.get(msg.id)
    if (hit !== undefined) {
      pending.delete(msg.id)
      hit(msg)
    }
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.result?.exceptionDetails !== undefined) throw new Error(JSON.stringify(res.result.exceptionDetails))
    return res.result?.result?.value
  }
  return { ws, send, evaluate }
}

const mode = process.argv[2] ?? 'probe'
const { ws, send, evaluate } = await connect()

if (mode === 'probe') {
  const info = await evaluate(`JSON.stringify({
    title: document.title,
    buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).filter((t) => t !== '').slice(0, 40),
    tabParts: [...document.querySelectorAll('.session-item, .session-row, [data-session-id]')].map((el) => (el.textContent ?? '').trim().slice(0, 40)).slice(0, 12),
    bodyHead: document.body.innerText.slice(0, 400),
  })`)
  console.log(info)
} else {
  // open：切到当前会话 → 滚到底 → 点轮尾改动卡的「审查」→ 截图
  const clicked = await evaluate(`(() => {
    const items = [...document.querySelectorAll('button, [role="button"], .session-item')]
    const hit = items.find((el) => (el.textContent ?? '').includes('右侧预览统一为侧栏'))
    if (hit === undefined) return 'not-found'
    hit.click()
    return 'clicked'
  })()`)
  console.log('session:', clicked)
  await new Promise((r) => setTimeout(r, 2500))
  const scrolled = await evaluate(`(() => {
    const sc = [...document.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 100)
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    if (sc === undefined) return 'no-scroller'
    sc.scrollTop = sc.scrollHeight
    return 'scrolled:' + sc.scrollHeight
  })()`)
  console.log('scroll:', scrolled)
  await new Promise((r) => setTimeout(r, 1200))
  const review = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '审查')
    if (btn === undefined) return 'no-review-button'
    btn.click()
    return 'review-clicked'
  })()`)
  console.log('review:', review)
  await new Promise((r) => setTimeout(r, 2500))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const fs = await import('node:fs')
  fs.writeFileSync('desktop/shots/_verify-dock.png', Buffer.from(shot.result.data, 'base64'))
  const marked = await evaluate(`JSON.stringify({ changed: document.querySelectorAll('.md-changed').length, dockTabs: [...document.querySelectorAll('.dock-tab')].map((el) => (el.textContent ?? '').trim()) })`)
  console.log('marked:', marked)
}

ws.close()
