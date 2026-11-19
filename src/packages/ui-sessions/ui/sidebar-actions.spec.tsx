/**
 * 侧栏会话列表的操作面（ui 层，真渲染）：新建/打开、搜索、改名、归档、视图选项与失败提示。
 *
 * 沿用 `unsaved-row.spec.tsx` 的假宿主：槽位登记取组件、RuntimeProvider 给通道、
 * `dscNative` 走原生桥。行内菜单/拖拽的细枝末节归源码探针，这里钉「点了之后发什么请求」。
 *
 * @module dsc-ui-sessions/ui/sidebar-actions.spec
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, setShellPage, shellPage, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, SessionSummary, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** SessionList 不直接导出：照生产壳装载插件那条路，收下 `shell.sidebar` 的登记。 */
function listComponent(): ComponentType {
  const registered: Array<{ slot: string; component: unknown }> = []
  const fakeUi = {
    slots: {
      register: (slot: string, _options: unknown, component: unknown): void => {
        registered.push({ slot, component })
      },
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
    },
    provide: (): void => undefined,
    consume: (): undefined => undefined,
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  const found = registered.find((item) => item.slot === 'shell.sidebar')
  if (found === undefined) throw new Error('sessions 插件没有把列表登记进 shell.sidebar')
  return found.component as ComponentType
}

const SessionList = listComponent()

const SESSIONS: SessionSummary[] = [
  { id: 'D:/demo/a.jsonl', cwd: 'D:/demo', createdAt: 1, updatedAt: 30, title: '甲会话' },
  { id: 'D:/demo/b.jsonl', cwd: 'D:/demo', createdAt: 2, updatedAt: 20, title: '乙会话' },
  { id: 'D:/other/c.jsonl', cwd: 'D:/other', createdAt: 3, updatedAt: 10, title: '丙会话' },
]

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
}

function harnessOf(overrides: { sessions?: SessionSummary[]; refreshError?: Error } = {}): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const snapshot = {
    sessions: overrides.sessions ?? SESSIONS,
    status: { cwd: 'D:/demo', sessionPath: 'D:/demo/a.jsonl', turnState: 'idle' },
  } as unknown as HostSnapshot
  const replies: Record<string, unknown> = {
    refreshSessions: {},
    getUiPrefs: { sessionGroup: 'workspace', sessionSort: 'manual', archivedFilter: 'hide', sessionExpansion: {} },
    openSession: {},
    renameSession: { ok: true, notice: '改好了' },
    archiveSessions: { ok: true, notice: '已归档' },
    setSessionPinned: { ok: true },
    setUiPrefs: { ok: true },
  }
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
      if (method === 'refreshSessions' && overrides.refreshError !== undefined) return Promise.reject(overrides.refreshError)
      return Promise.resolve(replies[method] ?? { ok: true }) as Promise<T>
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (): Promise<unknown> => Promise.resolve([]),
    on: () => () => undefined,
  }
  return { channel, calls }
}

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <SessionList />
    </RuntimeProvider>,
  )

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

const rows = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll('.sess-item')] as HTMLElement[]
const rowWhere = (container: HTMLElement, text: string): HTMLElement => {
  const found = rows(container).find((row) => row.textContent?.includes(text))
  if (found === undefined) throw new Error(`没有会话行：${text}`)
  return found
}
const textOf = (element: Element | null): string => element?.textContent ?? ''

beforeEach(() => {
  setShellPage(null)
})

afterEach(() => {
  cleanup()
  setShellPage(null)
  delete (globalThis as { dscNative?: unknown }).dscNative
})

