/**
 * 槽位核心的运行期行为：声明/注册/排序/取赢家/引用稳定性/退订/报错，外加 D3 席位与
 * D2 Factory（迁自 `scripts/ui-plugin-test.mjs` 的 [1][7][8] 三段）。
 *
 * ## 被测的是什么
 *
 * - `@pneuma/ui-core/slots` 的 `SlotRegistry`：四形态（single / list / keyed / chain）、
 *   遮蔽、子槽 + `injectSlot` 等待、按槽的版本号、崩溃退位（faults）、chain 选举。
 *   引用稳定性单独钉——它挂了的表现是界面无限重渲染，最难查。
 * - `@pneuma/ui-core/store` 的 `defineStore`：懒建、共享席位、draft 烘干、释放。
 * - Factory 注册表：children 进声明表、重复注册抛装配错、故障进同一本账、卸载 collapse。
 *
 * ## 落位与隔离
 *
 * 全部是进程内逻辑，不起内核、不开端口；落 integration 是因为这批断言原来是宿主装配
 * 探针（ui-plugin-test）的一部分，随本批一起进来，落点跟着族走。夹具只用局部对象，
 * 不碰磁盘与 HOME。
 *
 * ## 与探针的对应
 *
 * 探针用 `check()` 计数，这里一条 `check` 对应一个 `test`；线性场景（注册 → 断言 →
 * 再注册 → 再断言）的中间态在 `beforeAll` 里按原次序跑完、逐项记下，用例只读记录——
 * 次序语义保真，失败信息也比一整段脚本好看。
 *
 * @module dsc/tests/integration/ui-plugin-slots
 */
import { beforeAll, describe, expect, test } from 'vitest'
import {
  ChainSlotSelectError,
  DuplicateSlotError,
  KeyedSlotKeyError,
  SlotAssemblyError,
  SlotKindConflictError,
  SlotRegistry,
  UndeclaredSlotError,
  type SlotEntry,
  type SlotFault,
} from '@pneuma/ui-core/slots.js'
import { defineStore, type SeatInstance, type StoreHandle } from '@pneuma/ui-core/store.js'

/** 线性场景里记一条事实的口袋：beforeAll 跑流程，test 只读记录。 */
type Fact = { value: unknown; note?: string }

/** 取条目 id 列表的便捷读法（探针同款 join 口径）。 */
const idsOf = (entries: readonly SlotEntry<unknown>[]): string[] => entries.map((entry) => entry.id)

/**
 * 显式走擦除签名的 register：chain 槽的 `select` 与 D3 席位场景的组件不收窄成公开重载的
 * 形状（开放表 `SlotMapLike` 本来就是「不做类型检查」的那份，探针是 JS 直写）。落实现签名，
 * 不在调用点各撒一个 `as never`。
 */
function registerErased(registry: SlotRegistry, slot: string, options: object, component: unknown): () => void {
  // bind 是必需的：方法引用离开实例会丢 this（register 实现第一行就读 this.kinds）。
  const erased = registry.register.bind(registry) as (slot: string, options: object, component: unknown) => () => void
  return erased(slot, options, component)
}

