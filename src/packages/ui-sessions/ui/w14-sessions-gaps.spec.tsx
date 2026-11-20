/**
 * 侧栏会话列表（`ui-sessions/ui/ui.tsx`）的 W14 补盲：既有 spec 没走到的那批错误路与
 * 「单列表档 / 命令面板 / 超时兜底」的接线。
 *
 * 覆盖：
 * - 挂载期两处静默兜底：偏好读取失败、原生桥的最近工作区读取失败；
 * - `run()` 的通道 reject、归档的整条 catch、撤销归档时「宿主拒收」与「通道 reject」两路、
 *   工作区删除时归档失败；
 * - 命令面板动作表（ACTIONS_SERVICE）的登记与 run 入口；
 * - 分叉落地的 reject；
 * - 乐观高亮的 4 秒超时；视图菜单二次点击收起、搜索框的清空钮；
 * - 单列表档会话行的七个回调（置顶 / 归档 / 改名 / 改名收尾 / 分叉 / 恢复 / 行级菜单），
 *   以及行级菜单的遮罩、归档项、恢复项；
 * - 工作区行内改名的输入框吞冒泡、工作区菜单的遮罩与「资源管理器」失败回执；
 * - 顶栏工作区打开组收到 `ok:false` 时的回执。
 *
 * 挂载方式沿用 `page.spec.tsx` / `sessions-more.spec.tsx`：照生产壳装载插件收
 * `shell.sidebar` 与 `shell.header` 两条登记；RuntimeProvider 给假宿主通道，`dscNative` 按用例开关。
 *
 * @module dsc-ui-sessions/ui/w14-sessions-gaps.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, setShellPage, setThreadView, type HostChannel } from '@dsc/ui-runtime'
import { ServiceRegistry, ServicesProvider } from '@dsc/ui-core'
import {
  ACTIONS_SERVICE,
  type ActionsHandle,
  type HostSnapshot,
  type SessionSummary,
  type UiAction,
  type UiPluginApi,
} from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import plugin from './ui.js'

interface Registration {
  slot: string
  options: Record<string, unknown>
  component: unknown
}

const registered: Registration[] = []
const fakeUi = {
  slots: {
    register: (slot: string, options: unknown, component: unknown): void => {
      registered.push({ slot, options: options as Record<string, unknown>, component })
    },
    declare: (): void => undefined,
    registerFactory: (): void => undefined,
  },
  provide: (): void => undefined,
  consume: (): undefined => undefined,
} as unknown as UiPluginApi
plugin.apply(fakeUi)

function componentAt(slot: string, id?: string): ComponentType {
  const found = registered.find((item) => item.slot === slot && (id === undefined || item.options['id'] === id))
  if (found === undefined) throw new Error(`没有登记：${slot}${id === undefined ? '' : `/${id}`}`)
  return found.component as ComponentType
}

const SessionList = componentAt('shell.sidebar')
const WorkspaceOpenGroup = componentAt('shell.header', 'sessions.workspace-open')

const session = (over: Partial<SessionSummary> & { id: string }): SessionSummary => ({
  cwd: 'D:/demo',
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const A = 'D:/demo/a.jsonl'
const B = 'D:/demo/b.jsonl'
const D = 'D:/demo/d.jsonl'

const SESSIONS: SessionSummary[] = [
  session({ id: A, createdAt: 1, updatedAt: 30, title: '甲会话' }),
  session({ id: B, createdAt: 2, updatedAt: 20, title: '乙会话' }),
  session({ id: 'D:/other/c.jsonl', cwd: 'D:/other', createdAt: 3, updatedAt: 10, title: '丙会话' }),
]

interface Invoke {
  method: string
  args: unknown[]
}

interface HarnessOptions {
  sessions?: SessionSummary[]
  prefs?: Record<string, unknown>
  snapshot?: Record<string, unknown>
  replies?: Record<string, unknown>
  nativeReplies?: Record<string, unknown>
  noNative?: boolean
}

interface Harness {
  channel: HostChannel
  calls: Invoke[]
  nativeCalls: Array<{ op: string; args: unknown[] }>
}

/** 假宿主：快照 + 偏好 + 通道/原生桥都记账。 */
function harnessOf(options: HarnessOptions = {}): Harness {
  const calls: Invoke[] = []
  const nativeCalls: Array<{ op: string; args: unknown[] }> = []
  const snapshot = {
    sessions: options.sessions ?? SESSIONS,
    status: { cwd: 'D:/demo', sessionPath: A, turnState: 'idle' },
    ...(options.snapshot ?? {}),
  } as unknown as HostSnapshot
  const replies: Record<string, unknown> = {
    refreshSessions: {},
    getUiPrefs: {
      sessionGroup: 'workspace',
      sessionSort: 'manual',
      archivedFilter: 'hide',
      sessionExpansion: {},
      ...(options.prefs ?? {}),
    },
    openSession: {},
    renameSession: { ok: true, notice: '改好了' },
    archiveSessions: { ok: true, notice: '已归档' },
    restoreSessions: { ok: true, notice: '恢复了' },
    setSessionPinned: { ok: true },
    setUiPrefs: { ok: true },
    newSessionIn: { ok: true },
    interrupt: { ok: true },
    listUserMessages: ['第一句话', '第二句话'],
    forkSession: { ok: true, path: 'D:/demo/fork.jsonl' },
    ...(options.replies ?? {}),
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
      const reply = replies[method]
      if (reply instanceof Error) return Promise.reject(reply)
      return Promise.resolve(reply ?? { ok: true }) as Promise<T>
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  if (options.noNative !== true) {
    ;(globalThis as { dscNative?: unknown }).dscNative = {
      version: 1,
      call: (op: string, args: unknown[] = []): Promise<unknown> => {
        nativeCalls.push({ op, args })
        const reply = options.nativeReplies?.[op]
        if (reply instanceof Error) return Promise.reject(reply)
        if (reply !== undefined) return Promise.resolve(reply)
        if (op === 'recentCwds') return Promise.resolve([])
        if (op === 'pickDirectory') return Promise.resolve('')
        return Promise.resolve({ ok: true })
      },
      on: () => () => undefined,
    }
  }
  return { channel, calls, nativeCalls }
}

const mount = (harness: Harness, services?: ServiceRegistry): ReturnType<typeof render> => {
  const tree = (
    <RuntimeProvider channel={harness.channel}>
      <SessionList />
    </RuntimeProvider>
  )
  return render(services === undefined ? tree : <ServicesProvider services={services}>{tree}</ServicesProvider>)
}

const mountHeader = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <WorkspaceOpenGroup />
    </RuntimeProvider>,
  )

