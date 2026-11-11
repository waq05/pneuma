/**
 * 「重复调用提醒」的真机探针（守卫那一半的验收；纯逻辑那半边在
 * `scripts/repeat-reminder-test.mjs`）。
 *
 * 现场就是复现那个缺陷的现场：**假端点固定回同一个 `tool_call`**。回合环没有步数上限
 * （`src/packages/session-core/loop.ts:362` 的 `for (;;)`），所以模型一直要工具，这一轮就
 * 一直跑。本探针让它在同一个调用上连跑 9 次、再收尾，验证那条**建议性**提醒：
 *   - 第 3 / 5 / 8 次调用之后的那一跳（第 4 / 6 / 9 次请求）里多一条 user 消息；
 *   - 其余每一步都不多（提醒是偶尔一句，不是每步都有的背景音）；
 *   - **调用没有被否决**：9 次调用执行了 9 次，结果都是真读到的正文；
 *   - 会话日志里出现对应的 `context-injected` 记录，界面上那张注入卡认得出这一类别；
 *   - **重开等于实时**（2026-11-11）：跑完两轮之后先切到另一条会话、再切回来，注入卡的张数
 *     与每张卡的文字（收起行 + 逐条行）必须与实时**逐字一致**。这是「只记这一跳新增的注入」
 *     这条记账口径的直接收益——以前实时 6 张、重放对不上，这一条断言只能躲着。
 *
 * 注入卡的口径（2026-11-11 起）：卡片记的是「这一跳**新增**了哪些注入」，不是「这一跳注入了
 * 什么」。环境快照 16 跳一字未变，所以只有第 1 跳长一张三项的卡（环境快照 / 模式 / 沙箱）；
 * 提醒那 4 跳各长一张只有 `repeat-reminder` 一项的卡。改前是 6 张（环境按轮合并、各带次数）。
 * 第二轮换参数（A, A, B, B, B）：切换参数的那一跳（第 14 次请求）**不该**有提醒（计数清零），
 * 而新参数重新攒到第 3 次（第 16 次请求）又该有——清零不是「一次之后再也不提醒」。
 *
 * 为什么走「真回合 + 数请求体」而不是造 jsonl：这条守卫的证据全在**发给模型的那份消息**里
 * （请求体），造日志造不出它；而数请求体正好把「模型到底看没看见」钉死。
 *
 * 为什么关掉 session-title / memory / self-improve：它们会在回合前后各自发一次模型请求，
 * 把「第几次请求」这个序号打乱——本探针的判据全靠序号（与 `_verify-compaction.mjs` 同一
 * 条纪律：先关掉会抢镜头的插件）。
 *
 * 运行：node desktop/shots/_verify-repeat-reminder.mjs
 * 产物：desktop/shots/_repeat-reminder.png（最后一张注入卡）
 *
 * 前提：`pnpm run build` 与 `pnpm run build:ui`、桌面构建（`desktop/out`）都已跑过——
 * 探针加载的是构建产物，不是 src。
 *
 * @module dsc/desktop/shots/_verify-repeat-reminder
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assert,
  connectCdp,
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
const fakePort = 18990
const debugPort = 9390

/** 提醒文案的默认字典（探针不抄正文，直接读产品里那一份）。 */
const { REPEAT_REMINDER_TEXTS } = await import(new URL('../../lib/core/repeat-reminder.js', import.meta.url).href)

