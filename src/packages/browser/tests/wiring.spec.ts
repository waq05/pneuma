/**
 * browser 插件装配面（`packages/browser/index.ts`）：两个工具、守卫、提示词、命令、
 * 设置分区、会话事件与收尾。
 *
 * 假 ctx 只收挂载点；真浏览器换成假 `BrowserProcess` + 假 `CdpTransport`
 * （`@pneuma/cdp/launch.js` 被 `vi.mock` 替换）。动作层（`@pneuma/cdp/actions.js`）用真实现，
 * 所以每条工具调用都能落到「假 transport 收到了哪条 CDP 命令、参数是什么」上，
 * 而不是只断言插件调了一个同名函数。
 *
 * `DSC_HOME` 在任何 import 之前指进临时目录（插件配置路径在模块求值时算定）。
 *
 * @module dsc/packages/browser/tests/wiring.spec
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-browser-wiring-'))
process.env['DSC_HOME'] = HOME
const WORK = mkdtempSync(join(tmpdir(), 'dsc-browser-work-'))

/**
 * 假连接/假进程。放在 `vi.hoisted` 里是因为 `vi.mock` 的工厂会被提到 import 之前，
 * 工厂里不能引用模块级的普通变量。
 */
const h = vi.hoisted(() => {
  type Responder = (params: Record<string, any>, session: FakeSession | null) => any

  /** 一个页面/框架 session：命令记到 transport 上，事件可以手动推。 */
  class FakeSession {
    readonly handlers = new Map<string, Set<(params: Record<string, any>) => void>>()
    constructor(
      readonly sessionId: string,
      private readonly transport: FakeTransport,
    ) {}

    send<T = unknown>(method: string, params: Record<string, any> = {}): Promise<T> {
      return this.transport.send<T>(method, params, { sessionId: this.sessionId })
    }

    on(method: string, handler: (params: Record<string, any>) => void): () => void {
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

    listenerCount(method: string): number {
      return this.handlers.get(method)?.size ?? 0
    }

    get connection(): FakeTransport {
      return this.transport
    }
  }

  /** 浏览器级连接 + 会话表。只实现插件与 actions.ts 用得到的那些方法。 */
  class FakeTransport {
    closed = false
    readonly calls: Array<{ method: string; params: Record<string, any>; sessionId?: string }> = []
    readonly sessions = new Map<string, FakeSession>()
    readonly responders = new Map<string, Responder>()
    /** 页面目标清单（Target.getTargets）。 */
    targets: Array<Record<string, any>> = [
      { targetId: 't1', type: 'page', title: '首页', url: 'https://example.com/' },
    ]
    axTree: Record<string, any> = {
      nodes: [
        { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: '示例页' }, childIds: ['n1', 'n2'] },
        { nodeId: 'n1', parentId: 'root', role: { value: 'button' }, name: { value: '提交' }, backendDOMNodeId: 42 },
        { nodeId: 'n2', parentId: 'root', role: { value: 'textbox' }, name: { value: '邮箱' }, backendDOMNodeId: 43 },
      ],
    }
    nodes = new Map<number, { role: string; name: string; disabled?: boolean }>([
      [42, { role: 'button', name: '提交' }],
      [43, { role: 'textbox', name: '邮箱' }],
    ])
    sessionIds: Record<string, string> = { t1: 'S1', t2: 'S2' }
    pageUrl = 'https://example.com/'
    pageTitle = '示例页'
    readyState = 'complete'
    waitMatched = true
    evaluateValue: unknown = { ok: true }
    evaluateThrows = false
    screenshotData = 'iVBORw0KGgo='
    navigateErrorText = ''
    redirectTo = ''
    downloadFailure = ''
    mainFrame = 'MAIN'

    constructor() {
      const plain = (): Record<string, never> => ({})
      for (const method of [
        'Page.enable',
        'Runtime.enable',
        'DOM.enable',
        'Accessibility.enable',
        'Network.enable',
        'Input.dispatchMouseEvent',
        'Input.dispatchKeyEvent',
        'Input.insertText',
        'DOM.focus',
        'DOM.scrollIntoViewIfNeeded',
        'DOM.setFileInputFiles',
        'Page.handleJavaScriptDialog',
      ]) {
        this.responders.set(method, plain)
      }
      this.responders.set('Target.getTargets', () => ({ targetInfos: this.targets }))
      this.responders.set('Target.attachToTarget', (params) => {
        const targetId = String(params['targetId'] ?? '')
        return { sessionId: this.sessionIds[targetId] ?? `S-${targetId}` }
      })
      this.responders.set('Target.createTarget', () => ({ targetId: 't-new' }))
      this.responders.set('Browser.setDownloadBehavior', () => {
        if (this.downloadFailure !== '') throw new Error(this.downloadFailure)
        return {}
      })
      this.responders.set('Accessibility.getFullAXTree', () => this.axTree)
      this.responders.set('Accessibility.getPartialAXTree', (params) => {
        const backendNodeId = Number(params['backendNodeId'])
        const node = this.nodes.get(backendNodeId)
        if (node === undefined) throw new Error('拿不到无障碍节点')
        return {
          nodes: [
            {
              backendNodeId,
              role: { value: node.role },
              name: { value: node.name },
              ...(node.disabled === true
                ? { properties: [{ name: 'disabled', value: { value: true } }] }
                : {}),
            },
          ],
        }
      })
      this.responders.set('DOM.describeNode', (params) => {
        const backendNodeId = Number(params['backendNodeId'])
        if (!this.nodes.has(backendNodeId)) throw new Error('这个后端节点已经不在了')
        return { node: { backendNodeId } }
      })
      this.responders.set('DOM.getBoxModel', () => ({ model: { content: [10, 20, 110, 20, 110, 70, 10, 70] } }))
      this.responders.set('DOM.resolveNode', () => ({ object: { objectId: 'obj-1' } }))
      this.responders.set('Page.getLayoutMetrics', () => ({ cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }))
      this.responders.set('Page.captureScreenshot', () => ({ data: this.screenshotData }))
      this.responders.set('Page.getFrameTree', () => ({ frameTree: { frame: { id: this.mainFrame } } }))
      this.responders.set('Page.navigate', (params) => {
        if (this.navigateErrorText !== '') return { errorText: this.navigateErrorText }
        this.pageUrl = this.redirectTo !== '' ? this.redirectTo : String(params['url'] ?? '')
        return { frameId: 'F1' }
      })
      this.responders.set('Runtime.callFunctionOn', (params) => {
        const args = params['arguments'] as Array<{ value?: unknown }> | undefined
        return { result: { value: args?.[0]?.value ?? [] } }
      })
      this.responders.set('Runtime.evaluate', (params) => {
        const expression = String(params['expression'] ?? '')
        if (expression.includes('location.href')) {
          return { result: { value: { url: this.pageUrl, title: this.pageTitle, readyState: this.readyState } } }
        }
        if (expression.includes('innerText.includes') || expression.includes('querySelector')) {
          return { result: { value: this.waitMatched } }
        }
        if (expression.includes('window.scrollTo')) return { result: { value: 0 } }
        if (this.evaluateThrows) {
          return { exceptionDetails: { exception: { description: 'ReferenceError: x is not defined\n    at <anonymous>:1:1' } } }
        }
        return { result: { value: this.evaluateValue } }
      })
    }

    respond(method: string, fn: Responder): void {
      this.responders.set(method, fn)
    }

    send<T = unknown>(method: string, params: Record<string, any> = {}, options: { sessionId?: string } = {}): Promise<T> {
      this.calls.push({ method, params, sessionId: options.sessionId })
      const responder = this.responders.get(method)
      if (responder === undefined) return Promise.reject(new Error(`假连接没有 ${method} 的应答`))
      try {
        const session = options.sessionId === undefined ? null : this.session(options.sessionId)
        return Promise.resolve(responder(params, session) as T)
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

    methods(): string[] {
      return this.calls.map((call) => call.method)
    }
  }

  /** 一个不碰真进程的 BrowserProcess：首次调用即「启动」，close/shutdown 只记账。 */
  class FakeBrowserProcess {
    static instances: FakeBrowserProcess[] = []
    alive = false
    profileDir: string | null = null
    executable: string | null = null
    pid: number | null = null
    closeCalls = 0
    shutdownCalls = 0
    configs: Array<Record<string, any>> = []
    readonly transport = new FakeTransport()

    constructor(readonly readConfig: () => Record<string, any>) {
      FakeBrowserProcess.instances.push(this)
    }

    async browserTransport(_signal?: AbortSignal): Promise<FakeTransport> {
      if (this.shutdownCalls > 0) throw new Error('受控浏览器已被关掉；下一次调用工具会自动重开')
      const config = this.readConfig()
      this.configs.push(config)
      this.alive = true
      this.executable = String(config['executablePath'] ?? '') === '' ? 'C:\\fake\\chrome.exe' : String(config['executablePath'])
      this.profileDir =
        String(config['profileDir'] ?? '') === '' ? 'C:\\tmp\\dsc-browser-fake' : String(config['profileDir'])
      this.pid = 4321
      this.transport.closed = false
      return this.transport
    }

    close(): void {
      this.closeCalls += 1
      this.alive = false
      this.transport.closed = true
    }

    shutdown(): void {
      this.shutdownCalls += 1
      this.alive = false
      this.transport.closed = true
    }
  }

  return {
    FakeSession,
    FakeTransport,
    FakeBrowserProcess,
    probe: { result: 'C:\\fake\\chrome.exe' as string | null, calls: [] as unknown[] },
  }
})

vi.mock('@pneuma/cdp/launch.js', () => ({
  BrowserProcess: h.FakeBrowserProcess,
  probeExecutable: (config: unknown) => {
    h.probe.calls.push(config)
    return h.probe.result
  },
}))

type BrowserIndex = typeof import('../index.js')
let browserPlugin: BrowserIndex['browserPlugin']

beforeAll(async () => {
  browserPlugin = (await import('../index.js')).browserPlugin
  writeFileSync(join(WORK, 'ok.txt'), 'hello', 'utf8')
  writeFileSync(join(WORK, '.env'), 'SECRET=1', 'utf8')
})

beforeEach(() => {
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
  h.FakeBrowserProcess.instances.length = 0
  h.probe.result = 'C:\\fake\\chrome.exe'
  h.probe.calls.length = 0
})

const harnesses: Harness[] = []

afterEach(() => {
  // 未处理的对话框定时器最长 300s：每个用例收尾时统一 dispose 掉。
  for (const harness of harnesses.splice(0)) {
    try {
      harness.dispose()
    } catch {
      // 已经收过了
    }
  }
})

afterAll(() => {
  delete process.env['DSC_HOME']
  for (const dir of [HOME, WORK]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows 上偶发 EPERM：临时目录留给系统清，不让收尾拖红测试
    }
  }
})

interface AnyTool {
  name: string
  risk: string
  parameters: Record<string, any>
  run: (args: Record<string, any>, ctx: Record<string, any>) => Promise<any>
}

interface Harness {
  tools: AnyTool[]
  guards: Array<{ id: string; order: number; decide: (input: Record<string, any>) => any }>
  projections: Array<{ id: string; fn: () => string }>
  commands: Array<{ spec: { name: string; args?: string; description?: string }; run: (args: any) => void }>
  sections: Array<Record<string, any>>
  notices: string[]
  listeners: Map<string, (...args: any[]) => void>
  effects: Array<() => void>
  counts: { tool: number; guard: number; prompt: number; command: number; section: number; sessionOpen: number; exit: number }
  process: () => any
  dispose: () => void
}

/** 假 ctx：记录挂载点，注册返回带计数的退订函数。 */
function makeHarness(config: Record<string, unknown> = {}): Harness {
  const tools: AnyTool[] = []
  const guards: Harness['guards'] = []
  const projections: Harness['projections'] = []
  const commands: Harness['commands'] = []
  const sections: Array<Record<string, any>> = []
  const notices: string[] = []
  const listeners = new Map<string, (...args: any[]) => void>()
  const effects: Array<() => void> = []
  const counts = { tool: 0, guard: 0, prompt: 0, command: 0, section: 0, sessionOpen: 0, exit: 0 }
  const tracker = (key: keyof typeof counts) => () => {
    counts[key] += 1
  }
  const ctx = {
    effect(fn: () => unknown) {
      const result = fn()
      if (typeof result === 'function') effects.push(result as () => void)
      return () => undefined
    },
    tools: {
      register(tool: AnyTool) {
        tools.push(tool)
        return tracker('tool')
      },
    },
    guards: {
      register(guard: Harness['guards'][number]) {
        guards.push(guard)
        return tracker('guard')
      },
    },
    prompt: {
      register(id: string, fn: () => string) {
        projections.push({ id, fn })
        return tracker('prompt')
      },
    },
    commands: {
      register(spec: Harness['commands'][number]['spec'], run: Harness['commands'][number]['run']) {
        commands.push({ spec, run })
        return tracker('command')
      },
    },
    settings: {
      registerSection(section: Record<string, any>) {
        sections.push(section)
        return tracker('section')
      },
    },
    transcript: {
      system(text: string) {
        notices.push(text)
      },
    },
    on(event: string, handler: (...args: any[]) => void) {
      listeners.set(event, handler)
      return tracker(event === 'dsc/exit' ? 'exit' : 'sessionOpen')
    },
  }
  const cleanup = browserPlugin.apply(ctx as never, config) as unknown as (() => void) | undefined
  let disposed = false
  const harness: Harness = {
    tools,
    guards,
    projections,
    commands,
    sections,
    notices,
    listeners,
    effects,
    counts,
    process: () => h.FakeBrowserProcess.instances.at(-1),
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
  cwd: WORK,
  signal: new AbortController().signal,
  sessionId: 'sess-1',
  sessionPath: join(WORK, 'sessions', 'a.jsonl'),
})

const tool = (harness: Harness, name: string): AnyTool => {
  const found = harness.tools.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`没有注册工具 ${name}`)
  return found
}

