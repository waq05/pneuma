/**
 * @pneuma/session-search 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：这个包对外只有插件对象与切词证据（索引本体要会话与磁盘，留在集成探针里），
 * 再加上清单、装配行与文档，就是能便宜钉住的全集。
 * @module @pneuma/session-search/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
let passed = 0

const pkg = JSON.parse(read('../package.json'))
const mod = await import('../../../../lib/packages/session-search/index.js')
const idx = await import('../../../../lib/packages/session-search/session-index.js')

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/session-search', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /^\s*-\s*id: session-search\s*$/m, '装配行的 id 必须正好是 session-search')
  assert.ok(patch.includes("name: '@pneuma/session-search'"), "装配行的 name 必须是 '@pneuma/session-search'")
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
  assert.equal(typeof mod.sessionSearchPlugin, 'object')
  assert.equal(typeof mod.sessionSearchPlugin.name, 'string')
  assert.equal(mod.sessionSearchPlugin.name, pkg.name.split('/').pop())
  assert.equal(mod.sessionSearchPlugin.name, 'session-search')
  assert.equal(typeof mod.sessionSearchPlugin.apply, 'function')
  passed += 1
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), '缺 ## Model Experience')
  assert.ok(readme.includes('## Known Limitations'), '缺 ## Known Limitations')
  passed += 1
})

// 切词：建索引时中文逐字记 1-gram，查询单字才搜得到；两字以上查询只取相邻 2-gram。
test('中文切词：索引带单字，查询按相邻两字，不会拿单字凑命中', () => {
  assert.deepEqual(idx.documentTerms('内存').sort(), ['内', '存', '内存'].sort())
  assert.deepEqual(idx.queryTerms('内存'), ['内存'])
  assert.deepEqual(idx.queryTerms('存'), ['存'])
  passed += 1
})

// 宽松召回：长中文段按相邻两字分组、命中过半即算，短段仍要求全中（不放宽）。
test('查询分组：长段过半、短段全中，只有长段才可放宽', () => {
  const groups = idx.queryGroups('内存占用过高')
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].terms, ['内存', '存占', '占用', '用过', '过高'])
  assert.equal(groups[0].need, 3)
  assert.equal(idx.relaxable(groups), true)
  const short = idx.queryGroups('内存')
  assert.deepEqual(short, [{ terms: ['内存'], need: 1 }])
  assert.equal(idx.relaxable(short), false)
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
