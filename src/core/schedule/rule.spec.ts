/**
 * 定时选择器（`core/schedule/rule.ts`）的纯函数测试：解析、下一次触发、DST 两条规则。
 *
 * 全部固定 `UTC` 或明确的 IANA 时区，`nowMs` 由用例显式给——不读本机时钟，换机器/换时区
 * 不漂。重点钉三类容易错的地方：
 *
 * 1. **锚点递推**：`every` 从建任务那一刻起算，不是从 `fromMs` 起算；tick 抖动不能让
 *    「每 30 分钟」漂成 30 分零 7 秒。
 * 2. **Vixie 的日/周 OR**：日字段与周字段都受限时是「或」，只有一个受限时按那一个。
 * 3. **DST**：gap 里的墙上时刻不存在（返回 null，任务顺延）；overlap 只取较早那一次。
 *
 * @module dsc/core/schedule/rule.spec
 */
import { describe, expect, test } from 'vitest'
import {
  formatInstant,
  isValidTimeZone,
  isOneShot,
  isoWeekday,
  localWall,
  nextRunAt,
  offsetAt,
  parseClock,
  parseCron,
  parseDurationSeconds,
  parseRule,
  parseWeekday,
  periodMs,
  wallTimeToInstant,
} from './rule.js'

/** 2026-03-09 09:30 UTC。 */
const NOW = Date.UTC(2026, 2, 9, 9, 30)

describe('parseDurationSeconds：时长写法', () => {
  test('纯数字按秒；s/m/h/d 后缀按单位换算', () => {
    expect(parseDurationSeconds('90')).toBe(90)
    expect(parseDurationSeconds('90s')).toBe(90)
    expect(parseDurationSeconds('5m')).toBe(300)
    expect(parseDurationSeconds('2h')).toBe(7_200)
    expect(parseDurationSeconds('1d')).toBe(86_400)
  })

  test('复合写法 1h30m / 2h5s 相加；大小写与空白不影响', () => {
    expect(parseDurationSeconds(' 1H 30M ')).toBe(5_400)
    expect(parseDurationSeconds('2h5s')).toBe(7_205)
  })

  test('认不出的返回 null，不猜', () => {
    for (const bad of ['', 'abc', '5w', '1.5h', '-5m']) {
      expect(parseDurationSeconds(bad), bad).toBeNull()
    }
  })
})

describe('parseClock / parseWeekday', () => {
  test('HH:MM 与 H:MM 都认；秒被丢掉；越界返回 null', () => {
    expect(parseClock('09:30')).toEqual({ hour: 9, minute: 30 })
    expect(parseClock('9:05')).toEqual({ hour: 9, minute: 5 })
    expect(parseClock('09:30:45')).toEqual({ hour: 9, minute: 30 })
    expect(parseClock('24:00')).toBeNull()
    expect(parseClock('9:5')).toBeNull()
  })

  test('星期几：数字、英文三字母、中文（周一~周日 / 周天）', () => {
    expect(parseWeekday('1')).toBe(1)
    expect(parseWeekday('7')).toBe(7)
    expect(parseWeekday('mon')).toBe(1)
    expect(parseWeekday('Sunday')).toBe(7)
    expect(parseWeekday('周三')).toBe(3)
    expect(parseWeekday('礼拜天')).toBe(7)
    expect(parseWeekday('周八')).toBeNull()
  })
})

describe('parseCron：五字段 Vixie', () => {
  test('通配与步长展开', () => {
    const parsed = parseCron('*/15 * * * *')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.fields.minute).toEqual([0, 15, 30, 45])
    expect(parsed.fields.dayOfMonthRestricted).toBe(false)
    expect(parsed.fields.dayOfWeekRestricted).toBe(false)
  })

  test('范围、列表与周字段归一（7 → 0）', () => {
    const parsed = parseCron('0 9 * * 1-5')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.fields.hour).toEqual([9])
    expect(parsed.fields.dayOfWeek).toEqual([1, 2, 3, 4, 5])
    expect(parsed.fields.dayOfWeekRestricted).toBe(true)
    expect(parsed.fields.dayOfMonthRestricted).toBe(false)

    const sunday = parseCron('0 0 * * 7')
    expect(sunday.ok && sunday.fields.dayOfWeek).toEqual([0])
    const list = parseCron('0 0 1,15 * *')
    expect(list.ok && list.fields.dayOfMonth).toEqual([1, 15])
  })

  test('六段、@宏、L/W/#/?、月名/周名一律拒绝（只做 Vixie，不猜方言）', () => {
    for (const bad of ['0 0 9 * * *', '@daily', '0 0 L * *', '0 0 15W * *', '0 0 * * 1#2', '0 0 ? * *', '0 0 * JAN *', '0 0 * * MON']) {
      const parsed = parseCron(bad)
      expect(parsed.ok, bad).toBe(false)
    }
  })
})

