/**
 * @pneuma/ask 的包级测试：钉 4 条不变量。
 * 为什么只钉这些：这个包对外只有插件对象，装配面、包形态、入口与文档四条就是它能被便宜钉住的全集。
 *
 * 迁移说明：原文件从 `lib/packages/ask/index.js` 取插件对象，现在直接 import 源码入口——
 * 改一行源码不构建也看得见。四条断言本身没变（装配行、包形态、入口、README），
 * 它们读的是清单与文档，不是 `index.ts` 的实现文本，所以不属于第 2 节要重写的源码文本断言。
 *
 * @module @pneuma/ask/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import * as mod from '../index.js'
import { askPlugin } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/ask', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: ask\s*$/m)
  expect(patch).toContain("name: '@pneuma/ask'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  const pkg = JSON.parse(read('../package.json')) as {
    name: string
    type: string
    exports: Record<string, { default?: string }>
    pneuma: { bundle: { patch: string }; library?: boolean }
  }
  expect(pkg.name).toBe('@pneuma/ask')
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.']?.default).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  expect(pkg.pneuma.bundle.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma.library).not.toBe(true)
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名与 apply 对得上', () => {
  // 入口应当恰好导出一个 *Plugin 对象：多一个就说明有人把另一个插件塞进了这个包。
  const keys = Object.keys(mod).filter((key) => /Plugin$/.test(key))
  expect(keys).toEqual(['askPlugin'])
  expect(typeof askPlugin).toBe('object')
  expect(typeof askPlugin.name).toBe('string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  expect(askPlugin.name).toBe('ask')
  expect(typeof askPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})
