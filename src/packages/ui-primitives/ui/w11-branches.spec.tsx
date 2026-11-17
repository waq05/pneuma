/**
 * 基元包的长尾分支补测（ui 层，真渲染 + 直接调用纯函数）。
 *
 * 目标：把已有 spec 没铺到的「组件全量渲染 / 错误路径 / 表格截断与失败 / 拖拽状态机 /
 * 工具摘要兜底 / token 与吞吐读数 / 转出口」逐条钉住。只加测试，不改产品。
 *
 * 与既有 spec 的分工：`primitives-extra.spec.tsx` 铺过一次渲染与交互主干，
 * `panels-resizer.spec.ts` / `panels-geometry.spec.ts` 钉面板几何读写；这里补的是
 * 图标全量、表格的失败与多 sheet、`useWidthDrag` 的四条事件出口、摘要的兜底字段、
 * 以及六个「只做转出」的模块（re-export）真的还能调到实现。
 *
 * @module dsc-ui-primitives/ui/w11-branches.spec
 */
import { createElement, type ComponentType } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import * as icons from './icons.js'
import {
  IconCopyColor,
  IconFolderColor,
  IconFolderOpenColor,
  IconTerminalColor,
  IconVSCodeColor,
} from './icons-workspace.js'
import { CsvView, XlsxView } from './table-view.js'
import { ThreadResizer } from './thread-resizer.js'
import { useWidthDrag } from './panels.js'
import {
  DEFAULT_FIELDS,
  KNOWN_TOOLS,
  SUMMARY_FIELDS,
  TOOL_STATUS_TEXT,
  UNKNOWN_TOOL_ICON,
  UNKNOWN_TOOL_TITLE,
  matchTool,
  oneLine,
  prettyJson,
  shortUrl,
  toolSummary,
  toolVerb,
} from './tool-summary.js'
import { formatCostCny, formatTokens, trimZero } from './tokens.js'
import { Select } from './select.js'
import { errText } from './error-text.js'
import { sameGitSurface } from './git-surface.js'
import { createSignal } from './signal.js'
import { averageTtftMs, formatTokensPerSecond, tokensPerSecond } from './throughput.js'
import { parseUnifiedDiff, splitUnifiedDiffByFile } from './unified-diff.js'
import { Text } from './plugin-text.js'

// ── 表格两个解析库的替身（动态 import 也走替身）──────────────────────────────

const papa = vi.hoisted(() => ({ parse: vi.fn() }))
const xlsx = vi.hoisted(() => ({
  read: vi.fn(),
  utils: { sheet_to_json: vi.fn() },
}))

vi.mock('papaparse', () => ({ parse: papa.parse }))
vi.mock('xlsx', () => ({ read: xlsx.read, utils: xlsx.utils }))

// ── 图标全量渲染 ─────────────────────────────────────────────────────────────

const iconEntries = Object.entries(icons).filter(
  ([name, value]) => name.startsWith('Icon') && typeof value === 'function',
) as Array<[string, ComponentType<{ size?: number; className?: string }>]>

