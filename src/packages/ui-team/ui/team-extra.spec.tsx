/**
 * `ui-team` 界面半的补充覆盖（ui 层，真渲染）。
 *
 * 既有 `ui/subagent-tab.spec.tsx` 覆盖右栏子智能体页签；这里补它没铺到的团队页主路：
 *
 *   - `TeamEntry` 的 3 秒轮询：首次拉取写共享席位、到点再拉、卸载清定时器；
 *   - 名册状态回写：打开中的只读运行记录跟着席位从 working 翻成 idle；
 *   - `TeammateReader` 的 portal 落点与头部元信息、返回按钮关闭；
 *   - 面包屑事件 `shell.teammate.view`：按 `sessionId` 找父会话标题，找不到回落「原会话」，
 *     关闭时发 null 让顶栏还原；
 *   - 三个动作回传：停止 / 移除（先确认再发，取消不发）/ 发话（空值禁发、按钮与回车两条路）；
 *   - 一次性队友：头部换成一次性说明、不给发话入口；
 *   - Esc 与跨包 `shell.teammate.exit` 两条关闭通道；
 *   - 子智能体页签的匹配兜底：label 优先、label 命中名册（路径不同）、未知状态原样显示、
 *     `startedAt = 0` 不画耗时。
 *
 * 夹具只起假 HostChannel 与假宿主快照，不碰真内核；每个用例清 localStorage 与 DOM。
 *
 * @module @pneuma/ui-team/ui/team-extra.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import {
  SlotRegistry,
  useSeatProps,
  type HostSnapshot,
  type SlotEntry,
  type TeammateView,
  type TranscriptEntry,
  type UiPluginApi,
} from '@dsc/ui-core'
import { dockTabMeta } from '@dsc/ui-dockkit'
import teamPlugin from './ui.js'

/** `apply` 收下的那份服务（正文区只读层从这里开 / 关）。 */
interface TeammateReaderApi {
  open(mate: TeammateView): void
  close(): void
}

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

/** 假宿主：名册 / 运行记录按用例给的应答走，其余返回 undefined。 */
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

/** 正文区锚点 + 挂载点（reader 是 portal 出去的，壳里那格必须先存在）。 */
function shellDom(): HTMLElement {
  document.body.innerHTML =
    '<div class="thread-main" data-thread-area><div id="mount"></div></div>'
  return document.querySelector('#mount') as HTMLElement
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

const mount = (
  loaded: Loaded,
  channel: HostChannel,
): ReturnType<typeof render> =>
  render(<EntryHost loaded={loaded} channel={channel} />, { container: shellDom() })

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

const readerOf = (loaded: Loaded): TeammateReaderApi =>
  loaded.provided.get('teammateReader') as TeammateReaderApi

const openReader = async (loaded: Loaded, mate: TeammateView): Promise<void> => {
  act(() => {
    readerOf(loaded).open(mate)
  })
  await flush()
}

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

const buttonByText = (root: ParentNode, text: string): HTMLButtonElement => {
  const found = [...root.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text,
  )
  if (found === undefined) throw new Error(`找不到按钮「${text}」`)
  return found as HTMLButtonElement
}

const toastText = (): string =>
  [...document.querySelectorAll('.dsc-toast .dsc-toast__text')]
    .map((node) => node.textContent ?? '')
    .join(' | ')

let openApi: TeammateReaderApi | null = null

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
          addListener: () => undefined,
          removeListener: () => undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    })
  }
})

afterEach(() => {
  openApi?.close()
  openApi = null
  cleanup()
  vi.useRealTimers()
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
    openApi = readerOf(loaded)
    const rendered = mount(loaded, channel)
    await flush()

    const listCalls = (): number =>
      channel.calls.filter((call) => call.method === 'listTeammates').length
    expect(listCalls()).toBe(1)
    expect(channel.calls[0]?.args).toEqual([])
    const instance = loaded.registry.seat(loaded.entry.store)
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

  test('打开中的运行记录跟着名册席位翻状态（working → idle）', async () => {
    const channel = makeChannel({ roster: () => [mate({ state: 'working' })], peek: () => Promise.resolve(entries()) })
    const loaded = loadTeam()
    openApi = readerOf(loaded)
    mount(loaded, channel)
    await flush()

    await openReader(loaded, mate({ state: 'working' }))
    expect(document.querySelector('.team-reader .sub-tab-state')?.textContent).toBe('运行中')

    const instance = loaded.registry.seat(loaded.entry.store)
    act(() => {
      instance?.actions.setList([mate({ state: 'idle', finishedAt: Date.now() })])
    })
    await flush()
    const state = document.querySelector('.team-reader .sub-tab-state')
    expect(state?.textContent).toBe('已完成')
    expect(state?.className).toContain('idle')
  })
})

