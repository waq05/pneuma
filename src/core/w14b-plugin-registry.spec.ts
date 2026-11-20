/**
 * `core/plugin-registry.ts` 的缺口补齐：旧版 `{ disabled: string[] }` 条目树、patch 行配置的
 * 登记与三档合并、team→subagent 迁移、apiVersion 的两种非法值。
 *
 * `DSC_HOME` 在导入产品模块之前指到临时目录；不碰真实 `~/.dsc`。
 *
 * @module dsc/core/w14b-plugin-registry.spec
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14b-registry-'))
process.env['DSC_HOME'] = HOME
const PLUGINS_FILE = join(HOME, 'plugins.json')

type Registry = typeof import('./plugin-registry.js')
let registry: Registry

beforeAll(async () => {
  registry = await import('./plugin-registry.js')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5 })
})

beforeEach(() => {
  writeFileSync(PLUGINS_FILE, JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

describe('readPluginEntries：旧版 disabled 数组', () => {
  test('没有 entries 段、只有 disabled 数组：每一条都当停用条目，按名字排序', () => {
    writeFileSync(PLUGINS_FILE, JSON.stringify({ disabled: ['b-plugin', 'a-plugin'] }), 'utf8')
    const entries = registry.readPluginEntries()
    expect(entries.map((entry) => entry.file)).toEqual(['a-plugin', 'b-plugin'])
    expect(entries.every((entry) => entry.disabled)).toBe(true)
  })
})

describe('registerRowConfig / resolvePluginConfig：三档合并', () => {
  test('只登记行配置：行配置生效', () => {
    registry.registerRowConfig('row-x', { level: 2 })
    expect(registry.resolvePluginConfig('row-x')).toEqual({ level: 2 })
  })

  test('宿主直给 + 行配置：行配置里与直给同名的键以直给为准', () => {
    registry.registerRowConfig('row-y', { level: 2, extra: 'row' })
    // 直给那份是装配时的权威值：同一键以直给为准；行配置独有的键不会被补进来。
    expect(registry.resolvePluginConfig('row-y', { level: 9 })).toEqual({ level: 9 })
    registry.registerRowConfig('row-y', undefined)
    expect(registry.resolvePluginConfig('row-y')).toEqual({})
  })
})

describe('migrateTeamMerge：team 开着就点亮 subagent', () => {
  test('team 显式启用、subagent 缺失：写一条 subagent 启用的条目；再跑一次不再写盘', () => {
    writeFileSync(PLUGINS_FILE, JSON.stringify({ version: 1, entries: [{ file: 'team', disabled: false, config: {} }] }), 'utf8')
    registry.migrateTeamMerge()
    const after = registry.readPluginEntries()
    expect(after.find((entry) => entry.file === 'subagent')?.disabled).toBe(false)
    // team 条目原样留着（回滚到旧版本时那份开关还在）。
    expect(after.find((entry) => entry.file === 'team')?.disabled).toBe(false)

    const before = readFileSync(PLUGINS_FILE, 'utf8')
    registry.migrateTeamMerge()
    expect(readFileSync(PLUGINS_FILE, 'utf8')).toBe(before)
  })
})

describe('checkApiVersion：两种非法值', () => {
  test('非整数与小于 1 各有各的文案', () => {
    expect(registry.checkApiVersion(1.5)).toContain('应为整数')
    expect(registry.checkApiVersion(0)).toContain('必须为正整数')
  })
})
