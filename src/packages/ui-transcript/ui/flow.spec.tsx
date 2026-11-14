/**
 * 会话流主组件（`ui.tsx` 的 TranscriptFlow）的渲染段（ui 层，真渲染）——分页与设置下发链。
 *
 * 来源（缺口清单 B34）：
 * - `scripts/ui-paging-test.mjs` 第 [7]：「到顶不画『加载更早』」「按钮读数 = 这一页实际
 *   放出的轮数」「可见窗口按整轮过滤」「刻度条与按钮走同一个放页入口」。原探针钉的是
 *   ui.tsx 的文本；这里把整棵流真渲染出来，用假宿主快照喂 60 轮，逐条验行为。
 * - `scripts/ui-fold-prefs-test.mjs` 第 [6] 的下发链：设置变化经 `shell.uiprefs` 事件
 *   同步进壳（getUiPrefs → setPrefs）——原探针钉 `addEventListener('shell.uiprefs', read)`
 *   那行文本；这里在真组件上派发事件，看折叠偏好真的换了。
 *
 * 为什么这份能存在：TranscriptFlow 的宿主接缝全在 `useHostSelector` / `useHostChannel`
 * 后面（RuntimeProvider + 假 HostChannel 就能喂），壳自身的视口协调器对 jsdom 缺的
 * 浏览器 API 有 `typeof` 防御（见 viewport.ts 的挂载段），不需要为测试改产品代码。
 *
 * @module dsc-ui-transcript/ui/flow.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, SlotRenderApi, TranscriptEntry, UiPluginApi } from '@dsc/ui'
import { type TranscriptChildSlot } from './shared.js'
import plugin from './ui.js'

/**
 * TranscriptFlow 不直接导出（对外面是 `defineUiPlugin` 的定义对象）：经 `apply` 把它
 * 注册进槽位的动作在测试替身上重放一遍，收下它注册的那个组件——这正是生产壳装载
 * 插件时走的那条路。
 */
function flowComponent(): (props: { renderSlot: SlotRenderApi<TranscriptChildSlot>['renderSlot'] }) => ReactNode {
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
  if (found === undefined) throw new Error('transcript 插件没有把流组件注册进 shell.main')
  return found.component as (props: { renderSlot: SlotRenderApi<TranscriptChildSlot>['renderSlot'] }) => ReactNode
}

const TranscriptFlow = flowComponent()

/** 假宿主通道：快照在测试里换、invoke 只答 getUiPrefs（其余方法名落空）。 */
function makeChannel(initial: HostSnapshot | null): HostChannel & { set(snapshot: HostSnapshot | null): void } {
  let snapshot = initial
  const listeners = new Set<() => void>()
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
    // .tsx 里不能写 `<T>` 泛型箭头（会被当 JSX）；宽签名 + 整体断言。
    invoke: ((method: string) =>
      method === 'getUiPrefs' ? Promise.resolve({}) : Promise.reject(new Error(`测试不触发 ${method}`))) as unknown as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
    set(next: HostSnapshot | null) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * 全体弃权的槽渲染：chain 槽没人认领时兜底画出内置行体（生产里 `renderSlot` 由壳的
 * 槽位系统注入；这条测试不装任何插件，内置行就是全部）。
 */
const renderSlot = ((slot: TranscriptChildSlot, owner: unknown, fallback?: ReactNode): ReactNode => (fallback ?? null)) as unknown as SlotRenderApi<TranscriptChildSlot>['renderSlot']

const snapshotOf = (entries: TranscriptEntry[]): HostSnapshot =>
  ({
    entries,
    liveEntries: [],
    status: { cwd: 'D:/demo', sessionPath: 'D:/demo/demo-session.jsonl', sessionId: 'uuid-1', turnState: 'idle' },
  }) as unknown as HostSnapshot

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

let seq = 0
/** 造一轮（题面 + 一句回答）。 */
const roundOf = (round: number, body: string, think = false): TranscriptEntry[] => [
  { kind: 'user', id: (seq += 1), text: `第 ${String(round)} 问：${body}`, ts: round * 10 } as TranscriptEntry,
  ...(think ? [{ kind: 'thinking', id: (seq += 1), text: `${body} 的思考。` } as TranscriptEntry] : []),
  { kind: 'text', id: (seq += 1), text: `${body} 的回答。`, ts: round * 10 + 1 } as TranscriptEntry,
]

const renderFlow = (entries: TranscriptEntry[]): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={makeChannel(snapshotOf(entries))}>
      <TranscriptFlow renderSlot={renderSlot} />
    </RuntimeProvider>,
  )

