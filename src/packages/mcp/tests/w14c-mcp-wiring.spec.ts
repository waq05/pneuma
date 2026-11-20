/**
 * mcp 插件装配面的 W14-C 补测：清单坏掉、工具在掉线连接上被调、具名 server、
 * 取不到会话身份、建连途中被停用、配置改坏、状态行与合法 defaultRisk（`packages/mcp/index.ts`）。
 *
 * 连接层（`openConnection`）换成可编排的假连接（与既有的 `tests/wiring.spec.ts` 同一套做法），
 * 本文件只关心插件怎么接、怎么撤、怎么把失败说给人听；stdio/http 协议细节由
 * `w14c-mcp-stdio.spec.ts` 与既有 `connection.spec.ts` 负责，两边不重复。
 *
 * @module dsc/packages/mcp/tests/w14c-mcp-wiring
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { McpCapabilities, McpConnection, McpOpenOptions, McpServerConfig } from '../mcp.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-mcp-w14c-'))
const WORKSPACE = join(HOME, 'workspace')
process.env['DSC_HOME'] = HOME

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

const openCalls: Array<{ server: McpServerConfig; options: McpOpenOptions }> = []
type OpenImpl = (server: McpServerConfig) => FakeConn | Promise<FakeConn>

function serve(impl: OpenImpl): void {
  mockState.openConnection.mockImplementation(async (server: McpServerConfig, options: McpOpenOptions) => {
    openCalls.push({ server, options })
    return impl(server)
  })
}

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

interface CapturedTool {
  name: string
  risk: string
  run(args: Record<string, unknown>, ctx: Record<string, unknown>): Promise<string>
}

interface McpHarness {
  tools: CapturedTool[]
  sections: Array<{
    fields(): Array<{ key?: string; type?: string; text?: string }>
    values(): Record<string, unknown>
    save(key: string, value: unknown): void
    action(name: string): string
  }>
  service: {
    servers(): Array<{ name: string; state: string; problem?: string }>
    tools(): Array<{ name: string }>
    call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>
  }
  systems: string[]
  fireExit(): void
  dispose(): void
}

const cleanups: Array<() => void> = []

beforeAll(async () => {
  ;({ mcpPlugin } = await import('../index.js'))
})

beforeEach(() => {
  vi.clearAllMocks()
  openCalls.length = 0
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
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
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // 临时目录留给系统清
  }
})

/** 假 ctx 跑真 apply（与既有 wiring.spec 同一套）；`sessionThrows` 逼出会话身份兜底。 */
function runApply(over: { sessionThrows?: boolean; config?: Record<string, unknown> } = {}): McpHarness {
  const tools: CapturedTool[] = []
  const sections: McpHarness['sections'] = []
  const systems: string[] = []
  const exitHandlers: Array<() => void> = []
  const disposers: Array<() => void> = []
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
      register() {
        return () => {}
      },
    },
    transcript: {
      system(text: string) {
        systems.push(text)
      },
    },
    approval: { decide: async () => 'allow-once' },
    session: {
      current: () => {
        if (over.sessionThrows === true) throw new Error('没有当前会话')
        return {
          meta: { id: 'sess-1', cwd: WORKSPACE },
          filePath: join(WORKSPACE, 'sessions', 'a.jsonl'),
        }
      },
    },
  }

  const returned = mcpPlugin.apply(ctx as never, { reconnect: false, servers: listOf(entry()), ...over.config }) as unknown as
    (() => void) | undefined
  let disposed = false
  const harness: McpHarness = {
    tools,
    sections,
    service: service!,
    systems,
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

const entry = (name = 'srv'): Record<string, unknown> => ({
  name,
  transport: 'http',
  url: `https://${name}.invalid/mcp`,
})
const listOf = (...servers: Array<Record<string, unknown>>): string => JSON.stringify(servers)
const signal = (): AbortSignal => new AbortController().signal
const toolContext = (): Record<string, unknown> => ({
  signal: signal(),
  sessionId: 'sess-1',
  sessionPath: join(WORKSPACE, 'sessions', 'a.jsonl'),
})

/** 等所有 server 进入指定状态。 */
async function waitStates(harness: McpHarness, state: string): Promise<void> {
  await vi.waitFor(() => {
    const states = harness.service.servers()
    expect(states.length).toBeGreaterThan(0)
    expect(states.every((server) => server.state === state)).toBe(true)
  })
}

/** 读磁盘上 mcp 那一项的配置。 */
function diskConfig(): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(join(HOME, 'plugins.json'), 'utf8')) as {
    entries?: Array<{ file?: string; config?: Record<string, unknown> }>
  }
  return doc.entries?.find((item) => item.file === 'mcp')?.config ?? {}
}

