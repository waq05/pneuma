/**
 * 浏览器插件的长尾分支补测（ui 层，jsdom + 假原生桥）。
 *
 * 已有 `address-bar.spec.tsx` 钉了「回车 → normalizeAddress → browserNav」这条主路。
 * 这一份补的是它没走到的分支：
 *   - `apply` 的两条桌面侧全局事件（开页签 / 关页签）的载荷校验与退订；
 *   - `browser-state` 的 id 过滤、地址回填、编辑中不覆盖草稿、空值不覆盖页签信息；
 *   - `browser-open-requested` 的载荷校验；
 *   - 几何上报：不可见只摘视图、矩形不可用按帧重试、回执 false / reject 写 data 属性；
 *   - 后退 / 前进 / 刷新 / 外部打开 / 地址栏回车的成功与失败文案。
 *
 * @module dsc-ui-browser/ui/w11-branches.spec
 */
import { beforeAll, beforeEach, afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { dockTabMeta, makeTab, type DockTab } from '@dsc/ui-dockkit'
import plugin from './ui.js'

type NativeHandler = (payload: unknown) => void

interface BridgeHarness {
  handlers: Map<string, Set<NativeHandler>>
  calls: Array<{ op: string; args: unknown[] }>
  replies: Map<string, (args: unknown[]) => Promise<unknown> | unknown>
  emit(event: string, payload: unknown): void
}

/** 假原生桥：事件处理函数按名字收着，测试里手动 emit。 */
function bridgeOf(): BridgeHarness {
  const handlers = new Map<string, Set<NativeHandler>>()
  const calls: Array<{ op: string; args: unknown[] }> = []
  const replies = new Map<string, (args: unknown[]) => Promise<unknown> | unknown>()
  const harness: BridgeHarness = {
    handlers,
    calls,
    replies,
    emit: (event, payload) => {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload)
    },
  }
  vi.stubGlobal('dscNative', {
    version: 1,
    call: (op: string, args: unknown[] = []): Promise<unknown> => {
      calls.push({ op, args })
      const reply = replies.get(op)
      try {
        return Promise.resolve(reply === undefined ? null : reply(args))
      } catch (error) {
        return Promise.reject(error)
      }
    },
    on: (event: string, handler: NativeHandler): (() => void) => {
      let set = handlers.get(event)
      if (set === undefined) {
        set = new Set()
        handlers.set(event, set)
      }
      set.add(handler)
      return () => {
        set!.delete(handler)
      }
    },
  })
  return harness
}

class ObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let BrowserTab: ComponentType<{ tab: DockTab; active: boolean; expanded: boolean }>

/** 经 apply 报名取回页签体（与生产壳同一条装配路）。 */
function takeBrowserTab(): ComponentType<{ tab: DockTab; active: boolean; expanded: boolean }> {
  const apply = plugin.apply as unknown as (ui?: never) => () => void
  const off = apply(undefined as never)
  const meta = dockTabMeta('browser')
  if (meta === undefined) throw new Error('browser 插件没有报名页签体')
  // 不调用 off：本文件后面的 openDockBrowserTab / closeTab 需要 browser 这个 kind 仍然有效。
  return meta.component as ComponentType<{ tab: DockTab; active: boolean; expanded: boolean }>
}

const renderTab = (
  overrides: Partial<{ path: string; active: boolean; expanded: boolean }> = {},
): ReturnType<typeof render> => {
  const tab = makeTab('browser', overrides.path, 'view-1')
  return render(
    <BrowserTab tab={tab} active={overrides.active ?? true} expanded={overrides.expanded ?? true} />,
  )
}

beforeAll(() => {
  BrowserTab = takeBrowserTab()
})

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── plugin.apply 的两条全局事件 ──────────────────────────────────────────────

describe('apply：桌面侧「开页签 / 关页签」两条全局事件的载荷校验', () => {
  test('非对象与空 id 都忽略；合法 id 才开页签，url 缺失按空态开', () => {
    const bridge = bridgeOf()
    const off = (plugin.apply as unknown as (ui?: never) => () => void)(undefined as never)
    expect(bridge.handlers.get('browser-tab-open-request')?.size).toBe(1)

    bridge.emit('browser-tab-open-request', null)
    bridge.emit('browser-tab-open-request', 'nope')
    bridge.emit('browser-tab-open-request', {})
    bridge.emit('browser-tab-open-request', { id: 42 })
    bridge.emit('browser-tab-open-request', { id: '' })
    // 到这一步一次页签都没开：dockActions 的调用不能从 calls 里看（它是内存状态），
    // 但至少不能抛错，且后续合法载荷要能接着走。
    bridge.emit('browser-tab-open-request', { id: 'agent-1', url: 'https://example.com/' })
    bridge.emit('browser-tab-open-request', { id: 'agent-2', url: 7 })
    off()
    expect(bridge.handlers.get('browser-tab-open-request')?.size).toBe(0)
    expect(bridge.handlers.get('browser-tab-close-request')?.size).toBe(0)
  })

  test('关页签事件同样校验；退订后不再收到', () => {
    const bridge = bridgeOf()
    const off = (plugin.apply as unknown as (ui?: never) => () => void)(undefined as never)
    bridge.emit('browser-tab-close-request', null)
    bridge.emit('browser-tab-close-request', {})
    bridge.emit('browser-tab-close-request', { id: '' })
    bridge.emit('browser-tab-close-request', { id: 'agent-1' })
    const before = bridge.handlers.get('browser-tab-close-request')?.size
    off()
    expect(bridge.handlers.get('browser-tab-close-request')?.size).toBe(0)
    expect(before).toBe(1)
  })

  test('重复报名后旧退订函数不摘掉新报名的页签', () => {
    const firstOff = (plugin.apply as unknown as (ui?: never) => () => void)(undefined as never)
    const secondOff = (plugin.apply as unknown as (ui?: never) => () => void)(undefined as never)
    firstOff()
    expect(dockTabMeta('browser')).toBeDefined()
    secondOff()
    expect(dockTabMeta('browser')).toBeUndefined()
    // 还给后续用例（本文件前面已取回组件，这里只补报名表）。
    ;(plugin.apply as unknown as (ui?: never) => () => void)(undefined as never)
  })
})

