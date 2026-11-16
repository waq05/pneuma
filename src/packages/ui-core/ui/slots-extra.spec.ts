/**
 * `ui-core` 槽位层的补充覆盖（ui 层，纯逻辑，落 ui project 是因为文件在 `ui/` 下）。
 *
 * 既有 `tests/ui-core.spec.ts` 只钉包身份与桶导出，`tests/integration/ui-plugin-slots.int.spec.ts`
 * 覆盖主流程。这里补它没铺到的边界：
 *
 *   - 声明引用计数 / 重复释放的幂等 / 未声明槽的错误文案（空表也给人话）；
 *   - keyed 的空 key、同格不同 priority 的合法替换、同 priority 的冲突；
 *   - single / list 的格子语义与 order 排序；
 *   - 按槽版本号与 winners 快照隔离（别的槽登记不换引用）；
 *   - injectSlot 的贡献 / 退订 / 槽消失后再回来重贡献，以及贡献与退订抛错的两条故障路径；
 *   - 崩溃退位后下一名顶上、重复报故障只记一条、退订后重新登记能复活；
 *   - chain 选举的同 priority 注册序、抛异常视同弃权、全员弃权、对非 chain 的装配错误；
 *   - 订阅按槽隔离、退订、订阅者抛异常不拖垮其它订阅者；
 *   - Factory 的重复注册、children/slots 冻结快照、卸载 collapse、故障账不摘定义；
 *   - 席位按 handle 共享实例、最后一个持有者释放后归零，以及 actions 的浅拷贝写入口；
 *   - `createScopedSlotApi` 的记账外壳（每个变更动作都进账本、返回值是账本函数）。
 *
 * 不写 smoke：每条都断言一个会因实现退化而变红的行为。
 *
 * @module @pneuma/ui-core/ui/slots-extra.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  ChainSlotSelectError,
  DuplicateSlotError,
  KeyedSlotKeyError,
  SlotAssemblyError,
  SlotKindConflictError,
  SlotRegistry,
  UndeclaredSlotError,
  type SlotElectResult,
  type SlotEntry,
  type SlotFault,
} from '../slots.js'
import { createScopedSlotApi } from '../scoped-slots.js'
import { defineStore } from '../store.js'
import { defineUiPlugin } from '../plugin.js'

/** 用擦除签名注册（开放表 SlotMapLike 本来就不做类型检查，链式 select 的窄签名在这里无意义）。 */
function register(
  registry: SlotRegistry,
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

/** 用擦除签名选举（原因同上）。 */
function elect(registry: SlotRegistry, slot: string, owner: unknown): SlotElectResult<unknown> | null {
  const erased = registry.elect.bind(registry) as (
    slot: string,
    owner: unknown,
  ) => SlotElectResult<unknown> | null
  return erased(slot, owner)
}

/** 捕获同步抛出的错误；没抛返回 null。 */
function thrown(fn: () => void): Error | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('声明与登记边界', () => {
  test('同形态重复声明按引用计数；释放幂等，归零才清槽', () => {
    const registry = new SlotRegistry()
    const releaseA = registry.declare('shell.main', 'list')
    const releaseB = registry.declare('shell.main', 'list')
    register(registry, 'shell.main', { id: 'panel' }, 'panel')

    releaseA()
    releaseA() // 重复调用是空操作
    expect(registry.slots).toEqual(['shell.main'])
    expect(registry.entriesOf('shell.main').map((entry) => entry.id)).toEqual(['panel'])

    releaseB()
    expect(registry.slots).toEqual([])
    expect(registry.entriesOf('shell.main')).toEqual([])
    expect(registry.winners('shell.main')).toEqual([])
    expect(registry.version('shell.main')).toBeGreaterThan(0)
  })

  test('形态冲突与未声明槽的报错：已知槽名（含空表）都写进人话里', () => {
    const registry = new SlotRegistry()
    registry.declare('shell.main', 'single')
    const conflict = thrown(() => registry.declare('shell.main', 'keyed'))
    expect(conflict).toBeInstanceOf(SlotKindConflictError)
    expect(conflict?.message).toContain('single')

    const unknown = thrown(() => register(registry, 'shell.nope', { id: 'x' }, 'x'))
    expect(unknown).toBeInstanceOf(UndeclaredSlotError)
    expect(unknown?.message).toContain('没有被声明')
    expect(unknown?.message).toContain('shell.main')

    const empty = new SlotRegistry()
    const none = thrown(() => register(empty, 'shell.nope', { id: 'x' }, 'x'))
    expect(none?.message).toContain('已声明：无')
  })

  test('keyed：空 key 报错；同格不同 priority 合法且小者胜；同 priority 冲突', () => {
    const registry = new SlotRegistry()
    registry.declare('status.keys', 'keyed')

    expect(thrown(() => register(registry, 'status.keys', { id: 'missing' }, 'x'))).toBeInstanceOf(
      KeyedSlotKeyError,
    )
    expect(thrown(() => register(registry, 'status.keys', { id: 'empty', key: '' }, 'x'))).toBeInstanceOf(
      KeyedSlotKeyError,
    )

    register(registry, 'status.keys', { id: 'low', key: 'main', priority: 5 }, 'low')
    register(registry, 'status.keys', { id: 'high', key: 'main', priority: 1 }, 'high')
    expect(registry.winners('status.keys').map((entry) => entry.id)).toEqual(['high'])
    // 被遮蔽的那份仍在登记表里，诊断看得见。
    expect(registry.entriesOf('status.keys').map((entry) => entry.id)).toEqual(['low', 'high'])

    expect(
      thrown(() => register(registry, 'status.keys', { id: 'dup', key: 'main', priority: 1 }, 'dup')),
    ).toBeInstanceOf(DuplicateSlotError)

    register(registry, 'status.keys', { id: 'other', key: 'side', priority: 0 }, 'other')
    expect(registry.winners('status.keys').map((entry) => entry.id)).toEqual(['high', 'other'])
  })

  test('single 一格一名、list 每 id 一格；显示序按 order 再按注册序', () => {
    const registry = new SlotRegistry()
    registry.declare('shell.one', 'single')
    register(registry, 'shell.one', { id: 'base', priority: 10 }, 'base')
    register(registry, 'shell.one', { id: 'override', priority: 0 }, 'override')
    expect(registry.winners('shell.one').map((entry) => entry.id)).toEqual(['override'])
    expect(
      thrown(() => register(registry, 'shell.one', { id: 'dup', priority: 0 }, 'dup')),
    ).toBeInstanceOf(DuplicateSlotError)

    registry.declare('shell.many', 'list')
    register(registry, 'shell.many', { id: 'late', order: 20 }, 'late')
    register(registry, 'shell.many', { id: 'early-a', order: 5 }, 'early-a')
    register(registry, 'shell.many', { id: 'early-b', order: 5 }, 'early-b')
    expect(registry.winners('shell.many').map((entry) => entry.id)).toEqual([
      'early-a',
      'early-b',
      'late',
    ])
  })

  test('winners 快照按槽隔离：别的槽登记不动这个槽的引用与版本号', () => {
    const registry = new SlotRegistry()
    registry.declare('shell.a', 'list')
    registry.declare('shell.b', 'list')
    register(registry, 'shell.a', { id: 'a1' }, 'a1')

    const snapshot = registry.winners('shell.a')
    const version = registry.version('shell.a')
    const global = registry.getVersion()

    register(registry, 'shell.b', { id: 'b1' }, 'b1')
    expect(registry.version('shell.a')).toBe(version)
    expect(registry.winners('shell.a')).toBe(snapshot)
    expect(registry.getVersion()).toBeGreaterThan(global)

    register(registry, 'shell.a', { id: 'a2', order: 1 }, 'a2')
    expect(registry.version('shell.a')).toBe(version + 1)
    expect(registry.winners('shell.a')).not.toBe(snapshot)
  })
})

describe('injectSlot 的等待语义与故障账', () => {
  test('槽未声明不跑；声明后贡献；槽撤回撤贡献；再声明重贡献；撤回等待解除贡献', () => {
    const registry = new SlotRegistry()
    let runs = 0
    let disposed = 0
    const off = registry.injectSlot('shell.late', () => {
      runs += 1
      return () => {
        disposed += 1
      }
    })
    expect(runs).toBe(0)

    const release = registry.declare('shell.late', 'single')
    expect(runs).toBe(1)

    release()
    expect(disposed).toBe(1)

    const releaseAgain = registry.declare('shell.late', 'single')
    expect(runs).toBe(2)

    off()
    expect(disposed).toBe(2)
    releaseAgain()
    expect(disposed).toBe(2)
  })

  test('贡献抛错记 contribute；退订抛错记 dispose；都不把异常抛给调用方', () => {
    const registry = new SlotRegistry()
    const faults: SlotFault[] = []
    registry.onFault((fault) => faults.push(fault))
    registry.injectSlot('shell.bad', () => {
      throw new Error('贡献失败')
    })
    const release = registry.declare('shell.bad', 'single')
    expect(faults).toHaveLength(1)
    expect(faults[0]).toMatchObject({ slot: 'shell.bad', id: '', phase: 'contribute' })
    expect(faults[0]?.error.message).toBe('贡献失败')
    release()

    const disposing = new SlotRegistry()
    const disposeFaults: SlotFault[] = []
    disposing.onFault((fault) => disposeFaults.push(fault))
    disposing.injectSlot('shell.bad', () => () => {
      throw new Error('退订失败')
    })
    const releaseDisposal = disposing.declare('shell.bad', 'single')
    expect(() => releaseDisposal()).not.toThrow()
    expect(disposeFaults).toHaveLength(1)
    expect(disposeFaults[0]).toMatchObject({ slot: 'shell.bad', id: '', phase: 'dispose' })
    expect(disposeFaults[0]?.error.message).toBe('退订失败')
  })
})

describe('崩溃退位与订阅', () => {
  test('报故障后退位、下一名顶上；重复报只记一条；退订后新登记能重新拿到位置', () => {
    const registry = new SlotRegistry()
    registry.declare('shell.main', 'single')
    const offLow = register(registry, 'shell.main', { id: 'low', priority: 10 }, 'low')
    const offHigh = register(registry, 'shell.main', { id: 'high', priority: 1 }, 'high')
    expect(registry.winners('shell.main').map((entry) => entry.id)).toEqual(['high'])

    const faults: SlotFault[] = []
    registry.onFault((fault) => faults.push(fault))
    const high = registry.entriesOf('shell.main').find((entry) => entry.id === 'high') as SlotEntry<unknown>
    registry.reportFault(high, '渲染炸了')
    expect(registry.winners('shell.main').map((entry) => entry.id)).toEqual(['low'])
    expect(registry.brokenCount('shell.main')).toBe(1)
    expect(faults).toHaveLength(1)
    expect(faults[0]).toMatchObject({ slot: 'shell.main', id: 'high', phase: 'render' })
    expect(faults[0]?.error).toBeInstanceOf(Error)

    registry.reportFault(high, new Error('再报一次'))
    expect(faults).toHaveLength(1) // 坏条目只记第一条

    offHigh()
    expect(registry.brokenCount('shell.main')).toBe(0)
    const offNew = register(registry, 'shell.main', { id: 'high', priority: 1 }, 'high-again')
    expect(registry.winners('shell.main').map((entry) => entry.id)).toEqual(['high'])
    offNew()
    offLow()
  })

  test('订阅按槽隔离、退订生效；一个订阅者抛异常不拖垮其它订阅者', () => {
    const registry = new SlotRegistry()
    registry.declare('shell.a', 'list')
    registry.declare('shell.b', 'list')
    let onlyA = 0
    let all = 0
    const offA = registry.subscribe(() => {
      onlyA += 1
    }, 'shell.a')
    const offAll = registry.subscribe(() => {
      all += 1
    })

    register(registry, 'shell.b', { id: 'b1' }, 'b1')
    expect(onlyA).toBe(0)
    expect(all).toBe(1)

    register(registry, 'shell.a', { id: 'a1' }, 'a1')
    expect(onlyA).toBe(1)
    expect(all).toBe(2)

    offA()
    offAll()
    register(registry, 'shell.a', { id: 'a2', order: 1 }, 'a2')
    expect(onlyA).toBe(1)
    expect(all).toBe(2)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let afterThrow = 0
    registry.subscribe(() => {
      throw new Error('订阅者坏了')
    }, 'shell.a')
    registry.subscribe(() => {
      afterThrow += 1
    }, 'shell.a')
    register(registry, 'shell.a', { id: 'a3', order: 2 }, 'a3')
    expect(afterThrow).toBe(1)
    expect(errorSpy).toHaveBeenCalled()
  })
})

describe('chain 选举', () => {
  test('同 priority 按注册序；弃权问下一位；matched 原样透传；winners 给全部幸存者', () => {
    const registry = new SlotRegistry()
    registry.declare('shell.tool', 'chain')
    register(registry, 'shell.tool', { id: 'catch-all', priority: 5, select: () => 'fallback' }, 'c')
    register(
      registry,
      'shell.tool',
      { id: 'first', priority: 0, select: (owner: unknown) => ((owner as { mine?: boolean }).mine === true ? 'mine' : null) },
      'a',
    )
    register(registry, 'shell.tool', { id: 'second', priority: 0, select: () => 'second' }, 'b')

    expect(elect(registry, 'shell.tool', { mine: true })).toMatchObject({
      entry: { id: 'first' },
      matched: 'mine',
    })
    expect(elect(registry, 'shell.tool', { mine: false })).toMatchObject({
      entry: { id: 'second' },
      matched: 'second',
    })
    expect(registry.winners('shell.tool').map((entry) => entry.id)).toEqual([
      'first',
      'second',
      'catch-all',
    ])
  })

  test('选择器抛错视同弃权并退位；全员弃权给 null；对非 chain 选举抛装配错误', () => {
    const registry = new SlotRegistry()
    registry.declare('shell.tool', 'chain')
    register(
      registry,
      'shell.tool',
      {
        id: 'broken',
        priority: 0,
        select: () => {
          throw new Error('选择器坏了')
        },
      },
      'bad',
    )
    register(registry, 'shell.tool', { id: 'good', priority: 1, select: () => 'good' }, 'good')

    expect(elect(registry, 'shell.tool', {})).toMatchObject({ entry: { id: 'good' }, matched: 'good' })
    expect(registry.brokenCount('shell.tool')).toBe(1)
    expect(registry.faults.at(-1)).toMatchObject({ slot: 'shell.tool', id: 'broken', phase: 'render' })
    expect(registry.winners('shell.tool').map((entry) => entry.id)).toEqual(['good'])

    registry.declare('shell.abstain', 'chain')
    register(registry, 'shell.abstain', { id: 'never', select: () => null }, 'never')
    expect(elect(registry, 'shell.abstain', {})).toBeNull()

    registry.declare('shell.single', 'single')
    expect(thrown(() => elect(registry, 'shell.single', {}))).toBeInstanceOf(SlotAssemblyError)
  })
})

describe('Factory 与席位', () => {
  test('Factory：重复名报装配错误；children/slots 是冻结快照；卸载 collapse 子槽', () => {
    const registry = new SlotRegistry()
    let notified = 0
    const offSubscribe = registry.subscribeFactory('card', () => {
      notified += 1
    })
    const off = registry.registerFactory(
      {
        name: 'card',
        children: { 'card.body': 'single' },
        slots: { head: { props: { title: '' } }, body: {} },
      },
      'definition',
    )
    expect(notified).toBe(1)
    expect(registry.factoryVersion('card')).toBe(1)

    const definition = registry.factory('card')
    expect(definition?.children).toEqual(['card.body'])
    expect(definition?.slots).toEqual(['head', 'body'])
    expect(Object.isFrozen(definition?.children)).toBe(true)
    expect(Object.isFrozen(definition?.slots)).toBe(true)
    expect(registry.spec('card.body')).toBe('single')

    expect(thrown(() => registry.registerFactory({ name: 'card' }, 'again'))).toBeInstanceOf(
      SlotAssemblyError,
    )
    expect(registry.factory('card')).toBe(definition)
    expect(registry.spec('card.body')).toBe('single')

    const offChild = register(registry, 'card.body', { id: 'row' }, 'row')
    off()
    expect(registry.factory('card')).toBeUndefined()
    expect(registry.spec('card.body')).toBeUndefined()
    expect(registry.entriesOf('card.body')).toEqual([])
    expect(notified).toBe(2)
    expect(registry.factoryVersion('card')).toBe(2)

    off()
    expect(notified).toBe(2)
    offChild()
    offSubscribe()
  })

  test('Factory 故障进同一本账但不摘共享定义', () => {
    const registry = new SlotRegistry()
    const off = registry.registerFactory({ name: 'card' }, 'definition')
    const definition = registry.factory('card')
    registry.reportFactoryFault('card', 'head', new Error('局部组件坏了'))
    expect(registry.faults.at(-1)).toMatchObject({
      slot: 'factory:card',
      id: 'head',
      phase: 'render',
    })
    expect(registry.factory('card')).toBe(definition)
    expect(registry.factoryVersion('card')).toBe(1)
    off()
  })

  test('席位按 handle 共享实例；最后一个持有者退订后归零；actions 走浅拷贝写入口', () => {
    const registry = new SlotRegistry()
    registry.declare('shell.main', 'list')
    const handle = defineStore<{ n: number }, { inc: (draft: { n: number }) => void }>({
      init: () => ({ n: 0 }),
      actions: {
        inc: (draft) => {
          draft.n += 1
        },
      },
    })

    expect(registry.seat(handle)).toBeUndefined()
    const offA = register(registry, 'shell.main', { id: 'a', store: handle }, 'a')
    const instance = registry.seat(handle)
    expect(instance).toBeDefined()
    expect(registry.seat(handle)).toBe(instance) // 懒建一次

    let notified = 0
    const offStore = instance?.subscribe(() => {
      notified += 1
    })
    instance?.actions.inc()
    expect(instance?.getSnapshot()).toEqual({ n: 1 })
    expect(notified).toBe(1)
    offStore?.()
    instance?.actions.inc()
    expect(notified).toBe(1)

    const offB = register(registry, 'shell.main', { id: 'b', priority: 1, store: handle }, 'b')
    expect(registry.seat(handle)).toBe(instance)
    offA()
    expect(registry.seat(handle)).toBe(instance)
    offB()
    expect(registry.seat(handle)).toBeUndefined()
  })
})

describe('插件面：createScopedSlotApi 的记账外壳', () => {
  test('声明 / 登记 / 等待都进账本，返回的就是账本函数；读面原样代理', () => {
    const registry = new SlotRegistry()
    registry.declare('shell.main', 'list')
    const wrappers: Array<() => void> = []
    const api = createScopedSlotApi(registry, (release) => {
      const wrapper = (): void => {
        release()
      }
      wrappers.push(wrapper)
      return wrapper
    })

    expect(api.slots).toEqual(['shell.main'])
    expect(api.spec('shell.main')).toBe('list')
    expect(api.spec('shell.nope')).toBeUndefined()

    const offRegister = api.register('shell.main', { id: 'panel' }, 'panel')
    expect(wrappers).toHaveLength(1)
    expect(offRegister).toBe(wrappers[0])
    expect(api.entriesOf('shell.main').map((entry) => entry.id)).toEqual(['panel'])
    expect(api.winners('shell.main').map((entry) => entry.id)).toEqual(['panel'])
    offRegister()
    expect(api.entriesOf('shell.main')).toEqual([])

    const offDeclare = api.declare('shell.extra', 'single')
    expect(wrappers).toHaveLength(2)
    expect(registry.spec('shell.extra')).toBe('single')
    offDeclare()
    expect(registry.spec('shell.extra')).toBeUndefined()

    let contributed = 0
    const offInject = api.injectSlot('shell.late', () => {
      contributed += 1
      return () => {
        contributed -= 1
      }
    })
    expect(wrappers).toHaveLength(3)
    const offLate = registry.declare('shell.late', 'single')
    expect(contributed).toBe(1)
    offInject()
    expect(contributed).toBe(0)
    offLate()
  })

  test('Factory 登记与席位读取也走同一条记账；defineUiPlugin 是恒等函数', () => {
    const registry = new SlotRegistry()
    registry.declare('shell.main', 'list')
    const wrappers: Array<() => void> = []
    const api = createScopedSlotApi(registry, (release) => {
      const wrapper = (): void => {
        release()
      }
      wrappers.push(wrapper)
      return wrapper
    })
    const handle = defineStore<{ n: number }, { bump: (draft: { n: number }) => void }>({
      init: () => ({ n: 0 }),
      actions: {
        bump: (draft) => {
          draft.n += 1
        },
      },
    })

    const offRegister = api.register('shell.main', { id: 'seat', store: handle }, 'seat')
    expect(api.seat(handle)).toBeDefined()

    const offFactory = api.registerFactory(
      { name: 'card', children: { 'card.body': 'single' } },
      'definition',
    )
    expect(wrappers).toHaveLength(2)
    expect(registry.factory('card')?.children).toEqual(['card.body'])
    offFactory()
    expect(registry.factory('card')).toBeUndefined()

    offRegister()
    expect(api.seat(handle)).toBeUndefined()

    const module = { apply: () => undefined }
    expect(defineUiPlugin(module)).toBe(module)
  })
})
