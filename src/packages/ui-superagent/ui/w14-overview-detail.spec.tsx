/**
 * Super Agent 概览页与详情页的第四批补测（W14）：两页还没被 `pages-extra.spec` 走到的出口。
 *
 * 概览页（`overview.tsx`）：
 * - 有工单时不画空态、改画最近动态（时刻认不出就不画右栏）；
 * - 「来源」区块：两种来源名、未启用、从未轮询、时刻读不懂回落 ISO、轮询时长四档、错误原文；
 * - 一条统计都没有时的空态按钮：点一下切到发布页。
 *
 * 详情页（`detail.tsx`）：
 * - 「等你回答」那一档的回话框：输入、点按钮发送、成功清空；失败留原因；
 * - Ctrl/Cmd+Enter 发送；
 * - 跑动中的工单每 5 秒自动重读时间线（静默刷新）。
 *
 * @module dsc-ui-superagent/ui/w14-overview-detail.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, TranscriptEntry } from '@dsc/ui'
import { DetailPage } from './detail.js'
import { OverviewPage } from './overview.js'
import {
  closeTicket,
  setSuperagentTab,
  useSuperagentTab,
  type SuperagentSource,
  type SuperagentTicket,
  type SuperagentView,
} from './state.js'
import zh from '../locale/ui.zh.json'

// ── 夹具 ─────────────────────────────────────────────────────────────────────

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
  } as SuperagentTicket
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

interface Invoke {
  method: string
  args: unknown[]
}

type Reply = (method: string) => unknown

/** 假宿主：快照给空（两页都靠 props 的 surface），invoke 可换回答。 */
function harnessOf(reply: Reply = () => ({ ok: true })): {
  channel: HostChannel
  calls: Invoke[]
} {
  const calls: Invoke[] = []
  const channel: HostChannel = {
    getSnapshot: () => null as unknown as HostSnapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: <T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      try {
        const value = reply(method)
        if (value instanceof Error) return Promise.reject(value) as Promise<T>
        return Promise.resolve(value) as Promise<T>
      } catch (error: unknown) {
        return Promise.reject(error) as Promise<T>
      }
    },
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

/** 页签信号的观察窗（模块级信号不在 props 链上）。 */
function TabProbe(): ReactNode {
  return <span data-testid="tab-probe">{useSuperagentTab()}</span>
}

const tabText = (): string => document.querySelector('[data-testid="tab-probe"]')?.textContent ?? ''

const mountOverview = (surface: SuperagentView): ReturnType<typeof render> => {
  const { channel } = harnessOf()
  return render(
    <RuntimeProvider channel={channel}>
      <OverviewPage surface={surface} />
      <TabProbe />
    </RuntimeProvider>,
  )
}

const mountDetail = (
  surface: SuperagentView,
  id: string,
  reply?: Reply,
): { view: ReturnType<typeof render>; calls: Invoke[] } => {
  const harness = harnessOf(reply)
  const view = render(
    <RuntimeProvider channel={harness.channel}>
      <DetailPage surface={surface} id={id} />
    </RuntimeProvider>,
  )
  return { view, calls: harness.calls }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date(2026, 10, 2, 15, 0, 0))
})

afterEach(() => {
  cleanup()
  closeTicket()
  setSuperagentTab('overview')
  vi.useRealTimers()
})

// ── 概览页 ───────────────────────────────────────────────────────────────────

