/**
 * 终端页签（`ui-terminal/ui/ui.tsx`）的渲染与交互段（ui 层，真渲染）。
 *
 * xterm 与 fit addon 用同一形状的替身（`Terminal` 记账写入、`onData` 留下回调），
 * 原生桥用 `globalThis.dscNative` 假对象。钉的是：桥缺席时的人话、首次可见才 spawn、
 * 本地行编辑（回显 / 退格 / Ctrl+C / 回车整行下发）、dock-data 只认自己的会话 id、
 * 切 Shell 落盘并杀旧起新、启动失败的错误人话、卸载杀会话。
 *
 * @module dsc-ui-terminal/ui/terminal.spec
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
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

afterAll(() => {
  offPlugin()
})

interface NativeCall {
  op: string
  payload: unknown
}

interface NativeHarness {
  calls: NativeCall[]
  emit(event: string, data: unknown): void
}

/** 假原生桥：term-spawn 按用例给的应答走，其余回 { ok: true }。 */
function installNative(options: { spawn?: (payload: unknown) => Promise<unknown> } = {}): NativeHarness {
  const calls: NativeCall[] = []
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (channel: string, args: unknown[] = []): Promise<unknown> => {
      // 终端走 `native.invoke('terminal', [op, payload])` 这一层：op 在第二个参数里。
      const op = channel === 'terminal' ? String(args[0]) : channel
      const payload = channel === 'terminal' ? args[1] : args[0]
      calls.push({ op, payload })
      if (op === 'term-spawn') {
        return options.spawn === undefined ? Promise.resolve({ id: 'session-1' }) : options.spawn(payload)
      }
      return Promise.resolve({ ok: true })
    },
    on: (event: string, listener: (data: unknown) => void): (() => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => {
        set.delete(listener)
      }
    },
  }
  return {
    calls,
    emit(event: string, data: unknown): void {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(data)
    },
  }
}

function channelOf(cwd = 'C:/repo'): HostChannel {
  const snapshot = {
    sessions: [],
    status: { cwd, turnState: 'idle' },
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

const body = (active: boolean) => (
  <RuntimeProvider channel={channelOf()}>
    <TerminalTab tab={{ id: 'tab-1', kind: 'terminal' }} active={active} expanded />
  </RuntimeProvider>
)

const mount = (active: boolean): ReturnType<typeof render> => render(body(active))

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''
const termOf = (): FakeTerminalShape => xterm.instances[xterm.instances.length - 1] as FakeTerminalShape
const opsOf = (harness: NativeHarness, op: string): NativeCall[] =>
  harness.calls.filter((call) => call.op === op)

beforeEach(() => {
  localStorage.clear()
  xterm.instances.length = 0
  xterm.fit.calls = 0
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  // Select 浮层会调 scrollIntoView；jsdom 没有。
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (globalThis as { dscNative?: unknown }).dscNative
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  vi.restoreAllMocks()
})

describe('挂载与起进程', () => {
  test('原生桥缺席：只给一句人话，不创建终端也不 spawn', () => {
    const { container } = mount(true)
    expect(textOf(container.querySelector('.shell-term-empty'))).toContain('桌面版')
    expect(textOf(container.querySelector('.shell-term-empty'))).toContain('numa')
    expect(xterm.instances).toHaveLength(0)
  })

  test('首挂不可见不起进程；首次可见才按 cwd + 默认 shell spawn', async () => {
    const native = installNative()
    const view = mount(false)
    await flush()
    expect(opsOf(native, 'term-spawn')).toHaveLength(0)

    view.rerender(body(true))
    await flush()
    const spawn = opsOf(native, 'term-spawn')
    expect(spawn).toHaveLength(1)
    expect(spawn[0]?.payload).toEqual({ cwd: 'C:/repo', shell: 'powershell' })
    // 横幅与提示符都写进了终端。
    expect(termOf().writes.join('')).toContain('PowerShell · 管道模式')
    expect(termOf().writes.join('')).toContain('PS>')
  })

  test('本地行编辑：回显、退格、Ctrl+C、回车整行下发', async () => {
    const native = installNative()
    mount(true)
    await flush()
    const term = termOf()

    act(() => {
      term.dataHandler?.('ls')
    })
    expect(term.writes).toContain('l')
    expect(term.writes).toContain('s')

    act(() => {
      term.dataHandler?.('\u007f')
    })
    expect(term.writes).toContain('\b \b')

    act(() => {
      term.dataHandler?.('\r')
    })
    expect(term.writes).toContain('\r\n')
    expect(opsOf(native, 'term-input').at(-1)?.payload).toEqual({ id: 'session-1', data: 'l\n' })

    act(() => {
      term.dataHandler?.('xy\u0003')
    })
    expect(term.writes.join('')).toContain('^C')
  })

  test('宿主输出只认自己的会话 id；换行转 CRLF 并补提示符', async () => {
    const native = installNative()
    mount(true)
    await flush()
    const term = termOf()
    const before = term.writes.length

    native.emit('dock-data', { id: 'someone-else', data: '不该出现' })
    expect(term.writes).toHaveLength(before)

    native.emit('dock-data', { id: 'session-1', data: 'hello\nworld' })
    const joined = term.writes.join('')
    expect(joined).toContain('hello\r\nworld')
    expect(joined).not.toContain('不该出现')
    // 输出落定后补提示符（管道模式不回显命令）。
    expect(term.writes.length).toBeGreaterThan(before)
    expect(joined).toContain('PS>')
  })
})

describe('Shell 选择与卸载', () => {
  test('切 Shell：落盘 localStorage，杀旧会话并按新 shell 重起', async () => {
    let index = 0
    const native = installNative({
      spawn: () => {
        index += 1
        return Promise.resolve({ id: `session-${String(index)}` })
      },
    })
    mount(true)
    await flush()
    expect(opsOf(native, 'term-spawn')).toHaveLength(1)

    fireEvent.click(document.querySelector('.select-trigger') as HTMLElement)
    const options = [...document.querySelectorAll('.select-opt')] as HTMLElement[]
    const bash = options.find((option) => textOf(option).includes('Git Bash')) as HTMLElement
    fireEvent.click(bash)
    await flush()

    expect(localStorage.getItem('dsc.dockShell')).toBe('bash')
    expect(opsOf(native, 'term-kill').at(-1)?.payload).toEqual({ id: 'session-1' })
    expect(opsOf(native, 'term-spawn').at(-1)?.payload).toEqual({ cwd: 'C:/repo', shell: 'bash' })
  })

  test('localStorage 记住的 shell 是下次的默认值', async () => {
    localStorage.setItem('dsc.dockShell', 'cmd')
    const native = installNative()
    const { container } = mount(true)
    await flush()

    expect(textOf(container.querySelector('.select-value'))).toBe('CMD')
    expect(opsOf(native, 'term-spawn')[0]?.payload).toEqual({ cwd: 'C:/repo', shell: 'cmd' })
  })

  test('卸载：杀掉会话并释放终端实例', async () => {
    const native = installNative()
    const view = mount(true)
    await flush()
    const term = termOf()

    view.unmount()
    expect(opsOf(native, 'term-kill').at(-1)?.payload).toEqual({ id: 'session-1' })
    expect(term.disposed).toBe(true)
  })
})
