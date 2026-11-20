/**
 * tool-search 的 w14 补测：`tool-search.ts` 的索引 size 与配置报错分支，
 * `index.ts` 的「只活在台面上」工具的真转调、以及关掉 MCP 开关时的现状文案。
 *
 * 装配面用真 `apply` + 假 ctx（与 `wiring.spec.ts` 同一套语义）；配置每次现读临时
 * `DSC_HOME` 下的 plugins.json，绝不碰真实 `~/.dsc`。
 *
 * @module dsc/packages/tool-search/tests/w14-gaps
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { ToolSearchIndex, resolveToolSearchConfig } from '../tool-search.js'

type ToolSearchModule = typeof import('../index.js')

const HOME = mkdtempSync(join(tmpdir(), 'dsc-tool-search-w14-'))
process.env['DSC_HOME'] = HOME

let toolSearchPlugin: ToolSearchModule['toolSearchPlugin']

beforeAll(async () => {
  toolSearchPlugin = (await import('../index.js')).toolSearchPlugin
})

beforeEach(() => {
  mkdirSync(HOME, { recursive: true })
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

// ── tool-search.ts：索引与配置校验 ─────────────────────────────────────────────

describe('ToolSearchIndex.size', () => {
  test('空索引是 0，加两篇文档后是 2（同名重复加不去重，调用方自己保证）', async () => {
    const index = new ToolSearchIndex()
    expect(index.size).toBe(0)
    index.add({ name: 'bash', summary: '跑命令', description: '在终端里跑一条命令' })
    expect(index.size).toBe(1)
    index.add({ name: 'read-file', summary: '读文件', description: '按路径读一个文件的正文' })
    expect(index.size).toBe(2)
  })
})

describe('resolveToolSearchConfig 的报错分支', () => {
  test('不是对象：null / 数组 / 字符串都报「配置要是一个对象」', () => {
    for (const raw of [null, [], 'tier']) {
      expect(() => resolveToolSearchConfig(raw), `原始值 ${JSON.stringify(raw)}`).toThrow(/配置要是一个对象/)
    }
  })

  test('不认识的配置项点名「哪个键」并列出它认得的键', () => {
    expect(() => resolveToolSearchConfig({ tier: 2, bogus: true })).toThrow(/不认识配置项「bogus」/)
    expect(() => resolveToolSearchConfig({ bogus: true })).toThrow(/它认得的是/)
  })

  test('deferMcpSchemas 收到非布尔值：报出原值', () => {
    expect(() => resolveToolSearchConfig({ deferMcpSchemas: 'yes' })).toThrow(/deferMcpSchemas 只能是 true 或 false/)
  })

  test('名字清单里混进非字符串：报字段名与元素的 typeof', () => {
    expect(() => resolveToolSearchConfig({ deferRules: ['ok', 7] })).toThrow(/deferRules 只能是字符串数组，里面有 number/)
    expect(() => resolveToolSearchConfig({ keepTools: [null] })).toThrow(/keepTools 只能是字符串数组，里面有 object/)
  })

  test('名字清单既不是数组也不是字符串：报字段名与原值', () => {
    expect(() => resolveToolSearchConfig({ deferRules: 42 })).toThrow(/deferRules 要么是多行文本，要么是字符串数组，收到 42/)
    expect(() => resolveToolSearchConfig({ keepTools: { a: 1 } })).toThrow(/keepTools 要么是多行文本，要么是字符串数组/)
  })
})

// ── index.ts：装配面 ──────────────────────────────────────────────────────────

interface FakeTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  risk: string
  run(args: Record<string, unknown>, runCtx: Record<string, unknown>): Promise<string>
}

interface Harness {
  tools: Map<string, FakeTool>
  sections: any[]
  toolCalls: Array<{ name: string; args: Record<string, unknown>; runCtx: Record<string, unknown> }>
  tool(name: string): any
  section(): any
}

function mount(options: { config?: Record<string, unknown>; tools?: FakeTool[] } = {}): Harness {
  const tools = new Map<string, FakeTool>()
  for (const tool of options.tools ?? []) tools.set(tool.name, tool)
  const toolCalls: Harness['toolCalls'] = []
  const sections: any[] = []
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
    get() {
      return undefined
    },
  }
  toolSearchPlugin.apply?.(ctx as never, options.config ?? {})
  return {
    tools,
    sections,
    toolCalls,
    tool: (name: string) => tools.get(name),
    section: () => sections[0],
  }
}

function entry(name: string, risk: string, description: string): FakeTool {
  return {
    name,
    description,
    risk,
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    async run() {
      return 'ran'
    },
  }
}

function runCtx(): { cwd: string; signal: AbortSignal; sessionId: string; sessionPath: string } {
  return {
    cwd: join(HOME, 'work'),
    signal: new AbortController().signal,
    sessionId: 'sess-w14',
    sessionPath: join(HOME, 'sessions', 'sess-w14.jsonl'),
  }
}

test('tool_call 转调只活在台面上的注册表工具：真 run 那条 entry，runCtx 原样传下去', async () => {
  const called: Harness['toolCalls'] = []
  const bash: FakeTool = {
    name: 'bash',
    description: '跑命令',
    risk: 'write',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    async run(args, runCtx) {
      called.push({ name: 'bash', args, runCtx })
      return `bash:${JSON.stringify(args)}`
    },
  }
  // 默认档（tier 2 + 空规则）不撤 registry 工具：bash 只在台面上，不在撤下目录里。
  const harness = mount({ tools: [bash] })
  expect(harness.tools.has('bash')).toBe(true)

  const context = runCtx()
  const out = await harness.tool('tool_call').run({ name: 'bash', arguments: { command: 'pwd' } }, context)
  expect(out).toContain('bash:{"command":"pwd"}')
  expect(called).toHaveLength(1)
  expect(called[0]!.args).toEqual({ command: 'pwd' })
  // 真正的 runCtx 被原样交给那条工具（会话归属、取消信号、工作目录都在）。
  expect(called[0]!.runCtx).toMatchObject({
    cwd: context.cwd,
    sessionId: 'sess-w14',
    sessionPath: context.sessionPath,
  })
  expect(called[0]!.runCtx['signal']).toBe(context.signal)
})

test('关掉 MCP 开关但注册表仍有撤下的工具：现状清单写「MCP 的 schema 没撤」', () => {
  const harness = mount({
    config: { tier: 3, deferMcpSchemas: false },
    tools: [entry('bash', 'write', '跑命令')],
  })
  expect(harness.tools.has('bash')).toBe(false)
  const fields = harness.section().fields() as Array<Record<string, unknown>>
  const withheld = fields.find((field) => field['label'] === '现在撤下了这些')
  const text = String(withheld?.['text'] ?? '')
  expect(text).toContain('MCP 工具的 schema 没撤（开关关着）')
  expect(text).toContain('注册表工具 1 条：bash')
})
