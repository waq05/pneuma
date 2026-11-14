/**
 * @pneuma/web-search 的包级测试：插件对象、设置分区，以及「请求怎么组、响应怎么解」。
 *
 * 为什么不连真 API：这个包的对外行为就是一次 HTTP POST，真打外网会让测试受网络、限流与
 * key 影响。迁移时把 `fetch` 换成假的实现，断言发出去的 URL / 头 / body 与解析回来的结果，
 * 错误分支（空 query、没配 key）走真实代码路径。
 *
 * 原测试有 5 条 check()，其中 4 条读 `index.ts` 源码文本（`name: 'web_search'`、
 * `required: ['query']`、域名说明等）。现在这些全部改成 `apply()` 后拿注册出来的工具对象，
 * 断言它的 name / risk / parameters。
 *
 * 环境隔离：`DSC_HOME` 指到 `mkdtempSync` 的临时目录，插件配置只落在临时目录。
 *
 * @module @pneuma/web-search/tests
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'

/** 捕获到的工具声明（只填断言用得到的字段）。 */
interface CapturedTool {
  name: string
  description: string
  risk: string
  parameters: {
    properties: Record<string, { type?: string; description?: string }>
    required?: string[]
  }
  run: (args: Record<string, unknown>, scope: Record<string, unknown>) => Promise<unknown>
}

/** 捕获到的提示段。 */
interface CapturedPrompt {
  id: string
  render: () => string
}

/** 捕获到的设置分区。 */
interface CapturedSection {
  id: string
  order?: number
  fields: () => Array<{ key: string; options?: Array<{ value: string }> }>
  values: () => Record<string, unknown>
}

/** 假 ctx 捕获到的注册面。 */
interface Captured {
  tools: CapturedTool[]
  prompts: CapturedPrompt[]
  sections: CapturedSection[]
  notices: unknown[]
}

const home = mkdtempSync(join(tmpdir(), 'dsc-web-search-spec-'))
const pluginsJson = join(home, 'plugins.json')
/** 调工具时给的作用域：只要 cwd 与 signal 是真的，其余字段这个包用不到。 */
const scope = { cwd: home, signal: new AbortController().signal, sessionId: 'spec-session', sessionPath: '' }

let webSearchPlugin: typeof import('../index.js')['webSearchPlugin']

beforeAll(async () => {
  process.env.DSC_HOME = home
  const policy = await import('@pneuma/runtime/core/path-policy.js')
  expect(policy.DSC_HOME).toBe(home)
  ;({ webSearchPlugin } = await import('../index.js'))
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 把 web-search 这一条配置写进临时 plugins.json（插件每次用值时现读磁盘）。 */
function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    pluginsJson,
    `${JSON.stringify({ version: 1, entries: [{ file: 'web-search', disabled: false, config }] }, null, 2)}\n`,
    'utf8',
  )
}

/** 删掉配置：回到「没配 key」的状态。 */
function clearConfig(): void {
  rmSync(pluginsJson, { force: true })
}

/** 假 ctx：apply 只用这几个面；effect 真跑回调，否则工具注册根本不会发生。 */
function applyPlugin(): Captured {
  const captured: Captured = { tools: [], prompts: [], sections: [], notices: [] }
  const ctx = {
    tools: {
      register: (entry: CapturedTool) => {
        captured.tools.push(entry)
        return () => {}
      },
    },
    prompt: {
      register: (id: string, render: () => string) => {
        captured.prompts.push({ id, render })
        return () => {}
      },
    },
    settings: {
      registerSection: (spec: CapturedSection) => {
        captured.sections.push(spec)
        return () => {}
      },
    },
    emit: (_event: string, payload: unknown) => {
      captured.notices.push(payload)
    },
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
  }
  // 假 ctx 只实现 apply 用到的面；真实 Context 的字段远多于它。
  webSearchPlugin.apply(ctx as unknown as Context, undefined)
  return captured
}

/** 取唯一注册出来的 web_search 工具；没注册就直接失败，免得后面报「undefined 上没有 run」。 */
function webSearchTool(captured: Captured): CapturedTool {
  const tool = captured.tools.find((entry) => entry.name === 'web_search')
  expect(tool, '配了 key 却没注册 web_search').toBeDefined()
  return tool as CapturedTool
}

