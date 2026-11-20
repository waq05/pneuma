/**
 * Super Agent 视图投影的补盲（`packages/ui-superagent/ui/state.ts`）：
 * 阶段解析的 working/ended/未知档、来源与设置历史的脏值过滤、计数里的 done 组，
 * 以及两个指纹（来源、设置历史）在「缺席 / 空 / 有内容」三种形状下的比较。
 *
 * 只喂快照，不渲染组件：`readSuperagent` / `sameSuperagent` 是纯函数。
 *
 * @module dsc/packages/ui-superagent/ui/w12-state.spec
 */
import { describe, expect, test } from 'vitest'
import type { HostSnapshot } from '@dsc/ui'
import { readSuperagent, sameSuperagent } from './state.js'

/** 用一格 `surfaces.superagent` 拼快照。 */
function snapshotOf(surface: Record<string, unknown> | null): HostSnapshot {
  return { surfaces: surface === null ? {} : { superagent: surface } } as unknown as HostSnapshot
}

/** 一张工单；默认只给必填字段。 */
function ticket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 't-1', title: '工单', stage: { stage: 'idle' }, at: '2026-01-01T00:00:00Z', ...overrides }
}

describe('阶段解析：working / ended / 未知档', () => {
  test('working 带 queued 保留动作，不带就只是 working', () => {
    const view = readSuperagent(
      snapshotOf({
        tickets: [ticket({ stage: { stage: 'working', action: 'queued' } }), ticket({ id: 't-2', stage: { stage: 'working' } })],
      }),
    )!
    expect(view.tickets[0]!.stage).toEqual({ stage: 'working', action: 'queued' })
    expect(view.tickets[1]!.stage).toEqual({ stage: 'working' })
  })

  test('ended 认 ended，其余认不出的档按 idle', () => {
    const view = readSuperagent(
      snapshotOf({
        tickets: [
          ticket({ stage: { stage: 'ended' } }),
          ticket({ id: 't-2', stage: { stage: 'future-stage' } }),
          ticket({ id: 't-3', stage: { stage: 'person', action: '乱写' } }),
        ],
      }),
    )!
    expect(view.tickets[0]!.stage).toEqual({ stage: 'ended' })
    expect(view.tickets[1]!.stage).toEqual({ stage: 'idle' })
    // person 的动作认不出：保留 person 档但不带 action（不把脏值写进视图）。
    expect(view.tickets[2]!.stage).toEqual({ stage: 'person' })
  })

  test('ended 组计入 done，其余未结算的计入 running', () => {
    const view = readSuperagent(
      snapshotOf({
        tickets: [
          ticket({ stage: { stage: 'ended' } }),
          ticket({ id: 't-2', stage: { stage: 'working' } }),
          ticket({ id: 't-3', stage: { stage: 'person', action: 'answer' } }),
        ],
      }),
    )!
    expect(view.counts).toEqual({ needsYou: 1, running: 1, done: 1 })
  })
})

describe('来源清单：脏值过滤与空态区分', () => {
  test('非数组：整格缺席（undefined），概览页不画', () => {
    const view = readSuperagent(snapshotOf({ sources: 'x' }))!
    expect(view.sources).toBeUndefined()
  })

  test('数组但全是脏值：给空数组（画空区块），不是 undefined', () => {
    const view = readSuperagent(
      snapshotOf({
        sources: [null, 1, { id: '' }, { id: 'github', enabled: 'true' }],
      }),
    )!
    // 最后一条 id 合法，保留；enabled 只认布尔 true，字符串 'true' 当关闭。
    expect(view.sources).toEqual([{ id: 'github', enabled: false }])
  })

  test('合法来源带 lastPollAt / lastError：空串字段不写进去', () => {
    const view = readSuperagent(
      snapshotOf({
        sources: [
          { id: 'github', enabled: true, lastPollAt: '2026-01-01T00:00:00Z', lastError: '限流' },
          { id: 'feishu', enabled: false, lastPollAt: '', lastError: '' },
        ],
      }),
    )!
    expect(view.sources).toEqual([
      { id: 'github', enabled: true, lastPollAt: '2026-01-01T00:00:00Z', lastError: '限流' },
      { id: 'feishu', enabled: false },
    ])
  })
})

describe('设置变更历史：脏值过滤与空态区分', () => {
  test('非数组：整格缺席（undefined）', () => {
    const view = readSuperagent(snapshotOf({ settingsHistory: {} }))!
    expect(view.settingsHistory).toBeUndefined()
  })

  test('版本不是数字、key 为空：跳过；方括号项按空对象处理', () => {
    const view = readSuperagent(
      snapshotOf({
        settingsHistory: [
          null,
          { version: 'abc', key: 'a' },
          { version: 2, key: '' },
          { version: 3, key: 'model', at: '2026-02-02T00:00:00Z', from: 'a', to: 'b' },
        ],
      }),
    )!
    expect(view.settingsHistory).toEqual([
      { version: 3, key: 'model', at: '2026-02-02T00:00:00Z', from: 'a', to: 'b' },
    ])
  })

  test('有格但一条也不合法：给空数组（设置页画「还没有变更记录」）', () => {
    const view = readSuperagent(snapshotOf({ settingsHistory: [null, { version: NaN, key: 'x' }] }))!
    expect(view.settingsHistory).toEqual([])
  })
})

describe('sameSuperagent：来源与设置历史的指纹', () => {
  function viewOf(surface: Record<string, unknown>): NonNullable<ReturnType<typeof readSuperagent>> {
    return readSuperagent(snapshotOf(surface))!
  }

  test('来源一样就等价；lastError 变了必须重画', () => {
    const base = { sources: [{ id: 'github', enabled: true, lastPollAt: 't1', lastError: '限流' }] }
    const same = { sources: [{ id: 'github', enabled: true, lastPollAt: 't1', lastError: '限流' }] }
    const changed = { sources: [{ id: 'github', enabled: true, lastPollAt: 't1', lastError: '' }] }
    expect(sameSuperagent(viewOf(base), viewOf(same))).toBe(true)
    expect(sameSuperagent(viewOf(base), viewOf(changed))).toBe(false)
  })

  test('来源缺席与空数组是两件事', () => {
    expect(sameSuperagent(viewOf({}), viewOf({ sources: [] }))).toBe(false)
    expect(sameSuperagent(viewOf({ sources: [] }), viewOf({ sources: [] }))).toBe(true)
  })

  test('设置历史：最新一条变了要重画；空数组与缺席不同', () => {
    const withChange = { settingsHistory: [{ version: 1, at: 't', key: 'k', to: 'v' }] }
    const sameChange = { settingsHistory: [{ version: 1, at: 't', key: 'k', to: 'v' }] }
    const otherChange = { settingsHistory: [{ version: 2, at: 't', key: 'k', to: 'v2' }] }
    expect(sameSuperagent(viewOf(withChange), viewOf(sameChange))).toBe(true)
    expect(sameSuperagent(viewOf(withChange), viewOf(otherChange))).toBe(false)
    expect(sameSuperagent(viewOf({}), viewOf({ settingsHistory: [] }))).toBe(false)
    expect(sameSuperagent(viewOf({ settingsHistory: [] }), viewOf({ settingsHistory: [] }))).toBe(true)
  })
})
