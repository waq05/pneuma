/**
 * 长期记忆评估（memory eval）回归探针：纯模块逐项 + 真回合注入计数 + 账本对齐。
 *
 * 边界 ④ 说「记忆的评估机制没做、隐式使用计数的扫回话命中片段只做了代码审查，
 * 没构造带 assistant 消息的真回合去断言计数递增」——本探针把这两件都补上：
 *   A. 纯模块（`src/core/memory-eval.ts`，零依赖，按 Node 类型擦除直读）：
 *      空库 / 全部被引用 / 全部死重 / 被预算挤掉 / grade 三档边界 / UTF-8 字节数 /
 *      排序（count 优先再看时间）/ `formatMemoryReport` 的增量行。
 *   B. 账本对齐 codex（`lib/core/memory.js`）：每条引用 +1、`last` 更新、注入维独立
 *      （不碰引用）、老 `.usage.json` 向后兼容、清理「只移不删」且 `usage_count=0` 优先被移。
 *   C. 真回合（真内核 + 假 SSE，照 `teammate-notice-test.mjs` 的套路）：一次真回合后
 *      `injected` 递增、同回合第二次请求不重复递增（负向锚点）、`citedCount` 只在回话
 *      命中片段时递增；`/memory eval` 与设置只读统计行走真出口。
 *
 * 隔离：临时 HOME + 假模型端点，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm build && node scripts/memory-eval-test.mjs
 *
 * @module dsc/scripts/memory-eval-test
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-memory-eval-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// memory 插件：开注入，关自动复盘与自动整理（本探针自己控时机，也不要复盘话术来抢镜头）。
writeFileSync(
  join(home, '.dsc', 'plugins.json'),
  JSON.stringify(
    { version: 1, entries: [{ file: 'memory', config: { enabled: true, reviewEnabled: false, reviewEveryTurns: 0, pruneEnabled: false } }] },
    null,
    2,
  ),
  'utf8',
)

// 真回合要用的两条记忆：内核起来之前先摆在盘上（免得后续读被当成「外部改动」）。
const ENTRY_A = '记忆甲片段甲子乙丑丙寅丁卯'
const ENTRY_B = '记忆乙片段子丑寅卯辰巳午未'
const memGlobal = join(home, '.dsc', 'memory', 'global')
mkdirSync(memGlobal, { recursive: true })
writeFileSync(join(memGlobal, 'MEMORY.md'), `${ENTRY_A}\n§\n${ENTRY_B}\n`, 'utf8')

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

// ── A. 纯模块：memory-eval.ts 直读（Node 类型擦除，零运行期依赖）──────────────────
const evalMod = await import(new URL('../src/core/memory-eval.ts', import.meta.url).href)
const { evaluateMemory, formatMemoryReport, readingsOf } = evalMod

/** 造一条评估条目。 */
const entry = (key, target, text, injectedTurns, citedCount, lastCitedAt = null) => ({
  key,
  target,
  text,
  injectedTurns,
  citedCount,
  lastCitedAt,
})
const input = (entries, extra = {}) => ({
  entries,
  turns: 0,
  usedChars: 0,
  limitChars: 100,
  pruneAfterDays: 60,
  now: 1_700_000_000_000,
  ...extra,
})

