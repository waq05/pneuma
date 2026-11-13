/**
 * `@pneuma/ui-runtime` 的包级测试：钉住「共享状态只有一份」这条不变量。
 *
 * 为什么这条最要紧：布局插件与 19 个界面单元都读 RuntimeContext / 页与视图信号 / 外观落地。
 * 它们一旦分家，症状是首渲染抛「useHostChannel 必须在 RuntimeProvider 里用」——而错误现场
 * 在浏览器里，构建期一声不响。所以这里从几个方向把它钉住：本包的模块清单与壳的落点表、
 * 平台种子表、库包声明。
 *
 * 迁移说明（D2）：旧文件整份读 `.ts`/`.tsx` 源码文本再 `assert.match`——
 *   - `ui/index.ts` 的六条 `export * from './x'`；
 *   - `ui-boot/ui/boot.ts` 里那两行 import / require 表；
 *   - `ui-shell/src/plugin-api.ts` 的转出清单与「不许引 @dsc/ui-layout」。
 * 这些断的是写法不是行为（改引号、加注释、换个等价的转出写法都会假红），按迁移手册
 * 第 2 节处理：前两条换成「六个模块文件都在」「平台种子表里有它」这类数据/文件面事实；
 * 第三条整条删掉——它验的是 `ui-shell` 的源码，且 `scripts/ui-plugin-test.mjs` 的 [5b]
 * 已经逐文件走查 import 把同一件事钉住了（见 `ui/index.ts` 文件头的分层纪律）。
 * 界面半要 jsdom + `@dsc/*` 才能 import，按本批规矩不进 unit 层。
 *
 * @module @pneuma/ui-runtime/tests
 */
import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { apply, name } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  pneuma: { library?: boolean; bundle?: unknown }
}

const pkg = JSON.parse(read('../package.json')) as PackageJson

/** 界面半 `ui/index.ts` 转出的六个模块。 */
const UI_MODULES = [
  'appearance.ts',
  'host-channel.ts',
  'page-state.ts',
  'runtime-context.tsx',
  'thread-view.ts',
  'usage-today.ts',
]

test('界面半齐：六个模块文件都在 ui/ 下', () => {
  // 为什么不 import：这六个模块要 React/DOM 与 `@dsc/*` 解析条件，unit 层（node 环境）
  // 装载不了；能在这里验的是模块没被搬走/改名——壳按 ui/index.ts 装载时才会踩空。
  for (const file of UI_MODULES) {
    expect(existsSync(new URL(`../ui/${file}`, import.meta.url)), `ui/${file} 不见了`).toBe(true)
  }
})

test('壳的落点表指到本包的 ui/index.ts', () => {
  const table = JSON.parse(read('../../../../ui-shell/packages.json')) as Record<string, string>
  const target = table['@dsc/ui-runtime']
  expect(target, 'ui-shell/packages.json 里没有 @dsc/ui-runtime').toBeDefined()
  expect(
    target?.endsWith('src/packages/ui-runtime/ui/index.ts'),
    `ui-shell/packages.json 里 @dsc/ui-runtime 指向 ${String(target)}`,
  ).toBe(true)
})

test('它是库包：pneuma.library 为真、没有装配行', () => {
  expect(pkg.pneuma.library, '不是库包：那就会有一行、可以被停用，共享状态也就跟着没了').toBe(true)
  expect(pkg.pneuma.bundle, '有 pneuma.bundle：库包不该产出 client.js').toBeUndefined()
})

test('平台种子表认它（插件在浏览器里按包名 require 到壳里这一份）', () => {
  const modules = JSON.parse(read('../../ui-boot/ui/platform-modules.json')) as string[]
  expect(modules, `platform-modules.json 里没有它：${modules.join(',')}`).toContain('@dsc/ui-runtime')
})

test('入口能加载：库包的空 apply，name 与包名同源', () => {
  expect(typeof apply).toBe('function')
  expect(apply()).toBeUndefined()
  expect(pkg.name).toBe('@pneuma/' + name)
})
