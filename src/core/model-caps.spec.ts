/**
 * 模型能力：档位夹取与请求字段映射（迁自 `scripts/effort-per-model-test.mjs` 的 [2][3]）。
 *
 * 用户问的是：思考档位那颗滑杆，遇到不同模型档位不一样时会不会错。机制上档位来自模型的
 * 能力声明（`config.yaml` 的 `thinkingLevels` / `thinkingParam` / `effortMap`），滑杆按清单
 * 长度画、请求按清单发字段。本文件钉**宿主这一半**：换模型时旧档位夹回「默认」、
 * 三套端点各发什么字段、`effortMap` 的逐档覆盖与「写 null = 不发」。
 *
 * 界面那一半（`effortChoices` 按清单长度给选项）在 `ui-composer/ui/model-picker.spec.ts`；
 * 宿主真的把夹取与校验接进 `ctx.llm` 的那几条在 `tests/integration/effort-per-model.int.spec.ts`。
 *
 * 原探针 [4] 五条滑杆 `.tsx` 源码正则与 [5] 两条「给正则做元检查」不搬，理由见交付报告。
 *
 * 纯函数、零依赖，归 unit 层。
 *
 * @module dsc/core/model-caps.spec
 */
import { describe, expect, test } from 'vitest'
import type { EffortLevel } from '@pneuma/runtime/contract.js'
import {
  clampEffort,
  DEFAULT_THINKING_LEVELS,
  effortToWire,
  hasEffortLevel,
  normalizeEffortMap,
  normalizeThinkingLevels,
  type ModelCaps,
} from './model-caps.js'

/** 造一份模型能力（缺省按「四档 + thinking 开关 + 只吃文本」）。 */
function modelCaps(extra: Partial<ModelCaps> = {}): ModelCaps {
  return {
    thinkingLevels: [...DEFAULT_THINKING_LEVELS],
    thinkingParam: 'thinking',
    effortMap: {},
    modalities: ['text'],
    ...extra,
  }
}

describe('① 换模型：旧档位在新模型上不存在就夹回「默认」', () => {
  const two = modelCaps({ thinkingLevels: ['low', 'high'], thinkingParam: 'reasoning-effort' })
  const noThinking = modelCaps({ thinkingLevels: [] })

  test('两档模型上没有 max：夹回默认', () => {
    expect(clampEffort(two, 'max')).toBe('default')
  })

  test('两档模型上有 high：保留', () => {
    expect(clampEffort(two, 'high')).toBe('high')
  })

  test('没有思考的模型上一律回默认', () => {
    expect(clampEffort(noThinking, 'low')).toBe('default')
    expect(clampEffort(noThinking, 'default')).toBe('default')
  })

  test('hasEffortLevel 认「默认」恒可选', () => {
    expect(hasEffortLevel(noThinking, 'default')).toBe(true)
    expect(hasEffortLevel(noThinking, 'off')).toBe(false)
  })

  test('配置里的档位写法容错：字符串 / false 都认', () => {
    expect(normalizeThinkingLevels('low, high')).toEqual(['low', 'high'])
    expect(normalizeThinkingLevels(false)).toEqual([])
  })
})

describe('② 请求字段：三套端点三种发法', () => {
  test('thinking 开关：低/高/最大都发 enabled，关发 disabled', () => {
    const caps = modelCaps({ thinkingParam: 'thinking' })
    for (const level of ['low', 'high', 'max'] as const) expect(effortToWire(caps, level).thinking).toBe('enabled')
    expect(effortToWire(caps, 'off').thinking).toBe('disabled')
  })

  test('选「默认」不发思考字段', () => {
    expect(effortToWire(modelCaps({ thinkingParam: 'thinking' }), 'default')).toEqual({})
  })

  test('reasoning_effort：各档按缺省线上值发', () => {
    const caps = modelCaps({ thinkingParam: 'reasoning-effort' })
    expect(effortToWire(caps, 'low').reasoningEffort).toBe('low')
    expect(effortToWire(caps, 'max').reasoningEffort).toBe('max')
  })

  test('reasoning_effort：off 发 none', () => {
    expect(effortToWire(modelCaps({ thinkingParam: 'reasoning-effort' }), 'off').reasoningEffort).toBe('none')
  })

  test('effortMap 覆盖生效（端点用 minimal / xhigh 这种名字时）', () => {
    const caps = modelCaps({
      thinkingParam: 'reasoning-effort',
      effortMap: normalizeEffortMap({ low: 'minimal', max: 'xhigh' }),
    })
    expect(effortToWire(caps, 'low').reasoningEffort).toBe('minimal')
    expect(effortToWire(caps, 'max').reasoningEffort).toBe('xhigh')
  })

  test('effortMap 里写 null 的那一档不发字段', () => {
    const caps = modelCaps({
      thinkingParam: 'reasoning-effort',
      effortMap: normalizeEffortMap({ high: null }),
    })
    expect(effortToWire(caps, 'high')).toEqual({})
  })

  test('thinkingParam: none 的端点：选哪档都不发', () => {
    const caps = modelCaps({ thinkingParam: 'none' })
    for (const level of ['off', 'low', 'high', 'max'] as const) expect(effortToWire(caps, level)).toEqual({})
  })

  test('没有思考档位的模型：选哪档都不发', () => {
    const caps = modelCaps({ thinkingLevels: [] })
    for (const level of ['off', 'low', 'high', 'max'] as const) expect(effortToWire(caps, level)).toEqual({})
  })

  test('档位清单是固定顺序去重（配置里写乱序也只认四种）', () => {
    const levels: EffortLevel[] = normalizeThinkingLevels(['max', 'off', 'max', 'bogus'])
    expect(levels).toEqual(['off', 'max'])
  })
})
