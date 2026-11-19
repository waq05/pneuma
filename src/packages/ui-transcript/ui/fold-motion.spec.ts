/**
 * 整轮收起逐行动画（`fold-motion.ts`）的状态机分支（ui 层，真 DOM）。
 *
 * 这份钉的都是模块头写下的判据，而不是实现细节：
 *  - 第一次见到的元素同步提交，见过的才进动画（重挂之后新 DOM 一出现就该是收起的）；
 *  - 收起先写实测高度 → 微任务开一次批 → 高度过渡末帧提交；`row-gap` 跟着收、跟着还；
 *  - `transitionend` 只认**自己**的 `height` 那条，别的属性 / 子节点事件不提前提交；
 *  - 批次收工时**批次级**查焦点：任何一层带焦点，整批一个 `hidden` 都不挂，只放行那一层；
 *  - 展开方向随时可以打断排队 / 正在跑 / 已经收完记账的三段，都不提交 `hidden`；
 *  - 减少动态偏好、帧超时兜底、卸载清理、`prepareExpand` 的段范围、零高度当场提交。
 *
 * jsdom 恒量 0 高，所以需要真实高度的元素用 `offsetHeight` 读数替身；批次与帧时钟
 * 用替身录制调用，不依赖计时抖动。`--dsc-dur-slow` / `--dsc-ease` 不预置时按
 * `readSlowMs` / `readEase` 的兜底口径（180ms / 默认曲线）断言。
 *
 * @module dsc-ui-transcript/ui/fold-motion.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { useTurnFoldMotion, type FoldMotion } from './fold-motion.js'
import type { ChatViewport, FoldBatch } from './viewport.js'
import type { HiddenCommit } from './fold-seats.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** 一条收起提交：`commit` 与它带着的 `reveal` 分开记，方便验「整批放行时一个都不提交」。 */
function commitOf(): HiddenCommit {
  const commit = vi.fn() as unknown as HiddenCommit
  commit.reveal = vi.fn()
  return commit
}

interface ViewportStub {
  viewport: ChatViewport
  calls: Array<{ moving?: readonly Element[]; durationMs?: number }>
  batch: FoldBatch
}

/** 视口替身：只实现 fold-motion 真用到的那几样（beginBatch + scroller）。 */
function viewportStub(): ViewportStub {
  const calls: ViewportStub['calls'] = []
  const batch: FoldBatch = {
    landing: 'tail',
    active: true,
    frame: vi.fn(),
    end: vi.fn(),
  }
  const viewport = {
    scroller: null,
    beginBatch: (options?: { moving?: readonly Element[]; durationMs?: number }) => {
      calls.push(options ?? {})
      return batch
    },
  } as unknown as ChatViewport
  return { viewport, calls, batch }
}

let current: FoldMotion | null = null

function Harness({ collapsed, viewport }: { collapsed: boolean; viewport: ChatViewport }): null {
  current = useTurnFoldMotion({ collapsed, viewport })
  return null
}

/** 挂一个座位，拿回它的动画把手与视口替身。 */
function mount(collapsed = false): ViewportStub & { motion: FoldMotion; rerender: (collapsed: boolean) => void } {
  const stub = viewportStub()
  const view = render(createElement(Harness, { collapsed, viewport: stub.viewport }))
  const motion = current
  if (motion === null) throw new Error('useTurnFoldMotion 没有交出把手')
  return {
    ...stub,
    motion,
    rerender: (next: boolean) => view.rerender(createElement(Harness, { collapsed: next, viewport: stub.viewport })),
  }
}

/** 造一行：真挂进文档（焦点 / isConnected 才成立），高度用读数替身。 */
function makeRow(height = 100, parent: HTMLElement = document.body): HTMLDivElement {
  const row = document.createElement('div')
  Object.defineProperty(row, 'offsetHeight', { configurable: true, get: () => height })
  parent.appendChild(row)
  return row
}

/** 段容器：`row-gap` 收 / 还只在 `.turn-process-body` 上做。 */
function makeBody(gap = '3px'): HTMLDivElement {
  const body = document.createElement('div')
  body.className = 'turn-process-body'
  body.style.rowGap = gap
  document.body.appendChild(body)
  return body
}

/** 等微任务里的 `flush()` 跑完。 */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/** `transitionend` 在 jsdom 没有构造器，用普通 Event 补上 `propertyName`。 */
function transitionEndOn(target: Element, propertyName: string): void {
  const event = new Event('transitionend', { bubbles: true })
  Object.defineProperty(event, 'propertyName', { value: propertyName })
  target.dispatchEvent(event)
}

/** 把元素第一次交给动画（同步提交）之后，再真正收起一次。 */
function seenAndCollapse(motion: FoldMotion, row: HTMLElement, commit: HiddenCommit): void {
  motion.transition(row, true, commitOf())
  motion.transition(row, true, commit)
}

