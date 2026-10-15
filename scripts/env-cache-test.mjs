/**
 * WS3 上下文新鲜度与缓存自检（env 快照「变了才发」+ 显式 cache 能力位 + 指令预算口径）。
 *
 * 三件事各自的证据：
 *   (a) env-facts 投影：**缺省每轮都发**（`envRefreshMs` 缺省 0）——「平台：Windows
 *       （bash 工具跑的是 PowerShell）」只有这一个载体，跳过一轮就等于那一轮模型没有
 *       平台事实。闸门本身（设一个非 0 毫秒数 = 「变了才发」，照 dsh time-context 的
 *       刷新下限）单独用显式 `envRefreshMs=600000` 测：首次必发、文本变了必发、没变
 *       又没到下限就不发。落盘状态条目（noteEnvFacts 的 hash 去重）行为不变。
 *   (b) 显式前缀缓存：能力位缺省 false——当前唯一的 DeepSeek 系路由**请求体逐字节不变**；
 *       只有端点声明 `cacheControl: true` 时才打 `cache_control` 断点（头部 system + 末尾各一）。
 *   (c) 指令预算口径是**字符**不是字节：恰好 20000 字符不截断、20001 截断；20000 个
 *       中文字符（60000 字节）也不截断——若口径是字节它必被砍。
 *
 * 隔离：临时 HOME + 假 SSE 端点驱动真回合，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm run build && node scripts/env-cache-test.mjs
 *
 * @module dsc/scripts/env-cache-test
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-env-cache-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 关掉会在回合里额外投递/起请求的插件：本探针要数的是「一轮两步」的请求体，别被抢镜头。
writeFileSync(
  join(home, '.dsc', 'plugins.json'),
  JSON.stringify({
    version: 1,
    entries: [
      { file: 'session-title', disabled: true },
      { file: 'memory', disabled: true },
      { file: 'self-improve', disabled: true },
    ],
  }, null, 2),
  'utf8',
)

let failures = 0
const checks = []
const check = (label, condition, extra = '') => {
  checks.push(Boolean(condition))
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(20)
  }
}

// ── 假 SSE 端点：记录每个请求体（raw + 解析），按形状分派 ───────────────────────
const sseText = (text) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n` +
  'data: [DONE]\n\n'
const sseToolCall = (id, name, args) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n` +
  'data: [DONE]\n\n'

const bodies = []
async function serve() {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let payload = {}
      try {
        payload = JSON.parse(raw)
      } catch {
        payload = {}
      }
      bodies.push({ raw, payload })
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const hasToolResult = messages.some((m) => m.role === 'tool')
      const realUser = [...messages]
        .reverse()
        .find((m) => m.role === 'user' && !(typeof m.content === 'string' && m.content.includes('不是用户发言')))
      const lastText =
        typeof realUser?.content === 'string'
          ? realUser.content
          : Array.isArray(realUser?.content)
            ? realUser.content.filter((p) => p.type === 'text').map((p) => p.text).join('')
            : ''
      const reply =
        !hasToolResult && lastText.includes('开跑') ? sseToolCall('c1', 'noop', '{}') : sseText('收到')
      res.end(reply)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const site = await serve()
const { createKernel } = await import('../lib/host/kernel.js')
const { serializeMessages, applyExplicitCache } = await import('../lib/core/llm.js')
const { buildSystemPrompt, DEFAULT_INSTRUCTION_BUDGET } = await import('../lib/core/prompt.js')

const model = {
  id: 'm',
  name: 'm',
  contextWindow: 100000,
  maxTokens: 500,
  modalities: ['text'],
  thinkingLevels: [],
  thinkingParam: 'none',
  effortMap: {},
}
const ctx = await createKernel({
  config: {
    providers: {
      // 默认路由：不声明显式缓存（当前唯一的 DeepSeek 形状）
      test: { name: 'test', displayName: 'Test', baseUrl: site.baseUrl, apiKey: 'k', models: [model] },
      // 声明支持显式缓存的端点（Anthropic 形状），用来验证「只有声明了才打点」
      cached: { name: 'cached', displayName: 'Cached', baseUrl: site.baseUrl, apiKey: 'k', cacheControl: true, models: [model] },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

/** 快照判定：正文里带「环境事实」的那条 user 消息。 */
const isEnvSnapshot = (message) =>
  message?.role === 'user' &&
  (typeof message.content === 'string' ? message.content : '').includes('环境事实')
