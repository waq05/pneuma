/**
 * 会话区视口协调器（`viewport.ts`）的边界补测（ui 层，真 hook + 真 DOM）。
 *
 * 既有 `turn-spacer.spec.tsx` 只走到「占位、floor、pin、overflow-anchor」主路径。
 * 这一份只补它的空白面——挂载/摘除、隐藏态、逐帧补间的中途与收尾、锚点身份找回
 * （座位键 / 轮号 + 行号 / 找不回时的降级）、两类批次落点与读历史态的锚点筛选：
 *
 *  - 没挂容器时所有测量/写入口给安全默认值（floor 0、atFloor false、beginBatch null）；
 *  - `attach` 的四个边界：空节点、不在 `.chat` 里、同一个容器重复挂、换容器后计数归零；
 *  - `offsetOf` 的四种 null 情形（没容器 / null / 元素脱开 / 没有盒子）；
 *  - `scrollToOffset` 的夹取、隐藏态、`jump` 交接、`smooth` 补间的中间帧与收尾；
 *  - `captureAnchor` / `restoreAnchor` 的座位键、轮号 + 行号两套身份，以及降级计数；
 *  - 批次：跟随态落 floor、读历史态挑第一条可见行（跳过 hidden / 零高 / 已滚出上方 /
 *    正在动的盒子）、锚点找不回时夹回 floor、`end()` 重复调用无害；
 *  - `ResizeObserver` / `MutationObserver` 缺席时批次照样能开能收。
 *
 * jsdom 没有布局：几何全部按元素打桩（`scrollHeight` / `clientHeight` / `offsetHeight` /
 * `getBoundingClientRect` / `getClientRects`），帧回调收进队列由用例手动推。
 *
 * @module dsc-ui-transcript/ui/viewport-extra.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  readSlowMs,
  useChatViewport,
  type ChatViewportHandle,
  type ScrollAnchor,
  type ViewportReader,
} from './viewport.js'

/** 本用例挂上去的 rAF 回调；由 {@link flushFrame} 一帧一帧推。 */
let frameQueue: FrameRequestCallback[] = []
let nextFrameId = 0

beforeEach(() => {
  frameQueue = []
  nextFrameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    nextFrameId += 1
    frameQueue.push(callback)
    return nextFrameId
  })
  vi.stubGlobal('cancelAnimationFrame', (): void => undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 推一帧（队列里的下一个回调）。 */
function flushFrame(): void {
  const callback = frameQueue.shift()
  if (callback === undefined) throw new Error('这一帧没有排队的 rAF')
  callback(0)
}

/** 把视口挂到一个最小 `.chat` 上，并交出 handle。 */
function Probe({ onReady, children }: { onReady(handle: ChatViewportHandle): void; children?: ReactNode }): ReactNode {
  const handle = useChatViewport()
  onReady(handle)
  return (
    <div className="chat" ref={handle.attach}>
      {children}
    </div>
  )
}

/** 挂一次并返回常用节点。 */
function mount(children?: ReactNode): { handle: ChatViewportHandle; container: HTMLElement; chat: HTMLElement } {
  let handle!: ChatViewportHandle
  const { container } = render(<Probe onReady={(value) => { handle = value }}>{children}</Probe>)
  return { handle, container, chat: container.querySelector('.chat') as HTMLElement }
}

/** jsdom 没有布局：按实例打桩数值属性。 */
function setNumber(
  element: HTMLElement,
  key: 'scrollHeight' | 'clientHeight' | 'clientWidth' | 'offsetHeight',
  value: number,
): void {
  Object.defineProperty(element, key, { configurable: true, get: () => value })
}

/** jsdom 没有布局：按实例打桩矩形。 */
function setRect(element: Element, top: number, height = 20): void {
  element.getBoundingClientRect = (): DOMRect =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 10,
      width: 10,
      x: 0,
      y: top,
      toJSON: (): Record<string, number> => ({ top, height }),
    }) as DOMRect
}

/** `offsetOf` 先问 `getClientRects().length`，零矩形代表没有盒子。 */
function setClientRects(element: Element, length: number): void {
  element.getClientRects = (): DOMRectList => ({ length }) as DOMRectList
}

/** 一个最小跟随策略替身。 */
function readerOf(over: Partial<ViewportReader> = {}): ViewportReader {
  return {
    following: () => true,
    wrote: vi.fn(),
    jumped: vi.fn(),
    ...over,
  }
}