describe('fold-motion：第一次 vs 见过的元素', () => {
  test('第一次见到的元素同步提交（新 DOM 一出现就是收起的），不写任何动画内联值', () => {
    const { motion } = mount()
    const row = makeRow()
    const first = commitOf()

    motion.transition(row, true, first)

    expect(first).toHaveBeenCalledTimes(1)
    expect(row.style.height).toBe('')
    expect(row.style.transition).toBe('')
    expect(row.style.overflow).toBe('')
  })

  test('见过的元素先写实测高度并排队；排队那一段不算「在藏」', async () => {
    const { motion, calls } = mount()
    const row = makeRow(120)
    const commit = commitOf()

    seenAndCollapse(motion, row, commit)
    expect(commit).not.toHaveBeenCalled()
    expect(row.style.transition).toBe('none')
    expect(row.style.overflow).toBe('hidden')
    expect(row.style.height).toBe('120px')
    // 只是登记进 waiting，还没东西在动：守卫不能把里层的组关掉。
    expect(motion.hiddenOrCollapsing(row)).toBe(false)
    // 同一个元素重复登记只算一次。
    motion.transition(row, true, commit)
    expect(calls).toHaveLength(0)

    await flushMicrotasks()

    expect(calls).toHaveLength(1)
    expect(calls[0].durationMs).toBe(240) // 180ms 慢档 + 60ms 提交余量
    expect(calls[0].moving).toEqual([row])
    // 起始值写死之后再上过渡、归零。
    expect(row.style.height).toBe('0px')
    expect(row.style.marginTop).toBe('0px')
    expect(row.style.opacity).toBe('0')
    expect(row.style.transition).toContain('height 124ms')
    expect(row.style.transition).toContain('opacity 79ms')
    expect(motion.hiddenOrCollapsing(row)).toBe(true)
  })

  test('高度为 0 的元素没有可过渡的东西，当场提交、不进批次', async () => {
    const { motion, calls } = mount()
    const row = makeRow(0)
    const commit = commitOf()

    seenAndCollapse(motion, row, commit)
    await flushMicrotasks()

    expect(commit).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(0)
    expect(row.style.height).toBe('')
  })
})

describe('fold-motion：transitionend 的判据', () => {
  test('只认自己身上的 height：opacity / 子节点的 height 都不提前提交', async () => {
    const { motion, batch } = mount()
    const row = makeRow(80)
    const child = document.createElement('span')
    row.appendChild(child)
    const commit = commitOf()

    seenAndCollapse(motion, row, commit)
    await flushMicrotasks()

    transitionEndOn(row, 'opacity')
    transitionEndOn(child, 'height')
    expect(commit).not.toHaveBeenCalled()
    expect(batch.end).not.toHaveBeenCalled()

    transitionEndOn(row, 'height')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(batch.end).toHaveBeenCalledTimes(1)
    expect(row.style.height).toBe('')
    expect(row.style.transition).toBe('')
    expect(row.style.marginTop).toBe('')
    expect(row.style.opacity).toBe('')
    expect(row.style.overflow).toBe('')
  })

  test('行缝（段容器 row-gap）同步收，收工时还回原值；同一容器只记一次', async () => {
    const { motion, batch } = mount()
    const body = makeBody('3px')
    const first = makeRow(60, body)
    const second = makeRow(70, body)

    seenAndCollapse(motion, first, commitOf())
    seenAndCollapse(motion, second, commitOf())
    await flushMicrotasks()

    expect(body.style.rowGap).toBe('0px')
    expect(body.style.transition).toContain('row-gap 124ms')

    transitionEndOn(first, 'height')
    transitionEndOn(second, 'height')

    expect(body.style.rowGap).toBe('3px')
    expect(body.style.transition).toBe('')
    expect(batch.end).toHaveBeenCalledTimes(1)
  })
})

describe('fold-motion：批次级焦点判定', () => {
  test('任何一层带焦点：整批一个 hidden 都不挂，只调带焦点那层的 reveal', async () => {
    const { motion, batch } = mount()
    const focused = makeRow(90)
    const other = makeRow(95)
    focused.tabIndex = 0
    focused.focus()
    expect(document.activeElement).toBe(focused)
    const focusedCommit = commitOf()
    const otherCommit = commitOf()

    seenAndCollapse(motion, focused, focusedCommit)
    seenAndCollapse(motion, other, otherCommit)
    await flushMicrotasks()

    // 先收完的是不带焦点的那层：判定仍然要等整批收工，不能「谁先到谁先关」。
    transitionEndOn(other, 'height')
    expect(otherCommit).not.toHaveBeenCalled()
    expect(motion.hiddenOrCollapsing(other)).toBe(true) // 已收完、等收工也算在藏

    transitionEndOn(focused, 'height')

    expect(focusedCommit.reveal).toHaveBeenCalledTimes(1)
    expect(focusedCommit).not.toHaveBeenCalled()
    expect(otherCommit).not.toHaveBeenCalled()
    // 两层的样式都还回去，批次收口。
    expect(focused.style.height).toBe('')
    expect(other.style.height).toBe('')
    expect(batch.end).toHaveBeenCalledTimes(1)
  })
})

