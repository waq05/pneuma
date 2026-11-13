/**
 * @pneuma/schedule 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：排期算法在 runtime core 的 rule/runner/store 里，这个包只做装配与设置分区，这里钉清单、包形态、入口对象与它声明的十项依赖。
 *
 * 迁移说明：原文件从 `lib/packages/schedule/index.js` 取插件对象，现在直接 import 源码入口 `../index.js`。
 *
 * @module @pneuma/schedule/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { schedulePlugin } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包的清单。 */
const pkg = JSON.parse(read('../package.json')) as {
  name: string
  type: string
  exports: Record<string, { default?: string }>
  pneuma?: { library?: boolean; bundle?: { patch: string } }
}

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toContain('id: schedule')
  expect(patch).toContain("name: '@pneuma/schedule'")
})

test('包形态：ESM、两个导出子路径、patch 声明自洽', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.']?.default).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  if (pkg.pneuma?.library === true) {
    expect(pkg.pneuma?.bundle).toBeUndefined()
  } else {
    expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
  }
})

test('入口：插件对象有名字与 apply', () => {
  expect(typeof schedulePlugin.name).toBe('string')
  expect([pkg.name.split('/').at(-1), 'schedule']).toContain(schedulePlugin.name)
  expect(typeof schedulePlugin.apply).toBe('function')
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

test('装配面：十项注入齐、不 provide（面挂在 tools/commands/surfaces 上）', () => {
  expect([...(schedulePlugin.inject ?? [])]).toEqual([
    'tools',
    'commands',
    'settings',
    'transcript',
    'agent',
    'session',
    'waiting',
    'llm',
    'prompt',
    'surfaces',
  ])
  expect(schedulePlugin.provide).toBeUndefined()
})
