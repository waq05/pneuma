/**
 * 侧栏会话列表页（`ui-sessions/ui/ui.tsx`）的交互补测（ui 层，真渲染）。
 *
 * 与 `sidebar-actions.spec.tsx`（新建/打开/搜索/改名/归档）和 `unsaved-row.spec.tsx`
 * （临时行与页脚）分工：这里只补它们没铺到的面——工作区分组的展开/折叠与键盘操作、
 * 手动排序拖拽、「展开剩余」、会话行的状态点/置顶/归档/时间、右键菜单的整批动作
 * （停止/复制 ID/分叉/查看轨迹）、视图菜单的排序档、工作区新增与删除、空态/加载态、
 * 插件整页入口的可用性，以及偏好写回失败的回执。
 *
 * 挂载方式沿用既有两份 spec：照生产壳装载插件那条路收 `shell.sidebar` 的登记，
 * RuntimeProvider 给假宿主通道，`dscNative` 按用例开关。
 *
 * @module dsc-ui-sessions/ui/page.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import {
  RuntimeProvider,
  setShellPage,
  shellPage,
  setThreadView,
  shellThreadView,
  type HostChannel,
} from '@dsc/ui-runtime'
import type { HostSnapshot, SessionSummary, UiPluginApi } from '@dsc/ui'
import zh from '../locale/ui.zh.json'
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
  /** 快照上的额外字段（sessionStates / sessionsLoading 等）。 */
  snapshot?: Record<string, unknown>
  /** 通道方法应答覆盖（数组/对象/Error）。 */
  replies?: Record<string, unknown>
  /** 原生桥应答覆盖；`pickDirectory` / `recentCwds` 在这里给。 */
  nativeReplies?: Record<string, unknown>
  /** 不装原生桥（浏览器档）。 */
  noNative?: boolean
  /** 启动图帧（`getPluginsFrame`）。 */
  pluginsFrame?: unknown
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
    getPluginsFrame: () => (options.pluginsFrame ?? null) as never,
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

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <SessionList />
    </RuntimeProvider>,
  )

/** 让挂载期的一串 promise 落地（含嵌套 async）。 */
const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
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
const clearCalls = (harness: Harness): void => {
  harness.calls.length = 0
}
const toastText = (): string => textOf(document.querySelector('.dsc-toasts'))

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
  setThreadView('chat')
  setShellPage(null)
})

afterEach(() => {
  cleanup()
  setShellPage(null)
  setThreadView('chat')
  delete (globalThis as { dscNative?: unknown }).dscNative
  delete (navigator as { clipboard?: unknown }).clipboard
})

