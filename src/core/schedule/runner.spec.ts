/**
 * 调度器（`core/schedule/runner.ts`）的纯决策面：补跑策略、失败分类、重试阶梯、投递文案。
 *
 * 这一批刻意不碰 `ScheduleRunner` 的定时器与文件落盘（那部分归 store 与集成层）：
 * 先钉最容易写错、又最容易在没有机器等待时验证的决策函数。
 *
 * @module dsc/core/schedule/runner.spec
 */
import { describe, expect, test } from 'vitest'
import type { ScheduleRule } from './rule.js'
import { describeRule, formatDuration, graceMs } from './rule.js'
import {
  classifyFailure,
  decideOccurrence,
  deliveryText,
  planFailure,
  quotaHoldMs,
  RETRY_LADDER_MS,
  DEFAULT_QUOTA_HOLD_MS,
} from './runner.js'
import type { ScheduleTask } from './store.js'

/** 2026-03-09 09:30 UTC。 */
const NOW = Date.UTC(2026, 2, 9, 9, 30)

/** 一条最小任务（只填投递文案用到的字段）。 */
function task(overrides: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    id: 't1',
    title: '每日站会提醒',
    prompt: '汇总昨天的提交，发到群里。',
    rule: { kind: 'daily', hour: 9, minute: 30 },
    timeZone: 'UTC',
    enabled: true,
    nextRunAt: NOW,
    lastRunAt: null,
    lastStatus: 'never',
    lastError: null,
    failureStreak: 0,
    pendingSlot: null,
    createdBy: 'user',
    deliveryHistory: [],
    sessionId: 's1',
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    ...overrides,
  }
}

describe('decideOccurrence：至多跑一次，绝不补积压', () => {
  test('没有排期 / 还没到点：不投递', () => {
    const none = decideOccurrence({ kind: 'every', seconds: 60, anchorMs: NOW }, 'UTC', null, NOW)
    expect(none.verdict).toBe('idle')
    expect(none.fire).toBe(false)

    const future = decideOccurrence({ kind: 'every', seconds: 60, anchorMs: NOW }, 'UTC', NOW + 60_000, NOW)
    expect(future.verdict).toBe('idle')
    expect(future.next).toBe(NOW + 60_000)
  })

  test('一次性任务：宽限内照跑并收尾，超宽限不补', () => {
    const at: ScheduleRule = { kind: 'at', atMs: NOW - 30_000 }
    const ok = decideOccurrence(at, 'UTC', NOW - 30_000, NOW)
    expect(ok).toMatchObject({ fire: true, verdict: 'due', next: null })
    expect(ok.reason).toContain('照跑')

    const missed = decideOccurrence(at, 'UTC', NOW - 600_000, NOW)
    expect(missed).toMatchObject({ fire: false, verdict: 'missed', next: null })
    expect(missed.reason).toContain('不补跑')
  })

  test('周期任务：准点 / 宽限内迟到 / 超宽限合并成一次', () => {
    const rule: ScheduleRule = { kind: 'daily', hour: 9, minute: 30 }
    // 宽限 = 半周期 = 12h，夹到上限 2h。
    expect(graceMs(rule, 'UTC', NOW)).toBe(2 * 3_600_000)

    const due = decideOccurrence(rule, 'UTC', NOW, NOW)
    expect(due).toMatchObject({ fire: true, verdict: 'due' })
    expect(due.next).toBe(Date.UTC(2026, 2, 10, 9, 30))

    const late = decideOccurrence(rule, 'UTC', NOW - 300_000, NOW)
    expect(late).toMatchObject({ fire: true, verdict: 'late' })

    const catchUp = decideOccurrence(rule, 'UTC', NOW - 3 * 3_600_000, NOW)
    expect(catchUp).toMatchObject({ fire: true, verdict: 'catch-up' })
    expect(catchUp.reason).toContain('合并成这一次')
    expect(catchUp.next).toBe(Date.UTC(2026, 2, 10, 9, 30))
  })

  test('every 任务：宽限被夹到下限 2 分钟，迟到 90 秒算 late', () => {
    const rule: ScheduleRule = { kind: 'every', seconds: 60, anchorMs: NOW - 3_600_000 }
    expect(graceMs(rule, 'UTC', NOW)).toBe(120_000)
    const late = decideOccurrence(rule, 'UTC', NOW - 90_000, NOW)
    expect(late.verdict).toBe('late')
  })
})

describe('classifyFailure / quotaHoldMs', () => {
  test('配额类：429 / rate limit / quota / 中文额度词', () => {
    for (const text of ['HTTP 429 Too Many Requests', 'rate_limit exceeded', 'quota exhausted', '余额不足，请充值', '触发限流']) {
      expect(classifyFailure(text), text).toBe('quota')
    }
  })

  test('瞬时网络类：ECONNRESET / fetch failed / 中文超时', () => {
    for (const text of ['read ECONNRESET', 'TypeError: fetch failed', 'socket hang up', '连接超时']) {
      expect(classifyFailure(text), text).toBe('transient')
    }
  })

  test('其它错误不当作可重试', () => {
    expect(classifyFailure('tool write failed: permission denied')).toBe('other')
    expect(classifyFailure('')).toBe('other')
  })

  test('配额恢复点：英文秒 / 中文秒 / 毫秒 / 缺省', () => {
    expect(quotaHoldMs('retry after 300s')).toBe(300_000 + 60_000)
    expect(quotaHoldMs('请 120 秒后重试')).toBe(120_000 + 60_000)
    expect(quotaHoldMs('retry-after: 500ms')).toBe(500 + 60_000)
    expect(quotaHoldMs('quota exceeded')).toBe(DEFAULT_QUOTA_HOLD_MS)
  })
})

