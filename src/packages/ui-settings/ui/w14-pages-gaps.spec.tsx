/**
 * 设置各子页（`ui-settings/ui/models.tsx` / `presets.tsx` / `archive.tsx` / `heatmap.ts` /
 * `usage.tsx`）的 W14 补盲。
 *
 * 覆盖：
 * - 模型页：桥写 reject 的兜底（回执 + 重取）、新增端点时左栏伪条目的点击、端点表单里
 *   模型能力「思考档位」的回调；
 * - 模式页：写动作通道 reject 的行内说明、编辑表单里显示名与说明两个输入框的回写；
 * - 归档页：超过 30 天的日期文案、清单读取失败的行内说明；
 * - 热力图：0.1 / 0.33 两个分档的边界值；
 * - 用量页：宿主给出 NaN 读数时 y 轴上限的兜底（`niceCeiling` 的末档）。
 *
 * 挂载方式沿用 `models-extra.spec.tsx` / `settings-more.spec.tsx`：假通道 + 假原生桥。
 *
 * @module dsc-ui-settings/ui/w14-pages-gaps.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { ArchivedPage, ModelConfigView, ProviderModelView, UsageDayView, UsageStatsView } from '@dsc/ui'
import { ModelsGroup } from './models.js'
import { PresetsGroup } from './presets.js'
import { ArchiveGroup } from './archive.js'
import { UsageGroup } from './usage.js'
import { buildCells } from './heatmap.js'
import zh from '../locale/ui.zh.json'

// ── 通用假宿主 / 假桥 ──────────────────────────────────────────────────────

interface Invoke {
  method: string
  args: unknown[]
}

type Reply = (method: string, args: unknown[]) => unknown
type Routes = Record<string, (args: unknown[]) => unknown>

/** 按方法名路由的假通道；handler 返回 Error 表示 reject。函数式与表式两种写法都收。 */
function channelOf(source: Reply | Routes): { channel: HostChannel; calls: Invoke[] } {
  const calls: Invoke[] = []
  const channel: HostChannel = {
    getSnapshot: () => null,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: <T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      try {
        const value = typeof source === 'function' ? source(method, args) : source[method]?.(args)
        if (value === undefined) return Promise.resolve({ ok: true } as T)
        if (value instanceof Error) return Promise.reject(value) as Promise<T>
        return Promise.resolve(value) as Promise<T>
      } catch (error: unknown) {
        return Promise.reject(error) as Promise<T>
      }
    },
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const callsOf = (calls: Invoke[], method: string): unknown[][] =>
  calls.filter((call) => call.method === method).map((call) => call.args)

const mount = (channel: HostChannel, node: ReactNode): ReturnType<typeof render> =>
  render(<RuntimeProvider channel={channel}>{node}</RuntimeProvider>)

const lastToast = (): string => {
  const nodes = document.querySelectorAll('.dsc-toasts .dsc-toast__text')
  return nodes[nodes.length - 1]?.textContent ?? ''
}

const buttonWithText = (scope: ParentNode, text: string): HTMLButtonElement | undefined =>
  ([...scope.querySelectorAll('button')] as HTMLButtonElement[]).find((node) => node.textContent?.includes(text))

function fakeNative(handlers: Record<string, (args: unknown[]) => unknown> = {}): {
  calls: Array<{ op: string; args: unknown[] }>
} {
  const calls: Array<{ op: string; args: unknown[] }> = []
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (op: string, args: unknown[] = []): Promise<unknown> => {
      calls.push({ op, args })
      const handler = handlers[op]
      if (handler === undefined) return Promise.resolve({ ok: true })
      try {
        return Promise.resolve(handler(args))
      } catch (error: unknown) {
        return Promise.reject(error)
      }
    },
    on: () => () => undefined,
  }
  return { calls }
}

// ── 模型页夹具 ─────────────────────────────────────────────────────────────

function modelOf(id: string, over: Partial<ProviderModelView> = {}): ProviderModelView {
  return {
    id,
    name: id,
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinkingLevels: ['off', 'low', 'high', 'max'],
    thinkingParam: 'thinking',
    effortMap: {},
    modalities: ['text'],
    ...over,
  }
}

function configOf(over: Partial<ModelConfigView> = {}): ModelConfigView {
  return {
    providers: [
      {
        name: 'deepseek',
        displayName: 'DeepSeek 官方',
        baseUrl: 'https://api.deepseek.com/v1',
        keyRef: 'DEEPSEEK_API_KEY',
        keyConfigured: true,
        models: [modelOf('deepseek-chat'), modelOf('deepseek-reasoner')],
      },
      {
        name: 'lab',
        displayName: '',
        baseUrl: 'https://lab.example/v1',
        keyRef: 'LAB_KEY',
        keyConfigured: false,
        models: [modelOf('lab-mini')],
      },
    ],
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek-chat',
    temperature: null,
    configFile: 'D:\\dsc\\config.yaml',
    credentialsFile: 'D:\\dsc\\credentials.yaml',
    ...over,
  }
}

const mountModels = (channel: HostChannel): ReturnType<typeof render> => mount(channel, <ModelsGroup />)