describe('icons.tsx：每个线性图标都画得出 SVG（全量）', () => {
  test('命名空间里每个 Icon* 都能渲染，尺寸透传，viewBox 与 aria-hidden 一致', () => {
    expect(iconEntries.length).toBeGreaterThan(45)
    for (const [name, Icon] of iconEntries) {
      const { container, unmount } = render(createElement(Icon, { size: 13 }))
      const svg = container.querySelector('svg')
      expect(svg, `${name} 没画出 svg`).not.toBeNull()
      expect(svg?.getAttribute('width'), `${name} 的宽度`).toBe('13')
      expect(svg?.getAttribute('height'), `${name} 的高度`).toBe('13')
      expect(svg?.getAttribute('aria-hidden'), `${name} 的 aria-hidden`).toBe('true')
      expect(svg?.getAttribute('viewBox'), `${name} 的 viewBox`).toMatch(/^0 0 (16 16|24 24)$/)
      unmount()
    }
  })

  test('不传 size：默认 16；className 透传到 svg 上', () => {
    const { container } = render(<icons.IconPlus className="plus" />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('16')
    expect(svg?.getAttribute('class')).toBe('plus')
  })

  test('iconSizeStyle 把尺寸挂成 --dsc-icon-size', () => {
    expect(icons.iconSizeStyle(17)).toEqual({ '--dsc-icon-size': '17px' })
  })

  test('IconPin：filled 两档与 size 透传（钉身 fill 跟着翻）', () => {
    const filled = render(<icons.IconPin size={14} filled />)
    expect(filled.container.querySelector('svg path[fill]')?.getAttribute('fill')).toBe('currentColor')
    filled.unmount()
    const hollow = render(<icons.IconPin size={14} />)
    expect(hollow.container.querySelector('svg path[fill]')?.getAttribute('fill')).toBe('none')
  })

  test('两个 16px 视口的图标也各自画得出（默认尺寸与自定义尺寸）', () => {
    for (const Icon of [icons.IconTriangleRightFill, icons.IconNewChat]) {
      const { container, unmount } = render(<Icon />)
      expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 16 16')
      unmount()
      const custom = render(<Icon size={22} className="c" />)
      const svg = custom.container.querySelector('svg')
      expect(svg?.getAttribute('width')).toBe('22')
      expect(svg?.getAttribute('class')).toBe('c')
    }
  })
})

describe('icons-workspace.tsx：彩色图标全量', () => {
  test('五个彩色图标都画得出 SVG，尺寸透传，颜色写死为对象本色', () => {
    const entries: Array<[string, ComponentType<{ size?: number; className?: string }>]> = [
      ['folder', IconFolderColor],
      ['folder-open', IconFolderOpenColor],
      ['terminal', IconTerminalColor],
      ['vscode', IconVSCodeColor],
      ['copy', IconCopyColor],
    ]
    for (const [name, Icon] of entries) {
      const { container, unmount } = render(<Icon size={15} className="ws" />)
      const svg = container.querySelector('svg')
      expect(svg, `${name} 没画出 svg`).not.toBeNull()
      expect(svg?.getAttribute('width')).toBe('15')
      expect(svg?.getAttribute('class')).toBe('ws')
      expect(svg?.getAttribute('fill')).toBe('none')
      unmount()
    }
    // 文件夹是双色：背板与前面的色值不同。
    const folder = render(<IconFolderColor />)
    const fills = [...folder.container.querySelectorAll('rect')].map((node) => node.getAttribute('fill'))
    expect(new Set(fills).size).toBe(2)
  })
})

// ── 表格视图：失败、tsv、多 sheet、截断 ─────────────────────────────────────

describe('table-view.tsx：CSV / TSV 的失败与分隔符分支', () => {
  test('解析成功：首行表头、行数据进 tbody', async () => {
    papa.parse.mockReturnValueOnce({ data: [['a', 'b'], ['1', '2']] })
    const { container } = render(<CsvView text={'a,b\n1,2'} path="a.csv" />)
    await waitFor(() => expect(container.querySelector('.file-table')).not.toBeNull())
    expect(container.querySelectorAll('thead th')).toHaveLength(2)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(papa.parse).toHaveBeenCalledWith('a,b\n1,2', { delimiter: undefined })
  })

  test('.tsv 显式制表符，CRLF 先归一成 LF', async () => {
    papa.parse.mockReturnValueOnce({ data: [['x']] })
    render(<CsvView text={'x\ty\r\n'} path="A.TSV" />)
    await waitFor(() => expect(papa.parse).toHaveBeenCalled())
    expect(papa.parse).toHaveBeenLastCalledWith('x\ty\n', { delimiter: '\t' })
  })

  test('解析抛错：给失败占位并带原因', async () => {
    papa.parse.mockImplementationOnce(() => {
      throw new Error('坏文件')
    })
    const { container } = render(<CsvView text={'x'} path="a.csv" />)
    await waitFor(() => expect(container.querySelector('.file-preview-empty')?.textContent).toContain('坏文件'))
  })

  test('非 Error 抛出：String 化后仍能显示', async () => {
    papa.parse.mockImplementationOnce(() => {
      throw 'plain'
    })
    const { container } = render(<CsvView text={'x'} path="a.csv" />)
    await waitFor(() => expect(container.querySelector('.file-preview-empty')?.textContent).toContain('plain'))
  })

  test('列超过 100：截断提示出现，列数被切到 100', async () => {
    const row = Array.from({ length: 120 }, (_, index) => String(index))
    papa.parse.mockReturnValueOnce({ data: [row] })
    const { container } = render(<CsvView text={'x'} path="a.csv" />)
    await waitFor(() => expect(container.querySelector('[data-tree-note="truncated"]')).not.toBeNull())
    expect(container.querySelectorAll('thead th')).toHaveLength(100)
  })
})

describe('table-view.tsx：xlsx 的多 sheet 与失败路径', () => {
  beforeEach(() => {
    xlsx.utils.sheet_to_json.mockReset()
    xlsx.utils.sheet_to_json.mockReturnValue([['h1', 'h2'], ['v1', undefined]])
    xlsx.read.mockReset()
    xlsx.read.mockReturnValue({
      SheetNames: ['第一页', '第二页'],
      Sheets: { 第一页: { name: 's1' }, 第二页: { name: 's2' } },
    })
  })

  test('多 sheet：画出页签，点第二页把该 sheet 转成行；null 单元格变空串', async () => {
    const { container } = render(<XlsxView base64={btoa('x')} />)
    await waitFor(() => expect(container.querySelectorAll('.file-sheet')).toHaveLength(2))
    expect(container.querySelectorAll('tbody td')[1]?.textContent).toBe('')
    fireEvent.click(container.querySelectorAll('.file-sheet')[1] as HTMLElement)
    await waitFor(() => expect(xlsx.utils.sheet_to_json).toHaveBeenCalledWith({ name: 's2' }, { header: 1, raw: false, defval: '' }))
    expect(container.querySelector('.file-sheet.on')?.textContent).toBe('第二页')
  })

  test('单 sheet：不画页签条，直接出表', async () => {
    xlsx.read.mockReturnValueOnce({ SheetNames: ['only'], Sheets: { only: {} } })
    const { container } = render(<XlsxView base64={btoa('y')} />)
    await waitFor(() => expect(container.querySelector('.file-table')).not.toBeNull())
    expect(container.querySelector('.file-sheets')).toBeNull()
  })

  test('工作簿里没有这个 sheet：给空表而不炸', async () => {
    xlsx.read.mockReturnValueOnce({ SheetNames: ['gone'], Sheets: {} })
    const { container } = render(<XlsxView base64={btoa('z')} />)
    await waitFor(() => expect(container.querySelector('.file-table')).not.toBeNull())
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0)
  })

  test('读取抛错：失败占位带原因', async () => {
    xlsx.read.mockImplementationOnce(() => {
      throw new Error('不是表格')
    })
    const { container } = render(<XlsxView base64={btoa('w')} />)
    await waitFor(() => expect(container.querySelector('.file-preview-empty')?.textContent).toContain('不是表格'))
  })

  test('非 Error 抛出：String 化后仍能显示', async () => {
    xlsx.read.mockImplementationOnce(() => {
      throw 404
    })
    const { container } = render(<XlsxView base64={btoa('v')} />)
    await waitFor(() => expect(container.querySelector('.file-preview-empty')?.textContent).toContain('404'))
  })
})