const runTool = (harness: Harness, name: string, args: Record<string, any>): Promise<any> =>
  tool(harness, name).run(args, runCtx())

const textOf = (value: any): string => (typeof value === 'string' ? value : String(value?.text ?? ''))

/** report() 的第二行是结构化 JSON。 */
const jsonOf = (value: any): Record<string, any> => {
  const line = textOf(value)
    .split('\n')
    .find((entry) => entry.startsWith('{'))
  if (line === undefined) throw new Error(`结果里没有 JSON 行：${textOf(value)}`)
  return JSON.parse(line) as Record<string, any>
}

const transportOf = (harness: Harness): any => harness.process().transport

const guardInput = (args: Record<string, any>, toolName = 'browser'): Record<string, any> => ({
  toolName,
  args,
  cwd: WORK,
  sessionId: 'sess-1',
})

const snapshot = (harness: Harness, extra: Record<string, any> = {}): Promise<any> =>
  runTool(harness, 'browser_look', { action: 'snapshot', ...extra })

describe('注册与生命周期', () => {
  test('两个工具、守卫、提示词、命令、设置分区都挂上了（参数面完整）', () => {
    const harness = makeHarness()
    expect(harness.tools.map((entry) => `${entry.name}:${entry.risk}`)).toEqual(['browser:exec', 'browser_look:read'])
    expect(harness.guards[0]).toMatchObject({ id: 'browser', order: 20 })
    expect(harness.projections).toHaveLength(1)
    expect(harness.projections[0]!.id).toBe('browser')
    expect(harness.commands[0]!.spec.name).toBe('browser')
    expect(harness.sections[0]).toMatchObject({ id: 'browser', order: 34 })
    expect(harness.sections[0]!.groups).toHaveLength(4)
    expect([...harness.listeners.keys()].sort()).toEqual(['dsc/exit', 'dsc/session-open'])

    const look = tool(harness, 'browser_look')
    expect(look.parameters.required).toEqual(['action'])
    expect(look.parameters.properties.action.enum).toEqual([
      'snapshot',
      'screenshot',
      'console',
      'network',
      'tabs',
      'wait_for',
    ])
    const act = tool(harness, 'browser')
    expect(act.parameters.required).toEqual(['action'])
    for (const action of ['navigate', 'click', 'type', 'evaluate', 'frame', 'close']) {
      expect(act.parameters.properties.action.enum).toContain(action)
    }
    expect(act.parameters.properties.fields.items.required).toEqual(['ref', 'value'])
    expect(harness.projections[0]!.fn()).toContain('受控浏览器（DOM 级）')
  })

  test('disposer 逐个调用退订，并 shutdown 受控浏览器', async () => {
    const harness = makeHarness()
    await runTool(harness, 'browser_look', { action: 'tabs' })
    const proc = harness.process()
    harness.dispose()
    expect(harness.counts).toEqual({ tool: 2, guard: 1, prompt: 1, command: 1, section: 1, sessionOpen: 1, exit: 1 })
    expect(harness.effects).toHaveLength(6)
    expect(proc.shutdownCalls).toBe(1)
  })

  test('设置分区 values 反映夹取后的配置，fields 带出探测结果与运行状态', async () => {
    const harness = makeHarness({
      headless: false,
      executablePath: '  C:/x/chrome.exe  ',
      profileDir: '',
      allowedDomains: 'example.com',
      maxSnapshotChars: 100,
      dialogPolicy: 'auto_accept',
      enableEvaluate: false,
      downloadDir: ' C:/dl ',
      waitTimeoutMs: 100,
      consoleBuffer: 9999,
      networkBuffer: 9999,
    })
    const section = harness.sections[0] as any
    expect(section.values()).toEqual({
      headless: false,
      executablePath: 'C:/x/chrome.exe',
      profileDir: '',
      allowedDomains: 'example.com',
      maxSnapshotChars: 500,
      dialogPolicy: 'auto_accept',
      enableEvaluate: false,
      downloadDir: 'C:/dl',
      waitTimeoutMs: 500,
      consoleBuffer: 2000,
      networkBuffer: 2000,
    })
    const fields = section.fields() as Array<Record<string, any>>
    expect(fields).toHaveLength(15)
    expect(fields.map((field) => field.key).filter((key) => key !== undefined)).toEqual([
      'headless',
      'executablePath',
      'profileDir',
      'allowedDomains',
      'maxSnapshotChars',
      'dialogPolicy',
      'enableEvaluate',
      'downloadDir',
      'waitTimeoutMs',
      'consoleBuffer',
      'networkBuffer',
    ])
    expect(h.probe.calls).toHaveLength(1)
    expect(fields.find((field) => field.type === 'info' && field.group === 'startup')?.text).toBe('C:\\fake\\chrome.exe')

    await runTool(harness, 'browser_look', { action: 'tabs' })
    const after = section.fields() as Array<Record<string, any>>
    expect(after.find((field) => field.type === 'info' && field.group === 'status')?.text).toContain('4321')
  })
})