describe('工作区分组的展开 / 折叠', () => {
  test('点组行只切换自己：另一组不跟着动，展开态写回 sessionExpansion', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const other = groupWhere(container, 'other')
    expect(other.getAttribute('aria-expanded')).toBe('false')
    expect(rows(container)).toHaveLength(2)

    clearCalls(harness)
    fireEvent.click(other)
    await flush()
    expect(other.getAttribute('aria-expanded')).toBe('true')
    expect(rows(container)).toHaveLength(3)
    // 当前组（D:/demo）没被顺手收起。
    expect(groupWhere(container, 'demo').getAttribute('aria-expanded')).toBe('true')
    // 挂载期会把当前组（D:/demo）补进展开表，所以这里连它一起钉。
    expect(callsOf(harness, 'setUiPrefs')[0]?.args).toEqual([
      { sessionExpansion: { 'D:/demo': true, 'D:/other': true } },
    ])

    clearCalls(harness)
    fireEvent.click(other)
    await flush()
    expect(other.getAttribute('aria-expanded')).toBe('false')
    expect(rows(container)).toHaveLength(2)
    expect(callsOf(harness, 'setUiPrefs')[0]?.args).toEqual([
      { sessionExpansion: { 'D:/demo': true, 'D:/other': false } },
    ])
  })

  test('键盘：Enter 与空格都能开合组行，且不触发两次', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const other = groupWhere(container, 'other')
    fireEvent.keyDown(other, { key: 'Enter' })
    await flush()
    expect(other.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(other, { key: ' ' })
    await flush()
    expect(other.getAttribute('aria-expanded')).toBe('false')
  })

  test('树档：父目录默认展开、子目录默认收起；收起父目录连带藏掉后代', async () => {
    const harness = harnessOf({
      prefs: { sessionGroup: 'tree' },
      sessions: [
        session({ id: 'D:/demo/a.jsonl', updatedAt: 30, title: '甲会话' }),
        session({ id: 'D:/demo/sub/b.jsonl', cwd: 'D:/demo/sub', updatedAt: 20, title: '子会话' }),
        session({ id: 'D:/other/c.jsonl', cwd: 'D:/other', updatedAt: 10, title: '丙会话' }),
      ],
    })
    const { container } = mount(harness)
    await flush()
    // 父 + 子 + other 三行组头；子组收着，所以它的会话不画。
    expect(groups(container)).toHaveLength(3)
    expect(rowWhere(container, '甲会话')).toBeTruthy()
    expect(container.querySelectorAll('.sess-item')).toHaveLength(1)
    expect(groupWhere(container, 'sub').getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(groupWhere(container, 'demo'))
    await flush()
    // 父收起 → 子组头也不在列表里。
    expect(groups(container)).toHaveLength(2)
    expect(container.querySelectorAll('.sess-item')).toHaveLength(0)
  })

  test('每组默认露 5 条，「展开剩余」加量、再点收起', async () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      session({ id: `D:/demo/${String(index)}.jsonl`, updatedAt: 100 - index, title: `会话${String(index)}` }),
    )
    const harness = harnessOf({ sessions: many })
    const { container } = mount(harness)
    await flush()
    expect(container.querySelectorAll('.sess-item')).toHaveLength(5)
    const more = container.querySelector('.session-overflow') as HTMLElement
    expect(textOf(more)).toBe('展开剩余 2 个会话')

    fireEvent.click(more)
    expect(container.querySelectorAll('.sess-item')).toHaveLength(7)
    expect(textOf(container.querySelector('.session-overflow'))).toBe('收起')

    fireEvent.click(container.querySelector('.session-overflow') as HTMLElement)
    expect(container.querySelectorAll('.sess-item')).toHaveLength(5)
  })

  test('收起组会重置「展开剩余」进度，下次展开从头数 5 条', async () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      session({ id: `D:/demo/${String(index)}.jsonl`, updatedAt: 100 - index, title: `会话${String(index)}` }),
    )
    const harness = harnessOf({ sessions: many })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelector('.session-overflow') as HTMLElement)
    expect(container.querySelectorAll('.sess-item')).toHaveLength(7)

    fireEvent.click(groupWhere(container, 'demo'))
    await flush()
    expect(container.querySelectorAll('.sess-item')).toHaveLength(0)
    fireEvent.click(groupWhere(container, 'demo'))
    await flush()
    expect(container.querySelectorAll('.sess-item')).toHaveLength(5)
  })
})