describe('装配面的残余分支', () => {
  test('清单坏掉：写一条「这次一个都没连」的会话流，不连任何 server', () => {
    const harness = runApply({ config: { servers: '不是 JSON' } })
    expect(harness.systems.join('\n')).toContain('MCP 的服务器清单读不了')
    expect(harness.service.servers()).toEqual([])
    expect(openCalls).toHaveLength(0)
  })

  test('连接已经不可用：工具调用回一句「现在没连上」', async () => {
    let conn: FakeConn | undefined
    serve(() => {
      conn = fakeConnection()
      conn.listTools.mockResolvedValue([{ name: 'echo', description: '回声', inputSchema: { type: 'object', properties: {} } }])
      return conn
    })
    const harness = runApply()
    await waitStates(harness, 'ready')
    conn!.alive = false
    await expect(harness.service.call('mcp__srv__echo', {}, signal())).rejects.toThrow(/现在没连上/)
  })

  test('mcp_resources 指明 server：走具名 pickStates，只列这一台', async () => {
    serve(() => {
      const conn = fakeConnection()
      conn.capabilities = { resources: true, prompts: false }
      conn.listResources.mockResolvedValue([])
      return conn
    })
    const harness = runApply()
    await waitStates(harness, 'ready')
    const tool = harness.tools.find((item) => item.name === 'mcp_resources')
    if (tool === undefined) throw new Error('没有注册 mcp_resources')
    const listed = await tool.run({ action: 'list', server: 'srv' }, toolContext())
    expect(listed).toContain('「srv」0 个资源')
  })

  test('取不到会话身份：建连 cwd 用空串、owner 留空，不影响连上', async () => {
    serve(() => fakeConnection())
    const harness = runApply({ sessionThrows: true })
    await waitStates(harness, 'ready')
    expect(openCalls[0]!.options.cwd).toBe('')
  })

  test('建连途中插件被停用：握手完一发现已作废，把连接当场关掉', async () => {
    let releaseTools: (value: unknown[]) => void = () => {}
    const toolsReady = new Promise<unknown[]>((resolve) => {
      releaseTools = resolve
    })
    let conn: FakeConn | undefined
    serve(() => {
      conn = fakeConnection()
      conn.listTools.mockReturnValue(toolsReady)
      return conn
    })
    const harness = runApply()
    await vi.waitFor(() => expect(conn).toBeDefined())
    harness.fireExit()
    releaseTools([])
    await vi.waitFor(() => expect(conn!.close).toHaveBeenCalled())
    expect(harness.service.servers()).toEqual([])
  })

  test('配置在磁盘上改坏：applyConfig 说「沿用现在这些连接」', async () => {
    serve(() => fakeConnection())
    const harness = runApply()
    await waitStates(harness, 'ready')
    writeFileSync(
      join(HOME, 'plugins.json'),
      JSON.stringify({ version: 1, entries: [{ file: 'mcp', config: { servers: '[坏清单' } }] }),
      'utf8',
    )
    harness.sections[0]!.save('reconnect', true)
    expect(harness.systems.join('\n')).toContain('沿用现在这些连接')
  })

  test('状态行：连不上的 server 也在 fields() 里列出来', async () => {
    serve(() => {
      throw new Error('握手炸了')
    })
    const harness = runApply()
    await waitStates(harness, 'failed')
    const status = harness.sections[0]!.fields().find((field) => field.key === undefined && field.text !== undefined)
    expect(String(status?.text)).toContain('srv')
  })

  test('保存合法的 defaultRisk：写盘并回读', () => {
    const harness = runApply()
    harness.sections[0]!.save('defaultRisk', 'read')
    expect(diskConfig()).toMatchObject({ defaultRisk: 'read' })
    expect(harness.sections[0]!.values()).toMatchObject({ defaultRisk: 'read' })
  })
})
