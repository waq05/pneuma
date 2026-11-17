/**
 * @pneuma/presets 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：模式文件与投影逻辑都在 runtime core，这个包只负责登记服务与切换命令，能便宜测的是清单、包形态、入口对象与声明面。
 * 导入面是源码入口（`../index.js`），不是 `lib/` 产物。
 * @module @pneuma/presets/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { presetsPlugin } from '../index.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toContain('id: presets')
  expect(patch).toContain("name: '@pneuma/presets'")
})

test('包形态：ESM、两个导出子路径、patch 声明自洽', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.'].default).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  if (pkg.pneuma?.library === true) {
    expect(pkg.pneuma?.bundle).toBeUndefined()
  } else {
    expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
  }
})

test('入口：插件对象有名字与 apply', () => {
  expect(typeof presetsPlugin.name).toBe('string')
  expect([pkg.name.split('/').at(-1), 'presets']).toContain(presetsPlugin.name)
  expect(typeof presetsPlugin.apply).toBe('function')
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

test('服务名：provide 是 presets，装配依赖含 prompt/tools/approval/mode', () => {
  expect(presetsPlugin.provide).toBe('presets')
  for (const dep of ['prompt', 'tools', 'approval', 'mode', 'surfaces', 'settings']) {
    expect(presetsPlugin.inject).toContain(dep)
  }
})

test('字典：出厂四个模式的标签与描述，中英各一份，英文里没有汉字', () => {
  const zh = JSON.parse(read('../locale/ui.zh.json'))
  const en = JSON.parse(read('../locale/ui.en.json'))
  for (const name of ['standard', 'minimal', 'maker', 'ptc']) {
    for (const field of ['label', 'description']) {
      const key = 'builtin.' + name + '.' + field
      expect(typeof zh[key], key + ' 中文缺').toBe('string')
      expect(typeof en[key], key + ' 英文缺').toBe('string')
      expect(/[\u4e00-\u9fff]/.test(en[key]), key + ' 英文里还有汉字').toBe(false)
    }
  }
})
