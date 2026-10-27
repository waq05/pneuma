/**
 * 设置 → 用量统计在窄窗口里的两处硬伤（2026-10-27 报障第 3、4 条）。
 *
 *   3. 模型用量环形图左边被切：`.donut-row` 是居中 flex，180 + 28 + 240 = 448px 塞进 323px 卡片，
 *      溢出平均摊到两边，环的左缘量到 -31px。
 *   4. 热力图不自己横向滚：一年 53 列 × 13px = 686px，横向溢出算在祖先链上，把整个设置页撑到
 *      scrollWidth 731 / clientWidth 385，于是整页能左右拖、热力图被卡片右缘切掉。
 *
 * 这一份钉住「谁溢出谁自己滚」的接线与样式，外加四档时间窗（今天 / 近 7 天 / 近 30 天 / 近一年）。
 * 桌面回退渲染层（desktop/src/renderer/UsagePanel.tsx）同一份图同一套修，一起钉。
 *
 * 用法：node scripts/ui-usage-layout-test.mjs（只读源码，不需要先编译）
 *
 * @module dsc/scripts/ui-usage-layout-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(new URL(rel, `file://${root.replace(/\\/g, '/')}/`), 'utf8')
/** 热力图的纯布局（拆出来就能直接跑，不必把 React 文件拖进 Node）。 */
const { buildCells, CELL, GAP } = await import(new URL('../ui-shell/src/plugins/settings/heatmap.ts', import.meta.url).href)

let passed = 0
let failures = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

/**
 * 列出某个选择器的**全部**规则体（`.donut-row` 有两处：legacy 的并排那条与末尾的换行那条）。
 *
 * 为什么先剥注释：注释里写一个类名不该算「有这条规则」（负向自证就喂这坨坏输入）。
 * 为什么要全部：后写的赢，但同一选择器在媒体查询里还有第二份——只取一条就会漏判。
 */
function ruleBodies(css, selector) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const bodies = []
  let from = 0
  for (;;) {
    const index = clean.indexOf(selector + ' {', from)
    if (index < 0) break
    const open = clean.indexOf('{', index)
    const close = clean.indexOf('}', open)
    if (close < 0) break
    bodies.push(clean.slice(open + 1, close))
    from = close
  }
  return bodies
}

/** 这个选择器有没有某条规则带上某个属性（同一选择器多处规则，任意一处带上即算）。 */
function hasStyle(css, selector, pattern) {
  return ruleBodies(css, selector).some((body) => pattern.test(body))
}

console.log('\n[1] 热力图：自己横向滚 + 四档时间窗')
{
  const usage = read('ui-shell/src/plugins/settings/usage.tsx')
  const heatmap = read('ui-shell/src/plugins/settings/heatmap.ts')
  check('一格宽度只写一份（CELL / GAP 常量）', heatmap.includes('const CELL = 10') && heatmap.includes('const GAP = 3') && usage.includes("from './heatmap'"), '')
  check(
    '窗口长度是参数（buildCells 收 windowDays，不再钉死 52 周）',
    /export function buildCells\(\s*days: UsageDayView\[\],\s*windowDays: number,?\s*\)/.test(heatmap) &&
      heatmap.includes('windowDays - 1') &&
      !heatmap.includes('52 * 7 * 86400000'),
  )
  check(
    '四档：今天 / 近 7 天 / 近 30 天 / 近一年',
    usage.includes('type HeatRange = 1 | 7 | 30 | 364') &&
      usage.includes('[1, 7, 30, 364] as HeatRange[]') &&
      usage.includes("'今天'") && usage.includes("'近一年'"),
  )
  check('分段控件挂的是既有的 dsc-segmented 口径（不新造一种按钮）', usage.includes('className="dsc-segmented" role="group" aria-label="热力图时间范围"'), '')
  check('热力图是唯一的横向滚动容器（.hm-scroll > .hm-canvas）', /className="hm-scroll">\s*<div className="hm-canvas">/.test(usage.replace(/\n\s*/g, '\n')), '')
  check('画布跟着网格走（月份标签的定位基准是整张网格）', usage.includes('className="hm-canvas"'), '')
  check('heatDays 按档位截取（不是把一年全画出来再靠滑）', usage.includes('const heatDays = stats.days.slice(-heatRange)'), '')
}

