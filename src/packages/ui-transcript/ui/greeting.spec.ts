/**
 * 空会话首屏招呼语的时段判定与换档定时（迁自 `scripts/ui-welcome-greeting-test.mjs`
 * 第 [1][2][4][5] 段）。
 *
 * 2026-11-10 用户要求放弃「9 组 × 5 句」的池子方案，改成 zcode 的按时段一句 + codex 的
 * 「不寒暄，只给下一步」：问候语只按现在几点挑一句，每段一句；「能干什么」交给首屏提示
 * 与四张卡。判定在 `greeting.ts`（纯函数），文案在两份字典里。
 *
 * 为什么是行为测试：`greeting.ts` 零依赖纯函数，`greetingSlot`（按时段选句）与
 * `nextGreetingBoundaryDelayMs`（到整点才换、永远给正数）的真跑结果就是被测行为；
 * 字典的六段键、长度上限、中英对齐是运行时数据（不是源码），对着字典本身查。
 *
 * 不迁的部分（原探针第 [1] 末尾与第 [3] 段，见交付报告缺口清单）：
 * welcome.tsx 的文案表接线（逐句字面量取词、`GREETING_TEXT[slot]` 查表、H1 造型）与
 * ui.tsx 的接线钉（时钟递进来、到点重绘定时器、折行兜底样式）——渲染接线，归组件渲染批。
 * 第 [4] 段里「greeting.ts 不再导出句数常量」改成了公开面检查（导出名清单恰好四个），
 * 「weekend / returning / firstRun 不在源码里」这条源码钉随旧方案一起退役——判定函数
 * 已经没有这些分岔可走，公开面检查抓得住「又长出分岔」的回归。
 *
 * @module dsc-ui-transcript/ui/greeting.spec
 */
import { describe, expect, test } from 'vitest'
import * as greeting from './greeting.js'
import { greetingSlot, nextGreetingBoundaryDelayMs } from './greeting.js'
import en from '../locale/ui.en.json'
import zh from '../locale/ui.zh.json'

/** 六个时段的固定清单（与 `GreetingSlot` 对齐）。 */
const SLOTS = ['earlyMorning', 'morning', 'noon', 'afternoon', 'evening', 'lateNight'] as const

/** 一周里的某一天：`2026-11-02` 起跳到第一个周二，所有用例都从它派生。 */
function weekdayAt(hour: number, minute = 0): Date {
  const at = new Date(2026, 10, 2, hour, minute, 0, 0)
  while (at.getDay() !== 2) at.setDate(at.getDate() + 1)
  return at
}

describe('文案表：六段各一句，中英对齐，长度不超上限', () => {
  const KEY = /^transcript\.welcome\.hello\.([A-Za-z]+)$/
  const keysOf = (dict: Record<string, unknown>): string[] =>
    Object.keys(dict)
      .filter((key) => KEY.test(key))
      .sort()
  const expected = SLOTS.map((slot) => `transcript.welcome.hello.${slot}`).sort()

  test('中文与英文表里正好是这六段', () => {
    expect(keysOf(zh)).toEqual(expected)
    expect(keysOf(en)).toEqual(expected)
  })

  test('六句都非空、中文不超过 18 字（28px 的 H1 超了就折行、首屏重心散）', () => {
    const problems: string[] = []
    for (const slot of SLOTS) {
      const value = (zh as Record<string, string>)[`transcript.welcome.hello.${slot}`]
      if (value === undefined || value.trim() === '') problems.push(`${slot} 是空的`)
      const length = [...value].length
      if (length > 18) problems.push(`${slot} 有 ${length} 个字`)
    }
    expect(problems).toEqual([])
  })

  test('英文不超过 64 字符、没有漏译（不出现汉字）', () => {
    const problems: string[] = []
    for (const slot of SLOTS) {
      const value = (en as Record<string, string>)[`transcript.welcome.hello.${slot}`] ?? ''
      if ([...value].length > 64) problems.push(`${slot} 有 ${value.length} 个字符`)
      if (/[\u4e00-\u9fff]/.test(value)) problems.push(`${slot} 还是中文`)
    }
    expect(problems).toEqual([])
  })

  test('两个字典都不留「组 + 序号」的旧键（老方案已撤）', () => {
    const numbered = (dict: Record<string, unknown>): number =>
      Object.keys(dict).filter((key) => /^transcript\.welcome\.hello\.[A-Za-z]+\.\d+$/.test(key)).length
    expect(numbered(zh)).toBe(0)
    expect(numbered(en)).toBe(0)
  })

  test('公开面恰好是两个判定函数（不再导出句数常量）', () => {
    expect(Object.keys(greeting).sort()).toEqual(['greetingSlot', 'nextGreetingBoundaryDelayMs'])
  })
})

