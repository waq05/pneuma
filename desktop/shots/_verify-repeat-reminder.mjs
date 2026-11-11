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
 *   - 会话日志里出现对应的 `context-injected` 记录，界面上那张注入卡认得出这一类别。
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
    .map((card) => textOf(card.querySelector('.entry-injection-head')))`

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
// 提醒那一张会多出第四类，收起行只列前三类、第四类收进 `+1`——所以要点开它，逐条行里才
// 看得见 `repeat-reminder` 那一条（来源 / 位置 / 字数 / 预览）。
const page = await cdp.evaluate(`
  ${PAGE_HELPERS}
  const scroller = document.querySelector('.chat')
  if (scroller !== null) {
    scroller.scrollTop = scroller.scrollHeight
    await wait(600)
  }
  const cards = [...document.querySelectorAll('.entry-injection')]
  /** 点开一张卡的行头，等它展开。 */
  const openCard = async (card) => {
    const head = card.querySelector('.entry-injection-head')
    if (head === null) return false
    if (head.getAttribute('aria-expanded') !== 'true') head.click()
    for (let i = 0; i < 40 && head.getAttribute('aria-expanded') !== 'true'; i += 1) await wait(50)
    await wait(150)
    return head.getAttribute('aria-expanded') === 'true'
  }
  /** 最后一张卡（第二轮的提醒那一张）与它的逐条行。 */
  const last = cards[cards.length - 1] ?? null
  const lastOpen = last === null ? false : await openCard(last)
  const rows = last === null ? [] : [...last.querySelectorAll('.entry-injection-row')].map((row) => ({
    source: textOf(row.querySelector('.entry-injection-source')),
    where: textOf(row.querySelector('.entry-injection-where')),
    chars: textOf(row.querySelector('.entry-injection-chars')),
    preview: textOf(row.querySelector('.entry-injection-preview')),
  }))
  return {
    heads: injectionHeads(),
    injections: cards.length,
    toolCards: document.querySelectorAll('.tool-card').length,
    lastOpen,
    lastRows: rows,
    // 请求 invariant 失配会折成一条 system 条目；本投影必须可复算（同一份历史 → 同一份请求）。
    systems: [...document.querySelectorAll('.entry-system')].map((row) => textOf(row)),
  }
`)
await cdp.shot(join(shots, '_repeat-reminder.png'))

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
  lastRows: page?.lastRows,
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

// ④ 会话日志里有对应的注入记录，且界面认得出这一类别。
assert('日志里出现带 repeat-reminder 的 context-injected 记录（4 条：第 4/6/9/16 跳）',
  withReminder.length === 4, `实际 ${String(withReminder.length)}（注入记录共 ${String(contextRecords.length)} 条）`)
assert('注入记录里 repeat-reminder 排在最后（env-facts 先报，提醒是这一轮最后追加的话）',
  withReminder.every((record) => {
    const kinds = (record.payload?.parts ?? []).map((part) => part.kind)
    return kinds[0] === 'env-facts' && kinds[kinds.length - 1] === 'repeat-reminder'
  }), JSON.stringify(withReminder.map((record) => (record.payload?.parts ?? []).map((part) => part.kind))))
assert('注入记录记了来源与位置',
  withReminder.every((record) => {
    const part = (record.payload?.parts ?? []).find((item) => item.kind === 'repeat-reminder')
    return part.source === 'repeat-reminder' && part.where === 'user-tail' && part.chars > 0 && part.preview.length > 0
  }))
// 提醒那张卡有 4 类（环境快照 / 模式 / 沙箱 / 重复调用提醒），收起行只列前三类，第四类收进 `+1`。
assert('界面上有把第四类收进「+1」的注入卡（这一轮多了一类）',
  (page?.heads ?? []).some((head) => head.includes('+1')), JSON.stringify(page?.heads ?? []))
assert('点开最后一张注入卡（第二轮的提醒那张）', page?.lastOpen === true)
const reminderRow = (page?.lastRows ?? []).find((row) => row.source === 'repeat-reminder')
assert('展开后逐条行里认得出 repeat-reminder 这一条', reminderRow !== undefined,
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

server.close()
teardown([cdp, desktop, home])
finish('_verify-repeat-reminder')
