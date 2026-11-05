/**
 * @pneuma/self-improve 的包级测试：钉 7 条不变量。
 * 为什么只钉这些：入口导出的插件对象、唯一一个纯函数 parseDraftAnswer，加上清单、装配行与文档，
 * 是不碰会话、模型与 ~/.dsc 就能便宜钉住的全集。
 * @module @pneuma/self-improve/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
let passed = 0

const pkg = JSON.parse(read('../package.json'))
const mod = await import('../../../../lib/packages/self-improve/index.js')

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/self-improve', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /^\s*-\s*id: self-improve\s*$/m, '装配行的 id 必须正好是 self-improve')
  assert.ok(patch.includes("name: '@pneuma/self-improve'"), "装配行的 name 必须是 '@pneuma/self-improve'")
  passed += 1
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml（库包则相反）。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.exports['.'].default, 'exports 必须有 "."')
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
  assert.equal(typeof mod.selfImprovePlugin, 'object')
  assert.equal(typeof mod.selfImprovePlugin.name, 'string')
  assert.equal(mod.selfImprovePlugin.name, pkg.name.split('/').pop())
  assert.equal(mod.selfImprovePlugin.name, 'self-improve')
  assert.equal(typeof mod.selfImprovePlugin.apply, 'function')
  passed += 1
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), '缺 ## Model Experience')
  assert.ok(readme.includes('## Known Limitations'), '缺 ## Known Limitations')
  passed += 1
})

// 纯函数：模型只该回一行 JSON；规整写法与套代码块两种都要认。
test('parseDraftAnswer：认出规整 JSON 与代码块里的 JSON', () => {
  const line = '{"name":"git-flow","description":"整理提交","whenToUse":"提交前","content":"# 步骤"}'
  const direct = mod.parseDraftAnswer(line)
  assert.equal(direct.kind, 'draft')
  assert.equal(direct.draft.name, 'git-flow')
  assert.equal(direct.draft.whenToUse, '提交前')
  const fenced = mod.parseDraftAnswer('```json\n' + line + '\n```')
  assert.equal(fenced.kind, 'draft')
  assert.equal(fenced.draft.content, '# 步骤')
  passed += 1
})

// 纯函数：NONE 是「这轮不值得沉淀」的正常回答，不该被当成解析失败。
test('parseDraftAnswer：NONE 与认不出的一行各有明确结果', () => {
  assert.deepEqual(mod.parseDraftAnswer('NONE'), { kind: 'none' })
  const bad = mod.parseDraftAnswer('{}')
  assert.equal(bad.kind, 'invalid')
  assert.equal(typeof bad.error, 'string')
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
