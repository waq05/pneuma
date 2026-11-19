/**
 * 「新会话那一行」与侧栏页脚的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-sessions-unsaved-row-test.mjs` 第 [3]–[5] 段与
 * `scripts/ui-sidebar-footer-test.mjs` 第 [2] 段（缺口清单 B37）。
 *
 * - [3] 临时行是只读回执：不弹右键菜单、不画图钉、不给归档钮、不给双击改名、不参与拖拽；
 * - [4] 点「新会话」时把所在工作区展开（写回 `sessionExpansion=true`）；
 * - [5] 点会话当场高亮（乐观值），点「新会话」那一拍撤掉旧高亮；
 * - 页脚：今日总用量读数、唯一一处文案、原生 title、60 秒兜底轮询、`days` 末位取今天。
 *
 * 不迁的（见交付报告缺口清单）：
 * - `ui-sessions-unsaved-row` 的契约 / 宿主补行 / 补刷守卫（第 [1][2] 段）是宿主侧源码文本；
 * - 第 [4] 段「删工作区跳过临时行」要过确认弹层，行为落在宿主归档回执上，归集成层；
 * - 页脚第 [3] 段的通道白名单（core/ui-methods.ts 与 remote/types.ts）与第 [4] 段产物审计
 *   （`lib/ui/plugins/sessions/client.js`）是静态配置 / 构建产物，归产物批；`formatTokens`
 *   真值表已在 `ui-primitives/ui/tokens.spec.ts`。
 *
 * @module dsc-ui-sessions/ui/unsaved-row.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, SessionSummary, UiPluginApi } from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import plugin from './ui.js'

/** SessionList 不直接导出：照生产壳装载插件那条路，收下 `shell.sidebar` 的登记。 */
function listComponent(): () => ReactNode {
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
  return found.component as () => ReactNode
}

const SessionList = listComponent()

interface Invoke {
  method: string
  args: unknown[]
}

/** 两条会话：一条真行、一条还没落盘的临时行。 */
const sessionsOf = (): SessionSummary[] => [
  { id: 'D:/demo/a.jsonl', cwd: 'D:/demo', createdAt: 1, updatedAt: 2, title: '真会话' },
  { id: 'D:/demo/b.jsonl', cwd: 'D:/demo', createdAt: 3, updatedAt: 4, title: '临时会话', unsaved: true },
]

interface Harness {
  channel: HostChannel
  calls: Invoke[]
}

/** 假宿主：快照 + 偏好 + 用量；所有 invoke 记账。 */
function harnessOf(prefs: Record<string, unknown> = {}): Harness {
  const calls: Invoke[] = []
  const snapshot = {
    sessions: sessionsOf(),
    status: { cwd: 'D:/demo', turnState: 'idle' },
  } as unknown as HostSnapshot
  const replies: Record<string, unknown> = {
    refreshSessions: {},
    openSession: { ok: true },
    setUiPrefs: { ok: true },
    usageStats: { days: [{ inputTokens: 9999, outputTokens: 0 }, { inputTokens: 100, outputTokens: 50, costCny: 0.25 }] },
    getUiPrefs: { sessionGroup: 'workspace', sessionSort: 'manual', archivedFilter: 'hide', ...prefs },
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
      return Promise.resolve(replies[method] ?? { ok: true }) as Promise<T>
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <SessionList />
    </RuntimeProvider>,
  )

/** 让挂载期的一串 promise 落地。 */
const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

const rowWhere = (container: HTMLElement, text: string): HTMLElement => {
  const rows = [...container.querySelectorAll('.sess-item')] as HTMLElement[]
  const found = rows.find((row) => row.textContent?.includes(text))
  if (found === undefined) throw new Error(`没有找到会话行：${text}`)
  return found
}

beforeEach(() => {
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (op: string): Promise<unknown> => Promise.resolve(op === 'recentCwds' ? [] : { ok: true }),
    on: () => () => undefined,
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (globalThis as { dscNative?: unknown }).dscNative
})

describe('临时行是只读回执（ui-sessions-unsaved-row [3]）', () => {
  test('不画图钉（占位撑住行首）、不给归档钮', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const unsaved = rowWhere(container, '临时会话')
    expect(unsaved.querySelector('.lead-pin')).toBeNull()
    // 占位仍然在（行首不塌）。
    expect(unsaved.querySelector('.row-slot')).toBeTruthy()
    expect(unsaved.querySelector('.row-actions button')).toBeNull()
    // 对照组：真行有图钉与归档钮。
    const real = rowWhere(container, '真会话')
    expect(real.querySelector('.lead-pin')).toBeTruthy()
    expect(real.querySelector('.row-actions button')).toBeTruthy()
  })

  test('双击标题不亮出改名框（真行会亮，对照组）', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    fireEvent.doubleClick(rowWhere(container, '临时会话').querySelector('.title') as HTMLElement)
    expect(container.querySelector('.row-rename')).toBeNull()
    fireEvent.doubleClick(rowWhere(container, '真会话').querySelector('.title') as HTMLElement)
    expect(container.querySelector('.row-rename')).toBeTruthy()
  })

  test('右键不弹行级菜单（真行会弹，对照组）', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    fireEvent.contextMenu(rowWhere(container, '临时会话'), { clientX: 10, clientY: 10 })
    expect(container.querySelector('.row-menu')).toBeNull()
    fireEvent.contextMenu(rowWhere(container, '真会话'), { clientX: 10, clientY: 10 })
    expect(container.querySelector('.row-menu')).toBeTruthy()
  })

  test('不参与拖拽（draggable 为假）', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    expect(rowWhere(container, '临时会话').getAttribute('draggable')).toBe('false')
    expect(rowWhere(container, '真会话').getAttribute('draggable')).toBe('true')
  })
})

