/**
 * @pneuma/tool-search 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：检索索引要真实工具表，留在集成探针里；能便宜钉住的是装配面、包形态、入口、
 * 文档，以及 glob 匹配与「撤下哪条工具」这两条纯逻辑。
 * @module @pneuma/tool-search/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
let passed = 0

const pkg = JSON.parse(read('../package.json'))
const mod = await import('../../../../lib/packages/tool-search/index.js')
const ts = await import('../../../../lib/packages/tool-search/tool-search.js')

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/tool-search', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /^\s*-\s*id: tool-search\s*$/m, '装配行的 id 必须正好是 tool-search')
  assert.ok(patch.includes("name: '@pneuma/tool-search'"), "装配行的 name 必须是 '@pneuma/tool-search'")
  passed += 1
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml（库包则相反）。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.exports['.'], 'exports 必须有 "."')
  assert.ok(pkg.exports['./package.json'], 'exports 必须有 "./package.json"')
  if (pkg.pneuma.library === true) {
    assert.equal(pkg.pneuma.bundle, undefined, '库包不该有 bundle.patch')
  } else {
    assert.equal(pkg.pneuma.bundle.patch, './cordis.patch.yml')
  }
  passed += 1
})

// 入口真能加载：lib 产物已构建，这里直接 import 并检查插件对象的三件事。
test('lib 入口能加载，插件名与 apply 对得上', () => {
  assert.equal(typeof mod.toolSearchPlugin, 'object')
  assert.equal(typeof mod.toolSearchPlugin.name, 'string')
  assert.equal(mod.toolSearchPlugin.name, pkg.name.split('/').pop())
  assert.equal(mod.toolSearchPlugin.name, 'tool-search')
  assert.equal(typeof mod.toolSearchPlugin.apply, 'function')
  passed += 1
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), '缺 ## Model Experience')
  assert.ok(readme.includes('## Known Limitations'), '缺 ## Known Limitations')
  passed += 1
})

// glob 匹配：只认 *，大小写不敏感；不带 * 的模式必须整名相等（子串不算命中）。
test('工具名 glob：* 通配且大小写不敏感，不带 * 就要求整名相等', () => {
  assert.equal(ts.matchesToolGlob('mcp__github__*', 'mcp__github__create_issue'), true)
  assert.equal(ts.matchesToolGlob('MCP__GITHUB__*', 'mcp__github__create_issue'), true)
  assert.equal(ts.matchesToolGlob('read*', 'write'), false)
  assert.equal(ts.matchesToolGlob('read', 'readFile'), false)
  passed += 1
})

// 撤下策略：只读工具永不撤（撤了每次读多两步），tier 3 撤 write，keepTools 能兜住。
test('撤下策略：read 永不撤，tier 3 撤 write，keepTools 能兜住', () => {
  const tier3 = { ...ts.DEFAULT_TOOL_SEARCH_CONFIG, tier: 3 }
  assert.equal(ts.shouldDeferTool({ name: 'bash', risk: 'write' }, tier3), true)
  assert.equal(ts.shouldDeferTool({ name: 'read', risk: 'read' }, tier3), false)
  const kept = { ...tier3, keepTools: ['bash'] }
  assert.equal(ts.shouldDeferTool({ name: 'bash', risk: 'write' }, kept), false)
  const tier1 = { ...ts.DEFAULT_TOOL_SEARCH_CONFIG, tier: 1 }
  assert.equal(ts.shouldDeferTool({ name: 'bash', risk: 'write' }, tier1), false)
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
