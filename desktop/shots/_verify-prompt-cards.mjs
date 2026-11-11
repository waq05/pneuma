/**
 * 「系统提示卡 / 上下文注入卡」的现场探针（界面那半边的验收）。
 *
 * 数据面早就在了：`contract/transcript.ts` 的两条条目（`system-prompt` / `context-injection`）、
 * adapter 的 `prompt/used` 与 `context/injected`、以及会话日志里的
 * `state('system-prompt')` 与 `state('context-injected')` 两条记录。缺的是会话流里的两张卡。
 *
 * 为什么**直接造会话 jsonl**、不放假模型跑一轮（与 `_verify-compaction.mjs` 的取舍相反）：
 * 这两张卡的落位记录由宿主在「请求组装完」那一刻写（`session.ts:1250` 的 appendSystemPrompt /
 * `session.ts:1267` 的 appendContextInjections），要让真实回合产出它们，得先让假端点回一句、
 * 再等宿主把提示词拼出来——中间还有 hash 去重（同一版提示连发几轮只记一张卡），造一个
 * 「提示词变过一次」的现场比直接写日志贵得多。而重放这条路是**产品代码自己走的**：
 * `Session.load` 逐行读 jsonl → `transcriptMarkOf`（`session.ts:792`，`state` 记录按文件顺序
 * 进 `marks`）→ 适配器 `replayHistory` 的 `flushMarks` 按 `after`（写这条时日志里有几条消息）
 * 插回原位 → `markEvent` 折成 `prompt/used` / `context/injected` → 与实时路径同一条 reduce。
 * 所以造出来的会话与真会话在转录层**完全同形**。
 *
 * 造的东西（`src/core/session.ts:86-153` 的 `SessionTranscriptMark` 形状）：
 *   1. 一条 `state('system-prompt')`：`after: 0`（落在最前面）、`view` 带 9 段与模型名，
 *      段清单**故意乱序写**（tool-rules 排在 behavior 前面），用来证明卡片按 `order` 升序排；
 *   2. 一条 `state('context-injected')`：`after: 2`（两条消息之后）、4 条注入（4 类，正好
 *      能同时验证「前三类 + `+N`」两个分支）；
 *   3. 中间两条消息（一问一答），让会话有轮、不至于落进空会话欢迎态。
 *
 * 断言：
 *   - 页面上有 `.entry-prompt` 与 `.entry-injection`，且提示卡在第一条消息之前；
 *   - 两张卡的收起行文字含字数（6.2K 字）、段数（9 段）、模型名，注入卡含逐类读数与 +1；
 *   - 点开提示卡后段清单行数 = 9（表头不算），且第一行是 order 最小的 identity（不是原序的 tool-rules）；
 *   - 末行 hash 是造的那串的前 8 位；
 *   - 点开注入卡后逐条行数 = 4；
 *   - 注入卡头行 `.entry-injection-head` 有原生 `title`：非空、含「只列这一跳新增的注入」那句
 *     （`transcript.injection.newOnlyTip`）与开合提示（收起态 `expandTip`、展开态 `collapseTip`），
 *     期望值全从 `ui.zh.json` 读；卡片标题文字仍是字典里的「上下文注入」（`injection.label`）；
 *   - 截图 `desktop/shots/_prompt-cards.png`。
 *
 * 运行：node desktop/shots/_verify-prompt-cards.mjs
 * 产物：desktop/shots/_prompt-cards.png
 *
 * 前提：`pnpm run build:ui` 与桌面构建（`desktop/out`）都已跑过——探针加载的是构建产物，
 * 不是 src。本探针不发任何消息，所以不需要假端点。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-prompt-cards-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
/** 会话的 cwd：用仓库根，会话文件因此落在 `sessions/<slug('D:/dsc')>`。 */
const cwd = root
const debugPort = 9385

/**
 * 期望文案从字典读，不在探针里写死中文：卡片标题与头行悬停提示都是 `ui.zh.json` 里的键，
 * 字典改了探针跟着变，才不会出现「文案改了、探针还绿」。
 * 键名与源码钉 `scripts/injection-card-tip-test.mjs` 用的是同四个。
 */
const zh = JSON.parse(readFileSync(join(root, 'src/packages/ui-transcript/locale/ui.zh.json'), 'utf8'))
const INJECTION_LABEL = zh['transcript.injection.label']
const INJECTION_NEW_ONLY_TIP = zh['transcript.injection.newOnlyTip']
const INJECTION_EXPAND_TIP = zh['transcript.injection.expandTip']
const INJECTION_COLLAPSE_TIP = zh['transcript.injection.collapseTip']

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'D-dsc'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(userData, { recursive: true })