// ── [1a] 主注册表：声明 / 排序 / 引用稳定性 / 退订 ─────────────────────────────
describe('槽位核心：主注册表的声明与登记', () => {
  /** 逐项记录（键 = 探针里那条 check 的语义）。 */
  const f: Record<string, Fact> = {}
  /** 主注册表与流程里用到的句柄。 */
  let slots: SlotRegistry
  let snapshotA: readonly SlotEntry<unknown>[]
  let notified = 0

  beforeAll(() => {
    slots = new SlotRegistry()
    const offMain = slots.declare('shell.main', 'list')
    f.visible = { value: slots.slots.join(',') }
    f.emptyEntries = { value: slots.entriesOf('shell.main').length }
    f.emptyWinners = { value: slots.winners('shell.main').length }

    let throws: unknown = null
    try {
      registerErased(slots, 'shell.nope', { id: 'x' }, {})
    } catch (error) {
      throws = error
    }
    f.undeclared = { value: throws instanceof UndeclaredSlotError, note: String(throws) }
    f.undeclaredMessage = { value: throws instanceof Error ? throws.message.includes('shell.main') : false, note: String(throws) }

    const before = slots.getVersion()
    const offLate = registerErased(slots, 'shell.main', { id: 'late', order: 20 }, 'late')
    registerErased(slots, 'shell.main', { id: 'early', order: 5 }, 'early')
    registerErased(slots, 'shell.main', { id: 'mid-a', order: 10 }, 'mid-a')
    registerErased(slots, 'shell.main', { id: 'mid-b', order: 10 }, 'mid-b')
    f.versionGrows = { value: slots.getVersion() > before }
    f.sorted = { value: idsOf(slots.entriesOf('shell.main')).join(','), note: 'early,mid-a,mid-b,late' }
    f.size = { value: slots.size }

    snapshotA = slots.winners('shell.main')
    const snapshotB = slots.winners('shell.main')
    f.snapshotStable = { value: snapshotA === snapshotB }
    registerErased(slots, 'shell.main', { id: 'later', order: 30 }, 'later')
    f.snapshotReplaced = { value: slots.winners('shell.main') !== snapshotA }

    let duplicate: unknown = null
    try {
      registerErased(slots, 'shell.main', { id: 'early' }, 'dup')
    } catch (error) {
      duplicate = error
    }
    f.duplicate = { value: duplicate instanceof DuplicateSlotError, note: String(duplicate) }
    f.duplicateMessage = {
      value: duplicate instanceof Error && duplicate.message.includes('early') && duplicate.message.includes('priority'),
      note: duplicate instanceof Error ? duplicate.message : '',
    }

    let declaredTwice: unknown = null
    try {
      slots.declare('shell.main', 'keyed')
    } catch (error) {
      declaredTwice = error
    }
    f.kindConflict = { value: declaredTwice instanceof SlotKindConflictError, note: String(declaredTwice) }
    const offAgain = slots.declare('shell.main', 'list')
    f.redeclareOk = { value: slots.slots.includes('shell.main') }
    offAgain()

    const offSub = slots.subscribe(() => {
      notified += 1
    })
    offLate()
    f.offRemovesEntry = { value: !slots.entriesOf('shell.main').some((entry) => entry.id === 'late') }
    f.offNotifies = { value: notified }
    offSub()
    const afterUnsubscribe = notified
    registerErased(slots, 'shell.main', { id: 'noisy', order: 40 }, 'noisy')
    f.offStopsNotify = { value: notified === afterUnsubscribe, note: String(notified) }
    offMain()
    f.undeclaredGone = { value: !slots.slots.includes('shell.main') }
  })

  test('声明后槽名可见', () => {
    expect(f.visible?.value).toBe('shell.main')
  })
  test('未声明时取登记为空', () => {
    expect(f.emptyEntries?.value).toBe(0)
  })
  test('未声明时取赢家为空', () => {
    expect(f.emptyWinners?.value).toBe(0)
  })
  test('注册到未声明的槽当场报错', () => {
    expect(f.undeclared?.value, f.undeclared?.note).toBe(true)
  })
  test('报错消息里带上已知槽名', () => {
    expect(f.undeclaredMessage?.value, f.undeclaredMessage?.note).toBe(true)
  })
  test('版本号随登记单调递增', () => {
    expect(f.versionGrows?.value).toBe(true)
  })
  test('list 槽按 order 排序、持平时按注册先后', () => {
    expect(f.sorted?.value, String(f.sorted?.value)).toBe('early,mid-a,mid-b,late')
  })
  test('注册总数正确', () => {
    expect(f.size?.value).toBe(4)
  })
  test('winners 引用稳定（React 快照要求）', () => {
    expect(f.snapshotStable?.value).toBe(true)
  })
  test('登记后快照换引用', () => {
    expect(f.snapshotReplaced?.value).toBe(true)
  })
  test('同一个格子同 priority 重复报错', () => {
    expect(f.duplicate?.value, f.duplicate?.note).toBe(true)
  })
  test('重复报错里点名占位者并给出改法', () => {
    expect(f.duplicateMessage?.value, f.duplicateMessage?.note).toBe(true)
  })
  test('同一个槽声明成两种形态报错', () => {
    expect(f.kindConflict?.value, f.kindConflict?.note).toBe(true)
  })
  test('同形态重复声明合法（引用计数 +1）', () => {
    expect(f.redeclareOk?.value).toBe(true)
  })
  test('退订后登记消失', () => {
    expect(f.offRemovesEntry?.value).toBe(true)
  })
  test('退订触发了订阅者', () => {
    expect(f.offNotifies?.value).toBe(1)
  })
  test('退订后不再收到通知', () => {
    expect(f.offStopsNotify?.value, f.offStopsNotify?.note).toBe(true)
  })
  test('撤回声明后槽名消失', () => {
    expect(f.undeclaredGone?.value).toBe(true)
  })
})

