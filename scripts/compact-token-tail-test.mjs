/**
 * 压缩口径对齐（2026-11-02）的探针：按 token 留尾巴、摘要压不小就放弃、压完复量再压、
 * 阈值口径（窗口 − 输出预留 − 安全余量）、爆窗先看微压缩投影。
 *
 * 为什么单开一份：这五条都是「换一套口径」的改动，纯函数与接线两半都得验——
 *   - `selectCut` 是纯函数，但它的意义只在「一条工具结果就几十万字符」的会话里显出来，
 *     普通小消息的历史用条数口径和 token 口径结果一样，测不出区别；
 *   - 复量再压与阈值口径都在 `check()` 里，只有真内核（真配置、真模型路由、真事件）
 *     才验得到；摘要放弃与微压缩短路同理（一个要假会话，一个要真服务）。
 *
 * 覆盖 7 件（任务要求至少 6 件）：
 *   [1] token 预算选尾比固定 20 条留下更多内容（构造一条巨型 tool 结果）；
 *   [2] 尾部不以孤儿 tool 消息开头（切点落在 tool 上时退到 assistant）；
 *   [3] 摘要不小于原文时抛错，且会话历史一条没动；
 *   [4] 复量循环：第一次压完仍超阈值会再压，到上限（compactionRetries）就停；
 *   [5] 阈值口径：128k 窗口、maxTokens 8192 时安全余量按窗口 6.4% 算（约 8388），
 *       而不是照抄 dsh 的定值 65536；
 *   [6] `projectedTokens` 在旧工具结果很多时明显小于原始估算；
 *   [7] 爆窗强压先看投影：清理后装得下就直接返回 false，不牺牲历史。
 *
 * 全部跑在临时 HOME 上（假模型端点），真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm run build && node scripts/compact-token-tail-test.mjs
 *
 * @module dsc/scripts/compact-token-tail-test
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-compact-token-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dscHome = join(home, '.dsc')
mkdirSync(dscHome, { recursive: true })
writeFileSync(join(dscHome, 'config.yaml'), 'model:\n  name: test\n', 'utf8')

/** 写插件配置（内核装配时按它读配置，等价于用户在设置页调过的值）。 */
const writePlugins = (compactConfig) => {
  writeFileSync(
    join(dscHome, 'plugins.json'),
    JSON.stringify(
      {
        version: 1,
        entries: [{ file: 'memory', config: { enabled: false } }, { file: 'compact', config: compactConfig }],
      },
      null,
      2,
    ),
    'utf8',
  )
}

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
}

const { selectCut, safeCut, estimateTokens, compactSession } = await import('../lib/core/compact.js')

// ── [1][2] 纯函数：切点选择 ──────────────────────────────────────────────────
console.log('── [1] token 预算选尾 vs 固定条数 ──')
const GIANT = 'G'.repeat(200_000) // 约 66k tokens：一条工具结果就能把尾巴预算吃满
const caps = { keepRecent: 20, anchorChars: 1000, userQuoteChars: 1000, readStateFiles: 0, readStateChars: 200 }
const mixed = [
  { role: 'user', content: '开始' },
  { role: 'assistant', content: '好' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'c1', content: GIANT },
]
for (let index = 0; index < 26; index += 1) {
  mixed.push(
    index % 2 === 0 ? { role: 'user', content: `补充 ${index}` } : { role: 'assistant', content: `收到 ${index}` },
  )
}
{
  const byCount = safeCut(mixed, mixed.length - caps.keepRecent)
  const byTokens = selectCut(mixed, { ...caps, retainTokens: 60_000 })
  check('纯条数口径切在倒数第 20 条（索引 10）', byCount === 10, String(byCount))
  check('token 口径把巨型工具结果一起留下（索引 2）', byTokens === 2, String(byTokens))
  check(
    'token 口径留下的尾部含那条巨型结果',
    mixed.slice(byTokens).some((message) => message.content === GIANT),
  )
  check(
    '纯条数口径把这条结果折掉了（这就是「等于没压」的场景）',
    !mixed.slice(byCount).some((message) => message.content === GIANT),
  )
  check('预算比整段小很多时，条数下限仍然生效', selectCut(mixed, { ...caps, retainTokens: 1 }) === 10, String(selectCut(mixed, { ...caps, retainTokens: 1 })))
}

