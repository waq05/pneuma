/**
 * `ui-ask` 的补盲：模型清单拉取失败、复制成功的回执。
 *
 * 缺口逐条：
 *   - `ui.tsx:436`：`listModels` 调用本身失败（不是回空清单）时的 catch——面板照常可用，
 *     不把「没模型可选」当成致命错误；
 *   - `ui.tsx:630`：`navigator.clipboard.writeText` 成功后的回执（失败那一支已有用例）。
 *
 * 契约里 `ui.tsx:418` 是 `useSyncExternalStore` 的第三个参数（服务端快照），jsdom 里
 * 不会调用它，属不可覆盖的一行，已在报告里单列。
 *
 * @module dsc-ui-ask/ui/w14-ask
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type AskChunk, type HostChannel } from '@dsc/ui-runtime'
import { dockTabMeta } from '@dsc/ui-dockkit'
import type { HostSnapshot, UiPluginApi } from '@dsc/ui'
import zh from '../locale/ui.zh.json'
import plugin from './ui.js'

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
  consume(): undefined {
    return undefined
  },
} as unknown as UiPluginApi
plugin.apply(fakeUi)
const AskTab = dockTabMeta('ask')?.component as ComponentType<{
  tab: { id: string; kind: string }
  active: boolean
  expanded: boolean
}>

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
}

let sessionSeq = 0

/** 假宿主：`listModels` 可配成 rejection。 */
function harnessOf(options: { modelsReject?: boolean } = {}): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  sessionSeq += 1
  const snapshot = {
    status: { sessionId: `w14-ask-${String(sessionSeq)}`, turnState: 'idle' },
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
      if (method === 'listModels' && options.modelsReject === true) {
        return Promise.reject(new Error('清单读不出来')) as Promise<T>
      }
      if (method === 'listModels') return Promise.resolve([] as unknown as T)
      if (method === 'sideAsk') {
        return Promise.resolve({ text: '完整答案', model: 'm1', ms: 1_200, stopped: false }) as unknown as Promise<T>
      }
      return Promise.resolve({ ok: true } as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const flush = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <AskTab tab={{ id: 'ask-tab', kind: 'ask' }} active expanded />
    </RuntimeProvider>,
  )

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
  document.body.innerHTML = ''
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

describe('模型清单拉取失败', () => {
  test('listModels reject：页签照常可用，输入框与发送钮都在', async () => {
    const harness = harnessOf({ modelsReject: true })
    const { container } = mount(harness)
    await flush()
    expect(harness.calls.some((call) => call.method === 'listModels')).toBe(true)
    expect(container.querySelector('.ask-input')).not.toBeNull()
    expect(container.querySelector('.ask-send')).not.toBeNull()
  })
})

describe('复制成功的回执', () => {
  test('writeText 成功：回执写「答案已复制」', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text)
          return Promise.resolve()
        },
      },
    })
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()

    const input = container.querySelector('.ask-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '帮我解释这段' } })
    fireEvent.click(container.querySelector('.ask-send') as HTMLButtonElement)
    await flush()

    const copy = container.querySelector(`button[aria-label="${zh['ask.copy.aria']}"]`) as HTMLButtonElement
    expect(copy).not.toBeNull()
    fireEvent.click(copy)
    await flush()
    expect(written).toEqual(['完整答案'])
    expect(document.querySelector('.dsc-toasts')?.textContent).toContain(zh['ask.copy.ok'])
  })
})
