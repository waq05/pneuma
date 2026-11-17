/**
 * `@pneuma/ui-preview` 的包级测试：钉 6 条不变量。
 *
 * 为什么只钉这些：本包的宿主半只有一行身份（`name` + 空 `apply`），
 * 真正的界面在 `ui/ui.tsx` 里、由界面壳的构建编进壳——这里能验的只是
 * 「清单说它是谁、产物还在不在、入口导出的名字与清单同源」。
 * 界面行为要整套壳才成立，归 `scripts/ui-plugin-test.mjs` 那批集成探针。
 *
 * 迁移说明：旧文件从 `lib/packages/ui-preview/index.js`（构建产物）装载，并自己累加
 * passed 计数。`vitest.config.ts` 禁止测试 import `lib/`（改源码不重建就看不出变化），
 * 所以入口改成直接 import 源码 `../index.js`；计数交给 Vitest，断言换成 `expect`。
 * `package.json` / `cordis.patch.yml` / `README.md` 是包清单与文档，不是 `.ts`/`.tsx`
 * 源码文本，继续按原文断言。
 *
 * @module @pneuma/ui-preview/tests
 */
import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { apply, name } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  type: string
  exports: {
    '.': { default: string }
    './package.json': string
    './client': string
  }
  pneuma: {
    order: number
    bundle: { patch: string }
  }
}

const pkg = JSON.parse(read('../package.json')) as PackageJson

test('装配行与包名对得上：cordis.patch.yml 里 id 与 name 都是本包', () => {
  const patch = read('../cordis.patch.yml')
  // 为什么钉：行 id 写成别的包，插件中心的开关就永远关不掉这个包（关的是别人）。
  expect(patch, 'cordis.patch.yml 里没有 id: ui-preview').toContain('id: ui-preview')
  expect(patch, "cordis.patch.yml 里没有 name: '@pneuma/ui-preview'").toContain("name: '@pneuma/ui-preview'")
})

test('包形态：ESM、两个出口、功能包声明 bundle.patch', () => {
  // 为什么钉：包级产物按 ESM 加载，出口少了壳就 import 不到；patch 声明丢了装配行不生效。
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.'].default, '缺少 exports["."]').toBe('./index.js')
  expect(pkg.exports['./package.json'], '缺少 exports["./package.json"]').toBe('./package.json')
  expect(pkg.pneuma.bundle.patch).toBe('./cordis.patch.yml')
})

test('入口能加载：导出的 name 是字符串且与包名同源，apply 是函数', () => {
  // 为什么钉：模块导出的名字是这一行的身份，必须等于行 id / 包名后缀，
  // 否则插件清单与产物对不上号，停用/加载都找不到它。
  expect(typeof name).toBe('string')
  expect(name).toBe('ui-preview')
  expect(typeof apply, '入口没有导出 apply：这一行装配不起来').toBe('function')
  expect(pkg.name).toBe('@pneuma/' + name)
})

test('README 留着两段人读的契约', () => {
  const readme = read('../README.md')
  expect(readme, 'README 丢了 ## Model Experience 段').toContain('## Model Experience')
  expect(readme, 'README 丢了 ## Known Limitations 段').toContain('## Known Limitations')
})

test('order 落在界面单元专用段 350–368', () => {
  // 为什么钉：19 个界面单元按 id 字典序占 350–368，越段就会跟别的层抢号。
  expect(typeof pkg.pneuma.order).toBe('number')
  expect(
    pkg.pneuma.order >= 350 && pkg.pneuma.order <= 368,
    'pneuma.order = ' + String(pkg.pneuma.order) + '，超出界面单元专用段 350–368',
  ).toBe(true)
})

test('界面半的出口指向 ui/ui.tsx 且文件在', () => {
  // 为什么钉：界面半搬走/改名后 exports["./client"] 会指空，壳按启动图装载时才发现。
  expect(pkg.exports['./client']).toBe('./ui/ui.tsx')
  expect(existsSync(new URL('../ui/ui.tsx', import.meta.url)), 'ui/ui.tsx 不见了').toBe(true)
})
