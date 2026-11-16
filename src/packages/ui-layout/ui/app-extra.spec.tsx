/**
 * 壳层主界面（`ui-layout/ui/app.tsx`）的补充分支段（ui 层，真渲染）。
 *
 * 与同目录三份既有 spec 的分工：
 *   - `app-spacer.spec.tsx` 钉底部占位的**位置**；
 *   - `review-pane.spec.tsx` / `update-button.spec.tsx` 各自钉子组件；
 *   - 本文件补骨架本身：槽位落点、面板开合、页签路由、侧栏折叠、快捷键、尺寸存档、
 *     空态/连接/诊断三类异常面、队友面包屑与整页路由。
 *
 * 假 `HostChannel` 按方法返回形状正确的数据（`getUiPrefs` 给空对象、`openSession` 记账），
 * 路由用 `setShellPage` / `setThreadView` / `setDockReview` 这些壳的真源驱动。每个用例都在
 * 用完清干净模块级状态（它们是模块单例，不清会串到下一个用例）。
 *
 * @module dsc-ui-layout/ui/app-extra.spec
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, type RenderResult } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import { RuntimeProvider, setShellPage, setThreadView, type ChannelStatus, type HostChannel } from '@dsc/ui-runtime'
import { SlotRegistry, type UiBootGraph, type UiPluginLoadReport } from '@dsc/ui-core'
import { SHELL_SLOTS, SLOT } from '@dsc/ui-slots'
import {
  dockSurface,
  registerDockTab,
  setDockReview,
  setDockSession,
  type DockTabBodyProps,
} from '@dsc/ui-dockkit'
import { PANEL_KEYS, primePanelGeometry } from '@dsc/ui-primitives'
import type { HostSnapshot, UiSlots } from '@dsc/ui'
import { App, type AppBootSession, type AppSyncHandle } from './app.js'

/** jsdom 里的窄屏开关：`beforeEach` 的 matchMedia 桩现读它。 */
let narrowViewport = false
/** 指针捕获桩的账（jsdom 没有 PointerEvent 的捕获语义）。 */
const capturedPointers = new Set<number>()
/** 每个用例给一个独立的会话 id，让 dock 布局（会话级存档）从默认态开始。 */
let sessionSeq = 0
const nextSessionId = (): string => {
  sessionSeq += 1
  return `spec-session-${String(sessionSeq)}`
}

const EMPTY_BOOT = (): UiBootGraph =>
  ({
    rev: 'r1',
    entries: [],
    batches: [],
    host: { name: 'Pneuma', version: '0.0.0-test', language: 'zh' },
  }) as unknown as UiBootGraph

interface ChannelHarness {
  channel: HostChannel
  /** 每次 invoke 都记一笔（断言回传用）。 */
  calls: Array<{ method: string; args: unknown[] | undefined }>
  reconnects: number
  emit(): void
}

interface SnapshotOptions {
  entries?: unknown[]
  liveEntries?: unknown[]
  sessions?: unknown[]
  sessionPath?: string
  sessionId?: string | null
  cwd?: string | null
}

function makeChannel(
  options: {
    status?: ChannelStatus | (() => ChannelStatus)
    hostError?: string | null
    hello?: { protocolVersion: number; methods: string[]; host: { name: string; version: string } } | null
    snapshot?: SnapshotOptions
  } = {},
): ChannelHarness {
  const listeners = new Set<() => void>()
  const calls: Array<{ method: string; args: unknown[] | undefined }> = []
  // 先收成 const 再判型：闭包里读 `options.status` 不会被外层 typeof 收窄。
  const statusOption = options.status
  const statusFn: () => ChannelStatus =
    typeof statusOption === 'function' ? statusOption : () => statusOption ?? 'open'
  const state = { reconnects: 0, status: statusFn }
  const snap = options.snapshot ?? {}
  const status: Record<string, unknown> = { cwd: snap.cwd ?? 'D:/demo', turnState: 'idle' }
  if (snap.sessionPath !== undefined) status['sessionPath'] = snap.sessionPath
  if (snap.sessionId !== undefined) status['sessionId'] = snap.sessionId
  if (snap.cwd === null) delete status['cwd']
  const snapshot = {
    entries: snap.entries ?? [],
    liveEntries: snap.liveEntries ?? [],
    sessions: snap.sessions ?? [],
    status,
    surfaces: {},
  } as unknown as HostSnapshot
  const channel: HostChannel = {
    getSnapshot: () => snapshot,
    getHello: () => options.hello ?? null,
    getStatus: () => state.status(),
    getHostError: () => options.hostError ?? null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    invoke: (<T,>(method: string, args?: unknown[]): Promise<T> => {
      calls.push({ method, args })
      return Promise.resolve({} as T)
    }) as HostChannel['invoke'],
    reconnect: () => {
      state.reconnects += 1
    },
    close: () => undefined,
  }
  return {
    channel,
    calls,
    get reconnects() {
      return state.reconnects
    },
    emit: () => {
      for (const listener of [...listeners]) listener()
    },
  } as ChannelHarness & { reconnects: number }
}

