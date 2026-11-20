/**
 * 过程分组的补盲（`packages/ui-transcript/ui/process-groups.ts`）：
 * 工具名归类的计划类、实时详情的三种来源（字符串 / 全字符串数组 / questions）、
 * 超长截断、半截 JSON 里的数组与非字符串标量、组头三类以上的拼接，
 * 以及分组时 `system-prompt` / `context-injection` 的封组与「拖尾组只剩定稿思考」。
 *
 * @module dsc/packages/ui-transcript/ui/w12-process-groups.spec
 */
import { describe, expect, test } from 'vitest'
import type { TranscriptEntry } from '@dsc/ui'
import type { RoundInfo } from './timing.js'
import {
  activityOf,
  groupSteps,
  liveToolDetail,
  normalizeDetail,
  preparingToolDetail,
  reasoningDetail,
  stepGroupTitle,
  type ActivityCount,
} from './process-groups.js'

let seq = 0
const entry = (kind: TranscriptEntry['kind'], extra: object = {}): TranscriptEntry =>
  ({ kind, id: (seq += 1), ...extra }) as TranscriptEntry
const tool = (name: string, status: string): TranscriptEntry =>
  entry('tool', { call: { callId: `c${String(seq)}`, name, argsText: '{}', status } })
const round = (index: number, startIndex: number, endIndex: number, endTs: number | null = 2): RoundInfo =>
  ({ index, startIndex, endIndex, startTs: 1, endTs, answered: true }) as RoundInfo

describe('activityOf：计划类工具', () => {
  test('todo / goal / 计划模式都归到 plan，未知工具归 tools', () => {
    for (const name of ['todo_write', 'create_goal', 'update_goal', 'get_goal', 'exit_plan_mode']) {
      expect(activityOf(name)).toBe('plan')
    }
    expect(activityOf('brand_new_tool')).toBe('tools')
  })
})

describe('normalizeDetail：只认字符串与全字符串数组', () => {
  test('数字 / 混合数组 / 对象给空串', () => {
    expect(normalizeDetail(123)).toBe('')
    expect(normalizeDetail(['a', 1])).toBe('')
    expect(normalizeDetail({ a: 1 })).toBe('')
    expect(normalizeDetail(['a', 'b'])).toBe('a, b')
  })

  test('超长按字素截到 160 并补省略号', () => {
    const output = normalizeDetail('x'.repeat(300))
    expect(output.length).toBe(160)
    expect(output.endsWith('…')).toBe(true)
  })
})

describe('liveToolDetail：questions 参数', () => {
  test('取第一个问题对象的 question 字段（跳过空项）', () => {
    const args = JSON.stringify({ questions: [null, { question: '' }, { question: '选哪个？' }] })
    expect(liveToolDetail('ask_user', args)).toBe('选哪个？')
  })
})

describe('preparingToolDetail：半截 JSON 的边界', () => {
  test('空参数：空串', () => {
    expect(preparingToolDetail('   ')).toBe('')
  })

  test('参数值是数组：不硬当成字符串读', () => {
    expect(preparingToolDetail('{"queries":["a","b"')).toBe('')
  })

  test('参数值是非字符串标量且带空格：解析不炸', () => {
    expect(preparingToolDetail('{"port": 123}')).toBe('')
  })
})

describe('reasoningDetail：最后一段非空', () => {
  test('全是空白段落：空串', () => {
    expect(reasoningDetail('\n\n   \n')).toBe('')
  })

  test('取最后一段并去掉 markdown 加粗', () => {
    expect(reasoningDetail('第一段\n\n**第二段**')).toBe('第二段')
  })
})

describe('stepGroupTitle：已结束组的聚合文案', () => {
  const count = (kind: ActivityCount['kind'], times: number): ActivityCount => ({ kind, count: times })

  test('两类且都以「已」开头：第二项省掉共同前缀', () => {
    const shared = stepGroupTitle([count('read', 2), count('search', 1)], true)
    const unshared = stepGroupTitle([count('read', 2), count('commands', 1)], true)
    expect(shared).not.toBe(unshared)
    expect(shared.length).toBeLessThan(unshared.length)
  })

  test('超过三类：只列前三类并补「等」', () => {
    const three = stepGroupTitle([count('read', 3), count('search', 2), count('write', 1)], true)
    const four = stepGroupTitle(
      [count('read', 3), count('search', 2), count('write', 1), count('commands', 1)],
      true,
    )
    expect(four.length).toBeGreaterThan(three.length)
    expect(four.startsWith(three)).toBe(true)
  })
})

describe('groupSteps：两种系统卡封组', () => {
  test('system-prompt / context-injection 本身不进组，但会把组切成两段', () => {
    const entries = [
      entry('user', { text: '题面' }),
      tool('read', 'done'),
      entry('system-prompt', { text: '系统提示' }),
      tool('write', 'done'),
      entry('context-injection', { text: '注入' }),
      entry('thinking', { text: '再想' }),
    ]
    const grouping = groupSteps(entries, [round(0, 0, 5)], () => false)
    expect(grouping.groups.length).toBeGreaterThanOrEqual(2)
    const members = grouping.groups.flatMap((group) => [...group.members])
    expect(members).not.toContain(2)
    expect(members).not.toContain(4)
  })
})

describe('groupSteps：拖尾组只剩定稿思考', () => {
  test('没有运行中工具、也没有直播思考：组会画出来但不带实时详情', () => {
    const entries = [entry('user', { text: '题面' }), entry('thinking', { text: '已经想完的' })]
    const grouping = groupSteps(entries, [round(0, 0, 1, null)], () => true)
    expect(grouping.groups).toHaveLength(1)
    expect(grouping.groups[0]!.closed).toBe(false)
    expect(grouping.groups[0]!.running).toBeUndefined()
    expect(grouping.groups[0]!.runningDetail).toBeUndefined()
  })
})
