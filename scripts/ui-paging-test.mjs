/**
 * 会话分页（transcript/paging.ts）的确定性探针。
 *
 * 分页口径跟 dsh 对齐成**条目数**（dsh `packages/api/session-controller/src/history.ts:392`
 * 的 `paginate` + `session.ts:52` 的 `PAGE_MESSAGES = 50` 与
 * `HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }`）：
 *
 *   1. **地板**：一页至少 50 条**且**至少 2 轮，只够一项就继续往前收（两项都满足才切）；
 *   2. **天花板**：再收一轮会顶破 500 就先收口——宁可这一页比地板小，也绝不把一轮
 *      拆成两页；唯一例外是单轮自身超 500 条（那时只能整轮放进来）；
 *   3. **到顶**：已经没有更早的轮就返回 0，界面据此不画「加载更早」。
 *
 * 三段：
 *   [1]-[6] 纯逻辑——模型按 Node 的类型擦除直读 .ts（同 `ui-status-panel-test.mjs` 的做法，
 *   不需要先 build）：常数 / 地板 / 天花板 / 不拆轮 / 单轮超限例外 / 到顶与连点两下；
 *   [7] 形态钉——ui.tsx 里「谁在调这个纯函数」「到顶不画按钮」「可见窗口按整轮过滤」
 *   「放页有滚动补偿与跟随暂停」这些只能靠文本钉住的结构约定。
 *
 * 运行：node scripts/ui-paging-test.mjs
 *
 * @module dsc/scripts/ui-paging-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const paging = await import(
  new URL('../ui-shell/src/plugins/transcript/paging.ts', import.meta.url).href
)
const { PAGE_MIN_ENTRIES, PAGE_MIN_ROUNDS, PAGE_MAX_ENTRIES, pageStartRound } = paging

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

/**
 * 把 `pageStartRound` 的返回翻译成一页的读数：起点轮号、条目数、轮数。
 * 为什么在探针里自己算：断言要同时盯住「返回的边界」与「这页到底有多少条」，
 * 自己从 sizes 切片算才不依赖实现里可能有的第二份中间量。
 */
const pageOf = (sizes, before) => {
  const start = pageStartRound(sizes, before)
  const window = sizes.slice(start, before)
  return { start, entries: window.reduce((sum, size) => sum + size, 0), rounds: window.length }
}

/** 确定性伪随机（探针不许有真随机：同一条报障要能复现）。 */
const lcg = (seed) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
}

console.log('[1] 口径常数（照 dsh：minMessages 50 / minTurns 2 / maxMessages 500）')
{
  check('一页最少 50 条', PAGE_MIN_ENTRIES === 50, String(PAGE_MIN_ENTRIES))
  check('一页最少 2 轮', PAGE_MIN_ROUNDS === 2, String(PAGE_MIN_ROUNDS))
  check('一页最多 500 条', PAGE_MAX_ENTRIES === 500, String(PAGE_MAX_ENTRIES))
}

console.log('[2] 地板：条目数与轮数两项都满足才收口')
{
  const thin = pageOf([30, 30, 30], 3)
  check('条目不够就继续往前收（30+30 才够 50）', thin.start === 1 && thin.entries === 60, JSON.stringify(thin))

  const oneRound = pageOf([100, 100], 2)
  check('一轮就够 50 条也不收口：满 2 轮才切', oneRound.start === 0 && oneRound.rounds === 2, JSON.stringify(oneRound))

  const flat = pageOf(Array.from({ length: 20 }, () => 5), 20)
  check('轮数够但条目不够：收到第 50 条整才切', flat.start === 10 && flat.entries === 50 && flat.rounds === 10, JSON.stringify(flat))

  const tail = pageOf(Array.from({ length: 12 }, () => 10), 12)
  check('默认尾页 = 最后 5 轮（50 条）', tail.start === 7 && tail.entries === 50, JSON.stringify(tail))
}

console.log('[3] 天花板：≤500 封顶，宁可提前收口')
{
  const exact = pageOf([250, 250, 250], 3)
  check('正好收满 500 就切', exact.start === 1 && exact.entries === 500, JSON.stringify(exact))

  const overshoot = pageOf([300, 300, 300], 3)
  check('再收一轮会顶破 500 就先收口（这一页 300 条、1 轮也认）', overshoot.start === 2 && overshoot.entries === 300, JSON.stringify(overshoot))

  const greedy = pageOf([400, 100, 100], 3)
  check('能拆轮凑到 500 也绝不拆（这一页只收 200 条）', greedy.start === 1 && greedy.entries === 200, JSON.stringify(greedy))

  // 普查：任何形状下页都不超上限——除非这一页就是「单轮自身超上限」的那一轮。
  const next = lcg(20261013)
  let census = 0
  let bad = null
  for (let seed = 1; seed <= 200; seed += 1) {
    const before = 1 + (seed % 24)
    const sizes = Array.from({ length: before }, () => 1 + (next() % 700))
    const page = pageOf(sizes, before)
    census += 1
    if (page.rounds === 0) bad = { seed, reason: '空页', page }
    else if (page.entries > PAGE_MAX_ENTRIES && page.rounds !== 1) bad = { seed, reason: '超上限且不是单轮', page }
    if (bad !== null) break
  }
  check(`普查 ${String(census)} 组尺寸：页不超上限，或这一页就是单轮`, bad === null, JSON.stringify(bad))
}

