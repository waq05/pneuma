/**
 * 命令面板（`ui-palette/ui/ui.tsx`）的渲染与交互段（ui 层，真渲染）。
 *
 * 面板经 `shell.header` 槽报名：这里照壳装载插件那条路把组件收下，套上 RuntimeProvider
 * 与假服务表（动作表用 `actions` 服务提供），再按真键盘事件驱动。钉的是：
 * Ctrl+K 开合与自动聚焦、按标签/说明/关键词过滤、↑↓/回车/Home/End 的选中、
 * 最近会话组的排序与截断、遮罩与关闭钮、`?` 键位表（含输入框里不触发）、
 * Shift+Ctrl+K 不抢旁问。
 *
 * @module dsc-ui-palette/ui/palette.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { ServiceRegistry, ServicesProvider } from '@dsc/ui-core'
import type { ActionsHandle, HostSnapshot, SessionSummary, UiAction, UiPluginApi } from '@dsc/ui'
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

interface Invoke {
  method: string
  args: unknown[]
}

interface Harness {
  channel: HostChannel
  calls: Invoke[]
  runs: string[]
  actions: readonly UiAction[]
  registry: ServiceRegistry
}

/** 动作表替身：list 稳定、subscribe 可订阅（面板只读）。 */
function actionsHandle(actions: readonly UiAction[]): ActionsHandle {
  const listeners = new Set<() => void>()
  return {
    register: () => () => undefined,
    list: () => actions,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const action = (over: Partial<UiAction> & { id: string; label: string }): UiAction => ({
  run: () => undefined,
  ...over,
})

function harnessOf(
  options: { actions?: readonly UiAction[]; sessions?: readonly SessionSummary[] } = {},
): Harness {
  const calls: Invoke[] = []
  const runs: string[] = []
  const snapshot = {
    sessions: options.sessions ?? [],
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
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      return Promise.resolve({ ok: true } as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  const actions = (options.actions ?? []).map((item) => ({
    ...item,
    run: () => {
      runs.push(item.id)
      item.run()
    },
  }))
  const registry = new ServiceRegistry()
  registry.provide<ActionsHandle>('actions', actionsHandle(actions), 'test')
  return { channel, calls, runs, actions, registry }
}

/** 面板不直接导出：套 RuntimeProvider（取快照）与服务表（取动作表）。 */
const mountWithActions = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <ServicesProvider services={harness.registry}>
        <PalettePanel />
      </ServicesProvider>
    </RuntimeProvider>,
  )

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 4; index += 1) await Promise.resolve()
  })

const openPalette = (): void => {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
}

const inputOf = (): HTMLInputElement =>
  document.querySelector('.palette-search input') as HTMLInputElement
const rowsOf = (): HTMLElement[] => [...document.querySelectorAll('.palette-row')] as HTMLElement[]
const textOf = (element: Element | null): string => element?.textContent ?? ''

