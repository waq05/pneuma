/**
 * tool-search 插件装配面（`packages/tool-search/index.ts`）：真 `apply` + 假 ctx。
 *
 * 钉四件事：
 *   - 三个桥接工具挂上、设置分区挂上、按配置真正撤下注册表工具（含 keepTools / tier / 规则）；
 *   - `tool_search` 的索引、打分、limit 夹取与「没搜到」那段解释（它必须说清「撤下的目录」）；
 *   - `tool_describe` / `tool_call` 的解析、错误分支与转调（含 MCP 与 gateAs 身份）；
 *   - 设置保存后立刻换挡、卸载时把撤下的工具与 MCP schema 全部还回去。
 *
 * 假 ctx 的工具表按真实 ToolService 的语义实现（Map 按名字存、退订判等），否则
 * `withhold()` 那条「再注册一次随即退订」的技巧在测试里不会生效。
 *
 * @module dsc/packages/tool-search/tests/wiring.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

type ToolSearchIndexModule = typeof import('../index.js')

const HOME = mkdtempSync(join(tmpdir(), 'dsc-tool-search-wiring-'))
process.env['DSC_HOME'] = HOME

let toolSearchPlugin: ToolSearchIndexModule['toolSearchPlugin']

beforeAll(async () => {
  toolSearchPlugin = (await import('../index.js')).toolSearchPlugin
})

beforeEach(() => {
  mkdirSync(HOME, { recursive: true })
  // 配置在每次 mount 时现读磁盘：上一条用例 save 过的值必须清掉，否则会盖过本条传入的 config。
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // 临时目录留给系统清
  }
})

// ── 假 ctx ────────────────────────────────────────────────────────────────────

interface FakeTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  risk: string
  run(args: Record<string, unknown>, runCtx: any): Promise<string>
}

interface McpTool {
  name: string
  description: string
  server: string
  parameters: Record<string, unknown>
  risk: string
}

interface MountOptions {
  config?: Record<string, unknown>
  tools?: FakeTool[]
  mcp?: boolean
  mcpTools?: McpTool[]
}

interface Harness {
  tools: Map<string, FakeTool>
  sections: any[]
  mcpCalls: string[]
  toolCalls: Array<{ name: string; args: Record<string, unknown>; runCtx: any }>
  disposer: (() => void) | undefined
  tool(name: string): any
  section(): any
  list(): string[]
}

/** 造一条注册表工具：run 记下调用现场并回一行可断言的文本。 */
function entry(
  name: string,
  risk: string,
  description: string,
  calls: Harness['toolCalls'],
  extra: { parameters?: Record<string, unknown> } = {},
): FakeTool {
  return {
    name,
    description,
    risk,
    parameters: extra.parameters ?? { type: 'object', properties: { command: { type: 'string' } } },
    async run(args, runCtx) {
      calls.push({ name, args, runCtx })
      return `${name}:${JSON.stringify(args)}`
    },
  }
}

