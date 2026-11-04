/**
 * @pneuma/session-title 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：入口只有插件对象与一个纯函数 cleanTitle，起标题本身要会话与模型，留在集成探针里。
 * @module @pneuma/session-title/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
let passed = 0

const pkg = JSON.parse(read('../package.json'))
const mod = await import('../../../../lib/packages/session-title/index.js')

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/session-title', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /^\s*-\s*id: session-title\s*$/m, '装配行的 id 必须正好是 session-title')
  assert.ok(patch.includes("name: '@pneuma/session-title'"), "装配行的 name 必须是 '@pneuma/session-title'")
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
  assert.equal(typeof mod.sessionTitlePlugin, 'object')
  assert.equal(typeof mod.sessionTitlePlugin.name, 'string')
  assert.equal(mod.sessionTitlePlugin.name, pkg.name.split('/').pop())
  assert.equal(mod.sessionTitlePlugin.name, 'session-title')
  assert.equal(typeof mod.sessionTitlePlugin.apply, 'function')
  passed += 1
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), '缺 ## Model Experience')
  assert.ok(readme.includes('## Known Limitations'), '缺 ## Known Limitations')
  passed += 1
})

// 纯函数：模型爱加引号、前缀、think 块；洗完是空就返回 undefined，超长按 40 字截。
test('cleanTitle：洗掉 think 块、引号与「标题：」前缀，空串返回 undefined，超长截到 40', () => {
  assert.equal(mod.cleanTitle('标题：修复登录'), '修复登录')
  assert.equal(mod.cleanTitle('<think>内部推理</think>\n「登录修复」\n'), '登录修复')
  assert.equal(mod.cleanTitle('   '), undefined)
  assert.equal(mod.cleanTitle('一'.repeat(60)).length, 40)
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
