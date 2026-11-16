/**
 * 侧栏会话列表（`ui-sessions/ui/ui.tsx`）的分支补测。
 *
 * 既有三份 spec 压了新建/打开/搜索/改名/归档、分组折叠、拖拽、空态与插件入口。这一份
 * 只补它们没走到的分支：偏好坏形状的逐字段回落、启动图帧推来后插件钮的出现与消失、
 * 偏好写回失败的回滚、mutation 回执里的「没给原因」、归档 / 撤销 / 分叉 / 复制 / 新建
 * 各自失败的回执、组行键盘改名与失焦提交、拖到列表末尾、归档行与临时行的快捷键守卫、
 * 行级菜单改名、展开剩余的三档，以及原生桥失败与快照坏形状。
 *
 * @module dsc-ui-sessions/ui/branches-extra.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, setShellPage, shellPage, type HostChannel } from '@dsc/ui-runtime'
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

function componentAt(slot: string): ComponentType {
  const found = registered.find((item) => item.slot === slot)
  if (found === undefined) throw new Error(`没有登记：${slot}`)
  return found.component as ComponentType
}

const SessionList = componentAt('shell.sidebar')
const WorkspaceOpenGroup = componentAt('shell.header')

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
  pluginsFrame?: unknown
}

interface Harness {
  channel: HostChannel
  calls: Invoke[]
  nativeCalls: Array<{ op: string; args: unknown[] }>
  emitPlugins: (frame: unknown) => void
}

type PluginListener = Parameters<HostChannel['onPlugins']>[0]

function harnessOf(options: HarnessOptions = {}): Harness {
  const calls: Invoke[] = []
  const nativeCalls: Array<{ op: string; args: unknown[] }> = []
  const pluginListeners = new Set<PluginListener>()
  let frame: unknown = options.pluginsFrame ?? null
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
    newSessionIn: { ok: true },
    interrupt: { ok: true },
    listUserMessages: ['第一句话', '第二句话'],
    forkSession: { ok: true, path: 'D:/demo/fork.jsonl' },
    listArchivedSessions: { items: [{ path: 'D:/archive/a.jsonl' }] },
    usageStats: { days: [] },
    ...(options.replies ?? {}),
  }
  const channel: HostChannel = {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => frame as ReturnType<HostChannel['getPluginsFrame']>,
    onPlugins: (listener: PluginListener) => {
      pluginListeners.add(listener)
      return () => {
        pluginListeners.delete(listener)
      }
    },
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
  return {
    channel,
    calls,
    nativeCalls,
    emitPlugins: (next) => {
      frame = next
      for (const listener of pluginListeners) listener(frame as Parameters<PluginListener>[0])
    },
  }
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

const rows = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll('.sess-item')] as HTMLElement[]
const rowWhere = (container: HTMLElement, text: string): HTMLElement => {
  const found = rows(container).find((row) => row.textContent?.includes(text))
  if (found === undefined) throw new Error(`没有会话行：${text}`)
  return found
}
const groupWhere = (container: HTMLElement, text: string): HTMLElement => {
  const found = [...container.querySelectorAll('.group-row')].find((row) => row.textContent?.includes(text))
  if (found === undefined) throw new Error(`没有工作区行：${text}`)
  return found as HTMLElement
}
const textOf = (element: Element | null | undefined): string => element?.textContent ?? ''
const callsOf = (harness: Harness, method: string): Invoke[] => harness.calls.filter((call) => call.method === method)
const toastText = (): string => textOf(document.querySelector('.dsc-toasts'))
const toastAction = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll('.dsc-toast__act')].find((button) => textOf(button) === label) as HTMLElement | undefined

function menuItem(container: HTMLElement, text: string): HTMLElement {
  const items = [...container.querySelectorAll('.row-menu .menu-item')] as HTMLElement[]
  const found = items.find((item) => textOf(item).trim().startsWith(text))
  if (found === undefined) throw new Error(`没有菜单项：${text}`)
  return found
}

/** 拖拽事件需要的最小 DataTransfer 替身。 */
function dragTransfer(): {
  effectAllowed: string
  dropEffect: string
  setData(type: string, value: string): void
  getData(type: string): string
  setDragImage(): void
} {
  const store = new Map<string, string>()
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (type, value) => {
      store.set(type, value)
    },
    getData: (type) => store.get(type) ?? '',
    setDragImage: () => undefined,
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  setShellPage(null)
})

