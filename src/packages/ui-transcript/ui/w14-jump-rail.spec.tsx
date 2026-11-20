/**
 * 右侧回合刻度条（`jump-rail.tsx`）第四批补测：W14 剩余的分支出口。
 *
 * 已有 `jump-rail.spec` 铺过可见性/题面预览/跳轮主干、`transcript-extra.spec` 铺过预览卡
 * 与已画轮跳转。这一份补它们没碰到的：
 *
 * - 当前轮判定里的命中测试（`document.elementFromPoint` 落在某一行上 → 那一轮亮起），
 *   以及命中元素不是行时的回落；
 * - 轨道自身滚动的两条渐隐边（`data-fade-up` / `data-fade-down`）；
 * - 当前刻度不在可视区时自动居中（`scrollTo` 被调用）；
 * - 点还没画出来的轮：先请求放页（`onReveal`）、等待期间刻度闪烁、超时后收手；
 * - 轨道与刻度的指针进出（预览卡跟随出现/收起）。
 *
 * jsdom 不做布局：几何一律用替身（`getClientRects` / `clientWidth` / `scrollTo` /
 * `elementFromPoint`），口径与 `transcript-extra.spec` 的刻度条用例一致。
 *
 * @module dsc-ui-transcript/ui/w14-jump-rail.spec
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { JumpRailRound } from './jump-rail.js'
import { JumpRail } from './jump-rail.js'
import type { ChatViewport } from './viewport.js'

beforeAll(() => {
  // 刻度条的量测与宽窄判定都靠 ResizeObserver；jsdom 没有，给空桩。
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
})

beforeEach(() => {
  // 容器宽度够宽（>=900）刻度条才画；jsdom 没有布局，getter 直接给数。
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.hidden ? [] : [{ width: 200, height: 20 }]) as unknown as DOMRectList
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const roundsOf = (count: number): JumpRailRound[] =>
  Array.from({ length: count }, (_, round) => ({
    round,
    prompt: `第 ${String(round)} 问`,
    response: round === 0 ? '答过了' : '',
  }))

interface MountOptions {
  /** 已画出来的第一轮（更早的算「还没放出来」）。 */
  renderedFrom?: number
  /** 命中测试的返回值（不给就 null）。 */
  hitOf?: (scroller: HTMLElement) => Element | null
  /** 视口「在底」判定。 */
  atFloor?: boolean
}

interface Mounted {
  wrap: HTMLElement
  scroller: HTMLElement
  scrollToOffset: ReturnType<typeof vi.fn>
  onReveal: ReturnType<typeof vi.fn>
  railScroll: HTMLElement
}

/** 挂一套 `.chat-wrap > .chat > 行` 的架子，把刻度条渲进 wrap。 */
function mountRail(rounds: JumpRailRound[], options: MountOptions = {}): Mounted {
  const wrap = document.createElement('div')
  wrap.className = 'chat-wrap'
  const scroller = document.createElement('div')
  scroller.className = 'chat'
  for (const round of rounds) {
    if (round.round < (options.renderedFrom ?? 0)) continue
    const row = document.createElement('div')
    row.setAttribute('data-round', String(round.round))
    row.textContent = `第 ${String(round.round)} 轮的行`
    scroller.appendChild(row)
  }
  wrap.appendChild(scroller)
  document.body.appendChild(wrap)

  const scrollToOffset = vi.fn()
  const onReveal = vi.fn()
  const viewport = {
    scroller,
    rect: (): DOMRect | null => ({ top: 0, left: 0, width: 800, height: 600 }) as DOMRect,
    scrollTop: (): number => 0,
    clientWidth: (): number => 800,
    atFloor: (): boolean => options.atFloor ?? false,
    offsetOf: (element: Element | null): number | null =>
      element === null ? null : Number(element.getAttribute('data-round')) * 400,
    scrollToOffset,
  } as unknown as ChatViewport

  // jsdom 没有 `elementFromPoint`：这里直接挂一个替身（不是 spyOn——属性压根不存在）。
  ;(document as unknown as { elementFromPoint?: unknown }).elementFromPoint = (): Element | null =>
    options.hitOf?.(scroller) ?? null

  render(
    <JumpRail
      rounds={rounds}
      renderedFrom={options.renderedFrom ?? 0}
      onReveal={onReveal as unknown as (round: number) => void}
      viewport={viewport}
    />,
    { container: wrap },
  )
  return {
    wrap,
    scroller,
    scrollToOffset,
    onReveal,
    railScroll: wrap.querySelector('.jump-rail-scroll') as HTMLElement,
  }
}

/** 等刻度条的 rAF 量测落地。 */
async function afterMeasure(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
}

