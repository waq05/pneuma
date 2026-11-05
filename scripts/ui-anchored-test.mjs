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
import { readFileSync } from 'node:fs'
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

console.log('[3] 悬停卡的两条定位路（源码钉）')
{
  const source = readFileSync(new URL('../src/packages/ui-transcript/ui/rows/changes-card.tsx', import.meta.url), 'utf8')
  const hoverDelay = readFileSync(new URL('../src/packages/ui-primitives/ui/hover-delay.ts', import.meta.url), 'utf8')
  check('支持锚点时写 position-anchor', source.includes("['positionAnchor' as keyof CSSProperties]"))
  check('贴锚点上方 6px（bottom 量距底边，所以要 +6）', source.includes('calc(anchor(top) + 6px)'))
  check('上方放不下自动翻到下方（flip-block）', source.includes("positionTryFallbacks: 'flip-block'"))
  check('左缘按锚点算再夹进视口（clamp + anchor(left)）', source.includes('clamp(8px, calc(anchor(left) - 24px)'))
  check('行元素挂 anchor-name（悬停的那一行才是锚点）', source.includes("['anchorName' as keyof CSSProperties]"))
  check(
    '不支持锚点时保留「量 rect 上下二选一」的回退',
    source.includes('anchor.top - 12 >= maxHeight'),
    '回退分支被删了：老浏览器上预览卡会没位置',
  )
  check('锚点名从悬停状态传给浮层（anchorName 字段在）', hoverDelay.includes('anchorName?: string'))
  check('arm() 能带上锚点名（第四参）', hoverDelay.includes('anchorName?: string) => void'))
}

console.log('')
console.log(fail === 0 ? `浮层锚定电池：${String(pass)} 条全过` : `浮层锚定电池：${String(pass)} 通过 / ${String(fail)} 失败`)
process.exit(fail === 0 ? 0 : 1)
