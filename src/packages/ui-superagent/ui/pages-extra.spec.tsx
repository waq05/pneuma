/**
 * Super Agent 界面半的交互断言（ui 层，真渲染）。
 *
 * `tests/pages.spec.ts` 只钉清单与字典（不渲染 React）；这一份照壳装载插件那条路把
 * `shell.sidebar` / `shell.page` 的登记收下来，放进 `RuntimeProvider` + 假宿主通道里跑：
 *
 * - `state.ts`：阶段名 / 分组 / 时刻格式化、快照投影的形状检查与兜底、视图相等判断、
 *   页签与选中工单的模块级信号；
 * - `ui.tsx`：侧栏入口的徽标与三种收起语义、整页的路由（插件缺席 / 没启动 / 起不来 /
 *   概览 / 发布 / 工单 / 设置四个页签）；
 * - `publish.tsx`：校验、提交参数、成功后的切页与高亮、失败回执、忙碌态、最近动态；
 * - `tickets.tsx`：空态、三组分组与计数、高亮自动清除、点行进详情；
 * - `detail.tsx`：只读时间线（各类条目 / 截断 / 跳过记账条目）、加载 / 失败 / 刷新、
 *   停止 / 重试 / 清理的可用性与回执、确认框取消；
 * - `settings.tsx`：分区读取的加载 / 缺失 / 失败、六种字段的渲染、下拉 / 开关 / 文本 /
 *   数字的写入时机、保存与动作失败、派生值只读、未知值补选项。
 *
 * @module dsc-ui-superagent/ui/pages-extra.spec
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ComponentType, ReactNode } from 'react'
import { RuntimeProvider, setShellPage, type HostChannel } from '@dsc/ui-runtime'
import type {
  HostSnapshot,
  SettingsSectionView,
  SettingsValues,
  TranscriptEntry,
  UiPluginApi,
} from '@dsc/ui'
import plugin from './ui.js'
import { DetailPage } from './detail.js'
import { PublishPage } from './publish.js'
import { SettingsPage } from './settings.js'
import { TicketsPage } from './tickets.js'
import {
  closeTicket,
  formatAt,
  openTicket,
  readSuperagent,
  sameSuperagent,
  setHighlightedTicket,
  setSuperagentTab,
  stageGroupOf,
  stageLabelOf,
  useHighlightedTicket,
  useSelectedTicket,
  useSuperagentTab,
  type SuperagentTicket,
  type SuperagentView,
} from './state.js'

// ── 从插件登记里收下侧栏入口与整页（照壳装载那条路） ────────────────────────────

interface Registered {
  slot: string
  component: ComponentType
}

const registered: Registered[] = []
plugin.apply({
  slots: {
    register: (slot: string, _options: unknown, component: unknown): void => {
      registered.push({ slot, component: component as ComponentType })
    },
    declare: (): void => undefined,
    registerFactory: (): void => undefined,
  },
  provide: (): void => undefined,
  consume: (): undefined => undefined,
} as unknown as UiPluginApi)

const EntryRow = (() => {
  const found = registered.find((item) => item.slot === 'shell.sidebar')
  if (found === undefined) throw new Error('superagent 没有把入口登记进 shell.sidebar')
  return found.component
})()

const Page = (() => {
  const found = registered.find((item) => item.slot === 'shell.page')
  if (found === undefined) throw new Error('superagent 没有把页面登记进 shell.page')
  return found.component
})()

// ── 假宿主 ─────────────────────────────────────────────────────────────────────

interface Invoke {
  method: string
  args: unknown[]
}

type Reply = (method: string, args: unknown[]) => unknown

interface Harness {
  channel: HostChannel
  calls: Invoke[]
  setSurface(surface: unknown): void
}

/**
 * 假通道：`snapshot` 必须是稳定引用（`useSyncExternalStore` 每帧都要拿它判等），
 * 所以这里缓存一份，`setSurface` 换引用并通知订阅者。
 */
function harnessOf(snapshot: unknown, reply: Reply = () => ({ ok: true })): Harness {
  let current = snapshot as HostSnapshot | null
  const listeners = new Set<() => void>()
  const calls: Invoke[] = []
  const channel: HostChannel = {
    getSnapshot: () => current,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    invoke: <T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      try {
        const value = reply(method, args)
        if (value instanceof Error) return Promise.reject(value) as Promise<T>
        return Promise.resolve(value) as Promise<T>
      } catch (error: unknown) {
        return Promise.reject(error) as Promise<T>
      }
    },
    reconnect: () => undefined,
    close: () => undefined,
  }
  return {
    channel,
    calls,
    setSurface: (surface: unknown): void => {
      current = { surfaces: { superagent: surface } } as unknown as HostSnapshot
      for (const listener of [...listeners]) listener()
    },
  }
}

const snapshotOf = (surface: unknown): HostSnapshot =>
  ({ surfaces: { superagent: surface } }) as unknown as HostSnapshot

// ── 夹具 ───────────────────────────────────────────────────────────────────────

/** 本机时区的 ISO：`formatAt` 按本机时间读，构造与断言用同一组字段才不看跑测机器。 */
function isoAt(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(year, month - 1, day, hour, minute).toISOString()
}

function ticketOf(id: string, over: Partial<SuperagentTicket> = {}): SuperagentTicket {
  return {
    id,
    title: `工单 ${id}`,
    stage: { stage: 'idle' },
    at: isoAt(2026, 1, 2, 3, 4),
    ...over,
  }
}

function surfaceOf(over: Partial<SuperagentView> = {}): SuperagentView {
  return {
    ready: true,
    problem: null,
    counts: { needsYou: 0, running: 0, done: 0 },
    tickets: [],
    recent: [],
    ...over,
  }
}

/** 一页四签 + 选中工单的观察窗（模块级信号不在 props 链上，只能靠 hook 读）。 */
function SignalProbe(): ReactNode {
  const tab = useSuperagentTab()
  const selected = useSelectedTicket()
  const highlight = useHighlightedTicket()
  return <span data-testid="signal-probe">{`${tab}|${selected ?? '-'}|${highlight ?? '-'}`}</span>
}

function probeText(): string {
  return document.querySelector('[data-testid="signal-probe"]')?.textContent ?? ''
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const buttons = [...root.querySelectorAll('button')]
  const found = buttons.find((button) => (button.textContent ?? '').trim().includes(text))
  if (found === undefined) throw new Error(`找不到按钮：${text}`)
  return found
}

function chooseSelectOption(ariaLabel: string, text: string): void {
  const trigger = document.querySelector(`[aria-label="${ariaLabel}"]`)
  if (trigger === null) throw new Error(`找不到下拉：${ariaLabel}`)
  fireEvent.click(trigger)
  const option = [...document.querySelectorAll('.select-opt')].find((item) =>
    (item.textContent ?? '').includes(text),
  )
  if (option === undefined) throw new Error(`下拉 ${ariaLabel} 里没有「${text}」`)
  fireEvent.click(option)
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onOk, onErr) => {
    resolve = onOk
    reject = onErr
  })
  return { promise, resolve, reject }
}

