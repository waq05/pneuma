/**
 * 状态面板（`ui-status/ui/ui.tsx`）的分支补测（ui 层，真渲染）。
 *
 * 既有三份 spec 覆盖壳层、各分区主干与一批单帧边界。这一份用**可变快照**补它们走不到的
 * 「第二帧」：各投影的相等判断（同值不重画 / 变化才重画）、表面形状坏掉时的兜底读取、
 * 名册与任务板轮询、git 三档节奏与页面不可见、时钟两档、ResizeObserver 降级、
 * 拖动守卫与折叠桶预览卡。
 *
 * @module dsc-ui-status/ui/w11-branches.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, setThreadView, type HostChannel } from '@dsc/ui-runtime'
import type {
  GoalView,
  HostSnapshot,
  ScheduledTaskView,
  TeamBoardView,
  TeammateView,
  TodoItemView,
  UiPluginApi,
} from '@dsc/ui'
import plugin from './ui.js'

const MODE_KEY = 'dsc.statusPanel.mode'
const POS_KEY = 'dsc.statusPanel.pos'

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

interface Invoke {
  method: string
  args: unknown[]
}

interface ChannelState {
  status: Record<string, unknown>
  surfaces: Record<string, unknown>
  mates: TeammateView[] | Error
  board: TeamBoardView | null | Error
  git: Record<string, unknown> | Error
}

interface Harness {
  channel: HostChannel
  calls: Invoke[]
  state: ChannelState
  emit(): void
}

function harnessOf(initial: Partial<ChannelState> = {}): Harness {
  const state: ChannelState = {
    status: { cwd: 'C:/repo', sessionPath: 'C:/repo/abc.jsonl', sessionId: 'abc', turnState: 'idle' },
    surfaces: {},
    mates: [],
    board: null,
    git: { added: 0, removed: 0, dirtyFileCount: 0, branch: 'main' },
    ...initial,
  }
  const calls: Invoke[] = []
  const listeners = new Set<() => void>()
  const snapshot = (): HostSnapshot =>
    ({ sessions: [], status: state.status, surfaces: state.surfaces }) as unknown as HostSnapshot
  const channel: HostChannel = {
    getSnapshot: snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      if (method === 'listTeammates') {
        return (state.mates instanceof Error ? Promise.reject(state.mates) : Promise.resolve(state.mates)) as Promise<T>
      }
      if (method === 'listTeamBoard') {
        return (state.board instanceof Error ? Promise.reject(state.board) : Promise.resolve(state.board)) as Promise<T>
      }
      if (method === 'dock') {
        return (state.git instanceof Error ? Promise.reject(state.git) : Promise.resolve(state.git)) as Promise<T>
      }
      return Promise.resolve({ ok: true } as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return {
    channel,
    calls,
    state,
    emit: () => {
      for (const listener of listeners) listener()
    },
  }
}

function mount(harness: Harness, width = 900): ReturnType<typeof render> {
  const root = document.createElement('div')
  root.innerHTML =
    '<div class="main"><div class="topbar"><div class="tabs"></div></div>' +
    '<div class="thread-main" data-thread-area><div id="mount"></div></div></div>'
  document.body.append(root)
  const area = root.querySelector('[data-thread-area]') as HTMLElement
  Object.defineProperty(area, 'clientWidth', { configurable: true, value: width })
  return render(
    <RuntimeProvider channel={harness.channel}>
      <StatusPanel />
    </RuntimeProvider>,
    { container: root.querySelector('#mount') as HTMLElement },
  )
}

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })

const tabs = (): HTMLElement => document.querySelector('.topbar .tabs') as HTMLElement
const textOf = (element: Element | null | undefined): string => element?.textContent ?? ''
const section = (id: string): HTMLElement | null => tabs().querySelector(`[data-sp-section="${id}"]`)
const callsOf = (harness: Harness, method: string): Invoke[] => harness.calls.filter((call) => call.method === method)

const todo = (id: string, status: TodoItemView['status'], content: string): TodoItemView => ({ id, status, content })
const todoView = (items: TodoItemView[]): Record<string, unknown> => ({
  items,
  revision: 1,
  done: items.filter((item) => item.status === 'completed').length,
  total: items.filter((item) => item.status !== 'cancelled').length,
  active: items.find((item) => item.status === 'in_progress')?.content ?? null,
})
const goal = (over: Partial<GoalView> = {}): GoalView => ({
  objective: '把面板测完',
  phase: 'active',
  rounds: 1,
  maxRounds: 5,
  armed: true,
  ...over,
})
const mate = (over: Partial<TeammateView> & { name: string }): TeammateView => ({
  role: 'coder',
  state: 'working',
  task: '写代码',
  file: `C:/sessions/${over.name}.jsonl`,
  parent: 'lead',
  depth: 1,
  rounds: 1,
  startedAt: 1_000,
  sessionId: 'abc',
  ...over,
})
const work = (id: string, title: string): Record<string, unknown> => ({
  id,
  kind: 'job',
  title,
  startedAt: Date.now() - 5_000,
})
const plan = (file: string, title: string): Record<string, unknown> => ({ file, title, at: Date.now() - 1_000 })
const scheduled = (id: string, title: string): ScheduledTaskView => ({
  id,
  title,
  enabled: true,
  nextRunAt: null,
  lastStatus: 'ok',
  lastError: null,
})
const board = (revision: number, tasks: TeamBoardView['tasks']): TeamBoardView => ({ revision, tasks })
const boardTask = (id: string, over: Partial<TeamBoardView['tasks'][number]> = {}): TeamBoardView['tasks'][number] => ({
  id,
  subject: `任务 ${id}`,
  description: '',
  status: 'pending',
  owner: null,
  blockedBy: [],
  writeScopes: [],
  ready: true,
  ...over,
})

/** 把 document.visibilityState 临时改成指定值（jsdom 里它默认是 visible 的只读属性）。 */
function setVisibility(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  localStorage.setItem(MODE_KEY, 'panel')
  setThreadView('chat')
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
  setThreadView('chat')
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  delete (document as unknown as { visibilityState?: unknown }).visibilityState
  document.querySelector('.dsc-toasts')?.remove()
})

