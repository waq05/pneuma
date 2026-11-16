/**
 * 设置主界面（`ui.tsx`）的补齐段（ui 层，真渲染）。
 *
 * 已有的 `nav.spec.tsx` / `embed-slot.spec.tsx` / `models.spec.tsx` / `usage-layout.spec.tsx`
 * 分别钉住导航筛选、parent 嵌槽、模型页与用量页；这里只补它们不碰的那几条：
 *
 * - 页头与正文路由（默认第一分区、副标题、模型页的 `settings-body-fill`）；
 * - 分区清单取不回来 / 字段取不回来时的**坏配置提示**（不是白屏、不是「未知分区」）；
 * - 通用分区的声明式控件：选择提交与回执、开关、文本/数字的失焦与回车提交；
 * - 两种只读/脏值态：派生值置灰只读、选项外的值显式标「未识别」；
 * - 信息行的复制、打开路径、换/恢复配置文件（含原生桥缺席时的说明）；
 * - 外观：主题即时写盘、写失败回滚并说明；
 * - 空分区说明、未搬的结构化分区（远程）的诚实说明、三种关闭路径。
 *
 * @module dsc-ui-settings/ui/ui-extra.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type {
  SettingsField,
  SettingsMutation,
  SettingsSectionView,
  SettingsValues,
  UiPluginApi,
} from '@dsc/ui'
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

/** 一张宿主分区：默认是 builtin + 声明式。 */
function sectionOf(id: string, title: string, patch: Partial<SettingsSectionView> = {}): SettingsSectionView {
  return { id, title, order: 0, builtin: true, custom: false, fields: [], ...patch }
}

/** 外观那一块每次挂载都会读一次；给一份最小偏好，免得走加载态。 */
const prefsOf = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  themeMode: 'claude',
  fontSize: 1,
  density: 'standard',
  ...patch,
})

/** 模型页只做路由断言：给一份空端点表即可，不让 ModelsGroup 炸。 */
const modelConfig = (): Record<string, unknown> => ({
  providers: [],
  defaultProvider: '',
  defaultModel: '',
  temperature: null,
  configFile: '',
  credentialsFile: '',
})

interface Recorded {
  method: string
  args: unknown[]
}

/** 假宿主通道：按方法名路由，所有调用记进 `calls`。 */
function makeChannel(routes: Record<string, (args: unknown[]) => unknown>): {
  channel: HostChannel
  calls: Recorded[]
} {
  const calls: Recorded[] = []
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
      const handler = routes[method]
      if (handler === undefined) return Promise.resolve({} as T)
      try {
        return Promise.resolve(handler(args) as T | Promise<T>) as Promise<T>
      } catch (error) {
        return Promise.reject(error)
      }
    },
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const callsOf = (calls: Recorded[], method: string): unknown[][] =>
  calls.filter((call) => call.method === method).map((call) => call.args)