/** 让挂载期的一串 promise 落地（含嵌套 async）。 */
const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })

const rows = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll('.sess-item')] as HTMLElement[]
const rowWhere = (container: HTMLElement, text: string): HTMLElement => {
  const found = rows(container).find((row) => row.textContent?.includes(text))
  if (found === undefined) throw new Error(`没有会话行：${text}`)
  return found
}
const groups = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll('.group-row')] as HTMLElement[]
const groupWhere = (container: HTMLElement, text: string): HTMLElement => {
  const found = groups(container).find((row) => row.textContent?.includes(text))
  if (found === undefined) throw new Error(`没有工作区行：${text}`)
  return found
}
const textOf = (element: Element | null): string => element?.textContent ?? ''
const callsOf = (harness: Harness, method: string): Invoke[] => harness.calls.filter((call) => call.method === method)
const toastText = (): string => textOf(document.querySelector('.dsc-toasts'))
const toastAction = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll('.dsc-toast__act')].find((button) => button.textContent === label) as HTMLElement | undefined
const menuItem = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll('.row-menu .menu-item')].find((button) => button.textContent?.includes(label)) as
    HTMLElement | undefined
const confirmProceed = (): HTMLElement => {
  const buttons = [...(document.querySelector('.dsc-confirm')?.querySelectorAll('button') ?? [])] as HTMLElement[]
  const proceed = buttons.at(-1)
  if (proceed === undefined) throw new Error('确认框没有按钮')
  return proceed
}
/** 造一段假的动作表句柄：登记过的 owner 与列表都记下来。 */
function actionsHarness(): { handle: ActionsHandle; registered: Array<{ owner: string; list: readonly UiAction[] }> } {
  const collected: Array<{ owner: string; list: readonly UiAction[] }> = []
  const handle = {
    register: (owner: string, list: readonly UiAction[]): (() => void) => {
      collected.push({ owner, list })
      return () => undefined
    },
  } as unknown as ActionsHandle
  return { handle, registered: collected }
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  setThreadView('chat')
  setShellPage(null)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setShellPage(null)
  setThreadView('chat')
  delete (globalThis as { dscNative?: unknown }).dscNative
  delete (navigator as { clipboard?: unknown }).clipboard
  document.body.innerHTML = ''
})