describe('快照面：读取兜底与相等判断', () => {
  test('表面形状坏掉时不崩；有效面出现后分区按帧更新，同值不换引用也照常渲染', async () => {
    const harness = harnessOf({ surfaces: { todos: 5, goal: 'x', backgroundWorks: {}, planDirectory: 'x', scheduled: {} } })
    mount(harness)
    await flush()
    expect(section('todo')).toBeNull()
    expect(section('goal')).toBeNull()

    harness.state.surfaces = {
      todos: todoView([todo('t1', 'in_progress', '第一项'), todo('t2', 'pending', '第二项')]),
      goal: goal(),
      backgroundWorks: [work('job-1', '构建')],
      planDirectory: [plan('C:/repo/p1.md', '方案')],
      scheduled: [scheduled('s1', '巡检')],
    }
    await act(async () => {
      harness.emit()
      await Promise.resolve()
    })
    await flush()
    expect(textOf(section('todo')?.querySelector('.sp-section-trail'))).toContain('0/2')
    expect(textOf(section('todo')?.querySelector('.sp-list'))).toContain('第一项')
    expect(textOf(section('goal'))).toContain('把面板测完')
    expect(textOf(section('terminal'))).toContain('构建')
    expect(section('plan')).not.toBeNull()
    expect(section('workflow')).not.toBeNull()

    // 同内容的新对象：相等判断应拦住重画（这里只断言界面仍然正确）。
    harness.state.surfaces = {
      ...harness.state.surfaces,
      todos: todoView([todo('t1', 'in_progress', '第一项'), todo('t2', 'pending', '第二项')]),
    }
    await act(async () => {
      harness.emit()
      await Promise.resolve()
    })
    await flush()
    expect(textOf(section('todo')?.querySelector('.sp-list'))).toContain('第一项')

    // 逐个字段变化：done / 长度 / 行内容都要走到不相等分支。
    harness.state.surfaces = {
      ...harness.state.surfaces,
      todos: todoView([todo('t1', 'completed', '第一项'), todo('t2', 'pending', '第二项')]),
    }
    await act(async () => {
      harness.emit()
      await Promise.resolve()
    })
    await flush()
    expect(textOf(section('todo')?.querySelector('.sp-section-trail'))).toContain('1/2')

    harness.state.surfaces = {
      ...harness.state.surfaces,
      todos: todoView([
        todo('t1', 'completed', '第一项'),
        todo('t2', 'pending', '第二项'),
        todo('t3', 'pending', '第三项'),
      ]),
    }
    await act(async () => {
      harness.emit()
      await Promise.resolve()
    })
    await flush()
    expect(textOf(section('todo')?.querySelector('.sp-list'))).toContain('第三项')

    harness.state.surfaces = {
      ...harness.state.surfaces,
      todos: todoView([todo('t1', 'completed', '改过的第一项'), todo('t2', 'pending', '第二项')]),
      goal: goal({ armed: false, blockedReason: '等批准' }),
      backgroundWorks: [work('job-1', '构建'), work('job-2', '测试')],
      planDirectory: [plan('C:/repo/p1.md', '新方案'), plan('C:/repo/p2.md', '第二份')],
      scheduled: [scheduled('s1', '夜间巡检')],
    }
    await act(async () => {
      harness.emit()
      await Promise.resolve()
    })
    await flush()
    expect(textOf(section('todo'))).toContain('改过的第一项')
    expect(section('goal')?.querySelector('.sp-goal-text')?.getAttribute('title')).toBe('等批准')
    expect(textOf(section('terminal'))).toContain('测试')
    expect(textOf(section('plan'))).toContain('第二份')
    expect(textOf(section('workflow'))).toContain('夜间巡检')
  })

  test('status 字段类型不对时读默认值；换路径 / 换 cwd / 回合收工触发 git 催拍', async () => {
    const harness = harnessOf({ status: { sessionPath: 5, cwd: null, turnState: 7 } })
    mount(harness)
    await flush()
    expect(callsOf(harness, 'dock').length).toBeGreaterThanOrEqual(1)

    const baseline = callsOf(harness, 'dock').length
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    harness.state.status = { sessionPath: 'C:/other/b.jsonl', cwd: 'C:/other', turnState: 'working' }
    await act(async () => {
      harness.emit()
      await Promise.resolve()
    })
    await flush()
    expect(callsOf(harness, 'dock').length).toBeGreaterThan(baseline)

    const afterPath = callsOf(harness, 'dock').length
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    harness.state.status = { ...harness.state.status, turnState: 'idle' }
    await act(async () => {
      harness.emit()
      await Promise.resolve()
    })
    await flush()
    expect(callsOf(harness, 'dock').length).toBeGreaterThan(afterPath)
  })
})

