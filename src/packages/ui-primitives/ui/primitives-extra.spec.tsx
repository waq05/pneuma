/**
 * 基元包的补测（ui 层，真渲染）：已有 spec 没铺到的格式化口径、快照读数、原生桥、
 * 骨架屏、Toast / Confirm、弹层焦点、下拉选择、差异行 / 代码视图 / 表格视图与
 * markdown 的本地路径判定。
 *
 * 挂载方式沿用本包既有 spec：`@testing-library/react` 真渲染，jsdom 缺的
 * `scrollIntoView` / `offsetParent` 在文件里补桩；高亮模块用 `vi.mock` 替身，
 * 避免为了测渲染去装载 shiki 语法。
 *
 * @module dsc-ui-primitives/ui/primitives-extra.spec
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useDialogFocus } from './dialog-focus.js'
import { Select } from './select.js'
import { confirmAction } from './confirm.js'
import { toastErr, toastOk, toastOkAction } from './toast.js'
import { LoadingStatus, Skeleton, SkeletonText } from './skeleton.js'
import { entryTs, formatClock, formatClockSeconds, formatDuration, formatTraceDuration } from './time.js'
import { baseNameOf, displayPathOf, joinPath } from './paths.js'
import {
  NO_ENTRIES,
  NO_SESSIONS,
  readCompactingSince,
  readCwd,
  readEntries,
  readLive,
  readSessionId,
  readSessions,
  readSessionPath,
  readTurnState,
} from './snapshot.js'
import { getHostNative, NATIVE_UNAVAILABLE } from './native.js'
import { DiffRows } from './diff-rows.js'
import { CodeView } from './code-view.js'
import { CsvView } from './table-view.js'
import { isLocalFilePath, isRelativeFilePath } from './markdown.js'
import type { DiffHunkView, HostSnapshot, TranscriptEntry } from '@dsc/ui-core'
import zh from '../locale/ui.zh.json'

const highlightMock = vi.hoisted(() => ({
  lines: vi.fn(),
  html: vi.fn(),
  lang: vi.fn(() => 'typescript'),
}))

vi.mock('./highlight', () => ({
  highlightLines: highlightMock.lines,
  highlightToHtml: highlightMock.html,
  langForPath: highlightMock.lang,
}))

beforeAll(() => {
  // jsdom 没有布局：滚动与可聚焦判定都要补一个最小替身。
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return this.parentElement
    },
  })
})

beforeEach(() => {
  document.body.innerHTML = ''
  highlightMock.lines.mockReset()
  highlightMock.html.mockReset()
  highlightMock.lang.mockReset()
  highlightMock.lang.mockReturnValue('typescript')
  highlightMock.lines.mockResolvedValue(null)
  highlightMock.html.mockResolvedValue(
    '<span class="line">a\n</span><span class="line">b\n</span><span class="line">c\n</span>',
  )
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  document.body.innerHTML = ''
  delete (globalThis as { dscNative?: unknown }).dscNative
})

describe('时间口径（time.ts）', () => {
  test('缺失 / 非有限 / 非正数都判成没有；时钟按本机时区补零，秒档到秒', () => {
    const at = new Date(2024, 0, 2, 3, 4, 5).getTime()
    expect(entryTs(undefined)).toBeNull()
    expect(entryTs({ kind: 'user', id: 1, text: 'x', ts: 0 })).toBeNull()
    expect(entryTs({ kind: 'user', id: 1, text: 'x', ts: Number.NaN })).toBeNull()
    expect(entryTs({ kind: 'user', id: 1, text: 'x', ts: at })).toBe(at)

    expect(formatClock(null)).toBeNull()
    expect(formatClock(0)).toBeNull()
    expect(formatClock(at)).toBe('03:04')
    expect(formatClockSeconds(at)).toBe('03:04:05')
    expect(formatClockSeconds(Number.NaN)).toBeNull()
  })

  test('耗时：不足 1 秒也写 1 秒；分 / 时档；轨迹口径先四舍五入到 0.1 秒', () => {
    expect(formatDuration(null)).toBeNull()
    expect(formatDuration(-1)).toBeNull()
    expect(formatDuration(400)).toBe('1秒')
    expect(formatDuration(61_000)).toBe('1分1秒')
    expect(formatDuration(3_725_000)).toBe('1时02分05秒')

    expect(formatTraceDuration(undefined)).toBeNull()
    expect(formatTraceDuration(Number.NaN)).toBeNull()
    expect(formatTraceDuration(4_200)).toBe('4.2s')
    expect(formatTraceDuration(59_960)).toBe('1m00s')
    expect(formatTraceDuration(3_600_000)).toBe('1h00m')
  })
})

describe('路径与快照读数（paths.ts / snapshot.ts）', () => {
  test('cwd 内相对、相等给 .、home 给 ~；大小写与两种分隔符都认', () => {
    expect(displayPathOf('', 'D:/demo')).toBe('')
    expect(displayPathOf('D:\\demo\\src\\a.ts', 'd:\\demo')).toBe('src/a.ts')
    expect(displayPathOf('D:/demo', 'D:/demo')).toBe('.')
    expect(displayPathOf('C:\\Users\\me\\x', '', 'c:\\users\\me')).toBe('~/x')
    expect(displayPathOf('/tmp', '', '/tmp')).toBe('~')
    expect(displayPathOf('/other/x', 'D:/demo', '/tmp')).toBe('/other/x')
    expect(baseNameOf('D:\\a\\b.ts')).toBe('b.ts')
    expect(joinPath('D:\\demo', 'a.ts')).toBe('D:\\demo\\a.ts')
    expect(joinPath('D:\\demo\\', 'a.ts')).toBe('D:\\demo\\a.ts')
  })

  test('快照缺失共用空表（引用稳定）；字段类型不对按缺省；会话短名剥掉 .jsonl', () => {
    expect(readCwd(null)).toBeNull()
    expect(readSessionPath(null)).toBeNull()
    expect(readTurnState(null)).toBe('idle')
    expect(readCompactingSince(null)).toBeNull()
    expect(readSessions(null)).toBe(NO_SESSIONS)
    expect(readEntries(null)).toBe(NO_ENTRIES)
    expect(readLive(null)).toBe(NO_ENTRIES)
    expect(readSessionId(null)).toBeNull()

    const snapshot = {
      status: {
        cwd: 'D:/demo',
        sessionPath: 'D:/demo/abc.jsonl',
        turnState: 'working',
        compactingSince: 123,
      },
      sessions: [{ id: 'D:/demo/a.jsonl', cwd: 'D:/demo', createdAt: 1, updatedAt: 2 }],
      entries: [{ kind: 'user', id: 1, text: 'x' }],
      liveEntries: [{ kind: 'user', id: 2, text: 'y' }],
    } as unknown as HostSnapshot
    expect(readCwd(snapshot)).toBe('D:/demo')
    expect(readSessionPath(snapshot)).toBe('D:/demo/abc.jsonl')
    expect(readTurnState(snapshot)).toBe('working')
    expect(readCompactingSince(snapshot)).toBe(123)
    expect(readSessions(snapshot)).toHaveLength(1)
    expect(readEntries(snapshot)).toHaveLength(1)
    expect(readLive(snapshot)).toHaveLength(1)
    expect(readSessionId(snapshot)).toBe('abc')
    expect(readSessionId({ status: { sessionPath: 'D:/a/plain' } } as unknown as HostSnapshot)).toBe('plain')
    expect(readSessionId({ status: { sessionPath: '' } } as unknown as HostSnapshot)).toBeNull()
    expect(readTurnState({ status: { turnState: 7 } } as unknown as HostSnapshot)).toBe('idle')
    expect(readCompactingSince({ status: { compactingSince: 'x' } } as unknown as HostSnapshot)).toBeNull()
  })
})

describe('原生桥（native.ts）', () => {
  test('桥缺席：available=false、version=null、invoke 拒绝、on 给空退订', async () => {
    const native = getHostNative()
    expect(native.available).toBe(false)
    expect(native.version).toBeNull()
    await expect(native.invoke('openPath', ['D:\\dsc'])).rejects.toThrow(NATIVE_UNAVAILABLE)
    expect(typeof native.on('dock-data', () => undefined)).toBe('function')
  })

  test('桥在位：版本透传（缺失回落协议版）、操作与实参原样转、on 委托给桥', async () => {
    const call = vi.fn(async () => ({ ok: true }))
    const on = vi.fn(() => () => undefined)
    ;(globalThis as { dscNative?: unknown }).dscNative = { version: 9, call, on }
    const native = getHostNative()
    expect(native.available).toBe(true)
    expect(native.version).toBe(9)
    await expect(native.invoke('openPath', ['D:\\dsc'])).resolves.toEqual({ ok: true })
    expect(call).toHaveBeenCalledWith('openPath', ['D:\\dsc'])
    const listener = vi.fn()
    native.on('dock-data', listener)
    expect(on).toHaveBeenCalledWith('dock-data', listener)

    ;(globalThis as { dscNative?: unknown }).dscNative = { call, on }
    expect(getHostNative().version).toBe(3)
  })
})

describe('骨架屏（skeleton.tsx）', () => {
  test('默认一条块；文本占位最后一行 62%；读屏状态行藏视觉、带 aria-live', () => {
    const { container } = render(<Skeleton />)
    const one = container.querySelector('.dsc-skeleton') as HTMLElement
    expect(one.getAttribute('aria-hidden')).toBe('true')
    expect(one.style.width).toBe('100%')
    expect(one.style.height).toBe('12px')
    expect(one.style.borderRadius).toBe('6px')

    const { container: second } = render(<SkeletonText lines={3} widths={['80%', '70%']} />)
    const blocks = [...second.querySelectorAll('.dsc-skeleton')] as HTMLElement[]
    expect(blocks).toHaveLength(3)
    expect(blocks[0]?.style.width).toBe('80%')
    expect(blocks[1]?.style.width).toBe('70%')
    expect(blocks[2]?.style.width).toBe('62%')

    const { container: third } = render(<LoadingStatus label="正在读取分区" />)
    const status = third.querySelector('.dsc-loading-status') as HTMLElement
    expect(status.getAttribute('role')).toBe('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('正在读取分区')
  })
})

describe('Toast 与 Confirmation（toast.ts / confirm.ts）', () => {
  test('成功提示自动消失；带动作的提示点了执行并把这条收掉', () => {
    vi.useFakeTimers()
    toastOk('保存成功')
    const ok = document.querySelector('.dsc-toast') as HTMLElement
    expect(ok.dataset['tone']).toBe('success')
    expect(ok.textContent).toContain('保存成功')
    act(() => {
      vi.advanceTimersByTime(2_500)
    })
    expect(document.querySelector('.dsc-toast')).toBeNull()

    const run = vi.fn()
    toastOkAction('会话已归档', [
      { label: '撤销', run },
      { label: '筛选已归档会话', run: () => undefined },
    ])
    const action = document.querySelector('.dsc-toast__act') as HTMLElement
    expect(action.textContent).toBe('撤销')
    // 两颗动作之间有「或」，不会读成一件连续的事。
    expect(document.querySelector('.dsc-toast__sep')?.textContent).toBe(zh['primitives.toast.or'])
    fireEvent.click(action)
    expect(run).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(document.querySelector('.dsc-toast')).toBeNull()
  })

  test('失败提示带关闭钮；堆满 4 条后成功提示不许挤掉失败那条', () => {
    vi.useFakeTimers()
    toastErr('操作失败')
    const danger = document.querySelector('.dsc-toast[data-tone="danger"]') as HTMLElement
    expect(danger.querySelector('.dsc-toast__close')).toBeTruthy()
    for (let index = 0; index < 4; index += 1) toastOk('好')
    expect(document.querySelector('.dsc-toast[data-tone="danger"]')).toBeTruthy()
    expect(document.querySelectorAll('.dsc-toast')).toHaveLength(5)
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
  })

  test('确认框：默认焦点在取消、危险档主按钮走 destructive；确认/取消/Esc/遮罩四条路', async () => {
    const proceedPromise = confirmAction({ title: '归档？', detail: '可恢复', confirmLabel: '归档', danger: true })
    const overlay = document.querySelector('.dsc-confirm') as HTMLElement
    expect(document.activeElement?.textContent).toBe('取消')
    const buttons = [...overlay.querySelectorAll('button')] as HTMLElement[]
    const proceed = buttons.find((button) => button.textContent === '归档') as HTMLElement
    expect(proceed.dataset['variant']).toBe('destructive')
    fireEvent.click(proceed)
    await expect(proceedPromise).resolves.toBe(true)
    expect(document.querySelector('.dsc-confirm')).toBeNull()

    const cancelPromise = confirmAction({ title: '取消？', detail: '说明', confirmLabel: '好' })
    fireEvent.click(document.querySelector('.dsc-confirm .dsc-confirm__actions button') as HTMLElement)
    await expect(cancelPromise).resolves.toBe(false)

    const escapePromise = confirmAction({ title: 'Esc？', detail: '说明', confirmLabel: '好' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await expect(escapePromise).resolves.toBe(false)

    const backdropPromise = confirmAction({ title: '遮罩？', detail: '说明', confirmLabel: '好' })
    const backdrop = document.querySelector('.dsc-confirm') as HTMLElement
    fireEvent.pointerDown(backdrop)
    await expect(backdropPromise).resolves.toBe(false)
  })

  test('后到的确认框把前一张判取消（同一时刻只挂一张）', async () => {
    const first = confirmAction({ title: '第一张', detail: '说明', confirmLabel: '好' })
    const second = confirmAction({ title: '第二张', detail: '说明', confirmLabel: '好' })
    await expect(first).resolves.toBe(false)
    expect(document.querySelectorAll('.dsc-confirm')).toHaveLength(1)
    fireEvent.click(document.querySelector('.dsc-confirm__actions button:last-child') as HTMLElement)
    await expect(second).resolves.toBe(true)
  })
})

describe('弹层焦点（dialog-focus.ts）与下拉选择（select.tsx）', () => {
  test('打开聚焦第一项，Tab / Shift+Tab 在弹层内循环，Esc 交给 onClose 并归还焦点', () => {
    const onClose = vi.fn()
    function Dialog({ active }: { active: boolean }): React.ReactNode {
      const { ref } = useDialogFocus(active, onClose)
      return (
        <div ref={ref} data-testid="dialog">
          <button type="button">一</button>
          <button type="button">二</button>
        </div>
      )
    }
    const trigger = document.createElement('button')
    trigger.textContent = '触发器'
    document.body.appendChild(trigger)
    trigger.focus()
    const { rerender } = render(<Dialog active={false} />)
    rerender(<Dialog active />)
    const dialog = document.querySelector('[data-testid="dialog"]') as HTMLElement
    expect(document.activeElement?.textContent).toBe('一')
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement?.textContent).toBe('二')
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement?.textContent).toBe('一')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(<Dialog active={false} />)
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  test('下拉：打开列选项、键盘 Home/Enter 选中并关闭、Escape 只收浮层、disabled 不开', () => {
    const onPick = vi.fn()
    const { rerender } = render(
      <Select
        value="b"
        ariaLabel="选择"
        options={[
          { value: 'a', label: '甲' },
          { value: 'b', label: '乙' },
        ]}
        onPick={onPick}
      />,
    )
    const trigger = document.querySelector('.select-trigger') as HTMLElement
    expect(trigger.textContent).toContain('乙')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const options = [...document.querySelectorAll('.select-opt')] as HTMLElement[]
    expect(options).toHaveLength(2)
    expect(options[1]?.getAttribute('data-selected')).toBe('true')
    fireEvent.keyDown(trigger, { key: 'Home' })
    expect(document.querySelector('.select-opt[data-active="true"]')?.textContent).toContain('甲')
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('a')
    expect(document.querySelector('.select-pop')).toBeNull()

    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(document.querySelector('.select-pop')).toBeNull()

    rerender(
      <Select value="a" disabled options={[{ value: 'a', label: '甲' }]} onPick={onPick} />,
    )
    fireEvent.click(document.querySelector('.select-trigger') as HTMLElement)
    expect(document.querySelector('.select-pop')).toBeNull()
  })
})

describe('差异行、代码视图与表格视图', () => {
  test('unified：hunk 头、增删记号、纯文本回落', () => {
    const hunks: DiffHunkView[] = [
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        lines: [
          { kind: 'context', oldLine: 1, newLine: 1, text: 'same' },
          { kind: 'remove', oldLine: 2, newLine: null, text: 'old' },
          { kind: 'add', oldLine: null, newLine: 2, text: 'new' },
        ],
      },
    ]
    const { container } = render(<DiffRows hunks={hunks} path="a.txt" />)
    expect(container.querySelector('.diff-hunk-head')?.textContent).toBe('@@ -1,2 +1,2 @@')
    expect(container.querySelectorAll('.diff-line')).toHaveLength(3)
    expect(container.querySelector('.diff-del .diff-sign')?.textContent).toBe('-')
    expect(container.querySelector('.diff-add .diff-sign')?.textContent).toBe('+')
    expect(container.querySelector('.diff-ctx .diff-text')?.textContent).toBe('same')
  })

  test('split：context 左右各一份，增删按序配对，高亮 HTML 落到行内', async () => {
    highlightMock.lines.mockResolvedValue([
      { segments: ['<span style="color:#111">same</span>'] },
      { segments: ['<span style="color:#f00">old</span>'] },
      { segments: ['<span style="color:#0a0">new</span>'] },
    ])
    const hunks: DiffHunkView[] = [
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        lines: [
          { kind: 'context', oldLine: 1, newLine: 1, text: 'same' },
          { kind: 'remove', oldLine: 2, newLine: null, text: 'old' },
          { kind: 'add', oldLine: null, newLine: 2, text: 'new' },
        ],
      },
    ]
    const { container } = render(<DiffRows hunks={hunks} path="a.ts" split />)
    await waitFor(() => expect(container.querySelectorAll('.diff-split-row')).toHaveLength(2))
    const rows = [...container.querySelectorAll('.diff-split-row')]
    expect(rows[0]?.querySelectorAll('.diff-half')).toHaveLength(2)
    // 删除/新增配成同一行对：左半边 del、右半边 add（两半都带高亮产物）。
    expect(rows[1]?.querySelector('.diff-half-del')).not.toBeNull()
    expect(rows[1]?.querySelector('.diff-half-add')).not.toBeNull()
    expect(rows[1]?.innerHTML).toContain('color:#f00')
    expect(container.querySelector('.diff-body')?.getAttribute('data-split')).toBe('true')
  })

  test('代码视图：截断提示、行号/折行类、目标行高亮；高亮失败回落纯文本', async () => {
    const many = Array.from({ length: 5_001 }, (_, index) => `line${index}`).join('\n')
    const { container } = render(<CodeView text={many} path="a.ts" targetLine={2} wrap />)
    const note = container.querySelector('[data-tree-note="truncated"]')
    expect(note?.textContent).toContain('5000')
    expect(container.querySelector('.file-code--numbered')).toBeTruthy()
    expect(container.querySelector('.file-code--wrap')).toBeTruthy()
    await waitFor(() => {
      const target = container.querySelector('.file-code-line-target')
      expect(target?.textContent ?? '').toContain('b')
    })

    highlightMock.html.mockRejectedValueOnce(new Error('语法装不上'))
    const { container: plain } = render(<CodeView text={'a\nb'} path="x.unknown" />)
    await waitFor(() => expect(plain.querySelector('.file-code-plain')).not.toBeNull())
    expect(plain.querySelectorAll('.file-code-plain .line')).toHaveLength(2)
  })

  test('CSV 视图：首行当表头，超过 500 行截断并给提示', async () => {
    const csv = ['a,b', ...Array.from({ length: 500 }, (_, index) => `${index},x`)].join('\n')
    const { container } = render(<CsvView text={csv} path="a.csv" />)
    await waitFor(() => expect(container.querySelector('.file-table')).not.toBeNull(), { timeout: 5_000 })
    expect(container.querySelector('thead th')?.textContent).toBe('a')
    expect(container.querySelectorAll('tbody tr').length).toBeLessThanOrEqual(500)
    expect(container.querySelector('[data-tree-note="truncated"]')).not.toBeNull()
  })
})

describe('markdown 的本地路径判定（markdown.ts 纯函数出口）', () => {
  test('盘符 / UNC / 绝对路径与相对路径；协议、锚点、空串都不接管', () => {
    expect(isLocalFilePath('D:\\dsc\\a.ts')).toBe(true)
    expect(isLocalFilePath('D:%5Cdsc%5Ca.ts')).toBe(true)
    expect(isLocalFilePath('\\\\server\\share\\a')).toBe(true)
    expect(isLocalFilePath('/home/me/a.ts')).toBe(true)
    expect(isLocalFilePath('https://example.com')).toBe(false)
    expect(isLocalFilePath('mailto:a@b.c')).toBe(false)
    expect(isLocalFilePath('javascript:alert(1)')).toBe(false)
    expect(isLocalFilePath('')).toBe(false)

    expect(isRelativeFilePath('package.json')).toBe(true)
    expect(isRelativeFilePath('docs/a.md')).toBe(true)
    expect(isRelativeFilePath('#anchor')).toBe(false)
    expect(isRelativeFilePath('/abs/a')).toBe(false)
    expect(isRelativeFilePath('mailto:a@b.c')).toBe(false)
    expect(isRelativeFilePath('https://x.y')).toBe(false)
  })
})
