/**
 * 消息流 ui 层的边界补测（真渲染）。
 *
 * 既有 spec 已覆盖主路径；这一份只补它们没走到的那几段：
 *  - 工具卡三种视图（检索 / 读取 / 待办）的另外几种状态：空结果、没匹配、零命中文件、
 *    空文件、认不出结构回落原文、清空回执、坏状态；
 *  - 模型重试行的「已重试 / 正在重试」两态与倒计时；
 *  - 用户附件卡的四条降级路（视频有/无 url、文件有/无 url）与编辑框的取消 / 空正文 /
 *    重发三个出口；
 *  - 只读出口的审查卡与贴图浮层；
 *  - 子代理卡的徽标与可选字段，以及只读子代理条目流的空态与稳定身份；
 *  - 改动卡的「审查 / 打开」出口（走真实的 dock 布局状态，断言开出来的页签）；
 *  - 刻度条的悬停预览与点击跳轮（jsdom 几何用替身，口径同 jump-rail.spec）。
 *
 * @module dsc-ui-transcript/ui/transcript-extra.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ToolCallView, TranscriptEntry, UserFileAttachment } from '@dsc/ui'
import { dockSurface, registerDockTab, setDockSession } from '@dsc/ui-dockkit'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { clearFold, hasFold } from './fold-state.js'
import { SubagentFlow } from './subagent-flow.js'
import { JumpRail, type JumpRailRound } from './jump-rail.js'
import type { ChatViewport } from './viewport.js'
import { ChangesCard } from './rows/changes-card.js'
import { RetryRow } from './rows/retry-row.js'
import { ReadonlyUserRow, UserFileCards, UserRow } from './rows/user-row.js'
import { SubagentRow } from './rows/tool-row.js'
import { FlowActionsContext, ShellCwdContext, type FlowActions, type Row } from './shared.js'
import { SearchBody, SearchCount } from './tool-card/search-view.js'
import { ReadBody, ReadRange } from './tool-card/read-view.js'
import { TodoBody, TodoProgress } from './tool-card/todo-view.js'
import type { SearchCall, SearchResult } from './tool-card/search-model.js'
import type { ReadCall, ReadPreview } from './tool-card/read-model.js'
import type { TodoList } from './tool-card/todo-model.js'

// 展开体量高与刻度条重测都用 ResizeObserver；jsdom 没有，统一给空桩。
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)

afterEach(cleanup)

/** 测试替身宿主通道：这批卡不触发 invoke。 */
const stubChannel = (): HostChannel => ({
  getSnapshot: () => null,
  getHello: () => null,
  getStatus: () => 'open',
  getHostError: () => null,
  getPluginsFrame: () => null,
  onPlugins: () => () => undefined,
  onAsk: () => () => undefined,
  subscribe: () => () => undefined,
  invoke: () => Promise.reject(new Error('测试不触发宿主调用')),
  reconnect: () => undefined,
  close: () => undefined,
})

/** 一条工具调用（只读视图）。 */
const toolCallOf = (over: Partial<ToolCallView> = {}): ToolCallView => ({
  callId: 'call-1',
  name: 'grep',
  argsText: '{"pattern":"needle"}',
  status: 'done',
  ...over,
})

// ── 检索卡：头行读数与三种结果形态 ───────────────────────────────────────────