// ── [1b] single / keyed / 遮蔽 ────────────────────────────────────────────────
describe('single 与 keyed 槽', () => {
  test('single 槽只画一条（priority 小的胜）', () => {
    const single = new SlotRegistry()
    single.declare('shell.notice', 'single')
    registerErased(single, 'shell.notice', { id: 'a', order: 1 }, 'a')
    registerErased(single, 'shell.notice', { id: 'b', order: 2, priority: 1 }, 'b')
    expect(single.winners('shell.notice').map((entry) => entry.id).join(',')).toBe('a')
  })

  test('keyed 槽每格只取一条', () => {
    const keyed = new SlotRegistry()
    keyed.declare('tool.call', 'keyed')
    registerErased(keyed, 'tool.call', { id: 'read-impl', key: 'read', order: 1 }, 'read-1')
    registerErased(keyed, 'tool.call', { id: 'read-other', key: 'read', order: 2, priority: 1 }, 'read-2')
    registerErased(keyed, 'tool.call', { id: 'write-impl', key: 'write', order: 1 }, 'write')
    expect(keyed.winners('tool.call').map((entry) => entry.id).join(',')).toBe('read-impl,write-impl')
  })

  test('同 id 不同 priority 是合法替换（小者胜）', () => {
    const shadow = new SlotRegistry()
    shadow.declare('tool.card', 'list')
    registerErased(shadow, 'tool.card', { id: 'builtin', order: 1 }, 'builtin')
    registerErased(shadow, 'tool.card', { id: 'builtin', order: 1, priority: -1 }, 'override')
    expect(shadow.winners('tool.card').map((entry) => entry.component).join(',')).toBe('override')
  })

  test('被遮蔽的那份仍在登记表里（诊断看得见）', () => {
    const shadow = new SlotRegistry()
    shadow.declare('tool.card', 'list')
    registerErased(shadow, 'tool.card', { id: 'builtin', order: 1 }, 'builtin')
    registerErased(shadow, 'tool.card', { id: 'builtin', order: 1, priority: -1 }, 'override')
    expect(shadow.entriesOf('tool.card').length).toBe(2)
  })

  test('keyed 槽没给 key 当场报错', () => {
    const keyless = new SlotRegistry()
    keyless.declare('tool.call', 'keyed')
    expect(() => registerErased(keyless, 'tool.call', { id: 'x' }, 'x')).toThrow(KeyedSlotKeyError)
  })
})

