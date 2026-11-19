/**
 * @pneuma/dsh-compat 的包级测试：钉 4 条不变量。
 * 为什么只钉这些：这个包是给外部插件补差异的薄壳，对外只有插件对象，四条装配面不变量是它能被便宜验证的全部。
 *
 * 迁移说明：装配行改成 `YAML.parse` 后断言结构，不再匹配文本；入口直接 import 源码。
 * @module @pneuma/dsh-compat/tests
 */
import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { expect, test } from 'vitest'
import { dshCompatPlugin } from '../index.js'

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

test('cordis.patch.yml 的装配行认的是 @pneuma/dsh-compat', () => {
  const patch = YAML.parse(read('../cordis.patch.yml')) as Array<{ insert?: PatchRow[] }>
  const row = patch.flatMap((layer) => layer.insert ?? []).find((item) => item.id === 'dsh-compat')
  // 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对。
  expect(row, '装配行的 id 必须正好是 dsh-compat').toBeDefined()
  expect(row?.name, "装配行的 name 必须是 '@pneuma/dsh-compat'").toBe('@pneuma/dsh-compat')
})

test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  expect(pkg.name).toBe('@pneuma/dsh-compat')
  expect(pkg.type).toBe('module')
  expect(pkg.exports?.['.'], 'exports 必须有 "."').toBeDefined()
  expect(pkg.exports?.['./package.json'], 'exports 必须有 "./package.json"').toBeDefined()
  expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma?.library, '功能包不该标成库包').not.toBe(true)
})

test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof dshCompatPlugin, '入口应当导出插件对象').toBe('object')
  expect(typeof dshCompatPlugin.name).toBe('string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  expect(dshCompatPlugin.name).toBe(pkg.name.slice('@pneuma/'.length))
  expect(dshCompatPlugin.name).toBe('dsh-compat')
  expect(typeof dshCompatPlugin.apply).toBe('function')
})

test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme, '缺 ## Model Experience').toContain('## Model Experience')
  expect(readme, '缺 ## Known Limitations').toContain('## Known Limitations')
})
