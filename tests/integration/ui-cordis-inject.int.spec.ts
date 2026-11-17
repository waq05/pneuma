/**
 * cordis 的 `inject` 语义自检（拆自 `scripts/ui-cordis-test.mjs` 的 [0] 段，断言 1:1）。
 *
 * 这一段**不需要浏览器**：它钉住的是 cordis 装配机制本身的三条假设，跟界面、跟
 * Chromium 都没关系，起真机纯属浪费（每条 10-60 秒换不来新信息），所以按分层设计
 * 归 integration 层——起真内核前先钉住「我们依赖的等待形状真是我们以为的那样」。
 *
 * 拆 `inject` 双关之后，服务名那一半交给 cordis 等；这条自检证明等待的形状：
 *   1. 依赖没就绪时 `await fiber` **直接放行**（不抛、不卡），纤维停在状态 0；
 *   2. apply **不跑**（不能拿半份服务就开工）；
 *   3. 服务后来补上 → apply 跑起来、状态到 2，且 `internal/status` 事件确实发得出来
 *      （壳的账本靠它从「等待」翻成「已生效」）。
 *
 * @module dsc/tests/integration/ui-cordis-inject.int.spec
 */
import { Context } from '@deepseek-ai/cordis'
import { beforeAll, describe, expect, test } from 'vitest'

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

describe('cordis inject 语义（不开浏览器，钉住装配机制的三条假设）', () => {
  /** 纤维句柄与事件账本：beforeAll 里按原探针的顺序铺一遍，test 只读事实。 */
  const state: {
    settled: 'resolved' | 'timeout' | 'pending'
    fiberStateAtRest: number
    startedAtRest: number
    startedAfterProvide: number
    fiberStateAfterProvide: number
    events: string[]
  } = {
    settled: 'pending',
    fiberStateAtRest: -1,
    startedAtRest: -1,
    startedAfterProvide: -1,
    fiberStateAfterProvide: -1,
    events: [],
  }

  beforeAll(async () => {
    const ctx = new Context()
    const off = ctx.on('internal/status', (fiber, old) => {
      state.events.push(`${String(old)}->${String(fiber.state)}`)
    })
    let started = 0
    const fiber = ctx.plugin({
      name: 'needs-service',
      inject: ['notYetProvided'],
      apply: () => {
        started += 1
      },
    })
    // 依赖缺席：await fiber 必须直接放行（1.5 秒兜底，探针同款——正常远快于此）。
    state.settled = await Promise.race([
      fiber.then(() => 'resolved' as const),
      sleep(1500).then(() => 'timeout' as const),
    ])
    state.fiberStateAtRest = fiber.state
    state.startedAtRest = started

    // 服务补上：apply 应当跑起来，纤维翻到生效。
    ctx.provide('notYetProvided', {})
    await sleep(200)
    state.startedAfterProvide = started
    state.fiberStateAfterProvide = fiber.state
    off()
  }, 10_000)

  test('依赖缺席时 await fiber 直接放行（不卡住）', () => {
    expect(state.settled, String(state.settled)).toBe('resolved')
  })
  test('依赖缺席时纤维停在待装（state=0）', () => {
    expect(state.fiberStateAtRest, String(state.fiberStateAtRest)).toBe(0)
  })
  test('依赖缺席时 apply 不跑', () => {
    expect(state.startedAtRest, String(state.startedAtRest)).toBe(0)
  })
  test('服务补上后 apply 跑了', () => {
    expect(state.startedAfterProvide, String(state.startedAfterProvide)).toBe(1)
  })
  test('服务补上后纤维生效（state=2）', () => {
    expect(state.fiberStateAfterProvide, String(state.fiberStateAfterProvide)).toBe(2)
  })
  test('状态变化有事件（壳的账本靠它刷新）', () => {
    expect(state.events.length >= 2, JSON.stringify(state.events)).toBe(true)
  })
})
