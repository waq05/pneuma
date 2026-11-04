/**
 * @pneuma/tools-default 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：工具真跑要子进程与磁盘，留在集成探针里；能便宜钉住的是装配面、包形态、
 * 入口、文档，以及两个纯函数（glob 花括号展开、bash 输出截断）。
 * @module @pneuma/tools-default/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
let passed = 0

const pkg = JSON.parse(read('../package.json'))
const mod = await import('../../../../lib/packages/tools-default/index.js')
const search = await import('../../../../lib/packages/tools-default/search-tools.js')
const bash = await import('../../../../lib/packages/tools-default/bash.js')

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/tools-default', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /^\s*-\s*id: tools-default\s*$/m, '装配行的 id 必须正好是 tools-default')
  assert.ok(patch.includes("name: '@pneuma/tools-default'"), "装配行的 name 必须是 '@pneuma/tools-default'")
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
  assert.equal(typeof mod.toolsDefaultPlugin, 'object')
  assert.equal(typeof mod.toolsDefaultPlugin.name, 'string')
  assert.equal(mod.toolsDefaultPlugin.name, pkg.name.split('/').pop())
  assert.equal(mod.toolsDefaultPlugin.name, 'tools-default')
  assert.equal(typeof mod.toolsDefaultPlugin.apply, 'function')
  passed += 1
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), '缺 ## Model Experience')
  assert.ok(readme.includes('## Known Limitations'), '缺 ## Known Limitations')
  passed += 1
})

// 花括号展开：只有真带逗号的多选才展开；单值按字面量处理；缺右括号直接报错，不静默空结果。
test('glob 花括号：{a,b} 展开，{a} 不展开，缺 } 报错', () => {
  assert.deepEqual(search.expandBraces('src/*.{js,ts}'), ['src/*.js', 'src/*.ts'])
  assert.deepEqual(search.expandBraces('src/{a}'), ['src/{a}'])
  assert.deepEqual(search.expandBraces('src/*.js'), ['src/*.js'])
  assert.throws(() => search.expandBraces('src/*.{js'), /没有配对的/)
  passed += 1
})

// 输出截断：留头 60% + 尾 40%，中间写明省略多少字符；没超预算就原样返回。
test('bash 输出截断：头 60% + 尾 40%，短输出不动', () => {
  const out = bash.truncateBashOutput('A'.repeat(100), 10)
  assert.ok(out.startsWith('A'.repeat(6)), '头应保留 6 个字符（10 的 60%）')
  assert.ok(out.endsWith('A'.repeat(4)), '尾应保留 4 个字符（10 的 40%）')
  assert.ok(out.includes('中间省略 90 字符'), '中间要写明省略了多少字符')
  assert.equal(bash.truncateBashOutput('短输出', 10), '短输出')
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