// ── 拖拽状态机（panels.ts 的 useWidthDrag）──────────────────────────────────

/** 叫一个 React 处理器；参数只给状态机读到的字段。 */
function pointerEvent(
  currentTarget: HTMLElement,
  fields: { button?: number; pointerId?: number; clientX?: number; clientY?: number },
): Record<string, unknown> {
  return {
    button: 0,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    preventDefault: vi.fn(),
    currentTarget,
    relatedTarget: null,
    ...fields,
  }
}

describe('panels.ts：useWidthDrag 的四条事件出口', () => {
  let rafCallbacks: FrameRequestCallback[]
  let node: HTMLDivElement

  beforeEach(() => {
    rafCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    node = document.createElement('div')
    document.body.appendChild(node)
    Object.defineProperty(node, 'hasPointerCapture', { configurable: true, value: () => true })
    Object.defineProperty(node, 'setPointerCapture', { configurable: true, value: vi.fn() })
    Object.defineProperty(node, 'releasePointerCapture', { configurable: true, value: vi.fn() })
    Object.defineProperty(node, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(0, 100, 200, 400),
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    node.remove()
    document.body.classList.remove('resizing')
  })

  test('左键按下 → 移动一帧 → 松手落盘；拖动期间 body 挂 resizing', () => {
    const onDrag = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() =>
      useWidthDrag({
        getBase: () => 300,
        sign: 2,
        clamp: (px) => Math.min(Math.max(px, 200), 600),
        onDrag,
        onCommit,
        trackPointerY: true,
      }),
    )
    ;(result.current.onPointerDown as unknown as (event: unknown) => void)(pointerEvent(node, { clientX: 100 }))
    expect(node.hasAttribute('data-dragging')).toBe(true)
    expect(document.body.classList.contains('resizing')).toBe(true)
    expect(node.setPointerCapture).toHaveBeenCalled()

    ;(result.current.onPointerMove as unknown as (event: unknown) => void)(pointerEvent(node, { clientX: 140, clientY: 300 }))
    expect(onDrag).not.toHaveBeenCalled() // 先攒到一帧
    rafCallbacks.shift()?.(0)
    expect(onDrag).toHaveBeenCalledWith(380)
    expect(node.style.getPropertyValue('--dsc-handle-y')).toBe('50%')

    ;(result.current.onPointerUp as unknown as (event: unknown) => void)(pointerEvent(node, { clientX: 150 }))
    expect(onCommit).toHaveBeenCalledWith(400)
    expect(node.hasAttribute('data-dragging')).toBe(false)
    expect(document.body.classList.contains('resizing')).toBe(false)
  })

  test('非左键不抓；移动没抓指针时忽略；未拖动时松手不落盘', () => {
    const onDrag = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() =>
      useWidthDrag({ getBase: () => 300, sign: 1, clamp: (px) => px, onDrag, onCommit }),
    )
    const down = result.current.onPointerDown as unknown as (event: unknown) => void
    const move = result.current.onPointerMove as unknown as (event: unknown) => void
    const up = result.current.onPointerUp as unknown as (event: unknown) => void
    down(pointerEvent(node, { button: 2 }))
    expect(node.hasPointerCapture).toBeDefined()
    expect(document.body.classList.contains('resizing')).toBe(false)
    move(pointerEvent(node, { clientX: 50 }))
    expect(rafCallbacks).toHaveLength(0)
    up(pointerEvent(node, { clientX: 50 }))
    expect(onCommit).not.toHaveBeenCalled()
  })

  test('指针捕获丢了：移动被忽略', () => {
    const onDrag = vi.fn()
    Object.defineProperty(node, 'hasPointerCapture', { configurable: true, value: () => false })
    const { result } = renderHook(() =>
      useWidthDrag({ getBase: () => 300, sign: 1, clamp: (px) => px, onDrag, onCommit: vi.fn() }),
    )
    ;(result.current.onPointerDown as unknown as (event: unknown) => void)(pointerEvent(node, { clientX: 10 }))
    ;(result.current.onPointerMove as unknown as (event: unknown) => void)(pointerEvent(node, { clientX: 90 }))
    expect(rafCallbacks).toHaveLength(0)
    expect(onDrag).not.toHaveBeenCalled()
  })

  test('按下没拖动就松手：不覆盖存档（moved=false）', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() =>
      useWidthDrag({ getBase: () => 300, sign: 1, clamp: (px) => px, onDrag: vi.fn(), onCommit }),
    )
    ;(result.current.onPointerDown as unknown as (event: unknown) => void)(pointerEvent(node, { clientX: 99 }))
    ;(result.current.onPointerUp as unknown as (event: unknown) => void)(pointerEvent(node, { clientX: 99 }))
    expect(onCommit).not.toHaveBeenCalled()
  })

  test('取消：回到基准宽度并释放拖动状态', () => {
    const onDrag = vi.fn()
    const { result } = renderHook(() =>
      useWidthDrag({ getBase: () => 420, sign: -1, clamp: (px) => px, onDrag, onCommit: vi.fn() }),
    )
    ;(result.current.onPointerDown as unknown as (event: unknown) => void)(pointerEvent(node, { clientX: 100 }))
    ;(result.current.onPointerCancel as unknown as (event: unknown) => void)(pointerEvent(node, { clientX: 100 }))
    expect(onDrag).toHaveBeenCalledWith(420)
    expect(node.hasAttribute('data-dragging')).toBe(false)
    // 未拖动时取消是空操作。
    ;(result.current.onPointerCancel as unknown as (event: unknown) => void)(pointerEvent(node, {}))
    expect(onDrag).toHaveBeenCalledTimes(1)
  })

  test('trackPointerY 默认不写；高度为 0 时落点按 50%；比例夹在 10%–90%', () => {
    const { result } = renderHook(() =>
      useWidthDrag({ getBase: () => 300, sign: 1, clamp: (px) => px, onDrag: vi.fn(), onCommit: vi.fn() }),
    )
    ;(result.current.onPointerDown as unknown as (event: unknown) => void)(pointerEvent(node, { clientX: 0 }))
    ;(result.current.onPointerMove as unknown as (event: unknown) => void)(pointerEvent(node, { clientX: 5, clientY: 200 }))
    expect(node.style.getPropertyValue('--dsc-handle-y')).toBe('')

    cleanup()
    const flat = document.createElement('div')
    document.body.appendChild(flat)
    Object.defineProperty(flat, 'hasPointerCapture', { configurable: true, value: () => true })
    Object.defineProperty(flat, 'setPointerCapture', { configurable: true, value: vi.fn() })
    Object.defineProperty(flat, 'releasePointerCapture', { configurable: true, value: vi.fn() })
    Object.defineProperty(flat, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0, 0, 10, 0) })
    const second = renderHook(() =>
      useWidthDrag({ getBase: () => 300, sign: 1, clamp: (px) => px, onDrag: vi.fn(), onCommit: vi.fn(), trackPointerY: true }),
    )
    ;(second.result.current.onPointerDown as unknown as (event: unknown) => void)(pointerEvent(flat, { clientX: 0 }))
    ;(second.result.current.onPointerMove as unknown as (event: unknown) => void)(pointerEvent(flat, { clientX: 1, clientY: 999 }))
    expect(flat.style.getPropertyValue('--dsc-handle-y')).toBe('50%')
    // 换成有高度的盒子：落点比例要夹在 10%–90%。
    Object.defineProperty(flat, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0, 100, 10, 400) })
    ;(second.result.current.onPointerMove as unknown as (event: unknown) => void)(pointerEvent(flat, { clientX: 2, clientY: 1000 }))
    expect(flat.style.getPropertyValue('--dsc-handle-y')).toBe('90%')
    ;(second.result.current.onPointerMove as unknown as (event: unknown) => void)(pointerEvent(flat, { clientX: 3, clientY: -999 }))
    expect(flat.style.getPropertyValue('--dsc-handle-y')).toBe('10%')
    flat.remove()
  })
})

