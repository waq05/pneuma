/**
 * 设置面板第三批补测：声明式控件的 `fact` / `rows` / `checks` / `info` / `button` 分支，
 * 以及「通用」分区末尾那块外观（`AppearanceRows` / `FontRow`）的每个控件。
 *
 * 已有三份 spec 的分工：`ui-extra` 钉住面板骨架、选择/开关/文本的主链路、复制与换配置文件；
 * `settings-more` 钉住结构化分区（模式/归档/用量/模型/配对弹窗）。这一份只补它们没碰到的：
 *
 * - `fact` 行的有值/占位，`rows` 表的增删行、文本格提交、正则拒绝、下拉格、保存失败与通道抛错；
 * - `checks` 的分组、空态、空组、清单外的已选值、勾选与取消；
 * - `info` 行的复制失败、`openPath` 的回执失败与通道抛错、两种行内动作的四种结果；
 * - `button` 动作的失败/抛错/三种结构化回执（URL 打开、就地更新、配对码弹窗）；
 * - 外观：字体输入框（回车 / Esc / 失焦）、字号滑块、六个下拉、两个开关、读/写偏好失败。
 *
 * @module dsc-ui-settings/ui/w13-settings-fields.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import { ServiceRegistry, ServicesProvider } from '@dsc/ui-core'
import type {
  ActionsHandle,
  SettingsField,
  SettingsSectionView,
  SettingsValues,
  UiAction,
  UiPluginApi,
} from '@dsc/ui'
import { ACTIONS_SERVICE } from '@dsc/ui'
import plugin from './ui.js'

// 配对弹窗要画二维码：jsdom 没有 canvas，换成固定 dataURL（弹窗逻辑仍然真跑）。
vi.mock('qrcode', () => ({
  default: { toDataURL: (): Promise<string> => Promise.resolve('data:image/png;base64,QQ==') },
}))

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

interface Recorded {
  method: string
  args: unknown[]
}

/** 按方法名路由的假通道；handler 抛错 = 该调用 reject。 */
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
      if (handler === undefined) return Promise.resolve({ ok: true } as T)
      try {
        return Promise.resolve(handler(args) as T | Promise<T>) as Promise<T>
      } catch (error: unknown) {
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

/** 一张宿主分区：默认是 builtin + 声明式。 */
function sectionOf(id: string, title: string, patch: Partial<SettingsSectionView> = {}): SettingsSectionView {
  return { id, title, order: 0, builtin: true, custom: false, fields: [], ...patch }
}

/** 外观那一块每次挂载都会读一次；给一份最小偏好。 */
const prefsOf = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  themeMode: 'claude',
  fontSize: 1,
  density: 'standard',
  ...patch,
})

/**
 * 有状态的假宿主：写进去的值下次读得到（真的面板会回读一次，固定返回值会把刚写的值
 * 立刻覆盖掉，那条链路的用例就成了假绿）。
 */
function storeRoutes(initial: SettingsValues): {
  store: SettingsValues
  routes: Record<string, (args: unknown[]) => unknown>
} {
  const store: SettingsValues = { ...initial }
  return {
    store,
    routes: {
      getSectionValues: () => ({ ...store }),
      setSettingValue: (args: unknown[]) => {
        store[args[1] as string] = args[2] as SettingsValues[string]
        return { ok: true }
      },
    },
  }
}

/** 把一串已经排好的微任务跑完。 */
const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })

/** 挂面板并把它打开（面板默认关着，侧栏事件是生产里的开门路径）。 */
async function openPanel(channel: HostChannel): Promise<ReturnType<typeof render>> {
  const rendered = render(
    <RuntimeProvider channel={channel}>
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

/** 挂一张只有指定字段的「通用」分区并打开。 */
async function openFields(
  fields: SettingsField[],
  routes: Record<string, (args: unknown[]) => unknown> = {},
  values: SettingsValues = {},
): Promise<{ container: HTMLElement; calls: Recorded[] }> {
  const { channel, calls } = makeChannel({
    getSettingsSections: () => [sectionOf('general', '通用', { fields })],
    getSectionValues: () => values,
    getUiPrefs: () => prefsOf(),
    ...routes,
  })
  const { container } = await openPanel(channel)
  await flush()
  return { container, calls }
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
      try {
        return Promise.resolve(handler === undefined ? { ok: true } : handler(args))
      } catch (error: unknown) {
        return Promise.reject(error)
      }
    },
    on: () => () => undefined,
  }
  return { calls }
}