/** 挂面板并把它打开（面板默认关着，侧栏事件是生产里的开门路径）。 */
async function openPanel(
  channel: HostChannel,
  detail?: { section?: string },
): Promise<ReturnType<typeof render>> {
  const rendered = render(
    <RuntimeProvider channel={channel}>
      <SettingsPanel />
    </RuntimeProvider>,
  )
  await act(async () => {
    window.dispatchEvent(new CustomEvent('shell.settings.open', detail === undefined ? undefined : { detail }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  return rendered
}

/** 把一串已经排好的微任务跑完。 */
const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })

const navItem = (container: HTMLElement, label: string): HTMLElement => {
  const found = ([...container.querySelectorAll('.settings-nav-item')] as HTMLElement[]).find((item) =>
    item.textContent?.includes(label),
  )
  if (found === undefined) throw new Error(`导航里没有 ${label}`)
  return found
}

const buttonOf = (scope: ParentNode, label: string): HTMLButtonElement | undefined =>
  ([...scope.querySelectorAll('button')] as HTMLButtonElement[]).find((node) => node.textContent === label)

const triggerOf = (container: HTMLElement, label: string): HTMLButtonElement =>
  container.querySelector(`.select-trigger[aria-label="${label}"]`) as HTMLButtonElement

/** 点开自绘下拉并选中一项目（浮层 portal 到 body）。 */
async function pickOption(trigger: HTMLButtonElement, label: string): Promise<void> {
  await act(async () => {
    fireEvent.click(trigger)
    await Promise.resolve()
  })
  const option = ([...document.querySelectorAll('.select-opt')] as HTMLElement[]).find((node) =>
    node.textContent?.includes(label),
  )
  if (option === undefined) throw new Error(`下拉里没有 ${label}`)
  await act(async () => {
    fireEvent.click(option)
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** 假原生桥：桌面窗口 preload 挂的 `window.dscNative` 就是这个形状。 */
function fakeNative(handlers: Record<string, (args: unknown[]) => unknown> = {}): {
  calls: Array<{ op: string; args: unknown[] }>
} {
  const calls: Array<{ op: string; args: unknown[] }> = []
  ;(globalThis as { dscNative?: unknown }).dscNative = {
    version: 1,
    call: (op: string, args: unknown[] = []) => {
      calls.push({ op, args })
      const handler = handlers[op]
      return Promise.resolve(handler === undefined ? { ok: true } : handler(args))
    },
    on: () => () => undefined,
  }
  return { calls }
}

beforeEach(() => {
  // 模块级开合信号在用例之间会留着；cleanup 摘掉上一棵 React 树就够了（下面的打开事件会置真）。
  cleanup()
  localStorage.clear()
  delete (globalThis as { dscNative?: unknown }).dscNative
  // jsdom 没有布局，自绘下拉在打开时会把高亮项滚进可视区——补一个空实现。
  ;(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = (): void => undefined
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (globalThis as { dscNative?: unknown }).dscNative
  Reflect.deleteProperty(navigator, 'clipboard')
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

describe('页头与分区路由', () => {
  test('默认选中第一个分区并显示副标题；切到模型页时正文加 fill 类，切回普通页去掉', async () => {
    const sections = [
      sectionOf('general', '通用', {
        subtitle: '基础偏好',
        fields: [{ type: 'switch', key: 'telemetry', label: '匿名统计' }],
      }),
      sectionOf('models', '模型', { custom: true }),
      sectionOf('about', '关于', { order: 900 }),
    ]
    const { channel } = makeChannel({
      getSettingsSections: () => sections,
      getSectionValues: () => ({ telemetry: false }),
      getModelConfig: () => modelConfig(),
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)

    expect(container.querySelector('.settings-main h2')?.textContent).toBe('通用')
    expect(container.querySelector('.settings-head p')?.textContent).toBe('基础偏好')
    expect(container.querySelector('.settings-body')?.classList.contains('settings-body-fill')).toBe(false)

    await act(async () => {
      fireEvent.click(navItem(container, '模型'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('.settings-main h2')?.textContent).toBe('模型')
    expect(container.querySelector('.settings-body')?.classList.contains('settings-body-fill')).toBe(true)

    await act(async () => {
      fireEvent.click(navItem(container, '关于'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('.settings-main h2')?.textContent).toBe('关于')
    expect(container.querySelector('.settings-body')?.classList.contains('settings-body-fill')).toBe(false)
  })

  test('侧栏事件带具体分区：开门后直接落在那一页，而不是第一个分区', async () => {
    const { channel } = makeChannel({
      getSettingsSections: () => [sectionOf('general', '通用', { order: 0 }), sectionOf('about', '关于', { order: 9 })],
      getSectionValues: () => ({}),
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel, { section: 'about' })

    expect(container.querySelector('.settings-main h2')?.textContent).toBe('关于')
    expect(container.querySelector('.settings-nav-item.on .label')?.textContent).toBe('关于')
  })
})

describe('分区清单与字段取不回来时的坏配置提示', () => {
  test('分区清单抛错：导航与正文都写「分区加载失败」并保留错误原文，不落成「未知分区」', async () => {
    const { channel } = makeChannel({
      getSettingsSections: () => {
        throw new Error('settings.yaml 第 3 行解析失败')
      },
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)

    const navEmpty = container.querySelector('.settings-nav-empty')?.textContent ?? ''
    expect(navEmpty).toContain('分区加载失败')
    expect(navEmpty).toContain('settings.yaml 第 3 行解析失败')
    const bodyEmpty = container.querySelector('.settings-main .settings-empty')?.textContent ?? ''
    expect(bodyEmpty).toContain('分区加载失败')
    expect(bodyEmpty).not.toContain('未知分区')
    expect(container.querySelectorAll('.settings-nav-item')).toHaveLength(0)
  })

  test('字段值取不回来：本分区底部给「读取设置失败」的行内说明', async () => {
    const { channel } = makeChannel({
      getSettingsSections: () => [sectionOf('general', '通用', {
        fields: [{ type: 'switch', key: 'telemetry', label: '匿名统计' }],
      })],
      getSectionValues: () => {
        throw new Error('配置文件损坏')
      },
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)

    const note = container.querySelector('.settings-note.error')?.textContent ?? ''
    expect(note).toContain('读取设置失败')
    expect(note).toContain('配置文件损坏')
  })
})

describe('通用分区的声明式控件', () => {
  test('选择一项：setSettingValue 收到分区与键值，成功回执留在行内，随后回读一次值', async () => {
    const values: SettingsValues = { themeMode: 'light' }
    let valueReads = 0
    const { channel, calls } = makeChannel({
      getSettingsSections: () => [sectionOf('general', '通用', {
        fields: [
          {
            type: 'select',
            key: 'themeMode',
            label: '主题模式',
            options: [
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ],
          },
        ],
      })],
      getSectionValues: () => {
        valueReads += 1
        return values
      },
      setSettingValue: (args) => {
        values[String(args[1])] = args[2] as SettingsValues[string]
        return { ok: true, notice: '已保存' }
      },
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)
    const trigger = triggerOf(container, '主题模式')
    expect(trigger.textContent).toContain('浅色')

    await pickOption(trigger, '深色')

    expect(callsOf(calls, 'setSettingValue').at(-1)).toEqual(['general', 'themeMode', 'dark'])
    expect(container.querySelector('.settings-note:not(.error)')?.textContent).toBe('已保存')
    expect(triggerOf(container, '主题模式').textContent).toContain('深色')
    expect(valueReads).toBeGreaterThanOrEqual(2)
  })

  test('开关提交结果 ok:false：行内写「保存失败：<原因>」，且不再回读', async () => {
    let valueReads = 0
    const { channel } = makeChannel({
      getSettingsSections: () => [sectionOf('general', '通用', {
        fields: [{ type: 'switch', key: 'telemetry', label: '匿名统计' }],
      })],
      getSectionValues: () => {
        valueReads += 1
        return { telemetry: false }
      },
      setSettingValue: () => ({ ok: false, error: '磁盘只读' }),
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)
    const toggle = container.querySelector('button[role="switch"][aria-label="匿名统计"]') as HTMLButtonElement

    await act(async () => {
      fireEvent.click(toggle)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('.settings-note.error')?.textContent).toBe('保存失败：磁盘只读')
    expect(valueReads).toBe(1)
  })

  test('写入通道抛错：行内写「保存失败」并保留错误原文', async () => {
    const { channel } = makeChannel({
      getSettingsSections: () => [sectionOf('general', '通用', {
        fields: [{ type: 'switch', key: 'telemetry', label: '匿名统计' }],
      })],
      getSectionValues: () => ({ telemetry: false }),
      setSettingValue: () => {
        throw new Error('通道断了')
      },
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)

    await act(async () => {
      fireEvent.click(container.querySelector('button[role="switch"][aria-label="匿名统计"]') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('.settings-note.error')?.textContent).toBe('保存失败：通道断了')
  })

  test('文本失焦提交、回车提交、值没变时不重复写；数字框按 number 写回', async () => {
    const values: SettingsValues = { displayName: '旧名', limit: 5 }
    const { channel, calls } = makeChannel({
      getSettingsSections: () => [sectionOf('general', '通用', {
        fields: [
          { type: 'text', key: 'displayName', label: '显示名称' },
          { type: 'number', key: 'limit', label: '数量上限' },
        ],
      })],
      getSectionValues: () => values,
      setSettingValue: (args) => {
        values[String(args[1])] = args[2] as SettingsValues[string]
        return { ok: true, notice: '已保存' }
      },
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)
    const text = container.querySelector('input[aria-label="显示名称"]') as HTMLInputElement
    const number = container.querySelector('input[aria-label="数量上限"]') as HTMLInputElement

    fireEvent.change(text, { target: { value: '新名' } })
    fireEvent.blur(text)
    await flush()
    expect(callsOf(calls, 'setSettingValue').at(-1)).toEqual(['general', 'displayName', '新名'])
    const writesAfterBlur = callsOf(calls, 'setSettingValue').length

    // 值没变：再失焦一次不应重复写。
    fireEvent.blur(text)
    await flush()
    expect(callsOf(calls, 'setSettingValue').length).toBe(writesAfterBlur)

    // 数字框回车 = 失焦提交，且值按 number 传（先真的聚焦，回车里的 blur() 才会发出失焦）。
    number.focus()
    fireEvent.change(number, { target: { value: '42' } })
    fireEvent.keyDown(number, { key: 'Enter' })
    await flush()
    expect(callsOf(calls, 'setSettingValue').at(-1)).toEqual(['general', 'limit', 42])
  })

  test('派生值（不在选项里且给了显示名）：下拉置灰只读，显示宿主给的派生名', async () => {
    const { channel } = makeChannel({
      getSettingsSections: () => [sectionOf('general', '通用', {
        fields: [
          {
            type: 'select',
            key: 'permissionPreset',
            label: '权限预设',
            options: [
              { value: 'ask', label: '每次询问' },
              { value: 'auto', label: '自动' },
            ],
            derivedLabelKey: 'permissionDisplay',
          },
        ],
      })],
      getSectionValues: () => ({ permissionPreset: 'custom', permissionDisplay: '自定义组合（3 条规则）' }),
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)
    const trigger = triggerOf(container, '权限预设')

    expect(trigger.disabled).toBe(true)
    expect(trigger.textContent).toContain('自定义组合（3 条规则）')
    fireEvent.click(trigger)
    await flush()
    expect(document.querySelector('.select-pop')).toBeNull()
  })

  test('选项外的脏值（没给派生名）：仍然显示出来并明确标「未识别」，不偷偷显示成第一项', async () => {
    const { channel } = makeChannel({
      getSettingsSections: () => [sectionOf('general', '通用', {
        fields: [
          {
            type: 'select',
            key: 'themeMode',
            label: '主题模式',
            options: [
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ],
          },
        ],
      })],
      getSectionValues: () => ({ themeMode: 'mystery' }),
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)
    const trigger = triggerOf(container, '主题模式')

    expect(trigger.textContent).toContain('mystery · 未识别')
    await act(async () => {
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    const options = [...document.querySelectorAll('.select-opt')].map((node) => node.textContent ?? '')
    expect(options.some((label) => label.includes('mystery · 未识别'))).toBe(true)
  })

  test('空分区：正文写「该分区没有可配置项」，不是空白', async () => {
    const { channel } = makeChannel({
      getSettingsSections: () => [sectionOf('general', '通用')],
      getSectionValues: () => ({}),
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)

    expect(container.querySelector('.settings-fields .settings-empty')?.textContent).toBe('该分区没有可配置项。')
  })
})

describe('信息行的动作', () => {
  test('复制走剪贴板并给「已复制」；无原生桥时「打开」如实说明只在桌面版里有', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { channel } = makeChannel({
      getSettingsSections: () => [sectionOf('general', '通用', {
        fields: [{ type: 'info', label: '配置文件', text: 'D:/dsc/config.yaml', copyable: true }],
      })],
      getSectionValues: () => ({}),
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)

    await act(async () => {
      fireEvent.click(buttonOf(container, '复制') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('D:/dsc/config.yaml')
    expect(container.querySelector('.settings-note:not(.error)')?.textContent).toBe('已复制')

    // 没有 globalThis.dscNative：说明这条能力只在桌面版里有。
    await act(async () => {
      fireEvent.click(buttonOf(container, '打开') as HTMLButtonElement)
      await Promise.resolve()
    })
    expect(container.querySelector('.settings-note.error')?.textContent).toContain('用系统程序打开只在桌面版里有')
  })

  test('更换 / 恢复默认配置文件：两步原生调用、成功回执，成功后重取分区清单', async () => {
    const native = fakeNative({
      pickConfigFile: () => 'D:/other/config.yaml',
      setConfigFile: (args) =>
        args[0] === ''
          ? { ok: true, notice: '已恢复默认配置' }
          : { ok: true, notice: '已切到 D:/other/config.yaml' },
    })
    let sectionReads = 0
    const { channel } = makeChannel({
      getSettingsSections: () => {
        sectionReads += 1
        return [sectionOf('general', '通用', {
          fields: [
            {
              type: 'info',
              label: '配置文件',
              text: 'D:/dsc/config.yaml',
              copyable: true,
              actions: [
                { id: 'switch-config-file', label: '更换配置', tip: '选一份别的配置' },
                { id: 'reset-config-file', label: '恢复默认' },
                { id: 'unknown-action', label: '不该出现' },
              ],
            },
          ],
        })]
      },
      getSectionValues: () => ({}),
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)
    const before = sectionReads
    // 壳只画认得的动作 id：多声明的整条跳过。
    expect(buttonOf(container, '不该出现')).toBeUndefined()

    await act(async () => {
      fireEvent.click(buttonOf(container, '更换配置') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(native.calls.map((call) => call.op)).toEqual(['pickConfigFile', 'setConfigFile'])
    expect(native.calls[1]?.args).toEqual(['D:/other/config.yaml'])
    expect(container.querySelector('.settings-note:not(.error)')?.textContent).toBe('已切到 D:/other/config.yaml')
    expect(sectionReads).toBeGreaterThan(before)

    const afterSwitch = sectionReads
    await act(async () => {
      fireEvent.click(buttonOf(container, '恢复默认') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    // 恢复默认不弹对话框：直接把空串交给 setConfigFile。
    expect(native.calls.at(-1)).toEqual({ op: 'setConfigFile', args: [''] })
    expect(container.querySelector('.settings-note:not(.error)')?.textContent).toBe('已恢复默认配置')
    expect(sectionReads).toBeGreaterThan(afterSwitch)
  })
})

describe('外观', () => {
  test('主题即时写盘并广播；写失败回滚到原档并说明原因', async () => {
    let fail = false
    const prefsWrites: unknown[][] = []
    const { channel } = makeChannel({
      getSettingsSections: () => [sectionOf('general', '通用', {
        fields: [{ type: 'switch', key: 'telemetry', label: '匿名统计' }],
      })],
      getSectionValues: () => ({ telemetry: false }),
      getUiPrefs: () => prefsOf(),
      setUiPrefs: (args) => {
        prefsWrites.push(args)
        if (fail) throw new Error('配额满了')
        return { ok: true }
      },
    })
    const { container } = await openPanel(channel)
    await flush()

    const tile = (label: string): HTMLButtonElement =>
      ([...container.querySelectorAll('.theme-tile')] as HTMLButtonElement[]).find((node) => node.textContent === label) as HTMLButtonElement
    expect(tile('Claude').getAttribute('aria-checked')).toBe('true')

    let broadcasts = 0
    const onBroadcast = (): void => {
      broadcasts += 1
    }
    window.addEventListener('shell.uiprefs', onBroadcast)
    try {
      await act(async () => {
        fireEvent.click(tile('深色'))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(prefsWrites.at(-1)).toEqual([{ themeMode: 'dark' }])
      expect(tile('深色').getAttribute('aria-checked')).toBe('true')
      expect(broadcasts).toBe(1)

      fail = true
      await act(async () => {
        fireEvent.click(tile('浅色'))
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(container.querySelector('.settings-note.error')?.textContent).toBe('没写进去：配额满了')
      expect(tile('深色').getAttribute('aria-checked')).toBe('true')
    } finally {
      window.removeEventListener('shell.uiprefs', onBroadcast)
    }
  })
})

describe('未搬的结构化分区与关闭路径', () => {
  test('远程控制是结构化分区但没搬：给出原因与「暂时只能查看」的说明', async () => {
    const { channel } = makeChannel({
      getSettingsSections: () => [sectionOf('remote', '远程控制', { custom: true, order: 0 })],
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)

    expect(container.querySelector('.settings-main h2')?.textContent).toBe('远程控制')
    const body = container.querySelector('.settings-body')?.textContent ?? ''
    expect(body).toContain('远程与手机连接的面板还没搬过来')
    expect(body).toContain('这个分区还没有可用的界面，暂时只能查看。')
  })

  test('关闭按钮、点遮罩都关；点面板内部不关', async () => {
    const { channel } = makeChannel({
      getSettingsSections: () => [sectionOf('general', '通用')],
      getSectionValues: () => ({}),
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)

    expect(container.querySelector('.settings')).not.toBeNull()
    await act(async () => {
      fireEvent.click(container.querySelector('button[aria-label="关闭设置"]') as HTMLButtonElement)
    })
    expect(container.querySelector('.settings')).toBeNull()

    await act(async () => {
      window.dispatchEvent(new CustomEvent('shell.settings.open'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('.settings')).not.toBeNull()

    fireEvent.mouseDown(container.querySelector('.settings-head') as HTMLElement)
    expect(container.querySelector('.settings')).not.toBeNull()

    await act(async () => {
      fireEvent.mouseDown(container.querySelector('.settings-mask') as HTMLElement)
      await Promise.resolve()
    })
    expect(container.querySelector('.settings')).toBeNull()
  })
})