describe('readSlowMs：时长令牌的四种口径', () => {
  test('ms / s 都换算成毫秒；非法值与非正值回落 180', () => {
    const styleOf = (raw: string): CSSStyleDeclaration =>
      ({ getPropertyValue: (): string => raw }) as unknown as CSSStyleDeclaration
    const computed = vi.spyOn(window, 'getComputedStyle')

    computed.mockReturnValue(styleOf('250ms'))
    expect(readSlowMs()).toBe(250)

    computed.mockReturnValue(styleOf('0.25s'))
    expect(readSlowMs()).toBe(250)

    computed.mockReturnValue(styleOf('oops'))
    expect(readSlowMs()).toBe(180)

    computed.mockReturnValue(styleOf('-1ms'))
    expect(readSlowMs()).toBe(180)

    computed.mockReturnValue(styleOf('0s'))
    expect(readSlowMs()).toBe(180)
  })
})

describe('没挂容器：测量与写入口的安全默认值', () => {
  test('摘掉之后全部读到空值，写滚动与开批次都是空操作', () => {
    const { handle } = mount()
    const viewport = handle.viewport
    viewport.detach()

    expect(viewport.scroller).toBeNull()
    expect(viewport.column).toBeNull()
    expect(viewport.spacer).toBeNull()
    expect(viewport.scrollTop()).toBe(0)
    expect(viewport.scrollHeight()).toBe(0)
    expect(viewport.clientHeight()).toBe(0)
    expect(viewport.clientWidth()).toBe(0)
    expect(viewport.spacerHeight()).toBe(0)
    expect(viewport.floor()).toBe(0)
    expect(viewport.floorSlack()).toBe(0)
    expect(viewport.hidden()).toBe(true)
    // 藏起来（这里是「没有容器」）一律判不在底。
    expect(viewport.atFloor()).toBe(false)
    expect(viewport.offsetOf(null)).toBeNull()
    expect(viewport.rect()).toBeNull()
    expect(viewport.scrollToOffset(120)).toBe(0)
    expect(viewport.pin()).toBe(0)
    expect(viewport.captureAnchor()).toBeNull()
    expect(viewport.restoreAnchor({ element: document.createElement('div'), top: 0 })).toBe(0)
    expect(viewport.beginBatch()).toBeNull()
    expect(viewport.batchActive()).toBe(false)
    expect(viewport.motionActive()).toBe(false)
    // 重复收尾不抛。
    viewport.endBatch()
    viewport.cancelMotion()
  })
})

describe('attach：空节点 / 不在 .chat / 同容器 / 换容器', () => {
  test('不在 .chat 里的节点与 null 都摘干净；同容器重复挂是空操作；换容器重置降级计数', () => {
    const { handle } = mount()
    const viewport = handle.viewport

    const chatA = document.createElement('div')
    chatA.className = 'chat'
    const innerA = document.createElement('div')
    chatA.appendChild(innerA)
    const spacerA = document.createElement('div')
    spacerA.setAttribute('data-chat-turn-spacer', '')
    chatA.appendChild(spacerA)

    const chatB = document.createElement('div')
    chatB.className = 'chat'
    const innerB = document.createElement('div')
    chatB.appendChild(innerB)

    // 不在任何 .chat 里：摘掉（这里本来是挂着的渲染容器）。
    viewport.attach(document.createElement('div'))
    expect(viewport.scroller).toBeNull()

    setRect(chatA, 100, 300)
    viewport.attach(innerA)
    expect(viewport.scroller).toBe(chatA)
    expect(viewport.spacer).toBe(spacerA)
    expect(viewport.column).toBe(innerA)
    expect(viewport.rect()?.top).toBe(100)

    // 同一个容器再挂一次：早退，不重置降级计数。
    chatA.dataset.foldAnchorFallback = '7'
    const spacerBefore = viewport.spacer
    viewport.attach(innerA)
    expect(chatA.dataset.foldAnchorFallback).toBe('7')
    expect(viewport.spacer).toBe(spacerBefore)

    // 换容器：计数归零、新容器上的降级属性被清掉；旧容器上的历史值不再归它管。
    chatB.dataset.foldAnchorFallback = '3'
    viewport.attach(innerB)
    expect(viewport.scroller).toBe(chatB)
    expect(viewport.spacer).toBeNull()
    expect(chatB.dataset.foldAnchorFallback).toBeUndefined()
    expect(chatA.dataset.foldAnchorFallback).toBe('7')

    // 内容列不是 HTMLElement（SVG）时给 null，不把非元素当列。
    const chatC = document.createElement('div')
    chatC.className = 'chat'
    chatC.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    const innerC = document.createElement('div')
    chatC.appendChild(innerC)
    viewport.attach(innerC)
    expect(viewport.scroller).toBe(chatC)
    expect(viewport.column).toBeNull()

    viewport.attach(null)
    expect(viewport.scroller).toBeNull()
  })
})

