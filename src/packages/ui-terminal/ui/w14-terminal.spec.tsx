/**
 * `ui-terminal` 的补盲：面板尺寸变化时重排（`ResizeObserver` 回调里 fit 成功那一支）。
 *
 * 另外钉住 251-254（`term-spawn` 失败的回执）与它背后的一个真 bug：`native` 原来是每次渲染
 * 都新建（`getHostNative()` 每次返回新对象），而它在「起 shell」effect 的依赖里；失败分支又
 * 轮流 `setError('')` / `setError(failure)`，几秒内就重试到写出 160 万字符横幅。产品侧已改用
 * 缓存形态的 `useHostNative()`，这里用「spawn 失败 + 父级重渲染」断言只起一次、只报一次。
 *
 * 替身形状照同目录 `terminal.spec.tsx`（xterm / fit addon / `dscNative` 都是假对象）。
 *
 * @module dsc-ui-terminal/ui/w14-terminal
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { dockTabMeta, type DockTabBodyProps } from '@dsc/ui-dockkit'
import type { HostSnapshot, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

interface FakeTerminalShape {
  writes: string[]
  dataHandler: ((data: string) => void) | null
  disposed: boolean
}

const xterm = vi.hoisted(() => {
  const instances: FakeTerminalShape[] = []
  const fit = { calls: 0 }
  class FakeTerminal implements FakeTerminalShape {
    writes: string[] = []
    dataHandler: ((data: string) => void) | null = null
    disposed = false
    constructor() {
      instances.push(this)
    }
    loadAddon(): void {}
    open(): void {}
    write(data: string): void {
      this.writes.push(data)
    }
    writeln(data: string): void {
      this.writes.push(data)
    }
    onData(handler: (data: string) => void): { dispose: () => void } {
      this.dataHandler = handler
      return {
        dispose: () => {
          this.dataHandler = null
        },
      }
    }
    dispose(): void {
      this.disposed = true
    }
  }
  return { instances, fit, FakeTerminal }
})

vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {
      xterm.fit.calls += 1
    }
  },
}))

/** 终端页签经 registerDockTab 报名；照壳装载那条路收下组件。 */
const offPlugin = plugin.apply({} as UiPluginApi) as () => void
const TerminalTab = dockTabMeta('terminal')?.component as unknown as ComponentType<DockTabBodyProps>

/** ResizeObserver 的假身：记下回调，用例自己触发「面板变宽了」。 */
const observers: Array<() => void> = []

afterAll(() => {
  offPlugin()
})

/** 假原生桥：spawn 一律成功，其余回 `{ ok: true }`。 */
function installNative(): void {
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (channel: string, args: unknown[] = []): Promise<unknown> => {
      const op = channel === 'terminal' ? String(args[0]) : channel
      if (op === 'term-spawn') return Promise.resolve({ id: 'session-1' })
      return Promise.resolve({ ok: true })
    },
    on: () => () => undefined,
  }
}

function channelOf(): HostChannel {
  const snapshot = {
    sessions: [],
    status: { cwd: 'C:/repo', turnState: 'idle' },
    surfaces: {},
  } as unknown as HostSnapshot
  return {
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
}

const mount = (): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={channelOf()}>
      <TerminalTab tab={{ id: 'tab-1', kind: 'terminal' }} active expanded />
    </RuntimeProvider>,
  )

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })

beforeEach(() => {
  localStorage.clear()
  xterm.instances.length = 0
  xterm.fit.calls = 0
  observers.length = 0
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    private readonly callback: () => void
    constructor(callback: () => void) {
      this.callback = callback
      observers.push(callback)
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (globalThis as { dscNative?: unknown }).dscNative
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  vi.restoreAllMocks()
})

describe('面板尺寸变化', () => {
  test('ResizeObserver 回调里重排一次（fit 成功那支），不额外重建终端', async () => {
    installNative()
    mount()
    await flush()
    expect(xterm.instances).toHaveLength(1)
    expect(observers.length).toBeGreaterThan(0)
    const before = xterm.fit.calls
    act(() => {
      for (const callback of observers) callback()
    })
    // 起进程成功那次 fit 也算一次；这里只关心回调多出来的那一次。
    expect(xterm.fit.calls).toBe(before + 1)
    expect(xterm.instances).toHaveLength(1)
  })
})

describe('起 shell 失败', () => {
  test('只报一次错：native 引用稳定，父级重渲染不重试（251-254）', async () => {
    let spawnCalls = 0
    ;(globalThis as { dscNative?: unknown }).dscNative = {
      version: 1,
      call: (channel: string, args: unknown[] = []): Promise<unknown> => {
        const op = channel === 'terminal' ? String(args[0]) : channel
        if (op === 'term-spawn') {
          spawnCalls += 1
          return Promise.reject(new Error('pwsh 没装'))
        }
        return Promise.resolve({ ok: true })
      },
      on: () => () => undefined,
    }
    const view = mount()
    await flush()
    await flush()
    expect(spawnCalls).toBe(1)
    expect(xterm.instances).toHaveLength(1)
    expect(xterm.instances[0]?.writes.join('') ?? '').toContain('pwsh 没装')

    // 父级重渲染：`native` 若还是「每次新建」，这里会再起一次 shell（修复前的死循环起点）。
    view.rerender(
      <RuntimeProvider channel={channelOf()}>
        <TerminalTab tab={{ id: 'tab-1', kind: 'terminal' }} active expanded />
      </RuntimeProvider>,
    )
    await flush()
    expect(spawnCalls).toBe(1)
  })
})
