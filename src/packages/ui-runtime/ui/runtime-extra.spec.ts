/**
 * @dsc/ui-runtime 的补缺口测试：宿主通道（SSE + invoke）、外观落地、页/视图信号、今日用量。
 *
 * 既有两处只管「归一化认 claude」与「六个模块文件都在」；本文件补运行期行为：
 *
 *   - `createHostChannel`：hello/frame/plugins/ask 四条事件、订阅容错、invoke 的成功/401/
 *     HTTP 错误/ok=false/超时/外部取消、帧号跳号重开流、onerror 区分宿主报错与连接终态；
 *   - `appearance`：字号 px 归一与旧倍率换算、字体列表归一、applyAppearance 写 DOM、
 *     localStorage 镜像与地址上 `theme=` 的优先级；
 *   - `page-state` / `thread-view`：切页与切脸的通知去重、openTrace 的一次性聚焦；
 *   - `useTodayUsage`：末位日合计、空列表、刷新键变化。
 *
 * jsdom 没有 EventSource：每个用例前把假类挂到 global，emit 只喂给当前实例；fetch 同样打桩。
 *
 * @module @dsc/ui-runtime/ui/runtime-extra.spec
 */
import { createElement, type ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fontScaleFromTextSizePx, normalizeFontList, normalizeTextSizePx, textSizePxFromLegacy } from '@dsc/ui-core'
import { HOST_PROTOCOL_VERSION } from '../../../core/dock-browser.js'
import {
  DEFAULT_APPEARANCE,
  applyAppearance,
  appearanceFromPrefs,
  loadCachedAppearance,
  saveCachedAppearance,
} from './appearance.js'
import { HostInvokeAbortedError, createHostChannel, type HostChannel } from './host-channel.js'
import { RuntimeProvider } from './runtime-context.js'
import { setShellPage, shellPage, subscribePage } from './page-state.js'
import {
  clearTraceFocus,
  openTrace,
  setThreadView,
  shellThreadView,
  subscribeThreadView,
  traceFocusStep,
} from './thread-view.js'
import { useTodayUsage } from './usage-today.js'