const mountPage = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <Page />
      <SignalProbe />
    </RuntimeProvider>,
  )

const mountTickets = (harness: Harness, surface: SuperagentView): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <TicketsPage surface={surface} />
      <SignalProbe />
    </RuntimeProvider>,
  )

const mountPublish = (harness: Harness, surface: SuperagentView): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <PublishPage surface={surface} />
      <SignalProbe />
    </RuntimeProvider>,
  )

const mountDetail = (harness: Harness, surface: SuperagentView, id: string): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <DetailPage surface={surface} id={id} />
      <SignalProbe />
    </RuntimeProvider>,
  )

/**
 * 设置页也要收快照面：合并后它底部多了一块「最近变更」，数据来自
 * `surfaces.superagent.settingsHistory`（`settings.tsx:338`）。默认给一份没有这一格的
 * 视图，这块就不画，旧的字段断言不受影响。
 */
const mountSettings = (
  harness: Harness,
  surface: SuperagentView | null = surfaceOf(),
): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <SettingsPage surface={surface} />
    </RuntimeProvider>,
  )

beforeEach(() => {
  setShellPage('superagent')
  setSuperagentTab('publish')
  closeTicket()
  setHighlightedTicket(null)
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined
})

afterEach(() => {
  cleanup()
  setShellPage(null)
  setSuperagentTab('publish')
  closeTicket()
  setHighlightedTicket(null)
  document.querySelectorAll('.dsc-toasts, .dsc-confirm').forEach((node) => node.remove())
  vi.useRealTimers()
})

// ── state.ts：纯派生与投影 ─────────────────────────────────────────────────────

describe('state：阶段与时刻', () => {
  test('阶段名四组齐全；person 的五个动作各有一句话，认不出的动作退回组名', () => {
    expect(stageLabelOf({ stage: 'person', action: 'delivery' })).toBe('等你验收交付')
    expect(stageLabelOf({ stage: 'person', action: 'answer' })).toBe('等你回答')
    expect(stageLabelOf({ stage: 'person', action: 'review' })).toBe('等你审阅')
    expect(stageLabelOf({ stage: 'person', action: 'blocked' })).toBe('卡住了，等你处理')
    expect(stageLabelOf({ stage: 'person', action: 'failed' })).toBe('执行失败，等你处理')
    expect(stageLabelOf({ stage: 'person' })).toBe('需要你处理')
    expect(stageLabelOf({ stage: 'working', action: 'queued' })).toBe('排队中')
    expect(stageLabelOf({ stage: 'working' })).toBe('执行中')
    expect(stageLabelOf({ stage: 'idle' })).toBe('待命')
    expect(stageLabelOf({ stage: 'ended' })).toBe('已结束')
  })

  test('分组：person 进「需要你处理」，working 与 idle 都算「进行中」，ended 算「已完成」', () => {
    expect(stageGroupOf({ stage: 'person', action: 'delivery' })).toBe('person')
    expect(stageGroupOf({ stage: 'working', action: 'queued' })).toBe('working')
    expect(stageGroupOf({ stage: 'working' })).toBe('working')
    expect(stageGroupOf({ stage: 'idle' })).toBe('working')
    expect(stageGroupOf({ stage: 'ended' })).toBe('ended')
  })

  test('formatAt：合法 ISO 按本机时区画到分钟；空串与认不出的值不画', () => {
    expect(formatAt(isoAt(2026, 1, 2, 3, 4))).toBe('2026-01-02 03:04')
    expect(formatAt('')).toBe('')
    expect(formatAt('not-a-date')).toBe('')
  })
})

describe('state：快照投影', () => {
  test('整格缺席（快照没来 / 没有 surfaces / 没有 superagent）一律返回 null', () => {
    expect(readSuperagent(null)).toBeNull()
    expect(readSuperagent({} as unknown as HostSnapshot)).toBeNull()
    expect(readSuperagent({ surfaces: {} } as unknown as HostSnapshot)).toBeNull()
    expect(readSuperagent({ surfaces: { superagent: null } } as unknown as HostSnapshot)).toBeNull()
    expect(readSuperagent({ surfaces: [] } as unknown as HostSnapshot)).toBeNull()
  })

  test('脏字段按缺省处理：坏工单丢掉、坏计数按阶段现数、空文本动态不进最近列表', () => {
    const view = readSuperagent(
      snapshotOf({
        ready: 'yes',
        tickets: [
          null,
          'nope',
          { id: '', title: '没有 id' },
          {
            id: 't1',
            title: 'T1',
            stage: { stage: 'person', action: 'delivery' },
            at: isoAt(2026, 1, 2, 3, 4),
            branch: '',
            summary: '',
            changedFiles: ['a', 2, 'b'],
          },
          { id: 't2', title: 42, stage: 'working', at: 9 },
          { id: 't3', stage: { stage: 'person', action: 'nope' }, at: 9 },
        ],
        counts: { needsYou: 'x', running: 5, done: -1 },
        problem: { code: 'E1' },
        recent: [null, { text: '' }, { text: 'a', at: 1 }, { at: 't', text: 'b' }, 'x'],
      }),
    )
    expect(view).not.toBeNull()
    const parsed = view as NonNullable<typeof view>
    expect(parsed.ready).toBe(false)
    expect(parsed.tickets.map((ticket) => ticket.id)).toEqual(['t1', 't2', 't3'])
    expect(parsed.tickets[0]).toMatchObject({
      title: 'T1',
      stage: { stage: 'person', action: 'delivery' },
      at: isoAt(2026, 1, 2, 3, 4),
      changedFiles: ['a', 'b'],
    })
    expect(parsed.tickets[0]?.branch).toBeUndefined()
    expect(parsed.tickets[0]?.summary).toBeUndefined()
    expect(parsed.tickets[1]).toMatchObject({ title: '', stage: { stage: 'idle' }, at: '' })
    expect(parsed.tickets[2]?.stage).toEqual({ stage: 'person' })
    // counts 里只有 running 合法（5），needsYou / done 按工单现数：person 2、ended 0。
    expect(parsed.counts).toEqual({ needsYou: 2, running: 5, done: 0 })
    expect(parsed.problem).toEqual({ code: 'E1', detail: '' })
    expect(parsed.recent).toEqual([
      { at: '', text: 'a' },
      { at: 't', text: 'b' },
    ])
  })

  test('字段缺席时 tickets / recent 复用同一份冻结空数组（相等判断靠它）', () => {
    const first = readSuperagent(snapshotOf({ ready: true, tickets: 'x', recent: 1 }))
    const second = readSuperagent(snapshotOf({ ready: true }))
    expect(first).not.toBeNull()
    expect(first?.tickets).toBe(second?.tickets)
    expect(first?.recent).toBe(second?.recent)
    expect(first?.tickets).toHaveLength(0)
    expect(first?.recent).toHaveLength(0)
  })
})

