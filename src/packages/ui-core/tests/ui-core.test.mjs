/**
 * `@pneuma/ui-core` 的包级测试：钉库包身份、桶文件转出、产物可加载与文档两段。
 *
 * 产物那条读 lib/packages/ui-core/index.js（先 pnpm run build）；还没构建时明确打印
 * 「待构建」并跳过，不伪造通过。单独跑：node src/packages/ui-core/tests/ui-core.test.mjs
 *
 * @module @pneuma/ui-core/tests
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { after, test } from 'node:test'

/** 按相对本文件的路径读文本。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
let passed = 0
let skipped = 0

test('库包身份：private + pneuma.library，没有装配行', () => {
  assert.equal(pkg.name, '@pneuma/ui-core')
  assert.equal(pkg.version, JSON.parse(read('../../../../package.json')).version)
  assert.equal(pkg.private, true)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.pneuma.library, true)
  assert.equal(pkg.pneuma.bundle, undefined)
  assert.ok(!existsSync(new URL('../cordis.patch.yml', import.meta.url)), '库包不该有 cordis.patch.yml')
  passed += 1
})

test('exports：根入口、package.json 与终端壳要的四个模块子路径', () => {
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./package.json'], './package.json')
  // 终端壳（@pneuma/tui）按裸说明符取这一半：键与目标必须一字不差。
  for (const name of ['slots', 'slots-ink', 'tui-plugins', 'tui-plugin-api']) {
    assert.equal(pkg.exports[`./${name}.js`], `./${name}.js`)
    assert.ok(existsSync(new URL(`../${name}.ts`, import.meta.url)) || existsSync(new URL(`../${name}.tsx`, import.meta.url)), `${name} 的源码不在包里`)
  }
  passed += 1
})

test('桶里有导出：槽位、帧与 core 的启动图再导出都在', () => {
  const entry = read('../index.ts')
  assert.match(entry, /export /, 'index.ts 里没有一个 export：包被搬空或改成了空文件')
  for (const module of ['./frames.js', './slots.js', './services.js', './arrival.js']) {
    assert.ok(entry.includes(`export * from '${module}'`), `index.ts 没转出 ${module}`)
  }
  // 启动图归内核：桶从 src/core 取，不再有本包内的 manifest.js。
  assert.ok(
    entry.includes("export * from '../../core/ui-manifest.js'"),
    'index.ts 没有从 src/core/ui-manifest.js 转出启动图',
  )
  assert.ok(!existsSync(new URL('../manifest.ts', import.meta.url)), 'manifest.ts 应该已经搬到 src/core/ui-manifest.ts')
  passed += 1
})

test('README 两段都在', () => {
  const text = read('../README.md')
  assert.match(text, /^## Model Experience/m)
  assert.match(text, /^## Known Limitations/m)
  passed += 1
})

test('lib 产物能加载，且至少导出函数或常量', async () => {
  const url = new URL('../../../../lib/packages/ui-core/index.js', import.meta.url)
  if (!existsSync(url)) {
    skipped += 1
    console.log('待构建：lib/packages/ui-core/index.js 还没生成（主控 pnpm run build 后复跑本项）')
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
