/**
 * 运行时请求 invariant 电池：纯函数单元 + 真内核端到端。
 *
 * 被测：`src/core/request-invariant.ts` 的 `checkReconstructable` 与 `loop.ts` 里的接线
 * （组装完 messages、`deps.stream` 之前校验一次；不一致经 `dsc/notice` 报出、按会话去重、
 * **不阻断请求**）。对应 dsh 的 agent-loop invariant（请求 messages == session.deriveMessages()
 * 逐字节相等，不符即 fail），dsc 的取舍是只报不杀。
 *
 * 断言两层：
 *   ① 纯函数：健康 ok；中段内容/role/长度差被认出且定位准；尾部运行时注入段按结构放宽
 *      （易变 env 文本不误报）；就地改输入被抓；奇怪 content 不抛；不改入参；digest 稳定。
 *   ② 真内核 + 假 SSE：健康回合零误报；坏投影（非纯 / 就地改输入 / 组装与发送之间插一条）
 *      各报一次 notice；同一形状连跑两轮只报一次；校验失败时请求仍照发（断言 stream 被调用）。
 *
 * 隔离：临时 HOME + 假模型端点，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm build && node scripts/request-invariant-test.mjs
 *
 * @module dsc/scripts/request-invariant-test
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-invariant-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 关掉长期记忆：它会在回合结束时投机器通知，与这里要观察的 notice 抢镜头。
writeFileSync(
  join(home, '.dsc', 'plugins.json'),
  JSON.stringify({ version: 1, entries: [{ file: 'memory', config: { enabled: false } }] }, null, 2),
  'utf8',
)

let failures = 0
const check = (label, condition, extra = '') => {
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
const msg = (role, content, extra = {}) => ({ role, content, ...extra })

// ── ① 纯函数 ────────────────────────────────────────────────────────────────────
const { checkReconstructable, snapshotMessages, firstMutatedIndex } = await import('../lib/core/request-invariant.js')

console.log('[1] 纯函数：健康 / 各种失配 / 放宽 / 就地改')
{
  const sent = [msg('system', 'S'), msg('user', 'hi'), msg('assistant', 'yo')]
  const derived = sent.map((m) => ({ ...m }))
  const r = checkReconstructable(sent, derived)
  check('健康：ok:true', r.ok === true, JSON.stringify(r))
  check('健康：不带 reason/digest', r.reason === undefined && r.digest === undefined, JSON.stringify(r))
}
{
  const sent = [msg('system', 'S'), msg('user', 'a'), msg('user', 'b')]
  const derived = [msg('system', 'S'), msg('user', 'a'), msg('user', 'B')]
  const r = checkReconstructable(sent, derived)
  check('中段内容不一致：ok:false', r.ok === false, JSON.stringify(r))
  check('中段内容不一致：firstDiffIndex=2', r.firstDiffIndex === 2, JSON.stringify(r))
  check(
    '中段内容不一致：reason 带「第 3 条」与 role',
    (r.reason ?? '').includes('第 3 条') && (r.reason ?? '').includes('user'),
    r.reason,
  )
}
{
  const sent = [msg('system', 'S'), msg('user', 'a'), msg('assistant', 'b')]
  const derived = [msg('system', 'S'), msg('user', 'a')]
  const r = checkReconstructable(sent, derived)
  check('长度差：ok:false 且 reason 带差 +1', r.ok === false && (r.reason ?? '').includes('差 +1'), r.reason)
  check('长度差：firstDiffIndex=2', r.firstDiffIndex === 2, JSON.stringify(r))
}
{
  const sent = [msg('system', 'S'), msg('assistant', 'x')]
  const derived = [msg('system', 'S'), msg('tool', 'x', { tool_call_id: 't' })]
  const r = checkReconstructable(sent, derived)
  check(
    'role 不一致被认出（两侧 role 都进 reason）',
    r.ok === false && (r.reason ?? '').includes('assistant') && (r.reason ?? '').includes('tool'),
    r.reason,
  )
}
{
  // ts 是记账字段：两次派生之间本来就不同，不该算内容差异。
  const sent = [msg('system', 'S', { ts: 1 }), msg('user', 'hi', { ts: 2 })]
  const derived = [msg('system', 'S', { ts: 9 }), msg('user', 'hi', { ts: 8 })]
  check('ts 差异不算不一致', checkReconstructable(sent, derived).ok === true)
}
{
  // 图像段按逐段比：URL 变了要认出来（不 stringify，图像 data URL 很大）。
  const a = msg('user', [
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ])
  const b = msg('user', [
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
  ])
  check('图像 URL 变了被认出', checkReconstructable([a], [b]).ok === false)
}
{
  // 尾部运行时注入段（env 快照）按结构放宽：易变文本（日期）不误报。
  const env = (date) => `环境快照：${date} 分支 main\n（本条是程序在每次请求时自动附上的当前环境快照，不是用户发言）`
  const sent = [msg('system', 'S'), msg('user', 'hi'), msg('assistant', 'yo'), msg('user', env('2026-10-15'))]
  const derived = [msg('system', 'S'), msg('user', 'hi'), msg('assistant', 'yo'), msg('user', env('2026-10-16'))]
  check('尾部运行时注入段按结构放宽（易变文本不误报）', checkReconstructable(sent, derived).ok === true)
}
{
  const env = '环境快照\n（本条是程序在每次请求时自动附上的当前环境快照，不是用户发言）'
  const hook = '<external_content source="hook:UserPromptSubmit">钩子说了一句</external_content>'
  const sent = [msg('system', 'S'), msg('user', 'hi')]
  const derived = [msg('system', 'S'), msg('user', 'hi'), msg('user', env), msg('user', hook)]
  check('重建侧多出尾部运行时注入段 → ok', checkReconstructable(sent, derived).ok === true)
}
{
  // 尾部多出的 user 不是运行时注入段（没有标记）→ 仍然被抓。
  const sent = [msg('system', 'S'), msg('user', 'hi')]
  const derived = [msg('system', 'S'), msg('user', 'hi'), msg('user', '随便多出来的一条')]
  const r = checkReconstructable(sent, derived)
  check('尾部多出非注入 user 仍被抓', r.ok === false && r.firstDiffIndex === 2, JSON.stringify(r))
}
{
  const before = snapshotMessages([msg('system', 'S'), msg('user', 'hi')])
  const after = [msg('system', 'S'), msg('user', 'hi 被就地改了')]
  const r = checkReconstructable(after, after, { before, after })
  check('就地改输入被抓（firstDiffIndex=1）', r.ok === false && r.firstDiffIndex === 1, JSON.stringify(r))
  check('就地改输入：reason 点明就地改写', (r.reason ?? '').includes('就地'), r.reason)
}
{
  const before = snapshotMessages([msg('system', 'S')])
  const after = [msg('system', 'S'), msg('user', '塞进来的')]
  const r = checkReconstructable(after, after, { before, after })
  check('输入数组被塞一条也被抓（长度差）', r.ok === false && r.firstDiffIndex === 1, JSON.stringify(r))
}
{
  const before = snapshotMessages([msg('system', 'S'), msg('assistant', '', { tool_calls: [{ id: 't', type: 'function', function: { name: 'n', arguments: '{}' } }] })])
  const after = JSON.parse(JSON.stringify(before))
  after[1].tool_calls.push({ id: 't2', type: 'function', function: { name: 'n2', arguments: '{}' } })
  const r = checkReconstructable(after, after, { before, after })
  check('tool_calls 数组被就地追加也被抓', r.ok === false && r.firstDiffIndex === 1, JSON.stringify(r))
}
{
  const weird = [
    { role: 'user', content: null },
    { role: 'user', content: [{ type: 'text', text: 't' }, { type: 'image_url', image_url: { url: 'data:x' } }] },
    { role: 'assistant', content: '' },
  ]
  let threw = false
  let r = null
  try {
    r = checkReconstructable(weird, JSON.parse(JSON.stringify(weird)))
  } catch {
    threw = true
  }
  check('奇怪 content（null / 数组 / 空串）不抛异常', threw === false && r?.ok === true, String(threw))
}
{
  const sent = [msg('system', 'S'), msg('user', 'a'), msg('assistant', 'b')]
  const derived = [msg('system', 'S'), msg('user', 'a'), msg('assistant', 'B')]
  const sentCopy = JSON.stringify(sent)
  const derivedCopy = JSON.stringify(derived)
  checkReconstructable(sent, derived)
  check('校验不改动入参', JSON.stringify(sent) === sentCopy && JSON.stringify(derived) === derivedCopy)
}
{
  const sent = [msg('system', 'S'), msg('user', 'a'), msg('assistant', 'b')]
  const derived = [msg('system', 'S'), msg('user', 'a'), msg('assistant', 'B')]
  const r1 = checkReconstructable(sent, derived)
  const r2 = checkReconstructable(sent, derived)
  check('同一形状 digest 稳定（可做去重键）', r1.digest !== undefined && r1.digest === r2.digest, `${r1.digest} / ${r2.digest}`)
}
{
  const before = snapshotMessages([msg('system', 'S'), msg('user', 'hi')])
  check('firstMutatedIndex：没改返回 null', firstMutatedIndex(before, before.map((m) => ({ ...m }))) === null)
}

// ── ② 真内核 + 假 SSE ────────────────────────────────────────────────────────────
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

async function serve() {
  const state = { requests: 0 }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      state.requests += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        payload = {}
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const isTitle = messages.some(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('会话标题生成器'),
      )
      const realUser = [...messages]
        .reverse()
        .find((m) => m.role === 'user' && !(typeof m.content === 'string' && m.content.includes('不是用户发言')))
      const lastText =
        typeof realUser?.content === 'string'
          ? realUser.content
          : Array.isArray(realUser?.content)
            ? realUser.content.filter((p) => p.type === 'text').map((p) => p.text).join('')
            : ''
      const hasToolResult = messages.some((m) => m.role === 'tool')
      let reply
      if (isTitle) reply = sseText('invariant 探针的会话标题')
      else if (!hasToolResult && lastText.includes('开跑')) reply = sseToolCall('t1', 'echo', '{}')
      else reply = sseText('收到')
      res.end(reply)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, state, close: () => new Promise((resolve) => server.close(resolve)) }
}

const site = await serve()
const { createKernel } = await import('../lib/host/kernel.js')
const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: site.baseUrl,
        apiKey: 'k',
        models: [
          {
            id: 'm',
            name: 'm',
            contextWindow: 100000,
            maxTokens: 500,
            modalities: ['text'],
            thinkingLevels: [],
            thinkingParam: 'none',
            effortMap: {},
          },
        ],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

/** 收集所有 invariant 相关的 notice（dsc/notice → transcript 折 system 条目）。 */
const notices = []
ctx.on('dsc/notice', (text) => {
  if (typeof text === 'string' && text.includes('invariant')) notices.push(text)
})

