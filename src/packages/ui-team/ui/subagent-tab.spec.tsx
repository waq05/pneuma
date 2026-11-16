/**
 * 右栏子智能体页签（`ui-team/ui.tsx` 的 `SubagentTabBody`）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-subagent-page-test.mjs` 第 [1]–[4] 段（缺口清单 B37）。
 * - [1] `transcriptFlow` 服务两端：transcript 插件 provide（组件 + 槽名），team 页签
 *   `useService` 读到后交给 FlowHost；服务缺席退回 PeekView；
 * - [2] 兜底仍在：加载骨架 / 空态 / 错误态三种人话，不白屏；
 * - [3] 轮询只在 working 时开、页面不可见不发请求、卸载清定时器；
 * - [4] 头部画角色 / 状态 / 轮数 / 时长；名册匹配不到时整块元信息不画。
 *
 * 不迁的：第 [5] 段产物审计（`lib/ui/plugins/<id>/client.js`）是构建产物层，归产物批；
 * 「PeekView 的错误与空态人话没被删」的源码文本钉由本文件的真渲染覆盖。
 *
 * @module dsc-ui-team/ui/subagent-tab.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { ServiceRegistry, ServicesProvider } from '@dsc/ui-core'
import { dockTabMeta } from '@dsc/ui-dockkit'
import type { TeammateView, TranscriptEntry, UiPluginApi } from '@dsc/ui'
import teamPlugin from './ui.js'
import transcriptPlugin from '../../ui-transcript/ui/ui.js'

interface FakeUi {
  ui: UiPluginApi
  provided: Map<string, unknown>
}

/** call apply 的测试替身：收下 provide 与槽位登记（生产壳装载插件走的就是这条路）。 */
function fakeUi(): FakeUi {
  const provided = new Map<string, unknown>()
  const ui = {
    slots: {
      register: (): void => undefined,
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
      seat: (): unknown => seatInstance,
    },
    provide: (name: string, value: unknown): void => {
      provided.set(name, value)
    },
    consume: (): undefined => undefined,
  } as unknown as UiPluginApi
  return { ui, provided }
}

/** 名册席位替身：`useSeat` 只读 `getSnapshot` / `subscribe`。 */
let mates: TeammateView[] = []
const seatInstance = {
  getSnapshot: (): { list: TeammateView[] } => ({ list: mates }),
  subscribe: (): (() => void) => () => undefined,
}

const headerMate = (over: Partial<TeammateView> = {}): TeammateView => ({
  name: 'reviewer-1',
  role: 'coder',
  state: 'idle',
  task: '复查改动',
  file: 'C:/sessions/mate.jsonl',
  parent: 'lead',
  depth: 1,
  rounds: 3,
  startedAt: Date.now() - 5_000,
  ...over,
})

const entriesOf = (): TranscriptEntry[] => [
  { kind: 'text', id: 1, text: '队友的第一句回答' } as TranscriptEntry,
]

interface Recorded {
  method: string
  args: unknown[]
}

