/**
 * `ui-composer` 输入区主组件（`ui.tsx`）与模型菜单（`model-controls.tsx`）的补盲。
 *
 * 既有三份 spec 的分工见 `composer-more.spec.tsx` 文件头；这一份只补它们没碰到的分支：
 *
 *   - 不接受输入的会话（队友收工 / 一次性子智能体）整块换成只读说明；
 *   - 点输入框内边距把焦点还给正文区（手机误触回退）；
 *   - `@` 候选用 mousedown 采纳（抢在 textarea 失焦之前），不是 click；
 *   - 权限预设浮层的遮罩点击收起；
 *   - 顶栏模式胶囊的失败回执（宿主不受理 `usePreset` 时弹红色 toast，不静默）；
 *   - 模型两级菜单：一级行 Tab 聚焦与点击都能飞出二级（触摸屏没有悬浮）。
 *
 * @module dsc-ui-composer/ui/w14-composer-box.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

interface Registered {
  slot: string
  id: string
  component: unknown
}

/** 照壳装载插件那条路收下顶栏与输入区两个登记。 */
function capture(): Map<string, ComponentType> {
  const registered: Registered[] = []
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
  const slots = new Map<string, ComponentType>()
  for (const item of registered) {
    if (item.slot === 'shell.composer' || item.slot === 'shell.header.lead') {
      slots.set(item.id, item.component as ComponentType)
    }
  }
  return slots
}

const slots = capture()
const ComposerBox = slots.get('composer.box') as ComponentType
const PresetChip = slots.get('composer.preset') as ComponentType

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

interface HarnessOptions {
  acceptsInput?: boolean
  model?: string
  provider?: string
  models?: unknown[]
  permissionPresets?: Record<string, unknown>
  preset?: Record<string, unknown>
  /** `dock` 通道的回话（`@` 提及走它）。 */
  dock?: (op: string, args: unknown[]) => unknown
  /** `usePreset` 失败时给什么错误；缺省成功。 */
  presetError?: Error
}

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
}

