/**
 * 「历史被压缩」落点的现场探针（差距清单 S8 的第一块）。
 *
 * 数据早就在：`contract/transcript.ts` 的 `CompactionMark`。适配器在两种条目上挂它：
 * 实时的 system 通知（`system(text, compaction = true)`）与重放出来的压缩摘要 user 条目
 * （正文以 `SUMMARY_BANNER` 开头，`src/core/compact-anchors.ts:14`）。以前会话流两处都看不见，
 * 这次补两张卡：
 *
 *   1. `.entry-compaction`：两侧细线的分隔行，`data-compaction-count` 是第几次；
 *   2. `.entry-user-compaction`：压缩摘要那个用户气泡**上方**的一行 16px 小字。
 *
 * 为什么不照 `_verify-bash-card.mjs` 那样让假模型跑出压缩：**jsonl 里没有 system 记录**。
 * `SessionRecord`（`src/core/session.ts:135-225`）只有 meta / user / assistant / tool /
 * summary / state / rewind / note / notice 九种；`Session.load` 的 switch 没有 `system`
 * 分支，重放也从不产出 system 条目（`adapter/transcript.ts` 的 `replayHistory` 只发
 * user / message / tool 事件）。**唯一**能产出 system 压缩落点的路径是实时压缩：
 * compact 插件压完发 `dsc/notice(text, 'compaction')`，转录插件据此调
 * `system(text, true)`（`packages/transcript/index.ts:136`）。
 *
 * 所以探针分两步，两步都是真跑、不猜字段：
 *
 *   A. 造一条 jsonl：40 条真消息 + 末尾一条 `summary` 记录（`keep: 40`）。
 *      重放时 `load` 的 `case 'summary'` 把历史换成「摘要 + 末尾 40 条」，摘要正文以
 *      `SUMMARY_BANNER` 开头 → 那条 user 条目带上 `compaction`，第 1 次。断言小标。
 *   B. 打开这条会话后，从输入框真的敲 `/compact` 回车（走 `runUiCommand` 同一条闸）。
 *      假端点回一句短摘要，压缩成立 → compact 插件发 'compaction' 类别的通知 → 实时
 *      system 条目，第 2 次（重放已经用掉 1 次）。断言分隔行。
 *
 * 关于「第 2 次」：`CompactionMark` 的注释写明重放路径的 count 永远是 1（日志里只留
 * 最后一条摘要），实时路径才按会话累计。所以同一条会话里两处标记分别是 1 与 2，
 * 这不是造错了，是数据面的既有口径。
 *
 * 运行：node desktop/shots/_verify-compaction.mjs
 * 产物：desktop/shots/_compaction.png
 *
 * 前提：`pnpm run build:ui` 已跑过（探针加载的是 lib/ui 里的插件包，不是 src）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-compaction-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
/** 会话的 cwd：用仓库根，会话文件因此落在 `sessions/<slug('D:/dsc')>`。 */
const cwd = root
const fakePort = 18997
const debugPort = 9377

/** 摘要正文的固定开头（与 `src/core/compact-anchors.ts` 的 SUMMARY_BANNER 同字面量）。 */
const SUMMARY_BANNER = '[先前对话的交接摘要（原文已压缩）]'

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'D-dsc'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(userData, { recursive: true })

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-compaction', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-compaction', '        name: Fake Compaction',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({ defaultPolicy: 'full-access' }))

/**
 * 造的会话：40 条一字不假的历史，末尾追加一条 summary 记录。
 *
 * 为什么正好 40 条：`keep: 40` 让重放后内存里是「摘要 + 这 40 条」（41 条），
 * 既够 `compactSession` 的 `messages.length > keepRecent + 2`（缺省 keepRecent 20）
 * ——/compact 不会退化成「历史不长，无需压缩」，也够冒出一条摘要。
 */
