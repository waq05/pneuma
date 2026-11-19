/**
 * 插件页（`ui-plugins/ui/ui.tsx`）的交互段（ui 层，真渲染）。
 *
 * 照壳装载插件那条路收下 `shell.page` 的组件，放进 RuntimeProvider + 假宿主通道：
 * 分组与「展开更多」、卡片启停、详情页来回、第三方信任卡的披露与确认、组合包开关、
 * 读清单/读信任失败时的常驻提示。真装卸与产物扫描归宿主。
 *
 * @module dsc-ui-plugins/ui/ui.spec
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, setShellPage, type HostChannel } from '@dsc/ui-runtime'
import type { HostHello, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** PluginsPage 不直接导出：照壳装载插件那条路，收下 `shell.page` 的登记。 */
function pluginsPage(): ComponentType {
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
  const found = registered.find((item) => item.slot === 'shell.page')
  if (found === undefined) throw new Error('plugins 插件没有把页面登记进 shell.page')
  return found.component as ComponentType
}

const PluginsPage = pluginsPage()

interface PluginRow {
  file: string
  name: string
  source: 'builtin' | 'external'
  description: string
  enabled: boolean
  toggleable: boolean
  experimental?: boolean
  settingsSection?: string
  apiVersion?: number
  bundle?: string
  clientCapabilities?: string[]
  problem?: string
}

function builtin(file: string, overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    file,
    name: file,
    source: 'builtin',
    description: `${file} 的说明`,
    enabled: true,
    toggleable: true,
    ...overrides,
  }
}

const ROWS: PluginRow[] = [
  {
    file: 'my.js',
    name: 'my-plugin',
    source: 'external',
    description: '自己的插件',
    enabled: true,
    toggleable: true,
  },
  builtin('tools-default', { settingsSection: 'tools-default' }),
  builtin('ui-status'),
  builtin('exp-one', { experimental: true }),
  builtin('kernel-core', { toggleable: false }),
  ...Array.from({ length: 11 }, (_, index) => builtin(`off-${String(index + 1)}`)),
]

interface TrustRow {
  name: string
  key?: string
  origin?: 'package'
  version?: string
  profile?: string
  api?: string
  platforms: string[]
  trusted: boolean
  trustedAt?: number
  enabled: boolean
  problem?: string
  problemKind?: 'manifest' | 'clash' | 'version' | 'artifact' | 'stale'
}

const TRUSTS: TrustRow[] = [
  { name: 'ext-ui', platforms: ['web'], trusted: false, enabled: false, api: '^1.0.0' },
  { name: 'pkg-ui', key: 'pkg-ui/ui/client.js', origin: 'package', version: '1.2.0', profile: 'default', platforms: ['web'], trusted: true, enabled: true },
]

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
  nativeCalls: Array<{ op: string; args: unknown[] }>
}

function harnessOf(overrides: { plugins?: unknown; trusts?: unknown } = {}): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const nativeCalls: Array<{ op: string; args: unknown[] }> = []
  const replies: Record<string, unknown> = {
    listPlugins: overrides.plugins ?? ROWS,
    listUiTrust: overrides.trusts ?? TRUSTS,
    setPluginEnabled: { ok: true },
    getSettingsSections: [],
    getSectionValues: {},
  }
  const channel: HostChannel = {
    getSnapshot: () => null,
    getHello: () => ({ host: { name: 'web', version: '1.0.0' } }) as unknown as HostHello,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      const reply = replies[method]
      if (reply instanceof Error) return Promise.reject(reply)
      return Promise.resolve(reply ?? { ok: true }) as Promise<T>
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (op: string, args: unknown[] = []): Promise<unknown> => {
      nativeCalls.push({ op, args })
      if (op === 'setUiTrust') return Promise.resolve({ ok: true, notice: '信任了' })
      if (op === 'installPlugin') return Promise.resolve([])
      return Promise.resolve({ ok: true })
    },
    on: () => () => undefined,
  }
  return { channel, calls, nativeCalls }
}

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <PluginsPage />
    </RuntimeProvider>,
  )

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''

beforeEach(() => {
  setShellPage('plugins')
})

afterEach(() => {
  cleanup()
  setShellPage(null)
  delete (globalThis as { dscNative?: unknown }).dscNative
})