/** 一套槽位：每个壳槽都登记一个带 data-probe 的探针组件，断言落点用。 */
function makeSlots(): { slots: SlotRegistry; asUiSlots: UiSlots } {
  const slots = new SlotRegistry()
  for (const [name, kind] of Object.entries(SHELL_SLOTS)) {
    slots.declare(name, kind as 'single' | 'list' | 'keyed' | 'chain')
  }
  const probe = (text: string): ComponentType<Record<string, unknown>> =>
    function Probe(): ReactNode {
      return <span data-probe={text}>{text}</span>
    }
  const ids: Array<[string, string]> = [
    [SLOT.header, 'header'],
    [SLOT.headerLead, 'header-lead'],
    [SLOT.sidebar, 'sidebar'],
    [SLOT.page, 'page'],
    [SLOT.main, 'main'],
    [SLOT.thread, 'thread'],
    [SLOT.composer, 'composer'],
    [SLOT.statusbar, 'statusbar'],
    [SLOT.notice, 'notice'],
  ]
  for (const [slot, id] of ids) slots.register(slot, { id }, probe(id) as never)
  return { slots, asUiSlots: slots as unknown as UiSlots }
}

interface RenderOptions {
  boot?: UiBootGraph
  bootError?: string | null
  session?: AppBootSession | null
  hmr?: AppSyncHandle | null
  services?: string[]
  allowedModules?: string[]
}

interface Mounted extends RenderResult {
  harness: ChannelHarness
  slots: SlotRegistry
}

function mount(harness: ChannelHarness, options: RenderOptions = {}): Mounted {
  const { slots, asUiSlots } = makeSlots()
  const services = options.services ?? []
  const state = {
    names: () => services,
  }
  const view = render(
    <RuntimeProvider channel={harness.channel}>
      <App
        slots={asUiSlots}
        boot={options.boot ?? EMPTY_BOOT()}
        serviceRegistry={state as unknown as Parameters<typeof App>[0]['serviceRegistry']}
        session={options.session ?? null}
        hmr={options.hmr ?? null}
        bootError={options.bootError ?? null}
        allowedModules={options.allowedModules ?? []}
      />
    </RuntimeProvider>,
  )
  return { ...view, harness, slots }
}

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''

const probeIn = (container: HTMLElement, selector: string, slot: string): Element | null =>
  container.querySelector(`${selector} [data-slot="${slot}"]`)

const fireKey = (init: KeyboardEventInit): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => {
    window.dispatchEvent(event)
  })
  return event
}

/** 本地存档的初始值要在 render 之前写（组件的读档发生在 useState 初始化里）。 */
const store = (key: string, value: string): void => localStorage.setItem(key, value)

/* ------------------------------------------------------------------ */
/* 槽位注册（dock 页签种类）：Ctrl+P / Ctrl+` / Ctrl+T 只在 kind 已报名时开页签。 */
/* ------------------------------------------------------------------ */

const unregisterKinds: Array<() => void> = []
beforeAll(() => {
  const kinds: Array<{ kind: 'files' | 'terminal' | 'browser'; label: string }> = [
    { kind: 'files', label: '文件' },
    { kind: 'terminal', label: '终端' },
    { kind: 'browser', label: '浏览器' },
  ]
  for (const meta of kinds) {
    unregisterKinds.push(
      registerDockTab({
        kind: meta.kind,
        label: meta.label,
        component: function StubTab(_props: DockTabBodyProps): ReactNode {
          return <div data-dock-stub={meta.kind} />
        },
      }),
    )
  }
})
afterAll(() => {
  for (const off of unregisterKinds.splice(0)) off()
})

