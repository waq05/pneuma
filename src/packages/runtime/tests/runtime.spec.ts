/**
 * @pneuma/runtime-adapter 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：适配器要织进整套服务才能跑，这里钉清单、包形态、入口对象（名字沿用内核契约 ui-runtime）与它声明要拿的那些服务面。
 * 导入面是源码入口（`../index.js`），不是 `lib/` 产物。
 * @module @pneuma/runtime-adapter/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { runtimePlugin } from '../index.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toContain('id: runtime')
  expect(patch).toContain("name: '@pneuma/runtime-adapter'")
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
  // 目录 id 是 runtime、包名末段是 runtime-adapter，但插件对象名沿用内核里既有的契约名
  // 'ui-runtime'（src/packages/runtime/index.ts:29），这里钉的是那个契约名。
  expect(runtimePlugin.name).toBe('ui-runtime')
  expect(typeof runtimePlugin.apply).toBe('function')
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

test('适配器契约：provide 是 ui，注入面含 tools/mode/presets/permissionPresets', () => {
  expect(runtimePlugin.provide).toBe('ui')
  for (const dep of ['tools', 'mode', 'presets', 'permissionPresets', 'goal', 'ask', 'plan', 'todo']) {
    expect(runtimePlugin.inject).toContain(dep)
  }
})