ctx.tools.register({
  name: 'echo',
  description: '测试用只读工具',
  parameters: { type: 'object', properties: {} },
  risk: 'read',
  run: async () => 'echoed',
})

/** 跑一个真回合，返回 { reason, requests }（requests = 这一回合真发出去的模型请求数）。 */
async function runTurn(text) {
  const before = site.state.requests
  const ended = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', (reason) => {
      off()
      resolve(reason)
    })
  })
  ctx.agent.followup(text)
  const reason = await ended
  await until(() => !ctx.agent.isRunning, 20000)
  await sleep(80)
  return { reason, requests: site.state.requests - before }
}

console.log('[2] 真内核：健康回合零误报')
{
  const turn = await runTurn('开跑：健康回合')
  check('健康回合正常收尾', turn.reason === 'completed', String(turn.reason))
  check('健康回合真的发了请求（含工具调用那一步）', turn.requests >= 2, String(turn.requests))
  check('健康回合零误报（没有 invariant notice）', notices.length === 0, JSON.stringify(notices))
}

console.log('[3] 坏投影一：非纯（往系统提示塞随机数）')
{
  const offRandom = ctx.prompt.registerProjection('bad-random', (msgs) => {
    if (msgs.length === 0) return msgs
    const head = msgs[0]
    const text = typeof head.content === 'string' ? head.content : ''
    return [{ ...head, content: `${text}\nnonce:${Math.random()}` }, ...msgs.slice(1)]
  })
  const t1 = await runTurn('开跑：非纯投影一')
  check('非纯投影：回合仍正常收尾（校验不阻断）', t1.reason === 'completed', String(t1.reason))
  check('非纯投影：请求仍照发（stream 被调用）', t1.requests >= 1, String(t1.requests))
  check('非纯投影：报了一条 notice', notices.length === 1, JSON.stringify(notices))
  check(
    '非纯投影：notice 带条数与 role（第 1 条 / system）',
    (notices[0] ?? '').includes('第 1 条') && (notices[0] ?? '').includes('system'),
    notices[0],
  )
  const t2 = await runTurn('开跑：非纯投影二')
  check('非纯投影：第二回合同形状不再报（去重）', t2.reason === 'completed' && notices.length === 1, JSON.stringify(notices))
  offRandom()
}

