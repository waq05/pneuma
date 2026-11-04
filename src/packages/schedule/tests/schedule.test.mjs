/**
 * @pneuma/schedule 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：排期算法在 runtime core 的 rule/runner/store 里，这个包只做装配与设置分区，这里钉清单、包形态、入口对象与它声明的十项依赖。
 * @module @pneuma/schedule/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
let passed = 0

const { schedulePlugin } = await import(new URL('../../../../lib/packages/schedule/index.js', import.meta.url).href)

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  assert.ok(patch.includes('id: schedule'))
  assert.ok(patch.includes("name: '@pneuma/schedule'"))
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
  assert.equal(typeof schedulePlugin.name, 'string')
  assert.ok([pkg.name.split('/').at(-1), 'schedule'].includes(schedulePlugin.name))
  assert.equal(typeof schedulePlugin.apply, 'function')
  passed += 1
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'))
  assert.ok(readme.includes('## Known Limitations'))
  passed += 1
})

test('装配面：十项注入齐、不 provide（面挂在 tools/commands/surfaces 上）', () => {
  assert.deepEqual([...schedulePlugin.inject], ['tools', 'commands', 'settings', 'transcript', 'agent', 'session', 'waiting', 'llm', 'prompt', 'surfaces'])
  assert.equal(schedulePlugin.provide, undefined)
  passed += 1
})

after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
