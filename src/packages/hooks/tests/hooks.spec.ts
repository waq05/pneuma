/**
 * @pneuma/hooks 的包级测试：钉 7 条不变量。
 * 为什么只钉这些：这个包对外只有插件对象，规则解析要真读磁盘配置才跑得起来，代价不划算，
 * 所以只钉装配面与入口；0.9.0 把外部命令钩子（原 @pneuma/lifecycle-hooks）并了进来，
 * 事件表与命令白名单是纯函数、写错等于让拦截形同虚设，所以把原包那两条断言一起搬到这里，
 * 并钉住十四个事件的接通档位。
 * @module @pneuma/hooks/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { hooksPlugin } from '../index.js'
import {
  commandAllowed,
  LIFECYCLE_CAPABILITIES,
  LIFECYCLE_EVENTS,
  LIFECYCLE_MATCHER_EVENTS,
  matcherSupported,
} from '../lifecycle-hooks.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/hooks', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: hooks\s*$/m)
  expect(patch).toContain("name: '@pneuma/hooks'")
  expect(patch).not.toMatch(/lifecycle-hooks/)
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  const pkg = JSON.parse(read('../package.json')) as {
    name: string
    type: string
    exports: Record<string, { default?: string } | string>
    pneuma: { bundle?: { patch?: string }; library?: boolean; settingsSection?: string }
  }
  expect(pkg.name).toBe('@pneuma/hooks')
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.']).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  expect(pkg.pneuma.bundle?.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma.library).not.toBe(true)
  // 合并后设置分区仍是 hooks（外部命令那一组在同一页）。
  expect(pkg.pneuma.settingsSection).toBe('hooks')
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名、apply 与注入表对得上', () => {
  const pkg = JSON.parse(read('../package.json')) as { name: string }
  expect(typeof hooksPlugin).toBe('object')
  expect(typeof hooksPlugin.name).toBe('string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  expect(hooksPlugin.name).toBe(pkg.name.slice('@pneuma/'.length))
  expect(hooksPlugin.name).toBe('hooks')
  expect(hooksPlugin.provide).toBe('hooks')
  expect(typeof hooksPlugin.apply).toBe('function')
  // 外部命令钩子的两个服务并进来之后，注入表要带 llm 与 prompt（投影挂在这两个上）。
  const inject = [...(hooksPlugin.inject as string[])]
  for (const service of ['llm', 'prompt', 'guards', 'settings']) {
    expect(inject, `inject 缺 ${service}`).toContain(service)
  }
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

// 事件表是外部钩子的唯一协议面：名字按 codex 写，档位计数写错等于谎报接通情况。
test('事件名沿用 codex 写法，只有三个事件支持 matcher，档位仍是 3/5/6', () => {
  for (const event of ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop']) {
    expect(LIFECYCLE_EVENTS, `事件表缺 ${event}`).toContain(event)
  }
  expect(LIFECYCLE_EVENTS).toHaveLength(14)
  expect(LIFECYCLE_MATCHER_EVENTS).toEqual(['PreToolUse', 'PostToolUse', 'SessionStart'])
  expect(matcherSupported('PreToolUse')).toBe(true)
  expect(matcherSupported('Stop')).toBe(false)
  const tiers = LIFECYCLE_CAPABILITIES.map((item) => item.tier)
  expect(tiers.filter((tier) => tier === 'wired')).toHaveLength(3)
  expect(tiers.filter((tier) => tier === 'partial')).toHaveLength(5)
  expect(tiers.filter((tier) => tier === 'unwired')).toHaveLength(6)
})

// 白名单是空串时**一律放行**（不限制），不是「只放行空命令」——旧标题把两者说反了。
test('命令白名单是空串时一律放行', () => {
  expect(commandAllowed('echo hi', '')).toBe(true)
})

// 写了名单才按入口词限制：词边界只认空格 / 斜杠 / 行尾，`nodejs-evil` 不能蹭 `node`。
test('命令白名单按入口词匹配，前缀相同的另一个程序不蹭放行', () => {
  const allow = 'node,pnpm'
  expect(commandAllowed('node guard.js --strict', allow)).toBe(true)
  expect(commandAllowed('NODE guard.js', allow)).toBe(true)
  expect(commandAllowed('C:/tools/node guard.js', 'C:/tools/node')).toBe(true)
  expect(commandAllowed('nodejs-evil --x', allow)).toBe(false)
  expect(commandAllowed('echo hi', 'node *')).toBe(false)
})