describe('挂载期的静默兜底', () => {
  test('偏好读取失败与最近工作区读取失败：都不拦挂载，列表照常画', async () => {
    const harness = harnessOf({
      replies: { getUiPrefs: new Error('偏好库坏了') },
      nativeReplies: { recentCwds: new Error('桥不在') },
    })
    const { container } = mount(harness)
    await flush()
    expect(rows(container).map((row) => textOf(row.querySelector('.title')))).toContain('甲会话')
    expect(callsOf(harness, 'getUiPrefs')).toHaveLength(1)
    expect(harness.nativeCalls.some((call) => call.op === 'recentCwds')).toBe(true)
  })
})

describe('通道失败与人话回执', () => {
  test('run() 的通道 reject：把原因写进侧栏故障条', async () => {
    const harness = harnessOf({ replies: { setSessionPinned: new Error('置顶挂了') } })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(rowWhere(container, '甲会话').querySelector('.lead-pin') as HTMLElement)
    await flush()
    expect(textOf(container)).toContain('置顶挂了')
  })

  test('归档本身 reject：Toast 带原因；撤销恢复被宿主拒收：Toast 也带原因', async () => {
    const failing = harnessOf({ replies: { archiveSessions: new Error('归档挂了') } })
    const first = mount(failing)
    await flush()
    fireEvent.click(rowWhere(first.container, '甲会话').querySelector('.row-actions button') as HTMLElement)
    await flush()
    expect(toastText()).toContain('归档挂了')
    cleanup()
    document.body.innerHTML = ''

    const refused = harnessOf({
      replies: {
        listArchivedSessions: { items: [{ path: 'D:/archive/b.jsonl' }] },
        restoreSessions: { ok: false, error: '宿主拒收恢复' },
      },
    })
    const second = mount(refused)
    await flush()
    fireEvent.click(rowWhere(second.container, '乙会话').querySelector('.row-actions button') as HTMLElement)
    await flush()
    fireEvent.click(toastAction(zh['toast.undoArchive']) as HTMLElement)
    await flush()
    expect(toastText()).toContain('宿主拒收恢复')
  })

  test('撤销恢复的通道 reject：Toast 带原因原文', async () => {
    const harness = harnessOf({
      replies: {
        listArchivedSessions: { items: [{ path: 'D:/archive/a.jsonl' }] },
        restoreSessions: new Error('通道断了'),
      },
    })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(rowWhere(container, '甲会话').querySelector('.row-actions button') as HTMLElement)
    await flush()
    fireEvent.click(toastAction(zh['toast.undoArchive']) as HTMLElement)
    await flush()
    expect(toastText()).toContain('通道断了')
  })

  test('删除工作区时归档失败：Toast 说明归档没成，组不丢', async () => {
    const harness = harnessOf({ replies: { archiveSessions: new Error('整批失败') } })
    const { container } = mount(harness)
    await flush()
    const more = groupWhere(container, 'demo').querySelector('.row-actions button') as HTMLElement
    fireEvent.click(more)
    fireEvent.click(menuItem(zh['menu.deleteWorkspace']) as HTMLElement)
    await flush()
    fireEvent.click(confirmProceed())
    await flush()
    expect(toastText()).toContain(zh['toast.archiveFailed'])
  })

  test('分叉落地的 reject：写进侧栏故障条', async () => {
    const harness = harnessOf({ replies: { forkSession: new Error('分叉挂了') } })
    const { container } = mount(harness)
    await flush()
    const row = rowWhere(container, '甲会话')
    fireEvent.keyDown(row, { key: 'F', ctrlKey: true, altKey: true })
    await flush()
    fireEvent.click(document.querySelector('.fork-item') as HTMLElement)
    await flush()
    expect(textOf(container)).toContain('分叉挂了')
  })
})

describe('命令面板的动作表', () => {
  test('登记 sessions/session.new；run 走与窄栏同一个新会话入口', async () => {
    const harness = harnessOf()
    const { handle, registered: actions } = actionsHarness()
    const registry = new ServiceRegistry()
    registry.provide(ACTIONS_SERVICE, handle, 'test')
    mount(harness, registry)
    await flush()
    expect(actions.map((item) => item.owner)).toEqual(['sessions'])
    const action = actions[0]?.list.find((item) => item.id === 'session.new')
    expect(action).toBeTruthy()
    action?.run()
    await flush()
    expect(callsOf(harness, 'openSession')[0]?.args).toEqual([])
  })
})

