/**
 * 对话区的时间口径（桌面渲染层 `turn-timing.ts` 的同构移植）：每轮的起止时刻、
 * 进行中状态行的一句话。
 *
 * 三个底层格式化（`entryTs` / `formatClock` / `formatDuration`）已搬去平台种子库
 * （`@dsc/ui-primitives` 的 time）——轨迹页要读同一份，这里只转出去保持调用点不变。
 * 数据缺口的口径见那边的注释：拿不到时间就返回 null，界面不画，绝不显示 NaN。
 *
 * @module dsc-ui-shell/plugins/transcript/timing
 */
import type { TranscriptEntry } from '@dsc/ui'
import { entryTs } from '@dsc/ui-primitives'
import type { RoundInfo } from './rounds'

// 平台种子的读数原样转出（消息流内部的 import 不变）。
export { entryTs, formatClock, formatDuration } from '@dsc/ui-primitives'

// 分轮口径搬去 rounds.ts（一份真值：轮元信息与座位切分同源出来）。这里转出，
// 保持 `RoundInfo` 类型与 `roundInfos` 的导出、签名不变——别处调用点一律不动。
export { roundInfos, type RoundInfo } from './rounds'

/** 这一轮的用时（毫秒）；两头只要有一头没有 ts 就是 null。 */
export function roundDuration(round: RoundInfo): number | null {
  if (round.startTs === null || round.endTs === null) return null
  const ms = round.endTs - round.startTs
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

/** 这一轮是从哪一刻开始的：取最后一条**非插话**的用户消息的 ts（状态行计时用）。 */
export function turnStartedAt(entries: readonly TranscriptEntry[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry !== undefined && entry.kind === 'user' && entry.steering !== true) return entryTs(entry)
  }
  return null
}

// 「现在在干什么」的推导搬去 activity.ts（零依赖纯函数：探针要直接 import 它）。
// 这里转出，调用点与类型名一个都不用改。
export { liveActivity, type LiveActivity } from './activity'