describe('轮询：git / 名册 / 任务板', () => {
  test('git 读数：脏仓库画分区，变干净撤掉；坏形状按 0 兜底', async () => {
    const harness = harnessOf({ git: { added: 2, removed: 1, dirtyFileCount: 3, branch: 'feature/x' } })
    mount(harness)
    await flush()
    expect(section('git')?.querySelector('[data-sp-git-changes]')?.getAttribute('data-sp-git-changes')).toBe('3')
    expect(section('git')?.querySelector('[data-sp-git-branch]')?.getAttribute('data-sp-git-branch')).toBe('feature/x')

    harness.state.git = { added: 0, removed: 0, dirtyFileCount: 0, branch: 'main' }
    await act(async () => {
      vi.advanceTimersByTime(12_000)
      await Promise.resolve()
    })
    await flush()
    expect(section('git')).toBeNull()

    harness.state.git = { added: 'x', removed: null, dirtyFileCount: 'y', branch: 9 }
    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
    })
    await flush()
    expect(section('git')).toBeNull()
  })

  test('页面不可见时 git 不拍；切回可见立刻补一拍；读失败退到最慢档', async () => {
    const harness = harnessOf({ git: { added: 1, removed: 0, dirtyFileCount: 1, branch: 'main' } })
    mount(harness)
    await flush()
    expect(section('git')).not.toBeNull()

    const before = callsOf(harness, 'dock').length
    setVisibility('hidden')
    await act(async () => {
      vi.advanceTimersByTime(12_000)
      await Promise.resolve()
    })
    expect(callsOf(harness, 'dock').length).toBe(before)

    setVisibility('visible')
    await act(async () => {
      await Promise.resolve()
    })
    await flush()
    expect(callsOf(harness, 'dock').length).toBeGreaterThan(before)

    harness.state.git = new Error('not a repo')
    await act(async () => {
      vi.advanceTimersByTime(12_000)
      await Promise.resolve()
    })
    await flush()
    expect(section('git')).toBeNull()
  })

  test('名册：同名单不重画、变化才更新；隐藏时不问、切回可见补一拍、失败清空', async () => {
    const harness = harnessOf({ mates: [mate({ name: 'w1' }), mate({ name: 'e1', state: 'idle' })] })
    mount(harness)
    await flush()
    expect(section('agent')).not.toBeNull()
    expect(textOf(section('agent'))).toContain('w1')

    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    await flush()
    const callsAfterFirst = callsOf(harness, 'listTeammates').length

    harness.state.mates = [mate({ name: 'w1', task: '新任务' }), mate({ name: 'e1', state: 'idle' })]
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    await flush()
    expect(callsOf(harness, 'listTeammates').length).toBe(callsAfterFirst + 1)
    expect(section('agent')?.querySelector('[title="新任务"]')).not.toBeNull()

    setVisibility('hidden')
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    expect(callsOf(harness, 'listTeammates').length).toBe(callsAfterFirst + 1)

    setVisibility('visible')
    await act(async () => {
      await Promise.resolve()
    })
    await flush()
    expect(callsOf(harness, 'listTeammates').length).toBe(callsAfterFirst + 2)

    harness.state.mates = new Error('team absent')
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    await flush()
    expect(section('agent')).toBeNull()
  })

  test('宿主推帧：订阅回调立刻重拉名册与任务板（5 秒轮询只当兜底）', async () => {
    const harness = harnessOf({
      mates: [mate({ name: 'w1' })],
      board: board(1, [boardTask('t1')]),
    })
    mount(harness)
    await flush()
    const matesBefore = callsOf(harness, 'listTeammates').length
    const boardBefore = callsOf(harness, 'listTeamBoard').length

    harness.state.mates = [mate({ name: 'w1' }), mate({ name: 'w2', state: 'idle', tokens: 58_100_000 })]
    harness.state.board = board(2, [boardTask('t1', { subject: '推帧后的任务' })])
    await act(async () => {
      harness.emit()
      await Promise.resolve()
    })
    await flush()
    // 不等 5 秒：推一帧就各多一拍。
    expect(callsOf(harness, 'listTeammates').length).toBe(matesBefore + 1)
    expect(callsOf(harness, 'listTeamBoard').length).toBe(boardBefore + 1)
    expect(textOf(section('team'))).toContain('推帧后的任务')
    expect(textOf(section('agent'))).toContain('w2')
  })

  test('任务板：同板不重画、版本 / 长度 / 字段变化才更新；null 忽略、失败清空', async () => {
    const harness = harnessOf({ board: board(1, [boardTask('t1'), boardTask('t2', { status: 'completed' })]) })
    mount(harness)
    await flush()
    expect(section('team')).not.toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    expect(section('team')).not.toBeNull()

    harness.state.board = board(2, [boardTask('t1', { subject: '新任务一' }), boardTask('t2', { status: 'completed' })])
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    await flush()
    expect(textOf(section('team'))).toContain('新任务一')

    harness.state.board = null
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    expect(section('team')).not.toBeNull()

    harness.state.board = new Error('board absent')
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    await flush()
    expect(section('team')).toBeNull()
  })
})

