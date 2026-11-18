/**
 * 状态面板各分区（`ui-status/ui/ui.tsx` 的 MiniSummary / Todo / Fold / Agent / Team /
 * Git / Terminal / Workflow / Goal / Plan）的渲染与交互段（ui 层，真渲染）。
 *
 * 与 `ui.spec.tsx` 分工：那边只钉壳层（锚点、胶囊、模式存档、空数据不画）。
 * 这里补每个分区自己的账——胶囊优先级链的几种摘要、待办三态与折叠桶预览卡、
 * 子智能体与共享任务的行/详情、Git/终端/工作流的读数与动作、输出页签的轮询与冻结，
 * 以及坏数据与长文本截断的兜底。真扫盘、真 git、真轮询节拍归宿主，这里只钉界面。
 *
 * @module dsc-ui-status/ui/sections.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { ServiceRegistry, ServicesProvider } from '@dsc/ui-core'
import { dockSurface, dockTabMeta, registerDockTab } from '@dsc/ui-dockkit'
import type {
  BackgroundOutputView,
  BackgroundWorkView,
  HostSnapshot,
  PlanEntryView,
  ScheduledTaskView,
  TeammateView,
  TeamBoardView,
  TodoItemView,
  UiPluginApi,
} from '@dsc/ui'
import zh from '../locale/ui.zh.json'
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

interface Invoke {
  method: string
  args: unknown[]
}

interface HarnessOptions {
  surfaces?: Record<string, unknown>
  status?: Record<string, unknown>
  teammates?: TeammateView[] | Error
  board?: TeamBoardView | null | Error
  git?: Record<string, unknown> | Error | null
  background?: BackgroundOutputView | Error
  services?: ServiceRegistry
}

interface Harness {
  channel: HostChannel
  calls: Invoke[]
}

/** 假宿主：快照面 + 轮询方法（名册/任务板/git/输出）全记账。 */
function harnessOf(options: HarnessOptions = {}): Harness {
  const calls: Invoke[] = []
  const snapshot = {
    sessions: [],
    status: {
      cwd: 'C:/repo',
      sessionPath: 'C:/repo/abc.jsonl',
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
      if (method === 'listTeammates') {
        const reply = options.teammates ?? []
        return (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)) as Promise<T>
      }
      if (method === 'listTeamBoard') {
        const reply = options.board ?? null
        return (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)) as Promise<T>
      }
      if (method === 'dock') {
        const reply = options.git ?? {}
        return (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)) as Promise<T>
      }
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

/** 壳里的两个锚点：页签行（portal 落点）与正文区（宽度裁决）。 */
function shellDom(): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML =
    '<div class="topbar"><div class="tabs"></div></div>' +
    '<div class="thread-main" data-thread-area><div id="mount"></div></div>'
  document.body.append(root)
  return root.querySelector('#mount') as HTMLElement
}

const mount = (harness: Harness, options: { services?: ServiceRegistry } = {}): ReturnType<typeof render> => {
  const target = shellDom()
  const tree = (
    <RuntimeProvider channel={harness.channel}>
      <StatusPanel />
    </RuntimeProvider>
  )
  return render(options.services === undefined ? tree : <ServicesProvider services={options.services}>{tree}</ServicesProvider>, {
    container: target,
  })
}

/** 固定落「始终展开」档：分区内容在收起态是 inert 的，测内容前先展开。 */
const mountPanel = (harness: Harness, options: { services?: ServiceRegistry } = {}): ReturnType<typeof render> => {
  localStorage.setItem('dsc.statusPanel.mode', 'panel')
  return mount(harness, options)
}

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })

const tabs = (): HTMLElement => document.querySelector('.topbar .tabs') as HTMLElement
const textOf = (element: Element | null | undefined): string => element?.textContent ?? ''
const miniText = (): string => textOf(tabs().querySelector('.sp-mini'))
const section = (id: string): HTMLElement | null => tabs().querySelector(`[data-sp-section="${id}"]`)
const expandSection = (id: string): void => {
  const node = section(id)
  if (node === null) throw new Error(`没有分区：${id}`)
  if (node.getAttribute('data-sp-open') !== '1') {
    fireEvent.click(node.querySelector('.sp-section-head') as HTMLElement)
  }
}
const callsOf = (harness: Harness, method: string): Invoke[] => harness.calls.filter((call) => call.method === method)
const toastText = (): string => textOf(document.querySelector('.dsc-toasts'))

const todo = (id: string, status: TodoItemView['status'], content: string, parent?: string): TodoItemView =>
  parent === undefined ? { id, status, content } : { id, status, content, parent }

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
  delete (window as { matchMedia?: unknown }).matchMedia
})