describe('当前轮判定：命中测试', () => {
  test('探针落在第 2 轮的行上：那一枚刻度亮起（aria-current=true）', async () => {
    const mounted = mountRail(roundsOf(3), {
      hitOf: (scroller) => scroller.querySelector('[data-round="1"]'),
    })
    await afterMeasure()
    const ticks = [...mounted.wrap.querySelectorAll('.jump-tick')] as HTMLElement[]
    expect(ticks[1]?.getAttribute('aria-current')).toBe('true')
    expect(ticks[0]?.getAttribute('aria-current')).toBeNull()
  })

  test('命中元素不是行：回落用滚动位置与锚点判定，不抛', async () => {
    const mounted = mountRail(roundsOf(3), { hitOf: (scroller) => scroller })
    await afterMeasure()
    const ticks = [...mounted.wrap.querySelectorAll('.jump-tick')] as HTMLElement[]
    expect(ticks.length).toBe(3)
  })
})

describe('轨道自身的渐隐边', () => {
  test('滚到中间：上下两条渐隐边都亮；滚到底/顶：各收一条', async () => {
    const mounted = mountRail(roundsOf(3))
    await afterMeasure()
    const scroll = mounted.railScroll
    if (scroll === null) throw new Error('刻度条没有画出来')
    Object.defineProperty(scroll, 'scrollHeight', {
      configurable: true,
      value: 500,
    })
    Object.defineProperty(scroll, 'clientHeight', {
      configurable: true,
      value: 100,
    })
    scroll.scrollTop = 50
    fireEvent.scroll(scroll)
    expect(scroll.getAttribute('data-fade-up')).toBe('')
    expect(scroll.getAttribute('data-fade-down')).toBe('')

    scroll.scrollTop = 400
    fireEvent.scroll(scroll)
    expect(scroll.getAttribute('data-fade-up')).toBe('')
    expect(scroll.getAttribute('data-fade-down')).toBeNull()

    scroll.scrollTop = 0
    fireEvent.scroll(scroll)
    expect(scroll.getAttribute('data-fade-up')).toBeNull()
    expect(scroll.getAttribute('data-fade-down')).toBe('')
  })
})

describe('当前刻度自动居中', () => {
  test('当前刻度在可视区外：轨道 scrollTo 把它滚到中间；指针在轨道里时不挪', async () => {
    const mounted = mountRail(roundsOf(3), {
      hitOf: (scroller) => scroller.querySelector('[data-round="1"]'),
    })
    const scroll = mounted.railScroll
    if (scroll === null) throw new Error('刻度条没有画出来')
    const scrollTo = vi.fn()
    Object.defineProperty(scroll, 'scrollHeight', {
      configurable: true,
      value: 500,
    })
    Object.defineProperty(scroll, 'clientHeight', {
      configurable: true,
      value: 100,
    })
    Object.defineProperty(scroll, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })
    const tick = scroll.querySelector('[data-turn="1"]') as HTMLElement
    Object.defineProperty(tick, 'offsetTop', {
      configurable: true,
      value: 300,
    })

    await afterMeasure()
    expect(scrollTo).toHaveBeenCalled()

    // 指针进轨道：之后的自动居中不再把刻度从手底下挪走。
    scrollTo.mockClear()
    fireEvent.pointerEnter(mounted.wrap.querySelector('.jump-rail') as HTMLElement)
    fireEvent.scroll(scroll)
    await afterMeasure()
    expect(scrollTo).not.toHaveBeenCalled()
  })
})

describe('点还没画出来的轮', () => {
  test('先请求放页（onReveal），等待期刻度闪烁，放不出来就收手', async () => {
    const mounted = mountRail(roundsOf(3), { renderedFrom: 1 })
    await afterMeasure()
    const early = mounted.wrap.querySelector('[data-turn="0"]') as HTMLElement | null
    if (early === null) throw new Error('没有画第 1 轮的刻度')
    expect(early.classList.contains('is-unloaded')).toBe(true)
    fireEvent.click(early)
    expect(mounted.onReveal).toHaveBeenCalledWith(0)
    expect(mounted.scrollToOffset).not.toHaveBeenCalled()
    // 放页的 40 帧兜底跑完：闪烁收掉（不再 is-busy）。
    await waitFor(
      () => {
        const tick = mounted.wrap.querySelector('[data-turn="0"]') as HTMLElement
        expect(tick.classList.contains('is-busy')).toBe(false)
      },
      { timeout: 3000 },
    )
  })
})

describe('指针进出', () => {
  test('刻度悬停出预览卡；离开轨道收起', async () => {
    const mounted = mountRail(roundsOf(3))
    await afterMeasure()
    const tick = mounted.wrap.querySelector('[data-turn="1"]') as HTMLElement
    fireEvent.pointerEnter(tick)
    expect(mounted.wrap.querySelector('.jump-preview')).not.toBeNull()
    fireEvent.pointerLeave(mounted.wrap.querySelector('.jump-rail') as HTMLElement)
    expect(mounted.wrap.querySelector('.jump-preview')).toBeNull()
  })
})
