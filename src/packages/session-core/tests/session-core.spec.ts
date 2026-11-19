/**
 * `@pneuma/session-core` 的包级测试：钉库包身份、桶文件转出与入口可加载。
 *
 * 「逐行转出」这条原来读 `index.ts` 文本找 `export * from './x.js'`，现在改成
 * 真的 import 每个模块与桶文件，逐键比对「模块导出的每个值都能从桶文件拿到、
 * 且是同一个绑定」——桶文件漏转出会当场红，改引号/缩进不会。
 *
 * @module @pneuma/session-core/tests
 */
import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import * as compact from '../compact.js'
import * as hooks from '../hooks.js'
import * as loop from '../loop.js'
import * as modes from '../modes.js'
import * as prompt from '../prompt.js'
import * as barrel from '../index.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
const MODULES = ['hooks', 'compact', 'prompt', 'loop', 'modes'] as const
const modules: Record<(typeof MODULES)[number], Record<string, unknown>> = { hooks, compact, prompt, loop, modes }

test('库包身份：private + pneuma.library，没有装配行', () => {
  expect(pkg.name).toBe('@pneuma/session-core')
  expect(pkg.version).toBe(JSON.parse(read('../../../../package.json')).version)
  expect(pkg.private).toBe(true)
  expect(pkg.type).toBe('module')
  expect(pkg.pneuma.library).toBe(true)
  expect(pkg.pneuma.bundle).toBeUndefined()
  expect(existsSync(new URL('../cordis.patch.yml', import.meta.url))).toBe(false)
})

test('exports 的模块子路径键与目标一字不差', () => {
  expect(pkg.exports['.'].default).toBe('./index.js')
  expect(pkg.exports['./package.json']).toBe('./package.json')
  for (const name of MODULES) expect(pkg.exports[`./${name}.js`]).toBe(`./${name}.js`)
})

test('桶文件转出全部模块，且拿到的是同一个绑定', () => {
  for (const name of MODULES) {
    expect(existsSync(new URL(`../${name}.ts`, import.meta.url))).toBe(true)
    const entries = Object.entries(modules[name])
    expect(entries.length).toBeGreaterThan(0)
    for (const [key, value] of entries) {
      expect(barrel[key as keyof typeof barrel], `桶文件没转出 ${name}.ts 的 ${key}`).toBe(value)
    }
  }
})

test('README 两段都在', () => {
  const text = read('../README.md')
  expect(text).toMatch(/^## Model Experience/m)
  expect(text).toMatch(/^## Known Limitations/m)
})

test('入口能加载，且至少导出函数或常量', () => {
  const values = Object.values(barrel)
  expect(values.length).toBeGreaterThan(0)
  expect(
    values.some((value) => typeof value === 'function' || (typeof value === 'object' && value !== null)),
  ).toBe(true)
})
