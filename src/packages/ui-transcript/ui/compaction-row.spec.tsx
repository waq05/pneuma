/**
 * 压缩落点行（`rows/compaction-row.tsx`）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-compaction-row-test.mjs` 第 [1]（缺口清单 B34）——组件本体原来钉的
 * 是源码形态（className、data 属性、字典键调用），这里真画出来验：
 *  - 次数从 `mark.count` 来（换一个 count，读数跟着变——数据驱动的证据）；
 *  - 两侧各一条 `aria-hidden` 的分隔线；
 *  - 说明挂在原生 `title` 上（气泡层 0.6.37 起下线，只写 data-tip 等于藏进 DOM）；
 *  - 组件只收 mark：正文不进组件的渲染面（text 是给轨迹页取证用的）。
 *
 * 第 [3][5] 段是 CSS 规则体与「组件里没有中文字面量」的源码扫描钉——jsdom 不应用样式表、
 * 文字钉没有行为等价物，不迁（文案键的**存在性**在下面用取词器的行为验：未知键会原样
 * 返回键名，渲染出键名就是键不存在）。
 *
 * @module dsc-ui-transcript/ui/compaction-row.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { CompactionRow } from './rows/compaction-row.js'

afterEach(cleanup)

describe('压缩落点行（B34 ui-compaction-row [1]）', () => {
  test('次数写进 data-compaction-count，中间一行小字说「第几次」', () => {
    const { container } = render(<CompactionRow mark={{ count: 2 }} />)
    const row = container.querySelector('.entry-compaction') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.getAttribute('data-compaction-count')).toBe('2')
    expect(row.textContent).toContain('2')
  })

  test('换一个次数读数跟着变（数据驱动，不是写死的一句）', () => {
    const { container, rerender } = render(<CompactionRow mark={{ count: 1 }} />)
    expect((container.querySelector('.entry-compaction') as HTMLElement).getAttribute('data-compaction-count')).toBe('1')
    rerender(<CompactionRow mark={{ count: 7 }} />)
    expect((container.querySelector('.entry-compaction') as HTMLElement).getAttribute('data-compaction-count')).toBe('7')
    expect(container.querySelector('.entry-compaction')?.textContent).toContain('7')
  })

  test('两侧各一条 aria-hidden 的分隔线（读屏只读中间那行字）', () => {
    const { container } = render(<CompactionRow mark={{ count: 1 }} />)
    const lines = [...container.querySelectorAll('.entry-compaction-line')]
    expect(lines.length).toBe(2)
    expect(lines.every((line) => line.getAttribute('aria-hidden') === 'true')).toBe(true)
  })

  test('说明挂原生 title（气泡层已下线，data-tip 之外还得让人看得见）', () => {
    const { container } = render(<CompactionRow mark={{ count: 1 }} />)
    const row = container.querySelector('.entry-compaction') as HTMLElement
    const title = row.getAttribute('title') ?? ''
    expect(title).not.toBe('')
    // 不是键名（键不存在时取词器原样返回键名）——说明文案真的在字典里。
    expect(title).not.toContain('transcript.compaction')
    expect(row.getAttribute('data-tip')).toBe(title)
  })

  test('正文不进组件的渲染面（system 的取证全文是给轨迹页的）', () => {
    const { container } = render(<CompactionRow mark={{ count: 1 }} />)
    const row = container.querySelector('.entry-compaction') as HTMLElement
    // 一行小字 + 两条线，除次数说明外没有别的正文内容。
    expect(row.textContent?.replace(/\D/g, '').length).toBeLessThanOrEqual(2)
  })
})
