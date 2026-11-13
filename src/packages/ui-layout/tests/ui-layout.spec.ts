/**
 * `@pneuma/ui-layout` 的包级测试：钉住「它现在是一个客户端插件」这几条不变量。
 *
 * 为什么只钉形状、不钉界面行为：本包的实体在界面半（`ui/`）里，由 `ui-shell` 的构建打
 * 成 `lib/ui/plugins/layout/client.js`；界面行为由 `scripts/ui-plugin-test.mjs` 那批集成
 * 探针负责（它们要整套壳才成立）。这里能验的是「声明的三处（package.json / cordis.patch.yml /
 * 壳的落点表）对得上」。
 *
 * 迁移说明：旧文件 8 条里，3 条是读 `ui/*.tsx` / `ui-boot/ui/boot.ts` 源码的写法断言
 * （「只转出 App、不转出 createHostChannel」「app.tsx 从 @dsc/ui-runtime 取 hook」）。
 * 「组件文件里写了哪行 import」测的是写法不是行为，改个等价写法就假红；要真验界面半
 * 得进 jsdom + `@dsc/*`，属 ui project 与集成探针的活，unit 层不硬跑（会变成一堆
 * Cannot find module）。所以其中 1 条纯写法用例删除，另 2 条只保留其中真有数据接缝的
 * 那一半（平台种子表），并在标题里写明。用例数 8 -> 7。
 *
 * @module @pneuma/ui-layout/tests
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { expect, test } from 'vitest'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  type: string
  exports: { '.': { default: string }; './client': string }
  pneuma: {
    library?: boolean
    order: number
    resolution: string
    bundle: { patch: string }
    client: { platform: string; api: string; phase: string }
  }
}

const pkg = JSON.parse(read('../package.json')) as PackageJson
/** 界面契约版本 = 壳包的 version。不写死：抬产品号时这份测试不用跟着改。 */
const shellVersion = (JSON.parse(read('../../../../ui-shell/package.json')) as { version: string }).version
/** 壳的落点表：`@dsc/<包>` → 相对 `ui-shell/` 的源码路径。 */
const table = JSON.parse(read('../../../../ui-shell/packages.json')) as Record<string, string>
/** 平台种子：浏览器侧可 `require` 到的那批模块，顺序也是契约的一部分。 */
const modules = JSON.parse(read('../../ui-boot/ui/platform-modules.json')) as string[]

test('界面半的入口还在：ui/index.ts 存在且非空', () => {
  const entry = new URL('../ui/index.ts', import.meta.url)
  expect(existsSync(entry), 'ui/index.ts 不见了：包被搬空或改成了空文件').toBe(true)
  expect(statSync(entry).size).toBeGreaterThan(0)
})

test('壳的落点表指到本包的 ui/index.ts，且目标文件在磁盘上', () => {
  const target = table['@dsc/ui-layout']
  expect(
    typeof target === 'string' && target.endsWith('src/packages/ui-layout/ui/index.ts'),
    `ui-shell/packages.json 里 @dsc/ui-layout 指向 ${String(target)}，不是 src/packages/ui-layout/ui/index.ts`,
  ).toBe(true)
  expect(existsSync(new URL('../../../../ui-shell/' + target, import.meta.url))).toBe(true)
})

test('package.json：客户端插件的身份（去 library、有 patch / order / client / ./client）', () => {
  expect(pkg.pneuma.library, '还是 pneuma.library：那样就没有行、没有开关').toBeUndefined()
  expect(pkg.pneuma.bundle.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma.order, 'order 要排在 19 个界面单元（350–368）之前').toBe(349)
  expect(pkg.pneuma.resolution).toBe('overridable')
  expect(pkg.exports['./client'], './client 要指到界面半的入口').toBe('./ui/ui.tsx')
  expect(pkg.pneuma.client.platform).toBe('pneuma')
  expect(pkg.pneuma.client.api).toBe('^' + shellVersion)
  expect(pkg.pneuma.client.phase, '首屏批：骨架要在首帧前就位').toBe('early')
})

test('cordis.patch.yml：一行 insert，id 与包名都是本包', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toContain('- insert:')
  expect(patch).toContain('- id: ui-layout')
  expect(patch).toContain("name: '@pneuma/ui-layout'")
})

test('布局不再是平台种子：@dsc/ui-layout 不在 ui-boot 的平台种子表里', () => {
  // 实现随自己的 bundle 走；留在种子里等于让壳内联出第二份实现。
  expect(modules, `platform-modules.json 里还有 @dsc/ui-layout：${modules.join(',')}`).not.toContain('@dsc/ui-layout')
})

test('共享状态入口在平台种子里：@dsc/ui-runtime 可被 require，全局只有一份', () => {
  expect(modules, `platform-modules.json 里没有 @dsc/ui-runtime：${modules.join(',')}`).toContain('@dsc/ui-runtime')
})

test('装配行在 src 里就位（构建脚本按目录扫，缺了 rows 就空）', () => {
  expect(existsSync(new URL('../cordis.patch.yml', import.meta.url))).toBe(true)
})
