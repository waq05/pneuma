/**
 * 底部状态栏（`ui-statusbar/ui/ui.tsx`）的分支补测（ui 层，真渲染）。
 *
 * 既有 `segments.spec.tsx` 只覆盖「步数为 0 不画 / 主文案 / 悬浮卡四行」。这一份补：
 * 上下文段（圆环、分段条、图例、空分段）、token 段的缓存命中率各档（无明细 / 90% /
 * 满命中 / 99.9x 区分位）、原生桥缺席与拒绝、会话 id / 模型的省略、非法回合状态。
 *
 * @module dsc-ui-statusbar/ui/w11-branches.spec
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, UiPluginApi } from '@dsc/ui'
import zh from '../locale/ui.zh.json'
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

function makeChannel(status: Record<string, unknown>): HostChannel {
  const snapshot = { entries: [], liveEntries: [], status } as unknown as HostSnapshot
  return {
    getSnapshot: () => snapshot,
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
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''
const query = (root: HTMLElement, selector: string): HTMLElement => root.querySelector(selector) as HTMLElement

/** 一条完整的用量日志投影。 */
const usageView = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  requests: 2,
  inputTokens: 1_000,
  outputTokens: 500,
  cacheHitTokens: 900,
  cacheMissTokens: 100,
  lastInputTokens: 100,
  lastAt: 1,
  llmMs: 5_000,
  ttftMs: 1_000,
  ttftSteps: 2,
  decodeMs: 2_500,
  decodeTokens: 250,
  toolMs: 1_200,
  toolCalls: 2,
  ...over,
})

/** 装一块假原生桥；`reply` 为 Error 时调 sessionUsage 直接拒绝。 */
function installNative(reply: Record<string, unknown> | null, mode: 'ok' | 'reject' = 'ok'): void {
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (op: string): Promise<unknown> => {
      if (op !== 'sessionUsage') return Promise.resolve({ ok: true })
      return mode === 'reject' ? Promise.reject(new Error('usage log missing')) : Promise.resolve(reply)
    },
    on: () => () => undefined,
  }
}

beforeEach(() => {
  delete (globalThis as { dscNative?: unknown }).dscNative
})

afterEach(() => {
  cleanup()
  delete (globalThis as { dscNative?: unknown }).dscNative
})

