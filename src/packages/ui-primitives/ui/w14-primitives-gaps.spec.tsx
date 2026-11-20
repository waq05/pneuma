/**
 * 基元包（`ui-primitives/ui`）第四批补测：W14 剩下的零散出口。
 *
 * 已有 spec 各管一块：`w12-highlight` 钉懒装载与回落、`primitives-extra` 钉弹层焦点主链路、
 * `panels-resizer` / `w11-branches` 钉拖拽状态机、`diff-rows` 出现在多处渲染用例里。
 * 这一份只补它们没走到的：
 *
 * - `highlightToHtml`（另一条 HTML 出口，全仓从没直接调过）：有语言 / 没语言 / 认不出的语言；
 * - `useDialogFocus` 在弹层里一个可聚焦元素都没有时，Tab 被拦下（焦点不会跑到遮罩底下）；
 * - `useWidthDrag` 的取消帧：移动排了一帧、松手在帧跑之前 → `cancelAnimationFrame` 真的被调；
 * - `.dart` 按项目快照认 Flutter；认不出的档位走 `assertNever`（编译期闭集的运行期兜底文案）；
 * - `run_code` 的脚本摘要只取第一行（全是空行/注释时摘要为空，不吐整段脚本）；
 * - `DiffRows` 的 split 视图在增删行数不等时给缺的那半边画淡占位；
 * - `useHostNative` hook 形态在没有桥的浏览器环境里给 `available:false`。
 *
 * @module dsc-ui-primitives/ui/w14-primitives-gaps.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, renderHook } from '@testing-library/react'
import type { DiffHunkView } from '@dsc/ui-core'
import { useDialogFocus } from './dialog-focus.js'
import { useWidthDrag } from './panels.js'
import { classifyCodeFileType, type FileTypeKind } from './file-type-classify.js'
import { FileTypeIcon } from './file-type-icon.js'
import { toolSummary } from './tool-summary.js'
import { DiffRows } from './diff-rows.js'
import { useHostNative } from './native.js'
import { highlightToHtml } from './highlight.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── highlightToHtml：另一条 HTML 出口 ────────────────────────────────────────

describe('highlightToHtml', () => {
  test('有语言：出 shiki 的 pre/code，双主题变量在行内 style 上', async () => {
    const html = await highlightToHtml('const a = 1', 'ts')
    expect(html).toContain('<pre')
    expect(html).toContain('class="shiki')
    expect(html).toContain('--shiki-light')
  })

  test('没有围栏语言 / 认不出的语言：回落纯文本 lang，照样出 HTML', async () => {
    const plain = await highlightToHtml('随便一段', undefined)
    expect(plain).toContain('<pre')
    expect(plain).toContain('随便一段')
    const unknown = await highlightToHtml('x = 1', 'no-such-lang')
    expect(unknown).toContain('x = 1')
  })
})

// ── dialog-focus：没有可聚焦元素时的 Tab ─────────────────────────────────────

describe('弹层里一个可聚焦元素都没有', () => {
  test('Tab 被拦下（preventDefault），焦点不跑到遮罩底下', () => {
    function Dialog(): React.ReactNode {
      const { ref } = useDialogFocus(true)
      return (
        <div ref={ref} data-testid="dialog">
          <span>只有文字，没有按钮</span>
        </div>
      )
    }
    const { getByTestId } = render(<Dialog />)
    const dialog = getByTestId('dialog')
    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    })
    dialog.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    // Shift+Tab 同样拦。
    const back = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    dialog.dispatchEvent(back)
    expect(back.defaultPrevented).toBe(true)
  })
})

// ── useWidthDrag：取消还没跑的那一帧 ─────────────────────────────────────────

describe('拖拽状态机：松手取消还没跑的那一帧', () => {
  let node: HTMLDivElement
  let rafCallbacks: FrameRequestCallback[]
  let cancel: ReturnType<typeof vi.fn>

  beforeEach(() => {
    rafCallbacks = []
    cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', cancel)
    node = document.createElement('div')
    document.body.appendChild(node)
    Object.defineProperty(node, 'hasPointerCapture', {
      configurable: true,
      value: () => true,
    })
    Object.defineProperty(node, 'setPointerCapture', {
      configurable: true,
      value: () => undefined,
    })
    Object.defineProperty(node, 'releasePointerCapture', {
      configurable: true,
      value: () => undefined,
    })
  })

  afterEach(() => {
    node.remove()
    document.body.classList.remove('resizing')
  })

  test('按下 → 移动（排帧）→ 帧还没跑就松手：那一帧被取消，落盘按最后一次指针位置算', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() =>
      useWidthDrag({
        getBase: () => 300,
        sign: 1,
        clamp: (px) => px,
        onDrag: vi.fn(),
        onCommit,
      }),
    )
    const event = (clientX: number): Record<string, unknown> => ({
      button: 0,
      pointerId: 1,
      clientX,
      clientY: 0,
      preventDefault: vi.fn(),
      currentTarget: node,
    })
    const down = result.current.onPointerDown as unknown as (event: unknown) => void
    const move = result.current.onPointerMove as unknown as (event: unknown) => void
    const up = result.current.onPointerUp as unknown as (event: unknown) => void
    down(event(100))
    move(event(140))
    // 帧还在队列里：这一拍松手，排好的那一帧必须被撤销。
    up(event(150))
    expect(cancel).toHaveBeenCalled()
    expect(onCommit).toHaveBeenCalledWith(350)
  })
})

// ── 文件类型：Flutter 与闭集兜底 ────────────────────────────────────────────

describe('文件类型分类的边界', () => {
  test('.dart 按项目快照认 Flutter；没有 flutter 标记就不是', () => {
    expect(
      classifyCodeFileType('main.dart', 'dart', {
        files: {
          'app/pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n',
        },
      }),
    ).toBe('flutter')
    expect(
      classifyCodeFileType('main.dart', 'dart', {
        files: { 'pubspec.yaml': 'name: app' },
      }),
    ).not.toBe('flutter')
    expect(classifyCodeFileType('main.dart', 'dart')).not.toBe('flutter')
  })

  test('认不出的档位走 assertNever：抛一句人能读的错，而不是画一张空白字形', () => {
    expect(() => render(<FileTypeIcon kind={'no-such-kind' as FileTypeKind} />)).toThrow(/没有字形的传统档/)
  })
})

// ── 工具摘要：脚本类参数只取第一行 ──────────────────────────────────────────

describe('run_code 的脚本摘要', () => {
  test('取第一行非空、去掉行首注释；全是空行/注释时脚本摘要为空，退回参数里的短字符串', () => {
    expect(toolSummary('run_code', JSON.stringify({ code: '// 先读文件\nconst a = 1' }))).toBe('先读文件')
    // 首行取不到内容：摘要不吃整段脚本，退回压平后的参数原文（这里是 `//`）。
    const blank = toolSummary('run_code', JSON.stringify({ code: '// \n\n   \n' }))
    expect(blank).toBe('//')
  })
})

// ── DiffRows：split 视图的缺半边 ────────────────────────────────────────────

describe('DiffRows 的 split 视图', () => {
  test('删两行加一行：第二对右半边是空占位', () => {
    const hunk: DiffHunkView = {
      oldStart: 1,
      oldCount: 2,
      newStart: 1,
      newCount: 1,
      lines: [
        { kind: 'remove', oldLine: 1, newLine: null, text: '旧一' },
        { kind: 'remove', oldLine: 2, newLine: null, text: '旧二' },
        { kind: 'add', oldLine: null, newLine: 1, text: '新一' },
      ],
    }
    const { container } = render(<DiffRows hunks={[hunk]} path="" split />)
    expect(container.querySelectorAll('.diff-split-row').length).toBe(2)
    expect(container.querySelectorAll('.diff-half-empty').length).toBe(1)
    expect(container.querySelector('.diff-hunk-head')?.textContent).toContain('@@ -1,2 +1,1 @@')
  })
})

// ── 原生桥的 hook 形态 ──────────────────────────────────────────────────────

describe('useHostNative', () => {
  test('浏览器里没有桥：available 为 false，invoke 给拒绝的 Promise', async () => {
    const { result } = renderHook(() => useHostNative())
    expect(result.current.available).toBe(false)
    expect(result.current.version).toBeNull()
    await expect(result.current.invoke('notify')).rejects.toThrow()
  })
})