type NativeCall = (op: string, args?: unknown[]) => Promise<unknown>
const nativeOf = (): { call: NativeCall } => (globalThis as unknown as { dscNative: { call: NativeCall } }).dscNative

const buttonOf = (scope: ParentNode, label: string): HTMLButtonElement | undefined =>
  ([...scope.querySelectorAll('button')] as HTMLButtonElement[]).find((node) => node.textContent === label)

const noteText = (container: HTMLElement): string => container.querySelector('.settings-note')?.textContent ?? ''

const triggerOf = (container: HTMLElement, label: string): HTMLButtonElement => {
  const found = container.querySelector(`.select-trigger[aria-label="${label}"]`) as HTMLButtonElement | null
  if (found === null) throw new Error(`找不到下拉 ${label}`)
  return found
}

/** 点开自绘下拉并点第 index 个项目（浮层 portal 到 body）。 */
async function pickOptionAt(trigger: HTMLButtonElement, index: number): Promise<HTMLElement> {
  await act(async () => {
    fireEvent.click(trigger)
    await Promise.resolve()
  })
  const options = [...document.querySelectorAll('.select-opt')] as HTMLElement[]
  const option = options[index]
  if (option === undefined) throw new Error(`下拉里没有第 ${index} 项`)
  await act(async () => {
    fireEvent.click(option)
    await Promise.resolve()
    await Promise.resolve()
  })
  return option
}

/** 按文字点开下拉并选中一项目。 */
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

