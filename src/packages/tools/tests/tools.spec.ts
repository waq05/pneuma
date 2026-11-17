/**
 * @pneuma/tools 的包级测试：钉 7 条不变量。
 * 为什么只钉这些：这是纯内存注册表，服务本身就能整套便宜地验，不需要会话、模型或磁盘。
 * 导入面是源码入口（`../index.js`），不是 `lib/` 产物。
 * @module @pneuma/tools/tests
 */
import { readFileSync } from 'node:fs'
import type { Plugin } from '@deepseek-ai/cordis'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { ToolService } from '@pneuma/runtime/services/types.js'
import { expect, test, vi } from 'vitest'
import { toolsPlugin } from '../index.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))

/** 造一个形状合法的工具条目；用例只关心 name 与对象身份时用它兜住其余必填字段。 */
function tool(name: string): ToolEntry {
  return { name, description: `测试用工具 ${name}`, parameters: {}, risk: 'read', run: async () => '' }
}

/** 假 ctx：这个插件只做一件事——provide 出 tools 服务。 */
function makeService(): ToolService {
  let service: ToolService | undefined
  const fakeCtx = {
    provide: (_name: string, value: ToolService) => {
      service = value
    },
  }
  // 假 ctx 只实现 provide；插件只用到这一位。
  ;(toolsPlugin.apply as (ctx: unknown, config?: unknown) => void)(fakeCtx)
  expect(service).toBeDefined()
  return service as ToolService
}

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/tools', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: tools\s*$/m)
  expect(patch).toContain("name: '@pneuma/tools'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml（库包则相反）。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.'].default).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  if (pkg.pneuma.library === true) {
    expect(pkg.pneuma.bundle).toBeUndefined()
  } else {
    expect(pkg.pneuma.bundle.patch).toBe('./cordis.patch.yml')
  }
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名、provide 与 apply 对得上', () => {
  expect(typeof toolsPlugin).toBe('object')
  expect(typeof toolsPlugin.name).toBe('string')
  expect(toolsPlugin.name).toBe(pkg.name.split('/').pop())
  expect(toolsPlugin.name).toBe('tools')
  expect(toolsPlugin.provide).toBe('tools')
  expect(typeof toolsPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

// 注册表：注册后进 list，注销只删自己那一条，别人同名的条目不该被误删。
test('tools 服务：注册进表，注销的是自己那一条', () => {
  const service = makeService()
  const first = tool('demo')
  const offFirst = service.register(first)
  expect(service.list().map((entry) => entry.name)).toEqual(['demo'])
  const second = tool('demo')
  service.register(second)
  expect(service.list()).toEqual([second])
  offFirst()
  // 旧条目的注销函数只认自己那次注册：同名的新条目必须原样留着。
  expect(service.list()).toEqual([second])
})

// 形状关：dsh 风格定义（有 execute 没 run）必须当场拦下并指路兼容层，不能等模型调用时才炸。
test('注册表拦下 dsh 风格定义并指点兼容层，也拦下空名与缺 run', () => {
  const service = makeService()
  const dshStyle = { name: 'bad', execute: () => {} } as unknown as ToolEntry
  expect(() => service.register(dshStyle)).toThrow(/dsh 风格/)
  expect(() => service.register(tool(''))).toThrow(/非空的 name/)
  expect(() => service.register({ name: 'noRun' } as unknown as ToolEntry)).toThrow(/缺 run 函数/)
})

// 目录投影：只做减法、按注册顺序叠加；一个投影崩了就跳过它，别让整轮请求失败。
test('visible 只做减法，崩掉的投影跳过而不是整轮失败', () => {
  const service = makeService()
  service.register(tool('a'))
  service.register(tool('b'))
  const off = service.project('only-a', (list) => list.filter((entry) => entry.name === 'a'))
  expect(service.visible().map((entry) => entry.name)).toEqual(['a'])
  off()
  expect(service.visible().map((entry) => entry.name).sort()).toEqual(['a', 'b'])
  const offBad = service.project('boom', () => {
    throw new Error('boom')
  })
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(service.visible().map((entry) => entry.name).sort()).toEqual(['a', 'b'])
    expect(errorLog).toHaveBeenCalled()
  } finally {
    offBad()
    errorLog.mockRestore()
  }
})