describe('检索卡（SearchCount / SearchBody）', () => {
  test('头行读数：空结果说「没有匹配」，文件/内容两种口径各自成句，全 0 不画', () => {
    const empty = render(<SearchCount result={{ kind: 'content', files: [], total: 0, empty: true, notes: [] }} />)
    const badge = empty.container.querySelector('[data-hit-empty="1"]') as HTMLElement
    expect(badge.textContent).toBe('没有匹配')
    empty.unmount()

    const files = render(
      <SearchCount
        result={{
          kind: 'files',
          files: [
            { path: 'a.ts', hits: [] },
            { path: 'b.ts', hits: [] },
          ],
          total: 2,
          empty: false,
          notes: [],
        }}
      />,
    )
    expect(files.container.textContent).toBe('2 个文件')
    files.unmount()

    const content = render(
      <SearchCount
        result={{
          kind: 'content',
          files: [
            { path: 'a.ts', hits: [{ line: 1, text: 'x' }] },
            { path: 'b.ts', hits: [{ line: 2, text: 'y' }] },
          ],
          total: 3,
          empty: false,
          notes: [],
        }}
      />,
    )
    expect(content.container.textContent).toBe('3 处 · 2 个文件')
    content.unmount()

    const zero = render(<SearchCount result={{ kind: 'content', files: [], total: 0, empty: false, notes: [] }} />)
    expect(zero.container.firstChild).toBeNull()
  })

  test('结果还没回来：跑动中说「正在检索」，收尾后不画一张空卡', () => {
    const search: SearchCall = { kind: 'content', pattern: 'needle', root: null }
    const running = render(
      <SearchBody call={toolCallOf({ status: 'running', resultText: undefined })} search={search} result={null} cwd="D:/demo" />,
    )
    expect(running.container.querySelector('.tc-search-note')?.textContent).toBe('正在检索')
    running.unmount()

    const done = render(
      <SearchBody call={toolCallOf({ status: 'done', resultText: undefined })} search={search} result={null} cwd="D:/demo" />,
    )
    expect(done.container.firstChild).toBeNull()
  })

  test('没有匹配：一句「没有匹配：pattern」+ 宿主尾注（跳过受保护文件这类话不能省）', () => {
    const result: SearchResult = {
      kind: 'content',
      files: [],
      total: 0,
      empty: true,
      notes: ['（已跳过 2 个受保护文件）'],
    }
    const { container } = render(
      <SearchBody
        call={toolCallOf()}
        search={{ kind: 'content', pattern: 'needle', root: null }}
        result={result}
        cwd="D:/demo"
      />,
    )
    expect(container.querySelector('.tc-search')?.getAttribute('data-search-empty')).toBe('1')
    expect(container.querySelector('.tc-search-none')?.textContent).toBe('没有匹配：needle')
    expect(container.querySelector('.tc-search-note')?.textContent).toBe('（已跳过 2 个受保护文件）')
  })

  test('有命中：文件分组、行号一列 + 内容一列；零命中的文件不画计数与清单；尾注在末尾', () => {
    const result: SearchResult = {
      kind: 'content',
      files: [
        {
          path: 'src/a.ts',
          hits: [
            { line: 12, text: 'const needle = 1' },
            { line: null, text: '续行没有行号' },
          ],
        },
        { path: 'src/b.ts', hits: [] },
      ],
      total: 2,
      empty: false,
      notes: ['（只显示前 2 条）'],
    }
    const { container } = render(
      <SearchBody
        call={toolCallOf()}
        search={{ kind: 'content', pattern: 'needle', root: null }}
        result={result}
        cwd="D:/demo"
      />,
    )
    expect(container.querySelectorAll('.tc-search-file').length).toBe(2)
    expect(container.querySelectorAll('.tc-search-hit').length).toBe(2)
    // 行号有就画、没有（null）就不画。
    expect(container.querySelector('.tc-search-line')?.textContent).toBe('12')
    expect(container.querySelectorAll('.tc-search-line').length).toBe(1)
    expect(container.querySelector('.tc-search-text')?.textContent).toBe('const needle = 1')
    // 零命中的文件只有路径，没有「N 处」读数，也没有清单。
    const heads = container.querySelectorAll('.tc-search-file-head')
    expect(heads[0]?.querySelector('.tc-search-file-count')?.textContent).toBe('2 处')
    expect(heads[1]?.querySelector('.tc-search-file-count')).toBeNull()
    expect(container.querySelector('.tc-search-note')?.textContent).toBe('（只显示前 2 条）')
  })

  test('路径按检索根拼绝对路径（不是按会话 cwd）：root=src 时点开的是 D:/demo/src/a.ts', () => {
    const { container } = render(
      <SearchBody
        call={toolCallOf({ name: 'glob' })}
        search={{ kind: 'files', pattern: '*.ts', root: 'src' }}
        result={{ kind: 'files', files: [{ path: 'a.ts', hits: [] }], total: 1, empty: false, notes: [] }}
        cwd="D:/demo"
      />,
    )
    const button = container.querySelector('.tc-path-btn') as HTMLElement
    expect(button.getAttribute('data-tc-open')).toBe('D:/demo/src/a.ts')
    expect(button.textContent).toBe('src/a.ts')
  })
})

// ── 读取卡：区间读数与四种展开体 ─────────────────────────────────────────────

