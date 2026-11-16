/**
 * 插件页（`ui-plugins/ui/ui.tsx`）的补充分支（ui 层，真渲染）。
 *
 * `ui.spec.tsx` 已经钉住七段分组、展开更多、详情来回、信任披露、组合包开关与读失败。
 * 这里只补它没走到的角落：外部/实验/界面单元各自的展开、安装与重启的桥调用、
 * 桥缺席时的降级、确认失败与写入中、启停失败回滚、老宿主行的键回落与徽标、
 * 组合包与未知问题档的「下一步」、详情页配置的读/写/动作/复制/失败。
 *
 * @module dsc-ui-plugins/ui/plugins-extra.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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

function external(file: string, overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    file,
    name: file,
    source: 'external',
    description: `${file} 的说明`,
    enabled: true,
    toggleable: true,
    ...overrides,
  }
}

interface TrustRow {
  name: string
  key?: string
  origin?: 'third-party' | 'package'
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

type Handler = (args: unknown[]) => unknown
type Reply = unknown | Handler

interface HarnessOptions {
  plugins?: unknown
  trusts?: unknown
  replies?: Record<string, Reply>
  /** `null` = 页面里没有原生桥（浏览器 / 远程壳）。 */
  native?: Record<string, Reply> | null
}

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
  nativeCalls: Array<{ op: string; args: unknown[] }>
}

const BASE_ROWS: PluginRow[] = [builtin('tools-default', { settingsSection: 'tools-default' })]

const BASE_TRUSTS: TrustRow[] = [
  { name: 'ext-ui', platforms: ['web'], trusted: false, enabled: false, api: '^1.0.0' },
]

