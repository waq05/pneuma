/**
 * 「思考一长，行头要吸在组体顶部」的现场探针（差距清单 S10）。
 *
 * 报障形状（改之前）：思考展开后正文有几百像素，而阶段组体只有 `min(400px, 50vh)` 高
 * （`.step-body` 的 max-height + overflow-y: auto）；一旦往下滚到正文中间，行头
 * （`.think-head`，点它就是收起）就滚出视野。带「收起」的吸附快捷栏 `.think-bar` 只在
 * 内容超过 400px 时才渲染，短一点的思考（比如 300px）连这条都没有——于是「想收起只能
 * 一路滚回组体顶部」。
 *
 * 这个探针造这条现场：假模型一口气吐一段 40 多行的思考（带代码块，高度必然越过组体
 * 的 400px 上限），然后停 4 秒再给正文。量三件事：
 *
 *   1. 滚之前量一次对照：行头还在块的自然位置（块顶与组体顶对齐，行头与组体差 0）；
 *   2. 把 `.step-body` 的 scrollTop 设成 160 再量：行头顶边与组体顶边之差应在 ±2px 内，
 *      而块顶相对组体已经上移了 160px——这才证明是**行头吸住了**，不是整块没动；
 *   3. 快捷栏 `.think-bar` 在场时，它应贴在行头下沿（±4px）、不能盖住行头；
 *   4. 滚完之后**真鼠标**点一下吸住的行头，`aria-expanded` 要变 false——证明吸住的那根
 *      行头是一根真的能点的行头，不是一张截图纸。
 *
 * 三处刻意做法（与 `_verify-think-markdown.mjs` 同一套口径）：
 *  - **在跑动中量**：那 4 秒停顿是唯一的稳定观察窗口——内容已经齐了，阶段组仍强制摊开。
 *    收工之后思考行会从「直播尾」换成正式条目整行重挂（负 id → 正 id，key 跟着换），
 *    滚动位置与被量的节点都可能换人，此刻量到的几何未必还是同一根行头。
 *  - **判展开用 `data-open`，不用高度**：组体收着时里面的行照样有布局高度，用高度当判据
 *    会得出「已经展开了」的假结论（模板里踩过一次）。同理思考行看 `classList.contains('open')`。
 *  - **点击优先真鼠标**（CDP 的 `Input.dispatchMouseEvent`）：`element.dispatchEvent` 会绕过
 *    命中测试，点没点得中、有没有被别的层盖住它都答不了；而「吸住的行头还能点」正是这条
 *    探针的核心断言之一，所以滚动之后那一下必须走真鼠标。只有「把正文摊开」这种手段性
 *    点击才留一条合成事件兜底（组体/整轮正在动画时，真点击可能落在别处）。
 *
 * 运行：node desktop/shots/_verify-think-sticky.mjs
 * 产物：desktop/shots/_think-sticky.png（组体滚到 160px 之后的状态）
 *
 * 前提：`pnpm run build:ui` 已跑过（探针加载的是 lib/ui 里的插件包，不是 src）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-think-sticky-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const work = join(home, 'work')
const fakePort = 18999
const debugPort = 9379

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions', 'demo'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'readme.txt'), '探针用的占位文件。\n')

writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-sticky', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-sticky', '        name: Fake Sticky',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))
// 思考行默认展开关着：探针自己点开，验的是「点开之后行头吸没吸住」。
// collapseTiming 用 next-input：跑完的最后一轮先摊着（默认 completion 会把过程区收成 0 高）。
// 这一条只影响探针的观测时机，不改产品行为。
writeFileSync(join(dsc, 'settings.json'), JSON.stringify({ ui: { reasoningDefaultOpen: false, collapseTiming: 'next-input' } }))

const now = Date.now()
writeFileSync(
  join(dsc, 'sessions', 'demo', 'think-sticky.jsonl'),
  [
    { type: 'meta', id: 'think-sticky', cwd: work, createdAt: now - 60000 },
    { type: 'user', text: '想一段长的，然后说一句话。', ts: now - 50000 },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n',
)

/** 足够长的思考：40 多行带代码块，展开高度必然越过 .step-body 的 400px 上限。 */
const THINK = [
  '先把这次改动落在哪一层想清楚，再动手：',
  '',
  '第一，滚动容器是谁。阶段组体 `.step-body` 有 `max-height: min(400px, 50vh)` 和',
  '`overflow-y: auto`，思考一长，真正滚的是这一层。再往上的 `.turn-process-body` 写着',
  '`overflow: hidden`，所以吸附链到那里就断了，别指望把行头吸到窗口顶部。',
  '',
  '第二，吸附参照系与吸附元素的区别。sticky 找的是最近的滚动祖先，也就是组体；',
  '而行头被限制在自己的包含块（`.think-block`）里，块滚出组体之后行头也跟着走。',
  '这个「跟着走」是必要的：一整轮里可能有好几条思考，行头不能越过自己那条。',
  '',
  '第三，叠层顺序。带「收起」的快捷栏原来也吸在 top: 0，两块钉在同一行上会互相压住：',
  '快捷栏那条不透明底盖掉行头一半，两边的按钮挤在一起也不好点。把它挪到行头高度之下，',
  '行头和快捷栏就上下叠着，谁都不挡谁。高度用令牌 `--dsc-process-row-h`，不写魔数。',
  '',
  '```css',
  '.think-block.open .think-head {',
  '  background: var(--dsc-fill-quinary);',
  '  border-radius: 0;',
  '  position: sticky;',
  '  top: 0;',
  '  z-index: 1;',
  '}',
  '```',
  '',
  '第四，底色为什么必须不透明。吸附之后正文从行底往下滚过去，半透明底会把文字透上来，',
  '读起来像两行字叠在一起。用与展开态块底同色的 `--dsc-fill-quinary`，吸住时看不出边界。',
  '',
  '第五，圆角为什么归零。行头原来是 `--dsc-r-control` 的小圆角，吸在顶部时上面那两角会',
  '在块底色上留出两道弧线；归零之后整条行头就是一块齐边的挡板。',
  '',
  '第六，短内容怎么办。快捷栏仍然只在内容超过 400px 时渲染，这是「长内容才给一条常驻',
  '状态栏」的产品口径，不是这次要改的东西。但短一点的思考本来就没有快捷栏，它现在靠',
  '吸住的行头收起，所以这一改反而补上了原来那一段空白。',
  '',
  '第七，验证要看什么。滚到 160px 之后，行头顶边应与组体顶边重合，块顶则已经上移 160px；',
  '快捷栏贴住行头下沿；最后用真鼠标点一下行头，`aria-expanded` 要变 false。',
  '',
  '结论：按这个顺序改，只动吸附位置与快捷栏的 top，不碰展开区与组体的任何规则。',
].join('\n')

