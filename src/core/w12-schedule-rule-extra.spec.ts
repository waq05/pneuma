/**
 * 定时选择器（`core/schedule/rule.ts`）的边角补齐：cron 字段展开的错误路径、
 * `at` 的 DST 跳表、weekly 缺时刻、cron 永远不匹配、DST gap 跳过、
 * periodMs 的 weekly/cron、describeNext 的两种「没有下一次」、normalizeRule 的兜底。
 *
 * @module dsc/core/w12-schedule-rule-extra.spec
 */
import { describe, expect, test } from 'vitest'
import {
  describeNext,
  isValidTimeZone,
  nextRunAt,
  normalizeRule,
  parseCron,
  parseRule,
  periodMs,
  systemTimeZone,
} from './schedule/rule.js'

/** 2026-03-09 09:30 UTC（周一）。 */
const NOW = Date.UTC(2026, 2, 9, 9, 30)

describe('systemTimeZone', () => {
  test('返回一个可用的 IANA 时区（认不出时退回 UTC）', () => {
    const zone = systemTimeZone()
    expect(typeof zone).toBe('string')
    expect(zone.length).toBeGreaterThan(0)
    expect(isValidTimeZone(zone) || zone === 'UTC').toBe(true)
  })
})

describe('parseCron 的字段展开错误', () => {
  test('步长为 0、范围两端非数字、取值越界分别给出可读错误', () => {
    const step = parseCron('*/0 * * * *')
    expect(step.ok).toBe(false)
    if (!step.ok) expect(step.error).toContain('步长要大于 0')

    const nonNumeric = parseCron('1-* * * * *')
    expect(nonNumeric.ok).toBe(false)
    if (!nonNumeric.ok) expect(nonNumeric.error).toContain('范围两端都要是数字')

    const outOfRange = parseCron('70 * * * *')
    expect(outOfRange.ok).toBe(false)
    if (!outOfRange.ok) expect(outOfRange.error).toContain('取值要在 0~59 之间')
  })
})

describe('parseRule 的 at 与 weekly', () => {
  test('at 后面不是能读懂的格式：报错并给示例', () => {
    const parsed = parseRule('at:不是时刻', 'UTC', NOW)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('不是一个能读懂的时刻')
  })

  test('at 落进夏令时跳表：该本地时刻不存在，解析报错', () => {
    // 英国 2026-03-29 01:00 UTC 跳到 02:00，01:30 这个本地时刻不存在。
    const parsed = parseRule('at:2026-03-29T01:30', 'Europe/London', Date.UTC(2026, 2, 1))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('不存在')
  })

  test('weekly 只写星期几不写时刻：报错并给示例', () => {
    const parsed = parseRule('weekly:mon', 'UTC', NOW)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('weekly 后面要写')
  })
})

describe('nextRunAt 的边界', () => {
  test('cron 永远不匹配（2 月 31 日）：扫到上限返回 null', () => {
    const parsed = parseCron('0 0 31 2 *')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(nextRunAt({ kind: 'cron', expression: '0 0 31 2 *', fields: parsed.fields }, 'UTC', NOW)).toBeNull()
  })

  test('DST gap 的那一分钟被跳过：3/8 的 02:30 不存在，顺延到 3/9', () => {
    // 2026-03-08 00:00 EST = 05:00Z；02:00 直接跳到 03:00，02:30 不存在。
    const parsed = parseCron('30 2 * * *')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const next = nextRunAt({ kind: 'cron', expression: '30 2 * * *', fields: parsed.fields }, 'America/New_York', Date.UTC(2026, 2, 8, 5, 0))
    // 3/9 02:30 EDT = 06:30Z
    expect(next).toBe(Date.UTC(2026, 2, 9, 6, 30))
  })
})

describe('periodMs 与文案', () => {
  test('weekly 固定 7 天；cron 用相邻两次触发相减', () => {
    expect(periodMs({ kind: 'weekly', weekday: 1, hour: 9, minute: 30 }, 'UTC', NOW)).toBe(7 * 86_400_000)
    const parsed = parseCron('*/15 * * * *')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(periodMs({ kind: 'cron', expression: '*/15 * * * *', fields: parsed.fields }, 'UTC', NOW)).toBe(15 * 60_000)
    // 永远不匹配的 cron 算不出周期
    const impossible = parseCron('0 0 31 2 *')
    if (impossible.ok) {
      expect(periodMs({ kind: 'cron', expression: '0 0 31 2 *', fields: impossible.fields }, 'UTC', NOW)).toBeNull()
    }
  })

  test('describeNext：一次性任务说跑完了，算不出的说检查规则', () => {
    expect(describeNext({ kind: 'at', atMs: 1 }, 'UTC', null)).toBe('已经跑完（一次性任务）')
    expect(describeNext({ kind: 'daily', hour: 9, minute: 0 }, 'UTC', null)).toBe('算不出下一次触发时刻，请检查规则')
    expect(describeNext({ kind: 'daily', hour: 9, minute: 0 }, 'UTC', NOW)).toContain('下次')
  })
})

describe('normalizeRule 的兜底', () => {
  test('认不出的 kind、非对象、坏 cron 都返回 null', () => {
    expect(normalizeRule({ kind: 'bogus' })).toBeNull()
    expect(normalizeRule(null)).toBeNull()
    expect(normalizeRule('after:5m')).toBeNull()
    expect(normalizeRule({ kind: 'cron', expression: '不是 cron' })).toBeNull()
  })

  test('合法规则原样收敛（数值取整）', () => {
    expect(normalizeRule({ kind: 'every', seconds: 90.6, anchorMs: 1000.4 })).toEqual({
      kind: 'every',
      seconds: 91,
      anchorMs: 1000,
    })
  })
})