/** 假搜索 API：记录请求，回给定 JSON。 */
function stubFetch(body: unknown): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return calls
}

// 第 1 条：插件对象本体——名字与它依赖的三个服务。
test('插件对象：名字与它依赖的三个服务', () => {
  expect(webSearchPlugin.name).toBe('web-search')
  expect([...(webSearchPlugin.inject as string[])]).toStrictEqual(['tools', 'prompt', 'settings'])
  expect(typeof webSearchPlugin.apply).toBe('function')
})

// 第 2 条：没配 key 时工具与提示词都不在场，并给用户一条去哪儿配的提示。
test('没配 key：不注册 web_search，提示词为空，发一条配置提示', () => {
  clearConfig()
  const captured = applyPlugin()
  expect(captured.tools).toStrictEqual([])
  expect(captured.notices).toHaveLength(1)
  expect(String(captured.notices[0])).toContain('还没配搜索服务的 key')
  const prompt = captured.prompts.find((entry) => entry.id === 'web-search')
  expect(prompt, '提示段应当注册').toBeDefined()
  // 没有 key 时提示词返回空串：不往系统提示里塞一段用不上的说明。
  expect(prompt?.render()).toBe('')
})

// 第 3 条：配了 key 就注册工具，名字/风险/必填项与三个入参都由注册对象给出。
test('配了 key：web_search 只读，必填只有 query，三个入参都在', () => {
  writeConfig({ provider: 'tavily', apiKey: 'test-key', maxResults: 2 })
  const captured = applyPlugin()
  const tool = webSearchTool(captured)
  expect(tool.risk).toBe('read')
  expect(tool.parameters.required).toStrictEqual(['query'])
  expect(Object.keys(tool.parameters.properties).sort()).toStrictEqual([
    'excludeDomains',
    'includeDomains',
    'query',
  ])
  expect(tool.parameters.properties['query']?.type).toBe('string')
  expect(tool.parameters.properties['includeDomains']?.type).toBe('array')
  // 配好 key 之后提示词才交代「用 web_search 查证」。
  const prompt = captured.prompts.find((entry) => entry.id === 'web-search')
  expect(prompt?.render()).toContain('web_search')
})

// 第 4 条：域名过滤的适用范围写在参数说明里（只有 tavily 有等价参数，别的提供方不硬凑）。
test('域名过滤参数的说明写明只有 tavily 生效', () => {
  writeConfig({ provider: 'tavily', apiKey: 'test-key' })
  const tool = webSearchTool(applyPlugin())
  expect(tool.parameters.properties['includeDomains']?.description).toContain('tavily')
  expect(tool.parameters.properties['excludeDomains']?.description).toContain('tavily')
})

// 第 5 条：空 query 在发请求之前就被拒——否则会白打一次 API 拿回一堆无关结果。
test('空 query 直接报错，不发请求', async () => {
  writeConfig({ provider: 'tavily', apiKey: 'test-key' })
  const calls = stubFetch({ results: [] })
  const tool = webSearchTool(applyPlugin())
  await expect(tool.run({ query: '   ' }, scope)).rejects.toThrow(/query 不能为空/)
  expect(calls).toHaveLength(0)
})

// 第 6 条：请求组装——URL、份数，以及 tavily 原生的 include/exclude_domains。
//
// F11（2026-11-14 修）：run() 算出的 headers 曾从没交给 search()（内部 postJson 一律空
// headers），真 API 一律 401，联网搜索一次都没成功过。现在 authorization 头是**预期行为**，
// 必须断言：头不在，key 就发不出去。
test('请求组装：tavily 的地址、认证头与域名过滤原样进请求', async () => {
  writeConfig({ provider: 'tavily', apiKey: 'test-key', maxResults: 2 })
  const calls = stubFetch({ results: [] })
  const tool = webSearchTool(applyPlugin())
  await tool.run(
    // 混进非字符串与空串：listOf 应当把它们滤掉，不能变成 [""] 或数字塞进 API。
    { query: ' pneuma ', includeDomains: ['example.com', '', 7], excludeDomains: ['bad.com'] },
    scope,
  )
  expect(calls).toHaveLength(1)
  const call = calls[0]!
  expect(call.url).toBe('https://api.tavily.com/search')
  expect(call.init.method).toBe('POST')
  expect((call.init.headers as Record<string, string>)['content-type']).toBe('application/json')
  expect((call.init.headers as Record<string, string>)['authorization']).toBe('Bearer test-key')
  expect(JSON.parse(String(call.init.body))).toStrictEqual({
    query: 'pneuma',
    max_results: 2,
    search_depth: 'basic',
    include_domains: ['example.com'],
    exclude_domains: ['bad.com'],
  })
})

