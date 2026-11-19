/**
 * @pneuma/runtime-api 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：它只有一颗只读的 runtime_api 工具、没有可导出的纯函数，能便宜测的是清单、包形态、入口对象与它声明的五个只读服务面。
 * 导入面是源码入口（`../index.js`），不是 `lib/` 产物。
 * @module @pneuma/runtime-api/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { runtimeApiPlugin } from '../index.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toContain('id: runtime-api')
  expect(patch).toContain("name: '@pneuma/runtime-api'")
})

test('包形态：ESM、两个导出子路径、patch 声明自洽', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.'].default).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  if (pkg.pneuma?.library === true) {
    expect(pkg.pneuma?.bundle).toBeUndefined()
  } else {
    expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
  }
})

test('入口：插件对象有名字与 apply', () => {
  expect(typeof runtimeApiPlugin.name).toBe('string')
  expect([pkg.name.split('/').at(-1), 'runtime-api']).toContain(runtimeApiPlugin.name)
  expect(typeof runtimeApiPlugin.apply).toBe('function')
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

test('装配面：注入 tools/guards/prompt/surfaces/presets，自己不 provide', () => {
  expect(runtimeApiPlugin.inject).toEqual(['tools', 'guards', 'prompt', 'surfaces', 'presets'])
  expect(runtimeApiPlugin.provide).toBeUndefined()
})
