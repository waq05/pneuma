/**
 * `@pneuma/ui-runtime` 的包级测试：钉住「共享状态只有一份」这条不变量。
 *
 * 为什么这条最要紧：布局插件与 19 个界面单元都读 RuntimeContext / 页与视图信号 / 外观落地。
 * 它们一旦分家，症状是首渲染抛「useHostChannel 必须在 RuntimeProvider 里用」——而错误现场
 * 在浏览器里，构建期一声不响。所以这里从三个方向把它钉住：本包的出口、壳的落点表、
 * 运行时 require 表。
 *
 * 全部读源码、不读 `lib/`：产物没构建时这几条照样能跑，改坏了当场红。
 *
 * @module @pneuma/ui-runtime/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

/** 按相对本文件的路径读文本。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

let passed = 0

test('界面半的出口齐：六个模块都从 ui/index.ts 转出', () => {
  const entry = read('../ui/index.ts')
  for (const mod of ['appearance', 'host-channel', 'page-state', 'runtime-context', 'thread-view', 'usage-today']) {
    assert.match(entry, new RegExp(`export \\* from '\\./${mod}'`), `ui/index.ts 没有转出 ${mod}`)
  }
  passed += 1
})

test('壳的落点表指到本包的 ui/index.ts', () => {
  const table = JSON.parse(read('../../../../ui-shell/packages.json'))
  const target = table['@dsc/ui-runtime']
  assert.ok(
    typeof target === 'string' && target.endsWith('src/packages/ui-runtime/ui/index.ts'),
    `ui-shell/packages.json 里 @dsc/ui-runtime 指向 ${String(target)}`,
  )
  passed += 1
})

test('它是库包：pneuma.library 为真、没有装配行', () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.pneuma.library, true, '不是库包：那就会有一行、可以被停用，共享状态也就跟着没了')
  assert.equal(pkg.pneuma.bundle, undefined, '有 pneuma.bundle：库包不该产出 client.js')
  passed += 1
})

test('平台种子表与运行期 require 表都认它（两份表读同一个 JSON）', () => {
  const modules = JSON.parse(read('../../ui-boot/ui/platform-modules.json'))
  assert.ok(modules.includes('@dsc/ui-runtime'), `platform-modules.json 里没有它：${modules.join(',')}`)
  const boot = read('../../ui-boot/ui/boot.ts')
  assert.match(boot, /import \* as uiRuntime from '@dsc\/ui-runtime'/)
  assert.match(boot, /'@dsc\/ui-runtime':\s*uiRuntime/)
  passed += 1
})

test('插件契约面从本包转出（不是从布局包）', () => {
  const api = read('../../../../ui-shell/src/plugin-api.ts')
  assert.doesNotMatch(api, /from '@dsc\/ui-layout'/, 'plugin-api 还在引 @dsc/ui-layout：布局已不是种子')
  for (const name of ['useHostSnapshot', 'useShellPage', 'useThreadView', 'applyAppearance']) {
    assert.match(api, new RegExp(`\\b${name}\\b`), `plugin-api 没有转出 ${name}`)
  }
  passed += 1
})

// 断言计数只给 `scripts/package-tests.mjs` 显示；判据始终是退出码。
after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
