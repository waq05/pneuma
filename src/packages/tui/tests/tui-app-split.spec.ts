/**
 * `@pneuma/tui` 的包级测试。
 *
 * 一、搬家门禁：终端界面的组件树在 `src/packages/tui/app/`，旧根 `src/app` 已经不存在。
 * 这是目录结构事实，用文件系统断言即可，不读源码文本。
 *
 * 二、等价行为用例（迁移时补的，替代被删的源码扫描）：旧文件另两条是
 *   [b] 递归扫 `app/` 下每个 `.ts`/`.tsx`，断言没有 `../` 形式的 import；
 *   [c] 读 `tui/index.ts` 断言它 `import './app/App.js'`、不再走
 *       `@pneuma/runtime/app/App.js`。
 * 这两条都是「源码长什么样」而不是「程序做什么」：改一行注释、换一种等价写法就会红，
 * 把 import 真改坏却可能照样绿。按迁移手册第 2 节属必删项（要验 import 图的边界，
 * 应落在构建期门禁上）。把它们换成 `app/` 下两个纯模块的真实行为用例——显示宽度与
 * 行高缓存是滚动/折行的地基，改坏会让终端渲染错位，测行为比测写法更能抓住回归。
 *
 * 迁移说明：旧文件用 `node:test` + `node:assert`；现在换成 `vitest` 的 `test` + `expect`。
 * 两个纯模块都不依赖 React/ink，可以在 unit 层（node 环境）直接 import。
 *
 * @module @pneuma/tui/tests
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { displayWidth } from '../app/display-width.js'
import { HeightCache } from '../app/scroll-model.js'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const appDir = join(root, 'src/packages/tui/app')

test('组件树搬进了 tui 包，旧根 src/app 不再存在', () => {
  expect(statSync(appDir).isDirectory(), 'src/packages/tui/app 应当存在且是目录').toBe(true)
  expect(existsSync(join(appDir, 'App.tsx')), 'src/packages/tui/app/App.tsx 应当存在').toBe(true)
  expect(existsSync(join(root, 'src/app')), 'src/app 目录必须已经不存在').toBe(false)
})

test('显示宽度：CJK / 全角记 2 列，ASCII 记 1 列', () => {
  expect(displayWidth('')).toBe(0)
  expect(displayWidth('abc')).toBe(3)
  expect(displayWidth('中文'), '两个汉字占 4 列').toBe(4)
  expect(displayWidth('a中'), '混排按码位累加').toBe(3)
})

test('行高缓存：换宽度整表作废，同一宽度不丢已量的行数，非正行数不进表', () => {
  const cache = new HeightCache()
  cache.useWidth(80)
  cache.set(1, 3)
  cache.set(2, 0)
  expect(cache.get(1)).toBe(3)
  expect(cache.get(2), '0 行不进表（没量到的条目才该走估算）').toBeUndefined()
  expect(cache.size).toBe(1)

  // 同一宽度再设一次：折行没变，量到的行数继续用。
  cache.useWidth(80)
  expect(cache.get(1)).toBe(3)

  // 宽度变了：折行位置全变，旧行数必须整表作废。
  cache.useWidth(100)
  expect(cache.get(1)).toBeUndefined()
  expect(cache.size).toBe(0)
})
