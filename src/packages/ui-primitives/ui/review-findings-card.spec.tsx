/**
 * `/review` 结论卡（`review-findings-card.tsx`）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-review-findings-test.mjs` 的「样式与接线」段（缺口清单 B37）。原探针钉
 * 卡片源码里有没有那 13 个类名、`data-priority` 与 `P${priority}` 文本；这里把那 13 个接缝
 * 真渲染出来——类名落在 DOM 上、四档徽标与人话、位置按钮的绝对路径与行号、无通道时置灰。
 *
 * 不迁的（无渲染接缝，见交付报告缺口清单）：
 * - 「四档徽标色都在 views.css」——jsdom 不应用样式表，色值是样式表文本钉，转 shots；
 * - 「基元包导出」的源码文本钉换成从 `@dsc/ui-primitives` 的公开面 import（编译期 + 运行期
 *   都在验这条出口），同一件事不再读源码。
 *
 * @module dsc-ui-primitives/ui/review-findings-card.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ReviewFindingsCard } from '@dsc/ui-primitives'
import type { ReviewFindingsView } from './review-findings.js'

afterEach(cleanup)

/** 三条条目：P0 / P2 / 认不出档位；第二条带建议、第一条带多行说明。 */
const docOf = (over: Partial<ReviewFindingsView> = {}): ReviewFindingsView => ({
  teammate: 'reviewer-1',
  state: '已完成',
  note: '整体看过一遍，改动集中在 /review 这条链上。',
  findings: [
    {
      priority: 0,
      title: '取消之后记录还会被覆盖',
      location: { path: 'src/packages/subagent/index.ts', line: 870 },
      detail: '收工回调里无条件写 finished。',
      suggestion: '给 finish 传队友名。',
    },
    {
      priority: 2,
      title: '路径没归一',
      location: { path: 'src/core/git-info.ts', line: 128 },
      detail: '先归一化再比较。',
    },
    {
      title: '写错档位的一条',
      detail: '',
    },
  ],
  ...over,
})

const query = (container: HTMLElement, selector: string): HTMLElement => {
  const found = container.querySelector(selector)
  if (found === null) throw new Error(`没有找到 ${selector}`)
  return found as HTMLElement
}

describe('卡头与引言', () => {
  test('根节点、队友名、收工状态与条数都在；条目按文档顺序铺', () => {
    const { container } = render(<ReviewFindingsCard doc={docOf()} />)
    expect(query(container, '.review-findings').getAttribute('data-review-findings')).toBe('')
    expect(query(container, '.review-findings-title').textContent).toBe('代码审查 · reviewer-1')
    expect(query(container, '.review-findings-state').textContent).toBe('已完成')
    expect(query(container, '.review-findings-head').textContent).toContain('3 条')
    expect(query(container, '.review-findings-note').textContent).toContain('整体看过一遍')
    const titles = [...container.querySelectorAll('.review-finding-title')].map((node) => node.textContent)
    expect(titles).toEqual(['取消之后记录还会被覆盖', '路径没归一', '写错档位的一条'])
  })

  test('队友名缺席时标题回落到「审查队友」；没有状态时不多画一个空标签', () => {
    const { container } = render(<ReviewFindingsCard doc={docOf({ teammate: '', state: undefined })} />)
    expect(query(container, '.review-findings-title').textContent).toBe('代码审查 · 审查队友')
    expect(container.querySelector('.review-findings-state')).toBeNull()
  })

  test('一条都没有：不画列表、不画条数，但引言照画', () => {
    const { container } = render(
      <ReviewFindingsCard doc={docOf({ findings: [], note: '没有发现问题。' })} />,
    )
    expect(container.querySelector('.review-findings-list')).toBeNull()
    expect(container.querySelector('.review-findings-head')?.textContent).not.toContain('条')
    expect(query(container, '.review-findings-note').textContent).toBe('没有发现问题。')
  })
})

describe('条目：四档徽标、位置按钮、说明与建议', () => {
  test('优先级写进 data-priority（P0 / P2 / 认不出不写），徽标翻成人话', () => {
    const { container } = render(<ReviewFindingsCard doc={docOf()} />)
    const rows = [...container.querySelectorAll('.review-finding')] as HTMLElement[]
    expect(rows[0]?.getAttribute('data-priority')).toBe('P0')
    expect(rows[1]?.getAttribute('data-priority')).toBe('P2')
    expect(rows[2]?.hasAttribute('data-priority')).toBe(false)
    const badges = [...container.querySelectorAll('.review-finding-badge')].map((node) => node.textContent)
    expect(badges).toEqual(['P0 必须修', 'P2 建议', 'P?'])
  })

  test('位置按钮显示 path:line；有跳转通道时点一下给绝对路径与行号', () => {
    const onOpenLocation = vi.fn()
    const { container } = render(<ReviewFindingsCard doc={docOf()} cwd="D:/repo" onOpenLocation={onOpenLocation} />)
    const rows = [...container.querySelectorAll('.review-finding')] as HTMLElement[]
    const button = query(rows[0] as HTMLElement, '.review-finding-loc')
    expect(button.textContent).toBe('src/packages/subagent/index.ts:870')
    expect(button).toHaveProperty('disabled', false)
    fireEvent.click(button)
    // joinPath 用 Windows 反斜杠拼子路径（fs-list / fs-read 吃这种形状）。
    expect(onOpenLocation).toHaveBeenCalledWith('D:/repo\\src/packages/subagent/index.ts', 870)
  })

  test('没有跳转通道时按钮置灰（位置照常完整显示，不装成能点）', () => {
    const { container } = render(<ReviewFindingsCard doc={docOf()} />)
    const button = query(container, '.review-finding-loc')
    expect(button).toHaveProperty('disabled', true)
    expect(button.textContent).toBe('src/packages/subagent/index.ts:870')
  })

  test('说明与建议各占一段；空说明不画空段落；建议带「建议：」前缀', () => {
    const { container } = render(<ReviewFindingsCard doc={docOf()} />)
    const rows = [...container.querySelectorAll('.review-finding')] as HTMLElement[]
    expect(query(rows[0] as HTMLElement, '.review-finding-detail').textContent).toBe('收工回调里无条件写 finished。')
    expect(query(rows[0] as HTMLElement, '.review-finding-suggest').textContent).toBe('建议：给 finish 传队友名。')
    expect(rows[1]?.querySelector('.review-finding-suggest')).toBeNull()
    expect(rows[2]?.querySelector('.review-finding-detail')).toBeNull()
  })
})
