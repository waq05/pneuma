/**
 * 槽位 React 出口（`ui-slots/ui/slots-react.tsx`）的分支补测（ui 层，真渲染）。
 *
 * 既有包测试只断言文件存在；ui-core 的 `slots-extra.spec.ts` 钉的是注册表账本。
 * 这一份补渲染出口自己那一层：条目外层属性、owner 透传、`renderSlot` 的子槽装配校验、
 * chain 选举与兜底、错误边界退位、Factory 的局部位置选择 / 递归检测 / 故障边界。
 *
 * @module dsc-ui-slots/ui/w11-branches.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import { SlotAssemblyError, SlotRegistry } from '@dsc/ui-core'
import type { UiSlots } from '@dsc/ui'
import { ChainOutlet, FactoryOutlet, SlotOutlet } from './slots-react.js'

type Kind = 'list' | 'single' | 'keyed' | 'chain'

/** 注册表：公开 API 的泛型在测试里没必要收窄，统一走擦除签名。 */
function makeSlots(): { registry: SlotRegistry; slots: UiSlots } {
  const registry = new SlotRegistry()
  return { registry, slots: registry as unknown as UiSlots }
}

function declare(registry: SlotRegistry, slot: string, kind: Kind = 'list'): () => void {
  return (registry.declare as (slot: string, kind: Kind) => () => void)(slot, kind)
}

function register(
  registry: SlotRegistry,
  slot: string,
  options: Record<string, unknown>,
  component: unknown,
): () => void {
  return (registry.register as (s: string, o: Record<string, unknown>, c: unknown) => () => void)(
    slot,
    options,
    component,
  )
}

function registerFactory(
  registry: SlotRegistry,
  options: Record<string, unknown>,
  component: unknown,
): () => void {
  return (registry.registerFactory as (o: Record<string, unknown>, c: unknown) => () => void)(
    options,
    component,
  )
}

type AnyProps = Record<string, any>

