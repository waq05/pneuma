/**
 * 会话区视口协调器的批次观察器与帧时钟补测（ui 层，真 hook + 真 DOM）。
 *
 * `viewport-extra.spec.tsx` 把批次补位置的主体覆盖得很全，但它推的是 `batch.frame()`；
 * `Batch` 自己那条**时间线**从没跑过：
 *
 *  - `ResizeObserver` / `MutationObserver` 的回调进来走 `step()`（补一次、仍活着时继续）；
 *  - `begin()` 排的 rAF `tick()`：每帧 `land()` 一次，到 deadline 自己收批；
 *  - deadline 之前的 tick 会继续排帧，收批之后的 tick 立刻返回。
 *
 * jsdom 没有布局：容器高度按实例打桩；rAF 收进队列由用例手动推；两个观察器换成
 * 「记下回调、由用例手动触发」的桩（要验的正是「回调进来之后做什么」）。
 *
 * @module dsc-ui-transcript/ui/w13-viewport.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useChatViewport, type ChatViewportHandle, type ViewportReader } from './viewport.js'

let frameQueue: FrameRequestCallback[] = []
/** 用例手动触发的观察器回调（`new ResizeObserver(cb)` 的 cb）。 */
let resizeCallback: (() => void) | null = null
let mutationCallback: (() => void) | null = null

beforeEach(() => {
  frameQueue = []
  resizeCallback = null
  mutationCallback = null
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frameQueue.push(callback)
    return frameQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', (): void => undefined)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallback = callback
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(callback: () => void) {
        mutationCallback = callback
      }
      observe(): void {}
      disconnect(): void {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function flushFrame(): void {
  const callback = frameQueue.shift()
  if (callback === undefined) throw new Error('这一帧没有排队的 rAF')
  callback(0)
}

function setNumber(element: HTMLElement, key: 'scrollHeight' | 'clientHeight', value: number): void {
  Object.defineProperty(element, key, { configurable: true, get: (): number => value })
}

/** 挂一个最小 `.chat` 并交出 handle。 */
function mount(): { handle: ChatViewportHandle; chat: HTMLElement } {
  let handle!: ChatViewportHandle
  function Probe(): ReactNode {
    const value = useChatViewport()
    handle = value
    return <div className="chat" ref={value.attach} />
  }
  const { container } = render(<Probe />)
  return { handle, chat: container.querySelector('.chat') as HTMLElement }
}

/** 跟随态读者：`wrote` 记账，方便断言「补了一次」。 */
function follower(): ViewportReader {
  return { following: () => true, wrote: vi.fn(), jumped: vi.fn() }
}

describe('观察器回调：尺寸变化与 DOM 变更各补一次', () => {
  test('ResizeObserver 回调把滚出底部的容器拉回 floor', () => {
    const { handle, chat } = mount()
    setNumber(chat, 'scrollHeight', 1000)
    setNumber(chat, 'clientHeight', 200)
    const reader = follower()
    handle.viewport.bindReader(reader)
    const batch = handle.viewport.beginBatch({ durationMs: 10_000 })
    expect(batch?.landing).toBe('tail')

    chat.scrollTop = 100
    expect(resizeCallback).not.toBeNull()
    resizeCallback?.()
    // tail 落点 = floor = 1000 − 200 = 800。
    expect(chat.scrollTop).toBe(800)
    expect(reader.wrote).toHaveBeenCalled()
    batch?.end()
  })

  test('MutationObserver 回调同样补一次；批次收掉之后回调不再写', () => {
    const { handle, chat } = mount()
    setNumber(chat, 'scrollHeight', 900)
    setNumber(chat, 'clientHeight', 200)
    const batch = handle.viewport.beginBatch({ durationMs: 10_000 })
    chat.scrollTop = 400
    expect(mutationCallback).not.toBeNull()
    mutationCallback?.()
    expect(chat.scrollTop).toBe(700)

    batch?.end()
    chat.scrollTop = 100
    // 收批之后 `live` 为 false：回调进来是空操作。
    mutationCallback?.()
    expect(chat.scrollTop).toBe(100)
  })
})

describe('rAF 帧时钟：每帧补一次，到点收批', () => {
  test('未到 deadline 继续排帧；到 deadline 收批并还回 overflow-anchor', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const { handle, chat } = mount()
    setNumber(chat, 'scrollHeight', 1000)
    setNumber(chat, 'clientHeight', 200)
    const reader = follower()
    handle.viewport.bindReader(reader)

    const batch = handle.viewport.beginBatch({ durationMs: 1000 })
    expect(batch?.active).toBe(true)
    expect(chat.style.overflowAnchor).toBe('none')

    chat.scrollTop = 100
    vi.spyOn(performance, 'now').mockReturnValue(400)
    flushFrame()
    expect(chat.scrollTop).toBe(800)
    expect(handle.viewport.batchActive()).toBe(true)
    // 还没到点：又排了一帧。
    expect(frameQueue).toHaveLength(1)

    vi.spyOn(performance, 'now').mockReturnValue(1200)
    flushFrame()
    expect(chat.scrollTop).toBe(800)
    expect(handle.viewport.batchActive()).toBe(false)
    expect(chat.style.overflowAnchor).toBe('')
  })

  test('收批之后迟到的 tick 直接返回（不写滚动、不再排帧）', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const { handle, chat } = mount()
    setNumber(chat, 'scrollHeight', 1000)
    setNumber(chat, 'clientHeight', 200)
    const batch = handle.viewport.beginBatch({ durationMs: 1000 })
    // begin 排的那一帧先取出来（模拟「这一帧来得晚」），收批后再推它。
    const late = frameQueue.shift() as FrameRequestCallback
    batch?.end()
    chat.scrollTop = 123
    late(0)
    expect(chat.scrollTop).toBe(123)
    expect(handle.viewport.batchActive()).toBe(false)
  })
})
