/**
 * lsp 包的 W14-C 补测：连接层、调度层与插件装配面剩余的失败/时序分支。
 *
 * 对端全部是真 node 子进程跑的分帧假服务器：既有夹具 `tests/fixtures/fake-lsp-server.mjs`
 * 能表达的（握手、推送、拉式诊断、退出）直接复用；它表达不了的（坏帧、乱序版本、超长
 * hover、忘记推送）由本文件在临时目录里现写一份最小服务器脚本来演。
 *
 * 覆盖目标（行号以 2026-11-20 的源码为准）：
 *   - client.ts：连接已关后仍发请求、stdin 已毁、正文超上限、分帧解析抛错、
 *     拉式诊断报错、推送等待器在「最新推送被忘掉 / 版本更旧 / 调用方信号已中止」时的收场；
 *   - manager.ts：idle 清扫定时器到点、诊断路上 awaitReady 抛错、破键过期、
 *     队列里 op 抛错后的尾巴、同 key 并发启动的 pending 分支；
 *   - index.ts：工具里 manager 抛错、hover 空内容、守卫里事件路径抛错、结果超 16000 字符；
 *   - uri.ts：`pathToFileURL` 抛错时手工拼 URI 的兜底。
 *
 * 注入方式说明：
 *   - 连接层用真子进程 + 临时脚本，不 mock 模块；
 *   - 「stdin 已毁」「推送被忘掉」「同 key 并发启动」三条走不到公开 API（前者只有管道
 *     内部状态，后者被串行队列挡住），所以用类型断言直接触碰私有字段/方法，属于测试专用注入；
 *   - 时间预算压到毫秒级，所有实例/管理器/临时目录在 afterEach 收掉。
 *
 * @module dsc/packages/lsp/tests/w14c-lsp-gaps
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { defaultRuntimeValues, LspInstance, type LspManagerOptions, type LspRuntimeValues } from '../client.js'
import { LspManager } from '../manager.js'
import { pathToUri } from '../uri.js'
import type { LspServerDef } from '../servers.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-lsp-w14c-'))
process.env['DSC_HOME'] = HOME
const fixture = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))
const SCRIPT_DIR = join(HOME, 'servers')
mkdirSync(SCRIPT_DIR, { recursive: true })
const env = { ...process.env } as Record<string, string>
const position = { line: 0, character: 0 }
const created: Array<{ instance: LspInstance; root: string }> = []
const managers: LspManager[] = []
const dirs: string[] = []

afterEach(() => {
  for (const { instance } of created.splice(0)) {
    try {
      instance.terminateNow()
    } catch {
      // 已经退了的实例再收一次无害
    }
  }
  for (const manager of managers.splice(0)) manager.dispose()
})

afterAll(() => {
  // 临时目录统一在收尾删：Windows 上子进程刚退出时还攥着 cwd，逐个删会拖慢每条用例。
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // 临时目录留给系统清
    }
  }
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // 临时目录留给系统清
  }
})

// ── 临时假服务器脚本 ─────────────────────────────────────────────────────────

/** 按 Content-Length 分帧读 stdin 的公共前半段；后半段由各模式自己写。 */
const SERVER_PRELUDE = `
const send = (value) => {
  const body = JSON.stringify(value)
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body)
}
const respond = (id, result) => send({ jsonrpc: '2.0', id, result })
const respondError = (id, message, code) => send({ jsonrpc: '2.0', id, error: { code, message } })
const caps = { positionEncoding: 'utf-16', definitionProvider: true, hoverProvider: true }
const range = () => ({ start: { line: 0, character: 0 }, end: { line: 0, character: 1 } })
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const sep = buffer.indexOf('\\r\\n\\r\\n')
    if (sep < 0) return
    const header = buffer.slice(0, sep)
    const match = /content-length:\\s*(\\d+)/i.exec(header)
    if (match === null) return
    const length = Number(match[1])
    if (buffer.length < sep + 4 + length) return
    const raw = buffer.slice(sep + 4, sep + 4 + length)
    buffer = buffer.slice(sep + 4 + length)
    handle(JSON.parse(raw))
  }
})
`

