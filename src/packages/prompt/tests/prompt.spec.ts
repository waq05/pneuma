/**
 * @pneuma/prompt 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：提示词分段注册要整套内核才立得住，这里只钉清单、包形态、入口对象，以及同包的纯函数 pruneToolResults（确定性、只切中间、最近几条不动）。
 * 导入面是源码入口（`../index.js`、`../tool-result-prune.js`），不是 `lib/` 产物。
 * @module @pneuma/prompt/tests
 */
import { readFileSync } from 'node:fs'
import type { ChatMessage } from '@pneuma/runtime/core/llm.js'
import { expect, test } from 'vitest'
import { promptPlugin } from '../index.js'
import { DEFAULT_TOOL_RESULT_PRUNE, pruneToolResults } from '../tool-result-prune.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))

/** 取一条消息的文本正文；这个包的修剪只动纯文本，非字符串说明夹具写错了。 */
function textOf(message: ChatMessage): string {
  if (typeof message.content !== 'string') throw new Error('夹具里的消息正文必须是字符串')
  return message.content
}

test('清单与装配行：cordis.patch.yml 的 id 与包名对得上', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toContain('id: prompt')
  expect(patch).toContain("name: '@pneuma/prompt'")
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
  expect(typeof promptPlugin.name).toBe('string')
  expect([pkg.name.split('/').at(-1), 'prompt']).toContain(promptPlugin.name)
  expect(typeof promptPlugin.apply).toBe('function')
})

test('README：模型体验与已知限制两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

test('修剪：超长工具结果只切中间，两头与省掉的字数都在', () => {
  // 口径是与 dsh 的 pruner 对齐的硬数字（8K 阈值 / 4K 头 / 1K 尾 / 最近留 4 条）。
  // 不写死这组数，下面「用常量构造夹具再拿常量比对」就成了自证。
  expect(DEFAULT_TOOL_RESULT_PRUNE).toEqual({ thresholdChars: 8192, headChars: 4096, tailChars: 1024, keepRecent: 4 })
  const long = 'x'.repeat(DEFAULT_TOOL_RESULT_PRUNE.thresholdChars + 500)
  const recent = Array.from({ length: DEFAULT_TOOL_RESULT_PRUNE.keepRecent }, () => ({ role: 'tool' as const, content: '最近的结果' }))
  const messages = [{ role: 'tool' as const, content: long }, ...recent]
  const pruned = pruneToolResults(messages)
  expect(pruned).not.toBe(messages)
  const text = textOf(pruned[0]!)
  expect(text.length).toBeLessThan(long.length)
  expect(text).toMatch(/省掉了 \d+ 个字符/)
  expect(text.startsWith('x'.repeat(DEFAULT_TOOL_RESULT_PRUNE.headChars))).toBe(true)
  expect(text.endsWith('x'.repeat(DEFAULT_TOOL_RESULT_PRUNE.tailChars))).toBe(true)
  expect(pruned[1]).toBe(messages[1])
})

test('修剪：不用切或预算不自洽时原样返回同一份数组', () => {
  const short = [{ role: 'tool' as const, content: '短结果' }]
  expect(pruneToolResults(short)).toBe(short)
  const oversized = [{ role: 'tool' as const, content: 'x'.repeat(10_000) }]
  const badBudget = { thresholdChars: 100, headChars: 60, tailChars: 60, keepRecent: 1 }
  expect(pruneToolResults(oversized, badBudget)).toBe(oversized)
})