// ── ThreadResizer 的量算分支 ─────────────────────────────────────────────────

class ObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('thread-resizer.tsx：量算三条路（有输入区 / 无输入区 / 无正文列）', () => {
  const stubRect = (element: HTMLElement, rect: DOMRect): void => {
    Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => rect })
  }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ObserverStub)
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (): string => '' }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  test('有输入区与正文列：写列缘与把手底边两个变量', () => {
    const { container } = render(
      <div className="thread-zone">
        <div className="chat-inner" />
        <div className="composer-zone" />
        <ThreadResizer width={null} onCommit={vi.fn()} onReset={vi.fn()} />
      </div>,
    )
    const zone = container.querySelector('.thread-zone') as HTMLElement
    const column = container.querySelector('.chat-inner') as HTMLElement
    const dock = container.querySelector('.composer-zone') as HTMLElement
    stubRect(zone, new DOMRect(0, 0, 1000, 800))
    stubRect(column, new DOMRect(100, 0, 800, 800))
    stubRect(dock, new DOMRect(0, 600, 1000, 200))
    // 挂载时 effect 已跑过一次（此时矩形还是 jsdom 的全 0）；再借窗口 resize 触一次重量。
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(zone.style.getPropertyValue('--dsc-thread-col-start')).toBe('100px')
    expect(zone.style.getPropertyValue('--dsc-thread-col-end')).toBe('900px')
    expect(zone.style.getPropertyValue('--dsc-thread-handle-bottom')).toBe('200px')
  })

  test('没有输入区：撤掉把手底边变量，退回铺满整层', () => {
    const { container } = render(
      <div className="thread-zone">
        <div className="chat-inner" />
        <ThreadResizer width={null} onCommit={vi.fn()} onReset={vi.fn()} />
      </div>,
    )
    const zone = container.querySelector('.thread-zone') as HTMLElement
    stubRect(zone, new DOMRect(0, 0, 1000, 800))
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(zone.style.getPropertyValue('--dsc-thread-handle-bottom')).toBe('')
  })

  test('输入区高度为 0：同样撤掉变量', () => {
    const { container } = render(
      <div className="thread-zone">
        <div className="chat-inner" />
        <div className="composer-zone" />
        <ThreadResizer width={null} onCommit={vi.fn()} onReset={vi.fn()} />
      </div>,
    )
    const zone = container.querySelector('.thread-zone') as HTMLElement
    const dock = container.querySelector('.composer-zone') as HTMLElement
    stubRect(zone, new DOMRect(0, 0, 1000, 800))
    stubRect(dock, new DOMRect(0, 600, 1000, 0))
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(zone.style.getPropertyValue('--dsc-thread-handle-bottom')).toBe('')
  })

  test('没有正文列：底边照写，列缘变量不写；双击交给 onReset', () => {
    const onReset = vi.fn()
    const { container } = render(
      <div className="thread-zone">
        <div className="composer-zone" />
        <ThreadResizer width={null} onCommit={vi.fn()} onReset={onReset} />
      </div>,
    )
    const zone = container.querySelector('.thread-zone') as HTMLElement
    const dock = container.querySelector('.composer-zone') as HTMLElement
    stubRect(zone, new DOMRect(0, 0, 1000, 800))
    stubRect(dock, new DOMRect(0, 700, 1000, 100))
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(zone.style.getPropertyValue('--dsc-thread-handle-bottom')).toBe('100px')
    expect(zone.style.getPropertyValue('--dsc-thread-col-start')).toBe('')
    fireEvent.doubleClick(container.querySelector('.thread-handle') as HTMLElement)
    expect(onReset).toHaveBeenCalled()
  })
})

