/**
 * 基元包几处分支的补盲：
 * - `select.tsx`：滚轮在浮层外 / 键盘按到未处理的键；
 * - `confirm.ts`：Tab 在两个按钮之间循环、非 Tab 键不拦；
 * - `humanize-error.ts`：对象原文既不是合法 JSON 又不能被 `String()` 的兜底；
 * - `review-findings.ts`：位置写成「无行号」形态、条目里出现空行时字段回落。
 *
 * @module dsc/packages/ui-primitives/ui/w12-primitives-branches.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Select } from './select.js'
import { confirmAction } from './confirm.js'
import { humanizeError } from './humanize-error.js'
import { parseReviewFindings } from './review-findings.js'

beforeEach(() => {
  // jsdom 没有布局，`scrollIntoView` 不存在：下拉浮层打开时会调它把高亮项滚进可视区。
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  // 确认框挂在 document.body 上：用例结束后清掉，别影响下一个。
  document.querySelectorAll('.dsc-confirm').forEach((element) => element.remove())
})

describe('Select：浮层外的滚轮与未处理的按键', () => {
  const options = [
    { value: 'a', label: '甲' },
    { value: 'b', label: '乙' },
  ] as const

  test('打开后滚轮滚页面（目标不在浮层里）：收起浮层', () => {
    const onPick = vi.fn()
    render(<Select value="a" options={options} onPick={onPick} />)
    fireEvent.click(screen.getByRole('combobox'))
    expect(document.querySelector('.select-pop')).not.toBeNull()
    fireEvent.wheel(document.body)
    expect(document.querySelector('.select-pop')).toBeNull()
    expect(onPick).not.toHaveBeenCalled()
  })

  test('打开后按未处理的键：什么都不做，浮层仍开着', () => {
    const onPick = vi.fn()
    render(<Select value="a" options={options} onPick={onPick} />)
    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger)
    const event = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })
    trigger.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(document.querySelector('.select-pop')).not.toBeNull()
  })
})

describe('Confirm：Tab 焦点循环', () => {
  test('Tab 在两个按钮之间来回，非 Tab 键不拦', async () => {
    const promise = confirmAction({ title: '循环？', detail: '说明', confirmLabel: '好' })
    const overlay = document.querySelector('.dsc-confirm') as HTMLElement
    const buttons = [...overlay.querySelectorAll('button')] as HTMLElement[]
    const cancel = buttons[0]!
    const proceed = buttons[1]!
    expect(document.activeElement).toBe(cancel)

    // 非 Tab：不拦（默认行为留给浏览器）。
    const other = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    document.dispatchEvent(other)
    expect(other.defaultPrevented).toBe(false)

    // Tab：焦点从取消挪到确认。
    const first = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(first)
    expect(first.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(proceed)

    // 再 Tab：绕回取消。
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(cancel)

    fireEvent.click(cancel)
    await expect(promise).resolves.toBe(false)
  })
})

describe('humanizeError：原文兜底', () => {
  test('对象没有可序列化结构：退回 String()', () => {
    const weird = { toJSON: (): undefined => undefined }
    const result = humanizeError(weird, '兜底标题')
    expect(result.detail).toContain('Object')
    expect(result.title).toBe(result.detail.split(/\r?\n/)[0])
  })

  test('String() 本身抛错：原文空串，标题用兜底', () => {
    const hostile = {
      toString(): string {
        throw new Error('不许转')
      },
    }
    const result = humanizeError(hostile, '兜底标题')
    expect(result.detail).toBe('')
    expect(result.title).toBe('兜底标题')
    expect(result.hint).toBeTruthy()
  })
})

/** 照协议拼一份 findings 正文。 */
function wrap(body: string): string {
  return `<review-findings teammate="r1">\n${body}\n</review-findings>`
}

describe('parseReviewFindings：位置无行号与空行回落', () => {
  test('位置写成「无行号」形态：整段当路径', () => {
    const doc = parseReviewFindings(wrap('### [P1] 标题\n位置：src/a.ts'))
    expect(doc?.findings[0]?.location).toEqual({ path: 'src/a.ts' })
    const withJunk = parseReviewFindings(wrap('### [P1] 标题\n位置：src/a.ts:见下'))
    expect(withJunk?.findings[0]?.location).toEqual({ path: 'src/a.ts:见下' })
  })

  test('条目里出现空行：字段段落关掉，后续裸行回到说明', () => {
    const doc = parseReviewFindings(
      wrap(['### [P1] 标题', '说明：第一段', '建议：先改这里', '', '裸行补一句'].join('\n')),
    )
    const finding = doc?.findings[0]
    expect(finding?.detail).toContain('第一段')
    expect(finding?.detail).toContain('裸行补一句')
    expect(finding?.suggestion).toBe('先改这里')
  })
})
