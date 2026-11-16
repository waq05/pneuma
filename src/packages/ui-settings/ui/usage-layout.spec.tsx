/**
 * 设置 → 用量统计的接线（`usage.tsx`）渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-usage-layout-test.mjs` 第 [1] 段（缺口清单 B37）。原探针钉 `usage.tsx`
 * 的源码文本（四档常量、`dsc-segmented`、`.hm-scroll > .hm-canvas`、`heatDays` 截取）；
 * 这里真渲染 UsageGroup，喂一份多天用量：
 * - 四档时间窗按钮都在（今天 / 近 7 天 / 近 30 天 / 近一年），默认近一年；
 * - 热力图是唯一的横向滚动容器（`.hm-scroll > .hm-canvas > .hm-body`），画布跟着网格走；
 * - 点「今天」后 `heatDays` 只截末位一天（格子数跟着变）——`slice(-heatRange)` 的行为面。
 *
 * 不迁的（见交付报告缺口清单）：
 * - 第 [2] 段 CSS 算术（`.donut-row` 换行、`.hm-scroll` 横向滚、窄屏环 150px）是样式表钉，
 *   jsdom 无布局，转 shots；
 * - 第 [1b] 段月份标签已在 `heatmap.spec.ts`（`buildCells` 真跑）；
 * - 第 [4] 段负向自证是探针自己的扫描器自检，本文件的反向验证（改坏 `buildCells` 守卫）
 *   等价。
 *
 * @module dsc-ui-settings/ui/usage-layout.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { UsageDayView } from '@dsc/ui'
import { UsageGroup } from './usage.js'

afterEach(cleanup)

/** 三天用量（默认近一年档会全画出来）。 */
const daysOf = (): UsageDayView[] => [
  { date: '2026-11-13', inputTokens: 100, outputTokens: 50, turns: 1, byModel: {} },
  { date: '2026-11-14', inputTokens: 200, outputTokens: 100, turns: 2, byModel: {} },
  { date: '2026-11-15', inputTokens: 300, outputTokens: 150, turns: 3, byModel: {} },
]

/** 假通道：只答 usageStats。 */
function makeChannel(): HostChannel {
  const stats = {
    sinceTs: 1,
    totalInputTokens: 600,
    totalOutputTokens: 300,
    totalCacheHitTokens: 0,
    totalCacheMissTokens: 0,
    totalTurns: 6,
    activeDays: 3,
    currentStreakDays: 3,
    longestStreakDays: 3,
    peakDay: daysOf()[2],
    days: daysOf(),
    models: [{ key: 'deepseek/deepseek-chat', inputTokens: 600, outputTokens: 300, turns: 6, cacheHitTokens: 0, cacheMissTokens: 0 }],
  }
  return {
    getSnapshot: () => null,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string): Promise<T> =>
      (method === 'usageStats' ? Promise.resolve(stats) : Promise.resolve({})) as Promise<T>) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

const mount = (): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={makeChannel()}>
      <UsageGroup />
    </RuntimeProvider>,
  )

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

const heatButtons = (container: HTMLElement): HTMLButtonElement[] =>
  [...container.querySelectorAll('.usage-block .dsc-segmented__btn')].slice(0, 4) as HTMLButtonElement[]

const gridCells = (container: HTMLElement): number => container.querySelectorAll('.hm-grid > .hm-cell').length

describe('四档时间窗与热力图容器', () => {
  test('四档按钮都在，默认近一年；热力图是 .hm-scroll > .hm-canvas > .hm-body 唯一横滚层', async () => {
    const { container } = mount()
    await flush()
    expect(container.querySelector('.usage')).toBeTruthy()
    const buttons = heatButtons(container)
    expect(buttons.map((button) => button.textContent)).toEqual(['今天', '近 7 天', '近 30 天', '近一年'])
    expect(buttons[3]?.getAttribute('aria-selected')).toBe('true')
    // 近一年窗口把网格铺满 365 格，其中三天有数据（其余是补零格）。
    expect(gridCells(container)).toBe(365)
    expect(container.querySelectorAll('.hm-grid > .hm-cell:not(.hm-l0)')).toHaveLength(3)
    const scroll = container.querySelector('.hm-scroll') as HTMLElement
    expect(scroll).toBeTruthy()
    expect(scroll.firstElementChild?.className).toBe('hm-canvas')
    expect(scroll.querySelector('.hm-body > .hm-grid')).toBeTruthy()
    // 页面上没有第二个横向滚动容器（模态外的图表不自己滚）。
    expect(container.querySelectorAll('.hm-scroll')).toHaveLength(1)
  })

  test('点「今天」：heatDays 只取末位一天，格子数跟着变（不是画完一年再靠滑）', async () => {
    const { container } = mount()
    await flush()
    const today = heatButtons(container)[0] as HTMLButtonElement
    await act(async () => {
      fireEvent.click(today)
      await Promise.resolve()
    })
    expect(today.getAttribute('aria-selected')).toBe('true')
    expect(gridCells(container)).toBe(1)
    // 月份标签列不重复（同一列只挂一个）。
    const columns = [...container.querySelectorAll('.hm-months > span')].map((node) => (node as HTMLElement).style.left)
    expect(new Set(columns).size).toBe(columns.length)
  })
})
