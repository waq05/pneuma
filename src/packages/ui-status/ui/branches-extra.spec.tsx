/**
 * 状态面板（`ui-status/ui/ui.tsx`）的分支补测。
 *
 * 既有 `ui.spec.tsx` 压壳层、`sections.spec.tsx` 压各分区主干。这一份只补它们没走到的
 * 分支：展示档存档坏掉 / 宽正文自动展开 / 模式菜单遮罩与收起、胶囊拖动（写盘、吸附、
 * 越界夹取、没有可拖容器）、失败回执的四个动作、子智能体服务缺席时的右栏兜底、
 * 全完成的任务板与 blocked 目标 / 暂停的工作流读数，以及后台输出页签的
 * 「不可见不拉、运行中续拉、各状态词、加载首帧」。
 *
 * @module dsc-ui-status/ui/branches-extra.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, setThreadView, type HostChannel } from '@dsc/ui-runtime'
import { dockSurface, dockTabMeta, registerDockTab } from '@dsc/ui-dockkit'
import type {
  BackgroundOutputView,
  BackgroundWorkView,
  DockTabBodyProps,
  HostSnapshot,
  ScheduledTaskView,
  TeammateView,
  TeamBoardView,
  TodoItemView,
  UiPluginApi,
} from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import plugin from './ui.js'

const MODE_KEY = 'dsc.statusPanel.mode'
const POS_KEY = 'dsc.statusPanel.pos'

/** 面板不直接导出：照壳装载插件那条路收 `shell.main` 的登记。 */
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
const WorkOutputTab = dockTabMeta('work-output')?.component as ComponentType<DockTabBodyProps>

interface Invoke {
  method: string
  args: unknown[]
}

interface HarnessOptions {
  surfaces?: Record<string, unknown>
  status?: Record<string, unknown>
  teammates?: TeammateView[]
  board?: TeamBoardView | null
  background?: BackgroundOutputView | Error
  /** 指定方法返回失败（不是抛异常，是 invoke 直接 reject）。 */
  reject?: Record<string, Error>
  /** `stopBackground` 成功时的回执文本。 */
  stopBackgroundText?: string
}

interface Harness {
  channel: HostChannel
  calls: Invoke[]
}

function harnessOf(options: HarnessOptions = {}): Harness {
  const calls: Invoke[] = []
  const snapshot = {
    sessions: [],
    status: {
      cwd: 'C:/repo',
      sessionPath: 'C:/repo/abc.jsonl',
      sessionId: 'abc',
      turnState: 'idle',
      ...(options.status ?? {}),
    },
    surfaces: options.surfaces ?? {},
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
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      const failure = options.reject?.[method]
      if (failure !== undefined) return Promise.reject(failure)
      if (method === 'listTeammates') return Promise.resolve((options.teammates ?? []) as unknown as T)
      if (method === 'listTeamBoard') return Promise.resolve((options.board ?? null) as unknown as T)
      if (method === 'stopBackground') return Promise.resolve((options.stopBackgroundText ?? '') as unknown as T)
      if (method === 'dock') return Promise.resolve({} as T)
      if (method === 'readBackground') {
        const reply = options.background ?? { status: 'completed', text: '', totalChars: 0, from: 0, droppedChars: 0, atEnd: true }
        return (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)) as Promise<T>
      }
      return Promise.resolve({ ok: true } as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

/**
 * 壳锚点。`nested` 把顶栏放进 `.main` 里（拖动的夹取容器），默认是分隔的两块。
 * `width` 直接打在正文区上，绕开 jsdom 的 0 宽度。
 */
function mount(
  harness: Harness,
  options: { width?: number; nested?: boolean } = {},
): ReturnType<typeof render> {
  const root = document.createElement('div')
  root.innerHTML = options.nested === true
    ? '<div class="main"><div class="topbar"><div class="tabs"></div></div>' +
      '<div class="thread-main" data-thread-area><div id="mount"></div></div></div>'
    : '<div class="topbar"><div class="tabs"></div></div>' +
      '<div class="thread-main" data-thread-area><div id="mount"></div></div>'
  document.body.append(root)
  if (options.width !== undefined) {
    const area = root.querySelector('[data-thread-area]') as HTMLElement
    Object.defineProperty(area, 'clientWidth', { configurable: true, value: options.width })
  }
  const target = root.querySelector('#mount') as HTMLElement
  return render(
    <RuntimeProvider channel={harness.channel}>
      <StatusPanel />
    </RuntimeProvider>,
    { container: target },
  )
}

const mountPanel = (harness: Harness, options: { width?: number; nested?: boolean } = {}): ReturnType<typeof render> => {
  localStorage.setItem(MODE_KEY, 'panel')
  return mount(harness, options)
}

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })

