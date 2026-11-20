/**
 * 跟随策略的补盲（`packages/ui-transcript/ui/follow.ts`）：五条规矩里原来没走到的分支。
 *
 * 这里不渲染会话流，只把 `useFollowBottom` 挂在一个真 DOM 滚动容器上，视口用可控替身：
 * - 「只认自己的写」：位置没变只记账；
 * - 「高度变了但夹回底部」不判读者；
 * - 「松手必须有手势作证」：滚轮 / 键 / 指针三条手势，以及无手势时的补钉；
 * - 藏起来的容器：测量不可信时只记账、重新可见时补钉；
 * - 落定（`scrollend`）与逐帧补间（`motionActive`）期间的取舍；
 * - 视口回报（`wrote` / `jumped`）与换会话、`pause` / `resume`、卸载清理。
 *
 * @module dsc/packages/ui-transcript/ui/w12-follow.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useFollowBottom } from './follow.js'
import type { ChatViewport, ViewportReader } from './viewport.js'

/** 可控的视口状态。 */
interface FakeState {
  scrollTop: number
  scrollHeight: number
  hidden: boolean
  motion: boolean
  pinCalls: number
  cancelMotion: number
}

/** `useFollowBottom` 的返回值快照（Probe 每次渲染都交回来）。 */
interface FollowHandle {
  paused: boolean
  end: HTMLDivElement | null
  pause(): void
  resume(): void
}

interface Harness {
  scroller: HTMLDivElement
  viewport: ChatViewport
  state: FakeState
  reader(): ViewportReader | null
}

/** 造一个视口替身：只实现 follow.ts 真正会调的那些成员。 */
function makeHarness(): Harness {
  const scroller = document.createElement('div')
  const column = document.createElement('div')
  document.body.appendChild(scroller)
  document.body.appendChild(column)
  const state: FakeState = {
    scrollTop: 0,
    scrollHeight: 1000,
    hidden: false,
    motion: false,
    pinCalls: 0,
    cancelMotion: 0,
  }
  let reader: ViewportReader | null = null
  const viewport = {
    scroller,
    column,
    spacer: null,
    attach: (): void => undefined,
    detach: (): void => undefined,
    scrollTop: (): number => state.scrollTop,
    scrollHeight: (): number => state.scrollHeight,
    clientHeight: (): number => 200,
    clientWidth: (): number => 800,
    spacerHeight: (): number => 0,
    floor: (): number => Math.max(0, state.scrollHeight - 200),
    floorSlack: (): number => Math.max(0, state.scrollHeight - 200) - state.scrollTop,
    atFloor: (slack = 0): boolean => Math.max(0, state.scrollHeight - 200) - state.scrollTop <= slack,
    offsetOf: (): number | null => null,
    rect: (): DOMRect | null => null,
    scrollToOffset: (top: number): number => {
      state.scrollTop = top
      return top
    },
    motionActive: (): boolean => state.motion,
    cancelMotion: (): void => {
      state.cancelMotion += 1
      state.motion = false
    },
    hidden: (): boolean => state.hidden,
    pin: (): number => {
      state.pinCalls += 1
      state.scrollTop = Math.max(0, state.scrollHeight - 200)
      return state.scrollTop
    },
    setSpacer: (): void => undefined,
    captureAnchor: (): null => null,
    restoreAnchor: (): number => 0,
    bindReader: (next: ViewportReader): (() => void) => {
      reader = next
      return () => {
        reader = null
      }
    },
  } as unknown as ChatViewport
  return { scroller, viewport, state, reader: () => reader }
}

/** 最小的挂载组件：只调 hook，把返回值交回去。 */
function Probe(props: {
  viewport: ChatViewport
  sessionKey: string
  dep: number
  onFollow(follow: FollowHandle): void
}): ReactNode {
  const follow = useFollowBottom(props.dep, props.sessionKey, props.viewport)
  props.onFollow(follow)
  return null
}

/** 挂载一次，返回 harness 与「最新一次渲染的 hook 返回值」。 */
function mount(options: { sessionKey?: string; dep?: number } = {}): {
  harness: Harness
  latest(): FollowHandle
  rerender(next: { sessionKey?: string; dep?: number }): void
  unmount(): void
} {
  const harness = makeHarness()
  let current: FollowHandle = { paused: false, end: null, pause: () => undefined, resume: () => undefined }
  const record = (follow: FollowHandle): void => {
    current = follow
  }
  const rendered = render(
    <Probe
      viewport={harness.viewport}
      sessionKey={options.sessionKey ?? 'sess-1'}
      dep={options.dep ?? 0}
      onFollow={record}
    />,
  )
  return {
    harness,
    latest: () => current,
    rerender: (next) => {
      rendered.rerender(
        <Probe
          viewport={harness.viewport}
          sessionKey={next.sessionKey ?? options.sessionKey ?? 'sess-1'}
          dep={next.dep ?? options.dep ?? 0}
          onFollow={record}
        />,
      )
    },
    unmount: () => rendered.unmount(),
  }
}

