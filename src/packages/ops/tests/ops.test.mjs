/**
 * @pneuma/ops 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：这个包只做装配（找 worker、注册工具、开设置分区），不拉起外部 worker 能测的就是清单、包形态、入口对象与两个便宜的配置函数。
 * @module @pneuma/ops/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
let passed = 0

const { opsPlugin, OPS_TIMEOUT_RANGE, readOpsConfig } = await import(new URL('../../../../lib/packages/ops/index.js', import.meta.url).href)

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  assert.ok(patch.includes('id: ops'))
  assert.ok(patch.includes("name: '@pneuma/ops'"))
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
  assert.equal(typeof opsPlugin.name, 'string')
  assert.ok([pkg.name.split('/').at(-1), 'ops'].includes(opsPlugin.name))
  assert.equal(typeof opsPlugin.apply, 'function')
  passed += 1
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'))
  assert.ok(readme.includes('## Known Limitations'))
  passed += 1
})

test('时限：区间常量是 2s–30s，配置值一律夹回区间', () => {
  assert.deepEqual({ ...OPS_TIMEOUT_RANGE }, { min: 2_000, max: 30_000 })
  for (const input of [1, 1_000_000]) {
    const { timeoutMs } = readOpsConfig({ timeoutMs: input })
    assert.ok(timeoutMs >= OPS_TIMEOUT_RANGE.min && timeoutMs <= OPS_TIMEOUT_RANGE.max)
  }
  assert.equal(typeof readOpsConfig().workerPath, 'string')
  passed += 1
})

after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
