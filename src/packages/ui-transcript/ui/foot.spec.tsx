/**
 * 轮尾（`rows/foot.tsx` 的 RoundFoot / TurnStatusLine）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-transcript-render-test.mjs` 第 [11]（缺口清单 B33）——复制 / 分叉
 * 「停下之后」才画。原探针钉的是 foot.tsx 里的 `!props.running &&` 条件文本；这里
 * 真渲染出来验：跑动中两颗钮根本不在 DOM（不是置灰占位），停下后才出现。用量与时刻
 * 的同一条规则（跑动中不画，免得两处一起跳）也在这里逐样验。
 *
 * CSS 的显隐（默认透明、悬浮 / 焦点才现）是样式表面，jsdom 无接缝，留探针。
 *
 * @module dsc-ui-transcript/ui/foot.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { RoundInfo } from './timing.js'
import { RoundFoot, TurnStatusLine } from './rows/foot.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** 一轮元信息：有起止时刻（算得出用时与时刻）。 */
const roundOf = (over: Partial<RoundInfo> = {}): RoundInfo =>
  ({ index: 0, startIndex: 0, endIndex: 3, startTs: 1_000, endTs: 62_000, answered: true, ...over })

const usage = { inputTokens: 1200, outputTokens: 800 }

describe('复制 / 分叉只在停止之后才画（B33 [11]）', () => {
  test('running：两颗钮都不在 DOM（不是置灰占位），时刻与用量也先不画', () => {
    const { container } = render(
      <RoundFoot round={roundOf()} running={true} copyText="半截回答" usage={usage} tokens={900} onFork={() => undefined} />,
    )
    expect(container.querySelector('.round-act')).toBeNull()
    expect(container.querySelector('.user-act')).toBeNull()
    expect(container.querySelector('.round-clock')).toBeNull()
    expect(container.querySelector('.round-tokens')).toBeNull()
  })

  test('停下后：复制与分叉出现；有最终回答才有复制，第 0 轮不给分叉', () => {
    const { container, rerender } = render(
      <RoundFoot round={roundOf()} running={false} copyText="完整回答" usage={usage} tokens={null} onFork={() => undefined} />,
    )
    expect(container.querySelector('.round-act')).toBeTruthy()
    expect(container.querySelector('.user-act')).toBeTruthy()
    // 没有回答（以工具结果收尾的轮）就没有复制。
    rerender(<RoundFoot round={roundOf()} running={false} usage={usage} tokens={null} onFork={() => undefined} />)
    expect(container.querySelector('.round-act')).toBeNull()
    // 第 1 轮（round 0）不给分叉：分完还是这一轮。
    rerender(
      <RoundFoot round={roundOf({ index: 0 })} running={false} copyText="答" usage={null} tokens={null} onFork={undefined} />,
    )
    expect(container.querySelector('.user-act')).toBeNull()
  })

  test('用量：真值优先（0 或负数当没上报），没有真值才用正文估算顶上（带 ~）', () => {
    const { container, rerender } = render(
      <RoundFoot round={roundOf()} running={false} usage={usage} tokens={900} />,
    )
    expect(container.querySelector('.round-tokens')?.textContent).not.toContain('~')
    rerender(<RoundFoot round={roundOf()} running={false} usage={{ inputTokens: 0, outputTokens: 0 }} tokens={900} />)
    expect(container.querySelector('.round-tokens')?.textContent).toContain('~')
  })

  test('什么读数都拿不到的老会话：整行不画', () => {
    const { container } = render(
      <RoundFoot round={roundOf({ startTs: null, endTs: null })} running={false} usage={null} tokens={null} />,
    )
    expect(container.querySelector('.round-foot')).toBeNull()
  })
})

describe('回合进行中的直播行（TurnStatusLine）', () => {
  test('转圈 + 一句话 + 扫光取值 + 三点动画；起点可信时报用时', () => {
    const startedAt = Date.now() - 5_000
    const { container } = render(<TurnStatusLine text="Numa 工作中" startedAt={startedAt} />)
    expect(container.querySelector('.turn-status-spin')).toBeTruthy()
    expect(container.querySelector('.turn-status-dots')?.querySelectorAll('i').length).toBe(3)
    const stage = container.querySelector('.turn-status-stage') as HTMLElement
    expect(stage.getAttribute('data-shimmer')).toBeTruthy()
    expect(stage.textContent).toContain('Numa 工作中')
    expect(stage.textContent).toMatch(/\d/)
  })

  test('起点拿不到（老会话没有 ts）：只报状态不报时间，绝不显示 NaN', () => {
    const { container } = render(<TurnStatusLine text="Numa 工作中" startedAt={null} />)
    const stage = container.querySelector('.turn-status-stage') as HTMLElement
    expect(stage.textContent).toBe('Numa 工作中')
    expect(stage.textContent).not.toContain('NaN')
  })
})

describe('直播行是一行、自带时钟、挂扫光（ui-turn-status [2] 行为化）', () => {
  test('不再渲染旧分割线与第二行的活动名', () => {
    const { container } = render(<TurnStatusLine text="Numa 工作中" startedAt={null} />)
    expect(container.querySelector('.turn-status-rule')).toBeNull()
    expect(container.querySelector('.turn-status-activity')).toBeNull()
  })

  test('自己带每秒时钟：用时读数每秒跳一次（不带着消息流重排）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const { container } = render(<TurnStatusLine text="Numa 工作中" startedAt={95_000} />)
    const stage = container.querySelector('.turn-status-stage') as HTMLElement
    const first = stage.textContent
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(stage.textContent).not.toBe(first)
    expect(stage.textContent).toContain('Numa 工作中')
  })

  test('具体活动收进悬停提示（行面不重复组头）', () => {
    const { container } = render(<TurnStatusLine text="Numa 工作中" startedAt={null} hint="正在调用 bash" />)
    expect((container.querySelector('.turn-status') as HTMLElement).getAttribute('title')).toBe('正在调用 bash')
  })
})

describe('轮尾用量 / 时刻 / 分隔点由组件画出来（ui-round-foot-hover [3] 行为化）', () => {
  test('停下后三者都在 DOM；跑动中一个都不画（不是透明占位）', () => {
    const stopped = render(
      <RoundFoot round={roundOf()} running={false} usage={usage} tokens={900} onFork={() => undefined} />,
    )
    expect(stopped.container.querySelector('.round-tokens')).toBeTruthy()
    expect(stopped.container.querySelector('.round-clock')).toBeTruthy()
    expect(stopped.container.querySelector('.round-sep')).toBeTruthy()

    const running = render(
      <RoundFoot round={roundOf()} running={true} usage={usage} tokens={900} onFork={() => undefined} />,
    )
    expect(running.container.querySelector('.round-tokens')).toBeNull()
    expect(running.container.querySelector('.round-clock')).toBeNull()
    expect(running.container.querySelector('.round-sep')).toBeNull()
  })
})
