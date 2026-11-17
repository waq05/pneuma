/**
 * @pneuma/goal 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：目标包的阶段与轮次上限是写死的常量表，改歪会让自动续跑停不下来，所以额外钉这张表。
 *
 * 迁移说明：原文件从 `lib/packages/goal/*.js` 取模块，现在直接 import 源码入口与 `goal.ts`；
 * 常量表因此是编译进测试的那一份源码值，改坏 `goal.ts` 立刻红。
 *
 * @module @pneuma/goal/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { goalPlugin } from '../index.js'
import { DEFAULT_MAX_GOAL_ROUNDS, GOAL_PHASES, MAX_GOAL_ROUNDS_CAP } from '../goal.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/goal', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: goal\s*$/m)
  expect(patch).toContain("name: '@pneuma/goal'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  const pkg = JSON.parse(read('../package.json')) as {
    name: string
    type: string
    exports: Record<string, { default?: string }>
    pneuma: { bundle: { patch: string }; library?: boolean }
  }
  expect(pkg.name).toBe('@pneuma/goal')
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.']?.default).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  expect(pkg.pneuma.bundle.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma.library).not.toBe(true)
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof goalPlugin).toBe('object')
  expect(typeof goalPlugin.name).toBe('string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  expect(goalPlugin.name).toBe('goal')
  expect(typeof goalPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

test('阶段表与轮次上限是常量，且上限高于缺省值', () => {
  expect([...GOAL_PHASES]).toEqual(['active', 'paused', 'blocked', 'complete'])
  expect(DEFAULT_MAX_GOAL_ROUNDS).toBe(24)
  expect(MAX_GOAL_ROUNDS_CAP).toBe(256)
  expect(MAX_GOAL_ROUNDS_CAP).toBeGreaterThan(DEFAULT_MAX_GOAL_ROUNDS)
})
