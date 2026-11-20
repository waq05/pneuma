/**
 * remote 插件的 W14-C 补测：手机端插件壳（`shellUiOf`）那一整段装配面，
 * 以及只在这条路上才走到的上传/推送订阅/主控位收尾分支。
 *
 * 为什么要 mock `core/ui-bundles`：`uiAssetsDir()` / `uiPluginsDir()` 是按**编译产物**
 * （`lib/ui/...`）的位置算的，而单测跑的是 `src/`，所以真实落点永远不存在、壳分支永远不走。
 * 这里把这两个函数指到临时目录（一份 index.html + 一个最小插件产物），让
 * `createUiBootSource` / `createUiGraphFrames` / `createUiEvents` 全部真跑起来。
 *
 * 覆盖面（`packages/remote/index.ts` 行号）：
 *   - 壳分支 616-683：启动图源、数据通道、渠道鉴权、combos、启动图事件订阅与退订；
 *   - 通知推送 715-720、726-727 与「发送测试推送」1166/1178 在 `w14c-remote-notify.spec.ts`；
 *   - 插件期快照 572-573、invoke 缺方法 561、节流帧空连接 251-252；
 *   - 收尾：上传超限 413、推送订阅入库/退订（`pushSubscribe` / `pushUnsubscribe` 两个闭包）、
 *     进程退出钩子 1224。
 *
 * 真起 `127.0.0.1` 上的 HTTP + WS 服务（端口 `listen(0)` 现取），收尾全部关掉。
 * 不上外网：推送订阅只入库、不发；上传只发本机。
 *
 * @module dsc/packages/remote/tests/w14c-remote-shell
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { WebSocket } from 'ws'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-remote-w14c-shell-'))
process.env['DSC_HOME'] = HOME

/** 假界面壳产物目录：唯一一份 index.html（壳的首页）。 */
const ASSETS_DIR = join(HOME, 'ui-assets')
/** 假插件产物目录：一个最小内置插件 `demo`（client.js + bundle.json + 根清单）。 */
const PLUGINS_DIR = join(HOME, 'ui-plugins')

mkdirSync(ASSETS_DIR, { recursive: true })
mkdirSync(join(PLUGINS_DIR, 'demo'), { recursive: true })
writeFileSync(join(ASSETS_DIR, 'index.html'), '<html><body>手机壳首页</body></html>', 'utf8')
writeFileSync(join(PLUGINS_DIR, 'manifest.json'), JSON.stringify({ version: 1, apiVersion: '0.9.2' }), 'utf8')
writeFileSync(
  join(PLUGINS_DIR, 'demo', 'bundle.json'),
  JSON.stringify({ apiVersion: '0.9.2', file: 'client.js', platforms: ['web'], api: '^0.9.2' }),
  'utf8',
)
writeFileSync(join(PLUGINS_DIR, 'demo', 'client.js'), 'export const demo = "demo-client"\n', 'utf8')

/* 只把两个目录函数指到临时产物；其余导出（清单解析、产物表、combo）保持真的。 */
vi.mock('@pneuma/runtime/core/ui-bundles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pneuma/runtime/core/ui-bundles.js')>()
  return {
    ...actual,
    uiAssetsDir: () => ASSETS_DIR,
    uiPluginsDir: () => PLUGINS_DIR,
  }
})

type RemoteIndex = typeof import('../index.js')
let remotePlugin: RemoteIndex['remotePlugin']

beforeAll(async () => {
  remotePlugin = (await import('../index.js')).remotePlugin
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // 临时目录留给系统清
  }
})

// ── 假 ctx 与挂载 ────────────────────────────────────────────────────────────

interface Section {
  fields(): Array<{ key?: string; action?: string; text?: string }>
  values(): Record<string, unknown>
  save(key: string, value: unknown): void
  action(name: string): unknown
}

interface Harness {
  sections: Section[]
  notices: string[]
  logs: string[]
  fireTranscript(): void
  fire(name: string, ...args: unknown[]): void
  dispose(): void
}

function makePrefs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { enabled: false, port: 0, lan: false, push: false, notifyWebhook: '', ...over }
}

