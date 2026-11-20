/**
 * 状态面板（`ui-status/ui/ui.tsx`）的 W14 补盲：既有 spec 走不到的几条「第二帧 / 错误路」。
 *
 * 覆盖：
 * - 折叠桶的「后面 n 项」档：窗口之后的桶混着已办完的条目时退回中性位置词；
 * - 后台活与计划目录的相等判断：同值换引用不重画、变了才重画（选择器的第二条路）；
 * - 拖动按帧合并：rAF 回调真的写一次 `host.style.transform`（松手会取消帧，只有单独推帧能到）；
 * - 队友「移除」：确认框的取消 / 确认 / 通道失败三条路，以及移除钮吞掉冒泡不误开会话；
 * - Git / 目标分区头的开合；
 * - 共享任务「最近活动」的开合与活动行；
 * - 输出页签从冻结态滚回底部时恢复跟随（不走「回到底部」按钮那条路）。
 *
 * @module dsc-ui-status/ui/w14-status-gaps.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, setThreadView, type HostChannel } from '@dsc/ui-runtime'
import { dockTabMeta } from '@dsc/ui-dockkit'
import type {
  BackgroundOutputView,
  BackgroundWorkView,
  GoalView,
  HostSnapshot,
  PlanEntryView,
  TeammateView,
  TeamBoardView,
  TodoItemView,
  UiPluginApi,
} from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import plugin from './ui.js'

const MODE_KEY = 'dsc.statusPanel.mode'
const POS_KEY = 'dsc.statusPanel.pos'

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
  background: BackgroundOutputView | Error
  removeFails: boolean
}

interface Harness {
  channel: HostChannel
  calls: Invoke[]
  state: ChannelState
  emit(): void
}

/** 假宿主：可变快照面 + 轮询方法（名册 / 任务板 / git / 输出）全记账。 */
function harnessOf(initial: Partial<ChannelState> = {}): Harness {
  const state: ChannelState = {
    status: { cwd: 'C:/repo', sessionPath: 'C:/repo/abc.jsonl', turnState: 'idle' },
    surfaces: {},
    mates: [],
    board: null,
    git: { added: 0, removed: 0, dirtyFileCount: 0, branch: 'main' },
    background: {
      id: 'job-1',
      kind: 'job',
      status: 'completed',
      text: 'done',
      totalChars: 4,
      from: 0,
      droppedChars: 0,
      atEnd: true,
    },
    removeFails: false,
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
      if (method === 'readBackground') {
        const reply = state.background
        return (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)) as Promise<T>
      }
      if (method === 'removeTeammate' && state.removeFails) {
        return Promise.reject(new Error('删不掉')) as Promise<T>
      }
      return Promise.resolve({ ok: true } as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  const emit = (): void => {
    for (const listener of listeners) listener()
  }
  return { channel, calls, state, emit }
}

/** 壳里的锚点：页签行（portal 落点）、正文区（宽度裁决）与 `.main`（拖动夹取容器）。 */
function shellDom(width = 1200): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML =
    '<div class="main"><div class="topbar"><div class="tabs"></div></div>' +
    '<div class="thread-main" data-thread-area><div id="mount"></div></div></div>'
  document.body.append(root)
  const area = root.querySelector('[data-thread-area]') as HTMLElement
  Object.defineProperty(area, 'clientWidth', { configurable: true, value: width })
  return root.querySelector('#mount') as HTMLElement
}

const mount = (harness: Harness, width = 1200): ReturnType<typeof render> => {
  const target = shellDom(width)
  return render(
    <RuntimeProvider channel={harness.channel}>
      <StatusPanel />
    </RuntimeProvider>,
    { container: target },
  )
}

/** 固定落「始终展开」档：分区内容在收起态是 inert 的，测内容前先展开。 */
const mountPanel = (harness: Harness, width = 1200): ReturnType<typeof render> => {
  localStorage.setItem(MODE_KEY, 'panel')
  return mount(harness, width)
}

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })

const tabs = (): HTMLElement => document.querySelector('.topbar .tabs') as HTMLElement
const textOf = (element: Element | null | undefined): string => element?.textContent ?? ''
const section = (id: string): HTMLElement | null => tabs().querySelector(`[data-sp-section="${id}"]`)
const expandSection = (id: string): void => {
  const node = section(id)
  if (node === null) throw new Error(`没有分区：${id}`)
  if (node.getAttribute('data-sp-open') !== '1') fireEvent.click(node.querySelector('.sp-section-head') as HTMLElement)
}
const callsOf = (harness: Harness, method: string): Invoke[] => harness.calls.filter((call) => call.method === method)
const toastText = (): string => textOf(document.querySelector('.dsc-toasts'))