/** 一个把 owner 的 `label` 画出来的普通条目。 */
function Label(props: AnyProps): ReactNode {
  return (
    <span className="label" data-owner-label={String(props.label ?? 'none')}>
      {String(props.label ?? 'none')}
    </span>
  )
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SlotOutlet 与 renderSlot', () => {
  test('list 槽按 order 画全部条目，owner 缺省与显式两种都透传，外层带 data 属性', () => {
    const { registry, slots } = makeSlots()
    declare(registry, 'shell.main')
    register(registry, 'shell.main', { id: 'late', order: 20 }, Label)
    register(registry, 'shell.main', { id: 'early', order: 5 }, Label)

    const first = render(<SlotOutlet slots={slots} slot="shell.main" />)
    const entries = [...first.container.querySelectorAll('.slot-entry')] as HTMLElement[]
    expect(entries.map((node) => node.dataset['entry'])).toEqual(['early', 'late'])
    expect(entries[0]?.dataset['slot']).toBe('shell.main')
    expect(entries[0]?.dataset['cell']).toBe('early')
    expect(first.container.querySelector('.label')?.getAttribute('data-owner-label')).toBe('none')
    first.unmount()

    const second = render(<SlotOutlet slots={slots} slot="shell.main" owner={{ label: 'row-7' }} />)
    expect(second.container.querySelector('.label')?.getAttribute('data-owner-label')).toBe('row-7')
  })

  test('renderSlot 渲染声明过的非 chain 子槽与 chain 子槽；空 chain 用 fallback', () => {
    const { registry, slots } = makeSlots()
    declare(registry, 'shell.main')
    declare(registry, 'child.list')
    declare(registry, 'child.chain', 'chain')
    register(registry, 'child.list', { id: 'child' }, Label)
    function Host(props: AnyProps): ReactNode {
      return (
        <div className="host">
          {props.renderSlot('child.list', { label: 'nested' })}
          {props.renderSlot('child.chain', {}, <i className="fallback">empty-chain</i>)}
        </div>
      )
    }
    register(registry, 'shell.main', { id: 'host', children: { 'child.list': 'list', 'child.chain': 'chain' } }, Host)

    const { container } = render(<SlotOutlet slots={slots} slot="shell.main" />)
    expect(container.querySelector('.host .label')?.getAttribute('data-owner-label')).toBe('nested')
    expect(container.querySelector('.host .fallback')?.textContent).toBe('empty-chain')
  })

  test('renderSlot 没声明的子槽抛装配错误：空表与有表两种文案都写人话', () => {
    const { registry, slots } = makeSlots()
    declare(registry, 'shell.main')
    function Bad(props: AnyProps): ReactNode {
      return <>{props.renderSlot('nope')}</>
    }
    const releaseBad = register(registry, 'shell.main', { id: 'bad' }, Bad)
    expect(() => render(<SlotOutlet slots={slots} slot="shell.main" />)).toThrow(SlotAssemblyError)
    expect(() => render(<SlotOutlet slots={slots} slot="shell.main" />)).toThrow(/没有声明子槽「nope」.*声明过的：无/s)
    releaseBad()
    cleanup()

    declare(registry, 'known')
    function Bad2(props: AnyProps): ReactNode {
      return <>{props.renderSlot('nope')}</>
    }
    const release = register(registry, 'shell.main', { id: 'bad2', children: { known: 'list' } }, Bad2)
    expect(() => render(<SlotOutlet slots={slots} slot="shell.main" />)).toThrow(/声明过的：known/s)
    release()
  })

  test('条目渲染抛普通错误：记一条故障并让它退位；装配错误仍往上炸', () => {
    const { registry, slots } = makeSlots()
    declare(registry, 'shell.main')
    function Explode(): ReactNode {
      throw new Error('boom')
    }
    register(registry, 'shell.main', { id: 'broken', priority: 0 }, Explode)
    register(registry, 'shell.main', { id: 'healthy', priority: 1 }, Label)

    const view = render(<SlotOutlet slots={slots} slot="shell.main" owner={{ label: 'ok' }} />)
    expect(registry.faults.some((fault) => fault.id === 'broken' && String(fault.error.message).includes('boom'))).toBe(
      true,
    )
    expect(registry.winners('shell.main').map((entry) => entry.id)).toEqual(['healthy'])
    expect(view.container.querySelector('[data-owner-label="ok"]')).not.toBeNull()
  })

  test('装配错误不被错误边界吞掉：继续抛给上层', () => {
    const { registry, slots } = makeSlots()
    declare(registry, 'shell.main')
    function AssemblyBoom(): ReactNode {
      throw new SlotAssemblyError('契约对不上')
    }
    register(registry, 'shell.main', { id: 'assembly' }, AssemblyBoom)
    expect(() => render(<SlotOutlet slots={slots} slot="shell.main" />)).toThrow('契约对不上')
    expect(registry.faults).toHaveLength(0)
  })
})

describe('ChainOutlet 选举', () => {
  test('没有候选时画 fallback；不给 fallback 就是空', () => {
    const { registry, slots } = makeSlots()
    declare(registry, 'shell.chain', 'chain')
    const withFallback = render(
      <ChainOutlet slots={slots} slot="shell.chain" owner={{}} fallback={<b className="fb">none</b>} />,
    )
    expect(withFallback.container.querySelector('.fb')).not.toBeNull()
    withFallback.unmount()

    const empty = render(<ChainOutlet slots={slots} slot="shell.chain" owner={{}} />)
    expect(empty.container.querySelector('.slot-entry')).toBeNull()
  })

  test('按 select 选出唯一渲染者，matched 与 owner 一起交给组件；抛异常的选择器弃权给下一位', () => {
    const { registry, slots } = makeSlots()
    declare(registry, 'shell.chain', 'chain')
    function Picked(props: AnyProps): ReactNode {
      return (
        <span className="picked" data-matched={String(props.matched)} data-row={String(props.row)}>
          {String(props.matched)}
        </span>
      )
    }
    register(
      registry,
      'shell.chain',
      {
        id: 'skip',
        priority: 0,
        select: () => null,
      },
      Picked,
    )
    register(
      registry,
      'shell.chain',
      {
        id: 'thrower',
        priority: 1,
        select: () => {
          throw new Error('bad selector')
        },
      },
      Picked,
    )
    register(
      registry,
      'shell.chain',
      {
        id: 'hit',
        priority: 2,
        select: (owner: AnyProps) => (owner['row'] === 'r1' ? 'MATCH' : null),
      },
      Picked,
    )

    const { container } = render(<ChainOutlet slots={slots} slot="shell.chain" owner={{ row: 'r1' }} />)
    expect(container.querySelectorAll('.slot-entry')).toHaveLength(1)
    expect(container.querySelector('.picked')?.getAttribute('data-matched')).toBe('MATCH')
    expect(container.querySelector('.picked')?.getAttribute('data-row')).toBe('r1')
    // 抛异常的选择器被记成故障并退位。
    expect(registry.faults.some((fault) => fault.id === 'thrower')).toBe(true)
  })
})

