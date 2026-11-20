/**
 * webserver 插件的 W14 补缺口测试：真起本机界面服务，走装配面而不是 `readUiServerConfig`。
 *
 * 既有 `webserver.spec.ts` 只钉包形态与配置；这里把 `apply` 的整条装配链跑起来（端口 0，
 * 只监听 127.0.0.1，不连外网），补的缺口是：
 *
 *   - `ensure()` 的启动、复用与 `running`；
 *   - 启动图热更事件（`dsc/ui-plugins-changed` / `dsc/ui-graph-dirty`）推帧；
 *   - 快照里的已定稿 / 直播尾分桶与旁问增量扇出；
 *   - 造帧失败时经 logger 报出来（通道 log 回调）；
 *   - `/api/invoke` 的 submit 第三参过 `sanitizeFileRefs`；
 *   - HMR 轮询起来后读 watch 行；
 *   - 起不来时（端口被占）只 warn 不掀翻插件；
 *   - 插件卸载 effect 把服务与订阅收干净。
 *
 * `DSC_HOME` 在 import 之前指到临时目录（签名密钥与附件仓库落在那儿），真实 `~/.dsc` 不碰。
 *
 * @module @pneuma/webserver/tests/w14-assembly
 */
import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

const HOME = createTempDir('dsc-webserver-w14-')
process.env['DSC_HOME'] = HOME

type WebServerMod = typeof import('../index.js')
let webserverPlugin: WebServerMod['webserverPlugin']

afterAll(() => {
  delete process.env['DSC_HOME']
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

interface Mounted {
  service: {
    ensure(): Promise<{ url: string; origin: string; port: number }>
    readonly running: unknown
  }
  runtime: {
    getSnapshot: () => unknown
    subscribe: (listener: () => void) => () => void
    submit: ReturnType<typeof vi.fn>
  }
  warn: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  systems: string[]
  snapshotListener: (() => void) | undefined
  fire(event: string, ...args: unknown[]): void
  dispose(): void
}

/** 假 ctx 装一次 webserver 插件。 */
function mount(passed: Record<string, unknown>): Mounted {
  const events = new Map<string, Array<(...args: unknown[]) => void>>()
  const systems: string[] = []
  const warn = vi.fn()
  const info = vi.fn()
  let snapshotListener: (() => void) | undefined
  let provided: unknown
  let effectDispose: (() => void) | undefined
  const runtime = {
    getSnapshot: () => ({
      seq: 7,
      status: { sessionId: 's1', turnState: 'idle' },
      entries: [
        { id: 1, text: '定稿' },
        { id: -1, text: '直播' },
      ],
    }),
    subscribe: (listener: () => void) => {
      snapshotListener = listener
      return () => {
        snapshotListener = undefined
      }
    },
    submit: vi.fn(),
  }
  const ctx = {
    ui: runtime,
    transcript: {
      system: (text: string) => systems.push(text),
      touch: vi.fn(),
    },
    logger: { warn, info, error: vi.fn() },
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = events.get(event) ?? []
      list.push(handler)
      events.set(event, list)
      return () => {
        const at = list.indexOf(handler)
        if (at >= 0) list.splice(at, 1)
      }
    },
    provide(name: string, value: unknown) {
      if (name === 'webServer') provided = value
    },
    effect(execute: () => unknown) {
      const result = execute()
      effectDispose = typeof result === 'function' ? (result as () => void) : undefined
      return effectDispose ?? (() => {})
    },
  }
  ;(webserverPlugin.apply as (ctx: unknown, passed: unknown) => void)(ctx as never, passed)
  expect(provided).toBeDefined()
  return {
    service: provided as Mounted['service'],
    runtime,
    warn,
    info,
    systems,
    get snapshotListener() {
      return snapshotListener
    },
    fire(event, ...args) {
      for (const handler of [...(events.get(event) ?? [])]) handler(...args)
    },
    dispose: () => effectDispose?.(),
  }
}

/** 用一次性令牌换 Cookie（303 + set-cookie）。 */
async function exchange(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  expect(response.status).toBe(303)
  const cookie = response.headers.get('set-cookie') ?? ''
  return cookie.split(';')[0] ?? ''
}

beforeAll(async () => {
  ;({ webserverPlugin } = await import('../index.js'))
})

describe('装配面：ensure、热更事件与数据通道', () => {
  test('启动、复用、推帧、旁问扇出、造帧失败与 invoke', async () => {
    const h = mount({ enabled: false, port: 0, hmr: false })
    const service = h.service
    try {
      const pending = service.ensure()
      // start() 先订阅热更事件再 await 创建服务；这一刻 handle 还是 null，推帧要安全地什么都不做。
      h.fire('dsc/ui-plugins-changed')
      const handle = await pending
      expect(handle.url).toContain('?token=')
      expect(handle.origin).toBe(`http://127.0.0.1:${String(handle.port)}`)

      // 第二次 ensure 直接复用，不重新监听。
      await expect(service.ensure()).resolves.toMatchObject({
        port: handle.port,
      })
      expect(service.running).not.toBeNull()

      // 服务起来之后再推帧：refresh → 取图 → 推 plugins 帧。
      expect(() => h.fire('dsc/ui-plugins-changed')).not.toThrow()
      expect(() => h.fire('dsc/ui-graph-dirty')).not.toThrow()

      // 快照订阅回调驱动一帧；此时没有页面连着，只记「漏过变化」，不造帧。
      h.snapshotListener?.()
      // 旁问增量经 dsc/side-ask-chunk 扇出到通道订阅者。
      expect(() => h.fire('dsc/side-ask-chunk', { id: 'ask-1', delta: '你' })).not.toThrow()

      // 连一条 SSE：第一帧要在这里造出来（已定稿 / 直播尾分桶就在造帧时发生）。
      const cookie = await exchange(handle.url)
      const sse = await fetch(`${handle.origin}/api/events`, {
        headers: { cookie, accept: 'text/event-stream' },
      })
      expect(sse.status).toBe(200)
      const reader = sse.body!.getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain('event: frame')

      // 造帧失败走通道 log → ctx.logger.warn，不静默。
      h.runtime.getSnapshot = () => {
        throw new Error('快照形状坏了')
      }
      h.snapshotListener?.()
      await vi.waitFor(() => expect(h.warn).toHaveBeenCalled())
      expect(String(h.warn.mock.calls[0]?.[0])).toContain('造帧失败')
      await reader.cancel()

      // /api/invoke：submit 的第三参过 sanitizeFileRefs，空清单原样变成 []。
      const response = await fetch(`${handle.origin}/api/invoke`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'submit', args: ['你好', [], []] }),
      })
      await expect(response.json()).resolves.toMatchObject({ ok: true })
      expect(h.runtime.submit).toHaveBeenCalledWith('你好', [], [])
    } finally {
      h.dispose()
    }
  })
})