// ── [1c] 子槽 + injectSlot：贡献者可比声明者先加载 ─────────────────────────────
describe('子槽与 injectSlot 的等待语义', () => {
  const f: Record<string, Fact> = {}
  let nested: SlotRegistry

  beforeAll(() => {
    nested = new SlotRegistry()
    nested.declare('shell.main', 'list')
    let echoes = 0
    const offWait = nested.injectSlot('card.footer', () => {
      echoes += 1
      return registerErased(nested, 'card.footer', { id: 'echo' }, 'echo')
    })
    f.waitQuiet = { value: echoes }
    const offCard = registerErased(nested, 'shell.main', { id: 'card', children: { 'card.footer': 'list' } }, 'card')
    f.woken = { value: echoes }
    f.childContributed = { value: nested.winners('card.footer').map((entry) => entry.component).join(',') }
    f.childrenRemembered = {
      value: nested.entriesOf('shell.main')[0]?.children.join(','),
      note: 'card.footer',
    }
    offCard()
    f.childGone = { value: nested.spec('card.footer') }
    nested.declare('card.footer', 'list')
    f.redeclared = { value: echoes }
    offWait()
  })

  test('等一个还没声明的槽不会跑贡献', () => {
    expect(f.waitQuiet?.value).toBe(0)
  })
  test('声明者一登记，等待者就被叫醒', () => {
    expect(f.woken?.value).toBe(1)
  })
  test('子槽里出现了贡献', () => {
    expect(f.childContributed?.value).toBe('echo')
  })
  test('条目记住了自己声明的子槽', () => {
    expect(f.childrenRemembered?.value, String(f.childrenRemembered?.value)).toBe('card.footer')
  })
  test('声明者退订后子槽消失', () => {
    expect(f.childGone?.value).toBeUndefined()
  })
  test('槽重新声明时等待者再贡献一次', () => {
    expect(f.redeclared?.value).toBe(2)
  })

  test('同名同形态的子槽可被多份登记共享', () => {
    const shared = new SlotRegistry()
    shared.declare('shell.main', 'list')
    registerErased(shared, 'shell.main', { id: 'c1', children: { 'list.footer': 'list' } }, 'c1')
    registerErased(shared, 'shell.main', { id: 'c2', children: { 'list.footer': 'list' } }, 'c2')
    expect(shared.spec('list.footer')).toBe('list')
  })

  test('同名不同形态的子槽报错', () => {
    const shared = new SlotRegistry()
    shared.declare('shell.main', 'list')
    registerErased(shared, 'shell.main', { id: 'c1', children: { 'list.footer': 'list' } }, 'c1')
    expect(() =>
      registerErased(shared, 'shell.main', { id: 'c3', children: { 'list.footer': 'single' } }, 'c3'),
    ).toThrow(SlotKindConflictError)
  })
})

// ── [1d] 按槽的版本号：一次登记不许放大成整页重渲染 ────────────────────────────
describe('按槽的版本号与快照隔离', () => {
  test('登记 b 不动 a 的版本号', () => {
    const isolated = new SlotRegistry()
    isolated.declare('a', 'list')
    isolated.declare('b', 'list')
    registerErased(isolated, 'a', { id: 'x' }, 'x')
    const versionA = isolated.version('a')
    registerErased(isolated, 'b', { id: 'y' }, 'y')
    expect(isolated.version('a')).toBe(versionA)
  })

  test('登记 b 不让 a 的快照换引用', () => {
    const isolated = new SlotRegistry()
    isolated.declare('a', 'list')
    isolated.declare('b', 'list')
    registerErased(isolated, 'a', { id: 'x' }, 'x')
    const snapshotA2 = isolated.winners('a')
    registerErased(isolated, 'b', { id: 'y' }, 'y')
    expect(isolated.winners('a')).toBe(snapshotA2)
  })

  test('全局版本号仍然前进（诊断区靠它）', () => {
    const isolated = new SlotRegistry()
    isolated.declare('a', 'list')
    registerErased(isolated, 'a', { id: 'x' }, 'x')
    expect(isolated.getVersion()).toBeGreaterThan(0)
  })
})

// ── [1e] 崩溃退位（single 槽的 fault 记账） ───────────────────────────────────
describe('崩溃退位：格子里的下一名顶上，故障记下来给诊断看', () => {
  const f: Record<string, Fact> = {}

  beforeAll(() => {
    const healing = new SlotRegistry()
    healing.declare('notice', 'single')
    registerErased(healing, 'notice', { id: 'first' }, 'first')
    registerErased(healing, 'notice', { id: 'second', priority: 1 }, 'second')
    f.beforeFault = { value: healing.winners('notice')[0]?.component }
    const recorded: SlotFault[] = []
    const offFault = healing.onFault((fault) => recorded.push(fault))
    healing.reportFault(
      healing.entriesOf('notice').find((entry) => entry.component === 'first') as SlotEntry<unknown>,
      new Error('炸了'),
    )
    f.afterFault = { value: healing.winners('notice')[0]?.component }
    f.faultRecorded = { value: recorded.length === 1 && recorded[0]?.phase === 'render', note: JSON.stringify(recorded) }
    f.faultTable = { value: healing.faults.length }
    f.noResurrect = { value: healing.winners('notice').length }
    offFault()
  })

  test('退位前画 priority 小的那个', () => {
    expect(f.beforeFault?.value).toBe('first')
  })
  test('崩过的条目退位，下一名顶上', () => {
    expect(f.afterFault?.value).toBe('second')
  })
  test('故障被记录并广播', () => {
    expect(f.faultRecorded?.value, f.faultRecorded?.note).toBe(true)
  })
  test('故障表可读（诊断区用）', () => {
    expect(f.faultTable?.value).toBe(1)
  })
  test('退位是一次性的（不自动复活）', () => {
    expect(f.noResurrect?.value).toBe(1)
  })
})