describe('parseRule：六种选择器与报错', () => {
  test('after / every：起点钉在 nowMs 上', () => {
    const after = parseRule('after:5m', 'UTC', NOW)
    expect(after).toEqual({ ok: true, rule: { kind: 'after', seconds: 300, anchorMs: NOW } })
    const every = parseRule('every 30m', 'UTC', NOW)
    expect(every).toEqual({ ok: true, rule: { kind: 'every', seconds: 1_800, anchorMs: NOW } })
  })

  test('after 必须为正；every 有 60 秒下限', () => {
    expect(parseRule('after:0s', 'UTC', NOW).ok).toBe(false)
    expect(parseRule('after:-1m', 'UTC', NOW).ok).toBe(false)
    expect(parseRule('every:30s', 'UTC', NOW).ok).toBe(false)
  })

  test('at：绝对时刻（带 Z / 不带 Z）与今天的 HH:MM', () => {
    const zoned = parseRule('at:2026-03-09T10:30:00Z', 'UTC', NOW)
    expect(zoned).toEqual({ ok: true, rule: { kind: 'at', atMs: Date.UTC(2026, 2, 9, 10, 30) } })
    const local = parseRule('at:2026-03-09T10:30', 'UTC', NOW)
    expect(local.ok && local.rule.kind === 'at' && local.rule.atMs).toBe(Date.UTC(2026, 2, 9, 10, 30))
    // 今天 09:30 已经过了一分钟 → 顺延到明天。
    const nextDay = parseRule('at:09:30', 'UTC', NOW + 60_000)
    expect(nextDay.ok && nextDay.rule.kind === 'at' && nextDay.rule.atMs).toBe(Date.UTC(2026, 2, 10, 9, 30))
  })

  test('at 过去的绝对时刻报错；非法日期报错', () => {
    expect(parseRule('at:2020-01-01T00:00:00Z', 'UTC', NOW).ok).toBe(false)
    expect(parseRule('at:2026-13-40', 'UTC', NOW).ok).toBe(false)
  })

  test('daily / weekly：两种分隔写法都认', () => {
    expect(parseRule('daily:09:30', 'UTC', NOW)).toEqual({
      ok: true,
      rule: { kind: 'daily', hour: 9, minute: 30 },
    })
    expect(parseRule('weekly:mon 09:30', 'UTC', NOW)).toEqual({
      ok: true,
      rule: { kind: 'weekly', weekday: 1, hour: 9, minute: 30 },
    })
    expect(parseRule('weekly:mon:09:30', 'UTC', NOW)).toEqual({
      ok: true,
      rule: { kind: 'weekly', weekday: 1, hour: 9, minute: 30 },
    })
  })

  test('没写关键字时整串当 cron；认不出给六种写法', () => {
    const bare = parseRule('30 9 * * *', 'UTC', NOW)
    expect(bare.ok && bare.rule.kind).toBe('cron')
    const bogus = parseRule('bogus', 'UTC', NOW)
    expect(bogus.ok).toBe(false)
    if (!bogus.ok) expect(bogus.error).toContain('after:5m')
  })

  test('空串与不认识的时区在解析前就拒绝', () => {
    expect(parseRule('', 'UTC', NOW).ok).toBe(false)
    const badZone = parseRule('daily:09:30', 'Mars/Olympus', NOW)
    expect(badZone.ok).toBe(false)
    if (!badZone.ok) expect(badZone.error).toContain('IANA')
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true)
    expect(isValidTimeZone('')).toBe(false)
  })
})

