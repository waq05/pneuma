/**
 * 审查面板（`ui-layout/ui/review-pane.tsx`）的渲染与交互段（ui 层，真渲染）。
 *
 * 面板读的是 dockkit 的审查目标（不是 props）：这里用 `setDockReview` 交接一轮改动，
 * 再钉「单文件显示相对路径与增删计数、多文件下拉切换、空清单给人话、关闭清目标、
 * 分栏/换行视图落盘、有原生桥时系统打开把路径交出去」。
 *
 * `DiffRows` 的高亮是异步的，这几条用例不依赖 token：文件扩展名取 `.txt`（没有语法，
 * 立即回落纯文本），断言只落在结构与文案上。
 *
 * @module dsc-ui-layout/ui/review-pane.spec
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { dockReview, setDockReview } from '@dsc/ui-dockkit'
import type { ChangedFileView } from '@dsc/ui-core'
import { ReviewPane } from './review-pane.js'

/** 一份最小改动：一个 add 行，路径用 .txt 避开 shiki 语法装载。 */
function fileOf(path: string, over: Partial<ChangedFileView> = {}): ChangedFileView {
  return {
    path,
    added: 1,
    removed: 0,
    status: 'modified',
    hunks: [
      {
        oldStart: 1,
        oldCount: 0,
        newStart: 1,
        newCount: 1,
        lines: [{ kind: 'add', text: 'hello', oldLine: null, newLine: 1 }],
      },
    ],
    ...over,
  }
}

const textOf = (element: Element | null): string => element?.textContent ?? ''

const toolOf = (container: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('.diff-tool')].find(
    (button) => textOf(button) === label,
  ) as HTMLButtonElement | undefined

beforeEach(() => {
  localStorage.clear()
  // jsdom 没有 scrollIntoView：Select 打开后会把高亮项滚进可视区。
  ;(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = (): void => undefined
})

afterEach(() => {
  cleanup()
  setDockReview(null)
  document.body.innerHTML = ''
  delete (globalThis as { dscNative?: unknown }).dscNative
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  localStorage.clear()
})

describe('审查目标与文件清单', () => {
  test('没点过「审查」时整块不渲染', () => {
    const { container } = render(<ReviewPane />)
    expect(container.querySelector('aside.diff-pane')).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  test('单文件：显示相对路径与增删计数，hunk 画成 unified diff；关闭清掉审查目标', () => {
    setDockReview({ files: [fileOf('C:/repo/src/notes.txt', { added: 3, removed: 1 })], index: 0, cwd: 'C:/repo' })
    const { container } = render(<ReviewPane />)

    expect(textOf(container.querySelector('.diff-file-name'))).toBe('src/notes.txt')
    expect(textOf(container.querySelector('.changes-added'))).toBe('+3')
    expect(textOf(container.querySelector('.changes-removed'))).toBe('-1')
    expect(textOf(container.querySelector('.diff-hunk-head'))).toBe('@@ -1,0 +1,1 @@')
    expect(textOf(container.querySelector('.diff-line.diff-add'))).toContain('hello')
    // 单文件不画下拉。
    expect(container.querySelector('.select-trigger')).toBeNull()

    fireEvent.click(toolOf(container, '关闭') as HTMLButtonElement)
    expect(dockReview()).toBeNull()
    expect(container.querySelector('aside.diff-pane')).toBeNull()
  })

  test('多文件：下拉按 review.index 定位；选另一项就换那一份的路径与 diff', () => {
    setDockReview({
      files: [fileOf('C:/repo/a.txt'), fileOf('C:/repo/b.txt', { added: 7 })],
      index: 1,
      cwd: 'C:/repo',
    })
    const { container } = render(<ReviewPane />)

    expect(textOf(container.querySelector('.select-value'))).toBe('b.txt')
    expect(textOf(container.querySelector('.changes-added'))).toBe('+7')

    fireEvent.click(container.querySelector('.select-trigger') as HTMLElement)
    const options = [...document.querySelectorAll('.select-opt')] as HTMLElement[]
    expect(options).toHaveLength(2)
    fireEvent.click(options[0] as HTMLElement)

    expect(textOf(container.querySelector('.select-value'))).toBe('a.txt')
    expect(textOf(container.querySelector('.changes-added'))).toBe('+1')
  })

  test('空清单：给「这一轮没有可审查的改动」，不画计数与 diff 正文', () => {
    setDockReview({ files: [], index: 0, cwd: 'C:/repo' })
    const { container } = render(<ReviewPane />)

    expect(textOf(container.querySelector('.diff-note'))).toBe('这一轮没有可审查的改动。')
    expect(container.querySelector('.changes-counts')).toBeNull()
    expect(container.querySelector('.diff-body')).toBeNull()
  })
})

describe('视图开关与外部打开', () => {
  test('分栏/换行切换写进 localStorage，diff 正文跟着换视图', () => {
    setDockReview({ files: [fileOf('C:/repo/a.txt')], index: 0, cwd: 'C:/repo' })
    const { container } = render(<ReviewPane />)

    const split = toolOf(container, '分栏') as HTMLButtonElement
    expect(split.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(split)
    expect(localStorage.getItem('dsc.diffView')).toBe('split')
    expect(toolOf(container, '合并')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('.diff-body')?.getAttribute('data-split')).toBe('true')

    const wrap = toolOf(container, '换行') as HTMLButtonElement
    expect(wrap.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(wrap)
    expect(localStorage.getItem('dsc.diffWrap')).toBe('wrap')
    expect(toolOf(container, '换行')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('.diff-body')?.getAttribute('data-wrap')).toBe('true')
  })

  test('新增 + 截断提示一起出现；有原生桥时「系统打开」把文件路径交出去', () => {
    const nativeCalls: Array<{ op: string; args: unknown[] }> = []
    ;(globalThis as { dscNative?: unknown }).dscNative = {
      version: 1,
      call: (op: string, args: unknown[] = []): Promise<unknown> => {
        nativeCalls.push({ op, args })
        return Promise.resolve(undefined)
      },
      on: () => () => undefined,
    }
    setDockReview({
      files: [fileOf('C:/repo/new.txt', { status: 'added', truncated: true })],
      index: 0,
      cwd: 'C:/repo',
    })
    const { container } = render(<ReviewPane />)

    expect(textOf(container.querySelector('.diff-badge'))).toBe('新增')
    expect(textOf(container.querySelector('.diff-note'))).toContain('改动较大')
    fireEvent.click(toolOf(container, '系统打开') as HTMLButtonElement)
    expect(nativeCalls).toEqual([{ op: 'openPath', args: ['C:/repo/new.txt'] }])
  })
})