function harnessOf(options: HarnessOptions = {}): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const nativeCalls: Array<{ op: string; args: unknown[] }> = []
  const replies: Record<string, Reply> = {
    listPlugins: options.plugins ?? BASE_ROWS,
    listUiTrust: options.trusts ?? BASE_TRUSTS,
    setPluginEnabled: { ok: true },
    setSettingValue: { ok: true },
    runSettingAction: { ok: true },
    getSettingsSections: [],
    getSectionValues: {},
    ...options.replies,
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
      const reply = replies[method] ?? { ok: true }
      try {
        const value = typeof reply === 'function' ? (reply as Handler)(args) : reply
        if (value instanceof Error) return Promise.reject(value) as Promise<T>
        return Promise.resolve(value) as Promise<T>
      } catch (error) {
        return Promise.reject(error) as Promise<T>
      }
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }

  if (options.native === null) {
    delete (globalThis as { dscNative?: unknown }).dscNative
  } else {
    const ops: Record<string, Reply> = {
      setUiTrust: { ok: true, notice: '信任了' },
      installPlugin: [],
      restartHost: { ok: true },
      openPath: '',
      ...options.native,
    }
    ;(globalThis as { dscNative?: unknown }).dscNative = {
      version: 1,
      call: (op: string, args: unknown[] = []): Promise<unknown> => {
        nativeCalls.push({ op, args })
        const reply = ops[op] ?? { ok: true }
        try {
          const value = typeof reply === 'function' ? (reply as Handler)(args) : reply
          if (value instanceof Error) return Promise.reject(value)
          return Promise.resolve(value)
        } catch (error) {
          return Promise.reject(error)
        }
      },
      on: () => () => undefined,
    }
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

/** 等 setTimeout 里的刷新（安装/启停成功后的 600ms 重取）。 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const textOf = (element: Element | null): string => element?.textContent ?? ''
const toastTexts = (): string[] =>
  [...document.querySelectorAll('.dsc-toast__text')].map((node) => textOf(node))

beforeEach(() => {
  setShellPage('plugins')
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: (): void => undefined,
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(() => Promise.resolve()) },
  })
})

afterEach(() => {
  cleanup()
  setShellPage(null)
  document.body.innerHTML = ''
  delete (globalThis as { dscNative?: unknown }).dscNative
})

describe('分组的展开边界', () => {
  test('自定义超过 10 条：展开其余 N 个 / 收起；空描述、组合包与客户端能力有各自落点', async () => {
    const rows = Array.from({ length: 11 }, (_, index) => external(`ext-${String(index)}.js`))
    rows[0] = external('ext-0.js', {
      description: '',
      bundle: 'bundle-a',
      clientCapabilities: ['toast', 'native'],
      settingsSection: 'ext-sec',
    })
    const harness = harnessOf({ plugins: rows })
    const { container } = mount(harness)
    await flush()

    expect(container.querySelectorAll('.plugin-grid .plugin-row')).toHaveLength(10)
    const more = container.querySelector('.plugin-more') as HTMLElement
    expect(textOf(more)).toContain('展开其余 1 个')
    fireEvent.click(more)
    expect(container.querySelectorAll('.plugin-grid .plugin-row')).toHaveLength(11)
    expect(textOf(container.querySelector('.plugin-more'))).toContain('收起')
    fireEvent.click(container.querySelector('.plugin-more') as HTMLElement)
    expect(container.querySelectorAll('.plugin-grid .plugin-row')).toHaveLength(10)

    const first = container.querySelector('.plugin-row[data-plugin="ext-0.js"]') as HTMLElement
    expect(textOf(first)).toContain('ext-0.js · 无描述')
    expect(textOf(first)).toContain('组合包 bundle-a')
    expect(textOf(first)).toContain('界面扩展（dsh 客户端插件）：toast、native · 只列出，不装载')
    expect(first.querySelector('[data-client-capabilities]')?.getAttribute('data-client-capabilities')).toBe(
      'toast,native',
    )
    expect(first.querySelector('.icon-btn')?.getAttribute('aria-label')).toBe('配置 ext-0.js')
  })

  test('实验与界面单元各自一个展开键：翻一段不拉开另一段', async () => {
    const rows = [
      builtin('tools-one'),
      ...Array.from({ length: 11 }, (_, index) => builtin(`exp-${String(index)}`, { experimental: true })),
      ...Array.from({ length: 11 }, (_, index) => builtin(`ui-${String(index)}`)),
    ]
    const harness = harnessOf({ plugins: rows })
    const { container } = mount(harness)
    await flush()

    const count = (prefix: string): number =>
      container.querySelectorAll(`.plugin-row[data-plugin^="${prefix}"]`).length
    expect(count('exp-')).toBe(10)
    expect(count('ui-')).toBe(10)
    // 只有实验与界面单元两段超过 10 条（官方只有 1 条）。
    expect(container.querySelectorAll('.plugin-more')).toHaveLength(2)
    // 没有外部插件时给空态卡。
    expect(textOf(container.querySelector('.empty-card'))).toContain('还没有外部插件')

    fireEvent.click(container.querySelectorAll('.plugin-more')[0] as HTMLElement)
    expect(count('exp-')).toBe(11)
    expect(count('ui-')).toBe(10)

    fireEvent.click(container.querySelectorAll('.plugin-more')[1] as HTMLElement)
    expect(count('ui-')).toBe(11)
    expect(count('exp-')).toBe(11)
  })
})

describe('页头的原生桥动作', () => {
  test('添加插件：走 installPlugin，成功提示安装结果并在 600ms 后重取清单', async () => {
    const harness = harnessOf({ native: { installPlugin: ['a.js', 'b.js'] } })
    const { container } = mount(harness)
    await flush()
    const before = harness.calls.filter((call) => call.method === 'listPlugins').length

    fireEvent.click(container.querySelector('.plugins-add') as HTMLElement)
    await flush()
    expect(harness.nativeCalls).toContainEqual({ op: 'installPlugin', args: [] })
    expect(toastTexts().some((text) => text.includes('已安装 a.js、b.js'))).toBe(true)

    await act(async () => {
      await sleep(650)
    })
    await flush()
    expect(harness.calls.filter((call) => call.method === 'listPlugins').length).toBe(before + 1)
  })

  test('添加插件的空返回不提示；安装抛错时给人话', async () => {
    const empty = harnessOf({ native: { installPlugin: [] } })
    const first = mount(empty)
    await flush()
    fireEvent.click(first.container.querySelector('.plugins-add') as HTMLElement)
    await flush()
    expect(toastTexts()).toHaveLength(0)

    cleanup()
    const failing = harnessOf({ native: { installPlugin: new Error('选择器打不开') } })
    const second = mount(failing)
    await flush()
    fireEvent.click(second.container.querySelector('.plugins-add') as HTMLElement)
    await flush()
    expect(toastTexts().some((text) => text.includes('选择器打不开'))).toBe(true)
  })

  test('重启内核：确认框点确认才调 restartHost；点取消不调', async () => {
    const harness = harnessOf()
    mount(harness)
    await flush()

    fireEvent.click(document.querySelector('[aria-label="重启内核"]') as HTMLElement)
    const dialog = document.querySelector('.dsc-confirm')
    expect(dialog).not.toBeNull()
    expect(textOf(dialog)).toContain('正在运行的回合会被打断')
    fireEvent.click(dialog?.querySelector('[data-variant="destructive"]') as HTMLElement)
    await flush()
    expect(harness.nativeCalls).toContainEqual({ op: 'restartHost', args: [] })

    cleanup()
    const cancelled = harnessOf()
    mount(cancelled)
    await flush()
    fireEvent.click(document.querySelector('[aria-label="重启内核"]') as HTMLElement)
    fireEvent.click(document.querySelector('.dsc-confirm [data-variant="secondary"]') as HTMLElement)
    await flush()
    expect(cancelled.nativeCalls.some((call) => call.op === 'restartHost')).toBe(false)
  })

  test('浏览器里没有原生桥：重启钮置灰并说明；添加与信任确认给「只在桌面版」', async () => {
    const harness = harnessOf({ native: null })
    const { container } = mount(harness)
    await flush()

    const restart = container.querySelector('[aria-label="重启内核"]') as HTMLButtonElement
    expect(restart.disabled).toBe(true)
    expect(restart.getAttribute('data-tip')).toContain('只在桌面版')

    fireEvent.click(container.querySelector('.plugins-add') as HTMLElement)
    await flush()
    expect(toastTexts().some((text) => text.includes('装插件来自桌面外壳的文件选择器'))).toBe(true)

    const card = container.querySelector('[data-trust="ext-ui"]') as HTMLElement
    fireEvent.click(card.querySelector('.btn-primary') as HTMLElement)
    fireEvent.click(card.querySelector('.trust-actions .btn-primary') as HTMLElement)
    await flush()
    expect(toastTexts().some((text) => text.includes('信任确认要写'))).toBe(true)
  })
})

describe('信任卡的边界', () => {
  test('披露可取消收起；确认失败（ok:false）报错、按钮恢复、不重读信任清单', async () => {
    const harness = harnessOf({ native: { setUiTrust: { ok: false, error: '写盘失败' } } })
    const { container } = mount(harness)
    await flush()

    const card = container.querySelector('[data-trust="ext-ui"]') as HTMLElement
    fireEvent.click(card.querySelector('.btn-primary') as HTMLElement)
    expect(card.querySelector('.trust-disclosure')).not.toBeNull()
    fireEvent.click(card.querySelector('.trust-actions .btn-ghost') as HTMLElement)
    expect(card.querySelector('.trust-disclosure')).toBeNull()
    expect(textOf(card.querySelector('.btn-primary'))).toContain('查看并信任')

    fireEvent.click(card.querySelector('.btn-primary') as HTMLElement)
    fireEvent.click(card.querySelector('.trust-actions .btn-primary') as HTMLElement)
    await flush()
    expect(toastTexts().some((text) => text.includes('确认失败') && text.includes('写盘失败'))).toBe(true)
    expect(textOf(card.querySelector('.trust-actions .btn-primary'))).toContain('确认信任')
    expect(harness.calls.filter((call) => call.method === 'listUiTrust')).toHaveLength(1)
  })

  test('确认写入期间按钮变「正在写…」并禁用，成功后重读信任并给回执', async () => {
    let finish!: (value: unknown) => void
    const pending = new Promise<unknown>((resolve) => {
      finish = resolve
    })
    const harness = harnessOf({ native: { setUiTrust: () => pending } })
    const { container } = mount(harness)
    await flush()

    const card = container.querySelector('[data-trust="ext-ui"]') as HTMLElement
    fireEvent.click(card.querySelector('.btn-primary') as HTMLElement)
    fireEvent.click(card.querySelector('.trust-actions .btn-primary') as HTMLElement)
    await flush()
    const confirm = card.querySelector('.trust-actions .btn-primary') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(textOf(confirm)).toContain('正在写…')

    finish({ ok: true, notice: '写好了' })
    await flush()
    expect(toastTexts().some((text) => text.includes('写好了'))).toBe(true)
    expect(harness.calls.filter((call) => call.method === 'listUiTrust').length).toBeGreaterThanOrEqual(2)
  })

  test('信任卡启停失败：先乐观翻转，失败后翻回并报原因', async () => {
    const harness = harnessOf({
      trusts: [
        { name: 'pkg-ui', key: 'pkg-ui/ui/client.js', origin: 'package', platforms: ['web'], trusted: true, enabled: true },
      ],
      replies: {
        setPluginEnabled: () => {
          throw new Error('写盘失败')
        },
      },
    })
    const { container } = mount(harness)
    await flush()

    const toggle = container.querySelector('[data-trust="pkg-ui"] .switch') as HTMLElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await flush()
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toastTexts().some((text) => text.includes('没改成功') && text.includes('写盘失败'))).toBe(true)
  })

  test('老宿主行没有 origin：仍按第三方画，键回落 <name>/ui/client.js，并显示已停用徽标', async () => {
    const harness = harnessOf({
      trusts: [{ name: 'legacy-ui', platforms: ['web'], trusted: true, enabled: false, api: '^1.0.0' }],
    })
    const { container } = mount(harness)
    await flush()

    expect(container.textContent).toContain('第三方界面插件')
    const card = container.querySelector('[data-trust="legacy-ui"]') as HTMLElement
    expect(card).not.toBeNull()
    expect(textOf(card)).toContain('已停用')
    expect(card.querySelector('[data-version]')).toBeNull()
    expect(card.querySelector('[data-profile]')).toBeNull()
    expect(card.querySelector('.btn-primary')).toBeNull()

    fireEvent.click(card.querySelector('.switch') as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setPluginEnabled', args: ['legacy-ui/ui/client.js', true] })
  })

  test('问题档按来源分开说：组合包用包内文案，宿主没标档时各有兜底，且坏卡不给「查看并信任」', async () => {
    const harness = harnessOf({
      trusts: [
        {
          name: 'pkg-artifact',
          origin: 'package',
          version: '1.0.0',
          profile: 'default',
          platforms: ['web'],
          trusted: true,
          enabled: true,
          problem: '入口文件不存在',
          problemKind: 'artifact',
        },
        {
          name: 'pkg-unknown',
          origin: 'package',
          platforms: ['web'],
          trusted: true,
          enabled: true,
          problem: '说不清',
        },
        {
          name: 'ext-unknown',
          platforms: ['web'],
          trusted: false,
          enabled: false,
          problem: '也说不清',
        },
      ],
    })
    const { container } = mount(harness)
    await flush()

    const nextText = (name: string): string =>
      textOf(container.querySelector(`[data-trust="${name}"] .trust-next`))
    expect(nextText('pkg-artifact')).toContain('exports["./client"]')
    expect(nextText('pkg-unknown')).toContain('pneuma.client')
    expect(nextText('ext-unknown')).toContain('~/.dsc/plugins/<目录名>/')
    expect(container.querySelector('[data-trust="ext-unknown"] .btn-primary')).toBeNull()
  })
})

describe('详情页与配置表单', () => {
  test('无配置与停用插件各说各话，且都不去请求分区', async () => {
    const harness = harnessOf({
      plugins: [builtin('no-sec'), builtin('off-sec', { settingsSection: 'off-sec', enabled: false })],
    })
    const { container } = mount(harness)
    await flush()

    fireEvent.click(container.querySelector('.plugin-row[data-plugin="no-sec"]') as HTMLElement)
    await flush()
    expect(textOf(container.querySelector('.settings-empty'))).toContain('该插件没有可配置项。')

    fireEvent.click(container.querySelector('.plugin-back') as HTMLElement)
    fireEvent.click(container.querySelector('.plugin-row[data-plugin="off-sec"]') as HTMLElement)
    await flush()
    expect(textOf(container.querySelector('.settings-empty'))).toContain('插件已停用，启用后才能配置。')
    expect(harness.calls.some((call) => call.method === 'getSettingsSections')).toBe(false)
  })

  test('配置表单：下拉/开关/文本/数字各回传参数，复制给回执，按钮动作重读分区', async () => {
    const section = {
      id: 'sec',
      title: '配置',
      order: 1,
      builtin: false,
      custom: false,
      groups: [{ id: 'g1', title: '高级' }],
      fields: [
        { type: 'info', label: '路径', text: 'C:/x', copyable: true },
        { type: 'select', key: 'mode', label: '模式', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }] },
        { type: 'switch', key: 'flag', label: '开关', group: 'g1' },
        { type: 'text', key: 'name', label: '名称', placeholder: '写点什么' },
        { type: 'number', key: 'num', label: '数量', min: 0, max: 10, step: 1 },
        { type: 'button', action: 'do', label: '执行', style: 'ghost' },
      ],
    }
    const harness = harnessOf({
      plugins: [builtin('cfg', { settingsSection: 'sec' })],
      replies: {
        getSettingsSections: [section],
        getSectionValues: { mode: 'a', flag: false, name: '旧', num: 2 },
        setSettingValue: { ok: true },
        runSettingAction: { ok: true, notice: '动作完成' },
      },
    })
    const { container } = mount(harness)
    await flush()

    fireEvent.click(container.querySelector('.plugin-row[data-plugin="cfg"]') as HTMLElement)
    await flush()
    expect(container.querySelector('.plugin-detail')).not.toBeNull()
    expect(textOf(container.querySelector('.plugin-detail-config'))).toContain('高级')

    // 下拉：打开浮层选「乙」。
    fireEvent.click(container.querySelector('[aria-label="模式"]') as HTMLElement)
    const options = [...document.querySelectorAll('.select-opt')] as HTMLElement[]
    fireEvent.click(options[1] as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setSettingValue', args: ['sec', 'mode', 'b'] })

    // 开关：直接提交取反值。
    fireEvent.click(container.querySelector('[aria-label="开关"]') as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setSettingValue', args: ['sec', 'flag', true] })

    // 文本：失焦才提交。
    const textInput = container.querySelector('input[aria-label="名称"]') as HTMLInputElement
    fireEvent.change(textInput, { target: { value: '新' } })
    fireEvent.blur(textInput)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setSettingValue', args: ['sec', 'name', '新'] })

    // 数字：回车触发失焦，按 number 提交。
    const numInput = container.querySelector('input[aria-label="数量"]') as HTMLInputElement
    fireEvent.change(numInput, { target: { value: '5' } })
    // 产品在回车时调 blur()；jsdom 不会因此派发 React 收到的 focusout，补一次 blur 事件。
    fireEvent.keyDown(numInput, { key: 'Enter' })
    fireEvent.blur(numInput)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setSettingValue', args: ['sec', 'num', 5] })

    // 信息行复制。
    fireEvent.click(container.querySelector('.text-btn') as HTMLElement)
    await flush()
    expect(textOf(container.querySelector('.settings-note'))).toContain('已复制')

    // 行内动作：runSettingAction 成功后回读值并重取分区（控件清单可能变）。
    const actionButton = [...container.querySelectorAll('.setting-row.action button')][0] as HTMLElement
    fireEvent.click(actionButton)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'runSettingAction', args: ['sec', 'do'] })
    expect(harness.calls.filter((call) => call.method === 'getSettingsSections').length).toBeGreaterThanOrEqual(2)
    expect(textOf(container.querySelector('.settings-note'))).toContain('动作完成')
  })

  test('配置表单：派生值置灰只读，选项外的值标「未识别」', async () => {
    const section = {
      id: 'sec',
      title: '配置',
      order: 1,
      builtin: false,
      custom: false,
      fields: [
        {
          type: 'select',
          key: 'perm',
          label: '权限',
          options: [{ value: 'a', label: '甲' }],
          derivedLabelKey: 'permLabel',
        },
        {
          type: 'select',
          key: 'plain',
          label: '普通',
          options: [{ value: 'a', label: '甲' }],
        },
      ],
    }
    const harness = harnessOf({
      plugins: [builtin('cfg', { settingsSection: 'sec' })],
      replies: {
        getSettingsSections: [section],
        getSectionValues: { perm: 'custom', permLabel: '组合出来的名字', plain: 'zzz' },
      },
    })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelector('.plugin-row[data-plugin="cfg"]') as HTMLElement)
    await flush()

    const derived = container.querySelector('[aria-label="权限"]') as HTMLButtonElement
    expect(derived.disabled).toBe(true)
    expect(textOf(derived)).toContain('组合出来的名字')
    const plain = container.querySelector('[aria-label="普通"]') as HTMLElement
    expect(textOf(plain)).toContain('zzz · 未识别')
  })

  test('配置读写失败与空分区：保存失败、动作失败、分区没有可配置项各有落点', async () => {
    const empty = {
      id: 'empty',
      title: '空',
      order: 1,
      builtin: false,
      custom: false,
      fields: [],
    }
    const failing = harnessOf({
      plugins: [builtin('empty', { settingsSection: 'empty' })],
      replies: { getSettingsSections: [empty] },
    })
    const first = mount(failing)
    await flush()
    fireEvent.click(first.container.querySelector('.plugin-row[data-plugin="empty"]') as HTMLElement)
    await flush()
    expect(textOf(first.container.querySelector('.settings-empty'))).toContain('该分区没有可配置项。')

    cleanup()
    const section = {
      id: 'sec',
      title: '配置',
      order: 1,
      builtin: false,
      custom: false,
      fields: [
        { type: 'switch', key: 'flag', label: '开关' },
        { type: 'button', action: 'do', label: '执行' },
      ],
    }
    const harness = harnessOf({
      plugins: [builtin('cfg', { settingsSection: 'sec' })],
      replies: {
        getSettingsSections: [section],
        getSectionValues: { flag: false },
        setSettingValue: { ok: false, error: '磁盘满了' },
        runSettingAction: { ok: false, error: '钩子坏了' },
      },
    })
    const second = mount(harness)
    await flush()
    fireEvent.click(second.container.querySelector('.plugin-row[data-plugin="cfg"]') as HTMLElement)
    await flush()

    fireEvent.click(second.container.querySelector('[aria-label="开关"]') as HTMLElement)
    await flush()
    expect(textOf(second.container.querySelector('.settings-note.error'))).toContain('保存失败')
    expect(textOf(second.container.querySelector('.settings-note.error'))).toContain('磁盘满了')

    fireEvent.click(second.container.querySelector('.setting-row.action button') as HTMLElement)
    await flush()
    expect(textOf(second.container.querySelector('.settings-note.error'))).toContain('操作失败')
    expect(textOf(second.container.querySelector('.settings-note.error'))).toContain('钩子坏了')
  })

  test('插件开关失败：乐观翻转回滚，页面常驻提示给出原因', async () => {
    const harness = harnessOf({
      plugins: [builtin('tools-default')],
      replies: {
        setPluginEnabled: () => {
          throw new Error('写盘失败')
        },
      },
    })
    const { container } = mount(harness)
    await flush()

    const toggle = container.querySelector('.plugin-row[data-plugin="tools-default"] .switch') as HTMLElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await flush()
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(textOf(container.querySelector('.plugins-empty'))).toContain('没改成功')
    expect(textOf(container.querySelector('.plugins-empty'))).toContain('写盘失败')
  })
})