describe('会话行的渲染与行内动作', () => {
  test('运行状态点顶替图钉；没有状态才有图钉钮，点一下把置顶写回宿主', async () => {
    const harness = harnessOf({ snapshot: { sessionStates: { 'D:/demo/b.jsonl': 'working' } } })
    const { container } = mount(harness)
    await flush()
    const working = rowWhere(container, '乙会话')
    const dot = working.querySelector('.session-dot.working')
    expect(dot?.getAttribute('aria-label')).toBe(zh['dot.working'])
    expect(working.querySelector('.lead-pin')).toBeNull()

    const idle = rowWhere(container, '甲会话')
    const pin = idle.querySelector('.lead-pin') as HTMLElement
    expect(pin.getAttribute('aria-label')).toBe(zh['menu.pin'])
    clearCalls(harness)
    fireEvent.click(pin)
    await flush()
    expect(callsOf(harness, 'setSessionPinned')[0]?.args).toEqual(['D:/demo/a.jsonl', true])
    // 行内按钮不该顺带打开会话。
    expect(callsOf(harness, 'openSession')).toHaveLength(0)
  })

  test('已归档行：带 archived 类、行尾是「恢复」，点行只给提示不开会话', async () => {
    const archived = session({
      id: 'D:/demo/old.jsonl',
      archivedAt: 50,
      updatedAt: 40,
      title: '旧会话',
    })
    const harness = harnessOf({ sessions: [archived], prefs: { archivedFilter: 'show' } })
    const { container } = mount(harness)
    await flush()
    const row = rowWhere(container, '旧会话')
    expect(row.className).toContain('archived')
    const restore = row.querySelector('.row-actions button') as HTMLElement
    expect(restore.getAttribute('aria-label')).toBe(zh['menu.restore'])

    fireEvent.click(restore)
    await flush()
    expect(callsOf(harness, 'restoreSessions')[0]?.args).toEqual([['D:/demo/old.jsonl']])

    clearCalls(harness)
    fireEvent.click(row)
    await flush()
    expect(callsOf(harness, 'openSession')).toHaveLength(0)
    expect(toastText()).toContain(zh['row.archivedOpen'])
  })

  test('创建时间档的行尾时间读 createdAt；最近更新档读 updatedAt', async () => {
    const now = Date.now()
    const items = [
      session({ id: 'D:/demo/a.jsonl', createdAt: now - 2 * 60_000, updatedAt: now - 3 * 86_400_000, title: '甲会话' }),
      session({ id: 'D:/demo/b.jsonl', createdAt: now - 4 * 86_400_000, updatedAt: now - 20, title: '乙会话' }),
    ]
    const created = harnessOf({ sessions: items, prefs: { sessionSort: 'created' } })
    const first = mount(created)
    await flush()
    expect(textOf(rowWhere(first.container, '甲会话').querySelector('.when'))).toBe('2分钟')
    cleanup()

    const recent = harnessOf({ sessions: items, prefs: { sessionSort: 'recent' } })
    const second = mount(recent)
    await flush()
    expect(textOf(rowWhere(second.container, '甲会话').querySelector('.when'))).toBe('3天')
  })

  test('指针进入时量标题溢出：溢出才挂 data-overflow 与位移变量', async () => {
    const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 100 })
    try {
      const harness = harnessOf()
      const { container } = mount(harness)
      await flush()
      const row = rowWhere(container, '甲会话')
      const title = row.querySelector('.title') as HTMLElement
      expect(title.getAttribute('data-overflow')).toBeNull()
      fireEvent.pointerEnter(row)
      expect(title.getAttribute('data-overflow')).toBe('1')
      expect(title.getAttribute('style')).toContain('--title-shift: -100px')
      // 长标题滚得久一点：1400 + 100*22。
      expect(title.getAttribute('style')).toContain('--title-dur: 3600ms')
    } finally {
      if (scrollWidth === undefined) delete (HTMLElement.prototype as { scrollWidth?: unknown }).scrollWidth
      else Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scrollWidth)
      if (clientWidth === undefined) delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth
      else Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
    }
  })

  test('视图菜单的排序档：当前档打勾，点了把 sessionSort 写回并关掉菜单', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelectorAll('.head-actions .icon-btn')[1] as HTMLElement)
    const picks = [...container.querySelectorAll('.view-menu button')] as HTMLElement[]
    expect(picks).toHaveLength(9)
    // 排序三档在 3–5；出厂档是手动，所以第 3 项打勾。
    expect(picks[3]?.getAttribute('aria-checked')).toBe('true')
    clearCalls(harness)
    fireEvent.click(picks[4]!)
    await flush()
    expect(callsOf(harness, 'setUiPrefs')[0]?.args).toEqual([{ sessionSort: 'recent' }])
    fireEvent.click(container.querySelector('.menu-backdrop') as HTMLElement)
    expect(container.querySelector('.view-menu')).toBeNull()
  })
})

