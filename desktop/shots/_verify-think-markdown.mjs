/**
 * 「思考正文要按 Markdown 排出来」的现场探针（差距清单 S3）。
 *
 * 报障形状（改之前）：模型在思考里写的 ``` 代码块、`- 列表`、`**加粗**`，界面上是原始字符——
 * 因为 `.think-text` 直接 `{entry.text}` 且 `white-space: pre-wrap`。
 *
 * 这个探针造这条现场：假模型一次吐出带代码块 / 列表 / 加粗 / 行内代码的 reasoning，
 * 收工后点开思考块，量这几件事：
 *
 *   1. 代码块真的排成了 `<pre><code>`（不是原始反引号）；
 *   2. 列表有 `<li>`、加粗有 `<strong>`、行内代码有 `<code>`；
 *   3. 正文里不再出现三连反引号那段原文；
 *   4. 展开区没有横向溢出，长行关在代码块里横滚；
 *   5. 节点级槽位（`transcript.node`）的兜底没给内置行体套壳、也没把内容画丢。
 *
 * 两处刻意的做法：
 *  - **点击走真鼠标**（CDP 的 `Input.dispatchMouseEvent`），不是 `element.dispatchEvent`：
 *    后者在 `<button disabled>` 与部分委托路径上会被浏览器吃掉，探针会得出「点不动」的假结论。
 *  - **先展开整轮再展开思考**：跑完一轮默认把过程区收成 0 高（`collapseTiming=completion`），
 *    那会儿量什么尺寸都是 0，截图也只有一条抬头。
 *
 * 运行：node desktop/shots/_verify-think-markdown.mjs
 * 产物：desktop/shots/_think-markdown.png（点开之后的整屏）
 *
 * 前提：`pnpm run build:ui` 已跑过（探针加载的是 lib/ui 里的插件包，不是 src）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-think-markdown-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18998
const debugPort = 9378

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'readme.txt'), '探针用的占位文件。\n')

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-markdown', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-markdown', '        name: Fake Markdown',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
// 思考行默认展开关着：探针自己点开，验的是「点开之后怎么排」。
// collapseTiming 用 next-input：跑完的最后一轮先摊着（默认 completion 会把过程区收成 0 高，
// 那会儿量什么尺寸都是 0，截图也只有一条抬头）。这一条只影响探针的观测时机，不改产品行为。
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({ ui: { reasoningDefaultOpen: false, collapseTiming: 'next-input' } }))

const now = Date.now()
writeFileSync(
  join(dsc, 'sessions', 'demo', 'think-markdown.jsonl'),
  [
    { type: 'meta', id: 'think-markdown', cwd: work, createdAt: now - 60000 },
    { type: 'user', text: '想一段带代码的，然后说一句话。', ts: now - 50000 },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n',
)

/** 思考原文：四样都要能排出来（代码块 / 有序列表 / 加粗 / 行内代码）。 */
const THINK = [
  '先看这段判断，再决定改哪儿：',
  '',
  '```js',
  'const branch = kind === "thinking" ? "reason" : "body"',
  'if (branch === "reason") { render(branch) }',
  '```',
  '',
  '要点：',
  '',
  '- 第一，`RowBody` 里那条 switch 是写死的；',
  '- 第二，**正文槽**要能单独换掉。',
  '',
  '结论：按原计划走。',
].join('\n')

