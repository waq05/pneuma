/**
 * `@pneuma/ui-boot` 的包级测试：只钉两条不变量。
 *
 * 为什么只钉这两条：本包的实体在浏览器半边（`ui/`），由 `ui-shell` 的构建编进壳的 app
 * bundle；包本身没有可执行的 Node 逻辑。界面行为由 `scripts/ui-plugin-test.mjs` 那批
 * 集成探针负责（它们要整套壳才成立）。
 *
 * 两条都读源码、不读 `lib/`：产物没构建时这两条照样能跑，改坏了当场红。
 *
 * @module @pneuma/ui-boot/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

/** 按相对本文件的路径读文本。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

let passed = 0

test('包身份：库包（有 library、没有 patch / order），exports 至少含 boot.js 与 hmr.js', () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.pneuma.library, true, '引导是库包：没有行、不能停用')
  assert.equal(pkg.pneuma.bundle, undefined, '不该有 cordis.patch.yml 声明')
  assert.equal(pkg.pneuma.order, undefined, '库包不参与行排序')
  assert.equal(pkg.exports['./boot.js'], './boot.js')
  assert.equal(pkg.exports['./hmr.js'], './hmr.js')
  passed += 1
})

test('页面入口还在，并把它交给渲染器的 start(api)', () => {
  const entry = read('../ui/main.tsx')
  assert.ok(entry.includes("from './boot'"), '入口没有从 boot.ts 取装载能力')
  assert.ok(entry.includes('loaded.start'), '入口没有调用渲染器的 start(api)')
  assert.match(entry, /RendererUnavailable|RendererFailure/, '入口没有诊断页')
  passed += 1
})

// 断言计数只给 `scripts/package-tests.mjs` 显示；判据始终是退出码。
after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