describe('读取卡（ReadRange / ReadBody）', () => {
  const baseCall: ReadCall = { path: 'sample.txt', offset: 3, limit: null }

  test('头行区间：空文件、单行、区间、只有起点四种说法', () => {
    const empty = render(
      <ReadRange call={baseCall} preview={{ path: 'a', lines: [], total: null, notes: [], empty: true }} />,
    )
    const emptySpan = empty.container.querySelector('.tc-range') as HTMLElement
    expect(emptySpan.textContent).toBe('（空文件）')
    expect(emptySpan.getAttribute('title')).toBeNull()
    empty.unmount()

    const single = render(
      <ReadRange
        call={{ ...baseCall, offset: 40 }}
        preview={{ path: 'a', lines: [{ number: 40, text: '' }], total: null, notes: [], empty: false }}
      />,
    )
    expect(single.container.querySelector('.tc-range')?.textContent).toBe('第 40 行')
    single.unmount()

    const range = render(
      <ReadRange
        call={baseCall}
        preview={{
          path: 'a',
          lines: [
            { number: 40, text: '' },
            { number: 79, text: '' },
          ],
          total: 300,
          notes: [],
          empty: false,
        }}
      />,
    )
    const rangeSpan = range.container.querySelector('.tc-range') as HTMLElement
    expect(rangeSpan.textContent).toBe('第 40–79 行')
    expect(rangeSpan.getAttribute('title')).toBe('共 300 行')
    range.unmount()

    const from = render(<ReadRange call={{ ...baseCall, offset: 40 }} preview={null} />)
    expect(from.container.querySelector('.tc-range')?.textContent).toBe('第 40 行起')
  })

  test('展开体：正文按行号摊开，尾注单独一行', () => {
    const preview: ReadPreview = {
      path: 'D:/work/sample.txt',
      lines: [
        { number: 3, text: '第三行' },
        { number: 4, text: '第四行' },
      ],
      total: 300,
      notes: ['…（共 300 行，可用 offset/limit 续读）'],
      empty: false,
    }
    const { container } = render(<ReadBody call={toolCallOf({ name: 'read' })} preview={preview} />)
    expect(container.querySelectorAll('.tc-read-line').length).toBe(2)
    expect(container.querySelector('.tc-read-no')?.textContent).toBe('3')
    expect(container.querySelector('.tc-read-text')?.textContent).toBe('第三行')
    expect(container.querySelector('.tc-read-note')?.textContent).toContain('共 300 行')
  })

  test('空文件：一句「（空文件）」加宿主尾注，标 data-read-empty', () => {
    const preview: ReadPreview = {
      path: 'D:/work/empty.txt',
      lines: [],
      total: 0,
      notes: ['…（共 0 行，可用 offset/limit 续读）'],
      empty: true,
    }
    const { container } = render(<ReadBody call={toolCallOf({ name: 'read' })} preview={preview} />)
    const box = container.querySelector('.tc-read') as HTMLElement
    expect(box.getAttribute('data-read-empty')).toBe('1')
    const notes = [...container.querySelectorAll('.tc-read-note')].map((node) => node.textContent)
    expect(notes[0]).toBe('（空文件）')
    expect(notes[1]).toContain('共 0 行')
  })

  test('认不出结构回落原文；跑动中说「正在读取」；跑完仍什么都没有就不画', () => {
    const raw = render(
      <ReadBody call={toolCallOf({ name: 'read', status: 'done', resultText: ' 读不到：权限不足 ' })} preview={null} />,
    )
    expect(raw.container.querySelector('.tc-read-raw')?.textContent).toBe('读不到：权限不足')
    raw.unmount()

    const running = render(
      <ReadBody call={toolCallOf({ name: 'read', status: 'running', resultText: undefined })} preview={null} />,
    )
    expect(running.container.querySelector('.tc-read-note')?.textContent).toBe('正在读取')
    running.unmount()

    const nothing = render(
      <ReadBody call={toolCallOf({ name: 'read', status: 'done', resultText: '' })} preview={null} />,
    )
    expect(nothing.container.firstChild).toBeNull()
  })
})

// ── 待办卡：进度读数与清空 / 空清单 / 整表 ───────────────────────────────────

