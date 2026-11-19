/**
 * 底部状态栏（`ui-statusbar/ui.tsx` 的 `StatusSegments`）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-turn-status-test.mjs` 第 [4] 段（缺口清单 B37）。原探针钉状态栏源码里
 * 「不读 turnStartedAt」「没有 statusbar.turn.elapsed」「步数为 0 时整段不画」；这里真渲染：
 * - 步数为 0 时轮/步那一段不画（即使有 token 读数也只画 token 段）；
 * - 主文案是「N 轮 M 步」，不报本轮用时；
 * - 悬浮卡仍列模型用时 / 工具调用用时 / 首 token / 输出速度（给一份假用量日志）。
 *
 * 不迁的：`turnStartedAt` 契约与宿主快照字段的删除、两条死文案键由 `ui-locale` 死键闸 /
 * 宿主快照契约管；第 [3][5] 段 CSS（.turn-status 分隔线、正文 480 保底、dockDragLimit）
 * 是样式与布局算术，转 shots。
 *
 * @module dsc-ui-statusbar/ui/segments.spec
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** StatusSegments 不直接导出：经插件 apply 收下 `shell.statusbar` 的登记。 */
function segmentsComponent(): () => ReactNode {
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
  const found = registered.find((item) => item.slot === 'shell.statusbar')
  if (found === undefined) throw new Error('statusbar 插件没有登记 shell.statusbar')
  return found.component as () => ReactNode
}

const StatusSegments = segmentsComponent()

/** 快照：status 那一片按用例给。 */
function snapshotOf(status: Record<string, unknown>): HostSnapshot {
  return { entries: [], liveEntries: [], status } as unknown as HostSnapshot
}

function makeChannel(status: Record<string, unknown>): HostChannel {
  return {
    getSnapshot: () => snapshotOf(status),
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(): Promise<T> => Promise.resolve({}) as Promise<T>) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

const mount = (status: Record<string, unknown>): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={makeChannel(status)}>
      <StatusSegments />
    </RuntimeProvider>,
  )

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

beforeEach(() => {
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (op: string): Promise<unknown> =>
      Promise.resolve(
        op === 'sessionUsage'
          ? {
              requests: 2,
              inputTokens: 1000,
              outputTokens: 500,
              cacheHitTokens: 0,
              cacheMissTokens: 0,
              lastInputTokens: 100,
              lastAt: 1,
              llmMs: 5_000,
              ttftMs: 1_000,
              ttftSteps: 2,
              decodeMs: 2_500,
              decodeTokens: 250,
              toolMs: 1_200,
              toolCalls: 2,
            }
          : { ok: true },
      ),
    on: () => () => undefined,
  }
})

afterEach(() => {
  cleanup()
  delete (globalThis as { dscNative?: unknown }).dscNative
})

describe('步数为 0 时轮/步整段不画', () => {
  test('没有进度、没有 token：整条不占位置', async () => {
    const { container } = mount({ turnState: 'working', progress: { turns: 0, steps: 0 } })
    await flush()
    expect(container.querySelector('.segments')).toBeNull()
  })

  test('有 token 但步数为 0：只画 token 段，不画轮/步段（不再为「用时」开口子）', async () => {
    const { container } = mount({
      turnState: 'working',
      progress: { turns: 0, steps: 0 },
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    await flush()
    expect(container.querySelector('.seg-turn')).toBeNull()
    expect(container.querySelector('.seg-tokens')).toBeTruthy()
  })
})

describe('轮/步段与悬浮卡', () => {
  test('主文案是「N 轮 M 步」，不带本轮用时', async () => {
    const { container } = mount({
      turnState: 'working',
      sessionId: 'uuid-1234',
      model: 'deepseek-chat',
      progress: { turns: 2, steps: 3 },
    })
    await flush()
    const trigger = container.querySelector('.seg-turn .ctx-trigger') as HTMLElement
    expect(trigger.textContent).toContain('2 轮 3 步')
    expect(trigger.textContent).not.toContain('用时')
    expect(trigger.getAttribute('title')).toContain('deepseek-chat')
  })

  test('卡片仍列模型用时 / 工具调用用时 / 首 token / 输出速度', async () => {
    const { container } = mount({
      turnState: 'working',
      sessionId: 'uuid-1234',
      model: 'deepseek-chat',
      progress: { turns: 2, steps: 3 },
    })
    await flush()
    const card = container.querySelector('.seg-turn .ctx-card') as HTMLElement
    expect(card.textContent).toContain('模型用时')
    expect(card.textContent).toContain('工具调用用时')
    expect(card.textContent).toContain('首 token 平均')
    expect(card.textContent).toContain('输出速度')
    // 卡里没有「本轮用时（进行中）」这类每秒跳的活读数。
    expect(card.textContent).not.toContain('本轮用时')
  })
})
