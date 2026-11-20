/**
 * browser 插件收尾缺口（`packages/browser/index.ts`）：w11/wiring 两份没走到的那几行。
 *
 * 补五处行为：
 *   - 相对地址拼不到当前页（`new URL` 本身抛）时给可照做的错；
 *   - auto_accept / auto_dismiss 策略下 `handleDialog` 失败写进 transcript；
 *   - 「切回主标签页」时连接已经换了（重连/重开）的拒绝；
 *   - 设置分区 save 的四个纯文本/数字键（executablePath / profileDir / downloadDir / networkBuffer）；
 *   - 浏览器正在跑时保存「要重启才生效」的键，提示写进 transcript。
 *
 * 假 harness 照抄 `wiring.spec.ts` 的思路，只留这五处用得到的挂载点与假连接；
 * `DSC_HOME` 在动态 import 之前指进临时目录，收尾恢复。
 *
 * @module @pneuma/browser/tests/w14-tail-gaps.spec
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-browser-w14-'))
const savedHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = HOME

const h = vi.hoisted(() => {
  type Handler = (params: Record<string, any>) => void

  /** 一个页面 session：命令记到连接上，事件由测试手动推。 */
  class FakeSession {
    readonly handlers = new Map<string, Set<Handler>>()
    constructor(
      readonly sessionId: string,
      private readonly transport: FakeTransport,
    ) {}

    send<T = unknown>(method: string, params: Record<string, any> = {}): Promise<T> {
      return this.transport.send<T>(method, params, this.sessionId)
    }

    on(method: string, handler: Handler): () => void {
      let set = this.handlers.get(method)
      if (set === undefined) {
        set = new Set()
        this.handlers.set(method, set)
      }
      set.add(handler)
      return () => {
        set!.delete(handler)
      }
    }

    emit(method: string, params: Record<string, any> = {}): void {
      for (const handler of [...(this.handlers.get(method) ?? [])]) handler(params)
    }

    get connection(): FakeTransport {
      return this.transport
    }
  }

  /** 浏览器级连接 + 会话表：只实现本 spec 用得到的命令。 */
  class FakeTransport {
    closed = false
    readonly calls: Array<{ method: string; params: Record<string, any>; sessionId?: string }> = []
    readonly responders = new Map<string, (params: Record<string, any>) => unknown>()
    readonly sessions = new Map<string, FakeSession>()
    targets: Array<Record<string, any>> = [{ targetId: 't1', type: 'page', title: '首页', url: 'https://example.com/' }]
    pageUrl = 'https://example.com/'
    pageTitle = '示例页'
    readyState = 'complete'

    constructor() {
      const plain = (): Record<string, never> => ({})
      for (const method of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'Accessibility.enable', 'Network.enable']) {
        this.responders.set(method, plain)
      }
      this.responders.set('Target.getTargets', () => ({ targetInfos: this.targets }))
      this.responders.set('Target.attachToTarget', () => ({ sessionId: 'S1' }))
      this.responders.set('Accessibility.getFullAXTree', () => ({ nodes: [] }))
      this.responders.set('Runtime.evaluate', () => ({
        result: { value: { url: this.pageUrl, title: this.pageTitle, readyState: this.readyState } },
      }))
    }

    send<T = unknown>(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<T> {
      this.calls.push({ method, params, ...(sessionId === undefined ? {} : { sessionId }) })
      const responder = this.responders.get(method)
      if (responder === undefined) return Promise.reject(new Error(`假连接没有 ${method} 的应答`))
      try {
        return Promise.resolve(responder(params) as T)
      } catch (error) {
        return Promise.reject(error)
      }
    }

    session(sessionId: string): FakeSession {
      let found = this.sessions.get(sessionId)
      if (found === undefined) {
        found = new FakeSession(sessionId, this)
        this.sessions.set(sessionId, found)
      }
      return found
    }

    sent(method: string): Array<{ method: string; params: Record<string, any>; sessionId?: string }> {
      return this.calls.filter((call) => call.method === method)
    }

    close(): void {
      this.closed = true
    }
  }

  /** 不碰真进程的 BrowserProcess：`plan` 里排好的假连接按次取，取完就用默认那条。 */
  class FakeBrowserProcess {
    static instances: FakeBrowserProcess[] = []
    alive = false
    profileDir: string | null = null
    executable: string | null = null
    pid: number | null = null
    readonly transports: FakeTransport[] = [new FakeTransport()]
    /** 逐次消费的连接队列（测「连接换了」用）。 */
    readonly plan: FakeTransport[] = []
    lastTransport: FakeTransport | null = null

    constructor(readonly readConfig: () => Record<string, any>) {
      FakeBrowserProcess.instances.push(this)
    }

    async browserTransport(): Promise<FakeTransport> {
      const transport = this.plan.shift() ?? this.transports[0]!
      this.lastTransport = transport
      this.alive = true
      this.pid = 4321
      this.profileDir = 'C:\\tmp\\dsc-browser-fake'
      this.executable = 'C:\\fake\\chrome.exe'
      return transport
    }

    close(): void {
      this.alive = false
      this.lastTransport?.close()
    }

    shutdown(): void {
      this.alive = false
      this.lastTransport?.close()
    }
  }

  return { FakeSession, FakeTransport, FakeBrowserProcess }
})

