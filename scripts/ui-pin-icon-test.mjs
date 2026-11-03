/**
 * 「置顶图钉画对了」的静态探针（2026-11-03）。
 *
 * 报障原话：「置顶图标需要优化一下，现在太丑」。原图是 45° 斜拼的三段线，缩到
 * 13px 糊成一个小哑铃，谁看都认不出是图钉。
 *
 * 钉住五件事：
 *   [1] 图形是竖向推钉（顶帽 + 钉身 + 针），旧版那三段斜线不再出现；
 *   [2] 钉身能填实（`filled`），已置顶那枚靠形状区分，不只靠颜色；
 *   [3] 会话行确实把 `pinned` 传给了图钉，并且放大到 14px；
 *   [4] 置顶态仍是黄色、图标按块级对齐，悬浮时有淡底（这一格能点）；
 *   [5] 没置顶时仍然平时隐形、悬浮才浮出（别把安静的行首弄脏）。
 *
 * 每条判据都配一条「弄脏副本必须红」。
 *
 * 跑法：node scripts/ui-pin-icon-test.mjs
 *
 * @module dsc/scripts/ui-pin-icon-test
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

const icons = read('ui-shell/src/ui-primitives/icons.tsx')
const sessionsUi = read('ui-shell/src/plugins/sessions/ui.tsx')
const css = read('ui-shell/src/legacy/views.css')

/** 只看 `IconPin` 那一段（同一文件里还有几十个图标，全文找会认错）。 */
const pinSource = (src) => {
  const start = src.indexOf('export function IconPin')
  const end = src.indexOf('export function IconTerminal')
  return start < 0 || end < start ? '' : src.slice(start, end)
}

/** [1] 竖向推钉的三段几何。 */
const isVertical = (src) => {
  const body = pinSource(src)
  return body.includes('M9 3h6') && body.includes('M12 12.3v6.3') && !body.includes('20.4 9.8')
}
check('[1] 图钉是竖向推钉（顶帽 + 钉身 + 针）', isVertical(icons))
check('[1] 弄脏副本会红', !isVertical(dirty(icons, 'M9 3h6', 'M14.2 3.6 20.4 9.8')))

/** [2] 钉身可填实。 */
const hasFilled = (src) => {
  const body = pinSource(src)
  return body.includes('filled?: boolean') && body.includes("fill={filled ? 'currentColor' : 'none'}")
}
check('[2] 已置顶时钉身填实', hasFilled(icons))
check('[2] 弄脏副本会红', !hasFilled(dirty(icons, "fill={filled ? 'currentColor' : 'none'}", 'fill="none"')))

/** [3] 会话行把置顶状态传下去，尺寸 14。 */
const rowWiring = (src) => src.includes('<IconPin size={14} filled={pinned} />')
check('[3] 会话行传入 filled={pinned} 且尺寸 14', rowWiring(sessionsUi))
check('[3] 弄脏副本会红', !rowWiring(dirty(sessionsUi, 'filled={pinned}', '')))

/** [4] 置顶色与悬浮淡底。 */
const pinnedStyle = (src) =>
  src.includes('.sess-item .lead-pin.pinned {') &&
  src.includes('color: var(--dsc-yellow);') &&
  src.includes('.sess-item .lead-pin > svg {') &&
  src.includes('display: block;') &&
  src.includes('color-mix(in srgb, var(--dsc-yellow) 18%, transparent)')
check('[4] 置顶黄色、图标块级、悬浮有同色淡底', pinnedStyle(css))
check('[4] 弄脏副本会红', !pinnedStyle(dirty(css, 'display: block;', 'display: inline;')))

/** [5] 没置顶时还是平时隐形。 */
const quietWhenIdle = (src) =>
  /\.sess-item \.lead-pin \{[\s\S]*?opacity: 0;/.test(src) &&
  src.includes('.sess-item .lead-pin.pinned {')
check('[5] 未置顶时平时隐形、置顶常显', quietWhenIdle(css))
check('[5] 弄脏副本会红', !quietWhenIdle(dirty(css, 'opacity: 0;', 'opacity: 1;')))

console.log('')
if (failures > 0) {
  console.log(`FAIL 共 ${failures} 条`)
  process.exitCode = 1
} else {
  console.log('PASS 图钉五项全过')
}