describe('行级菜单（右键）的整批动作', () => {
  const menuItem = (container: HTMLElement, text: string): HTMLElement => {
    const items = [...container.querySelectorAll('.row-menu .menu-item')] as HTMLElement[]
    // 菜单项里 icon 与文案之间有一个字面空格，比之前先 trim。
    const found = items.find((item) => textOf(item).trim().startsWith(text))
    if (found === undefined) throw new Error(`没有菜单项：${text}`)
    return found
  }

  test('置顶项与工作状态的「停止运行」：各回传自己的方法', async () => {
    const harness = harnessOf({ snapshot: { sessionStates: { 'D:/demo/b.jsonl': 'working' } } })
    const { container } = mount(harness)
    await flush()
    fireEvent.contextMenu(rowWhere(container, '乙会话'), { clientX: 40, clientY: 40 })
    expect(menuItem(container, zh['menu.stop'])).toBeTruthy()
    fireEvent.click(menuItem(container, zh['menu.stop']))
    await flush()
    expect(callsOf(harness, 'interrupt')[0]?.args).toEqual(['D:/demo/b.jsonl'])

    clearCalls(harness)
    fireEvent.contextMenu(rowWhere(container, '甲会话'), { clientX: 40, clientY: 40 })
    fireEvent.click(menuItem(container, zh['menu.pin']))
    await flush()
    expect(callsOf(harness, 'setSessionPinned')[0]?.args).toEqual(['D:/demo/a.jsonl', true])
  })

  test('复制会话 ID：写进剪贴板的是剥掉 .jsonl 的 uuid', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    fireEvent.contextMenu(rowWhere(container, '乙会话'), { clientX: 40, clientY: 40 })
    fireEvent.click(menuItem(container, zh['menu.copyId']))
    await flush()
    expect(writeText).toHaveBeenCalledWith('b')
    expect(toastText()).toContain(zh['toast.idCopied'])
  })

  test('查看轨迹：切正文区到轨迹页并打开这条会话', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    fireEvent.contextMenu(rowWhere(container, '乙会话'), { clientX: 40, clientY: 40 })
    fireEvent.click(menuItem(container, zh['menu.trace']))
    await flush()
    expect(shellThreadView()).toBe('trace')
    expect(callsOf(harness, 'openSession')[0]?.args).toEqual(['D:/demo/b.jsonl'])
  })

  test('分叉：先列用户消息，选一条后调 forkSession 并打开新会话；长消息压成一行截断', async () => {
    const long = `${'很长的用户消息'.repeat(10)}\n第二行`
    const harness = harnessOf({ replies: { listUserMessages: ['第一句', long] } })
    const { container } = mount(harness)
    await flush()
    fireEvent.contextMenu(rowWhere(container, '乙会话'), { clientX: 40, clientY: 40 })
    fireEvent.click(menuItem(container, zh['menu.fork']))
    await flush()
    const picks = [...container.querySelectorAll('.fork-item')] as HTMLElement[]
    expect(picks).toHaveLength(2)
    const shown = textOf(picks[1]?.querySelector('.txt') ?? null)
    expect(shown.endsWith('…')).toBe(true)
    expect(shown).not.toContain('\n')
    expect(Array.from(shown)).toHaveLength(61)

    fireEvent.click(picks[1]!)
    await flush()
    expect(callsOf(harness, 'forkSession')[0]?.args).toEqual(['D:/demo/b.jsonl', 1])
    expect(callsOf(harness, 'openSession')[0]?.args).toEqual(['D:/demo/fork.jsonl'])
    expect(toastText()).toContain('第 2 条')
  })

  test('用户消息不足两条：给提示、不开选择器', async () => {
    const harness = harnessOf({ replies: { listUserMessages: ['只有一句'] } })
    const { container } = mount(harness)
    await flush()
    fireEvent.contextMenu(rowWhere(container, '乙会话'), { clientX: 40, clientY: 40 })
    fireEvent.click(menuItem(container, zh['menu.fork']))
    await flush()
    expect(container.querySelector('.fork-picker')).toBeNull()
    expect(toastText()).toContain(zh['fork.tooFew'])
  })
})