beforeEach(() => {
  localStorage.clear()
  // 几何模块有一份内存副本（localStorage 空着时回落到它）；上一个用例拖过的值不能串过来。
  primePanelGeometry({})
  narrowViewport = false
  setShellPage(null)
  setThreadView('chat')
  setDockReview(null)
  setDockSession('')
  window.history.replaceState({}, '', '/')

  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: narrowViewport,
    media: query,
    onchange: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    addListener: (): void => undefined,
    removeListener: (): void => undefined,
    dispatchEvent: (): boolean => false,
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
  // jsdom 没有 PointerEvent：拖拽用例要 `button` / `clientX` / `pointerId` 真的落在事件上，
  // 用 MouseEvent 顶上（否则 fireEvent 退化成 Event，`event.button` 是 undefined，
  // 按下处理器第一行就返回了）。
  vi.stubGlobal(
    'PointerEvent',
    class FakePointerEvent extends MouseEvent {
      readonly pointerId: number
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init)
        this.pointerId = init.pointerId ?? 1
      }
    },
  )
  capturedPointers.clear()
  const proto = Element.prototype as unknown as {
    setPointerCapture?: (id: number) => void
    hasPointerCapture?: (id: number) => boolean
    releasePointerCapture?: (id: number) => void
  }
  proto.setPointerCapture = (id: number): void => {
    capturedPointers.add(id)
  }
  proto.hasPointerCapture = (id: number): boolean => capturedPointers.has(id)
  proto.releasePointerCapture = (id: number): void => {
    capturedPointers.delete(id)
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  const proto = Element.prototype as unknown as {
    setPointerCapture?: unknown
    hasPointerCapture?: unknown
    releasePointerCapture?: unknown
  }
  delete proto.setPointerCapture
  delete proto.hasPointerCapture
  delete proto.releasePointerCapture
  delete (globalThis as { dscNative?: unknown }).dscNative
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 })
  setShellPage(null)
  setThreadView('chat')
  setDockReview(null)
  setDockSession('')
  window.history.replaceState({}, '', '/')
  localStorage.clear()
})

describe('骨架布局与槽位', () => {
  test('品牌名、九个槽位各就各位；空会话给居中欢迎态；标题回落「新会话」', () => {
    const harness = makeChannel()
    const { container } = mount(harness)

    expect(textOf(container.querySelector('.sidebar-header .brand'))).toBe('Pneuma')
    // 槽位的落点：侧栏、顶栏左簇/右簇、正文列、输入区、状态栏、播报区。
    expect(probeIn(container, '.sidebar-slot', SLOT.sidebar)).not.toBeNull()
    expect(probeIn(container, '.topbar-cluster', SLOT.headerLead)).not.toBeNull()
    expect(probeIn(container, '.topbar', SLOT.header)).not.toBeNull()
    expect(probeIn(container, '.chat-inner', SLOT.main)).not.toBeNull()
    expect(probeIn(container, '.composer-zone', SLOT.composer)).not.toBeNull()
    expect(probeIn(container, '.composer-zone .statusbar', SLOT.statusbar)).not.toBeNull()
    expect(probeIn(container, '.dsc-toasts', SLOT.notice)).not.toBeNull()
    // 空快照标题给「新会话」。
    expect(textOf(container.querySelector('.topbar .title'))).toBe('新会话')
    // 空会话：对话页给 thread-main-empty（欢迎文案与输入框居中成一组）。
    expect(container.querySelector('.thread-main')?.className).toBe('thread-main thread-main-empty')
    // 页模式专属的壳.page 槽这时不渲染。
    expect(container.querySelector(`[data-slot="${SLOT.page}"]`)).toBeNull()
  })

  test('顶栏标题按会话列表找显示名（sessionPath → title）', () => {
    const harness = makeChannel({
      snapshot: {
        sessions: [{ id: 'C:/s/a.jsonl', title: '修复布局' }],
        sessionPath: 'C:/s/a.jsonl',
      },
    })
    const { container } = mount(harness)
    expect(textOf(container.querySelector('.topbar .title'))).toBe('修复布局')
  })

  test('开场 system 条目不算「有内容」；真对话条目才摘掉空态', () => {
    const systemOnly = mount(makeChannel({ snapshot: { entries: [{ kind: 'system', text: '会话已开始' }] } }))
    expect(systemOnly.container.querySelector('.thread-main')?.className).toContain('thread-main-empty')
    systemOnly.unmount()

    const withUser = mount(makeChannel({ snapshot: { entries: [{ kind: 'user', text: '你好' }] } }))
    expect(withUser.container.querySelector('.thread-main')?.className).toBe('thread-main')
  })
})

