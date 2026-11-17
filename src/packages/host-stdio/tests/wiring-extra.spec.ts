/**
 * @pneuma/host-stdio 的补缺口测试：parentPort 传输（桌面壳那条路）与 dock 浏览器链路。
 *
 * 既有两份 spec 只走 stdio（没有桌面壳）与包形态；这里把 `process.parentPort` 装上，覆盖：
 *
 *   - `pickTransport` 选 parentPort 后的握手、快照节流、`interactive.reachable`；
 *   - host→runtime 的 invoke（允许 / 白名单拒绝 / 抛错 / 异步返回值）与 exit；
 *   - dock 浏览器四条请求的发送、应答兑现、超时、迟到应答与 `dsc/exit` 时统一拒绝；
 *   - browser-event 分发容错、ui-url 的成败，以及 `dsc/open-*` / `dsc/dock-data` 转发。
 *
 * 每条用例自己造一个假父端口并挂到 process 上，结束前触发 `dsc/exit` 清掉节流定时器。
 *
 * @module @pneuma/host-stdio/tests/wiring-extra
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { HostBrowserLink } from '../../../core/host-browser-link.js'
import { HOST_BROWSER_SERVICE } from '../../../core/host-browser-link.js'
import { HOST_PROTOCOL_VERSION } from '../../../core/dock-browser.js'
import { hostStdioPlugin } from '../index.js'

/** 假父端口：记录发出去的消息，允许测试往里灌 host→runtime 消息。 */
interface FakePort {
  sent: Array<Record<string, unknown>>
  handlers: Array<(event: { data: unknown }) => void>
  postMessage(message: unknown): void
  on(event: string, listener: (event: { data: unknown }) => void): void
}

/** 没有 `parentPort` 时 process 上的属性键。 */
const processWithPort = process as typeof process & { parentPort?: FakePort }
const originalPort = processWithPort.parentPort