describe('时钟、宽度降级与折叠桶', () => {
  test('没有 ResizeObserver 时退回 window.resize 重新量宽', async () => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    const harness = harnessOf({
      surfaces: { backgroundWorks: [work('job-1', '构建')] },
    })
    mount(harness, 700)
    await flush()
    const host = tabs().querySelector('.sp-host') as HTMLElement
    expect(host.style.getPropertyValue('--sp-avail')).toBe('700px')

    const area = document.querySelector('[data-thread-area]') as HTMLElement
    Object.defineProperty(area, 'clientWidth', { configurable: true, value: 1500 })
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(host.style.getPropertyValue('--sp-avail')).toBe('1500px')
  })

  test('有在跑的后台活起 1s 快钟；收起胶囊后时钟停掉', async () => {
    const harness = harnessOf({ surfaces: { backgroundWorks: [work('job-1', '构建')] } })
    mount(harness, 1400)
    await flush()
    expect(tabs().querySelector('[data-expanded="1"]')).not.toBeNull()
    const timers = vi.getTimerCount()
    expect(timers).toBeGreaterThan(0)

    // 快钟挂在 1s interval 上；收起后那条 effect 的清理必须真的 clearInterval。
    const clearSpy = vi.spyOn(window, 'clearInterval')
    const clears = clearSpy.mock.calls.length
    fireEvent.click(tabs().querySelectorAll('.sp-toolbar .sp-icon-btn')[1] as HTMLElement)
    await flush()
    expect(tabs().querySelector('[data-expanded="1"]')).toBeNull()
    expect(clearSpy.mock.calls.length).toBeGreaterThan(clears)
    clearSpy.mockRestore()
  })

  test('折叠桶：hover 120ms 开预览卡、离开 80ms 关；触屏点按才开合；Escape 关', async () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      todo(`t${index + 1}`, index === 4 ? 'in_progress' : 'pending', `第 ${index + 1} 项`),
    )
    const harness = harnessOf({ surfaces: { todos: todoView(items) } })
    mount(harness)
    await flush()
    const folds = tabs().querySelectorAll('.sp-fold')
    expect(folds.length).toBe(2)
    const preceding = folds[0] as HTMLElement

    fireEvent.mouseEnter(preceding)
    await act(async () => {
      vi.advanceTimersByTime(120)
    })
    const card = tabs().querySelector('[data-sp-card="preceding"]') as HTMLElement | null
    expect(card).not.toBeNull()
    expect(textOf(card)).toContain('第 1 项')

    fireEvent.mouseLeave(preceding)
    await act(async () => {
      vi.advanceTimersByTime(80)
    })
    expect(tabs().querySelector('[data-sp-card="preceding"]')).toBeNull()

    fireEvent.focus(preceding)
    await act(async () => {
      vi.advanceTimersByTime(120)
    })
    expect(tabs().querySelector('[data-sp-card="preceding"]')).not.toBeNull()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(tabs().querySelector('[data-sp-card="preceding"]')).toBeNull()

    // 桌面指针：点折叠行不反转 hover 的卡。
    fireEvent.click(preceding)
    await act(async () => {
      vi.advanceTimersByTime(120)
    })
    expect(tabs().querySelector('[data-sp-card="preceding"]')).toBeNull()
  })

  test('拖动守卫：非左键 / 指针 id 不匹配 / 没真拖过都不落存档', async () => {
    class PointerEventPolyfill extends window.MouseEvent {
      readonly pointerId: number
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init)
        this.pointerId = init.pointerId ?? 0
      }
    }
    ;(window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill
    ;(globalThis as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill
    localStorage.setItem(MODE_KEY, 'mini')
    const harness = harnessOf({ surfaces: { backgroundWorks: [work('job-1', '构建')] } })
    mount(harness)
    await flush()
    const mini = tabs().querySelector('.sp-mini') as HTMLElement

    fireEvent.pointerDown(mini, { button: 2, clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(mini, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(mini, { clientX: 100, clientY: 100, pointerId: 1 })
    expect(localStorage.getItem(POS_KEY)).toBeNull()

    fireEvent.pointerDown(mini, { button: 0, clientX: 10, clientY: 10, pointerId: 2 })
    fireEvent.pointerMove(mini, { clientX: 100, clientY: 100, pointerId: 3 })
    fireEvent.pointerUp(mini, { clientX: 100, clientY: 100, pointerId: 3 })
    fireEvent.pointerUp(mini, { clientX: 100, clientY: 100, pointerId: 2 })
    expect(localStorage.getItem(POS_KEY)).toBeNull()

    // 没拖过：up 不吞 click，点击照常展开。
    fireEvent.click(mini)
    expect(tabs().querySelector('.sp')?.getAttribute('data-expanded')).toBe('1')
  })
})
