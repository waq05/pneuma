/**
 * 会话区节点级槽位的契约常量（迁自 `scripts/ui-node-slot-test.mjs` 中唯一有导出接缝
 * 的两条，按手册 §2 方案 A「断言导出对象」改写）。
 *
 * 原探针自己写明了性质：**本批只做源码钉**——`@dsc/ui` 的槽契约是 `declare module`
 * 的编译期合并，运行期没有对应物，import 进来也验不到那条链。所以三处子槽常量里
 * 只有 `shared.ts` 导出的两个字符串常量能行为化断言（注册、声明、渲染三处同源的
 * 「源」就是它们）；其余各段——SlotMap 的 chain 声明、`TranscriptChildSlot` 三槽
 * 联合、`renderSlot` 第三参 fallback、RowBody 两层分工、两处装配登记、ThinkText 的
 * Markdown 渲染——全是编译期类型与渲染体文本，没有运行期接缝，**保留断言原样
 * 不迁**，整条记进交付报告的缺口清单（主线统一登记 backlog）。
 *
 * @module dsc-ui-transcript/ui/node-slots.spec
 */
import { describe, expect, test } from 'vitest'
import { TRANSCRIPT_NODE_SLOT, TRANSCRIPT_REASONING_BODY_SLOT } from './shared.js'

describe('节点级子槽的契约常量（注册 / 声明 / 渲染三处同源的「源」）', () => {
  test('节点槽的名字是 transcript.node', () => {
    expect(TRANSCRIPT_NODE_SLOT).toBe('transcript.node')
  })

  test('思考正文槽的名字是 transcript.reasoning.body', () => {
    expect(TRANSCRIPT_REASONING_BODY_SLOT).toBe('transcript.reasoning.body')
  })

  test('两个槽名互不相同、都带 transcript 前缀（不会被别的域借走）', () => {
    expect(TRANSCRIPT_NODE_SLOT).not.toBe(TRANSCRIPT_REASONING_BODY_SLOT)
    expect(TRANSCRIPT_NODE_SLOT.startsWith('transcript.')).toBe(true)
    expect(TRANSCRIPT_REASONING_BODY_SLOT.startsWith('transcript.')).toBe(true)
  })
})
