/**
 * `@pneuma/ui-renderer` 的包级测试：钉住「它现在是一个可停用的客户端插件」这几条不变量。
 *
 * 为什么只钉形状、不钉界面行为：本包的实体在界面半（`ui/`）里，由 `ui-shell` 的构建打
 * 成 `lib/ui/plugins/renderer/client.js`；界面行为由 `scripts/ui-plugin-test.mjs` 那批
 * 集成探针负责（它们要整套壳才成立）。这里能验的是「声明的三处（package.json /
 * cordis.patch.yml / ui/ui.tsx）对得上」与「入口已搬到引导」。
 *
 * 全部读源码、不读 `lib/`：产物没构建时这几条照样能跑，改坏了当场红。
 *
 * @module @pneuma/ui-renderer/tests
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { after, test } from 'node:test'

/** 按相对本文件的路径读文本。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 界面契约版本 = 壳包的 version。不写死：抬产品号时这份测试不用跟着改。 */
const shellVersion = JSON.parse(read('../../../../ui-shell/package.json')).version

let passed = 0

test('界面半的出口还在：ui/index.ts 转出 start 与默认插件', () => {
  const entry = read('../ui/index.ts')
  assert.match(entry, /export \{ default, start \}/)
  passed += 1
})

test('package.json：客户端插件的身份（去 library、有 patch / order / client / ./client）', () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.pneuma.library, undefined, '还是 pneuma.library：那样就没有行、没有开关')
  assert.equal(pkg.pneuma.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.pneuma.order, 348, 'order 要排在骨架（349）与 19 个界面单元（350–368）之前')
  assert.equal(pkg.pneuma.resolution, 'overridable')
  assert.equal(pkg.exports['./client'], './ui/ui.tsx', './client 要指到界面半的入口')
  assert.equal(pkg.pneuma.client.platform, 'pneuma')
  assert.equal(pkg.pneuma.client.api, '^' + shellVersion)
  assert.equal(pkg.pneuma.client.immediately, true)
  assert.equal(pkg.pneuma.client.phase, 'early', '首屏批：引导要先物化它才能画首帧')
  passed += 1
})

test('cordis.patch.yml：一行 insert，id 与包名都是本包', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /- insert:/)
  assert.match(patch, /- id: ui-renderer/)
  assert.match(patch, /name: '@pneuma\/ui-renderer'/)
  passed += 1
})

test('ui/ui.tsx：导出 start(api)，并带 defineUiPlugin 的默认导出', () => {
  const entry = read('../ui/ui.tsx')
  assert.match(entry, /export async function start\(api: UiRendererApi\)/)
  assert.match(entry, /export default defineUiPlugin\(/, '没有默认导出：装载器会报「插件没有导出 apply」')
  assert.match(entry, /LayoutUnavailable/, '骨架缺席的诊断页不见了')
  passed += 1
})

test('页面入口已搬到引导：本包不再有 ui/main.tsx', () => {
  assert.equal(existsSync(new URL('../ui/main.tsx', import.meta.url)), false, 'ui/main.tsx 还在：入口没搬干净')
  const html = read('../../../../ui-shell/index.html')
  assert.match(html, /ui-boot\/ui\/main\.tsx/, 'index.html 的入口没指到引导')
  passed += 1
})

test('引导包的身份：库包、没有行（对应 dsh 的 client-modules）', () => {
  const boot = JSON.parse(read('../../ui-boot/package.json'))
  assert.equal(boot.name, '@pneuma/ui-boot')
  assert.equal(boot.pneuma.library, true)
  assert.equal(boot.pneuma.bundle, undefined)
  passed += 1
})

// 断言计数只给 `scripts/package-tests.mjs` 显示；判据始终是退出码。
after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
