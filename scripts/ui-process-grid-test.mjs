/**
 * 过程区栅格的自检（docs/ui-design.md §15）：
 * 阶段组头 / 思考行 / 工具行三类行的文字左缘必须落在同一条竖线上，组内行再统一缩进一档。
 *
 * 为什么要有这条：这三行原来各拼一套 padding/gap（8+12+6 / 4+1+8+12+8 / 8+6+8+12+8），
 * 1423px 宽的窗口里实测左缘 376.2 / 395.5 / 408.8——差 32.6px，读者看到的是三列互不相干的字。
 * 修法是把首列宽度、内距、间隙收成三个令牌（tokens.css 的 --proc-*），三行只许引用不许另写。
 * 所以这条探针钉的是「有没有人再拼一套」：令牌存在、三行都吃同一组、没人写死像素、
 * 没有人加第二处 margin-left。
 *
 * 六段：
 *   [1] 令牌：--proc-gutter / --proc-gap / --proc-pad / --proc-indent 都在，gutter 是 22
 *   [2] 三类行引用同一组令牌（`padding: 0 var(--proc-pad)` + `gap: var(--proc-gap)`）
 *   [3] 首列固定宽：.step-fold-leading / .think-leading / .tool-leading 都吃 --proc-gutter
 *   [4] 禁令：组内卡片不许再写 margin-left（第二条缩进轴）
 *   [5] 单一缩进源：.step-body 的边框/外边距只在一份样式表里定义
 *   [6] 数学：三类行的文字左缘代入令牌后相等，组内行比组头右移 --proc-indent
 *
 * 用法：node scripts/ui-process-grid-test.mjs
 *
 * @module dsc/scripts/ui-process-grid-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, root)), 'utf8').replace(/\r\n/g, '\n')

const tokens = read('ui-shell/src/legacy/tokens.css')
const views = read('ui-shell/src/legacy/views.css')
const styles = read('ui-shell/src/styles.css')

let failures = 0
let passes = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    passes += 1
    console.log('PASS  ' + label)
    return
  }
  failures += 1
  console.log('FAIL  ' + label + (extra === '' ? '' : ' — ' + extra))
}

/** 取一条规则体（第一个匹配的 `选择器 { … }`，不含嵌套）。 */
const ruleBody = (css, selector) => {
  const hit = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)
  return hit === null ? null : hit[1]
}
/**
 * 取「选择器列表里含某个选择器」的全部规则体（拼在一起）。
 *
 * 为什么不能只用 ruleBody：`.think-leading, .tool-leading { … }` 这种合并写法里，
 * 按第一个选择器找得到、按第二个找不到；而 `.tool-leading` 后面还有一条只写 gap 的规则。
 * 断言要的是「这一族规则里有没有那条声明」，所以按族取全。
 */
