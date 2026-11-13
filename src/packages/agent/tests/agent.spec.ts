/**
 * @pneuma/agent 的包级测试：钉 4 条不变量。
 * 为什么只钉这些：这个包对外只有插件对象，装配面与文档面钉死就能挡住"改名/改行 id"这类真实回归，再深一层就要起会话跑循环，代价不成比例。
 * @module @pneuma/agent/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { agentPlugin } from '../index.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/agent', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: agent\s*$/m)
  expect(patch).toContain("name: '@pneuma/agent'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  const pkg = JSON.parse(read('../package.json'))
  expect(pkg.name).toBe('@pneuma/agent')
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.'].default).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  expect(pkg.pneuma.bundle.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma.library).not.toBe(true)
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof agentPlugin).toBe('object')
  expect(typeof agentPlugin.name).toBe('string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  expect(agentPlugin.name).toBe('agent')
  expect(typeof agentPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})