const tabs = (): HTMLElement => document.querySelector('.topbar .tabs') as HTMLElement
const textOf = (element: Element | null | undefined): string => element?.textContent ?? ''
const section = (id: string): HTMLElement | null => tabs().querySelector(`[data-sp-section="${id}"]`)
const expandSection = (id: string): void => {
  const node = section(id)
  if (node === null) throw new Error(`没有分区：${id}`)
  if (node.getAttribute('data-sp-open') !== '1') fireEvent.click(node.querySelector('.sp-section-head') as HTMLElement)
}
const toastText = (): string => textOf(document.querySelector('.dsc-toasts'))
const callsOf = (harness: Harness, method: string): Invoke[] => harness.calls.filter((call) => call.method === method)

const todo = (id: string, status: TodoItemView['status'], content: string): TodoItemView => ({ id, status, content })
const todoView = (items: TodoItemView[]): Record<string, unknown> => ({
  items,
  revision: 1,
  done: items.filter((item) => item.status === 'completed').length,
  total: items.filter((item) => item.status !== 'cancelled').length,
  active: items.find((item) => item.status === 'in_progress')?.content ?? null,
})

const mate = (over: Partial<TeammateView> & { name: string }): TeammateView => ({
  role: 'coder',
  state: 'working',
  task: '写一段代码',
  file: `C:/sessions/${over.name}.jsonl`,
  parent: 'lead',
  depth: 1,
  rounds: 1,
  startedAt: 1000,
  sessionId: 'abc',
  ...over,
})

const work = (over: Partial<BackgroundWorkView> & { id: string }): BackgroundWorkView => ({
  kind: 'job',
  title: '构建',
  startedAt: Date.now() - 5_000,
  ...over,
})

const task = (over: Partial<ScheduledTaskView> & { id: string }): ScheduledTaskView => ({
  title: '巡检',
  enabled: true,
  nextRunAt: null,
  lastStatus: 'ok',
  lastError: null,
  ...over,
})

const SURFACES = {
  goal: { objective: '把面板测完', phase: 'active', rounds: 1, maxRounds: 5, armed: true },
  todos: todoView([todo('t1', 'in_progress', '再写用例'), todo('t2', 'pending', '最后收尾')]),
  backgroundWorks: [work({ id: 'job-1', title: '构建' })],
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  setThreadView('chat')
  // jsdom 没有 PointerEvent：拿 MouseEvent 顶一层，clientX / button 才带得进 React 的合成事件。
  class PointerEventPolyfill extends window.MouseEvent {
    readonly pointerId: number
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
    }
  }
  ;(window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill
  ;(globalThis as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill
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
  delete (window as unknown as { PointerEvent?: unknown }).PointerEvent
  delete (globalThis as unknown as { PointerEvent?: unknown }).PointerEvent
  document.body.innerHTML = ''
})

describe('展示档与模式菜单', () => {
  test('存档里的模式认不出时按自动档；坏 JSON 的位置存档不影响挂载', async () => {
    localStorage.setItem(MODE_KEY, 'weird')
    localStorage.setItem(POS_KEY, '{broken')
    mount(harnessOf({ surfaces: SURFACES }))
    await flush()
    const panel = tabs().querySelector('.sp') as HTMLElement
    expect(panel.getAttribute('data-display-mode')).toBe('auto')
    expect(panel.getAttribute('data-expanded')).toBe('0')
    fireEvent.click(tabs().querySelector('.sp-mini') as HTMLElement)
    expect(panel.getAttribute('data-expanded')).toBe('1')
    expect(localStorage.getItem(MODE_KEY)).toBe('panel')
  })

  test('读存档本身抛异常（隐私模式）：当自动档，面板照常画', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('存储被禁')
    })
    try {
      mount(harnessOf({ surfaces: SURFACES }))
      await flush()
      expect(tabs().querySelector('.sp-mini')).not.toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  test('正文区够宽时自动档直接展开；遮罩收起菜单、收起钮落回胶囊并写盘', async () => {
    mount(harnessOf({ surfaces: SURFACES }), { width: 1400 })
    await flush()
    const panel = tabs().querySelector('.sp') as HTMLElement
    expect(panel.getAttribute('data-expanded')).toBe('1')
    const host = tabs().querySelector('.sp-host') as HTMLElement
    expect(host.style.getPropertyValue('--sp-avail')).toBe('1400px')

    const [menuButton, collapse] = [...tabs().querySelectorAll('.sp-toolbar .sp-icon-btn')] as HTMLElement[]
    fireEvent.click(menuButton!)
    expect(tabs().querySelector('.sp-menu')).not.toBeNull()
    fireEvent.click(tabs().querySelector('.sp-mask') as HTMLElement)
    expect(tabs().querySelector('.sp-menu')).toBeNull()
    expect(panel.getAttribute('data-expanded')).toBe('1')

    fireEvent.click(collapse!)
    await flush()
    expect(panel.getAttribute('data-expanded')).toBe('0')
    expect(localStorage.getItem(MODE_KEY)).toBe('mini')
  })

  test('正文区不画面板：切到轨迹页时只剩隐藏哨兵', async () => {
    setThreadView('trace')
    mount(harnessOf({ surfaces: SURFACES }))
    await flush()
    expect(tabs().querySelector('.sp-mini')).toBeNull()
    expect((document.querySelector('.sp-host') as HTMLElement).hasAttribute('hidden')).toBe(true)
  })
})