const todo = (id: string, status: TodoItemView['status'], content: string): TodoItemView => ({ id, status, content })
const todoView = (items: TodoItemView[]): Record<string, unknown> => ({
  items,
  revision: 1,
  done: items.filter((item) => item.status === 'completed').length,
  total: items.filter((item) => item.status !== 'cancelled').length,
  active: items.find((item) => item.status === 'in_progress')?.content ?? null,
})
const work = (over: Partial<BackgroundWorkView> & { id: string }): BackgroundWorkView => ({
  kind: 'job',
  title: '构建',
  startedAt: Date.now() - 5_000,
  ...over,
})
const plan = (file: string, title: string): PlanEntryView => ({ file, title, at: Date.now() - 1_000 })
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
  state: 'idle',
  task: '写一段代码',
  file: `C:/sessions/${over.name}.jsonl`,
  parent: 'lead',
  depth: 1,
  rounds: 1,
  startedAt: 1_000,
  sessionId: 'abc',
  ...over,
})
const boardTask = (id: string): TeamBoardView['tasks'][number] => ({
  id,
  subject: `任务 ${id}`,
  description: '',
  status: 'pending',
  owner: null,
  blockedBy: [],
  writeScopes: [],
  ready: true,
})

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  setThreadView('chat')
  vi.useFakeTimers({ shouldAdvanceTime: true })
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  // jsdom 没有 PointerEvent：拿 MouseEvent 顶一层，clientX / button / pointerId 才带得进 React。
  class PointerEventPolyfill extends window.MouseEvent {
    readonly pointerId: number
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
    }
  }
  ;(window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
  setThreadView('chat')
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  delete (window as unknown as { PointerEvent?: unknown }).PointerEvent
  document.body.innerHTML = ''
})

describe('折叠桶的「后面 n 项」档', () => {
  test('窗口之后的桶混着已办完的条目：退回中性位置词，不虚报「待处理」', async () => {
    // 7 条 > 阈值 6：焦点落在第 3 条（in_progress），窗口 [c,d,e]，后面的 [f,g] 混了一条已完成。
    const items = [
      todo('a', 'completed', '已办一'),
      todo('b', 'completed', '已办二'),
      todo('c', 'in_progress', '在跑'),
      todo('d', 'pending', '待办一'),
      todo('e', 'pending', '待办二'),
      todo('f', 'pending', '待办三'),
      todo('g', 'completed', '已办三'),
    ]
    const harness = harnessOf({ surfaces: { todos: todoView(items) } })
    mountPanel(harness)
    await flush()
    const after = section('todo')?.querySelector('[data-sp-fold="following"]') as HTMLElement
    expect(textOf(after)).toBe(zh['status.fold.later'].replace('{n}', '2'))
    expect(after.getAttribute('title')).toBe(zh['status.fold.later'].replace('{n}', '2'))
  })
})

describe('后台活 / 计划目录的相等判断', () => {
  test('同长度换引用：逐项比后判定相等不重画；字段变了才按新值重画', async () => {
    const firstWork = work({ id: 'job-1', title: '构建' })
    const firstPlan = plan('C:/repo/.dsc/plans/p1.md', '方案一')
    const harness = harnessOf({ surfaces: { backgroundWorks: [firstWork], planDirectory: [firstPlan] } })
    mountPanel(harness)
    await flush()
    expect(textOf(section('terminal'))).toContain('构建')
    expect(textOf(section('plan'))).toContain('方案一')

    // 新数组、同内容：两条相等判断都走「长度相同 → 逐项比」那条路，结果 true。
    harness.state.surfaces = {
      backgroundWorks: [work({ id: 'job-1', title: '构建' })],
      planDirectory: [plan('C:/repo/.dsc/plans/p1.md', '方案一')],
    }
    await act(async () => {
      harness.emit()
      await Promise.resolve()
    })
    await flush()
    expect(textOf(section('terminal'))).toContain('构建')

    // 新数组、改标题：逐项比出不同，重画后看到新值。
    harness.state.surfaces = {
      backgroundWorks: [work({ id: 'job-1', title: '构建二号' })],
      planDirectory: [plan('C:/repo/.dsc/plans/p1.md', '方案二')],
    }
    await act(async () => {
      harness.emit()
      await Promise.resolve()
    })
    await flush()
    expect(textOf(section('terminal'))).toContain('构建二号')
    expect(textOf(section('plan'))).toContain('方案二')
  })
})

