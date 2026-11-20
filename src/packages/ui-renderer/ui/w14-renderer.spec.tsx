/**
 * `ui-renderer` 的补盲：面板几何「首帧没等到偏好」那条路。
 *
 * 缺口逐条：
 *   - `ui.tsx:112`：`within(prefs, 1500)` 超时那一支（`resolve(null)`，不把首帧挂在宿主上）；
 *   - `ui.tsx:344-350`：超时后偏好迟到（`prefs.then`）——补灌几何并**这时才**注册落盘出口；
 *   - `ui.tsx:337-338`：落盘出口调用 `setUiPrefs` 失败时只告警（不弹错、不打断拖动）。
 *
 * 假通道 / 假 `UiRendererApi` 的写法照同包 `w12-renderer.spec.tsx`，只是 `getUiPrefs`
 * 换成「挂住 → 超时 → 迟到」三拍。
 *
 * @module dsc/packages/ui-renderer/ui/w14-renderer
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { PANEL_KEYS, writeStoredPx } from '@dsc/ui-primitives'
import type { HostChannel } from '@dsc/ui-runtime'
import { start } from './ui.js'

type Api = Parameters<typeof start>[0]

const runtimeMock = vi.hoisted(() => ({ channel: null as unknown }))

vi.mock('@dsc/ui-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dsc/ui-runtime')>()
  return { ...actual, createHostChannel: () => runtimeMock.channel }
})

/** 假通道：`getUiPrefs` 由用例给一个可控 promise，`setUiPrefs` 一律失败。 */
function fakeChannel(prefs: Promise<unknown>): HostChannel {
  return {
    getSnapshot: () => null,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string): Promise<T> => {
      if (method === 'getUiPrefs') return prefs as Promise<T>
      if (method === 'setUiPrefs') return Promise.reject(new Error('宿主写不进去')) as Promise<T>
      return Promise.resolve({} as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

interface Harness {
  api: Api
  container: HTMLElement
}

/** 一份能跑通的假入口面（骨架装载成功，第一批为空）。 */
function harnessOf(channel: HostChannel): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  runtimeMock.channel = channel
  const boot = {
    entries: [{ id: 'layout' }],
    host: { cwd: 'C:/repo', sessionPath: 'C:/repo/a.jsonl', sessionId: 'a' },
  } as unknown as Api['boot']
  const session = {
    markFirstFrame: vi.fn(),
    startApplication: vi.fn(),
    services: {},
  } as unknown as Awaited<ReturnType<Api['createBootSession']>>
  const api = {
    container,
    boot,
    bootError: null,
    slots: {} as Api['slots'],
    cordis: {} as Api['cordis'],
    services: {} as Api['services'],
    servicesProvider: (({ children }: { children: ReactNode }) => <>{children}</>) as Api['servicesProvider'],
    allowedModules: [],
    bindRuntime: vi.fn(),
    loadPluginModule: vi.fn(() => Promise.resolve({ App: () => <div data-testid="layout-app">骨架已装</div> })),
    startPluginHmr: vi.fn(() => null),
    createBootSession: vi.fn(() => Promise.resolve(session)),
  } as unknown as Api
  return { api, container }
}

beforeEach(() => {
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('偏好迟到', () => {
  test('1500ms 内没等到：首帧照画；偏好迟到后补灌几何并注册落盘出口（写失败只告警）', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let resolvePrefs: (value: unknown) => void = () => undefined
    const prefs = new Promise<unknown>((resolve) => {
      resolvePrefs = resolve
    })
    const harness = harnessOf(fakeChannel(prefs))

    let running: Promise<void> = Promise.resolve()
    await act(async () => {
      running = start(harness.api)
      // 让 `within` 里的 1500ms 期限走到头（resolve(null)），首帧不等宿主。
      await vi.advanceTimersByTimeAsync(1_600)
    })
    await act(async () => {
      await running
    })
    expect(harness.container.querySelector('[data-testid="layout-app"]')).not.toBeNull()

    // 偏好迟到：补灌几何 + 这时才注册落盘出口。
    await act(async () => {
      resolvePrefs({ panelWidths: { [PANEL_KEYS.sidebarWidth]: 321 } })
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      writeStoredPx(PANEL_KEYS.sidebarWidth, 322)
      await Promise.resolve()
      await Promise.resolve()
    })
    // 落盘出口真的接上了：写一次几何就发一次 setUiPrefs，失败只告警。
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('面板几何没写成'), expect.any(Error))
    warn.mockRestore()
  })
})