const now = Date.now()
const seeded = [{ type: 'meta', id: 'compaction-seed', cwd, createdAt: now - 600000 }]
for (let index = 1; index <= 20; index += 1) {
  seeded.push({
    type: 'user',
    text: `第 ${String(index)} 轮：先说明这一轮要做什么，再给一段足够长的正文，让压缩有东西可折。` +
      '（这段是自检自己造的会话，不碰真实 ~/.dsc。）'.repeat(3),
    ts: now - 600000 + index * 2000,
  })
  seeded.push({
    type: 'assistant',
    text: `第 ${String(index)} 轮的回答：这里是一段占位正文，用来把上下文撑到压缩有意义的量级。` +
      '（自检不要求文笔，只要求 token 数够。）'.repeat(3),
    reasoning: '',
    ts: now - 600000 + index * 2000 + 1000,
  })
}
seeded.push({
  type: 'summary',
  text: `${SUMMARY_BANNER}\n自检造出来的压缩摘要：前面二十轮都在讨论同一件事，细节从略。`,
  keep: 40,
  ts: now - 100000,
})
const sessionPath = join(dsc, 'sessions', 'D-dsc', 'compaction-seed.jsonl').replace(/\\/g, '/')
writeFileSync(sessionPath, seeded.map((line) => JSON.stringify(line)).join('\n') + '\n')