/** 写一份临时假服务器脚本，返回绝对路径。 */
function serverScript(name: string, body: string): string {
  const path = join(SCRIPT_DIR, `${name}.mjs`)
  writeFileSync(path, `${SERVER_PRELUDE}\n${body}\n`, 'utf8')
  return path
}

/**
 * 把假服务器收到的东西分派掉；各模式只覆盖自己关心的输入。
 *
 * 默认行为：initialize 回能力、didOpen 推一条诊断、definition/hover 各给一个正常结果。
 */
const DEFAULT_HANDLE = `
function handle(message) {
  if (message.method === 'initialize') {
    respond(message.id, { capabilities: caps })
    return
  }
  if (message.method === 'initialized') return
  if (message.method === 'shutdown') {
    respond(message.id, null)
    return
  }
  if (message.method === 'exit') {
    process.exit(0)
    return
  }
  if (message.method === 'textDocument/didOpen') {
    const doc = message.params.textDocument
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, version: doc.version, diagnostics: [{ range: range(), severity: 1, message: 'len:' + String(doc.text.length) }] } })
    return
  }
  if (message.method === 'textDocument/definition') {
    respond(message.id, { uri: message.params.textDocument.uri, range: range() })
    return
  }
  if (message.method === 'textDocument/hover') {
    respond(message.id, { contents: { kind: 'markdown', value: '## 标题' } })
    return
  }
  if (typeof message.id === 'number') respond(message.id, null)
}
`

/** 造一个带 package.json 标记的临时项目根。 */
function project(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-lsp-w14c-proj-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"demo"}\n', 'utf8')
  const file = join(dir, 'src', 'a.ts')
  writeFileSync(file, 'const a = 1\n', 'utf8')
  return { dir, file }
}

const baseValues = (over: Partial<LspRuntimeValues> = {}): LspRuntimeValues => ({
  ...defaultRuntimeValues(),
  initializeTimeoutMs: 4_000,
  requestTimeoutMs: 4_000,
  diagnosticsWaitMs: 1_000,
  pushSettleMs: 30,
  cancelGraceMs: 100,
  shutdownGraceMs: 800,
  brokenRetryMs: 60_000,
  ...over,
})

/** 一个已登记收尾的实例；`script` 是假服务器脚本路径。 */
function makeInstance(
  script: string,
  over: Partial<LspRuntimeValues> = {},
  mode = 'custom',
): { instance: LspInstance; file: string; root: string; exits: string[] } {
  const { dir, file } = project()
  const exits: string[] = []
  const server: LspServerDef = {
    id: `fake-${mode}`,
    languageId: 'typescript',
    extensions: ['.ts'],
    command: 'node',
    args: [script],
    markers: ['package.json'],
  }
  const instance = new LspInstance({
    server,
    root: dir,
    target: { file: process.execPath, shell: false },
    env,
    values: baseValues(over),
    onExit: (reason) => exits.push(reason),
  })
  created.push({ instance, root: dir })
  return { instance, file, root: dir, exits }
}

/** 用既有夹具造实例（模式名就是夹具自己的 mode）。 */
function makeFixtureInstance(
  mode: string,
  over: Partial<LspRuntimeValues> = {},
): { instance: LspInstance; file: string; exits: string[] } {
  const { dir, file } = project()
  const exits: string[] = []
  const server: LspServerDef = {
    id: `fixture-${mode}`,
    languageId: 'typescript',
    extensions: ['.ts'],
    command: 'node',
    args: [fixture, mode],
    markers: ['package.json'],
  }
  const instance = new LspInstance({
    server,
    root: dir,
    target: { file: process.execPath, shell: false },
    env,
    values: baseValues(over),
    onExit: (reason) => exits.push(reason),
  })
  created.push({ instance, root: dir })
  return { instance, file, exits }
}

