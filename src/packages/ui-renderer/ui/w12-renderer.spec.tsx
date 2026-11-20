/**
 * 渲染器入口的补盲（`packages/ui-renderer/ui/ui.tsx`）：
 * - `requestAppearance` 落到 DOM 的那段（字号 px / 旧倍率 / 字体 / 主题 / 密度）与骨架未就绪时的空操作；
 * - 启动占位的退场（两帧后加 class、240ms 后摘掉）；
 * - `getUiPrefs` 失败只告警、不挡首帧。
 *
 * 假 `UiRendererApi` 与假通道的写法照同包 `ui.spec.tsx`（通道工厂换成记录用的假通道，不连 SSE）。
 *
 * @module dsc/packages/ui-renderer/ui/w12-renderer.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { requestAppearance } from '@dsc/ui'
import type { HostChannel } from '@dsc/ui-runtime'
import { start } from './ui.js'

type Api = Parameters<typeof start>[0]

const runtimeMock = vi.hoisted(() => ({ channel: null as unknown }))

vi.mock('@dsc/ui-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dsc/ui-runtime')>()
  return { ...actual, createHostChannel: () => runtimeMock.channel }
})

/** 假通道：偏好可配成成功 / 失败。 */
function fakeChannel(options: { prefsReject?: boolean } = {}): HostChannel {
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
      if (method === 'getUiPrefs' && options.prefsReject === true) {
        return Promise.reject(new Error('偏好读不出来')) as Promise<T>
      }
      return Promise.resolve({ panelWidths: {} } as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

interface Harness {
  api: Api
  container: HTMLElement
  channel: HostChannel
}

/** 一份能跑通的假入口面。 */
function harnessOf(channel: HostChannel = fakeChannel()): Harness {
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
  return { api, container, channel }
}

const runStart = (harness: Harness): Promise<void> =>
  act(async () => {
    await start(harness.api)
  })

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
  localStorage.clear()
})

describe('requestAppearance：插件改外观，壳落地', () => {
  test('骨架还没装上来时是空操作（不改 DOM）', () => {
    const before = document.documentElement.getAttribute('data-theme')
    requestAppearance({ themeMode: 'dark' })
    expect(document.documentElement.getAttribute('data-theme')).toBe(before)
  })

  test('字号按 px 归一、旧倍率折成 px、字体列表归一后写进 CSS 变量', async () => {
    const harness = harnessOf()
    await runStart(harness)

    // px 真源：30 被夹到上限，--dsc-font-scale 跟着它变。
    requestAppearance({ textSizePx: 30 })
    const scale = document.documentElement.style.getPropertyValue('--dsc-font-scale')
    expect(Number(scale)).toBeGreaterThan(1)
    expect(Number(scale)).toBeLessThanOrEqual(22 / 14)

    // 旧插件只发倍率：折成 px 再落地，值不会变成 NaN。
    requestAppearance({ fontSize: 1.1 })
    expect(Number(document.documentElement.style.getPropertyValue('--dsc-font-scale'))).toBeGreaterThan(1)

    // 字体：非空写变量；空串把变量删掉（不能留空值）。
    const textFont = 'Test Sans'
    requestAppearance({ textFontFamily: textFont })
    expect(document.documentElement.style.getPropertyValue('--dsc-font-text')).toContain(textFont)
    requestAppearance({ textFontFamily: '' })
    expect(document.documentElement.style.getPropertyValue('--dsc-font-text')).toBe('')

    // 主题与密度直接落 data 属性。
    requestAppearance({ themeMode: 'light', density: 'compact' })
    expect(document.documentElement.dataset['theme']).toBe('light')
    expect(document.documentElement.dataset['density']).toBe('compact')
  })

  test('patch 里没给的项保持上一次的值（不被抹成默认）', async () => {
    const harness = harnessOf()
    await runStart(harness)
    requestAppearance({ themeMode: 'claude' })
    requestAppearance({ textSizePx: 16 })
    expect(document.documentElement.dataset['theme']).toBe('claude')
  })
})

describe('启动占位退场', () => {
  test('两帧后加 done class，240ms 后把占位摘掉', async () => {
    const splash = document.createElement('div')
    splash.id = 'boot-splash'
    document.body.append(splash)
    const addClass = vi.spyOn(splash.classList, 'add')
    const harness = harnessOf()
    await runStart(harness)
    expect(addClass).toHaveBeenCalledWith('boot-splash--done')
    await vi.waitFor(() => {
      expect(splash.isConnected).toBe(false)
    })
  })

  test('没有占位元素时也不报错', async () => {
    const harness = harnessOf()
    await expect(runStart(harness)).resolves.toBeUndefined()
    expect(harness.container.querySelector('[data-testid="layout-app"]')).not.toBeNull()
  })
})

describe('偏好读取失败', () => {
  test('只告警，首帧照画', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const harness = harnessOf(fakeChannel({ prefsReject: true }))
    await runStart(harness)
    expect(harness.container.querySelector('[data-testid="layout-app"]')).not.toBeNull()
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('读界面偏好失败'), expect.any(Error))
    })
    warn.mockRestore()
  })
})