/** 假模型：一口气把 THINK 送出来，停 4 秒（观察窗口），再给一句正文收工。 */
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
      // 内容已经齐了（长度足够把组体撑到 400px 上限），而这一轮还在跑，过程区是强制摊开的。
      // 收工之后再量，思考行会整行重挂（负 id → 正 id），量的就不是同一根行头了。
      delta({ reasoning_content: THINK })
      await sleep(4000)
    }
    delta({ content: '想完了，按计划走。' })
    await sleep(80)
    delta({}, 'stop')
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 200 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-sticky] ${String(error)}\n`)
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
  const round = (value) => Math.round(value)
  const rectOf = (selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    const box = node.getBoundingClientRect()
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), w: Math.round(box.width), h: Math.round(box.height) }
  }
  /** 同一帧里把三个盒子的位置一起读出来：分开读会跨帧，滚动/过渡中能差出好几像素。 */
  const geometryOf = () => {
    const block = document.querySelector('.think-block.open')
    if (block === null) return { missing: true, open: document.querySelector('.think-block')?.classList.contains('open') ?? false }
    const body = block.closest('.step-body')
    if (body === null) return { noBody: true }
    const head = block.querySelector('.think-head')
    const bar = block.querySelector('.think-bar')
    if (head === null) return { noHead: true }
    const bodyBox = body.getBoundingClientRect()
    const blockBox = block.getBoundingClientRect()
    const headBox = head.getBoundingClientRect()
    const barBox = bar === null ? null : bar.getBoundingClientRect()
    return {
      scrollTop: round(body.scrollTop),
      scrollRange: round(body.scrollHeight - body.clientHeight),
      bodyTop: round(bodyBox.top),
      headTop: round(headBox.top),
      headBottom: round(headBox.bottom),
      blockTop: round(blockBox.top),
      // 关键读数：行头顶边与组体顶边之差（吸附成立时是 0 附近）。
      headVsBody: round(headBox.top - bodyBox.top),
      // 对照读数：块顶与组体顶边之差（块没有吸住，应该跟着滚走）。
      blockVsBody: round(blockBox.top - bodyBox.top),
      barPresent: barBox !== null,
      barTop: barBox === null ? null : round(barBox.top),
      // 快捷栏与行头下沿之差：0 附近说明「行头在上、快捷栏紧贴它下面」，负值就是盖住行头。
      barVsHeadBottom: barBox === null ? null : round(barBox.top - headBox.bottom),
      rowHeight: getComputedStyle(document.documentElement).getPropertyValue('--dsc-process-row-h').trim(),
      // 组体顶边那条 24px 渐隐如果在，吸住的行头会跟着淡掉一半：遮罩作用在整个滚动盒上，
      // 连吸住的行头自己的字一起乘了透明度。有开的思考块时这条渐隐应该被撤掉，
      // 所以这里读组体的计算遮罩，下面判「要么没有，要么不是顶上透明的那一版」。
      mask: getComputedStyle(body).maskImage,
      headPoint: { x: Math.round(headBox.x + headBox.width / 2), y: Math.round(headBox.y + headBox.height / 2) },
      expanded: head.getAttribute('aria-expanded'),
    }
  }
`