const home = makeHome({
  shots,
  name: '_verify-repeat-reminder-home',
  dirs: ['sessions/demo', 'usage'],
  config: [
    'default:',
    '  provider: fake',
    '  model: fake-repeat',
    'providers:',
    '  fake:',
    '    displayName: 自检假端点',
    `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
    '    apiKeyEnv: DSC_FAKE_KEY',
    '    models:',
    '      - id: fake-repeat',
    '        name: Fake Repeat',
    '        contextWindow: 128000',
    '        maxTokens: 4096',
    '',
  ].join('\n'),
  settings: { defaultPolicy: 'full-access' },
})

// 三个会在回合前后自己发请求的插件：序号一乱，判据就全错（见文件头）。
writeFileSync(
  join(home.dsc, 'plugins.json'),
  JSON.stringify(
    {
      version: 1,
      entries: [
        { file: 'session-title', disabled: true },
        { file: 'memory', disabled: true },
        { file: 'self-improve', disabled: true },
      ],
    },
    null,
    2,
  ),
)

/** 夹具：被读的文件（每次 read 都该读回这几行）。 */
const PROBE_LINES = ['probe-line-1', 'probe-line-2', 'probe-line-3', 'probe-line-4']
writeFileSync(join(home.work, 'probe.txt'), `${PROBE_LINES.join('\n')}\n`)
/** 夹具目录得先把自己「解忽略」（同 `_verify-tool-views.mjs:99-109` 的理由）。 */
writeFileSync(join(home.work, '.gitignore'), '!*\n')

/**
 * 造一条会话：只有 meta 与一句开场白，cwd 指向隔离 HOME 里的 work。
 *
 * 为什么要造：不造的话会话落在「当前查看/新建」那条上，cwd 是宿主进程目录，read 的相对
 * 路径会读到别的文件——探针判据就会跟着环境漂。
 *
 * 为什么直接写在 `sessions/<slug(cwd)>/` 下：`Session.load` 缺省**按会话根目录重算写入
 * 路径**（`core/session.ts:835`：`sessions/<slug(cwd)>/<id>.jsonl`），放在别的目录里打开
 * 之后，后续记录会写去那个重算出来的文件——探针读原文件就会读到「什么都没发生」。
 */
const { slugCwd } = await import(new URL('../../lib/core/session.js', import.meta.url).href)
const sessionDir = join(home.dsc, 'sessions', slugCwd(home.work))
mkdirSync(sessionDir, { recursive: true })
const now = Date.now()
const sessionPath = join(sessionDir, 'repeat-reminder.jsonl')
writeFileSync(
  sessionPath,
  [
    { type: 'meta', id: 'repeat-reminder', cwd: home.work, createdAt: now - 60000 },
    { type: 'user', text: '这条会话是给重复调用提醒造的。', ts: now - 50000 },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n') + '\n',
)

/**
 * 另一条会话：只用来把当前查看的会话「挤出去」。
 *
 * 为什么必须有它：`openSession` 对「已经在看这条会话」是 no-op（`packages/session/index.ts:91`），
 * 直接再打开目标路径什么都不会重放——那样「重开等于实时」就成了空转。切到另一条会话再切回来，
 * 第二下才是一次真正的 `clear()` + `replayHistory()`（目标会话来没来得及收摊时也会走日志重放）。
 * 这条会话自己只有一句开场白，所以切过去之后注入卡应当归零——那也是「真的切走了」的判据。
 */
const otherSessionPath = join(sessionDir, 'repeat-reminder-other.jsonl')
writeFileSync(
  otherSessionPath,
  [
    { type: 'meta', id: 'repeat-reminder-other', cwd: home.work, createdAt: now - 60000 },
    { type: 'user', text: '这条会话只用来切走，不跑回合。', ts: now - 50000 },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n') + '\n',
)

// ── 假端点：按「第几次请求」分派（序号见文件头）──────────────────────────────
/** 每一跳要回什么：前 9 跳同一个调用，第 10 跳收尾；第二轮 A,A,B,B,B，第 16 跳收尾。 */
const SAME_ARGS = { path: 'probe.txt' }
const A_ARGS = { path: 'probe.txt', offset: 1, limit: 1 }
const B_ARGS = { path: 'probe.txt', offset: 2, limit: 1 }
/** 收尾那句的正文（探针按它等回合结束）。 */
const FIRST_DONE = '第一轮收工。'
const SECOND_DONE = '第二轮收工。'

/**
 * 第 index 次（1 起）请求该回什么。
 * @param {number} index
 * @returns {{ call: Record<string, unknown> } | { final: string }}
 */
function responseFor(index) {
  if (index <= 9) return { call: SAME_ARGS }
  if (index === 10) return { final: FIRST_DONE }
  if (index === 11 || index === 12) return { call: A_ARGS }
  if (index === 13 || index === 14 || index === 15) return { call: B_ARGS }
  return { final: SECOND_DONE }
}

/** 每次请求的 messages（判据全靠它；只在探针进程里，不落盘）。 */
const requests = []
let callSeq = 0

const server = createServer((req, res) => {
  void (async () => {
    const url = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-repeat', object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('fake endpoint: 只有 /chat/completions')
      return
    }
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
    requests.push({ index: requests.length + 1, messages })
    const plan = responseFor(requests.length)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finishReason = null) => send({ choices: [{ delta: patch, finish_reason: finishReason }] })
    if ('call' in plan) {
      callSeq += 1
      // 每次调用给**不同的 id**：同一个 id 会被会话按 callId 去重（`session.ts:970`），
      // 历史里就只剩一条工具结果，后面的请求形状会跟着变，判据全废。
      const id = `call_repeat_${String(callSeq)}`
      delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'read', arguments: '' } }] })
      delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(plan.call) } }] })
      delta({}, 'tool_calls')
    } else {
      delta({ content: plan.final })
      delta({}, 'stop')
    }
    send({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 200, completion_tokens: 40 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fake-repeat] ${String(error)}\n`)
    try {
      res.end()
    } catch {}
  })
})
server.listen(fakePort, '127.0.0.1')

