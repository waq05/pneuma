/**
 * 会话区底部占位的探针（视口四阶段 ①，2026-11-10）：只验「元素与口径」备好了，
 * 不验协调器（第③阶段才写它的高度）。
 *
 * 为什么钉源码而不是 import：占位是 JSX 元素、贴底口径藏在 `follow.ts` 的闭包里，
 * Node 里既渲不出 React 树也拿不到 `scrollHeight`。这里用文本钉守住四件事：
 *
 *   [1] 元素在哪：`ui-layout` 的 `app.tsx` 里，`.chat` 的**最后一个子元素**、`.chat-inner` **之后**。
 *       为什么不能写进 transcript 的 `ui.tsx`：那整段经 `shell.main` 槽渲在 `.chat-inner` 里面，
 *       写进去必然变成 `.chat-inner` 的 flex 子项——多吃一格 `--dsc-turn-gap`，而且
 *       `follow.ts` 观察的是 `scroller.firstElementChild`（正是 `.chat-inner`），
 *       占位改高度会被当成「内容增长」，被自己的 `onResize` 抵消。
 *   [2] 反向钉：`ui.tsx` 里**不许**出现 `data-chat-turn-spacer`。这条守的正是
 *       「占位不在 `.chat-inner` 子树里」——比数 `.chat` 的子元素个数稳：
 *       数个数会被新加的任何兄弟节点弄红，而「transcript 渲染的一切都在列内」是结构事实。
 *   [3] 口径：`follow.ts` 的 `floor()` 从 `scrollHeight` 里减掉了占位高度（读数 + 相减都在源码里），
 *       `pin()` 写的是 `floor()`，而贴底判定仍是 24px（它比「离 floor 多远」，不是离 `scrollHeight`）。
 *   [4] 样式：`views.css` 有 `.turn-spacer`，`flex: 0 0 auto` 与 `height: 0` 双在（默认恒 0 高）。
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-turn-spacer-test.mjs
 *
 * @module dsc/scripts/ui-turn-spacer-test
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

let passed = 0
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

const APP = 'src/packages/ui-layout/ui/app.tsx'
const FOLLOW = 'src/packages/ui-transcript/ui/follow.ts'
const UI = 'src/packages/ui-transcript/ui/ui.tsx'
const CSS = 'src/packages/ui-renderer/ui/styles/legacy/views.css'

const appSrc = read(APP)
const followSrc = read(FOLLOW)
const uiSrc = read(UI)
const css = read(CSS)

/**
 * 从 `openIndex`（一个 `<div` 的起点）往后数 div 的配对，返回 `</div>` 之后的下标。
 * 只认字面标签：这一段的注释里没有 `<div`，不会干扰配对。
 */
const divBlockEnd = (src, openIndex) => {
  // 自闭合的 `<div … />`（占位就是）不开新层；普通 `<div …>` 进一层，`</div>` 退一层。
  const tag = /<div\b[^>]*>|<\/div>/g
  tag.lastIndex = openIndex
  let depth = 0
  let match
  while ((match = tag.exec(src)) !== null) {
    if (match[0] === '</div>') {
      depth -= 1
      if (depth === 0) return match.index + match[0].length
    } else if (match[0].endsWith('/>')) {
      if (depth === 0) return match.index + match[0].length
    } else {
      depth += 1
    }
  }
  return -1
}

