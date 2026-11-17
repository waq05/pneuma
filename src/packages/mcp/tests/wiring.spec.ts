/**
 * mcp 插件装配面（`packages/mcp/index.ts`）：连接生命周期、按能力注册工具、
 * 请求转发与围栏、反向 elicitation、设置分区、配置变更与关闭。
 *
 * 连接层（`mcp.ts` 的 `openConnection`）在这里替换成假连接对象：本文件测的是插件
 * 怎么接、怎么撤、怎么把外部文本交回模型；stdio/http 的协议细节由 `connection.spec.ts`
 *（真子进程）负责，`mcp.spec.ts` 用假 fetch 覆盖传输层，两边不重复。
 *
 * @module dsc/packages/mcp/tests/wiring.spec
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { McpCapabilities, McpConnection, McpOpenOptions, McpServerConfig } from '../mcp.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-mcp-wiring-'))
const WORKSPACE = join(HOME, 'workspace')
process.env['DSC_HOME'] = HOME

/* `openConnection` 换成可编排的假实现；其余导出（parseServerList / asRisk / 命名）保持真的。 */
const mockState = vi.hoisted(() => ({ openConnection: vi.fn() }))
vi.mock('../mcp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mcp.js')>()
  return { ...actual, openConnection: mockState.openConnection }
})

type McpIndex = typeof import('../index.js')

let mcpPlugin: McpIndex['mcpPlugin']

interface FakeConn {
  alive: boolean
  instructions: string
  capabilities: McpCapabilities
  protocolVersion: string
  listTools: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
  listResources: ReturnType<typeof vi.fn>
  readResource: ReturnType<typeof vi.fn>
  listPrompts: ReturnType<typeof vi.fn>
  getPrompt: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

/** 打开过的一次连接（含插件传给 `openConnection` 的选项）。 */
const openCalls: Array<{ server: McpServerConfig; options: McpOpenOptions }> = []

type OpenImpl = (server: McpServerConfig, index: number) => FakeConn | Promise<FakeConn>

/** 让下一批 `openConnection` 调走这个实现。 */
function serve(impl: OpenImpl): void {
  mockState.openConnection.mockImplementation(async (server: McpServerConfig, options: McpOpenOptions) => {
    const index = openCalls.length
    openCalls.push({ server, options })
    return impl(server, index)
  })
}

/** 一个默认连得上、没有工具的假连接。 */
function fakeConnection(over: Partial<FakeConn> = {}): FakeConn {
  const conn: FakeConn = {
    alive: true,
    instructions: '',
    capabilities: { resources: false, prompts: false },
    protocolVersion: '2025-06-18',
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async (name: string) => ({ text: `echo:${name}`, isError: false })),
    listResources: vi.fn(async () => []),
    readResource: vi.fn(async (uri: string) => ({ text: `res:${uri}`, isError: false })),
    listPrompts: vi.fn(async () => []),
    getPrompt: vi.fn(async (name: string) => ({ text: `prompt:${name}`, isError: false })),
    close: vi.fn(() => {
      conn.alive = false
    }),
    ...over,
  }
  return conn
}

/** 捕获到的工具声明。 */
interface CapturedTool {
  name: string
  description: string
  risk: string
  parameters: { properties?: Record<string, { enum?: string[] }>; required?: string[] }
  run(args: Record<string, unknown>, ctx: Record<string, unknown>): Promise<string>
}

/** 捕获到的提示段。 */
interface CapturedPrompt {
  id: string
  render(): string
  order?: number
}

/** 一次 apply 捕获到的东西。 */
interface McpHarness {
  tools: CapturedTool[]
  prompts: CapturedPrompt[]
  sections: Array<{
    id: string
    order?: number
    fields(): Array<{ key?: string; type?: string; options?: Array<{ value: string }> }>
    values(): Record<string, unknown>
    save(key: string, value: unknown): void
    action(name: string): string
  }>
  service: {
    servers(): Array<{ name: string; state: string; tools: number; resources?: number; prompts?: number; problem?: string }>
    tools(): Array<{ name: string; server: string; tool: string; risk: string }>
    call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>
    deferSchemas(): void
    restoreSchemas(): void
  }
  systems: string[]
  approvals: Array<{ request: Record<string, unknown>; signal: unknown }>
  promptsOff: Array<() => void>
  setDecision(decision: 'allow-once' | 'reject'): void
  fireExit(): void
  dispose(): void
}

