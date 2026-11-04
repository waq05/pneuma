/**
 * `@pneuma/ui-layout` 的包级测试：钉住「它现在是一个客户端插件」这几条不变量。
 *
 * 为什么只钉形状、不钉界面行为：本包的实体在界面半（`ui/`）里，由 `ui-shell` 的构建打
 * 成 `lib/ui/plugins/layout/client.js`；界面行为由 `scripts/ui-plugin-test.mjs` 那批集成
 * 探针负责（它们要整套壳才成立）。这里能验的是「声明的三处（package.json / cordis.patch.yml /
 * ui/ui.tsx）对得上，且骨架不会被内联成第二份」。
 *
 * 全部读源码、不读 `lib/`：产物没构建时这几条照样能跑，改坏了当场红。
 *
 * @module @pneuma/ui-layout/tests
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { after, test } from 'node:test'

/** 按相对本文件的路径读文本。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

let passed = 0

test('界面半的出口还在：ui/index.ts 里有 export', () => {
  const entry = read('../ui/index.ts')
  assert.match(entry, /export /, 'ui/index.ts 里没有一个 export：包被搬空或改成了空文件')
  passed += 1
})

test('壳的落点表指到本包的 ui/index.ts', () => {
  const table = JSON.parse(read('../../../../ui-shell/packages.json'))
  const target = table['@dsc/ui-layout']
  assert.ok(
    typeof target === 'string' && target.endsWith('src/packages/ui-layout/ui/index.ts'),
    `ui-shell/packages.json 里 @dsc/ui-layout 指向 ${String(target)}，不是 src/packages/ui-layout/ui/index.ts`,
  )
  passed += 1
})

test('package.json：客户端插件的身份（去 library、有 patch / order / client / ./client）', () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.pneuma.library, undefined, '还是 pneuma.library：那样就没有行、没有开关')
  assert.equal(pkg.pneuma.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.pneuma.order, 349, 'order 要排在 19 个界面单元（350–368）之前')
  assert.equal(pkg.pneuma.resolution, 'overridable')
  assert.equal(pkg.exports['./client'], './ui/ui.tsx', './client 要指到界面半的入口')
  assert.equal(pkg.pneuma.client.platform, 'pneuma')
  assert.equal(pkg.pneuma.client.api, '^0.8.1')
  assert.equal(pkg.pneuma.client.phase, 'early', '首屏批：骨架要在首帧前就位')
  passed += 1
})

test('cordis.patch.yml：一行 insert，id 与包名都是本包', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /- insert:/)
  assert.match(patch, /- id: ui-layout/)
  assert.match(patch, /name: '@pneuma\/ui-layout'/)
  passed += 1
})

test('ui/ui.tsx：转出 main 需要的挂载面，并带 defineUiPlugin 的默认导出', () => {
  const entry = read('../ui/ui.tsx')
  for (const name of ['App', 'createHostChannel', 'RuntimeProvider', 'applyAppearance']) {
    assert.match(entry, new RegExp(`\\b${name}\\b`), `ui/ui.tsx 没有转出 ${name}`)
  }
  assert.match(entry, /export default defineUiPlugin\(/, '没有默认导出：装载器会报「插件没有导出 apply」')
  passed += 1
})

test('骨架是平台种子：@dsc/ui-layout 在装载器的 require 表里（否则会内联第二份实现）', () => {
  const modules = JSON.parse(read('../../ui-boot/ui/platform-modules.json'))
  assert.ok(modules.includes('@dsc/ui-layout'), `platform-modules.json 里没有 @dsc/ui-layout：${modules.join(',')}`)
  const boot = read('../../ui-boot/ui/boot.ts')
  assert.match(boot, /from '@dsc\/ui-layout'/)
  assert.match(boot, /'@dsc\/ui-layout':\s*uiLayout/)
  passed += 1
})

test('装配行在 src 里就位（构建脚本按目录扫，缺了 rows 就空）', () => {
  assert.ok(existsSync(new URL('../cordis.patch.yml', import.meta.url)))
  passed += 1
})

// 断言计数只给 `scripts/package-tests.mjs` 显示；判据始终是退出码。
after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
