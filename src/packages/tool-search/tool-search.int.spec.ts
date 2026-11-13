/**
 * 工具渐进披露（`tool_search` / `tool_describe` / `tool_call`）的自检
 * （integration 层，原 `scripts/tool-search-test.mjs`）。
 *
 * 为什么单开一条：会话里模型把 `tool_search` 当**全局工具目录**用，搜不到就回答用户
 * 「这台机器上没有网页搜索工具」——它其实只检索「撤下的工具」（MCP 的动手类 + 命中
 * 渐进披露规则的注册表工具）。这一节钉住三类事实：
 *   [1] 撤下真的发生（exec 的 bash 从台面消失、read 工具一个不动），三条桥接工具在台面上；
 *   [2] 搜得到撤下的那条、`tool_describe` 取得到 schema；
 *   [3] 搜不到时的文案把口径说清（只装撤下的 + 台面清单 + 「不等于这台机器没有」）。
 *
 * ## 为什么真起内核
 *
 * 撤下发生在工具注册表装配之后（插件把 `deferRules` 折成注册表的 keep/deny），桥接工具
 * 的 run 又依赖同一张表。只测 `shouldDeferTool` 证明不了「台面上真的少了 bash」。
 *
 * ## 隔离
 *
 * 临时 HOME 由 integration setup 提供；`plugins.json` 显式写，沙箱插件保持关闭
 * （Windows 上它启动会 spawn PowerShell 体检，可能挂住 worker）。
 *
 * @module @pneuma/tool-search/tool-search.int.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'
import { gateIdentity } from '@pneuma/runtime/core/tools.js'
import { DSC_HOME } from '@pneuma/runtime/core/path-policy.js'
import { DEFAULT_TOOL_SEARCH_CONFIG, shouldDeferTool } from './tool-search.js'

/** 一个工具条目里本文件用到的面。 */
interface ToolView {
  name: string
  description: string
  run(args: Record<string, unknown>, ctx: Record<string, unknown>): Promise<unknown> | unknown
}

/** 内核里本文件用到的服务面。 */
interface KernelSurface {
  tools: { list(): ToolView[] }
  session: { current(): { meta: { id: string }; filePath: string } }
}

/** 起好的内核与它的工具表视图。 */
interface Booted {
  kernel: BootedKernel
  tool(name: string): ToolView | undefined
  toolNames(): string[]
  runCtx: Record<string, unknown>
}

