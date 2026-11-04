/**
 * 时间口径（纯函数）：把条目上的 `ts` 与各种毫秒数格式化成界面读得懂的文字。
 *
 * 为什么从消息流插件里搬出来：轨迹页与对话页对「时刻 / 用时」的读法必须同一份
 * ——同一个数在两处显示成两种写法，用户会以为是两个不同的数。壳里插件之间不能
 * 互相 import（各自独立打包），共用件只能住平台层。
 *
 * 数据缺口（消息流与轨迹页共同的难点）：transcript 条目上的 `ts` 是可选的——
 * 2026-09 之前的会话日志没记时间。所以每个函数对「没有 ts」「ts 不是有限数」
 * 「用时算出来是负的」一律返回 null，由界面决定「不画」。绝不显示 NaN，
 * 也不拿「现在」冒充历史时刻。
 *
 * @module dsc-ui-shell/platform/time
 */
import type { TranscriptEntry } from '@dsc/ui-core'

/** 取出条目上可信的时间戳；没有或不是有限正数就是 null。 */
export function entryTs(entry: TranscriptEntry | undefined): number | null {
  if (entry === undefined) return null
  const ts = entry.ts
  return typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : null
}

/** 毫秒时间戳 → 本机时区的 `HH:mm`；拿不到合法时间戳返回 null。 */
export function formatClock(ts: number | null): string | null {
  if (ts === null || !Number.isFinite(ts) || ts <= 0) return null
  const at = new Date(ts)
  if (Number.isNaN(at.getTime())) return null
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** 精确到秒的时刻 `HH:mm:ss`（时间条悬停提示、检查器用；行内只给 HH:mm）。 */
export function formatClockSeconds(ts: number | null): string | null {
  if (ts === null || !Number.isFinite(ts) || ts <= 0) return null
  const at = new Date(ts)
  if (Number.isNaN(at.getTime())) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

/**
 * 毫秒 → 「2分41秒」/「8秒」/「1时02分05秒」（对话页的中文口径）。
 * 不足 1 秒也写「1秒」：真实耗时可以是 400ms，写「0秒」看着像坏了。
 */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null
  const total = Math.max(1, Math.round(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (hours > 0) return `${String(hours)}时${pad(minutes)}分${pad(seconds)}秒`
  if (minutes > 0) return `${String(minutes)}分${String(seconds)}秒`
  return `${String(seconds)}秒`
}

/**
 * 工具耗时格式化：`4.2s` / `1m03s` / `2h05m`（轨迹页的读数口径，对照 dsh）。
 *
 * 为什么不足 1 秒也带一位小数：真实的工具调用常是几百毫秒，写成 `0s` 看着像坏了。
 * 拿不到（null / NaN / 负数）返回 null——界面据此不画这一项，绝不显示 0 秒。
 */
export function formatTraceDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null
  // 先四舍五入到 0.1 秒再决定用秒还是用分：59.96s 不该印成「60.0s」。
  const tenths = Math.round(ms / 100) / 10
  if (tenths < 60) return `${tenths.toFixed(1)}s`
  const total = Math.round(ms / 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${String(hours)}h${pad(minutes)}m`
  return `${String(minutes)}m${pad(seconds)}s`
}