/** 假 ctx 跑真 apply；远程开关与推送开关由 prefs 直接喂。 */
function mount(passed: Record<string, unknown>, prefs = makePrefs(), opts: { sessionThrows?: boolean } = {}): Harness {
  const sections: Section[] = []
  const notices: string[] = []
  const logs: string[] = []
  const transcriptListeners = new Set<() => void>()
  const handlers = new Map<string, Set<(...args: unknown[]) => unknown>>()
  const cleanups: Array<() => void> = []
  const snapshot = {
    status: { sessionPath: join(HOME, 's.jsonl'), sessionId: 's', turnState: 'idle' },
    entries: [
      { id: 1, kind: 'text' },
      { id: -1, kind: 'text' },
    ],
    surfaces: { pendingApproval: null, pendingPlan: null, pendingQuestion: null },
  }
  const runtime = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    answerApproval: () => {},
    setUiPrefs: async () => ({ ok: true }),
    exit: vi.fn(),
  }
  const ctx = {
    ui: runtime,
    session: {
      current: () => {
        if (opts.sessionThrows === true) throw new Error('没有当前会话')
        return { meta: { id: 's', cwd: HOME }, filePath: join(HOME, 's.jsonl') }
      },
    },
    transcript: {
      system: (text: string) => notices.push(text),
      subscribe: (listener: () => void) => {
        transcriptListeners.add(listener)
        return () => transcriptListeners.delete(listener)
      },
      touch: () => {},
    },
    agent: { followup: () => {}, interrupt: () => {} },
    approval: { setPolicy: () => {}, setReviewer: () => {}, answer: () => {} },
    settings: {
      prefs: () => ({ remote: { ...prefs }, ui: {} }),
      setPrefs: (patch: { remote?: Record<string, unknown> }) => {
        if (patch.remote !== undefined) Object.assign(prefs, patch.remote)
      },
      registerSection: (section: Section) => {
        sections.push(section)
        return () => {}
      },
      watchPrefs: () => () => {},
    },
    emit(event: string, ...args: unknown[]) {
      if (event === 'dsc/notice') notices.push(String(args[0] ?? ''))
      for (const handler of handlers.get(event) ?? []) handler(...args)
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(handler)
      return () => handlers.get(event)?.delete(handler)
    },
    effect: (execute: () => unknown) => {
      const result = execute()
      const off = typeof result === 'function' ? (result as () => void) : (): void => {}
      cleanups.push(off)
      return off
    },
    logger: {
      warn: (line: string) => logs.push(line),
    },
  }
  remotePlugin.apply?.(ctx as never, passed)
  const harness: Harness = {
    sections,
    notices,
    logs,
    fireTranscript: () => {
      for (const listener of [...transcriptListeners]) listener()
    },
    fire: (name, ...args) => {
      for (const handler of [...(handlers.get(name) ?? [])]) handler(...args)
    },
    dispose: () => {
      for (const off of cleanups.splice(0).reverse()) off()
    },
  }
  opened.push(harness)
  return harness
}

const opened: Harness[] = []

afterEach(() => {
  for (const harness of opened.splice(0)) {
    try {
      harness.dispose()
    } catch {
      // 已经收过了
    }
  }
})

/** 现取一个空闲端口。 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function sectionOf(harness: Harness): Section {
  const section = harness.sections[0]
  if (section === undefined) throw new Error('没有注册 remote 设置分区')
  return section
}

/** 等设置分区状态变成「运行中」。 */
async function waitRunning(harness: Harness, port: number): Promise<void> {
  await vi.waitFor(() => {
    const status = sectionOf(harness)
      .fields()
      .find((field) => field.key === undefined && String(field.text ?? '').includes('运行中'))
    expect(String(status?.text)).toContain(`:${String(port)}`)
  })
}

interface Paired {
  token: string
  cookie: string
}

/** 起服务后配一台设备，拿到 token 与设备 Cookie。 */
async function pairDevice(harness: Harness, base: string): Promise<Paired> {
  const issued = (await sectionOf(harness).action('regenerate-code')) as { data: { code: string } }
  const response = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: issued.data.code, deviceName: '测试手机' }),
  })
  const doc = (await response.json()) as { token: string }
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { token: doc.token, cookie }
}