// ── 工具摘要的兜底与边界 ─────────────────────────────────────────────────────

describe('tool-summary.ts：摘要的兜底字段与格式化', () => {
  test('oneLine：换行压空格、按码点截断（代理对不劈开）', () => {
    expect(oneLine(' a\n\tb  c ', 20)).toBe('a b c')
    expect(oneLine('🙂🙂🙂🙂', 2)).toBe('🙂🙂…')
    expect(oneLine('short', 10)).toBe('short')
  })

  test('shortUrl：合法 URL 取主机；坏 URL 原样返回', () => {
    expect(shortUrl('https://example.com/a/b?q=1')).toBe('example.com')
    expect(shortUrl('not a url')).toBe('not a url')
  })

  test('非法 JSON 与 JSON 标量：前者原文压行，后者空摘要', () => {
    expect(toolSummary('bash', '{"command": "git sta')).toBe('{"command": "git sta')
    expect(toolSummary('bash', '42')).toBe('')
    expect(toolSummary('bash', 'null')).toBe('')
  })

  test('已知工具取两个字段；空字段跳过；url 只留主机名', () => {
    expect(toolSummary('read', JSON.stringify({ path: '/a', file_path: '/b' }))).toBe('/b · /a')
    expect(toolSummary('bash', JSON.stringify({ command: '', description: '跑测试' }))).toBe('跑测试')
    expect(toolSummary('webfetch', JSON.stringify({ url: 'https://docs.example.com/x' }))).toBe('docs.example.com')
  })

  test('字段表没命中：兜底取参数里第一个非空字符串', () => {
    expect(toolSummary('unknown_tool', JSON.stringify({ count: 2, note: '第一条', other: '第二条' }))).toBe('第一条')
  })

  test('run_code 的 code：跳过空行与行首注释；全是注释时退回原文一行', () => {
    expect(toolSummary('run_code', JSON.stringify({ code: '\n  // 说明\nconst x = 1' }))).toBe('说明')
    expect(toolSummary('run_code', JSON.stringify({ code: '// 只有注释' }))).toBe('只有注释')
  })

  test('对象里没有任何字符串：空摘要（不印「工具调用 · 」半截）', () => {
    expect(toolSummary('unknown_tool', JSON.stringify({ n: 1, ok: true }))).toBe('')
  })

  test('prettyJson：合法格式化、非法原样返回', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyJson('{oops')).toBe('{oops')
  })

  test('matchTool：精确名 / 前缀族 / 未知三档', () => {
    expect(matchTool('bash').known).toBe(true)
    expect(matchTool('bash').base).toBe(KNOWN_TOOLS['bash']?.verb)
    const ops = matchTool('ops_read_table')
    expect(ops.known).toBe(false)
    expect(ops.base).toBeTruthy()
    expect(matchTool('mcp__server__tool').Icon).toBeDefined()
    expect(matchTool('nothing_here').Icon).toBe(UNKNOWN_TOOL_ICON)
    expect(matchTool('nothing_here').base).toBe(UNKNOWN_TOOL_TITLE)
  })

  test('名册口径：默认字段、状态词、标题不随状态变形', () => {
    expect(DEFAULT_FIELDS).toContain('command')
    expect(SUMMARY_FIELDS['job_output']).toContain('job_id')
    expect(TOOL_STATUS_TEXT['aborted']).toBeTruthy()
    expect(toolVerb('读取', 'running')).toBe('读取')
    expect(toolVerb('读取', 'failed')).toBe('读取')
  })
})