describe('胶囊摘要（MiniSummary）的优先级链', () => {
  test('在跑的定点任务压过其他面，胶囊只报它的标题', async () => {
    const running = task({ id: 's1', title: '夜间巡检', lastStatus: 'running', nextRunAt: Date.now() + 60_000 })
    const harness = harnessOf({
      surfaces: {
        scheduled: [running],
        goal: { objective: '不该出现的目标', phase: 'active', rounds: 0, maxRounds: 3, armed: true },
      },
    })
    mount(harness)
    await flush()
    expect(miniText()).toContain('夜间巡检')
    expect(miniText()).not.toContain('不该出现的目标')
  })

  test('进行中的待办排第二；胶囊无进度尾巴（那是日进度档的）', async () => {
    const harness = harnessOf({
      surfaces: { todos: todoView([todo('t1', 'pending', '待办一'), todo('t2', 'in_progress', '正在写用例')]) },
    })
    mount(harness)
    await flush()
    expect(miniText()).toContain('正在写用例')
    expect(tabs().querySelector('.sp-mini-trail')).toBeNull()
  })

  test('未完成目标排第三：胶囊报目标正文', async () => {
    const harness = harnessOf({
      surfaces: { goal: { objective: '把面板测完', phase: 'paused', rounds: 2, maxRounds: 5, armed: true } },
    })
    mount(harness)
    await flush()
    expect(miniText()).toContain('把面板测完')
  })

  test('在跑档三种组合：队友 + 后台活混合给总数，单一类给各自的说法', async () => {
    const mates = [
      mate({ name: 'writer-1', state: 'working' }),
      mate({ name: 'reader-1', state: 'idle' }),
    ]
    const matesOnly = harnessOf({ teammates: mates })
    mount(matesOnly)
    await flush()
    expect(miniText()).toContain(zh['status.capsule.mates'].replace('{n}', '1'))
    cleanup()
    document.body.innerHTML = ''

    const worksOnly = harnessOf({ surfaces: { backgroundWorks: [work({ id: 'job-1' })] } })
    mount(worksOnly)
    await flush()
    expect(miniText()).toContain(zh['status.capsule.works'].replace('{n}', '1'))
    cleanup()
    document.body.innerHTML = ''

    const mixed = harnessOf({ teammates: mates, surfaces: { backgroundWorks: [work({ id: 'job-1' })] } })
    mount(mixed)
    await flush()
    expect(miniText()).toContain(zh['status.capsule.running'].replace('{n}', '2'))
  })

  test('收工的队友兜底：胶囊报「已结束 N 个子智能体」', async () => {
    const harness = harnessOf({
      teammates: [mate({ name: 'a', state: 'idle' }), mate({ name: 'b', state: 'failed' })],
    })
    mount(harness)
    await flush()
    expect(miniText()).toContain(zh['status.capsule.matesEnded'].replace('{n}', '2'))
  })

  test('进度档：没有当前项但有总数时报 done/total 尾巴', async () => {
    const harness = harnessOf({
      surfaces: {
        todos: {
          items: [todo('t1', 'cancelled', '取消一'), todo('t2', 'cancelled', '取消二')],
          revision: 1,
          done: 0,
          total: 2,
          active: null,
        },
      },
    })
    mount(harness)
    await flush()
    expect(miniText()).toContain(zh['status.section.todo'])
    expect(textOf(tabs().querySelector('.sp-mini-trail'))).toBe('0/2')
  })

  test('计划与 Git：计划报标题；Git 只报「更改」不报增删行数', async () => {
    const plans: PlanEntryView[] = [{ file: 'C:/repo/.dsc/plans/p1.md', title: '重构方案', at: Date.now() - 1_000 }]
    const planHarness = harnessOf({ surfaces: { planDirectory: plans } })
    mount(planHarness)
    await flush()
    expect(miniText()).toContain('重构方案')
    cleanup()
    document.body.innerHTML = ''

    const gitHarness = harnessOf({ git: { added: 9, removed: 4, dirtyFileCount: 2, branch: 'main' } })
    mount(gitHarness)
    await flush()
    expect(miniText()).toContain(zh['status.changes'])
    expect(miniText()).not.toContain('+9')
    expect(miniText()).not.toContain('/−4')
  })
})