describe('分组与卡片', () => {
  test('按来源分七段；官方超过 10 条只画前 10，点「展开更多」全给', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()

    // 自定义 1 + 官方前 10 + 实验 1 + 界面单元 1 + 内核 1 = 14。
    expect(container.querySelectorAll('.plugin-grid .plugin-row')).toHaveLength(14)
    const more = container.querySelector('.plugin-more') as HTMLElement
    expect(more).not.toBeNull()
    fireEvent.click(more)
    // 官方 12 条全出来（多 2 条；ui-status 归界面单元那一组，不算官方）。
    expect(container.querySelectorAll('.plugin-grid .plugin-row')).toHaveLength(16)
  })

  test('整卡点进详情；详情里仍能启停，返回回列表', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()

    const card = container.querySelector('.plugin-row[data-plugin="my.js"]') as HTMLElement
    fireEvent.click(card)
    expect(container.querySelector('.plugin-detail')).not.toBeNull()
    expect(textOf(container.querySelector('.plugin-detail'))).toContain('my-plugin')

    fireEvent.click(container.querySelector('.plugin-detail-head .switch') as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setPluginEnabled', args: ['my.js', false] })

    fireEvent.click(container.querySelector('.plugin-back') as HTMLElement)
    expect(container.querySelector('.plugin-detail')).toBeNull()
    expect(container.querySelector('.plugin-row[data-plugin="my.js"]')).not.toBeNull()
  })

  test('卡片开关按 file 写；内核行锁定不发请求', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()

    const card = container.querySelector('.plugin-row[data-plugin="tools-default"]') as HTMLElement
    fireEvent.click(card.querySelector('.switch') as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setPluginEnabled', args: ['tools-default', false] })

    const kernel = container.querySelector('.plugin-row[data-plugin="kernel-core"]') as HTMLElement
    expect((kernel.querySelector('.switch') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(kernel.querySelector('.switch') as HTMLElement)
    await flush()
    expect(harness.calls.filter((call) => call.method === 'setPluginEnabled')).toHaveLength(1)
  })
})

describe('第三方与组合包', () => {
  test('未信任卡展开能力披露；确认走原生桥 setUiTrust，成功后重读信任清单', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()

    const card = container.querySelector('[data-trust="ext-ui"]') as HTMLElement
    const review = card.querySelector('.btn-primary') as HTMLElement
    fireEvent.click(review)
    expect(card.querySelector('.trust-disclosure')).not.toBeNull()
    expect(textOf(card.querySelector('.trust-disclosure'))).toContain('^1.0.0')

    fireEvent.click(card.querySelector('.trust-actions .btn-primary') as HTMLElement)
    await flush()
    expect(harness.nativeCalls).toContainEqual({ op: 'setUiTrust', args: ['ext-ui'] })
    expect(harness.calls.filter((call) => call.method === 'listUiTrust').length).toBeGreaterThanOrEqual(2)
  })

  test('已信任的组合包用宿主给的 key 启停（没给才回落默认形状）', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()

    const pkg = container.querySelector('[data-trust="pkg-ui"]') as HTMLElement
    fireEvent.click(pkg.querySelector('.switch') as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setPluginEnabled', args: ['pkg-ui/ui/client.js', false] })

    // 组合包没有「查看并信任」，但有版本与 profile 徽标。
    expect(pkg.querySelector('.btn-primary')).toBeNull()
    expect(textOf(pkg)).toContain('v1.2.0')
    expect(textOf(pkg)).toContain('profile default')
  })

  test('装不上的行按宿主档位说「下一步」，不是只丢一句 problem', async () => {
    const harness = harnessOf({
      trusts: [
        {
          name: 'broken-ui',
          platforms: ['web'],
          trusted: false,
          enabled: false,
          problem: 'api 区间对不上',
          problemKind: 'version',
        },
      ],
    })
    const { container } = mount(harness)
    await flush()
    const card = container.querySelector('[data-trust="broken-ui"]') as HTMLElement
    expect(card.querySelector('.trust-next')).not.toBeNull()
    expect(textOf(card)).toContain('api 区间对不上')
  })
})

describe('读失败', () => {
  test('清单读不到：页面上常驻提示；信任清单读不到：信任组下面单独说', async () => {
    const harness = harnessOf({ plugins: new Error('ECONNREFUSED host'), trusts: new Error('ENOENT trust.json') })
    const { container } = mount(harness)
    await flush()
    const notes = [...container.querySelectorAll('.plugins-empty')].map((note) => textOf(note))
    expect(notes).toHaveLength(2)
    expect(notes.every((text) => text.includes('连不上宿主'))).toBe(true)
    expect(container.textContent).not.toContain('ENOENT')
  })
})