describe('state：视图相等判断', () => {
  const base = (): SuperagentView =>
    surfaceOf({
      counts: { needsYou: 1, running: 2, done: 3 },
      problem: { code: 'E1', detail: '详情' },
      tickets: [
        ticketOf('t1', {
          stage: { stage: 'person', action: 'delivery' },
          summary: '摘要',
          branch: 'main',
          changedFiles: ['a.ts', 'b.ts'],
        }),
      ],
      recent: [{ at: 't', text: '动态' }],
    })

  test('内容相同的新对象判等；null 与对象、两个 null 的边界', () => {
    expect(sameSuperagent(null, null)).toBe(true)
    expect(sameSuperagent(null, base())).toBe(false)
    expect(sameSuperagent(base(), null)).toBe(false)
    const left = base()
    expect(sameSuperagent(left, left)).toBe(true)
    expect(sameSuperagent(left, base())).toBe(true)
  })

  test('任一会变的内容变了就不等：ready / problem / counts / 工单字段 / recent', () => {
    const left = base()
    const changed: SuperagentView[] = [
      { ...base(), ready: false },
      { ...base(), problem: { code: 'E2', detail: '详情' } },
      { ...base(), problem: { code: 'E1', detail: '换了' } },
      { ...base(), counts: { needsYou: 9, running: 2, done: 3 } },
      { ...base(), tickets: [] },
      { ...base(), tickets: [ticketOf('t1', { title: '换了' })] },
      { ...base(), tickets: [ticketOf('t1', { stage: { stage: 'ended' }, summary: '摘要', branch: 'main', changedFiles: ['a.ts', 'b.ts'] })] },
      { ...base(), tickets: [ticketOf('t1', { stage: { stage: 'person', action: 'delivery' }, summary: '摘要', branch: 'main', changedFiles: ['a.ts', 'b.ts', 'c.ts'] })] },
      { ...base(), recent: [] },
      { ...base(), recent: [{ at: 't', text: '换了一条' }] },
    ]
    for (const next of changed) expect(sameSuperagent(left, next)).toBe(false)
  })
})

describe('state：模块级导航信号', () => {
  test('页签 / 选中工单 / 高亮三个信号能被 hook 读到并跟着写更新', () => {
    render(<SignalProbe />)
    expect(probeText()).toBe('publish|-|-')
    act(() => {
      setSuperagentTab('tickets')
      openTicket('t1')
      setHighlightedTicket('t1')
    })
    expect(probeText()).toBe('tickets|t1|t1')
    act(() => {
      setSuperagentTab('settings')
      closeTicket()
      setHighlightedTicket(null)
    })
    expect(probeText()).toBe('settings|-|-')
  })
})

// ── ui.tsx：侧栏入口 ──────────────────────────────────────────────────────────

describe('侧栏入口', () => {
  test('徽标只在 needsYou > 0 时画；点一下切页到工单并清掉选中，再点一下回对话页', () => {
    setShellPage(null)
    const harness = harnessOf(snapshotOf(surfaceOf({ counts: { needsYou: 2, running: 0, done: 0 } })))
    const page = render(
      <RuntimeProvider channel={harness.channel}>
        <EntryRow />
        <SignalProbe />
      </RuntimeProvider>,
    )
    const entry = buttonByText(page.container, 'Super Agent')
    expect(entry.getAttribute('aria-pressed')).toBe('false')
    expect(entry.querySelector('[aria-label="2 张工单需要你处理"]')?.textContent).toBe('2')

    fireEvent.click(entry)
    expect(probeText()).toBe('tickets|-|-')
    expect(buttonByText(page.container, 'Super Agent').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(buttonByText(page.container, 'Super Agent'))
    expect(probeText()).toBe('tickets|-|-')
    expect(buttonByText(page.container, 'Super Agent').getAttribute('aria-pressed')).toBe('false')
  })

  test('停在设置页或工单详情时点入口：先回工单列表，不把整页关掉', () => {
    setSuperagentTab('settings')
    openTicket('t1')
    const harness = harnessOf(snapshotOf(surfaceOf({ counts: { needsYou: 0, running: 0, done: 0 } })))
    const page = render(
      <RuntimeProvider channel={harness.channel}>
        <EntryRow />
        <SignalProbe />
      </RuntimeProvider>,
    )
    const entry = buttonByText(page.container, 'Super Agent')
    expect(entry.querySelector('[style*="border-radius"]'), '计数为 0 时不画徽标').toBeNull()
    fireEvent.click(entry)
    expect(probeText()).toBe('tickets|-|-')
    expect(buttonByText(page.container, 'Super Agent').getAttribute('aria-pressed')).toBe('true')
  })
})

// ── ui.tsx：整页路由 ──────────────────────────────────────────────────────────

describe('整页路由', () => {
  test('快照里没有 superagent：画「没有启动」，四个页签仍在但内容不换成空白', () => {
    const harness = harnessOf(null)
    const page = mountPage(harness)
    expect(page.container.querySelector('.plugins-empty')?.textContent).toContain('没有启动')
    // 合并后页签行是「概览 / 发布 / 工单 / 设置」，顺序与 `ui.tsx:151-196` 一致。
    const tabs = [...page.container.querySelectorAll('[role="tab"]')]
    expect(tabs.map((tab) => tab.textContent)).toEqual(['概览', '发布', '工单', '设置'])
    fireEvent.click(tabs[2] as HTMLElement)
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('true')
    expect(page.container.querySelector('.plugins-empty')?.textContent).toContain('没有启动')
  })

  test('宿主插件在但编排库没打开：分「没有原因」与「带 problem」两种说明', async () => {
    const first = harnessOf(snapshotOf(surfaceOf({ ready: false })))
    const page = mountPage(first)
    await waitFor(() => expect(page.container.querySelector('.settings-note.error')?.textContent).toContain('还没启动'))

    cleanup()
    const second = harnessOf(
      snapshotOf(surfaceOf({ ready: false, problem: { code: 'E1', detail: '库打不开' } })),
    )
    const other = mountPage(second)
    await waitFor(() => expect(other.container.querySelector('.settings-note.error')?.textContent).toContain('E1'))
    expect(other.container.querySelector('.settings-note.error')?.textContent).toContain('库打不开')
  })

  test('设置页签在运行期没起来时也能进（改仓库路径正是为了让它起来）', async () => {
    const section: SettingsSectionView = {
      id: 'superagent',
      title: 'Super Agent 设置',
      order: 1,
      builtin: false,
      custom: false,
      fields: [],
    }
    const harness = harnessOf(
      snapshotOf(surfaceOf({ ready: false })),
      (method) => {
        if (method === 'getSettingsSections') return [section]
        if (method === 'getSectionValues') return {}
        return { ok: true }
      },
    )
    const page = mountPage(harness)
    // 页签顺序「概览 / 发布 / 工单 / 设置」：设置是第 4 个（`ui.tsx:185-195`）。
    fireEvent.click(page.container.querySelectorAll('[role="tab"]')[3] as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('.settings-group-title')?.textContent).toBe('Super Agent 设置'))
  })

  test('四个页签各自画自己的内容：概览计数 / 发布表单 / 工单空态 / 设置加载', async () => {
    const harness = harnessOf(
      snapshotOf(surfaceOf({ tickets: [] })),
      (method) => {
        if (method === 'getSettingsSections') return []
        return { ok: true }
      },
    )
    const page = mountPage(harness)
    // 默认停在发布页（`state.ts:458`）。
    expect(page.container.querySelector('input[aria-label="标题"]')).not.toBeNull()
    expect(page.container.querySelector('.settings-empty')?.textContent).toContain('还没有动态')

    // 概览：三格计数 + 一张工单都没有时的空态（`overview.tsx:86-92`）。
    fireEvent.click(page.container.querySelectorAll('[role="tab"]')[0] as HTMLElement)
    expect(page.container.querySelectorAll('.usage-card')).toHaveLength(3)
    expect(
      [...page.container.querySelectorAll('.usage-card-value')].map((node) => node.textContent),
    ).toEqual(['0', '0', '0'])
    expect(page.container.querySelector('.empty-card-title')?.textContent).toContain('这里还没有工单')

    // 发布：标题输入框回来了。
    fireEvent.click(page.container.querySelectorAll('[role="tab"]')[1] as HTMLElement)
    expect(page.container.querySelector('input[aria-label="标题"]')).not.toBeNull()

    // 工单：空态。
    fireEvent.click(page.container.querySelectorAll('[role="tab"]')[2] as HTMLElement)
    expect(page.container.querySelector('.empty-card-title')?.textContent).toContain('这里还没有工单')

    // 设置：宿主没登记分区时给一句人话。
    fireEvent.click(page.container.querySelectorAll('[role="tab"]')[3] as HTMLElement)
    await waitFor(() =>
      expect(page.container.querySelector('.settings-empty')?.textContent).toContain('宿主还没有登记 superagent 设置分区'),
    )
  })
})

