/**
 * 审批卡改版自检（0.7.1）：卡片只留「要干什么、动哪个文件、为什么问你」。
 *
 * 三季度那份用户反馈是「审批框一堆看不懂的字」——命令原文读不懂、档位行每张都重复、
 * 「低风险」徽章和「5 分钟没人答」的提示句占着地方不给信息。这次改版收掉的就是这些。
 *
 * 判据分三类：
 *   [1] 数据从哪来：契约里有 `meaning`，审批插件把命令原文与含义一起下发；
 *   [2] 两张卡（插件壳 / 旧渲染层）都画了含义行、都收掉了噪音（正反双验）；
 *   [3] 样式两份样式表都有，且含义行排在命令原文**之前**（先给结论，再给原文）。
 *
 * 跑法：node scripts/ui-approval-card-test.mjs（纯源码检查，不需要 build）
 *
 * @module dsc/scripts/ui-approval-card-test
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

// 契约 0.7.1 按域拆成十份（`src/contract/*.ts`，`src/contract.ts` 只做转出）：
// 审批那一份才是实体，转出那份只用来确认「导出面没断」。
const contract = read('src/contract/approval.ts')
const contractBarrel = read('src/contract.ts')
const plugin = read('src/plugins/approval.ts')
const shell = read('ui-shell/src/plugins/prompt/ui.tsx')
const legacy = read('desktop/src/renderer/ApprovalCard.tsx')
const tui = read('src/app/ApprovalCard.tsx')
const shellCss = read('ui-shell/src/legacy/views.css')
const legacyCss = read('desktop/src/renderer/styles.css')

// ── [1] 数据从哪来 ─────────────────────────────────────────────────────────────

console.log('[1] 契约与审批插件')
check('契约里有 meaning 字段', contract.includes('meaning?: string'))
check('转出那份把审批契约照旧带出来', contractBarrel.includes("export * from './contract/approval.js'"))
check('契约说清命令类工具的摘要给的是命令原文', contract.includes('命令类工具给的是**命令原文**'))
check('审批插件引入 callMeaning', plugin.includes("from '../core/call-meaning.js'"))
check('插件在裁决时算出含义', plugin.includes('const meaning = callMeaning({'))
check('插件把命令原文当参数摘要', plugin.includes('const summary = command ?? request.argsSummary'))
check('视图用传进来的摘要', plugin.includes('argsSummary: redact(input.summary)'))
check('含义进了视图', plugin.includes('...(input.meaning === null ? {} : { meaning: input.meaning })'))

// ── [2] 两张卡 ────────────────────────────────────────────────────────────────

console.log('[2] 插件壳与旧渲染层的卡片')
for (const [name, source] of [
  ['插件壳', shell],
  ['旧渲染层', legacy],
]) {
  check(`${name}：画含义行`, source.includes('className="approval-meaning"'))
  check(`${name}：低风险不画徽章`, source.includes("request.risk === 'low' ? null :"))
  check(`${name}：通用兜底理由不占版面`, source.includes('isGenericReason(request.reason)'))
  check(`${name}：档位行收进悬浮提示`, source.includes('title={modeLine}'))
  check(`${name}：不再常驻「5 分钟没人答」`, !source.includes('<span className="hint">5 分钟没人答'))
  check(`${name}：拒绝按钮上写明清超时`, source.includes('5 分钟没人答也按拒绝处理'))
}

// 含义行必须排在命令原文之前：先给结论（它要干什么），再给原文（它到底怎么写的）。
{
  const at = shell.indexOf('className="approval-meaning"')
  const args = shell.indexOf('className="approval-args"')
  check('插件壳：含义行在命令原文之前', at > 0 && args > at, `meaning@${String(at)} args@${String(args)}`)
}
{
  const at = legacy.indexOf('className="approval-meaning"')
  const args = legacy.indexOf('className="approval-args"')
  check('旧渲染层：含义行在命令原文之前', at > 0 && args > at, `meaning@${String(at)} args@${String(args)}`)
}

// 终端那张卡没有悬浮提示可躲，所以只收两样：风险标签与通用兜底理由；
// 含义行照加，三张卡的说法因此一致。
console.log('[2b] 终端卡片')
check('终端：画含义行', tui.includes('request.meaning === undefined ? null : <Text {...TEXT.body}>{request.meaning}</Text>'))
check('终端：低风险不挂标签', tui.includes("request.risk === 'low' ? null : ("))
check('终端：通用兜底理由不占行', tui.includes('!GENERIC_REASONS.has(request.reason)'))
check('终端：中高风险仍挂标签', tui.includes('（{risk.text}）'))

// 档位行是「设置的回声」：只该出现在悬浮提示里，不该再常驻一行。
check('插件壳：档位不再单独占一行', !shell.includes('<span className="approval-mode">'))
check('旧渲染层：档位不再单独占一行', !legacy.includes('<span className="approval-mode">'))

// 低风险徽章收掉之后，中高风险必须照旧画出来（别把整枚徽章一起删了）。
check('插件壳：中高风险仍画徽章', shell.includes('{risk.label}'))
check('旧渲染层：中高风险仍画徽章', legacy.includes('{risk.label}'))

// 命令原文带上完整悬浮提示：卡片那行会被省略号截断，全文得能看。
check('插件壳：命令原文有悬浮全文', shell.includes('title={request.argsSummary}'))
check('旧渲染层：命令原文有悬浮全文', legacy.includes('title={request.argsSummary}'))

// ── [3] 样式 ──────────────────────────────────────────────────────────────────

console.log('[3] 样式表')
for (const [name, css] of [
  ['插件壳', shellCss],
  ['旧渲染层', legacyCss],
]) {
  check(`${name}：有 .approval-meaning 规则`, /\.approval-meaning\s*\{/.test(css))
}

// ── 收尾 ──────────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.log(`\n${String(failures)} 项不通过`)
  process.exit(1)
}
console.log('\n全部通过')