const envCount = (messages) => messages.filter(isEnvSnapshot).length
/** 一棵树里有几处 cache_control（深扫，用来钉「几处断点」）。 */
function countCacheControl(node) {
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countCacheControl(item), 0)
  if (node !== null && typeof node === 'object') {
    let sum = 0
    for (const [key, value] of Object.entries(node)) {
      if (key === 'cache_control') sum += 1
      else sum += countCacheControl(value)
    }
    return sum
  }
  return 0
}

// ── 假时钟：只用来推「刷新下限」这一条，用完立刻还原 ────────────────────────────
const realNow = Date.now.bind(Date)
let skew = 0
Date.now = () => realNow() + skew
const withClock = (offsetMs, fn) => {
  skew = offsetMs
  try {
    return fn()
  } finally {
    skew = 0
  }
}

// ══ (a) 端到端：一轮两步，抓两个请求体 ══════════════════════════════════════════
console.log('[a] 真回合（一步工具调用 + 一步收尾）里 env 快照缺省每轮都发')
ctx.tools.register({
  name: 'noop',
  description: '探针空工具',
  parameters: { type: 'object', properties: {} },
  risk: 'read',
  run: async () => 'ok',
})
const e2eSessionFile = ctx.session.current().filePath
{
  const ended = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', () => {
      off()
      resolve()
    })
  })
  ctx.agent.followup('开跑')
  await ended
  await until(() => !ctx.agent.isRunning)
  await sleep(120)
}
const step1 = bodies.find((b) => {
  const messages = b.payload.messages ?? []
  return !messages.some((m) => m.role === 'tool')
})
const step2 = bodies.find((b) => (b.payload.messages ?? []).some((m) => m.role === 'tool'))
check('真回合共抓到两步请求', step1 !== undefined && step2 !== undefined, JSON.stringify(bodies.map((b) => (b.payload.messages ?? []).length)))
check(
  '第一步请求带当前环境快照（首次必发）',
  envCount(step1?.payload.messages ?? []) === 1,
  `env=${envCount(step1?.payload.messages ?? [])}`,
)
check(
  '默认配置下第二步请求仍带一条环境快照（缺省 = 每轮都发）',
  envCount(step2?.payload.messages ?? []) === 1,
  `env=${envCount(step2?.payload.messages ?? [])}`,
)

// 落盘状态条目：noteEnvFacts 的 hash 去重行为不变（两步只留一条）
const stateLines = readFileSync(e2eSessionFile, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))
  .filter((record) => record.type === 'state' && record.id === 'env-facts')
check('env-facts 落盘状态条目只有一条（行为不变）', stateLines.length === 1, `lines=${stateLines.length}`)
check(
  '落盘的快照文本 = 第一步发给模型的那条（Model-visible ⟺ logged）',
  stateLines[0]?.payload?.text ===
    (step1?.payload.messages ?? []).find(isEnvSnapshot)?.content,
  '状态条目与请求体不一致',
)

// ══ (b) DeepSeek 请求体零漂移 ═════════════════════════════════════════════════
console.log('[b] DeepSeek 系路由（未声明能力）：请求体逐字节不变')
check('两步请求体全文都没有 cache_control', !step1?.raw.includes('cache_control') && !step2?.raw.includes('cache_control'))
check(
  '顶层字段名与顺序未变（model,messages,stream,stream_options,tools,max_tokens）',
  JSON.stringify(Object.keys(step1?.payload ?? {})) ===
    JSON.stringify(['model', 'messages', 'stream', 'stream_options', 'tools', 'max_tokens']),
  JSON.stringify(Object.keys(step1?.payload ?? {})),
)
check(
  '线上 message 逐条只含协议字段（ts 已剥掉）',
  (step1?.payload.messages ?? []).every((m) => Object.keys(m).every((k) => ['role', 'content', 'reasoning_content', 'tool_calls', 'tool_call_id'].includes(k))),
  JSON.stringify((step1?.payload.messages ?? []).map((m) => Object.keys(m))),
)

const driftMsgs = [
  { role: 'system', content: 'SYS', ts: 111 },
  { role: 'user', content: 'hi' },
  {
    role: 'assistant',
    content: '',
    reasoning_content: 'think',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
    ts: 222,
  },
  { role: 'tool', content: 'ok', tool_call_id: 'c1' },
  { role: 'user', content: [{ type: 'text', text: 'look' }] },
  { role: 'assistant', content: 'done', reasoning_content: '', ts: 333 },
]
const golden = JSON.stringify(serializeMessages(driftMsgs))
check('serializeMessages 输出不含 cache_control、不含 ts', !golden.includes('cache_control') && !golden.includes('"ts"'))
check(
  'assistant 的字段挑选未变（tool_calls 留、空 reasoning_content 丢）',
  golden.includes('"tool_calls"') && golden.match(/reasoning_content/g)?.length === 1,
  golden,
)
const wireWith = (capability) =>
  JSON.stringify(capability === true ? applyExplicitCache(serializeMessages(driftMsgs)) : serializeMessages(driftMsgs))
