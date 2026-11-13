/**
 * `@pneuma/session-core` 的包级测试：钉库包身份、桶文件转出与产物可加载。
 * 产物那条读 lib/packages/session-core/index.js（先 pnpm run build）；还没构建时明确打印
 * 「待构建」并跳过，不伪造通过。单独跑：node src/packages/session-core/tests/session-core.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
const MODULES = ["hooks","compact","prompt","loop","modes"]
let passed = 0
let skipped = 0

test('库包身份：private + pneuma.library，没有装配行', () => {
  assert.equal(pkg.name, '@pneuma/session-core')
  assert.equal(pkg.version, JSON.parse(read('../../../../package.json')).version)
  assert.equal(pkg.private, true)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.pneuma.library, true)
  assert.equal(pkg.pneuma.bundle, undefined)
  assert.ok(!existsSync(new URL('../cordis.patch.yml', import.meta.url)), '库包不该有 cordis.patch.yml')
  passed += 1
})

test('exports 的模块子路径键与目标一字不差', () => {
  assert.equal(pkg.exports['.'].default, './index.js')
  assert.equal(pkg.exports['./package.json'], './package.json')
  for (const name of MODULES) assert.equal(pkg.exports[`./${name}.js`], `./${name}.js`)
  passed += 1
})

test('index.ts 逐行转出全部模块，源码文件都在包里', () => {
  const entry = read('../index.ts')
  for (const name of MODULES) {
    assert.ok(entry.includes(`export * from './${name}.js'`), `index.ts 没转出 ${name}.js`)
    assert.ok(existsSync(new URL(`../${name}.ts`, import.meta.url)), `${name}.ts 不在包里`)
  }
  passed += 1
})

test('README 两段都在', () => {
  const text = read('../README.md')
  assert.match(text, /^## Model Experience/m)
  assert.match(text, /^## Known Limitations/m)
  passed += 1
})

test('lib 产物能加载，且至少导出函数或常量', async () => {
  const url = new URL('../../../../lib/packages/session-core/index.js', import.meta.url)
  if (!existsSync(url)) {
    skipped += 1
    console.log('待构建：lib/packages/session-core/index.js 还没生成（主控 pnpm run build 后复跑本项）')
    return
  }
  const mod = await import(url.href)
  const values = Object.values(mod)
  assert.ok(values.length > 0, '产物没有任何导出')
  assert.ok(
    values.some((value) => typeof value === 'function' || (typeof value === 'object' && value !== null)),
    '产物里没有函数或常量导出',
  )
  passed += 1
})

after(() => {
  console.log(`通过 ${String(passed)} 项${skipped > 0 ? `，待构建 ${String(skipped)} 项（见上方日志）` : ''}`)
})
