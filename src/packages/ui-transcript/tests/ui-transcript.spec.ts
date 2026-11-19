/**
 * `@pneuma/ui-transcript` 的包级测试：薄宿主半的身份（name）、空 apply 与清单声明的对齐。
 *
 * 真画东西的界面半在 `ui/ui.tsx`，由界面壳单独构建，不在包级测试里跑；
 * 这里只钉宿主半与 `package.json` / `cordis.patch.yml` 的形状。
 *
 * 迁移说明：旧文件是自造 `check()` runner——逐条打印 PASS/FAIL、自己累加计数并在最后
 * `process.exit(1)`；入口还从 `lib/packages/ui-transcript/index.js`（构建产物）装载。
 * 现在改成 Vitest 的 `test` + `expect`，入口直接 import 源码 `../index.js`（改源码
 * 立刻生效，不必先 `pnpm run build`），计数与退出码交给 Vitest。
 *
 * @module @pneuma/ui-transcript/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { apply, name } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  exports: { './client': string }
  pneuma: {
    order: number
    client: { platform: string; api: string }
  }
}

const manifest = JSON.parse(read('../package.json')) as PackageJson
const patch = read('../cordis.patch.yml')
/** 界面契约版本 = 壳包的 version。不写死：抬产品号时这份测试不用跟着改。 */
const shellVersion = JSON.parse(read('../../../../ui-shell/package.json')) as { version: string }

test('导出的 name 是 ui-transcript', () => {
  expect(name).toBe('ui-transcript')
})

test('apply 是空实现：不吃参数、调用不做任何事', () => {
  expect(apply.length).toBe(0)
  expect(apply()).toBeUndefined()
})

test('package.json：order 368（界面段里 transcript 的位置）', () => {
  expect(manifest.pneuma.order).toBe(368)
})

test('界面半的声明在：./client 指到 ui/ui.tsx，pneuma.client 写了平台与 API', () => {
  expect(manifest.exports['./client']).toBe('./ui/ui.tsx')
  expect(manifest.pneuma.client.platform).toBe('pneuma')
  expect(manifest.pneuma.client.api).toBe('^' + shellVersion.version)
})

test('行 id 与导出的 name 一致，行的 name 是这个包', () => {
  // 行 id 与模块导出的名字同源，停用这个开关才关得对包。
  const rowId = /- id: (\S+)/.exec(patch)?.[1]
  expect(rowId).toBe(name)
  expect(patch).toContain("name: '" + manifest.name + "'")
})
