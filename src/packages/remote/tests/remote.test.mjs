/**
 * @pneuma/remote 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：起服务、抢主控位要真端口与磁盘，这里只钉清单、包形态、入口对象，以及纯路径函数 remoteAssetsDir 的落点。
 * @module @pneuma/remote/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
let passed = 0

const { remotePlugin, remoteAssetsDir } = await import(new URL('../../../../lib/packages/remote/index.js', import.meta.url).href)

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  assert.ok(patch.includes('id: remote'))
  assert.ok(patch.includes("name: '@pneuma/remote'"))
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
  assert.equal(typeof remotePlugin.name, 'string')
  assert.ok([pkg.name.split('/').at(-1), 'remote'].includes(remotePlugin.name))
  assert.equal(typeof remotePlugin.apply, 'function')
  passed += 1
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'))
  assert.ok(readme.includes('## Known Limitations'))
  passed += 1
})

test('静态资源目录：绝对路径且落在 remote/assets', () => {
  const dir = remoteAssetsDir()
  assert.ok(isAbsolute(dir))
  assert.ok(dir.endsWith(['remote', 'assets'].join(sep)))
  passed += 1
})

after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
