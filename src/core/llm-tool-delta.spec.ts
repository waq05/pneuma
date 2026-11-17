/**
 * 流式工具调用增量的合并规则（unit 层）。
 *
 * 来源：`scripts/ui-tool-name-null-test.mjs` 第 [1] 段（2026-10-30 白屏事故的合并层）。
 *
 * 事故链条：网关在某一片流里把 `id` / `function.name` 回成 `null` → 旧合并分支只判
 * `!== undefined && !== ''`，null 两道门都过 → 把前面收到的好名字覆盖成 null → 日志写
 * null → 界面对名字调 `.toLowerCase()` → 对话页白屏。修法：**逐字段判 `typeof === 'string'`**
 * ——`null` 不是「给了个空值」，是「这次这片没带名字」。
 *
 * 原探针第 [4] 段的源码形态钉（「逐字段判 typeof」等写法断言）不迁：改回旧的漏门时，
 * 下面的行为断言（null 不覆盖、脏值不落表）会直接红，文本钉是多余的。
 *
 * @module dsc/core/llm-tool-delta.spec
 */
import { describe, expect, test } from 'vitest'
import { applyToolCallDelta } from './llm.js'

/** 脏值样本：类型上不该出现，运行时网关就是会发（事故的实况）。 */
const junkDelta = {
  index: 3,
  id: 42,
  function: { name: 7, arguments: ['x'] },
} as unknown as Parameters<typeof applyToolCallDelta>[1]

describe('null / 脏值只是「这片没给」', () => {
  test('首发分片落名字与参数，并通知一次「准备中」', () => {
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    const prepared: string[] = []
    applyToolCallDelta(calls, { index: 0, id: 'call_1', function: { name: 'run_code', arguments: '{"co' } }, (name) => prepared.push(name))
    const first = calls.get(0)
    expect(first?.name).toBe('run_code')
    expect(first?.arguments).toBe('{"co')
    expect(prepared).toEqual(['run_code'])
  })

  test('后续分片的 null 名字 / null ID 不覆盖已收到的，参数继续累积，不重复报「准备中」', () => {
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    const prepared: string[] = []
    applyToolCallDelta(calls, { index: 0, id: 'call_1', function: { name: 'run_code', arguments: '{"co' } }, (name) => prepared.push(name))
    applyToolCallDelta(calls, { index: 0, id: null, function: { name: null, arguments: 'de": 1}' } }, (name) => prepared.push(name))
    const merged = calls.get(0)
    expect(merged?.name).toBe('run_code')
    expect(merged?.id).toBe('call_1')
    expect(merged?.arguments).toBe('{"code": 1}')
    expect(prepared).toHaveLength(1)
  })

  test('首片全 null 时各字段落成空串，绝不落成 null（那是白屏的根）', () => {
    const blank = new Map<number, { id: string; name: string; arguments: string }>()
    applyToolCallDelta(blank, { index: 1, id: null, function: { name: null, arguments: null } })
    expect(blank.get(1)).toEqual({ id: '', name: '', arguments: '' })
  })

  test('空名字不报「准备中」', () => {
    const seen: string[] = []
    applyToolCallDelta(new Map(), { index: 2, function: { name: null } }, (name) => seen.push(name))
    expect(seen).toHaveLength(0)
  })

  test('非字符串脏值（数字、对象）同样当没给，不落进调用表', () => {
    const dirty = new Map<number, { id: string; name: string; arguments: string }>()
    expect(() => applyToolCallDelta(dirty, junkDelta)).not.toThrow()
    expect(dirty.get(3)).toEqual({ id: '', name: '', arguments: '' })
  })
})