// ── publish.tsx ───────────────────────────────────────────────────────────────

describe('发布页', () => {
  test('最近动态只取尾部 5 条并按新到旧排；没有动态时给空态', async () => {
    const recent = Array.from({ length: 7 }, (_, index) => ({
      at: isoAt(2026, 1, 2, 3, index),
      text: `动态 ${String(index)}`,
    }))
    const harness = harnessOf(snapshotOf(surfaceOf({ recent })))
    const page = mountPublish(harness, surfaceOf({ recent }))
    const labels = [...page.container.querySelectorAll('.plugin-detail-config .setting-label')].map(
      (node) => node.textContent,
    )
    expect(labels).toEqual(['动态 6', '动态 5', '动态 4', '动态 3', '动态 2'])
    expect(page.container.querySelector('.setting-control .mono')?.textContent).toBe('2026-01-02 03:06')

    cleanup()
    const empty = mountPublish(harnessOf(null), surfaceOf())
    expect(empty.container.querySelector('.settings-empty')?.textContent).toContain('还没有动态')
  })

  test('标题为空：按钮与回车都只报一句「先写一个标题」，不叫宿主', async () => {
    const harness = harnessOf(snapshotOf(surfaceOf()))
    const page = mountPublish(harness, surfaceOf())
    fireEvent.click(buttonByText(page.container, '发布工单'))
    expect(page.container.querySelector('.settings-note.error')?.textContent).toContain('先写一个标题')
    const title = page.container.querySelector('input[aria-label="标题"]') as HTMLInputElement
    fireEvent.keyDown(title, { key: 'Enter' })
    expect(page.container.querySelector('.settings-note.error')?.textContent).toContain('先写一个标题')
    expect(harness.calls.filter((call) => call.method === 'superagentPublish')).toHaveLength(0)
  })

  test('提交成功：标题 / 正文去空白、只交这两项；切到工单页并高亮新工单', async () => {
    const surface = surfaceOf({ tickets: [ticketOf('t1')] })
    const harness = harnessOf(snapshotOf(surface), (method) =>
      method === 'superagentPublish' ? 't1' : { ok: true },
    )
    const page = mountPublish(harness, surface)
    // 合并后发布页去掉了「起点分支」（`publish.tsx` 现在只收标题与正文）。
    expect(page.container.querySelector('input[aria-label="起点分支"]')).toBeNull()
    fireEvent.change(page.container.querySelector('input[aria-label="标题"]') as HTMLInputElement, {
      target: { value: '  标题  ' },
    })
    fireEvent.change(page.container.querySelector('textarea[aria-label="正文"]') as HTMLTextAreaElement, {
      target: { value: '  正文  ' },
    })
    fireEvent.click(buttonByText(page.container, '发布工单'))

    await waitFor(() => expect(harness.calls.some((call) => call.method === 'superagentPublish')).toBe(true))
    expect(harness.calls.find((call) => call.method === 'superagentPublish')?.args).toEqual([
      { title: '标题', body: '正文' },
    ])
    await waitFor(() => expect(probeText()).toBe('tickets|-|t1'))
    expect((page.container.querySelector('input[aria-label="标题"]') as HTMLInputElement).value).toBe('')
    expect((page.container.querySelector('textarea[aria-label="正文"]') as HTMLTextAreaElement).value).toBe('')
  })

  test('正文留空也照发（宿主用标题当正文）；提交参数没有 base 字段', async () => {
    const harness = harnessOf(snapshotOf(surfaceOf()), (method) =>
      method === 'superagentPublish' ? 't2' : { ok: true },
    )
    const page = mountPublish(harness, surfaceOf())
    fireEvent.change(page.container.querySelector('input[aria-label="标题"]') as HTMLInputElement, {
      target: { value: '只有标题' },
    })
    fireEvent.keyDown(page.container.querySelector('input[aria-label="标题"]') as HTMLInputElement, {
      key: 'Enter',
    })
    await waitFor(() => expect(harness.calls.some((call) => call.method === 'superagentPublish')).toBe(true))
    const input = harness.calls.find((call) => call.method === 'superagentPublish')?.args[0] as Record<string, unknown>
    expect(input).toEqual({ title: '只有标题', body: '' })
    expect('base' in input).toBe(false)
  })

  test('发布失败：错误原文翻成人话留在页上，输入不清空，忙态收回', async () => {
    const harness = harnessOf(snapshotOf(surfaceOf()), (method) =>
      method === 'superagentPublish' ? new Error('ECONNREFUSED 127.0.0.1') : { ok: true },
    )
    const page = mountPublish(harness, surfaceOf())
    fireEvent.change(page.container.querySelector('input[aria-label="标题"]') as HTMLInputElement, {
      target: { value: '会失败的标题' },
    })
    fireEvent.click(buttonByText(page.container, '发布工单'))
    await waitFor(() => expect(page.container.querySelector('.settings-note.error')?.textContent).toContain('发布失败'))
    expect((page.container.querySelector('input[aria-label="标题"]') as HTMLInputElement).value).toBe('会失败的标题')
    expect(buttonByText(page.container, '发布工单').disabled).toBe(false)
    expect(probeText()).toBe('publish|-|-')
  })

  test('提交中：按钮变「发布中…」且禁用，再按回车不会连发第二张', async () => {
    const pending = deferred<string>()
    const harness = harnessOf(snapshotOf(surfaceOf()), (method) =>
      method === 'superagentPublish' ? pending.promise : { ok: true },
    )
    const page = mountPublish(harness, surfaceOf())
    fireEvent.change(page.container.querySelector('input[aria-label="标题"]') as HTMLInputElement, {
      target: { value: '排队中的工单' },
    })
    fireEvent.click(buttonByText(page.container, '发布工单'))
    await waitFor(() => expect(buttonByText(page.container, '发布中…').disabled).toBe(true))
    fireEvent.keyDown(page.container.querySelector('input[aria-label="标题"]') as HTMLInputElement, {
      key: 'Enter',
    })
    expect(harness.calls.filter((call) => call.method === 'superagentPublish')).toHaveLength(1)
    await act(async () => {
      pending.resolve('t9')
    })
    expect(probeText()).toBe('tickets|-|t9')
  })
})