test('F11：serper 走 X-API-KEY，bocha 走 Bearer（三家认证头各有其形）', async () => {
  writeConfig({ provider: 'serper', apiKey: 'test-key' })
  const serperCalls = stubFetch({ organic: [] })
  const tool = webSearchTool(applyPlugin())
  await tool.run({ query: 'pneuma' }, scope)
  expect((serperCalls[0]!.init.headers as Record<string, string>)['X-API-KEY']).toBe('test-key')

  writeConfig({ provider: 'bocha', apiKey: 'test-key' })
  const bochaCalls = stubFetch({ data: { webPages: { value: [] } } })
  const tool2 = webSearchTool(applyPlugin())
  await tool2.run({ query: 'pneuma' }, scope)
  expect((bochaCalls[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer test-key')
})

// 第 7 条：响应解析——三家字段名不同，这里按 tavily 的 title/url/content 归一；
// 文本进围栏，结构化来源清单供界面画卡片，条数顶到上限时标 truncated。
test('响应解析：归一成文本与来源清单，顶到上限标 truncated', async () => {
  writeConfig({ provider: 'tavily', apiKey: 'test-key', maxResults: 2 })
  stubFetch({
    results: [
      { title: 'Pneuma 文档', url: 'https://example.com/docs', content: '第一行\n\n  第二行  ' },
      { title: 'Pneuma 仓库', url: 'https://example.com/repo', content: '说明' },
    ],
  })
  const tool = webSearchTool(applyPlugin())
  const result = (await tool.run({ query: 'pneuma' }, scope)) as {
    text: string
    presentation: { result: { card: string; kind: string; sources: Array<Record<string, string>>; truncated: boolean } }
  }
  expect(result.text).toContain('搜索「pneuma」共 2 条结果（提供方 tavily）')
  expect(result.text).toContain('Pneuma 文档')
  expect(result.text).toContain('https://example.com/docs')
  const card = result.presentation.result
  expect(card.card).toBe('web')
  expect(card.kind).toBe('search')
  expect(card.sources).toStrictEqual([
    // 摘要里的连续空白折成一个空格：卡片与文本用的是同一段归一后的内容。
    { title: 'Pneuma 文档', url: 'https://example.com/docs', snippet: '第一行 第二行' },
    { title: 'Pneuma 仓库', url: 'https://example.com/repo', snippet: '说明' },
  ])
  expect(card.truncated).toBe(true)
})

// 第 8 条：调用时配置被删（用户在设置里清空了 key）→ 报错文案要指路，而不是空指针。
test('调用时没有 key：报错指向设置页', async () => {
  writeConfig({ provider: 'tavily', apiKey: 'test-key' })
  const tool = webSearchTool(applyPlugin())
  clearConfig()
  await expect(tool.run({ query: 'pneuma' }, scope)).rejects.toThrow(/还没配 API key/)
})

// 第 9 条：设置分区——id/order、提供方三档、份数上下限。
test('设置分区：id=web-search、order=46，提供方三档齐全', () => {
  const captured = applyPlugin()
  const section = captured.sections[0]
  expect(section?.id).toBe('web-search')
  expect(section?.order).toBe(46)
  const fields = section?.fields() ?? []
  const provider = fields.find((field) => field.key === 'provider')
  expect(provider?.options?.map((option) => option.value)).toStrictEqual(['tavily', 'bocha', 'serper'])
  // 份数上限写死在 20：搜索 API 本身也不回更多，界面上不该让人填出无效值。
  expect(fields.map((field) => field.key)).toContain('maxResults')
})
