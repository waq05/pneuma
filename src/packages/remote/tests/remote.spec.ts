/**
 * @pneuma/remote 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：起服务、抢主控位要真端口与磁盘，这里只钉清单、包形态、入口对象，以及纯路径函数 remoteAssetsDir 的落点。
 *
 * 迁移说明：装配行改成 `YAML.parse` 后断言结构；入口直接 import 源码，不再依赖 `lib/` 产物。
 * @module @pneuma/remote/tests
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import YAML from 'yaml'
import { expect, test } from 'vitest'
import { remoteAssetsDir, remotePlugin } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  type?: string
  exports?: Record<string, { default?: string } | string>
  pneuma?: { library?: boolean; bundle?: { patch?: string } }
}

/** 装配文件里的一行。 */
interface PatchRow {
  id?: string
  name?: string
}

const pkg = JSON.parse(read('../package.json')) as PackageJson

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = YAML.parse(read('../cordis.patch.yml')) as Array<{ insert?: PatchRow[] }>
  const row = patch.flatMap((layer) => layer.insert ?? []).find((item) => item.id === 'remote')
  expect(row, '装配行缺 id: remote').toBeDefined()
  expect(row?.name, "装配行缺 name: '@pneuma/remote'").toBe('@pneuma/remote')
})

test('包形态：ESM、两个导出子路径、patch 声明自洽', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports?.['.'], 'exports 必须有 "."').toBeDefined()
  expect(pkg.exports?.['./package.json'], 'exports 必须有 "./package.json"').toBeDefined()
  if (pkg.pneuma?.library === true) {
    expect(pkg.pneuma?.bundle).toBeUndefined()
  } else {
    expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
  }
})

test('入口：插件对象有名字与 apply', () => {
  expect(typeof remotePlugin.name).toBe('string')
  expect([pkg.name.split('/').at(-1), 'remote']).toContain(remotePlugin.name)
  expect(typeof remotePlugin.apply).toBe('function')
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

test('静态资源目录：绝对路径且落在 remote/assets', () => {
  const dir = remoteAssetsDir()
  expect(isAbsolute(dir)).toBe(true)
  expect(dir.endsWith(['remote', 'assets'].join(sep))).toBe(true)
})
