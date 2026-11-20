/**
 * `ui-trace` 的补盲：检查器里的图片放大浮层关闭钮、入参复制两种回执，
 * 以及轨迹页工具卡的状态列（工厂局部组件 `statusDetail`）。
 *
 * 缺口逐条：
 *   - `inspector.tsx:237-238`：放大浮层里那颗 ×——单击就关（且不把点击再传给遮罩）；
 *   - `inspector.tsx:294-299`：复制入参的成功 / 失败两种回执；
 *   - `ui.tsx:752-755`：`TraceStatus`（工厂局部组件）真的被渲染时算耗时与状态文案。
 *     既有用例的 `renderFactorySlot` 一律走 fallback，所以这一件从没被挂上过。
 *
 * 挂载方式沿用同目录 `trace-extra.spec.tsx`：照壳装载插件收下轨迹页组件，套
 * RuntimeProvider；区别是这一份的 `renderFactorySlot` 会真的渲染传进来的局部组件。
 *
 * @module dsc-ui-trace/ui/w14-trace
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, TranscriptEntry, UiPluginApi } from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import plugin from './ui.js'

/** 轨迹页组件：照壳装载插件那条路收下第一份登记。 */
function traceComponent(): ComponentType<Record<string, unknown>> {
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
    consume(): undefined {
      return undefined
    },
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  const found = registered[0]
  if (found === undefined) throw new Error('trace 插件没有登记组件')
  return found.component as ComponentType<Record<string, unknown>>
}

const TraceView = traceComponent()

const BASE = 1_767_240_000_000

const user = (id: number, text: string, extra: Partial<Extract<TranscriptEntry, { kind: 'user' }>> = {}): TranscriptEntry =>
  ({ kind: 'user', id, text, ts: BASE, ...extra }) as TranscriptEntry

const tool = (id: number, patch: Partial<Extract<TranscriptEntry, { kind: 'tool' }>['call']> = {}): TranscriptEntry =>
  ({
    kind: 'tool',
    id,
    ts: BASE + 3000,
    call: {
      callId: `call-${String(id)}`,
      name: 'read',
      argsText: '{"path":"a.ts"}',
      resultText: '文件内容',
      status: 'done',
      startedAt: BASE + 1000,
      durationMs: 2000,
      ...patch,
    },
  }) as TranscriptEntry

function snapshotOf(entries: TranscriptEntry[]): HostSnapshot {
  return {
    entries,
    liveEntries: [],
    sessions: [],
    status: { cwd: 'D:/demo', sessionPath: 'D:/demo/demo.jsonl', sessionId: 'uuid-trace', turnState: 'idle' },
    surfaces: {},
  } as unknown as HostSnapshot
}

function channelOf(snapshot: HostSnapshot): HostChannel {
  return {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (() => Promise.reject(new Error('轨迹页不该 invoke'))) as unknown as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

/**
 * 工厂出口：把传进来的局部组件真的挂上（`statusDetail` 是本包提供的状态列），
 * 没有再落回 fallback。既有用例只钉 fallback，所以这一件一直没被执行。
 */
const renderFactorySlot = ((
  _name: string,
  input: unknown,
  options?: { slots?: Record<string, unknown>; fallback?: ReactNode },
): ReactNode => {
  const locals = options?.slots ?? {}
  const StatusDetail = locals['statusDetail'] as ComponentType<{ call: unknown }> | undefined
  const entry = (input as { entry?: { call?: unknown } } | undefined)?.entry
  if (StatusDetail === undefined || entry?.call === undefined) return options?.fallback ?? null
  return <StatusDetail call={entry.call} />
}) as never

function renderTrace(snapshot: HostSnapshot): ReturnType<typeof render> {
  return render(
    <RuntimeProvider channel={channelOf(snapshot)}>
      <TraceView renderFactorySlot={renderFactorySlot} />
    </RuntimeProvider>,
  )
}

const textOf = (element: Element | null): string => element?.textContent ?? ''

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  delete (globalThis as { dscNative?: unknown }).dscNative
})

describe('轨迹页工具卡的状态列（工厂局部组件）', () => {
  test('定稿只印裸耗时；跑动中带状态文案与耗时', () => {
    const { container } = renderTrace(snapshotOf([user(1, '看'), tool(2)]))
    const done = container.querySelector('[data-trace-step="2"] .status') as HTMLElement
    expect(done).not.toBeNull()
    expect(textOf(done)).toBe('2.0s')
    cleanup()

    const running = renderTrace(snapshotOf([user(1, '看'), tool(2, { status: 'running', durationMs: 4200 })]))
    const live = running.container.querySelector('[data-trace-step="2"] .status') as HTMLElement
    expect(live.querySelector('.tc-spin')).not.toBeNull()
    expect(textOf(live)).toContain('进行中')
    expect(textOf(live)).toContain('4.2s')
  })
})

describe('检查器的放大浮层', () => {
  test('点附件缩略图开浮层；× 单击就关（不把点击传给遮罩）', () => {
    const { container } = renderTrace(snapshotOf([user(1, '带图', { images: ['data:image/png;base64,AAAA'] })]))
    fireEvent.click(container.querySelector('.round-open') as HTMLElement)
    const inspector = container.querySelector('.trace-inspector') as HTMLElement
    const thumb = (inspector.querySelector('.attach-zoom') ??
      inspector.querySelector('img')?.closest('button')) as HTMLElement | null
    expect(thumb).not.toBeNull()
    fireEvent.click(thumb as HTMLElement)
    const lightbox = document.querySelector('[data-trace-lightbox]') as HTMLElement
    expect(lightbox).not.toBeNull()

    fireEvent.click(lightbox.querySelector('.lightbox-close') as HTMLElement)
    expect(document.querySelector('[data-trace-lightbox]')).toBeNull()
    // 检查器本身还开着：× 只关浮层。
    expect(container.querySelector('.trace-inspector')).not.toBeNull()
  })
})

describe('复制入参', () => {
  test('成功：回执写「已复制」', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text)
          return Promise.resolve()
        },
      },
    })
    const { container } = renderTrace(snapshotOf([user(1, '看'), tool(2)]))
    fireEvent.click(container.querySelector('[data-trace-step="2"]') as HTMLElement)
    fireEvent.click(container.querySelector('[data-trace-copy-args]') as HTMLElement)
    await waitFor(() => {
      expect(document.querySelector('.dsc-toasts')?.textContent).toContain(zh['toast.copied'])
    })
    expect(written).toEqual(['{"path":"a.ts"}'])
  })

  test('失败：回执写「复制失败」，不静默', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('剪贴板被拒')) },
    })
    const { container } = renderTrace(snapshotOf([user(1, '看'), tool(2)]))
    fireEvent.click(container.querySelector('[data-trace-step="2"]') as HTMLElement)
    fireEvent.click(container.querySelector('[data-trace-copy-args]') as HTMLElement)
    await waitFor(() => {
      expect(document.querySelector('.dsc-toasts')?.textContent).toContain(zh['toast.copyFailed'])
    })
  })
})
