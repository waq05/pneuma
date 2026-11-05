/**
 * `@pneuma/transcript` 的包级测试：钉 5 条不变量。
 *
 * 为什么只钉这些：本包是纯服务插件（provide `transcript`），条目折叠的实体在
 * `@pneuma/runtime/adapter/transcript.js` 里；包这一层能验的只有装配声明、
 * 入口对象形状，以及它对兄弟服务的 inject 依赖——少写一个 inject，
 * `getSnapshot()` 里 `ctx.surfaces`/`ctx.session` 会当场抛
 * 「cannot get property ... without inject」，整个界面快照就断了。
 *
 * 入口加载的是 `lib/packages/transcript/index.js`（构建产物）：顶层只有 import、
 * 无副作用，所以能真 import，不必退化成读 `index.ts` 文本。
 *
 * @module @pneuma/transcript/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

/** 按相对本文件的路径读文本。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

let passed = 0

test('装配行与包名对得上：cordis.patch.yml 里 id 与 name 都是本包', () => {
  const patch = read('../cordis.patch.yml')
  // 为什么钉：行 id 写成别的包，插件中心的开关就永远关不掉这个包（关的是别人）。
  assert.ok(patch.includes('id: transcript'), 'cordis.patch.yml 里没有 id: transcript')
  assert.ok(patch.includes("name: '@pneuma/transcript'"), "cordis.patch.yml 里没有 name: '@pneuma/transcript'")
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

test('入口能加载：transcriptPlugin 的 name 与包名同源，apply 是函数', async () => {
  const mod = await import('../../../../lib/packages/transcript/index.js')
  const pkg = JSON.parse(read('../package.json'))
  const plugin = mod.transcriptPlugin
  // 为什么钉：名字是这一行的身份，必须等于行 id / 包名后缀；
  // apply 不在，插件对象就只是个数据，装配时什么都不会发生。
  assert.equal(typeof plugin, 'object', '入口没有导出 transcriptPlugin')
  assert.equal(typeof plugin.name, 'string')
  assert.equal(plugin.name, 'transcript')
  assert.equal(typeof plugin.apply, 'function', 'transcriptPlugin 没有 apply')
  assert.equal(pkg.name, '@pneuma/' + plugin.name)
  passed += 1
})

test('服务契约：provide transcript，inject 覆盖快照用到的三个服务', async () => {
  const { transcriptPlugin } = await import('../../../../lib/packages/transcript/index.js')
  // 为什么钉：getSnapshot 里读 ctx.session / ctx.llm / ctx.surfaces；
  // 任一 inject 漏写，快照第一次被读就抛 without inject，界面整块空白。
  assert.equal(transcriptPlugin.provide, 'transcript', 'provide 不是 transcript：其它插件按这个名字取服务')
  assert.ok(Array.isArray(transcriptPlugin.inject), 'inject 不是数组')
  for (const dep of ['session', 'llm', 'surfaces']) {
    assert.ok(
      transcriptPlugin.inject.includes(dep),
      'inject 少了 ' + dep + '：快照读取会抛 without inject',
    )
  }
  passed += 1
})

test('README 留着两段人读的契约', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), 'README 丢了 ## Model Experience 段')
  assert.ok(readme.includes('## Known Limitations'), 'README 丢了 ## Known Limitations 段')
  passed += 1
})

// 断言计数只给 scripts/package-tests.mjs 显示；判据始终是退出码。
after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
