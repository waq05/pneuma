/**
 * @pneuma/host-stdio 的包级测试：钉 5 条不变量。
 * 为什么只钉这些：宿主协议版本号是两端握手的唯一凭据，版本对不上会静默错位，
 * 所以额外钉它并与运行时核心那份对齐。
 * @module @pneuma/host-stdio/tests
 */
import { readFileSync } from 'node:fs'
import { HOST_PROTOCOL_VERSION as CORE_PROTOCOL_VERSION } from '@pneuma/runtime/core/dock-browser.js'
import { expect, test } from 'vitest'
import { HOST_PROTOCOL_VERSION, hostStdioPlugin } from '../index.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/host-stdio', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: host-stdio\s*$/m)
  expect(patch).toContain("name: '@pneuma/host-stdio'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  const pkg = JSON.parse(read('../package.json')) as {
    name: string
    type: string
    exports: Record<string, { default?: string } | string>
    pneuma: { bundle?: { patch?: string }; library?: boolean }
  }
  expect(pkg.name).toBe('@pneuma/host-stdio')
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.']).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  expect(pkg.pneuma.bundle?.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma.library).not.toBe(true)
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名与 apply 对得上', () => {
  const pkg = JSON.parse(read('../package.json')) as { name: string }
  expect(typeof hostStdioPlugin).toBe('object')
  expect(typeof hostStdioPlugin.name).toBe('string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  expect(hostStdioPlugin.name).toBe(pkg.name.slice('@pneuma/'.length))
  expect(hostStdioPlugin.name).toBe('host-stdio')
  expect(typeof hostStdioPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

// 握手凭据：正整数，且与运行时核心那份是同一个数。两边各写一份版本号时，
// 这里就是唯一会红的地方。
test('协议版本是正整数，且与运行时核心那份一致', () => {
  expect(Number.isInteger(HOST_PROTOCOL_VERSION)).toBe(true)
  expect(HOST_PROTOCOL_VERSION).toBeGreaterThan(0)
  expect(HOST_PROTOCOL_VERSION).toBe(CORE_PROTOCOL_VERSION)
})
