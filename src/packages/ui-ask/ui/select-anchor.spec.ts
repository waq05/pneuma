/**
 * 选区浮钮定位的「实测尺寸」分支（迁自 `scripts/ui-ask-selection-slot-test.mjs`
 * 第 [6] 段的可行为化部分）。
 *
 * 原探针的口径：`ask.selection.action` 是一条 list 槽，动作颗数由插件决定——夹取
 * 必须用「浮层量出来的宽度」（`getBoundingClientRect`），92px 那个常量只剩首帧兜底，
 * 不再是唯一依据（多颗动作时整排才不会被 `.app` 的 overflow-x: clip 裁掉）。
 * `anchorOf` 的第三参 `measured` 就是这条语义的接缝，纯函数真跑可验。
 *
 * 没迁的（原探针第 [1]–[5] 段与其余第 [6] 段，见交付报告缺口清单）：槽声明
 * （`declare module` 编译期）、`shell.header` 登记与内置动作挂链、`SelectionBubble`
 * 的 renderSlot 接线、样式定位、注释留档、`measure` 回调读 rect——全是渲染层
 * 接缝或源码文本，归组件渲染批。`anchorOf` 的默认行为（两参调用）已由
 * `side-ask.spec.ts` 覆盖，不重复。
 *
 * @module dsc-ui-ask/ui/select-anchor.spec
 */
import { describe, expect, test } from 'vitest'
import { ANCHOR_GAP, BUBBLE_H, BUBBLE_W, anchorOf } from './select.js'

const VIEW = { width: 1280, height: 800 }

describe('anchorOf：夹取跟着实测宽度走（不再拿 92 当唯一依据）', () => {
  test('宽浮层（多颗动作）贴右缘时按实测宽度收回，不是按 92px', () => {
    const box = { left: 1100, top: 100, right: 1279, bottom: 120 }
    const measured = { width: 260, height: BUBBLE_H }
    const wide = anchorOf(box, VIEW, measured)
    // maxLeft = 视口宽 - 实测宽 - ANCHOR_GAP；rightAligned = 1279 - 260。
    expect(wide.left).toBe(VIEW.width - measured.width - ANCHOR_GAP)
    // 同一选区用兜底宽夹取会给出不同的左界——证明宽度真的是实测值在起作用。
    const fallback = anchorOf(box, VIEW)
    expect(fallback.left).not.toBe(wide.left)
  })

  test('实测宽度超过视口时夹回左安全区（整排再宽也不出视口）', () => {
    const box = { left: 1000, top: 100, right: 1279, bottom: 120 }
    const huge = anchorOf(box, VIEW, { width: 3000, height: BUBBLE_H })
    expect(huge.left).toBe(ANCHOR_GAP)
  })

  test('实测高度放不下下方时翻到选区上方（下方判定也跟着实测走）', () => {
    const box = { left: 100, top: 600, right: 300, bottom: 790 }
    const tall = anchorOf(box, VIEW, { width: BUBBLE_W, height: 200 })
    // below = 790 + GAP = 798；798 + 200 > 800 - GAP → 翻上方。
    expect(tall.top).toBe(box.top - 200 - ANCHOR_GAP)
  })

  test('首帧兜底：不传实测尺寸时行为与 92×30 那套一致（不会更宽）', () => {
    const box = { left: 200, top: 100, right: 300, bottom: 120 }
    const defaulted = anchorOf(box, VIEW)
    expect(defaulted.left).toBe(box.right - BUBBLE_W)
    expect(defaulted.top).toBe(box.bottom + ANCHOR_GAP)
  })
})
