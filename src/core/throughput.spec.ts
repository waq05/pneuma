/**
 * 输出速度与首字延迟的读数口径（迁自 `scripts/throughput-test.mjs` 第 6 节）。
 *
 * 三个纯函数是整个口径的「唯一原件」：终端状态栏、桌面状态栏、设置页的用量统计都从这里
 * 取，谁也不许自己再写一遍除法。本节钉边界：
 *
 *   - 速度 = token ÷ 解码秒；解码期为 0 或没有样本时给 null（界面据此整段省略，
 *     绝不除一个 0 印出天文数字）；
 *   - 首字延迟取平均；样本数为 0 时给 null；
 *   - 读数格式：10 以上给整数、10 以下一位小数；负数与 0 都读作 0。
 *
 * 归 unit：纯函数，无 IO、无环境依赖。
 *
 * @module dsc/core/throughput.spec
 */
import { describe, expect, test } from 'vitest'
import { averageTtftMs, formatTokensPerSecond, tokensPerSecond } from './throughput.js'

describe('⑥ 口径函数', () => {
  test('速度 = token ÷ 解码秒（60 token / 3s = 20）', () => {
    expect(tokensPerSecond({ decodeMs: 3000, decodeTokens: 60 })).toBe(20)
  })

  test('解码期为 0 不给数（不除零）', () => {
    expect(tokensPerSecond({ decodeMs: 0, decodeTokens: 60 })).toBeNull()
  })

  test('没有样本也不给数', () => {
    expect(tokensPerSecond({ decodeMs: 0, decodeTokens: 0 })).toBeNull()
  })

  test('首字延迟取平均（1600ms / 2 步 = 800ms）', () => {
    expect(averageTtftMs({ ttftMs: 1600, ttftSteps: 2 })).toBe(800)
  })

  test('首字样本为 0 → null', () => {
    expect(averageTtftMs({ ttftMs: 0, ttftSteps: 0 })).toBeNull()
  })

  test('读数 10 以上给整数', () => {
    expect(formatTokensPerSecond(10.06)).toBe('10')
    expect(formatTokensPerSecond(69.4)).toBe('69')
  })

  test('读数 10 以下给一位小数', () => {
    expect(formatTokensPerSecond(9.94)).toBe('9.9')
    expect(formatTokensPerSecond(8.4)).toBe('8.4')
  })

  test('负数与 0 都读作 0', () => {
    expect(formatTokensPerSecond(-5)).toBe('0')
    expect(formatTokensPerSecond(0)).toBe('0')
  })
})