describe('TeammateReader：portal、头部与关闭', () => {
  test('portal 落到 [data-thread-area]，头部画名字/角色/状态/说明，正文走 PeekView', async () => {
    const channel = makeChannel({ roster: () => [mate()], peek: () => Promise.resolve(entries()) })
    const loaded = loadTeam()
    openApi = readerOf(loaded)
    mount(loaded, channel)
    await flush()

    await openReader(loaded, mate())
    const reader = document.querySelector('[data-thread-area] .team-reader')
    expect(reader).not.toBeNull()
    expect(reader?.getAttribute('aria-label')).toBe('队友 reviewer-1 的运行记录（只读）')
    expect(reader?.querySelector('.team-reader-name')?.textContent).toBe('reviewer-1')
    expect(reader?.querySelector('.team-reader-role')?.textContent).toBe('coder')
    expect(reader?.querySelector('.sub-tab-state')?.textContent).toBe('运行中')
    expect(reader?.querySelector('.team-reader-note')?.textContent).toBe(
      '只读：这是子智能体的运行记录',
    )
    expect(reader?.querySelector('.peek-text')?.textContent).toBe('队友的第一句回答')

    fireEvent.click(buttonByText(reader as HTMLElement, '返回原会话'))
    await flush()
    expect(document.querySelector('.team-reader')).toBeNull()
  })

  test('面包屑事件：按 sessionId 找父会话标题；关闭时发 null', async () => {
    const channel = makeChannel({
      roster: () => [mate({ sessionId: 'parent' })],
      peek: () => Promise.resolve(entries()),
      sessions: [{ id: 'C:/sessions/parent.jsonl', title: '父会话标题' }],
      sessionPath: 'C:/sessions/current.jsonl',
    })
    const loaded = loadTeam()
    openApi = readerOf(loaded)
    const hints: unknown[] = []
    const onHint = (event: Event): void => {
      hints.push((event as CustomEvent).detail)
    }
    window.addEventListener('shell.teammate.view', onHint)
    try {
      mount(loaded, channel)
      await flush()
      await openReader(loaded, mate({ sessionId: 'parent' }))
      expect(hints.at(-1)).toEqual({
        name: 'reviewer-1',
        parentTitle: '父会话标题',
        parentPath: 'C:/sessions/parent.jsonl',
      })

      fireEvent.click(buttonByText(document.querySelector('.team-reader') as HTMLElement, '返回原会话'))
      await flush()
      expect(hints.at(-1)).toBeNull()
    } finally {
      window.removeEventListener('shell.teammate.view', onHint)
    }
  })

  test('面包屑兜底：找不到出生会话时标题回落「原会话」并带当前会话路径', async () => {
    const channel = makeChannel({
      roster: () => [mate()],
      peek: () => Promise.resolve(entries()),
      sessions: [],
      sessionPath: 'C:/sessions/current.jsonl',
    })
    const loaded = loadTeam()
    openApi = readerOf(loaded)
    const hints: unknown[] = []
    const onHint = (event: Event): void => {
      hints.push((event as CustomEvent).detail)
    }
    window.addEventListener('shell.teammate.view', onHint)
    try {
      mount(loaded, channel)
      await flush()
      await openReader(loaded, mate({ sessionId: 'missing' }))
      expect(hints.at(-1)).toEqual({
        name: 'reviewer-1',
        parentTitle: '原会话',
        parentPath: 'C:/sessions/current.jsonl',
      })
    } finally {
      window.removeEventListener('shell.teammate.view', onHint)
    }
  })

  test('Esc 与跨包 exit 事件都能关掉这一层', async () => {
    const channel = makeChannel({ roster: () => [mate()], peek: () => Promise.resolve(entries()) })
    const loaded = loadTeam()
    openApi = readerOf(loaded)
    mount(loaded, channel)
    await flush()

    await openReader(loaded, mate())
    expect(document.querySelector('.team-reader')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    await flush()
    expect(document.querySelector('.team-reader')).toBeNull()

    await openReader(loaded, mate())
    expect(document.querySelector('.team-reader')).not.toBeNull()
    act(() => {
      window.dispatchEvent(new CustomEvent('shell.teammate.exit'))
    })
    await flush()
    expect(document.querySelector('.team-reader')).toBeNull()
  })
})

describe('ReaderActions：状态与动作回传', () => {
  test('working：只有停止（没有移除）；点停止回传 stopTeammate 并给成功回执', async () => {
    const channel = makeChannel({ roster: () => [mate({ state: 'working' })], peek: () => Promise.resolve(entries()) })
    const loaded = loadTeam()
    openApi = readerOf(loaded)
    mount(loaded, channel)
    await flush()
    await openReader(loaded, mate({ state: 'working' }))

    const reader = document.querySelector('.team-reader') as HTMLElement
    expect(() => buttonByText(reader, '移除')).toThrow()
    fireEvent.click(buttonByText(reader, '停止'))
    await flush()
    expect(channel.calls).toContainEqual({ method: 'stopTeammate', args: ['reviewer-1'] })
    expect(toastText()).toContain('已叫停 reviewer-1')
  })

  test('停止失败：toastErr 把宿主原因写出来', async () => {
    const channel = makeChannel({
      roster: () => [mate({ state: 'working' })],
      peek: () => Promise.resolve(entries()),
      reject: (method) => (method === 'stopTeammate' ? new Error('宿主拒绝') : undefined),
    })
    const loaded = loadTeam()
    openApi = readerOf(loaded)
    mount(loaded, channel)
    await flush()
    await openReader(loaded, mate({ state: 'working' }))

    fireEvent.click(buttonByText(document.querySelector('.team-reader') as HTMLElement, '停止'))
    await flush()
    expect(toastText()).toContain('已叫停 reviewer-1失败：宿主拒绝')
    expect(document.querySelector('.dsc-toast[data-tone="danger"]')).not.toBeNull()
  })

  test('移除：先确认；取消不发，确认后才回传 removeTeammate', async () => {
    const channel = makeChannel({ roster: () => [mate({ state: 'idle' })], peek: () => Promise.resolve(entries()) })
    const loaded = loadTeam()
    openApi = readerOf(loaded)
    mount(loaded, channel)
    await flush()
    await openReader(loaded, mate({ state: 'idle' }))

    const reader = document.querySelector('.team-reader') as HTMLElement
    fireEvent.click(buttonByText(reader, '移除'))
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.querySelector('.dsc-confirm__title')?.textContent).toBe('移除队友「reviewer-1」？')
    fireEvent.click(buttonByText(dialog as HTMLElement, '取消'))
    await flush()
    expect(channel.calls.some((call) => call.method === 'removeTeammate')).toBe(false)
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()

    fireEvent.click(buttonByText(reader, '移除'))
    const confirmed = document.querySelector('[role="alertdialog"]') as HTMLElement
    const proceed = confirmed.querySelector(
      '.dsc-confirm__actions button[data-variant="destructive"]',
    ) as HTMLButtonElement
    fireEvent.click(proceed)
    await flush()
    expect(channel.calls).toContainEqual({ method: 'removeTeammate', args: ['reviewer-1'] })
    expect(toastText()).toContain('已移除 reviewer-1')
  })

  test('发话：空值禁发；按钮与回车两条路都回传 messageTeammate 并收起输入框', async () => {
    const channel = makeChannel({ roster: () => [mate({ state: 'idle' })], peek: () => Promise.resolve(entries()) })
    const loaded = loadTeam()
    openApi = readerOf(loaded)
    mount(loaded, channel)
    await flush()
    await openReader(loaded, mate({ state: 'idle' }))

    const reader = document.querySelector('.team-reader') as HTMLElement
    fireEvent.click(buttonByText(reader, '发话'))
    const input = reader.querySelector('.team-reader-write input') as HTMLInputElement
    expect(input.getAttribute('placeholder')).toBe('给 reviewer-1 带句话…')
    const send = buttonByText(reader, '发送')
    expect(send.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '   ' } })
    expect(send.disabled).toBe(true)

    fireEvent.change(input, { target: { value: '你好' } })
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    await flush()
    expect(channel.calls).toContainEqual({ method: 'messageTeammate', args: ['reviewer-1', '你好'] })
    expect(reader.querySelector('.team-reader-write input')).toBeNull()

    fireEvent.click(buttonByText(reader, '发话'))
    const again = reader.querySelector('.team-reader-write input') as HTMLInputElement
    fireEvent.change(again, { target: { value: '再来一句' } })
    fireEvent.keyDown(again, { key: 'Enter' })
    await flush()
    expect(channel.calls).toContainEqual({
      method: 'messageTeammate',
      args: ['reviewer-1', '再来一句'],
    })
    expect(reader.querySelector('.team-reader-write input')).toBeNull()
  })

  test('一次性队友：头部换成一次性说明，不给发话入口', async () => {
    const channel = makeChannel({
      roster: () => [mate({ state: 'idle', mode: 'one-shot' })],
      peek: () => Promise.resolve(entries()),
    })
    const loaded = loadTeam()
    openApi = readerOf(loaded)
    mount(loaded, channel)
    await flush()
    await openReader(loaded, mate({ state: 'idle', mode: 'one-shot' }))

    const reader = document.querySelector('.team-reader') as HTMLElement
    expect(reader.querySelector('.team-reader-note')?.textContent).toBe(
      '只读：一次性任务不支持后续消息，可在这里看完整执行记录',
    )
    expect(() => buttonByText(reader, '发话')).toThrow()
    expect(buttonByText(reader, '移除')).toBeTruthy()
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
    const instance = loaded.registry.seat(loaded.entry.store)
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
    const instance = loaded.registry.seat(loaded.entry.store)
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