afterEach(() => {
  cleanup()
  setShellPage(null)
  document.body.innerHTML = ''
  delete (globalThis as { dscNative?: unknown }).dscNative
  delete (navigator as { clipboard?: unknown }).clipboard
})

describe('偏好的坏形状与启动图帧', () => {
  test('每个字段各自回落：分组/排序/筛选取默认，坏别名与坏展开表被丢掉，显式 false 仍被尊重', async () => {
    const harness = harnessOf({
      prefs: {
        sessionGroup: 'weird',
        sessionSort: 42,
        archivedFilter: 'no',
        workspaceAliases: { 'D:/demo': '演示别名', 'D:/bad': 7 },
        sessionExpansion: { 'D:/demo': false, 'D:/other': 'yes' },
        workspaceOrder: ['D:/x', 1, ''],
        sessionOrder: { 'D:/demo': ['a.jsonl', 2] },
      },
    })
    const { container } = mountList(harness)
    await flush()

    const demo = groupWhere(container, '演示别名')
    expect(demo.textContent).toContain('演示别名')
    expect(demo.getAttribute('aria-expanded')).toBe('false')
    expect(rows(container)).toHaveLength(0)

    fireEvent.click(demo)
    await flush()
    expect(demo.getAttribute('aria-expanded')).toBe('true')
    expect(rows(container)).toHaveLength(2)
  })

  test('启动图帧里没有 plugins 就摘掉插件钮；正停在插件页时自动退回对话页', async () => {
    setShellPage('plugins')
    const harness = harnessOf({
      pluginsFrame: { graph: { entries: [{ id: 'skills' }, { id: 'plugins' }] } },
    })
    const { container } = mountList(harness)
    await flush()
    expect([...container.querySelectorAll('.sidebar-nav .nav-item')]).toHaveLength(2)

    await act(async () => {
      harness.emitPlugins({ graph: { entries: [{ id: 'skills' }] } })
    })
    expect([...container.querySelectorAll('.sidebar-nav .nav-item')]).toHaveLength(1)
    expect(shellPage()).toBeNull()
  })

  test('快照形状坏掉（status / sessionStates 不是对象、loading 不是布尔）：不崩且页脚读 0 tok', async () => {
    const harness = harnessOf({
      snapshot: { status: 'bad', sessionStates: 'bad', sessionsLoading: 'yes' },
    })
    const { container } = mountList(harness)
    await flush()
    // status 坏掉 → 读不到当前工作区，哪组都不默认展开；手动展开后行照常画。
    expect([...container.querySelectorAll('.group-row')]).toHaveLength(2)
    fireEvent.click(groupWhere(container, 'demo'))
    await flush()
    expect(rows(container)).toHaveLength(2)
    expect(rows(container).some((row) => row.className.includes('active'))).toBe(false)
    expect(textOf(container.querySelector('.sidebar-footer .num'))).toContain('0 tok')
  })
})

