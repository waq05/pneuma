/**
 * 老会话日志回放时工具名的修复（unit 层）。
 *
 * 来源：`scripts/ui-tool-name-null-test.mjs` 第 [2] 段（2026-10-30 白屏事故的回放层）。
 *
 * 事故链条的中间一环：坏流把 `name: null` 写进了会话日志。合并层修好后，新日志不会再出现
 * null，但**老日志每次重开这个会话都会再崩一次**——所以 `Transcript.replayHistory` 读到
 * 非字符串的名字 / callId 要就地修成空串，否则渲染层的 `.toLowerCase()` 照样炸。
 *
 * @module dsc/adapter/transcript-replay.spec
 */
import { expect, test } from 'vitest'
import { Transcript } from './transcript.js'

test('老日志里的 null 工具名 / null callId 读回来修成空串（不抛、参数原文保留）', () => {
  const transcript = new Transcript()
  // 事故老日志里真存着 null（类型声明的 `string` 是修好之后的口径）：
  // 这里按 2026-10-30 现场的原样喂进去，正是要验「声明之外的脏数据也能安全回放」。
  const legacyMessages = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: null, type: 'function', function: { name: null, arguments: '{"code":"x"}' } }],
    },
    { role: 'tool', content: '未知工具：null', tool_call_id: null },
  ] as unknown as Parameters<Transcript['replayHistory']>[0]
  transcript.replayHistory(legacyMessages)
  const tool = transcript.entries.find((entry) => entry.kind === 'tool')
  expect(tool).toBeDefined()
  expect(tool?.kind === 'tool' && tool.call.name).toBe('')
  expect(tool?.kind === 'tool' && tool.call.callId).toBe('')
  expect(tool?.kind === 'tool' && tool.call.argsText).toBe('{"code":"x"}')
})

test('正常的老日志照旧回放（修复不伤好数据）', () => {
  const transcript = new Transcript()
  transcript.replayHistory([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
    },
    { role: 'tool', content: '文件内容', tool_call_id: 'call_9' },
  ])
  const tool = transcript.entries.find((entry) => entry.kind === 'tool')
  expect(tool?.kind === 'tool' && tool.call.name).toBe('read')
  expect(tool?.kind === 'tool' && tool.call.callId).toBe('call_9')
  expect(tool?.kind === 'tool' && tool.call.argsText).toBe('{"path":"a"}')
})
