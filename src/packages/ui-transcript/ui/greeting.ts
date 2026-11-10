/**
 * 空会话首屏那句招呼语：只按现在几点挑一句。
 *
 * 为什么不按「周末 / 隔了些天回来 / 头一回打开」再分岔（2026-11-10 用户要求放弃原方案）：
 * 分岔一多，每个岔口都得凑够句子，凑出来的就是「下午还有一段整时间，够用」这种没话找话。
 * 对着 zcode 和 codex 各看了一遍之后取中间：zcode 只按时段给一句，codex 干脆不寒暄、
 * 只告诉你下一步能干什么。这里保留前者，后者交给首屏那行提示和四张卡。
 *
 * 判定摘成纯函数：边界（几点算深夜）才能被自检钉住；文案仍留在 `welcome.tsx` 的字面量
 * 表里——文案闸只认字面量 `t('...')`。
 *
 * @module dsc-ui-shell/plugins/transcript/greeting
 */

/** 招呼语的六个时段。 */
export type GreetingSlot =
  | 'earlyMorning'
  | 'morning'
  | 'noon'
  | 'afternoon'
  | 'evening'
  | 'lateNight'

/** 挑一句招呼语要的现场。 */
export interface GreetingFacts {
  /** 现在（本机时区）。传进来而不是在函数里现取，自检才能拿固定时刻试边界。 */
  at: Date
}

/**
 * 按本机小时判定时段。边界一律左闭右开，与 zcode 的分档一致：
 * 05:00 清晨、09:00 上午、12:00 中午、14:00 下午、18:00 晚上、23:00 深夜。
 *
 * 深夜跨零点（23:00–04:59），所以两支都用 `lateNight`——不单独判的话，
 * 零点到五点会顺着 `hour < 12` 落进上午，半夜打开看到「上午好」。
 */
export function greetingSlot({ at }: GreetingFacts): GreetingSlot {
  const hour = at.getHours()
  if (hour < 5) return 'lateNight'
  if (hour < 9) return 'earlyMorning'
  if (hour < 12) return 'morning'
  if (hour < 14) return 'noon'
  if (hour < 18) return 'afternoon'
  if (hour < 23) return 'evening'
  return 'lateNight'
}

/** 换档的整点，与 `greetingSlot` 的分档一一对应。 */
const BOUNDARY_HOURS = [5, 9, 12, 14, 18, 23] as const

/**
 * 距离下一次换档还有多少毫秒。
 *
 * 为什么要有这个数：首屏那句招呼语只在重绘时读时钟。窗口挂一晚上不动，过了 18:00 第一位
 * 还是「下午好」。拿这个数挂一个定时器，到点重绘一次就换过来了——zcode 的首屏是这么做的
 * （`getNextChatEmptyGreetingDelayMs`）。
 *
 * 返回永远 ≥ 1：正好卡在边界上时给的是**下一个**边界，而不是 0。给 0 的话定时器会原地
 * 空转，每一帧都重绘一次。
 */
export function nextGreetingBoundaryDelayMs(at: Date): number {
  const now = at.getTime()
  const candidates = BOUNDARY_HOURS.map((hour) => {
    const boundary = new Date(now)
    boundary.setHours(hour, 0, 0, 0)
    return boundary.getTime()
  })
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(BOUNDARY_HOURS[0], 0, 0, 0)
  const next = candidates.find((time) => time > now) ?? tomorrow.getTime()
  return Math.max(1, next - now)
}
