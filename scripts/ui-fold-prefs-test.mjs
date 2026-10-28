/**
 * 设置里「定稿的思考行 / 工具卡默认展开」改了之后，屏幕上的老行跟不跟的探针。
 *
 * 报障现场：设置页把开关一拨，已经画出来的行纹丝不动，用户以为设置没生效。
 * 根因是三处消费点都只在挂载时算一次初值（useState(() => readFold(...))），
 * 而存档与设置默认态在 readFold 里被压成同一个布尔值，分不出「用户手动调过」。
 *
 * 这一条三组断言：
 *   [1] 纯逻辑（fold-state.ts，零 React，Node 直接 import）：
 *       没存档时跟随 fallback、有存档时不动、存档里的 false 也算手动、undefined 键不炸；
 *   [2] 源码钉：三处消费点确实改用 useFoldState，且不再有 useState(() => readFold(...))；
 *       工具卡 preparing 不可展开、思考行直播态不参与初值这两条细节还在；
 *   [3] 四档 policy 表逐字未变（本次只动「默认展开」的跟随，不碰过程折叠策略）。
 *
 * 用法：node scripts/ui-fold-prefs-test.mjs
 *
 * @module dsc/scripts/ui-fold-prefs-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
// 源码统一换成 LF：仓库里部分文件是 CRLF，逐字比对不能因为换行符误报。
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, root)), 'utf8').replace(/\r\n/g, '\n')
// 去掉注释后再断言「代码里没有旧写法」：历史注释里引用旧代码是正常的，不算违规。
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const modUrl = (rel) => new URL(rel, root).href

const foldState = await import(modUrl('ui-shell/src/plugins/transcript/fold-state.ts'))
const { readFold, writeFold, hasFold, foldStateOf, followFallback } = foldState

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

console.log('1. 纯逻辑：没手动存档时跟随设置默认态')
{
  const key = 'probe:no-archive'
  check('没存过 = 读不到手动标记', hasFold(key) === false)
  const off = foldStateOf(key, false)
  check('fallback=false → 收起且 manual=false', off.open === false && off.manual === false, JSON.stringify(off))
  const on = foldStateOf(key, true)
  check('fallback 变 true → open 跟着变 true，仍不算手动', on.open === true && on.manual === false, JSON.stringify(on))
  check('readFold 与 foldStateOf 口径一致', readFold(key, true) === true && readFold(key, false) === false)
  check('followFallback：当前收起 + 默认态翻到展开 → 展开', followFallback(false, key, true) === true)
  check('followFallback：当前展开 + 默认态翻到收起 → 收起', followFallback(true, key, false) === false)
}

console.log('2. 纯逻辑：有手动存档时不动')
{
  const key = 'probe:manual-open'
  writeFold(key, true)
  check('写过之后 hasFold 为真', hasFold(key) === true)
  check('foldStateOf 标成 manual', foldStateOf(key, false).manual === true)
  check('存档 true 优先于 fallback false', foldStateOf(key, false).open === true)
  check('默认态翻到 false 也不动当前值（followFallback 保持 true）', followFallback(true, key, false) === true)
  check('默认态翻到 true 也不动当前值（followFallback 保持 false）', followFallback(false, key, true) === false)

  // 反向：用户手动收起，存档里就是 false——不能被「没存过」的兜底 false 混淆。
  const closedKey = 'probe:manual-closed'
  writeFold(closedKey, false)
  check('存档 false 也算手动（hasFold 真）', hasFold(closedKey) === true)
  check('存档 false 的 manual 标记为真', foldStateOf(closedKey, true).manual === true)
  check('存档 false 优先于 fallback true', foldStateOf(closedKey, true).open === false)
  check('followFallback 不会把它翻成 fallback true', followFallback(false, closedKey, true) === false)
}

console.log('3. 纯逻辑：undefined 键（不存档的视图）不炸')
{
  let threw = null
  let state
  try {
    state = foldStateOf(undefined, true)
    writeFold(undefined, true)
  } catch (reason) {
    threw = reason
  }
  check('undefined 键读状态与写入都不抛', threw === null, threw === null ? '' : String(threw))
  check('undefined 键 manual 恒为 false', state.open === true && state.manual === false, JSON.stringify(state))
  check('undefined 键 hasFold 为假', hasFold(undefined) === false)
  check('undefined 键写入是空操作（read 仍回 fallback）', readFold(undefined, false) === false)
  check('undefined 键跟随默认态', followFallback(true, undefined, false) === false)
}

console.log('4. 纯逻辑：钩子的生命周期（用同一份 followFallback 逐拍模拟）')
{
  // 拍 1：挂载，无存档，设置默认收起
  const key = 'probe:lifecycle'
  let open = foldStateOf(key, false).open
  check('挂载即按默认态收起', open === false)
  // 拍 2：设置改成默认展开 → effect 跟随
  open = followFallback(open, key, true)
  check('设置改成展开后老行跟着展开', open === true)
  // 拍 3：用户手动点收起 → 写存档并转手动
  writeFold(key, false)
  open = false
  check('点过之后转手动', hasFold(key) === true)
  // 拍 4：设置再改成默认展开 → 不动（这就是报障点：不能被设置翻回去）
  open = followFallback(open, key, true)
  check('手动收起后，设置改回展开也不动', open === false)
  // 拍 5：重挂读回手动值
  check('重挂读回的是手动值（收起）', foldStateOf(key, true).open === false)
}

console.log('5. 源码钉：三处消费点改用钩子')
{
  const consumers = [
    ['ui-shell/src/plugins/transcript/tool-card/factory.tsx', 'persistKey'],
    ['ui-shell/src/plugins/transcript/rows/tool-row.tsx', 'storeKey'],
    ['ui-shell/src/plugins/transcript/rows/think-row.tsx', 'storeKey'],
  ]
  for (const [rel, keyName] of consumers) {
    const src = read(rel)
    check(rel + ' 引入 useFoldState', /import \{ useFoldState \} from '(\.\.\/)+fold-hook'/.test(src))
    check(rel + ' 调用 useFoldState(' + keyName + ')', new RegExp('useFoldState\\(' + keyName).test(src))
    check(rel + ' 不再用 useState(() => readFold(...))', !/useState\(\(\) => readFold\(/.test(src))
    check(rel + ' 不再直接写存档（写存档归钩子）', !/writeFold\(/.test(src))
  }

  const factory = read('ui-shell/src/plugins/transcript/tool-card/factory.tsx')
  const toolRow = read('ui-shell/src/plugins/transcript/rows/tool-row.tsx')
  const thinkRow = read('ui-shell/src/plugins/transcript/rows/think-row.tsx')
  check('工具卡 preparing 仍不可展开（factory）', /call\.status !== 'preparing'/.test(factory) && /open && expandable/.test(factory))
  check('工具行 preparing 仍不可展开（tool-row）', /call\.status !== 'preparing'/.test(toolRow) && /open && expandable/.test(toolRow))
  // 注释里保留着「以前写成 live || prefs.reasoningOpen」的来历说明，所以只看代码本身。
  const thinkCode = stripComments(thinkRow)
  check('思考行初值不再拿 live 当展开理由', !/readFold\(storeKey, live/.test(thinkCode) && !/useFoldState\(storeKey, live/.test(thinkCode))
  check('思考行仍按直播态区分摘要与样式', /live \? latestCompletedParagraphFirstLine/.test(thinkRow))
}

console.log('6. 源码钉：钩子本身与设置下发链路')
{
  const hook = read('ui-shell/src/plugins/transcript/fold-hook.ts')
  const state = read('ui-shell/src/plugins/transcript/fold-state.ts')
  check('钩子复用 followFallback（判断不另写一份）', /followFallback\(current, storeKey, fallback\)/.test(hook))
  check('钩子写存档走 writeFold', /writeFold\(storeKey, next\)/.test(hook))
  check('钩子只依赖 React 基础 hook（无 JSX）', /from 'react'/.test(hook) && !/<[A-Za-z][^>]*>/.test(hook))
  check('纯模块导出 hasFold / foldStateOf / followFallback', ['hasFold', 'foldStateOf', 'followFallback'].every((name) => state.includes('export function ' + name + '(')))
  check('纯模块零 React 依赖（Node 可直接 import）', !/from 'react'/.test(state))

  const ui = read('ui-shell/src/plugins/transcript/ui.tsx')
  check('设置变化仍经 shell.uiprefs 事件同步进壳', /addEventListener\('shell.uiprefs', read\)/.test(ui) && /invoke<Record<string, unknown>>\('getUiPrefs'/.test(ui))
  check('工具卡默认态来自 toolDefaultOpen', /toolOpen: value\['toolDefaultOpen'\] === true/.test(ui))
  check('思考行默认态来自 reasoningDefaultOpen', /reasoningOpen: value\['reasoningDefaultOpen'\] === true/.test(ui))
}

console.log('7. 源码钉：四档 policy 表逐字未变')
{
  const roundFold = read('ui-shell/src/plugins/transcript/round-fold.tsx')
  const expected = [
    'export const PROCESS_FOLD_POLICIES: Readonly<Record<ProcessFold, ProcessFoldPolicy>> = {',
    "  compact: { foldTurns: true, stepGrouping: 'collapsed', liveDetail: false, reasoningPreview: false },",
    "  standard: { foldTurns: true, stepGrouping: 'collapsed', liveDetail: true, reasoningPreview: true },",
    "  detailed: { foldTurns: true, stepGrouping: 'history', liveDetail: true, reasoningPreview: true },",
    "  verbose: { foldTurns: false, stepGrouping: 'none', liveDetail: false, reasoningPreview: true },",
    '}',
  ].join('\n')
  const found = roundFold.match(/export const PROCESS_FOLD_POLICIES[\s\S]*?\n\}/)
  const actual = found === null ? '' : found[0].replace(/[ \t]+/g, ' ')
  const wanted = expected.replace(/[ \t]+/g, ' ')
  check('四档能力表内容与顺序未变', actual === wanted, actual === wanted ? '' : JSON.stringify(actual))
}

console.log('')
console.log(failures === 0 ? 'ALL PASS  ' + passes + ' 项' : 'FAILED  ' + failures + ' 项，PASS ' + passes + ' 项')
process.exitCode = failures === 0 ? 0 : 1
