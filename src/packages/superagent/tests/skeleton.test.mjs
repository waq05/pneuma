/**
 * @pneuma/superagent 的包级测试：P0 骨架只钉两条不变量。
 *
 * 为什么只钉这两条：这一轮只搭壳，包里除了「入口对象」与「清单／装配行」没有别的东西
 * 可测——业务逻辑、存储、调度一条都还没有，多写断言就是在测自己刚编的常量。
 *
 * 注意：第 1 条 import 的是构建产物 `lib/packages/superagent/index.js`，
 * 跑它之前必须先 `pnpm run build`。P0 骨架这一轮**刻意没跑**（并行构建会互相踩 lib/），
 * 所以这个文件在总装前跑起来会报 ERR_MODULE_NOT_FOUND，属于预期。
 *
 * @module @pneuma/superagent/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import YAML from 'yaml'

/** 读同包里的文件（路径相对本测试文件）。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
let passed = 0

const plugin = await import(new URL('../../../../lib/packages/superagent/index.js', import.meta.url).href)

// ── 1. 入口对象 ──────────────────────────────────────────────────────────────
assert.equal(
  typeof plugin.name,
  'string',
  '入口应导出 name 字符串（lib/packages/superagent/index.js 的模块级导出）',
)
assert.equal(plugin.name, 'superagent', `入口导出的 name 应为 'superagent'，实际是 ${JSON.stringify(plugin.name)}`)
assert.equal(typeof plugin.apply, 'function', `入口应导出 apply 函数（cordis 认这个入口），实际是 ${typeof plugin.apply}`)
passed += 1
console.log('断言 1 通过：入口导出 name（字符串）与 apply（函数）')

// ── 2. 清单与装配行 ──────────────────────────────────────────────────────────
const order = pkg.pneuma?.order
assert.equal(typeof order, 'number', `package.json 的 pneuma.order 应是数字，实际是 ${JSON.stringify(order)}`)
assert.equal(order, 3800, `pneuma.order 应为 3800，实际是 ${JSON.stringify(order)}`)

const patch = YAML.parse(read('../cordis.patch.yml'))
assert.ok(Array.isArray(patch), 'cordis.patch.yml 顶层应是数组（一条 insert）')
assert.equal(patch.length, 1, `cordis.patch.yml 应恰好 1 条 insert，实际 ${patch.length} 条`)
assert.ok(Array.isArray(patch[0]?.insert), 'cordis.patch.yml 的唯一一条应是 insert')
assert.equal(patch[0].insert.length, 1, `insert 里应恰好 1 行，实际 ${patch[0].insert.length} 行`)

const row = patch[0].insert[0] ?? {}
assert.equal(row.id, 'superagent', `行 id 应为 'superagent'，实际是 ${JSON.stringify(row.id)}`)
assert.equal(row.name, pkg.name, `行的 name 应等于包名 ${pkg.name}，实际是 ${JSON.stringify(row.name)}`)
assert.equal(row.disabled, true, `骨架阶段默认关，行上应有 disabled: true，实际是 ${JSON.stringify(row.disabled)}`)
passed += 1
console.log('断言 2 通过：pneuma.order 是 3800，patch 恰好一条 insert，行 id / name 对得上')

console.log(`通过 ${String(passed)}`)
