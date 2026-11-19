/**
 * 轨迹时间概览条（`timeline.tsx`）与轨迹页（`ui.tsx`）的边界补测。
 *
 * 既有 `trace-extra.spec.tsx` 只压了「有宽度 / 只有刻度 / 老会话无时间戳」三条静态面。
 * 这一份补交互与坏形状：零跨度、悬停计时、滚轮缩放与全览复位、拖选与单击、右键平移
 * 对 contextmenu 的压制、取景窗外的标记裁剪、换会话复位、选中区间芯片；另外几条压
 * 轨迹页的用量坏形状、计划/失败轮尾/无名工具行，以及「跟随滚动 / 一次性聚焦 / 区间聚焦」
 * 三段副作用。
 *
 * jsdom 没有 PointerEvent 与指针捕获 API：本文件按需打桩（只作用于本文件）。
 *
 * @module dsc-ui-trace/ui/timeline-extra.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps, ComponentType } from 'react'
import { RuntimeProvider, clearTraceFocus, openTrace, traceFocusStep, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, TranscriptEntry, UiPluginApi } from '@dsc/ui'
import { formatClockSeconds } from '@dsc/ui-primitives'
import { TraceTimeline } from './timeline.js'
import type { TraceMark } from './trace-format.js'
import plugin from './ui.js'

const BASE = 1_767_240_000_000

const MARKS: TraceMark[] = [
  { id: 1, kind: 'tool', name: 'read', start: 500, end: 900, durationMs: 400, ts: 500, round: 0 },
  { id: 2, kind: 'thinking', name: '思考', start: 5000, end: null, durationMs: null, ts: 5000, round: 0 },
  { id: 3, kind: 'tool', name: 'bash', start: 9500, end: 9800, durationMs: 300, ts: 9500, round: 1 },
  { id: 4, kind: 'tool', name: 'edit', start: 100, end: 300, durationMs: 200, ts: 100, round: 0 },
]

interface TimelineProps {
  marks: TraceMark[]
  boundaries: Array<{ round: number; ts: number }>
  spanStart: number | null
  spanEnd: number | null
  selected: { start: number; end: number } | null
  selectedCount: number
  resetKey: string
  onSelect: (range: { start: number; end: number } | null) => void
}

const baseProps = (onSelect: (range: { start: number; end: number } | null) => void): TimelineProps => ({
  marks: MARKS,
  boundaries: [
    { round: 0, ts: 500 },
    { round: 1, ts: 9500 },
  ],
  spanStart: 0,
  spanEnd: 10_000,
  selected: null,
  selectedCount: 0,
  resetKey: 'session-a',
  onSelect,
})

function renderTimeline(overrides: Partial<TimelineProps> = {}): ReturnType<typeof render> & {
  track: HTMLElement
  onSelect: (range: { start: number; end: number } | null) => void
  props: TimelineProps
} {
  const onSelect = overrides.onSelect ?? vi.fn()
  const props = { ...baseProps(onSelect), ...overrides, onSelect } as TimelineProps
  const view = render(<TraceTimeline {...(props as unknown as ComponentProps<typeof TraceTimeline>)} />)
  const track = view.container.querySelector('[data-trace-track]') as HTMLElement | null
  if (track !== null) {
    const rect = { left: 0, top: 0, width: 1000, height: 40, right: 1000, bottom: 40, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    track.getBoundingClientRect = () => rect
  }
  return { ...view, track: track as HTMLElement, onSelect, props }
}

const textOf = (element: Element | null | undefined): string => element?.textContent ?? ''

beforeEach(() => {
  document.body.innerHTML = ''
  clearTraceFocus()
  // jsdom 没有 PointerEvent：用 MouseEvent 顶一层（clientX / button 都从 MouseEvent 来），
  // 否则 React 的 onPointerDown 拿到的 button 是 undefined、clientX 是 0。
  class PointerEventPolyfill extends window.MouseEvent {
    readonly pointerId: number
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
    }
  }
  ;(window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill
  ;(globalThis as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill
  HTMLElement.prototype.setPointerCapture = function setPointerCapture(): void {}
  HTMLElement.prototype.releasePointerCapture = function releasePointerCapture(): void {}
  HTMLElement.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
    return true
  }
  HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void {}
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  clearTraceFocus()
  delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture
  delete (HTMLElement.prototype as { releasePointerCapture?: unknown }).releasePointerCapture
  delete (HTMLElement.prototype as { hasPointerCapture?: unknown }).hasPointerCapture
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
  delete (window as unknown as { PointerEvent?: unknown }).PointerEvent
  delete (globalThis as unknown as { PointerEvent?: unknown }).PointerEvent
  document.body.innerHTML = ''
})

describe('时间条的静态边界', () => {
  test('起止任一侧缺席都只画一句说明；跨度为 0 时轨道不可投影且交互全部哑火', () => {
    const missing = renderTimeline({ spanStart: null, spanEnd: null })
    expect(missing.container.querySelector('[data-trace-timeline="empty"]')).not.toBeNull()
    expect(textOf(missing.container.querySelector('.ttl-note'))).toContain('时间条不画')
    cleanup()

    const half = renderTimeline({ spanStart: 0, spanEnd: null })
    expect(half.container.querySelector('[data-trace-timeline="empty"]')).not.toBeNull()
    cleanup()

    const zero = renderTimeline({ spanStart: 5000, spanEnd: 5000 })
    expect(zero.track.getAttribute('data-projectable')).toBe('0')
    fireEvent.pointerDown(zero.track, { button: 0, clientX: 500, pointerId: 1 })
    fireEvent.pointerUp(zero.track, { clientX: 500, pointerId: 1 })
    fireEvent.wheel(zero.track, { deltaY: -100, clientX: 500 })
    expect(zero.onSelect).not.toHaveBeenCalled()
    expect(zero.container.querySelector('[data-trace-zoom-reset]')).toBeNull()
  })

  test('标记投影成百分比：有耗时的画宽度，没耗时的只画刻度；轮次边界各一条', () => {
    const { container } = renderTimeline()
    const bar = container.querySelector('[data-trace-mark="1"]') as HTMLElement
    expect(bar.className).toContain('ttl-bar')
    expect(bar.style.left).toBe('5%')
    expect(bar.style.width).toBe('4%')
    expect(bar.getAttribute('data-duration')).toBe('400')

    const tick = container.querySelector('[data-trace-mark="2"]') as HTMLElement
    expect(tick.className).toContain('ttl-tick')
    expect(tick.style.left).toBe('50%')
    expect(tick.style.width).toBe('')

    expect(container.querySelector('[data-trace-boundary="0"]')).not.toBeNull()
    expect(container.querySelector('[data-trace-boundary="1"]')).not.toBeNull()
    expect(textOf(container.querySelector('.ttl-range'))).toContain('10.0s')
  })
})

describe('悬停提示', () => {
  test('停满 500ms 才出提示；走开即撤；没耗时的写「未记录」而不是 0s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { container, track } = renderTimeline()
    const bar = container.querySelector('[data-trace-mark="1"]') as HTMLElement

    fireEvent.pointerEnter(bar)
    await act(async () => {
      vi.advanceTimersByTime(499)
    })
    expect(container.querySelector('[data-trace-tip]')).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    const tip = container.querySelector('[data-trace-tip]') as HTMLElement
    expect(tip).not.toBeNull()
    expect(textOf(tip)).toContain('read')
    expect(textOf(tip)).toContain('耗时 0.4s')

    fireEvent.pointerLeave(track)
    expect(container.querySelector('[data-trace-tip]')).toBeNull()

    // 没停满就走开：计时器被撤，永远不会弹。
    const tick = container.querySelector('[data-trace-mark="2"]') as HTMLElement
    fireEvent.pointerEnter(tick)
    fireEvent.pointerLeave(track)
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    expect(container.querySelector('[data-trace-tip]')).toBeNull()
  })

  test('耗时与时刻都缺时各写一句「未记录」', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const marks: TraceMark[] = [
      { id: 8, kind: 'system', name: '系统事件', start: 4000, end: null, durationMs: null, ts: null, round: 0 },
    ]
    const { container } = renderTimeline({ marks })
    const tick = container.querySelector('[data-trace-mark="8"]') as HTMLElement
    fireEvent.pointerEnter(tick)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    const tip = container.querySelector('[data-trace-tip]') as HTMLElement
    // ts 缺席时时刻退回起点（start），耗时缺席才写「耗时未记录」——不编 0 秒。
    // 时刻按本机时区格式化：写死 08:00:04 只对 UTC+8 成立，CI（UTC）会读到 00:00:04。
    // 期望值用与实现同一份格式化函数算，时区无关。
    expect(textOf(tip)).toContain(formatClockSeconds(4000) ?? '')
    expect(textOf(tip)).toContain('耗时未记录')
    expect(textOf(tip)).not.toContain('0.0s')
  })
})

describe('缩放 / 平移 / 拖选', () => {
  test('滚轮以指针为锚缩放，放大后再滚回全览；头部的全览芯片也能复位', () => {
    const { container, track } = renderTimeline()
    fireEvent.wheel(track, { deltaY: -100, clientX: 250 })
    expect(track.getAttribute('data-zoomed')).toBe('1')
    const chip = container.querySelector('[data-trace-zoom-reset]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(textOf(chip)).toContain('已缩放')

    fireEvent.wheel(track, { deltaY: 100, clientX: 250 })
    expect(track.getAttribute('data-zoomed')).toBeNull()
    expect(container.querySelector('[data-trace-zoom-reset]')).toBeNull()

    fireEvent.wheel(track, { deltaY: -100, clientX: 250 })
    expect(track.getAttribute('data-zoomed')).toBe('1')
    fireEvent.click(container.querySelector('[data-trace-zoom-reset]') as HTMLElement)
    expect(track.getAttribute('data-zoomed')).toBeNull()
  })

  test('取景窗外的标记与边界不画（左侧越界与右侧越界两条都跳过）', () => {
    const { container, track } = renderTimeline()
    fireEvent.wheel(track, { deltaY: -100, clientX: 250 })
    // 视窗约 500–8500：id4（100–300）在左外侧，id3（9500–9800）在右外侧。
    expect(container.querySelector('[data-trace-mark="4"]')).toBeNull()
    expect(container.querySelector('[data-trace-mark="3"]')).toBeNull()
    expect(container.querySelector('[data-trace-mark="1"]')).not.toBeNull()
    expect(container.querySelector('[data-trace-boundary="1"]')).toBeNull()
  })

  test('拖选上报区间；没拖够 4px 当点击清除；pointercancel 中断后不再上报', () => {
    const first = renderTimeline()
    fireEvent.pointerDown(first.track, { button: 0, clientX: 250, pointerId: 7 })
    fireEvent.pointerMove(first.track, { clientX: 750, pointerId: 7 })
    expect(first.container.querySelector('[data-trace-selection]')).not.toBeNull()
    fireEvent.pointerUp(first.track, { clientX: 750, pointerId: 7 })
    expect(first.onSelect).toHaveBeenCalledWith({ start: 2500, end: 7500 })
    cleanup()

    const click = renderTimeline()
    fireEvent.pointerDown(click.track, { button: 0, clientX: 500, pointerId: 8 })
    fireEvent.pointerUp(click.track, { clientX: 500, pointerId: 8 })
    expect(click.onSelect).toHaveBeenCalledWith(null)
    cleanup()

    const micro = renderTimeline()
    fireEvent.pointerDown(micro.track, { button: 0, clientX: 500, pointerId: 9 })
    fireEvent.pointerMove(micro.track, { clientX: 502, pointerId: 9 })
    fireEvent.pointerUp(micro.track, { clientX: 502, pointerId: 9 })
    expect(micro.onSelect).toHaveBeenCalledWith(null)
    cleanup()

    const cancelled = renderTimeline()
    fireEvent.pointerDown(cancelled.track, { button: 0, clientX: 250, pointerId: 10 })
    fireEvent.pointerMove(cancelled.track, { clientX: 750, pointerId: 10 })
    fireEvent.pointerCancel(cancelled.track, { pointerId: 10 })
    fireEvent.pointerUp(cancelled.track, { clientX: 750, pointerId: 10 })
    expect(cancelled.onSelect).not.toHaveBeenCalled()
  })

  test('右键拖动平移并吃掉紧随的 contextmenu；没拖动时右键单击清除区间', () => {
    const panned = renderTimeline()
    fireEvent.wheel(panned.track, { deltaY: -100, clientX: 250 })
    fireEvent.pointerDown(panned.track, { button: 2, clientX: 250, pointerId: 3 })
    fireEvent.pointerMove(panned.track, { clientX: 350, pointerId: 3 })
    fireEvent.pointerUp(panned.track, { clientX: 350, pointerId: 3 })
    expect(panned.track.getAttribute('data-zoomed')).toBe('1')
    fireEvent.contextMenu(panned.track)
    expect(panned.onSelect).not.toHaveBeenCalled()
    fireEvent.contextMenu(panned.track)
    expect(panned.onSelect).toHaveBeenCalledWith(null)
    cleanup()

    const clicked = renderTimeline()
    fireEvent.pointerDown(clicked.track, { button: 2, clientX: 250, pointerId: 4 })
    fireEvent.pointerUp(clicked.track, { clientX: 250, pointerId: 4 })
    fireEvent.contextMenu(clicked.track)
    expect(clicked.onSelect).toHaveBeenCalledWith(null)
  })

  test('已选区间画高亮与芯片；点芯片清除；换会话（resetKey）复位缩放', () => {
    const selected = renderTimeline({ selected: { start: 1000, end: 6000 }, selectedCount: 3 })
    const block = selected.container.querySelector('[data-trace-selection]') as HTMLElement
    expect(block.style.left).toBe('10%')
    expect(block.style.width).toBe('50%')
    const chip = selected.container.querySelector('[data-trace-selection-chip]') as HTMLElement
    expect(textOf(chip)).toContain('已选')
    expect(textOf(chip)).toContain('3 步')
    fireEvent.click(chip)
    expect(selected.onSelect).toHaveBeenCalledWith(null)
    cleanup()

    const reset = renderTimeline()
    fireEvent.wheel(reset.track, { deltaY: -100, clientX: 250 })
    expect(reset.container.querySelector('[data-trace-zoom-reset]')).not.toBeNull()
    reset.rerender(
      <TraceTimeline
        {...(reset.props as unknown as ComponentProps<typeof TraceTimeline>)}
        resetKey="session-b"
      />,
    )
    expect(reset.container.querySelector('[data-trace-zoom-reset]')).toBeNull()
  })
})

// ── 轨迹页（TraceView）的行为面 ──────────────────────────────────────────────

/** TraceView 不直接导出：照生产壳装载插件那条路收组件。 */
function traceComponent(): ComponentType<Record<string, unknown>> {
  const registered: Array<{ slot: string; component: unknown }> = []
  const fakeUi = {
    slots: {
      register: (slot: string, _options: unknown, component: unknown): void => {
        registered.push({ slot, component })
      },
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
    },
    provide: (): void => undefined,
    consume: (): undefined => undefined,
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  const found = registered[0]
  if (found === undefined) throw new Error('trace 插件没有登记组件')
  return found.component as ComponentType<Record<string, unknown>>
}

const TraceView = traceComponent()

const user = (id: number, text: string, ts = BASE): TranscriptEntry =>
  ({ kind: 'user', id, text, ts }) as TranscriptEntry

const tool = (id: number, startedAt = BASE + 100, durationMs = 100, name = 'read'): TranscriptEntry =>
  ({
    kind: 'tool',
    id,
    ts: startedAt + durationMs,
    call: { callId: `c${String(id)}`, name, argsText: '{}', resultText: 'ok', status: 'done', startedAt, durationMs },
  }) as TranscriptEntry

function snapshotOf(entries: TranscriptEntry[], extra: Record<string, unknown> = {}): HostSnapshot {
  return {
    entries,
    liveEntries: [],
    status: { cwd: 'D:/demo', sessionPath: 'D:/demo/a.jsonl', turnId: 1, turnState: 'idle' },
    ...extra,
  } as unknown as HostSnapshot
}

/** 可变快照通道：push 时通知订阅者重读。 */
function makeChannel(initial: HostSnapshot): {
  channel: HostChannel
  push: (next: HostSnapshot) => void
} {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const channel: HostChannel = {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    invoke: (() => Promise.reject(new Error('轨迹页不该 invoke'))) as unknown as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return {
    channel,
    push: (next) => {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

const renderFallbackSlot = ((_name: string, _input: unknown, options?: { fallback?: unknown }): unknown =>
  options?.fallback ?? null) as never

function renderTrace(channel: HostChannel): ReturnType<typeof render> {
  return render(
    <RuntimeProvider channel={channel}>
      <TraceView renderFactorySlot={renderFallbackSlot} />
    </RuntimeProvider>,
  )
}

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 4; index += 1) await Promise.resolve()
  })

describe('轨迹页的坏形状与后三类步骤', () => {
  test('整会话用量形状不对（缺 status / usage 不是对象 / token 不是数 / 非有限）：不打印 tok', async () => {
    const cases: unknown[] = [
      {},
      { status: 'bad' },
      { status: { usage: 'bad' } },
      { status: { usage: { inputTokens: '1', outputTokens: 2 } } },
      { status: { usage: { inputTokens: Number.NaN, outputTokens: 2 } } },
    ]
    for (const extra of cases) {
      const view = renderTrace(makeChannel(snapshotOf([user(1, '问'), tool(2)], extra as Record<string, unknown>)).channel)
      await flush()
      expect(textOf(view.container.querySelector('.trace-stats'))).not.toContain('tok')
      cleanup()
    }
  })

  test('计划卡、失败轮尾与无名工具行都各有自己的画法', async () => {
    const entries: TranscriptEntry[] = [
      user(1, '排个计划'),
      {
        kind: 'plan',
        id: 2,
        ts: BASE + 100,
        plan: { title: '重构方案', file: 'D:/p.md', text: '正文' },
      } as TranscriptEntry,
      { kind: 'turn-end', id: 3, reason: 'failed', ts: BASE + 200 } as unknown as TranscriptEntry,
      tool(4, BASE + 300, 0, ''),
    ]
    const view = renderTrace(makeChannel(snapshotOf(entries)).channel)
    await flush()
    const plan = view.container.querySelector('.trace-plan') as HTMLElement
    expect(textOf(plan)).toContain('重构方案')
    expect(textOf(plan)).toContain('D:/p.md')
    expect(view.container.textContent).toContain('过程失败')
    const fallback = view.container.querySelector('[data-fallback="trace-tool"]') as HTMLElement
    expect(fallback).not.toBeNull()
    expect(fallback.querySelector('.name')).toBeNull()
  })
})

describe('轨迹页的滚动跟随与聚焦', () => {
  test('跟随：离开底部暂停、回到 32px 内恢复；一屏装得下时始终跟随', async () => {
    const first = snapshotOf([user(1, '开始'), tool(2)])
    const pair = makeChannel(first)
    const view = renderTrace(pair.channel)
    await flush()
    const scroller = view.container.querySelector('.chat') as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 })
    scroller.scrollTop = 1000

    // 用户滚到 100：离底部 800px → 暂停跟随。
    scroller.scrollTop = 100
    fireEvent.scroll(scroller)
    await act(async () => {
      pair.push(snapshotOf([user(1, '开始'), tool(2), user(3, '再来'), tool(4)]))
    })
    expect(scroller.scrollTop).toBe(100)

    // 回到离底部 20px：恢复跟随，下一条一到就贴底。
    scroller.scrollTop = 880
    fireEvent.scroll(scroller)
    await act(async () => {
      pair.push(snapshotOf([user(1, '开始'), tool(2), user(3, '再来'), tool(4), user(5, '继续'), tool(6)]))
    })
    expect(scroller.scrollTop).toBe(1000)
    cleanup()

    // 一屏装得下（limit <= 0）：不判「离开底部」。
    const small = makeChannel(snapshotOf([user(1, '短'), tool(2)]))
    const second = renderTrace(small.channel)
    await flush()
    const shortScroller = second.container.querySelector('.chat') as HTMLElement
    Object.defineProperty(shortScroller, 'scrollHeight', { configurable: true, value: 100 })
    Object.defineProperty(shortScroller, 'clientHeight', { configurable: true, value: 100 })
    shortScroller.scrollTop = 10
    fireEvent.scroll(shortScroller)
    await act(async () => {
      small.push(snapshotOf([user(1, '短'), tool(2), user(3, '加一条'), tool(4)]))
    })
    expect(shortScroller.scrollTop).toBe(100)
  })

  test('一次性聚焦：展开所在轮并闪一下，读完即清；1.6s 后闪烁自己灭', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    openTrace(2)
    const view = renderTrace(makeChannel(snapshotOf([user(1, '看这条'), tool(2, BASE + 100, 200)])).channel)
    await flush()
    const round = view.container.querySelector('[data-trace-round="0"]') as HTMLElement
    expect(round.className).toContain('open')
    const step = view.container.querySelector('[data-trace-step="2"]') as HTMLElement
    expect(step.className).toContain('is-flash')
    expect(traceFocusStep()).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(1_600)
    })
    expect(view.container.querySelector('[data-trace-step="2"]')?.className).not.toContain('is-flash')
  })

  test('时间条拖选：命中轮展开、聚焦步骤滚进视野（scrollIntoView 被调用）', async () => {
    const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    const view = renderTrace(
      makeChannel(
        snapshotOf([user(1, '第一轮'), tool(2, BASE + 100, 100), user(3, '第二轮', BASE + 3000), tool(4, BASE + 3100, 100)]),
      ).channel,
    )
    await flush()
    const track = view.container.querySelector('[data-trace-track]') as HTMLElement
    const rect = { left: 0, top: 0, width: 1000, height: 40, right: 1000, bottom: 40, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    track.getBoundingClientRect = () => rect
    fireEvent.pointerDown(track, { button: 0, clientX: 0, pointerId: 11 })
    fireEvent.pointerMove(track, { clientX: 1000, pointerId: 11 })
    fireEvent.pointerUp(track, { clientX: 1000, pointerId: 11 })
    await flush()
    expect(view.container.querySelector('[data-trace-round="0"]')?.className).toContain('open')
    expect(scrollSpy).toHaveBeenCalled()
    scrollSpy.mockRestore()
  })
})
