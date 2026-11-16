/**
 * 侧栏会话列表的补测（ui 层，真渲染）：顶栏「工作区打开组」的四个入口与收起时机、
 * 归档提示里的撤销 / 筛选动作、相对时间与运行状态点、工作区 ··· 菜单的改名 / 恢复 /
 * 打开资源管理器、仅归档档的整组恢复，以及单列表档的渲染。
 *
 * 挂载方式沿用 `page.spec.tsx`：照生产壳装载插件那条路收 `shell.sidebar` 与
 * `shell.header` 两条登记；RuntimeProvider 给假宿主通道，`dscNative` 按用例开关。
 *
 * @module dsc-ui-sessions/ui/sessions-more.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, setShellPage, setThreadView, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, SessionSummary, UiPluginApi } from '@dsc/ui'
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

const SESSIONS: SessionSummary[] = [
  session({ id: 'D:/demo/a.jsonl', createdAt: 1, updatedAt: 30, title: '甲会话' }),
  session({ id: 'D:/demo/b.jsonl', createdAt: 2, updatedAt: 20, title: '乙会话' }),
  session({ id: 'D:/other/c.jsonl', cwd: 'D:/other', createdAt: 3, updatedAt: 10, title: '丙会话' }),
]

interface Invoke {
  method: string
  args: unknown[]
}

interface HarnessOptions {
  sessions?: SessionSummary[]
  cwd?: string | null
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

function harnessOf(options: HarnessOptions = {}): Harness {
  const calls: Invoke[] = []
  const nativeCalls: Array<{ op: string; args: unknown[] }> = []
  const cwd = options.cwd === undefined ? 'D:/demo' : options.cwd
  const snapshot = {
    sessions: options.sessions ?? SESSIONS,
    status: { cwd, sessionPath: 'D:/demo/a.jsonl', turnState: 'idle' },
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
    listArchivedSessions: { items: [{ path: 'D:/archive/a.jsonl' }] },
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
      return Promise.resolve(replies[method] ?? { ok: true }) as Promise<T>
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
        return Promise.resolve({ ok: true })
      },
      on: () => () => undefined,
    }
  }
  return { channel, calls, nativeCalls }
}

const mountList = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <SessionList />
    </RuntimeProvider>,
  )

const mountHeader = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <WorkspaceOpenGroup />
    </RuntimeProvider>,
  )

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })

const rows = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll('.sess-item')] as HTMLElement[]
const rowWhere = (root: HTMLElement, text: string): HTMLElement => {
  const found = rows(root).find((row) => row.textContent?.includes(text))
  if (found === undefined) throw new Error(`没有会话行：${text}`)
  return found
}
const textOf = (element: Element | null): string => element?.textContent ?? ''
const toastText = (): string => textOf(document.querySelector('.dsc-toasts'))

function toastAction(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll('.dsc-toast__act')].find((button) => button.textContent === label) as
    | HTMLElement
    | undefined
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  setShellPage(null)
  setThreadView('chat')
})

afterEach(() => {
  cleanup()
  setShellPage(null)
  setThreadView('chat')
  document.body.innerHTML = ''
  delete (globalThis as { dscNative?: unknown }).dscNative
  delete (navigator as { clipboard?: unknown }).clipboard
})

describe('顶栏工作区打开组', () => {
  test('主钮开资源管理器；下拉里终端 / 资源管理器 / VS Code 都走原生桥并带当前工作区', async () => {
    const harness = harnessOf()
    const { container } = mountHeader(harness)
    await flush()
    fireEvent.click(container.querySelector('.ws-open-main') as HTMLElement)
    await flush()
    expect(harness.nativeCalls).toContainEqual({ op: 'openWorkspace', args: ['explorer', 'D:/demo'] })

    const caret = container.querySelector('.ws-open-caret') as HTMLElement
    const pick = async (index: number): Promise<void> => {
      fireEvent.click(caret)
      const items = [...document.querySelectorAll('.ws-open-menu .menu-item')] as HTMLElement[]
      fireEvent.click(items[index] as HTMLElement)
      await flush()
    }
    await pick(0)
    await pick(1)
    await pick(2)
    expect(harness.nativeCalls).toContainEqual({ op: 'openWorkspace', args: ['terminal', 'D:/demo'] })
    expect(harness.nativeCalls).toContainEqual({ op: 'openWorkspace', args: ['explorer', 'D:/demo'] })
    expect(harness.nativeCalls).toContainEqual({ op: 'openWorkspace', args: ['vscode', 'D:/demo'] })
  })

  test('复制工作区路径；Escape 与点外面都收起下拉', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const harness = harnessOf()
    const { container } = mountHeader(harness)
    await flush()
    const caret = container.querySelector('.ws-open-caret') as HTMLElement

    fireEvent.click(caret)
    const items = [...document.querySelectorAll('.ws-open-menu .menu-item')] as HTMLElement[]
    fireEvent.click(items[3] as HTMLElement)
    await flush()
    expect(writeText).toHaveBeenCalledWith('D:/demo')
    expect(toastText()).toContain(zh['toast.pathCopied'])
    expect(document.querySelector('.ws-open-menu')).toBeNull()

    fireEvent.click(caret)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('.ws-open-menu')).toBeNull()

    fireEvent.click(caret)
    fireEvent.pointerDown(document.body)
    expect(document.querySelector('.ws-open-menu')).toBeNull()
  })

  test('没有原生桥：给桌面版提示、不发请求；没有工作目录：给先开会话的提示', async () => {
    const browser = harnessOf({ noNative: true })
    const { container } = mountHeader(browser)
    await flush()
    fireEvent.click(container.querySelector('.ws-open-main') as HTMLElement)
    await flush()
    expect(toastText()).toContain(zh['toast.needsDesktop'])
    expect(browser.nativeCalls).toHaveLength(0)

    cleanup()
    document.body.innerHTML = ''
    const noCwd = harnessOf({ cwd: null })
    const second = mountHeader(noCwd)
    await flush()
    fireEvent.click(second.container.querySelector('.ws-open-main') as HTMLElement)
    await flush()
    expect(toastText()).toContain(zh['toast.noCwd'])
  })
})

describe('归档提示里的两个动作', () => {
  test('撤销：从归档列表按文件名认回路径，再调 restoreSessions', async () => {
    const harness = harnessOf()
    const { container } = mountList(harness)
    await flush()
    fireEvent.click(rowWhere(container, '甲会话').querySelector('.row-actions button') as HTMLElement)
    await flush()
    expect(toastText()).toContain('会话已归档')
    fireEvent.click(toastAction(zh['toast.undoArchive']) as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'listArchivedSessions', args: [] })
    expect(harness.calls).toContainEqual({ method: 'restoreSessions', args: [['D:/archive/a.jsonl']] })
  })

  test('筛选已归档会话：把 archivedFilter 写成 show', async () => {
    const harness = harnessOf()
    const { container } = mountList(harness)
    await flush()
    fireEvent.click(rowWhere(container, '乙会话').querySelector('.row-actions button') as HTMLElement)
    await flush()
    fireEvent.click(toastAction(zh['toast.showArchived']) as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setUiPrefs', args: [{ archivedFilter: 'show' }] })
  })
})

describe('相对时间、状态点与单列表档', () => {
  test('行尾时间照旧版分档：刚刚 / N分钟 / N小时 / N天', async () => {
    const now = Date.now()
    const timed = [
      session({ id: 'D:/demo/t1.jsonl', updatedAt: now - 1_000, title: '刚刚的' }),
      session({ id: 'D:/demo/t2.jsonl', updatedAt: now - 5 * 60_000 - 5_000, title: '五分钟的' }),
      session({ id: 'D:/demo/t3.jsonl', updatedAt: now - 3 * 3_600_000 - 5_000, title: '三小时的' }),
      session({ id: 'D:/demo/t4.jsonl', updatedAt: now - 2 * 86_400_000 - 60_000, title: '两天的' }),
    ]
    const { container } = mountList(harnessOf({ sessions: timed }))
    await flush()
    expect(textOf(rowWhere(container, '刚刚的').querySelector('.when'))).toBe(zh['time.justNow'])
    expect(textOf(rowWhere(container, '五分钟的').querySelector('.when'))).toBe('5分钟')
    expect(textOf(rowWhere(container, '三小时的').querySelector('.when'))).toBe('3小时')
    expect(textOf(rowWhere(container, '两天的').querySelector('.when'))).toBe('2天')
  })

  test('运行状态点顶替图钉：三档 class 与读屏说明都来自状态表', async () => {
    const states = {
      'D:/demo/a.jsonl': 'working',
      'D:/demo/b.jsonl': 'awaiting-approval',
      'D:/demo/c.jsonl': 'just-finished',
    }
    const sessions = [
      session({ id: 'D:/demo/a.jsonl', title: '跑的', pinnedAt: 9 }),
      session({ id: 'D:/demo/b.jsonl', title: '等的' }),
      session({ id: 'D:/demo/c.jsonl', title: '完成的' }),
    ]
    const { container } = mountList(harnessOf({ sessions, snapshot: { sessionStates: states } }))
    await flush()
    const running = rowWhere(container, '跑的')
    expect(running.querySelector('.session-dot.working')?.getAttribute('aria-label')).toBe(zh['dot.working'])
    // 有状态点时图钉不画，即使这一行是置顶的。
    expect(running.querySelector('.lead-pin')).toBeNull()
    expect(rowWhere(container, '等的').querySelector('.session-dot.awaiting-approval')?.getAttribute('aria-label')).toBe(
      zh['dot.awaiting'],
    )
    expect(
      rowWhere(container, '完成的').querySelector('.session-dot.just-finished')?.getAttribute('aria-label'),
    ).toBe(zh['dot.finished'])
  })

  test('单列表档：标题变「会话」，跨工作区混成一条流，不出工作区行', async () => {
    const { container } = mountList(harnessOf({ prefs: { sessionGroup: 'flat' } }))
    await flush()
    expect(textOf(container.querySelector('.side-title'))).toBe(zh['head.sessions'])
    expect(container.querySelector('.group-row')).toBeNull()
    expect(rows(container).map((row) => textOf(row.querySelector('.title')))).toEqual([
      '甲会话',
      '乙会话',
      '丙会话',
    ])
  })
})

describe('工作区 ··· 菜单与仅归档档', () => {
  test('重命名显示名写回 workspaceAliases；恢复真实目录名删掉别名', async () => {
    const harness = harnessOf({ sessions: [session({ id: 'D:/demo/a.jsonl', title: '甲会话' })] })
    const { container } = mountList(harness)
    await flush()
    const groupRow = container.querySelector('.group-row') as HTMLElement
    const more = groupRow.querySelector(`[aria-label="${zh['group.more']}"]`) as HTMLElement

    fireEvent.click(more)
    const rename = [...document.querySelectorAll('.row-menu .menu-item')].find((item) =>
      textOf(item).includes(zh['menu.renameGroup']),
    ) as HTMLElement
    fireEvent.click(rename)
    const input = container.querySelector('.group-row .row-rename') as HTMLInputElement
    expect(input).not.toBeNull()
    fireEvent.change(input, { target: { value: '别名工作区' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(harness.calls).toContainEqual({
      method: 'setUiPrefs',
      args: [{ workspaceAliases: { 'D:/demo': '别名工作区' } }],
    })
    expect(textOf(container.querySelector('.group-row .dir'))).toBe('别名工作区')

    fireEvent.click(container.querySelector(`[aria-label="${zh['group.more']}"]`) as HTMLElement)
    const reset = [...document.querySelectorAll('.row-menu .menu-item')].find((item) =>
      textOf(item).includes(zh['menu.resetAlias']),
    ) as HTMLElement
    fireEvent.click(reset)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setUiPrefs', args: [{ workspaceAliases: {} }] })
    expect(textOf(container.querySelector('.group-row .dir'))).toBe('demo')
  })

  test('组菜单「在资源管理器中打开」：桌面档走原生桥；浏览器档给提示', async () => {
    const desktop = harnessOf({ sessions: [session({ id: 'D:/demo/a.jsonl', title: '甲会话' })] })
    const first = mountList(desktop)
    await flush()
    fireEvent.click(first.container.querySelector(`[aria-label="${zh['group.more']}"]`) as HTMLElement)
    const explorer = [...document.querySelectorAll('.row-menu .menu-item')].find((item) =>
      textOf(item).includes(zh['menu.openExplorer']),
    ) as HTMLElement
    fireEvent.click(explorer)
    await flush()
    expect(desktop.nativeCalls).toContainEqual({ op: 'openPath', args: ['D:/demo'] })

    cleanup()
    document.body.innerHTML = ''
    delete (globalThis as { dscNative?: unknown }).dscNative
    const browser = harnessOf({ noNative: true, sessions: [session({ id: 'D:/demo/a.jsonl', title: '甲会话' })] })
    const second = mountList(browser)
    await flush()
    fireEvent.click(second.container.querySelector(`[aria-label="${zh['group.more']}"]`) as HTMLElement)
    const browserExplorer = [...document.querySelectorAll('.row-menu .menu-item')].find((item) =>
      textOf(item).includes(zh['menu.openExplorer']),
    ) as HTMLElement
    fireEvent.click(browserExplorer)
    await flush()
    expect(toastText()).toContain(zh['toast.explorerNeedsDesktop'])
  })

  test('仅归档档：组头「全部恢复」与组菜单「恢复这 N 个会话」都整组回传', async () => {
    const archived = [
      session({ id: 'D:/demo/x.jsonl', title: '归档甲', archivedAt: 50 }),
      session({ id: 'D:/demo/y.jsonl', title: '归档乙', archivedAt: 60 }),
    ]
    const harness = harnessOf({ sessions: archived, prefs: { archivedFilter: 'only' } })
    const { container } = mountList(harness)
    await flush()
    expect(rows(container)).toHaveLength(2)
    fireEvent.click(container.querySelector(`[aria-label="${zh['group.restoreAll']}"]`) as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({
      method: 'restoreSessions',
      args: [['D:/demo/x.jsonl', 'D:/demo/y.jsonl']],
    })

    fireEvent.click(container.querySelector(`[aria-label="${zh['group.more']}"]`) as HTMLElement)
    const restoreItem = [...document.querySelectorAll('.row-menu .menu-item')].find((item) =>
      textOf(item).includes('恢复这 2 个会话'),
    ) as HTMLElement
    fireEvent.click(restoreItem)
    await flush()
    expect(
      harness.calls.filter(
        (call) => call.method === 'restoreSessions' && Array.isArray(call.args[0]) && call.args[0].length === 2,
      ),
    ).toHaveLength(2)
  })
})