describe('进程区（TodoRow / TodoStatusIcon / 清空）', () => {
  test('四态图标、子任务标记与长文本 title 全量', async () => {
    const long = '很长的待办内容'.repeat(20)
    const harness = harnessOf({
      surfaces: {
        todos: todoView([
          todo('t1', 'completed', '已完成的那条'),
          todo('t2', 'in_progress', '进行中的那条'),
          todo('t3', 'pending', '还没开始', 't2'),
          todo('t4', 'cancelled', long),
        ]),
      },
    })
    mountPanel(harness)
    await flush()
    expect(textOf(section('todo')?.querySelector('.sp-section-trail'))).toContain('1/3')
    const rows = [...(section('todo')?.querySelectorAll('.sp-row') ?? [])] as HTMLElement[]
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual([
      'completed',
      'in_progress',
      'pending',
      'cancelled',
    ])
    expect(rows[0]?.querySelector('.sp-icon-done')).toBeTruthy()
    expect(rows[1]?.querySelector('.sp-icon-run')).toBeTruthy()
    expect(rows[2]?.querySelector('.sp-icon-wait')).toBeTruthy()
    expect(rows[3]?.querySelector('.sp-icon-cancel')).toBeTruthy()
    expect(textOf(rows[2]?.querySelector('.sp-row-note'))).toBe(zh['status.todo.subtask'])
    // 视觉上两行截断，全文留在 title 里。
    expect(rows[3]?.querySelector('.sp-row-text')?.getAttribute('title')).toBe(long)
  })

  test('全部办完时进度带 complete 标记；清空钮回传 clearTodos', async () => {
    const harness = harnessOf({
      surfaces: { todos: todoView([todo('t1', 'completed', '第一件'), todo('t2', 'completed', '第二件')]) },
    })
    mountPanel(harness)
    await flush()
    const trail = section('todo')?.querySelector('[data-sp-progress]') as HTMLElement
    expect(trail.getAttribute('data-sp-progress')).toBe('2/2')
    expect(trail.getAttribute('data-sp-complete')).toBe('1')
    fireEvent.click(section('todo')?.querySelector('[data-sp-clear]') as HTMLElement)
    await flush()
    expect(callsOf(harness, 'clearTodos')).toHaveLength(1)
    expect(toastText()).toContain(zh['status.toast.todosCleared'])
  })
})

describe('折叠桶（FoldRow / FoldPreviewCard）', () => {
  const manyTodos = (): Record<string, unknown> =>
    todoView([
      todo('a', 'completed', '已完成一'),
      todo('b', 'completed', '已完成二'),
      todo('c', 'in_progress', '在跑'),
      todo('d', 'pending', '待办一'),
      todo('e', 'pending', '待办二'),
      todo('f', 'pending', '待办三'),
      todo('g', 'pending', '待办四'),
      todo('h', 'pending', '待办五'),
    ])

  test('超过 6 条启用聚焦窗口：前后折叠桶文案按状态语义；悬停 120ms 出预览卡，离开 80ms 收起', async () => {
    const harness = harnessOf({ surfaces: { todos: manyTodos() } })
    mountPanel(harness)
    await flush()
    const before = section('todo')?.querySelector('[data-sp-fold="preceding"]') as HTMLElement
    const after = section('todo')?.querySelector('[data-sp-fold="following"]') as HTMLElement
    expect(textOf(before)).toBe(zh['status.fold.completed'].replace('{n}', '2'))
    expect(textOf(after)).toBe(zh['status.fold.waiting'].replace('{n}', '3'))
    // 窗口本体 3 条。
    expect(section('todo')?.querySelectorAll('.sp-row')).toHaveLength(3)

    fireEvent.mouseEnter(before)
    expect(tabs().querySelector('.sp-card')).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(120)
    })
    const card = tabs().querySelector('.sp-card') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.getAttribute('data-sp-card')).toBe('preceding')
    expect(card.querySelectorAll('.sp-row')).toHaveLength(2)
    expect(textOf(card.querySelector('.sp-card-head'))).toBe(zh['status.fold.completed'].replace('{n}', '2'))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(tabs().querySelector('.sp-card')).toBeNull()

    fireEvent.mouseEnter(before)
    await act(async () => {
      vi.advanceTimersByTime(120)
    })
    expect(tabs().querySelector('.sp-card')).toBeTruthy()
    fireEvent.mouseLeave(before)
    await act(async () => {
      vi.advanceTimersByTime(80)
    })
    expect(tabs().querySelector('.sp-card')).toBeNull()
  })

  test('触屏（无悬停）点按：立刻开、再点收；窗口前桶混了未办完的条目时退回中性位置词', async () => {
    ;(window as { matchMedia?: unknown }).matchMedia = (query: string) => ({
      matches: query.includes('hover: none'),
      media: query,
      onchange: null,
      addListener: (): void => undefined,
      removeListener: (): void => undefined,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
      dispatchEvent: (): boolean => false,
    })
    const harness = harnessOf({
      surfaces: {
        todos: todoView([
          todo('a', 'completed', '已完成'),
          todo('b', 'pending', '混在窗口前'),
          todo('c', 'in_progress', '在跑'),
          todo('d', 'pending', '待办一'),
          todo('e', 'pending', '待办二'),
          todo('f', 'pending', '待办三'),
          todo('g', 'pending', '待办四'),
        ]),
      },
    })
    mountPanel(harness)
    await flush()
    const before = section('todo')?.querySelector('[data-sp-fold="preceding"]') as HTMLElement
    expect(textOf(before)).toBe(zh['status.fold.earlier'].replace('{n}', '2'))
    fireEvent.click(before)
    expect(tabs().querySelector('.sp-card')).toBeTruthy()
    fireEvent.click(before)
    await act(async () => {
      vi.advanceTimersByTime(80)
    })
    expect(tabs().querySelector('.sp-card')).toBeNull()
  })
})

