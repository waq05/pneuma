/**
 * `@pneuma/ui-boot` 的包级测试：钉四条不变量。
 *
 * 为什么只钉这些：本包的实体在浏览器半边（`ui/`），由 `ui-shell` 的构建编进壳的 app
 * bundle；包本身没有可执行的 Node 逻辑。界面行为由 `scripts/ui-plugin-test.mjs` 那批
 * 集成探针负责（它们要整套壳才成立）。
 *
 * 迁移说明：旧文件有两条读 `ui/main.tsx` / `ui/boot.ts` 源码的写法断言（入口里有没有
 * `start`、`stripClientSuffix`、`pluginExternal` 这些字面量）。那测的是写法不是行为，
 * 要真验装载器得进浏览器 + `@dsc/*`，unit 层不硬跑。按手册第 2 节：页面入口只验
 * 「文件还在且非空」，平台种子与报错文案改成断数据表本身；装载器的判定逻辑归集成探针。
 * 用例数 4 -> 4。
 *
 * @module @pneuma/ui-boot/tests
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { expect, test } from 'vitest'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  pneuma: {
    library?: boolean
    order?: number
    bundle?: { patch: string }
  }
  exports: Record<string, string>
}

const pkg = JSON.parse(read('../package.json')) as PackageJson

test('包身份：库包（有 library、没有 patch / order），exports 至少含 boot.js 与 hmr.js', () => {
  expect(pkg.pneuma.library, '引导是库包：没有行、不能停用').toBe(true)
  expect(pkg.pneuma.bundle, '不该有 cordis.patch.yml 声明').toBeUndefined()
  expect(pkg.pneuma.order, '库包不参与行排序').toBeUndefined()
  expect(pkg.exports['./boot.js']).toBe('./boot.js')
  expect(pkg.exports['./hmr.js']).toBe('./hmr.js')
})

test('页面入口还在：ui/main.tsx 存在且非空（start(api) 的接线归界面集成探针）', () => {
  const entry = new URL('../ui/main.tsx', import.meta.url)
  expect(existsSync(entry), 'ui/main.tsx 不见了：页面入口被搬走').toBe(true)
  expect(statSync(entry).size).toBeGreaterThan(0)
})

test('平台种子表：cordis / zod / react-virtual 在表里，且夹在 @dsc/ui-runtime 与 @xterm/xterm 之间', () => {
  const seeds = JSON.parse(read('../ui/platform-modules.json')) as string[]
  for (const name of ['@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual']) {
    expect(seeds, `种子表里没有 ${name}`).toContain(name)
    // 位置也是契约：JSON 与 MODULES 的键顺序被 scripts/ui-plugin-test.mjs 逐位比对，
    // 这里只拦「加在了别人前面」这种一眼能看出来的漂移。
    expect(
      seeds.indexOf(name) > seeds.indexOf('@dsc/ui-runtime') && seeds.indexOf(name) < seeds.indexOf('@xterm/xterm'),
      `${name} 应该在 @dsc/ui-runtime 之后、@xterm/xterm 之前`,
    ).toBe(true)
  }
})

test('external 报错文案在字典里，口径是「既不是平台种子，也不是本图的插件」', () => {
  // 文案在字典里、不在 boot.ts 的字符串里（界面半的硬编码由 scripts/ui-locale-test.mjs 拦）。
  // 装载器怎么判 external（平台种子 or 本图插件）由集成探针验；这里钉的是两期共用的那句话。
  const zh = JSON.parse(read('../locale/ui.zh.json')) as Record<string, string>
  expect(typeof zh['boot.external.unknown']).toBe('string')
  expect(String(zh['boot.external.unknown'])).toContain('既不是平台种子，也不是本图的插件')
})
