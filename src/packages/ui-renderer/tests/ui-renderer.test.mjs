/**
 * `@pneuma/ui-renderer` 的包级测试：只钉两条不变量。
 *
 * 为什么只钉这两条：本包的实体在界面半（`ui/`）里，而界面半由 `ui-shell` 的构建编进壳，
 * 包自己不带可执行的宿主逻辑——能在这里验的只有"出口还在"与"壳的落点表指对了"。
 * 界面行为由 `scripts/ui-plugin-test.mjs` 那批集成探针负责（它们要整套壳才成立）。
 *
 * 两条都读源码、不读 `lib/`：产物没构建时这两条照样能跑，改坏了当场红。
 *
 * @module @pneuma/ui-renderer/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  const target = table['@dsc/ui-renderer']
  assert.ok(
    typeof target === 'string' && target.endsWith('src/packages/ui-renderer/ui/index.ts'),
    `ui-shell/packages.json 里 @dsc/ui-renderer 指向 ${String(target)}，不是 src/packages/ui-renderer/ui/index.ts`,
  )
  passed += 1
})

// 断言计数只给 `scripts/package-tests.mjs` 显示；判据始终是退出码。
after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
