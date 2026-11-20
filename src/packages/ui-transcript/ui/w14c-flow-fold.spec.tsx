/**
 * 会话流主干剩余出口的补测（W14 重 harness 面）：折叠 / 阶段组 / 刻度条 / 跟随策略。
 *
 * 覆盖目标（对照 W14 缺口清单）：
 *  - `render.tsx`：焦点保护放行整轮（190/201/204）、阶段组头点击（298）、组座位的回调装配
 *    （350-361）；
 *  - `ui.tsx`：刻度条点「还没画出来的轮」时走 `revealRound → release`（586）；
 *  - `follow.ts`：藏起来再露出来且已暂停时排落定（202）、手势之内重开跟随又被位置变化打断（235）。
 *
 * 流那两条必须把整棵树渲进真的 `.chat` / `.chat-wrap` 里：折叠动画与刻度条都靠
 * `endRef.closest('.chat')` 找滚动容器，jsdom 没有布局就按既有 spec 的口径补几何替身。
 * 跟随那两条用 `w12-follow.spec` 的可控视口替身，直接挂 hook。
 *
 * @module dsc-ui-transcript/ui/w14c-flow-fold.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, SlotRenderApi, TranscriptEntry, UiPluginApi } from '@dsc/ui'
import { clearFoldPrefix, readFold } from './fold-state.js'
import { useFollowBottom } from './follow.js'
import type { ChatViewport, ViewportReader } from './viewport.js'
import { TRANSCRIPT_NODE_SLOT, type TranscriptChildSlot } from './shared.js'
import plugin from './ui.js'

// ── 插件装载：收下 shell.main 的流组件（与 w14-flow-edges 同一手法） ───────────

interface FlowProps {
  renderSlot: SlotRenderApi<TranscriptChildSlot>['renderSlot']
}

function applyPlugin(): unknown {
  let component: unknown
  const fakeUi = {
    slots: {
      register(slot: string, _options: unknown, registered: unknown): void {
        if (slot === 'shell.main') component = registered
      },
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
    },
    provide: (): void => undefined,
    consume: (): undefined => undefined,
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  if (component === undefined) throw new Error('transcript 插件没有把流组件注册进 shell.main')
  return component
}

const TranscriptFlow = applyPlugin() as ComponentType<FlowProps>

const renderSlot = ((_slot: TranscriptChildSlot, _owner: unknown, fallback?: ReactNode): ReactNode =>
  fallback) as unknown as SlotRenderApi<TranscriptChildSlot>['renderSlot']

interface Call {
  method: string
  args: readonly unknown[]
}

interface ChannelHarness extends HostChannel {
  calls: Call[]
  set(next: HostSnapshot): void
}

/** 假宿主通道：快照可替换，invoke 只认挂载期会用到的那几个方法。 */
function makeChannel(initial: HostSnapshot): ChannelHarness {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const calls: Call[] = []
  const invoke = ((method: string, args: readonly unknown[] = []): Promise<unknown> => {
    calls.push({ method, args })
    if (method === 'getUiPrefs') return Promise.resolve({})
    if (method === 'submit' || method === 'refreshSessions' || method === 'openSession') return Promise.resolve(null)
    return Promise.reject(new Error(`测试不触发 ${method}`))
  }) as unknown as HostChannel['invoke']
  return {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    invoke,
    reconnect: () => undefined,
    close: () => undefined,
    calls,
    set(next: HostSnapshot) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

let seq = 0
const userOf = (text: string): TranscriptEntry => ({ kind: 'user', id: (seq += 1), text, ts: seq }) as TranscriptEntry
const textOf = (text: string): TranscriptEntry => ({ kind: 'text', id: (seq += 1), text, ts: seq }) as TranscriptEntry
const thinkOf = (text: string): TranscriptEntry => ({ kind: 'thinking', id: (seq += 1), text, ts: seq }) as TranscriptEntry
const toolOf = (name: string): TranscriptEntry =>
  ({ kind: 'tool', id: (seq += 1), call: { callId: `c${String(seq)}`, name, argsText: '{}', status: 'done' } }) as TranscriptEntry

const roundOf = (question: string, answer: string): TranscriptEntry[] => [userOf(question), textOf(answer)]

function snapshotOf(entries: TranscriptEntry[], sessionPath: string | null = 'D:/demo/demo-session.jsonl'): HostSnapshot {
  return {
    entries,
    liveEntries: [],
    status: {
      cwd: 'D:/demo',
      ...(sessionPath === null ? {} : { sessionPath }),
      sessionId: 'uuid-1',
      turnState: 'idle',
    },
  } as unknown as HostSnapshot
}

async function flush(times = 4): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) await Promise.resolve()
  })
}

