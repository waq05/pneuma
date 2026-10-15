/**
 * 图片按龄卸载（image-diet）自检：纯函数 + 真投影链 + 真回合端到端。
 *
 * 为什么单独一张网：图片是长会话里最贵的一块——一张 JPEG 截图 100~300KB 的 base64，
 * 留在历史里就是每一轮请求都重发一遍。这一层「留着但只留该留的那几张」是新加的口径，
 * 一旦把「当前正在看的那张截图」误卸载，模型下一步就会照着看不见的画面点错位置；
 * 一旦把消息删了，工具调用配不上对，端点直接 400。所以三件事必须钉死：
 *   ① 纯函数口径：用户图按预算、工具图按最近 N 张、更早回合全卸载、幂等、不改输入；
 *   ② 真投影链：image-diet 在 drop-images 之前跑（模型不收图时两者并存，最终无图）；
 *   ③ 真回合端到端：模型收图时，历史工具结果里的截图只留最近 2 张，最新那张一定在。
 *
 * 全部跑在临时 HOME + 假 SSE 端点上，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/image-diet-test.mjs
 *
 * @module dsc/scripts/image-diet-test
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-image-diet-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
// 假端点：内核装配需要一个能读的 config.yaml，不连真模型
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

const {
  IMAGE_DIET_PLACEHOLDER,
  countImageParts,
  pruneImages,
  readImageDietConfig,
} = await import('../lib/core/image-diet.js')
const { createKernel } = await import('../lib/host/kernel.js')

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
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

const text = (value) => ({ type: 'text', text: value })
const image = (url) => ({ type: 'image_url', image_url: { url } })
const url = (n) => `data:image/png;base64,IMG${n}`
const parts = (message) => (Array.isArray(message?.content) ? message.content : [])
const imageUrls = (message) => parts(message).filter((part) => part.type === 'image_url').map((part) => part.image_url.url)
const placeholders = (message) => parts(message).filter((part) => part.type === 'text' && part.text === IMAGE_DIET_PLACEHOLDER).length
/** 消息的纯文本（content 是数组时拼 text 片段），用来找护栏留在正文里的那几句话。 */
const textOf = (message) =>
  typeof message?.content === 'string'
    ? message.content
    : parts(message).filter((part) => part.type === 'text').map((part) => part.text).join('')
/** 电脑控制截图的形状：tool 消息，text 里带截图标记，后面跟一张图（照 computer-use 的落库）。 */
const shot = (marker, urlValue) => ({ role: 'tool', tool_call_id: `call-${marker}`, content: [text(`屏幕截图 ${marker}`), image(urlValue)] })

