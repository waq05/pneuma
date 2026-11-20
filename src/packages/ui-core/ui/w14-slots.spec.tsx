/**
 * `ui-core` 槽位渲染出口（`slots-ink.tsx`）与 React 订阅面（`slots-react.ts`）的补盲。
 *
 * 缺口是几处「只有走到特定分支才会经过」的边界，逐条钉行为：
 *
 *   - 空槽返回 null（不渲染包装层，帧里不多出空行）；
 *   - 声明过子槽的条目能经 `renderSlot` 渲染子槽；没声明的报装配错误并列出声明过的；
 *   - TUI 没有 Factory 渲染出口：`renderFactorySlot` 明确抛装配错误，不是 undefined 崩；
 *   - 条目渲染期普通异常：错误边界接住、上报故障、这一条退位，其它条目不退；
 *     而装配错误（SlotAssemblyError）必须往上炸——壳和插件的契约没对上不能装作没事；
 *   - 席位：登记过 store 的条目拿到 useStore / actions；实例从有到无时读值清空
 *     （不许静默画旧数据）；登记的持有者还在、实例却已释放时报装配错误。
 *
 * ink 的组件在这里按 react-dom 渲染：`Box` / `Text` 落到未知标签与文本节点上，
 * 被测的是槽位的装配/退位语义，不是 ink 的排版。
 *
 * @module dsc/packages/ui-core/ui/w14-slots
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import { createElement } from 'react'
import { SlotAssemblyError, SlotRegistry, type SlotEntry } from '../slots.js'
import { SlotOutlet } from '../slots-ink.js'
import { useSeat, useSeatProps } from '../slots-react.js'
import { defineStore, type SeatInstance } from '../store.js'

/** 用擦除签名登记（渲染出口的组件类型是开放表，这里只钉装配语义）。 */
function register(
  registry: SlotRegistry<unknown>,
  slot: string,
  options: Record<string, unknown>,
  component: unknown,
): () => void {
  const erased = registry.register.bind(registry) as (
    slot: string,
    options: Record<string, unknown>,
    component: unknown,
  ) => () => void
  return erased(slot, options, component)
}

/** 挂一个简版槽位出口（SlotOutlet 的 props 是擦除面，这里按 ComponentType 收窄）。 */
function outlet(registry: SlotRegistry<unknown>, slot: string): ReactNode {
  return createElement(SlotOutlet as unknown as ComponentType<{ slots: unknown; slot: string }>, {
    slots: registry,
    slot,
  })
}

/** 取条目组件拿到的渲染能力。 */
interface EntryCapabilities {
  renderSlot: (name: string) => ReactNode
  renderFactorySlot: () => ReactNode
  childSlots: readonly string[]
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SlotOutlet 的装配语义', () => {
  test('没有登记的槽不渲染任何东西', () => {
    const registry = new SlotRegistry<unknown>()
    registry.declare('shell.empty', 'list')
    const empty = render(createElement('div', null, outlet(registry, 'shell.empty')))
    expect(empty.container.innerHTML).toBe('<div></div>')

    const missing = render(createElement('div', null, outlet(registry, 'shell.missing')))
    expect(missing.container.innerHTML).toBe('<div></div>')
  })

  test('条目经 renderSlot 渲染声明过的子槽，childSlots 列出声明名', () => {
    const registry = new SlotRegistry<unknown>()
    registry.declare('shell.main', 'list')
    registry.declare('card.body', 'single')

    const child = (): ReactNode => createElement('span', null, '子槽内容')
    register(registry, 'card.body', { id: 'child' }, child)

    const parent = (props: Record<string, unknown>): ReactNode => {
      const capabilities = props as unknown as EntryCapabilities
      return createElement(
        'section',
        { 'data-children': capabilities.childSlots.join('、') },
        capabilities.renderSlot('card.body'),
      )
    }
    register(registry, 'shell.main', { id: 'parent', children: { 'card.body': 'single' } }, parent)

    const { container } = render(createElement('div', null, outlet(registry, 'shell.main')))
    expect(container.querySelector('section')?.getAttribute('data-children')).toBe('card.body')
    expect(container.textContent).toContain('子槽内容')
  })

