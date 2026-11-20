/**
 * 轨迹页格式化的补盲（`packages/ui-trace/ui/trace-format.ts`）：
 * `stepName` 的 system / user / 兜底分支、`prettyMaybeJson` 的解析失败分支、
 * `stepMatches` 里 plan / subagent / model-retry / thinking 各自的搜索字段。
 *
 * @module dsc/packages/ui-trace/ui/w12-trace-format.spec
 */
import { describe, expect, test } from 'vitest'
import type { TranscriptEntry } from '@dsc/ui'
import { prettyMaybeJson, stepMatches, stepName, type TraceStepEntry } from './trace-format.js'

/** 造一条最小条目；只关心被测函数读的字段。 */
function entry(value: Record<string, unknown>): TraceStepEntry {
  return value as unknown as TraceStepEntry
}

function anyEntry(value: Record<string, unknown>): TranscriptEntry {
  return value as unknown as TranscriptEntry
}

describe('stepName：种类名与轮级标记', () => {
  test('system / user / text 走种类词', () => {
    expect(stepName(anyEntry({ kind: 'system', text: 'x' }))).toMatch(/系统|system/i)
    expect(stepName(anyEntry({ kind: 'user', text: 'x' }))).toMatch(/用户|user/i)
    expect(stepName(anyEntry({ kind: 'text', text: 'x' }))).toMatch(/正文|text/i)
  })

  test('轮尾标记按原因分「中断」与「失败」两种说法', () => {
    const aborted = stepName(entry({ kind: 'turn-end', reason: 'aborted' }))
    const failed = stepName(entry({ kind: 'turn-end', reason: 'error' }))
    expect(aborted).not.toBe(failed)
    expect(aborted.length).toBeGreaterThan(0)
    expect(failed.length).toBeGreaterThan(0)
  })

  test('子代理用任务当名字：超过 24 字截断加省略号', () => {
    const task = '把这一整段任务写得非常非常长超过二十四个字符还要继续写下去'
    const name = stepName(
      entry({ kind: 'subagent', sub: { task, name: 'worker', state: 'running' } }),
    )
    expect(name).toBe(`${task.slice(0, 24)}…`)
    const short = stepName(entry({ kind: 'subagent', sub: { task: '短任务', name: 'w', state: 'done' } }))
    expect(short).toBe('短任务')
  })
})

describe('prettyMaybeJson：能解析才美化', () => {
  test('合法 JSON 缩进输出并标记 formatted', () => {
    expect(prettyMaybeJson('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', formatted: true })
  })

  test('半截 JSON 原样返回，formatted=false', () => {
    const broken = '{"a":'
    expect(prettyMaybeJson(broken)).toEqual({ text: broken, formatted: false })
  })
})

describe('stepMatches：各步骤的可搜字段', () => {
  test('空查询永远不命中', () => {
    expect(stepMatches(entry({ kind: 'thinking', text: '任何内容' }), '   ')).toBe(false)
  })

  test('thinking / system 搜正文', () => {
    expect(stepMatches(entry({ kind: 'thinking', text: '想一下 关键字' }), '关键字')).toBe(true)
    expect(stepMatches(entry({ kind: 'system', text: '系统 提示' }), '提示')).toBe(true)
  })

  test('plan 搜标题、文件与正文', () => {
    const plan = entry({ kind: 'plan', plan: { title: '标题甲', file: 'plans/x.md', text: '正文乙' } })
    expect(stepMatches(plan, '标题甲')).toBe(true)
    expect(stepMatches(plan, 'plans/x.md')).toBe(true)
    expect(stepMatches(plan, '正文乙')).toBe(true)
    expect(stepMatches(plan, '没出现')).toBe(false)
  })

  test('subagent 搜任务、名字与状态', () => {
    const sub = entry({ kind: 'subagent', sub: { task: '任务甲', name: 'worker-1', state: 'running' } })
    expect(stepMatches(sub, '任务甲')).toBe(true)
    expect(stepMatches(sub, 'worker-1')).toBe(true)
    expect(stepMatches(sub, 'running')).toBe(true)
  })

  test('model-retry 搜重试次数文案', () => {
    const retry = entry({ kind: 'model-retry', attempt: 3, ts: 1 })
    expect(stepMatches(retry, '3')).toBe(true)
  })

  test('末轮标记这类没有额外字段：只按种类名匹配', () => {
    const turnEnd = entry({ kind: 'turn-end', reason: 'aborted' })
    expect(stepMatches(turnEnd, 'turn-end')).toBe(true)
    expect(stepMatches(turnEnd, 'zzz')).toBe(false)
  })
})