beforeEach(() => {
  localStorage.clear()
  // 高亮滚进可视区：jsdom 没有 scrollIntoView。
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('打开与关闭', () => {
  test('Ctrl+K 打开、输入框自动聚焦；Esc 关闭', async () => {
    const harness = harnessOf({
      actions: [
        action({ id: 'a.settings', label: '打开设置', hint: '偏好设置', group: '设置', shortcut: 'Ctrl+,' }),
        action({ id: 'a.new', label: '新建会话', group: '设置' }),
      ],
    })
    mountWithActions(harness)
    expect(document.querySelector('.palette')).toBeNull()

    openPalette()
    const panel = document.querySelector('.palette') as HTMLElement
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-label')).toBe('命令面板')
    expect(document.activeElement).toBe(inputOf())
    expect(document.querySelector('.palette-list')?.getAttribute('role')).toBe('listbox')

    // 动作行：标签 / 说明 / 键位；组头只出现一次。
    expect(rowsOf()).toHaveLength(2)
    expect(textOf(rowsOf()[0])).toContain('打开设置')
    expect(textOf(rowsOf()[0])).toContain('偏好设置')
    expect(textOf(rowsOf()[0])).toContain('Ctrl+,')
    expect(document.querySelectorAll('.palette-group')).toHaveLength(1)
    expect(rowsOf()[0]?.getAttribute('aria-selected')).toBe('true')
    expect(rowsOf()[0]?.getAttribute('data-active')).toBe('1')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.palette')).toBeNull()
  })

  test('遮罩点击、关闭钮、外部事件都能关；Esc 之外不关', async () => {
    const harness = harnessOf({ actions: [action({ id: 'a.one', label: '动作一' })] })
    mountWithActions(harness)

    openPalette()
    fireEvent.mouseDown(document.querySelector('.palette-mask') as HTMLElement)
    expect(document.querySelector('.palette')).toBeNull()

    openPalette()
    fireEvent.click(document.querySelector('.palette-close') as HTMLElement)
    expect(document.querySelector('.palette')).toBeNull()

    // 别处发 OPEN_EVENT 也能打开（不需要 import 本插件）。
    act(() => {
      window.dispatchEvent(new Event('shell.palette.open'))
    })
    expect(document.querySelector('.palette')).not.toBeNull()
  })
})

describe('过滤与键盘选择', () => {
  test('按标签 / 说明 / 关键词过滤（不分大小写）；筛不到给人话', async () => {
    const harness = harnessOf({
      actions: [
        action({
          id: 'a.settings',
          label: '打开设置',
          hint: '偏好设置',
          keywords: ['preferences'],
        }),
        action({ id: 'a.new', label: '新建会话', hint: '从干净上下文开始' }),
      ],
    })
    mountWithActions(harness)
    openPalette()

    fireEvent.change(inputOf(), { target: { value: 'PREFERENCES' } })
    expect(rowsOf()).toHaveLength(1)
    expect(textOf(rowsOf()[0])).toContain('打开设置')

    // 命中的是说明（hint）。
    fireEvent.change(inputOf(), { target: { value: '干净' } })
    expect(rowsOf()).toHaveLength(1)
    expect(textOf(rowsOf()[0])).toContain('新建会话')

    fireEvent.change(inputOf(), { target: { value: '  zzz  ' } })
    expect(rowsOf()).toHaveLength(0)
    expect(textOf(document.querySelector('.palette-empty'))).toBe('没有匹配项')

    // 命中的是标签（大小写不敏感）。
    fireEvent.change(inputOf(), { target: { value: '新建' } })
    expect(rowsOf()).toHaveLength(1)
  })

  test('↑↓ 移动高亮、Home/End 到首尾，回车执行当前项并关闭', async () => {
    const harness = harnessOf({
      actions: [
        action({ id: 'a.one', label: '动作一' }),
        action({ id: 'a.two', label: '动作二' }),
        action({ id: 'a.three', label: '动作三' }),
      ],
    })
    mountWithActions(harness)
    openPalette()
    const input = inputOf()

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(rowsOf()[1]?.getAttribute('data-active')).toBe('1')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(rowsOf()[2]?.getAttribute('data-active')).toBe('1')
    // 到底后不再越界。
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(rowsOf()[2]?.getAttribute('data-active')).toBe('1')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(rowsOf()[1]?.getAttribute('data-active')).toBe('1')

    fireEvent.keyDown(input, { key: 'End' })
    expect(rowsOf()[2]?.getAttribute('data-active')).toBe('1')
    fireEvent.keyDown(input, { key: 'Home' })
    expect(rowsOf()[0]?.getAttribute('data-active')).toBe('1')
    // PageDown 至少能挪一行（jsdom 量不到高度时按一页一行算）。
    fireEvent.keyDown(input, { key: 'PageDown' })
    expect(rowsOf()[1]?.getAttribute('data-active')).toBe('1')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(harness.runs).toEqual(['a.two'])
    expect(document.querySelector('.palette')).toBeNull()
  })

  test('最近会话：按更新时间倒序、归档的不进、标题缺省给「新会话」；点一行开会话', async () => {
    const sessions: SessionSummary[] = [
      { id: 'C:/s/old.jsonl', cwd: 'C:/repo', createdAt: 1, updatedAt: 10, title: '旧会话' },
      { id: 'C:/s/archived.jsonl', cwd: 'C:/repo', createdAt: 1, updatedAt: 99, title: '归档会话', archivedAt: 5 },
      { id: 'C:/s/fresh.jsonl', cwd: 'C:/repo', createdAt: 1, updatedAt: 30 },
      { id: 'C:/s/mid.jsonl', cwd: 'C:/repo', createdAt: 1, updatedAt: 20, title: '中间会话' },
    ]
    const harness = harnessOf({
      actions: [action({ id: 'a.one', label: '动作一' })],
      sessions,
    })
    mountWithActions(harness)
    openPalette()

    const labels = rowsOf().map((row) => textOf(row.querySelector('.palette-label')))
    expect(labels).toEqual(['动作一', '新会话', '中间会话', '旧会话'])
    expect(labels).not.toContain('归档会话')
    // 会话组单独起一个组头。
    const groups = [...document.querySelectorAll('.palette-group')].map(textOf)
    expect(groups).toEqual(['动作', '最近会话'])

    const target = rowsOf().find((row) => textOf(row).includes('中间会话')) as HTMLElement
    fireEvent.click(target)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'openSession', args: ['C:/s/mid.jsonl'] })
    expect(harness.calls).toContainEqual({ method: 'refreshSessions', args: [] })
    expect(document.querySelector('.palette')).toBeNull()
  })
})

describe('键位表', () => {
  test('? 打开键位表；输入框里的 ? 不触发；Shift+Ctrl+K 不抢旁问', async () => {
    const harness = harnessOf({ actions: [action({ id: 'a.one', label: '动作一' })] })
    mountWithActions(harness)

    fireEvent.keyDown(document.body, { key: '?' })
    expect(document.querySelector('.shortcut-sheet')).not.toBeNull()
    expect(document.querySelectorAll('.shortcut-row')).toHaveLength(10)
    expect(textOf(document.querySelector('.shortcut-sheet'))).toContain('Ctrl K')
    expect(textOf(document.querySelector('.shortcut-sheet'))).toContain('命令面板')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.shortcut-sheet')).toBeNull()

    // 输入框里打问号是文字，不该弹键位表。
    openPalette()
    fireEvent.keyDown(inputOf(), { key: '?' })
    expect(document.querySelector('.shortcut-sheet')).toBeNull()
    expect(document.querySelector('.palette')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })

    // 带 Shift 的 Ctrl+K 归旁问，面板不该一起弹。
    fireEvent.keyDown(window, { key: 'K', ctrlKey: true, shiftKey: true })
    expect(document.querySelector('.palette')).toBeNull()
    expect(document.querySelector('.shortcut-sheet')).toBeNull()
  })
})