// ── [1f] chain：条目自己选举（第四形态） ──────────────────────────────────────
describe('chain 槽的选举', () => {
  /** 造一条带内置 + 接管者的链（探针同款）。 */
  function makeChain(): SlotRegistry {
    const chain = new SlotRegistry()
    chain.declare('tool.view', 'chain')
    registerErased(chain, 'tool.view', { id: 'builtin', priority: 100, select: (owner: { name: string }) => ({ verb: owner.name }) }, 'builtin')
    registerErased(chain, 'tool.view', { id: 'hijack', priority: 1, select: (owner: { name: string }) => (owner.name === 'bash' ? '接管' : null) }, 'hijack')
    return chain
  }

  test('chain 槽没给 select 当场报错', () => {
    const chain = new SlotRegistry()
    chain.declare('tool.view', 'chain')
    expect(() => registerErased(chain, 'tool.view', { id: 'no-select' }, 'no-select')).toThrow(ChainSlotSelectError)
  })

  test('认领者赢过 catch-all（priority 小者先问）', () => {
    const chain = makeChain()
    expect(chain.elect('tool.view', { name: 'bash' })?.entry.id).toBe('hijack')
  })

  test('弃权（null）问下一位', () => {
    const chain = makeChain()
    expect(chain.elect('tool.view', { name: 'read' })?.entry.id).toBe('builtin')
  })

  test('matched 原样透传', () => {
    const chain = makeChain()
    expect((chain.elect('tool.view', { name: 'read' })?.matched as { verb?: string } | undefined)?.verb).toBe('read')
  })

  test('priority 最小的弃权不挡后面的当选', () => {
    const chain = makeChain()
    registerErased(chain, 'tool.view', { id: 'picky', priority: 0, select: () => null }, 'picky')
    expect(chain.elect('tool.view', { name: 'read' })?.entry.id).toBe('builtin')
  })

  test('全员弃权返回 null', () => {
    const shy = new SlotRegistry()
    shy.declare('tool.view', 'chain')
    registerErased(shy, 'tool.view', { id: 'picky', priority: 0, select: () => null }, 'picky')
    expect(shy.elect('tool.view', { name: 'read' })).toBeNull()
  })

  test('chain 同 priority 并存不报冲突', () => {
    const tied = new SlotRegistry()
    tied.declare('tool.view', 'chain')
    registerErased(tied, 'tool.view', { id: 'first', priority: 5, select: () => 'a' }, 'first')
    registerErased(tied, 'tool.view', { id: 'second', priority: 5, select: () => 'b' }, 'second')
    expect(tied.entriesOf('tool.view').length).toBe(2)
  })

  test('同 priority 按注册序先问', () => {
    const tied = new SlotRegistry()
    tied.declare('tool.view', 'chain')
    registerErased(tied, 'tool.view', { id: 'first', priority: 5, select: () => 'a' }, 'first')
    registerErased(tied, 'tool.view', { id: 'second', priority: 5, select: () => 'b' }, 'second')
    expect(tied.elect('tool.view', {})?.entry.id).toBe('first')
  })

  test('当选者退位后选举落到下一位', () => {
    const chainHealing = new SlotRegistry()
    chainHealing.declare('tool.view', 'chain')
    registerErased(chainHealing, 'tool.view', { id: 'cranky', priority: 1, select: () => 'x' }, 'cranky')
    registerErased(chainHealing, 'tool.view', { id: 'backup', priority: 2, select: () => 'y' }, 'backup')
    chainHealing.reportFault(
      chainHealing.entriesOf('tool.view').find((entry) => entry.id === 'cranky') as SlotEntry<unknown>,
      new Error('渲染炸了'),
    )
    expect(chainHealing.elect('tool.view', {})?.entry.id).toBe('backup')
  })

  test('抛异常的选择器视同弃权', () => {
    const rotten = new SlotRegistry()
    rotten.declare('tool.view', 'chain')
    registerErased(rotten, 'tool.view', { id: 'throws', priority: 1, select: () => { throw new Error('选择器有 bug') } }, 'throws')
    registerErased(rotten, 'tool.view', { id: 'fine', priority: 2, select: () => 'ok' }, 'fine')
    expect(rotten.elect('tool.view', {})?.entry.id).toBe('fine')
  })

  test('坏选择器被记故障并退位', () => {
    const rotten = new SlotRegistry()
    rotten.declare('tool.view', 'chain')
    const rottenFaults: SlotFault[] = []
    rotten.onFault((fault) => rottenFaults.push(fault))
    registerErased(rotten,
      'tool.view',
      {
        id: 'throws',
        priority: 1,
        select: () => {
          throw new Error('选择器有 bug')
        },
      },
      'throws',
    )
    registerErased(rotten, 'tool.view', { id: 'fine', priority: 2, select: () => 'ok' }, 'fine')
    void rotten.elect('tool.view', {})
    expect(rottenFaults.length === 1 && rotten.entriesOf('tool.view').length === 2).toBe(true)
  })

  test('对非 chain 槽 elect 抛装配错误', () => {
    const chain = makeChain()
    expect(() => chain.elect('shell.main', {})).toThrow()
  })

  test('winners 对 chain 返回全部幸存候选人', () => {
    const chain = makeChain()
    registerErased(chain, 'tool.view', { id: 'picky', priority: 0, select: () => null }, 'picky')
    expect(chain.winners('tool.view').length).toBe(3)
  })
})