describe('乐观高亮的收尾', () => {
  test('点了会话没等到宿主那一帧：4 秒后自动撤掉高亮，回落当前会话', async () => {
    vi.useFakeTimers()
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    expect(rowWhere(container, '甲会话').className).toContain('active')
    fireEvent.click(rowWhere(container, '乙会话'))
    expect(rowWhere(container, '乙会话').className).toContain('active')
    await act(async () => {
      vi.advanceTimersByTime(4_000)
    })
    expect(rowWhere(container, '乙会话').className).not.toContain('active')
    expect(rowWhere(container, '甲会话').className).toContain('active')
  })
})

describe('头部两个小钮', () => {
  test('视图菜单点第二次自己收起；搜索框的清空钮关掉搜索', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const view = container.querySelector('.head-actions button[aria-label]') as HTMLElement
    const viewButton = [...container.querySelectorAll('.head-actions button')].find(
      (button) => button.getAttribute('aria-label') === zh['view.label'],
    ) as HTMLElement
    expect(viewButton).toBeTruthy()
    expect(view).toBeTruthy()
    fireEvent.click(viewButton)
    expect(document.querySelector('.row-menu')).not.toBeNull()
    fireEvent.click(viewButton)
    expect(document.querySelector('.row-menu')).toBeNull()

    const searchButton = [...container.querySelectorAll('.head-actions button')].find(
      (button) => button.getAttribute('aria-label') === zh['search.tip'],
    ) as HTMLElement
    fireEvent.click(searchButton)
    expect(container.querySelector('.side-search input')).not.toBeNull()
    fireEvent.click(container.querySelector('.side-search .icon-btn') as HTMLElement)
    expect(container.querySelector('.side-search')).toBeNull()
  })
})