console.log('── [2] 切点落在 tool 消息上时退到配对边界 ──')
{
  // 预算 1000：倒着累加到巨型结果那条就超了，keepFrom 正好落在 tool 消息上
  const cut = selectCut(mixed, { ...caps, retainTokens: 1_000 })
  check('切点退到索引 2（assistant）', cut === 2, String(cut))
  check('尾部不以孤儿 tool 消息开头', mixed[cut].role !== 'tool', String(mixed[cut].role))
  const pairedId = mixed[cut].tool_calls?.[0]?.id
  check('尾部第一条的 tool_call 与紧跟的结果配对', mixed[cut + 1].tool_call_id === pairedId, String(pairedId))
  const allTools = [
    { role: 'tool', tool_call_id: 'a', content: '结果 A' },
    { role: 'tool', tool_call_id: 'b', content: '结果 B' },
    { role: 'tool', tool_call_id: 'c', content: '结果 C' },
  ]
  check('整段都是工具结果时切点是 0（调用方按无法压缩处理）', selectCut(allTools, { ...caps, keepRecent: 2 }) === 0)
}

// ── [3] 摘要压不小就放弃 ────────────────────────────────────────────────────
console.log('── [3] 摘要不小于原文时抛错且历史不动 ──')
{
  const messages = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
    { role: 'assistant', content: 'd' },
    { role: 'user', content: 'e' },
    { role: 'assistant', content: 'f' },
    { role: 'user', content: 'g' },
  ]
  const snapshot = JSON.stringify(messages)
  const session = {
    messages,
    meta: { id: 'unit-tiny' },
    filePath: 'D:\\tmp\\unit-tiny.jsonl',
    summary: '',
    replaced: false,
    replaceWithSummary(text, kept) {
      this.replaced = true
      this.summary = text
      this.messages = kept
    },
  }
  // 摘要模型回一段比整段历史长几百倍的正文：摘要估算必然 >= 被折内容的估算
  const hugeText = 'z'.repeat(60_000)
  const stream = async () => ({ text: hugeText })
  let thrown
  try {
    await compactSession(
      session,
      { api: 'openai-completions', baseUrl: 'http://x', apiKey: 'k', model: 'm' },
      stream,
      new AbortController().signal,
      undefined,
      { keepRecent: 2, anchorChars: 1000, userQuoteChars: 1000, readStateFiles: 0, readStateChars: 200 },
      undefined,
      { imageBudget: 4, toolResultChars: 2000 },
      { system: 'SYS', tools: [] },
    )
  } catch (error) {
    thrown = error
  }
  check('抛了错', thrown instanceof Error, String(thrown))
  check('错误文案说明「压缩没有意义」', String(thrown?.message ?? '').includes('压缩没有意义'), String(thrown?.message ?? ''))
  check('没有写摘要（replaceWithSummary 没被调用）', session.replaced === false)
  check('会话历史一条没动', JSON.stringify(session.messages) === snapshot)
}

// ── 假模型端点：压缩请求回一段短摘要，别的请求回一句普通回答 ─────────────────
const sseText = (text) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n` +
  'data: [DONE]\n\n'
let compactRequests = 0
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let payload = {}
    try {
      payload = JSON.parse(body)
    } catch {
      payload = {}
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const last = messages[messages.length - 1]
    const lastText = typeof last?.content === 'string' ? last.content : ''
    const isCompact = lastText.includes('交接摘要')
    if (isCompact) compactRequests += 1
    res.end(isCompact ? sseText('【假摘要】这段历史已压缩') : sseText('收到'))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`

/** 造一个内核：模型窗口与输出预留由参数给，压缩配置走 plugins.json。 */
const makeKernel = async (model) => {
  const { createKernel } = await import('../lib/host/kernel.js')
  return createKernel({
    config: {
      providers: {
        test: {
          name: 'test',
          displayName: 'Test',
          baseUrl,
          apiKey: 'k',
          models: [
            {
              id: model.id,
              name: model.id,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              modalities: ['text'],
              thinkingLevels: [],
              thinkingParam: 'none',
              effortMap: {},
            },
          ],
        },
      },
      defaultProvider: 'test',
      defaultModel: model.id,
    },
    resumeSessionPath: null,
  })
}

