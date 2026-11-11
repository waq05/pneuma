/**
 * read / search / todo 三张专用工具卡的现场探针（差距清单 S4 的第二批）。
 *
 * 改之前：三件事都走同一张通用卡——read 是一条「读取 · sample.txt」+ 参数表（`offset` /
 * `limit` 自己心算），grep 是「搜索文件内容 · needle」+ 一坨结果原文，todo_write 是
 * 一段压平的 `todos` 数组 JSON。改之后各自有一张卡：**read** 头行说「读了哪个文件的哪一段」
 * （路径可点）、展开是行号 + 原文的预览；**检索**头行说命中了多少、展开按文件列命中
 * （路径可点）；**待办**头行说完成了几条、展开是四态勾选清单。
 *
 * 这个探针造一条真会话：假模型第一跳一次吐三个工具调用（read / grep / todo_write），宿主
 * 真的把它们跑掉（读的是隔离 HOME 里造的两个小文件），第二跳给一句正文收工。然后在页面上核：
 *
 *   1. 三张卡都在（`.tc-read` / `.tc-search` / `.tc-todo`），且各自的数据对得上：
 *      read 5 行、行号 3–7、头行写「第 3–7 行」；检索 2 个文件 3 处命中；待办 3 条、1/3 完成；
 *   2. **路径可点**：read 卡的头行路径按钮、检索卡每个文件组的路径按钮都带着绝对路径读数
 *      （`data-tc-open`），且点它不折卡（卡体还在）；
 *   3. **展开后有内容且高度 > 0**：卡片在 DOM 里不等于在屏幕上——阶段组默认收着时断言全过、
 *      照片上却只有一行组头（`_verify-bash-card.mjs` 踩过一次）；
 *   4. **组收起时它们跟着藏**：收起阶段组之后再量三张卡的屏幕高度，必须是 0；重新展开后
 *      又回来（证明是藏起来，不是被卸掉）。
 *
 * 三条与产品设置有关的刻意做法：
 *  - `defaultPolicy: 'full-access'`：read / grep 才跑得起来，不会停在审批卡上；
 *  - `toolDefaultOpen: true` + `collapseTiming: 'next-input'`：卡默认展开，收工后过程区也摊着
 *    （仍然留了「点开卡头」的兜底，万一默认档没生效）；
 *  - 三条「禁后台节流」的开关由 `_probe-kit.mjs` 的 `launchDesktop` 统一带上（窗口被挡住时
 *    Chromium 会把定时器压到 1Hz，测量到处是 0）。
 *
 * 运行：node desktop/shots/_verify-tool-views.mjs
 * 产物：desktop/shots/_tool-views.png（隔离 HOME 在 desktop/shots/_verify-tool-views-home，跑完删）
 *
 * 前提：`pnpm run build` 与 `pnpm run build:ui` 已跑过（探针加载的是 lib/ 与 lib/ui 的产物）。
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
const fakePort = 18997
const debugPort = 9377

const home = makeHome({
  shots,
  name: '_verify-tool-views-home',
  dirs: ['sessions/demo', 'usage'],
  config: [
    'default:',
    '  provider: fake',
    '  model: fake-views',
    'providers:',
    '  fake:',
    '    displayName: 自检假端点',
    `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
    '    apiKeyEnv: DSC_FAKE_KEY',
    '    models:',
    '      - id: fake-views',
    '        name: Fake Views',
    '        contextWindow: 128000',
    '        maxTokens: 4096',
    '',
  ].join('\n'),
  settings: {
    defaultPolicy: 'full-access',
    ui: { toolDefaultOpen: true, collapseTiming: 'next-input' },
  },
})

/** 夹具：读的那份文件（12 行）与两份带 needle 的文件（grep 用）。 */
const SAMPLE_LINES = [
  'alpha one',
  'beta two',
  'gamma three',
  'delta four',
  'epsilon five',
  'zeta six',
  'eta seven',
  'theta eight',
  'iota nine',
  'kappa ten',
  'lambda eleven',
  'mu twelve',
]
writeFileSync(join(home.work, 'sample.txt'), `${SAMPLE_LINES.join('\n')}\n`)
writeFileSync(join(home.work, 'a.txt'), 'needle in a.txt line 1\nplain line\nneedle again on line 3\n')
writeFileSync(join(home.work, 'b.md'), '# doc\nneedle in b.md\n')
/**
 * 夹具目录得先把自己「解忽略」。
 *
 * 为什么：这个临时 HOME 落在 `desktop/shots/` 下，而仓库的 `.gitignore` 里有一条
 * `desktop/shots/**`（截图产物不入库）。`grep` / `glob` 会先查 git 根再逐层读 `.gitignore`
 * （`packages/tools-default/search-tools.ts:244-265`），于是夹具文件全被当成「忽略掉的」，
 * 真机上表现成「搜 needle 没有匹配」——那不是卡片的 bug，是夹具被忽略规则吃了。
 * 这里在 work 目录里写一条 `!*`：忽略规则按「后出现的赢」结算（`search-tools.ts:220-226`），
 * 子目录的规则排在父目录之后，夹具因此重新可见。
 */
