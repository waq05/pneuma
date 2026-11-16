/**
 * 会话目标条（`ui-tasks/ui/ui.tsx`）的渲染与动作回传段（ui 层，真渲染）。
 *
 * 组件不直接导出：照壳装载插件那条路 `apply`，收下 `shell.composer` 的登记。用假宿主
 * 快照的 `surfaces.goal` 点亮目标条，钉「没目标不画、状态文案与按钮随 phase 变、
 * 点按钮只发 goalAction、失败写成人话」。
 *
 * @module dsc-ui-tasks/ui/ui.spec
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { GoalView, HostSnapshot, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

interface Registration {
  slot: string
  options: { id?: string; order?: number }
  component: ComponentType
}

/** GoalBarSlot 不直接导出：收下 `shell.composer` 里 id = tasks.goal 的登记。 */
const registered: Registration[] = []
plugin.apply({
  slots: {
    register: (slot: string, options: { id?: string; order?: number }, component: ComponentType): void => {
      registered.push({ slot, options, component })
    },
    declare: (): void => undefined,
    registerFactory: (): void => undefined,
    seat: (): undefined => undefined,
  },
  provide: (): void => undefined,
  consume(): undefined {
    return undefined
  },
} as unknown as UiPluginApi)

const found = registered.find((item) => item.slot === 'shell.composer' && item.options.id === 'tasks.goal')
if (found === undefined) throw new Error('tasks 插件没有把目标条登记进 shell.composer')
const GoalBar = found.component

interface Invoke {
  method: string
  args: unknown[]
}

interface Harness {
  channel: HostChannel
  calls: Invoke[]
}

/** 假宿主：快照里只放 surfaces.goal，`goalAction` 的调用记账。 */
function harnessOf(goal: GoalView | undefined, invokeError?: Error): Harness {
  const calls: Invoke[] = []
  const snapshot = {
    sessions: [],
    status: { cwd: 'C:/repo', turnState: 'idle' },
    surfaces: goal === undefined ? {} : { goal },
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
      if (invokeError !== undefined) return Promise.reject(invokeError)
      return Promise.resolve({ ok: true } as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const goalOf = (over: Partial<GoalView> = {}): GoalView => ({
  objective: '把界面覆盖率补上',
  phase: 'active',
  rounds: 2,
  maxRounds: 5,
  armed: true,
  ...over,
})

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <GoalBar />
    </RuntimeProvider>,
  )

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''

const buttonOf = (container: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((button) => textOf(button) === label) as
    | HTMLButtonElement
    | undefined

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('目标条', () => {
  test('登记在 shell.composer 的 tasks.goal（order 22）；没设目标时整条不画', () => {
    expect(found?.slot).toBe('shell.composer')
    expect(found?.options.id).toBe('tasks.goal')
    expect(found?.options.order).toBe(22)

    const { container } = mount(harnessOf(undefined))
    expect(container.innerHTML).toBe('')
  })

  test('active + armed：显示目标、轮次与「自动续跑中」；暂停只发 goalAction(pause)', async () => {
    const harness = harnessOf(goalOf())
    const { container } = mount(harness)

    expect(textOf(container.querySelector('.goal-label'))).toBe('目标')
    expect(textOf(container.querySelector('.goal-text'))).toBe('把界面覆盖率补上')
    expect(textOf(container.querySelector('.goal-state'))).toBe('自动续跑中 · 2/5 轮')
    expect(buttonOf(container, '暂停')).not.toBeUndefined()

    fireEvent.click(buttonOf(container, '暂停') as HTMLButtonElement)
    await flush()
    expect(harness.calls).toEqual([{ method: 'goalAction', args: ['pause'] }])
    expect(document.body.textContent).toContain('目标已暂停')
  })

  test('paused：按钮换成「继续」，点了发 resume', async () => {
    const harness = harnessOf(goalOf({ phase: 'paused' }))
    const { container } = mount(harness)

    expect(textOf(container.querySelector('.goal-state'))).toContain('已暂停')
    expect(buttonOf(container, '暂停')).toBeUndefined()
    fireEvent.click(buttonOf(container, '继续') as HTMLButtonElement)
    await flush()

    expect(harness.calls).toEqual([{ method: 'goalAction', args: ['resume'] }])
    expect(document.body.textContent).toContain('目标已继续')
  })

  test('blocked 且卡在轮次上限：多一颗「放宽轮次」，点了发 extend', async () => {
    const harness = harnessOf(
      goalOf({ phase: 'blocked', blockedReason: '轮次已达上限（5/5）' }),
    )
    const { container } = mount(harness)

    expect(textOf(container.querySelector('.goal-state'))).toContain('已阻塞')
    expect(buttonOf(container, '放宽轮次')).not.toBeUndefined()
    fireEvent.click(buttonOf(container, '放宽轮次') as HTMLButtonElement)
    await flush()

    expect(harness.calls).toEqual([{ method: 'goalAction', args: ['extend'] }])
    expect(document.body.textContent).toContain('已放宽轮次')
  })

  test('blocked 但不是轮次上限：不给「放宽轮次」，仍可继续', () => {
    const { container } = mount(harnessOf(goalOf({ phase: 'blocked', blockedReason: '等待用户确认' })))

    expect(buttonOf(container, '放宽轮次')).toBeUndefined()
    expect(buttonOf(container, '继续')).not.toBeUndefined()
  })

  test('complete：不画暂停/继续/放宽，只剩清空；清空发 clear', async () => {
    const harness = harnessOf(goalOf({ phase: 'complete' }))
    const { container } = mount(harness)

    expect(textOf(container.querySelector('.goal-state'))).toContain('已完成')
    expect(buttonOf(container, '暂停')).toBeUndefined()
    expect(buttonOf(container, '继续')).toBeUndefined()
    expect(buttonOf(container, '放宽轮次')).toBeUndefined()

    fireEvent.click(buttonOf(container, '✕') as HTMLButtonElement)
    await flush()
    expect(harness.calls).toEqual([{ method: 'goalAction', args: ['clear'] }])
    expect(document.body.textContent).toContain('目标已清除')
  })

  test('动作失败：把宿主给的原因写进失败提示', async () => {
    const harness = harnessOf(goalOf(), new Error('socket closed'))
    const { container } = mount(harness)

    fireEvent.click(buttonOf(container, '暂停') as HTMLButtonElement)
    await flush()

    expect(document.body.textContent).toContain('目标操作失败：socket closed')
  })
})
