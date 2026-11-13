/**
 * 请求分段里「工具调用参数算哪一段」的那一条（`scripts/batch3-test.mjs` 的残留断言）。
 *
 * `token-estimate.spec.ts` 已经钉了五段各归各位、空请求全零、schema 段与 tools 段分开；
 * 但**「纯 tool_calls 的消息，其参数算进 assistant、tools 段必须是 0」**这一条没有独立
 * 断言——现有那条只断言 `assistant` 的数值，若实现把参数同时记进 tools 段，它照样绿。
 * 段名容易误解（`tools` 是模型读到的工具**返回原文**，工具定义在 `schema`，参数是模型
 * 自己产出的文本），所以单独留一条。
 *
 * 为什么是独立文件：`token-estimate.spec.ts` 是既有文件，本批的可写白名单只允许新建
 * spec；把这条塞进别人的文件会踩边界。
 *
 * @module dsc/core/token-estimate-request.spec
 */
import { expect, test } from 'vitest'
import { estimateRequestSegments } from './token-estimate.js'

test('纯 tool_calls 消息：参数算进 assistant 段，tools 段为 0', () => {
  const segments = estimateRequestSegments([
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read', arguments: 'abcdefgh' } }] },
  ])
  // 参数是模型产出的文本，占输入 token；归错段会让界面把「模型说的话」显示成「工具返回太肥」。
  expect(segments.assistant).toBeGreaterThan(0)
  expect(segments.tools).toBe(0)
})