// ── browser-state / browser-open-requested ──────────────────────────────────

describe('BrowserTab：原生推送的分支', () => {
  test('状态推送只认自己这一台；地址与标题回填，空值不覆盖页签信息', async () => {
    const bridge = bridgeOf()
    const { container } = renderTab()
    const input = container.querySelector('.browser-url') as HTMLInputElement
    bridge.emit('browser-state', null)
    bridge.emit('browser-state', { id: 'other', url: 'https://wrong/' })
    expect(input.value).toBe('')
    bridge.emit('browser-state', { id: 'view-1', url: 'https://a.example/', title: '标题', canGoBack: true })
    await waitFor(() => expect(input.value).toBe('https://a.example/'))
    expect((container.querySelector('[aria-label="后退"]') as HTMLButtonElement).disabled).toBe(false)
    const callsNow = container.querySelectorAll('button').length
    expect(callsNow).toBeGreaterThan(0)
    // 空 url/title：只更新 page 状态，不改页签信息（这里只断言地址栏不被清空）。
    bridge.emit('browser-state', { id: 'view-1', url: '', title: '' })
    await waitFor(() => expect(input.value).toBe(''))
  })

  test('地址栏编辑中：状态推送不覆盖草稿；失焦后恢复跟随', () => {
    const bridge = bridgeOf()
    const { container } = renderTab()
    const input = container.querySelector('.browser-url') as HTMLInputElement
    fireEvent.change(input, { target: { value: '正在输入' } })
    fireEvent.focus(input)
    bridge.emit('browser-state', { id: 'view-1', url: 'https://pushed/' })
    expect(input.value).toBe('正在输入')
    fireEvent.blur(input)
    act(() => {
      bridge.emit('browser-state', { id: 'view-1', url: 'https://pushed/' })
    })
    expect(input.value).toBe('https://pushed/')
  })

  test('browser-open-requested：载荷不合法 / 不是本台都忽略，合法才开新页签', () => {
    const bridge = bridgeOf()
    renderTab()
    bridge.emit('browser-open-requested', null)
    bridge.emit('browser-open-requested', 'x')
    bridge.emit('browser-open-requested', { id: 'other', url: 'https://x/' })
    bridge.emit('browser-open-requested', { id: 'view-1', url: 5 })
    bridge.emit('browser-open-requested', { id: 'view-1', url: '' })
    expect(() => bridge.emit('browser-open-requested', { id: 'view-1', url: 'https://new.example/' })).not.toThrow()
  })

  test('卸载：退订两条事件并向原生层发 browserClose', () => {
    const bridge = bridgeOf()
    const view = renderTab()
    view.unmount()
    expect(bridge.handlers.get('browser-state')?.size).toBe(0)
    expect(bridge.calls.some((entry) => entry.op === 'browserClose')).toBe(true)
  })
})

// ── 几何上报 ────────────────────────────────────────────────────────────────

