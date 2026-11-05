/**
 * 浮层锚定的纯逻辑：锚点名怎么造、两份样式怎么写。
 *
 * 真机那半由 `ui-anchor-e2e.mjs` 量（矩形、间距、打开当帧不隐藏）；这里钉的是「算出来的东西
 * 对不对」——名字必须能被 `anchor-name` 接受，样式必须带上下缘/左缘/翻向/最小宽度四条。
 *
 * 跑法：node scripts/ui-anchored-test.mjs
 *
 * @module dsc/scripts/ui-anchored-test
 */
import { anchorNameOf, anchoredStyles } from '../src/packages/ui-primitives/ui/anchored.ts'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
    return
  }
  fail += 1
  console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

console.log('[1] 锚点名')
{
  const name = anchorNameOf(':r7:')
  check('React 的 useId（带冒号）能被造出合法的自定义属性名', name === '--dsc-anchor-r7', name)
  check('不带冒号/点下划线（anchor-name 只认这些字符）', /^--[a-zA-Z0-9_-]+$/.test(name), name)
  check('不同的 useId 造出不同的名字', anchorNameOf(':r1:') !== anchorNameOf(':r2:'))
}

console.log('[2] 两份样式')
{
  const styles = anchoredStyles('--dsc-anchor-x', { gap: 4, width: 'anchor' })
  const anchorStyle = styles.anchor
  const panel = styles.panel
  check('锚点那边写的是 anchor-name', anchorStyle['anchorName'] === '--dsc-anchor-x', JSON.stringify(anchorStyle))
  check('浮层写 position-anchor 指回锚点', panel['positionAnchor'] === '--dsc-anchor-x', JSON.stringify(panel))
  check('贴下缘（anchor(bottom) + gap）', panel['top'] === 'calc(anchor(bottom) + 4px)', String(panel['top']))
  check('对齐左缘', panel['left'] === 'anchor(left)', String(panel['left']))
  check('放不下时翻上去', panel['positionTryFallbacks'] === 'flip-block', String(panel['positionTryFallbacks']))
  check('宽度不窄于锚点', panel['minWidth'] === 'anchor-size(width)', String(panel['minWidth']))

  const auto = anchoredStyles('--dsc-anchor-y', { gap: 6, width: 'auto' }).panel
  check('width=auto 时不写 min-width（浮层自己定宽）', auto['minWidth'] === undefined, String(auto['minWidth']))
  check('gap 跟着参数走', auto['top'] === 'calc(anchor(bottom) + 6px)', String(auto['top']))
}

console.log('')
console.log(fail === 0 ? `浮层锚定电池：${String(pass)} 条全过` : `浮层锚定电池：${String(pass)} 通过 / ${String(fail)} 失败`)
process.exit(fail === 0 ? 0 : 1)