describe('概览页：最近动态与来源区块', () => {
  test('有工单时画最近动态（时刻认不出的那条不画右栏）', () => {
    const { container } = mountOverview(
      surfaceOf({
        tickets: [ticketOf('t1')],
        recent: [
          { at: isoAt(2026, 11, 2, 14, 30), text: '工单 t1 完成' },
          { at: '不是时刻', text: '来路不明的动态' },
        ],
      }),
    )
    expect(container.querySelector('.empty-card')).toBeNull()
    const rows = [...container.querySelectorAll('.setting-row')]
    expect(rows.length).toBe(2)
    expect(rows[0]?.querySelector('.setting-control')?.textContent).toContain('2026-11-02 14:30')
    // 时刻认不出的那条：正文照画，右栏不画一条空壳。
    expect(rows[1]?.querySelector('.setting-label')?.textContent).toBe('来路不明的动态')
    expect(rows[1]?.querySelector('.setting-control')).toBeNull()
  })

  test('没有动态时画一句空态', () => {
    const { container } = mountOverview(surfaceOf({ tickets: [ticketOf('t1')] }))
    expect(container.querySelector('.settings-empty')?.textContent).toBe(zh['superagent.overview.recentEmpty'])
  })

  test('来源区块：两种来源名、未启用、从未轮询、时刻读不懂回落 ISO、时长四档、错误原文', () => {
    const now = Date.now()
    const sources: SuperagentSource[] = [
      { id: 'github', enabled: false },
      { id: 'feishu', enabled: true, lastError: '401 Unauthorized: 令牌过期' },
      { id: 'github', enabled: true, lastPollAt: '不是时刻' },
      {
        id: 'feishu',
        enabled: true,
        lastPollAt: new Date(now - 30_000).toISOString(),
      },
      {
        id: 'github',
        enabled: true,
        lastPollAt: new Date(now - 5 * 60_000).toISOString(),
      },
      {
        id: 'feishu',
        enabled: true,
        lastPollAt: new Date(now - 3 * 3_600_000).toISOString(),
      },
      {
        id: 'github',
        enabled: true,
        lastPollAt: new Date(now - 3 * 24 * 3_600_000).toISOString(),
      },
      { id: 'mystery-source', enabled: true },
    ]
    const { container } = mountOverview(surfaceOf({ tickets: [ticketOf('t1')], sources }))
    const labels = [...container.querySelectorAll('.setting-label')].map((node) => node.textContent)
    // 认不出的来源原样显示 id。
    expect(labels).toEqual(expect.arrayContaining(['GitHub', '飞书', 'mystery-source']))
    const text = container.textContent ?? ''
    expect(text).toContain(zh['superagent.overview.sources.disabled'])
    expect(text).toContain(zh['superagent.overview.sources.never'])
    // 时刻读不懂：把 ISO 原样显示出来，而不是说「从未成功」。
    expect(text).toContain('不是时刻')
    expect(text).toContain('401 Unauthorized: 令牌过期')
    // 四档时长：刚刚 / N 分钟前 / N 小时前 / N 天前 各出现一次。
    expect(text).toContain(zh['superagent.overview.sources.justNow'])
    expect(text).toContain(zh['superagent.overview.sources.minutesAgo'].replace('{count}', '5'))
    expect(text).toContain(zh['superagent.overview.sources.hoursAgo'].replace('{count}', '3'))
    expect(text).toContain(zh['superagent.overview.sources.daysAgo'].replace('{count}', '3'))
  })

  test('旧快照没有 sources 这一格：整块不画', () => {
    const { container } = mountOverview(surfaceOf({ tickets: [ticketOf('t1')] }))
    expect(container.textContent).not.toContain(zh['superagent.overview.sources'])
  })

  test('零工单空态：点「去发布」切到发布页', () => {
    const { container } = mountOverview(surfaceOf())
    expect(container.querySelector('.empty-card-title')?.textContent).toBe(zh['superagent.overview.empty'])
    const button = [...container.querySelectorAll('button')].find((item) =>
      (item.textContent ?? '').includes(zh['superagent.overview.emptyAction']),
    )
    if (button === undefined) throw new Error('空态没有画「去发布」按钮')
    fireEvent.click(button)
    expect(tabText()).toBe('publish')
  })
})

// ── 详情页 ───────────────────────────────────────────────────────────────────