console.log('\n[1b] 月份标签：一列只挂一个（2026-10-27 报障「10和11月重叠」）')
{
  // 真跑 buildCells：窗口对齐到周日起时，第一列里同时有 9 月尾巴与 10 月 1 号，
  // 两个标签的 left 都算成 0，叠成一团。
  const day = (date, tokens) => ({ date, inputTokens: tokens, outputTokens: 0, turns: 1, byModel: {} })
  const days = []
  for (let at = new Date('2026-09-27T12:00:00'); at <= new Date('2026-10-10T12:00:00'); at.setDate(at.getDate() + 1)) {
    const key = at.toISOString().slice(0, 10)
    days.push(day(key, 100))
  }
  const { columns, months } = buildCells(days, 14)
  const columnsOf = months.map((month) => month.column)
  check('标签列没有重复（同一列只挂一个）', new Set(columnsOf).size === columnsOf.length, JSON.stringify(months))
  check('首列只留 9 月（不把 10 月的 1 号也钉在 0 上）', months[0]?.column === 0 && months[0]?.label === '9月', JSON.stringify(months))
  check('标签按列递增（画出来不会左右乱跳）', columnsOf.every((col, index) => index === 0 || col > columnsOf[index - 1]), JSON.stringify(columnsOf))
  check('标签落在网格范围内', columnsOf.every((col) => col >= 0 && col < columns.length), JSON.stringify({ columnsOf, columns: columns.length }))
  check('格子总数 = 生成的天数', columns.flat().length === days.length, JSON.stringify({ cells: columns.flat().length, days: days.length }))

  // 一整年：12 个标签、列必须严格递增；这条在修前会因首列两个标签而红。
  const year = []
  for (let at = new Date('2025-10-26T12:00:00'); at <= new Date('2026-10-27T12:00:00'); at.setDate(at.getDate() + 1)) {
    const key = at.toISOString().slice(0, 10)
    year.push(day(key, 1000))
  }
  const full = buildCells(year, 364)
  const fullCols = full.months.map((month) => month.column)
  check('一年窗口的标签列严格递增', fullCols.every((col, index) => index === 0 || col > fullCols[index - 1]), JSON.stringify(fullCols))
  check('标签都是「N月」且不重复列', full.months.every((month) => /^\d{1,2}月$/.test(month.label)) && new Set(fullCols).size === fullCols.length, JSON.stringify(full.months))
  check('一年窗口至少 11 个标签（跨年不会漏月）', full.months.length >= 11, String(full.months.length))
}

console.log('\n[2] 环形图：窄窗口换行，不被卡片切')
{
  const css = read('ui-shell/src/styles.css')
  check('热力图容器的横向溢出是真的 auto（不是 hidden/visible）', hasStyle(css, '.hm-scroll', /overflow-x:\s*auto/), JSON.stringify(ruleBodies(css, '.hm-scroll')))
  check('画布宽度跟着内容（max-content），标签才对得上格子', hasStyle(css, '.hm-canvas', /width:\s*max-content/), JSON.stringify(ruleBodies(css, '.hm-canvas')))
  check('环形那一行允许换行', hasStyle(css, '.donut-row', /flex-wrap:\s*wrap/), JSON.stringify(ruleBodies(css, '.donut-row')))
  check('图例不再拿 min-width 撑住并排（min-width: 0 + 可伸缩）', hasStyle(css, '.donut-legend', /min-width:\s*0/) && hasStyle(css, '.donut-legend', /flex:\s*1 1 200px/), JSON.stringify(ruleBodies(css, '.donut-legend')))
  check('窄屏把环缩到 150px（180 挤不下两栏）', /@media \(max-width: 640px\)[\s\S]{0,400}?\.donut-svg \{[\s\S]{0,80}?height: 150px/.test(css), '')
  check('横向滚动容器不吃掉页面手势（overscroll-behavior-x: contain）', hasStyle(css, '.hm-scroll', /overscroll-behavior-x:\s*contain/), JSON.stringify(ruleBodies(css, '.hm-scroll')))
}

console.log('\n[3] 桌面回退渲染层同一份修')
{
  const panel = read('desktop/src/renderer/UsagePanel.tsx')
  check('桌面那份也收 windowDays', /function buildCells\(\s*days: UsageDayView\[\],\s*windowDays: number,?\s*\)/.test(panel) && panel.includes('windowDays - 1'), '')
  check('桌面那份也是四档', panel.includes('type HeatRange = 1 | 7 | 30 | 364') && panel.includes('[1, 7, 30, 364] as HeatRange[]'), '')
  check('桌面那份也包了 .hm-scroll / .hm-canvas', panel.includes('className="hm-scroll"') && panel.includes('className="hm-canvas"'), '')
  check('桌面那份也做了「一列只挂一个月份标签」', panel.includes('!months.some((month) => month.column === columns.length)'), '')
  const css = read('desktop/src/renderer/styles.css')
  check('桌面样式里也有 .hm-scroll 与 .hm-canvas', hasStyle(css, '.hm-scroll', /overflow-x:\s*auto/) && hasStyle(css, '.hm-canvas', /width:\s*max-content/), '')
  check('桌面那份环形也换行', hasStyle(css, '.donut-row', /flex-wrap:\s*wrap/), JSON.stringify(ruleBodies(css, '.donut-row')))
  check('追加区标记仍在文件最后一行（末尾纪律）', /追加区[^\n]*\n?$/.test(css.trimEnd() + '\n'), '')
}

console.log('\n[4] 负向自证：扫描器不是空转')
{
  const bad = '.hm { display: flex }\n.donut-row { align-items: center }'
  check('负向：没有 overflow-x 的容器会被判不合格', !hasStyle(bad, '.hm-scroll', /overflow-x:\s*auto/) && !hasStyle(bad, '.donut-row', /flex-wrap:\s*wrap/), '')
  const badTsx = 'function buildCells(days: UsageDayView[]) { return { columns: [], months: [] } }'
  check('负向：不收 windowDays 的实现会被挡下', !/windowDays: number/.test(badTsx), '')
  check('负向：注释里的类名不算有规则', ruleBodies('/* .hm-scroll { } */', '.hm-scroll').length === 0, JSON.stringify(ruleBodies('/* .hm-scroll { } */', '.hm-scroll')))
  check('负向：媒体查询里第二份规则也能被找到（只取最后一条会漏）', ruleBodies('.donut-row { gap: 1px }\n@media (max-width: 640px) { .donut-row { gap: 2px } }', '.donut-row').length === 2, '')
}

console.log(`\n用量统计窄屏版式：${String(passed)}/${String(passed + failures)} 通过`)
process.exit(failures === 0 ? 0 : 1)
