/**
 * 用量日志的读写与按会话折叠（迁自 `scripts/throughput-test.mjs` 第 5 节）。
 *
 * ## 这个文件是什么
 *
 * `~/.dsc/usage/usage.jsonl` 是两种行的计量流：请求行（token + 一步的三个墙钟读数
 * `lm`/`ft`/`d`）与工具行（`k: 'tool'` + 调用耗时）。设置页的用量统计与会话用量卡
 * 都从这里聚合，**输出速度 = 整会话累计输出 token ÷ 累计纯解码时间**也在这里折叠。
 *
 * 本节钉住读的一端：墙钟三项原样读回、老行（0.6.67 之前没有墙钟）既不进分子也不进
 * 分母、工具行只进工具耗时、坏行与别的会话跳过、「最后一次输入」按时间戳取。
 *
 * ## 隔离
 *
 * 用量日志的路径从 `path-policy` 的模块级 `DSC_HOME` 派生，所以 `tempHome()` 必须先跑、
 * 模块一律动态 import。第一条用例顺手钉住「这份文件真的落在临时主目录里」——真实
 * `~/.dsc` 一个字节都不动。
 *
 * @module dsc/core/usage-log.spec
 */
import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { UsageRecord } from './usage-log.js'
import { tempHome } from '../../tests/harness.js'

/** 临时主目录：`usage.jsonl` 从这里派生（真实 `~/.dsc` 不动）。 */
const home = tempHome('dsc-usage-log-')

type UsageLogModule = typeof import('./usage-log.js')
type ThroughputModule = typeof import('./throughput.js')
type SessionUsage = NonNullable<ReturnType<UsageLogModule['readSessionUsage']>>

let log: UsageLogModule
let throughput: ThroughputModule

beforeAll(async () => {
  log = await import('./usage-log.js')
  throughput = await import('./throughput.js')
})

afterAll(() => {
  home.restore()
})

describe('⑤ 日志读写与折叠', () => {
  /** 写进去的第一条请求行（墙钟三项原样读回用）。 */
  let firstRequest: UsageRecord

  beforeAll(() => {
    log.appendUsageRecord({ provider: 'p', model: 'm', i: 100, o: 20, ch: 80, cm: 20, sid: 'sess-1', lm: 1100, ft: 300, d: 800 })
    // 0.6.67 之前的老行：不带墙钟。
    log.appendUsageRecord({ provider: 'p', model: 'm', i: 50, o: 5, sid: 'sess-1' })
    log.appendUsageRecord({ provider: 'p', model: 'm', i: 70, o: 9, sid: 'sess-2', lm: 500, ft: 100, d: 400 })
    log.appendToolRecord({ sid: 'sess-1', n: 'bash', ms: 250 })
    log.appendToolRecord({ sid: 'sess-2', n: 'bash', ms: 999 })
    // 写盘中断的半截行：解析失败就当没有这一行。
    appendFileSync(log.usageLogFile(), '{"t":1,"sid":"sess-1","i"', 'utf8')
    firstRequest = log.readUsageRecords()[0] as UsageRecord
  })

  test('用量日志真的落在临时主目录里', () => {
    expect(log.usageLogFile().startsWith(home.home)).toBe(true)
  })

  test('请求行读得回（工具行与坏行都不算）', () => {
    expect(log.readUsageRecords()).toHaveLength(3)
  })

  test('墙钟三项原样读回', () => {
    expect(firstRequest.lm).toBe(1100)
    expect(firstRequest.ft).toBe(300)
    expect(firstRequest.d).toBe(800)
  })

  test('老行没有墙钟三项', () => {
    const legacy = log.readUsageRecords()[1]
    expect(legacy?.lm).toBeUndefined()
    expect(legacy?.ft).toBeUndefined()
    expect(legacy?.d).toBeUndefined()
  })

  describe('按会话折叠', () => {
    /** sess-1 的折叠结果（下面几条断言共用）。 */
    let view: SessionUsage

    beforeAll(() => {
      const folded = log.readSessionUsage('sess-1')
      if (folded === null) throw new Error('sess-1 应当有折叠结果')
      view = folded
    })

    test('请求数、token 与墙钟累计（老行不进分子分母）', () => {
      expect(view.requests).toBe(2)
      expect(view.inputTokens).toBe(150)
      expect(view.outputTokens).toBe(25)
      expect(view.llmMs).toBe(1100)
      expect(view.ttftMs).toBe(300)
      expect(view.ttftSteps).toBe(1)
      expect(view.decodeMs).toBe(800)
      expect(view.decodeTokens).toBe(20)
    })

    test('工具行只进工具耗时与次数', () => {
      expect(view.toolMs).toBe(250)
      expect(view.toolCalls).toBe(1)
    })

    test('缓存两栏成对才算数', () => {
      expect(view.cacheHitTokens).toBe(80)
      expect(view.cacheMissTokens).toBe(20)
    })

    test('最后一次请求取时间戳最新的那条', () => {
      expect(view.lastInputTokens).toBe(50)
    })

    test('速度口径接上折叠结果（20 token ÷ 0.8s = 25）', () => {
      expect(throughput.tokensPerSecond(view)).toBe(25)
    })
  })

  test('别的会话各算各的', () => {
    expect(log.readSessionUsage('sess-2')?.toolMs).toBe(999)
  })

  test('这个会话一行都没有 → null（界面整段省略，不显示全 0 的账）', () => {
    expect(log.readSessionUsage('sess-404')).toBeNull()
  })

  test('空会话 id → null', () => {
    expect(log.readSessionUsage('')).toBeNull()
    expect(log.foldSessionUsage('{}', '')).toBeNull()
  })
})