  test('renderSlot 指向没声明过的子槽：抛装配错误，并把声明过的名字列进消息', () => {
    const registry = new SlotRegistry<unknown>()
    registry.declare('shell.broken', 'single')
    const wrongChild = (props: Record<string, unknown>): ReactNode => {
      const capabilities = props as unknown as EntryCapabilities
      return capabilities.renderSlot('card.head')
    }
    register(registry, 'shell.broken', { id: 'bad-child', children: { 'card.body': 'single' } }, wrongChild)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    let message = ''
    try {
      render(createElement('div', null, outlet(registry, 'shell.broken')))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('没有声明子槽「card.head」')
    expect(message).toContain('card.body')
    // 装配错误不是「插件坏了」：不记故障、不退位。
    expect(registry.faults).toEqual([])
    expect(registry.brokenCount('shell.broken')).toBe(0)
  })

  test('TUI 没有 Factory 渲染出口：调用即抛装配错误，且不把条目当成坏了', () => {
    const registry = new SlotRegistry<unknown>()
    registry.declare('shell.factory', 'single')
    const boom = (props: Record<string, unknown>): ReactNode => {
      const capabilities = props as unknown as EntryCapabilities
      return capabilities.renderFactorySlot()
    }
    register(registry, 'shell.factory', { id: 'factory-user' }, boom)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    let message = ''
    try {
      render(createElement('div', null, outlet(registry, 'shell.factory')))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('Factory 渲染出口')
    expect(registry.brokenCount('shell.factory')).toBe(0)
  })

  test('普通渲染异常：错误边界接住、记一条 render 故障、这一条退位，别的条目照常渲染', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const registry = new SlotRegistry<unknown>()
    registry.declare('shell.main', 'list')
    const broken = (): ReactNode => {
      throw new Error('组件炸了')
    }
    register(registry, 'shell.main', { id: 'boom' }, broken)
    register(registry, 'shell.main', { id: 'fine', order: 1 }, (() => createElement('span', null, '还在')) as never)

    const { container } = render(createElement('div', null, outlet(registry, 'shell.main')))
    expect(registry.faults.at(-1)).toMatchObject({ slot: 'shell.main', id: 'boom', phase: 'render' })
    expect(registry.brokenCount('shell.main')).toBe(1)
    expect(container.textContent).toContain('还在')
    expect(container.textContent).not.toContain('组件炸了')
  })

  test('席位：登记 store 的条目拿到 useStore / actions，写入口逐次通知', () => {
    const registry = new SlotRegistry<unknown>()
    registry.declare('shell.seat', 'single')
    const handle = defineStore<{ n: number }, { bump: (draft: { n: number }) => void }>({
      init: () => ({ n: 0 }),
      actions: {
        bump: (draft) => {
          draft.n += 1
        },
      },
    })
    const seated = (props: Record<string, unknown>): ReactNode => {
      const useStore = props['useStore'] as (selector: (state: { n: number }) => number) => number
      const actions = props['actions'] as { bump: () => void }
      const n = useStore((state) => state.n)
      return createElement('button', { type: 'button', onClick: () => actions.bump() }, `n=${String(n)}`)
    }
    register(registry, 'shell.seat', { id: 'seat', store: handle }, seated)

    const { container } = render(createElement('div', null, outlet(registry, 'shell.seat')))
    const button = container.querySelector('button') as HTMLButtonElement
    expect(button.textContent).toBe('n=0')
    act(() => {
      button.click()
    })
    expect(container.querySelector('button')?.textContent).toBe('n=1')
    expect(registry.seat(handle)?.getSnapshot()).toEqual({ n: 1 })
  })
})

describe('useSeat 的实例切换', () => {
  test('实例从有到无时读值清空，回来再按新实例订阅', () => {
    const handle = defineStore<{ n: number }, { set: (draft: { n: number }, to: number) => void }>({
      init: () => ({ n: 7 }),
      actions: {
        set: (draft, to) => {
          draft.n = to
        },
      },
    })
    const registry = new SlotRegistry<unknown>()
    registry.declare('shell.main', 'single')
    const off = register(registry, 'shell.main', { id: 'seat', store: handle }, (() => null) as never)
    // 动作表的入参由壳在调用时补，测试只关心「点一下就改状态」：用 rest 参数放宽类型。
    type LocalActions = { set: (...args: unknown[]) => void }
    const instance = registry.seat(handle) as unknown as { actions: LocalActions } | undefined
    expect(instance).toBeDefined()

    const useValue = (at: unknown): number | undefined =>
      useSeat(at as SeatInstance<{ n: number }, never> | undefined, (state) => state.n)
    const { result, rerender } = renderHook((props: { at: unknown }) => useValue(props.at), {
      initialProps: { at: instance as unknown },
    })
    expect(result.current).toBe(7)

    act(() => {
      instance?.actions.set(3)
    })
    expect(result.current).toBe(3)

    rerender({ at: undefined })
    expect(result.current).toBeUndefined()

    rerender({ at: instance as unknown })
    expect(result.current).toBe(3)
    off()
  })

  test('登记的持有者还在、实例却不在账上：useSeatProps 抛装配错误', () => {
    const handle = defineStore<{ n: number }, Record<never, never>>({ init: () => ({ n: 0 }), actions: {} })
    const broken = (): ReactNode => {
      // 持有者还在，但传进来的注册表说这个席位没实例——与真注册表对不上就是装配错误。
      useSeatProps({ seat: () => undefined }, handle)
      return null
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => render(createElement(broken))).toThrow(SlotAssemblyError)
  })
})

describe('登记表的读面（与渲染出口共用同一份快照）', () => {
  test('winners 的引用在版本不变时稳定，退订后回到空表', () => {
    const registry = new SlotRegistry<unknown>()
    registry.declare('shell.main', 'list')
    const off = register(registry, 'shell.main', { id: 'row' }, (() => null) as never)
    const first = registry.winners('shell.main')
    expect(registry.winners('shell.main')).toBe(first)
    expect(registry.entriesOf('shell.none')).toEqual([])
    expect((first[0] as SlotEntry<unknown>).id).toBe('row')
    off()
    expect(registry.winners('shell.main')).toEqual([])
  })
})