describe('待办卡（TodoProgress / TodoBody）', () => {
  test('头行进度：空清单不画；有进行中的那条时进度与正文都上屏', () => {
    const emptyList: TodoList = { items: [], done: 0, total: 0, notes: [], cleared: false }
    const empty = render(<TodoProgress list={emptyList} />)
    expect(empty.container.firstChild).toBeNull()
    empty.unmount()

    const list: TodoList = {
      items: [
        { id: 'a', content: '写单测', status: 'completed', depth: 0 },
        { id: 'b', content: '跑构建', status: 'in_progress', depth: 1 },
      ],
      done: 1,
      total: 2,
      notes: [],
      cleared: false,
    }
    const { container } = render(<TodoProgress list={list} />)
    expect(container.querySelector('.tc-todo-progress')?.textContent).toBe('1/2 完成')
    const active = container.querySelector('.tc-todo-active') as HTMLElement
    expect(active.textContent).toBe('跑构建')
    expect(active.getAttribute('title')).toBe('跑构建')
  })

  test('清空回执与「清单里没有条目」是两句话，不是同一张空卡', () => {
    const cleared = render(
      <TodoBody list={{ items: [], done: 0, total: 0, notes: [], cleared: true }} />,
    )
    expect(cleared.container.querySelector('.tc-todo')?.getAttribute('data-todo-empty')).toBe('1')
    expect(cleared.container.querySelector('.tc-todo-note')?.textContent).toBe('清单已清空')
    cleared.unmount()

    const empty = render(<TodoBody list={{ items: [], done: 0, total: 0, notes: [], cleared: false }} />)
    expect(empty.container.querySelector('.tc-todo-note')?.textContent).toBe('清单里没有条目')
  })

  test('整表：四态与层级落在 DOM 上，进度与尾注重算', () => {
    const list: TodoList = {
      items: [
        { id: 'a', content: '写单测', status: 'completed', depth: 0 },
        { id: 'b', content: '跑构建', status: 'in_progress', depth: 1 },
        { id: 'c', content: '已取消', status: 'cancelled', depth: 1 },
      ],
      done: 1,
      total: 2,
      notes: ['只保留前 64 条'],
      cleared: false,
    }
    const { container } = render(<TodoBody list={list} />)
    const items = [...container.querySelectorAll('.tc-todo-item')] as HTMLElement[]
    expect(items.map((item) => item.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'cancelled'])
    expect(items[1]?.style.getPropertyValue('--tc-todo-depth')).toBe('1')
    expect(container.querySelector('.tc-todo-done')?.textContent).toBe('1/2 完成')
    expect(container.querySelector('.tc-todo-note')?.textContent).toBe('只保留前 64 条')
  })
})

// ── 模型重试行：两种状态与倒计时 ─────────────────────────────────────────────

describe('模型重试行（RetryRow）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 一条重试条目。 */
  const retryOf = (over: Partial<Extract<TranscriptEntry, { kind: 'model-retry' }>> = {}): Extract<TranscriptEntry, { kind: 'model-retry' }> =>
    ({ kind: 'model-retry', id: 1, attempt: 2, maxRetries: 5, delayMs: 1500, text: '429 rate limit', ...over })

  test('已重试：不闪、摘要说等了几秒，明细里是延迟与失败原因', () => {
    const { container } = render(
      <RetryRow entry={retryOf({ ts: Date.now() - 5000 })} />,
    )
    const details = container.querySelector('.retry-row') as HTMLElement
    expect(details.getAttribute('data-active')).toBeNull()
    const summary = container.querySelector('.retry-text') as HTMLElement
    expect(summary.textContent).toBe('已重试模型请求（2/5） · 2s')
    expect(summary.getAttribute('data-shimmer')).toBeNull()
    expect(container.querySelector('.retry-details')?.textContent).toContain('1500 毫秒')
    expect(container.querySelector('.retry-details')?.textContent).toContain('429 rate limit')
  })

  test('正在重试：标记 active / shimmer，剩余秒数跟着时钟走', () => {
    const { container } = render(<RetryRow entry={retryOf({ delayMs: 5000, ts: Date.now() })} />)
    const details = container.querySelector('.retry-row') as HTMLElement
    expect(details.getAttribute('data-active')).toBe('1')
    const summary = container.querySelector('.retry-text') as HTMLElement
    expect(summary.textContent).toBe('正在重试模型请求（2/5） · 5s')
    expect(summary.getAttribute('data-shimmer')).toBe('正在重试模型请求')
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(summary.textContent).toBe('正在重试模型请求（2/5） · 3s')
  })
})

// ── 用户附件与编辑框 ─────────────────────────────────────────────────────────

