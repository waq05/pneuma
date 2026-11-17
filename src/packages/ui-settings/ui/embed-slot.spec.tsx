/**
 * 「分区并进父页」（声明里的 `parent` 位）的渲染段（迁自
 * `scripts/settings-embed-slot-test.mjs` 的界面半，缺口清单 B7）。
 *
 * ## 来源与分层
 *
 * 原探针六段：
 *   [1] 宿主侧 terminal-env 仍注册、builtin、custom=false、parent=general、order/字段不变；
 *   [2] 导航按 parent 链滤掉子分区、父分区还在；
 *   [3] 读写与按钮动作仍按子分区自己的 id 走；
 *   [4] 切换后检测结果跟着刷新（「当前：…」落到新选的那一档）；
 *   [5] ui-settings 里没有 terminal-env / tools-default 字面量；导航/父页/子块/渲染器/重取
 *       五条源码文本钉；
 *   [6] tools-default 与 ui-settings 的中英字典键一一对应。
 *
 * [2] 与 [3] 的「按子分区 id 读写」在 ui 层有真接缝：起真面板，宿主发一张带
 * `parent: 'general'` 的子分区，点父页里的控件，看 `setSettingValue` / `runSettingAction`
 * 收到的 sectionId 是不是子分区自己的。写回后重取分区清单（原探针 [5] 最后一钉）也能
 * 用调用计数观察。这三段迁进 ui 层。
 *
 * **探针保留**，因为下面这些不在渲染层：
 *
 * - [1] 宿主侧声明（terminal-env 的注册、order=6、字段类型表）要起真内核 + terminal-env
 *   插件，属内核/集成层，不是本 spec 的宿主桩；
 * - [4] 「检测结果跟着刷新」验的是 `tools-default` 的 fields() 现算值与 `detectShells()`
 *   的真实探测，宿主桩只会验自己编的回执；
 * - [5] 的源码文本钉（`ui.tsx` 里没有具体插件名、导航 filter / `pages.get` / `GenericFields`
 *   / 两处 `onChanged?.()`）没有运行期等价物——本 spec 只能证明「这一份声明会并进去」，
 *   证明不了「壳里没有硬编另一条路」；
 * - [6] 字典键一一对应是源码/资源审计。
 *
 * @module dsc-ui-settings/ui/embed-slot.spec
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { SettingsField, SettingsSectionView, SettingsValues, UiPluginApi } from '@dsc/ui'
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

/** 父分区：只有一条自己的字段，用来证明子分区是**追加**在末尾。 */
const general: SettingsSectionView = {
  id: 'general',
  title: '通用',
  subtitle: '基础偏好',
  order: 0,
  builtin: true,
  custom: false,
  fields: [{ type: 'switch', key: 'telemetry', label: '匿名统计', help: '发不发' }],
}

/** 子分区：就是 terminal-env 的形态（parent 指向 general）。 */
const terminalEnv: SettingsSectionView = {
  id: 'terminal-env',
  title: '终端环境',
  subtitle: '下一条命令起生效',
  order: 6,
  builtin: true,
  custom: false,
  parent: 'general',
  fields: [
    {
      type: 'select',
      key: 'bashShell',
      label: 'Bash 路径',
      options: [
        { value: 'gitbash', label: 'Git Bash' },
        { value: 'wsl', label: 'WSL' },
      ],
      help: '选一个',
    },
    { type: 'info', label: '检测结果', text: '当前：Git Bash', help: '✓ Git Bash\n✗ WSL' },
    { type: 'switch', key: 'persistent', label: '持久 shell', help: '开不开' },
    { type: 'button', label: '重新检测', action: 'redetect', help: '按了就知道' },
  ] as SettingsField[],
}

/** 一个父分区不存在的悬空 parent：按壳的规则应退回独立导航项。 */
const orphan: SettingsSectionView = {
  id: 'orphan',
  title: '悬空分区',
  order: 7,
  builtin: true,
  custom: false,
  parent: 'not-installed',
  fields: [],
}

const saveCalls: Array<[string, string, unknown]> = []
const actionCalls: Array<[string, string]> = []
let sectionCalls = 0

