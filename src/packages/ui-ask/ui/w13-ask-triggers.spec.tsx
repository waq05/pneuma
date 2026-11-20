/**
 * 旁问页（`ui-ask/ui/ui.tsx`）的入口与浮层补测（ui 层，真渲染）。
 *
 * 已有两份的分工：`ask-extra` 钉住页签本体（发送 / 流式 / 停止 / 删除），
 * `selection-slot` 钉住槽登记与浮层的渲染契约。这一份只补它们没走到的：
 *
 * - 触发器的动作表（`ask.open` / `ask.selection` 两条）与 `Ctrl+Shift+K` 快捷键；
 * - `currentSelection` 的三条回落（没有选区 / 宿主不在 `.chat` 里 / 选区文本不可用）；
 * - 选区浮层的滚动关闭、窗口改大小重夹、`ResizeObserver` 重量；
 * - 气泡复制失败时的回执文案。
 *
 * @module dsc-ui-ask/ui/w13-ask-triggers.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RuntimeProvider, type AskChunk, type HostChannel } from '@dsc/ui-runtime'
import { ServiceRegistry, ServicesProvider } from '@dsc/ui-core'
import { dockTabMeta } from '@dsc/ui-dockkit'
import { ACTIONS_SERVICE, type ActionsHandle, type HostSnapshot, type UiAction, type UiPluginApi } from '@dsc/ui'
import type { ComponentType } from 'react'
import zh from '../locale/ui.zh.json'
import plugin from './ui.js'
import { pendingVersion, takePendingQuote } from './store.js'

/** 照生产壳装载插件：收下 shell.header 那条登记的触发器组件。 */
function triggerComponent(): ComponentType<{ renderSlot?: unknown }> {
  const collected: Array<{ slot: string; component: unknown }> = []
  const fakeUi = {
    slots: {
      register: (slot: string, _options: unknown, component: unknown): void => {
        collected.push({ slot, component })
      },
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
    },
    provide: (): void => undefined,
    consume: (): undefined => undefined,
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  const found = collected.find((item) => item.slot === 'shell.header')
  if (found === undefined) throw new Error('ask 插件没有把触发器登记进 shell.header')
  return found.component as ComponentType<{ renderSlot?: unknown }>
}

const Triggers = triggerComponent()
const AskTab = dockTabMeta('ask')?.component as ComponentType<{
  tab: { id: string; kind: string }
  active: boolean
  expanded: boolean
}>

interface Invoke {
  method: string
  args: unknown[]
}

let sessionSeq = 0

/** 假宿主：会话 id 每例唯一（模块级 store 按会话分桶）；`sideAsk` 立即回包。 */
function harnessOf(): { channel: HostChannel; calls: Invoke[] } {
  const calls: Invoke[] = []
  sessionSeq += 1
  const snapshot = {
    status: { sessionId: `sess-${String(sessionSeq)}`, turnState: 'idle' },
  } as unknown as HostSnapshot
  const channel: HostChannel = {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: (_listener: (chunk: AskChunk) => void) => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      if (method === 'listModels') {
        return Promise.resolve([{ value: 'prov:m1', provider: 'prov', providerDisplayName: '厂商甲', model: '模型一' }]) as Promise<T>
      }
      if (method === 'sideAsk') {
        return Promise.resolve({ text: '**完整答案**', model: 'm1', ms: 1_200, stopped: false }) as Promise<T>
      }
      return Promise.resolve({ ok: true }) as Promise<T>
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })

/** 造一段 jsdom 里不存在的选区：文本落在给定宿主里，框在视口中部。 */
function stubSelection(host: Element | null, text = '这是一段足够长的选区'): void {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    // currentSelection 读 anchorNode 判宿主，选区对象上必须给这一项（真浏览器里是文本节点）
    anchorNode: host,
    getRangeAt: () => ({
      commonAncestorContainer: host,
      getBoundingClientRect: () => ({ left: 100, top: 100, right: 300, bottom: 130 }),
    }),
    toString: () => text,
  } as unknown as Selection)
}

const clearSelection = (): void => {
  vi.spyOn(window, 'getSelection').mockReturnValue(null as unknown as Selection)
}

/** 收下 ActionsHandle 登记的假实现。 */
function actionsHarness(): { handle: ActionsHandle; registered: Array<{ owner: string; list: readonly UiAction[] }> } {
  const registered: Array<{ owner: string; list: readonly UiAction[] }> = []
  const handle = {
    register: (owner: string, list: readonly UiAction[]): (() => void) => {
      registered.push({ owner, list })
      return () => undefined
    },
  } as unknown as ActionsHandle
  return { handle, registered }
}

const triggerAction = (list: readonly UiAction[], id: string): UiAction | undefined =>
  list.find((item) => item.id === id)

beforeEach(() => {
  takePendingQuote()
  document.body.innerHTML = ''
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  takePendingQuote()
})

