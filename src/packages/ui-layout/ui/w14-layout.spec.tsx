/**
 * `ui-layout` 的补盲：审查面板、更新按钮、两个桶文件，以及骨架（`app.tsx`）的几处边角。
 *
 * 缺口逐条：
 *
 *   - `review-pane.tsx`：宽度拖拽整条链（取基线 / 方向 / 夹取 / 每帧写变量 / 松手落盘）、
 *     双击复位、原生桥打开失败的回执、预览入口（走 setDockPreview 而不是 dockActions）；
 *   - `update-button.tsx`：`installUpdate` 调用本身失败（不是回 `{ok:false}`）的退位与原因；
 *   - `index.ts` / `ui/ui.tsx`：两个模块顶层的行（行身份常量与取词器），import 即覆盖；
 *   - `app.tsx`：正文列宽 / 右栏宽度拖拽的落盘、诊断区里 cordis 纤维五档文案、
 *     槽位故障清单、原生桥探针的成功读法。
 *
 * @module dsc-ui-layout/ui/w14-layout
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, type RenderResult } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, setShellPage, setThreadView, type HostChannel } from '@dsc/ui-runtime'
import { SlotRegistry, type ChangedFileView, type UiBootGraph, type UiPluginLoadReport } from '@dsc/ui-core'
import { SHELL_SLOTS, SLOT } from '@dsc/ui-slots'
import { dockSurface, registerDockTab, setDockReview, setDockSession, type DockTabBodyProps } from '@dsc/ui-dockkit'
import { PANEL_KEYS, primePanelGeometry } from '@dsc/ui-primitives'
import type { HostSnapshot, UiSlots } from '@dsc/ui'
import { App, type AppBootSession } from './app.js'
import { ReviewPane } from './review-pane.js'
import { UpdateButton } from './update-button.js'

/* ── 桶文件：模块顶层那两行（行身份常量、取词器）import 即执行 ─────────────── */
import * as layoutPackage from '../index.js'
import * as layoutUi from './ui.js'

const EMPTY_BOOT = (): UiBootGraph =>
  ({
    rev: 'r1',
    entries: [],
    batches: [],
    host: { name: 'Pneuma', version: '0.0.0-test', language: 'zh' },
  }) as unknown as UiBootGraph

interface ChannelHarness {
  channel: HostChannel
}

interface SnapshotOptions {
  sessionId?: string | null
  sessionPath?: string
}

/** 一个最小的数据通道：快照按用例拼，invoke 一律回 `{}`。 */
function makeChannel(options: SnapshotOptions = {}): ChannelHarness {
  const status: Record<string, unknown> = { cwd: 'D:/demo', turnState: 'idle' }
  if (options.sessionPath !== undefined) status['sessionPath'] = options.sessionPath
  if (options.sessionId !== undefined) status['sessionId'] = options.sessionId
  const snapshot = {
    entries: [],
    liveEntries: [],
    sessions: [],
    status,
    surfaces: {},
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
    invoke: (<T,>(): Promise<T> => Promise.resolve({} as T)) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel }
}

/** 一套壳槽位（每个槽登记一个探针），断言落点与故障账用。 */
function makeSlots(): { slots: SlotRegistry; asUiSlots: UiSlots } {
  const slots = new SlotRegistry()
  for (const [name, kind] of Object.entries(SHELL_SLOTS)) {
    slots.declare(name, kind as 'single' | 'list' | 'keyed' | 'chain')
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
  for (const [slot, id] of ids) {
    const probe = function Probe(): ReactNode {
      return <span data-probe={id}>{id}</span>
    }
    slots.register(slot, { id }, probe as never)
  }
  return { slots, asUiSlots: slots as unknown as UiSlots }
}

interface RenderOptions {
  boot?: UiBootGraph
  session?: AppBootSession | null
  services?: string[]
}

interface Mounted extends RenderResult {
  slots: SlotRegistry
}

function mountApp(harness: ChannelHarness, options: RenderOptions = {}): Mounted {
  const { slots, asUiSlots } = makeSlots()
  const services = options.services ?? []
  const view = render(
    <RuntimeProvider channel={harness.channel}>
      <App
        slots={asUiSlots}
        boot={options.boot ?? EMPTY_BOOT()}
        serviceRegistry={{ names: () => services } as unknown as Parameters<typeof App>[0]['serviceRegistry']}
        session={options.session ?? null}
        hmr={null}
        bootError={null}
        allowedModules={[]}
      />
    </RuntimeProvider>,
  )
  return { ...view, slots }
}

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''

/** 一份最小改动（`.txt` 避开 shiki 语法装载）。 */
function fileOf(path: string, over: Partial<ChangedFileView> = {}): ChangedFileView {
  return {
    path,
    added: 1,
    removed: 0,
    status: 'modified',
    hunks: [
      {
        oldStart: 1,
        oldCount: 0,
        newStart: 1,
        newCount: 1,
        lines: [{ kind: 'add', text: 'hello', oldLine: null, newLine: 1 }],
      },
    ],
    ...over,
  }
}

/** 装一座假原生桥：`call` 的行为由用例给。 */
function installBridge(call: (op: string, args: unknown[]) => Promise<unknown>): void {
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call,
    on: () => () => undefined,
  }
}

