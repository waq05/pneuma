/**
 * 分轮口径与内部条目标签的纯函数层（ui 层）。
 *
 * 来源：`scripts/ui-transcript-render-test.mjs` 第 [7]①②③ 段（0.6.67 报障：右侧刻度条
 * `.jump-rail` 错位 / 多刻度）：
 * - ① 座位切分与轮元信息同源：steering 不另起一轮，`splitRounds` 的轮与 `roundInfos`
 *   逐项相同（一份真值），前导 + 座位恰好覆盖每条一次；
 * - ② internal 条目从不另起一轮：回合中途并进本轮、收尾出账并进上一轮、会话第一条归
 *   leading——三种都不增刻度（与 dsh 给非人来源一枚刻度的做法有意不同）；
 * - ③ internal 的题面预览不出现原文：队友汇报给一句带队友名的人话，认不出也给兜底话。
 *
 * 为什么是行为测试：`rounds.ts` 只 import 取词器与字典（零 React），`splitRounds` /
 * `roundInfos` / `teammateReportLabel` / `internalLabel` 的真跑结果就是被测行为。原探针里
 * 钉渲染接线（`trigger-row.tsx`、`user-row.tsx`、`render.tsx` 的取法文本）的断言不迁，
 * 归组件渲染批；落库 / 出账 / 重放三处宿主接线（`session.ts`、`loop.ts`、`adapter`）的
 * 文本钉同样不迁——那条链的行为实测在 `scripts/notice-origin-test.mjs`，不在本组范围。
 *
 * @module dsc-ui-transcript/ui/rounds.spec
 */
import { describe, expect, test } from 'vitest'
import type { TranscriptEntry } from '@dsc/ui'
import { internalLabel, roundInfos, splitRounds, teammateReportLabel } from './rounds.js'

/** 造一条条目：id 递增（正数 = 定稿），ts 排进样张。 */
let seq = 0
const entry = (kind: TranscriptEntry['kind'], extra: object = {}): TranscriptEntry =>
  ({ kind, id: (seq += 1), ...extra }) as TranscriptEntry

/** 宿主 subagent 插件造出来的队友汇报正文形状（`TEAMMATE_REPORT_OPEN` 开头）。 */
const teammateBody =
  '<teammate-report from="mate-1" role="coder" state="已完成">\n派给它的任务：改个 bug\n它的汇报：\n搞定了\n</teammate-report>'

/** 三问三答的常规样张，中间插一条 steering。 */
const steer = [
  entry('user', { text: 'A', ts: 1 }),
  entry('text', { text: 'r1', ts: 2 }),
  entry('user', { text: '插一句话', steering: true, ts: 3 }),
  entry('text', { text: 'r2', ts: 4 }),
  entry('user', { text: 'B', ts: 5 }),
  entry('text', { text: 'r3', ts: 6 }),
]

// ── ① 座位切分与轮元信息同源 ────────────────────────────────────────────────────

describe('steering 不另起一轮（刻度条不错位）', () => {
  test('插话那条并进当前轮：2 轮，round0 覆盖 0..3', () => {
    const split = splitRounds(steer)
    expect(split.rounds).toHaveLength(2)
    expect(split.rounds[0]?.startIndex).toBe(0)
    expect(split.rounds[0]?.endIndex).toBe(3)
  })

  test('座位数 = 轮数，round 序号 / 开轮下标逐项一一对应', () => {
    const split = splitRounds(steer)
    const infos = roundInfos(steer)
    expect(split.seats).toHaveLength(infos.length)
    expect(split.seats.every((seat, i) => seat.round === infos[i]?.index && seat.round === i && seat.indices[0] === infos[i]?.startIndex)).toBe(true)
  })

  test('对同一 entries 两边（splitRounds 的轮 / roundInfos）逐项相同（一份真值）', () => {
    const split = splitRounds(steer)
    expect(roundInfos(steer)).toEqual(split.rounds)
  })

  test('前导 + 座位恰好覆盖每条一次且升序（座位是连续切片）', () => {
    const split = splitRounds(steer)
    const covered = [...split.leading, ...split.seats.flatMap((seat) => seat.indices)]
    expect(covered).toEqual(steer.map((_, at) => at))
  })

  test('座位末下标 = 下一轮开轮条目之前（不越界、不留缝）', () => {
    const split = splitRounds(steer)
    split.seats.every((seat, i) => {
      const next = split.seats[i + 1]
      const stop = next === undefined ? steer.length - 1 : next.indices[0] - 1
      expect(seat.indices.at(-1)).toBe(stop)
      return true
    })
  })
})