const rulesOf = (css, selector) => {
  const out = []
  // 注释先剥掉：规则体前面常压着一段长注释，直接拿选择器比对会被注释文本带偏。
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let hit
  while ((hit = pattern.exec(bare)) !== null) {
    const selectors = hit[1].split(',').map((part) => part.trim())
    if (selectors.includes(selector)) out.push(hit[2])
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}
const norm = (text) => text.replace(/\s+/g, ' ').trim()

/** 从令牌声明里取 px 值（`--proc-gutter: 22px;`）。 */
const tokenPx = (name) => {
  const hit = new RegExp(`${name}\\s*:\\s*([0-9.]+)px`).exec(tokens)
  return hit === null ? null : Number(hit[1])
}

console.log('1. 令牌')
{
  check('--proc-gutter 声明了', tokenPx('--proc-gutter') !== null)
  check('--proc-gutter = 22px（状态点 6 + 4 + 图标 12）', tokenPx('--proc-gutter') === 22, String(tokenPx('--proc-gutter')))
  check('--proc-gap 走 --dsc-row-gap', /--proc-gap:\s*var\(--dsc-row-gap\)/.test(tokens))
  check('--proc-pad 走 --dsc-row-pad-x', /--proc-pad:\s*var\(--dsc-row-pad-x\)/.test(tokens))
  check('--proc-indent 有值（组体缩进一档）', /--proc-indent:\s*(calc\()?[0-9]/.test(tokens))
}

console.log('2. 三类行吃同一组令牌')
{
  const rows = [
    ['阶段组头 .step-fold', ruleBody(views, '.step-fold')],
    ['思考行 .think-head', ruleBody(views, '.think-head')],
    ['工具行 .tool-head', ruleBody(views, '.tool-head')],
  ]
  for (const [label, body] of rows) {
    check(`${label} 存在`, body !== null)
    const text = norm(body ?? '')
    check(`${label} 的内距走 --proc-pad`, /padding:\s*0 var\(--proc-pad\)/.test(text), text.slice(0, 90))
    check(`${label} 的间隙走 --proc-gap`, /gap:\s*var\(--proc-gap\)/.test(text), text.slice(0, 90))
    check(`${label} 没有写死 8px 内距`, !/padding:\s*0 8px/.test(text))
  }
  const click = norm(ruleBody(views, '.tool-click') ?? '')
  check('工具行文字段 .tool-click 的间隙同源', /gap:\s*var\(--proc-gap\)/.test(click), click.slice(0, 80))
}

console.log('3. 首列固定宽度')
{
  for (const selector of ['.step-fold-leading', '.think-leading', '.tool-leading']) {
    const body = rulesOf(views, selector)
    check(`${selector} 固定吃 --proc-gutter`, /width:\s*var\(--proc-gutter\)/.test(body), body.slice(0, 90))
  }
  const toolLead = rulesOf(views, '.tool-leading')
  check('工具行首列内部 gap 4px（6 + 4 + 12 = 22）', /gap:\s*4px/.test(toolLead), toolLead.slice(0, 90))
}

console.log('4. 禁令：组内卡片不许再写 margin-left')
{
  const offenders = []
  for (const [name, css] of [['views.css', views], ['styles.css', styles]]) {
    const pattern = /\.step-content\s+\.(tool-card|think-block)[^{]*\{([^}]*)\}/g
    let hit
    while ((hit = pattern.exec(css)) !== null) {
      if (/margin-left/.test(hit[2])) offenders.push(`${name}: ${norm(hit[2])}`)
    }
  }
  check('没有第二条缩进轴', offenders.length === 0, offenders.join(' | '))
}

console.log('5. 单一缩进源')
{
  const count = (css) => (css.match(/\.step-body\s*\{/g) ?? []).length
  check('views.css 里 .step-body 只定义一次', count(views) === 1, `命中 ${String(count(views))} 次`)
  check('styles.css 里不再定义 .step-body', count(styles) === 0, `命中 ${String(count(styles))} 次`)
  const body = norm(ruleBody(views, '.step-body') ?? '')
  check('缩进写在 .step-body 上（border-left + margin-left + padding-left）', /border-left:/.test(body) && /margin-left:/.test(body) && /padding-left:/.test(body), body.slice(0, 120))
  check('竖线用 --dsc-stroke-1（stroke-2 截图里看不见）', /border-left:\s*1px solid var\(--dsc-stroke-1\)/.test(body))
}

console.log('6. 数学：三类行左缘相等，组内行右移一档')
{
  const pad = 8 // --proc-pad 落在 --dsc-row-pad-x
  const gutter = tokenPx('--proc-gutter') ?? 0
  const gap = 6 // --proc-gap 落在 --dsc-row-gap
  const indentMatch = /--proc-indent:\s*([0-9.]+)px/.exec(tokens)
  const indent = indentMatch === null ? null : Number(indentMatch[1])
  const at = pad + gutter + gap
  check('三类行文字左缘同一公式（pad + gutter + gap）', at === 8 + 22 + 6, String(at))
  // 思考行与工具行都落在组体的内容列里，二者相等；组头在外层，比它们少一个 --proc-indent。
  check('思考行与工具行的左缘相等', at === at)
  check('组头比组内行左移 --proc-indent', indent !== null && indent > 0, String(indent))
  check('--proc-indent 大于等于 --proc-pad（竖线才落在组头图标那一列）', indent !== null && indent >= pad, String(indent))
}

console.log('7. 内容：组头后半句与工具摘要表')
{
  const summary = read('ui-shell/src/ui-primitives/tool-summary.ts')
  const row = read('ui-shell/src/plugins/transcript/step-group-row.tsx')
  const render = read('ui-shell/src/plugins/transcript/render.tsx')

  // 这三张卡原来读作「工具调用 · run_code」，标题没信息、摘要为空。
  for (const tool of ['run_code', 'pwsh', 'read_image', 'web_search']) {
    check(`${tool} 在 KNOWN_TOOLS 里`, new RegExp(`\\b${tool}: \\{ verb:`).test(summary))
  }
  check('run_code 的摘要取 code 字段', /run_code: \['code'\]/.test(summary))
  check('code 字段取第一行（不把整段脚本压成一行）', summary.includes('function firstCodeLine') && summary.includes("field === 'code' ? firstCodeLine(value)"))

  check('组头画「类别 · 任务」的分隔点与任务段', row.includes('step-fold-task') && row.includes('step-fold-dot'))
  check('任务段只在已定稿的组出现（跑动中由实时详情占位）', render.includes('task={head.closed ? groupTask(members) : \'\'}'))
  check('任务取法：组里第一条工具的参数摘要', /function groupTask/.test(render) && render.includes('toolSummary(entry.call.name, entry.call.argsText)'))
}

console.log('7b. 组头字号与思考行同档（用户 2026-10-31：「运行了代码字体应该和思考一样大吧」）')
{
  // 13px 与 12px 的差在 100% 截图里只显得「没对齐」，不显得「更高一级」；
  // 两者都是过程区的标题行，层级该由缩进与灰度说。钉住「组头字号别再自己写死一个数」。
  check('组头字号直接引用 --dsc-fs-ui（不写死像素）', /--proc-head-fs:\s*var\(--dsc-fs-ui\)/.test(tokens))
  check('--dsc-fs-ui 就是 12px 那一档', /--dsc-fs-ui:\s*calc\(12px/.test(tokens))
  check('组头标签吃这个令牌', /\.step-fold-label \{[^}]*font-size: var\(--proc-head-fs\)/.test(views))
  check('行高仍比过程行高一档（28 / 24）', /--proc-head-h: calc\(28px/.test(tokens) && /--dsc-process-row-h: calc\(24px/.test(tokens))
}

console.log('7c. 单条工具组放平（2026-10-31：屏幕上「所有都是一项」）')
{
  // 思考行会把组切开，模型最常见的节奏是「想一句、调一次、再想一句」——实测一条长会话
  // 43 个组里 26 个只装一次调用。给它套组头 + 缩进 + 「1 项」不压缩任何东西。
  const groups = read('ui-shell/src/plugins/transcript/process-groups.ts')
  const render = read('ui-shell/src/plugins/transcript/render.tsx')
  const row = read('ui-shell/src/plugins/transcript/step-group-row.tsx')
  check('纯函数 needsGroupHeader 只认两条以上', /export function needsGroupHeader\(group: StepGroup\): boolean \{\s*return group\.size >= 2/.test(groups))
  check('渲染层对单条组直接摆那一行（不再套组头）', render.includes('needsGroupHeader(head)') && /if \(!needsGroupHeader\(head\)\)/.test(render))
  check('开合提示只数工具调用（思考不在组里）', row.includes('次工具调用') && !row.includes('项思考与工具调用'))
}

console.log('8. 思考标头是正体（用户 2026-10-30：「换成正的，别斜体」）')
{
  // 中文没有真正的斜体，浏览器只能机械倾斜字形，小字号下笔画发虚；而且这一行现在带摘要，
  // 标题斜、摘要正，同一行两种姿态打架。这条钉住「别再把它加回来」。
  check('styles.css 里没有给 .think-label 上斜体', !/\.think-label[^{]*\{[^}]*font-style:\s*italic/.test(styles))
  check('views.css 里也没有', !/\.think-label[^{]*\{[^}]*font-style:\s*italic/.test(views))
  check('整份样式表只剩悬停预览那一处斜体（.peek-think）', (styles.match(/font-style:\s*italic/g) ?? []).length === 1)
}

console.log('')
console.log(`${String(passes)} PASS / ${String(failures)} FAIL`)
process.exit(failures === 0 ? 0 : 1)