/** 造一个 `.chat-wrap > .chat` 的滚动容器，返回 chat（渲进它）。 */
function makeChat(): { wrap: HTMLElement; chat: HTMLElement } {
  const wrap = document.createElement('div')
  wrap.className = 'chat-wrap'
  const chat = document.createElement('div')
  chat.className = 'chat'
  wrap.appendChild(chat)
  document.body.appendChild(wrap)
  return { wrap, chat }
}

beforeEach(() => {
  // 刻度条每帧用 `document.elementFromPoint` 判「当前轮」；jsdom 没有，给个恒 null 的替身。
  ;(document as unknown as { elementFromPoint?: unknown }).elementFromPoint = () => null
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  clearFoldPrefix(['uuid-1:turn:', 'uuid-1:step:'])
})

// ── render.tsx：整轮放行 / 阶段组 ─────────────────────────────────────────────

describe('折叠的整轮与阶段组', () => {
  test('焦点保护放行收起的一轮；组头能点开（190/201/204/298/350-361）', async () => {
    const { chat } = makeChat()
    // 一轮完整过程：思考 + 两次工具调用（成组）+ 正文收尾。
    const entries = [userOf('把两个文件读一下'), thinkOf('先看看结构'), toolOf('read'), toolOf('grep'), textOf('读完了')]
    const view = render(
      <RuntimeProvider channel={makeChannel(snapshotOf(entries))}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
      { container: chat },
    )
    await flush()
    // 默认档（completion）下收尾轮收起：整轮藏的是阶段组座位（行本身不挂 hidden），
    // 由折叠动画在下一帧才提交，等它落地。
    await waitFor(() => expect(view.container.querySelector('.step-seat[hidden]')).not.toBeNull(), { timeout: 3000 })
    const hidden = view.container.querySelector('.step-seat[hidden]') as HTMLElement
    // 浏览器查找命中：座位把整轮放行。
    act(() => hidden.dispatchEvent(new Event('beforematch')))
    await flush()
    expect(view.container.querySelector('[data-turn-rescue="1"]')).not.toBeNull()
    expect(readFold('uuid-1:turn:0', false)).toBe(false)
    // 阶段组：组头存在，点一下写存档并翻面（298）。
    const groupHead = view.container.querySelector('.step-fold') as HTMLElement | null
    expect(groupHead, '连续过程条目应当收成阶段组').not.toBeNull()
    const before = groupHead?.getAttribute('aria-expanded')
    fireEvent.click(groupHead as HTMLElement)
    await flush()
    expect(groupHead?.getAttribute('aria-expanded')).not.toBe(before)
    // 组体存在证明 StepGroupSeat 带着组员渲染过（350-361 的回调装配）。
    expect(view.container.querySelector('.step-body')).not.toBeNull()
  })
})

// ── ui.tsx：刻度条点还没画出来的轮 ──────────────────────────────────────────