describe('分页：默认只画尾页（ui-paging [7] 行为化）', () => {
  test('60 轮的长会话：默认只画尾部一页，「加载更早」的读数是这一页放出的轮数', () => {
    const entries = Array.from({ length: 60 }, (_, round) => roundOf(round, `话题${String(round)}`)).flat()
    const { container } = renderFlow(entries)
    const seats = container.querySelectorAll('[data-round-seat]')
    expect(seats.length).toBeGreaterThan(0)
    expect(seats.length).toBeLessThan(60)
    const earlier = container.querySelector('.chat-earlier') as HTMLElement | null
    if (earlier === null) throw new Error('长会话必须画「加载更早」按钮')
    // data-earlier-rounds = 第一次点会放出来的轮数（与按钮文案同源）。
    const shown = Number.parseInt(earlier.getAttribute('data-earlier-rounds') ?? '', 10)
    expect(Number.isFinite(shown)).toBe(true)
    expect(shown).toBeGreaterThan(0)
    expect(earlier.textContent).toContain(String(shown))
    // 可见窗口按整轮过滤：画出来的座位序号全部 ≥ firstVisible，不拆半轮。
    const numbers = [...seats].map((seat) => Number.parseInt(seat.getAttribute('data-round-seat') ?? '', 10))
    expect(numbers.every((value, at) => value === numbers[0] + at)).toBe(true)
  })

  test('点「加载更早」把更早的轮放出来；一路点到头按钮消失（到顶不画）', () => {
    const entries = Array.from({ length: 60 }, (_, round) => roundOf(round, `话题${String(round)}`)).flat()
    const { container } = renderFlow(entries)
    const countSeats = (): number => container.querySelectorAll('[data-round-seat]').length
    const before = countSeats()
    const earlier = () => container.querySelector('.chat-earlier') as HTMLElement | null
    expect(earlier()).toBeTruthy()
    // 连点到头：每一下都放出**整轮**，最后到顶按钮消失。
    for (let click = 0; click < 60; click += 1) {
      const button = earlier()
      if (button === null) break
      fireEvent.click(button)
    }
    expect(earlier()).toBeNull()
    expect(countSeats()).toBe(60)
    expect(countSeats()).toBeGreaterThan(before)
  })

  test('短会话（不足一页）：没有「加载更早」这一行', () => {
    const entries = roundOf(0, '只有一问').concat(roundOf(1, '再问一句'))
    const { container } = renderFlow(entries)
    expect(container.querySelector('.chat-earlier')).toBeNull()
    expect(container.querySelectorAll('[data-round-seat]').length).toBe(2)
  })
})

describe('设置下发链：shell.uiprefs 事件同步进壳（ui-fold-prefs [6] 行为化）', () => {
  test('事件一到、壳重读 getUiPrefs：定稿思考行的默认展开跟着设置翻', async () => {
    const entries = roundOf(0, '看设置的思考', true)
    // getUiPrefs 这次答「默认展开思考行」。
    let prefsAnswer: Record<string, unknown> = { reasoningDefaultOpen: true }
    const channel = makeChannel(snapshotOf(entries))
    channel.invoke = ((method: string) =>
      method === 'getUiPrefs' ? Promise.resolve(prefsAnswer) : Promise.reject(new Error(`测试不触发 ${method}`))) as unknown as HostChannel['invoke']
    const { container } = render(
      <RuntimeProvider channel={channel}>
        <TranscriptFlow renderSlot={renderSlot} />
      </RuntimeProvider>,
    )
    // 等挂载那次 getUiPrefs 落地（promise 微任务）。
    await act(async () => {
      await Promise.resolve()
    })
    const thinkHead = container.querySelector('.think-head') as HTMLElement
    expect(thinkHead.getAttribute('aria-expanded')).toBe('true')
    // 设置页把开关关掉：壳派发 shell.uiprefs，老行跟着收。
    prefsAnswer = { reasoningDefaultOpen: false }
    await act(async () => {
      window.dispatchEvent(new Event('shell.uiprefs'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect((container.querySelector('.think-head') as HTMLElement).getAttribute('aria-expanded')).toBe('false')
  })
})
