/**
 * 空会话首屏那句招呼语：先按现场挑一组，再从组里挑一句。
 *
 * 为什么单独一个文件：首屏那块是 TSX，Node 侧的自检探针 import 不了。把「挑哪一句」的
 * 判定摘出来放成纯函数，边界（几点算深夜、周末和时段谁优先、隔天换不换句）才能被机器
 * 钉住；文案本身仍留在 `welcome.tsx` 的字面量表里——文案闸只认字面量 `t('...')`。
 *
 * 优先级从高到低：第一次用 → 久未使用 → 周末 → 时段。
 * 前三个是「有由头」的组：人刚装好、隔了些天回来、今天周六日，这几件事都比「现在几点」
 * 更值得说一句。时段殿后，因为它天天成立，不该压过头一回和久别重逢。
 *
 * @module dsc-ui-shell/plugins/transcript/greeting
 */

/** 招呼语的九个组：六个时段，加周末、久未使用、第一次用。 */
export type GreetingSlot =
  | 'earlyMorning'
  | 'morning'
  | 'noon'
  | 'afternoon'
  | 'evening'
  | 'lateNight'
  | 'weekend'
  | 'returning'
  | 'firstRun'

/** 每组几句。文案表在 `welcome.tsx`，两边由自检对齐。 */
export const GREETING_VARIANTS = 5

/**
 * 组的固定次序：组内第几句用它的位置做偏移，同一天里相邻两组的句子因此不重样。
 * 这个次序只影响「第几句」，不影响哪一组被选中，随时可以调。
 */
const ORDER: readonly GreetingSlot[] = [
  'earlyMorning',
  'morning',
  'noon',
  'afternoon',
  'evening',
  'lateNight',
  'weekend',
  'returning',
  'firstRun',
]

/** 挑一句招呼语要的现场。 */
export interface GreetingFacts {
  /** 现在（本机时区）。传进来而不是在函数里现取，自检才能拿固定时刻试边界。 */
  at: Date
  /** 除当前这条空会话外，还有没有别的会话。false 就是第一次打开。 */
  hasHistory: boolean
  /** 有历史，但最近一次写入超过七天：隔了好些天才回来。 */
  longAbsence: boolean
}

/** 挑出来的结果：哪一组、组里第几句。 */
export interface GreetingPick {
  slot: GreetingSlot
  index: number
}

/**
 * 按本机小时判定时段。边界一律左闭右开：05:00 算清晨，08:00 才算上午。
 *
 * 深夜跨零点，所以 0–5 点单独一支——不单独判的话会顺着 `hour < 12` 落进上午，
 * 半夜打开看到「上午时间最整」。
 */
function slotOfHour(hour: number): GreetingSlot {
  if (hour < 5) return 'lateNight'
  if (hour < 8) return 'earlyMorning'
  if (hour < 12) return 'morning'
  if (hour < 14) return 'noon'
  if (hour < 18) return 'afternoon'
  if (hour < 23) return 'evening'
  return 'lateNight'
}

/**
 * 挑一句招呼语。
 *
 * 组内第几句由「当天」决定：同一天同一组永远同一句，隔天换下一句。这样既不会在眼前
 * 跳字，也不至于一年到头看同一行。
 *
 * 为什么用 `Date.UTC(年, 月, 日)` 折算天数、而不是拿 `new Date(y, 0, 1)` 相减算年内
 * 第几天：相减得的是本机时区的毫秒差，在有夏令时的时区会差一小时，除以一天的毫秒再
 * 取整就会错一天。UTC 没有夏令时，当天零点除以一天永远是整数，每过一天必增一。
 */
export function greetingSlot(facts: GreetingFacts): GreetingPick {
  const { at, hasHistory, longAbsence } = facts
  const weekday = at.getDay()
  const slot: GreetingSlot = !hasHistory
    ? 'firstRun'
    : longAbsence
      ? 'returning'
      : weekday === 0 || weekday === 6
        ? 'weekend'
        : slotOfHour(at.getHours())
  const day = Math.floor(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) / 86_400_000)
  return { slot, index: (day + ORDER.indexOf(slot)) % GREETING_VARIANTS }
}