// ── [7] D3 席位：共享实例 / 懒建 / 释放 / 浅拷贝口径 ───────────────────────────
describe('D3 席位（defineStore）', () => {
  const f: Record<string, Fact> = {}
  let offA: () => void
  let offB: () => void
  let instance: SeatInstance<{ list: string[]; nested: { n: number } }, { setList: (draft: { list: string[] }, list: string[]) => void }>
  let counted: StoreHandle<{ list: string[]; nested: { n: number } }, { setList: (draft: { list: string[] }, list: string[]) => void }>
  let slots: SlotRegistry
  let creates: number

  beforeAll(() => {
    slots = new SlotRegistry()
    slots.declare('probe.one', 'list')
    slots.declare('probe.two', 'list')
    const seat = defineStore<{ list: string[]; nested: { n: number } }, { setList: (draft: { list: string[] }, list: string[]) => void }>({
      init: () => ({ list: [], nested: { n: 1 } }),
      actions: {
        setList: (draft, list) => {
          draft.list = list
        },
      },
    })

    creates = 0
    counted = { spec: seat.spec, create: () => ((creates += 1), seat.create()) }
    offA = registerErased(slots, 'probe.one', { id: 'a', store: counted }, 'A')
    f.lazy = { value: creates }

    offB = registerErased(slots, 'probe.two', { id: 'b', store: counted }, 'B')
    instance = slots.seat(counted) as typeof instance
    f.createdOnRead = { value: creates }
    f.shared = { value: instance !== undefined && instance === slots.seat(counted) }

    const before = instance.getSnapshot()
    instance.actions.setList(['x'])
    const after = instance.getSnapshot()
    f.draftBaked = { value: after.list.join(',') }
    f.topRefChanged = { value: before !== after }
    f.nestedKept = { value: before.nested === after.nested }

    let hits = 0
    const off = instance.subscribe(() => {
      hits += 1
    })
    instance.set({ ...after, list: ['y'] })
    f.notified = { value: hits }
    off()
    instance.set({ ...after, list: ['z'] })
    f.offQuiet = { value: hits }
  })

  test('register 不建实例（懒建）', () => {
    expect(f.lazy?.value).toBe(0)
  })
  test('首次渲染读才建实例', () => {
    expect(f.createdOnRead?.value).toBe(1)
  })
  test('两个登记共享同一个实例', () => {
    expect(f.shared?.value).toBe(true)
  })
  test('actions 只收业务实参（draft 已烘掉）', () => {
    expect(f.draftBaked?.value).toBe('x')
  })
  test('写入换顶层引用（React 快照比较成立）', () => {
    expect(f.topRefChanged?.value).toBe(true)
  })
  test('浅拷贝口径：未触碰的嵌套值按引用保留', () => {
    expect(f.nestedKept?.value).toBe(true)
  })
  test('订阅收到写入', () => {
    expect(f.notified?.value).toBe(1)
  })
  test('退订后不再通知', () => {
    expect(f.offQuiet?.value).toBe(1)
  })

  test('还有持有者时席位仍在', () => {
    expect(slots.seat(counted)).toBeDefined()
  })

  test('最后一个持有者卸载后席位释放', () => {
    offA()
    expect(slots.seat(counted)).toBeDefined()
    offB()
    expect(slots.seat(counted)).toBeUndefined()
  })

  test('未登记过的 handle 读不到席位', () => {
    const fresh = defineStore<{ list: string[]; nested: { n: number } }, Record<string, never>>({
      init: () => ({ list: [], nested: { n: 0 } }),
      actions: {},
    })
    expect(slots.seat(fresh as unknown as typeof counted)).toBeUndefined()
  })
})

