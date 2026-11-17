/**
 * @pneuma/microcompact 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：这个包只改请求体、不动会话日志，清谁不清谁是纯函数，钉住它才能保证旧结果被清而新结果与输入不被误伤。
 *
 * 迁移说明：原文件从 `lib/packages/microcompact/*.js` 取模块，现在直接 import 源码入口与 `microcompact.ts`。
 *
 * @module @pneuma/microcompact/tests
 */
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { microcompactPlugin } from '../index.js'
import {
  CLEARED_TOOL_RESULT_PREFIX,
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_MIN_SAVE_TOKENS,
  microcompact,
  planMicrocompact,
} from '../microcompact.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 消息正文的文本视图（这条用例里只放字符串正文）。 */
const textOf = (message: ChatMessage | undefined): string =>
  message !== undefined && typeof message.content === 'string' ? message.content : ''

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/microcompact', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: microcompact\s*$/m)
  expect(patch).toContain("name: '@pneuma/microcompact'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  const pkg = JSON.parse(read('../package.json')) as {
    name: string
    type: string
    exports: Record<string, { default?: string }>
    pneuma: { bundle: { patch: string }; library?: boolean }
  }
  expect(pkg.name).toBe('@pneuma/microcompact')
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.']?.default).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  expect(pkg.pneuma.bundle.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma.library).not.toBe(true)
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof microcompactPlugin).toBe('object')
  expect(typeof microcompactPlugin.name).toBe('string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  expect(microcompactPlugin.name).toBe('microcompact')
  expect(typeof microcompactPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

test('只清旧的工具结果，最近几条原样留着，输入不被就地改', () => {
  const long = 'x'.repeat(4000)
  const messages: ChatMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: 'c1', content: long },
    { role: 'tool', tool_call_id: 'c2', content: long },
  ]
  const out = microcompact(messages, { keepRecent: 1 })
  // 旧的该被换成新对象
  expect(out[1]).not.toBe(messages[1])
  expect(textOf(out[1]).startsWith(CLEARED_TOOL_RESULT_PREFIX)).toBe(true)
  // 最近一条要原样保留
  expect(out[2]).toBe(messages[2])
  // 输入数组不能被就地改
  expect(textOf(messages[1])).toBe(long)
})

test('清理计划按 callId 给出占位符，缺省阈值是常量', () => {
  const messages: ChatMessage[] = [{ role: 'tool', tool_call_id: 'c9', content: 'y'.repeat(4000) }]
  const plan = planMicrocompact(messages, { keepRecent: 0 })
  expect([...plan.keys()]).toEqual(['c9'])
  expect(DEFAULT_KEEP_RECENT_TOOL_RESULTS).toBe(5)
  expect(DEFAULT_MIN_SAVE_TOKENS).toBe(256)
})
