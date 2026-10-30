/**
 * 工具渐进披露（`tool_search` / `tool_describe` / `tool_call`）的自检：真内核 + 临时 HOME。
 *
 * 为什么单开一条：会话里模型把 `tool_search` 当**全局工具目录**用，搜不到就回答用户
 * 「这台机器上没有网页搜索工具」——它其实只检索「撤下的工具」（MCP 的动手类 + 命中
 * 渐进披露规则的注册表工具）。这一节钉住三类事实：
 *   [1] 撤下真的发生（exec 的 bash 从台面消失、read 工具一个不动），三条桥接工具在台面上；
 *   [2] 搜得到撤下的那条、`tool_describe` 取得到 schema；
 *   [3] 搜不到时的文案把口径说清（只装撤下的 + 台面清单 + 「不等于这台机器没有」）。
 *
 * 隔离：临时 HOME，真实 ~/.dsc 一个字节都不动。用法：pnpm build && node scripts/tool-search-test.mjs
 *
 * @module dsc/scripts/tool-search-test
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-tool-search-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dsc = join(home, '.dsc')
mkdirSync(dsc, { recursive: true })
// 内核装配要读 config.yaml；model 段给个假名就行（这里不连模型）
writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 官方可开关插件：显式打开 tool-search，并让 `bash`（exec）命中延后规则
writeFileSync(
  join(dsc, 'plugins.json'),
  JSON.stringify(
    { version: 1, entries: [{ file: 'tool-search', disabled: false, config: { deferRules: ['bash'] } }] },
    null,
    2,
  ),
  'utf8',
)

let failures = 0
let passes = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passes += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const { createKernel } = await import('../lib/host/kernel.js')
const { DEFAULT_TOOL_SEARCH_CONFIG, shouldDeferTool } = await import('../lib/core/tool-search.js')
const { gateIdentity } = await import('../lib/core/tools.js')

/** 按延后规则起一份内核（插件配置每次挂载时从 plugins.json 现读，所以可以起两份）。 */
async function boot(rules) {
  writeFileSync(
    join(dsc, 'plugins.json'),
    JSON.stringify(
      { version: 1, entries: [{ file: 'tool-search', disabled: false, config: { deferRules: rules } }] },
      null,
      2,
    ),
    'utf8',
  )
  const kernel = await createKernel({ config: {}, resumeSessionPath: null })
  const session = kernel.get('session').current()
  return {
    kernel,
    tool: (name) => kernel.tools.list().find((entry) => entry.name === name),
    toolNames: () => kernel.tools.list().map((entry) => entry.name),
    runCtx: {
      cwd: process.cwd(),
      sessionId: session.meta.id,
      sessionPath: session.filePath,
      signal: new AbortController().signal,
    },
  }
}

console.log('工具渐进披露测试')

// ── [1] 撤下与台面（`bash` 命中延后规则） ───────────────────────────────────
const first = await boot(['bash'])
{
  const names = first.toolNames()
  check(
    '三条桥接工具在台面上（插件真的挂上了）',
    ['tool_search', 'tool_describe', 'tool_call'].every((name) => names.includes(name)),
    JSON.stringify(names),
  )
  check('命中延后规则的 `bash`（exec）已从台面撤下', !names.includes('bash'), JSON.stringify(names.filter((n) => n.includes('bash'))))
  check(
    'read 工具一个都没撤（撤了每次读都得先搜再调，多两次往返）',
    ['read', 'glob', 'grep'].every((name) => names.includes(name)),
    JSON.stringify(['read', 'glob', 'grep'].filter((n) => !names.includes(n))),
  )
}

// ── [2] 搜得到 / 取得到 schema ─────────────────────────────────────────────
{
  const found = String(await first.tool('tool_search').run({ query: 'bash' }, first.runCtx))
  check('搜 `bash` 命中（撤下的目录里就是它）', /\b1\. bash\b/.test(found) && found.includes('tool_call'), found.slice(0, 140))
  const schema = String(await first.tool('tool_describe').run({ name: 'bash' }, first.runCtx))
  check('`tool_describe bash` 给出 schema 与「已从台面上撤下」的去向', schema.includes('command') && schema.includes('已从台面上撤下'), schema.slice(0, 140))
}

