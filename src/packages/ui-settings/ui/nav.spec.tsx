/**
 * 设置导航的分区筛选（`ui.tsx` 的 `HIDDEN_SECTIONS`）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-settings-nav-test.mjs` 整条（缺口清单 B37）。原探针读源码钉
 * `HIDDEN_SECTIONS` 与三处 `.filter` / `.find` / 事件守卫；这里真渲染设置面板：
 * - 宿主仍发「技能」分区，导航与选中查找都把它滤掉（不会露出「未知分区」）；
 * - 侧栏事件带着 `skills` 请它开门时不跳进死分区；
 * - 其余四个手画分区（模型 / 模式 / 用量 / 归档）照旧在链上，点开各自的面板；
 * - 非 builtin 分区不进设置（宿主过滤，原探针第 [4] 段的边界）。
 *
 * 不迁的：第 [2] 段「SkillsGroup / listSkills / setSkillEnabled / IconBolt 不在 ui.tsx 里」与
 * 第 [4] 段「侧栏技能整页入口还在」都是源码文本钉 / 别的插件行为，归代码审查与 skills 包；
 * 宿主分区表（`packages/settings/index.ts`）的 order 同样是宿主侧文本。
 *
 * @module dsc-ui-settings/ui/nav.spec
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { ModelConfigView, SettingsSectionView, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** SettingsPanel 不直接导出：照生产壳装载插件那条路，收下 `shell.header` 的登记。 */
function panelComponent(): () => ReactNode {
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
  const found = registered.find((item) => item.slot === 'shell.header')
  if (found === undefined) throw new Error('settings 插件没有把面板登记进 shell.header')
  return found.component as () => ReactNode
}

const SettingsPanel = panelComponent()

/** 一张宿主分区（只有导航要用的几项）。 */
const sectionOf = (id: string, title: string, order: number, custom = false): SettingsSectionView => ({
  id,
  title,
  order,
  builtin: true,
  custom,
  fields: [],
})

/** 宿主发来的分区表：技能还在（TUI / 旧桌面版还消费它），外加一个非 builtin 的插件分区。 */
const sectionsOf = (): SettingsSectionView[] => [
  sectionOf('general', '通用', 10),
  sectionOf('skills', '技能', 20, true),
  sectionOf('models', '模型', 30, true),
  sectionOf('presets', '模式', 40, true),
  sectionOf('usage', '用量统计', 50, true),
  sectionOf('archive', '归档', 60, true),
  { ...sectionOf('about', '关于', 900), fields: [{ type: 'button', action: 'check-update', label: '检查更新' }] },
  { ...sectionOf('plugin-x', '插件分区', 70), builtin: false },
]

/** 最小可渲染的模型配置（只求 ModelsGroup 不炸，本组不测它的行为）。 */
const modelConfig = (): ModelConfigView => ({
  providers: [
    {
      name: 'deepseek',
      displayName: 'DeepSeek 官方',
      baseUrl: 'https://api.deepseek.com/v1',
      keyRef: 'DEEPSEEK_API_KEY',
      keyConfigured: true,
      models: [
        {
          id: 'deepseek-chat',
          name: 'deepseek-chat',
          contextWindow: 128_000,
          maxTokens: 8_192,
          thinkingLevels: ['off', 'low', 'high', 'max'],
          thinkingParam: 'thinking',
          effortMap: {},
          modalities: ['text'],
        },
      ],
    },
  ],
  defaultProvider: 'deepseek',
  defaultModel: 'deepseek-chat',
  temperature: null,
  configFile: 'D:\\dsc\\config.yaml',
  credentialsFile: 'D:\\dsc\\credentials.yaml',
})

/** 一份有数据的用量统计（UsageGroup 只在 sinceTs 非 null 时画正式面）。 */
const usageStats = (): Record<string, unknown> => {
  const days = [{ date: '2026-11-15', inputTokens: 100, outputTokens: 50, turns: 1, byModel: { 'deepseek/deepseek-chat': 150 } }]
  return {
    sinceTs: 1,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheHitTokens: 0,
    totalCacheMissTokens: 0,
    totalTurns: 1,
    activeDays: 1,
    currentStreakDays: 1,
    longestStreakDays: 1,
    peakDay: days[0],
    days,
    models: [{ key: 'deepseek/deepseek-chat', inputTokens: 100, outputTokens: 50, turns: 1, cacheHitTokens: 0, cacheMissTokens: 0 }],
  }
}