vi.mock('@pneuma/cdp/launch.js', () => ({
  BrowserProcess: h.FakeBrowserProcess,
  probeExecutable: () => 'C:\\fake\\chrome.exe',
}))

type BrowserIndex = typeof import('../index.js')
let browserPlugin: BrowserIndex['browserPlugin']

beforeAll(async () => {
  browserPlugin = (await import('../index.js')).browserPlugin
})

beforeEach(() => {
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
  h.FakeBrowserProcess.instances.length = 0
})

const harnesses: Harness[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    try {
      harness.dispose()
    } catch {
      // 已经收过了
    }
  }
})

afterAll(() => {
  if (savedHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = savedHome
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 偶发 EPERM：留给系统清
  }
})

interface AnyTool {
  name: string
  run: (args: Record<string, any>, ctx: Record<string, any>) => Promise<any>
}

interface Harness {
  tools: AnyTool[]
  sections: Array<Record<string, any>>
  notices: string[]
  process: () => InstanceType<typeof h.FakeBrowserProcess>
  dispose: () => void
}

/** 假 ctx：只收 apply 会调的挂载点。 */
function makeHarness(config: Record<string, unknown> = {}): Harness {
  const tools: AnyTool[] = []
  const sections: Array<Record<string, any>> = []
  const notices: string[] = []
  const effects: Array<() => void> = []
  const ctx = {
    effect(fn: () => unknown) {
      const result = fn()
      if (typeof result === 'function') effects.push(result as () => void)
      return () => undefined
    },
    tools: {
      register(tool: AnyTool) {
        tools.push(tool)
        return () => undefined
      },
    },
    guards: { register: () => () => undefined },
    prompt: { register: () => () => undefined },
    commands: { register: () => () => undefined },
    settings: {
      registerSection(section: Record<string, any>) {
        sections.push(section)
        return () => undefined
      },
    },
    transcript: {
      system(text: string) {
        notices.push(text)
      },
    },
    on: () => () => undefined,
  }
  const cleanup = browserPlugin.apply(ctx as never, config) as unknown as (() => void) | undefined
  let disposed = false
  const harness: Harness = {
    tools,
    sections,
    notices,
    process: () => h.FakeBrowserProcess.instances.at(-1)!,
    dispose: () => {
      if (disposed) return
      disposed = true
      if (typeof cleanup === 'function') cleanup()
    },
  }
  harnesses.push(harness)
  return harness
}

const runCtx = (): Record<string, any> => ({
  cwd: HOME,
  signal: new AbortController().signal,
  sessionId: 'sess-1',
  sessionPath: join(HOME, 'sessions', 'a.jsonl'),
})

const runTool = (harness: Harness, name: string, args: Record<string, any>): Promise<any> => {
  const tool = harness.tools.find((entry) => entry.name === name)
  if (tool === undefined) throw new Error(`没有注册工具 ${name}`)
  return tool.run(args, runCtx())
}

