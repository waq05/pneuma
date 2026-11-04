/**
 * @pneuma/spill 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：这个包对外只有插件对象，落盘要会话目录与磁盘，留在集成探针里；
 * 能便宜钉住的是装配面、包形态、入口、文档，以及 apply 挂上的观察者与设置分区。
 * @module @pneuma/spill/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
let passed = 0

const pkg = JSON.parse(read('../package.json'))
const mod = await import('../../../../lib/packages/spill/index.js')

// 假 ctx：只实现 apply 会碰的四个面；effect 不执行回调，免得挂载时就把观察者注销掉。
function fakeContext() {
  const captured = { observers: [], section: undefined }
  const ctx = {
    guards: {
      registerObserver: (observer) => {
        captured.observers.push(observer)
        return () => {}
      },
    },
    settings: {
      registerSection: (spec) => {
        captured.section = spec
        return () => {}
      },
    },
    effect: () => {},
    transcript: { system: () => {} },
    session: { current: () => ({ meta: { id: 'package-test' } }) },
  }
  return { ctx, captured }
}

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/spill', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /^\s*-\s*id: spill\s*$/m, '装配行的 id 必须正好是 spill')
  assert.ok(patch.includes("name: '@pneuma/spill'"), "装配行的 name 必须是 '@pneuma/spill'")
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
  assert.equal(typeof mod.spillPlugin, 'object')
  assert.equal(typeof mod.spillPlugin.name, 'string')
  assert.equal(mod.spillPlugin.name, pkg.name.split('/').pop())
  assert.equal(mod.spillPlugin.name, 'spill')
  assert.equal(typeof mod.spillPlugin.apply, 'function')
  assert.ok(mod.spillPlugin.inject.includes('guards'), '必须注入 guards 才挂得上观察者')
  passed += 1
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), '缺 ## Model Experience')
  assert.ok(readme.includes('## Known Limitations'), '缺 ## Known Limitations')
  passed += 1
})

// 顺序不变量：观察者必须排在遮红（order 10）之后，否则磁盘上留下的会是脱敏前的原文。
test('apply 挂上的观察者排在遮红（10）之后，且 read 的输出不落盘', () => {
  const { ctx, captured } = fakeContext()
  const dispose = mod.spillPlugin.apply(ctx, {})
  assert.equal(captured.observers.length, 1)
  const observer = captured.observers[0]
  assert.equal(observer.id, 'spill')
  assert.ok(observer.order > 10, 'order 必须大于遮红的 10，否则密钥会以原文落盘')
  const long = 'x'.repeat(200_000)
  assert.equal(observer.observe('read', long), long, 'read 的结果就是模型点名要的那段，不该转存')
  assert.equal(typeof dispose, 'function', 'apply 必须返回可卸载的清理函数')
  passed += 1
})

// 设置面：分区 id 必须与插件键一致，否则界面按 id 找不回自己的设置。
test('设置分区 id 是 spill，字段与保存/按钮回调齐全', () => {
  const { ctx, captured } = fakeContext()
  mod.spillPlugin.apply(ctx, {})
  assert.equal(captured.section.id, 'spill')
  assert.equal(typeof captured.section.title, 'string')
  assert.equal(typeof captured.section.fields, 'function')
  assert.equal(typeof captured.section.save, 'function')
  assert.equal(typeof captured.section.action, 'function')
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