describe('offsetOf：四种没有可信位置的情形', () => {
  test('null / 已脱开 / 没有盒子都给 null；有盒子时按内容原点算偏移', () => {
    const { handle, container } = mount(
      <>
        <div className="chat-inner">内容</div>
        <div className="entry-row" data-round="0">行</div>
      </>,
    )
    const chat = container.querySelector('.chat') as HTMLElement
    const row = container.querySelector('.entry-row') as HTMLElement
    setRect(chat, 100)
    chat.scrollTop = 30

    expect(handle.viewport.offsetOf(null)).toBeNull()
    expect(handle.viewport.offsetOf(document.createElement('div'))).toBeNull()

    setClientRects(row, 0)
    expect(handle.viewport.offsetOf(row)).toBeNull()

    setClientRects(row, 1)
    setRect(row, 200)
    // 内容原点 = 容器上缘 100 − 已滚 30 = 70；行顶 200 − 70 = 130。
    expect(handle.viewport.offsetOf(row)).toBe(130)
  })
})

describe('captureAnchor 与 setSpacer', () => {
  test('没有座位时锚点为 null；有座位时记下座位键与相对容器顶端的距离', () => {
    const { handle, container } = mount(
      <>
        <div className="chat-inner">内容</div>
        <div className="entry-row" data-round="0">普通行</div>
      </>,
    )
    const chat = container.querySelector('.chat') as HTMLElement
    setRect(chat, 100)
    expect(handle.viewport.captureAnchor()).toBeNull()

    const seat = document.createElement('div')
    seat.setAttribute('data-round-seat', '3')
    chat.appendChild(seat)
    setRect(seat, 340)
    const anchor = handle.viewport.captureAnchor()
    expect(anchor?.element).toBe(seat)
    expect(anchor?.seat).toBe('3')
    expect(anchor?.top).toBe(240)
  })

  test('占位写高度：同一值不重复写；0 与亚像素值都清掉内联样式；没有占位时是空操作', () => {
    const withSpacer = mount(
      <>
        <div className="chat-inner">内容</div>
        <div data-chat-turn-spacer="" />
      </>,
    )
    const spacer = withSpacer.container.querySelector('[data-chat-turn-spacer]') as HTMLElement
    withSpacer.handle.viewport.setSpacer(42)
    expect(spacer.style.height).toBe('42px')
    // 同值再写一次：不改（断言值本身，够钉住分支）。
    withSpacer.handle.viewport.setSpacer(42)
    expect(spacer.style.height).toBe('42px')
    withSpacer.handle.viewport.setSpacer(0)
    expect(spacer.style.height).toBe('')
    withSpacer.handle.viewport.setSpacer(0.2)
    expect(spacer.style.height).toBe('')

    const without = mount(<div className="chat-inner">内容</div>)
    // 没有占位元素：不抛、也没有东西可写。
    without.handle.viewport.setSpacer(42)
    expect(without.handle.viewport.spacer).toBeNull()
  })
})

describe('restoreAnchor：元素还挂着时的位移补偿', () => {
  test('漂移超过 EPS 就补、小于 EPS 不动；摘掉容器后一律 0', () => {
    const { handle, container } = mount(
      <>
        <div className="chat-inner">内容</div>
        <div data-round-seat="1">座位</div>
      </>,
    )
    const chat = container.querySelector('.chat') as HTMLElement
    const seat = container.querySelector('[data-round-seat]') as HTMLElement
    setRect(chat, 100)
    setRect(seat, 300)
    const anchor = handle.viewport.captureAnchor() as ScrollAnchor
    expect(anchor.top).toBe(200)

    // 座位从 300 移到 260：相对容器顶端从 200 变 160，补 −40。
    chat.scrollTop = 100
    setRect(seat, 260)
    expect(handle.viewport.restoreAnchor(anchor)).toBe(-40)
    expect(chat.scrollTop).toBe(60)

    // 亚像素抖动不补。
    chat.scrollTop = 50
    setRect(seat, 300.4)
    expect(handle.viewport.restoreAnchor(anchor)).toBe(0)
    expect(chat.scrollTop).toBe(50)

    handle.viewport.detach()
    expect(handle.viewport.restoreAnchor(anchor)).toBe(0)
  })
})

