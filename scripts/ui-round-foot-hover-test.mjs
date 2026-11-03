/**
 * 「轮尾的用量与时刻也只在悬浮时出现」的静态探针（2026-11-03）。
 *
 * 报障原图：一轮回答下面常驻着「复制 · 分叉 · ~653 tok · 21:53」——两颗钮按 2026-11-02
 * 的改动已经会淡出了，可用量与时刻还杵在那里，一行行小字把长会话拖成噪音。
 *
 * 钉住四件事：
 *   [1] 用量（`.round-tokens`）、时刻（`.round-clock`）、分隔点（`.round-sep`）默认 opacity 0；
 *   [2] 鼠标进这一轮 / 焦点进这一轮时三者一起浮现（与两颗钮同一组选择器）；
 *   [3] 三个类名确实由组件画出来（不然样式写了也没东西可淡）；
 *   [4] 减少动效偏好下关掉过渡（不能为了好看让晕动用户难受）。
 *
 * 每条判据都配一条“弄脏副本必须红”。
 *
 * 跑法：node scripts/ui-round-foot-hover-test.mjs
 *
 * @module dsc/scripts/ui-round-foot-hover-test
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
    failures += 1
  }
}
const read = (part) => readFileSync(join(root, part), 'utf8')
const dirty = (hay, from, to) => hay.split(from).join(to)

const css = read('ui-shell/src/legacy/views.css')
const foot = read('ui-shell/src/plugins/transcript/rows/foot.tsx')

/**
 * 只看这一段的样式（视图里还有别的 `.round-foot` 规则，从全文里找第一个会认错）：
 * 起点锚在那段注释的「现在是两段合起来才现」。
 */
const tail = (() => {
  const at = css.indexOf('现在是两段合起来才现')
  return at < 0 ? '' : css.slice(at)
})()

/** 「默认隐藏」那一条规则（`opacity: 0` 所在块）。 */
const hiddenBlock = (s) => {
  const part = s.slice(css.indexOf('现在是两段合起来才现'))
  const at = part.indexOf('.round-foot .round-tokens,')
  return at < 0 ? '' : part.slice(at, at + 600)
}
/** 「浮现」那一组选择器（`:hover` 起，到 `opacity: 1` 那条规则为止）。 */
const revealBlock = (s) => {
  const part = s.slice(css.indexOf('现在是两段合起来才现'))
  const at = part.indexOf('.turn-seat > *:not(:first-child):hover ~ .round-foot .round-tokens')
  if (at < 0) return ''
  const end = part.indexOf('}', at)
  return end < 0 ? part.slice(at) : part.slice(at, end + 1)
}

// ── [1] 默认隐藏 ────────────────────────────────────────────────────────────────
const hidesAll = (s) => {
  const block = hiddenBlock(s)
  return (
    block.includes('.round-foot .round-tokens,') &&
    block.includes('.round-foot .round-sep,') &&
    block.includes('.round-foot .round-clock') &&
    block.includes('opacity: 0')
  )
}
check('[1] 用量 / 时刻 / 分隔点默认 opacity 0', hidesAll(css))
check('[1] 隐藏判据对脏副本必须红', !hidesAll(dirty(css, 'opacity: 0', 'opacity: 1')))

// ── [2] 悬浮 / 焦点时一起浮现 ───────────────────────────────────────────────────
const revealsAll = (s) => {
  const block = revealBlock(s)
  return (
    block.includes('.round-foot .round-tokens') &&
    block.includes('.round-foot .round-sep') &&
    block.includes('.round-foot .round-clock') &&
    block.includes(':focus-within > .round-foot .round-clock') &&
    block.includes('opacity: 1')
  )
}
check('[2] 鼠标进这一轮 / 焦点进来时三者一起浮现', revealsAll(css))
check('[2] 浮现判据对脏副本必须红', !revealsAll(dirty(css, ':focus-within > .round-foot .round-clock', ':focus-withinX > .round-foot .round-clock')))

// ── [3] 组件确实画了这三个类名 ──────────────────────────────────────────────────
const renders = (s) =>
  s.includes('className="round-tokens"') && s.includes('className="round-clock"') && s.includes('className="round-sep"')
check('[3] 组件画出了 round-tokens / round-clock / round-sep', renders(foot))
check('[3] 组件判据对脏副本必须红', !renders(dirty(foot, 'className="round-clock"', 'className="round-clockX"')))

// ── [4] 减少动效下关掉过渡 ──────────────────────────────────────────────────────
const reduced = (s) => {
  const part = s.slice(css.indexOf('现在是两段合起来才现'))
  const at = part.indexOf('@media (prefers-reduced-motion: reduce)')
  if (at < 0) return false
  const end = part.indexOf('}', at)
  const block = end < 0 ? part.slice(at) : part.slice(at, end + 1)
  return block.includes('.round-foot .round-tokens') && block.includes('.round-foot .round-clock') && block.includes('transition: none')
}
check('[4] 减少动效偏好下三者都不做过渡', reduced(css))
check('[4] 动效判据对脏副本必须红', !reduced(dirty(css, 'transition: none', 'transition: opacity 0.2s')))

console.log(failures === 0 ? '\nPASS 轮尾用量 / 时刻的悬浮浮现四条口径全过' : `\nFAIL ${failures} 条`)
process.exit(failures === 0 ? 0 : 1)