describe('用户附件卡（UserFileCards）', () => {
  const files = (): UserFileAttachment[] => [
    { sha: 'v1', kind: 'video', name: '演示.mp4', mime: 'video/mp4', bytes: 1024, path: 'D:/a.mp4', url: 'blob:video-1' },
    { sha: 'v2', kind: 'video', name: '无地址.mp4', mime: 'video/mp4', bytes: 2048, path: 'D:/b.mp4' },
    { sha: 'f1', kind: 'file', name: '报告.pdf', mime: 'application/pdf', bytes: 1024, path: 'D:/c.pdf', url: 'blob:file-1' },
    { sha: 'f2', kind: 'file', name: '本地.txt', mime: 'text/plain', bytes: 10, path: 'D:/d.txt' },
  ]

  test('视频有 url 出播放器；视频没 url 降级文件卡；文件有 url 是下载链接、没 url 是死卡', () => {
    const { container } = render(<UserFileCards files={files()} />)
    const videos = container.querySelectorAll('video')
    expect(videos.length).toBe(1)
    expect(videos[0]?.getAttribute('src')).toBe('blob:video-1')
    expect(videos[0]?.getAttribute('aria-label')).toBe('演示.mp4')

    const link = container.querySelector('a.user-file-card') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('blob:file-1')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.textContent).toContain('报告.pdf')

    // 两张死卡：无 url 的视频（降级）与无 url 的文件。
    const dead = [...container.querySelectorAll('div.user-file-card')] as HTMLElement[]
    expect(dead.length).toBe(2)
    expect(dead.map((node) => node.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('无地址.mp4'), expect.stringContaining('本地.txt')]),
    )
    // 四个附件都上了屏（视频也来自 .user-file-card）。
    expect(container.querySelectorAll('.user-file-card').length).toBe(4)
  })

  test('附件缺省或空数组时整块不渲染', () => {
    const none = render(<UserFileCards files={undefined} />)
    expect(none.container.firstChild).toBeNull()
    none.unmount()
    const empty = render(<UserFileCards files={[]} />)
    expect(empty.container.firstChild).toBeNull()
  })
})

describe('编辑并重发（UserRow 的三个出口）', () => {
  const entry = { kind: 'user', id: 1, text: '原话' } as Extract<TranscriptEntry, { kind: 'user' }>

  /** 渲染一条可编辑用户消息，返回动作替身。 */
  const renderEditable = (): { container: HTMLElement; actions: FlowActions & { editAndResend: ReturnType<typeof vi.fn> } } => {
    const actions = { editAndResend: vi.fn(), busy: false }
    const { container } = render(
      <FlowActionsContext.Provider value={actions}>
        <UserRow entry={entry} />
      </FlowActionsContext.Provider>,
    )
    return { container, actions }
  }

  test('Esc 与「取消」都只收手：不重发、编辑框消失', () => {
    const { container, actions } = renderEditable()
    fireEvent.click(container.querySelector('.user-act') as HTMLElement)
    const box = container.querySelector('.user-edit-box') as HTMLTextAreaElement
    expect(box.value).toBe('原话')
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(container.querySelector('.user-edit-box')).toBeNull()
    expect(actions.editAndResend).not.toHaveBeenCalled()

    fireEvent.click(container.querySelector('.user-act') as HTMLElement)
    fireEvent.click(container.querySelector('.user-edit-actions [data-variant="ghost"]') as HTMLElement)
    expect(container.querySelector('.user-edit-box')).toBeNull()
    expect(actions.editAndResend).not.toHaveBeenCalled()
  })

  test('空白正文不可重发：Enter 与按钮都拦住（按钮保持置灰）', () => {
    const { container, actions } = renderEditable()
    fireEvent.click(container.querySelector('.user-act') as HTMLElement)
    const box = container.querySelector('.user-edit-box') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '   ' } })
    const resend = container.querySelector('.user-edit-actions [data-variant="primary"]') as HTMLButtonElement
    expect(resend.disabled).toBe(true)
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(actions.editAndResend).not.toHaveBeenCalled()
    expect(container.querySelector('.user-edit-box')).toBeTruthy()
  })

  test('Shift+Enter 只换行；Enter 与「重发」都把 trim 后的正文交出去', () => {
    const { container, actions } = renderEditable()
    fireEvent.click(container.querySelector('.user-act') as HTMLElement)
    const box = container.querySelector('.user-edit-box') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '  改过的  ' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(actions.editAndResend).not.toHaveBeenCalled()
    expect(container.querySelector('.user-edit-box')).toBeTruthy()

    fireEvent.keyDown(box, { key: 'Enter' })
    expect(actions.editAndResend).toHaveBeenCalledWith(entry, '改过的')
    expect(container.querySelector('.user-edit-box')).toBeNull()

    // 再走按钮那一条：同样 trim 后提交。
    actions.editAndResend.mockClear()
    fireEvent.click(container.querySelector('.user-act') as HTMLElement)
    const again = container.querySelector('.user-edit-box') as HTMLTextAreaElement
    fireEvent.change(again, { target: { value: ' 按钮改的 ' } })
    fireEvent.click(container.querySelector('.user-edit-actions [data-variant="primary"]') as HTMLElement)
    expect(actions.editAndResend).toHaveBeenCalledWith(entry, '按钮改的')
  })
})