describe('restoreAnchor：重挂之后按身份找回同一行', () => {
  test('座位键含引号也能找回（选择器转义）；找不回时降级计数写在 .chat 上', () => {
    const { handle, container } = mount(
      <>
        <div className="chat-inner">内容</div>
        <div data-round-seat={'a"b'}>旧座位</div>
      </>,
    )
    const chat = container.querySelector('.chat') as HTMLElement
    const oldSeat = container.querySelector('[data-round-seat]') as HTMLElement
    setRect(chat, 0)
    setRect(oldSeat, 200)
    const anchor = handle.viewport.captureAnchor() as ScrollAnchor
    expect(anchor.seat).toBe('a"b')

    // React 重挂：旧节点脱开、同身份的新节点接在原位。
    oldSeat.remove()
    const nextSeat = document.createElement('div')
    nextSeat.setAttribute('data-round-seat', 'a"b')
    chat.appendChild(nextSeat)
    setRect(nextSeat, 240)
    chat.scrollTop = 0
    expect(handle.viewport.restoreAnchor(anchor)).toBe(40)
    expect(chat.scrollTop).toBe(40)

    // 普通行按「轮号 + 同轮行序号」找回。
    const other = document.createElement('div')
    other.className = 'entry-row'
    other.setAttribute('data-round', '8')
    const oldRow = document.createElement('div')
    oldRow.className = 'entry-row'
    oldRow.setAttribute('data-round', '7')
    chat.append(other, oldRow)
    const plain: ScrollAnchor = { element: oldRow, top: 50, round: '7', index: 1 }
    oldRow.remove()
    const row0 = document.createElement('div')
    row0.className = 'entry-row'
    row0.setAttribute('data-round', '7')
    const row1 = document.createElement('div')
    row1.className = 'entry-row'
    row1.setAttribute('data-round', '7')
    chat.append(row0, row1)
    setRect(row0, 100)
    setRect(row1, 250)
    chat.scrollTop = 0
    expect(handle.viewport.restoreAnchor(plain)).toBe(200)
    expect(chat.scrollTop).toBe(200)

    // 没有身份、座位找不到、行号找不到：三条都记降级。
    const noIdentity = document.createElement('div')
    expect(handle.viewport.restoreAnchor({ element: noIdentity, top: 0 })).toBe(0)
    expect(chat.dataset.foldAnchorFallback).toBe('1')

    const detachedSeat = document.createElement('div')
    expect(handle.viewport.restoreAnchor({ element: detachedSeat, top: 0, seat: 'nope' })).toBe(0)
    expect(chat.dataset.foldAnchorFallback).toBe('2')

    expect(handle.viewport.restoreAnchor({ element: detachedSeat, top: 0, round: '99', index: 9 })).toBe(0)
    expect(chat.dataset.foldAnchorFallback).toBe('3')
  })
})

describe('scrollToOffset：夹取、隐藏态与主动跳转', () => {
  test('负值夹到 0、超过 floor 夹到 floor；隐藏态原样返回；jump 把落点交回策略', () => {
    const { handle, container } = mount(<div className="chat-inner">内容</div>)
    const chat = container.querySelector('.chat') as HTMLElement
    setNumber(chat, 'scrollHeight', 1000)
    setNumber(chat, 'clientHeight', 200)
    const reader = readerOf()
    handle.viewport.bindReader(reader)

    expect(handle.viewport.scrollToOffset(-10)).toBe(0)
    expect(reader.wrote).toHaveBeenLastCalledWith(0)

    expect(handle.viewport.scrollToOffset(5000)).toBe(800)
    expect(reader.wrote).toHaveBeenLastCalledWith(800)

    expect(handle.viewport.scrollToOffset(120, 'instant', 'jump')).toBe(120)
    expect(reader.jumped).toHaveBeenLastCalledWith(120)

    // 藏起来：写 scrollTop 没有意义，原样返回，也不制造假滚动。
    setNumber(chat, 'clientHeight', 0)
    chat.scrollTop = 42
    expect(handle.viewport.hidden()).toBe(true)
    expect(handle.viewport.atFloor()).toBe(false)
    expect(handle.viewport.scrollToOffset(300)).toBe(42)
    expect(handle.viewport.pin()).toBe(42)

    handle.viewport.detach()
    expect(handle.viewport.scrollToOffset(300)).toBe(0)
  })
})

