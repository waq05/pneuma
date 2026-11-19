/**
 * settings 包级测试：插件对象 + 八个内置分区的 id/order/字段。
 *
 * 原来这五条里有三条读 `index.ts` 源码正则（注册循环那一行、`order: N`、`key: 'x'`）。
 * 现在改成真的调一遍 `apply()`，从 `settings` 服务的 `sections()` 拿注册结果再断言——
 * 分区顺序、order、通用分区字段顺序、custom 标记与「关于」分区的检查更新动作，
 * 全是运行时真实值；改引号/换行不会红，删掉一个分区或调错 order 会红。
 *
 * 环境隔离：`path-policy` 在模块加载时读 `DSC_HOME`，所以先把它指到 `mkdtempSync` 的
 * 临时目录再 import 插件；apply 期间的偏好写盘只会落在这个临时目录里。
 *
 * @module @pneuma/settings/tests
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DscCoreConfig } from '@pneuma/runtime/core/config.js'
import type { SettingsSectionView, SettingsService } from '@pneuma/runtime/services/types.js'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-settings-spec-'))
let service: SettingsService
let settingsPlugin: typeof import('../index.js')['settingsPlugin']

beforeAll(async () => {
  process.env.DSC_HOME = home
  // 先自己 import 一次路径策略：确认 DSC_HOME 真的指到临时目录，再 import 插件并跑 apply，
  // 否则 apply 里的偏好写盘会落到真实的 ~/.dsc。插件本身也必须动态 import——静态 import
  // 会在本文件的模块加载阶段就把 path-policy 一起拉起来，那时 DSC_HOME 还没设。
  const policy = await import('@pneuma/runtime/core/path-policy.js')
  expect(policy.DSC_HOME).toBe(home)
  ;({ settingsPlugin } = await import('../index.js'))
  const fakeCtx = {
    get: () => undefined,
    transcript: { touch: () => {}, system: () => {} },
    llm: {
      provider: 'deepseek',
      model: 'chat',
      effort: 'default',
      setEffort: () => {},
      setModel: () => {},
      routeTo: () => ({}),
      stream: () => {},
    },
    approval: { reviewer: 'user', setPolicy: () => {}, setReviewer: () => {} },
    provide: (_name: string, value: SettingsService) => {
      service = value
    },
  }
  // 假 ctx 只实现 apply 用到的成员；配置对象只在 reloadLive 里被读，这里不会走到。
  ;(settingsPlugin.apply as (ctx: unknown, config: DscCoreConfig) => void)(fakeCtx, {} as DscCoreConfig)
})

afterAll(() => {
  delete process.env.DSC_HOME
  rmSync(home, { recursive: true, force: true })
})

/** 按 id 取分区（sections() 已按 order 排好，这里只做定位）。 */
function sectionOf(id: string): SettingsSectionView {
  const found = service.sections().find((section) => section.id === id)
  expect(found, `没有名为 ${id} 的分区`).toBeDefined()
  return found as SettingsSectionView
}

test('插件对象：名字、提供服务、三个注入', () => {
  expect(settingsPlugin.name).toBe('settings')
  expect(settingsPlugin.provide).toBe('settings')
  expect(settingsPlugin.inject).toEqual(['llm', 'approval', 'transcript'])
  expect(typeof settingsPlugin.apply).toBe('function')
})

test('八个内置分区按固定顺序注册', () => {
  expect(service.sections().map((section) => section.id)).toEqual([
    'general',
    'models',
    'presets',
    'skills',
    'usage',
    'archive',
    'tui',
    'about',
  ])
})

test('分区 id 与 order 对得上（通用 0 到关于 900）', () => {
  const orders = Object.fromEntries(service.sections().map((section) => [section.id, section.order]))
  expect(orders).toEqual({ general: 0, models: 10, presets: 15, skills: 20, usage: 25, archive: 30, tui: 35, about: 900 })
})

test('通用分区的四个字段按顺序：预设、思考、温度、托盘', () => {
  const keys = sectionOf('general')
    .fields.flatMap((field) => ('key' in field ? [field.key] : []))
  expect(keys).toEqual(['permissionPreset', 'effort', 'temperature', 'closeToTray'])
})

test('五个分区由桌面端自画（custom），关于分区有检查更新', async () => {
  expect(service.sections().filter((section) => section.custom).map((section) => section.id)).toEqual([
    'models',
    'presets',
    'skills',
    'usage',
    'archive',
  ])
  expect(sectionOf('about').fields.some((field) => 'key' in field && field.key === 'updateCheck')).toBe(true)
  // 「检查更新」这个动作名真的接在 check-update 上：拦住全局 fetch，能走到更新源查询并
  // 把失败原因原样回执，说明服务按名字找到了这个动作（写错名字会回「没有动作 x」）。
  const fetchStub = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('测试不联网'))
  try {
    const result = await service.action('about', 'check-update')
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error : '').toContain('测试不联网')
  } finally {
    fetchStub.mockRestore()
  }
})
