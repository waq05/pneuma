/**
 * opencode Go 会话归因头直测（2026-10-14 报障：HTTP 400 `MissingSessionID`）。
 *
 * 事故形状：把模型切到 opencode 的 Go 端点（`https://opencode.ai/zen/go/v1`）之后，
 * 请求直接被拒——网关按**会话**做路由与 prompt 缓存，客户端没带 `x-opencode-session`
 * 就不给路由。分析稿见 docs/opencode-go-session-header.md。
 *
 * 修法（对齐同类客户端的做法）：会话 id 从 core 铺到协议层，但**只在命中 Go 入口时**
 * 才发头——host 为 opencode.ai 或其子域、path 规范化后正好是 `/zen/go/v1`（不认
 * provider id，那是用户随手起的名字），顺带补一个自标识 user-agent（文档要求
 * 「用自己的名字」，node/undici 缺省不算）；别家端点发出去的头与修前逐字节一样。
 *
 * 断言四层：
 *   1. 门控纯逻辑：host+path 组合的各种变体、会话 id 合法性（非法值只省略这个头，
 *      绝不让一个观测字段把请求弄坏）；非法 baseUrl 一律不发；
 *   2. 真 wire：桩掉 globalThis.fetch 跑真 streamChat，看请求头上到底带了什么
 *      （Go 端点带、deepseek 端点一个字节不多带、没有会话 id 时只留 UA）；
 *   3. 重试稳定：同一逻辑调用重试时头的值不变（会话归因靠的就是「同一个会话同一个 id」）；
 *   4. 内核端到端：真 kernel + Go 端点 + 桩 fetch 跑真回合，断言头里的 id 就是那条
 *      会话的 meta.id，两轮不变。
 *
 * 用法：pnpm run build && node scripts/llm-session-header-test.mjs
 *
 * @module dsc/scripts/llm-session-header-test
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// config 模块在 import 时就固定了 ~/.dsc 路径，临时 HOME 必须先于一切 lib 导入
const home = mkdtempSync(join(tmpdir(), 'dsc-session-header-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })

const {
  APP_USER_AGENT,
  OPENCODE_SESSION_HEADER,
  isOpenCodeGoBaseUrl,
  sessionAttributionHeaders,
  sessionIdHeaderValue,
} = await import('../lib/core/request-attribution.js')
const { streamChat } = await import('../lib/core/llm.js')
const { createKernel } = await import('../lib/host/kernel.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return true
    if (Date.now() > deadline) return false
    await sleep(25)
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

console.log('opencode Go 会话归因头测试：缺 x-opencode-session 就 400')

// ── 1. 门控纯逻辑 ─────────────────────────────────────────────────────────────
console.log('\n[1] 门控：认 host + path 一起判')
{
  check('Go 入口原文', isOpenCodeGoBaseUrl('https://opencode.ai/zen/go/v1'))
  check('尾斜杠照认（配置里两种写法都有人写）', isOpenCodeGoBaseUrl('https://opencode.ai/zen/go/v1/'))
  check('大小写不敏感', isOpenCodeGoBaseUrl('HTTPS://OpenCode.AI/Zen/Go/V1'))
  check('子域也算（www. / api. 之类）', isOpenCodeGoBaseUrl('https://www.opencode.ai/zen/go/v1'))
  check('带端口不影响（hostname 才判）', isOpenCodeGoBaseUrl('https://opencode.ai:443/zen/go/v1'))
  check('普通 Zen（/zen/v1）不算 Go 入口', !isOpenCodeGoBaseUrl('https://opencode.ai/zen/v1'))
  check('别的 host 不算', !isOpenCodeGoBaseUrl('https://api.deepseek.com/v1'))
  check('后缀像但不是一个域不算（opencode.ai.evil.com）', !isOpenCodeGoBaseUrl('https://opencode.ai.evil.com/zen/go/v1'))
  check('前缀像不算（notopencode.ai）', !isOpenCodeGoBaseUrl('https://notopencode.ai/zen/go/v1'))
  check('path 多了尾巴不算（用户把完整 URL 填进 baseUrl 时）', !isOpenCodeGoBaseUrl('https://opencode.ai/zen/go/v1/chat/completions'))
  check('空串 / 认不出的 URL 一律不发', !isOpenCodeGoBaseUrl('') && !isOpenCodeGoBaseUrl('not a url') && !isOpenCodeGoBaseUrl(undefined))
}

console.log('\n[1] 会话 id 的合法性：非法值只省略这个头')
{
  check('uuid 原样过（宿主会话 id 就是这个形状）', sessionIdHeaderValue('7b1e0f1a-2c3d-4e5f-8a9b-0c1d2e3f4a5b') === '7b1e0f1a-2c3d-4e5f-8a9b-0c1d2e3f4a5b')
  check('下划线冒号点也放行（别的来源的 id 不许因此丢头）', sessionIdHeaderValue('sess_a:b.c') === 'sess_a:b.c')
  check('带空格 → 省略', sessionIdHeaderValue('has space') === undefined)
  check('带换行 → 省略（这种值会让 fetch 直接抛，把整次请求弄坏）', sessionIdHeaderValue('a\nb') === undefined)
  check('空 / 缺 → 省略', sessionIdHeaderValue('') === undefined && sessionIdHeaderValue('   ') === undefined && sessionIdHeaderValue(undefined) === undefined)
  check('超长（>128）→ 省略', sessionIdHeaderValue('a'.repeat(129)) === undefined && sessionIdHeaderValue('a'.repeat(128)) === 'a'.repeat(128))
}

console.log('\n[1] 头构造：只认 Go 入口')
{
  const go = sessionAttributionHeaders('https://opencode.ai/zen/go/v1', 'sid-1')
  check('Go + 会话 id：自标识 UA + 会话头', go['user-agent'] === APP_USER_AGENT && go[OPENCODE_SESSION_HEADER] === 'sid-1', JSON.stringify(go))
  check('UA 是自标识的产品名/版本（不是 node/undici）', /^pneuma\/\S+$/.test(APP_USER_AGENT) && !/node|undici/i.test(APP_USER_AGENT), APP_USER_AGENT)
  const noId = sessionAttributionHeaders('https://opencode.ai/zen/go/v1', undefined)
  check('Go 但没有会话 id：只留 UA（网关照旧会报 MissingSessionID，报错原文比编的 id 好查）',
    noId[OPENCODE_SESSION_HEADER] === undefined && noId['user-agent'] === APP_USER_AGENT, JSON.stringify(noId))
  check('非 Go 端点：空表（deepseek / glm 一个字节都看不到）',
    Object.keys(sessionAttributionHeaders('https://api.deepseek.com/v1', 'sid-1')).length === 0)
}

// ── 2. 真 wire：桩掉 fetch 看请求头上到底带了什么 ───────────────────────────────
console.log('\n[2] 真 wire：请求头逐条看')
const realFetch = globalThis.fetch
const sseBody =
  `data: ${JSON.stringify({ choices: [{ delta: { content: '收到' } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n` +
  'data: [DONE]\n\n'
/** 桩 fetch：记下每次请求的 URL 与头，按 failTimes 先失败几次再回 SSE。 */
const captured = []
let failTimes = 0
/** 这条请求是不是会话标题生成那条支线（另一条调用路径，用来证「不光回合带」）。 */
const isTitleCall = (rawBody) => {
  try {
    const messages = JSON.parse(rawBody).messages ?? []
    return messages.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('标题生成器'))
  } catch {
    return false
  }
}
globalThis.fetch = async (url, init) => {
  const headers = init?.headers ?? {}
  captured.push({ url: String(url), headers, title: isTitleCall(init?.body), attempt: captured.length + 1 })
  if (failTimes > 0) {
    failTimes -= 1
    return new Response('{"error":"boom"}', { status: 500 })
  }
  return new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const call = (request) => streamChat(request, { onDelta() {} })
const base = { apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }] }

