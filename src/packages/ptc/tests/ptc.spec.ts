/**
 * @pneuma/ptc 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：run_code 要真跑脚本就得有工具目录与守卫链，这里只钉清单、包形态、入口对象，以及同包纯函数 readDeadlineMs 与它的区间常量。
 *
 * 迁移说明：原文件从 `lib/packages/ptc/index.js` 取模块，现在直接 import 源码入口 `../index.js`。
 *
 * @module @pneuma/ptc/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { PTC_DEADLINE_RANGE, ptcPlugin, readDeadlineMs } from '../index.js'

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
  expect(patch).toContain('id: ptc')
  expect(patch).toContain("name: '@pneuma/ptc'")
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
  expect(typeof ptcPlugin.name).toBe('string')
  expect([pkg.name.split('/').at(-1), 'ptc']).toContain(ptcPlugin.name)
  expect(typeof ptcPlugin.apply).toBe('function')
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

test('时限：区间常量是 30s–15min，配置值一律夹回区间', () => {
  expect({ ...PTC_DEADLINE_RANGE }).toEqual({ min: 30_000, max: 900_000 })
  for (const input of [1, 1_000_000]) {
    const ms = readDeadlineMs({ deadlineMs: input })
    expect(Number.isInteger(ms)).toBe(true)
    expect(ms).toBeGreaterThanOrEqual(PTC_DEADLINE_RANGE.min)
    expect(ms).toBeLessThanOrEqual(PTC_DEADLINE_RANGE.max)
  }
})
