/**
 * @pneuma/self-improve 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：入口导出的插件对象、唯一一个纯函数 parseDraftAnswer，加上清单、装配行与文档，
 * 是不碰会话、模型与 ~/.dsc 就能便宜钉住的全集。
 *
 * 迁移说明：原文件从 `lib/packages/self-improve/*.js` 取模块，现在直接 import 源码入口
 * `../index.js`——改一行源码不构建也看得见。断言内容不变，只换断言库。
 * 顺带修一处文档与实际不符：原文件头写「钉 7 条不变量」，实际只有 6 条用例。
 *
 * @module @pneuma/self-improve/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { parseDraftAnswer, selfImprovePlugin } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包的清单。 */
const pkg = JSON.parse(read('../package.json')) as {
  name: string
  type: string
  exports: Record<string, { default?: string }>
  pneuma: { bundle?: { patch: string }; library?: boolean }
}

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/self-improve', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: self-improve\s*$/m)
  expect(patch).toContain("name: '@pneuma/self-improve'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml（库包则相反）。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.']?.default).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  if (pkg.pneuma.library === true) {
    expect(pkg.pneuma.bundle).toBeUndefined()
  } else {
    expect(pkg.pneuma.bundle?.patch).toBe('./cordis.patch.yml')
  }
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof selfImprovePlugin).toBe('object')
  expect(typeof selfImprovePlugin.name).toBe('string')
  expect(selfImprovePlugin.name).toBe(pkg.name.split('/').pop())
  expect(selfImprovePlugin.name).toBe('self-improve')
  expect(typeof selfImprovePlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

// 纯函数：模型只该回一行 JSON；规整写法与套代码块两种都要认。
test('parseDraftAnswer：认出规整 JSON 与代码块里的 JSON', () => {
  const line = '{"name":"git-flow","description":"整理提交","whenToUse":"提交前","content":"# 步骤"}'
  const direct = parseDraftAnswer(line)
  expect(direct.kind).toBe('draft')
  expect(direct.kind === 'draft' ? direct.draft.name : '').toBe('git-flow')
  expect(direct.kind === 'draft' ? direct.draft.whenToUse : '').toBe('提交前')
  const fenced = parseDraftAnswer('```json\n' + line + '\n```')
  expect(fenced.kind).toBe('draft')
  expect(fenced.kind === 'draft' ? fenced.draft.content : '').toBe('# 步骤')
})

// 纯函数：NONE 是「这轮不值得沉淀」的正常回答，不该被当成解析失败。
test('parseDraftAnswer：NONE 与认不出的一行各有明确结果', () => {
  expect(parseDraftAnswer('NONE')).toEqual({ kind: 'none' })
  const bad = parseDraftAnswer('{}')
  expect(bad.kind).toBe('invalid')
  expect(bad.kind === 'invalid' ? typeof bad.error : 'not-string').toBe('string')
})