describe('browser_look', () => {
  test('未知 action 与 close 的落点：两条工具各自列出可用动作', async () => {
    const harness = makeHarness()
    await expect(runTool(harness, 'browser_look', { action: 'dance' })).rejects.toThrow(
      /未知 action：dance。可用：snapshot \/ screenshot \/ console \/ network \/ tabs \/ wait_for/,
    )
    // lookActions 里没有 close，所以这里走的是「未知 action」而不是后面那句专门文案。
    await expect(runTool(harness, 'browser_look', { action: 'close' })).rejects.toThrow(/未知 action：close/)
    await expect(runTool(harness, 'browser', { action: 'dance' })).rejects.toThrow(/未知 action：dance。可用：navigate/)
    await expect(runTool(harness, 'browser', { action: '' })).rejects.toThrow(/未知 action：\(空\)/)
  })

  test('snapshot 生成 ref 并附带围栏文本；重复调用复用同一 session', async () => {
    const harness = makeHarness()
    const output = await snapshot(harness)
    const transport = transportOf(harness)
    expect(transport.sent('Accessibility.getFullAXTree')).toEqual([
      expect.objectContaining({ params: { depth: -1 }, sessionId: 'S1' }),
    ])
    expect(jsonOf(output)).toMatchObject({
      action: 'snapshot',
      url: 'https://example.com/',
      interactive: 2,
      refs: 2,
      lines: 2,
      truncated: false,
    })
    expect(textOf(output)).toContain('<external_content source="browser">')
    expect(textOf(output)).toContain('[ref=e1]')
    expect(textOf(output)).toContain('- button "提交"')

    await snapshot(harness)
    expect(transport.sent('Target.attachToTarget')).toHaveLength(1)
    expect(transport.sent('Accessibility.getFullAXTree')).toHaveLength(2)
  })

  test('snapshot maxChars 触发按行截断，完整树视图给不同页眉', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    const transport = transportOf(harness)
    transport.axTree = {
      nodes: Array.from({ length: 40 }, (_unused, index) => ({
        nodeId: `n${String(index)}`,
        role: { value: 'button' },
        name: { value: `按钮${String(index)}` },
        backendDOMNodeId: 100 + index,
      })),
    }
    const truncated = await snapshot(harness, { maxChars: 500 })
    expect(jsonOf(truncated).truncated).toBe(true)
    expect(textOf(truncated)).toContain('还有')

    const full = await snapshot(harness, { full: true })
    expect(jsonOf(full).action).toBe('snapshot')
    expect(textOf(full)).toContain('完整树')
  })

  test('没有页面目标时新建 about:blank 并附加到新 session', async () => {
    const harness = makeHarness()
    await runTool(harness, 'browser_look', { action: 'tabs' })
    const transport = transportOf(harness)
    transport.targets = []
    const output = await snapshot(harness)
    expect(transport.sent('Target.createTarget')[0]!.params).toEqual({ url: 'about:blank' })
    expect(transport.sent('Accessibility.getFullAXTree').at(-1)!.sessionId).toBe('S-t-new')
    expect(jsonOf(output).action).toBe('snapshot')
  })

  test('screenshot 转发 Page.captureScreenshot；拿不到数据时给人话', async () => {
    const harness = makeHarness()
    const output = await runTool(harness, 'browser_look', { action: 'screenshot', fullPage: true })
    const transport = transportOf(harness)
    expect(transport.sent('Page.captureScreenshot')[0]!.params).toEqual({ format: 'png', captureBeyondViewport: true })
    expect(output.images).toEqual(['data:image/png;base64,iVBORw0KGgo='])
    expect(jsonOf(output)).toMatchObject({ action: 'screenshot', fullPage: true, url: 'https://example.com/' })

    const broken = makeHarness()
    await runTool(broken, 'browser_look', { action: 'tabs' })
    transportOf(broken).screenshotData = ''
    await expect(runTool(broken, 'browser_look', { action: 'screenshot' })).rejects.toThrow(/没返回图像数据/)
  })

  test('console：事件进环形缓冲、异常另起级别、clear 清空', async () => {
    const harness = makeHarness({ consoleBuffer: 2 })
    await snapshot(harness)
    const session = transportOf(harness).session('S1')
    session.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: '第一条' }] })
    session.emit('Runtime.consoleAPICalled', { type: 'warn', args: [{ value: '第二条' }] })
    session.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: '第三条' }] })

    const output = await runTool(harness, 'browser_look', { action: 'console' })
    expect(jsonOf(output)).toMatchObject({ action: 'console', count: 2, cleared: false })
    expect(textOf(output)).not.toContain('第一条')
    expect(textOf(output)).toContain('log: 第三条')

    session.emit('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'Error: boom' } } })
    const withException = await runTool(harness, 'browser_look', { action: 'console' })
    expect(textOf(withException)).toContain('exception: Error: boom')

    const cleared = await runTool(harness, 'browser_look', { action: 'console', clear: true })
    expect(jsonOf(cleared)).toMatchObject({ action: 'console', count: 2, cleared: true })
    expect(textOf(await runTool(harness, 'browser_look', { action: 'console' }))).toContain('控制台还没有输出')
  })

  test('network：请求/响应/失败按 requestId 回填，clear 清空', async () => {
    const harness = makeHarness({ networkBuffer: 2 })
    await snapshot(harness)
    const session = transportOf(harness).session('S1')
    session.emit('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://a.test/x', method: 'GET' } })
    session.emit('Network.responseReceived', { requestId: 'r1', response: { status: 200, mimeType: 'text/html' } })
    session.emit('Network.requestWillBeSent', { requestId: 'r2', request: { url: 'https://a.test/y', method: 'POST' } })
    session.emit('Network.loadingFailed', { requestId: 'r2', errorText: 'net::ERR_FAILED' })

    const output = await runTool(harness, 'browser_look', { action: 'network' })
    expect(jsonOf(output)).toMatchObject({ action: 'network', count: 2, cleared: false })
    expect(textOf(output)).toContain('GET 200 text/html https://a.test/x')
    expect(textOf(output)).toContain('POST 失败：net::ERR_FAILED https://a.test/y')

    await runTool(harness, 'browser_look', { action: 'network', clear: true })
    expect(textOf(await runTool(harness, 'browser_look', { action: 'network' }))).toContain('还没有记录到网络请求')
  })

  test('tabs 标出当前目标；一个目标都没有时直接报错', async () => {
    const harness = makeHarness()
    const before = await runTool(harness, 'browser_look', { action: 'tabs' })
    expect(jsonOf(before)).toMatchObject({ action: 'tabs', count: 1, current: '' })
    expect(textOf(before)).toContain('[targetId=t1]')

    await snapshot(harness)
    const after = await runTool(harness, 'browser_look', { action: 'tabs' })
    expect(jsonOf(after).current).toBe('t1')
    expect(textOf(after)).toContain('* page')

    transportOf(harness).targets = []
    await expect(runTool(harness, 'browser_look', { action: 'tabs' })).rejects.toThrow(/一个页面目标都没有/)
  })

  test('wait_for：text/selector 二选一，成功与超时各有文案', async () => {
    const harness = makeHarness({ waitTimeoutMs: 500 })
    await expect(runTool(harness, 'browser_look', { action: 'wait_for' })).rejects.toThrow(/需要 text 或 selector/)
    const ok = await runTool(harness, 'browser_look', { action: 'wait_for', selector: '#ok' })
    expect(jsonOf(ok)).toMatchObject({ action: 'wait_for' })
    expect(typeof jsonOf(ok).waitedMs).toBe('number')

    const miss = makeHarness({ waitTimeoutMs: 500 })
    await runTool(miss, 'browser_look', { action: 'tabs' })
    transportOf(miss).waitMatched = false
    await expect(
      runTool(miss, 'browser_look', { action: 'wait_for', text: '不会出现', timeoutMs: 100 }),
    ).rejects.toThrow(/等了 100ms 也没等到 文本「不会出现」/)
  })

  test('downloadDir 非空时设下载行为；设不上只记通知不影响快照', async () => {
    const harness = makeHarness({ downloadDir: 'C:\\dl' })
    await snapshot(harness)
    expect(transportOf(harness).sent('Browser.setDownloadBehavior')).toEqual([
      expect.objectContaining({
        params: { behavior: 'allow', downloadPath: 'C:\\dl', eventsEnabled: false },
        sessionId: undefined,
      }),
    ])

    const failing = makeHarness({ downloadDir: 'C:\\dl' })
    await runTool(failing, 'browser_look', { action: 'tabs' })
    transportOf(failing).downloadFailure = '目录不可写'
    await expect(snapshot(failing)).resolves.toBeTruthy()
    expect(failing.notices.join('\n')).toContain('下载目录设不上')
  })
})