/** 设备 token 换一张 WS 票据。 */
async function ticketOf(base: string, token: string): Promise<string> {
  const response = await fetch(`${base}/api/ticket`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  return ((await response.json()) as { ticket: string }).ticket
}

interface WsHarness {
  ws: WebSocket
  messages: Array<Record<string, unknown>>
  waitFor(predicate: (message: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>
  close(): void
}

/** 连一条 WS 并收集消息。 */
function connectWs(port: number, ticket: string): Promise<WsHarness> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`)
  const messages: Array<Record<string, unknown>> = []
  const waiters: Array<{ predicate: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = []
  ws.on('message', (data) => {
    const parsed = JSON.parse(data.toString()) as Record<string, unknown>
    messages.push(parsed)
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(parsed)) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(parsed)
    }
  })
  return new Promise<WsHarness>((resolveWs, rejectWs) => {
    ws.once('open', () => {
      resolveWs({
        ws,
        messages,
        waitFor(predicate, timeoutMs = 3_000) {
          const existing = messages.find(predicate)
          if (existing !== undefined) return Promise.resolve(existing)
          return new Promise((resolveMessage, rejectMessage) => {
            const timer = setTimeout(() => {
              rejectMessage(new Error(`等 WS 消息超时；已收到：${JSON.stringify(messages)}`))
            }, timeoutMs)
            timer.unref?.()
            waiters.push({
              predicate,
              resolve: (message) => {
                clearTimeout(timer)
                resolveMessage(message)
              },
            })
          })
        },
        close() {
          ws.close()
        },
      })
    })
    ws.once('error', rejectWs)
  })
}

/** 发一次未经 fetch 加工的 HTTP 请求（可带大 body；Host 头也能自己写）。 */
function rawPost(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'POST', path, headers: { ...headers, 'content-length': String(body.length) } },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
        })
        res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, body: text }))
      },
    )
    // 413 会先回、上传体随后写不进去：以已收到的响应为准，写侧错误忽略。
    req.on('error', () => {})
    req.end(body)
  })
}

/** 给一条 SSE 响应包一个只建一次的 reader：同一条流不能重复 getReader。 */
function sseReader(response: Response): (marker: string, count: number, timeoutMs?: number) => Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('响应没有 body')
  const decoder = new TextDecoder()
  let text = ''
  return async (marker, count, timeoutMs = 4_000) => {
    const readLoop = (async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
        if (text.split(marker).length - 1 >= count) return
      }
    })()
    await Promise.race([
      readLoop,
      new Promise((_, rejectTime) => {
        const timer = setTimeout(
          () => rejectTime(new Error(`等 SSE 事件 ${marker} 超时；已收到：${text.slice(-400)}`)),
          timeoutMs,
        )
        timer.unref?.()
      }),
    ])
    return text
  }
}

// ── 用例 ─────────────────────────────────────────────────────────────────────

describe('插件版壳：配对页、壳首页、启动图与插件 bundle', () => {
  test('未配对给配对页；配对后根路径回壳首页（注入 /boot.js）、能取启动图与单插件 bundle', async () => {
    const port = await freePort()
    const harness = mount({}, makePrefs({ enabled: true, port }))
    await waitRunning(harness, port)
    const base = `http://127.0.0.1:${port}`

    const pairingPage = await fetch(`${base}/`)
    expect(pairingPage.status).toBe(200)
    expect(await pairingPage.text()).toContain('配对码')
    const pairJs = await fetch(`${base}/pair.js`)
    expect(pairJs.status).toBe(200)
    expect(await pairJs.text()).toContain('/api/pair')

    const paired = await pairDevice(harness, base)
    const home = await fetch(`${base}/`, { headers: { cookie: paired.cookie } })
    const homeText = await home.text()
    expect(homeText).toContain('手机壳首页')
    // 壳首页会被补上外链启动图标签（与本机界面服务同一份变换）。
    expect(homeText).toContain('/boot.js')

    const bootJs = await fetch(`${base}/boot.js`, { headers: { cookie: paired.cookie } })
    expect(await bootJs.text()).toContain('__DSC_BOOT__')

    const bootResponse = await fetch(`${base}/api/boot`, { headers: { cookie: paired.cookie } })
    const bootText = await bootResponse.text()
    expect(bootResponse.status, bootText).toBe(200)
    const bootDoc = JSON.parse(bootText) as { entries?: Array<{ id: string; url: string }> }
    const demo = bootDoc.entries?.find((entry) => entry.id === 'demo')
    expect(demo, bootText).toBeDefined()
    const bundle = await fetch(`${base}/${String(demo?.url)}`, { headers: { cookie: paired.cookie } })
    expect(bundle.status).toBe(200)
    expect(await bundle.text()).toContain('demo-client')
  })

  test('壳数据通道：白名单外/坏实参/正常调用三态；启动图变化会往 SSE 推一帧', async () => {
    const port = await freePort()
    const harness = mount({}, makePrefs({ enabled: true, port }))
    await waitRunning(harness, port)
    const base = `http://127.0.0.1:${port}`
    const paired = await pairDevice(harness, base)

    const post = async (method: string, args: unknown[]): Promise<{ status: number; ok: boolean; error?: string }> => {
      const response = await fetch(`${base}/api/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: paired.cookie },
        body: JSON.stringify({ method, args }),
      })
      return { status: response.status, ...((await response.json()) as { ok: boolean; error?: string }) }
    }

    // 协议层先挡一道（403），壳的实参校验再挡一道（200 + ok:false），最后一档真派发。
    const notAllowed = await post('saveProvider', [])
    expect(notAllowed.status).toBe(403)
    const badArgs = await post('renameSession', [])
    expect(badArgs.status).toBe(200)
    expect(badArgs.ok).toBe(false)
    const good = await post('setUiPrefs', [{}])
    expect(good.status).toBe(200)
    expect(good.ok).toBe(true)

    const controller = new AbortController()
    const events = await fetch(`${base}/api/events`, { headers: { cookie: paired.cookie }, signal: controller.signal })
    expect(events.status).toBe(200)
    const read = sseReader(events)
    const first = await read('event: plugins', 1)
    expect(first).toContain('event: hello')
    expect(first).toContain('"demo"')
    // 翻插件开关会推第二帧启动图（与本地壳同一套事件名）。
    harness.fire('dsc/ui-plugins-changed')
    const second = await read('event: plugins', 2)
    expect(second).toContain('event: plugins')
    controller.abort()
  })

  test('快照取不到（会话没了）：造帧失败只写日志，不把页面弄断', async () => {
    const port = await freePort()
    const harness = mount({}, makePrefs({ enabled: true, port }), { sessionThrows: true })
    await waitRunning(harness, port)
    const base = `http://127.0.0.1:${port}`
    const paired = await pairDevice(harness, base)
    const controller = new AbortController()
    const events = await fetch(`${base}/api/events`, { headers: { cookie: paired.cookie }, signal: controller.signal })
    expect(events.status).toBe(200)
    // 首帧全量要取快照：取不到时数据通道自己记日志、跳过这一帧（页面连接不断）。
    await vi.waitFor(() => expect(harness.logs.join('\n')).toContain('造帧失败'))
    controller.abort()
  })
})

describe('壳档数据通道的方法面', () => {
  test('壳方法表外的错误在入口就被挡住', async () => {
    const port = await freePort()
    const harness = mount({}, makePrefs({ enabled: true, port }))
    await waitRunning(harness, port)
    const base = `http://127.0.0.1:${port}`
    const paired = await pairDevice(harness, base)
    const response = await fetch(`${base}/api/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: paired.cookie },
      body: JSON.stringify({ method: 'setPluginEnabled', args: ['x', true] }),
    })
    const doc = (await response.json()) as { ok: boolean; error?: string }
    expect(doc.ok).toBe(false)
  })
})

describe('WS 会话与节流帧', () => {
  test('非白名单方法、运行时缺的方法各回一句错；连接断开后到点的节流帧只记漏变化', async () => {
    const port = await freePort()
    const harness = mount({ snapshotThrottleMs: 137 }, makePrefs({ enabled: true, port }))
    await waitRunning(harness, port)
    const base = `http://127.0.0.1:${port}`
    const paired = await pairDevice(harness, base)
    const session = await connectWs(port, await ticketOf(base, paired.token))
    await session.waitFor((message) => message['type'] === 'hello')
    await session.waitFor((message) => message['type'] === 'snapshot')
    // 快照里的直播间条目（负 id）与正式条目分开给：hello 之后那一帧能看出来。
    expect(JSON.stringify(session.messages)).toContain('liveEntries')

    session.ws.send(JSON.stringify({ type: 'invoke', id: 1, method: 'saveProvider', args: [] }))
    const notAllowed = await session.waitFor((message) => message['id'] === 1)
    expect(notAllowed['ok']).toBe(false)
    expect(String(notAllowed['error'])).toContain('远程不开放')

    session.ws.send(JSON.stringify({ type: 'invoke', id: 2, method: 'listArchivedSessions', args: [] }))
    const missing = await session.waitFor((message) => message['id'] === 2)
    expect(missing['ok']).toBe(false)
    expect(String(missing['error'])).toContain('运行时没有这个方法')

    // 拦下节流定时器：够得着「到点时一条连接都不剩」这条分支，又不用真等。
    // leading-edge 口径让等待值不总等于配置值（上一帧刚推过就只剩零头），所以按上限收。
    const original = globalThis.setTimeout
    const captured: Array<() => void> = []
    globalThis.setTimeout = ((callback: () => void, ms?: number, ...args: unknown[]) => {
      if (typeof ms === 'number' && ms <= 200) {
        captured.push(callback)
        return 0 as unknown as NodeJS.Timeout
      }
      return (original as unknown as (cb: () => void, delayMs?: number, ...rest: unknown[]) => NodeJS.Timeout)(
        callback,
        ms,
        ...args,
      )
    }) as typeof setTimeout
    try {
      harness.fireTranscript()
      expect(captured).toHaveLength(1)
      // 吊销全部设备会在同步路径里把 socket 从集合里摘掉，再跑到点的回调就是空连接分支。
      await sectionOf(harness).action('revoke-all')
      captured[0]!()
    } finally {
      globalThis.setTimeout = original
    }
    session.close()
  })
})

describe('路由与收尾', () => {
  test('上传超 20MB：回 413，不把连接掐成 socket hang up', async () => {
    const port = await freePort()
    const harness = mount({}, makePrefs({ enabled: true, port }))
    await waitRunning(harness, port)
    const base = `http://127.0.0.1:${port}`
    const paired = await pairDevice(harness, base)
    const body = Buffer.alloc(20 * 1024 * 1024 + 1024, 0x61)
    const response = await rawPost(port, '/api/upload?filename=big.bin', { authorization: `Bearer ${paired.token}` }, body)
    expect(response.status).toBe(413)
    expect(response.body).toContain('请求体超过')
  }, 20_000)

  test('推送订阅：没凭据 401；有凭据入库与退订（走插件给的 pushSubscribe/pushUnsubscribe）', async () => {
    const port = await freePort()
    const harness = mount({}, makePrefs({ enabled: true, port, push: true }))
    await waitRunning(harness, port)
    const base = `http://127.0.0.1:${port}`
    const paired = await pairDevice(harness, base)
    const payload = { endpoint: 'https://127.0.0.1:9/push', keys: { p256dh: 'cGxhaW4=', auth: 'YXV0aA==' } }

    const anonymous = await fetch(`${base}/api/push-subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(anonymous.status).toBe(401)
    expect(((await anonymous.json()) as { error: string }).error).toContain('设备凭据无效')

    const added = await fetch(`${base}/api/push-subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: paired.cookie },
      body: JSON.stringify(payload),
    })
    expect(added.status).toBe(200)
    expect(await added.json()).toMatchObject({ ok: true, added: true })

    const removed = await fetch(`${base}/api/push-unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: paired.cookie },
      body: JSON.stringify({ endpoint: payload.endpoint }),
    })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ ok: true, removed: true })
  })

  test('进程退出钩子：把主控位文件放掉', async () => {
    // 不真的 `process.emit('exit')`：那会把同一 worker 里所有退出钩子都跑一遍，可能拆掉
    // 后续用例还要用的资源。改成截下插件注册的那一个回调再单独调它。
    const onceSpy = vi.spyOn(process, 'once')
    try {
      const port = await freePort()
      const harness = mount({}, makePrefs({ enabled: true, port }))
      await waitRunning(harness, port)
      const ownerFile = join(HOME, 'remote', '.owner.json')
      expect(existsSync(ownerFile)).toBe(true)
      const exitListeners = onceSpy.mock.calls.filter(([event]) => event === 'exit').map(([, listener]) => listener)
      expect(exitListeners.length).toBeGreaterThan(0)
      const onExit = exitListeners[exitListeners.length - 1] as () => void
      onExit()
      expect(existsSync(ownerFile)).toBe(false)
    } finally {
      onceSpy.mockRestore()
    }
  })
})