describe('子智能体区（AgentSection）', () => {
  test('在跑的排前面；行内 token / 耗时 / 状态词、一次性标记、停止钮与点击打开运行记录', async () => {
    const startedAt = Date.UTC(2026, 0, 1)
    const mates = [
      mate({ name: 'idle-1', state: 'idle', startedAt: 2000 }),
      mate({ name: 'run-late', state: 'working', startedAt: 3000, tokens: 58_100_000 }),
      mate({ name: 'run-early', state: 'working', mode: 'one-shot', startedAt: 1000 }),
      mate({
        name: 'bad-1',
        state: 'failed',
        startedAt,
        finishedAt: startedAt + (50 * 60 + 6) * 1000,
        sessionId: 'abc',
      }),
      mate({ name: 'other', state: 'working', sessionId: 'zzz' }),
    ]
    const opened: string[] = []
    const services = new ServiceRegistry()
    services.provide('teammateReader', { open: (m: TeammateView) => opened.push(m.name) }, 'test')
    const harness = harnessOf({ teammates: mates })
    mountPanel(harness, { services })
    await flush()
    expandSection('agent')
    const rows = [...(section('agent')?.querySelectorAll('.sp-row-agent') ?? [])] as HTMLElement[]
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.getAttribute('data-sp-agent-state'))).toEqual([
      'working',
      'working',
      'idle',
      'failed',
    ])
    // 分区头照 dsh：「X 已完成 · Y 在跑」。
    expect(textOf(section('agent')?.querySelector('.sp-section-trail'))).toBe('2 已完成 · 2 在跑')
    expect(textOf(rows[0]?.querySelector('.sp-row-mode'))).toBe(zh['status.agent.modeOneShot'])
    expect(rows[3]?.querySelector('.sp-row-time')?.getAttribute('data-tone')).toBe('danger')
    expect(section('agent')?.querySelectorAll('.sp-row-stop')).toHaveLength(2)
    // 行尾右箭头（dsh 面板那一格）。
    expect(rows.every((row) => row.querySelector('.sp-row-arrow') !== null)).toBe(true)
    // token 只在有值时画：run-late 有 58.1M，其余（undefined）不画。
    expect(textOf(rows[1]?.querySelector('.sp-row-tokens'))).toBe('58.1M tok')
    expect(section('agent')?.querySelectorAll('.sp-row-tokens')).toHaveLength(1)
    // 耗时：收工的按 startedAt→finishedAt 冻结，秒补成两位（「50分06秒」）。
    expect(textOf(rows[3]?.querySelector('.sp-row-elapsed'))).toBe('50分06秒')

    fireEvent.click(rows[0]?.querySelector('.sp-row-stop') as HTMLElement)
    await flush()
    expect(callsOf(harness, 'stopTeammate')[0]?.args).toEqual(['run-early'])
    expect(toastText()).toContain('已叫停 run-early')

    fireEvent.click(rows[2]?.querySelector('.sp-row-open') as HTMLElement)
    expect(opened).toEqual(['idle-1'])
  })

  test('token 无值或 0 都不画（不显示假的 0）；全员收工时读数只报「N 已完成」', async () => {
    const harness = harnessOf({
      teammates: [
        mate({ name: 'no-tokens', state: 'idle', tokens: undefined }),
        mate({ name: 'zero-tokens', state: 'idle', tokens: 0 }),
        mate({ name: 'some-tokens', state: 'idle', tokens: 912_400 }),
      ],
    })
    mountPanel(harness)
    await flush()
    expandSection('agent')
    const rows = [...(section('agent')?.querySelectorAll('.sp-row-agent') ?? [])] as HTMLElement[]
    expect(rows).toHaveLength(3)
    expect(section('agent')?.querySelectorAll('.sp-row-tokens')).toHaveLength(1)
    const tokenCells = [...(section('agent')?.querySelectorAll('.sp-row-tokens') ?? [])] as HTMLElement[]
    expect(textOf(tokenCells[0])).toBe('912.4K tok')
    expect(textOf(section('agent')?.querySelector('.sp-section-trail'))).toBe('3 已完成')
  })
})

