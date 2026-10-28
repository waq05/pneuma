/**
 * 「工具行没有卡片外形」探针（2026-10-29）。
 *
 * 用户原话：一行工具调用就是「图标 + 工具名 + 摘要 + 行尾读数」，静息没有框、没有底色，
 * 鼠标移上去也不铺底色；能点开的只有文字那一段。整轮折叠与阶段组头的整合点保留，
 * 但悬停同样只提文字色。
 *
 * 这一条钉六件事（都按源码，不依赖浏览器）：
 *   [1] .tool-card 不再有边框 / 边框圆角 / 底色 / overflow 裁剪；
 *   [2] .tool-head / .think-head / .step-fold 的 :hover / :active 不再铺底色；
 *   [3] 点击与键盘处理挪进 .tool-click，行尾读数与药丸不参与展开；
 *   [4] 成功态（done）只留绿点，不再渲染「完成」两个字；
 *   [5] 过程行高令牌是 24px，三处过程行间距是 3px；
 *   [6] 对比度与缩进：摘要 secondary、未知名 tertiary、图标 12px、状态点 6px、
 *       组体内工具行与思考行再缩进 4px。
 *
 * 另做一条**正向**键盘断言：把 .tool-click 的 onKeyDown 函数体取出来真跑一遍，
 * Enter / Space 必须各触发一次 toggle 且 preventDefault，其他键不触发。
 *
 * 用法：node scripts/ui-tool-row-flat-test.mjs
 *
 * @module dsc/scripts/ui-tool-row-flat-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, root)), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const views = stripComments(read('ui-shell/src/legacy/views.css'))
const styles = stripComments(read('ui-shell/src/styles.css'))
const factory = read('ui-shell/src/plugins/transcript/tool-card/factory.tsx')

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

/** 取一个选择器的规则体（只看第一条，够用：这几个选择器都只有一条主规则）。 */
const rule = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(css)?.[1] ?? ''
}

console.log('[1] 卡片外形：没有边框、没有底色')

const card = rule(views, '.tool-card')
check('.tool-card 规则体存在', card !== '')
check('没有 border / border-left', !/\bborder(-left)?\s*:/.test(card), card.trim())
check('没有 border-radius', !/border-radius\s*:/.test(card), card.trim())
check('没有 background', !/background\s*:/.test(card), card.trim())
check('没有 overflow: hidden（吸住吸附栏）', !/overflow\s*:\s*hidden/.test(card), card.trim())
check(
  '状态不再用左边条表达（status-* 不写 border-left）',
  !/\.tool-card\.status-(running|done|failed|rejected)\s*\{[^}]*border-left\s*:/.test(views),
)
check('展开态仍有 overflow: visible 的兜底或卡片本身可见', /overflow\s*:\s*visible/.test(card) || !/overflow\s*:/.test(card))

console.log('[2] 悬停 / 按下不铺底色（三处过程行）')