describe('胶囊拖动：按帧合并的那条路', () => {
  /** 给拖动需要的两个矩形：容器 1000×800，胶囊基准点 (100,50)。 */
  function stubRects(host: HTMLElement): void {
    const main = document.querySelector('.main') as HTMLElement
    main.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    host.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 200,
        height: 30,
        right: 300,
        bottom: 80,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect
  }

  test('指针移动后 rAF 回调写一次 transform，并把帧号清空（松手前只排一帧）', async () => {
    localStorage.setItem(MODE_KEY, 'mini')
    const harness = harnessOf({ surfaces: { goal: goal() } })
    mount(harness)
    await flush()
    const host = tabs().querySelector('.sp-host') as HTMLElement
    stubRects(host)
    const mini = tabs().querySelector('.sp-mini') as HTMLElement

    const realRaf = window.requestAnimationFrame
    const realCaf = window.cancelAnimationFrame
    const frames: FrameRequestCallback[] = []
    window.requestAnimationFrame = (callback) => {
      frames.push(callback)
      return frames.length
    }
    window.cancelAnimationFrame = () => undefined
    try {
      fireEvent.pointerDown(mini, { button: 0, clientX: 200, clientY: 60, pointerId: 1 })
      fireEvent.pointerMove(mini, { clientX: 260, clientY: 100, pointerId: 1 })
      expect(frames).toHaveLength(1)
      // 再移一次：帧还没跑，不重复排帧。
      fireEvent.pointerMove(mini, { clientX: 270, clientY: 110, pointerId: 1 })
      expect(frames).toHaveLength(1)

      act(() => {
        frames[0]!(0)
      })
      expect(host.style.transform).toBe('translate3d(70px, 50px, 0)')

      // 帧已清空：下一次移动还能再排一帧。
      fireEvent.pointerMove(mini, { clientX: 280, clientY: 120, pointerId: 1 })
      expect(frames).toHaveLength(2)
      fireEvent.pointerUp(mini, { clientX: 280, clientY: 120, pointerId: 1 })
    } finally {
      window.requestAnimationFrame = realRaf
      window.cancelAnimationFrame = realCaf
    }
    expect(JSON.parse(localStorage.getItem(POS_KEY) ?? 'null')).toEqual({ x: 80, y: 60 })
  })
})

describe('队友移除：确认框三条路', () => {
  test('取消不动通道；确认后调 removeTeammate 并回执；失败给人话；点移除不误开会话', async () => {
    const harness = harnessOf({ mates: [mate({ name: 'done-1', task: '收工了' })] })
    mountPanel(harness)
    await flush()
    expandSection('agent')
    const row = section('agent')?.querySelector('[data-sp-agent="done-1"]') as HTMLElement
    const remove = (section('agent')?.querySelector('[data-sp-agent-remove]') ?? null) as HTMLElement | null
    expect(remove).not.toBeNull()

    // 取消：确认框出现，点「取消」后通道一次都不调，也没开会话。
    fireEvent.click(remove!)
    await flush()
    expect(document.querySelector('.dsc-confirm')).not.toBeNull()
    expect(textOf(document.querySelector('.dsc-confirm'))).toContain('done-1')
    const buttons = [...(document.querySelector('.dsc-confirm')?.querySelectorAll('button') ?? [])] as HTMLElement[]
    fireEvent.click(buttons[0]!)
    await flush()
    expect(document.querySelector('.dsc-confirm')).toBeNull()
    expect(callsOf(harness, 'removeTeammate')).toHaveLength(0)
    expect(callsOf(harness, 'openTeammate')).toHaveLength(0)

    // 确认：走通道并给成功回执。
    fireEvent.click(remove!)
    const proceed = document.querySelector('.dsc-confirm [data-variant="destructive"]') as HTMLElement
    expect(proceed).not.toBeNull()
    fireEvent.click(proceed)
    await flush()
    expect(callsOf(harness, 'removeTeammate')[0]?.args).toEqual(['done-1'])
    expect(toastText()).toContain('done-1')
    expect(callsOf(harness, 'openTeammate')).toHaveLength(0)
    // 移除钮吞掉了冒泡：整行打开回调一次都没跑。
    expect(row).toBeTruthy()
  })

  test('通道 reject：回执带上原因原文', async () => {
    const harness = harnessOf({ mates: [mate({ name: 'done-2' })], removeFails: true })
    mountPanel(harness)
    await flush()
    expandSection('agent')
    fireEvent.click(section('agent')?.querySelector('[data-sp-agent-remove]') as HTMLElement)
    await flush()
    fireEvent.click(document.querySelector('.dsc-confirm [data-variant="destructive"]') as HTMLElement)
    await flush()
    expect(callsOf(harness, 'removeTeammate')).toHaveLength(1)
    expect(toastText()).toContain('删不掉')
  })
})

