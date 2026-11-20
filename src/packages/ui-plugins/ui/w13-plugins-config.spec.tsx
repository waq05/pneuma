/**
 * 插件页第三批补测（`ui-plugins/ui/ui.tsx`）：分组展开键、页头原生动作的抛错分支、
 * 卡片齿轮入口、详情页配置表单的 `fact` / `rows` / `info` / `button` 与四条失败链路。
 *
 * `ui.spec` 钉住七段分组与信任披露，`plugins-extra` 钉住安装/重启主链路、启停回滚与
 * 配置表单的标量控件。这一份只补它们没碰到的：
 *
 * - 第三方 / 组合包 / 内核三段的「展开更多」各翻一次（每段一个键）；
 * - 重启内核与确认信任在原生桥**抛错**时的落点；
 * - 可配置插件卡右边那颗齿轮（stopPropagation 后进详情）；
 * - 详情页读分区失败、读值失败；
 * - `rows` 记录表的增删行、文本格失焦、正则拒绝、下拉格的「未识别」；
 * - `fact` 的有值/占位、`info` 的复制失败与 `openPath` 三态、`button` 抛错；
 * - 乐观写入失败与回读失败两条收尾。
 *
 * @module dsc-ui-plugins/ui/w13-plugins-config.spec
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
  enabled: boolean
  problem?: string
  problemKind?: 'manifest' | 'clash' | 'version' | 'artifact' | 'stale'
}

const builtin = (file: string, patch: Partial<PluginRow> = {}): PluginRow => ({
  file,
  name: file,
  source: 'builtin',
  description: `${file} 的说明`,
  enabled: true,
  toggleable: true,
  ...patch,
})

const packageRow = (name: string): TrustRow => ({
  name,
  origin: 'package',
  version: '1.0.0',
  profile: 'main',
  platforms: ['web'],
  trusted: true,
  enabled: true,
})

type Handler = (args: unknown[]) => unknown
type Reply = unknown | Handler

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
  nativeCalls: Array<{ op: string; args: unknown[] }>
}

function harnessOf(options: {
  plugins?: unknown
  trusts?: unknown
  replies?: Record<string, Reply>
  native?: Record<string, Reply>
}): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const nativeCalls: Array<{ op: string; args: unknown[] }> = []
  const replies: Record<string, Reply> = {
    listPlugins: options.plugins ?? [builtin('tools-default')],
    listUiTrust: options.trusts ?? [],
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

  const ops: Record<string, Reply> = {
    setUiTrust: { ok: true, notice: '信任了' },
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
      } catch (error: unknown) {
        return Promise.reject(error)
      }
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
    await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''
const toastTexts = (): string[] => [...document.querySelectorAll('.dsc-toast__text')].map((node) => textOf(node))

const buttonOf = (scope: ParentNode, label: string): HTMLButtonElement | undefined =>
  ([...scope.querySelectorAll('button')] as HTMLButtonElement[]).find((node) => node.textContent === label)

/** 进某个插件的详情页。 */
async function openDetail(container: HTMLElement, file: string): Promise<void> {
  fireEvent.click(container.querySelector(`.plugin-row[data-plugin="${file}"]`) as HTMLElement)
  await flush()
}

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

