/**
 * 右侧回合刻度条（`jump-rail.tsx` 的 JumpRail）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-jump-rail-test.mjs` 第 [4] 段「接线形态」（缺口清单 B36「ui-jump-rail
 * [4]」；判定纯函数半已迁 `rail-window.spec.ts`）。原探针钉的是源码文本（querySelectorAll
 * 按 `[data-round]` 收、`getClientRects().length === 0` 跳过隐藏行、`lastRound` 取轮清单
 * 尾轮、`readCurrent` 不许回来）；这里把同一件事行为化——真把刻度条挂进一段带行的
 * 滚动容器里，让组件自己量：
 *   - 触发行（子代理汇报那类**没有用户气泡**的行）挂 `[data-round]` 也是锚点——
 *     旧写法只认 `.entry-user`，那一轮永远拿不到锚点（2026-10-28 报障）；
 *   - 整轮收起的隐藏行（没有盒子）不当锚点，不把「最上面」判给藏起来的那一轮；
 *   - 贴底时高亮**轮清单**的最后一轮（哪怕最新一轮一个锚点都没有）。
 *
 * jsdom 不做布局：锚点的「有没有盒子」用 `getClientRects` 的替身按行给（hidden 的行
 * 给空数组、可见行给一段矩形），命中测试的 `elementFromPoint` 给 null（走几何兜底），
 * 视口几何由 ChatViewport 替身提供——替身只模拟「浏览器本来就会给的东西」，不掺组件
 * 自己的判定。滚动容器的架子先于 render 建好（`render(ui, { container })`）：JumpRail
 * 挂载那一拍就要从它里面收锚点，后补 DOM 会错过挂载期的首次测量。
 *
 * @module dsc-ui-transcript/ui/jump-rail.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ChatViewport } from './viewport.js'
import { JumpRail, type JumpRailRound } from './jump-rail.js'

/** 刻度条的轮清单（题面与摘要在这层用例里不被读到）。 */
const rounds = (count: number): JumpRailRound[] =>
  Array.from({ length: count }, (_, round) => ({ round, prompt: `第 ${String(round)} 问`, response: '' }))

/** jsdom 没有 ResizeObserver：JumpRail 挂载与滚动重测都靠它调度，给空桩。 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  // jsdom 不做命中测试：命中恒空，判定走几何兜底（probeTop 对锚点表）。
  ;(document as unknown as { elementFromPoint?: unknown }).elementFromPoint = () => null
  // 「有没有盒子」按行给：hidden 的行没有矩形（整轮收起的真实语义），可见行有一段。
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.hidden ? [] : [{ width: 200, height: 20 }]) as unknown as DOMRectList
  })
  // 刻度条可见性的宽度判据读宿主实际宽度（jsdom 恒 0）：统一给一个比 900px 阈值宽的值。
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
})

afterEach(() => {
  cleanup()
  // mount 用预建容器：RTL 的 cleanup 只卸 React 树，架子要自己拆。
  document.querySelectorAll('.chat-wrap').forEach((host) => host.remove())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** ChatViewport 替身：几何与「到底」由用例控制（scrollTop 可变，滚动用例换它）。 */
function fakeViewport(scroller: HTMLElement, atFloor: () => boolean, scrollTop: () => number): ChatViewport {
  return {
    scroller,
    rect: (): DOMRect | null => ({ top: 0, left: 0, width: 800, height: 600 } as DOMRect),
    scrollTop,
    clientWidth: (): number => 800,
    atFloor,
    offsetOf: (element: Element | null): number | null => {
      if (element === null) return null
      // 隐藏行（没有盒子）量出来的偏移就是 0——这正是它会被当成「在最上面」的原因，
      // 也是「跳过没有盒子的行」要防的那件事。
      if ((element as HTMLElement).hidden === true) return 0
      return Number(element.getAttribute('data-round')) * 400
    },
    scrollToOffset: (): number => 0,
  } as unknown as ChatViewport
}

/**
 * 把刻度条挂进「.chat-wrap > .chat（滚动容器）> 行」的架子；行由用例给——
 * 只有触发行（不带 .entry-user 气泡），正是旧写法数不到的那种。
 */
function mount(options: {
  rows: Array<{ round: number; hidden?: boolean }>
  atFloor: () => boolean
  scrollTop?: () => number
}): { container: HTMLElement; scroller: HTMLElement } {
  const wrap = document.createElement('div')
  wrap.className = 'chat-wrap'
  const scroller = document.createElement('div')
  scroller.className = 'chat'
  for (const row of options.rows) {
    const el = document.createElement('div')
    el.setAttribute('data-round', String(row.round))
    if (row.hidden === true) el.hidden = true
    else el.textContent = '触发行（没有用户气泡）'
    scroller.appendChild(el)
  }
  wrap.appendChild(scroller)
  document.body.appendChild(wrap)
  render(
    <JumpRail
      rounds={rounds(Math.max(2, options.rows.length))}
      renderedFrom={0}
      onReveal={(): void => undefined}
      viewport={fakeViewport(scroller, options.atFloor, options.scrollTop ?? ((): number => 0))}
    />,
    { container: wrap },
  )
  return { container: wrap, scroller }
}

/** 等组件的 rAF 测量落地（jsdom 的 rAF 用定时器实现，真实等一帧）。 */
const afterMeasure = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
}

/** 高亮的那枚刻度（当前轮）。 */
const activeTick = (container: HTMLElement): string | null =>
  container.querySelector('.jump-tick.on')?.getAttribute('data-turn') ?? null

describe('锚点按 [data-round] 收，不再只认用户气泡（ui-jump-rail [4] 行为化）', () => {
  test('触发行（无气泡）就是锚点：不贴底时按探针线的几何兜底判轮', async () => {
    // 锚点 round0 在内容坐标 0、round1 在 400；探针线在 scrollTop+8=408 → 落第 1 轮。
    let scrollTop = 400
    const { container, scroller } = mount({ rows: [{ round: 0 }, { round: 1 }], atFloor: () => false, scrollTop: () => scrollTop })
    await afterMeasure()
    expect(activeTick(container)).toBe('1')
    // 滚回顶部：探针线落在第 0 轮。
    scrollTop = 0
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll'))
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    expect(activeTick(container)).toBe('0')
  })

  test('贴底时高亮轮清单的最后一轮（2026-10-28 那个报障的现场：锚点只到第 0 轮）', async () => {
    // 子代理现场：会话有两轮，第二轮是汇报（这里连 DOM 锚点都只给第 0 轮）。
    const { container } = mount({ rows: [{ round: 0 }], atFloor: () => true })
    await afterMeasure()
    // 旧写法拿锚点尾部当最新一轮 → 高亮停在 0；现在由轮清单给 → 1。
    expect(activeTick(container)).toBe('1')
  })

  test('整轮收起的隐藏行不当锚点（量出来没有盒子，不会把「最上面」判给它）', async () => {
    // round1 的行整轮收起（没有盒子）。可见锚点只有 round0（内容坐标 0）。
    // 探针线在 8：若隐藏行混进锚点（top 0 ≤ 8），兜底会把「当前轮」判给藏起来的第 1 轮。
    const { container } = mount({ rows: [{ round: 0 }, { round: 1, hidden: true }], atFloor: () => false })
    await afterMeasure()
    expect(activeTick(container)).toBe('0')
  })
})