describe('触发器的动作表与快捷键', () => {
  test('动作表登记 ask.open / ask.selection 两条，按下去都能开旁问并带上选区原文', async () => {
    const { channel } = harnessOf()
    const { handle, registered } = actionsHarness()
    const registry = new ServiceRegistry()
    registry.provide(ACTIONS_SERVICE, handle, 'test')
    const { container } = render(
      <ServicesProvider services={registry}>
        <RuntimeProvider channel={channel}>
          <div className="chat">
            <Triggers />
          </div>
        </RuntimeProvider>
      </ServicesProvider>,
    )
    await flush()

    expect(registered.map((item) => item.owner)).toEqual(['ask'])
    const list = registered[0]?.list ?? []
    expect(list.map((item) => item.id)).toEqual(['ask.open', 'ask.selection'])

    const before = pendingVersion()
    triggerAction(list, 'ask.open')?.run()
    expect(pendingVersion()).toBe(before + 1)

    // 没有选区：selection 这条也照常开旁问，不带引用
    clearSelection()
    triggerAction(list, 'ask.selection')?.run()
    expect(pendingVersion()).toBe(before + 2)
    expect(takePendingQuote()).toBeNull()

    // 有选区：原文交给页签（读走即清）
    stubSelection(container.querySelector('.chat'))
    triggerAction(list, 'ask.selection')?.run()
    expect(takePendingQuote()).toBe('这是一段足够长的选区')
  })

  test('Ctrl+Shift+K 开旁问并拦下浏览器默认行为；别的组合键不动作', async () => {
    const { channel } = harnessOf()
    const { handle } = actionsHarness()
    const registry = new ServiceRegistry()
    registry.provide(ACTIONS_SERVICE, handle, 'test')
    const { container } = render(
      <ServicesProvider services={registry}>
        <RuntimeProvider channel={channel}>
          <div className="chat">
            <Triggers />
          </div>
        </RuntimeProvider>
      </ServicesProvider>,
    )
    await flush()

    const before = pendingVersion()
    // Ctrl+K 不是它：不拦、不开
    const plain = fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(plain).toBe(true)
    expect(pendingVersion()).toBe(before)

    stubSelection(container.querySelector('.chat'))
    const handled = fireEvent.keyDown(window, { key: 'K', ctrlKey: true, shiftKey: true })
    expect(handled).toBe(false)
    expect(pendingVersion()).toBe(before + 1)
    expect(takePendingQuote()).toBe('这是一段足够长的选区')
  })
})

describe('选区浮层的三条关闭/重算路径', () => {
  /** 渲染触发器并模拟一次「在正文里选完松开鼠标」。 */
  function pick(container: HTMLElement): HTMLElement | null {
    stubSelection(container.querySelector('.chat'))
    fireEvent.mouseUp(document)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    return document.body.querySelector('.ask-sel-actions')
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('滚动关掉浮层；窗口改大小只重夹位置（浮层还在）', async () => {
    const { channel } = harnessOf()
    const { container } = render(
      <RuntimeProvider channel={channel}>
        <div className="chat">
          <Triggers renderSlot={undefined} />
        </div>
      </RuntimeProvider>,
    )
    await flush()

    expect(pick(container)).not.toBeNull()
    fireEvent.scroll(window)
    expect(document.body.querySelector('.ask-sel-actions')).toBeNull()

    // 换窄视口：位置按新视口重夹，浮层不消失
    const bubble = pick(container)
    expect(bubble).not.toBeNull()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 200 })
    fireEvent.resize(window)
    const moved = document.body.querySelector('.ask-sel-actions') as HTMLElement
    expect(moved).not.toBeNull()
    expect(Number.parseFloat(moved.style.left)).toBeLessThanOrEqual(200 - 8)
  })

  test('选区读不到 / 宿主不在 .chat / 文本不可用：三种都收起浮层', async () => {
    const { channel } = harnessOf()
    const { container } = render(
      <RuntimeProvider channel={channel}>
        <div className="chat">
          <Triggers renderSlot={undefined} />
        </div>
      </RuntimeProvider>,
    )
    await flush()

    // 1) 选区整个没了
    expect(pick(container)).not.toBeNull()
    clearSelection()
    fireEvent.mouseUp(document)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(document.body.querySelector('.ask-sel-actions')).toBeNull()

    // 2) 选区宿主不在 .chat 里
    const outside = document.createElement('div')
    document.body.append(outside)
    stubSelection(outside)
    fireEvent.mouseUp(document)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(document.body.querySelector('.ask-sel-actions')).toBeNull()

    // 3) 文本是空白：normalizeSelection 判为不可用
    stubSelection(container.querySelector('.chat'), '   ')
    fireEvent.mouseUp(document)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(document.body.querySelector('.ask-sel-actions')).toBeNull()
  })

  test('ResizeObserver 观察浮层本体：回调里重量一次尺寸不抛', async () => {
    const observed: Element[] = []
    let fire: (() => void) | null = null
    class Observer {
      constructor(callback: () => void) {
        fire = callback
      }
      observe(node: Element): void {
        observed.push(node)
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', Observer)

    const { channel } = harnessOf()
    const { container } = render(
      <RuntimeProvider channel={channel}>
        <div className="chat">
          <Triggers renderSlot={undefined} />
        </div>
      </RuntimeProvider>,
    )
    await flush()

    expect(pick(container)).not.toBeNull()
    expect(observed.some((node) => node.classList.contains('ask-sel-actions'))).toBe(true)
    act(() => {
      fire?.()
    })
    expect(document.body.querySelector('.ask-sel-actions')).not.toBeNull()
  })
})

describe('气泡的复制回执', () => {
  test('复制失败：回执写「复制失败」，不是静默', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('剪贴板被拒')) },
    })
    const { channel } = harnessOf()
    const { container } = render(
      <RuntimeProvider channel={channel}>
        <AskTab tab={{ id: 'ask-tab', kind: 'ask' }} active expanded />
      </RuntimeProvider>,
    )
    await flush()

    const input = container.querySelector('.ask-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '帮我解释这段' } })
    fireEvent.click(container.querySelector('.ask-send') as HTMLButtonElement)
    await flush()

    const copy = container.querySelector(`button[aria-label="${zh['ask.copy.aria']}"]`) as HTMLButtonElement
    expect(copy).not.toBeNull()
    fireEvent.click(copy)
    await flush()
    expect(document.querySelector('.dsc-toasts')?.textContent).toContain(zh['ask.copy.failed'])
  })
})