// ── token / 成本读数 ────────────────────────────────────────────────────────

describe('tokens.ts：K/M 缩写与金额口径的边界', () => {
  test('trimZero：整数档去小数，十位以下留一位', () => {
    expect(trimZero(46)).toBe('46')
    expect(trimZero(1)).toBe('1')
    expect(trimZero(1.25)).toBe('1.3')
  })

  test('formatTokens：0 / 负 / 非有限 / 千以下 / K / M', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(-3)).toBe('0')
    expect(formatTokens(Number.NaN)).toBe('0')
    expect(formatTokens(999.6)).toBe('1000')
    expect(formatTokens(1_000)).toBe('1K')
    expect(formatTokens(1_200)).toBe('1.2K')
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(formatTokens(999_999)).toBe('1000K')
  })

  test('formatCostCny：零 / 不足一分 / 两位小数', () => {
    expect(formatCostCny(0)).toBe('¥0.00')
    expect(formatCostCny(Number.NaN)).toBe('¥0.00')
    expect(formatCostCny(0.004)).toBe('<¥0.01')
    expect(formatCostCny(0.005)).toBe('¥0.01')
    expect(formatCostCny(12.345)).toBe('¥12.35')
  })
})

// ── 六个转出口与 select 的剩余分支 ──────────────────────────────────────────

