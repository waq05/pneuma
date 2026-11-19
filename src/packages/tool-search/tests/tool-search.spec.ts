/**
 * @pneuma/tool-search 的包级测试：钉 6 条不变量。
 *
 * 为什么只钉这些：检索索引要真实工具表，留在集成探针里；能便宜钉住的是装配面、包形态、
 * 入口、文档，以及 glob 匹配与「撤下哪条工具」这两条纯逻辑。
 *
 * 迁移说明：原测试读 `lib/` 产物；现在直接 import src 的插件对象与纯函数，
 * 断言从 node:assert 换成 Vitest。撤下策略补了一条 tier 2 的默认档行为。
 *
 * @module @pneuma/tool-search/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { toolSearchPlugin } from '../index.js'
import { DEFAULT_TOOL_SEARCH_CONFIG, matchesToolGlob, shouldDeferTool } from '../tool-search.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  type?: string
  exports?: Record<string, unknown>
  pneuma?: { library?: boolean; bundle?: { patch?: string } }
}

const pkg = JSON.parse(read('../package.json')) as PackageJson

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/tool-search', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch, '装配行的 id 必须正好是 tool-search').toMatch(/^\s*-\s*id: tool-search\s*$/m)
  expect(patch, "装配行的 name 必须是 '@pneuma/tool-search'").toContain("name: '@pneuma/tool-search'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml（库包则相反）。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports?.['.'], 'exports 必须有 "."').toBeDefined()
  expect(pkg.exports?.['./package.json'], 'exports 必须有 "./package.json"').toBeDefined()
  if (pkg.pneuma?.library === true) {
    expect(pkg.pneuma?.bundle, '库包不该有 bundle.patch').toBeUndefined()
  } else {
    expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
  }
})

// 入口真能加载：插件名 = 包名最后一段 = 装配行的 id。
test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof toolSearchPlugin).toBe('object')
  expect(typeof toolSearchPlugin.name).toBe('string')
  expect(toolSearchPlugin.name).toBe(pkg.name.split('/').pop())
  expect(toolSearchPlugin.name).toBe('tool-search')
  expect(typeof toolSearchPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme, '缺 ## Model Experience').toContain('## Model Experience')
  expect(readme, '缺 ## Known Limitations').toContain('## Known Limitations')
})

// glob 匹配：只认 *，大小写不敏感；不带 * 的模式必须整名相等（子串不算命中）。
test('工具名 glob：* 通配且大小写不敏感，不带 * 就要求整名相等', () => {
  expect(matchesToolGlob('mcp__github__*', 'mcp__github__create_issue')).toBe(true)
  expect(matchesToolGlob('MCP__GITHUB__*', 'mcp__github__create_issue')).toBe(true)
  expect(matchesToolGlob('read*', 'write')).toBe(false)
  expect(matchesToolGlob('read', 'readFile')).toBe(false)
})

// 撤下策略：只读工具永不撤（撤了每次读多两步），tier 3 撤 write，keepTools 能兜住。
test('撤下策略：read 永不撤，tier 3 撤 write，keepTools 能兜住', () => {
  const tier3 = { ...DEFAULT_TOOL_SEARCH_CONFIG, tier: 3 as const }
  expect(shouldDeferTool({ name: 'bash', risk: 'write' }, tier3)).toBe(true)
  expect(shouldDeferTool({ name: 'read', risk: 'read' }, tier3)).toBe(false)
  const kept = { ...tier3, keepTools: ['bash'] }
  expect(shouldDeferTool({ name: 'bash', risk: 'write' }, kept)).toBe(false)
  const tier1 = { ...DEFAULT_TOOL_SEARCH_CONFIG, tier: 1 as const }
  expect(shouldDeferTool({ name: 'bash', risk: 'write' }, tier1)).toBe(false)
  // 缺省档是 2：write 工具不该在默认设置下被撤（撤它要用户显式提到 3 档）。
  expect(DEFAULT_TOOL_SEARCH_CONFIG.tier).toBe(2)
})
