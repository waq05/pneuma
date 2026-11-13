/**
 * @pneuma/superagent 的包级测试：P0 骨架只钉两条不变量。
 *
 * 为什么只钉这两条：这一轮只搭壳，包里除了「入口对象」与「清单／装配行」没有别的东西
 * 可测——业务逻辑、存储、调度一条都还没有，多写断言就是在测自己刚编的常量。
 *
 * 迁移说明：原文件读 `lib/` 构建产物、自写 `passed` 计数；现在直接 import 源码，
 * 由 Vitest 自己计数。
 *
 * @module @pneuma/superagent/tests
 */
import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { expect, test } from 'vitest'
import { apply, name } from '../index.js'

/** 读同包里的文件（路径相对本测试文件）。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 装配文件里的一行。 */
interface PatchRow {
  id?: string
  name?: string
  disabled?: boolean
}

const pkg = JSON.parse(read('../package.json')) as {
  name: string
  pneuma?: { order?: number }
}

// ── 1. 入口对象 ──────────────────────────────────────────────────────────────
test('入口导出 name（字符串）与 apply（函数）', () => {
  expect(typeof name, '入口应导出 name 字符串（index.ts 的模块级导出）').toBe('string')
  expect(name, `入口导出的 name 应为 'superagent'，实际是 ${JSON.stringify(name)}`).toBe('superagent')
  expect(typeof apply, `入口应导出 apply 函数（cordis 认这个入口），实际是 ${typeof apply}`).toBe('function')
})

// ── 2. 清单与装配行 ──────────────────────────────────────────────────────────
test('pneuma.order 是 3800，patch 恰好一条 insert，行 id / name 对得上', () => {
  const order = pkg.pneuma?.order
  expect(typeof order, `package.json 的 pneuma.order 应是数字，实际是 ${JSON.stringify(order)}`).toBe('number')
  expect(order, `pneuma.order 应为 3800，实际是 ${JSON.stringify(order)}`).toBe(3800)

  // 解析成结构再断言，不匹配文本：多一个空格、换引号都不该让这条变红。
  const patch = YAML.parse(read('../cordis.patch.yml')) as Array<{ insert?: PatchRow[] }>
  expect(Array.isArray(patch), 'cordis.patch.yml 顶层应是数组（一条 insert）').toBe(true)
  expect(patch, `cordis.patch.yml 应恰好 1 条 insert，实际 ${String(patch.length)} 条`).toHaveLength(1)
  expect(Array.isArray(patch[0]?.insert), 'cordis.patch.yml 的唯一一条应是 insert').toBe(true)

  const rows = patch[0].insert ?? []
  expect(rows, `insert 里应恰好 1 行，实际 ${String(rows.length)} 行`).toHaveLength(1)

  const row = rows[0]
  expect(row.id, `行 id 应为 'superagent'，实际是 ${JSON.stringify(row.id)}`).toBe('superagent')
  expect(row.name, `行的 name 应等于包名 ${pkg.name}，实际是 ${JSON.stringify(row.name)}`).toBe(pkg.name)
  expect(row.disabled, `骨架阶段默认关，行上应有 disabled: true，实际是 ${JSON.stringify(row.disabled)}`).toBe(true)
})