/** 挂一次插件：真 apply，假 ctx 按真实 ToolService 语义维护工具表。 */
function mount(options: MountOptions = {}): Harness {
  const tools = new Map<string, FakeTool>()
  const toolCalls: Harness['toolCalls'] = []
  for (const tool of options.tools ?? []) tools.set(tool.name, tool)

  const sections: any[] = []
  const mcpCalls: string[] = []
  const services = new Map<string, unknown>()

  if (options.mcp === true) {
    services.set('mcp', {
      servers: () => [],
      tools: () => options.mcpTools ?? [],
      async call(name: string, args: Record<string, unknown>) {
        mcpCalls.push(`call:${name}:${JSON.stringify(args)}`)
        return `mcp:${name}`
      },
      deferSchemas: () => mcpCalls.push('defer'),
      restoreSchemas: () => mcpCalls.push('restore'),
    })
  }

  const ctx = {
    effect(fn: () => unknown) {
      const result = fn()
      const off = typeof result === 'function' ? (result as () => void) : () => undefined
      return () => {
        try {
          off()
        } catch {
          // 卸载路径不抛
        }
      }
    },
    tools: {
      register(tool: FakeTool) {
        tools.set(tool.name, tool)
        return () => {
          if (tools.get(tool.name) === tool) tools.delete(tool.name)
        }
      },
      list: () => [...tools.values()],
      visible: () => [...tools.values()],
      project: () => () => undefined,
    },
    settings: {
      registerSection(section: any) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    get(name: string) {
      return services.get(name)
    },
  }

  const disposer = toolSearchPlugin.apply?.(ctx as never, options.config ?? {}) as (() => void) | undefined

  return {
    tools,
    sections,
    mcpCalls,
    toolCalls,
    disposer,
    tool: (name: string) => tools.get(name),
    section: () => sections[0],
    list: () => [...tools.keys()],
  }
}

/** 工具 run 的执行现场。 */
function runCtx(): { cwd: string; signal: AbortSignal; sessionId: string; sessionPath: string } {
  return {
    cwd: join(HOME, 'work'),
    signal: new AbortController().signal,
    sessionId: 'sess-1',
    sessionPath: join(HOME, 'sessions', 'sess-1.jsonl'),
  }
}

const MCP_TOOL: McpTool = {
  name: 'mcp__github__create_issue',
  description: '创建工单：在 GitHub 仓库里开一个 issue。',
  server: 'github',
  parameters: { type: 'object', properties: { title: { type: 'string' } } },
  risk: 'write',
}

// ── 注册与撤下 ────────────────────────────────────────────────────────────────

describe('注册与撤下', () => {
  test('三个桥接工具与设置分区挂上；默认档只撤 MCP，注册表里的 write 工具留着', () => {
    const harness = mount({
      tools: [
        entry('bash', 'write', '跑命令', []),
        entry('read-file', 'read', '读文件', []),
      ],
      mcp: true,
      mcpTools: [MCP_TOOL],
    })

    expect(harness.list().sort()).toEqual(['bash', 'read-file', 'tool_call', 'tool_describe', 'tool_search'])
    expect(harness.section()).toMatchObject({ id: 'tool-search', order: 47 })
    expect(harness.mcpCalls).toContain('defer')
    // 默认 tier 2 + 空 deferRules：注册表工具一条都不撤。
    expect(harness.tools.has('bash')).toBe(true)
    expect(harness.tools.has('read-file')).toBe(true)
  })

  test('tier 3：write / exec 注册表工具被撤下、read 常驻；检索-描述-转调整条路通', async () => {
    const calls: Harness['toolCalls'] = []
    const harness = mount({
      config: { tier: 3 },
      tools: [
        entry('bash', 'write', '跑命令', calls),
        entry('run-code', 'exec', '跑脚本', calls),
        entry('read-file', 'read', '读文件', calls),
      ],
    })
    expect(harness.tools.has('bash')).toBe(false)
    expect(harness.tools.has('run-code')).toBe(false)
    expect(harness.tools.has('read-file')).toBe(true)

    const search = harness.tool('tool_search')
    const hits = await search.run({ query: 'bash 命令' }, runCtx())
    expect(hits).toContain('bash')
    expect(hits).toContain('分数')
    expect(hits).toContain('撤下的目录共 2 条')

    const describe = await harness.tool('tool_describe').run({ name: 'bash' }, runCtx())
    expect(describe).toContain('bash（风险 write')
    expect(describe).toContain('已从台面上撤下')
    expect(describe).toContain('"command"')

    const called = await harness.tool('tool_call').run(
      { name: 'bash', arguments: { command: 'ls' } },
      runCtx(),
    )
    expect(called).toContain('bash:{"command":"ls"}')
    expect(calls.some((call) => call.name === 'bash' && call.runCtx.sessionId === 'sess-1')).toBe(true)
  })

  test('tier 1 不撤注册表；tier 2 只撤规则命中的；keepTools 在 tier 3 也兜得住', () => {
    const tier1 = mount({ config: { tier: 1 }, tools: [entry('bash', 'write', '跑命令', [])] })
    expect(tier1.tools.has('bash')).toBe(true)

    const tier2 = mount({
      config: { tier: 2, deferRules: ['exec-*'] },
      tools: [
        entry('bash', 'write', '跑命令', []),
        entry('exec-runner', 'exec', '跑脚本', []),
      ],
    })
    expect(tier2.tools.has('bash')).toBe(true)
    expect(tier2.tools.has('exec-runner')).toBe(false)

    const kept = mount({
      config: { tier: 3, keepTools: ['bash'] },
      tools: [
        entry('bash', 'write', '跑命令', []),
        entry('exec-runner', 'exec', '跑脚本', []),
      ],
    })
    expect(kept.tools.has('bash')).toBe(true)
    expect(kept.tools.has('exec-runner')).toBe(false)
  })
})

// ── tool_search ───────────────────────────────────────────────────────────────

describe('tool_search', () => {
  test('没搜到：说清「撤下的目录」与台面上现有工具，避免被读成「这台机器没有」', async () => {
    const harness = mount({ config: { tier: 3 }, tools: [entry('bash', 'write', '跑命令', [])] })
    const out = await harness.tool('tool_search').run({ query: '完全不相干的词' }, runCtx())
    expect(out).toContain('没搜到匹配的工具')
    expect(out).toContain('撤下的目录里有 1 条')
    expect(out).toContain('台面上现有')
    expect(out).toContain('tool_search')

    const empty = mount()
    const emptyOut = await empty.tool('tool_search').run({ query: '任意' }, runCtx())
    expect(emptyOut).toContain('撤下的目录是空的')
  })

  test('limit 夹取：0 收到 1、超上限收到 20、不写给配置条数；空 query 直接拒', async () => {
    const harness = mount({
      config: { tier: 3, searchLimit: 5 },
      tools: [
        entry('bash', 'write', '跑命令', []),
        entry('bash-runner', 'write', '跑 bash 脚本', []),
      ],
    })
    const search = harness.tool('tool_search')

    const one = await search.run({ query: 'bash', limit: 0 }, runCtx())
    expect(one).toContain('命中 1 条')

    const all = await search.run({ query: 'bash', limit: 999 }, runCtx())
    expect(all).toContain('命中 2 条')

    const configured = await search.run({ query: 'bash' }, runCtx())
    expect(configured).toContain('命中 2 条')

    await expect(search.run({ query: '  ' }, runCtx())).rejects.toThrow('query 不能为空')
  })

  test('MCP 工具也进检索：按 server 名与中文说明都能命中', async () => {
    const harness = mount({ config: { tier: 1 }, mcp: true, mcpTools: [MCP_TOOL] })
    const search = harness.tool('tool_search')

    const byServer = await search.run({ query: 'github issue' }, runCtx())
    expect(byServer).toContain('mcp__github__create_issue')

    const byChinese = await search.run({ query: '创建工单' }, runCtx())
    expect(byChinese).toContain('mcp__github__create_issue')
    expect(byChinese).toContain('创建工单')
  })
})

// ── tool_describe / tool_call ─────────────────────────────────────────────────

describe('tool_describe 与 tool_call', () => {
  test('tool_describe：空名/未知都拒；撤下的与台面上的都能取到 schema', async () => {
    const harness = mount({ config: { tier: 3 }, tools: [entry('bash', 'write', '跑命令', []), entry('read-file', 'read', '读文件', [])] })
    const describe = harness.tool('tool_describe')

    await expect(describe.run({ name: ' ' }, runCtx())).rejects.toThrow('name 不能为空')
    await expect(describe.run({ name: 'nope' }, runCtx())).rejects.toThrow('没有这个工具')

    const held = await describe.run({ name: 'bash' }, runCtx())
    expect(held).toContain('已从台面上撤下')
    const live = await describe.run({ name: 'read-file' }, runCtx())
    expect(live).toContain('就在台面上')
    const mcp = await (() => {
      const withMcp = mount({ config: { tier: 1 }, mcp: true, mcpTools: [MCP_TOOL] })
      return withMcp.tool('tool_describe').run({ name: 'mcp__github__create_issue' }, runCtx())
    })()
    expect(mcp).toContain('MCP server github')
    expect(mcp).toContain('"title"')
  })

  test('tool_call：空名/桥接工具/未知工具/坏参数各自拒；对象与 JSON 字符串都能转调', async () => {
    const harness = mount({ config: { tier: 3 }, tools: [entry('bash', 'write', '跑命令', [])] })
    const call = harness.tool('tool_call')

    await expect(call.run({}, runCtx())).rejects.toThrow('name 不能为空')
    await expect(call.run({ name: 'tool_search' }, runCtx())).rejects.toThrow('不用经 tool_call')
    await expect(call.run({ name: 'nope' }, runCtx())).rejects.toThrow('没有这个工具')
    await expect(call.run({ name: 'bash', arguments: '{坏 JSON' }, runCtx())).rejects.toThrow('不是合法 JSON')
    await expect(call.run({ name: 'bash', arguments: [1] }, runCtx())).rejects.toThrow('arguments 要是一个对象')
    await expect(call.run({ name: 'bash', arguments: 'null' }, runCtx())).rejects.toThrow('解析出来不是对象')

    const asString = await call.run({ name: 'bash', arguments: '{"command":"pwd"}' }, runCtx())
    expect(asString).toContain('bash:{"command":"pwd"}')

    const asObject = await call.run({ name: 'bash', arguments: { command: 'ls' } }, runCtx())
    expect(asObject).toContain('bash:{"command":"ls"}')

    const empty = await call.run({ name: 'bash', arguments: '   ' }, runCtx())
    expect(empty).toContain('bash:{}')
  })

  test('tool_call 转调 MCP：按真名走 mcp.call，结果原样回来', async () => {
    const harness = mount({ config: { tier: 1 }, mcp: true, mcpTools: [MCP_TOOL] })
    const out = await harness.tool('tool_call').run(
      { name: 'mcp__github__create_issue', arguments: { title: 'bug' } },
      runCtx(),
    )
    expect(out).toBe('mcp:mcp__github__create_issue')
    expect(harness.mcpCalls).toContain('call:mcp__github__create_issue:{"title":"bug"}')
  })

  test('gateAs：只在认得出目标时交出真名与真实风险；坏参数退回空对象但仍给身份', () => {
    const tools: FakeTool[] = [
      entry('bash', 'write', '跑命令', []),
      entry('read-file', 'read', '读文件', []),
    ]
    const harness = mount({ config: { tier: 3 }, tools })
    const gate = harness.tool('tool_call').gateAs.bind(harness.tool('tool_call'))
    const cwd = join(HOME, 'work')

    expect(gate({}, cwd)).toBeUndefined()
    expect(gate({ name: 'tool_call' }, cwd)).toBeUndefined()
    expect(gate({ name: 'nope' }, cwd)).toBeUndefined()
    expect(gate({ name: 'bash', arguments: { command: 'ls' } }, cwd)).toEqual({
      name: 'bash',
      risk: 'write',
      args: { command: 'ls' },
    })
    expect(gate({ name: 'bash', arguments: '{坏 JSON' }, cwd)).toEqual({ name: 'bash', risk: 'write', args: {} })
    expect(gate({ name: 'read-file' }, cwd)).toEqual({ name: 'read-file', risk: 'read', args: {} })
  })
})

// ── 设置分区与卸载 ────────────────────────────────────────────────────────────

describe('设置分区与卸载', () => {
  test('values 回当前配置；合法保存立刻换挡，非法值与带空格的清单被挡回', () => {
    const harness = mount({
      config: { deferMcpSchemas: false, tier: 2 },
      tools: [entry('bash', 'write', '跑命令', [])],
      mcp: true,
      mcpTools: [MCP_TOOL],
    })
    const section = harness.section()

    expect(section.values()).toMatchObject({
      deferMcpSchemas: false,
      tier: '2',
      deferRules: '',
      keepTools: '',
      searchLimit: 5,
    })

    expect(section.save('deferMcpSchemas', 'yes')).toContain('开关')
    expect(section.save('tier', 9)).toContain('档位')
    expect(section.save('searchLimit', 0)).toContain('条数')
    expect(section.save('searchLimit', 100)).toContain('条数')
    expect(section.save('deferRules', 'bad name')).toContain('空格')
    expect(section.save('keepTools', 'a b')).toContain('空格')
    expect(section.save('nope', 1)).toContain('nope')

    expect(section.save('tier', '3')).toBeUndefined()
    expect(section.values().tier).toBe('3')
    expect(harness.tools.has('bash')).toBe(false)

    expect(section.save('tier', 1)).toBeUndefined()
    expect(harness.tools.has('bash')).toBe(true)

    expect(section.save('tier', 2)).toBeUndefined()
    expect(section.save('deferRules', 'bash\n\nfoo, bar')).toBeUndefined()
    expect(section.values().deferRules).toBe('bash\nfoo\nbar')
    expect(harness.tools.has('bash')).toBe(false)

    expect(section.save('searchLimit', 7)).toBeUndefined()
    expect(section.values().searchLimit).toBe(7)
  })

  test('关掉 MCP 开关时当场 restoreSchemas；设置里的现状清单列得出撤下的工具', () => {
    const harness = mount({
      config: { tier: 3 },
      tools: [entry('bash', 'write', '跑命令', [])],
      mcp: true,
      mcpTools: [MCP_TOOL],
    })
    expect(harness.mcpCalls).toContain('defer')

    const fields = harness.section().fields() as Array<Record<string, unknown>>
    const withheld = fields.find((field) => field['label'] === '现在撤下了这些')
    expect(withheld?.['text']).toContain('bash')
    expect(withheld?.['text']).toContain('mcp__github__create_issue')

    expect(harness.section().save('deferMcpSchemas', false)).toBeUndefined()
    expect(harness.mcpCalls).toContain('restore')

    const off = mount({ config: { deferMcpSchemas: false }, mcp: true, mcpTools: [MCP_TOOL] })
    const emptyFields = off.section().fields() as Array<Record<string, unknown>>
    const emptyWithheld = emptyFields.find((field) => field['label'] === '现在撤下了这些')
    expect(emptyWithheld?.['text']).toContain('现在没有撤下任何工具')
  })

  test('卸载：桥接工具退订、撤下的注册表工具放回台面、MCP schema 收回', () => {
    const harness = mount({
      config: { tier: 3 },
      tools: [entry('bash', 'write', '跑命令', [])],
      mcp: true,
      mcpTools: [MCP_TOOL],
    })
    expect(harness.tools.has('bash')).toBe(false)
    expect(harness.disposer).toBeTypeOf('function')

    harness.disposer!()
    expect(harness.tools.has('bash')).toBe(true)
    expect(harness.tools.has('tool_search')).toBe(false)
    expect(harness.tools.has('tool_describe')).toBe(false)
    expect(harness.tools.has('tool_call')).toBe(false)
    expect(harness.mcpCalls).toContain('restore')
  })
})