/** 假端点：压缩请求要一句能用的摘要，其余请求一律给同一句短回答。 */
const server = createServer((req, res) => {
  void (async () => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    let messages = []
    try {
      const parsed = JSON.parse(body)
      messages = Array.isArray(parsed.messages) ? parsed.messages : []
    } catch { messages = [] }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    // 压缩请求的最后一条是 COMPACT_PROMPT（role: user，内容很长）；正常对话请求没有它。
    // 两种都回一句短文本：摘要因此远小于被折的历史（compactSession 会拒绝「压不小」的摘要）。
    const summarizing = messages.length > 0 && String(messages.at(-1)?.content ?? '').includes('压缩')
    delta({ content: summarizing ? '自检摘要：前面二十轮都在讨论同一件事。' : '自检回答。' })
    await sleep(60)
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 20 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-compaction] ${String(error)}\n`)
    try { res.end() } catch {}
  })
})
server.listen(fakePort, '127.0.0.1')

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
}
delete env.ELECTRON_RUN_AS_NODE

const electron = spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
  join(root, 'desktop/out/main/index.js'), '--remote-debugging-port=' + String(debugPort),
], { cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
electron.stdout.on('data', (d) => { log += String(d) })
electron.stderr.on('data', (d) => { log += String(d) })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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

/** 页面里常用的小工具（每次重新定义，探针之间不共享状态）。 */
const PAGE_HELPERS = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  /** 气泡上方那枚小标此刻的样子。 */
  const badgeSnap = () => {
    const mark = document.querySelector('.entry-user-compaction')
    if (mark === null) return { present: false }
    const box = mark.getBoundingClientRect()
    const bubble = mark.nextElementSibling
    return {
      present: true,
      count: mark.getAttribute('data-compaction-count'),
      text: (mark.textContent ?? '').trim(),
      tip: mark.getAttribute('data-tip') ?? '',
      height: Math.round(box.height),
      beforeBubble: bubble !== null && bubble.classList.contains('entry-user'),
      aboveBubble: bubble !== null && box.bottom <= bubble.getBoundingClientRect().top + 1,
    }
  }
  /** 分隔行此刻的样子：两侧线的实际宽度也读出来（flex: 1 没生效时是 0）。 */
  const rowSnap = () => {
    const row = document.querySelector('.entry-compaction')
    if (row === null) return { present: false }
    const box = row.getBoundingClientRect()
    const lines = [...row.querySelectorAll('.entry-compaction-line')]
      .map((line) => Math.round(line.getBoundingClientRect().width))
    return {
      present: true,
      count: row.getAttribute('data-compaction-count'),
      text: (row.querySelector('.entry-compaction-text')?.textContent ?? '').trim(),
      tip: row.getAttribute('data-tip') ?? '',
      lines,
      width: Math.round(box.width),
      height: Math.round(box.height),
    }
  }
`

// ── A. 打开造好的会话：重放出来的摘要条目应当带第 1 次压缩的小标 ──────────────
const opened = await evaluate(`
  ${PAGE_HELPERS}
  for (let i = 0; i < 120; i += 1) {
    if (typeof window.dsc !== 'undefined' && document.querySelector('.composer textarea') !== null) break
    await wait(250)
  }
  if (typeof window.dsc === 'undefined') return { error: 'no window.dsc（preload 没起来）' }
  await window.dsc.invoke('openSession', [${JSON.stringify(sessionPath)}])
  // 重放 41 条消息要一点时间：等小标出现（最多 15 秒），别拿固定等待当判据。
  let badge = badgeSnap()
  for (let i = 0; i < 75 && badge.present !== true; i += 1) {
    await wait(200)
    badge = badgeSnap()
  }
  await wait(400)
  return { badge: badgeSnap(), bubbles: document.querySelectorAll('.entry-user').length }
`)
if (opened?.error !== undefined) throw new Error(String(opened.error))
console.log('opened', JSON.stringify(opened))

// ── B. 真敲 /compact：让宿主压一次，冒出实时的 system 压缩落点 ────────────────
const compacted = await evaluate(`
  ${PAGE_HELPERS}
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '/compact')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(200)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  // 压缩要一次模型调用（假端点是本地回环，几十毫秒），给足 25 秒。
  let row = rowSnap()
  for (let i = 0; i < 250 && row.present !== true; i += 1) {
    await wait(100)
    row = rowSnap()
  }
  // 没等到时把页面上最后几条 system 正文带回来（「历史不长，无需压缩」「压缩失败：…」都在里面）。
  const tails = [...document.querySelectorAll('.entry-system')].map((el) => (el.textContent ?? '').trim()).slice(-3)
  return { row, badge: badgeSnap(), tails }
`)
console.log('compacted', JSON.stringify(compacted))

// 截图前把分隔行滚到视口中间，并确认它真的有高度（在 DOM 里不等于在屏幕上）。
const visible = await evaluate(`
  ${PAGE_HELPERS}
  const row = document.querySelector('.entry-compaction')
  if (row === null) return { visible: false }
  row.scrollIntoView({ block: 'center' })
  await wait(600)
  const box = row.getBoundingClientRect()
  return { visible: true, w: Math.round(box.width), h: Math.round(box.height), top: Math.round(box.top), snap: rowSnap() }
`)
console.log('visible', JSON.stringify(visible))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (typeof shot?.data === 'string') writeFileSync(join(shots, '_compaction.png'), Buffer.from(shot.data, 'base64'))

// ── 判 ───────────────────────────────────────────────────────────────────
const failures = []
const badge = opened?.badge ?? { present: false }
const row = compacted?.row ?? { present: false }
if (badge.present !== true) failures.push('压缩摘要的气泡上方没有 .entry-user-compaction')
if (badge.present === true) {
  if (badge.count !== '1') failures.push(`小标的 data-compaction-count 不是 1（实际 ${String(badge.count)}）`)
  if (!String(badge.text ?? '').includes('压缩')) failures.push(`小标里没有「压缩」（实际「${String(badge.text)}」）`)
  if (badge.height !== 16) failures.push(`小标不是 16px 高（实际 ${String(badge.height)}px）`)
  if (badge.beforeBubble !== true) failures.push('小标不是气泡的上一个兄弟节点（没挂在气泡上方）')
  if (badge.aboveBubble !== true) failures.push('小标的底边越过了气泡顶边（把气泡顶歪了）')
}
if (row.present !== true) {
  failures.push('页面上没有 .entry-compaction（压缩提示没有画成分隔行）')
} else {
  // 重放那条摘要已经是第 1 次，实时 /compact 是第 2 次（口径见文件头）。
  if (row.count !== '2') failures.push(`data-compaction-count 不是 2（实际 ${String(row.count)}）`)
  if (!String(row.text ?? '').includes('压缩')) failures.push(`分隔行里没有「压缩」（实际「${String(row.text)}」）`)
  if (!String(row.tip ?? '').includes('摘要')) failures.push(`data-tip 没说明「只保留摘要」（实际「${String(row.tip)}」）`)
  if (!Array.isArray(row.lines) || row.lines.length !== 2) failures.push(`分隔线不是两条（实际 ${JSON.stringify(row.lines)}）`)
  if (!Array.isArray(row.lines) || !row.lines.every((width) => width > 20)) failures.push(`分隔线没拉出宽度（flex: 1 没生效？实际 ${JSON.stringify(row.lines)}）`)
  if ((row.height ?? 0) < 10) failures.push(`分隔行在屏幕上没有高度（实际 ${String(row.height)}px）`)
}
if (compacted?.tails !== undefined && row.present !== true && compacted.tails.length > 0) {
  log += `\n[system tails] ${JSON.stringify(compacted.tails)}`
}
console.log('report', JSON.stringify({ badge, row, failures }))
const pass = 'PASS 压缩落点进了会话流（摘要气泡上方一行 16px 小标 · 实时压缩一条两侧细线的分隔行）'
console.log(failures.length === 0 ? pass : 'FAIL ' + failures.join('; '))

try { ws.close() } catch {}
try { electron.kill() } catch {}
server.close()
process.exit(failures.length === 0 ? 0 : 1)
