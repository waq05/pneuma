/**
 * @pneuma/ptc 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：run_code 要真跑脚本就得有工具目录与守卫链，这里只钉清单、包形态、入口对象，以及同包纯函数 readDeadlineMs 与它的区间常量。
 * @module @pneuma/ptc/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
let passed = 0

const { ptcPlugin, PTC_DEADLINE_RANGE, readDeadlineMs } = await import(new URL('../../../../lib/packages/ptc/index.js', import.meta.url).href)

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  assert.ok(patch.includes('id: ptc'))
  assert.ok(patch.includes("name: '@pneuma/ptc'"))
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
  assert.equal(typeof ptcPlugin.name, 'string')
  assert.ok([pkg.name.split('/').at(-1), 'ptc'].includes(ptcPlugin.name))
  assert.equal(typeof ptcPlugin.apply, 'function')
  passed += 1
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'))
  assert.ok(readme.includes('## Known Limitations'))
  passed += 1
})

test('时限：区间常量是 30s–15min，配置值一律夹回区间', () => {
  assert.deepEqual({ ...PTC_DEADLINE_RANGE }, { min: 30_000, max: 900_000 })
  for (const input of [1, 1_000_000]) {
    const ms = readDeadlineMs({ deadlineMs: input })
    assert.ok(Number.isInteger(ms))
    assert.ok(ms >= PTC_DEADLINE_RANGE.min && ms <= PTC_DEADLINE_RANGE.max)
  }
  passed += 1
})

after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
