/**
 * 正文列拖拽条的渲染面补测（ui 层，真渲染 + 真指针事件）。
 *
 * `panels-resizer.spec.ts` 只钉了 `panels.ts` 的纯逻辑（夹取数学、读档、写根变量），
 * `thread-resizer.tsx` 自己那一层从没被渲染过——本文件补它的三条接缝：
 *
 *  - `resolve(px)` 的两种口径：没存档时量 `.chat-inner` 真实 offsetWidth，有存档时夹进
 *    「本层宽 − 两侧预算 − 右缘轨道」；本层窄到放不下下限时仍给 THREAD_MIN；
 *  - 拖动每一帧 `onDrag` 写 `--dsc-thread-user-max` 并重量一次列缘（写进本层两个变量）；
 *  - 松手落盘 `onCommit`（没移动就不落）、双击复位 `onReset`。
 *
 * jsdom 没有布局：`clientWidth` / `offsetWidth` / `getBoundingClientRect` 全部按实例打桩；
 * rAF 与 Pointer Capture 是 jsdom 缺的两样（后者用全局原型桩补），帧回调收进队列手动推。
 *
 * @module dsc-ui-primitives/ui/w13-thread-resizer.spec
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { THREAD_EDGE_BUDGET, THREAD_MIN } from './panels.js'
import { ThreadResizer } from './thread-resizer.js'

/** 本用例排队的 rAF 回调；{@link flushFrame} 一次推一帧。 */
let frameQueue: FrameRequestCallback[] = []

beforeEach(() => {
  frameQueue = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frameQueue.push(callback)
    return frameQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', (): void => undefined)
  // jsdom 没有 PointerEvent（fireEvent.pointerDown 会退化成无 button 的 Event，
  // 组件的 `event.button !== 0` 早退）：补一个带 button / clientX / pointerId 的。
  vi.stubGlobal(
    'PointerEvent',
    class PointerEventPolyfill extends MouseEvent {
      readonly pointerId: number
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init)
        this.pointerId = init.pointerId ?? 1
      }
    },
  )
  // jsdom 不实现 Pointer Capture 与 ResizeObserver；组件挂载期就会碰它们。
  const proto = Element.prototype as unknown as {
    setPointerCapture?: () => void
    hasPointerCapture?: () => boolean
    releasePointerCapture?: () => void
  }
  proto.setPointerCapture = (): void => undefined
  proto.hasPointerCapture = (): boolean => true
  proto.releasePointerCapture = (): void => undefined
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  )
  // 只读样式令牌：读不到就回落 36 + 5 = 41。
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (): string => '' }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.documentElement.style.removeProperty('--dsc-thread-user-max')
})

/** 推一帧（队列里的下一个回调）。 */
function flushFrame(): void {
  const callback = frameQueue.shift()
  if (callback === undefined) throw new Error('这一帧没有排队的 rAF')
  callback(0)
}

/** 按实例打桩尺寸属性（jsdom 全给 0）。 */
function setNumber(element: Element, key: 'clientWidth' | 'offsetWidth', value: number): void {
  Object.defineProperty(element, key, { configurable: true, get: (): number => value })
}

interface Mounted {
  handles: HTMLElement[]
  zone: HTMLElement
  onCommit: ReturnType<typeof vi.fn<(px: number) => void>>
  onReset: ReturnType<typeof vi.fn<() => void>>
}

