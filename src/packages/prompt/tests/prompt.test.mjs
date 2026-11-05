/**
 * @pneuma/prompt 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：提示词分段注册要整套内核才立得住，这里只钉清单、包形态、入口对象，以及同包的纯函数 pruneToolResults（确定性、只切中间、最近几条不动）。
 * @module @pneuma/prompt/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
let passed = 0

const { promptPlugin } = await import(new URL('../../../../lib/packages/prompt/index.js', import.meta.url).href)
const { pruneToolResults, DEFAULT_TOOL_RESULT_PRUNE } = await import(
  new URL('../../../../lib/packages/prompt/tool-result-prune.js', import.meta.url).href
)

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  assert.ok(patch.includes('id: prompt'))
  assert.ok(patch.includes("name: '@pneuma/prompt'"))
  passed += 1
})

test('包形态：ESM、两个导出子路径、patch 声明自洽', () => {
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.exports['.'].default)
  assert.ok(pkg.exports['./package.json'])
  if (pkg.pneuma?.library === true) {
    assert.equal(pkg.pneuma?.bundle, undefined)
  } else {
    assert.equal(pkg.pneuma?.bundle?.patch, './cordis.patch.yml')
  }
  passed += 1
})

test('入口：lib 产物里的插件对象有名字与 apply', () => {
  assert.equal(typeof promptPlugin.name, 'string')
  assert.ok([pkg.name.split('/').at(-1), 'prompt'].includes(promptPlugin.name))
  assert.equal(typeof promptPlugin.apply, 'function')
  passed += 1
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'))
  assert.ok(readme.includes('## Known Limitations'))
  passed += 1
})

test('修剪：超长工具结果只切中间，两头与省掉的字数都在', () => {
  const long = 'x'.repeat(DEFAULT_TOOL_RESULT_PRUNE.thresholdChars + 500)
  const recent = Array.from({ length: DEFAULT_TOOL_RESULT_PRUNE.keepRecent }, () => ({ role: 'tool', content: '最近的结果' }))
  const messages = [{ role: 'tool', content: long }, ...recent]
  const pruned = pruneToolResults(messages)
  assert.notEqual(pruned, messages)
  assert.ok(pruned[0].content.length < long.length)
  assert.match(pruned[0].content, /省掉了 \d+ 个字符/)
  assert.ok(pruned[0].content.startsWith('x'.repeat(DEFAULT_TOOL_RESULT_PRUNE.headChars)))
  assert.ok(pruned[0].content.endsWith('x'.repeat(DEFAULT_TOOL_RESULT_PRUNE.tailChars)))
  assert.equal(pruned[1], messages[1])
  passed += 1
})

test('修剪：不用切或预算不自洽时原样返回同一份数组', () => {
  const short = [{ role: 'tool', content: '短结果' }]
  assert.equal(pruneToolResults(short), short)
  const oversized = [{ role: 'tool', content: 'x'.repeat(10_000) }]
  const badBudget = { thresholdChars: 100, headChars: 60, tailChars: 60, keepRecent: 1 }
  assert.equal(pruneToolResults(oversized, badBudget), oversized)
  passed += 1
})

after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