describe('偏好写回失败与回执缺原因', () => {
  test('setUiPrefs 失败：本地改动回滚，并把人话写进 toast', async () => {
    const harness = harnessOf({ replies: { setUiPrefs: new Error('磁盘只读') } })
    const { container } = mountList(harness)
    await flush()
    fireEvent.click(container.querySelectorAll('.head-actions .icon-btn')[1] as HTMLElement)
    const picks = [...container.querySelectorAll('.view-menu button')] as HTMLElement[]
    fireEvent.click(picks[2]!)
    await flush()
    expect(textOf(container.querySelector('.side-title'))).toBe(zh['head.workspaces'])
    expect(toastText()).toContain('磁盘只读')
  })

  test('mutation 回执 ok:false 且没给 error：写「没有原因」而不是空提示', async () => {
    const harness = harnessOf({ replies: { renameSession: { ok: false } } })
    const { container } = mountList(harness)
    await flush()
    const row = rowWhere(container, '乙会话')
    fireEvent.keyDown(row, { key: 'r', ctrlKey: true, altKey: true })
    const input = row.querySelector('.row-rename') as HTMLInputElement
    fireEvent.change(input, { target: { value: '新名字' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(toastText()).toContain(zh['toast.noReason'])
    expect(callsOf(harness, 'refreshSessions')).toHaveLength(1)
  })
})

describe('归档 / 撤销 / 分叉 / 复制 / 新建的失败面', () => {
  test('归档失败：回执带原因，不重扫；撤销时归档区里没有同 uuid 的路径就说找不到', async () => {
    const failed = harnessOf({ replies: { archiveSessions: { ok: false, error: '归档坏了' } } })
    const first = mountList(failed)
    await flush()
    fireEvent.click(rowWhere(first.container, '甲会话').querySelector('.row-actions button') as HTMLElement)
    await flush()
    expect(toastText()).toContain('归档坏了')
    expect(callsOf(failed, 'refreshSessions')).toHaveLength(1)
    cleanup()

    const missing = harnessOf({
      replies: { listArchivedSessions: { items: [{ path: 'D:/archive/other.jsonl' }] } },
    })
    const second = mountList(missing)
    await flush()
    fireEvent.click(rowWhere(second.container, '甲会话').querySelector('.row-actions button') as HTMLElement)
    await flush()
    fireEvent.click(toastAction(zh['toast.undoArchive']) as HTMLElement)
    await flush()
    expect(toastText()).toContain(zh['toast.undoArchiveMissing'])
  })

  test('分叉：列消息失败写进侧栏；forkSession 回 ok:false 写原因；成功但没给路径时开新会话', async () => {
    const listFailed = harnessOf({ replies: { listUserMessages: new Error('读不到消息') } })
    const first = mountList(listFailed)
    await flush()
    fireEvent.contextMenu(rowWhere(first.container, '乙会话'), { clientX: 10, clientY: 10 })
    fireEvent.click(menuItem(first.container, zh['menu.fork']))
    await flush()
    expect(textOf(first.container.querySelector('.sidebar-empty'))).toContain('读不到消息')
    cleanup()

    const forkFailed = harnessOf({ replies: { forkSession: { ok: false, error: '断线了' } } })
    const second = mountList(forkFailed)
    await flush()
    fireEvent.contextMenu(rowWhere(second.container, '乙会话'), { clientX: 10, clientY: 10 })
    fireEvent.click(menuItem(second.container, zh['menu.fork']))
    await flush()
    fireEvent.click(second.container.querySelector('.fork-item') as HTMLElement)
    await flush()
    expect(textOf(second.container.querySelector('.sidebar-empty'))).toContain('断线了')
    cleanup()

    const noPath = harnessOf({ replies: { forkSession: { ok: true } } })
    const third = mountList(noPath)
    await flush()
    fireEvent.contextMenu(rowWhere(third.container, '乙会话'), { clientX: 10, clientY: 10 })
    fireEvent.click(menuItem(third.container, zh['menu.fork']))
    await flush()
    fireEvent.click(third.container.querySelector('.fork-item') as HTMLElement)
    await flush()
    expect(callsOf(noPath, 'openSession')[0]?.args).toEqual([])
    expect(toastText()).toContain(zh['fork.done'].replace('{n}', '1'))
  })

  test('复制 ID 失败给提示；在别的工作区新建失败也给人话', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('剪贴板被占')) },
    })
    const copy = harnessOf()
    const first = mountList(copy)
    await flush()
    fireEvent.contextMenu(rowWhere(first.container, '乙会话'), { clientX: 10, clientY: 10 })
    fireEvent.click(menuItem(first.container, zh['menu.copyId']))
    await flush()
    expect(toastText()).toContain('剪贴板被占')
    cleanup()

    const create = harnessOf({ replies: { newSessionIn: new Error('目录不可写') } })
    const second = mountList(create)
    await flush()
    fireEvent.click(groupWhere(second.container, 'other').querySelector(`[aria-label="${zh['group.newInLabel']}"]`) as HTMLElement)
    await flush()
    expect(toastText()).toContain('目录不可写')
  })
})