describe('nextRunAt：下一次触发', () => {
  test('after / at 只跑一次，过期返回 null', () => {
    expect(nextRunAt({ kind: 'after', seconds: 60, anchorMs: 1_000 }, 'UTC', 1_000)).toBe(61_000)
    expect(nextRunAt({ kind: 'after', seconds: 60, anchorMs: 1_000 }, 'UTC', 61_000)).toBeNull()
    expect(nextRunAt({ kind: 'at', atMs: 5_000 }, 'UTC', 1_000)).toBe(5_000)
    expect(nextRunAt({ kind: 'at', atMs: 5_000 }, 'UTC', 5_000)).toBeNull()
    expect(isOneShot({ kind: 'daily', hour: 9, minute: 0 })).toBe(false)
    expect(isOneShot({ kind: 'at', atMs: 1 })).toBe(true)
  })

  test('every 按 anchor 栅格递推，不随 fromMs 漂移', () => {
    const rule = { kind: 'every' as const, seconds: 60, anchorMs: 1_000 }
    expect(nextRunAt(rule, 'UTC', 1_000)).toBe(61_000)
    expect(nextRunAt(rule, 'UTC', 61_000)).toBe(121_000)
    expect(nextRunAt(rule, 'UTC', 61_007)).toBe(121_000)
    expect(nextRunAt(rule, 'UTC', 0)).toBe(1_000)
  })

  test('daily：当天已过就明天；weekly：按 ISO 星期几推', () => {
    const daily = { kind: 'daily' as const, hour: 9, minute: 30 }
    expect(nextRunAt(daily, 'UTC', Date.UTC(2026, 2, 9, 8, 0))).toBe(Date.UTC(2026, 2, 9, 9, 30))
    expect(nextRunAt(daily, 'UTC', Date.UTC(2026, 2, 9, 10, 0))).toBe(Date.UTC(2026, 2, 10, 9, 30))

    // 2026-03-09 是周一；周一 09:30 已过 → 下周一。
    const weekly = { kind: 'weekly' as const, weekday: 1, hour: 9, minute: 30 }
    expect(nextRunAt(weekly, 'UTC', Date.UTC(2026, 2, 9, 10, 0))).toBe(Date.UTC(2026, 2, 16, 9, 30))
  })

  test('cron：每 15 分钟 / 每日 09:00 / 四年一次的 2 月 29', () => {
    const quarter = parseCron('*/15 * * * *')
    expect(quarter.ok).toBe(true)
    if (!quarter.ok) return
    expect(nextRunAt({ kind: 'cron', expression: '*/15 * * * *', fields: quarter.fields }, 'UTC', Date.UTC(2026, 2, 9, 9, 30))).toBe(
      Date.UTC(2026, 2, 9, 9, 45),
    )

    const nine = parseCron('0 9 * * *')
    expect(nine.ok).toBe(true)
    if (!nine.ok) return
    expect(nextRunAt({ kind: 'cron', expression: '0 9 * * *', fields: nine.fields }, 'UTC', Date.UTC(2026, 2, 9, 10, 0))).toBe(
      Date.UTC(2026, 2, 10, 9, 0),
    )

    const leap = parseCron('0 0 29 2 *')
    expect(leap.ok).toBe(true)
    if (!leap.ok) return
    expect(nextRunAt({ kind: 'cron', expression: '0 0 29 2 *', fields: leap.fields }, 'UTC', Date.UTC(2026, 2, 9))).toBe(
      Date.UTC(2028, 1, 29),
    )
  })

  test('cron 日/周都受限时是 OR（Vixie 语义）', () => {
    const orFields = parseCron('0 0 1 * 1')
    expect(orFields.ok).toBe(true)
    if (!orFields.ok) return
    // 2026-03-09 周一之后：下周一（3/16）比 4/1 更早。
    expect(
      nextRunAt({ kind: 'cron', expression: '0 0 1 * 1', fields: orFields.fields }, 'UTC', Date.UTC(2026, 2, 9, 10, 0)),
    ).toBe(Date.UTC(2026, 2, 16, 0, 0))
  })

  test('periodMs：一次性任务 null，其余给大概间隔', () => {
    expect(periodMs({ kind: 'after', seconds: 1, anchorMs: 0 }, 'UTC', 0)).toBeNull()
    expect(periodMs({ kind: 'every', seconds: 30, anchorMs: 0 }, 'UTC', 0)).toBe(30_000)
    expect(periodMs({ kind: 'daily', hour: 0, minute: 0 }, 'UTC', 0)).toBe(86_400_000)
  })
})

describe('时区换算与 DST', () => {
  test('localWall / offsetAt / formatInstant：UTC 与上海', () => {
    const instant = Date.UTC(2026, 2, 9, 9, 30)
    expect(localWall(instant, 'UTC')).toEqual({ year: 2026, month: 3, day: 9, hour: 9, minute: 30, second: 0 })
    expect(localWall(instant, 'Asia/Shanghai')).toMatchObject({ hour: 17, minute: 30 })
    expect(offsetAt(instant, 'UTC')).toBe(0)
    expect(offsetAt(instant, 'Asia/Shanghai')).toBe(8 * 3_600_000)
    expect(formatInstant(instant, 'UTC')).toBe('2026-03-09 09:30:00 +00:00')
  })

  test('DST gap：不存在的本地时刻返回 null（任务顺延）', () => {
    // 美国 2026-03-08 02:00 跳到 03:00，02:30 不存在。
    expect(wallTimeToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, 'America/New_York')).toBeNull()
  })

  test('DST overlap：重复的 01:30 只取较早那一次', () => {
    // 2026-11-01 01:30 在纽约出现两次（EDT 05:30Z 与 EST 06:30Z），取较早的。
    expect(wallTimeToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, 'America/New_York')).toBe(
      Date.UTC(2026, 10, 1, 5, 30),
    )
  })

  test('isoWeekday：2026-03-09 是周一', () => {
    expect(isoWeekday({ year: 2026, month: 3, day: 9, hour: 0, minute: 0, second: 0 })).toBe(1)
    expect(isoWeekday({ year: 2026, month: 3, day: 15, hour: 0, minute: 0, second: 0 })).toBe(7)
  })
})