describe('地址闸门（工具面落点）', () => {
  test('守卫：只认两条工具，绝对地址按协议/私网/名单判定', () => {
    const harness = makeHarness({ allowedDomains: 'example.com\n!bad.example.com' })
    const guard = harness.guards[0]!
    expect(guard.decide(guardInput({ action: 'navigate' }, 'read'))).toEqual({ action: 'defer' })
    expect(guard.decide(guardInput({ action: 'click' }, 'browser_look'))).toEqual({ action: 'defer' })
    expect(guard.decide(guardInput({ action: 'navigate', url: '' }))).toEqual({
      action: 'deny',
      reason: 'navigate 需要一个 url',
    })
    // 相对地址留给动作层（它要知道当前页）
    expect(guard.decide(guardInput({ action: 'navigate', url: 'next' }))).toEqual({ action: 'defer' })

    const file = guard.decide(guardInput({ action: 'navigate', url: 'file:///etc/passwd' })) as any
    expect(file.action).toBe('deny')
    expect(file.reason).toContain('只允许 http/https')

    const local = guard.decide(guardInput({ action: 'navigate', url: 'http://127.0.0.1:8080/' })) as any
    expect(local.action).toBe('deny')
    expect(local.reason).toContain('私网/本机地址')

    const denied = guard.decide(guardInput({ action: 'navigate', url: 'https://bad.example.com/' })) as any
    expect(denied.action).toBe('deny')
    expect(denied.reason).toContain('命中拒绝名单')

    const outside = guard.decide(guardInput({ action: 'navigate', url: 'https://other.com/' })) as any
    expect(outside.action).toBe('deny')
    expect(outside.reason).toContain('不在允许名单')

    expect(guard.decide(guardInput({ action: 'navigate', url: 'https://ok.example.com/' }))).toEqual({ action: 'defer' })
    expect(guard.decide(guardInput({ action: 'click', ref: 'e1' }))).toEqual({ action: 'defer' })
  })

  test('守卫：evaluate 开关、敏感原语与表达式里的地址', () => {
    const disabled = makeHarness({ enableEvaluate: false })
    const refused = disabled.guards[0]!.decide(
      guardInput({ action: 'evaluate', expression: '1 + 1' }),
    ) as any
    expect(refused.action).toBe('deny')
    expect(refused.reason).toContain('关掉了')

    const harness = makeHarness()
    const guard = harness.guards[0]!
    const sensitive = guard.decide(guardInput({ action: 'evaluate', expression: "require('fs')" })) as any
    expect(sensitive.action).toBe('deny')
    expect(sensitive.reason).toContain('敏感原语')

    const privateUrl = guard.decide(
      guardInput({ action: 'evaluate', expression: "fetch('http://192.168.1.5/admin')" }),
    ) as any
    expect(privateUrl.action).toBe('deny')
    expect(privateUrl.reason).toContain('表达式里出现被拒的地址')

    expect(guard.decide(guardInput({ action: 'evaluate', expression: 'document.title' }))).toEqual({ action: 'defer' })
  })

  test('navigate 动作层拒绝非法地址，且不会发出 Page.navigate', async () => {
    const harness = makeHarness()
    await expect(runTool(harness, 'browser', { action: 'navigate', url: 'file:///etc/passwd' })).rejects.toThrow(
      /这一步被挡下了：只允许 http\/https/,
    )
    await expect(runTool(harness, 'browser', { action: 'navigate', url: 'http://10.0.0.8/' })).rejects.toThrow(
      /这一步被挡下了：私网\/本机地址/,
    )
    await expect(runTool(harness, 'browser', { action: 'navigate', url: '   ' })).rejects.toThrow(/需要一个 url/)
    expect(transportOf(harness).sent('Page.navigate')).toHaveLength(0)
  })

  test('navigate 成功：相对地址按当前页展开，落地后附简版快照', async () => {
    const harness = makeHarness()
    // 先起连接再改当前页（ensurePage 在 navigate 里第一个动作就是读当前页）
    await runTool(harness, 'browser_look', { action: 'tabs' })
    const transport = transportOf(harness)
    transport.pageUrl = 'https://example.com/a/b'
    const output = await runTool(harness, 'browser', { action: 'navigate', url: '../c?q=1' })
    expect(transport.sent('Page.navigate')[0]!.params).toEqual({ url: 'https://example.com/c?q=1' })
    expect(jsonOf(output)).toMatchObject({
      action: 'navigate',
      url: 'https://example.com/c?q=1',
      readyState: 'complete',
      interactive: 2,
    })
    expect(textOf(output)).toContain('已打开 https://example.com/c?q=1')
    expect(textOf(output)).toContain('<external_content source="browser">')
  })

  test('navigate 落地被重定向到私网：挪回 about:blank 并报错', async () => {
    const harness = makeHarness()
    await runTool(harness, 'browser_look', { action: 'tabs' })
    const transport = transportOf(harness)
    transport.redirectTo = 'http://192.168.1.9/admin'
    await expect(runTool(harness, 'browser', { action: 'navigate', url: 'https://example.com/' })).rejects.toThrow(
      /落地地址被拒（私网\/本机地址/,
    )
    expect(transport.sent('Page.navigate').map((call) => call.params['url'])).toEqual([
      'https://example.com/',
      'about:blank',
    ])
    expect(transport.sent('Accessibility.getFullAXTree')).toHaveLength(0)
  })

  test('navigate 失败文案带浏览器的 errorText', async () => {
    const harness = makeHarness()
    await runTool(harness, 'browser_look', { action: 'tabs' })
    transportOf(harness).navigateErrorText = 'net::ERR_NAME_NOT_RESOLVED'
    await expect(runTool(harness, 'browser', { action: 'navigate', url: 'https://nope.test/' })).rejects.toThrow(
      /打开 https:\/\/nope.test\/ 失败：net::ERR_NAME_NOT_RESOLVED/,
    )
  })

  test('相对地址没有当前页可依时给出可照做的错', async () => {
    const harness = makeHarness()
    await runTool(harness, 'browser_look', { action: 'tabs' })
    transportOf(harness).pageUrl = ''
    await expect(runTool(harness, 'browser', { action: 'navigate', url: 'next' })).rejects.toThrow(
      /没有已打开的页面可以让它相对/,
    )
  })
})