/** 假宿主通道：只答设置面板会问的几个方法，记录分区重取次数。 */
function makeChannel(): HostChannel {
  const sections = [general, terminalEnv, orphan]
  const values: Record<string, SettingsValues> = {
    general: { telemetry: false },
    'terminal-env': { bashShell: 'gitbash', persistent: false },
    orphan: {},
  }
  const replies: Record<string, unknown> = {
    getSettingsSections: sections,
    getModelConfig: { providers: [], defaultProvider: '', defaultModel: '', temperature: null, configFile: '', credentialsFile: '' },
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
    invoke: (<T,>(method: string, args?: unknown[]): Promise<T> => {
      if (method === 'getSettingsSections') {
        sectionCalls += 1
        return Promise.resolve(sections as T)
      }
      if (method === 'getSectionValues') {
        return Promise.resolve((values[String(args?.[0])] ?? {}) as T)
      }
      if (method === 'setSettingValue') {
        saveCalls.push([String(args?.[0]), String(args?.[1]), args?.[2]])
        values[String(args?.[0])] = { ...values[String(args?.[0])], [String(args?.[1])]: args?.[2] } as SettingsValues
        return Promise.resolve({ ok: true, notice: '已保存' } as T)
      }
      if (method === 'runSettingAction') {
        actionCalls.push([String(args?.[0]), String(args?.[1])])
        return Promise.resolve({ ok: true, notice: '重新检测完成' } as T)
      }
      return Promise.resolve((replies[method] ?? {}) as T)
    }) as HostChannel['invoke'],
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
    await Promise.resolve()
  })
  return rendered
}

const navLabels = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.settings-nav-item .label')].map((node) => node.textContent ?? '')

const embeddedOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector('.settings-embedded[data-section="terminal-env"]') as HTMLElement | null

beforeEach(() => {
  saveCalls.length = 0
  actionCalls.length = 0
  sectionCalls = 0
  // 模块级开合信号在用例之间会留着：先确保是关的（关着时面板不渲染，事件监听仍在）。
  cleanup()
})

afterEach(() => {
  cleanup()
})

describe('导航按 parent 链滤掉子分区', () => {
  test('子分区不单独占导航；父分区还在', async () => {
    const { container } = await openPanel()
    const names = navLabels(container)
    expect(names).toContain('通用')
    expect(names).not.toContain('终端环境')
  })

  test('悬空 parent 退回独立分区（不因一条坏声明把内容藏掉）', async () => {
    const { container } = await openPanel()
    expect(navLabels(container)).toContain('悬空分区')
  })
})

describe('父页按声明把子分区整块画在末尾', () => {
  test('通用页里出现嵌槽：标题、说明与子分区控件齐全，父分区自己的字段也在', async () => {
    const { container } = await openPanel()
    const embedded = embeddedOf(container)
    expect(embedded).not.toBeNull()
    expect(embedded?.querySelector('.settings-group-title')?.textContent).toBe('终端环境')
    expect(embedded?.textContent).toContain('下一条命令起生效')
    // 子分区的四类控件都画出来（select / info / switch / button）。
    expect(embedded?.querySelector('.select-trigger')?.textContent).toContain('Git Bash')
    expect(embedded?.textContent).toContain('当前：Git Bash')
    expect(embedded?.querySelector('button[role="switch"][aria-label="持久 shell"]')).toBeTruthy()
    expect([...(embedded?.querySelectorAll('button') ?? [])].some((node) => node.textContent === '重新检测')).toBe(true)
    // 父分区自己的字段没有被顶掉。
    expect(container.querySelector('button[role="switch"][aria-label="匿名统计"]')).toBeTruthy()
  })
})

describe('嵌槽里的读写与按钮动作仍按子分区自己的 id 走', () => {
  test('点子分区的 switch：setSettingValue 收到 terminal-env，并通知父页重取分区清单', async () => {
    const { container } = await openPanel()
    const before = sectionCalls
    const toggle = embeddedOf(container)?.querySelector('button[role="switch"][aria-label="持久 shell"]') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(toggle)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(saveCalls.at(-1)).toEqual(['terminal-env', 'persistent', true])
    expect(sectionCalls).toBeGreaterThan(before)
  })

  test('点子分区的按钮：runSettingAction 收到 terminal-env/redetect，并再次重取分区清单', async () => {
    const { container } = await openPanel()
    const before = sectionCalls
    const button = [...(embeddedOf(container)?.querySelectorAll('button') ?? [])].find((node) => node.textContent === '重新检测') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(button)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(actionCalls.at(-1)).toEqual(['terminal-env', 'redetect'])
    expect(sectionCalls).toBeGreaterThan(before)
  })
})
