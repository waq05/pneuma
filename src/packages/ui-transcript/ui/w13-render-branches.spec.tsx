/**
 * 会话行体按 kind 分流的补充分支（ui 层，真渲染 `RowBody`）。
 *
 * `rows-render.spec.tsx` 覆盖了 text / thinking / tool / system / system-prompt /
 * context-injection / turn-end 这些分支；`render.tsx` 的 `builtinRowBody` 还有四类条目
 * 从没渲染过——本文件把它们的**渲染出口**钉住：
 *
 *  - `turn-max-tokens`：轮次因输出上限结束时的一行系统提示（带 `data-turn-notice`）；
 *  - `model-retry`：可展开的重试行（`.retry-row`，倒计时/已重试两种态）；
 *  - `plan`：计划卡（`.plan-card`，pending 与 settled 两种外观）；
 *  - `subagent`：队友卡（`.shell-subagent`，状态词、一次性标记、错误行）。
 *
 * 四条都是纯渲染（不碰宿主通道），断言落在类名与文案上。
 *
 * @module dsc-ui-transcript/ui/w13-render-branches.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { TranscriptEntry } from '@dsc/ui'
import type { Row } from './shared.js'
import { RowBody } from './render.js'

afterEach(cleanup)

/** 同目录 spec 的写法：条目 + 行壳（live=false，at/stable 固定）。 */
let seq = 1000
const rowOf = (entry: TranscriptEntry): Row =>
  ({ entry, live: false, at: 1, stable: 'r0:text:0' }) as Row

const entryOf = (kind: TranscriptEntry['kind'], extra: object = {}): TranscriptEntry =>
  ({ kind, id: (seq += 1), ...extra }) as TranscriptEntry

describe('turn-max-tokens', () => {
  test('画一行带 data-turn-notice 的系统提示', () => {
    const { container } = render(<RowBody row={rowOf(entryOf('turn-max-tokens'))} />)
    const notice = container.querySelector('[data-turn-notice="max-tokens"]')
    expect(notice).not.toBeNull()
    expect(notice?.textContent).toBe('这一轮的输出达到长度上限，已被截断')
  })
})

describe('model-retry', () => {
  test('已重试过的记录（ts 早已过点）画收起态的重试行，展开明细里有等待时长与原因', () => {
    const { container } = render(
      <RowBody
        row={rowOf(
          entryOf('model-retry', {
            ts: Date.now() - 60_000,
            delayMs: 1847,
            attempt: 3,
            maxRetries: 5,
            text: '429: server_error',
          }),
        )}
      />,
    )
    const row = container.querySelector('.retry-row')
    expect(row).not.toBeNull()
    expect(row?.getAttribute('data-active')).toBeNull()
    expect(container.querySelector('.retry-summary')?.textContent).toContain('3/5')
    // 展开明细：延迟毫秒数 + 失败原因原文。
    expect(container.querySelector('.retry-details')?.textContent).toContain('1847')
    expect(container.querySelector('.retry-details')?.textContent).toContain('429: server_error')
  })

  test('正在退避中（ts 就在此刻、delayMs 还没过）带 data-active，并且会起倒计时定时器', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <RowBody
          row={rowOf(
            entryOf('model-retry', { ts: Date.now(), delayMs: 60_000, attempt: 1, maxRetries: 3, text: '限流' }),
          )}
        />,
      )
      expect(container.querySelector('.retry-row')?.getAttribute('data-active')).toBe('1')
      expect(vi.getTimerCount()).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('plan', () => {
  test('pending 的计划卡：标题、待批准判定、正文与文件路径都上屏', () => {
    const { container } = render(
      <RowBody
        row={rowOf(
          entryOf('plan', {
            plan: { decision: 'pending', title: '加一层缓存', text: '第一步…', file: '.dsc/plan.md' },
          }),
        )}
      />,
    )
    const card = container.querySelector('.plan-card')
    expect(card?.classList.contains('pending')).toBe(true)
    expect(card?.querySelector('.plan-title')?.textContent).toBe('加一层缓存')
    expect(card?.querySelector('.plan-verdict')?.textContent).toBe('等你批')
    expect(card?.querySelector('.plan-body')?.textContent).toBe('第一步…')
    expect(card?.querySelector('.plan-file')?.textContent).toBe('.dsc/plan.md')
  })

  test('settled 的计划卡：判定文案跟着 approved / rejected 变', () => {
    const approved = render(
      <RowBody row={rowOf(entryOf('plan', { plan: { decision: 'approved', title: 'A', text: 'x', file: 'a.md' } }))} />,
    )
    expect(approved.container.querySelector('.plan-card')?.classList.contains('pending')).toBe(false)
    expect(approved.container.querySelector('.plan-verdict')?.textContent).toBe('已批准')
    approved.unmount()

    const rejected = render(
      <RowBody row={rowOf(entryOf('plan', { plan: { decision: 'rejected', title: 'B', text: 'y', file: 'b.md' } }))} />,
    )
    expect(rejected.container.querySelector('.plan-verdict')?.textContent).toBe('未批准')
  })
})

describe('subagent', () => {
  test('队友卡：名字/角色/状态词/任务与用量都在；一次性与错误行按字段出现', () => {
    const { container } = render(
      <RowBody
        row={rowOf(
          entryOf('subagent', {
            sub: {
              name: '研究员',
              role: 'researcher',
              state: 'failed',
              mode: 'one-shot',
              task: '去查一下\n再总结',
              rounds: 2,
              toolCalls: 7,
              tokens: 1234,
              lastTool: { name: 'read' },
              error: '上下文超限',
            },
          }),
        )}
      />,
    )
    const card = container.querySelector('.shell-subagent')
    expect(card?.getAttribute('data-state')).toBe('failed')
    expect(card?.querySelector('.shell-subagent-name')?.textContent).toBe('研究员')
    expect(card?.querySelector('.shell-subagent-role')?.textContent).toBe('researcher')
    expect(card?.querySelector('.shell-subagent-state')?.textContent).toBe('过程失败')
    expect(card?.querySelector('.shell-subagent-mode')?.textContent).toBe('一次性')
    // 任务只留一行（换行被压平）。
    expect(card?.querySelector('.shell-subagent-task')?.textContent).not.toContain('\n')
    expect(card?.querySelector('.shell-subagent-meta')?.textContent).toContain('1.2K tok')
    expect(card?.querySelector('.shell-subagent-meta')?.textContent).toContain('当前 read')
    expect(card?.querySelector('.shell-subagent-error')?.textContent).toBe('上下文超限')
  })

  test('没有一次性标记、没有错误、没有用量时那几格不画', () => {
    const { container } = render(
      <RowBody
        row={rowOf(
          entryOf('subagent', {
            sub: { name: '助手', role: 'worker', state: 'working', mode: 'team', task: '跑', rounds: 1, toolCalls: 1 },
          }),
        )}
      />,
    )
    const card = container.querySelector('.shell-subagent')
    expect(card?.querySelector('.shell-subagent-mode')).toBeNull()
    expect(card?.querySelector('.shell-subagent-error')).toBeNull()
    expect(card?.querySelector('.shell-subagent-state')?.textContent).toBe('执行中')
  })
})