/** 写一份只打开 tool-search 的插件清单（沙箱保持关闭，理由见文件头）。 */
function writePlugins(deferRules: string[]): void {
  mkdirSync(DSC_HOME, { recursive: true })
  writeFileSync(
    join(DSC_HOME, 'plugins.json'),
    JSON.stringify(
      {
        version: 1,
        entries: [
          { file: 'sandbox', disabled: true },
          { file: 'memory', config: { enabled: false } },
          { file: 'tool-search', disabled: false, config: { deferRules } },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )
}

/** 按延后规则起一份内核（插件配置每次挂载时从 plugins.json 现读，所以可以起两份）。 */
async function boot(deferRules: string[]): Promise<Booted> {
  writePlugins(deferRules)
  const fake = await fakeLLM({ turns: ['本文件不跑回合'] })
  const kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
  kernels.push(kernel)
  llms.push(fake)
  const surface = kernel.ctx as unknown as KernelSurface
  const session = surface.session.current()
  return {
    kernel,
    tool: (name) => surface.tools.list().find((entry) => entry.name === name),
    toolNames: () => surface.tools.list().map((entry) => entry.name),
    runCtx: {
      cwd: process.cwd(),
      sessionId: session.meta.id,
      sessionPath: session.filePath,
      signal: new AbortController().signal,
    },
  }
}

const kernels: BootedKernel[] = []
const llms: FakeLLM[] = []

afterAll(async () => {
  for (const kernel of kernels) await kernel.dispose()
  for (const llm of llms) await llm.close()
})

describe('[1] 撤下与台面（`bash` 命中延后规则）', () => {
  let first: Booted
  beforeAll(async () => {
    first = await boot(['bash'])
  })

  test('三条桥接工具在台面上（插件真的挂上了）', () => {
    const names = first.toolNames()
    for (const name of ['tool_search', 'tool_describe', 'tool_call']) expect(names).toContain(name)
  })

  test('命中延后规则的 bash（exec）已从台面撤下', () => {
    expect(first.toolNames()).not.toContain('bash')
  })

  test('read 工具一个都没撤（撤了每次读都得先搜再调，多两次往返）', () => {
    const names = first.toolNames()
    for (const name of ['read', 'glob', 'grep']) expect(names).toContain(name)
  })

  test('搜 `bash` 命中（撤下的目录里就是它），并指向 tool_call', async () => {
    const found = String(await first.tool('tool_search')?.run({ query: 'bash' }, first.runCtx))
    expect(found).toMatch(/\b1\. bash\b/)
    expect(found).toContain('tool_call')
  })

  test('`tool_describe bash` 给出 schema 与「已从台面上撤下」的去向', async () => {
    const schema = String(await first.tool('tool_describe')?.run({ name: 'bash' }, first.runCtx))
    expect(schema).toContain('command')
    expect(schema).toContain('已从台面上撤下')
  })

  test('搜不到时的文案：只装撤下的 + 台面清单 + 「不等于这台机器没有」', async () => {
    const miss = String(
      await first.tool('tool_search')?.run({ query: '网页搜索 网络搜索 web search', limit: 15 }, first.runCtx),
    )
    // 这段文案就是那次报障的根因：模型以为搜不到 = 机器没有。
    expect(miss).toContain('只装**被撤下**的工具')
    expect(miss).toMatch(/台面上现有 \d+ 条，直接按真名调用：/)
    expect(miss).toContain('搜不到不等于这台机器没有这个工具')
    expect(miss).toMatch(/撤下的目录里有 \d+ 条/)
  })

  test('工具说明也写明「不是全局工具目录」', () => {
    const description = first.tool('tool_search')?.description ?? ''
    expect(description).toContain('不是全局工具目录')
    expect(description).toContain('不等于')
  })

  test('`tool_call` 拒绝再包一层桥接工具', async () => {
    await expect(first.tool('tool_call')?.run({ name: 'tool_search' }, first.runCtx)).rejects.toThrow(/本来就在台面上/)
  })

  test('`tool_call` 点名不存在的工具并指路 tool_search', async () => {
    await expect(first.tool('tool_call')?.run({ name: 'no_such_tool' }, first.runCtx)).rejects.toThrow(
      /没有这个工具[\s\S]*tool_search/,
    )
  })

  test('桥接工具报出真名（一次调用只问一遍守卫的大前提）', () => {
    const bridge = first.tool('tool_call')
    expect(bridge).toBeDefined()
    // 撤下的工具：守卫链看到的是真名与真实风险（不是 tool_call / exec）。
    const held = gateIdentity(bridge as unknown as Parameters<typeof gateIdentity>[0], { name: 'bash', arguments: { command: 'echo hi' } }, process.cwd())
    expect(held.name).toBe('bash')
    expect(held.risk).toBe('exec')
    expect((held.args as { command?: string }).command).toBe('echo hi')

    // 台面上的只读工具：按 read 判定（不再因为走 tool_call 就多弹一张卡）。
    const live = gateIdentity(bridge as unknown as Parameters<typeof gateIdentity>[0], { name: 'read', arguments: { file_path: 'a.ts' } }, process.cwd())
    expect(live.name).toBe('read')
    expect(live.risk).toBe('read')

    // 名字拼错：退回按桥自己判定，错误留给 run 报给模型。
    const badName = gateIdentity(bridge as unknown as Parameters<typeof gateIdentity>[0], { name: 'no_such_tool' }, process.cwd())
    expect(badName.name).toBe('tool_call')
    expect(badName.risk).toBe('exec')

    // 参数坏掉：仍按真名问一遍（参数退成空对象），run 里照样会报错。
    const badArgs = gateIdentity(bridge as unknown as Parameters<typeof gateIdentity>[0], { name: 'bash', arguments: '{不是 JSON' }, process.cwd())
    expect(badArgs.name).toBe('bash')
    expect(Object.keys(badArgs.args)).toHaveLength(0)

    // 想再包一层桥接工具：按桥自己判定（run 里会拒绝）。
    const nested = gateIdentity(bridge as unknown as Parameters<typeof gateIdentity>[0], { name: 'tool_search' }, process.cwd())
    expect(nested.name).toBe('tool_call')
  })
})

describe('[4] 目录为空时的话术（一份什么都不撤的内核）', () => {
  test('对照：这份内核什么都没撤，搜不到时说的是「是空的」并照样给台面清单', async () => {
    const empty = await boot(['这个规则谁都不命中'])
    expect(empty.toolNames()).toContain('bash')
    const miss = String(await empty.tool('tool_search')?.run({ query: 'bash' }, empty.runCtx))
    // 「共 0 条」会被读成「没有工具」；「是空的」才说得清是「没有撤下的」。
    expect(miss).toContain('撤下的目录是空的')
    expect(miss).toMatch(/台面上现有 \d+ 条/)
    expect(miss).toContain('bash')
  })
})

describe('[6] 撤下判定（纯函数；read 永不撤是安全底线）', () => {
  const tier3 = { ...DEFAULT_TOOL_SEARCH_CONFIG, tier: 3 as const, deferRules: [], keepTools: [] }

  test('tier 3：write 工具被撤', () => {
    expect(shouldDeferTool({ name: 'write', risk: 'write' }, tier3)).toBe(true)
  })

  test('tier 3：read 工具照样不撤（写 `*` 也拦得住）', () => {
    // 只读工具被撤 = 每次读都要先搜再调，多两次往返；安全底线也不接受这个代价。
    expect(shouldDeferTool({ name: 'read', risk: 'read' }, { ...tier3, deferRules: ['*'] })).toBe(false)
  })

  test('keepTools 保得住写类工具', () => {
    expect(shouldDeferTool({ name: 'bash', risk: 'exec' }, { ...tier3, keepTools: ['bash'] })).toBe(false)
  })

  test('tier 2 只撤命中规则的', () => {
    expect(shouldDeferTool({ name: 'bash', risk: 'exec' }, { ...tier3, tier: 2 as const, deferRules: ['edit'] })).toBe(false)
  })
})
