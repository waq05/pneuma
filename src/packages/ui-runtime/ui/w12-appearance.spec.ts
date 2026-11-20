/**
 * 外观落地的补盲（`packages/ui-runtime/ui/appearance.ts`）：系统偏好监听、原生桥上报、镜像写失败。
 *
 * 这些分支都挂在模块级状态上（`media` 在 import 时求值），所以用 `vi.resetModules()` +
 * 动态 import 每个用例拿一份干净的模块；`readCssColor` 换成可控返回值（它是另一个模块的
 * 令牌读取，jsdom 没有真实样式计算），被测的 `applyAppearance` / `pushNativeChrome` 本身真跑。
 *
 * @module dsc/packages/ui-runtime/ui/w12-appearance.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/** 原生桥的两个上报动作记在这里。 */
const chromeMock = vi.hoisted(() => ({ color: '#112233 #445566' as string | null }))

vi.mock('@dsc/ui-primitives', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, readCssColor: () => chromeMock.color }
})

interface FakeMediaQueryList {
  matches: boolean
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

let mql: FakeMediaQueryList
let nativeCall: ReturnType<typeof vi.fn>

/** 拿一份干净的 appearance 模块。 */
async function load(): Promise<typeof import('./appearance.js')> {
  return await import('./appearance.js')
}

beforeEach(() => {
  vi.resetModules()
  mql = {
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  vi.stubGlobal('matchMedia', () => mql)
  nativeCall = vi.fn(async () => undefined)
  ;(globalThis as unknown as { dscNative?: unknown }).dscNative = { call: nativeCall, version: 1 }
  delete document.documentElement.dataset['theme']
  chromeMock.color = '#112233 #445566'
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (globalThis as unknown as { dscNative?: unknown }).dscNative
})

describe('跟随系统：挂 / 摘监听与系统翻面', () => {
  test('选 system 挂上监听，改回具体主题就摘掉', async () => {
    const { applyAppearance, DEFAULT_APPEARANCE } = await load()
    applyAppearance({ ...DEFAULT_APPEARANCE, themeMode: 'system' })
    expect(mql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    // 跟随系统时解析成 light（matchMedia.matches = true），而不是把 'system' 写进 data-theme。
    expect(document.documentElement.dataset['theme']).toBe('light')

    const watcher = mql.addEventListener.mock.calls[0]![1] as () => void
    mql.matches = false
    watcher()
    expect(document.documentElement.dataset['theme']).toBe('dark')

    applyAppearance({ ...DEFAULT_APPEARANCE, themeMode: 'claude' })
    expect(mql.removeEventListener).toHaveBeenCalledWith('change', watcher)
    expect(document.documentElement.dataset['theme']).toBe('claude')
  })

  test('已经不是 system 时再调一次：不重复摘监听', async () => {
    const { applyAppearance, DEFAULT_APPEARANCE } = await load()
    applyAppearance({ ...DEFAULT_APPEARANCE, themeMode: 'dark' })
    expect(mql.removeEventListener).not.toHaveBeenCalled()
    expect(mql.addEventListener).not.toHaveBeenCalled()
  })
})

describe('原生桥上报：主题来源与窗口控件区颜色', () => {
  test('桥在：报 setThemeSource，颜色变了才报 setWindowChrome', async () => {
    const { applyAppearance, DEFAULT_APPEARANCE } = await load()
    applyAppearance({ ...DEFAULT_APPEARANCE, themeMode: 'system' })
    await Promise.resolve()
    expect(nativeCall).toHaveBeenCalledWith('setThemeSource', ['system'])
    expect(nativeCall).toHaveBeenCalledWith('setWindowChrome', ['#112233', '#445566'])

    nativeCall.mockClear()
    applyAppearance({ ...DEFAULT_APPEARANCE, themeMode: 'light' })
    await Promise.resolve()
    expect(nativeCall).toHaveBeenCalledWith('setThemeSource', ['light'])
    // 颜色没变：第二条不重复报（避免每次上色都惊动主进程）。
    expect(nativeCall).not.toHaveBeenCalledWith('setWindowChrome', expect.anything())
  })

  test('读不出颜色令牌：只报主题来源，不报窗口颜色', async () => {
    chromeMock.color = null
    const { applyAppearance, DEFAULT_APPEARANCE } = await load()
    applyAppearance({ ...DEFAULT_APPEARANCE, themeMode: 'dark' })
    await Promise.resolve()
    expect(nativeCall).toHaveBeenCalledWith('setThemeSource', ['dark'])
    expect(nativeCall).not.toHaveBeenCalledWith('setWindowChrome', expect.anything())
  })

  test('桥不在：整段空操作，不抛', async () => {
    delete (globalThis as unknown as { dscNative?: unknown }).dscNative
    const { applyAppearance, DEFAULT_APPEARANCE } = await load()
    expect(() => {
      applyAppearance({ ...DEFAULT_APPEARANCE, themeMode: 'light' })
    }).not.toThrow()
    expect(document.documentElement.dataset['theme']).toBe('light')
  })
})

describe('镜像写入', () => {
  test('localStorage 写失败：只警告，不影响上色', async () => {
    const { DEFAULT_APPEARANCE, saveCachedAppearance } = await load()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('配额满了')
    })
    expect(() => {
      saveCachedAppearance(DEFAULT_APPEARANCE)
    }).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('外观缓存写入失败'), expect.any(Error))
  })
})
