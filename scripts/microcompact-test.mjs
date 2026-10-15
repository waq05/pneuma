/**
 * 每轮旧工具结果微压缩（WS1）的确定性探针。
 *
 * 契约见 docs/context-token-plan.md 的「### WS1 每轮旧工具结果微压缩」。三段：
 *   [1] 纯函数（直读 src/core/microcompact.ts）：保留窗口 / 最小节省门槛 / 各类跳过 /
 *       幂等 / 不改输入 / 工具名回填——把跳过规则逐条钉成行为；
 *   [2] 接线：真内核里注册的 `microcompact` 投影落在 env-facts(600) 与 drop-images(900)
 *       中间（用两条 649 / 651 哨兵投影夹出微压缩到底在哪一段跑），配置开关也在这里验；
 *   [3] 端到端：真内核 + 假 SSE 跑一段八次工具调用的回合，断言**后一轮请求体**里旧的
 *       工具结果已变占位符，而会话日志原文一个字节没动。
 *
 * 直读 .ts 的做法照 ui-transcript-render-test.mjs（Node 类型擦除）；这里补一个
 * `.js` → `.ts` 的解析回落，纯函数文件才能照常 `import ... from './token-estimate.js'`
 * 复用全仓唯一那份 token 估算（口径不复制第二份）。
 *
 * 隔离：临时 HOME + 假模型端点，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm run build && node scripts/microcompact-test.mjs
 *
 * @module dsc/scripts/microcompact-test
 */
import { registerHooks } from 'node:module'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-microcompact-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 关掉长期记忆：它在回合收尾会投一次复盘，给端到端那段添乱（探针要的是确定性的工具回合）
writeFileSync(
  join(home, '.dsc', 'plugins.json'),
  JSON.stringify({ version: 1, entries: [{ file: 'memory', config: { enabled: false } }] }, null, 2),
  'utf8',
)

// .js → .ts 解析回落：纯函数源文件里照常写 `./token-estimate.js`，直读 .ts 时才需要它
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (
        typeof specifier === 'string' &&
        specifier.endsWith('.js') &&
        (specifier.startsWith('./') || specifier.startsWith('../'))
      ) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

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

// ── 造消息的小工具 ───────────────────────────────────────────────────────────

/** 一段够长、够「像日志」的正文：约 1200 个汉字 ≈ 780 token（稳稳超过 256 的门槛）。 */
const longText = () => `日志行：${'错'.repeat(1200)}`
/** 一段短正文：约 30 个汉字 ≈ 20 token（省不到 256，门槛以内）。 */
const shortText = () => '错误'.repeat(15)
const toolCall = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } })
const assistant = (id, name) => ({ role: 'assistant', content: '', tool_calls: [toolCall(id, name)] })
const toolMsg = (id, content, extra = {}) => ({ role: 'tool', content, tool_call_id: id, ...extra })
const isCleared = (content) => typeof content === 'string' && content.startsWith('[旧工具结果已清理')

const { microcompact, DEFAULT_KEEP_RECENT_TOOL_RESULTS, DEFAULT_MIN_SAVE_TOKENS } = await import(
  new URL('../src/core/microcompact.ts', import.meta.url).href
)

