/**
 * 输入区「思考档位」的选项清单（迁自 `scripts/effort-per-model-test.mjs` 的 [1]）。
 *
 * 用户问的是：思考档位那颗滑杆，遇到不同模型档位不一样时会不会错。这一半钉**界面拿到的
 * 清单**：模型声明两档 / 四档 / 不声明，界面就画 2 / 4 / 0 个点，外加恒在的「默认」。
 * 清单长度直接决定滑杆画几个停点，所以「写死四档」的回归会在这里红。
 *
 * 为什么在 ui 项目：`effortChoices` 住在 `ui-composer/ui/model-picker.ts`，那个目录带
 * `@dsc/ui` 与 JSON 字典依赖，unit 层（node、无 `@dsc/*` 别名）装载不了。
 *
 * 原探针 [4] 那五条滑杆 `.tsx` 源码正则不搬（`percentOf(levels.length)` 这类写法断言），
 * 它要保的行为是「点数由清单长度决定」，而清单长度由本文件钉；渲染层真的画几个点要在
 * 界面渲染测试里验，属 ui 层的活。删除清单见交付报告。
 *
 * @module dsc-ui-composer/ui/model-picker.spec
 */
import { describe, expect, test } from 'vitest'
import type { ModelChoiceView } from '@dsc/ui'
import { effortChoices } from './model-picker.js'

/** 造一份模型行；只有能力字段参与判定。 */
function choice(thinkingLevels: ModelChoiceView['thinkingLevels']): ModelChoiceView {
  return {
    value: 'test/m',
    provider: 'test',
    providerDisplayName: 'Test',
    model: 'm',
    description: 'Test · 100k',
    contextWindow: 100_000,
    thinkingLevels,
    modalities: ['text'],
  }
}

describe('① 档位清单：模型声明几档，界面就几档（外加恒在的「默认」）', () => {
  test('两档的模型：默认 + 低 + 高', () => {
    expect(effortChoices(choice(['low', 'high']))).toEqual(['default', 'low', 'high'])
  })

  test('四档的模型：默认 + 四档', () => {
    expect(effortChoices(choice(['off', 'low', 'high', 'max']))).toEqual(['default', 'off', 'low', 'high', 'max'])
  })

  test('不声明思考的模型：只剩「默认」', () => {
    expect(effortChoices(choice([]))).toEqual(['default'])
  })

  test('清单长度各不相同（滑杆按它画点）', () => {
    expect(effortChoices(choice(['low', 'high']))).toHaveLength(3)
    expect(effortChoices(choice(['off', 'low', 'high', 'max']))).toHaveLength(5)
    expect(effortChoices(choice([]))).toHaveLength(1)
  })

  test('模型声明里出现没听过的档位：丢掉，不画一个点不动的点', () => {
    // `ultra` 是宿主数据里不该出现的值：留着只会画出一个发不出去的停点。
    expect(effortChoices(choice(['off', 'ultra'] as ModelChoiceView['thinkingLevels']))).toEqual(['default', 'off'])
  })
})
