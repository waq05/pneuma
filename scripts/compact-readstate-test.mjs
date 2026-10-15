/**
 * 压缩后 read-state 回插（WS5）的电池。
 *
 * 对标 ZCode 的 post-compact read-state：压缩掉一段历史后，接手的模型看不出
 * 「这些文件我刚读到哪」，只能重读一遍。这里从被折区间机械抽出「压前最后读过哪些文件、
 * 读到哪一段」，作为一条紧凑的 read-state 段并进摘要。它只带路径与行范围、不带文件内容，
 * 且文案自带「可能已过时，需要时重读」（read-state 是提示不是真相）。
 *
 * 断言三层：
 *   ① 纯函数 `buildReadState`：路径+行范围、同文件只留最后一次、超上限只留最近 N、
 *      超预算截断带省略标记、没读过给空串、非 read 调用/坏参数不算、幂等、maxFiles=0 关闭；
 *   ② 摘要拼接顺序：摘要正文 → carry → 原话 → 锚点 → **read-state** → 细节找回；
 *   ③ 真内核 + 假 SSE 端到端：压一段带 read 的历史，断言压缩后 `kept[0]` 含 read-state、
 *      不含被折原文。
 *
 * 隔离：临时 HOME + 假模型端点，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm build && node scripts/compact-readstate-test.mjs
 *
 * @module dsc/scripts/compact-readstate-test
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-readstate-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 关掉长期记忆，免得它在回合收尾投机器通知、干扰端到端；compact 保留条数压到 5，
// 这样一小段历史就能触发压缩。
writeFileSync(
  join(home, '.dsc', 'plugins.json'),
  JSON.stringify(
    { version: 1, entries: [{ file: 'memory', config: { enabled: false } }, { file: 'compact', config: { keepRecent: 5 } }] },
    null,
    2,
  ),
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

const { buildReadState, DEFAULT_READ_STATE_FILES, SUMMARY_BANNER } = await import('../lib/core/compact-anchors.js')
const { compactSession } = await import('../lib/core/compact.js')

/** 造一条带 read 调用的 assistant 消息。 */
const readAssistant = (id, path, offset, limit) => ({
  role: 'assistant',
  content: '',
  tool_calls: [
    {
      id,
      type: 'function',
      function: {
        name: 'read',
        arguments: JSON.stringify({ path, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) }),
      },
    },
  ],
})

/** 造一条带任意工具调用的 assistant 消息（用来验证非 read 调用不算）。 */
const anyAssistant = (id, name, args) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
})

