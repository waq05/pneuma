/**
 * 旁问页签的补测（ui 层，真渲染）：空态与模型清单、发送与通道实参、引用 chip、
 * 流式增量、停止 / 失败 / 已停止三种收尾、删气泡，以及 store 的纯函数面。
 *
 * 挂载方式沿用 `selection-slot.spec.tsx`：照生产壳装载插件那条路拿 `dockTabMeta('ask')`
 * 的组件；`RuntimeProvider` 给假通道（含 `onAsk` 的增量口），会话 id 每个用例唯一，
 * 避免模块级桶串场。
 *
 * @module dsc-ui-ask/ui/ask-extra.spec
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type AskChunk, type HostChannel } from '@dsc/ui-runtime'
import { dockTabMeta } from '@dsc/ui-dockkit'
import { humanErrorText } from '@dsc/ui-primitives'
import type { HostSnapshot, UiPluginApi } from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import plugin from './ui.js'
import {
  addBubble,
  appendAnswer,
  askSnapshot,
  patchBubble,
  pendingVersion,
  removeBubble,
  requestAskOpen,
  subscribeAsk,
  takePendingQuote,
  updateAsk,
} from './store.js'

/** 照生产壳装载插件：收下它报名的页签。 */
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
const AskTab = dockTabMeta('ask')?.component as ComponentType<{
  tab: { id: string; kind: string }
  active: boolean
  expanded: boolean
}>

interface Invoke {
  method: string
  args: unknown[]
}

interface Harness {
  channel: HostChannel
  calls: Invoke[]
  ask: (chunk: AskChunk) => void
  resolveSideAsk: (value: unknown) => void
}

let sessionSeq = 0

/** 假宿主：会话 id 每例唯一；`sideAsk` 默认立即回包，需要挂住时用 `pending`。 */
function harnessOf(options: { pendingAsk?: boolean } = {}): Harness {
  const calls: Invoke[] = []
  const listeners: Array<(chunk: AskChunk) => void> = []
  let resolveSideAsk: ((value: unknown) => void) | null = null
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
    onAsk: (listener) => {
      listeners.push(listener)
      return () => {
        const at = listeners.indexOf(listener)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      if (method === 'listModels') {
        return Promise.resolve([
          { value: 'prov:m1', provider: 'prov', providerDisplayName: '厂商甲', model: '模型一' },
        ]) as Promise<T>
      }
      if (method === 'sideAsk') {
        if (options.pendingAsk === true) {
          return new Promise<T>((resolve) => {
            resolveSideAsk = resolve as (value: unknown) => void
          })
        }
        return Promise.resolve({ text: '完整答案', model: 'm1', ms: 1_200, stopped: false }) as Promise<T>
      }
      return Promise.resolve({ ok: true }) as Promise<T>
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return {
    channel,
    calls,
    ask: (chunk) => {
      for (const listener of listeners) listener(chunk)
    },
    resolveSideAsk: (value) => {
      resolveSideAsk?.(value)
    },
  }
}

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <AskTab tab={{ id: 'ask-tab', kind: 'ask' }} active expanded />
    </RuntimeProvider>,
  )

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''

beforeAll(() => {
  // jsdom 没有布局：Select 把高亮项滚进可视区时要用它。
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  })
})

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  takePendingQuote()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  localStorage.clear()
  takePendingQuote()
})