describe('转出口（error-text / git-surface / signal / throughput / unified-diff / plugin-text）', () => {
  test('errText：Error 取 message，非 Error String 化', () => {
    expect(errText(new Error('boom'))).toBe('boom')
    expect(errText('text')).toBe('text')
  })

  test('sameGitSurface：四个字段逐项比较', () => {
    const base = { repo: true, branch: 'main', detached: false, dirtyFileCount: 2 }
    expect(sameGitSurface(base, { ...base })).toBe(true)
    expect(sameGitSurface(base, { ...base, dirtyFileCount: 3 })).toBe(false)
    expect(sameGitSurface(base, { ...base, detached: true })).toBe(false)
  })

  test('createSignal：set 才判等，notify 强制通知，退订后不再收', () => {
    const signal = createSignal(1)
    const listener = vi.fn()
    const off = signal.subscribe(listener)
    signal.set(2)
    expect(signal.get()).toBe(2)
    expect(listener).toHaveBeenCalledTimes(1)
    signal.set(2)
    expect(listener).toHaveBeenCalledTimes(1)
    signal.notify()
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    signal.set(3)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  test('throughput：零分母给 null，有值给读数；速度格式按 10 分档', () => {
    expect(tokensPerSecond({ decodeMs: 0, decodeTokens: 10 })).toBeNull()
    expect(tokensPerSecond({ decodeMs: 1_000, decodeTokens: 50 })).toBe(50)
    expect(averageTtftMs({ ttftMs: 100, ttftSteps: 0 })).toBeNull()
    expect(averageTtftMs({ ttftMs: 300, ttftSteps: 2 })).toBe(150)
    expect(formatTokensPerSecond(8.44)).toBe('8.4')
    expect(formatTokensPerSecond(12.6)).toBe('13')
    expect(formatTokensPerSecond(-2)).toBe('0')
  })

  test('unified-diff：解析 hunk 与按文件拆分', () => {
    const text = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' same',
      'diff --git a/y.ts b/y.ts',
      '--- a/y.ts',
      '+++ b/y.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n')
    const hunks = parseUnifiedDiff(text)
    expect(hunks.length).toBeGreaterThanOrEqual(2)
    const files = splitUnifiedDiffByFile(text)
    expect(files.length).toBe(2)
    expect(files[0]?.path).toContain('x.ts')
  })

  test('Text 基元：画 span 并透传 className / children', () => {
    const { container } = render(<Text className="t">一段</Text>)
    expect(container.querySelector('span.t')?.textContent).toBe('一段')
  })
})

describe('select.tsx：displayLabel、空清单、浮层外点击与键盘边界', () => {
  beforeAll(() => {
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined
  })

  test('displayLabel 覆盖派生值；空清单点开不弹浮层', () => {
    const onPick = vi.fn()
    const { container } = render(
      <Select value="custom" displayLabel="自定义" options={[]} onPick={onPick} />,
    )
    expect(container.querySelector('.select-value')?.textContent).toBe('自定义')
    fireEvent.click(container.querySelector('.select-trigger') as HTMLElement)
    expect(document.querySelector('.select-pop')).toBeNull()
  })

  test('打开后点浮层外收起；Escape 只收浮层；Tab 收起不抢焦点', () => {
    const onPick = vi.fn()
    const { container } = render(
      <Select
        value="a"
        options={[
          { value: 'a', label: '甲' },
          { value: 'b', label: '乙' },
        ]}
        onPick={onPick}
      />,
    )
    const trigger = container.querySelector('.select-trigger') as HTMLElement
    fireEvent.click(trigger)
    expect(document.querySelector('.select-pop')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(document.querySelector('.select-pop')).toBeNull()

    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(document.querySelector('.select-pop')).toBeNull()

    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(document.querySelector('.select-pop')).toBeNull()

    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'End' })
    expect(document.querySelector('.select-opt[data-active="true"]')?.textContent).toContain('乙')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(document.querySelector('.select-opt[data-active="true"]')?.textContent).toContain('乙')
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    expect(document.querySelector('.select-opt[data-active="true"]')?.textContent).toContain('甲')
    fireEvent.keyDown(trigger, { key: 'Home' })
    expect(document.querySelector('.select-opt[data-active="true"]')?.textContent).toContain('甲')
    // 点已选中项：不回调 onPick，但仍收起。
    fireEvent.click(document.querySelectorAll('.select-opt')[0] as HTMLElement)
    expect(onPick).not.toHaveBeenCalled()
    expect(document.querySelector('.select-pop')).toBeNull()
  })

  test('未打开时的空格/上下键会打开；指针移入候选项跟着高亮', () => {
    const onPick = vi.fn()
    const { container } = render(
      <Select
        value="a"
        ariaLabel="选一个"
        options={[
          { value: 'a', label: '甲' },
          { value: 'b', label: '乙' },
        ]}
        onPick={onPick}
      />,
    )
    const trigger = container.querySelector('.select-trigger') as HTMLElement
    fireEvent.keyDown(trigger, { key: ' ' })
    expect(document.querySelector('.select-pop')).not.toBeNull()
    fireEvent.pointerEnter(document.querySelectorAll('.select-opt')[1] as HTMLElement)
    expect(document.querySelector('.select-opt[data-active="true"]')?.textContent).toContain('乙')
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('b')
  })
})