console.log('[4] 坏投影二：就地改输入')
{
  const offMutate = ctx.prompt.registerProjection('bad-mutate', (msgs) => {
    if (msgs.length > 0 && typeof msgs[0].content === 'string') msgs[0].content = `${msgs[0].content}\nMUTATED`
    return msgs
  })
  const turn = await runTurn('开跑：就地改输入')
  check('就地改输入：回合正常收尾', turn.reason === 'completed', String(turn.reason))
  check('就地改输入：报了一条新 notice', notices.length === 2, JSON.stringify(notices))
  check('就地改输入：notice 点明「就地改写」', (notices[1] ?? '').includes('就地'), notices[1])
  offMutate()
}

console.log('[5] 坏投影三：组装与发送之间往 session.messages 插一条')
{
  let inserted = false
  const offInsert = ctx.prompt.registerProjection('bad-insert', (msgs) => {
    // 模拟「组装与发送之间会话日志被动了」：投影第一次跑时往 session.messages 插一条。
    // 发送侧在它之前就组装好了（不含这条），重建侧从日志现状派生（含这条）→ 对不上。
    if (!inserted) {
      inserted = true
      ctx.session.current().messages.splice(1, 0, { role: 'user', content: '组装与发送之间插进来的' })
    }
    return msgs
  })
  const turn = await runTurn('开跑：插一条')
  check('插一条：回合正常收尾', turn.reason === 'completed', String(turn.reason))
  check('插一条：报了一条新 notice', notices.length === 3, JSON.stringify(notices))
  check('插一条：firstDiffIndex 命中第 3 条', (notices[2] ?? '').includes('第 3 条'), notices[2])
  offInsert()
  // 收拾插进去的那条，别让它污染后面的断言（它在 index 1）。
  const live = ctx.session.current().messages
  if (live[1]?.content === '组装与发送之间插进来的') live.splice(1, 1)
}

console.log('[6] 端到端：坏投影撤掉后回到零误报')
{
  const turn = await runTurn('开跑：回归干净')
  check('回归回合正常收尾', turn.reason === 'completed', String(turn.reason))
  check('回归后不再新增 notice（零误报）', notices.length === 3, JSON.stringify(notices))
}

await ctx.dispose?.()
await site.close()
console.log('')
if (failures === 0) console.log('运行时请求 invariant 电池：全部通过')
else console.log(`运行时请求 invariant 电池：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
process.exit(failures === 0 ? 0 : 1)