console.log('[A] 纯模块 memory-eval');
{
  // 空库：没有东西可评，不该报偏差。
  const empty = evaluateMemory(input([]))
  check('空库 grade=healthy', empty.grade === 'healthy', empty.grade)
  check('空库 coverage 记 1', empty.coverage === 1, String(empty.coverage))
  check('空库 citationRate 记 1', empty.citationRate === 1, String(empty.citationRate))
  check('空库死重/未注入都空', empty.deadWeight.length === 0 && empty.uninjected.length === 0, JSON.stringify({ d: empty.deadWeight, u: empty.uninjected }))
  check('空库体量与预算都是 0', empty.storageBytes === 0 && empty.budgetRatio === 0, JSON.stringify({ s: empty.storageBytes, b: empty.budgetRatio }))

  // 全部被引用：健康。
  const allCited = evaluateMemory(input([entry('a', 'global', '事实甲', 2, 3, 100), entry('b', 'user', '偏好乙', 1, 1, 200)]))
  check('全部被引用 grade=healthy', allCited.grade === 'healthy', allCited.grade)
  check('全部被引用 coverage=1 / citationRate=1', allCited.coverage === 1 && allCited.citationRate === 1, JSON.stringify({ c: allCited.coverage, r: allCited.citationRate }))
  check('全部被引用无死重', allCited.deadWeight.length === 0, JSON.stringify(allCited.deadWeight))

  // 全部死重：注入够多但一次没被引用 → poor。
  const allDead = evaluateMemory(input([entry('d1', 'global', '死重一', 3, 0), entry('d2', 'global', '死重二', 9, 0)]))
  check('全部死重 grade=poor', allDead.grade === 'poor', allDead.grade)
  check('全部死重 citationRate=0', allDead.citationRate === 0, String(allDead.citationRate))
  check('全部死重都进 deadWeight', JSON.stringify(allDead.deadWeight) === JSON.stringify(['d1', 'd2']), JSON.stringify(allDead.deadWeight))

  // 被预算挤掉：turns > 0 但从没进过提示词 → 进 uninjected。
  const squeezed = evaluateMemory(input([entry('in1', 'global', '进过提示词', 1, 0), entry('out1', 'global', '被挤掉', 0, 0)], { turns: 1 }))
  check('被预算挤掉的进 uninjected', JSON.stringify(squeezed.uninjected) === JSON.stringify(['out1']), JSON.stringify(squeezed.uninjected))
  check('被预算挤掉时 coverage<1', squeezed.coverage === 0.5, String(squeezed.coverage))
  // 负向锚点：轮数还没发生（turns=0）就不该判「未注入」。
  const noTurns = evaluateMemory(input([entry('in1', 'global', '进过提示词', 1, 0), entry('out1', 'global', '被挤掉', 0, 0)], { turns: 0 }))
  check('turns=0 时 uninjected 为空（负向锚点）', noTurns.uninjected.length === 0, JSON.stringify(noTurns.uninjected))

  // grade 三档边界（阈值文档化在模块注释里）。
  const covHalf = evaluateMemory(input([entry('x1', 'global', '甲', 1, 1, 1), entry('x2', 'global', '乙', 0, 0)]))
  check('coverage=0.5 恰好 → watch（不是 poor）', covHalf.coverage === 0.5 && covHalf.grade === 'watch', JSON.stringify({ c: covHalf.coverage, g: covHalf.grade }))
  const covFull = evaluateMemory(input([
    entry('y1', 'global', '甲', 1, 1, 1),
    entry('y2', 'global', '乙', 1, 1, 1),
    entry('y3', 'global', '丙', 1, 1, 1),
    entry('y4', 'global', '丁', 1, 1, 1),
    entry('y5', 'global', '戊', 0, 0),
  ]))
  check('coverage=0.8 恰好 → healthy', covFull.coverage === 0.8 && covFull.grade === 'healthy', JSON.stringify({ c: covFull.coverage, g: covFull.grade }))
  const citeFifth = evaluateMemory(input(['a', 'b', 'c', 'd', 'e'].map((k, i) => entry(k, 'global', `条目${k}`, 1, i === 0 ? 1 : 0, i === 0 ? 9 : null))))
  check('citationRate=0.2 恰好 → watch（不是 poor）', Math.abs(citeFifth.citationRate - 0.2) < 1e-9 && citeFifth.grade === 'watch', JSON.stringify({ r: citeFifth.citationRate, g: citeFifth.grade }))
  const citeHalf = evaluateMemory(input(['a', 'b', 'c', 'd'].map((k, i) => entry(k, 'global', `条目${k}`, 1, i < 2 ? 1 : 0, i < 2 ? 9 : null))))
  check('citationRate=0.5 恰好 → healthy', citeHalf.citationRate === 0.5 && citeHalf.grade === 'healthy', JSON.stringify({ r: citeHalf.citationRate, g: citeHalf.grade }))
  // 负向锚点：预算占用 0.89 健康、0.9 恰好转 watch。
  const budgetLow = evaluateMemory(input([entry('b1', 'global', '甲', 1, 1, 1)], { usedChars: 89, limitChars: 100 }))
  const budgetEdge = evaluateMemory(input([entry('b1', 'global', '甲', 1, 1, 1)], { usedChars: 90, limitChars: 100 }))
  check('budgetRatio=0.9 恰好 → watch', budgetEdge.budgetRatio === 0.9 && budgetEdge.grade === 'watch', JSON.stringify({ b: budgetEdge.budgetRatio, g: budgetEdge.grade }))
  check('budgetRatio=0.89 → 仍 healthy（负向锚点）', budgetLow.grade === 'healthy', JSON.stringify({ b: budgetLow.budgetRatio, g: budgetLow.grade }))
  // 死重边界：injectedTurns=3 才算，2 不算。
  const deadEdge = evaluateMemory(input([entry('e3', 'global', '三次', 3, 0), entry('e2', 'global', '两次', 2, 0)]))
  check('注入满 3 轮没引用才算死重', JSON.stringify(deadEdge.deadWeight) === JSON.stringify(['e3']), JSON.stringify(deadEdge.deadWeight))

  // UTF-8 字节数（条目正文口径）。
  const utf = evaluateMemory(input([entry('u1', 'global', '中文abc', 1, 1, 1)]))
  check('体量按 UTF-8 字节算（两个中文 + 三个 ASCII = 9 字节）', utf.storageBytes === Buffer.byteLength('中文abc', 'utf8') && utf.storageBytes === 9, String(utf.storageBytes))

  // 排序：count 优先，再看 lastCitedAt（对齐 codex 的选择 ORDER BY）。
  const ranked = evaluateMemory(input([
    entry('lo', 'global', '低', 1, 1, 999),
    entry('hiOld', 'global', '高旧', 1, 5, 100),
    entry('hiNew', 'global', '高新', 1, 5, 500),
  ]))
  check('排序 count 优先', ranked.ranking[0] === 'hiNew' && ranked.ranking[1] === 'hiOld' && ranked.ranking[2] === 'lo', JSON.stringify(ranked.ranking))
  // 负向锚点：时间新的排前（把 hiNew 的 lastCitedAt 变小，顺序必须翻转）。
  const ranked2 = evaluateMemory(input([
    entry('lo', 'global', '低', 1, 1, 999),
    entry('hiOld', 'global', '高旧', 1, 5, 500),
    entry('hiNew', 'global', '高新', 1, 5, 100),
  ]))
  check('同 count 时 lastCitedAt 新的排前（负向锚点）', ranked2.ranking[0] === 'hiOld' && ranked2.ranking[1] === 'hiNew', JSON.stringify(ranked2.ranking))

  // 每格读数（对齐 codex 的 MemoriesUsageKind 分类）。
  const perTarget = evaluateMemory(input([entry('g1', 'global', '甲', 1, 1, 1), entry('g2', 'global', '乙', 3, 0), entry('u1', 'user', '丙', 1, 1, 1)]))
  const g = perTarget.byTarget.find((cell) => cell.target === 'global')
  const u = perTarget.byTarget.find((cell) => cell.target === 'user')
  check('byTarget 分出两格', perTarget.byTarget.length === 2, JSON.stringify(perTarget.byTarget.map((c) => c.target)))
  check('byTarget 每格条目/注入/引用读数正确', g.entries === 2 && g.injectedEntries === 2 && g.citedEntries === 1 && g.deadWeight.length === 1 && u.entries === 1 && u.citedEntries === 1, JSON.stringify({ g, u }))

  // lines 人话报表。
  const lines = empty.lines
  check('lines 含「等级 健康」（中文人话）', lines.some((line) => line === '等级 健康'), JSON.stringify(lines))
  check('lines 含「覆盖率 100%」', lines.includes('覆盖率 100%'), JSON.stringify(lines))

  // formatMemoryReport：无 previous 无对比段；有 previous 逐项给增量。
  const noPrev = formatMemoryReport(empty)
  check('无上次读数时没有对比段', !noPrev.includes('与上次相比'), noPrev)
  const prevOne = readingsOf(evaluateMemory(input([entry('a', 'global', '甲', 0, 0)], { turns: 1 }))) // 1 条、从没被注入
  const curTwo = evaluateMemory(input([entry('a', 'global', '甲', 1, 1, 1), entry('b', 'global', '乙', 1, 1, 1)]))
  const withDelta = formatMemoryReport(curTwo, prevOne)
  check('有上次读数时出现「与上次相比」', withDelta.includes('与上次相比'), withDelta)
  check('增量逐项：条目 +1', withDelta.includes('条目 2（+1）'), withDelta)
  check('增量逐项：引用 +2', withDelta.includes('引用 2（+2）'), withDelta)
  check('增量逐项：覆盖率给百分比点', withDelta.includes('覆盖率 100%（+100%）'), withDelta)
  const prevWatch = { ...readingsOf(curTwo), grade: 'watch' }
  check('等级变化行给出上次档位', formatMemoryReport(curTwo, prevWatch).includes('等级 健康（上次 留意）'), formatMemoryReport(curTwo, prevWatch))
  check('readingsOf 去掉 lines 但留读数', !('lines' in prevOne) && prevOne.entries === 1, JSON.stringify(Object.keys(prevOne)))
}