/** 挂一条拖拽条：本层宽 1000、内容列宽 700（可覆盖）。 */
function mount(options: { width: number | null; zoneWidth?: number; columnWidth?: number }): Mounted {
  const onCommit = vi.fn<(px: number) => void>()
  const onReset = vi.fn<() => void>()
  const columnWidth = options.columnWidth ?? 700
  const zoneWidth = options.zoneWidth ?? 1000
  const page = render(
    <div className="thread-zone">
      <div className="chat-inner" />
      <ThreadResizer width={options.width} onCommit={onCommit} onReset={onReset} />
    </div>,
  )
  const zone = page.container.querySelector('.thread-zone') as HTMLElement
  const column = page.container.querySelector('.chat-inner') as HTMLElement
  setNumber(zone, 'clientWidth', zoneWidth)
  setNumber(column, 'offsetWidth', columnWidth)
  zone.getBoundingClientRect = (): DOMRect => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  column.getBoundingClientRect = (): DOMRect => ({ left: 100, top: 0, right: 800, bottom: 800, width: 700, height: 800, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect
  const handles = [...page.container.querySelectorAll('.thread-handle')] as HTMLElement[]
  return { handles, zone, onCommit, onReset }
}

/** 按一下左侧把手（按钮 0 = 左键）。 */
function pressDown(handle: HTMLElement, clientX: number): void {
  fireEvent.pointerDown(handle, { button: 0, clientX, pointerId: 1 })
}

describe('resolve：没存档量内容列、有存档夹进本层', () => {
  test('width=null 时按下取内容列真实宽 700 做基准', () => {
    const { handles, onCommit } = mount({ width: null })
    const left = handles[0] as HTMLElement
    pressDown(left, 100)
    // 左把手 sign=-2：右移 100 → 700 - 200 = 500。
    fireEvent.pointerMove(left, { clientX: 200, pointerId: 1 })
    flushFrame()
    expect(document.documentElement.style.getPropertyValue('--dsc-thread-user-max')).toBe('500px')
    fireEvent.pointerUp(left, { clientX: 200, pointerId: 1 })
    expect(onCommit).toHaveBeenCalledWith(500)
  })

  test('有存档且超出本层上限时夹到「本层宽 − 80 − 41」；低于下限夹到 480', () => {
    const wide = mount({ width: 2000 })
    pressDown(wide.handles[0] as HTMLElement, 100)
    fireEvent.pointerMove(wide.handles[0] as HTMLElement, { clientX: 100, pointerId: 1 })
    flushFrame()
    // 1000 − THREAD_EDGE_BUDGET(80) − 右缘轨道(41) = 879。
    expect(document.documentElement.style.getPropertyValue('--dsc-thread-user-max')).toBe(
      `${String(1000 - THREAD_EDGE_BUDGET - 41)}px`,
    )

    const narrow = mount({ width: 10 })
    pressDown(narrow.handles[0] as HTMLElement, 100)
    fireEvent.pointerMove(narrow.handles[0] as HTMLElement, { clientX: 100, pointerId: 1 })
    flushFrame()
    expect(document.documentElement.style.getPropertyValue('--dsc-thread-user-max')).toBe(
      `${String(THREAD_MIN)}px`,
    )
  })

  test('本层窄到比下限还窄：仍给 THREAD_MIN（夹取上限不塌成负数）', () => {
    const { handles } = mount({ width: 2000, zoneWidth: 100 })
    pressDown(handles[0] as HTMLElement, 100)
    fireEvent.pointerMove(handles[0] as HTMLElement, { clientX: 100, pointerId: 1 })
    flushFrame()
    expect(document.documentElement.style.getPropertyValue('--dsc-thread-user-max')).toBe(
      `${String(THREAD_MIN)}px`,
    )
  })
})

describe('拖动落盘与复位', () => {
  test('拖动帧顺带重量列缘：本层两个列缘变量按内容列矩形写', () => {
    const { handles, zone } = mount({ width: 600 })
    const left = handles[0] as HTMLElement
    pressDown(left, 100)
    fireEvent.pointerMove(left, { clientX: 150, pointerId: 1 })
    flushFrame()
    // 列矩形 left=100 / right=800，本层 left=0：写 100px / 800px。
    expect(zone.style.getPropertyValue('--dsc-thread-col-start')).toBe('100px')
    expect(zone.style.getPropertyValue('--dsc-thread-col-end')).toBe('800px')
  })

  test('只按不拖：松手不落盘（别用窗口夹过的显示值覆盖更宽的存档）', () => {
    const { handles, onCommit } = mount({ width: 600 })
    const left = handles[0] as HTMLElement
    pressDown(left, 100)
    fireEvent.pointerUp(left, { clientX: 100, pointerId: 1 })
    expect(onCommit).not.toHaveBeenCalled()
  })

  test('双击把手复位（两条把手都接到 onReset）', () => {
    const { handles, onReset } = mount({ width: 600 })
    fireEvent.doubleClick(handles[0] as HTMLElement)
    fireEvent.doubleClick(handles[1] as HTMLElement)
    expect(onReset).toHaveBeenCalledTimes(2)
  })
})
