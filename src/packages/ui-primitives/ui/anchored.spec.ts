/**
 * 浮层锚定的纯逻辑（迁自 `scripts/ui-anchored-test.mjs` 第 [1]、[2] 段）。
 *
 * 原探针的口径：真机那半由 `ui-anchor-e2e.mjs` 量（矩形、间距、打开当帧不隐藏）；
 * 这里钉「算出来的东西对不对」——锚点名必须能被 `anchor-name` 接受，样式必须带
 * 上下缘/左缘/翻向/最小宽度四条。`anchorNameOf` 与 `anchoredStyles` 是纯函数
 * （只 import react 类型），真跑结果就是被测行为。
 *
 * 没迁的（原探针第 [3] 段，见交付报告缺口清单）：
 *   - `changes-card.tsx` 的悬停卡两份样式与「量 rect 上下二选一」的回退分支——JSX
 *     渲染体文本钉，接缝在渲染层，归组件渲染批；
 *   - `hover-delay.ts` 的 `arm` 第四参（锚点名）——`useHoverDelay` 是 React hook，
 *     验证要真渲染，同一批。
 *
 * @module dsc-ui-primitives/ui/anchored.spec
 */
import { describe, expect, test } from 'vitest'
import { anchorNameOf, anchoredStyles } from './anchored.js'

describe('anchorNameOf：React useId 的冒号名字整成合法的 anchor-name', () => {
  test('带冒号的 useId 造出 `--dsc-anchor-` 前缀的自定义属性名', () => {
    expect(anchorNameOf(':r7:')).toBe('--dsc-anchor-r7')
  })

  test('结果只含 anchor-name 认的字符（字母数字下划线连字符）', () => {
    // anchor-name 只认自定义属性名字符：冒号、点这些要被剔掉；下划线与连字符要留下。
    for (const id of [':r1:', ':r12:', '«r7»']) {
      expect(anchorNameOf(id)).toMatch(/^--[a-zA-Z0-9_-]+$/)
    }
    expect(anchorNameOf('_x-9')).toBe('--dsc-anchor-_x-9')
  })

  test('不同的 useId 造出不同的名字（两个浮层同屏不串锚点）', () => {
    expect(anchorNameOf(':r1:')).not.toBe(anchorNameOf(':r2:'))
  })
})

describe('anchoredStyles：锚点与浮层两份样式', () => {
  test('锚点那边写 anchor-name，浮层写 position-anchor 指回锚点', () => {
    const styles = anchoredStyles('--dsc-anchor-x', { gap: 4, width: 'anchor' })
    expect(styles.anchor).toMatchObject({ anchorName: '--dsc-anchor-x' })
    expect(styles.panel).toMatchObject({ positionAnchor: '--dsc-anchor-x' })
  })

  test('贴下缘（anchor(bottom) + gap）、对齐左缘', () => {
    const styles = anchoredStyles('--dsc-anchor-x', { gap: 4, width: 'anchor' })
    expect(styles.panel.top).toBe('calc(anchor(bottom) + 4px)')
    expect(styles.panel.left).toBe('anchor(left)')
  })

  test('放不下时翻上去（flip-block），宽度不窄于锚点（width=anchor）', () => {
    const styles = anchoredStyles('--dsc-anchor-x', { gap: 4, width: 'anchor' })
    expect(styles.panel.positionTryFallbacks).toBe('flip-block')
    expect(styles.panel.minWidth).toBe('anchor-size(width)')
  })

  test('width=auto 时不写 min-width（浮层自己定宽），gap 跟着参数走', () => {
    const panel = anchoredStyles('--dsc-anchor-y', { gap: 6, width: 'auto' }).panel
    expect(panel.minWidth).toBeUndefined()
    expect(panel.top).toBe('calc(anchor(bottom) + 6px)')
  })
})