/** 派发一个滚动事件（真的走 addEventListener 那条路）。 */
function fireScroll(scroller: HTMLElement): void {
  act(() => {
    scroller.dispatchEvent(new Event('scroll'))
  })
}

let now = 10_000
let resizeCallback: (() => void) | null = null
let observeCount = 0
let disconnectCount = 0

beforeEach(() => {
  now = 10_000
  resizeCallback = null
  observeCount = 0
  disconnectCount = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallback = callback
      }
      observe(): void {
        observeCount += 1
      }
      unobserve(): void {}
      disconnect(): void {
        disconnectCount += 1
      }
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('只认自己的写 / 高度变化的判据', () => {
  test('scroll 位置与上次写的一致：只记账，不钉也不松', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    const before = state.pinCalls
    fireScroll(scroller)
    expect(state.pinCalls).toBe(before)
    expect(mounted.latest().paused).toBe(false)
  })

  test('位置变了但高度没变：无手势时补一次钉底，跟随不动', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    const before = state.pinCalls
    state.scrollTop = 300
    fireScroll(scroller)
    expect(state.pinCalls).toBe(before + 1)
    expect(mounted.latest().paused).toBe(false)
  })

  test('高度变了且夹回底部：认作内容驱动，不判读者', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    const before = state.pinCalls
    state.scrollHeight = 1200
    state.scrollTop = 1000
    fireScroll(scroller)
    expect(state.pinCalls).toBe(before)
    expect(mounted.latest().paused).toBe(false)
  })

  test('高度变了但不在底部：没有手势时仍补钉底', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    const before = state.pinCalls
    state.scrollHeight = 1200
    state.scrollTop = 100
    fireScroll(scroller)
    expect(state.pinCalls).toBe(before + 1)
  })

  test('已暂停时高度变矮夹回底部：排一次落定，落定后恢复跟随', async () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    act(() => {
      mounted.latest().pause()
    })
    expect(mounted.latest().paused).toBe(true)
    const before = state.pinCalls
    // 变矮 + 停在新的底上：认作内容驱动，跟随已关时要排一次落定。
    state.scrollHeight = 900
    state.scrollTop = 700
    fireScroll(scroller)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 240))
    })
    expect(mounted.latest().paused).toBe(false)
    expect(state.pinCalls).toBe(before + 1)
  })
})

describe('松手必须有手势作证', () => {
  test('往上滚轮：立刻松跟随并亮胶囊；随后的 scroll 只排落定不补钉', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    const beforeMotion = state.cancelMotion
    const before = state.pinCalls
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
    })
    expect(state.cancelMotion).toBe(beforeMotion + 1)
    state.scrollTop = 200
    fireScroll(scroller)
    expect(state.pinCalls).toBe(before)
    expect(mounted.latest().paused).toBe(true)
  })

  test('往下滚轮：停补间但不松跟随', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    const beforeMotion = state.cancelMotion
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }))
    })
    expect(state.cancelMotion).toBe(beforeMotion + 1)
    expect(mounted.latest().paused).toBe(false)
  })

  test('ctrl + 滚轮是缩放：既不抢补间也不松跟随', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    const beforeMotion = state.cancelMotion
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true }))
    })
    expect(state.cancelMotion).toBe(beforeMotion)
    expect(mounted.latest().paused).toBe(false)
  })

  test('ArrowUp 松跟随，ArrowDown 只停补间，其他键不处理', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    const beforeMotion = state.cancelMotion
    act(() => {
      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    })
    expect(state.cancelMotion).toBe(beforeMotion + 1)
    expect(mounted.latest().paused).toBe(false)
    act(() => {
      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
    })
    expect(state.cancelMotion).toBe(beforeMotion + 2)
    // 手势只是松手；胶囊在随后那条离开底部的 scroll 上亮。
    state.scrollTop = 200
    fireScroll(scroller)
    expect(mounted.latest().paused).toBe(true)
    act(() => {
      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    })
    expect(state.cancelMotion).toBe(beforeMotion + 2)
  })

  test('指针按下：只有鼠标按在滚动容器上或触摸 / 触控笔才停补间', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    const beforeMotion = state.cancelMotion
    const child = document.createElement('div')
    scroller.appendChild(child)
    act(() => {
      const event = new Event('pointerdown', { bubbles: true })
      Object.defineProperty(event, 'pointerType', { value: 'mouse' })
      child.dispatchEvent(event)
    })
    expect(state.cancelMotion).toBe(beforeMotion)
    act(() => {
      const event = new Event('pointerdown', { bubbles: true })
      Object.defineProperty(event, 'pointerType', { value: 'touch' })
      child.dispatchEvent(event)
    })
    expect(state.cancelMotion).toBe(beforeMotion + 1)
    act(() => {
      const event = new Event('pointerdown')
      Object.defineProperty(event, 'pointerType', { value: 'mouse' })
      scroller.dispatchEvent(event)
    })
    expect(state.cancelMotion).toBe(beforeMotion + 2)
  })

  test('藏起来的容器上的滚轮不算读者：不改跟随意图', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    state.hidden = true
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
    })
    expect(mounted.latest().paused).toBe(false)
  })
})