describe('空态、模型清单与发送', () => {
  test('空态文案与问题输入的发送钮；模型清单挂载时取一次，下拉里有「跟随主会话」与清单项', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    expect(textOf(container.querySelector('.ask-empty-title'))).toBe(zh['ask.empty.title'])
    expect(textOf(container.querySelector('.ask-empty-desc'))).toBe(zh['ask.empty.desc'])
    expect((container.querySelector('.ask-send') as HTMLButtonElement).disabled).toBe(true)
    expect(harness.calls.filter((call) => call.method === 'listModels')).toHaveLength(1)

    fireEvent.click(container.querySelector('.ask-model .select-trigger') as HTMLElement)
    const labels = [...document.querySelectorAll('.select-opt')].map((option) => option.textContent ?? '')
    expect(labels[0]).toContain(zh['ask.model.follow'])
    expect(labels.some((label) => label.includes('厂商甲 · 模型一'))).toBe(true)
  })

  test('发送：先落一条 running 气泡，通道实参是 [问题, 引用, 票据, provider, model]；答案回来覆盖正文', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const input = container.querySelector('.ask-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '  这是什么  ' } })
    expect((container.querySelector('.ask-send') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(container.querySelector('.ask-send') as HTMLElement)
    await flush()

    const bubble = container.querySelector('.ask-bubble') as HTMLElement
    expect(bubble.dataset['status']).toBe('done')
    expect(textOf(bubble.querySelector('.ask-q'))).toBe('这是什么')
    expect(textOf(bubble.querySelector('.ask-a'))).toContain('完整答案')
    expect(textOf(bubble.querySelector('.ask-meta'))).toContain('m1')
    expect(input.value).toBe('')

    const sent = harness.calls.find((call) => call.method === 'sideAsk')
    expect(sent?.args[0]).toBe('这是什么')
    expect(sent?.args[1]).toBe('')
    expect(typeof sent?.args[2]).toBe('string')
    expect(sent?.args[3]).toBe('')
    expect(sent?.args[4]).toBe('')
  })

  test('选中模型：写进 localStorage，发送时拆成 provider / model 两参', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelector('.ask-model .select-trigger') as HTMLElement)
    const option = [...document.querySelectorAll('.select-opt')].find((item) =>
      (item.textContent ?? '').includes('厂商甲 · 模型一'),
    ) as HTMLElement
    fireEvent.click(option)
    expect(localStorage.getItem('dsc.ask.model')).toBe('prov:m1')

    fireEvent.change(container.querySelector('.ask-input') as HTMLTextAreaElement, {
      target: { value: '问一句' },
    })
    fireEvent.keyDown(container.querySelector('.ask-input') as HTMLElement, { key: 'Enter' })
    await flush()
    const sent = harness.calls.find((call) => call.method === 'sideAsk')
    expect(sent?.args[3]).toBe('prov')
    expect(sent?.args[4]).toBe('模型一')
  })
})

describe('引用 chip 与流式增量', () => {
  test('打开请求带来的引用进 chip；点叉撤掉，chip 消失', async () => {
    requestAskOpen('引用原文')
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const chip = container.querySelector('.ask-quote-chip') as HTMLElement
    expect(chip).not.toBeNull()
    expect(textOf(chip.querySelector('.ask-quote-text'))).toBe('引用原文')
    fireEvent.click(chip.querySelector('.ask-quote-drop') as HTMLElement)
    expect(container.querySelector('.ask-quote-chip')).toBeNull()
  })

  test('流式增量按票据追加到气泡；空增量不画，最终回包补全正文', async () => {
    const harness = harnessOf({ pendingAsk: true })
    const { container } = mount(harness)
    await flush()
    fireEvent.change(container.querySelector('.ask-input') as HTMLTextAreaElement, {
      target: { value: '流式?' },
    })
    fireEvent.keyDown(container.querySelector('.ask-input') as HTMLElement, { key: 'Enter' })
    await flush()
    const id = harness.calls.find((call) => call.method === 'sideAsk')?.args[2]
    expect(typeof id).toBe('string')
    expect(container.querySelector('.ask-typing')).not.toBeNull()

    act(() => {
      harness.ask({ id: id as string, delta: '半' })
      harness.ask({ id: id as string, delta: '' })
      harness.ask({ id: id as string, delta: '截' })
    })
    expect(textOf(container.querySelector('.ask-a'))).toContain('半截')
    expect(container.querySelector('.ask-caret')).not.toBeNull()

    act(() => {
      harness.resolveSideAsk({ text: '完整答案', model: 'm1', ms: 900, stopped: false })
    })
    await flush()
    expect(textOf(container.querySelector('.ask-a'))).toContain('完整答案')
    expect(container.querySelector('.ask-caret')).toBeNull()
    const bubble = container.querySelector('.ask-bubble') as HTMLElement
    expect(bubble.dataset['status']).toBe('done')
  })
})