const BIG = 'x'.repeat(4_000) // 约 1320 tokens 一条

// ── [4] 复量循环：还超就再压，到上限停 ───────────────────────────────────────
console.log('── [4] 压完复量、还超就再压、到上限停 ──')
const notices = []
writePlugins({ keepRecent: 5, autoCompactPercent: 50, compactionRetries: 1 })
const ctx1 = await makeKernel({ id: 'm-small', contextWindow: 4_000, maxTokens: 500 })
ctx1.on('dsc/notice', (text) => notices.push(text))
const session1 = ctx1.session.current()
{
  // 阈值 = max(1024, min(4000×50%, 4000−500−256)) = 2000
  // 历史布局（15 条）：……, assistant(6 个工具调用), tool×6。
  // 切点 = 15−5 = 10 落在 tool 上 → 退到索引 8，尾巴 7 条；
  // 压完 = 摘要 + 7 条 = 8 条 > keepRecent+2 = 7，所以第二次压得动。
  session1.appendUser('开工')
  session1.appendAssistant('收到', '', [])
  for (let index = 0; index < 3; index += 1) {
    session1.appendUser(`第${index}批 ${BIG}`)
    session1.appendAssistant(`第${index}批收到 ${BIG}`, '', [])
  }
  const calls = Array.from({ length: 6 }, (_, index) => ({
    id: `t${index + 1}`,
    name: 'bash',
    arguments: '{}',
  }))
  session1.appendAssistant('', '', calls)
  for (let index = 0; index < 6; index += 1) session1.appendTool(`t${index + 1}`, 'bash', `输出 ${BIG}`)

  const before = estimateTokens(session1.messages)
  check('压前估算确实超过阈值 2000', before > 2000, String(before))
  await ctx1.compact.check()
  check('第一次压完仍超阈值 → 再压一次（共 2 次摘要调用）', compactRequests === 2, String(compactRequests))
  check('第二次压完到上限就停（不会变成 3 次）', compactRequests === 2, String(compactRequests))
  check(
    '提示带次数与复量结果',
    notices.some((text) => text.includes('已连续压缩 2 次') && text.includes('阈值 2000')),
    JSON.stringify(notices),
  )
  const after = estimateTokens(session1.messages)
  check('压完仍超阈值（说明补压确实用完了）', after > 2000, String(after))
}

// ── [6] projectedTokens：旧工具结果很多时明显更小 ──────────────────────────
console.log('── [6] 微压缩投影估算明显小于原始估算 ──')
const toolHeavy = []
for (let index = 0; index < 30; index += 1) {
  toolHeavy.push({
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: `h${index}`, type: 'function', function: { name: 'bash', arguments: `{"i":${index}}` } },
    ],
  })
  toolHeavy.push({ role: 'tool', tool_call_id: `h${index}`, content: `第${index}个结果 ${BIG}` })
}
{
  const micro = ctx1.get('microcompact')
  check('内核里拿得到 microcompact 服务', micro !== undefined)
  const raw = estimateTokens(toolHeavy)
  const projected = micro.projectedTokens(toolHeavy)
  check('投影估算明显小于原始估算（省掉七成以上）', projected < raw * 0.3, `${projected} vs ${raw}`)
  check('投影估算本身是个正数', Number.isFinite(projected) && projected > 0, String(projected))
}
await ctx1.dispose?.()