describe('ref 与动作转发', () => {
  test('click：复核 ref 后转发 moved/pressed/released，输出带坐标与地址', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    const transport = transportOf(harness)
    const output = await runTool(harness, 'browser', { action: 'click', ref: 'e1' })
    expect(jsonOf(output)).toMatchObject({ action: 'click', ref: 'e1', button: 'left', clicks: 1, url: 'https://example.com/' })
    expect(textOf(output)).toContain('已点击 ref「e1」（button "提交"）在 (60, 45)')
    expect(transport.sent('DOM.describeNode')[0]!.params).toEqual({ backendNodeId: 42 })
    expect(transport.sent('Input.dispatchMouseEvent').map((call) => call.params['type'])).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ])
    expect(transport.sent('Input.dispatchMouseEvent')[1]!.params).toMatchObject({ button: 'left', x: 60, y: 45, clickCount: 1 })
  })

  test('导航事件与文档替换会作废 ref，旧 ref 被拒且不转发点击', async () => {
    const first = makeHarness()
    await snapshot(first)
    const firstTransport = transportOf(first)
    firstTransport.session('S1').emit('Page.frameNavigated', { frame: { id: 'F1' } })
    await expect(runTool(first, 'browser', { action: 'click', ref: 'e1' })).rejects.toThrow(/页面已经跳转到别的地址/)
    expect(firstTransport.sent('Input.dispatchMouseEvent')).toHaveLength(0)

    const second = makeHarness()
    await snapshot(second)
    const secondTransport = transportOf(second)
    secondTransport.session('S1').emit('Runtime.executionContextsCleared', {})
    await expect(runTool(second, 'browser', { action: 'click', ref: 'e1' })).rejects.toThrow(/页面的文档被换掉了/)
    expect(secondTransport.sent('Input.dispatchMouseEvent')).toHaveLength(0)
  })

  test('不认识 ref / 元素已变：拒绝且不点击', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    await expect(runTool(harness, 'browser', { action: 'click', ref: 'e9' })).rejects.toThrow(/不认识 ref「e9」/)

    const stale = makeHarness()
    await snapshot(stale)
    const transport = transportOf(stale)
    transport.nodes.delete(42)
    await expect(runTool(stale, 'browser', { action: 'click', ref: 'e1' })).rejects.toThrow(
      /页面已变，请重新 snapshot/,
    )
    expect(transport.sent('Input.dispatchMouseEvent')).toHaveLength(0)
  })

  test('hover 只发 mouseMoved；press 聚焦后发 keyDown/keyUp', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    const transport = transportOf(harness)
    const hovered = await runTool(harness, 'browser', { action: 'hover', ref: 'e1' })
    expect(jsonOf(hovered)).toMatchObject({ action: 'hover', ref: 'e1' })
    expect(transport.sent('Input.dispatchMouseEvent').map((call) => call.params['type'])).toEqual(['mouseMoved'])

    const pressed = await runTool(harness, 'browser', { action: 'press', key: 'Enter', ref: 'e2' })
    expect(jsonOf(pressed)).toMatchObject({ action: 'press', key: 'Enter', vk: 13 })
    expect(transport.sent('DOM.focus').at(-1)!.params).toEqual({ backendNodeId: 43 })
    expect(transport.sent('Input.dispatchKeyEvent').slice(-2).map((call) => call.params['type'])).toEqual([
      'keyDown',
      'keyUp',
    ])

    await expect(runTool(harness, 'browser', { action: 'press', key: '  ' })).rejects.toThrow(/需要一个 key/)
  })

  test('type：空文本与密钥形状都被拦；clear/submit 的按键落点', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    const transport = transportOf(harness)
    await expect(runTool(harness, 'browser', { action: 'type', ref: 'e2', text: '' })).rejects.toThrow(/非空的 text/)
    await expect(
      runTool(harness, 'browser', { action: 'type', ref: 'e2', text: `sk-${'a'.repeat(24)}` }),
    ).rejects.toThrow(/不代你把凭据打进网页输入框/)
    expect(transport.sent('Input.insertText')).toHaveLength(0)

    const output = await runTool(harness, 'browser', { action: 'type', ref: 'e2', text: '你好', clear: true, submit: true })
    expect(jsonOf(output)).toMatchObject({ action: 'type', ref: 'e2', chars: 2 })
    expect(transport.sent('Input.insertText')).toEqual([{ method: 'Input.insertText', params: { text: '你好' }, sessionId: 'S1' }])
    const keys = transport.sent('Input.dispatchKeyEvent').map((call) => call.params)
    expect(keys.some((params) => params['type'] === 'rawKeyDown' && params['modifiers'] === 2)).toBe(true)
    expect(keys.some((params) => params['key'] === 'Enter')).toBe(true)
  })

  test('select：values 为空报错；成功时把值交给页面函数', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    await expect(runTool(harness, 'browser', { action: 'select', ref: 'e1' })).rejects.toThrow(/需要 values/)

    const transport = transportOf(harness)
    const output = await runTool(harness, 'browser', { action: 'select', ref: 'e1', values: ['A', 'B'] })
    expect(transport.sent('DOM.resolveNode')[0]!.params).toEqual({ backendNodeId: 42 })
    expect(transport.sent('Runtime.callFunctionOn')[0]!.params['arguments']).toEqual([{ value: ['A', 'B'] }])
    expect(jsonOf(output)).toMatchObject({ action: 'select', ref: 'e1', selected: ['A', 'B'] })
  })

  test('scroll：方向校验、鼠标滚轮与 top 的 scrollTo', async () => {
    const harness = makeHarness()
    await expect(runTool(harness, 'browser', { action: 'scroll', direction: 'diagonal' })).rejects.toThrow(
      /direction 只能是 up\/down\/left\/right\/top\/bottom/,
    )
    const down = await runTool(harness, 'browser', { action: 'scroll', direction: 'down' })
    expect(jsonOf(down)).toMatchObject({ action: 'scroll', direction: 'down', deltaX: 0, deltaY: 500 })
    const wheel = transportOf(harness).sent('Input.dispatchMouseEvent').at(-1)!
    expect(wheel.params).toMatchObject({ type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 500 })

    const top = await runTool(harness, 'browser', { action: 'scroll', direction: 'top' })
    expect(jsonOf(top)).toMatchObject({ action: 'scroll', direction: 'top', deltaX: 0, deltaY: 0 })
    expect(String(transportOf(harness).sent('Runtime.evaluate').at(-1)!.params['expression'])).toContain('window.scrollTo(0, 0)')
  })

  test('fill_form：空清单与敏感取值被拦，成功时逐项填写', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    await expect(runTool(harness, 'browser', { action: 'fill_form', fields: [] })).rejects.toThrow(/非空的 fields/)
    await expect(
      runTool(harness, 'browser', {
        action: 'fill_form',
        fields: [{ ref: 'e2', value: `sk-${'b'.repeat(24)}` }],
      }),
    ).rejects.toThrow(/取值不能用/)

    const transport = transportOf(harness)
    const output = await runTool(harness, 'browser', {
      action: 'fill_form',
      fields: [
        { ref: 'e1', value: '甲' },
        { ref: 'e2', value: '乙' },
      ],
    })
    expect(transport.sent('Input.insertText').map((call) => call.params['text'])).toEqual(['甲', '乙'])
    expect(jsonOf(output)).toMatchObject({ action: 'fill_form', filled: 2, fields: ['e1', 'e2'] })
  })

  test('evaluate：开关、空表达式、异常与结果围栏', async () => {
    const disabled = makeHarness({ enableEvaluate: false })
    await expect(runTool(disabled, 'browser', { action: 'evaluate', expression: '1' })).rejects.toThrow(/被关掉了/)

    const harness = makeHarness()
    await expect(runTool(harness, 'browser', { action: 'evaluate', expression: '   ' })).rejects.toThrow(
      /需要一个 expression/,
    )
    transportOf(harness).evaluateValue = { sum: 2 }
    const output = await runTool(harness, 'browser', { action: 'evaluate', expression: '1 + 1' })
    expect(output).toContain('求值结果：')
    expect(output).toContain('{"sum":2}')
    expect(output).toContain('<external_content source="browser">')

    const throwing = makeHarness()
    await runTool(throwing, 'browser_look', { action: 'tabs' })
    transportOf(throwing).evaluateThrows = true
    await expect(runTool(throwing, 'browser', { action: 'evaluate', expression: 'x.y' })).rejects.toThrow(
      /页面 JS 抛异常：ReferenceError: x is not defined/,
    )
  })

  test('upload：空清单/不存在/读禁文件都拒，成功时给绝对路径', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    const transport = transportOf(harness)
    await expect(runTool(harness, 'browser', { action: 'upload', ref: 'e1' })).rejects.toThrow(/没有给要上传的文件路径/)
    await expect(runTool(harness, 'browser', { action: 'upload', ref: 'e1', paths: ['missing.txt'] })).rejects.toThrow(
      /文件不存在/,
    )
    await expect(runTool(harness, 'browser', { action: 'upload', ref: 'e1', paths: ['.env'] })).rejects.toThrow(
      /不能上传这个文件/,
    )

    const output = await runTool(harness, 'browser', { action: 'upload', ref: 'e1', paths: ['ok.txt'] })
    expect(transport.sent('DOM.setFileInputFiles')[0]!.params).toEqual({
      files: [join(WORK, 'ok.txt')],
      backendNodeId: 42,
    })
    expect(jsonOf(output)).toMatchObject({ action: 'upload', ref: 'e1', files: [join(WORK, 'ok.txt')] })
  })

  test('close：没启动过给一句话；启动后关进程、作废 ref 并退订事件', async () => {
    const idle = makeHarness()
    expect(await runTool(idle, 'browser', { action: 'close' })).toBe('受控浏览器本来就没在运行。')

    const harness = makeHarness()
    await snapshot(harness)
    const transport = transportOf(harness)
    const session = transport.session('S1')
    expect(session.listenerCount('Runtime.consoleAPICalled')).toBe(1)
    const proc = harness.process()
    const output = await runTool(harness, 'browser', { action: 'close' })
    expect(jsonOf(output)).toMatchObject({ action: 'close' })
    expect(proc.closeCalls).toBe(1)
    expect(session.listenerCount('Runtime.consoleAPICalled')).toBe(0)

    session.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: '关掉之后' }] })
    expect(textOf(await runTool(harness, 'browser_look', { action: 'console' }))).toContain('控制台还没有输出')
    await expect(runTool(harness, 'browser', { action: 'click', ref: 'e1' })).rejects.toThrow(/不认识 ref「e1」/)
  })
})