describe('时段边界：左闭右开，深夜跨零点', () => {
  const CASES: ReadonlyArray<readonly [number, number, (typeof SLOTS)[number]]> = [
    [0, 0, 'lateNight'],
    [4, 59, 'lateNight'],
    [5, 0, 'earlyMorning'],
    [8, 59, 'earlyMorning'],
    [9, 0, 'morning'],
    [11, 59, 'morning'],
    [12, 0, 'noon'],
    [13, 59, 'noon'],
    [14, 0, 'afternoon'],
    [17, 59, 'afternoon'],
    [18, 0, 'evening'],
    [22, 59, 'evening'],
    [23, 0, 'lateNight'],
  ]

  test('13 个边界都对', () => {
    const wrong = CASES.filter(([hour, minute, slot]) => greetingSlot({ at: weekdayAt(hour, minute) }) !== slot)
    expect(
      wrong.map(([hour, minute, slot]) => `${hour}:${String(minute).padStart(2, '0')} 应为 ${slot}`),
    ).toEqual([])
  })

  test('六个时段都各不相同；同一天里问两次，答案一样', () => {
    const at = (hour: number): string => greetingSlot({ at: weekdayAt(hour) })
    expect(new Set([6, 10, 13, 15, 20, 23].map(at)).size).toBe(6)
    expect(at(15)).toBe(at(15))
  })
})

describe('换档定时：到整点才换，永远给正数', () => {
  const at = (hour: number, minute = 0, second = 0): Date => {
    const date = weekdayAt(hour, minute)
    date.setSeconds(second, 0)
    return date
  }
  const toMinutes = (ms: number): number => Math.round(ms / 60_000)

  test('08:59 挂 1 分钟，09:00 换档', () => {
    expect(nextGreetingBoundaryDelayMs(at(8, 59))).toBe(60_000)
  })

  test('04:59:30 只挂 30 秒', () => {
    expect(nextGreetingBoundaryDelayMs(at(4, 59, 30))).toBe(30_000)
  })

  test('23:30 挂到次日 05:00（330 分钟）', () => {
    expect(toMinutes(nextGreetingBoundaryDelayMs(at(23, 30)))).toBe(330)
  })

  test('09:00:00 给的是 3 小时后，不是 0（给 0 定时器会原地空转，每帧重绘）', () => {
    expect(nextGreetingBoundaryDelayMs(at(9))).toBe(3 * 3_600_000)
  })

  test('间隔始终是正数，最长不超过 6 小时', () => {
    let shortest = Number.POSITIVE_INFINITY
    let longest = 0
    for (const hour of [0, 4, 5, 8, 9, 11, 12, 13, 14, 17, 18, 22, 23]) {
      for (const minute of [0, 1, 30, 59]) {
        const delay = nextGreetingBoundaryDelayMs(at(hour, minute, 7))
        shortest = Math.min(shortest, delay)
        longest = Math.max(longest, delay)
      }
    }
    expect(shortest).toBeGreaterThanOrEqual(1)
    expect(longest).toBeLessThanOrEqual(6 * 3_600_000)
  })

  test('一整天按定时器走，六段依次换过', () => {
    let cursor = at(0, 0, 0)
    const seen = [greetingSlot({ at: cursor })]
    for (let index = 0; index < 12; index += 1) {
      cursor = new Date(cursor.getTime() + nextGreetingBoundaryDelayMs(cursor))
      seen.push(greetingSlot({ at: cursor }))
    }
    expect(seen.slice(0, 7).join('>')).toBe('lateNight>earlyMorning>morning>noon>afternoon>evening>lateNight')
  })
})