// 一张永远连不上的假端点：本探针只重放历史、不发请求，配置里有个 provider 让启动图能过就行。
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-prompt-cards', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:9/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-prompt-cards', '        name: Fake Prompt Cards',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({ defaultPolicy: 'full-access' }))

/** 系统提示的摘要（16 位 hash，与契约「sha256 前 16 位」同形状；末行只显示前 8 位）。 */
const PROMPT_HASH = '3f9a1c2b7d4e5f60'

/**
 * 9 段，字数合计 6234（卡片按千位折算成 `6.2K 字`）。
 *
 * **写序故意不是 order 序**：identity、tool-rules、behavior…——卡片要是照数组原序铺，
 * 第二行就会是 tool-rules，探针当场能把「按 order 升序」这条钉住。
 */
const SECTIONS = [
  { id: 'identity', order: 10, chars: 1200, from: 'core' },
  { id: 'tool-rules', order: 30, chars: 1400, from: 'core' },
  { id: 'behavior', order: 20, chars: 980, from: 'core' },
  { id: 'instructions', order: 40, chars: 1000, from: 'file' },
  { id: 'skills', order: 50, chars: 950, from: 'plugin:skills' },
  { id: 'preset:persona', order: 60, chars: 380, from: 'plugin:preset:persona' },
  { id: 'mode', order: 70, chars: 224, from: 'plugin:mode' },
  { id: 'git-hygiene', order: 80, chars: 60, from: 'plugin:git-hygiene' },
  { id: 'wrap-up', order: 90, chars: 40, from: 'plugin:wrap-up' },
]
const PROMPT_CHARS = SECTIONS.reduce((sum, section) => sum + section.chars, 0)
/** 段清单按 order 排好之后的 id 顺序（探针逐行核对）。 */
const ORDERED_IDS = [...SECTIONS].sort((left, right) => left.order - right.order).map((section) => section.id)

/**
 * 4 条注入、4 个类别：
 * - 展开态逐条行数 = 4；
 * - 收起行只列前三类，第四类收进 `+1`（两个分支都在同一个现场里被验证）。
 *
 * 字数取了几个真会出现的量级（环境快照几百字、模式几十字）。
 */
const PARTS = [
  {
    kind: 'env-facts',
    source: 'env-facts',
    where: 'user-tail',
    chars: 318,
    preview: '2026-11-10 · win32 · D:/dsc · 分支 feat/pluginization，3 个文件未提交',
  },
  {
    kind: 'mode',
    source: 'mode',
    where: 'system',
    chars: 86,
    preview: '协作模式：代理（自己动手，不停下来等确认）',
  },
  {
    kind: 'todo-reminder',
    source: 'todo-write',
    where: 'user-tail',
    chars: 64,
    preview: '待办还有 2 项未完成：写测试、跑自检',
  },
  {
    kind: 'sandbox',
    source: 'sandbox',
    where: 'system',
    chars: 120,
    preview: '沙箱档位：工作区可写，可写根 D:/dsc',
  },
]

const now = Date.now()
const lines = [
  { type: 'meta', id: 'prompt-cards-seed', cwd, createdAt: now - 300000 },
  // 1. 系统提示的落位记录。`after: 0` = 写在第一条消息之前，重放时落在最前面。
  //    `text` 是正文全文（卡片不读它，但会话 state 要存）；`view` 才是卡片的数据。
  {
    type: 'state',
    id: 'system-prompt',
    payload: {
      hash: PROMPT_HASH,
      text: '自检造的系统提示全文（卡片不读这一段，只认 view）。',
      after: 0,
      view: { hash: PROMPT_HASH, chars: PROMPT_CHARS, sections: SECTIONS, model: 'fake-prompt-cards' },
      ts: now - 290000,
    },
  },
  { type: 'user', text: '自检：这条会话是给两张账单卡造的，不用真回答。', ts: now - 280000 },
  { type: 'assistant', text: '自检回答。', reasoning: '', ts: now - 279000 },
  // 2. 上下文注入的落位记录。`after: 2` = 两条消息之后（本轮末尾）。
  {
    type: 'state',
    id: 'context-injected',
    payload: { parts: PARTS, after: 2, ts: now - 278000 },
  },
]
const sessionPath = join(dsc, 'sessions', 'D-dsc', 'prompt-cards-seed.jsonl').replace(/\\/g, '/')
writeFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')

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
  /** 点一下行头，再等展开体里的行出来。 */
  const openCard = async (rootSelector) => {
    const root = document.querySelector(rootSelector)
    if (root === null) return false
    const head = root.querySelector(':scope > [role="button"]')
    if (head === null) return false
    if (head.getAttribute('aria-expanded') !== 'true') head.click()
    for (let i = 0; i < 40 && head.getAttribute('aria-expanded') !== 'true'; i += 1) await wait(50)
    await wait(120)
    return head.getAttribute('aria-expanded') === 'true'
  }
  const textOf = (node) => (node?.textContent ?? '').trim()