// ── 假模型端点（真 SSE）：驱动真回合 ──────────────────────────────────────────
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
      const isTitleRequest = messages.some(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('会话标题生成器'),
      )
      // 环境事实那条是程序在每次请求末尾自动附上的 user 消息（尾巴写明「不是用户发言」），
      // 先滤掉它再看「最后一条对话消息」是不是工具结果。
      const conv = messages.filter((m) => !(m.role === 'user' && typeof m.content === 'string' && m.content.includes('不是用户发言')))
      const lastConv = conv[conv.length - 1]
      const realUser = [...conv].reverse().find((m) => m.role === 'user')
      let reply
      if (isTitleRequest) reply = sseText('记忆评估探针标题')
      else if (lastConv?.role === 'tool') reply = sseText(`收尾。${ENTRY_A}`) // 回话命中甲条目的前 12 字 → 记一次引用
      else if (typeof realUser?.content === 'string' && realUser.content.includes('开跑')) reply = sseToolCall('t1', 'echo_probe', '{}')
      else reply = sseText('收到')
      res.end(reply)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const site = await serve()
const { createKernel } = await import('../lib/host/kernel.js')
const core = await import('../lib/core/memory.js')
const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: site.baseUrl,
        apiKey: 'k',
        models: [
          { id: 'm', name: 'm', contextWindow: 100000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} },
        ],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})