{
  const go = await call({ ...base, baseUrl: 'https://opencode.ai/zen/go/v1', sessionId: 'sid-wire' })
  check('Go 端点这一轮正常收下（桩端点回了正文）', go.text === '收到', JSON.stringify(go.text))
  const sent = captured.at(-1)
  check('发出的 URL 就是 Go 的 chat/completions', sent.url === 'https://opencode.ai/zen/go/v1/chat/completions', sent.url)
  check('请求头带上 x-opencode-session，值就是传下来的会话 id', sent.headers[OPENCODE_SESSION_HEADER] === 'sid-wire', JSON.stringify(sent.headers))
  check('同时带上自标识 user-agent', sent.headers['user-agent'] === APP_USER_AGENT, String(sent.headers['user-agent']))
  check('保留原有的 content-type / authorization（没挤掉谁）', sent.headers['content-type'] === 'application/json' && sent.headers.authorization === 'Bearer k')
  let validHeader = true
  try {
    new Headers(sent.headers)
  } catch (error) {
    validHeader = false
    console.log(`        （头不合法：${String(error)}）`)
  }
  check('整份头对 HTTP 合法（非法值不会把请求弄坏）', validHeader)

  const goNoId = await call({ ...base, baseUrl: 'https://opencode.ai/zen/go/v1' })
  check('Go 端点没给会话 id：不发那个头，但留着 UA', goNoId.text === '收到' && captured.at(-1).headers[OPENCODE_SESSION_HEADER] === undefined && captured.at(-1).headers['user-agent'] === APP_USER_AGENT, JSON.stringify(captured.at(-1).headers))

  // 反证：普通端点一个字节都不多带（这是「不能无条件加头」那条教训的守门员）
  await call({ ...base, baseUrl: 'https://api.deepseek.com/v1', sessionId: 'sid-wire' })
  const plain = captured.at(-1)
  const keys = Object.keys(plain.headers).map((key) => key.toLowerCase()).sort()
  check('deepseek 端点：头仍只有 content-type + authorization 两个', keys.join(',') === 'authorization,content-type', keys.join(','))
  check('deepseek 端点：没有 user-agent（没被顺带改掉，undici 缺省照旧）', plain.headers['user-agent'] === undefined)

  // 形态变体也要命中：大小写 + 尾斜杠（配置里怎么写都得发）
  await call({ ...base, baseUrl: 'https://OpenCode.AI/zen/go/v1/', sessionId: 'sid-wire' })
  check('配置写成大写 + 尾斜杠照样命中门控', captured.at(-1).headers[OPENCODE_SESSION_HEADER] === 'sid-wire', JSON.stringify(captured.at(-1).headers))
}