`

// ── 打开造好的会话：重放两条消息 + 两条落位记录 ───────────────────────────────
const opened = await evaluate(`
  ${PAGE_HELPERS}
  for (let i = 0; i < 120; i += 1) {
    if (typeof window.dsc !== 'undefined' && document.querySelector('.composer textarea') !== null) break
    await wait(250)
  }
  if (typeof window.dsc === 'undefined') return { error: 'no window.dsc（preload 没起来）' }
  await window.dsc.invoke('openSession', [${JSON.stringify(sessionPath)}])
  // 重放是异步的：等提示卡出现（最多 15 秒），别拿固定等待当判据。
  let card = document.querySelector('.entry-prompt')
  for (let i = 0; i < 75 && card === null; i += 1) {
    await wait(200)
    card = document.querySelector('.entry-prompt')
  }
  await wait(400)
  const prompt = document.querySelector('.entry-prompt')
  const injection = document.querySelector('.entry-injection')
  const user = document.querySelector('.entry-user')
  const rect = (node) => (node === null ? null : {
    top: Math.round(node.getBoundingClientRect().top),
    bottom: Math.round(node.getBoundingClientRect().bottom),
  })
  return {
    hasPrompt: prompt !== null,
    hasInjection: injection !== null,
    promptHash: prompt?.getAttribute('data-prompt-hash') ?? '',
    injectionCount: injection?.getAttribute('data-injection-count') ?? '',
    promptHead: textOf(prompt?.querySelector('.entry-prompt-head')),
    injectionHead: textOf(injection?.querySelector('.entry-injection-head')),
    // 头行的原生 title（收起态）：悬停提示要先说清卡片记的是「新增」，不是「这一跳注入了什么」。
    injectionHeadTitle: injection?.querySelector('.entry-injection-head')?.getAttribute('title') ?? '',
    promptBeforeUser: prompt !== null && user !== null
      && prompt.getBoundingClientRect().top < user.getBoundingClientRect().top,
    welcome: document.querySelector('.welcome') !== null,
    messages: document.querySelectorAll('.entry-user').length,
    promptBox: rect(prompt),
    injectionBox: rect(injection),
  }
`)
if (opened?.error !== undefined) throw new Error(String(opened.error))
console.log('opened', JSON.stringify(opened))

// ── 点开两张卡：段清单行数、行内 id 顺序、逐条注入行数、hash 末行 ──────────────
const expanded = await evaluate(`
  ${PAGE_HELPERS}
  const promptOk = await openCard('.entry-prompt')
  const injectionOk = await openCard('.entry-injection')
  const marks = (open) => open ? '[data-open]' : ''
  const promptRoot = document.querySelector('.entry-prompt' + marks(promptOk))
  const injectionRoot = document.querySelector('.entry-injection' + marks(injectionOk))
  // 表头也带 .entry-prompt-tr：段数只数带 .entry-prompt-id 的那些行。
  const idCells = [...(promptRoot?.querySelectorAll('.entry-prompt-id') ?? [])].map((cell) => textOf(cell))
  const fromCells = [...(promptRoot?.querySelectorAll('.entry-prompt-from') ?? [])].map((cell) => textOf(cell))
  const charCells = [...(promptRoot?.querySelectorAll('.entry-prompt-num') ?? [])].map((cell) => textOf(cell))
  return {
    promptExpanded: promptOk,
    injectionExpanded: injectionOk,
    promptOpenFlag: promptRoot?.getAttribute('data-open') ?? null,
    sectionRows: idCells.length,
    ids: idCells,
    froms: fromCells,
    hashLine: textOf(promptRoot?.querySelector('.entry-prompt-hash')),
    missingLine: textOf(promptRoot?.querySelector('.entry-prompt-missing')),
    tablePresent: promptRoot?.querySelector('.entry-prompt-table') !== null,
    injectionRows: [...(injectionRoot?.querySelectorAll('.entry-injection-row') ?? [])].length,
    // 展开态的 title 要换成「收起」提示，同时口径那句不能丢。
    injectionTitle: injectionRoot?.querySelector('.entry-injection-head')?.getAttribute('title') ?? '',
    sources: [...(injectionRoot?.querySelectorAll('.entry-injection-source') ?? [])].map((cell) => textOf(cell)),
    wheres: [...(injectionRoot?.querySelectorAll('.entry-injection-where') ?? [])].map((cell) => textOf(cell)),
    previews: [...(injectionRoot?.querySelectorAll('.entry-injection-preview') ?? [])].map((cell) => textOf(cell)),
    charsCells: charCells,
  }
