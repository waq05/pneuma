/**
 * `@pneuma/ui-dockkit` 的包级测试：只钉两条不变量。
 *
 * 为什么只钉这两条：本包的实体在界面半（`ui/`）里，而界面半由 `ui-shell` 的构建编进壳，
 * 包自己不带可执行的宿主逻辑——能在这里验的只有「出口文件还在」与「壳的落点表指对了」。
 * 界面行为由 `scripts/ui-plugin-test.mjs` 那批集成探针负责（它们要整套壳才成立）。
 *
 * 迁移说明：旧文件读 `ui/index.ts` 源码找 `export ` 字样——那是写法断言：把导出换个写法
 * 就假红，把实现删空只留注释里的 export 就假绿。现在直接验入口文件真实存在且非空，
 * 落点表那条把表里的相对路径解析回磁盘再验一次，壳改指别处当场红。
 *
 * @module @pneuma/ui-dockkit/tests
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { expect, test } from 'vitest'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 壳的落点表：`@dsc/<包>` → 相对 `ui-shell/` 的源码路径。 */
const table = JSON.parse(read('../../../../ui-shell/packages.json')) as Record<string, string>
const target = table['@dsc/ui-dockkit']

test('界面半的入口还在：ui/index.ts 存在且非空', () => {
  const entry = new URL('../ui/index.ts', import.meta.url)
  expect(existsSync(entry), 'ui/index.ts 不见了：包被搬空或改成了空文件').toBe(true)
  expect(statSync(entry).size).toBeGreaterThan(0)
})

test('壳的落点表指到本包的 ui/index.ts，且目标文件在磁盘上', () => {
  expect(typeof target).toBe('string')
  expect(
    target.endsWith('src/packages/ui-dockkit/ui/index.ts'),
    `ui-shell/packages.json 里 @dsc/ui-dockkit 指向 ${String(target)}，不是 src/packages/ui-dockkit/ui/index.ts`,
  ).toBe(true)
  expect(existsSync(new URL('../../../../ui-shell/' + target, import.meta.url))).toBe(true)
})
