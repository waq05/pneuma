/**
 * `ui-team` 界面半的补充覆盖（ui 层，真渲染）。
 *
 * 既有 `ui/subagent-tab.spec.tsx` 覆盖右栏子智能体页签；这里补它没铺到的团队页主路：
 *
 *   - `TeamEntry` 的 3 秒轮询：首次拉取写共享席位、到点再拉、卸载清定时器；
 *   - 顶栏面包屑 `shell.teammate.view`：正文区是队友会话时按 `sessionId` 找父会话标题，
 *     找不到回落「原会话」+ 当前会话路径，离开时发 null 让顶栏还原；
 *   - 子智能体页签的匹配兜底：label 优先、label 命中名册（路径不同）、未知状态原样显示、
 *     `startedAt = 0` 不画耗时。
 *
 * 夹具只起假 HostChannel 与假宿主快照，不碰真内核；每个用例清 localStorage 与 DOM。
 *
 * @module @pneuma/ui-team/ui/team-extra.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import {
  SlotRegistry,
  useSeatProps,
  type HostSnapshot,
  type SlotEntry,
  type TeammateView,
  type TranscriptEntry,
} from '@dsc/ui-core'
import type { UiPluginApi } from '@dsc/ui'
import { dockTabMeta } from '@dsc/ui-dockkit'
import teamPlugin from './ui.js'

interface Loaded {
  registry: SlotRegistry
  provided: Map<string, unknown>
  entry: SlotEntry<unknown>
}

/**
 * 照壳装载插件那条路走：先声明 shell.header.lead（壳在装插件前声明自己的位置），
 * 再把 `ui.slots` 代理到真注册表。这样登记里的 store 会真的进席位账。
 */
function loadTeam(): Loaded {
  const registry = new SlotRegistry()
  registry.declare('shell.header.lead', 'list')
  const provided = new Map<string, unknown>()
  const registerErased = registry.register.bind(registry) as (
    slot: string,
    options: Record<string, unknown>,
    component: unknown,
  ) => () => void
  const factoryErased = registry.registerFactory.bind(registry) as (
    options: Record<string, unknown>,
    component: unknown,
  ) => () => void
  const seatErased = registry.seat.bind(registry) as (handle: unknown) => unknown
  const slots = {
    get slots(): string[] {
      return registry.slots
    },
    spec: (slot: string): string | undefined => registry.spec(slot),
    declare: (slot: string, kind: 'single' | 'list' | 'keyed' | 'chain'): (() => void) =>
      registry.declare(slot, kind),
    register: registerErased,
    registerFactory: factoryErased,
    seat: seatErased,
    injectSlot: (slot: string, contribute: () => void | (() => void)): (() => void) =>
      registry.injectSlot(slot, contribute),
    entriesOf: (slot: string): readonly SlotEntry<unknown>[] => registry.entriesOf(slot),
    winners: (slot: string): readonly SlotEntry<unknown>[] => registry.winners(slot),
  }
  const ui = {
    slots,
    provide: (name: string, value: unknown): void => {
      provided.set(name, value)
    },
    consume: (): undefined => undefined,
  } as unknown as UiPluginApi
  teamPlugin.apply(ui)
  const entry = registry.winners('shell.header.lead').find((row) => row.id === 'team.entry')
  if (entry === undefined) throw new Error('team 插件没有登记 team.entry')
  return { registry, provided, entry }
}