const transportOf = (harness: Harness): InstanceType<typeof h.FakeTransport> => harness.process().lastTransport!

describe('相对地址拼不到当前页', () => {
  test('当前页地址本身不合法时，navigate 给的错点名两边地址且不发 Page.navigate', async () => {
    const harness = makeHarness()
    await runTool(harness, 'browser_look', { action: 'snapshot' })
    const transport = transportOf(harness)
    transport.pageUrl = 'not a url'
    await expect(runTool(harness, 'browser', { action: 'navigate', url: '/next' })).rejects.toThrow(
      /相对地址「\/next」拼不到当前页面 not a url 上/,
    )
    expect(transport.sent('Page.navigate')).toHaveLength(0)
  })
})

describe('自动对话框策略失败', () => {
  test('auto_accept 处理失败时 transcript 记下原因，不抛出', async () => {
    const harness = makeHarness({ dialogPolicy: 'auto_accept' })
    await runTool(harness, 'browser_look', { action: 'snapshot' })
    const transport = transportOf(harness)
    transport.responders.delete('Page.handleJavaScriptDialog')
    transport.session('S1').emit('Page.javascriptDialogOpening', { type: 'confirm', message: '接受吗' })
    await vi.waitFor(() => {
      expect(harness.notices.join('\n')).toContain('[browser] 自动接受对话框失败')
    })
    expect(harness.notices.join('\n')).toContain('假连接没有 Page.handleJavaScriptDialog 的应答')
  })

  test('auto_dismiss 处理失败时文案是「关掉」', async () => {
    const harness = makeHarness({ dialogPolicy: 'auto_dismiss' })
    await runTool(harness, 'browser_look', { action: 'snapshot' })
    const transport = transportOf(harness)
    transport.responders.delete('Page.handleJavaScriptDialog')
    transport.session('S1').emit('Page.javascriptDialogOpening', { type: 'alert', message: '关掉吗' })
    await vi.waitFor(() => {
      expect(harness.notices.join('\n')).toContain('[browser] 自动关掉对话框失败')
    })
  })
})

describe('frame 切回主标签页', () => {
  test('主标签页所在连接已经被换掉时拒绝，并说清先做一步操作', async () => {
    const harness = makeHarness()
    await runTool(harness, 'browser_look', { action: 'snapshot' })
    const first = transportOf(harness)
    // 排两个连接：ensurePage 拿到与主标签页同一条（直接复用），frame 里的 ensureBrowser 拿到新的一条。
    harness.process().plan.push(first, new h.FakeTransport())
    await expect(runTool(harness, 'browser', { action: 'frame' })).rejects.toThrow(/还没附加到主标签页，先随便做一步操作/)
  })
})

describe('设置分区 save 的文本与数字键', () => {
  test('executablePath / profileDir / downloadDir 去掉首尾空格；networkBuffer 数字夹取后落盘', async () => {
    const harness = makeHarness({})
    const section = harness.sections[0] as any
    expect(section.save('executablePath', '  C:/x/chrome.exe  ')).toBeUndefined()
    expect(section.save('profileDir', '  C:/prof  ')).toBeUndefined()
    expect(section.save('downloadDir', '  C:/dl  ')).toBeUndefined()
    expect(section.save('networkBuffer', 5)).toBeUndefined()
    expect(section.values()).toMatchObject({
      executablePath: 'C:/x/chrome.exe',
      profileDir: 'C:/prof',
      downloadDir: 'C:/dl',
      networkBuffer: 5,
    })
  })
})

describe('浏览器在跑时保存要重启的键', () => {
  test('headless 改变时提示重启才生效', async () => {
    const harness = makeHarness({})
    await runTool(harness, 'browser_look', { action: 'tabs' })
    expect(harness.process().alive).toBe(true)
    const section = harness.sections[0] as any
    expect(section.save('headless', false)).toBeUndefined()
    expect(harness.notices.join('\n')).toContain('这项要重启受控浏览器才生效')
  })
})
