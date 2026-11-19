/**
 * 座位注册表与逐行订阅的口径（ui 层）。
 *
 * 来源：`scripts/ui-row-isolation-test.mjs` 第 [1]–[3] 段（差距清单 S2 的彻底方案，
 * 2026-11-10）。这条要守的不变量只有一句话：**一条 `Row` 只要它自己的内容和展开状态
 * 没变，就不重渲染、也不该被碰 DOM**。守它的零件在 `seat-store.ts` 的三份出口里：
 *
 * - [1] 注册表本体：按身份索引、内容等价复用旧对象、只通知变了的行、退订摘干净、跨会话不串；
 * - [2] 订阅：只喊登记过的那一格，退订把空集合从表里摘掉；
 * - [3] 判等函数：`sameRow` / `sameContent` 的判据（引用 / 深度相等 / at / live / stable）。
 *
 * 原探针第 [4] 段是源码形态钉（谁 memo、props 里有没有 Row、注释里有没有写清时序）——
 * 渲染体文本，不迁，归组件渲染批；其中「键就是 keyOf」这一条按行为迁：直接 import
 * `shared.ts` 的 `keyOf` 断言它的输出。原探针在 Node 里跑不了 shared.ts（它带着分轮与
 * 取词器的运行期依赖），ui project 的别名解析接得住。
 *
 * @module dsc-ui-transcript/ui/seat-store.spec
 */
import { describe, expect, test } from 'vitest'
import type { Row } from './shared.js'
import { keyOf } from './shared.js'
import { createSeatStore, sameContent, sameRow } from './seat-store.js'

/**
 * 一行测试数据。`entry` 的形状故意用最简单的纯 JSON：注册表只认数据，不认条目有几种。
 */
const rowOf = (over: Partial<Row> = {}): Row =>
  ({
    stable: 'r0:text:0',
    live: false,
    at: 1,
    entry: { kind: 'text', id: 1, text: '第一句' },
    ...over,
  }) as Row

/** 一份座位：一个前导行 + 一个轮，轮里两行。 */
const seatsOf = (roundRows: Row[]): Parameters<ReturnType<typeof createSeatStore>['stage']>[1] => ({
  leading: [rowOf({ stable: 'lead:system:0', at: 0, entry: { kind: 'system', id: 0, text: '开场' } })],
  rounds: [{ rows: roundRows }],
})

/**
 * 键的算法：注册表由调用方注入它（生产里递的就是 shared.ts 的 keyOf）。
 */
const keyOfForTest = (row: Row, sessionKey: string): string => keyOf(row, sessionKey)

// ── 注册表本体 ─────────────────────────────────────────────────────────────────

