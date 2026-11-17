/**
 * 「工具名是 null」时参数表的判法（ui 层）。
 *
 * 来源：`scripts/ui-tool-name-null-test.mjs` 第 [3] 段的 `toolArgFields` 部分（2026-10-30
 * 白屏事故的渲染纯函数层：名字不是字符串时绝不抛异常）。
 *
 * 本目录的 `tool-args.spec.ts` 钉正常名字的分流；这里只补事故暴露的那条边界——
 * 名字是 null / 空串（老日志、网关坏流）也要给出「不改文件」的稳答案。
 *
 * @module dsc-ui-primitives/ui/tool-args-null.spec
 */
import { expect, test } from 'vitest'
import { toolArgFields } from './tool-args.js'

test('toolArgFields(null) 不抛，判成不改文件', () => {
  expect(() => toolArgFields(null, '{}')).not.toThrow()
  expect(toolArgFields(null, '{}').mutating).toBe(false)
})

test('toolArgFields(空串) 不抛，判成不改文件', () => {
  expect(() => toolArgFields('', '{}')).not.toThrow()
  expect(toolArgFields('', '{}').mutating).toBe(false)
})

test('write 照旧判成改文件（正常路径没被事故修法带坏）', () => {
  expect(toolArgFields('write', '{"path":"a","content":"b"}').mutating).toBe(true)
})
