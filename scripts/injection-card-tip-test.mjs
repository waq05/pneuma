/**
 * 「上下文注入卡」头行提示的源码钉：卡片记的是**这一跳新增了哪些注入**，不是「这一跳注入了什么」。
 *
 * 背景（2026-11-11）：注入记账改成「内容没变就不上报」之后，一张只有「待办提醒」的卡会被读成
 * 「这一跳只注入了提醒」——其实环境快照照常注入了，只是没变、没记。卡片标题（「上下文注入」）
 * 是用户认这张卡的锚点，不能动；能加的是头行那个原生 `title`（悬停提示），说清口径。
 *
 * 这里只钉源码与字典（真机读 DOM 属性由 `desktop/shots/_probe-injection-title.mjs` 那一趟负责）：
 *  - 注入卡的头行 `<div className="entry-injection-head">` 上有原生 `title`，且用了
 *    `transcript.injection.newOnlyTip` 这个字典键；
 *  - 中英字典都有这个键、内容非空，中文里那两句口径都在（「只列这一跳新增的注入」
 *    「内容没变的项不会重复出现」）；
 *  - 卡片标题文字没被改（仍是「上下文注入」/「Context injections」）；
 *  - 开合提示没被顶掉（`expandTip` / `collapseTip` 仍在这个 `title` 里）。
 *
 * 用法：node scripts/injection-card-tip-test.mjs
 *
 * @module dsc/scripts/injection-card-tip-test
 */
import { readFileSync } from 'node:fs'

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

const card = read('src/packages/ui-transcript/ui/rows/prompt-card.tsx')
const zh = JSON.parse(read('src/packages/ui-transcript/locale/ui.zh.json'))
const en = JSON.parse(read('src/packages/ui-transcript/locale/ui.en.json'))

/** 字典键名：卡片头行用的那个。 */
const KEY = 'transcript.injection.newOnlyTip'

console.log('[1] 源码：注入卡头行带原生的 title，且用的是那个字典键')
{
  const headAt = card.indexOf('className="entry-injection-head"')
  check('找得到注入卡头行（className="entry-injection-head"）', headAt >= 0, String(headAt))
  // 头行这一段到 onClick 为止：title 必须长在头行上，不是长在卡片里随便哪个元素上。
  const headSlice = card.slice(headAt, headAt + 900)
  const titleAt = headSlice.indexOf('title=')
  check('头行有原生 title 属性', titleAt >= 0, headSlice.slice(0, 120))
  check(`头行的 title 用了 ${KEY}`, headSlice.includes(`t('${KEY}')`), headSlice.slice(0, 240))
  check('title 仍然接开合提示（expandTip / collapseTip 没被顶掉）',
    headSlice.includes("t('transcript.injection.expandTip')")
    && headSlice.includes("t('transcript.injection.collapseTip')"))
  // 反例守卫：只把键挂上去、把开合提示删掉，这一条会红。
  const titleLine = headSlice.slice(titleAt, headSlice.indexOf('\n', titleAt))
  check('title 在同一个表达式里同时带口径与开合提示',
    titleLine.includes(KEY) || headSlice.slice(titleAt, titleAt + 400).includes("t('transcript.injection.collapseTip')"),
    titleLine)
}

console.log('[2] 字典：中英各一条，口径说清楚')
{
  for (const [name, dict] of [['zh', zh], ['en', en]]) {
    check(`${name} 字典有 ${KEY}`, typeof dict[KEY] === 'string' && dict[KEY].trim() !== '', String(dict[KEY]))
  }
  check('中文说了「只列这一跳新增的注入」', String(zh[KEY]).includes('只列这一跳新增的注入'), String(zh[KEY]))
  check('中文说了「内容没变的项不会重复出现」', String(zh[KEY]).includes('内容没变的项不会重复出现'), String(zh[KEY]))
  check('英文说了只列新增', /only the injections/i.test(String(en[KEY])), String(en[KEY]))
  check('英文说了没变的不重复', /not repeated|unchanged/i.test(String(en[KEY])), String(en[KEY]))
  // 不许编造数据：提示里不能出现「另有 N 项」这类我们没有的读数。
  check('提示没有编造「另有 N 项未变」这类读数', !/另有|N 项|\+\d+ 项/.test(String(zh[KEY])), String(zh[KEY]))
}

console.log('[3] 卡片标题文字本身不许动')
{
  check('中文标题仍是「上下文注入」', zh['transcript.injection.label'] === '上下文注入', String(zh['transcript.injection.label']))
  check('英文标题仍是「Context injections」', en['transcript.injection.label'] === 'Context injections', String(en['transcript.injection.label']))
  check('卡片仍用 transcript.injection.label 画标题', card.includes("t('transcript.injection.label')"))
  check('没有把口径写进标题（标题键里没有「只列」）', !String(zh['transcript.injection.label']).includes('只列'))
}

console.log('')
if (failures === 0) console.log('上下文注入卡头行提示：全部通过')
else console.log(`上下文注入卡头行提示：${failures} 条失败`)
process.exit(failures === 0 ? 0 : 1)