const desktop = launchDesktop({ root, home: home.home, dsc: home.dsc, userData: home.userData, debugPort })
const cdp = await connectCdp({ port: debugPort, log: desktop.log })

/** 页面里反复用到的小工具（每次求值重新定义，探针之间不共享状态）。 */
const PAGE_HELPERS = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const textOf = (node) => (node?.textContent ?? '').trim()
  /** 在输入框里打一句话回车（走产品自己那条发送闸）。 */
  const sendText = async (text) => {
    const input = document.querySelector('.composer textarea')
    if (input === null) return 'no textarea'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(150)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
    return ''
  }
  const injectionHeads = () => [...document.querySelectorAll('.entry-injection')]
    .map((card) => textOf(card.querySelector('.entry-injection-head')))
  /**
   * 读全部注入卡：逐张展开，收下收起行与逐条行（来源 / 位置 / 字数 / 预览）。
   *
   * 为什么展开而不是只读收起行：三张提醒卡的正文长度一样（5 次与 8 次只差一个数字），
   * 收起行完全相同；只有逐条行里的预览能证明「重开重放出来的确实是同一批正文」。
   * 为什么全读而不是只读最后一张：重开对账要的是整份卡片清单，一张都不能多、不能少。
   */
  const readInjectionCards = async () => {
    const cards = [...document.querySelectorAll('.entry-injection')]
    const out = []
    for (const card of cards) {
      const head = card.querySelector('.entry-injection-head')
      if (head === null) continue
      if (head.getAttribute('aria-expanded') !== 'true') head.click()
      for (let i = 0; i < 40 && head.getAttribute('aria-expanded') !== 'true'; i += 1) await wait(50)
      await wait(80)
      out.push({
        head: textOf(head),
        parts: card.getAttribute('data-injection-count'),
        rows: [...card.querySelectorAll('.entry-injection-row')].map((row) => ({
          source: textOf(row.querySelector('.entry-injection-source')),
          where: textOf(row.querySelector('.entry-injection-where')),
          chars: textOf(row.querySelector('.entry-injection-chars')),
          preview: textOf(row.querySelector('.entry-injection-preview')),
        })),
      })
    }
    return out
  }`

/** 读会话 jsonl 的全部记录（坏行跳过，与 `Session.load` 同口径）。 */
const readRecords = () => {
  const out = []
  for (const line of readFileSync(sessionPath, 'utf8').split(/\r?\n/)) {
    if (line === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}

/** 等日志里出现某句收尾正文（回合真的结束了，不是盲等）。 */
const waitForFinal = async (marker, timeoutMs) => {
  const result = await pollPage(
    async () => {
      const hit = readRecords().some((record) => record.type === 'assistant' && String(record.text ?? '').includes(marker))
      return { ok: hit }
    },
    { timeoutMs, intervalMs: 200 },
  )
  return result.ok
}

// ── 1. 打开造好的会话，发第一句（第二轮那句在回合收工后再发）────────────────────
const opened = await requireScene(cdp.evaluate, {
  name: '会话打开、输入框可用、第一句已发出',
  timeoutMs: 90000,
  script: `
    ${PAGE_HELPERS}
    for (let i = 0; i < 120; i += 1) {
      if (typeof window.dsc !== 'undefined' && document.querySelector('.composer textarea') !== null) break
      await wait(250)
    }
    if (typeof window.dsc === 'undefined') return { ok: false, why: 'no window.dsc（preload 没起来）' }
    await window.dsc.invoke('openSession', [${JSON.stringify(sessionPath)}])
    await wait(600)
    const failure = await sendText('开始，把这件事办完。')
    if (failure !== '') return { ok: false, why: failure }
    return { ok: true }
  `,
})
if (!opened.ok) {
  teardown([cdp, desktop, home, { stop: () => server.close() }])
  finish('_verify-repeat-reminder')
}

const firstDone = await waitForFinal(FIRST_DONE, 120000)
assert('第一轮真的跑完了（假端点在 9 次调用之后收到收尾请求）', firstDone === true, `日志里没有「${FIRST_DONE}」`)

// ── 2. 第二轮：换参数（A,A,B,B,B），验证计数清零之后能重新攒起来 ────────────────
// 等一拍再发：最后一条 assistant 落库与 turn/end 之间还有收尾记账，这一拍避开
// 「新消息被当成中途插话排队」的时序（排队的活也会被投递，但请求序号会跟着变）。
await sleep(1200)
const secondSent = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const failure = await sendText('再来一轮。')
  return failure
`)
assert('第二轮那句话发出去了', secondSent === '', String(secondSent))
const secondDone = await waitForFinal(SECOND_DONE, 120000)
assert('第二轮真的跑完了', secondDone === true, `日志里没有「${SECOND_DONE}」`)

