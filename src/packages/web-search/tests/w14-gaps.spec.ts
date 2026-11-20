/**
 * web-search 的 w14 补测：DeepSeek 回复里一块结果都没有时明说「没搜到」、
 * 博查 / Serper 的结果列表解析（字段名各自不同），以及插件卸载时的三个退订。
 *
 * 与 `web-search.spec.ts` 同一套假 ctx 与假 `fetch`；`DSC_HOME` 指临时目录，不联网。
 * 「没配 key」的用例不在这里：key 一律用 plugins.json 里的明文 `apiKey`，`apiKeyEnv`
 * 指向不存在的变量名，避免落到本机真实凭据。
 *
 * @module dsc/packages/web-search/tests/w14-gaps
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'

interface CapturedTool {
  name: string
  run: (args: Record<string, unknown>, scope: Record<string, unknown>) => Promise<unknown>
}

const home = mkdtempSync(join(tmpdir(), 'dsc-web-search-w14-'))
const pluginsJson = join(home, 'plugins.json')
const scope = { cwd: home, signal: new AbortController().signal, sessionId: 'spec-w14', sessionPath: '' }

type WebSearchModule = typeof import('../index.js')
let webSearchPlugin: WebSearchModule['webSearchPlugin']

beforeAll(async () => {
  process.env['DSC_HOME'] = home
  const policy = await import('@pneuma/runtime/core/path-policy.js')
  expect(policy.DSC_HOME).toBe(home)
  webSearchPlugin = (await import('../index.js')).webSearchPlugin
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // 临时目录留给系统清
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    pluginsJson,
    `${JSON.stringify({ version: 1, entries: [{ file: 'web-search', disabled: false, config }] }, null, 2)}\n`,
    'utf8',
  )
}

interface Harness {
  tools: CapturedTool[]
  offs: string[]
}

/** 假 ctx：effect 真跑回调并把退订标签收进 `offs`，apply 的返回值给调用方调用。 */
function applyPlugin(): Harness {
  const harness: Harness = { tools: [], offs: [] }
  const ctx = {
    tools: {
      register: (entry: CapturedTool) => {
        harness.tools.push(entry)
        return () => {
          harness.offs.push('tool')
        }
      },
    },
    prompt: {
      register: () => () => {
        harness.offs.push('prompt')
      },
    },
    settings: {
      registerSection: () => () => {
        harness.offs.push('section')
      },
    },
    emit: () => undefined,
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => undefined
    },
  }
  ;(harness as Harness & { dispose?: () => void }).dispose = webSearchPlugin.apply?.(ctx as unknown as Context, undefined) as
    (() => void) | undefined
  return harness
}

const toolOf = (harness: Harness): CapturedTool => {
  const tool = harness.tools.find((entry) => entry.name === 'web_search')
  expect(tool, '没注册 web_search').toBeDefined()
  return tool as CapturedTool
}

function stubFetch(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  )
}

/** 工具结果既有文本也有卡片数据：这里只取文本。 */
const textOf = (result: unknown): string =>
  typeof result === 'string' ? result : String((result as { text?: unknown }).text ?? '')

test('DeepSeek 回复里只有空的结果块：交回「没有搜到结果」，不拿模型正文冒充', async () => {
  writeConfig({ provider: 'deepseek', apiKeyEnv: 'DSC_SPEC_MISSING_KEY', apiKey: 'spec-key' })
  stubFetch({ content: [{ type: 'web_search_tool_result', content: [] }] })
  const text = textOf(await toolOf(applyPlugin()).run({ query: 'pneuma 的版本号' }, scope))
  expect(text).toContain('「pneuma 的版本号」没有搜到结果')
})

test('博查：data.webPages.value 里的 name / url / summary 归一成结果清单', async () => {
  writeConfig({ provider: 'bocha', apiKey: 'spec-key', maxResults: 2 })
  stubFetch({
    data: { webPages: { value: [{ name: '博查结果', url: 'https://example.com/bocha', summary: '博查摘要' }] } },
  })
  const text = textOf(await toolOf(applyPlugin()).run({ query: 'pneuma' }, scope))
  expect(text).toContain('博查结果')
  expect(text).toContain('https://example.com/bocha')
  expect(text).toContain('博查摘要')
  expect(text).toContain('提供方 bocha')
})

test('Serper：organic 里的 title / link / snippet 归一成结果清单', async () => {
  writeConfig({ provider: 'serper', apiKey: 'spec-key', maxResults: 2 })
  stubFetch({ organic: [{ title: 'Google 结果', link: 'https://example.com/serper', snippet: 'Google 摘要' }] })
  const text = textOf(await toolOf(applyPlugin()).run({ query: 'pneuma' }, scope))
  expect(text).toContain('Google 结果')
  expect(text).toContain('https://example.com/serper')
  expect(text).toContain('Google 摘要')
  expect(text).toContain('提供方 serper')
})

test('插件卸载：工具、提示段、设置分区三个退订各调一次', () => {
  writeConfig({ provider: 'tavily', apiKey: 'spec-key' })
  const harness = applyPlugin()
  const dispose = (harness as Harness & { dispose?: () => void }).dispose
  expect(typeof dispose).toBe('function')
  dispose?.()
  expect(harness.offs).toEqual(['tool', 'prompt', 'section'])
})