describe('fold-motion：展开方向打断三段', () => {
  test('打断排队中的收起：还内联值、不提交、也不再开批', async () => {
    const { motion, calls } = mount()
    const row = makeRow(100)
    const collapseCommit = commitOf()
    const expandCommit = commitOf()

    seenAndCollapse(motion, row, collapseCommit)
    motion.transition(row, false, expandCommit)

    expect(expandCommit).toHaveBeenCalledTimes(1)
    expect(collapseCommit).not.toHaveBeenCalled()
    expect(row.style.height).toBe('')
    expect(row.style.transition).toBe('')

    await flushMicrotasks()
    expect(calls).toHaveLength(0)
  })

  test('打断正在跑的一项：摘监听、还样式；它不是最后一项时批次还在跑', async () => {
    const { motion, batch } = mount()
    const first = makeRow(100)
    const second = makeRow(110)
    const firstCommit = commitOf()
    const secondCommit = commitOf()

    seenAndCollapse(motion, first, firstCommit)
    seenAndCollapse(motion, second, secondCommit)
    await flushMicrotasks()

    const expandFirst = commitOf()
    motion.transition(first, false, expandFirst)

    expect(expandFirst).toHaveBeenCalledTimes(1)
    expect(first.style.height).toBe('')
    expect(motion.hiddenOrCollapsing(first)).toBe(false)
    expect(motion.hiddenOrCollapsing(second)).toBe(true)
    expect(batch.end).not.toHaveBeenCalled()
    // 被放行的那项之后再来 height 事件不能提交。
    transitionEndOn(first, 'height')
    expect(firstCommit).not.toHaveBeenCalled()

    transitionEndOn(second, 'height')
    expect(secondCommit).toHaveBeenCalledTimes(1)
    expect(batch.end).toHaveBeenCalledTimes(1)
  })

  test('打断批次里最后一项：立刻收工（批次位置由视口自己补）', async () => {
    const { motion, batch } = mount()
    const row = makeRow(100)
    const collapseCommit = commitOf()

    seenAndCollapse(motion, row, collapseCommit)
    await flushMicrotasks()

    motion.transition(row, false, commitOf())

    expect(collapseCommit).not.toHaveBeenCalled()
    expect(batch.end).toHaveBeenCalledTimes(1)
    expect(row.style.height).toBe('')
  })

  test('已收完记账的那项被展开：从 settled 摘掉，收工时不再替它提交 hidden', async () => {
    const { motion, batch } = mount()
    const settled = makeRow(100)
    const moving = makeRow(110)
    const settledCommit = commitOf()
    const movingCommit = commitOf()

    seenAndCollapse(motion, settled, settledCommit)
    seenAndCollapse(motion, moving, movingCommit)
    await flushMicrotasks()

    transitionEndOn(settled, 'height') // 收完，只记账
    expect(motion.hiddenOrCollapsing(settled)).toBe(true)

    motion.transition(settled, false, commitOf())
    expect(motion.hiddenOrCollapsing(settled)).toBe(false)
    expect(settledCommit).not.toHaveBeenCalled()

    transitionEndOn(moving, 'height')
    expect(movingCommit).toHaveBeenCalledTimes(1)
    expect(settledCommit).not.toHaveBeenCalled()
    expect(batch.end).toHaveBeenCalledTimes(1)
  })
})

