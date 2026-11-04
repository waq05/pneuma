/**
 * 今日用量的共享 hook（2026-10-25，P1-5）。
 *
 * 为什么抽出来：侧栏页脚原来自己拉一次 `usageStats`，状态栏又是另一份需求（想在不展开
 * 侧栏时也看得见金额）。两处各写一遍，就会出现"页脚 12.3K / 状态栏 11.9K"这种自相矛盾——
 * 不是数据错，是两边取数时刻不同。这里只留一份取数口径，两个消费方共用。
 *
 * 「今天」的判定不在壳里：宿主 `usageStats` 把逐日补零到本地今天，`days` 末位就是今天。
 * 壳只挑末位，不自己算日期（时区、跨零点补零都归宿主）。
 *
 * 刷新：调用方给一个 `refreshKey`（通常是本会话累计 token），它一变就重取；另外 60 秒
 * 兜底轮询——别的窗口/后台宿主的请求不会往本窗口推快照。
 *
 * @module dsc-ui-shell/ui-layout/usage-today
 */
import { useEffect, useState } from 'react'
import { useHostChannel } from './runtime-context'

/** `usageStats` 里壳用到的那两列（形状原件见 contract.ts 的 UsageStatsView / UsageDayView）。 */
interface UsageStatsShape {
  days: { inputTokens: number; outputTokens: number; costCny?: number | null }[]
}

/** 今日读数：token 合计与估算金额（宿主算不出金额时是 null）。 */
export interface TodayUsage {
  tokens: number
  cost: number | null
}

/** 空读数：还没有任何记录时用它（不是"读取中"，是"确实是 0"）。 */
const EMPTY: TodayUsage = { tokens: 0, cost: null }

/**
 * 今日用量。
 *
 * @param refreshKey 变化即重取（一般传本会话累计 token）
 */
export function useTodayUsage(refreshKey: unknown = null): TodayUsage {
  const channel = useHostChannel()
  const [today, setToday] = useState<TodayUsage>(EMPTY)

  useEffect(() => {
    let active = true
    const load = (): void => {
      void channel
        .invoke<UsageStatsShape>('usageStats')
        .then((stats) => {
          if (!active) return
          const day = stats.days[stats.days.length - 1]
          setToday({
            tokens: day === undefined ? 0 : day.inputTokens + day.outputTokens,
            cost: day?.costCny ?? null,
          })
        })
        // 读失败维持上一次读数：这是一块小面板，不值得弹错打断。
        .catch(() => undefined)
    }
    load()
    const timer = window.setInterval(load, 60_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [channel, refreshKey])

  return today
}