const cleanups: Array<() => void> = []

beforeAll(async () => {
  ;({ mcpPlugin } = await import('../index.js'))
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup()
    } catch {
      // 已经收过了
    }
  }
  mockState.openConnection.mockReset()
  openCalls.length = 0
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // 临时目录留给系统清。
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  openCalls.length = 0
  // 每条用例从空配置开始：磁盘里那一份会逐键盖过 apply 收到的 `passed`。
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

/** 假 ctx 跑真 apply：记录挂载点；会话身份与审批结论可调。 */
function runApply(config: Record<string, unknown> = {}): McpHarness {
  const tools: CapturedTool[] = []
  const prompts: CapturedPrompt[] = []
  const promptsOff: Array<() => void> = []
  const sections: McpHarness['sections'] = []
  const systems: string[] = []
  const approvals: Array<{ request: Record<string, unknown>; signal: unknown }> = []
  const exitHandlers: Array<() => void> = []
  const disposers: Array<() => void> = []
  let decision: 'allow-once' | 'reject' = 'allow-once'
  let service: McpHarness['service'] | undefined

  const ctx = {
    provide(name: string, value: McpHarness['service']) {
      if (name === 'mcp') service = value
      return () => {}
    },
    settings: {
      registerSection(spec: McpHarness['sections'][number]) {
        sections.push(spec)
        return () => {}
      },
    },
    effect(fn: () => unknown) {
      const off = fn()
      if (typeof off === 'function') {
        disposers.push(off as () => void)
        return off as () => void
      }
      return () => {}
    },
    on(event: string, handler: () => void) {
      if (event === 'dsc/exit') exitHandlers.push(handler)
      return () => {
        const index = exitHandlers.indexOf(handler)
        if (index >= 0) exitHandlers.splice(index, 1)
      }
    },
    tools: {
      register(entry: CapturedTool) {
        tools.push(entry)
        return () => {
          const index = tools.indexOf(entry)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    prompt: {
      register(id: string, render: () => string, options?: { order?: number }) {
        const entry: CapturedPrompt = { id, render, ...(options?.order === undefined ? {} : { order: options.order }) }
        prompts.push(entry)
        const off = () => {
          const index = prompts.indexOf(entry)
          if (index >= 0) prompts.splice(index, 1)
        }
        promptsOff.push(off)
        return off
      },
    },
    transcript: {
      system(text: string) {
        systems.push(text)
      },
    },
    approval: {
      decide: async (request: Record<string, unknown>, signal: unknown) => {
        approvals.push({ request, signal })
        return decision
      },
    },
    session: {
      current: () => ({
        meta: { id: 'sess-1', cwd: WORKSPACE },
        filePath: join(WORKSPACE, 'sessions', 'a.jsonl'),
      }),
    },
  }

  const returned = mcpPlugin.apply(ctx as never, config) as unknown as (() => void) | undefined
  let disposed = false
  const harness: McpHarness = {
    tools,
    prompts,
    sections,
    service: service!,
    systems,
    approvals,
    promptsOff,
    setDecision(next) {
      decision = next
    },
    fireExit() {
      for (const handler of [...exitHandlers]) handler()
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (typeof returned === 'function') returned()
      for (const off of disposers.splice(0).reverse()) off()
    },
  }
  cleanups.push(() => harness.dispose())
  return harness
}

/** 一条 http server 配置（连接本身被 mock，只为了过清单校验）。 */
function entry(name = 'srv', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, transport: 'http', url: `https://${name}.invalid/mcp`, ...extra }
}

const listOf = (...servers: Array<Record<string, unknown>>): string => JSON.stringify(servers)

const toolContext = (sessionId = 'sess-1'): Record<string, unknown> => ({
  signal: new AbortController().signal,
  sessionId,
  sessionPath: join(WORKSPACE, 'sessions', `${sessionId}.jsonl`),
})

const signal = (): AbortSignal => new AbortController().signal

/** 等所有 server 进入指定状态。 */
async function waitStates(harness: McpHarness, state: string): Promise<void> {
  await vi.waitFor(() => {
    const states = harness.service.servers()
    expect(states.length).toBeGreaterThan(0)
    expect(states.every((server) => server.state === state)).toBe(true)
  })
}

describe('注册与连接', () => {
  test('服务与设置分区先挂上；初始 connecting，连上后 ready', async () => {
    serve(() => fakeConnection())
    const harness = runApply({ servers: listOf(entry()), reconnect: false })

    expect(harness.sections[0]).toMatchObject({ id: 'mcp', order: 47 })
    expect(harness.service.servers()).toMatchObject([{ name: 'srv', state: 'connecting', tools: 0 }])

    await waitStates(harness, 'ready')
    expect(openCalls).toHaveLength(1)
    expect(openCalls[0]!.options).toMatchObject({
      connectTimeoutMs: 20_000,
      callTimeoutMs: 60_000,
      cwd: WORKSPACE,
    })
  })

  test('能力开关决定两个全局工具；工具风险按 defaultRisk 与逐工具覆盖', async () => {
    serve((server) => {
      const conn = fakeConnection()
      conn.capabilities = server.name === 'beta'
        ? { resources: true, prompts: true }
        : { resources: false, prompts: false }
      conn.listTools.mockResolvedValue(server.name === 'alpha'
        ? [
            { name: 'read_tool', description: '读', inputSchema: { type: 'object', properties: {} } },
            { name: 'write_tool', description: '写', inputSchema: { type: 'object', properties: {} } },
          ]
        : [{ name: 'echo', description: '回声', inputSchema: { type: 'object', properties: {} } }])
      return conn
    })
    const harness = runApply({
      servers: listOf(
        { ...entry('alpha'), defaultRisk: 'read', risk: { write_tool: 'write' } },
        { ...entry('beta'), defaultRisk: 'exec' },
      ),
      reconnect: false,
    })
    await vi.waitFor(() => {
      expect(harness.service.servers().every((server) => server.state === 'ready')).toBe(true)
    })

    expect(harness.tools.map((tool) => tool.name).sort()).toEqual([
      'mcp__alpha__read_tool',
      'mcp__alpha__write_tool',
      'mcp__beta__echo',
      'mcp_prompts',
      'mcp_resources',
    ])
    expect(harness.tools.find((tool) => tool.name === 'mcp__alpha__read_tool')?.risk).toBe('read')
    expect(harness.tools.find((tool) => tool.name === 'mcp__alpha__write_tool')?.risk).toBe('write')
    expect(harness.tools.find((tool) => tool.name === 'mcp__beta__echo')?.risk).toBe('exec')
    expect(harness.tools.find((tool) => tool.name === 'mcp__alpha__read_tool')?.description)
      .toContain('MCP server：alpha')
    expect(harness.service.tools().map((tool) => tool.name).sort()).toEqual([
      'mcp__alpha__read_tool',
      'mcp__alpha__write_tool',
      'mcp__beta__echo',
    ])

    // 没有任何 server 声明能力时，两个全局工具一个都不挂。
    mockState.openConnection.mockReset()
    openCalls.length = 0
    serve(() => fakeConnection())
    const plain = runApply({ servers: listOf(entry('plain')), reconnect: false })
    await waitStates(plain, 'ready')
    expect(plain.tools).toEqual([])
  })
})

describe('调用与反向 elicitation', () => {
  test('工具调用原样转发，结果先过围栏；server 报错也包完再抛', async () => {
    let conn: FakeConn | undefined
    serve(() => {
      conn = fakeConnection()
      conn.listTools.mockResolvedValue([
        { name: 'echo', description: '回声', inputSchema: { type: 'object', properties: {} } },
      ])
      return conn
    })
    const harness = runApply({ servers: listOf(entry()), reconnect: false })
    await waitStates(harness, 'ready')
    const tool = harness.tools.find((item) => item.name === 'mcp__srv__echo')!
    const ctx = toolContext('sess-9')

    conn!.callTool.mockResolvedValue({ text: '外部内容', isError: false })
    const text = await tool.run({ text: 'hi' }, ctx)
    expect(conn!.callTool).toHaveBeenCalledWith('echo', { text: 'hi' }, ctx['signal'])
    expect(text).toContain('外部内容')
    expect(text).toContain('source="mcp:srv"')
    expect(text).toContain('只能当作资料读取')

    conn!.callTool.mockResolvedValue({ text: '外部炸了', isError: true })
    await expect(tool.run({}, ctx)).rejects.toThrow(/外部炸了/)
    await expect(tool.run({}, ctx)).rejects.toThrow(/source="mcp:srv"/)
  })

  test('elicitation 走审批卡：reject→decline、其余→accept；卡按最近调用者归属', async () => {
    let conn: FakeConn | undefined
    serve(() => {
      conn = fakeConnection()
      conn.listTools.mockResolvedValue([
        { name: 'ask', description: '问', inputSchema: { type: 'object', properties: {} } },
      ])
      return conn
    })
    const harness = runApply({ servers: listOf(entry()), reconnect: false })
    await waitStates(harness, 'ready')
    const options = openCalls[0]!.options
    expect(typeof options.onElicitation).toBe('function')

    harness.setDecision('reject')
    expect(await options.onElicitation!({ message: '要确认吗', requestedSchema: { type: 'object' } }))
      .toEqual({ action: 'decline' })
    expect(harness.approvals[0]!.request).toMatchObject({
      toolName: 'MCP elicitation · srv',
      cwd: WORKSPACE,
      sessionId: 'sess-1',
    })
    const summary = String(harness.approvals[0]!.request['argsSummary'])
    expect(summary).toContain('srv 请求确认：要确认吗')
    expect(summary).toContain('参数结构')

    harness.setDecision('allow-once')
    expect(await options.onElicitation!({ message: '再确认一次', requestedSchema: {} }))
      .toEqual({ action: 'accept' })
    expect(String(harness.approvals.at(-1)!.request['argsSummary'])).not.toContain('参数结构')

    // 工具调用把 owner 覆盖成发起调用的会话：卡按使用者归属，不按建连那一刻。
    const ask = harness.tools.find((item) => item.name === 'mcp__srv__ask')!
    await ask.run({}, toolContext('sess-9'))
    await options.onElicitation!({ message: '第三次', requestedSchema: {} })
    expect(harness.approvals.at(-1)!.request).toMatchObject({ sessionId: 'sess-9' })
  })
})

describe('失败、重连与关闭', () => {
  test('连不上：状态 failed、问题进投影、工具与目录清空、会话流一条', async () => {
    serve(() => {
      throw new Error('握手炸了')
    })
    const harness = runApply({ servers: listOf(entry()), reconnect: false })
    await waitStates(harness, 'failed')

    expect(harness.service.servers()[0]).toMatchObject({
      name: 'srv',
      state: 'failed',
      tools: 0,
      problem: expect.stringContaining('握手炸了'),
    })
    expect(harness.systems.join('\n')).toContain('MCP server srv 没连上：握手炸了')
    expect(harness.tools).toEqual([])
    expect(harness.service.tools()).toEqual([])
    await expect(harness.service.call('mcp__srv__echo', {}, signal())).rejects.toThrow('没有这个 MCP 工具')

    // reconnect: false 不安排重试。
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(openCalls).toHaveLength(1)
  })

  test('重连：按初始间隔退避重试，连续失败超过上限后放弃并说清怎么恢复', async () => {
    serve(() => {
      throw new Error('还不行')
    })
    const harness = runApply({
      servers: listOf(entry()),
      reconnect: true,
      reconnectInitialDelayMs: 1,
      reconnectMaxDelayMs: 1,
      reconnectMaxAttempts: 1,
    })
    await vi.waitFor(
      () => expect(harness.systems.join('\n')).toContain('连续 1 次没连上'),
      { timeout: 3_000 },
    )
    expect(openCalls.length).toBeGreaterThanOrEqual(2)
    expect(harness.systems.join('\n')).toContain('点「重连全部服务器」')

    const settled = openCalls.length
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(openCalls).toHaveLength(settled)
  })

  test('instructions 超过上限截断并挂进系统提示；dsc/exit 关连接、撤工具与提示', async () => {
    let conn: FakeConn | undefined
    serve(() => {
      conn = fakeConnection({ instructions: 'x'.repeat(4_100) })
      conn.listTools.mockResolvedValue([
        { name: 'echo', description: '回声', inputSchema: { type: 'object', properties: {} } },
      ])
      conn.capabilities = { resources: true, prompts: true }
      return conn
    })
    const harness = runApply({ servers: listOf(entry()), reconnect: false })
    await waitStates(harness, 'ready')
    await vi.waitFor(() => {
      expect(harness.prompts.some((prompt) => prompt.id === 'mcp-instructions-srv')).toBe(true)
    })
    const instruction = harness.prompts.find((prompt) => prompt.id === 'mcp-instructions-srv')!
    expect(instruction.order).toBe(55)
    expect(instruction.render()).toContain('…（说明过长已截断）')
    expect(instruction.render()).toContain('MCP 服务器「srv」')

    harness.fireExit()
    expect(conn!.close).toHaveBeenCalled()
    expect(harness.service.servers()).toEqual([])
    expect(harness.tools).toEqual([])
    expect(harness.prompts).toEqual([])
    expect(() => harness.dispose()).not.toThrow()
  })

  test('插件 disposer：停 server、撤工具、关连接，重复调用是空操作', async () => {
    let conn: FakeConn | undefined
    serve(() => {
      conn = fakeConnection({ instructions: '用法说明' })
      conn.listTools.mockResolvedValue([
        { name: 'echo', description: '回声', inputSchema: { type: 'object', properties: {} } },
      ])
      conn.capabilities = { resources: true, prompts: true }
      return conn
    })
    const harness = runApply({ servers: listOf(entry()), reconnect: false })
    await waitStates(harness, 'ready')
    expect(harness.tools.length).toBeGreaterThan(0)
    expect(harness.prompts.length).toBeGreaterThan(0)

    harness.dispose()
    expect(conn!.close).toHaveBeenCalled()
    expect(harness.service.servers()).toEqual([])
    expect(harness.tools).toEqual([])
    expect(harness.prompts).toEqual([])
    expect(() => harness.dispose()).not.toThrow()
  })
})

describe('设置分区与配置变更', () => {
  test('values 读当前配置；非法值抛错、数字取整、reconnect 认字符串', async () => {
    serve(() => fakeConnection())
    const harness = runApply({
      servers: listOf(entry()),
      callTimeoutMs: 1_234,
      reconnect: false,
      reconnectMaxAttempts: 3,
    })
    const section = harness.sections[0]!
    expect(section.values()).toMatchObject({
      servers: listOf(entry()),
      defaultRisk: 'exec',
      callTimeoutMs: 1_234,
      connectTimeoutMs: 20_000,
      reconnect: false,
      reconnectMaxAttempts: 3,
    })

    expect(() => section.save('servers', '[{"name":"x"}]')).toThrow('stdio，必须写 command')
    expect(() => section.save('defaultRisk', 'nope')).toThrow('defaultRisk 只能是')
    expect(() => section.save('callTimeoutMs', 'abc')).toThrow('要填数字')
    expect(() => section.save('nope', 1)).toThrow('这个分区没有这项')
    expect(() => section.action('nope')).toThrow('这个分区没有这个按钮')

    section.save('callTimeoutMs', 1_234.6)
    section.save('reconnect', 'true')
    const saved = JSON.parse(readFileSync(join(HOME, 'plugins.json'), 'utf8')) as {
      entries?: Array<{ file?: string; config?: Record<string, unknown> }>
    }
    expect(saved.entries?.find((item) => item.file === 'mcp')?.config).toMatchObject({
      callTimeoutMs: 1_235,
      reconnect: true,
    })
    expect(section.values()).toMatchObject({ callTimeoutMs: 1_235, reconnect: true })
  })

  test('只改风险不动连接；改连接参数重连；reload 重连全部；删 server 撤工具', async () => {
    const conns: FakeConn[] = []
    serve(() => {
      const conn = fakeConnection()
      conn.listTools.mockResolvedValue([
        { name: 'echo', description: '回声', inputSchema: { type: 'object', properties: {} } },
      ])
      conns.push(conn)
      return conn
    })
    const base = { ...entry('srv'), defaultRisk: 'read' }
    const harness = runApply({ servers: listOf(base), reconnect: false })
    await waitStates(harness, 'ready')
    const section = harness.sections[0]!
    expect(harness.tools.find((tool) => tool.name === 'mcp__srv__echo')?.risk).toBe('read')

    // 只改 defaultRisk：连接参数没变，不重连，只把已注册工具的风险改掉。
    section.save('servers', listOf({ ...base, defaultRisk: 'exec' }))
    await vi.waitFor(() => {
      expect(harness.tools.find((tool) => tool.name === 'mcp__srv__echo')?.risk).toBe('exec')
    })
    expect(openCalls).toHaveLength(1)

    // URL 变了：旧连接关掉、按新参数重连。
    section.save('servers', listOf({ ...entry('srv'), defaultRisk: 'exec', url: 'https://other.invalid/mcp' }))
    await vi.waitFor(() => expect(openCalls).toHaveLength(2))
    expect(conns[0]!.close).toHaveBeenCalled()
    await vi.waitFor(() => expect(harness.service.servers()[0]?.state).toBe('ready'))

    // 「重连全部服务器」按钮：再关一条、再起一条。
    expect(section.action('reload')).toContain('已按配置重新发起连接：1 个 server')
    await vi.waitFor(() => expect(openCalls).toHaveLength(3))
    expect(conns[1]!.close).toHaveBeenCalled()
    await vi.waitFor(() => expect(harness.service.servers()[0]?.state).toBe('ready'))

    // 清单清空：server 撤掉，工具与目录一起清。
    section.save('servers', '[]')
    await vi.waitFor(() => expect(harness.service.servers()).toEqual([]))
    expect(conns[2]!.close).toHaveBeenCalled()
    expect(harness.tools).toEqual([])
    expect(harness.service.tools()).toEqual([])
  })

  test('保存配置会把「失败且没有待重试计时器」的 server 推一把（retryIdle）', async () => {
    let attempts = 0
    serve(() => {
      attempts += 1
      if (attempts === 1) throw new Error('第一次没连上')
      return fakeConnection()
    })
    const base = { ...entry('srv'), defaultRisk: 'read' }
    const harness = runApply({ servers: listOf(base), reconnect: false })
    await waitStates(harness, 'failed')
    expect(openCalls).toHaveLength(1)

    // 保存同一份清单：配置没变，但 retryIdle 会把失败且无计时器的 server 重连一次。
    harness.sections[0]!.save('servers', listOf(base))
    await vi.waitFor(() => expect(harness.service.servers()[0]?.state).toBe('ready'))
    expect(openCalls).toHaveLength(2)
  })
})

describe('渐进披露与能力工具', () => {
  test('deferSchemas 只撤动手类（write/exec），restoreSchemas 全量挂回', async () => {
    let conn: FakeConn | undefined
    serve(() => {
      conn = fakeConnection()
      conn.listTools.mockResolvedValue([
        { name: 'read_tool', description: '读', inputSchema: { type: 'object', properties: {} } },
        { name: 'write_tool', description: '写', inputSchema: { type: 'object', properties: {} } },
        { name: 'exec_tool', description: '跑', inputSchema: { type: 'object', properties: {} } },
      ])
      return conn
    })
    const harness = runApply({
      servers: listOf({ ...entry('srv'), defaultRisk: 'exec', risk: { read_tool: 'read', write_tool: 'write' } }),
      reconnect: false,
    })
    await waitStates(harness, 'ready')
    expect(harness.tools.map((tool) => tool.name).sort()).toEqual([
      'mcp__srv__exec_tool',
      'mcp__srv__read_tool',
      'mcp__srv__write_tool',
    ])

    harness.service.deferSchemas()
    expect(harness.tools.map((tool) => tool.name)).toEqual(['mcp__srv__read_tool'])
    // 目录不因撤 schema 而变：检索仍能搜到那三个。
    expect(harness.service.tools()).toHaveLength(3)

    harness.service.restoreSchemas()
    expect(harness.tools).toHaveLength(3)
    harness.service.deferSchemas()
    harness.service.deferSchemas()
    expect(harness.tools).toHaveLength(1)
    harness.service.restoreSchemas()
    harness.service.restoreSchemas()
    expect(harness.tools).toHaveLength(3)
  })

  test('mcp_resources：list 报条数并更新状态投影，read 转发 uri，坏参数给人话', async () => {
    let conn: FakeConn | undefined
    serve(() => {
      conn = fakeConnection()
      conn.capabilities = { resources: true, prompts: false }
      conn.listResources.mockResolvedValue([
        { uri: 'file:///a.txt', name: 'A', description: '说明', mimeType: 'text/plain' },
      ])
      conn.readResource.mockResolvedValue({ text: '第一段', isError: false })
      return conn
    })
    const harness = runApply({ servers: listOf(entry()), reconnect: false })
    await waitStates(harness, 'ready')
    await vi.waitFor(() => expect(harness.service.servers()[0]?.resources).toBe(1))

    const tool = harness.tools.find((item) => item.name === 'mcp_resources')!
    expect(tool).toBeDefined()
    expect(tool.risk).toBe('read')
    expect(tool.parameters.required).toEqual(['action'])
    expect(tool.parameters.properties?.['action']?.enum).toEqual(['list', 'read'])

    const listed = await tool.run({ action: 'list' }, toolContext())
    expect(listed).toContain('「srv」1 个资源')
    expect(listed).toContain('file:///a.txt')
    expect(listed).toContain('source="mcp-resources"')

    const read = await tool.run({ action: 'read', uri: 'file:///a.txt' }, toolContext())
    expect(conn!.readResource).toHaveBeenCalledWith('file:///a.txt', expect.anything())
    expect(read).toContain('第一段')
    expect(read).toContain('source="mcp-resource:srv"')

    expect(await tool.run({ action: 'read' }, toolContext())).toContain('read 要带上 uri')
    expect(await tool.run({ action: 'dance' }, toolContext())).toContain('不认识的 action')
    await expect(tool.run({ action: 'list', server: 'nope' }, toolContext()))
      .rejects.toThrow('没有叫 nope 且已连上')

    // 连接断掉后：没有「还连着的 server」，空态也要有话说。
    openCalls[0]!.options.onClose()
    await vi.waitFor(() => expect(harness.service.servers()[0]?.state).toBe('failed'))
    expect(await tool.run({ action: 'list' }, toolContext()))
      .toContain('没有任何已连上的 server 声明 resources 能力')
  })

  test('mcp_prompts：list 报参数名单，get 把参数转成字符串并转发', async () => {
    let conn: FakeConn | undefined
    serve(() => {
      conn = fakeConnection()
      conn.capabilities = { resources: false, prompts: true }
      conn.listPrompts.mockResolvedValue([{ name: 'greet', description: '打招呼', arguments: ['who'] }])
      conn.getPrompt.mockResolvedValue({ text: '你好 小明', isError: false })
      return conn
    })
    const harness = runApply({ servers: listOf(entry()), reconnect: false })
    await waitStates(harness, 'ready')
    await vi.waitFor(() => expect(harness.service.servers()[0]?.prompts).toBe(1))

    const tool = harness.tools.find((item) => item.name === 'mcp_prompts')!
    expect(tool).toBeDefined()
    expect(tool.risk).toBe('read')
    expect(tool.parameters.properties?.['action']?.enum).toEqual(['list', 'get'])
    // 没声明 resources 就不该注册 mcp_resources。
    expect(harness.tools.some((item) => item.name === 'mcp_resources')).toBe(false)

    const listed = await tool.run({ action: 'list' }, toolContext())
    expect(listed).toContain('「srv」1 个提示模板')
    expect(listed).toContain('greet（参数：who）')
    expect(listed).toContain('source="mcp-prompts"')

    expect(await tool.run({ action: 'get' }, toolContext())).toContain('get 要带上模板名')
    const got = await tool.run({ action: 'get', name: 'greet', arguments: { who: '小明', n: 1 } }, toolContext())
    expect(conn!.getPrompt).toHaveBeenCalledWith('greet', { who: '小明', n: '1' }, expect.anything())
    expect(got).toContain('你好 小明')
    expect(got).toContain('source="mcp-prompt:srv"')
    expect(await tool.run({ action: 'dance' }, toolContext())).toContain('不认识的 action')

    // 连接断掉后：同样落到空态文案。
    openCalls[0]!.options.onClose()
    await vi.waitFor(() => expect(harness.service.servers()[0]?.state).toBe('failed'))
    expect(await tool.run({ action: 'list' }, toolContext()))
      .toContain('没有任何已连上的 server 声明 prompts 能力')
  })
})