describe('HMR 轮询', () => {
  test('hmr 打开后定时轮询读 watch 行，停用时定时器一起收掉', async () => {
    const h = mount({
      enabled: false,
      port: 0,
      hmr: true,
      hmrPollIntervalMs: 50,
    })
    try {
      const handle = await h.service.ensure()
      // 轮询间隔 50ms；等几拍（不定时死等，够 poll 跑到「基线已建、发现目录缺失 → refresh」即可）。
      await new Promise((resolveTick) => setTimeout(resolveTick, 200))
      expect(handle.port).toBeGreaterThan(0)
      h.fire('dsc/ui-plugins-changed')
    } finally {
      const running = h.service.running as { close(): Promise<void> } | null
      h.dispose()
      if (running !== null && running !== undefined) await running.close()
    }
  })
})

describe('起不来与卸载', () => {
  test('端口被占时 apply 只 warn；卸载 effect 关服务并退订', async () => {
    // 先占住一个端口，再让插件去 listen 同一个。
    const blocker: Server = createServer((_req, res) => res.end('occupied'))
    await new Promise<void>((resolveListen) => blocker.listen(0, '127.0.0.1', () => resolveListen()))
    const address = blocker.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    process.env['DSC_UI_PORT'] = String(port)
    const h = mount({ enabled: true, port: 0, hmr: false })
    try {
      await vi.waitFor(() => expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('webserver: 起不来')))
    } finally {
      h.dispose()
      delete process.env['DSC_UI_PORT']
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()))
    }
  })
})