// ── 3. 重试：同一逻辑调用的头必须稳定 ─────────────────────────────────────────
console.log('\n[3] 重试：头的值不随物理请求变')
{
  failTimes = 1
  const before = captured.length
  const result = await call({ ...base, baseUrl: 'https://opencode.ai/zen/go/v1', sessionId: 'sid-stable' })
  const attempts = captured.slice(before)
  check('5xx 之后重试了一次（两次物理请求）', attempts.length === 2, JSON.stringify(attempts.map((a) => a.attempt)))
  check('重试后这一轮照样收下', result.text === '收到')
  check('两次物理请求带的会话 id 完全一致（网关按它做路由，变一次就等于换了会话）',
    attempts.every((a) => a.headers[OPENCODE_SESSION_HEADER] === 'sid-stable'), JSON.stringify(attempts.map((a) => a.headers[OPENCODE_SESSION_HEADER])))
}

// ── 4. 内核端到端：真回合 → 头里的 id 就是那条会话 ─────────────────────────────
console.log('\n[4] 内核端到端：真回合发出去的头')
{
  const ctx = await createKernel({
    config: {
      providers: {
        go: {
          name: 'go',
          displayName: 'Go',
          baseUrl: 'https://opencode.ai/zen/go/v1',
          apiKey: 'k',
          models: [{ id: 'm', name: 'm', contextWindow: 100000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }],
        },
      },
      defaultProvider: 'go',
      defaultModel: 'm',
    },
    resumeSessionPath: null,
  })

  const sid = ctx.session.current().meta.id
  check('宿主会话 id 是 uuid（能直接当头的值）', UUID.test(sid), sid)

  const before = captured.length
  const ended = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', (reason, signal) => {
      if (signal.sessionId === sid) {
        off()
        resolve(reason)
      }
    })
  })
  ctx.agent.followup('打个招呼')
  check('回合正常收尾（带了会话头也没把请求发坏）', (await ended) === 'completed')
  await sleep(150)

  const round1 = captured.slice(before)
  const titles1 = round1.filter((r) => r.title)
  check(
    `这一轮确实发了请求（端点被真的走了一遍，共 ${round1.length} 次，其中标题支线 ${titles1.length} 次）`,
    round1.length >= 1,
  )
  check('标题支线（不走回合、直接调 llm 服务的那条路）也带同一个 id',
    titles1.length === 0 || titles1.every((r) => r.headers[OPENCODE_SESSION_HEADER] === sid),
    JSON.stringify(titles1.map((r) => r.headers[OPENCODE_SESSION_HEADER])))
  check('每个请求都带 x-opencode-session，值就是这条会话的 id',
    round1.every((r) => r.headers[OPENCODE_SESSION_HEADER] === sid),
    JSON.stringify(round1.map((r) => r.headers[OPENCODE_SESSION_HEADER])))
  check('每个请求都带自标识 UA', round1.every((r) => r.headers['user-agent'] === APP_USER_AGENT))
  check('打的都是 Go 的 chat/completions', round1.every((r) => r.url === 'https://opencode.ai/zen/go/v1/chat/completions'))

  // 第二轮：同一个会话必须是同一个 id（稳定性是这条路线的全部价值）
  const before2 = captured.length
  const ended2 = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', (reason, signal) => {
      if (signal.sessionId === sid) {
        off()
        resolve(reason)
      }
    })
  })
  ctx.agent.followup('再问一句')
  check('第二轮也正常收尾', (await ended2) === 'completed')
  await sleep(150)
  const round2 = captured.slice(before2)
  check('第二轮照样带同一个会话 id', round2.length >= 1 && round2.every((r) => r.headers[OPENCODE_SESSION_HEADER] === sid),
    JSON.stringify(round2.map((r) => r.headers[OPENCODE_SESSION_HEADER])))

  ctx.emit('dsc/exit')
}

