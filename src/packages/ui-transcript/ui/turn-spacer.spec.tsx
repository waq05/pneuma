/**
 * 会话区视口协调器（`viewport.ts`）对底部占位的测量与写入，以及跟随策略的接线
 * （ui 层，真渲染 + 真 DOM）。
 *
 * 来源：`scripts/ui-turn-spacer-test.mjs` 第 [2][3][5] 段（缺口清单 B37）。原探针钉的是
 * `viewport.ts` / `follow.ts` 的源码文本；这里用一个真 `.chat` 容器把视口挂起来：
 * - [3] 占位被认出、`offsetHeight` 是唯一高度来源、`floor()` 的算式、`pin()` 落 floor；
 * - [5] 批次开始写 `overflow-anchor: none`、结束清成空串；
 * - 跟随策略挂载后真的把 `scrollTop` 钉到 floor（写位置只经视口）。
 *
 * 第 [2] 段的反向钉同样在这里：消息流的 `ui.tsx` 真渲染后，容器里不存在占位元素。
 *
 * 不迁的：views.css 的 `flex` / `height: 0` 与「高度由协调器写内联样式」注释是样式表文本，
 * 转 shots；真机滚动几何（`scrollHeight` / `clientHeight` 的真实数值）jsdom 没有布局，
 * 归 shots 截图探针。
 *
 * @module dsc-ui-transcript/ui/turn-spacer.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, SlotRenderApi, TranscriptEntry, UiPluginApi } from '@dsc/ui'
import { useChatViewport, type ChatViewportHandle } from './viewport.js'
import { useFollowBottom } from './follow.js'
import plugin from './ui.js'

/** 桩掉 jsdom 缺的布局观察器与帧回调。 */
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** 把视口与跟随策略挂进一棵最小 DOM：`.chat > .chat-inner + .turn-spacer`。 */
function Probe({
  dep,
  onReady,
}: {
  dep: number
  onReady(handle: ChatViewportHandle): void
}): ReactNode {
  const handle = useChatViewport()
  onReady(handle)
  const follow = useFollowBottom(dep, 'sess-1', handle.viewport)
  return (
    <div className="chat" ref={handle.attach}>
      <div className="chat-inner">内容</div>
      <div className="turn-spacer" data-chat-turn-spacer="" aria-hidden="true" ref={follow.setEnd} />
    </div>
  )
}

/** 给元素挂上假的布局读数（jsdom 没有布局）。 */
function setMetrics(element: HTMLElement, key: 'scrollHeight' | 'clientHeight' | 'offsetHeight', value: number): void {
  Object.defineProperty(element, key, { configurable: true, get: () => value })
}

describe('视口认占位、算 floor、写 scrollTop（[3]）', () => {
  test('占位元素被认出；占位高度读 offsetHeight；floor = scrollHeight − 占位 − clientHeight', () => {
    let handle!: ChatViewportHandle
    const { container } = render(<Probe dep={0} onReady={(value) => { handle = value }} />)
    const chat = container.querySelector('.chat') as HTMLElement
    const spacer = container.querySelector('.turn-spacer') as HTMLElement
    setMetrics(chat, 'scrollHeight', 1000)
    setMetrics(chat, 'clientHeight', 200)
    setMetrics(spacer, 'offsetHeight', 120)
    expect(handle.viewport.spacer).toBe(spacer)
    expect(handle.viewport.spacerHeight()).toBe(120)
    expect(handle.viewport.floor()).toBe(680)
  })

  test('pin() 落 floor；atFloor 在落定后为真', () => {
    let handle!: ChatViewportHandle
    const { container } = render(<Probe dep={0} onReady={(value) => { handle = value }} />)
    const chat = container.querySelector('.chat') as HTMLElement
    const spacer = container.querySelector('.turn-spacer') as HTMLElement
    setMetrics(chat, 'scrollHeight', 1000)
    setMetrics(chat, 'clientHeight', 200)
    setMetrics(spacer, 'offsetHeight', 120)
    expect(handle.viewport.pin()).toBe(680)
    expect(chat.scrollTop).toBe(680)
    expect(handle.viewport.atFloor()).toBe(true)
  })

  test('短会话（内容比可视区短）floor 为 0，atFloor 也是真（与长会话同一个答案）', () => {
    let handle!: ChatViewportHandle
    const { container } = render(<Probe dep={0} onReady={(value) => { handle = value }} />)
    const chat = container.querySelector('.chat') as HTMLElement
    setMetrics(chat, 'scrollHeight', 100)
    setMetrics(chat, 'clientHeight', 200)
    expect(handle.viewport.floor()).toBe(0)
    expect(handle.viewport.atFloor()).toBe(true)
  })

  test('setSpacer 写内联高度，0 清掉内联样式（口径与没有占位时一致）', () => {
    let handle!: ChatViewportHandle
    const { container } = render(<Probe dep={0} onReady={(value) => { handle = value }} />)
    const spacer = container.querySelector('.turn-spacer') as HTMLElement
    handle.viewport.setSpacer(42)
    expect(spacer.style.height).toBe('42px')
    handle.viewport.setSpacer(0)
    expect(spacer.style.height).toBe('')
  })
})