describe('⑥ 设置页聚合（aggregateUsage / buildUsageStats）', () => {
  test('localDateKey 是本地 YYYY-MM-DD，且昨天与今天不同', () => {
    const now = Date.now()
    expect(log.localDateKey(now)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(log.localDateKey(now)).not.toBe(log.localDateKey(now - 86_400_000))
  })

  test('合计、逐模型排序、缓存两栏、连续天数与峰值日', () => {
    const now = Date.now()
    const records: UsageRecord[] = [
      { t: now - 86_400_000, provider: 'deepseek', model: 'deepseek-flash', i: 1_000, o: 100, sid: 's1', ch: 700, cm: 300 },
      { t: now - 86_400_000 + 1_000, provider: 'deepseek', model: 'deepseek-flash', i: 500, o: 50, sid: 's1' },
      { t: now, provider: 'other', model: 'm', i: 10, o: 5, sid: 's2' },
    ]
    const stats = log.aggregateUsage(records)
    expect(stats).toMatchObject({
      totalInputTokens: 1_510,
      totalOutputTokens: 155,
      totalTurns: 3,
      totalCacheHitTokens: 700,
      totalCacheMissTokens: 300,
      activeDays: 2,
      currentStreakDays: 2,
      longestStreakDays: 2,
      sinceTs: now - 86_400_000,
    })
    expect(stats.models.map((model) => model.key)).toEqual(['deepseek/deepseek-flash', 'other/m'])
    expect(stats.peakDay?.date).toBe(log.localDateKey(now - 86_400_000))
    expect(stats.days.at(-1)?.date).toBe(log.localDateKey(now))
    // DeepSeek 端点给花费；只有别家端点时没有 costCny。
    expect(stats.totalCostCny).toBeGreaterThan(0)
    expect(log.aggregateUsage([{ t: now, provider: 'openrouter', model: 'x', i: 1, o: 1, sid: 's' }]).totalCostCny).toBeUndefined()
  })

  test('空记录：零合计、无峰值日、days 为空', () => {
    expect(log.aggregateUsage([])).toMatchObject({
      sinceTs: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTurns: 0,
      activeDays: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
      peakDay: null,
      days: [],
    })
  })

  test('buildUsageStats 从真实文件读一遍再聚合（本文件前面写的 3 条请求行）', () => {
    const stats = log.buildUsageStats()
    expect(stats.totalInputTokens).toBe(220)
    expect(stats.totalOutputTokens).toBe(34)
    expect(stats.totalTurns).toBe(3)
    expect(stats.models.map((model) => model.key)).toEqual(['p/m'])
  })
})