/** 触碰实例内部连接的诊断缓存（测试专用注入，见文件头）。 */
interface ConnectionPeek {
  connection: {
    latestPush(uri: string): unknown
    forgetPush(uri: string): void
    request(method: string, params: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown>
    child: { stdin: { destroy(): void } | null }
  }
}

const peek = (instance: LspInstance): ConnectionPeek => instance as unknown as ConnectionPeek

// ── 连接层 ───────────────────────────────────────────────────────────────────

describe('连接已关 / 管道坏掉之后', () => {
  test('进程已退后再发请求：当场按关闭原因拒绝', async () => {
    const { instance, file } = makeFixtureInstance('die')
    // 第一条查询在 didOpen 上把进程弄死；第二条走「连接已关仍调 request」的分支。
    await expect(instance.query('goToDefinition', file, position, undefined)).rejects.toThrow()
    await expect(instance.query('goToDefinition', file, position, undefined)).rejects.toThrow(/进程退出|退出/)
    expect(instance.dead).toBe(true)
  })

  test('stdin 已被销毁：写的时候按「输入口已经关了」收场', async () => {
    const { instance, file } = makeFixtureInstance('ok')
    await instance.query('goToDefinition', file, position, undefined)
    peek(instance).connection.child.stdin?.destroy()
    await expect(instance.query('goToDefinition', file, position, undefined)).rejects.toThrow(/输入口已经关了/)
  })

  test('didOpen 正文超过 16MB 上限：编码失败按连接废掉处理', async () => {
    const { instance, file } = makeFixtureInstance('ok')
    writeFileSync(file, `// ${'a'.repeat(17 * 1024 * 1024)}\n`, 'utf8')
    await expect(instance.query('goToDefinition', file, position, undefined)).rejects.toThrow(/超过|上限/)
    expect(instance.dead).toBe(true)
  }, 20_000)

  test('服务器写坏帧：分帧解析抛错后把连接和进程一起收掉', async () => {
    const script = serverScript(
      'broken-frame',
      `
${DEFAULT_HANDLE}
handle = (message) => {
  if (message.method === 'initialize') {
    respond(message.id, { capabilities: caps })
    return
  }
  if (typeof message.id !== 'number') return
  // 请求来了才回一段缺 Content-Length 的坏帧：客户端应当把整条连接判废。
  process.stdout.write('X-Nope: 1\\r\\n\\r\\n{}')
}
`,
    )
    const { instance, file, exits } = makeInstance(script)
    await expect(instance.query('goToDefinition', file, position, undefined)).rejects.toThrow(/Content-Length|分帧|协议/)
    expect(instance.dead).toBe(true)
    await vi.waitFor(() => expect(exits.length).toBeGreaterThan(0))
  })
})

describe('推送诊断的等待器', () => {
  test('拉式诊断报错：当没有结果，等待推送超时后给 null', async () => {
    const script = serverScript(
      'pull-error',
      `
${DEFAULT_HANDLE}
handle = (message) => {
  if (message.method === 'initialize') {
    respond(message.id, { capabilities: { positionEncoding: 'utf-16', diagnosticProvider: {} } })
    return
  }
  if (message.method === 'textDocument/didOpen') return
  if (message.method === 'textDocument/diagnostic') {
    respondError(message.id, '拉不动', -32001)
    return
  }
  if (message.method === 'shutdown') {
    respond(message.id, null)
    return
  }
  if (message.method === 'exit') {
    process.exit(0)
    return
  }
  if (typeof message.id === 'number') respond(message.id, null)
}
`,
    )
    const { instance, file } = makeInstance(script, { diagnosticsWaitMs: 300 })
    expect(await instance.diagnostics(file, undefined, undefined)).toBeNull()
  })

  test('推送被中途忘掉：结算时拿不到最新推送，按没有结果收场', async () => {
    const script = serverScript('late-push', DEFAULT_HANDLE)
    const { instance, file } = makeInstance(script, { pushSettleMs: 150, diagnosticsWaitMs: 3_000 })
    const uri = pathToUri(file)
    const running = instance.diagnostics(file, undefined, undefined)
    await vi.waitFor(() => expect(peek(instance).connection.latestPush(uri)).toBeDefined())
    peek(instance).connection.forgetPush(uri)
    expect(await running).toBeNull()
  })

  test('乱序推送：结算时最新一条比这次 didOpen 旧，按没有结果收场', async () => {
    const script = serverScript(
      'older-push',
      `
${DEFAULT_HANDLE}
const fallback = handle
handle = (message) => {
  if (message.method === 'textDocument/didOpen') {
    const doc = message.params.textDocument
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, version: doc.version, diagnostics: [{ range: range(), severity: 1, message: 'new' }] } })
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, version: doc.version - 1, diagnostics: [{ range: range(), severity: 1, message: 'old' }] } })
    }, 10)
    return
  }
  fallback(message)
}
`,
    )
    const { instance, file } = makeInstance(script, { pushSettleMs: 150, diagnosticsWaitMs: 3_000 })
    expect(await instance.diagnostics(file, undefined, undefined)).toBeNull()
  })

  test('调用方信号在进等待器那一刻已中止（鸭子信号）：立刻收场', async () => {
    const script = serverScript('plain', DEFAULT_HANDLE)
    const { instance, file } = makeInstance(script, { diagnosticsWaitMs: 3_000 })
    // awaitReady 读一次 aborted（此时为 false），waitForPush 再读时已经变 true：
    // 真实 AbortSignal 走不到这条窄缝，用按次翻转的鸭子信号把这个分支钉住。
    let reads = 0
    const fakeSignal = {
      get aborted() {
        reads += 1
        return reads > 1
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal
    expect(await instance.diagnostics(file, undefined, fakeSignal)).toBeNull()
  })

  test('正常信号：注册中止监听，推送到了照常返回结果', async () => {
    const script = serverScript('plain', DEFAULT_HANDLE)
    const { instance, file } = makeInstance(script, { diagnosticsWaitMs: 3_000 })
    const controller = new AbortController()
    const items = await instance.diagnostics(file, undefined, controller.signal)
    expect(items).toHaveLength(1)
  })
})

describe('URI 兜底', () => {
  test('pathToFileURL 抛错（空 UNC 资源路径）时手工拼一个合法 URI', () => {
    const uri = pathToUri('\\\\?\\UNC\\x')
    expect(uri.startsWith('file://')).toBe(true)
    expect(uri).not.toContain('\\')
  })
})

// ── 管理器：定时器、破键、队列、并发启动 ─────────────────────────────────────

interface ManagerSetup {
  manager: LspManager
  root: string
  file: string
}

/** 造一个带项目根的管理器；`server` 是清单里那一条。 */
function makeManager(
  server: Partial<LspServerDef>,
  values: Partial<LspRuntimeValues> = {},
  options: Partial<LspManagerOptions> = {},
): ManagerSetup {
  const { dir, file } = project()
  const def: LspServerDef = {
    id: 'fake',
    languageId: 'typescript',
    extensions: ['.ts'],
    command: process.execPath,
    args: [fixture, 'ok'],
    markers: ['package.json'],
    ...server,
  }
  const manager = new LspManager({
    servers: () => [def],
    idleTimeoutMs: () => 60_000,
    baseCwd: () => dir,
    env: () => env,
    values: () => baseValues(values),
    ...options,
  })
  managers.push(manager)
  return { manager, root: dir, file }
}

function managerPlan(setup: ManagerSetup, server: LspServerDef): Record<string, unknown> {
  return {
    server,
    root: setup.root,
    path: setup.file,
    key: `${server.id}\u0000${setup.root}`,
    target: { file: process.execPath, shell: false },
  }
}

interface ManagerPeek {
  acquire(plan: unknown): Promise<{ ok: boolean; record?: unknown }>
  enqueue<T>(key: string, op: () => Promise<T>): Promise<T>
}

const managerPeek = (manager: LspManager): ManagerPeek => manager as unknown as ManagerPeek

describe('管理器的残余分支', () => {
  test('idle 清扫定时器到点会跑一轮，并自动排下一次', async () => {
    vi.useFakeTimers()
    let manager: LspManager | undefined
    try {
      manager = makeManager({}).manager
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(manager.status()).toHaveLength(1)
    } finally {
      manager?.dispose()
      managers.length = 0
      vi.useRealTimers()
    }
  })

  test('诊断路上同步信号已取消：走 failed() 收场而不是抛出去', async () => {
    const { manager, root, file } = makeManager({})
    expect(await manager.query('goToDefinition', file, position, root, undefined)).toMatchObject({ ok: true })
    const controller = new AbortController()
    controller.abort()
    const outcome = await manager.diagnostics(file, root, undefined, controller.signal)
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining('取消') })
  })

  test('破键过期：重新放行、状态里也不再报破键', async () => {
    const { manager, root, file } = makeManager({ args: ['-e', 'process.exit(1)'] }, { brokenRetryMs: -1 })
    const first = await manager.query('goToDefinition', file, position, root, undefined)
    expect(first).toMatchObject({ ok: false, reason: expect.stringContaining('起不来') })
    // status 先扫掉过期破键（brokenIn 的删除分支），再查一次走 brokenReason 的过期分支。
    expect(manager.status()[0]).toMatchObject({ brokenSeconds: null })
    const second = await manager.query('goToDefinition', file, position, root, undefined)
    expect(second).toMatchObject({ ok: false, reason: expect.stringContaining('起不来') })
    expect((second as { reason: string }).reason).not.toContain('先不重试')
  })

  test('队列里的 op 抛错：尾巴照样接上下一次，不留下未处理的 rejection', async () => {
    const { manager } = makeManager({})
    const peeked = managerPeek(manager)
    await expect(
      peeked.enqueue('k', async () => {
        throw new Error('队列里炸了')
      }),
    ).rejects.toThrow('队列里炸了')
    // 让 tails 上那条 catch 处理器跑完（否则 vitest 会把它当未处理 rejection 记一笔）。
    await Promise.resolve()
    await Promise.resolve()
    expect(await peeked.enqueue('k', async () => 'after')).toBe('after')
  })

  test('同 key 并发启动：后到的等前一次的 pending 启动（成功与失败两条）', async () => {
    const okSetup = makeManager({})
    const okServer: LspServerDef = {
      id: 'fake',
      languageId: 'typescript',
      extensions: ['.ts'],
      command: process.execPath,
      args: [fixture, 'ok'],
      markers: ['package.json'],
    }
    const acquireOk = managerPeek(okSetup.manager).acquire.bind(okSetup.manager)
    const okPlan = managerPlan(okSetup, okServer)
    const [first, second] = await Promise.all([acquireOk(okPlan), acquireOk(okPlan)])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(first.record).toBe(second.record)

    const crashServer: LspServerDef = {
      id: 'crash',
      languageId: 'typescript',
      extensions: ['.ts'],
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      markers: ['package.json'],
    }
    const crashSetup = makeManager({})
    const acquireCrash = managerPeek(crashSetup.manager).acquire.bind(crashSetup.manager)
    const crashPlan = managerPlan(crashSetup, crashServer)
    const [failedFirst, failedSecond] = await Promise.all([acquireCrash(crashPlan), acquireCrash(crashPlan)])
    expect(failedFirst.ok).toBe(false)
    expect(failedSecond.ok).toBe(false)
  })
})

// ── 插件装配面：工具、守卫与结果截断 ─────────────────────────────────────────

type LspIndex = typeof import('../index.js')
let lspPlugin: LspIndex['lspPlugin']

beforeAll(async () => {
  lspPlugin = (await import('../index.js')).lspPlugin
})

interface Harness {
  tools: Array<{ name: string; run(args: Record<string, unknown>, ctx: unknown): Promise<string> }>
  guards: Array<{ decide(input: unknown): Promise<unknown> }>
  sections: Array<{ fields(): Array<{ text?: string }> }>
  notices: string[]
  dispose(): void
}

/** 假 ctx 跑真 apply；`sessionThrows` 用来逼出「取会话身份失败」的兜底。 */
function fakeCtx(cwd: string, config: Record<string, unknown>, sessionThrows = false): Harness {
  const tools: Harness['tools'] = []
  const guards: Harness['guards'] = []
  const sections: Harness['sections'] = []
  const notices: string[] = []
  const cleanups: Array<() => void> = []
  const session = {
    meta: { id: 'lsp-w14c', cwd },
    filePath: join(cwd, '.dsc', 'sessions', 'lsp-w14c.jsonl'),
    appendNote: () => {},
  }
  const ctx = {
    effect(fn: () => unknown) {
      const result = fn()
      const off = typeof result === 'function' ? (result as () => void) : (): void => {}
      cleanups.push(off)
      return off
    },
    on() {
      return () => {}
    },
    tools: {
      register(tool: Harness['tools'][number]) {
        tools.push(tool)
        return () => {}
      },
    },
    guards: {
      register(guard: Harness['guards'][number]) {
        guards.push(guard)
        return () => {}
      },
      registerObserver() {
        return () => {}
      },
    },
    prompt: {
      registerProjection() {
        return () => {}
      },
      register() {
        return () => {}
      },
    },
    settings: {
      registerSection(section: Harness['sections'][number]) {
        sections.push(section)
        return () => {}
      },
    },
    provide() {
      return () => {}
    },
    session: {
      current: () => {
        if (sessionThrows) throw new Error('没有当前会话')
        return session
      },
    },
    transcript: { system: (text: string) => notices.push(text) },
  }
  const cleanup = lspPlugin.apply?.(ctx as never, {
    enabled: true,
    servers: JSON.stringify([]),
    diagnostics: true,
    idleSeconds: 600,
    maxLocations: 100,
    ...config,
  })
  const off = typeof cleanup === 'function' ? (cleanup as () => void) : (): void => {}
  cleanups.push(off)
  return {
    tools,
    guards,
    sections,
    notices,
    dispose: () => {
      for (const dispose of cleanups.splice(0).reverse()) dispose()
    },
  }
}

/** 服务器清单那一行 JSON：一条真 node 跑临时脚本。 */
function serverList(script: string): string {
  return JSON.stringify([
    { id: 'fake', command: process.execPath, args: [script], extensions: ['.ts'], markers: ['package.json'] },
  ])
}

const toolContext = (cwd: unknown): Record<string, unknown> => ({
  cwd,
  signal: new AbortController().signal,
})

function toolOf(harness: Harness) {
  const tool = harness.tools.find((item) => item.name === 'lsp')
  if (tool === undefined) throw new Error('没有注册 lsp 工具')
  return tool
}

describe('lsp 工具与守卫的兜底', () => {
  test('取不到工作目录让 manager 抛错：工具折成「LSP 查询出错」', async () => {
    const script = serverScript('plain-tool', DEFAULT_HANDLE)
    const harness = fakeCtx(HOME, { servers: serverList(script) })
    try {
      const result = await toolOf(harness).run(
        { operation: 'goToDefinition', file_path: 'relative.ts', line: 1, character: 1 },
        toolContext(undefined),
      )
      expect(result).toContain('LSP 查询出错')
    } finally {
      harness.dispose()
    }
  })

  test('hover 结果为空：给一句能自救的「没有悬停信息」', async () => {
    const script = serverScript(
      'hover-null',
      `
${DEFAULT_HANDLE}
const fallback = handle
handle = (message) => {
  if (message.method === 'textDocument/hover') {
    respond(message.id, null)
    return
  }
  fallback(message)
}
`,
    )
    const { dir, file } = project()
    const harness = fakeCtx(dir, { servers: serverList(script) })
    try {
      const result = await toolOf(harness).run({ operation: 'hover', file_path: file, line: 1, character: 1 }, toolContext(dir))
      expect(result).toContain('没有悬停信息')
    } finally {
      harness.dispose()
    }
  })

  test('hover 内容超过 16000 字符：截断并附一句说明', async () => {
    const script = serverScript(
      'hover-long',
      `
${DEFAULT_HANDLE}
const fallback = handle
handle = (message) => {
  if (message.method === 'textDocument/hover') {
    respond(message.id, { contents: { kind: 'markdown', value: 'x'.repeat(20000) } })
    return
  }
  fallback(message)
}
`,
    )
    const { dir, file } = project()
    const harness = fakeCtx(dir, { servers: serverList(script) })
    try {
      const result = await toolOf(harness).run({ operation: 'hover', file_path: file, line: 1, character: 1 }, toolContext(dir))
      expect(result).toContain('已截断')
      expect(result.length).toBeLessThan(17_000)
    } finally {
      harness.dispose()
    }
  })

  test('守卫里 canServe 抛错（工作目录取不到）：吞掉并按不拦截处理', async () => {
    const script = serverScript('plain-guard', DEFAULT_HANDLE)
    const { dir, file } = project()
    const harness = fakeCtx(dir, { servers: serverList(script) })
    try {
      const guard = harness.guards[0]
      if (guard === undefined) throw new Error('没有注册守卫')
      const verdict = await guard.decide({
        toolName: 'write',
        target: file,
        cwd: undefined,
        sessionId: 'lsp-w14c',
      })
      expect(verdict).toEqual({ action: 'defer' })
    } finally {
      harness.dispose()
    }
  })
})
