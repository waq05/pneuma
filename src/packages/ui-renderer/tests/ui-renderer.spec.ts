/**
 * `@pneuma/ui-renderer` 的包级测试：钉住「它现在是一个可停用的客户端插件」这几条不变量。
 *
 * 为什么只钉形状、不钉界面行为：本包的实体在界面半（`ui/`）里，由 `ui-shell` 的构建打
 * 成 `lib/ui/plugins/renderer/client.js`；界面行为由 `scripts/ui-plugin-test.mjs` 那批
 * 集成探针负责（它们要整套壳才成立）。这里能验的是「声明的三处（package.json /
 * cordis.patch.yml / 界面半的落点）对得上」与「入口已搬到引导」。
 *
 * 迁移说明（D2）：
 *   - 旧文件用 `node:test` + `node:assert`，且**读 `ui/index.ts` 与 `ui/ui.tsx` 的源码文本**
 *     再 `assert.match`（比如「`export async function start(api: UiRendererApi)`」）。
 *     那是测写法不是测行为：改缩进/换行会假红，把实现改坏但字面量留着会假红/假绿。按
 *     迁移手册第 2 节整条删掉；界面半确实要 jsdom + `@dsc/*` 才能 import，按规矩不进 unit 层。
 *     替代：用「壳的落点表 + 清单里 `./client` 的落点」验界面半接得上，用文件存在性验
 *     `ui/` 没被搬走。
 *   - 入口从 `lib/` 产物改成直接 import 源码 `../index.js`（改源码不必先构建）。
 *   - `package.json` / `cordis.patch.yml` / `ui-shell/index.html` 是清单与页面入口，
 *     不是 `.ts`/`.tsx` 源码；后两者的装配行改成解析成对象再断言。
 *
 * @module @pneuma/ui-renderer/tests
 */
import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import YAML from 'yaml'
import { apply, name } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  exports: {
    '.': { default: string }
    './client': string
    './package.json': string
  }
  pneuma: {
    library?: boolean
    bundle: { patch: string }
    order: number
    resolution: string
    client: { platform: string; api: string; immediately: boolean; phase: string }
  }
}

/** cordis.patch.yml 的形状：顶层是若干 `{ insert: [...] }`。 */
interface PatchDoc {
  insert?: { id?: string; name?: string }[]
}

const pkg = JSON.parse(read('../package.json')) as PackageJson
/** 界面契约版本 = 壳包的 version。不写死：抬产品号时这份测试不用跟着改。 */
const shellVersion = JSON.parse(read('../../../../ui-shell/package.json')) as { version: string }

test('界面半的落点在：壳的落点表指向本包 ui/index.ts，文件也都在', () => {
  // 为什么钉：界面壳按 ui-shell/packages.json 解析 @dsc/ui-renderer。落点或文件任一
  // 搬走，壳启动时才发现缺包；这里两侧一起验。
  const table = JSON.parse(read('../../../../ui-shell/packages.json')) as Record<string, string>
  const target = table['@dsc/ui-renderer']
  expect(target, 'ui-shell/packages.json 里没有 @dsc/ui-renderer').toBeDefined()
  expect(target?.endsWith('src/packages/ui-renderer/ui/index.ts'), '落点不是本包 ui/index.ts').toBe(true)
  expect(existsSync(new URL('../ui/index.ts', import.meta.url)), 'ui/index.ts 不见了').toBe(true)
  expect(existsSync(new URL('../ui/ui.tsx', import.meta.url)), 'ui/ui.tsx（插件入口）不见了').toBe(true)
})

test('package.json：客户端插件的身份（去 library、有 patch / order / client / ./client）', () => {
  expect(pkg.pneuma.library, '还是 pneuma.library：那样就没有行、没有开关').toBeUndefined()
  expect(pkg.pneuma.bundle.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma.order, 'order 要排在骨架（349）与 19 个界面单元（350–368）之前').toBe(348)
  expect(pkg.pneuma.resolution).toBe('overridable')
  expect(pkg.exports['./client'], './client 要指到界面半的入口').toBe('./ui/ui.tsx')
  expect(pkg.pneuma.client.platform).toBe('pneuma')
  expect(pkg.pneuma.client.api).toBe('^' + shellVersion.version)
  expect(pkg.pneuma.client.immediately).toBe(true)
  expect(pkg.pneuma.client.phase, '首屏批：引导要先物化它才能画首帧').toBe('early')
})

test('cordis.patch.yml：一行 insert，id 与包名都是本包', () => {
  // 解析成对象再断言：改引号/缩进/注释不会假红，多一行 insert 或写错 id 会真红。
  const doc = YAML.parse(read('../cordis.patch.yml')) as PatchDoc[]
  expect(Array.isArray(doc)).toBe(true)
  expect(doc).toHaveLength(1)
  const rows = doc[0]?.insert
  expect(rows, '这一条不是 insert').toBeDefined()
  expect(rows).toHaveLength(1)
  expect(rows?.[0]?.id).toBe(name)
  expect(rows?.[0]?.name).toBe(pkg.name)
})

test('页面入口已搬到引导：本包不再有 ui/main.tsx，index.html 的入口指向引导', () => {
  expect(existsSync(new URL('../ui/main.tsx', import.meta.url)), 'ui/main.tsx 还在：入口没搬干净').toBe(false)
  // index.html 是页面入口（构建器按它找入口模块），不是 .ts/.tsx 源码，继续按原文断言。
  const html = read('../../../../ui-shell/index.html')
  expect(html, 'index.html 的入口没指到引导').toContain('ui-boot/ui/main.tsx')
})

test('引导包的身份：库包、没有行（对应 dsh 的 client-modules）', () => {
  const boot = JSON.parse(read('../../ui-boot/package.json')) as {
    name: string
    pneuma: { library?: boolean; bundle?: unknown }
  }
  expect(boot.name).toBe('@pneuma/ui-boot')
  expect(boot.pneuma.library).toBe(true)
  expect(boot.pneuma.bundle).toBeUndefined()
})

test('入口能加载：apply 是函数，导出的 name 与包名同源', () => {
  expect(typeof apply).toBe('function')
  expect(pkg.name).toBe('@pneuma/' + name)
})