/** jsdom 不带 EventSource：这个假类只做 host-channel 用到的那几件事。 */
class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []

  readonly url: string
  readyState = FakeEventSource.CONNECTING
  onopen: (() => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closed = false
  private readonly listeners = new Map<string, Array<(event: Event) => void>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  close(): void {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }

  /** 喂一条服务端事件（hello/frame/plugins/ask）。 */
  emit(type: string, data: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ data } as MessageEvent<string>)
    }
  }

  /** 模拟一次连接层错误；带 data 时是宿主自己发的 `event: error`。 */
  fail(data?: string): void {
    this.readyState = FakeEventSource.CLOSED
    this.onerror?.(data === undefined ? ({} as Event) : ({ data } as MessageEvent<string>))
  }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  localStorage.clear()
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('宿主通道：四条事件与订阅容错', () => {
  test('hello / frame / plugins / ask 各自更新状态，坏帧只丢一条', () => {
    const channel = createHostChannel()
    const changes: number[] = []
    const off = channel.subscribe(() => changes.push(changes.length))
    const bad = channel.subscribe(() => {
      throw new Error('订阅者自己炸了')
    })
    const es = FakeEventSource.instances.at(-1)!

    es.emit('hello', JSON.stringify({ protocolVersion: HOST_PROTOCOL_VERSION, methods: ['x'], host: { name: 'h', version: '1' } }))
    expect(channel.getStatus()).toBe('open')
    expect(channel.getHello()?.host.name).toBe('h')

    es.emit('frame', JSON.stringify({ type: 'snapshot', seq: 1, entries: [{ id: 1, text: 'a' }], liveEntries: [] }))
    expect(channel.getSnapshot()?.entries).toHaveLength(1)
    expect(changes.length).toBeGreaterThan(0)

    const frames: string[] = []
    const offPlugins = channel.onPlugins((frame) => frames.push(frame.rev))
    es.emit('plugins', JSON.stringify({ rev: 'r1', changed: ['a'], removed: [], graph: {} }))
    expect(channel.getPluginsFrame()?.rev).toBe('r1')
    expect(frames).toEqual(['r1'])

    const chunks: Array<{ id: string; delta: string }> = []
    const offAsk = channel.onAsk((chunk) => chunks.push({ id: chunk.id, delta: chunk.delta }))
    es.emit('ask', JSON.stringify({ id: 'a', delta: '第一段' }))
    es.emit('ask', JSON.stringify({ id: 7, delta: '坏形状' }))
    es.emit('ask', '不是 JSON')
    expect(chunks).toEqual([{ id: 'a', delta: '第一段' }])

    // 一个 plugins 订阅者抛错不该挡住后面的订阅者。
    const thrower = channel.onPlugins(() => {
      throw new Error('这一条不要了')
    })
    const seen: string[] = []
    const counter = channel.onPlugins((frame) => seen.push(frame.rev))
    es.emit('plugins', JSON.stringify({ rev: 'r2', changed: [], removed: [], graph: {} }))
    expect(channel.getPluginsFrame()?.rev).toBe('r2')
    expect(seen).toEqual(['r2'])

    off()
    bad()
    offPlugins()
    offAsk()
    thrower()
    counter()
    channel.close()
    expect(channel.getStatus()).toBe('closed')
  })

  test('invoke：成功、401 关通道、HTTP 失败、ok=false、超时与外部取消', async () => {
    const channel = createHostChannel()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, value: { a: 1 } }) })
    await expect(channel.invoke('usageStats')).resolves.toEqual({ a: 1 })

    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: '凭据过期' }) })
    await expect(channel.invoke('usageStats')).rejects.toThrow('凭据过期')
    expect(channel.getStatus()).toBe('closed')
    expect(channel.getHostError()).toBe('凭据过期')

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => null })
    await expect(channel.invoke('usageStats')).rejects.toThrow('HTTP 500')

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: false }) })
    await expect(channel.invoke('usageStats')).rejects.toThrow('调用失败')

    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        }),
    )
    const timeout = channel.invoke('usageStats', [], { timeoutMs: 5 })
    await expect(timeout).rejects.toBeInstanceOf(HostInvokeAbortedError)
    await expect(timeout).rejects.toMatchObject({ reason: 'timeout' })
    await expect(timeout).rejects.toThrow(/超时（5 毫秒）/)

    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        }),
    )
    const gate = new AbortController()
    const aborted = channel.invoke('usageStats', [], { signal: gate.signal })
    gate.abort()
    await expect(aborted).rejects.toMatchObject({ reason: 'aborted' })

    channel.close()
  })

  test('帧号跳号重开流；宿主报错与连接终态分开报', () => {
    const channel = createHostChannel()
    const first = FakeEventSource.instances.at(-1)!
    first.emit('frame', JSON.stringify({ type: 'snapshot', seq: 1, entries: [], liveEntries: [] }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    first.emit('frame', JSON.stringify({ type: 'delta', seq: 3, full: false, meta: {} }))
    expect(warn).toHaveBeenCalled()
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(channel.getStatus()).toBe('connecting')
    warn.mockRestore()

    const second = FakeEventSource.instances.at(-1)!
    second.emit('hello', JSON.stringify({ protocolVersion: HOST_PROTOCOL_VERSION, methods: [], host: { name: 'h', version: '1' } }))
    expect(channel.getStatus()).toBe('open')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    second.fail(JSON.stringify({ error: '造帧失败' }))
    expect(channel.getHostError()).toBe('造帧失败')
    expect(channel.getStatus()).toBe('open')

    second.fail()
    expect(channel.getStatus()).toBe('closed')
    errorSpy.mockRestore()

    const count = FakeEventSource.instances.length
    channel.reconnect()
    expect(FakeEventSource.instances.length).toBe(count + 1)
    channel.close()
    const afterClose = FakeEventSource.instances.length
    channel.reconnect()
    expect(FakeEventSource.instances.length).toBe(afterClose)
  })
})

