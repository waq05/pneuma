/**
 * 宿主通道（`host-channel.ts`）的坏帧与调用失败补测（ui 层）。
 *
 * 既有渲染批只测「帧好、调用成功」的主路径；本文件用假 EventSource 把四条**坏输入**分支
 * 与 invoke 的兜底重抛补齐：
 *
 *  - hello / frame / plugins 三帧 JSON 坏掉：只打 console.error，状态与快照不变（宁可少一帧，
 *    也不画半对不对的界面）；
 *  - 宿主 `event: error` 的 data 不是 JSON：hostError 收原文（不当断线处理）；
 *  - `es.onopen`：状态转 open（只认当前这条流）；
 *  - invoke 的 fetch 非中断失败（网络层错误）：原样重抛，不包装成 HostInvokeAbortedError。
 *
 * @module dsc-ui-runtime/ui/w13-host-channel.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createHostChannel, HostInvokeAbortedError } from './host-channel.js'

/** 假 EventSource：登记监听器，由用例手动 emit。 */
class FakeEventSource {
  static readonly CLOSED = 2
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static instances: FakeEventSource[] = []

  readonly url: string
  readyState = FakeEventSource.CONNECTING
  closed = false
  onopen: (() => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private readonly listeners = new Map<string, ((event: Event) => void)[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, callback: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(callback)
    this.listeners.set(type, list)
  }

  close(): void {
    this.closed = true
  }

  /** 推一帧（模拟宿主发来的 SSE 帧）。 */
  emit(type: string, data: string): void {
    const event = { data } as unknown as Event
    for (const callback of this.listeners.get(type) ?? []) callback(event)
  }
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 建通道并取当前那条假流。 */
function open(): { channel: ReturnType<typeof createHostChannel>; source: FakeEventSource } {
  const channel = createHostChannel()
  const source = FakeEventSource.instances[0] as FakeEventSource
  return { channel, source }
}

describe('坏帧：只记日志，不改状态与快照', () => {
  test('hello 帧不是 JSON：状态留在 connecting，快照仍 null', () => {
    const { channel, source } = open()
    source.emit('hello', '{ 不是 json')
    expect(channel.getHello()).toBeNull()
    expect(channel.getStatus()).toBe('connecting')
    expect(errorSpy).toHaveBeenCalledWith('[ui-shell] 握手帧认不出', expect.anything())
    channel.close()
  })

  test('frame 帧不是 JSON：快照仍 null，状态不转 open', () => {
    const { channel, source } = open()
    source.emit('frame', 'oops')
    expect(channel.getSnapshot()).toBeNull()
    expect(channel.getStatus()).toBe('connecting')
    expect(errorSpy).toHaveBeenCalledWith('[ui-shell] 帧认不出', expect.anything())
    channel.close()
  })

  test('plugins 热更帧不是 JSON：启动图仍 null，订阅者不被叫醒', () => {
    const { channel, source } = open()
    const listener = vi.fn()
    channel.onPlugins(listener)
    source.emit('plugins', 'not-json')
    expect(channel.getPluginsFrame()).toBeNull()
    expect(listener).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('[ui-shell] 启动图热更帧认不出', expect.anything())
    channel.close()
  })
})

describe('连接状态', () => {
  test('onopen：状态转 open；换过流之后旧实例的 onopen 不再回写', () => {
    const { channel, source } = open()
    source.onopen?.()
    expect(channel.getStatus()).toBe('open')

    channel.reconnect()
    // 旧实例的 onopen 迟到：source 已换，状态不受影响。
    const next = FakeEventSource.instances[1] as FakeEventSource
    source.onopen?.()
    expect(next).not.toBe(source)
    expect(channel.getStatus()).toBe('connecting')
    next.onopen?.()
    expect(channel.getStatus()).toBe('open')
    channel.close()
  })

  test('宿主 error 事件的 data 不是 JSON：hostError 收原文，不当断线', () => {
    const { channel, source } = open()
    source.onerror?.({ data: '造帧失败：内存不够' } as unknown as Event)
    expect(channel.getHostError()).toBe('造帧失败：内存不够')
    expect(errorSpy).toHaveBeenCalledWith('[ui-shell] 宿主报错', '造帧失败：内存不够')
    // 有 data 的 error 不入断线分支：状态仍是 connecting（没被写成 closed）。
    expect(channel.getStatus()).toBe('connecting')
    channel.close()
  })
})

describe('invoke：非中断的网络失败原样重抛', () => {
  test('fetch 抛普通错误：拿到同一个错误对象，不包装成 HostInvokeAbortedError', async () => {
    const { channel } = open()
    const networkError = new Error('net::ERR_CONNECTION_REFUSED')
    vi.stubGlobal('fetch', () => Promise.reject(networkError))
    const failure = await channel.invoke('dock', ['status']).catch((error: unknown) => error)
    expect(failure).toBe(networkError)
    expect(failure).not.toBeInstanceOf(HostInvokeAbortedError)
    channel.close()
  })

  test('调用方 signal 已中止：仍是 HostInvokeAbortedError（与上面那条分开）', async () => {
    const { channel } = open()
    vi.stubGlobal('fetch', () => Promise.reject(new DOMException('aborted', 'AbortError')))
    const controller = new AbortController()
    controller.abort()
    const failure = await channel
      .invoke('dock', ['status'], { signal: controller.signal })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HostInvokeAbortedError)
    expect((failure as HostInvokeAbortedError).reason).toBe('aborted')
    channel.close()
  })
})