console.log('[1] buildReadState 纯函数')
{
  // ① 单次 read → 含路径与行范围
  const one = buildReadState([readAssistant('c1', 'D:\\proj\\src\\a.ts', 1, 100)], 1500)
  check('单次 read 产出含路径', one.includes('D:\\proj\\src\\a.ts'), one)
  check('单次 read 产出含行范围', one.includes('第 1–100 行'), one)
  check('标题带「可能已过时，需要时重读」', one.includes('## 读过的文件（可能已过时，需要时重读）'), one)

  // ② 同文件多次读 → 只留最后一次（行范围取最后那次）
  const twice = buildReadState(
    [
      readAssistant('c1', 'D:\\a\\x.ts', 1, 50),
      readAssistant('c2', 'D:\\a\\x.ts', 100, 25),
    ],
    1500,
  )
  check('同文件多次读只出现一次', twice.split('D:\\a\\x.ts').length - 1 === 1, twice)
  check('同文件取最后一次的行范围', twice.includes('第 100–124 行') && !twice.includes('第 1–50 行'), twice)

  // ③ 超 readStateFiles → 只留最近 N 个（丢最老的）
  const six = Array.from({ length: 6 }, (_, index) => readAssistant(`c${index}`, `D:\\p\\f${index + 1}.ts`, 1, 10))
  const capped = buildReadState(six, 4000, 5)
  check('默认上限是 5', DEFAULT_READ_STATE_FILES === 5)
  check('超上限只留 5 个', capped.split('\n- ').length - 1 === 5, capped)
  check('丢的是最老那个（f1）', !capped.includes('f1.ts') && capped.includes('f6.ts'), capped)
  check('最近的在最前（f6 在 f5 之前）', capped.indexOf('f6.ts') < capped.indexOf('f5.ts'), capped)

  // ④ 超预算 → 截断带省略标记，且不超预算（maxFiles 放大，逼出「行数够但装不下」的截断）
  const many = Array.from({ length: 20 }, (_, index) => readAssistant(`c${index}`, `D:\\verylongpath\\dir${index}\\file${index}.ts`, 1, 10))
  const clipped = buildReadState(many, 500, 20)
  check('超预算带省略标记', clipped.includes('……（后文省略）'), clipped)
  check('超预算结果不超过预算', clipped.length <= 500, String(clipped.length))

  // ⑤ 没读过任何文件 → 空串
  check('只有用户消息 → 空串', buildReadState([{ role: 'user', content: '你好' }], 1500) === '')
  check('空输入 → 空串', buildReadState([], 1500) === '')

  // ⑥ 非 read 工具调用不算
  const nonRead = buildReadState([anyAssistant('c1', 'bash', '{"path":"D:\\\\a\\\\b.ts"}')], 1500)
  check('非 read 调用不算', nonRead === '', nonRead)

  // ⑦ 坏参数（JSON 截断）→ 跳过
  const badJson = buildReadState([anyAssistant('c1', 'read', '{不是合法 JSON')], 1500)
  check('参数坏 JSON → 跳过', badJson === '', badJson)
  const noPath = buildReadState([anyAssistant('c1', 'read', '{"offset":3}')], 1500)
  check('没有 path → 跳过', noPath === '', noPath)

  // ⑧ 行范围变体：只给 offset / 什么都不给
  const offsetOnly = buildReadState([readAssistant('c1', 'D:\\a\\y.ts', 40)], 1500)
  check('只给 offset → 「第 N 行起」', offsetOnly.includes('第 40 行起'), offsetOnly)
  const bare = buildReadState([readAssistant('c1', 'D:\\a\\z.ts')], 1500)
  check('不给 offset/limit → 「第 1 行起」', bare.includes('第 1 行起'), bare)

  // ⑨ maxFiles=0 → 关闭（这条也是负向验证的锚点：写死 0 时上面「含路径」会变红）
  check('maxFiles=0 → 空串', buildReadState([readAssistant('c1', 'D:\\a\\a.ts', 1, 10)], 1500, 0) === '')

  // ⑩ 预算装不下标题 → 空串
  check('预算太小装不下标题 → 空串', buildReadState([readAssistant('c1', 'D:\\a\\a.ts', 1, 10)], 10) === '')

  // ⑪ 幂等
  const msgSet = [readAssistant('c1', 'D:\\a\\a.ts', 1, 10), readAssistant('c2', 'D:\\a\\b.ts', 5, 20)]
  check('幂等：同输入同输出', buildReadState(msgSet, 1500) === buildReadState(msgSet, 1500))
}