describe('smooth 补间：中间帧、收尾交接、取消与被打断', () => {
  test('逐帧写到落点；jump 在末帧交回策略；已在落点直接落定；后续写入打断补间', () => {
    const { handle, container } = mount(<div className="chat-inner">内容</div>)
    const chat = container.querySelector('.chat') as HTMLElement
    setNumber(chat, 'scrollHeight', 1000)
    setNumber(chat, 'clientHeight', 200)
    const reader = readerOf()
    handle.viewport.bindReader(reader)
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)

    // 0 → 600，补间时长读不到令牌时是 180ms。
    expect(handle.viewport.scrollToOffset(600, 'smooth', 'jump')).toBe(0)
    expect(handle.viewport.motionActive()).toBe(true)

    now.mockReturnValue(1090)
    flushFrame()
    expect(handle.viewport.motionActive()).toBe(true)
    expect(chat.scrollTop).toBeGreaterThan(0)
    expect(chat.scrollTop).toBeLessThan(600)

    now.mockReturnValue(1300)
    flushFrame()
    expect(handle.viewport.motionActive()).toBe(false)
    expect(chat.scrollTop).toBe(600)
    expect(reader.jumped).toHaveBeenCalledTimes(1)
    expect(reader.jumped).toHaveBeenLastCalledWith(600)

    // 跟随态补间（无 jump）：末帧不交回。
    now.mockReturnValue(2000)
    expect(handle.viewport.scrollToOffset(700, 'smooth')).toBe(600)
    now.mockReturnValue(2200)
    flushFrame()
    expect(chat.scrollTop).toBe(700)
    expect(reader.jumped).toHaveBeenCalledTimes(1)

    // 点的就是当前位置：没有补间，但仍按落点重算一次跟随意图。
    expect(handle.viewport.scrollToOffset(700, 'smooth', 'jump')).toBe(700)
    expect(reader.jumped).toHaveBeenCalledTimes(2)
    expect(handle.viewport.motionActive()).toBe(false)

    // 取消补间：之后到来的一帧什么都不做。
    now.mockReturnValue(3000)
    handle.viewport.scrollToOffset(300, 'smooth')
    expect(handle.viewport.motionActive()).toBe(true)
    handle.viewport.cancelMotion()
    expect(handle.viewport.motionActive()).toBe(false)
    flushFrame()
    expect(chat.scrollTop).toBe(700)

    // 补间被一次瞬移打断：位置意图以新写入为准。
    now.mockReturnValue(4000)
    handle.viewport.scrollToOffset(200, 'smooth')
    expect(handle.viewport.motionActive()).toBe(true)
    expect(handle.viewport.scrollToOffset(50)).toBe(50)
    expect(handle.viewport.motionActive()).toBe(false)
    flushFrame()
    expect(chat.scrollTop).toBe(50)
  })
})

describe('bindReader：解绑只认自己那一次绑定', () => {
  test('解绑后不再收到落点；旧解绑函数不误伤新绑定；绑 null 合法', () => {
    const { handle, container } = mount(<div className="chat-inner">内容</div>)
    const chat = container.querySelector('.chat') as HTMLElement
    setNumber(chat, 'scrollHeight', 1000)
    setNumber(chat, 'clientHeight', 200)

    const first = readerOf()
    const unbindFirst = handle.viewport.bindReader(first)
    handle.viewport.scrollToOffset(10, 'instant', 'jump')
    expect(first.jumped).toHaveBeenCalledTimes(1)

    unbindFirst()
    handle.viewport.scrollToOffset(20, 'instant', 'jump')
    expect(first.jumped).toHaveBeenCalledTimes(1)

    const second = readerOf()
    handle.viewport.bindReader(second)
    // 旧的解绑函数再跑一次：新绑定不能被它清掉。
    unbindFirst()
    handle.viewport.scrollToOffset(30, 'instant', 'jump')
    expect(second.jumped).toHaveBeenCalledTimes(1)

    const unbindSecond = handle.viewport.bindReader(null)
    unbindSecond()
    handle.viewport.scrollToOffset(40, 'instant', 'jump')
    expect(second.jumped).toHaveBeenCalledTimes(1)
  })
})