console.log('[1] 纯函数：保留窗口 / 门槛 / 跳过规则 / 幂等')
{
  check('默认值与 ZCode 对齐（保留 5 条、最小省 256）', DEFAULT_KEEP_RECENT_TOOL_RESULTS === 5 && DEFAULT_MIN_SAVE_TOKENS === 256)

  // 20 条工具结果：前 15 条该被清、最后 5 条原文留着
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '开跑' },
  ]
  for (let index = 1; index <= 20; index += 1) {
    messages.push(assistant(`c${index}`, 'bash'), toolMsg(`c${index}`, longText()))
  }
  const before = JSON.stringify(messages)
  const out = microcompact(messages, {})
  const outTools = out.filter((message) => message.role === 'tool')
  const clearedCount = outTools.filter((message) => isCleared(message.content)).length

  check('20 条里前 15 条被清（保留最近 5 条原文）', clearedCount === 15, `cleared=${clearedCount}`)
  check(
    '最后 5 条逐字未动',
    outTools.slice(-5).every((message) => message.content === messages.find((m) => m.tool_call_id === message.tool_call_id).content),
    '尾部被误清',
  )
  check('占位符回填了真实工具名', outTools[0].content === '[旧工具结果已清理：bash]', String(outTools[0].content))
  check(
    '条数与 role 序列不变',
    out.length === messages.length && out.every((message, index) => message.role === messages[index].role),
  )
  check(
    '非 tool 条目原样传过（system / user / assistant 引用都不换）',
    out[0] === messages[0] && out[1] === messages[1] && out[2] === messages[2],
  )
  check('不改输入数组（原数组内容与长度不变）', JSON.stringify(messages) === before, '输入被就地改了')
  check(
    '幂等：连跑两次输出逐字节相等',
    JSON.stringify(microcompact(out, {})) === JSON.stringify(out),
    '第二遍结果不同',
  )

  // 单条最小节省门槛：短结果留着
  const shortList = [
    { role: 'user', content: 'go' },
    assistant('s1', 'bash'),
    toolMsg('s1', shortText()),
    assistant('s2', 'bash'),
    toolMsg('s2', longText()),
  ]
  const shortOut = microcompact(shortList, { keepRecent: 1 })
  check('省不到 256 token 的短结果不清', shortOut[2].content === shortText(), String(shortOut[2].content))
  check('门槛设 0 时短结果也清（只要真能省）', microcompact(shortList, { keepRecent: 1, minSaveTokens: 0 })[2].content === '[旧工具结果已清理：bash]')
  // keepRecent=0：窗口不保护任何一条，两条长结果都该被清（短结果另有门槛挡着，不能用来验这条）
  const twoLong = [
    { role: 'user', content: 'go' },
    assistant('z1', 'bash'),
    toolMsg('z1', longText()),
    assistant('z2', 'bash'),
    toolMsg('z2', longText()),
  ]
  const zeroKeep = microcompact(twoLong, { keepRecent: 0 })
  check(
    'keepRecent=0 时窗口不保护任何一条',
    isCleared(zeroKeep[2].content) && isCleared(zeroKeep[4].content),
    JSON.stringify(zeroKeep.filter((m) => m.role === 'tool').map((m) => String(m.content).slice(0, 14))),
  )

  // 各条跳过规则：都用「2 条工具结果 + keepRecent 1」把第一条顶成候选
  const skipCase = (firstContent, options = {}, firstExtra = {}) => {
    const list = [
      { role: 'user', content: 'go' },
      assistant('a1', 'bash'),
      toolMsg('a1', firstContent, firstExtra),
      assistant('a2', 'bash'),
      toolMsg('a2', longText()),
    ]
    return microcompact(list, { keepRecent: 1, ...options })[2]
  }

  const errorCall = skipCase(longText(), { errorCallIds: new Set(['a1']) })
  check('失败/被拒结果不清（errorCallIds 旁路）', errorCall.content === longText(), '失败结果被清')
  const errorField = skipCase(longText(), {}, { error: 'tool-error' })
  check('消息自带 error 字段的不清', errorField.content === longText(), '带 error 的条目被清')
  const imageText = skipCase(`${longText()} image_url: data:image/png;base64,AAA`)
  check('正文里提到 image_url 的不清', imageText.content.includes('image_url'), '疑似带图结果被清')
  const spilled = skipCase(`${longText()}\n[完整输出已落盘：C:\\tmp\\x.log]`)
  check('已 spill 落盘的结果不清（避免二次处理）', spilled.content.includes('[完整输出已落盘：'), '落盘结果被清')
  const already = skipCase('[旧工具结果已清理：bash]')
  check('已是占位符的不清（幂等锚点）', already.content === '[旧工具结果已清理：bash]', String(already.content))
  const arrayContent = skipCase([{ type: 'text', text: longText() }])
  check('数组正文（带图那种形状）不处理', Array.isArray(arrayContent.content), '数组正文被换了')

  // 工具名查不到：只写光杆一句
  const orphan = [
    { role: 'user', content: 'go' },
    toolMsg('p1', longText()),
    toolMsg('p2', longText()),
  ]
  const orphanOut = microcompact(orphan, { keepRecent: 1 })
  check('查不到工具名时只写「旧工具结果已清理」', orphanOut[1].content === '[旧工具结果已清理]', String(orphanOut[1].content))

  // 没有工具结果时原样返回
  const plain = [{ role: 'user', content: 'hi' }]
  check('没有工具结果时原样返回', JSON.stringify(microcompact(plain, {})) === JSON.stringify(plain))
}

// ── 假模型端点（真 SSE）：端到端那段用它驱动多次工具调用 ───────────────────────
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

/** 端到端要跑几轮工具调用：默认保留 5 条，跑 8 轮才有旧结果可清。 */
const MAX_TOOL_RESULTS = 8
/** 每次请求的 messages 都记下来（探针按请求形状断言）。 */
const seenRequests = []

async function serve() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        payload = {}
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      seenRequests.push(messages)
      const isTitleRequest = messages.some(
        (message) => message.role === 'system' && typeof message.content === 'string' && message.content.includes('会话标题生成器'),
      )
      const toolCount = messages.filter((message) => message.role === 'tool').length
      let reply
      if (isTitleRequest) reply = sseText('微压缩探针的会话标题')
      else if (toolCount < MAX_TOOL_RESULTS) reply = sseToolCall(`t${toolCount + 1}`, 'bulk', '{}')
      else reply = sseText('收尾：都收到了')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(reply)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const site = await serve()
const { createKernel } = await import(new URL('../lib/host/kernel.js', import.meta.url).href)
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
            // 不收图：drop-images 会在最后把图换上文字说明，正方便钉微压缩在它之前
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