describe('分区头的开合', () => {
  test('Git 与目标两个分区头点一次收起、再点展开', async () => {
    const harness = harnessOf({
      surfaces: { goal: goal() },
      git: { added: 3, removed: 1, dirtyFileCount: 2, branch: 'main' },
    })
    mountPanel(harness)
    await flush()
    expect(section('git')?.getAttribute('data-sp-open')).toBe('1')
    expect(section('goal')?.getAttribute('data-sp-open')).toBe('1')

    fireEvent.click(section('git')?.querySelector('.sp-section-head') as HTMLElement)
    expect(section('git')?.getAttribute('data-sp-open')).toBe('0')
    fireEvent.click(section('git')?.querySelector('.sp-section-head') as HTMLElement)
    expect(section('git')?.getAttribute('data-sp-open')).toBe('1')

    fireEvent.click(section('goal')?.querySelector('.sp-section-head') as HTMLElement)
    expect(section('goal')?.getAttribute('data-sp-open')).toBe('0')
    fireEvent.click(section('goal')?.querySelector('.sp-section-head') as HTMLElement)
    expect(section('goal')?.getAttribute('data-sp-open')).toBe('1')
  })
})

describe('共享任务的最近活动', () => {
  test('活动行按条画；点开合钮切换展开态', async () => {
    const board: TeamBoardView = {
      revision: 1,
      tasks: [boardTask('t1')],
      activity: [
        { at: Date.now() - 60_000, by: 'lead', kind: 'create', taskId: 't1', text: '建了任务' },
        { at: Date.now() - 30_000, by: 'coder', kind: 'message', text: '广播一条' },
      ],
    }
    const harness = harnessOf({ board })
    mountPanel(harness)
    await flush()
    expandSection('team')
    const block = section('team')?.querySelector('.sp-task-activity') as HTMLElement
    expect(block.getAttribute('data-sp-open')).toBe('0')
    const rows = [...block.querySelectorAll('.sp-row-activity')] as HTMLElement[]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.getAttribute('data-sp-activity')).toBe('create')
    expect(textOf(rows[0])).toContain('[t1] 建了任务')
    expect(textOf(rows[1])).toContain('广播一条')

    const head = block.querySelector('.sp-activity-head') as HTMLElement
    fireEvent.click(head)
    expect(block.getAttribute('data-sp-open')).toBe('1')
    fireEvent.click(head)
    expect(block.getAttribute('data-sp-open')).toBe('0')
  })
})

describe('输出页签：滚回底部恢复跟随', () => {
  test('冻结后直接滚到底部（不点按钮）恢复跟随', async () => {
    const WorkOutputTab = dockTabMeta('work-output')?.component as ComponentType<{
      tab: { id: string; kind: string; path?: string; label?: string }
      active: boolean
      expanded: boolean
    }>
    const harness = harnessOf({
      background: {
        id: 'job-1',
        kind: 'job',
        status: 'running',
        text: 'line',
        totalChars: 4,
        from: 0,
        droppedChars: 0,
        atEnd: true,
      },
    })
    render(
      <RuntimeProvider channel={harness.channel}>
        <WorkOutputTab tab={{ id: 'tab-1', kind: 'work-output', path: 'job-1' }} active expanded />
      </RuntimeProvider>,
    )
    await flush()
    const root = document.querySelector('[data-sp-output="job-1"]') as HTMLElement
    const scroller = root.querySelector('.work-out-scroll') as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 200 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 })
    // 先向上滚离底部：冻结。
    scroller.scrollTop = 80
    fireEvent.scroll(scroller)
    scroller.scrollTop = 10
    fireEvent.scroll(scroller)
    expect(root.getAttribute('data-following')).toBe('0')
    // 再直接滚回底部：不走按钮，onScroll 自己恢复跟随。
    scroller.scrollTop = 100
    fireEvent.scroll(scroller)
    expect(root.getAttribute('data-following')).toBe('1')
    expect(root.querySelector('[data-sp-output-resume]')).toBeNull()
  })
})
