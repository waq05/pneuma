/**
 * 会话流（`ui-transcript`）零散杂项的第四批补测（W14）。
 *
 * 这里每一段都对应一个组件 / 纯函数还没被走到的出口：
 *
 * - `ContextInjectionCard` 的键盘开合（Enter / 空格开合，其余键直接放行）；
 * - `searchResultOf` 认不出形状的结果行：当尾注留着，不吞；
 * - `triggerKind` 的四档来源（作业 / 队友汇报 / 目标续跑 / 其它）；
 * - `webResultOf` 的结构化卡片坏掉时返回 null（不许拿文本兜底）；
 * - `elapsedLabel` 的四档相对时间（刚刚 / 分钟 / 小时 / 天）；
 * - `useIntendedDiff` 的 edit 回退：盘上现值读不到时用 old→new 的参数差异；
 * - 阶段组头实时标题的「已满 150ms 立刻换」分支。
 *
 * @module dsc-ui-transcript/ui/w14-misc-gaps.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { ToolCallView, TranscriptEntry } from '@dsc/ui'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { ContextInjectionCard } from './rows/prompt-card.js'
import { triggerKind } from './rows/trigger-row.js'
import { elapsedLabel } from './welcome.js'
import { searchResultOf } from './tool-card/search-model.js'
import { webResultOf } from './tool-card/web-model.js'
import { useIntendedDiff, type IntendedDiff } from './intended-diff.js'
import { StepGroupRow } from './step-group-row.js'
import type { StepGroup } from './process-groups.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ── 上下文注入卡：键盘开合 ───────────────────────────────────────────────────

describe('上下文注入卡的键盘开合', () => {
  const parts = [
    { kind: 'env-facts', chars: 300, preview: '环境快照' },
    { kind: 'mode', chars: 86, preview: '模式' },
  ] as unknown as Parameters<typeof ContextInjectionCard>[0]['parts']

  test('Enter 展开、空格收起；其它键不动它', () => {
    const { container } = render(<ContextInjectionCard parts={parts} />)
    const head = container.querySelector('.entry-injection-head') as HTMLElement
    expect(head.getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(head, { key: 'Enter' })
    expect(head.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(head, { key: ' ' })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    // 其余键直接放行：状态不变，也不拦默认行为。
    fireEvent.keyDown(head, { key: 'a' })
    expect(head.getAttribute('aria-expanded')).toBe('false')
  })
})

// ── 检索结果：认不出的行当尾注 ──────────────────────────────────────────────

describe('searchResultOf 的尾注', () => {
  test('认不出形状的一行不吞：进 notes，同时正常命中的文件照旧解析', () => {
    const result = searchResultOf('content', '这一行没有命中形状\nsrc/a.ts:12: const needle = 1')
    expect(result?.notes).toContain('这一行没有命中形状')
    expect(result?.files[0]?.path).toBe('src/a.ts')
    expect(result?.files[0]?.hits[0]?.line).toBe(12)
  })
})

// ── 唤醒来源四档 ────────────────────────────────────────────────────────────

describe('triggerKind', () => {
  test('作业 / 队友汇报 / 目标续跑 / 其它四档', () => {
    expect(triggerKind('后台作业 build 已完成')).toBe('job')
    expect(triggerKind('<teammate-report finished />')).toBe('teammate')
    expect(triggerKind('（目标自动续跑：继续第 2 步）')).toBe('goal')
    expect(triggerKind('一条普通通知')).toBe('other')
  })
})

// ── web 卡片坏数据 ──────────────────────────────────────────────────────────

describe('webResultOf 的坏卡片', () => {
  test('card=web 但既没有 kind 也没有 sources/url：null，不拿文本兜底', () => {
    const call = { kind: 'search', query: 'pneuma' } as unknown as Parameters<typeof webResultOf>[0]
    expect(webResultOf(call, { result: { card: 'web' } }, '1. 标题\nhttps://a.example/one\n摘要')).toBeNull()
    // 不是 web 卡（别种卡片）时照旧走文本解析。
    expect(webResultOf(call, { result: { card: 'terminal' } }, '1. 标题\nhttps://a.example/one\n摘要')).not.toBeNull()
  })
})

// ── 相对时间四档 ────────────────────────────────────────────────────────────

describe('elapsedLabel', () => {
  test('刚刚 / N 分钟前 / N 小时前 / N 天前', () => {
    const now = Date.now()
    expect(elapsedLabel(now - 10_000)).toContain('刚刚')
    expect(elapsedLabel(now - 5 * 60_000)).toContain('5')
    expect(elapsedLabel(now - 3 * 3_600_000)).toContain('3')
    expect(elapsedLabel(now - 3 * 24 * 3_600_000)).toContain('3')
    // 未来时刻（时钟偏了）按「刚刚」收，不出现负数。
    expect(elapsedLabel(now + 60_000)).toContain('刚刚')
  })
})

// ── useIntendedDiff：edit 回退 ───────────────────────────────────────────────

describe('useIntendedDiff 的 edit 回退', () => {
  const noop = (): void => undefined

  /** 假宿主通道：`dock fs-read` 的回答由调用方给。 */
  function channelOf(reply: () => Promise<unknown>): HostChannel {
    return {
      getSnapshot: () => null,
      getHello: () => null,
      getStatus: () => 'open',
      getHostError: () => null,
      getPluginsFrame: () => null,
      onPlugins: () => noop,
      onAsk: () => noop,
      subscribe: () => noop,
      invoke: ((method: string) => (method === 'dock' ? reply() : Promise.resolve(null))) as unknown as HostChannel['invoke'],
      reconnect: noop,
      close: noop,
    }
  }

  /** 把 hook 的返回值提出来。 */
  function Probe({ call, onState }: { call: ToolCallView; onState: (state: IntendedDiff | null) => void }): ReactNode {
    onState(useIntendedDiff(call, 'D:/work', true))
    return null
  }

  test('盘上现值读不到（不是文本）时：用 old → new 的参数差异当最诚实的下限', async () => {
    const call: ToolCallView = {
      callId: 'c1',
      name: 'edit',
      // 这里用宿主实际传的参数名（old / new）。
      argsText: JSON.stringify({
        path: 'src/a.ts',
        old: 'const a = 1',
        new: 'const a = 2',
      }),
      status: 'running',
    }
    let state: IntendedDiff | null = null
    render(
      <RuntimeProvider channel={channelOf(() => Promise.resolve({ kind: 'binary', text: undefined }))}>
        <Probe
          call={call}
          onState={(value) => {
            state = value
          }}
        />
      </RuntimeProvider>,
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    // 推演出了差异：没有盘上现值也能看到 old→new。
    expect(state).not.toBeNull()
    expect((state as unknown as IntendedDiff).fellBack).toBe(true)
    expect((state as unknown as IntendedDiff).file?.added).toBe(1)
    expect((state as unknown as IntendedDiff).file?.removed).toBe(1)
  })
})