describe('页签路由与面板开合', () => {
  test('对话/轨迹两张脸：点轨迹换 shell.thread，输入区与状态栏不跟着换', () => {
    const { container } = mount(makeChannel())
    const tabs = [...container.querySelectorAll('.topbar .tabs button')]
    expect(tabs.map((tab) => textOf(tab))).toEqual(['对话', '轨迹'])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(probeIn(container, '.chat-inner', SLOT.main)).not.toBeNull()

    fireEvent.click(tabs[1] as HTMLElement)
    expect(container.querySelector('.chat-wrap')).toBeNull()
    expect(probeIn(container, '.main', SLOT.thread)).not.toBeNull()
    expect(probeIn(container, '.composer-zone', SLOT.composer)).not.toBeNull()
    expect(probeIn(container, '.composer-zone .statusbar', SLOT.statusbar)).not.toBeNull()
    const after = [...container.querySelectorAll('.topbar .tabs button')]
    expect(after[1]?.getAttribute('aria-selected')).toBe('true')
    expect(after[1]?.className).toBe('on')

    fireEvent.click(after[0] as HTMLElement)
    expect(container.querySelector('.chat-wrap')).not.toBeNull()
    expect(container.querySelector(`[data-slot="${SLOT.thread}"]`)).toBeNull()
  })

  test('侧栏折叠：Ctrl+B 收起成窄栏、插件内容不卸载、存档落盘；再按一次展开', () => {
    const { container } = mount(makeChannel())
    expect(container.querySelector('.app')?.getAttribute('data-rail')).toBe('0')
    expect(container.querySelector('.sidebar')).not.toBeNull()
    expect(container.querySelector('.sidebar.rail')).toBeNull()
    expect(container.querySelector('.rail-logo')).toBeNull()
    expect(container.querySelector('.sidebar-resizer')).not.toBeNull()

    fireKey({ key: 'b', ctrlKey: true })
    expect(container.querySelector('.app')?.getAttribute('data-rail')).toBe('1')
    expect(container.querySelector('.sidebar')).not.toBeNull()
    expect(container.querySelector('.sidebar')?.className).toBe('sidebar rail')
    expect(container.querySelector('.rail-logo')).not.toBeNull()
    expect(container.querySelector('.sidebar-resizer')).toBeNull()
    // 插件内容仍在 DOM 里（收起只藏不卸）。
    expect(probeIn(container, '.sidebar-slot', SLOT.sidebar)).not.toBeNull()
    expect(container.querySelector('.sidebar-header')?.getAttribute('aria-hidden')).toBe('true')
    expect(localStorage.getItem(PANEL_KEYS.sidebarCollapsed)).toBe('1')

    fireKey({ key: 'B', ctrlKey: true })
    expect(container.querySelector('.app')?.getAttribute('data-rail')).toBe('0')
    expect(container.querySelector('.rail-logo')).toBeNull()
    expect(localStorage.getItem(PANEL_KEYS.sidebarCollapsed)).toBe('0')
  })

  test('侧栏开合的另外两个入口：品牌行收起钮与 shell.sidebar.toggle 事件', () => {
    const { container } = mount(makeChannel())
    fireEvent.click(container.querySelector('.sidebar-header .rail-toggle') as HTMLElement)
    expect(container.querySelector('.app')?.getAttribute('data-rail')).toBe('1')

    act(() => {
      window.dispatchEvent(new CustomEvent('shell.sidebar.toggle'))
    })
    expect(container.querySelector('.app')?.getAttribute('data-rail')).toBe('0')

    // 带 shift / alt 的组合键不是快捷键（避免吞掉浏览器自己的 Ctrl+Shift+B）。
    fireKey({ key: 'b', ctrlKey: true, shiftKey: true })
    expect(container.querySelector('.app')?.getAttribute('data-rail')).toBe('0')
    fireKey({ key: 'b' })
    expect(container.querySelector('.app')?.getAttribute('data-rail')).toBe('0')
  })

  test('窄栏导航：logo 展开、新会话事件、技能/插件切页并回退', () => {
    store(PANEL_KEYS.sidebarCollapsed, '1')
    const { container } = mount(makeChannel())
    expect(container.querySelector('.app')?.getAttribute('data-rail')).toBe('1')

    const newSession = vi.fn()
    window.addEventListener('shell.session.new', newSession)
    fireEvent.click(container.querySelector('.rail-btn[aria-label="新会话"]') as HTMLElement)
    expect(newSession).toHaveBeenCalledTimes(1)
    window.removeEventListener('shell.session.new', newSession)

    const skills = container.querySelector('.rail-nav .rail-btn[aria-label="技能"]') as HTMLElement
    expect(skills.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(skills)
    expect(skills.getAttribute('aria-pressed')).toBe('true')
    expect(skills.className).toContain('on')
    fireEvent.click(skills)
    expect(skills.getAttribute('aria-pressed')).toBe('false')

    const plugins = container.querySelector('.rail-nav .rail-btn[aria-label="插件"]') as HTMLElement
    fireEvent.click(plugins)
    expect(plugins.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(plugins)
    expect(plugins.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(container.querySelector('.rail-logo') as HTMLElement)
    expect(container.querySelector('.app')?.getAttribute('data-rail')).toBe('0')
  })

  test('窄栏底部：目录提示带 cwd、点目录展开、设置发 window 事件', () => {
    store(PANEL_KEYS.sidebarCollapsed, '1')
    const { container } = mount(makeChannel({ snapshot: { cwd: 'D:/proj' } }))

    const settings = vi.fn()
    window.addEventListener('shell.settings.open', settings)
    const folder = container.querySelector('.rail-foot .rail-btn[aria-label="展开侧边栏（查看工作目录）"]') as HTMLElement
    expect(folder.getAttribute('data-tip')).toContain('工作目录 D:/proj')
    fireEvent.click(container.querySelector('.rail-foot .rail-btn[aria-label="设置"]') as HTMLElement)
    expect(settings).toHaveBeenCalledTimes(1)
    window.removeEventListener('shell.settings.open', settings)

    fireEvent.click(folder)
    expect(container.querySelector('.app')?.getAttribute('data-rail')).toBe('0')
  })

  test('工作区面板开合钮：收起时出现，点开后右栏展开、钮自己消失', () => {
    const harness = makeChannel({ snapshot: { sessionId: nextSessionId() } })
    const { container } = mount(harness)
    const toggle = container.querySelector('.dock-toggle') as HTMLElement
    expect(toggle).not.toBeNull()
    expect(container.querySelector('.dock')?.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(toggle)
    expect(dockSurface().expanded).toBe(true)
    expect(container.querySelector('.dock-toggle')).toBeNull()
    expect(container.querySelector('.dock')?.getAttribute('aria-hidden')).toBeNull()
  })

  test('审查目标在时正文让位：thread-zone 打 data-review，拖拽把手不画', () => {
    setDockReview({ files: [], index: 0, cwd: 'C:/repo' })
    const { container } = mount(makeChannel())
    expect(container.querySelector('.thread-zone')?.getAttribute('data-review')).toBe('1')
    expect(container.querySelectorAll('.thread-handle')).toHaveLength(0)
  })
})

describe('窄屏（手机档）', () => {
  test('窄屏首帧就收起：不画图标窄栏，导航改挂顶栏；会话钮拉抽屉、遮罩收回', () => {
    narrowViewport = true
    const { container } = mount(makeChannel())
    expect(container.querySelector('.app')?.getAttribute('data-rail')).toBe('1')
    expect(container.querySelector('.sidebar')?.className).toBe('sidebar rail')
    // 手机档整条侧栏不画，窄栏也不画。
    expect(container.querySelector('.rail-logo')).toBeNull()

    const sessions = container.querySelector('.topbar-nav-btn[aria-label="会话"]') as HTMLElement
    expect(sessions).not.toBeNull()
    expect(container.querySelector('.sidebar-scrim')).toBeNull()
    fireEvent.click(sessions)
    expect(container.querySelector('.app')?.getAttribute('data-rail')).toBe('0')
    expect(container.querySelector('.sidebar-scrim')).not.toBeNull()

    fireEvent.click(container.querySelector('.sidebar-scrim') as HTMLElement)
    expect(container.querySelector('.app')?.getAttribute('data-rail')).toBe('1')
    expect(container.querySelector('.sidebar-scrim')).toBeNull()
  })

  test('窄屏整页：页头带给回头路；「插件」钮切整页再返回对话', () => {
    narrowViewport = true
    setShellPage('skills')
    const harness = makeChannel()
    const { container } = mount(harness)

    expect(container.querySelector('.topbar')).toBeNull()
    expect(textOf(container.querySelector('.page-strip .title'))).toBe('技能')
    fireEvent.click(container.querySelector('.page-strip .icon-btn[aria-label="返回对话"]') as HTMLElement)
    expect(container.querySelector('.page-strip')).toBeNull()
    expect(container.querySelector('.topbar')).not.toBeNull()

    const plugins = container.querySelector('.topbar-nav-btn[aria-label="插件"]') as HTMLElement
    expect(plugins.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(plugins)
    expect(textOf(container.querySelector('.page-strip .title'))).toBe('插件')
    expect(container.querySelector('.topbar')).toBeNull()
  })

  test('窄屏轨迹页只留一颗「← 对话」，没有被顶栏页签困住', () => {
    narrowViewport = true
    setThreadView('trace')
    const { container } = mount(makeChannel())
    const tabs = container.querySelector('.topbar .tabs') as HTMLElement
    expect(tabs).not.toBeNull()
    expect(tabs.getAttribute('role')).toBeNull()
    fireEvent.click(tabs.querySelector('button') as HTMLElement)
    expect(container.querySelector('.chat-wrap')).not.toBeNull()
    expect(container.querySelector('.topbar .tabs')).toBeNull()
  })
})

describe('整页模式与快捷键', () => {
  test('桌面整页：顶栏与正文换成 shell.page，状态栏仍占底部一份', () => {
    setShellPage('plugins')
    const { container } = mount(makeChannel())
    expect(container.querySelector('.topbar')).toBeNull()
    expect(container.querySelector('.thread-zone')).toBeNull()
    expect(probeIn(container, '.main', SLOT.page)).not.toBeNull()
    expect(container.querySelectorAll('.statusbar')).toHaveLength(1)
    expect(probeIn(container, '.main > .statusbar', SLOT.statusbar)).not.toBeNull()
    expect(container.querySelector('.composer-zone')).toBeNull()
    // 播报区与诊断区在页模式下照旧。
    expect(probeIn(container, '.dsc-toasts', SLOT.notice)).not.toBeNull()
  })

  test('Ctrl+P 打开文件页签（收起态下也会展开右栏）', () => {
    const harness = makeChannel({ snapshot: { sessionId: nextSessionId() } })
    mount(harness)
    const event = fireKey({ key: 'p', ctrlKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(dockSurface().expanded).toBe(true)
    const tabs = dockSurface().panes.flatMap((pane) => pane.tabs)
    expect(tabs.map((tab) => tab.kind)).toEqual(['files'])
  })

  test('Ctrl+` 打开终端页签（code=Backquote 也算）', () => {
    const harness = makeChannel({ snapshot: { sessionId: nextSessionId() } })
    mount(harness)
    fireKey({ key: '`', code: 'Backquote', ctrlKey: true })
    expect(dockSurface().expanded).toBe(true)
    expect(dockSurface().panes.flatMap((pane) => pane.tabs).map((tab) => tab.kind)).toEqual(['terminal'])
  })

  test('Ctrl+T 新开浏览器页签（不替换开始页，可多开）', () => {
    const harness = makeChannel({ snapshot: { sessionId: nextSessionId() } })
    mount(harness)
    fireKey({ key: 't', ctrlKey: true })
    const kinds = dockSurface().panes.flatMap((pane) => pane.tabs).map((tab) => tab.kind)
    expect(kinds).toEqual(['guide', 'browser'])
    fireKey({ key: 't', ctrlKey: true })
    expect(dockSurface().panes.flatMap((pane) => pane.tabs).filter((tab) => tab.kind === 'browser')).toHaveLength(2)
  })
})

describe('尺寸存档与拖拽', () => {
  test('侧栏宽度：读档铺根变量，双击复位删档；拖拽松手把新宽度落盘', () => {
    store(PANEL_KEYS.sidebarWidth, '300')
    const { container } = mount(makeChannel())
    expect(document.documentElement.style.getPropertyValue('--dsc-sidebar-w')).toBe('300px')

    fireEvent.doubleClick(container.querySelector('.sidebar-resizer') as HTMLElement)
    expect(localStorage.getItem(PANEL_KEYS.sidebarWidth)).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--dsc-sidebar-w')).toBe('')

    // 拖拽：默认宽 237 + 60（RAF 即时执行，让每帧回调当场落地）。
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', (): void => undefined)
    const resizer = container.querySelector('.sidebar-resizer') as HTMLElement
    fireEvent.pointerDown(resizer, { button: 0, clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(resizer, { clientX: 160, pointerId: 1 })
    expect(document.documentElement.style.getPropertyValue('--dsc-sidebar-w')).toBe('297px')
    fireEvent.pointerUp(resizer, { clientX: 160, pointerId: 1 })
    expect(localStorage.getItem(PANEL_KEYS.sidebarWidth)).toBe('297')
  })

  test('正文列宽：读档铺 --dsc-thread-user-max，双击把手复位', () => {
    store(PANEL_KEYS.threadWidth, '900')
    const { container } = mount(makeChannel())
    expect(document.documentElement.style.getPropertyValue('--dsc-thread-user-max')).toBe('900px')

    fireEvent.doubleClick(container.querySelector('.thread-handle[data-side="right"]') as HTMLElement)
    expect(localStorage.getItem(PANEL_KEYS.threadWidth)).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--dsc-thread-user-max')).toBe('')
  })

  test('右栏宽度随窗口变窄夹回可用空间（存档只改内存，不覆盖原宽）', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1600 })
    store(PANEL_KEYS.dockWidth, '800')
    const { container } = mount(makeChannel({ snapshot: { sessionId: nextSessionId() } }))
    const dock = container.querySelector('.dock') as HTMLElement
    expect(dock.style.width).toBe('800px')

    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 900 })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    // 900 - 0（jsdom 量不到侧栏）- 480 = 420。
    expect(dock.style.width).toBe('420px')
    expect(localStorage.getItem(PANEL_KEYS.dockWidth)).toBe('800')
  })
})

describe('异常态：连接、宿主与诊断', () => {
  test('数据通道 connecting 超过 3 秒才亮条；点「立即重连」叫 channel.reconnect', () => {
    vi.useFakeTimers()
    const harness = makeChannel({ status: 'connecting' })
    const { container } = mount(harness)
    expect(container.querySelector('.conn-banner')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    const banner = container.querySelector('.conn-banner') as HTMLElement
    expect(banner).not.toBeNull()
    expect(banner.getAttribute('data-conn')).toBe('connecting')
    expect(textOf(banner)).toContain('连不上宿主')
    fireEvent.click(banner.querySelector('.conn-retry') as HTMLElement)
    expect(harness.reconnects).toBe(1)
  })

  test('数据通道 closed：文案换成「连接已断开」并给出重开提示', () => {
    vi.useFakeTimers()
    const harness = makeChannel({ status: 'closed' })
    const { container } = mount(harness)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    const banner = container.querySelector('.conn-banner') as HTMLElement
    expect(banner.getAttribute('data-conn')).toBe('closed')
    expect(textOf(banner)).toContain('连接已断开')
    expect(textOf(banner)).toContain('凭据失效或宿主换了端口')
  })

  test('宿主异常条：有 hostError 时单独一行摊出原因', () => {
    const { container } = mount(makeChannel({ hostError: '造帧失败：坏数据' }))
    const strip = container.querySelector('.host-error') as HTMLElement
    expect(strip).not.toBeNull()
    expect(strip.getAttribute('data-host-error')).toBe('1')
    expect(textOf(strip)).toContain('宿主状态异常：造帧失败：坏数据')
  })

  test('清单取不到（bootError）：没有会话也画诊断，boot 那条报失败', () => {
    const { container } = mount(makeChannel(), { bootError: '清单 404' })
    const diag = container.querySelector('.diagnostics') as HTMLElement
    expect(diag).not.toBeNull()
    expect(textOf(diag.querySelector('summary'))).toContain('诊断（1 个插件')
    const boot = diag.querySelector('[data-plugin="boot"]') as HTMLElement
    expect(boot.className).toBe('bad')
    expect(textOf(boot)).toContain('失败：清单 404')
  })

  test('诊断读数：装载报告、批次时刻/rev、cordis 纤维与退订账本、服务表', async () => {
    const reports: UiPluginLoadReport[] = [
      { id: 'alpha', ok: true, name: 'Alpha', provides: ['svc.a', 'svc.b'], attempts: 2 },
      { id: 'beta', ok: false, error: 'boom' },
    ]
    const ledger = {
      startedAt: 1000,
      batches: [
        { phase: 'early', entries: ['alpha', 'beta'], state: 'done', scheduledAt: 900, startedAt: 1000, doneAt: 1120 },
      ],
      plugins: {
        alpha: { phase: 'early', state: 'loaded', via: 'cordis' as const, fiber: 2 },
        beta: { phase: 'early', state: 'failed', via: 'ledger' as const },
      },
    }
    const session: AppBootSession = {
      getReports: () => reports,
      getState: () => ledger,
      subscribe: () => () => undefined,
    }
    const boot = {
      ...EMPTY_BOOT(),
      rev: 'r9',
      entries: [{ id: 'alpha' }, { id: 'beta' }],
      batches: [{ phase: 'early', rev: 'r9' }],
    } as unknown as UiBootGraph

    const { container } = mount(makeChannel(), { session, boot, services: ['svc.a', 'svc.b'] })
    await flush()

    const alpha = container.querySelector('[data-plugin="alpha"]') as HTMLElement
    expect(alpha.className).toBe('ok')
    expect(textOf(alpha)).toContain('已装上')
    expect(textOf(alpha)).toContain('提供：svc.a、svc.b')
    expect(textOf(alpha)).toContain('（重试 2 次才成功）')
    expect(textOf(alpha.querySelector('[data-plugin-phase]'))).toContain('首屏批')
    expect(alpha.querySelector('[data-plugin-via]')?.getAttribute('data-plugin-via')).toBe('cordis')
    expect(textOf(alpha.querySelector('[data-plugin-via]'))).toContain('cordis（已生效）')

    const beta = container.querySelector('[data-plugin="beta"]') as HTMLElement
    expect(beta.className).toBe('bad')
    expect(textOf(beta)).toContain('失败：boom')
    expect(beta.querySelector('[data-plugin-via]')?.getAttribute('data-plugin-via')).toBe('ledger')
    expect(textOf(beta.querySelector('[data-plugin-via]'))).toContain('退订账本')

    const batch = container.querySelector('[data-batch="early"]') as HTMLElement
    expect(batch.getAttribute('data-batch-state')).toBe('done')
    expect(batch.getAttribute('data-batch-loaded')).toBe('1/2')
    expect(batch.getAttribute('data-batch-rev')).toBe('r9')
    expect(textOf(batch)).toContain('首屏 1/2')
    expect(textOf(batch)).toContain('@120ms')

    expect(container.querySelector('[data-services]')?.getAttribute('data-services')).toBe('svc.a,svc.b')
    expect(textOf(container.querySelector('.diagnostics'))).toContain('槽：')
  })

  test('页内同步失败：画失败清单并给重试入口', () => {
    const retry = vi.fn()
    const hmr: AppSyncHandle = {
      getFailures: () => [{ id: 'gamma', message: '换装失败', at: 1 }],
      retry,
      subscribe: () => () => undefined,
    }
    const { container } = mount(makeChannel(), { hmr })
    const failed = container.querySelector('[data-sync-failure="gamma"]') as HTMLElement
    expect(failed).not.toBeNull()
    expect(failed.className).toBe('bad')
    expect(textOf(failed)).toContain('页内同步失败：换装失败')
    fireEvent.click(container.querySelector('[data-sync-retry]') as HTMLElement)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  test('?diag=1 强制常显：服务/槽清单/原生桥探针读数都在', async () => {
    window.history.replaceState({}, '', '/?diag=1')
    const { container } = mount(makeChannel(), { services: ['svc.only'] })
    await flush()
    expect(container.querySelector('.diagnostics')).not.toBeNull()
    expect(container.querySelector('[data-services]')?.getAttribute('data-services')).toBe('svc.only')
    expect(textOf(container.querySelector('.diagnostics'))).toContain('shell.main')
    const native = container.querySelector('[data-native]') as HTMLElement
    expect(native.getAttribute('data-native')).toBe('off')
    expect(native.getAttribute('data-native-probe')).toBe('off')
    expect(textOf(native)).toContain('原生桥：')
  })
})

describe('队友面包屑与其他入口', () => {
  test('shell.teammate.view 换顶栏标题；点父会话先发退出事件再 openSession', () => {
    const harness = makeChannel()
    const { container } = mount(harness)
    const detail = { name: '小队友', parentTitle: '父会话', parentPath: 'C:/s/parent.jsonl' }

    act(() => {
      window.dispatchEvent(new CustomEvent('shell.teammate.view', { detail }))
    })
    const crumbs = container.querySelector('.crumbs') as HTMLElement
    expect(crumbs).not.toBeNull()
    expect(crumbs.getAttribute('aria-label')).toBe('会话层级')
    expect(textOf(crumbs.querySelector('.crumb-link'))).toBe('父会话')
    expect(textOf(crumbs.querySelector('.crumb-current'))).toBe('小队友')
    expect(textOf(crumbs.querySelector('.crumb-badge'))).toBe('只读')
    expect(container.querySelector('.topbar .title')).toBeNull()

    const exited = vi.fn()
    window.addEventListener('shell.teammate.exit', exited)
    fireEvent.click(crumbs.querySelector('.crumb-link') as HTMLElement)
    expect(exited).toHaveBeenCalledTimes(1)
    expect(harness.calls).toContainEqual({ method: 'openSession', args: ['C:/s/parent.jsonl'] })
    window.removeEventListener('shell.teammate.exit', exited)

    // 重复同一份 detail 不重画；detail=null 还原普通标题。
    act(() => {
      window.dispatchEvent(new CustomEvent('shell.teammate.view', { detail }))
    })
    expect(container.querySelector('.crumbs')).not.toBeNull()
    act(() => {
      window.dispatchEvent(new CustomEvent('shell.teammate.view', { detail: null }))
    })
    expect(container.querySelector('.crumbs')).toBeNull()
    expect(textOf(container.querySelector('.topbar .title'))).toBe('新会话')
  })

  test('父会话路径为空时只发退出事件，不调 openSession', () => {
    const harness = makeChannel()
    const { container } = mount(harness)
    act(() => {
      window.dispatchEvent(
        new CustomEvent('shell.teammate.view', {
          detail: { name: '小队友', parentTitle: '父会话', parentPath: null },
        }),
      )
    })
    fireEvent.click(container.querySelector('.crumb-link') as HTMLElement)
    expect(harness.calls.some((call) => call.method === 'openSession')).toBe(false)
  })
})