describe('对话框策略', () => {
  test('must_respond：挂起时阻塞页面命令，dialog accept 带 promptText', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    transportOf(harness).session('S1').emit('Page.javascriptDialogOpening', { type: 'prompt', message: '你的名字' })
    expect(harness.notices.join('\n')).toContain('页面弹出了 prompt 对话框')

    await expect(runTool(harness, 'browser_look', { action: 'snapshot' })).rejects.toThrow(/还挂着一个 prompt 对话框/)
    await expect(runTool(harness, 'browser', { action: 'click', ref: 'e1' })).rejects.toThrow(/还挂着一个 prompt 对话框/)
    // tabs 是浏览器级命令，不受对话框影响
    await expect(runTool(harness, 'browser_look', { action: 'tabs' })).resolves.toBeTruthy()

    const output = await runTool(harness, 'browser', {
      action: 'dialog',
      dialogAction: 'accept',
      promptText: '小明',
    })
    expect(jsonOf(output)).toMatchObject({ action: 'dialog', dialogAction: 'accept', type: 'prompt' })
    expect(transportOf(harness).sent('Page.handleJavaScriptDialog').at(-1)!.params).toEqual({
      accept: true,
      promptText: '小明',
    })
    // 处理完就不再阻塞
    await expect(snapshot(harness)).resolves.toBeTruthy()
  })

  test('must_respond：没人处理时超时自动 dismiss 并解除阻塞', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    const transport = transportOf(harness)
    vi.useFakeTimers()
    try {
      transport.session('S1').emit('Page.javascriptDialogOpening', { type: 'alert', message: '超时测试' })
      await expect(runTool(harness, 'browser_look', { action: 'snapshot' })).rejects.toThrow(/还挂着一个 alert 对话框/)
      await vi.advanceTimersByTimeAsync(300_000)
      await Promise.resolve()
      expect(transport.sent('Page.handleJavaScriptDialog').some((call) => call.params['accept'] === false)).toBe(true)
      expect(harness.notices.join('\n')).toContain('没人处理')
      await expect(snapshot(harness)).resolves.toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  test('auto_dismiss / auto_accept 立即处理且不阻塞', async () => {
    const dismiss = makeHarness({ dialogPolicy: 'auto_dismiss' })
    await snapshot(dismiss)
    transportOf(dismiss).session('S1').emit('Page.javascriptDialogOpening', { type: 'confirm', message: '关掉吗' })
    await Promise.resolve()
    expect(transportOf(dismiss).sent('Page.handleJavaScriptDialog').at(-1)!.params).toEqual({ accept: false })
    await expect(snapshot(dismiss)).resolves.toBeTruthy()

    const accept = makeHarness({ dialogPolicy: 'auto_accept' })
    await snapshot(accept)
    transportOf(accept).session('S1').emit('Page.javascriptDialogOpening', { type: 'confirm', message: '接受吗' })
    await Promise.resolve()
    expect(transportOf(accept).sent('Page.handleJavaScriptDialog').at(-1)!.params).toEqual({ accept: true })
  })

  test('dialog 的边界：没有挂起、缺 dialogAction、Closed 事件清状态', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    await expect(runTool(harness, 'browser', { action: 'dialog', dialogAction: 'accept' })).rejects.toThrow(
      /当前没有待处理的对话框/,
    )

    const session = transportOf(harness).session('S1')
    session.emit('Page.javascriptDialogOpening', { type: 'alert', message: '缺动作' })
    await expect(runTool(harness, 'browser', { action: 'dialog' })).rejects.toThrow(/需要 dialogAction=accept/)
    // 没处理掉，仍挂着
    await expect(snapshot(harness)).rejects.toThrow(/还挂着一个 alert 对话框/)

    session.emit('Page.javascriptDialogClosed', {})
    await expect(snapshot(harness)).resolves.toBeTruthy()
  })
})