// ── ② internal 从不另起一轮（三种形态都不增刻度） ───────────────────────────────

describe('internal 条目从不另起一轮', () => {
  test('回合中途并进本轮的 internal（steering+internal）不增刻度：仍 1 轮 1 座位', () => {
    const midSteer = [
      entry('user', { text: 'A', ts: 1 }),
      entry('text', { text: 'r1', ts: 2 }),
      entry('user', { text: teammateBody, steering: true, internal: true, ts: 3 }),
      entry('text', { text: 'r2', ts: 4 }),
    ]
    const mid = splitRounds(midSteer)
    expect(mid.rounds).toHaveLength(1)
    expect(mid.seats).toHaveLength(1)
    expect(mid.seats[0]?.indices).toHaveLength(4)
  })

  test('收尾出账的 internal（非 steering）不开新轮、并进上一轮', () => {
    const endInternal = [
      entry('user', { text: 'A', ts: 1 }),
      entry('text', { text: 'r1', ts: 2 }),
      entry('user', { text: teammateBody, internal: true, ts: 3 }),
      entry('text', { text: 'r2', ts: 4 }),
    ]
    const end = splitRounds(endInternal)
    expect(end.rounds).toHaveLength(1)
    expect(end.seats).toHaveLength(1)
    expect(end.rounds[0]?.startIndex).toBe(0)
    expect(end.rounds[0]?.endIndex).toBe(3)
    expect(end.seats[0]?.indices.join(',')).toBe('0,1,2,3')
  })

  test('并进上一轮时 endTs 跟着推进（internal 之后还有条目就用后者的时刻）', () => {
    const endInternal = [
      entry('user', { text: 'A', ts: 1 }),
      entry('text', { text: 'r1', ts: 2 }),
      entry('user', { text: teammateBody, internal: true, ts: 3 }),
      entry('text', { text: 'r2', ts: 4 }),
    ]
    expect(splitRounds(endInternal).rounds[0]?.endTs).toBe(4)
  })

  test('internal 是本轮最后一条时也算进 endTs（「用时」仍是整轮墙钟）', () => {
    const endInternal = [
      entry('user', { text: 'A', ts: 1 }),
      entry('text', { text: 'r1', ts: 2 }),
      entry('user', { text: teammateBody, internal: true, ts: 3 }),
    ]
    const endTail = splitRounds(endInternal)
    expect(endTail.rounds).toHaveLength(1)
    expect(endTail.rounds[0]?.endIndex).toBe(2)
    expect(endTail.rounds[0]?.endTs).toBe(3)
  })

  test('会话第一条就是通知：不造空轮、归 leading 开场段，座位接缝不错位', () => {
    const leadInternal = [
      entry('system', { text: '开场提示', ts: 1 }),
      entry('user', { text: '后台作业 job-1 成功完成。', internal: true, ts: 2 }),
      entry('user', { text: 'A', ts: 3 }),
      entry('text', { text: 'r1', ts: 4 }),
    ]
    const lead = splitRounds(leadInternal)
    expect(lead.rounds).toHaveLength(1)
    expect(lead.rounds[0]?.startIndex).toBe(2)
    expect(lead.seats).toHaveLength(1)
    expect(lead.seats[0]?.indices.join(',')).toBe('2,3')
    expect(lead.leading.join(',')).toBe('0,1')
  })
})

// ── ③ internal 的题面预览不出现原文 ────────────────────────────────────────────

describe('internal 的标签（人话，不回原文）', () => {
  test('队友汇报的人话标签带队友名、不含原文', () => {
    const label = teammateReportLabel(teammateBody)
    expect(label).toBe('队友 mate-1 汇报了运行结果')
    expect(label).not.toContain('<teammate-report')
  })

  test('头里认不出队友名时也绝不回原文（兜底一句通用话）', () => {
    const label = teammateReportLabel('<teammate-report role="x">乱</teammate-report>')
    expect(label).toContain('队友')
    expect(label).not.toContain('<teammate-report')
  })

  test('状态进文案（state="已失败" → 失败了）', () => {
    expect(teammateReportLabel('<teammate-report from="mate-2" state="已失败">x')).toContain('失败了')
  })

  test('internalLabel 认得队友汇报（唤醒卡与刻度悬停卡共用这句）', () => {
    expect(internalLabel(teammateBody)).toContain('队友 mate-1')
  })
})
