/**
 * 模型 / 档位浮层的交互补测（`ui-composer/ui/model-controls.tsx`）。
 *
 * `composer-extra` 已经钉住「chip 读数 → 根页 → 模型二级 → 点模型回传」这条主链路；
 * 这一份补它没碰到的边角：
 *
 * - 根页 `↑↓` 搬焦点（首尾回环）与 Esc 收起三张浮层；
 * - 焦点离开锚点才收、锚点内部搬焦点不收；
 * - 悬浮端点后滚动一级列表 → 飞出卡按新行位重量；指针离开面板 → 收起飞出卡；
 * - 根页 / 模型面板 / 档位面板三张遮罩各收一张；
 * - `setModel` 失败 → 原因写进输入框下方那一行；
 * - 两处 `ResizeObserver`（底栏量宽、面板重量）的回调真的跑得住。
 *
 * @module dsc-ui-composer/ui/w13-model-controls.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** ComposerBox 不直接导出：照壳装载插件那条路收下 `shell.composer` 的登记。 */
function composerBox(): ComponentType {
  const registered: Array<{ slot: string; id: string; component: unknown }> = []
  const fakeUi = {
    slots: {
      register: (slot: string, options: { id?: string }, component: unknown): void => {
        registered.push({ slot, id: options.id ?? '', component })
      },
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
      seat: (): undefined => undefined,
    },
    provide: (): void => undefined,
    consume(): undefined {
      return undefined
    },
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  const found = registered.find((item) => item.slot === 'shell.composer' && item.id === 'composer.box')
  if (found === undefined) throw new Error('composer 插件没有把输入区登记进 shell.composer')
  return found.component as ComponentType
}

const ComposerBox = composerBox()

/** 模型清单的一行（字段与宿主 `ModelChoiceView` 同形）。 */
function choice(
  provider: string,
  displayName: string,
  model: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    value: `${provider}/${model}`,
    provider,
    providerDisplayName: displayName,
    model,
    description: `${displayName} · ${model}`,
    contextWindow: 128_000,
    thinkingLevels: ['off', 'low', 'high', 'max'],
    modalities: ['text', 'image'],
    ...overrides,
  }
}

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
}

let sessionSeq = 0

