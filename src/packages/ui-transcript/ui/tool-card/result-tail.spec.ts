/**
 * 收起态工具结果尾巴的读数（ui 层）。
 *
 * 来源：`scripts/ui-transcript-render-test.mjs` 第 [8] 段的纯逻辑部分（对照 codex 的
 * 活动流：工具卡收起时不再摊结果行，只数「点开还能看到几行」）。2026-10-27 用户报
 * 「工具调用在折叠状态时占用面积太大，只占一行就行」，三行预览让每张卡从一行变四行。
 *
 * `factory.tsx` 里「收起态不再渲染结果尾巴 / 展开态不重复摊 / 头行写截断数」的接线断言
 * 不迁（渲染体文本，归组件渲染批）。
 *
 * @module dsc-ui-transcript/ui/tool-card/result-tail.spec
 */
import { expect, test } from 'vitest'
import { RESULT_TAIL_LINES, resultTail } from './result-tail.js'

test('收起态一行都不摊（常量钉在 0）', () => {
  const tail = resultTail(['1', '2', '3', '4', '5', '6'].join('\n'))
  expect(RESULT_TAIL_LINES).toBe(0)
  expect(tail?.lines).toHaveLength(0)
})

test('隐藏行数 = 全部非空行', () => {
  expect(resultTail('1\n2\n3\n4\n5\n6')?.hidden).toBe(6)
})

test('末尾空行不算进读数', () => {
  expect(resultTail('a\nb\n\n\n')?.hidden).toBe(2)
})

test('中间的空白行不算进读数（只数真内容）', () => {
  expect(resultTail('a\n\n\nb\n\nc')?.hidden).toBe(3)
})

test('结果为空 / 没回来时连读数都不给', () => {
  expect(resultTail('')).toBeNull()
  expect(resultTail('   \n')).toBeNull()
  expect(resultTail(undefined)).toBeNull()
})

test('单行结果也只留读数（仍不摊预览）', () => {
  const tail = resultTail('只有一行')
  expect(tail?.hidden).toBe(1)
  expect(tail?.lines).toHaveLength(0)
})