const { runCommand } = await import('../lib/plugins/commands.js')
const usageOf = () => core.readUsage()
const injectedOf = (key) => usageOf()[key]?.injected ?? 0
const countOf = (key) => usageOf()[key]?.count ?? 0
const keyA = core.entryUsageKey('global', ENTRY_A)
const keyB = core.entryUsageKey('global', ENTRY_B)

const echoTool = ctx.tools.register({
  name: 'echo_probe',
  description: '测试用回声工具',
  parameters: { type: 'object', properties: {} },
  risk: 'read',
  run: async () => 'probe ok',
})
const waitTurn = () =>
  new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', () => {
      off()
      resolve()
    })
  })

// ── C. 真回合：注入计数与引用计数 ───────────────────────────────────────────────
console.log('\n[C] 真回合注入 / 引用计数');
{
  const baseA = injectedOf(keyA)
  const baseB = injectedOf(keyB)
  const baseCiteA = countOf(keyA)

  const t1 = waitTurn()
  ctx.agent.followup('开跑')
  await until(() => ctx.agent.isRunning)
  await t1
  await until(() => !ctx.agent.isRunning)
  await sleep(150)

  check('一次真回合后甲的 injected 递增 1', injectedOf(keyA) === baseA + 1, JSON.stringify({ baseA, now: injectedOf(keyA) }))
  check('一次真回合后乙的 injected 递增 1', injectedOf(keyB) === baseB + 1, JSON.stringify({ baseB, now: injectedOf(keyB) }))
  // 负向锚点：这一回合走了两次请求（工具调用 + 收尾），若没按回合去重会 +2。
  check('同回合第二次请求不重复递增（负向锚点）', injectedOf(keyA) - baseA === 1, JSON.stringify({ delta: injectedOf(keyA) - baseA }))
  check('回话命中甲片段 → 甲 citedCount +1', countOf(keyA) === baseCiteA + 1, JSON.stringify({ baseCiteA, now: countOf(keyA) }))
  check('回话没提乙 → 乙 citedCount 保持 0', countOf(keyB) === 0, String(countOf(keyB)))

  // 第二条回合：回话不命中任何片段 → 只有 injected 涨，引用不动。
  const t2 = waitTurn()
  ctx.agent.followup('再来一轮')
  await until(() => ctx.agent.isRunning)
  await t2
  await until(() => !ctx.agent.isRunning)
  await sleep(150)
  check('第二回合 injected 再 +1', injectedOf(keyA) === baseA + 2, JSON.stringify({ now: injectedOf(keyA) }))
  check('第二回合回话没命中 → 甲 citedCount 不动', countOf(keyA) === baseCiteA + 1, JSON.stringify({ now: countOf(keyA) }))

  // 账文件形状：注入维与引用维都在。
  const raw = JSON.parse(readFileSync(core.usageFile(), 'utf8'))
  check('账文件里 injected 是数字', typeof raw[keyA]?.injected === 'number' && raw[keyA].injected === baseA + 2, JSON.stringify(raw[keyA]))
  check('账文件里 lastInjected 有值且注入不改引用 last', typeof raw[keyA]?.lastInjected === 'number' && raw[keyA].lastInjected > 0, JSON.stringify(raw[keyA]))
  check('账文件里引用维 count/last 仍在', raw[keyA].count === baseCiteA + 1 && typeof raw[keyA].last === 'number', JSON.stringify(raw[keyA]))

  // /memory eval 出口（第一次无上次读数、第二次有）。
  const ui = { notices: [] }
  const uiCtx = { notice: (text) => ui.notices.push(text) }
  runCommand('/memory eval', {}, uiCtx)
  check('/memory eval 输出含「记忆评估」', ui.notices.some((n) => n.includes('记忆评估')), JSON.stringify(ui.notices))
  check('/memory eval 报表含两条记忆', ui.notices.some((n) => n.includes('条目 2 条')), JSON.stringify(ui.notices))
  check('首次评估没有对比段（还没有上次读数）', !ui.notices.join('\n').includes('与上次相比'), JSON.stringify(ui.notices))
  ui.notices.length = 0
  runCommand('/memory eval', {}, uiCtx)
  check('第二次评估出现「与上次相比」增量段', ui.notices.join('\n').includes('与上次相比'), JSON.stringify(ui.notices))
  check('评估读数落 .eval.json', existsSync(core.evalFile()), core.evalFile())

  // 设置分区：只读统计行 + 评估按钮，走真出口。
  const settings = ctx.get('settings')
  const section = settings.sections().find((item) => item.id === 'memory')
  const statField = section?.fields.find((field) => field.type === 'info' && (field.label ?? '').includes('使用评估'))
  check('设置分区里有只读统计行', statField !== undefined && typeof statField.text === 'string' && statField.text.includes('引用率'), JSON.stringify(statField))
  check('设置统计行读数是活的（含条数与引用率）', /条目 \d+/.test(statField?.text ?? '') && /引用率 \d+%/.test(statField?.text ?? ''), statField?.text)
  check('设置分区里有「看评估报告」按钮', section?.fields.some((field) => field.type === 'button' && field.action === 'evalReport'), JSON.stringify(section?.fields.map((f) => f.type)))
  const actionResult = await settings.action('memory', 'evalReport')
  check('「看评估报告」按钮返回评估文本', actionResult.ok === true && typeof actionResult.notice === 'string' && actionResult.notice.includes('记忆评估'), JSON.stringify(actionResult))
}