writeFileSync(join(home.work, '.gitignore'), '!*\n')

/** 一次吐三个调用：读第 3–7 行、按内容找 needle、写一张三条的待办清单。 */
const READ_CALL = { path: 'sample.txt', offset: 3, limit: 5 }
const GREP_CALL = { pattern: 'needle' }
const TODO_CALL = {
  todos: [
    { id: 't1', content: 'write tests', status: 'completed' },
    { id: 't2', content: 'run build', status: 'in_progress' },
    { id: 't3', content: 'clean up', status: 'pending' },
  ],
}

const now = Date.now()
writeFileSync(
  join(home.dsc, 'sessions/demo/tool-views.jsonl'),
  [
    { type: 'meta', id: 'tool-views', cwd: home.work, createdAt: now - 60000 },
    { type: 'user', text: '读一段、搜一下、再记一张待办。', ts: now - 50000 },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n',
)

/** 假模型：第一跳吐三个工具调用，第二跳（历史里有 tool 结果）给正文收工。 */
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
    const hasToolResult = messages.some((message) => message.role === 'tool')
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finishReason = null) => send({ choices: [{ delta: patch, finish_reason: finishReason }] })
    const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    if (!hasToolResult) {
      // 三个调用一次送齐（各有自己的 index）：宿主会把三条都跑掉。
      const calls = [
        { name: 'read', args: READ_CALL },
        { name: 'grep', args: GREP_CALL },
        { name: 'todo_write', args: TODO_CALL },
      ]
      delta({
        tool_calls: calls.map((call, index) => ({
          index,
          id: `call_views_${String(index + 1)}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      })
      delta({}, 'tool_calls')
    } else {
      delta({ content: '三件事都做完了。' })
      await sleepMs(80)
      delta({}, 'stop')
    }
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 200 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-views] ${String(error)}\n`)
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
  /** 卡体收着就把那张卡的头点开（默认档没生效时的兜底）。 */
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

// ── 1. 先打开造好的那条会话（工作目录是隔离 HOME 里的 work），再发消息 ────────
/** 造好的会话：read / grep 都按它的 cwd 解析相对路径（不打开它就会落到仓库根目录）。 */
const sessionPath = join(home.dsc, 'sessions/demo/tool-views.jsonl')
const ready = await requireScene(cdp.evaluate, {
  name: '三张专用卡都画出来并且展开着',
  timeoutMs: 90000,
  script: `
    ${PAGE_HELPERS}
    for (let i = 0; i < 120; i += 1) {
      if (typeof window.dsc !== 'undefined' && document.querySelector('.composer textarea') !== null) break
      await wait(250)
    }
    if (typeof window.dsc === 'undefined') return { ok: false, why: 'no window.dsc（preload 没起来）' }
    if ((document.body.dataset.viewsOpened ?? '') !== '1') {
      // 直接按路径打开：探针文件所在的那条会话，cwd 才是隔离 work 目录。
      await window.dsc.invoke('openSession', [${JSON.stringify(sessionPath)}])
      document.body.dataset.viewsOpened = '1'
      await wait(600)
    }
    const input = document.querySelector('.composer textarea')
    if (input === null) return { ok: false, why: 'no textarea' }
    if ((input.dataset.sent ?? '') !== '1') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, '读一段、搜一下、再记一张待办。')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dataset.sent = '1'
      await wait(150)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
    }
    openGroup()
    if (has('.tc-read') && has('.tc-search') && has('.tc-todo')) return { ok: true }
    openCards()
    return {
      ok: false,
      cards: document.querySelectorAll('.tool-card').length,
      read: has('.tc-read'),
      search: has('.tc-search'),
      todo: has('.tc-todo'),
    }
  `,
})
if (!ready.ok) {
  process.stdout.write(`[tool-views] 场景没到位，最后读到 ${JSON.stringify(ready.facts)}\n`)
}

// 等三条调用全部落定（status-done）：结果没回来时卡片上只有参数那份数据。
const settled = await pollPage(cdp.evaluate, `
  ${PAGE_HELPERS}
  const cards = [...document.querySelectorAll('.tool-card')]
  const done = cards.filter((card) => card.classList.contains('status-done')).length
  return { ok: done >= 3, done, total: cards.length }
`, { timeoutMs: 60000, intervalMs: 300 })
assert('一条消息里的三条调用都跑完了（3 张卡都是 status-done）', settled.ok === true, JSON.stringify(settled.last))

/** 每张卡此刻的一句话摘要：失败时靠它看出是哪一条没跑完（名字 / 状态 / 卡体在不在）。 */
const digest = await cdp.evaluate(`
  ${PAGE_HELPERS}
  return [...document.querySelectorAll('.tool-card')].map((card) => ({
    status: (card.className.match(/status-([a-z]+)/) ?? [])[1] ?? '?',
    head: card.querySelector('.tool-head')?.textContent?.trim().slice(0, 80) ?? '',
    body: card.querySelector('.tool-body') !== null,
    kind: card.querySelector('.tc-read') !== null ? 'read'
      : card.querySelector('.tc-search') !== null ? 'search'
      : card.querySelector('.tc-todo') !== null ? 'todo'
      : card.querySelector('.tc-bash') !== null ? 'bash' : 'generic',
  }))
`)
process.stdout.write(`[tool-views] 卡片清单 ${JSON.stringify(digest)}\n`)
assert('阶段组是展开的（照片上才看得见卡体）', (await cdp.evaluate(`
  ${PAGE_HELPERS}
  openGroup()
  await wait(200)
  return groupOpen()
`)) === true)

// ── 2. read 卡 ───────────────────────────────────────────────────────────────
const read = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const card = document.querySelector('.tc-read')
  if (card === null) return { present: false }
  const toolCard = card.closest('.tool-card')
  const lines = card.querySelector('.tc-read-lines')
  const no = [...card.querySelectorAll('.tc-read-no')].map((node) => node.textContent.trim())
  const text = [...card.querySelectorAll('.tc-read-text')].map((node) => node.textContent)
  const chip = toolCard.querySelector('.tc-range')
  const path = toolCard.querySelector('.tool-head .tc-path-btn')
  return {
    present: true,
    lines: no.length,
    first: no[0] ?? null,
    last: no[no.length - 1] ?? null,
    firstText: text[0] ?? '',
    lastText: text[text.length - 1] ?? '',
    chip: chip?.textContent?.trim() ?? '',
    open: path?.getAttribute('data-tc-open') ?? null,
    pathText: path?.textContent?.trim() ?? '',
    box: boxOf('.tc-read-lines'),
    maxHeight: lines === null ? null : Number.parseFloat(getComputedStyle(lines).maxHeight),
    note: card.querySelector('.tc-read-note')?.textContent?.trim() ?? '',
  }
`)
process.stdout.write(`[tool-views] read ${JSON.stringify(read)}\n`)
assert('read 卡在页面上（.tc-read）', read?.present === true)
assert('内容预览有 5 行（offset 3 / limit 5）', read?.lines === 5, String(read?.lines))
assert('第一行的行号是 3', read?.first === '3', String(read?.first))
assert('最后一行的行号是 7（结果里的真实行号）', read?.last === '7', String(read?.last))
assert('正文对上号（第 3 行是 gamma three）', read?.firstText === 'gamma three', String(read?.firstText))
assert('正文对上号（第 7 行是 eta seven）', read?.lastText === 'eta seven', String(read?.lastText))
assert('头行的区间读数写「第 3–7 行」', read?.chip === '第 3–7 行', String(read?.chip))
assert('头行的文件名是可点的路径按钮', read?.pathText === 'sample.txt', String(read?.pathText))
assert('路径按钮带绝对路径读数（点开预览吃绝对的）', String(read?.open ?? '').endsWith('sample.txt'), String(read?.open))
assert('预览区在屏幕上有高度', (read?.box?.h ?? 0) > 20, JSON.stringify(read?.box))
assert('预览区限高（max-height 是个有限像素值）', Number.isFinite(read?.maxHeight) === true && (read?.maxHeight ?? 0) < 10000, String(read?.maxHeight))

// ── 3. 检索卡 ────────────────────────────────────────────────────────────────
const search = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const card = document.querySelector('.tc-search')
  if (card === null) return { present: false }
  const toolCard = card.closest('.tool-card')
  const files = [...card.querySelectorAll('.tc-search-file')].map((file) => ({
    path: file.querySelector('.tc-path-btn')?.getAttribute('data-tc-open') ?? null,
    text: file.querySelector('.tc-path-btn')?.textContent?.trim() ?? '',
  }))
  return {
    present: true,
    files: files.length,
    paths: files.map((file) => file.text),
    opens: files.map((file) => file.path),
    hits: card.querySelectorAll('.tc-search-hit').length,
    lineNumbers: [...card.querySelectorAll('.tc-search-line')].map((node) => node.textContent.trim()),
    chip: toolCard.querySelector('.tc-hit-count')?.textContent?.trim() ?? '',
    box: boxOf('.tc-search-files'),
    cardOpen: toolCard.querySelector('.tool-body') !== null,
  }
`)
process.stdout.write(`[tool-views] search ${JSON.stringify(search)}\n`)
assert('检索卡在页面上（.tc-search）', search?.present === true)
assert('命中分两个文件（a.txt / b.md）', search?.files === 2, String(search?.files))
assert('三处命中（a.txt 两处 + b.md 一处）', search?.hits === 3, String(search?.hits))
assert('文件名是 a.txt', search?.paths?.[0] === 'a.txt', JSON.stringify(search?.paths))
assert('文件名是 b.md', search?.paths?.[1] === 'b.md', JSON.stringify(search?.paths))
assert('每个文件组的路径都可点且带绝对路径', (search?.opens ?? []).every((path) => typeof path === 'string' && path.length > 3 && !path.startsWith('a.txt')), JSON.stringify(search?.opens))
assert('命中带行号（a.txt 的 1 与 3）', search?.lineNumbers?.slice(0, 2).join(',') === '1,3', JSON.stringify(search?.lineNumbers))
assert('头行的命中读数写「3 处 · 2 个文件」', search?.chip === '3 处 · 2 个文件', String(search?.chip))
assert('命中清单在屏幕上有高度', (search?.box?.h ?? 0) > 20, JSON.stringify(search?.box))

// 点一下命中文件里的路径：卡不许跟着折（展开体里的按钮不在头行的展开开关里）。
const clickPath = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const button = document.querySelector('.tc-search-file .tc-path-btn')
  if (button === null) return { ok: false }
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(400)
  return { ok: true, stillOpen: document.querySelector('.tc-search') !== null, chip: document.querySelector('.tc-hit-count')?.textContent ?? '' }
`)
assert('点检索卡里的文件路径不会把卡折起来', clickPath?.ok === true && clickPath?.stillOpen === true, JSON.stringify(clickPath))

// ── 4. 待办卡 ────────────────────────────────────────────────────────────────
const todo = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const card = document.querySelector('.tc-todo')
  if (card === null) return { present: false }
  const toolCard = card.closest('.tool-card')
  const items = [...card.querySelectorAll('.tc-todo-item')]
  return {
    present: true,
    count: items.length,
    states: items.map((item) => item.getAttribute('data-status')),
    texts: items.map((item) => item.querySelector('.tc-todo-text')?.textContent?.trim() ?? ''),
    boxes: card.querySelectorAll('.tc-todo-box').length,
    progress: toolCard.querySelector('.tc-todo-progress')?.textContent?.trim() ?? '',
    active: toolCard.querySelector('.tc-todo-active')?.textContent?.trim() ?? '',
    box: boxOf('.tc-todo-list'),
  }
`)
process.stdout.write(`[tool-views] todo ${JSON.stringify(todo)}\n`)
assert('待办卡在页面上（.tc-todo）', todo?.present === true)
assert('清单三条', todo?.count === 3, String(todo?.count))
assert('三条的状态依次是 完成 / 进行中 / 未做', (todo?.states ?? []).join(',') === 'completed,in_progress,pending', JSON.stringify(todo?.states))
assert('条目正文与模型写的一致', (todo?.texts ?? []).join('|') === 'write tests|run build|clean up', JSON.stringify(todo?.texts))
assert('每条都画了勾选框（3 个）', todo?.boxes === 3, String(todo?.boxes))
assert('头行写「1/3 完成」', todo?.progress === '1/3 完成', String(todo?.progress))
assert('头行带出正在进行的那一条', todo?.active === 'run build', String(todo?.active))
assert('清单在屏幕上有高度', (todo?.box?.h ?? 0) > 20, JSON.stringify(todo?.box))

// ── 5. 组收起时三张卡跟着藏 ───────────────────────────────────────────────────
/**
 * 「藏起来了没有」用 `checkVisibility` 判，不量高度。
 *
 * 为什么：阶段组收起走的是逐行动画（`fold-motion`），末帧挂 `hidden="until-found"`；组体里
 * 那些行**仍留着布局盒子**，`getBoundingClientRect().height` 照样是 141px——`_verify-bash-card.mjs`
 * 的注释里记过同一件事（「组体收着时里面的行照样有布局高度」）。量高度会把「藏起来」判成
 * 「没藏」，所以这里同时看两样：CSS 可见性（`checkVisibility`）与组头自己的 `data-open`。
 */
const VISIBLE_HELPER = `
  const visible = (selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  }
`
const collapse = await cdp.evaluate(`
  ${PAGE_HELPERS}
  ${VISIBLE_HELPER}
  openGroup()
  await wait(300)
  const before = {
    read: visible('.tc-read'),
    search: visible('.tc-search'),
    todo: visible('.tc-todo'),
  }
  const head = document.querySelector('.step-fold')
  if (head === null) return { ok: false, why: 'no step-fold', before }
  head.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  // 逐行收起是按帧跑的（fold-motion），留够两段动效 + 保险。
  await wait(900)
  const collapsed = {
    read: visible('.tc-read'),
    search: visible('.tc-search'),
    todo: visible('.tc-todo'),
  }
  const groupBody = document.querySelector('.step-fold')?.closest('.step')?.querySelector('.step-body') ?? null
  return { ok: true, before, collapsed, groupOpen: groupOpen(), bodyHidden: groupBody?.getAttribute('hidden') ?? null }
`)
process.stdout.write(`[tool-views] collapse ${JSON.stringify(collapse)}\n`)
assert('收起前三张卡都可见', collapse?.before?.read === true && collapse?.before?.search === true && collapse?.before?.todo === true, JSON.stringify(collapse?.before))
assert('阶段组确实收起了（data-open 不再是 1）', collapse?.groupOpen === false, String(collapse?.groupOpen))
assert('收起后 read 卡跟着藏起来（不可见）', collapse?.collapsed?.read === false, String(collapse?.collapsed?.read))
assert('收起后检索卡跟着藏起来（不可见）', collapse?.collapsed?.search === false, String(collapse?.collapsed?.search))
assert('收起后待办卡跟着藏起来（不可见）', collapse?.collapsed?.todo === false, String(collapse?.collapsed?.todo))

// 再把组展开，三张卡要回来（证明确实是藏起来，不是被卸掉）。
const reopen = await cdp.evaluate(`
  ${PAGE_HELPERS}
  ${VISIBLE_HELPER}
  openGroup()
  await wait(600)
  return {
    read: visible('.tc-read'),
    search: visible('.tc-search'),
    todo: visible('.tc-todo'),
    height: boxOf('.tc-read')?.h ?? 0,
    groupOpen: groupOpen(),
  }
`)
process.stdout.write(`[tool-views] reopen ${JSON.stringify(reopen)}\n`)
assert('重新展开后 read 卡回来了（可见）', reopen?.read === true, String(reopen?.read))
assert('重新展开后检索卡回来了（可见）', reopen?.search === true, String(reopen?.search))
assert('重新展开后待办卡回来了（可见）', reopen?.todo === true, String(reopen?.todo))
assert('重新展开后 read 卡又有真实高度（不是空壳）', (reopen?.height ?? 0) > 20, String(reopen?.height))

// ── 6. 反向钉：轨迹页照旧摊原始参数与结果原文（不走这三张卡） ─────────────────
/**
 * 差距清单那条硬要求的现场版：**专用卡只在对话页生效**。轨迹页的职责是取证，要把原样的
 * 参数 JSON 与结果原文摊开；换成 read / 检索 / 待办卡之后，被格式化掉的那份原文就再也
 * 看不到。这里真切到轨迹页、真把那一行点开，核两件事：三张卡的标记一个都没有，
 * 原始参数与结果原文在。
 */
const traceState = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const tab = [...document.querySelectorAll('button, [role="tab"], a')]
    .find((node) => node.textContent?.trim() === '轨迹')
  if (tab === undefined) return { ok: false, why: 'no trace tab' }
  tab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(1200)
  const cards = [...document.querySelectorAll('.tool-card')]
  // 轨迹页的卡是临时展开态（初值收起）：把「读取」那一行点开，才能看到参数与结果。
  const readRow = cards.find((card) => (card.querySelector('.tool-head')?.textContent ?? '').includes('读取'))
  readRow?.querySelector('.tool-click')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(500)
  const body = readRow?.querySelector('.tool-body') ?? null
  return {
    ok: true,
    cards: cards.length,
    special: document.querySelectorAll('.tc-read, .tc-search, .tc-todo').length,
    args: body?.querySelector('.args')?.textContent ?? '',
    result: body?.querySelector('.result')?.textContent ?? '',
  }
`)
process.stdout.write(`[tool-views] 轨迹页 ${JSON.stringify({ ...traceState, args: String(traceState?.args ?? '').slice(0, 120), result: String(traceState?.result ?? '').slice(0, 80) })}\n`)
assert('切到轨迹页之后一张专用卡都没有（.tc-read / .tc-search / .tc-todo）', traceState?.ok === true && traceState?.special === 0, String(traceState?.special))
assert('轨迹页照旧摊原始参数 JSON（读到 path 字段）', String(traceState?.args ?? '').includes('"path": "sample.txt"'), String(traceState?.args ?? '').slice(0, 120))
assert('轨迹页照旧摊结果原文（读到第 3 行原文）', String(traceState?.result ?? '').includes('gamma three'), String(traceState?.result ?? '').slice(0, 80))

// 切回对话页，照片拍的是三张卡（不是轨迹页）。
await cdp.evaluate(`
  ${PAGE_HELPERS}
  const tab = [...document.querySelectorAll('button, [role="tab"], a')]
    .find((node) => node.textContent?.trim() === '对话')
  tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(1200)
  openGroup()
  await wait(300)
  return true
`)

// ── 7. 组体是可滚的：三张卡加起来比组体高，最后那张要滚一下才看得全 ────────────
/**
 * 这一段不是给卡片补台，是**交代清楚截图看得到什么**。
 *
 * 阶段组自己的组体有上限（`views.css` 的 `.step-body`：`max-height: min(400px, 50vh)` +
 * `overflow-y: auto`），三张卡加起来比它高，所以组体顶部那一屏只能看到 read 与检索两张卡，
 * 待办卡的清单露在组体下缘之外（它没被裁掉，是在组体的滚动区里，滚一下就有）。
 * 第一张截图按默认（组体滚到顶）拍，第二张把组体滚到底再拍——两张一起才算看过现场。
 */
const scrollState = await cdp.evaluate(`
  ${PAGE_HELPERS}
  // 只认「装着待办卡的那个组体」：页面上可能同时挂着好几处组体（轨迹页也有一套）。
  const body = document.querySelector('.tc-todo')?.closest('.step-body') ?? null
  if (body === null) return { ok: false, why: 'no step-body around the todo card' }
  const scrollable = body.scrollHeight > body.clientHeight
  body.scrollTop = body.scrollHeight
  await wait(250)
  const bodyBox = body.getBoundingClientRect()
  const list = document.querySelector('.tc-todo-list')?.getBoundingClientRect() ?? null
  const inView = list !== null
    && list.top >= bodyBox.top - 1
    && list.bottom <= bodyBox.bottom + 1
  return {
    ok: true,
    scrollable,
    scrollTop: Math.round(body.scrollTop),
    scrollHeight: Math.round(body.scrollHeight),
    clientHeight: Math.round(body.clientHeight),
    inView,
    listH: list === null ? 0 : Math.round(list.height),
  }
`)
process.stdout.write(`[tool-views] 组体滚动 ${JSON.stringify(scrollState)}\n`)
assert('组体是可滚的（三张卡加起来高过组体上限，靠组体自己滚）', scrollState?.scrollable === true, JSON.stringify(scrollState))
assert('滚到底之后待办清单完整落在组体视野里', scrollState?.inView === true && (scrollState?.listH ?? 0) > 20, JSON.stringify(scrollState))
await cdp.shot(join(shots, '_tool-views-todo.png'))

// 第一张截图按默认位置（组体滚到顶）拍，与用户打开这一轮时看到的顺序一致。
const headProbe = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const body = document.querySelector('.step-body')
  if (body !== null) body.scrollTop = 0
  await wait(200)
  const card = document.querySelector('.tc-read')?.closest('.tool-card') ?? null
  const chip = card?.querySelector('.tc-range') ?? null
  const box = chip?.getBoundingClientRect() ?? null
  return {
    chipText: chip?.textContent ?? '',
    chipVisible: chip === null ? null : chip.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    chip: box === null ? null : { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) },
    dpr: window.devicePixelRatio,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  }
`)
process.stdout.write(`[tool-views] 头行读数 ${JSON.stringify(headProbe)}\n`)
assert('头行的区间读数在默认状态下可见', headProbe?.chipVisible === true && headProbe?.chipText === '第 3–7 行', JSON.stringify(headProbe))

/**
 * 把真鼠标移到头行上：那颗「在轨迹中查看」药丸会亮起来（绝对定位压在行尾），
 * 所以行尾的读数必须同时淡出——不然药丸会盖住「第 3–7 行」的半截。
 */
const hoverPoint = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const head = document.querySelector('.tc-read')?.closest('.tool-card')?.querySelector('.tool-head')
  if (head === null || head === undefined) return null
  const box = head.getBoundingClientRect()
  return { x: Math.round(box.left + Math.min(120, box.width / 2)), y: Math.round(box.top + box.height / 2) }
`)
/**
 * 真鼠标移上去，然后**轮询**等药丸亮起来。
 *
 * 为什么不睡一次就判：这一轮里刚去过轨迹页又切回来，聊天区会重渲染，指针底下的节点可能
 * 在这一拍被换掉（`:hover` 随之丢掉）。轮询 + 每次重发一次 `mouseMoved` 才稳。
 */
let hoverState = null
if (hoverPoint !== null) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 200, buttons: 0 })
  await sleep(150)
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: hoverPoint.x + attempt,
      y: hoverPoint.y,
      buttons: 0,
    })
    await sleep(220)
    hoverState = await cdp.evaluate(`
      ${PAGE_HELPERS}
      const card = document.querySelector('.tc-read')?.closest('.tool-card') ?? null
      const chip = card?.querySelector('.tc-range') ?? null
      const pill = card?.querySelector('.tc-trace') ?? null
      return {
        chipOpacity: chip === null ? null : getComputedStyle(chip).opacity,
        pillOpacity: pill === null ? null : getComputedStyle(pill).opacity,
        hovered: [...document.querySelectorAll(':hover')].map((node) => String(node.className)).slice(-3),
      }
    `)
    if (hoverState?.pillOpacity === '1') break
  }
}
process.stdout.write(`[tool-views] 悬停 ${JSON.stringify(hoverState)}\n`)
assert('悬停头行时「在轨迹中查看」药丸亮出来', hoverState?.pillOpacity === '1', String(hoverState?.pillOpacity))
assert('同时区间读数淡出（药丸不压在读数上）', hoverState?.chipOpacity === '0', String(hoverState?.chipOpacity))
// 鼠标移开，让照片上是默认状态（读数在、药丸藏）。
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 60, buttons: 0 })
await sleep(300)
await cdp.shot(join(shots, '_tool-views.png'))

// ── 7. 收尾 ──────────────────────────────────────────────────────────────────
teardown([cdp, { stop: () => desktop.stop() }, { stop: () => server.close() }, home])
const tally = counts()
process.stdout.write(`[tool-views] 截图 desktop/shots/_tool-views.png，共 ${String(tally.total)} 条断言\n`)
finish('tool-views')