describe('胶囊拖动', () => {
  /** 给拖动需要的两个矩形：容器 1000×800，胶囊基准点 (100,50)。 */
  function stubRects(host: HTMLElement, applied: { x: number; y: number }): void {
    const main = document.querySelector('.main') as HTMLElement
    main.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    host.getBoundingClientRect = () =>
      ({
        left: 100 + applied.x,
        top: 50 + applied.y,
        width: 200,
        height: 30,
        right: 300 + applied.x,
        bottom: 80 + applied.y,
        x: 100 + applied.x,
        y: 50 + applied.y,
        toJSON: () => ({}),
      }) as DOMRect
  }

  test('拖过阈值：位置写盘、松手后的补发 click 不再展开面板', async () => {
    localStorage.setItem(MODE_KEY, 'mini')
    mount(harnessOf({ surfaces: SURFACES }), { nested: true })
    await flush()
    const host = tabs().querySelector('.sp-host') as HTMLElement
    stubRects(host, { x: 0, y: 0 })
    const mini = tabs().querySelector('.sp-mini') as HTMLElement

    fireEvent.pointerDown(mini, { button: 0, clientX: 200, clientY: 60, pointerId: 1 })
    fireEvent.pointerMove(mini, { clientX: 260, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(mini, { clientX: 260, clientY: 100, pointerId: 1 })
    expect(JSON.parse(localStorage.getItem(POS_KEY) ?? 'null')).toEqual({ x: 60, y: 40 })
    expect(host.style.transform).toContain('translate3d(60px, 40px, 0)')

    fireEvent.click(mini)
    expect(tabs().querySelector('.sp')?.getAttribute('data-expanded')).toBe('0')
  })

  test('拖动距离太近吸附回默认点并清掉存档', async () => {
    localStorage.setItem(MODE_KEY, 'mini')
    mount(harnessOf({ surfaces: SURFACES }), { nested: true })
    await flush()
    const host = tabs().querySelector('.sp-host') as HTMLElement
    stubRects(host, { x: 0, y: 0 })
    const mini = tabs().querySelector('.sp-mini') as HTMLElement

    fireEvent.pointerDown(mini, { button: 0, clientX: 200, clientY: 60, pointerId: 2 })
    fireEvent.pointerMove(mini, { clientX: 210, clientY: 65, pointerId: 2 })
    fireEvent.pointerUp(mini, { clientX: 210, clientY: 65, pointerId: 2 })
    expect(localStorage.getItem(POS_KEY)).toBeNull()
    expect(host.style.transform).toContain('translate3d(0px, 0px, 0)')
  })

  test('窗口变化把越界位置夹回可见范围并写盘', async () => {
    localStorage.setItem(MODE_KEY, 'mini')
    localStorage.setItem(POS_KEY, JSON.stringify({ x: 900, y: 900 }))
    mount(harnessOf({ surfaces: SURFACES }), { nested: true })
    await flush()
    const host = tabs().querySelector('.sp-host') as HTMLElement
    stubRects(host, { x: 900, y: 900 })

    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(JSON.parse(localStorage.getItem(POS_KEY) ?? 'null')).toEqual({ x: 692, y: 712 })
  })

  test('没有可夹取的容器（顶栏不在正文区内）：不进入拖动，点击照常展开', async () => {
    localStorage.setItem(MODE_KEY, 'mini')
    mount(harnessOf({ surfaces: SURFACES }))
    await flush()
    const mini = tabs().querySelector('.sp-mini') as HTMLElement
    fireEvent.pointerDown(mini, { button: 0, clientX: 200, clientY: 60, pointerId: 3 })
    fireEvent.pointerMove(mini, { clientX: 300, clientY: 120, pointerId: 3 })
    fireEvent.pointerUp(mini, { clientX: 300, clientY: 120, pointerId: 3 })
    expect(localStorage.getItem(POS_KEY)).toBeNull()
    fireEvent.click(mini)
    expect(tabs().querySelector('.sp')?.getAttribute('data-expanded')).toBe('1')
  })
})

describe('失败回执与子智能体兜底', () => {
  test('停止队友 / 停止后台活 / 清空待办 / 目标动作四处的失败都给人话', async () => {
    const failure = new Error('nope')
    const harness = harnessOf({
      surfaces: SURFACES,
      teammates: [mate({ name: 'worker-1' })],
      reject: { stopTeammate: failure, stopBackground: failure, clearTodos: failure, goalAction: failure },
    })
    mountPanel(harness)
    await flush()

    fireEvent.click(section('todo')?.querySelector('[data-sp-clear]') as HTMLElement)
    fireEvent.click(section('goal')?.querySelector('.sp-goal-btn') as HTMLElement)
    expandSection('terminal')
    fireEvent.click(section('terminal')?.querySelector('.sp-row-stop') as HTMLElement)
    expandSection('agent')
    fireEvent.click(section('agent')?.querySelector('.sp-row-stop') as HTMLElement)
    await flush()
    expect(toastText().split('nope').length - 1).toBeGreaterThanOrEqual(4)
  })

  test('停止后台活成功：回执文本优先，空串退回本地文案', async () => {
    const first = harnessOf({ surfaces: SURFACES, stopBackgroundText: '终端已关' })
    mountPanel(first)
    await flush()
    expandSection('terminal')
    fireEvent.click(section('terminal')?.querySelector('.sp-row-stop') as HTMLElement)
    await flush()
    expect(toastText()).toContain('终端已关')
    cleanup()

    const second = harnessOf({ surfaces: SURFACES, stopBackgroundText: '' })
    mountPanel(second)
    await flush()
    expandSection('terminal')
    fireEvent.click(section('terminal')?.querySelector('.sp-row-stop') as HTMLElement)
    await flush()
    expect(toastText()).toContain(zh['status.toast.workStopped'].replace('{id}', 'job-1'))
  })

  test('点队友走宿主的 openTeammate；宿主不认这条方法时退回 openSession（不静默）；全员收工时读数换「共 N」', async () => {
    const harness = harnessOf({ teammates: [mate({ name: 'idle-1', state: 'idle' }), mate({ name: 'failed-1', state: 'failed' })] })
    mountPanel(harness)
    await flush()
    expandSection('agent')
    expect(textOf(section('agent')?.querySelector('.sp-section-trail'))).toBe(
      zh['status.agent.trailCount'].replace('{n}', '2'),
    )
    fireEvent.click(section('agent')?.querySelector('.sp-row-open') as HTMLElement)
    await flush()
    expect(callsOf(harness, 'openTeammate')[0]?.args).toEqual(['idle-1'])
  })

  test('旧宿主没有 openTeammate：点队友退回 openSession（那条会话文件），不出现「点了没反应」', async () => {
    const harness = harnessOf({
      teammates: [mate({ name: 'idle-1', state: 'idle' })],
      reject: { openTeammate: new Error('协议不允许调用的方法：openTeammate') },
    })
    mountPanel(harness)
    await flush()
    expandSection('agent')
    fireEvent.click(section('agent')?.querySelector('.sp-row-open') as HTMLElement)
    await flush()
    expect(callsOf(harness, 'openSession').map((call) => call.args[0])).toEqual(['C:/sessions/idle-1.jsonl'])
  })
})

describe('任务板 / 目标 / 工作流的剩余读数', () => {
  test('任务板全部完成报「共 N」；blocked 目标给继续钮并把原因放 title；停用但有排期报「已暂停」', async () => {
    const board: TeamBoardView = {
      revision: 1,
      tasks: [
        { id: 't1', subject: '做完一', description: '', status: 'completed', owner: null, blockedBy: [], writeScopes: [], ready: true },
        { id: 't2', subject: '做完二', description: '', status: 'completed', owner: 'lead', blockedBy: [], writeScopes: [], ready: true },
      ],
    }
    const paused = task({ id: 's1', title: '夜间巡检', enabled: false, nextRunAt: Date.now() + 60_000 })
    const harness = harnessOf({
      surfaces: {
        goal: { objective: '等审批的目标', phase: 'blocked', rounds: 2, maxRounds: 5, armed: true, blockedReason: '等用户批准' },
        scheduled: [paused],
      },
      board,
    })
    mountPanel(harness)
    await flush()

    expect(textOf(section('goal')?.querySelector('.sp-goal-state'))).toContain(zh['status.goal.phaseBlocked'])
    expect(section('goal')?.querySelector('.sp-goal-text')?.getAttribute('title')).toBe('等用户批准')
    expect(textOf(section('goal')?.querySelector('.sp-goal-btn'))).toBe(zh['status.goal.resume'])

    expandSection('team')
    expect(textOf(section('team')?.querySelector('.sp-section-trail'))).toBe(
      zh['status.team.trailDone'].replace('{n}', '2'),
    )

    expandSection('workflow')
    expect(textOf(section('workflow')?.querySelector('.sp-row-time'))).toBe(zh['status.task.paused'])
  })
})

describe('后台活输出页签', () => {
  const renderTab = (
    harness: Harness,
    tab: DockTabBodyProps['tab'],
    active = true,
    expanded = true,
  ): ReturnType<typeof render> =>
    render(
      <RuntimeProvider channel={harness.channel}>
        <WorkOutputTab tab={tab} active={active} expanded={expanded} />
      </RuntimeProvider>,
    )

  test('运行中按秒续拉；页签不可见或没有 id 时一次都不拉', async () => {
    const harness = harnessOf({
      background: { id: 'job-1', kind: 'job', status: 'running', text: 'line', totalChars: 5, from: 0, droppedChars: 0, atEnd: true },
    })
    renderTab(harness, { id: 'tab-1', kind: 'work-output', path: 'job-1' })
    await flush()
    expect(callsOf(harness, 'readBackground')).toHaveLength(1)
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    expect(callsOf(harness, 'readBackground').length).toBeGreaterThanOrEqual(2)
    cleanup()

    const hidden = harnessOf({})
    renderTab(hidden, { id: 'tab-1', kind: 'work-output', path: 'job-1' }, false, true)
    await flush()
    expect(callsOf(hidden, 'readBackground')).toHaveLength(0)
    cleanup()

    const noId = harnessOf({})
    renderTab(noId, { id: 'tab-1', kind: 'work-output' })
    await flush()
    expect(callsOf(noId, 'readBackground')).toHaveLength(0)
    expect((document.querySelector('[data-sp-output]') as HTMLElement).getAttribute('data-status')).toBe('loading')
  })

  test('首帧还没拿到快照时写「正在读取」', () => {
    const harness = harnessOf({
      background: { id: 'job-1', kind: 'job', status: 'running', text: '', totalChars: 0, from: 0, droppedChars: 0, atEnd: true },
    })
    renderTab(harness, { id: 'tab-1', kind: 'work-output', path: 'job-1' })
    // 不 flush：invoke 的 then 还没跑，display 仍是 null。
    expect(textOf(document.querySelector('[data-sp-output-text]'))).toBe(zh['status.output.reading'])
  })

  test('五种状态词与未知状态兜底 loading', async () => {
    const cases: Array<[string, string]> = [
      ['completed', zh['status.workStatus.completed']],
      ['failed', zh['status.workStatus.failed']],
      ['killed', zh['status.workStatus.killed']],
      ['weird', zh['status.workStatus.loading']],
    ]
    for (const [status, label] of cases) {
      const harness = harnessOf({
        background: { id: 'job-1', kind: 'job', status, text: 'x', totalChars: 1, from: 0, droppedChars: 0, atEnd: true },
      })
      renderTab(harness, { id: 'tab-1', kind: 'work-output', path: 'job-1' })
      await flush()
      expect(textOf(document.querySelector('.work-out-status'))).toBe(label)
      cleanup()
    }
  })

  test('读失败给人话，读数停在「正在读取」而不是编一份空输出', async () => {
    const harness = harnessOf({ background: new Error('管道断了') })
    renderTab(harness, { id: 'tab-1', kind: 'work-output', path: 'job-1' })
    await flush()
    expect(textOf(document.querySelector('.work-out-note'))).toContain('管道断了')
    expect(textOf(document.querySelector('[data-sp-output-text]'))).toBe(zh['status.output.reading'])
  })
})
