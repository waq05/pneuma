/**
 * @pneuma/file-review 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：预览的可见行为由配置夹取与路径显示决定，这两条是纯函数，所以额外钉它们而不是钉渲染文本。
 * @module @pneuma/file-review/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
let passed = 0

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/file-review', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /^\s*-\s*id: file-review\s*$/m, '装配行的 id 必须正好是 file-review')
  assert.ok(patch.includes("name: '@pneuma/file-review'"), "装配行的 name 必须是 '@pneuma/file-review'")
  passed += 1
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.name, '@pneuma/file-review')
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.exports['.'].default, 'exports 必须有 "."')
  assert.ok(pkg.exports['./package.json'], 'exports 必须有 "./package.json"')
  assert.equal(pkg.pneuma.bundle.patch, './cordis.patch.yml')
  assert.notEqual(pkg.pneuma.library, true, '功能包不该标成库包')
  passed += 1
})

// 入口真能加载：lib 产物已构建，这里直接 import 并检查插件对象的三件事。
test('lib 入口能加载，插件名与 apply 对得上', async () => {
  const pkg = JSON.parse(read('../package.json'))
  const mod = await import('../../../../lib/packages/file-review/index.js')
  const keys = Object.keys(mod).filter((key) => /Plugin$/.test(key))
  assert.equal(keys.length, 1, '入口应当恰好导出一个 *Plugin 对象')
  const plugin = mod[keys[0]]
  assert.equal(typeof plugin, 'object')
  assert.equal(typeof plugin.name, 'string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  assert.equal(plugin.name, pkg.name.slice('@pneuma/'.length))
  assert.equal(plugin.name, 'file-review')
  assert.equal(typeof plugin.apply, 'function')
  passed += 1
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), '缺 ## Model Experience')
  assert.ok(readme.includes('## Known Limitations'), '缺 ## Known Limitations')
  passed += 1
})

const fileReview = await import('../../../../lib/packages/file-review/index.js')

test('配置解析：缺省值正确，越界夹到区间内', () => {
  assert.deepEqual(fileReview.parseFileReviewConfig({}), { enabled: true, maxLines: 120, contextLines: 3 })
  assert.equal(fileReview.parseFileReviewConfig({ maxLines: 99999 }).maxLines, fileReview.FILE_REVIEW_RANGES.maxLines.max)
  assert.equal(fileReview.parseFileReviewConfig({ contextLines: -5 }).contextLines, 0)
  assert.equal(fileReview.parseFileReviewConfig({ enabled: false }).enabled, false)
  passed += 1
})

test('路径显示：工作目录内写相对路径，目录外保留绝对路径', () => {
  assert.equal(fileReview.displayPathOf('/w', '/w/src/a.ts'), 'src/a.ts')
  assert.equal(fileReview.displayPathOf('/w', '/other/a.ts'), '/other/a.ts')
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