console.log('[4] 绝不把一轮拆成两页')
{
  const sizes = [37, 63, 1, 200, 9, 480, 5, 5, 5]
  let off = null
  for (let before = 0; before <= sizes.length; before += 1) {
    const start = pageStartRound(sizes, before)
    if (!Number.isInteger(start) || start < 0 || start > before) off = { before, start }
    const page = pageOf(sizes, before)
    // 页就是 sizes[start..before) 的整轮切片：条目数必须等于这几轮的整轮之和，
    // 「拆轮」的表现（页里出现半轮的条目数）在这里会立刻暴露。
    if (page.entries !== sizes.slice(start, before).reduce((sum, size) => sum + size, 0)) off = { before, page }
  }
  check('任何 before 的边界都是整轮切片（0 ≤ start ≤ before）', off === null, JSON.stringify(off))

  // 界面按 `seat.round >= firstVisible` 过滤（见 [7] 的文本钉），所以「整轮切片」= 界面整轮画。
  const boundary = pageOf([60, 60, 60, 60], 4)
  check('收口后剩下的那几轮仍是完整轮（60+60）', boundary.start === 2 && boundary.entries === 120, JSON.stringify(boundary))
}

console.log('[5] 单轮自身超上限：唯一的整轮例外')
{
  const mega = pageOf([600], 1)
  check('单轮 600 条：整轮放进来（这一页 600 条，超上限也认）', mega.start === 0 && mega.entries === 600 && mega.rounds === 1, JSON.stringify(mega))

  const behind = pageOf([100, 600], 2)
  check('超限那一轮自己成一页（600 条）', behind.start === 1 && behind.entries === 600, JSON.stringify(behind))

  const front = pageOf([600, 100], 2)
  check('它前面那点小轮先单独收口（100 条：上限优先于地板）', front.start === 1 && front.entries === 100 && front.rounds === 1, JSON.stringify(front))

  const rest = pageOf([600, 100], 1)
  check('再点一下才轮到那一轮（600 条）', rest.start === 0 && rest.entries === 600, JSON.stringify(rest))
}

console.log('[6] 到顶与连点两下（从中间边界继续往前攒）')
{
  check('已经到顶（before = 0）返回 0', pageStartRound([10, 20, 30], 0) === 0)
  check('没有可收的轮（空尺寸表）也返回 0', pageStartRound([], 0) === 0)

  const sizes = [60, 60, 60, 60]
  const first = pageOf(sizes, 4)
  const second = pageOf(sizes, first.start)
  check('第一下：最后 2 轮（120 条）', first.start === 2 && first.entries === 120, JSON.stringify(first))
  check('第二下：从上一页的边界继续往前，收到头', second.start === 0 && second.entries === 120, JSON.stringify(second))
  check('两页不重叠、合起来铺满，轮一枚不少', first.start === second.rounds && first.rounds + second.rounds === sizes.length)

  // 变长尺寸：一路连点到头，每一步都要么过了地板、要么是被上限逼的收口，起点严格递减。
  const varied = [7, 90, 3, 40, 120, 12, 8, 300, 6, 55]
  let before = varied.length
  let clicks = 0
  let sane = true
  while (before > 0) {
    const page = pageOf(varied, before)
    if (page.start >= before || page.rounds === 0) {
      sane = false
      break
    }
    const floorMet = page.entries >= PAGE_MIN_ENTRIES && page.rounds >= PAGE_MIN_ROUNDS
    // 地板没到的唯一合法理由是上限收口：再往前收一轮就会顶破 500（或已经收到头）。
    const capCut = page.start === 0 || page.entries + varied[page.start - 1] > PAGE_MAX_ENTRIES
    if (!floorMet && !capCut) sane = false
    if (page.entries > PAGE_MAX_ENTRIES && page.rounds !== 1) sane = false
    before = page.start
    clicks += 1
  }
  check(`变长尺寸连点 ${String(clicks)} 下到头：每页过地板（或被上限逼收），起点严格递减`, sane && before === 0 && clicks >= 2)
}

console.log('[7] 形态钉（ui.tsx 里的结构约定）')
{
  const ui = read('ui-shell/src/plugins/transcript/ui.tsx')
  const source = read('ui-shell/src/plugins/transcript/paging.ts')

  check('paging.ts 是纯逻辑（不引 React / 任何运行期依赖）', !/from 'react'/.test(source) && !/from '\.\//.test(source))
  check('ui.tsx 的口径来自 paging.ts，按轮写死的 PAGE_ROUNDS 已撤', ui.includes("from './paging'") && !ui.includes('PAGE_ROUNDS'))
  check('默认尾页与可见窗口都用同一个纯函数', ui.includes('pageStartRound(roundSizes, roundSizes.length)') && ui.includes('pageStartRound(roundSizes, firstVisible)'))
  check('到顶不画「加载更早」（firstVisible > 0 才画）', ui.includes('{firstVisible > 0 ? ('))
  check('按钮读数 = 这一页实际放出的轮数（earlierRounds），不是写死的常数', ui.includes("加载更早的 ${String(earlierRounds)} 轮") && ui.includes('data-earlier-rounds={firstVisible}') && ui.includes('release(firstVisible - earlierRounds)'))
  check('可见窗口按整轮过滤（seat.round >= firstVisible，天然不拆轮）', ui.includes('seats.rounds.filter((seat) => seat.round >= firstVisible)'))
  check('刻度条仍拿 renderedFrom，点未画出的轮走同一个放页入口', ui.includes('renderedFrom={firstVisible}') && ui.includes('release(round)'))
  check('放页有滚动补偿：useLayoutEffect 里量锚点位移再补 scrollTop', /useLayoutEffect\([\s\S]{0,700}?scroller\.scrollTop \+= top - anchor\.top/.test(ui))
  check('锚点取第一个画出来的座位（不是按钮后的兄弟）', ui.includes("scroller.querySelector<HTMLElement>('[data-round-seat]')"))
  check('放页顺带暂停跟随（别让流式内容把视角拽回底部）', ui.includes('follow.pause()') && ui.includes('pause = (): void =>') && ui.includes('return { setEnd, paused, resume, pause }'))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
