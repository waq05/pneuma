/**
 * 会话分页的确定性探针（ui 层）。
 *
 * 来源：`scripts/ui-paging-test.mjs` 第 [1]–[6] 段。分页口径跟 dsh 对齐成**条目数**：
 *   1. **地板**：一页至少 50 条**且**至少 2 轮，只够一项就继续往前收（两项都满足才切）；
 *   2. **天花板**：再收一轮会顶破 500 就先收口——宁可这一页比地板小，也绝不把一轮
 *      拆成两页；唯一例外是单轮自身超 500 条（那时只能整轮放进来）；
 *   3. **到顶**：已经没有更早的轮就返回 0，界面据此不画「加载更早」。
 *
 * 原探针第 [7] 段是 `ui.tsx` / `viewport.ts` 的形态钉（谁在调这个纯函数、滚动补偿在
 * 布局效果里补……）——渲染体与结构约定文本，不迁，归组件渲染批。
 *
 * 为什么在 spec 里自己算页读数（`pageOf`）：断言要同时盯住「返回的边界」与「这一页到底
 * 有多少条」，从 sizes 切片自己算才不依赖实现里可能有的第二份中间量。
 *
 * @module dsc-ui-transcript/ui/paging.spec
 */
import { expect, test } from 'vitest'
import { PAGE_MAX_ENTRIES, PAGE_MIN_ENTRIES, PAGE_MIN_ROUNDS, pageStartRound } from './paging.js'

/** 把 `pageStartRound` 的返回翻译成一页的读数：起点轮号、条目数、轮数。 */
const pageOf = (sizes: number[], before: number): { start: number; entries: number; rounds: number } => {
  const start = pageStartRound(sizes, before)
  const window = sizes.slice(start, before)
  return { start, entries: window.reduce((sum, size) => sum + size, 0), rounds: window.length }
}

/** 确定性伪随机（探针不许有真随机：同一条报障要能复现）。 */
const lcg = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
}

// ── 口径常数 ───────────────────────────────────────────────────────────────────

test('口径常数（照 dsh：minMessages 50 / minTurns 2 / maxMessages 500）', () => {
  expect(PAGE_MIN_ENTRIES).toBe(50)
  expect(PAGE_MIN_ROUNDS).toBe(2)
  expect(PAGE_MAX_ENTRIES).toBe(500)
})

// ── 地板：条目数与轮数两项都满足才收口 ─────────────────────────────────────────

test('条目不够就继续往前收（30+30 才够 50）', () => {
  const thin = pageOf([30, 30, 30], 3)
  expect(thin.start).toBe(1)
  expect(thin.entries).toBe(60)
})

test('一轮就够 50 条也不收口：满 2 轮才切', () => {
  const oneRound = pageOf([100, 100], 2)
  expect(oneRound.start).toBe(0)
  expect(oneRound.rounds).toBe(2)
})

test('轮数够但条目不够：收到第 50 条整才切', () => {
  const flat = pageOf(Array.from({ length: 20 }, () => 5), 20)
  expect(flat.start).toBe(10)
  expect(flat.entries).toBe(50)
  expect(flat.rounds).toBe(10)
})

test('默认尾页 = 最后 5 轮（50 条）', () => {
  const tail = pageOf(Array.from({ length: 12 }, () => 10), 12)
  expect(tail.start).toBe(7)
  expect(tail.entries).toBe(50)
})

// ── 天花板：≤500 封顶，宁可提前收口 ────────────────────────────────────────────

test('正好收满 500 就切', () => {
  const exact = pageOf([250, 250, 250], 3)
  expect(exact.start).toBe(1)
  expect(exact.entries).toBe(500)
})

test('再收一轮会顶破 500 就先收口（这一页 300 条、1 轮也认）', () => {
  const overshoot = pageOf([300, 300, 300], 3)
  expect(overshoot.start).toBe(2)
  expect(overshoot.entries).toBe(300)
})

test('能拆轮凑到 500 也绝不拆（这一页只收 200 条）', () => {
  const greedy = pageOf([400, 100, 100], 3)
  expect(greedy.start).toBe(1)
  expect(greedy.entries).toBe(200)
})