describe('createSeatStore：按身份索引、内容等价复用、只通知变了的行', () => {
  test('注册表有 stage / commit / row / subscribe / size / lastChanged 六个出口', () => {
    const store = createSeatStore(keyOfForTest)
    // 六个出口按名枚举：动态点名需要一份字符串键视图（`unknown` 先转，接口没有索引签名）。
    const exits = store as unknown as Record<string, unknown>
    for (const name of ['stage', 'commit', 'row', 'subscribe', 'size', 'lastChanged']) {
      expect(typeof exits[name], `出口 ${name}`).toBe('function')
    }
  })

  test('stage 之后渲染期就能读到行（render 与 commit 分两个阶段的前提），前导段也登记', () => {
    const store = createSeatStore(keyOfForTest)
    const first = rowOf()
    const second = rowOf({
      stable: 'r0:tool:0',
      at: 2,
      entry: { kind: 'tool', id: 2, call: { callId: 'c1', name: 'bash', argsText: '{}', status: 'done' } },
    })
    store.stage('s1', seatsOf([first, second]))
    expect(store.row(keyOfForTest(first, 's1'))?.at).toBe(1)
    expect(store.row(keyOfForTest(rowOf({ stable: 'lead:system:0', at: 0 }), 's1'))).toBeDefined()
    store.commit()
    // commit 之后行数 = 这一帧登记的行数（1 前导 + 2 座位）。
    expect(store.size()).toBe(3)
  })

  test('内容没变时复用上一帧的 Row 对象（引用相同 = 行体不重渲染）', () => {
    const store = createSeatStore(keyOfForTest)
    const first = rowOf()
    const secondEntry = { kind: 'tool', id: 2, call: { callId: 'c1', name: 'bash' } } as Row['entry']
    store.stage('s1', seatsOf([first, rowOf({ stable: 'r0:tool:0', at: 2, entry: secondEntry })]))
    store.commit()
    // 快照必须在 stage 之前取：stage 之后再读两次同一个键，两边都是新表里的同一格。
    const beforeReuse = store.row(keyOfForTest(first, 's1'))
    store.stage('s1', seatsOf([
      rowOf(),
      rowOf({ stable: 'r0:tool:0', at: 2, entry: secondEntry }),
    ]))
    const afterReuse = store.row(keyOfForTest(first, 's1'))
    expect(afterReuse === beforeReuse).toBe(true)
    expect(afterReuse?.stable).toBe(first.stable)
    store.commit()
    // 内容没变的一帧：一行都不通知。
    expect(store.lastChanged()).toBe(0)
  })

  test('全量锚帧（新对象、同内容）不通知任何行，行里留的仍是旧 entry（下游 memo 还能命中）', () => {
    const store = createSeatStore(keyOfForTest)
    const first = rowOf()
    const secondEntry = { kind: 'tool', id: 2, call: { callId: 'c1', name: 'bash' } } as Row['entry']
    store.stage('s1', seatsOf([first, rowOf({ stable: 'r0:tool:0', at: 2, entry: secondEntry })]))
    store.commit()
    const anchorEntry = { kind: 'text', id: 1, text: '第一句' } as Row['entry']
    store.stage('s1', seatsOf([rowOf({ entry: anchorEntry }), rowOf({ stable: 'r0:tool:0', at: 2, entry: secondEntry })]))
    store.commit()
    expect(store.lastChanged()).toBe(0)
    expect(store.row(keyOfForTest(first, 's1'))?.entry === first.entry).toBe(true)
  })

  test('内容真的变了：只通知这一行，行体读到新内容', () => {
    const store = createSeatStore(keyOfForTest)
    const first = rowOf()
    const secondEntry = { kind: 'tool', id: 2, call: { callId: 'c1', name: 'bash' } } as Row['entry']
    store.stage('s1', seatsOf([first, rowOf({ stable: 'r0:tool:0', at: 2, entry: secondEntry })]))
    store.commit()
    store.stage('s1', seatsOf([
      rowOf({ entry: { kind: 'text', id: 1, text: '第一句，多一个字' } as Row['entry'] }),
      rowOf({ stable: 'r0:tool:0', at: 2, entry: secondEntry }),
    ]))
    store.commit()
    expect(store.lastChanged()).toBe(1)
    expect(store.row(keyOfForTest(first, 's1'))?.entry).toMatchObject({ text: '第一句，多一个字' })
  })

  test('live 变了也通知（直播 → 定稿要重画光标与默认展开态）', () => {
    const store = createSeatStore(keyOfForTest)
    const first = rowOf()
    store.stage('s1', seatsOf([first]))
    store.commit()
    store.stage('s1', seatsOf([rowOf({ live: true, entry: first.entry })]))
    store.commit()
    expect(store.lastChanged()).toBeGreaterThanOrEqual(1)
  })

  test('at 变了也通知（否则行里留着过期下标），读到的是新下标', () => {
    const store = createSeatStore(keyOfForTest)
    const first = rowOf()
    store.stage('s1', seatsOf([first]))
    store.commit()
    store.stage('s1', seatsOf([rowOf({ live: true, at: 9, entry: first.entry })]))
    store.commit()
    expect(store.lastChanged()).toBe(1)
    expect(store.row(keyOfForTest(first, 's1'))?.at).toBe(9)
  })
})