function harnessOf(
  options: { models?: unknown[]; setModelError?: Error; model?: string; provider?: string; effort?: string } = {},
): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  sessionSeq += 1
  const snapshot = {
    sessions: [],
    queued: [],
    notices: [],
    status: {
      cwd: 'C:/repo',
      sessionPath: `C:/repo/session-${String(sessionSeq)}.jsonl`,
      turnState: 'idle',
      inboxCount: 0,
      model: options.model ?? 'm1',
      provider: options.provider ?? 'p1',
      effort: options.effort ?? 'low',
    },
    surfaces: {
      permissionPresets: { options: [], current: 'custom' },
      git: { repo: false, branch: '', detached: false, dirtyFileCount: 0 },
    },
  } as unknown as HostSnapshot

  const channel: HostChannel = {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      if (method === 'listModels') return Promise.resolve((options.models ?? []) as unknown as T)
      if (method === 'listUiCommands') return Promise.resolve([] as unknown as T)
      if (method === 'setModel' && options.setModelError !== undefined) {
        return Promise.reject(options.setModelError) as Promise<T>
      }
      return Promise.resolve({ ok: true } as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <ComposerBox />
    </RuntimeProvider>,
  )

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

/** 等 chip 读出模型再开根页。 */
async function openSheet(container: HTMLElement, expected = 'p1/m1'): Promise<HTMLElement> {
  await waitFor(() => {
    expect(container.querySelector('.composer-model-chip')?.getAttribute('data-composer-model')).toBe(expected)
  })
  fireEvent.click(container.querySelector('.composer-model-chip') as HTMLButtonElement)
  const sheet = container.querySelector('.model-sheet') as HTMLElement
  expect(sheet).not.toBeNull()
  return sheet
}

beforeEach(() => {
  localStorage.clear()
  // jsdom 的 Element 没有 scrollIntoView：模型菜单展开时会把当前项滚进视野。
  Element.prototype.scrollIntoView = () => undefined
  if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
    vi.stubGlobal('CSS', { escape: (value: string) => value })
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

describe('根页的键盘与 Esc', () => {
  test('↑↓ 在两行之间搬焦点并首尾回环；Esc 收掉整张浮层', async () => {
    const { container } = mount(harnessOf({ models: [choice('p1', '端点一', 'm1')] }))
    const sheet = await openSheet(container)
    const rows = [...sheet.querySelectorAll('[data-sheet-row]')] as HTMLElement[]
    expect(rows).toHaveLength(2)
    // 打开时焦点已经落在第一行（方向键才有起点）
    expect(document.activeElement).toBe(rows[0])

    fireEvent.keyDown(sheet, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[1])
    // 末尾再按下：绕回第一行
    fireEvent.keyDown(sheet, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(sheet, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rows[1])
    // 别的键不搬
    fireEvent.keyDown(sheet, { key: 'Tab' })
    expect(document.activeElement).toBe(rows[1])

    const prevented = fireEvent.keyDown(window, { key: 'Escape' })
    expect(prevented).toBe(false)
    expect(container.querySelector('.model-sheet')).toBeNull()
  })
})

describe('锚点焦点与遮罩', () => {
  test('焦点还在锚点里不收；真正离开锚点才收', async () => {
    const { container } = mount(harnessOf({ models: [choice('p1', '端点一', 'm1')] }))
    await openSheet(container)
    const row = container.querySelector('.model-sheet [data-sheet-row]') as HTMLElement
    const rows = [...container.querySelectorAll('.model-sheet [data-sheet-row]')] as HTMLElement[]
    const outside = container.querySelector('.send-btn') as HTMLElement

    // 锚点内部搬焦点（行 → 行）：不收
    fireEvent.focusOut(row, { relatedTarget: rows[1] })
    await flush()
    expect(container.querySelector('.model-sheet')).not.toBeNull()
    // 焦点去面板外面：收
    fireEvent.focusOut(row, { relatedTarget: outside })
    await flush()
    expect(container.querySelector('.model-sheet')).toBeNull()
  })

  test('根页 / 模型面板 / 档位面板三张遮罩各收掉自己那张', async () => {
    const { container } = mount(harnessOf({ models: [choice('p1', '端点一', 'm1')] }))

    // 根页
    let sheet = await openSheet(container)
    fireEvent.click(container.querySelector('.model-anchor .pop-mask') as HTMLElement)
    expect(container.querySelector('.model-sheet')).toBeNull()

    // 模型面板
    sheet = await openSheet(container)
    fireEvent.click([...sheet.querySelectorAll('[data-sheet-row]')][0] as HTMLElement)
    await flush()
    const picker = container.querySelector('.model-picker') as HTMLElement
    expect(picker).not.toBeNull()
    fireEvent.click(container.querySelector('.model-anchor .pop-mask') as HTMLElement)
    expect(container.querySelector('.model-picker')).toBeNull()

    // 档位面板
    sheet = await openSheet(container)
    fireEvent.click([...sheet.querySelectorAll('[data-sheet-row]')][1] as HTMLElement)
    await flush()
    expect(container.querySelector('[data-effort-track]')).not.toBeNull()
    const masks = [...container.querySelectorAll('.pop-mask')]
    fireEvent.click(masks.at(-1) as HTMLElement)
    expect(container.querySelector('[data-effort-track]')).toBeNull()
  })
})

describe('模型二级：悬浮、滚动与离开', () => {
  test('悬浮出飞出卡；滚动一级列表后卡片按新行位重量；指针离开面板收起', async () => {
    const { container } = mount(
      harnessOf({
        models: [choice('p1', '端点一', 'm1'), choice('p2', '端点二', 'm2')],
      }),
    )
    const sheet = await openSheet(container)
    fireEvent.click(sheet.querySelector('[data-sheet-row]') as HTMLElement)
    await flush()
    const picker = container.querySelector('.model-picker') as HTMLElement
    const providers = [...picker.querySelectorAll('.provider-row')] as HTMLElement[]
    expect(providers).toHaveLength(2)

    fireEvent.mouseEnter(providers[1] as HTMLElement)
    await flush()
    let flyout = container.querySelector('.model-flyout') as HTMLElement
    expect(flyout).not.toBeNull()
    expect(flyout.textContent).toContain('m2')
    const before = flyout.style.getPropertyValue('--flyout-top')

    // 滚一下一级列表：飞出卡按新行位重算（重算后仍在）
    const list = picker.querySelector('.model-providers') as HTMLElement
    fireEvent.scroll(list)
    await flush()
    flyout = container.querySelector('.model-flyout') as HTMLElement
    expect(flyout).not.toBeNull()
    expect(flyout.style.getPropertyValue('--flyout-top')).toBe(before)

    // 指针离开整张面板：飞出卡收起（回到只有一级那一列）
    fireEvent.mouseLeave(picker)
    await flush()
    expect(container.querySelector('.model-flyout')).toBeNull()
  })

  test('点模型行：setModel 成功即收面板；失败把原因写进输入框下方', async () => {
    const okHarness = harnessOf({ models: [choice('p1', '端点一', 'm1'), choice('p2', '端点二', 'm2')] })
    const ok = mount(okHarness)
    const okSheet = await openSheet(ok.container)
    fireEvent.click(okSheet.querySelector('[data-sheet-row]') as HTMLElement)
    await flush()
    const okPicker = ok.container.querySelector('.model-picker') as HTMLElement
    fireEvent.mouseEnter([...okPicker.querySelectorAll('.provider-row')][1] as HTMLElement)
    await flush()
    const okFlyout = ok.container.querySelector('.model-flyout') as HTMLElement
    fireEvent.click(within(okFlyout).getByText('m2').closest('button') as HTMLButtonElement)
    await flush()
    expect(ok.container.querySelector('.model-flyout')).toBeNull()
    expect(okHarness.calls).toContainEqual({ method: 'setModel', args: ['p2/m2'] })

    cleanup()
    const bad = mount(
      harnessOf({
        models: [choice('p1', '端点一', 'm1'), choice('p2', '端点二', 'm2')],
        setModelError: new Error('宿主拒绝换模型'),
      }),
    )
    const badSheet = await openSheet(bad.container)
    fireEvent.click(badSheet.querySelector('[data-sheet-row]') as HTMLElement)
    await flush()
    const badPicker = bad.container.querySelector('.model-picker') as HTMLElement
    fireEvent.mouseEnter([...badPicker.querySelectorAll('.provider-row')][1] as HTMLElement)
    await flush()
    const badFlyout = bad.container.querySelector('.model-flyout') as HTMLElement
    fireEvent.click(within(badFlyout).getByText('m2').closest('button') as HTMLButtonElement)
    await flush()
    expect(bad.container.querySelector('.shell-composer-fault')?.textContent).toContain('宿主拒绝换模型')
  })
})

describe('两处 ResizeObserver', () => {
  test('底栏量宽与面板重量都挂了观察者，回调跑一次不抛', async () => {
    const observers: Array<{ nodes: Element[]; fire: () => void; disconnected: boolean }> = []
    class Observer {
      private readonly nodes: Element[] = []
      private disconnected = false
      constructor(private readonly callback: () => void) {}
      observe(node: Element): void {
        this.nodes.push(node)
        observers.push({
          nodes: this.nodes,
          fire: this.callback,
          get disconnected(): boolean {
            return false
          },
        } as unknown as { nodes: Element[]; fire: () => void; disconnected: boolean })
      }
      unobserve(): void {}
      disconnect(): void {
        this.disconnected = true
      }
    }
    vi.stubGlobal('ResizeObserver', Observer)

    const { container } = mount(harnessOf({ models: [choice('p1', '端点一', 'm1')] }))
    const sheet = await openSheet(container)
    // 底栏那处观察在挂载时就挂了（量端点前缀放不放得下）
    expect(observers.length).toBeGreaterThanOrEqual(1)
    // 再开模型二级：面板自身宽高变了要重量，第二处观察者这时才挂上
    fireEvent.click(sheet.querySelector('[data-sheet-row]') as HTMLElement)
    await flush()
    expect(observers.length).toBeGreaterThanOrEqual(2)
    for (const observer of observers) {
      expect(observer.nodes.length).toBeGreaterThanOrEqual(1)
      act(() => {
        observer.fire()
      })
    }
    expect(container.querySelector('.model-picker')).not.toBeNull()



  })
})