describe('藏起来的容器：只记账，重新可见时补钉', () => {
  test('隐藏期间 scroll / resize 只记账；重新可见的第一条 scroll 补钉', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    const before = state.pinCalls
    state.hidden = true
    state.scrollTop = 0
    fireScroll(scroller)
    expect(resizeCallback).not.toBeNull()
    act(() => {
      resizeCallback!()
    })
    expect(state.pinCalls).toBe(before)
    state.hidden = false
    fireScroll(scroller)
    expect(state.pinCalls).toBe(before + 1)
    expect(mounted.latest().paused).toBe(false)
  })
})

describe('落定与逐帧补间', () => {
  test('scrollend：跟随态补齐最后几像素', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    const before = state.pinCalls
    act(() => {
      scroller.dispatchEvent(new Event('scrollend'))
    })
    expect(state.pinCalls).toBe(before + 1)
  })

  test('scrollend：已松手但落点贴底 → 恢复跟随', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
    })
    state.scrollTop = 200
    fireScroll(scroller)
    expect(mounted.latest().paused).toBe(true)
    state.scrollTop = 800
    act(() => {
      scroller.dispatchEvent(new Event('scrollend'))
    })
    expect(mounted.latest().paused).toBe(false)
  })

  test('补间期间：scroll / scrollend / resize 都不采样', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    const before = state.pinCalls
    state.motion = true
    state.scrollTop = 123
    state.scrollHeight = 1200
    fireScroll(scroller)
    act(() => {
      scroller.dispatchEvent(new Event('scrollend'))
    })
    act(() => {
      resizeCallback!()
    })
    expect(state.pinCalls).toBe(before)
    expect(mounted.latest().paused).toBe(false)
  })

  test('内容变长：跟随态且不在底部才补钉；暂停态一动不动', () => {
    const mounted = mount()
    const { state } = mounted.harness
    const before = state.pinCalls
    state.scrollTop = 100
    act(() => {
      resizeCallback!()
    })
    expect(state.pinCalls).toBe(before + 1)
    act(() => {
      mounted.latest().pause()
    })
    expect(mounted.latest().paused).toBe(true)
    const pausedBase = state.pinCalls
    state.scrollTop = 0
    act(() => {
      resizeCallback!()
    })
    expect(state.pinCalls).toBe(pausedBase)
  })
})

describe('视口回报与换会话', () => {
  test('bindReader 收下 wrote：下一帧同位置不算读者动手', () => {
    const mounted = mount()
    const { scroller, state } = mounted.harness
    const reader = mounted.harness.reader()
    expect(reader).not.toBeNull()
    reader!.wrote(456)
    state.scrollTop = 456
    const before = state.pinCalls
    fireScroll(scroller)
    expect(state.pinCalls).toBe(before)
  })

  test('jumped：落点在底继续跟，不在底就脱离跟随并亮胶囊', () => {
    const mounted = mount()
    const { state } = mounted.harness
    const reader = mounted.harness.reader()!
    state.scrollTop = 800
    act(() => {
      reader.jumped!(800)
    })
    expect(mounted.latest().paused).toBe(false)
    state.scrollTop = 100
    act(() => {
      reader.jumped!(100)
    })
    expect(mounted.latest().paused).toBe(true)
  })

  test('换会话：重算跟随意图并补钉一次', () => {
    const mounted = mount()
    const { state } = mounted.harness
    const before = state.cancelMotion
    const beforePin = state.pinCalls
    act(() => {
      mounted.rerender({ sessionKey: 'sess-2' })
    })
    expect(state.cancelMotion).toBe(before + 1)
    expect(mounted.latest().paused).toBe(false)
    expect(state.pinCalls).toBe(beforePin + 1)
  })

  test('换会话时补间在跑：先不钉，等落点自己回来', () => {
    const mounted = mount()
    const { state } = mounted.harness
    state.motion = true
    const beforePin = state.pinCalls
    act(() => {
      mounted.rerender({ dep: 1 })
    })
    expect(state.pinCalls).toBe(beforePin)
  })

  test('pause / resume：暂停后不再跟，恢复后立刻补钉', () => {
    const mounted = mount()
    const { state } = mounted.harness
    const before = state.pinCalls
    act(() => {
      mounted.latest().pause()
    })
    expect(mounted.latest().paused).toBe(true)
    expect(state.pinCalls).toBe(before)
    act(() => {
      mounted.latest().resume()
    })
    expect(mounted.latest().paused).toBe(false)
    expect(state.pinCalls).toBe(before + 1)
  })

  test('卸载：解绑 reader 并断开观察器', () => {
    const mounted = mount()
    expect(observeCount).toBe(2)
    mounted.unmount()
    expect(mounted.harness.reader()).toBeNull()
    expect(disconnectCount).toBe(1)
  })
})