// ── 订阅 ───────────────────────────────────────────────────────────────────────

describe('订阅：只喊登记过的那一格，退订摘干净', () => {
  test('这一帧没变不打扰、变了打扰一次、退订之后不再打扰', () => {
    const store = createSeatStore(keyOfForTest)
    const row = rowOf()
    store.stage('s1', seatsOf([row]))
    store.commit()
    const key = keyOfForTest(row, 's1')
    let calls = 0
    const off = store.subscribe(key, () => {
      calls += 1
    })
    // 订阅返回一个函数（卸载时由 useSyncExternalStore 的 cleanup 调用）。
    expect(typeof off).toBe('function')

    store.stage('s1', seatsOf([rowOf()]))
    store.commit()
    expect(calls).toBe(0)

    store.stage('s1', seatsOf([rowOf({ entry: { kind: 'text', id: 1, text: '变了' } as Row['entry'] })]))
    store.commit()
    expect(calls).toBe(1)

    off()
    store.stage('s1', seatsOf([rowOf({ entry: { kind: 'text', id: 1, text: '又变了' } as Row['entry'] })]))
    store.commit()
    expect(calls).toBe(1)
  })

  test('退订把空的订阅集合一起摘掉（注册表不会越攒越大）', () => {
    const store = createSeatStore(keyOfForTest)
    const row = rowOf()
    store.stage('s1', seatsOf([row]))
    store.commit()
    const key = keyOfForTest(row, 's1')
    let calls = 0
    const off = store.subscribe(key, () => {
      calls += 1
    })
    off()
    store.stage('s1', seatsOf([rowOf({ entry: { kind: 'text', id: 1, text: '第三变' } as Row['entry'] })]))
    store.commit()
    expect(calls).toBe(0)
  })

  test('同一帧 stage 两次（React 严格模式的双次渲染）收敛到同一份结果', () => {
    const doubled = createSeatStore(keyOfForTest)
    doubled.stage('s1', seatsOf([rowOf()]))
    doubled.stage('s1', seatsOf([rowOf()]))
    doubled.commit()
    // 首帧登记 2 行（1 前导 + 1 座位），一行不多一行不少。
    expect(doubled.lastChanged()).toBe(2)
    doubled.stage('s1', seatsOf([rowOf()]))
    doubled.stage('s1', seatsOf([rowOf()]))
    doubled.commit()
    // 同一帧 stage 两次之后再提交：一行都不通知（双次渲染不制造假变动）。
    expect(doubled.lastChanged()).toBe(0)
  })

  test('没登记过就 commit 是空操作（不会把上一帧的表清空）', () => {
    const empty = createSeatStore(keyOfForTest)
    empty.commit()
    expect(empty.size()).toBe(0)
    expect(empty.lastChanged()).toBe(0)
  })

  test('这一帧没登记的行（被分页切走 / 整轮消失）连格子与订阅位一起被摘掉', () => {
    const gone = createSeatStore(keyOfForTest)
    const survivor = rowOf()
    const vanishing = rowOf({ stable: 'r0:text:1', at: 5 })
    gone.stage('s1', seatsOf([survivor, vanishing]))
    gone.commit()
    let goneCalls = 0
    gone.subscribe(keyOfForTest(vanishing, 's1'), () => {
      goneCalls += 1
    })
    gone.stage('s1', seatsOf([survivor]))
    gone.commit()
    // size 跟着降（只剩前导 + 1 座位），消失的行不会再收到通知。
    expect(gone.size()).toBe(2)
    expect(gone.row(keyOfForTest(vanishing, 's1'))).toBeUndefined()
    expect(goneCalls).toBe(0)
  })

  test('切会话：上一条会话的格子被摘掉，同一 stable 不共用对象（内容一样也不借）', () => {
    const cross = createSeatStore(keyOfForTest)
    cross.stage('s1', seatsOf([rowOf()]))
    cross.commit()
    const fromS1 = cross.row(keyOfForTest(rowOf(), 's1'))
    cross.stage('s2', seatsOf([rowOf()]))
    cross.commit()
    const fromS2 = cross.row(keyOfForTest(rowOf(), 's2'))
    expect(cross.row(keyOfForTest(rowOf(), 's1'))).toBeUndefined()
    expect(fromS1 !== fromS2 && fromS1 !== undefined && fromS2 !== undefined).toBe(true)
    // 现役表只剩这一帧登记的行（前导 + 座位 = 2）。
    expect(cross.size()).toBe(2)
  })
})

