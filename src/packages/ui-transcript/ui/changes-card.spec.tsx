/**
 * 轮尾「文件已更改」卡与悬停预览（`rows/changes-card.tsx`）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-transcript-render-test.mjs` 第 [6]（缺口清单 B33）——悬停预览的
 * 收卡口径。原探针钉的是源码里 `className="hover-preview"` 后面挂着 onMouseEnter={onKeep}
 * onMouseLeave={onLeave}` 的形状；这里把同一件事行为化：
 *  - 行上停 **500ms** 才出卡（划过一路不闪卡）；
 *  - 移开 **1s** 后才收（参考实现是 100ms，本壳有意分道）；
 *  - 卡上挂着 onMouseEnter（keep 续命）与 onMouseLeave（disarm 起同一条倒计时）——
 *    只挂 keep 会让卡永远粘住（2026-10-14 的报障）；
 *  - Esc 收卡走 capture（审批卡在冒泡阶段把 Esc 当拒绝，预览开着时先收预览）。
 *
 * 500 / 1000 两个常量的行为面在 `@dsc/ui-primitives` 的 `hover-delay.spec.tsx` 兜底
 * （替换体不依赖 ChangesCard 的接线）；这份钉的是「卡片真的接在事件上」。
 *
 * @module dsc-ui-transcript/ui/changes-card.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ChangedFileView } from '@dsc/ui'
import type { Row } from './shared.js'
import { keyOf } from './shared.js'
import { ChangesCard } from './rows/changes-card.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** 造一条 changes 条目包成行。 */
const changeRow = (path: string, added: number, removed: number): Row =>
  ({
    entry: { kind: 'changes', id: Math.abs(hashOf(path)), file: { path, added, removed, hunks: [], status: 'modified' } },
    live: false,
    at: 1,
    stable: `r0:changes:${path}`,
  }) as unknown as Row

function hashOf(text: string): number {
  let value = 0
  for (const ch of text) value = (value * 31 + ch.charCodeAt(0)) | 0
  return value
}

const renderCard = (rows: Row[]): ReturnType<typeof render> => render(<ChangesCard rows={rows} cwd="D:/demo" />)

/** 悬停用例的样张：两张文件（单文件卡没有行列表，悬停只发生在多文件卡上）。 */
const twoRows = (): Row[] => [changeRow('a.ts', 3, 1), changeRow('b.ts', 1, 1)]

const hoverCard = (): HTMLElement | null => document.body.querySelector('.hover-preview')

describe('行上停 500ms 出卡（B33 [6]）', () => {
  test('划过（<500ms）不出卡；停够 500ms 才出', () => {
    const { container } = renderCard(twoRows())
    const row = container.querySelector('.changes-row-wrap') as HTMLElement
    fireEvent.mouseEnter(row, { currentTarget: row })
    act(() => {
      vi.advanceTimersByTime(499)
    })
    expect(hoverCard()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(hoverCard()).toBeTruthy()
    // 卡里画的是该文件的 diff（hunks 就在条目上，不读盘）。
    expect(document.body.querySelector('.hover-preview-name')?.textContent).toContain('a.ts')
  })

  test('行上移开 1s 后才收；999ms 时还在', () => {
    const { container } = renderCard(twoRows())
    const row = container.querySelector('.changes-row-wrap') as HTMLElement
    fireEvent.mouseEnter(row, { currentTarget: row })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    fireEvent.mouseLeave(row)
    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(hoverCard()).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(hoverCard()).toBeNull()
  })
})

describe('卡上挂着 keep 与 disarm（B33 [6] 的另一半）', () => {
  test('鼠标移进卡里续命（keep），移出卡起同一条 1s 倒计时', () => {
    const { container } = renderCard(twoRows())
    const row = container.querySelector('.changes-row-wrap') as HTMLElement
    fireEvent.mouseEnter(row, { currentTarget: row })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    const card = hoverCard() as HTMLElement
    // 从行上移开、紧接着移进卡里：keep 取消收卡倒计时。
    fireEvent.mouseLeave(row)
    fireEvent.mouseEnter(card)
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(hoverCard()).toBeTruthy() // 只挂 keep 的旧病是这里卡永远粘住；现在的断言是 keep 之后移出才收
    // 移出卡：起同一条倒计时，1s 后收。
    fireEvent.mouseLeave(card)
    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(hoverCard()).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(hoverCard()).toBeNull()
  })
})

describe('Esc 收预览走 capture（审批卡把 Esc 当拒绝之前先收预览）', () => {
  test('预览开着时按 Esc 只收预览', () => {
    const { container } = renderCard(twoRows())
    const row = container.querySelector('.changes-row-wrap') as HTMLElement
    fireEvent.mouseEnter(row, { currentTarget: row })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(hoverCard()).toBeTruthy()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(hoverCard()).toBeNull()
  })
})

describe('聚合与折叠（对照旧界面 ChangedFilesCard）', () => {
  test('逐条 changes 按路径合并（同文件多刀相加）；turnDiff 在场就只用它', () => {
    const rows = [
      changeRow('a.ts', 3, 1),
      changeRow('a.ts', 2, 0),
      changeRow('b.ts', 1, 1),
    ]
    const { container } = renderCard(rows)
    expect(container.querySelectorAll('.changes-row').length).toBe(2)
    const first = container.querySelector('.changes-row') as HTMLElement
    expect(first.textContent).toContain('5')
    expect(first.textContent).toContain('1')
  })

  test('多文件卡头说「已编辑 N 个文件」；单文件说文件名', () => {
    const multi = renderCard([changeRow('a.ts', 1, 0), changeRow('b.ts', 1, 0)])
    expect((multi.container.querySelector('.changes-title') as HTMLElement).textContent).toMatch(/2/)
    const single = renderCard([changeRow('only.ts', 1, 0)])
    expect((single.container.querySelector('.changes-title') as HTMLElement).textContent).toContain('only.ts')
  })

  test('行数超过折叠阈值（4）收起，靠「展开全部」放出来', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => changeRow(`${name}.ts`, 1, 0))
    const { container } = renderCard(rows)
    expect(container.querySelectorAll('.changes-row').length).toBe(4)
    fireEvent.click(container.querySelector('.changes-toggle') as HTMLElement)
    expect(container.querySelectorAll('.changes-row').length).toBe(6)
  })

  test('没有改动的轮不画这张卡', () => {
    const { container } = renderCard([])
    expect(container.querySelector('.changes-card')).toBeNull()
  })
})