describe('停止 / 失败 / 已停止与删除', () => {
  test('运行中给停止钮，点了发 sideAskCancel 带票据', async () => {
    const harness = harnessOf({ pendingAsk: true })
    const { container } = mount(harness)
    await flush()
    fireEvent.change(container.querySelector('.ask-input') as HTMLTextAreaElement, {
      target: { value: '停一下' },
    })
    fireEvent.keyDown(container.querySelector('.ask-input') as HTMLElement, { key: 'Enter' })
    await flush()
    const id = harness.calls.find((call) => call.method === 'sideAsk')?.args[2] as string
    const stop = container.querySelector('.ask-stop') as HTMLElement
    expect(stop).not.toBeNull()
    fireEvent.click(stop)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'sideAskCancel', args: [id] })
    act(() => {
      harness.resolveSideAsk({ text: '', model: 'm1', ms: 10, stopped: true })
    })
    await flush()
  })

  test('宿主拒绝：气泡落 error 档并显示人话原因，停止钮与光标都不在', async () => {
    const harness = harnessOf()
    const failing: HostChannel = {
      ...harness.channel,
      invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
        harness.calls.push({ method, args })
        if (method === 'listModels') return Promise.resolve([]) as Promise<T>
        if (method === 'sideAsk') return Promise.reject(new Error('ECONNREFUSED')) as Promise<T>
        return Promise.resolve({ ok: true }) as Promise<T>
      }) as HostChannel['invoke'],
    }
    const { container } = render(
      <RuntimeProvider channel={failing}>
        <AskTab tab={{ id: 'ask-tab', kind: 'ask' }} active expanded />
      </RuntimeProvider>,
    )
    await flush()
    fireEvent.change(container.querySelector('.ask-input') as HTMLTextAreaElement, {
      target: { value: '会失败' },
    })
    fireEvent.keyDown(container.querySelector('.ask-input') as HTMLElement, { key: 'Enter' })
    await flush()
    const bubble = container.querySelector('.ask-bubble') as HTMLElement
    expect(bubble.dataset['status']).toBe('error')
    expect(textOf(bubble.querySelector('.ask-error'))).toBe(humanErrorText(new Error('ECONNREFUSED')).text)
    expect(bubble.querySelector('.ask-stop')).toBeNull()
    expect(bubble.querySelector('.ask-caret')).toBeNull()
  })

  test('回包 stopped：元信息写「已停止」，不画停止钮', async () => {
    const harness = harnessOf()
    const stoppedChannel: HostChannel = {
      ...harness.channel,
      invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
        harness.calls.push({ method, args })
        if (method === 'listModels') return Promise.resolve([]) as Promise<T>
        if (method === 'sideAsk') {
          return Promise.resolve({ text: '半截', model: 'm1', ms: 500, stopped: true }) as Promise<T>
        }
        return Promise.resolve({ ok: true }) as Promise<T>
      }) as HostChannel['invoke'],
    }
    const { container } = render(
      <RuntimeProvider channel={stoppedChannel}>
        <AskTab tab={{ id: 'ask-tab', kind: 'ask' }} active expanded />
      </RuntimeProvider>,
    )
    await flush()
    fireEvent.change(container.querySelector('.ask-input') as HTMLTextAreaElement, {
      target: { value: '被停了' },
    })
    fireEvent.click(container.querySelector('.ask-send') as HTMLElement)
    await flush()
    expect(textOf(container.querySelector('.ask-meta'))).toBe(zh['ask.meta.stopped'])
    expect(container.querySelector('.ask-stop')).toBeNull()
  })

  test('删除一条：气泡消失，空态回来', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    fireEvent.change(container.querySelector('.ask-input') as HTMLTextAreaElement, {
      target: { value: '待删除' },
    })
    fireEvent.click(container.querySelector('.ask-send') as HTMLElement)
    await flush()
    const remove = [...container.querySelectorAll('.ask-icon-btn')].find(
      (button) => button.getAttribute('aria-label') === zh['ask.remove.aria'],
    ) as HTMLElement
    fireEvent.click(remove)
    await flush()
    expect(container.querySelector('.ask-bubble')).toBeNull()
    expect(container.querySelector('.ask-empty')).not.toBeNull()
  })
})

describe('store 纯函数面', () => {
  test('订阅只在变更时通知；空增量不通知；打开请求带版本号与一次性引用', () => {
    const listener = vi.fn()
    const off = subscribeAsk(listener)
    const id = `store-${String(++sessionSeq)}`
    const before = pendingVersion()
    requestAskOpen('引')
    expect(pendingVersion()).toBe(before + 1)
    expect(takePendingQuote()).toBe('引')
    expect(takePendingQuote()).toBeNull()
    expect(listener).toHaveBeenCalled()

    addBubble(id, { id: 'b1', question: 'q', quote: '', answer: '', status: 'running' })
    expect(askSnapshot(id)).toHaveLength(1)
    patchBubble(id, 'b1', { answer: 'a' })
    expect(askSnapshot(id)[0]?.answer).toBe('a')
    appendAnswer(id, 'b1', '')
    expect(askSnapshot(id)[0]?.answer).toBe('a')
    appendAnswer(id, 'b1', 'b')
    expect(askSnapshot(id)[0]?.answer).toBe('ab')
    updateAsk(id, (list) => list.map((item) => ({ ...item, status: 'done' as const })))
    expect(askSnapshot(id)[0]?.status).toBe('done')
    removeBubble(id, 'b1')
    expect(askSnapshot(id)).toHaveLength(0)
    off()
  })
})