// ── 判等函数 ───────────────────────────────────────────────────────────────────

describe('sameContent：什么算「同一份内容」', () => {
  test('认引用相等', () => {
    const value = { a: 1 }
    expect(sameContent(value, value)).toBe(true)
  })
  test('认嵌套对象与数组的深相等', () => {
    expect(sameContent({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
  })
  test('值不同就不同', () => {
    expect(sameContent({ a: 2 }, { a: 1 })).toBe(false)
  })
  test('数组长度不同就不同', () => {
    expect(sameContent([1, 2], [1])).toBe(false)
  })
  test('数组与对象不互认', () => {
    expect(sameContent([], {})).toBe(false)
  })
  test('少一个键就算不同（条件展开的字段缺了不能当没变）', () => {
    expect(sameContent({ a: 1 }, { a: 1, b: undefined })).toBe(false)
  })
  test('把 null 与对象分开', () => {
    expect(sameContent(null, {})).toBe(false)
  })
  test('认原始值的严格相等（NaN 之外）', () => {
    expect(sameContent(1, 1)).toBe(true)
    expect(sameContent('a', 'b')).toBe(false)
  })
})

describe('sameRow：什么算「同一行」', () => {
  const base = rowOf()

  test('同一个对象算同一行', () => {
    expect(sameRow(base, base)).toBe(true)
  })
  test('换对象、内容相同算同一行（全量锚帧那条路）', () => {
    expect(sameRow(base, { ...base, entry: { ...base.entry } })).toBe(true)
  })
  test('正文变了不算', () => {
    // 同 stable / live / at、entry 内容不同：判等必须在 entry 深度相等那一步拦住。
    expect(
      sameRow(base, rowOf({ stable: base.stable, live: base.live, at: base.at, entry: { kind: 'text', id: 1, text: '别的话' } })),
    ).toBe(false)
  })
  test('live 变了不算（直播 → 定稿要重画）', () => {
    expect(sameRow(base, { ...base, live: true })).toBe(false)
  })
  test('at 变了不算（历史分页会让下标漂）', () => {
    expect(sameRow(base, { ...base, at: base.at + 1 })).toBe(false)
  })
  test('stable 变了不算（轮内身份换了就是另一行）', () => {
    expect(sameRow(base, { ...base, stable: 'r0:text:1' })).toBe(false)
  })
  test('不把「工具卡条目的 call 深一层」漏掉（callId 换了要重画）', () => {
    expect(
      sameRow(
        rowOf({ entry: { kind: 'tool', id: 2, call: { callId: 'a', name: 'bash', argsText: '{}', status: 'done' } } }),
        rowOf({ entry: { kind: 'tool', id: 2, call: { callId: 'b', name: 'bash', argsText: '{}', status: 'done' } } }),
      ),
    ).toBe(false)
  })
})

// ── 键的算法（原探针 [4] 段里唯一可行为化的一条） ──────────────────────────────

describe('keyOf：会话标识 + 行的稳定身份', () => {
  test('键形如 `会话|stable`，切会话不串键', () => {
    const row = rowOf()
    expect(keyOf(row, 's1')).toBe('s1|r0:text:0')
    expect(keyOf(row, 's2')).toBe('s2|r0:text:0')
    expect(keyOf(rowOf({ stable: 'r0:call:c1' }), 's1')).toBe('s1|r0:call:c1')
  })
})