describe('上下文段', () => {
  test('有样本时画圆环 + 百分比 + 四段进度条与图例', async () => {
    installNative(usageView())
    const { container } = mount({
      turnState: 'working',
      sessionId: 'uuid-1234',
      model: 'deepseek-chat',
      progress: { turns: 2, steps: 3 },
      usage: { inputTokens: 1_000, outputTokens: 500 },
      contextWindow: 100_000,
      contextUsed: 45_000,
      contextSegments: { system: 10_000, schema: 5_000, tools: 20_000, prompt: 6_000, assistant: 3_000, thinking: 1_000 },
    })
    await flush()

    const context = query(container, '.seg-context')
    expect(context).not.toBeNull()
    expect(textOf(query(context, '.ctx-trigger'))).toContain('45%')
    expect(query(context, '.ctx-trigger').getAttribute('aria-label')).toBe(
      zh['statusbar.context.aria'].replace('{percent}', '45'),
    )
    // 圆环：底圈 + 进度圈。
    expect(context.querySelectorAll('svg circle')).toHaveLength(2)
    expect(context.querySelectorAll('.ctx-bar-seg')).toHaveLength(4)
    expect(context.querySelectorAll('.ctx-legend-row')).toHaveLength(4)
    expect(textOf(query(context, '.ctx-legend'))).toContain(zh['statusbar.context.system'])
    expect(textOf(query(context, '.ctx-legend'))).toContain(zh['statusbar.context.schema'])
    expect(textOf(query(context, '.ctx-legend'))).toContain(zh['statusbar.context.tools'])
    expect(textOf(query(context, '.ctx-legend'))).toContain(zh['statusbar.context.messages'])
    expect(query(context, '.ctx-bar-fill')).toBeNull()
  })

  test('用量超过窗口：显示值夹在 100%，圆环按满圈画', async () => {
    installNative(usageView({ cacheHitTokens: 0, cacheMissTokens: 0 }))
    const { container } = mount({
      turnState: 'idle',
      progress: { turns: 1, steps: 1 },
      usage: { inputTokens: 10, outputTokens: 0 },
      contextWindow: 100_000,
      contextUsed: 250_000,
    })
    await flush()
    const trigger = query(container, '.seg-context .ctx-trigger')
    expect(textOf(trigger)).toContain('100%')
    // 进度圈的描边长度按 100% 封顶（半径 5.2 → 周长约 32.67）。
    const ring = trigger.querySelectorAll('svg circle')[1]
    expect(ring?.getAttribute('stroke-dasharray')).toMatch(/^32\.6/)
  })

  test('分段全为 0：只画一条填充条，不摆一排 0 图例', async () => {
    installNative(null)
    const { container } = mount({
      turnState: 'idle',
      progress: { turns: 1, steps: 1 },
      usage: { inputTokens: 10, outputTokens: 0 },
      contextWindow: 100_000,
      contextUsed: 2_000,
    })
    await flush()
    const context = query(container, '.seg-context')
    expect(context).not.toBeNull()
    expect(context.querySelector('.ctx-bar-fill')).not.toBeNull()
    expect(context.querySelector('.ctx-legend')).toBeNull()
    expect(context.querySelectorAll('.ctx-bar-seg')).toHaveLength(0)
  })

  test('没有窗口或没有样本：上下文整段不画', async () => {
    installNative(null)
    const zeroWindow = mount({
      turnState: 'idle',
      progress: { turns: 1, steps: 1 },
      usage: { inputTokens: 10, outputTokens: 0 },
      contextWindow: 0,
      contextUsed: 5_000,
    })
    await flush()
    expect(zeroWindow.container.querySelector('.seg-context')).toBeNull()
    cleanup()

    const noSample = mount({ turnState: 'idle', progress: { turns: 1, steps: 1 }, contextWindow: 100_000 })
    await flush()
    expect(noSample.container.querySelector('.seg-context')).toBeNull()
  })
})