describe('外观：归一化、DOM 落地与 localStorage 镜像', () => {
  test('字号归一化：px 夹回 10–22，旧倍率换算成 px，其余项按白名单回落', () => {
    // 真源是 px（contract/fonts.ts 的 normalizeTextSizePx）：坏值/越界一律夹进 10–22。
    expect(normalizeTextSizePx(14)).toBe(14)
    expect(normalizeTextSizePx(9)).toBe(10)
    expect(normalizeTextSizePx(30)).toBe(22)
    expect(normalizeTextSizePx(12.6)).toBe(13)
    expect(normalizeTextSizePx(Number.NaN)).toBe(14)
    expect(normalizeTextSizePx('lg')).toBe(14)
    // 旧存档只存倍率或三档字符串：读档时按基准 14px 换算（textSizePxFromLegacy）。
    expect(textSizePxFromLegacy('lg')).toBe(16)
    expect(textSizePxFromLegacy('md')).toBe(14)
    expect(textSizePxFromLegacy('sm')).toBe(13)
    expect(textSizePxFromLegacy('nope')).toBeNull()
    // 旧倍率先夹到 0.85–1.35 再乘 14px：1.35 × 14 = 18.9 → 19；0.85 × 14 = 11.9 → 12。
    expect(textSizePxFromLegacy(9)).toBe(19)
    expect(textSizePxFromLegacy(0.1)).toBe(12)
    // `--dsc-font-scale` 是由 px 派生的倍率，保留 4 位小数（12px 不会画成 11.96px）。
    expect(fontScaleFromTextSizePx(14)).toBe(1)
    expect(fontScaleFromTextSizePx(12)).toBe(0.8571)
    // 字体列表归一：空串 = 用内置栈；含空格的族名补引号；分号/花括号这类会弄坏 CSS 的字符剔掉。
    expect(normalizeFontList('')).toBe('')
    expect(normalizeFontList('Noto Sans SC, monospace')).toBe('"Noto Sans SC", monospace')
    expect(normalizeFontList('nope;font, monospace')).toBe('nopefont, monospace')

    expect(
      appearanceFromPrefs({
        themeMode: 'light',
        // 旧存档里的三档字符串：类型上已收窄成数字，运行期归一化仍认它。
        fontSize: 'md' as unknown as number,
        density: 'roomy',
        collapseTiming: 'next-input',
        foldedReplies: 'final',
      }),
    ).toEqual({
      themeMode: 'light',
      textSizePx: 14,
      textFontFamily: '',
      codeFontFamily: '',
      density: 'roomy',
      collapseTiming: 'next-input',
      foldedReplies: 'final',
    })
    // textSizePx 是真源：同时给了派生倍率时以 px 为准（appearance.ts:129-134）。
    expect(appearanceFromPrefs({ textSizePx: 18, fontSize: 0.9 }).textSizePx).toBe(18)
    // 注意：DEFAULT_APPEARANCE.foldedReplies 是 'final'，而 normalizeFoldedReplies 的兜底是
    // 'all'（appearance.ts:84 与 :117-119）——目前两处口径不一致，这里按运行期实际值钉住。
    expect(appearanceFromPrefs(undefined)).toEqual({ ...DEFAULT_APPEARANCE, foldedReplies: 'all' })
    expect(appearanceFromPrefs({ density: '紧凑' as never, collapseTiming: 'x' as never, foldedReplies: 'y' as never })).toMatchObject({
      density: 'standard',
      collapseTiming: 'completion',
      foldedReplies: 'all',
    })
  })

  test('applyAppearance 写 data-theme / data-density / 字号倍率；跟随系统在无 matchMedia 时落到 dark', () => {
    const root = document.documentElement
    applyAppearance({ ...DEFAULT_APPEARANCE, themeMode: 'light' })
    expect(root.dataset.theme).toBe('light')
    // 默认正文 14px，派生出的倍率就是 1。
    expect(root.style.getPropertyValue('--dsc-font-scale')).toBe('1')

    applyAppearance({ ...DEFAULT_APPEARANCE, themeMode: 'system', density: 'roomy', textSizePx: 21 })
    expect(root.dataset.theme).toBe('dark')
    expect(root.dataset.density).toBe('roomy')
    // 21px ÷ 基准 14px = 1.5：界面里那批 `calc(Npx * var(--dsc-font-scale))` 跟着 px 缩放。
    expect(root.style.getPropertyValue('--dsc-font-scale')).toBe('1.5')

    // 字体列表写进 CSS 变量；空串必须删变量（写空串会让整条 font-family 非法，见 appearance.ts:200-214）。
    applyAppearance({ ...DEFAULT_APPEARANCE, textFontFamily: '"Noto Sans SC", sans-serif' })
    expect(root.style.getPropertyValue('--dsc-font-text')).toBe('"Noto Sans SC", sans-serif')
    applyAppearance({ ...DEFAULT_APPEARANCE })
    expect(root.style.getPropertyValue('--dsc-font-text')).toBe('')

    applyAppearance({ ...DEFAULT_APPEARANCE, themeMode: 'claude' })
    expect(root.dataset.theme).toBe('claude')
  })

  test('localStorage 镜像往返；地址上的 theme 压过镜像；坏镜像回落默认', () => {
    const cached = { ...DEFAULT_APPEARANCE, themeMode: 'dark' as const, density: 'compact' as const }
    saveCachedAppearance(cached)
    expect(loadCachedAppearance()).toEqual(cached)

    window.history.replaceState({}, '', '/?theme=light')
    expect(loadCachedAppearance().themeMode).toBe('light')

    window.history.replaceState({}, '', '/')
    localStorage.setItem('dsc.appearance', '{不是 JSON')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(loadCachedAppearance()).toEqual(DEFAULT_APPEARANCE)
    warn.mockRestore()
  })
})

