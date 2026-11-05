/**
 * `@pneuma/ui-palette` 的包级测试：钉 6 条不变量。
 *
 * 为什么只钉这些：本包的宿主半只有一行身份（`name` + 空 `apply`），真正的界面在 `ui/ui.tsx` 里、由界面壳的构建编进壳——这里验「清单、产物、出口、文件都还在」。界面行为要整套壳才成立，归 `scripts/ui-plugin-test.mjs` 那批集成探针。
 *
 * 入口加载的是 `lib/packages/ui-palette/index.js`（构建产物）：它没有原生依赖、
 * 顶层无副作用，所以能真 import，不必退化成读 `index.ts` 文本。
 *
 * @module @pneuma/ui-palette/tests
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { after, test } from 'node:test'

/** 按相对本文件的路径读文本。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

let passed = 0

test('装配行与包名对得上：cordis.patch.yml 里 id 与 name 都是本包', () => {
  const patch = read('../cordis.patch.yml')
  // 为什么钉：行 id 写成别的包，插件中心的开关就永远关不掉这个包（关的是别人）。
  assert.ok(patch.includes('id: ui-palette'), 'cordis.patch.yml 里没有 id: ui-palette')
  assert.ok(patch.includes("name: '@pneuma/ui-palette'"), "cordis.patch.yml 里没有 name: '@pneuma/ui-palette'")
  passed += 1
})

test('包形态：ESM、两个出口、功能包声明 bundle.patch', () => {
  const pkg = JSON.parse(read('../package.json'))
  // 为什么钉：包级产物按 ESM 加载，出口少了壳就 import 不到；patch 声明丢了装配行不生效。
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.exports['.'].default, './index.js', '缺少 exports["."]')
  assert.equal(pkg.exports['./package.json'], './package.json', '缺少 exports["./package.json"]')
  assert.equal(pkg.pneuma.bundle.patch, './cordis.patch.yml')
  passed += 1
})

test('入口能加载：导出的 name 是字符串且与包名同源，apply 是函数', async () => {
  const mod = await import('../../../../lib/packages/ui-palette/index.js')
  const pkg = JSON.parse(read('../package.json'))
  // 为什么钉：模块导出的名字是这一行的身份，必须等于行 id / 包名后缀，
  // 否则插件清单与产物对不上号，停用与加载都找不到它。
  assert.equal(typeof mod.name, 'string')
  assert.equal(mod.name, 'ui-palette')
  assert.equal(typeof mod.apply, 'function', '入口没有导出 apply：这一行装配不起来')
  assert.equal(pkg.name, '@pneuma/' + mod.name)
  passed += 1
})

test('README 留着两段人读的契约', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), 'README 丢了 ## Model Experience 段')
  assert.ok(readme.includes('## Known Limitations'), 'README 丢了 ## Known Limitations 段')
  passed += 1
})

test('order 落在界面单元专用段 350–368', () => {
  const pkg = JSON.parse(read('../package.json'))
  // 为什么钉：19 个界面单元按 id 字典序占 350–368，越段就会跟别的层抢号。
  assert.equal(typeof pkg.pneuma.order, 'number')
  assert.ok(
    pkg.pneuma.order >= 350 && pkg.pneuma.order <= 368,
    'pneuma.order = ' + String(pkg.pneuma.order) + '，超出界面单元专用段 350–368',
  )
  passed += 1
})

test('界面半的出口指向 ui/ui.tsx 且文件在', () => {
  const pkg = JSON.parse(read('../package.json'))
  // 为什么钉：界面半搬走或改名后 exports["./client"] 会指空，壳按启动图装载时才发现。
  assert.equal(pkg.exports['./client'], './ui/ui.tsx')
  assert.ok(existsSync(new URL('../ui/ui.tsx', import.meta.url)), 'ui/ui.tsx 不见了')
  passed += 1
})

// 断言计数只给 scripts/package-tests.mjs 显示；判据始终是退出码。
after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