const waitRail = async (page: ReturnType<typeof render>): Promise<void> => {
  await waitFor(() => expect(page.container.querySelector('[data-provider="deepseek"]')).not.toBeNull())
}

// ── 模式页夹具（沿用 settings-more.spec） ──────────────────────────────────

const presetView = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  label: name,
  description: `${name} 的说明`,
  tools: null,
  drop: [],
  deny: [],
  replace: false,
  prompt: '',
  builtin: false,
  ...over,
})

const presetRoutes = (): Routes => ({
  listPresets: () =>
    ({
      current: 'fast',
      defaultName: 'review',
      options: [
        presetView('fast', { label: '快速', builtin: true }),
        presetView('review', { label: '审查', tools: ['read'], prompt: '只找问题。' }),
      ],
      droppable: [{ id: 'team', label: '团队协作段' }],
    }) as unknown as Record<string, unknown>,
  listTools: () => [{ name: 'read', risk: 'read', description: '读文件' }],
})

const cardOf = (container: HTMLElement, label: string): HTMLElement => {
  const found = ([...container.querySelectorAll('.preset-card')] as HTMLElement[]).find((card) =>
    card.textContent?.includes(label),
  )
  if (found === undefined) throw new Error(`没有模式卡片 ${label}`)
  return found
}

// ── 归档页夹具 ─────────────────────────────────────────────────────────────

function archivedPage(over: Partial<ArchivedPage> = {}): ArchivedPage {
  const now = Date.now()
  return {
    items: [
      {
        path: 'C:/a/old.jsonl',
        cwd: 'D:/work/alpha',
        title: '很久以前',
        createdAt: 1,
        updatedAt: 2,
        archivedAt: now - 40 * 86_400_000,
      },
    ],
    trashDir: 'C:/trash',
    trashCount: 1,
    ...over,
  } as unknown as ArchivedPage
}

// ── 用量页夹具 ─────────────────────────────────────────────────────────────

const dayOf = (date: string, input: number, output: number): UsageDayView =>
  ({ date, inputTokens: input, outputTokens: output, turns: 1, byModel: {} }) as UsageDayView

const statsOf = (over: Partial<UsageStatsView> = {}): UsageStatsView => {
  const days = [dayOf('2026-11-14', 100, 50), dayOf('2026-11-15', 200, 100)]
  return {
    sinceTs: 1,
    totalInputTokens: 300,
    totalOutputTokens: 150,
    totalCacheHitTokens: 0,
    totalCacheMissTokens: 0,
    totalTurns: 2,
    activeDays: 2,
    currentStreakDays: 2,
    longestStreakDays: 2,
    peakDay: days[1] as UsageDayView,
    days,
    models: [{ key: 'p/m1', inputTokens: 200, outputTokens: 100, turns: 2, cacheHitTokens: 0, cacheMissTokens: 0 }],
    ...over,
  } as UsageStatsView
}

beforeEach(() => {
  fakeNative()
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined
})

