/**
 * `@pneuma/ui-superagent` 的包级测试：钉住宿主半的身份与清单声明这两条不变量。
 *
 * 为什么只有两条：本包的界面半（`ui/`）是 React 组件，要整套壳才成立，归 `scripts/` 的
 * 集成探针；这里只验「插件对象还在」与「清单声明没漂」。
 *
 * 迁移说明（D2）：旧文件读 `index.ts` 源码文本，用正则断言
 * `export const name = '...'` / `export function apply(`——那是测写法：多一个导出、换个
 * 声明方式都会假红。按迁移手册第 2 节首选方案 A，改成真的 import 插件对象再断言
 * `name` / `apply`（同时顺带验了模块真的能加载）。清单那半继续解析 YAML/JSON 后断言，
 * 不再是字符串包含。
 *
 * @module @pneuma/ui-superagent/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import YAML from 'yaml'
import { apply, name } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/**
 * 界面壳版本：插件清单的 pneuma.client.api 必须等于它的 ^ 区间。
 *
 * 不写死具体版本号：发版时根版本一抬，这里就该跟着走。写死 ^0.9.1 的结果是
 * 每次发版都要手改（0.9.2 就漏了，CI 上这条红）。读根 package.json 拿当下版本。
 */
const SHELL_VERSION = (JSON.parse(read('../../../../package.json')) as { version: string }).version

/** cordis.patch.yml 的形状：顶层是若干 `{ insert: [...] }`。 */
interface PatchDoc {
  insert?: { id?: string; name?: string; disabled?: boolean }[]
}

test('插件对象：导出的 name 与目录名同源、apply 是函数', () => {
  expect(typeof name).toBe('string')
  expect(name).toBe('ui-superagent')
  expect(typeof apply, 'index.ts 没有导出 apply 函数：这一行装配不起来').toBe('function')
  expect(apply()).toBeUndefined()
})

test('清单声明：pneuma.client.api 等于壳版本，cordis.patch.yml 恰好一条 insert 行', () => {
  const pkg = JSON.parse(read('../package.json')) as {
    pneuma: { client: { api: string; platform: string } }
  }
  // 为什么钉 api：界面半面对的契约区间写在清单里，壳的构建按它校验（ui-shell/build-plugins.mjs）。
  expect(pkg.pneuma.client.api, `pneuma.client.api 不是 ^${SHELL_VERSION}`).toBe(`^${SHELL_VERSION}`)
  expect(pkg.pneuma.client.platform, 'pneuma.client.platform 不是 pneuma').toBe('pneuma')

  const patch = YAML.parse(read('../cordis.patch.yml')) as PatchDoc[]
  // 为什么钉「恰好一条」：一个包只许一行；多出来的 insert 会把同一插件装两次，
  // 少一条则插件中心的开关永远关不掉这个包。
  expect(Array.isArray(patch)).toBe(true)
  expect(patch, 'cordis.patch.yml 顶层不是恰好 1 条').toHaveLength(1)
  expect(patch[0]?.insert, '这一条不是 insert').toBeDefined()
  expect(patch[0]?.insert, 'insert 里不是恰好 1 行').toHaveLength(1)
  expect(Object.keys(patch[0] ?? {}), 'insert 旁边还有别的键').toEqual(['insert'])
  const row = patch[0]?.insert?.[0]
  expect(row?.id, '行 id 与目录名不一致').toBe('ui-superagent')
  expect(row?.name, '行的 name 与包名不一致').toBe('@pneuma/ui-superagent')
  // 界面单元默认装载：其余界面包没有一个写 disabled，界面是壳的一部分。
  // 默认关的只应该是宿主包 superagent——它一开就要建库、起节拍。
  expect(row?.disabled, '界面单元不该默认关闭，patch 行里不要写 disabled').toBeUndefined()
})
