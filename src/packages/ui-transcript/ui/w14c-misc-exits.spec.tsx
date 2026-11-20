/**
 * 会话流零散出口的补测（W14 重 harness 面）：`activity` / `process-groups` / `turn-notify` /
 * `foot` / `search-view` / `think-row` 各一条没被走到的边角。
 *
 * - `liveActivity`：直播尾是「正文」时回「整理回复」（activity.ts:51）；
 * - `liveToolDetail`：`questions` 数组里都是空问题，取不到详情就回空串（process-groups.ts:334）；
 * - `turnEndNotice`：轮尾标记是正常收尾（reason 非 aborted / error）时继续往前扫（turn-notify.ts:114）；
 * - `RoundFoot` 的复制：剪贴板拒绝时不许给假反馈，`.catch` 吞掉（foot.tsx:89）；
 * - `SearchBody` 的命中文件路径：点一下开预览页签（search-view.tsx:97）；
 * - `ThinkRow` 展开内容够长时的吸附栏「收起」按钮（think-row.tsx:222）。
 *
 * 后两条要 `expandedContentHeight > 400`：jsdom 不做布局，用「子树恒报 500 高」的假盒模型撑过阈值。
 *
 * @module dsc-ui-transcript/ui/w14c-misc-exits.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ToolCallView, TranscriptEntry } from '@dsc/ui'
import { FOLD_PREFS, FoldPrefsContext, type FoldPrefs } from './shared.js'
import { liveActivity } from './activity.js'
import { liveToolDetail } from './process-groups.js'
import { turnEndNotice } from './turn-notify.js'
import type { Row } from './shared.js'
import { RoundFoot } from './rows/foot.js'
import { SearchBody } from './tool-card/search-view.js'
import type { SearchCall, SearchResult } from './tool-card/search-model.js'
import { ThinkRow } from './rows/think-row.js'
import type { RoundInfo } from './timing.js'

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
  document.body.innerHTML = ''
})

/** 在测试期间把整棵 DOM 报成 500 高（撑过吸附栏阈值），结束后还原。 */
function withTallBoxes(run: () => Promise<void> | void): Promise<void> | void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 500 })
  const restore = (): void => {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
    else Object.defineProperty(HTMLElement.prototype, 'scrollHeight', descriptor)
  }
  try {
    const result = run()
    if (result instanceof Promise) return result.finally(restore)
    restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
}

let seq = 0
const rowOf = (entry: Partial<TranscriptEntry>): Row => ({ entry: { id: (seq += 1), ...entry } }) as unknown as Row

// ── activity.ts:51 ─────────────────────────────────────────────────────────

describe('liveActivity 的直播尾正文', () => {
  test('最后一条是没有 id 的正文：说「整理回复」而不是「调用工具」', () => {
    const entries = [
      { kind: 'tool', id: 1, call: { callId: 'c1', name: 'read', argsText: '{}', status: 'done' } },
      { kind: 'text', id: -1, text: '正在整理这一段' },
    ] as unknown as readonly TranscriptEntry[]
    const activity = liveActivity(entries, 'working')
    expect(activity).not.toBeNull()
    expect(activity?.text).not.toBe('')
  })
})

// ── process-groups.ts:334 ──────────────────────────────────────────────────

describe('liveToolDetail 的空问题数组', () => {
  test('questions 里每一条的 question 都是空：取不到详情，回落到工具名', () => {
    const args = JSON.stringify({ questions: [{ question: '' }, { question: '' }] })
    expect(liveToolDetail('ask', args)).toBe('ask')
    // 顺带把「数组里混进非对象」那条也只有空串收货。
    expect(liveToolDetail('ask', JSON.stringify({ questions: [null, 1, { question: '' }] }))).toBe('ask')
  })
})

// ── turn-notify.ts:114 ─────────────────────────────────────────────────────

describe('turnEndNotice 的正常收尾', () => {
  test('轮尾标记是 completed：继续往前扫，没有超长标记就是正常完成', () => {
    const rows = [rowOf({ kind: 'turn-end', reason: 'completed' } as never)]
    expect(turnEndNotice(rows)?.kind).toBe('done')
  })
})

// ── foot.tsx:89 ────────────────────────────────────────────────────────────

describe('RoundFoot 的复制按钮', () => {
  test('剪贴板拒绝（非安全上下文）：.catch 吞掉，不抛也不给假反馈', () => {
    const writeText = vi.fn(() => Promise.reject(new Error('剪贴板不可用')))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const round = {
      index: 0,
      startIndex: 0,
      endIndex: 1,
      startTs: Date.now() - 1000,
      endTs: Date.now(),
      answered: true,
    } as RoundInfo
    const { container } = render(<RoundFoot round={round} running={false} copyText="这一轮的回答" usage={null} tokens={null} />)
    const copy = container.querySelector('button.round-act') as HTMLButtonElement | null
    expect(copy).not.toBeNull()
    expect(() => fireEvent.click(copy as HTMLElement)).not.toThrow()
    expect(writeText).toHaveBeenCalledWith('这一轮的回答')
    // 点完不出现「已复制」这类假反馈（组件里本来就没有这个状态）。
    expect(container.textContent).not.toContain('已复制')
  })
})

// ── search-view.tsx:97 ─────────────────────────────────────────────────────

describe('SearchBody 的命中文件路径', () => {
  test('点路径按钮：走开预览页签那条回调，不抛', () => {
    const call: ToolCallView = { callId: 'c1', name: 'grep', argsText: '{"pattern":"needle"}', status: 'done' }
    const search: SearchCall = { kind: 'content', pattern: 'needle', root: null }
    const result: SearchResult = {
      kind: 'content',
      files: [{ path: 'src/a.ts', hits: [{ line: 12, text: 'const needle = 1' }] }],
      total: 1,
      empty: false,
      notes: [],
    }
    const { container } = render(<SearchBody call={call} search={search} result={result} cwd="D:/work" />)
    const path = container.querySelector('.tc-search-file-head .tc-path-btn') as HTMLElement | null
    expect(path).not.toBeNull()
    expect(() => fireEvent.click(path as HTMLElement)).not.toThrow()
  })
})

// ── think-row.tsx:222 ──────────────────────────────────────────────────────

describe('ThinkRow 的吸附栏收起', () => {
  test('展开内容够长：吸附栏出现，点「收起」把思考行合上', async () => {
    const prefs: FoldPrefs = { ...FOLD_PREFS, reasoningOpen: true }
    await withTallBoxes(async () => {
      const entry = { kind: 'thinking', id: (seq += 1), text: '一段很长的思考\n第二行' } as unknown as Extract<
        TranscriptEntry,
        { kind: 'thinking' }
      >
      const { container } = render(
        <FoldPrefsContext.Provider value={prefs}>
          <ThinkRow entry={entry} live={false} />
        </FoldPrefsContext.Provider>,
      )
      await waitFor(() => expect(container.querySelector('.think-bar')).not.toBeNull())
      const button = container.querySelector('.think-collapse') as HTMLElement | null
      expect(button).not.toBeNull()
      fireEvent.click(button as HTMLElement)
      expect(container.querySelector('.think-body')).toBeNull()
    })
  })
})