describe('批次：跟随态落 floor、收尾幂等', () => {
  test('开始写 overflow-anchor、收尾还回去；重复 end 无害；结束后的 frame 不再补', () => {
    const { handle, container } = mount(<div className="chat-inner">内容</div>)
    const chat = container.querySelector('.chat') as HTMLElement
    setNumber(chat, 'scrollHeight', 1000)
    setNumber(chat, 'clientHeight', 200)
    const reader = readerOf()
    handle.viewport.bindReader(reader)

    const batch = handle.viewport.beginBatch({ durationMs: 1000 })
    expect(batch).not.toBeNull()
    expect(batch?.landing).toBe('tail')
    expect(handle.viewport.batchActive()).toBe(true)
    expect(chat.style.overflowAnchor).toBe('none')

    chat.scrollTop = 0
    batch?.frame()
    expect(chat.scrollTop).toBe(800)
    const wroteAfterFirst = (reader.wrote as ReturnType<typeof vi.fn>).mock.calls.length
    batch?.frame()
    expect((reader.wrote as ReturnType<typeof vi.fn>).mock.calls.length).toBe(wroteAfterFirst)

    batch?.end()
    expect(handle.viewport.batchActive()).toBe(false)
    expect(chat.style.overflowAnchor).toBe('')
    expect(reader.wrote).toHaveBeenLastCalledWith(800)

    // 重复收尾与结束后的帧都是空操作。
    batch?.end()
    batch?.frame()
    handle.viewport.endBatch()
    expect(chat.scrollTop).toBe(800)

    // 没有 reader 时按跟随态（tail）开；新批次会把上一批就地收掉。
    handle.viewport.bindReader(null)
    const first = handle.viewport.beginBatch({ durationMs: 1000 })
    const second = handle.viewport.beginBatch({ durationMs: 1000 })
    expect(first?.active).toBe(false)
    expect(second?.active).toBe(true)
    expect(second?.landing).toBe('tail')
    second?.end()
  })
})

describe('批次：观察器缺席 / 列不是元素', () => {
  test('ResizeObserver 与 MutationObserver 都没有时批次照样能开能收', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    vi.stubGlobal('MutationObserver', undefined)
    const { handle, container } = mount(<div className="chat-inner">内容</div>)
    setNumber(container.querySelector('.chat') as HTMLElement, 'clientHeight', 200)

    const batch = handle.viewport.beginBatch({ durationMs: 1000 })
    expect(batch?.active).toBe(true)
    batch?.end()
    expect(handle.viewport.batchActive()).toBe(false)
  })

  test('有 ResizeObserver 时观察列与容器；列不是 HTMLElement 时只观察容器', () => {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const { handle } = mount(<div className="chat-inner">内容</div>)
    const first = handle.viewport.beginBatch({ durationMs: 1000 })
    expect(first?.active).toBe(true)
    first?.end()

    // 换一个首子节点是 SVG 的容器：column 为 null，开批次不炸。
    const chat = document.createElement('div')
    chat.className = 'chat'
    chat.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    const inner = document.createElement('div')
    chat.appendChild(inner)
    handle.viewport.attach(inner)
    expect(handle.viewport.column).toBeNull()
    const second = handle.viewport.beginBatch({ durationMs: 1000 })
    expect(second?.active).toBe(true)
    second?.end()
  })
})

