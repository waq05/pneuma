/**
 * 渲染器入口（`ui-renderer/ui/ui.tsx`）的首帧与诊断段（ui 层，真渲染）。
 *
 * `start(api)` 是引导交来的入口：先显式取骨架，取不到就画诊断页（不能白屏），
 * 取到才建通道、装 early 批、画 App、打首帧并启动 application 批。这里用一个假
 * `UiRendererApi` 钉上面每一条分支，通道工厂换成记录用的假通道（不连 SSE）。
 *
 * @module dsc-ui-renderer/ui/ui.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { HostChannel } from '@dsc/ui-runtime'
import { start } from './ui.js'

type Api = Parameters<typeof start>[0]

/** 通道工厂的替身：`start` 里唯一需要真网络的那一处。 */
const runtimeMock = vi.hoisted(() => ({ channel: null as unknown }))

vi.mock('@dsc/ui-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dsc/ui-runtime')>()
  return { ...actual, createHostChannel: () => runtimeMock.channel }
})

interface Harness {
  api: Api
  container: HTMLElement
  channel: HostChannel
  bindRuntime: ReturnType<typeof vi.fn>
  loadPluginModule: ReturnType<typeof vi.fn>
  createBootSession: ReturnType<typeof vi.fn>
  startPluginHmr: ReturnType<typeof vi.fn>
  markFirstFrame: ReturnType<typeof vi.fn>
  startApplication: ReturnType<typeof vi.fn>
}

/** 假通道：偏好读成功即可，其它调用不应发生。 */
function fakeChannel(): HostChannel {
  return {
    getSnapshot: () => null,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(): Promise<T> => Promise.resolve({ panelWidths: {} } as T)) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

/**
 * 一份引导入口面。
 *
 * @param options.entries - 启动图条目（骨架那条 id 固定为 `layout`）
 * @param options.disabled - 启动图里的停用记录
 * @param options.bootError - 引导取启动图时记下的错误原文
 * @param options.load - 骨架产物的物化结果（默认给一个能渲染的 App）
 */
function harnessOf(
  options: {
    entries?: Array<{ id: string }>
    disabled?: string[]
    bootError?: string | null
    load?: () => Promise<unknown>
  } = {},
): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const channel = fakeChannel()
  runtimeMock.channel = channel
  const boot = {
    entries: options.entries ?? [],
    ...(options.disabled === undefined ? {} : { disabled: options.disabled }),
    host: { cwd: 'C:/repo', sessionPath: 'C:/repo/a.jsonl', sessionId: 'a' },
  } as unknown as Api['boot']
  const bindRuntime = vi.fn()
  const markFirstFrame = vi.fn()
  const startApplication = vi.fn()
  const session = { markFirstFrame, startApplication, services: {} } as unknown as Awaited<
    ReturnType<Api['createBootSession']>
  >
  const loadPluginModule = vi.fn(
    options.load ??
      (() =>
        Promise.resolve({
          App: () => <div data-testid="layout-app">骨架已装</div>,
        })),
  )
  const createBootSession = vi.fn(() => Promise.resolve(session))
  const startPluginHmr = vi.fn(() => null)
  const api = {
    container,
    boot,
    bootError: options.bootError ?? null,
    slots: {} as Api['slots'],
    cordis: {} as Api['cordis'],
    services: {} as Api['services'],
    servicesProvider: (({ children }: { children: ReactNode }) => <>{children}</>) as Api['servicesProvider'],
    allowedModules: [],
    bindRuntime,
    loadPluginModule,
    startPluginHmr,
    createBootSession,
  } as unknown as Api
  return {
    api,
    container,
    channel,
    bindRuntime,
    loadPluginModule,
    createBootSession,
    startPluginHmr,
    markFirstFrame,
    startApplication,
  }
}

/** 跑一次 `start` 并等 React 的首帧提交落地。 */
const runStart = (harness: Harness): Promise<void> =>
  act(async () => {
    await start(harness.api)
  })

const textOf = (container: HTMLElement): string => container.textContent ?? ''

beforeEach(() => {
  // jsdom 未必带 rAF；启动占位退场那双帧回调只需要能被执行。
  ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callback(0)
    return 0
  }
  ;(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = (): void => undefined
  localStorage.clear()
})

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-density')
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
  delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame
  localStorage.clear()
})

describe('骨架缺席的诊断页', () => {
  test('启动清单里没有 layout：说清是「没进启动清单」并给出缺的条目名', async () => {
    const harness = harnessOf()
    await runStart(harness)

    const text = textOf(harness.container)
    expect(text).toContain('没有进启动清单')
    expect(text).toContain('启动图里没有 layout 这一条')
    expect(harness.container.querySelector('[data-testid="layout-app"]')).toBeNull()
  })

  test('layout 被停用：诊断页写「已停用」，细节用引导留下的错误原文', async () => {
    const harness = harnessOf({ disabled: ['layout'], bootError: '读取启动图失败：404' })
    await runStart(harness)

    const text = textOf(harness.container)
    expect(text).toContain('已停用')
    expect(text).toContain('读取启动图失败：404')
  })

  test('骨架产物加载失败：诊断页写「加载失败」并保留错误原文', async () => {
    const harness = harnessOf({
      entries: [{ id: 'layout' }],
      load: () => Promise.reject(new Error('chunk 404')),
    })
    await runStart(harness)

    const text = textOf(harness.container)
    expect(text).toContain('加载失败')
    expect(text).toContain('chunk 404')
  })

  test('产物形状不对（没有 App）：按加载失败处理并点名缺的是 App', async () => {
    const harness = harnessOf({
      entries: [{ id: 'layout' }],
      load: () => Promise.resolve({}),
    })
    await runStart(harness)

    const text = textOf(harness.container)
    expect(text).toContain('加载失败')
    expect(text).toContain('产物里没有 App')
  })
})

describe('骨架就位后的首帧', () => {
  test('建通道并回填、装配会话、画 App，随后打首帧并启动第二批', async () => {
    const harness = harnessOf({ entries: [{ id: 'layout' }] })
    await runStart(harness)

    expect(harness.container.querySelector('[data-testid="layout-app"]')?.textContent).toBe('骨架已装')
    expect(harness.bindRuntime).toHaveBeenCalledTimes(1)
    expect(harness.bindRuntime).toHaveBeenCalledWith(harness.channel)
    expect(harness.createBootSession).toHaveBeenCalledWith(harness.api.boot, {
      host: harness.api.boot.host,
      runtime: harness.channel,
    })
    expect(harness.startPluginHmr).toHaveBeenCalledWith({
      channel: harness.channel,
      session: expect.anything(),
    })
    expect(harness.markFirstFrame).toHaveBeenCalledTimes(1)
    expect(harness.startApplication).toHaveBeenCalledTimes(1)
  })

  test('装载会话建不起来也不白屏：App 照样画，诊断信息交给骨架', async () => {
    const harness = harnessOf({ entries: [{ id: 'layout' }] })
    harness.createBootSession.mockRejectedValueOnce(new Error('cordis 起不来'))
    await runStart(harness)

    expect(harness.container.querySelector('[data-testid="layout-app"]')).not.toBeNull()
    expect(harness.startPluginHmr).not.toHaveBeenCalled()
    expect(harness.markFirstFrame).not.toHaveBeenCalled()
    expect(harness.startApplication).not.toHaveBeenCalled()
  })
})