// ── [5] 阈值口径：128k 窗口、maxTokens 8192 ────────────────────────────────
console.log('── [5] 阈值口径（安全余量按窗口 6.4% 而不是定值 65536）──')
writePlugins({ keepRecent: 5, autoCompactPercent: 80, compactionRetries: 0 })
const ctx2 = await makeKernel({ id: 'm-big', contextWindow: 131_072, maxTokens: 8_192 })
ctx2.on('dsc/notice', (text) => notices.push(text))
const session2 = ctx2.session.current()
const window = 131_072
const reserve = 8_192
const autoHeadroom = Math.min(65_536, Math.floor(window * 0.064))
const expectedThreshold = Math.max(1024, Math.min(Math.floor(window * 0.8), window - reserve - autoHeadroom))
const oldThreshold = Math.max(1024, Math.min(Math.floor(window * 0.8), window - reserve - 65_536))
console.log(`      期望阈值 = ${expectedThreshold}（旧口径会是 ${oldThreshold}）`)
{
  compactRequests = 0
  // 造 ~68k tokens 的历史：旧口径（57344）会判超，新口径（104857）不该判超
  const chunk = 'x'.repeat(26_000) // 约 8580 tokens
  for (let index = 0; index < 4; index += 1) {
    session2.appendUser(`第${index}段 ${chunk}`)
    session2.appendAssistant(`收到第${index}段 ${chunk}`, '', [])
  }
  const used = estimateTokens(session2.messages)
  check('历史估算落在新旧阈值之间（旧口径会压，新口径不该压）', used > oldThreshold && used <= expectedThreshold, String(used))
  await ctx2.compact.check()
  check('新口径下没有触发压缩', compactRequests === 0, String(compactRequests))
  check('新阈值约等于窗口的 80%（而不是 44%）', expectedThreshold === Math.floor(window * 0.8), String(expectedThreshold))
  check('自动安全余量按 6.4% 算（约 8388），不是 65536', autoHeadroom === 8_388, String(autoHeadroom))
}

// ── [7] 爆窗强压先看微压缩投影 ──────────────────────────────────────────────
console.log('── [7] 清理后装得下就不压摘要 ──')
{
  compactRequests = 0
  notices.length = 0
  session2.messages.length = 0
  for (const message of toolHeavy) session2.messages.push(message)
  const micro = ctx2.get('microcompact')
  check('投影后已在窗口内', micro.projectedTokens(session2.messages) < ctx2.llm.contextWindowOf(session2))
  const compacted = await ctx2.compact.forceCompact()
  check('forceCompact 返回 false（这一轮不压）', compacted === false, String(compacted))
  check('没有发摘要请求', compactRequests === 0, String(compactRequests))
  check(
    '发了一条「直接重试」的提示',
    notices.some((text) => text.includes('旧工具结果清理后已在窗口内')),
    JSON.stringify(notices),
  )
}
// ── [8] 端到端：插件真的把「窗口 16%」传给了切点 ────────────────────────────
// [4] 那一段的切点被「条数下限」兜住，验不出 token 预算有没有接线；这一段让预算
// 明显大于下限：60k 窗口 → 保留 9600 token，40 条各约 1300 token 的历史里，
// token 口径留下约 8 条，纯条数口径（keepRecent=5）只会留 5 条。
console.log('── [8] 插件按窗口 16% 算保留预算（不是只按条数）──')
{
  compactRequests = 0
  notices.length = 0
  writePlugins({ keepRecent: 5, autoCompactPercent: 50, compactionRetries: 0 })
  const ctx3 = await makeKernel({ id: 'm-tail', contextWindow: 60_000, maxTokens: 500 })
  const session3 = ctx3.session.current()
  for (let index = 0; index < 20; index += 1) {
    session3.appendUser(`第${index}问 ${BIG}`)
    session3.appendAssistant(`第${index}答 ${BIG}`, '', [])
  }
  const beforeTok = estimateTokens(session3.messages)
  const beforeCount = session3.messages.length
  // 阈值 = max(1024, min(60000×50%, 60000−500−3840)) = 30000；历史约 52k，确实超了
  check('压前既超阈值又是长历史', beforeTok > 30_000 && beforeCount === 40, `${beforeTok} / ${beforeCount}`)
  await ctx3.compact.check()
  const kept = session3.messages.length
  check('真压了一次（有摘要调用）', compactRequests >= 1, String(compactRequests))
  // 9600 token 预算 ÷ 每条约 1300 token ≈ 8 条，加摘要本身 = 9；纯条数口径会是 1+5=6
  check('尾巴按 token 预算留在 8 条左右，而不是只留下限 5 条', kept >= 8, String(kept))
  check('也没把整段留下（确实压掉了大部分）', kept < 16, String(kept))
  await ctx3.dispose?.()
}
await ctx2.dispose?.()
await new Promise((resolve) => server.close(resolve))

console.log('')
if (failures === 0) console.log('压缩口径探针：全部通过')
else console.log(`压缩口径探针：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
process.exit(failures === 0 ? 0 : 1)
