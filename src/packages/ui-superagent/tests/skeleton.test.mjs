/**
 * `@pneuma/ui-superagent` 的包级测试：只钉两条本轮真正成立的不变量。
 *
 * 为什么只有两条：本轮的产物是**空壳**——宿主半只有一行身份，界面半只有占位文案。
 * 界面行为（侧栏那一行点得开、整页外壳对不对）要整套壳才成立，归 `scripts/` 的集成探针；
 * 这里只验「插件对象还在」与「清单声明没漂」。
 *
 * 为什么不 import `lib/` 的构建产物：这一轮明确不跑构建（主控统一跑），
 * 包级测试若依赖 `lib/` 会在未构建的检出上直接红。入口只有两行声明，读源码判得同样准。
 *
 * @module @pneuma/ui-superagent/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import YAML from 'yaml'

/** 按相对本文件的路径读文本。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('插件对象：导出的 name 是字符串、apply 是函数', () => {
  const source = read('../index.ts')
  // 只认字符串字面量：`export const name = someVar` 里装的什么都可能，加载器要的是确定的身份。
  const name = /^export const name = '([^']+)'$/m.exec(source)
  assert.ok(name !== null, "index.ts 里没有 `export const name = '<字符串>'`：加载器认不出这一行")
  assert.equal(name[1], 'ui-superagent', 'name 与包名 / 行 id 不同源')
  assert.ok(/^export function apply\s*\(/m.test(source), 'index.ts 没有导出 apply 函数：这一行装配不起来')
})

test('清单声明：pneuma.client.api 是 ^0.9.1，cordis.patch.yml 恰好一条 insert 行', () => {
  const pkg = JSON.parse(read('../package.json'))
  // 为什么钉 api：界面半面对的契约区间写在清单里，壳的构建按它校验（ui-shell/build-plugins.mjs）。
  assert.equal(pkg.pneuma.client.api, '^0.9.1', 'pneuma.client.api 不是 ^0.9.1')
  assert.equal(pkg.pneuma.client.platform, 'pneuma', 'pneuma.client.platform 不是 pneuma')

  const patch = YAML.parse(read('../cordis.patch.yml'))
  // 为什么钉「恰好一条」：一个包只许一行；多出来的 insert 会把同一插件装两次，
  // 少一条则插件中心的开关永远关不掉这个包。
  assert.ok(Array.isArray(patch), 'cordis.patch.yml 顶层不是数组')
  assert.equal(patch.length, 1, 'cordis.patch.yml 顶层不是恰好 1 条')
  assert.ok(Array.isArray(patch[0].insert), '这一条不是 insert')
  assert.equal(patch[0].insert.length, 1, 'insert 里不是恰好 1 行')
  assert.deepEqual(Object.keys(patch[0]), ['insert'], 'insert 旁边还有别的键')
  const row = patch[0].insert[0]
  assert.equal(row.id, 'ui-superagent', '行 id 与目录名不一致')
  assert.equal(row.name, '@pneuma/ui-superagent', '行的 name 与包名不一致')
  // 界面单元默认装载：其余 21 个界面包没有一个写 disabled，界面是壳的一部分。
  // 默认关的只应该是宿主包 superagent——它一开就要建库、起节拍。
  assert.equal(row.disabled, undefined, '界面单元不该默认关闭，patch 行里不要写 disabled')
})