describe('页与视图信号：通知去重与一次性聚焦', () => {
  test('切页：同值不通知，退订后不再收到', () => {
    const changes: Array<string | null> = []
    const off = subscribePage(() => changes.push(shellPage()))
    setShellPage('plugins')
    setShellPage('plugins')
    setShellPage(null)
    expect(changes).toEqual(['plugins', null])
    off()
    setShellPage('skills')
    expect(changes).toEqual(['plugins', null])
    setShellPage(null)
  })

  test('thread-view：切脸、openTrace 带聚焦、clear 只生效一次', () => {
    const changes: string[] = []
    const off = subscribeThreadView(() => changes.push(`${shellThreadView()}:${String(traceFocusStep())}`))
    setThreadView('trace')
    setThreadView('trace')
    openTrace(7)
    openTrace(7)
    expect(shellThreadView()).toBe('trace')
    expect(traceFocusStep()).toBe(7)
    clearTraceFocus()
    expect(traceFocusStep()).toBeNull()
    clearTraceFocus()
    expect(changes).toEqual(['trace:null', 'trace:7', 'trace:null'])
    off()
    setThreadView('chat')
    expect(shellThreadView()).toBe('chat')
  })
})

describe('今日用量：末位日合计与刷新', () => {
  /** 只实现 invoke 的通道桩。 */
  function usageChannel(days: Array<{ inputTokens: number; outputTokens: number; costCny?: number | null }>): HostChannel {
    return {
      invoke: vi.fn(async () => ({ days })),
    } as unknown as HostChannel
  }

  function wrapper(channel: HostChannel) {
    return ({ children }: { children: ReactNode }) => createElement(RuntimeProvider, { channel, children })
  }

  test('取 days 末位；空列表给 0 与 null', async () => {
    const channel = usageChannel([
      { inputTokens: 5, outputTokens: 1, costCny: 0 },
      { inputTokens: 10, outputTokens: 5, costCny: 0.23 },
    ])
    const { result } = renderHook(() => useTodayUsage(), { wrapper: wrapper(channel) })
    await waitFor(() => expect(result.current).toEqual({ tokens: 15, cost: 0.23 }))

    const empty = usageChannel([])
    const second = renderHook(() => useTodayUsage(), { wrapper: wrapper(empty) })
    await waitFor(() => expect(second.result.current).toEqual({ tokens: 0, cost: null }))
  })
})
