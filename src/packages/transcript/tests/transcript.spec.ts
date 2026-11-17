/**
 * `@pneuma/transcript` 的包级测试：钉 5 条不变量。
 *
 * 为什么只钉这些：本包是纯服务插件（provide `transcript`），条目折叠的实体在
 * `@pneuma/runtime/adapter/transcript.js` 里；包这一层能验的只有装配声明、
 * 入口对象形状，以及它对兄弟服务的 inject 依赖——少写一个 inject，
 * `getSnapshot()` 里 `ctx.surfaces`/`ctx.session` 会当场抛
 * 「cannot get property ... without inject」，整个界面快照就断了。
 *
 * 迁移说明：原来加载的是 `lib/packages/transcript/index.js`（构建产物），现在直接
 * import 源码入口 `../index.js`——顶层只有 import、无副作用，改一行源码不用构建也看得见。
 *
 * @module @pneuma/transcript/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { transcriptPlugin } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('装配行与包名对得上：cordis.patch.yml 里 id 与 name 都是本包', () => {
  const patch = read('../cordis.patch.yml')
  // 为什么钉：行 id 写成别的包，插件中心的开关就永远关不掉这个包（关的是别人）。
  expect(patch).toContain('id: transcript')
  expect(patch).toContain("name: '@pneuma/transcript'")
})

test('包形态：ESM、两个出口、功能包声明 bundle.patch', () => {
  const pkg = JSON.parse(read('../package.json')) as {
    type: string
    exports: Record<string, { default?: string } | string>
    pneuma: { bundle: { patch: string } }
  }
  // 为什么钉：包级产物按 ESM 加载，出口少了壳就 import 不到；patch 声明丢了装配行不生效。
  expect(pkg.type).toBe('module')
  expect((pkg.exports['.'] as { default?: string }).default).toBe('./index.js')
  expect(pkg.exports['./package.json']).toBe('./package.json')
  expect(pkg.pneuma.bundle.patch).toBe('./cordis.patch.yml')
})

test('入口能加载：transcriptPlugin 的 name 与包名同源，apply 是函数', () => {
  const pkg = JSON.parse(read('../package.json')) as { name: string }
  // 为什么钉：名字是这一行的身份，必须等于行 id / 包名后缀；
  // apply 不在，插件对象就只是个数据，装配时什么都不会发生。
  expect(typeof transcriptPlugin).toBe('object')
  expect(typeof transcriptPlugin.name).toBe('string')
  expect(transcriptPlugin.name).toBe('transcript')
  expect(typeof transcriptPlugin.apply).toBe('function')
  expect(pkg.name).toBe(`@pneuma/${String(transcriptPlugin.name)}`)
})

test('服务契约：provide transcript，inject 覆盖快照用到的三个服务', () => {
  // 为什么钉：getSnapshot 里读 ctx.session / ctx.llm / ctx.surfaces；
  // 任一 inject 漏写，快照第一次被读就抛 without inject，界面整块空白。
  expect(transcriptPlugin.provide).toBe('transcript')
  expect(Array.isArray(transcriptPlugin.inject)).toBe(true)
  const inject = transcriptPlugin.inject ?? []
  for (const dep of ['session', 'llm', 'surfaces']) {
    expect(inject, `inject 少了 ${dep}：快照读取会抛 without inject`).toContain(dep)
  }
})

test('README 留着两段人读的契约', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})
