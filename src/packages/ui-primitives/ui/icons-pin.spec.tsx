/**
 * 置顶图钉（`icons.tsx` 的 `IconPin`）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-pin-icon-test.mjs` 第 [2]（缺口清单 B36「ui-pin-icon 整条」）里
 * 有运行期接缝的那半——「钉身能填实（`filled`），已置顶那枚靠形状区分，不只靠颜色」。
 * 原探针钉的是 `fill={filled ? 'currentColor' : 'none'}` 那行源码文本；这里把同一件事
 * 行为化：真把组件画出来，`filled` 一翻，钉身那条 path 的填充跟着翻。
 *
 * 不迁的（原探针第 [1][3][4][5] 段，见交付报告缺口清单）：
 *   - [1] 的三段 path 数据（`M9 3h6` 等）是 SVG 几何，渲染层没有比「数 path 字符串」
 *     更有信息量的断言——不硬迁；
 *   - [3] 会话行把 `filled={pinned}` 传下去、[4][5] 的置顶黄与平时隐形，落在
 *     `ui-sessions` 的行组件与 `views.css` 样式表——前者不在本批可写白名单，
 *     后者 jsdom 不应用样式表，都没有渲染接缝。
 *
 * @module dsc-ui-primitives/ui/icons-pin.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { IconPin } from './icons.js'

afterEach(cleanup)

/** 钉身那条 path：顶帽与针都是描边，只有钉身带 fill 属性。 */
const bodyPath = (container: HTMLElement): SVGPathElement | null =>
  container.querySelector('svg path[fill]')

describe('IconPin 的钉身填充（ui-pin-icon [2] 行为化）', () => {
  test('filled：钉身填实（currentColor），形状区分不靠颜色', () => {
    const { container } = render(<IconPin size={14} filled />)
    const body = bodyPath(container)
    expect(body).toBeTruthy()
    expect(body?.getAttribute('fill')).toBe('currentColor')
  })

  test('未置顶：钉身空心（none），只剩描边轮廓', () => {
    const { container } = render(<IconPin size={14} />)
    const body = bodyPath(container)
    expect(body).toBeTruthy()
    expect(body?.getAttribute('fill')).toBe('none')
  })

  test('size 透传成 width/height（会话行 14px 那一档）', () => {
    const { container } = render(<IconPin size={14} filled />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('14')
    expect(svg?.getAttribute('height')).toBe('14')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
  })
})