const hoverNoBg = (selector) => {
  // 只查「选择器自己成一条规则」的写法；.tool-head:hover .verb 这种提色规则不算铺底。
  const body = rule(views, selector + ':hover')
  return body === '' || !/background\s*:/.test(body)
}
check('.tool-head:hover 只有文字色、没有背景', hoverNoBg('.tool-head'))
check('.tool-head:active 不存在铺底规则', rule(views, '.tool-head:active') === '')
check('.think-head:hover 没有背景', hoverNoBg('.think-head'))
check('.think-head:active 不存在铺底规则', rule(views, '.think-head:active') === '')
check('.step-fold:hover 没有背景', hoverNoBg('.step-fold'))
check('.step-fold:active 不存在铺底规则', rule(views, '.step-fold:active') === '')
check('工具行悬停提动词色', /\.tool-head:hover \.verb\s*\{[^}]*color: var\(--dsc-text-primary\)/.test(views))
check('工具行悬停提摘要色', /\.tool-head:hover \.preview\s*\{[^}]*color: var\(--dsc-text-primary\)/.test(views))
check('思考行悬停提标题色（原有）', /\.think-head:hover \.think-label\s*\{\s*color: var\(--dsc-text-secondary\)/.test(views))
check('组头悬停提标题色', /\.step-fold:hover \.step-fold-label\s*\{\s*color: var\(--dsc-text-primary\)/.test(views))
check(
  '截图钩子改提文字色（思考）',
  /\.shot-reveal \.think-head \.think-label[\s\S]{0,80}color: var\(--dsc-text-primary\)/.test(views),
)
check(
  '截图钩子改提文字色（组头）',
  /\.shot-reveal \.step-fold \.step-fold-label\s*\{[^}]*color: var\(--dsc-text-primary\)/.test(views),
)
check('截图钩子不再铺底色', !/\.shot-reveal \.(think-head|step-fold)\s*\{[^}]*background\s*:/.test(views))

console.log('[3] 点击与键盘只在 .tool-click 上')

const headOpen = /<div\s+className="tool-head"[\s\S]*?>/.exec(factory)?.[0] ?? ''
check('.tool-head 外壳不再挂 onClick', headOpen !== '' && !/onClick=/.test(headOpen), headOpen)
// 取到「行尾读数」那段注释之前：中间可能还有嵌套的 <span>（状态点），
// 用第一个 </span> 收口会只截到状态点，截不到整段。
const clickBlock = /<span\s+className=\{`tool-click[\s\S]*?\{tail !== null/.exec(factory)?.[0] ?? ''
check('.tool-click 文字段存在', clickBlock !== '')
check('.tool-click 挂 onClick', /onClick=\{expandable \? toggle : undefined\}/.test(clickBlock))
check('.tool-click 挂 role=button', /role=\{expandable \? 'button' : undefined\}/.test(clickBlock))
check('.tool-click 挂 tabIndex', /tabIndex=\{expandable \? 0 : -1\}/.test(clickBlock))
check('.tool-click 挂 aria-expanded', /'aria-expanded': bodyOpen/.test(clickBlock))
check('.tool-click 挂 onKeyDown', /onKeyDown=\{/.test(clickBlock))
check('文字段只包状态点 + 图标 + 动词 + 未知名 + 摘要', /className="tool-dot"/.test(clickBlock) && /<Icon size=\{12\} className="tool-icon" \/>/.test(clickBlock) && /className="verb"/.test(clickBlock) && /className="name"/.test(clickBlock) && /<Preview /.test(clickBlock))
check('行尾读数 / 状态词 / 药丸 / 箭头留在文字段外', !/tc-more|StatusDetail|Trailing|tc-chevron/.test(clickBlock))
check('路径按钮自己的 stopPropagation 还在', /onClick=\{\(event\) => \{\s*event\.stopPropagation\(\)/.test(factory))

// 正向键盘断言：把 onKeyDown 的函数体取出来真跑。
const keyBody = /onKeyDown=\{\(event\) => \{([\s\S]*?)\n\s*\}\}/.exec(clickBlock)?.[1] ?? ''
check('键盘处理函数体取到了', keyBody !== '')
if (keyBody !== '') {
  // eslint-disable-next-line no-new-func
  const handler = new Function('event', 'toggle', keyBody)
  for (const [key, expected] of [['Enter', 1], [' ', 1], ['a', 0]]) {
    let toggles = 0
    let prevented = 0
    handler({ key, preventDefault: () => { prevented += 1 } }, () => { toggles += 1 })
    check(
      `键盘 ${key === ' ' ? 'Space' : key} → toggle ${String(expected)} 次且 preventDefault ${String(expected)} 次`,
      toggles === expected && prevented === expected,
      'toggles=' + String(toggles) + ' prevented=' + String(prevented),
    )
  }
}

console.log('[4] 成功态只留绿点')

check('done 不输出状态词（空串）', /call\.status === 'done' \? '' : \(TOOL_STATUS_TEXT/.test(factory))
check('done 也不拼「用时」（那是跑动中的读数）', /duration === null \|\| call\.status === 'done' \? '' :/.test(factory))
check('失败 / 被拒 / 进行中 / 准备中照旧走状态词表', /TOOL_STATUS_TEXT\[call\.status\]/.test(factory))

console.log('[5] 行高与行距')

check('过程行高令牌是 24px（密度倍率保留）', /--dsc-process-row-h: calc\(24px \* var\(--dsc-density\)\)/.test(styles))
check(
  '座位内 --dsc-stack-gap 覆写成 3px',
  /\.turn-seat \{[\s\S]{0,160}--dsc-stack-gap: calc\(3px \* var\(--dsc-density\)\)/.test(views),
)
check('.turn-seat 的 gap 是 3px', /\.turn-seat \{[\s\S]{0,220}gap: calc\(3px \* var\(--dsc-density\)\)/.test(views))
check('.turn-process-body 的 gap 是 3px', /\.turn-process-body \{[\s\S]{0,160}gap: calc\(3px \* var\(--dsc-density\)\)/.test(views))
check('.step-content 的 gap 是 3px', /\.step-content \{[\s\S]{0,120}gap: calc\(3px \* var\(--dsc-density\)\)/.test(views))
check('工具头左右内距仍是 8px', rule(views, '.tool-head').includes('padding: 0 8px'))

console.log('[6] 对比度、尺寸与缩进分级')

check('摘要是 secondary', /\.tool-head \.preview \{[^}]*color: var\(--dsc-text-secondary\)/.test(views))
check('未知名是 tertiary', /\.tool-head \.name \{[^}]*color: var\(--dsc-text-tertiary\)/.test(views))
check('图标 12px', /\.tool-head \.tool-icon \{[^}]*height: 12px;[^}]*width: 12px;/.test(styles))
check('状态点 6px', /\.tool-dot \{[^}]*height: 6px;[^}]*width: 6px;/.test(styles))
check('四种状态点配色仍齐全', ['running', 'done', 'failed', 'rejected'].every((status) => new RegExp('\\.tool-card\\.status-' + status + ' \\.tool-dot \\{[^}]*background:').test(styles)))
check('组体竖线仍是 1px、13px 缩进没加粗', /\.step-body \{[^}]*border-left: 1px solid[^}]*margin-left: 3px;[^}]*padding-left: 9px;/.test(styles))
check('组体内工具行再缩进 4px', /\.step-content \.tool-card,?\s*\n?\.step-content \.think-block \{\s*margin-left: 4px;/.test(styles))
check('焦点圈挪到文字段', /\.tool-card \.tool-click:focus-visible \{[^}]*box-shadow: inset/.test(views))

console.log('')
console.log(`通过 ${String(passes)}/${String(passes + failures)}`)
process.exit(failures === 0 ? 0 : 1)