describe('详情页：回话框', () => {
  /** 「等你回答」那张工单。 */
  const awaiting = (over: Partial<SuperagentTicket> = {}): SuperagentTicket =>
    ticketOf('t-answer', {
      stage: { stage: 'person', action: 'answer' },
      question: '要现在发布吗？',
      ...over,
    })

  const answerBox = (root: ParentNode): HTMLTextAreaElement => {
    const box = root.querySelector(`textarea[aria-label="${zh['superagent.detail.answer.title']}"]`)
    if (box === null) throw new Error('没有画回话框')
    return box as HTMLTextAreaElement
  }

  test('输入后点发送：把 trim 后的正文交给宿主，成功后清空草稿', async () => {
    const { view, calls } = mountDetail(surfaceOf({ tickets: [awaiting()] }), 't-answer', (method) =>
      method === 'superagentPeekSession' ? [] : { ok: true },
    )
    await waitFor(() => expect(answerBox(view.container)).not.toBeNull())
    fireEvent.change(answerBox(view.container), {
      target: { value: '  可以发布  ' },
    })
    const send = [...view.container.querySelectorAll('button')].find((item) =>
      (item.textContent ?? '').includes(zh['superagent.detail.answer.send']),
    )
    if (send === undefined) throw new Error('没有画发送按钮')
    await act(async () => {
      fireEvent.click(send)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls.some((call) => call.method === 'superagentAnswer')).toBe(true)
    const answer = calls.find((call) => call.method === 'superagentAnswer')
    expect(answer?.args[0] as { ticketId: string; text: string }).toEqual({
      ticketId: 't-answer',
      text: '可以发布',
    })
    await waitFor(() => expect(answerBox(view.container).value).toBe(''))
  })

  test('Ctrl+Enter 也能发；宿主拒绝时把原因留在框下', async () => {
    const { view, calls } = mountDetail(surfaceOf({ tickets: [awaiting()] }), 't-answer', (method) => {
      if (method === 'superagentPeekSession') return []
      return new Error('通道断了')
    })
    await waitFor(() => expect(answerBox(view.container)).not.toBeNull())
    fireEvent.change(answerBox(view.container), {
      target: { value: '回一句' },
    })
    await act(async () => {
      fireEvent.keyDown(answerBox(view.container), {
        key: 'Enter',
        ctrlKey: true,
      })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls.some((call) => call.method === 'superagentAnswer')).toBe(true)
    await waitFor(() =>
      expect(view.container.querySelector('.settings-note.error')?.textContent).toContain(
        zh['superagent.detail.answer.failed'].replace('{message}', '通道断了'),
      ),
    )
  })

  test('空白草稿点发送：什么都不发', async () => {
    const { view, calls } = mountDetail(surfaceOf({ tickets: [awaiting()] }), 't-answer', (method) =>
      method === 'superagentPeekSession' ? [] : { ok: true },
    )
    await waitFor(() => expect(answerBox(view.container)).not.toBeNull())
    fireEvent.change(answerBox(view.container), { target: { value: '   ' } })
    const send = [...view.container.querySelectorAll('button')].find((item) =>
      (item.textContent ?? '').includes(zh['superagent.detail.answer.send']),
    ) as HTMLButtonElement | undefined
    if (send === undefined) throw new Error('没有画发送按钮')
    expect(send.disabled).toBe(true)
    await act(async () => {
      fireEvent.click(send)
      await Promise.resolve()
    })
    expect(calls.some((call) => call.method === 'superagentAnswer')).toBe(false)
  })
})

describe('详情页：跑动中的工单定时重读', () => {
  test('working 档每 5 秒静默重读一次时间线；结束后不再读', async () => {
    const working = ticketOf('t-live', { stage: { stage: 'working' } })
    const { calls } = mountDetail(surfaceOf({ tickets: [working] }), 't-live', (method) =>
      method === 'superagentPeekSession' ? ([] as TranscriptEntry[]) : { ok: true },
    )
    await waitFor(() => expect(calls.filter((call) => call.method === 'superagentPeekSession').length).toBe(1))
    await act(async () => {
      vi.advanceTimersByTime(5000)
      await Promise.resolve()
    })
    await waitFor(() => expect(calls.filter((call) => call.method === 'superagentPeekSession').length).toBe(2))
  })
})