function harnessOf(options: HarnessOptions = {}): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const snapshot = {
    sessions: [],
    queued: [],
    notices: [],
    status: {
      cwd: 'C:/repo',
      sessionPath: 'C:/repo/session.jsonl',
      turnState: 'idle',
      inboxCount: 0,
      model: options.model ?? '',
      provider: options.provider ?? '',
      effort: 'default',
      acceptsInput: options.acceptsInput,
    },
    surfaces: {
      permissionPresets: options.permissionPresets ?? { options: [], current: 'custom' },
      preset: options.preset ?? { options: [], current: '' },
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
      if (method === 'dock') {
        const handler = options.dock
        if (handler === undefined) return Promise.resolve({ entries: [] } as unknown as T)
        try {
          return Promise.resolve(handler(String(args[0]), args) as T)
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
      if (method === 'usePreset' && options.presetError !== undefined) return Promise.reject(options.presetError)
      return Promise.resolve({ ok: true } as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const textareaOf = (container: HTMLElement): HTMLTextAreaElement => container.querySelector('textarea') as HTMLTextAreaElement

function type(input: HTMLTextAreaElement, value: string, caret: number = value.length): void {
  fireEvent.change(input, { target: { value, selectionStart: caret, selectionEnd: caret } })
}

beforeEach(() => {
  if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
    vi.stubGlobal('CSS', { escape: (value: string) => value })
  }
  Element.prototype.scrollIntoView = () => undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    callback(0)
    return 0
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('不接受输入的会话', () => {
  test('整块换成只读说明：没有输入框、没有发送钮，抬头与正文都在', async () => {
    const harness = harnessOf({ acceptsInput: false })
    const { container } = render(
      <RuntimeProvider channel={harness.channel}>
        <ComposerBox />
      </RuntimeProvider>,
    )
    await flush()
    const note = container.querySelector('[data-composer-readonly]') as HTMLElement
    expect(note).not.toBeNull()
    expect(note.getAttribute('role')).toBe('note')
    expect(note.querySelector('.composer-readonly-title')?.textContent).toBe('这段记录只读')
    expect(note.querySelector('.composer-readonly-body')?.textContent).toContain('没有接话的人')
    expect(container.querySelector('textarea')).toBeNull()
    expect(harness.calls.some((call) => call.method === 'submit')).toBe(false)
  })
})

describe('输入框的点击焦点回退', () => {
  test('点框内空白处把焦点还给正文区；点按钮不抢焦点', async () => {
    const harness = harnessOf()
    const { container } = render(
      <RuntimeProvider channel={harness.channel}>
        <ComposerBox />
      </RuntimeProvider>,
    )
    await flush()
    const composer = container.querySelector('.composer') as HTMLElement
    const input = textareaOf(container)
    input.blur()
    fireEvent.click(composer)
    expect(document.activeElement).toBe(input)

    input.blur()
    fireEvent.click(container.querySelector('.model-btn') as HTMLButtonElement)
    expect(document.activeElement).not.toBe(input)
  })
})

describe('@ 候选用 mousedown 采纳', () => {
  test('点候选行把 @token 换成路径 + 空格，面板收起', async () => {
    const harness = harnessOf({
      dock: (op, args) => {
        if (op === 'fs-roots') return { cwd: 'C:/repo', roots: [{ path: 'C:/repo' }] }
        const options = args[1] as { dir?: string }
        if (options.dir === '.') return { entries: [{ name: 'a.ts', dir: false }] }
        return { entries: [] }
      },
    })
    const { container } = render(
      <RuntimeProvider channel={harness.channel}>
        <ComposerBox />
      </RuntimeProvider>,
    )
    await flush()
    const input = textareaOf(container)
    type(input, '@a', 2)
    await waitFor(() => {
      expect(container.querySelectorAll('.mention-item[role="option"]')).toHaveLength(1)
    })
    fireEvent.mouseDown(container.querySelector('.mention-item[role="option"]') as HTMLElement)
    await flush()
    expect(input.value).toBe('@a.ts ')
    expect(container.querySelector('.mention-pop')).toBeNull()
  })
})

describe('权限预设浮层的遮罩', () => {
  test('点遮罩收起菜单（不触发选择）', async () => {
    const harness = harnessOf({
      permissionPresets: {
        options: [
          { name: 'default', label: '标准', description: '默认档' },
          { name: 'readonly', label: '只读', description: '只读档' },
        ],
        current: 'default',
      },
    })
    const { container } = render(
      <RuntimeProvider channel={harness.channel}>
        <ComposerBox />
      </RuntimeProvider>,
    )
    await flush()
    const button = container.querySelector('.model-btn') as HTMLButtonElement
    fireEvent.click(button)
    await flush()
    const mask = container.querySelector('.pop-mask') as HTMLElement
    expect(mask).not.toBeNull()
    expect(container.querySelector('.policy-pop')).not.toBeNull()

    fireEvent.click(mask)
    await flush()
    expect(container.querySelector('.policy-pop')).toBeNull()
    expect(harness.calls.some((call) => call.method === 'usePreset')).toBe(false)
  })
})

describe('顶栏模式胶囊的失败回执', () => {
  test('宿主不受理 usePreset：红色 toast 里带原错，菜单已收起', async () => {
    const harness = harnessOf({
      preset: {
        current: 'build',
        defaultName: 'build',
        options: [
          { name: 'build', label: '执行', description: '干活' },
          { name: 'plan', label: '计划', description: '只规划' },
        ],
      },
      presetError: new Error('宿主不收这个模式'),
    })
    const { container } = render(
      <RuntimeProvider channel={harness.channel}>
        <PresetChip />
      </RuntimeProvider>,
    )
    await flush()
    fireEvent.click(container.querySelector('.preset-chip') as HTMLButtonElement)
    await flush()
    const items = Array.from(container.querySelectorAll('.preset-pop [role="menuitemradio"]')) as HTMLButtonElement[]
    const plan = items.find((item) => item.textContent?.includes('计划')) as HTMLButtonElement
    fireEvent.click(plan)
    await waitFor(() => {
      expect(document.querySelector('.dsc-toast__text')?.textContent).toContain('切换失败：宿主不收这个模式')
    })
    expect(harness.calls).toContainEqual({ method: 'usePreset', args: ['plan'] })
    expect(container.querySelector('.preset-pop')).toBeNull()
  })
})

describe('模型两级菜单的键盘与点击', () => {
  test('一级行 Tab 聚焦也飞出二级；点另一行切过去', async () => {
    const harness = harnessOf({
      model: 'm1',
      provider: 'p1',
      models: [choice('p1', '端点一', 'm1'), choice('p2', '端点二', 'm2')],
    })
    const { container } = render(
      <RuntimeProvider channel={harness.channel}>
        <ComposerBox />
      </RuntimeProvider>,
    )
    await waitFor(() => {
      expect(container.querySelector('.composer-model-chip')?.getAttribute('data-composer-model')).toBe('p1/m1')
    })
    fireEvent.click(container.querySelector('.composer-model-chip') as HTMLButtonElement)
    const rows = Array.from(container.querySelectorAll('.model-sheet [data-sheet-row]'))
    fireEvent.click(rows[0] as HTMLElement)
    await flush()
    const providers = Array.from(container.querySelectorAll('.provider-row')) as HTMLButtonElement[]
    expect(providers).toHaveLength(2)

    // jsdom 的 getComputedStyle 对 overflow-x 给的不是规范初始值：想走到「一路往上找裁剪盒」
    // 的整条循环，得把祖先的 overflow-x 都报成 visible（浏览器里的常态）。
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ overflowX: 'visible' }) as unknown as CSSStyleDeclaration)

    // Tab 到第一行（焦点事件）也要飞出二级：触摸屏与键盘都只有这一条路。
    fireEvent.focus(providers[0] as HTMLButtonElement)
    await flush()
    expect(container.querySelector('.model-flyout')).not.toBeNull()

    // 点第二行：飞出卡换成端点二的模型。
    fireEvent.click(providers[1] as HTMLButtonElement)
    await flush()
    expect(container.querySelector('.model-flyout')?.textContent).toContain('m2')

    const modelRow = within(container.querySelector('.model-flyout') as HTMLElement)
      .getByText('m2')
      .closest('button') as HTMLButtonElement
    fireEvent.click(modelRow)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'setModel', args: ['p2/m2'] })
    expect(container.querySelector('.model-picker')).toBeNull()
  })
})