/** 假宿主通道：只答设置面板会问的几个方法。 */
function makeChannel(): HostChannel {
  const replies: Record<string, unknown> = {
    getSettingsSections: sectionsOf(),
    getModelConfig: modelConfig(),
    listPresets: { current: 'default', defaultName: 'default', options: [], droppable: [] },
    listTools: [],
    listArchivedSessions: { items: [], trashDir: 'D:/dsc/trash', trashCount: 0 },
    usageStats: usageStats(),
    runSettingAction: { ok: true, notice: '发现新版本 1.2.1', data: { kind: 'update', version: '1.2.1' } },
  }
  return {
    getSnapshot: () => null,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string): Promise<T> => Promise.resolve(replies[method] ?? {}) as Promise<T>) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

/** 挂面板并把它打开（面板默认关着，侧栏事件是生产里的开门路径）。 */
async function openPanel(): Promise<ReturnType<typeof render>> {
  const rendered = render(
    <RuntimeProvider channel={makeChannel()}>
      <SettingsPanel />
    </RuntimeProvider>,
  )
  await act(async () => {
    window.dispatchEvent(new CustomEvent('shell.settings.open'))
    await Promise.resolve()
    await Promise.resolve()
  })
  return rendered
}

const labels = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.settings-nav-item .label')].map((node) => node.textContent ?? '')

const navItem = (container: HTMLElement, label: string): HTMLElement => {
  const items = [...container.querySelectorAll('.settings-nav-item')] as HTMLElement[]
  const found = items.find((item) => item.textContent?.includes(label))
  if (found === undefined) throw new Error(`导航里没有 ${label}`)
  return found
}

beforeEach(() => {
  // 模块级开合信号在用例之间会留着：先确保是关的（关着时面板不渲染，事件监听仍在）。
  cleanup()
})

afterEach(() => {
  cleanup()
})

describe('导航列表：宿主发着技能分区，壳不列', () => {
  test('技能不在导航里；通用 / 模型 / 模式 / 用量统计 / 归档 / 关于在；非 builtin 分区也不在', async () => {
    const { container } = await openPanel()
    const names = labels(container)
    expect(names).not.toContain('技能')
    expect(names).toEqual(['通用', '模型', '模式', '用量统计', '归档', '关于'])
    expect(names).not.toContain('插件分区')
  })

  test('侧栏事件带 skills 请它开门：不会跳进死分区，仍停在第一个可用分区', async () => {
    const { container } = await openPanel()
    await act(async () => {
      window.dispatchEvent(new CustomEvent('shell.settings.open', { detail: { section: 'skills' } }))
      await Promise.resolve()
    })
    expect(container.querySelector('.settings-nav-item.on .label')?.textContent).toBe('通用')
    // 「空分区」是通用分区自己的正常空态；这里只要求不是「未知分区」。
    expect(container.querySelector('.settings-empty')?.textContent).not.toContain('未知')
    expect(container.querySelector('.settings-main h2')?.textContent).toBe('通用')
  })
})

describe('其余四个手画分区照旧在链上', () => {
  test('逐个点开：模型 / 用量 / 模式 / 归档各自的根节点出现，没有「未知分区」', async () => {
    const { container } = await openPanel()
    const cases: Array<[label: string, selector: string]> = [
      ['模型', '.models-page'],
      ['用量统计', '.usage'],
      ['模式', '.presets'],
      ['归档', '.archived'],
    ]
    for (const [label, selector] of cases) {
      await act(async () => {
        fireEvent.click(navItem(container, label))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(container.querySelector(selector)).toBeTruthy()
      // 空态可以是「还没有自定义模式」这类正常文案；不许落进「未知分区 / 加载失败」。
      expect(container.querySelector('.settings-empty')?.textContent ?? '').not.toContain('未知')
      expect(container.querySelector('.settings-empty')?.textContent ?? '').not.toContain('加载失败')
      expect(container.querySelector('.settings-nav-item.on .label')?.textContent).toBe(label)
    }
  })
})

describe('设置页「关于」的 kind:update 分出口（ui-update-button [5]）', () => {
  test('查到可装新版：就地给「立即更新」；无原生桥时如实说明去哪做', async () => {
    const { container } = await openPanel()
    await act(async () => {
      fireEvent.click(navItem(container, '关于'))
      await Promise.resolve()
      await Promise.resolve()
    })
    const check = [...container.querySelectorAll('button')].find((node) => node.textContent === '检查更新')
    expect(check).toBeTruthy()
    await act(async () => {
      fireEvent.click(check as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    const update = [...container.querySelectorAll('button')].find((node) => node.textContent === '立即更新')
    expect(update).toBeTruthy()
    await act(async () => {
      fireEvent.click(update as HTMLButtonElement)
      await Promise.resolve()
    })
    expect(container.querySelector('.settings-note.error')?.textContent).toContain('就地更新要用桌面外壳的原生桥')
  })
})