describe('只读用户消息（ReadonlyUserRow）', () => {
  test('审查结论画成卡片，不退回用户气泡', () => {
    const body = '<review-findings summary="复查完成">\n<finding file="a.ts" line="1" severity="warn">有点问题</finding>\n</review-findings>'
    const { container } = render(
      <ShellCwdContext.Provider value="">
        <ReadonlyUserRow entry={{ kind: 'user', id: 1, text: body }} />
      </ShellCwdContext.Provider>,
    )
    expect(container.querySelector('.user-turn')).toBeNull()
    expect(container.textContent).toContain('a.ts')
  })

  test('贴图浮层可开可关（只读出口自己一份状态）', () => {
    const { container } = render(
      <ReadonlyUserRow entry={{ kind: 'user', id: 1, text: '看图', images: ['file:///shot.png'] }} />,
    )
    fireEvent.click(container.querySelector('button.entry-shot') as HTMLElement)
    expect(document.body.querySelector('.img-lightbox img[src="file:///shot.png"]')).toBeTruthy()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.body.querySelector('.img-lightbox')).toBeNull()
  })
})

// ── 子代理卡与只读条目流 ─────────────────────────────────────────────────────

describe('子代理卡（SubagentRow）', () => {
  const subagentOf = (sub: object): Extract<TranscriptEntry, { kind: 'subagent' }> =>
    ({ kind: 'subagent', id: 1, sub }) as Extract<TranscriptEntry, { kind: 'subagent' }>

  test('一次性徽标、状态词、token、当前工具与错误行都上屏', () => {
    const { container } = render(
      <SubagentRow
        entry={subagentOf({
          name: '小美',
          role: 'coder',
          task: '修 bug',
          state: 'working',
          mode: 'one-shot',
          rounds: 3,
          toolCalls: 5,
          tokens: 1234,
          lastTool: { name: 'bash', args: '{}', status: 'done' },
          error: '过程挂了',
        })}
      />,
    )
    expect(container.querySelector('.shell-subagent-mode')?.textContent).toBe('一次性')
    expect(container.querySelector('.shell-subagent-state')?.textContent).toBe('执行中')
    const meta = container.querySelector('.shell-subagent-meta')?.textContent ?? ''
    expect(meta).toContain('3 轮 · 5 次工具')
    expect(meta).toContain('tok')
    expect(meta).toContain('当前 bash')
    expect(container.querySelector('.shell-subagent-error')?.textContent).toBe('过程挂了')
  })

  test('未知状态回落原文；可选字段缺席时不画空徽标与空尾巴', () => {
    const { container } = render(
      <SubagentRow
        entry={subagentOf({
          name: '阿强',
          role: 'reader',
          task: '读文件',
          state: 'weird',
          mode: 'continuable',
          rounds: 0,
          toolCalls: 0,
        })}
      />,
    )
    expect(container.querySelector('.shell-subagent-mode')).toBeNull()
    expect(container.querySelector('.shell-subagent-state')?.textContent).toBe('weird')
    expect(container.querySelector('.shell-subagent-error')).toBeNull()
    const meta = container.querySelector('.shell-subagent-meta')?.textContent ?? ''
    expect(meta).not.toContain('tok')
    expect(meta).not.toContain('当前')
  })
})

