/**
 * @pneuma/presets 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：模式文件与投影逻辑都在 runtime core，这个包只负责登记服务与切换命令，能便宜测的是清单、包形态、入口对象与声明面。
 * @module @pneuma/presets/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
let passed = 0

const { presetsPlugin } = await import(new URL('../../../../lib/packages/presets/index.js', import.meta.url).href)

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  assert.ok(patch.includes('id: presets'))
  assert.ok(patch.includes("name: '@pneuma/presets'"))
  passed += 1
})

test('包形态：ESM、两个导出子路径、patch 声明自洽', () => {
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.exports['.'])
  assert.ok(pkg.exports['./package.json'])
  if (pkg.pneuma?.library === true) {
    assert.equal(pkg.pneuma?.bundle, undefined)
  } else {
    assert.equal(pkg.pneuma?.bundle?.patch, './cordis.patch.yml')
  }
  passed += 1
})

test('入口：lib 产物里的插件对象有名字与 apply', () => {
  assert.equal(typeof presetsPlugin.name, 'string')
  assert.ok([pkg.name.split('/').at(-1), 'presets'].includes(presetsPlugin.name))
  assert.equal(typeof presetsPlugin.apply, 'function')
  passed += 1
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'))
  assert.ok(readme.includes('## Known Limitations'))
  passed += 1
})

test('服务名：provide 是 presets，装配依赖含 prompt/tools/approval/mode', () => {
  assert.equal(presetsPlugin.provide, 'presets')
  for (const dep of ['prompt', 'tools', 'approval', 'mode', 'surfaces', 'settings']) {
    assert.ok(presetsPlugin.inject.includes(dep))
  }
  passed += 1
})


test('字典：出厂四个模式的标签与描述，中英各一份，英文里没有汉字', () => {
  const zh = JSON.parse(read('../locale/ui.zh.json'))
  const en = JSON.parse(read('../locale/ui.en.json'))
  for (const name of ['standard', 'minimal', 'maker', 'ptc']) {
    for (const field of ['label', 'description']) {
      const key = 'builtin.' + name + '.' + field
      assert.equal(typeof zh[key], 'string', key + ' 中文缺')
      assert.equal(typeof en[key], 'string', key + ' 英文缺')
      assert.ok(!/[\u4e00-\u9fff]/.test(en[key]), key + ' 英文里还有汉字')
    }
  }
  passed += 1
})

after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
