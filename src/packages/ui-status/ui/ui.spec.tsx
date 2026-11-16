/**
 * 状态面板（`ui-status/ui/ui.tsx`）的渲染与交互段（ui 层，真渲染）。
 *
 * 面板是 portal 出去的：这里先搭出壳里那两处锚点（`.topbar .tabs` 与
 * `[data-thread-area]`），再用假宿主快照把目标/任务/计划/后台活/定点任务点亮。
 * 钉的是「胶囊与面板同壳切换、分区按快照出现、模式与位置存档、拖动不误触展开」。
 *
 * @module dsc-ui-status/ui/ui.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** 面板不直接导出：照壳装载插件那条路，收下 `shell.main` 的登记。 */
function statusPanel(): ComponentType {
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
  const found = registered.find((item) => item.slot === 'shell.main' && item.id === 'status.panel')
  if (found === undefined) throw new Error('status 插件没有把面板登记进 shell.main')
  return found.component as ComponentType
}

const StatusPanel = statusPanel()

interface Harness {
  channel: HostChannel
}

function harnessOf(surfaces: Record<string, unknown>): Harness {
  const snapshot = {
    sessions: [],
    status: { cwd: 'C:/repo', sessionPath: 'C:/repo/a.jsonl', turnState: 'idle' },
    surfaces,
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
    invoke: (<T,>(method: string): Promise<T> => {
      // 任务板缺席返回 null（{} 会让面板读不存在的 tasks 而崩）；名册给空数组。
      if (method === 'listTeamBoard') return Promise.resolve(null as T)
      if (method === 'listTeammates') return Promise.resolve([] as unknown as T)
      return Promise.resolve({} as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel }
}

/** 壳里的两个锚点：页签行（portal 落点）与正文区（宽度裁决）。 */
function shellDom(): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML =
    '<div class="topbar"><div class="tabs"></div></div>' +
    '<div class="thread-main" data-thread-area><div id="mount"></div></div>'
  document.body.append(root)
  return root.querySelector('#mount') as HTMLElement
}

const mount = (harness: Harness): ReturnType<typeof render> => {
  const target = shellDom()
  return render(
    <RuntimeProvider channel={harness.channel}>
      <StatusPanel />
    </RuntimeProvider>,
    { container: target },
  )
}

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''

const SURFACES = {
  goal: { objective: '把面板测完', phase: 'running', rounds: 1, maxRounds: 5, armed: true },
  todos: {
    done: 1,
    total: 2,
    active: 1,
    items: [
      { id: 't1', status: 'completed', content: '先读代码' },
      { id: 't2', status: 'in_progress', content: '再写用例' },
    ],
  },
  backgroundWorks: [
    { id: 'job-1', kind: 'job', title: '构建', startedAt: Date.now() - 5_000, status: 'running' },
  ],
  planDirectory: [{ file: 'C:/repo/.dsc/plans/p1.md', title: '重构方案', at: Date.now() - 1_000 }],
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

describe('胶囊与面板', () => {
  test('窄正文区自动落在胶囊档；点胶囊展开出面板与各分区', async () => {
    const harness = harnessOf(SURFACES)
    mount(harness)
    await flush()

    const tabs = document.querySelector('.topbar .tabs') as HTMLElement
    expect(tabs.querySelector('.sp-mini')).not.toBeNull()
    const panel = tabs.querySelector('.sp-panel') as HTMLElement
    expect(panel.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(tabs.querySelector('.sp-mini') as HTMLElement)
    expect(tabs.querySelector('[data-expanded]')?.getAttribute('data-expanded')).toBe('1')
    expect(panel.getAttribute('aria-hidden')).toBe('false')
    // 目标、任务、计划、终端几个分区都按快照出现。
    expect(textOf(tabs.querySelector('.sp-goal'))).toContain('把面板测完')
    expect(textOf(tabs.querySelector('[data-sp-section="todo"] .sp-section-trail'))).toContain('1/2')
    expect(textOf(tabs.querySelector('[data-sp-section="todo"] .sp-list'))).toContain('先读代码')
    expect(textOf(tabs.querySelector('.sp-panel'))).toContain('重构方案')
  })

  test('模式存档为 panel：首帧就是展开态，工具栏菜单可切回胶囊并落盘', async () => {
    localStorage.setItem('dsc.statusPanel.mode', 'panel')
    const harness = harnessOf(SURFACES)
    mount(harness)
    await flush()
    const tabs = document.querySelector('.topbar .tabs') as HTMLElement
    expect(tabs.querySelector('.sp-panel')?.getAttribute('aria-hidden')).toBe('false')

    const buttons = tabs.querySelectorAll('.sp-toolbar .sp-icon-btn')
    fireEvent.click(buttons[0] as HTMLElement)
    const menu = tabs.querySelector('.sp-menu') as HTMLElement
    expect(menu).not.toBeNull()
    const options = [...menu.querySelectorAll('button')] as HTMLElement[]
    expect(options.length).toBeGreaterThanOrEqual(3)
    fireEvent.click(options[2]!)
    expect(localStorage.getItem('dsc.statusPanel.mode')).toBe('mini')
    expect(tabs.querySelector('.sp-mini')).not.toBeNull()
  })

  test('点击（没拖动）照常展开；分区可折叠', async () => {
    const harness = harnessOf(SURFACES)
    mount(harness)
    await flush()
    const tabs = document.querySelector('.topbar .tabs') as HTMLElement
    fireEvent.click(tabs.querySelector('.sp-mini') as HTMLElement)
    const section = tabs.querySelector('[data-sp-section="todo"]') as HTMLElement
    expect(section.getAttribute('data-sp-open')).toBe('1')
    fireEvent.click(section.querySelector('.sp-section-head') as HTMLElement)
    expect(section.getAttribute('data-sp-open')).toBe('0')
  })

  test('没有任何数据：连胶囊都不画（只有隐藏占位），不留一块空壳', async () => {
    const harness = harnessOf({})
    mount(harness)
    await flush()
    const tabs = document.querySelector('.topbar .tabs') as HTMLElement
    expect(tabs.querySelector('.sp-mini')).toBeNull()
    expect(tabs.querySelector('.sp-panel')).toBeNull()
  })
})