test('普查 200 组尺寸：页不超上限，或这一页就是单轮', () => {
  // 普查：任何形状下页都不超上限——除非这一页就是「单轮自身超上限」的那一轮。
  const next = lcg(20261013)
  for (let seed = 1; seed <= 200; seed += 1) {
    const before = 1 + (seed % 24)
    const sizes = Array.from({ length: before }, () => 1 + (next() % 700))
    const page = pageOf(sizes, before)
    expect(page.rounds === 0, `seed=${String(seed)} 空页`).toBe(false)
    expect(
      page.entries <= PAGE_MAX_ENTRIES || page.rounds === 1,
      `seed=${String(seed)} 超上限且不是单轮`,
    ).toBe(true)
  }
})

// ── 绝不把一轮拆成两页 ─────────────────────────────────────────────────────────

test('任何 before 的边界都是整轮切片（0 ≤ start ≤ before）', () => {
  const sizes = [37, 63, 1, 200, 9, 480, 5, 5, 5]
  for (let before = 0; before <= sizes.length; before += 1) {
    const start = pageStartRound(sizes, before)
    expect(Number.isInteger(start) && start >= 0 && start <= before, `before=${String(before)} start=${String(start)}`).toBe(true)
    const page = pageOf(sizes, before)
    // 页就是 sizes[start..before) 的整轮切片：「拆轮」的表现（页里出现半轮的条目数）在这里会立刻暴露。
    expect(page.entries).toBe(sizes.slice(start, before).reduce((sum, size) => sum + size, 0))
  }
})

test('收口后剩下的那几轮仍是完整轮（60+60）', () => {
  // 界面按 `seat.round >= firstVisible` 过滤，所以「整轮切片」= 界面整轮画。
  const boundary = pageOf([60, 60, 60, 60], 4)
  expect(boundary.start).toBe(2)
  expect(boundary.entries).toBe(120)
})

// ── 单轮自身超上限：唯一的整轮例外 ─────────────────────────────────────────────

test('单轮 600 条：整轮放进来（这一页 600 条，超上限也认）', () => {
  const mega = pageOf([600], 1)
  expect(mega.start).toBe(0)
  expect(mega.entries).toBe(600)
  expect(mega.rounds).toBe(1)
})

test('超限那一轮自己成一页，前面的小轮先单独收口', () => {
  expect(pageOf([100, 600], 2)).toMatchObject({ start: 1, entries: 600 })
  expect(pageOf([600, 100], 2)).toMatchObject({ start: 1, entries: 100, rounds: 1 })
  expect(pageOf([600, 100], 1)).toMatchObject({ start: 0, entries: 600 })
})

// ── 到顶与连点两下（从中间边界继续往前攒） ─────────────────────────────────────

test('已经到顶（before = 0）与空尺寸表都返回 0', () => {
  expect(pageStartRound([10, 20, 30], 0)).toBe(0)
  expect(pageStartRound([], 0)).toBe(0)
})

test('连点两下：两页不重叠、合起来铺满，轮一枚不少', () => {
  const sizes = [60, 60, 60, 60]
  const first = pageOf(sizes, 4)
  const second = pageOf(sizes, first.start)
  expect(first).toMatchObject({ start: 2, entries: 120 })
  expect(second).toMatchObject({ start: 0, entries: 120 })
  expect(first.start).toBe(second.rounds)
  expect(first.rounds + second.rounds).toBe(sizes.length)
})

test('变长尺寸连点到头：每页过地板（或被上限逼收），起点严格递减', () => {
  const varied = [7, 90, 3, 40, 120, 12, 8, 300, 6, 55]
  let before = varied.length
  let clicks = 0
  while (before > 0) {
    const page = pageOf(varied, before)
    expect(page.start < before && page.rounds > 0).toBe(true)
    const floorMet = page.entries >= PAGE_MIN_ENTRIES && page.rounds >= PAGE_MIN_ROUNDS
    // 地板没到的唯一合法理由是上限收口：再往前收一轮就会顶破 500（或已经收到头）。
    const capCut = page.start === 0 || page.entries + (varied[page.start - 1] ?? 0) > PAGE_MAX_ENTRIES
    expect(floorMet || capCut).toBe(true)
    expect(page.entries <= PAGE_MAX_ENTRIES || page.rounds === 1).toBe(true)
    before = page.start
    clicks += 1
  }
  expect(before).toBe(0)
  expect(clicks).toBeGreaterThanOrEqual(2)
})
