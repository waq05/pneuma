/**
 * `@pneuma/ui-slots` 的包级测试：只钉两条不变量。
 *
 * 为什么只钉这两条：本包的实体在界面半（`ui/`）里，而界面半由 `ui-shell` 的构建编进壳，
 * 包自己不带可执行的宿主逻辑——能在这里验的只有「界面半的文件还在」与「壳的落点表指对了」。
 * 界面行为由 `scripts/ui-plugin-test.mjs` 那批集成探针负责（它们要整套壳才成立）。
 *
 * 迁移说明（D2）：旧文件读 `ui/index.ts` 的源码文本，用 `assert.match(entry, /export /)`
 * 判「文件里有没有一个 export」——那既可能被一行注释糊过去，也会因为换个等价的转出写法
 * 假红，按迁移手册第 2 节换掉：改成断言两个实现模块（槽名契约 `slots.ts`、React 渲染出口
 * `slots-react.tsx`）与作者面入口都还在。界面半要 jsdom + `@dsc/*`，不进 unit 层。
 *
 * @module @pneuma/ui-slots/tests
 */
import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { apply } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('界面半的文件都在：作者面入口 + 槽名契约 + React 渲染出口', () => {
  for (const file of ['index.ts', 'slots.ts', 'slots-react.tsx']) {
    expect(existsSync(new URL(`../ui/${file}`, import.meta.url)), `ui/${file} 不见了`).toBe(true)
  }
  // 这个包是库包：宿主半只有一个空 apply（连 name 都不导出，没有行身份），
  // 也没有装配行——否则用户会看到一个点了没反应的假开关。
  expect(typeof apply).toBe('function')
  expect(apply()).toBeUndefined()
  const pkg = JSON.parse(read('../package.json')) as { name: string; pneuma: { library?: boolean } }
  expect(pkg.name).toBe('@pneuma/ui-slots')
  expect(pkg.pneuma.library).toBe(true)
})

test('壳的落点表指到本包的 ui/index.ts', () => {
  const table = JSON.parse(read('../../../../ui-shell/packages.json')) as Record<string, string>
  const target = table['@dsc/ui-slots']
  expect(
    typeof target === 'string' && target.endsWith('src/packages/ui-slots/ui/index.ts'),
    `ui-shell/packages.json 里 @dsc/ui-slots 指向 ${String(target)}，不是 src/packages/ui-slots/ui/index.ts`,
  ).toBe(true)
})