const capturedPointers = new Set<number>()
let sessionSeq = 0
const nextSessionId = (): string => {
  sessionSeq += 1
  return `w14-layout-${String(sessionSeq)}`
}

/* 「打开」走 setDockPreview：它只在 preview 这一 kind 已报名时才开页签。 */
let offPreviewKind: (() => void) | null = null
beforeAll(() => {
  offPreviewKind = registerDockTab({
    kind: 'preview',
    label: '预览',
    component: function PreviewStub(_props: DockTabBodyProps): ReactNode {
      return <div data-preview-stub="" />
    },
  })
})
afterAll(() => {
  offPreviewKind?.()
})

beforeEach(() => {
  localStorage.clear()
  primePanelGeometry({})
  setShellPage(null)
  setThreadView('chat')
  setDockReview(null)
  setDockSession('')
  window.history.replaceState({}, '', '/')
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
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
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', (): void => undefined)
  capturedPointers.clear()
  const proto = Element.prototype as unknown as {
    setPointerCapture?: (id: number) => void
    hasPointerCapture?: (id: number) => boolean
    releasePointerCapture?: (id: number) => void
    scrollIntoView?: () => void
  }
  proto.setPointerCapture = (id: number): void => {
    capturedPointers.add(id)
  }
  proto.hasPointerCapture = (id: number): boolean => capturedPointers.has(id)
  proto.releasePointerCapture = (id: number): void => {
    capturedPointers.delete(id)
  }
  proto.scrollIntoView = (): void => undefined
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  const proto = Element.prototype as unknown as Record<string, unknown>
  delete proto['setPointerCapture']
  delete proto['hasPointerCapture']
  delete proto['releasePointerCapture']
  delete proto['scrollIntoView']
  delete (globalThis as { dscNative?: unknown }).dscNative
  localStorage.clear()
  setDockReview(null)
  setDockSession('')
  setShellPage(null)
  setThreadView('chat')
  window.history.replaceState({}, '', '/')
})

describe('两个桶文件的模块顶层', () => {
  test('包入口给出行身份，界面入口导出骨架组件', () => {
    expect(layoutPackage.name).toBe('ui-layout')
    expect(typeof layoutPackage.apply).toBe('function')
    expect(typeof layoutUi.App).toBe('function')
    layoutPackage.apply()
  })
})

describe('审查面板的宽度拖拽', () => {
  test('拖左边缘调宽：每帧写根变量，松手落盘；双击复位删档', () => {
    setDockReview({ files: [fileOf('C:/repo/a.txt')], index: 0, cwd: 'C:/repo' })
    const { container } = render(<ReviewPane />)
    const resizer = container.querySelector('.diff-resizer') as HTMLElement

    fireEvent.pointerDown(resizer, { button: 0, clientX: 400, pointerId: 1 })
    // 面板在右、热区在左缘：指针左移（dx 为负）面板变宽。
    fireEvent.pointerMove(resizer, { clientX: 340, pointerId: 1 })
    expect(document.documentElement.style.getPropertyValue('--dsc-diff-pane-w')).toBe('540px')
    fireEvent.pointerUp(resizer, { clientX: 340, pointerId: 1 })
    expect(localStorage.getItem(PANEL_KEYS.diffPaneWidth)).toBe('540')

    fireEvent.doubleClick(resizer)
    expect(localStorage.getItem(PANEL_KEYS.diffPaneWidth)).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--dsc-diff-pane-w')).toBe('')
  })

  test('原生桥「系统打开」失败：红色 toast 带上原因', async () => {
    installBridge(() => Promise.reject(new Error('没有默认程序')))
    setDockReview({ files: [fileOf('C:/repo/a.txt')], index: 0, cwd: 'C:/repo' })
    const { container } = render(<ReviewPane />)
    const openSystem = [...container.querySelectorAll('.diff-tool')].find(
      (button) => textOf(button) === '系统打开',
    ) as HTMLButtonElement
    fireEvent.click(openSystem)
    await flush()
    expect(document.querySelector('.dsc-toast__text')?.textContent).toContain('系统打开失败：没有默认程序')
  })

  test('「打开」入口把预览目标交给 dockkit（而不是走 dockActions 的旧路）', () => {
    setDockReview({ files: [fileOf('C:/repo/a.txt')], index: 0, cwd: 'C:/repo' })
    const { container } = render(<ReviewPane />)
    const open = [...container.querySelectorAll('.diff-tool')].find((button) => textOf(button) === '打开')
    fireEvent.click(open as HTMLButtonElement)
    const surface = dockSurface()
    const tabs = surface.panes.flatMap((pane) => pane.tabs)
    expect(tabs.some((tab) => tab.kind === 'preview' && tab.path === 'C:/repo/a.txt')).toBe(true)
  })
})