/** 假宿主：`peekTranscript` 按用例给的应答走，其余一律拒绝。 */
function makeChannel(peek: () => Promise<TranscriptEntry[]>): HostChannel & { calls: Recorded[] } {
  const calls: Recorded[] = []
  return {
    calls,
    getSnapshot: () => null,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      if (method === 'peekTranscript') return peek() as Promise<T>
      return Promise.reject(new Error(`测试不触发 ${method}`))
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

/** 从报名表里取子智能体页签体（apply 里 registerDockTab 的结果）。 */
function subagentTab(): (props: { tab: { id: string; kind: string; path?: string; label?: string }; active: boolean; expanded: boolean }) => ReactNode {
  const { ui } = fakeUi()
  teamPlugin.apply(ui)
  const meta = dockTabMeta('subagent')
  if (meta === undefined) throw new Error('team 插件没有报名 subagent 页签')
  return meta.component as unknown as (props: { tab: { id: string; kind: string; path?: string; label?: string }; active: boolean; expanded: boolean }) => ReactNode
}

const SubagentTab = subagentTab()

const tabOf = (path = 'C:/sessions/mate.jsonl', label?: string): { id: string; kind: string; path?: string; label?: string } =>
  ({ id: 'tab-1', kind: 'subagent', path, label })

const mount = (
  channel: HostChannel,
  props: { tab: { id: string; kind: string; path?: string; label?: string }; active: boolean; expanded: boolean },
  services?: ServiceRegistry,
): ReturnType<typeof render> => {
  const tree = (
    <RuntimeProvider channel={channel}>
      <SubagentTab {...props} />
    </RuntimeProvider>
  )
  return render(services === undefined ? tree : <ServicesProvider services={services}>{tree}</ServicesProvider>)
}

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

beforeEach(() => {
  mates = []
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('transcriptFlow 服务的两端（[1]）', () => {
  test('transcript 插件 provide 的是一份 { Component, slot }，组件是函数', () => {
    const { ui, provided } = fakeUi()
    transcriptPlugin.apply(ui)
    const service = provided.get('transcriptFlow') as { Component?: unknown; slot?: unknown } | undefined
    expect(service).toBeTruthy()
    expect(typeof service?.Component).toBe('function')
    expect(service?.slot).toBe('shell.subagent.flow')
  })

  test('team 页签报名成 subagent 页签（组件从报名表取得到）', () => {
    expect(typeof dockTabMeta('subagent')?.component).toBe('function')
  })

  test('服务在：FlowHost 用 flow.Component 渲染同一套行；服务缺席：退回 PeekView', async () => {
    const channel = makeChannel(() => Promise.resolve(entriesOf()))
    const registry = new ServiceRegistry()
    const seen: TranscriptEntry[][] = []
    const Flow = ({ entries }: { entries: readonly TranscriptEntry[] }): ReactNode => {
      seen.push([...entries])
      return <div className="fake-flow">flow-body</div>
    }
    registry.provide('transcriptFlow', { Component: Flow }, 'test')
    const withFlow = mount(channel, { tab: tabOf(), active: true, expanded: true }, registry)
    await flush()
    expect(withFlow.container.querySelector('.fake-flow')).toBeTruthy()
    expect(seen[0]).toEqual(entriesOf())
    expect(withFlow.container.querySelector('.peek-flow')).toBeNull()

    const withoutFlow = mount(channel, { tab: tabOf(), active: true, expanded: true })
    await flush()
    expect(withoutFlow.container.querySelector('.fake-flow')).toBeNull()
    expect(withoutFlow.container.querySelector('.peek-text')?.textContent).toBe('队友的第一句回答')
  })
})

describe('兜底：加载 / 空 / 错误三种人话（[2]）', () => {
  test('加载中画骨架（aria-label），不是一行灰字', () => {
    const { container } = mount(
      makeChannel(() => new Promise<TranscriptEntry[]>(() => undefined)),
      { tab: tabOf(), active: true, expanded: true },
    )
    expect(container.querySelector('[role="status"][aria-label]')).toBeTruthy()
  })

  test('空运行记录给「它还没开始干活」；读失败给错误人话（都不白屏）', async () => {
    const empty = mount(makeChannel(() => Promise.resolve([])), { tab: tabOf(), active: true, expanded: true })
    await flush()
    expect(empty.container.querySelector('.settings-empty')?.textContent).toContain('它还没开始干活')

    const failed = mount(makeChannel(() => Promise.reject(new Error('读不到'))), {
      tab: tabOf(),
      active: true,
      expanded: true,
    })
    await flush()
    expect(failed.container.querySelector('.settings-empty')?.textContent).toContain('读不到')
  })
})

describe('轮询：只在 working 时开、页面不可见不发请求、卸载清定时器（[3]）', () => {
  const peekCalls = (channel: HostChannel & { calls: Recorded[] }): number =>
    channel.calls.filter((call) => call.method === 'peekTranscript').length

  test('working：先拉一次，2.5s 后再拉；收工（idle）不起定时器', async () => {
    vi.useFakeTimers()
    mates = [headerMate({ state: 'working' })]
    const channel = makeChannel(() => Promise.resolve(entriesOf()))
    mount(channel, { tab: tabOf(), active: true, expanded: true })
    await flush()
    const first = peekCalls(channel)
    await act(async () => {
      vi.advanceTimersByTime(2_500)
      await Promise.resolve()
    })
    expect(peekCalls(channel)).toBeGreaterThan(first)

    mates = [headerMate({ state: 'idle' })]
    const idle = makeChannel(() => Promise.resolve(entriesOf()))
    mount(idle, { tab: tabOf(), active: true, expanded: true })
    await flush()
    const idleFirst = peekCalls(idle)
    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await Promise.resolve()
    })
    expect(peekCalls(idle)).toBe(idleFirst)
  })

  test('document.hidden 时那一拍不发请求', async () => {
    vi.useFakeTimers()
    mates = [headerMate({ state: 'working' })]
    const channel = makeChannel(() => Promise.resolve(entriesOf()))
    mount(channel, { tab: tabOf(), active: true, expanded: true })
    await flush()
    const before = peekCalls(channel)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await act(async () => {
      vi.advanceTimersByTime(2_500)
      await Promise.resolve()
    })
    expect(peekCalls(channel)).toBe(before)
    hidden.mockRestore()
  })

  test('卸载后不再拉（定时器被清掉）', async () => {
    vi.useFakeTimers()
    mates = [headerMate({ state: 'working' })]
    const channel = makeChannel(() => Promise.resolve(entriesOf()))
    const rendered = mount(channel, { tab: tabOf(), active: true, expanded: true })
    await flush()
    const before = peekCalls(channel)
    rendered.unmount()
    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await Promise.resolve()
    })
    expect(peekCalls(channel)).toBe(before)
  })
})

describe('头部元信息（[4]）', () => {
  test('匹配到名册行：角色 / 状态 / 轮数 / 时长都上屏', async () => {
    mates = [headerMate({ state: 'idle' })]
    const channel = makeChannel(() => Promise.resolve(entriesOf()))
    const { container } = mount(channel, { tab: tabOf(), active: true, expanded: true })
    await flush()
    expect(container.querySelector('.sub-tab-name')?.textContent).toBe('reviewer-1')
    expect(container.querySelector('.sub-tab-role')?.textContent).toBe('coder')
    expect(container.querySelector('.sub-tab-state')?.textContent).toBe('已完成')
    expect(container.querySelector('.sub-tab-round')?.textContent).toBe('第 3 轮')
    expect(container.querySelector('.tm-time')).toBeTruthy()
    expect(container.querySelector('.sub-tab-note')?.textContent).toBe('只读运行记录')
  })

  test('匹配不到名册行：只留标题（页签 label → 文件名），不编造角色与状态', async () => {
    mates = []
    const channel = makeChannel(() => Promise.resolve(entriesOf()))
    const { container } = mount(channel, { tab: tabOf('C:/sessions/uuid-abc.jsonl'), active: true, expanded: true })
    await flush()
    expect(container.querySelector('.sub-tab-name')?.textContent).toBe('uuid-abc')
    expect(container.querySelector('.sub-tab-role')).toBeNull()
    expect(container.querySelector('.sub-tab-state')).toBeNull()
    expect(container.querySelector('.sub-tab-round')).toBeNull()
    expect(container.querySelector('.tm-time')).toBeNull()
  })
})