await ctx.dispose?.()
await site.close()
echoTool()

// ── B. 账本对齐 codex（lib/core/memory.js）────────────────────────────────────
console.log('\n[B] 账本对齐 codex（count/last/注入维/清理）');
{
  const k = 'ledger-anchor-key'
  core.bumpUsage([k], 1000)
  check('每条引用 +1', core.readUsage()[k].count === 1, JSON.stringify(core.readUsage()[k]))
  core.bumpUsage([k], 2000)
  check('再引用一次 count=2 且 last 更新', core.readUsage()[k].count === 2 && core.readUsage()[k].last === 2000, JSON.stringify(core.readUsage()[k]))
  core.bumpInjected([k], 3000)
  const rec = core.readUsage()[k]
  check('注入累加 injected 且记 lastInjected', rec.injected === 1 && rec.lastInjected === 3000, JSON.stringify(rec))
  // 负向锚点：注入不是引用，绝不能动 count/last（否则清理把「只是被注入」的当成被引用过）。
  check('注入不改引用 count（负向锚点）', rec.count === 2, JSON.stringify(rec))
  check('注入不改引用 last（负向锚点）', rec.last === 2000, JSON.stringify(rec))

  // 老账文件（缺 injected）向后兼容，且下一次记账不把它抹掉。
  writeFileSync(core.usageFile(), JSON.stringify({ legacy: { count: 2, last: 5 } }), 'utf8')
  check('老记录缺 injected 读成 0', core.readUsage().legacy.injected === 0, JSON.stringify(core.readUsage().legacy))
  core.bumpInjected(['legacy'], 7)
  const legacy = core.readUsage().legacy
  check('在老记录上记注入：injected=1 且 count/last 原样', legacy.injected === 1 && legacy.count === 2 && legacy.last === 5, JSON.stringify(legacy))

  // 裸读数文件：路径、往返、缺文件返回 null。
  check('evalFile 落在 memory 目录下的 .eval.json', core.evalFile().endsWith(join('memory', '.eval.json')), core.evalFile())
  rmSync(core.evalFile(), { force: true })
  check('没有评估文件时 readEval 返回 null', core.readEval() === null)
  core.writeEval({ entries: 5, grade: 'watch' })
  check('writeEval/readEval 往返一致', core.readEval().entries === 5 && core.readEval().grade === 'watch', JSON.stringify(core.readEval()))

  // 清理：被引用过的留下、usage_count=0 的移走，且「只移不删」。
  const ws = join(home, 'wsprune')
  mkdirSync(ws, { recursive: true })
  const KEEP = '被引用过的条目'
  const DROP = '从没被引用的条目'
  const wsFile = core.memoryFileOf('workspace', ws)
  mkdirSync(dirname(wsFile), { recursive: true })
  writeFileSync(wsFile, `${KEEP}\n§\n${DROP}\n`, 'utf8')
  const usage = { [core.entryUsageKey('workspace', KEEP)]: { count: 3, last: Date.now() - 100_000 } }
  // now 取在文件 mtime 之后一点：afterDays=0 下没被引用过的必被判陈旧，避免毫秒级赛跑。
  const pruned = core.pruneCells(ws, core.MEMORY_LIMIT_DEFAULTS, { global: false, user: false, workspace: true }, { afterDays: 0, now: Date.now() + 1000, usage })
  const after = core.splitEntries(readFileSync(wsFile, 'utf8'))
  check('清理：被引用过的留下（count 优先）', after.includes(KEEP) && !after.includes(DROP), JSON.stringify(after))
  check('清理：usage_count=0 的移走', pruned.moved.workspace.includes(DROP), JSON.stringify(pruned.moved.workspace))
  const archivePath = core.archiveFileOf('workspace', ws)
  const archived = existsSync(archivePath) ? core.splitEntries(readFileSync(archivePath, 'utf8')) : []
  check('清理：只移不删（归档里找得到）', archived.includes(DROP) && !archived.includes(KEEP), JSON.stringify(archived))
}

console.log('')
if (failures === 0) {
  console.log('长期记忆评估电池：全部通过')
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    console.log(`（临时 HOME 未清掉，留在 ${home}，可手动删除）`)
  }
} else {
  console.log(`长期记忆评估电池：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
}
process.exit(failures === 0 ? 0 : 1)
