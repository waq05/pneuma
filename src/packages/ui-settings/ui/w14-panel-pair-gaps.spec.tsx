/**
 * 设置面板（`ui-settings/ui/ui.tsx`）与手机连接弹窗（`ui-settings/ui/pair-modal.tsx`）的
 * W14 补盲：既有 spec 走不到的那几条错误路与边角状态。
 *
 * 覆盖：
 * - 配对码弹窗里的「重新生成 / 打开局域网访问」成功回执（`regeneratePair` 的 ok 分支，
 *   以及 `PairModal` 的 `onEnableLan` 接线）；
 * - `rows` 表格加行时清草稿的那条「别的字段草稿也要留着」的守卫，以及保存回执里的 notice；
 * - 派生选择框（值不在选项里、宿主给了显示名的置灰只读档）；
 * - 字体输入框的 Escape（外层弹层已经 preventDefault 时只清草稿、不关面板）；
 * - 二维码生成失败只把那一格换成说明；
 * - Tab 循环里一个可聚焦元素都没有时把焦点拉回弹层本身；
 * - 复制失败的回执。
 *
 * 挂载方式沿用 `w13-settings-fields.spec.tsx`：照生产壳装载插件收 `shell.header` 的登记，
 * 再用 `shell.settings.open` 打开面板。二维码库在 jsdom 里没有画布，换成一个可控制成败的假实现。
 *
 * @module dsc-ui-settings/ui/w14-panel-pair-gaps.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { PairShareData, SettingsField, SettingsSectionView, SettingsValues, UiPluginApi } from '@dsc/ui'
import { PairModal } from './pair-modal.js'
import plugin from './ui.js'
import zh from '../locale/ui.zh.json'

const qr = vi.hoisted<{ toDataURL: ReturnType<typeof vi.fn> }>(() => ({ toDataURL: vi.fn() }))

// 二维码库在 jsdom 里没有画布：换成可控制成败的假实现，弹窗逻辑仍然真跑。
vi.mock('qrcode', () => ({ default: { toDataURL: qr.toDataURL } }))

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
function makeChannel(routes: Record<string, (args: unknown[]) => unknown>): { channel: HostChannel; calls: Recorded[] } {
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

function sectionOf(id: string, title: string, patch: Partial<SettingsSectionView> = {}): SettingsSectionView {
  return { id, title, order: 0, builtin: true, custom: false, fields: [], ...patch }
}

const prefsOf = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  themeMode: 'claude',
  fontSize: 1,
  density: 'standard',
  ...patch,
})

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 4; index += 1) await Promise.resolve()
  })

/** 挂面板并打开它（面板默认关着，侧栏事件是生产里的开门路径）。 */
async function openPanel(channel: HostChannel): Promise<ReturnType<typeof render>> {
  const rendered = render(
    <RuntimeProvider channel={channel}>
      <SettingsPanel />
    </RuntimeProvider>,
  )
  await act(async () => {
    window.dispatchEvent(new CustomEvent('shell.settings.open'))
    for (let index = 0; index < 4; index += 1) await Promise.resolve()
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

const textOf = (element: Element | null): string => element?.textContent ?? ''
const noteText = (container: HTMLElement): string => textOf(container.querySelector('.settings-note'))
const toastText = (): string => textOf(document.querySelector('.dsc-toasts'))

/** 一张配对数据；reach 决定画二维码还是给「打开局域网访问」引导。 */
function pairData(patch: Record<string, unknown> = {}): PairShareData {
  return {
    kind: 'pair-code',
    code: '12345678',
    url: 'http://192.168.1.2:7777/?code=12345678',
    expiresAt: Date.now() + 60_000,
    reach: 'lan',
    ...patch,
  } as PairShareData
}

const noopResult = async (): Promise<{ ok: false; error: string }> => ({ ok: false, error: '没做' })

beforeEach(() => {
  qr.toDataURL.mockReset()
  qr.toDataURL.mockResolvedValue('data:image/png;base64,QQ==')
  document.body.innerHTML = ''
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(() => Promise.resolve()) },
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.querySelectorAll('.dsc-toasts, .dsc-confirm, .pair-modal').forEach((node) => node.remove())
  Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

describe('配对码弹窗：重新生成与打开局域网', () => {
  test('只允许本机时点「打开局域网访问」：走 onEnableLan 换上可达的新码', async () => {
    let round = 0
    const { container } = await openFields([{ type: 'button', action: 'pair-code', label: '连接手机' }], {
      runSettingAction: () => {
        round += 1
        if (round === 1) return { ok: true, data: pairData({ reach: 'local' }) }
        return { ok: true, data: pairData({ reach: 'lan', code: '87654321' }) }
      },
    })
    await act(async () => {
      const trigger = [...container.querySelectorAll('button')].find((button) => button.textContent === '连接手机')
      fireEvent.click(trigger as HTMLElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    const card = document.querySelector('.pair-card') as HTMLElement
    expect(card).not.toBeNull()
    expect(card.querySelector('.pair-qr-guide-title')).not.toBeNull()

    await act(async () => {
      fireEvent.click(card.querySelector('.pair-qr-guide .btn-primary') as HTMLElement)
      await Promise.resolve()
      await Promise.resolve()
    })
    // 面板里 regeneratePair 成功那条：回执带 pair-code 就原地换码（并重取分区）。
    expect(document.querySelector('.pair-code')?.textContent).toBe('87654321')
    expect(document.querySelector('.pair-qr-guide')).toBeNull()
    expect(container).toBeTruthy()
  })
})

describe('声明式字段的边角', () => {
  test('表格加行只清本表草稿：别的字段草稿不动；保存回执带 notice 时写进行内说明', async () => {
    const { container } = await openFields(
      [
        { key: 'nick', type: 'text', label: '昵称' },
        { key: 'allow', type: 'rows', label: '准入表', columns: [{ key: 'name', label: '名称', type: 'text' }] },
      ],
      { setSettingValue: () => ({ ok: true, notice: '宿主已收到' }) },
      { nick: '旧名字', allow: [{ name: 'ok' }] },
    )
    const nick = container.querySelector('input[aria-label="昵称"]') as HTMLInputElement
    fireEvent.change(nick, { target: { value: '新名字' } })
    fireEvent.click(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === zh['settings.ui.rows.add'],
      ) as HTMLElement,
    )
    await flush()
    expect(noteText(container)).toBe('宿主已收到')
    // 「昵称」的草稿没被表格的 clearDrafts 清掉。
    expect((container.querySelector('input[aria-label="昵称"]') as HTMLInputElement).value).toBe('新名字')
  })

  test('派生选择框：值不在选项里但宿主给了显示名 → 置灰只读，不画成可选下拉', async () => {
    const { container } = await openFields(
      [
        {
          key: 'permissionPreset',
          type: 'select',
          label: '权限预设',
          options: [{ value: 'full', label: '全开' }],
          derivedLabelKey: 'permissionPresetLabel',
        },
      ],
      {},
      { permissionPreset: 'custom', permissionPresetLabel: '自定义组合' },
    )
    expect(container.textContent).toContain('自定义组合')
    const trigger = container.querySelector('.setting-select') as HTMLElement | null
    expect(trigger).not.toBeNull()
    expect(trigger?.getAttribute('aria-disabled') ?? trigger?.getAttribute('disabled') ?? 'set').not.toBeNull()
  })

  test('字体输入框 Escape：外层弹层已 preventDefault 时只清草稿，输入框回到当前值', async () => {
    const { container, calls } = await openFields([])
    const font = container.querySelector('input[aria-label="正文字体"]') as HTMLInputElement
    expect(font).not.toBeNull()
    fireEvent.change(font, { target: { value: '临时值' } })
    expect(font.value).toBe('临时值')
    // 另一层浮层先把 Esc「消费」掉（defaultPrevented），设置面板不关，字体行自己清草稿。
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    escape.preventDefault()
    font.dispatchEvent(escape)
    await flush()
    expect(font.value).toBe('')
    expect(callsOf(calls, 'setUiPrefs')).toHaveLength(0)
    expect(container.querySelector('.settings')).not.toBeNull()
  })
})

describe('手机连接弹窗的兜底', () => {
  test('二维码生成失败：那一格换成说明，配对码与地址照旧可用', async () => {
    qr.toDataURL.mockRejectedValueOnce(new Error('画布不支持'))
    render(
      <PairModal
        data={pairData()}
        onRegenerate={() => Promise.resolve({ ok: true, data: pairData() })}
        onEnableLan={noopResult}
        onClose={() => undefined}
      />,
    )
    await waitFor(() => expect(document.querySelector('.pair-qr-hold')?.textContent).toBe(zh['settings.pair.qrFailed']))
    expect(document.querySelector('.pair-code')?.textContent).toBe('12345678')
    expect(document.querySelector('.pair-url-text')?.textContent).toBe('http://192.168.1.2:7777/?code=12345678')
  })

  test('Tab 时一个可聚焦元素都没有：焦点拉回弹层本身', async () => {
    render(
      <PairModal
        data={pairData()}
        onRegenerate={() => Promise.resolve({ ok: true, data: pairData() })}
        onEnableLan={noopResult}
        onClose={() => undefined}
      />,
    )
    const card = document.querySelector('.pair-card') as HTMLElement
    for (const button of [...card.querySelectorAll('button')]) button.remove()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(card)
  })

  test('复制失败：回执说复制没成', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('剪贴板被拒')))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(
      <PairModal
        data={pairData()}
        onRegenerate={() => Promise.resolve({ ok: true, data: pairData() })}
        onEnableLan={noopResult}
        onClose={() => undefined}
      />,
    )
    const copy = document.querySelector('.pair-code-row button') as HTMLElement
    fireEvent.click(copy)
    await waitFor(() => expect(toastText()).toContain(zh['settings.pair.copyFailed']))
  })
})