describe('frame 切换', () => {
  test('切到跨进程 iframe 后动作落到它上面；切回主标签页退订 iframe 事件', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    const transport = transportOf(harness)
    transport.targets.push({ targetId: 't2', type: 'iframe', title: '内嵌框架', url: 'https://frame.test/' })

    const switched = await runTool(harness, 'browser', { action: 'frame', targetId: 't2' })
    expect(jsonOf(switched)).toMatchObject({ action: 'frame', targetId: 't2', type: 'iframe' })
    expect(transport.sessions.get('S2')!.listenerCount('Runtime.consoleAPICalled')).toBe(1)

    await snapshot(harness)
    expect(transport.sent('Accessibility.getFullAXTree').at(-1)!.sessionId).toBe('S2')
    await runTool(harness, 'browser', { action: 'click', ref: 'e1' })
    expect(transport.sent('Input.dispatchMouseEvent').every((call) => call.sessionId === 'S2')).toBe(true)

    const back = await runTool(harness, 'browser', { action: 'frame' })
    expect(jsonOf(back)).toMatchObject({ action: 'frame', targetId: 't1' })
    expect(transport.sessions.get('S2')!.listenerCount('Runtime.consoleAPICalled')).toBe(0)
    expect(transport.sessions.get('S1')!.listenerCount('Runtime.consoleAPICalled')).toBe(1)

    transport.session('S2').emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: '切走后的 iframe' }] })
    expect(textOf(await runTool(harness, 'browser_look', { action: 'console' }))).toContain('控制台还没有输出')
  })

  test('targetId 是主标签页 / frameId 是主框架时都切回主标签页', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    const transport = transportOf(harness)

    const byTarget = await runTool(harness, 'browser', { action: 'frame', targetId: 't1' })
    expect(jsonOf(byTarget)).toMatchObject({ action: 'frame', targetId: 't1' })
    expect(textOf(byTarget)).toContain('就是主标签页')

    const byFrame = await runTool(harness, 'browser', { action: 'frame', frameId: 'MAIN' })
    expect(jsonOf(byFrame)).toMatchObject({ action: 'frame', frameId: 'MAIN' })
    expect(textOf(byFrame)).toContain('就是主框架')
    expect(transport.sent('Accessibility.getFullAXTree').at(-1)!.sessionId).toBe('S1')
  })

  test('不存在的目标报错并指引 browser_look action=tabs', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    await expect(runTool(harness, 'browser', { action: 'frame', targetId: 'zzz' })).rejects.toThrow(
      /没有 targetId 为 zzz 的目标/,
    )
  })
})