describe('planFailure：重试阶梯与恢复点', () => {
  test('配额：停到恢复点；自然排期更晚就听自然排期', () => {
    const rule: ScheduleRule = { kind: 'daily', hour: 9, minute: 30 }
    const hold = planFailure(rule, 'UTC', NOW + 86_400_000, NOW, '429 rate limit', 0)
    expect(hold).toMatchObject({ kind: 'quota', status: 'blocked', failureStreak: 1 })
    expect(hold.next).toBe(NOW + 86_400_000)

    const sooner = planFailure(rule, 'UTC', NOW + 1_000, NOW, '429 rate limit', 0)
    // 自然排期比恢复点更早也不行：配额没恢复，提前跑只会再撞一次。
    expect(sooner.next).toBe(NOW + DEFAULT_QUOTA_HOLD_MS)
  })

  test('一次性任务：失败不重跑', () => {
    const plan = planFailure({ kind: 'at', atMs: NOW }, 'UTC', null, NOW, 'ECONNRESET', 0)
    expect(plan).toMatchObject({ kind: 'transient', status: 'failed', failureStreak: 0, next: null })
    expect(plan.detail).toContain('不自动重跑')
  })

  test('瞬时错误：5/15/30 分钟阶梯，用完就等自然排期', () => {
    const rule: ScheduleRule = { kind: 'daily', hour: 9, minute: 30 }
    const first = planFailure(rule, 'UTC', null, NOW, 'ECONNRESET', 0)
    expect(first).toMatchObject({ status: 'failed', failureStreak: 1 })
    expect(first.next).toBe(NOW + RETRY_LADDER_MS[0]!)
    expect(first.detail).toContain('第 1/3 档')

    const third = planFailure(rule, 'UTC', null, NOW, 'ECONNRESET', 2)
    expect(third.next).toBe(NOW + RETRY_LADDER_MS[2]!)

    const exhausted = planFailure(rule, 'UTC', NOW + 86_400_000, NOW, 'ECONNRESET', 3)
    expect(exhausted).toMatchObject({ status: 'failed', failureStreak: 4 })
    expect(exhausted.next).toBe(NOW + 86_400_000)
    expect(exhausted.detail).toContain('阶梯已用完')
  })

  test('自然排期比重试更早：不插队', () => {
    const rule: ScheduleRule = { kind: 'every', seconds: 60, anchorMs: NOW }
    const plan = planFailure(rule, 'UTC', NOW + 30_000, NOW, 'ECONNRESET', 0)
    expect(plan.next).toBe(NOW + 30_000)
    expect(plan.detail).toContain('自然排期')
  })

  test('其它错误：不动排期，只记失败', () => {
    const rule: ScheduleRule = { kind: 'daily', hour: 9, minute: 30 }
    const plan = planFailure(rule, 'UTC', NOW + 86_400_000, NOW, 'permission denied', 0)
    expect(plan).toMatchObject({ kind: 'other', status: 'failed', failureStreak: 0 })
    expect(plan.next).toBe(NOW + 86_400_000)
    expect(plan.detail).toContain('不自动重发')
  })
})

describe('deliveryText：必须写明「不是用户指令、不构成授权」', () => {
  test('基本文案带标题、排期、时区与任务描述', () => {
    const text = deliveryText(task(), NOW, 'due')
    expect(text).toContain('【定时任务触发】')
    expect(text).toContain('每日站会提醒')
    expect(text).toContain('2026-03-09 09:30:00 +00:00')
    expect(text).toContain('时区 UTC')
    expect(text).toContain('不是用户此刻发出的指令')
    expect(text).toContain('不构成任何授权')
    expect(text).toContain('照常走审批流程')
    expect(text).toContain('任务描述：')
    expect(text).toContain('汇总昨天的提交')
    expect(text).not.toContain('补跑')
  })

  test('catch-up / recovered / manual 各带一句说明', () => {
    expect(deliveryText(task(), NOW, 'catch-up')).toContain('补跑，错过的几次已合并成这一次')
    expect(deliveryText(task(), NOW, 'recovered')).toContain('补投')
    expect(deliveryText(task(), NOW, 'manual')).toContain('手动点「立即跑一次」')
  })
})

describe('rule 的展示辅助（顺带覆盖 formatDuration / describeRule）', () => {
  test('formatDuration 四级单位', () => {
    expect(formatDuration(30)).toBe('30 秒')
    expect(formatDuration(90)).toBe('1 分 30 秒')
    expect(formatDuration(3_600)).toBe('1 小时')
    expect(formatDuration(5_400)).toBe('1 小时 30 分')
    expect(formatDuration(90_000)).toBe('1 天 1 小时')
  })

  test('describeRule 六种规则都有一句话', () => {
    expect(describeRule({ kind: 'after', seconds: 300, anchorMs: 0 }, 'UTC')).toBe('5 分钟后跑一次')
    expect(describeRule({ kind: 'at', atMs: NOW }, 'UTC')).toContain('只跑一次')
    expect(describeRule({ kind: 'every', seconds: 1_800, anchorMs: 0 }, 'UTC')).toContain('每 30 分钟')
    expect(describeRule({ kind: 'daily', hour: 9, minute: 30 }, 'UTC')).toContain('每天 09:30')
    expect(describeRule({ kind: 'weekly', weekday: 1, hour: 9, minute: 30 }, 'UTC')).toContain('周一 09:30')
    const cron = describeRule(
      { kind: 'cron', expression: '0 9 * * *', fields: { minute: [0], hour: [9], dayOfMonth: [1], month: [1], dayOfWeek: [0], dayOfMonthRestricted: false, dayOfWeekRestricted: false } },
      'UTC',
    )
    expect(cron).toContain('cron')
  })
})
