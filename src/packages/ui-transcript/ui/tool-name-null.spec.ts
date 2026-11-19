/**
 * 「工具名不是字符串」时的阶段归档与实时详情（ui 层）。
 *
 * 来源：`scripts/ui-tool-name-null-test.mjs` 第 [3] 段的 `process-groups` 部分（2026-10-30
 * 白屏事故的渲染纯函数层）。事故的最后一环：日志里的 `name: null` 一路到达
 * `activityOf()`，对 null 调 `.toLowerCase()` 抛错 → 整个消息流条目崩掉、对话页白屏。
 * 修法：名字不是字符串时归「通用工具」这一档，绝不抛异常。
 *
 * 不迁的部分（原探针）：第 [1] 段（合并层，落 `src/core/llm-tool-delta.spec.ts`）、
 * 第 [2] 段（回放层，落 `src/adapter/transcript-replay.spec.ts`）、第 [3] 段的
 * `toolArgFields`（落 `src/packages/ui-primitives/ui/tool-args-null.spec.ts`）、
 * 第 [4] 段源码形态钉（行为断言已覆盖，见各 spec 抬头）。
 *
 * @module dsc-ui-transcript/ui/tool-name-null.spec
 */
import { expect, test } from 'vitest'
import { activityOf, liveToolDetail } from './process-groups.js'

test('activityOf(null / undefined / 空串) 归「通用工具」，不抛', () => {
  expect(activityOf(null)).toBe('tools')
  expect(activityOf(undefined)).toBe('tools')
  expect(activityOf('')).toBe('tools')
})

test('正常名字照旧归一（修复不伤好数据）', () => {
  expect(activityOf('Bash')).toBe('commands')
  expect(activityOf('read')).toBe('read')
})

test('liveToolDetail 对空名字不抛', () => {
  expect(() => liveToolDetail('', '{"path":"a"}')).not.toThrow()
})
