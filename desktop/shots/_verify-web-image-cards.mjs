/**
 * web 与 read_image 两张专用工具卡的现场探针（差距清单 S4 第三批）。
 *
 * 这一批补上剩下两张「通用卡装不下」的卡：
 *   - **web**（`web_search` / `webfetch`）：头行一枚结果条数（或 HTTP 状态码），展开体是
 *     来源清单——可点标题 + 两行摘要 + 截断说明。数据来自宿主交来的卡片数据
 *     （`presentation.result.card === 'web'`），不是把结果文本反解回去。
 *   - **read_image**：头行说说这是什么图、多大（`PNG · 220 B`），展开体是**这张图本身**。
 *
 * 这个探针造一条真会话，两条路各走一遍：
 *   1. **web 卡走重放**：会话日志里已经有一条 `webfetch` 的调用与结果（带卡片数据），
 *      打开会话时由 `replayHistory` 缝回工具卡。为什么不用真搜索：真搜索要 API key 与
 *      外网，隔离 HOME 里两样都没有；重放这条路恰好覆盖得更狠——它证明「卡片数据落了盘、
 *      刷新会话还在」，这正是数据面改动的目的。
 *   2. **图片卡走真跑**：假模型喊一次 `read_image`（参数指向本探针刚生成的那张 PNG），
 *      宿主真的读盘、真的把图挂进上下文，界面再按路径现读一次画出来。
 *
 * 现场要核的五件事（每件都不是「DOM 里有这个节点」就算数）：
 *   - 两张卡都在，且**标记不串**（web 卡里没有图片，图片卡里没有来源清单）；
 *   - web 卡的三条来源：两条是真链接（`href` / `target=_blank` / `rel`），第三条 URL 为空
 *     时不画成链接（宿主 `toHit` 真会给空 URL，见 `web-search/index.ts:110-121`）；
 *   - 图片卡：`<img>` 的 `src` 是 data URL、`naturalWidth` 真的是 64（不是空图占位）、
 *     屏幕上有高度、底下那行写 `64×48`；
 *   - 头行读数：web 写「2 条结果」，图片写「PNG · …」；两张卡的文件路径都可点；
 *   - **轨迹页一张都没有**：那一页的职责是取证，要看原样参数 JSON 与结果原文。
 *
 * 运行：node desktop/shots/_verify-web-image-cards.mjs
 * 产物：desktop/shots/_web-image-cards.png（隔离 HOME 在 desktop/shots/_verify-web-image-cards-home，跑完删）
 *
 * 前提：`pnpm run build` 与 `pnpm run build:ui` 已跑过（探针加载的是 lib/ 与 lib/ui 的产物）。
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  assert,
  connectCdp,
  counts,
  finish,
  launchDesktop,
  makeHome,
  pollPage,
  requireScene,
  sleep,
  teardown,
} from './_probe-kit.mjs'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const fakePort = 18998
const debugPort = 9378

const home = makeHome({
  shots,
  name: '_verify-web-image-cards-home',
  dirs: ['sessions/demo', 'usage'],
  config: [
    'default:',
    '  provider: fake',
    '  model: fake-cards',
    'providers:',
    '  fake:',
    '    displayName: 自检假端点',
    `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
    '    apiKeyEnv: DSC_FAKE_KEY',
    '    models:',
    '      - id: fake-cards',
    '        name: Fake Cards',
    '        contextWindow: 128000',
    '        maxTokens: 4096',
    '',
  ].join('\n'),
  settings: {
    // read_image 是只读工具，full-access 只是别让别的调用停在审批卡上。
    defaultPolicy: 'full-access',
    ui: { toolDefaultOpen: true, collapseTiming: 'next-input' },
  },
})

// ── 夹具一：一张真的 PNG（64×48 渐变色，手写编码，不引第三方库） ─────────────────
/** CRC32（PNG 每个 chunk 都要）——表驱动，够用就行。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
/** 造一张 RGB 渐变 PNG：`width × height`，颜色随 x/y 变化（截图上一眼看得出是张图）。 */
function gradientPng(width, height) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * stride
    for (let x = 0; x < width; x += 1) {
      raw[row] = 0 // 每行一个 filter 字节：0 = None
      raw[row + 1 + x * 3] = Math.round((x / (width - 1)) * 255)
      raw[row + 2 + x * 3] = Math.round((y / (height - 1)) * 255)
      raw[row + 3 + x * 3] = 128
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 2 // 颜色类型 2 = truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const PNG_W = 64
const PNG_H = 48
const png = gradientPng(PNG_W, PNG_H)
writeFileSync(join(home.work, 'shot.png'), png)

/**
 * 重放用的那份 web 卡片数据：三条来源，刻意造出宿主真实会出现的三种情况。
 *
 *   - 前两条有标题、有摘要、URL 是 https；
 *   - 第三条 `url` 是空串（`web-search/index.ts:110-121` 的 `toHit` 拿不到链接时就是空串），
 *     界面必须画成**不可点的**纯文本，而不是一个 `href=""` 的假链接；
 *   - 第二条摘要带换行（提供方常给的形状），界面要压平。
 */
const WEB_PRESENTATION = {
  call: { card: 'web', query: 'pneuma 视口' },
  result: {
    card: 'web',
    kind: 'search',
    sources: [
      { title: 'Pneuma 文档 · 视口与跟随', url: 'https://example.com/viewport', snippet: '跟随态落到 floor，读历史态保住第一条可见行的屏幕位置。' },
      { title: '滚动协调器设计笔记', url: 'https://example.org/notes', snippet: '第一行\n第二行（提供方换了行）' },
      { title: '没有链接的那条结果', url: '', snippet: '提供方没给 URL。' },
    ],
    truncated: true,
  },
}

const now = Date.now()
writeFileSync(
  join(home.dsc, 'sessions/demo/web-image.jsonl'),
  [
    { type: 'meta', id: 'web-image', cwd: home.work, createdAt: now - 60000 },
    // 这条会话跑「极简模式」：`read_image` 只在那档注册（config-core/presets.ts:134）。
    { type: 'state', id: 'preset', payload: 'minimal' },
    { type: 'user', text: '先看看那两个网页，再看这张图。', ts: now - 50000 },
    {
      type: 'assistant',
      text: '',
      reasoning: '',
      /*
       * 日志里的工具调用是**扁平**形状（`{ id, name, arguments }`），不是协议里的
       * `{ id, type, function: { name, arguments } }`：`core/session.ts:731-735` 读日志时
       * 按扁平字段拼协议那份。写成嵌套形状不会报错，但名字与参数会变成 undefined——
       * 于是 `estimateTokens` 里 `undefined + undefined` 得到 NaN，请求组装时抛
       * 「text is not iterable」，整轮直接失败。
       */
      toolCalls: [{ id: 'call_web_1', name: 'webfetch', arguments: JSON.stringify({ url: 'https://example.com/viewport' }) }],
      ts: now - 49000,
    },
    {
      type: 'tool',
      callId: 'call_web_1',
      name: 'webfetch',
      // 结果文本刻意不含任何可解析结构：卡片若真有来源清单，只可能来自上面那份卡片数据。
      text: '已抓取 3 个来源。',
      presentation: WEB_PRESENTATION,
      ts: now - 48000,
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n') + '\n',
)

/** 假模型：第一跳喊一次 read_image，第二跳（历史里有 tool 结果）给正文收工。 */
const server = createServer((req, res) => {
  void (async () => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const messages = (() => {
      try {
        const parsed = JSON.parse(body)
        return Array.isArray(parsed.messages) ? parsed.messages : []
      } catch {
        return []
      }
    })()
    /**
     * 这一跳该不该喊工具？
     *
     * 不能按「历史里有没有 tool 消息」判：这条会话的历史里本来就有一条重放出来的
     * `webfetch` 结果（造 web 卡用的），那样第一跳就会被当成「工具已经跑过」，
     * 直接回正文收工，`read_image` 永远不会被喊出来。所以按**这次调用本身在不在历史里**判。
     */
    const alreadyCalled = messages.some((message) =>
      (Array.isArray(message.tool_calls) ? message.tool_calls : []).some(
        (call) => call?.function?.name === 'read_image',
      ),
    )
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finishReason = null) => send({ choices: [{ delta: patch, finish_reason: finishReason }] })
    const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    if (!alreadyCalled) {
      delta({
        tool_calls: [
          {
            index: 0,
            id: 'call_shot_1',
            type: 'function',
            function: { name: 'read_image', arguments: JSON.stringify({ path: 'shot.png' }) },
          },
        ],
      })
      delta({}, 'tool_calls')
    } else {
      delta({ content: '网页和图都看过了。' })
      await sleepMs(80)
      delta({}, 'stop')
    }
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 200 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-cards] ${String(error)}\n`)
    try {
      res.end()
    } catch {}
  })
})
server.listen(fakePort, '127.0.0.1')

const desktop = launchDesktop({
  root,
  home: home.home,
  dsc: home.dsc,
  userData: home.userData,
  debugPort,
})
const cdp = await connectCdp({ port: debugPort, log: desktop.log })

/** 页面里反复用到的小工具（每次求值重新定义，探针之间不共享状态）。 */
const PAGE_HELPERS = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const groupOpen = () => document.querySelector('.step-fold')?.getAttribute('data-open') === '1'
  const openGroup = () => {
    if (!groupOpen()) {
      for (const head of document.querySelectorAll('.step-fold')) {
        head.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        break
      }
    }
    return groupOpen()
  }
  const openCards = () => {
    let opened = 0
    for (const card of document.querySelectorAll('.tool-card')) {
      if (card.querySelector('.tool-body') !== null) continue
      const head = card.querySelector('.tool-click')
      if (head === null) continue
      head.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      opened += 1
    }
    return opened
  }
  const has = (selector) => document.querySelector(selector) !== null
  const textOf = (selector) => document.querySelector(selector)?.textContent?.trim() ?? ''
  const boxOf = (selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    const box = node.getBoundingClientRect()
    return { w: Math.round(box.width), h: Math.round(box.height) }
  }
`

// ── 1. 打开造好的会话（重放把 web 卡折出来），再发一条消息让模型喊 read_image ─────
const sessionPath = join(home.dsc, 'sessions/demo/web-image.jsonl')
const ready = await requireScene(cdp.evaluate, {
  name: 'web 卡与图片卡都画出来并且展开着',
  timeoutMs: 90000,
  script: `
    ${PAGE_HELPERS}
    for (let i = 0; i < 120; i += 1) {
      if (typeof window.dsc !== 'undefined' && document.querySelector('.composer textarea') !== null) break
      await wait(250)
    }
    if (typeof window.dsc === 'undefined') return { ok: false, why: 'no window.dsc（preload 没起来）' }
    if ((document.body.dataset.cardsOpened ?? '') !== '1') {
      await window.dsc.invoke('openSession', [${JSON.stringify(sessionPath)}])
      document.body.dataset.cardsOpened = '1'
      await wait(900)
    }
    const input = document.querySelector('.composer textarea')
    if (input === null) return { ok: false, why: 'no textarea' }
    if ((input.dataset.sent ?? '') !== '1') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, '再看这张图。')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dataset.sent = '1'
      await wait(150)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
    }
    openGroup()
    if (has('.tc-web') && has('.tc-shot')) return { ok: true }
    openCards()
    return {
      ok: false,
      cards: document.querySelectorAll('.tool-card').length,
      web: has('.tc-web'),
      shot: has('.tc-shot'),
      heads: [...document.querySelectorAll('.tool-head')].map((node) => node.textContent?.trim().slice(0, 40)),
      // 排查用：消息到底发出去没有、请求有没有报错（报错会落成一条 notice / error 条目）。
      entries: document.querySelectorAll('.entry').length,
      inputValue: (document.querySelector('.composer textarea')?.value ?? '').slice(0, 40),
      notices: [...document.querySelectorAll('.notice, .entry-error, .turn-error')].map((node) => node.textContent?.trim().slice(0, 120)),
      tail: (document.body.innerText ?? '').slice(-400),
    }
  `,
})
if (!ready.ok) {
  process.stdout.write(`[web-image] 场景没到位，最后读到 ${JSON.stringify(ready.facts)}\n`)
}

// 等图片那张卡落定（status-done）：结果没回来时头行只有参数那份数据。
const settled = await pollPage(cdp.evaluate, `
  ${PAGE_HELPERS}
  const done = [...document.querySelectorAll('.tool-card')].filter((card) => card.classList.contains('status-done')).length
  return { ok: done >= 2, done, total: document.querySelectorAll('.tool-card').length }
`, { timeoutMs: 60000, intervalMs: 300 })
assert('两条调用都跑完了（两张卡都是 status-done）', settled.ok === true, JSON.stringify(settled.last))

const digest = await cdp.evaluate(`
  ${PAGE_HELPERS}
  return [...document.querySelectorAll('.tool-card')].map((card) => ({
    status: (card.className.match(/status-([a-z]+)/) ?? [])[1] ?? '?',
    head: card.querySelector('.tool-head')?.textContent?.trim().slice(0, 80) ?? '',
    body: card.querySelector('.tool-body') !== null,
    kind: card.querySelector('.tc-web') !== null ? 'web'
      : card.querySelector('.tc-shot') !== null ? 'shot' : 'generic',
  }))
`)
process.stdout.write(`[web-image] 卡片清单 ${JSON.stringify(digest)}\n`)
assert('阶段组是展开的（照片上才看得见卡体）', (await cdp.evaluate(`
  ${PAGE_HELPERS}
  openGroup()
  await wait(200)
  return groupOpen()
`)) === true)

// ── 2. web 卡：来源清单、可点链接、空 URL 不装成链接、截断说明 ───────────────────
const web = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const card = document.querySelector('.tc-web')
  if (card === null) return { present: false }
  const toolCard = card.closest('.tool-card')
  const sources = [...card.querySelectorAll('.tc-web-source')].map((source) => {
    const link = source.querySelector('.tc-web-link')
    return {
      tag: link?.tagName ?? null,
      text: link?.textContent?.trim() ?? '',
      href: link?.getAttribute('href') ?? null,
      target: link?.getAttribute('target') ?? null,
      rel: link?.getAttribute('rel') ?? null,
      snippet: source.querySelector('.tc-web-snippet')?.textContent?.trim() ?? '',
      // 摘要框的折行口径：normal = 换行按空白收掉（多行摘要因此只占一条的高度）。
      wrap: (() => {
        const node = source.querySelector('.tc-web-snippet')
        return node === null ? null : getComputedStyle(node).whiteSpace
      })(),
    }
  })
  return {
    present: true,
    sources,
    count: toolCard.querySelector('.tc-web-count')?.textContent?.trim() ?? '',
    notes: [...card.querySelectorAll('.tc-web-note')].map((node) => node.textContent?.trim() ?? ''),
    box: boxOf('.tc-web-sources'),
    rawTextShown: (card.textContent ?? '').includes('已抓取 3 个来源'),
    // 反向钉：web 卡里不该出现图片卡的东西（两张卡的标记不许串）。
    shotInside: card.querySelectorAll('.tc-shot-img').length,
  }
`)
process.stdout.write(`[web-image] web ${JSON.stringify(web)}\n`)
assert('web 卡在页面上（.tc-web）', web?.present === true)
assert('来源清单三条', web?.sources?.length === 3, String(web?.sources?.length))
assert('第一条是链接（tag 是 A）', web?.sources?.[0]?.tag === 'A', String(web?.sources?.[0]?.tag))
assert('第一条的标题取自卡片数据的 title', web?.sources?.[0]?.text === 'Pneuma 文档 · 视口与跟随', String(web?.sources?.[0]?.text))
assert('第一条的 href 是那张卡的 URL', web?.sources?.[0]?.href === 'https://example.com/viewport', String(web?.sources?.[0]?.href))
assert('外链在新窗口打开（target=_blank）', web?.sources?.[0]?.target === '_blank', String(web?.sources?.[0]?.target))
assert('外链带 rel="noreferrer noopener"', String(web?.sources?.[0]?.rel ?? '') === 'noreferrer noopener', String(web?.sources?.[0]?.rel))
assert('摘要按卡片数据原样显示', String(web?.sources?.[0]?.snippet ?? '').includes('跟随态落到 floor'), String(web?.sources?.[0]?.snippet))
assert('多行摘要被压成一行（浏览器把换行当空白收掉）', String(web?.sources?.[1]?.snippet ?? '').includes('第一行') && String(web?.sources?.[1]?.snippet ?? '').includes('第二行') && web?.sources?.[1]?.wrap === 'normal', JSON.stringify({ snippet: web?.sources?.[1]?.snippet, wrap: web?.sources?.[1]?.wrap }))
assert('URL 为空的那条不画成链接（tag 是 SPAN、没有 href）', web?.sources?.[2]?.tag === 'SPAN' && web?.sources?.[2]?.href === null && web?.sources?.[2]?.text === '没有链接的那条结果', JSON.stringify(web?.sources?.[2]))
assert('头行的结果读数写「3 条结果」（三条都算，空链接那条也是真结果）', web?.count === '3 条结果', String(web?.count))
assert('截断说明摊出来了', (web?.notes ?? []).some((note) => note.includes('只列了前')), JSON.stringify(web?.notes))
assert('来源清单在屏幕上有高度', (web?.box?.h ?? 0) > 20, JSON.stringify(web?.box))
assert('卡片没有把结果原文糊上去（来源来自卡片数据）', web?.rawTextShown === false, String(web?.rawTextShown))
assert('web 卡里没有图片卡的标记（两张卡不串）', web?.shotInside === 0, String(web?.shotInside))

// ── 3. 图片卡：真 <img>、真尺寸、可点、底下那行读数 ──────────────────────────────
/**
 * 先等图**真的解码完**再断言：卡片是先挂 `<img>`、`onLoad` 之后才拿到尺寸的，
 * 只等「卡画出来了」会在图还没解出来的那一帧上量到 `naturalWidth === 0`。
 */
const shotReady = await pollPage(cdp.evaluate, `
  ${PAGE_HELPERS}
  const img = document.querySelector('.tc-shot-img')
  if (img === null) return { ok: false, why: 'no img' }
  return { ok: img.complete === true && img.naturalWidth > 0, w: img.naturalWidth }
`, { timeoutMs: 20000, intervalMs: 200 })
assert('图片真的解码出来了（complete 且 naturalWidth > 0）', shotReady.ok === true, JSON.stringify(shotReady.last))

const shot = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const card = document.querySelector('.tc-shot')
  if (card === null) return { present: false }
  const toolCard = card.closest('.tool-card')
  const img = card.querySelector('.tc-shot-img')
  return {
    present: true,
    hasImg: img !== null,
    src: img?.getAttribute('src')?.slice(0, 30) ?? '',
    natural: img === null ? null : { w: img.naturalWidth, h: img.naturalHeight },
    alt: img?.getAttribute('alt') ?? '',
    role: img?.getAttribute('role') ?? null,
    tabIndex: img?.getAttribute('tabindex') ?? null,
    rendered: img === null ? null : { w: Math.round(img.getBoundingClientRect().width), h: Math.round(img.getBoundingClientRect().height) },
    meta: card.querySelector('.tc-shot-meta')?.textContent?.trim() ?? '',
    notes: [...card.querySelectorAll('.tc-shot-note')].map((node) => node.textContent?.trim() ?? ''),
    badge: toolCard.querySelector('.tc-shot-badge')?.textContent?.trim() ?? '',
    pathText: toolCard.querySelector('.tool-head .tc-path-btn')?.textContent?.trim() ?? '',
    open: toolCard.querySelector('.tool-head .tc-path-btn')?.getAttribute('data-tc-open') ?? null,
    webInside: card.querySelectorAll('.tc-web-source').length,
  }
`)
process.stdout.write(`[web-image] shot ${JSON.stringify(shot)}\n`)
assert('图片卡在页面上（.tc-shot）', shot?.present === true)
assert('图真的是 <img>（不是占位块）', shot?.hasImg === true)
assert('src 是从宿主现读回来的 data URL', String(shot?.src ?? '').startsWith('data:image/png;base64,'), String(shot?.src))
assert('浏览器真的解出了原始尺寸 64×48（不是空图）', shot?.natural?.w === 64 && shot?.natural?.h === 48, JSON.stringify(shot?.natural))
assert('图在屏幕上有高度（不是 0 高的空壳）', (shot?.rendered?.h ?? 0) > 20, JSON.stringify(shot?.rendered))
assert('图最多铺满块宽（没有溢出容器）', (shot?.rendered?.w ?? 0) <= PNG_W * 4, JSON.stringify(shot?.rendered))
assert('alt 是文件名（读屏软件念得出是什么）', shot?.alt === 'shot.png', String(shot?.alt))
assert('图能点开（role=button + tabindex=0，键盘也够得着）', shot?.role === 'button' && shot?.tabIndex === '0', JSON.stringify({ role: shot?.role, tabIndex: shot?.tabIndex }))
assert('图底下那行写 64×48', shot?.meta === '64×48', String(shot?.meta))
assert('头行读数是「格式 · 体积」', /^PNG · /.test(String(shot?.badge ?? '')), String(shot?.badge))
assert('头行的文件名可取点（read_image 与 read 同一族）', shot?.pathText === 'shot.png' && String(shot?.open ?? '').endsWith('shot.png'), JSON.stringify({ text: shot?.pathText, open: shot?.open }))
assert('图片卡里没有来源清单的标记（两张卡不串）', shot?.webInside === 0, String(shot?.webInside))

// 点一下图：开右侧预览页签，且卡不许跟着折（卡体的点击不该被头行的开关吃掉）。
const clickImg = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const img = document.querySelector('.tc-shot-img')
  if (img === null) return { ok: false }
  img.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(700)
  const chips = [...document.querySelectorAll('.dock-chip-label')].map((node) => node.textContent?.trim() ?? '')
  return { ok: true, stillOpen: document.querySelector('.tc-shot') !== null, chips }
`)
process.stdout.write(`[web-image] 点图 ${JSON.stringify(clickImg)}\n`)
assert('点图不会把卡折起来', clickImg?.ok === true && clickImg?.stillOpen === true, JSON.stringify(clickImg))
assert('点图打开的是这张图的预览页签', (clickImg?.chips ?? []).includes('shot.png'), JSON.stringify(clickImg?.chips))

// ── 4. 反向钉：轨迹页一张专用卡都没有，原样参数与结果原文都在 ─────────────────────
const traceState = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const tab = [...document.querySelectorAll('button, [role="tab"], a')]
    .find((node) => node.textContent?.trim() === '轨迹')
  if (tab === undefined) return { ok: false, why: 'no trace tab' }
  tab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  // 等轨迹页真的挂出来（trace-page 那个根节点），再等它把两张卡建好：
  // 只等卡数会被对话页那两张骗过。
  for (let i = 0; i < 60; i += 1) {
    if (document.querySelector('.trace-page') !== null && document.querySelectorAll('.tool-card').length >= 2) break
    await wait(250)
  }
  const cards = [...document.querySelectorAll('.tool-card')]
  for (const card of cards) {
    if (card.querySelector('.tool-body') === null) {
      card.querySelector('.tool-click')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
  }
  await wait(600)
  const bodies = cards.map((card) => ({
    head: card.querySelector('.tool-head')?.textContent?.trim().slice(0, 40) ?? '',
    args: card.querySelector('.tool-body .args')?.textContent ?? '',
    result: card.querySelector('.tool-body .result')?.textContent ?? '',
  }))
  return {
    ok: true,
    cards: cards.length,
    special: document.querySelectorAll('.tc-web, .tc-shot').length,
    bodies,
  }
`)
process.stdout.write(`[web-image] 轨迹页 ${JSON.stringify({ ...traceState, bodies: (traceState?.bodies ?? []).map((body) => ({ head: body.head, args: String(body.args).slice(0, 80), result: String(body.result).slice(0, 60) })) })}\n`)
assert('切到轨迹页之后一张专用卡都没有（.tc-web / .tc-shot）', traceState?.ok === true && traceState?.special === 0, String(traceState?.special))
assert('轨迹页照旧摊原始参数（read_image 的 path 字段）', (traceState?.bodies ?? []).some((body) => String(body.args).includes('"path": "shot.png"')), JSON.stringify((traceState?.bodies ?? []).map((body) => String(body.args).slice(0, 60))))
assert('轨迹页照旧摊结果原文（宿主的「已加载图片」那句）', (traceState?.bodies ?? []).some((body) => String(body.result).includes('已加载图片')), JSON.stringify((traceState?.bodies ?? []).map((body) => String(body.result).slice(0, 40))))

// 切回对话页拍照。两张卡分属两条消息、各自一个阶段组，而且上一条的组在用户发下一条时
// 已经自动收起了（`collapseTiming: 'next-input'`）——所以拍照前要**按卡找到它自己那一组**
// 再点开，不能一股脑点所有组头（那会把已经开着的又关掉）。
const shotWeb = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const tab = [...document.querySelectorAll('button, [role="tab"], a')]
    .find((node) => node.textContent?.trim() === '对话')
  tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(1200)
  /** 装这张卡的那个阶段组的组头（从 .step-seat 往上找 .step-fold）。 */
  const click = (node) => node?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  const card = () => document.querySelector('.tc-web')
  const webHeight = () => boxOf('.tc-web-sources')?.h ?? 0
  const processHeight = () => card()?.closest('.turn-seat')?.querySelector('.turn-process-body')?.getBoundingClientRect().height ?? 0
  const stepHidden = () => card()?.closest('.step-seat')?.querySelector('.step-body')?.hasAttribute('hidden') === true
  /*
   * 先摊卡体、再摊两层折叠，而且**摊折叠放在最后**：openCards() 会写折叠存档、引发一次
   * 整表重渲染，实测重渲染之后组头的展开态会回到默认（老的那一轮默认收着）。所以顺序是
   * 「先点卡，再点组」，最后量一次高度就截图，中间不再有任何会触发重渲染的动作。
   */
  openCards()
  await wait(400)
  for (let i = 0; i < 4 && webHeight() < 20; i += 1) {
    // 第一层：整轮（收起时过程区高度 0）。点之前先判，点已经开着的那层反而会关掉。
    if (processHeight() === 0) {
      click(card()?.closest('.turn-seat')?.querySelector('.turn-fold'))
      await wait(600)
    }
    // 第二层：这一步（组体收起时 .step-body 带 hidden）。
    if (stepHidden()) {
      click(card()?.closest('.step-seat')?.querySelector('.step-fold'))
      await wait(700)
    }
  }
  document.querySelector('.tc-web')?.scrollIntoView({ block: 'center' })
  await wait(400)
  return {
    web: has('.tc-web'),
    shot: has('.tc-shot'),
    webBox: boxOf('.tc-web-sources'),
    shotBox: boxOf('.tc-shot-img'),
  }
`)
process.stdout.write(`[web-image] 拍照准备 ${JSON.stringify(shotWeb)}\n`)
assert('拍照时两张卡都展开着（web 的来源清单在屏幕上有高度）', shotWeb?.web === true && (shotWeb?.webBox?.h ?? 0) > 20, JSON.stringify(shotWeb?.webBox))
await cdp.shot(join(shots, '_web-image-cards.png'))

// 第二张：滚到图片卡（本轮消息在下面，第一张照片里被挤出视野了）。
const shotImage = await cdp.evaluate(`
  ${PAGE_HELPERS}
  /**
   * 「看得见」只认 checkVisibility，不认高度：组体是 hidden="until-found" 收起来的，
   * 里面那张图**仍留着布局盒子**（量出来 64×48），但一个像素都不画——拿高度判会把
   * 「收着」当成「开着」，照片上就什么都没有（_verify-tool-views.mjs 的注释记过同一条）。
   */
  const visible = () => {
    const node = document.querySelector('.tc-shot-img')
    return node !== null && node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  }
  const head = document.querySelector('.tc-shot')?.closest('.step-seat')?.querySelector('.step-fold') ?? null
  for (let i = 0; i < 4 && !visible(); i += 1) {
    head?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(800)
  }
  document.querySelector('.tc-shot')?.scrollIntoView({ block: 'center' })
  await wait(500)
  return { visible: visible(), box: boxOf('.tc-shot-img'), meta: textOf('.tc-shot-meta') }
`)
process.stdout.write(`[web-image] 拍照准备（图片） ${JSON.stringify(shotImage)}\n`)
assert('第二张照片里图片卡真的画出来了（checkVisibility + 有高度）', shotImage?.visible === true && (shotImage?.box?.h ?? 0) > 20, JSON.stringify(shotImage))
await cdp.shot(join(shots, '_web-image-cards-image.png'))

// ── 5. 收尾 ──────────────────────────────────────────────────────────────────
teardown([cdp, { stop: () => desktop.stop() }, { stop: () => server.close() }, home])
const tally = counts()
process.stdout.write(`[web-image] 截图 desktop/shots/_web-image-cards.png 与 _web-image-cards-image.png，共 ${String(tally.total)} 条断言\n`)
finish('web-image')
