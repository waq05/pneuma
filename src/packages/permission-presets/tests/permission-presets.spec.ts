/**
 * @pneuma/permission-presets 的包级测试：钉 7 条不变量。
 * 为什么只钉这些：这个包的契约就是「provide 一个服务、只调审批与沙箱已有的 setter」，
 * 能便宜测的是清单、包形态、入口对象与它声明的依赖面；出厂四档的字典键必须与
 * permission-core 那张表一一对上，否则设置页会缺字或显示原始 key。
 * @module @pneuma/permission-presets/tests
 */
import { readFileSync } from 'node:fs'
import { BUILTIN_PERMISSION_PRESETS } from '@pneuma/permission-core/permission-presets.js'
import { expect, test } from 'vitest'
import { permissionPresetsPlugin } from '../index.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json')) as {
  name: string
  type: string
  exports: Record<string, { default?: string } | string>
  pneuma?: { bundle?: { patch?: string }; library?: boolean }
}

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: permission-presets\s*$/m)
  expect(patch).toContain("name: '@pneuma/permission-presets'")
})

test('包形态：ESM、两个导出子路径、patch 声明自洽', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.']).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  if (pkg.pneuma?.library === true) {
    expect(pkg.pneuma.bundle).toBeUndefined()
  } else {
    expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
  }
})

test('入口：插件对象有名字与 apply，名字与包名去前缀后一致', () => {
  expect(typeof permissionPresetsPlugin.name).toBe('string')
  expect(permissionPresetsPlugin.name).toBe(pkg.name.split('/').at(-1))
  expect(permissionPresetsPlugin.name).toBe('permission-presets')
  expect(typeof permissionPresetsPlugin.apply).toBe('function')
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

test('服务名：provide 是 permissionPresets，依赖审批/模式/快照那几个面', () => {
  expect(permissionPresetsPlugin.provide).toBe('permissionPresets')
  // 精确比对：多依赖一个服务意味着装配顺序多一条约束，少一个则 apply 里读不到东西。
  expect([...(permissionPresetsPlugin.inject as string[])]).toEqual([
    'approval',
    'settings',
    'surfaces',
    'mode',
    'session',
    'transcript',
  ])
})

test('字典：出厂四档的标签与描述，中英各一份，英文里没有汉字', () => {
  const zh = JSON.parse(read('../locale/ui.zh.json')) as Record<string, string>
  const en = JSON.parse(read('../locale/ui.en.json')) as Record<string, string>
  for (const name of ['read-only', 'workspace', 'full-access', 'auto-review']) {
    for (const field of ['label', 'description']) {
      const key = `preset.${name}.${field}`
      expect(typeof zh[key], `${key} 中文缺`).toBe('string')
      expect(typeof en[key], `${key} 英文缺`).toBe('string')
      expect(en[key], `${key} 英文里还有汉字`).not.toMatch(/[\u4e00-\u9fff]/)
    }
  }
  // 字典键必须跟着 permission-core 那张表：表里加一档而字典没跟上，设置页会显示原始 key。
  expect(BUILTIN_PERMISSION_PRESETS.map((preset) => preset.name).sort()).toEqual(
    ['read-only', 'workspace', 'full-access', 'auto-review'].sort(),
  )
})

test('中文标签与核心表逐字一致（设置页显示字典、诊断读表，两处不能漂）', () => {
  const zh = JSON.parse(read('../locale/ui.zh.json')) as Record<string, string>
  for (const preset of BUILTIN_PERMISSION_PRESETS) {
    expect(zh[`preset.${preset.name}.label`], `${preset.name} 标签漂了`).toBe(preset.label)
  }
})