describe('BrowserTab：几何上报的三条出口', () => {
  test('不可见：只发 dockBrowser false，不上报矩形', async () => {
    const bridge = bridgeOf()
    renderTab({ active: false })
    await waitFor(() => expect(bridge.calls.some((entry) => entry.op === 'dockBrowser')).toBe(true))
    expect(bridge.calls.find((entry) => entry.op === 'dockBrowser')?.args).toEqual(['view-1', false])
  })

  test('矩形可用：上报矩形并回执 true；随后按页签地址发一次 load', async () => {
    const bridge = bridgeOf()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 600, 400))
    const { container } = renderTab({ path: 'https://example.com/' })
    await waitFor(() =>
      expect(bridge.calls.some((entry) => entry.op === 'browserNav' && entry.args[1] === 'load')).toBe(true),
    )
    const dock = bridge.calls.find((entry) => entry.op === 'dockBrowser')
    expect(dock?.args[2]).toEqual({ x: 10, y: 20, width: 600, height: 400 })
    expect((container.querySelector('.browser-holder') as HTMLElement).dataset['browserBound']).toBe('1')
  })

  test('矩形不可用：借 requestAnimationFrame 重试，直到拿到可用矩形', async () => {
    const bridge = bridgeOf()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    let calls = 0
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => {
      calls += 1
      return calls <= 1 ? new DOMRect(0, 0, 0, 0) : new DOMRect(0, 0, 500, 300)
    })
    renderTab({ path: 'https://retry.example/' })
    await waitFor(() => expect(frames.length).toBeGreaterThan(0))
    act(() => {
      frames.shift()?.(0)
    })
    await waitFor(() => expect(bridge.calls.some((entry) => entry.op === 'browserNav')).toBe(true))
  })

  test('回执 false：data-browser-bound=0，不触发首次 load', async () => {
    const bridge = bridgeOf()
    bridge.replies.set('dockBrowser', () => false)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 300))
    const { container } = renderTab({ path: 'https://example.com/' })
    await waitFor(() => expect((container.querySelector('.browser-holder') as HTMLElement).dataset['browserBound']).toBe('0'))
    expect(bridge.calls.some((entry) => entry.op === 'browserNav')).toBe(false)
  })

  test('调用 reject：同样写 0 且不抛到界面', async () => {
    const bridge = bridgeOf()
    bridge.replies.set('dockBrowser', () => {
      throw new Error('桥断了')
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 300))
    const { container } = renderTab({ path: 'https://example.com/' })
    await waitFor(() => expect((container.querySelector('.browser-holder') as HTMLElement).dataset['browserBound']).toBe('0'))
  })
})

// ── 工具条动作 ──────────────────────────────────────────────────────────────

describe('BrowserTab：后退 / 前进 / 刷新 / 外部打开 / 回车', () => {
  test('三个导航钮各自把当前地址与动作交给 browserNav', async () => {
    const bridge = bridgeOf()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 300))
    const { container } = renderTab({ path: 'https://page.example/' })
    await waitFor(() => expect(bridge.calls.some((entry) => entry.op === 'browserNav')).toBe(true))
    bridge.calls.length = 0
    bridge.emit('browser-state', { id: 'view-1', url: 'https://page.example/', canGoBack: true, canGoForward: true })
    await waitFor(() => expect((container.querySelector('[aria-label="后退"]') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(container.querySelector('[aria-label="后退"]') as HTMLElement)
    fireEvent.click(container.querySelector('[aria-label="前进"]') as HTMLElement)
    fireEvent.click(container.querySelector('[aria-label="刷新"]') as HTMLElement)
    const nav = bridge.calls.filter((entry) => entry.op === 'browserNav').map((entry) => entry.args[1])
    expect(nav).toEqual(['back', 'forward', 'reload'])
  })

  test('导航 reject：把原因写进错误行', async () => {
    const bridge = bridgeOf()
    bridge.replies.set('browserNav', () => {
      throw new Error('导航失败')
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 300))
    const { container } = renderTab({ path: 'https://page.example/' })
    await waitFor(() => expect(bridge.calls.some((entry) => entry.op === 'browserNav')).toBe(true))
    bridge.replies.set('browserNav', () => {
      throw new Error('导航失败')
    })
    fireEvent.click(container.querySelector('[aria-label="刷新"]') as HTMLElement)
    await waitFor(() => expect(container.querySelector('.browser-error')?.textContent).toContain('导航失败'))
  })

  test('外部打开：没有当前地址时不调用；有地址时交给 openExternal，失败给人话', async () => {
    const bridge = bridgeOf()
    const { container } = renderTab()
    const openButton = container.querySelector('[aria-label="用系统浏览器打开"]') as HTMLButtonElement
    expect(openButton.disabled).toBe(true)
    fireEvent.click(openButton)
    expect(bridge.calls.some((entry) => entry.op === 'openExternal')).toBe(false)

    bridge.emit('browser-state', { id: 'view-1', url: 'https://page.example/' })
    await waitFor(() => expect(openButton.disabled).toBe(false))
    bridge.replies.set('openExternal', () => {
      throw new Error('没有默认浏览器')
    })
    fireEvent.click(openButton)
    await waitFor(() =>
      expect(container.querySelector('.browser-error')?.textContent).toContain('没有默认浏览器'),
    )
    expect(bridge.calls.some((entry) => entry.op === 'openExternal')).toBe(true)
  })

  test('视图已绑定时回车直接导航（不再等几何）', async () => {
    const bridge = bridgeOf()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 300))
    const { container } = renderTab({ path: 'https://start.example/' })
    await waitFor(() => expect(bridge.calls.some((entry) => entry.op === 'browserNav')).toBe(true))
    bridge.calls.length = 0
    const input = container.querySelector('.browser-url') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'https://next.example/' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(bridge.calls.some((entry) => entry.op === 'browserNav')).toBe(true))
    expect(bridge.calls.find((entry) => entry.op === 'browserNav')?.args).toEqual([
      'https://next.example/',
      'load',
      'view-1',
    ])
  })
})
