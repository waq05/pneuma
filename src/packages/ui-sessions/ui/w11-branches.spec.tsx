/**
 * 侧栏会话列表（`ui-sessions/ui/ui.tsx`）的分支补测（ui 层，真渲染）。
 *
 * 既有按钮已覆盖主流程（分组 / 菜单 / 拖拽 / 空态）。这一份补：
 * 偏好字段形状坏掉时的读取兜底、写回失败的面撤销（七个字段各一条）、
 * 会话行快捷键（Enter / Ctrl+Alt+F / Ctrl+Shift+A / 双击改名）、底部用量与
 * 「添加工作区」的降级路径、`shell.session.new` 事件的两种 detail。
 *
 * @module dsc-ui-sessions/ui/w11-branches.spec
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
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

function componentAt(slot: string): ComponentType {
  const found = registered.find((item) => item.slot === slot)
  if (found === undefined) throw new Error(`没有登记：${slot}`)
  return found.component as ComponentType
}

const SessionList = componentAt('shell.sidebar')

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
  const snapshot = {
    sessions: options.sessions ?? SESSIONS,
    status: { cwd: 'D:/demo', sessionPath: 'D:/demo/a.jsonl', turnState: 'idle' },
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
    listUserMessages: ['第一条', '第二条'],
    listArchivedSessions: { items: [{ path: 'D:/archive/a.jsonl' }] },
    usageStats: { days: [] },
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
      call: (op: string): Promise<unknown> => {
        nativeCalls.push({ op, args: [] })
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

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <SessionList />
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
const groupWhere = (root: HTMLElement, text: string): HTMLElement => {
  const found = [...root.querySelectorAll('.group-row')].find((row) => row.textContent?.includes(text)) as
    | HTMLElement
    | undefined
  if (found === undefined) throw new Error(`没有工作区行：${text}`)
  return found
}
const textOf = (element: Element | null): string => element?.textContent ?? ''
const callsOf = (harness: Harness, method: string): Invoke[] => harness.calls.filter((call) => call.method === method)

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
  setThreadView('chat')
  document.querySelector('.dsc-toasts')?.remove()
})

afterEach(() => {
  cleanup()
  setShellPage(null)
  setThreadView('chat')
  localStorage.clear()
  delete (globalThis as { dscNative?: unknown }).dscNative
  document.querySelector('.dsc-toasts')?.remove()
})

describe('偏好字段的读取兜底', () => {
  test('线上值形状全错：枚举回落出厂档、坏条目被丢掉，列表照常画', async () => {
    const harness = harnessOf({
      prefs: {
        sessionGroup: 'bogus',
        sessionSort: 7,
        archivedFilter: 'nope',
        workspaceAliases: { 'D:/demo': '演示区', 'D:/other': 9 },
        sessionExpansion: { 'D:/demo': true, 'D:/other': 'yes' },
        workspaceOrder: ['D:/demo', 3, '', 'D:/other'],
        sessionOrder: { 'D:/demo': ['D:/demo/a.jsonl', 8], 'D:/other': 'nope' },
      },
    })
    const { container } = mount(harness)
    await flush()
    expect(rows(container).length).toBe(2)
    expect(container.querySelectorAll('.group').length).toBe(2)
    expect(textOf(container)).toContain('演示区')
    // 枚举全部回落到 workspace / manual / hide：标题仍按工作区分组。
    expect(textOf(container.querySelector('.side-title'))).toBe(zh['head.workspaces'])

    fireEvent.click(container.querySelectorAll('.head-actions .icon-btn')[1] as HTMLElement)
    const picks = [...container.querySelectorAll('.view-menu button')] as HTMLElement[]
    expect(picks[0]?.getAttribute('aria-checked')).toBe('true')
    expect(picks[3]?.getAttribute('aria-checked')).toBe('true')
    expect(picks[6]?.getAttribute('aria-checked')).toBe('true')
  })
})

describe('偏好写回失败：本地撤销七个字段', () => {
  test('分组 / 排序 / 筛选 / 展开 / 别名 / 工作区顺序 / 会话顺序都走撤销面', async () => {
    const harness = harnessOf({ replies: { setUiPrefs: new Error('prefs down') } })
    const { container } = mount(harness)
    await flush()

    // 工作区顺序（拖组行；这一档要求 group 还是 workspace，所以放在切分组之前）。
    // manual 档没排过序时 D:/demo 在前（首次出现时间倒序，grouping.ts:190-207），
    // 拖 demo 到 other 之前才会真的换位并写盘；拖第一组到它自己下面不写（ui.tsx:735-748）。
    const transfer = dragTransfer()
    fireEvent.dragStart(groupWhere(container, 'demo'), { dataTransfer: transfer })
    fireEvent.dragOver(groupWhere(container, 'other'), { dataTransfer: transfer })
    fireEvent.drop(groupWhere(container, 'other'), { dataTransfer: transfer })
    await flush()

    // 展开态（点组头）
    fireEvent.click(groupWhere(container, 'demo'))
    await flush()

    // 别名（组菜单 → 改名 → 回车）
    const demoRow = groupWhere(container, 'demo')
    fireEvent.click(demoRow.querySelector(`[aria-label="${zh['group.more']}"]`) as HTMLElement)
    const rename = [...container.querySelectorAll('.row-menu .menu-item')].find(
      (item) => textOf(item).trim() === zh['menu.renameGroup'],
    ) as HTMLElement
    fireEvent.click(rename)
    // 改名时组头换成输入框，input.value 不进 textContent：用改名前的行节点找它。
    const input = demoRow.querySelector('.row-rename') as HTMLInputElement
    fireEvent.change(input, { target: { value: '演示区' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()

    // 工作区顺序已在上方（切换分组之前）覆盖。

    // 会话顺序（manual 档、同组内互拖）
    const first = rowWhere(container, '甲会话')
    const second = rowWhere(container, '乙会话')
    fireEvent.dragStart(first, { dataTransfer: transfer })
    fireEvent.dragOver(second, { dataTransfer: transfer })
    fireEvent.drop(second, { dataTransfer: transfer })
    await flush()

    // 三组单选（切分组放最后：tree 档会改组的默认展开与可拖性）
    fireEvent.click(container.querySelectorAll('.head-actions .icon-btn')[1] as HTMLElement)
    const picks = [...container.querySelectorAll('.view-menu button')] as HTMLElement[]
    fireEvent.click(picks[1]!) // group: tree
    await flush()
    // 菜单点选不自动关闭：保持展开，继续点其余两组。
    const picks2 = [...container.querySelectorAll('.view-menu button')] as HTMLElement[]
    fireEvent.click(picks2[4]!) // sort: recent
    await flush()
    const picks3 = [...container.querySelectorAll('.view-menu button')] as HTMLElement[]
    fireEvent.click(picks3[7]!) // archived: show
    await flush()

    const bodies = callsOf(harness, 'setUiPrefs').map((call) => call.args[0] as Record<string, unknown>)
    expect(bodies.some((body) => body['sessionGroup'] === 'tree')).toBe(true)
    expect(bodies.some((body) => body['sessionSort'] === 'recent')).toBe(true)
    expect(bodies.some((body) => body['archivedFilter'] === 'show')).toBe(true)
    expect(bodies.some((body) => body['sessionExpansion'] !== undefined)).toBe(true)
    expect(bodies.some((body) => body['workspaceAliases'] !== undefined)).toBe(true)
    expect(bodies.some((body) => body['workspaceOrder'] !== undefined)).toBe(true)
    expect(bodies.some((body) => body['sessionOrder'] !== undefined)).toBe(true)
    // 每次失败都有回执。
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain(zh['toast.prefsFailed'].split('{')[0])
  })
})

describe('会话行的键盘与改名', () => {
  test('Enter 打开、Ctrl+Alt+F 分叉、Ctrl+Shift+A 归档、普通键不动作', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const row = rowWhere(container, '甲会话')

    fireEvent.keyDown(row, { key: 'x' })
    fireEvent.keyDown(row, { key: 'Enter' })
    await flush()
    expect(callsOf(harness, 'openSession').some((call) => call.args[0] === 'D:/demo/a.jsonl')).toBe(true)

    fireEvent.keyDown(row, { key: 'F', ctrlKey: true, altKey: true })
    await flush()
    expect(callsOf(harness, 'listUserMessages')).toHaveLength(1)
    expect(textOf(container.querySelector('.fork-picker'))).toContain('第一条')

    fireEvent.keyDown(row, { key: 'a', ctrlKey: true, shiftKey: true })
    await flush()
    expect(callsOf(harness, 'archiveSessions')[0]?.args).toEqual([['D:/demo/a.jsonl']])
  })

  test('Ctrl+Alt+R 亮出改名框：Escape 撤销、回车提交、失焦提交', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const row = rowWhere(container, '甲会话')

    fireEvent.keyDown(row, { key: 'r', ctrlKey: true, altKey: true })
    let input = row.querySelector('.row-rename') as HTMLInputElement
    expect(input.value).toBe('甲会话')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(row.querySelector('.row-rename')).toBeNull()

    fireEvent.keyDown(row, { key: 'r', ctrlKey: true, altKey: true })
    input = row.querySelector('.row-rename') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  新名字  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(callsOf(harness, 'renameSession')[0]?.args).toEqual(['D:/demo/a.jsonl', '新名字'])

    fireEvent.doubleClick(row.querySelector('.title') as HTMLElement)
    input = row.querySelector('.row-rename') as HTMLInputElement
    fireEvent.change(input, { target: { value: '失焦名' } })
    fireEvent.blur(input)
    await flush()
    expect(callsOf(harness, 'renameSession').at(-1)?.args).toEqual(['D:/demo/a.jsonl', '失焦名'])
  })

  test('归档行点开先拦下；临时行不吃行级动作与右键；未来时间不显示相对时间', async () => {
    const future = Date.now() + 60_000
    const harness = harnessOf({
      sessions: [
        session({ id: 'D:/demo/old.jsonl', title: '归档会话', archivedAt: 5 }),
        session({ id: 'D:/demo/new.jsonl', title: '临时会话', unsaved: true, updatedAt: future }),
      ],
      prefs: { archivedFilter: 'show' },
    })
    const { container } = mount(harness)
    await flush()

    fireEvent.click(rowWhere(container, '归档会话'))
    await flush()
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain(zh['row.archivedOpen'])

    const unsaved = rowWhere(container, '临时会话')
    expect(textOf(unsaved.querySelector('.when'))).toBe('')
    fireEvent.contextMenu(unsaved)
    expect(container.querySelector('.row-menu')).toBeNull()
    fireEvent.keyDown(unsaved, { key: 'a', ctrlKey: true, shiftKey: true })
    expect(callsOf(harness, 'archiveSessions')).toHaveLength(0)
  })
})

describe('底部用量与添加工作区', () => {
  test('今日用量有账：显示 tok 与金额；没有账时只显示 0 tok', async () => {
    const withCost = harnessOf({
      snapshot: { status: { cwd: 'D:/demo', sessionPath: 'D:/demo/a.jsonl', usage: { inputTokens: 100, outputTokens: 20 } } },
      replies: { usageStats: { days: [{ inputTokens: 10, outputTokens: 5, costCny: 0.25 }] } },
    })
    const first = mount(withCost)
    await flush()
    expect(textOf(first.container.querySelector('.sidebar-footer'))).toContain('15 tok')
    expect(textOf(first.container.querySelector('.sidebar-footer'))).toContain('¥')
    cleanup()

    const noCost = harnessOf({ replies: { usageStats: { days: [{ inputTokens: 1, outputTokens: 1 }] } } })
    const second = mount(noCost)
    await flush()
    expect(textOf(second.container.querySelector('.sidebar-footer'))).toContain('2 tok')
    expect(textOf(second.container.querySelector('.sidebar-footer'))).not.toContain('¥')
  })

  test('添加工作区：无原生桥给说明；选目录抛错也给说明', async () => {
    const noBridge = harnessOf({ noNative: true })
    const first = mount(noBridge)
    await flush()
    fireEvent.click([...first.container.querySelectorAll('.head-actions .icon-btn')].at(-1) as HTMLElement)
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain(zh['toast.addWorkspaceNeedsDesktop'])
    cleanup()

    const failing = harnessOf({ nativeReplies: { pickDirectory: new Error('dialog broke') } })
    const second = mount(failing)
    await flush()
    fireEvent.click([...second.container.querySelectorAll('.head-actions .icon-btn')].at(-1) as HTMLElement)
    await flush()
    expect(textOf(document.querySelector('.dsc-toasts'))).toContain('dialog broke')
  })

  test('shell.session.new 事件：带 cwd 在那目录新建，不带则新建会话', async () => {
    const harness = harnessOf()
    mount(harness)
    await flush()

    await act(async () => {
      window.dispatchEvent(new CustomEvent('shell.session.new'))
    })
    await flush()
    expect(callsOf(harness, 'openSession').some((call) => call.args.length === 0)).toBe(true)

    await act(async () => {
      window.dispatchEvent(new CustomEvent('shell.session.new', { detail: { cwd: 'D:/brand-new' } }))
    })
    await flush()
    expect(callsOf(harness, 'newSessionIn')[0]?.args).toEqual(['D:/brand-new'])
  })
})
