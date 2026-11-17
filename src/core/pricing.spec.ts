/**
 * 会话费用估算的纯函数（unit 层，迁自 `scripts/batch3-test.mjs` 的计价段）。
 *
 * 钉的是三件事：**哪天哪一刻算高峰**（价格差一倍）、**模型按哪条前缀查价**、以及
 * **一笔用量怎么拆成命中 / 未命中 / 输出**。这三件里面任何一件漂了，用户看到的
 * 都是一个安静的错误数字——不报错、不掉行，只是账单对不上。
 *
 * ## 为什么整条断言不碰内核
 *
 * `pricing.ts` 零依赖：不读环境、不发请求，输入就是 `Date` 与 token 数。起内核只会
 * 把「假端点的时间」和「系统时钟」搅进来——高峰判定按真实时钟算，测试会在北京时间
 * 9:00 整那一秒开始飘。
 *
 * @module dsc/core/pricing.spec
 */
import { expect, test } from 'vitest'
import {
  addUsageToBuckets,
  emptyCostBuckets,
  estimateSessionCostCny,
  isDeepseekProvider,
  isPeakHour,
  priceForModel,
} from './pricing.js'

/** 北京某日某时对应的 `Date`：北京时间是 UTC+8 固定偏移（无夏令时）。 */
function beijing(iso: string): Date {
  return new Date(`${iso}:00+08:00`)
}

test('周三上午 10 点（北京）算高峰', () => {
  // 2026-10-07 是周三。
  expect(isPeakHour(beijing('2026-10-07T10:00'))).toBe(true)
})

test('周日凌晨不算高峰（周末全天谷）', () => {
  // 2026-10-11 是周日：同样是上午 10 点，工作日算峰、周日算谷。
  expect(isPeakHour(beijing('2026-10-11T10:00'))).toBe(false)
})

test('工作日午休 12-14 与晚间算谷', () => {
  expect(isPeakHour(beijing('2026-10-07T12:00'))).toBe(false)
  expect(isPeakHour(beijing('2026-10-07T20:00'))).toBe(false)
})

test('峰段边界：9:00 起算，12:00 已出峰；14:00 再入峰，18:00 出峰', () => {
  // 边界方向搞反（>= 写成 >）时，只有这几个整点能看出来。
  expect(isPeakHour(beijing('2026-10-07T08:59'))).toBe(false)
  expect(isPeakHour(beijing('2026-10-07T09:00'))).toBe(true)
  expect(isPeakHour(beijing('2026-10-07T11:59'))).toBe(true)
  expect(isPeakHour(beijing('2026-10-07T12:00'))).toBe(false)
  expect(isPeakHour(beijing('2026-10-07T14:00'))).toBe(true)
  expect(isPeakHour(beijing('2026-10-07T18:00'))).toBe(false)
})

test('价目表只对官方 provider 生效', () => {
  expect(isDeepseekProvider('deepseek')).toBe(true)
  expect(isDeepseekProvider('my-deepseek-proxy')).toBe(true)
  expect(isDeepseekProvider('openai')).toBe(false)
})

test('priceForModel 按最长前缀匹配（视觉版不该落到基础版）', () => {
  // 价目表里 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 同时存在：
  // 取第一个命中的前缀时，视觉版会错拿基础版的价格。
  expect(priceForModel('deepseek-v4-flash')?.output[1]).toBe(8)
  expect(priceForModel('deepseek-v4-flash-vision-exp')?.output[1]).toBe(8)
  // 未收录的模型名不能瞎猜一个价格出来。
  expect(priceForModel('gpt-x')).toBeUndefined()
})

test('addUsageToBuckets：input 含命中，拆成命中 / 未命中两笔', () => {
  const buckets = emptyCostBuckets()
  addUsageToBuckets(buckets, { inputTokens: 1000, outputTokens: 100, cacheHitTokens: 800, cacheMissTokens: 200 }, true)
  expect(buckets.peak.hit).toBe(800)
  expect(buckets.peak.miss).toBe(200)
  expect(buckets.peak.output).toBe(100)
  // 谷桶一个 token 都不该动。
  expect(buckets.idle).toEqual({ hit: 0, miss: 0, output: 0 })
})

test('addUsageToBuckets：只报了命中明细时，未命中由总量减出来', () => {
  const buckets = emptyCostBuckets()
  addUsageToBuckets(buckets, { inputTokens: 1000, outputTokens: 0, cacheHitTokens: 800 }, false)
  expect(buckets.idle.hit).toBe(800)
  expect(buckets.idle.miss).toBe(200)
})

test('addUsageToBuckets：端点没报明细时全部按未命中计（估算只会偏高不会漏）', () => {
  const buckets = emptyCostBuckets()
  addUsageToBuckets(buckets, { inputTokens: 500, outputTokens: 50 }, true)
  expect(buckets.peak.miss).toBe(500)
  expect(buckets.peak.hit).toBe(0)
})

test('emptyCostBuckets 每次返回新对象（两次会话不会串账）', () => {
  expect(emptyCostBuckets()).not.toBe(emptyCostBuckets())
})

test('estimateSessionCostCny：峰桶按高峰价、谷桶按空闲价分别算', () => {
  const buckets = emptyCostBuckets()
  // 谷桶：命中 1M × ¥0.02 + 未命中 1M × ¥1 + 输出 1M × ¥4 = ¥5.02
  // 输入总量给 2M，因为 Pneuma 的 `inputTokens` 包含命中量（命中 + 未命中 = 总量）。
  addUsageToBuckets(
    buckets,
    { inputTokens: 2_000_000, outputTokens: 1_000_000, cacheHitTokens: 1_000_000, cacheMissTokens: 1_000_000 },
    false,
  )
  // 峰桶：未命中 1M × ¥2 + 输出 1M × ¥8 = ¥10
  addUsageToBuckets(
    buckets,
    { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheHitTokens: 0, cacheMissTokens: 1_000_000 },
    true,
  )
  const estimate = estimateSessionCostCny([{ model: 'deepseek-v4-flash', buckets }])
  expect(estimate).toBeDefined()
  expect(estimate!.idle).toBeCloseTo(5.02, 10)
  expect(estimate!.peak).toBeCloseTo(10, 10)
  expect(estimate!.total).toBeCloseTo(15.02, 10)
})

test('estimateSessionCostCny：一个价目表外的模型都不给数字', () => {
  const buckets = emptyCostBuckets()
  addUsageToBuckets(buckets, { inputTokens: 1000, outputTokens: 100 }, true)
  // 宁可不显示金额，也不给错误金额：调用方拿 undefined 就是「不画这一栏」。
  expect(estimateSessionCostCny([{ model: 'gpt-x', buckets }])).toBeUndefined()
  expect(estimateSessionCostCny([])).toBeUndefined()
})

test('estimateSessionCostCny：可计价模型但一笔 token 都没有时也不给数字', () => {
  // 「没有用量」与「用了但便宜到 0」是两件事；返回 0 会让界面显示「本次花费 ¥0.00」。
  expect(estimateSessionCostCny([{ model: 'deepseek-v4-flash', buckets: emptyCostBuckets() }])).toBeUndefined()
})