afterEach(() => {
  if (originalPort === undefined) delete processWithPort.parentPort
  else processWithPort.parentPort = originalPort
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 装一次插件，返回测试要用的所有把手。 */
function mount(webServer?: unknown) {
  const sent: Array<Record<string, unknown>> = []
  const handlers: Array<(event: { data: unknown }) => void> = []
  const port: FakePort = {
    sent,
    handlers,
    postMessage(message) {
      sent.push(message as Record<string, unknown>)
    },
    on(event, listener) {
      if (event === 'message') handlers.push(listener)
    },
  }
  processWithPort.parentPort = port

  const provided = new Map<string, unknown>()
  const events = new Map<string, Array<(...args: unknown[]) => void>>()
  let snapshotListener: (() => void) | undefined
  let effectDispose: (() => void) | undefined
  const runtime = {
    getSnapshot: () => ({ seq: 1, entries: [], liveEntries: [], status: { turnState: 'idle' } }),
    subscribe: (listener: () => void) => {
      snapshotListener = listener
      return () => {
        snapshotListener = undefined
      }
    },
    listPlugins: () => [{ name: 'base' }],
    usageStats: async () => ({ totalTurns: 1 }),
    setModel: async (model: string) => ({ model }),
    exit: vi.fn(),
  }
  const warn = vi.fn()
  const ctx = {
    ui: runtime,
    provide(name: string, value: unknown) {
      provided.set(name, value)
      return () => {
        if (provided.get(name) === value) provided.delete(name)
      }
    },
    get(name: string) {
      return name === 'webServer' ? webServer : undefined
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = events.get(event) ?? []
      list.push(handler)
      events.set(event, list)
      return () => {
        const at = list.indexOf(handler)
        if (at >= 0) list.splice(at, 1)
      }
    },
    logger: { warn, info: vi.fn(), error: vi.fn() },
    effect(execute: () => unknown) {
      const result = execute()
      effectDispose = typeof result === 'function' ? (result as () => void) : undefined
      return effectDispose ?? (() => {})
    },
  }

  hostStdioPlugin.apply(ctx as never, { snapshotThrottleMs: 1 })

  return {
    port,
    sent,
    provided,
    runtime,
    warn,
    snapshot: () => snapshotListener?.(),
    emitHost(message: Record<string, unknown>) {
      for (const handler of [...handlers]) handler({ data: message })
    },
    fire(event: string, ...args: unknown[]) {
      for (const handler of [...(events.get(event) ?? [])]) handler(...args)
    },
    exit() {
      for (const handler of [...(events.get('dsc/exit') ?? [])]) handler()
    },
    disposeEffect: () => effectDispose?.(),
  }
}

/** 等一条满足条件的线上消息（invoke/result 是异步写的）。 */
async function waitSent(sent: Array<Record<string, unknown>>, match: (message: Record<string, unknown>) => boolean) {
  let found: Record<string, unknown> | undefined
  await vi.waitFor(() => {
    found = sent.find(match)
    expect(found).toBeDefined()
  })
  return found!
}

/** 取 dock 请求发出去时用的自增 id。 */
function requestId(sent: Array<Record<string, unknown>>, type: string): number {
  const message = [...sent].reverse().find((item) => item['type'] === type)
  if (message === undefined) throw new Error(`没有发出 ${type}`)
  return message['id'] as number
}

describe('parentPort 传输：握手、快照与事件转发', () => {
  test('握手带契约版本；快照按节流推送；interactive 判可达', async () => {
    const mounted = mount()
    try {
      expect(mounted.sent[0]).toEqual({ type: 'hello', protocolVersion: HOST_PROTOCOL_VERSION })
      expect(mounted.provided.get('interactive')).toEqual({ kind: 'host', reachable: expect.any(Function) })
      const interactive = mounted.provided.get('interactive') as { reachable(): boolean }
      expect(interactive.reachable()).toBe(true)

      const first = await waitSent(mounted.sent, (message) => message['type'] === 'snapshot')
      expect(first['snapshot']).toMatchObject({ seq: 1 })

      const before = mounted.sent.filter((message) => message['type'] === 'snapshot').length
      mounted.snapshot()
      await vi.waitFor(() => {
        const after = mounted.sent.filter((message) => message['type'] === 'snapshot').length
        expect(after).toBeGreaterThan(before)
      })

      mounted.fire('dsc/open-picker')
      mounted.fire('dsc/open-models')
      mounted.fire('dsc/dock-data', 'term-1', 'hello')
      expect(mounted.sent.at(-1)).toEqual({ type: 'dock-data', id: 'term-1', data: 'hello' })
      expect(mounted.sent.some((message) => message['action'] === 'open-picker')).toBe(true)
      expect(mounted.sent.some((message) => message['action'] === 'open-models')).toBe(true)
    } finally {
      mounted.exit()
    }
    expect(mounted.provided.has(HOST_BROWSER_SERVICE)).toBe(false)
  })
})

describe('invoke 与 exit：白名单、返回值与异常', () => {
  test('允许的同步/异步方法回 result；白名单外与抛错各回一句人话；exit 转给 runtime', async () => {
    const mounted = mount()
    try {
      mounted.emitHost({ type: 'invoke', id: 1, method: 'listPlugins', args: [] })
      const ok = await waitSent(mounted.sent, (message) => message['type'] === 'result' && message['id'] === 1)
      expect(ok).toMatchObject({ ok: true, value: [{ name: 'base' }] })

      mounted.emitHost({ type: 'invoke', id: 2, method: 'usageStats' })
      const asyncResult = await waitSent(mounted.sent, (message) => message['type'] === 'result' && message['id'] === 2)
      expect(asyncResult).toMatchObject({ ok: true, value: { totalTurns: 1 } })

      mounted.emitHost({ type: 'invoke', id: 3, method: 'noSuchMethod' })
      const denied = await waitSent(mounted.sent, (message) => message['type'] === 'result' && message['id'] === 3)
      expect(denied).toMatchObject({ ok: false })
      expect(String(denied['error'])).toContain('协议不允许调用')

      mounted.emitHost({ type: 'invoke', id: 4, method: 'setModel', args: ['deepseek/chat'] })
      const model = await waitSent(mounted.sent, (message) => message['type'] === 'result' && message['id'] === 4)
      expect(model).toMatchObject({ ok: true, value: { model: 'deepseek/chat' } })

      const boom = { ...mounted.runtime, setModel: () => Promise.reject(new Error('模型切换失败')) }
      // 直接把 runtime 上那个方法换掉（插件持有的是同一个对象引用）。
      ;(mounted.runtime as { setModel: unknown }).setModel = boom.setModel
      mounted.emitHost({ type: 'invoke', id: 5, method: 'setModel', args: ['x'] })
      const failed = await waitSent(mounted.sent, (message) => message['type'] === 'result' && message['id'] === 5)
      expect(failed).toMatchObject({ ok: false, error: '模型切换失败' })

      mounted.emitHost({ type: 'exit' })
      expect(mounted.runtime.exit).toHaveBeenCalledTimes(1)
    } finally {
      mounted.exit()
    }
  })
})

describe('dock 浏览器链路：四条请求、应答、超时与收尾', () => {
  test('views/open/close/call 的线上形状与应答兑现；失败应答传给 reject', async () => {
    const mounted = mount()
    try {
      const link = mounted.provided.get(HOST_BROWSER_SERVICE) as HostBrowserLink
      expect(link.available()).toBe(true)

      const views = link.views()
      const viewsId = requestId(mounted.sent, 'browser-views')
      mounted.emitHost({ type: 'browser-result', id: viewsId, ok: true, value: [{ viewId: 'v1' }] })
      await expect(views).resolves.toEqual([{ viewId: 'v1' }])

      const opened = link.open('https://example.com/', 'v1')
      const openMessage = [...mounted.sent].reverse().find((message) => message['type'] === 'browser-open')!
      expect(openMessage).toMatchObject({ url: 'https://example.com/', viewId: 'v1' })
      mounted.emitHost({ type: 'browser-result', id: openMessage['id'], ok: true, value: { viewId: 'v1' } })
      await expect(opened).resolves.toEqual({ viewId: 'v1' })

      const closed = link.close('v1')
      const closeId = requestId(mounted.sent, 'browser-close')
      mounted.emitHost({ type: 'browser-result', id: closeId, ok: true, value: null })
      // browserClose 只 await、不把应答值交出去：结账后一律 undefined。
      await expect(closed).resolves.toBeUndefined()

      const called = link.call('v1', 'Page.enable', { a: 1 })
      const callMessage = [...mounted.sent].reverse().find((message) => message['type'] === 'browser-call')!
      expect(callMessage).toMatchObject({ viewId: 'v1', method: 'Page.enable', params: { a: 1 } })
      mounted.emitHost({ type: 'browser-result', id: callMessage['id'], ok: false, error: '视图没了' })
      await expect(called).rejects.toThrow('视图没了')

      // 不认识 / 迟到的应答直接丢掉，不抛也不回写。
      mounted.emitHost({ type: 'browser-result', id: 99_999, ok: true, value: 1 })
      mounted.emitHost({ type: 'browser-result', id: viewsId, ok: true, value: 'late' })
    } finally {
      mounted.exit()
    }
  })

  test('send 抛错立刻拒绝；超时报人话；退出时挂着的请求统一拒绝', async () => {
    const mounted = mount()
    const link = mounted.provided.get(HOST_BROWSER_SERVICE) as HostBrowserLink
    try {
      // 发不出去：postMessage 抛错。
      const originalPost = mounted.port.postMessage
      mounted.port.postMessage = () => {
        throw new Error('端口关了')
      }
      await expect(link.close('v1')).rejects.toThrow(/browser-close 发不出去：端口关了/)
      mounted.port.postMessage = originalPost

      // 退出时还挂着：统一按「宿主正在退出」拒绝。
      const pending = link.views()
      mounted.exit()
      await expect(pending).rejects.toThrow(/宿主正在退出，browser-views 没有拿到应答/)
    } finally {
      mounted.exit()
    }

    // 超时单独起一次（假定时器只在这一次生效）。
    const timed = mount()
    vi.useFakeTimers()
    try {
      const timedLink = timed.provided.get(HOST_BROWSER_SERVICE) as HostBrowserLink
      const pending = timedLink.views()
      const assertion = expect(pending).rejects.toThrow(/browser-views 超时（25000ms）/)
      await vi.advanceTimersByTimeAsync(25_001)
      await assertion
    } finally {
      timed.disposeEffect()
      vi.useRealTimers()
    }
  })

  test('browser-event 分发给订阅者，单个订阅者抛错不挡住别人', () => {
    const mounted = mount()
    try {
      const link = mounted.provided.get(HOST_BROWSER_SERVICE) as HostBrowserLink
      const seen: unknown[] = []
      const offBad = link.onEvent(() => {
        throw new Error('这一条不要了')
      })
      const off = link.onEvent((event) => seen.push(event))
      mounted.emitHost({ type: 'browser-event', viewId: 'v1', method: 'Page.loadEventFired', params: {} })
      expect(seen).toHaveLength(1)
      off()
      mounted.emitHost({ type: 'browser-event', viewId: 'v1', method: 'Page.loadEventFired', params: {} })
      expect(seen).toHaveLength(1)
      offBad()
    } finally {
      mounted.exit()
    }
  })
})

describe('ui-url 与 webServer', () => {
  test('ensure 成功发 ui-url；失败只记 warn，不掀翻插件', async () => {
    const ok = mount({
      ensure: async () => ({ url: 'http://127.0.0.1:9/?t=1', origin: 'http://127.0.0.1:9' }),
    })
    try {
      const message = await waitSent(ok.sent, (item) => item['type'] === 'ui-url')
      expect(message).toMatchObject({ url: 'http://127.0.0.1:9/?t=1', origin: 'http://127.0.0.1:9' })
    } finally {
      ok.exit()
    }

    const failed = mount({
      ensure: async () => {
        throw new Error('端口被占')
      },
    })
    try {
      await vi.waitFor(() => expect(failed.warn).toHaveBeenCalled())
      expect(String(failed.warn.mock.calls[0]?.[0])).toContain('本机界面服务起不来')
      expect(String(failed.warn.mock.calls[0]?.[0])).toContain('端口被占')
    } finally {
      failed.exit()
    }
  })
})