/** 假宿主：名册 / 运行记录 / 会话清单按用例给的应答走，其余返回 undefined。 */
function makeChannel(
  options: {
    roster?: () => TeammateView[]
    peek?: () => Promise<TranscriptEntry[]>
    reject?: (method: string) => Error | undefined
    sessions?: Array<{ id: string; title?: string }>
    sessionPath?: string
  } = {},
): HostChannel & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const snapshot = {
    sessions: options.sessions ?? [],
    status: {
      cwd: 'C:/repo',
      sessionPath: options.sessionPath ?? 'C:/sessions/current.jsonl',
      turnState: 'idle',
    },
    surfaces: {},
  } as unknown as HostSnapshot
  return {
    calls,
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      const rejection = options.reject?.(method)
      if (rejection !== undefined) return Promise.reject(rejection)
      if (method === 'listTeammates') {
        return Promise.resolve((options.roster?.() ?? []) as unknown as T)
      }
      if (method === 'peekTranscript') {
        return (options.peek?.() ?? Promise.resolve([])) as Promise<T>
      }
      return Promise.resolve(undefined as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

/** 按壳的做法把登记组件接上席位面（useStore + actions）。 */
function EntryHost({ loaded, channel }: { loaded: Loaded; channel: HostChannel }): ReactNode {
  const seat = useSeatProps(loaded.registry, loaded.entry.store)
  const Entry = loaded.entry.component as ComponentType<Record<string, unknown>>
  return (
    <RuntimeProvider channel={channel}>
      <Entry {...seat} renderSlot={() => null} childSlots={[]} renderFactorySlot={() => null} />
    </RuntimeProvider>
  )
}

const mount = (loaded: Loaded, channel: HostChannel): ReturnType<typeof render> => {
  document.body.innerHTML = '<div id="mount"></div>'
  return render(<EntryHost loaded={loaded} channel={channel} />, {
    container: document.querySelector('#mount') as HTMLElement,
  })
}

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

const mate = (over: Partial<TeammateView> = {}): TeammateView => ({
  name: 'reviewer-1',
  role: 'coder',
  state: 'working',
  task: '复查改动',
  file: 'C:/sessions/mate.jsonl',
  parent: 'lead',
  depth: 1,
  rounds: 3,
  startedAt: Date.now() - 5_000,
  ...over,
})

const entries = (): TranscriptEntry[] => [
  { kind: 'text', id: 1, text: '队友的第一句回答' } as TranscriptEntry,
]

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (): MediaQueryList =>
        ({
          matches: false,
          media: '',
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    })
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
  document.body.innerHTML = ''
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

describe('TeamEntry 的轮询与名册席位', () => {
  test('首次拉取写席位、3 秒再拉；卸载后不再发请求', async () => {
    vi.useFakeTimers()
    let roster = [mate({ name: 'reviewer-1' })]
    const channel = makeChannel({ roster: () => roster })
    const loaded = loadTeam()
    const rendered = mount(loaded, channel)
    await flush()

    const listCalls = (): number =>
      channel.calls.filter((call) => call.method === 'listTeammates').length
    expect(listCalls()).toBe(1)
    expect(channel.calls[0]?.args).toEqual([])
    const instance = loaded.registry.seat(loaded.entry.store!)
    expect(instance?.getSnapshot()).toEqual({ list: roster })

    roster = [mate({ name: 'reviewer-2' })]
    await act(async () => {
      vi.advanceTimersByTime(3_000)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(listCalls()).toBe(2)
    expect(instance?.getSnapshot()).toEqual({ list: roster })

    rendered.unmount()
    await act(async () => {
      vi.advanceTimersByTime(9_000)
      await Promise.resolve()
    })
    expect(listCalls()).toBe(2)
  })
})

describe('顶栏面包屑（正文区是队友会话时）', () => {
  /** 收一条 `shell.teammate.view`，返回清掉监听的函数。 */
  const watchCrumb = (): { details: Array<unknown>; off: () => void } => {
    const details: Array<unknown> = []
    const onView = (event: Event): void => {
      details.push((event as CustomEvent<unknown>).detail)
    }
    window.addEventListener('shell.teammate.view', onView)
    return { details, off: () => window.removeEventListener('shell.teammate.view', onView) }
  }

  test('当前会话是队友那条：递「父会话 / 队友名」；卸载时发 null 还原标题', async () => {
    const channel = makeChannel({
      roster: () => [mate({ sessionId: 'parent' })],
      sessions: [{ id: 'C:/sessions/parent.jsonl', title: '父会话' }],
      sessionPath: 'C:/sessions/mate.jsonl',
    })
    const loaded = loadTeam()
    const crumb = watchCrumb()
    const rendered = mount(loaded, channel)
    await flush()

    expect(crumb.details).toContainEqual({
      name: 'reviewer-1',
      parentTitle: '父会话',
      parentPath: 'C:/sessions/parent.jsonl',
    })

    rendered.unmount()
    expect(crumb.details.at(-1)).toBeNull()
    crumb.off()
  })

  test('找不到出生会话：标题回落「原会话」，路径给当前会话（点了是 no-op，不跳错地方）', async () => {
    const channel = makeChannel({
      roster: () => [mate({ sessionId: 'missing' })],
      sessions: [],
      sessionPath: 'C:/sessions/mate.jsonl',
    })
    const loaded = loadTeam()
    const crumb = watchCrumb()
    mount(loaded, channel)
    await flush()

    expect(crumb.details).toContainEqual({
      name: 'reviewer-1',
      parentTitle: '原会话',
      parentPath: 'C:/sessions/mate.jsonl',
    })
    crumb.off()
  })

  test('正文区不是队友会话：什么都不递', async () => {
    const channel = makeChannel({
      roster: () => [mate()],
      sessionPath: 'C:/sessions/other.jsonl',
    })
    const loaded = loadTeam()
    const crumb = watchCrumb()
    mount(loaded, channel)
    await flush()

    expect(crumb.details).toHaveLength(0)
    crumb.off()
  })
})

describe('SubagentTab 的匹配兜底', () => {
  const Tab = (): ComponentType<Record<string, unknown>> => {
    const meta = dockTabMeta('subagent')
    if (meta === undefined) throw new Error('team 插件没有报名 subagent 页签')
    return meta.component as unknown as ComponentType<Record<string, unknown>>
  }

  const mountTab = (
    channel: HostChannel,
    tab: { id: string; kind: string; path?: string; label?: string },
  ): ReturnType<typeof render> => {
    const Body = Tab()
    return render(
      <RuntimeProvider channel={channel}>
        <Body tab={tab} active expanded />
      </RuntimeProvider>,
    )
  }

  test('给 label 时标题优先用 label（即使名册里有 name）', async () => {
    const loaded = loadTeam()
    const instance = loaded.registry.seat(loaded.entry.store!)
    act(() => {
      instance?.actions.setList([mate({ state: 'idle' })])
    })
    const channel = makeChannel({ peek: () => Promise.resolve(entries()) })
    const { container } = mountTab(channel, {
      id: 'tab-1',
      kind: 'subagent',
      path: 'C:/sessions/mate.jsonl',
      label: 'alias-name',
    })
    await flush()
    expect(container.querySelector('.sub-tab-name')?.textContent).toBe('alias-name')
    expect(container.querySelector('.sub-tab-role')?.textContent).toBe('coder')
  })

  test('label 能命中名册（路径不同）；未知状态原样显示；startedAt=0 不画耗时', async () => {
    const loaded = loadTeam()
    const instance = loaded.registry.seat(loaded.entry.store!)
    act(() => {
      instance?.actions.setList([
        mate({ name: 'alias-name', state: 'paused' as unknown as TeammateView['state'], startedAt: 0 }),
      ])
    })
    const channel = makeChannel({ peek: () => Promise.resolve(entries()) })
    const { container } = mountTab(channel, {
      id: 'tab-2',
      kind: 'subagent',
      path: 'D:/other/session.jsonl',
      label: 'alias-name',
    })
    await flush()
    const head = container.querySelector('.sub-tab-head') as HTMLElement
    expect(head.getAttribute('data-subagent-state')).toBe('paused')
    expect(container.querySelector('.sub-tab-role')?.textContent).toBe('coder')
    expect(container.querySelector('.sub-tab-state')?.textContent).toBe('paused')
    expect(container.querySelector('.tm-time')?.textContent).toBe('')
  })
})