describe('点「新会话」展开所在工作区（ui-sessions-unsaved-row [4]）', () => {
  test('组收起时点新会话：写回 sessionExpansion=true，并请求 openSession([])', async () => {
    const harness = harnessOf({ sessionExpansion: { 'D:/demo': false } })
    const { container } = mount(harness)
    await flush()
    // 组收着：会话行一个都不画。
    expect(container.querySelectorAll('.sess-item')).toHaveLength(0)
    const button = container.querySelector('[data-action="new-session"]') as HTMLElement
    expect(button).toBeTruthy()
    await act(async () => {
      fireEvent.click(button)
      await Promise.resolve()
    })
    const prefsCall = harness.calls.find((call) => call.method === 'setUiPrefs')
    expect(prefsCall?.args[0]).toEqual({ sessionExpansion: { 'D:/demo': true } })
    const openCall = harness.calls.find((call) => call.method === 'openSession')
    expect(openCall?.args).toEqual([])
  })
})

describe('乐观高亮（ui-sessions-unsaved-row [5]）', () => {
  test('点会话当帧就亮；点「新会话」把旧高亮撤掉', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const real = rowWhere(container, '真会话')
    expect(real.className).not.toContain('active')
    await act(async () => {
      fireEvent.click(real)
      await Promise.resolve()
    })
    expect(real.className).toContain('active')
    expect(harness.calls.find((call) => call.method === 'openSession')?.args).toEqual(['D:/demo/a.jsonl'])
    // 点新会话：乐观值清空 → 没有行亮着。
    await act(async () => {
      fireEvent.click(container.querySelector('[data-action="new-session"]') as HTMLElement)
      await Promise.resolve()
    })
    const rows = [...container.querySelectorAll('.sess-item')] as HTMLElement[]
    expect(rows.some((row) => row.className.includes('active'))).toBe(false)
  })
})

describe('侧栏页脚（ui-sidebar-footer [2]）', () => {
  test('今日总用量取 days 末位，文案只画一处，悬浮说明走原生 title', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const footer = container.querySelector('.sidebar-footer') as HTMLElement
    expect(footer.querySelector('.num')?.textContent).toContain('150 tok')
    // 只画一处「今日总用量」，旧口径两条都不出现。
    expect(footer.textContent?.split(zh['footer.usage']).length).toBe(2)
    expect(footer.textContent).not.toContain('会话用量')
    expect(footer.textContent).not.toContain('在别的目录开新会话')
    const usageRow = footer.querySelector('.row') as HTMLElement
    expect(usageRow.getAttribute('title')).toBe(zh['footer.usageTip'])
    expect(usageRow.className).not.toContain('row-btn')
  })

  test('60 秒兜底轮询：到点重取一次 usageStats', async () => {
    vi.useFakeTimers()
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    expect(container.querySelector('.sidebar-footer')).toBeTruthy()
    const before = harness.calls.filter((call) => call.method === 'usageStats').length
    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await Promise.resolve()
    })
    const after = harness.calls.filter((call) => call.method === 'usageStats').length
    expect(after).toBeGreaterThan(before)
  })

  test('设置行只开设置面板，不派发 shell.session.new（选目录开会话归组头）', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const seen: string[] = []
    const onSettings = (): void => {
      seen.push('settings')
    }
    const onSession = (): void => {
      seen.push('session')
    }
    window.addEventListener('shell.settings.open', onSettings)
    window.addEventListener('shell.session.new', onSession)
    try {
      fireEvent.click(container.querySelector('.sidebar-footer .row-btn') as HTMLElement)
    } finally {
      window.removeEventListener('shell.settings.open', onSettings)
      window.removeEventListener('shell.session.new', onSession)
    }
    expect(seen).toEqual(['settings'])
  })
})