console.log('[2] compactSession 摘要拼接顺序（readState 在 recovery 之前）')
{
  const messages = [
    { role: 'user', content: '帮我看看这两个文件' },
    readAssistant('c1', 'D:\\proj\\a.ts', 1, 30),
    { role: 'tool', content: 'a.ts 的内容', tool_call_id: 'c1' },
    readAssistant('c2', 'D:\\proj\\b.ts', 10, 20),
    { role: 'tool', content: 'b.ts 的内容', tool_call_id: 'c2' },
    ...Array.from({ length: 6 }, (_, index) => ({ role: 'user', content: `填充 ${index}` })),
  ]
  const session = {
    messages,
    meta: { id: 'unit-order' },
    filePath: 'D:\\tmp\\unit-order.jsonl',
    summary: '',
    kept: null,
    replaceWithSummary(summary, kept) {
      this.summary = summary
      this.kept = kept
    },
  }
  const route = { api: 'openai-completions', baseUrl: 'http://x', apiKey: 'k', model: 'm' }
  const stream = async () => ({ text: '【假摘要】顺序检查' })
  const outcome = await compactSession(
    session,
    route,
    stream,
    new AbortController().signal,
    undefined,
    { keepRecent: 3, anchorChars: 6000, userQuoteChars: 8000, readStateFiles: 5, readStateChars: 1500 },
    undefined,
    { imageBudget: 4, toolResultChars: 2000 },
    { system: 'SYS', tools: [] },
  )
  check('压缩成功', outcome === 'compacted', outcome)
  const text = session.summary
  check('摘要含 read-state 段', text.includes('## 读过的文件'), text)
  const atAnchor = text.indexOf('## 锚点索引')
  const atRead = text.indexOf('## 读过的文件')
  const atRecovery = text.indexOf('## 细节找回')
  check('read-state 在细节找回之前', atRead >= 0 && atRecovery > atRead, JSON.stringify({ atAnchor, atRead, atRecovery }))
  check('read-state 在锚点索引之后', atRead > atAnchor && atAnchor >= 0, JSON.stringify({ atAnchor, atRead }))
}

console.log('[3] 真内核 + 假 SSE 端到端')
{
  // ── 假模型端点：压缩请求（最后一条 user 含「交接摘要」）回摘要正文 ────────────
  const sseText = (t) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n` +
    'data: [DONE]\n\n'
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
      const isTitle = messages.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('会话标题生成器'))
      res.end(isCompact ? sseText('【假摘要】这段历史已压缩') : isTitle ? sseText('read-state 探针') : sseText('收到'))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`

  const { createKernel } = await import('../lib/host/kernel.js')
  const ctx = await createKernel({
    config: {
      providers: {
        test: {
          name: 'test',
          displayName: 'Test',
          baseUrl,
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

  const session = ctx.session.current()
  const SENTINEL = '被折掉的工具结果原文哨兵-ZZZ-不该出现'
  session.appendUser('开场：看这几个文件')
  for (let index = 1; index <= 6; index += 1) {
    const callId = `r${index}`
    const path = `D:\\proj\\src\\f${index}.ts`
    session.appendAssistant('', '', [{ id: callId, name: 'read', arguments: JSON.stringify({ path, offset: 1, limit: 200 }) }])
    session.appendTool(callId, 'read', index === 1 ? SENTINEL : `f${index}.ts 的内容`)
  }
  session.appendUser('继续')
  session.appendAssistant('收到', '', [])
  session.appendUser('还有别的吗')
  session.appendAssistant('没有了', '', [])
  session.appendUser('好')

  await ctx.compact.run()

  const kept = session.messages
  const head = typeof kept[0]?.content === 'string' ? kept[0].content : ''
  check('压缩后首条是摘要（kept[0] 带 banner）', head.startsWith(SUMMARY_BANNER), head.slice(0, 40))
  check('kept[0] 含 read-state 段', head.includes('## 读过的文件'), head.slice(0, 200))
  check('kept[0] 含最后读过的文件路径', head.includes('D:\\proj\\src\\f6.ts'), head.slice(-400))
  check('kept[0] 含行范围', head.includes('第 1–200 行'), head.slice(-400))
  check('kept[0] 不含被折掉的原文哨兵', !head.includes(SENTINEL), head.includes(SENTINEL) ? '哨兵泄漏' : '')
  const orderKernel = [head.indexOf('## 锚点索引'), head.indexOf('## 读过的文件'), head.indexOf('## 细节找回')]
  check('端到端顺序：锚点 < read-state < 细节找回', orderKernel[0] >= 0 && orderKernel[1] > orderKernel[0] && orderKernel[2] > orderKernel[1], JSON.stringify(orderKernel))

  await ctx.dispose?.()
  await new Promise((resolve) => server.close(resolve))
}

console.log('')
if (failures === 0) console.log('压缩 read-state 电池：全部通过')
else console.log(`压缩 read-state 电池：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
process.exit(failures === 0 ? 0 : 1)