// ── [8] D2 Factory：定义账 / children 进声明表 / 卸载 collapse / 故障记账 ───────
describe('D2 Factory（registerFactory）', () => {
  const f: Record<string, Fact> = {}
  let versions: number
  let definition: () => () => void
  let slots: SlotRegistry

  beforeAll(() => {
    slots = new SlotRegistry()
    slots.declare('probe.main', 'list')
    definition = () =>
      slots.registerFactory(
        { name: 'probe.card', children: { 'probe.card.footer': 'list' }, slots: { a: {}, b: {} } },
        () => null,
      )

    versions = 0
    const offSub = slots.subscribeFactory('probe.card', () => {
      versions += 1
    })
    const off = definition()
    f.childrenDeclared = { value: slots.spec('probe.card.footer') }
    f.factorySlots = { value: slots.factory('probe.card')?.slots.join(',') }
    f.definedNotifies = { value: versions === 1 && slots.factoryVersion('probe.card') === 1 }

    let duplicate: unknown = null
    try {
      definition()
    } catch (error) {
      duplicate = error
    }
    f.duplicateThrows = { value: duplicate instanceof SlotAssemblyError && duplicate.message.includes('probe.card'), note: String(duplicate) }
    f.duplicateKeepsChildren = { value: slots.spec('probe.card.footer') }

    slots.reportFactoryFault('probe.card', 'a', new Error('局部组件炸了'))
    const fault = slots.faults.at(-1)
    f.factoryFault = {
      value: fault?.slot === 'factory:probe.card' && fault?.id === 'a' && slots.factory('probe.card') !== undefined,
      note: JSON.stringify(fault),
    }

    off()
    f.collapsed = {
      value: slots.factory('probe.card') === undefined && slots.spec('probe.card.footer') === undefined,
      note: String(slots.spec('probe.card.footer')),
    }
    f.offNotifies = { value: versions }

    const offAgain = definition()
    f.reRegisterable = { value: slots.factory('probe.card') !== undefined }
    offAgain()
    offSub()
  })

  test('Factory 注册后 children 进声明表（形态正确）', () => {
    expect(f.childrenDeclared?.value, String(f.childrenDeclared?.value)).toBe('list')
  })
  test('读得到定义与声明的局部位置', () => {
    expect(f.factorySlots?.value).toBe('a,b')
  })
  test('定义注册通知订阅者（版本 +1）', () => {
    expect(f.definedNotifies?.value).toBe(true)
  })
  test('同名第二次注册抛装配错误（人话里带名字）', () => {
    expect(f.duplicateThrows?.value, f.duplicateThrows?.note).toBe(true)
  })
  test('重复注册失败不留下多余的子槽声明', () => {
    expect(f.duplicateKeepsChildren?.value).toBe('list')
  })
  test('Factory 故障进同一本故障账（slot 记 factory:<名>），定义不摘除', () => {
    expect(f.factoryFault?.value, f.factoryFault?.note).toBe(true)
  })
  test('卸载后定义消失、children 递归 collapse', () => {
    expect(f.collapsed?.value, f.collapsed?.note).toBe(true)
  })
  test('定义卸载也通知订阅者', () => {
    expect(f.offNotifies?.value).toBe(2)
  })
  test('卸载后同一个名字可以重新注册', () => {
    expect(f.reRegisterable?.value).toBe(true)
  })
})