describe('跟随策略：挂载后钉到 floor（写位置只经视口）', () => {
  test('内容提交让 dep 变一次：scrollTop 被钉到 floor（占位不算内容）', () => {
    let handle!: ChatViewportHandle
    const rendered = render(<Probe dep={0} onReady={(value) => { handle = value }} />)
    const chat = rendered.container.querySelector('.chat') as HTMLElement
    const spacer = rendered.container.querySelector('.turn-spacer') as HTMLElement
    setMetrics(chat, 'scrollHeight', 1000)
    setMetrics(chat, 'clientHeight', 200)
    setMetrics(spacer, 'offsetHeight', 120)
    // 首帧（0 高度）已经钉过一次；改完读数再让 dep 变一次触发重钉。
    act(() => {
      rendered.rerender(<Probe dep={1} onReady={(value) => { handle = value }} />)
    })
    // 跟随策略自己钉的，不是本用例手动调的 pin。
    expect(handle.viewport.scrollTop()).toBe(680)
    expect(chat.scrollTop).toBe(680)
  })
})

describe('overflow-anchor 按时间开关（[5]）', () => {
  test('批次开始写 none，结束清成空串', () => {
    let handle!: ChatViewportHandle
    const { container } = render(<Probe dep={0} onReady={(value) => { handle = value }} />)
    const chat = container.querySelector('.chat') as HTMLElement
    setMetrics(chat, 'scrollHeight', 1000)
    setMetrics(chat, 'clientHeight', 200)
    const batch = handle.viewport.beginBatch({ durationMs: 1 })
    expect(batch).not.toBeNull()
    expect(chat.style.overflowAnchor).toBe('none')
    handle.viewport.endBatch()
    expect(chat.style.overflowAnchor).toBe('')
  })

  test('detach 也会把 overflow-anchor 还回去', () => {
    let handle!: ChatViewportHandle
    const { container } = render(<Probe dep={0} onReady={(value) => { handle = value }} />)
    const chat = container.querySelector('.chat') as HTMLElement
    setMetrics(chat, 'scrollHeight', 1000)
    setMetrics(chat, 'clientHeight', 200)
    handle.viewport.beginBatch({ durationMs: 1 })
    expect(chat.style.overflowAnchor).toBe('none')
    handle.viewport.detach()
    expect(chat.style.overflowAnchor).toBe('')
  })
})

/** 消息流组件不直接导出：经插件 apply 收下 `shell.main` 的登记（与 flow.spec 同一条路）。 */
function flowComponent(): (props: { renderSlot: SlotRenderApi<never>['renderSlot'] }) => ReactNode {
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
  const found = registered.find((item) => item.slot === 'shell.main')
  if (found === undefined) throw new Error('transcript 插件没有把流组件登记进 shell.main')
  return found.component as (props: { renderSlot: SlotRenderApi<never>['renderSlot'] }) => ReactNode
}

const TranscriptFlow = flowComponent()
const renderSlot = ((_slot: unknown, _owner: unknown, fallback?: ReactNode): ReactNode => (fallback ?? null)) as unknown as SlotRenderApi<never>['renderSlot']

describe('反向钉：消息流里没有占位（[2]）', () => {
  test('渲染 TranscriptFlow 后容器里不存在 data-chat-turn-spacer / .turn-spacer', async () => {
    const entries: TranscriptEntry[] = [
      { kind: 'user', id: 1, text: '问一句', ts: 1 } as TranscriptEntry,
      { kind: 'text', id: 2, text: '答一句', ts: 2 } as TranscriptEntry,
    ]
    const snapshot = {
      entries,
      liveEntries: [],
      status: { cwd: 'D:/demo', sessionPath: 'D:/demo/demo.jsonl', sessionId: 'uuid-1', turnState: 'idle' },
    } as unknown as HostSnapshot
    const channel: HostChannel = {
      getSnapshot: () => snapshot,
      getHello: () => null,
      getStatus: () => 'open',
      getHostError: () => null,
      getPluginsFrame: () => null,
      onPlugins: () => () => undefined,
      onAsk: () => () => undefined,
      subscribe: () => () => undefined,
      invoke: (<T,>(method: string): Promise<T> =>
        (method === 'getUiPrefs' ? Promise.resolve({}) : Promise.resolve({})) as Promise<T>) as HostChannel['invoke'],
      reconnect: () => undefined,
      close: () => undefined,
    }
    let container!: HTMLElement
    await act(async () => {
      const rendered = render(
        <RuntimeProvider channel={channel}>
          <TranscriptFlow renderSlot={renderSlot} />
        </RuntimeProvider>,
      )
      container = rendered.container
      await Promise.resolve()
    })
    expect(container.querySelector('[data-chat-turn-spacer]')).toBeNull()
    expect(container.querySelector('.turn-spacer')).toBeNull()
    // 消息流本身确实画出来了（不是空树导致的反向假绿）。
    expect(container.querySelector('.entry-text')).toBeTruthy()
  })
})