describe('键盘、拖到末尾与展开剩余', () => {
  test('组行 Ctrl+Alt+R 进入改名：Esc 放弃，失焦提交别名', async () => {
    const harness = harnessOf()
    const { container } = mountList(harness)
    await flush()
    const demo = groupWhere(container, 'demo')

    fireEvent.keyDown(demo, { key: 'r', ctrlKey: true, altKey: true })
    let input = demo.querySelector('.row-rename') as HTMLInputElement
    expect(input).not.toBeNull()
    fireEvent.change(input, { target: { value: '放弃的名字' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(demo.querySelector('.row-rename')).toBeNull()

    fireEvent.keyDown(demo, { key: 'r', ctrlKey: true, altKey: true })
    input = demo.querySelector('.row-rename') as HTMLInputElement
    fireEvent.change(input, { target: { value: '失焦别名' } })
    fireEvent.blur(input)
    await flush()
    expect(callsOf(harness, 'setUiPrefs').at(-1)?.args).toEqual([{ workspaceAliases: { 'D:/demo': '失焦别名' } }])
  })

  test('拖到列表末尾落点写 workspaceOrder；只拖不落（dragEnd）不写', async () => {
    const harness = harnessOf()
    const { container } = mountList(harness)
    await flush()
    const transfer = dragTransfer()

    fireEvent.dragStart(groupWhere(container, 'demo'), { dataTransfer: transfer })
    const tail = container.querySelector('.drop-tail') as HTMLElement
    expect(tail).not.toBeNull()
    fireEvent.dragOver(tail, { dataTransfer: transfer })
    fireEvent.drop(tail, { dataTransfer: transfer })
    await flush()
    expect(callsOf(harness, 'setUiPrefs').at(-1)?.args).toEqual([{ workspaceOrder: ['D:/other', 'D:/demo'] }])

    cleanup()
    const second = harnessOf()
    const view = mountList(second)
    await flush()
    fireEvent.dragStart(groupWhere(view.container, 'demo'), { dataTransfer: dragTransfer() })
    fireEvent.dragEnd(groupWhere(view.container, 'demo'))
    await flush()
    expect(callsOf(second, 'setUiPrefs').some((call) => 'workspaceOrder' in (call.args[0] as object))).toBe(false)
  })

  test('归档行与临时行的快捷键守卫：归档行不给改名/归档，临时行不给分叉', async () => {
    const archived = session({ id: 'D:/demo/old.jsonl', archivedAt: 50, title: '旧会话' })
    const unsaved = session({ id: 'D:/demo/temp.jsonl', title: '临时会话', unsaved: true })
    const harness = harnessOf({ sessions: [archived, unsaved], prefs: { archivedFilter: 'show' } })
    const { container } = mountList(harness)
    await flush()

    const old = rowWhere(container, '旧会话')
    fireEvent.keyDown(old, { key: 'Enter' })
    await flush()
    expect(toastText()).toContain(zh['row.archivedOpen'])
    fireEvent.keyDown(old, { key: 'r', ctrlKey: true, altKey: true })
    expect(old.querySelector('.row-rename')).toBeNull()
    fireEvent.keyDown(old, { key: 'a', ctrlKey: true, shiftKey: true })
    await flush()
    expect(callsOf(harness, 'archiveSessions')).toHaveLength(0)

    const temp = rowWhere(container, '临时会话')
    fireEvent.keyDown(temp, { key: 'f', ctrlKey: true, altKey: true })
    await flush()
    expect(callsOf(harness, 'listUserMessages')).toHaveLength(0)
    fireEvent.keyDown(temp, { key: 'a', ctrlKey: true, shiftKey: true })
    await flush()
    expect(callsOf(harness, 'archiveSessions')).toHaveLength(0)
  })

  test('行级菜单改名：Esc 放弃、失焦提交；展开剩余按 5→10→12→5 三档走', async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      session({ id: `D:/demo/${String(index)}.jsonl`, updatedAt: 100 - index, title: `会话${String(index)}` }),
    )
    const harness = harnessOf({ sessions: many })
    const { container } = mountList(harness)
    await flush()
    expect(rows(container)).toHaveLength(5)

    fireEvent.contextMenu(rows(container)[0]!, { clientX: 10, clientY: 10 })
    fireEvent.click(menuItem(container, zh['menu.rename']))
    let input = container.querySelector('.sess-item .row-rename') as HTMLInputElement
    expect(input).not.toBeNull()
    fireEvent.change(input, { target: { value: '不要的名字' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(container.querySelector('.sess-item .row-rename')).toBeNull()
    expect(callsOf(harness, 'renameSession')).toHaveLength(0)

    fireEvent.contextMenu(rows(container)[0]!, { clientX: 10, clientY: 10 })
    fireEvent.click(menuItem(container, zh['menu.rename']))
    input = container.querySelector('.sess-item .row-rename') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  最终名字  ' } })
    fireEvent.blur(input)
    await flush()
    expect(callsOf(harness, 'renameSession').at(-1)?.args).toEqual(['D:/demo/0.jsonl', '最终名字'])

    const more = (): HTMLElement => container.querySelector('.session-overflow') as HTMLElement
    fireEvent.click(more())
    expect(rows(container)).toHaveLength(10)
    expect(textOf(more())).toContain('2')
    fireEvent.click(more())
    expect(rows(container)).toHaveLength(12)
    expect(textOf(more())).toBe(zh['group.collapse'])
    fireEvent.click(more())
    expect(rows(container)).toHaveLength(5)
  })
})

describe('原生桥失败与顶栏入口', () => {
  test('打开工作区失败与复制路径失败各给提示', async () => {
    const open = harnessOf({ nativeReplies: { openWorkspace: new Error('桥断了') } })
    const first = mountHeader(open)
    await flush()
    fireEvent.click(first.container.querySelector('.ws-open-main') as HTMLElement)
    await flush()
    expect(toastText()).toContain('桥断了')
    cleanup()

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('没有权限')) },
    })
    const copy = harnessOf()
    const second = mountHeader(copy)
    await flush()
    fireEvent.click(second.container.querySelector('.ws-open-caret') as HTMLElement)
    const items = [...document.querySelectorAll('.ws-open-menu .menu-item')] as HTMLElement[]
    fireEvent.click(items[3] as HTMLElement)
    await flush()
    expect(toastText()).toContain(zh['toast.copyManual'])
  })

  test('添加工作区：选择目录抛错给提示；选到非字符串当取消', async () => {
    const failed = harnessOf({ nativeReplies: { pickDirectory: new Error('对话框炸了') } })
    const first = mountList(failed)
    await flush()
    fireEvent.click([...first.container.querySelectorAll('.head-actions .icon-btn')].at(-1) as HTMLElement)
    await flush()
    expect(toastText()).toContain('对话框炸了')
    cleanup()

    const cancelled = harnessOf({ nativeReplies: { pickDirectory: 42 } })
    const second = mountList(cancelled)
    await flush()
    fireEvent.click([...second.container.querySelectorAll('.head-actions .icon-btn')].at(-1) as HTMLElement)
    await flush()
    expect(callsOf(cancelled, 'newSessionIn')).toHaveLength(0)
  })
})