// ── 假模型端点（真 SSE）：装在前面，provider 的 baseUrl 要指到这里 ─────────────────
/** 第二轮（带工具结果）请求体，供 ⑪ 断言。 */
const captured = []
let requestCount = 0
/** 一个 SSE 帧（照 teammate-notice-test 的拆法：正文/工具调用与收尾分成两帧）。 */
const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const sseText = (value) =>
  sse({ choices: [{ delta: { content: value } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
  sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) +
  'data: [DONE]\n\n'
const sseToolCall = (id, name) =>
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '{}' } }] } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
  sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) +
  'data: [DONE]\n\n'

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    requestCount += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let payload = {}
    try {
      payload = JSON.parse(body)
    } catch {
      payload = {}
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const hasToolResult = messages.some((m) => m.role === 'tool')
    if (hasToolResult) captured.push(messages)
    // 会话标题的辅助调用：不参与本探针，直接给一句话收掉（别撞上工具分派）
    if (messages.some((m) => m.role === 'system' && String(m.content).includes('会话标题生成器'))) {
      res.end(sseText('图片卸载探针'))
      return
    }
    res.end(hasToolResult ? sseText('完成') : sseToolCall('shot-1', 'shot'))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const baseUrl = `http://127.0.0.1:${port}`

// ── ① 纯函数口径 ───────────────────────────────────────────────────────────────
console.log('[1] pruneImages：用户图按预算')
{
  const messages = [
    { role: 'user', content: [text('看这几张'), ...Array.from({ length: 6 }, (_, index) => image(url(index + 1)))] },
    { role: 'assistant', content: '收到' },
  ]
  const before = JSON.stringify(messages)
  const out = pruneImages(messages)
  check('6 张用户图只留最近 4 张', imageUrls(out[0]).length === 4, JSON.stringify(imageUrls(out[0])))
  check('被卸载的两张留了占位（不是删部件）', placeholders(out[0]) === 2, String(placeholders(out[0])))
  check('保留的是最近的 4 张（顺序不动）', imageUrls(out[0]).join(',') === [3, 4, 5, 6].map(url).join(','))
  check('不改输入（原对象逐字节不变）', JSON.stringify(messages) === before)
  check('没超预算时一张都不动', (() => {
    const three = [{ role: 'user', content: [text('三张'), image(url(1)), image(url(2)), image(url(3))] }]
    const kept = pruneImages(three)
    return countImageParts(kept) === 3 && placeholders(kept[0]) === 0
  })())
}

console.log('[2] pruneImages：工具图只留最近 2 张')
{
  const messages = [
    { role: 'user', content: '开始' },
    shot('A', url(1)),
    shot('B', url(2)),
    shot('C', url(3)),
  ]
  const out = pruneImages(messages)
  check('最老那张截图被卸载', imageUrls(out[1]).length === 0 && placeholders(out[1]) === 1, JSON.stringify(parts(out[1])))
  check('最近两张截图留着', imageUrls(out[2]).length === 1 && imageUrls(out[3]).length === 1)
  check('同一轮里 5 张截图也只留最近 2 张', (() => {
    const many = [{ role: 'user', content: '看' }, ...Array.from({ length: 5 }, (_, index) => shot(`s${index}`, url(index)))]
    const kept = pruneImages(many)
    return countImageParts(kept) === 2
  })())
}

console.log('[3] pruneImages：更早回合的图全卸载 + 不删消息')
{
  const messages = [
    { role: 'user', content: [text('第一轮'), image(url(1)), image(url(2))] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [text('第二轮'), image(url(3))] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [text('第三轮'), image(url(4))] },
    { role: 'assistant', content: 'ok' },
  ]
  const out = pruneImages(messages)
  check('第一轮（更早回合）的图全卸载', imageUrls(out[0]).length === 0 && placeholders(out[0]) === 2, JSON.stringify(parts(out[0])))
  check('第二轮仍在保留窗口内（keepRounds=2）', imageUrls(out[2]).length === 1)
  check('第三轮的图保留', imageUrls(out[4]).length === 1)
  check('消息条数与 role 序列逐条不变', out.length === messages.length && out.every((m, i) => m.role === messages[i].role), JSON.stringify(out.map((m) => m.role)))
  check('role 序列与原文一致（无孤儿/无丢条）', out.map((m) => m.role).join(',') === messages.map((m) => m.role).join(','))
  check('keepRounds=0 时全部卸载', countImageParts(pruneImages(messages, { userImageBudget: 4, toolImageBudget: 2, keepRounds: 0 })) === 0)
}

console.log('[4] pruneImages：文本部件顺序保持 + 幂等 + 契约边界')
{
  const messages = [{ role: 'user', content: [text('前'), image(url(1)), text('中'), image(url(2)), text('后')] }]
  const out = pruneImages(messages, { userImageBudget: 1, toolImageBudget: 2, keepRounds: 2 })
  const shape = parts(out[0]).map((p) => (p.type === 'image_url' ? p.image_url.url : p.text))
  check(
    '卸载只替换 image_url 那一片，文本顺序不变',
    JSON.stringify(shape) === JSON.stringify(['前', IMAGE_DIET_PLACEHOLDER, '中', url(2), '后']),
    JSON.stringify(shape),
  )
  const twice = pruneImages(out, { userImageBudget: 1, toolImageBudget: 2, keepRounds: 2 })
  check('幂等：连跑两遍逐字节相等', JSON.stringify(out) === JSON.stringify(twice))
  const assistantOnly = [{ role: 'assistant', content: [text('a'), image(url(9))] }]
  check('assistant 图不属于契约范围，原样留着', countImageParts(pruneImages(assistantOnly)) === 1)
}

console.log('[5] readImageDietConfig：缺省、总开关、区间夹取')
{
  const defaults = readImageDietConfig(undefined)
  check('缺省：用户 4 / 工具 2 / 保留 2 回合、默认开', defaults.userImageBudget === 4 && defaults.toolImageBudget === 2 && defaults.keepRounds === 2 && defaults.enabled === true, JSON.stringify(defaults))
  check('显式 enabled:false 生效', readImageDietConfig({ enabled: false }).enabled === false)
  const clamped = readImageDietConfig({ userImageBudget: 999, toolImageBudget: -5, keepRounds: 9999 })
  check('超上限夹到 20 / 20 / 50，负值夹到 0', clamped.userImageBudget === 20 && clamped.toolImageBudget === 0 && clamped.keepRounds === 50, JSON.stringify(clamped))
  check('非数字回落缺省', readImageDietConfig({ userImageBudget: 'abc' }).userImageBudget === 4)
}

// ── ② 真投影链 ─────────────────────────────────────────────────────────────────
console.log('[6] 投影链：登记与顺序（image-diet 在 drop-images 之前）')
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
            id: 'm-img',
            name: 'm-img',
            contextWindow: 100000,
            maxTokens: 800,
            modalities: ['text', 'image'],
            thinkingLevels: [],
            thinkingParam: 'none',
            effortMap: {},
          },
          {
            id: 'm-text',
            name: 'm-text',
            contextWindow: 100000,
            maxTokens: 800,
            modalities: ['text'],
            thinkingLevels: [],
            thinkingParam: 'none',
            effortMap: {},
          },
        ],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm-img',
  },
  resumeSessionPath: null,
})