describe('token 段的缓存命中率', () => {
  test('日志有明细：90% 命中、未缓存输入与缓存读取两行都在', async () => {
    installNative(usageView({ cacheHitTokens: 900, cacheMissTokens: 100 }))
    const { container } = mount({
      turnState: 'working',
      sessionId: 'uuid-1234',
      progress: { turns: 1, steps: 1 },
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    await flush()
    const tokens = query(container, '.seg-tokens')
    expect(textOf(query(tokens, '.ctx-trigger'))).toContain(
      zh['statusbar.tokens.cacheHit'].replace('{percent}', '90'),
    )
    const card = query(tokens, '.ctx-card')
    expect(textOf(card)).toContain(zh['statusbar.tokens.cacheHitLabel'])
    expect(textOf(card)).toContain(zh['statusbar.tokens.cacheMiss'])
    expect(textOf(card)).toContain(zh['statusbar.tokens.cacheRead'])
    expect(query(tokens, '.ctx-trigger').getAttribute('title')).toContain('90%')
  })

  test('满命中显示 100%，不再走区分位', async () => {
    installNative(usageView({ inputTokens: 1_000, outputTokens: 10, cacheHitTokens: 1_000, cacheMissTokens: 0 }))
    const { container } = mount({
      turnState: 'idle',
      sessionId: 'uuid-1',
      progress: { turns: 1, steps: 1 },
      usage: { inputTokens: 1_000, outputTokens: 10 },
    })
    await flush()
    const trigger = query(container, '.seg-tokens .ctx-trigger')
    expect(textOf(trigger)).toContain(zh['statusbar.tokens.cacheHit'].replace('{percent}', '100'))
  })

  test('差几个 token 的满命中：加小数位，绝不四舍五入成 100%', async () => {
    installNative(
      usageView({ inputTokens: 19_999, outputTokens: 1, cacheHitTokens: 19_999, cacheMissTokens: 1 }),
    )
    const { container } = mount({
      turnState: 'idle',
      sessionId: 'uuid-2',
      progress: { turns: 1, steps: 1 },
      usage: { inputTokens: 19_999, outputTokens: 1 },
    })
    await flush()
    const text = textOf(query(container, '.seg-tokens .ctx-trigger'))
    expect(text).toContain('99.')
    expect(text).not.toContain('100%')
  })

  test('端点没上报缓存明细：退回「输入」行，不编命中率', async () => {
    installNative(null)
    const { container } = mount({
      turnState: 'idle',
      progress: { turns: 1, steps: 1 },
      usage: { inputTokens: 1_000, outputTokens: 500 },
    })
    await flush()
    const tokens = query(container, '.seg-tokens')
    expect(textOf(tokens.querySelector('.ctx-trigger'))).not.toContain(zh['statusbar.tokens.cacheHitLabel'])
    const card = textOf(query(tokens, '.ctx-card'))
    expect(card).toContain(zh['statusbar.tokens.input'])
    expect(card).not.toContain(zh['statusbar.tokens.cacheHitLabel'])
  })
})

describe('轮/步段与降级路径', () => {
  test('原生桥缺席：速度与耗时行整块省略，上下文仍按快照样本画', async () => {
    const { container } = mount({
      turnState: 'thinking',
      sessionId: 'uuid-9999',
      model: 'deepseek-chat',
      progress: { turns: 3, steps: 4 },
      usage: { inputTokens: 10, outputTokens: 5 },
      contextWindow: 64_000,
      contextUsed: 1_000,
    })
    await flush()
    const turn = query(container, '.seg-turn')
    expect(textOf(query(turn, '.ctx-trigger'))).toContain('3 轮 4 步')
    expect(textOf(query(turn, '.ctx-trigger'))).not.toContain('tok/s')
    const card = textOf(query(turn, '.ctx-card'))
    expect(card).not.toContain(zh['statusbar.card.modelTime'])
    expect(card).not.toContain(zh['statusbar.card.toolTime'])
    expect(container.querySelector('.seg-context')).not.toBeNull()
  })

  test('用量日志读失败：不崩、也不画速度', async () => {
    installNative(null, 'reject')
    const { container } = mount({
      turnState: 'working',
      sessionId: 'uuid-err',
      progress: { turns: 1, steps: 1 },
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    await flush()
    expect(textOf(query(container, '.seg-turn .ctx-trigger'))).not.toContain('tok/s')
  })

  test('会话 id 缺失、模型是 unknown：悬浮说明只留状态', async () => {
    const { container } = mount({
      turnState: 'idle',
      model: 'unknown',
      progress: { turns: 1, steps: 2 },
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await flush()
    const title = query(container, '.seg-turn .ctx-trigger').getAttribute('title') ?? ''
    expect(title).toContain(zh['statusbar.turnHint.state'].replace('{state}', zh['statusbar.turn.idle']))
    expect(title).not.toContain('会话')
    expect(title).not.toContain('模型')
  })

  test('非法回合状态与零步数都不画轮/步段', async () => {
    const invalid = mount({
      turnState: 'paused',
      progress: { turns: 2, steps: 2 },
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await flush()
    expect(invalid.container.querySelector('.seg-turn')).toBeNull()
    cleanup()

    const zeroSteps = mount({
      turnState: 'working',
      progress: { turns: 2, steps: 0 },
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await flush()
    expect(zeroSteps.container.querySelector('.seg-turn')).toBeNull()
  })

  test('步数为 0 且既无 token 也无上下文样本：整条不占位置', async () => {
    const { container } = mount({ turnState: 'idle', progress: { turns: 0, steps: 0 } })
    await flush()
    expect(container.querySelector('.segments')).toBeNull()
    expect(textOf(container)).toBe('')
  })
})
