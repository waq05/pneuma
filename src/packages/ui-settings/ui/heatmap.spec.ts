/**
 * 热力图纯布局的月份标签与时间窗（迁自 `scripts/ui-usage-layout-test.mjs` 第 [1b] 段，
 * 另把第 [1] 段里两条有公开出口的钉行为化）。
 *
 * 报障背景（2026-10-27）：窗口从周日起、月初又落在同一列时，「10月」与「11月」两个标签
 * 被钉在同一个 left 上叠成一团；热力图钉死 53 列，手机上整块横出屏幕。修法是「同一列只挂
 * 一个标签（保留先到的）」+「窗口长度收参数（今天 / 7 天 / 30 天 / 近一年）」。
 *
 * 为什么是行为测试：`heatmap.ts` 是从 usage.tsx 拆出来的纯布局（只经 `@dsc/ui` 取词器拿
 * 月份名），`buildCells` 的真跑结果就是被测行为；`CELL` / `GAP` 是导出常量，断言它们的值
 * 就是「一格尺寸只写一份」的公开面（方案 A）。
 *
 * 不迁的部分（原探针第 [1][2][4] 段，见交付报告缺口清单）：
 *   - [1] usage.tsx 的接线（四档分段控件、.hm-scroll > .hm-canvas 结构、heatDays 截取）
 *     ——渲染接线，归组件渲染批；
 *   - [2] CSS 布局算术（.donut-row 换行、.hm-scroll 横向滚、环 150px）——纯样式钉，
 *     没有可导入的尺寸常量，转 shots 截图探针；
 *   - [4] 负向自证（扫描器 ruleBodies 对坏输入的反应）——那是探针自己造的扫描器的
 *     自检，spec 里没有这台扫描器；本文件的反向验证（改坏 buildCells 守卫必须红）等价。
 *
 * @module dsc-ui-settings/ui/heatmap.spec
 */
import { describe, expect, test } from 'vitest'
import type { UsageDayView } from '@dsc/ui'
import { CELL, GAP, buildCells } from './heatmap.js'

/** 造一天用量：全部天数同量，热力图档位不参与本批断言。 */
const day = (date: string, tokens: number): UsageDayView =>
  ({ date, inputTokens: tokens, outputTokens: 0, turns: 1, byModel: {} }) as UsageDayView

/** 一段连续天数：从 `from` 起每天一格，直到 `to`（含）。 */
function dayRange(from: string, to: string, tokens: number): UsageDayView[] {
  const days: UsageDayView[] = []
  for (let at = new Date(`${from}T12:00:00`); at <= new Date(`${to}T12:00:00`); at.setDate(at.getDate() + 1)) {
    days.push(day(at.toISOString().slice(0, 10), tokens))
  }
  return days
}

describe('一格尺寸只写一份（导出常量）', () => {
  test('CELL = 10、GAP = 3（设置面板正文约 690px，53 列刚好放下）', () => {
    expect(CELL).toBe(10)
    expect(GAP).toBe(3)
  })
})

describe('月份标签：一列只挂一个（2026-10-27 报障「10和11月重叠」）', () => {
  // 真跑 buildCells：窗口对齐到周日起时，第一列里同时有 9 月尾巴与 10 月 1 号，
  // 两个标签的 left 都算成 0，修前会叠成一团。
  const days = dayRange('2026-09-27', '2026-10-10', 100)
  const { columns, months } = buildCells(days, 14)
  const columnsOf = months.map((month) => month.column)

  test('标签列没有重复（同一列只挂一个）', () => {
    expect(new Set(columnsOf).size).toBe(columnsOf.length)
  })

  test('首列只留 9 月（不把 10 月的 1 号也钉在 0 上）', () => {
    expect(months[0]?.column).toBe(0)
    expect(months[0]?.label).toBe('9月')
  })

  test('标签按列递增（画出来不会左右乱跳）', () => {
    expect(columnsOf.every((col, index) => index === 0 || col > columnsOf[index - 1])).toBe(true)
  })

  test('标签落在网格范围内', () => {
    expect(columnsOf.every((col) => col >= 0 && col < columns.length)).toBe(true)
  })

  test('格子总数 = 生成的天数（数据起点是周日、又早于时间窗起点，前面没有空档可铺）', () => {
    expect(columns.flat().length).toBe(days.length)
  })
})

describe('一年窗口：12 个标签、列严格递增（修前会因首列两个标签而红）', () => {
  const year = dayRange('2025-10-26', '2026-10-27', 1000)
  const full = buildCells(year, 364)
  const fullCols = full.months.map((month) => month.column)

  test('一年窗口的标签列严格递增', () => {
    expect(fullCols.every((col, index) => index === 0 || col > fullCols[index - 1])).toBe(true)
  })

  test('标签都是「N月」且不重复列', () => {
    expect(full.months.every((month) => /^\d{1,2}月$/.test(month.label))).toBe(true)
    expect(new Set(fullCols).size).toBe(fullCols.length)
  })

  test('一年窗口至少 11 个标签（跨年不会漏月）', () => {
    expect(full.months.length).toBeGreaterThanOrEqual(11)
  })
})

describe('窗口长度是参数（不再钉死 52 周）', () => {
  test('14 天窗只铺出个位数列，一年窗铺出 50 列以上——同一份 buildCells 两档分明', () => {
    const fortnight = buildCells(dayRange('2026-09-27', '2026-10-10', 100), 14).columns.length
    const annual = buildCells(dayRange('2025-10-26', '2026-10-27', 1000), 364).columns.length
    expect(fortnight).toBeLessThanOrEqual(4)
    expect(annual).toBeGreaterThanOrEqual(50)
  })
})