// ── 1. 发消息，等直播思考行出现 ──────────────────────────────────────────────
const ready = await evaluate(`
  ${PAGE_HELPERS}
  for (let i = 0; i < 120; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(250)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '想一段长的，然后说一句话。')
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

// ── 2. 先展开整轮（数据判据用 data-open，不看高度）────────────────────────────
const revealed = await evaluate(`
  ${PAGE_HELPERS}
  const wasOpen = document.querySelector('.step-fold')?.getAttribute('data-open') === '1'
  if (!wasOpen) {
    document.querySelector('.step-fold')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(450)
  }
  return {
    wasOpen,
    nowOpen: document.querySelector('.step-fold')?.getAttribute('data-open') === '1',
  }
`)
console.log('revealed', JSON.stringify(revealed))

// ── 3. 组体刚展开时贴底跟随，行头在视口外；先回到 0，让行头露出来再点 ──────────
const rewound = await evaluate(`
  ${PAGE_HELPERS}
  const block = document.querySelector('.think-block')
  const body = block?.closest('.step-body') ?? null
  if (body === null) return { error: 'no step-body' }
  body.scrollTop = 0
  await wait(150)
  return { scrollTop: Math.round(body.scrollTop), head: rectOf('.think-block .think-head') }
`)
console.log('rewound', JSON.stringify(rewound))
if (rewound?.error !== undefined) throw new Error(String(rewound.error))
if (rewound?.head === null || rewound?.head === undefined) throw new Error('组体展开后没找到可点的思考行头（探针没造出现场）')

// ── 4. 点开思考行头（真鼠标；真鼠标没吃上再补一枪合成事件）────────────────────
// 这一步只是「把正文摊开」的手段，不是被验对象（吸住之后还能不能点，第 7 步单独验）。
await clickAt(rewound.head)
await sleep(300)
const afterClick = await evaluate(`
  ${PAGE_HELPERS}
  const block = document.querySelector('.think-block')
  return {
    open: block?.classList.contains('open') ?? false,
    hitClass: String(document.elementFromPoint(${rewound.head.x}, ${rewound.head.y})?.className ?? '').slice(0, 60),
  }
`)
console.log('afterClick', JSON.stringify(afterClick))
if (afterClick.open !== true) {
  await evaluate(`
    ${PAGE_HELPERS}
    document.querySelector('.think-block .think-head')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(250)
    return null
  `)
  console.log('afterClick 补了一枪合成事件（真鼠标没落在行头上）')
}

// ── 5. 等正文齐了（代码块排出来、文字够长），快捷栏跟着量出来 ─────────────────
// 全程**在跑动中量**：那一会儿过程区是强制摊开的，尺寸是真的（见文件头）。
const settled = await evaluate(`
  ${PAGE_HELPERS}
  for (let i = 0; i < 300; i += 1) {
    const body = document.querySelector('.think-text')
    const bar = document.querySelector('.think-bar')
    if (body !== null && body.querySelector('pre') !== null && bar !== null) break
    await wait(100)
  }
  const body = document.querySelector('.think-text')
  const block = document.querySelector('.think-block')
  return {
    open: block?.classList.contains('open') ?? false,
    running: block?.classList.contains('live') ?? false,
    textHeight: Math.round(body?.getBoundingClientRect().height ?? 0),
    thinkHeight: Math.round(block?.getBoundingClientRect().height ?? 0),
    barPresent: document.querySelector('.think-bar') !== null,
  }
`)
console.log('settled', JSON.stringify(settled))

// ── 6. 滚之前量一次对照（此时行头在块的自然位置，还没吸住）────────────────────
const before = await evaluate(`
  ${PAGE_HELPERS}
  const block = document.querySelector('.think-block')
  const body = block?.closest('.step-body') ?? null
  if (body === null) return { noBody: true }
  body.scrollTop = 0
  await wait(150)
  return geometryOf()
`)
console.log('before', JSON.stringify(before))

// ── 7. 组体滚到 160px，再量一次（这里才是被验对象）──────────────────────────
const after = await evaluate(`
  ${PAGE_HELPERS}
  const body = document.querySelector('.think-block')?.closest('.step-body') ?? null
  if (body === null) return { noBody: true }
  body.scrollTop = 160
  // 等一帧再等手势落定（组体的跟随判定在 140ms 后结算，别在结算前抢读数）。
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await wait(220)
  return geometryOf()
`)
console.log('after', JSON.stringify(after))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (typeof shot?.data === 'string') writeFileSync(join(shots, '_think-sticky.png'), Buffer.from(shot.data, 'base64'))

// ── 8. 吸住的行头还能不能点：真鼠标点一下，看 aria-expanded ───────────────────
const point = after?.headPoint ?? null
if (point !== null) {
  await clickAt(point)
  await sleep(350)
}
const collapsed = await evaluate(`
  ${PAGE_HELPERS}
  const head = document.querySelector('.think-block .think-head')
  const block = document.querySelector('.think-block')
  return {
    expanded: head?.getAttribute('aria-expanded') ?? null,
    open: block?.classList.contains('open') ?? false,
    hitClass: ${point === null ? "''" : `String(document.elementFromPoint(${point.x}, ${point.y})?.className ?? '')`}.slice(0, 80),
    headRect: rectOf('.think-block .think-head'),
  }
`)
console.log('collapsed', JSON.stringify(collapsed))

// ── 9. 判 ───────────────────────────────────────────────────────────────────
const failures = []
const barNote = []
if (before?.noBody === true || after?.noBody === true) failures.push('没找到包住思考块的 .step-body（组体没渲染）')
else {
  if (before.missing === true || after.missing === true) failures.push('思考块没展开（探针没点开）')
  else {
    if (!(before.scrollRange > 160)) {
      failures.push(`组体滚不动：可滚范围只有 ${String(before.scrollRange)}px（思考内容没撑到 400px 上限，探针没造出现场）`)
    }
    if (before.scrollTop !== 0) failures.push(`滚之前的起点不是 0（${String(before.scrollTop)}px）`)
    if (before.barPresent !== true) barNote.push('快捷栏没有渲染（内容阈值没到）')
    if (Math.abs(before.blockVsBody) > 2) {
      failures.push(`滚之前块顶就不在组体顶上（差 ${String(before.blockVsBody)}px），后面的吸附读数没有对照`)
    }

    // 被验对象：滚 160px 之后。
    if (after.scrollTop !== 160) failures.push(`组体没滚到 160px（实际 ${String(after.scrollTop)}px）`)
    if (Math.abs(after.headVsBody) > 2) {
      failures.push(`滚到 160px 后行头没吸在组体顶部：行头顶边与组体顶边差 ${String(after.headVsBody)}px`)
    }
    if (after.blockVsBody > -140) {
      failures.push(`块没有跟着滚走（块顶与组体顶差 ${String(after.blockVsBody)}px）——说明读到的不是吸附、是整块没动`)
    }
    // 组体顶边那条 24px 渐隐必须已经撤掉：遮罩会把吸住的行头自己的字一起乘成半透明。
    // `mask-image: none` 的序列化就是 "none"；留着的那版顶上从透明起步，
    // Chrome 把它写成 `rgba(0, 0, 0, 0) 0px`，只认这个起点（底边那条的透明终点是 100%）。
    const maskText = String(after.mask ?? 'none')
    if (maskText !== 'none' && maskText.includes('rgba(0, 0, 0, 0) 0px')) {
      failures.push(`组体顶边还留着 24px 渐隐（mask=${maskText.slice(0, 72)}），吸住的行头会被一起淡化`)
    }
    if (after.barPresent === true) {
      if (after.barVsHeadBottom === null || Math.abs(after.barVsHeadBottom) > 4) {
        failures.push(`快捷栏没贴在行头下沿（差 ${String(after.barVsHeadBottom)}px）：要么盖住行头，要么中间空一条`)
      } else if (after.barVsHeadBottom < -2) {
        failures.push(`快捷栏盖住了行头 ${String(-after.barVsHeadBottom)}px`)
      }
    } else {
      barNote.push('滚完之后没有快捷栏（内容阈值没到）')
    }

    // 吸住的那根行头必须还能点。
    if (collapsed.expanded !== 'false') {
      failures.push(`滚到 160px 后点行头没收起（aria-expanded=${String(collapsed.expanded)}，落点上是 ${collapsed.hitClass || '空'}）`)
    }
  }
}

console.log('report', JSON.stringify({ before, after, collapsed }))
const pass = `PASS 组体滚到 160px 时行头仍吸在顶部（top 差 ${String(after?.headVsBody ?? before?.headVsBody)}px），且点它还能收起`
console.log(failures.length === 0 ? pass : 'FAIL ' + failures.join('; '))
if (barNote.length > 0) console.log('note ' + barNote.join('；'))

try { electron.kill() } catch {}
server.close()
process.exit(failures.length === 0 ? 0 : 1)