describe('刻度条放页', () => {
  test('点更早的刻度：走 revealRound → release，把那一页放出来（586）', async () => {
    // 刻度条的宽窄判定与量测都靠几何替身；host 由 `scroller.closest('.chat-wrap')` 找到。
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
      return (this.hidden ? [] : [{ width: 200, height: 20 }]) as unknown as DOMRectList
    })
    const { chat } = makeChat()
    ;(document as unknown as { elementFromPoint?: unknown }).elementFromPoint = () => chat
    const entries = Array.from({ length: 30 }, (_, round) => roundOf(`第 ${String(round)} 问`, `第 ${String(round)} 答`)).flat()
    const view = render(
      <RuntimeProvider channel={makeChannel(snapshotOf(entries))}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
      { container: chat },
    )
    await flush()
    const seats = (): number => view.container.querySelectorAll('[data-round-seat]').length
    const before = seats()
    const early = document.querySelector('.jump-tick.is-unloaded') as HTMLElement | null
    expect(early, '长会话的刻度条应当有还没画出来的轮').not.toBeNull()
    fireEvent.click(early as HTMLElement)
    await flush()
    expect(seats()).toBeGreaterThan(before)
  })
})

// ── follow.ts：藏起来再露出来 / 手势窗口内的位置变化 ─────────────────────────

interface FollowState {
  scrollTop: number
  scrollHeight: number
  hidden: boolean
  motion: boolean
  pinCalls: number
  cancelMotion: number
}

interface FollowHandle {
  paused: boolean
  end: HTMLDivElement | null
  pause(): void
  resume(): void
}

/** 可控视口替身（只实现 follow.ts 会调的成员，与 w12-follow.spec 同形）。 */
function makeFollowHarness(): {
  scroller: HTMLDivElement
  viewport: ChatViewport
  state: FollowState
  reader(): ViewportReader | null
} {
  const scroller = document.createElement('div')
  const column = document.createElement('div')
  document.body.appendChild(scroller)
  document.body.appendChild(column)
  const state: FollowState = { scrollTop: 0, scrollHeight: 1000, hidden: false, motion: false, pinCalls: 0, cancelMotion: 0 }
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

function Probe(props: { viewport: ChatViewport; onFollow(follow: FollowHandle): void }): ReactNode {
  const follow = useFollowBottom(0, 'sess-1', props.viewport)
  props.onFollow(follow)
  return null
}

function mountFollow(): { harness: ReturnType<typeof makeFollowHarness>; latest(): FollowHandle } {
  const harness = makeFollowHarness()
  let current: FollowHandle = { paused: false, end: null, pause: () => undefined, resume: () => undefined }
  render(<Probe viewport={harness.viewport} onFollow={(follow) => (current = follow)} />)
  return { harness, latest: () => current }
}

const fireScroll = (scroller: HTMLElement): void => {
  act(() => {
    scroller.dispatchEvent(new Event('scroll'))
  })
}

describe('跟随策略的两条漏网分支', () => {
  test('藏起来再露出来、已被读者暂停：重新可见的第一条只排落定（202）', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000)
    const mounted = mountFollow()
    const { scroller, state } = mounted.harness
    state.hidden = true
    fireScroll(scroller)
    state.hidden = false
    act(() => mounted.latest().pause())
    state.scrollTop = 120
    fireScroll(scroller)
    // 已暂停时「重新露出来」不补钉，只等落定；胶囊仍亮着。
    expect(mounted.latest().paused).toBe(true)
    expect(state.pinCalls).toBe(0)
  })

  test('手势窗口内又开了跟随、位置却变了：认作读者，松手亮胶囊（235）', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000)
    const mounted = mountFollow()
    const { scroller, state } = mounted.harness
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
    })
    // 用户点「回到底部」：跟随重新打开（不等落定）。
    act(() => mounted.latest().resume())
    expect(mounted.latest().paused).toBe(false)
    state.scrollTop = 100
    fireScroll(scroller)
    // 手势还新鲜 + 位置真的离开底部 → 松手，胶囊亮。
    expect(mounted.latest().paused).toBe(true)
  })
})

// `waitFor` 只在刻度条用例里等异步渲染；保留引用避免 lint 误判未使用。
void waitFor