check(
  '能力位为 false / undefined / 不传：三种情形逐字节相同',
  wireWith(false) === golden && wireWith(undefined) === golden && golden === wireWith(false),
  '能力位不该影响未声明路由的请求体',
)

// ══ (b) 声明支持时才打点 ═══════════════════════════════════════════════════════
console.log('[b] 端点声明支持时：打两处 ephemeral 断点')
const marked = applyExplicitCache(serializeMessages(driftMsgs))
check('恰好两处 cache_control（头部 system + 对话末尾）', countCacheControl(marked) === 2, `count=${countCacheControl(marked)}`)
check(
  '断点形状是 {type:"ephemeral"}',
  marked[0]?.content?.[0]?.cache_control?.type === 'ephemeral' &&
    marked[5]?.content?.[0]?.cache_control?.type === 'ephemeral',
  JSON.stringify(marked[0]?.content),
)
check(
  '不打点的消息与打点前逐条逐字节相同',
  marked.slice(1, 5).every((m, i) => JSON.stringify(m) === JSON.stringify(serializeMessages(driftMsgs)[i + 1])),
  '只有打点那两条变了',
)
check('空数组安全（原样返回）', applyExplicitCache([]).length === 0)
check(
  '路由能力位：默认端点不带、声明端点带',
  ctx.llm.routeTo('test', 'm', 'default').cacheControl === undefined &&
    ctx.llm.routeTo('cached', 'm', 'default').cacheControl === true,
  JSON.stringify([ctx.llm.routeTo('test', 'm', 'default').cacheControl, ctx.llm.routeTo('cached', 'm', 'default').cacheControl]),
)
// 端到端：带能力位发一条真请求，线上确实出现断点
{
  const route = ctx.llm.routeTo('cached', 'm', 'default')
  await ctx.llm.stream(
    route.api,
    {
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      model: route.model,
      messages: [{ role: 'system', content: 'SYS-DIRECT' }, { role: 'user', content: 'hi' }],
      cacheControl: true,
    },
    { onDelta() {} },
  )
  const direct = bodies.find((b) => b.raw.includes('SYS-DIRECT'))
  check(
    '带能力位的真请求线上有 2 处断点，且落点正确',
    countCacheControl(direct?.payload) === 2 &&
      direct?.payload?.messages?.[0]?.content?.[0]?.cache_control?.type === 'ephemeral' &&
      direct?.payload?.messages?.[1]?.content?.[0]?.cache_control?.type === 'ephemeral',
    JSON.stringify(direct?.payload?.messages),
  )
}

// ══ (a) 投影级：闸门机制本身（显式 envRefreshMs=600000 打开它）══════════════════
console.log('[a] 投影级：显式 envRefreshMs=600000 打开的闸门（首次必发 / 变化必发 / 未变且未到下限不发）')
// 缺省是 0 = 每轮都发（平台事实的唯一载体，见 plugins/prompt.ts）；这里显式打开闸门，
// 单独测「变了才发」的机制。改 plugins.json 现读生效。
const setEnvRefresh = (ms) =>
  writeFileSync(
    join(home, '.dsc', 'plugins.json'),
    JSON.stringify({
      version: 1,
      entries: [
        { file: 'session-title', disabled: true },
        { file: 'memory', disabled: true },
        { file: 'self-improve', disabled: true },
        ...(ms === null ? [] : [{ file: 'prompt', config: { envRefreshMs: ms } }]),
      ],
    }, null, 2),
    'utf8',
  )
setEnvRefresh(600_000)
const dirA = join(home, 'wa')
const dirB = join(home, 'wb')
mkdirSync(dirA, { recursive: true })
mkdirSync(dirB, { recursive: true })
let envStateCalls = 0
const fakeSession = (id, cwd) => ({
  meta: { id, cwd },
  state: () => undefined,
  appendState: () => {
    envStateCalls += 1
  },
})
const fn = (messages, session) => ctx.prompt.rewrite(messages, session)
const seed = [{ role: 'system', content: 'SYS' }, { role: 'user', content: '你好' }]
const sessionA = fakeSession('probe-a', dirA)
const sessionB = fakeSession('probe-b', dirB)