describe('七段里剩下三段的展开键', () => {
  test('第三方段：展开 11 条并收起；信任卡带 API/平台/徽标', async () => {
    const trusts: TrustRow[] = Array.from({ length: 11 }, (_, index) => ({
      name: `ext-${String(index)}`,
      platforms: ['web'],
      trusted: false,
      enabled: false,
      api: '^1.0.0',
    }))
    const { container } = mount(harnessOf({ trusts }))
    await flush()

    expect(container.querySelectorAll('[data-trust]')).toHaveLength(10)
    const more = container.querySelector('.plugin-more') as HTMLElement
    expect(textOf(more)).toContain('展开其余 1 个')
    fireEvent.click(more)
    expect(container.querySelectorAll('[data-trust]')).toHaveLength(11)
    fireEvent.click(container.querySelector('.plugin-more') as HTMLElement)
    expect(container.querySelectorAll('[data-trust]')).toHaveLength(10)
    expect(textOf(container.querySelector('[data-trust="ext-0"]'))).toContain('@dsc/ui ^1.0.0')
  })

  test('组合包段：展开 11 条，版本与 profile 徽标都在', async () => {
    const trusts = Array.from({ length: 11 }, (_, index) => packageRow(`pkg-${String(index)}`))
    const { container } = mount(harnessOf({ trusts }))
    await flush()

    expect(container.querySelectorAll('[data-trust]')).toHaveLength(10)
    fireEvent.click(container.querySelector('.plugin-more') as HTMLElement)
    expect(container.querySelectorAll('[data-trust]')).toHaveLength(11)
    const first = container.querySelector('[data-trust="pkg-0"]') as HTMLElement
    expect(textOf(first)).toContain('v1.0.0')
    expect(textOf(first)).toContain('profile main')
    // 组合包装进 profile 就是同意：没有「查看并信任」按钮
    expect(first.querySelector('.btn-primary')).toBeNull()
  })

  test('内核段：不可拨的行也收成一段，超过 10 条同样能展开', async () => {
    const rows = Array.from({ length: 11 }, (_, index) => builtin(`k-${String(index)}`, { toggleable: false }))
    const { container } = mount(harnessOf({ plugins: rows }))
    await flush()

    expect(container.querySelectorAll('.plugin-row')).toHaveLength(10)
    fireEvent.click(container.querySelector('.plugin-more') as HTMLElement)
    expect(container.querySelectorAll('.plugin-row')).toHaveLength(11)
    // 不可拨的行：开关锁住
    expect((container.querySelector('.plugin-row .switch') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('页头原生动作的抛错分支', () => {
  test('重启内核：原生桥抛错时 toast 写「重启失败：<原因>」', async () => {
    const harness = harnessOf({ native: { restartHost: new Error('内核进程不在了') } })
    mount(harness)
    await flush()

    fireEvent.click(document.querySelector('[aria-label="重启内核"]') as HTMLElement)
    fireEvent.click(document.querySelector('.dsc-confirm [data-variant="destructive"]') as HTMLElement)
    await flush()
    expect(harness.nativeCalls.some((call) => call.op === 'restartHost')).toBe(true)
    expect(toastTexts().some((text) => text.includes('重启失败：内核进程不在了'))).toBe(true)
  })

  test('确认信任：原生桥抛错时 toast 写「确认失败：<原因>」，并保持未信任态', async () => {
    const trusts: TrustRow[] = [{ name: 'ext-ui', platforms: ['web'], trusted: false, enabled: false }]
    const harness = harnessOf({ trusts, native: { setUiTrust: new Error('plugins.json 只读') } })
    const { container } = mount(harness)
    await flush()

    fireEvent.click(buttonOf(container.querySelector('[data-trust="ext-ui"]') as HTMLElement, '查看并信任') as HTMLButtonElement)
    await flush()
    fireEvent.click(buttonOf(document, '确认信任') as HTMLButtonElement)
    await flush()
    expect(toastTexts().some((text) => text.includes('确认失败：plugins.json 只读'))).toBe(true)
    expect(container.querySelector('[data-trust="ext-ui"] .trust-disclosure')).not.toBeNull()
  })
})

describe('详情页入口与读失败', () => {
  test('可配置插件卡右边那颗齿轮：拦下整卡点击后进详情', async () => {
    const section = {
      id: 'sec',
      title: '配置',
      order: 1,
      builtin: false,
      custom: false,
      fields: [{ type: 'text', key: 'name', label: '名称' }],
    }
    const harness = harnessOf({
      plugins: [builtin('cfg', { settingsSection: 'sec' })],
      replies: { getSettingsSections: [section], getSectionValues: {} },
    })
    const { container } = mount(harness)
    await flush()

    const gear = container.querySelector('.plugin-row[data-plugin="cfg"] .icon-btn') as HTMLButtonElement
    expect(gear.getAttribute('aria-label')).toBe('配置 cfg')
    fireEvent.click(gear)
    await flush()
    expect(container.querySelector('.plugin-detail')).not.toBeNull()
    expect(harness.calls.some((call) => call.method === 'getSettingsSections')).toBe(true)
  })

  test('读分区抛错：详情页落回「没有可配置项」，不留一根空骨架', async () => {
    const harness = harnessOf({
      plugins: [builtin('cfg', { settingsSection: 'sec' })],
      replies: {
        getSettingsSections: () => {
          throw new Error('宿主没实现')
        },
      },
    })
    const { container } = mount(harness)
    await flush()
    await openDetail(container, 'cfg')

    expect(container.querySelector('.settings-loading')).toBeNull()
    expect(textOf(container.querySelector('.settings-empty'))).toBe('该插件没有可配置项。')
  })
})

/** 配置表单的通用挂载：进详情 + 等值读完。 */
async function mountConfig(options: {
  fields: unknown[]
  values: unknown
  replies?: Record<string, Reply>
  native?: Record<string, Reply>
}): Promise<{ container: HTMLElement; harness: Harness }> {
  const section = {
    id: 'sec',
    title: '配置',
    order: 1,
    builtin: false,
    custom: false,
    fields: options.fields,
  }
  const harness = harnessOf({
    plugins: [builtin('cfg', { settingsSection: 'sec' })],
    replies: {
      getSettingsSections: [section],
      getSectionValues: options.values,
      ...options.replies,
    },
    ...(options.native === undefined ? {} : { native: options.native }),
  })
  const { container } = mount(harness)
  await flush()
  await openDetail(container, 'cfg')
  return { container, harness }
}

describe('配置表单的 rows 记录表', () => {
  test('文本格失焦写回、下拉格选一项、加一行、删一行；值在界面与宿主之间对齐', async () => {
    const store: Record<string, unknown> = { allow: [{ name: 'old', mode: 'b' }] }
    const { container, harness } = await mountConfig({
      fields: [
        {
          type: 'rows',
          key: 'allow',
          label: '准入表',
          columns: [
            { key: 'name', label: '名称', type: 'text', placeholder: '仓库名' },
            { key: 'mode', label: '模式', type: 'select', options: [{ value: 'a', label: 'A 档' }] },
          ],
        },
      ],
      values: () => ({ ...store }),
      replies: {
        getSectionValues: () => ({ ...store }),
        setSettingValue: (args: unknown[]) => {
          store[args[1] as string] = args[2]
          return { ok: true }
        },
      },
    })

    const select = container.querySelector('select[aria-label="第 1 行的模式"]') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual(['A 档', 'b · 未识别'])
    await act(async () => {
      fireEvent.change(select, { target: { value: 'a' } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(store['allow']).toEqual([{ name: 'old', mode: 'a' }])

    const cell = container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement
    expect(cell.placeholder).toBe('仓库名')
    fireEvent.change(cell, { target: { value: 'next' } })
    fireEvent.blur(cell)
    await flush()
    expect(store['allow']).toEqual([{ name: 'next', mode: 'a' }])

    fireEvent.click(buttonOf(container, '添加一行') as HTMLButtonElement)
    await flush()
    expect(store['allow']).toEqual([{ name: 'next', mode: 'a' }, {}])

    const remove = container.querySelector('button[aria-label="删除这一行"]') as HTMLButtonElement
    fireEvent.click(remove)
    await flush()
    expect(store['allow']).toEqual([{}])
    expect(harness.calls.filter((call) => call.method === 'setSettingValue').length).toBeGreaterThanOrEqual(4)
  })

  test('正则不匹配：行内说明写「不符合格式」，不写回；坏正则按通过处理', async () => {
    const store: Record<string, unknown> = { allow: [{ name: 'ok' }] }
    const { container } = await mountConfig({
      fields: [
        {
          type: 'rows',
          key: 'allow',
          label: '准入表',
          columns: [{ key: 'name', label: '名称', type: 'text', pattern: '^[a-z]+$' }],
        },
      ],
      values: () => ({ ...store }),
      replies: {
        getSectionValues: () => ({ ...store }),
        setSettingValue: (args: unknown[]) => {
          store[args[1] as string] = args[2]
          return { ok: true }
        },
      },
    })

    const cell = container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement
    fireEvent.change(cell, { target: { value: 'Has Space' } })
    fireEvent.blur(cell)
    await flush()
    expect(store['allow']).toEqual([{ name: 'ok' }])
    expect(textOf(container.querySelector('.settings-note'))).toContain('名称 这一格不符合格式：Has Space')
  })

  test('保存被拒（ok:false）与通道抛错：都写「保存失败」，并回读宿主那份把乐观值收回去', async () => {
    let mode: 'reject' | 'throw' = 'reject'
    const store: Record<string, unknown> = { allow: [{ name: 'old' }] }
    const reads: number[] = []
    const { container } = await mountConfig({
      fields: [
        {
          type: 'rows',
          key: 'allow',
          label: '准入表',
          columns: [{ key: 'name', label: '名称', type: 'text' }],
        },
      ],
      values: { allow: [{ name: 'old' }] },
      replies: {
        getSectionValues: () => {
          reads.push(1)
          return { ...store }
        },
        setSettingValue: () => {
          if (mode === 'reject') return { ok: false, error: '配置文件只读' }
          throw new Error('写盘炸了')
        },
      },
    })

    const first = container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement
    fireEvent.change(first, { target: { value: 'a' } })
    fireEvent.blur(first)
    await flush()
    expect(textOf(container.querySelector('.settings-note'))).toContain('保存失败：配置文件只读')
    // 乐观值被回读收回去
    expect((container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement).value).toBe('old')
    const readsAfterReject = reads.length

    mode = 'throw'
    const second = container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement
    fireEvent.change(second, { target: { value: 'b' } })
    fireEvent.blur(second)
    await flush()
    expect(textOf(container.querySelector('.settings-note'))).toContain('保存失败：写盘炸了')
    expect(reads.length).toBeGreaterThan(readsAfterReject)
  })

  test('回读抛错被吞掉：界面不崩，也不再写说明', async () => {
    let read = 0
    const { container } = await mountConfig({
      fields: [
        {
          type: 'rows',
          key: 'allow',
          label: '准入表',
          columns: [{ key: 'name', label: '名称', type: 'text' }],
        },
      ],
      values: { allow: [{ name: 'old' }] },
      replies: {
        getSectionValues: () => {
          read += 1
          if (read === 1) return { allow: [{ name: 'old' }] }
          throw new Error('读不回来了')
        },
        setSettingValue: { ok: true },
      },
    })

    const cell = container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement
    fireEvent.change(cell, { target: { value: 'new' } })
    fireEvent.blur(cell)
    await flush()
    expect(read).toBeGreaterThanOrEqual(2)
    expect(container.querySelector('.settings-note')).toBeNull()
  })
})

describe('配置表单的 fact / info / button', () => {
  test('fact：标量照画，缺失与对象给占位；info：复制失败写清楚', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('剪贴板被拒')) },
    })
    const { container } = await mountConfig({
      fields: [
        { type: 'fact', key: 'deploy', label: '部署', help: '来自部署检查' },
        { type: 'fact', key: 'missing', label: '缺失' },
        { type: 'fact', key: 'weird', label: '怪值' },
        { type: 'info', label: '路径', text: '/tmp/x', copyable: true },
      ],
      values: { deploy: 42, weird: { nested: true } },
    })

    const rows = [...container.querySelectorAll('.setting-row.info')] as HTMLElement[]
    expect(rows).toHaveLength(4)
    expect(rows[0]?.querySelector('.setting-info')?.textContent).toBe('42')
    expect(rows[1]?.querySelector('.setting-info')?.textContent).toBe('（没有值）')
    expect(rows[2]?.querySelector('.setting-info')?.textContent).toBe('（没有值）')

    fireEvent.click(buttonOf(container, '复制') as HTMLButtonElement)
    await flush()
    expect(textOf(container.querySelector('.settings-note'))).toBe('复制失败，请手动选中')
  })

  test('info 的「打开」：没有原生桥时说明只在桌面版；桥回执失败与桥抛错各写原因', async () => {
    const first = await mountConfig({
      fields: [{ type: 'info', label: '路径', text: '/tmp/x', copyable: true }],
      values: {},
      native: {},
    })
    // 把桥拆掉：模拟浏览器页签
    delete (globalThis as { dscNative?: unknown }).dscNative
    fireEvent.click(buttonOf(first.container, '打开') as HTMLButtonElement)
    await flush()
    expect(textOf(first.container.querySelector('.settings-note'))).toBe(
      '用系统程序打开只在桌面版里有（浏览器里没有这条桥）',
    )

    cleanup()
    const failing = await mountConfig({
      fields: [{ type: 'info', label: '路径', text: '/tmp/x', copyable: true }],
      values: {},
      native: { openPath: '找不到这个目录' },
    })
    fireEvent.click(buttonOf(failing.container, '打开') as HTMLButtonElement)
    await flush()
    expect(textOf(failing.container.querySelector('.settings-note'))).toBe('打开失败：找不到这个目录')

    cleanup()
    const thrown = await mountConfig({
      fields: [{ type: 'info', label: '路径', text: '/tmp/x', copyable: true }],
      values: {},
      native: { openPath: new Error('文件管理器起不来') },
    })
    fireEvent.click(buttonOf(thrown.container, '打开') as HTMLButtonElement)
    await flush()
    expect(textOf(thrown.container.querySelector('.settings-note'))).toBe('打开失败：文件管理器起不来')
  })

  test('button 动作：ok:false 与通道抛错都写「操作失败」', async () => {
    const rejected = await mountConfig({
      fields: [{ type: 'button', action: 'do', label: '执行', style: 'ghost' }],
      values: {},
      replies: { runSettingAction: { ok: false, error: '宿主忙着' } },
    })
    const button = buttonOf(rejected.container, '执行') as HTMLButtonElement
    expect(button.className).toBe('btn-ghost')
    fireEvent.click(button)
    await flush()
    expect(textOf(rejected.container.querySelector('.settings-note'))).toContain('操作失败：宿主忙着')

    cleanup()
    const thrown = await mountConfig({
      fields: [{ type: 'button', action: 'do', label: '执行' }],
      values: {},
      replies: {
        runSettingAction: () => {
          throw new Error('宿主进程没了')
        },
      },
    })
    fireEvent.click(buttonOf(thrown.container, '执行') as HTMLButtonElement)
    await flush()
    expect(textOf(thrown.container.querySelector('.settings-note'))).toContain('操作失败：宿主进程没了')
  })

  test('读值抛错：表单底部写「读取设置失败」并保留原因', async () => {
    const { container } = await mountConfig({
      fields: [{ type: 'text', key: 'name', label: '名称' }],
      values: {},
      replies: {
        getSectionValues: () => {
          throw new Error('值表坏了')
        },
      },
    })
    expect(container.querySelector('.settings-fields')).not.toBeNull()
    expect(textOf(container.querySelector('.settings-note'))).toContain('读取设置失败：值表坏了')
  })
})