// ── [3] 搜不到时的口径（这次报障的根因） ───────────────────────────────────
{
  const miss = String(await first.tool('tool_search').run({ query: '网页搜索 网络搜索 web search', limit: 15 }, first.runCtx))
  check('点明这个目录只装「被撤下」的工具', miss.includes('只装**被撤下**的工具'), miss.slice(0, 120))
  check('把台面清单一起给出（模型据此知道机器上到底有什么）', /台面上现有 \d+ 条，直接按真名调用：/.test(miss) && /read/.test(miss), miss.slice(-220))
  check('写明「搜不到不等于这台机器没有这个工具」', miss.includes('搜不到不等于这台机器没有这个工具'), miss.slice(-220))
  check('目录非空时报条数', /撤下的目录里有 \d+ 条/.test(miss), miss.slice(0, 80))
  const desc = first.tool('tool_search').description
  check('工具说明也写明「不是全局工具目录」', desc.includes('不是全局工具目录') && desc.includes('不等于'), desc.slice(-80))
}

// ── [4] 目录为空时的话术（一份什么都不撤的内核） ───────────────────────────
{
  const empty = await boot(['这个规则谁都不命中'])
  const catalogEmpty = empty.toolNames().includes('bash')
  check('对照：这份内核什么都没撤（bash 还在台面上）', catalogEmpty, JSON.stringify(empty.toolNames().slice(0, 6)))
  const miss = String(await empty.tool('tool_search').run({ query: 'bash' }, empty.runCtx))
  check('空目录说「是空的」而不是「共 0 条」（旧话术会被读成「没有工具」）', miss.includes('撤下的目录是空的'), miss.slice(0, 100))
  check('空目录时照样给出台面清单（bash 就在里面）', /台面上现有 \d+ 条/.test(miss) && /bash/.test(miss), miss.slice(-160))
}

// ── [5] 桥接工具的错误路径 ─────────────────────────────────────────────────
{
  let bridgeError = ''
  try {
    await first.tool('tool_call').run({ name: 'tool_search' }, first.runCtx)
  } catch (error) {
    bridgeError = error instanceof Error ? error.message : String(error)
  }
  check('`tool_call` 拒绝再包一层桥接工具', bridgeError.includes('本来就在台面上'), bridgeError)
  let missingError = ''
  try {
    await first.tool('tool_call').run({ name: 'no_such_tool' }, first.runCtx)
  } catch (error) {
    missingError = error instanceof Error ? error.message : String(error)
  }
  check('`tool_call` 点名不存在的工具并指路 tool_search', missingError.includes('没有这个工具') && missingError.includes('tool_search'), missingError)
}

// ── [6] 撤下判定（纯函数；read 永不撤是安全底线） ───────────────────────────
{
  const tier3 = { ...DEFAULT_TOOL_SEARCH_CONFIG, tier: 3, deferRules: [], keepTools: [] }
  check('tier 3：write 工具被撤', shouldDeferTool({ name: 'write', risk: 'write' }, tier3))
  check('tier 3：read 工具照样不撤（写 `*` 也拦得住）', !shouldDeferTool({ name: 'read', risk: 'read' }, { ...tier3, deferRules: ['*'] }))
  check('keepTools 保得住写类工具', !shouldDeferTool({ name: 'bash', risk: 'exec' }, { ...tier3, keepTools: ['bash'] }))
  check('tier 2 只撤命中规则的', !shouldDeferTool({ name: 'bash', risk: 'exec' }, { ...tier3, tier: 2, deferRules: ['edit'] }))
}

// ── [7] 桥接工具报出真名（一次调用只问一遍守卫的大前提） ───────────────────
{
  const bridge = first.tool('tool_call')
  const held = gateIdentity(bridge, { name: 'bash', arguments: { command: 'echo hi' } }, process.cwd())
  check(
    '撤下的工具：守卫链看到的是真名与真实风险（不是 tool_call / exec）',
    held.name === 'bash' && held.risk === 'exec' && held.args.command === 'echo hi',
    JSON.stringify(held),
  )
  const live = gateIdentity(bridge, { name: 'read', arguments: { file_path: 'a.ts' } }, process.cwd())
  check(
    '台面上的只读工具：按 read 判定（不再因为走 tool_call 就多弹一张卡）',
    live.name === 'read' && live.risk === 'read',
    JSON.stringify(live),
  )
  const badName = gateIdentity(bridge, { name: 'no_such_tool' }, process.cwd())
  check('名字拼错：退回按桥自己判定，错误留给 run 报给模型', badName.name === 'tool_call' && badName.risk === 'exec', JSON.stringify(badName))
  const badArgs = gateIdentity(bridge, { name: 'bash', arguments: '{不是 JSON' }, process.cwd())
  check('参数坏掉：仍按真名问一遍（参数退成空对象），run 里照样会报错', badArgs.name === 'bash' && Object.keys(badArgs.args).length === 0, JSON.stringify(badArgs))
  const nested = gateIdentity(bridge, { name: 'tool_search' }, process.cwd())
  check('想再包一层桥接工具：按桥自己判定（run 里会拒绝）', nested.name === 'tool_call', JSON.stringify(nested))
}

console.log(`工具渐进披露电池：${passes} PASS / ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
