/**
 * `@pneuma/desktop-dock` 的包级测试：钉 4 条不变量。
 *
 * 为什么只钉这些：这个包对外只有插件对象，装配面、包形态、入口与文档四条钉住即可，
 * 再往下要真起桌面桥。工作区根的授权判定另有一个文件（`workspace-roots.spec.ts`）。
 *
 * 迁移说明（D2）：旧文件用 `node:test` + `node:assert`，入口从 `lib/packages/desktop-dock/
 * index.js`（构建产物）装载。现在改成 Vitest 的 `test` + `expect`，直接 import 源码
 * `../index.js`。入口会连带加载 `@pneuma/runtime/core/config.js`，那里在模块加载时读
 * `DSC_HOME`，所以先把它指到临时目录再动态 import——不让测试碰到真实的 `~/.dsc/config.yaml`。
 * cordis.patch.yml 的装配行改成解析成对象再断言（改引号/缩进不会假红）。
 *
 * @module @pneuma/desktop-dock/tests
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import YAML from 'yaml'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  type: string
  exports: { '.': { default: string }; './package.json': string }
  pneuma: { library?: boolean; bundle: { patch: string } }
}

/** cordis.patch.yml 的形状：顶层是若干 `{ insert: [...] }`。 */
interface PatchDoc {
  insert?: { id?: string; name?: string }[]
}

const pkg = JSON.parse(read('../package.json')) as PackageJson

const home = mkdtempSync(join(tmpdir(), 'dsc-desktop-dock-spec-'))
let mod: typeof import('../index.js')

beforeAll(async () => {
  // 先指临时 DSC_HOME，再动态 import：path-policy 的 DSC_HOME 是模块加载时算的。
  process.env.DSC_HOME = home
  mod = await import('../index.js')
})

afterAll(() => {
  delete process.env.DSC_HOME
  rmSync(home, { recursive: true, force: true })
})

test('cordis.patch.yml 的装配行认的是 @pneuma/desktop-dock', () => {
  const doc = YAML.parse(read('../cordis.patch.yml')) as PatchDoc[]
  expect(Array.isArray(doc)).toBe(true)
  expect(doc).toHaveLength(1)
  const rows = doc[0]?.insert
  expect(rows, '装配行的 id 必须正好是 desktop-dock').toHaveLength(1)
  expect(rows?.[0]?.id, '装配行的 id 必须正好是 desktop-dock').toBe('desktop-dock')
  expect(rows?.[0]?.name, "装配行的 name 必须是 '@pneuma/desktop-dock'").toBe('@pneuma/desktop-dock')
})

test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  expect(pkg.name).toBe('@pneuma/desktop-dock')
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.'].default, 'exports 必须有 "."').toBeTruthy()
  expect(pkg.exports['./package.json'], 'exports 必须有 "./package.json"').toBeTruthy()
  expect(pkg.pneuma.bundle.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma.library, '功能包不该标成库包').not.toBe(true)
})

test('入口能加载，插件名与 apply 对得上', () => {
  const keys = Object.keys(mod).filter((key) => /Plugin$/.test(key))
  expect(keys.length, '入口应当恰好导出一个 *Plugin 对象').toBe(1)
  const plugin = mod[keys[0] as keyof typeof mod] as { name: string; apply: unknown }
  expect(typeof plugin).toBe('object')
  expect(typeof plugin.name).toBe('string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  expect(plugin.name).toBe(pkg.name.slice('@pneuma/'.length))
  expect(plugin.name).toBe('desktop-dock')
  expect(typeof plugin.apply).toBe('function')
})

test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme, '缺 ## Model Experience').toContain('## Model Experience')
  expect(readme, '缺 ## Known Limitations').toContain('## Known Limitations')
})