// ── [1] 元素位置：.chat 的最后一个子元素，在 .chat-inner 之后 ───────────────────
console.log('[1] 占位挂在 .chat 里、.chat-inner 之后')
{
  const chatOpen = appSrc.indexOf('<div className="chat">')
  const appHasSpacer = appSrc.includes('data-chat-turn-spacer')
  check(`${APP} 里有 data-chat-turn-spacer`, appHasSpacer)
  check('app.tsx 里有 .chat 容器', chatOpen >= 0)

  const chatClose = chatOpen < 0 ? -1 : divBlockEnd(appSrc, chatOpen)
  const innerOpen = appSrc.indexOf('<div className="chat-inner">')
  const innerClose = innerOpen < 0 ? -1 : divBlockEnd(appSrc, innerOpen)
  check('app.tsx 里有 .chat-inner 容器', innerOpen >= 0 && innerClose > innerOpen)

  // 占位的起始 <div>：从 data 属性往前找同一个标签的开头。
  const spacerAttr = appSrc.indexOf('data-chat-turn-spacer')
  const spacerOpen = spacerAttr < 0 ? -1 : appSrc.lastIndexOf('<div', spacerAttr)
  check('占位是一个 div', spacerOpen >= 0 && spacerAttr > spacerOpen)
  check('占位是自闭合标签（没有子节点）', appSrc.slice(spacerAttr, spacerAttr + 80).includes('/>'))
  check('占位带 aria-hidden="true"', /data-chat-turn-spacer=""\s+aria-hidden="true"/.test(appSrc))

  check(
    '占位在 .chat-inner **之后**（下标比较）',
    innerClose > 0 && spacerOpen > innerClose,
    `chat-inner 收尾 ${innerClose}，占位 ${spacerOpen}`,
  )
  check(
    '占位在 .chat 内部',
    chatOpen >= 0 && chatClose > 0 && spacerOpen > chatOpen && spacerOpen < chatClose,
    `.chat ${chatOpen}..${chatClose}，占位 ${spacerOpen}`,
  )

  // 「最后一个子元素」：列收尾到占位之间、占位收尾到 .chat 收尾之间都不能再有元素。
  const trailing = (from, to) => srcSliceWithoutComments(appSrc.slice(from, to))
  check(
    '.chat-inner 收尾与占位之间没有别的元素',
    innerClose > 0 && spacerOpen >= 0 && trailing(innerClose, spacerOpen).trim() === '',
    trailing(innerClose, spacerOpen).trim().slice(0, 60),
  )
  const spacerClose = spacerAttr < 0 ? -1 : appSrc.indexOf('/>', spacerAttr) + 2
  check(
    '占位之后到 .chat 收尾之间没有别的元素（它确实是最后一个）',
    spacerClose > 0 && chatClose > 0 && trailing(spacerClose, chatClose - '</div>'.length).trim() === '',
    trailing(spacerClose, chatClose - '</div>'.length).trim().slice(0, 60),
  )
}

// ── [2] 反向钉：占位不在 .chat-inner 的子树里（transcript 的一切都在列内）────────
console.log('[2] 反向钉：transcript 的 ui.tsx 里没有占位')
{
  check(
    `${UI} 里没有 data-chat-turn-spacer（渲染进去就落在 .chat-inner 内）`,
    !uiSrc.includes('data-chat-turn-spacer'),
  )
  check('ui.tsx 里也没有 .turn-spacer 类名', !uiSrc.includes('turn-spacer'))
}

// ── [3] 贴底口径：floor() 减占位，pin() 写 floor() ──────────────────────────────
console.log('[3] follow.ts 的 floor() 减掉占位高度')
{
  check('follow.ts 读占位元素', followSrc.includes("[data-chat-turn-spacer]"))
  check('follow.ts 读的是元素实际高度（offsetHeight）', followSrc.includes('.offsetHeight'))
  check('取不到占位时按 0 算', /spacer\?\.offsetHeight \?\? 0/.test(followSrc))
  check(
    'floor() 里 scrollHeight 减 spacerHeight 再减 clientHeight',
    /scrollHeight\s*-\s*spacerHeight\(scroller\)\s*-\s*scroller\.clientHeight/.test(followSrc),
  )
  check('pin() 写的是 floor()', /scroller\.scrollTop\s*=\s*floor\(\)/.test(followSrc))
  check('pin() 不再直接写 scrollHeight', !/scroller\.scrollTop\s*=\s*scroller\.scrollHeight/.test(followSrc))
  check('贴底判定仍是 24px', /FOLLOW_BOTTOM_PX\s*=\s*24\b/.test(followSrc))
  check(
    '贴底判定比的是 floor() 到 scrollTop 的距离（没改成离 scrollHeight）',
    /floor\(\)\s*-\s*(scroller\.scrollTop|top)\s*<=\s*FOLLOW_BOTTOM_PX/.test(followSrc),
  )
}

// ── [4] 样式：默认恒 0 高、不参与伸缩 ───────────────────────────────────────────
console.log('[4] views.css 的 .turn-spacer')
{
  const block = css.match(/\.turn-spacer\s*\{([^}]*)\}/)
  check('views.css 有 .turn-spacer 规则', block !== null)
  const body = block === null ? '' : block[1]
  check('.turn-spacer 不参与伸缩（flex: 0 0 auto）', /flex:\s*0 0 auto/.test(body))
  check('.turn-spacer 默认高度为 0', /height:\s*0(px)?\s*;/.test(body))
  check(
    '注释说明了高度由协调器写内联样式',
    /高度由/.test(css.slice(Math.max(0, css.indexOf('.turn-spacer') - 600), css.indexOf('.turn-spacer'))),
  )
}

/**
 * 去掉 JSX 注释（`{/* … *}{@link …}`）与空白，只留元素文本；
 * 用途是判断两段元素之间有没有夹着别的节点。
 */
function srcSliceWithoutComments(text) {
  return text.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
}

console.log(`\n[ui-turn-spacer] 断言 ${String(passed + failures)} 条，通过 ${String(passed)} 条，失败 ${String(failures)} 条`)
process.exit(failures === 0 ? 0 : 1)
