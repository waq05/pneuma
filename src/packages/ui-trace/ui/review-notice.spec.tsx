/**
 * 轨迹页对「写前预览」通知的接线（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-review-notice-test.mjs` 第 [6] 段的轨迹页那半（缺口清单 B37）。原探针钉
 * `ui.tsx` 里的 `parseReviewNotice(text)` 与 `<ReviewNoticeCard … cwd="" />` 文本；这里把
 * TraceView 真挂起来喂一条通知，验证 system 步骤走同一张卡、且缺 cwd 时按路径原文显示。
 *
 * 不迁的：「轨迹页划选 diff 不误开检查器」是 `ui.tsx` 的选择器忽略表文本钉，jsdom 里没有
 * 真实划选与检查器打开链路，归 shots / 代码审查。
 *
 * @module dsc-ui-trace/ui/review-notice.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { REVIEW_NOTICE_BANNER, parseReviewNotice } from '@dsc/ui-primitives'
import type { HostSnapshot, TranscriptEntry, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** TraceView 不直接导出：照生产壳装载插件那条路，从 apply 的登记里收下它。 */
function traceComponent(): (props: Record<string, never>) => ReactNode {
  const registered: Array<{ slot: string; component: unknown }> = []
  const fakeUi = {
    slots: {
      register: (slot: string, _options: unknown, component: unknown): void => {
        registered.push({ slot, component })
      },
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
    },
    provide: (): void => undefined,
    consume: (): undefined => undefined,
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  const found = registered[0]
  if (found === undefined) throw new Error('trace 插件没有登记组件')
  return found.component as (props: Record<string, never>) => ReactNode
}

const TraceView = traceComponent()

/** 假通道：只提供空快照的订阅面（轨迹页所有数据都来自快照，不 invoke）。 */
function makeChannel(snapshot: HostSnapshot): HostChannel {
  return {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (() => Promise.reject(new Error('轨迹页不该 invoke'))) as unknown as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

/** 一条写前预览通知（头行 + 两行 diff）。 */
const noticeText = `${REVIEW_NOTICE_BANNER}修改 src/a.ts（+1 行 / -1 行）\n@@ -1,3 +1,3 @@\n-旧行\n+新行`

/** 造快照：一条 system 条目。 */
const snapshotOf = (entry: TranscriptEntry): HostSnapshot =>
  ({
    entries: [entry],
    liveEntries: [],
    status: { cwd: 'D:/demo', sessionPath: 'D:/demo/demo.jsonl', sessionId: 'uuid-1', turnState: 'idle' },
  }) as unknown as HostSnapshot

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('轨迹页的 system 步骤', () => {
  test('写前预览走同一张卡片（.trace-review 里的 .entry-review），路径按原文显示', () => {
    expect(parseReviewNotice(noticeText)).not.toBeNull()
    const entry = { kind: 'system', id: 1, text: noticeText } as TranscriptEntry
    const { container } = render(
      <RuntimeProvider channel={makeChannel(snapshotOf(entry))}>
        <TraceView />
      </RuntimeProvider>,
    )
    const card = container.querySelector('.trace-review .entry-review')
    expect(card).toBeTruthy()
    expect(card?.querySelector('.entry-review-path')?.textContent).toBe('src/a.ts')
    expect(card?.querySelector('.changes-added')?.textContent).toBe('+1 行')
  })

  test('认不出的短通知仍走一行灰字（不误开卡片）', () => {
    const entry = { kind: 'system', id: 1, text: '这一轮被中断' } as TranscriptEntry
    const { container } = render(
      <RuntimeProvider channel={makeChannel(snapshotOf(entry))}>
        <TraceView />
      </RuntimeProvider>,
    )
    expect(container.querySelector('.entry-review')).toBeNull()
    expect(container.textContent).toContain('这一轮被中断')
  })
})
