/**
 * 选区浮层的动作是一条槽（差距清单 S9：把「选中文字后的浮层动作」从写死改成可插）。
 *
 * 改之前：`SelectionBubble` 自己画一颗 `<button className="ask-sel-btn">`，点它就 `openAsk`。
 * 想在这颗浮层上再挂一个动作（解释、搜索、复制成引用……）只能改浮层源码。
 * 改之后：浮层渲染一条 list 槽 `ask.selection.action`，内置那一颗「问 AI」也登记在链上，
 * 插件按 order 往里挂动作即可。
 *
 * 四段（源码钉为主：这条槽是契约，形状变了要在这里当场红）：
 *   [1] 槽声明：`declare module '@dsc/ui'` 里 `kind: 'list'`，owner 交 `text` 与 `close`；
 *       声明方式只挑一种（靠 `shell.header` 登记的 children 声明，不另调 `slots.declare`）。
 *   [2] 登记：`shell.header` 那条的 `children` 里有它，内置动作挂在链上（id / order / priority）。
 *   [3] 浮层渲染：`renderSlot('ask.selection.action', { text, close })`，且**有**
 *       `renderSlot === undefined` 的兜底（反向钉：不许只剩一句 renderSlot 调用）。
 *   [4] 样式：定位从按钮挪到 `.ask-sel-actions` 容器（按钮那条规则里不再有 position）。
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-ask-selection-slot-test.mjs
 *
 * @module dsc/scripts/ui-ask-selection-slot-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

const ask = read('src/packages/ui-ask/ui/ui.tsx')
const styles = read('src/packages/ui-renderer/ui/styles/styles.css')

// 「不该出现」的断言先剥注释：注释里就引着旧写法与槽名，不剥会自己打脸。
const askCode = ask.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const stylesCode = styles.replace(/\/\*[\s\S]*?\*\//g, '')

console.log('[1] 槽声明：ask.selection.action 是一条 list 槽，owner 交原文与关掉浮层的回调')
{
  check(
    '槽名是字面量常量 ask.selection.action（注册、声明、渲染三处同源）',
    askCode.includes("const SELECTION_ACTION_SLOT = 'ask.selection.action'"),
  )
  check(
    '并进 @dsc/ui 的 SlotMap（与 transcript 的子槽同一写法）',
    /declare module '@dsc\/ui' \{\s*\n\s*interface SlotMap \{/.test(askCode),
  )
  check(
    '形态是 list（一排动作，不是单格遮蔽）',
    /\[SELECTION_ACTION_SLOT\]: \{\s*\n\s*kind: 'list'/.test(askCode),
  )
  check(
    'owner 里有 text: string',
    /\[SELECTION_ACTION_SLOT\]: \{[\s\S]{0,160}?owner: \{ text: string;/.test(askCode),
  )
  check(
    'owner 里有 close: () => void（动作自己决定点完关不关）',
    /\[SELECTION_ACTION_SLOT\]: \{[\s\S]{0,200}?close: \(\) => void \}/.test(askCode),
  )
  // 声明只走一条路：children 自动声明（本仓既有写法）；再调一次 declare 就是两份真相。
  check(
    '不另调 ui.slots.declare 声明它（声明归 shell.header 那条登记的 children）',
    !/ui\.slots\.declare\(\s*(?:SELECTION_ACTION_SLOT|'ask\.selection\.action')/.test(askCode),
  )
}

console.log('[2] 登记：header 那条开出子槽，内置那一颗挂在链上')
{
  check(
    'AskTriggers 的 props 用 SlotComponentProps 声明子槽额度',
    askCode.includes("SlotComponentProps<Record<never, never>, 'ask.selection.action'>"),
  )
  check(
    'shell.header 那条登记带 children: { [SELECTION_ACTION_SLOT]: list }',
    /ui\.slots\.register\(\s*\n?\s*'shell\.header',\s*\n?\s*\{[\s\S]{0,220}?children: \{ \[SELECTION_ACTION_SLOT\]: 'list' \}/.test(askCode),
  )
  check(
    'header 那条登记还是 ask.triggers / order 80（位置没被顺手改掉）',
    /'shell\.header',\s*\n?\s*\{\s*\n?\s*id: 'ask\.triggers',\s*\n?\s*order: 80,/.test(askCode),
  )
  check(
    '内置动作用 ask.selection.builtin / order 0 / priority 100 登记在链上',
    /ui\.slots\.register\(\s*\n?\s*SELECTION_ACTION_SLOT,\s*\n?\s*\{ id: 'ask\.selection\.builtin', order: 0, priority: 100 \},\s*\n?\s*AskSelectionAction,/.test(askCode),
  )
  check(
    '内置动作组件就是 AskSelectionAction（不是就地画一颗匿名按钮）',
    /export function AskSelectionAction\(\{ text, close \}: \{ text: string; close: \(\) => void \}\)/.test(askCode),
  )
  check(
    '它点完开旁问并关掉浮层（openAsk(text) + close()）',
    /export function AskSelectionAction[\s\S]{0,700}?openAsk\(text\)[\s\S]{0,80}?close\(\)/.test(askCode),
  )
  check(
    '按钮的类名与文案照旧（.ask-sel-btn / t(ask.selectionBubble)）',
    /export function AskSelectionAction[\s\S]{0,700}?className="ask-sel-btn"[\s\S]{0,400}?t\('ask\.selectionBubble'\)/.test(askCode),
  )
  check(
    '按下时拦掉浏览器撤选区（onMouseDown + preventDefault）',
    /export function AskSelectionAction[\s\S]{0,900}?onMouseDown=\{\(event\) => \{\s*\n?\s*event\.preventDefault\(\)/.test(askCode),
  )
}

console.log('[3] 浮层：渲染那条链，且留着「没有槽上下文」的兜底')
{
  check(
    'SelectionBubble 收 renderSlot prop（由 AskTriggers 一路传下来）',
    /function SelectionBubble\(\{\s*\n?\s*renderSlot,?\s*\n?\s*\}?:?[\s\S]{0,200}?renderSlot\?: SlotRenderApi<'ask\.selection\.action'>\['renderSlot'\]/.test(askCode),
  )
  check(
    'AskTriggers 把 renderSlot 交给浮层（<SelectionBubble renderSlot={renderSlot} />）',
    askCode.includes('<SelectionBubble renderSlot={renderSlot} />'),
  )
  check(
    '浮层调 renderSlot(ask.selection.action, { text, close })',
    /renderSlot\('ask\.selection\.action', \{ text: pick\.text, close \}\)/.test(askCode),
  )
  // 反向钉：只剩 renderSlot 调用时，槽装配坏了就一颗按钮都没有——用户连「问 AI」都没了。
  check(
    '有 renderSlot === undefined 的兜底分支（反向钉：不许只剩 renderSlot 调用）',
    /renderSlot === undefined \?/.test(askCode),
  )
  check(
    '兜底里画的就是内置那一颗（AskSelectionAction + 选中的原文 + close）',
    /renderSlot === undefined \?[\s\S]{0,400}?<AskSelectionAction text=\{pick\.text\} close=\{close\} \/>/.test(askCode),
  )
  check(
    '浮层关掉自己的回调只有一个出处（close 里 setPick(null)）',
    /const close = \(\): void => \{\s*\n?\s*setPick\(null\)/.test(askCode),
  )
  check(
    '点浮层里任一颗动作都不触发「重新读选区」（判 .ask-sel-actions 而不是某一颗按钮）',
    askCode.includes("event.target.closest('.ask-sel-actions') !== null"),
  )
}

console.log('[4] 样式：定位在容器上，按钮只做行内药丸')
{
  const actionsRule = /\.ask-sel-actions \{([^}]*)\}/.exec(stylesCode)
  const buttonRule = /\.ask-sel-btn \{([^}]*)\}/.exec(stylesCode)
  check('.ask-sel-actions 有一条规则', actionsRule !== null)
  check(
    '.ask-sel-actions 是 position: absolute（一排共用一个锚点）',
    actionsRule !== null && /position: absolute;/.test(actionsRule[1]),
  )
  check('.ask-sel-actions 是 flex + gap（多颗排一行）', actionsRule !== null && /display: flex;/.test(actionsRule[1]) && /gap: var\(--dsc-/.test(actionsRule[1]))
  check(
    '.ask-sel-actions 的层级照抄原按钮那一档（--dsc-z-menu）',
    actionsRule !== null && /z-index: var\(--dsc-z-menu\);/.test(actionsRule[1]),
  )
  check('.ask-sel-btn 那条规则还在（长相等没动）', buttonRule !== null && /border-radius: var\(--dsc-r-pill\);/.test(buttonRule[1]))
  check(
    '.ask-sel-btn 里不再有定位（position 整条交给容器）',
    buttonRule !== null && !/position:/.test(buttonRule[1]),
    buttonRule === null ? '没找到 .ask-sel-btn 规则' : buttonRule[1].replace(/\s+/g, ' ').slice(0, 160),
  )
  check(
    '.ask-sel-btn 里也不再自带 z-index（同一档只出现在容器上）',
    buttonRule !== null && !/z-index:/.test(buttonRule[1]),
  )
  check(
    '颜色 / 圆角 / 阴影 / 字号仍走 --dsc-* 令牌（没有写死色值）',
    buttonRule !== null && !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(buttonRule[1]) && /background: var\(--dsc-bg-popover\)/.test(buttonRule[1]),
  )
}

console.log('[5] 注释留档：为什么内置那一颗也要登记到链上')
{
  check(
    'AskSelectionAction 的注释写明「为什么它也要登记到槽上」',
    /\/\*\*[\s\S]{0,600}?为什么它也要登记到[\s\S]{0,500}?order/.test(ask),
  )
  check(
    'apply 里的注释写明「内置那一颗也走同一条链」（排序统一）',
    /内置那一颗「问 AI」也走同一条链[\s\S]{0,400}?order/.test(ask),
  )
  check(
    '兜底分支的理由也留了档（插件没装好时不至于连问 AI 都没了）',
    ask.includes('连问 AI 都没了') || ask.includes('至少留住内置那一颗'),
  )
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