describe('工作区新增、改名与删除', () => {
  test('「添加工作区」没有原生桥：给桌面版提示，不发请求', async () => {
    const harness = harnessOf({ noNative: true })
    const { container } = mount(harness)
    await flush()
    const add = [...container.querySelectorAll('.head-actions .icon-btn')].at(-1) as HTMLElement
    expect(add.getAttribute('aria-label')).toBe(zh['addWorkspace.label'])
    fireEvent.click(add)
    await flush()
    expect(callsOf(harness, 'newSessionIn')).toHaveLength(0)
    expect(toastText()).toContain(zh['toast.addWorkspaceNeedsDesktop'])
  })

  test('选到目录：在那个目录开新会话、记进最近工作区，空组立刻出现', async () => {
    const harness = harnessOf({ nativeReplies: { pickDirectory: 'D:/brand-new' } })
    const { container } = mount(harness)
    await flush()
    const add = [...container.querySelectorAll('.head-actions .icon-btn')].at(-1) as HTMLElement
    fireEvent.click(add)
    await flush()
    expect(callsOf(harness, 'newSessionIn')[0]?.args).toEqual(['D:/brand-new'])
    expect(harness.nativeCalls.find((call) => call.op === 'rememberCwd')?.args).toEqual(['D:/brand-new'])
    // 空工作区只能经这份清单进列表：补行之后组头就在了。
    expect(groupWhere(container, 'brand-new')).toBeTruthy()
  })

  test('选目录被取消（空串）：什么都不发', async () => {
    const harness = harnessOf({ nativeReplies: { pickDirectory: '' } })
    const { container } = mount(harness)
    await flush()
    fireEvent.click([...container.querySelectorAll('.head-actions .icon-btn')].at(-1) as HTMLElement)
    await flush()
    expect(callsOf(harness, 'newSessionIn')).toHaveLength(0)
  })

  test('组头「在此工作区新建会话」：收着的组先展开，再报 newSessionIn', async () => {
    const harness = harnessOf({ prefs: { sessionExpansion: { 'D:/other': false } } })
    const { container } = mount(harness)
    await flush()
    const other = groupWhere(container, 'other')
    const newIn = other.querySelector(`[aria-label="${zh['group.newInLabel']}"]`) as HTMLElement
    clearCalls(harness)
    fireEvent.click(newIn)
    await flush()
    expect(callsOf(harness, 'setUiPrefs')[0]?.args).toEqual([
      { sessionExpansion: { 'D:/demo': true, 'D:/other': true } },
    ])
    expect(callsOf(harness, 'newSessionIn')[0]?.args).toEqual(['D:/other'])
  })

  test('工作区 ··· 菜单改名：别名写回 workspaceAliases，组头当场换字', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    clearCalls(harness)
    const groupRow = groupWhere(container, 'demo')
    fireEvent.click(groupRow.querySelector(`[aria-label="${zh['group.more']}"]`) as HTMLElement)
    const items = [...container.querySelectorAll('.row-menu .menu-item')] as HTMLElement[]
    const rename = items.find((item) => textOf(item).trim() === zh['menu.renameGroup'])
    expect(rename).toBeTruthy()
    fireEvent.click(rename as HTMLElement)
    // 改名时组头换成输入框，input.value 不进 textContent，所以按 DOM 位置找。
    const input = groupRow.querySelector('.row-rename') as HTMLInputElement | null
    expect(input).toBeTruthy()
    if (input === null) throw new Error('没有出现改名输入框')
    fireEvent.change(input, { target: { value: '演示区' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(callsOf(harness, 'setUiPrefs')[0]?.args).toEqual([{ workspaceAliases: { 'D:/demo': '演示区' } }])
    expect(textOf(groupWhere(container, '演示区'))).toContain('演示区')
  })

  test('删除工作区：弹确认框，确认后归档该组全部会话并重扫', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    fireEvent.click(groupWhere(container, 'demo').querySelector(`[aria-label="${zh['group.more']}"]`) as HTMLElement)
    const del = [...container.querySelectorAll('.row-menu .menu-item')].find(
      (item) => textOf(item).trim() === zh['menu.deleteWorkspace'],
    ) as HTMLElement
    fireEvent.click(del)
    await flush()
    const confirm = document.querySelector('.dsc-confirm')
    expect(confirm).not.toBeNull()
    expect(textOf(confirm)).toContain('删除工作区「demo」？')
    const proceed = [...(confirm?.querySelectorAll('button') ?? [])].find((button) => textOf(button).trim() === zh['common.delete'])
    expect(proceed).toBeTruthy()
    clearCalls(harness)
    fireEvent.click(proceed as HTMLElement)
    await flush()
    expect(callsOf(harness, 'archiveSessions')[0]?.args).toEqual([['D:/demo/a.jsonl', 'D:/demo/b.jsonl']])
    expect(callsOf(harness, 'refreshSessions')).not.toHaveLength(0)
    expect(toastText()).toContain('2 个会话已归档')
  })

  test('删除空工作区：只从侧边栏移除，不归档任何会话', async () => {
    const harness = harnessOf({ sessions: [], nativeReplies: { recentCwds: ['D:/empty'] } })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(groupWhere(container, 'empty').querySelector(`[aria-label="${zh['group.more']}"]`) as HTMLElement)
    fireEvent.click(
      [...container.querySelectorAll('.row-menu .menu-item')].find(
        (item) => textOf(item).trim() === zh['menu.deleteWorkspace'],
      ) as HTMLElement,
    )
    await flush()
    const confirm = document.querySelector('.dsc-confirm')
    expect(textOf(confirm)).toContain(zh['workspace.deleteEmpty'])
    const proceed = [...(confirm?.querySelectorAll('button') ?? [])].find((button) => textOf(button).trim() === zh['common.delete'])
    clearCalls(harness)
    fireEvent.click(proceed as HTMLElement)
    await flush()
    expect(callsOf(harness, 'archiveSessions')).toHaveLength(0)
    expect(toastText()).toContain(zh['toast.workspaceRemoved'])
    expect(container.querySelector('.group-row')).toBeNull()
  })
})

describe('手动排序拖拽（可靠部分）', () => {
  test('拖组行到另一组上方：workspaceOrder 按落点写回', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const transfer = dragTransfer()
    const demo = groupWhere(container, 'demo')
    const other = groupWhere(container, 'other')
    clearCalls(harness)
    // manual 档还没排过序时组序是 D:/demo 在前（首次出现时间倒序，grouping.ts:190-207）。
    // jsdom 的 DragEvent 不带 clientY，组行恒按「落在上半段」算 → 拖 demo 到 other 之前。
    fireEvent.dragStart(demo, { dataTransfer: transfer })
    fireEvent.dragOver(other, { dataTransfer: transfer })
    expect(other.parentElement?.className).toContain('drop-above')
    fireEvent.drop(other, { dataTransfer: transfer })
    await flush()
    expect(callsOf(harness, 'setUiPrefs')[0]?.args).toEqual([{ workspaceOrder: ['D:/demo', 'D:/other'] }])
  })

  test('拖会话行到同组同置顶块的下方：sessionOrder 按落点写回', async () => {
    const harness = harnessOf({
      sessions: [
        session({ id: 'D:/demo/a.jsonl', updatedAt: 20, title: '甲会话' }),
        session({ id: 'D:/demo/b.jsonl', updatedAt: 10, title: '乙会话' }),
      ],
    })
    const { container } = mount(harness)
    await flush()
    const transfer = dragTransfer()
    const first = rowWhere(container, '甲会话')
    const second = rowWhere(container, '乙会话')
    expect(first.getAttribute('draggable')).toBe('true')
    clearCalls(harness)
    // jsdom 里 `clientY` 恒为 0，会话行按「落在下半段」算 → 把甲拖到乙之后。
    fireEvent.dragStart(first, { dataTransfer: transfer })
    fireEvent.dragOver(second, { dataTransfer: transfer })
    expect(second.className).toContain('drop-below')
    fireEvent.drop(second, { dataTransfer: transfer })
    await flush()
    expect(callsOf(harness, 'setUiPrefs')[0]?.args).toEqual([
      { sessionOrder: { 'D:/demo': ['D:/demo/b.jsonl', 'D:/demo/a.jsonl'] } },
    ])
  })
})

