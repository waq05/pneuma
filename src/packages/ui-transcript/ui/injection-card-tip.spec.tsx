/**
 * 上下文注入卡头行提示的渲染段（迁自 `scripts/injection-card-tip-test.mjs` 的行为半，B6）。
 *
 * ## 来源与分层
 *
 * 原探针钉两件事：
 *   [1] `rows/prompt-card.tsx` 的注入卡头行上有原生 `title`，且用了
 *       `transcript.injection.newOnlyTip`；开合提示（expandTip / collapseTip）没被顶掉；
 *   [2] 中英字典里口径句非空、没编造「另有 N 项」这类读数；
 *   [3] 卡片标题文字不许动。
 *
 * [1] 的一半是**源码文本**（某表达式里出现某键），另一半是**用户真能看到的 DOM 属性**。
 * 后者在 jsdom 里有接缝：真渲染 `ContextInjectionCard`，读 `.entry-injection-head` 的
 * `title` 与 `.entry-injection-label`，点开再看 title 是否换成收起提示。所以这里把行为段
 * 迁进 ui 层；**探针保留**，因为下面这些 jsdom 够不到：
 *
 * - [1] 的源码身份钉（`title` 必须挂在那段 JSX、必须真的用字典键而不是抄一份同文文案）；
 * - [2] 的中英双字典键集与英文措辞（本 spec 只覆盖中文渲染结果；英文要在启动图切语言，
 *   ui project 没有那条通道）；
 * - [2]/[3] 的「标题字面量没被改」与「字典里不许出现 N 项读数」的**内容审计**；
 * - 真机 DOM 那一半在 `desktop/shots/_verify-prompt-cards.mjs`（桌面构建产物 + 造好的
 *   会话，读 `.entry-injection-head` 的 title），按 B6 继续留 shots。
 *
 * @module dsc-ui-transcript/ui/injection-card-tip.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ContextInjectionCard, type ContextInjectionView } from './rows/prompt-card.js'

afterEach(() => {
  cleanup()
})

/** 两条注入：一条带预览、一条不带（与既有注入卡用例同一份形状）。 */
const partsOf = (): ContextInjectionView[] => [
  { kind: 'todo-reminder', source: 'todo', where: 'user-tail', chars: 5 },
  { kind: 'env-facts', source: 'env', where: 'user-tail', chars: 300, preview: '平台 win32 · cwd D:/demo' },
]

/** 头行节点；找不到就让用例红（不是静默跳过）。 */
function headOf(container: HTMLElement): HTMLElement {
  const found = container.querySelector('.entry-injection-head')
  if (found === null) throw new Error('没有找到 .entry-injection-head')
  return found as HTMLElement
}

describe('注入卡头行：口径提示 + 开合提示，标题不受影响', () => {
  test('收起态 title 同时带「只列这一跳新增」口径与展开提示，标签仍是「上下文注入」', () => {
    const { container } = render(<ContextInjectionCard parts={partsOf()} />)
    const head = headOf(container)
    const title = head.getAttribute('title') ?? ''
    expect(title).toContain('只列这一跳新增的注入')
    expect(title).toContain('内容没变的项不会重复出现')
    expect(title).toContain('展开这一轮注入了什么')
    expect(container.querySelector('.entry-injection-label')?.textContent).toBe('上下文注入')
    expect(head.getAttribute('aria-expanded')).toBe('false')
  })

  test('点开后 title 换成收起提示，口径句仍在', () => {
    const { container } = render(<ContextInjectionCard parts={partsOf()} />)
    const head = headOf(container)
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    const title = head.getAttribute('title') ?? ''
    expect(title).toContain('只列这一跳新增的注入')
    expect(title).toContain('收起这一轮注入了什么')
    expect(title).not.toContain('展开这一轮注入了什么')
    // 展开体照常出现两条：口径提示没有把卡片开合顶掉。
    expect(container.querySelectorAll('.entry-injection-row')).toHaveLength(2)
  })

  test('提示里没有编造「另有 N 项未变」这类读数', () => {
    const { container } = render(<ContextInjectionCard parts={partsOf()} />)
    const title = headOf(container).getAttribute('title') ?? ''
    expect(title).not.toMatch(/另有|N 项|\+\d+ 项/)
  })
})
