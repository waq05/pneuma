/**
 * image-diet 包级测试：设置分区的身份、四个控件与默认值。
 *
 * 迁移说明：原来「标题走 `t('section.title')`」是按 `index.ts` 源码正则断言的，现改成
 * 真跑 `apply()` 拿到设置分区对象，再把 `title` 与 `locale/ui.zh.json` 里那个键的值比对：
 * 键名写歪（或字典缺这条）会红，换语言、改文案不会红。其余三条本来就是运行时值，原样保留。
 *
 * 环境隔离：`resolvePluginConfig` 读 `DSC_HOME` 下的 `plugins.json`，所以先把 `DSC_HOME`
 * 指到 `mkdtempSync` 的临时目录，再动态 import 插件；真实 `~/.dsc` 一个字节都不碰。
 *
 * @module @pneuma/image-diet/tests
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsField } from '@pneuma/runtime/contract.js'
import type { SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { afterAll, expect, test } from 'vitest'

/** 本包的界面文案字典。 */
const zh = JSON.parse(readFileSync(new URL('../locale/ui.zh.json', import.meta.url), 'utf8')) as Record<string, string>

const home = mkdtempSync(join(tmpdir(), 'dsc-image-diet-spec-'))
process.env.DSC_HOME = home

/** 假 ctx 捕获到的那一份设置分区（apply 里同步赋值，断言时一定在）。 */
let section!: SettingsSectionSpec
const { imageDietPlugin } = await import('../index.js')
const core = await import('@pneuma/runtime/core/image-diet.js')

imageDietPlugin.apply({
  settings: {
    registerSection: (spec: SettingsSectionSpec) => {
      section = spec
      return () => {}
    },
  },
  effect: (execute: () => unknown) => {
    const off = execute()
    return typeof off === 'function' ? off : () => {}
  },
} as never, {} as never)

afterAll(() => {
  delete process.env.DSC_HOME
  rmSync(home, { recursive: true, force: true })
})

// 分区身份：id、标题取词键、order 三项一起钉，界面按 id 找分区、按 order 排位置。
test('分区身份：id image-diet、标题走 t(\'section.title\')、order 38', () => {
  expect(section.id).toBe('image-diet')
  // 标题文案的原文在 locale/ui.zh.json：这里钉「真的用上了这个键」——
  // 字典里没有这条键时 hostT 会退回键名本身，所以两边必须一致且字典里有值。
  expect(Object.hasOwn(zh, 'section.title')).toBe(true)
  expect(section.title).toBe(zh['section.title'])
  expect(typeof section.subtitle).toBe('string')
  expect(section.order).toBe(38)
})

test('四个控件：总开关 + 三个数字预算', () => {
  const fields = section.fields()
  const keyOf = (field: SettingsField): string | undefined => ('key' in field ? field.key : undefined)
  expect(fields.map(keyOf)).toEqual(['enabled', 'userImageBudget', 'toolImageBudget', 'keepRounds'])
  expect(fields.map((field) => field.type)).toEqual(['switch', 'number', 'number', 'number'])
})

test('数字控件的上下界与 IMAGE_DIET_RANGES 一致', () => {
  const fields = section.fields()
  const numeric = fields.filter((field) => field.type === 'number')
  for (const field of numeric) {
    const range = core.IMAGE_DIET_RANGES[field.key as keyof typeof core.IMAGE_DIET_RANGES]
    expect(field.min).toBe(range.min)
    expect(field.max).toBe(range.max)
  }
})

test('默认值：开着，用户图 4 张、工具图 2 张、保留 2 回合；越界值夹回区间', () => {
  expect({ ...core.readImageDietConfig({}) }).toEqual({
    enabled: true,
    userImageBudget: 4,
    toolImageBudget: 2,
    keepRounds: 2,
  })
  expect(core.readImageDietConfig({ keepRounds: 999 }).keepRounds).toBe(50)
  expect(core.readImageDietConfig({ userImageBudget: -3 }).userImageBudget).toBe(0)
})