// ── 5. 铺线不漂：四个调用方 + 派发口兜底都带上会话 id ──────────────────────────
// [4] 只走得到回合这一条路。压缩、标题、审批、以及「调用方没填」时的兜底是源码事实，
// 这里按当下写法钉住——它们是这次修复的另一半（会话 id 没铺下来，门控再对也没用）。
console.log('\n[5] 铺线：会话 id 从哪来')
{
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const llmCore = read('src/core/llm.ts')
  const llmPlugin = read('src/plugins/llm.ts')
  const loop = read('src/core/loop.ts')
  const compact = read('src/core/compact.ts')
  const title = read('src/plugins/session-title.ts')
  const approval = read('src/plugins/approval.ts')

  check('协议层：发请求前按端点补归因头', llmCore.includes('sessionAttributionHeaders(request.baseUrl, request.sessionId)'))
  check('协议层：全文件只有这一处补头（没有第二条「无条件加」的路）', (llmCore.match(/sessionAttributionHeaders\(/g) ?? []).length === 1)
  check('派发口兜底：调用方没填就用当前会话', llmPlugin.includes('sessionId: request.sessionId ?? currentSessionId(ctx)'))
  check('派发口兜底读不到会话时不炸（拿不到就省略这个头）',
    /function currentSessionId\(ctx: Context\)[\s\S]{0,160}?catch\s*\{[\s\S]{0,80}?return undefined/.test(llmPlugin))
  check('回合：用**这个 agent 自己的**会话（后台会话也在跑，不是「当前查看的会话」）', loop.includes('sessionId: this.session.meta.id'))
  check('压缩：算在被压的那条会话头上', compact.includes('sessionId: session.meta.id'))
  check('标题：算在被起名的那条会话头上', /model: route\.model,[\s\S]{0,200}?sessionId: id,/.test(title))
  check('审批：算在发起调用的那条会话头上', approval.includes('sessionId: request.sessionId'))
}

// 桩拆掉，别影响同一进程里后面的东西
globalThis.fetch = realFetch

console.log('')
if (failures === 0) {
  console.log('opencode Go 会话归因头电池：全部通过')
} else {
  console.log(`opencode Go 会话归因头电池：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
}
process.exit(failures === 0 ? 0 : 1)