// 收工之后把界面上的注入卡读一遍（先滚到底：会话流是虚拟列表，视口外的卡不在 DOM 里）。
// 改口径之后（2026-11-11）卡片记的是「这一跳**新增**了哪些注入」，所以不再点开「第四类
// 收进 +1」那种卡——环境卡是 3 项，每张提醒卡只有 1 项。逐张卡都读逐条行：
// 三张提醒卡的收起行一模一样（字数相同），只有预览能证明重放出来的是同一批正文。
const page = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const scroller = document.querySelector('.chat')
  if (scroller !== null) {
    scroller.scrollTop = scroller.scrollHeight
    await wait(600)
  }
  const cards = await readInjectionCards()
  const last = [...document.querySelectorAll('.entry-injection')].at(-1) ?? null
  return {
    cards,
    heads: cards.map((card) => card.head),
    injections: cards.length,
    toolCards: document.querySelectorAll('.tool-card').length,
    lastRows: cards.at(-1)?.rows ?? [],
    lastOpen: last?.querySelector('.entry-injection-head')?.getAttribute('aria-expanded') === 'true',
    // 请求 invariant 失配会折成一条 system 条目；本投影必须可复算（同一份历史 → 同一份请求）。
    systems: [...document.querySelectorAll('.entry-system')].map((row) => textOf(row)),
  }
`)
await cdp.shot(join(shots, '_repeat-reminder.png'))

// ── 2b. 重开等于实时（这次改动的核心收益）──────────────────────────────────────
// 先切到另一条会话把当前视图挤掉，再打开目标：第二下才是真重放（同一条会话再 open 是 no-op）。
// 判据不是「卡片还在」，而是**张数与每张卡的文字（收起行 + 逐条行）逐字一致**——
// 以前实时 6 张、重放 5 张，这一条只能躲着；改完两侧都由同一份「新增了什么」生成。
const reopened = await cdp.evaluate(`
  ${PAGE_HELPERS}
  await window.dsc.invoke('openSession', [${JSON.stringify(otherSessionPath)}])
  for (let i = 0; i < 200; i += 1) {
    if (document.querySelectorAll('.entry-injection').length === 0
      && document.querySelectorAll('.entry-user').length === 1) break
    await wait(100)
  }
  const switched = {
    injections: document.querySelectorAll('.entry-injection').length,
    users: document.querySelectorAll('.entry-user').length,
  }
  await window.dsc.invoke('openSession', [${JSON.stringify(sessionPath)}])
  const want = ${String(page?.cards?.length ?? 0)}
  for (let i = 0; i < 300; i += 1) {
    if (document.querySelectorAll('.entry-injection').length === want
      && document.querySelectorAll('.entry-user').length === 3) break
    await wait(100)
  }
  await wait(400)
  const cards = await readInjectionCards()
  return {
    switched,
    cards,
    injections: cards.length,
    users: document.querySelectorAll('.entry-user').length,
  }
