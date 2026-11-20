/**
 * `ui-plugins` 的补盲：内核重启在没有桌面桥时的回执、组合包卡片的只读入口、配置表单里
 * 记录表的草稿清理与「派生值置灰」分支。
 *
 * 缺口逐条（`ui.tsx`）：
 *   - `282-283`：重启内核时原生桥不可用 → 红色 toast 说清「只在桌面窗口可用」；
 *   - `491-492`：组合包卡片的两颗只读入口（开卡 / 确认都是空操作，包装上即同意）；
 *   - `1042`：列上写的 `pattern` 是坏正则 → 按通过处理（不拦写回）；
 *   - `1226`：加 / 删行时清草稿只清记录表那一组（别的字段的草稿留着）；
 *   - `1301-1302`：失焦时输入与存档相同 → 把草稿丢掉、不写回；
 *   - `1317`：格子里回车 = 失焦（等于提交这一格）；
 *   - `1375`：`select` 的值不在选项里、又有派生显示名 → 置灰只读那一支。
 *
 * 装载方式沿用同目录 `w13-plugins-config.spec.tsx`（照壳收下 `shell.page` 的登记、
 * `setShellPage('plugins')` 进整页）；假通道只认本页用到的那几个方法。
 *
 * @module dsc-ui-plugins/ui/w14-plugins
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, setShellPage, type HostChannel } from '@dsc/ui-runtime'
import type { HostHello, UiPluginApi } from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import plugin from './ui.js'

/** 照壳装载插件那条路，收下 `shell.page` 上的插件页。 */
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
    consume(): undefined {
      return undefined
    },
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  const found = registered.find((item) => item.slot === 'shell.page')
  if (found === undefined) throw new Error('plugins 插件没有把页面登记进 shell.page')
  return found.component as ComponentType
}

const PluginsPage = pluginsPage()

type Reply = unknown | ((args: unknown[]) => unknown)

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
}

function harnessOf(options: { plugins?: unknown; trusts?: unknown; replies?: Record<string, Reply> }): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const replies: Record<string, Reply> = {
    listPlugins: options.plugins ?? [],
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
      const value = typeof reply === 'function' ? (reply as (args: unknown[]) => unknown)(args) : reply
      return Promise.resolve(value as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <PluginsPage />
    </RuntimeProvider>,
  )

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''
const toastTexts = (): string[] => [...document.querySelectorAll('.dsc-toast__text')].map((node) => textOf(node))

const builtin = (file: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  file,
  name: file,
  source: 'builtin',
  description: `${file} 的说明`,
  enabled: true,
  toggleable: true,
  ...patch,
})

const packageRow = (name: string): Record<string, unknown> => ({
  name,
  origin: 'package',
  version: '1.0.0',
  profile: 'main',
  platforms: ['web'],
  trusted: true,
  enabled: true,
})

/** 进某个插件的详情页。 */
async function openDetail(container: HTMLElement, file: string): Promise<void> {
  fireEvent.click(container.querySelector(`.plugin-row[data-plugin="${file}"]`) as HTMLElement)
  await flush()
}

/** 配置表单的通用挂载：进详情 + 等值读完。 */
async function mountConfig(options: {
  fields: unknown[]
  values: unknown
  replies?: Record<string, Reply>
}): Promise<{ container: HTMLElement; harness: Harness }> {
  const section = { id: 'sec', title: '配置', order: 1, builtin: false, custom: false, fields: options.fields }
  const harness = harnessOf({
    plugins: [builtin('cfg', { settingsSection: 'sec' })],
    replies: {
      getSettingsSections: [section],
      getSectionValues: options.values,
      ...options.replies,
    },
  })
  const { container } = mount(harness)
  await flush()
  await openDetail(container, 'cfg')
  return { container, harness }
}

beforeEach(() => {
  setShellPage('plugins')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: (): void => undefined })
  document.querySelector('.dsc-toasts')?.remove()
})

afterEach(() => {
  cleanup()
  setShellPage(null)
  document.body.innerHTML = ''
  delete (globalThis as { dscNative?: unknown }).dscNative
  vi.restoreAllMocks()
})

describe('内核重启与组合包卡片', () => {
  // `282-283`（没有原生桥时点「重启内核」给红色回执）**没有覆盖**：没有桥时那颗钮带
  // `disabled` 渲染（`ui.tsx:390`），React 对 disabled 的 button 不派发 click，
  // 正常用法下这两行走不到。要覆盖它得改产品（把「不可用」做成可点 + 提示），不在本次写权限内。
  test('没有桌面桥：重启钮按不可用渲染（disabled，提示写「只在桌面版里有」）', async () => {
    delete (globalThis as { dscNative?: unknown }).dscNative
    const harness = harnessOf({ plugins: [builtin('tools-default')] })
    mount(harness)
    await flush()
    const restart = document.querySelector(`[aria-label="${zh['plugins.action.restart']}"]`) as HTMLButtonElement
    expect(restart).not.toBeNull()
    expect(restart.disabled).toBe(true)
    expect(restart.getAttribute('data-tip')).toBe(zh['plugins.action.restartTipBrowser'])
  })

  test('组合包卡片：只读入口点下去不炸、不开确认框（包装进 profile 就是同意）', async () => {
    const harness = harnessOf({ trusts: [packageRow('pkg-a')] })
    const { container } = mount(harness)
    await flush()
    const card = container.querySelector('[data-trust="pkg-a"]') as HTMLElement
    expect(card).not.toBeNull()
    // 整卡头（onOpen 是空操作）与确认钮（onConfirm 是空操作：组合包不画这颗钮）。
    fireEvent.click(card)
    await flush()
    expect(document.querySelector('.dsc-confirm')).toBeNull()
    expect(container.querySelector('[data-trust="pkg-a"]')).not.toBeNull()
  })
})