describe('空态、加载态与故障回执', () => {
  test('加载中：给「正在读会话列表…」而不是空历史提示', async () => {
    const harness = harnessOf({ sessions: [], snapshot: { sessionsLoading: true } })
    const { container } = mount(harness)
    await flush()
    const empty = container.querySelector('.sidebar-empty')
    expect(textOf(empty)).toContain(zh['list.loading'])
    expect(textOf(empty)).not.toContain(zh['list.emptyHint'])
  })

  test('搜索无匹配：把人话里的关键词原样带出来', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelectorAll('.head-actions .icon-btn')[0] as HTMLElement)
    fireEvent.change(container.querySelector('.side-search input') as HTMLInputElement, { target: { value: 'zzz' } })
    const empty = container.querySelector('.sidebar-empty')
    expect(textOf(empty)).toBe(zh['list.noMatch'].replace('{query}', 'zzz'))
  })

  test('只看归档但一条都没有 / 全被隐藏：两种空态文案分开', async () => {
    const only = harnessOf({ prefs: { archivedFilter: 'only' } })
    const first = mount(only)
    await flush()
    expect(textOf(first.container.querySelector('.sidebar-empty'))).toContain(zh['list.noArchived'])
    cleanup()

    const hidden = harnessOf({
      sessions: [session({ id: 'D:/demo/old.jsonl', archivedAt: 9, updatedAt: 8, title: '旧会话' })],
    })
    const second = mount(hidden)
    await flush()
    expect(textOf(second.container.querySelector('.sidebar-empty'))).toContain(zh['list.allArchived'])
  })

  test('偏好写回失败：回执写明原因，且不重扫列表', async () => {
    const harness = harnessOf({ replies: { setSessionPinned: { ok: false, error: '文件被占用' } } })
    const { container } = mount(harness)
    await flush()
    clearCalls(harness)
    fireEvent.click(rowWhere(container, '甲会话').querySelector('.lead-pin') as HTMLElement)
    await flush()
    expect(toastText()).toContain('操作失败：文件被占用')
    expect(callsOf(harness, 'refreshSessions')).toHaveLength(0)
  })
})

describe('插件整页入口的可用性', () => {
  test('启动图里没有 plugins 条目：不画「插件」钮，只剩技能入口', async () => {
    const harness = harnessOf({ pluginsFrame: { graph: { entries: [{ id: 'skills' }] } } })
    const { container } = mount(harness)
    await flush()
    const nav = [...container.querySelectorAll('.sidebar-nav .nav-item')] as HTMLElement[]
    expect(nav).toHaveLength(1)
    expect(textOf(nav[0])).toContain(zh['nav.skills'])
  })

  test('正停在插件页时插件被停用：自动退回对话页', async () => {
    setShellPage('plugins')
    const harness = harnessOf({ pluginsFrame: { graph: { entries: [{ id: 'skills' }] } } })
    mount(harness)
    await flush()
    expect(shellPage()).toBeNull()
  })
})