`)

// ── 3. 判 ───────────────────────────────────────────────────────────────────
const records = readRecords()
const contextRecords = records.filter((record) => record.type === 'state' && record.id === 'context-injected')
const withReminder = contextRecords.filter((record) =>
  (record.payload?.parts ?? []).some((part) => part.kind === 'repeat-reminder'))
const toolRecords = records.filter((record) => record.type === 'tool')
const assistantCalls = records.filter((record) => record.type === 'assistant' && Array.isArray(record.toolCalls))

console.log('requests', JSON.stringify(requests.map((item) => item.messages.length)))
console.log('report', JSON.stringify({
  requests: requests.length,
  contextRecords: contextRecords.length,
  withReminder: withReminder.length,
  toolRecords: toolRecords.length,
  assistantCalls: assistantCalls.length,
  injectionCards: page?.injections,
  heads: page?.heads,
  lastRows: page?.lastRows,
  // 重开那半边的读数：切走时归零（证明真的切走了），重开后张数与「逐字一致」的结论。
  replaySwitched: reopened?.switched,
  replayInjectionCards: reopened?.injections,
  replayCardsEqual: JSON.stringify(reopened?.cards) === JSON.stringify(page?.cards),
  replayUsers: reopened?.users,
  toolSample: String(toolRecords[0]?.text ?? '').slice(0, 200),
}))

// ① 请求条数：9 + 1（第一轮收尾）+ 5 + 1（第二轮收尾）。
assert('假端点一共收到 16 次请求（9 次调用 + 收尾，5 次调用 + 收尾）', requests.length === 16, String(requests.length))

/**
 * 一次请求里带了几条 user 消息、其中哪几条是提醒。
 *
 * 口径：user 消息数 = 历史里的人话（第一轮 2 条：造的那句 + 探针发的那句；第二轮起 3 条）
 * + 1（env-facts 每轮补的环境快照）+ 1（这一跳有提醒时）。工具结果是 tool 角色，不算。
 */
const reminderTextsOf = (messages) => messages
  .filter((message) => message.role === 'user')
  .map((message) => String(message.content ?? ''))
  .filter((text) => text.includes('（提醒：'))

/** 期望带提醒的请求序号（1 起）：第一轮 4/6/9，第二轮 16（见文件头）。 */
const WANT_REMINDER = new Map([
  [4, REPEAT_REMINDER_TEXTS.gentle],
  [6, null],
  [9, null],
  [16, null],
])

for (const request of requests) {
  const found = reminderTextsOf(request.messages)
  const wanted = WANT_REMINDER.has(request.index)
  assert(
    `第 ${String(request.index)} 次请求${wanted ? '带' : '不带'}提醒`,
    wanted ? found.length === 1 : found.length === 0,
    `实际 ${String(found.length)} 条：${JSON.stringify(found.map((text) => text.slice(0, 40)))}`,
  )
  const userCount = request.messages.filter((message) => message.role === 'user').length
  // 第一轮（1..10）历史里 2 条人话，第二轮（11..16）3 条；再加环境快照与（可能的）提醒。
  const historyUsers = request.index <= 10 ? 2 : 3
  const expectedUsers = historyUsers + 1 + (wanted ? 1 : 0)
  assert(
    `第 ${String(request.index)} 次请求的 user 消息条数对得上（${String(expectedUsers)}）`,
    userCount === expectedUsers,
    `实际 ${String(userCount)}`,
  )
}

// 提醒的正文要能被模型读懂：第一档温和（不点参数），后两档详细（工具名 + 次数 + 参数）。
const at = (index) => reminderTextsOf(requests.find((item) => item.index === index).messages)[0] ?? ''
assert('第 4 次请求的提醒是第一档（温和，不贴参数）', at(4) === REPEAT_REMINDER_TEXTS.gentle, at(4))
assert('第 6 次请求的提醒说了「连续调用了 5 次」', at(6).includes('连续调用了 5 次') && at(6).includes('read'), at(6))
assert('第 9 次请求的提醒说了「连续调用了 8 次」', at(9).includes('连续调用了 8 次'), at(9))
assert('详细档里贴了这次调用的参数', at(9).includes('probe.txt'), at(9))
assert('提醒是末尾那条（不是拼进用户原话）', requests
  .find((item) => item.index === 9).messages.at(-1).content === at(9))

// ② 其余步没有多：上面逐跳的断言已经钉住；这里再钉一条「9 次调用一共只提醒 3 次」。
assert('第一轮 9 次调用只提醒 3 次（第 4/6/9 跳）',
  requests.filter((item) => item.index <= 9 && reminderTextsOf(item.messages).length === 1).length === 3)

// ③ 调用没有被否决：14 次调用执行了 14 次，每次都真读到了正文。
assert('两轮一共 14 次工具调用都落进了日志', toolRecords.length === 14, String(toolRecords.length))
assert('14 次调用的 assistant 记录对得上', assistantCalls.length === 14, String(assistantCalls.length))
assert('每次调用都有结果（执行次数 = 调用次数，没有被否决）',
  toolRecords.every((record) => typeof record.text === 'string' && record.text.length > 0))
assert('结果里读到了探针文件的正文（工具真的执行了，不是合成结果）',
  toolRecords.every((record) => record.text.includes('probe-line-')),
  JSON.stringify(toolRecords.map((record) => String(record.text).slice(0, 30)).slice(0, 3)))
assert('没有任何一条调用被拒 / 被取消', toolRecords.every((record) => record.error === undefined),
  JSON.stringify(toolRecords.filter((record) => record.error !== undefined).map((record) => record.error)))

// ④ 会话日志与界面：注入卡记的是「这一跳**新增**了什么」，不是「这一跳注入了什么」。
assert('日志里带 repeat-reminder 的注入记录仍是 4 条（第 4/6/9/16 跳各一次）',
  withReminder.length === 4, `实际 ${String(withReminder.length)}（注入记录共 ${String(contextRecords.length)} 条）`)
// 改口径后的形态（2026-11-11）：提醒那一跳的注入记录**只有 repeat-reminder 一项**——环境那一跳
// 也照旧注入，但内容没变就不再记一条。这条替代了旧的「env-facts 排在最前、提醒排在最后」：
// 旧断言钉的是「每跳都把整份清单重新记一遍」这个形态，形态随口径一起作废；强度没降，现在钉的是
// 「那条记录里只有什么」——多记一项就不绿。
assert('提醒那一跳的注入记录只有 repeat-reminder 一项（环境照旧注入，但没变就不记）',
  withReminder.every((record) => {
    const kinds = (record.payload?.parts ?? []).map((part) => part.kind)
    return kinds.length === 1 && kinds[0] === 'repeat-reminder'
  }), JSON.stringify(withReminder.map((record) => (record.payload?.parts ?? []).map((part) => part.kind))))
assert('注入记录一共 5 条：环境那一跳 1 条 + 提醒 4 条（改前是 8 条）',
  contextRecords.length === 5, String(contextRecords.length))
assert('第一条注入记录是环境那一跳的三项（env-facts / mode / sandbox）',
  JSON.stringify((contextRecords[0]?.payload?.parts ?? []).map((part) => part.kind)) === '["env-facts","mode","sandbox"]',
  JSON.stringify((contextRecords[0]?.payload?.parts ?? []).map((part) => part.kind)))
assert('注入记录记了来源与位置',
  withReminder.every((record) => {
    const part = (record.payload?.parts ?? []).find((item) => item.kind === 'repeat-reminder')
    return part.source === 'repeat-reminder' && part.where === 'user-tail' && part.chars > 0 && part.preview.length > 0
  }))
const cards = page?.cards ?? []
// 张数：1 张环境卡（第 1 跳的三项）+ 4 张提醒卡（第 4/6/9/16 跳各一句）。改前是 6 张：
// 环境卡按「这一轮」合并成 2 张（各带次数），提醒 4 张。现在环境只报第一次，第二轮不再长卡。
assert('16 步两轮只落 5 张注入卡（1 张环境 + 4 张提醒；改前是 6 张）',
  page?.injections === 5, String(page?.injections))
assert('第一张卡是环境那一跳的三项（环境快照 / 模式 / 沙箱）',
  cards[0]?.parts === '3'
  && (cards[0]?.rows ?? []).map((row) => row.source).join(',') === 'env-facts,mode,sandbox',
  JSON.stringify({ parts: cards[0]?.parts, sources: (cards[0]?.rows ?? []).map((row) => row.source) }))
assert('其余 4 张都是提醒卡，各自的逐条行只有 repeat-reminder 一项',
  cards.slice(1).every((card) => card.parts === '1'
    && card.rows.length === 1 && card.rows[0]?.source === 'repeat-reminder'),
  JSON.stringify(cards.slice(1).map((card) => [card.parts, card.rows.map((row) => row.source)])))
assert('三张提醒卡的正文各不相同（温和 / 连续 5 次 / 连续 8 次），第四张回到温和版（第二轮重新攒到第 3 次）',
  cards[1]?.rows[0]?.preview === REPEAT_REMINDER_TEXTS.gentle
  && String(cards[2]?.rows[0]?.preview).includes('连续调用了 5 次')
  && String(cards[3]?.rows[0]?.preview).includes('连续调用了 8 次')
  && cards[4]?.rows[0]?.preview === REPEAT_REMINDER_TEXTS.gentle,
  JSON.stringify(cards.slice(1).map((card) => card.rows[0]?.preview)))
assert('没有一张卡还写着「共 N 步」（内容没变就不再上报，重复计数随口径消失）',
  (page?.heads ?? []).every((head) => !head.includes('共 ')), JSON.stringify(page?.heads ?? []))
assert('界面上的注入卡张数与日志里的注入记录条数一致',
  page?.injections === contextRecords.length, `${String(page?.injections)} vs ${String(contextRecords.length)}`)
assert('点开最后一张注入卡（第二轮的提醒那张）', page?.lastOpen === true)
const reminderRow = (page?.lastRows ?? [])[0]
assert('展开后逐条行里认得出 repeat-reminder 这一条', reminderRow?.source === 'repeat-reminder',
  JSON.stringify(page?.lastRows ?? []))
assert('这一条标着「请求末尾」', reminderRow?.where === '请求末尾', String(reminderRow?.where))
assert('这一条有字数与预览（预览里就是提醒正文）',
  reminderRow !== undefined && reminderRow.chars.includes('字') && reminderRow.preview.includes('提醒'),
  JSON.stringify(reminderRow ?? {}))
assert('这一条的预览不是原始 kind 也不是空串',
  reminderRow !== undefined && reminderRow.preview !== '' && reminderRow.preview !== 'repeat-reminder',
  String(reminderRow?.preview))
assert('回合过程画出了工具卡（会话流没空）', (page?.toolCards ?? 0) >= 1, String(page?.toolCards))
// 提醒是投影产物：它必须能由「日志原文 + 同一条投影链」逐字节重建，否则 invariant 会报警。
assert('没有请求 invariant 失配（提醒可复算，不是随机注入）',
  (page?.systems ?? []).every((text) => !text.includes('invariant')),
  JSON.stringify(page?.systems ?? []))

// ⑤ 换参数之后计数清零：第 14 跳是切换之后的第 1 次，不该有提醒；第 16 跳重新攒到 3 次，又该有。
assert('换参数之后的那一跳（第 14 次请求）没有提醒（计数清零）',
  reminderTextsOf(requests.find((item) => item.index === 14).messages).length === 0)
assert('新参数重新连续 3 次之后（第 16 次请求）又有提醒（清零不是永不再提醒）',
  reminderTextsOf(requests.find((item) => item.index === 16).messages).length === 1)

// ⑥ 重开等于实时（这次改动的核心收益）：卡片张数与每张卡的文字（收起行 + 逐条行）逐字一致。
// 这一条以前是躲着的（实时与重放各走各的生成方式，实时 6 张、重放对不上）；改完两侧都从
// 同一份「这一跳新增了什么」生成，才敢钉「逐字一致」——差一个字就不绿。
assert('重开前先真的切走了（另一条会话没有任何注入卡、只有 1 条用户消息）',
  reopened?.switched?.injections === 0 && reopened?.switched?.users === 1,
  JSON.stringify(reopened?.switched))
assert('重开后注入卡张数与实时一致',
  reopened?.injections === page?.injections,
  `重放 ${String(reopened?.injections)} vs 实时 ${String(page?.injections)}`)
assert('重开后每张卡的文字与实时逐字一致（收起行 + 来源 / 位置 / 字数 / 预览）',
  JSON.stringify(reopened?.cards) === JSON.stringify(page?.cards),
  `实时 ${JSON.stringify(page?.cards)?.slice(0, 400)} / 重放 ${JSON.stringify(reopened?.cards)?.slice(0, 400)}`)
assert('重开后历史消息也回来了（3 条用户消息：造的那句 + 两轮发的话）',
  reopened?.users === 3, String(reopened?.users))

server.close()
teardown([cdp, desktop, home])
finish('_verify-repeat-reminder')