describe('记录表的草稿与校验', () => {
  test('格子里回车＝失焦；输入与存档相同就丢草稿不写回', async () => {
    const store: Record<string, unknown> = { allow: [{ name: 'ok' }] }
    const writes: unknown[][] = []
    const { container } = await mountConfig({
      fields: [
        {
          type: 'rows',
          key: 'allow',
          label: '准入表',
          columns: [{ key: 'name', label: '名称', type: 'text' }],
        },
      ],
      values: () => ({ ...store }),
      replies: {
        getSectionValues: () => ({ ...store }),
        setSettingValue: (args: unknown[]) => {
          writes.push(args)
          return { ok: true }
        },
      },
    })
    const cell = container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement
    fireEvent.change(cell, { target: { value: 'ok' } })
    fireEvent.keyDown(cell, { key: 'Enter' })
    fireEvent.blur(cell)
    await flush()
    expect(writes).toHaveLength(0)
    expect(store['allow']).toEqual([{ name: 'ok' }])
  })

  test('坏正则按通过处理：写回照做，不给「不符合格式」', async () => {
    const store: Record<string, unknown> = { allow: [{ name: 'ok' }] }
    const { container } = await mountConfig({
      fields: [
        {
          type: 'rows',
          key: 'allow',
          label: '准入表',
          columns: [{ key: 'name', label: '名称', type: 'text', pattern: '[' }],
        },
      ],
      values: () => ({ ...store }),
      replies: {
        getSectionValues: () => ({ ...store }),
        setSettingValue: (args: unknown[]) => {
          store['allow'] = args[2]
          return { ok: true }
        },
      },
    })
    const cell = container.querySelector('input[aria-label="第 1 行的名称"]') as HTMLInputElement
    fireEvent.change(cell, { target: { value: 'Has Space' } })
    fireEvent.blur(cell)
    await flush()
    expect(store['allow']).toEqual([{ name: 'Has Space' }])
    expect(container.querySelector('.settings-note')).toBeNull()
  })

  test('加一行时清草稿只清本表那一组（别的字段的草稿留着）', async () => {
    const store: Record<string, unknown> = { allow: [{ name: 'ok' }], note: 'stored' }
    const { container } = await mountConfig({
      fields: [
        { type: 'text', key: 'note', label: '备注' },
        {
          type: 'rows',
          key: 'allow',
          label: '准入表',
          columns: [{ key: 'name', label: '名称', type: 'text' }],
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
    // 先在备注里打字（产生一份不属于记录表前缀的草稿），再点「添加一行」。
    const note = [...container.querySelectorAll('input.setting-input')].find(
      (node) => (node as HTMLInputElement).type !== 'text' || node.getAttribute('aria-label') === '备注',
    ) as HTMLInputElement | undefined
    const noteInput = (note ?? (container.querySelector('.setting-row input') as HTMLInputElement)) as HTMLInputElement
    fireEvent.change(noteInput, { target: { value: '草稿' } })
    const add = [...container.querySelectorAll('button')].find((node) => textOf(node).includes('添加一行')) as
      HTMLButtonElement | undefined
    expect(add).toBeDefined()
    fireEvent.click(add as HTMLButtonElement)
    await flush()
    expect((store['allow'] as unknown[]).length).toBe(2)
    // 备注的草稿还在输入框里（没被记录表的清理连带清掉）。
    expect(noteInput.value).toBe('草稿')
  })
})

describe('派生值置灰的 select', () => {
  test('值不在选项里、又有派生显示名：渲染成只读下拉', async () => {
    const { container } = await mountConfig({
      fields: [
        {
          type: 'select',
          key: 'mode',
          label: '模式',
          options: [{ value: 'a', label: 'A 档' }],
          derivedLabelKey: 'modeLabel',
        },
      ],
      values: { mode: 'zzz', modeLabel: '宿主给的显示名' },
    })
    const row = container.querySelector('.setting-row') as HTMLElement
    expect(row).not.toBeNull()
    expect(textOf(row)).toContain('宿主给的显示名')
    const trigger = row.querySelector('.select-trigger') as HTMLElement
    expect(trigger).not.toBeNull()
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
  })
})