describe('Factory 出口', () => {
  test('定义缺席画 fallback；不给 fallback 为空；之后注册定义会自动出现', () => {
    const { registry, slots } = makeSlots()
    const missing = render(
      <FactoryOutlet slots={slots} name="card" fallback={<span className="waiting">waiting</span>} />,
    )
    expect(missing.container.querySelector('.waiting')).not.toBeNull()
    missing.unmount()

    const none = render(<FactoryOutlet slots={slots} name="card" />)
    expect(none.container.textContent).toBe('')
    none.unmount()

    const live = render(<FactoryOutlet slots={slots} name="card" />)
    function Def(): ReactNode {
      return <span className="def">defined</span>
    }
    act(() => {
      registerFactory(registry, { name: 'card' }, Def)
    })
    expect(live.container.querySelector('.def')).not.toBeNull()
  })

  test('定义组件拿到 childSlots / renderSlot / renderFactorySlot / useFactorySlot 与输入 props', () => {
    const { registry, slots } = makeSlots()
    declare(registry, 'factory.child')
    const offChild = register(registry, 'factory.child', { id: 'child' }, Label)
    function Local(props: AnyProps): ReactNode {
      return <span className="local">{String(props.label)}</span>
    }
    function Def(props: AnyProps): ReactNode {
      const Chosen = props.useFactorySlot('body', Local)
      return (
        <div className="def">
          <span className="children">{props.childSlots.join(',')}</span>
          <span className="input">{String(props.input)}</span>
          {props.renderSlot('factory.child', { label: 'from-def' })}
          <Chosen label="local-default" />
        </div>
      )
    }
    const offDef = registerFactory(
      registry,
      { name: 'card', children: { 'factory.child': 'list' }, slots: { body: { props: {} } } },
      Def,
    )

    const { container } = render(
      <FactoryOutlet slots={slots} name="card" inputProps={{ input: 'payload' }} />,
    )
    expect(container.querySelector('.children')?.textContent).toBe('factory.child')
    expect(container.querySelector('.input')?.textContent).toBe('payload')
    expect(container.querySelector('.def .label')?.getAttribute('data-owner-label')).toBe('from-def')
    // 父没选局部组件时用定义给的 fallback。
    expect(container.querySelector('.local')?.textContent).toBe('local-default')

    cleanup()
    const selected = render(
      <FactoryOutlet
        slots={slots}
        name="card"
        selections={{
          body: (props: AnyProps) => <span className="selected">{String(props.label)}</span>,
        }}
      />,
    )
    expect(selected.container.querySelector('.selected')?.textContent).toBe('local-default')
    offDef()
    offChild()
  })

  test('没有声明的局部位置 / 子槽都抛装配错误；空表与有表文案不同', () => {
    const { registry, slots } = makeSlots()
    function UseMissing(props: AnyProps): ReactNode {
      props.useFactorySlot('nope', (() => null) as never)
      return null
    }
    const off = registerFactory(registry, { name: 'empty' }, UseMissing)
    expect(() => render(<FactoryOutlet slots={slots} name="empty" />)).toThrow(/没有声明局部位置「nope」.*声明过的：无/s)
    cleanup()
    off()

    declare(registry, 'factory.child')
    function RenderMissing(props: AnyProps): ReactNode {
      return <>{props.renderSlot('nope')}</>
    }
    const off2 = registerFactory(registry, { name: 'childless' }, RenderMissing)
    expect(() => render(<FactoryOutlet slots={slots} name="childless" />)).toThrow(/没有声明子槽「nope」/s)
    cleanup()

    function RenderMissing2(props: AnyProps): ReactNode {
      return <>{props.renderSlot('nope')}</>
    }
    const off3 = registerFactory(
      registry,
      { name: 'withchild', children: { 'factory.child': 'list' } },
      RenderMissing2,
    )
    expect(() => render(<FactoryOutlet slots={slots} name="withchild" />)).toThrow(/声明过的：factory\.child/s)
    off2()
    off3()
  })

  test('父位置选了未声明的局部组件：抛装配错误（空表/有表都写清）', () => {
    const { registry, slots } = makeSlots()
    function Def(): ReactNode {
      return null
    }
    const off = registerFactory(registry, { name: 'plain' }, Def)
    expect(() =>
      render(
        <FactoryOutlet
          slots={slots}
          name="plain"
          selections={{ nope: (() => null) as ComponentType<Record<string, unknown>> }}
        />,
      ),
    ).toThrow(/没有声明局部位置「nope」.*声明过的：无/s)
    cleanup()

    const off2 = registerFactory(registry, { name: 'slotted', slots: { body: {} } }, Def)
    expect(() =>
      render(
        <FactoryOutlet
          slots={slots}
          name="slotted"
          selections={{ another: (() => null) as ComponentType<Record<string, unknown>> }}
        />,
      ),
    ).toThrow(/声明过的：body/s)
    off()
    off2()
  })

  test('Factory 自己的 occurrence 递归渲染：装配错误往上炸', () => {
    const { registry, slots } = makeSlots()
    function Loop(props: AnyProps): ReactNode {
      return <>{props.renderFactorySlot('loop')}</>
    }
    const off = registerFactory(registry, { name: 'loop' }, Loop)
    expect(() => render(<FactoryOutlet slots={slots} name="loop" />)).toThrow(/递归渲染/)
    off()
  })

  test('定义组件渲染崩溃：画 factory-crash、记故障但不摘除共享定义', () => {
    const { registry, slots } = makeSlots()
    function DefBoom(): ReactNode {
      throw new Error('factory boom')
    }
    const off = registerFactory(registry, { name: 'boom' }, DefBoom)
    const view = render(<FactoryOutlet slots={slots} name="boom" />)
    expect(view.container.querySelector('.factory-crash')?.textContent).toContain('factory boom')
    expect(registry.faults.some((fault) => fault.slot === 'factory:boom')).toBe(true)
    // 定义还在：别的 occurrence 仍能取到它。
    expect(registry.factory('boom')).toBeDefined()
    off()
  })

  test('局部组件渲染崩溃：画 factory-crash 且故障 id 是局部位置名', () => {
    const { registry, slots } = makeSlots()
    function Def(props: AnyProps): ReactNode {
      const Chosen = props.useFactorySlot('body', (() => null) as never)
      return <Chosen />
    }
    const off = registerFactory(registry, { name: 'localboom', slots: { body: {} } }, Def)
    const view = render(
      <FactoryOutlet
        slots={slots}
        name="localboom"
        selections={{
          body: (): ReactNode => {
            throw new Error('local boom')
          },
        }}
      />,
    )
    expect(view.container.querySelector('.factory-crash')?.textContent).toContain('local boom')
    expect(view.container.querySelector('.factory-crash')?.getAttribute('data-factory-slot')).toBe('body')
    expect(registry.faults.some((fault) => fault.slot === 'factory:localboom' && fault.id === 'body')).toBe(true)
    off()
  })

  test('局部组件里的装配错误不被 Factory 边界吞掉', () => {
    const { registry, slots } = makeSlots()
    function Def(props: AnyProps): ReactNode {
      const Chosen = props.useFactorySlot('body', (() => null) as never)
      return <Chosen />
    }
    const off = registerFactory(registry, { name: 'localassembly', slots: { body: {} } }, Def)
    expect(() =>
      render(
        <FactoryOutlet
          slots={slots}
          name="localassembly"
          selections={{
            body: (): ReactNode => {
              throw new SlotAssemblyError('局部装配错')
            },
          }}
        />,
      ),
    ).toThrow('局部装配错')
    off()
  })
})
