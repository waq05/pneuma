/**
 * 输入区（`ui-composer/ui/ui.tsx` 的 ComposerBox）的交互段（ui 层，真渲染）。
 *
 * 只钉输入框与发送/打断这条主干：打字开按钮、回车与按钮各发什么、审批挂起时禁发、
 * 跑着一轮时变成「停止」、发送失败把原因写在输入框下面。模型选择/附件/命令面板
 * 各自已有纯逻辑与组件 spec，这里不重复铺。
 *
 * @module dsc-ui-composer/ui/composer.spec
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** ComposerBox 不直接导出：照壳装载插件那条路，收下 `shell.composer` 的登记。 */
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

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
}

function harnessOf(options: { turnState?: string; pendingApproval?: unknown; submitError?: Error } = {}): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const snapshot = {
    sessions: [],
    status: {
      cwd: 'C:/repo',
      sessionPath: 'C:/repo/a.jsonl',
      turnState: options.turnState ?? 'idle',
      inboxCount: 0,
    },
    surfaces: {
      permissionPresets: { options: [], current: 'custom' },
      ...(options.pendingApproval === undefined ? {} : { pendingApproval: options.pendingApproval }),
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
      if (method === 'submit' && options.submitError !== undefined) return Promise.reject(options.submitError)
      // 模型与命令是列表类：给空数组，别让消费方按对象去读长度。
      if (method === 'listModels' || method === 'listSlashCommands') return Promise.resolve([] as unknown as T)
      if (method === 'steerQueued') return Promise.resolve(true as unknown as T)
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

const textareaOf = (container: HTMLElement): HTMLTextAreaElement =>
  container.querySelector('textarea') as HTMLTextAreaElement
const sendOf = (container: HTMLElement): HTMLButtonElement =>
  container.querySelector('.send-btn:not(.stop)') as HTMLButtonElement

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
})

describe('输入与发送', () => {
  test('空输入禁发；打上字后可点发送，回传正文并清空', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    expect(sendOf(container).disabled).toBe(true)

    fireEvent.change(textareaOf(container), { target: { value: '你好' } })
    expect(sendOf(container).disabled).toBe(false)
    fireEvent.click(sendOf(container))
    await flush()
    expect(harness.calls).toContainEqual({ method: 'submit', args: ['你好'] })
    expect(textareaOf(container).value).toBe('')
  })

  test('回车发送；Shift+Enter 只换行不发', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const input = textareaOf(container)
    fireEvent.change(input, { target: { value: '第一句' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    await flush()
    expect(harness.calls.some((call) => call.method === 'submit')).toBe(false)

    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(harness.calls).toContainEqual({ method: 'submit', args: ['第一句'] })
  })

  test('以 / 开头走受限命令派发，不发消息', async () => {
    const harness = harnessOf()
    const { container } = mount(harness)
    await flush()
    const input = textareaOf(container)
    fireEvent.change(input, { target: { value: '/status' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(harness.calls).toContainEqual({ method: 'runUiCommand', args: ['/status'] })
    expect(harness.calls.some((call) => call.method === 'submit')).toBe(false)
  })

  test('发送失败：原因写在输入框下方，正文保留', async () => {
    const harness = harnessOf({ submitError: new Error('宿主断线了') })
    const { container } = mount(harness)
    await flush()
    const input = textareaOf(container)
    fireEvent.change(input, { target: { value: '会失败' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(container.querySelector('.shell-composer-fault')?.textContent).toContain('宿主断线了')
    expect(textareaOf(container).value).toBe('会失败')
  })
})

describe('审批与运行中', () => {
  test('审批挂起：输入框与发送都锁住', async () => {
    const harness = harnessOf({ pendingApproval: { id: 'a1' } })
    const { container } = mount(harness)
    await flush()
    expect(textareaOf(container).disabled).toBe(true)
    expect(sendOf(container).disabled).toBe(true)
  })

  test('跑着一轮：出现停止钮，点了发 interrupt', async () => {
    const harness = harnessOf({ turnState: 'streaming' })
    const { container } = mount(harness)
    await flush()
    // 排队模式下发送钮仍在（变成「排队发」），停止钮是这一轮的主按钮。
    const stop = container.querySelector('.send-btn.stop') as HTMLButtonElement
    expect(stop).not.toBeNull()
    fireEvent.click(stop)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'interrupt', args: [] })
  })
})