describe('更新按钮的调用失败', () => {
  test('installUpdate 本身 reject：按钮退回可点，title 写「更新失败：原因」', async () => {
    installBridge((op) => {
      if (op === 'checkUpdate') return Promise.resolve({ status: 'available', version: '1.2.3' })
      if (op === 'installUpdate') return Promise.reject(new Error('通道断了'))
      return Promise.resolve(undefined)
    })
    const { container } = render(<UpdateButton />)
    await flush()
    const button = container.querySelector('.update-btn') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(button)
      await Promise.resolve()
    })
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('title')).toBe('更新失败：通道断了')
    expect(button.textContent).toBe('更新')
  })
})

describe('骨架的尺寸落盘', () => {
  test('正文列宽拖拽松手把新宽度写进存档', () => {
    const { container } = mountApp(makeChannel())
    const handle = container.querySelector('.thread-handle[data-side="right"]') as HTMLElement
    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 560, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 560, pointerId: 1 })
    expect(localStorage.getItem(PANEL_KEYS.threadWidth)).not.toBeNull()
  })

  test('右栏宽度拖拽：每帧回传、落盘', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1600 })
    const { container } = mountApp(makeChannel({ sessionId: nextSessionId() }))
    const resizer = container.querySelector('.dock-resizer') as HTMLElement
    expect(resizer).not.toBeNull()
    fireEvent.mouseDown(resizer, { clientX: 800 })
    fireEvent.mouseMove(window, { clientX: 700 })
    fireEvent.mouseUp(window, { clientX: 700 })
    expect(localStorage.getItem(PANEL_KEYS.dockWidth)).not.toBeNull()
  })
})

describe('诊断区的读数', () => {
  /** 一份装载账本：`fiber` 是 cordis 状态码（0..5）。 */
  function sessionOf(fibers: Array<[string, number]>): AppBootSession {
    const reports: UiPluginLoadReport[] = [
      ...fibers.map(([id]) => ({ id, ok: true, name: id })),
      // 有一条失败才会强制画出诊断区（全绿时诊断默认收着）。
      { id: 'broken', ok: false, error: '装不上' },
    ]
    const plugins: Record<string, unknown> = {}
    for (const [id, fiber] of fibers) plugins[id] = { phase: 'early', state: 'loaded', via: 'cordis', fiber }
    return {
      getReports: () => reports,
      getState: () => ({ startedAt: 1000, batches: [], plugins }) as never,
      subscribe: () => () => undefined,
    } as unknown as AppBootSession
  }

  test('cordis 电池五档都有中文文案（待装 / 装载中 / 装载失败 / 已卸载）', async () => {
    const session = sessionOf([
      ['p0', 0],
      ['p1', 1],
      ['p3', 3],
      ['p4', 4],
      ['p5', 5],
    ])
    const boot = {
      ...EMPTY_BOOT(),
      entries: ['p0', 'p1', 'p3', 'p4', 'p5'].map((id) => ({ id })),
    } as unknown as UiBootGraph
    const { container } = mountApp(makeChannel(), { session, boot })
    await flush()
    const diag = textOf(container.querySelector('.diagnostics'))
    expect(diag).toContain('待装')
    expect(diag).toContain('装载中')
    expect(diag).toContain('装载失败')
    expect(diag).toContain('已卸载')
  })

  test('槽位故障账：诊断区逐条列出（槽名 / 条目 id / 阶段 / 消息）', () => {
    const { container, slots } = mountApp(makeChannel())
    const entry = slots.entriesOf(SLOT.main)[0] as never
    act(() => {
      slots.reportFault(entry, new Error('渲染炸了'))
    })
    const fault = container.querySelector('[data-fault]') as HTMLElement
    expect(fault).not.toBeNull()
    expect(fault.className).toContain('bad')
    expect(textOf(fault)).toContain('渲染炸了')
    expect(textOf(fault)).toContain('在渲染时出错')
  })

  test('?diag=1 下原生桥探针：recentCwds 成功时读数写「回了几个」', async () => {
    window.history.replaceState({}, '', '/?diag=1')
    installBridge((op) => {
      // UpdateButton 也挂在这棵树上：它的 checkUpdate 要有正经回话，否则渲染就崩。
      if (op === 'checkUpdate') return Promise.resolve({ status: 'latest' })
      if (op === 'recentCwds') return Promise.resolve(['C:/a', 'C:/b'])
      return Promise.resolve(undefined)
    })
    const { container } = mountApp(makeChannel())
    await flush()
    const native = container.querySelector('[data-native]') as HTMLElement
    expect(native.getAttribute('data-native')).toBe('on')
    expect(native.getAttribute('data-native-probe')).toBe('ok')
    expect(textOf(native)).toContain('试点 recentCwds 回了 2 个最近工作区')
  })
})