describe('fold-motion：减少动态与兜底', () => {
  test('prefers-reduced-motion：同步提交，只开一小批补位置', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }))
    const { motion, calls, batch } = mount()
    const row = makeRow(100)
    const commit = commitOf()

    seenAndCollapse(motion, row, commit)
    await flushMicrotasks()

    expect(commit).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].durationMs).toBe(60)
    expect(row.style.height).toBe('')
    expect(batch.frame).toHaveBeenCalledTimes(1)
    expect(batch.end).toHaveBeenCalledTimes(1)
  })

  test('transitionend 永远不来：超时兜底也会收工', async () => {
    const raf = vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    const timers: Array<() => void> = []
    const timerspy = vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler) => {
      if (typeof handler === 'function') timers.push(handler as () => void)
      return 9 as unknown as number
    }) as unknown as typeof window.setTimeout)
    const { motion, batch } = mount()
    const row = makeRow(100)
    const commit = commitOf()

    seenAndCollapse(motion, row, commit)
    await flushMicrotasks()

    expect(timers).toHaveLength(1)
    expect(commit).not.toHaveBeenCalled()
    timers[0]()

    expect(commit).toHaveBeenCalledTimes(1)
    expect(batch.end).toHaveBeenCalledTimes(1)
    expect(row.style.height).toBe('')
    timerspy.mockRestore()
    void raf
  })

  test('帧时钟每帧补位置，到 deadline 收工（不靠 transitionend）', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    let now = 0
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { motion, batch } = mount()
    const row = makeRow(100)
    const commit = commitOf()

    seenAndCollapse(motion, row, commit)
    await flushMicrotasks()
    expect(frames).toHaveLength(1)

    now = 10
    frames[0](now)
    expect(batch.frame).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
    expect(frames).toHaveLength(2)

    now = 1000
    frames[1](now)
    expect(batch.frame).toHaveBeenCalledTimes(2)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(batch.end).toHaveBeenCalledTimes(1)
    nowSpy.mockRestore()
  })

  test('元素已离场：收工时不再往一个不在文档里的节点上挂 hidden', async () => {
    const { motion, batch } = mount()
    const row = makeRow(100)
    const commit = commitOf()

    seenAndCollapse(motion, row, commit)
    await flushMicrotasks()
    row.remove()

    transitionEndOn(row, 'height')

    expect(commit).not.toHaveBeenCalled()
    expect(batch.end).toHaveBeenCalledTimes(1)
  })
})

describe('fold-motion：prepareExpand / clear', () => {
  test('prepareExpand 只在「已收起 + 有活着的段」时开批；已脱开的段不算', () => {
    const { motion, calls } = mount(false)
    const segment = document.createElement('div')
    document.body.appendChild(segment)

    motion.register(segment)
    motion.prepareExpand()
    expect(calls).toHaveLength(0)

    // collapsed 是渲染时刷新的选项：重渲染之后才生效。
    const view = mount(true)
    const live = document.createElement('div')
    document.body.appendChild(live)
    view.motion.register(live)
    view.motion.prepareExpand()
    expect(view.calls).toHaveLength(1)
    expect(view.calls[0].moving).toEqual([live])

    live.remove()
    view.motion.prepareExpand()
    expect(view.calls).toHaveLength(1)
    void view
  })

  test('register(null) 顺手清掉已经离场的段', () => {
    const { motion, calls } = mount(true)
    const segment = document.createElement('div')
    document.body.appendChild(segment)
    motion.register(segment)
    segment.remove()
    motion.register(null)
    motion.prepareExpand()
    expect(calls).toHaveLength(0)
  })

  test('clear() 清排队中的那一段：还样式、不提交', async () => {
    const { motion, calls } = mount()
    const row = makeRow(100)
    const commit = commitOf()

    seenAndCollapse(motion, row, commit)
    motion.clear()

    expect(commit).not.toHaveBeenCalled()
    expect(row.style.height).toBe('')
    await flushMicrotasks()
    expect(calls).toHaveLength(0)
  })

  test('clear() 收掉正在跑的那一批：提交、还样式、关批次', async () => {
    const { motion, batch } = mount()
    const row = makeRow(100)
    const commit = commitOf()

    seenAndCollapse(motion, row, commit)
    await flushMicrotasks()
    motion.clear()

    expect(commit).toHaveBeenCalledTimes(1)
    expect(batch.end).toHaveBeenCalledTimes(1)
    expect(row.style.height).toBe('')
  })

  test('座位卸载（hook 清理）同样收掉还没收工的批次', async () => {
    const stub = viewportStub()
    const view = render(createElement(Harness, { collapsed: false, viewport: stub.viewport }))
    const motion = current
    if (motion === null) throw new Error('没有把手')
    const row = makeRow(100)
    const commit = commitOf()
    seenAndCollapse(motion, row, commit)
    await flushMicrotasks()

    view.unmount()

    expect(commit).toHaveBeenCalledTimes(1)
    expect(stub.batch.end).toHaveBeenCalledTimes(1)
  })

  test('hiddenOrCollapsing：直挂 hidden、批中、已收完三种都算，无关元素不算', async () => {
    const { motion } = mount()
    const hidden = makeRow(50)
    hidden.setAttribute('hidden', 'until-found')
    expect(motion.hiddenOrCollapsing(hidden)).toBe(true)

    const row = makeRow(100)
    const other = makeRow(100)
    seenAndCollapse(motion, row, commitOf())
    seenAndCollapse(motion, other, commitOf())
    await flushMicrotasks()
    expect(motion.hiddenOrCollapsing(row)).toBe(true)

    transitionEndOn(row, 'height')
    expect(motion.hiddenOrCollapsing(row)).toBe(true)
    expect(motion.hiddenOrCollapsing(makeRow(10))).toBe(false)

    transitionEndOn(other, 'height')
    expect(motion.hiddenOrCollapsing(row)).toBe(false)
  })
})