`)
console.log('expanded', JSON.stringify(expanded))

// 截图前把两张卡都留在视口里：先让提示卡贴顶，再确认注入卡还在屏幕内。
const framed = await evaluate(`
  ${PAGE_HELPERS}
  const prompt = document.querySelector('.entry-prompt')
  if (prompt !== null) prompt.scrollIntoView({ block: 'start' })
  await wait(500)
  const box = (selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    const rect = node.getBoundingClientRect()
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) }
  }
  const promptBox = box('.entry-prompt')
  const injectionBox = box('.entry-injection')
  const viewport = { height: window.innerHeight }
  const bothVisible = promptBox !== null && injectionBox !== null
    && promptBox.top >= -2 && injectionBox.bottom <= viewport.height + 2
  if (bothVisible !== true && injectionBox !== null && injectionBox.bottom > viewport.height) {
    // 放不下就退一步：把注入卡滚进来，提示卡留在上面能露多少算多少（截图照样能看出两张卡长什么样）。
    document.querySelector('.entry-injection').scrollIntoView({ block: 'end' })
    await wait(400)
  }
  return { promptBox, injectionBox, viewport, bothVisible, hasChat: document.querySelector('.chat') !== null }
`)
console.log('framed', JSON.stringify(framed))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (typeof shot?.data === 'string') writeFileSync(join(shots, '_prompt-cards.png'), Buffer.from(shot.data, 'base64'))

// ── 判 ───────────────────────────────────────────────────────────────────
const failures = []
if (opened?.hasPrompt !== true) failures.push('页面上没有 .entry-prompt（系统提示没画成卡）')
if (opened?.hasInjection !== true) failures.push('页面上没有 .entry-injection（上下文注入没画成卡）')
if (opened?.promptHash !== PROMPT_HASH) failures.push(`data-prompt-hash 不是造的 hash（实际 ${String(opened?.promptHash)}）`)
if (String(opened?.injectionCount) !== String(PARTS.length)) failures.push(`data-injection-count 不是 ${String(PARTS.length)}（实际 ${String(opened?.injectionCount)}）`)
if (opened?.promptBeforeUser !== true) failures.push('系统提示卡不在第一条消息之前（落位记录 after:0 没生效）')
if (opened?.welcome === true) failures.push('落进了空会话欢迎态（有消息的会话不该是欢迎态）')
if (opened?.messages !== 1) failures.push(`用户消息不是 1 条（实际 ${String(opened?.messages)}）`)

const promptHead = String(opened?.promptHead ?? '')
if (!promptHead.includes('6.2K 字')) failures.push(`提示卡收起行里没有「6.2K 字」（实际「${promptHead}」）`)
if (!promptHead.includes('9 段')) failures.push(`提示卡收起行里没有「9 段」（实际「${promptHead}」）`)
if (!promptHead.includes('fake-prompt-cards')) failures.push(`提示卡收起行里没有模型名（实际「${promptHead}」）`)
if (!promptHead.includes('系统提示')) failures.push(`提示卡收起行里没有「系统提示」（实际「${promptHead}」）`)

const injectionHead = String(opened?.injectionHead ?? '')
for (const expected of [INJECTION_LABEL, '环境快照 318 字', '模式 86 字', '待办提醒 64 字', '+1']) {
  if (!injectionHead.includes(expected)) failures.push(`注入卡收起行里没有「${expected}」（实际「${injectionHead}」）`)
}
// 第四类（沙箱）只该以 `+1` 出现，不该把四类全摊在收起行里。
if (injectionHead.includes('沙箱')) failures.push(`注入卡收起行摊了第四类（实际「${injectionHead}」）`)

// 头行的原生 title：源码钉（`scripts/injection-card-tip-test.mjs`）只证 JSX 上挂着 title 表达式，
// 这里补真机那一半——浏览器里确实渲染出了 title 属性，口径句与开合提示都在。
// 期望值全从字典取，文案改了探针跟着红。
const injectionTitleClosed = String(opened?.injectionHeadTitle ?? '')
const injectionTitleOpen = String(expanded?.injectionTitle ?? '')
if (injectionTitleClosed.trim() === '') {
  failures.push('注入卡头行 `.entry-injection-head` 上没有原生 title 属性（读到的是空串）')
}
if (!injectionTitleClosed.includes(INJECTION_NEW_ONLY_TIP)) {
  failures.push(`注入卡头行 title 里没有「只列这一跳新增」那句（实际「${injectionTitleClosed}」）`)
}
if (!injectionTitleClosed.includes(INJECTION_EXPAND_TIP)) {
  failures.push(`注入卡收起态 title 里没有展开提示（实际「${injectionTitleClosed}」）`)
}
if (!injectionTitleOpen.includes(INJECTION_NEW_ONLY_TIP) || !injectionTitleOpen.includes(INJECTION_COLLAPSE_TIP)) {
  failures.push(`注入卡展开态 title 没同时保留口径句与收起提示（实际「${injectionTitleOpen}」）`)
}
// 标题文字仍是字典里的「上下文注入」：口径只许加在悬停提示里，不许改标题本身。
if (!injectionHead.includes(INJECTION_LABEL)) {
  failures.push(`注入卡头行标题文字不是字典里的「${INJECTION_LABEL}」（实际「${injectionHead}」）`)
}

if (expanded?.promptExpanded !== true) failures.push('提示卡点不开（aria-expanded 没变 true）')
if (expanded?.sectionRows !== SECTIONS.length) failures.push(`段清单行数不是 ${String(SECTIONS.length)}（实际 ${String(expanded?.sectionRows)}）`)
if (JSON.stringify(expanded?.ids) !== JSON.stringify(ORDERED_IDS)) {
  failures.push(`段清单没按 order 升序（期望 ${JSON.stringify(ORDERED_IDS)}，实际 ${JSON.stringify(expanded?.ids)}）`)
}
if (!String(expanded?.hashLine ?? '').includes(PROMPT_HASH.slice(0, 8))) {
  failures.push(`末行不是 hash 前 8 位（实际「${String(expanded?.hashLine)}」）`)
}
if (String(expanded?.hashLine ?? '').includes(PROMPT_HASH.slice(8))) {
  failures.push(`末行画了完整 hash（只该给前 8 位，实际「${String(expanded?.hashLine)}」）`)
}
if (expanded?.missingLine !== '') failures.push(`非老会话却画了 bodyMissing 那句（实际「${String(expanded?.missingLine)}」）`)
if (expanded?.tablePresent !== true) failures.push('展开后没有段清单表')
if (expanded?.injectionExpanded !== true) failures.push('注入卡点不开（aria-expanded 没变 true）')
if (expanded?.injectionRows !== PARTS.length) failures.push(`注入卡逐条行数不是 ${String(PARTS.length)}（实际 ${String(expanded?.injectionRows)}）`)
if (JSON.stringify(expanded?.sources) !== JSON.stringify(PARTS.map((part) => part.source))) {
  failures.push(`来源列与造的清单不一致（实际 ${JSON.stringify(expanded?.sources)}）`)
}
// 位置口径：system → 系统提示，user-tail → 请求末尾。
const wantedWheres = PARTS.map((part) => (part.where === 'system' ? '系统提示' : '请求末尾'))
if (JSON.stringify(expanded?.wheres) !== JSON.stringify(wantedWheres)) {
  failures.push(`位置列不对（期望 ${JSON.stringify(wantedWheres)}，实际 ${JSON.stringify(expanded?.wheres)}）`)
}
if (expanded?.previews?.[0] !== PARTS[0].preview) failures.push('第一条注入的预览没画出来')
if (framed?.bothVisible !== true) log += `\n[framed] 两张卡没能同时进视口：${JSON.stringify(framed)}`

console.log('report', JSON.stringify({
  promptHead,
  injectionHead,
  injectionTitleClosed,
  injectionTitleOpen,
  sectionRows: expanded?.sectionRows,
  injectionRows: expanded?.injectionRows,
  hashLine: expanded?.hashLine,
  bothVisible: framed?.bothVisible,
  failures,
}))
const pass = 'PASS 两张账单卡进了会话流（系统提示：9 段 + 6.2K 字 + hash 前 8 位 · 上下文注入：前三类 + +1，点开逐条，头行 title 带新增口径与开合提示）'
console.log(failures.length === 0 ? pass : 'FAIL ' + failures.join('; '))

try { ws.close() } catch {}
try { electron.kill() } catch {}
process.exit(failures.length === 0 ? 0 : 1)