describe('单列表档的会话行回调', () => {
  const flatPrefs = { sessionGroup: 'flat', archivedFilter: 'show' }
  const flatSessions = (): SessionSummary[] => [
    session({ id: A, createdAt: 1, updatedAt: 30, title: '甲会话' }),
    session({ id: B, createdAt: 2, updatedAt: 20, title: '乙会话' }),
    session({ id: D, createdAt: 3, updatedAt: 10, title: '丁会话', archivedAt: 5 }),
  ]

  test('置顶 / 归档 / 行内改名 / 分叉四条动作各自回传', async () => {
    const harness = harnessOf({ sessions: flatSessions(), prefs: flatPrefs })
    const { container } = mount(harness)
    await flush()
    expect(container.querySelectorAll('.group-row')).toHaveLength(0)

    fireEvent.click(rowWhere(container, '甲会话').querySelector('.lead-pin') as HTMLElement)
    await flush()
    expect(callsOf(harness, 'setSessionPinned')[0]?.args).toEqual([A, true])

    fireEvent.click(rowWhere(container, '甲会话').querySelector('.row-actions button') as HTMLElement)
    await flush()
    expect(callsOf(harness, 'archiveSessions')[0]?.args).toEqual([[A]])

    // 行级右键菜单的「重命名」：先请求改名（收尾回调把请求清掉），再提交新名字。
    const row = rowWhere(container, '乙会话')
    fireEvent.contextMenu(row, { clientX: 8, clientY: 8 })
    fireEvent.click(menuItem(zh['menu.rename']) as HTMLElement)
    await flush()
    const input = row.querySelector('.row-rename') as HTMLInputElement
    expect(input).not.toBeNull()
    fireEvent.change(input, { target: { value: '乙改名' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(callsOf(harness, 'renameSession')[0]?.args).toEqual([B, '乙改名'])

    // 右键菜单的「分叉」：先开选择器、点遮罩收起，再点一条消息落分叉。
    fireEvent.contextMenu(rowWhere(container, '乙会话'), { clientX: 8, clientY: 8 })
    fireEvent.click(menuItem(zh['menu.fork']) as HTMLElement)
    await flush()
    expect(document.querySelector('.fork-picker')).not.toBeNull()
    fireEvent.click(document.querySelector('.fork-picker')?.previousElementSibling as HTMLElement)
    expect(document.querySelector('.fork-picker')).toBeNull()
    fireEvent.contextMenu(rowWhere(container, '乙会话'), { clientX: 8, clientY: 8 })
    fireEvent.click(menuItem(zh['menu.fork']) as HTMLElement)
    await flush()
    fireEvent.click(document.querySelector('.fork-item') as HTMLElement)
    await flush()
    expect(callsOf(harness, 'forkSession')[0]?.args).toEqual([B, 0])
  })

  test('归档行的恢复钮；行级菜单的遮罩 / 归档项 / 恢复项', async () => {
    const harness = harnessOf({ sessions: flatSessions(), prefs: flatPrefs })
    const { container } = mount(harness)
    await flush()

    // 行级快捷键 Ctrl+Alt+F 走单列表档自己的 onFork 回调：开选择器后用遮罩收起。
    fireEvent.keyDown(rowWhere(container, '甲会话'), { key: 'f', ctrlKey: true, altKey: true })
    await flush()
    expect(document.querySelector('.fork-picker')).not.toBeNull()
    fireEvent.click(document.querySelector('.fork-picker')?.previousElementSibling as HTMLElement)
    expect(document.querySelector('.fork-picker')).toBeNull()

    fireEvent.click(rowWhere(container, '丁会话').querySelector('.row-actions button') as HTMLElement)
    await flush()
    expect(callsOf(harness, 'restoreSessions')[0]?.args).toEqual([[D]])

    // 行级菜单的遮罩：点一下关菜单。
    fireEvent.contextMenu(rowWhere(container, '甲会话'), { clientX: 8, clientY: 8 })
    expect(document.querySelector('.row-menu')).not.toBeNull()
    fireEvent.click(document.querySelector('.menu-backdrop') as HTMLElement)
    expect(document.querySelector('.row-menu')).toBeNull()

    // 非归档行菜单最后一项是「归档」，点了立刻归档。
    fireEvent.contextMenu(rowWhere(container, '甲会话'), { clientX: 8, clientY: 8 })
    fireEvent.click(menuItem(zh['menu.archive']) as HTMLElement)
    await flush()
    expect(callsOf(harness, 'archiveSessions')[0]?.args).toEqual([[A]])

    // 归档行菜单最后一项换成「恢复」。
    fireEvent.contextMenu(rowWhere(container, '丁会话'), { clientX: 8, clientY: 8 })
    fireEvent.click(menuItem(zh['menu.restore']) as HTMLElement)
    await flush()
    expect(callsOf(harness, 'restoreSessions').length).toBeGreaterThanOrEqual(2)
    expect(callsOf(harness, 'restoreSessions').at(-1)?.args).toEqual([[D]])
  })
})

describe('工作区行与菜单', () => {
  test('行内改名的输入框吞掉点击：点输入框不把组收起', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const group = groupWhere(container, 'demo')
    expect(group.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(group, { key: 'r', ctrlKey: true, altKey: true })
    const input = group.querySelector('.row-rename') as HTMLInputElement
    expect(input).not.toBeNull()
    fireEvent.click(input)
    expect(group.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(group.querySelector('.row-rename')).toBeNull()
  })

  test('工作区菜单的遮罩收起；「资源管理器」失败给出原因', async () => {
    const harness = harnessOf({ nativeReplies: { openPath: new Error('没有这个目录') } })
    const { container } = mount(harness)
    await flush()
    const more = (): HTMLElement => groupWhere(container, 'demo').querySelector('.row-actions button') as HTMLElement

    fireEvent.click(more())
    expect(document.querySelector('.row-menu')).not.toBeNull()
    fireEvent.click(document.querySelector('.menu-backdrop') as HTMLElement)
    expect(document.querySelector('.row-menu')).toBeNull()

    fireEvent.click(more())
    fireEvent.click(menuItem(zh['menu.openExplorer']) as HTMLElement)
    await flush()
    expect(toastText()).toContain('没有这个目录')
  })
})

describe('顶栏工作区打开组', () => {
  test('原生桥回 ok:false：把宿主给的原因报出来', async () => {
    const harness = harnessOf({ nativeReplies: { openWorkspace: { ok: false, error: '目录没了' } } })
    const { container } = mountHeader(harness)
    await flush()
    fireEvent.click(container.querySelector('.ws-open-main') as HTMLElement)
    await flush()
    expect(toastText()).toContain('目录没了')
  })
})