beforeEach(() => {
  cleanup()
  localStorage.clear()
  delete (globalThis as { dscNative?: unknown }).dscNative
  ;(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = (): void => undefined
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (globalThis as { dscNative?: unknown }).dscNative
  Reflect.deleteProperty(navigator, 'clipboard')
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

describe('fact 行：有值显示、没有值给占位', () => {
  test('values 里有标量就画出来；对象与缺失值都落到「（没有值）」', async () => {
    const { container } = await openFields(
      [
        { type: 'fact', key: 'deploy', label: '部署检查', help: '来自部署检查结果' },
        { type: 'fact', key: 'missing', label: '缺失项' },
        { type: 'fact', key: 'weird', label: '怪值' },
      ],
      {},
      { deploy: '全部通过', weird: { nested: true } } as unknown as SettingsValues,
    )

    const rows = [...container.querySelectorAll('.setting-row.info')] as HTMLElement[]
    expect(rows).toHaveLength(3)
    expect(rows[0]?.querySelector('.setting-info')?.textContent).toBe('全部通过')
    expect(rows[1]?.querySelector('.setting-info')?.textContent).toBe('（没有值）')
    // host 塞了对象：显示占位而不是 `[object Object]`
    expect(rows[2]?.querySelector('.setting-info')?.textContent).toBe('（没有值）')
    expect(container.textContent).not.toContain('[object Object]')
  })
})

describe('rows 记录表：增删行、文本格提交、正则拒绝、下拉格', () => {
  test('空表给说明；添加一行写回空记录并回读；再删掉这一行', async () => {
    const { store, routes } = storeRoutes({ allow: [] })
    const { container, calls } = await openFields(
      [
        {
          type: 'rows',
          key: 'allow',
          label: '准入表',
          columns: [{ key: 'name', label: '名称', type: 'text' }],
        },
      ],
      routes,
    )

    expect(container.textContent).toContain('还没有记录，点「添加一行」建第一条。')
    await act(async () => {
      fireEvent.click(buttonOf(container, '添加一行') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(callsOf(calls, 'setSettingValue')[0]).toEqual(['general', 'allow', [{}]])
    expect(store['allow']).toEqual([{}])
    // 保存成功后回读一次（宿主可能夹取非法值）
    expect(callsOf(calls, 'getSectionValues').length).toBeGreaterThanOrEqual(2)

    await flush()
    const remove = container.querySelector('button[aria-label="删除这一行"]') as HTMLButtonElement
    expect(remove).not.toBeNull()
    await act(async () => {
      fireEvent.click(remove)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(callsOf(calls, 'setSettingValue')[1]).toEqual(['general', 'allow', []])
    expect(store['allow']).toEqual([])
  })

  test('文本格：输入后失焦才写回；回车触发失焦；值没变不写', async () => {
    const { store, routes } = storeRoutes({ allow: [{ name: 'old' }] })
    const { container, calls } = await openFields(
      [
        {
          type: 'rows',
          key: 'allow',
          label: '准入表',
          columns: [{ key: 'name', label: '名称', type: 'text', placeholder: '仓库名' }],
        },
      ],
      routes,
    )

    const input = container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement
    expect(input.placeholder).toBe('仓库名')
    fireEvent.change(input, { target: { value: 'next' } })
    expect(callsOf(calls, 'setSettingValue')).toHaveLength(0)
    fireEvent.blur(input)
    await flush()
    expect(callsOf(calls, 'setSettingValue')[0]).toEqual(['general', 'allow', [{ name: 'next' }]])
    expect(store['allow']).toEqual([{ name: 'next' }])
    // 草稿清掉后输入框显示回已保存的值
    expect((container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement).value).toBe('next')

    const again = container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement
    fireEvent.keyDown(again, { key: 'Enter' })
    expect(callsOf(calls, 'setSettingValue')).toHaveLength(1)
  })

  test('正则不匹配：行内说明写「不符合格式」，不写回宿主，输入框回到原值', async () => {
    const { store, routes } = storeRoutes({ allow: [{ name: 'ok' }] })
    const { container, calls } = await openFields(
      [
        {
          type: 'rows',
          key: 'allow',
          label: '准入表',
          columns: [{ key: 'name', label: '名称', type: 'text', pattern: '^[a-z]+$' }],
        },
      ],
      routes,
    )

    const input = container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Has Space' } })
    fireEvent.blur(input)
    await flush()
    expect(callsOf(calls, 'setSettingValue')).toHaveLength(0)
    expect(store['allow']).toEqual([{ name: 'ok' }])
    expect(noteText(container)).toContain('名称 这一格不符合格式：Has Space')
    expect((container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement).value).toBe('ok')
  })

  test('regex 写坏了按通过处理，照样写回（不让坏 pattern 把值锁死）', async () => {
    const { store, routes } = storeRoutes({ allow: [{ name: 'ok' }] })
    const { container, calls } = await openFields(
      [
        {
          type: 'rows',
          key: 'allow',
          label: '准入表',
          columns: [{ key: 'name', label: '名称', type: 'text', pattern: '[' }],
        },
      ],
      routes,
    )
    const input = container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'anything' } })
    fireEvent.blur(input)
    await flush()
    expect(callsOf(calls, 'setSettingValue')[0]).toEqual(['general', 'allow', [{ name: 'anything' }]])
    expect(store['allow']).toEqual([{ name: 'anything' }])
  })

  test('下拉格：选项外的值标「未识别」；选一项就整表写回并清草稿', async () => {
    const { store, routes } = storeRoutes({ allow: [{ mode: 'b' }] })
    const { container, calls } = await openFields(
      [
        {
          type: 'rows',
          key: 'allow',
          label: '准入表',
          columns: [{ key: 'mode', label: '模式', type: 'select', options: [{ value: 'a', label: 'A 档' }] }],
        },
      ],
      routes,
    )

    const select = container.querySelector('select[aria-label="第 1 行的模式"]') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual(['A 档', 'b · 未识别'])
    await act(async () => {
      fireEvent.change(select, { target: { value: 'a' } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(callsOf(calls, 'setSettingValue')[0]).toEqual(['general', 'allow', [{ mode: 'a' }]])
    expect(store['allow']).toEqual([{ mode: 'a' }])
  })

  test('保存失败：行内写「保存失败：<原因>」；通道抛错也写说明并回读一次', async () => {
    let mode: 'fail' | 'throw' = 'fail'
    const { channel, calls } = makeChannel({
      getSettingsSections: () => [
        sectionOf('general', '通用', {
          fields: [
            {
              type: 'rows',
              key: 'allow',
              label: '准入表',
              columns: [{ key: 'name', label: '名称', type: 'text' }],
            },
          ],
        }),
      ],
      getSectionValues: () => {
        if (mode === 'throw') throw new Error('读盘失败')
        return { allow: [{ name: 'a' }] }
      },
      getUiPrefs: () => prefsOf(),
      setSettingValue: () => {
        if (mode === 'throw') throw new Error('写盘炸了')
        return { ok: false, error: '配置只读' }
      },
    })
    const { container } = await openPanel(channel)
    await flush()

    const input = container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'b' } })
    fireEvent.blur(input)
    await flush()
    expect(noteText(container)).toContain('保存失败：配置只读')

    mode = 'throw'
    const second = container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement
    fireEvent.change(second, { target: { value: 'c' } })
    fireEvent.blur(second)
    await flush()
    expect(noteText(container)).toContain('保存失败：写盘炸了')
    expect(callsOf(calls, 'getSectionValues').length).toBeGreaterThanOrEqual(3)
  })
})

describe('checks 分组多选', () => {
  test('分组标题、选项副说明、勾选与取消都走同一份数组；计数随选中数变', async () => {
    const { store, routes } = storeRoutes({ models: ['a'] })
    const { container, calls } = await openFields(
      [
        {
          type: 'checks',
          key: 'models',
          label: '可用模型',
          help: '勾掉的模型不出现在聊天里',
          groups: [
            {
              title: '第一组',
              options: [
                { value: 'a', label: '模型 A', detail: 'provider/a' },
                { value: 'b', label: '模型 B' },
              ],
            },
          ],
        },
      ],
      routes,
    )

    expect(container.textContent).toContain('第一组')
    expect(container.textContent).toContain('已选 1 / 2 项')
    expect(container.textContent).toContain('provider/a')

    const boxA = container.querySelector('input[aria-label="模型 A"]') as HTMLInputElement
    const boxB = container.querySelector('input[aria-label="模型 B"]') as HTMLInputElement
    expect(boxA.checked).toBe(true)
    expect(boxB.checked).toBe(false)

    await act(async () => {
      fireEvent.click(boxB)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(callsOf(calls, 'setSettingValue')[0]).toEqual(['general', 'models', ['a', 'b']])
    expect(store['models']).toEqual(['a', 'b'])

    await flush()
    const boxA2 = container.querySelector('input[aria-label="模型 A"]') as HTMLInputElement
    await act(async () => {
      fireEvent.click(boxA2)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(callsOf(calls, 'setSettingValue')[1]).toEqual(['general', 'models', ['b']])
    expect(store['models']).toEqual(['b'])
  })

  test('清单外的已选值单独收一组；空组与全空两种说明都画出来', async () => {
    const { container } = await openFields(
      [{ type: 'checks', key: 'sources', label: '来源', groups: [{ title: '空组', options: [] }] }],
      {},
      { sources: ['stray-value'] },
    )
    expect(container.textContent).toContain('（这一组没有选项）')
    expect(container.textContent).toContain('其他（不在清单里）')
    expect(container.textContent).toContain('已选 1 / 0 项')
    expect(container.querySelector('input[aria-label="stray-value"]')).not.toBeNull()
  })

  test('一个分组都没有：只画「没有可选项」的说明', async () => {
    const { container } = await openFields([{ type: 'checks', key: 'sources', label: '来源', groups: [] }])
    expect(container.textContent).toContain('没有可选项。')
  })
})

describe('info 行与 button 动作', () => {
  const infoField = (patch: Partial<Extract<SettingsField, { type: 'info' }>> = {}): SettingsField => ({
    type: 'info',
    label: '配置文件',
    text: '/home/me/.dsc/config.yaml',
    mono: true,
    copyable: true,
    ...patch,
  })

  test('复制失败写「复制失败，请手动选中」', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('剪贴板被拒')) },
    })
    const { container } = await openFields([infoField()])
    await act(async () => {
      fireEvent.click(buttonOf(container, '复制') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(noteText(container)).toBe('复制失败，请手动选中')
  })

  test('打开路径：原生桥返回的失败原因原样写进行内说明；桥抛错也接住', async () => {
    const native = fakeNative({ openPath: () => '没有这个文件' })
    const first = await openFields([infoField()])
    await act(async () => {
      fireEvent.click(buttonOf(first.container, '打开') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(native.calls[0]?.op).toBe('openPath')
    expect(noteText(first.container)).toBe('打开失败：没有这个文件')

    cleanup()
    fakeNative({
      openPath: () => {
        throw new Error('系统拒绝')
      },
    })
    const second = await openFields([infoField()])
    await act(async () => {
      fireEvent.click(buttonOf(second.container, '打开') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(noteText(second.container)).toBe('打开失败：系统拒绝')
  })

  test('行内动作：只画壳认得的两个 id；没原生桥时如实说明哪做', async () => {
    const { container } = await openFields([
      infoField({
        actions: [
          { id: 'unknown-action', label: '别处' },
          { id: 'switch-config-file', label: '更换' },
          { id: 'reset-config-file', label: '恢复默认', tip: '回到出厂配置' },
        ],
      }),
    ])
    expect(buttonOf(container, '别处')).toBeUndefined()
    expect(buttonOf(container, '更换')).not.toBeUndefined()
    expect(buttonOf(container, '恢复默认')).not.toBeUndefined()
    await act(async () => {
      fireEvent.click(buttonOf(container, '更换') as HTMLButtonElement)
      await Promise.resolve()
    })
    expect(noteText(container)).toBe('换配置文件要在桌面版里做（浏览器里没有这条桥）')
  })

  test('换配置文件：选路径取消就停；宿主拒绝写原因；桥抛错走兜底说明', async () => {
    const native = fakeNative({ pickConfigFile: () => '', setConfigFile: () => ({ ok: false, error: '不是 YAML' }) })
    const { container } = await openFields([infoField({ actions: [{ id: 'switch-config-file', label: '更换' }] })])
    await act(async () => {
      fireEvent.click(buttonOf(container, '更换') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(native.calls.map((call) => call.op)).toEqual(['pickConfigFile'])

    native.calls.length = 0
    nativeOf().call = (op: string, args: unknown[] = []) => {
      native.calls.push({ op, args })
      if (op === 'pickConfigFile') return Promise.resolve('/tmp/other.yaml')
      if (op === 'setConfigFile') return Promise.resolve({ ok: false, error: '不是 YAML' })
      return Promise.resolve({ ok: true })
    }
    await act(async () => {
      fireEvent.click(buttonOf(container, '更换') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(native.calls.map((call) => call.op)).toEqual(['pickConfigFile', 'setConfigFile'])
    expect(noteText(container)).toBe('换配置文件失败：不是 YAML')

    nativeOf().call = () => Promise.reject(new Error('对话框没起来'))
    await act(async () => {
      fireEvent.click(buttonOf(container, '更换') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(noteText(container)).toBe('换配置文件失败：对话框没起来')
  })

  test('button 动作：失败与抛错都写「操作失败」', async () => {
    const { container } = await openFields(
      [{ type: 'button', action: 'run-check', label: '立即检查', style: 'ghost' }],
      { runSettingAction: () => ({ ok: false, error: '进程忙' }) },
    )
    const button = buttonOf(container, '立即检查') as HTMLButtonElement
    expect(button.className).toBe('btn-ghost')
    await act(async () => {
      fireEvent.click(button)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(noteText(container)).toBe('操作失败：进程忙')

    cleanup()
    const second = await openFields([{ type: 'button', action: 'run-check', label: '立即检查' }], {
      runSettingAction: () => {
        throw new Error('宿主挂了')
      },
    })
    await act(async () => {
      fireEvent.click(buttonOf(second.container, '立即检查') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(noteText(second.container)).toBe('操作失败：宿主挂了')
  })

  test('回执带 URL 但没有原生桥：写「只在桌面版里有」', async () => {
    const { container } = await openFields([{ type: 'button', action: 'check-update', label: '检查更新' }], {
      runSettingAction: () => ({ ok: true, data: { kind: 'url', url: 'https://example.com/releases' } }),
    })
    await act(async () => {
      fireEvent.click(buttonOf(container, '检查更新') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(noteText(container)).toContain('只在桌面版里有')
  })

  test('回执带 URL 且桥抛错：写「打开链接失败」', async () => {
    fakeNative({
      openExternal: () => {
        throw new Error('系统浏览器起不来')
      },
    })
    const { container } = await openFields([{ type: 'button', action: 'check-update', label: '检查更新' }], {
      runSettingAction: () => ({ ok: true, data: { kind: 'url', url: 'https://example.com/releases' } }),
    })
    await act(async () => {
      fireEvent.click(buttonOf(container, '检查更新') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(noteText(container)).toBe('打开链接失败：系统浏览器起不来')
  })

  test('回执带可装版本：就地给「立即更新」；无桥说明、有桥失败写原因', async () => {
    const routes = {
      runSettingAction: () => ({ ok: true, notice: '发现新版 1.2.3', data: { kind: 'update', version: '1.2.3' } }),
    }
    const { container } = await openFields([{ type: 'button', action: 'check-update', label: '检查更新' }], routes)
    await act(async () => {
      fireEvent.click(buttonOf(container, '检查更新') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(noteText(container)).toContain('发现新版 1.2.3')
    await act(async () => {
      fireEvent.click(buttonOf(container, '立即更新') as HTMLButtonElement)
      await Promise.resolve()
    })
    expect(noteText(container)).toContain('就地更新要用桌面外壳的原生桥')

    cleanup()
    fakeNative({ installUpdate: () => ({ ok: false, error: '下载失败' }) })
    const second = await openFields([{ type: 'button', action: 'check-update', label: '检查更新' }], routes)
    await act(async () => {
      fireEvent.click(buttonOf(second.container, '检查更新') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(buttonOf(second.container, '立即更新') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(noteText(second.container)).toBe('更新失败：下载失败')
  })

  test('回执带配对码：弹「手机连接」；重新生成的三条失败路径与 X 关闭', async () => {
    let round = 0
    const pairData = {
      kind: 'pair-code',
      code: '12345678',
      url: 'http://192.168.1.2:7777/?code=12345678',
      expiresAt: Date.now() + 60_000,
    }
    const { container } = await openFields([{ type: 'button', action: 'pair-code', label: '连接手机' }], {
      runSettingAction: () => {
        round += 1
        if (round === 1) return { ok: true, data: pairData }
        if (round === 2) return { ok: true, notice: '只有一句说明' }
        if (round === 3) throw new Error('宿主超时')
        return { ok: false, error: '宿主说不行' }
      },
    })
    await act(async () => {
      fireEvent.click(buttonOf(container, '连接手机') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })

    const modal = document.body.querySelector('.pair-card') as HTMLElement
    expect(modal).not.toBeNull()
    expect(modal.textContent).toContain('12345678')

    // 回执没有结构化载荷 → 弹窗里说「宿主没返回配对码内容」
    await act(async () => {
      fireEvent.click(buttonOf(document.body, '重新生成') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.body.querySelector('.pair-error')?.textContent).toBe(
      '这一版宿主没有返回配对码内容，请升级后再试',
    )

    // 通道抛错 → 弹窗里写「操作失败：宿主超时」
    await act(async () => {
      fireEvent.click(buttonOf(document.body, '重新生成') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.body.querySelector('.pair-error')?.textContent).toBe('操作失败：宿主超时')

    // 宿主明确拒绝
    await act(async () => {
      fireEvent.click(buttonOf(document.body, '重新生成') as HTMLButtonElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.body.querySelector('.pair-error')?.textContent).toBe('宿主说不行')

    // X 关掉：弹窗从 body 上消失
    const close = document.body.querySelector('.pair-card button[aria-label="关闭"]') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(close)
      await Promise.resolve()
    })
    expect(document.body.querySelector('.pair-card')).toBeNull()
  })
})

describe('分组头与并进父页的分区', () => {
  test('相邻同组字段只在第一行前插组头；两个子分区都并进父页', async () => {
    const sections = [
      sectionOf('general', '通用', {
        fields: [
          { type: 'text', key: 'a', label: '甲', group: 'g1' },
          { type: 'text', key: 'b', label: '乙', group: 'g1' },
          { type: 'text', key: 'c', label: '丙', group: 'g2' },
        ],
        groups: [
          { id: 'g1', title: '第一组' },
          { id: 'g2', title: '第二组' },
        ],
      }),
      sectionOf('terminal', '终端环境', { order: 1, parent: 'general', fields: [] }),
      sectionOf('tools', '工具默认值', { order: 2, parent: 'general', subtitle: '默认放行哪些工具' }),
    ]
    const { channel } = makeChannel({
      getSettingsSections: () => sections,
      getSectionValues: () => ({}),
      getUiPrefs: () => prefsOf(),
    })
    const { container } = await openPanel(channel)
    await flush()

    const titles = [...container.querySelectorAll('.settings-fields > .settings-group-title')].map(
      (node) => node.textContent,
    )
    expect(titles).toEqual(['第一组', '第二组'])
    // 并进父页的分区不占导航，但在正文末尾各画一块
    const embedded = [...container.querySelectorAll('.settings-embedded')] as HTMLElement[]
    expect(embedded.map((node) => node.getAttribute('data-section'))).toEqual(['terminal', 'tools'])
    expect(embedded[1]?.textContent).toContain('默认放行哪些工具')
    expect([...container.querySelectorAll('.settings-nav-item')].map((node) => node.textContent)).not.toContain(
      '终端环境',
    )
  })
})

describe('外观：字体、字号、六个下拉与两个开关', () => {
  test('读偏好失败：外观区写「读外观失败」并保留原因', async () => {
    const { container } = await openFields([], {
      getUiPrefs: () => {
        throw new Error('prefs.json 坏了')
      },
    })
    expect(container.textContent).toContain('读外观失败：prefs.json 坏了')
  })

  test('字体输入框：失焦写回；回车触发失焦；Esc 只清草稿不写（顺带关掉面板，见产出里的问题清单）', async () => {
    const { container, calls } = await openFields([], { getUiPrefs: () => prefsOf() })
    expect(container.textContent).toContain('外观')

    const textFont = container.querySelector('input[aria-label="正文字体"]') as HTMLInputElement
    fireEvent.change(textFont, { target: { value: 'Menlo' } })
    fireEvent.blur(textFont)
    await flush()
    expect(callsOf(calls, 'setUiPrefs')[0]).toEqual([{ textFontFamily: 'Menlo' }])

    const codeFont = container.querySelector('input[aria-label="代码字体"]') as HTMLInputElement
    codeFont.focus()
    fireEvent.change(codeFont, { target: { value: 'FiraCode' } })
    // 回车走真 blur()：输入框先拿到焦点，jsdom 才会把 blur 派发成 React 的 onBlur
    fireEvent.keyDown(codeFont, { key: 'Enter' })
    await flush()
    expect(callsOf(calls, 'setUiPrefs')[1]).toEqual([{ codeFontFamily: 'FiraCode' }])

    const again = container.querySelector('input[aria-label="正文字体"]') as HTMLInputElement
    fireEvent.change(again, { target: { value: '临时值' } })
    expect((container.querySelector('input[aria-label="正文字体"]') as HTMLInputElement).value).toBe('临时值')
    fireEvent.keyDown(again, { key: 'Escape' })
    // Esc 只清草稿、不写偏好；但它同时冒泡到面板的关闭钩子，面板被关掉（产出里记为源码问题）
    expect(callsOf(calls, 'setUiPrefs')).toHaveLength(2)
    expect(container.querySelector('.settings')).toBeNull()
  })

  test('字号滑块、六个下拉与两个提醒开关都写偏好', async () => {
    const { container, calls } = await openFields([], { getUiPrefs: () => prefsOf() })

    const range = container.querySelector('input[aria-label="字号"]') as HTMLInputElement
    fireEvent.change(range, { target: { value: '16' } })
    await flush()
    expect(callsOf(calls, 'setUiPrefs')[0]).toEqual([{ textSizePx: 16 }])
    expect(container.querySelector('.font-scale-value')?.textContent).toBe('16 px')

    await pickOption(triggerOf(container, '密度'), '紧凑')
    expect(callsOf(calls, 'setUiPrefs').at(-1)).toEqual([{ density: 'compact' }])

    await pickOption(triggerOf(container, '过程折叠程度'), '完全展开')
    expect(callsOf(calls, 'setUiPrefs').at(-1)).toEqual([{ processFold: 'verbose' }])

    await pickOption(triggerOf(container, '折叠时机'), '下次发言时收起')
    expect(callsOf(calls, 'setUiPrefs').at(-1)).toEqual([{ collapseTiming: 'next-input' }])

    await pickOption(triggerOf(container, '收起后显示的回复'), '只留最终回答')
    expect(callsOf(calls, 'setUiPrefs').at(-1)).toEqual([{ foldedReplies: 'final' }])

    await pickOption(triggerOf(container, '定稿的思考行默认态'), '默认展开')
    expect(callsOf(calls, 'setUiPrefs').at(-1)).toEqual([{ reasoningDefaultOpen: true }])

    await pickOption(triggerOf(container, '工具卡默认态'), '默认展开')
    expect(callsOf(calls, 'setUiPrefs').at(-1)).toEqual([{ toolDefaultOpen: true }])

    // 音色：选中即试听（jsdom 没有 AudioContext，发声函数自己静默），再写偏好
    await pickOptionAt(triggerOf(container, '提醒音音色'), 1)
    const variant = callsOf(calls, 'setUiPrefs').at(-1) as [Record<string, unknown>]
    expect(typeof variant[0]['turnCompleteSoundVariant']).toBe('number')

    const soundSwitch = container.querySelector('button[role="switch"][aria-label="任务提醒音"]') as HTMLButtonElement
    fireEvent.click(soundSwitch)
    await flush()
    expect(callsOf(calls, 'setUiPrefs').at(-1)).toEqual([{ turnCompleteSound: false }])

    const notifySwitch = container.querySelector(
      'button[role="switch"][aria-label="后台系统通知"]',
    ) as HTMLButtonElement
    fireEvent.click(notifySwitch)
    await flush()
    expect(callsOf(calls, 'setUiPrefs').at(-1)).toEqual([{ turnCompleteNotify: false }])
  })

  test('写偏好失败：显示回滚到原值并说明原因', async () => {
    const { container, calls } = await openFields([], {
      getUiPrefs: () => prefsOf(),
      setUiPrefs: () => {
        throw new Error('磁盘满')
      },
    })
    const range = container.querySelector('input[aria-label="字号"]') as HTMLInputElement
    fireEvent.change(range, { target: { value: '18' } })
    await flush()
    expect(callsOf(calls, 'setUiPrefs')).toHaveLength(1)
    expect((container.querySelector('input[aria-label="字号"]') as HTMLInputElement).value).not.toBe('18')
    expect(container.querySelector('.settings-note.error')?.textContent).toContain('没写进去：磁盘满')
  })
})

describe('命令面板：每个分区登记一条跳转动作', () => {
  test('动作按分区清单逐条登记；hint 取副标题；run 把我送进那一页', async () => {
    const registered: Array<{ owner: string; list: readonly UiAction[] }> = []
    const handle = {
      register: (owner: string, list: readonly UiAction[]): (() => void) => {
        registered.push({ owner, list })
        return () => undefined
      },
    } as unknown as ActionsHandle
    const registry = new ServiceRegistry()
    registry.provide(ACTIONS_SERVICE, handle, 'test')

    const sections = [
      sectionOf('general', '通用', { subtitle: '基础偏好', fields: [] }),
      sectionOf('about', '关于', { order: 9 }),
    ]
    const { channel } = makeChannel({
      getSettingsSections: () => sections,
      getSectionValues: () => ({}),
      getUiPrefs: () => prefsOf(),
    })
    const { container } = render(
      <ServicesProvider services={registry}>
        <RuntimeProvider channel={channel}>
          <SettingsPanel />
        </RuntimeProvider>
      </ServicesProvider>,
    )
    await act(async () => {
      window.dispatchEvent(new CustomEvent('shell.settings.open'))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(registered.map((item) => item.owner)).toEqual(['settings'])
    const list = registered[0]?.list ?? []
    expect(list.map((item) => item.id)).toEqual(['settings.general', 'settings.about'])
    expect(list[0]?.hint).toBe('基础偏好')
    expect(list[0]?.keywords).toContain('general')

    // run：切到那一页（面板已经是开的，断言标题跟着换）
    await act(async () => {
      list[1]?.run()
      await Promise.resolve()
    })
    expect(container.querySelector('.settings-main h2')?.textContent).toBe('关于')


  })
})