describe('新建、打开与入口', () => {
  test('新会话按钮：openSession 不带 id，再重扫清单', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelector('.btn-new') as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'openSession', args: [] })
    expect(harness.calls.filter((call) => call.method === 'refreshSessions').length).toBeGreaterThanOrEqual(2)
  })

  test('点一行会话：带上它的 id 打开；当前行有 active 标记', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    expect(rowWhere(container, '甲会话').className).toContain('active')
    fireEvent.click(rowWhere(container, '乙会话'))
    await flush()
    expect(harness.calls).toContainEqual({ method: 'openSession', args: ['D:/demo/b.jsonl'] })
  })

  test('技能/插件入口切整页，再点一次回对话页', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const nav = [...container.querySelectorAll('.sidebar-nav .nav-item')] as HTMLElement[]
    expect(nav.length).toBeGreaterThanOrEqual(1)
    fireEvent.click(nav[0]!)
    expect(shellPage()).toBe('skills')
    fireEvent.click(nav[0]!)
    expect(shellPage()).toBeNull()

    const plugins = nav.find((item) => textOf(item).includes('插件'))
    if (plugins !== undefined) {
      fireEvent.click(plugins)
      expect(shellPage()).toBe('plugins')
      fireEvent.click(plugins)
      expect(shellPage()).toBeNull()
    }
  })
})

describe('搜索与视图选项', () => {
  test('搜索按标题过滤；Escape 关掉搜索并恢复全量', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    // 工作区档：只默认展开当前会话所在的那一组，另一组收着。
    expect(rows(container)).toHaveLength(2)

    const searchButton = container.querySelectorAll('.head-actions .icon-btn')[0] as HTMLElement
    fireEvent.click(searchButton)
    const input = container.querySelector('.side-search input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '丙' } })
    expect(rows(container)).toHaveLength(1)
    expect(textOf(rows(container)[0])).toContain('丙会话')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(container.querySelector('.side-search')).toBeNull()
    // 搜索时全组展开；关掉搜索后回到默认展开态。
    expect(rows(container)).toHaveLength(2)
  })

  test('视图菜单：切平铺/只显示归档都写回界面偏好', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const sortButton = container.querySelectorAll('.head-actions .icon-btn')[1] as HTMLElement
    fireEvent.click(sortButton)
    const menu = container.querySelector('.view-menu') as HTMLElement
    expect(menu).not.toBeNull()
    const picks = [...menu.querySelectorAll('button')] as HTMLElement[]
    // 分组 3 项（工作区/树/平铺）、排序 3 项、筛选 3 项。
    expect(picks).toHaveLength(9)
    fireEvent.click(picks[2]!)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setUiPrefs', args: [{ sessionGroup: 'flat' }] })

    fireEvent.click(picks[8]!)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setUiPrefs', args: [{ archivedFilter: 'only' }] })
  })
})

describe('行级动作', () => {
  test('Ctrl+Alt+R 亮出改名框，回车把新名字交给宿主', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const row = rowWhere(container, '乙会话')
    fireEvent.keyDown(row, { key: 'r', ctrlKey: true, altKey: true })
    const input = row.querySelector('.row-rename') as HTMLInputElement
    expect(input).not.toBeNull()
    fireEvent.change(input, { target: { value: '新名字' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(harness.calls).toContainEqual({ method: 'renameSession', args: ['D:/demo/b.jsonl', '新名字'] })
  })

  test('Ctrl+Shift+A 直接归档（不弹确认框），并重扫清单', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    fireEvent.keyDown(rowWhere(container, '乙会话'), { key: 'a', ctrlKey: true, shiftKey: true })
    await flush()
    expect(harness.calls).toContainEqual({ method: 'archiveSessions', args: [['D:/demo/b.jsonl']] })
    expect(harness.calls.filter((call) => call.method === 'refreshSessions').length).toBeGreaterThanOrEqual(2)
  })
})

describe('空态与失败', () => {
  test('没有会话：给空态提示而不是白板', async () => {
    const harness = harnessOf({ sessions: [] })
    const { container } = mount(harness)
    await flush()
    expect(container.querySelector('.sidebar-empty')).not.toBeNull()
    expect(textOf(container.querySelector('.sidebar-empty'))).not.toBe('')
  })

  test('重扫失败：把原因写在侧栏里', async () => {
    const harness = harnessOf({ refreshError: new Error('会话目录读不出来') })
    const { container } = mount(harness)
    await flush()
    const empty = container.querySelector('.sidebar-empty')
    expect(empty).not.toBeNull()
    expect(textOf(empty)).toContain('会话目录读不出来')
  })
})