console.log('[2] 接线：投影在 env-facts(600) 与 drop-images(900) 之间跑')
{
  // 两条哨兵投影夹住 order 650：649 看到的一定是微压缩之前、651 看到的一定是之后
  const seenBefore = { messages: null }
  const seenAfter = { messages: null }
  const off649 = ctx.prompt.registerProjection(
    'probe-649',
    (messages) => {
      seenBefore.messages = JSON.parse(JSON.stringify(messages))
      return messages
    },
    { order: 649 },
  )
  const off651 = ctx.prompt.registerProjection(
    'probe-651',
    (messages) => {
      seenAfter.messages = JSON.parse(JSON.stringify(messages))
      return messages
    },
    { order: 651 },
  )

  const assembled = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '开跑' },
  ]
  for (let index = 1; index <= 7; index += 1) {
    assembled.push(assistant(`k${index}`, 'bash'), toolMsg(`k${index}`, longText()))
  }
  assembled.push({ role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] })

  const out = ctx.prompt.rewrite(assembled, ctx.session.current())
  const toolsOf = (list) => list.filter((message) => message.role === 'tool')
  const beforeTools = toolsOf(seenBefore.messages ?? [])
  const afterTools = toolsOf(seenAfter.messages ?? [])
  const outTools = toolsOf(out)

  check('649 哨兵看到工具结果原文（微压缩还没跑）', beforeTools.length === 7 && beforeTools.every((message) => !isCleared(message.content)))
  check(
    '649 哨兵看到了 env-facts 追加的末尾环境快照（说明它在 env-facts 之后）',
    (seenBefore.messages ?? []).some(
      (message) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('本条是程序在每次请求时自动附上的当前环境快照'),
    ),
    '没看到环境快照',
  )
  check('651 哨兵看到旧的已被换成占位符（微压缩在 649..651 之间跑）', afterTools.filter((message) => isCleared(message.content)).length === 2, `cleared=${afterTools.filter((message) => isCleared(message.content)).length}`)
  check(
    '651 哨兵手里图像还在（drop-images 还没跑，说明微压缩在它之前）',
    (seenAfter.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')),
  )
  check(
    '投影链末端图像已被 drop-images 换成文字说明（微压缩不在它之后）',
    out.some((message) => Array.isArray(message.content) && message.content.some((part) => part.text?.includes('图像没有随请求发送'))) &&
      !out.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')),
  )
  check('最终请求体里旧工具结果确已清理、最近 5 条原文在', outTools.filter((message) => isCleared(message.content)).length === 2 && outTools.slice(-5).every((message) => !isCleared(message.content)))

  // 配置开关：经真 settings 服务写盘 → 投影立刻不清理
  await ctx.settings.save('microcompact', 'enabled', false)
  const off = ctx.prompt.rewrite(assembled, ctx.session.current())
  check('设置里关掉后投影不再清理', toolsOf(off).every((message) => !isCleared(message.content)), '仍被清理')
  await ctx.settings.save('microcompact', 'enabled', true)
  const backOn = ctx.prompt.rewrite(assembled, ctx.session.current())
  check('再打开后立刻恢复清理', toolsOf(backOn).filter((message) => isCleared(message.content)).length === 2)

  off649()
  off651()
}

console.log('[3] 端到端：后一轮请求体里旧工具结果已清，日志原文不动')
{
  const offTool = ctx.tools.register({
    name: 'bulk',
    description: '测试用长输出工具',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async () => longText(),
  })

  const ended = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', () => {
      off()
      resolve()
    })
  })
  ctx.agent.followup('开跑')
  await until(() => seenRequests.length > 0)
  await ended
  await until(() => !ctx.agent.isRunning, 30000)
  await sleep(120)

  const maxToolRequest = seenRequests
    .filter((messages) => messages.filter((message) => message.role === 'tool').length === MAX_TOOL_RESULTS)
    .at(-1)
  check('拿到了带 8 条工具结果的请求体', maxToolRequest !== undefined, `requests=${seenRequests.length}`)
  const requestTools = (maxToolRequest ?? []).filter((message) => message.role === 'tool')
  check('请求体里工具结果一条不少（8 条）', requestTools.length === MAX_TOOL_RESULTS, `got=${requestTools.length}`)
  check(
    '请求体里最旧 3 条已变占位符（保留窗口 5 条）',
    requestTools.slice(0, 3).every((message) => message.content === '[旧工具结果已清理：bulk]'),
    JSON.stringify(requestTools.map((message) => String(message.content).slice(0, 14))),
  )
  check('请求体里最近 5 条仍是原文', requestTools.slice(3).every((message) => message.content.startsWith('日志行：')))
  check(
    '会话日志原文一个字节没动（清理只发生在请求体上）',
    ctx.session.current().messages.filter((message) => message.role === 'tool').every((message) => typeof message.content === 'string' && message.content.startsWith('日志行：')),
    '日志被改了',
  )

  offTool()
}

await ctx.dispose?.()
await site.close()
console.log('')
if (failures === 0) console.log('旧工具结果微压缩电池：全部通过')
else console.log(`旧工具结果微压缩电池：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
process.exit(failures === 0 ? 0 : 1)
