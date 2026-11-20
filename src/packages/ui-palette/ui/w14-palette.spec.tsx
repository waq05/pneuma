/**
 * `ui-palette` 的补盲：键位表的两个入口、滚轮折算、以及面板里几处「别把点击/滚轮漏给遮罩」
 * 的守卫。
 *
 * 缺口逐条：
 *   - `ui.tsx:118-119`：`shell.shortcuts.open` 窗口事件单独叫出键位表（不经过命令面板）；
 *   - `206`：键位表遮罩点击关闭；`365`：键位表内部点击不下传给遮罩；
 *   - `227` / `356`：两处遮罩上的滚轮折算到列表；`407-410`：折算函数自身的三条出口
 *     （列表不在、指针本来就在列表里、内容没溢出——第 407 行的「列表不在」在渲染后
 *     拿不到，属不可测）；
 *   - `236`：命令面板内部点击不下传给遮罩（否则点输入框面板就关了）；
 *   - `270`：Tab 被拦下（焦点只有一个输入框，不许跑出面板）；
 *   - `299`：鼠标移到某一行就把它设为高亮；
 *   - `316-317`：底栏「全部快捷键」链接切到键位表。
 *
 * 装载方式沿用同目录 `palette.spec.tsx`：照壳收下 `shell.header` 的登记，套
 * RuntimeProvider 与假服务表（动作表用 `actions` 服务提供）。
 *
 * @module dsc-ui-palette/ui/w14-palette
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { ServiceRegistry, ServicesProvider } from '@dsc/ui-core'
import type { ActionsHandle, HostSnapshot, UiAction, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** PalettePanel 不直接导出：照壳装载插件那条路，收下 `shell.header` 的登记。 */
function palettePanel(): ComponentType {
  const registered: Array<{ slot: string; id: string; component: unknown }> = []
  const fakeUi = {
    slots: {
      register: (slot: string, options: { id?: string }, component: unknown): void => {
        registered.push({ slot, id: options.id ?? '', component })
      },
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
      seat: (): undefined => undefined,
    },
    provide: (): void => undefined,
    consume(): undefined {
      return undefined
    },
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  const found = registered.find((item) => item.slot === 'shell.header' && item.id === 'palette.panel')
  if (found === undefined) throw new Error('palette 插件没有把面板登记进 shell.header')
  return found.component as ComponentType
}

const PalettePanel = palettePanel()

function actionsHandle(actions: readonly UiAction[]): ActionsHandle {
  return {
    register: () => () => undefined,
    list: () => actions,
    subscribe: () => () => undefined,
  }
}

const action = (over: Partial<UiAction> & { id: string; label: string }): UiAction => ({
  run: () => undefined,
  ...over,
})

interface Harness {
  channel: HostChannel
  runs: string[]
  registry: ServiceRegistry
}

function harnessOf(actions: readonly UiAction[]): Harness {
  const runs: string[] = []
  const snapshot = {
    sessions: [],
    status: { cwd: 'C:/repo', turnState: 'idle' },
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
    invoke: (<T,>(): Promise<T> => Promise.resolve({ ok: true } as T)) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  const wrapped = actions.map((item) => ({
    ...item,
    run: () => {
      runs.push(item.id)
      item.run()
    },
  }))
  const registry = new ServiceRegistry()
  registry.provide<ActionsHandle>('actions', actionsHandle(wrapped), 'w14')
  return { channel, runs, registry }
}

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <ServicesProvider services={harness.registry}>
        <PalettePanel />
      </ServicesProvider>
    </RuntimeProvider>,
  )

const openPalette = (): void => {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
}

const openShortcuts = (): void => {
  act(() => {
    window.dispatchEvent(new Event('shell.shortcuts.open'))
  })
}

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('键位表的入口与守卫', () => {
  test('shell.shortcuts.open 单独叫出键位表；遮罩点击关闭，内部点击不关', () => {
    const harness = harnessOf([action({ id: 'a.one', label: '动作一' })])
    mount(harness)

    openShortcuts()
    const sheet = document.querySelector('.shortcut-sheet') as HTMLElement
    expect(sheet).not.toBeNull()
    // 键位表自己也是 `.palette`（同一种浮层几何），用搜索框区分命令面板在不在。
    expect(document.querySelector('.palette-search')).toBeNull()

    // 面板内部（标题行 / 表格）点一下：stopPropagation，遮罩的关闭不该被触发。
    fireEvent.mouseDown(sheet)
    expect(document.querySelector('.shortcut-sheet')).not.toBeNull()
    // 键位表的遮罩滚轮也折算给列表（这一处原来一动不动）。
    fireEvent.wheel(document.querySelector('.palette-mask') as HTMLElement, { deltaY: 40 })
    expect(document.querySelector('.shortcut-sheet')).not.toBeNull()

    fireEvent.mouseDown(document.querySelector('.palette-mask') as HTMLElement)
    expect(document.querySelector('.shortcut-sheet')).toBeNull()
  })

  test('底栏「全部快捷键」：关掉命令面板，换成键位表', () => {
    const harness = harnessOf([action({ id: 'a.one', label: '动作一' })])
    mount(harness)
    openPalette()
    const link = document.querySelector('.palette-foot-link') as HTMLButtonElement
    expect(link).not.toBeNull()
    fireEvent.click(link)
    expect(document.querySelector('.palette-search')).toBeNull()
    expect(document.querySelector('.shortcut-sheet')).not.toBeNull()
  })
})

describe('命令面板里的守卫', () => {
  test('内部点击不下传遮罩（点输入框不会把面板关掉）；Tab 被拦下', () => {
    const harness = harnessOf([action({ id: 'a.one', label: '动作一' })])
    mount(harness)
    openPalette()
    const input = document.querySelector('.palette-search input') as HTMLInputElement
    fireEvent.mouseDown(document.querySelector('.palette') as HTMLElement)
    expect(document.querySelector('.palette-search')).not.toBeNull()

    fireEvent.keyDown(input, { key: 'Tab' })
    expect(document.querySelector('.palette-search')).not.toBeNull()
  })

  test('鼠标移到某一行就把它设为高亮，行内显示分组标题', () => {
    const harness = harnessOf([
      action({ id: 'a.settings', label: '打开设置', group: '设置' }),
      action({ id: 'a.new', label: '新建会话', group: '会话' }),
    ])
    mount(harness)
    openPalette()
    const rows = [...document.querySelectorAll('.palette-row')] as HTMLElement[]
    expect(rows).toHaveLength(2)
    fireEvent.mouseEnter(rows[1] as HTMLElement)
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true')
    expect(rows[0]?.getAttribute('aria-selected')).toBe('false')
  })
})

describe('滚轮折算', () => {
  test('指针在面板外（遮罩上）时把滚轮补进列表；指针已在列表内时不动', () => {
    const harness = harnessOf([action({ id: 'a.one', label: '动作一' }), action({ id: 'a.two', label: '动作二' })])
    mount(harness)
    openPalette()
    const list = document.querySelector('.palette-list') as HTMLElement
    // jsdom 没有排版：给列表一个「内容比可视区高」的假盒子，才能走到真正滚那一步。
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 400 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 120 })

    fireEvent.wheel(document.querySelector('.palette-mask') as HTMLElement, { deltaY: 60 })
    expect(list.scrollTop).toBe(60)

    // 指针本来就在列表里：交给浏览器原生滚动，自己不再加一份。
    fireEvent.wheel(list, { deltaY: 50 })
    expect(list.scrollTop).toBe(60)
  })
})