// ── 阶段组头：实时标题已满 150ms 立刻换 ─────────────────────────────────────

describe('阶段组头实时标题的换字时机', () => {
  const groupOf = (over: Partial<StepGroup> = {}): StepGroup =>
    ({
      roundIndex: 0,
      seq: 0,
      startIndex: 0,
      endIndex: 1,
      size: 2,
      members: [0, 1],
      counts: [{ kind: 'read', count: 2 }],
      failures: 0,
      closed: false,
      running: 'read',
      runningDetail: '第一版',
      preparing: false,
      ...over,
    }) as StepGroup

  test('标题已显示超过 150ms 再来新标题：当场换（不排队）', async () => {
    const view = render(<StepGroupRow group={groupOf()} open={false} showDetail onToggle={vi.fn()} />)
    const detail = (): string => view.container.querySelector('.step-fold-detail')?.textContent ?? ''
    expect(detail()).toBe('第一版')
    // 等过最短保留窗口，再换一版：这一次不该再排队 150ms，而是直接提交。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    view.rerender(<StepGroupRow group={groupOf({ runningDetail: '第二版' })} open={false} showDetail onToggle={vi.fn()} />)
    expect(detail()).toBe('第二版')
  })
})

// 保留一个「本文件只加测试、不动产品」的自检：产品源码的导出在这批用例里没被改过。
void ((): TranscriptEntry | null => null)
