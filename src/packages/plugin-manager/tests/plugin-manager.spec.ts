/**
 * @pneuma/plugin-manager 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：它只有一颗 plugin_manager 工具、没有可导出的纯函数，能便宜测的是清单、包形态、入口对象与装配声明的两个依赖。
 *
 * 迁移说明：装配行改成 `YAML.parse` 后断言结构；入口直接 import 源码，不再依赖 `lib/` 产物。
 * @module @pneuma/plugin-manager/tests
 */
import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { expect, test } from 'vitest'
import { pluginManagerPlugin } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  type?: string
  exports?: Record<string, { default?: string } | string>
  pneuma?: { library?: boolean; bundle?: { patch?: string } }
}

/** 装配文件里的一行。 */
interface PatchRow {
  id?: string
  name?: string
}

const pkg = JSON.parse(read('../package.json')) as PackageJson

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = YAML.parse(read('../cordis.patch.yml')) as Array<{ insert?: PatchRow[] }>
  const row = patch.flatMap((layer) => layer.insert ?? []).find((item) => item.id === 'plugin-manager')
  expect(row).toBeDefined()
  expect(row?.name).toBe('@pneuma/plugin-manager')
})

test('包形态：ESM、两个导出子路径、patch 声明自洽', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports?.['.']).toBeDefined()
  expect(pkg.exports?.['./package.json']).toBeDefined()
  if (pkg.pneuma?.library === true) {
    expect(pkg.pneuma?.bundle).toBeUndefined()
  } else {
    expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
  }
})

test('入口：插件对象有名字与 apply', () => {
  expect(typeof pluginManagerPlugin.name).toBe('string')
  expect([pkg.name.split('/').at(-1), 'plugin-manager']).toContain(pluginManagerPlugin.name)
  expect(typeof pluginManagerPlugin.apply).toBe('function')
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

test('装配面：只依赖 tools 与 commands，自己不 provide', () => {
  expect(pluginManagerPlugin.inject).toStrictEqual(['tools', 'commands'])
  expect(pluginManagerPlugin.provide).toBeUndefined()
})