describe('只读子代理条目流（SubagentFlow）', () => {
  afterEach(() => {
    clearFold('mate-1:sub:thinking:0')
  })

  test('没给条目时容器照画、一行都不出', () => {
    const { container } = render(<SubagentFlow />)
    expect(container.querySelector('.chat-inner.subagent-flow')).toBeTruthy()
    expect(container.querySelectorAll('.entry-row').length).toBe(0)
  })

  test('同一套行渲染：用户消息只读（没有编辑钮），思考行的展开存档按 sessionKey 落键', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'user', id: 1, text: '请看看' },
      { kind: 'thinking', id: 2, text: '想一想' },
      { kind: 'text', id: 3, text: '回答如下' },
    ]
    const { container } = render(
      <RuntimeProvider channel={stubChannel()}>
        <SubagentFlow entries={entries} sessionKey="mate-1" cwd="D:/work" />
      </RuntimeProvider>,
    )
    expect(container.querySelectorAll('.entry-row').length).toBe(3)
    expect(container.querySelector('.user-turn')).toBeTruthy()
    // 只读出口不画 hover 编辑钮。
    expect(container.querySelector('.user-act')).toBeNull()
    expect(container.textContent).toContain('回答如下')
    fireEvent.click(container.querySelector('.think-head') as HTMLElement)
    expect(hasFold('mate-1:sub:thinking:0')).toBe(true)
  })

  test('工具条目在只读流里也落到同一张工具卡', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'tool', id: 1, call: { callId: 'c1', name: 'bash', argsText: '{"command":"ls"}', status: 'done' } },
    ]
    const { container } = render(
      <RuntimeProvider channel={stubChannel()}>
        <SubagentFlow entries={entries} sessionKey="mate-1" cwd="D:/work" />
      </RuntimeProvider>,
    )
    expect(container.querySelector('.tool-card')).toBeTruthy()
  })
})

// ── 改动卡的审查 / 打开出口（真实 dock 布局状态） ────────────────────────────

describe('改动卡的「审查 / 打开」出口', () => {
  let facts: { offs: Array<() => void>; session: number } = { offs: [], session: 0 }
  beforeEach(() => {
    localStorage.clear()
    facts.session += 1
    setDockSession(`transcript-extra-${String(facts.session)}`)
    // 两种页签都报名：不带报名的话 setDockFileView / setDockPreview 会直接 early return。
    facts.offs.push(registerDockTab({ kind: 'preview', label: '预览', component: () => null }))
    facts.offs.push(registerDockTab({ kind: 'patch', label: '补丁', component: () => null }))
  })
  afterEach(() => {
    while (facts.offs.length > 0) facts.offs.pop()!()
    localStorage.clear()
  })

  const changeRow = (path: string): Row =>
    ({
      entry: { kind: 'changes', id: path.length, file: { path, added: 1, removed: 0, hunks: [], status: 'modified' } },
      live: false,
      at: 1,
      stable: `r0:changes:${path}`,
    }) as unknown as Row

  const previewPaths = (): string[] =>
    dockSurface()
      .panes.flatMap((pane) => pane.tabs)
      .filter((tab) => tab.kind === 'preview')
      .map((tab) => tab.path ?? '')

  test('单文件：头行、审查、打开三处都开同一张预览页签', () => {
    const { container } = render(<ChangesCard rows={[changeRow('only.ts')]} cwd="D:/demo" />)
    // 单文件卡没有行列表，出口是头行与底部两个按钮。
    fireEvent.click(container.querySelector('.changes-head') as HTMLElement)
    expect(previewPaths()).toContain('only.ts')
    fireEvent.click(container.querySelector('.changes-act-single .changes-btn') as HTMLElement)
    expect(previewPaths()).toContain('only.ts')
    const buttons = container.querySelectorAll('.changes-act-single .changes-btn')
    fireEvent.click(buttons[1] as HTMLElement)
    expect(previewPaths()).toContain('only.ts')
  })

  test('多文件：行内审查 / 打开与卡头点第一张各开各的路径', () => {
    const { container } = render(<ChangesCard rows={[changeRow('a.ts'), changeRow('b.ts')]} cwd="D:/demo" />)
    const rows = container.querySelectorAll('.changes-row-wrap')
    fireEvent.click(rows[1]?.querySelector('.changes-row') as HTMLElement)
    expect(previewPaths()).toContain('b.ts')
    fireEvent.click(rows[1]?.querySelectorAll('.changes-btn')[0] as HTMLElement)
    expect(previewPaths()).toContain('b.ts')
    fireEvent.click(rows[1]?.querySelectorAll('.changes-btn')[1] as HTMLElement)
    expect(previewPaths()).toContain('b.ts')
    // 卡头按第一张文件开（reviewAt(files.indexOf(single ?? files[0]))）。
    fireEvent.click(container.querySelector('.changes-head') as HTMLElement)
    expect(previewPaths()).toContain('a.ts')
  })
})