describe('批次：读历史态的锚点筛选', () => {
  test('hidden / 零高 / 已滚出上方都跳过；正在动的先记兜底，后面有不动的那行就用它', () => {
    const { handle, container } = mount(
      <>
        <div className="chat-inner">内容</div>
        <div className="entry-row" data-round="0" hidden>收起</div>
        <div className="entry-row" data-round="0">零高</div>
        <div className="entry-row" data-round="0">上方</div>
        <div className="entry-row" data-round="0">正在动</div>
        <div className="entry-row" data-round="0">目标</div>
      </>,
    )
    const chat = container.querySelector('.chat') as HTMLElement
    const rows = [...container.querySelectorAll('.entry-row')] as HTMLElement[]
    setRect(chat, 0, 400)
    setRect(rows[0]!, 50)
    setRect(rows[1]!, 60, 0)
    setRect(rows[2]!, -30)
    setRect(rows[3]!, 50)
    setRect(rows[4]!, 120)
    handle.viewport.bindReader(readerOf({ following: () => false }))

    const batch = handle.viewport.beginBatch({ moving: [rows[3]!], durationMs: 1000 })
    expect(batch?.landing).toBe('reading')

    // 目标行上移 30px：这一帧补 −30。
    setRect(rows[4]!, 90)
    chat.scrollTop = 300
    batch?.frame()
    expect(chat.scrollTop).toBe(270)
    batch?.end()
  })

  test('可见行全在动且下一行已滚出下方：退回兜底那一行；整块藏起来时没有锚点', () => {
    const { handle, container } = mount(
      <>
        <div className="chat-inner">内容</div>
        <div className="entry-row" data-round="0">正在动</div>
        <div className="entry-row" data-round="0">下方</div>
      </>,
    )
    const chat = container.querySelector('.chat') as HTMLElement
    const rows = [...container.querySelectorAll('.entry-row')] as HTMLElement[]
    setRect(chat, 0, 400)
    setRect(rows[0]!, 50)
    setRect(rows[1]!, 450)
    handle.viewport.bindReader(readerOf({ following: () => false }))

    const batch = handle.viewport.beginBatch({ moving: [rows[0]!], durationMs: 1000 })
    setRect(rows[0]!, 30)
    chat.scrollTop = 100
    batch?.frame()
    expect(chat.scrollTop).toBe(80)
    batch?.end()

    // 容器高度 0：读历史态拿不到参照，这一批一帧都不写。
    setRect(chat, 0, 0)
    chat.scrollTop = 80
    const hiddenView = handle.viewport.beginBatch({ durationMs: 1000 })
    expect(hiddenView?.landing).toBe('reading')
    hiddenView?.frame()
    expect(chat.scrollTop).toBe(80)
    hiddenView?.end()
  })
})

describe('批次：读历史态锚点找不回 / 零高 / 亚像素', () => {
  test('找不回按身份降级并夹回 floor；零高行停手；亚像素漂移不补', () => {
    const { handle, container } = mount(
      <>
        <div className="chat-inner">内容</div>
        <div className="entry-row" data-round="0">锚点</div>
      </>,
    )
    const chat = container.querySelector('.chat') as HTMLElement
    setNumber(chat, 'scrollHeight', 700)
    setNumber(chat, 'clientHeight', 200)
    setRect(chat, 0, 600)
    const row = container.querySelector('.entry-row') as HTMLElement
    setRect(row, 100)
    handle.viewport.bindReader(readerOf({ following: () => false }))

    const batch = handle.viewport.beginBatch({ durationMs: 1000 })
    // 锚点行被删掉：这一帧没有可信的尺子，只做几何兜底（夹回 floor 500）。
    row.remove()
    chat.scrollTop = 700
    batch?.frame()
    expect(chat.dataset.foldAnchorFallback).toBe('1')
    expect(chat.scrollTop).toBe(500)
    batch?.frame()
    expect(chat.dataset.foldAnchorFallback).toBe('2')
    expect(chat.scrollTop).toBe(500)
    batch?.end()

    // 锚点行这一帧被藏起来（零高）：停手，不拿 0 矩形乱补。
    const zero = document.createElement('div')
    zero.className = 'entry-row'
    zero.setAttribute('data-round', '1')
    chat.appendChild(zero)
    setRect(zero, 100)
    const zeroBatch = handle.viewport.beginBatch({ durationMs: 1000 })
    setRect(zero, 100, 0)
    chat.scrollTop = 400
    zeroBatch?.frame()
    expect(chat.scrollTop).toBe(400)
    zeroBatch?.end()

    // 亚像素漂移：不补。
    const tiny = document.createElement('div')
    tiny.className = 'entry-row'
    tiny.setAttribute('data-round', '2')
    chat.appendChild(tiny)
    setRect(tiny, 100)
    const tinyBatch = handle.viewport.beginBatch({ durationMs: 1000 })
    setRect(tiny, 100.2)
    chat.scrollTop = 400
    tinyBatch?.frame()
    expect(chat.scrollTop).toBe(400)
    tinyBatch?.end()
  })
})