describe('共享任务区（TeamBoardSection）', () => {
  test('行读数四档 + 状态灯、详情一次只开一条、右箭头随展开转', async () => {
    const board: TeamBoardView = {
      revision: 1,
      tasks: [
        { id: 't1', subject: '写测试', description: '把 ui 层补到 60%', status: 'in_progress', owner: 'writer-1', blockedBy: [], writeScopes: ['src/a.ts'], ready: true },
        { id: 't2', subject: '等依赖的事', description: '', status: 'pending', owner: null, blockedBy: ['t1'], writeScopes: [], ready: false },
        { id: 't3', subject: '可开工的事', description: '随时能派', status: 'pending', owner: 'lead', blockedBy: [], writeScopes: [], ready: true },
        { id: 't4', subject: '完成的事', description: '已经做完', status: 'completed', owner: null, blockedBy: [], writeScopes: [], ready: true },
      ],
    }
    const harness = harnessOf({ board })
    mountPanel(harness)
    await flush()
    expandSection('team')
    // 分区头照 dsh：「N 已完成 · M 未完成」。
    expect(textOf(section('team')?.querySelector('.sp-section-trail'))).toBe('1 已完成 · 3 未完成')
    const rows = [...(section('team')?.querySelectorAll('.sp-row-task') ?? [])] as HTMLElement[]
    expect(rows.map((row) => row.getAttribute('data-sp-task-state'))).toEqual([
      'in_progress',
      'pending',
      'pending',
      'completed',
    ])
    // 状态灯四态：进行中带旋转弧、被依赖挡琥珀、待开始空心圈、完成实心绿。
    expect(rows[0]?.querySelector('.sp-lamp-run')?.getAttribute('data-sp-lamp')).toBe('running')
    expect(rows[1]?.querySelector('.sp-lamp')?.getAttribute('data-sp-lamp')).toBe('blocked')
    expect(rows[2]?.querySelector('.sp-lamp')?.getAttribute('data-sp-lamp')).toBe('pending')
    expect(rows[3]?.querySelector('.sp-lamp')?.getAttribute('data-sp-lamp')).toBe('done')
    expect(textOf(rows[1]?.querySelector('.sp-row-time'))).toBe(zh['status.team.stateBlocked'])
    expect(rows[1]?.querySelector('.sp-row-time')?.getAttribute('data-tone')).toBe('warn')
    expect(textOf(rows[2]?.querySelector('.sp-row-time'))).toBe(zh['status.team.statePending'])
    expect(textOf(rows[1]?.querySelector('.sp-row-note'))).toBe(zh['status.team.unowned'])
    // 行尾右箭头：收起指右，展开后 aria-expanded 翻真（旋转交给 CSS）。
    expect(rows[0]?.querySelector('.sp-row-arrow')).not.toBeNull()
    expect(rows[0]?.querySelector('.sp-row-open')?.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(rows[0]?.querySelector('.sp-row-open') as HTMLElement)
    expect(rows[0]?.querySelector('.sp-row-open')?.getAttribute('aria-expanded')).toBe('true')
    let detail = section('team')?.querySelector('.sp-task-detail') as HTMLElement
    expect(textOf(detail)).toContain('把 ui 层补到 60%')
    expect(textOf(detail)).toContain('预计改：src/a.ts')

    fireEvent.click(rows[1]?.querySelector('.sp-row-open') as HTMLElement)
    const details = section('team')?.querySelectorAll('.sp-task-detail') ?? []
    expect(details).toHaveLength(1)
    detail = details[0] as HTMLElement
    expect(textOf(detail)).toContain(zh['status.team.noDetail'])
    expect(textOf(detail)).toContain('依赖：t1')

    // 分区头可收起。
    fireEvent.click(section('team')?.querySelector('.sp-section-head') as HTMLElement)
    expect(section('team')?.getAttribute('data-sp-open')).toBe('0')
  })
})

describe('Git 工具区（GitSection）', () => {
  test('读数：文件数 + 分支；点「更改」开右侧栏 Git 页签', async () => {
    const dispose = registerDockTab({ kind: 'git', label: 'Git', component: (() => null) as never })
    try {
      const harness = harnessOf({ git: { added: 5, removed: 2, dirtyFileCount: 3, branch: 'feature/x' } })
      mountPanel(harness)
      await flush()
      expect(section('git')).toBeTruthy()
      const changes = section('git')?.querySelector('[data-sp-git-changes]') as HTMLElement
      expect(changes.getAttribute('data-sp-git-changes')).toBe('3')
      expect(textOf(changes)).toContain(zh['status.changes'])
      expect(textOf(changes)).toContain('3 个文件')
      expect(textOf(section('git')?.querySelector('[data-sp-git-branch]'))).toContain('feature/x')

      fireEvent.click(changes)
      const surface = dockSurface()
      expect(surface.expanded).toBe(true)
      expect(surface.panes[0]?.tabs.some((tab) => tab.kind === 'git')).toBe(true)
    } finally {
      dispose()
    }
  })

  test('干净仓库不摆状态卡：连胶囊都不画', async () => {
    const harness = harnessOf({ git: { added: 0, removed: 0, dirtyFileCount: 0, branch: 'main' } })
    mount(harness)
    await flush()
    expect(tabs().querySelector('.sp-mini')).toBeNull()
    expect(tabs().querySelector('.sp-panel')).toBeNull()
  })
})

describe('终端区（WorkSection）与输出页签（WorkOutputTab）', () => {
  test('行读数、停止钮与点开只读输出页签', async () => {
    const works = [
      work({ id: 'job-1', title: '构建', startedAt: Date.now() - 65_000 }),
      work({ id: 'term-1', kind: 'terminal', title: 'tail -f', startedAt: Date.now() - 5_000 }),
    ]
    const harness = harnessOf({ surfaces: { backgroundWorks: works } })
    mountPanel(harness)
    await flush()
    expandSection('terminal')
    expect(textOf(section('terminal')?.querySelector('.sp-section-trail'))).toContain('2 个后台运行')
    const rows = [...(section('terminal')?.querySelectorAll('.sp-row') ?? [])] as HTMLElement[]
    expect(rows).toHaveLength(2)
    expect(textOf(rows[0]?.querySelector('.sp-row-time'))).toBe('1分5秒')

    fireEvent.click(rows[0]?.querySelector('.sp-row-stop') as HTMLElement)
    await flush()
    expect(callsOf(harness, 'stopBackground')[0]?.args).toEqual(['job-1'])

    fireEvent.click(rows[0]?.querySelector('.sp-row-open') as HTMLElement)
    const tab = dockSurface().panes[0]?.tabs.find((item) => item.kind === 'work-output')
    expect(tab?.path).toBe('job-1')
    expect(tab?.label).toBe('构建')
  })

  test('输出页签：运行中按快照画文本与状态', async () => {
    const WorkOutputTab = dockTabMeta('work-output')?.component as ComponentType<{
      tab: { id: string; kind: string; path?: string; label?: string }
      active: boolean
      expanded: boolean
    }>
    expect(WorkOutputTab).toBeTruthy()
    const harness = harnessOf({
      background: {
        id: 'job-1',
        kind: 'job',
        status: 'running',
        text: 'hello\nworld',
        totalChars: 11,
        from: 0,
        droppedChars: 0,
        atEnd: true,
      },
    })
    render(
      <RuntimeProvider channel={harness.channel}>
        <WorkOutputTab tab={{ id: 'tab-1', kind: 'work-output', path: 'job-1', label: '构建' }} active expanded />
      </RuntimeProvider>,
    )
    await flush()
    const root = document.querySelector('[data-sp-output="job-1"]') as HTMLElement
    expect(root.getAttribute('data-status')).toBe('running')
    expect(root.getAttribute('data-following')).toBe('1')
    expect(textOf(root.querySelector('.work-out-title'))).toBe('构建')
    expect(textOf(root.querySelector('.work-out-status'))).toBe(zh['status.workStatus.running'])
    expect(textOf(root.querySelector('[data-sp-output-text]'))).toBe('hello\nworld')
    expect(callsOf(harness, 'readBackground')[0]?.args).toEqual(['job-1'])
  })

  test('输出页签：空输出给占位，丢头报一条，跑完不再续拉', async () => {
    const WorkOutputTab = dockTabMeta('work-output')?.component as ComponentType<{
      tab: { id: string; kind: string; path?: string; label?: string }
      active: boolean
      expanded: boolean
    }>
    const harness = harnessOf({
      background: {
        id: 'term-1',
        kind: 'terminal',
        status: 'closed',
        text: '',
        totalChars: 12,
        from: 12,
        droppedChars: 12,
        atEnd: true,
      },
    })
    render(
      <RuntimeProvider channel={harness.channel}>
        <WorkOutputTab tab={{ id: 'tab-1', kind: 'work-output', path: 'term-1' }} active expanded />
      </RuntimeProvider>,
    )
    await flush()
    const root = document.querySelector('[data-sp-output="term-1"]') as HTMLElement
    expect(root.getAttribute('data-status')).toBe('closed')
    expect(textOf(root.querySelector('[data-sp-output-text]'))).toBe(zh['status.output.empty'])
    expect(textOf(root.querySelector('[data-sp-output-dropped]'))).toContain('丢弃 12 字符')
    expect(textOf(root.querySelector('.work-out-status'))).toBe(zh['status.workStatus.closed'])
    // 跑完的活不再轮询：只读了挂载那一次。
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(callsOf(harness, 'readBackground')).toHaveLength(1)
  })

  test('输出页签：读失败给人话；向上滚离底部冻结，点「回到底部」恢复跟随', async () => {
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
    scroller.scrollTop = 80
    fireEvent.scroll(scroller)
    scroller.scrollTop = 10
    fireEvent.scroll(scroller)
    expect(root.getAttribute('data-following')).toBe('0')
    const resume = root.querySelector('[data-sp-output-resume]') as HTMLElement
    expect(resume).toBeTruthy()
    fireEvent.click(resume)
    expect(root.getAttribute('data-following')).toBe('1')
    expect(root.querySelector('[data-sp-output-resume]')).toBeNull()
  })

  test('输出页签：读失败把原因写在头部下面', async () => {
    const WorkOutputTab = dockTabMeta('work-output')?.component as ComponentType<{
      tab: { id: string; kind: string; path?: string; label?: string }
      active: boolean
      expanded: boolean
    }>
    const harness = harnessOf({ background: new Error('管道断了') })
    render(
      <RuntimeProvider channel={harness.channel}>
        <WorkOutputTab tab={{ id: 'tab-1', kind: 'work-output', path: 'job-9' }} active expanded />
      </RuntimeProvider>,
    )
    await flush()
    const root = document.querySelector('[data-sp-output="job-9"]') as HTMLElement
    expect(textOf(root.querySelector('.work-out-note'))).toContain('读不了输出：管道断了')
    expect(textOf(root.querySelector('[data-sp-output-text]'))).toBe(zh['status.output.reading'])
  })
})

describe('工作流区（WorkflowSection）', () => {
  test('六种行读数：停用 / 未排期 / 在跑 / 上次失败 / 阻塞 / 倒计时', async () => {
    const tasks = [
      task({ id: 's1', title: '停用的', enabled: false, nextRunAt: null }),
      task({ id: 's2', title: '未排期', enabled: true, nextRunAt: null, lastStatus: 'never' }),
      task({ id: 's3', title: '在跑', enabled: true, nextRunAt: Date.now() + 60_000, lastStatus: 'running' }),
      task({ id: 's4', title: '失败过', enabled: true, nextRunAt: Date.now() + 60_000, lastStatus: 'failed', lastError: '权限不足' }),
      task({ id: 's5', title: '被阻塞', enabled: true, nextRunAt: Date.now() + 60_000, lastStatus: 'blocked' }),
      task({ id: 's6', title: '有排期', enabled: true, nextRunAt: Date.now() + 120_000, lastStatus: 'ok' }),
    ]
    const harness = harnessOf({ surfaces: { scheduled: tasks } })
    mountPanel(harness)
    await flush()
    expandSection('workflow')
    expect(textOf(section('workflow')?.querySelector('.sp-section-trail'))).toBe(
      zh['status.workflow.trailRunning'].replace('{n}', '1'),
    )
    const rows = [...(section('workflow')?.querySelectorAll('.sp-row') ?? [])] as HTMLElement[]
    expect(rows.map((row) => row.getAttribute('data-sched-state'))).toEqual([
      'ok',
      'never',
      'running',
      'failed',
      'blocked',
      'ok',
    ])
    expect(textOf(rows[0]?.querySelector('.sp-row-time'))).toBe(zh['status.task.disabled'])
    expect(textOf(rows[1]?.querySelector('.sp-row-time'))).toBe(zh['status.task.unscheduled'])
    expect(textOf(rows[2]?.querySelector('.sp-row-time'))).toBe(zh['status.workStatus.running'])
    expect(textOf(rows[3]?.querySelector('.sp-row-time'))).toBe(zh['status.task.lastFailed'])
    expect(textOf(rows[4]?.querySelector('.sp-row-time'))).toBe(zh['status.task.blocked'])
    expect(textOf(rows[5]?.querySelector('.sp-row-time'))).toContain('后')
    // 失败原因挂在行的原生 title 上（长文本不进正文）。
    expect(rows[3]?.querySelector('.sp-row-open')?.getAttribute('data-tip')).toContain('权限不足')
  })
})

describe('目标区（GoalSection）与计划区（PlanSection）', () => {
  test('目标四相位：活动给暂停、暂停给继续、完成不给钮；读数带轮次', async () => {
    const active = harnessOf({
      surfaces: { goal: { objective: '把面板测完', phase: 'active', rounds: 1, maxRounds: 5, armed: true } },
    })
    mountPanel(active)
    await flush()
    expect(textOf(section('goal')?.querySelector('.sp-section-trail'))).toBe('1/5 轮')
    expect(textOf(section('goal')?.querySelector('.sp-goal-state'))).toContain(zh['status.goal.phaseArmed'])
    const pause = section('goal')?.querySelector('.sp-goal-btn') as HTMLElement
    expect(textOf(pause)).toBe(zh['status.goal.pause'])
    fireEvent.click(pause)
    await flush()
    expect(callsOf(active, 'goalAction')[0]?.args).toEqual(['pause'])
    expect(toastText()).toContain(zh['status.goal.pauseDone'])
    cleanup()
    document.body.innerHTML = ''

    const paused = harnessOf({
      surfaces: { goal: { objective: '暂停中的', phase: 'paused', rounds: 2, maxRounds: 5, armed: true } },
    })
    mountPanel(paused)
    await flush()
    const resume = section('goal')?.querySelector('.sp-goal-btn') as HTMLElement
    expect(textOf(resume)).toBe(zh['status.goal.resume'])
    fireEvent.click(resume)
    await flush()
    expect(callsOf(paused, 'goalAction')[0]?.args).toEqual(['resume'])
    cleanup()
    document.body.innerHTML = ''

    const complete = harnessOf({
      surfaces: { goal: { objective: '做完了', phase: 'complete', rounds: 5, maxRounds: 5, armed: true } },
    })
    mountPanel(complete)
    await flush()
    expect(textOf(section('goal')?.querySelector('.sp-goal-state'))).toContain(zh['status.goal.phaseComplete'])
    expect(section('goal')?.querySelector('.sp-goal-btn')).toBeNull()
    expect(section('goal')?.querySelector('.sp-goal-text')?.getAttribute('title')).toBe('做完了')
  })

  test('计划区：行数与「多久前」；点一行开预览页签', async () => {
    const dispose = registerDockTab({ kind: 'preview', label: '预览', component: (() => null) as never })
    try {
      const plans: PlanEntryView[] = [
        { file: 'C:/repo/.dsc/plans/p2.md', title: '新计划', at: Date.now() - 1_000 },
        { file: 'C:/repo/.dsc/plans/p1.md', title: '旧计划', at: Date.now() - 120_000 },
      ]
      const harness = harnessOf({ surfaces: { planDirectory: plans } })
      mountPanel(harness)
      await flush()
      expandSection('plan')
      expect(textOf(section('plan')?.querySelector('.sp-section-trail'))).toBe('2 份')
      const rows = [...(section('plan')?.querySelectorAll('.sp-row') ?? [])] as HTMLElement[]
      expect(textOf(rows[0]?.querySelector('.sp-row-time'))).toBe(zh['status.ago.justNow'])
      expect(textOf(rows[1]?.querySelector('.sp-row-time'))).toContain('前')

      fireEvent.click(rows[0]?.querySelector('.sp-row-open') as HTMLElement)
      const surface = dockSurface()
      expect(surface.expanded).toBe(true)
      expect(surface.panes[0]?.tabs.some((tab) => tab.kind === 'preview' && tab.path === 'C:/repo/.dsc/plans/p2.md')).toBe(true)
    } finally {
      dispose()
    }
  })
})

describe('坏数据与兜底', () => {
  test('快照面形状不对 / 名册与任务板缺席：不崩、不画空壳', async () => {
    const harness = harnessOf({
      surfaces: {
        todos: { items: 'not-an-array' },
        goal: 'bad',
        backgroundWorks: { nope: true },
        planDirectory: 'nope',
        scheduled: false,
      },
      teammates: new Error('team 没开'),
      board: null,
    })
    mount(harness)
    await flush()
    expect(tabs().querySelector('.sp-mini')).toBeNull()
    expect(tabs().querySelector('.sp-panel')).toBeNull()
    // 哨兵还在文档流里（壳的根），但浮层 host 没有内容。
    expect(document.querySelector('.sp-host:not([hidden])')).toBeNull()
  })
})
