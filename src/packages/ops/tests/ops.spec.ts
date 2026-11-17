/**
 * @pneuma/ops 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：这个包只做装配（找 worker、注册工具、开设置分区），不拉起外部 worker 能测的就是清单、包形态、入口对象与两个便宜的配置函数。
 *
 * 迁移说明：原文件从 `lib/packages/ops/index.js` 取模块，现在直接 import 源码入口 `../index.js`。
 *
 * @module @pneuma/ops/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { OPS_TIMEOUT_RANGE, opsPlugin, readOpsConfig } from '../index.js'

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
  expect(patch).toContain('id: ops')
  expect(patch).toContain("name: '@pneuma/ops'")
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
  expect(typeof opsPlugin.name).toBe('string')
  expect([pkg.name.split('/').at(-1), 'ops']).toContain(opsPlugin.name)
  expect(typeof opsPlugin.apply).toBe('function')
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

test('时限：区间常量是 2s–30s，配置值一律夹回区间', () => {
  expect({ ...OPS_TIMEOUT_RANGE }).toEqual({ min: 2_000, max: 30_000 })
  for (const input of [1, 1_000_000]) {
    const { timeoutMs } = readOpsConfig({ timeoutMs: input })
    expect(timeoutMs).toBeGreaterThanOrEqual(OPS_TIMEOUT_RANGE.min)
    expect(timeoutMs).toBeLessThanOrEqual(OPS_TIMEOUT_RANGE.max)
  }
  expect(typeof readOpsConfig().workerPath).toBe('string')
})
