/**
 * 侧栏组间顺序：点会话不位移（迁自 `scripts/ui-sidebar-order-test.mjs` 第 [1]–[5] 段）。
 *
 * 报障原话（2026-11-13）：在侧栏点别的历史会话，它所在的工作区会跑到顶部，希望保持原位。
 * 根因：`buildWorkGroups` 的手动档在 `workspaceOrder` 为空时，把「等于当前 cwd 的组」顶到
 * 最前，而 cwd 读的是 `status.cwd`（当前会话的目录）——跨工作区点一条会话，宿主 cwd 一变，
 * 那个组就抢到第一位。修法：活动组只在「还没有会话」（刚切过去、一个会话都没有）时才置顶。
 *
 * 为什么是行为测试：`grouping.ts` 是侧栏的纯数据整形（只经 `@dsc/ui` 取词器），原探针为了
 * 在 Node 里 import 它用 esbuild 现打了一个 ESM；Vitest 的 ui project 直接解析 `@dsc/ui`
 * 与字典 JSON，import 产品源码真跑就行，不需要那套打包替身。
 *
 * 第 [2] 段（脏副本必须红）在探针里是「把打包产物里的空组守卫删掉再 import」；这里改成
 * 旧口径反向对照：在 spec 里照报障前的比较器（活动组恒置顶，不判空）真跑一遍，判据必须
 * 能把两种行为分开——判据分不开就是空转（与 draft.spec 的旧口径对照同一手法）。
 *
 * 第 [6] 段（比较器里守卫的源码文本钉）不迁：守卫在不在，行为用例（点会话不位移 /
 * 新工作区仍置顶）已经从两头压住，文本钉按手册 §2 退役。
 *
 * @module dsc-ui-sessions/ui/grouping.spec
 */
import { describe, expect, test } from 'vitest'
import type { SessionSummary } from '@dsc/ui'
import { buildWorkGroups, type GroupInput } from './grouping.js'

const now = Date.now()
/** 两个工作区：dsc 最近动过，waq 的会话都更旧。 */
const SESSIONS = [
  { id: 'D:/dsc/a.jsonl', cwd: 'D:\\dsc', createdAt: now - 9000, updatedAt: now - 1000, title: '开跑' },
  { id: 'D:/dsc/b.jsonl', cwd: 'D:\\dsc', createdAt: now - 9000, updatedAt: now - 8000, title: '开跑 2' },
  { id: 'C:/Users/waq/c.jsonl', cwd: 'C:\\Users\\waq', createdAt: now - 90_000, updatedAt: now - 50_000, title: '你是谁' },
] as unknown as SessionSummary[]

/** 跑一帧：只关心组顺序（cwd 序列）。 */
const frame = (cwd: string, extra: Partial<GroupInput> = {}): string[] =>
  buildWorkGroups({
    sessions: SESSIONS,
    recentCwds: [],
    cwd,
    sort: 'manual',
    group: 'workspace',
    archived: 'hide',
    trimmed: '',
    aliases: {},
    order: [],
    sessionOrder: {},
    ...extra,
  }).map((group) => group.cwd)

/** 报障前的比较器：活动组恒置顶，不判「还没有会话」。 */
const oldFrame = (cwd: string): string[] => {
  const map = new Map<string, SessionSummary[]>()
  for (const session of SESSIONS) {
    const list = map.get(session.cwd) ?? []
    list.push(session)
    map.set(session.cwd, list)
  }
  const lastUsed = (list: SessionSummary[]): number => list.reduce((max, s) => Math.max(max, s.updatedAt), 0)
  return [...map.entries()]
    .sort((a, b) => {
      if (a[0] === cwd) return -1
      if (b[0] === cwd) return 1
      return lastUsed(b[1]) - lastUsed(a[1])
    })
    .map(([dir]) => dir)
}

describe('点会话不位移', () => {
  const before = frame('D:\\dsc')

  test('基线：最近使用的工作区在前', () => {
    expect(before).toEqual(['D:\\dsc', 'C:\\Users\\waq'])
  })

  test('点开另一个工作区的会话，组顺序不变', () => {
    const after = frame('C:\\Users\\waq')
    expect(after).toEqual(before)
  })

  test('再从 waq 点回 dsc，顺序仍然不变', () => {
    expect(frame('D:\\dsc')).toEqual(frame('C:\\Users\\waq'))
  })
})

describe('旧口径对照（报障前的行为必须被这组判据抓住）', () => {
  test('活动组恒置顶的旧比较器上，点会话真的会跳顶——判据不空转', () => {
    const dirtyAfter = oldFrame('C:\\Users\\waq')
    expect(dirtyAfter[0]).toBe('C:\\Users\\waq')
    expect(dirtyAfter).not.toEqual(frame('D:\\dsc'))
  })
})

describe('新工作区仍然置顶：切过去还没发消息的空目录要第一眼看得见', () => {
  const fresh = frame('D:\\new-dir', { recentCwds: ['D:\\new-dir'] })

  test('切到空工作区，它排在第一位', () => {
    expect(fresh[0]).toBe('D:\\new-dir')
  })

  test('空工作区置顶不挤掉其余组', () => {
    expect(fresh).toHaveLength(3)
    expect(fresh.slice(1)).toEqual(frame('D:\\dsc'))
  })
})

describe('手动拖过的顺序优先，活动组不抢位', () => {
  const manual = frame('D:\\dsc', { order: ['C:\\Users\\waq', 'D:\\dsc'] })

  test('workspaceOrder 非空时按手动顺序', () => {
    expect(manual).toEqual(['C:\\Users\\waq', 'D:\\dsc'])
  })

  test('手动顺序下点会话也不位移', () => {
    expect(frame('C:\\Users\\waq', { order: ['C:\\Users\\waq', 'D:\\dsc'] })).toEqual(manual)
  })
})

describe('时间档不受影响：只按时间，不看 cwd', () => {
  test('最近更新档按时间倒序', () => {
    expect(frame('C:\\Users\\waq', { sort: 'recent' })).toEqual(['D:\\dsc', 'C:\\Users\\waq'])
  })

  test('创建时间档同上', () => {
    expect(frame('C:\\Users\\waq', { sort: 'created' })).toEqual(['D:\\dsc', 'C:\\Users\\waq'])
  })
})