describe('命令 /browser', () => {
  test('status 分未运行/运行中，close 关进程，未知子命令给用法', async () => {
    const harness = makeHarness()
    const said: string[] = []
    const ui = { notice: (text: string) => said.push(text) }
    const command = harness.commands[0]!

    command.run({ args: ['status'], ui })
    expect(said.at(-1)).toContain('没在运行')

    await snapshot(harness)
    command.run({ args: [], ui })
    expect(said.at(-1)).toContain('pid 4321')
    expect(said.at(-1)).toContain('快照代际 2，ref 2 个')

    const proc = harness.process()
    command.run({ args: ['close'], ui })
    expect(proc.closeCalls).toBe(1)
    expect(said.at(-1)).toContain('已关闭受控浏览器')

    command.run({ args: ['status'], ui })
    expect(said.at(-1)).toContain('没在运行')

    command.run({ args: ['dance'], ui })
    expect(said.at(-1)).toContain('用法：/browser status')
  })

  test('close 在没启动过时只给一句提示', () => {
    const harness = makeHarness()
    const said: string[] = []
    harness.commands[0]!.run({ args: ['close'], ui: { notice: (text: string) => said.push(text) } })
    expect(said.at(-1)).toContain('本来就没在运行')
  })
})

describe('设置分区 save / action', () => {
  test('非法值/未知键返回文案，数字夹取后落盘', () => {
    const harness = makeHarness()
    const section = harness.sections[0] as any
    expect(typeof section.save('maxSnapshotChars', 'abc')).toBe('string')
    expect(typeof section.save('waitTimeoutMs', 'abc')).toBe('string')
    expect(typeof section.save('consoleBuffer', 'abc')).toBe('string')
    expect(typeof section.save('networkBuffer', 'abc')).toBe('string')
    expect(typeof section.save('dialogPolicy', 'sometimes')).toBe('string')
    expect(typeof section.save('nope', 1)).toBe('string')
    expect(section.values().maxSnapshotChars).toBe(15000)

    expect(section.save('maxSnapshotChars', 100)).toBeUndefined()
    expect(section.save('waitTimeoutMs', 999999)).toBeUndefined()
    expect(section.save('dialogPolicy', 'auto_dismiss')).toBeUndefined()
    expect(section.save('headless', false)).toBeUndefined()
    expect(section.save('enableEvaluate', 'false')).toBeUndefined()
    expect(section.values()).toMatchObject({
      maxSnapshotChars: 500,
      waitTimeoutMs: 60000,
      dialogPolicy: 'auto_dismiss',
      headless: false,
      enableEvaluate: false,
    })

    const doc = JSON.parse(readFileSync(join(HOME, 'plugins.json'), 'utf8')) as {
      entries: Array<{ file: string; config: Record<string, unknown> }>
    }
    const entry = doc.entries.find((item) => item.file === 'browser')
    expect(entry?.config).toMatchObject({
      maxSnapshotChars: 500,
      waitTimeoutMs: 60000,
      dialogPolicy: 'auto_dismiss',
      headless: false,
      enableEvaluate: false,
    })
  })

  test('保存域名名单后守卫立即生效', () => {
    const harness = makeHarness()
    const section = harness.sections[0] as any
    const guard = harness.guards[0]!
    expect(guard.decide(guardInput({ action: 'navigate', url: 'https://example.com/' }))).toEqual({ action: 'defer' })

    section.save('allowedDomains', '!example.com')
    const verdict = guard.decide(guardInput({ action: 'navigate', url: 'https://example.com/' })) as any
    expect(verdict.action).toBe('deny')
    expect(verdict.reason).toContain('命中拒绝名单')
    expect(section.values().allowedDomains).toBe('!example.com')
  })

  test('保存缓冲条数会 resize 已攒的条目', async () => {
    const harness = makeHarness({ consoleBuffer: 3 })
    await snapshot(harness)
    const session = transportOf(harness).session('S1')
    for (const text of ['a', 'b', 'c']) {
      session.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: text }] })
    }
    const section = harness.sections[0] as any
    expect(section.save('consoleBuffer', 1)).toBeUndefined()
    const output = await runTool(harness, 'browser_look', { action: 'console' })
    expect(jsonOf(output).count).toBe(1)
    expect(textOf(output)).toContain('log: c')
    expect(textOf(output)).not.toContain('log: a')
  })

  test('action look-tab：成功给地址与加载状态，失败把原因写成一句话', async () => {
    const harness = makeHarness()
    const section = harness.sections[0] as any
    const ok = await section.action('look-tab')
    expect(ok).toContain('https://example.com/')
    expect(ok).toContain('complete')

    const failing = makeHarness()
    await runTool(failing, 'browser_look', { action: 'tabs' })
    transportOf(failing).respond('Target.getTargets', () => {
      throw new Error('模拟连不上')
    })
    const failed = await (failing.sections[0] as any).action('look-tab')
    expect(failed).toContain('模拟连不上')
  })

  test('action close-browser：未运行一句话，运行中关闭并带 profile', async () => {
    const idle = makeHarness()
    expect(typeof (await (idle.sections[0] as any).action('close-browser'))).toBe('string')

    const harness = makeHarness()
    await runTool(harness, 'browser_look', { action: 'tabs' })
    const proc = harness.process()
    const said = await (harness.sections[0] as any).action('close-browser')
    expect(proc.closeCalls).toBe(1)
    expect(said).toContain('dsc-browser-fake')
    await expect((harness.sections[0] as any).action('nope')).rejects.toThrow(/没有这个按钮/)
  })
})

describe('会话事件与退出清理', () => {
  test('dsc/session-open 作废上一会话的 ref；dsc/exit 关闭进程', async () => {
    const harness = makeHarness()
    await snapshot(harness)
    harness.listeners.get('dsc/session-open')!()
    await expect(runTool(harness, 'browser', { action: 'click', ref: 'e1' })).rejects.toThrow(/换了会话/)

    const proc = harness.process()
    harness.listeners.get('dsc/exit')!()
    expect(proc.shutdownCalls).toBe(1)
    expect(transportOf(harness).sessions.get('S1')!.listenerCount('Runtime.consoleAPICalled')).toBe(0)
  })

  test('没有 ref 时 session-open 不动代际', async () => {
    const harness = makeHarness()
    const said: string[] = []
    harness.listeners.get('dsc/session-open')!()
    harness.commands[0]!.run({ args: ['status'], ui: { notice: (text: string) => said.push(text) } })
    // 没启动过，只断言不抛错即可：session-open 的空 ref 分支不该建连接
    expect(said.at(-1)).toContain('没在运行')
    expect(harness.process()).toBeUndefined()
  })
})