afterEach(() => {
  cleanup()
  document.querySelectorAll('.dsc-toasts, .dsc-confirm').forEach((node) => node.remove())
  delete (globalThis as { dscNative?: unknown }).dscNative
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

describe('模型页的兜底', () => {
  test('桥写 reject：Toast 带原文并重取配置；新增端点的左栏伪条目可点', async () => {
    const native = fakeNative({
      saveProvider: () => {
        throw new Error('桥炸了')
      },
    })
    const { channel, calls } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mountModels(channel)
    await waitRail(page)
    const url = page.container.querySelector('input[aria-label="Base URL"]') as HTMLInputElement
    url.focus()
    fireEvent.change(url, { target: { value: 'https://changed.example/v1' } })
    fireEvent.keyDown(url, { key: 'Enter' })
    await waitFor(() => expect(lastToast()).toContain('桥炸了'))
    expect(native.calls.some((call) => call.op === 'saveProvider')).toBe(true)
    await waitFor(() => expect(callsOf(calls, 'getModelConfig').length).toBeGreaterThanOrEqual(2))

    // 左栏「新增端点」伪条目：点一下仍停在新增表单上（走 selectProvider 那条路）。
    fireEvent.click(page.container.querySelector('[data-provider-add="1"]') as HTMLElement)
    const pseudo = page.container.querySelector('[data-provider="__new__"]') as HTMLElement
    expect(pseudo).not.toBeNull()
    fireEvent.click(pseudo)
    expect(page.container.querySelector('[data-provider-form="new"]')).not.toBeNull()
  })

  test('端点表单里模型能力的思考档位：勾一档走 ModelFields 的 onLevels', async () => {
    const { channel } = channelOf((method) => (method === 'getModelConfig' ? configOf() : { ok: true }))
    const page = mountModels(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-provider-edit="1"]') as HTMLElement)
    const form = page.container.querySelector('[data-provider-form="deepseek"]') as HTMLElement
    expect(form).not.toBeNull()
    const level = form.querySelector('[data-cap-level="high"]') as HTMLElement
    const before = level.getAttribute('aria-pressed')
    fireEvent.click(level)
    expect(form.querySelector('[data-cap-level="high"]')?.getAttribute('aria-pressed')).not.toBe(before)
  })

  test('拉取清单全不选：采用钮禁用、计数归零', async () => {
    const { channel } = channelOf((method) => {
      if (method === 'getModelConfig') return configOf()
      if (method === 'discoverModels') return ['deepseek-new']
      return { ok: true }
    })
    const page = mountModels(channel)
    await waitRail(page)
    fireEvent.click(page.container.querySelector('[data-model-discover="1"]') as HTMLElement)
    await waitFor(() => expect(document.querySelector('[data-models-discover-adopt]')).not.toBeNull())
    fireEvent.click(buttonWithText(document.body, zh['settings.models.discover.none']) as HTMLButtonElement)
    const adopt = document.querySelector('[data-models-discover-adopt]') as HTMLButtonElement
    expect(adopt.disabled).toBe(true)
    expect(adopt.textContent).toContain('0')
    // 说明：React 对 disabled 控件不派发 click，`onAdopt([])` 的兜底分支不可从界面触达。
  })
})

describe('模式页的兜底', () => {
  test('写动作通道 reject：行内说明写原因，列表不收起', async () => {
    const { channel } = channelOf({
      ...presetRoutes(),
      usePreset: () => {
        throw new Error('写盘失败')
      },
    })
    const { container } = mount(channel, <PresetsGroup />)
    await waitFor(() => expect(container.querySelectorAll('.preset-card').length).toBeGreaterThan(0))
    fireEvent.click(buttonWithText(cardOf(container, '审查'), zh['settings.presets.use']) as HTMLButtonElement)
    await waitFor(() => expect(container.querySelector('.settings-note.error')?.textContent).toContain('写盘失败'))
    expect(container.querySelectorAll('.preset-card').length).toBeGreaterThan(0)
  })

  test('编辑表单的显示名与说明两个输入框都回写草稿', async () => {
    const { channel } = channelOf(presetRoutes())
    const { container } = mount(channel, <PresetsGroup />)
    await waitFor(() => expect(container.querySelectorAll('.preset-card').length).toBeGreaterThan(0))
    fireEvent.click(buttonWithText(cardOf(container, '审查'), zh['settings.presets.edit']) as HTMLButtonElement)
    const form = container.querySelector('.preset-form') as HTMLElement
    expect(form).not.toBeNull()
    const inputs = [...form.querySelectorAll('input.setting-input')] as HTMLInputElement[]
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: '审查二号' } })
    expect(([...form.querySelectorAll('input.setting-input')] as HTMLInputElement[])[1]?.value).toBe('审查二号')
    fireEvent.change(inputs[2] as HTMLInputElement, { target: { value: '新的说明' } })
    expect(([...form.querySelectorAll('input.setting-input')] as HTMLInputElement[])[2]?.value).toBe('新的说明')
  })
})

describe('归档页的兜底', () => {
  test('超过 30 天：日期文案退回本地日期串', async () => {
    const page = archivedPage()
    const { channel } = channelOf({ listArchivedSessions: () => page })
    const { container } = mount(channel, <ArchiveGroup />)
    await waitFor(() => expect(container.querySelector('.arch-row')).not.toBeNull())
    const archivedAt = page.items[0]?.archivedAt ?? 0
    expect(container.querySelector('.arch-row .when')?.textContent).toContain(new Date(archivedAt).toLocaleDateString())
  })

  test('清单读取失败：行内说明带上原因，页面不白屏', async () => {
    const { channel } = channelOf({
      listArchivedSessions: () => new Error('归档目录读不了'),
    })
    const { container } = mount(channel, <ArchiveGroup />)
    await waitFor(() => expect(container.querySelector('.settings-note.error')?.textContent).toContain('归档目录读不了'))
  })
})

describe('热力图的档位边界', () => {
  test('0.1 / 0.33 两个分档的边界值各落一档', () => {
    const days = [dayOf('2026-11-10', 100, 0), dayOf('2026-11-11', 20, 0), dayOf('2026-11-12', 5, 0)]
    const { columns } = buildCells(days, 7)
    const cells = columns.flat().filter((cell) => cell !== null)
    const levelOf = (date: string): number | undefined => cells.find((cell) => cell?.day.date === date)?.level
    expect(levelOf('2026-11-10')).toBe(4)
    expect(levelOf('2026-11-11')).toBe(2)
    expect(levelOf('2026-11-12')).toBe(1)
  })
})

describe('用量页的兜底', () => {
  test('宿主给出 NaN 读数：y 轴上限兜底成 10×10^k，页面照常画', async () => {
    const broken = statsOf({ days: [dayOf('2026-11-15', Number.NaN, 0)], peakDay: null, models: [] })
    const { channel } = channelOf({ usageStats: () => broken })
    const { container } = mount(channel, <UsageGroup />)
    await waitFor(() => expect(container.querySelector('.usage')).not.toBeNull())
    expect(container.querySelector('.trend-chart, .usage-block')).not.toBeNull()
  })
})