const firstA = fn(seed, sessionA)
check(
  '新会话第一次：尾部追加一条环境快照，正文含本会话的 cwd',
  envCount(firstA) === 1 && firstA[firstA.length - 1].content.includes(dirA),
  JSON.stringify(firstA.map((m) => m.content).slice(-1)),
)
check('快照是 user 角色、且排在消息末尾', firstA[firstA.length - 1].role === 'user')
const secondA = fn(seed, sessionA)
check('同一会话再来一次（文本没变、未到下限）：不追加', envCount(secondA) === 0, `env=${envCount(secondA)}`)
const firstB = fn(seed, sessionB)
check('另一个会话（不同 cwd）：各自首次必发，快照含自己的 cwd', envCount(firstB) === 1 && firstB[firstB.length - 1].content.includes(dirB))

sessionA.meta.cwd = dirB // 同一个会话换目录 = 环境变了
const changedA = fn(seed, sessionA)
check('文本变了必发（换目录后同一会话再发一条）', envCount(changedA) === 1, `env=${envCount(changedA)}`)
const withinA = withClock(100_000, () => fn(seed, sessionA))
check('没到刷新下限（+100 秒）：文本没变就不发', envCount(withinA) === 0, `env=${envCount(withinA)}`)
const afterA = withClock(700_000, () => fn(seed, sessionA))
check('到了刷新下限（+700 秒）：文本没变也重注一条', envCount(afterA) === 1, `env=${envCount(afterA)}`)
check('落盘状态条目每次发出都调用（去重交给 noteEnvFacts）', envStateCalls >= 4, `calls=${envStateCalls}`)

// 缺省（不配 envRefreshMs）= 0 = 每轮都发：这是**默认行为**，必须钉死
// （平台「Windows→PowerShell」只有快照这一个载体，见 plugins/prompt.ts 的注释）。
// 用一个全新会话，避免上面假时钟把「上次发出时刻」推到未来污染读数。
setEnvRefresh(null)
const sessionDefault = fakeSession('probe-default', dirA)
const defA = fn(seed, sessionDefault)
const defA2 = fn(seed, sessionDefault)
check(
  '缺省每轮都发：不配 envRefreshMs 时，文本没变的第二轮仍带环境快照',
  envCount(defA) === 1 && envCount(defA2) === 1,
  `env=${envCount(defA)}/${envCount(defA2)}`,
)

// ══ (c) 指令预算口径：字符，不是字节 ═══════════════════════════════════════════
console.log('[c] 指令预算口径：以字符计')
check('缺省值仍是 20000（字符），未因改口径砍半', DEFAULT_INSTRUCTION_BUDGET === 20_000, String(DEFAULT_INSTRUCTION_BUDGET))
const dirExact = join(home, 'budget-exact')
const dirOver = join(home, 'budget-over')
const dirCjk = join(home, 'budget-cjk')
for (const dir of [dirExact, dirOver, dirCjk]) mkdirSync(dir, { recursive: true })
writeFileSync(join(dirExact, 'AGENTS.md'), 'a'.repeat(20_000), 'utf8')
writeFileSync(join(dirOver, 'AGENTS.md'), 'a'.repeat(20_001), 'utf8')
const cjkBody = '中'.repeat(20_000)
writeFileSync(join(dirCjk, 'AGENTS.md'), cjkBody, 'utf8')
const sysExact = buildSystemPrompt(dirExact, { instructionBudget: 20_000, skills: '' })
const sysOver = buildSystemPrompt(dirOver, { instructionBudget: 20_000, skills: '' })
const sysCjk = buildSystemPrompt(dirCjk, { instructionBudget: 20_000, skills: '' })
check('恰好 20000 字符的指令文件不截断', sysExact.includes('AGENTS.md') && !sysExact.includes('过长，中间省略'))
check('20001 字符被截断（阈值按字符数算）', sysOver.includes('过长，中间省略'))
check(
  '20000 个中文字符（60000 字节）不截断——口径是字符不是字节',
  !sysCjk.includes('过长，中间省略'),
  '若按字节算，60000 字节必然超 20000 预算',
)
check('换算自洽：20000 中文字符 = 60000 字节', Buffer.byteLength(cjkBody, 'utf8') === 60_000)

await site.close()
console.log('')
console.log(`共 ${checks.length} 条断言，失败 ${failures} 条`)
process.exit(failures === 0 ? 0 : 1)