const session = ctx.session.current()
const rewrite = (messages) => ctx.prompt.rewrite(messages, session)

{
  const view = ctx.settings.sections().find((section) => section.id === 'image-diet')
  check('设置分区 image-diet 已注册', view !== undefined, JSON.stringify(ctx.settings.sections().map((s) => s.id)))
  check(
    '分区四个控件齐全',
    JSON.stringify((view?.fields ?? []).map((field) => field.key)) === JSON.stringify(['enabled', 'userImageBudget', 'toolImageBudget', 'keepRounds']),
    JSON.stringify((view?.fields ?? []).map((field) => field.key)),
  )
  const values = await ctx.settings.values('image-diet')
  check('分区缺省值与 core 口径一致', values.enabled === true && values.userImageBudget === 4 && values.toolImageBudget === 2 && values.keepRounds === 2, JSON.stringify(values))
}

console.log('[7] 投影链：模型收图时按预算卸载（真 rewrite）')
{
  const input = [
    { role: 'user', content: [text('看这几张'), ...Array.from({ length: 6 }, (_, index) => image(url(index + 1)))] },
  ]
  const out = rewrite(input)
  const userMessage = [...out].reverse().find((m) => m.role === 'user' && imageUrls(m).length > 0)
  check('模型收图时保留 4 张、卸载 2 张', imageUrls(userMessage).length === 4 && placeholders(userMessage) === 2, JSON.stringify(imageUrls(userMessage)))
  check('消息不被删除（输出条数 ≥ 输入条数）', out.length >= input.length, `${input.length} → ${out.length}`)
  const inputRoles = input.map((m) => m.role).join(',')
  const outRoles = out.map((m) => m.role).join(',')
  check('输入 role 序列是输出 role 序列的子序列（无丢条/无重排）', outRoles.includes(inputRoles), outRoles)
}

console.log('[8] 投影链：电脑控制正在跑时最新那张截图不许被卸载')
{
  // 挂上电脑操作插件：它原来那条只留最新一张截图的投影（prune-stale-screenshots）已降级为
  // 不登记，截图与别的工具结果走同一套通用规则（toolImageBudget=2）。挂上它才能钉住这件事。
  const { computerUsePlugin } = await import('../lib/plugins/computer-use.js')
  await ctx.plugin(computerUsePlugin, {})
  const input = [
    { role: 'user', content: '点一下那个按钮' },
    shot('s1', url(1)),
    shot('s2', url(2)),
    shot('s3', url(3)),
  ]
  const out = rewrite(input)
  const shots = out.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'text' && p.text.startsWith('屏幕截图')))
  const newest = shots[shots.length - 1]
  check('最新那张截图仍在（图像本身随请求发送）', imageUrls(newest).join(',') === url(3), JSON.stringify(parts(newest)))
  check('更老的截图被卸载成占位', imageUrls(shots[0]).length === 0 && placeholders(shots[0]) === 1, JSON.stringify(parts(shots[0])))
  check(
    '用的是通用占位，不是电脑控制那条专有文案（专有投影已降级为不登记）',
    textOf(shots[0]).includes(IMAGE_DIET_PLACEHOLDER) && !textOf(shots[0]).includes('已被更新的截图取代'),
    textOf(shots[0]),
  )
  check('挂上电脑操作后截图仍按 toolImageBudget=2 保留 2 张', countImageParts(out) === 2, String(countImageParts(out)))
}

