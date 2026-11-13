/**
 * `@pneuma/ui-core` 的包级测试：钉库包身份、桶文件转出、子路径入口可加载与文档两段。
 *
 * 迁移说明：旧文件第 3 条读 `index.ts` 源码找 `export * from '...'` 字样——写法断言，
 * 换等价写法就假红、删实现留注释就假绿。现在直接 import 源码桶，断这些名字真在导出表上；
 * 第 5 条原来 import `lib/packages/ui-core/index.js` 产物，但 `vitest.config.ts` 禁止测试
 * 读 `lib/`，改成 import 四个子路径的源码模块（终端壳按裸说明符取的那几份）并验非空。
 *
 * @module @pneuma/ui-core/tests
 */
import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import * as uiCore from '../index.js'
import * as slots from '../slots.js'
import * as slotsInk from '../slots-ink.js'
import * as tuiPluginApi from '../tui-plugin-api.js'
import * as tuiPlugins from '../tui-plugins.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  version: string
  private: boolean
  type: string
  exports: Record<string, { types?: string; default?: string } | string>
  pneuma: { library?: boolean; bundle?: { patch?: string } }
}

const pkg = JSON.parse(read('../package.json')) as PackageJson
const rootPkg = JSON.parse(read('../../../../package.json')) as { version: string }

test('库包身份：private + pneuma.library，没有装配行', () => {
  expect(pkg.name).toBe('@pneuma/ui-core')
  expect(pkg.version).toBe(rootPkg.version)
  expect(pkg.private).toBe(true)
  expect(pkg.type).toBe('module')
  expect(pkg.pneuma.library).toBe(true)
  expect(pkg.pneuma.bundle).toBeUndefined()
  expect(existsSync(new URL('../cordis.patch.yml', import.meta.url)), '库包不该有 cordis.patch.yml').toBe(false)
})

test('exports：根入口、package.json 与终端壳要的四个模块子路径', () => {
  expect(pkg.exports['.']).toEqual({ types: './index.d.ts', default: './index.js' })
  expect(pkg.exports['./package.json']).toBe('./package.json')
  // 终端壳（@pneuma/tui）按裸说明符取这一半：键与目标必须一字不差。
  for (const name of ['slots', 'slots-ink', 'tui-plugins', 'tui-plugin-api']) {
    expect(pkg.exports[`./${name}.js`]).toBe(`./${name}.js`)
    expect(
      existsSync(new URL(`../${name}.ts`, import.meta.url)) || existsSync(new URL(`../${name}.tsx`, import.meta.url)),
      `${name} 的源码不在包里`,
    ).toBe(true)
  }
})

test('桶里有导出：槽位、帧、服务、装载约定与 core 的启动图都能从源码桶取到', () => {
  // 为什么钉：这些名字是壳与插件 require 的公共面；桶漏转出一个，调用方拿到 undefined。
  // 名字是运行期查表，编译期没有对应键，所以按字符串索引（仅此一处转 Record）。
  const barrel = uiCore as unknown as Record<string, unknown>
  for (const name of ['SlotRegistry', 'ServiceRegistry', 'UiArrivalLedger', 'isFullFrame', 'defineUiPlugin', 'composeUiBootGraph']) {
    expect(barrel[name], `index.ts 没有转出 ${name}`).toBeDefined()
  }
  // 启动图归内核：桶从 src/core/ui-manifest 取，不再有本包内的 manifest.js。
  expect(existsSync(new URL('../manifest.ts', import.meta.url)), 'manifest.ts 应该已经搬到 src/core/ui-manifest.ts').toBe(false)
})

test('README 两段都在', () => {
  const text = read('../README.md')
  expect(text).toMatch(/^## Model Experience/m)
  expect(text).toMatch(/^## Known Limitations/m)
})

test('四个模块子路径都能从源码加载，且都不是空模块', () => {
  const modules: Record<string, Record<string, unknown>> = {
    slots,
    'slots-ink': slotsInk,
    'tui-plugins': tuiPlugins,
    'tui-plugin-api': tuiPluginApi,
  }
  for (const [name, mod] of Object.entries(modules)) {
    expect(Object.keys(mod).length, `${name} 没有任何导出`).toBeGreaterThan(0)
  }
})
