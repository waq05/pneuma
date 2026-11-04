/**
 * 热力图的纯布局：把逐日用量排成「周日打头」的列，并算出月份标签该落在哪一列。
 *
 * 为什么从 `usage.tsx` 里拆出来：月份标签重叠这类错只有真算一遍才抓得到
 * （2026-10-27 报障：窗口从周日起、月初又落在同一列时，「10月」与「11月」两个标签
 * 被钉在同一个 left 上，叠成一团）。拆成纯模块之后 Node 探针能直接跑 `buildCells`，
 * 不必把整个 React 文件拖进测试。
 *
 * @module dsc-ui-shell/plugins/settings/heatmap
 */
import type { UsageDayView } from '@dsc/ui'

/** 格子边长与间距（px）：设置面板正文宽度约 690px，53 列刚好放下。 */
export const CELL = 10
export const GAP = 3

export type HeatCell = { day: UsageDayView; level: number } | null

/** 一列里的每一天；`null` = 窗口起点之前的空档。 */
export type HeatColumn = HeatCell[]

/** 月份标签：挂到第 `column` 列上。 */
export interface HeatMonth {
  column: number
  label: string
}

/** 热力图格子：0 = 空档，1..4 = 由少到多。颜色档位见 styles.css 的 .hm-l*。 */
export function buildCells(
  days: UsageDayView[],
  windowDays: number,
): { columns: HeatColumn[]; months: HeatMonth[] } {
  const max = Math.max(1, ...days.map((day) => day.inputTokens + day.outputTokens))
  const level = (day: UsageDayView): number => {
    const tokens = day.inputTokens + day.outputTokens
    if (tokens <= 0) return 0
    const ratio = tokens / max
    if (ratio > 0.66) return 4
    if (ratio > 0.33) return 3
    if (ratio > 0.1) return 2
    return 1
  }
  const columns: HeatColumn[] = []
  let current: HeatCell[] = []
  const months: HeatMonth[] = []
  let lastMonth = -1
  /** 一天进列（真实数据与前置空档都走这条），满了就整列收进 columns。 */
  const pushDay = (cell: HeatCell, date: Date): void => {
    if (date.getMonth() !== lastMonth) {
      // 月份切换处记一列（列里只要还有一格就能挂标签）。
      //
      // 同一列只挂一个标签：窗口从周日起时，第一列里可能同时有上个月的尾巴和
      // 新一个月的 1 号（2025-10-26 起的那一列里就有 11 月 1 日）。两首都 push
      // 的话 `left` 完全相同，标签直接叠字（2026-10-27 报障「10和11月重叠」）。
      // 保留先到的那一个（占这列天数更多的那个月），跳过后来者。
      if (current.length < 7 && !months.some((month) => month.column === columns.length)) {
        months.push({ column: columns.length, label: `${String(date.getMonth() + 1)}月` })
      }
      lastMonth = date.getMonth()
    }
    current.push(cell)
    if (current.length === 7) {
      columns.push(current)
      current = []
    }
  }
  // 窗口从今天回溯一整年、对齐到周日（GitHub 的列从周日开始）：
  // 数据只覆盖其中一段，前面的空档也照常铺格子、标月份，热力图才是一张
  // 完整的年历，而不是孤零零贴着左边的一小列。数据早于窗口时以数据起点为准。
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const firstDate = new Date(`${days[0]?.date ?? ''}T12:00:00`)
  // 窗口长度由用户选的那一档给（今天 / 7 天 / 30 天 / 一年）：以前钉死一年，
  // 手机上 53 列整块横出屏幕，想只看这几天就只能自己认列（2026-10-27 报障第 4 条）。
  const windowStart = new Date(today.getTime() - Math.max(0, windowDays - 1) * 86400000)
  const alignedStart = new Date(Math.min(firstDate.getTime(), windowStart.getTime()))
  alignedStart.setDate(alignedStart.getDate() - alignedStart.getDay())
  for (let at = new Date(alignedStart); at < firstDate; at.setDate(at.getDate() + 1)) {
    pushDay(null, new Date(at.getTime()))
  }
  for (const day of days) {
    pushDay({ day, level: level(day) }, new Date(`${day.date}T12:00:00`))
  }
  if (current.length > 0) columns.push(current)
  return { columns, months }
}