// ── 刻度条：悬停预览与点击跳轮 ───────────────────────────────────────────────

describe('回合刻度条（JumpRail）的预览与跳轮', () => {
  let scrollToOffset: ReturnType<typeof vi.fn>
  let onReveal: ReturnType<typeof vi.fn>

  beforeEach(() => {
    scrollToOffset = vi.fn()
    onReveal = vi.fn()
    ;(document as unknown as { elementFromPoint?: unknown }).elementFromPoint = () => null
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
      return (this.hidden ? [] : [{ width: 200, height: 20 }]) as unknown as DOMRectList
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
  })

  afterEach(() => {
    document.querySelectorAll('.chat-wrap').forEach((host) => host.remove())
    vi.restoreAllMocks()
  })

  const roundsOf = (over: Partial<JumpRailRound>[] = []): JumpRailRound[] =>
    Array.from({ length: 2 }, (_, round) => ({ round, prompt: `第 ${String(round)} 问`, response: '', ...over[round] }))

  /** 把刻度条挂进 .chat-wrap > .chat > 行的架子。 */
  const mountRail = (rounds: JumpRailRound[]): { container: HTMLElement; scroller: HTMLElement } => {
    const wrap = document.createElement('div')
    wrap.className = 'chat-wrap'
    const scroller = document.createElement('div')
    scroller.className = 'chat'
    for (const round of rounds) {
      const row = document.createElement('div')
      row.setAttribute('data-round', String(round.round))
      row.textContent = `第 ${String(round.round)} 轮的行`
      scroller.appendChild(row)
    }
    wrap.appendChild(scroller)
    document.body.appendChild(wrap)
    const viewport = {
      scroller,
      rect: (): DOMRect | null => ({ top: 0, left: 0, width: 800, height: 600 } as DOMRect),
      scrollTop: (): number => 0,
      clientWidth: (): number => 800,
      atFloor: (): boolean => false,
      offsetOf: (element: Element | null): number | null =>
        element === null ? null : Number(element.getAttribute('data-round')) * 400,
      scrollToOffset,
    } as unknown as ChatViewport
    render(
      <JumpRail rounds={rounds} renderedFrom={0} onReveal={onReveal as unknown as (round: number) => void} viewport={viewport} />,
      { container: wrap },
    )
    return { container: wrap, scroller }
  }

  const afterMeasure = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
  }

  test('聚焦刻度出预览卡：题面与回复摘要各一行；失焦收起', async () => {
    const { container } = mountRail(roundsOf([{ response: '答过了' }, {}]))
    await afterMeasure()
    const tick = container.querySelector('[data-turn="1"]') as HTMLElement
    fireEvent.focus(tick)
    const preview = container.querySelector('.jump-preview') as HTMLElement
    expect(preview).toBeTruthy()
    expect(preview.querySelector('.jump-preview-prompt')?.textContent).toBe('第 1 问')
    expect(preview.querySelector('.jump-preview-response')).toBeNull()
    fireEvent.blur(tick)
    expect(container.querySelector('.jump-preview')).toBeNull()

    const first = container.querySelector('[data-turn="0"]') as HTMLElement
    fireEvent.focus(first)
    expect(container.querySelector('.jump-preview-response')?.textContent).toBe('答过了')
  })

  test('空题面说「第 N 轮」；点已画出的刻度按视口偏移跳转（smooth + jump 交接）', async () => {
    const { container } = mountRail(roundsOf([{ prompt: '' }]))
    await afterMeasure()
    const first = container.querySelector('[data-turn="0"]') as HTMLElement
    fireEvent.focus(first)
    expect(container.querySelector('.jump-preview-prompt')?.textContent).toBe('第 1 轮')
    fireEvent.click(first)
    expect(scrollToOffset).toHaveBeenCalledWith(0, 'smooth', 'jump')

    fireEvent.click(container.querySelector('[data-turn="1"]') as HTMLElement)
    expect(scrollToOffset).toHaveBeenCalledWith(400, 'smooth', 'jump')
    expect(onReveal).not.toHaveBeenCalled()
  })
})