console.log('[9] 投影链：与 drop-images 并存（模型不收图 → 最终无图，且 image-diet 先跑）')
{
  ctx.llm.setModel('test', 'm-text')
  const input = [
    { role: 'user', content: [text('看图'), ...Array.from({ length: 6 }, (_, index) => image(url(index + 1)))] },
  ]
  const out = rewrite(input)
  check('最终没有 image_url（drop-images 全剥）', countImageParts(out) === 0, String(countImageParts(out)))
  const userMessage = out.find((m) => m.role === 'user')
  check(
    'image-diet 的占位还在（先于 drop-images 跑过）',
    textOf(userMessage).includes(IMAGE_DIET_PLACEHOLDER),
    textOf(userMessage),
  )
  check(
    'drop-images 的说明也在（两条护栏并存）',
    textOf(userMessage).includes('没有声明照片输入能力'),
    textOf(userMessage),
  )
  ctx.llm.setModel('test', 'm-img')
}

console.log('[10] 投影链：设置改了就生效（现读配置）')
{
  const input = [{ role: 'user', content: [text('三张'), image(url(1)), image(url(2)), image(url(3))] }]
  await ctx.settings.save('image-diet', 'userImageBudget', 1)
  const tight = rewrite(input)
  check('预算改成 1 → 只留最近 1 张', countImageParts(tight) === 1, String(countImageParts(tight)))
  await ctx.settings.save('image-diet', 'enabled', false)
  const off = rewrite(input)
  check('总开关关掉 → 一张都不动', countImageParts(off) === 3 && !JSON.stringify(off).includes(IMAGE_DIET_PLACEHOLDER))
  const saved = await ctx.settings.save('image-diet', 'userImageBudget', 999)
  const values = await ctx.settings.values('image-diet')
  check('越界写入被夹到 20（写盘后现读）', saved.ok === true && values.userImageBudget === 20, JSON.stringify(values))
  // 还原缺省，别影响后面的真回合
  await ctx.settings.save('image-diet', 'enabled', true)
  await ctx.settings.save('image-diet', 'userImageBudget', 4)
  await ctx.settings.save('image-diet', 'toolImageBudget', 2)
  await ctx.settings.save('image-diet', 'keepRounds', 2)
}

// ── ③ 真回合端到端：工具结果里的截图只留最近 2 张 ────────────────────────────────
console.log('[11] 真回合端到端：第二轮请求体里的旧截图已卸载、最新那张还在')
ctx.llm.setModel('test', 'm-img')

const offTool = ctx.tools.register({
  name: 'shot',
  description: '探针用截图工具：返回一张文字说明与三张图',
  parameters: { type: 'object', properties: {} },
  risk: 'read',
  run: async () => ({ text: '屏幕快照', images: [url(11), url(12), url(13)] }),
})

const turnEnded = new Promise((resolve) => {
  const off = ctx.on('dsc/turn-end', () => {
    off()
    resolve()
  })
})
ctx.agent.followup('给我截个图')
await turnEnded
await until(() => captured.length > 0)
// 回合收尾还有别的活（会话标题、轮尾改动汇总会拉子进程）：等它们跑完再退场，
// 否则 Windows 上带着半关的子进程句柄 process.exit 会撞 libuv 断言。
await until(() => ctx.agent.isRunning !== true)
await sleep(300)
offTool()

const sent = captured[captured.length - 1] ?? []
const toolMessage = sent.find((m) => m.role === 'tool' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url' || (p.type === 'text' && p.text === IMAGE_DIET_PLACEHOLDER)))
check('第二轮请求体里带上了工具结果', sent.some((m) => m.role === 'tool'), JSON.stringify(sent.map((m) => m.role)))
check('工具结果里的 3 张图只留最近 2 张', imageUrls(toolMessage).length === 2, JSON.stringify(parts(toolMessage)))
check('被卸载的那张留了占位', placeholders(toolMessage) === 1, JSON.stringify(parts(toolMessage)))
check('最新那张截图（第 3 张）一定还在', imageUrls(toolMessage).includes(url(13)), JSON.stringify(imageUrls(toolMessage)))
check('更老的那张（第 1 张）没有发出去', !imageUrls(toolMessage).includes(url(11)))

console.log('')
// 先收内核再关端点：内核（会话文件句柄、llm 连接）没拆干净就关 socket，Windows 上
// libuv 会在退场时断言（照 teammate-notice-test 的收尾顺序）。
await ctx.dispose?.()
if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
await new Promise((resolve) => server.close(resolve))
if (failures === 0) {
  console.log('图片按龄卸载自检：全部通过')
  rmSync(home, { recursive: true, force: true })
} else {
  console.log(`图片按龄卸载自检：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
}
process.exit(failures === 0 ? 0 : 1)