/** 假模型：一口气把 THINK 分 14 口吐出来，然后给一句正文收工。 */
const server = createServer((req, res) => {
  void (async () => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const messages = (() => {
      try {
        const parsed = JSON.parse(body)
        return Array.isArray(parsed.messages) ? parsed.messages : []
      } catch { return [] }
    })()
    const hasAssistant = messages.some((message) => message.role === 'assistant')
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    if (!hasAssistant) {
      // 整段思考一次送完，然后**停 4 秒**再给正文——这段停顿是探针的观察窗口：
      // 内容已经齐了（代码块 / 列表 / 加粗都在），而这一轮还在跑，组体是强制摊开的。
      // 收工之后再量，阶段组会自己收回去，尺寸立刻变 0（见文件头的两处刻意做法）。
      delta({ reasoning_content: THINK })
      await sleep(4000)
    }
    delta({ content: '想法写完了，按计划走。' })
    await sleep(80)
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 200 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-markdown] ${String(error)}\n`)
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

/** 点一下页面上某个坐标（真鼠标：mousePressed + mouseReleased）。 */
const clickAt = async (point) => {
  const base = { x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
}

/** 页面里常用的几件小工具（每次都重新定义，探针之间不共享状态）。 */
const PAGE_HELPERS = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const rectOf = (selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    const box = node.getBoundingClientRect()
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), w: Math.round(box.width), h: Math.round(box.height) }
  }
  /** 一个节点往上八层的「盒子为什么是 0」读数（诊断用，不参与 PASS/FAIL）。 */
  const chainOf = (node) => {
    const out = []
    let walk = node
    for (let i = 0; walk !== null && i < 8; i += 1) {
      const style = getComputedStyle(walk)
      const box = walk.getBoundingClientRect()
      out.push({
        tag: walk.tagName,
        cls: String(walk.className ?? '').slice(0, 52),
        w: Math.round(box.width),
        h: Math.round(box.height),
        display: style.display,
        vis: style.visibility,
        cv: style.contentVisibility,
      })
      walk = walk.parentElement
    }
    return out
  }
`

// ── 1. 发消息，等第一段直播思考出现 ──────────────────────────────────────────
// 就在「还在跑」的时候点开它——这正是用户报障的真实时机，而且此时过程区天然是展开的，
// 量出来的尺寸是真的（收工后再点，要跟整轮折叠与阶段组折叠两层搏斗，见文件头注释）。
const ready = await evaluate(`
  ${PAGE_HELPERS}
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(250)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '想一段带代码的，然后说一句话。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))

  let head = null
  for (let i = 0; i < 200; i += 1) {
    const live = document.querySelector('.think-block.live')
    if (live !== null) {
      head = rectOf('.think-block.live .think-head')
      if (head !== null && head.w > 0) break
    }
    await wait(100)
  }
  return { head }
`)
if (ready?.error !== undefined) throw new Error(String(ready.error))
if (ready.head === null) throw new Error('没等到可点的直播思考行（探针没造出现场）')

// ── 2. 点开它（真鼠标；真鼠标没吃上再补一枪合成事件）────────────────────────
// 这一步只是「把正文摊开」的手段，不是被验对象（点击手感由 _verify-think-identity 覆盖）。
// 组体在展开/收拢的过渡帧里坐标系在动，真点击可能落在别处；`elementFromPoint` 把落点记下来，
// 落偏了就改用合成事件——否则探针会因为「没点到」而误报成「正文没渲染」。
await clickAt(ready.head)
await sleep(300)
const afterClick = await evaluate(`
  ${PAGE_HELPERS}
  const head = document.querySelector('.think-block .think-head')
  return {
    open: document.querySelector('.think-block')?.classList.contains('open') ?? false,
    headRect: rectOf('.think-block .think-head'),
    hitClass: String(document.elementFromPoint(${ready.head.x}, ${ready.head.y})?.className ?? '').slice(0, 60),
    headFound: head !== null,
  }
`)
console.log('afterClick', JSON.stringify(afterClick))
if (afterClick.open !== true && afterClick.headFound) {
  await evaluate(`
    ${PAGE_HELPERS}
    document.querySelector('.think-block .think-head')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(200)
    return null
  `)
  console.log('afterClick 补了一枪合成事件（真鼠标没落在行头上）')
}

// ── 3. 等正文把代码块排出来（半截 markdown 排不出 ``` ，所以等到 <pre> 出现为止）──
// 全程**在跑动中量**：那一会儿组体是强制摊开的，尺寸是真的；收工之后组体会自己收回去，
// 再从外面点开它要额外跟「阶段组折叠」搏斗，对这条探针毫无价值。
const settled = await evaluate(`
  ${PAGE_HELPERS}
  for (let i = 0; i < 300; i += 1) {
    const body = document.querySelector('.think-text')
    // 三样都到齐才算「内容齐了」：代码块、列表、加粗。只看 <pre> 会在列表还没到时提前量到。
    if (body !== null && body.querySelector('pre') !== null && body.querySelector('strong') !== null
      && body.querySelectorAll('li').length >= 2) break
    await wait(100)
  }
  const block = document.querySelector('.think-block')
  return {
    open: block?.classList.contains('open') ?? false,
    running: block?.classList.contains('live') ?? false,
    width: rectOf('.think-text')?.w ?? 0,
    thinkHeight: Math.round(block?.getBoundingClientRect().height ?? 0),
    chain: chainOf(block),
  }
`)
console.log('settled', JSON.stringify(settled).slice(0, 900))

// ── 3.5 阶段组默认是收着的：点开它，否则截图里只有一行组头 ──────────────────────
// 判据用组头自己的 `data-open`，**不要**用高度：组体收着时里面的行照样有布局高度，
// 用量高度当判据会得出「已经展开了」的假结论（这里踩过一次）。
const revealed = await evaluate(`
  ${PAGE_HELPERS}
  const wasOpen = document.querySelector('.step-fold')?.getAttribute('data-open') === '1'
  if (!wasOpen) {
    document.querySelector('.step-fold')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(400)
  }
  return {
    wasOpen,
    nowOpen: document.querySelector('.step-fold')?.getAttribute('data-open') === '1',
    thinkHeight: Math.round(document.querySelector('.think-block')?.getBoundingClientRect().height ?? 0),
  }
`)
console.log('revealed', JSON.stringify(revealed))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (typeof shot?.data === 'string') writeFileSync(join(shots, '_think-markdown.png'), Buffer.from(shot.data, 'base64'))

// ── 4. 量 ───────────────────────────────────────────────────────────────────
const report = await evaluate(`
  const block = document.querySelector('.think-block')
  const body = block?.querySelector('.think-text')
  if (block === null || body === null) return { missing: true, open: block?.classList.contains('open') ?? false }
  const bodyBox = block.querySelector('.think-body')?.getBoundingClientRect() ?? null
  const textBox = body.getBoundingClientRect()
  return {
    open: block.classList.contains('open'),
    hasPre: body.querySelector('pre') !== null,
    hasCode: body.querySelector('pre code, code') !== null,
    strong: body.querySelectorAll('strong').length,
    items: body.querySelectorAll('li').length,
    rawFence: (body.textContent ?? '').includes('\`\`\`'),
    // 横向溢出：展开区的右缘不许被正文顶出去（代码块自己横滚）。
    overflowRight: bodyBox === null ? 0 : Math.round(textBox.right - bodyBox.right),
    // 代码块要不要横滚：长行必须关在块里滚，不许把展开区顶出横向滚动条。
    // 谁是「负责横滚的那一层」可能是 pre 自己（shiki），也可能是它外面那层 .md-code-block，
    // 所以沿祖先链找到第一个 overflow-x 是 auto/scroll 的节点，记下它的类名。
    preScroll: [...body.querySelectorAll('pre')].map((node) => {
      const own = getComputedStyle(node).overflowX
      let scroller = own === 'auto' || own === 'scroll' ? 'pre' : ''
      for (let walk = node.parentElement; walk !== null && scroller === ''; walk = walk.parentElement) {
        const style = getComputedStyle(walk).overflowX
        if (style === 'auto' || style === 'scroll') scroller = String(walk.className) || walk.tagName
        if (walk === body) break
      }
      return { own, parentClass: String(node.parentElement?.className ?? '').slice(0, 48), scroller, scrollable: node.scrollWidth > node.clientWidth }
    }),
    innerWidth: Math.round(bodyBox?.width ?? 0),
    // 节点级槽位（transcript.node）的兜底不许留壳：链上没人认领时，内置行体应当直接是
    // .entry-row 的子节点。若这里数出东西，说明渲染出口给内置行体套了 .slot-entry。
    slotLeak: document.querySelectorAll('.entry-row > .slot-entry').length,
    // 兜底要是画空了，正文就没了——这是「加了槽位反而白屏」最直接的信号。
    textRows: document.querySelectorAll('.entry-text').length,
    thinkRows: document.querySelectorAll('.think-block').length,
    running: block.classList.contains('live'),
  }
`)

const failures = []
if (report.missing === true) failures.push('点开之后没找到 .think-text（正文没渲染）')
else {
  if (report.open !== true) failures.push('思考块没展开（探针没点开）')
  if (report.innerWidth === 0) failures.push('展开区量出来是 0 宽（探针没把整轮点开，几何断言不成立）')
  if (report.hasPre !== true) failures.push('代码块没排出来（没有 <pre>）')
  if (report.hasCode !== true) failures.push('行内代码 / 代码块里没有 <code>')
  if (!(report.strong > 0)) failures.push('加粗没排出来（没有 <strong>）')
  if (!(report.items >= 2)) failures.push('列表没排出来（<li> 少于 2 个）')
  if (report.rawFence === true) failures.push('正文里还留着三连反引号原文 —— 这就是改之前的现场')
  if (report.overflowRight > 1) failures.push(`展开区被正文顶出右缘 ${String(report.overflowRight)}px`)
  if (!report.preScroll.every((one) => one.scroller !== '')) {
    failures.push('代码块没有横向滚动的那一层（长行会顶破组体）：' + JSON.stringify(report.preScroll))
  }
  if (report.slotLeak !== 0) failures.push(`内置行体外面多套了 ${String(report.slotLeak)} 层 .slot-entry（兜底不该走条目壳）`)
  // 正文行要等这一轮收工才有（跑动中正文还没吐出来），所以只在收工后判它。
  if (report.running !== true && !(report.textRows >= 1)) failures.push('正文行没画出来（槽位兜底把人画没了）')
  if (!(report.thinkRows >= 1)) failures.push('思考行没画出来')
}

console.log('report', JSON.stringify(report))
console.log(failures.length === 0 ? 'PASS 思考正文按 Markdown 排出来了（代码块 / 列表 / 加粗，且不溢出）' : 'FAIL ' + failures.join('; '))

try { electron.kill() } catch {}
server.close()
process.exit(failures.length === 0 ? 0 : 1)