// ── tickets.tsx ───────────────────────────────────────────────────────────────

describe('工单列表', () => {
  test('一条都没有：空态给「去发布」，点了切到发布页签', () => {
    const harness = harnessOf(snapshotOf(surfaceOf()))
    const page = mountTickets(harness, surfaceOf())
    expect(page.container.querySelector('.empty-card-title')?.textContent).toContain('这里还没有工单')
    fireEvent.click(buttonByText(page.container, '去发布'))
    expect(probeText()).toBe('publish|-|-')
  })

  test('三组分组与计数按这一组画出来的条数算；标题为空用 id，时间按本机画', () => {
    const surface = surfaceOf({
      tickets: [
        ticketOf('p', { stage: { stage: 'person', action: 'delivery' }, summary: '等你验收' }),
        ticketOf('w', { stage: { stage: 'working', action: 'queued' } }),
        ticketOf('i', { stage: { stage: 'idle' }, title: '' }),
        ticketOf('e', { stage: { stage: 'ended' } }),
        ticketOf('p2', { stage: { stage: 'person', action: 'answer' } }),
      ],
    })
    const harness = harnessOf(snapshotOf(surface))
    const page = mountTickets(harness, surface)

    const groups = [...page.container.querySelectorAll('.plugin-group-label')].map((node) =>
      (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
    )
    expect(groups).toEqual(['需要你处理 2', '进行中 2', '已完成 1'])
    expect(page.container.querySelectorAll('.plugin-row')).toHaveLength(5)

    const idleRow = page.container.querySelector('[aria-label="查看工单：i"]') as HTMLElement
    expect(idleRow.querySelector('.plugin-name')?.textContent).toBe('i')
    const personRow = page.container.querySelector('[aria-label="查看工单：工单 p"]') as HTMLElement
    expect(personRow.querySelector('.plugin-desc')?.textContent).toBe('等你验收')
    expect(personRow.querySelector('.plugin-detail-src')?.textContent).toBe('等你验收交付')
    expect(personRow.querySelector('.mono')?.textContent).toBe('2026-01-02 03:04')
  })

  test('刚发布的行高亮，6 秒后自己清掉', () => {
    vi.useFakeTimers()
    setHighlightedTicket('h')
    const surface = surfaceOf({ tickets: [ticketOf('h'), ticketOf('other')] })
    const harness = harnessOf(snapshotOf(surface))
    const page = mountTickets(harness, surface)
    const highlighted = page.container.querySelector('[aria-label="查看工单：工单 h"]') as HTMLElement
    const other = page.container.querySelector('[aria-label="查看工单：工单 other"]') as HTMLElement
    expect(highlighted.style.background).toBe('var(--dsc-row-active-bg)')
    expect(other.style.background).toBe('')

    act(() => {
      vi.advanceTimersByTime(6_000)
    })
    expect((page.container.querySelector('[aria-label="查看工单：工单 h"]') as HTMLElement).style.background).toBe('')
  })

  test('点一行进详情；返回钮回到列表', async () => {
    const surface = surfaceOf({
      tickets: [ticketOf('t1', { stage: { stage: 'working' }, branch: 'feat/x', summary: '摘要' })],
    })
    const harness = harnessOf(snapshotOf(surface), (method) =>
      method === 'superagentPeekSession' ? [] : { ok: true },
    )
    const page = mountTickets(harness, surface)
    fireEvent.click(page.container.querySelector('[aria-label="查看工单：工单 t1"]') as HTMLElement)
    await waitFor(() => expect(page.container.querySelector('.plugin-detail')).not.toBeNull())
    expect(page.container.querySelector('.plugin-name')?.textContent).toBe('工单 t1')
    expect(probeText()).toBe('publish|t1|-')

    fireEvent.click(buttonByText(page.container, '工单列表'))
    expect(probeText()).toBe('publish|-|-')
    expect(page.container.querySelectorAll('.plugin-row')).toHaveLength(1)
  })
})

// ── detail.tsx ────────────────────────────────────────────────────────────────

describe('工单详情', () => {
  test('工单不在清单里：说清可能被清理 / 换工作区，返回钮仍可用', () => {
    const harness = harnessOf(snapshotOf(surfaceOf()))
    const page = mountDetail(harness, surfaceOf(), 'missing')
    expect(page.container.querySelector('.settings-empty')?.textContent).toContain('这张工单已经不在清单里')
    fireEvent.click(buttonByText(page.container, '工单列表'))
    expect(probeText()).toBe('publish|-|-')
  })

  test('头部读数：标题 / ID / 状态 / 建单时间 / 分支 / 交付摘要都画；缺的字段不画', () => {
    const full = ticketOf('t1', {
      stage: { stage: 'person', action: 'review' },
      branch: 'feat/superagent',
      summary: '改完了，等你审阅',
    })
    const surface = surfaceOf({ tickets: [full] })
    const page = mountDetail(harnessOf(snapshotOf(surface)), surface, 't1')
    expect(page.container.querySelector('.plugin-name')?.textContent).toBe('工单 t1')
    expect(page.container.querySelector('.plugin-detail-meta')?.textContent).toContain('工单 ID: t1')
    expect(page.container.textContent).toContain('等你审阅')
    expect(page.container.textContent).toContain('2026-01-02 03:04')
    expect(page.container.textContent).toContain('feat/superagent')
    expect(page.container.querySelector('.setting-help')?.textContent).toBe('改完了，等你审阅')

    cleanup()
    const bare = ticketOf('bare', { at: '', title: '' })
    const other = surfaceOf({ tickets: [bare] })
    const page2 = mountDetail(harnessOf(snapshotOf(other)), other, 'bare')
    expect(page2.container.querySelector('.plugin-name')?.textContent).toBe('bare')
    expect(page2.container.textContent).not.toContain('交付摘要')
    expect(page2.container.textContent).not.toContain('分支：')
    expect(page2.container.textContent).not.toContain('建单时间')
  })

  test('时间线：七类条目各画一行，空正文与记账条目跳过，超长正文截断补省略号', async () => {
    const long = 'x'.repeat(1_300)
    const entries = [
      { kind: 'user', id: 1, text: '需求正文', ts: new Date(2026, 0, 2, 3, 4).getTime() },
      { kind: 'thinking', id: 2, text: '思考正文' },
      { kind: 'text', id: 3, text: '' },
      { kind: 'text', id: 4, text: '回复正文' },
      {
        kind: 'tool',
        id: 5,
        call: { callId: 'c1', name: 'read_file', argsText: '{"p":1}', resultText: '文件内容', status: 'done' },
      },
      {
        kind: 'tool',
        id: 6,
        call: { callId: 'c2', name: 'grep', argsText: '只有参数', status: 'running' },
      },
      {
        kind: 'plan',
        id: 7,
        plan: { file: '/p.md', title: '计划标题', text: '计划正文', decision: 'pending' },
      },
      { kind: 'system', id: 8, text: '系统提示' },
      {
        kind: 'subagent',
        id: 9,
        sub: { name: '队友', role: '执行者', task: '做事', state: 'working', rounds: 1, toolCalls: 2 },
      },
      { kind: 'turn-end', id: 10, reason: 'stop' },
      { kind: 'text', id: 11, text: long },
    ] as unknown as TranscriptEntry[]
    const surface = surfaceOf({ tickets: [ticketOf('t1', { stage: { stage: 'working' } })] })
    const harness = harnessOf(snapshotOf(surface), (method) =>
      method === 'superagentPeekSession' ? entries : { ok: true },
    )
    const page = mountDetail(harness, surface, 't1')
    await waitFor(() => expect(page.container.querySelectorAll('.setting-row').length).toBe(9))
    const text = page.container.textContent ?? ''
    for (const expected of ['需求', '思考', '回复', '工具', '计划', '系统', '子任务']) {
      expect(text).toContain(expected)
    }
    expect(text).toContain('需求正文')
    expect(text).toContain('read_file')
    expect(text).toContain('文件内容')
    expect(text).toContain('只有参数')
    expect(text).toContain('计划标题')
    expect(text).toContain('队友 · 执行者')
    expect(text).toContain('03:04')
    expect(text).not.toContain(long)
    expect(text).toContain(`${'x'.repeat(1_200)}…`)
    expect(text).not.toContain('turn-end')
  })

  test('加载中 / 空时间线 / 刷新按钮：请求入参是 { id }，再点一次重读', async () => {
    const pending = deferred<TranscriptEntry[]>()
    let peekCount = 0
    const harness = harnessOf(snapshotOf(surfaceOf({ tickets: [ticketOf('t1')] })), (method) => {
      if (method === 'superagentPeekSession') {
        peekCount += 1
        return peekCount === 1 ? pending.promise : []
      }
      return { ok: true }
    })
    const surface = surfaceOf({ tickets: [ticketOf('t1')] })
    const page = mountDetail(harness, surface, 't1')
    expect(page.container.querySelector('[role="status"]')?.textContent).toContain('正在读执行会话')
    await act(async () => {
      pending.resolve([])
    })
    await waitFor(() => expect(page.container.querySelector('.settings-empty')?.textContent).toContain('执行会话还是空的'))
    expect(harness.calls.find((call) => call.method === 'superagentPeekSession')?.args).toEqual([{ id: 't1' }])

    fireEvent.click(page.container.querySelector('[aria-label="重新读取"]') as HTMLElement)
    await waitFor(() => expect(peekCount).toBe(2))
  })

  test('读执行会话失败：常驻错误条说清原因，不装成空时间线', async () => {
    const surface = surfaceOf({ tickets: [ticketOf('t1')] })
    const harness = harnessOf(snapshotOf(surface), (method) =>
      method === 'superagentPeekSession' ? new Error('boom') : { ok: true },
    )
    const page = mountDetail(harness, surface, 't1')
    await waitFor(() => expect(page.container.querySelector('.settings-note.error')?.textContent).toContain('读不到执行会话：boom'))
    expect(page.container.querySelector('.settings-empty')).toBeNull()
  })

  test('按钮可用性按阶段给：跑着的不能重试 / 已结束的不能停止，清理只对已结束开放', () => {
    const working = surfaceOf({ tickets: [ticketOf('w', { stage: { stage: 'working' } })] })
    const page = mountDetail(harnessOf(snapshotOf(working)), working, 'w')
    expect(buttonByText(page.container, '停止').disabled).toBe(false)
    expect(buttonByText(page.container, '重试').disabled).toBe(true)
    const clean = buttonByText(page.container, '清理')
    expect(clean.disabled).toBe(true)
    expect(clean.getAttribute('title')).toContain('只有已结束的工单能清理')

    cleanup()
    const ended = surfaceOf({ tickets: [ticketOf('e', { stage: { stage: 'ended' } })] })
    const page2 = mountDetail(harnessOf(snapshotOf(ended)), ended, 'e')
    expect(buttonByText(page2.container, '停止').disabled).toBe(true)
    expect(buttonByText(page2.container, '重试').disabled).toBe(false)
    expect(buttonByText(page2.container, '清理').disabled).toBe(false)
  })

  test('停止 / 重试：动作入参是 { id }，成功回执留在页上并重读时间线', async () => {
    const surface = surfaceOf({ tickets: [ticketOf('t1', { stage: { stage: 'working' } })] })
    const harness = harnessOf(snapshotOf(surface), (method) =>
      method === 'superagentStopTicket' ? { ok: true } : method === 'superagentPeekSession' ? [] : { ok: true },
    )
    const page = mountDetail(harness, surface, 't1')
    await waitFor(() => expect(harness.calls.some((call) => call.method === 'superagentPeekSession')).toBe(true))
    fireEvent.click(buttonByText(page.container, '停止'))
    await waitFor(() => expect(page.container.querySelector('.settings-note')?.textContent).toContain('已发送停止请求'))
    expect(harness.calls.find((call) => call.method === 'superagentStopTicket')?.args).toEqual([{ id: 't1' }])
    await waitFor(() => expect(harness.calls.filter((call) => call.method === 'superagentPeekSession')).toHaveLength(2))

    cleanup()
    const ended = surfaceOf({ tickets: [ticketOf('e', { stage: { stage: 'ended' } })] })
    const retryHarness = harnessOf(snapshotOf(ended), (method) =>
      method === 'superagentRetryTicket' ? { ok: true } : method === 'superagentPeekSession' ? [] : { ok: true },
    )
    const page2 = mountDetail(retryHarness, ended, 'e')
    fireEvent.click(buttonByText(page2.container, '重试'))
    await waitFor(() => expect(page2.container.querySelector('.settings-note')?.textContent).toContain('已发送重试请求'))
    expect(retryHarness.calls.find((call) => call.method === 'superagentRetryTicket')?.args).toEqual([{ id: 'e' }])
  })

  test('动作失败：错误翻成人话留在页上', async () => {
    const surface = surfaceOf({ tickets: [ticketOf('t1', { stage: { stage: 'working' } })] })
    const harness = harnessOf(snapshotOf(surface), (method) =>
      method === 'superagentStopTicket' ? new Error('boom') : method === 'superagentPeekSession' ? [] : { ok: true },
    )
    const page = mountDetail(harness, surface, 't1')
    fireEvent.click(buttonByText(page.container, '停止'))
    await waitFor(() => expect(page.container.querySelector('.settings-note.error')?.textContent).toContain('操作失败：boom'))
  })

  test('清理工作树：确认框取消不动桥；确认后调 superagentCleanWorktree 并留回执', async () => {
    const surface = surfaceOf({ tickets: [ticketOf('e', { stage: { stage: 'ended' } })] })
    const harness = harnessOf(snapshotOf(surface), (method) =>
      method === 'superagentPeekSession' ? [] : { ok: true },
    )
    const page = mountDetail(harness, surface, 'e')

    fireEvent.click(buttonByText(page.container, '清理'))
    await waitFor(() => expect(document.querySelector('.dsc-confirm')).not.toBeNull())
    expect(document.querySelector('.dsc-confirm__title')?.textContent).toContain('清理这张工单的工作树')
    fireEvent.click(document.querySelectorAll('.dsc-confirm__actions button')[0] as HTMLElement)
    expect(harness.calls.some((call) => call.method === 'superagentCleanWorktree')).toBe(false)

    fireEvent.click(buttonByText(page.container, '清理'))
    await waitFor(() => expect(document.querySelector('.dsc-confirm')).not.toBeNull())
    fireEvent.click(document.querySelectorAll('.dsc-confirm__actions button')[1] as HTMLElement)
    await waitFor(() => expect(harness.calls.some((call) => call.method === 'superagentCleanWorktree')).toBe(true))
    expect(harness.calls.find((call) => call.method === 'superagentCleanWorktree')?.args).toEqual([{ id: 'e' }])
    await waitFor(() => expect(page.container.querySelector('.settings-note')?.textContent).toContain('工作树已清理'))
  })
})

// ── settings.tsx ──────────────────────────────────────────────────────────────

const SIMPLE_SECTION: SettingsSectionView = {
  id: 'superagent',
  title: 'Super Agent',
  subtitle: '工单与执行设置',
  order: 1,
  builtin: false,
  custom: false,
  fields: [
    { type: 'info', label: '仓库路径', text: 'D:\\ws', mono: true, help: '工作树建在这里' },
    { type: 'text', key: 'workspace', label: '工作区', placeholder: '绝对路径' },
    { type: 'number', key: 'maxTickets', label: '并发数', min: 1, max: 8, step: 1 },
    {
      type: 'select',
      key: 'mode',
      label: '模式',
      help: '运行模式',
      options: [
        { value: 'a', label: '甲' },
        { value: 'b', label: '乙' },
      ],
    },
    { type: 'switch', key: 'auto', label: '自动' },
    { type: 'button', action: 'scan', label: '扫描', style: 'ghost', help: '刷新清单' },
  ],
}

const SIMPLE_VALUES: SettingsValues = { workspace: 'D:/ws', maxTickets: 2, mode: 'a', auto: false }

/** 设置页的假宿主：值表可变，写入成功后回读拿得到新值。 */
function settingsHarness(
  options: { values?: SettingsValues; section?: SettingsSectionView | null; mutation?: unknown } = {},
): Harness & { values: SettingsValues } {
  const values = { ...(options.values ?? SIMPLE_VALUES) }
  const section = options.section === undefined ? SIMPLE_SECTION : options.section
  const harness = harnessOf(
    snapshotOf(surfaceOf()),
    (method, args) => {
      if (method === 'getSettingsSections') return section === null ? [] : [section]
      if (method === 'getSectionValues') return values
      if (method === 'setSettingValue') {
        if (options.mutation instanceof Error) return options.mutation
        if (options.mutation !== undefined) return options.mutation
        values[String(args[1])] = args[2] as SettingsValues[string]
        return { ok: true, notice: '已保存' }
      }
      if (method === 'runSettingAction') {
        if (options.mutation instanceof Error) return options.mutation
        if (options.mutation !== undefined) return options.mutation
        return { ok: true, notice: '扫描完成' }
      }
      return { ok: true }
    },
  )
  return { ...harness, values }
}

describe('设置页', () => {
  test('加载中先是「正在读设置…」，读完拿 superagent 分区并回读值', async () => {
    const pending = deferred<SettingsSectionView[]>()
    const harness = harnessOf(snapshotOf(surfaceOf()), (method) => {
      if (method === 'getSettingsSections') return pending.promise
      if (method === 'getSectionValues') return SIMPLE_VALUES
      return { ok: true }
    })
    const page = mountSettings(harness)
    expect(page.container.querySelector('[role="status"]')?.textContent).toContain('正在读设置')
    await act(async () => {
      pending.resolve([SIMPLE_SECTION])
    })
    await waitFor(() => expect(page.container.querySelector('.settings-group-title')?.textContent).toBe('Super Agent'))
    expect(harness.calls.find((call) => call.method === 'getSectionValues')?.args).toEqual(['superagent'])
  })

  test('宿主没登记分区：说清去插件中心打开', async () => {
    const page = mountSettings(settingsHarness({ section: null }))
    await waitFor(() =>
      expect(page.container.querySelector('.settings-empty')?.textContent).toContain('宿主还没有登记 superagent 设置分区'),
    )
  })

  test('读分区清单失败：把原因翻成人话留在页上', async () => {
    const harness = harnessOf(snapshotOf(surfaceOf()), (method) =>
      method === 'getSettingsSections' ? new Error('boom') : { ok: true },
    )
    const page = mountSettings(harness)
    await waitFor(() => expect(page.container.querySelector('.settings-empty')?.textContent).toContain('读设置失败：boom'))
  })

  test('分区没有可改项：给一句「没有可改的项」而不是空白', async () => {
    const section: SettingsSectionView = { ...SIMPLE_SECTION, fields: [] }
    const page = mountSettings(settingsHarness({ section }))
    await waitFor(() =>
      expect(page.container.querySelector('.settings-empty')?.textContent).toContain('这个分区现在没有可改的项'),
    )
  })

  test('六种字段都按声明画：info / text / number / select / switch / button', async () => {
    const page = mountSettings(settingsHarness())
    await waitFor(() => expect(page.container.querySelector('.settings-group-title')?.textContent).toBe('Super Agent'))
    expect(page.container.querySelector('.setting-help')?.textContent).toBe('工单与执行设置')
    expect(page.container.querySelector('.setting-info')?.textContent).toBe('D:\\ws')
    expect(page.container.querySelector('.setting-info .mono')).not.toBeNull()

    const workspace = page.container.querySelector('input[aria-label="工作区"]') as HTMLInputElement
    expect(workspace.value).toBe('D:/ws')
    expect(workspace.placeholder).toBe('绝对路径')
    const maxTickets = page.container.querySelector('input[aria-label="并发数"]') as HTMLInputElement
    expect(maxTickets.type).toBe('number')
    expect(maxTickets.value).toBe('2')
    expect(maxTickets.min).toBe('1')
    expect(maxTickets.max).toBe('8')

    expect(document.querySelector('[aria-label="模式"]')?.textContent).toContain('甲')
    const toggle = page.container.querySelector('[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    const button = buttonByText(page.container, '扫描')
    expect(button.className).toContain('btn-ghost')
  })

  test('下拉选了就写、开关点了就写；成功回执显示并回读值', async () => {
    const harness = settingsHarness()
    const page = mountSettings(harness)
    await waitFor(() => expect(page.container.querySelector('[role="switch"]')).not.toBeNull())

    chooseSelectOption('模式', '乙')
    await waitFor(() =>
      expect(harness.calls.some((call) => call.method === 'setSettingValue' && call.args[1] === 'mode')).toBe(true),
    )
    expect(harness.calls.find((call) => call.method === 'setSettingValue')?.args).toEqual(['superagent', 'mode', 'b'])
    await waitFor(() => expect(page.container.querySelector('.settings-note')?.textContent).toBe('已保存'))

    fireEvent.click(page.container.querySelector('[role="switch"]') as HTMLElement)
    await waitFor(() =>
      expect(harness.calls.some((call) => call.method === 'setSettingValue' && call.args[1] === 'auto')).toBe(true),
    )
    expect(harness.calls.find((call) => call.args[1] === 'auto')?.args).toEqual(['superagent', 'auto', true])
  })

  test('文本边打边写不落盘，失焦才提交；数字回车提交成 number', async () => {
    const harness = settingsHarness()
    const page = mountSettings(harness)
    await waitFor(() => expect(page.container.querySelector('input[aria-label="工作区"]')).not.toBeNull())
    const before = harness.calls.filter((call) => call.method === 'setSettingValue').length

    const workspace = page.container.querySelector('input[aria-label="工作区"]') as HTMLInputElement
    fireEvent.change(workspace, { target: { value: 'C:/new' } })
    expect(harness.calls.filter((call) => call.method === 'setSettingValue')).toHaveLength(before)
    fireEvent.blur(workspace)
    await waitFor(() =>
      expect(harness.calls.some((call) => call.method === 'setSettingValue' && call.args[1] === 'workspace')).toBe(true),
    )
    expect(harness.calls.find((call) => call.args[1] === 'workspace')?.args).toEqual([
      'superagent',
      'workspace',
      'C:/new',
    ])

    const number = page.container.querySelector('input[aria-label="并发数"]') as HTMLInputElement
    number.focus()
    fireEvent.change(number, { target: { value: '5' } })
    fireEvent.keyDown(number, { key: 'Enter' })
    await waitFor(() =>
      expect(harness.calls.some((call) => call.method === 'setSettingValue' && call.args[1] === 'maxTickets')).toBe(true),
    )
    expect(harness.calls.find((call) => call.args[1] === 'maxTickets')?.args).toEqual(['superagent', 'maxTickets', 5])
  })

  test('保存失败（回执 ok:false / 直接 reject）都留一句人话', async () => {
    const rejected = mountSettings(settingsHarness({ mutation: { ok: false, error: 'nope' } }))
    await waitFor(() => expect(rejected.container.querySelector('[role="switch"]')).not.toBeNull())
    fireEvent.click(rejected.container.querySelector('[role="switch"]') as HTMLElement)
    await waitFor(() =>
      expect(rejected.container.querySelector('.settings-note.error')?.textContent).toContain('保存失败：nope'),
    )

    cleanup()
    const thrown = mountSettings(settingsHarness({ mutation: new Error('boom') }))
    await waitFor(() => expect(thrown.container.querySelector('[role="switch"]')).not.toBeNull())
    fireEvent.click(thrown.container.querySelector('[role="switch"]') as HTMLElement)
    await waitFor(() =>
      expect(thrown.container.querySelector('.settings-note.error')?.textContent).toContain('保存失败：boom'),
    )
  })

  test('按钮字段：动作 id 与分区 id 一起交给宿主，成功后重取分区并显示 notice', async () => {
    const harness = settingsHarness()
    const page = mountSettings(harness)
    await waitFor(() => expect(buttonByText(page.container, '扫描')).not.toBeUndefined())
    const before = harness.calls.filter((call) => call.method === 'getSettingsSections').length
    fireEvent.click(buttonByText(page.container, '扫描'))
    await waitFor(() => expect(harness.calls.some((call) => call.method === 'runSettingAction')).toBe(true))
    expect(harness.calls.find((call) => call.method === 'runSettingAction')?.args).toEqual(['superagent', 'scan'])
    // 成功后 load() 会重取分区并把上一句 notice 清掉（提示只活到下一次读）。
    await waitFor(() =>
      expect(harness.calls.filter((call) => call.method === 'getSettingsSections').length).toBe(before + 1),
    )
  })

  test('动作失败：说清失败原因', async () => {
    const harness = settingsHarness({ mutation: { ok: false, error: 'nope' } })
    const page = mountSettings(harness)
    await waitFor(() => expect(buttonByText(page.container, '扫描')).not.toBeUndefined())
    fireEvent.click(buttonByText(page.container, '扫描'))
    await waitFor(() =>
      expect(page.container.querySelector('.settings-note.error')?.textContent).toContain('操作失败：nope'),
    )
  })

  test('派生值不在选项里：下拉置灰只读并显示宿主给的显示名', async () => {
    const section: SettingsSectionView = {
      ...SIMPLE_SECTION,
      fields: [
        {
          type: 'select',
          key: 'permission',
          label: '权限',
          options: [{ value: 'a', label: '甲' }],
          derivedLabelKey: 'permissionLabel',
        },
      ],
    }
    const page = mountSettings(
      settingsHarness({ section, values: { permission: 'custom', permissionLabel: '自定义组合' } }),
    )
    await waitFor(() => expect(document.querySelector('[aria-label="权限"]')).not.toBeNull())
    const trigger = document.querySelector('[aria-label="权限"]') as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    expect(trigger.textContent).toContain('自定义组合')
  })

  test('未知值且没有派生名：补一条「当前值不在选项里」的可选项，而不是空白', async () => {
    const page = mountSettings(settingsHarness({ values: { ...SIMPLE_VALUES, mode: 'zzz' } }))
    await waitFor(() => expect(document.querySelector('[aria-label="模式"]')).not.toBeNull())
    const trigger = document.querySelector('[aria-label="模式"]') as HTMLButtonElement
    expect(trigger.disabled).toBe(false)
    expect(trigger.textContent).toContain('当前值不在选项里：zzz')
  })
})
