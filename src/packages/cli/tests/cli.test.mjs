/**
 * `@pneuma/cli` 的包级测试：钉入口表与产物对得上。
 * 为什么只钉这些：真正的行为要 spawn 子进程、动用户 profile，属于仓库级探针的活；
 * 这里只保证「表里写的文件真的在」——写错了就是 `numa plugin` 直接 ENOENT。
 * @module @pneuma/cli/tests
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
let passed = 0

test('库包身份：private + pneuma.library，且没有装配行', () => {
  assert.equal(pkg.private, true)
  assert.equal(pkg.pneuma.library, true)
  assert.equal(pkg.pneuma.bundle, undefined)
  assert.ok(!existsSync(new URL('../cordis.patch.yml', import.meta.url)))
  passed += 1
})

test('入口表里的每个文件都在源码里', () => {
  const entry = read('../index.ts')
  for (const file of ['config-cli.ts', 'plugin-cli.ts']) {
    // 表里写的是产物名（.js），源码是 .ts：比的是同一个 basename。
    assert.ok(entry.includes(file.replace(/\.ts$/, '.js')), `index.ts 的入口表没写 ${file}`)
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} 不在包里`)
  }
  passed += 1
})

test('入口表导出的是产物文件名（.js 而不是 .ts）', async () => {
  const mod = await import('../../../../lib/packages/cli/index.js')
  assert.deepEqual(mod.CLI_ENTRIES, { config: 'config-cli.js', plugin: 'plugin-cli.js' })
  passed += 1
})

test('两个脚本都在顶层收尾（process.exit），不会被当库 import', () => {
  for (const file of ['config-cli.ts', 'plugin-cli.ts']) {
    assert.match(read(`../${file}`), /process\.exit\(/, `${file} 没有 process.exit：它还是库的形状`)
  }
  passed += 1
})

test('README 两段都在', () => {
  const text = read('../README.md')
  assert.match(text, /^## Model Experience/m)
  assert.match(text, /^## Known Limitations/m)
  passed += 1
})

after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
