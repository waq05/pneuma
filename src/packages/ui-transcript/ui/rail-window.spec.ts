/**
 * 右侧回合刻度条「当前在第几轮」的判定（迁自 `scripts/ui-jump-rail-test.mjs`
 * 第 [1]–[3] 段）。
 *
 * 报障现场：会话里有子代理交互时，滑到底部右侧刻度高亮错位。根因在锚点来源——旧写法
 * 把 `.entry-user`（用户气泡）当锚点，而子代理汇报（`internal` 的 user 条目）渲染成
 * 一行触发行，没有气泡，那一轮永远拿不到锚点。现在「最新一轮」由轮清单给（`lastRound`），
 * 锚点按 `[data-round]` 收、同一轮去重留第一行。`rail-window.ts` 零依赖纯函数，
 * 真跑结果就是被测行为。
 *
 * 没迁的（原探针第 [4] 段接线形态，见交付报告缺口清单）：`jump-rail.tsx` 的
 * `querySelectorAll('[data-round]')`、`getClientRects` 跳过隐藏行、贴底取
 * `rounds.at(-1)` 等接线是渲染层 DOM 接缝，归组件渲染批。
 *
 * @module dsc-ui-transcript/ui/rail-window.spec
 */
import { describe, expect, test } from 'vitest'
import type { RailAnchor } from './rail-window.js'
import { dedupeByRound, pickCurrentRound } from './rail-window.js'

describe('贴底：取轮清单的最后一轮，不取最后一个锚点', () => {
  test('子代理现场：锚点只到第 0 轮，贴底仍高亮最后一轮（第 1 轮）', () => {
    // 旧写法拿锚点尾部当最新一轮时会给出 0——高亮就停错刻度。
    const onlyHumanAnchor: RailAnchor[] = [{ round: 0, top: 0 }]
    expect(onlyHumanAnchor.at(-1)?.round).toBe(0)
    const bottom = pickCurrentRound({
      atBottom: true,
      lastRound: 1,
      hitRound: null,
      anchors: onlyHumanAnchor,
      probeTop: 0,
    })
    expect(bottom).toBe(1)
  })

  test('最新一轮一个锚点都没有，贴底也给轮清单最后那一轮', () => {
    const threeRounds: RailAnchor[] = [{ round: 0, top: 0 }, { round: 2, top: 400 }]
    expect(pickCurrentRound({ atBottom: true, lastRound: 2, hitRound: 0, anchors: threeRounds, probeTop: 0 })).toBe(2)
  })

  test('贴底判定排在命中测试前面（底部那张卡不带 data-round，命中会落到上一轮）', () => {
    const threeRounds: RailAnchor[] = [{ round: 0, top: 0 }, { round: 2, top: 400 }]
    expect(pickCurrentRound({ atBottom: true, lastRound: 2, hitRound: 1, anchors: threeRounds, probeTop: 0 })).toBe(2)
  })

  test('没有轮（lastRound = -1）时贴底不硬给 0', () => {
    expect(pickCurrentRound({ atBottom: true, lastRound: -1, hitRound: null, anchors: [], probeTop: 0 })).toBe(-1)
  })
})

describe('不贴底：命中测试与几何兜底', () => {
  const anchors: RailAnchor[] = [
    { round: 0, top: 0 },
    { round: 1, top: 800 },
    { round: 2, top: 1600 },
  ]

  test('命中测试优先（探针线上是哪一轮就是哪一轮）', () => {
    expect(pickCurrentRound({ atBottom: false, lastRound: 2, hitRound: 1, anchors, probeTop: 850 })).toBe(1)
  })

  test('没命中：取最后一个 top ≤ 探针线的锚点', () => {
    expect(pickCurrentRound({ atBottom: false, lastRound: 2, hitRound: null, anchors, probeTop: 1608 })).toBe(2)
  })

  test('没命中且还在最顶上：高亮画出来的第一轮，而不是一枚都不亮', () => {
    expect(pickCurrentRound({ atBottom: false, lastRound: 2, hitRound: null, anchors, probeTop: 4 })).toBe(0)
  })

  test('一枚锚点都没有又没贴底：给 -1（不亮，也不瞎猜）', () => {
    expect(pickCurrentRound({ atBottom: false, lastRound: 2, hitRound: null, anchors: [], probeTop: 0 })).toBe(-1)
  })

  test('探针线滚过下一轮起点：取最后一个锚点', () => {
    expect(pickCurrentRound({ atBottom: false, lastRound: 2, hitRound: null, anchors, probeTop: 9999 })).toBe(2)
  })
})

describe('锚点去重：同一轮多行只留第一行', () => {
  test('每轮一条、留这一轮的第一行、顺序按输入不重排、空输入给空表', () => {
    const rows: RailAnchor[] = [
      { round: 0, top: 0 },
      { round: 0, top: 60 },
      { round: 0, top: 120 },
      { round: 1, top: 300 },
      { round: 1, top: 360 },
    ]
    const anchors = dedupeByRound(rows)
    expect(anchors).toHaveLength(2)
    expect(anchors[0]?.top).toBe(0)
    expect(anchors[1]?.top).toBe(300)
    expect(anchors.map((anchor) => anchor.round)).toEqual([0, 1])
    expect(dedupeByRound([])).toEqual([])
  })

  test('去重后仍能正确判轮（重复行不会把几何兜底带偏）', () => {
    const rows: RailAnchor[] = [
      { round: 0, top: 0 },
      { round: 0, top: 60 },
      { round: 1, top: 300 },
    ]
    const anchors = dedupeByRound(rows)
    expect(pickCurrentRound({ atBottom: false, lastRound: 1, hitRound: null, anchors, probeTop: 310 })).toBe(1)
  })
})
